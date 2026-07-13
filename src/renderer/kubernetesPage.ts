import type {
  KubernetesContextInfo,
  KubernetesCustomResourceDefinition,
  KubernetesListSnapshot,
  KubernetesLogState,
  KubernetesNamespaceScope,
  KubernetesPodTarget,
  KubernetesPortForwardInput,
  KubernetesPortForwardState,
  KubernetesRelatedResourceRequest,
  KubernetesRelatedResources,
  KubernetesResourceKind,
  KubernetesResourceQuery,
  KubernetesResourceSummary,
  KubernetesState,
  KubernetesTerminalOutput,
  KubernetesTerminalState,
} from '../shared/types';
import { registerPage } from './nav.js';
import { createKubernetesVirtualTable, type KubernetesVirtualTable } from './kubernetesVirtualTable.js';
import { createKubernetesTerminalDrawer, type KubernetesTerminalDrawer } from './kubernetesTerminal.js';
import {
  buildKubernetesOverviewFields,
  buildKubernetesPortForwardDialogModel,
  detectKubernetesForwardPorts,
  formatKubernetesDeclaredPortLabel,
} from './kubernetesDetailModel.js';

type ToastLevel = 'default' | 'success' | 'error';

/** Avoid a renderer-module import cycle: the page emits only a display-safe toast request. */
const setMessage = (text: string, level: ToastLevel = 'default'): void => {
  window.dispatchEvent(new CustomEvent('service-manager:toast', { detail: { text, level } }));
};

const KUBERNETES_NAV_ICON = `
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 1.8 13.4 4.9v6.2L8 14.2l-5.4-3.1V4.9L8 1.8Z"></path>
    <path d="M8 1.8v6.1m5.4-3L8 7.9 2.6 4.9m5.4 3v6.3"></path>
  </svg>
`;

export const RESOURCE_CATEGORIES = {
  Workloads: ['pods', 'deployments', 'statefulsets'],
  Network: ['services', 'ingresses'],
  Configuration: ['configmaps', 'secrets'],
  Storage: ['persistentvolumeclaims'],
  Cluster: ['nodes', 'namespaces'],
  'Custom Resources': ['custom-resources'],
} as const;

const SEARCH_DEBOUNCE_MS = 200;
const VIRTUAL_ROW_HEIGHT = 36;
const VIRTUAL_OVERSCAN = 8;

type KubernetesCategory = keyof typeof RESOURCE_CATEGORIES;
type KubernetesSortColumn = 'name' | 'namespace' | 'status' | 'age';

interface KubernetesSortState {
  column: KubernetesSortColumn;
  direction: 'asc' | 'desc';
}

interface KubernetesPageController {
  show(): void;
  hide(): void;
  destroy(): void;
}

type DetailTab = 'overview' | 'yaml' | 'events';

interface DetailBackStack {
  query: KubernetesResourceQuery;
  selectedUid: string;
  scrollTop: number;
  search: string;
  sort: KubernetesSortState;
}

interface ActiveDetail {
  query: KubernetesResourceQuery;
  summary: KubernetesResourceSummary;
  detail: Record<string, unknown>;
  tab: DetailTab;
  related?: RelatedDetailState;
}

interface RelatedDetailState {
  expanded: boolean;
  loading: boolean;
  resources?: KubernetesRelatedResources;
  error?: string;
}

