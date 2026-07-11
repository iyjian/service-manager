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
