const assert = require('node:assert/strict');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const distRoot = path.join(__dirname, '..', 'dist');
const rendererRoot = path.join(distRoot, 'renderer');
const mainRoot = path.join(distRoot, 'main');
const projectRoot = path.join(__dirname, '..');

async function readIntegrationFiles() {
  const [html, styles, baseStyles, renderer, notesPage, codeMirrorVendor, settingsDialog, preload, main] = await Promise.all([
    readFile(path.join(rendererRoot, 'index.html'), 'utf8'),
    readFile(path.join(rendererRoot, 'tailwind.css'), 'utf8'),
    readFile(path.join(rendererRoot, 'styles.css'), 'utf8'),
    readFile(path.join(rendererRoot, 'renderer.js'), 'utf8'),
    readFile(path.join(rendererRoot, 'notesPage.js'), 'utf8'),
    readFile(path.join(rendererRoot, 'vendor', 'codemirror.js'), 'utf8'),
    readFile(path.join(rendererRoot, 'settingsDialog.js'), 'utf8'),
    readFile(path.join(mainRoot, 'preload.js'), 'utf8'),
    readFile(path.join(mainRoot, 'main.js'), 'utf8'),
  ]);
  return { html, styles, baseStyles, renderer, notesPage, codeMirrorVendor, settingsDialog, preload, main };
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
  for (const language of ['markdown', 'bash', 'javascript', 'typescript', 'sql', 'json', 'yaml', 'text']) {
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
  const singleInstanceLock = main.indexOf('requestSingleInstanceLock()');
  const notesStoreInitialization = main.indexOf('new notesStore_1.NotesStore');
  assert.ok(singleInstanceLock >= 0 && notesStoreInitialization > singleInstanceLock);
  assert.match(main, /app\.on\('second-instance'/);
  assert.match(main, /new notesStore_1\.NotesStore\([^\n]*join\([^\n]*getPath\('userData'\), 'notes'\)\)/);
  assert.match(main, /noteTombstones: activeNotesStore\.exportTombstones\(\)/);
  assert.match(main, /replaceSnapshot\(staged\.notes, staged\.noteTombstones\)/);
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

test('Notes uses the full available width with a bounded responsive sidebar and independent scrolling', async () => {
  const { html, styles, baseStyles } = await readIntegrationFiles();

  assert.match(html, /<section class="notes-page"[^>]*>[\s\S]*?<aside class="notes-sidebar">[\s\S]*?<section class="notes-workspace"/);
  assert.match(styles, /\.app-shell\[data-page=notes\]\{[^}]*margin-left:0[^}]*margin-right:0[^}]*max-width:none[^}]*height:100dvh[^}]*max-height:100dvh[^}]*overflow:hidden/);
  assert.match(styles, /\.notes-page\{[^}]*overflow:hidden[^}]*grid-template-columns:clamp\(240px,22vw,360px\) minmax\(0,1fr\)/);
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
  assert.match(styles, /@media \(max-width:640px\)\{\.notes-page\{[^}]*grid-template-columns:minmax\(190px,220px\) minmax\(280px,1fr\)[^}]*overflow-x:auto/);
  assert.match(baseStyles, /@font-face\s*\{[^}]*font-family:\s*'STM Notes UI'[^}]*notes-ui-variable\.woff2[^}]*font-weight:\s*100 900/);
  assert.match(baseStyles, /@font-face\s*\{[^}]*font-family:\s*'STM Notes Code'[^}]*notes-code-variable\.woff2[^}]*font-weight:\s*100 800/);
  assert.match(baseStyles, /--font-family-notes-ui:\s*'STM Notes UI',\s*'STM UI',\s*sans-serif/);
  assert.match(baseStyles, /--font-family-notes-code:\s*'STM Notes Code',\s*'STM Notes UI',\s*monospace/);
  assert.match(styles, /\.app-shell\[data-page=notes\][^{]*\{[^}]*font-family:var\(--font-family-notes-ui\)/);
  assert.match(styles, /\.notes-content \.cm-editor\{[^}]*font-size:14px[^}]*font-family:var\(--font-family-notes-code\)[^}]*font-variant-ligatures:none/);
  assert.match(styles, /\.notes-content \.cm-scroller\{[^}]*overflow:auto[^}]*font-family:var\(--font-family-notes-code\)/);
});

