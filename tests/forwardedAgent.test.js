const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { AgentProtocol, Server, utils } = require('ssh2');
const { ForwardedKeyAgent, createForwardedAgent } = require('../dist/main/ssh/forwardedAgent');
const { SshTerminalRuntime, sshConnectionFingerprint } = require('../dist/main/ssh/sshTerminalRuntime');
const { validateHostDraft } = require('../dist/main/ssh/validation');
const { ServiceStore } = require('../dist/main/ssh/store');
const key = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const firstKey = key(), targetKey = key();
const host = (extra = {}) => ({ id: 'host', name: 'test', sshHost: '127.0.0.1', sshPort: 22, username: 'test',
  authType: 'privateKey', privateKey: targetKey, jumpHosts: [], forwards: [], services: [], ...extra });
const identities = (agent) => new Promise((resolve, reject) => agent.getIdentities((e, keys) => e ? reject(e) : resolve(keys)));
const sign = (agent, key, data, options = {}) => new Promise((resolve, reject) => agent.sign(key, data, options, (e, signature) => e ? reject(e) : resolve(signature)));
const stream = (agent) => new Promise((resolve, reject) => agent.getStream((e, stream) => e ? reject(e) : resolve(stream)));

test('default key selection uses first hop only, respects disabled/password settings and reads direct key files', async (t) => {
  for (const [config, expected] of [[host(), targetKey], [host({ jumpHosts: [host({ privateKey: firstKey }), host()] }), firstKey]]) {
    const agent = await createForwardedAgent(config); t.after(() => agent.dispose());
    const keys = await identities(agent); assert.equal(keys.length, 1); assert.ok(keys[0].getPublicSSH().equals(utils.parseKey(expected).getPublicSSH()));
  }
  assert.equal(await createForwardedAgent(host({ forwardAgent: false })), undefined);
  assert.equal(await createForwardedAgent(host({ jumpHosts: [host({ authType: 'password', password: 'test' })] })), undefined);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sm-agent-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'key'); await writeFile(file, firstKey);
  const agent = await createForwardedAgent(host({ privateKey: undefined, privateKeyPath: file })); t.after(() => agent.dispose());
  assert.ok((await identities(agent))[0].getPublicSSH().equals(utils.parseKey(firstKey).getPublicSSH()));
});

test('agent protocol returns only public identities and produces verifiable RSA SHA-2 signatures', async (t) => {
  const agent = new ForwardedKeyAgent(firstKey); t.after(() => agent.dispose());
  const server = await stream(agent), client = new AgentProtocol(true);
  t.after(() => client.destroy()); client.pipe(server).pipe(client);
  const [publicKey] = await identities(client);
  assert.equal(publicKey.isPrivateKey(), false);
  const data = Buffer.from('agent forwarding verification');
  for (const hash of ['sha256', 'sha512']) {
    const signature = await sign(client, publicKey, data, { hash });
    assert.equal(utils.parseKey(firstKey).verify(data, signature, hash), true);
  }
  await assert.rejects(sign(client, utils.parseKey(targetKey), data), /fail/i);
  agent.dispose(); await assert.rejects(identities(agent)); await assert.rejects(stream(agent));
  assert.equal(server.destroyed, true);
});

test('OpenSSH session-bind extension cannot corrupt subsequent identity/sign requests', async (t) => {
  for (const fragmented of [false, true]) {
    const agent = new ForwardedKeyAgent(firstKey); t.after(() => agent.dispose());
    const server = await stream(agent);
    const extensionName = Buffer.from('session-bind@openssh.com');
    const body = Buffer.concat([Buffer.from([27, 0, 0, 0, extensionName.length]), extensionName, Buffer.alloc(128, 42)]);
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
    const request = Buffer.concat([header, body]);
    const failure = once(server, 'data');
    if (fragmented) {
      for (const byte of request) server.write(Buffer.from([byte]));
    } else server.write(request);
    assert.deepEqual((await failure)[0], Buffer.from([0, 0, 0, 1, 5]));
    const client = new AgentProtocol(true); t.after(() => client.destroy());
    client.pipe(server).pipe(client);
    const [publicKey] = await identities(client);
    const data = Buffer.from('authentication after session-bind');
    const signature = await sign(client, publicKey, data, { hash: 'sha256' });
    assert.equal(utils.parseKey(firstKey).verify(data, signature, 'sha256'), true);
  }
});

test('encrypted keys are unlocked in memory; invalid passphrases have sanitized errors', async (t) => {
  const encrypted = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'test-secret' });
  assert.throws(() => new ForwardedKeyAgent(encrypted, 'wrong'), /^Error: Could not unlock the SSH agent forwarding key\.$/);
  const agent = new ForwardedKeyAgent(encrypted, 'test-secret'); t.after(() => agent.dispose());
  assert.equal((await identities(agent)).length, 1);
});

