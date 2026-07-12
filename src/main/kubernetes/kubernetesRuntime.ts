import { watch as watchPath } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  KubernetesListSnapshot as RendererKubernetesListSnapshot,
  KubernetesCustomResourceDefinition,
  KubernetesLogState,
  KubernetesNamespaceScope,
  KubernetesPodTarget,
  KubernetesPortForwardInput,
  KubernetesPortForwardState,
  KubernetesRelatedResourceRequest,
  KubernetesRelatedResources,
  KubernetesResourceKind,
  KubernetesResourceQuery as RendererKubernetesResourceQuery,
  KubernetesResourceSummary,
  KubernetesResourceWindowRange,
  KubernetesState,
  KubernetesTerminalState,
  KubernetesTerminalOutput,
} from '../../shared/types';
import { ClusterSession, classifyKubernetesConnectionError } from './clusterSession';
import { type KubernetesContextPreference } from './contextPreference';
import { diffKubeconfigContexts, normalizeNamespaceScope, type KubeconfigDocument } from './kubeconfigStore';
import {
  catalogFromDocument,
  kubeconfigDirectoryForHome,
  resolveKubeconfigContext,
  scanKubeconfigDirectory,
  type KubeconfigCatalog,
  type KubeconfigContextSource,
} from './kubeconfigCatalog';
import { createKubernetesClient, type KubernetesClient, type KubernetesWatchEvent } from './kubernetesClient';
import { PodInteractionManager, type KubernetesPortForwardInput as RuntimePortForwardInput, type KubernetesPodInteractionTarget } from './podInteractions';
import { ResourceCache } from './resourceCache';
import { ResourceCoordinator, type KubernetesListSnapshot, type ResourceCoordinatorOptions } from './resourceCoordinator';
import { projectLoadedResourceItems, resourceQueryKey, type KubernetesResourceQuery } from './resourceQuery';

const RESOURCE_KINDS = new Set<KubernetesResourceKind>([
  'pods',
  'deployments',
  'statefulsets',
  'services',
  'ingresses',
  'configmaps',
  'secrets',
  'persistentvolumeclaims',
  'nodes',
  'namespaces',
  'custom-resources',
]);

const MAX_RENDERER_TEXT_LENGTH = 16_384;
const MAX_TERMINAL_INPUT_LENGTH = 65_536;
const DEFAULT_RENDERER_WINDOW_SIZE = 128;
const MAX_RENDERER_WINDOW_SIZE = 256;
const CUSTOM_RESOURCE_PART = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;
const CUSTOM_RESOURCE_VERSION = /^v[0-9]+(?:alpha[0-9]+|beta[0-9]+)?$/;

export interface KubernetesRuntimeSession {
  getState(): KubernetesState;
  getClient(): KubernetesClient;
  setContexts(
    contexts: KubernetesState['contexts'],
    options?: { reconnectActiveContext?: boolean }
  ): Promise<void> | void;
  selectContext(name: string): Promise<KubernetesState>;
  reconnect(): Promise<KubernetesState>;
  disconnect(reason: string): Promise<void>;
}

export interface KubernetesCoordinator {
  activate(query: KubernetesResourceQuery): Promise<KubernetesListSnapshot>;
  loadNextPage(query: KubernetesResourceQuery): Promise<KubernetesListSnapshot>;
  deactivate(query?: KubernetesResourceQuery): Promise<void>;
  getDetail(query: KubernetesResourceQuery, name: string, namespace?: string): Promise<Record<string, unknown>>;
  getEvents(reference: { uid: string; namespace?: string }): Promise<KubernetesResourceSummary[]>;
  dispose(): Promise<void>;
}

export interface KubernetesInteractions {
  openLogs(input: KubernetesPodInteractionTarget): Promise<KubernetesLogState>;
  loadOlderLogs(id: string): Promise<KubernetesLogState>;
  setLogFollowing(id: string, following: boolean): Promise<KubernetesLogState>;
  clearLogs(id: string): KubernetesLogState;
  closeLogs(id: string): Promise<void>;
  openTerminal(input: KubernetesPodInteractionTarget): Promise<KubernetesTerminalState>;
  writeTerminal(id: string, data: string): void;
  resizeTerminal(id: string, cols: number, rows: number): void;
  closeTerminal(id: string): Promise<void>;
  startPortForward(input: RuntimePortForwardInput): Promise<KubernetesPortForwardState>;
  stopPortForward(id: string): Promise<void>;
  listPortForwards(): KubernetesPortForwardState[];
  onLogChanged(listener: (state: KubernetesLogState) => void): () => void;
  onTerminalChanged(listener: (state: KubernetesTerminalState) => void): () => void;
  onTerminalOutput(listener: (output: KubernetesTerminalOutput) => void): () => void;
  disposePageScoped(): Promise<void>;
  disposeAll(): Promise<void>;
}

export interface KubernetesRuntimeOptions {
  kubeconfigDirectory?: string;
  readKubeconfigCatalog?: () => Promise<KubeconfigCatalog>;
  watchKubeconfigDirectory?: (listener: () => void) => () => void;
  createClient?: (source: KubeconfigContextSource) => Promise<KubernetesClient>;
  /** @deprecated Single-file injection retained for focused runtime tests. */
  kubeconfigPath?: string;
  session?: KubernetesRuntimeSession;
  createCoordinator?: (client: () => KubernetesClient) => KubernetesCoordinator;
  createInteractions?: (client: () => KubernetesClient) => KubernetesInteractions;
  /** @deprecated Single-document injection retained for focused runtime tests. */
  readKubeconfig?: () => Promise<KubeconfigDocument>;
  /** @deprecated Single-file watcher injection retained for focused runtime tests. */
  watchKubeconfig?: (listener: () => void) => () => void;
  /** Main-process durable, credential-free Context selection-ID preference. */
  contextPreference?: KubernetesContextPreference;
  onDiagnostic?: (scope: string, error: Error, context: Record<string, string>) => void;
}

type StateListener = (state: KubernetesState) => void;
type ListListener = (snapshot: RendererKubernetesListSnapshot) => void;
type LogListener = (state: KubernetesLogState) => void;
type TerminalListener = (state: KubernetesTerminalState) => void;
type TerminalOutputListener = (output: KubernetesTerminalOutput) => void;
type PortForwardListener = (state: KubernetesPortForwardState) => void;

function copyScope(scope: KubernetesNamespaceScope): KubernetesNamespaceScope {
  return { mode: scope.mode, namespaces: [...scope.namespaces] };
}

