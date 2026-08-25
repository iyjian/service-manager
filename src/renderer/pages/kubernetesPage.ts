import type {
  KubernetesContextInfo,
  KubernetesCustomResourceDefinition,
  KubernetesCustomResourcePrinterColumn,
  KubernetesListSnapshot,
  KubernetesNamespaceScope,
  KubernetesPodEnvironment,
  KubernetesPodTarget,
  KubernetesPortForwardInput,
  KubernetesPortForwardState,
  KubernetesRelatedResourceRequest,
  KubernetesRelatedResources,
  KubernetesResourceKind,
  KubernetesResourceQuery,
  KubernetesResourceSummary,
  KubernetesState,
} from '../../shared/types';
import { common, createLowlight } from 'lowlight';
import { CODE_HIGHLIGHT_LIMITS } from '../codeHighlight.js';
import {
  findNotesTextMatches,
  initialNotesFindIndex,
  moveNotesFindIndex,
  type NotesFindMatch,
} from '../models/notesFind.js';
import {
  customResourcePrinterColumnKey,
} from '../models/kubernetesCustomResourcePrinterColumns.js';
import { registerPage } from './nav.js';
import { createKubernetesVirtualTable, type KubernetesVirtualTable } from '../components/kubernetesVirtualTable.js';
import { renderTextTabs } from '../components/tabs.js';
import {
  bindListboxKeyboardNavigation,
  closeDropdownOnFocusOut,
  focusSelectedMenuOption,
  isDropdownMenuOpen,
  setDropdownMenuOpen,
  shouldCloseDropdownMenu,
} from '../components/selectMenu.js';
import {
  buildKubernetesDrawerModel,
  detectKubeVirtVncTarget,
  environmentUnavailableLabel,
  filterKubernetesEnvironmentEntries,
  shouldRenderKubernetesEnvironment,
  type KubernetesDrawerContainer,
} from '../models/kubernetesDrawerModel.js';
import { createKubernetesWorkspace, type KubernetesWorkspace } from '../components/kubernetesWorkspace.js';
import {
  buildKubernetesOverviewFields,
  buildKubernetesPortForwardDialogModel,
  detectKubernetesForwardPorts,
  hasActiveKubernetesPortForward,
} from '../models/kubernetesDetailModel.js';
import { buildKubernetesCustomResourceDetailModel } from '../models/kubernetesCustomResourceModel.js';
import {
  buildKubernetesBuiltinDetailModel,
  isKubernetesBuiltinDetailKind,
  type KubernetesBuiltinDetailCondition,
  type KubernetesBuiltinDetailSection,
} from '../models/kubernetesBuiltinResourceModel.js';

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

function createKubernetesDrawerIcon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const value of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', value);
    svg.appendChild(path);
  }
  return svg;
}

function createKubernetesSortIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('kubernetes-sort-icon');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [className, pathData] of [
    ['kubernetes-sort-icon-up', 'm3.5 4.5 2.5-2.5 2.5 2.5'],
    ['kubernetes-sort-icon-down', 'm3.5 7.5 2.5 2.5 2.5-2.5'],
  ]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.classList.add(className);
    path.setAttribute('d', pathData);
    svg.appendChild(path);
  }
  return svg;
}

export const RESOURCE_CATEGORIES = {
  Workloads: ['pods', 'deployments', 'statefulsets'],
  Network: ['services', 'ingresses'],
  Configuration: ['configmaps', 'secrets'],
  Storage: ['persistentvolumeclaims'],
  'Custom Resources': ['custom-resources'],
} as const;

const SEARCH_DEBOUNCE_MS = 200;
const VIRTUAL_ROW_HEIGHT = 36;
const VIRTUAL_OVERSCAN = 8;
/** Lens-style reactive Age: tick every second while young rows are visible, then once a minute. */
const AGE_REFRESH_SECOND_MS = 1_000;
const AGE_REFRESH_MINUTE_MS = 60_000;
const AGE_REFRESH_SECONDS_UP_TO_MINUTES = 10;

type KubernetesCategory = keyof typeof RESOURCE_CATEGORIES;
type KubernetesSortColumn = string;

export interface KubernetesListColumn {
  key: string;
  label: string;
}

const KUBERNETES_LIST_COLUMNS: Record<KubernetesResourceKind, readonly KubernetesListColumn[]> = {
  pods: [
    { key: 'namespace', label: 'Namespace' },
    { key: 'name', label: 'Name' },
    { key: 'cpu', label: 'CPU' },
    { key: 'memory', label: 'Memory' },
    { key: 'restarts', label: 'Restarts' },
    { key: 'status', label: 'Status' },
    { key: 'node', label: 'Node' },
    { key: 'age', label: 'Age' },
  ],
  deployments: [
    { key: 'namespace', label: 'Namespace' },
    { key: 'name', label: 'Name' },
    { key: 'ready', label: 'Ready' },
    { key: 'updated', label: 'Up-to-date' },
    { key: 'available', label: 'Available' },
    { key: 'unavailable', label: 'Unavailable' },
    { key: 'strategy', label: 'Strategy' },
    { key: 'age', label: 'Age' },
  ],
  statefulsets: [
    { key: 'namespace', label: 'Namespace' },
    { key: 'name', label: 'Name' },
    { key: 'ready', label: 'Ready' },
    { key: 'current', label: 'Current' },
    { key: 'updated', label: 'Updated' },
    { key: 'service', label: 'Service' },
    { key: 'strategy', label: 'Strategy' },
    { key: 'age', label: 'Age' },
  ],
  services: [
    { key: 'namespace', label: 'Namespace' },
    { key: 'name', label: 'Name' },
    { key: 'type', label: 'Type' },
    { key: 'clusterIP', label: 'Cluster IP' },
    { key: 'externalIP', label: 'External IP' },
    { key: 'ports', label: 'Ports' },
    { key: 'selector', label: 'Selector' },
    { key: 'age', label: 'Age' },
  ],
  ingresses: [
    { key: 'namespace', label: 'Namespace' },
    { key: 'name', label: 'Name' },
    { key: 'class', label: 'Class' },
    { key: 'hosts', label: 'Hosts' },
    { key: 'address', label: 'Address' },
    { key: 'ports', label: 'Ports' },
    { key: 'tls', label: 'TLS' },
    { key: 'age', label: 'Age' },
  ],
  configmaps: [
    { key: 'namespace', label: 'Namespace' },
    { key: 'name', label: 'Name' },
    { key: 'data', label: 'Data' },
    { key: 'binary', label: 'Binary Data' },
    { key: 'immutable', label: 'Immutable' },
    { key: 'labels', label: 'Labels' },
    { key: 'annotations', label: 'Annotations' },
    { key: 'age', label: 'Age' },
  ],
  secrets: [
    { key: 'namespace', label: 'Namespace' },
    { key: 'name', label: 'Name' },
    { key: 'type', label: 'Type' },
    { key: 'data', label: 'Data Keys' },
    { key: 'immutable', label: 'Immutable' },
    { key: 'labels', label: 'Labels' },
    { key: 'annotations', label: 'Annotations' },
    { key: 'age', label: 'Age' },
  ],
  persistentvolumeclaims: [
    { key: 'namespace', label: 'Namespace' },
    { key: 'name', label: 'Name' },
    { key: 'status', label: 'Status' },
    { key: 'volume', label: 'Volume' },
    { key: 'capacity', label: 'Capacity' },
    { key: 'accessModes', label: 'Access Modes' },
    { key: 'storageClass', label: 'Storage Class' },
    { key: 'age', label: 'Age' },
  ],
  'custom-resources': [
    { key: 'namespace', label: 'Namespace' },
    { key: 'name', label: 'Name' },
    { key: 'kind', label: 'Kind' },
    { key: 'apiVersion', label: 'API Version' },
    { key: 'status', label: 'Status' },
    { key: 'generation', label: 'Generation' },
    { key: 'labels', label: 'Labels' },
    { key: 'age', label: 'Age' },
  ],
  nodes: [
    { key: 'name', label: 'Name' },
    { key: 'status', label: 'Status' },
    { key: 'roles', label: 'Roles' },
    { key: 'version', label: 'Version' },
    { key: 'internalIP', label: 'Internal IP' },
    { key: 'os', label: 'OS' },
    { key: 'kernel', label: 'Kernel' },
    { key: 'age', label: 'Age' },
  ],
  namespaces: [
    { key: 'name', label: 'Name' },
    { key: 'status', label: 'Status' },
    { key: 'labels', label: 'Labels' },
    { key: 'annotations', label: 'Annotations' },
    { key: 'finalizers', label: 'Finalizers' },
    { key: 'phase', label: 'Phase' },
    { key: 'resourceVersion', label: 'Version' },
    { key: 'age', label: 'Age' },
  ],
};

const CUSTOM_RESOURCE_FALLBACK_COLUMNS: readonly KubernetesListColumn[] = [
  { key: 'kind', label: 'Kind' },
  { key: 'apiVersion', label: 'API Version' },
  { key: 'status', label: 'Status' },
  { key: 'generation', label: 'Generation' },
  { key: 'labels', label: 'Labels' },
  { key: 'resourceVersion', label: 'Version' },
];

function visibleCustomResourcePrinterColumns(
  definition: KubernetesCustomResourceDefinition,
): Array<{ column: KubernetesCustomResourcePrinterColumn; index: number }> {
  return (definition.printerColumns ?? [])
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !['age', 'name', 'namespace'].includes(column.name.toLocaleLowerCase()))
    .sort((left, right) => left.column.priority - right.column.priority || left.index - right.index);
}

export function getKubernetesCustomResourceListColumns(
  definition: KubernetesCustomResourceDefinition,
): readonly KubernetesListColumn[] {
  const base = definition.scope === 'namespaced'
    ? [{ key: 'namespace', label: 'Namespace' }, { key: 'name', label: 'Name' }]
    : [{ key: 'name', label: 'Name' }];
  const available = 8 - base.length - 1;
  const middle: KubernetesListColumn[] = [];
  const labels = new Set(base.map(({ label }) => label.toLocaleLowerCase()));
  for (const { column, index } of visibleCustomResourcePrinterColumns(definition)) {
    const normalized = column.name.toLocaleLowerCase();
    if (labels.has(normalized) || middle.length >= available) continue;
    labels.add(normalized);
    middle.push({ key: customResourcePrinterColumnKey(index), label: column.name });
  }
  for (const fallback of CUSTOM_RESOURCE_FALLBACK_COLUMNS) {
    const normalized = fallback.label.toLocaleLowerCase();
    if (labels.has(normalized) || middle.length >= available) continue;
    labels.add(normalized);
    middle.push(fallback);
  }
  return [...base, ...middle, { key: 'age', label: 'Age' }];
}

export function getKubernetesListColumns(
  kind: KubernetesResourceKind,
  customDefinition?: KubernetesCustomResourceDefinition,
): readonly KubernetesListColumn[] {
  return kind === 'custom-resources' && customDefinition
    ? getKubernetesCustomResourceListColumns(customDefinition)
    : KUBERNETES_LIST_COLUMNS[kind];
}

interface KubernetesSortState {
  column: KubernetesSortColumn;
  direction: 'asc' | 'desc';
}

interface KubernetesPageController {
  show(): void;
  hide(): void;
  destroy(): void;
}

export interface KubernetesDrawerRequest {
  visible: boolean;
  pageGeneration: number;
  drawerGeneration: number;
  uid: string;
}

interface ActiveDetail {
  /** The page/list query that owns this drawer, distinct from a related-Pod fetch query. */
  originQuery: KubernetesResourceQuery;
  query: KubernetesResourceQuery;
  summary: KubernetesResourceSummary;
  detail: Record<string, unknown>;
  request: KubernetesDrawerRequest;
  related?: RelatedDetailState;
  eventsLoading?: boolean;
  events?: KubernetesResourceSummary[];
  eventsError?: string;
  eventsExpanded?: boolean;
  expandedSections?: Map<string, boolean>;
  customExpandedSections?: Set<string>;
}

interface RelatedDetailState {
  expanded: boolean;
  loading: boolean;
  resources?: KubernetesRelatedResources;
  error?: string;
}

