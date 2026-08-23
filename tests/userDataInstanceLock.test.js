const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CHROMIUM_SINGLETON_LOCK_FILE_NAME,
  USER_DATA_INSTANCE_LOCK_FILE_NAME,
  UserDataInstanceLockError,
  acquireUserDataInstanceLock,
  assertUserDataInstanceLockAvailable,
} = require('../dist/main/core/userDataInstanceLock');

const NOW = new Date('2026-07-20T00:00:00.000Z');

async function temporaryUserData(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'service-manager-instance-lock-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

function lockPath(directory) {
  return path.join(directory, USER_DATA_INSTANCE_LOCK_FILE_NAME);
}

function lockRecord(pid, ownerToken, acquiredAt = NOW.toISOString()) {
  return { schemaVersion: 1, pid, ownerToken, acquiredAt };
}

function writeLock(directory, record) {
  fs.writeFileSync(lockPath(directory), `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
}

test('acquires an atomic owner-token lock, rejects a live owner, and releases its own file', async (t) => {
  const directory = await temporaryUserData(t);
  const alive = new Set([111, 222]);
  const first = acquireUserDataInstanceLock(directory, {
    pid: 111,
    platform: 'win32',
    now: () => NOW,
    createOwnerToken: () => 'owner_token_111',
    isProcessAlive: (pid) => alive.has(pid),
  });

  const persisted = JSON.parse(fs.readFileSync(first.lockPath, 'utf8'));
  assert.deepEqual(persisted, lockRecord(111, 'owner_token_111'));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(first.lockPath).mode & 0o777, 0o600);
  }

  assert.throws(
    () => assertUserDataInstanceLockAvailable(directory, {
      pid: 222,
      platform: 'win32',
      now: () => NOW,
      isProcessAlive: (pid) => alive.has(pid),
    }),
    (error) => error instanceof UserDataInstanceLockError
      && error.code === 'USER_DATA_ALREADY_IN_USE'
      && error.source === 'service-manager'
      && error.ownerPid === 111,
  );

  assert.equal(first.release(), true);
  assert.equal(fs.existsSync(first.lockPath), false);
  assert.equal(first.release(), false);
});

test('reclaims a stable lock whose recorded PID is dead', async (t) => {
  const directory = await temporaryUserData(t);
  writeLock(directory, lockRecord(111, 'dead_owner_token'));

  assert.doesNotThrow(() => assertUserDataInstanceLockAvailable(directory, {
    pid: 222,
    platform: 'win32',
    now: () => NOW,
    isProcessAlive: (pid) => pid === 222,
  }));
  assert.equal(JSON.parse(fs.readFileSync(lockPath(directory), 'utf8')).ownerToken, 'dead_owner_token');

  const acquired = acquireUserDataInstanceLock(directory, {
    pid: 222,
    platform: 'win32',
    now: () => NOW,
    createOwnerToken: () => 'replacement_token',
    isProcessAlive: (pid) => pid === 222,
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(acquired.lockPath, 'utf8')), lockRecord(222, 'replacement_token'));
  assert.equal(acquired.release(), true);
});

test('keeps a recent damaged lock but reclaims it after the stale interval', async (t) => {
  const directory = await temporaryUserData(t);
  fs.writeFileSync(lockPath(directory), '{incomplete', { flag: 'wx', mode: 0o600 });
  const freshMs = NOW.getTime() - 5_000;
  fs.utimesSync(lockPath(directory), freshMs / 1_000, freshMs / 1_000);

  const options = {
    pid: 222,
    platform: 'win32',
    now: () => NOW,
    createOwnerToken: () => 'replacement_token',
    isProcessAlive: () => false,
    corruptLockStaleMs: 30_000,
  };
  assert.throws(
    () => acquireUserDataInstanceLock(directory, options),
    (error) => error instanceof UserDataInstanceLockError && error.ownerPid === undefined,
  );
  assert.equal(fs.readFileSync(lockPath(directory), 'utf8'), '{incomplete');

  const staleMs = NOW.getTime() - 31_000;
  fs.utimesSync(lockPath(directory), staleMs / 1_000, staleMs / 1_000);
  const acquired = acquireUserDataInstanceLock(directory, options);
  assert.equal(JSON.parse(fs.readFileSync(acquired.lockPath, 'utf8')).ownerToken, 'replacement_token');
  assert.equal(acquired.release(), true);
});

test('does not remove a new live lock that replaces the stale file during inspection', async (t) => {
  const directory = await temporaryUserData(t);
  writeLock(directory, lockRecord(111, 'dead_owner_token'));
  let replaced = false;

  assert.throws(
    () => acquireUserDataInstanceLock(directory, {
      pid: 333,
      platform: 'win32',
      now: () => NOW,
      createOwnerToken: () => 'contender_token',
      isProcessAlive: (pid) => {
        if (pid === 111 && !replaced) {
          replaced = true;
          fs.unlinkSync(lockPath(directory));
          writeLock(directory, lockRecord(222, 'new_live_owner'));
          return false;
        }
        return pid === 222 || pid === 333;
      },
    }),
    (error) => error instanceof UserDataInstanceLockError && error.ownerPid === 222,
  );

  assert.deepEqual(
    JSON.parse(fs.readFileSync(lockPath(directory), 'utf8')),
    lockRecord(222, 'new_live_owner'),
  );
});

test('release leaves a replacement lock owned by another token untouched', async (t) => {
  const directory = await temporaryUserData(t);
  const acquired = acquireUserDataInstanceLock(directory, {
    pid: 111,
    platform: 'win32',
    now: () => NOW,
    createOwnerToken: () => 'original_owner',
    isProcessAlive: () => true,
  });
  fs.unlinkSync(acquired.lockPath);
  writeLock(directory, lockRecord(222, 'replacement_owner'));

  assert.equal(acquired.release(), false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(acquired.lockPath, 'utf8')),
    lockRecord(222, 'replacement_owner'),
  );
});

test('macOS and Linux reject a live foreign Chromium SingletonLock without leaving an app lock', async (t) => {
  for (const platform of ['darwin', 'linux']) {
    const directory = await temporaryUserData(t);
    fs.symlinkSync(`test-host.local-4321`, path.join(directory, CHROMIUM_SINGLETON_LOCK_FILE_NAME));

    assert.throws(
      () => assertUserDataInstanceLockAvailable(directory, {
        pid: 1234,
        platform,
        now: () => NOW,
        isProcessAlive: (pid) => pid === 4321,
      }),
      (error) => error instanceof UserDataInstanceLockError
        && error.source === 'chromium'
        && error.ownerPid === 4321,
    );
    assert.equal(fs.existsSync(lockPath(directory)), false);
  }
});

test('ignores a dead, malformed, or current-process Chromium SingletonLock', async (t) => {
  for (const [target, isAlive] of [
    ['test-host.local-4321', () => false],
    ['malformed-target', () => true],
    ['test-host.local-1234', () => true],
  ]) {
    const directory = await temporaryUserData(t);
    fs.symlinkSync(target, path.join(directory, CHROMIUM_SINGLETON_LOCK_FILE_NAME));
    assert.doesNotThrow(() => assertUserDataInstanceLockAvailable(directory, {
      pid: 1234,
      platform: 'darwin',
      now: () => NOW,
      isProcessAlive: isAlive,
    }));
    const acquired = acquireUserDataInstanceLock(directory, {
      pid: 1234,
      platform: 'darwin',
      now: () => NOW,
      createOwnerToken: () => `owner_${target.replace(/[^A-Za-z0-9]/g, '_')}`,
      isProcessAlive: isAlive,
    });
    assert.equal(acquired.release(), true);
  }
});

test('reclaims a lock whose PID was reused by a process started after lock creation', async (t) => {
  const directory = await temporaryUserData(t);
  writeLock(directory, lockRecord(518, 'reused_pid_owner'));

  const options = {
    pid: 222,
    platform: 'darwin',
    now: () => NOW,
    createOwnerToken: () => 'replacement_token',
    isProcessAlive: () => true,
    currentUid: 501,
    processIdentityForPid: (pid) => (pid === 518
      ? { startTimeMs: Date.parse(NOW.toISOString()) + 60_000, uid: 501 }
      : undefined),
  };

  assert.doesNotThrow(() => assertUserDataInstanceLockAvailable(directory, options));
  const acquired = acquireUserDataInstanceLock(directory, options);
  assert.equal(JSON.parse(fs.readFileSync(acquired.lockPath, 'utf8')).ownerToken, 'replacement_token');
  assert.equal(acquired.release(), true);
});

test('reclaims a lock whose PID now belongs to a different user', async (t) => {
  const directory = await temporaryUserData(t);
  writeLock(directory, lockRecord(518, 'system_daemon_pid'));

  const options = {
    pid: 222,
    platform: 'darwin',
    now: () => NOW,
    createOwnerToken: () => 'replacement_token',
    isProcessAlive: () => true,
    currentUid: 501,
    processIdentityForPid: () => ({ uid: 0 }),
  };

  assert.doesNotThrow(() => assertUserDataInstanceLockAvailable(directory, options));
  const acquired = acquireUserDataInstanceLock(directory, options);
  assert.equal(JSON.parse(fs.readFileSync(acquired.lockPath, 'utf8')).ownerToken, 'replacement_token');
  assert.equal(acquired.release(), true);
});

test('keeps a live lock whose PID identity matches the recorded owner', async (t) => {
  const directory = await temporaryUserData(t);
  writeLock(directory, lockRecord(111, 'live_owner_token'));

  const options = {
    pid: 222,
    platform: 'darwin',
    now: () => NOW,
    createOwnerToken: () => 'contender_token',
    isProcessAlive: () => true,
    currentUid: 501,
    processIdentityForPid: (pid) => (pid === 111
      ? { startTimeMs: Date.parse(NOW.toISOString()) - 60_000, uid: 501 }
      : undefined),
  };

  assert.throws(
    () => acquireUserDataInstanceLock(directory, options),
    (error) => error instanceof UserDataInstanceLockError && error.ownerPid === 111,
  );
  assert.equal(JSON.parse(fs.readFileSync(lockPath(directory), 'utf8')).ownerToken, 'live_owner_token');
});

test('fails closed when a live PID identity cannot be determined', async (t) => {
  const directory = await temporaryUserData(t);
  writeLock(directory, lockRecord(111, 'unverifiable_owner'));

  assert.throws(
    () => acquireUserDataInstanceLock(directory, {
      pid: 222,
      platform: 'darwin',
      now: () => NOW,
      createOwnerToken: () => 'contender_token',
      isProcessAlive: () => true,
      currentUid: 501,
      processIdentityForPid: () => undefined,
    }),
    (error) => error instanceof UserDataInstanceLockError && error.ownerPid === 111,
  );
});
