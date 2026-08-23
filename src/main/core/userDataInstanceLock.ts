import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const USER_DATA_INSTANCE_LOCK_FILE_NAME = '.service-manager-instance.lock';
export const CHROMIUM_SINGLETON_LOCK_FILE_NAME = 'SingletonLock';

const LOCK_SCHEMA_VERSION = 1 as const;
const DEFAULT_CORRUPT_LOCK_STALE_MS = 30_000;
const MAX_LOCK_BYTES = 4 * 1024;
const MAX_ACQUIRE_ATTEMPTS = 16;

type LockSource = 'service-manager' | 'chromium';

interface LockRecord {
  schemaVersion: typeof LOCK_SCHEMA_VERSION;
  pid: number;
  ownerToken: string;
  acquiredAt: string;
}

interface ProcessIdentity {
  /** Epoch milliseconds at which the process started, when determinable. */
  startTimeMs?: number;
  /** Numeric real user ID of the process owner, when determinable. */
  uid?: number;
}

interface LockSnapshot {
  identity: string;
  modifiedAtMs: number;
  record?: LockRecord;
}

export interface UserDataInstanceLockOptions {
  /** Process identity override used by focused lock tests. */
  pid?: number;
  /** Platform override used by focused lock tests. */
  platform?: NodeJS.Platform;
  /** Clock override used to classify an incomplete or damaged lock as stale. */
  now?: () => Date;
  /** Owner-token override used by focused lock tests. */
  createOwnerToken?: () => string;
  /** Process liveness override used by focused lock tests. */
  isProcessAlive?: (pid: number) => boolean;
  /** Process identity override used by focused lock tests. */
  processIdentityForPid?: (pid: number) => ProcessIdentity | undefined;
  /** Current process UID override used by focused lock tests. */
  currentUid?: number;
  /** Damaged locks newer than this remain owned in case their writer is mid-write. */
  corruptLockStaleMs?: number;
}

export interface UserDataInstanceLock {
  readonly lockPath: string;
  readonly ownerToken: string;
  readonly pid: number;
  /** Removes the lock only while the on-disk owner token is still this handle's token. */
  release(): boolean;
}

export type UserDataInstanceLockProbeOptions = Pick<
  UserDataInstanceLockOptions,
  'pid' | 'platform' | 'now' | 'isProcessAlive' | 'processIdentityForPid' | 'currentUid' | 'corruptLockStaleMs'
>;

export class UserDataInstanceLockError extends Error {
  readonly code = 'USER_DATA_ALREADY_IN_USE' as const;

  constructor(
    readonly source: LockSource,
    readonly ownerPid?: number,
  ) {
    super('Service Manager data is already in use by another process.');
    this.name = 'UserDataInstanceLockError';
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function normalizePid(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function normalizeOwnerToken(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) return undefined;
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
}

function parseLockRecord(raw: string): LockRecord | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as Record<string, unknown>;
    const pid = normalizePid(candidate.pid);
    const ownerToken = normalizeOwnerToken(candidate.ownerToken);
    const acquiredAt = normalizeTimestamp(candidate.acquiredAt);
    if (candidate.schemaVersion !== LOCK_SCHEMA_VERSION || !pid || !ownerToken || !acquiredAt) {
      return undefined;
    }
    return { schemaVersion: LOCK_SCHEMA_VERSION, pid, ownerToken, acquiredAt };
  } catch {
    return undefined;
  }
}

