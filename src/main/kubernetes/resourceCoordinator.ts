import type { KubernetesResourceSummary } from './resourceQuery';
import { baseResourceQuery, mergeResourcePage, resourceQueryKey } from './resourceQuery';
import type { KubernetesResourceQuery } from './resourceQuery';
import type { KubernetesClient, KubernetesWatchEvent } from './kubernetesClient';
import { ResourceCache } from './resourceCache';

export interface KubernetesListSnapshot {
  query: KubernetesResourceQuery;
  items: KubernetesResourceSummary[];
  loadedCount: number;
  continueToken?: string;
  resourceVersion: string;
  watchActive: boolean;
  permissionDenied?: boolean;
  error?: string;
}

export interface ResourceCoordinatorOptions {
  client: () => KubernetesClient;
  cache: ResourceCache<KubernetesListSnapshot>;
  /** Main-process lifecycle hook. It must not send a transport error to IPC. */
  onWatchError?: (event: KubernetesWatchEvent) => void;
  /** A coalesced Watch/relist snapshot changed; callers may publish one view. */
  onSnapshotChanged?: (snapshot: KubernetesListSnapshot) => void;
}

interface ActiveRecord {
  key: string;
  query: KubernetesResourceQuery;
  consumers: number;
  ready: Promise<KubernetesListSnapshot>;
  snapshot?: KubernetesListSnapshot;
  abortController?: AbortController;
  watchGeneration: number;
  listGeneration: number;
  nextPage?: Promise<KubernetesListSnapshot>;
  recovering?: Promise<void>;
  pendingWatchEvents: KubernetesWatchEvent[];
  watchFlushQueued: boolean;
}

function snapshotCacheKey(query: KubernetesResourceQuery): string {
  return `list:${resourceQueryKey(query)}`;
}

function detailCacheKey(query: KubernetesResourceQuery, name: string, namespace?: string): string {
  return `detail:${resourceQueryKey(query)}:${namespace ?? ''}:${name}`;
}

function eventsCacheKey(reference: { uid: string; namespace?: string }): string {
  return `events:${reference.namespace ?? ''}:${reference.uid}`;
}

function isGone(event: KubernetesWatchEvent): boolean {
  return event.type === 'ERROR' && event.statusCode === 410;
}

function isPermissionDenied(event: KubernetesWatchEvent): boolean {
  return event.statusCode === 401 || event.statusCode === 403;
}

/**
 * Coordinates the one LIST/Watch pair that backs a currently visible resource
 * view. Keys intentionally omit local name filtering and sorting so renderer
 * changes do not create extra Kubernetes requests or Watch connections.
 */
export class ResourceCoordinator {
  private readonly active = new Map<string, ActiveRecord>();
  private disposed = false;

  public constructor(private readonly options: ResourceCoordinatorOptions) {}

  public activate(query: KubernetesResourceQuery): Promise<KubernetesListSnapshot> {
    this.assertUsable();
    const key = resourceQueryKey(query);
    const existing = this.active.get(key);
    if (existing) {
      existing.consumers += 1;
      return existing.ready;
    }

    const record: ActiveRecord = {
      key,
      query: baseResourceQuery(query),
      consumers: 1,
      ready: Promise.resolve(undefined as never),
      watchGeneration: 0,
      listGeneration: 0,
      pendingWatchEvents: [],
      watchFlushQueued: false,
    };
    record.ready = this.initialize(record);
    this.active.set(key, record);
    void record.ready.catch(() => {
      if (this.active.get(record.key) === record) {
        this.active.delete(record.key);
      }
    });
    return record.ready;
  }

  public async loadNextPage(query: KubernetesResourceQuery): Promise<KubernetesListSnapshot> {
    this.assertUsable();
    const record = this.active.get(resourceQueryKey(query));
    if (!record) {
      throw new Error('The Kubernetes resource list is not active.');
    }
    const snapshot = await record.ready;
    if (!this.isActive(record) || !snapshot.continueToken) {
      return snapshot;
    }
    if (record.recovering) {
      await record.recovering;
      return record.snapshot ?? snapshot;
    }
    if (record.nextPage) {
      return record.nextPage;
    }

    const continuation = snapshot.continueToken;
    const listGeneration = record.listGeneration;
    const pending = this.options.client().list(record.query, continuation).then((page) => {
      if (!this.canMergePage(record, snapshot, listGeneration)) {
        return this.snapshotAfterRecovery(record, snapshot);
      }
      snapshot.items = mergeResourcePage(snapshot.items, page.items);
      snapshot.loadedCount = snapshot.items.length;
      snapshot.continueToken = page.continueToken;
      snapshot.resourceVersion = page.resourceVersion || snapshot.resourceVersion;
      this.options.cache.set(snapshotCacheKey(record.query), snapshot);
      return snapshot;
    });
    record.nextPage = pending;
    void pending.finally(() => {
      if (record.nextPage === pending) {
        record.nextPage = undefined;
      }
    }).catch(() => undefined);
    return pending;
  }

