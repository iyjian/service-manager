import type {
  ConfigTransferResult,
  ForwardRuleDraft,
  HostDraft,
  HostView,
  JumpHostConfig,
  ServiceDraft,
  ServiceLogsResult,
  ServiceStatus,
  TunnelStatus,
  UpdateState,
} from '../shared/types';

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const hostDialog = requireElement<HTMLDialogElement>('#host-dialog');
const hostDialogTitle = requireElement<HTMLElement>('#host-dialog-title');
const pasteHostConfigButton = requireElement<HTMLButtonElement>('#paste-host-config-btn');
const closeHostDialogButton = requireElement<HTMLButtonElement>('#close-host-dialog-btn');
const cancelHostDialogButton = requireElement<HTMLButtonElement>('#cancel-host-dialog-btn');
const form = requireElement<HTMLFormElement>('#host-form');
const hostIdInput = requireElement<HTMLInputElement>('#host-id');
const nameInput = requireElement<HTMLInputElement>('#name');
const sshHostInput = requireElement<HTMLInputElement>('#ssh-host');
const sshPortInput = requireElement<HTMLInputElement>('#ssh-port');
const usernameInput = requireElement<HTMLInputElement>('#username');
const authTypeSelect = requireElement<HTMLSelectElement>('#auth-type');
const passwordInput = requireElement<HTMLInputElement>('#password');
const privateKeyInput = requireElement<HTMLTextAreaElement>('#private-key');
const passphraseInput = requireElement<HTMLInputElement>('#passphrase');
const passwordRow = requireElement<HTMLElement>('#password-row');
const privateKeyRow = requireElement<HTMLElement>('#private-key-row');
const passphraseRow = requireElement<HTMLElement>('#passphrase-row');
const importPrivateKeyButton = requireElement<HTMLButtonElement>('#import-private-key-btn');
const useJumpHostInput = requireElement<HTMLInputElement>('#use-jump-host');
const jumpHostSection = requireElement<HTMLElement>('#jump-host-section');
const jumpHostEditorList = requireElement<HTMLDivElement>('#jump-host-editor-list');
const addJumpHostButton = requireElement<HTMLButtonElement>('#add-jump-host-btn');
const forwardEditorList = requireElement<HTMLDivElement>('#forward-editor-list');
const addForwardButton = requireElement<HTMLButtonElement>('#add-forward-btn');
const serviceEditorList = requireElement<HTMLDivElement>('#service-editor-list');
const addServiceButton = requireElement<HTMLButtonElement>('#add-service-btn');
const saveHostButton = requireElement<HTMLButtonElement>('#save-host-btn');
const resetButton = requireElement<HTMLButtonElement>('#reset-btn');
const pageMessageElement = requireElement<HTMLDivElement>('#page-message');
const pageMessageTextElement = requireElement<HTMLElement>('#page-message-text');
const pageMessageCloseButton = requireElement<HTMLButtonElement>('#page-message-close-btn');
const hostDialogMessageElement = requireElement<HTMLDivElement>('#host-dialog-message');
const hostDialogMessageTextElement = requireElement<HTMLElement>('#host-dialog-message-text');
const hostDialogMessageCloseButton = requireElement<HTMLButtonElement>('#host-dialog-message-close-btn');
const addHostButton = requireElement<HTMLButtonElement>('#qa-add-host-btn');
const importConfigButton = requireElement<HTMLButtonElement>('#qa-import-config-btn');
const exportConfigButton = requireElement<HTMLButtonElement>('#qa-export-config-btn');
const updateStatusHintElement = requireElement<HTMLParagraphElement>('#update-status-hint');
const hostTableBody = requireElement<HTMLTableSectionElement>('#host-table-body');
const statHostsElement = requireElement<HTMLElement>('#stat-hosts');
const statForwardsElement = requireElement<HTMLElement>('#stat-forwards');
const statServicesElement = requireElement<HTMLElement>('#stat-services');
const statTunnelRunningElement = requireElement<HTMLElement>('#stat-tunnel-running');
const statTunnelStoppedElement = requireElement<HTMLElement>('#stat-tunnel-stopped');
const statTunnelErrorsElement = requireElement<HTMLElement>('#stat-tunnel-errors');
const statServiceRunningElement = requireElement<HTMLElement>('#stat-service-running');
const statServiceStoppedElement = requireElement<HTMLElement>('#stat-service-stopped');
const statServiceErrorsElement = requireElement<HTMLElement>('#stat-service-errors');
const overviewHintElement = requireElement<HTMLElement>('#overview-hint');

const serviceLogDialog = requireElement<HTMLDialogElement>('#service-log-dialog');
const serviceLogTitle = requireElement<HTMLElement>('#service-log-title');
const closeServiceLogDialogButton = requireElement<HTMLButtonElement>('#close-service-log-dialog-btn');
const logAutoScrollInput = requireElement<HTMLInputElement>('#log-auto-scroll');
const serviceLogTerminal = requireElement<HTMLDivElement>('#service-log-terminal');

let hosts: HostView[] = [];
let hostDialogMode: 'create' | 'edit' = 'create';
let editingPrivateKeyPath: string | undefined;
let activeLogTarget: { hostId: string; serviceId: string } | null = null;
let logAutoRefreshTimer: number | null = null;
let statusAutoRefreshTimer: number | null = null;
let isAutoRefreshing = false;
let lastLogLoadError: string | null = null;
const collapsedHostIds = new Set<string>();

type MessageLevel = 'default' | 'success' | 'error';

interface MessageView {
  root: HTMLElement;
  text: HTMLElement;
}

const pageMessageView: MessageView = {
  root: pageMessageElement,
  text: pageMessageTextElement,
};

const hostDialogMessageView: MessageView = {
  root: hostDialogMessageElement,
  text: hostDialogMessageTextElement,
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : String(error);
}

function shouldPromoteServiceError(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return /systemd|systemctl --user|systemd-run|journalctl|loginctl|linger/i.test(message);
}

function logRendererError(scope: string, error: unknown, context?: Record<string, unknown>): void {
  const message = toErrorMessage(error);
  console.error(`[renderer:${scope}] ${message}`, context ?? {});
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
}

function reportRendererError(scope: string, error: unknown, fallbackMessage?: string): void {
  logRendererError(scope, error);
  setMessage(fallbackMessage ?? toErrorMessage(error), 'error');
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/\n/g, '&#10;');
}

function safeValue(value: string | number | undefined): string {
  return escapeAttribute(value === undefined ? '' : String(value));
}

function renderSafely(scope = 'render'): void {
  try {
    render();
  } catch (error) {
    reportRendererError(scope, error, 'Unexpected UI render error.');
  }
}

function showDialog(dialog: HTMLDialogElement, name: string): void {
  if (dialog.open) {
    return;
  }

  try {
    dialog.showModal();
  } catch (error) {
    reportRendererError(`dialog:show:${name}`, error, `Unable to open ${name} dialog.`);
  }
}

function closeDialog(dialog: HTMLDialogElement, name: string): void {
  if (!dialog.open) {
    return;
  }

  try {
    dialog.close();
  } catch (error) {
    logRendererError(`dialog:close:${name}`, error);
  }
}

function isActiveLogTarget(target: { hostId: string; serviceId: string }): boolean {
  return Boolean(
    activeLogTarget &&
      activeLogTarget.hostId === target.hostId &&
      activeLogTarget.serviceId === target.serviceId
  );
}

function shouldStopLogRefresh(message: string): boolean {
  return message === 'Host not found.' || message === 'Service not found.';
}

