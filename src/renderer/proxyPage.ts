import type {
  ProxyCustomRule,
  ProxyCustomRuleDraft,
  ProxyExceptionType,
  ProxyGroupInfo,
  ProxyGroupOptionInfo,
  ProxyGroupsInfo,
  ProxyMode,
  ProxyRuleTarget,
  ProxyState,
  ProxyTraffic,
} from '../shared/types';
import { registerPage } from './nav.js';
import { haveSameProxyCustomRules, haveSameProxyGroupStructure } from './proxyGroupView.js';
import { setMessage } from './renderer.js';

const PROXY_NAV_ICON = `
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="8" cy="8" r="5.5"></circle>
    <path d="M2.5 8h11"></path>
    <path d="M8 2.5c1.8 1.5 2.7 3.3 2.7 5.5S9.8 12 8 13.5C6.2 12 5.3 10.2 5.3 8S6.2 4 8 2.5z"></path>
  </svg>
`;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const coreBadge = requireElement<HTMLElement>('#proxy-core-badge');
const statusBadge = requireElement<HTMLElement>('#proxy-status-badge');
const trafficReadout = requireElement<HTMLElement>('#proxy-traffic');
const toggleButton = requireElement<HTMLButtonElement>('#proxy-toggle-btn');
const logsButton = requireElement<HTMLButtonElement>('#proxy-logs-btn');
const downloadCoreButton = requireElement<HTMLButtonElement>('#proxy-download-core-btn');
const coreStatusLine = requireElement<HTMLElement>('#proxy-core-status');
const modeSeg = requireElement<HTMLElement>('#proxy-mode-seg');
const mixedPortInput = requireElement<HTMLInputElement>('#proxy-mixed-port');
const systemProxyToggle = requireElement<HTMLInputElement>('#proxy-system-toggle');
const tunToggle = requireElement<HTMLInputElement>('#proxy-tun-toggle');
const tunWarnButton = requireElement<HTMLButtonElement>('#proxy-tun-warn');
const tunInstallButton = requireElement<HTMLButtonElement>('#proxy-tun-install');
const tunRevokeButton = requireElement<HTMLButtonElement>('#proxy-tun-revoke');
const tunHint = requireElement<HTMLElement>('#proxy-tun-hint');
const subUrlInput = requireElement<HTMLInputElement>('#proxy-sub-url');
const saveSubButton = requireElement<HTMLButtonElement>('#proxy-save-sub-btn');
const subMetaLine = requireElement<HTMLElement>('#proxy-sub-meta');
const groupList = requireElement<HTMLDivElement>('#proxy-group-list');
const testNodesButton = requireElement<HTMLButtonElement>('#proxy-test-nodes-btn');
const exceptionForm = requireElement<HTMLFormElement>('#proxy-exception-form');
const exceptionTypeSelect = requireElement<HTMLSelectElement>('#proxy-exception-type');
const ruleTargetSelect = requireElement<HTMLSelectElement>('#proxy-rule-target');
const exceptionValueInput = requireElement<HTMLInputElement>('#proxy-exception-value');
const saveExceptionButton = requireElement<HTMLButtonElement>('#proxy-save-exception-btn');
const cancelExceptionButton = requireElement<HTMLButtonElement>('#proxy-cancel-exception-btn');
const exceptionList = requireElement<HTMLDivElement>('#proxy-exception-list');
const logDialog = requireElement<HTMLDialogElement>('#proxy-log-dialog');
const logAutoScroll = requireElement<HTMLInputElement>('#proxy-log-auto-scroll');
const closeLogDialogButton = requireElement<HTMLButtonElement>('#close-proxy-log-dialog-btn');
const logTerminal = requireElement<HTMLDivElement>('#proxy-log-terminal');
const logContent = requireElement<HTMLDivElement>('#proxy-log-content');

let currentState: ProxyState | null = null;
let logRefreshTimer: number | null = null;
let editingExceptionId: string | null = null;
let mixedPortDraft: string | null = null;
let isTestingNodes = false;
let isProxyPageActive = false;
let proxyPageGeneration = 0;
let renderedGroups: ProxyGroupsInfo | null = null;
let renderedExceptions: ProxyCustomRule[] | null = null;

interface RenderedProxyOption {
  button: HTMLButtonElement;
  marker: HTMLSpanElement;
  meta: HTMLSpanElement | null;
}

interface RenderedProxyGroup {
  current: HTMLSpanElement;
  options: Map<string, RenderedProxyOption>;
}