interface DrawerEnvironmentState {
  target: KubernetesPodTarget;
  drawerGeneration: number;
  loading: boolean;
  expanded: boolean;
  search: string;
  result?: KubernetesPodEnvironment;
  error?: 'permission' | 'unavailable';
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

export function isPermissionError(error: unknown): boolean {
  return /\b(?:401|403|forbidden|unauthorized|no permission|permission denied)\b/i.test(toErrorMessage(error));
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

function kubernetesListValue(column: KubernetesListColumn, item: KubernetesResourceSummary): string {
  if (column.key === 'namespace') return item.namespace ?? '—';
  if (column.key === 'name') return item.name;
  if (column.key === 'status') return item.status ?? item.columns.status ?? '—';
  if (column.key === 'age') return formatAge(item.createdAt);
  if (column.key === 'resourceVersion') return item.resourceVersion;
  return item.columns[column.key] ?? '—';
}

export function getKubernetesResourceRowValues(
  kind: KubernetesResourceKind,
  item: KubernetesResourceSummary,
  customDefinition?: KubernetesCustomResourceDefinition,
): string[] {
  return getKubernetesListColumns(kind, customDefinition).map((column) => kubernetesListValue(column, item));
}

export function splitKubernetesDeploymentPodName(name: string): { primary: string; suffix: string } {
  const match = /^(.+?)(-[a-z0-9]{8,10}-[a-z0-9]{4,5})$/.exec(name);
  return match
    ? { primary: match[1], suffix: match[2] }
    : { primary: name, suffix: '' };
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

export function filterKubernetesNamespaces(namespaces: Iterable<string>, query: string): string[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return [...new Set([...namespaces].map((name) => name.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .filter((name) => !normalizedQuery || name.toLocaleLowerCase().includes(normalizedQuery));
}

export function filterKubernetesCustomResourceDefinitions(
  definitions: Iterable<KubernetesCustomResourceDefinition>,
  query: string,
): KubernetesCustomResourceDefinition[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return [...definitions]
    .sort((left, right) => (
      left.group.localeCompare(right.group)
      || left.kind.localeCompare(right.kind)
      || left.version.localeCompare(right.version)
    ))
    .filter((definition) => !normalizedQuery || [
      definition.kind,
      definition.plural,
      definition.group,
      definition.version,
      `${definition.group}/${definition.version}`,
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)));
}

export interface KubernetesCustomResourceDefinitionGroup {
  group: string;
  definitions: KubernetesCustomResourceDefinition[];
}

export function groupKubernetesCustomResourceDefinitions(
  definitions: Iterable<KubernetesCustomResourceDefinition>,
  query: string,
): KubernetesCustomResourceDefinitionGroup[] {
  const groups = new Map<string, KubernetesCustomResourceDefinition[]>();
  for (const definition of filterKubernetesCustomResourceDefinitions(definitions, query)) {
    const values = groups.get(definition.group) ?? [];
    values.push(definition);
    groups.set(definition.group, values);
  }
  return [...groups.entries()].map(([group, values]) => ({ group, definitions: values }));
}

export function formatKubernetesResourceKindLabel(kind: string): string {
  return kind
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\bI Pv(?=\d)/g, 'IPv')
    .replace(/\bO Auth\b/g, 'OAuth')
    .trim();
}

export function kubernetesCustomResourceDefinitionKey(
  definition: KubernetesCustomResourceDefinition,
): string {
  return `${definition.group}/${definition.version}:${definition.plural}:${definition.scope}`;
}

export function rebindKubernetesCustomResourceDefinition(
  definitions: Iterable<KubernetesCustomResourceDefinition>,
  selected: KubernetesCustomResourceDefinition | undefined,
): KubernetesCustomResourceDefinition | undefined {
  if (!selected) return undefined;
  const selectedKey = kubernetesCustomResourceDefinitionKey(selected);
  return [...definitions].find((definition) => (
    kubernetesCustomResourceDefinitionKey(definition) === selectedKey
  ));
}

export function hasCurrentKubernetesCustomResourceDefinitions(
  selectedContext: string,
  definitionsContext: string | undefined,
  reloadContext: string | undefined,
): boolean {
  return definitionsContext === selectedContext && reloadContext !== selectedContext;
}

export interface KubernetesContextActivationIntent {
  id: number;
  context: string;
  pageGeneration: number;
}

export type KubernetesContextActivationDecision = 'wait' | 'activate' | 'terminal' | 'stale';

export function decideKubernetesContextActivation(
  intent: KubernetesContextActivationIntent,
  state: Pick<KubernetesState, 'selectedContext' | 'connection'>,
  visible: boolean,
  pageGeneration: number,
): KubernetesContextActivationDecision {
  if (!visible || intent.pageGeneration !== pageGeneration) return 'stale';
  if (state.selectedContext && state.selectedContext !== intent.context) return 'wait';
  if (!state.selectedContext && state.connection !== 'disconnected' && state.connection !== 'unsupported-auth') {
    return 'wait';
  }
  if (state.connection === 'connected') return 'activate';
  if (state.connection === 'connecting' || state.connection === 'reconnecting') return 'wait';
  return 'terminal';
}

export function shouldCloseKubernetesSelectorMenu(
  control: Pick<HTMLElement, 'contains'>,
  target: Node | null,
): boolean {
  return shouldCloseDropdownMenu(control, target);
}

export function nextKubernetesSort(
  current: KubernetesSortState,
  column: KubernetesSortColumn,
): KubernetesSortState {
  return current.column === column
    ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
    : { column, direction: 'asc' };
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

/** Exact visible drawer and target fence for active-only Env completions. */
export function isCurrentKubernetesEnvironmentRequest(
  current: { visible: boolean; drawerGeneration: number; target: KubernetesPodTarget },
  candidate: { visible: boolean; drawerGeneration: number; target: KubernetesPodTarget },
): boolean {
  return current.visible === candidate.visible
    && current.visible
    && current.drawerGeneration === candidate.drawerGeneration
    && sameKubernetesPodTarget(current.target, candidate.target);
}

export function categoryUsesResourceTabs(category: KubernetesCategory): boolean {
  return category !== 'Custom Resources';
}

function kubernetesSortColumn(
  value: string | undefined,
  kind: KubernetesResourceKind,
  customDefinition?: KubernetesCustomResourceDefinition,
): KubernetesSortColumn | undefined {
  return value && getKubernetesListColumns(kind, customDefinition).some((column) => column.key === value)
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

const kubernetesYamlLowlight = createLowlight(common);

interface KubernetesHighlightNode {
  type?: unknown;
  value?: unknown;
  tagName?: unknown;
  properties?: unknown;
  children?: unknown;
}

function appendKubernetesHighlightNode(parent: Node, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const node = value as KubernetesHighlightNode;
  if (node.type === 'text' && typeof node.value === 'string') {
    parent.appendChild(document.createTextNode(node.value));
    return;
  }
  if (node.type !== 'element' || node.tagName !== 'span' || !Array.isArray(node.children)) return;
  const span = document.createElement('span');
  if (node.properties && typeof node.properties === 'object') {
    const classNames = (node.properties as { className?: unknown }).className;
    if (Array.isArray(classNames)) {
      for (const className of classNames) {
        if (typeof className === 'string' && /^hljs-[a-z0-9_-]+$/.test(className)) span.classList.add(className);
      }
    }
  }
  for (const child of node.children) appendKubernetesHighlightNode(span, child);
  parent.appendChild(span);
}

function detailName(detail: ActiveDetail): string {
  return detail.summary.namespace
    ? `${detail.summary.namespace}/${detail.summary.name}`
    : detail.summary.name;
}

/**
 * Scroll-near-end continuation stays available only for unfiltered views. A
 * filtered view instead drains every remaining page through `loadMorePages`
 * so search covers the complete resource list like Lens's full-list filter.
 */
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

/**
 * Applies a detail result only while its drawer still belongs to the same
 * visible page/list query. Related Pods deliberately fetch with `kind: pods`
 * while their originating list remains a Deployment or StatefulSet.
 */
export async function runKubernetesDrawerDetailRequest<T>(
  load: () => Promise<T>,
  lifecycle: {
    isCurrent: () => boolean;
    onSuccess: (detail: T) => void;
    onError: (error: unknown) => void;
  },
): Promise<void> {
  if (!lifecycle.isCurrent()) return;
  try {
    const detail = await load();
    if (!lifecycle.isCurrent()) return;
    lifecycle.onSuccess(detail);
  } catch (error) {
    if (!lifecycle.isCurrent()) return;
    lifecycle.onError(error);
  }
}

/** Exact page/drawer/summary ownership guard for every asynchronous drawer result. */
export function isCurrentKubernetesDrawerRequest(
  current: KubernetesDrawerRequest,
  candidate: KubernetesDrawerRequest,
): boolean {
  return current.visible
    && candidate.visible
    && current.pageGeneration === candidate.pageGeneration
    && current.drawerGeneration === candidate.drawerGeneration
    && current.uid === candidate.uid;
}

/**
 * Adds page/list-query ownership to the exact drawer request fence. The
 * detail fetch query may be different for a related Pod, so it must not be
 * compared to the current resource-list query here.
 */
export function isCurrentKubernetesDrawerListRequest(
  pageVisible: boolean,
  current: KubernetesDrawerRequest,
  candidate: KubernetesDrawerRequest,
  currentListQuery: KubernetesResourceQuery | undefined,
  originListQuery: KubernetesResourceQuery,
): boolean {
  return pageVisible
    && isCurrentKubernetesDrawerRequest(current, candidate)
    && currentListQuery !== undefined
    && sameQuery(currentListQuery, originListQuery);
}

class KubernetesPage implements KubernetesPageController {
  private readonly contextToggle = requireElement<HTMLButtonElement>('#kubernetes-context-toggle');
  private readonly contextValue = requireElement<HTMLElement>('#kubernetes-context-value');
  private readonly contextControl = requireElement<HTMLElement>('#kubernetes-context-control');
  private readonly contextMenu = requireElement<HTMLDivElement>('#kubernetes-context-menu');
  private readonly connectionBadge = requireElement<HTMLElement>('#kubernetes-connection');
  private readonly reconnectButton = requireElement<HTMLButtonElement>('#kubernetes-reconnect');
  private readonly reloadButton = requireElement<HTMLButtonElement>('#kubernetes-reload-kubeconfig');
  private readonly namespaceToggle = requireElement<HTMLButtonElement>('#kubernetes-namespace-toggle');
  private readonly namespaceValue = requireElement<HTMLElement>('#kubernetes-namespace-value');
  private readonly namespaceControl = requireElement<HTMLElement>('#kubernetes-namespace-control');
  private readonly namespaceMenu = requireElement<HTMLDivElement>('#kubernetes-namespace-menu');
  private readonly namespaceSearch = requireElement<HTMLInputElement>('#kubernetes-namespace-search');
  private readonly namespaceAll = requireElement<HTMLDivElement>('#kubernetes-namespace-all');
  private readonly namespaceOptions = requireElement<HTMLDivElement>('#kubernetes-namespace-options');
  private readonly categoryTabs = requireElement<HTMLDivElement>('#kubernetes-category-tabs');
  private readonly resourceTabs = requireElement<HTMLDivElement>('#kubernetes-resource-tabs');
  private readonly secondaryRow = requireElement<HTMLElement>('.kubernetes-secondary-row');
  private readonly customResourceControl = requireElement<HTMLElement>('#kubernetes-custom-resource-control');
  private readonly customResourceToggle = requireElement<HTMLButtonElement>('#kubernetes-custom-resource-toggle');
  private readonly customResourceValue = requireElement<HTMLElement>('#kubernetes-custom-resource-value');
  private readonly customResourceMenu = requireElement<HTMLDivElement>('#kubernetes-custom-resource-menu');
  private readonly customResourceSearch = requireElement<HTMLInputElement>('#kubernetes-custom-resource-search');
  private readonly customResourceOptions = requireElement<HTMLDivElement>('#kubernetes-custom-resource-options');
  private readonly searchInput = requireElement<HTMLInputElement>('#kubernetes-resource-search');
  private readonly tableShell = requireElement<HTMLElement>('#kubernetes-table-shell');
  private readonly tableHeader = requireElement<HTMLElement>('#kubernetes-table-header');
  private readonly loadedCount = requireElement<HTMLElement>('#kubernetes-loaded-count');
  private readonly tableViewport = requireElement<HTMLDivElement>('#kubernetes-table-viewport');
  private readonly emptyState = requireElement<HTMLElement>('#kubernetes-empty-state');
  private readonly noPermission = requireElement<HTMLElement>('#kubernetes-no-permission');
  private readonly errorState = requireElement<HTMLElement>('#kubernetes-error-state');
  private readonly detailDrawer = requireElement<HTMLElement>('#kubernetes-detail-drawer');
  private readonly detailDrawerScrim = requireElement<HTMLButtonElement>('#kubernetes-detail-drawer-scrim');
  private readonly detailCloseButton = requireElement<HTMLButtonElement>('#kubernetes-detail-close');
  private readonly detailTitle = requireElement<HTMLElement>('#kubernetes-detail-title');
  private readonly detailVncButton = requireElement<HTMLButtonElement>('#kubernetes-detail-vnc');
  private readonly detailVncLabel = requireElement<HTMLElement>('#kubernetes-detail-vnc-label');
  private readonly detailPortForwardButton = requireElement<HTMLButtonElement>('#kubernetes-detail-port-forward');
  private readonly detailYamlToggle = requireElement<HTMLButtonElement>('#kubernetes-detail-yaml-toggle');
  private readonly detailYamlCopy = requireElement<HTMLButtonElement>('#kubernetes-detail-yaml-copy');
  private readonly detailOverview = requireElement<HTMLElement>('#kubernetes-detail-overview');
  private readonly detailYamlWrap = requireElement<HTMLElement>('#kubernetes-detail-yaml-wrap');
  private readonly detailYaml = requireElement<HTMLPreElement>('#kubernetes-detail-yaml');
  private readonly detailYamlFind = requireElement<HTMLElement>('#kubernetes-detail-yaml-find');
  private readonly detailYamlFindInput = requireElement<HTMLInputElement>('#kubernetes-detail-yaml-find-input');
  private readonly detailYamlFindCounter = requireElement<HTMLElement>('#kubernetes-detail-yaml-find-counter');
  private readonly detailYamlFindPrevious = requireElement<HTMLButtonElement>('#kubernetes-detail-yaml-find-previous');
  private readonly detailYamlFindNext = requireElement<HTMLButtonElement>('#kubernetes-detail-yaml-find-next');
  private readonly detailYamlFindClose = requireElement<HTMLButtonElement>('#kubernetes-detail-yaml-find-close');
  private readonly workspaceRoot = requireElement<HTMLElement>('#kubernetes-workspace');
  private readonly workspaceResizeHandle = requireElement<HTMLElement>('#kubernetes-workspace-resize-handle');
  private readonly workspaceTabs = requireElement<HTMLElement>('#kubernetes-workspace-tabs');
  private readonly workspacePane = requireElement<HTMLElement>('#kubernetes-workspace-pane');
  private readonly portForwardsToggle = requireElement<HTMLButtonElement>('#kubernetes-port-forwards-toggle');
  private readonly portForwardsCount = requireElement<HTMLElement>('#kubernetes-port-forwards-count');
  private readonly portForwardsDialog = requireElement<HTMLDialogElement>('#kubernetes-port-forwards-dialog');
  private readonly portForwardsCloseAll = requireElement<HTMLButtonElement>('#kubernetes-port-forwards-close-all');
  private readonly portForwardsClose = requireElement<HTMLButtonElement>('#kubernetes-port-forwards-close');
  private readonly portForwardList = requireElement<HTMLElement>('#kubernetes-port-forward-list');
  private readonly portForwardDialog = requireElement<HTMLDialogElement>('#kubernetes-port-forward-dialog');
  private readonly portForwardForm = requireElement<HTMLFormElement>('#kubernetes-port-forward-form');
  private readonly portForwardTitle = requireElement<HTMLElement>('#kubernetes-port-forward-title');
  private readonly portForwardDeclaredField = requireElement<HTMLElement>('#kubernetes-port-forward-declared-field');
  private readonly portForwardDeclaredPort = requireElement<HTMLSelectElement>('#kubernetes-port-forward-declared-port');
  private readonly portForwardRemotePort = requireElement<HTMLInputElement>('#kubernetes-port-forward-remote-port');
  private readonly portForwardLocalPort = requireElement<HTMLInputElement>('#kubernetes-port-forward-local-port');
  private readonly portForwardOpenBrowser = requireElement<HTMLInputElement>('#kubernetes-port-forward-open-browser');
  private readonly portForwardError = requireElement<HTMLElement>('#kubernetes-port-forward-error');
  private readonly portForwardCancel = requireElement<HTMLButtonElement>('#kubernetes-port-forward-cancel');
  private readonly portForwardCancelSecondary = requireElement<HTMLButtonElement>('#kubernetes-port-forward-cancel-secondary');
  private category: KubernetesCategory = 'Workloads';
  private resourceKind: KubernetesResourceKind = 'pods';
  private sort: KubernetesSortState = { column: 'name', direction: 'asc' };
  private customDefinitions: KubernetesCustomResourceDefinition[] = [];
  private customDefinitionsContext: string | undefined;
  private selectedCustomDefinition: KubernetesCustomResourceDefinition | undefined;
  private customDefinitionFilter = '';
  private customDefinitionsLoadingContext: string | undefined;
  private customDefinitionsLoad: { context: string; promise: Promise<boolean> } | undefined;
  private customDefinitionsRequestGeneration = 0;
  private customDefinitionsReloadContext: string | undefined;
  private reloadingKubeconfig = false;
  private state: KubernetesState | undefined;
  private snapshot: KubernetesListSnapshot | undefined;
  private table: KubernetesVirtualTable | undefined;
  private visible = false;
  private ageRefreshTimer?: number;
  private loadingMore = false;
  private requestedContinuation: string | undefined;
  private requestedWindow: string | undefined;
  private searchTimer: number | undefined;
  private reconnecting = false;
  private contextActivationIntentGeneration = 0;
  private pendingContextActivation: KubernetesContextActivationIntent | undefined;
  private requestGeneration = 0;
  private selectedNamespaces = new Set<string>();
  private availableNamespaces: string[] = [];
  private namespaceContext: string | undefined;
  private namespaceLoadingContext: string | undefined;
  private namespaceRequestGeneration = 0;
  private namespaceFilter = '';
  private unsubscribeState: (() => void) | undefined;
  private unsubscribeList: (() => void) | undefined;
  private unsubscribeLog: (() => void) | undefined;
  private unsubscribeTerminal: (() => void) | undefined;
  private unsubscribeTerminalOutput: (() => void) | undefined;
  private unsubscribePortForward: (() => void) | undefined;
  private bound = false;
  private pageGeneration = 0;
  private deactivation: Promise<void> = Promise.resolve();
  private activeDetail: ActiveDetail | undefined;
  private detailGeneration = 0;
  private detailYamlCopyResetTimer?: number;
  private yamlFindOpen = false;
  private yamlFindMatches: readonly NotesFindMatch[] = [];
  private yamlFindActiveIndex = -1;
  private yamlFindTruncated = false;
  private yamlFindFrame?: number;
  private vncOpening: { drawerGeneration: number } | undefined;
  private drawerRequest: KubernetesDrawerRequest = {
    visible: false,
    pageGeneration: 0,
    drawerGeneration: 0,
    uid: '',
  };
  private relatedGeneration = 0;
  /** Plaintext Secret material may exist only while its drawer detail is active. */
  private decodedSecretDetail: Record<string, unknown> | undefined;
  /** Active-drawer-only decoded Env values; never copied to a cache or workspace. */
  private drawerEnvironment: DrawerEnvironmentState | undefined;
  private drawerEnvironmentElement: HTMLElement | undefined;
  private workspace: KubernetesWorkspace | undefined;
  private portForwards = new Map<string, KubernetesPortForwardState>();
  private portForwardRevision = 0;
  private portForwardDraft: PortForwardDraft | undefined;
  private closingAllPortForwards = false;

  public show(): void {
    if (this.visible) return;
    this.visible = true;
    this.startAgeRefresh();
    const pageGeneration = ++this.pageGeneration;
    this.ensureBound();
    this.ensureTable();
    this.ensureWorkspace();
    this.unsubscribeState = window.kubernetesApi.onStateChanged((state) => this.onStateChanged(state));
    this.unsubscribeList = window.kubernetesApi.onListChanged((snapshot) => this.onListChanged(snapshot));
    this.unsubscribeLog = window.kubernetesApi.onLogChanged((state) => this.workspace?.onLogChanged(state));
    this.unsubscribeTerminal = window.kubernetesApi.onTerminalChanged((state) => this.workspace?.onTerminalChanged(state));
    this.unsubscribeTerminalOutput = window.kubernetesApi.onTerminalOutput((output) => this.workspace?.onTerminalOutput(output));
    this.unsubscribePortForward = window.kubernetesApi.onPortForwardChanged((state) => this.onPortForwardChanged(state));
    void this.loadPortForwards();
    void this.waitForPriorDeactivation(pageGeneration);
  }

  public hide(): void {
    if (!this.visible) return;
    this.closeSelectorMenus();
    this.cancelContextActivation();
    this.clearDrawerEnvironment();
    this.visible = false;
    this.stopAgeRefresh();
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
    this.closePortForwardsDialog();
    this.closePortForwardDialog();
    this.closeDetail();
    this.table?.dispose();
    this.table = undefined;
    this.deactivation = this.disposeWorkspace().then(
      () => window.kubernetesApi.deactivatePage(),
      () => window.kubernetesApi.deactivatePage(),
    ).catch((error) => {
      console.error('[kubernetes:deactivate-page]', error);
    });
  }

  public destroy(): void {
    this.hide();
  }

  private ensureWorkspace(): void {
    if (this.workspace) return;
    this.workspace = createKubernetesWorkspace({
      root: this.workspaceRoot,
      resizeHandle: this.workspaceResizeHandle,
      tabList: this.workspaceTabs,
      pane: this.workspacePane,
      openLogs: (target) => window.kubernetesApi.openLogs(target),
      setLogScope: (id, scope) => window.kubernetesApi.setLogScope(id, scope),
      setLogStartTime: (id, startTime) => window.kubernetesApi.setLogStartTime(id, startTime),
      setLogFollowing: (id, following) => window.kubernetesApi.setLogFollowing(id, following),
      clearLogs: (id) => window.kubernetesApi.clearLogs(id),
      closeLogs: (id) => window.kubernetesApi.closeLogs(id),
      openTerminal: (target) => window.kubernetesApi.openTerminal(target),
      writeTerminal: (id, data) => window.kubernetesApi.writeTerminal(id, data),
      resizeTerminal: (id, cols, rows) => window.kubernetesApi.resizeTerminal(id, cols, rows),
      closeTerminal: (id) => window.kubernetesApi.closeTerminal(id),
      reportError: (error) => setMessage(toErrorMessage(error), 'error'),
    });
  }

  /** Keep the workspace reference until all owned remote sessions are closed. */
  private async disposeWorkspace(): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) return;
    await workspace.dispose();
    if (this.workspace === workspace) this.workspace = undefined;
  }

  private disposeWorkspaceForLifecycle(): void {
    void this.disposeWorkspace().then(() => {
      if (this.visible && this.state?.connection === 'connected') this.ensureWorkspace();
    }).catch((error) => {
      console.error('[kubernetes:workspace-dispose]', error);
    });
  }

  private setContextMenuOpen(open: boolean): void {
    setDropdownMenuOpen(this.contextToggle, this.contextMenu, open);
  }

  private setNamespaceMenuOpen(open: boolean): void {
    setDropdownMenuOpen(this.namespaceToggle, this.namespaceMenu, open);
  }

  private setCustomResourceMenuOpen(open: boolean): void {
    setDropdownMenuOpen(this.customResourceToggle, this.customResourceMenu, open, {
      disabled: this.resourceKind !== 'custom-resources',
      beforeOpen: () => this.positionCustomResourceMenu(),
    });
  }

  private positionCustomResourceMenu(): void {
    const rect = this.customResourceToggle.getBoundingClientRect();
    const viewportPadding = 8;
    const width = Math.min(Math.max(340, rect.width), Math.max(0, window.innerWidth - viewportPadding * 2));
    const left = Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - width - viewportPadding));
    const top = rect.bottom + 4;
    this.customResourceMenu.style.left = `${left}px`;
    this.customResourceMenu.style.top = `${top}px`;
    this.customResourceMenu.style.width = `${width}px`;
    this.customResourceMenu.style.maxHeight = `${Math.max(120, Math.min(292, window.innerHeight - top - viewportPadding))}px`;
  }

  private closeSelectorMenus(): void {
    this.setContextMenuOpen(false);
    this.setNamespaceMenuOpen(false);
    this.setCustomResourceMenuOpen(false);
  }

  private ensureBound(): void {
    if (this.bound) return;
    this.bound = true;

    this.contextToggle.addEventListener('click', () => {
      const opening = !isDropdownMenuOpen(this.contextMenu);
      this.setNamespaceMenuOpen(false);
      this.setCustomResourceMenuOpen(false);
      this.setContextMenuOpen(opening);
      if (opening) focusSelectedMenuOption(this.contextMenu, '.kubernetes-selector-option');
    });
    bindListboxKeyboardNavigation(this.contextMenu, '.kubernetes-selector-option');
    bindListboxKeyboardNavigation(this.customResourceMenu, '.kubernetes-selector-option');
    this.reloadButton.addEventListener('click', () => {
      void this.reloadKubeconfig();
    });
    this.reconnectButton.addEventListener('click', () => {
      void this.reconnect();
    });
    this.namespaceToggle.addEventListener('click', () => {
      const opening = !isDropdownMenuOpen(this.namespaceMenu);
      this.setContextMenuOpen(false);
      this.setCustomResourceMenuOpen(false);
      if (opening) {
        this.namespaceFilter = '';
        this.namespaceSearch.value = '';
        this.renderNamespaceOptions();
      }
      this.setNamespaceMenuOpen(opening);
      if (opening) {
        window.requestAnimationFrame(() => {
          if (isDropdownMenuOpen(this.namespaceMenu)) this.namespaceSearch.focus();
        });
      }
    });
    this.namespaceSearch.addEventListener('input', () => {
      this.namespaceFilter = this.namespaceSearch.value;
      this.renderNamespaceOptions();
    });
    this.customResourceToggle.addEventListener('click', () => {
      const opening = !isDropdownMenuOpen(this.customResourceMenu);
      this.setContextMenuOpen(false);
      this.setNamespaceMenuOpen(false);
      if (opening) {
        this.customDefinitionFilter = '';
        this.customResourceSearch.value = '';
        this.renderCustomResourceOptions();
      }
      this.setCustomResourceMenuOpen(opening);
      if (opening) {
        window.requestAnimationFrame(() => {
          if (isDropdownMenuOpen(this.customResourceMenu)) this.customResourceSearch.focus();
        });
      }
    });
    this.customResourceSearch.addEventListener('input', () => {
      this.customDefinitionFilter = this.customResourceSearch.value;
      this.renderCustomResourceOptions();
    });
    this.secondaryRow.addEventListener('scroll', () => {
      if (isDropdownMenuOpen(this.customResourceMenu)) this.positionCustomResourceMenu();
    });
    window.addEventListener('resize', () => {
      if (isDropdownMenuOpen(this.customResourceMenu)) this.positionCustomResourceMenu();
    });
    document.addEventListener('pointerdown', (event) => {
      const target = event.target instanceof Node ? event.target : null;
      if (isDropdownMenuOpen(this.contextMenu)
        && shouldCloseKubernetesSelectorMenu(this.contextControl, target)) {
        this.setContextMenuOpen(false);
      }
      if (isDropdownMenuOpen(this.namespaceMenu)
        && shouldCloseKubernetesSelectorMenu(this.namespaceControl, target)) {
        this.setNamespaceMenuOpen(false);
      }
      if (isDropdownMenuOpen(this.customResourceMenu)
        && shouldCloseKubernetesSelectorMenu(this.customResourceControl, target)) {
        this.setCustomResourceMenuOpen(false);
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const contextOpen = isDropdownMenuOpen(this.contextMenu);
      const namespaceOpen = isDropdownMenuOpen(this.namespaceMenu);
      const customResourceOpen = isDropdownMenuOpen(this.customResourceMenu);
      if (!contextOpen && !namespaceOpen && !customResourceOpen) return;
      this.closeSelectorMenus();
      if (contextOpen) this.contextToggle.focus();
      else if (namespaceOpen) this.namespaceToggle.focus();
      else this.customResourceToggle.focus();
    });
    document.addEventListener('keydown', (event) => this.handleYamlFindShortcut(event), true);
    closeDropdownOnFocusOut(this.contextControl, () => this.setContextMenuOpen(false));
    closeDropdownOnFocusOut(this.namespaceControl, () => this.setNamespaceMenuOpen(false));
    closeDropdownOnFocusOut(this.customResourceControl, () => this.setCustomResourceMenuOpen(false));
    this.searchInput.addEventListener('input', () => this.debounceSearch());
    this.tableHeader.addEventListener('click', (event) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-kubernetes-sort]')
        : null;
      const column = kubernetesSortColumn(
        button?.dataset.kubernetesSort,
        this.resourceKind,
        this.selectedCustomDefinition,
      );
      if (!column) return;
      this.closeDetail();
      this.sort = nextKubernetesSort(this.sort, column);
      this.renderSortHeaders();
      void this.activateCurrentList();
    });
    this.detailCloseButton.addEventListener('click', () => this.closeDetail());
    this.detailDrawerScrim.addEventListener('click', () => this.closeDetail());
    this.detailVncButton.addEventListener('click', () => { void this.openVnc(); });
    this.detailPortForwardButton.addEventListener('click', () => this.openPortForwardDialog());
    this.detailYamlToggle.addEventListener('click', () => this.toggleDrawerYaml());
    this.detailYamlCopy.addEventListener('click', () => { void this.copyDrawerYaml(); });
    this.detailYamlFindInput.addEventListener('input', () => this.scheduleYamlFind());
    this.detailYamlFindPrevious.addEventListener('click', () => this.moveYamlFind(-1));
    this.detailYamlFindNext.addEventListener('click', () => this.moveYamlFind(1));
    this.detailYamlFindClose.addEventListener('click', () => this.closeYamlFind());
    this.detailYamlFindInput.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        this.moveYamlFind(event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.closeYamlFind();
      }
    });
    this.portForwardsToggle.addEventListener('click', () => this.openPortForwardsDialog());
    this.portForwardsClose.addEventListener('click', () => this.closePortForwardsDialog());
    this.portForwardsCloseAll.addEventListener('click', () => { void this.stopAllListedPortForwards(); });
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
    this.renderTableHeader();
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

