const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const distRoot = path.join(__dirname, '..', 'dist');
const rendererRoot = path.join(distRoot, 'renderer');
const mainRoot = path.join(distRoot, 'main');

async function readIntegrationFiles() {
  const [html, styles, renderer, notesPage, codeMirrorVendor, settingsDialog, preload, main] = await Promise.all([
    readFile(path.join(rendererRoot, 'index.html'), 'utf8'),
    readFile(path.join(rendererRoot, 'tailwind.css'), 'utf8'),
    readFile(path.join(rendererRoot, 'renderer.js'), 'utf8'),
    readFile(path.join(rendererRoot, 'notesPage.js'), 'utf8'),
    readFile(path.join(rendererRoot, 'vendor', 'codemirror.js'), 'utf8'),
    readFile(path.join(rendererRoot, 'settingsDialog.js'), 'utf8'),
    readFile(path.join(mainRoot, 'preload.js'), 'utf8'),
    readFile(path.join(mainRoot, 'main.js'), 'utf8'),
  ]);
  return { html, styles, renderer, notesPage, codeMirrorVendor, settingsDialog, preload, main };
}

test('compiled Notes page and bridge expose CodeMirror and the complete local CRUD flow', async () => {
  const { html, renderer, notesPage, codeMirrorVendor, preload, main } = await readIntegrationFiles();

  assert.match(html, /<main class="app-shell hidden" data-page="notes">/);
  assert.match(html, /id="notes-search"[^>]*type="search"/);
  assert.match(html, /id="note-name"/);
  assert.match(html, /<div id="note-content" class="notes-content"[^>]*><\/div>/);
  assert.match(html, /id="note-tags"/);
  assert.match(html, /id="note-copy-btn"/);
  assert.match(html, /id="notes-new-btn"[\s\S]*?<svg[\s\S]*?<span>New Note<\/span>/);
  assert.match(html, /id="note-copy-btn"[\s\S]*?<svg[\s\S]*?id="note-copy-label">Copy<\/span>/);
  assert.doesNotMatch(html, /id="note-delete-btn"/);
  assert.match(html, /<script type="importmap">[\s\S]*?"codemirror": "\.\/vendor\/codemirror\.js"/);
  for (const language of ['markdown', 'bash', 'javascript', 'typescript']) {
    assert.match(html, new RegExp(`<option value="${language}"`));
  }

  assert.match(preload, /listNotes:\s*\(\)\s*=>\s*[^\n]*invoke\('notes:list'\)/);
  assert.match(preload, /createNote:\s*\(\)\s*=>\s*[^\n]*invoke\('notes:create'\)/);
  assert.match(preload, /updateNote:\s*\(id, draft\)\s*=>\s*[^\n]*invoke\('notes:update', \{ id, draft \}\)/);
  assert.match(preload, /deleteNote:\s*\(id\)\s*=>\s*[^\n]*invoke\('notes:delete', id\)/);
  assert.match(preload, /ipcRenderer\.on\('notes:flush-request', handler\)/);
  assert.match(preload, /ipcRenderer\.send\('notes:flush-result', \{ requestId, ok: true \}\)/);
  assert.match(preload, /exposeInMainWorld\('notesApi', notesApi\)/);

  for (const handler of ['notesList', 'notesCreate', 'notesUpdate', 'notesDelete']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\(IPC_CHANNELS\\.${handler}`));
  }
  assert.match(renderer, /registerNotesPage\(\)/);
  assert.match(notesPage, /id:\s*'notes'/);
  assert.match(notesPage, /import \{ basicSetup, EditorView \} from 'codemirror'/);
  assert.match(notesPage, /new EditorView\(\{/);
  assert.match(notesPage, /window\.notesApi\.updateNote\(id, draft\)/);
  assert.match(notesPage, /window\.serviceApi\.writeClipboardText\(note\.content\)/);
  assert.match(notesPage, /window\.notesApi\.deleteNote\(note\.id\)/);
  assert.match(notesPage, /className = 'notes-list-remove'/);
  assert.match(codeMirrorVendor, /const basicSetup/);
});

test('Notes keeps a bounded two-column frame with independently scrolling content', async () => {
  const { html, styles } = await readIntegrationFiles();

  assert.match(html, /<section class="notes-page"[^>]*>[\s\S]*?<aside class="notes-sidebar">[\s\S]*?<section class="notes-workspace"/);
  assert.match(styles, /\.app-shell\[data-page=notes\]\{[^}]*height:100dvh[^}]*max-height:100dvh[^}]*overflow:hidden/);
  assert.match(styles, /\.notes-page\{[^}]*overflow:hidden[^}]*grid-template-columns:minmax\(220px,260px\) minmax\(0,1fr\)/);
  assert.match(styles, /\.notes-page,\.notes-sidebar\{[^}]*display:grid[^}]*min-height:0[^}]*min-width:0/);
  assert.match(styles, /\.notes-sidebar\{[^}]*grid-template-rows:auto minmax\(0,1fr\)/);
  assert.match(styles, /\.notes-list\{[^}]*min-height:0[^}]*overflow-y:auto/);
  assert.match(styles, /\.notes-list-row\{[^}]*grid-template-columns:minmax\(0,1fr\) 28px/);
  assert.match(styles, /\.notes-list-remove\{[^}]*height:1\.5rem[^}]*width:1\.5rem/);
  assert.match(styles, /\.notes-empty\{[^}]*height:100%[^}]*min-height:0/);
  assert.match(styles, /\.notes-editor\{[^}]*height:100%[^}]*min-height:0/);
  assert.match(styles, /\.notes-editor\{[^}]*min-width:0[^}]*grid-template-rows:auto auto minmax\(0,1fr\)/);
  assert.match(styles, /\.notes-content\{[^}]*height:100%[^}]*min-height:0[^}]*overflow:hidden/);
  assert.match(styles, /\.notes-content \.cm-editor\{[^}]*height:100%[^}]*min-height:0/);
  assert.match(styles, /\.notes-content \.cm-scroller\{[^}]*min-height:0[^}]*overflow:auto/);
  assert.match(styles, /\.notes-editor-toolbar \.notes-language-select\{[^}]*width:8rem[^}]*flex-shrink:0/);
  assert.match(styles, /\.notes-editor-toolbar \.notes-name-input\{[^}]*width:auto/);
});

test('Settings stays at the bottom of the navigation rail and exposes compact MinIO bucket controls', async () => {
  const { html, styles, renderer, notesPage, settingsDialog, preload, main } = await readIntegrationFiles();

  assert.match(html, /<nav id="nav-rail"[\s\S]*?id="nav-settings-btn"[\s\S]*?<\/nav>/);
  assert.match(html, /id="nav-settings-btn"[^>]*aria-label="Settings"/);
  assert.match(styles, /\.nav-settings-button\{margin-top:auto;order:99\}/);
  assert.match(styles, /\.host-dialog\.settings-dialog\{width:min\(540px,calc\(100vw - 32px\)\)/);
  assert.match(html, /id="settings-dialog"/);
  assert.match(html, /id="s3-endpoint"[^>]*placeholder="https:\/\/s3\.example\.com\/bucket"/);
  assert.doesNotMatch(html, /id="s3-sync-version"|Sync format/i);
  assert.match(html, /id="s3-access-key"[^>]*type="password"/);
  assert.match(html, /id="s3-secret-key"[^>]*type="password"/);
  assert.match(html, /<label for="s3-access-key">Access Key ID<\/label>[\s\S]*?id="s3-access-key-visibility"[^>]*type="button"[^>]*aria-label="Show Access Key ID"[^>]*aria-controls="s3-access-key"[^>]*aria-pressed="false"/);
  assert.match(html, /<label for="s3-secret-key">Secret Access Key<\/label>[\s\S]*?id="s3-secret-key-visibility"[^>]*type="button"[^>]*aria-label="Show Secret Access Key"[^>]*aria-controls="s3-secret-key"[^>]*aria-pressed="false"/);
  assert.match(styles, /\.settings-password-control\{[^}]*position:relative/);
  assert.match(styles, /\.settings-password-toggle\{[^}]*position:absolute/);
  assert.match(styles, /\.settings-password-toggle\[aria-pressed=true\]/);
  assert.match(html, /id="settings-sync-btn"[^>]*>Sync Now<\/button>/);

  assert.match(preload, /getS3SyncSettings:\s*\(\)\s*=>\s*[^\n]*invoke\('settings:s3:get'\)/);
  assert.match(preload, /saveS3SyncSettings:\s*\(draft\)\s*=>\s*[^\n]*invoke\('settings:s3:save', draft\)/);
  assert.match(preload, /revealS3SyncCredentials:\s*\(\)\s*=>\s*[^\n]*invoke\('settings:s3:reveal-credentials'\)/);
  assert.match(preload, /syncAllDataToS3:\s*\(\)\s*=>\s*[^\n]*invoke\('settings:s3:sync'\)/);
  assert.match(preload, /exposeInMainWorld\('settingsApi', settingsApi\)/);
  for (const handler of ['s3SettingsGet', 's3SettingsSave', 's3SettingsReveal', 's3Sync']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\(IPC_CHANNELS\\.${handler}`));
  }
  assert.match(renderer, /registerSettingsDialog\(\)/);
  assert.match(settingsDialog, /window\.settingsApi\.syncAllDataToS3\(\)/);
  assert.match(settingsDialog, /await flushNotesPage\(\);[\s\S]*?saveS3SyncSettings\(currentDraft\(\)\)[\s\S]*?syncAllDataToS3\(\)/);
  assert.match(notesPage, /await Promise\.all\([\s\S]*?if \(this\.notes\.some\([\s\S]*?throw new Error\('Some notes could not be saved\./);
  assert.match(settingsDialog, /endpointInput\.disabled = next/);
  assert.match(settingsDialog, /if \(busy \|\| credentialRevealPending\)\s*return/);
  assert.match(settingsDialog, /!clearCredentials && accessKeyId/);
  assert.match(settingsDialog, /!clearCredentials && secretAccessKey/);
});

test('Settings hydrates saved credentials as masked values and reveals only the selected field', async () => {
  const { settingsDialog } = await readIntegrationFiles();
  const renderStart = settingsDialog.indexOf('function renderSettings(');
  const renderEnd = settingsDialog.indexOf('function currentDraft', renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const renderSettings = settingsDialog.slice(renderStart, renderEnd);

  assert.match(renderSettings, /hasCredentials = settings\.hasCredentials/);
  assert.match(renderSettings, /if \(clearCredentialInputs \|\| !settings\.hasCredentials\)/);
  assert.match(renderSettings, /accessKeyInput\.value = ''/);
  assert.match(renderSettings, /secretKeyInput\.value = ''/);
  assert.doesNotMatch(renderSettings, /settings\.(?:accessKeyId|secretAccessKey|credentials)/);
  assert.doesNotMatch(settingsDialog, /accessKeyInput\.value\s*=\s*settings\./);
  assert.doesNotMatch(settingsDialog, /secretKeyInput\.value\s*=\s*settings\./);

  assert.match(settingsDialog, /const show = control\.input\.type === 'password'/);
  assert.match(settingsDialog, /if \(show && !control\.input\.value && hasCredentials\)[\s\S]*?await window\.settingsApi\.revealS3SyncCredentials\(\)/);
  assert.match(settingsDialog, /accessKeyInput\.value = credentials\.accessKeyId/);
  assert.match(settingsDialog, /secretKeyInput\.value = credentials\.secretAccessKey/);
  assert.match(settingsDialog, /control\.input\.type = visible \? 'text' : 'password'/);
  assert.match(settingsDialog, /control\.button\.setAttribute\('aria-pressed', String\(visible\)\)/);
  assert.match(settingsDialog, /const label = `\$\{visible \? 'Hide' : 'Show'\} \$\{control\.label\}`/);
  assert.match(settingsDialog, /control\.button\.setAttribute\('aria-label', label\)/);
  assert.match(settingsDialog, /const locked = busy \|\| credentialRevealPending/);
  assert.match(settingsDialog, /closeButton\.disabled = locked/);
  assert.match(settingsDialog, /if \(settings\.hasCredentials && \(!accessKeyInput\.value \|\| !secretKeyInput\.value\)\)[\s\S]*?await revealSavedCredentials\(\)/);
  assert.match(settingsDialog, /if \(show\)[\s\S]*?other !== control[\s\S]*?setCredentialVisibility\(other, false\)/);
  assert.match(settingsDialog, /dialog\.addEventListener\('close', maskCredentials\)/);
  assert.match(settingsDialog, /renderSettings\(settings, action === 'clear'\)/);
  assert.match(settingsDialog, /currentDraft\(action === 'clear'\)/);
});

test('normal and signal shutdown flush Notes and stop S3 sync through the shared coordinator', async () => {
  const { main } = await readIntegrationFiles();
  const shutdownStart = main.indexOf('async function shutdownRuntimesForQuit()');
  const shutdownEnd = main.indexOf('function requestQuitAfterRuntimeShutdown', shutdownStart);
  assert.ok(shutdownStart >= 0 && shutdownEnd > shutdownStart);
  const shutdown = main.slice(shutdownStart, shutdownEnd);

  assert.match(shutdown, /Promise\.resolve\(\)\.then\(\(\) => notesStore\?\.flush\(\)\)/);
  assert.match(shutdown, /await flushRendererNotes\(\);[\s\S]*?notesStore\?\.flush\(\)/);
  assert.match(shutdown, /Promise\.resolve\(\)\.then\(\(\) => s3SyncRuntime\?\.shutdown\(\)\)/);
  assert.match(main, /window\.on\('close',[\s\S]*?event\.preventDefault\(\)[\s\S]*?requestQuitAfterRuntimeShutdown\(\)/);
  assert.match(main, /ipcMain\.on\(IPC_CHANNELS\.notesFlushResult/);
  assert.match(main, /cleanup:\s*shutdownRuntimesForQuit/);
  assert.match(main, /process\.once\('SIGINT'[\s\S]*?requestQuitAfterRuntimeShutdown\(true\)/);
  assert.match(main, /process\.once\('SIGTERM'[\s\S]*?requestQuitAfterRuntimeShutdown\(true\)/);
});
