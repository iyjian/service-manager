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
export interface KubernetesLogState {
  sessionId: string;
  podName: string;
  namespace: string;
  container: string;
  lines: string[];
  following: boolean;
  hasOlder: boolean;
}

/** Renderer-safe contract for one bounded Pod log viewer. */
export interface KubernetesLogApi {
  loadOlderLogs(id: string): Promise<KubernetesLogState>;
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

/** Safe CRD metadata used only to construct a read-only CustomObjects query. */
export interface KubernetesCustomResourceDefinition {
  group: string;
  version: string;
  kind: string;
  plural: string;
  scope: 'namespaced' | 'cluster';
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
  endpoints?: KubernetesResourceSummary[];
  endpointSlices?: KubernetesResourceSummary[];
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

export interface KubernetesPortForwardInput {
  targetKind: 'pod' | 'service';
  namespace: string;
  targetName: string;
  remotePort: number;
  localPort?: number;
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
  listResources(query: KubernetesResourceQuery): Promise<KubernetesListSnapshot>;
  getResourceWindow(query: KubernetesResourceQuery, range: KubernetesResourceWindowRange): Promise<KubernetesListSnapshot>;
  loadMoreResources(query: KubernetesResourceQuery): Promise<KubernetesListSnapshot>;
  listCustomResourceDefinitions(): Promise<KubernetesCustomResourceDefinition[]>;
  getResourceDetail(query: KubernetesResourceQuery, name: string, namespace?: string): Promise<Record<string, unknown>>;
  getResourceEvents(uid: string, namespace?: string): Promise<KubernetesResourceSummary[]>;
  getRelatedResources(request: KubernetesRelatedResourceRequest): Promise<KubernetesRelatedResources>;
  openLogs(input: KubernetesPodTarget): Promise<KubernetesLogState>;
  openTerminal(input: KubernetesPodTarget): Promise<KubernetesTerminalState>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  startPortForward(input: KubernetesPortForwardInput): Promise<KubernetesPortForwardState>;
  stopPortForward(id: string): Promise<void>;
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