  private clearResourceTable(): void {
    this.requestGeneration += 1;
    this.snapshot = undefined;
    this.loadingMore = false;
    this.requestedContinuation = undefined;
    this.requestedWindow = undefined;
    this.table?.setWindow({ start: 0, end: 0, total: 0, items: [] });
    this.tableViewport.scrollTop = 0;
    this.tableShell.scrollLeft = 0;
  }

  private async waitForPriorDeactivation(pageGeneration: number): Promise<void> {
    await this.deactivation;
    if (!this.visible || pageGeneration !== this.pageGeneration) return;
    this.ensureWorkspace();
    await this.loadStateAndActivate(pageGeneration);
  }

  private async loadStateAndActivate(pageGeneration = this.pageGeneration): Promise<void> {
    try {
      const state = await window.kubernetesApi.getState();
      if (!this.visible || pageGeneration !== this.pageGeneration) return;
      const selected = state.contexts.find((context) => context.name === state.selectedContext);
      if (state.selectedContext && selected?.supported) {
        this.armContextActivation(state.selectedContext);
      }
      this.onStateChanged(state);
      if (!this.pendingContextActivation && state.connection !== 'connected') {
        await this.activateCurrentList();
      }
    } catch (error) {
      if (this.visible && pageGeneration === this.pageGeneration) this.showError(toErrorMessage(error));
    }
  }

  private onStateChanged(state: KubernetesState): void {
    const previousState = this.state;
    const hadContextActivationIntent = Boolean(this.pendingContextActivation);
    const contextChanged = previousState !== undefined && previousState.selectedContext !== state.selectedContext;
    const connectionChanged = previousState?.connection !== state.connection;
    const disconnected = previousState?.connection !== 'disconnected' && state.connection === 'disconnected';
    if (contextChanged) this.invalidateNamespaceOptions();
    if (contextChanged || disconnected) {
      this.clearResourceTable();
      this.clearDrawerEnvironment();
      this.disposeWorkspaceForLifecycle();
    }
    const preserveReloadCustomDefinition = !contextChanged
      && this.customDefinitionsReloadContext !== undefined
      && this.customDefinitionsReloadContext === state.selectedContext;
    if (this.customDefinitionsContext !== state.selectedContext) {
      this.customDefinitionsRequestGeneration += 1;
      this.customDefinitions = [];
      this.customDefinitionsContext = undefined;
      if (!preserveReloadCustomDefinition) {
        this.selectedCustomDefinition = undefined;
        this.customDefinitionsReloadContext = undefined;
        this.customDefinitionsLoadingContext = undefined;
        this.customDefinitionsLoad = undefined;
      }
      this.customDefinitionFilter = '';
      this.customResourceSearch.value = '';
      this.setCustomResourceMenuOpen(false);
    }
    this.state = state;
    if (this.visible && state.connection === 'connected' && !contextChanged && !disconnected) this.ensureWorkspace();
    const scope = state.namespaceScope ?? { mode: 'all', namespaces: [] };
    this.selectedNamespaces = new Set(scope.namespaces);
    this.renderState();
    if (state.connection !== 'connected' && (contextChanged || connectionChanged)) {
      this.renderConnectionListState(state);
    }
    if (this.visible && state.connection === 'connected' && state.selectedContext
      && this.namespaceContext !== state.selectedContext
      && this.namespaceLoadingContext !== state.selectedContext) {
      void this.loadNamespaces(state.selectedContext);
    }
    if (this.visible && this.resourceKind === 'custom-resources' && state.connection === 'connected'
      && this.customDefinitionsContext !== state.selectedContext && !this.reloadingKubeconfig) {
      void this.loadCustomResourceDefinitions();
    }
    this.settleContextActivation(state);
    const customDefinitionReloadPending = this.resourceKind === 'custom-resources'
      && this.customDefinitionsReloadContext === state.selectedContext;
    if (this.visible && state.connection === 'connected' && connectionChanged && !hadContextActivationIntent
      && !customDefinitionReloadPending) {
      void this.activateCurrentList();
    }
  }

  private armContextActivation(context: string): KubernetesContextActivationIntent {
    const intent = {
      id: ++this.contextActivationIntentGeneration,
      context,
      pageGeneration: this.pageGeneration,
    };
    this.pendingContextActivation = intent;
    return intent;
  }

  private cancelContextActivation(): void {
    this.contextActivationIntentGeneration += 1;
    this.pendingContextActivation = undefined;
  }

  private isCurrentContextActivation(intent: KubernetesContextActivationIntent): boolean {
    return this.pendingContextActivation?.id === intent.id
      && intent.pageGeneration === this.pageGeneration;
  }

  private settleContextActivation(state: KubernetesState): void {
    const intent = this.pendingContextActivation;
    if (!intent) return;
    const decision = decideKubernetesContextActivation(intent, state, this.visible, this.pageGeneration);
    if (decision === 'wait') return;
    if (this.pendingContextActivation?.id === intent.id) {
      this.pendingContextActivation = undefined;
    }
    if (decision === 'activate') {
      void this.activateCurrentList();
    }
  }

  private renderConnectionListState(state: KubernetesState): void {
    this.clearTransientStates();
    this.table?.setWindow({ start: 0, end: 0, total: 0, items: [] });
    const message = state.connection === 'connecting'
      ? 'Connecting to Kubernetes…'
      : state.connection === 'reconnecting'
        ? 'Reconnecting to Kubernetes…'
        : state.error ?? (state.selectedContext
          ? 'The Kubernetes Context is disconnected.'
          : 'Choose a supported Kubernetes Context to load resources.');
    this.loadedCount.textContent = message;
    this.emptyState.textContent = message;
    this.emptyState.classList.remove('hidden');
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
    this.renderList();
  }

  private renderState(): void {
    const state = this.state;
    this.renderContextMenu();

    this.connectionBadge.textContent = state?.connection ?? 'idle';
    this.connectionBadge.className = `kubernetes-connection kubernetes-connection-${state?.connection ?? 'idle'}`;
    const selected = state?.contexts.find((context) => context.name === state.selectedContext);
    const canReconnect = state?.connection === 'disconnected' && Boolean(selected?.supported);
    this.reconnectButton.classList.toggle('hidden', !canReconnect);
    this.reconnectButton.disabled = !canReconnect || this.reconnecting;
    this.reconnectButton.textContent = this.reconnecting ? 'Reconnecting…' : 'Reconnect';
    this.reloadButton.classList.toggle('hidden', !state?.kubeconfigReloadAvailable);
    this.reloadButton.disabled = this.reloadingKubeconfig;
    this.reloadButton.textContent = this.reloadingKubeconfig ? 'Reloading…' : 'Reload kubeconfig';
    this.namespaceToggle.disabled = state?.connection !== 'connected' || !state?.selectedContext;
    this.namespaceSearch.disabled = this.namespaceToggle.disabled;
    if (this.namespaceToggle.disabled) this.setNamespaceMenuOpen(false);
    this.renderNamespaceMenu();
    this.renderCategoryTabs();
    this.renderResourceTabs();
    this.renderCustomResourceControl();

    const unsupported = selected && !selected.supported;
    if (unsupported) {
      this.showError(this.unsupportedContextMessage(selected));
    }
  }

