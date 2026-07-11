import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import type { ProxyTunSupport } from '../../shared/types';

const execFileAsync = promisify(execFile);

// TUN needs the core to run with elevated network privileges. Mirroring
// clash-verge-rev (isTunModeAvailable = isAdminMode || isServiceOk) with a
// lighter mechanism: instead of a background service we grant the privilege
// to the core binary itself (setuid root on macOS, cap_net_admin on Linux).

async function isProcessAdmin(): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      await execFileAsync('net', ['session'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

async function isCorePrivileged(binaryPath: string): Promise<boolean> {
  if (process.platform === 'win32') {
    return false;
  }

  try {
    const stats = await fs.stat(binaryPath);
    if (process.platform === 'darwin') {
      return stats.uid === 0 && (stats.mode & 0o4000) !== 0;
    }
    // Linux: setuid root also works, but prefer file capabilities.
    if (stats.uid === 0 && (stats.mode & 0o4000) !== 0) {
      return true;
    }
    try {
      const { stdout } = await execFileAsync('getcap', [binaryPath], { timeout: 5000 });
      return /cap_net_admin/.test(stdout);
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

export async function checkTunSupport(binaryPath: string): Promise<ProxyTunSupport> {
  const [isAdmin, corePrivileged] = await Promise.all([isProcessAdmin(), isCorePrivileged(binaryPath)]);
  const available = isAdmin || corePrivileged;

  let hint: string | undefined;
  if (!available) {
    hint =
      process.platform === 'win32'
        ? 'Run the app as Administrator to use TUN mode.'
        : 'Grant the core elevated privileges to use TUN mode.';
  }

  return { available, isAdmin, corePrivileged, hint };
}

export async function grantTunPermission(binaryPath: string): Promise<void> {
  await fs.access(binaryPath);

  if (process.platform === 'darwin') {
    const script = `do shell script "chown root:wheel '${binaryPath.replace(/'/g, "'\\''")}' && chmod u+s '${binaryPath.replace(/'/g, "'\\''")}'" with administrator privileges`;
    await execFileAsync('osascript', ['-e', script], { timeout: 120000 });
    return;
  }

  if (process.platform === 'linux') {
    try {
      await execFileAsync('pkexec', ['setcap', 'cap_net_admin,cap_net_raw,cap_net_bind_service+ep', binaryPath], {
        timeout: 120000,
      });
      return;
    } catch (error) {
      throw new Error(
        `Authorization failed. Run manually: sudo setcap cap_net_admin,cap_net_raw,cap_net_bind_service+ep "${binaryPath}" (${(error as Error).message})`
      );
    }
  }

  throw new Error('On Windows, restart the app as Administrator to use TUN mode.');
}

export async function revokeTunPermission(binaryPath: string): Promise<void> {
  await fs.access(binaryPath);

  if (process.platform === 'darwin') {
    const uid = process.getuid?.() ?? 501;
    const escaped = binaryPath.replace(/'/g, "'\\''");
    const script = `do shell script "chmod u-s '${escaped}' && chown ${uid} '${escaped}'" with administrator privileges`;
    await execFileAsync('osascript', ['-e', script], { timeout: 120000 });
    return;
  }

  if (process.platform === 'linux') {
    await execFileAsync('pkexec', ['setcap', '-r', binaryPath], { timeout: 120000 });
    return;
  }

  throw new Error('Nothing to revoke on Windows; TUN uses the process elevation.');
}
