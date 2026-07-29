const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');

async function source(relativePath) {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

function between(value, startMarker, endMarker) {
  const start = value.indexOf(startMarker);
  const end = value.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker after ${startMarker}: ${endMarker}`);
  return value.slice(start, end);
}

test('Settings Notes exposes a compact transient Trilium ETAPI import card with progress and cancellation', async () => {
  const [html, styles] = await Promise.all([
    source('src/renderer/index.html'),
    source('src/renderer/tailwind.css'),
  ]);
  const notesPanel = between(
    html,
    '<section id="settings-notes-panel"',
    '<section id="settings-llm-panel"',
  );

  assert.match(notesPanel, /class="settings-trilium-card"/);
  assert.match(notesPanel, /Import from Trilium[\s\S]*?<span>ETAPI<\/span>/);
  assert.match(notesPanel, /id="trilium-endpoint"[^>]*type="url"[^>]*placeholder="https:\/\/notes\.example\.com"[^>]*autocomplete="off"/);
  assert.match(notesPanel, /id="trilium-etapi-token"[^>]*type="password"[^>]*placeholder="ETAPI Token"[^>]*autocomplete="off"/);
  assert.match(notesPanel, /id="trilium-etapi-token-visibility"[^>]*type="button"[^>]*aria-label="Show Trilium ETAPI Token"[^>]*aria-controls="trilium-etapi-token"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(notesPanel, /id="trilium-etapi-token"[^>]*\bvalue=/);
  assert.match(notesPanel, /id="trilium-http-warning"[^>]*class="settings-inline-warning hidden"[^>]*>HTTP sends the ETAPI Token without transport encryption\.<\/p>/);
  assert.match(notesPanel, /id="trilium-import-progress-wrap"[^>]*class="settings-trilium-progress hidden"/);
  assert.match(notesPanel, /id="trilium-import-progress"[^>]*max="1"[^>]*value="0"/);
  assert.match(notesPanel, /id="trilium-import-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(notesPanel, /id="settings-trilium-cancel-btn"[^>]*type="button"[^>]*class="btn btn-secondary hidden"[^>]*>Cancel<\/button>[\s\S]*?id="settings-trilium-import-btn"[^>]*type="button"[^>]*>Import<\/button>/);

  const triliumStyles = between(styles, '  .settings-trilium-card {', '  .settings-inline-warning {');
  assert.match(triliumStyles, /\.settings-trilium-card \{[\s\S]*?@apply grid gap-2\.5[^;]*px-3 py-2\.5/);
  assert.match(triliumStyles, /\.settings-trilium-progress progress \{[\s\S]*?@apply h-1\.5 w-full/);
  assert.match(triliumStyles, /\.settings-trilium-progress span \{[\s\S]*?text-\[11\.5px\] leading-4/);
  assert.match(triliumStyles, /\.settings-trilium-progress\[data-phase='error'\] span/);
  assert.match(triliumStyles, /\.settings-trilium-progress\[data-phase='complete'\] progress::\-webkit-progress-value/);
  assert.match(triliumStyles, /\.settings-trilium-actions \{\s*@apply pt-0\.5;/);
});

test('Trilium Settings flow flushes drafts, fences requests, converts HTML in batches, and keeps the token transient', async () => {
  const settingsDialog = await source('src/renderer/settingsDialog.ts');
  const importFlow = between(
    settingsDialog,
    'async function importFromTrilium(): Promise<void> {',
    'async function cancelActiveTriliumImport(): Promise<void> {',
  );
  const cancelFlow = between(
    settingsDialog,
    'async function cancelActiveTriliumImport(): Promise<void> {',
    'async function loadLlmModels(): Promise<void> {',
  );
  const saveFlow = between(
    settingsDialog,
    'async function saveAllSettings(): Promise<void> {',
    'async function testS3Connection(): Promise<void> {',
  );
  const s3Draft = between(
    settingsDialog,
    'function currentDraft(): S3SyncSettingsDraft {',
    'function currentS3TestDraft(): S3ConnectionTestDraft {',
  );
  const preferenceDraft = between(
    settingsDialog,
    'function currentUiPreferences(): UiPreferencesDraft {',
    'function shouldClearLlmToken(): boolean {',
  );
  const llmDraft = between(
    settingsDialog,
    'function currentLlmDraft(): LlmSettingsDraft {',
    'function shouldSaveS3Draft(',
  );

  const flushIndex = importFlow.indexOf('await flushNotesPage();');
  const prepareIndex = importFlow.indexOf('window.settingsApi.prepareTriliumImport({');
  const resolveIndex = importFlow.indexOf('window.settingsApi.resolveTriliumImportImages({');
  const convertIndex = importFlow.indexOf('const converted = convertTriliumHtmlToRichText(');
  const applyIndex = importFlow.indexOf('window.settingsApi.applyTriliumImport({');
  assert.ok(flushIndex >= 0 && flushIndex < prepareIndex);
  assert.ok(prepareIndex < resolveIndex && resolveIndex < convertIndex && convertIndex < applyIndex);
  assert.match(importFlow, /const requestId = crypto\.randomUUID\(\);[\s\S]*?activeTriliumImportRequestId = requestId/);
  assert.match(importFlow, /prepareTriliumImport\(\{\s*requestId,\s*endpoint,\s*etapiToken,\s*\}\)/);
  assert.match(importFlow, /if \(preparation\.requestId !== requestId\) throw new Error\('The Trilium import response did not match this request\.'\)/);
  assert.match(importFlow, /resolveTriliumImportImages\(\{\s*requestId,\s*sessionId: preparation\.sessionId,\s*\}\)/);
  assert.match(importFlow, /const imageAssetsBySource = new Map\(/);
  assert.match(importFlow, /convertTriliumHtmlToRichText\(\s*source\.html,\s*preparation\.endpoint,\s*imageAssetsBySource/);
  assert.ok((importFlow.match(/if \(triliumCancelRequested\) throw new Error\('Trilium import cancelled\.'\)/g) ?? []).length >= 3);
  assert.match(importFlow, /const convertedNotes: TriliumImportConvertedNote\[\] = \[\]/);
  assert.match(importFlow, /convertedNotes\.push\(\{ noteId: source\.noteId, \.\.\.converted \}\)/);
  assert.match(importFlow, /completed % TRILIUM_CONVERSION_BATCH_SIZE === 0[\s\S]*?phase: 'converting'[\s\S]*?await yieldToRenderer\(\)/);
  assert.match(importFlow, /applyTriliumImport\(\{\s*requestId,\s*sessionId: preparation\.sessionId,\s*convertedNotes,\s*\}\)/);
  assert.match(importFlow, /if \(activeTriliumImportRequestId === requestId\) activeTriliumImportRequestId = undefined/);
  assert.match(settingsDialog, /const TRILIUM_CONVERSION_BATCH_SIZE = 16/);

  const catchIndex = importFlow.indexOf('  } catch (error) {', applyIndex);
  const finallyIndex = importFlow.indexOf('  } finally {', catchIndex);
  assert.ok(applyIndex < catchIndex && finallyIndex > catchIndex);
  assert.match(importFlow.slice(applyIndex, catchIndex), /triliumEtapiTokenInput\.value = ''[\s\S]*?setTriliumTokenVisibility\(false\)/);
  assert.doesNotMatch(importFlow.slice(catchIndex, finallyIndex), /triliumEtapiTokenInput\.value = ''/);
  assert.match(cancelFlow, /triliumCancelRequested = true;[\s\S]*?triliumEtapiTokenInput\.value = '';[\s\S]*?cancelTriliumImport\(requestId\)/);
  assert.match(settingsDialog, /function clearCredentialInputs\(\): void \{[\s\S]*?triliumEtapiTokenInput\.value = ''/);
  assert.match(settingsDialog, /function prepareSettingsDialogClose\(\): void \{[\s\S]*?clearCredentialInputs\(\)[\s\S]*?resetTriliumImportUi\(\)/);

  for (const persistedDraft of [s3Draft, preferenceDraft, llmDraft, saveFlow]) {
    assert.doesNotMatch(persistedDraft, /trilium|etapi/i);
  }
  assert.match(settingsDialog, /onTriliumImportProgress\(\(progress\) => \{\s*if \(progress\.requestId !== activeTriliumImportRequestId\) return;\s*renderTriliumProgress\(progress\)/);
  assert.match(settingsDialog, /triliumImportProgressWrap\.dataset\.phase = progress\.phase/);
  assert.match(settingsDialog, /triliumCancelButton\.classList\.toggle\('hidden', !importingTrilium \|\| triliumApplyStarted\)/);
  assert.match(cancelFlow, /triliumApplyStarted\) return/);
});

test('preload exposes only the bounded Trilium prepare, image resolve, apply, cancel, and progress channels', async () => {
  const [preload, types] = await Promise.all([
    source('src/main/preload.ts'),
    source('src/shared/types.ts'),
  ]);
  const settingsApi = between(preload, 'const settingsApi: SettingsApi = {', 'const proxyApi: ProxyApi = {');

  assert.match(settingsApi, /prepareTriliumImport: \(input: TriliumImportPrepareInput\) =>\s*ipcRenderer\.invoke\('settings:notes:trilium-import:prepare', input\)/);
  assert.match(settingsApi, /resolveTriliumImportImages: \(input: TriliumImportResolveImagesInput\) =>\s*ipcRenderer\.invoke\('settings:notes:trilium-import:resolve-images', input\)/);
  assert.match(settingsApi, /applyTriliumImport: \(input: TriliumImportApplyInput\) =>\s*ipcRenderer\.invoke\('settings:notes:trilium-import:apply', input\)/);
  assert.match(settingsApi, /cancelTriliumImport: \(requestId: string\) =>\s*ipcRenderer\.invoke\('settings:notes:trilium-import:cancel', requestId\)/);
  assert.match(settingsApi, /onTriliumImportProgress:[\s\S]*?ipcRenderer\.on\('settings:notes:trilium-import:progress', wrapped\)[\s\S]*?removeListener\('settings:notes:trilium-import:progress', wrapped\)/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\('settingsApi', settingsApi\)/);
  assert.match(types, /interface SettingsApi \{[\s\S]*?prepareTriliumImport:[\s\S]*?resolveTriliumImportImages:[\s\S]*?applyTriliumImport:[\s\S]*?cancelTriliumImport:[\s\S]*?onTriliumImportProgress:/);
  assert.match(types, /interface PersistentDataReloaded \{\s*generation: number;\s*source: 's3' \| 'trilium';[\s\S]*?persistentApplyId\?: string;[\s\S]*?hostsChanged\?: boolean;[\s\S]*?notesDelta\?: NotesWorkspaceDelta;\s*\}/);
});

test('main process owns Trilium preparation sessions and applies each import atomically before one sync marker and reload', async () => {
  const [main, s3Sync] = await Promise.all([
    source('src/main/main.ts'),
    source('src/main/s3Sync.ts'),
  ]);
  const prepareHandler = between(
    main,
    'ipcMain.handle(IPC_CHANNELS.triliumImportPrepare',
    'ipcMain.handle(IPC_CHANNELS.triliumImportResolveImages',
  );
  const resolveHandler = between(
    main,
    'ipcMain.handle(IPC_CHANNELS.triliumImportResolveImages',
    'ipcMain.handle(IPC_CHANNELS.triliumImportApply',
  );
  const applyHandler = between(
    main,
    'ipcMain.handle(IPC_CHANNELS.triliumImportApply',
    'ipcMain.handle(IPC_CHANNELS.triliumImportCancel',
  );
  const cancelHandler = between(
    main,
    'ipcMain.handle(IPC_CHANNELS.triliumImportCancel',
    'ipcMain.handle(IPC_CHANNELS.llmSettingsGet',
  );
  const importState = between(
    main,
    'const activeTriliumImportRequests',
    'const autoStartAbortController',
  );
  const sessionHelpers = between(
    main,
    'function clearPreparedTriliumToken',
    'function triliumImageNoteHtml',
  );
  const convertedImageValidation = between(
    main,
    'function richTextImageIdentities(',
    'function trackTriliumImportTask',
  );

  assert.match(main, /triliumImportPrepare: 'settings:notes:trilium-import:prepare'/);
  assert.match(main, /triliumImportResolveImages: 'settings:notes:trilium-import:resolve-images'/);
  assert.match(main, /triliumImportApply: 'settings:notes:trilium-import:apply'/);
  assert.match(main, /triliumImportCancel: 'settings:notes:trilium-import:cancel'/);
  assert.match(main, /triliumImportProgress: 'settings:notes:trilium-import:progress'/);
  assert.match(importState, /preparedTriliumImports = new Map<string, \{[\s\S]*?plan: TriliumImportPlan;[\s\S]*?controller: AbortController;[\s\S]*?tokenBuffer\?: Buffer;[\s\S]*?resolvedImages\?: TriliumResolvedImageAsset\[\];[\s\S]*?s3ImageTarget\?: string;[\s\S]*?resolvingImages: boolean;[\s\S]*?expiresAt: number;/);
  assert.match(importState, /TRILIUM_IMPORT_SESSION_TTL_MS = 10 \* 60 \* 1_000/);
  assert.match(sessionHelpers, /session\.tokenBuffer\?\.fill\(0\);\s*delete session\.tokenBuffer/);
  assert.match(sessionHelpers, /if \(abort\) session\.controller\.abort\(\);\s*clearPreparedTriliumToken\(session\);\s*preparedTriliumImports\.delete\(sessionId\)/);
  assert.match(sessionHelpers, /if \(session\.expiresAt > now\) continue;\s*removePreparedTriliumImport\(sessionId, true\);\s*activeTriliumImportRequests\.delete\(session\.requestId\)/);

  assert.match(prepareHandler, /validateTriliumImportPrepare\(inputValue\)/);
  assert.match(prepareHandler, /if \(activeTriliumImportRequests\.size > 0\)[\s\S]*?Another Trilium import is already being prepared/);
  assert.match(prepareHandler, /activeTriliumImportRequests\.set\(input\.requestId, \{ senderId: event\.sender\.id, controller \}\)/);
  const prepareFlush = prepareHandler.indexOf('await flushRendererNotes();');
  const prepareFetch = prepareHandler.indexOf('await prepareTriliumImportPlan({');
  assert.ok(prepareFlush >= 0 && prepareFlush < prepareFetch);
  assert.match(prepareHandler, /const tokenBuffer = Buffer\.from\(input\.etapiToken, 'utf8'\);\s*let retainedSession = false/);
  assert.match(prepareHandler, /session\.senderId === event\.sender\.id[\s\S]*?removePreparedTriliumImport\(sessionId, true\)/);
  assert.match(prepareHandler, /triliumStoredSourceVersion\(note\.tags\)[\s\S]*?knownSourceVersions\[note\.id\] = version/);
  assert.match(prepareHandler, /token: input\.etapiToken,[\s\S]*?signal: controller\.signal,[\s\S]*?knownSourceVersions/);
  assert.match(prepareHandler, /preparedTriliumImports\.set\(sessionId, \{[\s\S]*?senderId: event\.sender\.id,[\s\S]*?requestId: input\.requestId,[\s\S]*?plan,[\s\S]*?controller,[\s\S]*?tokenBuffer,[\s\S]*?resolvingImages: false,[\s\S]*?expiresAt:/);
  assert.match(prepareHandler, /preparedTriliumImports\.set\([\s\S]*?retainedSession = true/);
  assert.match(prepareHandler, /htmlNotes: triliumHtmlNotes\(plan\)/);
  assert.match(prepareHandler, /imageTargetCount: plan\.imageTargets\.length/);
  assert.doesNotMatch(prepareHandler.slice(prepareHandler.indexOf('      return {')), /etapiToken|token:/);
  assert.match(prepareHandler, /finally \{\s*if \(!retainedSession\) \{\s*tokenBuffer\.fill\(0\);[\s\S]*?active\?\.controller === controller[\s\S]*?activeTriliumImportRequests\.delete\(input\.requestId\)/);

  assert.match(resolveHandler, /validateTriliumImportResolveImages\(inputValue\)/);
  assert.match(resolveHandler, /session\.senderId !== event\.sender\.id[\s\S]*?session\.requestId !== input\.requestId/);
  assert.match(resolveHandler, /if \(session\.resolvedImages\) \{[\s\S]*?assets: session\.resolvedImages[\s\S]*?status === 'placeholder'/);
  assert.match(resolveHandler, /if \(session\.resolvingImages \|\| !session\.tokenBuffer\)[\s\S]*?already being resolved/);
  assert.match(resolveHandler, /session\.resolvingImages = true/);
  assert.match(resolveHandler, /const initialSettings = await getS3SyncRuntime\(\)\.getSettings\(\);\s*const initialTarget = notesImageTarget\(initialSettings\)/);
  assert.match(resolveHandler, /await resolveTriliumImportImages\([\s\S]*?session\.tokenBuffer\?\.toString\('utf8'\) \?\? ''[\s\S]*?uploadNoteImage\(upload, context\.signal\)[\s\S]*?signal: session\.controller\.signal/);
  assert.match(resolveHandler, /phase: 'images'/);
  assert.match(main, /function formatTriliumImageTransferProgress\(transferredBytes: number\): string/);
  assert.match(resolveHandler, /formatTriliumImageTransferProgress\(progress\.transferredBytes\)/);
  assert.match(resolveHandler, /const uploaded = images\.some\(\(asset\) => asset\.status === 'uploaded'\);[\s\S]*?const finalSettings = await getS3SyncRuntime\(\)\.getSettings\(\);[\s\S]*?notesImageTarget\(finalSettings\) !== initialTarget[\s\S]*?S3 settings changed during the Trilium image import/);
  assert.match(resolveHandler, /session\.resolvedImages = images;\s*if \(uploaded\) session\.s3ImageTarget = initialTarget;\s*clearPreparedTriliumToken\(session\)/);
  assert.match(resolveHandler, /catch \(error\) \{\s*removePreparedTriliumImport\(input\.sessionId, true\);\s*activeTriliumImportRequests\.delete\(input\.requestId\);\s*throw error;\s*\} finally \{\s*session\.resolvingImages = false/);
  assert.doesNotMatch(resolveHandler, /assets:.*bytes|etapiToken/);
  assert.match(s3Sync, /public async uploadNoteImage\(value: unknown, signal\?: AbortSignal\): Promise<NoteImageUploadResult>[\s\S]*?this\.shuttingDown \|\| signal\?\.aborted[\s\S]*?createNotesImageStore\(settings, signal\)/);

  assert.match(applyHandler, /session\.senderId !== event\.sender\.id[\s\S]*?session\.requestId !== input\.requestId/);
  assert.match(applyHandler, /if \(!session\.resolvedImages\)[\s\S]*?Resolve the Trilium images before applying the import/);
  assert.match(applyHandler, /const expectedHtmlIds = session\.plan\.notes[\s\S]*?filter\(\(note\) => note\.content\.kind === 'html' \|\| note\.content\.kind === 'image'\)/);
  assert.match(applyHandler, /const convertedIds = input\.convertedNotes[\s\S]*?isDeepStrictEqual\(expectedHtmlIds, convertedIds\)/);
  assert.match(applyHandler, /validateConvertedTriliumImages\(session\.plan, session\.resolvedImages, input\.convertedNotes\)/);
  assert.match(applyHandler, /removePreparedTriliumImport\(input\.sessionId\)/);
  const applyFlush = applyHandler.indexOf('await prepareRendererNotesPersistentApply();');
  const sharedMutation = applyHandler.indexOf('await runS3SharedDataMutation(async () => {');
  assert.ok(applyFlush >= 0 && applyFlush < sharedMutation);
  assert.match(applyHandler.slice(applyFlush, sharedMutation), /if \(session\.s3ImageTarget\)[\s\S]*?notesImageTarget\(settings\) !== session\.s3ImageTarget[\s\S]*?S3 settings changed after the Trilium images were imported/);
  assert.match(applyHandler, /const previousNotes = getNotesStore\(\)\.exportSnapshot\(\);[\s\S]*?const previousTombstones = getNotesStore\(\)\.exportTombstones\(\);[\s\S]*?const previousTree = getNotesTreeStore\(\)\.snapshot\(\);[\s\S]*?const previousExpanded = getNotesTreeViewStore\(\)\.snapshot\(\)\.expandedNoteIds/);
  assert.match(applyHandler, /try \{[\s\S]*?notesDelta = await getNotesWorkspaceApplyCoordinator\(\)\.replace\(\{\s*notes: merged\.notes,\s*tombstones: merged\.tombstones,\s*tree: merged\.tree,\s*\}\);[\s\S]*?\} catch \(error\) \{\s*await restoreNotesWorkspace\(previousNotes, previousTombstones, previousTree, previousExpanded\);\s*throw error;/);
  assert.equal((applyHandler.match(/s3SyncRuntime\?\.markLocalChange\(\)/g) ?? []).length, 1);
  assert.match(applyHandler, /if \(notesChanged \|\| treeChanged\) \{[\s\S]*?s3SyncRuntime\?\.markLocalChange\(\)/);
  assert.match(applyHandler, /if \(applied\.changed\) \{[\s\S]*?reloadOwnsRelease = publishPersistentDataReload\('trilium', rendererApply, \{[\s\S]*?notesDelta: applied\.notesDelta/);
  assert.match(applyHandler, /finally \{\s*if \(!reloadOwnsRelease\) releaseRendererNotesPersistentApply\(rendererApply\);/);
  assert.match(applyHandler, /phase: 'complete'[\s\S]*?message: `Imported \$\{result\.total\} Notes\.`/);
  assert.match(applyHandler, /imagePlaceholderCount: input\.convertedNotes\.reduce\([\s\S]*?note\.imagePlaceholderCount/);
  assert.match(applyHandler, /finally \{[\s\S]*?active\?\.controller === session\.controller[\s\S]*?activeTriliumImportRequests\.delete\(input\.requestId\)/);

  assert.match(convertedImageValidation, /note\.content\.kind === 'html'[\s\S]*?note\.content\.kind === 'image'/);
  assert.match(convertedImageValidation, /converted\.embeddedImageCount !== expected\.images[\s\S]*?converted\.imagePlaceholderCount !== expected\.placeholders/);
  assert.match(convertedImageValidation, /parseRichTextContent\(content\)[\s\S]*?node\.type === 's3Image'[\s\S]*?parseNoteImageNodeAttributes\(node\.attrs\)/);
  assert.match(convertedImageValidation, /actual\.some\(\(identity\) => !allowed\.has\(identity\)\)[\s\S]*?unexpected reference/);
  assert.match(convertedImageValidation, /\[\.\.\.allowed\]\.some\(\(identity\) => !used\.has\(identity\)\)[\s\S]*?converted Trilium images are incomplete/);

  assert.match(cancelHandler, /const active = activeTriliumImportRequests\.get\(requestId\)/);
  assert.match(cancelHandler, /if \(active\?\.senderId === event\.sender\.id\) active\.controller\.abort\(\)/);
  assert.match(cancelHandler, /session\.senderId === event\.sender\.id && session\.requestId === requestId[\s\S]*?removePreparedTriliumImport\(sessionId, true\)/);
  assert.match(cancelHandler, /await Promise\.allSettled\(\[\.\.\.activeTriliumImportTasks\]\);\s*activeTriliumImportRequests\.delete\(requestId\)/);
  assert.match(main, /async function shutdownRuntimesForQuit\(\)[\s\S]*?for \(const \{ controller \} of activeTriliumImportRequests\.values\(\)\) controller\.abort\(\);[\s\S]*?await Promise\.allSettled\(\[\.\.\.activeTriliumImportTasks\]\);[\s\S]*?for \(const sessionId of \[\.\.\.preparedTriliumImports\.keys\(\)\]\) removePreparedTriliumImport\(sessionId\)/);
  assert.match(main, /app\.on\('render-process-gone'[\s\S]*?active\.senderId !== webContents\.id[\s\S]*?active\.controller\.abort\(\)[\s\S]*?session\.senderId === webContents\.id[\s\S]*?removePreparedTriliumImport\(sessionId, true\)/);
});

test('persistent-data reload applies precise Notes deltas and reloads Hosts only when changed', async () => {
  const [renderer, main] = await Promise.all([
    source('src/renderer/renderer.ts'),
    source('src/main/main.ts'),
  ]);
  const reloadHandler = between(
    renderer,
    'window.settingsApi.onPersistentDataReloaded((event) => {',
    '(async function init()',
  );
  assert.match(reloadHandler, /event\.notesDelta\s*\? applyNotesPageDelta\(event\.notesDelta, event\.persistentApplyId\)/);
  assert.match(reloadHandler, /event\.persistentApplyId\s*\? reloadNotesPage\(event\.persistentApplyId\)/);
  assert.match(reloadHandler, /event\.hostsChanged\s*\? Promise\.all\(\[loadHosts\(\), notesUpdate\]\)/);
  assert.doesNotMatch(reloadHandler, /event\.source ===/);
  assert.match(main, /function publishPersistentDataReload\([\s\S]*?source: 's3' \| 'trilium'[\s\S]*?hostsChanged\?: boolean; notesDelta\?: NotesWorkspaceDelta[\s\S]*?persistentApplyId: apply\.id/);
  assert.match(main, /publishPersistentDataReload\('s3', rendererApply, \{[\s\S]*?hostsChanged[\s\S]*?notesDelta/);
  assert.doesNotMatch(main, /onDataApplied:/);
});

test('Trilium HTML conversion uses the live Tiptap schema, strips active content, and canonicalizes links and fallback text', async () => {
  const editor = await source('src/renderer/notesRichTextEditor.ts');
  const extensionFactory = between(
    editor,
    'function createNotesRichTextExtensions(',
    'export interface TriliumHtmlConversionResult',
  );
  const conversion = between(
    editor,
    'export function convertTriliumHtmlToRichText(',
    '/** Small renderer adapter',
  );
  const fallback = between(
    editor,
    'function richTextPlainTextFallback(',
    '/** Convert a Trilium HTML fragment',
  );
  const liveEditor = between(editor, 'public constructor(options: NotesRichTextEditorOptions)', '  public setContent(');

  assert.match(extensionFactory, /StarterKit\.configure\(/);
  assert.match(extensionFactory, /TableKit\.configure\(/);
  assert.match(extensionFactory, /createTaskListExtension\(\)/);
  assert.match(extensionFactory, /createS3ImageExtension\(onError, onLayoutChange, importImages, importToken\)/);
  assert.match(liveEditor, /extensions: createNotesRichTextExtensions\(\s*this\.onError,/);
  assert.match(conversion, /new DOMParser\(\)\.parseFromString\(html, 'text\/html'\)/);
  assert.match(conversion, /script,style,iframe,object,embed,form,input,button,textarea,select,meta,link/);
  assert.match(conversion, /querySelectorAll\('\[data-trilium-import-image\]'\)[\s\S]*?removeAttribute\('data-trilium-import-image'\)/);
  assert.match(conversion, /adaptTriliumImages\(parsed\.body, endpoint, imageAssets, importToken\)/);
  assert.match(conversion, /querySelectorAll\('a\[href\]'\)[\s\S]*?new URL\(href, endpointBase\)[\s\S]*?isAllowedRichTextLinkHref\(absolute\.href\)[\s\S]*?anchor\.setAttribute\('href', absolute\.href\)/);
  assert.match(conversion, /catch \{\s*anchor\.removeAttribute\('href'\);\s*anchor\.removeAttribute\('target'\);\s*anchor\.removeAttribute\('rel'\)/);
  assert.match(conversion, /generateJSON\(\s*parsed\.body\.innerHTML,\s*createNotesRichTextExtensions\(/);
  assert.match(conversion, /const content = normalizeEditorContent\(generated\);\s*assertImportedImagesRetained\(content, adaptedImages\.attributes\)/);
  assert.match(conversion, /content: richTextPlainTextFallback\(parsed\.body\.textContent \?\? ''\)[\s\S]*?usedPlainTextFallback: true/);
  assert.doesNotMatch(conversion, /\bfetch\s*\(|window\.settingsApi|innerHTML\s*=/);
  assert.match(fallback, /replace\(\/\[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\]\/g, ''\)/);
  assert.match(fallback, /slice\(0, 750_000\)/);
  assert.match(fallback, /return normalizeRichTextContent\(\{ type: 'doc', content: paragraphs \}\)/);
});
