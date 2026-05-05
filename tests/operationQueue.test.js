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
