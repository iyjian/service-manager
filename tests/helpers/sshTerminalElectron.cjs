const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { generateKeyPairSync } = require('node:crypto');
const { Server } = require('ssh2');
const root = path.resolve(__dirname, '../..');
const output = process.argv[2];
const dist = path.join(root, 'dist/renderer');
const { SshTerminalRuntime } = require('../../dist/main/ssh/sshTerminalRuntime');
const { registerSshTerminalIpc } = require('../../dist/main/ssh/sshTerminalIpc');
const { IPC_CHANNELS } = require('../../dist/main/core/ipcChannels');
const { LocalTerminalRuntime } = require('../../dist/main/terminal/localTerminalRuntime');
const { registerLocalTerminalIpc } = require('../../dist/main/terminal/localTerminalIpc');
const { UiPreferencesStore } = require('../../dist/main/core/uiPreferencesStore');
fs.mkdirSync(path.join(output, 'electron-profile'), { recursive: true });
app.setPath('userData', path.join(output, 'electron-profile'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let runtime, localRuntime, web, ssh, window;
const clients = new Set();
const inputs = [], dimensions = [], states = [], errors = [];
const localStates = [], localOutputs = [], localPtys = [];
const deadline = setTimeout(() => { console.error('SSH Electron test exceeded 45 seconds'); app.exit(1); }, 45000);

async function main() {
  await app.whenReady();
  const preferences = new UiPreferencesStore(path.join(output, 'ui-preferences.json'));
  await preferences.load();
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  ssh = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client); client.on('error', () => undefined); client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => ctx.method === 'password' && ctx.password === 'test-password' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (acceptPty, _reject, size) => { dimensions.push(size); acceptPty(); });
      session.on('window-change', (_accept, _reject, size) => dimensions.push(size));
      session.on('shell', (acceptShell) => {
        const stream = acceptShell();
        stream.write('Welcome to Development\r\nSSH test server · UTF-8 enabled\r\n\x1b[32mdeveloper@development:~$ \x1b[0m');
        let command = '';
        stream.on('data', (data) => {
          inputs.push(data.toString()); stream.write(data);
          for (const character of data.toString()) {
            if (character === '\r' || character === '\n') {
              if (command.trim() === 'exit') { stream.exit(0); stream.end(); return; }
              command = '';
            } else command += character;
          }
        });
      });
    }));
  });
  ssh.listen(0, '127.0.0.1'); await once(ssh, 'listening');
  const hosts = Array.from({ length: 10 }, (_, i) => ({
    id: 'host-' + i, name: i === 0 ? 'Development' : i === 1 ? 'Production EU — application and database services' : 'Build Server ' + i,
    sshHost: '127.0.0.1', sshPort: ssh.address().port, username: 'developer', authType: 'password', password: 'test-password',
    jumpHosts: [], forwards: [], services: [],
  }));
  const preload = path.join(root, 'dist/main/core/preload.js');
  const channels = new Set([...Object.values(IPC_CHANNELS), ...[...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1])]);
  for (const channel of channels) {
    if (channel.startsWith('ssh-terminal:') || channel.startsWith('local-terminal:')) continue;
    ipcMain.handle(channel, async (_event, input) => {
      if (channel === 'host:list') return hosts.map(({ password, ...value }) => value);
      if (channel === 'app:startup-s3-sync:get') return { status: 'ready', syncState: { status: 'idle' } };
      if (channel === 'settings:ui:get') return preferences.get();
      if (channel === 'settings:ui:save') {
        const saved = await preferences.save(input);
        window.webContents.send(IPC_CHANNELS.uiPreferencesChanged, saved);
        return saved;
      }
      if (channel === 'settings:s3:get') return { endpoint: '', bucket: '', region: 'us-east-1', hasCredentials: false, hasSyncEncryptionKey: false, syncState: { status: 'idle' } };
      if (channel === 'settings:notes:share:get' || channel === 'settings:notes:share:save') return { shortenerBaseUrl: '', hasShortenerApiKey: false };
      if (channel === 'settings:llm:get' || channel === 'settings:llm:save') return { endpoint: '', selectedModel: '', hasToken: false };
      if (channel === 'app:memory-usage') return { bytes: 140000000 };
      if (channel === 'updater:get-state') return { status: 'idle', currentVersion: '0.3.81', trigger: 'auto' };
      if (channel === 'changelog:get') return { shouldShow: false, en: [], zh: [] };
      if (channel === 'kubernetes:get-state') return { contexts: [], connection: 'disconnected', kubeconfigReloadAvailable: false, namespaceScope: { mode: 'all', namespaces: [] } };
      return channel.includes('list') ? [] : {};
    });
  }
  // Serve the actual built renderer; disable only telemetry in this isolated harness.
  web = http.createServer((req, res) => {
    let pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/utils/sentry.js') { res.setHeader('Content-Type', 'text/javascript'); res.end('export function captureRendererException(scope,error) { console.error(scope,error); }'); return; }
    const file = pathname.startsWith('/assets/') ? path.resolve(root, '.' + pathname) : path.resolve(dist, '.' + pathname);
    if (!file.startsWith(dist + path.sep) && !file.startsWith(path.join(root, 'assets') + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      let content = fs.readFileSync(file);
      if (file.endsWith('index.html')) content = content.toString()
        .replace('<head>', `<head><script>window.__qaErrors=[];addEventListener('error',e=>__qaErrors.push(e.message));addEventListener('unhandledrejection',e=>__qaErrors.push(String(e.reason)));</script>`)
        .replace('<script type="module" src="./renderer.js"></script>', `<script>window.__qaTerminals=[];const BaseTerminal=window.Terminal;window.Terminal=class extends BaseTerminal {constructor(...args){super(...args);__qaTerminals.push(this);}};</script><script type="module" src="./renderer.js"></script>`);
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream');
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  web.listen(0, '127.0.0.1'); await once(web, 'listening');
  window = new BrowserWindow({ width: 1230, height: 820, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
  runtime = new SshTerminalRuntime({
    getHost: (id) => hosts.find((host) => host.id === id),
    state: (owner, state) => { states.push(state); if (!window.isDestroyed() && owner === window.webContents.id) window.webContents.send(IPC_CHANNELS.sshTerminalState, state); },
    output: (owner, value) => { if (!window.isDestroyed() && owner === window.webContents.id) window.webContents.send(IPC_CHANNELS.sshTerminalOutput, value); },
  });
  registerSshTerminalIpc(runtime, (event) => event.sender === window.webContents);
  localRuntime = new LocalTerminalRuntime({
    ...(process.platform === 'win32' ? {} : { shell: { file: '/bin/sh', args: ['-i'], name: 'sh' } }),
    cwd: output,
    loadPty: async () => ({ spawn: (...args) => { const pty = require('node-pty').spawn(...args); localPtys.push(pty); return pty; } }),
    state: (owner, state) => { localStates.push(state); if (!window.isDestroyed() && owner === window.webContents.id) window.webContents.send(IPC_CHANNELS.localTerminalState, state); },
    output: (owner, value) => { localOutputs.push(value); if (!window.isDestroyed() && owner === window.webContents.id) window.webContents.send(IPC_CHANNELS.localTerminalOutput, value); },
  });
  registerLocalTerminalIpc(localRuntime, (event) => event.sender === window.webContents);
  const owner = window.webContents.id;
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) { runtime.closeOwner(owner); localRuntime.closeOwner(owner); } });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const wc = window.webContents;
  const evaluate = (code) => wc.executeJavaScript(code, true);
  const waitFor = async (code) => { for (let i = 0; i < 100; i++) { const value = await evaluate(code); if (value) return value; await delay(30); } throw new Error('Timed out: ' + code); };
  const waitMain = async (predicate) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(30); } throw new Error('Timed out waiting for local PTY'); };
  await window.loadURL(`http://127.0.0.1:${web.address().port}/`);
  await waitFor(`document.querySelectorAll('[data-action="ssh-host"]').length === 10`);
  await wc.debugger.attach('1.3');
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const exitShell = async () => {
    await waitFor(`document.activeElement?.classList.contains('xterm-helper-textarea')`);
    await wc.debugger.sendCommand('Input.insertText', { text: 'exit' });
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  for (let i = 0; i < 3; i++) await click('[data-action="ssh-host"]');
  await waitFor(`document.querySelectorAll('#ssh-workspace [role="tab"]').length === 3`);
  await waitFor(`document.querySelector('#ssh-workspace [aria-selected="true"]').getAttribute('aria-label').endsWith('open')`);
  await delay(150);
  const names = await evaluate(`Array.from(document.querySelectorAll('#ssh-workspace [role="tab"]')).map(e=>e.textContent)`);
  assert.deepEqual(names, ['Development #1', 'Development #2', 'Development #3']);
  await waitFor(`document.activeElement?.classList.contains('xterm-helper-textarea')`);
  await wc.debugger.sendCommand('Input.insertText', { text: 'echo 中文' });
  await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await delay(100);
  assert.ok(inputs.join('').includes('echo 中文\r'));
  await click('[data-page-target="kubernetes"]');
  await delay(80);
  assert.equal(states.filter((state) => state.state === 'closed').length, 0);
  const firstId = await evaluate(`document.querySelector('#ssh-workspace [role="tab"]').id.replace('ssh-tab-','')`);
  await evaluate(`window.serviceApi.writeSshTerminal(${JSON.stringify(firstId)}, '\\r\\nBackground output while viewing Kubernetes\\r\\n')`);
  await waitFor(`(()=>{const b=window.__qaTerminals[0].buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString()).join('').includes('Background output while viewing Kubernetes')})()`);
  await click('[data-page-target="hosts"]');
  assert.equal(await evaluate(`document.querySelectorAll('#ssh-workspace [role="tab"]').length`), 3);
  assert.equal(await evaluate('window.__qaTerminals.length'), 3);
  await click('#ssh-workspace [role="tab"]');
  await waitFor(`document.activeElement?.classList.contains('xterm-helper-textarea')`);
  const rect = await evaluate(`(()=>{const r=document.querySelector('#ssh-workspace-resize-handle').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+3,height:document.querySelector('#ssh-workspace').getBoundingClientRect().height}})()`);
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y - 70, button: 'left', buttons: 1 });
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y - 70, button: 'left', buttons: 0, clickCount: 1 });
  await delay(80);
  assert.ok(await evaluate(`document.querySelector('#ssh-workspace').getBoundingClientRect().height > ${rect.height + 40}`));
  const layout = [];
  for (const [width, height] of [[900, 620], [1230, 820], [1920, 1080]]) {
    window.setContentSize(width, height); await delay(120);
    const value = await evaluate(`(()=>{const h=document.querySelector('main[data-page="hosts"]'), w=document.querySelector('#ssh-workspace'), p=document.querySelector('.hosts-content'), l=document.querySelector('.host-list-section');const r=w.getBoundingClientRect(), host=w.querySelector('.kubernetes-terminal-host').getBoundingClientRect(), screen=w.querySelector('.xterm-screen').getBoundingClientRect();return{width:innerWidth,height:innerHeight,pageWidth:h.clientWidth,workspaceBottom:r.bottom,workspaceHeight:r.height,contentHeight:p.clientHeight,documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight,listScrolls:l.scrollHeight>l.clientHeight,terminal:!!w.querySelector('.xterm-screen'),terminalBottomGap:host.bottom-screen.bottom,terminalRightGap:host.right-screen.right}})()`);
    assert.equal(value.width, width); assert.ok(value.documentWidth <= width); assert.ok(value.documentHeight <= height);
    assert.ok(value.pageWidth >= width - 70); assert.ok(value.workspaceBottom <= height); assert.ok(value.workspaceHeight <= value.contentHeight * 0.8 + 1);
    assert.ok(value.listScrolls && value.terminal);
    assert.ok(value.terminalBottomGap >= 8, `Terminal bottom padding was clipped: ${JSON.stringify(value)}`);
    assert.ok(value.terminalRightGap >= 8, `Terminal right padding was clipped: ${JSON.stringify(value)}`);
    layout.push(value);
    fs.writeFileSync(path.join(output, `ssh-${width}x${height}.png`), (await wc.capturePage()).toPNG());
  }
  assert.ok(dimensions.some((size) => size.cols > 120));
  await click('#ssh-workspace .kubernetes-workspace-tab-close');
  assert.equal(await evaluate(`document.querySelectorAll('#ssh-workspace [role="tab"]').length`), 2);
  await click('[data-action="ssh-host"]');
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('#ssh-workspace [role="tab"]')).some(e=>e.textContent==='Development #4')`));
  window.setContentSize(900, 620);
  for (let i = 0; i < 8; i++) await evaluate(`document.querySelectorAll('[data-action="ssh-host"]')[1].click()`);
  await waitFor(`document.querySelector('#ssh-workspace [aria-selected="true"]').getAttribute('aria-label').endsWith('open')`);
  assert.ok(await evaluate(`(()=>{const t=document.querySelector('#ssh-workspace-tabs');return t.scrollWidth>t.clientWidth && document.documentElement.scrollWidth===innerWidth})()`));
  assert.ok(await evaluate(`document.querySelector('#ssh-workspace [aria-selected="true"]').title.includes('Production EU — application and database services #8')`));
  assert.ok(await evaluate(`(()=>{const t=document.querySelector('#ssh-workspace [aria-selected="true"]'), n=t.querySelector('.ssh-workspace-tab-sequence').getBoundingClientRect(), c=t.nextElementSibling.getBoundingClientRect();return n.width>0 && n.right<=innerWidth && c.right<=innerWidth})()`));
  fs.writeFileSync(path.join(output, 'ssh-many-tabs-900x620.png'), (await wc.capturePage()).toPNG());
  const exitedTab = await evaluate(`document.querySelector('#ssh-workspace [aria-selected="true"]').id`);
  const tabsBeforeExit = await evaluate(`document.querySelectorAll('#ssh-workspace [role="tab"]').length`);
  await exitShell();
  await waitFor(`document.querySelectorAll('#ssh-workspace [role="tab"]').length === ${tabsBeforeExit - 1}`);
  assert.ok(await evaluate(`!document.getElementById(${JSON.stringify(exitedTab)})`));
  assert.ok(states.some((state) => state.id === exitedTab.replace('ssh-tab-', '') && state.closeReason === 'shell-exit'));
  while (await evaluate(`document.querySelectorAll('#ssh-workspace [role="tab"]').length`)) await click('#ssh-workspace .kubernetes-workspace-tab-close');
  assert.ok(await evaluate(`document.querySelector('#ssh-workspace').classList.contains('hidden')`));
  await click('[data-action="ssh-host"]');
  await waitFor(`document.querySelector('#ssh-workspace [aria-selected="true"]').getAttribute('aria-label').endsWith('open')`);
  await exitShell();
  await waitFor(`document.querySelector('#ssh-workspace').classList.contains('hidden')`);
  await click('[data-action="ssh-host"]');
  await waitFor(`document.querySelector('#ssh-workspace [aria-selected="true"]').getAttribute('aria-label').endsWith('open')`);
  const openBeforeReload = states.filter((state) => state.state === 'open').at(-1).id;
  // The same real preload/IPC is used for a local native PTY and appearance saves.
  await click('#local-terminal-btn');
  await waitFor(`document.querySelector('#ssh-workspace [aria-selected="true"]').getAttribute('aria-label').endsWith('open')`);
  const localId = localStates.find((state) => state.state === 'open').id;
  await waitMain(() => localOutputs.some((item) => item.id === localId));
  await wc.debugger.sendCommand('Input.insertText', { text: process.platform === 'win32'
    ? 'Write-Output ("LOCAL_" + "PTY")' : 'printf "LOCAL_%s\\n" PTY; test -t 0 && test -t 1 && printf "PTY_%s\\n" TTY' });
  await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await waitMain(() => localOutputs.filter((item) => item.id === localId).map((item) => item.data).join('').includes('LOCAL_PTY'));
  if (process.platform !== 'win32') assert.ok(localOutputs.map((item) => item.data).join('').includes('PTY_TTY'));
  await click('[data-page-target="kubernetes"]');
  assert.ok(!localStates.some((state) => state.id === localId && state.state === 'closed'));
  await click('[data-page-target="hosts"]');
  assert.ok(await evaluate(`document.querySelector('#ssh-workspace [aria-selected="true"]').textContent.includes('Local Terminal')`));
  const terminalCount = await evaluate('window.__qaTerminals.length');
  assert.ok(await evaluate(`window.__qaTerminals.at(-1).options.fontFamily.startsWith('"Monaco"') && window.__qaTerminals.at(-1).options.fontSize===18`));
  await click('#nav-settings-btn');
  await waitFor(`!document.querySelector('#terminal-font-family').disabled`);
  await click('#settings-terminal-tab');
  await evaluate(`document.querySelector('#terminal-font-family').value='JetBrains Mono';document.querySelector('#terminal-font-size').value='16';document.querySelector('#terminal-theme').value='light';document.querySelector('#terminal-theme').dispatchEvent(new Event('change'))`);
  fs.writeFileSync(path.join(output, 'terminal-settings.png'), (await wc.capturePage()).toPNG());
  await click('#settings-save-btn');
  await waitFor(`!document.querySelector('#settings-dialog').open`);
  assert.deepEqual(preferences.get().terminal, { fontFamily: 'JetBrains Mono', fontSize: 16, theme: 'light' });
  assert.equal(await evaluate('window.__qaTerminals.length'), terminalCount);
  assert.ok(await evaluate(`window.__qaTerminals.at(-1).options.fontFamily.startsWith('"JetBrains Mono"') && window.__qaTerminals.at(-1).options.fontSize===16 && window.__qaTerminals.at(-1).options.theme.background==='#fafafa'`));
  assert.ok(!localStates.some((state) => state.id === localId && state.state === 'closed'));
  await click('#nav-settings-btn'); await waitFor(`!document.querySelector('#terminal-font-family').disabled`);
  await click('#terminal-reset-btn'); await click('#settings-save-btn'); await waitFor(`!document.querySelector('#settings-dialog').open`);
  await click('#ssh-workspace [aria-selected="true"]');
  fs.writeFileSync(path.join(output, 'local-terminal.png'), (await wc.capturePage()).toPNG());
  await exitShell();
  await waitMain(() => localStates.some((state) => state.id === localId && state.closeReason === 'shell-exit'));
  await waitFor(`!document.getElementById('ssh-tab-${localId}')`);
  await click('#local-terminal-btn'); await waitFor(`document.querySelector('#ssh-workspace [aria-selected="true"]').getAttribute('aria-label').endsWith('open')`);
  const localBeforeReload = localStates.filter((state) => state.state === 'open').at(-1).id;
  await wc.reload(); await delay(100);
  assert.ok(states.some((state) => state.id === openBeforeReload && state.state === 'closed'));
  assert.ok(localStates.some((state) => state.id === localBeforeReload && state.state === 'closed'));
  if (process.platform !== 'win32') for (const pty of localPtys) await waitMain(() => { try { process.kill(pty.pid, 0); return false; } catch { return true; } });
  assert.deepEqual(await evaluate('window.__qaErrors'), []);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ names, layout, input: 'UTF-8 and Enter verified', resize: true, pagePersistence: true, shellExitClosesTab: true, localPty: true, appearanceSaved: true, reloadCleanup: true, errors }, null, 2));
  console.log('SSH_E2E_PASS ' + output);
}
main().then(() => {
  clearTimeout(deadline); runtime?.shutdown(); localRuntime?.shutdown(); for (const client of clients) client.end(); web?.close(); ssh?.close(); window?.destroy(); app.exit(0);
}).catch(async (error) => {
  console.error(error); console.error('Renderer errors:', errors);
  if (window && !window.isDestroyed()) { console.error(await window.webContents.executeJavaScript('document.body.innerText.slice(0,2500)').catch(() => 'unavailable')); fs.writeFileSync(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG()); }
  runtime?.shutdown(); localRuntime?.shutdown(); app.exit(1);
});