  private renderContextMenu(): void {
    const state = this.state;
    const focusedContext = document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.context
      : undefined;
    this.contextMenu.replaceChildren();
    if (!state?.contexts.length) {
      this.contextToggle.disabled = true;
      this.contextValue.textContent = 'No kubeconfig contexts found';
      this.contextValue.title = 'No kubeconfig contexts found';
      this.setContextMenuOpen(false);
      return;
    }

    this.contextToggle.disabled = false;
    const selected = state.contexts.find((context) => context.name === state.selectedContext);
    const selectedLabel = selected
      ? selected.supported ? selected.displayName : `${selected.displayName} (unsupported)`
      : 'Choose Context';
    this.contextValue.textContent = selectedLabel;
    this.contextValue.title = selectedLabel;

    for (const context of state.contexts) {
      const label = context.supported ? context.displayName : `${context.displayName} (unsupported)`;
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'kubernetes-selector-option';
      option.classList.toggle('kubernetes-selector-option-unsupported', !context.supported);
      option.dataset.context = context.name;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(context.name === state.selectedContext));
      option.title = label;
      const text = document.createElement('span');
      text.textContent = label;
      option.appendChild(text);
      option.addEventListener('click', () => {
        this.setContextMenuOpen(false);
        this.contextToggle.focus();
        if (context.name !== this.state?.selectedContext) void this.selectContext(context.name);
      });
      this.contextMenu.appendChild(option);
    }
    if (focusedContext && isDropdownMenuOpen(this.contextMenu)) {
      window.requestAnimationFrame(() => {
        if (!isDropdownMenuOpen(this.contextMenu)) return;
        Array.from(this.contextMenu.querySelectorAll<HTMLButtonElement>('[data-context]'))
          .find((option) => option.dataset.context === focusedContext)
          ?.focus();
      });
    }
  }

  private restoreNamespaceChoiceFocus(namespace: string | null): void {
    window.requestAnimationFrame(() => {
      if (!isDropdownMenuOpen(this.namespaceMenu)) return;
      const target = namespace === null
        ? this.namespaceAll.querySelector<HTMLInputElement>('input[type="checkbox"]')
        : Array.from(this.namespaceOptions.querySelectorAll<HTMLInputElement>('input[data-namespace]'))
          .find((input) => input.dataset.namespace === namespace);
      target?.focus();
    });
  }

  private renderNamespaceMenu(): void {
    const scope = this.currentScope();
    const label = scope.mode === 'all'
      ? 'All Namespaces'
      : scope.namespaces.length === 1
        ? scope.namespaces[0]
        : `${scope.namespaces.length} Namespaces`;
    this.namespaceValue.textContent = label;
    this.namespaceValue.title = label;
    this.namespaceSearch.value = this.namespaceFilter;
    this.namespaceAll.replaceChildren();

    const allLabel = document.createElement('label');
    allLabel.className = 'kubernetes-namespace-option';
    const all = document.createElement('input');
    all.type = 'checkbox';
    all.checked = scope.mode === 'all';
    allLabel.append(all, document.createTextNode('All'));
    all.addEventListener('change', () => {
      if (all.checked) {
        this.selectedNamespaces.clear();
        void this.setNamespaceScope({ mode: 'all', namespaces: [] }, null);
      } else {
        // An empty selected scope is invalid. Adding a Namespace below moves
        // from All Namespaces to a concrete multi-selection instead.
        this.renderNamespaceMenu();
        this.restoreNamespaceChoiceFocus(null);
      }
    });
    this.namespaceAll.appendChild(allLabel);
    this.renderNamespaceOptions();
  }

  private renderNamespaceOptions(): void {
    this.namespaceOptions.replaceChildren();
    const scope = this.currentScope();

    if (this.namespaceLoadingContext === this.state?.selectedContext) {
      const status = document.createElement('p');
      status.className = 'kubernetes-namespace-status';
      status.textContent = 'Loading Namespaces…';
      this.namespaceOptions.appendChild(status);
      return;
    }

    const allNamespaces = filterKubernetesNamespaces([...this.availableNamespaces, ...scope.namespaces], '');
    const namespaces = filterKubernetesNamespaces(allNamespaces, this.namespaceFilter);
    if (allNamespaces.length === 0) {
      const status = document.createElement('p');
      status.className = 'kubernetes-namespace-status';
      status.textContent = 'No Namespaces available';
      this.namespaceOptions.appendChild(status);
      return;
    }
    if (namespaces.length === 0) {
      const status = document.createElement('p');
      status.className = 'kubernetes-namespace-status';
      status.textContent = 'No matching Namespaces';
      this.namespaceOptions.appendChild(status);
      return;
    }

    for (const namespace of namespaces) {
      const label = document.createElement('label');
      label.className = 'kubernetes-namespace-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = scope.mode === 'selected' && this.selectedNamespaces.has(namespace);
      input.dataset.namespace = namespace;
      const name = document.createElement('span');
      name.textContent = namespace;
      name.title = namespace;
      label.append(input, name);
      input.addEventListener('change', () => {
        const next = updateNamespaceSelection(this.selectedNamespaces, namespace, input.checked);
        this.selectedNamespaces = new Set(next.namespaces);
        void this.setNamespaceScope(next, namespace);
      });
      this.namespaceOptions.appendChild(label);
    }
  }

  private renderCategoryTabs(): void {
    renderTextTabs({
      container: this.categoryTabs,
      tabs: (Object.keys(RESOURCE_CATEGORIES) as KubernetesCategory[])
        .map((category) => ({ id: category, label: category })),
      activeId: this.category,
      buttonClassName: 'kubernetes-category-tab',
      activeClassName: 'kubernetes-tab-active',
      onSelect: (category) => this.selectCategory(category),
    });
  }

  private renderResourceTabs(): void {
    const showTabs = categoryUsesResourceTabs(this.category);
    this.resourceTabs.classList.toggle('hidden', !showTabs);
    if (showTabs) {
      renderTextTabs({
        container: this.resourceTabs,
        tabs: RESOURCE_CATEGORIES[this.category].map((kind) => {
          const resourceKind = kind as KubernetesResourceKind;
          return { id: resourceKind, label: resourceLabel(resourceKind) };
        }),
        activeId: this.resourceKind,
        buttonClassName: 'kubernetes-resource-tab',
        activeClassName: 'kubernetes-tab-active',
        onSelect: (resourceKind) => this.selectResource(resourceKind),
      });
    } else {
      this.resourceTabs.replaceChildren();
    }
    this.renderCustomResourceControl();
  }

  private renderTableHeader(): void {
    this.tableShell.dataset.resourceKind = this.resourceKind;
    this.tableHeader.replaceChildren();
    for (const column of getKubernetesListColumns(this.resourceKind, this.selectedCustomDefinition)) {
      const header = document.createElement('span');
      header.setAttribute('role', 'columnheader');
      header.setAttribute('aria-sort', 'none');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'kubernetes-table-sort';
      button.dataset.kubernetesSort = column.key;
      button.dataset.sortLabel = column.label;
      if (this.resourceKind === 'pods' && (column.key === 'cpu' || column.key === 'memory')) {
        button.title = `Live ${column.label} usage from metrics.k8s.io`;
      }
      const label = document.createElement('span');
      label.textContent = column.label;
      button.append(label, createKubernetesSortIcon());
      header.appendChild(button);
      this.tableHeader.appendChild(header);
    }
    this.renderSortHeaders();
  }

  private renderSortHeaders(): void {
    const buttons = Array.from(this.tableHeader.querySelectorAll<HTMLButtonElement>('[data-kubernetes-sort]'));
    for (const button of buttons) {
      const column = kubernetesSortColumn(
        button.dataset.kubernetesSort,
        this.resourceKind,
        this.selectedCustomDefinition,
      );
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
    if (!isCustomResource) {
      this.setCustomResourceMenuOpen(false);
      return;
    }
    const context = this.state?.selectedContext;
    const loading = Boolean(context && this.customDefinitionsLoadingContext === context);
    const selected = this.selectedCustomDefinition;
    const label = selected
      ? `${formatKubernetesResourceKindLabel(selected.kind)} · ${selected.group}/${selected.version}`
      : loading
        ? 'Discovering Custom Resources…'
        : this.customDefinitionsContext === context && this.customDefinitions.length === 0
          ? 'No Custom Resources'
          : 'Select Custom Resource';
    this.customResourceValue.textContent = label;
    this.customResourceValue.title = label;
    this.customResourceToggle.disabled = !context || this.state?.connection !== 'connected'
      || loading || this.customDefinitions.length === 0;
    if (this.customResourceToggle.disabled) this.setCustomResourceMenuOpen(false);
    this.renderCustomResourceOptions();
  }

  private renderCustomResourceOptions(): void {
    this.customResourceOptions.replaceChildren();
    const groups = groupKubernetesCustomResourceDefinitions(
      this.customDefinitions,
      this.customDefinitionFilter,
    );
    if (this.customDefinitionsLoadingContext === this.state?.selectedContext) {
      const status = document.createElement('p');
      status.className = 'kubernetes-custom-resource-status';
      status.textContent = 'Discovering Custom Resources…';
      this.customResourceOptions.appendChild(status);
      return;
    }
    if (groups.length === 0) {
      const status = document.createElement('p');
      status.className = 'kubernetes-custom-resource-status';
      status.textContent = this.customDefinitions.length > 0
        ? 'No matching Custom Resources'
        : 'No Custom Resources available';
      this.customResourceOptions.appendChild(status);
      return;
    }
    for (const [groupIndex, group] of groups.entries()) {
      const container = document.createElement('div');
      container.className = 'kubernetes-custom-resource-group';
      container.setAttribute('role', 'group');
      const heading = document.createElement('div');
      heading.id = `kubernetes-custom-resource-group-${groupIndex}`;
      heading.className = 'kubernetes-custom-resource-group-heading';
      heading.textContent = group.group;
      heading.title = group.group;
      container.setAttribute('aria-labelledby', heading.id);
      container.appendChild(heading);
      for (const definition of group.definitions) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'kubernetes-selector-option kubernetes-custom-resource-option';
        option.dataset.customResource = this.customDefinitionKey(definition);
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(
          this.selectedCustomDefinition !== undefined
          && this.customDefinitionKey(this.selectedCustomDefinition) === this.customDefinitionKey(definition),
        ));
        const kind = formatKubernetesResourceKindLabel(definition.kind);
        option.setAttribute('aria-label', `${kind}, ${definition.group}/${definition.version}`);
        const text = document.createElement('span');
        text.textContent = kind;
        text.title = `${kind} · ${definition.group}/${definition.version}`;
        const version = document.createElement('span');
        version.className = 'kubernetes-custom-resource-option-meta';
        version.textContent = definition.version;
        option.append(text, version);
        option.addEventListener('click', () => this.selectCustomResourceDefinition(definition));
        container.appendChild(option);
      }
      this.customResourceOptions.appendChild(container);
    }
  }

  private selectCategory(category: KubernetesCategory): void {
    if (this.category === category) return;
    this.closeDetail();
    this.category = category;
    this.resourceKind = RESOURCE_CATEGORIES[category][0] as KubernetesResourceKind;
    this.sort = { column: 'name', direction: 'asc' };
    this.clearResourceTable();
    this.searchInput.value = '';
    this.renderCategoryTabs();
    this.renderResourceTabs();
    this.renderTableHeader();
    if (this.resourceKind === 'custom-resources') void this.loadCustomResourceDefinitions();
    void this.activateCurrentList();
  }

  private selectResource(kind: KubernetesResourceKind): void {
    if (this.resourceKind === kind) return;
    this.closeDetail();
    this.resourceKind = kind;
    this.sort = { column: 'name', direction: 'asc' };
    this.clearResourceTable();
    this.searchInput.value = '';
    this.renderResourceTabs();
    this.renderTableHeader();
    if (this.resourceKind === 'custom-resources') void this.loadCustomResourceDefinitions();
    void this.activateCurrentList();
  }

  private currentScope(): KubernetesNamespaceScope {
    const namespaces = [...this.selectedNamespaces].map((name) => name.trim()).filter(Boolean).sort();
    return namespaces.length === 0 ? { mode: 'all', namespaces: [] } : { mode: 'selected', namespaces };
  }

  private customDefinitionKey(definition: KubernetesCustomResourceDefinition): string {
    return kubernetesCustomResourceDefinitionKey(definition);
  }

  private loadCustomResourceDefinitions(): Promise<boolean> {
    const context = this.state?.selectedContext;
    if (!this.visible || this.resourceKind !== 'custom-resources' || !context || this.state?.connection !== 'connected') {
      return Promise.resolve(false);
    }
    const existing = this.customDefinitionsLoad;
    if (existing?.context === context) return existing.promise;
    const promise = this.performCustomResourceDefinitionLoad(context);
    this.customDefinitionsLoad = { context, promise };
    void promise.then(
      () => {
        if (this.customDefinitionsLoad?.promise === promise) this.customDefinitionsLoad = undefined;
      },
      () => {
        if (this.customDefinitionsLoad?.promise === promise) this.customDefinitionsLoad = undefined;
      },
    );
    return promise;
  }

  private async performCustomResourceDefinitionLoad(context: string): Promise<boolean> {
    const requestGeneration = ++this.customDefinitionsRequestGeneration;
    this.customDefinitionsLoadingContext = context;
    this.renderCustomResourceControl();
    try {
      const definitions = await window.kubernetesApi.listCustomResourceDefinitions();
      if (!this.visible || requestGeneration !== this.customDefinitionsRequestGeneration
        || this.resourceKind !== 'custom-resources' || this.state?.selectedContext !== context) return false;
      const previousDefinition = this.selectedCustomDefinition;
      const matchingDefinition = rebindKubernetesCustomResourceDefinition(definitions, previousDefinition);
      const definitionChanged = previousDefinition !== undefined && matchingDefinition !== undefined
        && JSON.stringify(previousDefinition) !== JSON.stringify(matchingDefinition);
      const reloadDiscovery = this.customDefinitionsReloadContext === context;
      this.customDefinitions = definitions;
      this.customDefinitionsContext = context;
      this.customDefinitionsReloadContext = undefined;
      if (previousDefinition) {
        this.selectedCustomDefinition = matchingDefinition;
      }
      let reactivate = reloadDiscovery && previousDefinition !== undefined && matchingDefinition !== undefined;
      if (previousDefinition && !matchingDefinition) {
        this.closeDetail();
        this.clearResourceTable();
        this.sort = { column: 'name', direction: 'asc' };
        this.renderTableHeader();
        reactivate = true;
      } else if (definitionChanged && matchingDefinition) {
        this.closeDetail();
        this.clearResourceTable();
        const columns = getKubernetesCustomResourceListColumns(matchingDefinition);
        if (!columns.some((column) => column.key === this.sort.column)) {
          this.sort = { column: 'name', direction: 'asc' };
        }
        this.renderTableHeader();
        reactivate = true;
      }
      this.renderCustomResourceControl();
      if (reactivate && !this.reloadingKubeconfig) {
        void this.activateCurrentList();
      }
      return true;
    } catch (error) {
      if (!this.visible || requestGeneration !== this.customDefinitionsRequestGeneration
        || this.resourceKind !== 'custom-resources') return false;
      if (isPermissionError(error)) this.showNoPermission(toErrorMessage(error));
      else this.showError(toErrorMessage(error));
      return false;
    } finally {
      if (requestGeneration === this.customDefinitionsRequestGeneration
        && this.customDefinitionsLoadingContext === context) {
        this.customDefinitionsLoadingContext = undefined;
        if (this.visible && this.resourceKind === 'custom-resources' && this.state?.selectedContext === context) {
          this.renderCustomResourceControl();
        }
      }
    }
  }

  private selectCustomResourceDefinition(definition: KubernetesCustomResourceDefinition): void {
    const selectedKey = this.selectedCustomDefinition
      ? this.customDefinitionKey(this.selectedCustomDefinition)
      : undefined;
    const nextKey = this.customDefinitionKey(definition);
    this.setCustomResourceMenuOpen(false);
    this.customResourceToggle.focus();
    if (selectedKey === nextKey) return;
    this.closeDetail();
    this.selectedCustomDefinition = definition;
    this.sort = { column: 'name', direction: 'asc' };
    this.clearResourceTable();
    this.renderCustomResourceControl();
    this.renderTableHeader();
    void this.activateCurrentList();
  }

  private currentQuery(): KubernetesResourceQuery | undefined {
    if (this.state?.connection !== 'connected') return undefined;
    const context = this.state?.selectedContext;
    if (!context) return undefined;
    if (this.resourceKind === 'custom-resources') {
      if (!hasCurrentKubernetesCustomResourceDefinitions(
        context,
        this.customDefinitionsContext,
        this.customDefinitionsReloadContext,
      )) return undefined;
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
    const intent = this.armContextActivation(context);
    this.closeSelectorMenus();
    this.closeDetail();
    this.clearResourceTable();
    try {
      const state = await window.kubernetesApi.selectContext(context);
      if (!this.visible || !this.isCurrentContextActivation(intent)) return;
      this.onStateChanged(state);
    } catch (error) {
      if (this.isCurrentContextActivation(intent)) {
        this.cancelContextActivation();
        this.showError(toErrorMessage(error));
      }
    }
  }

  private async reloadKubeconfig(): Promise<void> {
    if (this.reloadingKubeconfig) return;
    this.reloadingKubeconfig = true;
    this.renderState();
    this.closeSelectorMenus();
    this.closeDetail();
    this.clearResourceTable();
    this.customDefinitionsRequestGeneration += 1;
    this.customDefinitionsLoadingContext = undefined;
    this.customDefinitionsLoad = undefined;
    this.customDefinitions = [];
    this.customDefinitionsContext = undefined;
    this.customDefinitionsReloadContext = this.state?.selectedContext;
    this.renderCustomResourceControl();
    try {
      const state = await window.kubernetesApi.reloadKubeconfig();
      if (!this.visible) return;
      this.invalidateNamespaceOptions();
      this.onStateChanged(state);
      let customResourcesReady = true;
      if (this.resourceKind === 'custom-resources' && state.connection === 'connected') {
        customResourcesReady = await this.loadCustomResourceDefinitions();
      }
      if (customResourcesReady) {
        await this.activateCurrentList();
      }
    } catch (error) {
      this.showError(toErrorMessage(error));
    } finally {
      this.reloadingKubeconfig = false;
      this.renderState();
    }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.state?.connection !== 'disconnected') {
      return;
    }
    const selectedContext = this.state.selectedContext;
    const intent = selectedContext ? this.armContextActivation(selectedContext) : undefined;
    this.reconnecting = true;
    this.renderState();
    try {
      const state = await window.kubernetesApi.reconnect();
      if (!this.visible || (intent && !this.isCurrentContextActivation(intent))) return;
      this.invalidateNamespaceOptions();
      this.onStateChanged(state);
      if (state.connection !== 'connected' && state.connection !== 'reconnecting' && state.error) {
        this.showError(state.error);
      }
    } catch (error) {
      if (this.visible && (!intent || this.isCurrentContextActivation(intent))) {
        this.cancelContextActivation();
        this.showError(toErrorMessage(error));
      }
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
    this.namespaceFilter = '';
    this.namespaceSearch.value = '';
    this.setNamespaceMenuOpen(false);
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

  private async setNamespaceScope(
    scope: KubernetesNamespaceScope,
    focusNamespace: string | null,
  ): Promise<void> {
    const previousScope = this.state?.namespaceScope ?? { mode: 'all' as const, namespaces: [] };
    this.closeDetail();
    this.clearResourceTable();
    try {
      const state = await window.kubernetesApi.setNamespaceScope(scope);
      if (!this.visible) return;
      this.onStateChanged(state);
      this.renderNamespaceMenu();
      this.restoreNamespaceChoiceFocus(focusNamespace);
      await this.activateCurrentList();
    } catch (error) {
      this.selectedNamespaces = new Set(previousScope.namespaces);
      this.renderNamespaceMenu();
      this.restoreNamespaceChoiceFocus(focusNamespace);
      setMessage(toErrorMessage(error), 'error');
      if (this.visible) await this.activateCurrentList();
    }
  }

  private debounceSearch(): void {
    this.closeDetail();
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
      this.loadedCount.textContent = this.state?.connection !== 'connected'
        ? this.state?.connection === 'connecting'
          ? 'Connecting to Kubernetes…'
          : this.state?.connection === 'reconnecting'
            ? 'Reconnecting to Kubernetes…'
            : this.state?.error ?? 'Choose a supported Kubernetes Context to load resources.'
        : this.resourceKind === 'custom-resources'
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
    const snapshot = this.snapshot;
    const query = this.currentQuery();
    if (!snapshot || !query || !sameQuery(snapshot.query, query)) return;
    this.clearTransientStates();
    this.table?.setWindow(snapshot);
    this.renderSortHeaders();
    const metricsStatus = query.kind !== 'pods' || snapshot.podMetricsState === 'available'
      ? ''
      : snapshot.podMetricsState === 'loading'
        ? ' · loading metrics'
        : ' · metrics unavailable';
    this.loadedCount.textContent = snapshot.continueToken
      ? `Loaded ${snapshot.loadedCount} ${resourceLabel(query.kind)} · more available`
      : `Loaded ${snapshot.loadedCount} ${resourceLabel(query.kind)}`;
    this.loadedCount.textContent += metricsStatus;
    if (snapshot.total === 0) {
      this.emptyState.textContent = query.nameFilter ? 'No loaded resources match this name.' : 'No resources found.';
      this.emptyState.classList.remove('hidden');
    }
    if (this.visible && snapshot.continueToken && query.nameFilter?.trim()) {
      this.loadMorePages();
    }
  }

  /** Lens-style reactive Age: refresh only the mounted Age cells on an adaptive clock. */
  private startAgeRefresh(): void {
    if (this.ageRefreshTimer !== undefined) return;
    this.scheduleAgeRefresh(AGE_REFRESH_SECOND_MS);
  }

  private stopAgeRefresh(): void {
    if (this.ageRefreshTimer !== undefined) {
      window.clearTimeout(this.ageRefreshTimer);
      this.ageRefreshTimer = undefined;
    }
  }

  private scheduleAgeRefresh(delayMs: number): void {
    if (!this.visible || this.ageRefreshTimer !== undefined) return;
    this.ageRefreshTimer = window.setTimeout(() => {
      this.ageRefreshTimer = undefined;
      if (!this.visible) return;
      this.refreshVisibleAges();
      this.scheduleAgeRefresh(this.nextAgeRefreshDelay());
    }, delayMs);
  }

  private refreshVisibleAges(): void {
    for (const cell of Array.from(
      this.tableViewport.querySelectorAll<HTMLElement>('[data-kubernetes-age-cell]'),
    )) {
      const createdAt = cell.dataset.kubernetesAgeCell;
      if (createdAt) cell.textContent = formatAge(createdAt);
    }
  }

  /** Ticks every second while a visible row is younger than 10 minutes, then once a minute. */
  private nextAgeRefreshDelay(): number {
    let youngest: number | undefined;
    for (const cell of Array.from(
      this.tableViewport.querySelectorAll<HTMLElement>('[data-kubernetes-age-cell]'),
    )) {
      const created = Date.parse(cell.dataset.kubernetesAgeCell ?? '');
      if (Number.isFinite(created) && (youngest === undefined || created < youngest)) {
        youngest = created;
      }
    }
    if (youngest === undefined) return AGE_REFRESH_MINUTE_MS;
    const minutes = Math.floor((Date.now() - youngest) / 60_000);
    return minutes < AGE_REFRESH_SECONDS_UP_TO_MINUTES
      ? AGE_REFRESH_SECOND_MS
      : AGE_REFRESH_MINUTE_MS;
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
    const query = this.currentQuery();
    if (!query) return;
    if (!shouldAutomaticallyLoadMore(query)) return;
    this.loadMorePages();
  }

  /** Loads the next continuation page; a search filter keeps draining until the list is complete. */
  private loadMorePages(): void {
    const snapshot = this.snapshot;
    const query = this.currentQuery();
    if (!this.visible || !snapshot?.continueToken || !query || this.loadingMore) return;
    if (this.requestedContinuation === snapshot.continueToken) return;
    this.loadingMore = true;
    this.requestedContinuation = snapshot.continueToken;
    void window.kubernetesApi.loadMoreResources(query).then((next) => {
      this.loadingMore = false;
      this.requestedContinuation = undefined;
      if (!this.visible || !sameQuery(next.query, this.currentQuery() ?? next.query)) return;
      this.snapshot = next;
      this.renderList();
      if (next.continueToken && next.query.nameFilter?.trim()) {
        this.loadMorePages();
      }
    }).catch((error) => {
      this.loadingMore = false;
      this.requestedContinuation = undefined;
      if (!this.visible) return;
      if (isPermissionError(error)) this.showNoPermission(toErrorMessage(error));
      else this.showError(toErrorMessage(error));
    });
  }

  /**
   * Fence all prior detail actions before any new request can yield. Both row
   * and linked-Pod navigation use this exact path so the old resource can
   * never retain a Port Forward action while another detail is loading.
   */
  private beginDrawerReplacement(): number {
    this.clearDrawerEnvironment();
    this.resetDrawerVncAction();
    const generation = ++this.detailGeneration;
    this.invalidateRelatedDetail();
    this.activeDetail = undefined;
    this.decodedSecretDetail = undefined;
    this.drawerRequest = {
      visible: false,
      pageGeneration: this.pageGeneration,
      drawerGeneration: generation,
      uid: '',
    };
    this.detailPortForwardButton.classList.add('hidden');
    this.detailPortForwardButton.classList.remove('kubernetes-detail-port-forward-active');
    this.detailPortForwardButton.disabled = true;
    this.detailPortForwardButton.setAttribute('aria-label', 'Port Forward');
    this.detailPortForwardButton.removeAttribute('title');
    this.closePortForwardDialog();
    this.detailOverview.classList.remove('hidden');
    this.detailOverview.replaceChildren();
    this.detailYaml.textContent = '';
    this.detailYamlWrap.classList.add('hidden');
    this.resetYamlFind();
    this.detailYamlToggle.setAttribute('aria-pressed', 'false');
    this.detailYamlToggle.setAttribute('aria-label', 'View YAML');
    this.resetDrawerYamlCopyAction();
    this.detailDrawer.classList.remove('hidden');
    return generation;
  }

  private createDrawerRequest(summary: KubernetesResourceSummary, drawerGeneration: number): KubernetesDrawerRequest {
    return {
      visible: true,
      pageGeneration: this.pageGeneration,
      drawerGeneration,
      uid: summary.uid,
    };
  }

  private isCurrentDrawerRequest(
    request: KubernetesDrawerRequest,
    originQuery: KubernetesResourceQuery,
  ): boolean {
    return isCurrentKubernetesDrawerListRequest(
      this.visible,
      this.drawerRequest,
      request,
      this.currentQuery(),
      originQuery,
    );
  }

  private isCurrentActiveDrawer(active: ActiveDetail): boolean {
    return this.activeDetail === active && this.isCurrentDrawerRequest(active.request, active.originQuery);
  }

  private async openDetail(summary: KubernetesResourceSummary): Promise<void> {
    const query = this.currentQuery();
    const snapshot = this.snapshot;
    if (!query || !snapshot) return;
    const detailGeneration = this.beginDrawerReplacement();
    const request = this.createDrawerRequest(summary, detailGeneration);
    this.drawerRequest = request;
    this.detailTitle.textContent = `Loading ${resourceLabel(query.kind)}…`;
    try {
      const detail = await window.kubernetesApi.getResourceDetail(query, summary.name, summary.namespace);
      if (!this.isCurrentDrawerRequest(request, query)) return;
      const active: ActiveDetail = { originQuery: query, query, summary, detail, request };
      this.activeDetail = active;
      this.decodedSecretDetail = query.kind === 'secrets' ? decodeSecretForActiveView(detail) : undefined;
      this.renderDetail();
    } catch (error) {
      if (!this.isCurrentDrawerRequest(request, query)) return;
      setMessage(toErrorMessage(error), 'error');
      this.closeDetail();
    }
  }

  private closeDetail(): void {
    // Port forwards are Context-scoped main-process resources. Closing this
    // renderer-only drawer must never stop them or remove them from the count.
    this.clearDrawerEnvironment();
    this.resetDrawerVncAction();
    this.detailGeneration += 1;
    this.invalidateRelatedDetail();
    this.activeDetail = undefined;
    this.decodedSecretDetail = undefined;
    this.drawerRequest = {
      visible: false,
      pageGeneration: this.pageGeneration,
      drawerGeneration: this.detailGeneration,
      uid: '',
    };
    this.closePortForwardDialog();
    this.detailPortForwardButton.classList.add('hidden');
    this.detailPortForwardButton.classList.remove('kubernetes-detail-port-forward-active');
    this.detailPortForwardButton.disabled = true;
    this.detailPortForwardButton.setAttribute('aria-label', 'Port Forward');
    this.detailPortForwardButton.removeAttribute('title');
    this.detailOverview.classList.remove('hidden');
    this.detailOverview.replaceChildren();
    this.detailYaml.textContent = '';
    this.detailYamlWrap.classList.add('hidden');
    this.resetYamlFind();
    this.detailYamlToggle.setAttribute('aria-pressed', 'false');
    this.detailYamlToggle.setAttribute('aria-label', 'View YAML');
    this.resetDrawerYamlCopyAction();
    this.detailDrawer.classList.add('hidden');
  }

  private displayDetail(): Record<string, unknown> | undefined {
    if (!this.activeDetail) return undefined;
    return this.decodedSecretDetail ?? this.activeDetail.detail;
  }

  private renderDetail(): void {
    const active = this.activeDetail;
    const detail = this.displayDetail();
    if (!active || !detail) return;
    this.detailTitle.textContent = detailName(active);
    this.drawerEnvironmentElement = undefined;
    this.detailOverview.replaceChildren();
    if (active.query.kind === 'pods') this.renderPodDrawer(detail, active);
    else if (active.query.kind === 'custom-resources' && this.selectedCustomDefinition) {
      this.renderCustomResourceDrawer(detail, active, this.selectedCustomDefinition);
    } else if (isKubernetesBuiltinDetailKind(active.query.kind)) {
      this.renderBuiltinResourceDrawer(detail, active);
    } else this.renderOverview(detail, active);
    this.renderDrawerVnc(detail, active);
    this.renderDrawerPortForward(active);
    const related = this.renderRelatedDetail(active);
    if (related) this.detailOverview.appendChild(related);
    this.detailOverview.appendChild(this.renderDrawerEvents(active));
    if (!this.detailYamlWrap.classList.contains('hidden')) {
      this.renderDrawerYaml(detail);
      if (this.yamlFindOpen) this.applyYamlFindHighlights();
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

  private renderBuiltinResourceDrawer(detail: Record<string, unknown>, active: ActiveDetail): void {
    if (!isKubernetesBuiltinDetailKind(active.query.kind)) return;
    const model = buildKubernetesBuiltinDetailModel(active.query.kind, detail, active.summary);
    const properties = document.createElement('section');
    properties.className = 'kubernetes-builtin-resource-properties';
    const heading = document.createElement('h3');
    heading.textContent = 'Properties';
    const list = document.createElement('dl');
    list.className = 'kubernetes-builtin-resource-property-list';
    for (const field of model.properties) {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = field.label;
      const description = document.createElement('dd');
      description.textContent = field.value;
      description.title = field.value;
      row.append(term, description);
      list.appendChild(row);
    }
    properties.append(heading, list);
    this.detailOverview.appendChild(properties);

    if (model.labels.length > 0) {
      this.detailOverview.appendChild(this.createCustomResourceSection(active, 'builtin-labels', 'Labels', (content) => {
        this.renderCustomResourceMetadataRows(content, model.labels);
      }));
    }

    for (const section of model.sections) {
      this.detailOverview.appendChild(this.renderBuiltinResourceSection(active, section));
    }

    if (model.annotations.length > 0) {
      this.detailOverview.appendChild(this.createCustomResourceSection(
        active,
        'builtin-annotations',
        'Annotations',
        (content) => this.renderCustomResourceMetadataRows(content, model.annotations),
      ));
    }
  }

  private renderBuiltinResourceSection(
    active: ActiveDetail,
    section: KubernetesBuiltinDetailSection,
  ): HTMLElement {
    return this.createPersistentDrawerSection(
      active,
      `builtin-${section.key}`,
      section.title,
      section.initiallyExpanded,
      (content) => {
        if (section.kind === 'pairs') {
          this.renderCustomResourceMetadataRows(content, section.entries);
          return;
        }
        if (section.kind === 'conditions') {
          const list = document.createElement('div');
          list.className = 'kubernetes-custom-resource-condition-list kubernetes-builtin-condition-list';
          this.renderDrawerConditions(list, section.conditions);
          content.appendChild(list);
          return;
        }

        const wrap = document.createElement('div');
        wrap.className = 'kubernetes-builtin-table-wrap';
        const table = document.createElement('table');
        table.className = 'kubernetes-builtin-table';
        const head = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const column of section.columns) {
          const cell = document.createElement('th');
          cell.scope = 'col';
          cell.textContent = column;
          headRow.appendChild(cell);
        }
        head.appendChild(headRow);
        const body = document.createElement('tbody');
        for (const values of section.rows) {
          const row = document.createElement('tr');
          for (const [index, value] of values.entries()) {
            const cell = document.createElement('td');
            if (section.multilineColumn === index) {
              const text = document.createElement('pre');
              text.textContent = value;
              cell.appendChild(text);
            } else {
              cell.textContent = value;
              cell.title = value;
            }
            row.appendChild(cell);
          }
          body.appendChild(row);
        }
        table.append(head, body);
        wrap.appendChild(table);
        content.appendChild(wrap);
      },
    );
  }

  private renderDrawerConditions(
    content: HTMLElement,
    conditions: readonly KubernetesBuiltinDetailCondition[],
  ): void {
    for (const condition of conditions) {
      const row = document.createElement('article');
      row.className = 'kubernetes-custom-resource-condition';
      const head = document.createElement('div');
      const type = document.createElement('strong');
      type.textContent = condition.type;
      const badge = document.createElement('span');
      badge.className = 'kubernetes-custom-resource-condition-badge';
      badge.dataset.status = condition.status.toLocaleLowerCase();
      badge.textContent = condition.status;
      head.append(type, badge);
      row.appendChild(head);
      if (condition.reason || condition.lastTransitionTime) {
        const meta = document.createElement('p');
        meta.className = 'kubernetes-custom-resource-condition-meta';
        meta.textContent = [condition.reason, condition.lastTransitionTime].filter(Boolean).join(' · ');
        row.appendChild(meta);
      }
      if (condition.message) {
        const message = document.createElement('p');
        message.textContent = condition.message;
        row.appendChild(message);
      }
      content.appendChild(row);
    }
  }

  private createPersistentDrawerSection(
    active: ActiveDetail,
    key: string,
    title: string,
    initiallyExpanded: boolean,
    renderContent: (content: HTMLElement) => void,
  ): HTMLElement {
    active.expandedSections ??= new Map<string, boolean>();
    const section = document.createElement('section');
    section.className = 'kubernetes-drawer-section';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'kubernetes-drawer-section-toggle';
    const label = document.createElement('span');
    label.textContent = title;
    const indicator = document.createElement('span');
    const content = document.createElement('div');
    content.className = 'kubernetes-drawer-section-content';
    let rendered = false;
    const ensureContent = (): void => {
      if (rendered) return;
      rendered = true;
      renderContent(content);
    };
    const update = (): void => {
      const expanded = active.expandedSections?.get(key) ?? initiallyExpanded;
      if (expanded) ensureContent();
      toggle.setAttribute('aria-expanded', String(expanded));
      indicator.textContent = expanded ? '▾' : '▸';
      content.classList.toggle('hidden', !expanded);
    };
    toggle.addEventListener('click', () => {
      if (!this.isCurrentActiveDrawer(active)) return;
      const expanded = active.expandedSections?.get(key) ?? initiallyExpanded;
      active.expandedSections?.set(key, !expanded);
      update();
    });
    toggle.append(label, indicator);
    update();
    section.append(toggle, content);
    return section;
  }

  private renderCustomResourceDrawer(
    detail: Record<string, unknown>,
    active: ActiveDetail,
    definition: KubernetesCustomResourceDefinition,
  ): void {
    const model = buildKubernetesCustomResourceDetailModel(detail, definition);
    const properties = document.createElement('section');
    properties.className = 'kubernetes-custom-resource-properties';
    const heading = document.createElement('h3');
    heading.textContent = 'Properties';
    const list = document.createElement('dl');
    list.className = 'kubernetes-custom-resource-property-list';
    for (const item of model.properties) {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = item.name;
      const description = document.createElement('dd');
      if (item.multiline) {
        const value = document.createElement('pre');
        value.textContent = item.value;
        description.appendChild(value);
      } else {
        description.textContent = item.value;
        description.title = item.value;
      }
      row.append(term, description);
      list.appendChild(row);
    }
    properties.append(heading, list);
    this.detailOverview.appendChild(properties);

    if (model.labels.length > 0) {
      this.detailOverview.appendChild(this.createCustomResourceSection(active, 'labels', 'Labels', (content) => {
        this.renderCustomResourceMetadataRows(content, model.labels);
      }));
    }
    if (model.annotations.length > 0) {
      this.detailOverview.appendChild(this.createCustomResourceSection(active, 'annotations', 'Annotations', (content) => {
        this.renderCustomResourceMetadataRows(content, model.annotations);
      }));
    }
    if (model.conditions.length > 0) {
      const conditions = document.createElement('section');
      conditions.className = 'kubernetes-custom-resource-conditions';
      const conditionsHeading = document.createElement('h3');
      conditionsHeading.textContent = 'Status';
      const conditionList = document.createElement('div');
      conditionList.className = 'kubernetes-custom-resource-condition-list';
      for (const condition of model.conditions) {
        const row = document.createElement('article');
        row.className = 'kubernetes-custom-resource-condition';
        const head = document.createElement('div');
        const type = document.createElement('strong');
        type.textContent = condition.type;
        const badge = document.createElement('span');
        badge.className = 'kubernetes-custom-resource-condition-badge';
        badge.dataset.status = condition.status.toLocaleLowerCase();
        badge.textContent = condition.status;
        head.append(type, badge);
        row.appendChild(head);
        if (condition.reason || condition.lastTransitionTime) {
          const meta = document.createElement('p');
          meta.className = 'kubernetes-custom-resource-condition-meta';
          meta.textContent = [condition.reason, condition.lastTransitionTime].filter(Boolean).join(' · ');
          row.appendChild(meta);
        }
        if (condition.message) {
          const message = document.createElement('p');
          message.textContent = condition.message;
          row.appendChild(message);
        }
        conditionList.appendChild(row);
      }
      conditions.append(conditionsHeading, conditionList);
      this.detailOverview.appendChild(conditions);
    }
  }

  private renderCustomResourceMetadataRows(content: HTMLElement, entries: Array<[string, string]>): void {
    for (const [key, value] of entries) {
      const row = document.createElement('div');
      row.className = 'kubernetes-drawer-label-row';
      const label = document.createElement('span');
      label.textContent = key;
      label.title = key;
      const text = document.createElement('span');
      text.textContent = value;
      text.title = value;
      row.append(label, text);
      content.appendChild(row);
    }
  }

  private createCustomResourceSection(
    active: ActiveDetail,
    key: string,
    title: string,
    renderContent: (content: HTMLElement) => void,
  ): HTMLElement {
    active.customExpandedSections ??= new Set<string>();
    const section = document.createElement('section');
    section.className = 'kubernetes-drawer-section';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'kubernetes-drawer-section-toggle';
    const label = document.createElement('span');
    label.textContent = title;
    const indicator = document.createElement('span');
    const content = document.createElement('div');
    content.className = 'kubernetes-drawer-section-content';
    let rendered = false;
    const ensureContent = (): void => {
      if (rendered) return;
      rendered = true;
      renderContent(content);
    };
    const update = (): void => {
      const expanded = active.customExpandedSections?.has(key) ?? false;
      if (expanded) ensureContent();
      toggle.setAttribute('aria-expanded', String(expanded));
      indicator.textContent = expanded ? '▾' : '▸';
      content.classList.toggle('hidden', !expanded);
    };
    toggle.addEventListener('click', () => {
      if (!this.isCurrentActiveDrawer(active)) return;
      if (active.customExpandedSections?.has(key)) active.customExpandedSections.delete(key);
      else active.customExpandedSections?.add(key);
      update();
    });
    toggle.append(label, indicator);
    update();
    section.append(toggle, content);
    return section;
  }

  private toggleDrawerYaml(): void {
    const active = this.activeDetail;
    const detail = this.displayDetail();
    if (!active || !detail || !this.isCurrentActiveDrawer(active)) return;
    const opening = this.detailYamlWrap.classList.contains('hidden');
    this.detailYamlWrap.classList.toggle('hidden', !opening);
    this.detailOverview.classList.toggle('hidden', opening);
    this.detailYamlCopy.classList.toggle('hidden', !opening);
    this.detailYamlToggle.setAttribute('aria-pressed', String(opening));
    this.detailYamlToggle.setAttribute('aria-label', opening ? 'Hide YAML' : 'View YAML');
    if (opening) this.renderDrawerYaml(detail);
    else {
      this.detailYaml.textContent = '';
      this.resetYamlFind();
    }
  }

  private renderDrawerYaml(detail: Record<string, unknown>): void {
    let source: string;
    try {
      source = serializeKubernetesDetailYaml(detail);
    } catch (error) {
      this.detailYaml.textContent = toErrorMessage(error);
      return;
    }
    const code = document.createElement('code');
    code.className = 'hljs';
    code.textContent = source;
    if (source.length <= CODE_HIGHLIGHT_LIMITS.explicitCharacters) {
      try {
        const root = kubernetesYamlLowlight.highlight('yaml', source);
        code.replaceChildren();
        for (const child of root.children) appendKubernetesHighlightNode(code, child);
      } catch {
        // Fall back to the plain-text content already assigned above.
      }
    }
    this.detailYaml.replaceChildren(code);
  }

  private async copyDrawerYaml(): Promise<void> {
    if (this.detailYamlWrap.classList.contains('hidden') || this.detailYamlCopy.disabled) return;
    const text = this.detailYaml.textContent ?? '';
    this.detailYamlCopy.disabled = true;
    try {
      await window.serviceApi.writeClipboardText(text);
      this.detailYamlCopy.dataset.copied = 'true';
      this.detailYamlCopy.setAttribute('aria-label', 'YAML copied');
      this.detailYamlCopy.title = 'YAML copied';
      if (this.detailYamlCopyResetTimer !== undefined) window.clearTimeout(this.detailYamlCopyResetTimer);
      this.detailYamlCopyResetTimer = window.setTimeout(() => this.resetDrawerYamlCopyFeedback(), 1_200);
    } catch (error) {
      setMessage(`Unable to copy YAML: ${toErrorMessage(error)}`, 'error');
    } finally {
      this.detailYamlCopy.disabled = false;
    }
  }

  private resetDrawerYamlCopyFeedback(): void {
    this.detailYamlCopyResetTimer = undefined;
    delete this.detailYamlCopy.dataset.copied;
    this.detailYamlCopy.setAttribute('aria-label', 'Copy YAML');
    this.detailYamlCopy.title = 'Copy YAML';
  }

  private resetDrawerYamlCopyAction(): void {
    if (this.detailYamlCopyResetTimer !== undefined) {
      window.clearTimeout(this.detailYamlCopyResetTimer);
      this.detailYamlCopyResetTimer = undefined;
    }
    this.resetDrawerYamlCopyFeedback();
    this.detailYamlCopy.classList.add('hidden');
    this.detailYamlCopy.disabled = false;
  }

  private isYamlVisible(): boolean {
    return this.visible
      && !this.detailDrawer.classList.contains('hidden')
      && !this.detailYamlWrap.classList.contains('hidden');
  }

  private handleYamlFindShortcut(event: KeyboardEvent): void {
    if (!this.isYamlVisible() || event.isComposing) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && !event.altKey && !event.shiftKey
      && event.key.toLocaleLowerCase() === 'f') {
      event.preventDefault();
      event.stopPropagation();
      this.openYamlFind();
      return;
    }
    if (event.key === 'F3') {
      event.preventDefault();
      event.stopPropagation();
      if (this.yamlFindOpen) this.moveYamlFind(event.shiftKey ? -1 : 1);
      else this.openYamlFind();
      return;
    }
    if (event.key === 'Escape' && this.yamlFindOpen) {
      event.preventDefault();
      event.stopPropagation();
      this.closeYamlFind();
    }
  }

  private openYamlFind(): void {
    if (!this.isYamlVisible()) return;
    this.yamlFindOpen = true;
    this.detailYamlFind.classList.remove('hidden');
    this.detailYamlFind.setAttribute('aria-hidden', 'false');
    this.detailYamlFindInput.focus({ preventScroll: true });
    this.detailYamlFindInput.select();
    window.requestAnimationFrame(() => {
      if (this.yamlFindOpen && this.isYamlVisible()) {
        this.detailYamlFindInput.focus({ preventScroll: true });
        this.detailYamlFindInput.select();
      }
    });
    this.refreshYamlFind(false);
  }

  private scheduleYamlFind(): void {
    if (!this.yamlFindOpen || this.yamlFindFrame !== undefined) return;
    this.yamlFindFrame = window.requestAnimationFrame(() => {
      this.yamlFindFrame = undefined;
      this.refreshYamlFind(true);
    });
  }

  private refreshYamlFind(reveal: boolean): void {
    if (!this.yamlFindOpen) return;
    const anchor = this.yamlFindActiveIndex >= 0
      ? (this.yamlFindMatches[this.yamlFindActiveIndex]?.from ?? 0)
      : 0;
    const result = findNotesTextMatches(this.detailYaml.textContent ?? '', this.detailYamlFindInput.value);
    this.yamlFindMatches = result.matches;
    this.yamlFindTruncated = result.truncated;
    this.yamlFindActiveIndex = initialNotesFindIndex(this.yamlFindMatches, anchor);
    this.applyYamlFindHighlights();
    this.updateYamlFindControls();
    if (reveal) this.revealYamlFindMatch();
  }

  private applyYamlFindHighlights(): void {
    const code = this.detailYaml.querySelector<HTMLElement>('code');
    if (!code) return;
    const text = code.textContent ?? '';
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const [index, match] of this.yamlFindMatches.entries()) {
      if (match.from < cursor || match.from > text.length || match.to > text.length) continue;
      if (match.from > cursor) fragment.append(text.slice(cursor, match.from));
      const mark = document.createElement('mark');
      mark.className = index === this.yamlFindActiveIndex
        ? 'kubernetes-find-match-active'
        : 'kubernetes-find-match';
      mark.textContent = text.slice(match.from, match.to);
      fragment.append(mark);
      cursor = match.to;
    }
    if (cursor < text.length) fragment.append(text.slice(cursor));
    code.replaceChildren(fragment);
  }

  private moveYamlFind(direction: 1 | -1): void {
    if (!this.yamlFindOpen) return;
    this.yamlFindActiveIndex = moveNotesFindIndex(
      this.yamlFindActiveIndex,
      this.yamlFindMatches.length,
      direction,
    );
    this.applyYamlFindHighlights();
    this.updateYamlFindControls();
    this.revealYamlFindMatch();
    this.detailYamlFindInput.focus({ preventScroll: true });
  }

  private revealYamlFindMatch(): void {
    if (this.yamlFindActiveIndex < 0) return;
    const active = this.detailYaml.querySelector<HTMLElement>('.kubernetes-find-match-active');
    if (!active) return;
    const containerRect = this.detailYaml.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.top < containerRect.top + 16 || activeRect.bottom > containerRect.bottom - 16) {
      this.detailYaml.scrollTop += activeRect.top - containerRect.top - 24;
    }
    if (activeRect.left < containerRect.left + 8 || activeRect.right > containerRect.right - 8) {
      this.detailYaml.scrollLeft += activeRect.left - containerRect.left - 24;
    }
  }

  private updateYamlFindControls(): void {
    const count = this.yamlFindMatches.length;
    const current = this.yamlFindActiveIndex >= 0 ? this.yamlFindActiveIndex + 1 : 0;
    const total = `${count.toLocaleString('en-US')}${this.yamlFindTruncated ? '+' : ''}`;
    this.detailYamlFindCounter.textContent = `${current.toLocaleString('en-US')} / ${total}`;
    this.detailYamlFindCounter.setAttribute(
      'aria-label',
      count > 0
        ? `${current.toLocaleString('en-US')} of ${total} matches`
        : 'No matches',
    );
    this.detailYamlFindPrevious.disabled = count === 0;
    this.detailYamlFindNext.disabled = count === 0;
    this.detailYamlFind.dataset.noResults = String(Boolean(this.detailYamlFindInput.value) && count === 0);
  }

  private closeYamlFind(): void {
    if (!this.yamlFindOpen) return;
    this.yamlFindOpen = false;
    if (this.yamlFindFrame !== undefined) {
      window.cancelAnimationFrame(this.yamlFindFrame);
      this.yamlFindFrame = undefined;
    }
    this.detailYamlFindInput.value = '';
    this.detailYamlFindInput.blur();
    const detail = this.displayDetail();
    if (detail) this.renderDrawerYaml(detail);
    this.resetYamlFindControls();
  }

  private resetYamlFind(): void {
    this.yamlFindOpen = false;
    this.yamlFindMatches = [];
    this.yamlFindActiveIndex = -1;
    this.yamlFindTruncated = false;
    if (this.yamlFindFrame !== undefined) {
      window.cancelAnimationFrame(this.yamlFindFrame);
      this.yamlFindFrame = undefined;
    }
    this.detailYamlFindInput.value = '';
    this.resetYamlFindControls();
  }

  private resetYamlFindControls(): void {
    this.detailYamlFind.classList.add('hidden');
    this.detailYamlFind.setAttribute('aria-hidden', 'true');
    this.detailYamlFindCounter.textContent = '0 / 0';
    this.detailYamlFindCounter.setAttribute('aria-label', 'No matches');
    this.detailYamlFindPrevious.disabled = true;
    this.detailYamlFindNext.disabled = true;
    delete this.detailYamlFind.dataset.noResults;
  }

  private requestDrawerEvents(active: ActiveDetail): void {
    if (!this.isCurrentActiveDrawer(active) || active.eventsLoading || active.events || active.eventsError) return;
    active.eventsLoading = true;
    this.renderDetail();
    void window.kubernetesApi.getResourceEvents(active.summary.uid, active.summary.namespace).then((events) => {
      if (!this.isCurrentActiveDrawer(active)) return;
      active.events = events;
      active.eventsLoading = false;
      this.renderDetail();
    }).catch((error) => {
      if (!this.isCurrentActiveDrawer(active)) return;
      active.eventsError = `Unable to load Events: ${toErrorMessage(error)}`;
      active.eventsLoading = false;
      this.renderDetail();
    });
  }

  private renderDrawerEvents(active: ActiveDetail): HTMLElement {
    const section = document.createElement('section');
    section.className = 'kubernetes-drawer-events kubernetes-drawer-section';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'kubernetes-drawer-section-toggle';
    const label = document.createElement('span');
    label.textContent = 'Events';
    const indicator = document.createElement('span');
    const content = document.createElement('div');
    content.className = 'kubernetes-drawer-section-content';
    const expanded = active.eventsExpanded ?? false;
    toggle.setAttribute('aria-expanded', String(expanded));
    indicator.textContent = expanded ? '▾' : '▸';
    content.classList.toggle('hidden', !expanded);
    toggle.addEventListener('click', () => {
      if (!this.isCurrentActiveDrawer(active)) return;
      active.eventsExpanded = !(active.eventsExpanded ?? false);
      const opening = active.eventsExpanded;
      this.renderDetail();
      if (opening) this.requestDrawerEvents(active);
    });
    toggle.append(label, indicator);
    section.append(toggle, content);
    if (!expanded) return section;
    if (active.eventsLoading) {
      const loading = document.createElement('p');
      loading.textContent = 'Loading events…';
      content.appendChild(loading);
      return section;
    }
    if (active.eventsError) {
      const error = document.createElement('p');
      error.className = 'kubernetes-drawer-events-error';
      error.textContent = active.eventsError;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-secondary btn-sm';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        if (!this.isCurrentActiveDrawer(active) || active.eventsLoading) return;
        active.eventsError = undefined;
        this.requestDrawerEvents(active);
      });
      content.append(error, retry);
      return section;
    }
    const events = active.events ?? [];
    if (events.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No Events found for this resource.';
      content.appendChild(empty);
      return section;
    }
    const list = document.createElement('div');
    list.className = 'kubernetes-drawer-event-list';
    for (const event of events) {
      const row = document.createElement('div');
      row.className = 'kubernetes-drawer-event-row';
      const reason = document.createElement('strong');
      reason.textContent = event.columns.reason ?? event.status ?? event.name;
      const type = document.createElement('span');
      type.textContent = `Type: ${event.columns.type ?? '—'}`;
      const time = document.createElement('span');
      time.textContent = `Time: ${event.columns.observedAt ?? event.createdAt ?? '—'}`;
      const message = document.createElement('span');
      message.textContent = `Message: ${event.columns.message ?? '—'}`;
      const count = document.createElement('span');
      count.textContent = `Count: ${event.columns.count ?? '0'}`;
      row.append(reason, type, time, message, count);
      list.appendChild(row);
    }
    content.appendChild(list);
    return section;
  }

  private renderDrawerPortForward(active: ActiveDetail): void {
    const targetKind = active.query.kind === 'pods' ? 'pod'
      : active.query.kind === 'services' ? 'service'
        : undefined;
    const namespace = active.summary.namespace;
    const activeForward = Boolean(targetKind && namespace && hasActiveKubernetesPortForward(
      [...this.portForwards.values()],
      { targetKind, namespace, targetName: active.summary.name },
    ));
    this.detailPortForwardButton.classList.toggle('hidden', !targetKind);
    this.detailPortForwardButton.classList.toggle('kubernetes-detail-port-forward-active', activeForward);
    this.detailPortForwardButton.disabled = !targetKind || !namespace;
    this.detailPortForwardButton.setAttribute('aria-label', activeForward ? 'Port Forward (active)' : 'Port Forward');
    this.detailPortForwardButton.title = activeForward ? 'Port Forward active' : 'Port Forward';
  }

  private resetDrawerVncAction(): void {
    this.vncOpening = undefined;
    this.detailVncButton.classList.add('hidden');
    this.detailVncButton.disabled = true;
    this.detailVncButton.removeAttribute('aria-busy');
    this.detailVncButton.setAttribute('aria-label', 'Open VNC with system client');
    this.detailVncButton.removeAttribute('title');
    this.detailVncLabel.textContent = 'VNC';
  }

  private renderDrawerVnc(detail: Record<string, unknown>, active: ActiveDetail): void {
    const target = active.query.kind === 'pods' ? detectKubeVirtVncTarget(detail) : undefined;
    const busy = Boolean(target && this.vncOpening?.drawerGeneration === active.request.drawerGeneration);
    this.detailVncButton.classList.toggle('hidden', !target);
    this.detailVncButton.disabled = !target || busy;
    this.detailVncButton.toggleAttribute('aria-busy', busy);
    this.detailVncLabel.textContent = busy ? 'Opening…' : 'VNC';
    if (target) {
      const description = `Open VNC for ${target.vmiName} with system client`;
      this.detailVncButton.setAttribute('aria-label', description);
      this.detailVncButton.title = description;
    } else {
      this.detailVncButton.setAttribute('aria-label', 'Open VNC with system client');
      this.detailVncButton.removeAttribute('title');
    }
  }

  private async openVnc(): Promise<void> {
    const active = this.activeDetail;
    if (!active || !this.isCurrentActiveDrawer(active) || this.vncOpening) return;
    const target = active.query.kind === 'pods' ? detectKubeVirtVncTarget(active.detail) : undefined;
    if (!target) return;

    const opening = { drawerGeneration: active.request.drawerGeneration };
    this.vncOpening = opening;
    this.renderDrawerVnc(active.detail, active);
    try {
      await window.kubernetesApi.openVnc({
        namespace: target.namespace,
        podName: target.podName,
        podUid: target.podUid,
      });
      if (this.vncOpening === opening && this.isCurrentActiveDrawer(active)) {
        setMessage('VNC client opened.', 'success');
      }
    } catch (error) {
      if (this.vncOpening === opening && this.isCurrentActiveDrawer(active)) {
        setMessage(toErrorMessage(error), 'error');
      }
    } finally {
      if (this.vncOpening !== opening) return;
      this.vncOpening = undefined;
      if (this.isCurrentActiveDrawer(active)) this.renderDrawerVnc(active.detail, active);
    }
  }

  private renderPodDrawer(detail: Record<string, unknown>, active: ActiveDetail): void {
    const model = buildKubernetesDrawerModel(detail, active.summary);
    if (this.drawerEnvironment && (!this.isCurrentDrawerEnvironment(this.drawerEnvironment)
      || !model.containers.some((container) => sameKubernetesPodTarget(container.target, this.drawerEnvironment?.target)))) {
      this.clearDrawerEnvironment();
    }
    const header = document.createElement('dl');
    header.className = 'kubernetes-drawer-header-grid';
    for (const [label, value] of model.header) {
      const item = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      description.textContent = value;
      description.title = value;
      item.append(term, description);
      header.appendChild(item);
    }
    this.detailOverview.appendChild(header);

    this.detailOverview.appendChild(this.createDrawerSection('Labels', false, (content) => {
      if (model.labels.length === 0) {
        const empty = document.createElement('p');
        empty.textContent = 'No labels declared.';
        content.appendChild(empty);
        return;
      }
      for (const [key, value] of model.labels) {
        const row = document.createElement('div');
        row.className = 'kubernetes-drawer-label-row';
        const label = document.createElement('span');
        label.textContent = key;
        label.title = key;
        const text = document.createElement('span');
        text.textContent = value;
        text.title = value;
        row.append(label, text);
        content.appendChild(row);
      }
    }));

    this.detailOverview.appendChild(this.createDrawerSection('Containers', true, (content) => {
      content.classList.add('kubernetes-drawer-containers-content');
      if (model.containers.length === 0) {
        const empty = document.createElement('p');
        empty.textContent = 'No containers declared.';
        content.appendChild(empty);
        return;
      }
      for (const container of model.containers) {
        const environmentState = this.drawerEnvironment
          && this.isCurrentActiveDrawer(active)
          && sameKubernetesPodTarget(this.drawerEnvironment.target, container.target)
          ? this.drawerEnvironment
          : undefined;
        const card = document.createElement('article');
        card.className = 'kubernetes-drawer-container';
        const head = document.createElement('div');
        head.className = 'kubernetes-drawer-container-head';
        const name = document.createElement('strong');
        name.className = 'kubernetes-drawer-container-name';
        name.textContent = container.name;
        const primary = document.createElement('div');
        primary.className = 'kubernetes-drawer-container-primary';
        const actions = document.createElement('div');
        actions.className = 'kubernetes-drawer-container-actions';
        const logs = document.createElement('button');
        logs.type = 'button';
        logs.className = 'icon-btn kubernetes-drawer-container-action-logs';
        logs.setAttribute('aria-label', `View logs for ${container.name}`);
        logs.setAttribute('title', `View logs for ${container.name}`);
        logs.appendChild(createKubernetesDrawerIcon([
          'M5 3.5h10v13H5z',
          'M7.5 7h5M7.5 10h5M7.5 13h3.5',
        ]));
        logs.addEventListener('click', () => {
          if (!this.workspace) return;
          void this.workspace.openLogs(container.target);
          this.closeDetail();
        });
        const shell = document.createElement('button');
        shell.type = 'button';
        shell.className = 'icon-btn kubernetes-drawer-container-action-shell';
        shell.setAttribute('aria-label', `Open shell for ${container.name}`);
        shell.setAttribute('title', `Open shell for ${container.name}`);
        shell.appendChild(createKubernetesDrawerIcon([
          'M4 5.5 8 9l-4 3.5M10.5 13h5',
        ]));
        shell.addEventListener('click', () => {
          if (!this.workspace) return;
          void this.workspace.openShell(container.target);
        });
        actions.append(logs, shell);
        primary.append(name, actions);
        const kind = document.createElement('span');
        kind.className = 'kubernetes-drawer-container-kind';
        kind.textContent = container.init ? 'Init container' : 'Container';
        head.append(primary, kind);
        const info = document.createElement('section');
        info.className = 'kubernetes-drawer-container-block kubernetes-drawer-container-info';
        const infoTitle = document.createElement('h4');
        infoTitle.className = 'kubernetes-drawer-container-subtitle kubernetes-drawer-container-info-title';
        infoTitle.textContent = 'Info';
        const facts = document.createElement('dl');
        facts.className = 'kubernetes-drawer-facts';
        for (const [label, value] of [
          ['Status', container.status],
          ['Image', container.image],
          ['Pull policy', container.imagePullPolicy],
          ['Mounts', container.mounts],
          ['Command', container.command],
        ]) {
          const fact = document.createElement('div');
          const term = document.createElement('dt');
          term.textContent = label;
          const description = document.createElement('dd');
          description.textContent = value;
          description.title = value;
          fact.append(term, description);
          facts.appendChild(fact);
        }
        info.append(infoTitle, facts);
        card.append(head, info);
        if (shouldRenderKubernetesEnvironment(container.environmentDeclared, environmentState?.result)) {
          card.appendChild(this.renderContainerEnvironment(container, active));
        }
        content.appendChild(card);
      }
    }));
  }

  /** Drops the sole active-drawer Env result before its owner can change. */
  private clearDrawerEnvironment(): void {
    this.drawerEnvironment = undefined;
    this.drawerEnvironmentElement?.remove();
    this.drawerEnvironmentElement = undefined;
  }

  private isCurrentDrawerEnvironment(state: DrawerEnvironmentState): boolean {
    return this.drawerEnvironment === state
      && isCurrentKubernetesEnvironmentRequest(
        {
          visible: this.visible && this.drawerRequest.visible && this.activeDetail !== undefined,
          drawerGeneration: this.detailGeneration,
          target: state.target,
        },
        {
          visible: true,
          drawerGeneration: state.drawerGeneration,
          target: state.target,
        },
      );
  }

  private renderContainerEnvironment(container: KubernetesDrawerContainer, active: ActiveDetail): HTMLElement {
    const section = document.createElement('section');
    section.className = 'kubernetes-drawer-container-block kubernetes-drawer-container-env';
    const state = this.drawerEnvironment
      && this.isCurrentActiveDrawer(active)
      && sameKubernetesPodTarget(this.drawerEnvironment.target, container.target)
      ? this.drawerEnvironment
      : undefined;
    if (state) this.drawerEnvironmentElement = section;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'kubernetes-drawer-container-subtitle kubernetes-drawer-container-env-toggle';
    toggle.setAttribute('aria-label', 'Toggle environment');
    const label = document.createElement('span');
    label.textContent = 'Env';
    const indicator = document.createElement('span');
    const content = document.createElement('div');
    content.className = 'kubernetes-drawer-container-env-content';
    const expanded = state?.expanded ?? false;
    toggle.setAttribute('aria-expanded', String(expanded));
    indicator.textContent = expanded ? '▾' : '▸';
    content.classList.toggle('hidden', !expanded);
    if (state?.expanded) this.renderDrawerEnvironmentContent(content, state);
    toggle.addEventListener('click', () => {
      if (!this.isCurrentActiveDrawer(active)) return;
      const current = this.drawerEnvironment;
      if (current && sameKubernetesPodTarget(current.target, container.target)
        && this.isCurrentDrawerEnvironment(current)) {
        current.expanded = !current.expanded;
        this.renderDetail();
        if (current.expanded) this.requestDrawerEnvironment(current);
        return;
      }

      this.clearDrawerEnvironment();
      const next: DrawerEnvironmentState = {
        target: { ...container.target },
        drawerGeneration: this.detailGeneration,
        loading: false,
        expanded: false,
        search: '',
      };
      next.expanded = true;
      this.drawerEnvironment = next;
      this.requestDrawerEnvironment(next);
    });
    toggle.append(label, indicator);
    section.append(toggle, content);
    return section;
  }

  private renderDrawerEnvironmentContent(content: HTMLElement, state: DrawerEnvironmentState): void {
    if (state.loading) {
      const loading = document.createElement('p');
      loading.className = 'kubernetes-env-notice';
      loading.textContent = 'Loading environment…';
      content.appendChild(loading);
      return;
    }
    if (state.error === 'unavailable' || !state.result) {
      const error = document.createElement('p');
      error.className = 'kubernetes-env-notice kubernetes-env-notice-error';
      error.textContent = 'Unable to load environment';
      content.appendChild(error);
      return;
    }
    const result = state.result;

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'kubernetes-env-search';
    search.setAttribute('aria-label', 'Search environment');
    search.placeholder = 'Search environment';
    search.value = state.search;
    const renderEntries = (): void => {
      if (state.error === 'permission') {
        const permission = document.createElement('p');
        permission.className = 'kubernetes-env-notice kubernetes-env-notice-error';
        permission.textContent = 'No permission to read referenced Secret';
        content.appendChild(permission);
      }
      if (result.truncated) {
        const truncated = document.createElement('p');
        truncated.className = 'kubernetes-env-notice';
        truncated.textContent = 'Environment values truncated for safe display';
        content.appendChild(truncated);
      }

      const entries = filterKubernetesEnvironmentEntries(result.entries, state.search);
      if (entries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'kubernetes-env-notice';
        empty.textContent = state.search ? 'No environment entries match the search.' : 'No environment variables declared.';
        content.appendChild(empty);
        return;
      }
      const list = document.createElement('div');
      list.className = 'kubernetes-env-list';
      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'kubernetes-env-row';
        const name = document.createElement('code');
        name.textContent = entry.name;
        const value = document.createElement('pre');
        value.textContent = entry.value ?? environmentUnavailableLabel(entry.unavailable);
        row.append(name, value);
        list.appendChild(row);
      }
      content.appendChild(list);
    };
    search.addEventListener('input', () => {
      if (!this.isCurrentDrawerEnvironment(state)) return;
      state.search = search.value;
      while (search.nextSibling) search.nextSibling.remove();
      renderEntries();
    });
    content.appendChild(search);
    renderEntries();
  }

  private createDrawerSection(
    title: string,
    initiallyExpanded: boolean,
    renderContent: (content: HTMLElement) => void,
  ): HTMLElement {
    const section = document.createElement('section');
    section.className = 'kubernetes-drawer-section';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'kubernetes-drawer-section-toggle';
    const label = document.createElement('span');
    label.textContent = title;
    const indicator = document.createElement('span');
    let expanded = initiallyExpanded;
    const content = document.createElement('div');
    content.className = 'kubernetes-drawer-section-content';
    renderContent(content);
    const update = (): void => {
      toggle.setAttribute('aria-expanded', String(expanded));
      indicator.textContent = expanded ? '▾' : '▸';
      content.classList.toggle('hidden', !expanded);
    };
    toggle.addEventListener('click', () => {
      expanded = !expanded;
      update();
    });
    toggle.append(label, indicator);
    update();
    section.append(toggle, content);
    return section;
  }

  private requestDrawerEnvironment(state: DrawerEnvironmentState): void {
    if (state.result || state.loading || state.error) return;
    if (!this.isCurrentDrawerEnvironment(state)) return;
    state.loading = true;
    this.renderDetail();
    void Promise.resolve().then(() => window.kubernetesApi.getPodContainerEnvironment(state.target)).then((result) => {
      if (!this.isCurrentDrawerEnvironment(state)) return;
      state.loading = false;
      state.result = result;
      state.error = result.permissionDenied ? 'permission' : undefined;
      this.renderDetail();
    }).catch(() => {
      if (!this.isCurrentDrawerEnvironment(state)) return;
      state.loading = false;
      // The runtime already routes transient failures through Context recovery.
      // The renderer deliberately retains no source error text or object.
      state.error = 'unavailable';
      this.renderDetail();
    });
  }

  /**
   * Related resources are intentionally collapsed until a user expands this
   * detail-only section. The active resource list owns Watch lifecycle, so no
   * relation path may activate a list or replace its snapshot.
   */
  private renderRelatedDetail(active: ActiveDetail): HTMLElement | undefined {
    const state = this.relatedState(active);
    if (!state) return undefined;

    const section = document.createElement('section');
    section.className = 'kubernetes-related-section kubernetes-drawer-section';
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
      if (state.loading || !this.isCurrentActiveDrawer(active)) return;
      state.expanded = !state.expanded;
      this.renderDetail();
      if (state.expanded && !state.resources && !state.error) {
        void this.loadRelatedResources(active, state);
      }
    });
    header.append(heading, toggle);
    section.appendChild(header);

    if (!state.expanded) {
      return section;
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
        if (!state.loading && this.isCurrentActiveDrawer(active)) {
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
    return section;
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
  }

  private isCurrentRelatedRequest(
    active: ActiveDetail,
    state: RelatedDetailState,
    detailGeneration: number,
    relatedGeneration: number,
  ): boolean {
    return this.isCurrentActiveDrawer(active)
      && active.related === state
      && state.expanded
      && this.detailGeneration === detailGeneration
      && this.relatedGeneration === relatedGeneration;
  }

  private async loadRelatedResources(active: ActiveDetail, state: RelatedDetailState): Promise<void> {
    if (!this.isCurrentActiveDrawer(active) || !state.expanded || state.loading) return;
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
      this.renderDetail();
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
          this.renderDetail();
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
          this.renderDetail();
        },
      },
    );
  }

  private renderRelatedResources(active: ActiveDetail, resources: KubernetesRelatedResources): HTMLElement {
    const container = document.createElement('div');
    container.className = 'kubernetes-related-list';
    if (active.query.kind === 'services') {
      for (const warning of resources.warnings ?? []) {
        const feedback = document.createElement('p');
        feedback.className = 'kubernetes-related-feedback kubernetes-related-warning';
        feedback.textContent = warning;
        container.appendChild(feedback);
      }
      const groups = [
        ['Endpoints', resources.endpoints ?? []],
        ['EndpointSlices', resources.endpointSlices ?? []],
      ] as const;
      if (!groups.some(([, values]) => values.length > 0)) {
        const empty = document.createElement('p');
        empty.className = 'kubernetes-related-feedback';
        empty.textContent = 'No backend resources found.';
        container.appendChild(empty);
        return container;
      }
      for (const [label, values] of groups) {
        if (values.length === 0) continue;
        const heading = document.createElement('h4');
        heading.textContent = label;
        container.appendChild(heading);
        for (const backend of values) {
          const row = document.createElement('div');
          row.className = 'kubernetes-related-row kubernetes-related-backend-row';
          const name = document.createElement('span');
          name.textContent = backend.name;
          const status = document.createElement('span');
          status.textContent = backend.notReady > 0
            ? `${backend.ready} ready · ${backend.notReady} not ready`
            : `${backend.ready} ready`;
          row.append(name, status);
          const details = [
            backend.ports.length > 0
              ? `Ports: ${backend.ports.join(', ')}${backend.portCount > backend.ports.length
                ? ` · +${backend.portCount - backend.ports.length} more`
                : ''}`
              : undefined,
            backend.targets.length > 0
              ? `Targets: ${backend.targets.join(', ')}${backend.targetCount > backend.targets.length
                ? ` · +${backend.targetCount - backend.targets.length} more`
                : ''}`
              : undefined,
          ].filter((value): value is string => Boolean(value));
          if (details.length > 0) {
            const meta = document.createElement('span');
            meta.className = 'kubernetes-related-backend-meta';
            meta.textContent = details.join(' · ');
            meta.title = meta.textContent;
            row.appendChild(meta);
          }
          container.appendChild(row);
        }
      }
      return container;
    }

    const pods = resources.pods ?? [];
    const hasItems = pods.length > 0;
    if (!hasItems) {
      const empty = document.createElement('p');
      empty.className = 'kubernetes-related-feedback';
      empty.textContent = 'No related Pods found.';
      container.appendChild(empty);
      return container;
    }
    const heading = document.createElement('h4');
    heading.textContent = 'Pods';
    container.appendChild(heading);
    for (const item of pods) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'kubernetes-related-row kubernetes-related-pod-link';
      row.addEventListener('click', () => { void this.openRelatedPod(active, item); });
      const name = document.createElement('span');
      name.textContent = item.namespace ? `${item.namespace}/${item.name}` : item.name;
      const status = document.createElement('span');
      status.textContent = item.status ?? 'Pod';
      row.append(name, status);
      container.appendChild(row);
    }
    return container;
  }

  private async openRelatedPod(active: ActiveDetail, summary: KubernetesResourceSummary): Promise<void> {
    if (!this.isCurrentActiveDrawer(active) || !summary.namespace) return;
    const originQuery = active.originQuery;
    const query: KubernetesResourceQuery = {
      context: active.query.context,
      kind: 'pods',
      scope: 'namespaced',
      namespaceScope: { mode: 'selected', namespaces: [summary.namespace] },
    };
    const generation = this.beginDrawerReplacement();
    const request = this.createDrawerRequest(summary, generation);
    this.drawerRequest = request;
    this.detailTitle.textContent = 'Loading Pod…';
    await runKubernetesDrawerDetailRequest(
      () => window.kubernetesApi.getResourceDetail(query, summary.name, summary.namespace),
      {
        isCurrent: () => this.isCurrentDrawerRequest(request, originQuery),
        onSuccess: (detail) => {
          const next: ActiveDetail = { originQuery, query, summary, detail, request };
          this.activeDetail = next;
          this.decodedSecretDetail = undefined;
          this.renderDetail();
        },
        onError: (error) => {
          setMessage(toErrorMessage(error), 'error');
          this.closeDetail();
        },
      },
    );
  }

  private openPortForwardDialog(): void {
    if (this.detailPortForwardButton.disabled) return;
    const active = this.activeDetail;
    const detail = this.displayDetail();
    const targetKind = active?.query.kind === 'pods' ? 'pod'
      : active?.query.kind === 'services' ? 'service'
        : undefined;
    if (!active || !detail || !targetKind || !active.summary.namespace || !this.isCurrentActiveDrawer(active)) return;
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
      option.textContent = String(port.remotePort);
      this.portForwardDeclaredPort.appendChild(option);
    }
    this.portForwardDeclaredPort.value = '';
    this.portForwardDeclaredField.classList.toggle('hidden', !dialogModel.selectorVisible);
    this.portForwardRemotePort.value = dialogModel.remotePort;
    this.portForwardLocalPort.value = '';
    this.portForwardOpenBrowser.checked = true;
    this.setPortForwardError('');
    if (!this.portForwardDialog.open) this.portForwardDialog.showModal();
  }

  private closePortForwardDialog(): void {
    if (this.portForwardDialog.open) this.portForwardDialog.close();
    this.portForwardDraft = undefined;
    this.portForwardDeclaredField.classList.add('hidden');
    this.portForwardDeclaredPort.replaceChildren();
    this.setPortForwardError('');
  }

  private async submitPortForward(): Promise<void> {
    const draft = this.portForwardDraft;
    if (!draft) return;
    const remotePort = this.parsePort(this.portForwardRemotePort.value, 'Remote port', false);
    const localPort = this.parsePort(this.portForwardLocalPort.value, 'Local port', true);
    const openInBrowser = this.portForwardOpenBrowser.checked;
    if (remotePort === undefined || remotePort === null || localPort === null) return;
    const input: KubernetesPortForwardInput = {
      ...draft,
      remotePort,
      ...(localPort === undefined ? {} : { localPort }),
    };
    let state: KubernetesPortForwardState;
    try {
      state = await window.kubernetesApi.startPortForward(input);
    } catch (error) {
      const message = toErrorMessage(error);
      this.setPortForwardError(message);
      setMessage(message, 'error');
      return;
    }
    this.portForwardLocalPort.value = String(state.localPort);
    this.portForwardRevision += 1;
    this.portForwards.set(state.id, state);
    this.renderPortForwards();
    this.closePortForwardDialog();
    setMessage(`Port forward started at 127.0.0.1:${state.localPort}.`, 'success');
    if (openInBrowser) await this.openPortForwardEndpoint(state.localPort, true);
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
    const pageGeneration = this.pageGeneration;
    const revision = this.portForwardRevision;
    try {
      const forwards = await window.kubernetesApi.listPortForwards();
      if (!this.visible || pageGeneration !== this.pageGeneration || revision !== this.portForwardRevision) return;
      this.portForwards = new Map(forwards.map((forward) => [forward.id, forward]));
      this.renderPortForwards();
    } catch (error) {
      setMessage(toErrorMessage(error), 'error');
    }
  }

  private onPortForwardChanged(state: KubernetesPortForwardState): void {
    this.portForwardRevision += 1;
    if (state.state === 'stopped') this.portForwards.delete(state.id);
    else this.portForwards.set(state.id, state);
    this.renderPortForwards();
  }

  private openPortForwardsDialog(): void {
    if (!this.portForwardsDialog.open) this.portForwardsDialog.showModal();
  }

  private closePortForwardsDialog(): void {
    if (this.portForwardsDialog.open) this.portForwardsDialog.close();
  }

  private async stopAllListedPortForwards(): Promise<void> {
    if (this.closingAllPortForwards) return;
    const listedIds = [...this.portForwards.keys()];
    if (listedIds.length === 0) return;
    this.closingAllPortForwards = true;
    this.renderPortForwards();
    try {
      await window.kubernetesApi.stopAllPortForwards();
      for (const id of listedIds) this.portForwards.delete(id);
      setMessage('All port forwards closed.', 'success');
    } catch (error) {
      setMessage(toErrorMessage(error), 'error');
      void this.loadPortForwards();
    } finally {
      this.closingAllPortForwards = false;
      this.renderPortForwards();
    }
  }

  private async openPortForwardEndpoint(localPort: number, justStarted = false): Promise<void> {
    try {
      await window.serviceApi.openExternal(`http://127.0.0.1:${localPort}`);
    } catch (error) {
      setMessage(
        `${justStarted ? 'Port forward started, but the browser could not be opened' : 'Unable to open the forwarded port'}: ${toErrorMessage(error)}`,
        'error',
      );
    }
  }

  private renderPortForwards(): void {
    this.portForwardList.replaceChildren();
    const forwards = [...this.portForwards.values()];
    this.portForwardsCount.textContent = String(forwards.length);
    this.portForwardsToggle.setAttribute('aria-label', `Forwarded Ports (${forwards.length})`);
    this.portForwardsCloseAll.disabled = this.closingAllPortForwards || forwards.length === 0;
    const active = this.activeDetail;
    if (active && this.isCurrentActiveDrawer(active)) this.renderDrawerPortForward(active);
    if (forwards.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'kubernetes-port-forward-empty';
      empty.textContent = 'No active port forwards.';
      this.portForwardList.appendChild(empty);
      return;
    }
    for (const forward of forwards) {
      const row = document.createElement('div');
      row.className = 'kubernetes-port-forward-row';
      const target = document.createElement('span');
      target.textContent = `${forward.namespace}/${forward.targetName}`;
      const mapping = document.createElement('div');
      mapping.className = 'kubernetes-port-forward-mapping';
      const endpoint = document.createElement('button');
      endpoint.type = 'button';
      endpoint.className = 'kubernetes-port-forward-endpoint';
      endpoint.textContent = forward.localPort > 0 ? `127.0.0.1:${forward.localPort}` : 'Allocating local port…';
      endpoint.disabled = forward.state !== 'running' || forward.localPort < 1;
      endpoint.setAttribute('aria-label', `Open 127.0.0.1:${forward.localPort} in the default browser`);
      endpoint.addEventListener('click', () => { void this.openPortForwardEndpoint(forward.localPort); });
      const remote = document.createElement('span');
      remote.textContent = `→ ${forward.remotePort}`;
      mapping.append(endpoint, remote);
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
    const columns = getKubernetesListColumns(this.resourceKind, this.selectedCustomDefinition);
    const fields = getKubernetesResourceRowValues(this.resourceKind, item, this.selectedCustomDefinition);
    for (const [index, value] of fields.entries()) {
      const column = columns[index];
      const cell = document.createElement('span');
      cell.className = 'kubernetes-table-cell';
      cell.setAttribute('role', 'cell');
      if (this.resourceKind === 'pods' && column?.key === 'namespace') {
        cell.classList.add('kubernetes-table-pod-namespace');
        cell.textContent = value;
      } else if (this.resourceKind === 'pods' && column?.key === 'name') {
        const parts = splitKubernetesDeploymentPodName(value);
        const primary = document.createElement('span');
        primary.className = 'kubernetes-table-pod-name-primary';
        primary.textContent = parts.primary;
        cell.appendChild(primary);
        if (parts.suffix) {
          const suffix = document.createElement('span');
          suffix.className = 'kubernetes-table-pod-name-suffix';
          suffix.textContent = parts.suffix;
          cell.appendChild(suffix);
        }
      } else {
        cell.textContent = value;
      }
      if (column?.key === 'age') {
        cell.dataset.kubernetesAgeCell = item.createdAt ?? '';
      }
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
