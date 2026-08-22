import { flushSentry } from './sentry';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, safeStorage, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs, type Stats } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  parseNoteAttachmentReference,
  parseNoteImageNodeAttributes,
  parseRichTextContent,
  type NoteImageReference,
  type RichTextNode,
} from '../shared/noteRichText';
import type {
  ConfigTransferResult,
  ConfirmDialogOptions,
  ForwardState,
  HostConfig,
  HostDraft,
  Note,
  NoteDeleteInput,
  NoteDeletePreview,
  NoteDraft,
  NoteDraftRecoveryInput,
  NoteExportInput,
  NotePlacementInput,
  NoteMoveInput,
  NoteShareCreateInput,
  NoteShareDurationHours,
  NoteShareResignInput,
  NoteSummary,
  NoteTreeExpansionRequest,
  NotesWorkspaceSnapshot,
  NotesWorkspaceDelta,
  LlmModelsDraft,
  PrivateKeyImportResult,
  ServiceConfig,
  ServiceRefreshOptions,
  ServiceLogsResult,
  ServiceStatus,
  ServiceStatusChange,
  TunnelStatusChange,
  UpdateState,
  KubernetesLogUpdate,
  KubernetesLogScope,
  KubernetesNamespaceScope,
  KubernetesPodTarget,
  KubernetesPortForwardInput,
  KubernetesRelatedResourceRequest,
  KubernetesResourceQuery,
  KubernetesState,
  KubernetesTerminalState,
  KubernetesTerminalOutput,
  KubernetesListSnapshot,
  KubernetesPortForwardState,
  TriliumImportApplyInput,
  TriliumImportImageAsset,
  TriliumImportPrepareInput,
  TriliumImportProgress as RendererTriliumImportProgress,
  TriliumImportResolveImagesInput,
  TriliumImportResult,
  KubernetesVncLaunchResult,
  KubernetesVncTarget,
  StartupS3SyncState,
} from '../shared/types';
import {
  buildNotePrintDocument,
  richTextToMarkdown,
  richTextToSafeHtml,
} from '../shared/noteExport';
import {
  createSafeNoteFilename,
  renderMarkdownToSafeHtml,
} from '../shared/notesMarkdown';
import { highlightSafeNoteCodeBlocks } from './noteCodeHighlight';
import { ServiceStore } from './store';
import {
  checkHostServicesStatus,
  checkServiceStatus,
  getServiceLogs,
  setServiceRuntimeDiagnostics,
  startService,
  stopService,
  type HostServiceStatusResult,
} from './serviceRuntime';
import { RuntimeLogWriter } from './runtimeLog';
import { PortForwardManager } from './portForwardManager';
import { TunnelManager } from './tunnelManager';
import { AppUpdater } from './updater';
import { forwardToRuntimeConfig } from './hostConnection';
import { KeyedOperationQueue } from './operationQueue';
import {
  countRules,
  countServices,
  ensureUniqueImportedIds,
  type ExportedConfigFile,
  parseImportedHostDrafts,
} from './configTransfer';
import { RuntimeRegistry } from './runtimeRegistry';
import { preserveServiceRuntimeFields, validateHostDraft } from './validation';
import { ProxyRuntime } from './proxy/proxyRuntime';
import { scheduleProxyAutoStart } from './proxy/proxyAutoStart';
import { collectAppMemoryUsage } from './appMemory';
import type { ProxyExceptionDraft, ProxyMode, ProxyState, ProxyTraffic } from '../shared/types';
import { KubernetesRuntime } from './kubernetes/kubernetesRuntime';
import { FileKubernetesContextPreference } from './kubernetes/contextPreference';
import { validateKubernetesTerminalInput } from './kubernetes/terminalInput';
import { AppQuitCoordinator } from './quitCoordinator';
import {
  NOTE_LIMITS,
  NotesStore,
  classifyNoteDraftRecovery,
  normalizeNoteDraft,
  normalizeNoteSnapshot,
  rankNoteIdsForSearch,
  type NoteTombstone,
  type NotesSnapshot,
} from './notesStore';
import { NotesTreeStore } from './notesTreeStore';
import { NotesTreeViewStore } from './notesTreeViewStore';
import { NotesWorkspaceApplyCoordinator } from './notesWorkspaceApply';
import { UiPreferencesStore } from './uiPreferencesStore';
import { LlmSettingsStore } from './llmSettingsStore';
import { fetchLlmModels } from './llmModels';
import { SqlCredentialsStore } from './sqlCredentialsStore';
import { SqlRuntime } from './sqlRuntime';
import {
  S3SyncRuntime,
  type S3LocalChange,
  type S3NotesIncrementalIntent,
  type S3NotesIncrementalSnapshot,
} from './s3Sync';
import {
  createNotesAttachmentPreview,
  noteAttachmentPreviewKind,
} from './notesAttachmentPreview';
import {
  acquireUserDataInstanceLock,
  assertUserDataInstanceLockAvailable,
  UserDataInstanceLockError,
  type UserDataInstanceLock,
} from './userDataInstanceLock';
import {
  createS3SharedAppData,
  stageS3SharedAppDataForLocalApply,
  type S3SharedAppData,
} from './s3DataMerge';
import {
  mergeTriliumImport,
  prepareTriliumImport as prepareTriliumImportPlan,
  resolveTriliumImportImages,
  TRILIUM_IMPORT_MAX_TOTAL_IMAGE_BYTES,
  triliumStoredSourceVersion,
  type TriliumImportPlan,
  type TriliumImportProgress,
  type TriliumResolvedImageAsset,
} from './triliumImport';
import { buildChangelogView, ChangelogSeenStore } from './changelog';

const IPC_CHANNELS = {
  listHosts: 'host:list',
  saveHost: 'host:save',
  deleteHost: 'host:delete',
  exportConfig: 'config:export',
  importConfig: 'config:import',
  deleteService: 'service:delete',
  deleteForward: 'forward:delete',
  startService: 'service:start',
  stopService: 'service:stop',
  startForward: 'forward:start',
  stopForward: 'forward:stop',
  refreshService: 'service:refresh',
  refreshHostServices: 'service:refresh-host',
  getServiceLogs: 'service:logs',
  serviceStatusChanged: 'service:status',
  serviceStatusBatchChanged: 'service:status-batch',
  forwardStatusChanged: 'forward:status',
  importPrivateKey: 'auth:import-private-key',
  openExternal: 'app:open-external',
  readClipboardText: 'clipboard:read-text',
  writeClipboardText: 'clipboard:write-text',
  confirmAction: 'dialog:confirm',
  appCloseShortcutRequest: 'app:close-shortcut-request',
  appCloseShortcutResult: 'app:close-shortcut-result',
  getUpdateState: 'updater:get-state',
  checkUpdates: 'updater:check',
  updateState: 'updater:state',
  changelogGet: 'changelog:get',
  changelogMarkSeen: 'changelog:mark-seen',
  appMemoryUsage: 'app:memory-usage',
  notesList: 'notes:list',
  notesWorkspace: 'notes:workspace',
  notesGet: 'notes:get',
  notesSearch: 'notes:search',
  notesCreate: 'notes:create',
  notesUpdate: 'notes:update',
  notesMove: 'notes:move',
  notesTreeExpanded: 'notes:tree-expanded',
  notesDeletePreview: 'notes:delete-preview',
  notesDelete: 'notes:delete',
  notesRecoverDrafts: 'notes:recover-drafts',
  notesImageUpload: 'notes:image:upload',
  notesImageLoad: 'notes:image:load',
  notesAttachmentUpload: 'notes:attachment:upload',
  notesAttachmentView: 'notes:attachment:view',
  notesAttachmentDownload: 'notes:attachment:download',
  notesExport: 'notes:export',
  notesExportOpenLast: 'notes:export:open-last',
  notesSharesList: 'notes:shares:list',
  notesSharesCreate: 'notes:shares:create',
  notesSharesResign: 'notes:shares:resign',
  notesSharesDelete: 'notes:shares:delete',
  notesFlushRequest: 'notes:flush-request',
  notesFlushResult: 'notes:flush-result',
  notesPersistentApplyRelease: 'notes:persistent-apply-release',
  uiPreferencesGet: 'settings:ui:get',
  uiPreferencesSave: 'settings:ui:save',
  uiPreferencesNotesSidebarWidthSave: 'settings:ui:notes-sidebar-width:save',
  uiPreferencesChanged: 'settings:ui:changed',
  triliumImportPrepare: 'settings:notes:trilium-import:prepare',
  triliumImportResolveImages: 'settings:notes:trilium-import:resolve-images',
  triliumImportApply: 'settings:notes:trilium-import:apply',
  triliumImportCancel: 'settings:notes:trilium-import:cancel',
  triliumImportProgress: 'settings:notes:trilium-import:progress',
  llmSettingsGet: 'settings:llm:get',
  llmSettingsSave: 'settings:llm:save',
  llmSettingsReveal: 'settings:llm:reveal-token',
  llmModelsList: 'settings:llm:list-models',
  sqlAuthState: 'sql:auth-state',
  sqlLogin: 'sql:login',
  sqlLogout: 'sql:logout',
  sqlQueriesList: 'sql:queries:list',
  sqlQueryGet: 'sql:query:get',
  sqlQueryCreate: 'sql:query:create',
  sqlQueryUpdate: 'sql:query:update',
  sqlQueryRename: 'sql:query:rename',
  sqlQueryDelete: 'sql:query:delete',
  sqlExecute: 'sql:execute',
  sqlSchemaGet: 'sql:schema:get',
  s3SettingsGet: 'settings:s3:get',
  s3SettingsSave: 'settings:s3:save',
  s3SettingsTest: 'settings:s3:test',
  s3SettingsReveal: 'settings:s3:reveal-credentials',
  s3Sync: 'settings:s3:sync',
  s3SyncState: 'settings:s3:state',
  startupS3SyncGet: 'app:startup-s3-sync:get',
  startupS3SyncState: 'app:startup-s3-sync:state',
  persistentDataReloaded: 'app:persistent-data-reloaded',
  proxyGetState: 'proxy:get-state',
  proxyDownloadCore: 'proxy:download-core',
  proxyStart: 'proxy:start',
  proxyStop: 'proxy:stop',
  proxySaveAndFetchSubscription: 'proxy:save-and-fetch-subscription',
  proxySetMode: 'proxy:set-mode',
  proxySetSystemProxy: 'proxy:set-system-proxy',
  proxySetTun: 'proxy:set-tun',
  proxyAddException: 'proxy:add-exception',
  proxyUpdateException: 'proxy:update-exception',
  proxyDeleteException: 'proxy:delete-exception',
  proxyGrantTun: 'proxy:grant-tun',
  proxyRevokeTun: 'proxy:revoke-tun',
  proxyListProxies: 'proxy:list-proxies',
  proxyTestDelays: 'proxy:test-delays',
  proxySelectProxy: 'proxy:select-proxy',
  proxyGetLogs: 'proxy:get-logs',
  proxyStateChanged: 'proxy:state',
  proxyTrafficChanged: 'proxy:traffic',
  kubernetesGetState: 'kubernetes:get-state',
  kubernetesSelectContext: 'kubernetes:select-context',
  kubernetesReconnect: 'kubernetes:reconnect',
  kubernetesReloadKubeconfig: 'kubernetes:reload-kubeconfig',
  kubernetesSetNamespaceScope: 'kubernetes:set-namespace-scope',
  kubernetesListNamespaces: 'kubernetes:list-namespaces',
  kubernetesListResources: 'kubernetes:list-resources',
  kubernetesGetResourceWindow: 'kubernetes:get-resource-window',
  kubernetesLoadMoreResources: 'kubernetes:load-more-resources',
  kubernetesListCustomResourceDefinitions: 'kubernetes:list-custom-resource-definitions',
  kubernetesGetResourceDetail: 'kubernetes:get-resource-detail',
  kubernetesGetResourceEvents: 'kubernetes:get-resource-events',
  kubernetesGetRelatedResources: 'kubernetes:related-resources',
  kubernetesGetPodEnvironment: 'kubernetes:get-pod-environment',
  kubernetesOpenLogs: 'kubernetes:open-logs',
  kubernetesLoadOlderLogs: 'kubernetes:load-older-logs',
  kubernetesSetLogScope: 'kubernetes:set-log-scope',
  kubernetesSetLogStartTime: 'kubernetes:set-log-start-time',
  kubernetesSetLogFollowing: 'kubernetes:set-log-following',
  kubernetesClearLogs: 'kubernetes:clear-logs',
  kubernetesCloseLogs: 'kubernetes:close-logs',
  kubernetesOpenTerminal: 'kubernetes:open-terminal',
  kubernetesWriteTerminal: 'kubernetes:write-terminal',
  kubernetesResizeTerminal: 'kubernetes:resize-terminal',
  kubernetesCloseTerminal: 'kubernetes:close-terminal',
  kubernetesOpenVnc: 'kubernetes:open-vnc',
  kubernetesStartPortForward: 'kubernetes:start-port-forward',
  kubernetesStopPortForward: 'kubernetes:stop-port-forward',
  kubernetesStopAllPortForwards: 'kubernetes:stop-all-port-forwards',
  kubernetesListPortForwards: 'kubernetes:list-port-forwards',
  kubernetesDeactivatePage: 'kubernetes:deactivate-page',
  kubernetesStateChanged: 'kubernetes:state',
  kubernetesListChanged: 'kubernetes:list',
  kubernetesLogChanged: 'kubernetes:log',
  kubernetesTerminalChanged: 'kubernetes:terminal',
  kubernetesTerminalOutput: 'kubernetes:terminal-output',
  kubernetesPortForwardChanged: 'kubernetes:port-forward',
} as const;

const forwardOwners = new Map<string, string>();
let store: ServiceStore | null = null;
let notesStore: NotesStore | null = null;
let notesTreeStore: NotesTreeStore | null = null;
let notesTreeViewStore: NotesTreeViewStore | null = null;
let notesWorkspaceApplyCoordinator: NotesWorkspaceApplyCoordinator | null = null;
let uiPreferencesStore: UiPreferencesStore | null = null;
let llmSettingsStore: LlmSettingsStore | null = null;
let changelogSeenStore: ChangelogSeenStore | null = null;
let sqlRuntime: SqlRuntime | null = null;
let s3SyncRuntime: S3SyncRuntime | null = null;
let proxyRuntime: ProxyRuntime | null = null;
let kubernetesRuntime: KubernetesRuntime | null = null;
let runtimeLogWriter: RuntimeLogWriter | null = null;
const rendererWindows = new Set<BrowserWindow>();
const NOTES_PDF_RENDER_TIMEOUT_MS = 30_000;
const NOTES_PDF_MAX_DOCUMENT_BYTES = 6 * 1024 * 1024;
const NOTES_PDF_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const NOTES_PDF_MAX_STRUCTURAL_BLOCKS = 50_000;
const NOTES_PDF_MAX_TABLE_ROWS = 10_000;
const NOTES_PDF_MAX_APPROXIMATE_PAGES = 400;
const NOTES_PDF_APPROXIMATE_CHARACTERS_PER_PAGE = 5_000;
const NOTES_PDF_APPROXIMATE_BLOCKS_PER_PAGE = 80;
const NOTES_PDF_APPROXIMATE_TABLE_ROWS_PER_PAGE = 40;
const NOTE_EXPORT_OPEN_TTL_MS = 60_000;
let notesPdfExportActive = false;
const rendererExportGenerations = new Map<number, number>();
const recentNoteExports = new Map<number, {
  filePath: string;
  format: NoteExportInput['format'];
  device: number;
  inode: number;
  expiresAt: number;
  rendererGeneration: number;
  timeout: ReturnType<typeof setTimeout>;
}>();
let persistentDataGeneration = 0;
let s3SharedDataMutationQueue: Promise<void> = Promise.resolve();
let notesWorkspaceUnsafe = false;
const RENDERER_NOTES_FLUSH_TIMEOUT_MS = 2_000;
const pendingRendererNotesFlushes = new Map<string, {
  senderId: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
}>();
const CLOSE_SHORTCUT_RESPONSE_TIMEOUT_MS = 5_000;
const pendingCloseShortcutRequests = new Map<string, {
  senderId: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (handled: boolean) => void;
}>();
const activeLlmModelRequests = new Set<AbortController>();
const activeTriliumImportRequests = new Map<string, { senderId: number; controller: AbortController }>();
const activeTriliumImportTasks = new Set<Promise<void>>();
const preparedTriliumImports = new Map<string, {
  senderId: number;
  requestId: string;
  plan: TriliumImportPlan;
  controller: AbortController;
  tokenBuffer?: Buffer;
  resolvedImages?: TriliumResolvedImageAsset[];
  s3ImageTarget?: string;
  resolvingImages: boolean;
  expiresAt: number;
}>();
const TRILIUM_IMPORT_SESSION_TTL_MS = 10 * 60 * 1_000;
const autoStartAbortController = new AbortController();
const runtimeRegistry = new RuntimeRegistry();
const serviceOperationQueue = new KeyedOperationQueue();
const portForwardManager = new PortForwardManager();
const tunnelManager = new TunnelManager();
let updater: AppUpdater;
let quitCoordinator: AppQuitCoordinator;
const APP_DISPLAY_NAME = 'Service Manager';
const APP_ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const FINAL_PROCESS_EXIT_DELAY_MS = 1_500;
app.setName(APP_DISPLAY_NAME);
app.setAboutPanelOptions({
  applicationName: APP_DISPLAY_NAME,
});

function getStore(): ServiceStore {
  if (!store) {
    throw new Error('Service store is not initialized.');
  }
  return store;
}

function attachmentActionFailure(status: 'not-configured' | 'missing' | 'error') {
  return { status } as const;
}

function validateNoteExportInput(value: unknown): NoteExportInput {
  if (
    !isRecord(value)
    || typeof value.title !== 'string'
    || value.title.length > NOTE_LIMITS.nameCharacters
    || typeof value.content !== 'string'
    || value.content.length > NOTE_LIMITS.contentCharacters
    || (value.language !== 'richtext' && value.language !== 'markdown')
    || (value.format !== 'pdf' && value.format !== 'markdown')
    || Object.keys(value).some((key) => !['title', 'language', 'content', 'format'].includes(key))
  ) {
    throw new Error('The Note export request is invalid.');
  }
  if (value.language === 'richtext') parseRichTextContent(value.content);
  return value as unknown as NoteExportInput;
}

