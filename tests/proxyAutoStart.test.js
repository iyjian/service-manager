const assert = require('node:assert/strict');
const test = require('node:test');

let proxyAutoStart = {};
try {
  proxyAutoStart = require('../dist/main/proxy/proxyAutoStart.js');
} catch {
  // RED: the scheduler module does not exist yet.
}

test('scheduleProxyAutoStart starts restoration without awaiting completion', () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });

  const result = proxyAutoStart.scheduleProxyAutoStart(
    {
      restoreRunningIntent: () => {
        calls += 1;
        return pending;
      },
    },
    () => assert.fail('unexpected auto-start error')
  );

  assert.equal(result, undefined);
  assert.equal(calls, 1);
  release();
});

test('scheduleProxyAutoStart reports asynchronous restoration failure', async () => {
  const expected = new Error('injected auto-start failure');
  let reported;

  proxyAutoStart.scheduleProxyAutoStart(
    {
      restoreRunningIntent: async () => {
        throw expected;
      },
    },
    (error) => {
      reported = error;
    }
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reported, expected);
});

test('restoreWithPortConflictRetry retries only transient Mixed Port conflicts', async () => {
  let recoveredAttempts = 0;
  const recovered = await proxyAutoStart.restoreWithPortConflictRetry(
    {
      restoreRunningIntent: async () => {
        recoveredAttempts += 1;
        if (recoveredAttempts < 3) {
          throw new Error('Mixed port 7890 is already in use. Stop the process using it or choose another port.');
        }
        return 'running';
      },
    },
    async () => undefined
  );

  assert.equal(recovered, 'running');
  assert.equal(recoveredAttempts, 3);
});

test('restoreWithPortConflictRetry retains a persistent conflict and does not retry other failures', async () => {
  let conflictAttempts = 0;
  await assert.rejects(
    proxyAutoStart.restoreWithPortConflictRetry(
      {
        restoreRunningIntent: async () => {
          conflictAttempts += 1;
          throw new Error('Mixed port 7890 is already in use. Stop the process using it or choose another port.');
        },
      },
      async () => undefined
    ),
    /Mixed port 7890 is already in use/
  );
  assert.equal(conflictAttempts, 4);

  let otherAttempts = 0;
  await assert.rejects(
    proxyAutoStart.restoreWithPortConflictRetry(
      {
        restoreRunningIntent: async () => {
          otherAttempts += 1;
          throw new Error('mihomo core is not installed. Download it first.');
        },
      },
      async () => undefined
    ),
    /core is not installed/
  );
  assert.equal(otherAttempts, 1);
});

test('restoreWithPortConflictRetry does not queue another restore after shutdown aborts its delay', async () => {
  const controller = new AbortController();
  let attempts = 0;

  const result = await proxyAutoStart.restoreWithPortConflictRetry(
    {
      restoreRunningIntent: async () => {
        attempts += 1;
        throw new Error('Mixed port 7890 is already in use. Stop the process using it or choose another port.');
      },
    },
    async () => {
      controller.abort();
    },
    controller.signal
  );

  assert.equal(result, undefined);
  assert.equal(attempts, 1);
});