function renderUpdateState(state: UpdateState): void {
  updateStatusHintElement.classList.remove(
    'hidden',
    'update-status-info',
    'update-status-success',
    'update-status-error'
  );

  if (state.status === 'idle') {
    updateStatusHintElement.classList.add('hidden');
    updateStatusHintElement.textContent = '';
    return;
  }

  const fallbackMessage = (() => {
    if (state.status === 'checking') {
      return 'Checking for updates...';
    }
    if (state.status === 'available') {
      return `Update ${state.availableVersion ?? ''} is available.`;
    }
    if (state.status === 'downloading') {
      const progress = typeof state.progressPercent === 'number'
        ? ` (${Math.round(state.progressPercent)}%)`
        : '';
      return `Downloading update ${state.availableVersion ?? ''}${progress}`;
    }
    if (state.status === 'downloaded') {
      return `Update ${state.downloadedVersion ?? state.availableVersion ?? ''} downloaded. Restart to install.`;
    }
    if (state.status === 'up-to-date') {
      return `You're up to date (${state.currentVersion}).`;
    }
    if (state.status === 'unsupported') {
      return `Version ${state.currentVersion}. Auto update works in packaged builds only.`;
    }
    if (state.status === 'error') {
      return state.rawMessage ? `Update error: ${state.rawMessage}` : 'Update check failed.';
    }
    return `Version ${state.currentVersion}`;
  })();

  updateStatusHintElement.textContent = state.message ?? fallbackMessage;

  if (state.status === 'error') {
    updateStatusHintElement.classList.add('update-status-error');
    return;
  }

  if (state.status === 'up-to-date' || state.status === 'downloaded') {
    updateStatusHintElement.classList.add('update-status-success');
    return;
  }

  updateStatusHintElement.classList.add('update-status-info');
}

function renderMessage(view: MessageView, text: string, level: MessageLevel): void {
  view.root.classList.remove('hidden', 'message-default', 'message-success', 'message-error');

  if (!text) {
    view.text.textContent = '';
    view.root.classList.add('hidden');
    return;
  }

  view.root.classList.add(
    level === 'success' ? 'message-success' : level === 'error' ? 'message-error' : 'message-default'
  );
  view.text.textContent = text;
}

function setMessage(text: string, level: MessageLevel = 'default'): void {
  renderMessage(pageMessageView, text, level);
}

function setHostDialogMessage(text: string, level: MessageLevel = 'default'): void {
  renderMessage(hostDialogMessageView, text, level);
}

function clearHostDialogMessage(): void {
  renderMessage(hostDialogMessageView, '', 'default');
}

function statusClass(status: ServiceStatus | TunnelStatus): string {
  if (status === 'running') return 'status-running';
  if (status === 'error') return 'status-error';
  if (status === 'starting' || status === 'stopping') return 'status-transition';
  return 'status-stopped';
}

function canStartService(status: ServiceStatus): boolean {
  return status === 'stopped' || status === 'error';
}

function canStopService(status: ServiceStatus): boolean {
  return status === 'running' || status === 'starting';
}

function canStartForward(status: TunnelStatus): boolean {
  return status === 'stopped' || status === 'error';
}

function canStopForward(status: TunnelStatus): boolean {
  return status === 'running' || status === 'starting';
}

function toggleAuthFields(): void {
  if (authTypeSelect.value === 'password') {
    passwordRow.classList.remove('hidden');
    privateKeyRow.classList.add('hidden');
    passphraseRow.classList.add('hidden');
  } else {
    passwordRow.classList.add('hidden');
    privateKeyRow.classList.remove('hidden');
    passphraseRow.classList.remove('hidden');
  }
}

function toggleJumpSection(): void {
  if (!useJumpHostInput.checked) {
    jumpHostSection.classList.add('hidden');
    return;
  }
  jumpHostSection.classList.remove('hidden');
  if (jumpHostEditorList.children.length === 0) {
    jumpHostEditorList.appendChild(createJumpHostEditorRow());
    refreshJumpHostEditorTitles();
  }
}

function parsePort(raw: string, label: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return port;
}

function getFileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

function formatConfigSummary(hostCount: number, ruleCount: number, serviceCount: number): string {
  const hostLabel = hostCount === 1 ? 'host' : 'hosts';
  const ruleLabel = ruleCount === 1 ? 'rule' : 'rules';
  const serviceLabel = serviceCount === 1 ? 'service' : 'services';
  return `${hostCount} ${hostLabel}, ${ruleCount} ${ruleLabel}, ${serviceCount} ${serviceLabel}`;
}

function formatJumpChain(jumpHosts: JumpHostConfig[]): string {
  if (jumpHosts.length === 0) {
    return '';
  }
  return ` · via ${jumpHosts.map((jumpHost) => `${jumpHost.username}@${jumpHost.sshHost}:${jumpHost.sshPort}`).join(' -> ')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.trim() || undefined;
}

function readPort(value: unknown, fallback?: number): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function stripJsonCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function normalizeClipboardJumpHost(input: unknown): JumpHostConfig | null {
  if (!isRecord(input)) {
    return null;
  }

  const sshHost = readString(input.sshHost);
  const username = readString(input.username);
  if (!sshHost || !username) {
    return null;
  }

  return {
    sshHost,
    sshPort: readPort(input.sshPort, 22) ?? 22,
    username,
    authType: input.authType === 'password' ? 'password' : 'privateKey',
    password: readString(input.password),
    privateKey: typeof input.privateKey === 'string' ? input.privateKey : undefined,
    passphrase: readString(input.passphrase),
  };
}

function normalizeClipboardForward(input: unknown): ForwardRuleDraft | null {
  if (!isRecord(input)) {
    return null;
  }

  const localHost = readString(input.localHost);
  const remoteHost = readString(input.remoteHost);
  const localPort = readPort(input.localPort);
  const remotePort = readPort(input.remotePort);

  if (!localHost || !remoteHost || localPort === undefined || remotePort === undefined) {
    return null;
  }

  return {
    id: readString(input.id),
    name: readString(input.name),
    localHost,
    localPort,
    remoteHost,
    remotePort,
    autoStart: Boolean(input.autoStart),
  };
}

function normalizeClipboardService(input: unknown): ServiceDraft | null {
  if (!isRecord(input)) {
    return null;
  }

  const name = readString(input.name);
  const startCommand = typeof input.startCommand === 'string' ? input.startCommand : undefined;
  const port = readPort(input.port);

  if (!name || !startCommand || port === undefined) {
    return null;
  }

  return {
    id: readString(input.id),
    name,
    startCommand,
    port,
    forwardLocalPort: readPort(input.forwardLocalPort),
  };
}

interface ClipboardHostDraft extends Partial<HostDraft> {
  jumpHost?: JumpHostConfig;
}

function parseHostDraftFromClipboard(raw: string): ClipboardHostDraft {
  const text = stripJsonCodeFence(raw);
  if (!text) {
    throw new Error('Clipboard is empty.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Clipboard does not contain valid JSON.');
  }

  let source: unknown = parsed;
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) {
      throw new Error('Clipboard contains multiple hosts. Copy a single host config.');
    }
    source = parsed[0];
  } else if (isRecord(parsed) && Array.isArray(parsed.hosts)) {
    if (parsed.hosts.length !== 1) {
      throw new Error('Clipboard contains multiple hosts. Copy a single host config.');
    }
    source = parsed.hosts[0];
  }

  if (!isRecord(source)) {
    throw new Error('Clipboard does not contain a host config object.');
  }

  const jumpHosts = Array.isArray(source.jumpHosts)
    ? source.jumpHosts.map((item) => normalizeClipboardJumpHost(item)).filter((item): item is JumpHostConfig => item !== null)
    : normalizeClipboardJumpHost(source.jumpHost)
      ? [normalizeClipboardJumpHost(source.jumpHost) as JumpHostConfig]
      : [];

  return {
    id: readString(source.id),
    name: readString(source.name),
    sshHost: readString(source.sshHost),
    sshPort: readPort(source.sshPort, 22),
    username: readString(source.username),
    authType: source.authType === 'password' ? 'password' : 'privateKey',
    password: readString(source.password),
    privateKey: typeof source.privateKey === 'string' ? source.privateKey : undefined,
    passphrase: readString(source.passphrase),
    privateKeyPath: readString(source.privateKeyPath),
    jumpHosts,
    jumpHost: jumpHosts.length === 1 ? jumpHosts[0] : undefined,
    forwards: Array.isArray(source.forwards)
      ? source.forwards
          .map((item) => normalizeClipboardForward(item))
          .filter((item): item is ForwardRuleDraft => item !== null)
      : [],
    services: Array.isArray(source.services)
      ? source.services
          .map((item) => normalizeClipboardService(item))
          .filter((item): item is ServiceDraft => item !== null)
      : [],
  };
}

function applyHostDraftToForm(draft: ClipboardHostDraft): void {
  hostDialogMode = 'create';
  hostDialogTitle.textContent = 'Add Host';
  hostIdInput.value = '';
  nameInput.value = draft.name ?? '';
  sshHostInput.value = draft.sshHost ?? '';
  sshPortInput.value = String(draft.sshPort ?? 22);
  usernameInput.value = draft.username ?? '';
  authTypeSelect.value = draft.authType === 'password' ? 'password' : 'privateKey';
  passwordInput.value = draft.password ?? '';
  privateKeyInput.value = draft.privateKey ?? '';
  passphraseInput.value = draft.passphrase ?? '';
  editingPrivateKeyPath = draft.privateKeyPath;

  const jumpHosts = draft.jumpHosts ?? (draft.jumpHost ? [draft.jumpHost] : []);
  useJumpHostInput.checked = jumpHosts.length > 0;
  jumpHostEditorList.innerHTML = '';
  for (const jumpHost of jumpHosts) {
    jumpHostEditorList.appendChild(createJumpHostEditorRow(jumpHost));
  }

  forwardEditorList.innerHTML = '';
  for (const forward of draft.forwards ?? []) {
    forwardEditorList.appendChild(createForwardEditorRow(forward));
  }

  serviceEditorList.innerHTML = '';
  for (const service of draft.services ?? []) {
    serviceEditorList.appendChild(createServiceEditorRow(service));
  }

  toggleAuthFields();
  toggleJumpSection();
  refreshJumpHostEditorTitles();
}

function buildCopyableHostPayload(host: HostView): Record<string, unknown> {
  const jumpHosts = host.jumpHosts.map((jumpHost) => ({ ...jumpHost }));
  return {
    id: host.id,
    name: host.name,
    sshHost: host.sshHost,
    sshPort: host.sshPort,
    username: host.username,
    authType: host.authType,
    password: host.password,
    privateKey: host.privateKey,
    privateKeyPath: host.privateKeyPath,
    passphrase: host.passphrase,
    jumpHosts,
    jumpHost: jumpHosts.length === 1 ? jumpHosts[0] : undefined,
    forwards: host.forwards.map((forward) => ({
      id: forward.id,
      name: forward.name,
      localHost: forward.localHost,
      localPort: forward.localPort,
      remoteHost: forward.remoteHost,
      remotePort: forward.remotePort,
      autoStart: forward.autoStart,
    })),
    services: host.services.map((service) => ({
      id: service.id,
      name: service.name,
      startCommand: service.startCommand,
      port: service.port,
      forwardLocalPort: service.forwardLocalPort,
    })),
  };
}

function toForwardUrl(localHost: string, localPort: number): string {
  let host = localHost;
  if (host === '0.0.0.0') {
    host = '127.0.0.1';
  } else if (host === '::' || host === '::0') {
    host = '::1';
  }
  if (host.includes(':') && !host.startsWith('[')) {
    host = `[${host}]`;
  }
  return `http://${host}:${localPort}`;
}

