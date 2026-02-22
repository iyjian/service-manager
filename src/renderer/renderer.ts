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
const messageElement = document.querySelector<HTMLParagraphElement>('#message');
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

function setMessage(text: string, level: 'default' | 'success' | 'error' = 'default'): void {
  if (!messageElement) return;
  messageElement.classList.remove('message-default', 'message-success', 'message-error');
  messageElement.classList.add(
    level === 'success' ? 'message-success' : level === 'error' ? 'message-error' : 'message-default'
  );
  messageElement.textContent = text;
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
    <input type="hidden" data-field="id" value="${draft?.id ?? ''}" />
    <label class="field field-xs forward-local-host">
      Local Host
      <input class="input" data-field="localHost" value="${draft?.localHost ?? '127.0.0.1'}" required />
    </label>
    <label class="field field-xs forward-local-port">
      Local Port
      <input class="input" data-field="localPort" type="number" min="1" max="65535" value="${draft?.localPort ?? ''}" required />
    </label>
    <label class="field field-xs forward-remote-host">
      Remote Host
      <input class="input" data-field="remoteHost" value="${draft?.remoteHost ?? '127.0.0.1'}" required />
    </label>
    <label class="field field-xs forward-remote-port">
      Remote Port
      <input class="input" data-field="remotePort" type="number" min="1" max="65535" value="${draft?.remotePort ?? ''}" required />
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
  row.className = 'forward-row';
  row.innerHTML = `
    <input type="hidden" data-field="id" value="${draft?.id ?? ''}" />
    <label class="field field-xs forward-local-host">
      Name
      <input class="input" data-field="name" value="${draft?.name ?? ''}" required />
    </label>
    <label class="field field-xs">
      Start Command
      <input class="input" data-field="startCommand" value="${draft?.startCommand ?? ''}" required />
    </label>
    <label class="field field-xs">
      Exposed Port
      <input class="input" data-field="port" type="number" min="0" max="65535" value="${draft?.port ?? ''}" required />
    </label>
    <label class="field field-xs">
      Forward Local Port (Optional)
      <input class="input" data-field="forwardLocalPort" type="number" min="1" max="65535" value="${draft?.forwardLocalPort ?? ''}" />
    </label>
    <button type="button" class="btn btn-danger btn-sm forward-remove">Remove</button>
  `;

  row.querySelector<HTMLButtonElement>('.forward-remove')?.addEventListener('click', () => {
    row.remove();
  });

  return row;
}

function collectForwardsFromEditor(): ForwardRuleDraft[] {
  const rows = Array.from(forwardEditorList.querySelectorAll<HTMLElement>('.forward-row'));
  return rows.map((row, index) => {
    const get = (field: string): string =>
      row.querySelector<HTMLInputElement>(`[data-field="${field}"]`)?.value.trim() ?? '';
    const autoStart = row.querySelector<HTMLInputElement>('[data-field="autoStart"]')?.checked ?? false;

    const localHost = get('localHost');
    const remoteHost = get('remoteHost');
    if (!localHost) throw new Error(`Rule ${index + 1}: Local Host is required`);
    if (!remoteHost) throw new Error(`Rule ${index + 1}: Remote Host is required`);

    return {
      id: get('id') || undefined,
      localHost,
      localPort: parsePort(get('localPort'), `Rule ${index + 1} Local Port`),
      remoteHost,
      remotePort: parsePort(get('remotePort'), `Rule ${index + 1} Remote Port`),
      autoStart,
    };
  });
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
  const rows = Array.from(serviceEditorList.querySelectorAll<HTMLElement>('.forward-row'));
  return rows.map((row) => {
    const get = (field: string): string =>
      row.querySelector<HTMLInputElement>(`[data-field="${field}"]`)?.value.trim() ?? '';

    return {
      id: get('id') || undefined,
      name: get('name'),
      startCommand: get('startCommand'),
      port: Number(get('port')),
      forwardLocalPort: get('forwardLocalPort') ? Number(get('forwardLocalPort')) : undefined,
    };
  });
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
  forwardEditorList.appendChild(createForwardEditorRow());
  serviceEditorList.appendChild(createServiceEditorRow());
  toggleAuthFields();
  toggleJumpSection();
}

