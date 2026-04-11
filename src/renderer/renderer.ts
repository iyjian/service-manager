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
const jumpSshHostInput = requireElement<HTMLInputElement>('#jump-ssh-host');
const jumpSshPortInput = requireElement<HTMLInputElement>('#jump-ssh-port');
const jumpUsernameInput = requireElement<HTMLInputElement>('#jump-username');
const jumpAuthTypeSelect = requireElement<HTMLSelectElement>('#jump-auth-type');
const jumpPasswordInput = requireElement<HTMLInputElement>('#jump-password');
const jumpPrivateKeyInput = requireElement<HTMLTextAreaElement>('#jump-private-key');
const jumpPassphraseInput = requireElement<HTMLInputElement>('#jump-passphrase');
const jumpPasswordRow = requireElement<HTMLElement>('#jump-password-row');
const jumpPrivateKeyRow = requireElement<HTMLElement>('#jump-private-key-row');
const jumpPassphraseRow = requireElement<HTMLElement>('#jump-passphrase-row');
const importJumpPrivateKeyButton = requireElement<HTMLButtonElement>('#import-jump-private-key-btn');
const forwardEditorList = requireElement<HTMLDivElement>('#forward-editor-list');
const addForwardButton = requireElement<HTMLButtonElement>('#add-forward-btn');
const serviceEditorList = requireElement<HTMLDivElement>('#service-editor-list');
const addServiceButton = requireElement<HTMLButtonElement>('#add-service-btn');
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

function toggleJumpAuthFields(): void {
  if (jumpAuthTypeSelect.value === 'password') {
    jumpPasswordRow.classList.remove('hidden');
    jumpPrivateKeyRow.classList.add('hidden');
    jumpPassphraseRow.classList.add('hidden');
  } else {
    jumpPasswordRow.classList.add('hidden');
    jumpPrivateKeyRow.classList.remove('hidden');
    jumpPassphraseRow.classList.remove('hidden');
  }
}