type ButtonIconName =
  | 'addHost'
  | 'importConfig'
  | 'exportConfig'
  | 'pasteConfig'
  | 'key'
  | 'addHop'
  | 'addRule'
  | 'addService'
  | 'save'
  | 'reset'
  | 'cancel'
  | 'copy'
  | 'edit'
  | 'delete'
  | 'start'
  | 'stop';

function renderButtonIcon(icon: ButtonIconName): string {
  switch (icon) {
    case 'addHost':
      return `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2.5" y="3" width="7" height="4" rx="1"></rect>
          <rect x="2.5" y="9" width="7" height="4" rx="1"></rect>
          <path d="M12 5.25v5.5"></path>
          <path d="M9.25 8h5.5"></path>
        </svg>
      `;
    case 'importConfig':
      return `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8 2.5v7"></path>
          <path d="M5.5 7 8 9.5 10.5 7"></path>
          <path d="M3 11.5h10"></path>
          <path d="M4.5 11.5v1a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-1"></path>
        </svg>
      `;
    case 'exportConfig':
      return `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8 13.5v-7"></path>
          <path d="M5.5 6 8 3.5 10.5 6"></path>
          <path d="M3 11.5h10"></path>
          <path d="M4.5 11.5v1a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-1"></path>
        </svg>
      `;
    case 'pasteConfig':
      return `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="4" y="3.5" width="8" height="10" rx="1.5"></rect>
          <path d="M6 3.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v.5"></path>
          <path d="M6.5 7h3"></path>
          <path d="M6.5 9.5h3"></path>
        </svg>
      `;
    case 'key':
      return `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="5" cy="8" r="2.5"></circle>
          <path d="M7.5 8h5"></path>
          <path d="M10.5 8v1.75"></path>
          <path d="M12.5 8v1.25"></path>
        </svg>
      `;
    case 'addHop':
      return `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="4" cy="4" r="1.5"></circle>
          <circle cx="4" cy="12" r="1.5"></circle>
          <circle cx="10" cy="8" r="1.5"></circle>
          <path d="M5.5 4h1A2.5 2.5 0 0 1 9 6.5V8"></path>
          <path d="M5.5 12h1A2.5 2.5 0 0 0 9 9.5V8"></path>
          <path d="M13 3.75v4.5"></path>
          <path d="M10.75 6h4.5"></path>
        </svg>
      `;
    case 'addRule':
      return `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="4" cy="5" r="1.5"></circle>
          <circle cx="9" cy="10" r="1.5"></circle>
          <path d="M5.5 5h1A2.5 2.5 0 0 1 9 7.5V8.5"></path>
          <path d="M7.5 10h-1A2.5 2.5 0 0 1 4 7.5V6.5"></path>
          <path d="M13 3.75v4.5"></path>
          <path d="M10.75 6h4.5"></path>
        </svg>
      `;
    case 'addService':
      return `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2.5" y="3" width="8" height="10" rx="2"></rect>
          <path d="M5 6.25 7 8 5 9.75"></path>
          <path d="M8 10h.75"></path>
          <path d="M13 3.75v4.5"></path>
          <path d="M10.75 6h4.5"></path>
        </svg>
      `;
    case 'save':
      return `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5"></path>
        </svg>
      `;
    case 'reset':
      return `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 8a5 5 0 1 0 1.5-3.56"></path>
          <path d="M3 3.5v3h3"></path>
        </svg>
      `;
    case 'cancel':
      return `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4.5 4.5 11.5 11.5"></path>
          <path d="M11.5 4.5 4.5 11.5"></path>
        </svg>
      `;
    case 'copy':
      return `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="5" y="3" width="7" height="9" rx="1.5"></rect>
          <path d="M4 5H3.5A1.5 1.5 0 0 0 2 6.5v6A1.5 1.5 0 0 0 3.5 14H8"></path>
        </svg>
      `;
    case 'edit':
      return `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 13l2.75-.5L12 6.25 9.75 4 3.5 10.25 3 13z"></path>
          <path d="M8.75 5 11 7.25"></path>
        </svg>
      `;
    case 'delete':
      return `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3.5 4.5h9"></path>
          <path d="M6 4.5V3.5A1.5 1.5 0 0 1 7.5 2h1A1.5 1.5 0 0 1 10 3.5v1"></path>
          <path d="M5 6.5V12a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V6.5"></path>
          <path d="M6.75 7.25v4"></path>
          <path d="M9.25 7.25v4"></path>
        </svg>
      `;
    case 'start':
      return `
        <svg viewBox="0 0 16 16" fill="currentColor" stroke="none" aria-hidden="true">
          <path d="M5 3.75v8.5l6.5-4.25L5 3.75z"></path>
        </svg>
      `;
    case 'stop':
      return `
        <svg viewBox="0 0 16 16" fill="currentColor" stroke="none" aria-hidden="true">
          <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.25"></rect>
        </svg>
      `;
  }
}

function renderButtonContent(icon: ButtonIconName, label: string): string {
  return `<span class="btn-icon">${renderButtonIcon(icon)}</span><span class="btn-label">${escapeHtml(label)}</span>`;
}

function applyStaticButtonIcons(): void {
  addHostButton.innerHTML = renderButtonContent('addHost', 'Add Host');
  importConfigButton.innerHTML = renderButtonContent('importConfig', 'Import Config');
  exportConfigButton.innerHTML = renderButtonContent('exportConfig', 'Export Config');
  pasteHostConfigButton.innerHTML = renderButtonContent('pasteConfig', 'Paste Config');
  importPrivateKeyButton.innerHTML = renderButtonContent('key', 'Import');
  addJumpHostButton.innerHTML = renderButtonContent('addHop', 'Add Hop');
  addForwardButton.innerHTML = renderButtonContent('addRule', 'Add Rule');
  addServiceButton.innerHTML = renderButtonContent('addService', 'Add Service');
  saveHostButton.innerHTML = renderButtonContent('save', 'Save Host');
  resetButton.innerHTML = renderButtonContent('reset', 'Reset');
  cancelHostDialogButton.innerHTML = renderButtonContent('cancel', 'Cancel');
}