interface PortForwardDraft {
  targetKind: 'pod' | 'service';
  namespace: string;
  targetName: string;
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function resourceLabel(kind: KubernetesResourceKind): string {
  const labels: Record<KubernetesResourceKind, string> = {
    pods: 'Pods',
    deployments: 'Deployments',
    statefulsets: 'StatefulSets',
    services: 'Services',
    ingresses: 'Ingresses',
    configmaps: 'ConfigMaps',
    secrets: 'Secrets',
    persistentvolumeclaims: 'PVC',
    nodes: 'Nodes',
    namespaces: 'Namespaces',
    'custom-resources': 'Custom Resources',
  };
  return labels[kind];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

function isClusterScoped(kind: KubernetesResourceKind): boolean {
  return kind === 'nodes' || kind === 'namespaces';
}

function isPermissionError(error: unknown): boolean {
  return /\b(?:403|forbidden|permission denied)\b/i.test(toErrorMessage(error));
}

function formatAge(value: string | undefined): string {
  if (!value) return '—';
  const created = Date.parse(value);
  if (!Number.isFinite(created)) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - created) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function sameScope(left: KubernetesNamespaceScope, right: KubernetesNamespaceScope): boolean {
  return left.mode === right.mode && left.namespaces.join('\u0000') === right.namespaces.join('\u0000');
}

export function updateNamespaceSelection(
  selected: Iterable<string>,
  namespace: string,
  checked: boolean,
): KubernetesNamespaceScope {
  const next = new Set([...selected].map((name) => name.trim()).filter(Boolean));
  const value = namespace.trim();
  if (value) {
    if (checked) next.add(value);
    else next.delete(value);
  }
  const namespaces = [...next].sort();
  return namespaces.length > 0
    ? { mode: 'selected', namespaces }
    : { mode: 'all', namespaces: [] };
}

export function shouldCloseNamespaceMenu(
  control: Pick<HTMLElement, 'contains'>,
  target: Node | null,
): boolean {
  return target !== null && !control.contains(target);
}

export function nextKubernetesSort(
  current: KubernetesSortState,
  column: KubernetesSortColumn,
): KubernetesSortState {
  return current.column === column
    ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
    : { column, direction: 'asc' };
}

export function shouldAutoScrollKubernetesLogs(following: boolean, preserveScroll: boolean): boolean {
  return following && !preserveScroll;
}

export interface KubernetesLogAutoScrollScheduler {
  schedule(key: string, callback: () => void): void;
  cancel(): void;
}

export function createKubernetesLogAutoScrollScheduler(
  requestFrame: (callback: FrameRequestCallback) => number,
  cancelFrame: (frame: number) => void,
): KubernetesLogAutoScrollScheduler {
  let frame: number | undefined;
  let key: string | undefined;
  let callback: (() => void) | undefined;

  const cancel = (): void => {
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
    key = undefined;
    callback = undefined;
  };

  return {
    schedule(nextKey, nextCallback) {
      callback = nextCallback;
      if (frame !== undefined && key === nextKey) return;
      if (frame !== undefined) cancelFrame(frame);
      key = nextKey;
      frame = requestFrame(() => {
        frame = undefined;
        key = undefined;
        const pendingCallback = callback;
        callback = undefined;
        pendingCallback?.();
      });
    },
    cancel,
  };
}

export type KubernetesLogScrollIntent = 'follow' | 'preserve' | 'incidental';
export type KubernetesLogUpdateRoute = 'selected' | 'background' | 'stale';
export type KubernetesPodWorkspace = 'logs' | 'terminal';

export interface KubernetesLogViewportState {
  visible: boolean;
  detailGeneration: number;
  selectedContainer?: string;
  log?: KubernetesLogState;
  error?: string;
  search: string;
}

export interface KubernetesLogViewportElements {
  followButton: Pick<HTMLButtonElement, 'disabled' | 'setAttribute'>;
  pauseIcon: { classList: Pick<DOMTokenList, 'toggle'> };
  playIcon: { classList: Pick<DOMTokenList, 'toggle'> };
  clearButton: Pick<HTMLButtonElement, 'disabled'>;
  output: Pick<HTMLPreElement, 'textContent' | 'scrollTop' | 'scrollHeight'>;
  count: Pick<HTMLElement, 'textContent'>;
  state: { classList: Pick<DOMTokenList, 'remove' | 'toggle'> };
  stateLabel: Pick<HTMLElement, 'textContent'>;
}

export interface KubernetesLogViewport {
  render(intent?: KubernetesLogScrollIntent): void;
  cancel(): void;
}

export interface KubernetesLogFollowMutation {
  token: symbol;
  following: boolean;
}

export interface KubernetesLogFollowToggleOptions {
  sessions: Map<string, KubernetesLogState>;
  mutations: Map<string, KubernetesLogFollowMutation>;
  getSelectedContainer: () => string | undefined;
  viewport: KubernetesLogViewport;
  setFollowing: (sessionId: string, following: boolean) => Promise<KubernetesLogState>;
  onError: (error: unknown) => void;
}

export function claimKubernetesLogOpen(
  requests: Map<string, symbol>,
  key: string,
): symbol | undefined {
  if (requests.has(key)) return undefined;
  const token = Symbol(key);
  requests.set(key, token);
  return token;
}

export function releaseKubernetesLogOpen(
  requests: Map<string, symbol>,
  key: string,
  token: symbol,
): void {
  if (requests.get(key) === token) requests.delete(key);
}

export function applyKubernetesLogOpenFailure(options: {
  requests: Map<string, symbol>;
  key: string;
  token: symbol;
  selectedContainer: string | undefined;
  targetContainer: string;
  cache: () => void;
  renderSelected: () => void;
}): KubernetesLogUpdateRoute {
  if (options.requests.get(options.key) !== options.token) return 'stale';
  options.cache();
  if (options.selectedContainer !== options.targetContainer) return 'background';
  options.renderSelected();
  return 'selected';
}

interface KubernetesPodWorkspaceTab {
  classList: Pick<DOMTokenList, 'toggle'>;
  setAttribute(name: string, value: string): void;
}

export function applyKubernetesPodWorkspace(
  workspace: KubernetesPodWorkspace,
  options: {
    logsTab: KubernetesPodWorkspaceTab;
    terminalTab: KubernetesPodWorkspaceTab;
    hideTerminalDrawer: () => void;
  },
): void {
  const terminalSelected = workspace === 'terminal';
  options.logsTab.classList.toggle('kubernetes-log-view-tab-active', !terminalSelected);
  options.logsTab.setAttribute('aria-selected', String(!terminalSelected));
  options.terminalTab.classList.toggle('kubernetes-log-view-tab-active', terminalSelected);
  options.terminalTab.setAttribute('aria-selected', String(terminalSelected));
  if (!terminalSelected) options.hideTerminalDrawer();
}

function kubernetesPodTargetKey(target: KubernetesPodTarget): string {
  return `${target.namespace}\u0000${target.podName}\u0000${target.container}`;
}

export function sameKubernetesPodTarget(
  left: KubernetesPodTarget | undefined,
  right: KubernetesPodTarget | undefined,
): boolean {
  return Boolean(left && right
    && left.namespace === right.namespace
    && left.podName === right.podName
    && left.container === right.container);
}

export async function openKubernetesTerminalWorkspace(options: {
  target: KubernetesPodTarget;
  requests: Map<string, symbol>;
  selectWorkspace: (workspace: KubernetesPodWorkspace) => void;
  focusTarget: (target: KubernetesPodTarget) => string | undefined;
  focusSession: (id: string) => boolean;
  claimSession: (id: string) => void;
  openDrawer: (state: KubernetesTerminalState) => void;
  requestTerminal: (target: KubernetesPodTarget) => Promise<KubernetesTerminalState>;
  isCurrent: () => boolean;
  reportError: (error: unknown) => void;
}): Promise<void> {
  options.selectWorkspace('terminal');
  const existingId = options.focusTarget(options.target);
  if (existingId) {
    options.claimSession(existingId);
    return;
  }

  const key = kubernetesPodTargetKey(options.target);
  const token = claimKubernetesLogOpen(options.requests, key);
  if (!token) return;
  try {
    const state = await options.requestTerminal(options.target);
    options.openDrawer(state);
    if (options.requests.get(key) !== token || !options.isCurrent()) return;
    if (options.focusSession(state.id)) {
      options.claimSession(state.id);
      return;
    }
    options.selectWorkspace('logs');
    if (state.state === 'error') {
      options.reportError(state.error ?? 'Kubernetes terminal failed.');
    }
  } catch (error) {
    if (options.requests.get(key) !== token || !options.isCurrent()) return;
    options.selectWorkspace('logs');
    options.reportError(error);
  } finally {
    releaseKubernetesLogOpen(options.requests, key, token);
  }
}

export type KubernetesTerminalFinalRoute = 'background' | 'retained' | 'fallback';

export function routeKubernetesTerminalFinalState(options: {
  state: KubernetesTerminalState;
  selectedTarget: KubernetesPodTarget | undefined;
  workspace: KubernetesPodWorkspace;
  workspaceSessionId: string | undefined;
  replacementSessionId: string | undefined;
  claimSession: (id: string) => void;
  selectLogs: () => void;
  reportError: (message: string) => void;
}): KubernetesTerminalFinalRoute {
  if ((options.state.state !== 'closed' && options.state.state !== 'error')
    || options.workspace !== 'terminal'
    || options.state.id !== options.workspaceSessionId
    || !sameKubernetesPodTarget(options.state, options.selectedTarget)) {
    return 'background';
  }
  if (options.state.state === 'error') {
    options.reportError(options.state.error ?? 'Kubernetes terminal failed.');
  }
  if (options.replacementSessionId) {
    options.claimSession(options.replacementSessionId);
    return 'retained';
  }
  options.selectLogs();
  return 'fallback';
}

export function routeKubernetesLogUpdate(
  sessions: Map<string, KubernetesLogState>,
  selectedContainer: string | undefined,
  state: KubernetesLogState,
  allowNewSession = false,
): KubernetesLogUpdateRoute {
  const current = sessions.get(state.container);
  if ((current && current.sessionId !== state.sessionId)
    || (!current && (!allowNewSession || state.container !== selectedContainer))) {
    return 'stale';
  }
  sessions.set(state.container, state);
  return state.container === selectedContainer ? 'selected' : 'background';
}

export function applyKubernetesLogUpdate(
  sessions: Map<string, KubernetesLogState>,
  selectedContainer: string | undefined,
  state: KubernetesLogState,
  viewport: KubernetesLogViewport,
  intent: KubernetesLogScrollIntent,
  allowNewSession = false,
): KubernetesLogUpdateRoute {
  const route = routeKubernetesLogUpdate(sessions, selectedContainer, state, allowNewSession);
  if (route === 'selected') viewport.render(intent);
  return route;
}

export function shouldApplyKubernetesLogBroadcast(
  mutations: ReadonlyMap<string, KubernetesLogFollowMutation>,
  state: KubernetesLogState,
): boolean {
  const mutation = mutations.get(state.sessionId);
  return !mutation || mutation.following === state.following;
}

export async function runKubernetesLogFollowToggle(
  options: KubernetesLogFollowToggleOptions,
): Promise<void> {
  const container = options.getSelectedContainer();
  const previous = container ? options.sessions.get(container) : undefined;
  if (!previous) return;

  const desired = !previous.following;
  const token = Symbol(previous.sessionId);
  options.mutations.set(previous.sessionId, { token, following: desired });
  const optimistic = { ...previous, following: desired };
  applyKubernetesLogUpdate(
    options.sessions,
    options.getSelectedContainer(),
    optimistic,
    options.viewport,
    desired ? 'follow' : 'preserve',
  );

  const isCurrent = (): boolean => options.mutations.get(previous.sessionId)?.token === token
    && options.sessions.get(previous.container)?.sessionId === previous.sessionId;

  try {
    const next = await options.setFollowing(previous.sessionId, desired);
    if (!isCurrent()) return;
    applyKubernetesLogUpdate(
      options.sessions,
      options.getSelectedContainer(),
      next,
      options.viewport,
      next.following ? 'follow' : 'preserve',
    );
  } catch (error) {
    if (!isCurrent()) return;
    if (options.sessions.get(previous.container) === optimistic) {
      applyKubernetesLogUpdate(
        options.sessions,
        options.getSelectedContainer(),
        previous,
        options.viewport,
        previous.following ? 'follow' : 'preserve',
      );
    }
    options.onError(error);
  } finally {
    if (options.mutations.get(previous.sessionId)?.token === token) options.mutations.delete(previous.sessionId);
  }
}

export function formatKubernetesLogCount(filtered: number, total: number): string {
  const unit = total === 1 ? 'line' : 'lines';
  return filtered === total ? `${total} ${unit}` : `${filtered} of ${total} ${unit}`;
}

export function createKubernetesLogViewport(options: {
  getState: () => KubernetesLogViewportState;
  elements: KubernetesLogViewportElements;
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (frame: number) => void;
}): KubernetesLogViewport {
  const autoScroll = createKubernetesLogAutoScrollScheduler(options.requestFrame, options.cancelFrame);

  return {
    render(intent = 'incidental'): void {
      const previousScrollTop = options.elements.output.scrollTop;
      const state = options.getState();
      const log = state.log;
      const following = log?.following === true;
      const followLabel = following ? 'Pause log follow' : 'Resume log follow';
      options.elements.followButton.disabled = !log;
      options.elements.clearButton.disabled = !log;
      options.elements.followButton.setAttribute('aria-label', followLabel);
      options.elements.followButton.setAttribute('title', followLabel);
      options.elements.pauseIcon.classList.toggle('hidden', !following);
      options.elements.playIcon.classList.toggle('hidden', following);
      if (!log) {
        options.elements.output.textContent = state.selectedContainer
          ? state.error ?? 'Loading logs…'
          : 'No container is available.';
        options.elements.count.textContent = '0 lines';
        options.elements.state.classList.remove('kubernetes-log-state-live');
        options.elements.stateLabel.textContent = 'Paused';
        autoScroll.cancel();
        options.elements.output.scrollTop = previousScrollTop;
        return;
      }

      const search = state.search.trim().toLocaleLowerCase();
      const lines = search ? log.lines.filter((line) => line.toLocaleLowerCase().includes(search)) : log.lines;
      options.elements.count.textContent = formatKubernetesLogCount(lines.length, log.lines.length);
      options.elements.state.classList.toggle('kubernetes-log-state-live', log.following);
      options.elements.stateLabel.textContent = log.following ? 'Live' : 'Paused';
      options.elements.output.textContent = lines.join('\n');
      if (!shouldAutoScrollKubernetesLogs(log.following, intent !== 'follow')) {
        if (!log.following || intent === 'preserve') autoScroll.cancel();
        options.elements.output.scrollTop = previousScrollTop;
        return;
      }

      const request = {
        sessionId: log.sessionId,
        container: log.container,
        detailGeneration: state.detailGeneration,
      };
      const requestKey = `${request.sessionId}\u0000${request.container}\u0000${request.detailGeneration}`;
      autoScroll.schedule(requestKey, () => {
        const current = options.getState();
        if (!current.visible || !current.log?.following) return;
        if (current.log.sessionId !== request.sessionId) return;
        if (current.log.container !== request.container) return;
        if (current.selectedContainer !== request.container) return;
        if (current.detailGeneration !== request.detailGeneration) return;
        options.elements.output.scrollTop = options.elements.output.scrollHeight;
      });
    },
    cancel(): void {
      autoScroll.cancel();
    },
  };
}

export function categoryUsesResourceTabs(category: KubernetesCategory): boolean {
  return category !== 'Custom Resources';
}

function kubernetesSortColumn(value: string | undefined): KubernetesSortColumn | undefined {
  return value === 'name' || value === 'namespace' || value === 'status' || value === 'age'
    ? value
    : undefined;
}

function sameQuery(left: KubernetesResourceQuery, right: KubernetesResourceQuery): boolean {
  return left.context === right.context
    && left.kind === right.kind
    && left.apiVersion === right.apiVersion
    && left.plural === right.plural
    && left.scope === right.scope
    && left.nameFilter === right.nameFilter
    && left.sort?.column === right.sort?.column
    && left.sort?.direction === right.sort?.direction
    && sameScope(left.namespaceScope, right.namespaceScope);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function containerNames(detail: Record<string, unknown>): { regular: string[]; init: string[] } {
  const spec = asRecord(detail.spec);
  const names = (value: unknown): string[] => Array.isArray(value)
    ? value.flatMap((item) => {
      const name = stringValue(asRecord(item)?.name);
      return name ? [name] : [];
    })
    : [];
  return { regular: names(spec?.containers), init: names(spec?.initContainers) };
}

/** Converts the Kubernetes selector shape into the native API selector form. */
function workloadSelector(detail: Record<string, unknown>): string | undefined {
  const selector = asRecord(asRecord(detail.spec)?.selector);
  if (!selector) return undefined;
  const values: string[] = [];
  const labels = asRecord(selector.matchLabels);
  if (labels) {
    for (const [key, value] of Object.entries(labels)) {
      if (stringValue(key) && stringValue(value)) values.push(`${key}=${value}`);
    }
  }
  const expressions = Array.isArray(selector.matchExpressions) ? selector.matchExpressions : [];
  for (const expression of expressions) {
    const record = asRecord(expression);
    const key = stringValue(record?.key);
    const operator = stringValue(record?.operator);
    const expressionValues = Array.isArray(record?.values)
      ? record.values.flatMap((value) => stringValue(value) ? [value] : [])
      : [];
    if (!key || !operator) continue;
    if ((operator === 'In' || operator === 'NotIn') && expressionValues.length > 0) {
      values.push(`${key} ${operator.toLowerCase()} (${expressionValues.join(',')})`);
    } else if (operator === 'Exists') {
      values.push(key);
    } else if (operator === 'DoesNotExist') {
      values.push(`!${key}`);
    }
  }
  return values.length > 0 ? values.join(',') : undefined;
}

function cloneDetail(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function decodeBase64(value: string): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)));
  } catch {
    return value;
  }
}

function decodeSecretForActiveView(detail: Record<string, unknown>): Record<string, unknown> {
  const copy = cloneDetail(detail);
  const data = asRecord(copy.data);
  if (!data) return copy;
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') data[key] = decodeBase64(value);
  }
  return copy;
}

function browserYamlSerializer(): BrowserYamlSerializer {
  const serializer = globalThis.jsyaml;
  if (!serializer || typeof serializer.dump !== 'function') {
    throw new Error('Kubernetes YAML output is unavailable. Restart Service Manager and try again.');
  }
  return serializer;
}

/**
 * Keeps YAML serialization in the renderer so decoded Secret values remain
 * limited to the active detail viewer and never enter a reusable main cache.
 */
export function serializeKubernetesDetailYaml(detail: Record<string, unknown>): string {
  return browserYamlSerializer().dump(detail, { lineWidth: -1, noRefs: true });
}

function detailName(detail: ActiveDetail): string {
  return detail.summary.namespace
    ? `${detail.summary.namespace}/${detail.summary.name}`
    : detail.summary.name;
}

/** A filtered loaded-only view must never consume every continuation page. */
export function shouldAutomaticallyLoadMore(query: KubernetesResourceQuery): boolean {
  return !query.nameFilter?.trim();
}

/**
 * Keeps the asynchronous relation loader honest about the detail it began
 * loading for. Callbacks are deliberately separate so every mutable UI update
 * is preceded by a current-detail check.
 */
export async function runRelatedResourceRequest<T>(
  load: () => Promise<T>,
  lifecycle: {
    isCurrent: () => boolean;
    onLoading: () => void;
    onSuccess: (resources: T) => void;
    onError: (error: unknown) => void;
    onComplete: () => void;
  },
): Promise<void> {
  if (!lifecycle.isCurrent()) return;
  lifecycle.onLoading();
  try {
    const resources = await load();
    if (!lifecycle.isCurrent()) return;
    lifecycle.onSuccess(resources);
  } catch (error) {
    if (!lifecycle.isCurrent()) return;
    lifecycle.onError(error);
  } finally {
    if (lifecycle.isCurrent()) lifecycle.onComplete();
  }
}