function copyState(state: KubernetesState, namespaceScope: KubernetesNamespaceScope, reloadAvailable: boolean): KubernetesState {
  return {
    contexts: state.contexts.map((context) => ({ ...context })),
    ...(state.selectedContext ? { selectedContext: state.selectedContext } : {}),
    connection: state.connection,
    ...(state.error ? { error: state.error } : {}),
    kubeconfigReloadAvailable: reloadAvailable,
    namespaceScope: copyScope(namespaceScope),
  };
}

function copySummary(value: KubernetesResourceSummary): KubernetesResourceSummary {
  return {
    ...value,
    ...(value.namespace ? { namespace: value.namespace } : {}),
    ...(value.createdAt ? { createdAt: value.createdAt } : {}),
    ...(value.status ? { status: value.status } : {}),
    columns: { ...value.columns },
  };
}

function copyRelatedResources(value: KubernetesRelatedResources): KubernetesRelatedResources {
  return {
    ...(value.pods ? { pods: value.pods.map(copySummary) } : {}),
    ...(value.endpoints ? { endpoints: value.endpoints.map(copySummary) } : {}),
    ...(value.endpointSlices ? { endpointSlices: value.endpointSlices.map(copySummary) } : {}),
  };
}

function copyQuery(query: KubernetesResourceQuery): KubernetesResourceQuery {
  return {
    ...query,
    namespaceScope: copyScope(query.namespaceScope),
    ...(query.sort ? { sort: { ...query.sort } } : {}),
  };
}

function normalizedWindowRange(value: KubernetesResourceWindowRange): KubernetesResourceWindowRange {
  if (!Number.isInteger(value.start) || value.start < 0 || !Number.isInteger(value.end) || value.end < value.start) {
    throw new Error('Kubernetes virtual window is invalid.');
  }
  return {
    start: value.start,
    end: Math.min(value.end, value.start + MAX_RENDERER_WINDOW_SIZE),
  };
}

function projectSnapshotWindow(
  snapshot: KubernetesListSnapshot,
  viewQuery: KubernetesResourceQuery,
  range: KubernetesResourceWindowRange
): RendererKubernetesListSnapshot {
  const normalized = normalizedWindowRange(range);
  const projected = projectLoadedResourceItems(snapshot.items, viewQuery);
  const start = Math.min(normalized.start, projected.length);
  const end = Math.min(Math.max(start, normalized.end), projected.length);
  return {
    query: copyQuery(viewQuery),
    start,
    end,
    total: projected.length,
    items: projected.slice(start, end).map(copySummary),
    loadedCount: snapshot.loadedCount,
    ...(snapshot.continueToken ? { continueToken: snapshot.continueToken } : {}),
    resourceVersion: snapshot.resourceVersion,
    watchActive: snapshot.watchActive,
    ...(snapshot.permissionDenied ? { permissionDenied: true } : {}),
    ...(snapshot.error ? { error: snapshot.error } : {}),
  };
}

function copyLogState(state: KubernetesLogState): KubernetesLogState {
  return { ...state, lines: [...state.lines] };
}

function copyTerminalState(state: KubernetesTerminalState): KubernetesTerminalState {
  return { ...state };
}

function copyTerminalOutput(output: KubernetesTerminalOutput): KubernetesTerminalOutput {
  return { ...output };
}

function copyPortForwardState(state: KubernetesPortForwardState): KubernetesPortForwardState {
  return { ...state };
}