function renderSectionLabel(kind: 'tunnel' | 'service', text: string): string {
  const iconMarkup = kind === 'tunnel'
    ? `
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="4" cy="5" r="1.5"></circle>
        <circle cx="12" cy="11" r="1.5"></circle>
        <path d="M5.5 5h2a2.5 2.5 0 0 1 2.5 2.5V8"></path>
        <path d="M10.5 11h-2A2.5 2.5 0 0 1 6 8.5V8"></path>
      </svg>
    `
    : `
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2.5" y="3" width="11" height="10" rx="2"></rect>
        <path d="M5 6.25 7 8 5 9.75"></path>
        <path d="M8.75 9.75H11"></path>
      </svg>
    `;
  return `
    <span class="host-section-label host-section-label-${kind}">
      <span class="host-section-icon">${iconMarkup}</span>
      <span>${escapeHtml(text)}</span>
    </span>
  `;
}

async function importPrivateKeyIntoField(
  field: HTMLTextAreaElement,
  successMessage: (path: string) => string,
  onImported?: (path: string) => void
): Promise<void> {
  const imported = await window.serviceApi.importPrivateKey();
  if (!imported) {
    return;
  }
  field.value = imported.content;
  onImported?.(imported.path);
  setHostDialogMessage(successMessage(imported.path), 'success');
}

function toggleJumpHostEditorAuthFields(row: HTMLElement): void {
  const authType = row.querySelector<HTMLSelectElement>('[data-field="authType"]')?.value ?? 'privateKey';
  const passwordRow = row.querySelector<HTMLElement>('.jump-password-row');
  const privateKeyRow = row.querySelector<HTMLElement>('.jump-private-key-row');
  const passphraseRow = row.querySelector<HTMLElement>('.jump-passphrase-row');

  if (authType === 'password') {
    passwordRow?.classList.remove('hidden');
    privateKeyRow?.classList.add('hidden');
    passphraseRow?.classList.add('hidden');
    return;
  }

  passwordRow?.classList.add('hidden');
  privateKeyRow?.classList.remove('hidden');
  passphraseRow?.classList.remove('hidden');
}

function refreshJumpHostEditorTitles(): void {
  Array.from(jumpHostEditorList.querySelectorAll<HTMLElement>('.jump-host-editor-row')).forEach((row, index) => {
    const title = row.querySelector<HTMLElement>('.jump-host-editor-title');
    if (title) {
      title.textContent = `Hop ${index + 1}`;
    }
  });
}

function createJumpHostEditorRow(draft?: JumpHostConfig): HTMLElement {
  const row = document.createElement('div');
  row.className = 'forward-row jump-host-editor-row';
  row.innerHTML = `
    <div class="jump-host-editor-head">
      <div class="jump-host-editor-title">Jump Server</div>
      <button type="button" class="btn btn-danger btn-sm jump-host-remove">${renderButtonContent('delete', 'Remove')}</button>
    </div>
    <div class="form-row">
      <label class="field field-host field-xs">
        SSH Host
        <input class="input" data-field="sshHost" value="${safeValue(draft?.sshHost)}" />
      </label>
      <label class="field field-port field-xs">
        SSH Port
        <input class="input" data-field="sshPort" type="number" min="1" max="65535" value="${safeValue(draft?.sshPort ?? 22)}" />
      </label>
      <label class="field field-user field-xs">
        Username
        <input class="input" data-field="username" value="${safeValue(draft?.username)}" />
      </label>
    </div>
    <div class="form-row">
      <label class="field field-auth field-xs">
        Auth Type
        <select class="input" data-field="authType">
          <option value="privateKey" ${draft?.authType !== 'password' ? 'selected' : ''}>Private Key</option>
          <option value="password" ${draft?.authType === 'password' ? 'selected' : ''}>Password</option>
        </select>
      </label>
      <label class="field field-password field-xs jump-password-row hidden">
        Password
        <input class="input" data-field="password" type="password" value="${safeValue(draft?.password)}" />
      </label>
      <div class="private-key-wrap jump-private-key-row">
        <label class="field field-privatekey field-xs">
          Private Key
          <textarea class="input" data-field="privateKey" rows="1">${escapeHtml(draft?.privateKey ?? '')}</textarea>
        </label>
        <button type="button" class="btn btn-secondary btn-sm btn-nowrap jump-import-private-key">${renderButtonContent('key', 'Import')}</button>
      </div>
      <label class="field field-passphrase field-xs jump-passphrase-row hidden">
        Passphrase (Optional)
        <input class="input" data-field="passphrase" type="password" value="${safeValue(draft?.passphrase)}" />
      </label>
    </div>
  `;

  row.querySelector<HTMLButtonElement>('.jump-host-remove')?.addEventListener('click', () => {
    row.remove();
    refreshJumpHostEditorTitles();
    if (jumpHostEditorList.children.length === 0) {
      useJumpHostInput.checked = false;
      toggleJumpSection();
    }
  });

  row.querySelector<HTMLSelectElement>('[data-field="authType"]')?.addEventListener('change', () => {
    toggleJumpHostEditorAuthFields(row);
  });

  row.querySelector<HTMLButtonElement>('.jump-import-private-key')?.addEventListener('click', async () => {
    try {
      const field = row.querySelector<HTMLTextAreaElement>('[data-field="privateKey"]');
      if (!field) {
        throw new Error('Jump private key field not found.');
      }
      await importPrivateKeyIntoField(field, (path) => `Imported jump private key from ${path}`);
    } catch (error) {
      setHostDialogMessage((error as Error).message, 'error');
    }
  });

  toggleJumpHostEditorAuthFields(row);
  return row;
}

function createForwardEditorRow(draft?: ForwardRuleDraft): HTMLElement {
  const row = document.createElement('div');
  row.className = 'forward-row forward-editor-row';
  row.innerHTML = `
    <input type="hidden" data-field="id" value="${safeValue(draft?.id)}" />
    <label class="field field-xs forward-name">
      Name
      <input class="input" data-field="name" value="${safeValue(draft?.name)}" placeholder="web / db / redis" />
    </label>
    <label class="field field-xs forward-local-host">
      Local Host
      <input class="input" data-field="localHost" value="${safeValue(draft?.localHost)}" />
    </label>
    <label class="field field-xs forward-local-port">
      Local Port (Optional)
      <input class="input" data-field="localPort" type="number" min="1" max="65535" value="${safeValue(draft?.localPort)}" />
    </label>
    <label class="field field-xs forward-remote-host">
      Remote Host
      <input class="input" data-field="remoteHost" value="${safeValue(draft?.remoteHost)}" />
    </label>
    <label class="field field-xs forward-remote-port">
      Remote Port (Optional)
      <input class="input" data-field="remotePort" type="number" min="1" max="65535" value="${safeValue(draft?.remotePort)}" />
    </label>
    <label class="forward-auto">
      <input class="checkbox" data-field="autoStart" type="checkbox" ${draft?.autoStart ? 'checked' : ''} />
      Auto Start
    </label>
    <button type="button" class="btn btn-danger btn-sm forward-remove">${renderButtonContent('delete', 'Delete Rule')}</button>
  `;

  row.querySelector<HTMLButtonElement>('.forward-remove')?.addEventListener('click', () => {
    row.remove();
  });

  return row;
}

