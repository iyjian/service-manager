const test = require('node:test');
const assert = require('node:assert/strict');
const { notesServerHostOptions, notesServerDraftFromHost } = require('../dist/main/notesServer/hostSelection');
const host = { id: 'saved', name: 'Saved server', sshHost: 'server.example', sshPort: 2222, username: 'user', authType: 'privateKey', privateKeyId: 'vault-key', privateKey: 'secret-key', passphrase: 'secret-passphrase', password: 'secret-password', jumpHosts: [], forwards: [], services: [] };
test('Host selection exposes only connection labels, never authentication material', () => {
 const options = notesServerHostOptions([host]);
 assert.equal(options[0].id, 'saved');
 assert.equal(options[0].sshPort, 2222);
 assert.ok(!JSON.stringify(options).includes('secret'));
 assert.equal(options[0].privateKeyId, undefined);
});
test('selected Host authentication is resolved in the main process with its source reference', () => {
 const draft = notesServerDraftFromHost([host], 'saved');
 assert.equal(draft.sourceHostId, 'saved'); assert.equal(draft.privateKeyId, 'vault-key');
 assert.equal(draft.privateKey, host.privateKey); assert.equal(draft.passphrase, host.passphrase);
 assert.equal(draft.sshHost, host.sshHost); assert.equal(draft.sshPort, 2222);
 const password = notesServerDraftFromHost([{ ...host, authType: 'password' }], 'saved');
 assert.equal(password.password, host.password);
});
test('deleted Hosts and unsupported jump paths fail explicitly instead of connecting directly', () => {
 assert.throws(() => notesServerDraftFromHost([], 'saved'), /no longer exists/);
 assert.throws(() => notesServerDraftFromHost([host], {}), /Select a Host/);
 const jumped = { ...host, jumpHosts: [{ ...host }] };
 assert.match(notesServerHostOptions([jumped])[0].unavailableReason, /direct SSH/);
 assert.throws(() => notesServerDraftFromHost([jumped], 'saved'), /direct SSH/);
});

test('new Notes Host is persisted in the shared Host store and retries reuse it', async t => {
 const fs = require('node:fs/promises'); const path = require('node:path'); const os = require('node:os');
 const { ServiceStore } = require('../dist/main/ssh/store');
 const { PrivateKeyVault } = require('../dist/main/vault/privateKeyVault');
 const { NotesServerSettings } = require('../dist/main/notesServer/settings');
 const { createNotesServerHost } = require('../dist/main/notesServer/hostSelection');
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-host-'));
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 const protector = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value.split('').reverse().join('')), decryptString: bytes => bytes.toString().split('').reverse().join('') };
 const vault = new PrivateKeyVault(path.join(root, 'vault.json'), protector); await vault.load();
 const store = new ServiceStore(path.join(root, 'hosts.json')); await store.load(); await store.attachVault(vault);
 const draft = { name: 'Notes host', sshHost: 'server.example', sshPort: 22, username: 'user', authType: 'password', password: 'test-password' };
 const created = await createNotesServerHost(store, vault, draft);
 assert.equal(store.listHosts()[0].id, created.id); assert.deepEqual(created.services, []); assert.deepEqual(created.forwards, []);
 assert.equal((await createNotesServerHost(store, vault, draft)).id, created.id); assert.equal(store.listHosts().length, 1);
 const settings = new NotesServerSettings(path.join(root, 'notes.json'), protector, vault);
 await settings.save(notesServerDraftFromHost(store.listHosts(), created.id));
 const reopened = new ServiceStore(path.join(root, 'hosts.json')); await reopened.load(); await reopened.attachVault(vault);
 await settings.load();
 assert.equal(settings.view().sourceHostId, reopened.listHosts()[0].id);
 assert.equal(settings.endpoint().password, 'test-password'); assert.equal(settings.view().password, undefined);
});
