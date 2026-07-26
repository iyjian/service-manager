const assert = require('node:assert/strict');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const distRoot = path.join(__dirname, '..', 'dist');
const rendererRoot = path.join(distRoot, 'renderer');
const mainRoot = path.join(distRoot, 'main');
const projectRoot = path.join(__dirname, '..');

async function readIntegrationFiles() {
  const [html, styles, baseStyles, renderer, notesPage, codeMirrorVendor, settingsDialog, preload, main, notesStore] = await Promise.all([
    readFile(path.join(rendererRoot, 'index.html'), 'utf8'),
    readFile(path.join(rendererRoot, 'tailwind.css'), 'utf8'),
    readFile(path.join(rendererRoot, 'styles.css'), 'utf8'),
    readFile(path.join(rendererRoot, 'renderer.js'), 'utf8'),
    readFile(path.join(rendererRoot, 'notesPage.js'), 'utf8'),
    readFile(path.join(rendererRoot, 'vendor', 'codemirror.js'), 'utf8'),
    readFile(path.join(rendererRoot, 'settingsDialog.js'), 'utf8'),
    readFile(path.join(mainRoot, 'preload.js'), 'utf8'),
    readFile(path.join(mainRoot, 'main.js'), 'utf8'),
    readFile(path.join(mainRoot, 'notesStore.js'), 'utf8'),
  ]);
  return { html, styles, baseStyles, renderer, notesPage, codeMirrorVendor, settingsDialog, preload, main, notesStore };
}

