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

test('login fields and notes persist encrypted without exposing passwords', async t => {
 const { vault, root } = await fixture(t);
 const draft = { type: 'login', loginUrl: 'https://github.com/login', accounts: [{ username: 'alice', password: 'sensitive-password', notes: 'Use work account' }] };
 const saved = await vault.saveEntry(draft);
 assert.equal(saved.accounts[0].hasPassword, true); assert.equal(saved.accounts[0].password, undefined);
 assert.equal(vault.list().length, 0); assert.equal(vault.secret(saved.id, 'password'), draft.accounts[0].password);
 assert.deepEqual(vault.reuseReference({ password: 'host-password' }), { password: 'host-password' });
 const edited = await vault.saveEntry({ ...draft, id: saved.id, revision: 0, accounts: [{ ...saved.accounts[0], password: undefined }] });
 assert.equal(vault.secret(saved.id, 'password'), draft.accounts[0].password);
 await assert.rejects(vault.saveEntry({ ...draft, id: saved.id, revision: 0 }), /changed/);
 await assert.rejects(vault.saveEntry({ ...draft, type: 'secureNote' }), /Invalid Vault entry type/);
 const disk = await fs.readFile(path.join(root, 'vault.json'), 'utf8');
 assert.ok(!disk.includes('sensitive-password'));
 assert.equal(edited.accounts[0].notes, 'Use work account');
 const restored = new PrivateKeyVault(path.join(root, 'vault.json'), protector); await restored.load();
 assert.equal(restored.entries().length, 1); assert.equal(restored.secret(edited.id, 'password'), draft.accounts[0].password);
});
test('unsafe login URLs, oversized fields and wrong entry types are rejected', async t => {
 const { vault } = await fixture(t);
 const draft = { type: 'login', loginUrl: 'https://example.com/', accounts: [{ username: '', notes: '' }] };
 for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:password@example.com', 'not a URL']) {
   await assert.rejects(vault.saveEntry({ ...draft, loginUrl: url }));
 }
 await assert.rejects(vault.saveEntry({ ...draft, accounts: [{ username: 'x'.repeat(1001), notes: '' }] }));
 const saved = await vault.saveEntry({ ...draft, accounts: [{ ...draft.accounts[0], generatePassword: true }] });
 assert.equal(vault.secret(saved.id, 'password').length, 24);
 await assert.rejects(vault.rename(saved.id, 'new', 0), /Not an SSH key/);
 assert.throws(() => vault.resolve({ privateKeyId: saved.id }), /unavailable/);
});
test('remote migration retries safely, retains backup and rejects stale writes and changed identity', async t => {
 const { vault, root } = await fixture(t); const saved = await vault.add('existing', key);
 let state = { instanceId: 'server-a', revision: 0, records: [] };
 let failImport = true;
 const remote = {
  enabled: () => true,
  read: async () => structuredClone(state),
  import: async records => {
   for (const record of records) if (!state.records.some(item => item.id === record.id)) state.records.push(structuredClone(record));
   if (failImport) { failImport = false; throw new Error('Lost response'); }
  },
  write: async (records, revision) => { if (revision !== state.revision) throw new Error('conflict'); state.records = structuredClone(records); state.revision++; }
 };
 vault.attachRemote(remote);
 assert.match((await vault.refresh()).message, /unavailable/);
 assert.equal(vault.resolve({ privateKeyId: saved.id }).privateKey, key);
 assert.match((await vault.refresh()).message, /connected/);
 assert.equal(state.records.length, 1);
 assert.ok(await fs.stat(path.join(root, 'vault.json.migration-backup')));
 await vault.rename(saved.id, 'remote name', 0);
 assert.equal(state.records[0].name, 'remote name');
 state.records[0].revision++; state.records[0].name = 'another client'; state.revision++;
 await assert.rejects(vault.rename(saved.id, 'stale', 1), /changed/);
 state.instanceId = 'other-server';
 assert.match((await vault.refresh()).message, /unavailable/);
 assert.equal(vault.list()[0].name, 'another client');
});

test('a restored older remote database cannot erase cached keys, including after restart', async t => {
 const { vault, root } = await fixture(t); const keyView = await vault.add('existing', key);
 let state = { instanceId: 'server', revision: 0, records: [] };
 const remote = { enabled: () => true, read: async () => structuredClone(state), import: async records => { state.records = structuredClone(records); state.revision = 1; }, write: async () => {} };
 vault.attachRemote(remote); await vault.refresh();
 const restored = new PrivateKeyVault(path.join(root, 'vault.json'), protector); await restored.load(); restored.attachRemote(remote);
 state = { instanceId: 'server', revision: 0, records: [] };
 assert.match((await restored.refresh()).message, /unavailable/);
 assert.equal(restored.resolve({ privateKeyId: keyView.id }).privateKey, key);
});

