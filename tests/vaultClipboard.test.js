const test = require('node:test');
const assert = require('node:assert/strict');
const { copyVaultValue, isVaultClipboardValue } = require('../dist/main/vault/clipboard');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('Vault copies bypass history, clear on expiry, and preserve later unrelated copies', async () => {
 let text = ''; const clipboard = { writeText: value => { text = value; }, readText: () => text, clear: () => { text = ''; } };
 copyVaultValue(clipboard, 'secret-one', 20);
 assert.equal(text, 'secret-one'); assert.equal(isVaultClipboardValue(text), true);
 await delay(40); assert.equal(text, ''); assert.equal(isVaultClipboardValue('secret-one'), false);
 copyVaultValue(clipboard, 'secret-two', 20); text = 'unrelated';
 await delay(40); assert.equal(text, 'unrelated');
 copyVaultValue(clipboard, 'old', 20); copyVaultValue(clipboard, 'new', 60);
 await delay(40); assert.equal(text, 'new'); assert.equal(isVaultClipboardValue(text), true);
 await delay(40); assert.equal(text, '');
});
