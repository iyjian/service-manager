import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const KIBIBYTE = 1024;

export interface AppProcessMetric {
  memory: { workingSetSize: number };
}

export interface MemoryCommand {
  file: string;
  args: string[];
}

export interface AppMemoryCollectorOptions {
  metrics: () => readonly AppProcessMetric[];
  platform: NodeJS.Platform;
  mihomoPid?: number;
  run?: (file: string, args: readonly string[]) => Promise<string>;
}

function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function sumElectronWorkingSetBytes(metrics: readonly AppProcessMetric[]): number {
  return metrics.reduce((total, metric) => {
    const workingSetSize = metric?.memory?.workingSetSize;
    return isNonNegativeNumber(workingSetSize) ? total + workingSetSize * KIBIBYTE : total;
  }, 0);
}

export function childMemoryCommand(platform: NodeJS.Platform, pid: number): MemoryCommand | undefined {
  if (!isValidPid(pid)) {
    return undefined;
  }

  if (platform === 'darwin' || platform === 'linux') {
    return { file: 'ps', args: ['-o', 'rss=', '-p', String(pid)] };
  }

  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
      ],
    };
  }

  return undefined;
}

export function parseChildWorkingSetBytes(platform: NodeJS.Platform, stdout: string): number | undefined {
  const value = stdout.trim();
  if (!/^\d+$/.test(value)) {
    return undefined;
  }

  const workingSetSize = Number(value);
  if (!Number.isSafeInteger(workingSetSize)) {
    return undefined;
  }

  if (platform === 'darwin' || platform === 'linux') {
    return workingSetSize * KIBIBYTE;
  }

  if (platform === 'win32') {
    return workingSetSize;
  }

  return undefined;
}

async function runMemoryCommand(file: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { windowsHide: true });
  return stdout;
}

export async function collectAppMemoryUsage(
  options: AppMemoryCollectorOptions
): Promise<{ bytes?: number }> {
  let electronBytes: number;
  try {
    electronBytes = sumElectronWorkingSetBytes(options.metrics());
  } catch {
    return {};
  }

  const command = options.mihomoPid === undefined
    ? undefined
    : childMemoryCommand(options.platform, options.mihomoPid);
  if (!command) {
    return { bytes: electronBytes };
  }

  try {
    const run = options.run ?? runMemoryCommand;
    const stdout = await run(command.file, command.args);
    const childBytes = parseChildWorkingSetBytes(options.platform, stdout);
    return childBytes === undefined ? { bytes: electronBytes } : { bytes: electronBytes + childBytes };
  } catch {
    return { bytes: electronBytes };
  }
}
