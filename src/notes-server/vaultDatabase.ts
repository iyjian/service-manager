import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { validateRecords, type VaultRecord } from '../main/vault/entries';
import { fail } from '../main/notesServer/workspace';

/** The encryption key is separate from SQLite and must accompany disaster-recovery backups. */
export async function createVaultDatabase(db: DatabaseSync, directory: string) {
  db.exec('CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, encrypted TEXT NOT NULL)');
  const keyFile = path.join(directory, 'vault-encryption.key');
  let key: Buffer;
  try { key = await fs.readFile(keyFile); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (db.prepare('SELECT id FROM vault').get()) throw new Error('Vault encryption key is missing. Restore the original key.');
    key = randomBytes(32); await fs.writeFile(keyFile, key, { flag: 'wx', mode: 0o600 });
  }
  if (key.length !== 32) throw new Error('Invalid Vault encryption key.');
  await fs.chmod(keyFile, 0o600);
  const encrypt = (records: VaultRecord[]) => {
    const data = JSON.stringify(records);
    if (Buffer.byteLength(data) > 16 * 1024 * 1024) return fail(413, 'Vault is too large.');
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('service-manager-vault-v1'));
    const bytes = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
  };
  const read = (): { revision: number; records: VaultRecord[] } => {
    const row = db.prepare('SELECT revision, encrypted FROM vault WHERE id=1').get();
    if (!row) return { revision: 0, records: [] };
    const bytes = Buffer.from(String(row.encrypted), 'base64');
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from('service-manager-vault-v1')); cipher.setAuthTag(bytes.subarray(12, 28));
    return { revision: Number(row.revision), records: validateRecords(JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'))) };
  };
  const commit = (records: VaultRecord[], revision: number) => {
    const encrypted = encrypt(records);
    db.prepare('INSERT INTO vault VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, encrypted=excluded.encrypted').run(revision, encrypted);
  };
  // Fail closed if an existing Vault cannot be authenticated/decrypted.
  read();
  return {
    read,
    write(input: { records?: unknown; expectedRevision?: unknown }, migrate: boolean): { revision: number } {
      const incoming = validateRecords(input.records);
      const current = read();
      if (migrate) {
        const byId = new Map(current.records.map(record => [record.id, record]));
        for (const record of incoming) {
          const existing = byId.get(record.id);
          if (existing && !isDeepStrictEqual(existing, record)) return fail(409, 'Vault migration conflict. Local data was preserved.');
          if (!existing) byId.set(record.id, record);
        }
        if (byId.size === current.records.length) return { revision: current.revision };
        const records = validateRecords([...byId.values()]);
        commit(records, current.revision + 1);
      } else {
        if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== current.revision) return fail(409, 'Vault changed. Refresh before editing.');
        if (incoming.some(record => record.deletedAt && current.records.some(old => old.id === record.id && old.type !== 'login'))) return fail(409, 'Only Logins can be deleted.');
        // Clients cannot silently drop keys needed for existing SSH connections.
        const ids = new Set(incoming.map(record => record.id));
        if (current.records.some(record => !ids.has(record.id))) return fail(409, 'Vault entries cannot be removed by replacement.');
        if (current.records.some(record => record.deletedAt && !isDeepStrictEqual(record, incoming.find(next => next.id === record.id)))) return fail(409, 'Deleted Logins cannot be restored by replacement.');
        commit(incoming, current.revision + 1);
      }
      return { revision: current.revision + 1 };
    },
  };
}