function validateNoteShareDuration(value: unknown): NoteShareDurationHours {
  if (value !== 24 && value !== 72 && value !== 168) {
    throw new Error('The Note share expiry must be 24 hours, 3 days, or 7 days.');
  }
  return value;
}

function validateNoteShareId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new Error('The Note share ID is invalid.');
  }
  return value;
}

function validateNoteShareCreateInput(value: unknown): NoteShareCreateInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !['noteId', 'expiresInHours'].includes(key))) {
    throw new Error('The Note share request is invalid.');
  }
  return {
    noteId: validateNoteId(value.noteId),
    expiresInHours: validateNoteShareDuration(value.expiresInHours),
  };
}

function validateNoteShareResignInput(value: unknown): NoteShareResignInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !['noteId', 'shareId', 'expiresInHours'].includes(key))) {
    throw new Error('The Note share request is invalid.');
  }
  return {
    noteId: validateNoteId(value.noteId),
    shareId: validateNoteShareId(value.shareId),
    expiresInHours: validateNoteShareDuration(value.expiresInHours),
  };
}

function validateNoteShareDeleteInput(value: unknown): { noteId: string; shareId: string } {
  if (!isRecord(value) || Object.keys(value).some((key) => !['noteId', 'shareId'].includes(key))) {
    throw new Error('The Note share request is invalid.');
  }
  return {
    noteId: validateNoteId(value.noteId),
    shareId: validateNoteShareId(value.shareId),
  };
}

function assertNotePdfComplexity(documentHtml: string): void {
  if (Buffer.byteLength(documentHtml, 'utf8') > NOTES_PDF_MAX_DOCUMENT_BYTES) {
    throw new Error('This Note is too large to export as PDF. Download it as Markdown instead.');
  }

  let structuralBlocks = 0;
  let tableRows = 0;
  const structuralTag = /<(p|h[1-6]|li|blockquote|pre|table|tr|figure|article|hr)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = structuralTag.exec(documentHtml)) !== null) {
    structuralBlocks += 1;
    if (match[1].toLocaleLowerCase() === 'tr') tableRows += 1;
    if (structuralBlocks > NOTES_PDF_MAX_STRUCTURAL_BLOCKS || tableRows > NOTES_PDF_MAX_TABLE_ROWS) {
      throw new Error('This Note is too complex to export as PDF. Download it as Markdown instead.');
    }
  }

  const approximatePages = Math.max(
    1,
    Math.ceil(documentHtml.length / NOTES_PDF_APPROXIMATE_CHARACTERS_PER_PAGE),
    Math.ceil(structuralBlocks / NOTES_PDF_APPROXIMATE_BLOCKS_PER_PAGE),
    Math.ceil(tableRows / NOTES_PDF_APPROXIMATE_TABLE_ROWS_PER_PAGE),
  );
  if (approximatePages > NOTES_PDF_MAX_APPROXIMATE_PAGES) {
    throw new Error('This Note is too long to export as PDF. Download it as Markdown instead.');
  }
}

async function withNotePdfRenderTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('The Note PDF export timed out.'));
        }, NOTES_PDF_RENDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function runNotePdfExportTask<T>(operation: () => Promise<T>): Promise<T> {
  if (notesPdfExportActive) throw new Error('Another Note PDF export is already in progress.');
  notesPdfExportActive = true;
  try {
    return await operation();
  } finally {
    notesPdfExportActive = false;
  }
}

async function renderNotePdf(documentHtml: string): Promise<Buffer> {
  assertNotePdfComplexity(documentHtml);
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      javascript: false,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    printWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    const pdf = await withNotePdfRenderTimeout((async () => {
      await printWindow.loadURL(`data:text/html;base64,${Buffer.from(documentHtml, 'utf8').toString('base64')}`);
      return printWindow.webContents.printToPDF({
        pageSize: 'A4',
        preferCSSPageSize: true,
        printBackground: true,
      });
    })());
    if (!Buffer.isBuffer(pdf) || pdf.byteLength < 1 || pdf.byteLength > NOTES_PDF_MAX_OUTPUT_BYTES) {
      throw new Error('The generated Note PDF exceeds the supported size.');
    }
    return pdf;
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
  }
}

function getNotesStore(): NotesStore {
  if (!notesStore) {
    throw new Error('Notes store is not initialized.');
  }
  return notesStore;
}

function getNotesTreeStore(): NotesTreeStore {
  if (!notesTreeStore) throw new Error('Notes tree is not initialized.');
  return notesTreeStore;
}

function getNotesTreeViewStore(): NotesTreeViewStore {
  if (!notesTreeViewStore) throw new Error('Notes tree view is not initialized.');
  return notesTreeViewStore;
}

function getNotesWorkspaceApplyCoordinator(): NotesWorkspaceApplyCoordinator {
  if (!notesWorkspaceApplyCoordinator) throw new Error('Notes workspace apply is not initialized.');
  return notesWorkspaceApplyCoordinator;
}

function getUiPreferencesStore(): UiPreferencesStore {
  if (!uiPreferencesStore) {
    throw new Error('UI preferences are not initialized.');
  }
  return uiPreferencesStore;
}

function getChangelogSeenStore(): ChangelogSeenStore {
  if (!changelogSeenStore) {
    throw new Error('Changelog store is not initialized.');
  }
  return changelogSeenStore;
}

function getLlmSettingsStore(): LlmSettingsStore {
  if (!llmSettingsStore) throw new Error('LLM settings are not initialized.');
  return llmSettingsStore;
}

function getSqlRuntime(): SqlRuntime {
  if (!sqlRuntime) throw new Error('SQL is not initialized.');
  return sqlRuntime;
}

function getS3SyncRuntime(): S3SyncRuntime {
  if (!s3SyncRuntime) {
    throw new Error('S3 sync is not initialized.');
  }
  return s3SyncRuntime;
}

function getProxyRuntime(): ProxyRuntime {
  if (!proxyRuntime) throw new Error('Proxy runtime is not initialized.');
  return proxyRuntime;
}

function runS3SharedDataMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = s3SharedDataMutationQueue.then(operation, operation);
  s3SharedDataMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function mutateS3SharedData<T>(operation: () => Promise<T>): Promise<T> {
  return runS3SharedDataMutation(async () => {
    const result = await operation();
    s3SyncRuntime?.markLocalChange();
    return result;
  });
}

function assertNotesWorkspaceSafe(): void {
  if (notesWorkspaceUnsafe) {
    throw new Error('The Notes workspace could not be restored completely. Restart the application before editing Notes.');
  }
}

function mutateNotesSharedData<T>(
  operation: () => Promise<T>,
  change: S3LocalChange | ((result: T) => S3LocalChange) = { kind: 'full' },
): Promise<T> {
  return runS3SharedDataMutation(async () => {
    assertNotesWorkspaceSafe();
    const result = await operation();
    s3SyncRuntime?.markLocalChange(typeof change === 'function' ? change(result) : change);
    return result;
  });
}

function notesWorkspaceSnapshot(): NotesWorkspaceSnapshot {
  assertNotesWorkspaceSafe();
  return {
    notes: getNotesStore().list().map(noteSummary),
    tree: getNotesTreeStore().snapshot(),
    expandedNoteIds: getNotesTreeViewStore().snapshot().expandedNoteIds,
  };
}

function noteSummary(note: Note): NoteSummary {
  const { content: _content, ...summary } = note;
  return { ...summary, tags: [...summary.tags] };
}

function validateNotePlacement(value: unknown, allowUndefined = false): NotePlacementInput {
  if (value === undefined && allowUndefined) return { parentId: null };
  if (!isRecord(value) || (value.parentId !== null && typeof value.parentId !== 'string')) {
    throw new Error('Note placement is invalid.');
  }
  if (value.beforeNoteId !== undefined && typeof value.beforeNoteId !== 'string') {
    throw new Error('Note placement is invalid.');
  }
  return {
    parentId: value.parentId as string | null,
    ...(typeof value.beforeNoteId === 'string' ? { beforeNoteId: value.beforeNoteId } : {}),
  };
}

function validateNoteMove(value: unknown): NoteMoveInput {
  const placement = validateNotePlacement(value);
  if (!isRecord(value) || typeof value.noteId !== 'string') throw new Error('Note move is invalid.');
  return { noteId: value.noteId, ...placement };
}

function validateNoteTreeExpansion(value: unknown): NoteTreeExpansionRequest {
  if (!isRecord(value) || typeof value.expanded !== 'boolean') {
    throw new Error('Note tree expansion is invalid.');
  }
  if (typeof value.noteId === 'string') {
    return { noteId: value.noteId, expanded: value.expanded };
  }
  if (Array.isArray(value.noteIds)
    && value.noteIds.length > 0
    && value.noteIds.length <= 32
    && value.noteIds.every((noteId) => typeof noteId === 'string')) {
    return { noteIds: value.noteIds, expanded: value.expanded };
  }
  throw new Error('Note tree expansion is invalid.');
}

function validateNoteId(value: unknown, label = 'Note ID'): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > NOTE_LIMITS.idCharacters
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function validateTriliumRequestId(value: unknown): string {
  if (typeof value !== 'string'
    || value.length < 8
    || value.length > 128
    || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('The Trilium import request is invalid.');
  }
  return value;
}

function validateTriliumImportPrepare(value: unknown): TriliumImportPrepareInput {
  if (!isRecord(value)
    || typeof value.endpoint !== 'string'
    || typeof value.etapiToken !== 'string'
    || (value.maxNotes !== undefined
      && (!Number.isInteger(value.maxNotes) || Number(value.maxNotes) < 1 || Number(value.maxNotes) > NOTE_LIMITS.notes))) {
    throw new Error('The Trilium import request is invalid.');
  }
  return {
    requestId: validateTriliumRequestId(value.requestId),
    endpoint: value.endpoint,
    etapiToken: value.etapiToken,
    ...(value.maxNotes !== undefined ? { maxNotes: Number(value.maxNotes) } : {}),
  };
}

function validateTriliumImportResolveImages(value: unknown): TriliumImportResolveImagesInput {
  if (!isRecord(value)
    || typeof value.sessionId !== 'string'
    || value.sessionId.length < 8
    || value.sessionId.length > 128
    || !/^[A-Za-z0-9_-]+$/.test(value.sessionId)) {
    throw new Error('The prepared Trilium image import is invalid.');
  }
  return {
    requestId: validateTriliumRequestId(value.requestId),
    sessionId: value.sessionId,
  };
}

function validateTriliumImportApply(value: unknown): TriliumImportApplyInput {
  if (!isRecord(value)
    || typeof value.sessionId !== 'string'
    || value.sessionId.length < 8
    || value.sessionId.length > 128
    || !/^[A-Za-z0-9_-]+$/.test(value.sessionId)
    || !Array.isArray(value.convertedNotes)
    || value.convertedNotes.length > NOTE_LIMITS.notes) {
    throw new Error('The prepared Trilium import is invalid.');
  }
  const noteIds = new Set<string>();
  const convertedNotes = value.convertedNotes.map((candidate) => {
    if (!isRecord(candidate)
      || typeof candidate.noteId !== 'string'
      || typeof candidate.content !== 'string'
      || candidate.content.length > NOTE_LIMITS.contentCharacters
      || !Number.isSafeInteger(candidate.embeddedImageCount)
      || Number(candidate.embeddedImageCount) < 0
      || Number(candidate.embeddedImageCount) > 1_000_000
      || !Number.isSafeInteger(candidate.imagePlaceholderCount)
      || Number(candidate.imagePlaceholderCount) < 0
      || Number(candidate.imagePlaceholderCount) > Number(candidate.embeddedImageCount)
      || typeof candidate.usedPlainTextFallback !== 'boolean'
      || noteIds.has(candidate.noteId)) {
      throw new Error('The converted Trilium content is invalid.');
    }
    noteIds.add(candidate.noteId);
    return {
      noteId: candidate.noteId,
      content: candidate.content,
      embeddedImageCount: Number(candidate.embeddedImageCount),
      imagePlaceholderCount: Number(candidate.imagePlaceholderCount),
      usedPlainTextFallback: candidate.usedPlainTextFallback,
    };
  });
  return {
    requestId: validateTriliumRequestId(value.requestId),
    sessionId: value.sessionId,
    convertedNotes,
  };
}

function sendTriliumImportProgress(
  sender: Electron.WebContents,
  progress: RendererTriliumImportProgress,
): void {
  if (sender.isDestroyed()) return;
  try {
    sender.send(IPC_CHANNELS.triliumImportProgress, progress);
  } catch {
    // A closing renderer no longer needs import progress.
  }
}

function rendererTriliumProgress(
  requestId: string,
  progress: TriliumImportProgress,
): RendererTriliumImportProgress {
  if (progress.phase === 'discovering') {
    return {
      requestId,
      phase: 'discovering',
      completed: progress.processed,
      total: Math.max(progress.discovered, progress.processed),
      message: progress.processed > 0
        ? `Discovering Notes… ${progress.processed}`
        : 'Connecting and discovering Notes…',
    };
  }
  return {
    requestId,
    phase: 'fetching',
    completed: progress.processed,
    total: Math.max(progress.discovered, progress.processed),
    message: `Fetching content… ${progress.processed} Notes`,
  };
}

function formatTriliumImageTransferProgress(transferredBytes: number): string {
  const mib = 1024 * 1024;
  return `${(transferredBytes / mib).toFixed(1)}/${TRILIUM_IMPORT_MAX_TOTAL_IMAGE_BYTES / mib} MiB`;
}

function clearPreparedTriliumToken(session: { tokenBuffer?: Buffer }): void {
  session.tokenBuffer?.fill(0);
  delete session.tokenBuffer;
}

function removePreparedTriliumImport(sessionId: string, abort = false): void {
  const session = preparedTriliumImports.get(sessionId);
  if (!session) return;
  if (abort) session.controller.abort();
  clearPreparedTriliumToken(session);
  preparedTriliumImports.delete(sessionId);
}

function prunePreparedTriliumImports(now = Date.now()): void {
  for (const [sessionId, session] of preparedTriliumImports) {
    if (session.expiresAt > now) continue;
    removePreparedTriliumImport(sessionId, true);
    activeTriliumImportRequests.delete(session.requestId);
  }
}

function triliumImageNoteHtml(sourceKey: string): string {
  const match = sourceKey.match(/^note:([A-Za-z0-9_]{4,32})$/);
  if (!match) throw new Error('The prepared Trilium Image Note is invalid.');
  return `<figure class="image"><img src="api/images/${match[1]}"></figure>`;
}

function triliumHtmlNotes(plan: TriliumImportPlan): Array<{ noteId: string; html: string }> {
  return plan.notes.flatMap((note) => {
    if (note.content.kind === 'html') return [{ noteId: note.localNoteId, html: note.content.html }];
    if (note.content.kind === 'image') {
      return [{ noteId: note.localNoteId, html: triliumImageNoteHtml(note.content.sourceKey) }];
    }
    return [];
  });
}

function notesImageTarget(settings: { endpoint: string; bucket: string }): string {
  return `${settings.endpoint}\0${settings.bucket}`;
}

function imageReferenceIdentity(reference: NoteImageReference): string {
  return JSON.stringify([
    reference.objectId,
    reference.assetKey,
    reference.ciphertextSha256,
    reference.contentSha256,
    reference.mimeType,
    reference.byteLength,
    reference.width,
    reference.height,
  ]);
}

function richTextImageIdentities(content: string): string[] {
  const document = parseRichTextContent(content);
  const identities: string[] = [];
  const visit = (node: RichTextNode): void => {
    if (node.type === 's3Image') {
      identities.push(imageReferenceIdentity(parseNoteImageNodeAttributes(node.attrs)));
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(document);
  return identities;
}

function validateConvertedTriliumImages(
  plan: TriliumImportPlan,
  resolvedImages: readonly TriliumResolvedImageAsset[],
  convertedNotes: readonly TriliumImportApplyInput['convertedNotes'][number][],
): void {
  const assetsBySource = new Map(resolvedImages.map((asset) => [asset.sourceKey, asset]));
  const expectedByNote = new Map<string, { images: number; placeholders: number }>();
  for (const note of plan.notes) {
    const sources = note.content.kind === 'html'
      ? note.content.images.map((image) => image.sourceKey)
      : note.content.kind === 'image'
        ? [note.content.sourceKey]
        : [];
    if (sources.length === 0 && note.content.kind !== 'html') continue;
    expectedByNote.set(note.localNoteId, {
      images: sources.length,
      placeholders: sources.filter((sourceKey) => assetsBySource.get(sourceKey)?.status !== 'uploaded').length,
    });
  }
  for (const converted of convertedNotes) {
    const expected = expectedByNote.get(converted.noteId);
    if (!expected
      || converted.embeddedImageCount !== expected.images
      || converted.imagePlaceholderCount !== expected.placeholders) {
      throw new Error('The converted Trilium images are incomplete.');
    }
  }

  const allowed = new Set(resolvedImages.flatMap((asset) => (
    asset.status === 'uploaded' ? [imageReferenceIdentity(asset.reference)] : []
  )));
  const actual = convertedNotes.flatMap((note) => richTextImageIdentities(note.content));
  if (actual.some((identity) => !allowed.has(identity))) {
    throw new Error('The converted Trilium images contain an unexpected reference.');
  }
  const used = new Set(actual);
  if ([...allowed].some((identity) => !used.has(identity))) {
    throw new Error('The converted Trilium images are incomplete.');
  }
}

function trackTriliumImportTask<T>(task: Promise<T>): Promise<T> {
  const completion = task.then(() => undefined, () => undefined);
  activeTriliumImportTasks.add(completion);
  void completion.finally(() => activeTriliumImportTasks.delete(completion));
  return task;
}

function validateNoteDelete(value: unknown): NoteDeleteInput {
  if (!isRecord(value) || !Array.isArray(value.expectedIds)
    || value.expectedIds.length === 0
    || value.expectedIds.length > NOTE_LIMITS.notes) {
    throw new Error('Note deletion is invalid.');
  }
  const id = validateNoteId(value.id);
  const expectedIds = value.expectedIds.map((candidate, index) => (
    validateNoteId(candidate, `Expected Note ${index + 1} ID`)
  ));
  if (new Set(expectedIds).size !== expectedIds.length || !expectedIds.includes(id)) {
    throw new Error('Note deletion is invalid.');
  }
  return { id, expectedIds };
}

function validateNoteDraftRecoveries(value: unknown): NoteDraftRecoveryInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > NOTE_LIMITS.notes) {
    throw new Error('Note recovery is invalid.');
  }
  const originalIds = new Set<string>();
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error('Note recovery is invalid.');
    const originalId = validateNoteId(candidate.originalId, `Recovery Note ${index + 1} ID`);
    if (originalIds.has(originalId)) throw new Error('Note recovery contains a duplicate Note ID.');
    originalIds.add(originalId);
    const expectedNote = normalizeNoteSnapshot(candidate.expectedNote);
    if (expectedNote.id !== originalId) throw new Error('Note recovery base is invalid.');
    return { originalId, draft: normalizeNoteDraft(candidate.draft), expectedNote };
  });
}