function createServiceEditorRow(draft?: ServiceDraft): HTMLElement {
  const row = document.createElement('div');
  row.className = 'forward-row service-editor-row';
  row.innerHTML = `
    <input type="hidden" data-field="id" value="${safeValue(draft?.id)}" />
    <label class="field field-xs service-name-field">
      Name
      <input class="input" data-field="name" value="${safeValue(draft?.name)}" />
    </label>
    <label class="field field-xs service-port-field">
      Exposed Port (Optional)
      <input class="input" data-field="port" type="number" min="0" max="65535" value="${safeValue(draft?.port)}" />
    </label>
    <label class="field field-xs service-forward-port-field">
      Forward Local Port (Optional)
      <input class="input" data-field="forwardLocalPort" type="number" min="1" max="65535" value="${safeValue(draft?.forwardLocalPort)}" />
    </label>
    <button type="button" class="btn btn-danger btn-sm forward-remove">${renderButtonContent('delete', 'Remove')}</button>
    <label class="field field-xs service-command-field">
      Start Command
      <textarea class="input service-command-input" data-field="startCommand" rows="5" spellcheck="false" placeholder="cd /path/to/app && exec yarn start:dev">${escapeHtml(draft?.startCommand ?? '')}</textarea>
    </label>
  `;

  row.querySelector<HTMLButtonElement>('.forward-remove')?.addEventListener('click', () => {
    row.remove();
  });

  return row;
}

function collectForwardsFromEditor(): ForwardRuleDraft[] {
  const rows = Array.from(forwardEditorList.querySelectorAll<HTMLElement>('.forward-row'));
  const forwards: ForwardRuleDraft[] = [];

  rows.forEach((row, index) => {
    const get = (field: string): string =>
      row.querySelector<HTMLInputElement>(`[data-field="${field}"]`)?.value.trim() ?? '';
    const autoStart = row.querySelector<HTMLInputElement>('[data-field="autoStart"]')?.checked ?? false;

    const name = get('name');
    const localHost = get('localHost');
    const localPortRaw = get('localPort');
    const remoteHost = get('remoteHost');
    const remotePortRaw = get('remotePort');
    const isBlank = !name && !localHost && !localPortRaw && !remoteHost && !remotePortRaw && !autoStart;
    if (isBlank) {
      return;
    }
    if (!localHost) throw new Error(`Rule ${index + 1}: Local Host is required`);
    if (!localPortRaw) throw new Error(`Rule ${index + 1}: Local Port is required`);
    if (!remoteHost) throw new Error(`Rule ${index + 1}: Remote Host is required`);
    if (!remotePortRaw) throw new Error(`Rule ${index + 1}: Remote Port is required`);

    forwards.push({
      id: get('id') || undefined,
      name: name || undefined,
      localHost,
      localPort: parsePort(localPortRaw, `Rule ${index + 1} Local Port`),
      remoteHost,
      remotePort: parsePort(remotePortRaw, `Rule ${index + 1} Remote Port`),
      autoStart,
    });
  });

  return forwards;
}

function collectJumpHostsDraft(): JumpHostConfig[] {
  if (!useJumpHostInput.checked) {
    return [];
  }

  const rows = Array.from(jumpHostEditorList.querySelectorAll<HTMLElement>('.jump-host-editor-row'));
  const jumpHosts: JumpHostConfig[] = [];

  rows.forEach((row, index) => {
    const get = (field: string): string =>
      row.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-field="${field}"]`)?.value.trim() ?? '';

    const sshHost = get('sshHost');
    const sshPortRaw = get('sshPort');
    const username = get('username');
    const authType = get('authType') === 'password' ? 'password' : 'privateKey';
    const password = get('password');
    const privateKey = get('privateKey');
    const passphrase = get('passphrase');
    const isBlank = !sshHost && !username && !password && !privateKey && !passphrase;

    if (isBlank) {
      return;
    }

    if (!sshHost) throw new Error(`Jump server ${index + 1}: SSH Host is required`);
    if (!username) throw new Error(`Jump server ${index + 1}: Username is required`);

    const jumpHost: JumpHostConfig = {
      sshHost,
      sshPort: parsePort(sshPortRaw || '22', `Jump server ${index + 1} SSH Port`),
      username,
      authType,
      password: password || undefined,
      privateKey: privateKey || undefined,
      passphrase: passphrase || undefined,
    };

    if (authType === 'password' && !jumpHost.password) {
      throw new Error(`Jump server ${index + 1}: Password is required for password auth`);
    }
    if (authType === 'privateKey' && !jumpHost.privateKey?.trim()) {
      throw new Error(`Jump server ${index + 1}: Private Key is required for private key auth`);
    }

    jumpHosts.push(jumpHost);
  });

  return jumpHosts;
}

function collectServicesFromEditor(): ServiceDraft[] {
  const rows = Array.from(serviceEditorList.querySelectorAll<HTMLElement>('.service-editor-row'));
  const services: ServiceDraft[] = [];

  rows.forEach((row, index) => {
    const get = (field: string): string =>
      row.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-field="${field}"]`)?.value.trim() ?? '';

    const name = get('name');
    const startCommand = get('startCommand');
    const portRaw = get('port');
    const forwardLocalPortRaw = get('forwardLocalPort');
    const isBlank = !name && !startCommand && !portRaw && !forwardLocalPortRaw;
    if (isBlank) {
      return;
    }
    if (!name) throw new Error(`Service ${index + 1}: Name is required`);
    if (!startCommand) throw new Error(`Service ${index + 1}: Start Command is required`);
    if (!portRaw) throw new Error(`Service ${index + 1}: Exposed Port is required`);

    services.push({
      id: get('id') || undefined,
      name,
      startCommand,
      port: Number(portRaw),
      forwardLocalPort: forwardLocalPortRaw ? Number(forwardLocalPortRaw) : undefined,
    });
  });

  return services;
}

function resetForm(): void {
  form.reset();
  hostIdInput.value = '';
  editingPrivateKeyPath = undefined;
  sshPortInput.value = '22';
  useJumpHostInput.checked = false;
  jumpHostEditorList.innerHTML = '';
  forwardEditorList.innerHTML = '';
  serviceEditorList.innerHTML = '';
  clearHostDialogMessage();
  toggleAuthFields();
  toggleJumpSection();
}

function openHostDialog(mode: 'create' | 'edit', host?: HostView): void {
  hostDialogMode = mode;
  clearHostDialogMessage();
  if (mode === 'edit' && host) {
    hostDialogTitle.textContent = 'Edit Host';
    hostIdInput.value = host.id;
    nameInput.value = host.name;
    sshHostInput.value = host.sshHost;
    sshPortInput.value = String(host.sshPort);
    usernameInput.value = host.username;
    authTypeSelect.value = host.authType;
    passwordInput.value = host.password ?? '';
    privateKeyInput.value = host.privateKey ?? '';
    passphraseInput.value = host.passphrase ?? '';
    useJumpHostInput.checked = host.jumpHosts.length > 0;
    jumpHostEditorList.innerHTML = '';
    for (const jumpHost of host.jumpHosts) {
      jumpHostEditorList.appendChild(createJumpHostEditorRow(jumpHost));
    }
    refreshJumpHostEditorTitles();
    editingPrivateKeyPath = host.privateKeyPath;

    forwardEditorList.innerHTML = '';
    for (const forward of host.forwards) {
      forwardEditorList.appendChild(createForwardEditorRow(forward));
    }

    serviceEditorList.innerHTML = '';
    for (const service of host.services) {
      serviceEditorList.appendChild(
        createServiceEditorRow({
          id: service.id,
          name: service.name,
          startCommand: service.startCommand,
          port: service.port,
          forwardLocalPort: service.forwardLocalPort,
        })
      );
    }
  } else {
    hostDialogTitle.textContent = 'Add Host';
    resetForm();
  }

  toggleAuthFields();
  toggleJumpSection();
  showDialog(hostDialog, 'host');
}

function closeHostDialog(): void {
  closeDialog(hostDialog, 'host');
  clearHostDialogMessage();
}

function updateOverview(): void {
  const forwards = hosts.flatMap((host) => host.forwards);
  const services = hosts.flatMap((host) => host.services);

  statHostsElement.textContent = String(hosts.length);
  statForwardsElement.textContent = String(forwards.length);
  statServicesElement.textContent = String(services.length);
  statTunnelRunningElement.textContent = String(forwards.filter((item) => item.status === 'running').length);
  statTunnelStoppedElement.textContent = String(forwards.filter((item) => item.status === 'stopped').length);
  statTunnelErrorsElement.textContent = String(forwards.filter((item) => item.status === 'error').length);
  statServiceRunningElement.textContent = String(services.filter((item) => item.status === 'running').length);
  statServiceStoppedElement.textContent = String(services.filter((item) => item.status === 'stopped').length);
  statServiceErrorsElement.textContent = String(services.filter((item) => item.status === 'error').length);
  overviewHintElement.classList.toggle('hidden', hosts.length > 0);
}

