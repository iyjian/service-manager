const assert = require('node:assert/strict');
const test = require('node:test');

const { KeyedOperationQueue } = require('../dist/main/operationQueue');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('KeyedOperationQueue serializes jobs with the same key', async () => {
  const queue = new KeyedOperationQueue();
  const gate = deferred();
  const events = [];

  const first = queue.run('host-1:service-1', async () => {
    events.push('first:start');
    await gate.promise;
    events.push('first:end');
    return 'first';
  });
  await tick();

  const second = queue.run('host-1:service-1', async () => {
    events.push('second:start');
    return 'second';
  });
  await tick();

  assert.deepEqual(events, ['first:start']);

  gate.resolve();

  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
});

test('KeyedOperationQueue allows different keys to run concurrently', async () => {
  const queue = new KeyedOperationQueue();
  const gate = deferred();
  const events = [];

  const first = queue.run('host-1:service-1', async () => {
    events.push('first:start');
    await gate.promise;
    events.push('first:end');
    return 'first';
  });
  await tick();

  const second = queue.run('host-1:service-2', async () => {
    events.push('second:start');
    return 'second';
  });

  assert.equal(await second, 'second');
  assert.deepEqual(events, ['first:start', 'second:start']);

  gate.resolve();

  assert.equal(await first, 'first');
  assert.deepEqual(events, ['first:start', 'second:start', 'first:end']);
});

test('KeyedOperationQueue continues queued work after a failed job', async () => {
  const queue = new KeyedOperationQueue();
  const gate = deferred();
  const events = [];

  const first = queue.run('host-1:service-1', async () => {
    events.push('first:start');
    await gate.promise;
    events.push('first:fail');
    throw new Error('boom');
  });
  const firstFailure = assert.rejects(first, /boom/);
  await tick();

  const second = queue.run('host-1:service-1', async () => {
    events.push('second:start');
    return 'second';
  });
  await tick();

  assert.deepEqual(events, ['first:start']);

  gate.resolve();

  await firstFailure;
  assert.equal(await second, 'second');
  assert.deepEqual(events, ['first:start', 'first:fail', 'second:start']);
});

test('KeyedOperationQueue runMany acquires unique keys together and blocks single-key work until release', async () => {
  const queue = new KeyedOperationQueue();
  const existingGate = deferred();
  const batchGate = deferred();
  const events = [];

  const existing = queue.run('service-b', async () => {
    events.push('existing:start');
    await existingGate.promise;
    events.push('existing:end');
  });
  await tick();

  const batch = queue.runMany(['service-b', 'service-a', 'service-b'], async () => {
    events.push('batch:start');
    await batchGate.promise;
    events.push('batch:end');
    return 'batch';
  });
  await tick();

  const queuedOnA = queue.run('service-a', async () => {
    events.push('after-a:start');
  });
  await tick();
  assert.deepEqual(events, ['existing:start']);

  existingGate.resolve();
  await existing;
  await tick();
  assert.deepEqual(events, ['existing:start', 'existing:end', 'batch:start']);

  batchGate.resolve();
  assert.equal(await batch, 'batch');
  await queuedOnA;
  assert.deepEqual(events, ['existing:start', 'existing:end', 'batch:start', 'batch:end', 'after-a:start']);
});

test('KeyedOperationQueue runMany uses stable key ordering for overlapping batches', async () => {
  const queue = new KeyedOperationQueue();
  const firstGate = deferred();
  const events = [];

  const first = queue.runMany(['service-b', 'service-a'], async () => {
    events.push('first:start');
    await firstGate.promise;
    events.push('first:end');
  });
  await tick();

  const second = queue.runMany(['service-a', 'service-b'], async () => {
    events.push('second:start');
    return 'second';
  });
  await tick();
  assert.deepEqual(events, ['first:start']);

  firstGate.resolve();
  await first;
  assert.equal(await second, 'second');
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
});

test('KeyedOperationQueue runMany runs an empty-key task directly and releases keys after failure', async () => {
  const queue = new KeyedOperationQueue();

  assert.equal(await queue.runMany([], async () => 'empty'), 'empty');
  await assert.rejects(queue.runMany(['service-a', 'service-b'], async () => {
    throw new Error('batch failed');
  }), /batch failed/);

  assert.equal(await queue.run('service-a', async () => 'after failure'), 'after failure');
  assert.equal(await queue.run('service-b', async () => 'after failure'), 'after failure');
});
