import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NotesServerConnection, quote } from './connection';
import { NotesServerSettings } from './settings';

export interface ServerHealth { protocol: number; version: string; instanceId: string; revision: number; vaultSchema?: number; }
function olderVersion(remote: string, local: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(remote) || !/^\d+\.\d+\.\d+$/.test(local)) return false;
  const left = remote.split('.').map(Number), right = local.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] < right[index];
  return false;
}
export class NotesServerDeployment {
  readonly unit: string;
  readonly directoryName: string;
  private controller?: AbortController;
  private apiController?: AbortController;
  private apiConnection?: Promise<{ connection: NotesServerConnection; port: number; token: string }>;
  private apiIdleTimer?: ReturnType<typeof setTimeout>;
  private apiIdentity?: string;
  private upgradeAttempted = false;
  constructor(readonly settings: NotesServerSettings, private readonly bundle: string, private readonly version: string, development: boolean) {
    this.directoryName = development ? 'service-manager-dev-notes' : 'service-manager-notes';
    this.unit = `${this.directoryName}.service`;
  }
  cancel(): void { this.controller?.abort(); this.closeApi(); }
  private closeApi(): void {
    clearTimeout(this.apiIdleTimer); this.apiIdleTimer = undefined;
    this.apiController?.abort(); this.apiController = undefined; this.apiConnection = undefined;
    this.apiIdentity = undefined;
  }
  async session<T>(work: (connection: NotesServerConnection, base: string) => Promise<T>): Promise<T> {
    if (this.controller) throw new Error('A Notes Server operation is already running.');
    this.closeApi();
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 300_000); let connection: NotesServerConnection | undefined;
    try {
      connection = await NotesServerConnection.open(this.settings.endpoint(), controller.signal);
      const home = await connection.exec('printf %s "$HOME"');
      if (!home.startsWith('/') || /[\r\n\0%]/.test(home)) throw new Error('Unsupported server home directory.');
      return await work(connection, `${home}/.local/share/${this.directoryName}`);
    } finally { clearTimeout(timeout); connection?.close(); if (this.controller === controller) this.controller = undefined; }
  }
  async config(connection: NotesServerConnection, base: string): Promise<{ port: number; token: string }> {
    const raw = JSON.parse((await connection.read(`${base}/server.json`)).toString('utf8'));
    if (!raw || !Number.isInteger(raw.port) || raw.port < 1024 || raw.port > 65535 || !/^[a-f0-9]{64}$/.test(raw.token)) throw new Error('Invalid Notes Server configuration.');
    return { port: raw.port, token: raw.token };
  }
  async api<T>(route: string, payload?: unknown, binary = false): Promise<T> {
    if (this.controller) throw new Error('A Notes Server operation is already running.');
    if (this.apiIdentity !== this.settings.identity) this.closeApi();
    clearTimeout(this.apiIdleTimer);
    if (!this.apiConnection) {
      this.apiIdentity = this.settings.identity;
      const controller = new AbortController(); this.apiController = controller;
      this.apiConnection = (async () => {
        const timeout = setTimeout(() => controller.abort(), 30_000);
        let connection: NotesServerConnection | undefined;
        try {
          connection = await NotesServerConnection.open(this.settings.endpoint(), controller.signal);
          const home = await connection.exec('printf %s "$HOME"');
          if (!home.startsWith('/') || /[\r\n\0%]/.test(home)) throw new Error('Unsupported server home directory.');
          const config = await this.config(connection, `${home}/.local/share/${this.directoryName}`);
          return { connection, ...config };
        } catch (error) { connection?.close(); throw error; }
        finally { clearTimeout(timeout); }
      })();
    }
    const pending = this.apiConnection;
    try {
      const { connection, port, token } = await pending;
      if (this.apiConnection !== pending) throw new Error('Operation cancelled.');
      if (!connection.usable) {
        this.closeApi();
        throw new Error('Notes server is disconnected.');
      }
      return await connection.api<T>(port, token, route, payload, binary);
    } catch (error) {
      if (this.apiConnection === pending) this.closeApi();
      throw error;
    } finally {
      if (this.apiConnection === pending) {
        clearTimeout(this.apiIdleTimer);
        this.apiIdleTimer = setTimeout(() => this.closeApi(), 60_000);
        this.apiIdleTimer.unref();
      }
    }
  }
  async health(requiredVaultSchema = 0): Promise<ServerHealth> {
    let health = await this.api<ServerHealth>('/v1/health');
    if (health.protocol !== 1 || typeof health.instanceId !== 'string' || !Number.isSafeInteger(health.revision)) throw new Error('Unsupported Notes Server protocol.');
    if (this.settings.enabled && this.settings.instanceId === health.instanceId
      && !this.upgradeAttempted && (olderVersion(health.version, this.version)
        || (health.version === this.version && (health.vaultSchema ?? 0) < requiredVaultSchema))) {
      this.upgradeAttempted = true;
      await this.deploy();
      const updated = await this.api<ServerHealth>('/v1/health');
      if (updated.protocol !== 1 || updated.instanceId !== health.instanceId
        || !Number.isSafeInteger(updated.revision) || updated.revision < health.revision || updated.version !== this.version) {
        throw new Error('Notes Server upgrade verification failed.');
      }
      health = updated;
    }
    if (requiredVaultSchema > 0 && (!Number.isSafeInteger(health.vaultSchema) || health.vaultSchema! < requiredVaultSchema)) {
      throw new Error('The remote Vault format is outdated. Deploy the current Notes Server in Settings, then retry.');
    }
    return health;
  }
  async test(): Promise<string> {
    return this.session(async (c, base) => {
      const info = await this.preflight(c, base); return `Connection ready: Linux ${info}. systemd and lingering are available.`;
    });
  }
  private async preflight(c: NotesServerConnection, base: string): Promise<'x64' | 'arm64'> {
    const platform = await c.exec('uname -s'); if (platform !== 'Linux') throw new Error('Notes Server requires Linux.');
    const machine = await c.exec('uname -m'); const arch = machine === 'x86_64' ? 'x64' : machine === 'aarch64' ? 'arm64' : undefined;
    if (!arch) throw new Error('Supported architectures: Linux x64 and ARM64.');
    await c.exec('command -v systemctl >/dev/null && command -v tar >/dev/null && command -v sha256sum >/dev/null && getconf GNU_LIBC_VERSION >/dev/null');
    await c.exec('systemctl --user show-environment >/dev/null');
    const linger = await c.exec('loginctl show-user "$USER" -p Linger --value');
    if (linger !== 'yes') throw new Error('Enable user lingering first: sudo loginctl enable-linger <username>.');
    const free = Number(await c.exec('df -Pk "$HOME" | awk \'END {print $4}\''));
    if (!Number.isFinite(free) || free < 512 * 1024) throw new Error('At least 512 MiB of free disk space is required.');
    return arch;
  }
  async control(action: 'start' | 'stop' | 'restart' | 'logs'): Promise<string> {
    return this.session(async (c) => {
      if (action === 'logs') return c.exec(`journalctl --user -u ${quote(this.unit)} --no-pager -n 100 -o cat`);
      await c.exec(`systemctl --user ${action} ${quote(this.unit)}`); return `Notes Server ${action} completed.`;
    });
  }
  private async restoreUpgrade(c: NotesServerConnection, base: string): Promise<void> {
    const exists = await c.exec(`if test -f ${quote(`${base}/upgrade-recovery.json`)}; then printf yes; fi`);
    if (exists !== 'yes') return;
    const recovery = JSON.parse((await c.read(`${base}/upgrade-recovery.json`)).toString());
    if (typeof recovery.previous !== 'string' || !recovery.previous.startsWith(`${base}/releases/`)
      || typeof recovery.backup !== 'string' || !recovery.backup.startsWith(`${base}/data/backups/`)
      || typeof recovery.config !== 'string' || typeof recovery.unit !== 'string') throw new Error('Invalid upgrade recovery journal.');
    const unitPath = `${base.split('/.local/share/')[0]}/.config/systemd/user/${this.unit}`;
    await c.exec(`systemctl --user stop ${quote(this.unit)}`);
    // Schema-compatible releases retain all commits made since the upgrade backup.
    if (recovery.preserveDatabase !== true) {
      await c.exec(`cp -- ${quote(recovery.backup)} ${quote(`${base}/data/notes.sqlite3`)} && rm -f -- ${quote(`${base}/data/notes.sqlite3-wal`)} ${quote(`${base}/data/notes.sqlite3-shm`)}`);
    }
    await c.exec(`ln -sfn -- ${quote(recovery.previous)} ${quote(`${base}/current`)}`);
    await c.write(`${base}/server.json`, Buffer.from(recovery.config)); await c.write(unitPath, Buffer.from(recovery.unit));
    await c.exec(`systemctl --user daemon-reload && systemctl --user start ${quote(this.unit)} && rm -- ${quote(`${base}/upgrade-recovery.json`)}`);
  }
  async deploy(): Promise<string> {
    let upgradeStarted = false;
    return this.session(async (c, base) => {
      await this.restoreUpgrade(c, base);
      const arch = await this.preflight(c, base);
      const release = `${base}/releases/${this.version}-${randomUUID()}`;
      const unitDirectory = `${base.split('/.local/share/')[0]}/.config/systemd/user`;
      await c.exec(`mkdir -p -- ${quote(release)} ${quote(`${base}/data`)} ${quote(unitDirectory)} && chmod 700 -- ${quote(base)} ${quote(`${base}/data`)}`);
      const existing = await c.exec(`if test -f ${quote(`${base}/server.json`)}; then printf yes; fi`);
      let previous = ''; let savedBackup = ''; let configuration: any;
      let previousHealth: ServerHealth | undefined;
      if (existing === 'yes') {
        configuration = JSON.parse((await c.read(`${base}/server.json`)).toString());
        const validated = await this.config(c, base);
        previousHealth = await c.api<ServerHealth>(validated.port, validated.token, '/v1/health');
        if (previousHealth.protocol !== 1 || (this.settings.instanceId && previousHealth.instanceId !== this.settings.instanceId)) {
          throw new Error('The server database identity or protocol changed.');
        }
        // Refuse to upgrade an unhealthy server: the existing database must first be backed up consistently.
        const result = await c.api<{ name: string }>(validated.port, validated.token, '/v1/backups', {});
        if (!/^upgrade-[\dTZ-]+\.sqlite3$/.test(result.name)) throw new Error('Invalid backup response.');
        savedBackup = `${base}/data/backups/${result.name}`;
        previous = await c.exec(`readlink ${quote(`${base}/current`)}`);
      } else configuration = { port: this.directoryName.includes('-dev-') ? 47832 : 47831, token: randomBytes(32).toString('hex'), directory: `${base}/data`, version: this.version };
      const runtimeDirectory = path.join(this.bundle, 'notes-runtime');
      const manifest = JSON.parse(await fs.readFile(path.join(runtimeDirectory, 'manifest.json'), 'utf8'));
      const archive = await fs.readFile(path.join(runtimeDirectory, `linux-${arch}.tar.gz`));
      await c.write(`${release}/runtime.tar.gz`, archive);
      await c.exec(`printf '%s  %s\n' ${quote(manifest.hashes[`linux-${arch}`])} ${quote(`${release}/runtime.tar.gz`)} | sha256sum -c - >/dev/null && mkdir ${quote(`${release}/runtime`)} && tar -xzf ${quote(`${release}/runtime.tar.gz`)} -C ${quote(`${release}/runtime`)} --strip-components=1 && rm -- ${quote(`${release}/runtime.tar.gz`)}`);
      await c.exec(`${quote(`${release}/runtime/bin/node`)} -e 'require("node:sqlite"); process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)'`);
      await c.uploadDirectory(path.join(this.bundle, 'notes-server'), `${release}/app`);
      const oldConfig = JSON.stringify(configuration); configuration.version = this.version;
      const unit = `[Unit]\nDescription=Service Manager Notes\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${JSON.stringify(`${base}/current/runtime/bin/node`)} ${JSON.stringify(`${base}/current/app/notes-server/server.js`)} ${JSON.stringify(`${base}/server.json`)}\nRestart=on-failure\nRestartSec=3\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`;
      const unitPath = `${unitDirectory}/${this.unit}`;
      const previousUnit = existing === 'yes' ? await c.read(unitPath) : undefined;
      if (existing === 'yes' && previousUnit) {
        await c.write(`${base}/upgrade-recovery.json`, Buffer.from(JSON.stringify({ previous, backup: savedBackup, config: oldConfig, unit: previousUnit.toString('utf8'), preserveDatabase: true })));
        upgradeStarted = true;
      }
      try {
        if (existing === 'yes') await c.exec(`systemctl --user stop ${quote(this.unit)}`);
        await c.write(`${base}/server.json`, Buffer.from(JSON.stringify(configuration)));
        await c.write(unitPath, Buffer.from(unit));
        await c.exec(`ln -sfn -- ${quote(release)} ${quote(`${base}/current`)} && systemctl --user daemon-reload && systemctl --user enable --now ${quote(this.unit)}`);
        let healthy = false;
        for (let attempt = 0; attempt < 15; attempt++) {
          if (c.signal.aborted) throw new Error('Deployment cancelled.');
          try {
            const health = await c.api<ServerHealth>(configuration.port, configuration.token, '/v1/health');
            if (health.protocol === 1 && health.version === this.version
              && (!previousHealth || (health.instanceId === previousHealth.instanceId && health.revision >= previousHealth.revision))) {
              healthy = true; break;
            }
          } catch { /* bounded startup retry */ }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (!healthy) throw new Error('Notes Server did not become healthy.');
      } catch (error) {
        if (upgradeStarted && !c.signal.aborted) {
          await this.restoreUpgrade(c, base); upgradeStarted = false;
        }
        throw error;
      }
      if (upgradeStarted) {
        await c.exec(`rm -- ${quote(`${base}/upgrade-recovery.json`)}`); upgradeStarted = false;
      }
      return `Notes Server ${this.version} deployed and running (${arch}).`;
    }).catch(async error => {
      if (upgradeStarted) {
        try { await this.session((c, base) => this.restoreUpgrade(c, base)); }
        catch { throw new Error('Upgrade interrupted. Recovery is recorded on the server; reconnect and Deploy again to restore the previous version.'); }
      }
      throw error;
    });
  }
}