const renderedGroupElements = new Map<string, RenderedProxyGroup>();

const RULE_VALUE_PLACEHOLDERS: Record<ProxyExceptionType, string> = {
  DOMAIN: 'example.com',
  'DOMAIN-SUFFIX': 'example.com',
  'DOMAIN-KEYWORD': 'stream',
  'IP-CIDR': '203.0.113.0/24',
  'IP-CIDR6': '2001:db8::/32',
  'SRC-IP-CIDR': '10.0.0.0/8',
  GEOIP: 'CN',
  'DST-PORT': '443',
  'SRC-PORT': '443',
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

function formatTrafficRate(bytesPerSecond: number): string {
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let value = Math.max(0, Number.isFinite(bytesPerSecond) ? bytesPerSecond : 0);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const fractionDigits = unitIndex === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`;
}

function renderTraffic(traffic: ProxyTraffic | null): void {
  if (!isProxyPageActive) {
    return;
  }
  if (!traffic || currentState?.running !== 'running') {
    trafficReadout.textContent = '';
    trafficReadout.classList.add('hidden');
    return;
  }

  trafficReadout.textContent = `↓ ${formatTrafficRate(traffic.downBytesPerSecond)} · ↑ ${formatTrafficRate(traffic.upBytesPerSecond)}`;
  trafficReadout.classList.remove('hidden');
}

async function runAction(button: HTMLButtonElement | null, action: () => Promise<void>): Promise<void> {
  if (button) button.disabled = true;
  try {
    await action();
  } catch (error) {
    setMessage(toErrorMessage(error), 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

function renderState(state: ProxyState): void {
  if (!isProxyPageActive) {
    return;
  }
  currentState = state;

  // Header badges
  if (state.core.version) {
    coreBadge.textContent = `mihomo ${state.core.version}`;
    coreBadge.classList.remove('hidden');
  } else {
    coreBadge.classList.add('hidden');
  }

  statusBadge.textContent = state.running;
  statusBadge.className = `proxy-status-badge ${
    state.running === 'running'
      ? 'status-running'
      : state.running === 'error'
        ? 'status-error'
        : state.running === 'starting' || state.running === 'stopping'
          ? 'status-transition'
          : 'status-stopped'
  }`;

  const isRunning = state.running === 'running';
  testNodesButton.disabled = !isRunning || isTestingNodes;
  // Stop must stay clickable while running OR starting; only stopping (already
  // shutting down) and "not installed yet" disable the button.
  const showStop = state.running === 'running' || state.running === 'starting' || state.running === 'stopping';
  toggleButton.textContent = showStop ? 'Stop' : 'Start';
  toggleButton.disabled = state.running === 'stopping' || (!showStop && state.core.status !== 'installed');
  toggleButton.classList.toggle('btn-primary', !showStop);
  toggleButton.classList.toggle('btn-secondary', showStop);

  // Core card
  if (state.core.status === 'downloading') {
    const percent = state.core.downloadProgress ?? 0;
    coreStatusLine.textContent = `Downloading core... ${percent}%`;
    downloadCoreButton.disabled = true;
  } else if (state.core.status === 'installed') {
    coreStatusLine.textContent = `mihomo ${state.core.version ?? ''} installed${state.pid ? ` · PID ${state.pid}` : ''}`;
    downloadCoreButton.disabled = false;
    downloadCoreButton.innerHTML = '<span class="btn-label">Update Core</span>';
  } else {
    coreStatusLine.textContent = 'Core not installed. Download the mihomo core for this platform to get started.';
    downloadCoreButton.disabled = false;
    downloadCoreButton.innerHTML = '<span class="btn-label">Download Core</span>';
  }

  if (state.error) {
    coreStatusLine.textContent = `${coreStatusLine.textContent} · ${state.error}`;
  }

  // Controls
  for (const item of Array.from(modeSeg.querySelectorAll<HTMLButtonElement>('.seg-item'))) {
    item.classList.toggle('seg-item-active', item.dataset.mode === state.settings.mode);
  }
  const isMixedPortEditable = state.running === 'stopped' || state.running === 'error';
  mixedPortInput.disabled = !isMixedPortEditable;
  if (mixedPortDraft === null) {
    mixedPortInput.value = String(state.settings.mixedPort);
  }
  systemProxyToggle.checked = state.settings.systemProxyEnabled;
  tunToggle.checked = state.settings.tunEnabled;

  if (typeof state.settings.proxyCount === 'number' && state.settings.subscriptionUpdatedAt) {
    subMetaLine.textContent = `${state.settings.proxyCount} nodes · fetched ${new Date(
      state.settings.subscriptionUpdatedAt
    ).toLocaleString()}`;
  } else {
    subMetaLine.textContent = 'No subscription fetched yet.';
  }

  // TUN availability, mirroring clash-verge-rev: switch disabled when
  // unavailable, warning + grant icons shown; revoke icon when privileged.
  const tun = state.tunSupport;
  const tunAvailable = tun?.available ?? false;
  tunToggle.disabled = !tunAvailable;
  tunWarnButton.classList.toggle('hidden', tunAvailable);
  tunInstallButton.classList.toggle('hidden', tunAvailable);
  tunRevokeButton.classList.toggle('hidden', !(tun?.corePrivileged ?? false));
  tunWarnButton.title = tun?.hint ?? 'TUN mode is unavailable because the core lacks privileges.';
  tunInstallButton.title = 'Grant TUN privileges (an administrator password prompt will appear)';
  tunRevokeButton.title = 'Revoke TUN privileges';
  if (tunAvailable) {
    tunHint.textContent = tun?.isAdmin ? 'Available (running as admin)' : 'Available (core privileged)';
  } else {
    tunHint.textContent = tun?.hint ?? 'Requires elevated privileges';
  }

  if (!isRunning) {
    renderTraffic(null);
    clearRenderedGroups();
  }

  renderExceptions(state.settings.customRules ?? []);
}

function syncRuleValuePlaceholder(): void {
  exceptionValueInput.placeholder = RULE_VALUE_PLACEHOLDERS[exceptionTypeSelect.value as ProxyExceptionType];
}

function clearExceptionEditor(): void {
  editingExceptionId = null;
  exceptionTypeSelect.value = 'DOMAIN';
  ruleTargetSelect.value = 'PROXY';
  exceptionValueInput.value = '';
  syncRuleValuePlaceholder();
  saveExceptionButton.textContent = 'Add Custom Rule';
  cancelExceptionButton.classList.add('hidden');
}

function startEditingException(exception: ProxyCustomRule): void {
  editingExceptionId = exception.id;
  exceptionTypeSelect.value = exception.type;
  ruleTargetSelect.value = exception.target ?? 'DIRECT';
  exceptionValueInput.value = exception.value;
  syncRuleValuePlaceholder();
  saveExceptionButton.textContent = 'Save Custom Rule';
  cancelExceptionButton.classList.remove('hidden');
  exceptionValueInput.focus();
}

function renderExceptions(exceptions: ProxyCustomRule[]): void {
  if (haveSameProxyCustomRules(renderedExceptions, exceptions)) {
    return;
  }

  renderedExceptions = exceptions.map((exception) => ({ ...exception }));
  exceptionList.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const exception of exceptions) {
    const row = document.createElement('div');
    row.className = 'proxy-exception-row';
    row.setAttribute('role', 'listitem');
    row.dataset.exceptionId = exception.id;

    const type = document.createElement('span');
    type.className = 'proxy-exception-type';
    type.append(document.createTextNode(exception.type));

    const target = document.createElement('span');
    target.className = 'proxy-exception-type';
    target.append(document.createTextNode(exception.target));

    const value = document.createElement('span');
    value.className = 'proxy-exception-value';
    value.append(document.createTextNode(exception.value));

    const actions = document.createElement('div');
    actions.className = 'proxy-exception-actions';
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'btn btn-secondary btn-sm';
    editButton.textContent = 'Edit';
    editButton.setAttribute('aria-label', 'Edit custom rule');
    editButton.dataset.exceptionAction = 'edit';

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn-danger btn-sm';
    deleteButton.textContent = 'Delete';
    deleteButton.setAttribute('aria-label', 'Delete custom rule');
    deleteButton.dataset.exceptionAction = 'delete';

    actions.append(editButton, deleteButton);
    row.append(type, target, value, actions);
    fragment.appendChild(row);
  }
  exceptionList.appendChild(fragment);
}

function updateProxyOptionMeta(
  renderedOption: RenderedProxyOption,
  option: ProxyGroupOptionInfo
): void {
  let text = '';
  let unavailable = false;
  if (option.delayStatus === 'unavailable') {
    text = 'Unavailable';
    unavailable = true;
  } else if (typeof option.delayMs === 'number') {
    text = `${option.delayMs}ms`;
  }

  if (!text) {
    renderedOption.meta?.remove();
    renderedOption.meta = null;
    return;
  }

  if (!renderedOption.meta) {
    renderedOption.meta = document.createElement('span');
    renderedOption.meta.className = 'proxy-node-meta';
    renderedOption.button.appendChild(renderedOption.meta);
  }
  renderedOption.meta.classList.toggle('proxy-node-meta-unavailable', unavailable);
  renderedOption.meta.textContent = text;
}

function patchRenderedGroup(group: ProxyGroupInfo, renderedGroup: RenderedProxyGroup): void {
  renderedGroup.current.textContent = group.now ? `Current: ${group.now}` : 'No current candidate';
  for (const option of group.options) {
    const renderedOption = renderedGroup.options.get(option.name);
    if (!renderedOption) {
      continue;
    }
    const isActive = option.name === group.now;
    renderedOption.button.classList.toggle('proxy-node-active', isActive);
    renderedOption.marker.textContent = isActive ? '●' : '○';
    updateProxyOptionMeta(renderedOption, option);
  }
}

function patchRenderedGroups(data: ProxyGroupsInfo): void {
  for (const group of data.groups) {
    const renderedGroup = renderedGroupElements.get(group.name);
    if (renderedGroup) {
      patchRenderedGroup(group, renderedGroup);
    }
  }
}

function clearRenderedGroups(): void {
  renderedGroups = null;
  renderedGroupElements.clear();
  groupList.replaceChildren();
}

function rebuildGroups(data: ProxyGroupsInfo): void {
  renderedGroupElements.clear();
  const fragment = document.createDocumentFragment();
  for (const group of data.groups) {
    const section = document.createElement('section');
    section.className = 'proxy-strategy-group';
    const heading = document.createElement('div');
    heading.className = 'proxy-strategy-head';
    const name = document.createElement('span');
    name.className = 'proxy-strategy-name';
    name.textContent = group.name;
    const current = document.createElement('span');
    current.className = 'proxy-strategy-current';
    current.textContent = group.now ? `Current: ${group.now}` : 'No current candidate';
    heading.append(name, current);

    const options = document.createElement('div');
    options.className = 'proxy-node-list';
    const optionElements = new Map<string, RenderedProxyOption>();
    for (const option of group.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `proxy-node${option.name === group.now ? ' proxy-node-active' : ''}`;
      button.dataset.proxyGroup = group.name;
      button.dataset.proxyOption = option.name;
      const marker = document.createElement('span');
      marker.className = 'proxy-node-marker';
      marker.textContent = option.name === group.now ? '●' : '○';
      const optionName = document.createElement('span');
      optionName.className = 'proxy-node-name';
      optionName.textContent = option.name;
      const type = document.createElement('span');
      type.className = 'proxy-node-type';
      type.textContent = option.type;
      const meta = document.createElement('span');
      meta.className = 'proxy-node-meta';
      if (option.delayStatus === 'unavailable') {
        meta.classList.add('proxy-node-meta-unavailable');
        meta.textContent = 'Unavailable';
      } else if (typeof option.delayMs === 'number') {
        meta.textContent = `${option.delayMs}ms`;
      }
      button.append(marker, optionName, type);
      if (meta.textContent) {
        button.appendChild(meta);
      }
      optionElements.set(option.name, {
        button,
        marker,
        meta: meta.textContent ? meta : null,
      });
      options.appendChild(button);
    }
    section.append(heading, options);
    fragment.appendChild(section);
    renderedGroupElements.set(group.name, {
      current,
      options: optionElements,
    });
  }
  groupList.replaceChildren(fragment);
}

function renderGroups(data: ProxyGroupsInfo): void {
  if (!isProxyPageActive) {
    return;
  }
  if (haveSameProxyGroupStructure(renderedGroups, data)) {
    patchRenderedGroups(data);
  } else {
    rebuildGroups(data);
  }
  renderedGroups = data;
}

async function refreshGroups(generation = proxyPageGeneration): Promise<void> {
  if (!currentState || currentState.running !== 'running') {
    return;
  }
  try {
    const groups = await window.proxyApi.listProxies();
    if (isProxyPageActive && generation === proxyPageGeneration) {
      renderGroups(groups);
    }
  } catch (error) {
    if (isProxyPageActive && generation === proxyPageGeneration) {
      setMessage(toErrorMessage(error), 'error');
    }
  }
}

async function refreshState(generation = proxyPageGeneration): Promise<boolean> {
  try {
    const state = await window.proxyApi.getState();
    if (!isProxyPageActive || generation !== proxyPageGeneration) {
      return false;
    }
    renderState(state);
    return true;
  } catch (error) {
    if (isProxyPageActive && generation === proxyPageGeneration) {
      setMessage(toErrorMessage(error), 'error');
    }
    return false;
  }
}

function renderLogs(text: string): void {
  const previousScrollTop = logTerminal.scrollTop;
  logContent.textContent = text || 'No logs yet.';
  if (logAutoScroll.checked) {
    logTerminal.scrollTop = logTerminal.scrollHeight;
  } else {
    logTerminal.scrollTop = previousScrollTop;
  }
}

async function loadLogs(): Promise<void> {
  try {
    renderLogs(await window.proxyApi.getProxyLogs());
  } catch (error) {
    renderLogs(`Unable to load logs: ${toErrorMessage(error)}`);
  }
}

function stopLogRefresh(): void {
  if (logRefreshTimer !== null) {
    window.clearInterval(logRefreshTimer);
    logRefreshTimer = null;
  }
}

function openLogDialog(): void {
  if (logDialog.open) return;
  logContent.textContent = '';
  void loadLogs();
  stopLogRefresh();
  logRefreshTimer = window.setInterval(() => void loadLogs(), 1500);
  logDialog.showModal();
}

function closeLogDialog(): void {
  stopLogRefresh();
  if (logDialog.open) {
    logDialog.close();
  }
}

function bindEvents(): void {
  groupList.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button.proxy-node');
    const groupName = button?.dataset.proxyGroup;
    const optionName = button?.dataset.proxyOption;
    if (!button || !groupName || !optionName) {
      return;
    }
    void runAction(button, async () => {
      renderState(await window.proxyApi.selectProxy(groupName, optionName));
      await refreshGroups();
      setMessage(`${groupName} switched to ${optionName}`, 'success');
    });
  });

  exceptionList.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-exception-action]');
    const row = button?.closest<HTMLElement>('[data-exception-id]');
    const exceptionId = row?.dataset.exceptionId;
    const action = button?.dataset.exceptionAction;
    const exception = currentState?.settings.customRules?.find((item) => item.id === exceptionId);
    if (!button || !exceptionId || !action || !exception) {
      return;
    }
    if (action === 'edit') {
      startEditingException(exception);
      return;
    }
    if (action === 'delete') {
      void runAction(button, async () => {
        const state = await window.proxyApi.deleteException(exceptionId);
        renderState(state);
        clearExceptionEditor();
        if (state.running === 'running') {
          await refreshGroups();
        }
        setMessage('Custom rule deleted.', 'success');
      });
    }
  });

  toggleButton.addEventListener('click', () => {
    void runAction(toggleButton, async () => {
      const state = currentState;
      if (state && (state.running === 'running' || state.running === 'starting')) {
        renderState(await window.proxyApi.stopProxy());
        setMessage('Proxy stopped.', 'success');
      } else {
        const port = Number(mixedPortInput.value);
        const state = await window.proxyApi.startProxy(port);
        mixedPortDraft = null;
        renderState(state);
        setMessage('Proxy started.', 'success');
        await refreshGroups();
      }
    });
  });

  downloadCoreButton.addEventListener('click', () => {
    void runAction(downloadCoreButton, async () => {
      renderState(await window.proxyApi.downloadCore());
      setMessage('mihomo core downloaded.', 'success');
    });
  });

  modeSeg.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>('.seg-item');
    const mode = item?.dataset.mode as ProxyMode | undefined;
    if (!item || !mode) return;
    void runAction(item, async () => {
      renderState(await window.proxyApi.setMode(mode));
    });
  });

  mixedPortInput.addEventListener('input', () => {
    mixedPortDraft = mixedPortInput.value;
  });

  systemProxyToggle.addEventListener('change', () => {
    const enabled = systemProxyToggle.checked;
    void runAction(null, async () => {
      try {
        renderState(await window.proxyApi.setSystemProxy(enabled));
        setMessage(enabled ? 'System proxy enabled.' : 'System proxy disabled.', 'success');
      } catch (error) {
        systemProxyToggle.checked = !enabled;
        throw error;
      }
    });
  });

  tunToggle.addEventListener('change', () => {
    const enabled = tunToggle.checked;
    void runAction(null, async () => {
      try {
        renderState(await window.proxyApi.setTun(enabled));
        await refreshGroups();
        setMessage(
          enabled ? 'TUN mode enabled. mihomo may require admin/root privileges.' : 'TUN mode disabled.',
          'success'
        );
      } catch (error) {
        tunToggle.checked = !enabled;
        throw error;
      }
    });
  });

  tunWarnButton.addEventListener('click', () => {
    setMessage(tunWarnButton.title, 'error');
  });

  tunInstallButton.addEventListener('click', () => {
    void runAction(tunInstallButton, async () => {
      const ok = await window.serviceApi.confirmAction({
        title: 'Grant TUN Privileges',
        message: 'Grant TUN privileges to the Mihomo core?',
        detail:
          'The system will request an administrator password. This allows the core to create a virtual network adapter. Downloading a replacement core requires granting this permission again.',
        kind: 'question',
        confirmLabel: 'Grant',
        cancelLabel: 'Cancel',
      });
      if (!ok) return;
      renderState(await window.proxyApi.grantTunPermission());
      setMessage('TUN privileges granted.', 'success');
    });
  });

  tunRevokeButton.addEventListener('click', () => {
    void runAction(tunRevokeButton, async () => {
      const ok = await window.serviceApi.confirmAction({
        title: 'Revoke TUN Privileges',
        message: 'Revoke the Mihomo core TUN privileges?',
        detail: 'TUN mode will be turned off and unavailable until the permission is granted again.',
        kind: 'warning',
        confirmLabel: 'Revoke',
        cancelLabel: 'Cancel',
      });
      if (!ok) return;
      renderState(await window.proxyApi.revokeTunPermission());
      setMessage('TUN privileges revoked.', 'success');
    });
  });

  saveSubButton.addEventListener('click', () => {
    void runAction(saveSubButton, async () => {
      const state = await window.proxyApi.saveAndFetchSubscription(subUrlInput.value);
      renderState(state);
      subUrlInput.value = '';
      if (state.running === 'running') {
        clearRenderedGroups();
        await refreshGroups();
      }
      setMessage(
        state.running === 'running'
          ? 'Subscription fetched. Restart the proxy manually to apply it.'
          : 'Subscription fetched and cached. Start the proxy to browse strategy groups.',
        'success'
      );
    });
  });

  testNodesButton.addEventListener('click', () => {
    if (isTestingNodes) return;
    isTestingNodes = true;
    testNodesButton.textContent = 'Testing…';
    void runAction(testNodesButton, async () => {
      try {
        renderGroups(await window.proxyApi.testProxyDelays());
        setMessage('Node delay test complete.', 'success');
      } finally {
        testNodesButton.textContent = 'Test Nodes';
      }
    }).finally(() => {
      isTestingNodes = false;
      testNodesButton.disabled = currentState?.running !== 'running';
    });
  });

  exceptionForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void runAction(saveExceptionButton, async () => {
      const exceptionId = editingExceptionId;
      const draft: ProxyCustomRuleDraft = {
        type: exceptionTypeSelect.value as ProxyExceptionType,
        target: ruleTargetSelect.value as ProxyRuleTarget,
        value: exceptionValueInput.value,
      };
      const state = exceptionId
        ? await window.proxyApi.updateException(exceptionId, draft)
        : await window.proxyApi.addException(draft);
      renderState(state);
      clearExceptionEditor();
      if (state.running === 'running') {
        await refreshGroups();
      }
      setMessage(exceptionId ? 'Custom rule saved.' : 'Custom rule added.', 'success');
    });
  });

  cancelExceptionButton.addEventListener('click', clearExceptionEditor);
  exceptionTypeSelect.addEventListener('change', syncRuleValuePlaceholder);

  logsButton.addEventListener('click', openLogDialog);
  closeLogDialogButton.addEventListener('click', closeLogDialog);
  logDialog.addEventListener('close', stopLogRefresh);

  window.proxyApi.onProxyStateChanged((state) => {
    if (isProxyPageActive) {
      renderState(state);
    }
  });
  window.proxyApi.onProxyTrafficChanged(renderTraffic);
}

export function registerProxyPage(): void {
  clearExceptionEditor();
  bindEvents();
  registerPage({
    id: 'proxy',
    title: 'Proxy',
    icon: PROXY_NAV_ICON,
    onShow: () => {
      isProxyPageActive = true;
      const generation = ++proxyPageGeneration;
      void refreshState(generation).then((refreshed) => {
        if (refreshed) {
          return refreshGroups(generation);
        }
        return undefined;
      });
    },
    onHide: () => {
      isProxyPageActive = false;
      proxyPageGeneration += 1;
      closeLogDialog();
      currentState = null;
      renderedExceptions = null;
      exceptionList.replaceChildren();
      clearRenderedGroups();
    },
  });
}