function assertText(value: unknown, label: string, maximum = MAX_RENDERER_TEXT_LENGTH): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Kubernetes ${label} is required.`);
  }
  if (value.length > maximum) {
    throw new Error(`Kubernetes ${label} is too long.`);
  }
  return value;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return assertText(value, label);
}

function assertPort(value: unknown, label: 'remote' | 'local', allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > 65_535) {
    throw new Error(`Kubernetes ${label} port must be an integer between ${minimum} and 65535.`);
  }
  return value;
}

function errorFromUnknown(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

/**
 * ES2020 does not expose AggregateError in this project's TypeScript lib.
 * Keep every cleanup cause available to the caller without letting a failed
 * first cleanup prevent the later client-disconnect attempt.
 */
function cleanupFailureError(failures: unknown[], fallback: string): Error | undefined {
  if (failures.length === 0) {
    return undefined;
  }
  if (failures.length === 1) {
    return errorFromUnknown(failures[0], fallback);
  }
  const error = new Error(fallback);
  Object.assign(error, { causes: failures.map((failure) => errorFromUnknown(failure, fallback)) });
  return error;
}

function throwCleanupFailures(failures: unknown[], fallback: string): void {
  const error = cleanupFailureError(failures, fallback);
  if (error) {
    throw error;
  }
}

interface PendingListActivation {
  key: string;
  generation: number;
  coordinator: KubernetesCoordinator;
  promise: Promise<KubernetesListSnapshot>;
}

interface PendingListBroadcast {
  query: KubernetesResourceQuery;
  generation: number;
}

/**
 * Main-process lifecycle owner for one Kubernetes Context. The renderer only
 * receives copies of display-safe state; kubeconfig contents and transports
 * remain inside the concrete client/session implementations.
 */
export class KubernetesRuntime {
  private readonly kubeconfigDirectory: string;
  private readonly readKubeconfigCatalog: () => Promise<KubeconfigCatalog>;
  private readonly createCoordinator: (client: () => KubernetesClient) => KubernetesCoordinator;
  private readonly createInteractions: (client: () => KubernetesClient) => KubernetesInteractions;
  private readonly onDiagnostic?: (scope: string, error: Error, context: Record<string, string>) => void;
  private readonly contextPreference?: KubernetesContextPreference;
  private readonly session: KubernetesRuntimeSession;
  private coordinator?: KubernetesCoordinator;
  private interactions?: KubernetesInteractions;
  private currentQuery?: KubernetesResourceQuery;
  private currentSnapshot?: KubernetesListSnapshot;
  private pendingListActivation?: PendingListActivation;
  private readonly pendingListBroadcasts = new Map<string, PendingListBroadcast>();
  private rendererRange: KubernetesResourceWindowRange = { start: 0, end: DEFAULT_RENDERER_WINDOW_SIZE };
  private restoreQuery?: KubernetesResourceQuery;
  private queryGeneration = 0;
  private contextTransitionGeneration?: number;
  private namespaceScope: KubernetesNamespaceScope = { mode: 'all', namespaces: [] };
  private activeCatalog: KubeconfigCatalog = { contexts: [], sources: new Map(), fingerprint: '' };
  private kubeconfigReloadAvailable = false;
  private localError?: string;
  private stopWatchingKubeconfig?: () => void;
  private lifecycle: Promise<void> = Promise.resolve();
  private shutdownPromise?: Promise<void>;
  private reconnectMonitor?: Promise<void>;
  private disposed = false;
  private readonly stateListeners = new Set<StateListener>();
  private readonly listListeners = new Set<ListListener>();
  private readonly logListeners = new Set<LogListener>();
  private readonly terminalListeners = new Set<TerminalListener>();
  private readonly terminalOutputListeners = new Set<TerminalOutputListener>();
  private readonly portForwardListeners = new Set<PortForwardListener>();
  private interactionSubscriptions: Array<() => void> = [];
  /** Detail-only results share in-flight work briefly, but never a Watch or list snapshot. */
  private readonly relatedResourcesCache = new ResourceCache<KubernetesRelatedResources>(32, 30_000);
  private readonly customResourceDefinitionsCache = new ResourceCache<KubernetesCustomResourceDefinition[]>(4, 120_000);

  public constructor(options: KubernetesRuntimeOptions = {}) {
    const defaultDirectory = kubeconfigDirectoryForHome(homedir());
    this.kubeconfigDirectory = options.kubeconfigDirectory
      ?? (options.kubeconfigPath ? path.dirname(options.kubeconfigPath) : defaultDirectory);
    const legacyKubeconfigPath = options.kubeconfigPath ?? path.join(this.kubeconfigDirectory, 'config');
    this.readKubeconfigCatalog = options.readKubeconfigCatalog
      ?? (options.readKubeconfig
        ? async () => catalogFromDocument(legacyKubeconfigPath, await options.readKubeconfig!())
        : () => scanKubeconfigDirectory(this.kubeconfigDirectory));
    this.createCoordinator = options.createCoordinator ?? ((client) => new ResourceCoordinator({
      client,
      cache: new ResourceCache<KubernetesListSnapshot>(32, 120_000),
      onWatchError: (event) => this.handleWatchError(event),
      onSnapshotChanged: (snapshot) => this.queueWatchListBroadcast(snapshot.query, this.queryGeneration),
    } satisfies ResourceCoordinatorOptions));
    this.createInteractions = options.createInteractions ?? ((client) => new PodInteractionManager({ client }));
    this.onDiagnostic = options.onDiagnostic;
    this.contextPreference = options.contextPreference;
    const clientFactory = options.createClient ?? ((source: KubeconfigContextSource) => createKubernetesClient({
      kubeconfigPath: source.kubeconfigPath,
      context: source.contextName,
    }));
    this.session = options.session ?? new ClusterSession({
      createClient: (selectionId) => {
        const source = resolveKubeconfigContext(this.activeCatalog, selectionId);
        if (!source) {
          throw new Error('The selected Kubernetes Context is no longer available.');
        }
        return clientFactory(source);
      },
      disposeOwnedResources: () => this.disposeContextResources(),
    });
    this.coordinator = this.createCoordinator(() => this.observedClient());
    this.interactions = this.createInteractions(() => this.observedClient());

    const watchFactory = options.watchKubeconfigDirectory
      ?? options.watchKubeconfig
      ?? ((listener: () => void) => this.watchLocalKubeconfigDirectory(listener));
    this.stopWatchingKubeconfig = watchFactory(() => {
      void this.enqueueLifecycle(async () => {
        if (this.disposed) {
          return;
        }
        const next = await this.readKubeconfigCatalog();
        if (
          diffKubeconfigContexts(this.activeCatalog.contexts, next.contexts)
          || this.activeCatalog.fingerprint !== next.fingerprint
        ) {
          this.kubeconfigReloadAvailable = true;
          this.emitState();
        }
      }).catch(() => undefined);
    });
  }

  public async init(): Promise<KubernetesState> {
    return this.enqueueLifecycle(async () => {
      this.assertUsable();
      try {
        const catalog = await this.readKubeconfigCatalog();
        this.activeCatalog = catalog;
        await this.session.setContexts(catalog.contexts);
        await this.restoreContextPreference(catalog.contexts);
        this.kubeconfigReloadAvailable = false;
        this.localError = undefined;
      } catch {
        this.activeCatalog = { contexts: [], sources: new Map(), fingerprint: '' };
        await this.session.setContexts([]);
        this.localError = 'The local Kubernetes kubeconfig directory could not be read.';
      }
      const state = this.getState();
      this.emitState(state);
      return state;
    });
  }

  public getState(): KubernetesState {
    const state = copyState(this.session.getState(), this.namespaceScope, this.kubeconfigReloadAvailable);
    return this.localError
      ? { ...state, connection: 'disconnected', error: this.localError }
      : state;
  }

  public async selectContext(name: string): Promise<KubernetesState> {
    const contextName = assertText(name, 'Context name');
    this.assertUsable();
    const transition = this.beginContextTransition(false);
    return this.enqueueLifecycle(async () => {
      try {
        await this.deactivateInvalidatedQuery(transition.query, transition.coordinator);
        const state = await this.session.selectContext(contextName);
        await this.persistSelectedContext(state);
        const safeState = copyState(state, this.namespaceScope, this.kubeconfigReloadAvailable);
        this.emitState(safeState);
        return safeState;
      } finally {
        this.finishContextTransition(transition.generation);
      }
    });
  }

  public async reloadKubeconfig(): Promise<KubernetesState> {
    this.assertUsable();
    const transition = this.beginContextTransition(true);
    return this.enqueueLifecycle(async () => {
      try {
        await this.deactivateInvalidatedQuery(transition.query, transition.coordinator);
        const catalog = await this.readKubeconfigCatalog();
        this.activeCatalog = catalog;
        await this.session.setContexts(catalog.contexts, { reconnectActiveContext: true });
        const selectedAfterReload = this.session.getState().selectedContext;
        if (!selectedAfterReload || !catalog.contexts.find((context) => (
          context.name === selectedAfterReload && context.supported
        ))) {
          await this.clearContextPreference();
        }
        this.kubeconfigReloadAvailable = false;
        this.localError = undefined;
        this.finishContextTransition(transition.generation);
        if (this.session.getState().connection === 'connected') {
          await this.restoreCurrentListQuery();
        } else if (this.session.getState().connection === 'reconnecting') {
          this.startReconnectMonitor();
        }
        const state = this.getState();
        this.emitState(state);
        return state;
      } finally {
        this.finishContextTransition(transition.generation);
      }
    });
  }

  public async setNamespaceScope(scope: KubernetesNamespaceScope): Promise<KubernetesState> {
    this.assertUsable();
    this.namespaceScope = normalizeNamespaceScope(scope);
    const state = this.getState();
    this.emitState(state);
    return state;
  }

  /**
   * Explicit user recovery for a previously disconnected Context. This never
   * mutates cluster resources and does not recreate an old port forward.
   */
  public reconnect(): Promise<KubernetesState> {
    this.assertUsable();
    if (this.session.getState().connection !== 'disconnected') {
      throw new Error('The Kubernetes Context is not disconnected.');
    }
    return this.enqueueLifecycle(async () => {
      this.assertUsable();
      if (this.session.getState().connection !== 'disconnected') {
        throw new Error('The Kubernetes Context is not disconnected.');
      }
      const state = await this.session.reconnect();
      const safeState = copyState(state, this.namespaceScope, this.kubeconfigReloadAvailable);
      this.emitState(safeState);
      if (state.connection === 'connected') {
        await this.restoreCurrentListQuery();
      } else if (state.connection === 'reconnecting') {
        this.startReconnectMonitor();
      }
      return this.getState();
    });
  }

  public async activateResources(query: RendererKubernetesResourceQuery): Promise<RendererKubernetesListSnapshot> {
    this.assertUsable();
    const validated = this.validateQuery(query);
    this.assertConnectedQuery(validated);
    const generation = this.queryGeneration;
    const key = resourceQueryKey(validated);
    if (this.currentQuery && resourceQueryKey(this.currentQuery) === key) {
      this.currentQuery = copyQuery(validated);
      this.rendererRange = { start: 0, end: DEFAULT_RENDERER_WINDOW_SIZE };
      if (this.currentSnapshot) {
        this.emitList(this.currentSnapshot);
        return this.copyProjectedSnapshot(this.currentSnapshot);
      }
      const pending = this.pendingListActivation;
      if (pending && pending.key === key && pending.generation === generation && pending.coordinator === this.coordinator) {
        const snapshot = await pending.promise;
        return this.copyProjectedSnapshot(snapshot);
      }
    }
    const coordinator = this.ensureCoordinator();
    if (this.currentQuery) {
      await coordinator.deactivate(this.currentQuery);
    }
    if (!this.canUseQuery(validated, generation)) {
      throw new Error('The Kubernetes resource request was invalidated by a Context change.');
    }
    this.currentQuery = copyQuery(validated);
    this.currentSnapshot = undefined;
    this.rendererRange = { start: 0, end: DEFAULT_RENDERER_WINDOW_SIZE };
    const pending: PendingListActivation = {
      key,
      generation,
      coordinator,
      promise: Promise.resolve(undefined as never),
    };
    pending.promise = coordinator.activate(validated).then(async (snapshot) => {
      if (!this.isCurrentQuery(validated, generation) || this.coordinator !== coordinator) {
        await coordinator.deactivate(validated).catch(() => undefined);
        throw new Error('The Kubernetes resource request was invalidated by a Context change.');
      }
      this.currentSnapshot = snapshot;
      this.emitList(snapshot);
      return snapshot;
    }).catch((error) => {
      this.onOperationFailure(error);
      throw error;
    }).finally(() => {
      if (this.pendingListActivation === pending) {
        this.pendingListActivation = undefined;
      }
    });
    this.pendingListActivation = pending;
    const snapshot = await pending.promise;
    return this.copyProjectedSnapshot(snapshot);
  }

  public listResources(query: RendererKubernetesResourceQuery): Promise<RendererKubernetesListSnapshot> {
    return this.activateResources(query);
  }

  /**
   * Returns only the renderer's active virtual range. The complete loaded
   * collection remains in ResourceCoordinator and never crosses IPC.
   */
  public async getResourceWindow(
    query: RendererKubernetesResourceQuery,
    range: KubernetesResourceWindowRange
  ): Promise<RendererKubernetesListSnapshot> {
    this.assertUsable();
    const validated = this.validateQuery(query);
    this.assertConnectedQuery(validated);
    const normalized = normalizedWindowRange(range);
    if (!this.currentQuery || resourceQueryKey(this.currentQuery) !== resourceQueryKey(validated) || !this.currentSnapshot) {
      throw new Error('The requested Kubernetes resource list is not active.');
    }
    this.currentQuery = copyQuery(validated);
    this.rendererRange = normalized;
    return this.copyProjectedSnapshot(this.currentSnapshot);
  }

  public async loadMoreResources(query: RendererKubernetesResourceQuery): Promise<RendererKubernetesListSnapshot> {
    this.assertUsable();
    const validated = this.validateQuery(query);
    this.assertConnectedQuery(validated);
    const generation = this.queryGeneration;
    if (!this.currentQuery || resourceQueryKey(this.currentQuery) !== resourceQueryKey(validated)) {
      throw new Error('The requested Kubernetes resource list is not active.');
    }
    const coordinator = this.ensureCoordinator();
    try {
      const snapshot = await coordinator.loadNextPage(validated);
      if (!this.isCurrentQuery(validated, generation) || this.coordinator !== coordinator) {
        throw new Error('The Kubernetes resource request was invalidated by a Context change.');
      }
      this.currentSnapshot = snapshot;
      this.emitList(snapshot);
      return this.copyProjectedSnapshot(snapshot);
    } catch (error) {
      this.onOperationFailure(error);
      throw error;
    }
  }

  public async getResourceDetail(
    query: RendererKubernetesResourceQuery,
    name: string,
    namespace?: string
  ): Promise<Record<string, unknown>> {
    this.assertUsable();
    const validated = this.validateQuery(query);
    this.assertConnectedQuery(validated);
    const resourceName = assertText(name, 'resource name');
    const targetNamespace = namespace === undefined ? undefined : assertText(namespace, 'Namespace');
    try {
      return await this.ensureCoordinator().getDetail(validated, resourceName, targetNamespace);
    } catch (error) {
      this.onOperationFailure(error);
      throw error;
    }
  }

  public async getResourceEvents(uid: string, namespace?: string): Promise<KubernetesResourceSummary[]> {
    this.assertUsable();
    this.assertConnected();
    const resourceUid = assertText(uid, 'resource UID');
    const targetNamespace = namespace === undefined ? undefined : assertText(namespace, 'Namespace');
    try {
      const events = await this.ensureCoordinator().getEvents({ uid: resourceUid, namespace: targetNamespace });
      return events.map(copySummary);
    } catch (error) {
      this.onOperationFailure(error);
      throw error;
    }
  }

  /** CRDs are discovered only while the Custom Resources view asks for them. */
  public async listCustomResourceDefinitions(): Promise<KubernetesCustomResourceDefinition[]> {
    this.assertUsable();
    this.assertConnected();
    const context = this.session.getState().selectedContext;
    if (!context) {
      throw new Error('No active Kubernetes Context is connected.');
    }
    try {
      const definitions = await this.customResourceDefinitionsCache.getOrCreate(
        `crd:${context}`,
        () => this.observedClient().listCustomResourceDefinitions()
      );
      return definitions.map((definition) => ({ ...definition }));
    } catch (error) {
      this.onOperationFailure(error);
      throw error;
    }
  }

  public async getRelatedResources(
    request: KubernetesRelatedResourceRequest
  ): Promise<KubernetesRelatedResources> {
    this.assertUsable();
    this.assertConnected();
    const validated = this.validateRelatedResourceRequest(request);
    const context = this.session.getState().selectedContext;
    if (!context) {
      throw new Error('No active Kubernetes Context is connected.');
    }
    const key = `related:${JSON.stringify({ context, ...validated })}`;
    try {
      const resources = await this.relatedResourcesCache.getOrCreate(
        key,
        () => this.observedClient().getRelatedResources(validated)
      );
      return copyRelatedResources(resources);
    } catch (error) {
      // Authorization failures remain detail-local. Only a transport failure
      // starts the existing connection-loss cleanup path.
      this.onOperationFailure(error);
      throw error;
    }
  }

  public async openLogs(input: KubernetesPodTarget): Promise<KubernetesLogState> {
    const target = this.validatePodTarget(input);
    this.assertConnected();
    try {
      const state = await this.ensureInteractions().openLogs(target);
      this.emitLog(state);
      return copyLogState(state);
    } catch (error) {
      this.onOperationFailure(error);
      throw error;
    }
  }

  public async loadOlderLogs(id: string): Promise<KubernetesLogState> {
    const sessionId = assertText(id, 'log session ID');
    const state = await this.ensureInteractions().loadOlderLogs(sessionId);
    this.emitLog(state);
    return copyLogState(state);
  }

  public async setLogFollowing(id: string, following: boolean): Promise<KubernetesLogState> {
    const sessionId = assertText(id, 'log session ID');
    if (typeof following !== 'boolean') {
      throw new Error('Kubernetes log following must be true or false.');
    }
    const state = await this.ensureInteractions().setLogFollowing(sessionId, following);
    this.emitLog(state);
    return copyLogState(state);
  }

  public async clearLogs(id: string): Promise<KubernetesLogState> {
    const sessionId = assertText(id, 'log session ID');
    const state = this.ensureInteractions().clearLogs(sessionId);
    this.emitLog(state);
    return copyLogState(state);
  }

  public async closeLogs(id: string): Promise<void> {
    await this.ensureInteractions().closeLogs(assertText(id, 'log session ID'));
  }

  public async openTerminal(input: KubernetesPodTarget): Promise<KubernetesTerminalState> {
    const target = this.validatePodTarget(input);
    this.assertConnected();
    try {
      const state = await this.ensureInteractions().openTerminal(target);
      // A synchronous exec close/error can finalize and publish the terminal
      // through the interaction subscription before openTerminal resolves.
      // Do not publish that terminal final state a second time here.
      if (state.state !== 'closed' && state.state !== 'error') {
        this.emitTerminal(state);
      }
      return copyTerminalState(state);
    } catch (error) {
      this.onOperationFailure(error);
      throw error;
    }
  }

  public async writeTerminal(id: string, data: string): Promise<void> {
    const terminalId = assertText(id, 'terminal ID');
    if (typeof data !== 'string' || data.length > MAX_TERMINAL_INPUT_LENGTH) {
      throw new Error('Kubernetes terminal input must be text within the allowed size.');
    }
    this.ensureInteractions().writeTerminal(terminalId, data);
  }

  public async resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
    const terminalId = assertText(id, 'terminal ID');
    if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
      throw new Error('Kubernetes terminal dimensions must be positive integers.');
    }
    this.ensureInteractions().resizeTerminal(terminalId, cols, rows);
  }

  public async closeTerminal(id: string): Promise<void> {
    await this.ensureInteractions().closeTerminal(assertText(id, 'terminal ID'));
  }

  public async startPortForward(input: KubernetesPortForwardInput): Promise<KubernetesPortForwardState> {
    const validated = this.validatePortForward(input);
    this.assertConnected();
    try {
      const state = await this.ensureInteractions().startPortForward(validated);
      this.emitPortForward(state);
      return copyPortForwardState(state);
    } catch (error) {
      this.onOperationFailure(error);
      throw error;
    }
  }

  public async stopPortForward(id: string): Promise<void> {
    const forwardId = assertText(id, 'port forward ID');
    const existing = this.ensureInteractions().listPortForwards().find((forward) => forward.id === forwardId);
    await this.ensureInteractions().stopPortForward(forwardId);
    if (existing) {
      this.emitPortForward({ ...existing, state: 'stopped' });
    }
  }

  public async listPortForwards(): Promise<KubernetesPortForwardState[]> {
    return this.ensureInteractions().listPortForwards().map(copyPortForwardState);
  }

  /** Leaving the tab retains selected Context and explicit port forwards. */
  public async deactivatePage(): Promise<void> {
    const transition = this.beginContextTransition(false);
    return this.enqueueLifecycle(async () => {
      if (this.disposed) {
        this.finishContextTransition(transition.generation);
        return;
      }
      this.detachInteractionSubscriptions();
      try {
        await Promise.all([
          transition.coordinator?.deactivate(),
          this.interactions?.disposePageScoped(),
        ]);
      } finally {
        this.finishContextTransition(transition.generation);
      }
    });
  }

  /** Invoked by main shutdown; it is idempotent and releases every owned stream. */
  public shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      const transition = this.beginContextTransition(false);
      this.shutdownPromise = this.enqueueLifecycle(async () => {
        if (this.disposed) {
          return;
        }
        this.disposed = true;
        this.stopWatchingKubeconfig?.();
        this.stopWatchingKubeconfig = undefined;
        const failures: unknown[] = [];
        try {
          await this.deactivateInvalidatedQuery(transition.query, transition.coordinator);
        } catch (error) {
          failures.push(error);
        }
        const disconnectFailure = await this.disconnectAfterResourceCleanup('');
        if (disconnectFailure) {
          failures.push(disconnectFailure);
        }
        try {
          this.emitState();
          throwCleanupFailures(failures, 'Kubernetes shutdown cleanup failed.');
        } finally {
          this.finishContextTransition(transition.generation);
        }
      });
    }
    return this.shutdownPromise;
  }

  /**
   * Converts a failed API operation into a safe disconnected state. Only the
   * transient category starts ClusterSession's bounded reconnect policy.
   */
  public handleConnectionLoss(error: unknown): Promise<void> {
    const kind = classifyKubernetesConnectionError(error);
    const transition = this.beginContextTransition(true);
    return this.enqueueLifecycle(async () => {
      if (this.disposed) {
        return;
      }
      try {
        const failures: unknown[] = [];
        try {
          await this.deactivateInvalidatedQuery(transition.query, transition.coordinator);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
        const disconnectFailure = await this.disconnectAfterResourceCleanup('The Kubernetes API connection was lost.');
        if (disconnectFailure) {
          failures.push(disconnectFailure);
        }
        this.emitState();
        if (kind !== 'transient') {
          throwCleanupFailures(failures, 'Kubernetes connection cleanup failed.');
          return;
        }
        const state = await this.session.reconnect();
        this.emitState(copyState(state, this.namespaceScope, this.kubeconfigReloadAvailable));
        this.finishContextTransition(transition.generation);
        if (state.connection === 'connected') {
          await this.restoreCurrentListQuery();
        } else {
          this.startReconnectMonitor();
        }
        throwCleanupFailures(failures, 'Kubernetes connection cleanup failed.');
      } finally {
        this.finishContextTransition(transition.generation);
      }
    });
  }

  public onStateChanged(listener: StateListener): () => void {
    return this.addListener(this.stateListeners, listener);
  }

  public onListChanged(listener: ListListener): () => void {
    return this.addListener(this.listListeners, listener);
  }

  public onLogChanged(listener: LogListener): () => void {
    return this.addListener(this.logListeners, listener);
  }

  public onTerminalChanged(listener: TerminalListener): () => void {
    return this.addListener(this.terminalListeners, listener);
  }

  public onTerminalOutput(listener: TerminalOutputListener): () => void {
    return this.addListener(this.terminalOutputListeners, listener);
  }

  public onPortForwardChanged(listener: PortForwardListener): () => void {
    return this.addListener(this.portForwardListeners, listener);
  }

  private async restoreContextPreference(contexts: KubernetesState['contexts']): Promise<void> {
    if (!this.contextPreference || this.session.getState().selectedContext) {
      return;
    }
    const preferred = await this.contextPreference.load();
    if (!preferred) {
      return;
    }
    const context = contexts.find((candidate) => candidate.name === preferred);
    if (!context || !context.supported) {
      await this.clearContextPreference();
      return;
    }
    const state = await this.session.selectContext(preferred);
    // A failed connection remains visible in ClusterSession state. It is not a
    // successful selection and must not overwrite the remembered preference.
    if (state.connection === 'connected' && state.selectedContext === preferred) {
      await this.persistSelectedContext(state);
    }
  }

  private async persistSelectedContext(state: KubernetesState): Promise<void> {
    if (!this.contextPreference || !state.selectedContext || state.connection !== 'connected') {
      return;
    }
    try {
      await this.contextPreference.save(state.selectedContext);
    } catch {
      // Context selection must not fail after the cluster connection has
      // succeeded merely because a non-sensitive UI preference could not save.
    }
  }

  private async clearContextPreference(): Promise<void> {
    if (!this.contextPreference) {
      return;
    }
    try {
      await this.contextPreference.clear();
    } catch {
      // A stale name is harmless and must not prevent kubeconfig reload.
    }
  }

  private ensureCoordinator(): KubernetesCoordinator {
    if (!this.coordinator) {
      this.coordinator = this.createCoordinator(() => this.observedClient());
    }
    return this.coordinator;
  }

  private ensureInteractions(): KubernetesInteractions {
    if (!this.interactions) {
      this.interactions = this.createInteractions(() => this.observedClient());
    }
    this.attachInteractionSubscriptions(this.interactions);
    return this.interactions;
  }

  private attachInteractionSubscriptions(interactions: KubernetesInteractions): void {
    if (this.interactionSubscriptions.length > 0) {
      return;
    }
    this.interactionSubscriptions = [
      interactions.onLogChanged((state) => {
        if (!this.disposed && this.interactions === interactions) {
          this.emitLog(state);
        }
      }),
      interactions.onTerminalChanged((state) => {
        if (!this.disposed && this.interactions === interactions) {
          this.emitTerminal(state);
        }
      }),
      interactions.onTerminalOutput((output) => {
        if (!this.disposed && this.interactions === interactions) {
          this.emitTerminalOutput(output);
        }
      }),
    ];
  }

  private detachInteractionSubscriptions(): void {
    const subscriptions = this.interactionSubscriptions;
    this.interactionSubscriptions = [];
    for (const unsubscribe of subscriptions) {
      unsubscribe();
    }
  }

  private observedClient(): KubernetesClient {
    const client = this.session.getClient();
    return {
      list: (query, continueToken) => client.list(query, continueToken),
      get: (query, name, namespace) => client.get(query, name, namespace),
      listEvents: (reference) => client.listEvents(reference),
      listCustomResourceDefinitions: () => client.listCustomResourceDefinitions(),
      getRelatedResources: (request) => client.getRelatedResources(request),
      watch: (query, resourceVersion, onEvent) => {
        const generation = this.queryGeneration;
        return client.watch(query, resourceVersion, (event) => {
          onEvent(event);
          this.queueWatchListBroadcast(query, generation);
        });
      },
      openPodLog: (input, callbacks) => client.openPodLog(input, callbacks),
      openPodExec: (input, callbacks) => client.openPodExec(input, callbacks),
      openPortForward: (input) => client.openPortForward(input),
      close: () => client.close(),
    };
  }

  private async disposeContextResources(): Promise<void> {
    const coordinator = this.coordinator;
    const interactions = this.interactions;
    this.detachInteractionSubscriptions();
    this.coordinator = undefined;
    this.interactions = undefined;
    this.relatedResourcesCache.clear();
    this.customResourceDefinitionsCache.clear();
    const forwards = interactions?.listPortForwards() ?? [];
    const results = await Promise.allSettled([
      interactions?.disposeAll(),
      coordinator?.dispose(),
    ]);
    for (const forward of forwards) {
      this.emitPortForward({ ...forward, state: 'stopped' });
    }
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    throwCleanupFailures(failures, 'Kubernetes Context resource cleanup failed.');
  }

  /** Coalesce a Watch burst into one bounded renderer projection/IPC update. */
  private queueWatchListBroadcast(query: KubernetesResourceQuery, generation: number): void {
    const key = resourceQueryKey(query);
    if (this.pendingListBroadcasts.has(key)) {
      return;
    }
    const pending: PendingListBroadcast = { query: copyQuery(query), generation };
    this.pendingListBroadcasts.set(key, pending);
    queueMicrotask(() => {
      if (this.pendingListBroadcasts.get(key) !== pending) {
        return;
      }
      this.pendingListBroadcasts.delete(key);
      if (this.currentSnapshot && this.isCurrentQuery(pending.query, pending.generation)) {
        this.emitList(this.currentSnapshot);
      }
    });
  }

  private async restoreCurrentListQuery(): Promise<void> {
    const query = this.restoreQuery;
    const selectedContext = this.session.getState().selectedContext;
    if (!query || this.session.getState().connection !== 'connected' || selectedContext !== query.context) {
      return;
    }
    const generation = this.queryGeneration;
    const coordinator = this.ensureCoordinator();
    this.currentQuery = copyQuery(query);
    this.currentSnapshot = undefined;
    this.restoreQuery = undefined;
    const snapshot = await coordinator.activate(query);
    if (!this.isCurrentQuery(query, generation) || this.coordinator !== coordinator) {
      await coordinator.deactivate(query).catch(() => undefined);
      return;
    }
    this.currentSnapshot = snapshot;
    this.emitList(snapshot);
  }

  private startReconnectMonitor(): void {
    if (this.reconnectMonitor) {
      return;
    }
    const monitor = (async () => {
      let lastConnection: KubernetesState['connection'] | undefined;
      while (!this.disposed) {
        const state = this.getState();
        if (state.connection !== lastConnection) {
          lastConnection = state.connection;
          this.emitState(state);
        }
        if (state.connection === 'connected') {
          await this.restoreCurrentListQuery();
          return;
        }
        if (state.connection === 'disconnected' || state.connection === 'unsupported-auth') {
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    })();
    this.reconnectMonitor = monitor;
    void monitor.finally(() => {
      if (this.reconnectMonitor === monitor) {
        this.reconnectMonitor = undefined;
      }
    });
  }

  private onOperationFailure(error: unknown): void {
    if (classifyKubernetesConnectionError(error) === 'transient') {
      void this.handleConnectionLoss(error).catch(() => {
        this.reportConnectionLossCleanupFailure();
      });
    }
  }

  private handleWatchError(event: KubernetesWatchEvent): void {
    // ResourceCoordinator has already stopped the Watch and put a safe,
    // resource-local No permission message on the current snapshot. Do not
    // turn an RBAC denial into a whole-Context reconnect.
    if (event.statusCode === 401 || event.statusCode === 403) {
      return;
    }
    const error = event.error ?? Object.assign(
      new Error('The Kubernetes resource Watch stopped.'),
      event.statusCode === undefined ? {} : { statusCode: event.statusCode }
    );
    this.onOperationFailure(error);
  }

  /**
   * Keep the renderer state/retry path independent from diagnostic reporting.
   * The original cleanup error can include transport details, so only a fixed
   * message and fixed safe context cross into the app-level runtime logger.
   */
  private reportConnectionLossCleanupFailure(): void {
    try {
      this.onDiagnostic?.(
        'kubernetes:connection-loss',
        new Error('Kubernetes connection recovery cleanup failed.'),
        { operation: 'connection-loss-cleanup' }
      );
    } catch {
      // Diagnostics are best effort and must not interrupt reconnect handling.
    }
  }

  /**
   * Invalidates every renderer-visible list result before an asynchronous
   * Context mutation can begin. The old coordinator is retained only long
   * enough to abort its Watch; no later LIST result may publish after this.
   */
  private beginContextTransition(preserveQueryForRestore: boolean): {
    generation: number;
    query?: KubernetesResourceQuery;
    coordinator?: KubernetesCoordinator;
  } {
    const query = this.currentQuery ? copyQuery(this.currentQuery) : undefined;
    const selectedContext = this.session.getState().selectedContext;
    this.queryGeneration += 1;
    this.pendingListBroadcasts.clear();
    this.contextTransitionGeneration = this.queryGeneration;
    this.currentQuery = undefined;
    this.currentSnapshot = undefined;
    this.restoreQuery = preserveQueryForRestore && query && query.context === selectedContext
      ? query
      : undefined;
    return {
      generation: this.queryGeneration,
      ...(query ? { query } : {}),
      ...(this.coordinator ? { coordinator: this.coordinator } : {}),
    };
  }

  private finishContextTransition(generation: number): void {
    if (this.contextTransitionGeneration === generation) {
      this.contextTransitionGeneration = undefined;
    }
  }

  private async deactivateInvalidatedQuery(
    query: KubernetesResourceQuery | undefined,
    coordinator: KubernetesCoordinator | undefined
  ): Promise<void> {
    if (query) {
      await coordinator?.deactivate(query);
    }
  }

  /**
   * A failing stream/Watch cleanup must never skip ClusterSession.disconnect:
   * it owns the client close that releases HTTP/WebSocket transports.
   */
  private async disconnectAfterResourceCleanup(reason: string): Promise<Error | undefined> {
    const failures: unknown[] = [];
    try {
      await this.disposeContextResources();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.session.disconnect(reason);
    } catch (error) {
      failures.push(error);
    }
    return cleanupFailureError(failures, 'Kubernetes disconnect cleanup failed.');
  }

  private canUseQuery(query: KubernetesResourceQuery, generation: number): boolean {
    const state = this.session.getState();
    return !this.disposed
      && this.contextTransitionGeneration === undefined
      && this.queryGeneration === generation
      && state.connection === 'connected'
      && state.selectedContext === query.context;
  }

  private isCurrentQuery(query: KubernetesResourceQuery, generation: number): boolean {
    return this.canUseQuery(query, generation)
      && Boolean(this.currentQuery && resourceQueryKey(this.currentQuery) === resourceQueryKey(query));
  }

  private validateQuery(value: RendererKubernetesResourceQuery): KubernetesResourceQuery {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('A Kubernetes resource query is required.');
    }
    const query = value as RendererKubernetesResourceQuery;
    const context = assertText(query.context, 'Context name');
    if (!RESOURCE_KINDS.has(query.kind)) {
      throw new Error('The Kubernetes resource kind is not supported.');
    }
    const namespaceScope = normalizeNamespaceScope(query.namespaceScope);
    if (query.scope !== undefined && query.scope !== 'namespaced' && query.scope !== 'cluster') {
      throw new Error('Kubernetes resource scope must be namespaced or cluster.');
    }
    const result: KubernetesResourceQuery = {
      context,
      kind: query.kind,
      namespaceScope,
      ...(query.scope ? { scope: query.scope } : {}),
      ...(optionalText(query.labelSelector, 'label selector') ? { labelSelector: optionalText(query.labelSelector, 'label selector') } : {}),
      ...(optionalText(query.fieldSelector, 'field selector') ? { fieldSelector: optionalText(query.fieldSelector, 'field selector') } : {}),
      ...(optionalText(query.nameFilter, 'name filter') ? { nameFilter: optionalText(query.nameFilter, 'name filter') } : {}),
    };
    if (query.sort !== undefined) {
      if (!query.sort || typeof query.sort !== 'object' || Array.isArray(query.sort)) {
        throw new Error('Kubernetes resource sort is invalid.');
      }
      const column = assertText(query.sort.column, 'sort column');
      if (query.sort.direction !== 'asc' && query.sort.direction !== 'desc') {
        throw new Error('Kubernetes sort direction must be asc or desc.');
      }
      result.sort = { column, direction: query.sort.direction };
    }
    if (query.kind === 'custom-resources') {
      const apiVersion = assertText(query.apiVersion, 'custom resource API version');
      const plural = assertText(query.plural, 'custom resource plural');
      const [group, version, ...extra] = apiVersion.split('/');
      if (!group || !version || extra.length > 0 || !CUSTOM_RESOURCE_PART.test(group) || !CUSTOM_RESOURCE_VERSION.test(version)) {
        throw new Error('Kubernetes custom resource API version must use a valid group/version.');
      }
      if (!CUSTOM_RESOURCE_PART.test(plural)) {
        throw new Error('Kubernetes custom resource plural is invalid.');
      }
      result.apiVersion = apiVersion;
      result.plural = plural;
    }
    return result;
  }

  private validatePodTarget(value: KubernetesPodTarget): KubernetesPodInteractionTarget {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('A Kubernetes Pod target is required.');
    }
    return {
      namespace: assertText(value.namespace, 'Namespace'),
      podName: assertText(value.podName, 'Pod name'),
      container: assertText(value.container, 'container'),
    };
  }

  private validatePortForward(value: KubernetesPortForwardInput): RuntimePortForwardInput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('A Kubernetes port forward is required.');
    }
    if (value.targetKind !== 'pod' && value.targetKind !== 'service') {
      throw new Error('Kubernetes port forward target must be a Pod or Service.');
    }
    return {
      targetKind: value.targetKind,
      namespace: assertText(value.namespace, 'Namespace'),
      targetName: assertText(value.targetName, 'port forward target name'),
      remotePort: assertPort(value.remotePort, 'remote'),
      ...(value.localPort === undefined ? {} : { localPort: assertPort(value.localPort, 'local', true) }),
    };
  }

  private validateRelatedResourceRequest(
    value: KubernetesRelatedResourceRequest
  ): KubernetesRelatedResourceRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('A Kubernetes related resource request is required.');
    }
    if (value.kind !== 'service' && value.kind !== 'deployment' && value.kind !== 'statefulset') {
      throw new Error('Kubernetes related resource kind is invalid.');
    }
    const request: KubernetesRelatedResourceRequest = {
      kind: value.kind,
      namespace: assertText(value.namespace, 'Namespace'),
      name: assertText(value.name, 'resource name'),
    };
    if (value.selector !== undefined) {
      request.selector = assertText(value.selector, 'Workload selector');
    }
    if ((request.kind === 'deployment' || request.kind === 'statefulset') && !request.selector) {
      throw new Error('Kubernetes Workload selector is required.');
    }
    return request;
  }

  private assertConnected(): void {
    if (this.contextTransitionGeneration !== undefined) {
      throw new Error('A Kubernetes Context change is in progress.');
    }
    if (this.session.getState().connection !== 'connected') {
      throw new Error('No active Kubernetes Context is connected.');
    }
  }

  private assertConnectedQuery(query: KubernetesResourceQuery): void {
    this.assertConnected();
    const selectedContext = this.session.getState().selectedContext;
    if (!selectedContext || selectedContext !== query.context) {
      throw new Error('The Kubernetes resource query must use the selected Context.');
    }
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error('The Kubernetes runtime is shut down.');
    }
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(operation, operation);
    this.lifecycle = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private addListener<T>(listeners: Set<(value: T) => void>, listener: (value: T) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  private emitState(state = this.getState()): void {
    for (const listener of this.stateListeners) {
      listener(copyState(state, this.namespaceScope, this.kubeconfigReloadAvailable));
    }
  }

  private emitList(snapshot: KubernetesListSnapshot): void {
    const visibleSnapshot = this.projectSnapshotForCurrentView(snapshot);
    for (const listener of this.listListeners) {
      listener(visibleSnapshot);
    }
  }

  private copyProjectedSnapshot(snapshot: KubernetesListSnapshot): RendererKubernetesListSnapshot {
    return this.projectSnapshotForCurrentView(snapshot);
  }

  private projectSnapshotForCurrentView(snapshot: KubernetesListSnapshot): RendererKubernetesListSnapshot {
    const viewQuery = this.currentQuery
      && resourceQueryKey(this.currentQuery) === resourceQueryKey(snapshot.query)
      ? this.currentQuery
      : snapshot.query;
    return projectSnapshotWindow(snapshot, viewQuery, this.rendererRange);
  }

  private emitLog(state: KubernetesLogState): void {
    for (const listener of this.logListeners) {
      listener(copyLogState(state));
    }
  }

  private emitTerminal(state: KubernetesTerminalState): void {
    for (const listener of this.terminalListeners) {
      listener(copyTerminalState(state));
    }
  }

  private emitTerminalOutput(output: KubernetesTerminalOutput): void {
    if (
      typeof output.id !== 'string'
      || output.id.length === 0
      || output.id.length > MAX_RENDERER_TEXT_LENGTH
      || typeof output.data !== 'string'
      || output.data.length === 0
      || output.data.length > MAX_RENDERER_TEXT_LENGTH
    ) {
      return;
    }
    for (const listener of this.terminalOutputListeners) {
      listener(copyTerminalOutput(output));
    }
  }

  private emitPortForward(state: KubernetesPortForwardState): void {
    for (const listener of this.portForwardListeners) {
      listener(copyPortForwardState(state));
    }
  }

  private watchLocalKubeconfigDirectory(listener: () => void): () => void {
    try {
      // Directory-level watching covers creation, deletion, rename, content
      // updates, and atomic replacement without trusting platform-specific
      // event filenames.
      const watcher = watchPath(this.kubeconfigDirectory, { persistent: false }, () => listener());
      // File-descriptor exhaustion or a platform watcher error must not become
      // an uncaught main-process exception. The next app launch/reload can
      // attach a watcher again, while the explicit Reload action remains safe.
      watcher.on('error', () => undefined);
      return () => watcher.close();
    } catch {
      // A missing directory remains an empty renderer state from init; the next
      // app launch can attach a watcher after the directory is created.
      return () => undefined;
    }
  }
}
