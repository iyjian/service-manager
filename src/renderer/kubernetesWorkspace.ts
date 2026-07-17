import type {
  KubernetesLogScope,
  KubernetesLogState,
  KubernetesPodTarget,
  KubernetesTerminalOutput,
  KubernetesTerminalState,
} from '../shared/types';
import { createKubernetesTerminalPane } from './kubernetesTerminal.js';

export type KubernetesWorkspaceTabType = 'logs' | 'shell';

export interface KubernetesWorkspaceTab {
  /** Unique local instance ID; a reopened key always receives a new ID. */
  id: string;
  key: string;
  type: KubernetesWorkspaceTabType;
  target: KubernetesPodTarget;
  log?: KubernetesLogState;
  terminalId?: string;
  logSearch: string;
  closed: boolean;
}

export interface KubernetesWorkspaceState {
  open(type: KubernetesWorkspaceTabType, target: KubernetesPodTarget): { tab: KubernetesWorkspaceTab; created: boolean };
  tab(tabId: string): KubernetesWorkspaceTab | undefined;
  close(tabId: string): boolean;
  bindLog(tabId: string, log: KubernetesLogState): boolean;
  bindTerminal(tabId: string, terminalId: string): boolean;
  routeTerminalFinal(state: Pick<KubernetesTerminalState, 'id' | 'state'>): boolean;
  applyLog(state: KubernetesLogState): boolean;
  logForSession(sessionId: string): KubernetesLogState | undefined;
  tabIdForLogSession(sessionId: string): string | undefined;
  tabIdForTerminal(id: string): string | undefined;
  setLogSearch(tabId: string, search: string): boolean;
  tabs(): KubernetesWorkspaceTab[];
}

export interface KubernetesWorkspace {
  openLogs(target: KubernetesPodTarget): Promise<void>;
  openShell(target: KubernetesPodTarget): Promise<void>;
  onLogChanged(state: KubernetesLogState): void;
  onTerminalChanged(state: KubernetesTerminalState): void;
  onTerminalOutput(output: KubernetesTerminalOutput): void;
  dispose(): Promise<void>;
}

export interface KubernetesWorkspaceOptions {
  root: HTMLElement;
  resizeHandle?: HTMLElement;
  tabList: HTMLElement;
  pane: HTMLElement;
  openLogs(target: KubernetesPodTarget): Promise<KubernetesLogState>;
  setLogScope(id: string, scope: KubernetesLogScope): Promise<KubernetesLogState>;
  setLogStartTime(id: string, startTime: string): Promise<KubernetesLogState>;
  setLogFollowing(id: string, following: boolean): Promise<KubernetesLogState>;
  clearLogs(id: string): Promise<KubernetesLogState>;
  closeLogs(id: string): Promise<void>;
  openTerminal(target: KubernetesPodTarget): Promise<KubernetesTerminalState>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  reportError(error: unknown): void;
}

interface KubernetesWorkspaceFollowIntent {
  following: boolean;
  revision: number;
}

interface KubernetesWorkspaceScopeIntent {
  scope: KubernetesLogScope;
  revision: number;
}

interface KubernetesWorkspaceStartTimeIntent {
  startTime?: string;
  revision: number;
}

type KubernetesWorkspaceScrollIntent = 'none' | 'follow';

const MAX_PENDING_TERMINAL_OUTPUT_CHARACTERS = 64 * 1024;
const MAX_PENDING_TERMINAL_OUTPUT_CHUNKS = 256;
const KUBERNETES_WORKSPACE_MIN_HEIGHT = 120;
const KUBERNETES_WORKSPACE_MAX_HEIGHT_RATIO = 0.8;
const KUBERNETES_WORKSPACE_KEYBOARD_STEP = 20;
const KUBERNETES_SHELL_DEFAULT_HEIGHT_RATIO = 0.5;

export function clampKubernetesWorkspaceHeight(requestedHeight: number, pageHeight: number): number {
  const safePageHeight = Number.isFinite(pageHeight) ? Math.max(0, pageHeight) : 0;
  const maximum = Math.floor(safePageHeight * KUBERNETES_WORKSPACE_MAX_HEIGHT_RATIO);
  const minimum = Math.min(KUBERNETES_WORKSPACE_MIN_HEIGHT, maximum);
  const requested = Number.isFinite(requestedHeight) ? Math.round(requestedHeight) : minimum;
  return Math.min(maximum, Math.max(minimum, requested));
}

export function kubernetesWorkspaceTabKey(type: KubernetesWorkspaceTabType, target: KubernetesPodTarget): string {
  return [type, target.namespace, target.podName, target.container].join('\u0000');
}

function padLogDatePart(value: number): string {
  return String(value).padStart(2, '0');
}

