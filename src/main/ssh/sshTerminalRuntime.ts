import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { ClientChannel } from 'ssh2';
import type { HostConfig, TerminalOutput, SshTerminalState } from '../../shared/types';
import { hostToEndpoint, jumpHostsToEndpoints } from './hostConnection';
import { connectSshChain, type ConnectedSshChain } from './sshChain';

const OUTPUT_CHUNK = 16_384;
const OUTPUT_HIGH_WATER = 128 * 1024;
const OUTPUT_LOW_WATER = 64 * 1024;

interface Session {
  owner: number;
  state: SshTerminalState;
  fingerprint: string;
  abort: AbortController;
  chain?: ConnectedSshChain;
  channel?: ClientChannel;
  timer?: ReturnType<typeof setTimeout>;
  cols: number;
  rows: number;
  outstanding: number;
  pendingInput: number;
}

export interface SshTerminalRuntimeOptions {
  getHost(id: string): HostConfig | undefined;
  state(owner: number, state: SshTerminalState): void;
  output(owner: number, output: TerminalOutput): void;
  connect?(host: HostConfig, signal: AbortSignal): Promise<ConnectedSshChain>;
  timeoutMs?: number;
}

export function sshConnectionFingerprint(host: HostConfig): string {
  const endpoint = (value: HostConfig | HostConfig['jumpHosts'][number]) => [
    value.sshHost, value.sshPort, value.username, value.authType,
    value.authType === 'password' ? value.password : value.privateKey,
    value.authType === 'privateKey' ? value.passphrase : undefined,
  ];
  return createHash('sha256').update(JSON.stringify([
    endpoint(host), host.authType === 'privateKey' ? host.privateKeyPath : undefined,
    host.jumpHosts.map(endpoint),
  ])).digest('hex');
}

export function validateSshId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value)) {
    throw new Error('Invalid SSH identifier.');
  }
  return value;
}

export function validateSshDimensions(cols: unknown, rows: unknown): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)
    || Number(cols) < 1 || Number(rows) < 1 || Number(cols) > 1000 || Number(rows) > 1000) {
    throw new Error('Invalid SSH terminal dimensions.');
  }
}

/** Sessions and credentials never leave main; only the owning window receives output. */
export class SshTerminalRuntime {
  private readonly sessions = new Map<string, Session>();
  private stopped = false;

  constructor(private readonly options: SshTerminalRuntimeOptions) {}

  open(owner: number, hostId: string, id: string): SshTerminalState {
    validateSshId(hostId);
    validateSshId(id);
    if (this.stopped) throw new Error('SSH terminals are shutting down.');
    if (this.sessions.has(id)) throw new Error('SSH terminal already exists.');
    const host = this.options.getHost(hostId);
    if (!host) throw new Error('Host no longer exists.');
    const session: Session = {
      owner, state: { id, hostId, state: 'connecting' }, fingerprint: sshConnectionFingerprint(host),
      abort: new AbortController(), cols: 80, rows: 24, outstanding: 0, pendingInput: 0,
    };
    this.sessions.set(id, session);
    session.timer = setTimeout(() => this.finish(session, 'error', 'SSH connection timed out.'), this.options.timeoutMs ?? 30_000);
    void this.connect(session, host);
    return { ...session.state };
  }

  private alive(session: Session): boolean {
    return this.sessions.get(session.state.id) === session && !session.abort.signal.aborted;
  }

