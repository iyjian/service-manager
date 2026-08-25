import { captureRendererException } from './utils/sentry.js';
import type {
  AppMemoryUsage,
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
import { ansiToHtml, escapeAttribute, escapeHtml } from './utils/html.js';
import { initNav, registerPage } from './pages/nav.js';
import { registerKubernetesPage } from './pages/kubernetesPage.js';
import { applyNotesPageDelta, registerNotesPage, reloadNotesPage } from './pages/notesPage.js';
import { registerProxyPage } from './pages/proxyPage.js';
import { registerSqlPage } from './pages/sqlPage.js';
import { registerSettingsDialog } from './pages/settingsDialog.js';
import { maybeShowChangelog } from './pages/changelog.js';
import { trackStartupS3SyncWork, waitForStartupS3Sync } from './utils/startupS3SyncGate.js';
import { activateTabSet, bindTabButtons } from './components/tabs.js';
import {
  canStartForward,
  canStartService,
  canStopForward,
  canStopService,
  formatStatus,
  runtimeStatusMarker,
  statusClass,
} from './models/status.js';

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
const togglePrivateKeyButton = requireElement<HTMLButtonElement>('#toggle-private-key-btn');
const privateKeyContent = requireElement<HTMLElement>('#private-key-content');
const privateKeySourceStatus = requireElement<HTMLElement>('#private-key-source-status');
const privateKeySummaryToggle = requireElement<HTMLButtonElement>('#private-key-summary-toggle');
const targetPrivateKeyDetails = requireElement<HTMLElement>('#target-private-key-details');
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
const hostEditRoute = requireElement<HTMLElement>('#host-edit-route');
const hostEditPathCount = requireElement<HTMLElement>('#host-edit-path-count');
const hostEditForwardsCount = requireElement<HTMLElement>('#host-edit-forwards-count');
const hostEditServicesCount = requireElement<HTMLElement>('#host-edit-services-count');
const hostEditTabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-host-edit-tab]'));
const hostEditPanels = Array.from(document.querySelectorAll<HTMLElement>('[data-host-edit-panel]'));
const pageMessageElement = requireElement<HTMLDivElement>('#page-message');
const pageMessageTextElement = requireElement<HTMLButtonElement>('#page-message-text');
const pageMessageCloseButton = requireElement<HTMLButtonElement>('#page-message-close-btn');
const pageVersionElement = requireElement<HTMLElement>('#page-version');
const pageStatsElement = requireElement<HTMLElement>('#page-stats');
const hostDialogMessageElement = requireElement<HTMLDivElement>('#host-dialog-message');
const hostDialogMessageTextElement = requireElement<HTMLElement>('#host-dialog-message-text');
const hostDialogMessageCloseButton = requireElement<HTMLButtonElement>('#host-dialog-message-close-btn');
const addHostButton = requireElement<HTMLButtonElement>('#qa-add-host-btn');
const importConfigButton = requireElement<HTMLButtonElement>('#qa-import-config-btn');
const exportConfigButton = requireElement<HTMLButtonElement>('#qa-export-config-btn');
const updateStatusHintElement = requireElement<HTMLParagraphElement>('#update-status-hint');
const hostTableBody = requireElement<HTMLTableSectionElement>('#host-table-body');

const serviceLogDialog = requireElement<HTMLDialogElement>('#service-log-dialog');
const serviceLogTitle = requireElement<HTMLElement>('#service-log-title');
const closeServiceLogDialogButton = requireElement<HTMLButtonElement>('#close-service-log-dialog-btn');
const logAutoScrollInput = requireElement<HTMLInputElement>('#log-auto-scroll');
const serviceLogSearchInput = requireElement<HTMLInputElement>('#service-log-search');
const serviceLogFilterInput = requireElement<HTMLInputElement>('#service-log-filter');
const serviceLogSearchStatus = requireElement<HTMLElement>('#service-log-search-status');
const serviceLogPrevButton = requireElement<HTMLButtonElement>('#service-log-prev-btn');
const serviceLogNextButton = requireElement<HTMLButtonElement>('#service-log-next-btn');
const serviceLogTerminal = requireElement<HTMLDivElement>('#service-log-terminal');
const serviceLogContent = requireElement<HTMLDivElement>('#service-log-content');

const LOG_FETCH_CHUNK_LINES = 200;
const APP_MEMORY_REFRESH_INTERVAL_MS = 5000;
const MAX_CONCURRENT_HOST_SERVICE_REFRESHES = 4;
const startupS3SyncReady = waitForStartupS3Sync();

type LogLoadReason = 'refresh' | 'older';
type HostEditSection = 'path' | 'forwards' | 'services';

const hostEditTabItems = hostEditTabButtons.flatMap((button) => {
  const id = button.dataset.hostEditTab as HostEditSection | undefined;
  const panel = hostEditPanels.find((candidate) => candidate.dataset.hostEditPanel === id);
  return id && panel ? [{ id, button, panel }] : [];
});

let hosts: HostView[] = [];
let hostDialogMode: 'create' | 'edit' = 'create';
let editingPrivateKeyPath: string | undefined;
let activeLogTarget: { hostId: string; serviceId: string } | null = null;
let logAutoRefreshTimer: number | null = null;
let statusAutoRefreshTimer: number | null = null;
let appMemoryRefreshTimer: number | null = null;
let appMemoryUsage: AppMemoryUsage | null = null;
let isAutoRefreshing = false;
let lastLogLoadError: string | null = null;
let currentLogText = '';
let pendingLogSnapshot: { text: string; reason: LogLoadReason } | null = null;
let logSearchMatchElements: HTMLElement[] = [];
let activeLogSearchMatchIndex = -1;
let logLineLimit = LOG_FETCH_CHUNK_LINES;
let logHasOlderHistory = true;
let isLoadingOlderLogs = false;
let pageMessageTimer: number | null = null;
let pageMessageAction: PageMessageAction | undefined;
let pageMessageGeneration = 0;
let isHostsPageActive = false;
const collapsedHostIds = new Set<string>();
const PAGE_TOAST_DURATION_MS = 10_000;

type RuntimeStatusDomTarget =
  | { kind: 'service'; hostId: string; itemId: string }
  | { kind: 'forward'; hostId: string; itemId: string };

const pendingRuntimeStatusDomUpdates = new Map<string, RuntimeStatusDomTarget>();
let runtimeStatusUpdateFrame: number | null = null;
let floatingTooltip: HTMLDivElement | null = null;
let floatingTooltipAnchor: HTMLElement | null = null;

type MessageLevel = 'default' | 'success' | 'error';
type PageMessageAction = 'open-note-export';

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

function reportRendererError(
  scope: string,
  error: unknown,
  fallbackMessage?: string,
  capture = true,
): void {
  logRendererError(scope, error);
  if (capture) captureRendererException(scope, error);
  setMessage(fallbackMessage ?? toErrorMessage(error), 'error');
}

function safeValue(value: string | number | undefined): string {
  return escapeAttribute(value === undefined ? '' : String(value));
}