async function loadHosts(): Promise<void> {
  hosts = await window.serviceApi.listHosts();
  renderSafely('load-hosts');
}

async function refreshAllServices(silent = false): Promise<void> {
  if (isAutoRefreshing) return;
  isAutoRefreshing = true;
  try {
    for (const host of hosts) {
      for (const service of host.services) {
        if (service.status === 'starting' || service.status === 'stopping') continue;
        try {
          await window.serviceApi.refreshService(host.id, service.id);
        } catch (error) {
          if (!silent) setMessage((error as Error).message, 'error');
        }
      }
    }
  } finally {
    isAutoRefreshing = false;
  }
}

function startStatusAutoRefresh(): void {
  if (statusAutoRefreshTimer !== null) return;
  statusAutoRefreshTimer = window.setInterval(() => {
    void refreshAllServices(true);
  }, 5000);
}

function stopStatusAutoRefresh(): void {
  if (statusAutoRefreshTimer === null) return;
  window.clearInterval(statusAutoRefreshTimer);
  statusAutoRefreshTimer = null;
}

async function loadServiceLogs(): Promise<void> {
  if (!activeLogTarget) return;
  const target = { ...activeLogTarget };

  try {
    const logs: ServiceLogsResult = await window.serviceApi.getServiceLogs(target.hostId, target.serviceId);
    if (!isActiveLogTarget(target)) {
      return;
    }

    const merged = `${logs.stdout || ''}${logs.stderr || ''}`;
    serviceLogTerminal.innerHTML = ansiToHtml(merged);
    lastLogLoadError = null;
    if (logAutoScrollInput.checked) {
      serviceLogTerminal.scrollTop = serviceLogTerminal.scrollHeight;
    }
  } catch (error) {
    const message = toErrorMessage(error);
    logRendererError('service-logs', error, target);
    if (!isActiveLogTarget(target)) {
      return;
    }

    serviceLogTerminal.textContent = `Unable to load logs.\n${message}`;
    if (lastLogLoadError !== message) {
      setMessage(`Log refresh failed: ${message}`, 'error');
      lastLogLoadError = message;
    }
    if (shouldStopLogRefresh(message)) {
      stopLogAutoRefresh();
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ansiToHtml(input: string): string {
  const tokenRegex = /\x1b\[([0-9;]*)m/g;
  let currentClasses: string[] = [];
  let lastIndex = 0;
  let html = '';

  const appendChunk = (chunk: string): void => {
    if (!chunk) return;
    const escaped = escapeHtml(chunk);
    if (currentClasses.length === 0) {
      html += escaped;
      return;
    }
    html += `<span class="${currentClasses.join(' ')}">${escaped}</span>`;
  };

  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(input)) !== null) {
    appendChunk(input.slice(lastIndex, match.index));
    lastIndex = tokenRegex.lastIndex;

    const codes = (match[1] || '0').split(';').map((v) => Number(v || '0'));
    for (const code of codes) {
      if (code === 0) {
        currentClasses = [];
        continue;
      }
      if (code === 1) {
        if (!currentClasses.includes('ansi-bold')) currentClasses.push('ansi-bold');
        continue;
      }
      if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        currentClasses = currentClasses.filter((c) => !c.startsWith('ansi-fg-'));
        currentClasses.push(`ansi-fg-${code}`);
      }
    }
  }

  appendChunk(input.slice(lastIndex));
  return html.replace(/\n/g, '<br/>');
}

function startLogAutoRefresh(): void {
  if (logAutoRefreshTimer !== null) {
    window.clearInterval(logAutoRefreshTimer);
  }
  logAutoRefreshTimer = window.setInterval(() => {
    void loadServiceLogs();
  }, 1500);
}

function stopLogAutoRefresh(): void {
  if (logAutoRefreshTimer === null) return;
  window.clearInterval(logAutoRefreshTimer);
  logAutoRefreshTimer = null;
}

function openServiceLogDialog(host: HostView, serviceId: string): void {
  const service = host.services.find((item) => item.id === serviceId);
  if (!service) return;

  activeLogTarget = { hostId: host.id, serviceId: service.id };
  lastLogLoadError = null;
  serviceLogTitle.textContent = `${host.name} / ${service.name} (PID: ${service.pid ?? '-'})`;
  serviceLogTerminal.textContent = '';

  void loadServiceLogs().catch((error) => {
    reportRendererError('service-logs:open', error, `Log refresh failed: ${toErrorMessage(error)}`);
  });
  startLogAutoRefresh();
  showDialog(serviceLogDialog, 'service log');
}

function bindHostActions(root: ParentNode, host: HostView): void {
  root.querySelector<HTMLButtonElement>('[data-action="copy-host"]')?.addEventListener('click', async () => {
    try {
      const payload = JSON.stringify(buildCopyableHostPayload(host), null, 2);
      await window.serviceApi.writeClipboardText(payload);
      setMessage(`Copied host "${host.name}" to clipboard.`, 'success');
    } catch (error) {
      setMessage(`Copy host failed: ${(error as Error).message}`, 'error');
    }
  });

  root.querySelector<HTMLButtonElement>('[data-action="edit-host"]')?.addEventListener('click', () => {
    openHostDialog('edit', host);
  });

  root.querySelector<HTMLButtonElement>('[data-action="delete-host"]')?.addEventListener('click', async () => {
    try {
      const ok = await window.serviceApi.confirmAction({
        title: 'Delete Host',
        message: `Delete host "${host.name}"?`,
        detail: 'All services and forwarding rules under this host will be deleted.',
        kind: 'warning',
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
      });
      if (!ok) {
        return;
      }
      await window.serviceApi.deleteHost(host.id);
      if (hostDialog.open && hostIdInput.value === host.id) {
        closeHostDialog();
      }
      await loadHosts();
      setMessage(`Host ${host.name} deleted`, 'success');
    } catch (error) {
      setMessage(`Delete host failed: ${(error as Error).message}`, 'error');
    }
  });
}

function formatStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function render(): void {
  updateOverview();
  hostTableBody.innerHTML = '';

  if (hosts.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td class="table-empty">No hosts configured.</td>`;
    hostTableBody.appendChild(row);
    return;
  }

  hosts.forEach((host, hostIndex) => {
    if (hostIndex > 0) {
      const spacerRow = document.createElement('tr');
      spacerRow.className = 'host-spacer-row';
      spacerRow.innerHTML = '<td colspan="6"></td>';
      hostTableBody.appendChild(spacerRow);
    }

    const isCollapsed = collapsedHostIds.has(host.id);
    const runningForwards = host.forwards.filter((item) => item.status === 'running').length;
    const runningServices = host.services.filter((item) => item.status === 'running').length;
    const groupRow = document.createElement('tr');
    groupRow.className = `group-row${isCollapsed ? ' group-row-collapsed' : ''}`;
    const hostName = escapeHtml(host.name);
    const hostDesc = escapeHtml(`${host.username}@${host.sshHost}:${host.sshPort}${formatJumpChain(host.jumpHosts)}`);
    groupRow.innerHTML = `
      <td colspan="6" class="group-cell">
        <div class="group-head">
          <div class="group-main">
            <button
              type="button"
              class="host-toggle-btn"
              data-action="toggle-host"
              aria-expanded="${isCollapsed ? 'false' : 'true'}"
              aria-label="${isCollapsed ? 'Expand host' : 'Collapse host'}"
            >
              <span class="host-toggle-icon">${isCollapsed ? '▸' : '▾'}</span>
            </button>
            <div class="group-meta">
              <div class="group-title">${hostName}</div>
              <div class="group-desc">${hostDesc}</div>
            </div>
          </div>
          <div class="group-right">
            <div class="group-metrics">
              <span class="group-metric">${host.forwards.length} tunnel${host.forwards.length === 1 ? '' : 's'} · ${runningForwards} running</span>
              <span class="group-metric">${host.services.length} service${host.services.length === 1 ? '' : 's'} · ${runningServices} running</span>
            </div>
            <div class="row-actions">
            <button class="btn btn-secondary btn-sm" data-action="copy-host">${renderButtonContent('copy', 'Copy')}</button>
            <button class="btn btn-secondary btn-sm" data-action="edit-host">${renderButtonContent('edit', 'Edit Host')}</button>
            <button class="btn btn-danger btn-sm" data-action="delete-host">${renderButtonContent('delete', 'Delete Host')}</button>
            </div>
          </div>
        </div>
      </td>
    `;
    hostTableBody.appendChild(groupRow);
    groupRow.querySelector<HTMLButtonElement>('[data-action="toggle-host"]')?.addEventListener('click', () => {
      if (isCollapsed) {
        collapsedHostIds.delete(host.id);
      } else {
        collapsedHostIds.add(host.id);
      }
      renderSafely('toggle-host');
    });

    bindHostActions(groupRow, host);

    if (isCollapsed) {
      return;
    }

    if (host.forwards.length > 0) {
      const tunnelTitle = document.createElement('tr');
      tunnelTitle.className = 'host-section-row host-section-row-tunnel';
      tunnelTitle.innerHTML = `<th colspan="5">${renderSectionLabel('tunnel', 'Tunnel List')}</th>`;
      hostTableBody.appendChild(tunnelTitle);

      const tunnelHeader = document.createElement('tr');
      tunnelHeader.className = 'host-rules-head host-rules-head-tunnel';
      tunnelHeader.innerHTML = `
        <th>Name</th>
        <th>Port</th>
        <th>Status</th>
        <th>Auto Start</th>
        <th>Actions</th>
      `;
      hostTableBody.appendChild(tunnelHeader);

      host.forwards.forEach((forward, index) => {
        const row = document.createElement('tr');
        row.className = 'data-row data-row-tunnel';
        const startDisabled = canStartForward(forward.status) ? '' : 'disabled';
        const stopDisabled = canStopForward(forward.status) ? '' : 'disabled';
        const forwardError = escapeAttribute(forward.error ?? '');
        const forwardStatus = escapeHtml(formatStatus(forward.status));
        const forwardName = escapeHtml(forward.name?.trim() || `Rule #${index + 1}`);
        const portText = (() => {
          const base = escapeHtml(`${forward.localPort} -> ${forward.remotePort}`);
          const href = escapeAttribute(toForwardUrl(forward.localHost, forward.localPort));
          if (forward.status === 'running') {
            return `<a class="forward-link" href="${href}" target="_blank" rel="noreferrer">${base}</a> <span class="forward-indicator ok" title="Forward active">✓</span>`;
          }
          if (forward.status === 'error') {
            const err = escapeAttribute(forward.error || 'Forward failed');
            return `<span>${base}</span> <span class="forward-indicator error" title="${err}">✗</span>`;
          }
          return `<span>${base}</span> <span class="forward-indicator pending" title="Forward not active">…</span>`;
        })();
        const retry = forward.status === 'error' && forward.reconnectAt && forward.reconnectAt > Date.now()
          ? `<div class="status-retry">Retry in ${Math.ceil((forward.reconnectAt - Date.now()) / 1000)}s</div>`
          : '';
        row.innerHTML = `
          <td class="table-cell">${forwardName}</td>
          <td class="table-cell">${portText}</td>
          <td class="table-cell">
            <div class="status-wrap">
              <span class="status-indicator ${statusClass(forward.status)}${forwardError ? ' status-has-tooltip' : ''}" ${forwardError ? `data-tooltip="${forwardError}"` : ''}>
                <span class="status-dot"></span>
                <span class="status-label">${forwardStatus}</span>
              </span>
              ${retry}
            </div>
          </td>
          <td class="table-cell auto-start-cell"><span class="auto-start-indicator ${forward.autoStart ? 'auto-start-enabled' : 'auto-start-disabled'}">${forward.autoStart ? '✓' : '✗'}</span></td>
          <td class="table-cell">
            <div class="row-actions">
              <button class="btn btn-primary btn-sm" data-action="start-forward" ${startDisabled}>${renderButtonContent('start', 'Start')}</button>
              <button class="btn btn-secondary btn-sm" data-action="stop-forward" ${stopDisabled}>${renderButtonContent('stop', 'Stop')}</button>
            </div>
          </td>
        `;

        row.querySelector<HTMLButtonElement>('[data-action="start-forward"]')?.addEventListener('click', async () => {
          try {
            await window.serviceApi.startForward(host.id, forward.id);
          } catch (error) {
            setMessage(`Start forward failed: ${(error as Error).message}`, 'error');
          }
        });
        row.querySelector<HTMLButtonElement>('[data-action="stop-forward"]')?.addEventListener('click', async () => {
          try {
            await window.serviceApi.stopForward(host.id, forward.id);
          } catch (error) {
            setMessage(`Stop forward failed: ${(error as Error).message}`, 'error');
          }
        });
        hostTableBody.appendChild(row);
      });
    }

    if (host.services.length > 0) {
      const serviceTitle = document.createElement('tr');
      serviceTitle.className = 'host-section-row host-section-row-service';
      serviceTitle.innerHTML = `<th colspan="5">${renderSectionLabel('service', 'Service List')}</th>`;
      hostTableBody.appendChild(serviceTitle);

      const serviceHeader = document.createElement('tr');
      serviceHeader.className = 'host-rules-head host-rules-head-service';
      serviceHeader.innerHTML = `
        <th>Name</th>
        <th>Port</th>
        <th>Status</th>
        <th>PID</th>
        <th>Actions</th>
      `;
      hostTableBody.appendChild(serviceHeader);

      for (const service of host.services) {
        const row = document.createElement('tr');
        row.className = 'data-row data-row-service';
        const pidText = service.pid ? String(service.pid) : '-';
        const safeServiceName = escapeHtml(service.name);
        const safeServiceError = escapeAttribute(service.error ?? '');
        const portText = (() => {
          if (service.port === 0 || !service.forwardLocalPort) {
            return `<span>${escapeHtml(String(service.port))}</span>`;
          }
          const base = escapeHtml(`${service.forwardLocalPort} -> ${service.port}`);
          const href = escapeAttribute(`http://127.0.0.1:${service.forwardLocalPort}`);
          if (service.forwardState === 'ok') {
            return `<a class="forward-link" href="${href}" target="_blank" rel="noreferrer">${base}</a> <span class="forward-indicator ok" title="Forward active">✓</span>`;
          }
          if (service.forwardState === 'error') {
            const err = escapeAttribute(service.forwardError || 'Forward failed');
            return `<span>${base}</span> <span class="forward-indicator error" title="${err}">✗</span>`;
          }
          return `<span>${base}</span> <span class="forward-indicator pending" title="Forward not active">…</span>`;
        })();
        const startDisabled = canStartService(service.status) ? '' : 'disabled';
        const stopDisabled = canStopService(service.status) ? '' : 'disabled';
        row.innerHTML = `
          <td class="table-cell">${safeServiceName}</td>
          <td class="table-cell">${portText}</td>
          <td class="table-cell">
            <div class="status-wrap">
              <span class="status-indicator ${statusClass(service.status)}${safeServiceError ? ' status-has-tooltip' : ''}" ${safeServiceError ? `data-tooltip="${safeServiceError}"` : ''}>
                <span class="status-dot"></span>
                <span class="status-label">${escapeHtml(service.status)}</span>
              </span>
            </div>
          </td>
          <td class="table-cell"><button class="btn btn-secondary btn-sm" data-action="pid" ${service.pid ? '' : 'disabled'}>${escapeHtml(pidText)}</button></td>
          <td class="table-cell">
            <div class="row-actions">
              <button class="btn btn-primary btn-sm" data-action="start" ${startDisabled}>${renderButtonContent('start', 'Start')}</button>
              <button class="btn btn-secondary btn-sm" data-action="stop" ${stopDisabled}>${renderButtonContent('stop', 'Stop')}</button>
            </div>
          </td>
        `;

        row.querySelector<HTMLButtonElement>('[data-action="start"]')?.addEventListener('click', async () => {
          try {
            await window.serviceApi.startService(host.id, service.id);
          } catch (error) {
            setMessage(`Start failed: ${(error as Error).message}`, 'error');
          }
        });
        row.querySelector<HTMLButtonElement>('[data-action="stop"]')?.addEventListener('click', async () => {
          try {
            await window.serviceApi.stopService(host.id, service.id);
          } catch (error) {
            setMessage(`Stop failed: ${(error as Error).message}`, 'error');
          }
        });
        row.querySelector<HTMLButtonElement>('[data-action="pid"]')?.addEventListener('click', () => {
          openServiceLogDialog(host, service.id);
        });

        hostTableBody.appendChild(row);
      }
    }

  });
}

