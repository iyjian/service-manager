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
  pid?: number;
  error?: string;
  updatedAt?: string;
  forwardState?: ForwardState;
  forwardError?: string;
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

export interface ProxyExceptionDraft {
  id?: string;
  type: ProxyExceptionType;
  value: string;
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
  mode: ProxyMode;
  mixedPort: number;
  tunEnabled: boolean;
  systemProxyEnabled: boolean;
  selectedProxies?: Record<string, string>;
  selectedProxy?: string;
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
}

export interface ProxyGroupInfo {
  name: string;
  now?: string;
  options: ProxyGroupOptionInfo[];
}

export interface ProxyGroupsInfo {
  groups: ProxyGroupInfo[];
}

export interface ProxyApi {
  getState: () => Promise<ProxyState>;
  downloadCore: () => Promise<ProxyState>;
  startProxy: () => Promise<ProxyState>;
  stopProxy: () => Promise<ProxyState>;
  saveAndFetchSubscription: (url: string) => Promise<ProxyState>;
  setMode: (mode: ProxyMode) => Promise<ProxyState>;
  setMixedPort: (port: number) => Promise<ProxyState>;
  setSystemProxy: (enabled: boolean) => Promise<ProxyState>;
  setTun: (enabled: boolean) => Promise<ProxyState>;
  addException: (draft: ProxyExceptionDraft) => Promise<ProxyState>;
  updateException: (id: string, draft: ProxyExceptionDraft) => Promise<ProxyState>;
  deleteException: (id: string) => Promise<ProxyState>;
  grantTunPermission: () => Promise<ProxyState>;
  revokeTunPermission: () => Promise<ProxyState>;
  listProxies: () => Promise<ProxyGroupsInfo>;
  selectProxy: (groupName: string, optionName: string) => Promise<ProxyState>;
  getProxyLogs: () => Promise<string>;
  onProxyStateChanged: (listener: (state: ProxyState) => void) => () => void;
}

export interface ServiceApi {
  listHosts: () => Promise<HostView[]>;
  saveHost: (host: HostDraft) => Promise<HostView>;
  deleteHost: (id: string) => Promise<void>;
  deleteService: (hostId: string, serviceId: string) => Promise<void>;
  deleteForward: (hostId: string, forwardId: string) => Promise<void>;
  startService: (hostId: string, serviceId: string) => Promise<void>;
  stopService: (hostId: string, serviceId: string) => Promise<void>;
  startForward: (hostId: string, forwardId: string) => Promise<void>;
  stopForward: (hostId: string, forwardId: string) => Promise<void>;
  refreshService: (hostId: string, serviceId: string) => Promise<void>;
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