/** A close owns cleanup only until a later detail lifecycle increments its generation. */
export function isCurrentKubernetesDetailClose(
  closingGeneration: number,
  currentGeneration: number,
): boolean {
  return currentGeneration === closingGeneration + 1;
}

class KubernetesPage implements KubernetesPageController {
  private readonly contextSelect = requireElement<HTMLSelectElement>('#kubernetes-context');
  private readonly connectionBadge = requireElement<HTMLElement>('#kubernetes-connection');
  private readonly tlsBadge = requireElement<HTMLElement>('#kubernetes-tls-warning');
  private readonly reconnectButton = requireElement<HTMLButtonElement>('#kubernetes-reconnect');
  private readonly reloadButton = requireElement<HTMLButtonElement>('#kubernetes-reload-kubeconfig');
  private readonly namespaceToggle = requireElement<HTMLButtonElement>('#kubernetes-namespace-toggle');
  private readonly namespaceControl = requireElement<HTMLElement>('.kubernetes-namespace-control');
  private readonly namespaceMenu = requireElement<HTMLDivElement>('#kubernetes-namespace-menu');
  private readonly categoryTabs = requireElement<HTMLDivElement>('#kubernetes-category-tabs');
  private readonly resourceTabs = requireElement<HTMLDivElement>('#kubernetes-resource-tabs');
  private readonly customResourceControl = requireElement<HTMLElement>('#kubernetes-custom-resource-control');
  private readonly customResourceSelect = requireElement<HTMLSelectElement>('#kubernetes-custom-resource-select');
  private readonly searchInput = requireElement<HTMLInputElement>('#kubernetes-resource-search');
  private readonly tableHeader = requireElement<HTMLElement>('#kubernetes-table-header');
  private readonly loadedCount = requireElement<HTMLElement>('#kubernetes-loaded-count');
  private readonly tableViewport = requireElement<HTMLDivElement>('#kubernetes-table-viewport');
  private readonly emptyState = requireElement<HTMLElement>('#kubernetes-empty-state');
  private readonly noPermission = requireElement<HTMLElement>('#kubernetes-no-permission');
  private readonly errorState = requireElement<HTMLElement>('#kubernetes-error-state');
  private readonly listPage = requireElement<HTMLElement>('#kubernetes-list-page');
  private readonly detailPage = requireElement<HTMLElement>('#kubernetes-detail-page');
  private readonly detailBackButton = requireElement<HTMLButtonElement>('#kubernetes-detail-back');
  private readonly detailTitle = requireElement<HTMLElement>('#kubernetes-detail-title');
  private readonly detailSubtitle = requireElement<HTMLElement>('#kubernetes-detail-subtitle');
  private readonly detailPortForwardButton = requireElement<HTMLButtonElement>('#kubernetes-detail-port-forward');
  private readonly detailPortSummary = requireElement<HTMLElement>('#kubernetes-detail-port-summary');
  private readonly detailTabs = requireElement<HTMLElement>('#kubernetes-detail-tabs');
  private readonly detailOverview = requireElement<HTMLElement>('#kubernetes-detail-overview');
  private readonly detailYamlSection = requireElement<HTMLElement>('#kubernetes-detail-yaml-section');
  private readonly detailYaml = requireElement<HTMLPreElement>('#kubernetes-detail-yaml');
  private readonly detailEvents = requireElement<HTMLElement>('#kubernetes-detail-events');
  private readonly detailRelated = requireElement<HTMLElement>('#kubernetes-detail-related');
  private readonly containerSelect = requireElement<HTMLSelectElement>('#kubernetes-container-select');
  private readonly logPanel = requireElement<HTMLElement>('#kubernetes-log-panel');
  private readonly logTab = requireElement<HTMLButtonElement>('.kubernetes-log-toolbar [role="tablist"] .kubernetes-log-view-tab:first-child');
  private readonly logTerminalTab = requireElement<HTMLButtonElement>('#kubernetes-log-terminal-tab');
  private readonly logFollowButton = requireElement<HTMLButtonElement>('#kubernetes-log-follow');
  private readonly logFollowPauseIcon = requireElement<SVGElement>('#kubernetes-log-follow-pause-icon');
  private readonly logFollowPlayIcon = requireElement<SVGElement>('#kubernetes-log-follow-play-icon');
  private readonly logClearButton = requireElement<HTMLButtonElement>('#kubernetes-log-clear');
  private readonly logSearch = requireElement<HTMLInputElement>('#kubernetes-log-search');
  private readonly logOutput = requireElement<HTMLPreElement>('#kubernetes-log-output');
  private readonly logCount = requireElement<HTMLElement>('#kubernetes-log-count');
  private readonly logState = requireElement<HTMLElement>('#kubernetes-log-state');
  private readonly logStateLabel = requireElement<HTMLElement>('#kubernetes-log-state > span:last-child');
  private readonly portForwardPanel = requireElement<HTMLElement>('#kubernetes-port-forwards');
  private readonly portForwardList = requireElement<HTMLElement>('#kubernetes-port-forward-list');
  private readonly portForwardDialog = requireElement<HTMLDialogElement>('#kubernetes-port-forward-dialog');
  private readonly portForwardForm = requireElement<HTMLFormElement>('#kubernetes-port-forward-form');
  private readonly portForwardTitle = requireElement<HTMLElement>('#kubernetes-port-forward-title');
  private readonly portForwardTarget = requireElement<HTMLElement>('#kubernetes-port-forward-target');
  private readonly portForwardDeclaredField = requireElement<HTMLElement>('#kubernetes-port-forward-declared-field');
  private readonly portForwardDeclaredPort = requireElement<HTMLSelectElement>('#kubernetes-port-forward-declared-port');
  private readonly portForwardHint = requireElement<HTMLElement>('#kubernetes-port-forward-hint');
  private readonly portForwardRemotePort = requireElement<HTMLInputElement>('#kubernetes-port-forward-remote-port');
  private readonly portForwardLocalPort = requireElement<HTMLInputElement>('#kubernetes-port-forward-local-port');
  private readonly portForwardError = requireElement<HTMLElement>('#kubernetes-port-forward-error');
  private readonly portForwardCancel = requireElement<HTMLButtonElement>('#kubernetes-port-forward-cancel');
  private readonly portForwardCancelSecondary = requireElement<HTMLButtonElement>('#kubernetes-port-forward-cancel-secondary');
  private readonly terminalDrawerRoot = requireElement<HTMLElement>('#kubernetes-terminal-drawer');

  private category: KubernetesCategory = 'Workloads';
  private resourceKind: KubernetesResourceKind = 'pods';
  private sort: KubernetesSortState = { column: 'name', direction: 'asc' };
  private customDefinitions: KubernetesCustomResourceDefinition[] = [];
  private customDefinitionsContext: string | undefined;
  private selectedCustomDefinition: KubernetesCustomResourceDefinition | undefined;
  private state: KubernetesState | undefined;
  private snapshot: KubernetesListSnapshot | undefined;
  private table: KubernetesVirtualTable | undefined;
  private visible = false;
  private loadingMore = false;
  private requestedContinuation: string | undefined;
  private requestedWindow: string | undefined;
  private searchTimer: number | undefined;
  private reconnecting = false;
  private requestGeneration = 0;
  private selectedNamespaces = new Set<string>();
  private availableNamespaces: string[] = [];
  private namespaceContext: string | undefined;
  private namespaceLoadingContext: string | undefined;
  private namespaceRequestGeneration = 0;
  private unsubscribeState: (() => void) | undefined;
  private unsubscribeList: (() => void) | undefined;
  private unsubscribeLog: (() => void) | undefined;
  private unsubscribeTerminal: (() => void) | undefined;
  private unsubscribeTerminalOutput: (() => void) | undefined;
  private unsubscribePortForward: (() => void) | undefined;
  private bound = false;
  private pageGeneration = 0;
  private deactivation: Promise<void> = Promise.resolve();
  private detailBackStack: DetailBackStack | undefined;
  private activeDetail: ActiveDetail | undefined;
  private detailGeneration = 0;
  private detailLoading = false;
  private detailLoadingGeneration: number | undefined;
  private relatedGeneration = 0;
  /** Plaintext Secret material may exist only while its full-page detail is active. */
  private decodedSecretDetail: Record<string, unknown> | undefined;
  private detailEventsLoaded = false;
  private selectedContainer: string | undefined;
  private readonly logsByContainer = new Map<string, KubernetesLogState>();
  private readonly logFollowMutations = new Map<string, KubernetesLogFollowMutation>();
  private readonly openingLogs = new Map<string, symbol>();
  private readonly logErrorsByContainer = new Map<string, string>();
  private podWorkspace: KubernetesPodWorkspace = 'logs';
  private readonly openingTerminals = new Map<string, symbol>();
  private terminalWorkspaceSessionId: string | undefined;
  private terminalDrawer: KubernetesTerminalDrawer | undefined;
  private portForwards = new Map<string, KubernetesPortForwardState>();
  private portForwardDraft: PortForwardDraft | undefined;
  private readonly logViewport = createKubernetesLogViewport({
    getState: () => {
      const selectedContainer = this.selectedContainer;
      return {
        visible: this.visible,
        detailGeneration: this.detailGeneration,
        selectedContainer,
        log: selectedContainer ? this.logsByContainer.get(selectedContainer) : undefined,
        error: selectedContainer ? this.logErrorsByContainer.get(selectedContainer) : undefined,
        search: this.logSearch.value,
      };
    },
    elements: {
      followButton: this.logFollowButton,
      pauseIcon: this.logFollowPauseIcon,
      playIcon: this.logFollowPlayIcon,
      clearButton: this.logClearButton,
      output: this.logOutput,
      count: this.logCount,
      state: this.logState,
      stateLabel: this.logStateLabel,
    },
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (frame) => window.cancelAnimationFrame(frame),
  });

  public show(): void {
    if (this.visible) return;
    this.visible = true;
    const pageGeneration = ++this.pageGeneration;
    this.ensureBound();
    this.ensureTable();
    this.unsubscribeState = window.kubernetesApi.onStateChanged((state) => this.onStateChanged(state));
    this.unsubscribeList = window.kubernetesApi.onListChanged((snapshot) => this.onListChanged(snapshot));
    this.unsubscribeLog = window.kubernetesApi.onLogChanged((state) => this.onLogChanged(state));
    this.unsubscribeTerminal = window.kubernetesApi.onTerminalChanged((state) => this.onTerminalChanged(state));
    this.unsubscribeTerminalOutput = window.kubernetesApi.onTerminalOutput((output) => this.onTerminalOutput(output));
    this.unsubscribePortForward = window.kubernetesApi.onPortForwardChanged((state) => this.onPortForwardChanged(state));
    this.ensureTerminalDrawer();
    void this.loadPortForwards();
    void this.waitForPriorDeactivation(pageGeneration);
  }