function openHostDialog(mode: 'create' | 'edit', host?: HostView): void {
  hostDialogMode = mode;
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
    if (host.forwards.length === 0) forwardEditorList.appendChild(createForwardEditorRow());

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
    if (host.services.length === 0) serviceEditorList.appendChild(createServiceEditorRow());
  } else {
    hostDialogTitle.textContent = 'Add Host';
    resetForm();
  }

  toggleAuthFields();
  toggleJumpSection();
  hostDialog.showModal();
}

function closeHostDialog(): void {
  hostDialog.close();
  setMessage('');
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
  render();
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
  const logs: ServiceLogsResult = await window.serviceApi.getServiceLogs(activeLogTarget.hostId, activeLogTarget.serviceId);
  const merged = `${logs.stdout || ''}${logs.stderr || ''}`;
  serviceLogTerminal.innerHTML = ansiToHtml(merged);
  if (logAutoScrollInput.checked) {
    serviceLogTerminal.scrollTop = serviceLogTerminal.scrollHeight;
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
  serviceLogTitle.textContent = `${host.name} / ${service.name} (PID: ${service.pid ?? '-'})`;
  serviceLogTerminal.textContent = '';

  void loadServiceLogs();
  startLogAutoRefresh();
  serviceLogDialog.showModal();
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

  for (const host of hosts) {
    const groupRow = document.createElement('tr');
    groupRow.className = 'group-row';
    groupRow.innerHTML = `
      <td colspan="6" class="group-cell">
        <div class="group-head">
          <div>
            <div class="group-title">${host.name}</div>
            <div class="group-desc">${host.username}@${host.sshHost}:${host.sshPort}${host.jumpHost ? ` · via ${host.jumpHost.username}@${host.jumpHost.sshHost}:${host.jumpHost.sshPort}` : ''}</div>
          </div>
          <div class="row-actions">
            <button class="btn btn-secondary btn-sm" data-action="edit-host">Edit Host</button>
            <button class="btn btn-danger btn-sm" data-action="delete-host">Delete Host</button>
          </div>
        </div>
      </td>
    `;
    hostTableBody.appendChild(groupRow);

    const tunnelTitle = document.createElement('tr');
    tunnelTitle.className = 'host-rules-head';
    tunnelTitle.innerHTML = '<th colspan="6">Tunnel List</th>';
    hostTableBody.appendChild(tunnelTitle);

    const tunnelHeader = document.createElement('tr');
    tunnelHeader.className = 'host-rules-head';
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
      empty.className = 'data-row';
      empty.innerHTML = `<td colspan="6" class="table-empty">No forwarding rules under this host.</td>`;
      hostTableBody.appendChild(empty);
    }

    host.forwards.forEach((forward, index) => {
      const row = document.createElement('tr');
      row.className = 'data-row';
      const startDisabled = canStartForward(forward.status) ? '' : 'disabled';
      const stopDisabled = canStopForward(forward.status) ? '' : 'disabled';
      const retry = forward.status === 'error' && forward.reconnectAt && forward.reconnectAt > Date.now()
        ? `<div class="status-retry">Retry in ${Math.ceil((forward.reconnectAt - Date.now()) / 1000)}s</div>`
        : '';
      row.innerHTML = `
        <td class="table-cell">#${index + 1}</td>
        <td class="table-cell">${forward.localHost}:${forward.localPort}</td>
        <td class="table-cell">${forward.remoteHost}:${forward.remotePort}</td>
        <td class="table-cell auto-start-cell">${forward.autoStart ? '✓' : '✗'}</td>
        <td class="table-cell">
          <span class="status-indicator ${statusClass(forward.status)}" title="${forward.error ?? ''}">
            <span class="status-dot"></span>
            <span class="status-label">${formatStatus(forward.status)}</span>
          </span>
          ${retry}
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
    serviceTitle.className = 'host-rules-head';
    serviceTitle.innerHTML = '<th colspan="6">Service List</th>';
    hostTableBody.appendChild(serviceTitle);

    const serviceHeader = document.createElement('tr');
    serviceHeader.className = 'host-rules-head';
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
      empty.className = 'data-row';
      empty.innerHTML = `<td colspan="6" class="table-empty">No services under this host.</td>`;
      hostTableBody.appendChild(empty);
    }

    for (const service of host.services) {
      const row = document.createElement('tr');
      row.className = 'data-row';
      const updated = service.updatedAt ? new Date(service.updatedAt).toLocaleString() : '-';
      const pidText = service.pid ? String(service.pid) : '-';
      const portText = (() => {
        if (service.port === 0 || !service.forwardLocalPort) {
          return `<span>${service.port}</span>`;
        }
        const base = `${service.forwardLocalPort} -> ${service.port}`;
        if (service.forwardState === 'ok') {
          return `<a class="forward-link" href="http://127.0.0.1:${service.forwardLocalPort}" target="_blank" rel="noreferrer">${base}</a> <span class="forward-indicator ok" title="Forward active">✓</span>`;
        }
        if (service.forwardState === 'error') {
          const err = (service.forwardError || 'Forward failed').replace(/"/g, '&quot;');
          return `<span>${base}</span> <span class="forward-indicator error" title="${err}">✗</span>`;
        }
        return `<span>${base}</span> <span class="forward-indicator pending" title="Forward not active">…</span>`;
      })();
      const startDisabled = canStartService(service.status) ? '' : 'disabled';
      const stopDisabled = canStopService(service.status) ? '' : 'disabled';
      row.innerHTML = `
        <td class="table-cell">${service.name}</td>
        <td class="table-cell">${portText}</td>
        <td class="table-cell">
          <span class="status-indicator ${statusClass(service.status)}" title="${service.error ?? ''}">
            <span class="status-dot"></span>
            <span class="status-label">${service.status}</span>
          </span>
        </td>
        <td class="table-cell"><button class="btn btn-secondary btn-sm" data-action="pid" ${service.pid ? '' : 'disabled'}>${pidText}</button></td>
        <td class="table-cell">${updated}</td>
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
  }
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
  void window.serviceApi.openExternal(url);
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
    setMessage(`Imported private key from ${imported.path}`, 'success');
  } catch (error) {
    setMessage((error as Error).message, 'error');
  }
});