function renderSafely(scope = 'render'): void {
  if (!isHostsPageActive) {
    return;
  }
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

function setServiceLogPageScrollLock(locked: boolean): void {
  document.documentElement.classList.toggle('service-log-open', locked);
  document.body.classList.toggle('service-log-open', locked);
}

function maybeLoadOlderServiceLogs(): void {
  if (!serviceLogDialog.open || !activeLogTarget || isLoadingOlderLogs || !logHasOlderHistory) {
    return;
  }
  if (serviceLogTerminal.scrollTop > 12) {
    return;
  }

  isLoadingOlderLogs = true;
  logLineLimit += LOG_FETCH_CHUNK_LINES;
  void loadServiceLogs({ reason: 'older', lineLimit: logLineLimit }).finally(() => {
    isLoadingOlderLogs = false;
  });
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
  pageVersionElement.textContent = `v${state.currentVersion}`;
  pageVersionElement.classList.remove('hidden');

  updateStatusHintElement.classList.remove(
    'hidden',
    'update-status-info',
    'update-status-success',
    'update-status-error'
  );

  if (
    state.status === 'idle' ||
    state.status === 'unsupported' ||
    state.status === 'up-to-date' ||
    (state.status === 'error' && state.trigger === 'manual')
  ) {
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

  if (state.status === 'downloaded') {
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

function configurePageMessageAction(action?: PageMessageAction): void {
  pageMessageAction = action;
  const actionable = action === 'open-note-export';
  pageMessageTextElement.disabled = !actionable;
  pageMessageElement.dataset.actionable = String(actionable);
  if (actionable) {
    pageMessageTextElement.title = 'Open downloaded file';
    pageMessageTextElement.setAttribute('aria-label', 'Open downloaded Note file');
  } else {
    pageMessageTextElement.removeAttribute('title');
    pageMessageTextElement.removeAttribute('aria-label');
  }
}

export function setMessage(
  text: string,
  level: MessageLevel = 'default',
  action?: PageMessageAction,
): void {
  const generation = ++pageMessageGeneration;
  if (pageMessageTimer !== null) {
    window.clearTimeout(pageMessageTimer);
    pageMessageTimer = null;
  }

  configurePageMessageAction(text ? action : undefined);
  renderMessage(pageMessageView, text, level);

  if (!text) {
    return;
  }

  pageMessageTimer = window.setTimeout(() => {
    if (pageMessageGeneration !== generation) return;
    pageMessageTimer = null;
    pageMessageGeneration += 1;
    configurePageMessageAction();
    renderMessage(pageMessageView, '', 'default');
  }, PAGE_TOAST_DURATION_MS);
}

window.addEventListener('service-manager:toast', (event) => {
  const detail = event instanceof CustomEvent ? event.detail : undefined;
  if (!detail || typeof detail !== 'object') return;
  const value = detail as { text?: unknown; level?: unknown; action?: unknown };
  if (typeof value.text !== 'string') return;
  const level: MessageLevel = value.level === 'success' || value.level === 'error' ? value.level : 'default';
  const action: PageMessageAction | undefined = value.action === 'open-note-export'
    ? 'open-note-export'
    : undefined;
  setMessage(value.text, level, action);
});

function setHostDialogMessage(text: string, level: MessageLevel = 'default'): void {
  renderMessage(hostDialogMessageView, text, level);
}

function clearHostDialogMessage(): void {
  renderMessage(hostDialogMessageView, '', 'default');
}

function setPrivateKeyExpanded(expanded: boolean): void {
  privateKeyContent.classList.toggle('hidden', !expanded);
  togglePrivateKeyButton.innerHTML = renderButtonContent('key', expanded ? 'Hide Key' : 'Paste Key');
  privateKeySummaryToggle.setAttribute('aria-expanded', String(expanded));
}

function updatePrivateKeySourceStatus(): void {
  const hasKeyContent = privateKeyInput.value.trim().length > 0;
  if (editingPrivateKeyPath) {
    const source = getFileName(editingPrivateKeyPath);
    privateKeySourceStatus.textContent = hasKeyContent ? `Imported: ${source}` : `Key file: ${source}`;
    return;
  }

  privateKeySourceStatus.textContent = hasKeyContent ? 'Pasted key content' : 'No key configured';
}

function toggleAuthFields(): void {
  if (authTypeSelect.value === 'password') {
    passwordRow.classList.remove('hidden');
    privateKeyRow.classList.add('hidden');
    passphraseRow.classList.add('hidden');
    targetPrivateKeyDetails.classList.add('hidden');
  } else {
    passwordRow.classList.add('hidden');
    privateKeyRow.classList.remove('hidden');
    passphraseRow.classList.remove('hidden');
    targetPrivateKeyDetails.classList.remove('hidden');
  }
  updatePrivateKeySourceStatus();
}

function renderHostEditRoute(hopCount: number): void {
  const arrow = `
    <svg class="host-edit-route-arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
      <path d="m6 3.5 4.5 4.5L6 12.5"></path>
    </svg>
  `;
  const hops = Array.from({ length: hopCount }, (_, index) => `
    ${arrow}
    <span class="host-edit-route-hop">Hop ${index + 1}</span>
  `).join('');
  hostEditRoute.innerHTML = `
    <span class="host-edit-route-endpoint">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="2.5" width="12" height="8" rx="1.5"></rect><path d="M5.5 13.5h5M8 10.5v3"></path></svg>
      Local
    </span>
    ${hops}
    ${arrow}
    <span class="host-edit-route-endpoint host-edit-route-target">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2.5" y="2" width="11" height="5" rx="1"></rect><rect x="2.5" y="9" width="11" height="5" rx="1"></rect><path d="M5 4.5h.01M5 11.5h.01"></path></svg>
      Target
    </span>
  `;
  const path = ['Local', ...Array.from({ length: hopCount }, (_, index) => `Hop ${index + 1}`), 'Target'];
  hostEditRoute.setAttribute('aria-label', path.join(' connects to '));
}

function updateHostEditCounts(): void {
  const hopCount = jumpHostEditorList.querySelectorAll('.jump-host-editor-row').length;
  const forwardCount = forwardEditorList.querySelectorAll('.forward-editor-row').length;
  const serviceCount = serviceEditorList.querySelectorAll('.service-editor-row').length;
  hostEditPathCount.textContent = `${hopCount} ${hopCount === 1 ? 'hop' : 'hops'}`;
  hostEditForwardsCount.textContent = String(forwardCount);
  hostEditServicesCount.textContent = String(serviceCount);
  renderHostEditRoute(hopCount);
}

function setActiveHostEditSection(section: HostEditSection, focusTab = false): void {
  activateTabSet(hostEditTabItems, section, { focus: focusTab, hiddenClass: 'hidden' });
}

function syncJumpSection(): void {
  const hasJumpHosts = jumpHostEditorList.children.length > 0;
  useJumpHostInput.checked = hasJumpHosts;
  if (!hasJumpHosts) {
    jumpHostSection.classList.add('hidden');
  } else {
    jumpHostSection.classList.remove('hidden');
    refreshJumpHostEditorTitles();
  }
  updateHostEditCounts();
}

function isNumericPortText(value: string): boolean {
  return /^\d{0,5}$/.test(value);
}

function numericReplacementValue(input: HTMLInputElement, insertedText: string): string {
  const selectionStart = input.selectionStart ?? input.value.length;
  const selectionEnd = input.selectionEnd ?? selectionStart;
  return `${input.value.slice(0, selectionStart)}${insertedText}${input.value.slice(selectionEnd)}`;
}

function bindNumericPortInput(input: HTMLInputElement): void {
  if (input.dataset.portInputBound === 'true') return;
  input.dataset.portInputBound = 'true';
  input.dataset.lastValidPort = isNumericPortText(input.value) ? input.value : '';

  input.addEventListener('focus', () => {
    if (isNumericPortText(input.value)) {
      input.dataset.lastValidPort = input.value;
    }
  });
  input.addEventListener('beforeinput', (event) => {
    if (!(event instanceof InputEvent) || event.data === null) return;
    if (!isNumericPortText(numericReplacementValue(input, event.data))) {
      event.preventDefault();
    }
  });
  input.addEventListener('paste', (event) => {
    const pastedText = event.clipboardData?.getData('text') ?? '';
    if (!isNumericPortText(numericReplacementValue(input, pastedText))) {
      event.preventDefault();
    }
  });
  input.addEventListener('input', () => {
    if (isNumericPortText(input.value)) {
      input.dataset.lastValidPort = input.value;
      return;
    }
    input.value = input.dataset.lastValidPort ?? '';
  });
}

function bindNumericPortInputs(root: ParentNode): void {
  root.querySelectorAll<HTMLInputElement>('input[data-port-input]').forEach(bindNumericPortInput);
}

function syncNumericPortBaselines(root: ParentNode): void {
  root.querySelectorAll<HTMLInputElement>('input[data-port-input]').forEach((input) => {
    input.dataset.lastValidPort = isNumericPortText(input.value) ? input.value : '';
  });
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

function hostHue(name: string): number {
  let hue = 0;
  for (const char of name) {
    hue = (hue * 31 + (char.codePointAt(0) ?? 0)) % 360;
  }
  return hue;
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
  setActiveHostEditSection('path');
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
  setPrivateKeyExpanded(Boolean(privateKeyInput.value && !editingPrivateKeyPath));
  updatePrivateKeySourceStatus();
  syncJumpSection();
  updateHostEditCounts();
  syncNumericPortBaselines(form);
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
  | 'stop'
  | 'prev'
  | 'next';

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
    case 'prev':
      return `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10 3.5 5.5 8 10 12.5"></path>
        </svg>
      `;
    case 'next':
      return `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 3.5 10.5 8 6 12.5"></path>
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
  serviceLogPrevButton.innerHTML = renderButtonContent('prev', 'Prev');
  serviceLogNextButton.innerHTML = renderButtonContent('next', 'Next');
}

function renderSectionLabel(kind: 'tunnel' | 'service', text: string): string {
  const iconMarkup = kind === 'tunnel'
    ? `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M12 2C6.5 2 2 6.5 2 12v10h20V12c0-5.5-4.5-10-10-10m3.47 5.11A5.95 5.95 0 0 0 13 6.09V4.07c1.46.18 2.79.76 3.9 1.62zm-6.94 0L7.1 5.69A7.94 7.94 0 0 1 11 4.07v2.02c-.91.15-1.75.51-2.47 1.02M5.69 7.1l1.42 1.43A5.95 5.95 0 0 0 6.09 11H4.07c.18-1.46.76-2.79 1.62-3.9M6 13v2.5H4V13zm-2 7v-2.5h2V20zm12 0H8v-8c0-2.21 1.79-4 4-4s4 1.79 4 4zm.89-11.47l1.42-1.43a7.94 7.94 0 0 1 1.62 3.9h-2.02a5.95 5.95 0 0 0-1.02-2.47M18 13h2v2.5h-2zm0 7v-2.5h2V20z"></path>
      </svg>
    `
    : `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M5.126 18.874q-.357-.357-.357-.874t.357-.874t.874-.357t.874.357t.357.874t-.357.874t-.874.357t-.874-.357m6 0q-.357-.357-.357-.874t.357-.874t.874-.357t.874.357t.357.874t-.357.874t-.874.357t-.874-.357m6 0q-.357-.357-.357-.874t.357-.874t.874-.357t.874.357t.357.874t-.357.874t-.874.357t-.874-.357m-12-6q-.357-.357-.357-.874t.357-.874t.874-.357t.874.357t.357.874t-.357.874t-.874.357t-.874-.357m6 0q-.357-.357-.357-.874t.357-.874t.874-.357t.874.357t.357.874t-.357.874t-.874.357t-.874-.357m6 0q-.357-.357-.357-.874t.357-.874t.874-.357t.874.357t.357.874t-.357.874t-.874.357t-.874-.357m-12-6Q4.769 6.517 4.769 6t.357-.874T6 4.769t.874.357t.357.874t-.357.874T6 7.231t-.874-.357m6 0q-.357-.357-.357-.874t.357-.874t.874-.357t.874.357t.357.874t-.357.874t-.874.357t-.874-.357m6 0q-.357-.357-.357-.874t.357-.874t.874-.357t.874.357t.357.874t-.357.874t-.874.357t-.874-.357"></path>
      </svg>
    `;
  return `
    <span class="host-section-label host-section-label-${kind}">
      <span class="host-section-icon">${iconMarkup}</span>
      <span>${escapeHtml(text)}</span>
    </span>
  `;
}

function renderHostToggleIcon(isCollapsed: boolean): string {
  const path = isCollapsed
    ? 'm4 3.5l5 5l-5 5zM21 20v-2H3v2zm0-7v-2h-9v2zm0-7V4h-9v2z'
    : 'M2 5h8l-4 5zM21 20v-2H3v2zm0-7v-2h-9v2zm0-7V4h-8v2z';
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="${path}"></path>
    </svg>
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

function getEditorValue(row: HTMLElement, field: string): string {
  return row.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-field="${field}"]`)?.value.trim() ?? '';
}

function updateJumpPrivateKeyStatus(row: HTMLElement): void {
  const privateKey = getEditorValue(row, 'privateKey');
  const status = row.querySelector<HTMLElement>('.jump-private-key-status');
  if (status) {
    status.textContent = privateKey ? 'Private key configured' : 'Private Key';
  }
}

function setJumpPrivateKeyExpanded(row: HTMLElement, expanded: boolean): void {
  const authType = row.querySelector<HTMLSelectElement>('[data-field="authType"]')?.value ?? 'privateKey';
  const toggle = row.querySelector<HTMLButtonElement>('.jump-private-key-row');
  const details = row.querySelector<HTMLElement>('.jump-private-key-details');
  const nextExpanded = authType !== 'password' && expanded;
  toggle?.setAttribute('aria-expanded', String(nextExpanded));
  details?.classList.toggle('hidden', !nextExpanded);
}

function toggleJumpHostEditorAuthFields(row: HTMLElement): void {
  const authType = row.querySelector<HTMLSelectElement>('[data-field="authType"]')?.value ?? 'privateKey';
  const passwordRow = row.querySelector<HTMLElement>('.jump-password-row');
  const privateKeyRow = row.querySelector<HTMLElement>('.jump-private-key-row');

  if (authType === 'password') {
    passwordRow?.classList.remove('hidden');
    privateKeyRow?.classList.add('hidden');
    setJumpPrivateKeyExpanded(row, false);
    return;
  }

  passwordRow?.classList.add('hidden');
  privateKeyRow?.classList.remove('hidden');
  const expanded = privateKeyRow?.getAttribute('aria-expanded') === 'true';
  setJumpPrivateKeyExpanded(row, expanded);
  updateJumpPrivateKeyStatus(row);
}

function refreshJumpHostEditorTitles(): void {
  Array.from(jumpHostEditorList.querySelectorAll<HTMLElement>('.jump-host-editor-row')).forEach((row, index) => {
    const title = row.querySelector<HTMLElement>('.jump-host-editor-title');
    if (title) {
      title.textContent = `Hop ${index + 1}`;
    }
    row.querySelector<HTMLElement>('.host-edit-step-number')!.textContent = String(index + 1);
    row.querySelector<HTMLButtonElement>('.jump-host-remove')?.setAttribute('aria-label', `Remove Hop ${index + 1}`);
  });
  updateHostEditCounts();
}

function createJumpHostEditorRow(draft?: JumpHostConfig): HTMLElement {
  const row = document.createElement('div');
  row.className = 'forward-row jump-host-editor-row host-edit-path-row host-edit-path-grid';
  row.setAttribute('role', 'row');
  row.innerHTML = `
    <div class="host-edit-step-cell" role="cell">
      <span class="host-edit-step-number"></span>
      <span class="jump-host-editor-title">Hop</span>
    </div>
    <label class="host-edit-cell-label" role="cell">
      <span class="sr-only">Hop SSH Host</span>
      <input class="input" data-field="sshHost" value="${safeValue(draft?.sshHost)}" aria-label="Hop SSH Host" />
    </label>
    <label class="host-edit-cell-label" role="cell">
      <span class="sr-only">Hop SSH Port</span>
      <input class="input" data-field="sshPort" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" value="${safeValue(draft?.sshPort ?? 22)}" data-port-input aria-label="Hop SSH Port" />
    </label>
    <label class="host-edit-cell-label" role="cell">
      <span class="sr-only">Hop Username</span>
      <input class="input" data-field="username" value="${safeValue(draft?.username)}" aria-label="Hop Username" />
    </label>
    <label class="host-edit-cell-label" role="cell">
      <span class="sr-only">Hop Auth Type</span>
      <select class="input" data-field="authType" aria-label="Hop Auth Type">
        <option value="privateKey" ${draft?.authType !== 'password' ? 'selected' : ''}>Private Key</option>
        <option value="password" ${draft?.authType === 'password' ? 'selected' : ''}>Password</option>
      </select>
    </label>
    <div class="host-edit-credential-cell" role="cell">
      <label class="host-edit-cell-label jump-password-row hidden">
        <span class="sr-only">Hop Password</span>
        <input class="input" data-field="password" type="password" value="${safeValue(draft?.password)}" aria-label="Hop Password" />
      </label>
      <button type="button" class="host-edit-credential-toggle jump-private-key-row" aria-expanded="false">
        <span class="jump-private-key-status">Private Key</span>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="m4 6 4 4 4-4"></path></svg>
      </button>
    </div>
    <button type="button" class="host-edit-row-remove jump-host-remove" aria-label="Remove Hop">${renderButtonIcon('delete')}</button>
    <div class="host-edit-path-details jump-private-key-details hidden" role="cell">
      <label class="field field-privatekey field-xs">
        Private Key
        <textarea class="input" data-field="privateKey" rows="2" spellcheck="false">${escapeHtml(draft?.privateKey ?? '')}</textarea>
      </label>
      <label class="field field-xs jump-passphrase-row">
        Passphrase (Optional)
        <input class="input" data-field="passphrase" type="password" value="${safeValue(draft?.passphrase)}" />
      </label>
      <div class="host-edit-key-actions">
        <button type="button" class="btn btn-secondary btn-sm btn-nowrap jump-import-private-key">${renderButtonContent('key', 'Import')}</button>
      </div>
    </div>
  `;

  row.querySelector<HTMLButtonElement>('.jump-host-remove')?.addEventListener('click', () => {
    row.remove();
    syncJumpSection();
  });

  row.querySelector<HTMLSelectElement>('[data-field="authType"]')?.addEventListener('change', () => {
    toggleJumpHostEditorAuthFields(row);
  });

  row.querySelector<HTMLButtonElement>('.jump-private-key-row')?.addEventListener('click', () => {
    const expanded = row.querySelector<HTMLButtonElement>('.jump-private-key-row')?.getAttribute('aria-expanded') === 'true';
    setJumpPrivateKeyExpanded(row, !expanded);
  });

  row.querySelector<HTMLTextAreaElement>('[data-field="privateKey"]')?.addEventListener('input', () => {
    updateJumpPrivateKeyStatus(row);
  });

  row.querySelector<HTMLButtonElement>('.jump-import-private-key')?.addEventListener('click', async () => {
    try {
      const field = row.querySelector<HTMLTextAreaElement>('[data-field="privateKey"]');
      if (!field) {
        throw new Error('Jump private key field not found.');
      }
      await importPrivateKeyIntoField(field, (path) => `Imported jump private key from ${path}`);
      updateJumpPrivateKeyStatus(row);
    } catch (error) {
      setHostDialogMessage((error as Error).message, 'error');
    }
  });

  bindNumericPortInputs(row);
  toggleJumpHostEditorAuthFields(row);
  updateJumpPrivateKeyStatus(row);
  return row;
}

function createForwardEditorRow(draft?: ForwardRuleDraft): HTMLElement {
  const row = document.createElement('div');
  row.className = 'forward-row forward-editor-row host-edit-resource-row host-edit-forward-grid';
  row.setAttribute('role', 'row');
  row.innerHTML = `
    <input type="hidden" data-field="id" value="${safeValue(draft?.id)}" />
    <label class="host-edit-cell-label" role="cell"><span class="sr-only">Rule Name</span><input class="input" data-field="name" value="${safeValue(draft?.name)}" aria-label="Rule Name" /></label>
    <label class="host-edit-cell-label" role="cell"><span class="sr-only">Local Host</span><input class="input" data-field="localHost" value="${safeValue(draft?.localHost)}" aria-label="Local Host" /></label>
    <label class="host-edit-cell-label" role="cell"><span class="sr-only">Local Port</span><input class="input" data-field="localPort" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" value="${safeValue(draft?.localPort)}" data-port-input aria-label="Local Port" /></label>
    <label class="host-edit-cell-label" role="cell"><span class="sr-only">Remote Host</span><input class="input" data-field="remoteHost" value="${safeValue(draft?.remoteHost)}" aria-label="Remote Host" /></label>
    <label class="host-edit-cell-label" role="cell"><span class="sr-only">Remote Port</span><input class="input" data-field="remotePort" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" value="${safeValue(draft?.remotePort)}" data-port-input aria-label="Remote Port" /></label>
    <label class="host-edit-auto-cell" role="cell"><input class="checkbox" data-field="autoStart" type="checkbox" ${draft?.autoStart ? 'checked' : ''} /><span class="sr-only">Auto Start</span></label>
    <button type="button" class="host-edit-row-remove forward-remove" aria-label="Remove forwarding rule">${renderButtonIcon('delete')}</button>
  `;

  row.querySelector<HTMLButtonElement>('.forward-remove')?.addEventListener('click', () => {
    row.remove();
    updateHostEditCounts();
  });

  bindNumericPortInputs(row);
  return row;
}

function createServiceEditorRow(draft?: ServiceDraft): HTMLElement {
  const row = document.createElement('div');
  row.className = 'forward-row service-editor-row host-edit-resource-row host-edit-service-grid';
  row.setAttribute('role', 'row');
  row.innerHTML = `
    <input type="hidden" data-field="id" value="${safeValue(draft?.id)}" />
    <label class="host-edit-cell-label" role="cell"><span class="sr-only">Service Name</span><input class="input" data-field="name" value="${safeValue(draft?.name)}" aria-label="Service Name" /></label>
    <label class="host-edit-cell-label" role="cell"><span class="sr-only">Exposed Port (0 = disabled)</span><input class="input" data-field="port" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" value="${safeValue(draft?.port)}" data-port-input aria-label="Exposed Port (0 = disabled)" /></label>
    <label class="host-edit-cell-label" role="cell"><span class="sr-only">Forward Local Port (Optional)</span><input class="input" data-field="forwardLocalPort" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" value="${safeValue(draft?.forwardLocalPort)}" data-port-input aria-label="Forward Local Port (Optional)" /></label>
    <label class="host-edit-cell-label" role="cell"><span class="sr-only">Start Command</span><textarea class="input service-command-input" data-field="startCommand" rows="1" spellcheck="false" aria-label="Start Command">${escapeHtml(draft?.startCommand ?? '')}</textarea></label>
    <button type="button" class="host-edit-row-remove forward-remove" aria-label="Remove service">${renderButtonIcon('delete')}</button>
  `;

  row.querySelector<HTMLButtonElement>('.forward-remove')?.addEventListener('click', () => {
    row.remove();
    updateHostEditCounts();
  });

  bindNumericPortInputs(row);
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
  jumpHostEditorList.innerHTML = '';
  forwardEditorList.innerHTML = '';
  serviceEditorList.innerHTML = '';
  setPrivateKeyExpanded(false);
  updatePrivateKeySourceStatus();
  clearHostDialogMessage();
  toggleAuthFields();
  syncJumpSection();
  updateHostEditCounts();
  syncNumericPortBaselines(form);
  setActiveHostEditSection('path');
}

function openHostDialog(mode: 'create' | 'edit', host?: HostView): void {
  hostDialogMode = mode;
  clearHostDialogMessage();
  setActiveHostEditSection('path');
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
  setPrivateKeyExpanded(false);
  updatePrivateKeySourceStatus();
  syncJumpSection();
  updateHostEditCounts();
  syncNumericPortBaselines(form);
  showDialog(hostDialog, 'host');
}

function closeHostDialog(): void {
  closeDialog(hostDialog, 'host');
  clearHostDialogMessage();
}

async function loadHosts(): Promise<void> {
  hosts = await window.serviceApi.listHosts();
  renderSafely('load-hosts');
}

async function refreshAllServices(silent = false): Promise<void> {
  if (isAutoRefreshing) return;
  isAutoRefreshing = true;
  try {
    const refreshHosts = [...hosts];
    let nextHostIndex = 0;
    const refreshNextHost = async (): Promise<void> => {
      while (nextHostIndex < refreshHosts.length) {
        const host = refreshHosts[nextHostIndex++];
        const serviceIds = host.services.map((service) => service.id);
        if (serviceIds.length === 0) continue;

        try {
          await window.serviceApi.refreshHostServices(host.id, serviceIds, { silent });
        } catch (error) {
          if (!silent) setMessage((error as Error).message, 'error');
        }
      }
    };
    const workerCount = Math.min(MAX_CONCURRENT_HOST_SERVICE_REFRESHES, refreshHosts.length);
    await Promise.all(Array.from({ length: workerCount }, () => refreshNextHost()));
  } finally {
    isAutoRefreshing = false;
  }
}

function startStatusAutoRefresh(): void {
  if (statusAutoRefreshTimer !== null) return;
  void refreshAllServices(true);
  statusAutoRefreshTimer = window.setInterval(() => {
    void refreshAllServices(true);
  }, 5000);
}

function stopStatusAutoRefresh(): void {
  if (statusAutoRefreshTimer === null) return;
  window.clearInterval(statusAutoRefreshTimer);
  statusAutoRefreshTimer = null;
}

function stripAnsiCodes(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, '');
}

function filterLogText(input: string, filterQuery: string): string {
  const query = filterQuery.trim().toLowerCase();
  if (!query) {
    return input;
  }

  return input
    .split('\n')
    .filter((line) => stripAnsiCodes(line).toLowerCase().includes(query))
    .join('\n');
}

function countLogLines(input: string): number {
  if (!input) {
    return 0;
  }

  const normalized = input.endsWith('\n') ? input.slice(0, -1) : input;
  return normalized ? normalized.split('\n').length : 0;
}

function hasActiveLogSelection(): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  return Boolean(anchorNode && focusNode && serviceLogTerminal.contains(anchorNode) && serviceLogTerminal.contains(focusNode));
}

function setLogSearchStatus(current: number, total: number): void {
  serviceLogSearchStatus.textContent = total > 0 ? `${current} / ${total}` : '0 / 0';
}

function updateLogSearchButtons(): void {
  const disabled = logSearchMatchElements.length === 0;
  serviceLogPrevButton.disabled = disabled;
  serviceLogNextButton.disabled = disabled;
}

function clearLogSearchHighlights(): void {
  for (const match of Array.from(serviceLogContent.querySelectorAll('mark.log-search-hit'))) {
    match.replaceWith(document.createTextNode(match.textContent ?? ''));
  }
  serviceLogContent.normalize();
  logSearchMatchElements = [];
  activeLogSearchMatchIndex = -1;
}

function setActiveLogSearchMatch(index: number, scrollIntoView = true): void {
  if (logSearchMatchElements.length === 0) {
    activeLogSearchMatchIndex = -1;
    setLogSearchStatus(0, 0);
    updateLogSearchButtons();
    return;
  }

  const normalizedIndex = ((index % logSearchMatchElements.length) + logSearchMatchElements.length) % logSearchMatchElements.length;
  logSearchMatchElements.forEach((element, elementIndex) => {
    element.classList.toggle('log-search-hit-active', elementIndex === normalizedIndex);
  });
  activeLogSearchMatchIndex = normalizedIndex;
  setLogSearchStatus(normalizedIndex + 1, logSearchMatchElements.length);
  updateLogSearchButtons();

  if (scrollIntoView) {
    logSearchMatchElements[normalizedIndex]?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
}

function applyLogSearchHighlights(focusActiveMatch = false): void {
  const previousIndex = activeLogSearchMatchIndex;
  clearLogSearchHighlights();

  const query = serviceLogSearchInput.value.trim();
  if (!query) {
    setLogSearchStatus(0, 0);
    updateLogSearchButtons();
    return;
  }

  const loweredQuery = query.toLowerCase();
  const walker = document.createTreeWalker(
    serviceLogContent,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.nodeValue) {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.parentElement?.closest('.terminal-log-empty')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const textNodes: Text[] = [];
  let currentNode = walker.nextNode();
  while (currentNode) {
    textNodes.push(currentNode as Text);
    currentNode = walker.nextNode();
  }

  for (const node of textNodes) {
    const original = node.nodeValue ?? '';
    const lowered = original.toLowerCase();
    let searchIndex = lowered.indexOf(loweredQuery);
    if (searchIndex === -1) {
      continue;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    while (searchIndex !== -1) {
      if (searchIndex > cursor) {
        fragment.append(document.createTextNode(original.slice(cursor, searchIndex)));
      }
      const match = document.createElement('mark');
      match.className = 'log-search-hit';
      match.textContent = original.slice(searchIndex, searchIndex + query.length);
      logSearchMatchElements.push(match);
      fragment.append(match);
      cursor = searchIndex + query.length;
      searchIndex = lowered.indexOf(loweredQuery, cursor);
    }
    if (cursor < original.length) {
      fragment.append(document.createTextNode(original.slice(cursor)));
    }

    node.parentNode?.replaceChild(fragment, node);
  }

  if (logSearchMatchElements.length === 0) {
    setLogSearchStatus(0, 0);
    updateLogSearchButtons();
    return;
  }

  const nextIndex = previousIndex >= 0 ? Math.min(previousIndex, logSearchMatchElements.length - 1) : 0;
  setActiveLogSearchMatch(nextIndex, focusActiveMatch);
}

function renderServiceLogView(
  options: {
    preserveScroll?: boolean;
    focusActiveMatch?: boolean;
    previousScrollTop?: number;
    previousScrollHeight?: number;
    anchorHistoryPrepend?: boolean;
  } = {}
): void {
  const previousScrollTop = options.previousScrollTop ?? serviceLogTerminal.scrollTop;
  const previousScrollHeight = options.previousScrollHeight ?? serviceLogTerminal.scrollHeight;
  const filterQuery = serviceLogFilterInput.value.trim();
  const visibleText = filterLogText(currentLogText, filterQuery);

  if (visibleText) {
    serviceLogContent.innerHTML = ansiToHtml(visibleText);
  } else {
    const emptyMessage = filterQuery ? 'No matching log lines.' : 'No logs yet for this invocation.';
    serviceLogContent.innerHTML = `<div class="terminal-log-empty">${escapeHtml(emptyMessage)}</div>`;
  }

  applyLogSearchHighlights(options.focusActiveMatch ?? false);

  if (options.focusActiveMatch && serviceLogSearchInput.value.trim() && logSearchMatchElements.length > 0) {
    return;
  }

  if (options.anchorHistoryPrepend) {
    const nextScrollHeight = serviceLogTerminal.scrollHeight;
    serviceLogTerminal.scrollTop = previousScrollTop + (nextScrollHeight - previousScrollHeight);
    return;
  }

  if (logAutoScrollInput.checked && !options.preserveScroll) {
    serviceLogTerminal.scrollTop = serviceLogTerminal.scrollHeight;
    return;
  }

  serviceLogTerminal.scrollTop = previousScrollTop;
}

function appendServiceLogSuffix(suffix: string): void {
  if (!suffix) {
    return;
  }

  const previousScrollTop = serviceLogTerminal.scrollTop;
  const emptyState = serviceLogContent.querySelector('.terminal-log-empty');
  if (emptyState) {
    emptyState.remove();
  }

  serviceLogContent.insertAdjacentHTML('beforeend', ansiToHtml(suffix));

  if (logAutoScrollInput.checked) {
    serviceLogTerminal.scrollTop = serviceLogTerminal.scrollHeight;
    return;
  }

  serviceLogTerminal.scrollTop = previousScrollTop;
}

function updateDisplayedServiceLog(nextText: string, reason: LogLoadReason = 'refresh'): void {
  if (hasActiveLogSelection()) {
    pendingLogSnapshot = { text: nextText, reason };
    return;
  }

  if (nextText === currentLogText) {
    pendingLogSnapshot = null;
    return;
  }

  const previousText = currentLogText;
  const previousScrollTop = serviceLogTerminal.scrollTop;
  const previousScrollHeight = serviceLogTerminal.scrollHeight;
  currentLogText = nextText;
  pendingLogSnapshot = null;

  const hasQueryOverlay = serviceLogSearchInput.value.trim() || serviceLogFilterInput.value.trim();
  if (reason === 'refresh' && !hasQueryOverlay && previousText && nextText.startsWith(previousText)) {
    appendServiceLogSuffix(nextText.slice(previousText.length));
    return;
  }

  renderServiceLogView({
    preserveScroll: reason === 'older' || !logAutoScrollInput.checked,
    previousScrollTop,
    previousScrollHeight,
    anchorHistoryPrepend: reason === 'older',
  });
}

function applyPendingLogUpdateIfPossible(): void {
  if (pendingLogSnapshot === null || hasActiveLogSelection()) {
    return;
  }

  const nextSnapshot = pendingLogSnapshot;
  pendingLogSnapshot = null;
  updateDisplayedServiceLog(nextSnapshot.text, nextSnapshot.reason);
}

function resetServiceLogState(): void {
  currentLogText = '';
  pendingLogSnapshot = null;
  lastLogLoadError = null;
  logSearchMatchElements = [];
  activeLogSearchMatchIndex = -1;
  logLineLimit = LOG_FETCH_CHUNK_LINES;
  logHasOlderHistory = true;
  isLoadingOlderLogs = false;
  serviceLogSearchInput.value = '';
  serviceLogFilterInput.value = '';
  serviceLogContent.innerHTML = '';
  setLogSearchStatus(0, 0);
  updateLogSearchButtons();
  serviceLogTerminal.scrollTop = 0;
}

async function loadServiceLogs(options: { reason?: LogLoadReason; lineLimit?: number } = {}): Promise<void> {
  if (!activeLogTarget) return;
  const target = { ...activeLogTarget };
  const reason = options.reason ?? 'refresh';
  const lineLimit = options.lineLimit ?? logLineLimit;

  try {
    const logs: ServiceLogsResult = await window.serviceApi.getServiceLogs(target.hostId, target.serviceId, { lineLimit });
    if (!isActiveLogTarget(target)) {
      return;
    }

    const merged = `${logs.stdout || ''}${logs.stderr || ''}`;
    if (reason === 'older' && merged === currentLogText) {
      logHasOlderHistory = false;
    } else {
      updateDisplayedServiceLog(merged, reason);
      logHasOlderHistory = countLogLines(merged) >= lineLimit;
    }
    lastLogLoadError = null;
  } catch (error) {
    const message = toErrorMessage(error);
    logRendererError('service-logs', error, target);
    if (!isActiveLogTarget(target)) {
      return;
    }

    clearLogSearchHighlights();
    setLogSearchStatus(0, 0);
    updateLogSearchButtons();
    serviceLogContent.innerHTML = `<div class="terminal-log-empty terminal-log-empty-error">${escapeHtml(`Unable to load logs.\n${message}`)}</div>`;
    if (lastLogLoadError !== message) {
      setMessage(`Log refresh failed: ${message}`, 'error');
      lastLogLoadError = message;
    }
    if (shouldStopLogRefresh(message)) {
      stopLogAutoRefresh();
    }
  }
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
  resetServiceLogState();
  serviceLogTitle.textContent = `${host.name} / ${service.name} (PID: ${service.pid ?? '-'})`;

  void loadServiceLogs({ lineLimit: logLineLimit }).catch((error) => {
    reportRendererError('service-logs:open', error, `Log refresh failed: ${toErrorMessage(error)}`);
  });
  startLogAutoRefresh();
  showDialog(serviceLogDialog, 'service log');
  setServiceLogPageScrollLock(true);
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

function renderPortNumber(port: number): string {
  return `<span class="runtime-port-number">${escapeHtml(String(port))}</span>`;
}

function renderPortMap(localPort: number, remotePort: number): string {
  return `
    <span class="runtime-port-map">
      <span>L:</span>${renderPortNumber(localPort)}
      <span class="runtime-port-arrow">→</span>
      <span>R:</span>${renderPortNumber(remotePort)}
    </span>
  `;
}

function renderSinglePort(port: number): string {
  return `<span class="runtime-port-single"><span>:</span>${renderPortNumber(port)}</span>`;
}

function renderPowerIcon(): string {
  return `
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 2.5v5"></path>
      <path d="M5.15 4.35a5 5 0 1 0 5.7 0"></path>
    </svg>
  `;
}

function renderRuntimeActionButton(
  action: string,
  label: string,
  disabled: boolean,
  status: ServiceStatus | TunnelStatus
): string {
  const actionKind = action.startsWith('start') ? 'start' : 'stop';
  const isBusy = status === 'starting' || status === 'stopping';
  return `
    <button
      class="runtime-action-btn runtime-action-btn-${actionKind} ${statusClass(status)}${isBusy ? ' is-busy' : ''}"
      type="button"
      data-action="${escapeAttribute(action)}"
      data-status="${escapeAttribute(status)}"
      title="${escapeAttribute(label)}"
      aria-label="${escapeAttribute(label)}"
      aria-busy="${isBusy ? 'true' : 'false'}"
      ${disabled ? 'disabled' : ''}
    >
      <span class="runtime-action-icon">${renderPowerIcon()}</span>
      ${isBusy ? '<span class="runtime-action-spinner" aria-hidden="true"></span>' : ''}
    </button>
  `;
}

function renderTunnelPort(forward: HostView['forwards'][number]): string {
  const base = renderPortMap(forward.localPort, forward.remotePort);
  const endpoint = escapeAttribute(`${forward.localHost}:${forward.localPort} -> ${forward.remoteHost}:${forward.remotePort}`);

  if (forward.status === 'running') {
    const href = escapeAttribute(toForwardUrl(forward.localHost, forward.localPort));
    return `<a class="forward-link" href="${href}" target="_blank" rel="noreferrer" title="${endpoint}">${base}</a> <span class="forward-indicator ok" title="Forward active">✓</span>`;
  }
  if (forward.status === 'error') {
    const err = escapeAttribute(forward.error || 'Forward failed');
    return `<span title="${endpoint}">${base}</span> <span class="forward-indicator error" title="${err}">✗</span>`;
  }
  return `<span title="${endpoint}">${base}</span>`;
}

function renderServicePort(service: HostView['services'][number]): string {
  if (service.port === 0) {
    return '<span class="runtime-port-muted">-</span>';
  }

  if (!service.forwardLocalPort) {
    return renderSinglePort(service.port);
  }

  const base = renderPortMap(service.forwardLocalPort, service.port);
  const href = escapeAttribute(`http://127.0.0.1:${service.forwardLocalPort}`);
  if (service.forwardState === 'ok') {
    return `<a class="forward-link" href="${href}" target="_blank" rel="noreferrer">${base}</a> <span class="forward-indicator ok" title="Forward active">✓</span>`;
  }
  if (service.forwardState === 'error') {
    const err = escapeAttribute(service.forwardError || 'Forward failed');
    return `<span>${base}</span> <span class="forward-indicator error" title="${err}">✗</span>`;
  }
  return `<span>${base}</span> <span class="forward-indicator pending" title="Forward pending">…</span>`;
}

function createForwardRuntimeRow(
  host: HostView,
  forward: HostView['forwards'][number],
  index: number,
): HTMLDivElement {
  const item = document.createElement('div');
  item.className = 'runtime-row runtime-row-tunnel';
  item.dataset.hostId = host.id;
  item.dataset.forwardId = forward.id;
  const canStop = canStopForward(forward.status);
  const action = canStop
    ? renderRuntimeActionButton('stop-forward', 'Stop', false, forward.status)
    : renderRuntimeActionButton('start-forward', 'Start', !canStartForward(forward.status), forward.status);
  const retry = forward.status === 'error' && forward.reconnectAt && forward.reconnectAt > Date.now()
    ? `<span class="status-retry">Retry in ${Math.ceil((forward.reconnectAt - Date.now()) / 1000)}s</span>`
    : '';
  const forwardError = escapeAttribute(forward.error ?? '');
  item.innerHTML = `
    <span class="runtime-name-cell">
      <span
        class="runtime-name runtime-name-status ${statusClass(forward.status)}${forwardError ? ' status-has-tooltip' : ''}"
        title="${escapeAttribute(formatStatus(forward.status))}"
        ${forwardError ? `data-tooltip="${forwardError}"` : ''}
      >
        <span class="runtime-status-marker">${runtimeStatusMarker(forward.status)}</span>
        <span class="runtime-name-text">${escapeHtml(forward.name?.trim() || `Rule #${index + 1}`)}</span>
      </span>
      ${forward.autoStart ? '<span class="runtime-auto">AUTO</span>' : ''}${retry}
    </span>
    <span class="runtime-port">${renderTunnelPort(forward)}</span>
    <span class="runtime-actions">${action}</span>
  `;
  item.querySelector<HTMLButtonElement>('[data-action="start-forward"]')?.addEventListener('click', async () => {
    try {
      await window.serviceApi.startForward(host.id, forward.id);
    } catch (error) {
      setMessage(`Start forward failed: ${(error as Error).message}`, 'error');
    }
  });
  item.querySelector<HTMLButtonElement>('[data-action="stop-forward"]')?.addEventListener('click', async () => {
    try {
      await window.serviceApi.stopForward(host.id, forward.id);
    } catch (error) {
      setMessage(`Stop forward failed: ${(error as Error).message}`, 'error');
    }
  });
  return item;
}

function createServiceRuntimeRow(
  host: HostView,
  service: HostView['services'][number],
): HTMLDivElement {
  const item = document.createElement('div');
  item.className = 'runtime-row runtime-row-service';
  item.dataset.hostId = host.id;
  item.dataset.serviceId = service.id;
  const canStop = canStopService(service.status);
  const action = canStop
    ? renderRuntimeActionButton('stop', 'Stop', false, service.status)
    : renderRuntimeActionButton('start', 'Start', !canStartService(service.status), service.status);
  const serviceError = escapeAttribute(service.error ?? '');
  const logTitle = service.pid
    ? `Open logs (PID ${service.pid}, ${formatStatus(service.status)})`
    : `Open logs (${formatStatus(service.status)})`;

  item.innerHTML = `
    <span class="runtime-name-cell">
      <button
        class="runtime-name runtime-name-button runtime-name-status ${statusClass(service.status)}${serviceError ? ' status-has-tooltip' : ''}"
        type="button"
        data-action="logs"
        title="${escapeAttribute(logTitle)}"
        ${serviceError ? `data-tooltip="${serviceError}"` : ''}
      >
        <span class="runtime-status-marker">${runtimeStatusMarker(service.status)}</span>
        <span class="runtime-name-text">${escapeHtml(service.name)}</span>
      </button>
    </span>
    <span class="runtime-port">${renderServicePort(service)}</span>
    <span class="runtime-actions">${action}</span>
  `;
  item.querySelector<HTMLButtonElement>('[data-action="start"]')?.addEventListener('click', async () => {
    try {
      await window.serviceApi.startService(host.id, service.id);
    } catch (error) {
      setMessage(`Start failed: ${(error as Error).message}`, 'error');
    }
  });
  item.querySelector<HTMLButtonElement>('[data-action="stop"]')?.addEventListener('click', async () => {
    try {
      await window.serviceApi.stopService(host.id, service.id);
    } catch (error) {
      setMessage(`Stop failed: ${(error as Error).message}`, 'error');
    }
  });
  item.querySelector<HTMLButtonElement>('[data-action="logs"]')?.addEventListener('click', () => {
    openServiceLogDialog(host, service.id);
  });
  return item;
}

function findRenderedHostPanel(hostId: string): HTMLElement | null {
  return Array.from(hostTableBody.querySelectorAll<HTMLElement>('.host-panel[data-host-id]'))
    .find((panel) => panel.dataset.hostId === hostId) ?? null;
}

function replaceRenderedForwardRow(hostId: string, forwardId: string): boolean {
  const host = hosts.find((item) => item.id === hostId);
  const forwardIndex = host?.forwards.findIndex((item) => item.id === forwardId) ?? -1;
  if (!host || forwardIndex < 0) {
    return true;
  }

  const panel = findRenderedHostPanel(hostId);
  if (!panel) {
    return false;
  }
  if (panel.classList.contains('host-panel-collapsed')) {
    return true;
  }

  const list = panel.querySelector<HTMLElement>('.runtime-section-tunnels .runtime-list');
  const currentRow = list
    ? Array.from(list.querySelectorAll<HTMLElement>('.runtime-row[data-forward-id]'))
      .find((item) => item.dataset.forwardId === forwardId) ?? null
    : null;
  if (!currentRow) {
    return false;
  }

  if (floatingTooltipAnchor && currentRow.contains(floatingTooltipAnchor)) {
    hideFloatingTooltip();
  }
  currentRow.replaceWith(createForwardRuntimeRow(host, host.forwards[forwardIndex], forwardIndex));
  return true;
}

function replaceRenderedServiceRow(hostId: string, serviceId: string): boolean {
  const host = hosts.find((item) => item.id === hostId);
  const service = host?.services.find((item) => item.id === serviceId);
  if (!host || !service) {
    return true;
  }

  const panel = findRenderedHostPanel(hostId);
  if (!panel) {
    return false;
  }
  if (panel.classList.contains('host-panel-collapsed')) {
    return true;
  }

  const list = panel.querySelector<HTMLElement>('.runtime-section-services .runtime-list');
  const currentRow = list
    ? Array.from(list.querySelectorAll<HTMLElement>('.runtime-row[data-service-id]'))
      .find((item) => item.dataset.serviceId === serviceId) ?? null
    : null;
  if (!currentRow) {
    return false;
  }

  if (floatingTooltipAnchor && currentRow.contains(floatingTooltipAnchor)) {
    hideFloatingTooltip();
  }
  currentRow.replaceWith(createServiceRuntimeRow(host, service));
  return true;
}

function flushRuntimeStatusDomUpdates(): void {
  runtimeStatusUpdateFrame = null;
  const updates = Array.from(pendingRuntimeStatusDomUpdates.values());
  pendingRuntimeStatusDomUpdates.clear();
  let needsFullRender = false;

  try {
    for (const update of updates) {
      const updated = update.kind === 'service'
        ? replaceRenderedServiceRow(update.hostId, update.itemId)
        : replaceRenderedForwardRow(update.hostId, update.itemId);
      needsFullRender ||= !updated;
    }
  } catch (error) {
    logRendererError('runtime-status-local-update', error);
    captureRendererException('runtime-status-local-update', error);
    needsFullRender = true;
  }

  if (needsFullRender) {
    renderSafely('runtime-status-fallback-render');
  }
}

function scheduleRuntimeStatusDomUpdate(target: RuntimeStatusDomTarget): void {
  const key = JSON.stringify([target.kind, target.hostId, target.itemId]);
  pendingRuntimeStatusDomUpdates.set(key, target);
  if (runtimeStatusUpdateFrame !== null) {
    return;
  }
  runtimeStatusUpdateFrame = window.requestAnimationFrame(flushRuntimeStatusDomUpdates);
}

function renderPageStats(): void {
  const bytes = appMemoryUsage?.bytes;
  pageStatsElement.textContent = typeof bytes === 'number' && bytes >= 0
    ? `Memory ${formatGigabytes(bytes)} GB`
    : 'Memory unavailable';
  pageStatsElement.classList.remove('hidden');
}

function formatGigabytes(bytes: number): string {
  return (bytes / 1_000_000_000).toFixed(2);
}

async function refreshAppMemoryUsage(): Promise<void> {
  try {
    appMemoryUsage = await window.serviceApi.getAppMemoryUsage();
  } catch {
    appMemoryUsage = null;
  }
  renderPageStats();
}

function startAppMemoryRefresh(): void {
  if (appMemoryRefreshTimer !== null) return;
  void refreshAppMemoryUsage();
  appMemoryRefreshTimer = window.setInterval(() => void refreshAppMemoryUsage(), APP_MEMORY_REFRESH_INTERVAL_MS);
}

function stopAppMemoryRefresh(): void {
  if (appMemoryRefreshTimer === null) return;
  window.clearInterval(appMemoryRefreshTimer);
  appMemoryRefreshTimer = null;
}

function populateHostPanelBody(panel: HTMLElement, host: HostView): void {
  const body = panel.querySelector<HTMLDivElement>('.host-panel-body');
  if (!body) {
    throw new Error('Missing host panel body.');
  }

  body.replaceChildren();
  body.classList.toggle('host-panel-body-two-col', !panel.classList.contains('host-panel-collapsed'));
  if (panel.classList.contains('host-panel-collapsed')) {
    return;
  }

  const tunnelSection = document.createElement('section');
  tunnelSection.className = 'runtime-section runtime-section-tunnels';
  tunnelSection.innerHTML = `
    <div class="runtime-section-title">
      ${renderSectionLabel('tunnel', 'Tunnels')}
    </div>
    <div class="runtime-list"></div>
  `;
  const tunnelList = tunnelSection.querySelector<HTMLDivElement>('.runtime-list');
  if (!tunnelList) {
    throw new Error('Missing tunnel runtime list.');
  }

  if (host.forwards.length === 0) {
    tunnelList.innerHTML = '<div class="runtime-empty">No tunnels</div>';
  } else {
    host.forwards.forEach((forward, index) => {
      tunnelList.appendChild(createForwardRuntimeRow(host, forward, index));
    });
  }
  body.appendChild(tunnelSection);

  const serviceSection = document.createElement('section');
  serviceSection.className = 'runtime-section runtime-section-services';
  serviceSection.innerHTML = `
    <div class="runtime-section-title">
      ${renderSectionLabel('service', 'Services')}
    </div>
    <div class="runtime-list"></div>
  `;
  const serviceList = serviceSection.querySelector<HTMLDivElement>('.runtime-list');
  if (!serviceList) {
    throw new Error('Missing service runtime list.');
  }

  if (host.services.length === 0) {
    serviceList.innerHTML = '<div class="runtime-empty">No services</div>';
  } else {
    for (const service of host.services) {
      serviceList.appendChild(createServiceRuntimeRow(host, service));
    }
  }
  body.appendChild(serviceSection);
}

function setRenderedHostCollapsed(host: HostView, panel: HTMLElement, collapsed: boolean): void {
  const body = panel.querySelector<HTMLElement>('.host-panel-body');
  if (collapsed && body && floatingTooltipAnchor && body.contains(floatingTooltipAnchor)) {
    hideFloatingTooltip();
  }
  panel.classList.toggle('host-panel-collapsed', collapsed);
  const toggle = panel.querySelector<HTMLButtonElement>('[data-action="toggle-host"]');
  if (toggle) {
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.setAttribute('aria-label', collapsed ? 'Expand host' : 'Collapse host');
    toggle.title = collapsed ? 'Expand host' : 'Collapse host';
    const icon = toggle.querySelector<HTMLElement>('.host-toggle-icon');
    if (icon) {
      icon.innerHTML = renderHostToggleIcon(collapsed);
    }
  }
  populateHostPanelBody(panel, host);
}

function render(): void {
  renderPageStats();

  if (hosts.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td class="table-empty">No hosts configured.</td>`;
    hostTableBody.replaceChildren(row);
    return;
  }

  const fragment = document.createDocumentFragment();
  hosts.forEach((host) => {
    const isCollapsed = collapsedHostIds.has(host.id);
    const row = document.createElement('tr');
    row.className = 'host-panel-row';
    const cell = document.createElement('td');
    cell.className = 'host-panel-cell';
    cell.colSpan = 6;

    const panel = document.createElement('article');
    panel.className = `host-panel${isCollapsed ? ' host-panel-collapsed' : ''}`;
    panel.dataset.hostId = host.id;
    const hostName = escapeHtml(host.name);
    const hostDesc = escapeHtml(`${host.username}@${host.sshHost}:${host.sshPort}${formatJumpChain(host.jumpHosts)}`);
    const hostInitial = escapeHtml(([...host.name.trim()][0] ?? '#').toUpperCase());
    panel.innerHTML = `
      <div class="host-panel-head">
        <div class="host-panel-main">
          <div class="host-panel-title-wrap">
            <div class="host-panel-title">
              <button
                type="button"
                class="host-toggle-btn"
                data-action="toggle-host"
                aria-expanded="${isCollapsed ? 'false' : 'true'}"
                aria-label="${isCollapsed ? 'Expand host' : 'Collapse host'}"
                title="${isCollapsed ? 'Expand host' : 'Collapse host'}"
              >
                <span class="host-toggle-icon">${renderHostToggleIcon(isCollapsed)}</span>
              </button>
              <span class="host-identity" aria-hidden="true" style="background:hsl(${hostHue(host.name)} 60% 42%)">${hostInitial}</span>
              <span class="host-panel-name">${hostName}</span>
              <span class="host-panel-desc">${hostDesc}</span>
            </div>
          </div>
        </div>
        <div class="host-panel-actions row-actions">
          <button class="btn btn-secondary btn-sm btn-icon-only" data-action="copy-host" title="Copy host" aria-label="Copy host">${renderButtonContent('copy', 'Copy')}</button>
          <button class="btn btn-secondary btn-sm btn-icon-only" data-action="edit-host" title="Edit host" aria-label="Edit host">${renderButtonContent('edit', 'Edit Host')}</button>
          <button class="btn btn-danger btn-sm btn-icon-only" data-action="delete-host" title="Delete host" aria-label="Delete host">${renderButtonContent('delete', 'Delete Host')}</button>
        </div>
      </div>
      <div class="host-panel-body"></div>
    `;

    panel.querySelector<HTMLButtonElement>('[data-action="toggle-host"]')?.addEventListener('click', () => {
      const nextCollapsed = !collapsedHostIds.has(host.id);
      if (nextCollapsed) {
        collapsedHostIds.add(host.id);
      } else {
        collapsedHostIds.delete(host.id);
      }
      try {
        setRenderedHostCollapsed(host, panel, nextCollapsed);
      } catch (error) {
        reportRendererError('toggle-host', error, 'Unexpected Host display error.');
        renderSafely('toggle-host-fallback');
      }
    });

    bindHostActions(panel, host);
    populateHostPanelBody(panel, host);

    cell.appendChild(panel);
    row.appendChild(cell);
    fragment.appendChild(row);
  });
  hostTableBody.replaceChildren(fragment);
}

const HOSTS_NAV_ICON = `
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="2.5" y="2.5" width="11" height="4.5" rx="1"></rect>
    <rect x="2.5" y="9" width="11" height="4.5" rx="1"></rect>
    <path d="M5 4.75h.01"></path>
    <path d="M5 11.25h.01"></path>
  </svg>
`;

registerPage({
  id: 'hosts',
  title: 'Hosts',
  icon: HOSTS_NAV_ICON,
  onShow: () => {
    isHostsPageActive = true;
    renderSafely('show-hosts');
    startAppMemoryRefresh();
    startStatusAutoRefresh();
  },
  onHide: () => {
    isHostsPageActive = false;
    stopAppMemoryRefresh();
    stopStatusAutoRefresh();
    stopLogAutoRefresh();
    activeLogTarget = null;
    closeDialog(serviceLogDialog, 'service log');
    resetServiceLogState();
    setServiceLogPageScrollLock(false);
    hideFloatingTooltip();
    if (runtimeStatusUpdateFrame !== null) {
      window.cancelAnimationFrame(runtimeStatusUpdateFrame);
      runtimeStatusUpdateFrame = null;
    }
    pendingRuntimeStatusDomUpdates.clear();
    hostTableBody.replaceChildren();
  },
});
registerProxyPage();
registerKubernetesPage();
registerSqlPage();
registerNotesPage();
registerSettingsDialog();

applyStaticButtonIcons();
bindNumericPortInputs(form);
updateHostEditCounts();
setActiveHostEditSection('path');
resetServiceLogState();

bindTabButtons(hostEditTabItems, setActiveHostEditSection);

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
  updateHostEditCounts();
});

addJumpHostButton.addEventListener('click', () => {
  jumpHostEditorList.appendChild(createJumpHostEditorRow());
  syncJumpSection();
});

addServiceButton.addEventListener('click', () => {
  serviceEditorList.appendChild(createServiceEditorRow());
  updateHostEditCounts();
});

importPrivateKeyButton.addEventListener('click', async () => {
  try {
    await importPrivateKeyIntoField(
      privateKeyInput,
      (path) => `Imported private key from ${path}`,
      (path) => {
        editingPrivateKeyPath = path;
        setPrivateKeyExpanded(false);
        updatePrivateKeySourceStatus();
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

pageMessageTextElement.addEventListener('click', () => {
  if (pageMessageAction !== 'open-note-export') return;
  const generation = pageMessageGeneration;
  configurePageMessageAction();
  void window.notesApi.openLastExport().then((result) => {
    if (pageMessageGeneration !== generation) return;
    if (result.status === 'opened') {
      setMessage('');
    } else {
      setMessage('The downloaded Note file is no longer available to open.', 'error');
    }
  }).catch((error) => {
    if (pageMessageGeneration === generation) setMessage(toErrorMessage(error), 'error');
  });
});
pageMessageCloseButton.addEventListener('click', () => setMessage(''));
hostDialogMessageCloseButton.addEventListener('click', clearHostDialogMessage);
closeHostDialogButton.addEventListener('click', closeHostDialog);
cancelHostDialogButton.addEventListener('click', closeHostDialog);
resetButton.addEventListener('click', () => resetForm());
authTypeSelect.addEventListener('change', toggleAuthFields);
privateKeyInput.addEventListener('input', () => {
  if (editingPrivateKeyPath && privateKeyInput.value.trim() === '') {
    editingPrivateKeyPath = undefined;
  }
  updatePrivateKeySourceStatus();
});
togglePrivateKeyButton.addEventListener('click', () => {
  setPrivateKeyExpanded(privateKeyContent.classList.contains('hidden'));
});
privateKeySummaryToggle.addEventListener('click', () => {
  setPrivateKeyExpanded(privateKeyContent.classList.contains('hidden'));
});
useJumpHostInput.addEventListener('change', syncJumpSection);
serviceLogSearchInput.addEventListener('input', () => {
  renderServiceLogView({ preserveScroll: true, focusActiveMatch: true });
});
serviceLogSearchInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') {
    return;
  }
  event.preventDefault();
  if (logSearchMatchElements.length === 0) {
    return;
  }
  setActiveLogSearchMatch(activeLogSearchMatchIndex + (event.shiftKey ? -1 : 1));
});
serviceLogFilterInput.addEventListener('input', () => {
  renderServiceLogView({ preserveScroll: true, focusActiveMatch: true });
});
serviceLogPrevButton.addEventListener('click', () => {
  setActiveLogSearchMatch(activeLogSearchMatchIndex - 1);
});
serviceLogNextButton.addEventListener('click', () => {
  setActiveLogSearchMatch(activeLogSearchMatchIndex + 1);
});
serviceLogTerminal.addEventListener('scroll', () => {
  maybeLoadOlderServiceLogs();
});
logAutoScrollInput.addEventListener('change', () => {
  if (logAutoScrollInput.checked) {
    serviceLogTerminal.scrollTop = serviceLogTerminal.scrollHeight;
  }
  applyPendingLogUpdateIfPossible();
});
closeServiceLogDialogButton.addEventListener('click', () => {
  stopLogAutoRefresh();
  closeDialog(serviceLogDialog, 'service log');
  activeLogTarget = null;
  resetServiceLogState();
  setServiceLogPageScrollLock(false);
});
serviceLogDialog.addEventListener('close', () => {
  stopLogAutoRefresh();
  activeLogTarget = null;
  resetServiceLogState();
  setServiceLogPageScrollLock(false);
});
document.addEventListener('selectionchange', () => {
  if (!serviceLogDialog.open) {
    return;
  }
  applyPendingLogUpdateIfPossible();
});
window.addEventListener('beforeunload', () => {
  stopLogAutoRefresh();
  stopStatusAutoRefresh();
  stopAppMemoryRefresh();
  if (runtimeStatusUpdateFrame !== null) {
    window.cancelAnimationFrame(runtimeStatusUpdateFrame);
    runtimeStatusUpdateFrame = null;
  }
  pendingRuntimeStatusDomUpdates.clear();
  setServiceLogPageScrollLock(false);
});

function showFloatingTooltip(anchor: HTMLElement): void {
  const text = anchor.getAttribute('data-tooltip');
  if (!text) return;
  hideFloatingTooltip();
  const tip = document.createElement('div');
  tip.className = 'status-tooltip-floating';
  tip.textContent = text;
  document.body.appendChild(tip);
  floatingTooltip = tip;
  floatingTooltipAnchor = anchor;
  const rect = anchor.getBoundingClientRect();
  tip.style.left = `${rect.left}px`;
  tip.style.top = `${rect.bottom + 6}px`;
}

function hideFloatingTooltip(): void {
  if (floatingTooltip) {
    floatingTooltip.remove();
    floatingTooltip = null;
  }
  floatingTooltipAnchor = null;
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

form.addEventListener('invalid', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const panel = target.closest<HTMLElement>('[data-host-edit-panel]');
  const section = panel?.dataset.hostEditPanel as HostEditSection | undefined;
  if (section) setActiveHostEditSection(section);
}, true);

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    const authType = authTypeSelect.value === 'password' ? 'password' : 'privateKey';
    const draft: HostDraft = {
      id: hostIdInput.value.trim() || undefined,
      name: nameInput.value.trim(),
      sshHost: sshHostInput.value.trim(),
      sshPort: Number(sshPortInput.value),
      username: usernameInput.value.trim(),
      authType,
      password: authType === 'password' ? passwordInput.value.trim() || undefined : undefined,
      privateKey: authType === 'privateKey' ? privateKeyInput.value || undefined : undefined,
      passphrase: authType === 'privateKey' ? passphraseInput.value.trim() || undefined : undefined,
      privateKeyPath: authType === 'privateKey' ? editingPrivateKeyPath : undefined,
      jumpHosts: collectJumpHostsDraft(),
      forwards: collectForwardsFromEditor(),
      services: collectServicesFromEditor(),
    };

    await window.serviceApi.saveHost(draft);
    await loadHosts();
    closeHostDialog();
    setMessage(hostDialogMode === 'create' ? `Host "${draft.name}" created.` : `Host "${draft.name}" updated.`, 'success');
  } catch (error) {
    const message = (error as Error).message;
    if (/^Rule \d+:/.test(message)) {
      setActiveHostEditSection('forwards');
    } else if (/^Service \d+:/.test(message)) {
      setActiveHostEditSection('services');
    } else {
      setActiveHostEditSection('path');
    }
    setHostDialogMessage(message, 'error');
  }
});

window.serviceApi.onServiceStatusChanged((change) => {
  try {
    const host = hosts.find((item) => item.id === change.hostId);
    if (!host) return;

    const service = host.services.find((item) => item.id === change.serviceId);
    if (!service) return;

    const hasVisibleChange = service.status !== change.status
      || service.pid !== change.pid
      || service.error !== change.error
      || service.forwardState !== change.forwardState
      || service.forwardError !== change.forwardError;
    service.status = change.status;
    service.pid = change.pid;
    service.error = change.error;
    service.updatedAt = change.updatedAt;
    service.forwardState = change.forwardState;
    service.forwardError = change.forwardError;
    if (hasVisibleChange && isHostsPageActive) {
      scheduleRuntimeStatusDomUpdate({
        kind: 'service',
        hostId: change.hostId,
        itemId: change.serviceId,
      });
    }
    const serviceError = change.error;
    if (!change.silent && change.status === 'error' && serviceError && shouldPromoteServiceError(serviceError)) {
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

    const hasVisibleChange = forward.status !== change.status
      || forward.error !== change.error
      || forward.reconnectAt !== change.reconnectAt;
    const refreshRetryText = change.status === 'error'
      && typeof change.reconnectAt === 'number'
      && change.reconnectAt > Date.now();
    forward.status = change.status;
    forward.error = change.error;
    forward.reconnectAt = change.reconnectAt;
    if ((hasVisibleChange || refreshRetryText) && isHostsPageActive) {
      scheduleRuntimeStatusDomUpdate({
        kind: 'forward',
        hostId: change.hostId,
        itemId: change.forwardId,
      });
    }
  } catch (error) {
    reportRendererError('forward-status-changed', error, 'Unexpected tunnel status update error.');
  }
});

window.serviceApi.onUpdateStateChanged((state) => {
  try {
    renderUpdateState(state);
    if (state.status === 'error' && state.trigger === 'manual') {
      setMessage(state.message ?? 'Update check failed.', 'error');
    }
  } catch (error) {
    reportRendererError('update-state-changed', error, 'Unexpected updater status error.');
  }
});

window.settingsApi.onPersistentDataReloaded((event) => {
  const notesUpdate = event.notesDelta
    ? applyNotesPageDelta(event.notesDelta, event.persistentApplyId)
    : event.persistentApplyId
      ? reloadNotesPage(event.persistentApplyId)
      : Promise.resolve();
  const reload = event.hostsChanged
    ? Promise.all([loadHosts(), notesUpdate]).then(() => undefined)
    : notesUpdate;
  void trackStartupS3SyncWork(reload).catch((error) => {
    reportRendererError('persistent-data-reloaded', error, 'Persistent data changed, but the page could not be refreshed.');
  });
});

(async function init() {
  try {
    await startupS3SyncReady;
    initNav('hosts');
    resetForm();
    await loadHosts();
    await refreshAllServices(true);
    try {
      renderUpdateState(await window.serviceApi.getUpdateState());
    } catch {
      // no-op
    }
    void maybeShowChangelog();
  } catch (error) {
    reportRendererError('init', error, 'Failed to initialize UI.');
  }
})();

window.addEventListener('error', (event) => {
  reportRendererError('window:error', event.error ?? event.message, 'Unexpected UI error.', false);
});

window.addEventListener('unhandledrejection', (event) => {
  reportRendererError('window:unhandledrejection', event.reason, 'Unexpected async UI error.', false);
  event.preventDefault();
});
