import type { PrivateKeyVault } from '../vault/privateKeyVault';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { NotesShareCredentialProtector } from '../notes/notesShareSettingsStore';
import type { SshEndpointConfig } from '../ssh/sshChain';
import type { NotesServerSettingsDraft, NotesServerSettingsView } from '../../shared/types';

export class NotesServerSettings {
  private config?: SshEndpointConfig & { name: string; identity: string; sourceHostId?: string; privateKeyId?: string };
  private remote = false;
  private completed = false;
  get setupComplete(): boolean { return this.completed; }
  async completeSetup(): Promise<void> {
    await this.persist(this.config, this.remote, this.instanceId, true); this.completed = true;
  }
  instanceId?: string;
  constructor(private readonly file: string, private readonly protector: NotesShareCredentialProtector, private readonly vault?: PrivateKeyVault) {}
  get enabled(): boolean { return this.remote; }
  endpoint(): SshEndpointConfig { if (!this.config) throw new Error('Configure Notes Server first.'); return this.vault ? this.vault.resolve(this.config) : { ...this.config }; }
  get identity(): string { return this.config?.identity ?? ''; }
  view(): NotesServerSettingsView {
    const c = this.config;
    return { sourceHostId: c?.sourceHostId, setupComplete: this.completed, configured: Boolean(c), enabled: this.remote, name: c?.name ?? '', sshHost: c?.sshHost ?? '', sshPort: c?.sshPort ?? 22,
      privateKeyId: c?.privateKeyId, username: c?.username ?? '', authType: c?.authType ?? 'privateKey', hasPassword: Boolean(c?.password), hasPrivateKey: Boolean(c?.privateKeyId || c?.privateKey), hasPassphrase: Boolean(c?.passphrase), instanceId: this.instanceId };
  }
  async load(): Promise<void> {
    let raw: any; try { raw = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('Notes Server settings cannot be read.'); }
    try {
      const secret = JSON.parse(this.protector.decryptString(Buffer.from(raw.encrypted, 'base64')));
      this.completed = secret.setupComplete === true || (secret.setupComplete === undefined && secret.enabled === true && Boolean(secret.instanceId));
      this.config = secret.config; this.remote = this.completed || secret.enabled === true; this.instanceId = secret.instanceId;
    } catch { throw new Error('Notes Server credentials cannot be decrypted.'); }
    if (this.vault && this.config) { this.config = await this.vault.migrate(this.config); await this.persist(this.config, this.remote, this.instanceId); }
  }
  async save(input: NotesServerSettingsDraft): Promise<void> {
    if (this.remote && (!input || input.sshHost !== this.config?.sshHost || input.sshPort !== this.config?.sshPort || input.username !== this.config?.username)) throw new Error('The active Notes Server connection cannot be replaced.');
    if (!input || typeof input !== 'object' || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200
      || typeof input.sshHost !== 'string' || !input.sshHost.trim() || /[\s\0]/.test(input.sshHost) || input.sshHost.length > 253
      || typeof input.username !== 'string' || !/^[a-zA-Z0-9_.@-]{1,128}$/.test(input.username)
      || !Number.isInteger(input.sshPort) || input.sshPort < 1 || input.sshPort > 65535
      || !['password', 'privateKey'].includes(input.authType)) throw new Error('Invalid Notes Server connection.');
    for (const field of ['password', 'privateKey', 'passphrase'] as const) if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field]!.length > 65536)) throw new Error('Invalid authentication value.');
    const previous = this.config;
    const same = previous?.sshHost === input.sshHost && previous?.sshPort === input.sshPort && previous?.username === input.username;
    let config = { sourceHostId: input.sourceHostId, privateKeyId: input.privateKeyId, name: input.name.trim(), sshHost: input.sshHost.trim(), sshPort: input.sshPort, username: input.username, authType: input.authType,
      password: input.password || (same ? previous?.password : undefined), privateKey: input.privateKey || (same ? previous?.privateKey : undefined),
      passphrase: input.passphrase || (same ? previous?.passphrase : undefined), identity: same ? previous!.identity : randomUUID() };
    if (config.privateKeyId) { if (!this.vault) throw new Error('Vault is unavailable.'); this.vault.resolve(config); }
    if (this.vault) config = await this.vault.migrate(config);
    if (config.authType === 'password' ? !config.password : !config.privateKey && !config.privateKeyId) throw new Error('Authentication is required.');
    await this.persist(config, this.remote, same ? this.instanceId : undefined);
    this.config = config; if (!same) this.instanceId = undefined;
  }
  async setMode(enabled: boolean, instanceId = this.instanceId): Promise<void> {
    if (!enabled && this.completed) throw new Error('Local Notes storage is retired after migration.');
    await this.persist(this.config, enabled, instanceId); this.remote = enabled; this.instanceId = instanceId;
  }
  private async persist(config: typeof this.config, enabled: boolean, instanceId?: string, setupComplete = this.completed): Promise<void> {
    if (!this.protector.isEncryptionAvailable() || this.protector.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure credential storage is unavailable.');
    const encrypted = this.protector.encryptString(JSON.stringify({ config, enabled, instanceId, setupComplete })).toString('base64');
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ version: 1, encrypted }), { mode: 0o600 }); await fs.rename(temp, this.file);
  }
}