function conflictRecoveryDraft(draft: NoteDraft): NoteDraft {
  const suffix = ' (Conflict)';
  const normalizedName = draft.name.trim() || 'Untitled note';
  const available = Math.max(1, NOTE_LIMITS.nameCharacters - suffix.length);
  const baseName = normalizedName.endsWith(suffix)
    ? normalizedName.slice(0, NOTE_LIMITS.nameCharacters)
    : `${normalizedName.slice(0, available).trimEnd()}${suffix}`;
  const hasConflictTag = draft.tags.some((tag) => tag.trim().toLocaleLowerCase() === 'conflict');
  const tags = hasConflictTag
    ? [...draft.tags]
    : [...draft.tags.slice(0, Math.max(0, NOTE_LIMITS.tags - 1)), 'Conflict'];
  return { ...draft, name: baseName, tags };
}

function noteSubtreeIds(rootId: string): string[] {
  const tree = getNotesTreeStore().snapshot();
  if (!tree.nodes.some((node) => node.noteId === rootId)) return [];
  const children = new Map<string, string[]>();
  for (const node of tree.nodes) {
    if (node.parentId === null) continue;
    const group = children.get(node.parentId) ?? [];
    group.push(node.noteId);
    children.set(node.parentId, group);
  }
  const result: string[] = [];
  const visit = (noteId: string): void => {
    result.push(noteId);
    for (const childId of children.get(noteId) ?? []) visit(childId);
  };
  visit(rootId);
  return result;
}

function sameNoteIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return expected.size === left.length && right.every((id) => expected.has(id));
}

function noteDeletePreview(rootId: string): NoteDeletePreview | null {
  const note = getNotesStore().get(rootId);
  const expectedIds = noteSubtreeIds(rootId);
  return note && expectedIds.length > 0
    ? { id: note.id, name: note.name, expectedIds }
    : null;
}

async function restoreNotesWorkspace(
  notes: NotesSnapshot,
  tombstones: NoteTombstone[],
  tree: ReturnType<NotesTreeStore['snapshot']>,
  expandedNoteIds: string[],
): Promise<void> {
  const activeIds = notes.notes.map((note) => note.id);
  const rollbackErrors: unknown[] = [];
  await getNotesWorkspaceApplyCoordinator().replace({ notes, tombstones, tree })
    .catch((error) => rollbackErrors.push(error));
  await getNotesTreeViewStore().save(expandedNoteIds, activeIds).catch((error) => rollbackErrors.push(error));
  if (rollbackErrors.length > 0) {
    notesWorkspaceUnsafe = true;
    throw new Error('The Notes workspace rollback was incomplete. Restart the application before editing Notes.');
  }
}

function rendererNotesWindows(): BrowserWindow[] {
  return [...rendererWindows].filter((window) =>
    !window.isDestroyed()
    && !window.webContents.isDestroyed()
    && !window.webContents.isLoadingMainFrame()
  );
}

function rendererWindowForSender(senderId: number): BrowserWindow | undefined {
  return [...rendererWindows].find((window) =>
    !window.isDestroyed()
    && !window.webContents.isDestroyed()
    && window.webContents.id === senderId
  );
}

function deleteRecentNoteExport(senderId: number): void {
  const target = recentNoteExports.get(senderId);
  if (target) clearTimeout(target.timeout);
  recentNoteExports.delete(senderId);
}

function invalidateRendererExportState(senderId: number): void {
  deleteRecentNoteExport(senderId);
  const generation = rendererExportGenerations.get(senderId);
  if (generation !== undefined) rendererExportGenerations.set(senderId, generation + 1);
}

function clearExpiredNoteExports(now = Date.now()): void {
  for (const [senderId, target] of recentNoteExports) {
    if (
      target.expiresAt <= now
      || target.rendererGeneration !== rendererExportGenerations.get(senderId)
      || !rendererWindowForSender(senderId)
    ) {
      deleteRecentNoteExport(senderId);
    }
  }
}

async function registerRecentNoteExport(
  senderId: number,
  rendererGeneration: number,
  filePath: string,
  format: NoteExportInput['format'],
): Promise<boolean> {
  deleteRecentNoteExport(senderId);
  const expectedExtension = format === 'pdf' ? '.pdf' : '.md';
  if (path.extname(filePath).toLocaleLowerCase() !== expectedExtension) return false;
  let stats: Stats;
  try {
    stats = await fs.lstat(filePath);
  } catch {
    return false;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) return false;
  clearExpiredNoteExports();
  if (
    rendererExportGenerations.get(senderId) !== rendererGeneration
    || !rendererWindowForSender(senderId)
  ) return false;
  const expiresAt = Date.now() + NOTE_EXPORT_OPEN_TTL_MS;
  const timeout = setTimeout(() => {
    if (recentNoteExports.get(senderId)?.timeout === timeout) deleteRecentNoteExport(senderId);
  }, NOTE_EXPORT_OPEN_TTL_MS);
  timeout.unref();
  recentNoteExports.set(senderId, {
    filePath,
    format,
    device: stats.dev,
    inode: stats.ino,
    expiresAt,
    rendererGeneration,
    timeout,
  });
  return true;
}

async function takeRecentNoteExport(senderId: number): Promise<string | undefined> {
  clearExpiredNoteExports();
  const target = recentNoteExports.get(senderId);
  deleteRecentNoteExport(senderId);
  if (
    !target
    || target.expiresAt <= Date.now()
    || target.rendererGeneration !== rendererExportGenerations.get(senderId)
    || !rendererWindowForSender(senderId)
  ) return undefined;
  const expectedExtension = target.format === 'pdf' ? '.pdf' : '.md';
  if (path.extname(target.filePath).toLocaleLowerCase() !== expectedExtension) return undefined;
  let stats: Stats;
  try {
    stats = await fs.lstat(target.filePath);
  } catch {
    return undefined;
  }
  if (
    target.expiresAt <= Date.now()
    || target.rendererGeneration !== rendererExportGenerations.get(senderId)
    || !rendererWindowForSender(senderId)
    || !stats.isFile()
    || stats.isSymbolicLink()
    || stats.dev !== target.device
    || stats.ino !== target.inode
  ) return undefined;
  return target.filePath;
}

function primaryRendererWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (
    focused
    && rendererWindows.has(focused)
    && !focused.isDestroyed()
    && !focused.webContents.isDestroyed()
  ) {
    return focused;
  }
  return [...rendererWindows].find((window) =>
    !window.isDestroyed() && !window.webContents.isDestroyed()
  ) ?? null;
}

function requestRendererNotesFlush(
  window: BrowserWindow,
  persistentApplyId?: string,
): Promise<void> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve();
  const requestId = randomUUID();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRendererNotesFlushes.delete(requestId);
      reject(new Error('The renderer did not finish saving Notes before the timeout.'));
    }, RENDERER_NOTES_FLUSH_TIMEOUT_MS);
    timeout.unref();
    pendingRendererNotesFlushes.set(requestId, {
      senderId: window.webContents.id,
      timeout,
      resolve,
      reject,
    });
    try {
      window.webContents.send(IPC_CHANNELS.notesFlushRequest, {
        requestId,
        ...(persistentApplyId ? { persistentApplyId } : {}),
      });
    } catch {
      clearTimeout(timeout);
      pendingRendererNotesFlushes.delete(requestId);
      reject(new Error('The renderer could not be asked to save Notes.'));
    }
  });
}

function requestRendererCloseShortcut(window: BrowserWindow): Promise<boolean> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve(false);
  const requestId = randomUUID();
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      pendingCloseShortcutRequests.delete(requestId);
      resolve(true);
    }, CLOSE_SHORTCUT_RESPONSE_TIMEOUT_MS);
    timeout.unref();
    pendingCloseShortcutRequests.set(requestId, {
      senderId: window.webContents.id,
      timeout,
      resolve,
    });
    try {
      window.webContents.send(IPC_CHANNELS.appCloseShortcutRequest, { requestId });
    } catch {
      clearTimeout(timeout);
      pendingCloseShortcutRequests.delete(requestId);
      resolve(false);
    }
  });
}

function isCloseWindowShortcut(input: Electron.Input): boolean {
  if (input.type !== 'keyDown' || input.alt || input.shift) return false;
  if (input.key.toLocaleLowerCase() !== 'w') return false;
  return process.platform === 'darwin'
    ? Boolean(input.meta) && !input.control
    : Boolean(input.control) && !input.meta;
}

async function flushRendererNotes(): Promise<void> {
  const windows = rendererNotesWindows();
  await Promise.all(windows.map((window) => requestRendererNotesFlush(window)));
}

interface RendererNotesPersistentApply {
  id: string;
  windows: BrowserWindow[];
}

function releaseRendererNotesPersistentApply(apply: RendererNotesPersistentApply): void {
  for (const window of apply.windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    try {
      window.webContents.send(IPC_CHANNELS.notesPersistentApplyRelease, apply.id);
    } catch {
      // A renderer disappearing during release cannot retain an interactive lock.
    }
  }
}

async function prepareRendererNotesPersistentApply(): Promise<RendererNotesPersistentApply> {
  const apply = { id: randomUUID(), windows: rendererNotesWindows() };
  try {
    await Promise.all(apply.windows.map((window) => requestRendererNotesFlush(window, apply.id)));
    return apply;
  } catch (error) {
    releaseRendererNotesPersistentApply(apply);
    throw error;
  }
}

function publishPersistentDataReload(
  source: 's3' | 'trilium',
  apply: RendererNotesPersistentApply,
  options: { hostsChanged?: boolean; notesDelta?: NotesWorkspaceDelta } = {},
): boolean {
  persistentDataGeneration += 1;
  const notesOwnRelease = Boolean(options.notesDelta);
  if (!notesOwnRelease) releaseRendererNotesPersistentApply(apply);
  broadcast(IPC_CHANNELS.persistentDataReloaded, {
    generation: persistentDataGeneration,
    source,
    ...(notesOwnRelease ? { persistentApplyId: apply.id } : {}),
    ...(options.hostsChanged ? { hostsChanged: true } : {}),
    ...(options.notesDelta ? { notesDelta: options.notesDelta } : {}),
  });
  return true;
}

function serviceKey(hostId: string, serviceId: string): string {
  return `${hostId}:${serviceId}`;
}

function serviceForwardKey(hostId: string, serviceId: string): string {
  return serviceKey(hostId, serviceId);
}

function hasSameServiceStatusEndpoint(left: HostConfig, right: HostConfig): boolean {
  return left.sshHost === right.sshHost
    && left.sshPort === right.sshPort
    && left.username === right.username
    && left.authType === right.authType
    && left.password === right.password
    && left.privateKey === right.privateKey
    && left.passphrase === right.passphrase
    && left.privateKeyPath === right.privateKeyPath
    && isDeepStrictEqual(left.jumpHosts, right.jumpHosts);
}

async function persistServicePidIfCurrent(
  hostId: string,
  serviceId: string,
  expectedStartCommand: string,
  expectedPort: number,
  pid: number | undefined,
): Promise<boolean> {
  return runS3SharedDataMutation(async () => {
    const currentHost = getStore().findHostById(hostId);
    const currentService = currentHost?.services.find((service) => service.id === serviceId);
    if (!currentHost || !currentService
      || currentService.startCommand !== expectedStartCommand
      || currentService.port !== expectedPort) {
      return false;
    }
    currentService.pid = pid;
    await getStore().upsertHost(currentHost);
    return true;
  });
}

function validateProxyExceptionDraft(value: unknown): ProxyExceptionDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('A custom rule type and value are required.');
  }

  const draft = value as { type?: unknown; value?: unknown; target?: unknown };
  if (typeof draft.type !== 'string' || typeof draft.value !== 'string') {
    throw new Error('A custom rule type and value are required.');
  }
  if (draft.target !== undefined && typeof draft.target !== 'string') {
    throw new Error('A custom rule target must be a string.');
  }

  return {
    type: draft.type as ProxyExceptionDraft['type'],
    value: draft.value,
    ...(typeof draft.target === 'string' ? { target: draft.target as ProxyExceptionDraft['target'] } : {}),
  };
}

function validateProxyExceptionId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('A custom rule ID is required.');
  }
  return value;
}

function validateProxyMixedPort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('Mixed port must be an integer between 1 and 65535.');
  }
  return value;
}

const KUBERNETES_RESOURCE_KINDS = new Set([
  'pods', 'deployments', 'statefulsets', 'services', 'ingresses', 'configmaps',
  'secrets', 'persistentvolumeclaims', 'nodes', 'namespaces', 'custom-resources',
]);
const KUBERNETES_CUSTOM_RESOURCE_PART = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;
const KUBERNETES_CUSTOM_RESOURCE_VERSION = /^v[0-9]+(?:alpha[0-9]+|beta[0-9]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateKubernetesText(value: unknown, label: string, maximum = 16_384): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`Kubernetes ${label} is required and must be within the allowed size.`);
  }
  return value;
}

function validateKubernetesNamespaceScope(value: unknown): KubernetesNamespaceScope {
  if (!isRecord(value) || (value.mode !== 'all' && value.mode !== 'selected') || !Array.isArray(value.namespaces)) {
    throw new Error('Kubernetes Namespace scope is invalid.');
  }
  if (value.namespaces.some((namespace) => typeof namespace !== 'string' || namespace.length > 253)) {
    throw new Error('Kubernetes Namespace names must be text within the allowed size.');
  }
  return { mode: value.mode, namespaces: [...value.namespaces] as string[] };
}

function validateKubernetesQuery(value: unknown): KubernetesResourceQuery {
  if (!isRecord(value) || !KUBERNETES_RESOURCE_KINDS.has(value.kind as string)) {
    throw new Error('Kubernetes resource query is invalid.');
  }
  const query: KubernetesResourceQuery = {
    context: validateKubernetesText(value.context, 'Context name'),
    kind: value.kind as KubernetesResourceQuery['kind'],
    namespaceScope: validateKubernetesNamespaceScope(value.namespaceScope),
  };
  for (const field of ['apiVersion', 'plural', 'labelSelector', 'fieldSelector', 'nameFilter'] as const) {
    if (value[field] !== undefined) {
      query[field] = validateKubernetesText(value[field], field);
    }
  }
  if (value.scope !== undefined) {
    if (value.scope !== 'namespaced' && value.scope !== 'cluster') {
      throw new Error('Kubernetes resource scope is invalid.');
    }
    query.scope = value.scope;
  }
  if (value.sort !== undefined) {
    if (!isRecord(value.sort) || (value.sort.direction !== 'asc' && value.sort.direction !== 'desc')) {
      throw new Error('Kubernetes resource sort is invalid.');
    }
    query.sort = { column: validateKubernetesText(value.sort.column, 'sort column'), direction: value.sort.direction };
  }
  if (query.kind === 'custom-resources') {
    const apiVersion = validateKubernetesText(query.apiVersion, 'custom resource API version');
    const plural = validateKubernetesText(query.plural, 'custom resource plural');
    const [group, version, ...extra] = apiVersion.split('/');
    if (!group || !version || extra.length > 0 || !KUBERNETES_CUSTOM_RESOURCE_PART.test(group)
      || !KUBERNETES_CUSTOM_RESOURCE_VERSION.test(version) || !KUBERNETES_CUSTOM_RESOURCE_PART.test(plural)) {
      throw new Error('Kubernetes custom resource query is invalid.');
    }
  }
  return query;
}

function validateKubernetesWindowRange(value: unknown): { start: number; end: number } {
  if (!isRecord(value)) {
    throw new Error('Kubernetes resource window is invalid.');
  }
  const start = value.start;
  const end = value.end;
  if (typeof start !== 'number' || typeof end !== 'number'
    || !Number.isInteger(start) || !Number.isInteger(end)
    || start < 0 || end < start || end - start > 256) {
    throw new Error('Kubernetes resource window is invalid.');
  }
  return { start, end };
}

function validateKubernetesPodTarget(value: unknown): KubernetesPodTarget {
  if (!isRecord(value)) {
    throw new Error('Kubernetes Pod target is invalid.');
  }
  return {
    namespace: validateKubernetesText(value.namespace, 'Namespace'),
    podName: validateKubernetesText(value.podName, 'Pod name'),
    container: validateKubernetesText(value.container, 'container'),
  };
}

function validateKubernetesVncTarget(value: unknown): KubernetesVncTarget {
  if (!isRecord(value)) {
    throw new Error('Kubernetes VNC target is invalid.');
  }
  return {
    namespace: validateKubernetesText(value.namespace, 'Namespace', 253),
    podName: validateKubernetesText(value.podName, 'Pod name', 253),
    podUid: validateKubernetesText(value.podUid, 'Pod UID', 253),
  };
}

function validateKubernetesPortForward(value: unknown): KubernetesPortForwardInput {
  if (!isRecord(value) || (value.targetKind !== 'pod' && value.targetKind !== 'service')) {
    throw new Error('Kubernetes port forward is invalid.');
  }
  if (typeof value.remotePort !== 'number' || !Number.isInteger(value.remotePort)
    || value.remotePort < 1 || value.remotePort > 65_535) {
    throw new Error('Kubernetes remote port must be an integer between 1 and 65535.');
  }
  const remotePort = value.remotePort;
  const input: KubernetesPortForwardInput = {
    targetKind: value.targetKind,
    namespace: validateKubernetesText(value.namespace, 'Namespace'),
    targetName: validateKubernetesText(value.targetName, 'port forward target name'),
    remotePort,
  };
  if (value.localPort !== undefined) {
    if (typeof value.localPort !== 'number' || !Number.isInteger(value.localPort) || value.localPort < 0 || value.localPort > 65_535) {
      throw new Error('Kubernetes local port must be an integer between 0 and 65535.');
    }
    input.localPort = value.localPort;
  }
  return input;
}

