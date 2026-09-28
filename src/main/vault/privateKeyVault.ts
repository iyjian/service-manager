import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { utils } from 'ssh2';
import type { HostConfig, VaultKeyView } from '../../shared/types';
import type { NotesShareCredentialProtector } from '../notes/notesShareSettingsStore';

type Key = VaultKeyView & { privateKey: string; passphrase?: string };
type Endpoint = { privateKeyId?: string; privateKey?: string; passphrase?: string; privateKeyPath?: string };
export class PrivateKeyVault {
  private keys: Key[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private protector: NotesShareCredentialProtector) {}
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.keys = JSON.parse(this.protector.decryptString(Buffer.from(raw.encrypted, 'base64')));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Vault could not be unlocked.'); }
  }
  list(): VaultKeyView[] { return this.keys.map(key => this.view(key)); }
  private view({ id, name, createdAt, updatedAt, revision }: Key): VaultKeyView { return { id, name, createdAt, ...(updatedAt ? { updatedAt } : {}), ...(revision !== undefined ? { revision } : {}) }; }
  resolve<T extends Endpoint>(input: T): T {
    if (!input.privateKeyId) return { ...input };
    const key = this.keys.find(key => key.id === input.privateKeyId);
    if (!key) throw new Error('The selected Vault key is unavailable on this device.');
    return { ...input, privateKey: key.privateKey, passphrase: key.passphrase, privateKeyPath: undefined };
  }
  resolveHost<T extends HostConfig>(host: T): T {
    return { ...this.resolve(host), jumpHosts: host.jumpHosts.map(hop => this.resolve(hop)) };
  }
  reuseReference<T extends Endpoint>(input: T): T {
    const existing = this.keys.find(key => key.privateKey.trim() === input.privateKey?.trim() && (key.passphrase ?? '') === (input.passphrase ?? ''));
    return existing ? this.resolve({ ...input, privateKeyId: existing.id }) : { ...input };
  }
  async add(name: string, privateKey: string, passphrase?: string, migration = false): Promise<VaultKeyView> {
    const work = this.queue.then(async () => {
      if (typeof privateKey !== 'string' || !privateKey.trim() || Buffer.byteLength(privateKey) > 65536 || (passphrase !== undefined && (typeof passphrase !== 'string' || passphrase.length > 65536))) throw new Error('Invalid private key.');
      if (!migration) {
        if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Key name is required (up to 200 characters).');
        const parsed = utils.parseKey(privateKey, passphrase);
        if (parsed instanceof Error || Array.isArray(parsed) || !parsed.isPrivateKey()) throw new Error('Invalid private key or passphrase.');
      }
      const existing = this.keys.find(key => key.privateKey.trim() === privateKey.trim() && (key.passphrase ?? '') === (passphrase ?? ''));
      if (existing) return { id: existing.id, name: existing.name, createdAt: existing.createdAt };
      if (migration) { let index = 1; while (this.keys.some(key => key.name === `privateKey${index}`)) index++; name = `privateKey${index}`; }
      const key: Key = { id: randomUUID(), name: name.trim(), privateKey, passphrase, createdAt: new Date().toISOString() };
      await this.persist([...this.keys, key]);
      return { id: key.id, name: key.name, createdAt: key.createdAt };
    });
    this.queue = work.catch(() => {}); return work;
  }
  async rename(id: string, name: string, revision: number): Promise<VaultKeyView> {
    return this.update(id, revision, key => {
      if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Key name is required (up to 200 characters).');
      return { ...key, name: name.trim() };
    });
  }
  async replace(id: string, privateKey: string, passphrase: string | undefined, revision: number): Promise<VaultKeyView> {
    return this.update(id, revision, key => {
      if (typeof privateKey !== 'string' || !privateKey.trim() || Buffer.byteLength(privateKey) > 65536 || (passphrase !== undefined && (typeof passphrase !== 'string' || passphrase.length > 65536))) throw new Error('Invalid private key.');
      const parsed = utils.parseKey(privateKey, passphrase);
      if (parsed instanceof Error || Array.isArray(parsed) || !parsed.isPrivateKey()) throw new Error('Invalid private key or passphrase.');
      return { ...key, privateKey, passphrase };
    });
  }
  private update(id: string, revision: number, change: (key: Key) => Key): Promise<VaultKeyView> {
    const work = this.queue.then(async () => {
      const index = this.keys.findIndex(key => key.id === id);
      if (typeof id !== 'string' || index < 0) throw new Error('Private key no longer exists.');
      const current = this.keys[index];
      if (!Number.isSafeInteger(revision) || revision !== (current.revision ?? 0)) throw new Error('This key changed in another window. Close this dialog and try again.');
      const updated = { ...change(current), revision: revision + 1, updatedAt: new Date().toISOString() };
      const next = [...this.keys]; next[index] = updated;
      await this.persist(next); return this.view(updated);
    });
    this.queue = work.catch(() => {}); return work;
  }
  private async persist(keys: Key[]): Promise<void> {
    if (!this.protector.isEncryptionAvailable() || this.protector.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure credential storage is unavailable.');
    const encrypted = this.protector.encryptString(JSON.stringify(keys)).toString('base64');
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, encrypted }), { mode: 0o600 });
      await fs.rename(temporary, this.file); this.keys = keys;
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async migrate<T extends Endpoint>(input: T): Promise<T> {
    let privateKey = input.privateKey;
    // Incoming encrypted sync may carry another device's reference along with its key.
    if (input.privateKeyId && this.keys.some(key => key.id === input.privateKeyId)) return this.reference(input);
    if (!privateKey?.trim() && input.privateKeyPath) {
      if ((await fs.stat(input.privateKeyPath)).size > 65536) throw new Error('Private key file is too large.');
      privateKey = await fs.readFile(input.privateKeyPath, 'utf8');
    }
    if (!privateKey) { if (input.privateKeyId) this.resolve(input); return { ...input }; }
    const key = await this.add('', privateKey, input.passphrase, true);
    return this.reference({ ...input, privateKeyId: key.id });
  }
  reference<T extends Endpoint>(input: T): T {
    if (!input.privateKeyId) return { ...input };
    return { ...input, privateKey: undefined, passphrase: undefined, privateKeyPath: undefined };
  }
}
