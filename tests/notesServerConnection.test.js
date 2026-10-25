const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { NotesServerConnection } = require('../dist/main/notesServer/connection');
const { RemoteNotesBackend } = require('../dist/main/notesServer/backend');

function fixture(methods = {}) {
  const client = Object.assign(new EventEmitter(), { destroy() { this.emit('close'); }, ...methods });
  const controller = new AbortController();
  return { client, controller, connection: new NotesServerConnection(client, controller.signal) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('cancellation settles SFTP even when SSH never calls back', async () => {
  const f = fixture({ sftp() {} });
  const pending = f.connection.read('/config');
  const rejected = assert.rejects(pending, /cancelled/);
  await tick(); f.controller.abort(); await rejected;
  assert.equal(f.connection.usable, false);
  assert.equal(f.client.listenerCount('error'), 0);
});

test('SFTP channel timeout settles and closes a silent connection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ sftp() {} });
  const pending = f.connection.sftp();
  const rejected = assert.rejects(pending, /timed out/);
  await Promise.resolve(); t.mock.timers.tick(15_000); await rejected;
  assert.equal(f.connection.usable, false);
});

test('premature file stream close rejects rather than waiting for end', async () => {
  const stream = new PassThrough();
  let ended = false;
  const f = fixture({ sftp(callback) { callback(null, { createReadStream: () => stream, end() { ended = true; } }); } });
  const rejected = assert.rejects(f.connection.read('/config'), /closed before completion/);
  await tick(); stream.destroy(); await rejected;
  assert.equal(ended, true);
});

test('SSH disconnect settles an exec whose callback never arrives', async () => {
  const f = fixture({ exec() {} });
  const rejected = assert.rejects(f.connection.exec('true'), /connection closed/);
  await tick(); f.client.emit('close'); await rejected;
});

test('successful read still returns complete data and cleans listeners', async () => {
  const stream = new PassThrough();
  const f = fixture({ sftp(callback) { callback(null, { createReadStream: () => stream, end() {} }); } });
  const pending = f.connection.read('/config');
  await tick(); stream.end('config');
  assert.equal((await pending).toString(), 'config');
  assert.equal(f.client.listenerCount('error'), 0);
});

test('idle timeout does not bypass or discard a pending queue operation', async () => {
  const backend = new RemoteNotesBackend({ settings: {} }, '/unused', () => {});
  let release; let completed = false;
  const operation = backend.run(() => new Promise(resolve => { release = () => { completed = true; resolve(); }; }));
  await tick();
  await assert.rejects(backend.idle(5), /still finishing/);
  assert.equal(completed, false);
  release(); await operation; await backend.idle();
  assert.equal(completed, true);
});

test('API cancellation settles even when forwarding never calls back', async () => {
  const f = fixture({ forwardOut() {} });
  const rejected = assert.rejects(f.connection.api(47831, 'test', '/v1/health'), /cancelled/);
  await tick(); f.controller.abort(); await rejected;
});

test('upload cannot report success when closed before finish', async () => {
  const { Writable } = require('node:stream');
  const stream = new Writable({ write(_chunk, _encoding, _callback) {} });
  const f = fixture({ sftp(callback) { callback(null, { createWriteStream: () => stream, end() {} }); } });
  const rejected = assert.rejects(f.connection.write('/upload', Buffer.from('payload')), /closed before completion/);
  await tick(); stream.destroy(); await rejected;
});