test('oversized packets, too many channels, and excessive signing requests are bounded', async (t) => {
  const agent = new ForwardedKeyAgent(firstKey); t.after(() => agent.dispose());
  const connection = await stream(agent); const failure = once(connection, 'error');
  connection.write(Buffer.from([0x7f, 0xff])); connection.write(Buffer.from([0xff, 0xff]));
  await failure; assert.equal(connection.destroyed, true);
  const channels = await Promise.all(Array.from({ length: 16 }, () => stream(agent)));
  await assert.rejects(stream(agent)); channels[0].destroy(); assert.ok(await stream(agent));
  await assert.rejects(sign(agent, utils.parseKey(firstKey), Buffer.alloc(65537)));
  for (let i = 0; i < 70; i++) { try { await identities(agent); } catch { return; } }
  assert.fail('Agent request rate must be bounded');
});

test('host settings default on, reject invalid values, persist false, and change terminal fingerprint', async (t) => {
  assert.equal(validateHostDraft(host()).forwardAgent, true);
  assert.equal(validateHostDraft(host({ forwardAgent: false })).forwardAgent, false);
  assert.throws(() => validateHostDraft(host({ forwardAgent: 'false' })), /Invalid/);
  assert.notEqual(sshConnectionFingerprint(host()), sshConnectionFingerprint(host({ forwardAgent: false })));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sm-agent-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hosts.json'); await writeFile(file, JSON.stringify([host(), host({ id: 'disabled', forwardAgent: false })]));
  const store = new ServiceStore(file); await store.load();
  assert.equal(store.findHostById('host').forwardAgent, true); assert.equal(store.findHostById('disabled').forwardAgent, false);
});

test('real ssh2 terminal connections request forwarding only on the target, through a jump or directly', { timeout: 15000 }, async (t) => {
  const clients = new Set(); const requests = [];
  async function server(label) {
    const instance = new Server({ hostKeys: [firstKey] }, (client) => {
      clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
      client.on('authentication', (ctx) => ctx.accept());
      client.on('ready', () => {
        client.on('tcpip', (accept, reject, info) => {
          const socket = net.connect(info.destPort, info.destIP);
          socket.on('error', () => reject());
          socket.on('connect', () => { const channel = accept(); channel.pipe(socket).pipe(channel); channel.on('close', () => socket.destroy()); });
        });
        client.on('session', (accept) => {
          const session = accept(); session.on('pty', (accept) => accept());
          session.on('auth-agent', (accept) => { requests.push(label); accept?.(); });
          session.on('shell', (accept) => { const channel = accept(); channel.write('ready'); });
        });
      });
    });
    instance.listen(0, '127.0.0.1'); await once(instance, 'listening'); return instance;
  }
  const jump = await server('jump'), target = await server('target');
  t.after(() => { for (const client of clients) client.end(); jump.close(); target.close(); });
  for (const config of [host(), host({ jumpHosts: [host({ privateKey: firstKey, sshPort: jump.address().port })] }), host({ forwardAgent: false })]) {
    config.sshPort = target.address().port;
    let done;
    const opened = new Promise((resolve, reject) => { done = (state) => state.state === 'open' ? resolve() : state.state === 'error' ? reject(new Error(state.error)) : undefined; });
    const runtime = new SshTerminalRuntime({ getHost: () => config, state: (_owner, state) => done(state), output() {} });
    t.after(() => runtime.shutdown()); runtime.open(1, 'host', 'terminal'); await opened; runtime.shutdown();
  }
  assert.deepEqual(requests, ['target', 'target']);
});

test('Ed25519 and ECDSA keys produce interoperable SSH agent signatures', async (t) => {
  const { verify } = require('node:crypto');
  for (const [type, bits] of [['ed25519', undefined], ['ecdsa', 256], ['ecdsa', 384], ['ecdsa', 521]]) {
    const generated = utils.generateKeyPairSync(type, bits ? { bits } : {});
    const agent = new ForwardedKeyAgent(generated.private); t.after(() => agent.dispose());
    const server = await stream(agent), client = new AgentProtocol(true); t.after(() => client.destroy());
    client.pipe(server).pipe(client);
    const [publicKey] = await identities(client), data = Buffer.from('verify forwarded key');
    const signature = await sign(client, publicKey, data);
    if (type === 'ed25519') assert.equal(publicKey.verify(data, signature), true);
    else {
      const size = Math.ceil(bits / 8), parts = []; let offset = 0;
      for (let i = 0; i < 2; i++) {
        const length = signature.readUInt32BE(offset); offset += 4;
        const integer = signature.subarray(offset, offset + length); offset += length;
        const padded = Buffer.alloc(size); integer.copy(padded, Math.max(0, size - length), Math.max(0, length - size)); parts.push(padded);
      }
      assert.equal(offset, signature.length);
      assert.equal(verify(bits === 256 ? 'sha256' : bits === 384 ? 'sha384' : 'sha512', data,
        { key: publicKey.getPublicPEM(), dsaEncoding: 'ieee-p1363' }, Buffer.concat(parts)), true);
    }
  }
});
