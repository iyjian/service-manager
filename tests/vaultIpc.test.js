const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const handlers = new Map();
const original = Module._load;
const electron = { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, dialog: { showMessageBox: async input => { electron.lastDialog = input; } }, clipboard: { writeText: value => { electron.lastCopy = value; }, readText: () => '', clear: () => {} }, shell: { openExternal: async url => { electron.lastUrl = url; } } };
Module._load = function (name, ...args) { return name === 'electron' ? electron : original.call(this, name, ...args); };
let registerVaultIpc;
try { ({ registerVaultIpc } = require('../dist/main/vault/ipc')); } finally { Module._load = original; }
test('Vault IPC restricts windows and keeps revealed/copied credentials out of responses', async () => {
 const frame = {}; const event = { sender: { id: 7, mainFrame: frame }, senderFrame: frame };
 const entry = { id: 'one', name: 'Account', type: 'login', loginUrl: 'https://example.com/login' };
 registerVaultIpc({ status: () => ({ message: 'ready' }), entries: () => [entry], secret: () => 'private-value' }, { trustedSender: id => id === 7, mutate: work => work(), changed: async () => {} });
 assert.throws(() => handlers.get('vault:entries')({ ...event, sender: { id: 8, mainFrame: frame } }), /Unknown Vault/);
 assert.throws(() => handlers.get('vault:entries')({ ...event, senderFrame: {} }), /Unknown Vault/);
 assert.equal(await handlers.get('vault:copy')(event, 'one', 'password'), undefined);
 assert.equal(electron.lastCopy, 'private-value');
 assert.equal(await handlers.get('vault:reveal')(event, 'one'), undefined);
 assert.equal(electron.lastDialog.detail, 'private-value');
 await handlers.get('vault:open-url')(event, 'one', 0); assert.equal(electron.lastUrl, entry.loginUrl);
 entry.loginUrl = 'javascript:alert(1)';
 await assert.rejects(handlers.get('vault:open-url')(event, 'one', 0));
});

test('Chrome previews bind to their window, cancel without saving and reject unpreviewed rows', async t => {
 const fs = require('node:fs/promises'); const path = require('node:path'); const os = require('node:os');
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-ipc-csv-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
 const file = path.join(directory, 'chrome.csv'); await fs.writeFile(file, 'url,username,password,note\nhttps://example.com,alice,never-return-this,Note');
 electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
 let writes = 0;
 const { planChromeImport } = require('../dist/main/vault/chromeImport');
 registerVaultIpc({ previewImport: async rows => ({ fingerprint: 'snapshot', rows: planChromeImport([], rows).rows }), importAccounts: async (rows, fp) => { writes++; assert.equal(fp, 'snapshot'); assert.equal(rows[0].password, 'never-return-this'); return { accounts: rows.length, websites: 1 }; } }, { trustedSender: id => [7, 8].includes(id), mutate: work => work(), changed: async () => {} });
 const frame = {}; const makeEvent = id => ({ sender: { id, mainFrame: frame, isDestroyed: () => false, once: () => {} }, senderFrame: frame });
 const event = makeEvent(7); const other = makeEvent(8);
 const preview = await handlers.get('vault:chrome-preview')(event);
 assert.ok(!JSON.stringify(preview).includes('never-return-this')); assert.equal(writes, 0);
 await assert.rejects(handlers.get('vault:chrome-confirm')(other, preview.token, [preview.rows[0].id]), /expired/);
 await assert.rejects(handlers.get('vault:chrome-confirm')(event, preview.token, ['unpreviewed']), /Invalid import/);
 await handlers.get('vault:chrome-cancel')(event, preview.token);
 await assert.rejects(handlers.get('vault:chrome-confirm')(event, preview.token, [preview.rows[0].id]), /expired/);
 assert.equal(writes, 0);
 const fresh = await handlers.get('vault:chrome-preview')(event);
 assert.deepEqual(await handlers.get('vault:chrome-confirm')(event, fresh.token, [fresh.rows[0].id]), { accounts: 1, websites: 1 });
 await assert.rejects(handlers.get('vault:chrome-confirm')(event, fresh.token, [fresh.rows[0].id]), /expired/);
 assert.equal(writes, 1);
});

test('Login deletion requires confirmation and passes the reviewed revision', async () => {
 const frame={}; const event={sender:{id:7,mainFrame:frame},senderFrame:frame}; let writes=0;
 const entry={id:'login',type:'login',revision:3,loginUrl:'https://example.com',accounts:[{}]};
 registerVaultIpc({entries:()=>[entry],deleteLogin:async(id,revision)=>{assert.equal(id,'login');assert.equal(revision,3);writes++;}}, {trustedSender:id=>id===7,mutate:work=>work(),changed:async()=>{}});
 electron.dialog.showMessageBox=async input=>{assert.equal(input.defaultId,0);return {response:0};};
 assert.equal(await handlers.get('vault:delete-login')(event,'login',3),false); assert.equal(writes,0);
 electron.dialog.showMessageBox=async()=>({response:1});
 assert.equal(await handlers.get('vault:delete-login')(event,'login',3),true); assert.equal(writes,1);
 await assert.rejects(handlers.get('vault:delete-login')(event,'login',2),/changed/);
});

test('edit passwords are scoped to a trusted window and the reviewed Login revision', async () => {
 const frame={}; const event={sender:{id:7,mainFrame:frame},senderFrame:frame};
 registerVaultIpc({entries:()=>[{id:'login',type:'login',revision:4,accounts:[{id:'a'}]}],secret:(id,field,account)=>{assert.equal(id,'login');assert.equal(field,'password');assert.equal(account,'a');return 'test-only';}}, {trustedSender:id=>id===7,mutate:work=>work(),changed:async()=>{}});
 assert.deepEqual(await handlers.get('vault:edit-passwords')(event,'login',4),[{id:'a',password:'test-only'}]);
 assert.throws(()=>handlers.get('vault:edit-passwords')(event,'login',3),/changed/);
 assert.throws(()=>handlers.get('vault:edit-passwords')({...event,senderFrame:{}},'login',4),/Unknown Vault/);
});

test('inline password reveal only returns the requested account at the current revision', async () => {
 const frame={};const event={sender:{id:7,mainFrame:frame},senderFrame:frame};let reads=0;
 registerVaultIpc({entries:()=>[{id:'login',type:'login',revision:2,accounts:[{id:'a'},{id:'b'}]}],secret:(id,field,accountId)=>{reads++;assert.equal(accountId,'b');return 'test-only';}}, {trustedSender:id=>id===7,mutate:work=>work(),changed:async()=>{}});
 assert.equal(await handlers.get('vault:read-password')(event,'login',2,'b'),'test-only');
 assert.throws(()=>handlers.get('vault:read-password')(event,'login',1,'b'),/changed/);
 assert.throws(()=>handlers.get('vault:read-password')(event,'login',2,'missing'),/changed/);
 assert.throws(()=>handlers.get('vault:read-password')({...event,senderFrame:{}},'login',2,'b'),/Unknown Vault/);
 assert.equal(reads,1);
});