applyStaticButtonIcons();

addHostButton.addEventListener('click', () => {
  openHostDialog('create');
});

hostTableBody.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const link = target.closest('a.forward-link') as HTMLAnchorElement | null;
  if (!link) return;
  event.preventDefault();
  const url = link.getAttribute('href');
  if (!url) return;
  void window.serviceApi.openExternal(url).catch((error) => {
    reportRendererError('open-external', error, `Open link failed: ${toErrorMessage(error)}`);
  });
});

addForwardButton.addEventListener('click', () => {
  forwardEditorList.appendChild(createForwardEditorRow());
});

addJumpHostButton.addEventListener('click', () => {
  const hadRows = jumpHostEditorList.children.length > 0;
  useJumpHostInput.checked = true;
  toggleJumpSection();
  if (hadRows) {
    jumpHostEditorList.appendChild(createJumpHostEditorRow());
    refreshJumpHostEditorTitles();
  }
});

addServiceButton.addEventListener('click', () => {
  serviceEditorList.appendChild(createServiceEditorRow());
});

importPrivateKeyButton.addEventListener('click', async () => {
  try {
    await importPrivateKeyIntoField(
      privateKeyInput,
      (path) => `Imported private key from ${path}`,
      (path) => {
        editingPrivateKeyPath = path;
      }
    );
  } catch (error) {
    setHostDialogMessage((error as Error).message, 'error');
  }
});

