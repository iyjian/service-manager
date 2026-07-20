export type AuthType = 'password' | 'privateKey';

export type ServiceStatus = 'running' | 'stopped' | 'starting' | 'stopping' | 'unknown' | 'error';
export type ForwardState = 'none' | 'ok' | 'error';
export type TunnelStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface ForwardRule {
  id: string;
  name?: string;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  autoStart: boolean;
}

export interface ForwardRuleDraft {
  id?: string;
  name?: string;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  autoStart: boolean;
}

export interface JumpHostConfig {
  sshHost: string;
  sshPort: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface ServiceConfig {
  id: string;
  name: string;
  startCommand: string;
  port: number;
  forwardLocalPort?: number;
  pid?: number;
}

export interface HostConfig {
  id: string;
  name: string;
  sshHost: string;
  sshPort: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  privateKeyPath?: string;
  jumpHosts: JumpHostConfig[];
  forwards: ForwardRule[];
  services: ServiceConfig[];
}

export interface ServiceRuntime extends ServiceConfig {
  status: ServiceStatus;
  error?: string;
  updatedAt?: string;
  forwardState?: ForwardState;
  forwardError?: string;
}

export interface ForwardRuleRuntime extends ForwardRule {
  status: TunnelStatus;
  error?: string;
  reconnectAt?: number;
}

export interface HostView extends Omit<HostConfig, 'services'> {
  forwards: ForwardRuleRuntime[];
  services: ServiceRuntime[];
}

export interface ServiceDraft {
  id?: string;
  name: string;
  startCommand: string;
  port: number;
  forwardLocalPort?: number;
}

export interface HostDraft {
  id?: string;
  name: string;
  sshHost: string;
  sshPort: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  privateKeyPath?: string;
  jumpHost?: JumpHostConfig;
  jumpHosts?: JumpHostConfig[];
  forwards: ForwardRuleDraft[];
  services: ServiceDraft[];
}

export interface PrivateKeyImportResult {
  path: string;
  content: string;
}

export interface ConfigTransferResult {
  path: string;
  hostCount: number;
  ruleCount: number;
  serviceCount: number;
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'unsupported'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  downloadedVersion?: string;
  progressPercent?: number;
  trigger: 'auto' | 'manual';
  message?: string;
  rawMessage?: string;
}

export interface AppMemoryUsage {
  bytes?: number;
}

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  detail?: string;
  kind?: 'question' | 'warning';
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ServiceStatusChange {
  hostId: string;
  serviceId: string;
  status: ServiceStatus;
  silent?: boolean;
  pid?: number;
  error?: string;
  updatedAt?: string;
  forwardState?: ForwardState;
  forwardError?: string;
}

export interface ServiceRefreshOptions {
  silent?: boolean;
}

export interface TunnelStatusChange {
  hostId: string;
  forwardId: string;
  status: TunnelStatus;
  error?: string;
  reconnectAt?: number;
}

export interface ServiceLogsResult {
  stdout: string;
  stderr: string;
}

export interface ServiceLogsQuery {
  lineLimit?: number;
}

export type KubernetesResourceKind =
  | 'pods'
  | 'deployments'
  | 'statefulsets'
  | 'services'
  | 'ingresses'
  | 'configmaps'
  | 'secrets'
  | 'persistentvolumeclaims'
  | 'nodes'
  | 'namespaces'
  | 'custom-resources';

export type KubernetesConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'unsupported-auth';

export interface KubernetesContextInfo {
  /** Stable renderer-safe selection identity. It is not the source Context name. */
  name: string;
  /** Original Context name inside its source kubeconfig. */
  contextName: string;
  /** Text-only selector label, qualified by filename only when names collide. */
  displayName: string;
  clusterName: string;
  userName: string;
  supported: boolean;
  unsupportedReason?: 'exec-auth' | 'missing-auth' | 'unsupported-auth';
  tlsVerificationDisabled: boolean;
}

export interface KubernetesNamespaceScope {
  mode: 'all' | 'selected';
  namespaces: string[];
}

export interface KubernetesState {
  contexts: KubernetesContextInfo[];
  selectedContext?: string;
  connection: KubernetesConnectionState;
  error?: string;
  kubeconfigReloadAvailable: boolean;
  /** The active renderer selection; it contains names only, never credentials. */
  namespaceScope?: KubernetesNamespaceScope;
}

export interface KubernetesApiBase {
  getState(): Promise<KubernetesState>;
  selectContext(name: string): Promise<KubernetesState>;
  /** Explicit read-only reconnection for a disconnected selected Context. */
  reconnect(): Promise<KubernetesState>;
  reloadKubeconfig(): Promise<KubernetesState>;
  deactivatePage(): Promise<void>;
  onStateChanged(listener: (state: KubernetesState) => void): () => void;
}

/** Display-safe state only. Kubernetes stream transports remain in main. */
export type KubernetesLogScope = 'pod' | 'deployment';

export interface KubernetesLogState {
  sessionId: string;
  podName: string;
  namespace: string;
  container: string;
  lines: string[];
  following: boolean;
  /** RFC3339 lower bound for a paused API snapshot. Omitted for ordinary live logs. */
  startTime?: string;
  hasOlder: boolean;
  /** Current source selection. Deployment scope is resolved only in main. */
  scope: KubernetesLogScope;
  /** Presence means this viewer can switch between the current Pod and its Deployment. */
  deployment?: {
    name: string;
    podCount: number;
  };
  /** Monotonic per-session update version for stale renderer-event fencing. */
  revision: number;
}

/** Renderer-safe contract for one bounded Pod log viewer. */
export interface KubernetesLogApi {
  setLogScope(id: string, scope: KubernetesLogScope): Promise<KubernetesLogState>;
  setLogStartTime(id: string, startTime?: string): Promise<KubernetesLogState>;
  setLogFollowing(id: string, following: boolean): Promise<KubernetesLogState>;
  clearLogs(id: string): Promise<KubernetesLogState>;
  closeLogs(id: string): Promise<void>;
}

/** Renderer-safe resource query. It is validated again in the main process. */
export interface KubernetesResourceQuery {
  context: string;
  kind: KubernetesResourceKind;
  apiVersion?: string;
  plural?: string;
  scope?: 'namespaced' | 'cluster';
  namespaceScope: KubernetesNamespaceScope;
  labelSelector?: string;
  fieldSelector?: string;
  nameFilter?: string;
  sort?: {
    column: string;
    direction: 'asc' | 'desc';
  };
}

export interface KubernetesResourceSummary {
  uid: string;
  name: string;
  namespace?: string;
  resourceVersion: string;
  createdAt?: string;
  status?: string;
  columns: Record<string, string>;
}

export type KubernetesCustomResourcePrinterColumnType =
  | 'integer'
  | 'number'
  | 'string'
  | 'boolean'
  | 'date';

/** Bounded CRD table metadata; schema, webhooks, and annotations never cross IPC. */
export interface KubernetesCustomResourcePrinterColumn {
  name: string;
  type: KubernetesCustomResourcePrinterColumnType;
  jsonPath: string;
  priority: number;
  /** Main-process-only original CRD index retained by bounded list projections. */
  sourceIndex?: number;
}

/** Safe CRD metadata used only to construct a read-only CustomObjects query. */
export interface KubernetesCustomResourceDefinition {
  group: string;
  version: string;
  kind: string;
  plural: string;
  scope: 'namespaced' | 'cluster';
  printerColumns: KubernetesCustomResourcePrinterColumn[];
}

/** A renderer request for one bounded virtual-table range. */
export interface KubernetesResourceWindowRange {
  start: number;
  end: number;
}

/**
 * Small display-safe relationships loaded only after a detail page expands
 * them. These summaries never contain raw endpoint addresses or credentials.
 */
export interface KubernetesRelatedResources {
  pods?: KubernetesResourceSummary[];
  endpoints?: KubernetesRelatedBackendSummary[];
  endpointSlices?: KubernetesRelatedBackendSummary[];
  /** Display-safe partial-read notices; raw server error text never crosses IPC. */
  warnings?: string[];
}

/** Display-safe Service backend metadata; endpoint addresses never cross IPC. */
export interface KubernetesRelatedBackendSummary {
  kind: 'Endpoints' | 'EndpointSlice';
  name: string;
  ready: number;
  notReady: number;
  ports: string[];
  portCount: number;
  targets: string[];
  targetCount: number;
}

/** A narrow, read-only detail relationship request. */
export interface KubernetesRelatedResourceRequest {
  kind: 'service' | 'deployment' | 'statefulset';
  namespace: string;
  name: string;
  selector?: string;
}

export interface KubernetesListSnapshot {
  query: KubernetesResourceQuery;
  /** Absolute loaded-only projection indexes; end is exclusive. */
  start: number;
  end: number;
  /** Total rows in the main-process loaded-only projection. */
  total: number;
  /** Always bounded to the requested virtual range, never the full list. */
  items: KubernetesResourceSummary[];
  loadedCount: number;
  continueToken?: string;
  resourceVersion: string;
  watchActive: boolean;
  permissionDenied?: boolean;
  error?: string;
}

export interface KubernetesPodTarget {
  namespace: string;
  podName: string;
  container: string;
}

export type KubernetesPodEnvironmentSource =
  | 'literal'
  | 'secretKeyRef'
  | 'secretEnvFrom'
  | 'configMapKeyRef'
  | 'configMapEnvFrom'
  | 'fieldRef'
  | 'resourceFieldRef'
  | 'unknown';

export type KubernetesPodEnvironmentUnavailable =
  | 'missing'
  | 'no-permission'
  | 'unsupported'
  | 'too-large';

/** A bounded, active-view-only declaration result; it never contains raw Secret objects. */
export interface KubernetesPodEnvironmentEntry {
  name: string;
  source: KubernetesPodEnvironmentSource;
  value?: string;
  reference?: string;
  /** Kubernetes `optional` state for Secret and ConfigMap declarations. */
  optional?: boolean;
  unavailable?: KubernetesPodEnvironmentUnavailable;
}

/** Renderer-safe, non-cached environment data for one active Pod container. */
export interface KubernetesPodEnvironment {
  entries: KubernetesPodEnvironmentEntry[];
  truncated: boolean;
  permissionDenied: boolean;
}

export interface KubernetesPortForwardInput {
  targetKind: 'pod' | 'service';
  namespace: string;
  targetName: string;
  remotePort: number;
  localPort?: number;
}

/**
 * Renderer-safe identity for opening a KubeVirt console from an active Pod
 * detail. The main process re-reads the Pod and verifies this UID before it
 * derives the owning VirtualMachineInstance.
 */
export interface KubernetesVncTarget {
  namespace: string;
  podName: string;
  podUid: string;
}

/** Display-only result after the main process launches the system VNC client. */
export interface KubernetesVncLaunchResult {
  namespace: string;
  podName: string;
  vmiName: string;
  localPort: number;
}

/** Display-safe terminal session metadata. */
export interface KubernetesTerminalState {
  id: string;
  podName: string;
  namespace: string;
  container: string;
  shell: string;
  state: 'connecting' | 'open' | 'closed' | 'error';
  error?: string;
}

/**
 * One bounded terminal-output chunk. It is delivered only while the owning
 * page-scoped terminal session remains active and is never cached.
 */
export interface KubernetesTerminalOutput {
  id: string;
  data: string;
}

export interface KubernetesPortForwardState {
  id: string;
  targetKind: 'pod' | 'service';
  targetName: string;
  namespace: string;
  remotePort: number;
  localPort: number;
  state: 'starting' | 'running' | 'stopped' | 'error';
  error?: string;
}

/**
 * The complete renderer bridge for Kubernetes. Every input is revalidated by
 * the main-process IPC handler; this contract intentionally contains no
 * kubeconfig bytes, credentials, raw API transports, or WebSocket handles.
 */
export interface KubernetesApi extends KubernetesApiBase, KubernetesLogApi {
  setNamespaceScope(scope: KubernetesNamespaceScope): Promise<KubernetesState>;
  listNamespaces(): Promise<string[]>;
  listResources(query: KubernetesResourceQuery): Promise<KubernetesListSnapshot>;
  getResourceWindow(query: KubernetesResourceQuery, range: KubernetesResourceWindowRange): Promise<KubernetesListSnapshot>;
  loadMoreResources(query: KubernetesResourceQuery): Promise<KubernetesListSnapshot>;
  listCustomResourceDefinitions(): Promise<KubernetesCustomResourceDefinition[]>;
  getResourceDetail(query: KubernetesResourceQuery, name: string, namespace?: string): Promise<Record<string, unknown>>;
  getResourceEvents(uid: string, namespace?: string): Promise<KubernetesResourceSummary[]>;
  getRelatedResources(request: KubernetesRelatedResourceRequest): Promise<KubernetesRelatedResources>;
  getPodContainerEnvironment(input: KubernetesPodTarget): Promise<KubernetesPodEnvironment>;
  openLogs(input: KubernetesPodTarget): Promise<KubernetesLogState>;
  openTerminal(input: KubernetesPodTarget): Promise<KubernetesTerminalState>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  openVnc(input: KubernetesVncTarget): Promise<KubernetesVncLaunchResult>;
  startPortForward(input: KubernetesPortForwardInput): Promise<KubernetesPortForwardState>;
  stopPortForward(id: string): Promise<void>;
  stopAllPortForwards(): Promise<void>;
  listPortForwards(): Promise<KubernetesPortForwardState[]>;
  onListChanged(listener: (snapshot: KubernetesListSnapshot) => void): () => void;
  onLogChanged(listener: (state: KubernetesLogState) => void): () => void;
  onTerminalChanged(listener: (state: KubernetesTerminalState) => void): () => void;
  onTerminalOutput(listener: (output: KubernetesTerminalOutput) => void): () => void;
  onPortForwardChanged(listener: (state: KubernetesPortForwardState) => void): () => void;
}

export type ProxyMode = 'direct' | 'rule' | 'global';
export type ProxyRunStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export type ProxyCoreStatus = 'not-installed' | 'downloading' | 'installed';
export type ProxyExceptionType =
  | 'DOMAIN'
  | 'DOMAIN-SUFFIX'
  | 'DOMAIN-KEYWORD'
  | 'IP-CIDR'
  | 'IP-CIDR6'
  | 'SRC-IP-CIDR'
  | 'GEOIP'
  | 'DST-PORT'
  | 'SRC-PORT';

export type ProxyRuleTarget = 'PROXY' | 'DIRECT';

export interface ProxyCustomRuleDraft {
  id?: string;
  type: ProxyExceptionType;
  value: string;
  target?: ProxyRuleTarget;
}

export interface ProxyCustomRule extends ProxyCustomRuleDraft {
  id: string;
  target: ProxyRuleTarget;
}

// Compatibility input for the stable addException/updateException IPC method
// names. New calls may choose either target; persisted `exceptions` is legacy
// Direct Exception input and is coerced during runtime migration.
export interface ProxyExceptionDraft {
  id?: string;
  type: ProxyExceptionType;
  value: string;
  target?: ProxyRuleTarget;
}

export interface ProxyException extends ProxyExceptionDraft {
  id: string;
}

// Note: src/shared/types must stay type-only. Both tsconfig.main (CJS) and
// tsconfig.renderer (ESM) emit dist/shared/types.js, and the renderer build
// overwrites the main one — any runtime export would break `require` in main.
// The proxy group names ('代理' / '漏网之鱼') are therefore defined on each side.

export interface ProxySettings {
  subscriptionUpdatedAt?: string;
  proxyCount?: number;
  startOnLaunch: boolean;
  mode: ProxyMode;
  mixedPort: number;
  tunEnabled: boolean;
  systemProxyEnabled: boolean;
  selectedProxies?: Record<string, string>;
  selectedProxy?: string;
  customRules?: ProxyCustomRule[];
  // Legacy migration input only. Runtime state and new saved settings remove it.
  exceptions?: ProxyException[];
}

export interface ProxyCoreInfo {
  status: ProxyCoreStatus;
  version?: string;
  downloadProgress?: number;
}

export interface ProxyTunSupport {
  available: boolean;
  isAdmin: boolean;
  corePrivileged: boolean;
  hint?: string;
}

export interface ProxyState {
  core: ProxyCoreInfo;
  running: ProxyRunStatus;
  pid?: number;
  error?: string;
  settings: ProxySettings;
  tunSupport?: ProxyTunSupport;
}

export interface ProxyGroupOptionInfo {
  name: string;
  type: string;
  delayMs?: number;
  delayStatus?: ProxyDelayStatus;
}

export interface ProxyGroupInfo {
  name: string;
  now?: string;
  options: ProxyGroupOptionInfo[];
}

export interface ProxyGroupsInfo {
  groups: ProxyGroupInfo[];
}

export interface ProxyTraffic {
  upBytesPerSecond: number;
  downBytesPerSecond: number;
}

export type ProxyDelayStatus = 'ready' | 'unavailable';

export type NoteLanguage = 'markdown' | 'richtext' | 'bash' | 'javascript' | 'typescript' | 'sql' | 'json' | 'yaml' | 'text';

export interface Note {
  id: string;
  name: string;
  content: string;
  language: NoteLanguage;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NoteDraft {
  name: string;
  content: string;
  language: NoteLanguage;
  tags: string[];
}

export interface NotesTreeNode {
  noteId: string;
  parentId: string | null;
  order: number;
}

export interface NotesTreeSnapshot {
  schemaVersion: 1;
  nodes: NotesTreeNode[];
}

export interface NotesWorkspaceSnapshot {
  notes: Note[];
  tree: NotesTreeSnapshot;
  expandedNoteIds: string[];
}

export interface NotePlacementInput {
  parentId: string | null;
  beforeNoteId?: string;
}

export interface NoteMoveInput extends NotePlacementInput {
  noteId: string;
}

export interface NoteTreeExpansionInput {
  noteId: string;
  expanded: boolean;
}

export interface NoteDeleteInput {
  id: string;
  /** Exact subtree IDs shown in the renderer confirmation. */
  expectedIds: string[];
}

export interface NoteDeletePreview {
  id: string;
  name: string;
  expectedIds: string[];
}

export type NoteDeleteResult = {
  status: 'deleted';
  deletedIds: string[];
  tree: NotesTreeSnapshot;
  expandedNoteIds: string[];
} | {
  status: 'changed';
  preview: NoteDeletePreview | null;
};

export interface NoteDraftRecoveryInput {
  originalId: string;
  draft: NoteDraft;
  /** Last Note value successfully persisted by this renderer. */
  expectedNote: Note;
}

export interface NoteDraftRecoveryResult {
  recovered: Array<{ originalId: string; noteId: string; conflict: boolean }>;
  workspace: NotesWorkspaceSnapshot;
}

export type NoteImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';
export type NoteImageAlignment = 'left' | 'center' | 'right';

export interface NoteImageReference {
  objectId: string;
  assetKey: string;
  ciphertextSha256: string;
  contentSha256: string;
  mimeType: NoteImageMimeType;
  byteLength: number;
  width: number;
  height: number;
  alt?: string;
}

/** Layout attributes belong to the encrypted Note body, not the immutable S3 asset reference. */
export interface NoteImageNodeAttributes extends NoteImageReference {
  displayWidth?: number;
  alignment?: NoteImageAlignment;
}

export interface NoteImageUploadInput {
  bytes: Uint8Array;
  mimeType?: string;
  alt?: string;
}

export type NoteImageUploadResult =
  | { status: 'uploaded'; reference: NoteImageReference }
  | { status: 'not-configured' };

export type NoteImageLoadResult =
  | { status: 'loaded'; bytes: Uint8Array; mimeType: NoteImageMimeType }
  | { status: 'not-configured' | 'missing' | 'error' };

export interface NotesApi {
  listNotes: () => Promise<Note[]>;
  getWorkspace: () => Promise<NotesWorkspaceSnapshot>;
  createNote: (placement?: NotePlacementInput) => Promise<NotesWorkspaceSnapshot>;
  updateNote: (id: string, draft: NoteDraft, expectedNote: Note) => Promise<Note>;
  moveNote: (input: NoteMoveInput) => Promise<NotesWorkspaceSnapshot>;
  setTreeExpanded: (input: NoteTreeExpansionInput) => Promise<string[]>;
  previewNoteDelete: (id: string) => Promise<NoteDeletePreview | null>;
  deleteNote: (input: NoteDeleteInput) => Promise<NoteDeleteResult>;
  recoverDrafts: (input: NoteDraftRecoveryInput[]) => Promise<NoteDraftRecoveryResult>;
  uploadImage: (input: NoteImageUploadInput) => Promise<NoteImageUploadResult>;
  loadImage: (reference: NoteImageReference) => Promise<NoteImageLoadResult>;
  onFlushRequested: (listener: () => void | Promise<void>) => () => void;
}

export interface UiPreferences {
  notesFontSize: number;
  notesEditorTheme: 'light' | 'dark';
  notesSidebarWidth: number;
}

export type UiPreferencesDraft = Pick<UiPreferences, 'notesFontSize' | 'notesEditorTheme'>;

export type TriliumImportPhase =
  | 'discovering'
  | 'fetching'
  | 'images'
  | 'converting'
  | 'applying'
  | 'complete';

export interface TriliumImportPrepareInput {
  requestId: string;
  endpoint: string;
  etapiToken: string;
  /** Used by bounded integration checks; the ordinary UI always imports the complete user tree. */
  maxNotes?: number;
}

export interface TriliumImportHtmlNote {
  noteId: string;
  html: string;
}

export type TriliumImportImagePlaceholderReason =
  | 'protected'
  | 'missing'
  | 'invalid'
  | 'unsupported'
  | 'oversized';

export type TriliumImportImageAsset =
  | {
    sourceKey: string;
    status: 'uploaded';
    reference: NoteImageReference;
  }
  | {
    sourceKey: string;
    status: 'placeholder';
    reason: TriliumImportImagePlaceholderReason;
  };

export interface TriliumImportPreparation {
  requestId: string;
  sessionId: string;
  endpoint: string;
  total: number;
  htmlNotes: TriliumImportHtmlNote[];
  imageTargetCount: number;
  placeholderCount: number;
  cloneCount: number;
}

export interface TriliumImportResolveImagesInput {
  requestId: string;
  sessionId: string;
}

export interface TriliumImportImageResolution {
  requestId: string;
  sessionId: string;
  assets: TriliumImportImageAsset[];
  placeholderCount: number;
}

export interface TriliumImportConvertedNote {
  noteId: string;
  content: string;
  embeddedImageCount: number;
  imagePlaceholderCount: number;
  usedPlainTextFallback: boolean;
}

export interface TriliumImportApplyInput {
  requestId: string;
  sessionId: string;
  convertedNotes: TriliumImportConvertedNote[];
}

export interface TriliumImportProgress {
  requestId: string;
  phase: TriliumImportPhase;
  completed: number;
  total?: number;
  message: string;
}

export interface TriliumImportResult {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  placeholderCount: number;
  cloneCount: number;
  embeddedImageCount: number;
  imagePlaceholderCount: number;
  plainTextFallbackCount: number;
}

export interface LlmSettingsView {
  endpoint: string;
  selectedModel: string;
  hasToken: boolean;
}

export interface LlmSettingsDraft {
  endpoint: string;
  selectedModel: string;
  token?: string;
  clearToken?: boolean;
}

export interface LlmModelsDraft {
  endpoint: string;
  token?: string;
  useSavedToken?: boolean;
}

export interface S3SyncSettingsView {
  endpoint: string;
  bucket: string;
  region: string;
  hasCredentials: boolean;
  hasSyncEncryptionKey: boolean;
  lastSyncedAt?: string;
  lastRevision?: string;
  syncState: S3SyncState;
}

export interface S3SyncSettingsDraft {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  syncEncryptionKey?: string;
  clearCredentials?: boolean;
}

export interface S3ConnectionTestDraft {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface S3CredentialValues {
  accessKeyId?: string;
  secretAccessKey?: string;
  syncEncryptionKey?: string;
}

export interface S3SyncResult {
  action: 'up-to-date' | 'pulled' | 'pushed' | 'conflict';
  syncedAt: string;
  revision?: string;
  byteLength?: number;
  etag?: string;
  conflictCount?: number;
}

export type S3SyncStatus =
  | 'not-configured'
  | 'syncing'
  | 'synced'
  | 'pending'
  | 'offline'
  | 'conflict'
  | 'error';

export type S3SyncProgressPhase =
  | 'checking'
  | 'reading-local'
  | 'reading-cloud'
  | 'merging'
  | 'uploading'
  | 'applying'
  | 'finishing';

export interface S3SyncState {
  status: S3SyncStatus;
  pending: boolean;
  lastSyncedAt?: string;
  lastRevision?: string;
  pendingSince?: string;
  conflictCount?: number;
  message?: string;
  phase?: S3SyncProgressPhase;
  completedItems?: number;
  totalItems?: number;
}

export interface PersistentDataReloaded {
  generation: number;
  source: 's3' | 'trilium';
}

export interface SettingsApi {
  getUiPreferences: () => Promise<UiPreferences>;
  saveUiPreferences: (draft: UiPreferencesDraft) => Promise<UiPreferences>;
  saveNotesSidebarWidth: (width: number) => Promise<UiPreferences>;
  prepareTriliumImport: (input: TriliumImportPrepareInput) => Promise<TriliumImportPreparation>;
  resolveTriliumImportImages: (input: TriliumImportResolveImagesInput) => Promise<TriliumImportImageResolution>;
  applyTriliumImport: (input: TriliumImportApplyInput) => Promise<TriliumImportResult>;
  cancelTriliumImport: (requestId: string) => Promise<void>;
  onTriliumImportProgress: (listener: (progress: TriliumImportProgress) => void) => () => void;
  getS3SyncSettings: () => Promise<S3SyncSettingsView>;
  saveS3SyncSettings: (draft: S3SyncSettingsDraft) => Promise<S3SyncSettingsView>;
  testS3Connection: (draft: S3ConnectionTestDraft) => Promise<void>;
  revealS3SyncCredentials: () => Promise<S3CredentialValues>;
  syncAllDataToS3: () => Promise<S3SyncResult>;
  onS3SyncStateChanged: (listener: (state: S3SyncState) => void) => () => void;
  onUiPreferencesChanged: (listener: (preferences: UiPreferences) => void) => () => void;
  onPersistentDataReloaded: (listener: (event: PersistentDataReloaded) => void) => () => void;
  getLlmSettings: () => Promise<LlmSettingsView>;
  saveLlmSettings: (draft: LlmSettingsDraft) => Promise<LlmSettingsView>;
  revealLlmToken: () => Promise<string>;
  listLlmModels: (draft: LlmModelsDraft) => Promise<string[]>;
}

export interface ProxyDelayResult {
  status: ProxyDelayStatus;
  delayMs?: number;
}

export interface ProxyApi {
  getState: () => Promise<ProxyState>;
  downloadCore: () => Promise<ProxyState>;
  startProxy: (mixedPort: number) => Promise<ProxyState>;
  stopProxy: () => Promise<ProxyState>;
  saveAndFetchSubscription: (url: string) => Promise<ProxyState>;
  setMode: (mode: ProxyMode) => Promise<ProxyState>;
  setSystemProxy: (enabled: boolean) => Promise<ProxyState>;
  setTun: (enabled: boolean) => Promise<ProxyState>;
  addException: (draft: ProxyExceptionDraft) => Promise<ProxyState>;
  updateException: (id: string, draft: ProxyExceptionDraft) => Promise<ProxyState>;
  deleteException: (id: string) => Promise<ProxyState>;
  grantTunPermission: () => Promise<ProxyState>;
  revokeTunPermission: () => Promise<ProxyState>;
  listProxies: () => Promise<ProxyGroupsInfo>;
  testProxyDelays: () => Promise<ProxyGroupsInfo>;
  selectProxy: (groupName: string, optionName: string) => Promise<ProxyState>;
  getProxyLogs: () => Promise<string>;
  onProxyStateChanged: (listener: (state: ProxyState) => void) => () => void;
  onProxyTrafficChanged: (listener: (traffic: ProxyTraffic | null) => void) => () => void;
}

export interface ServiceApi {
  listHosts: () => Promise<HostView[]>;
  getAppMemoryUsage: () => Promise<AppMemoryUsage>;
  saveHost: (host: HostDraft) => Promise<HostView>;
  deleteHost: (id: string) => Promise<void>;
  deleteService: (hostId: string, serviceId: string) => Promise<void>;
  deleteForward: (hostId: string, forwardId: string) => Promise<void>;
  startService: (hostId: string, serviceId: string) => Promise<void>;
  stopService: (hostId: string, serviceId: string) => Promise<void>;
  startForward: (hostId: string, forwardId: string) => Promise<void>;
  stopForward: (hostId: string, forwardId: string) => Promise<void>;
  refreshService: (hostId: string, serviceId: string, options?: ServiceRefreshOptions) => Promise<void>;
  getServiceLogs: (hostId: string, serviceId: string, query?: ServiceLogsQuery) => Promise<ServiceLogsResult>;
  importPrivateKey: () => Promise<PrivateKeyImportResult | null>;
  exportConfig: () => Promise<ConfigTransferResult | null>;
  importConfig: () => Promise<ConfigTransferResult | null>;
  getUpdateState: () => Promise<UpdateState>;
  checkForUpdates: () => Promise<UpdateState>;
  openExternal: (url: string) => Promise<void>;
  readClipboardText: () => Promise<string>;
  writeClipboardText: (text: string) => Promise<void>;
  confirmAction: (options: ConfirmDialogOptions) => Promise<boolean>;
  onServiceStatusChanged: (listener: (change: ServiceStatusChange) => void) => () => void;
  onForwardStatusChanged: (listener: (change: TunnelStatusChange) => void) => () => void;
  onUpdateStateChanged: (listener: (state: UpdateState) => void) => () => void;
}
