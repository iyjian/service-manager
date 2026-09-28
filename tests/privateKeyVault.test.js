const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const { PrivateKeyVault } = require('../dist/main/vault/privateKeyVault');
const { ServiceStore } = require('../dist/main/ssh/store');
const { NotesServerSettings } = require('../dist/main/notesServer/settings');
const { hostToEndpoint, jumpHostsToEndpoints, forwardToRuntimeConfig } = require('../dist/main/ssh/hostConnection');
const protector = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text.split('').reverse().join('')), decryptString: bytes => bytes.toString().split('').reverse().join('') };
const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
async function fixture(t) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-vault-'));
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 const vault = new PrivateKeyVault(path.join(root, 'vault.json'), protector); await vault.load();
 return { root, vault };
}
const host = () => ({ id: 'host', name: 'host', sshHost: 'example.org', sshPort: 22, username: 'user', authType: 'privateKey', privateKey: key, passphrase: undefined, jumpHosts: [{ sshHost: 'jump', sshPort: 22, username: 'user', authType: 'privateKey', privateKey: key }], services: [], forwards: [] });
test('migration deduplicates target, jump and file keys, keeps references on disk and survives restart', async t => {
 const { root, vault } = await fixture(t);
 const file = path.join(root, 'hosts.json'); const keyPath = path.join(root, 'key'); await fs.writeFile(keyPath, key);
 await fs.writeFile(file, JSON.stringify([host(), { ...host(), id: 'file', privateKey: undefined, privateKeyPath: keyPath }]));
 const store = new ServiceStore(file); await store.load(); await store.attachVault(vault);
 assert.equal(vault.list().length, 1); assert.equal(vault.list()[0].name, 'privateKey1');
 const raw = await fs.readFile(file, 'utf8'); assert.ok(!raw.includes('BEGIN RSA')); assert.ok(!raw.includes(keyPath));
 const disk = JSON.parse(raw); assert.equal(disk[0].privateKeyId, disk[0].jumpHosts[0].privateKeyId);
 assert.equal((await hostToEndpoint(store.listHosts()[0])).privateKey, key);
 assert.equal(jumpHostsToEndpoints(store.listHosts()[0])[0].privateKey, key);
 const runtime = await forwardToRuntimeConfig(store.listHosts()[0], { id: 'f', localHost: '127.0.0.1', localPort: 1234, remoteHost: 'localhost', remotePort: 80 }); assert.equal(runtime.privateKey, key); assert.equal(runtime.jumpHosts[0].privateKey, key);
 const restored = new PrivateKeyVault(path.join(root, 'vault.json'), protector); await restored.load();
 const reopened = new ServiceStore(file); await reopened.load(); await reopened.attachVault(restored);
 assert.equal(restored.list().length, 1); assert.equal(reopened.findHostById('host').privateKey, key);
 assert.ok(!(await fs.readFile(path.join(root, 'vault.json'), 'utf8')).includes('BEGIN RSA'));
 assert.deepEqual(Object.keys(restored.list()[0]).sort(), ['createdAt', 'id', 'name']);
});
test('failed secure storage leaves legacy host file untouched and migration can be retried', async t => {
 const { root } = await fixture(t); const file = path.join(root, 'hosts.json'); const original = JSON.stringify([host()]); await fs.writeFile(file, original);
 const broken = new PrivateKeyVault(path.join(root, 'vault.json'), { ...protector, isEncryptionAvailable: () => false });
 const store = new ServiceStore(file); await store.load(); await assert.rejects(store.attachVault(broken), /Secure credential/);
 assert.equal(await fs.readFile(file, 'utf8'), original);
 const good = new PrivateKeyVault(path.join(root, 'vault.json'), protector); await good.load(); await store.attachVault(good); assert.equal(good.list().length, 1);
});
test('new keys validate input and concurrent adds do not lose keys or duplicate migration names', async t => {
 const { vault } = await fixture(t);
 await assert.rejects(vault.add('bad', 'not a key'), /Invalid private key/);
 await Promise.all([vault.add('', key, undefined, true), vault.add('', key, undefined, true), vault.add('', key, 'legacy-passphrase', true)]);
 assert.deepEqual(vault.list().map(key => key.name), ['privateKey1', 'privateKey2']);
 assert.throws(() => vault.resolve({ privateKeyId: 'missing' }), /unavailable/);
});
test('Notes references a Vault key without persisting duplicate secrets or returning them to renderer', async t => {
 const { root, vault } = await fixture(t); const saved = await vault.add('shared', key);
 const settings = new NotesServerSettings(path.join(root, 'notes.json'), protector, vault);
 await settings.save({ name: 'notes', sshHost: 'host', sshPort: 22, username: 'user', authType: 'privateKey', privateKeyId: saved.id });
 assert.equal(settings.endpoint().privateKey, key); assert.equal(settings.view().privateKeyId, saved.id); assert.equal(settings.view().hasPrivateKey, true); assert.equal(settings.view().privateKey, undefined);
 const raw = JSON.parse(await fs.readFile(path.join(root, 'notes.json'), 'utf8'));
 assert.ok(!protector.decryptString(Buffer.from(raw.encrypted, 'base64')).includes('BEGIN RSA'));
 const restored = new NotesServerSettings(path.join(root, 'notes.json'), protector, vault); await restored.load(); assert.equal(restored.endpoint().privateKey, key);
});

