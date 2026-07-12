import type { KubernetesNamespaceScope, KubernetesResourceKind } from '../../shared/types';
import { normalizeNamespaceScope } from './kubeconfigStore';

export interface KubernetesResourceQuery {
  context: string;
  kind: KubernetesResourceKind;
  apiVersion?: string;
  plural?: string;
  /**
   * Built-in cluster-scoped kinds are recognized automatically. Dynamic
   * custom resources must mark their scope so LIST and Watch keys cannot
   * collide with a namespaced resource using the same GVK.
   */
  scope?: 'namespaced' | 'cluster';
  namespaceScope: KubernetesNamespaceScope;
  labelSelector?: string;
  fieldSelector?: string;
  /**
   * A view-only filter over items which have already been loaded. It is
   * intentionally omitted from resourceQueryKey so it cannot create a LIST
   * request or a Watch; the main process applies it before IPC output.
   */
  nameFilter?: string;
  /**
   * A view-only ordering over items which have already been loaded. It is
   * intentionally omitted from resourceQueryKey so it cannot create a LIST
   * request or a Watch; the main process applies it before IPC output.
   */
  sort?: {
    column: string;
    direction: 'asc' | 'desc';
  };
}

export interface KubernetesResourceSummary {
  uid: string;
  name: string;
  namespace?: string;
  resourceVersion: string;
  createdAt?: string;
  status?: string;
  columns: Record<string, string>;
}

export interface KubernetesResourcePage {
  items: KubernetesResourceSummary[];
  continueToken?: string;
  resourceVersion: string;
}

/**
 * Removes display-only controls before a query crosses the LIST/Watch client
 * boundary. The coordinator retains this base query in its cache, while the
 * runtime applies the active view projection immediately before IPC output.
 */
export function baseResourceQuery(query: KubernetesResourceQuery): KubernetesResourceQuery {
  const { nameFilter: _nameFilter, sort: _sort, ...base } = query;
  return {
    ...base,
    namespaceScope: {
      mode: base.namespaceScope.mode,
      namespaces: [...base.namespaceScope.namespaces],
    },
  };
}

export interface KubernetesVirtualWindow<T> {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
  items: T[];
}

const CLUSTER_SCOPED_KINDS = new Set<KubernetesResourceKind>(['nodes', 'namespaces']);

function resourceScope(query: KubernetesResourceQuery): 'namespaced' | 'cluster' {
  if (CLUSTER_SCOPED_KINDS.has(query.kind)) {
    return 'cluster';
  }

  return query.scope ?? 'namespaced';
}

/**
 * Identifies only values which affect a Kubernetes LIST request or Watch.
 * View search and sorting are omitted deliberately so those controls do not
 * create another request or server-side subscription.
 */
export function resourceQueryKey(query: KubernetesResourceQuery): string {
  const scope = resourceScope(query);
  const namespaceScope = scope === 'cluster'
    ? { mode: 'all' as const, namespaces: [] }
    : normalizeNamespaceScope(query.namespaceScope);

  return JSON.stringify([
    query.context,
    query.kind,
    query.apiVersion ?? null,
    query.plural ?? null,
    scope,
    namespaceScope.mode,
    namespaceScope.namespaces,
    query.labelSelector ?? null,
    query.fieldSelector ?? null,
  ]);
}

/**
 * Reconciles a later page or Watch event without moving an existing row. The
 * Kubernetes resourceVersion is deliberately treated as an opaque value: the
 * latest provided object replaces the matching UID rather than relying on a
 * numeric comparison which Kubernetes does not guarantee.
 */
export function mergeResourcePage(
  current: KubernetesResourceSummary[],
  incoming: KubernetesResourceSummary[]
): KubernetesResourceSummary[] {
  const merged = [...current];
  const positions = new Map<string, number>();

  merged.forEach((item, index) => {
    positions.set(item.uid, index);
  });

  for (const item of incoming) {
    const position = positions.get(item.uid);
    if (position === undefined) {
      positions.set(item.uid, merged.length);
      merged.push(item);
    } else {
      merged[position] = item;
    }
  }

  return merged;
}

function valueForSort(item: KubernetesResourceSummary, column: string): string {
  if (column === 'name') return item.name;
  if (column === 'namespace') return item.namespace ?? '';
  if (column === 'status') return item.status ?? '';
  if (column === 'age') return item.createdAt ?? '';
  return item.columns[column] ?? '';
}

/**
 * Performs loaded-only search and ordering in the main process. This keeps
 * the renderer's scroll path limited to virtual-window calculations and DOM
 * replacement, while the coordinator continues to cache unfiltered items.
 */
export function projectLoadedResourceItems(
  items: KubernetesResourceSummary[],
  query: KubernetesResourceQuery
): KubernetesResourceSummary[] {
  const nameFilter = query.nameFilter?.trim().toLocaleLowerCase();
  // The default active view is already in the coordinator's loaded order.
  // Return it by reference so a Watch update for a 10k-Pod list does not first
  // clone every row before extracting the renderer's bounded window.
  const projected = nameFilter
    ? items.filter((item) => item.name.toLocaleLowerCase().includes(nameFilter))
    : query.sort
      ? [...items]
      : items;

  if (!query.sort) {
    return projected;
  }

  const { column, direction } = query.sort;
  return projected.sort((left, right) => {
    const result = valueForSort(left, column).localeCompare(valueForSort(right, column));
    return direction === 'asc' ? result : -result;
  });
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }

  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }

  return value;
}

/**
 * Projects a fixed-height list into the bounded range a virtual table needs
 * to render. `end` is exclusive and includes one overscan range before and
 * after the visible rows.
 */
export function projectVirtualWindow<T>(
  items: T[],
  scrollTop: number,
  rowHeight: number,
  viewportHeight: number,
  overscan: number
): KubernetesVirtualWindow<T> {
  const validRowHeight = positiveFinite(rowHeight, 'rowHeight');
  const validViewportHeight = nonNegativeFinite(viewportHeight, 'viewportHeight');
  const validOverscan = Math.floor(nonNegativeFinite(overscan, 'overscan'));
  const totalHeight = items.length * validRowHeight;
  const maxScrollTop = Math.max(0, totalHeight - validViewportHeight);
  const clampedScrollTop = Number.isFinite(scrollTop)
    ? Math.min(Math.max(0, scrollTop), maxScrollTop)
    : 0;
  const visibleStart = Math.floor(clampedScrollTop / validRowHeight);
  const visibleEnd = Math.min(
    items.length,
    Math.ceil((clampedScrollTop + validViewportHeight) / validRowHeight)
  );
  const start = Math.max(0, visibleStart - validOverscan);
  const end = Math.min(items.length, visibleEnd + validOverscan);

  return {
    start,
    end,
    offsetTop: start * validRowHeight,
    totalHeight,
    items: items.slice(start, end),
  };
}

function copyWithoutSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(copyWithoutSecretFields);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const copied: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'data' || key === 'stringData') {
      continue;
    }
    copied[key] = copyWithoutSecretFields(child);
  }
  return copied;
}

/**
 * Produces a cache-safe Secret representation. Every object and array is
 * recreated so callers cannot retain references to `data` or `stringData`.
 */
export function sanitizeSecretForCache(value: Record<string, unknown>): Record<string, unknown> {
  return copyWithoutSecretFields(value) as Record<string, unknown>;
}
