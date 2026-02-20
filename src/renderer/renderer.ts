import type { HostDraft, HostView, ServiceDraft, ServiceLogsResult, ServiceStatus } from '../shared/types';

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
const serviceEditorList = requireElement<HTMLDivElement>('#service-editor-list');
const addServiceButton = requireElement<HTMLButtonElement>('#add-service-btn');
const resetButton = requireElement<HTMLButtonElement>('#reset-btn');
const messageElement = requireElement<HTMLParagraphElement>('#message');
const addHostButton = requireElement<HTMLButtonElement>('#qa-add-host-btn');
const serviceTableBody = requireElement<HTMLTableSectionElement>('#service-table-body');
const statHostsElement = requireElement<HTMLElement>('#stat-hosts');
const statServicesElement = requireElement<HTMLElement>('#stat-services');
const statRunningElement = requireElement<HTMLElement>('#stat-running');
const statStoppedElement = requireElement<HTMLElement>('#stat-stopped');
const statErrorsElement = requireElement<HTMLElement>('#stat-errors');
const overviewHintElement = requireElement<HTMLElement>('#overview-hint');

const serviceLogDialog = requireElement<HTMLDialogElement>('#service-log-dialog');
const serviceLogTitle = requireElement<HTMLElement>('#service-log-title');
const closeServiceLogDialogButton = requireElement<HTMLButtonElement>('#close-service-log-dialog-btn');
const serviceLogTerminal = requireElement<HTMLDivElement>('#service-log-terminal');

let hosts: HostView[] = [];
let hostDialogMode: 'create' | 'edit' = 'create';
let editingPrivateKeyPath: string | undefined;
let activeLogTarget: { hostId: string; serviceId: string } | null = null;
let logAutoRefreshTimer: number | null = null;
let statusAutoRefreshTimer: number | null = null;
let isAutoRefreshing = false;

function setMessage(text: string, level: 'default' | 'success' | 'error' = 'default'): void {
  messageElement.classList.remove('message-default', 'message-success', 'message-error');
  messageElement.classList.add(
    level === 'success' ? 'message-success' : level === 'error' ? 'message-error' : 'message-default'
  );
  messageElement.textContent = text;
}

function statusClass(status: ServiceStatus): string {
  if (status === 'running') return 'status-running';
  if (status === 'error') return 'status-error';
  if (status === 'starting' || status === 'stopping') return 'status-transition';
  if (status === 'unknown') return 'status-transition';
  return 'status-stopped';
}

function canStart(status: ServiceStatus): boolean {
  return status === 'stopped' || status === 'error';
}