function validateKubernetesRelatedResourceRequest(value: unknown): KubernetesRelatedResourceRequest {
  if (!isRecord(value) || (value.kind !== 'service' && value.kind !== 'deployment' && value.kind !== 'statefulset')) {
    throw new Error('Kubernetes related resource request is invalid.');
  }
  const request: KubernetesRelatedResourceRequest = {
    kind: value.kind,
    namespace: validateKubernetesText(value.namespace, 'Namespace'),
    name: validateKubernetesText(value.name, 'resource name'),
  };
  if (value.selector !== undefined) {
    request.selector = validateKubernetesText(value.selector, 'Workload selector');
  }
  if ((request.kind === 'deployment' || request.kind === 'statefulset') && !request.selector) {
    throw new Error('Kubernetes Workload selector is required.');
  }
  return request;
}

function createWindow(): BrowserWindow {
  const rendererUrl = pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).toString();
  const window = new BrowserWindow({
    width: 1230,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  rendererWindows.add(window);
  const rendererId = window.webContents.id;
  rendererExportGenerations.set(rendererId, 0);
  window.once('closed', () => {
    rendererWindows.delete(window);
    deleteRecentNoteExport(rendererId);
    rendererExportGenerations.delete(rendererId);
  });
  window.webContents.on('render-process-gone', () => invalidateRendererExportState(rendererId));
  window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) invalidateRendererExportState(rendererId);
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const preventRemoteNavigation = (event: Electron.Event, url: string): void => {
    if (url !== rendererUrl) event.preventDefault();
  };
  window.webContents.on('will-navigate', preventRemoteNavigation);
  window.webContents.on('will-redirect', preventRemoteNavigation);
  window.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame && event.url === rendererUrl) return;
    if (!event.isMainFrame && (event.url === 'about:blank' || event.url.startsWith('blob:file:///'))) return;
    event.preventDefault();
  });
  let closeShortcutPending = false;
  window.webContents.on('before-input-event', (event, input) => {
    if (!isCloseWindowShortcut(input)) return;
    event.preventDefault();
    if (closeShortcutPending) return;
    closeShortcutPending = true;
    void requestRendererCloseShortcut(window).then((handled) => {
      closeShortcutPending = false;
      if (!handled && !window.isDestroyed()) window.close();
    }).catch((error) => {
      closeShortcutPending = false;
      logRuntimeError('window:close-shortcut', error);
      if (!window.isDestroyed()) window.close();
    });
  });

  window.on('unresponsive', () => {
    logRuntimeError('window:unresponsive', new Error('Renderer became unresponsive.'));
  });

  window.webContents.once('did-finish-load', () => {
    void s3SyncRuntime?.startAutoSync().catch((error) => logRuntimeError('s3:auto-start', error));
  });

  let allowStandaloneWindowClose = false;
  let standaloneWindowClosePending = false;
  window.on('close', (event) => {
    if (quitCoordinator.canQuitImmediately() || allowStandaloneWindowClose) return;
    event.preventDefault();
    if (process.platform !== 'darwin') {
      requestQuitAfterRuntimeShutdown();
      return;
    }
    if (standaloneWindowClosePending) return;
    standaloneWindowClosePending = true;
    void requestRendererNotesFlush(window).then(() => {
      allowStandaloneWindowClose = true;
      if (!window.isDestroyed()) window.close();
    }).catch((error) => {
      standaloneWindowClosePending = false;
      logRuntimeError('notes:window-close-flush', error);
      if (!window.isDestroyed()) {
        void dialog.showMessageBox(window, {
          type: 'error',
          title: 'Notes Could Not Be Saved',
          message: 'The window was kept open because the latest Notes changes could not be saved.',
          detail: 'Try saving again before closing the window.',
        });
      }
    });
  });

  void window.loadURL(rendererUrl).catch((error) => {
    logRuntimeError('window:load-file', error);
  });
  return window;
}

function getAppIconImage(): Electron.NativeImage | null {
  const icon = nativeImage.createFromPath(APP_ICON_PATH);
  return icon.isEmpty() ? null : icon;
}

function applyAppIcon(): void {
  if (process.platform !== 'darwin') {
    return;
  }

  const icon = getAppIconImage();
  if (icon) {
    app.dock.setIcon(icon);
  }
}