  public hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.pageGeneration += 1;
    this.requestGeneration += 1;
    this.invalidateNamespaceOptions();
    this.loadingMore = false;
    this.requestedContinuation = undefined;
    this.requestedWindow = undefined;
    if (this.searchTimer !== undefined) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = undefined;
    }
    this.unsubscribeState?.();
    this.unsubscribeState = undefined;
    this.unsubscribeList?.();
    this.unsubscribeList = undefined;
    this.unsubscribeLog?.();
    this.unsubscribeLog = undefined;
    this.unsubscribeTerminal?.();
    this.unsubscribeTerminal = undefined;
    this.unsubscribeTerminalOutput?.();
    this.unsubscribeTerminalOutput = undefined;
    this.unsubscribePortForward?.();
    this.unsubscribePortForward = undefined;
    this.closePortForwardDialog();
    void this.closeDetail();
    this.terminalDrawer?.dispose();
    this.terminalDrawer = undefined;
    this.table?.dispose();
    this.table = undefined;
    this.deactivation = window.kubernetesApi.deactivatePage().catch((error) => {
      console.error('[kubernetes:deactivate-page]', error);
    });
  }

  public destroy(): void {
    this.hide();
  }

  private ensureBound(): void {
    if (this.bound) return;
    this.bound = true;

    this.contextSelect.addEventListener('change', () => {
      const context = this.contextSelect.value;
      if (!context) return;
      void this.selectContext(context);
    });
    this.reloadButton.addEventListener('click', () => {
      void this.reloadKubeconfig();
    });
    this.reconnectButton.addEventListener('click', () => {
      void this.reconnect();
    });
    this.namespaceToggle.addEventListener('click', () => {
      this.namespaceMenu.classList.toggle('hidden');
    });
    document.addEventListener('pointerdown', (event) => {
      if (this.namespaceMenu.classList.contains('hidden')) return;
      const target = event.target instanceof Node ? event.target : null;
      if (shouldCloseNamespaceMenu(this.namespaceControl, target)) this.namespaceMenu.classList.add('hidden');
    });
    this.searchInput.addEventListener('input', () => this.debounceSearch());
    this.tableHeader.addEventListener('click', (event) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-kubernetes-sort]')
        : null;
      const column = kubernetesSortColumn(button?.dataset.kubernetesSort);
      if (!column) return;
      this.sort = nextKubernetesSort(this.sort, column);
      this.renderSortHeaders();
      void this.activateCurrentList();
    });
    this.customResourceSelect.addEventListener('change', () => this.selectCustomResourceDefinition());
    this.detailBackButton.addEventListener('click', () => { void this.closeDetail(); });
    this.detailPortForwardButton.addEventListener('click', () => this.openPortForwardDialog());
    this.detailTabs.addEventListener('click', (event) => {
      const target = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>('[data-detail-tab]') : null;
      const tab = target?.dataset.detailTab;
      if (tab === 'overview' || tab === 'yaml' || tab === 'events') void this.selectDetailTab(tab);
    });
    this.containerSelect.addEventListener('change', () => {
      this.openingTerminals.clear();
      this.selectedContainer = this.containerSelect.value || undefined;
      this.selectPodWorkspace('logs');
      this.renderLogPanel('follow');
      void this.openLogsForSelectedContainer();
    });
    this.logFollowButton.addEventListener('click', () => { void this.toggleLogFollowing(); });
    this.logClearButton.addEventListener('click', () => { void this.clearLogs(); });
    this.logSearch.addEventListener('input', () => this.renderLogPanel('preserve'));
    this.logTab.addEventListener('click', () => this.selectPodWorkspace('logs'));
    this.logTerminalTab.addEventListener('click', () => { void this.openTerminal(); });
    this.portForwardDeclaredPort.addEventListener('change', () => {
      this.portForwardRemotePort.value = this.portForwardDeclaredPort.value;
    });
    this.portForwardRemotePort.addEventListener('input', () => {
      this.portForwardDeclaredPort.value = '';
    });
    this.portForwardForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submitPortForward();
    });
    this.portForwardCancel.addEventListener('click', () => this.closePortForwardDialog());
    this.portForwardCancelSecondary.addEventListener('click', () => this.closePortForwardDialog());
    this.renderSortHeaders();
  }

  private ensureTerminalDrawer(): void {
    if (this.terminalDrawer) return;
    this.terminalDrawer = createKubernetesTerminalDrawer({
      root: this.terminalDrawerRoot,
      onInput: (id, data) => window.kubernetesApi.writeTerminal(id, data),
      onResize: (id, cols, rows) => window.kubernetesApi.resizeTerminal(id, cols, rows),
      onClose: (id) => window.kubernetesApi.closeTerminal(id),
    });
  }

  private ensureTable(): void {
    if (this.table) return;
    this.table = createKubernetesVirtualTable({
      container: this.tableViewport,
      rowHeight: VIRTUAL_ROW_HEIGHT,
      overscan: VIRTUAL_OVERSCAN,
      renderRow: (item) => this.renderRow(item),
      onNearEnd: () => this.loadMoreIfNeeded(),
      onWindowChange: (range) => this.requestVisibleWindow(range),
    });
  }

  private async waitForPriorDeactivation(pageGeneration: number): Promise<void> {
    await this.deactivation;
    if (!this.visible || pageGeneration !== this.pageGeneration) return;
    await this.loadStateAndActivate(pageGeneration);
  }

  private async loadStateAndActivate(pageGeneration = this.pageGeneration): Promise<void> {
    try {
      const state = await window.kubernetesApi.getState();
      if (!this.visible || pageGeneration !== this.pageGeneration) return;
      this.onStateChanged(state);
      await this.activateCurrentList();
    } catch (error) {
      if (this.visible && pageGeneration === this.pageGeneration) this.showError(toErrorMessage(error));
    }
  }

  private onStateChanged(state: KubernetesState): void {
    if (this.state?.selectedContext !== state.selectedContext) this.invalidateNamespaceOptions();
    if (this.customDefinitionsContext !== state.selectedContext) {
      this.customDefinitions = [];
      this.customDefinitionsContext = undefined;
      this.selectedCustomDefinition = undefined;
    }
    this.state = state;
    const scope = state.namespaceScope ?? { mode: 'all', namespaces: [] };
    this.selectedNamespaces = new Set(scope.namespaces);
    this.renderState();
    if (this.visible && state.connection === 'connected' && state.selectedContext
      && this.namespaceContext !== state.selectedContext
      && this.namespaceLoadingContext !== state.selectedContext) {
      void this.loadNamespaces(state.selectedContext);
    }
    if (this.visible && this.resourceKind === 'custom-resources' && state.connection === 'connected'
      && this.customDefinitionsContext !== state.selectedContext) {
      void this.loadCustomResourceDefinitions();
    }
  }

  private onListChanged(snapshot: KubernetesListSnapshot): void {
    const query = this.currentQuery();
    if (!this.visible || !query || !sameQuery(snapshot.query, query)) return;
    this.snapshot = snapshot;
    this.loadingMore = false;
    this.requestedContinuation = undefined;
    this.requestedWindow = undefined;
    if (snapshot.permissionDenied) {
      this.showNoPermission(snapshot.error ?? 'No permission to watch this Kubernetes resource.');
      return;
    }
    if (snapshot.error) {
      this.showError(snapshot.error);
      return;
    }
    if (!this.activeDetail) this.renderList();
  }

  private renderState(): void {
    const state = this.state;
    this.contextSelect.replaceChildren();
    if (!state?.contexts.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No kubeconfig contexts found';
      this.contextSelect.appendChild(option);
      this.contextSelect.disabled = true;
    } else {
      this.contextSelect.disabled = false;
      for (const context of state.contexts) {
        const option = document.createElement('option');
        option.value = context.name;
        option.textContent = context.supported ? context.displayName : `${context.displayName} (unsupported)`;
        option.selected = context.name === state.selectedContext;
        this.contextSelect.appendChild(option);
      }
    }

    this.connectionBadge.textContent = state?.connection ?? 'idle';
    this.connectionBadge.className = `kubernetes-connection kubernetes-connection-${state?.connection ?? 'idle'}`;
    const selected = state?.contexts.find((context) => context.name === state.selectedContext);
    this.renderTlsWarning(selected);
    const canReconnect = state?.connection === 'disconnected' && Boolean(selected?.supported);
    this.reconnectButton.classList.toggle('hidden', !canReconnect);
    this.reconnectButton.disabled = !canReconnect || this.reconnecting;
    this.reconnectButton.textContent = this.reconnecting ? 'Reconnecting…' : 'Reconnect';
    this.reloadButton.classList.toggle('hidden', !state?.kubeconfigReloadAvailable);
    this.namespaceToggle.disabled = state?.connection !== 'connected' || !state?.selectedContext;
    if (this.namespaceToggle.disabled) this.namespaceMenu.classList.add('hidden');
    this.renderNamespaceMenu();
    this.renderCategoryTabs();
    this.renderResourceTabs();
    this.renderCustomResourceControl();

    const unsupported = selected && !selected.supported;
    if (unsupported) {
      this.showError(this.unsupportedContextMessage(selected));
    }
  }

  private renderTlsWarning(context: KubernetesContextInfo | undefined): void {
    const tlsVerificationDisabled = Boolean(context?.tlsVerificationDisabled);
    this.tlsBadge.classList.toggle('hidden', !tlsVerificationDisabled);
    this.tlsBadge.textContent = tlsVerificationDisabled ? 'TLS verification disabled' : '';
  }

  private renderNamespaceMenu(): void {
    this.namespaceMenu.replaceChildren();
    const scope = this.currentScope();
    this.namespaceToggle.textContent = scope.mode === 'all'
      ? 'All Namespaces'
      : scope.namespaces.length === 1
        ? scope.namespaces[0]
        : `${scope.namespaces.length} Namespaces`;

    const allLabel = document.createElement('label');
    allLabel.className = 'kubernetes-namespace-option';
    const all = document.createElement('input');
    all.type = 'checkbox';
    all.checked = scope.mode === 'all';
    allLabel.append(all, document.createTextNode('All Namespaces'));
    all.addEventListener('change', () => {
      if (all.checked) {
        this.selectedNamespaces.clear();
        void this.setNamespaceScope({ mode: 'all', namespaces: [] });
      } else {
        // An empty selected scope is invalid. Adding a Namespace below moves
        // from All Namespaces to a concrete multi-selection instead.
        this.renderNamespaceMenu();
      }
    });
    this.namespaceMenu.appendChild(allLabel);

    if (this.namespaceLoadingContext === this.state?.selectedContext) {
      const status = document.createElement('p');
      status.className = 'kubernetes-namespace-status';
      status.textContent = 'Loading Namespaces…';
      this.namespaceMenu.appendChild(status);
      return;
    }

    const namespaces = [...new Set([...this.availableNamespaces, ...scope.namespaces])].sort();
    if (namespaces.length === 0) {
      const status = document.createElement('p');
      status.className = 'kubernetes-namespace-status';
      status.textContent = 'No Namespaces available';
      this.namespaceMenu.appendChild(status);
      return;
    }

    for (const namespace of namespaces) {
      const label = document.createElement('label');
      label.className = 'kubernetes-namespace-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = scope.mode === 'selected' && this.selectedNamespaces.has(namespace);
      input.dataset.namespace = namespace;
      label.append(input, document.createTextNode(namespace));
      input.addEventListener('change', () => {
        const next = updateNamespaceSelection(this.selectedNamespaces, namespace, input.checked);
        this.selectedNamespaces = new Set(next.namespaces);
        void this.setNamespaceScope(next);
      });
      this.namespaceMenu.appendChild(label);
    }
  }

  private renderCategoryTabs(): void {
    this.categoryTabs.replaceChildren();
    for (const category of Object.keys(RESOURCE_CATEGORIES) as KubernetesCategory[]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'kubernetes-category-tab';
      button.classList.toggle('kubernetes-tab-active', category === this.category);
      button.textContent = category;
      button.addEventListener('click', () => this.selectCategory(category));
      this.categoryTabs.appendChild(button);
    }
  }

  private renderResourceTabs(): void {
    this.resourceTabs.replaceChildren();
    const showTabs = categoryUsesResourceTabs(this.category);
    this.resourceTabs.classList.toggle('hidden', !showTabs);
    if (showTabs) {
      for (const kind of RESOURCE_CATEGORIES[this.category]) {
        const resourceKind = kind as KubernetesResourceKind;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'kubernetes-resource-tab';
        button.classList.toggle('kubernetes-tab-active', resourceKind === this.resourceKind);
        button.textContent = resourceLabel(resourceKind);
        button.addEventListener('click', () => this.selectResource(resourceKind));
        this.resourceTabs.appendChild(button);
      }
    }
    this.renderCustomResourceControl();
  }

  private renderSortHeaders(): void {
    const buttons = Array.from(this.tableHeader.querySelectorAll<HTMLButtonElement>('[data-kubernetes-sort]'));
    for (const button of buttons) {
      const column = kubernetesSortColumn(button.dataset.kubernetesSort);
      if (!column) continue;
      const active = column === this.sort.column;
      const direction = active ? this.sort.direction : undefined;
      button.classList.toggle('kubernetes-table-sort-active', active);
      if (direction) button.dataset.direction = direction;
      else delete button.dataset.direction;
      const header = button.closest('[role="columnheader"]') as HTMLElement | null;
      header?.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none');
      const label = button.dataset.sortLabel ?? column;
      button.setAttribute(
        'aria-label',
        direction ? `Sort by ${label}, currently ${direction === 'asc' ? 'ascending' : 'descending'}` : `Sort by ${label}`,
      );
    }
  }

  private renderCustomResourceControl(): void {
    const isCustomResource = this.resourceKind === 'custom-resources';
    this.customResourceControl.classList.toggle('hidden', !isCustomResource);
    if (!isCustomResource) return;
    this.customResourceSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = this.customDefinitions.length > 0
      ? 'Select a discovered Custom Resource'
      : 'Discovering Custom Resources…';
    this.customResourceSelect.appendChild(placeholder);
    for (const definition of this.customDefinitions) {
      const option = document.createElement('option');
      option.value = this.customDefinitionKey(definition);
      option.textContent = `${definition.group}/${definition.version} · ${definition.kind}`;
      option.selected = this.selectedCustomDefinition !== undefined
        && this.customDefinitionKey(this.selectedCustomDefinition) === option.value;
      this.customResourceSelect.appendChild(option);
    }
    this.customResourceSelect.disabled = !this.state?.selectedContext || this.customDefinitions.length === 0;
  }

  private selectCategory(category: KubernetesCategory): void {
    if (this.category === category) return;
    this.category = category;
    this.resourceKind = RESOURCE_CATEGORIES[category][0] as KubernetesResourceKind;
    this.snapshot = undefined;
    this.searchInput.value = '';
    this.renderCategoryTabs();
    this.renderResourceTabs();
    if (this.resourceKind === 'custom-resources') void this.loadCustomResourceDefinitions();
    void this.activateCurrentList();
  }

  private selectResource(kind: KubernetesResourceKind): void {
    if (this.resourceKind === kind) return;
    this.resourceKind = kind;
    this.snapshot = undefined;
    this.searchInput.value = '';
    this.renderResourceTabs();
    if (this.resourceKind === 'custom-resources') void this.loadCustomResourceDefinitions();
    void this.activateCurrentList();
  }

  private currentScope(): KubernetesNamespaceScope {
    const namespaces = [...this.selectedNamespaces].map((name) => name.trim()).filter(Boolean).sort();
    return namespaces.length === 0 ? { mode: 'all', namespaces: [] } : { mode: 'selected', namespaces };
  }

  private customDefinitionKey(definition: KubernetesCustomResourceDefinition): string {
    return `${definition.group}/${definition.version}:${definition.plural}:${definition.scope}`;
  }

  private async loadCustomResourceDefinitions(): Promise<void> {
    const context = this.state?.selectedContext;
    if (!this.visible || this.resourceKind !== 'custom-resources' || !context || this.state?.connection !== 'connected') {
      return;
    }
    this.renderCustomResourceControl();
    try {
      const definitions = await window.kubernetesApi.listCustomResourceDefinitions();
      if (!this.visible || this.resourceKind !== 'custom-resources' || this.state?.selectedContext !== context) return;
      this.customDefinitions = definitions;
      this.customDefinitionsContext = context;
      if (this.selectedCustomDefinition && !definitions.some((definition) => (
        this.customDefinitionKey(definition) === this.customDefinitionKey(this.selectedCustomDefinition as KubernetesCustomResourceDefinition)
      ))) {
        this.selectedCustomDefinition = undefined;
      }
      this.renderCustomResourceControl();
    } catch (error) {
      if (!this.visible || this.resourceKind !== 'custom-resources') return;
      if (isPermissionError(error)) this.showNoPermission(toErrorMessage(error));
      else this.showError(toErrorMessage(error));
    }
  }

  private selectCustomResourceDefinition(): void {
    const selected = this.customResourceSelect.value;
    this.selectedCustomDefinition = this.customDefinitions.find((definition) => this.customDefinitionKey(definition) === selected);
    this.snapshot = undefined;
    this.requestedWindow = undefined;
    void this.activateCurrentList();
  }

  private currentQuery(): KubernetesResourceQuery | undefined {
    const context = this.state?.selectedContext;
    if (!context) return undefined;
    if (this.resourceKind === 'custom-resources') {
      const definition = this.selectedCustomDefinition;
      if (!definition) return undefined;
      return {
        context,
        kind: 'custom-resources',
        apiVersion: `${definition.group}/${definition.version}`,
        plural: definition.plural,
        scope: definition.scope,
        namespaceScope: definition.scope === 'cluster' ? { mode: 'all', namespaces: [] } : this.currentScope(),
        ...(this.searchInput.value.trim() ? { nameFilter: this.searchInput.value.trim() } : {}),
        sort: { ...this.sort },
      };
    }
    const namespaceScope = isClusterScoped(this.resourceKind)
      ? { mode: 'all' as const, namespaces: [] }
      : this.currentScope();
    return {
      context,
      kind: this.resourceKind,
      ...(isClusterScoped(this.resourceKind) ? { scope: 'cluster' as const } : { scope: 'namespaced' as const }),
      namespaceScope,
      ...(this.searchInput.value.trim() ? { nameFilter: this.searchInput.value.trim() } : {}),
      sort: { ...this.sort },
    };
  }

  private async selectContext(context: string): Promise<void> {
    try {
      const state = await window.kubernetesApi.selectContext(context);
      if (!this.visible) return;
      this.snapshot = undefined;
      this.onStateChanged(state);
      await this.activateCurrentList();
    } catch (error) {
      this.showError(toErrorMessage(error));
    }
  }

  private async reloadKubeconfig(): Promise<void> {
    try {
      const state = await window.kubernetesApi.reloadKubeconfig();
      if (!this.visible) return;
      this.snapshot = undefined;
      this.invalidateNamespaceOptions();
      this.onStateChanged(state);
      await this.activateCurrentList();
    } catch (error) {
      this.showError(toErrorMessage(error));
    }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.state?.connection !== 'disconnected') {
      return;
    }
    this.reconnecting = true;
    this.renderState();
    try {
      const state = await window.kubernetesApi.reconnect();
      if (!this.visible) return;
      this.invalidateNamespaceOptions();
      this.onStateChanged(state);
      if (state.connection !== 'connected' && state.error) {
        this.showError(state.error);
      }
    } catch (error) {
      if (this.visible) this.showError(toErrorMessage(error));
    } finally {
      this.reconnecting = false;
      if (this.visible) this.renderState();
    }
  }

  private invalidateNamespaceOptions(): void {
    this.namespaceRequestGeneration += 1;
    this.availableNamespaces = [];
    this.namespaceContext = undefined;
    this.namespaceLoadingContext = undefined;
  }

  private async loadNamespaces(context: string): Promise<void> {
    const generation = ++this.namespaceRequestGeneration;
    this.namespaceLoadingContext = context;
    this.renderNamespaceMenu();
    try {
      const namespaces = await window.kubernetesApi.listNamespaces();
      if (!this.visible || generation !== this.namespaceRequestGeneration
        || this.state?.selectedContext !== context) return;
      this.availableNamespaces = [...new Set(namespaces.map((name) => name.trim()).filter(Boolean))].sort();
      this.namespaceContext = context;
    } catch (error) {
      if (this.visible && generation === this.namespaceRequestGeneration
        && this.state?.selectedContext === context) {
        setMessage(`Unable to load Namespaces: ${toErrorMessage(error)}`, 'error');
      }
    } finally {
      if (generation === this.namespaceRequestGeneration) {
        this.namespaceLoadingContext = undefined;
        if (this.visible) this.renderNamespaceMenu();
      }
    }
  }

  private async setNamespaceScope(scope: KubernetesNamespaceScope): Promise<void> {
    try {
      const state = await window.kubernetesApi.setNamespaceScope(scope);
      if (!this.visible) return;
      this.snapshot = undefined;
      this.onStateChanged(state);
      this.renderNamespaceMenu();
      await this.activateCurrentList();
    } catch (error) {
      this.showError(toErrorMessage(error));
    }
  }

  private debounceSearch(): void {
    if (this.searchTimer !== undefined) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = undefined;
      // The main process recognizes `nameFilter` as loaded-only, so this
      // refresh does not create an additional LIST or Watch connection.
      void this.activateCurrentList();
    }, SEARCH_DEBOUNCE_MS);
  }

  private async activateCurrentList(): Promise<void> {
    const query = this.currentQuery();
    const pageGeneration = this.pageGeneration;
    const generation = ++this.requestGeneration;
    this.clearTransientStates();
    if (!query) {
      this.snapshot = undefined;
      this.table?.setWindow({ start: 0, end: 0, total: 0, items: [] });
      this.loadedCount.textContent = this.resourceKind === 'custom-resources'
        ? 'Select a discovered Custom Resource definition to load instances.'
        : 'Choose a supported Kubernetes Context to load resources.';
      this.emptyState.textContent = this.loadedCount.textContent;
      this.emptyState.classList.remove('hidden');
      return;
    }
    const selected = this.state?.contexts.find((context) => context.name === query.context);
    if (selected && !selected.supported) {
      this.showError(this.unsupportedContextMessage(selected));
      return;
    }

    this.loadedCount.textContent = `Loading ${resourceLabel(query.kind)}…`;
    try {
      const snapshot = await window.kubernetesApi.listResources(query);
      if (
        !this.visible ||
        pageGeneration !== this.pageGeneration ||
        generation !== this.requestGeneration ||
        !sameQuery(query, this.currentQuery() ?? query)
      ) return;
      this.snapshot = snapshot;
      this.renderList();
    } catch (error) {
      if (!this.visible || pageGeneration !== this.pageGeneration || generation !== this.requestGeneration) return;
      if (isPermissionError(error)) {
        this.showNoPermission(toErrorMessage(error));
      } else {
        this.showError(toErrorMessage(error));
      }
    }
  }

  private renderList(): void {
    if (this.activeDetail) return;
    const snapshot = this.snapshot;
    const query = this.currentQuery();
    if (!snapshot || !query || !sameQuery(snapshot.query, query)) return;
    this.clearTransientStates();
    this.table?.setWindow(snapshot);
    this.renderSortHeaders();
    this.loadedCount.textContent = snapshot.continueToken
      ? `Loaded ${snapshot.loadedCount} ${resourceLabel(query.kind)} · more available`
      : `Loaded ${snapshot.loadedCount} ${resourceLabel(query.kind)}`;
    if (snapshot.total === 0) {
      this.emptyState.textContent = query.nameFilter ? 'No loaded resources match this name.' : 'No resources found.';
      this.emptyState.classList.remove('hidden');
    }
  }

  private requestVisibleWindow(range: { start: number; end: number }): void {
    const query = this.currentQuery();
    const snapshot = this.snapshot;
    if (!this.visible || !query || !snapshot || !sameQuery(snapshot.query, query)) {
      return;
    }
    if (snapshot.start <= range.start && snapshot.end >= range.end) {
      return;
    }
    const signature = `${range.start}:${range.end}`;
    if (this.requestedWindow === signature) {
      return;
    }
    this.requestedWindow = signature;
    const pageGeneration = this.pageGeneration;
    const requestGeneration = this.requestGeneration;
    void window.kubernetesApi.getResourceWindow(query, range).then((next) => {
      if (!this.visible || pageGeneration !== this.pageGeneration || requestGeneration !== this.requestGeneration
        || !sameQuery(next.query, this.currentQuery() ?? next.query)) {
        return;
      }
      this.snapshot = next;
      this.requestedWindow = undefined;
      this.renderList();
    }).catch((error) => {
      this.requestedWindow = undefined;
      if (!this.visible) return;
      if (isPermissionError(error)) this.showNoPermission(toErrorMessage(error));
      else this.showError(toErrorMessage(error));
    });
  }

  private loadMoreIfNeeded(): void {
    const snapshot = this.snapshot;
    const query = this.currentQuery();
    if (!this.visible || !snapshot?.continueToken || !query || this.loadingMore) return;
    if (!shouldAutomaticallyLoadMore(query)) return;
    if (this.requestedContinuation === snapshot.continueToken) return;
    this.loadingMore = true;
    this.requestedContinuation = snapshot.continueToken;
    void window.kubernetesApi.loadMoreResources(query).then((next) => {
      if (!this.visible || !sameQuery(next.query, this.currentQuery() ?? next.query)) return;
      this.snapshot = next;
      this.loadingMore = false;
      this.requestedContinuation = undefined;
      this.renderList();
    }).catch((error) => {
      this.loadingMore = false;
      if (!this.visible) return;
      if (isPermissionError(error)) this.showNoPermission(toErrorMessage(error));
      else this.showError(toErrorMessage(error));
    });
  }

  private setDetailTabsDisabled(disabled: boolean): void {
    for (const button of Array.from(this.detailTabs.querySelectorAll<HTMLButtonElement>('[data-detail-tab]'))) {
      button.disabled = disabled;
    }
  }

  private resetDetailLoadingState(generation: number): void {
    this.detailLoading = true;
    this.detailLoadingGeneration = generation;
    this.setDetailTabsDisabled(true);
    this.detailPortForwardButton.classList.add('hidden');
    this.detailPortForwardButton.disabled = true;
    this.detailPortSummary.textContent = '';
    this.closePortForwardDialog();
    this.logPanel.classList.add('hidden');
    this.logTerminalTab.disabled = true;
    this.detailPage.classList.remove('kubernetes-detail-pod');
  }

  private clearDetailLoadingState(): void {
    this.detailLoading = false;
    this.detailLoadingGeneration = undefined;
    this.setDetailTabsDisabled(false);
  }

  private finishDetailLoadingState(generation: number): void {
    if (!this.detailLoading || this.detailLoadingGeneration !== generation) return;
    this.clearDetailLoadingState();
  }

  private async openDetail(summary: KubernetesResourceSummary): Promise<void> {
    const query = this.currentQuery();
    const snapshot = this.snapshot;
    if (!query || !snapshot || this.activeDetail) return;
    this.openingTerminals.clear();
    this.selectPodWorkspace('logs');
    const detailGeneration = ++this.detailGeneration;
    this.resetDetailLoadingState(detailGeneration);
    this.detailBackStack = {
      query: { ...query, namespaceScope: { ...query.namespaceScope, namespaces: [...query.namespaceScope.namespaces] } },
      selectedUid: summary.uid,
      scrollTop: this.tableViewport.scrollTop,
      search: this.searchInput.value,
      sort: { ...this.sort },
    };
    this.listPage.classList.add('hidden');
    this.detailPage.classList.remove('hidden');
    this.detailTitle.textContent = `Loading ${resourceLabel(query.kind)}…`;
    this.detailSubtitle.textContent = '';
    this.detailOverview.replaceChildren();
    try {
      const detail = await window.kubernetesApi.getResourceDetail(query, summary.name, summary.namespace);
      if (!this.visible || detailGeneration !== this.detailGeneration || !this.detailBackStack) return;
      this.finishDetailLoadingState(detailGeneration);
      this.activeDetail = { query, summary, detail, tab: 'overview' };
      this.decodedSecretDetail = query.kind === 'secrets' ? decodeSecretForActiveView(detail) : undefined;
      this.detailEventsLoaded = false;
      this.selectedContainer = undefined;
      this.renderDetail();
    } catch (error) {
      if (!this.visible || detailGeneration !== this.detailGeneration) return;
      setMessage(toErrorMessage(error), 'error');
      await this.closeDetail();
    }
  }

  private async closeDetail(): Promise<void> {
    const backStack = this.detailBackStack;
    const closingGeneration = this.detailGeneration;
    this.detailGeneration += 1;
    this.openingTerminals.clear();
    this.terminalWorkspaceSessionId = undefined;
    // This must happen before closeDetailLogs awaits remote cleanup. A late
    // relation response must never re-render a detail the user already left.
    this.invalidateRelatedDetail();
    await this.closeDetailLogs();
    if (!isCurrentKubernetesDetailClose(closingGeneration, this.detailGeneration)) return;
    this.activeDetail = undefined;
    this.decodedSecretDetail = undefined;
    this.detailYaml.textContent = '';
    this.selectedContainer = undefined;
    this.detailEventsLoaded = false;
    this.detailEvents.replaceChildren();
    this.detailRelated.replaceChildren();
    this.detailRelated.classList.add('hidden');
    this.detailPage.classList.add('hidden');
    this.clearDetailLoadingState();
    this.listPage.classList.remove('hidden');
    this.detailBackStack = undefined;
    if (!backStack) return;
    this.searchInput.value = backStack.search;
    this.sort = { ...backStack.sort };
    this.renderSortHeaders();
    this.renderList();
    window.requestAnimationFrame(() => {
      this.tableViewport.scrollTop = backStack.scrollTop;
      const visibleStart = Math.floor(backStack.scrollTop / VIRTUAL_ROW_HEIGHT);
      const visibleRows = Math.ceil(this.tableViewport.clientHeight / VIRTUAL_ROW_HEIGHT);
      this.requestVisibleWindow({
        start: Math.max(0, visibleStart - VIRTUAL_OVERSCAN),
        end: visibleStart + visibleRows + VIRTUAL_OVERSCAN,
      });
    });
  }

  private displayDetail(): Record<string, unknown> | undefined {
    if (!this.activeDetail) return undefined;
    return this.decodedSecretDetail ?? this.activeDetail.detail;
  }

  private renderDetail(): void {
    if (this.detailLoading) return;
    const active = this.activeDetail;
    const detail = this.displayDetail();
    if (!active || !detail) return;
    this.detailTitle.textContent = detailName(active);
    this.detailSubtitle.textContent = resourceLabel(active.query.kind);
    this.renderDetailTabs(active.tab);
    this.renderOverview(detail, active);
    const yaml = this.detailYaml;
    try {
      yaml.textContent = serializeKubernetesDetailYaml(detail);
    } catch (error) {
      yaml.textContent = toErrorMessage(error);
    }
    this.detailYamlSection.classList.toggle('hidden', active.tab !== 'yaml');
    this.detailOverview.classList.toggle('hidden', active.tab !== 'overview');
    this.detailEvents.classList.toggle('hidden', active.tab !== 'events');
    this.renderPodActions(detail, active);
    this.renderRelatedDetail(detail, active);
  }

  private renderDetailTabs(tab: DetailTab): void {
    for (const button of Array.from(this.detailTabs.querySelectorAll<HTMLButtonElement>('[data-detail-tab]'))) {
      button.classList.toggle('kubernetes-detail-tab-active', button.dataset.detailTab === tab);
    }
  }

  private renderOverview(detail: Record<string, unknown>, active: ActiveDetail): void {
    this.detailOverview.replaceChildren();
    const fields = buildKubernetesOverviewFields(detail, {
      kind: resourceLabel(active.query.kind),
      name: active.summary.name,
      namespace: active.summary.namespace,
      status: active.summary.status,
    });
    const list = document.createElement('dl');
    list.className = 'kubernetes-detail-overview-grid';
    for (const field of fields) {
      const item = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = field.label;
      const description = document.createElement('dd');
      description.textContent = field.value;
      description.title = field.value;
      if (field.label === 'Status') {
        const dot = document.createElement('span');
        dot.className = 'kubernetes-status-dot';
        description.prepend(dot);
      }
      item.append(term, description);
      list.appendChild(item);
    }
    this.detailOverview.appendChild(list);
  }

  private async selectDetailTab(tab: DetailTab): Promise<void> {
    if (this.detailLoading) return;
    const active = this.activeDetail;
    if (!active) return;
    active.tab = tab;
    this.renderDetail();
    if (tab !== 'events' || this.detailEventsLoaded) return;
    this.detailEventsLoaded = true;
    this.detailEvents.textContent = 'Loading events…';
    try {
      const events = await window.kubernetesApi.getResourceEvents(active.summary.uid, active.summary.namespace);
      if (this.activeDetail !== active || active.tab !== 'events') return;
      this.renderEvents(events);
    } catch (error) {
      if (this.activeDetail !== active) return;
      this.detailEvents.textContent = `Unable to load Events: ${toErrorMessage(error)}`;
    }
  }

  private renderEvents(events: KubernetesResourceSummary[]): void {
    this.detailEvents.replaceChildren();
    if (events.length === 0) {
      this.detailEvents.textContent = 'No Events found for this resource.';
      return;
    }
    const list = document.createElement('div');
    list.className = 'kubernetes-events-list';
    for (const event of events) {
      const row = document.createElement('div');
      row.className = 'kubernetes-event-row';
      const name = document.createElement('strong');
      name.textContent = event.name;
      const status = document.createElement('span');
      status.textContent = event.status ?? 'Event';
      const age = document.createElement('span');
      age.textContent = formatAge(event.createdAt);
      row.append(name, status, age);
      list.appendChild(row);
    }
    this.detailEvents.appendChild(list);
  }

  private renderPodActions(detail: Record<string, unknown>, active: ActiveDetail): void {
    const isPod = active.query.kind === 'pods';
    const targetKind = active.query.kind === 'pods' ? 'pod'
      : active.query.kind === 'services' ? 'service'
        : undefined;
    const declaredPorts = targetKind ? detectKubernetesForwardPorts(detail, targetKind) : [];
    this.detailPage.classList.toggle('kubernetes-detail-pod', isPod);
    this.detailPortForwardButton.classList.toggle('hidden', !targetKind);
    this.detailPortForwardButton.disabled = !targetKind || !active.summary.namespace;
    this.detailPortSummary.textContent = declaredPorts.length === 0
      ? 'No declared TCP ports'
      : declaredPorts.length === 1
        ? `1 declared · ${declaredPorts[0].remotePort}`
        : `${declaredPorts.length} declared`;
    this.logPanel.classList.toggle('hidden', !isPod);
    this.logTerminalTab.disabled = true;
    applyKubernetesPodWorkspace(this.podWorkspace, {
      logsTab: this.logTab,
      terminalTab: this.logTerminalTab,
      hideTerminalDrawer: () => this.terminalDrawer?.hide(),
    });
    if (!isPod) return;
    const containers = containerNames(detail);
    const all = [...containers.regular, ...containers.init];
    if (!this.selectedContainer || !all.includes(this.selectedContainer)) this.selectedContainer = containers.regular[0] ?? containers.init[0];
    this.containerSelect.replaceChildren();
    for (const name of containers.regular) this.appendContainerOption(name, name, false);
    for (const name of containers.init) this.appendContainerOption(name, `Init: ${name}`, true);
    this.containerSelect.value = this.selectedContainer ?? '';
    const enabled = Boolean(this.selectedContainer && active.summary.namespace);
    this.logTerminalTab.disabled = !enabled;
    this.renderLogPanel();
    if (enabled) void this.openLogsForSelectedContainer();
  }

  private appendContainerOption(value: string, label: string, init: boolean): void {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = init ? `${label} (init)` : label;
    this.containerSelect.appendChild(option);
  }

  /**
   * Related resources are intentionally collapsed until a user expands this
   * detail-only section. The active resource list owns Watch lifecycle, so no
   * relation path may activate a list or replace its snapshot.
   */
  private renderRelatedDetail(detail: Record<string, unknown>, active: ActiveDetail): void {
    const state = this.relatedState(active);
    this.detailRelated.replaceChildren();
    this.detailRelated.classList.toggle('hidden', !state);
    if (!state) return;

    const section = document.createElement('section');
    section.className = 'kubernetes-related-section';
    const header = document.createElement('header');
    header.className = 'kubernetes-related-head';
    const heading = document.createElement('h3');
    heading.className = 'subcard-title';
    heading.textContent = active.query.kind === 'services' ? 'Backend resources' : 'Related Pods';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-secondary btn-sm';
    toggle.disabled = state.loading;
    toggle.textContent = state.loading ? 'Loading…' : state.expanded ? 'Collapse' : 'Expand';
    toggle.addEventListener('click', () => {
      if (state.loading || this.activeDetail !== active || !this.visible) return;
      state.expanded = !state.expanded;
      this.renderRelatedDetail(detail, active);
      if (state.expanded && !state.resources && !state.error) {
        void this.loadRelatedResources(active, state);
      }
    });
    header.append(heading, toggle);
    section.appendChild(header);

    if (!state.expanded) {
      this.detailRelated.appendChild(section);
      return;
    }
    if (state.error) {
      const error = document.createElement('p');
      error.className = 'kubernetes-related-feedback';
      error.textContent = state.error;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-secondary btn-sm';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        if (!state.loading && this.activeDetail === active && this.visible) {
          state.error = undefined;
          void this.loadRelatedResources(active, state);
        }
      });
      section.append(error, retry);
    } else if (state.loading) {
      const loading = document.createElement('p');
      loading.className = 'kubernetes-related-feedback';
      loading.textContent = 'Loading related resources…';
      section.appendChild(loading);
    } else if (state.resources) {
      section.appendChild(this.renderRelatedResources(active, state.resources));
    }
    this.detailRelated.appendChild(section);
  }

  private relatedState(active: ActiveDetail): RelatedDetailState | undefined {
    if (active.query.kind !== 'services' && active.query.kind !== 'deployments' && active.query.kind !== 'statefulsets') {
      return undefined;
    }
    active.related ??= { expanded: false, loading: false };
    return active.related;
  }

  private relatedRequest(active: ActiveDetail): KubernetesRelatedResourceRequest | undefined {
    const namespace = active.summary.namespace;
    if (!namespace) return undefined;
    if (active.query.kind === 'services') {
      return { kind: 'service', namespace, name: active.summary.name };
    }
    if (active.query.kind === 'deployments' || active.query.kind === 'statefulsets') {
      const selector = workloadSelector(active.detail);
      if (!selector) return undefined;
      return {
        kind: active.query.kind === 'deployments' ? 'deployment' : 'statefulset',
        namespace,
        name: active.summary.name,
        selector,
      };
    }
    return undefined;
  }

  /** Detach an old relation state synchronously before replacing or leaving a detail. */
  private invalidateRelatedDetail(active: ActiveDetail | undefined = this.activeDetail): void {
    this.relatedGeneration += 1;
    if (active) active.related = undefined;
    this.detailRelated.replaceChildren();
    this.detailRelated.classList.add('hidden');
  }

  private isCurrentRelatedRequest(
    active: ActiveDetail,
    state: RelatedDetailState,
    detailGeneration: number,
    relatedGeneration: number,
  ): boolean {
    return this.visible
      && this.activeDetail === active
      && active.related === state
      && state.expanded
      && this.detailGeneration === detailGeneration
      && this.relatedGeneration === relatedGeneration;
  }

  private async loadRelatedResources(active: ActiveDetail, state: RelatedDetailState): Promise<void> {
    if (!this.visible || this.activeDetail !== active || !state.expanded || state.loading) return;
    const detailGeneration = this.detailGeneration;
    const relatedGeneration = ++this.relatedGeneration;
    const isCurrent = (): boolean => this.isCurrentRelatedRequest(active, state, detailGeneration, relatedGeneration);
    if (!isCurrent()) return;
    const request = this.relatedRequest(active);
    if (!request) {
      if (!isCurrent()) return;
      state.error = active.query.kind === 'services'
        ? 'Backend resources are unavailable because this Service has no Namespace.'
        : 'No selector is available for this Workload.';
      if (!isCurrent()) return;
      this.renderRelatedDetail(active.detail, active);
      return;
    }
    await runRelatedResourceRequest(
      () => window.kubernetesApi.getRelatedResources(request),
      {
        isCurrent,
        onLoading: () => {
          if (!isCurrent()) return;
          state.loading = true;
          if (!isCurrent()) return;
          this.renderRelatedDetail(active.detail, active);
        },
        onSuccess: (resources) => {
          if (!isCurrent()) return;
          state.resources = resources;
          if (!isCurrent()) return;
          state.error = undefined;
        },
        onError: (error) => {
          if (!isCurrent()) return;
          state.error = isPermissionError(error)
            ? 'No permission to read related resources.'
            : `Unable to load related resources: ${toErrorMessage(error)}`;
        },
        onComplete: () => {
          if (!isCurrent()) return;
          state.loading = false;
          if (!isCurrent()) return;
          this.renderRelatedDetail(active.detail, active);
        },
      },
    );
  }

  private renderRelatedResources(active: ActiveDetail, resources: KubernetesRelatedResources): HTMLElement {
    const container = document.createElement('div');
    container.className = 'kubernetes-related-list';
    const groups: Array<[string, KubernetesResourceSummary[], boolean]> = active.query.kind === 'services'
      ? [
        ['Endpoints', resources.endpoints ?? [], false],
        ['EndpointSlices', resources.endpointSlices ?? [], false],
      ]
      : [['Pods', resources.pods ?? [], true]];
    const hasItems = groups.some(([, values]) => values.length > 0);
    if (!hasItems) {
      const empty = document.createElement('p');
      empty.className = 'kubernetes-related-feedback';
      empty.textContent = active.query.kind === 'services' ? 'No backend resources found.' : 'No related Pods found.';
      container.appendChild(empty);
      return container;
    }
    for (const [label, values, podLink] of groups) {
      if (values.length === 0) continue;
      const heading = document.createElement('h4');
      heading.textContent = label;
      container.appendChild(heading);
      for (const item of values) {
        const row = document.createElement(podLink ? 'button' : 'div');
        row.className = podLink ? 'kubernetes-related-row kubernetes-related-pod-link' : 'kubernetes-related-row';
        if (row instanceof HTMLButtonElement) {
          row.type = 'button';
          row.addEventListener('click', () => { void this.openRelatedPod(active, item); });
        }
        const name = document.createElement('span');
        name.textContent = item.namespace ? `${item.namespace}/${item.name}` : item.name;
        const status = document.createElement('span');
        status.textContent = item.status ?? label;
        row.append(name, status);
        container.appendChild(row);
      }
    }
    return container;
  }

  private async openRelatedPod(active: ActiveDetail, summary: KubernetesResourceSummary): Promise<void> {
    if (!this.visible || this.activeDetail !== active || !summary.namespace) return;
    const query: KubernetesResourceQuery = {
      context: active.query.context,
      kind: 'pods',
      scope: 'namespaced',
      namespaceScope: { mode: 'selected', namespaces: [summary.namespace] },
    };
    // Do this before any await: related-resource completion belongs only to
    // the previous Workload detail and cannot repaint over the linked Pod.
    this.invalidateRelatedDetail(active);
    this.openingTerminals.clear();
    this.selectPodWorkspace('logs');
    const generation = ++this.detailGeneration;
    this.resetDetailLoadingState(generation);
    this.detailTitle.textContent = 'Loading Pod…';
    this.detailSubtitle.textContent = '';
    await this.closeDetailLogs();
    if (!this.visible || generation !== this.detailGeneration || this.activeDetail !== active) return;
    try {
      const detail = await window.kubernetesApi.getResourceDetail(query, summary.name, summary.namespace);
      if (!this.visible || generation !== this.detailGeneration || this.activeDetail !== active) return;
      this.finishDetailLoadingState(generation);
      this.activeDetail = { query, summary, detail, tab: 'overview' };
      this.decodedSecretDetail = undefined;
      this.detailEventsLoaded = false;
      this.selectedContainer = undefined;
      this.renderDetail();
    } catch (error) {
      if (this.visible && generation === this.detailGeneration && this.activeDetail === active) {
        this.finishDetailLoadingState(generation);
        this.renderDetail();
        setMessage(toErrorMessage(error), 'error');
      }
    }
  }

  private activeLog(): KubernetesLogState | undefined {
    return this.selectedContainer ? this.logsByContainer.get(this.selectedContainer) : undefined;
  }

  private selectPodWorkspace(workspace: KubernetesPodWorkspace): void {
    this.podWorkspace = workspace;
    if (workspace === 'logs') this.terminalWorkspaceSessionId = undefined;
    applyKubernetesPodWorkspace(workspace, {
      logsTab: this.logTab,
      terminalTab: this.logTerminalTab,
      hideTerminalDrawer: () => this.terminalDrawer?.hide(),
    });
  }

  private cancelLogAutoScroll(): void {
    this.logViewport.cancel();
  }

  private renderLogPanel(intent: KubernetesLogScrollIntent = 'incidental'): void {
    this.logViewport.render(intent);
  }

  private async openLogsForSelectedContainer(): Promise<void> {
    const target = this.selectedPodTarget();
    if (!target) return;
    const existing = this.logsByContainer.get(target.container);
    if (existing) return;
    const openingKey = `${target.namespace}\u0000${target.podName}\u0000${target.container}`;
    const openingToken = claimKubernetesLogOpen(this.openingLogs, openingKey);
    if (!openingToken) return;
    const active = this.activeDetail;
    const detailGeneration = this.detailGeneration;
    this.logErrorsByContainer.delete(target.container);
    this.renderLogPanel();
    try {
      const state = await window.kubernetesApi.openLogs(target);
      if (!this.visible || this.activeDetail !== active || this.detailGeneration !== detailGeneration
        || this.selectedContainer !== target.container) {
        await window.kubernetesApi.closeLogs(state.sessionId).catch(() => undefined);
        return;
      }
      this.logErrorsByContainer.delete(target.container);
      applyKubernetesLogUpdate(
        this.logsByContainer,
        this.selectedContainer,
        state,
        this.logViewport,
        'follow',
        true,
      );
    } catch (error) {
      if (this.activeDetail === active && this.detailGeneration === detailGeneration) {
        const message = toErrorMessage(error);
        applyKubernetesLogOpenFailure({
          requests: this.openingLogs,
          key: openingKey,
          token: openingToken,
          selectedContainer: this.selectedContainer,
          targetContainer: target.container,
          cache: () => this.logErrorsByContainer.set(target.container, `Unable to load logs: ${message}`),
          renderSelected: () => {
            this.renderLogPanel();
            setMessage(message, 'error');
          },
        });
      }
    } finally {
      releaseKubernetesLogOpen(this.openingLogs, openingKey, openingToken);
    }
  }

  private async toggleLogFollowing(): Promise<void> {
    await runKubernetesLogFollowToggle({
      sessions: this.logsByContainer,
      mutations: this.logFollowMutations,
      getSelectedContainer: () => this.selectedContainer,
      viewport: this.logViewport,
      setFollowing: (sessionId, following) => window.kubernetesApi.setLogFollowing(sessionId, following),
      onError: (error) => setMessage(toErrorMessage(error), 'error'),
    });
  }

  private async clearLogs(): Promise<void> {
    const log = this.activeLog();
    if (!log) return;
    try {
      const next = await window.kubernetesApi.clearLogs(log.sessionId);
      applyKubernetesLogUpdate(
        this.logsByContainer,
        this.selectedContainer,
        next,
        this.logViewport,
        'preserve',
      );
    } catch (error) {
      setMessage(toErrorMessage(error), 'error');
    }
  }

  private async closeDetailLogs(): Promise<void> {
    this.cancelLogAutoScroll();
    const logs = [...this.logsByContainer.values()];
    this.logsByContainer.clear();
    this.logFollowMutations.clear();
    this.openingLogs.clear();
    this.logErrorsByContainer.clear();
    this.logSearch.value = '';
    this.renderLogPanel();
    await Promise.all(logs.map((log) => window.kubernetesApi.closeLogs(log.sessionId).catch(() => undefined)));
  }

  private onLogChanged(state: KubernetesLogState): void {
    const active = this.activeDetail;
    if (!active || active.query.kind !== 'pods') return;
    if (state.podName !== active.summary.name || state.namespace !== active.summary.namespace) return;
    if (!shouldApplyKubernetesLogBroadcast(this.logFollowMutations, state)) return;
    applyKubernetesLogUpdate(
      this.logsByContainer,
      this.selectedContainer,
      state,
      this.logViewport,
      'follow',
    );
  }

  private selectedPodTarget(): KubernetesPodTarget | undefined {
    const active = this.activeDetail;
    if (!active || active.query.kind !== 'pods' || !active.summary.namespace || !this.selectedContainer) return undefined;
    return { namespace: active.summary.namespace, podName: active.summary.name, container: this.selectedContainer };
  }

  private async openTerminal(): Promise<void> {
    const target = this.selectedPodTarget();
    if (!target) return;
    this.selectPodWorkspace('terminal');
    const active = this.activeDetail;
    const detailGeneration = this.detailGeneration;
    await openKubernetesTerminalWorkspace({
      target,
      requests: this.openingTerminals,
      selectWorkspace: (workspace) => {
        if (this.podWorkspace !== workspace) this.selectPodWorkspace(workspace);
      },
      focusTarget: (candidate) => this.terminalDrawer?.focusTarget(candidate),
      focusSession: (id) => this.terminalDrawer?.focusSession(id) ?? false,
      claimSession: (id) => {
        this.terminalWorkspaceSessionId = id;
      },
      openDrawer: (state) => this.terminalDrawer?.open(state, false),
      requestTerminal: (candidate) => window.kubernetesApi.openTerminal(candidate),
      isCurrent: () => this.visible
        && this.activeDetail === active
        && this.detailGeneration === detailGeneration
        && this.podWorkspace === 'terminal'
        && sameKubernetesPodTarget(this.selectedPodTarget(), target),
      reportError: (error) => setMessage(toErrorMessage(error), 'error'),
    });
  }

  private onTerminalChanged(state: KubernetesTerminalState): void {
    if (!this.visible) return;
    if (state.state === 'closed' || state.state === 'error') {
      this.terminalDrawer?.open(state);
      const selectedTarget = this.selectedPodTarget();
      const replacementSessionId = selectedTarget
        ? this.terminalDrawer?.sessionIdForTarget(selectedTarget)
        : undefined;
      routeKubernetesTerminalFinalState({
        state,
        selectedTarget,
        workspace: this.podWorkspace,
        workspaceSessionId: this.terminalWorkspaceSessionId,
        replacementSessionId,
        claimSession: (id) => {
          this.terminalWorkspaceSessionId = id;
        },
        selectLogs: () => this.selectPodWorkspace('logs'),
        reportError: () => setMessage(state.error ?? 'Kubernetes terminal failed.', 'error'),
      });
      return;
    }
    this.terminalDrawer?.open(state, false);
  }

  private onTerminalOutput(output: KubernetesTerminalOutput): void {
    this.terminalDrawer?.write(output.id, output.data);
  }

  private openPortForwardDialog(): void {
    if (this.detailLoading || this.detailPortForwardButton.disabled) return;
    const active = this.activeDetail;
    const detail = this.displayDetail();
    const targetKind = active?.query.kind === 'pods' ? 'pod'
      : active?.query.kind === 'services' ? 'service'
        : undefined;
    if (!active || !detail || !targetKind || !active.summary.namespace) return;
    if (this.portForwards.size >= 10) {
      setMessage('Kubernetes supports at most 10 active port forwards.', 'error');
      return;
    }
    const declaredPorts = detectKubernetesForwardPorts(detail, targetKind);
    const dialogModel = buildKubernetesPortForwardDialogModel(declaredPorts);
    this.portForwardDraft = {
      targetKind,
      namespace: active.summary.namespace,
      targetName: active.summary.name,
    };
    this.portForwardTitle.textContent = `Port Forward ${targetKind === 'pod' ? 'Pod' : 'Service'}`;
    this.portForwardTarget.textContent = `${active.summary.namespace}/${active.summary.name}`;
    this.portForwardDeclaredPort.replaceChildren();
    if (dialogModel.selectorVisible) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Choose a declared port';
      placeholder.selected = true;
      placeholder.disabled = true;
      this.portForwardDeclaredPort.appendChild(placeholder);
    }
    for (const port of declaredPorts) {
      const option = document.createElement('option');
      option.value = String(port.remotePort);
      option.textContent = formatKubernetesDeclaredPortLabel(port);
      this.portForwardDeclaredPort.appendChild(option);
    }
    this.portForwardDeclaredPort.value = '';
    this.portForwardDeclaredField.classList.toggle('hidden', !dialogModel.selectorVisible);
    this.portForwardHint.textContent = declaredPorts.length === 1
      ? `${formatKubernetesDeclaredPortLabel(declaredPorts[0])}. ${dialogModel.hint}`
      : dialogModel.hint;
    this.portForwardRemotePort.value = dialogModel.remotePort;
    this.portForwardLocalPort.value = '';
    this.setPortForwardError('');
    if (!this.portForwardDialog.open) this.portForwardDialog.showModal();
  }

  private closePortForwardDialog(): void {
    if (this.portForwardDialog.open) this.portForwardDialog.close();
    this.portForwardDraft = undefined;
    this.portForwardDeclaredField.classList.add('hidden');
    this.portForwardDeclaredPort.replaceChildren();
    this.portForwardHint.textContent = '';
    this.setPortForwardError('');
  }

  private async submitPortForward(): Promise<void> {
    const draft = this.portForwardDraft;
    if (!draft) return;
    const remotePort = this.parsePort(this.portForwardRemotePort.value, 'Remote port', false);
    const localPort = this.parsePort(this.portForwardLocalPort.value, 'Local port', true);
    if (remotePort === undefined || remotePort === null || localPort === null) return;
    const input: KubernetesPortForwardInput = {
      ...draft,
      remotePort,
      ...(localPort === undefined ? {} : { localPort }),
    };
    try {
      const state = await window.kubernetesApi.startPortForward(input);
      this.portForwards.set(state.id, state);
      this.renderPortForwards();
      this.closePortForwardDialog();
      setMessage('Port forward started.', 'success');
    } catch (error) {
      const message = toErrorMessage(error);
      this.setPortForwardError(message);
      setMessage(message, 'error');
    }
  }

  private parsePort(value: string, label: string, optional: boolean): number | undefined | null {
    if (!value.trim()) {
      if (optional) return undefined;
      this.setPortForwardError(`${label} must be an integer between 1 and 65535.`);
      return null;
    }
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      this.setPortForwardError(`${label} must be an integer between 1 and 65535.`);
      return null;
    }
    this.setPortForwardError('');
    return port;
  }

  private setPortForwardError(message: string): void {
    this.portForwardError.textContent = message;
    this.portForwardError.classList.toggle('hidden', !message);
  }

  private async loadPortForwards(): Promise<void> {
    try {
      const forwards = await window.kubernetesApi.listPortForwards();
      this.portForwards = new Map(forwards.map((forward) => [forward.id, forward]));
      this.renderPortForwards();
    } catch (error) {
      setMessage(toErrorMessage(error), 'error');
    }
  }

  private onPortForwardChanged(state: KubernetesPortForwardState): void {
    if (state.state === 'stopped') this.portForwards.delete(state.id);
    else this.portForwards.set(state.id, state);
    this.renderPortForwards();
  }

  private renderPortForwards(): void {
    this.portForwardList.replaceChildren();
    const forwards = [...this.portForwards.values()];
    this.portForwardPanel.classList.toggle('hidden', forwards.length === 0);
    if (forwards.length === 0) return;
    for (const forward of forwards) {
      const row = document.createElement('div');
      row.className = 'kubernetes-port-forward-row';
      const target = document.createElement('span');
      target.textContent = `${forward.namespace}/${forward.targetName}`;
      const mapping = document.createElement('span');
      mapping.textContent = `127.0.0.1:${forward.localPort} → ${forward.remotePort}`;
      const state = document.createElement('span');
      state.textContent = forward.error ? `${forward.state}: ${forward.error}` : forward.state;
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'btn btn-secondary btn-sm';
      stop.textContent = 'Stop';
      stop.disabled = forward.state !== 'running' && forward.state !== 'starting';
      stop.addEventListener('click', () => {
        void window.kubernetesApi.stopPortForward(forward.id).catch((error) => setMessage(toErrorMessage(error), 'error'));
      });
      row.append(target, mapping, state, stop);
      this.portForwardList.appendChild(row);
    }
  }

  private renderRow(item: KubernetesResourceSummary): HTMLElement {
    const row = document.createElement('div');
    row.className = 'kubernetes-table-row';
    row.setAttribute('role', 'row');
    row.tabIndex = 0;
    const fields = [item.name, item.namespace ?? '—', item.status ?? '—', formatAge(item.createdAt)];
    for (const value of fields) {
      const cell = document.createElement('span');
      cell.className = 'kubernetes-table-cell';
      cell.setAttribute('role', 'cell');
      cell.textContent = value;
      row.appendChild(cell);
    }
    row.addEventListener('click', () => { void this.openDetail(item); });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void this.openDetail(item);
      }
    });
    return row;
  }

  private clearTransientStates(): void {
    this.emptyState.classList.add('hidden');
    this.noPermission.classList.add('hidden');
    this.errorState.classList.add('hidden');
  }

  private showNoPermission(message: string): void {
    this.clearTransientStates();
    this.table?.setWindow({ start: 0, end: 0, total: 0, items: [] });
    this.noPermission.textContent = `No permission: ${message}`;
    this.noPermission.classList.remove('hidden');
    this.loadedCount.textContent = 'No permission';
  }

  private showError(message: string): void {
    this.clearTransientStates();
    this.table?.setWindow({ start: 0, end: 0, total: 0, items: [] });
    this.errorState.textContent = message;
    this.errorState.classList.remove('hidden');
    this.loadedCount.textContent = 'Unable to load resources';
  }

  private unsupportedContextMessage(context: KubernetesContextInfo): string {
    if (context.unsupportedReason === 'exec-auth') {
      return 'This Context uses exec authentication, which is not supported.';
    }
    return 'This Context does not have supported token or client-certificate authentication.';
  }
}

let page: KubernetesPage | undefined;

export function registerKubernetesPage(): void {
  page ??= new KubernetesPage();
  registerPage({
    id: 'kubernetes',
    title: 'Kubernetes',
    icon: KUBERNETES_NAV_ICON,
    onShow: () => page?.show(),
    onHide: () => page?.hide(),
  });
}