pasteHostConfigButton.addEventListener('click', async () => {
  try {
    const clipboardText = await window.serviceApi.readClipboardText();
    const draft = parseHostDraftFromClipboard(clipboardText);
    applyHostDraftToForm(draft);
    setHostDialogMessage('Pasted host config from clipboard. Review and save when ready.', 'success');
  } catch (error) {
    setHostDialogMessage((error as Error).message, 'error');
  }
});

pageMessageCloseButton.addEventListener('click', () => setMessage(''));
hostDialogMessageCloseButton.addEventListener('click', clearHostDialogMessage);
closeHostDialogButton.addEventListener('click', closeHostDialog);
cancelHostDialogButton.addEventListener('click', closeHostDialog);
resetButton.addEventListener('click', () => resetForm());
authTypeSelect.addEventListener('change', toggleAuthFields);
useJumpHostInput.addEventListener('change', toggleJumpSection);
closeServiceLogDialogButton.addEventListener('click', () => {
  stopLogAutoRefresh();
  closeDialog(serviceLogDialog, 'service log');
  activeLogTarget = null;
  lastLogLoadError = null;
});
serviceLogDialog.addEventListener('close', () => {
  stopLogAutoRefresh();
  activeLogTarget = null;
  lastLogLoadError = null;
});
window.addEventListener('beforeunload', () => {
  stopLogAutoRefresh();
  stopStatusAutoRefresh();
});

let floatingTooltip: HTMLDivElement | null = null;

function showFloatingTooltip(anchor: HTMLElement): void {
  const text = anchor.getAttribute('data-tooltip');
  if (!text) return;
  hideFloatingTooltip();
  const tip = document.createElement('div');
  tip.className = 'status-tooltip-floating';
  tip.textContent = text;
  document.body.appendChild(tip);
  floatingTooltip = tip;
  const rect = anchor.getBoundingClientRect();
  tip.style.left = `${rect.left}px`;
  tip.style.top = `${rect.bottom + 6}px`;
}

function hideFloatingTooltip(): void {
  if (floatingTooltip) {
    floatingTooltip.remove();
    floatingTooltip = null;
  }
}

hostTableBody.addEventListener('mouseenter', (event) => {
  const target = (event.target as HTMLElement).closest('.status-has-tooltip') as HTMLElement | null;
  if (target) showFloatingTooltip(target);
}, true);

hostTableBody.addEventListener('mouseleave', (event) => {
  const target = (event.target as HTMLElement).closest('.status-has-tooltip');
  if (target) hideFloatingTooltip();
}, true);

importConfigButton.addEventListener('click', async () => {
  try {
    const result: ConfigTransferResult | null = await window.serviceApi.importConfig();
    if (!result) return;
    await loadHosts();
    if (hostDialog.open) closeHostDialog();
    setMessage(`Imported ${formatConfigSummary(result.hostCount, result.ruleCount, result.serviceCount)} from ${getFileName(result.path)}`, 'success');
  } catch (error) {
    setMessage((error as Error).message, 'error');
  }
});

exportConfigButton.addEventListener('click', async () => {
  try {
    const result: ConfigTransferResult | null = await window.serviceApi.exportConfig();
    if (!result) return;
    setMessage(`Exported ${formatConfigSummary(result.hostCount, result.ruleCount, result.serviceCount)} to ${getFileName(result.path)}`, 'success');
  } catch (error) {
    setMessage((error as Error).message, 'error');
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    const draft: HostDraft = {
      id: hostIdInput.value.trim() || undefined,
      name: nameInput.value.trim(),
      sshHost: sshHostInput.value.trim(),
      sshPort: Number(sshPortInput.value),
      username: usernameInput.value.trim(),
      authType: authTypeSelect.value === 'password' ? 'password' : 'privateKey',
      password: passwordInput.value.trim() || undefined,
      privateKey: privateKeyInput.value || undefined,
      passphrase: passphraseInput.value.trim() || undefined,
      privateKeyPath: editingPrivateKeyPath,
      jumpHosts: collectJumpHostsDraft(),
      forwards: collectForwardsFromEditor(),
      services: collectServicesFromEditor(),
    };

    await window.serviceApi.saveHost(draft);
    await loadHosts();
    closeHostDialog();
    setMessage(hostDialogMode === 'create' ? `Host "${draft.name}" created.` : `Host "${draft.name}" updated.`, 'success');
  } catch (error) {
    setHostDialogMessage((error as Error).message, 'error');
  }
});

window.serviceApi.onServiceStatusChanged((change) => {
  try {
    const host = hosts.find((item) => item.id === change.hostId);
    if (!host) return;

    const service = host.services.find((item) => item.id === change.serviceId);
    if (!service) return;

    service.status = change.status;
    service.pid = change.pid;
    service.error = change.error;
    service.updatedAt = change.updatedAt;
    service.forwardState = change.forwardState;
    service.forwardError = change.forwardError;
    renderSafely('service-status-changed');
    const serviceError = change.error;
    if (change.status === 'error' && serviceError && shouldPromoteServiceError(serviceError)) {
      setMessage(serviceError, 'error');
    }

    if (activeLogTarget && activeLogTarget.hostId === change.hostId && activeLogTarget.serviceId === change.serviceId) {
      serviceLogTitle.textContent = `${host.name} / ${service.name} (PID: ${service.pid ?? '-'})`;
    }
  } catch (error) {
    reportRendererError('service-status-changed', error, 'Unexpected service status update error.');
  }
});

window.serviceApi.onForwardStatusChanged((change) => {
  try {
    const host = hosts.find((item) => item.id === change.hostId);
    if (!host) return;
    const forward = host.forwards.find((item) => item.id === change.forwardId);
    if (!forward) return;

    forward.status = change.status;
    forward.error = change.error;
    forward.reconnectAt = change.reconnectAt;
    renderSafely('forward-status-changed');
  } catch (error) {
    reportRendererError('forward-status-changed', error, 'Unexpected tunnel status update error.');
  }
});

window.serviceApi.onUpdateStateChanged((state) => {
  try {
    renderUpdateState(state);
  } catch (error) {
    reportRendererError('update-state-changed', error, 'Unexpected updater status error.');
  }
});

(async function init() {
  try {
    resetForm();
    await loadHosts();
    await refreshAllServices(true);
    try {
      renderUpdateState(await window.serviceApi.getUpdateState());
    } catch {
      // no-op
    }
    startStatusAutoRefresh();
  } catch (error) {
    reportRendererError('init', error, 'Failed to initialize UI.');
  }
})();

window.addEventListener('error', (event) => {
  reportRendererError('window:error', event.error ?? event.message, 'Unexpected UI error.');
});

window.addEventListener('unhandledrejection', (event) => {
  reportRendererError('window:unhandledrejection', event.reason, 'Unexpected async UI error.');
  event.preventDefault();
});
