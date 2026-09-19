import os from 'node:os';
import path from 'node:path';
import type { IDisposable, IPty, IPtyForkOptions } from 'node-pty';
import type { LocalTerminalState, TerminalOutput } from '../../shared/types';
import { disposeLocalPty } from './localPtyCleanup';

const OUTPUT_CHUNK = 16_384;
const OUTPUT_HIGH_WATER = 128 * 1024;
const OUTPUT_LOW_WATER = 64 * 1024;

export function validateLocalTerminalId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value)) {
    throw new Error('Invalid local terminal identifier.');
  }
  return value;
}

export function localShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, loginShell?: string | null) {
  if (platform === 'win32') {
    return { file: path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo'], name: 'PowerShell' };
  }
  const shell = loginShell || env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  return { file: shell, args: ['-l'], name: path.basename(shell) };
}

// A local login shell inherits the user's environment, without the launcher
// switches that can accidentally run Electron/Node children in debug mode.
export function localShellEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'ServiceManager' };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_INSPECT_RESUME_ON_START', 'VSCODE_INSPECTOR_OPTIONS']) {
    delete (result as NodeJS.ProcessEnv)[key];
  }
  return result;
}

type PtyModule = { spawn(file: string, args: string[], options: IPtyForkOptions): IPty };
interface Session {
  owner: number;
  state: LocalTerminalState;
  pty?: IPty;
  listeners: IDisposable[];
  timer?: ReturnType<typeof setTimeout>;
  cols: number;
  rows: number;
  outstanding: number;
  inputBudget: number;
  inputAt: number;
}

export interface LocalTerminalOptions {
  state(owner: number, state: LocalTerminalState): void;
  output(owner: number, output: TerminalOutput): void;
  loadPty?: () => Promise<PtyModule>;
  shell?: { file: string; args: string[]; name: string };
  cwd?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

/** Window-owned local PTYs. Shell paths, environment and cwd are main-only. */
export class LocalTerminalRuntime {
  private readonly sessions = new Map<string, Session>();
  private stopped = false;
  private get platform(): NodeJS.Platform { return this.options.platform ?? process.platform; }
  constructor(private readonly options: LocalTerminalOptions) {}

  open(owner: number, id: string): LocalTerminalState {
    validateLocalTerminalId(id);
    if (this.stopped) throw new Error('Local terminals are shutting down.');
    if (this.sessions.has(id)) throw new Error('Local terminal already exists.');
    if ([...this.sessions.values()].filter((session) => session.owner === owner).length >= 32) {
      throw new Error('Close a local terminal before opening another.');
    }
    const shell = this.options.shell ?? localShell(this.platform, process.env, os.userInfo().shell);
    const session: Session = { owner, state: { id, shell: shell.name, state: 'connecting' }, listeners: [],
      cols: 80, rows: 24, outstanding: 0, inputBudget: 256 * 1024, inputAt: Date.now() };
    this.sessions.set(id, session);
    session.timer = setTimeout(() => this.finish(session, 'error', 'Local shell startup timed out.'), this.options.timeoutMs ?? 10_000);
    void this.start(session, shell);
    return { ...session.state };
  }

  private alive(session: Session): boolean { return this.sessions.get(session.state.id) === session; }

  private async start(session: Session, shell: { file: string; args: string[] }): Promise<void> {
    try {
      const ptyModule = await (this.options.loadPty?.() ?? Promise.resolve().then(() => require('node-pty') as PtyModule));
      if (!this.alive(session)) return;
      const pty = ptyModule.spawn(shell.file, shell.args, {
        name: 'xterm-256color', cols: session.cols, rows: session.rows,
        cwd: this.options.cwd ?? os.homedir(), env: localShellEnvironment(process.env), encoding: 'utf8',
      });
      session.pty = pty;
      session.listeners.push(pty.onData((data) => this.emit(session, data)));
      session.listeners.push(pty.onExit(() => this.finish(session, 'closed', undefined, true)));
      clearTimeout(session.timer);
      session.state = { ...session.state, state: 'open' };
      this.options.state(session.owner, { ...session.state });
    } catch {
      this.finish(session, 'error', 'Could not start the local shell. Check that the shell and terminal runtime are available.');
    }
  }