function lockIdentity(stats: fs.Stats, raw: string): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${raw}`;
}

function readLockSnapshot(lockPath: string): LockSnapshot | undefined {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(lockPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }

  if (!stats.isFile() || stats.size > MAX_LOCK_BYTES) {
    return {
      identity: lockIdentity(stats, ''),
      modifiedAtMs: stats.mtimeMs,
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  return {
    identity: lockIdentity(stats, raw),
    modifiedAtMs: stats.mtimeMs,
    record: parseLockRecord(raw),
  };
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false;
    // EPERM still proves that a process owns the PID. Unknown probe failures
    // fail closed so they cannot turn a live owner's lock into a stale lock.
    return true;
  }
}

function linuxProcessIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const statClose = stat.lastIndexOf(')');
    if (statClose < 0) return undefined;
    const fields = stat.slice(statClose + 2).split(' ');
    // After "pid (comm) ", field 22 (starttime in USER_HZ ticks) is index 19.
    const startTicks = Number(fields[19]);

    let uid: number | undefined;
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const uidMatch = /^Uid:\s+(\d+)/m.exec(status);
      uid = uidMatch ? Number(uidMatch[1]) : undefined;
    } catch {
      // The UID stays unknown; the start-time check still applies.
    }
    if (!Number.isFinite(startTicks)) return { ...(uid !== undefined ? { uid } : {}) };

    const statBtime = fs.readFileSync('/proc/stat', 'utf8');
    const btimeMatch = /^btime\s+(\d+)/m.exec(statBtime);
    if (!btimeMatch) return { ...(uid !== undefined ? { uid } : {}) };
    return {
      startTimeMs: (Number(btimeMatch[1]) + startTicks / 100) * 1_000,
      ...(uid !== undefined ? { uid } : {}),
    };
  } catch {
    return undefined;
  }
}

function darwinProcessIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const output = execFileSync('ps', ['-o', 'lstart=', '-o', 'uid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
    });
    const trimmed = output.trim();
    if (!trimmed) return undefined;
    const uidMatch = /(\d+)\s*$/.exec(trimmed);
    const startText = trimmed.replace(/\s+\d+\s*$/, '').trim();
    const startTimeMs = startText ? Date.parse(startText) : NaN;
    return {
      ...(Number.isFinite(startTimeMs) ? { startTimeMs } : {}),
      ...(uidMatch ? { uid: Number(uidMatch[1]) } : {}),
    };
  } catch {
    return undefined;
  }
}

function defaultProcessIdentityForPid(pid: number, platform: NodeJS.Platform): ProcessIdentity | undefined {
  if (platform === 'linux') return linuxProcessIdentity(pid);
  if (platform === 'darwin') return darwinProcessIdentity(pid);
  return undefined;
}

/**
 * Decides whether the on-disk lock's PID is really the Service Manager
 * instance that wrote it. PID existence alone is not enough: an unrelated
 * process (for example a macOS system daemon) can reuse the PID after the
 * original owner exits without cleanup. Identity checks fail closed, so an
 * undeterminable identity never steals a live owner's lock.
 */
function isLockOwnerAlive(
  record: LockRecord,
  isProcessAlive: (pid: number) => boolean,
  processIdentityForPid: (pid: number) => ProcessIdentity | undefined,
  currentUid: number | undefined,
): boolean {
  if (!isProcessAlive(record.pid)) return false;
  const identity = processIdentityForPid(record.pid);
  if (!identity) return true;
  if (currentUid !== undefined && identity.uid !== undefined && identity.uid !== currentUid) {
    // A different user owns the PID; it cannot be this app instance.
    return false;
  }
  if (identity.startTimeMs !== undefined) {
    const acquiredAtMs = Date.parse(record.acquiredAt);
    // The original owner must have started before it wrote the lock. A holder
    // that started afterwards can only be a reused PID, so the lock is stale.
    if (Number.isFinite(acquiredAtMs) && identity.startTimeMs > acquiredAtMs) {
      return false;
    }
  }
  return true;
}

function chromiumSingletonPid(userDataPath: string): number | undefined {
  const singletonPath = path.join(userDataPath, CHROMIUM_SINGLETON_LOCK_FILE_NAME);
  try {
    if (!fs.lstatSync(singletonPath).isSymbolicLink()) return undefined;
    const target = fs.readlinkSync(singletonPath);
    const match = /-([1-9][0-9]{0,14})$/.exec(target);
    return match ? normalizePid(Number(match[1])) : undefined;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'EINVAL')) return undefined;
    throw error;
  }
}

function assertNoLiveChromiumOwner(
  userDataPath: string,
  platform: NodeJS.Platform,
  pid: number,
  isProcessAlive: (candidatePid: number) => boolean,
): void {
  if (platform !== 'darwin' && platform !== 'linux') return;
  const singletonPid = chromiumSingletonPid(userDataPath);
  if (singletonPid && singletonPid !== pid && isProcessAlive(singletonPid)) {
    throw new UserDataInstanceLockError('chromium', singletonPid);
  }
}

function serializeLockRecord(record: LockRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Read-only startup probe run before Electron's ProcessSingleton acquisition.
 * Dead/old stale records are deliberately left in place: only the process
 * that subsequently owns Electron's lock may reclaim them.
 */
export function assertUserDataInstanceLockAvailable(
  userDataPath: string,
  options: UserDataInstanceLockProbeOptions = {},
): void {
  const pid = normalizePid(options.pid ?? process.pid);
  if (!pid) throw new Error('The current process ID is invalid.');
  const platform = options.platform ?? process.platform;
  const now = options.now ?? (() => new Date());
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const processIdentityForPid = options.processIdentityForPid
    ?? ((pid: number) => defaultProcessIdentityForPid(pid, options.platform ?? process.platform));
  const currentUid = options.currentUid ?? process.getuid?.();
  const corruptLockStaleMs = options.corruptLockStaleMs ?? DEFAULT_CORRUPT_LOCK_STALE_MS;
  if (!Number.isFinite(corruptLockStaleMs) || corruptLockStaleMs < 0) {
    throw new Error('The corrupt lock stale interval is invalid.');
  }

  fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  const existing = readLockSnapshot(path.join(userDataPath, USER_DATA_INSTANCE_LOCK_FILE_NAME));
  if (existing?.record && isLockOwnerAlive(existing.record, isProcessAlive, processIdentityForPid, currentUid)) {
    throw new UserDataInstanceLockError('service-manager', existing.record.pid);
  }
  if (existing && !existing.record && now().getTime() - existing.modifiedAtMs < corruptLockStaleMs) {
    throw new UserDataInstanceLockError('service-manager');
  }
  assertNoLiveChromiumOwner(userDataPath, platform, pid, isProcessAlive);
}

function createLockFile(lockPath: string, record: LockRecord): boolean {
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, serializeLockRecord(record), 'utf8');
    fs.fsyncSync(descriptor);
    return true;
  } catch (error) {
    if (isErrno(error, 'EEXIST')) return false;
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original creation/write failure.
      }
      descriptor = undefined;
    }
    if (created) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // A partial fresh lock remains fail-closed and becomes reclaimable.
      }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sameSnapshot(left: LockSnapshot | undefined, right: LockSnapshot | undefined): boolean {
  return Boolean(left && right && left.identity === right.identity);
}

function removeStableStaleLock(lockPath: string, stale: LockSnapshot): boolean {
  const current = readLockSnapshot(lockPath);
  if (!sameSnapshot(stale, current)) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

class AcquiredUserDataInstanceLock implements UserDataInstanceLock {
  private released = false;

  constructor(
    readonly lockPath: string,
    readonly ownerToken: string,
    readonly pid: number,
  ) {}

  release(): boolean {
    if (this.released) return false;
    const owned = readLockSnapshot(this.lockPath);
    if (!owned?.record
      || owned.record.pid !== this.pid
      || owned.record.ownerToken !== this.ownerToken) {
      this.released = true;
      return false;
    }

    const current = readLockSnapshot(this.lockPath);
    if (!sameSnapshot(owned, current)
      || current?.record?.pid !== this.pid
      || current.record.ownerToken !== this.ownerToken) {
      this.released = true;
      return false;
    }

    try {
      fs.unlinkSync(this.lockPath);
      this.released = true;
      return true;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        this.released = true;
        return false;
      }
      throw error;
    }
  }
}

/**
 * Acquires the process-wide writer lease for one Electron userData directory.
 * The caller must first pass assertUserDataInstanceLockAvailable(), then own
 * Electron's ProcessSingleton lock so stale reclamation is serialized across
 * competing startups. Hold the returned handle until shutdown has completed.
 */
export function acquireUserDataInstanceLock(
  userDataPath: string,
  options: UserDataInstanceLockOptions = {},
): UserDataInstanceLock {
  const pid = normalizePid(options.pid ?? process.pid);
  if (!pid) throw new Error('The current process ID is invalid.');
  const now = options.now ?? (() => new Date());
  const createOwnerToken = options.createOwnerToken ?? randomUUID;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const processIdentityForPid = options.processIdentityForPid
    ?? ((pid: number) => defaultProcessIdentityForPid(pid, options.platform ?? process.platform));
  const currentUid = options.currentUid ?? process.getuid?.();
  const corruptLockStaleMs = options.corruptLockStaleMs ?? DEFAULT_CORRUPT_LOCK_STALE_MS;
  if (!Number.isFinite(corruptLockStaleMs) || corruptLockStaleMs < 0) {
    throw new Error('The corrupt lock stale interval is invalid.');
  }

  fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  const ownerToken = normalizeOwnerToken(createOwnerToken());
  if (!ownerToken) throw new Error('The user-data lock owner token is invalid.');
  const acquiredAt = now().toISOString();
  const lockPath = path.join(userDataPath, USER_DATA_INSTANCE_LOCK_FILE_NAME);
  const record: LockRecord = { schemaVersion: LOCK_SCHEMA_VERSION, pid, ownerToken, acquiredAt };

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    if (createLockFile(lockPath, record)) {
      return new AcquiredUserDataInstanceLock(lockPath, ownerToken, pid);
    }

    const existing = readLockSnapshot(lockPath);
    if (!existing) continue;
    if (existing.record) {
      if (isLockOwnerAlive(existing.record, isProcessAlive, processIdentityForPid, currentUid)) {
        throw new UserDataInstanceLockError('service-manager', existing.record.pid);
      }
    } else if (now().getTime() - existing.modifiedAtMs < corruptLockStaleMs) {
      // A newly created file can be observed between O_EXCL creation and its
      // first complete write. Only an old damaged file is safe to reclaim.
      throw new UserDataInstanceLockError('service-manager');
    }

    if (!removeStableStaleLock(lockPath, existing)) continue;
  }

  throw new UserDataInstanceLockError('service-manager');
}
