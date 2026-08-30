const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('host dialog uses a stepper-based connection path editor with compact rule tables', async () => {
  const rendererDir = path.join(__dirname, '..', 'dist', 'renderer');
  const [html, renderer, tailwind, baseStyles] = await Promise.all([
    readFile(path.join(rendererDir, 'index.html'), 'utf8'),
    readFile(path.join(rendererDir, 'renderer.js'), 'utf8'),
    readFile(path.join(rendererDir, 'tailwind.css'), 'utf8'),
    readFile(path.join(rendererDir, 'styles.css'), 'utf8'),
  ]);
  const styles = `${tailwind}\n${baseStyles}`;

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
  assert.match(hostDialog, /id="host-edit-route"/);
  assert.match(hostDialog, /class="he-local-chip"[\s\S]*?Local/);
  assert.match(hostDialog, /id="target-node-card"/);
  assert.match(hostDialog, /id="add-jump-host-btn"/);
  assert.doesNotMatch(hostDialog, /Jump Servers \(Optional\)/);
  assert.doesNotMatch(hostDialog, /id="use-jump-host"/);
  assert.doesNotMatch(hostDialog, /id="auth-type"/);

  assert.match(hostDialog, /id="private-key-source-status"/);
  assert.match(hostDialog, /id="toggle-private-key-btn"/);
  assert.match(hostDialog, /id="private-key-summary-toggle"/);
  assert.match(hostDialog, /data-empty="No forwarding rules"/);
  assert.match(hostDialog, /data-empty="No services"/);
  assert.match(hostDialog, /id="ssh-port"[^>]*type="text"[^>]*inputmode="numeric"[^>]*pattern="\[0-9\]\*"[^>]*maxlength="5"/);
  assert.doesNotMatch(hostDialog, /type="number"/);

  for (const field of ['sshHost', 'sshPort', 'username', 'password', 'privateKey', 'passphrase']) {
    assert.match(dynamicEditors, new RegExp(`data-field="${field}"`));
  }
  assert.match(dynamicEditors, /data-node-auth/);
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
  assert.match(renderer, /renderHostEditRoute\(\)/);
  assert.doesNotMatch(renderer, /gateway\.example\.com:22/);
  assert.doesNotMatch(renderer, /Runs through the remote login shell\./);

  assert.match(renderer, /Port 0 disables remote exposure/);
  assert.doesNotMatch(renderer, /\n\s*Local Port \(Optional\)\n/);
  assert.doesNotMatch(renderer, /\n\s*Remote Port \(Optional\)\n/);
  assert.doesNotMatch(renderer, /\n\s*Exposed Port \(Optional\)\n/);

  assert.match(styles, /\.form-actions[^{]*\{[^}]*position:\s*sticky/);
  assert.match(styles, /#host-dialog \.he-table-head[^{]*\{[^}]*position:\s*sticky/);
  assert.match(styles, /#host-dialog \.he-grid-forward[^{]*\{[^}]*grid-template-columns/);
  assert.match(styles, /#host-dialog \.he-grid-service[^{]*\{[^}]*grid-template-columns/);
  assert.match(styles, /\.he-card-summary/);
  assert.match(styles, /\.he-cmd-text[^{]*\{[^}]*text-overflow:\s*ellipsis/);
});