test('retired secure notes remain encrypted during saves but are not exposed in Vault', async t => {
 const { root } = await fixture(t);
 const file = path.join(root, 'vault.json');
 const legacy = { id: 'legacy-note', type: 'secureNote', name: 'Old note', notes: 'preserve-me', application: '', username: '', urls: [], tags: [], createdAt: '2026-10-05T00:00:00Z' };
 await fs.writeFile(file, JSON.stringify({ version: 1, encrypted: protector.encryptString(JSON.stringify([legacy])).toString('base64') }));
 const vault = new PrivateKeyVault(file, protector); await vault.load();
 assert.deepEqual(vault.entries(), []);
 assert.throws(() => vault.secret(legacy.id, 'notes'), /unavailable/);
 await vault.saveEntry({ type: 'login', loginUrl: 'https://example.com', accounts: [{ username: '', notes: 'Login notes' }] });
 const decoded = JSON.parse(protector.decryptString(Buffer.from(JSON.parse(await fs.readFile(file, 'utf8')).encrypted, 'base64')));
 assert.equal(decoded.records.find(record => record.id === legacy.id).notes, 'preserve-me');
 assert.equal(vault.entries().length, 1);
});

test('website accounts keep separate passwords across edits, additions, removal and stale drafts', async t => {
 const { vault } = await fixture(t);
 const saved = await vault.saveEntry({ type: 'login', loginUrl: 'https://site.example/login', accounts: [{ username: 'alice', password: 'alice-secret', notes: 'Personal' }, { username: 'bob', password: 'bob-secret', notes: 'Work' }] });
 assert.equal(saved.accounts.length, 2); assert.throws(() => vault.secret(saved.id, 'password'), /unavailable/);
 assert.equal(vault.secret(saved.id, 'password', saved.accounts[1].id), 'bob-secret');
 const edited = await vault.saveEntry({ id: saved.id, revision: 0, type: 'login', loginUrl: saved.loginUrl, accounts: [{ ...saved.accounts[1], username: 'robert' }, { username: 'charlie', password: 'new-secret', notes: 'New' }] });
 assert.equal(vault.secret(saved.id, 'password', edited.accounts[0].id), 'bob-secret');
 assert.throws(() => vault.secret(saved.id, 'password', saved.accounts[0].id), /unavailable/);
 await assert.rejects(vault.saveEntry({ id: saved.id, revision: 0, type: 'login', loginUrl: saved.loginUrl, accounts: edited.accounts }), /changed/);
 await assert.rejects(vault.saveEntry({ type: 'login', loginUrl: saved.loginUrl, accounts: [{ username: 'extra', notes: '' }] }), /already exists/);
});
test('Chrome imports are atomic, preview is secret-free and stale previews cannot write', async t => {
 const { vault } = await fixture(t);
 const { parseChromeCsv } = require('../dist/main/vault/chromeImport');
 const rows = parseChromeCsv('url,username,password,note\nhttps://site.example/,alice,secret-one,First\nhttps://site.example/,bob,secret-two,Second');
 const preview = await vault.previewImport(rows); assert.ok(!JSON.stringify(preview).includes('secret-one')); assert.equal(vault.entries().length, 0);
 const result = await vault.importAccounts(rows, preview.fingerprint); assert.deepEqual(result, { accounts: 2, websites: 1 });
 const view = vault.entries()[0]; assert.equal(view.accounts.length, 2); assert.equal(vault.secret(view.id, 'password', view.accounts[1].id), 'secret-two');
 await assert.rejects(vault.importAccounts(rows, preview.fingerprint), /Vault changed/);
 assert.equal(vault.entries().length, 1);
 const duplicates = await vault.previewImport(rows); assert.ok(duplicates.rows.every(row => row.status === 'duplicate'));
});

test('Login deletion clears credentials, survives restart and rejects stale or SSH deletion', async t => {
 const {root,vault}=await fixture(t);
 const entry=await vault.saveEntry({type:'login',loginUrl:'https://delete.example',accounts:[{username:'alice',password:'secret-delete',notes:'private-note'}]});
 await assert.rejects(vault.deleteLogin(entry.id,99),/changed/);
 assert.equal(vault.entries().length,1);
 await vault.deleteLogin(entry.id,entry.revision);
 assert.equal(vault.entries().length,0);
 const raw=JSON.parse(await fs.readFile(path.join(root,'vault.json'),'utf8'));
 const clear=protector.decryptString(Buffer.from(raw.encrypted,'base64'));
 assert.ok(!clear.includes('secret-delete')); assert.ok(!clear.includes('alice')); assert.ok(!clear.includes('private-note'));
 const restored=new PrivateKeyVault(path.join(root,'vault.json'),protector); await restored.load(); assert.equal(restored.entries().length,0);
 await assert.rejects(vault.saveEntry({...entry,type:'login',accounts:[{username:'alice',password:'restore',notes:''}]}),/changed/);
 const ssh=await vault.add('key',key);
 await assert.rejects(vault.deleteLogin(ssh.id,0),/changed/); assert.equal(vault.list().length,1);
});

test('editing a Login can explicitly clear its saved password', async t => {
 const {vault}=await fixture(t);
 const saved=await vault.saveEntry({type:'login',loginUrl:'https://clear.example',accounts:[{username:'test',password:'test-only',notes:''}]});
 const edited=await vault.saveEntry({...saved,accounts:saved.accounts.map(account=>({...account,password:''}))});
 assert.equal(edited.accounts[0].hasPassword,false); assert.equal(vault.secret(saved.id,'password',saved.accounts[0].id),'');
});