function canStop(status: ServiceStatus): boolean {
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
      <input class="input" data-field="port" type="number" min="1" max="65535" value="${draft?.port ?? ''}" required />
    </label>
    <label class="field field-xs">
      Forward Local Port
      <input class="input" data-field="forwardLocalPort" type="number" min="1" max="65535" value="${draft?.forwardLocalPort ?? ''}" />
    </label>
    <button type="button" class="btn btn-danger btn-sm forward-remove">Remove</button>
  `;

  row.querySelector<HTMLButtonElement>('.forward-remove')?.addEventListener('click', () => {
    row.remove();
  });

  return row;
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
  serviceEditorList.innerHTML = '';
  serviceEditorList.appendChild(createServiceEditorRow());
  toggleAuthFields();
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
    editingPrivateKeyPath = host.privateKeyPath;
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
    if (host.services.length === 0) {
      serviceEditorList.appendChild(createServiceEditorRow());
    }
  } else {
    hostDialogTitle.textContent = 'Add Host';
    resetForm();
  }

  toggleAuthFields();
  hostDialog.showModal();
}

function closeHostDialog(): void {
  hostDialog.close();
  setMessage('');
}

function updateOverview(): void {
  const services = hosts.flatMap((host) => host.services);
  statHostsElement.textContent = String(hosts.length);
  statServicesElement.textContent = String(services.length);
  statRunningElement.textContent = String(services.filter((service) => service.status === 'running').length);
  statStoppedElement.textContent = String(services.filter((service) => service.status === 'stopped').length);
  statErrorsElement.textContent = String(services.filter((service) => service.status === 'error').length);
  overviewHintElement.classList.toggle('hidden', hosts.length > 0);
}

async function loadHosts(): Promise<void> {
  hosts = await window.serviceApi.listHosts();
  render();
}

async function refreshService(hostId: string, serviceId: string): Promise<void> {
  try {
    await window.serviceApi.refreshService(hostId, serviceId);
  } catch (error) {
    setMessage((error as Error).message, 'error');
  }
}

async function refreshAllServices(silent = false): Promise<void> {
  if (isAutoRefreshing) return;
  isAutoRefreshing = true;
  try {
    for (const host of hosts) {
      for (const service of host.services) {
        try {
          await window.serviceApi.refreshService(host.id, service.id);
        } catch (error) {
          if (!silent) {
            setMessage((error as Error).message, 'error');
          }
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
  serviceLogTerminal.scrollTop = serviceLogTerminal.scrollHeight;
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

function render(): void {
  updateOverview();
  serviceTableBody.innerHTML = '';

  if (hosts.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td class="table-empty">No hosts or services configured.</td>`;
    serviceTableBody.appendChild(row);
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
            <div class="group-desc">${host.username}@${host.sshHost}:${host.sshPort}</div>
          </div>
          <div class="row-actions">
            <button class="btn btn-secondary btn-sm" data-action="edit-host">Edit Host</button>
            <button class="btn btn-danger btn-sm" data-action="delete-host">Delete Host</button>
          </div>
        </div>
      </td>
    `;
    serviceTableBody.appendChild(groupRow);

    const header = document.createElement('tr');
    header.className = 'host-rules-head';
    header.innerHTML = `
      <th>Service</th>
      <th>Port</th>
      <th>Status</th>
      <th>PID</th>
      <th>Updated</th>
      <th>Actions</th>
    `;
    serviceTableBody.appendChild(header);

    if (host.services.length === 0) {
      const empty = document.createElement('tr');
      empty.className = 'data-row';
      empty.innerHTML = `<td colspan="6" class="table-empty">No services under this host.</td>`;
      serviceTableBody.appendChild(empty);
    }

    for (const service of host.services) {
      const row = document.createElement('tr');
      row.className = 'data-row';
      const updated = service.updatedAt ? new Date(service.updatedAt).toLocaleString() : '-';
      const pidText = service.pid ? String(service.pid) : '-';
      const portText = service.forwardLocalPort ? `${service.forwardLocalPort} -> ${service.port}` : `${service.port}`;
      const startDisabled = canStart(service.status) ? '' : 'disabled';
      const stopDisabled = canStop(service.status) ? '' : 'disabled';
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

      serviceTableBody.appendChild(row);
    }

    groupRow.querySelector<HTMLButtonElement>('[data-action="edit-host"]')?.addEventListener('click', () => {
      openHostDialog('edit', host);
    });
    groupRow.querySelector<HTMLButtonElement>('[data-action="delete-host"]')?.addEventListener('click', async () => {
      await window.serviceApi.deleteHost(host.id);
      await loadHosts();
    });
  }
}

addHostButton.addEventListener('click', () => {
  openHostDialog('create');
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

window.serviceApi.onStatusChanged((change) => {
  const host = hosts.find((item) => item.id === change.hostId);
  if (!host) return;

  const service = host.services.find((item) => item.id === change.serviceId);
  if (!service) return;

  service.status = change.status;
  service.pid = change.pid;
  service.error = change.error;
  service.updatedAt = change.updatedAt;
  render();

  if (activeLogTarget && activeLogTarget.hostId === change.hostId && activeLogTarget.serviceId === change.serviceId) {
    serviceLogTitle.textContent = `${host.name} / ${service.name} (PID: ${service.pid ?? '-'})`;
  }
});

(async function init() {
  resetForm();
  await loadHosts();
  await refreshAllServices(true);
  startStatusAutoRefresh();
  setMessage('Ready.');
})();
