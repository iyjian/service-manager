const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AppQuitCleanupTimeoutError,
  AppQuitCoordinator,
  DEFAULT_APP_QUIT_CLEANUP_TIMEOUT_MS,
} = require('../dist/main/quitCoordinator.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function fakeTimer() {
  const scheduled = [];
  const timer = {
    setTimeout(callback, delayMs) {
      const handle = { callback, delayMs, cleared: false, fired: false };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      handle.cleared = true;
    },
  };

  return {
    timer,
    scheduled,
    fire(handle = scheduled.find((candidate) => !candidate.cleared && !candidate.fired)) {
      assert.ok(handle, 'expected a pending timer');
      handle.fired = true;
      handle.callback();
    },
  };
}

function createCoordinator(cleanup) {
  const events = [];
  const coordinator = new AppQuitCoordinator({
    abortAutoStart: () => events.push('abort'),
    cleanup: async () => {
      events.push('cleanup:start');
      await cleanup.promise;
      events.push('cleanup:end');
    },
    reportCleanupError: async (error) => events.push(`error:${error.message}`),
    quit: () => events.push('quit'),
    installUpdate: () => events.push('install'),
    exit: () => events.push('exit'),
  });
  return { coordinator, events };
}

test('AppQuitCoordinator starts an update installer only after runtime cleanup', async () => {
  const cleanup = deferred();
  const { coordinator, events } = createCoordinator(cleanup);

  const request = coordinator.request('install-update');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['abort', 'cleanup:start']);
  assert.equal(coordinator.canQuitImmediately(), false);

  cleanup.resolve();
  await request;
  assert.deepEqual(events, ['abort', 'cleanup:start', 'cleanup:end', 'install']);
  assert.equal(coordinator.canQuitImmediately(), true);
});

test('AppQuitCoordinator upgrades an in-flight normal quit to update without duplicate cleanup', async () => {
  const cleanup = deferred();
  const { coordinator, events } = createCoordinator(cleanup);

  const normal = coordinator.request('normal');
  const update = coordinator.request('install-update');
  cleanup.resolve();
  await Promise.all([normal, update]);

  assert.deepEqual(events, ['abort', 'cleanup:start', 'cleanup:end', 'install']);
});

test('AppQuitCoordinator gives a terminal signal authority over other in-flight intents', async () => {
  const cleanup = deferred();
  const { coordinator, events } = createCoordinator(cleanup);

  const update = coordinator.request('install-update');
  const signal = coordinator.request('signal');
  cleanup.resolve();
  await Promise.all([update, signal]);

  assert.deepEqual(events, ['abort', 'cleanup:start', 'cleanup:end', 'exit']);
});

test('AppQuitCoordinator reports cleanup failure but still performs one final action', async () => {
  const events = [];
  const coordinator = new AppQuitCoordinator({
    abortAutoStart: () => events.push('abort'),
    cleanup: async () => { throw new Error('cleanup failed'); },
    reportCleanupError: async (error) => events.push(`error:${error.message}`),
    quit: () => events.push('quit'),
    installUpdate: () => events.push('install'),
    exit: () => events.push('exit'),
  });

  await Promise.all([coordinator.request('normal'), coordinator.request('normal')]);
  assert.deepEqual(events, ['abort', 'error:cleanup failed', 'quit']);
  assert.equal(coordinator.canQuitImmediately(), true);
});

test('AppQuitCoordinator bounds never-resolving cleanup and reports the default deadline before exiting once', async () => {
  const cleanup = deferred();
  const clock = fakeTimer();
  const events = [];
  const errors = [];
  const coordinator = new AppQuitCoordinator({
    abortAutoStart: () => events.push('abort'),
    cleanup: async () => {
      events.push('cleanup:start');
      await cleanup.promise;
    },
    reportCleanupError: (error) => {
      errors.push(error);
      events.push('error');
      return new Promise(() => undefined);
    },
    quit: () => events.push('quit'),
    installUpdate: () => events.push('install'),
    exit: () => events.push('exit'),
    timer: clock.timer,
  });

  const normal = coordinator.request('normal');
  const update = coordinator.request('install-update');
  const signal = coordinator.request('signal');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(clock.scheduled.length, 1);
  assert.equal(clock.scheduled[0].delayMs, DEFAULT_APP_QUIT_CLEANUP_TIMEOUT_MS);
  assert.deepEqual(events, ['abort', 'cleanup:start']);

  clock.fire();
  await Promise.all([normal, update, signal]);

  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof AppQuitCleanupTimeoutError);
  assert.equal(errors[0].timeoutMs, DEFAULT_APP_QUIT_CLEANUP_TIMEOUT_MS);
  assert.deepEqual(events, ['abort', 'cleanup:start', 'error', 'exit']);
  assert.equal(clock.scheduled[0].cleared, true);
  assert.equal(coordinator.canQuitImmediately(), true);

  await coordinator.request('normal');
  assert.deepEqual(events, ['abort', 'cleanup:start', 'error', 'exit']);
});

test('AppQuitCoordinator consumes a cleanup rejection that arrives after the deadline', async () => {
  const cleanup = deferred();
  const clock = fakeTimer();
  const unhandled = [];
  const onUnhandledRejection = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const events = [];
    const timedCoordinator = new AppQuitCoordinator({
      abortAutoStart: () => events.push('abort'),
      cleanup: async () => {
        events.push('cleanup:start');
        await cleanup.promise;
        events.push('cleanup:end');
      },
      reportCleanupError: async (error) => events.push(`error:${error.message}`),
      quit: () => events.push('quit'),
      installUpdate: () => events.push('install'),
      exit: () => events.push('exit'),
      cleanupTimeoutMs: 25,
      timer: clock.timer,
    });

    const request = timedCoordinator.request('normal');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clock.scheduled[0].delayMs, 25);

    clock.fire();
    await request;
    cleanup.reject(new Error('late cleanup failure'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
    assert.deepEqual(events, [
      'abort',
      'cleanup:start',
      'error:Application runtime cleanup exceeded 25 ms',
      'quit',
    ]);
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
});