function applyAppMenu(): void {
  if (process.platform !== 'darwin') {
    return;
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: APP_DISPLAY_NAME,
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates...',
          click: () => {
            void updater.checkForUpdates('manual');
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [{ role: 'close' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', accelerator: 'CmdOrCtrl+Alt+R' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
    {
      label: 'Help',
      submenu: [],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function toView(hosts: HostConfig[]) {
  return runtimeRegistry.toView(hosts, (forwardId) => tunnelManager.getStatus(forwardId));
}

function emitStatus(
  hostId: string,
  serviceId: string,
  status: ServiceStatus,
  pid?: number,
  error?: string,
  silent = false
): void {
  const payload = runtimeRegistry.setServiceStatus(hostId, serviceId, status, pid, error);
  broadcast(IPC_CHANNELS.serviceStatusChanged, silent ? { ...payload, silent: true } : payload);
}

function emitForwardStatus(hostId: string, serviceId: string, state: ForwardState, error?: string, silent = false): void {
  const current = runtimeRegistry.setServiceForwardStatus(hostId, serviceId, state, error);
  emitStatus(hostId, serviceId, current.status, current.pid, current.error, silent);
}

interface HostServiceRefreshEntry {
  service: ServiceConfig;
  result: HostServiceStatusResult;
}

function serviceStatusChangeWithSilent(change: ServiceStatusChange, silent: boolean): ServiceStatusChange {
  return silent ? { ...change, silent: true } : change;
}

async function refreshHostServicesRuntime(
  hostId: string,
  requestedServiceIds: readonly string[],
  silent: boolean,
): Promise<void> {
  const initialHost = getStore().findHostById(hostId);
  if (!initialHost) throw new Error('Host not found.');
  const requested = new Set(requestedServiceIds);
  const initialServiceIds = initialHost.services
    .filter((service) => requested.has(service.id))
    .map((service) => service.id);
  if (initialServiceIds.length === 0) return;

  await serviceOperationQueue.runMany(
    initialServiceIds.map((serviceId) => serviceKey(hostId, serviceId)),
    async () => {
      try {
        const queryHost = getStore().findHostById(hostId);
        if (!queryHost) return;
        const queryServices = queryHost.services.filter((service) => requested.has(service.id));
        if (queryServices.length === 0) return;

        const results = await checkHostServicesStatus(queryHost, queryServices);
        const resultByServiceId = new Map(results.map((result) => [result.serviceId, result]));
        await runS3SharedDataMutation(async () => {
          const currentHost = getStore().findHostById(hostId);
          if (!currentHost || !hasSameServiceStatusEndpoint(queryHost, currentHost)) return;
          const currentServices = new Map(currentHost.services.map((service) => [service.id, service]));
          const entries: HostServiceRefreshEntry[] = [];
          for (const queriedService of queryServices) {
            const service = currentServices.get(queriedService.id);
            const result = resultByServiceId.get(queriedService.id);
            if (!service || !result
              || service.startCommand !== queriedService.startCommand
              || service.port !== queriedService.port) {
              continue;
            }
            entries.push({ service, result });
          }
          if (entries.length === 0) return;

          let hasPidSets = false;
          for (const { service, result } of entries) {
            if (result.pid && result.pid !== service.pid) {
              service.pid = result.pid;
              hasPidSets = true;
            }
          }
          if (hasPidSets) await getStore().upsertHost(currentHost);

          const completed: HostServiceRefreshEntry[] = [];
          for (const entry of entries) {
            const { service, result } = entry;
            try {
              const hasForward = Boolean(service.forwardLocalPort) && service.port > 0;
              if (result.status === 'stopped') {
                await portForwardManager.stop(serviceForwardKey(hostId, service.id));
                runtimeRegistry.setServiceForwardStatus(hostId, service.id, 'none');
              } else if (result.status === 'running' && hasForward) {
                try {
                  await portForwardManager.start(serviceForwardKey(hostId, service.id), currentHost, service);
                  runtimeRegistry.setServiceForwardStatus(hostId, service.id, 'ok');
                } catch (error) {
                  logRuntimeError('port-forward:start', error, {
                    hostId,
                    serviceId: service.id,
                    localPort: service.forwardLocalPort,
                    remotePort: service.port,
                  });
                  runtimeRegistry.setServiceForwardStatus(
                    hostId,
                    service.id,
                    'error',
                    error instanceof Error ? error.message : String(error)
                  );
                }
              } else if (!hasForward) {
                runtimeRegistry.setServiceForwardStatus(hostId, service.id, 'none');
              }
              completed.push(entry);
            } catch (error) {
              logRuntimeError('service:refresh-host-item', error, {
                hostId,
                serviceId: service.id,
                silent,
              });
            }
          }

          let hasPidClears = false;
          for (const { service, result } of completed) {
            if (result.status === 'stopped' && service.pid !== undefined) {
              service.pid = undefined;
              hasPidClears = true;
            }
          }
          if (hasPidClears) await getStore().upsertHost(currentHost);

          const changes = completed.map(({ service, result }) => serviceStatusChangeWithSilent(
            runtimeRegistry.setServiceStatus(hostId, service.id, result.status, service.pid, result.error),
            silent
          ));
          if (changes.length > 0) {
            broadcast(IPC_CHANNELS.serviceStatusBatchChanged, { changes });
          }
        });
      } catch (error) {
        logRuntimeError('service:refresh-host', error, {
          hostId,
          serviceCount: initialServiceIds.length,
          silent,
        });
        throw error;
      }
    }
  );
}

function logRuntimeError(scope: string, error: unknown, context?: Record<string, unknown>): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${scope}] ${message}`, context ?? {});
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }

  try {
    void runtimeLogWriter?.record(scope, error, context).catch(() => undefined);
  } catch {
    // Runtime logging is best effort and must not disrupt the app lifecycle.
  }
}

async function flushRuntimeLog(): Promise<void> {
  try {
    await runtimeLogWriter?.flush();
  } catch (error) {
    console.error('[runtime-log:flush]', error);
  }
}

async function shutdownRuntimesForQuit(): Promise<void> {
  try {
    updater.stop();
  } catch (error) {
    logRuntimeError('app:shutdown', error, { operation: 'updater-stop' });
  }

  for (const { controller } of activeTriliumImportRequests.values()) controller.abort();
  await Promise.allSettled([...activeTriliumImportTasks]);
  activeTriliumImportRequests.clear();
  for (const sessionId of [...preparedTriliumImports.keys()]) removePreparedTriliumImport(sessionId);

  try {
    await flushRendererNotes();
  } catch (error) {
    logRuntimeError('app:shutdown', error, { operation: 'renderer-notes-flush' });
  }

  for (const controller of activeLlmModelRequests) controller.abort();

  const shutdownResults = await Promise.allSettled([
    Promise.resolve().then(() => notesStore?.flush()),
    Promise.resolve().then(() => notesTreeStore?.flush()),
    Promise.resolve().then(() => notesTreeViewStore?.flush()),
    Promise.resolve().then(() => uiPreferencesStore?.flush()),
    Promise.resolve().then(() => llmSettingsStore?.flush()),
    Promise.resolve().then(() => sqlRuntime?.shutdown()),
    Promise.resolve().then(() => s3SharedDataMutationQueue),
    Promise.resolve().then(() => s3SyncRuntime?.shutdown()),
    Promise.resolve().then(() => portForwardManager.shutdown()),
    Promise.resolve().then(() => tunnelManager.stopAll()),
    Promise.resolve().then(() => proxyRuntime?.shutdown()),
    Promise.resolve().then(() => kubernetesRuntime?.shutdown()),
  ]);
  for (const result of shutdownResults) {
    if (result.status === 'rejected') {
      logRuntimeError('app:shutdown', result.reason, { operation: 'runtime-stop' });
    }
  }

  await flushSentry();
  await flushRuntimeLog();
}

function requestQuitAfterRuntimeShutdown(signal = false): void {
  void quitCoordinator.request(signal ? 'signal' : 'normal');
}

function runFinalExitAction(action: () => void): void {
  const forcedExit = setTimeout(() => process.exit(0), FINAL_PROCESS_EXIT_DELAY_MS);
  forcedExit.unref();
  action();
}

updater = new AppUpdater(
  () => primaryRendererWindow(),
  () => { void quitCoordinator.request('install-update'); },
);
quitCoordinator = new AppQuitCoordinator({
  abortAutoStart: () => autoStartAbortController.abort(),
  cleanup: shutdownRuntimesForQuit,
  reportCleanupError: async (error) => {
    logRuntimeError('app:shutdown', error, { operation: 'runtime-stop' });
    await flushRuntimeLog();
  },
  quit: () => runFinalExitAction(() => app.quit()),
  installUpdate: () => runFinalExitAction(() => updater.installDownloadedUpdate()),
  exit: () => runFinalExitAction(() => app.exit(0)),
});

function broadcast(channel: string, payload: unknown): void {
  for (const win of rendererWindows) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      continue;
    }

    try {
      win.webContents.send(channel, payload);
    } catch (error) {
      logRuntimeError('ipc:broadcast', error, { channel });
    }
  }
}

function registerProcessErrorHandlers(): void {
  process.on('uncaughtException', (error) => {
    logRuntimeError('process:uncaughtException', error);
  });

  process.on('unhandledRejection', (reason) => {
    logRuntimeError('process:unhandledRejection', reason);
  });

  app.on('render-process-gone', (_event, webContents, details) => {
    for (const [requestId, active] of activeTriliumImportRequests) {
      if (active.senderId !== webContents.id) continue;
      active.controller.abort();
      activeTriliumImportRequests.delete(requestId);
    }
    for (const [sessionId, session] of preparedTriliumImports) {
      if (session.senderId === webContents.id) removePreparedTriliumImport(sessionId, true);
    }
    logRuntimeError('app:render-process-gone', new Error(`Renderer process exited: ${details.reason}`), {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  app.on('child-process-gone', (_event, details) => {
    logRuntimeError('app:child-process-gone', new Error(`Child process exited: ${details.type}`), {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      name: details.name,
    });
  });
}

function syncKnownForwards(hosts: HostConfig[]): void {
  const next = new Map<string, string>();
  for (const host of hosts) {
    for (const forward of host.forwards) {
      tunnelManager.setKnownTunnel(forward.id);
      next.set(forward.id, host.id);
    }
  }

  for (const [forwardId] of forwardOwners) {
    if (!next.has(forwardId)) {
      forwardOwners.delete(forwardId);
    }
  }

  for (const [forwardId, hostId] of next) {
    forwardOwners.set(forwardId, hostId);
  }
}

async function stopAllHostRules(host: HostConfig): Promise<void> {
  await Promise.all(host.forwards.map((forward) => tunnelManager.stop(forward.id)));
}

async function clearRemovedRules(previous: HostConfig, next: HostConfig): Promise<void> {
  const nextIds = new Set(next.forwards.map((item) => item.id));
  const removed = previous.forwards.filter((item) => !nextIds.has(item.id));
  for (const forward of removed) {
    await tunnelManager.stop(forward.id);
    tunnelManager.clearTunnel(forward.id);
    forwardOwners.delete(forward.id);
  }
}

async function autoStartHostRules(host: HostConfig): Promise<void> {
  for (const forward of host.forwards) {
    if (!forward.autoStart) continue;
    try {
      const config = await forwardToRuntimeConfig(host, forward);
      void tunnelManager.start(config).catch(() => undefined);
    } catch (error) {
      logRuntimeError('forward:auto-start', error, { hostId: host.id, forwardId: forward.id });
    }
  }
}

const MAX_SYNCED_PRIVATE_KEY_BYTES = 4 * 1024 * 1024;

async function hostsForS3Snapshot(hosts: HostConfig[]): Promise<HostConfig[]> {
  return Promise.all(hosts.map(async (host) => {
    let privateKey = host.privateKey;
    if (host.authType === 'privateKey' && !privateKey?.trim() && host.privateKeyPath) {
      try {
        const metadata = await fs.stat(host.privateKeyPath);
        if (!metadata.isFile() || metadata.size > MAX_SYNCED_PRIVATE_KEY_BYTES) {
          throw new Error('invalid private key file');
        }
        privateKey = await fs.readFile(host.privateKeyPath, 'utf8');
        if (!privateKey.trim() || Buffer.byteLength(privateKey, 'utf8') > MAX_SYNCED_PRIVATE_KEY_BYTES) {
          throw new Error('invalid private key content');
        }
      } catch {
        throw new Error(`The imported private key for Host "${host.name}" could not be prepared for encrypted sync.`);
      }
    }
    return {
      ...host,
      ...(privateKey ? { privateKey } : {}),
      jumpHosts: host.jumpHosts.map((jumpHost) => ({ ...jumpHost })),
      forwards: host.forwards.map((forward) => ({ ...forward })),
      services: host.services.map((service) => ({ ...service })),
    };
  }));
}

async function collectS3SharedAppDataUnlocked(): Promise<S3SharedAppData> {
  assertNotesWorkspaceSafe();
  const activeNotesStore = getNotesStore();
  await activeNotesStore.flush();
  const [proxy, snapshotHosts] = await Promise.all([
    getProxyRuntime().exportPersistentSnapshot(),
    hostsForS3Snapshot(getStore().listHosts()),
  ]);
  return createS3SharedAppData({
    hosts: snapshotHosts,
    notes: activeNotesStore.exportSnapshot(),
    notesTree: getNotesTreeStore().snapshot(),
    noteTombstones: activeNotesStore.exportTombstones(),
    proxy,
  });
}

async function collectS3SharedAppData(): Promise<S3SharedAppData> {
  await flushRendererNotes();
  return runS3SharedDataMutation(collectS3SharedAppDataUnlocked);
}

async function collectS3ChangedNotes(
  intent: S3NotesIncrementalIntent,
): Promise<S3NotesIncrementalSnapshot> {
  return runS3SharedDataMutation(async () => {
    assertNotesWorkspaceSafe();
    const store = getNotesStore();
    await store.flush();
    const notes: Note[] = [];
    const tombstones: NoteTombstone[] = [];
    const tombstonesById = new Map(store.exportTombstones().map((tombstone) => [tombstone.id, tombstone]));
    for (const id of new Set([...intent.upsertIds, ...intent.deleteIds])) {
      const note = store.get(id);
      if (note) {
        notes.push(note);
        continue;
      }
      const tombstone = tombstonesById.get(id);
      if (!tombstone) throw new Error('A changed Note is no longer available.');
      tombstones.push(tombstone);
    }
    return {
      notes,
      tombstones,
      ...(intent.includeTree ? { notesTree: getNotesTreeStore().snapshot() } : {}),
    };
  });
}

function validateS3AppliedHosts(hosts: HostConfig[], currentHosts: HostConfig[]): HostConfig[] {
  const hostIds = new Set<string>();
  const forwardIds = new Set<string>();
  return hosts.map((candidate, index) => {
    let validated: HostConfig;
    try {
      validated = validateHostDraft(candidate);
    } catch (error) {
      throw new Error(`Synced Host ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (hostIds.has(validated.id)) throw new Error('Synced Hosts contain a duplicate Host ID.');
    hostIds.add(validated.id);
    for (const forward of validated.forwards) {
      if (forwardIds.has(forward.id)) throw new Error('Synced Hosts contain a duplicate Forward ID.');
      forwardIds.add(forward.id);
    }
    return preserveServiceRuntimeFields(
      currentHosts.find((host) => host.id === validated.id),
      validated,
    );
  });
}

async function stopAndClearHostRuntime(hosts: HostConfig[]): Promise<void> {
  await portForwardManager.stopAll();
  await tunnelManager.stopAll();
  for (const host of hosts) {
    for (const forward of host.forwards) {
      tunnelManager.clearTunnel(forward.id);
      forwardOwners.delete(forward.id);
    }
    for (const service of host.services) emitForwardStatus(host.id, service.id, 'none');
  }
}

async function applyS3SharedAppData(
  data: S3SharedAppData,
  expectedLocal?: S3SharedAppData,
): Promise<boolean> {
  // Freeze before flushing so a keystroke cannot land between the final
  // expected-local check and the whole-workspace replacement.
  const rendererApply = await prepareRendererNotesPersistentApply();
  let reloadOwnsRelease = false;
  let changed = false;
  let appliedHostsChanged = false;
  let notesDelta: NotesWorkspaceDelta | undefined;
  try {
    const applied = await runS3SharedDataMutation(async () => {
      if (expectedLocal) {
        const currentShared = await collectS3SharedAppDataUnlocked();
        if (!isDeepStrictEqual(currentShared, expectedLocal)) return false;
      }

      const currentHosts = getStore().listHosts();
      const currentNotes = getNotesStore().exportSnapshot();
      const currentNoteTombstones = getNotesStore().exportTombstones();
      const currentNotesTree = getNotesTreeStore().snapshot();
      const currentExpandedNoteIds = getNotesTreeViewStore().snapshot().expandedNoteIds;
      const currentProxy = await getProxyRuntime().exportPersistentSnapshot();
      const staged = stageS3SharedAppDataForLocalApply(data, {
        hosts: currentHosts,
        proxy: currentProxy,
      });
      const nextHosts = validateS3AppliedHosts(staged.hosts, currentHosts);
      const hostsChanged = !isDeepStrictEqual(currentHosts, nextHosts);
      const notesChanged = !isDeepStrictEqual(currentNotes, staged.notes)
        || !isDeepStrictEqual(currentNoteTombstones, staged.noteTombstones);
      const notesTreeChanged = !isDeepStrictEqual(currentNotesTree, staged.notesTree);
      const proxyChanged = !isDeepStrictEqual(currentProxy, staged.proxy);
      appliedHostsChanged = hostsChanged;
      changed = hostsChanged || notesChanged || notesTreeChanged || proxyChanged;
      if (!changed) return true;

      if (hostsChanged) {
        await stopAndClearHostRuntime(currentHosts);
      }
      try {
        if (notesChanged || notesTreeChanged) {
          notesDelta = await getNotesWorkspaceApplyCoordinator().replace({
            notes: staged.notes,
            tombstones: staged.noteTombstones,
            tree: staged.notesTree,
          });
        }
        if (proxyChanged) await getProxyRuntime().importPersistentSnapshot(staged.proxy);
        if (hostsChanged) await getStore().replaceHosts(nextHosts);
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        let notesRollbackIncomplete = false;
        if (notesChanged || notesTreeChanged) {
          await restoreNotesWorkspace(
            currentNotes,
            currentNoteTombstones,
            currentNotesTree,
            currentExpandedNoteIds,
          )
            .catch((rollback) => {
              notesRollbackIncomplete = true;
              rollbackErrors.push(rollback);
            });
        }
        if (proxyChanged) await getProxyRuntime().importPersistentSnapshot(currentProxy).catch((rollback) => rollbackErrors.push(rollback));
        if (hostsChanged) await getStore().replaceHosts(currentHosts).catch((rollback) => rollbackErrors.push(rollback));
        if (hostsChanged) {
          syncKnownForwards(currentHosts);
          for (const host of currentHosts) await autoStartHostRules(host);
        }
        if (rollbackErrors.length > 0) {
          if (notesRollbackIncomplete) notesWorkspaceUnsafe = true;
          throw new Error('Cloud data could not be applied and the local rollback was incomplete. Restart the application before editing data.');
        }
        throw error;
      }

      if (hostsChanged) {
        syncKnownForwards(nextHosts);
        for (const host of nextHosts) await autoStartHostRules(host);
      }
      return true;
    });
    if (applied && changed) {
      reloadOwnsRelease = publishPersistentDataReload('s3', rendererApply, {
        hostsChanged: appliedHostsChanged,
        ...(notesDelta ? { notesDelta } : {}),
      });
    }
    return applied;
  } finally {
    if (!reloadOwnsRelease) releaseRendererNotesPersistentApply(rendererApply);
  }
}

function registerIpcHandlers(): void {
  ipcMain.on(IPC_CHANNELS.appCloseShortcutResult, (event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload.requestId !== 'string' || typeof payload.handled !== 'boolean') return;
    const pending = pendingCloseShortcutRequests.get(payload.requestId);
    if (!pending || pending.senderId !== event.sender.id) return;
    clearTimeout(pending.timeout);
    pendingCloseShortcutRequests.delete(payload.requestId);
    pending.resolve(payload.handled);
  });

  ipcMain.handle(IPC_CHANNELS.listHosts, async () => {
    const hosts = getStore().listHosts();
    syncKnownForwards(hosts);
    return toView(hosts);
  });

  ipcMain.handle(IPC_CHANNELS.notesList, async () => runS3SharedDataMutation(async () => {
    assertNotesWorkspaceSafe();
    return getNotesStore().list().map(noteSummary);
  }));
  ipcMain.handle(IPC_CHANNELS.notesWorkspace, async () => (
    runS3SharedDataMutation(async () => notesWorkspaceSnapshot())
  ));
  ipcMain.handle(IPC_CHANNELS.notesGet, async (_event, idValue: unknown) => (
    runS3SharedDataMutation(async () => {
      assertNotesWorkspaceSafe();
      const note = getNotesStore().get(validateNoteId(idValue));
      if (!note) throw new Error('Note not found.');
      return note;
    })
  ));
  ipcMain.handle(IPC_CHANNELS.notesSearch, async (_event, inputValue: unknown) => (
    runS3SharedDataMutation(async () => {
      assertNotesWorkspaceSafe();
      if (!isRecord(inputValue)
        || typeof inputValue.query !== 'string'
        || inputValue.query.length > 512) {
        throw new Error('Note search is invalid.');
      }
      const notes = getNotesStore().list();
      if (inputValue.activeNote !== undefined) {
        const activeNote = normalizeNoteSnapshot(inputValue.activeNote);
        const index = notes.findIndex((note) => note.id === activeNote.id);
        if (index >= 0 && notes[index]?.updatedAt === activeNote.updatedAt) {
          notes[index] = activeNote;
        }
      }
      return rankNoteIdsForSearch(notes, inputValue.query);
    })
  ));
  ipcMain.handle(IPC_CHANNELS.notesCreate, async (_event, placementValue: unknown) => {
    const placement = validateNotePlacement(placementValue, true);
    let createdNoteId: string | undefined;
    return mutateNotesSharedData(async () => {
      const previousNotes = getNotesStore().exportSnapshot();
      const previousTombstones = getNotesStore().exportTombstones();
      const previousTree = getNotesTreeStore().snapshot();
      const previousExpanded = getNotesTreeViewStore().snapshot().expandedNoteIds;
      try {
        const note = await getNotesStore().create();
        createdNoteId = note.id;
        await getNotesTreeStore().insert(note.id, placement.parentId, placement.beforeNoteId);
        if (placement.parentId !== null) {
          await getNotesTreeViewStore().set(
            placement.parentId,
            true,
            getNotesStore().list().map((candidate) => candidate.id),
          );
        }
        return notesWorkspaceSnapshot();
      } catch (error) {
        await restoreNotesWorkspace(previousNotes, previousTombstones, previousTree, previousExpanded);
        throw error;
      }
    }, () => {
      if (!createdNoteId) throw new Error('The created Note identity is unavailable.');
      return { kind: 'notes', upsertIds: [createdNoteId], treeChanged: true };
    });
  });
  ipcMain.handle(IPC_CHANNELS.notesUpdate, async (_event, payload: unknown) => {
    if (!isRecord(payload)) {
      throw new Error('Note update is invalid.');
    }
    const id = validateNoteId(payload.id);
    const draft = normalizeNoteDraft(payload.draft);
    const expectedNote = normalizeNoteSnapshot(payload.expectedNote);
    if (expectedNote.id !== id) throw new Error('Note update base is invalid.');
    return mutateNotesSharedData(async () => {
      return getNotesStore().compareAndUpdate(id, expectedNote, draft);
    }, { kind: 'notes', upsertIds: [id] });
  });
  ipcMain.handle(IPC_CHANNELS.notesMove, async (_event, inputValue: unknown) => {
    const input = validateNoteMove(inputValue);
    return mutateNotesSharedData(async () => {
      const previousNotes = getNotesStore().exportSnapshot();
      const previousTombstones = getNotesStore().exportTombstones();
      const activeIds = getNotesStore().list().map((candidate) => candidate.id);
      const previousTree = getNotesTreeStore().snapshot();
      const previousExpanded = getNotesTreeViewStore().snapshot().expandedNoteIds;
      try {
        await getNotesTreeStore().move(input.noteId, input.parentId, input.beforeNoteId);
        if (input.parentId !== null) {
          await getNotesTreeViewStore().set(input.parentId, true, activeIds);
        }
        return notesWorkspaceSnapshot();
      } catch (error) {
        await restoreNotesWorkspace(previousNotes, previousTombstones, previousTree, previousExpanded);
        throw error;
      }
    }, { kind: 'notes', treeChanged: true });
  });
  ipcMain.handle(IPC_CHANNELS.notesTreeExpanded, async (_event, inputValue: unknown) => {
    const input = validateNoteTreeExpansion(inputValue);
    return runS3SharedDataMutation(async () => {
      assertNotesWorkspaceSafe();
      const activeIds = getNotesStore().list().map((candidate) => candidate.id);
      const requestedIds = 'noteIds' in input ? input.noteIds : [input.noteId];
      const expandableIds = requestedIds.filter((noteId) => activeIds.includes(noteId));
      if (expandableIds.length === 0) {
        return getNotesTreeViewStore().snapshot().expandedNoteIds;
      }
      return (await getNotesTreeViewStore().setMany(
        expandableIds,
        input.expanded,
        activeIds,
      )).expandedNoteIds;
    });
  });
  ipcMain.handle(IPC_CHANNELS.notesDeletePreview, async (_event, idValue: unknown) => {
    const id = validateNoteId(idValue);
    return runS3SharedDataMutation(async () => {
      assertNotesWorkspaceSafe();
      return noteDeletePreview(id);
    });
  });
  ipcMain.handle(IPC_CHANNELS.notesDelete, async (_event, inputValue: unknown) => {
    const input = validateNoteDelete(inputValue);
    return runS3SharedDataMutation(async () => {
      assertNotesWorkspaceSafe();
      const deletedIds = noteSubtreeIds(input.id);
      if (!sameNoteIds(deletedIds, input.expectedIds)) {
        return { status: 'changed' as const, preview: noteDeletePreview(input.id) };
      }
      if (deletedIds.length === 0) {
        return {
          status: 'deleted' as const,
          deletedIds,
          tree: getNotesTreeStore().snapshot(),
          expandedNoteIds: getNotesTreeViewStore().snapshot().expandedNoteIds,
        };
      }
      const previousNotes = getNotesStore().exportSnapshot();
      const previousTombstones = getNotesStore().exportTombstones();
      const previousTree = getNotesTreeStore().snapshot();
      const previousExpanded = getNotesTreeViewStore().snapshot().expandedNoteIds;
      try {
        const persistedDeletedIds = await getNotesStore().deleteMany(deletedIds);
        if (!sameNoteIds(deletedIds, persistedDeletedIds)) {
          throw new Error('The confirmed Notes subtree could not be deleted completely.');
        }
        const tree = await getNotesTreeStore().removeIds(deletedIds);
        const expanded = await getNotesTreeViewStore().replaceActiveIds(
          getNotesStore().list().map((note) => note.id),
        );
        s3SyncRuntime?.markLocalChange({
          kind: 'notes',
          deleteIds: deletedIds,
          treeChanged: true,
        });
        return {
          status: 'deleted' as const,
          deletedIds,
          tree,
          expandedNoteIds: expanded.expandedNoteIds,
        };
      } catch (error) {
        await restoreNotesWorkspace(previousNotes, previousTombstones, previousTree, previousExpanded);
        throw error;
      }
    });
  });
  ipcMain.handle(IPC_CHANNELS.notesRecoverDrafts, async (_event, inputValue: unknown) => {
    const recoveries = validateNoteDraftRecoveries(inputValue);
    return mutateNotesSharedData(async () => {
      const previousNotes = getNotesStore().exportSnapshot();
      const previousTombstones = getNotesStore().exportTombstones();
      const previousTree = getNotesTreeStore().snapshot();
      const previousExpanded = getNotesTreeViewStore().snapshot().expandedNoteIds;
      const recovered: Array<{ originalId: string; noteId: string; conflict: boolean }> = [];
      const activeIds = new Set(previousNotes.notes.map((note) => note.id));
      try {
        for (const recovery of recoveries) {
          const current = getNotesStore().list().find((note) => note.id === recovery.originalId);
          const decision = classifyNoteDraftRecovery(current, recovery.expectedNote, recovery.draft);
          if (decision === 'already-saved' && current) {
            recovered.push({ originalId: recovery.originalId, noteId: current.id, conflict: false });
            continue;
          }
          if (decision === 'update') {
            const note = await getNotesStore().update(recovery.originalId, recovery.draft);
            recovered.push({ originalId: recovery.originalId, noteId: note.id, conflict: false });
            continue;
          }
          const created = await getNotesStore().create();
          const note = await getNotesStore().update(created.id, conflictRecoveryDraft(recovery.draft));
          await getNotesTreeStore().insert(note.id, null);
          activeIds.add(note.id);
          recovered.push({ originalId: recovery.originalId, noteId: note.id, conflict: true });
        }
        return { recovered, workspace: notesWorkspaceSnapshot() };
      } catch (error) {
        await restoreNotesWorkspace(previousNotes, previousTombstones, previousTree, previousExpanded);
        throw error;
      }
    }, ({ recovered }) => ({
      kind: 'notes',
      upsertIds: recovered.map((item) => item.noteId),
      treeChanged: recovered.some((item) => item.conflict),
    }));
  });
  ipcMain.handle(IPC_CHANNELS.notesImageUpload, async (_event, input: unknown) =>
    getS3SyncRuntime().uploadNoteImage(input)
  );
  ipcMain.handle(IPC_CHANNELS.notesImageLoad, async (_event, reference: unknown) =>
    getS3SyncRuntime().loadNoteImage(reference)
  );
  ipcMain.handle(IPC_CHANNELS.notesAttachmentUpload, async (_event, input: unknown) =>
    getS3SyncRuntime().uploadNoteAttachment(input)
  );
  ipcMain.handle(IPC_CHANNELS.notesAttachmentView, async (_event, referenceValue: unknown) => {
    const reference = parseNoteAttachmentReference(referenceValue);
    if (!noteAttachmentPreviewKind(reference)) return { status: 'error' as const };
    const loaded = await getS3SyncRuntime().loadNoteAttachment(reference);
    if (loaded.status !== 'loaded') return attachmentActionFailure(loaded.status);
    const preview = createNotesAttachmentPreview(reference, loaded.bytes);
    return preview ? { status: 'loaded' as const, preview } : { status: 'error' as const };
  });
  ipcMain.handle(IPC_CHANNELS.notesAttachmentDownload, async (event, referenceValue: unknown) => {
    const reference = parseNoteAttachmentReference(referenceValue);
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options = {
      title: 'Download Note Attachment',
      defaultPath: path.join(app.getPath('downloads'), reference.fileName),
    };
    const result = parentWindow
      ? await dialog.showSaveDialog(parentWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { status: 'cancelled' as const };
    const loaded = await getS3SyncRuntime().loadNoteAttachment(reference);
    if (loaded.status !== 'loaded') return attachmentActionFailure(loaded.status);
    await fs.writeFile(result.filePath, loaded.bytes, { mode: 0o600 });
    return { status: 'saved' as const };
  });
  ipcMain.handle(IPC_CHANNELS.notesExport, async (event, inputValue: unknown) => {
    const input = validateNoteExportInput(inputValue);
    const extension = input.format === 'pdf' ? 'pdf' : 'md';
    const senderId = event.sender.id;
    const rendererGeneration = rendererExportGenerations.get(senderId);
    const parentWindow = rendererWindowForSender(senderId);
    if (rendererGeneration === undefined || !parentWindow) {
      throw new Error('The Note export window is no longer available.');
    }
    deleteRecentNoteExport(senderId);
    const options = {
      title: `Download Note as ${input.format === 'pdf' ? 'PDF' : 'Markdown'}`,
      defaultPath: path.join(app.getPath('downloads'), createSafeNoteFilename(input.title, extension)),
      filters: [{
        name: input.format === 'pdf' ? 'PDF Documents' : 'Markdown Files',
        extensions: [extension],
      }],
    };
    const performExport = async () => {
      const result = parentWindow
        ? await dialog.showSaveDialog(parentWindow, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { status: 'cancelled' as const };

      if (input.format === 'markdown') {
        const markdown = input.language === 'markdown'
          ? input.content
          : richTextToMarkdown(input.content);
        await fs.writeFile(result.filePath, markdown, { encoding: 'utf8', mode: 0o600 });
      } else {
        const plainBodyHtml = input.language === 'markdown'
          ? renderMarkdownToSafeHtml(input.content)
          : richTextToSafeHtml(input.content);
        const bodyHtml = highlightSafeNoteCodeBlocks(plainBodyHtml);
        const pdf = await renderNotePdf(buildNotePrintDocument(input.title, bodyHtml));
        await fs.writeFile(result.filePath, pdf, { mode: 0o600 });
      }
      return {
        status: 'saved' as const,
        canOpen: await registerRecentNoteExport(
          senderId,
          rendererGeneration,
          result.filePath,
          input.format,
        ),
      };
    };
    return input.format === 'pdf'
      ? runNotePdfExportTask(performExport)
      : performExport();
  });
  ipcMain.handle(IPC_CHANNELS.notesExportOpenLast, async (event) => {
    const filePath = await takeRecentNoteExport(event.sender.id);
    if (!filePath) return { status: 'unavailable' as const };
    const openError = await shell.openPath(filePath);
    if (openError) throw new Error('Unable to open the exported Note file.');
    return { status: 'opened' as const };
  });
  ipcMain.handle(IPC_CHANNELS.notesSharesList, async (_event, noteIdValue: unknown) => {
    const noteId = validateNoteId(noteIdValue);
    assertNotesWorkspaceSafe();
    if (!getNotesStore().get(noteId)) throw new Error('Note not found.');
    return getS3SyncRuntime().listNoteShares(noteId);
  });
  ipcMain.handle(IPC_CHANNELS.notesSharesCreate, async (_event, inputValue: unknown) => {
    const input = validateNoteShareCreateInput(inputValue);
    assertNotesWorkspaceSafe();
    const note = getNotesStore().get(input.noteId);
    if (!note) throw new Error('Note not found.');
    return getS3SyncRuntime().createNoteShare(note, input.expiresInHours);
  });
  ipcMain.handle(IPC_CHANNELS.notesSharesResign, async (_event, inputValue: unknown) => {
    const input = validateNoteShareResignInput(inputValue);
    assertNotesWorkspaceSafe();
    if (!getNotesStore().get(input.noteId)) throw new Error('Note not found.');
    return getS3SyncRuntime().resignNoteShare(input.noteId, input.shareId, input.expiresInHours);
  });
  ipcMain.handle(IPC_CHANNELS.notesSharesDelete, async (_event, inputValue: unknown) => {
    const input = validateNoteShareDeleteInput(inputValue);
    assertNotesWorkspaceSafe();
    if (!getNotesStore().get(input.noteId)) throw new Error('Note not found.');
    await getS3SyncRuntime().deleteNoteShare(input.noteId, input.shareId);
  });
  ipcMain.on(IPC_CHANNELS.notesFlushResult, (event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload.requestId !== 'string' || typeof payload.ok !== 'boolean') return;
    const pending = pendingRendererNotesFlushes.get(payload.requestId);
    if (!pending || pending.senderId !== event.sender.id) return;
    pendingRendererNotesFlushes.delete(payload.requestId);
    clearTimeout(pending.timeout);
    if (payload.ok) {
      pending.resolve();
    } else {
      const detail = typeof payload.error === 'string' && payload.error.trim()
        ? `: ${payload.error.trim().slice(0, 1000)}`
        : '';
      pending.reject(new Error(`The renderer could not save the latest Notes changes${detail}`));
    }
  });
  ipcMain.handle(IPC_CHANNELS.uiPreferencesGet, async () => getUiPreferencesStore().get());
  ipcMain.handle(IPC_CHANNELS.uiPreferencesSave, async (_event, draft: unknown) => {
    const preferences = await getUiPreferencesStore().save(draft);
    broadcast(IPC_CHANNELS.uiPreferencesChanged, preferences);
    return preferences;
  });
  ipcMain.handle(IPC_CHANNELS.uiPreferencesNotesSidebarWidthSave, async (_event, width: unknown) => {
    return getUiPreferencesStore().saveNotesSidebarWidth(width);
  });
  ipcMain.handle(IPC_CHANNELS.triliumImportPrepare, async (event, inputValue: unknown) => {
    const input = validateTriliumImportPrepare(inputValue);
    prunePreparedTriliumImports();
    if (activeTriliumImportRequests.size > 0) {
      throw new Error('Another Trilium import is already being prepared.');
    }
    for (const [sessionId, session] of preparedTriliumImports) {
      if (session.senderId === event.sender.id) {
        removePreparedTriliumImport(sessionId, true);
        activeTriliumImportRequests.delete(session.requestId);
      }
    }

    const controller = new AbortController();
    const tokenBuffer = Buffer.from(input.etapiToken, 'utf8');
    let retainedSession = false;
    activeTriliumImportRequests.set(input.requestId, { senderId: event.sender.id, controller });
    const task = (async () => {
      await flushRendererNotes();
      const knownSourceVersions: Record<string, string> = {};
      for (const note of getNotesStore().list()) {
        const version = triliumStoredSourceVersion(note.tags);
        if (version) knownSourceVersions[note.id] = version;
      }
      const plan = await prepareTriliumImportPlan({
        endpoint: input.endpoint,
        token: input.etapiToken,
        signal: controller.signal,
        knownSourceVersions,
        ...(input.maxNotes !== undefined ? { maxNotes: input.maxNotes } : {}),
        onProgress: (progress) => sendTriliumImportProgress(
          event.sender,
          rendererTriliumProgress(input.requestId, progress),
        ),
      });
      if (controller.signal.aborted) throw new Error('The Trilium import was cancelled.');
      const sessionId = randomUUID();
      preparedTriliumImports.set(sessionId, {
        senderId: event.sender.id,
        requestId: input.requestId,
        plan,
        controller,
        tokenBuffer,
        resolvingImages: false,
        expiresAt: Date.now() + TRILIUM_IMPORT_SESSION_TTL_MS,
      });
      retainedSession = true;
      sendTriliumImportProgress(event.sender, {
        requestId: input.requestId,
        phase: 'fetching',
        completed: plan.notes.length,
        total: plan.notes.length,
        message: `Fetched ${plan.notes.length} Notes.`,
      });
      return {
        requestId: input.requestId,
        sessionId,
        endpoint: plan.endpoint,
        total: plan.notes.length,
        htmlNotes: triliumHtmlNotes(plan),
        imageTargetCount: plan.imageTargets.length,
        placeholderCount: plan.placeholders,
        cloneCount: plan.clones,
      };
    })();
    try {
      return await trackTriliumImportTask(task);
    } finally {
      if (!retainedSession) {
        tokenBuffer.fill(0);
        const active = activeTriliumImportRequests.get(input.requestId);
        if (active?.controller === controller) activeTriliumImportRequests.delete(input.requestId);
      }
    }
  });
  ipcMain.handle(IPC_CHANNELS.triliumImportResolveImages, async (event, inputValue: unknown) => {
    const input = validateTriliumImportResolveImages(inputValue);
    prunePreparedTriliumImports();
    const session = preparedTriliumImports.get(input.sessionId);
    if (!session
      || session.senderId !== event.sender.id
      || session.requestId !== input.requestId) {
      throw new Error('The prepared Trilium import expired. Start the import again.');
    }
    if (session.resolvedImages) {
      return {
        requestId: input.requestId,
        sessionId: input.sessionId,
        assets: session.resolvedImages as TriliumImportImageAsset[],
        placeholderCount: session.resolvedImages.filter((asset) => asset.status === 'placeholder').length,
      };
    }
    if (session.resolvingImages || !session.tokenBuffer) {
      throw new Error('The Trilium images are already being resolved.');
    }
    session.resolvingImages = true;
    const task = (async () => {
      const initialSettings = await getS3SyncRuntime().getSettings();
      const initialTarget = notesImageTarget(initialSettings);
      const images = await resolveTriliumImportImages(
        session.plan,
        session.tokenBuffer?.toString('utf8') ?? '',
        (upload, context) => getS3SyncRuntime().uploadNoteImage(upload, context.signal),
        {
          signal: session.controller.signal,
          onProgress: (progress) => sendTriliumImportProgress(event.sender, {
            requestId: input.requestId,
            phase: 'images',
            completed: progress.processed,
            total: Math.max(1, progress.total),
            message: progress.total > 0
              ? `Importing images… ${progress.processed}/${progress.total} · ${formatTriliumImageTransferProgress(progress.transferredBytes)}`
              : 'No Trilium images to import.',
          }),
        },
      );
      if (session.controller.signal.aborted) throw new Error('The Trilium import was cancelled.');
      const uploaded = images.some((asset) => asset.status === 'uploaded');
      const finalSettings = await getS3SyncRuntime().getSettings();
      if (uploaded && notesImageTarget(finalSettings) !== initialTarget) {
        throw new Error('S3 settings changed during the Trilium image import. Start the import again.');
      }
      session.resolvedImages = images;
      if (uploaded) session.s3ImageTarget = initialTarget;
      clearPreparedTriliumToken(session);
      return {
        requestId: input.requestId,
        sessionId: input.sessionId,
        assets: images as TriliumImportImageAsset[],
        placeholderCount: images.filter((asset) => asset.status === 'placeholder').length,
      };
    })();
    try {
      return await trackTriliumImportTask(task);
    } catch (error) {
      removePreparedTriliumImport(input.sessionId, true);
      activeTriliumImportRequests.delete(input.requestId);
      throw error;
    } finally {
      session.resolvingImages = false;
    }
  });
  ipcMain.handle(IPC_CHANNELS.triliumImportApply, async (event, inputValue: unknown): Promise<TriliumImportResult> => {
    const input = validateTriliumImportApply(inputValue);
    prunePreparedTriliumImports();
    const session = preparedTriliumImports.get(input.sessionId);
    if (!session
      || session.senderId !== event.sender.id
      || session.requestId !== input.requestId) {
      throw new Error('The prepared Trilium import expired. Start the import again.');
    }
    if (!session.resolvedImages) {
      throw new Error('Resolve the Trilium images before applying the import.');
    }
    const expectedHtmlIds = session.plan.notes
      .filter((note) => note.content.kind === 'html' || note.content.kind === 'image')
      .map((note) => note.localNoteId)
      .sort();
    const convertedIds = input.convertedNotes.map((note) => note.noteId).sort();
    if (!isDeepStrictEqual(expectedHtmlIds, convertedIds)) {
      throw new Error('The converted Trilium content is incomplete.');
    }
    validateConvertedTriliumImages(session.plan, session.resolvedImages, input.convertedNotes);
    removePreparedTriliumImport(input.sessionId);

    const task = (async (): Promise<TriliumImportResult> => {
      sendTriliumImportProgress(event.sender, {
        requestId: input.requestId,
        phase: 'applying',
        completed: 0,
        total: 1,
        message: 'Applying imported Notes…',
      });
      const rendererApply = await prepareRendererNotesPersistentApply();
      let reloadOwnsRelease = false;
      try {
        if (session.s3ImageTarget) {
          const settings = await getS3SyncRuntime().getSettings();
          if (notesImageTarget(settings) !== session.s3ImageTarget) {
            throw new Error('S3 settings changed after the Trilium images were imported. Start the import again.');
          }
        }
        const applied = await runS3SharedDataMutation(async () => {
          assertNotesWorkspaceSafe();
          const previousNotes = getNotesStore().exportSnapshot();
          const previousTombstones = getNotesStore().exportTombstones();
          const previousTree = getNotesTreeStore().snapshot();
          const previousExpanded = getNotesTreeViewStore().snapshot().expandedNoteIds;
          const convertedHtml = Object.fromEntries(input.convertedNotes.map((note) => [note.noteId, note.content]));
          const merged = mergeTriliumImport({
            plan: session.plan,
            convertedHtml,
            notes: previousNotes,
            tombstones: previousTombstones,
            tree: previousTree,
          });
          const notesChanged = !isDeepStrictEqual(previousNotes, merged.notes)
            || !isDeepStrictEqual(previousTombstones, merged.tombstones);
          const treeChanged = !isDeepStrictEqual(previousTree, merged.tree);
          let notesDelta: NotesWorkspaceDelta | undefined;
          if (notesChanged || treeChanged) {
            try {
              notesDelta = await getNotesWorkspaceApplyCoordinator().replace({
                notes: merged.notes,
                tombstones: merged.tombstones,
                tree: merged.tree,
              });
            } catch (error) {
              await restoreNotesWorkspace(previousNotes, previousTombstones, previousTree, previousExpanded);
              throw error;
            }
            s3SyncRuntime?.markLocalChange({
              kind: 'notes',
              upsertIds: notesDelta.upsertedNotes.map((note) => note.id),
              deleteIds: notesDelta.removedNoteIds,
              treeChanged,
            });
          }
          return { summary: merged.summary, changed: notesChanged || treeChanged, notesDelta };
        });

        const result: TriliumImportResult = {
          total: applied.summary.imported,
          created: applied.summary.created,
          updated: applied.summary.updated,
          unchanged: applied.summary.unchanged,
          placeholderCount: applied.summary.placeholders,
          cloneCount: applied.summary.clones,
          embeddedImageCount: input.convertedNotes.reduce(
            (total, note) => total + note.embeddedImageCount,
            0,
          ),
          imagePlaceholderCount: input.convertedNotes.reduce(
            (total, note) => total + note.imagePlaceholderCount,
            0,
          ),
          plainTextFallbackCount: input.convertedNotes.filter(
            (note) => note.usedPlainTextFallback,
          ).length,
        };
        if (applied.changed) {
          reloadOwnsRelease = publishPersistentDataReload('trilium', rendererApply, {
            ...(applied.notesDelta ? { notesDelta: applied.notesDelta } : {}),
          });
        }
        sendTriliumImportProgress(event.sender, {
          requestId: input.requestId,
          phase: 'complete',
          completed: 1,
          total: 1,
          message: `Imported ${result.total} Notes.`,
        });
        return result;
      } finally {
        if (!reloadOwnsRelease) releaseRendererNotesPersistentApply(rendererApply);
      }
    })();
    try {
      return await trackTriliumImportTask(task);
    } finally {
      const active = activeTriliumImportRequests.get(input.requestId);
      if (active?.controller === session.controller) activeTriliumImportRequests.delete(input.requestId);
    }
  });
  ipcMain.handle(IPC_CHANNELS.triliumImportCancel, async (event, requestIdValue: unknown) => {
    const requestId = validateTriliumRequestId(requestIdValue);
    const active = activeTriliumImportRequests.get(requestId);
    if (active?.senderId === event.sender.id) active.controller.abort();
    for (const [sessionId, session] of preparedTriliumImports) {
      if (session.senderId === event.sender.id && session.requestId === requestId) {
        removePreparedTriliumImport(sessionId, true);
      }
    }
    if (active?.senderId === event.sender.id) {
      await Promise.allSettled([...activeTriliumImportTasks]);
      activeTriliumImportRequests.delete(requestId);
    }
  });
  ipcMain.handle(IPC_CHANNELS.llmSettingsGet, async () => getLlmSettingsStore().get());
  ipcMain.handle(IPC_CHANNELS.llmSettingsSave, async (_event, draft: unknown) =>
    getLlmSettingsStore().save(draft)
  );
  ipcMain.handle(IPC_CHANNELS.llmSettingsReveal, async () => getLlmSettingsStore().revealToken());
  ipcMain.handle(IPC_CHANNELS.llmModelsList, async (_event, draftValue: unknown) => {
    if (!isRecord(draftValue)
      || typeof draftValue.endpoint !== 'string'
      || (draftValue.token !== undefined && typeof draftValue.token !== 'string')
      || (draftValue.useSavedToken !== undefined && typeof draftValue.useSavedToken !== 'boolean')) {
      throw new Error('The LLM model request is invalid.');
    }
    const draft = draftValue as unknown as LlmModelsDraft;
    let token = draft.token;
    if (!token && draft.useSavedToken) token = await getLlmSettingsStore().revealToken();
    const controller = new AbortController();
    activeLlmModelRequests.add(controller);
    try {
      return await fetchLlmModels({ endpoint: draft.endpoint, ...(token ? { token } : {}), signal: controller.signal });
    } finally {
      activeLlmModelRequests.delete(controller);
    }
  });
  ipcMain.handle(IPC_CHANNELS.sqlAuthState, async (_event, environment: unknown) =>
    getSqlRuntime().getAuthState(environment)
  );
  ipcMain.handle(IPC_CHANNELS.sqlLogin, async (_event, input: unknown) =>
    getSqlRuntime().login(input)
  );
  ipcMain.handle(IPC_CHANNELS.sqlLogout, async (_event, environment: unknown) =>
    getSqlRuntime().logout(environment)
  );
  ipcMain.handle(IPC_CHANNELS.sqlQueriesList, async (_event, input: unknown) => {
    if (!isRecord(input) || Object.keys(input).some((key) => !['environment', 'search'].includes(key))) {
      throw new Error('The saved query list request is invalid.');
    }
    return getSqlRuntime().listQueries(input.environment, input.search);
  });
  ipcMain.handle(IPC_CHANNELS.sqlQueryGet, async (_event, input: unknown) => {
    if (!isRecord(input) || Object.keys(input).some((key) => !['environment', 'id'].includes(key))) {
      throw new Error('The saved query request is invalid.');
    }
    return getSqlRuntime().getQuery(input.environment, input.id);
  });
  ipcMain.handle(IPC_CHANNELS.sqlQueryCreate, async (_event, input: unknown) => {
    if (!isRecord(input) || Object.keys(input).some((key) => !['environment', 'draft'].includes(key))) {
      throw new Error('The saved query create request is invalid.');
    }
    return getSqlRuntime().createQuery(input.environment, input.draft);
  });
  ipcMain.handle(IPC_CHANNELS.sqlQueryUpdate, async (_event, input: unknown) => {
    if (!isRecord(input) || Object.keys(input).some((key) => !['environment', 'id', 'draft'].includes(key))) {
      throw new Error('The saved query update request is invalid.');
    }
    return getSqlRuntime().updateQuery(input.environment, input.id, input.draft);
  });
  ipcMain.handle(IPC_CHANNELS.sqlQueryRename, async (_event, input: unknown) => {
    if (!isRecord(input) || Object.keys(input).some((key) => !['environment', 'id', 'name'].includes(key))) {
      throw new Error('The saved query rename request is invalid.');
    }
    return getSqlRuntime().renameQuery(input.environment, input.id, input.name);
  });
  ipcMain.handle(IPC_CHANNELS.sqlQueryDelete, async (_event, input: unknown) => {
    if (!isRecord(input) || Object.keys(input).some((key) => !['environment', 'id'].includes(key))) {
      throw new Error('The saved query delete request is invalid.');
    }
    await getSqlRuntime().deleteQuery(input.environment, input.id);
  });
  ipcMain.handle(IPC_CHANNELS.sqlExecute, async (_event, input: unknown) => {
    if (!isRecord(input) || Object.keys(input).some((key) => !['environment', 'statement', 'options'].includes(key))) {
      throw new Error('The SQL execution request is invalid.');
    }
    return getSqlRuntime().execute(input.environment, input.statement, input.options);
  });
  ipcMain.handle(IPC_CHANNELS.sqlSchemaGet, async (_event, environment: unknown) =>
    getSqlRuntime().getSchema(environment)
  );
  ipcMain.handle(IPC_CHANNELS.s3SettingsGet, async () => getS3SyncRuntime().getS3SyncSettings());
  ipcMain.handle(
    IPC_CHANNELS.startupS3SyncGet,
    (): StartupS3SyncState => getS3SyncRuntime().getStartupSyncState()
  );
  ipcMain.handle(IPC_CHANNELS.s3SettingsSave, async (_event, draft: unknown) =>
    getS3SyncRuntime().saveS3SyncSettings(draft)
  );
  ipcMain.handle(IPC_CHANNELS.s3SettingsTest, async (_event, draft: unknown) =>
    getS3SyncRuntime().testS3Connection(draft)
  );
  ipcMain.handle(IPC_CHANNELS.s3SettingsReveal, async () =>
    getS3SyncRuntime().revealS3SyncCredentials()
  );
  ipcMain.handle(IPC_CHANNELS.s3Sync, async () => getS3SyncRuntime().syncAllDataToS3());

  ipcMain.handle(IPC_CHANNELS.exportConfig, async (): Promise<ConfigTransferResult | null> => {
    const hosts = getStore().listHosts();
    const suggestedName = `service-manager-config-${new Date().toISOString().slice(0, 10)}.json`;
    const result = await dialog.showSaveDialog({
      title: 'Export Service Manager Config',
      defaultPath: path.join(app.getPath('documents'), suggestedName),
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    const payload: ExportedConfigFile = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      app: 'service-manager',
      hosts,
    };
    await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return {
      path: result.filePath,
      hostCount: hosts.length,
      ruleCount: countRules(hosts),
      serviceCount: countServices(hosts),
    };
  });

  ipcMain.handle(IPC_CHANNELS.importConfig, async (): Promise<ConfigTransferResult | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Import Service Manager Config',
      defaultPath: app.getPath('documents'),
      properties: ['openFile'],
      filters: [
        { name: 'JSON Files', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const selectedPath = result.filePaths[0];
    const raw = await fs.readFile(selectedPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Invalid JSON file.');
    }

    const importedDrafts = parseImportedHostDrafts(parsed);
    const validatedHosts = ensureUniqueImportedIds(
      importedDrafts.map((draft, index) => {
        try {
          return validateHostDraft(draft);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Host ${index + 1}: ${message}`);
        }
      })
    );

    await mutateS3SharedData(async () => {
      const existingHosts = getStore().listHosts();
      await portForwardManager.stopAll();
      await tunnelManager.stopAll();
      for (const host of existingHosts) {
        for (const forward of host.forwards) {
          tunnelManager.clearTunnel(forward.id);
          forwardOwners.delete(forward.id);
        }
        for (const service of host.services) {
          emitForwardStatus(host.id, service.id, 'none');
        }
      }

      await getStore().replaceHosts(validatedHosts);
      syncKnownForwards(validatedHosts);
      for (const host of validatedHosts) {
        await autoStartHostRules(host);
      }
    });

    return {
      path: selectedPath,
      hostCount: validatedHosts.length,
      ruleCount: countRules(validatedHosts),
      serviceCount: countServices(validatedHosts),
    };
  });

  ipcMain.handle(IPC_CHANNELS.saveHost, async (_event, hostDraft: HostDraft) => {
    return mutateS3SharedData(async () => {
      const previous = hostDraft.id ? getStore().findHostById(hostDraft.id) : undefined;
      if (previous) {
        await portForwardManager.stopMany(previous.services.map((service) => serviceForwardKey(previous.id, service.id)));
        await stopAllHostRules(previous);
        for (const service of previous.services) {
          emitForwardStatus(previous.id, service.id, 'none');
        }
      }

      const validated = validateHostDraft(hostDraft);
      const host = preserveServiceRuntimeFields(previous, validated);

      if (previous) {
        await clearRemovedRules(previous, host);
      }

      for (const forward of host.forwards) {
        tunnelManager.setKnownTunnel(forward.id);
        forwardOwners.set(forward.id, host.id);
      }

      await getStore().upsertHost(host);
      await autoStartHostRules(host);

      for (const service of host.services) {
        if (!service.pid || !service.forwardLocalPort || service.port === 0) {
          emitForwardStatus(host.id, service.id, 'none');
          continue;
        }
        const status = await checkServiceStatus(host, service);
        if (status.status === 'running') {
          if (status.pid) {
            service.pid = status.pid;
          }
          try {
            await portForwardManager.start(serviceForwardKey(host.id, service.id), host, service);
            emitForwardStatus(host.id, service.id, 'ok');
          } catch (error) {
            logRuntimeError('port-forward:start', error, {
              hostId: host.id,
              serviceId: service.id,
              localPort: service.forwardLocalPort,
              remotePort: service.port,
            });
            emitForwardStatus(host.id, service.id, 'error', error instanceof Error ? error.message : String(error));
          }
        } else {
          emitForwardStatus(host.id, service.id, 'none');
        }
      }

      await getStore().upsertHost(host);
      return toView([host])[0];
    });
  });

  ipcMain.handle(IPC_CHANNELS.deleteHost, async (_event, hostId: string) => {
    await mutateS3SharedData(async () => {
      const host = getStore().findHostById(hostId);
      if (!host) return;

      await portForwardManager.stopMany(host.services.map((service) => serviceForwardKey(host.id, service.id)));
      await stopAllHostRules(host);
      for (const forward of host.forwards) {
        tunnelManager.clearTunnel(forward.id);
        forwardOwners.delete(forward.id);
      }
      for (const service of host.services) {
        emitForwardStatus(host.id, service.id, 'none');
      }

      await getStore().removeHost(hostId);
    });
  });

  ipcMain.handle(IPC_CHANNELS.deleteService, async (_event, payload: { hostId: string; serviceId: string }) => {
    await serviceOperationQueue.run(serviceKey(payload.hostId, payload.serviceId), () =>
      mutateS3SharedData(async () => {
        await portForwardManager.stop(serviceForwardKey(payload.hostId, payload.serviceId));
        emitForwardStatus(payload.hostId, payload.serviceId, 'none');
        await getStore().removeService(payload.hostId, payload.serviceId);
      })
    );
  });

  ipcMain.handle(IPC_CHANNELS.deleteForward, async (_event, payload: { hostId: string; forwardId: string }) => {
    await mutateS3SharedData(async () => {
      await tunnelManager.stop(payload.forwardId);
      tunnelManager.clearTunnel(payload.forwardId);
      forwardOwners.delete(payload.forwardId);
      await getStore().removeForward(payload.hostId, payload.forwardId);
    });
  });

  ipcMain.handle(IPC_CHANNELS.confirmAction, async (event, options: ConfirmDialogOptions) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const icon = getAppIconImage();
    const messageBoxOptions = {
      type: options.kind ?? 'question',
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: [options.cancelLabel ?? 'Cancel', options.confirmLabel ?? 'Confirm'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
      ...(icon ? { icon } : {}),
    };
    const result = parentWindow
      ? await dialog.showMessageBox(parentWindow, messageBoxOptions)
      : await dialog.showMessageBox(messageBoxOptions);

    return result.response === 1;
  });

  ipcMain.handle(IPC_CHANNELS.startForward, async (_event, payload: { hostId: string; forwardId: string }) => {
    const host = getStore().findHostById(payload.hostId);
    if (!host) throw new Error('Host not found.');
    const forward = host.forwards.find((item) => item.id === payload.forwardId);
    if (!forward) throw new Error('Forward rule not found.');

    const config = await forwardToRuntimeConfig(host, forward);
    await tunnelManager.start(config);
  });

  ipcMain.handle(IPC_CHANNELS.stopForward, async (_event, payload: { hostId: string; forwardId: string }) => {
    const host = getStore().findHostById(payload.hostId);
    if (!host) throw new Error('Host not found.');
    const forward = host.forwards.find((item) => item.id === payload.forwardId);
    if (!forward) throw new Error('Forward rule not found.');

    await tunnelManager.stop(forward.id);
  });

  ipcMain.handle(
    IPC_CHANNELS.refreshHostServices,
    async (
      _event,
      payload: { hostId: string; serviceIds: string[] } & ServiceRefreshOptions
    ) => {
      const host = getStore().findHostById(payload.hostId);
      if (!host) throw new Error('Host not found.');
      if (!Array.isArray(payload.serviceIds) || payload.serviceIds.length > host.services.length) {
        throw new Error('Service status request is invalid.');
      }
      const knownServiceIds = new Set(host.services.map((service) => service.id));
      const serviceIds = [...new Set(payload.serviceIds)];
      if (serviceIds.some((serviceId) => typeof serviceId !== 'string' || !knownServiceIds.has(serviceId))) {
        throw new Error('Service not found.');
      }
      await refreshHostServicesRuntime(payload.hostId, serviceIds, Boolean(payload.silent));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.refreshService,
    async (_event, payload: { hostId: string; serviceId: string } & ServiceRefreshOptions) => {
      const host = getStore().findHostById(payload.hostId);
      if (!host) throw new Error('Host not found.');
      if (!host.services.some((service) => service.id === payload.serviceId)) {
        throw new Error('Service not found.');
      }
      await refreshHostServicesRuntime(payload.hostId, [payload.serviceId], Boolean(payload.silent));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.startService,
    async (_event, payload: { hostId: string; serviceId: string }) => {
      return serviceOperationQueue.run(serviceKey(payload.hostId, payload.serviceId), async () => {
        try {
          const host = getStore().findHostById(payload.hostId);
          if (!host) throw new Error('Host not found.');
          const service = host.services.find((item) => item.id === payload.serviceId);
          if (!service) throw new Error('Service not found.');

          emitStatus(host.id, service.id, 'starting');
          const ret = await startService(host, service);
          if (!ret.ok) {
            logRuntimeError('service:start', ret.error ?? 'unknown start failure', payload);
            emitStatus(host.id, service.id, 'error', undefined, ret.error);
            return;
          }

          if (!await persistServicePidIfCurrent(host.id, service.id, service.startCommand, service.port, ret.pid)) {
            throw new Error('Service configuration changed while the start operation was running. Refresh and try again.');
          }
          service.pid = ret.pid;
          if (!service.forwardLocalPort || service.port === 0) {
            emitForwardStatus(host.id, service.id, 'none');
          }
          emitStatus(host.id, service.id, 'running', service.pid);
        } catch (error) {
          logRuntimeError('service:start', error, payload);
          throw error;
        }
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.stopService,
    async (_event, payload: { hostId: string; serviceId: string }) => {
      return serviceOperationQueue.run(serviceKey(payload.hostId, payload.serviceId), async () => {
        try {
          const host = getStore().findHostById(payload.hostId);
          if (!host) throw new Error('Host not found.');
          const service = host.services.find((item) => item.id === payload.serviceId);
          if (!service) throw new Error('Service not found.');

          emitStatus(host.id, service.id, 'stopping', service.pid);
          const ret = await stopService(host, service);
          if (!ret.ok) {
            logRuntimeError('service:stop', ret.error ?? 'unknown stop failure', payload);
            emitStatus(host.id, service.id, 'error', service.pid, ret.error);
            return;
          }

          await portForwardManager.stop(serviceForwardKey(host.id, service.id));
          emitForwardStatus(host.id, service.id, 'none');
          if (!await persistServicePidIfCurrent(host.id, service.id, service.startCommand, service.port, undefined)) {
            throw new Error('Service configuration changed while the stop operation was running. Refresh and try again.');
          }
          service.pid = undefined;
          emitStatus(host.id, service.id, 'stopped', undefined);
        } catch (error) {
          logRuntimeError('service:stop', error, payload);
          throw error;
        }
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.getServiceLogs,
    async (_event, payload: { hostId: string; serviceId: string; query?: { lineLimit?: number } }): Promise<ServiceLogsResult> => {
      try {
        const host = getStore().findHostById(payload.hostId);
        if (!host) throw new Error('Host not found.');
        const service = host.services.find((item) => item.id === payload.serviceId);
        if (!service) throw new Error('Service not found.');
        return getServiceLogs(host, service, payload.query);
      } catch (error) {
        logRuntimeError('service:logs', error, payload);
        throw error;
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.importPrivateKey, async (): Promise<PrivateKeyImportResult | null> => {
    const window = primaryRendererWindow();
    const sshDefaultDir = path.join(app.getPath('home'), '.ssh');
    let dialogDefaultPath = sshDefaultDir;
    try {
      await fs.access(sshDefaultDir);
    } catch {
      dialogDefaultPath = app.getPath('home');
    }

    const result = window
      ? await dialog.showOpenDialog(window, {
        title: 'Import Private Key',
        defaultPath: dialogDefaultPath,
        properties: ['openFile'],
        filters: [{ name: 'All Files', extensions: ['*'] }],
      })
      : await dialog.showOpenDialog({
      title: 'Import Private Key',
      defaultPath: dialogDefaultPath,
      properties: ['openFile'],
      filters: [{ name: 'All Files', extensions: ['*'] }],
      });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const filePath = result.filePaths[0];
    const content = await fs.readFile(filePath, 'utf8');
    return { path: filePath, content };
  });

  ipcMain.handle(IPC_CHANNELS.openExternal, async (_event, rawUrl: string) => {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('Invalid URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http/https URLs are allowed.');
    }
    await shell.openExternal(parsed.toString());
  });

  ipcMain.handle(IPC_CHANNELS.readClipboardText, async () => {
    return clipboard.readText();
  });

  ipcMain.handle(IPC_CHANNELS.writeClipboardText, async (_event, text: string) => {
    clipboard.writeText(text ?? '');
  });

  ipcMain.handle(IPC_CHANNELS.getUpdateState, async () => {
    return updater.getState();
  });

  ipcMain.handle(IPC_CHANNELS.checkUpdates, async () => {
    return updater.checkForUpdates('manual');
  });

  ipcMain.handle(IPC_CHANNELS.changelogGet, async () => {
    return buildChangelogView(app.getVersion(), getChangelogSeenStore().getSeenVersion());
  });

  ipcMain.handle(IPC_CHANNELS.changelogMarkSeen, async () => {
    await getChangelogSeenStore().markSeen(app.getVersion());
  });

  const getKubernetesRuntime = (): KubernetesRuntime => {
    if (!kubernetesRuntime) {
      throw new Error('Kubernetes runtime is not initialized.');
    }
    return kubernetesRuntime;
  };

  ipcMain.handle(IPC_CHANNELS.appMemoryUsage, async () => {
    const proxyState = await getProxyRuntime().getState();
    return collectAppMemoryUsage({
      metrics: () => app.getAppMetrics(),
      platform: process.platform,
      mihomoPid: proxyState.pid,
    });
  });

  ipcMain.handle(IPC_CHANNELS.proxyGetState, async () => getProxyRuntime().getState());
  ipcMain.handle(IPC_CHANNELS.proxyDownloadCore, async () => getProxyRuntime().downloadCore());
  ipcMain.handle(IPC_CHANNELS.proxyStart, async (_event, mixedPort: unknown) =>
    getProxyRuntime().start(validateProxyMixedPort(mixedPort))
  );
  ipcMain.handle(IPC_CHANNELS.proxyStop, async () => getProxyRuntime().stop());
  ipcMain.handle(IPC_CHANNELS.proxySaveAndFetchSubscription, async (_event, url: string) =>
    mutateS3SharedData(() => getProxyRuntime().saveAndFetchSubscription(url))
  );
  ipcMain.handle(IPC_CHANNELS.proxySetMode, async (_event, mode: ProxyMode) =>
    mutateS3SharedData(() => getProxyRuntime().setMode(mode))
  );
  ipcMain.handle(IPC_CHANNELS.proxySetSystemProxy, async (_event, enabled: boolean) =>
    getProxyRuntime().setSystemProxy(enabled)
  );
  ipcMain.handle(IPC_CHANNELS.proxySetTun, async (_event, enabled: boolean) => getProxyRuntime().setTun(enabled));
  ipcMain.handle(IPC_CHANNELS.proxyAddException, async (_event, draft: unknown) =>
    mutateS3SharedData(() => getProxyRuntime().addException(validateProxyExceptionDraft(draft)))
  );
  ipcMain.handle(
    IPC_CHANNELS.proxyUpdateException,
    async (_event, payload: { id?: unknown; draft?: unknown }) =>
      mutateS3SharedData(() => getProxyRuntime().updateException(
        validateProxyExceptionId(payload?.id),
        validateProxyExceptionDraft(payload?.draft)
      ))
  );
  ipcMain.handle(IPC_CHANNELS.proxyDeleteException, async (_event, id: unknown) =>
    mutateS3SharedData(() => getProxyRuntime().deleteException(validateProxyExceptionId(id)))
  );
  ipcMain.handle(IPC_CHANNELS.proxyGrantTun, async () => getProxyRuntime().grantTun());
  ipcMain.handle(IPC_CHANNELS.proxyRevokeTun, async () => getProxyRuntime().revokeTun());
  ipcMain.handle(IPC_CHANNELS.proxyListProxies, async () => getProxyRuntime().listProxies());
  ipcMain.handle(IPC_CHANNELS.proxyTestDelays, async () => getProxyRuntime().testProxyDelays());
  ipcMain.handle(
    IPC_CHANNELS.proxySelectProxy,
    async (_event, selection: { groupName?: unknown; optionName?: unknown }) => {
      if (typeof selection?.groupName !== 'string' || typeof selection.optionName !== 'string') {
        throw new Error('A strategy group and candidate name are required.');
      }
      return mutateS3SharedData(() => getProxyRuntime().selectProxy(selection.groupName as string, selection.optionName as string));
    }
  );
  ipcMain.handle(IPC_CHANNELS.proxyGetLogs, async () => getProxyRuntime().getLogs());

  ipcMain.handle(IPC_CHANNELS.kubernetesGetState, async () => getKubernetesRuntime().getState());
  ipcMain.handle(IPC_CHANNELS.kubernetesSelectContext, async (_event, name: unknown) =>
    getKubernetesRuntime().selectContext(validateKubernetesText(name, 'Context name'))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesReconnect, async () => getKubernetesRuntime().reconnect());
  ipcMain.handle(IPC_CHANNELS.kubernetesReloadKubeconfig, async () => getKubernetesRuntime().reloadKubeconfig());
  ipcMain.handle(IPC_CHANNELS.kubernetesSetNamespaceScope, async (_event, scope: unknown) =>
    getKubernetesRuntime().setNamespaceScope(validateKubernetesNamespaceScope(scope))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesListNamespaces, async () =>
    getKubernetesRuntime().listNamespaces()
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesListResources, async (_event, query: unknown) =>
    getKubernetesRuntime().listResources(validateKubernetesQuery(query))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesGetResourceWindow, async (_event, payload: unknown) => {
    if (!isRecord(payload)) throw new Error('Kubernetes resource window request is invalid.');
    return getKubernetesRuntime().getResourceWindow(
      validateKubernetesQuery(payload.query),
      validateKubernetesWindowRange(payload.range)
    );
  });
  ipcMain.handle(IPC_CHANNELS.kubernetesLoadMoreResources, async (_event, query: unknown) =>
    getKubernetesRuntime().loadMoreResources(validateKubernetesQuery(query))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesListCustomResourceDefinitions, async () =>
    getKubernetesRuntime().listCustomResourceDefinitions()
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesGetResourceDetail,
    async (_event, payload: unknown) => {
      if (!isRecord(payload)) throw new Error('Kubernetes resource detail request is invalid.');
      return getKubernetesRuntime().getResourceDetail(
        validateKubernetesQuery(payload.query),
        validateKubernetesText(payload.name, 'resource name'),
        payload.namespace === undefined ? undefined : validateKubernetesText(payload.namespace, 'Namespace')
      );
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesGetResourceEvents,
    async (_event, payload: unknown) => {
      if (!isRecord(payload)) throw new Error('Kubernetes Events request is invalid.');
      return getKubernetesRuntime().getResourceEvents(
        validateKubernetesText(payload.uid, 'resource UID'),
        payload.namespace === undefined ? undefined : validateKubernetesText(payload.namespace, 'Namespace')
      );
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesGetRelatedResources,
    async (_event, request: unknown) => getKubernetesRuntime().getRelatedResources(
      validateKubernetesRelatedResourceRequest(request)
    )
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesGetPodEnvironment, async (_event, input: unknown) =>
    getKubernetesRuntime().getPodContainerEnvironment(validateKubernetesPodTarget(input))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesOpenLogs, async (_event, input: unknown) =>
    getKubernetesRuntime().openLogs(validateKubernetesPodTarget(input))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesLoadOlderLogs, async (_event, id: unknown) =>
    getKubernetesRuntime().loadOlderLogs(validateKubernetesText(id, 'log session ID'))
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesSetLogScope,
    async (_event, payload: unknown) => {
      if (!isRecord(payload) || (payload.scope !== 'pod' && payload.scope !== 'deployment')) {
        throw new Error('Kubernetes log scope request is invalid.');
      }
      return getKubernetesRuntime().setLogScope(
        validateKubernetesText(payload.id, 'log session ID'),
        payload.scope as KubernetesLogScope
      );
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesSetLogFollowing,
    async (_event, payload: unknown) => {
      if (!isRecord(payload) || typeof payload.following !== 'boolean') throw new Error('Kubernetes log following request is invalid.');
      return getKubernetesRuntime().setLogFollowing(validateKubernetesText(payload.id, 'log session ID'), payload.following);
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesSetLogStartTime,
    async (_event, payload: unknown) => {
      if (!isRecord(payload) || (payload.startTime !== undefined && typeof payload.startTime !== 'string')) {
        throw new Error('Kubernetes log start time request is invalid.');
      }
      return getKubernetesRuntime().setLogStartTime(
        validateKubernetesText(payload.id, 'log session ID'),
        payload.startTime === undefined
          ? undefined
          : validateKubernetesText(payload.startTime, 'log start time', 64)
      );
    }
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesClearLogs, async (_event, id: unknown) =>
    getKubernetesRuntime().clearLogs(validateKubernetesText(id, 'log session ID'))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesCloseLogs, async (_event, id: unknown) =>
    getKubernetesRuntime().closeLogs(validateKubernetesText(id, 'log session ID'))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesOpenTerminal, async (_event, input: unknown) =>
    getKubernetesRuntime().openTerminal(validateKubernetesPodTarget(input))
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesWriteTerminal,
    async (_event, payload: unknown) => {
      if (!isRecord(payload)) throw new Error('Kubernetes terminal input is invalid.');
      return getKubernetesRuntime().writeTerminal(
        validateKubernetesText(payload.id, 'terminal ID'),
        validateKubernetesTerminalInput(payload.data)
      );
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesResizeTerminal,
    async (_event, payload: unknown) => {
      if (!isRecord(payload) || typeof payload.cols !== 'number' || !Number.isInteger(payload.cols) || payload.cols < 1
        || typeof payload.rows !== 'number' || !Number.isInteger(payload.rows) || payload.rows < 1) {
        throw new Error('Kubernetes terminal dimensions are invalid.');
      }
      return getKubernetesRuntime().resizeTerminal(
        validateKubernetesText(payload.id, 'terminal ID'),
        payload.cols,
        payload.rows
      );
    }
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesCloseTerminal, async (_event, id: unknown) =>
    getKubernetesRuntime().closeTerminal(validateKubernetesText(id, 'terminal ID'))
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesOpenVnc,
    async (_event, input: unknown): Promise<KubernetesVncLaunchResult> => {
      const handle = await getKubernetesRuntime().openVnc(validateKubernetesVncTarget(input));
      const viewerPassword = handle.takeViewerPassword();
      const authority = viewerPassword
        ? `vnc:${encodeURIComponent(viewerPassword)}@127.0.0.1`
        : '127.0.0.1';
      try {
        await shell.openExternal(`vnc://${authority}:${handle.localPort}`);
      } catch {
        await handle.close().catch(() => undefined);
        throw new Error('Unable to open the system VNC client. Install or configure a VNC client that handles vnc:// links.');
      }
      return {
        namespace: handle.namespace,
        podName: handle.podName,
        vmiName: handle.vmiName,
        localPort: handle.localPort,
      };
    }
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesStartPortForward, async (_event, input: unknown) =>
    getKubernetesRuntime().startPortForward(validateKubernetesPortForward(input))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesStopPortForward, async (_event, id: unknown) =>
    getKubernetesRuntime().stopPortForward(validateKubernetesText(id, 'port forward ID'))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesStopAllPortForwards, async () =>
    getKubernetesRuntime().stopAllPortForwards()
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesListPortForwards, async () => getKubernetesRuntime().listPortForwards());
  ipcMain.handle(IPC_CHANNELS.kubernetesDeactivatePage, async () => getKubernetesRuntime().deactivatePage());
}

function wireProxyStateBroadcast(): void {
  proxyRuntime?.on('state-changed', (state: ProxyState) => {
    broadcast(IPC_CHANNELS.proxyStateChanged, state);
  });
  proxyRuntime?.on('traffic-changed', (traffic: ProxyTraffic | null) => {
    broadcast(IPC_CHANNELS.proxyTrafficChanged, traffic);
  });
}

function wireKubernetesBroadcast(): void {
  kubernetesRuntime?.onStateChanged((state: KubernetesState) => {
    broadcast(IPC_CHANNELS.kubernetesStateChanged, state);
  });
  kubernetesRuntime?.onListChanged((snapshot: KubernetesListSnapshot) => {
    broadcast(IPC_CHANNELS.kubernetesListChanged, snapshot);
  });
  kubernetesRuntime?.onLogChanged((update: KubernetesLogUpdate) => {
    broadcast(IPC_CHANNELS.kubernetesLogChanged, update);
  });
  kubernetesRuntime?.onTerminalChanged((state: KubernetesTerminalState) => {
    broadcast(IPC_CHANNELS.kubernetesTerminalChanged, state);
  });
  kubernetesRuntime?.onTerminalOutput((output: KubernetesTerminalOutput) => {
    broadcast(IPC_CHANNELS.kubernetesTerminalOutput, output);
  });
  kubernetesRuntime?.onPortForwardChanged((state: KubernetesPortForwardState) => {
    broadcast(IPC_CHANNELS.kubernetesPortForwardChanged, state);
  });
}

function wireForwardStatusBroadcast(): void {
  tunnelManager.on('status-changed', (change: TunnelStatusChange) => {
    const hostId = forwardOwners.get(change.forwardId) ?? change.hostId;
    const payload: TunnelStatusChange = {
      hostId,
      forwardId: change.forwardId,
      status: change.status,
      error: change.error,
      reconnectAt: change.reconnectAt,
    };
    broadcast(IPC_CHANNELS.forwardStatusChanged, payload);
  });
}

function wireUpdaterBroadcast(): void {
  updater.on('state-changed', (state: UpdateState) => {
    broadcast(IPC_CHANNELS.updateState, state);
  });
}

registerProcessErrorHandlers();
process.once('SIGINT', () => {
  requestQuitAfterRuntimeShutdown(true);
});
process.once('SIGTERM', () => {
  requestQuitAfterRuntimeShutdown(true);
});

let userDataInstanceLock: UserDataInstanceLock | undefined;
let userDataInstanceLockError: unknown;
function releaseUserDataInstanceLock(): void {
  const lock = userDataInstanceLock;
  userDataInstanceLock = undefined;
  if (!lock) return;
  try {
    lock.release();
  } catch {
    // A stale owner record is reclaimed safely on the next startup.
  }
}

let ownsSingleInstanceLock = false;
const userDataPathForInstanceLock = app.getPath('userData');
try {
  assertUserDataInstanceLockAvailable(userDataPathForInstanceLock);
} catch (error) {
  userDataInstanceLockError = error;
}

if (!userDataInstanceLockError) {
  ownsSingleInstanceLock = app.requestSingleInstanceLock();
  if (ownsSingleInstanceLock) {
    try {
      // Electron's lock serializes stale durable-lock reclamation between
      // competing current releases.
      userDataInstanceLock = acquireUserDataInstanceLock(userDataPathForInstanceLock);
    } catch (error) {
      userDataInstanceLockError = error;
      app.releaseSingleInstanceLock();
      ownsSingleInstanceLock = false;
    }
  }
} else if (
  userDataInstanceLockError instanceof UserDataInstanceLockError
  && userDataInstanceLockError.source === 'service-manager'
) {
  // Current releases create the durable lock only after acquiring Electron's
  // ProcessSingleton, so this cannot steal the lock from an owner that is
  // still between its two startup phases.
  const ownsTemporaryElectronLock = app.requestSingleInstanceLock();
  if (ownsTemporaryElectronLock) app.releaseSingleInstanceLock();
}

if (!ownsSingleInstanceLock) {
  // Notes directory transactions are intentionally single-writer. A second
  // process or an older installed/development build sharing userData must exit
  // before any persistent store is initialized.
  releaseUserDataInstanceLock();
  if (userDataInstanceLockError) {
    if (userDataInstanceLockError instanceof UserDataInstanceLockError) {
      const owner = userDataInstanceLockError.ownerPid
        ? ` (PID ${userDataInstanceLockError.ownerPid})`
        : '';
      console.error(`Service Manager data is already in use by another process${owner}.`);
    } else {
      console.error('Service Manager could not acquire exclusive access to its data directory.');
    }
  }
  app.exit(0);
} else {
  app.on('second-instance', () => {
    const window = primaryRendererWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
}

process.once('exit', () => {
  releaseUserDataInstanceLock();
});

app.whenReady()
  .then(async () => {
    if (!ownsSingleInstanceLock) return;
    const initializedRuntimeLogWriter = new RuntimeLogWriter(path.join(app.getPath('userData'), 'logs'));
    runtimeLogWriter = initializedRuntimeLogWriter;
    setServiceRuntimeDiagnostics((event) =>
      initializedRuntimeLogWriter.record('service:systemd-preflight', new Error('Systemd preflight probe failed'), {
        hostId: event.hostId,
        check: event.check,
        attempt: event.attempt,
        category: event.category,
        exitCode: event.exitCode,
        elapsedMs: event.elapsedMs,
        stderr: event.stderr,
      })
    );

    const filePath = path.join(app.getPath('userData'), 'service-manager.json');
    store = new ServiceStore(filePath);
    await store.load();
    const hosts = store.listHosts();
    syncKnownForwards(hosts);

    notesStore = new NotesStore(path.join(app.getPath('userData'), 'notes-v4'));
    await notesStore.load();

    notesTreeStore = new NotesTreeStore(path.join(app.getPath('userData'), 'notes-tree.json'));
    await notesTreeStore.load(notesStore.list().map((note) => note.id));
    notesTreeViewStore = new NotesTreeViewStore(path.join(app.getPath('userData'), 'notes-tree-view.json'));
    await notesTreeViewStore.load(notesStore.list().map((note) => note.id));
    notesWorkspaceApplyCoordinator = new NotesWorkspaceApplyCoordinator(
      app.getPath('userData'),
      notesStore,
      notesTreeStore,
      notesTreeViewStore,
    );
    await notesWorkspaceApplyCoordinator.recover();

    uiPreferencesStore = new UiPreferencesStore(path.join(app.getPath('userData'), 'ui-preferences.json'));
    await uiPreferencesStore.load();

    changelogSeenStore = new ChangelogSeenStore(path.join(app.getPath('userData'), 'changelog-seen.json'));
    await changelogSeenStore.load();

    const credentialProtector = {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value: string) => safeStorage.encryptString(value),
      decryptString: (value: Buffer) => safeStorage.decryptString(value),
      getSelectedStorageBackend: () => process.platform === 'linux'
        ? safeStorage.getSelectedStorageBackend()
        : 'unknown',
    };
    llmSettingsStore = new LlmSettingsStore({
      filePath: path.join(app.getPath('userData'), 'llm-settings.json'),
      credentialProtector,
    });
    await llmSettingsStore.load();

    const sqlCredentialsStore = new SqlCredentialsStore({
      filePath: path.join(app.getPath('userData'), 'sql-login.json'),
      credentialProtector,
      allowBasicTextFallback: process.platform === 'linux',
    });
    await sqlCredentialsStore.load();
    sqlRuntime = new SqlRuntime({ credentialsStore: sqlCredentialsStore });

    const userDataPath = app.getPath('userData');
    const initializedProxyRuntime = new ProxyRuntime(path.join(userDataPath, 'proxy'));
    proxyRuntime = initializedProxyRuntime;
    await initializedProxyRuntime.init();

    const contextPreference = new FileKubernetesContextPreference(
      path.join(userDataPath, 'kubernetes-context.json')
    );
    const initializedKubernetesRuntime = new KubernetesRuntime({
      kubeconfigDirectory: path.join(app.getPath('home'), '.kube'),
      contextPreference,
      onDiagnostic: (scope, error, context) => logRuntimeError(scope, error, context),
    });
    kubernetesRuntime = initializedKubernetesRuntime;
    await initializedKubernetesRuntime.init();

    s3SyncRuntime = new S3SyncRuntime({
      userDataPath,
      appVersion: app.getVersion(),
      credentialProtector,
      snapshotProvider: collectS3SharedAppData,
      notesIncrementalProvider: collectS3ChangedNotes,
      snapshotApplier: applyS3SharedAppData,
      onStateChanged: (state) => broadcast(IPC_CHANNELS.s3SyncState, state),
      onStartupStateChanged: (state) => broadcast(IPC_CHANNELS.startupS3SyncState, state),
    });

    applyAppIcon();
    registerIpcHandlers();
    wireForwardStatusBroadcast();
    wireUpdaterBroadcast();
    wireProxyStateBroadcast();
    wireKubernetesBroadcast();
    applyAppMenu();
    for (const host of hosts) {
      await autoStartHostRules(host);
    }
    updater.start();
    createWindow();
    scheduleProxyAutoStart(
      initializedProxyRuntime,
      (error) => logRuntimeError('proxy:auto-start', error),
      autoStartAbortController.signal
    );

    app.on('activate', () => {
      if (!primaryRendererWindow()) {
        createWindow();
      }
    });
  })
  .catch((error) => {
    logRuntimeError('app:startup', error);
    dialog.showErrorBox(
      APP_DISPLAY_NAME,
      `Failed to initialize application.\n\n${error instanceof Error ? error.message : String(error)}`
    );
    app.quit();
  });

if (ownsSingleInstanceLock) {
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    if (quitCoordinator.canQuitImmediately()) {
      return;
    }

    event.preventDefault();
    requestQuitAfterRuntimeShutdown();
  });
}
