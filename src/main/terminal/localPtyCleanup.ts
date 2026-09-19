import type { IPty } from 'node-pty';

// node-pty 1.1.0's WinPTY backend frees the native agent in kill(), but
// omits the output worker disposal performed by its ConPTY backend.
// Keep this compatibility access here while that dependency is pinned.
type WindowsPty = IPty & {
  _agent?: {
    _useConpty: boolean;
    _conoutSocketWorker?: { dispose(): void };
  };
};

export function disposeLocalPty(pty: IPty, exited: boolean, platform: NodeJS.Platform): void {
  const agent = platform === 'win32' ? (pty as WindowsPty)._agent : undefined;
  try {
    // A Windows shell exit does not release its PTY. On POSIX the process has
    // already been reaped, so signalling its PID could affect a reused PID.
    if (!exited || platform === 'win32') pty.kill(platform === 'win32' ? undefined : 'SIGKILL');
  } catch { /* The native PTY may already be closed. */ }
  if (agent?._useConpty === false) {
    try { agent._conoutSocketWorker?.dispose(); } catch { /* Already disposed. */ }
  }
}