test('compiled Notes page and bridge expose the hierarchical local workspace flow', async () => {
  const { html, styles, renderer, notesPage, codeMirrorVendor, preload, main, notesStore } = await readIntegrationFiles();

  assert.match(html, /<main class="app-shell hidden" data-page="notes">/);
  assert.match(html, /id="notes-search"[^>]*type="search"/);
  assert.match(html, /id="note-name"/);
  assert.match(html, /<div id="note-content" class="notes-content"[^>]*>[\s\S]*?id="note-code-content"[\s\S]*?id="note-richtext-editor"/);
  assert.match(html, /id="note-richtext-toolbar"[\s\S]*?data-richtext-block-trigger[\s\S]*?data-richtext-link-trigger[\s\S]*?>Link<[\s\S]*?data-richtext-command="math"[\s\S]*?data-richtext-command="bold"[\s\S]*?data-richtext-command="underline"[\s\S]*?data-richtext-color-trigger/);
  assert.doesNotMatch(html, /Ask AI|data-richtext-ai/);
  assert.match(html, /id="note-richtext-image-input"[^>]*accept="image\/png,image\/jpeg,image\/webp"/);
  assert.doesNotMatch(html, /id="note-tags"|notes-tags-row|Tags, comma separated/);
  assert.match(html, /id="note-save-status"[^>]*class="notes-save-announcement"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.doesNotMatch(html, /notes-editor-toolbar[\s\S]*?id="note-save-status"[\s\S]*?id="note-copy-btn"/);
  assert.match(html, /id="note-copy-btn"/);
  assert.match(html, /id="notes-new-root-btn"[^>]*class="notes-tree-root-add"[^>]*aria-label="New root Note"[\s\S]*?<svg/);
  assert.match(html, /id="notes-list"[^>]*aria-label="Notes tree"/);
  assert.doesNotMatch(html, /Notes\s+Local snippets\s+New Note/);
  assert.match(html, /id="note-copy-btn"[\s\S]*?<svg[\s\S]*?id="note-copy-label">Copy<\/span>/);
  assert.doesNotMatch(html, /id="note-delete-btn"/);
  assert.match(styles, /\.notes-list-save-indicator[\s\S]*?width:\s*5px/);
  assert.match(styles, /\.notes-list-save-indicator\[data-state=error\]/);
  assert.match(styles, /\.notes-list-save-label\{[^}]*position:absolute[^}]*width:1px/);
  assert.match(notesPage, /noteSaveIndicatorState\(this\.isDirty\(note\.id\), this\.saveErrorNoteIds\.has\(note\.id\)\)/);
  assert.match(notesPage, /if \(this\.selectedId === note\.id\)\s*this\.setSaveStatus\('Saving…', 'saving'\)/);
  assert.match(notesPage, /saveLabel\.textContent = state === 'error' \? 'Save failed' : 'Saving'/);
  assert.match(notesPage, /if \(!wasDirty \|\| hadSaveError\)\s*this\.updateListSaveIndicator\(note\.id\)[\s\S]*?if \(refreshSearchResults\)\s*this\.queueSearchRender\(\)/);
  assert.match(notesPage, /if \(!this\.deletedIds\.has\(id\)\) \{[\s\S]*?this\.saveErrorNoteIds\.add\(id\)[\s\S]*?if \(this\.selectedId === id\)/);
  assert.ok((notesPage.match(/this\.updateListSaveIndicator\(id\)/g) ?? []).length >= 2);
  assert.match(notesPage, /normalizedNameChanged = current\.name !== saved\.name[\s\S]*?if \(normalizedNameChanged && current\) \{[\s\S]*?this\.updateListNoteName\(current\)[\s\S]*?this\.queueSearchRender\(\)[\s\S]*?\}\s*this\.updateListSaveIndicator\(id\)/);
  assert.match(notesPage, /if \(this\.saveStatus\.textContent === text && this\.saveStatus\.dataset\.state === state\)\s*return/);
  assert.match(html, /<script type="importmap">[\s\S]*?"codemirror": "\.\/vendor\/codemirror\.js"/);
  assert.match(
    html,
    /id="note-language-toggle"[\s\S]*?aria-haspopup="dialog"[\s\S]*?aria-controls="note-language-menu"[\s\S]*?aria-expanded="false"/,
  );
  assert.match(html, /id="note-language-search"[^>]*type="search"[^>]*aria-controls="note-language-options"/);
  assert.match(html, /id="note-language-options"[^>]*role="listbox"[^>]*aria-label="Language choices"/);
  assert.doesNotMatch(html, /<select id="note-language"/);
  assert.match(notesPage, /\{ value: 'richtext', label: 'Rich Text'[\s\S]*?\{ value: 'markdown', label: 'Markdown'/);
  for (const language of ['richtext', 'markdown', 'bash', 'javascript', 'typescript', 'sql', 'json', 'yaml', 'text']) {
    assert.match(notesPage, new RegExp(`value: '${language}'`));
  }
  assert.match(notesPage, /filterNoteLanguageOptions\(query\)[\s\S]*?terms\.every\(\(term\) => searchable\.includes\(term\)\)/);
  assert.match(notesPage, /handleLanguageMenuKeyDown\(event\)[\s\S]*?ArrowDown[\s\S]*?ArrowUp[\s\S]*?Home[\s\S]*?End/);

  assert.match(preload, /listNotes:\s*\(\)\s*=>\s*[^\n]*invoke\('notes:list'\)/);
  assert.match(preload, /getWorkspace:\s*\(\)\s*=>\s*[^\n]*invoke\('notes:workspace'\)/);
  assert.match(preload, /createNote:\s*\(placement\)\s*=>\s*[^\n]*invoke\('notes:create', placement\)/);
  assert.match(preload, /updateNote:\s*\(id, draft, expectedNote\)\s*=>[\s\S]*?invoke\('notes:update', \{ id, draft, expectedNote \}\)/);
  assert.match(preload, /moveNote:\s*\(input\)\s*=>\s*[^\n]*invoke\('notes:move', input\)/);
  assert.match(preload, /setTreeExpanded:\s*\(input\)\s*=>\s*[^\n]*invoke\('notes:tree-expanded', input\)/);
  assert.match(preload, /deleteNote:\s*\(input\)\s*=>\s*[^\n]*invoke\('notes:delete', input\)/);
  assert.match(preload, /recoverDrafts:\s*\(input\)\s*=>\s*[^\n]*invoke\('notes:recover-drafts', input\)/);
  assert.match(preload, /uploadImage:\s*\(input\)\s*=>\s*[^\n]*invoke\('notes:image:upload', input\)/);
  assert.match(preload, /loadImage:\s*\(reference\)\s*=>\s*[^\n]*invoke\('notes:image:load', reference\)/);
  assert.match(preload, /ipcRenderer\.on\('notes:flush-request', handler\)/);
  assert.match(preload, /ipcRenderer\.send\('notes:flush-result', \{ requestId, ok: true \}\)/);
  assert.match(preload, /ipcRenderer\.on\('notes:persistent-apply-release', handler\)/);
  assert.match(preload, /exposeInMainWorld\('notesApi', notesApi\)/);

  for (const handler of [
    'notesList',
    'notesWorkspace',
    'notesCreate',
    'notesUpdate',
    'notesMove',
    'notesTreeExpanded',
    'notesDeletePreview',
    'notesDelete',
    'notesRecoverDrafts',
    'notesImageUpload',
    'notesImageLoad',
  ]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\(IPC_CHANNELS\\.${handler}`));
  }
  const instanceLockProbe = main.indexOf('assertUserDataInstanceLockAvailable');
  const singleInstanceLock = main.indexOf('requestSingleInstanceLock()');
  const durableInstanceLock = main.indexOf('acquireUserDataInstanceLock');
  const notesStoreInitialization = main.indexOf('new notesStore_1.NotesStore');
  assert.ok(
    instanceLockProbe >= 0
      && singleInstanceLock > instanceLockProbe
      && durableInstanceLock > singleInstanceLock
      && notesStoreInitialization > durableInstanceLock,
  );
  assert.match(main, /process\.once\('exit',[\s\S]*releaseUserDataInstanceLock\(\)/);
  assert.match(main, /app\.on\('second-instance'/);
  assert.match(main, /new notesStore_1\.NotesStore\([^\n]*join\([^\n]*getPath\('userData'\), 'notes-v4'\)\)/);
  assert.match(main, /new notesTreeStore_1\.NotesTreeStore\([^\n]*join\([^\n]*getPath\('userData'\), 'notes-tree\.json'\)\)/);
  assert.match(main, /new notesTreeViewStore_1\.NotesTreeViewStore\([^\n]*join\([^\n]*getPath\('userData'\), 'notes-tree-view\.json'\)\)/);
  assert.match(main, /noteTombstones: activeNotesStore\.exportTombstones\(\)/);
  assert.match(main, /notesTree: getNotesTreeStore\(\)\.snapshot\(\)/);
  assert.match(main, /replaceSnapshot\(staged\.notes, staged\.noteTombstones\)/);
  assert.match(main, /getNotesTreeStore\(\)\.replaceSnapshot\(staged\.notesTree, activeNoteIds\)/);
  assert.match(main, /getNotesTreeViewStore\(\)\.replaceActiveIds\(activeNoteIds\)/);
  assert.match(renderer, /registerNotesPage\(\)/);
  assert.match(notesPage, /id:\s*'notes'/);
  assert.match(notesPage, /import \{ basicSetup, EditorView \} from 'codemirror'/);
  assert.match(notesPage, /new EditorView\(\{/);
  assert.match(notesPage, /window\.notesApi\.updateNote\(id, draft, cloneNote\(expectedNote\)\)/);
  assert.match(notesPage, /window\.serviceApi\.writeClipboardText\(content\)/);
  assert.match(notesPage, /new NotesRichTextEditor\(\{/);
  assert.match(html, /"@tiptap\/core": "\.\/vendor\/tiptap-core\.js"/);
  assert.match(preload, /previewNoteDelete:\s*\(id\)\s*=>\s*[^\n]*invoke\('notes:delete-preview', id\)/);
  assert.match(notesPage, /window\.notesApi\.previewNoteDelete\(id\)/);
  assert.match(notesPage, /sameNoteIdSet\(preview\.expectedIds, confirmedPreview\.expectedIds\)/);
  assert.match(notesPage, /Updated deletion scope/);
  assert.match(notesPage, /result\.deletedIds\.length === 1[\s\S]*?'Note deleted\.'[\s\S]*?Notes deleted/);
  assert.match(notesPage, /window\.notesApi\.deleteNote\(\{[\s\S]*?expectedIds: confirmedPreview\.expectedIds/);
  assert.match(notesPage, /result\.status === 'changed'/);
  assert.match(notesPage, /deletingNoteIds = new Set\(\)/);
  assert.match(notesPage, /window\.notesApi\.recoverDrafts\(pending\)/);
  assert.match(notesPage, /expectedNote: cloneNote\(expectedNote\)/);
  assert.match(notesPage, /window\.notesApi\.getWorkspace\(\)/);
  assert.match(notesPage, /window\.notesApi\.createNote\(\{ parentId \}\)/);
  assert.match(notesPage, /window\.notesApi\.moveNote\(\{/);
  assert.match(notesPage, /window\.notesApi\.setTreeExpanded\(\{ noteId, expanded \}\)/);
  assert.match(notesPage, /export function visibleNoteTreeRows\(/);
  assert.match(notesPage, /export function noteTreeBreadcrumb\(/);
  assert.match(notesPage, /export function resolveNoteTreeDropPlacement\(/);
  assert.match(notesPage, /await this\.flushAllPendingSaves\(\);[\s\S]*?const editVersionBaseline = new Map\(this\.editVersions\)[\s\S]*?this\.applyWorkspace\(workspace, editVersionBaseline\)/);
  assert.match(notesPage, /This will permanently delete \$\{preview\.expectedIds\.length\} Notes in this subtree\./);
  assert.match(main, /const rendererApply = await prepareRendererNotesPersistentApply\(\)/);
  assert.match(main, /publishPersistentDataReload\('s3', rendererApply\)/);
  assert.match(main, /if \(!reloadOwnsRelease\)\s+releaseRendererNotesPersistentApply\(rendererApply\)/);
  assert.match(main, /sameNoteIds\(deletedIds, input\.expectedIds\)/);
  assert.match(main, /status: 'changed'[\s\S]*?preview: noteDeletePreview\(input\.id\)/);
  assert.match(main, /getNotesStore\(\)\.deleteMany\(deletedIds\)/);
  assert.match(main, /if \(!activeIds\.includes\(input\.noteId\)\) \{\s*return getNotesTreeViewStore\(\)\.snapshot\(\)\.expandedNoteIds;/);
  const deleteHandlerStart = main.indexOf('ipcMain.handle(IPC_CHANNELS.notesDelete,');
  const deleteHandlerEnd = main.indexOf('ipcMain.handle(IPC_CHANNELS.notesRecoverDrafts,', deleteHandlerStart);
  assert.ok(deleteHandlerStart >= 0 && deleteHandlerEnd > deleteHandlerStart);
  const deleteHandler = main.slice(deleteHandlerStart, deleteHandlerEnd);
  assert.doesNotMatch(deleteHandler, /getNotesStore\(\)\.replaceSnapshot\(/);
  assert.doesNotMatch(main, /The Notes tree changed after confirmation/);
  assert.match(main, /getNotesStore\(\)\.compareAndUpdate\(id, expectedNote, draft\)/);
  assert.match(notesStore, /This Note changed after the editor loaded it/);
  assert.match(main, /classifyNoteDraftRecovery\)\(current, recovery\.expectedNote, recovery\.draft\)/);
  assert.match(main, /decision === 'already-saved'/);
  assert.match(main, /decision === 'update'/);
  assert.match(main, /runS3SharedDataMutation\(async \(\) => notesWorkspaceSnapshot\(\)\)/);
  assert.match(notesPage, /className = 'notes-list-remove'/);
  assert.match(notesPage, /className = 'notes-tree-add'/);
  assert.match(notesPage, /row\.draggable = true/);
  assert.match(notesPage, /handleListKeydown\(event\)/);
  assert.match(codeMirrorVendor, /const basicSetup/);
});

test('compiled Notes exposes file cards, the six-dot command handle, and PDF or Markdown downloads', async () => {
  const { html, styles, renderer, notesPage, preload, main } = await readIntegrationFiles();
  const richTextEditor = await readFile(path.join(rendererRoot, 'notesRichTextEditor.js'), 'utf8');

  assert.match(html, /id="note-copy-btn"[\s\S]*?id="note-download-btn"/);
  assert.match(html, /id="note-download-btn"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
  assert.match(html, /id="note-download-menu"[^>]*role="menu"[^>]*aria-label="Download Note"[\s\S]*?data-note-export-format="pdf"[\s\S]*?data-note-export-format="markdown"/);
  assert.match(html, /id="note-richtext-attachment-input"[^>]*type="file"[^>]*aria-hidden="true"/);
  assert.match(html, /id="note-attachment-preview-dialog"[^>]*aria-labelledby="note-attachment-preview-title"[^>]*aria-describedby="note-attachment-preview-meta"/);
  const previewFrame = html.match(/<iframe\s+id="note-attachment-preview-pdf"[\s\S]*?<\/iframe>/)?.[0] ?? '';
  assert.match(previewFrame, /referrerpolicy="no-referrer"/);
  assert.doesNotMatch(previewFrame, /sandbox=/);
  assert.match(html, /id="note-attachment-preview-text"[^>]*tabindex="0"[^>]*role="document"/);
  assert.match(styles, /\.notes-download-menu\{[^}]*position:absolute[^}]*z-index:50[^}]*display:grid/);
  assert.match(styles, /\.notes-richtext-block-handle\{[^}]*display:inline-flex[^}]*height:1\.75rem[^}]*width:1\.25rem[^}]*align-items:center[^}]*justify-content:center[^}]*border-width:0[^}]*background-color:transparent/);
  assert.match(styles, /\.notes-richtext-block-handle>svg\{[^}]*height:18px[^}]*width:18px[^}]*flex-shrink:0/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror \.notes-richtext-attachment\{[^}]*display:grid[^}]*align-items:center/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror \.notes-richtext-attachment\{[^}]*min-height:60px[^}]*border-color:rgb\(212 212 216[^}]*background-color:rgb\(244 244 245/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror \.notes-richtext-attachment\{[^}]*-webkit-user-select:none[^}]*user-select:none/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror \.notes-richtext-attachment\{[^}]*grid-template-columns:36px minmax\(0,1fr\)[^}]*max-width:100%[^}]*width:270px/);
  assert.match(styles, /\.notes-richtext-attachment-type\{[^}]*height:2\.25rem[^}]*width:2\.25rem/);
  assert.match(styles, /\.notes-richtext-attachment-type-image\{[^}]*height:100%[^}]*width:100%[^}]*object-fit:contain[^}]*pointer-events:none/);
  assert.match(styles, /\.notes-richtext-attachment-action\{[^}]*height:1\.75rem[^}]*width:1\.75rem/);
  assert.match(styles, /\.notes-richtext-attachment-actions\{[^}]*display:flex/);
  assert.match(styles, /\.notes-richtext-attachment-footer\{[^}]*margin-top:auto[^}]*display:flex[^}]*align-items:center[^}]*justify-content:flex-end/);
  assert.match(styles, /\.note-attachment-preview-dialog\{[^}]*height:min\(78vh,720px\)[^}]*width:min\(920px,calc\(100vw - 32px\)\)/);
  assert.match(html, /id="page-message-text"[^>]*type="button"[^>]*class="message-text"[^>]*disabled/);
  assert.match(styles, /\.message-toast\[data-actionable=true\] \.message-text\{[^}]*cursor:pointer[^}]*text-decoration-line:underline/);

  assert.match(richTextEditor, /title: 'File',[\s\S]*?requestAttachment\(undefined, range\.from\)/);
  assert.match(richTextEditor, /class NotesRichTextBlockHandle[\s\S]*?createElementNS\('http:\/\/www\.w3\.org\/2000\/svg', 'svg'\)[\s\S]*?viewBox', '0 0 20 20'/);
  assert.match(richTextEditor, /writingLeft - buttonBounds\.width - 4/);
  assert.match(richTextEditor, /className = 'notes-richtext-attachment'/);
  assert.match(richTextEditor, /NOTE_ATTACHMENT_ICON_SOURCES = \{[\s\S]*?pdf: '\.\.\/\.\.\/assets\/note-file-icons\/pdf\.svg'[\s\S]*?file: '\.\.\/\.\.\/assets\/note-file-icons\/file\.svg'/);
  assert.match(richTextEditor, /icon\.replaceChildren\(createAttachmentTypeIcon\(kind\)\)/);
  assert.doesNotMatch(richTextEditor, /pdf: 'PDF'[\s\S]*?document: 'DOC'/);
  assert.match(richTextEditor, /noteAttachmentPreviewKind\(reference\) \? \[createActionButton\('view', reference\)\] : \[\]/);
  assert.match(richTextEditor, /createActionButton\('download', reference\)/);
  assert.match(richTextEditor, /footer\.append\(metadata, actions\)[\s\S]*?copy\.append\(name, footer\)[\s\S]*?dom\.append\(icon, copy\)/);
  assert.match(richTextEditor, /metadata\.textContent = attachmentSize\(reference\.byteLength\)/);
  assert.doesNotMatch(richTextEditor, /metadata\.textContent[^\n]*reference\.mimeType/);
  assert.match(notesPage, /window\.notesApi\.uploadAttachment\(\{/);
  assert.match(notesPage, /window\.notesApi\.exportNote\(\{/);
  assert.match(notesPage, /format !== 'pdf' && format !== 'markdown'/);
  assert.match(notesPage, /result\.canOpen \? `\$\{label\} saved\. Click to open\.`[\s\S]*?result\.canOpen \? 'open-note-export' : undefined/);
  assert.match(notesPage, /attachmentPreviewDialog\.showModal\(\)[\s\S]*?window\.notesApi\.viewAttachment\(reference\)/);
  assert.match(notesPage, /attachmentPreviewText\.textContent = result\.preview\.text/);
  assert.match(notesPage, /URL\.createObjectURL\(new Blob/);
  assert.match(notesPage, /attachmentPreviewPdf\.src = `\$\{objectUrl\}#toolbar=0&navpanes=0`/);
  assert.match(notesPage, /URL\.revokeObjectURL\(this\.attachmentPreviewObjectUrl\)/);

  assert.match(preload, /uploadAttachment:\s*\(input\)\s*=>[^\n]*invoke\('notes:attachment:upload', input\)/);
  assert.match(preload, /viewAttachment:\s*\(reference\)\s*=>[^\n]*invoke\('notes:attachment:view', reference\)/);
  assert.match(preload, /downloadAttachment:\s*\(reference\)\s*=>[^\n]*invoke\('notes:attachment:download', reference\)/);
  assert.match(preload, /exportNote:\s*\(input\)\s*=>[^\n]*invoke\('notes:export', input\)/);
  assert.match(preload, /openLastExport:\s*\(\)\s*=>[^\n]*invoke\('notes:export:open-last'\)/);
  for (const handler of ['notesAttachmentUpload', 'notesAttachmentView', 'notesAttachmentDownload', 'notesExport', 'notesExportOpenLast']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\(IPC_CHANNELS\\.${handler}`));
  }
  const previewHandlerStart = main.indexOf('ipcMain.handle(IPC_CHANNELS.notesAttachmentView');
  const previewHandlerEnd = main.indexOf('ipcMain.handle(IPC_CHANNELS.notesAttachmentDownload', previewHandlerStart);
  assert.ok(previewHandlerStart >= 0 && previewHandlerEnd > previewHandlerStart);
  const previewHandler = main.slice(previewHandlerStart, previewHandlerEnd);
  assert.match(previewHandler, /parseNoteAttachmentReference[\s\S]*?noteAttachmentPreviewKind[\s\S]*?loadNoteAttachment[\s\S]*?createNotesAttachmentPreview/);
  assert.match(previewHandler, /status: 'loaded', preview/);
  assert.doesNotMatch(previewHandler, /shell\.openPath|writeFile|sessionData|path:/);
  assert.doesNotMatch(main, /NOTES_ATTACHMENT_PREVIEW_MAX_FILES|notes-attachment-previews/);
  assert.match(main, /will-frame-navigate[\s\S]*?about:blank[\s\S]*?blob:file:\/\/\/[\s\S]*?preventDefault/);
  assert.match(main, /notesAttachmentDownload[\s\S]*?showSaveDialog[\s\S]*?loadNoteAttachment/);
  assert.match(main, /notesExport[\s\S]*?createSafeNoteFilename\)[\s\S]*?input\.format === 'markdown'[\s\S]*?richTextToMarkdown\)[\s\S]*?renderMarkdownToSafeHtml\)[\s\S]*?richTextToSafeHtml\)/);
  assert.match(main, /NOTE_EXPORT_OPEN_TTL_MS = 60_?000/);
  assert.match(main, /const rendererExportGenerations = new Map\(\)/);
  assert.match(main, /function deleteRecentNoteExport\(senderId\)[\s\S]*?clearTimeout\(target\.timeout\)[\s\S]*?recentNoteExports\.delete\(senderId\)/);
  assert.match(main, /function invalidateRendererExportState\(senderId\)[\s\S]*?rendererExportGenerations\.set\(senderId, generation \+ 1\)/);
  assert.match(main, /registerRecentNoteExport\([\s\S]*?\.extname\([\s\S]*?\.lstat\([\s\S]*?!stats\.isFile\(\) \|\| stats\.isSymbolicLink\(\)/);
  assert.match(main, /registerRecentNoteExport\([\s\S]*?rendererExportGenerations\.get\(senderId\) !== rendererGeneration[\s\S]*?setTimeout\([\s\S]*?NOTE_EXPORT_OPEN_TTL_MS[\s\S]*?timeout\.unref\(\)/);
  assert.match(main, /takeRecentNoteExport\([\s\S]*?deleteRecentNoteExport\(senderId\)[\s\S]*?target\.expiresAt <= Date\.now\(\)[\s\S]*?\.lstat\([\s\S]*?target\.rendererGeneration !== rendererExportGenerations\.get\(senderId\)[\s\S]*?stats\.dev !== target\.device[\s\S]*?stats\.ino !== target\.inode/);
  assert.match(main, /rendererExportGenerations\.set\(rendererId, 0\)[\s\S]*?render-process-gone[\s\S]*?did-start-navigation[\s\S]*?isMainFrame[\s\S]*?invalidateRendererExportState\(rendererId\)/);
  assert.match(main, /notesExport[\s\S]*?const rendererGeneration = rendererExportGenerations\.get\(senderId\)[\s\S]*?registerRecentNoteExport\(\s*senderId,\s*rendererGeneration/);
  assert.match(main, /notesExportOpenLast[\s\S]*?takeRecentNoteExport\(event\.sender\.id\)[\s\S]*?shell\.openPath\(filePath\)[\s\S]*?if \(openError\)[\s\S]*?status: 'opened'/);
  assert.match(renderer, /value\.action === 'open-note-export'[\s\S]*?setMessage\(value\.text, level, action\)/);
  assert.match(renderer, /pageMessageTextElement\.addEventListener\('click'[\s\S]*?const generation = pageMessageGeneration[\s\S]*?notesApi\.openLastExport\(\)[\s\S]*?pageMessageGeneration !== generation[\s\S]*?result\.status === 'opened'/);
  assert.match(main, /NOTES_PDF_RENDER_TIMEOUT_MS = 30_?000/);
  assert.match(main, /NOTES_PDF_MAX_DOCUMENT_BYTES = 6 \* 1024 \* 1024/);
  assert.match(main, /NOTES_PDF_MAX_OUTPUT_BYTES = 64 \* 1024 \* 1024/);
  assert.match(main, /function assertNotePdfComplexity\([\s\S]*?Buffer\.byteLength\([\s\S]*?NOTES_PDF_MAX_STRUCTURAL_BLOCKS[\s\S]*?NOTES_PDF_MAX_TABLE_ROWS[\s\S]*?NOTES_PDF_MAX_APPROXIMATE_PAGES/);
  assert.match(main, /function withNotePdfRenderTimeout\([\s\S]*?Promise\.race\([\s\S]*?NOTES_PDF_RENDER_TIMEOUT_MS[\s\S]*?clearTimeout/);
  assert.match(main, /function runNotePdfExportTask\([\s\S]*?if \(notesPdfExportActive\)[\s\S]*?notesPdfExportActive = true[\s\S]*?finally[\s\S]*?notesPdfExportActive = false/);
  assert.match(main, /const printWindow = new [\s\S]*?BrowserWindow\([\s\S]*?try \{\s*printWindow\.webContents\.setWindowOpenHandler/);
  assert.match(main, /renderNotePdf\([\s\S]*?withNotePdfRenderTimeout\([\s\S]*?loadURL\([\s\S]*?printToPDF\([\s\S]*?Buffer\.isBuffer\(pdf\)[\s\S]*?NOTES_PDF_MAX_OUTPUT_BYTES[\s\S]*?finally[\s\S]*?printWindow\.destroy\(\)/);
  assert.match(main, /return input\.format === 'pdf'[\s\S]*?runNotePdfExportTask\(performExport\)[\s\S]*?performExport\(\)/);
  assert.match(main, /const rendererWindows = new Set\(\)/);
  assert.match(main, /rendererWindows\.add\(window\)[\s\S]*?rendererWindows\.delete\(window\)/);
  assert.match(main, /function rendererNotesWindows\(\) \{\s*return \[\.\.\.rendererWindows\]\.filter/);
  assert.match(main, /function primaryRendererWindow\(\)[\s\S]*?rendererWindows\.has\(focused\)/);
  assert.doesNotMatch(main, /BrowserWindow\.getAllWindows\(\)/);
});

test('Notes shared validators and export tools have distinct CommonJS main and ESM renderer artifacts', async () => {
  const [notesPage, packageManifest, copyMainRuntime, copyRenderer] = await Promise.all([
    readFile(path.join(rendererRoot, 'notesPage.js'), 'utf8'),
    readFile(path.join(projectRoot, 'package.json'), 'utf8'),
    readFile(path.join(projectRoot, 'scripts', 'copy-main-runtime.cjs'), 'utf8'),
    readFile(path.join(projectRoot, 'scripts', 'copy-renderer.cjs'), 'utf8'),
  ]);

  for (const runtime of ['noteRichText', 'noteExport', 'notesMarkdown']) {
    const [sharedRuntime, mainRuntime, rendererRuntime] = await Promise.all([
      readFile(path.join(distRoot, 'shared', `${runtime}.js`), 'utf8'),
      readFile(path.join(mainRoot, `${runtime}.cjs`), 'utf8'),
      readFile(path.join(rendererRoot, `${runtime}.js`), 'utf8'),
    ]);
    assert.match(sharedRuntime, /["']use strict["']/, `${runtime} shared runtime`);
    assert.match(mainRuntime, /["']use strict["']/, `${runtime} main runtime`);
    assert.doesNotMatch(sharedRuntime, /^export\s/m, `${runtime} shared runtime must stay CommonJS`);
    assert.doesNotMatch(mainRuntime, /^export\s/m, `${runtime} main runtime must stay CommonJS`);
    assert.match(rendererRuntime, /^export\s/m, `${runtime} renderer runtime must stay ESM`);
    assert.match(copyMainRuntime, new RegExp(`shared: '${runtime}\\.js', main: '${runtime}\\.cjs'`));
    assert.match(copyRenderer, new RegExp(`shared: '${runtime}\\.js', main: '${runtime}\\.cjs', renderer: '${runtime}\\.js'`));
  }
  assert.match(notesPage, /from '\.\/noteRichText\.js'/);
  assert.match(notesPage, /from '\.\/notesMarkdown\.js'/);
  assert.match(packageManifest, /"build:main": "tsc -p tsconfig\.main\.json && node scripts\/copy-main-runtime\.cjs"/);
});

test('Notes uses full width with a persistent resizable tree, independent scrolling, and shared editor themes', async () => {
  const { html, styles, baseStyles, notesPage } = await readIntegrationFiles();

  assert.match(html, /<section class="notes-page"[^>]*>[\s\S]*?<aside id="notes-sidebar" class="notes-sidebar">[\s\S]*?id="notes-sidebar-resizer"[\s\S]*?<section id="notes-workspace" class="notes-workspace"/);
  assert.match(html, /id="notes-sidebar-resizer"[\s\S]*?role="separator"[\s\S]*?aria-orientation="vertical"[\s\S]*?aria-controls="notes-sidebar notes-workspace"[\s\S]*?tabindex="0"/);
  assert.match(styles, /\.app-shell\[data-page=notes\]\{[^}]*margin-left:0[^}]*margin-right:0[^}]*max-width:none[^}]*height:100dvh[^}]*max-height:100dvh[^}]*overflow:hidden/);
  assert.match(styles, /\.notes-page\{[^}]*overflow:hidden[^}]*grid-template-columns:var\(--notes-sidebar-width,280px\) 6px minmax\(0,1fr\)/);
  assert.doesNotMatch(styles, /\.notes-page\{[^}]*grid-template-columns:[^}]*vw/);
  assert.match(styles, /\.notes-page,\.notes-sidebar\{[^}]*display:grid[^}]*min-height:0[^}]*min-width:0/);
  assert.match(styles, /\.notes-sidebar\{[^}]*grid-template-rows:auto minmax\(0,1fr\)/);
  assert.match(styles, /\.notes-sidebar-resizer\{[^}]*cursor:col-resize[^}]*touch-action:none/);
  assert.match(styles, /\.notes-sidebar-resizer:before\{[^}]*width:1px[^}]*background-color:/);
  assert.match(styles, /\.notes-list\{[^}]*min-height:0[^}]*overflow-y:auto/);
  assert.match(styles, /\.notes-list-row\{[^}]*grid-template-columns:22px minmax\(0,1fr\) 52px/);
  assert.match(styles, /\.notes-list-row\{padding-left:calc\(var\(--notes-tree-depth, 0\)\*14px\)\}/);
  assert.match(styles, /\.notes-tree-root-add[^}]*\{[^}]*height:2rem[^}]*width:2rem/);
  assert.match(styles, /\.notes-tree-actions\{[^}]*opacity:0/);
  assert.match(styles, /\.notes-tree-row\[data-drop-position=inside\]/);
  assert.match(styles, /\.notes-tree-root-drop/);
  assert.match(styles, /\.notes-empty\{[^}]*height:100%[^}]*min-height:0/);
  assert.match(styles, /\.notes-editor\{[^}]*height:100%[^}]*min-height:0/);
  assert.match(styles, /\.notes-editor\{[^}]*min-width:0[^}]*grid-template-rows:auto minmax\(0,1fr\)/);
  assert.doesNotMatch(styles, /\.notes-tags-row|\.notes-tags-label|\.notes-tags-input/);
  assert.match(styles, /\.notes-tree-toggle svg\{[^}]*transform:rotate\(0deg\)/);
  assert.match(styles, /\.notes-tree-toggle\[data-expanded=true\] svg\{transform:rotate\(90deg\)/);
  const taskItemRule = styles.match(/\.notes-richtext-content \.ProseMirror li\[data-task-item\]\{([^}]*)\}/);
  assert.ok(taskItemRule);
  assert.match(taskItemRule[1], /align-items:flex-start/);
  assert.match(taskItemRule[1], /margin-top:1rem/);
  assert.match(taskItemRule[1], /margin-bottom:1rem/);
  const taskCheckboxRules = [...styles.matchAll(/li\[data-task-item\] input\[type=checkbox\][^{]*\{([^}]*)\}/g)];
  assert.ok(taskCheckboxRules.length > 0);
  const taskCheckboxDeclarations = taskCheckboxRules.map((match) => match[1]).join(';');
  assert.match(taskCheckboxDeclarations, /font:inherit/);
  assert.match(taskCheckboxDeclarations, /appearance:none[^}]*border-style:solid[^}]*display:grid[^}]*place-content:center/);
  assert.match(
    taskCheckboxDeclarations,
    /width:1\.2em[^}]*height:1\.2em[^}]*top:calc\((?:\.28889em|\(1\.7777778em - 1\.2em\)\/2) - (?:0?\.5px)\)/,
  );
  assert.doesNotMatch(
    taskCheckboxDeclarations,
    /top:(?:5px|\.29em|calc\(\.29em\)|calc\(\(1\.7777778em - 1\.2em\)\/2\)(?:;|$))/,
  );
  assert.match(styles, /li\[data-task-item\]>div>p\{margin:0\}/);
  assert.match(
    styles,
    /\.notes-content\[data-theme=dark\] \.notes-richtext-content \.ProseMirror li\[data-task-item\]\[data-checked=true\]>div>p\{[^}]*color:/,
  );
  assert.doesNotMatch(
    styles,
    /\.notes-content\[data-theme=dark\] \.notes-richtext-content \.ProseMirror li\[data-task-item\]\[data-checked=true\]>div\{[^}]*color:/,
  );
  assert.match(styles, /\.notes-content\{[^}]*height:100%[^}]*min-height:0[^}]*overflow:hidden/);
  assert.match(styles, /\.notes-content \.cm-editor\{[^}]*height:100%[^}]*min-height:0/);
  assert.match(styles, /\.notes-content \.cm-scroller\{[^}]*min-height:0[^}]*overflow:auto/);
  assert.match(styles, /\.notes-language-control\{[^}]*position:relative[^}]*width:9rem[^}]*flex-shrink:0/);
  assert.match(styles, /\.notes-language-toggle\{[^}]*height:2rem[^}]*width:100%[^}]*justify-content:space-between/);
  assert.match(styles, /\.notes-language-menu\{[^}]*position:absolute[^}]*z-index:50[^}]*display:grid[^}]*width:14rem[^}]*max-height:272px[^}]*grid-template-rows:auto minmax\(0,1fr\)/);
  assert.match(styles, /\.notes-language-search-wrap\{[^}]*display:flex[^}]*height:1\.75rem[^}]*border-color:rgb\(228 228 231/);
  assert.match(styles, /\.notes-language-options\{[^}]*min-height:0[^}]*overflow-y:auto/);
  assert.match(styles, /\.notes-language-option\[aria-selected=true\]\{[^}]*background-color:rgb\(244 244 245/);
  assert.match(styles, /\.notes-editor-toolbar \.notes-name-input\{[^}]*width:auto/);
  assert.doesNotMatch(styles, /@media \(max-width:640px\)\{\.notes-page\{/);
  assert.match(baseStyles, /@font-face\s*\{[^}]*font-family:\s*'STM Notes UI'[^}]*notes-ui-variable\.woff2[^}]*font-weight:\s*100 900/);
  assert.match(baseStyles, /@font-face\s*\{[^}]*font-family:\s*'STM Notes Code'[^}]*notes-code-variable\.woff2[^}]*font-weight:\s*100 800/);
  assert.match(baseStyles, /--font-family-notes-ui:\s*ui-sans-serif,\s*system-ui,\s*sans-serif,\s*'Apple Color Emoji',\s*'Segoe UI Emoji',\s*'Segoe UI Symbol',\s*'Noto Color Emoji'/);
  assert.match(baseStyles, /--font-family-notes-code:\s*ui-monospace,\s*SFMono-Regular,\s*Menlo,\s*Monaco,\s*Consolas,\s*'Liberation Mono',\s*'Courier New',\s*monospace/);
  assert.match(baseStyles, /--font-family-notes-code-block:\s*'JetBrainsMono',\s*monospace/);
  assert.match(baseStyles, /--font-family-notes-richtext:\s*var\(--font-family-notes-ui\)/);
  assert.match(baseStyles, /--notes-editor-font-size:\s*18px/);
  assert.match(baseStyles, /--notes-sidebar-width:\s*280px/);
  assert.match(styles, /\.app-shell\[data-page=notes\][^{]*\{[^}]*font-family:var\(--font-family-notes-ui\)/);
  assert.match(styles, /\.app-shell\[data-page=notes\]\{[^}]*-webkit-font-smoothing:auto/);
  assert.match(styles, /\.notes-content \.cm-editor\{[^}]*font-family:var\(--font-family-notes-code\)[^}]*font-size:var\(--notes-editor-font-size\)[^}]*font-variant-ligatures:none/);
  assert.match(styles, /\.notes-content \.cm-scroller\{[^}]*overflow:auto[^}]*font-family:var\(--font-family-notes-code\)/);
  assert.match(styles, /\.notes-content\[data-theme=dark\] \.notes-code-content/);
  assert.match(styles, /\.notes-content\[data-theme=dark\] \.notes-richtext-content/);
  assert.match(styles, /\.notes-richtext-toolbar\{[^}]*min-width:0[^}]*padding:0/);
  assert.match(styles, /\.notes-richtext-image-toolbar,\.notes-richtext-toolbar\{position:absolute[^}]*z-index:30[^}]*display:flex[^}]*border-radius:\.375rem/);
  assert.match(styles, /\.notes-richtext-image-toolbar\{gap:\.125rem;padding:\.25rem\}/);
  assert.match(styles, /\.notes-richtext-image-align-button\{[^}]*height:2rem[^}]*width:2rem/);
  assert.match(styles, /\.notes-richtext-image-align-button\[data-active=true\]\{[^}]*color:/);
  assert.match(styles, /\.notes-richtext-tool\{[^}]*height:2\.25rem[^}]*border-radius:0/);
  assert.match(styles, /\.notes-richtext-tool\[data-active=true\]\{[^}]*color:/);
  assert.match(styles, /\.notes-richtext-block-menu\{[^}]*width:12rem/);
  assert.match(styles, /\.notes-richtext-block-item\{grid-template-columns:24px minmax\(0,1fr\) 16px\}/);
  assert.match(styles, /\.notes-richtext-block-item\[aria-selected=true\] \.notes-richtext-block-check\{visibility:visible\}/);
  assert.match(styles, /\.notes-richtext-link-popover\{[^}]*width:15rem[^}]*grid-template-columns:minmax\(0,1fr\) 32px/);
  assert.match(styles, /\.notes-richtext-link-action\[hidden\]\{display:none\}/);
  assert.match(styles, /\.notes-richtext-color-menu\{[^}]*max-height:20rem[^}]*width:12rem/);
  assert.match(styles, /\.notes-richtext-color-item\{grid-template-columns:28px minmax\(0,1fr\) 16px\}/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror\{[^}]*position:relative[^}]*min-height:100%[^}]*padding:\.625rem 1\.5rem 3rem/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror\.is-editor-empty:before\{[^}]*left:1\.5rem[^}]*top:\.625rem/);
  assert.match(styles, /@media \(max-width:820px\)\{\.notes-richtext-content \.ProseMirror\{padding:\.625rem \.75rem 2rem/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror\{[^}]*font-family:var\(--font-family-notes-richtext\)[^}]*font-size:var\(--notes-editor-font-size\)[^}]*line-height:1\.7777778/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror h1\{[^}]*font-size:2\.6666667em[^}]*font-weight:800[^}]*line-height:1/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror h2\{[^}]*font-size:1\.6666667em[^}]*font-weight:700[^}]*line-height:1\.3333333/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror h3\{[^}]*font-size:1\.3333333em[^}]*font-weight:600[^}]*line-height:1\.5/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror code\{[^}]*font-family:var\(--font-family-notes-code\)[^}]*font-size:\.8888889em[^}]*font-weight:500/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror code\{[^}]*border-radius:\.375rem[^}]*background-color:rgb\(241 245 249[^}]*padding:\.25rem \.375rem[^}]*color:rgb\(17 24 39/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror code\{[^}]*line-height:1\.5[^}]*white-space:break-spaces/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror code:after,\.notes-richtext-content \.ProseMirror code:before\{content:"`"\}/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror pre\{[^}]*background-color:rgb\(31 41 55[^}]*margin:2em 0[^}]*padding:1em 1\.5em[^}]*font-size:\.8888889em[^}]*line-height:1\.75/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror pre,\.notes-richtext-content \.ProseMirror pre code\{font-family:var\(--font-family-notes-code-block\);font-weight:400\}/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror pre code\{[^}]*line-height:inherit;white-space:inherit\}/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror pre code:after,\.notes-richtext-content \.ProseMirror pre code:before\{content:none\}/);
  assert.ok(
    styles.indexOf('.notes-richtext-content .ProseMirror h1+*')
      > styles.indexOf('.notes-richtext-content .ProseMirror pre{'),
    'heading-following block spacing must override the ordinary code-block top margin',
  );
  assert.match(styles, /\.notes-richtext-slash-menu\{[^}]*max-height:330px[^}]*width:18rem/);
  assert.match(styles, /\.notes-richtext-slash-item\{[^}]*height:3rem/);
  assert.match(styles, /\.notes-richtext-slash-icon\{[^}]*height:2\.5rem[^}]*width:2\.5rem/);
  assert.match(styles, /\.notes-richtext-image\{[^}]*max-width:100%/);
  assert.match(styles, /\.notes-richtext-image\{[^}]*margin-left:0/);
  assert.match(styles, /\.notes-richtext-image,\.notes-richtext-image\[data-alignment=center\]\{margin-right:auto\}/);
  assert.match(styles, /\.notes-richtext-image\[data-alignment=center\]\{margin-left:auto\}/);
  assert.match(styles, /\.notes-richtext-image\[data-alignment=right\]\{margin-left:auto;margin-right:0\}/);
  assert.match(styles, /\.notes-richtext-image\{position:relative/);
  assert.match(styles, /\.notes-richtext-image-frame\{position:relative/);
  assert.match(styles, /\.notes-richtext-image\.ProseMirror-selectednode\{outline:2px solid #4af/);
  assert.match(styles, /\.notes-richtext-image-handle\{[^}]*pointer-events:none[^}]*cursor:ew-resize[^}]*touch-action:none/);
  assert.match(styles, /\.notes-richtext-image\.ProseMirror-selectednode \.notes-richtext-image-handle\{[^}]*pointer-events:auto[^}]*opacity:1/);
  assert.match(styles, /\.notes-richtext-math\{[^}]*display:inline-flex[^}]*cursor:pointer/);
  assert.match(notesPage, /function applyNotesFontSize\(fontSize\)[\s\S]*?style\.setProperty\('--notes-editor-font-size', `\$\{normalized\}px`\)[\s\S]*?requestAnimationFrame\(\(\) => page\?\.requestEditorMeasure\(\)\)/);
  assert.match(notesPage, /fontSize >= 12 && fontSize <= 24 \? fontSize : 18/);
  assert.match(notesPage, /function clampNotesSidebarWidth\(value\)[\s\S]*?Math\.min\(MAX_NOTES_SIDEBAR_WIDTH, Math\.max\(MIN_NOTES_SIDEBAR_WIDTH, rounded\)\)/);
  assert.match(notesPage, /handleSidebarResizePointerDown[\s\S]*?setPointerCapture\(event\.pointerId\)[\s\S]*?handleSidebarResizePointerMove[\s\S]*?startWidth \+ event\.clientX - drag\.startX/);
  assert.match(notesPage, /finishSidebarResize[\s\S]*?saveNotesSidebarWidth\(width\)/);
  assert.match(notesPage, /handleSidebarResizeKeyDown[\s\S]*?ArrowLeft[\s\S]*?ArrowRight[\s\S]*?Home[\s\S]*?End/);
  assert.match(notesPage, /NOTES_SIDEBAR_KEYBOARD_SAVE_DEBOUNCE_MS = 180[\s\S]*?queueSidebarWidthSave/);
  assert.match(notesPage, /async flush\(\)[\s\S]*?finishSidebarResize\(\)[\s\S]*?waitForSidebarWidthSaves\(\)/);
  assert.match(notesPage, /function applyNotesEditorTheme\(theme\)[\s\S]*?theme === 'dark' \? 'dark' : 'light'[\s\S]*?dataset\.notesEditorTheme = normalized[\s\S]*?page\?\.applyEditorTheme\(normalized\)/);
});

test('Bundled compatibility fonts retain their local licenses', async () => {
  const fontRoot = path.join(projectRoot, 'assets', 'fonts');
  const [uiFont, codeFont, uiLicense, codeLicense, packageJson, baseStyles] = await Promise.all([
    stat(path.join(fontRoot, 'notes-ui-variable.woff2')),
    stat(path.join(fontRoot, 'notes-code-variable.woff2')),
    readFile(path.join(fontRoot, 'OFL-NotoSansCJK.txt'), 'utf8'),
    readFile(path.join(fontRoot, 'OFL-JetBrainsMono.txt'), 'utf8'),
    readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'src', 'renderer', 'styles.css'), 'utf8'),
  ]);
  const declaredFontPaths = [...baseStyles.matchAll(/url\(['"]?(\.\.\/\.\.\/assets\/fonts\/[^)'"\s]+)['"]?\)/g)]
    .map((match) => path.resolve(projectRoot, 'src', 'renderer', match[1]));
  const declaredFonts = await Promise.all(declaredFontPaths.map((fontPath) => stat(fontPath)));

  assert.ok(uiFont.size > 1_000_000);
  assert.ok(codeFont.size > 50_000);
  assert.equal(declaredFonts.length, 5);
  assert.ok(declaredFonts.every((font) => font.isFile() && font.size > 0));
  assert.match(uiLicense, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(codeLicense, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.ok(packageJson.build.files.includes('assets/**/*'));
});

test('Notes file-type icons are packaged locally with their upstream licenses', async () => {
  const iconRoot = path.join(projectRoot, 'assets', 'note-file-icons');
  const iconNames = [
    'pdf', 'document', 'spreadsheet', 'presentation', 'archive',
    'image', 'audio', 'video', 'code', 'file',
  ];
  const [icons, vscodeLicense, materialLicense, sources, packageJson] = await Promise.all([
    Promise.all(iconNames.map(async (name) => ({
      name,
      source: await readFile(path.join(iconRoot, `${name}.svg`), 'utf8'),
      metadata: await stat(path.join(iconRoot, `${name}.svg`)),
    }))),
    readFile(path.join(iconRoot, 'LICENSE-vscode-icons.txt'), 'utf8'),
    readFile(path.join(iconRoot, 'LICENSE-material-icon-theme.txt'), 'utf8'),
    readFile(path.join(iconRoot, 'SOURCES.md'), 'utf8'),
    readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
  ]);

  assert.ok(icons.every(({ metadata }) => metadata.isFile() && metadata.size > 100));
  for (const { name, source } of icons) {
    assert.match(source, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32">/, name);
    assert.doesNotMatch(source, /<script|https?:\/\/(?!www\.w3\.org)/i, name);
  }
  assert.match(vscodeLicense, /Copyright \(c\) 2016 Roberto Huertas/);
  assert.match(materialLicense, /Copyright \(c\) 2025 Material Extensions/);
  for (const sourceId of [
    'vscode-icons:file-type-pdf2',
    'vscode-icons:file-type-word',
    'vscode-icons:file-type-excel',
    'vscode-icons:file-type-powerpoint',
    'vscode-icons:file-type-image',
    'vscode-icons:file-type-json',
    'material-icon-theme:audio',
    'material-icon-theme:video',
  ]) {
    assert.match(sources, new RegExp(sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.ok(packageJson.build.files.includes('assets/**/*'));
});

test('Settings is fixed-height and shares Save across S3, Notes, and local LLM tabs', async () => {
  const { html, styles, renderer, notesPage, settingsDialog, preload, main } = await readIntegrationFiles();

  assert.match(html, /<nav id="nav-rail"[\s\S]*?id="nav-settings-btn"[\s\S]*?<\/nav>/);
  assert.match(html, /id="nav-settings-btn"[^>]*aria-label="Settings"/);
  assert.match(html, /id="nav-settings-btn"[\s\S]*?<svg class="nav-settings-icon"[^>]*viewBox="0 0 24 24"[\s\S]*?<circle cx="12" cy="12" r="3"><\/circle>/);
  assert.match(styles, /\.nav-settings-button\{margin-top:auto;order:99\}/);
  assert.match(styles, /\.host-dialog\.settings-dialog\{width:min\(540px,calc\(100vw - 32px\)\)/);
  assert.match(styles, /\.dialog-panel\.settings-panel\{[^}]*height:min\(600px,calc\(100dvh - 32px\)\)[^}]*max-height:min\(600px,calc\(100dvh - 32px\)\)[^}]*grid-template-rows:auto auto minmax\(0,1fr\) auto/);
  assert.match(styles, /\.settings-tab-panel\{[^}]*min-height:0[^}]*overflow-y:auto/);
  assert.match(html, /id="settings-dialog"/);
  assert.match(html, /class="settings-head-actions"[\s\S]*?id="settings-save-btn"[^>]*type="submit"[^>]*>Save<\/button>[\s\S]*?id="settings-close-btn"/);
  assert.match(html, /class="settings-tabs"[^>]*role="tablist"[\s\S]*?id="settings-s3-tab"[^>]*aria-selected="true"[\s\S]*?id="settings-notes-tab"[^>]*aria-selected="false"[\s\S]*?id="settings-llm-tab"[^>]*aria-selected="false"/);
  assert.match(html, /id="settings-s3-panel"[^>]*role="tabpanel"[^>]*aria-labelledby="settings-s3-tab"/);
  assert.match(html, /id="settings-notes-panel"[^>]*role="tabpanel"[^>]*aria-labelledby="settings-notes-tab"[^>]*hidden/);
  assert.match(html, /id="settings-llm-panel"[^>]*role="tabpanel"[^>]*aria-labelledby="settings-llm-tab"[^>]*hidden/);
  assert.match(styles, /\.settings-tab-panel\[hidden\]\{display:none\}/);
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
  assert.match(html, /id="settings-s3-panel"[\s\S]*?id="settings-test-btn"[^>]*>Test<\/button>[\s\S]*?id="settings-sync-btn"[^>]*>Sync Now<\/button>[\s\S]*?<\/section>/);
  assert.match(html, /id="s3-sync-status"[\s\S]*?id="s3-sync-status-text"[^>]*role="status"[^>]*aria-live="polite"[\s\S]*?id="s3-sync-progress-wrap"[^>]*class="settings-sync-progress-wrap hidden"[\s\S]*?id="s3-sync-progress"[^>]*aria-label="S3 sync progress"[\s\S]*?id="s3-sync-progress-value"/);
  assert.match(styles, /\.settings-status\{[^}]*display:flex[^}]*min-height:2\.25rem[^}]*align-items:center[^}]*justify-content:space-between/);
  assert.match(styles, /\.settings-sync-progress-wrap progress\{[^}]*height:\.25rem[^}]*width:5rem/);
  assert.match(styles, /\.settings-sync-progress-wrap progress:not\(\[value\]\)\{[^}]*background-image:linear-gradient[^}]*settings-sync-progress-indeterminate/);
  assert.match(html, /id="settings-notes-panel"[\s\S]*?id="notes-font-size"[^>]*type="number"[^>]*min="12"[^>]*max="24"[^>]*value="18"/);
  assert.match(html, /id="settings-notes-panel"[\s\S]*?id="notes-editor-theme"[\s\S]*?<option value="light">Light<\/option>[\s\S]*?<option value="dark">Dark<\/option>/);
  assert.doesNotMatch(html, /Adjust the snippet editor text size|Use one theme for code and rich text editors/);
  assert.match(styles, /\.settings-notes-card\{[^}]*display:grid[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(styles, /\.settings-notes-card \.settings-theme-select\{[^}]*width:7rem/);
  assert.match(html, /id="settings-llm-panel"[\s\S]*?id="llm-endpoint"[^>]*type="url"[^>]*placeholder="https:\/\/api\.example\.com\/v1"/);
  assert.match(html, /id="settings-llm-panel"[\s\S]*?id="llm-token"[^>]*type="password"[\s\S]*?id="llm-token-visibility"[^>]*aria-label="Show LLM Token"/);
  assert.match(html, /id="settings-llm-panel"[\s\S]*?id="llm-http-warning"[\s\S]*?id="llm-model"[\s\S]*?id="settings-llm-load-models-btn"[^>]*>Load Models<\/button>/);
  assert.match(html, /id="settings-sync-btn"[^>]*>Sync Now<\/button>/);
  assert.doesNotMatch(html, /settings-clear-credentials-btn|Clear Credentials/);

  assert.match(preload, /getUiPreferences:\s*\(\)\s*=>\s*[^\n]*invoke\('settings:ui:get'\)/);
  assert.match(preload, /saveUiPreferences:\s*\(draft\)\s*=>\s*[^\n]*invoke\('settings:ui:save', draft\)/);
  assert.match(preload, /saveNotesSidebarWidth:\s*\(width\)\s*=>[\s\S]*?invoke\('settings:ui:notes-sidebar-width:save', width\)/);
  assert.match(preload, /getS3SyncSettings:\s*\(\)\s*=>\s*[^\n]*invoke\('settings:s3:get'\)/);
  assert.match(preload, /saveS3SyncSettings:\s*\(draft\)\s*=>\s*[^\n]*invoke\('settings:s3:save', draft\)/);
  assert.match(preload, /testS3Connection:\s*\(draft\)\s*=>\s*[^\n]*invoke\('settings:s3:test', draft\)/);
  assert.match(preload, /revealS3SyncCredentials:\s*\(\)\s*=>\s*[^\n]*invoke\('settings:s3:reveal-credentials'\)/);
  assert.match(preload, /syncAllDataToS3:\s*\(\)\s*=>\s*[^\n]*invoke\('settings:s3:sync'\)/);
  assert.match(preload, /getLlmSettings:\s*\(\)\s*=>\s*[^\n]*invoke\('settings:llm:get'\)/);
  assert.match(preload, /saveLlmSettings:\s*\(draft\)\s*=>\s*[^\n]*invoke\('settings:llm:save', draft\)/);
  assert.match(preload, /revealLlmToken:\s*\(\)\s*=>\s*[^\n]*invoke\('settings:llm:reveal-token'\)/);
  assert.match(preload, /listLlmModels:\s*\(draft\)\s*=>\s*[^\n]*invoke\('settings:llm:list-models', draft\)/);
  assert.match(preload, /onS3SyncStateChanged:\s*\(listener\)\s*=>\s*\{[\s\S]*?ipcRenderer\.on\('settings:s3:state', wrapped\)[\s\S]*?removeListener\('settings:s3:state', wrapped\)/);
  assert.match(preload, /onPersistentDataReloaded:\s*\(listener\)\s*=>\s*\{[\s\S]*?ipcRenderer\.on\('app:persistent-data-reloaded', wrapped\)[\s\S]*?removeListener\('app:persistent-data-reloaded', wrapped\)/);
  assert.match(preload, /exposeInMainWorld\('settingsApi', settingsApi\)/);
  for (const handler of [
    'uiPreferencesGet',
    'uiPreferencesSave',
    'uiPreferencesNotesSidebarWidthSave',
    's3SettingsGet',
    's3SettingsSave',
    's3SettingsTest',
    's3SettingsReveal',
    's3Sync',
    'llmSettingsGet',
    'llmSettingsSave',
    'llmSettingsReveal',
    'llmModelsList',
  ]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\(IPC_CHANNELS\\.${handler}`));
  }
  assert.match(renderer, /registerSettingsDialog\(\)/);
  const persistentReloadStart = renderer.indexOf('window.settingsApi.onPersistentDataReloaded((event) => {');
  const persistentReloadEnd = renderer.indexOf('(async function init()', persistentReloadStart);
  assert.ok(persistentReloadStart >= 0 && persistentReloadEnd > persistentReloadStart);
  const persistentReload = renderer.slice(persistentReloadStart, persistentReloadEnd);
  const sourceCheck = persistentReload.indexOf("event.source === 'trilium'");
  const triliumBranchStart = persistentReload.indexOf('?', sourceCheck);
  const s3BranchStart = persistentReload.indexOf(':', triliumBranchStart);
  const branchEnd = persistentReload.indexOf(';', s3BranchStart);
  assert.ok(sourceCheck >= 0 && triliumBranchStart > sourceCheck && s3BranchStart > triliumBranchStart && branchEnd > s3BranchStart);
  assert.match(persistentReload.slice(triliumBranchStart + 1, s3BranchStart), /reloadNotesPage\(event\.persistentApplyId\)/);
  assert.doesNotMatch(persistentReload.slice(triliumBranchStart + 1, s3BranchStart), /loadHosts\(\)/);
  assert.match(persistentReload.slice(s3BranchStart + 1, branchEnd), /Promise\.all\(\[loadHosts\(\), reloadNotesPage\(event\.persistentApplyId\)\]\)/);
  assert.match(settingsDialog, /window\.settingsApi\.syncAllDataToS3\(\)/);
  assert.match(settingsDialog, /window\.settingsApi\.testS3Connection\(currentS3TestDraft\(\)\)/);
  assert.match(settingsDialog, /window\.settingsApi\.onS3SyncStateChanged\(renderSyncState\)/);
  assert.match(settingsDialog, /const syncPhaseLabels = \{[\s\S]*?checking: 'Checking cloud'[\s\S]*?'reading-cloud': 'Reading cloud'[\s\S]*?uploading: 'Uploading'/);
  assert.match(settingsDialog, /function renderSyncProgress\(state\)[\s\S]*?completedItems[\s\S]*?totalItems[\s\S]*?setAttribute\('aria-busy', 'true'\)[\s\S]*?syncProgress\.value = percent/);
  assert.match(settingsDialog, /case 'syncing':\s*renderSyncProgress\(state\)/);
  assert.match(settingsDialog, /function resetSyncProgress\(\)[\s\S]*?syncProgressWrap\.classList\.add\('hidden'\)[\s\S]*?removeAttribute\('aria-busy'\)/);
  assert.match(settingsDialog, /function setStatus\([\s\S]*?applyStatusLevel\(level\);\s*resetSyncProgress\(\)/);
  assert.match(settingsDialog, /window\.settingsApi\.onUiPreferencesChanged\(renderUiPreferences\)/);
  assert.match(settingsDialog, /bucketInput\.value = settings\.bucket/);
  assert.match(settingsDialog, /bucket:\s*bucketInput\.value\.trim\(\)/);
  assert.match(settingsDialog, /await flushNotesPage\(\);[\s\S]*?saveS3SyncSettings\(currentDraft\(\)\)[\s\S]*?syncAllDataToS3\(\)/);
  assert.match(settingsDialog, /const saveS3 = shouldSaveS3Draft\(s3Draft\)[\s\S]*?if \(saveS3\)[\s\S]*?saveS3SyncSettings\(s3Draft\)[\s\S]*?saveUiPreferences\(preferences\)[\s\S]*?saveLlmSettings\(llmDraft\)[\s\S]*?closeSettingsDialog\(\)/);
  assert.match(settingsDialog, /function shouldSaveS3Draft\(draft\)[\s\S]*?draft\.endpoint[\s\S]*?hasCredentials[\s\S]*?hasSyncEncryptionKey/);
  assert.match(settingsDialog, /const settingsTabOrder = \['s3', 'notes', 'llm'\]/);
  assert.match(settingsDialog, /function activateTab\(tab, focus = false\)[\s\S]*?panel\.hidden = !selected/);
  assert.match(settingsDialog, /event\.key === 'ArrowRight'[\s\S]*?event\.key === 'ArrowLeft'[\s\S]*?activateTab/);
  assert.doesNotMatch(settingsDialog, /clearCredentials|Clear Credentials/);
  assert.match(settingsDialog, /notesEditorTheme !== 'light' && notesEditorTheme !== 'dark'/);
  assert.match(settingsDialog, /return \{ notesFontSize, notesEditorTheme \}/);
  assert.match(settingsDialog, /applyNotesEditorTheme\(preferences\.notesEditorTheme\)/);
  assert.match(settingsDialog, /applyNotesSidebarWidth\(preferences\.notesSidebarWidth\)/);
  assert.match(settingsDialog, /window\.settingsApi\.listLlmModels\(\{/);
  assert.match(settingsDialog, /\.\.\.\(!token && hasLlmToken && !shouldClearLlmToken\(\) \? \{ useSavedToken: true \} : \{\}\)/);
  assert.match(settingsDialog, /function shouldClearLlmToken\(\)[\s\S]*?llmTokenClearRequested[\s\S]*?!llmTokenInput\.value && llmTokenEdited && llmSavedTokenHydrated/);
  assert.match(settingsDialog, /\.\.\.\(shouldClearLlmToken\(\) \? \{ clearToken: true \} : \{\}\)/);
  assert.match(settingsDialog, /token && llmTokenEdited \? \{ token \} : \{\}/);
  assert.match(settingsDialog, /renderLlmModelOptions\(models, selectedModel\)/);
  assert.match(settingsDialog, /const settingsReady = s3SettingsLoaded && uiPreferencesLoaded && llmSettingsLoaded/);
  assert.match(settingsDialog, /id="llm-token-remove"|llmTokenRemoveButton/);
  assert.ok(settingsDialog.includes("!hasToken || !/^http:\\/\\//i.test(llmEndpointInput.value.trim())"));
  assert.match(settingsDialog, /Promise\.allSettled\(\[[\s\S]*?getS3SyncSettings\(\)[\s\S]*?getUiPreferences\(\)[\s\S]*?getLlmSettings\(\)/);
  assert.match(notesPage, /await Promise\.all\([\s\S]*?if \(this\.notes\.some\([\s\S]*?throw new Error\('Some notes could not be saved\./);
  assert.match(settingsDialog, /for \(const input of s3Inputs\)\s*input\.disabled = locked \|\| !s3SettingsLoaded/);
  assert.match(settingsDialog, /\.\.\.\(accessKeyId \? \{ accessKeyId \} : \{\}\)/);
  assert.match(settingsDialog, /\.\.\.\(secretAccessKey \? \{ secretAccessKey \} : \{\}\)/);

  assert.match(main, /new llmSettingsStore_1\.LlmSettingsStore\(\{[\s\S]*?join\([^\n]*getPath\('userData'\), 'llm-settings\.json'\)/);
  const sharedSnapshotStart = main.indexOf('async function collectS3SharedAppDataUnlocked()');
  const sharedSnapshotEnd = main.indexOf('async function collectS3SharedAppData()', sharedSnapshotStart);
  assert.ok(sharedSnapshotStart >= 0 && sharedSnapshotEnd > sharedSnapshotStart);
  const sharedSnapshot = main.slice(sharedSnapshotStart, sharedSnapshotEnd);
  assert.doesNotMatch(sharedSnapshot, /llm|model|token/i);
});

test('Settings hydrates saved S3 and LLM credentials masked and reveals only one selected field', async () => {
  const { settingsDialog } = await readIntegrationFiles();
  const renderStart = settingsDialog.indexOf('function renderSettings(');
  const renderEnd = settingsDialog.indexOf('function currentDraft', renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const renderSettings = settingsDialog.slice(renderStart, renderEnd);

  assert.match(renderSettings, /hasCredentials = settings\.hasCredentials/);
  assert.match(renderSettings, /hasSyncEncryptionKey = settings\.hasSyncEncryptionKey/);
  assert.match(renderSettings, /if \(!settings\.hasCredentials\)/);
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
  assert.match(settingsDialog, /settingsResult\.value\.hasCredentials && \(!accessKeyInput\.value \|\| !secretKeyInput\.value\)[\s\S]*?settingsResult\.value\.hasSyncEncryptionKey && !syncEncryptionKeyInput\.value[\s\S]*?await revealSavedCredentials\(\)/);
  assert.match(settingsDialog, /syncEncryptionKeyInput\.value = credentials\.syncEncryptionKey/);
  assert.match(settingsDialog, /async function revealSavedLlmToken\(\)[\s\S]*?window\.settingsApi\.revealLlmToken\(\)[\s\S]*?llmTokenInput\.value = token[\s\S]*?maskCredentials\(\)/);
  assert.match(settingsDialog, /llmTokenInput\.value = token[\s\S]*?llmSavedTokenHydrated = Boolean\(token\)/);
  assert.match(settingsDialog, /hasLlmToken = settings\.hasToken/);
  assert.match(settingsDialog, /if \(!settings\.hasToken && !llmTokenEdited\)[\s\S]*?llmTokenInput\.value = ''/);
  assert.match(settingsDialog, /llmTokenInput\.addEventListener\('input',[\s\S]*?llmTokenEdited = true[\s\S]*?updateControls\(\)/);
  assert.match(settingsDialog, /function prepareSettingsDialogClose\(\)[\s\S]*?llmTokenEdited = false[\s\S]*?llmSavedTokenHydrated = false/);
  assert.match(settingsDialog, /async function openSettings\(\)[\s\S]*?llmTokenEdited = false[\s\S]*?llmSavedTokenHydrated = false[\s\S]*?clearCredentialInputs\(\)/);
  assert.match(settingsDialog, /saveLlmSettings\(llmDraft\)[\s\S]*?llmTokenEdited = false[\s\S]*?llmSavedTokenHydrated = Boolean\(savedLlmSettings\.hasToken && llmTokenInput\.value\)[\s\S]*?renderLlmSettings\(savedLlmSettings\)/);
  assert.doesNotMatch(settingsDialog, /llmTokenInput\.value\s*=\s*settings\.(?:token|credentials)/);
  assert.match(settingsDialog, /const syncEncryptionKey = syncEncryptionKeyInput\.value\.trim\(\)[\s\S]*?\{ syncEncryptionKey \}/);
  assert.match(settingsDialog, /writeClipboardText\(syncEncryptionKeyInput\.value\)/);
  assert.match(settingsDialog, /function renderSettingsWithAuthoritativeSyncKey[\s\S]*?syncEncryptionKeyInput\.value = ''[\s\S]*?renderSettings\(settings\)[\s\S]*?await revealSavedCredentials\(\)/);
  assert.match(settingsDialog, /saveS3SyncSettings\(currentDraft\(\)\)[\s\S]*?syncAllDataToS3\(\)[\s\S]*?renderSettingsWithAuthoritativeSyncKey\(await window\.settingsApi\.getS3SyncSettings\(\)\)/);
  assert.match(settingsDialog, /if \(show\)[\s\S]*?other !== control[\s\S]*?setCredentialVisibility\(other, false\)/);
  assert.match(settingsDialog, /function clearCredentialInputs\(\)[\s\S]*?control\.input\.value = ''/);
  assert.match(settingsDialog, /function prepareSettingsDialogClose\(\)[\s\S]*?settingsOpenGeneration \+= 1[\s\S]*?clearCredentialInputs\(\)[\s\S]*?maskCredentials\(\)/);
  assert.match(settingsDialog, /function closeSettingsDialog\(\)[\s\S]*?prepareSettingsDialogClose\(\)[\s\S]*?dialog\.close\(\)/);
  assert.match(settingsDialog, /async function openSettings\(\)[\s\S]*?clearCredentialInputs\(\)[\s\S]*?getS3SyncSettings\(\)/);
  assert.match(settingsDialog, /getLlmSettings\(\)[\s\S]*?llmResult\.value\.hasToken[\s\S]*?revealSavedLlmToken\(\)/);
  assert.match(settingsDialog, /control\.source === 'llm' \? await revealSavedLlmToken\(\) : await revealSavedCredentials\(\)/);
  assert.match(settingsDialog, /if \(!dialog\.open \|\| openGeneration !== settingsOpenGeneration\)\s*return/);
  assert.match(settingsDialog, /dialog\.addEventListener\('cancel',[\s\S]*?prepareSettingsDialogClose\(\)/);
  assert.match(settingsDialog, /dialog\.addEventListener\('close',[\s\S]*?if \(dialog\.open\)\s*return[\s\S]*?clearCredentialInputs\(\)[\s\S]*?maskCredentials\(\)/);
  assert.doesNotMatch(settingsDialog, /clearCredentials|Clear Credentials/);
});

test('normal and signal shutdown flush the complete Notes/Settings state and stop active work', async () => {
  const { main } = await readIntegrationFiles();
  const shutdownStart = main.indexOf('async function shutdownRuntimesForQuit()');
  const shutdownEnd = main.indexOf('function requestQuitAfterRuntimeShutdown', shutdownStart);
  assert.ok(shutdownStart >= 0 && shutdownEnd > shutdownStart);
  const shutdown = main.slice(shutdownStart, shutdownEnd);

  assert.match(shutdown, /Promise\.resolve\(\)\.then\(\(\) => notesStore\?\.flush\(\)\)/);
  assert.match(shutdown, /Promise\.resolve\(\)\.then\(\(\) => notesTreeStore\?\.flush\(\)\)/);
  assert.match(shutdown, /Promise\.resolve\(\)\.then\(\(\) => notesTreeViewStore\?\.flush\(\)\)/);
  assert.match(shutdown, /Promise\.resolve\(\)\.then\(\(\) => uiPreferencesStore\?\.flush\(\)\)/);
  assert.match(shutdown, /Promise\.resolve\(\)\.then\(\(\) => llmSettingsStore\?\.flush\(\)\)/);
  assert.match(shutdown, /for \(const controller of activeLlmModelRequests\)\s*controller\.abort\(\)/);
  assert.match(shutdown, /await flushRendererNotes\(\);[\s\S]*?notesStore\?\.flush\(\)/);
  assert.match(shutdown, /Promise\.resolve\(\)\.then\(\(\) => s3SyncRuntime\?\.shutdown\(\)\)/);
  assert.match(main, /window\.on\('close',[\s\S]*?event\.preventDefault\(\)[\s\S]*?requestQuitAfterRuntimeShutdown\(\)/);
  assert.match(main, /ipcMain\.on\(IPC_CHANNELS\.notesFlushResult/);
  assert.match(main, /cleanup:\s*shutdownRuntimesForQuit/);
  assert.match(main, /process\.once\('SIGINT'[\s\S]*?requestQuitAfterRuntimeShutdown\(true\)/);
  assert.match(main, /process\.once\('SIGTERM'[\s\S]*?requestQuitAfterRuntimeShutdown\(true\)/);
});