  public async deactivate(query?: KubernetesResourceQuery): Promise<void> {
    if (query) {
      const record = this.active.get(resourceQueryKey(query));
      if (!record) {
        return;
      }
      record.consumers -= 1;
      if (record.consumers > 0) {
        return;
      }
      this.active.delete(record.key);
      this.stopWatch(record);
      return;
    }

    for (const record of [...this.active.values()]) {
      record.consumers = 0;
      this.active.delete(record.key);
      this.stopWatch(record);
    }
  }

  public getDetail(
    query: KubernetesResourceQuery,
    name: string,
    namespace?: string
  ): Promise<Record<string, unknown>> {
    this.assertUsable();
    if (query.kind === 'secrets') {
      // Secret plaintext must stay only in the active detail view, never in a
      // reusable cache (including an in-flight cache shared with later views).
      return this.options.client().get(query, name, namespace);
    }
    return this.options.cache.getOrCreate(
      detailCacheKey(query, name, namespace),
      () => this.options.client().get(query, name, namespace)
    );
  }

  public getEvents(reference: { uid: string; namespace?: string }): Promise<KubernetesResourceSummary[]> {
    this.assertUsable();
    return this.options.cache.getOrCreate(
      eventsCacheKey(reference),
      () => this.options.client().listEvents(reference)
    );
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.deactivate();
    this.options.cache.clear();
  }

  private async initialize(record: ActiveRecord): Promise<KubernetesListSnapshot> {
    const snapshot = await this.options.cache.getOrCreate(
      snapshotCacheKey(record.query),
      async () => {
        const page = await this.options.client().list(record.query);
        return this.createSnapshot(record.query, page);
      }
    );
    if (!this.isActive(record)) {
      return snapshot;
    }

    record.snapshot = snapshot;
    snapshot.watchActive = false;
    await this.startWatch(record);
    return snapshot;
  }

  private createSnapshot(
    query: KubernetesResourceQuery,
    page: { items: KubernetesResourceSummary[]; continueToken?: string; resourceVersion: string }
  ): KubernetesListSnapshot {
    return {
      query,
      items: [...page.items],
      loadedCount: page.items.length,
      ...(page.continueToken ? { continueToken: page.continueToken } : {}),
      resourceVersion: page.resourceVersion,
      watchActive: false,
    };
  }

  private async startWatch(record: ActiveRecord): Promise<void> {
    const snapshot = record.snapshot;
    if (!snapshot || !this.isActive(record)) {
      return;
    }
    const generation = record.watchGeneration + 1;
    record.watchGeneration = generation;
    const controller = await this.options.client().watch(
      record.query,
      snapshot.resourceVersion,
      (event) => this.handleWatchEvent(record, generation, event)
    );
    if (!this.isActive(record) || record.watchGeneration !== generation) {
      controller.abort();
      return;
    }
    record.abortController = controller;
    snapshot.watchActive = true;
    this.options.cache.set(snapshotCacheKey(record.query), snapshot);
  }

  private handleWatchEvent(record: ActiveRecord, generation: number, event: KubernetesWatchEvent): void {
    if (!this.isActive(record) || record.watchGeneration !== generation || !record.snapshot) {
      return;
    }
    record.pendingWatchEvents.push(event);
    if (record.watchFlushQueued) {
      return;
    }
    record.watchFlushQueued = true;
    queueMicrotask(() => this.flushWatchEvents(record, generation));
  }

  /**
   * Reconcile a stream burst in one pass. Kubernetes Watch callbacks often
   * arrive synchronously in large bursts; rebuilding a loaded page for every
   * event turns one burst into O(events × loaded-items) work and one cache
   * publication per event.
   */
  private flushWatchEvents(record: ActiveRecord, generation: number): void {
    record.watchFlushQueued = false;
    if (!this.isActive(record) || record.watchGeneration !== generation || !record.snapshot) {
      record.pendingWatchEvents = [];
      return;
    }

    const events = record.pendingWatchEvents;
    record.pendingWatchEvents = [];
    const snapshot = record.snapshot;
    const normalEvents: KubernetesWatchEvent[] = [];

    for (const event of events) {
      if (isGone(event)) {
        this.applyWatchEvents(snapshot, normalEvents);
        this.invalidatePageRequests(record);
        void this.recoverGoneWatch(record).catch(() => {
          if (this.isActive(record) && record.snapshot) {
            record.snapshot.watchActive = false;
            this.options.cache.set(snapshotCacheKey(record.query), record.snapshot);
          }
        });
        return;
      }
      if (event.type === 'ERROR') {
        this.applyWatchEvents(snapshot, normalEvents);
        snapshot.permissionDenied = isPermissionDenied(event) || undefined;
        snapshot.error = snapshot.permissionDenied
          ? 'No permission to watch this Kubernetes resource.'
          : 'The Kubernetes resource Watch stopped.';
        this.stopWatch(record);
        this.options.onSnapshotChanged?.(snapshot);
        this.options.onWatchError?.(event);
        return;
      }
      normalEvents.push(event);
    }

    if (this.applyWatchEvents(snapshot, normalEvents)) {
      this.options.cache.set(snapshotCacheKey(record.query), snapshot);
      this.options.onSnapshotChanged?.(snapshot);
    }
  }

