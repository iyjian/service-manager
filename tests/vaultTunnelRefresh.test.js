const test = require('node:test');
const assert = require('node:assert/strict');
const { TunnelManager } = require('../dist/main/ssh/tunnelManager');
test('a previously scheduled reconnect picks up a replaced Vault key without restarting the live tunnel', async () => {
 const manager = new TunnelManager();
 const config = { id: 'forward', privateKey: 'old', passphrase: 'old-passphrase', jumpHosts: [{ privateKey: 'old-hop' }] };
 manager.configs.set('forward', config); manager.statuses.set('forward', { status: 'error' });
 let starts = 0;
 const connected = new Promise(resolve => { manager.start = async next => { starts++; resolve(next); }; });
 manager.scheduleReconnect('forward', Date.now() + 20);
 manager.updateCredentials({ ...config, privateKey: 'replacement', passphrase: 'replacement-passphrase', jumpHosts: [{ privateKey: 'new-hop' }] });
 assert.equal(starts, 0);
 const next = await connected;
 assert.equal(next.privateKey, 'replacement'); assert.equal(next.passphrase, 'replacement-passphrase'); assert.equal(next.jumpHosts[0].privateKey, 'new-hop');
 manager.clearTunnel('forward');
});
