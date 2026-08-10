const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('host dialog uses a dense three-tab connection-path editor without port steppers', async () => {
  const rendererDir = path.join(__dirname, '..', 'dist', 'renderer');
  const [html, renderer, styles] = await Promise.all([
    readFile(path.join(rendererDir, 'index.html'), 'utf8'),
    readFile(path.join(rendererDir, 'renderer.js'), 'utf8'),
    readFile(path.join(rendererDir, 'tailwind.css'), 'utf8'),
  ]);

  const hostDialogStart = html.indexOf('<dialog id="host-dialog"');
  const hostDialogEnd = html.indexOf('</dialog>', hostDialogStart);
  assert.notEqual(hostDialogStart, -1);
  assert.notEqual(hostDialogEnd, -1);
  const hostDialog = html.slice(hostDialogStart, hostDialogEnd);
  const dynamicEditors = renderer.slice(
    renderer.indexOf('function createJumpHostEditorRow'),
    renderer.indexOf('function collectForwardsFromEditor'),
  );

  assert.equal((hostDialog.match(/role="tab"/g) ?? []).length, 3);
  assert.match(hostDialog, /data-host-edit-tab="path"[^>]*>[\s\S]*?Connection Path/);
  assert.match(hostDialog, /data-host-edit-tab="forwards"[^>]*>[\s\S]*?Forwarding Rules/);
  assert.match(hostDialog, /data-host-edit-tab="services"[^>]*>[\s\S]*?Services/);
  assert.match(hostDialog, /data-host-edit-panel="path"/);
  assert.match(hostDialog, /data-host-edit-panel="forwards"/);
  assert.match(hostDialog, /data-host-edit-panel="services"/);
  assert.match(hostDialog, /id="host-edit-route"[\s\S]*?>[\s\S]*?Local[\s\S]*?Target/);
  assert.doesNotMatch(hostDialog, /Jump Servers \(Optional\)/);

  assert.match(hostDialog, /id="private-key-source-status"/);
  assert.match(hostDialog, /id="toggle-private-key-btn"/);
  assert.match(hostDialog, /id="private-key-summary-toggle"/);
  assert.match(hostDialog, /data-empty="No forwarding rules"/);
  assert.match(hostDialog, /data-empty="No services"/);
  assert.match(hostDialog, /id="use-jump-host"[^>]*class="hidden"/);
  assert.match(hostDialog, /id="ssh-port"[^>]*type="text"[^>]*inputmode="numeric"[^>]*pattern="\[0-9\]\*"[^>]*maxlength="5"/);
  assert.doesNotMatch(hostDialog, /type="number"/);

  for (const field of ['sshHost', 'sshPort', 'username', 'authType', 'password', 'privateKey', 'passphrase']) {
    assert.match(dynamicEditors, new RegExp(`data-field="${field}"`));
  }
  for (const field of ['id', 'name', 'localHost', 'localPort', 'remoteHost', 'remotePort', 'autoStart']) {
    assert.match(dynamicEditors, new RegExp(`data-field="${field}"`));
  }
  for (const field of ['id', 'name', 'port', 'forwardLocalPort', 'startCommand']) {
    assert.match(dynamicEditors, new RegExp(`data-field="${field}"`));
  }
  assert.equal((dynamicEditors.match(/data-port-input/g) ?? []).length, 5);
  assert.equal((dynamicEditors.match(/inputmode="numeric"/g) ?? []).length, 5);
  assert.equal((dynamicEditors.match(/maxlength="5"/g) ?? []).length, 5);
  assert.doesNotMatch(dynamicEditors, /type="number"/);
  assert.match(renderer, /function isNumericPortText\(value\)/);
  assert.match(renderer, /\^\\d\{0,5\}\$/);
  assert.match(renderer, /input\.dataset\.lastValidPort/);
  assert.match(renderer, /renderHostEditRoute\(hopCount\)/);
  assert.doesNotMatch(renderer, /gateway\.example\.com:22/);
  assert.doesNotMatch(renderer, /Runs through the remote login shell\./);

  assert.match(renderer, /Exposed Port \(0 = disabled\)/);
  assert.doesNotMatch(renderer, /\n\s*Local Port \(Optional\)\n/);
  assert.doesNotMatch(renderer, /\n\s*Remote Port \(Optional\)\n/);
  assert.doesNotMatch(renderer, /\n\s*Exposed Port \(Optional\)\n/);

  assert.match(styles, /\.form-actions[^{]*\{[^}]*position:sticky/);
  assert.match(styles, /#host-dialog \.host-edit-table-head[^{]*\{[^}]*position:sticky/);
  assert.match(styles, /#host-dialog \.host-edit-path-grid[^{]*\{[^}]*grid-template-columns/);
  assert.match(styles, /#host-dialog \.host-edit-forward-grid[^{]*\{[^}]*grid-template-columns/);
  assert.match(styles, /#host-dialog \.host-edit-service-grid[^{]*\{[^}]*grid-template-columns/);
});
