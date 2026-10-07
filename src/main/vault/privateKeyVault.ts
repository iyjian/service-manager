import { planChromeImport, type ChromeRow } from './chromeImport';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { utils } from 'ssh2';
import type { VaultEntryDraft, VaultEntryView, HostConfig, VaultKeyView } from '../../shared/types';
import type { NotesShareCredentialProtector } from '../notes/notesShareSettingsStore';

import { entryDraft, entryView, validateRecords, type VaultRecord } from './entries';
type Key = VaultRecord;
export interface VaultRemote {
  enabled(): boolean;
  read(): Promise<{ instanceId: string; revision: number; records: Key[] }>;
  import(records: Key[], instanceId: string): Promise<void>;
  write(records: Key[], revision: number, instanceId: string): Promise<void>;
}
type Endpoint = { privateKeyId?: string; privateKey?: string; passphrase?: string; privateKeyPath?: string };
export class PrivateKeyVault {
  private keys: Key[] = [];
  private remote?: VaultRemote;
  private migratedInstance?: string;
  private remoteRevision = 0;
  private remoteLoaded = false;
  get remoteReady(): boolean { return this.remoteLoaded; }
  private remoteChanged?: () => Promise<void>;
  private remoteMessage = 'Local encrypted Vault. Configure Notes Server to migrate.';
  attachRemote(remote: VaultRemote, changed?: () => Promise<void>): void { this.remote = remote; this.remoteChanged = changed; }
  status(): { message: string } { return { message: this.remoteMessage }; }
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private protector: NotesShareCredentialProtector) {}
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const decoded = JSON.parse(this.protector.decryptString(Buffer.from(raw.encrypted, 'base64')));
      this.keys = validateRecords(Array.isArray(decoded) ? decoded : decoded.records);
      this.migratedInstance = Array.isArray(decoded) ? undefined : decoded.migratedInstance;
      this.remoteRevision = Array.isArray(decoded) ? 0 : decoded.remoteRevision ?? 0;
      if (!Number.isSafeInteger(this.remoteRevision) || this.remoteRevision < 0) throw new Error('Invalid Vault revision.');
      if (this.migratedInstance !== undefined && (typeof this.migratedInstance !== 'string' || !this.migratedInstance || this.migratedInstance.length > 128)) throw new Error('Invalid Vault identity.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Vault could not be unlocked.'); }
  }
  list(): VaultKeyView[] { return this.keys.filter(key => !key.type || key.type === 'sshKey').map(key => this.view(key)); }
  private view({ id, name, createdAt, updatedAt, revision }: Key): VaultKeyView { return { id, name, createdAt, ...(updatedAt ? { updatedAt } : {}), ...(revision !== undefined ? { revision } : {}) }; }
  resolve<T extends Endpoint>(input: T): T {
    if (!input.privateKeyId) return { ...input };
    const key = this.keys.find(key => key.id === input.privateKeyId);
    if (!key || (key.type && key.type !== 'sshKey')) throw new Error('The selected Vault key is unavailable on this device.');
    return { ...input, privateKey: key.privateKey, passphrase: key.passphrase, privateKeyPath: undefined };
  }
  resolveHost<T extends HostConfig>(host: T): T {
    return { ...this.resolve(host), jumpHosts: host.jumpHosts.map(hop => this.resolve(hop)) };
  }
  reuseReference<T extends Endpoint>(input: T): T {
    if (!input.privateKey?.trim()) return { ...input };
    const existing = this.keys.find(key => key.privateKey?.trim() === input.privateKey?.trim() && (key.passphrase ?? '') === (input.passphrase ?? ''));
    return existing ? this.resolve({ ...input, privateKeyId: existing.id }) : { ...input };
  }
  async add(name: string, privateKey: string, passphrase?: string, migration = false): Promise<VaultKeyView> {
    const work = this.queue.then(async () => {
      await this.refreshRemote();
      if (typeof privateKey !== 'string' || !privateKey.trim() || Buffer.byteLength(privateKey) > 65536 || (passphrase !== undefined && (typeof passphrase !== 'string' || passphrase.length > 65536))) throw new Error('Invalid private key.');
      if (!migration) {
        if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Key name is required (up to 200 characters).');
        const parsed = utils.parseKey(privateKey, passphrase);
        if (parsed instanceof Error || Array.isArray(parsed) || !parsed.isPrivateKey()) throw new Error('Invalid private key or passphrase.');
      }
      const existing = this.keys.find(key => key.privateKey?.trim() === privateKey.trim() && (key.passphrase ?? '') === (passphrase ?? ''));
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
      await this.refreshRemote();
      const index = this.keys.findIndex(key => key.id === id);
      if (typeof id !== 'string' || index < 0) throw new Error('Private key no longer exists.');
      const current = this.keys[index];
      if (current.type && current.type !== 'sshKey') throw new Error('Not an SSH key.');
      if (!Number.isSafeInteger(revision) || revision !== (current.revision ?? 0)) throw new Error('This key changed in another window. Close this dialog and try again.');
      const updated = { ...change(current), revision: revision + 1, updatedAt: new Date().toISOString() };
      const next = [...this.keys]; next[index] = updated;
      await this.persist(next); return this.view(updated);
    });
    this.queue = work.catch(() => {}); return work;
  }
  private async persist(keys: Key[]): Promise<void> {
    keys = validateRecords(keys);
    if (!this.protector.isEncryptionAvailable() || this.protector.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure credential storage is unavailable.');
    if (this.remote?.enabled()) {
      if (!this.migratedInstance) throw new Error('Connect to the remote Vault before saving.');
      await this.remote.write(keys, this.remoteRevision, this.migratedInstance);
      this.remoteRevision++;
    } else if (this.migratedInstance) throw new Error('The remote Vault is unavailable. Local edits are disabled.');
    await this.persistLocal(keys);
  }
  private async persistLocal(keys: Key[]): Promise<void> {
    if (!this.protector.isEncryptionAvailable() || this.protector.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure credential storage is unavailable.');
    const encrypted = this.protector.encryptString(JSON.stringify({ records: keys, migratedInstance: this.migratedInstance, remoteRevision: this.remoteRevision })).toString('base64');
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, encrypted }), { mode: 0o600 });
      await fs.rename(temporary, this.file); this.keys = keys;
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  entries(): VaultEntryView[] { return this.keys.filter(record => record.type !== 'secureNote' && !record.deletedAt).map(entryView); }
  secret(id: string, field: 'username' | 'password' | 'notes', accountId?: string): string {
    const record = this.keys.find(key => key.id === id);
    if (!record || !['username', 'password', 'notes'].includes(field) || record.type !== 'login') throw new Error('Entry is unavailable.');
    const account = accountId ? record.accounts?.find(account => account.id === accountId) : record.accounts?.length === 1 ? record.accounts[0] : undefined;
    if (!account) throw new Error('Account is unavailable.');
    return account[field];
  }
  async saveEntry(input: VaultEntryDraft): Promise<VaultEntryView> {
    const work = this.queue.then(async () => {
      await this.refreshRemote();
      if (!input || input.type !== 'login') throw new Error('Invalid Vault entry type.');
      if (input.id !== undefined && (typeof input.id !== 'string' || !input.id || input.id.length > 128)) throw new Error('Invalid entry ID.');
      const previous = input.id ? this.keys.find(key => key.id === input.id) : undefined;
      if (input.id && (!previous || previous.deletedAt || previous.type !== input.type || input.revision !== (previous.revision ?? 0))) throw new Error('Entry changed. Refresh before editing.');
      const draft = entryDraft(input, previous);
      if (this.keys.some(record => record.type === 'login' && record.id !== previous?.id && record.loginUrl === draft.loginUrl)) throw new Error('This website already exists. Edit it to add an account.');
      const record: Key = { ...previous, ...draft, id: previous?.id ?? randomUUID(), createdAt: previous?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(), revision: (previous?.revision ?? -1) + 1 };
      await this.persist(previous ? this.keys.map(key => key.id === previous.id ? record : key) : [...this.keys, record]);
      return entryView(record);
    });
    this.queue = work.catch(() => {}); return work;
  }
  async deleteLogin(id: string, revision: number): Promise<void> {
    const work = this.queue.then(async () => {
      if (typeof id !== 'string' || !id || id.length > 128 || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid Login deletion.');
      await this.refreshRemote();
      const previous = this.keys.find(record => record.id === id);
      if (!previous || previous.type !== 'login' || previous.deletedAt || (previous.revision ?? 0) !== revision) throw new Error('Login changed. Refresh before deleting.');
      const now = new Date().toISOString();
      // Keep only an identity marker so older caches cannot resurrect deleted credentials.
      const deleted: Key = { id, type: 'login', name: 'Deleted login', createdAt: previous.createdAt, updatedAt: now, deletedAt: now, revision: revision + 1, loginUrl: '', accounts: [] };
      await this.persist(this.keys.map(record => record.id === id ? deleted : record));
    });
    this.queue = work.catch(() => {}); return work;
  }
  private fingerprint(): string { return createHash('sha256').update(JSON.stringify(this.keys)).digest('hex'); }
  async previewImport(rows: ChromeRow[]): Promise<{ fingerprint: string; rows: ReturnType<typeof planChromeImport>['rows'] }> {
    const work = this.queue.then(async () => { await this.refreshRemote(); return { fingerprint: this.fingerprint(), rows: planChromeImport(this.keys, rows).rows }; });
    this.queue = work.catch(() => {}); return work;
  }
  async importAccounts(rows: ChromeRow[], fingerprint: string): Promise<{ accounts: number; websites: number }> {
    const work = this.queue.then(async () => {
      await this.refreshRemote();
      if (fingerprint !== this.fingerprint()) throw new Error('Vault changed. Reopen the import preview before importing.');
      const plan = planChromeImport(this.keys, rows);
      if (plan.rows.some(row => row.status !== 'ready')) throw new Error('Import selection changed. Reopen the preview.');
      if (plan.accounts) await this.persist(plan.records);
      return { accounts: plan.accounts, websites: plan.websites };
    });
    this.queue = work.catch(() => {}); return work;
  }
  async refresh(): Promise<{ message: string }> {
    const work = this.queue.then(async () => {
      try { await this.refreshRemote(); } catch { this.remoteLoaded = false; this.remoteMessage = 'Remote Vault unavailable or conflicting. Local encrypted data preserved; retry Refresh.'; }
      return { message: this.remoteMessage };
    });
    this.queue = work.catch(() => {}); return work;
  }
  private async refreshRemote(): Promise<void> {
    if (!this.remote?.enabled()) { this.remoteMessage = this.migratedInstance ? 'Remote Vault disconnected. Local recovery cache is read-only.' : 'Local encrypted Vault. Configure Notes Server to migrate.'; return; }
    let snapshot = await this.remote.read();
    const validateSnapshot = () => {
      if (!snapshot || typeof snapshot.instanceId !== 'string' || !snapshot.instanceId || snapshot.instanceId.length > 128 || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error('Invalid remote Vault.');
      snapshot.records = validateRecords(snapshot.records);
    };
    validateSnapshot();
    if (this.migratedInstance && this.migratedInstance !== snapshot.instanceId) throw new Error('Remote Vault identity changed.');
    const snapshotIds = new Set(snapshot.records.map(record => record.id));
    if (this.migratedInstance && (snapshot.revision < this.remoteRevision || this.keys.some(key => !snapshotIds.has(key.id)))) throw new Error('Remote Vault data is older or incomplete. Local recovery cache preserved.');
    if (!this.migratedInstance) {
      // Preserve the exact pre-migration encrypted source. Never overwrite an existing backup.
      try { await fs.copyFile(this.file, `${this.file}.migration-backup`, 1); } catch (error) {
        if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      await this.remote.import(this.keys, snapshot.instanceId);
      const expectedInstance = snapshot.instanceId;
      snapshot = await this.remote.read();
      validateSnapshot();
      if (snapshot.instanceId !== expectedInstance) throw new Error('Remote Vault identity changed.');
      const remoteIds = new Set(snapshot.records.map(record => record.id));
      if (this.keys.some(key => !remoteIds.has(key.id))) throw new Error('Vault migration verification failed.');
      this.migratedInstance = snapshot.instanceId;
    }
    const records = validateRecords(snapshot.records);
    this.remoteRevision = snapshot.revision;
    await this.persistLocal(records);
    this.remoteLoaded = true;
    this.remoteMessage = 'Remote Vault connected · Local recovery cache enabled · Copied secrets clear after 30s';
    await this.remoteChanged?.();
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