closeHostDialogButton.addEventListener('click', closeHostDialog);
cancelHostDialogButton.addEventListener('click', closeHostDialog);
resetButton.addEventListener('click', () => resetForm());
authTypeSelect.addEventListener('change', toggleAuthFields);
useJumpHostInput.addEventListener('change', toggleJumpSection);
jumpAuthTypeSelect.addEventListener('change', toggleJumpAuthFields);
closeServiceLogDialogButton.addEventListener('click', () => {
  stopLogAutoRefresh();
  serviceLogDialog.close();
  activeLogTarget = null;
});
serviceLogDialog.addEventListener('close', () => {
  stopLogAutoRefresh();
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
    setMessage(`Imported jump private key from ${imported.path}`, 'success');
  } catch (error) {
    setMessage((error as Error).message, 'error');
  }
});

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
    setMessage(hostDialogMode === 'create' ? 'Host created.' : 'Host updated.', 'success');
  } catch (error) {
    setMessage((error as Error).message, 'error');
  }
});

window.serviceApi.onServiceStatusChanged((change) => {
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
  render();

  if (activeLogTarget && activeLogTarget.hostId === change.hostId && activeLogTarget.serviceId === change.serviceId) {
    serviceLogTitle.textContent = `${host.name} / ${service.name} (PID: ${service.pid ?? '-'})`;
  }
});

window.serviceApi.onForwardStatusChanged((change) => {
  const host = hosts.find((item) => item.id === change.hostId);
  if (!host) return;
  const forward = host.forwards.find((item) => item.id === change.forwardId);
  if (!forward) return;

  forward.status = change.status;
  forward.error = change.error;
  forward.reconnectAt = change.reconnectAt;
  render();
});

window.serviceApi.onUpdateStateChanged((state) => {
  renderUpdateState(state);
});

(async function init() {
  resetForm();
  await loadHosts();
  await refreshAllServices(true);
  try {
    renderUpdateState(await window.serviceApi.getUpdateState());
  } catch {
    // no-op
  }
  startStatusAutoRefresh();
  setMessage('Ready.');
})();