  private async connect(session: Session, host: HostConfig): Promise<void> {
    try {
      const connect = this.options.connect ?? (async (target, signal) => {
        const endpoint = await hostToEndpoint(target);
        return connectSshChain(endpoint, jumpHostsToEndpoints(target), { signal });
      });
      const chain = await connect(host, session.abort.signal);
      if (!this.alive(session)) {
        for (const client of chain.allClients) client.destroy();
        return;
      }
      session.chain = chain;
      for (const client of chain.allClients) {
        client.on('error', () => this.finish(session, 'error', 'SSH connection interrupted.'));
        client.on('close', () => this.finish(session, 'closed', 'SSH connection closed.'));
      }
      chain.targetClient.shell({ term: 'xterm-256color', cols: session.cols, rows: session.rows }, (error, channel) => {
        if (!this.alive(session)) { channel?.destroy(); return; }
        if (error) { this.finish(session, 'error', 'Could not open an interactive SSH shell.'); return; }
        clearTimeout(session.timer);
        session.timer = undefined;
        session.channel = channel;
        const stdout = new StringDecoder('utf8');
        const stderr = new StringDecoder('utf8');
        channel.on('data', (data: Buffer | string) => this.emit(session, typeof data === 'string' ? data : stdout.write(data)));
        channel.stderr.on('data', (data: Buffer | string) => this.emit(session, typeof data === 'string' ? data : stderr.write(data)));
        channel.once('end', () => { this.emit(session, stdout.end()); this.emit(session, stderr.end()); });
        channel.once('error', () => this.finish(session, 'error', 'SSH shell interrupted.'));
        channel.stderr.on('error', () => this.finish(session, 'error', 'SSH shell interrupted.'));
        const shellExited = (): void => this.finish(session, 'closed', undefined, 'shell-exit');
        channel.once('exit', shellExited);
        channel.once('close', shellExited);
        session.state = { ...session.state, state: 'open' };
        this.options.state(session.owner, { ...session.state });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      this.finish(session, 'error', /timed?\s*out|timeout/i.test(message)
        ? 'SSH connection timed out.'
        : /authentication|password|private key|passphrase/i.test(message)
          ? 'SSH authentication failed. Check the host credentials.'
          : 'SSH connection failed. Check the host connection settings.');
    }
  }

  private emit(session: Session, data: string): void {
    if (!this.alive(session)) return;
    for (let start = 0; start < data.length;) {
      let end = Math.min(data.length, start + OUTPUT_CHUNK);
      // Keep astral characters intact at the IPC string boundary as well as at UTF-8 decoding.
      if (end < data.length && data.charCodeAt(end - 1) >= 0xd800 && data.charCodeAt(end - 1) <= 0xdbff) end -= 1;
      const chunk = data.slice(start, end);
      start = end;
      session.outstanding += chunk.length;
      this.options.output(session.owner, { id: session.state.id, data: chunk });
    }
    if (session.outstanding >= OUTPUT_HIGH_WATER) {
      session.channel?.pause();
      session.channel?.stderr.pause();
    }
  }

  private owned(owner: number, id: string): Session | undefined {
    validateSshId(id);
    const session = this.sessions.get(id);
    if (session && session.owner !== owner) throw new Error('SSH terminal belongs to another window.');
    return session;
  }

  write(owner: number, id: string, data: unknown): void {
    if (typeof data !== 'string' || !data.length || data.length > 65_536) throw new Error('Invalid SSH terminal input.');
    const session = this.owned(owner, id);
    if (!session?.channel || session.state.state !== 'open') return;
    const bytes = Buffer.byteLength(data);
    if (session.pendingInput + bytes > 256 * 1024) throw new Error('SSH terminal input is busy.');
    session.pendingInput += bytes;
    session.channel.write(data, () => { session.pendingInput -= bytes; });
  }

  resize(owner: number, id: string, cols: number, rows: number): void {
    validateSshDimensions(cols, rows);
    const session = this.owned(owner, id);
    if (!session) return;
    session.cols = cols;
    session.rows = rows;
    session.channel?.setWindow(rows, cols, 0, 0);
  }

  acknowledge(owner: number, id: string, characters: unknown): void {
    if (!Number.isInteger(characters) || Number(characters) < 1 || Number(characters) > OUTPUT_CHUNK) {
      throw new Error('Invalid SSH output acknowledgement.');
    }
    const session = this.owned(owner, id);
    if (!session) return;
    session.outstanding = Math.max(0, session.outstanding - Number(characters));
    if (session.outstanding <= OUTPUT_LOW_WATER) {
      session.channel?.resume();
      session.channel?.stderr.resume();
    }
  }

  close(owner: number, id: string): void {
    const session = this.owned(owner, id);
    if (session) this.finish(session, 'closed', 'SSH session closed.');
  }

  closeOwner(owner: number): void {
    for (const session of this.sessions.values()) if (session.owner === owner) this.finish(session, 'closed');
  }

  reconcileHosts(hosts: HostConfig[]): void {
    const current = new Map(hosts.map((host) => [host.id, sshConnectionFingerprint(host)]));
    for (const session of this.sessions.values()) {
      if (current.get(session.state.hostId) !== session.fingerprint) {
        this.finish(session, 'closed', 'Host connection settings changed or the host was removed.');
      }
    }
  }

  shutdown(): void {
    this.stopped = true;
    for (const session of this.sessions.values()) this.finish(session, 'closed');
  }

  private finish(session: Session, state: 'closed' | 'error', error?: string, closeReason?: SshTerminalState['closeReason']): void {
    if (!this.alive(session)) return;
    this.sessions.delete(session.state.id);
    clearTimeout(session.timer);
    session.abort.abort();
    session.channel?.destroy();
    for (const client of session.chain?.allClients ?? []) client.destroy();
    session.state = { ...session.state, state, error, ...(closeReason ? { closeReason } : {}) };
    this.options.state(session.owner, { ...session.state });
  }
}