test('Notes local UI and code fonts are packaged with their licenses', async () => {
  const fontRoot = path.join(projectRoot, 'assets', 'fonts');
  const [uiFont, codeFont, uiLicense, codeLicense, packageJson] = await Promise.all([
    stat(path.join(fontRoot, 'notes-ui-variable.woff2')),
    stat(path.join(fontRoot, 'notes-code-variable.woff2')),
    readFile(path.join(fontRoot, 'OFL-NotoSansCJK.txt'), 'utf8'),
    readFile(path.join(fontRoot, 'OFL-JetBrainsMono.txt'), 'utf8'),
    readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
  ]);

  assert.ok(uiFont.size > 1_000_000);
  assert.ok(codeFont.size > 50_000);
  assert.match(uiLicense, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(codeLicense, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.ok(packageJson.build.files.includes('assets/**/*'));
});

test('Settings stays at the bottom of the navigation rail and exposes compact MinIO endpoint and bucket controls', async () => {
  const { html, styles, renderer, notesPage, settingsDialog, preload, main } = await readIntegrationFiles();

  assert.match(html, /<nav id="nav-rail"[\s\S]*?id="nav-settings-btn"[\s\S]*?<\/nav>/);
  assert.match(html, /id="nav-settings-btn"[^>]*aria-label="Settings"/);
  assert.match(styles, /\.nav-settings-button\{margin-top:auto;order:99\}/);
  assert.match(styles, /\.host-dialog\.settings-dialog\{width:min\(540px,calc\(100vw - 32px\)\)/);
  assert.match(html, /id="settings-dialog"/);
  assert.match(html, /id="s3-endpoint"[^>]*placeholder="https:\/\/s3\.example\.com"/);
  assert.match(html, /id="s3-bucket"[^>]*placeholder="service-manager"/);
  assert.doesNotMatch(html, /id="s3-sync-version"|Sync format/i);
  assert.match(html, /id="s3-access-key"[^>]*type="password"/);
  assert.match(html, /id="s3-secret-key"[^>]*type="password"/);
  assert.match(html, /<label for="s3-sync-encryption-key">Sync Encryption Key<\/label>[\s\S]*?id="s3-sync-encryption-key"[^>]*type="password"/);
  assert.match(html, /id="s3-sync-encryption-key-visibility"[^>]*aria-label="Show Sync Encryption Key"/);
  assert.match(html, /id="s3-sync-encryption-key-copy"[^>]*aria-label="Copy Sync Encryption Key"/);
  assert.doesNotMatch(html, /Independent from AK\/SK|Cloud data is authoritative while online/);
  assert.match(html, /<label for="s3-access-key">Access Key ID<\/label>[\s\S]*?id="s3-access-key-visibility"[^>]*type="button"[^>]*aria-label="Show Access Key ID"[^>]*aria-controls="s3-access-key"[^>]*aria-pressed="false"/);
  assert.match(html, /<label for="s3-secret-key">Secret Access Key<\/label>[\s\S]*?id="s3-secret-key-visibility"[^>]*type="button"[^>]*aria-label="Show Secret Access Key"[^>]*aria-controls="s3-secret-key"[^>]*aria-pressed="false"/);
  assert.match(styles, /\.settings-password-control\{[^}]*position:relative/);
  assert.match(styles, /\.settings-password-toggle\{[^}]*position:absolute[^}]*top:0[^}]*bottom:0[^}]*width:2\.25rem/);
  assert.match(styles, /\.settings-password-toggle svg\{[^}]*display:block[^}]*height:1\.25rem[^}]*width:1\.25rem/);
  assert.match(styles, /\.settings-password-toggle\[aria-pressed=true\]/);
  assert.match(html, /id="settings-sync-btn"[^>]*>Sync Now<\/button>/);

  assert.match(preload, /getS3SyncSettings:\s*\(\)\s*=>\s*[^\n]*invoke\('settings:s3:get'\)/);
  assert.match(preload, /saveS3SyncSettings:\s*\(draft\)\s*=>\s*[^\n]*invoke\('settings:s3:save', draft\)/);
  assert.match(preload, /revealS3SyncCredentials:\s*\(\)\s*=>\s*[^\n]*invoke\('settings:s3:reveal-credentials'\)/);
  assert.match(preload, /syncAllDataToS3:\s*\(\)\s*=>\s*[^\n]*invoke\('settings:s3:sync'\)/);
  assert.match(preload, /onS3SyncStateChanged:\s*\(listener\)\s*=>\s*\{[\s\S]*?ipcRenderer\.on\('settings:s3:state', wrapped\)[\s\S]*?removeListener\('settings:s3:state', wrapped\)/);
  assert.match(preload, /onPersistentDataReloaded:\s*\(listener\)\s*=>\s*\{[\s\S]*?ipcRenderer\.on\('app:persistent-data-reloaded', wrapped\)[\s\S]*?removeListener\('app:persistent-data-reloaded', wrapped\)/);
  assert.match(preload, /exposeInMainWorld\('settingsApi', settingsApi\)/);
  for (const handler of ['s3SettingsGet', 's3SettingsSave', 's3SettingsReveal', 's3Sync']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\(IPC_CHANNELS\\.${handler}`));
  }
  assert.match(renderer, /registerSettingsDialog\(\)/);
  assert.match(renderer, /window\.settingsApi\.onPersistentDataReloaded\(\(\)\s*=>\s*\{[\s\S]*?Promise\.all\(\[loadHosts\(\), reloadNotesPage\(\)\]\)/);
  assert.match(settingsDialog, /window\.settingsApi\.syncAllDataToS3\(\)/);
  assert.match(settingsDialog, /window\.settingsApi\.onS3SyncStateChanged\(renderSyncState\)/);
  assert.match(settingsDialog, /bucketInput\.value = settings\.bucket/);
  assert.match(settingsDialog, /bucket:\s*bucketInput\.value\.trim\(\)/);
  assert.match(settingsDialog, /await flushNotesPage\(\);[\s\S]*?saveS3SyncSettings\(currentDraft\(\)\)[\s\S]*?syncAllDataToS3\(\)/);
  assert.match(notesPage, /await Promise\.all\([\s\S]*?if \(this\.notes\.some\([\s\S]*?throw new Error\('Some notes could not be saved\./);
  assert.match(settingsDialog, /endpointInput\.disabled = next/);
  assert.match(settingsDialog, /bucketInput\.disabled = next/);
  assert.match(settingsDialog, /if \(busy \|\| credentialRevealPending\)\s*return/);
  assert.match(settingsDialog, /\.\.\.\(accessKeyId \? \{ accessKeyId \} : \{\}\)/);
  assert.match(settingsDialog, /\.\.\.\(secretAccessKey \? \{ secretAccessKey \} : \{\}\)/);
});

test('Settings hydrates saved credentials as masked values and reveals only the selected field', async () => {
  const { settingsDialog } = await readIntegrationFiles();
  const renderStart = settingsDialog.indexOf('function renderSettings(');
  const renderEnd = settingsDialog.indexOf('function currentDraft', renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const renderSettings = settingsDialog.slice(renderStart, renderEnd);

  assert.match(renderSettings, /hasCredentials = settings\.hasCredentials/);
  assert.match(renderSettings, /hasSyncEncryptionKey = settings\.hasSyncEncryptionKey/);
  assert.match(renderSettings, /if \(clearCredentialInputs \|\| !settings\.hasCredentials\)/);
  assert.match(renderSettings, /accessKeyInput\.value = ''/);
  assert.match(renderSettings, /secretKeyInput\.value = ''/);
  assert.doesNotMatch(renderSettings, /settings\.(?:accessKeyId|secretAccessKey|credentials)/);
  assert.doesNotMatch(settingsDialog, /accessKeyInput\.value\s*=\s*settings\./);
  assert.doesNotMatch(settingsDialog, /secretKeyInput\.value\s*=\s*settings\./);

  assert.match(settingsDialog, /const show = control\.input\.type === 'password'/);
  assert.match(settingsDialog, /if \(show && !control\.input\.value && control\.hasSavedValue\(\)\)[\s\S]*?await revealSavedCredentials\(\)/);
  assert.match(settingsDialog, /accessKeyInput\.value = credentials\.accessKeyId/);
  assert.match(settingsDialog, /secretKeyInput\.value = credentials\.secretAccessKey/);
  assert.match(settingsDialog, /control\.input\.type = visible \? 'text' : 'password'/);
  assert.match(settingsDialog, /control\.button\.setAttribute\('aria-pressed', String\(visible\)\)/);
  assert.match(settingsDialog, /const label = `\$\{visible \? 'Hide' : 'Show'\} \$\{control\.label\}`/);
  assert.match(settingsDialog, /control\.button\.setAttribute\('aria-label', label\)/);
  assert.match(settingsDialog, /const locked = busy \|\| credentialRevealPending/);
  assert.match(settingsDialog, /closeButton\.disabled = locked/);
  assert.match(settingsDialog, /settings\.hasCredentials && \(!accessKeyInput\.value \|\| !secretKeyInput\.value\)[\s\S]*?settings\.hasSyncEncryptionKey && !syncEncryptionKeyInput\.value[\s\S]*?await revealSavedCredentials\(\)/);
  assert.match(settingsDialog, /syncEncryptionKeyInput\.value = credentials\.syncEncryptionKey/);
  assert.match(settingsDialog, /const syncEncryptionKey = syncEncryptionKeyInput\.value\.trim\(\)[\s\S]*?\{ syncEncryptionKey \}/);
  assert.match(settingsDialog, /writeClipboardText\(syncEncryptionKeyInput\.value\)/);
  assert.match(settingsDialog, /function renderSettingsWithAuthoritativeSyncKey[\s\S]*?syncEncryptionKeyInput\.value = ''[\s\S]*?renderSettings\(settings, clearCredentialInputs\)[\s\S]*?await revealSavedCredentials\(\)/);
  assert.match(settingsDialog, /action === 'clear'[\s\S]*?getS3SyncSettings\(\)[\s\S]*?clearCredentials: true[\s\S]*?saveS3SyncSettings\(draft\)[\s\S]*?renderSettingsWithAuthoritativeSyncKey\(settings, action === 'clear'\)/);
  assert.match(settingsDialog, /saveS3SyncSettings\(currentDraft\(\)\)[\s\S]*?syncAllDataToS3\(\)[\s\S]*?renderSettingsWithAuthoritativeSyncKey\(await window\.settingsApi\.getS3SyncSettings\(\)\)/);
  assert.match(settingsDialog, /if \(show\)[\s\S]*?other !== control[\s\S]*?setCredentialVisibility\(other, false\)/);
  assert.match(settingsDialog, /dialog\.addEventListener\('close', maskCredentials\)/);
  assert.match(settingsDialog, /renderSettingsWithAuthoritativeSyncKey\(settings, action === 'clear'\)/);
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