test('encrypted sync restores device-local references without treating unchanged keys as host edits', async t => {
 const { vault, root } = await fixture(t);
 const store = new ServiceStore(path.join(root, 'hosts.json')); await store.load(); await store.upsertHost(host()); await store.attachVault(vault);
 const current = store.listHosts()[0];
 const shared = { ...current, privateKeyId: undefined };
 const restored = vault.reuseReference(shared);
 assert.equal(restored.privateKeyId, current.privateKeyId);
 assert.equal(restored.privateKey, current.privateKey);
 assert.equal(vault.reuseReference({ privateKey: 'changed' }).privateKeyId, undefined);
});

test('rename and replacement keep references stable across Host, Notes and restart', async t => {
 const { vault, root } = await fixture(t);
 const store = new ServiceStore(path.join(root, 'hosts.json')); await store.load(); await store.upsertHost(host()); await store.attachVault(vault);
 const saved = vault.list()[0]; const settings = new NotesServerSettings(path.join(root, 'notes.json'), protector, vault);
 await settings.save({ name: 'notes', sshHost: 'host', sshPort: 22, username: 'user', authType: 'privateKey', privateKeyId: saved.id });
 const renamed = await vault.rename(saved.id, 'Production deploy key', 0);
 assert.equal(renamed.id, saved.id); assert.equal(renamed.revision, 1); assert.equal(vault.resolve({ privateKeyId: saved.id }).privateKey, key);
 const replacement = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'new-passphrase' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
 const replaced = await vault.replace(saved.id, replacement, 'new-passphrase', 1);
 assert.equal(replaced.id, saved.id); assert.equal(replaced.name, renamed.name); assert.equal(replaced.createdAt, saved.createdAt); assert.equal(replaced.revision, 2);
 assert.equal(store.listHosts()[0].privateKey, replacement); assert.equal(store.listHosts()[0].jumpHosts[0].passphrase, 'new-passphrase');
 assert.equal(settings.endpoint().privateKey, replacement); assert.equal(settings.endpoint().passphrase, 'new-passphrase');
 const restored = new PrivateKeyVault(path.join(root, 'vault.json'), protector); await restored.load();
 assert.equal(restored.resolve({ privateKeyId: saved.id }).privateKey, replacement);
 assert.equal(restored.list()[0].name, renamed.name); assert.equal(restored.list().length, 1);
 assert.ok(!JSON.stringify(restored.list()).includes('passphrase')); assert.ok(!JSON.stringify(restored.list()).includes('PRIVATE KEY'));
});
test('invalid, stale and failed updates leave the original key and passphrase intact', async t => {
 const { vault, root } = await fixture(t); const saved = await vault.add('original', key);
 await assert.rejects(vault.rename(saved.id, ' ', 0), /name is required/);
 await assert.rejects(vault.replace(saved.id, 'not-a-key', undefined, 0), /Invalid private key/);
 const encrypted = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'correct' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
 await assert.rejects(vault.replace(saved.id, encrypted, 'wrong', 0), /Invalid private key/);
 const results = await Promise.allSettled([vault.rename(saved.id, 'first', 0), vault.rename(saved.id, 'second', 0)]);
 assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(vault.list()[0].name, 'first');
 await assert.rejects(vault.replace(saved.id, key, undefined, 0), /another window/);
 const broken = new PrivateKeyVault(path.join(root, 'vault.json'), { ...protector, encryptString() { throw new Error('secure storage failed'); } }); await broken.load();
 await assert.rejects(broken.rename(saved.id, 'lost', 1), /secure storage failed/);
 assert.equal(broken.list()[0].name, 'first'); assert.equal(broken.resolve({ privateKeyId: saved.id }).privateKey, key);
 const disk = new PrivateKeyVault(path.join(root, 'vault.json'), protector); await disk.load(); assert.equal(disk.list()[0].name, 'first');
});