  /** Applies ordered Watch mutations with at most one full loaded-page scan. */
  private applyWatchEvents(snapshot: KubernetesListSnapshot, events: KubernetesWatchEvent[]): boolean {
    if (events.length === 0) {
      return false;
    }

    let resourceVersionChanged = false;
    let order: string[] | undefined;
    let values: Map<string, KubernetesResourceSummary> | undefined;
    let locations: Map<string, number> | undefined;
    let removed: Set<number> | undefined;
    const ensureWorkingSet = (): void => {
      if (order && values && locations && removed) {
        return;
      }
      order = snapshot.items.map((item) => item.uid);
      values = new Map(snapshot.items.map((item) => [item.uid, item]));
      locations = new Map(order.map((uid, index) => [uid, index]));
      removed = new Set<number>();
    };

    for (const event of events) {
      const nextResourceVersion = event.resourceVersion ?? event.object?.resourceVersion;
      if (nextResourceVersion && nextResourceVersion !== snapshot.resourceVersion) {
        snapshot.resourceVersion = nextResourceVersion;
        resourceVersionChanged = true;
      }

      if ((event.type === 'ADDED' || event.type === 'MODIFIED') && event.object) {
        ensureWorkingSet();
        const existingLocation = locations?.get(event.object.uid);
        if (existingLocation === undefined) {
          locations?.set(event.object.uid, order?.length ?? 0);
          order?.push(event.object.uid);
        }
        values?.set(event.object.uid, event.object);
        continue;
      }

      if (event.type === 'DELETED' && event.object) {
        ensureWorkingSet();
        const existingLocation = locations?.get(event.object.uid);
        if (existingLocation !== undefined) {
          removed?.add(existingLocation);
          locations?.delete(event.object.uid);
          values?.delete(event.object.uid);
        }
      }
    }

    if (order && values && removed) {
      snapshot.items = order.flatMap((uid, index) => {
        const item = values?.get(uid);
        return removed?.has(index) || !item ? [] : [item];
      });
      snapshot.loadedCount = snapshot.items.length;
      return true;
    }
    return resourceVersionChanged;
  }

  private async recoverGoneWatch(record: ActiveRecord): Promise<void> {
    if (record.recovering) {
      return record.recovering;
    }
    const recovery = this.relistAfterGone(record);
    record.recovering = recovery;
    try {
      await recovery;
    } finally {
      if (record.recovering === recovery) {
        record.recovering = undefined;
      }
    }
  }

  private async relistAfterGone(record: ActiveRecord): Promise<void> {
    this.stopWatch(record);
    if (!this.isActive(record)) {
      return;
    }
    const page = await this.options.client().list(record.query);
    if (!this.isActive(record) || !record.snapshot) {
      return;
    }

    const replacement = this.createSnapshot(record.query, page);
    record.snapshot.items = replacement.items;
    record.snapshot.loadedCount = replacement.loadedCount;
    record.snapshot.continueToken = replacement.continueToken;
    record.snapshot.resourceVersion = replacement.resourceVersion;
    record.snapshot.watchActive = false;
    this.options.cache.set(snapshotCacheKey(record.query), record.snapshot);
    await this.startWatch(record);
    if (record.snapshot) {
      this.options.onSnapshotChanged?.(record.snapshot);
    }
  }

  private stopWatch(record: ActiveRecord): void {
    record.watchGeneration += 1;
    record.pendingWatchEvents = [];
    record.watchFlushQueued = false;
    const controller = record.abortController;
    record.abortController = undefined;
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    if (record.snapshot) {
      record.snapshot.watchActive = false;
      this.options.cache.set(snapshotCacheKey(record.query), record.snapshot);
    }
  }

  private invalidatePageRequests(record: ActiveRecord): void {
    record.listGeneration += 1;
    record.nextPage = undefined;
  }

  private canMergePage(
    record: ActiveRecord,
    snapshot: KubernetesListSnapshot,
    listGeneration: number
  ): boolean {
    return this.isActive(record)
      && record.snapshot === snapshot
      && record.listGeneration === listGeneration;
  }

  private async snapshotAfterRecovery(
    record: ActiveRecord,
    fallback: KubernetesListSnapshot
  ): Promise<KubernetesListSnapshot> {
    if (record.recovering) {
      await record.recovering;
    }
    return record.snapshot ?? fallback;
  }

  private isActive(record: ActiveRecord): boolean {
    return !this.disposed && record.consumers > 0 && this.active.get(record.key) === record;
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error('The Kubernetes resource coordinator is disposed.');
    }
  }
}