function toggleJumpSection(): void {
  if (!useJumpHostInput.checked) {
    jumpHostSection.classList.add('hidden');
    return;
  }
  jumpHostSection.classList.remove('hidden');
  toggleJumpAuthFields();
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

function createForwardEditorRow(draft?: ForwardRuleDraft): HTMLElement {
  const row = document.createElement('div');
  row.className = 'forward-row';
  row.innerHTML = `
    <input type="hidden" data-field="id" value="${safeValue(draft?.id)}" />
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
    <button type="button" class="btn btn-danger btn-sm forward-remove">Delete Rule</button>
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
    <button type="button" class="btn btn-danger btn-sm forward-remove">Remove</button>
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

    const localHost = get('localHost');
    const localPortRaw = get('localPort');
    const remoteHost = get('remoteHost');
    const remotePortRaw = get('remotePort');
    const isBlank = !localHost && !localPortRaw && !remoteHost && !remotePortRaw && !autoStart;
    if (isBlank) {
      return;
    }
    if (!localHost) throw new Error(`Rule ${index + 1}: Local Host is required`);
    if (!localPortRaw) throw new Error(`Rule ${index + 1}: Local Port is required`);
    if (!remoteHost) throw new Error(`Rule ${index + 1}: Remote Host is required`);
    if (!remotePortRaw) throw new Error(`Rule ${index + 1}: Remote Port is required`);

    forwards.push({
      id: get('id') || undefined,
      localHost,
      localPort: parsePort(localPortRaw, `Rule ${index + 1} Local Port`),
      remoteHost,
      remotePort: parsePort(remotePortRaw, `Rule ${index + 1} Remote Port`),
      autoStart,
    });
  });

  return forwards;
}

function collectJumpHostDraft(): JumpHostConfig | undefined {
  if (!useJumpHostInput.checked) {
    return undefined;
  }

  const authType = jumpAuthTypeSelect.value === 'password' ? 'password' : 'privateKey';
  const jumpHost: JumpHostConfig = {
    sshHost: jumpSshHostInput.value.trim(),
    sshPort: parsePort(jumpSshPortInput.value, 'Jump SSH Port'),
    username: jumpUsernameInput.value.trim(),
    authType,
    password: jumpPasswordInput.value || undefined,
    privateKey: jumpPrivateKeyInput.value || undefined,
    passphrase: jumpPassphraseInput.value || undefined,
  };

  if (!jumpHost.sshHost) throw new Error('Jump SSH Host is required');
  if (!jumpHost.username) throw new Error('Jump Username is required');
  if (authType === 'password' && !jumpHost.password) {
    throw new Error('Jump Password is required for password auth');
  }
  if (authType === 'privateKey' && !jumpHost.privateKey?.trim()) {
    throw new Error('Jump Private Key is required for private key auth');
  }

  return jumpHost;
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
  jumpSshHostInput.value = '';
  jumpSshPortInput.value = '22';
  jumpUsernameInput.value = '';
  jumpAuthTypeSelect.value = 'privateKey';
  jumpPasswordInput.value = '';
  jumpPrivateKeyInput.value = '';
  jumpPassphraseInput.value = '';
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
    useJumpHostInput.checked = Boolean(host.jumpHost);
    jumpSshHostInput.value = host.jumpHost?.sshHost ?? '';
    jumpSshPortInput.value = host.jumpHost?.sshPort ? String(host.jumpHost.sshPort) : '22';
    jumpUsernameInput.value = host.jumpHost?.username ?? '';
    jumpAuthTypeSelect.value = host.jumpHost?.authType ?? 'privateKey';
    jumpPasswordInput.value = host.jumpHost?.password ?? '';
    jumpPrivateKeyInput.value = host.jumpHost?.privateKey ?? '';
    jumpPassphraseInput.value = host.jumpHost?.passphrase ?? '';
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
    const hostDesc = escapeHtml(
      `${host.username}@${host.sshHost}:${host.sshPort}${
        host.jumpHost ? ` · via ${host.jumpHost.username}@${host.jumpHost.sshHost}:${host.jumpHost.sshPort}` : ''
      }`
    );
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
            <button class="btn btn-secondary btn-sm" data-action="edit-host">Edit Host</button>
            <button class="btn btn-danger btn-sm" data-action="delete-host">Delete Host</button>
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

    if (isCollapsed) {
      groupRow.querySelector<HTMLButtonElement>('[data-action="edit-host"]')?.addEventListener('click', () => {
        openHostDialog('edit', host);
      });
      groupRow.querySelector<HTMLButtonElement>('[data-action="delete-host"]')?.addEventListener('click', async () => {
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
      return;
    }

    const tunnelTitle = document.createElement('tr');
    tunnelTitle.className = 'host-section-row host-section-row-tunnel';
    tunnelTitle.innerHTML =
      '<th colspan="6"><span class="host-section-label host-section-label-tunnel">Tunnel List</span></th>';
    hostTableBody.appendChild(tunnelTitle);

    const tunnelHeader = document.createElement('tr');
    tunnelHeader.className = 'host-rules-head host-rules-head-tunnel';
    tunnelHeader.innerHTML = `
      <th>Rule</th>
      <th>Local</th>
      <th>Remote</th>
      <th>Auto Start</th>
      <th>Status</th>
      <th>Actions</th>
    `;
    hostTableBody.appendChild(tunnelHeader);

    if (host.forwards.length === 0) {
      const empty = document.createElement('tr');
      empty.className = 'data-row section-empty-row section-empty-row-tunnel';
      empty.innerHTML = `<td colspan="6" class="table-empty">No forwarding rules under this host.</td>`;
      hostTableBody.appendChild(empty);
    }

    host.forwards.forEach((forward, index) => {
      const row = document.createElement('tr');
      row.className = 'data-row data-row-tunnel';
      const startDisabled = canStartForward(forward.status) ? '' : 'disabled';
      const stopDisabled = canStopForward(forward.status) ? '' : 'disabled';
      const forwardError = escapeAttribute(forward.error ?? '');
      const forwardStatus = escapeHtml(formatStatus(forward.status));
      const localEndpoint = escapeHtml(`${forward.localHost}:${forward.localPort}`);
      const remoteEndpoint = escapeHtml(`${forward.remoteHost}:${forward.remotePort}`);
      const retry = forward.status === 'error' && forward.reconnectAt && forward.reconnectAt > Date.now()
        ? `<div class="status-retry">Retry in ${Math.ceil((forward.reconnectAt - Date.now()) / 1000)}s</div>`
        : '';
      row.innerHTML = `
        <td class="table-cell">#${index + 1}</td>
        <td class="table-cell">${localEndpoint}</td>
        <td class="table-cell">${remoteEndpoint}</td>
        <td class="table-cell auto-start-cell"><span class="auto-start-indicator ${forward.autoStart ? 'auto-start-enabled' : 'auto-start-disabled'}">${forward.autoStart ? '✓' : '✗'}</span></td>
        <td class="table-cell">
          <div class="status-wrap">
            <span class="status-indicator ${statusClass(forward.status)}${forwardError ? ' status-has-tooltip' : ''}" ${forwardError ? `data-tooltip="${forwardError}"` : ''}>
              <span class="status-dot"></span>
              <span class="status-label">${forwardStatus}</span>
            </span>
            ${retry}
          </div>
        </td>
        <td class="table-cell">
          <div class="row-actions">
            <button class="btn btn-primary btn-sm" data-action="start-forward" ${startDisabled}>Start</button>
            <button class="btn btn-secondary btn-sm" data-action="stop-forward" ${stopDisabled}>Stop</button>
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

    const serviceTitle = document.createElement('tr');
    serviceTitle.className = 'host-section-row host-section-row-service';
    serviceTitle.innerHTML =
      '<th colspan="6"><span class="host-section-label host-section-label-service">Service List</span></th>';
    hostTableBody.appendChild(serviceTitle);

    const serviceHeader = document.createElement('tr');
    serviceHeader.className = 'host-rules-head host-rules-head-service';
    serviceHeader.innerHTML = `
      <th>Service</th>
      <th>Port</th>
      <th>Status</th>
      <th>PID</th>
      <th>Updated</th>
      <th>Actions</th>
    `;
    hostTableBody.appendChild(serviceHeader);

    if (host.services.length === 0) {
      const empty = document.createElement('tr');
      empty.className = 'data-row section-empty-row section-empty-row-service';
      empty.innerHTML = `<td colspan="6" class="table-empty">No services under this host.</td>`;
      hostTableBody.appendChild(empty);
    }

    for (const service of host.services) {
      const row = document.createElement('tr');
      row.className = 'data-row data-row-service';
      const updated = service.updatedAt ? new Date(service.updatedAt).toLocaleString() : '-';
      const pidText = service.pid ? String(service.pid) : '-';
      const safeServiceName = escapeHtml(service.name);
      const safeUpdated = escapeHtml(updated);
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
        <td class="table-cell">${safeUpdated}</td>
        <td>
          <div class="row-actions">
            <button class="btn btn-primary btn-sm" data-action="start" ${startDisabled}>Start</button>
            <button class="btn btn-secondary btn-sm" data-action="stop" ${stopDisabled}>Stop</button>
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

    groupRow.querySelector<HTMLButtonElement>('[data-action="edit-host"]')?.addEventListener('click', () => {
      openHostDialog('edit', host);
    });
    groupRow.querySelector<HTMLButtonElement>('[data-action="delete-host"]')?.addEventListener('click', async () => {
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
  });
}

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

addServiceButton.addEventListener('click', () => {
  serviceEditorList.appendChild(createServiceEditorRow());
});

importPrivateKeyButton.addEventListener('click', async () => {
  try {
    const imported = await window.serviceApi.importPrivateKey();
    if (!imported) return;
    privateKeyInput.value = imported.content;
    editingPrivateKeyPath = imported.path;
    setHostDialogMessage(`Imported private key from ${imported.path}`, 'success');
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
jumpAuthTypeSelect.addEventListener('change', toggleJumpAuthFields);
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

importJumpPrivateKeyButton.addEventListener('click', async () => {
  try {
    const imported = await window.serviceApi.importPrivateKey();
    if (!imported) return;
    jumpPrivateKeyInput.value = imported.content;
    setHostDialogMessage(`Imported jump private key from ${imported.path}`, 'success');
  } catch (error) {
    setHostDialogMessage((error as Error).message, 'error');
  }
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
      jumpHost: collectJumpHostDraft(),
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