/** Formats an RFC3339 value for a local, second-precision datetime input. */
export function kubernetesLogStartTimeInputValue(startTime?: string): string {
  if (!startTime) return '';
  const date = new Date(startTime);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${padLogDatePart(date.getMonth() + 1)}-${padLogDatePart(date.getDate())}`
    + `T${padLogDatePart(date.getHours())}:${padLogDatePart(date.getMinutes())}:${padLogDatePart(date.getSeconds())}`;
}

/** Converts a datetime-local value to the only timestamp shape sent over IPC. */
export function kubernetesLogStartTimeIso(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function copyTarget(target: KubernetesPodTarget): KubernetesPodTarget {
  return { ...target };
}

function copyLog(log: KubernetesLogState): KubernetesLogState {
  return {
    ...log,
    lines: [...log.lines],
    ...(log.deployment ? { deployment: { ...log.deployment } } : {}),
  };
}

function copyTab(tab: KubernetesWorkspaceTab): KubernetesWorkspaceTab {
  return {
    ...tab,
    target: copyTarget(tab.target),
    ...(tab.log ? { log: copyLog(tab.log) } : {}),
  };
}

function sameTarget(left: KubernetesPodTarget, right: KubernetesPodTarget): boolean {
  return left.namespace === right.namespace
    && left.podName === right.podName
    && left.container === right.container;
}

function isTerminalFinal(state: Pick<KubernetesTerminalState, 'state'>): boolean {
  return state.state === 'closed' || state.state === 'error';
}

function tabLabel(tab: Pick<KubernetesWorkspaceTab, 'type' | 'target'>): string {
  const type = tab.type === 'logs' ? 'Logs' : 'Shell';
  return `${type} ${tabTargetCaption(tab)}`;
}

function tabTargetCaption(tab: Pick<KubernetesWorkspaceTab, 'target'>): string {
  return `${tab.target.namespace}/${tab.target.podName} · ${tab.target.container}`;
}

function createWorkspaceCloseIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm5 5 6 6m0-6-6 6');
  svg.appendChild(path);
  return svg;
}

function terminalStateMatchesTarget(state: KubernetesTerminalState, target: KubernetesPodTarget): boolean {
  return state.namespace === target.namespace
    && state.podName === target.podName
    && state.container === target.container;
}

/**
 * Owns only the pure, target/session mapping rules. UI selection and remote
 * lifecycle work remain in the controller below. A local tab instance ID is
 * deliberately distinct from its reusable target key, which prevents an old
 * asynchronous open result from attaching to a reopened tab.
 */
export function createKubernetesWorkspaceState(): KubernetesWorkspaceState {
  const tabsById = new Map<string, KubernetesWorkspaceTab>();
  const tabIdByKey = new Map<string, string>();
  const tabIdByLogSession = new Map<string, string>();
  const tabIdByTerminal = new Map<string, string>();
  let nextTabId = 0;

  const current = (tabId: string): KubernetesWorkspaceTab | undefined => {
    const tab = tabsById.get(tabId);
    return tab && !tab.closed ? tab : undefined;
  };

  const releaseLog = (tab: KubernetesWorkspaceTab): void => {
    if (tab.log && tabIdByLogSession.get(tab.log.sessionId) === tab.id) {
      tabIdByLogSession.delete(tab.log.sessionId);
    }
  };

  const releaseTerminal = (tab: KubernetesWorkspaceTab): void => {
    if (tab.terminalId && tabIdByTerminal.get(tab.terminalId) === tab.id) {
      tabIdByTerminal.delete(tab.terminalId);
    }
  };

  return {
    open(type, target) {
      const key = kubernetesWorkspaceTabKey(type, target);
      const existingId = tabIdByKey.get(key);
      const existing = existingId ? current(existingId) : undefined;
      if (existing) return { tab: copyTab(existing), created: false };
      if (existingId) tabIdByKey.delete(key);

      const tab: KubernetesWorkspaceTab = {
        id: `kubernetes-workspace-tab-${++nextTabId}`,
        key,
        type,
        target: copyTarget(target),
        logSearch: '',
        closed: false,
      };
      tabsById.set(tab.id, tab);
      tabIdByKey.set(key, tab.id);
      return { tab: copyTab(tab), created: true };
    },

    tab(tabId) {
      const value = current(tabId);
      return value ? copyTab(value) : undefined;
    },

    close(tabId) {
      const tab = current(tabId);
      if (!tab) return false;
      tab.closed = true;
      tabsById.delete(tab.id);
      if (tabIdByKey.get(tab.key) === tab.id) tabIdByKey.delete(tab.key);
      releaseLog(tab);
      releaseTerminal(tab);
      return true;
    },

    bindLog(tabId, log) {
      const tab = current(tabId);
      if (!tab || tab.type !== 'logs' || !sameTarget(tab.target, log)) return false;
      const ownerId = tabIdByLogSession.get(log.sessionId);
      if (ownerId && ownerId !== tab.id) return false;
      if (tab.log?.sessionId === log.sessionId && log.revision < tab.log.revision) return false;
      releaseLog(tab);
      tab.log = copyLog(log);
      tabIdByLogSession.set(log.sessionId, tab.id);
      return true;
    },

    bindTerminal(tabId, terminalId) {
      const tab = current(tabId);
      if (!tab || tab.type !== 'shell') return false;
      const ownerId = tabIdByTerminal.get(terminalId);
      if (ownerId && ownerId !== tab.id) return false;
      releaseTerminal(tab);
      tab.terminalId = terminalId;
      tabIdByTerminal.set(terminalId, tab.id);
      return true;
    },

    routeTerminalFinal(state) {
      if (!isTerminalFinal(state)) return false;
      const tabId = tabIdByTerminal.get(state.id);
      const tab = tabId ? current(tabId) : undefined;
      return Boolean(tab && tab.type === 'shell' && tab.terminalId === state.id);
    },

    applyLog(state) {
      const tabId = tabIdByLogSession.get(state.sessionId);
      const tab = tabId ? current(tabId) : undefined;
      if (!tab || tab.type !== 'logs' || !tab.log || tab.log.sessionId !== state.sessionId) return false;
      if (!sameTarget(tab.target, state) || state.revision < tab.log.revision) return false;
      tab.log = copyLog(state);
      return true;
    },

    logForSession(sessionId) {
      const tabId = tabIdByLogSession.get(sessionId);
      const tab = tabId ? current(tabId) : undefined;
      return tab?.log?.sessionId === sessionId ? copyLog(tab.log) : undefined;
    },

    tabIdForLogSession(sessionId) {
      const tabId = tabIdByLogSession.get(sessionId);
      return tabId && current(tabId) ? tabId : undefined;
    },

    tabIdForTerminal(id) {
      const tabId = tabIdByTerminal.get(id);
      return tabId && current(tabId) ? tabId : undefined;
    },

    setLogSearch(tabId, search) {
      const tab = current(tabId);
      if (!tab || tab.type !== 'logs') return false;
      tab.logSearch = search;
      return true;
    },

    tabs() {
      return [...tabsById.values()].filter((tab) => !tab.closed).map(copyTab);
    },
  };
}

/**
 * A direct, UI-free cleanup seam. It deliberately deduplicates IDs before
 * starting close requests and suppresses close failures during page teardown.
 */
export async function disposeKubernetesWorkspaceSessions(
  tabs: Array<Pick<KubernetesWorkspaceTab, 'type' | 'log' | 'terminalId'>>,
  close: {
    closeLogs(id: string): Promise<void>;
    closeTerminal(id: string): Promise<void>;
  },
): Promise<void> {
  const logIds = new Set(tabs.flatMap((tab) => tab.type === 'logs' && tab.log ? [tab.log.sessionId] : []));
  const terminalIds = new Set(tabs.flatMap((tab) => tab.type === 'shell' && tab.terminalId ? [tab.terminalId] : []));
  await Promise.all([
    ...[...logIds].map((id) => close.closeLogs(id).catch(() => undefined)),
    ...[...terminalIds].map((id) => close.closeTerminal(id).catch(() => undefined)),
  ]);
}

/**
 * The only live Logs/Shell owner for the Kubernetes page. It never creates a
 * global drawer; its selected xterm host lives inside the supplied workspace
 * pane, while background remote sessions retain their exact local xterm view
 * and remain represented by their tabs.
 */
export function createKubernetesWorkspace(options: KubernetesWorkspaceOptions): KubernetesWorkspace {
  const state = createKubernetesWorkspaceState();
  const terminalStates = new Map<string, KubernetesTerminalState>();
  const terminalFinalIds = new Set<string>();
  const openingTerminalTabIds = new Set<string>();
  const pendingTerminalOutputs = new Map<string, string[]>();
  const followRequests = new Map<string, symbol>();
  const followIntents = new Map<string, KubernetesWorkspaceFollowIntent>();
  const scopeRequests = new Map<string, symbol>();
  const scopeIntents = new Map<string, KubernetesWorkspaceScopeIntent>();
  const startTimeRequests = new Map<string, symbol>();
  const startTimeIntents = new Map<string, KubernetesWorkspaceStartTimeIntent>();
  const logScrollTops = new Map<string, number>();
  const renderedLogOutputs = new Map<string, HTMLPreElement>();
  const remotelyClosedLogIds = new Set<string>();
  const remotelyClosedTerminalIds = new Set<string>();
  const terminalPane = createKubernetesTerminalPane({
    onInput: (id, data) => options.writeTerminal(id, data),
    onResize: (id, cols, rows) => options.resizeTerminal(id, cols, rows),
  });
  let selectedTabId: string | undefined;
  let mountedTerminalTabId: string | undefined;
  let mountedTerminalId: string | undefined;
  let mountedTerminalHost: HTMLElement | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let autoScrollFrame: number | undefined;
  let autoScrollKey: string | undefined;
  let preserveScrollFrame: number | undefined;
  let preserveScrollTabId: string | undefined;
  let pendingTerminalOutputCharacters = 0;
  let pendingTerminalOutputChunks = 0;
  let workspaceResizeFrame: number | undefined;
  let workspaceResizeDrag: { pointerId: number; startY: number; startHeight: number } | undefined;

  const workspacePageHeight = (): number => {
    const parentHeight = options.root.parentElement?.clientHeight ?? 0;
    return parentHeight > 0 ? parentHeight : window.innerHeight;
  };

  const workspaceHeightBounds = (): { minimum: number; maximum: number } => {
    const maximum = Math.floor(Math.max(0, workspacePageHeight()) * KUBERNETES_WORKSPACE_MAX_HEIGHT_RATIO);
    return { minimum: Math.min(KUBERNETES_WORKSPACE_MIN_HEIGHT, maximum), maximum };
  };

  const scheduleTerminalResize = (): void => {
    if (workspaceResizeFrame !== undefined) return;
    workspaceResizeFrame = window.requestAnimationFrame(() => {
      workspaceResizeFrame = undefined;
      terminalPane.resizeActive();
    });
  };

  const applyWorkspaceHeight = (requestedHeight: number, resizeTerminal = true): void => {
    const pageHeight = workspacePageHeight();
    const height = clampKubernetesWorkspaceHeight(requestedHeight, pageHeight);
    const bounds = workspaceHeightBounds();
    options.root.style.maxHeight = `${bounds.maximum}px`;
    options.root.style.height = `${height}px`;
    options.resizeHandle?.setAttribute('aria-valuemin', String(bounds.minimum));
    options.resizeHandle?.setAttribute('aria-valuemax', String(bounds.maximum));
    options.resizeHandle?.setAttribute('aria-valuenow', String(height));
    if (resizeTerminal) scheduleTerminalResize();
  };

  const finishWorkspaceResize = (pointerId?: number, releaseCapture = true): void => {
    const drag = workspaceResizeDrag;
    if (!drag || (pointerId !== undefined && pointerId !== drag.pointerId)) return;
    workspaceResizeDrag = undefined;
    options.root.classList.remove('kubernetes-workspace-resizing');
    const handle = options.resizeHandle;
    if (releaseCapture && handle?.hasPointerCapture(drag.pointerId)) {
      try {
        handle.releasePointerCapture(drag.pointerId);
      } catch {
        // Pointer capture can already be gone after a native cancellation.
      }
    }
  };

  const onWorkspaceResizePointerDown = (event: PointerEvent): void => {
    if (disposed || event.button !== 0 || event.isPrimary === false) return;
    finishWorkspaceResize();
    const currentHeight = options.root.getBoundingClientRect().height;
    workspaceResizeDrag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: clampKubernetesWorkspaceHeight(currentHeight, workspacePageHeight()),
    };
    options.root.classList.add('kubernetes-workspace-resizing');
    options.resizeHandle?.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onWorkspaceResizePointerMove = (event: PointerEvent): void => {
    const drag = workspaceResizeDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    applyWorkspaceHeight(drag.startHeight + drag.startY - event.clientY);
    event.preventDefault();
  };

  const onWorkspaceResizePointerEnd = (event: PointerEvent): void => {
    finishWorkspaceResize(event.pointerId);
  };

  const onWorkspaceResizeLostCapture = (event: PointerEvent): void => {
    finishWorkspaceResize(event.pointerId, false);
  };

  const onWorkspaceResizeKeyDown = (event: KeyboardEvent): void => {
    const currentHeight = options.root.getBoundingClientRect().height;
    const { minimum, maximum } = workspaceHeightBounds();
    let requested: number | undefined;
    if (event.key === 'ArrowUp') requested = currentHeight + KUBERNETES_WORKSPACE_KEYBOARD_STEP;
    if (event.key === 'ArrowDown') requested = currentHeight - KUBERNETES_WORKSPACE_KEYBOARD_STEP;
    if (event.key === 'Home') requested = minimum;
    if (event.key === 'End') requested = maximum;
    if (requested === undefined) return;
    applyWorkspaceHeight(requested);
    event.preventDefault();
  };

  const syncWorkspaceResizeAttributes = (): void => {
    const handle = options.resizeHandle;
    if (!handle) return;
    const { minimum, maximum } = workspaceHeightBounds();
    const currentHeight = clampKubernetesWorkspaceHeight(options.root.getBoundingClientRect().height, workspacePageHeight());
    options.root.style.maxHeight = `${maximum}px`;
    handle.setAttribute('aria-valuemin', String(minimum));
    handle.setAttribute('aria-valuemax', String(maximum));
    handle.setAttribute('aria-valuenow', String(currentHeight));
  };

  const onWorkspaceWindowResize = (): void => {
    finishWorkspaceResize();
    const inlineHeight = Number.parseFloat(options.root.style.height);
    if (Number.isFinite(inlineHeight)) {
      // The active terminal pane owns the native window resize fit. Avoid a
      // second request-animation-frame fit/IPC from the workspace listener.
      applyWorkspaceHeight(inlineHeight, false);
      return;
    }
    syncWorkspaceResizeAttributes();
  };

  const bindWorkspaceResize = (): void => {
    const handle = options.resizeHandle;
    if (!handle) return;
    syncWorkspaceResizeAttributes();
    handle.addEventListener('pointerdown', onWorkspaceResizePointerDown);
    handle.addEventListener('pointermove', onWorkspaceResizePointerMove);
    handle.addEventListener('pointerup', onWorkspaceResizePointerEnd);
    handle.addEventListener('pointercancel', onWorkspaceResizePointerEnd);
    handle.addEventListener('lostpointercapture', onWorkspaceResizeLostCapture);
    handle.addEventListener('keydown', onWorkspaceResizeKeyDown);
    window.addEventListener('resize', onWorkspaceWindowResize);
  };

  const unbindWorkspaceResize = (): void => {
    const handle = options.resizeHandle;
    finishWorkspaceResize();
    if (!handle) return;
    handle.removeEventListener('pointerdown', onWorkspaceResizePointerDown);
    handle.removeEventListener('pointermove', onWorkspaceResizePointerMove);
    handle.removeEventListener('pointerup', onWorkspaceResizePointerEnd);
    handle.removeEventListener('pointercancel', onWorkspaceResizePointerEnd);
    handle.removeEventListener('lostpointercapture', onWorkspaceResizeLostCapture);
    handle.removeEventListener('keydown', onWorkspaceResizeKeyDown);
    window.removeEventListener('resize', onWorkspaceWindowResize);
  };

  bindWorkspaceResize();

  const closeRemoteLog = async (id: string): Promise<void> => {
    if (remotelyClosedLogIds.has(id)) return;
    remotelyClosedLogIds.add(id);
    await options.closeLogs(id);
  };

  const closeRemoteTerminal = async (id: string): Promise<void> => {
    if (remotelyClosedTerminalIds.has(id)) return;
    remotelyClosedTerminalIds.add(id);
    await options.closeTerminal(id);
  };

  /**
   * Exec output can arrive before its asynchronous open result exposes the
   * terminal ID to the workspace. Keep only a small renderer-memory bridge
   * until that exact ID binds, then drain it synchronously into its xterm.
   */
  const takePendingTerminalOutput = (id: string): string[] => {
    const output = pendingTerminalOutputs.get(id) ?? [];
    if (output.length === 0) return output;
    pendingTerminalOutputs.delete(id);
    pendingTerminalOutputChunks -= output.length;
    pendingTerminalOutputCharacters -= output.reduce((total, value) => total + value.length, 0);
    return output;
  };

  const clearPendingTerminalOutputs = (): void => {
    pendingTerminalOutputs.clear();
    pendingTerminalOutputCharacters = 0;
    pendingTerminalOutputChunks = 0;
  };

  const queuePendingTerminalOutput = (output: KubernetesTerminalOutput): void => {
    if (!output.data || terminalFinalIds.has(output.id)
      || pendingTerminalOutputChunks >= MAX_PENDING_TERMINAL_OUTPUT_CHUNKS
      || pendingTerminalOutputCharacters >= MAX_PENDING_TERMINAL_OUTPUT_CHARACTERS) return;
    const available = MAX_PENDING_TERMINAL_OUTPUT_CHARACTERS - pendingTerminalOutputCharacters;
    const data = output.data.slice(0, available);
    if (!data) return;
    const queued = pendingTerminalOutputs.get(output.id) ?? [];
    queued.push(data);
    pendingTerminalOutputs.set(output.id, queued);
    pendingTerminalOutputChunks += 1;
    pendingTerminalOutputCharacters += data.length;
  };

  const currentTab = (id: string, type?: KubernetesWorkspaceTabType): KubernetesWorkspaceTab | undefined => {
    const tab = state.tab(id);
    return tab && (!type || tab.type === type) ? tab : undefined;
  };

  const cancelAutoScroll = (): void => {
    if (autoScrollFrame !== undefined) window.cancelAnimationFrame(autoScrollFrame);
    autoScrollFrame = undefined;
    autoScrollKey = undefined;
  };

  const cancelPreserveScroll = (): void => {
    if (preserveScrollFrame !== undefined) window.cancelAnimationFrame(preserveScrollFrame);
    preserveScrollFrame = undefined;
    preserveScrollTabId = undefined;
  };

  const captureRenderedLogScroll = (tabId: string): void => {
    if (preserveScrollFrame !== undefined && preserveScrollTabId === tabId) return;
    const output = renderedLogOutputs.get(tabId);
    if (output?.parentElement) logScrollTops.set(tabId, output.scrollTop);
  };

  const scheduleLogScrollRestore = (
    tab: KubernetesWorkspaceTab,
    log: KubernetesLogState,
    scrollTop: number,
    expectedFollowing: boolean
  ): void => {
    cancelPreserveScroll();
    preserveScrollTabId = tab.id;
    preserveScrollFrame = window.requestAnimationFrame(() => {
      preserveScrollFrame = undefined;
      preserveScrollTabId = undefined;
      const current = currentTab(tab.id, 'logs');
      if (!current?.log || selectedTabId !== tab.id) return;
      if (current.log.sessionId !== log.sessionId
        || current.log.revision !== log.revision
        || current.log.following !== expectedFollowing) return;
      const output = renderedLogOutputs.get(tab.id);
      if (!output?.parentElement) return;
      output.scrollTop = scrollTop;
      logScrollTops.set(tab.id, output.scrollTop);
    });
  };

  const scheduleLogBottom = (tab: KubernetesWorkspaceTab, log: KubernetesLogState): void => {
    const key = `${tab.id}\u0000${log.sessionId}\u0000${log.revision}`;
    if (autoScrollFrame !== undefined && autoScrollKey === key) return;
    cancelAutoScroll();
    cancelPreserveScroll();
    autoScrollKey = key;
    autoScrollFrame = window.requestAnimationFrame(() => {
      autoScrollFrame = undefined;
      autoScrollKey = undefined;
      const current = currentTab(tab.id, 'logs');
      if (!current?.log || selectedTabId !== tab.id) return;
      if (current.log.sessionId !== log.sessionId || current.log.revision !== log.revision || !current.log.following) return;
      const output = renderedLogOutputs.get(tab.id);
      if (!output) return;
      output.scrollTop = output.scrollHeight;
      logScrollTops.set(tab.id, output.scrollTop);
    });
  };

  const detachTerminalPane = (): void => {
    terminalPane.detach();
    mountedTerminalTabId = undefined;
    mountedTerminalId = undefined;
    mountedTerminalHost = undefined;
  };

  const renderTabs = (): void => {
    const tabs = state.tabs();
    if (selectedTabId && !currentTab(selectedTabId)) selectedTabId = undefined;
    if (!selectedTabId && tabs.length > 0) selectedTabId = tabs[tabs.length - 1].id;
    options.root.classList.toggle('hidden', tabs.length === 0);
    if (tabs.length === 0) finishWorkspaceResize();
    else syncWorkspaceResizeAttributes();
    options.tabList.replaceChildren();
    for (const tab of tabs) {
      const item = document.createElement('div');
      const tabTypeClass = tab.type === 'logs'
        ? 'kubernetes-workspace-tab-logs'
        : 'kubernetes-workspace-tab-shell';
      item.className = `kubernetes-workspace-tab ${tabTypeClass}`;
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'kubernetes-workspace-tab-select';
      select.setAttribute('role', 'tab');
      select.setAttribute('aria-selected', String(selectedTabId === tab.id));
      select.setAttribute('aria-label', tabLabel(tab));
      select.textContent = tabTargetCaption(tab);
      select.title = tabTargetCaption(tab);
      select.addEventListener('click', () => {
        if (!currentTab(tab.id)) return;
        if (selectedTabId) captureRenderedLogScroll(selectedTabId);
        selectedTabId = tab.id;
        render();
      });
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'icon-btn kubernetes-workspace-tab-close';
      close.setAttribute('aria-label', `Close ${tabLabel(tab)}`);
      close.appendChild(createWorkspaceCloseIcon());
      close.addEventListener('click', () => {
        closeTab(tab.id, true);
      });
      item.append(select, close);
      options.tabList.appendChild(item);
    }
  };

  const renderAnsiLines = (output: HTMLPreElement, lines: string[]): void => {
    output.replaceChildren();
    const input = lines.join('\n');
    const token = /\x1b\[([0-9;]*)m/g;
    const classes: string[] = [];
    let lastIndex = 0;
    const append = (text: string): void => {
      if (!text) return;
      const node = document.createElement('span');
      node.textContent = text;
      if (classes.length > 0) node.className = classes.join(' ');
      output.appendChild(node);
    };
    let match: RegExpExecArray | null;
    while ((match = token.exec(input)) !== null) {
      append(input.slice(lastIndex, match.index));
      lastIndex = token.lastIndex;
      for (const value of (match[1] || '0').split(';')) {
        const code = Number(value || '0');
        if (code === 0) {
          classes.splice(0, classes.length);
        } else if (code === 1) {
          if (!classes.includes('ansi-bold')) classes.push('ansi-bold');
        } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
          const previous = classes.findIndex((className) => className.startsWith('ansi-fg-'));
          if (previous >= 0) classes.splice(previous, 1);
          classes.push(`ansi-fg-${code}`);
        }
      }
    }
    append(input.slice(lastIndex));
  };

  const renderLogPane = (tab: KubernetesWorkspaceTab, scrollIntent: KubernetesWorkspaceScrollIntent): void => {
    captureRenderedLogScroll(tab.id);
    detachTerminalPane();
    renderedLogOutputs.clear();
    options.pane.replaceChildren();
    const panel = document.createElement('section');
    panel.className = 'kubernetes-log-panel';
    const toolbar = document.createElement('div');
    toolbar.className = 'kubernetes-log-toolbar';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'input kubernetes-log-search-field';
    search.placeholder = 'Search logs';
    search.value = tab.logSearch;
    search.setAttribute('aria-label', `Search ${tabLabel(tab)}`);
    search.addEventListener('input', () => {
      if (!state.setLogSearch(tab.id, search.value)) return;
      renderPane('none');
    });
    const startTimeField = document.createElement('label');
    startTimeField.className = 'kubernetes-log-start-time';
    const startTimeLabel = document.createElement('span');
    startTimeLabel.textContent = 'Since';
    const startTime = document.createElement('input');
    startTime.type = 'datetime-local';
    startTime.step = '1';
    startTime.className = 'input kubernetes-log-start-time-input';
    startTime.setAttribute('aria-label', `Log start time for ${tabLabel(tab)}`);
    startTime.title = 'Load logs beginning at this local date and time';
    startTimeField.append(startTimeLabel, startTime);
    const follow = document.createElement('button');
    follow.type = 'button';
    follow.className = 'icon-btn';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn btn-secondary btn-sm';
    clear.textContent = 'Clear';
    const output = document.createElement('pre');
    output.className = 'kubernetes-log-output';
    output.setAttribute('data-kubernetes-workspace-log-output', 'true');
    const status = document.createElement('footer');
    status.className = 'kubernetes-log-status';
    const stateLabel = document.createElement('span');
    const count = document.createElement('span');
    const log = tab.log;
    let scopeSwitch: HTMLButtonElement | undefined;
    let restoreScrollTop: number | undefined;
    let scrollToBottom = false;
    if (!log) {
      startTime.disabled = true;
      follow.disabled = true;
      clear.disabled = true;
      follow.setAttribute('aria-label', 'Pause log follow');
      follow.textContent = 'Ⅱ';
      output.textContent = 'Loading logs…';
      stateLabel.textContent = 'Opening';
      count.textContent = '0 lines';
      cancelAutoScroll();
      cancelPreserveScroll();
    } else {
      startTime.value = kubernetesLogStartTimeInputValue(log.startTime);
      startTime.disabled = startTimeRequests.has(log.sessionId)
        || followRequests.has(log.sessionId)
        || scopeRequests.has(log.sessionId);
      startTime.addEventListener('change', () => {
        const timestamp = kubernetesLogStartTimeIso(startTime.value);
        if (!timestamp) {
          renderPane('none');
          return;
        }
        setLogStartTime(tab.id, timestamp);
      });
      if (log.deployment) {
        scopeSwitch = document.createElement('button');
        scopeSwitch.type = 'button';
        scopeSwitch.className = 'kubernetes-log-scope-switch';
        scopeSwitch.setAttribute('role', 'switch');
        scopeSwitch.setAttribute('aria-checked', String(log.scope === 'deployment'));
        scopeSwitch.setAttribute('aria-label', `Include all Pods in Deployment ${log.deployment.name}`);
        scopeSwitch.title = log.scope === 'deployment'
          ? `Showing all ${log.deployment.name} Deployment Pods; click for this Pod only`
          : `Showing this Pod only; click for all ${log.deployment.name} Deployment Pods`;
        scopeSwitch.textContent = `Deployment pods (${log.deployment.podCount})`;
        scopeSwitch.disabled = scopeRequests.has(log.sessionId) || startTimeRequests.has(log.sessionId);
        scopeSwitch.addEventListener('click', () => toggleLogScope(tab.id));
      }
      const following = log.following;
      follow.disabled = startTimeRequests.has(log.sessionId) || followRequests.has(log.sessionId);
      follow.setAttribute('aria-label', following ? 'Pause log follow' : 'Resume log follow');
      follow.setAttribute('title', following ? 'Pause log follow' : 'Resume log follow');
      follow.textContent = following ? 'Ⅱ' : '▶';
      follow.addEventListener('click', () => {
        toggleLogFollowing(tab.id);
      });
      clear.addEventListener('click', () => {
        clearLog(tab.id);
      });
      clear.disabled = startTimeRequests.has(log.sessionId);
      const searchValue = tab.logSearch.trim().toLocaleLowerCase();
      const lines = searchValue ? log.lines.filter((line) => line.toLocaleLowerCase().includes(searchValue)) : log.lines;
      renderAnsiLines(output, lines);
      const unit = log.lines.length === 1 ? 'line' : 'lines';
      count.textContent = lines.length === log.lines.length
        ? `${log.lines.length} ${unit}`
        : `${lines.length} of ${log.lines.length} ${unit}`;
      stateLabel.textContent = following ? 'Live' : 'Paused';
      output.addEventListener('scroll', () => {
        logScrollTops.set(tab.id, output.scrollTop);
      });
      renderedLogOutputs.set(tab.id, output);
      if (following && scrollIntent === 'follow') {
        scrollToBottom = true;
      } else {
        if (!following) cancelAutoScroll();
        restoreScrollTop = logScrollTops.get(tab.id) ?? 0;
      }
    }
    status.append(stateLabel, count);
    if (scopeSwitch) toolbar.appendChild(scopeSwitch);
    toolbar.append(search, startTimeField, follow, clear);
    panel.append(toolbar, output, status);
    options.pane.appendChild(panel);
    if (scrollToBottom && log) {
      scheduleLogBottom(tab, log);
    } else if (restoreScrollTop !== undefined && log) {
      // The replacement output is attached now, so restore immediately to
      // avoid a visible one-frame jump to the top. Reapply on the next frame
      // because Chromium can still clamp during the same layout turn.
      output.scrollTop = restoreScrollTop;
      logScrollTops.set(tab.id, output.scrollTop);
      scheduleLogScrollRestore(tab, log, restoreScrollTop, log.following);
    }
  };

  const renderShellPane = (tab: KubernetesWorkspaceTab): void => {
    for (const tabId of renderedLogOutputs.keys()) captureRenderedLogScroll(tabId);
    renderedLogOutputs.clear();
    cancelPreserveScroll();
    const terminal = tab.terminalId ? terminalStates.get(tab.terminalId) : undefined;
    if (terminal && mountedTerminalTabId === tab.id && mountedTerminalId === terminal.id && mountedTerminalHost) {
      if (!terminalPane.mount(terminal, mountedTerminalHost)) {
        closeTab(tab.id, true);
        return;
      }
      terminalPane.focus();
      return;
    }
    detachTerminalPane();
    options.pane.replaceChildren();
    const panel = document.createElement('section');
    panel.className = 'kubernetes-shell-panel';
    const host = document.createElement('div');
    host.className = 'kubernetes-shell-pane-host';
    panel.appendChild(host);
    options.pane.appendChild(panel);
    if (!terminal) {
      const opening = document.createElement('p');
      opening.className = 'kubernetes-terminal-unavailable';
      opening.textContent = 'Opening shell…';
      host.appendChild(opening);
      return;
    }
    mountedTerminalTabId = tab.id;
    mountedTerminalId = terminal.id;
    mountedTerminalHost = host;
    if (!terminalPane.mount(terminal, host)) {
      closeTab(tab.id, true);
      return;
    }
    terminalPane.focus();
  };

  const renderPane = (scrollIntent: KubernetesWorkspaceScrollIntent = 'none'): void => {
    const tab = selectedTabId ? currentTab(selectedTabId) : undefined;
    if (!tab) {
      options.pane.removeAttribute('aria-label');
      detachTerminalPane();
      renderedLogOutputs.clear();
      options.pane.replaceChildren();
      cancelAutoScroll();
      return;
    }
    options.pane.setAttribute('aria-label', tabLabel(tab));
    if (tab.type === 'logs') renderLogPane(tab, scrollIntent);
    else renderShellPane(tab);
  };

  const render = (scrollIntent: KubernetesWorkspaceScrollIntent = 'none'): void => {
    renderTabs();
    renderPane(scrollIntent);
  };

  const closeTab = (tabId: string, closeRemote: boolean): void => {
    const tab = currentTab(tabId);
    if (!tab) return;
    // Local removal is intentionally first. Any returned remote open result
    // is checked against this unique tab ID and can only be closed/discarded.
    state.close(tab.id);
    openingTerminalTabIds.delete(tab.id);
    if (openingTerminalTabIds.size === 0) clearPendingTerminalOutputs();
    logScrollTops.delete(tab.id);
    renderedLogOutputs.delete(tab.id);
    if (preserveScrollTabId === tab.id) cancelPreserveScroll();
    if (tab.log) {
      followRequests.delete(tab.log.sessionId);
      followIntents.delete(tab.log.sessionId);
      scopeRequests.delete(tab.log.sessionId);
      scopeIntents.delete(tab.log.sessionId);
      startTimeRequests.delete(tab.log.sessionId);
      startTimeIntents.delete(tab.log.sessionId);
    }
    if (tab.terminalId) {
      terminalFinalIds.add(tab.terminalId);
      takePendingTerminalOutput(tab.terminalId);
      terminalStates.delete(tab.terminalId);
      terminalPane.remove(tab.terminalId);
      if (mountedTerminalId === tab.terminalId) {
        mountedTerminalTabId = undefined;
        mountedTerminalId = undefined;
        mountedTerminalHost = undefined;
      }
    }
    if (selectedTabId === tab.id) selectedTabId = undefined;
    render();
    if (!closeRemote) return;
    if (tab.type === 'logs' && tab.log) void closeRemoteLog(tab.log.sessionId).catch(() => undefined);
    if (tab.type === 'shell' && tab.terminalId) void closeRemoteTerminal(tab.terminalId).catch(() => undefined);
  };

  const isCurrentLogTab = (tabId: string, sessionId?: string): KubernetesWorkspaceTab | undefined => {
    const tab = currentTab(tabId, 'logs');
    return tab && (!sessionId || tab.log?.sessionId === sessionId) ? tab : undefined;
  };

  const applyIncomingLog = (next: KubernetesLogState): { tab?: KubernetesWorkspaceTab; followed: boolean } => {
    const tabId = state.tabIdForLogSession(next.sessionId);
    const before = tabId ? isCurrentLogTab(tabId, next.sessionId) : undefined;
    if (!tabId || !before?.log) return { followed: false };
    const intent = followIntents.get(next.sessionId);
    const scopeIntent = scopeIntents.get(next.sessionId);
    const startTimeIntent = startTimeIntents.get(next.sessionId);
    if (next.revision < before.log.revision) return { followed: false };
    if (intent && (next.revision < intent.revision
      || (next.revision === intent.revision && next.following !== intent.following))) {
      return { followed: false };
    }
    if (scopeIntent && (next.revision < scopeIntent.revision
      || (next.revision === scopeIntent.revision && next.scope !== scopeIntent.scope))) {
      return { followed: false };
    }
    if (startTimeIntent && (next.revision < startTimeIntent.revision
      || (next.revision === startTimeIntent.revision && next.startTime !== startTimeIntent.startTime))) {
      return { followed: false };
    }
    if (!state.applyLog(next)) return { followed: false };
    if (intent && next.revision > intent.revision) followIntents.delete(next.sessionId);
    if (scopeIntent && next.revision > scopeIntent.revision) scopeIntents.delete(next.sessionId);
    if (startTimeIntent && next.revision > startTimeIntent.revision) startTimeIntents.delete(next.sessionId);
    const tab = isCurrentLogTab(tabId, next.sessionId);
    return { tab, followed: Boolean(tab && next.following && next.revision > before.log.revision) };
  };

  const toggleLogFollowing = (tabId: string): void => {
    const tab = isCurrentLogTab(tabId);
    const previous = tab?.log;
    if (!tab || !previous) return;
    const desired = !previous.following;
    if (!desired) {
      captureRenderedLogScroll(tab.id);
      cancelAutoScroll();
    }
    const token = Symbol(previous.sessionId);
    followRequests.set(previous.sessionId, token);
    followIntents.set(previous.sessionId, { following: desired, revision: previous.revision });
    if (desired) {
      startTimeIntents.set(previous.sessionId, { startTime: undefined, revision: previous.revision });
    }
    state.bindLog(tab.id, {
      ...previous,
      following: desired,
      ...(desired ? { startTime: undefined } : {}),
    });
    if (selectedTabId === tab.id) renderPane(desired ? 'follow' : 'none');
    void options.setLogFollowing(previous.sessionId, desired).then((next) => {
      if (followRequests.get(previous.sessionId) !== token || !isCurrentLogTab(tab.id, previous.sessionId)) return;
      followIntents.set(previous.sessionId, { following: next.following, revision: next.revision });
      const applied = applyIncomingLog(next);
      if (applied.tab?.id === selectedTabId) renderPane(applied.followed ? 'follow' : 'none');
    }).catch((error) => {
      if (followRequests.get(previous.sessionId) !== token || !isCurrentLogTab(tab.id, previous.sessionId)) return;
      if (!desired) {
        options.reportError(error);
        return;
      }
      followIntents.set(previous.sessionId, { following: previous.following, revision: previous.revision });
      state.bindLog(tab.id, previous);
      if (selectedTabId === tab.id) renderPane(previous.following ? 'follow' : 'none');
      options.reportError(error);
    }).finally(() => {
      if (followRequests.get(previous.sessionId) === token) followRequests.delete(previous.sessionId);
    });
  };

  const setLogStartTime = (tabId: string, startTime: string): void => {
    const tab = isCurrentLogTab(tabId);
    const previous = tab?.log;
    if (!tab || !previous || startTimeRequests.has(previous.sessionId)) return;
    captureRenderedLogScroll(tab.id);
    cancelAutoScroll();
    logScrollTops.set(tab.id, 0);
    const token = Symbol(previous.sessionId);
    startTimeRequests.set(previous.sessionId, token);
    startTimeIntents.set(previous.sessionId, { startTime, revision: previous.revision });
    followIntents.set(previous.sessionId, { following: false, revision: previous.revision });
    state.bindLog(tab.id, {
      ...previous,
      lines: [],
      following: false,
      startTime,
      hasOlder: false,
    });
    if (selectedTabId === tab.id) renderPane('none');
    void options.setLogStartTime(previous.sessionId, startTime).then((next) => {
      if (startTimeRequests.get(previous.sessionId) !== token || !isCurrentLogTab(tab.id, previous.sessionId)) return;
      startTimeIntents.set(previous.sessionId, { startTime: next.startTime, revision: next.revision });
      followIntents.set(previous.sessionId, { following: next.following, revision: next.revision });
      const applied = applyIncomingLog(next);
      if (applied.tab?.id === selectedTabId) renderPane('none');
    }).catch((error) => {
      if (startTimeRequests.get(previous.sessionId) === token && isCurrentLogTab(tab.id, previous.sessionId)) {
        options.reportError(error);
      }
    }).finally(() => {
      if (startTimeRequests.get(previous.sessionId) !== token) return;
      startTimeRequests.delete(previous.sessionId);
      if (selectedTabId === tab.id && isCurrentLogTab(tab.id, previous.sessionId)) renderPane('none');
    });
  };

  const toggleLogScope = (tabId: string): void => {
    const tab = isCurrentLogTab(tabId);
    const previous = tab?.log;
    if (!tab || !previous?.deployment) return;
    const desired: KubernetesLogScope = previous.scope === 'deployment' ? 'pod' : 'deployment';
    const token = Symbol(previous.sessionId);
    scopeRequests.set(previous.sessionId, token);
    scopeIntents.set(previous.sessionId, { scope: desired, revision: previous.revision });
    state.bindLog(tab.id, {
      ...previous,
      scope: desired,
      lines: [],
      hasOlder: desired === 'pod',
    });
    if (selectedTabId === tab.id) renderPane('none');
    void options.setLogScope(previous.sessionId, desired).then((next) => {
      if (scopeRequests.get(previous.sessionId) !== token || !isCurrentLogTab(tab.id, previous.sessionId)) return;
      scopeIntents.set(previous.sessionId, { scope: next.scope, revision: next.revision });
      const applied = applyIncomingLog(next);
      if (applied.tab?.id === selectedTabId) renderPane(applied.followed ? 'follow' : 'none');
    }).catch((error) => {
      if (scopeRequests.get(previous.sessionId) !== token || !isCurrentLogTab(tab.id, previous.sessionId)) return;
      scopeIntents.set(previous.sessionId, { scope: previous.scope, revision: previous.revision });
      state.bindLog(tab.id, previous);
      if (selectedTabId === tab.id) renderPane(previous.following ? 'follow' : 'none');
      options.reportError(error);
    }).finally(() => {
      if (scopeRequests.get(previous.sessionId) !== token) return;
      scopeRequests.delete(previous.sessionId);
      if (selectedTabId === tab.id && isCurrentLogTab(tab.id, previous.sessionId)) {
        renderPane('none');
      }
    });
  };

  const clearLog = (tabId: string): void => {
    const tab = isCurrentLogTab(tabId);
    const log = tab?.log;
    if (!tab || !log) return;
    void options.clearLogs(log.sessionId).then((next) => {
      if (!isCurrentLogTab(tab.id, log.sessionId)) return;
      const applied = applyIncomingLog(next);
      if (applied.tab?.id === selectedTabId) renderPane(applied.followed ? 'follow' : 'none');
    }).catch((error) => {
      if (isCurrentLogTab(tab.id, log.sessionId)) options.reportError(error);
    });
  };

  const openLogs = async (target: KubernetesPodTarget): Promise<void> => {
    if (disposed) return;
    const opened = state.open('logs', target);
    selectedTabId = opened.tab.id;
    render('none');
    if (!opened.created) return;
    try {
      const log = await options.openLogs(target);
      if (disposed || !state.bindLog(opened.tab.id, log)) {
        await closeRemoteLog(log.sessionId).catch(() => undefined);
        return;
      }
      if (selectedTabId === opened.tab.id) renderPane(log.following ? 'follow' : 'none');
      else renderTabs();
    } catch (error) {
      if (!currentTab(opened.tab.id, 'logs')) return;
      closeTab(opened.tab.id, false);
      options.reportError(error);
    }
  };

  const openShell = async (target: KubernetesPodTarget): Promise<void> => {
    if (disposed) return;
    const opened = state.open('shell', target);
    selectedTabId = opened.tab.id;
    if (opened.created && options.root.style.height === '') {
      applyWorkspaceHeight(workspacePageHeight() * KUBERNETES_SHELL_DEFAULT_HEIGHT_RATIO);
    }
    render();
    if (!opened.created) return;
    openingTerminalTabIds.add(opened.tab.id);
    try {
      const terminal = await options.openTerminal(target);
      if (isTerminalFinal(terminal)) {
        terminalFinalIds.add(terminal.id);
        takePendingTerminalOutput(terminal.id);
        terminalPane.finalize(terminal);
        if (terminal.state === 'error') {
          options.reportError(terminal.error ?? 'Kubernetes terminal failed.');
        }
      }
      if (disposed || terminalFinalIds.has(terminal.id)
        || !terminalStateMatchesTarget(terminal, target)
        || !state.bindTerminal(opened.tab.id, terminal.id)) {
        takePendingTerminalOutput(terminal.id);
        if (currentTab(opened.tab.id, 'shell')) closeTab(opened.tab.id, false);
        await closeRemoteTerminal(terminal.id).catch(() => undefined);
        return;
      }
      terminalStates.set(terminal.id, terminal);
      if (!terminalPane.prepare(terminal)) {
        takePendingTerminalOutput(terminal.id);
        if (currentTab(opened.tab.id, 'shell')) closeTab(opened.tab.id, false);
        await closeRemoteTerminal(terminal.id).catch(() => undefined);
        return;
      }
      for (const data of takePendingTerminalOutput(terminal.id)) {
        terminalPane.write({ id: terminal.id, data });
      }
      if (selectedTabId === opened.tab.id) renderPane();
      else renderTabs();
    } catch (error) {
      if (!currentTab(opened.tab.id, 'shell')) return;
      closeTab(opened.tab.id, false);
      options.reportError(error);
    } finally {
      openingTerminalTabIds.delete(opened.tab.id);
      if (openingTerminalTabIds.size === 0) clearPendingTerminalOutputs();
    }
  };

  return {
    openLogs,
    openShell,

    onLogChanged(next) {
      const applied = applyIncomingLog(next);
      if (applied.tab?.id === selectedTabId) renderPane(applied.followed ? 'follow' : 'none');
    },

    onTerminalChanged(next) {
      if (isTerminalFinal(next)) {
        // This runs before ownership lookup by design. A pre-bind final must
        // tombstone the ID inside the pane so a late open cannot mount it.
        terminalFinalIds.add(next.id);
        takePendingTerminalOutput(next.id);
        terminalPane.finalize(next);
        const tabId = state.tabIdForTerminal(next.id);
        if (!tabId) return;
        const tab = currentTab(tabId, 'shell');
        if (!tab || tab.terminalId !== next.id) return;
        if (next.state === 'error') options.reportError(next.error ?? 'Kubernetes terminal failed.');
        closeTab(tab.id, false);
        return;
      }
      const tabId = state.tabIdForTerminal(next.id);
      const tab = tabId ? currentTab(tabId, 'shell') : undefined;
      if (!tab || tab.terminalId !== next.id || !terminalStateMatchesTarget(next, tab.target)) return;
      terminalStates.set(next.id, next);
      if (!terminalPane.prepare(next)) {
        closeTab(tab.id, false);
        return;
      }
      if (selectedTabId === tab.id) renderPane();
    },

    onTerminalOutput(output) {
      // Retained views route only their exact terminal ID, including when a
      // still-owned Shell tab is currently in the background. An unknown ID
      // can be the first exec chunk racing before an open result binds it.
      if (terminalPane.write(output) || openingTerminalTabIds.size === 0) return;
      queuePendingTerminalOutput(output);
    },

    dispose() {
      if (disposal) return disposal;
      disposed = true;
      const tabs = state.tabs();
      for (const tab of tabs) state.close(tab.id);
      selectedTabId = undefined;
      terminalStates.clear();
      openingTerminalTabIds.clear();
      clearPendingTerminalOutputs();
      renderedLogOutputs.clear();
      cancelAutoScroll();
      cancelPreserveScroll();
      followRequests.clear();
      followIntents.clear();
      scopeRequests.clear();
      scopeIntents.clear();
      startTimeRequests.clear();
      startTimeIntents.clear();
      unbindWorkspaceResize();
      if (workspaceResizeFrame !== undefined) window.cancelAnimationFrame(workspaceResizeFrame);
      workspaceResizeFrame = undefined;
      mountedTerminalTabId = undefined;
      mountedTerminalId = undefined;
      mountedTerminalHost = undefined;
      terminalPane.dispose();
      options.tabList.replaceChildren();
      options.pane.replaceChildren();
      options.pane.removeAttribute('aria-label');
      options.root.classList.add('hidden');
      options.root.style.height = '';
      options.root.style.maxHeight = '';
      disposal = disposeKubernetesWorkspaceSessions(tabs, {
        closeLogs: closeRemoteLog,
        closeTerminal: closeRemoteTerminal,
      });
      return disposal;
    },
  };
}