  private emit(session: Session, data: string): void {
    if (!this.alive(session)) return;
    if (session.outstanding + data.length > 1024 * 1024) {
      this.finish(session, 'error', 'Terminal output exceeded its buffer limit.');
      return;
    }
    for (let start = 0; start < data.length;) {
      let end = Math.min(data.length, start + OUTPUT_CHUNK);
      if (end < data.length && data.charCodeAt(end - 1) >= 0xd800 && data.charCodeAt(end - 1) <= 0xdbff) end--;
      const chunk = data.slice(start, end);
      start = end;
      session.outstanding += chunk.length;
      this.options.output(session.owner, { id: session.state.id, data: chunk });
    }
    if (session.outstanding >= OUTPUT_HIGH_WATER) session.pty?.pause();
  }

  private owned(owner: number, id: string): Session | undefined {
    validateLocalTerminalId(id);
    const session = this.sessions.get(id);
    if (session && session.owner !== owner) throw new Error('Local terminal belongs to another window.');
    return session;
  }

  write(owner: number, id: string, data: unknown): void {
    if (typeof data !== 'string' || !data.length || data.length > 65_536) throw new Error('Invalid local terminal input.');
    const session = this.owned(owner, id);
    if (!session?.pty || session.state.state !== 'open') return;
    const now = Date.now();
    session.inputBudget = Math.min(256 * 1024, session.inputBudget + (now - session.inputAt) * 256);
    session.inputAt = now;
    const bytes = Buffer.byteLength(data);
    if (bytes > session.inputBudget) throw new Error('Local terminal input is busy.');
    session.inputBudget -= bytes;
    try { session.pty.write(data); } catch { this.finish(session, 'error', 'Local shell input failed.'); }
  }

  resize(owner: number, id: string, cols: unknown, rows: unknown): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || Number(cols) < 1 || Number(rows) < 1
      || Number(cols) > 1000 || Number(rows) > 1000) throw new Error('Invalid local terminal dimensions.');
    const session = this.owned(owner, id);
    if (!session) return;
    session.cols = Number(cols); session.rows = Number(rows);
    try { session.pty?.resize(session.cols, session.rows); } catch { this.finish(session, 'error', 'Local shell resize failed.'); }
  }

  acknowledge(owner: number, id: string, characters: unknown): void {
    if (!Number.isInteger(characters) || Number(characters) < 1 || Number(characters) > OUTPUT_CHUNK) {
      throw new Error('Invalid local output acknowledgement.');
    }
    const session = this.owned(owner, id);
    if (!session) return;
    session.outstanding = Math.max(0, session.outstanding - Number(characters));
    if (session.outstanding <= OUTPUT_LOW_WATER) session.pty?.resume();
  }

  close(owner: number, id: string): void {
    const session = this.owned(owner, id);
    if (session) this.finish(session, 'closed');
  }
  closeOwner(owner: number): void {
    for (const session of this.sessions.values()) if (session.owner === owner) this.finish(session, 'closed');
  }
  shutdown(): void {
    this.stopped = true;
    for (const session of this.sessions.values()) this.finish(session, 'closed');
  }
  private finish(session: Session, state: 'closed' | 'error', error?: string, exited = false): void {
    if (!this.alive(session)) return;
    this.sessions.delete(session.state.id);
    clearTimeout(session.timer);
    for (const listener of session.listeners) listener.dispose();
    if (session.pty) disposeLocalPty(session.pty, exited, this.platform);
    session.state = { ...session.state, state, error, ...(exited ? { closeReason: 'shell-exit' as const } : {}) };
    this.options.state(session.owner, { ...session.state });
  }
}
