import type { KubernetesContextInfo, KubernetesState } from '../../shared/types';
import type { KubernetesClient } from './kubernetesClient';

export const DEFAULT_KUBERNETES_RETRY_DELAYS_MS = [200, 500, 1_000, 2_000, 5_000] as const;

export type KubernetesConnectionErrorKind = 'transient' | 'authentication' | 'tls' | 'other';

export interface ClusterSessionOptions {
  createClient: (context: string) => Promise<KubernetesClient>;
  disposeOwnedResources: () => Promise<void>;
  retryDelaysMs?: number[];
}

export interface KubernetesContextCatalogOptions {
  /** Recreate an already-connected selected Context after credential reload. */
  reconnectActiveContext?: boolean;
}

interface ConnectionErrorLike {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  message?: unknown;
  response?: unknown;
  cause?: unknown;
}

const TRANSIENT_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function errorRecord(value: unknown): ConnectionErrorLike | undefined {
  return value && typeof value === 'object' ? value as ConnectionErrorLike : undefined;
}

function numericStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function nestedStatus(record: ConnectionErrorLike): number | undefined {
  const direct = numericStatus(record.statusCode) ?? numericStatus(record.status) ?? numericStatus(record.code);
  if (direct !== undefined) {
    return direct;
  }
  const response = errorRecord(record.response);
  return response ? nestedStatus(response) : undefined;
}

/**
 * Classifies only connection outcome categories. The original error is never
 * placed into renderer state because it can include an API URL or credentials.
 */
export function classifyKubernetesConnectionError(error: unknown): KubernetesConnectionErrorKind {
  const record = errorRecord(error);
  if (!record) {
    return 'other';
  }
  const code = typeof record.code === 'string' ? record.code.toUpperCase() : '';
  const message = typeof record.message === 'string' ? record.message : '';
  const status = nestedStatus(record);

  if (status === 401 || status === 403) {
    return 'authentication';
  }
  if (status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599)) {
    return 'transient';
  }
  if (
    TLS_CODES.has(code)
    || code.startsWith('ERR_TLS_')
    || /certificate|self[ -]?signed|unable to verify|tls handshake/i.test(message)
  ) {
    return 'tls';
  }
  if (TRANSIENT_CODES.has(code)) {
    return 'transient';
  }
  const cause = errorRecord(record.cause);
  return cause ? classifyKubernetesConnectionError(cause) : 'other';
}

function copyContext(context: KubernetesContextInfo): KubernetesContextInfo {
  return {
    name: context.name,
    contextName: context.contextName,
    displayName: context.displayName,
    clusterName: context.clusterName,
    userName: context.userName,
    supported: context.supported,
    ...(context.unsupportedReason ? { unsupportedReason: context.unsupportedReason } : {}),
    tlsVerificationDisabled: context.tlsVerificationDisabled,
  };
}

function copyState(state: KubernetesState): KubernetesState {
  return {
    contexts: state.contexts.map(copyContext),
    ...(state.selectedContext ? { selectedContext: state.selectedContext } : {}),
    connection: state.connection,
    ...(state.error ? { error: state.error } : {}),
    kubeconfigReloadAvailable: state.kubeconfigReloadAvailable,
  };
}

function contextsMatch(left: KubernetesContextInfo | undefined, right: KubernetesContextInfo | undefined): boolean {
  return Boolean(left && right
    && left.name === right.name
    && left.clusterName === right.clusterName
    && left.userName === right.userName
    && left.supported === right.supported
    && left.unsupportedReason === right.unsupportedReason
    && left.tlsVerificationDisabled === right.tlsVerificationDisabled);
}

function unsupportedMessage(context: KubernetesContextInfo): string {
  if (context.unsupportedReason === 'exec-auth') {
    return 'This Kubernetes Context uses exec credentials, which are not supported.';
  }
  if (context.unsupportedReason === 'missing-auth') {
    return 'This Kubernetes Context is missing supported credentials.';
  }
  return 'This Kubernetes Context does not use supported token or client-certificate credentials.';
}

function messageForFailure(kind: KubernetesConnectionErrorKind, retrying: boolean): string {
  switch (kind) {
    case 'authentication':
      return 'Kubernetes authentication was rejected for this Context.';
    case 'tls':
      return 'Kubernetes TLS verification failed for this Context.';
    case 'transient':
      return retrying
        ? 'The Kubernetes API is temporarily unavailable. Retrying…'
        : 'The Kubernetes API is temporarily unavailable.';
    default:
      return 'Unable to connect to the Kubernetes API.';
  }
}

/**
 * Owns exactly one active Context. Every mutation runs through one promise
 * chain so Context changes, reconnects, and disposal cannot overlap.
 */
export class ClusterSession {
  private contexts: KubernetesContextInfo[] = [];
  private client?: KubernetesClient;
  private state: KubernetesState = {
    contexts: [],
    connection: 'idle',
    kubeconfigReloadAvailable: false,
  };
  private operation: Promise<void> = Promise.resolve();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryGeneration = 0;

  public constructor(private readonly options: ClusterSessionOptions) {
    const retryDelays = options.retryDelaysMs ?? [...DEFAULT_KUBERNETES_RETRY_DELAYS_MS];
    if (retryDelays.some((delay) => !Number.isFinite(delay) || delay < 0)) {
      throw new Error('Kubernetes retry delays must be non-negative finite numbers.');
    }
    this.retryDelaysMs = [...retryDelays];
  }

  private readonly retryDelaysMs: number[];

  public getState(): KubernetesState {
    return copyState(this.state);
  }

  public setContexts(
    contexts: KubernetesContextInfo[],
    options: KubernetesContextCatalogOptions = {}
  ): Promise<void> {
    const nextContexts = contexts.map(copyContext);
    const generation = this.cancelRetries();
    return this.enqueue(() => this.setContextsNow(nextContexts, generation, options.reconnectActiveContext === true));
  }

  public selectContext(name: string): Promise<KubernetesState> {
    const generation = this.cancelRetries();
    return this.enqueue(() => this.selectContextNow(name, generation));
  }

  public disconnect(reason: string): Promise<void> {
    this.cancelRetries();
    return this.enqueue(async () => {
      let cleanupError: unknown;
      try {
        await this.disposeCurrent();
      } catch (error) {
        cleanupError = error;
      }
      this.state = {
        ...this.state,
        connection: 'disconnected',
        ...(reason ? { error: reason } : {}),
      };
      if (cleanupError !== undefined) {
        throw cleanupError;
      }
    });
  }

  public reconnect(): Promise<KubernetesState> {
    const generation = this.cancelRetries();
    return this.enqueue(async () => {
      const selected = this.state.selectedContext;
      if (!selected) {
        this.state = {
          ...this.state,
          connection: 'disconnected',
          error: 'Select a Kubernetes Context before reconnecting.',
        };
        return this.getState();
      }
      const context = this.contexts.find((candidate) => candidate.name === selected);
      if (!context) {
        this.state = {
          ...this.state,
          connection: 'disconnected',
          error: 'The selected Kubernetes Context is no longer available.',
        };
        return this.getState();
      }
      if (!context.supported) {
        await this.disposeCurrent();
        this.state = {
          ...this.state,
          connection: 'unsupported-auth',
          error: unsupportedMessage(context),
        };
        return this.getState();
      }
      await this.disposeCurrent();
      return this.connect(context, generation, 0, false);
    });
  }

  public getClient(): KubernetesClient {
    if (!this.client || this.state.connection !== 'connected') {
      throw new Error('No active Kubernetes Context is connected.');
    }
    return this.client;
  }

  private async selectContextNow(name: string, generation: number): Promise<KubernetesState> {
    const context = this.contexts.find((candidate) => candidate.name === name);
    if (!context) {
      let cleanupError: unknown;
      try {
        await this.disposeCurrent();
      } catch (error) {
        cleanupError = error;
      }
      this.state = {
        ...this.state,
        selectedContext: undefined,
        connection: 'disconnected',
        error: 'The selected Kubernetes Context is no longer available.',
      };
      if (cleanupError !== undefined) {
        throw cleanupError;
      }
      return this.getState();
    }

    const changingContext = this.state.selectedContext !== context.name;
    if (changingContext && this.state.selectedContext) {
      await this.disposeCurrent();
    }
    this.state = {
      ...this.state,
      selectedContext: context.name,
      ...(context.supported ? {} : { connection: 'unsupported-auth' as const }),
      ...(context.supported ? {} : { error: unsupportedMessage(context) }),
    };

    if (!context.supported) {
      if (this.client) {
        await this.disposeCurrent();
      }
      return this.getState();
    }
    if (this.client && !changingContext) {
      return this.getState();
    }
    return this.connect(context, generation, 0, false);
  }

  private async connect(
    context: KubernetesContextInfo,
    generation: number,
    retryAttempt: number,
    isRetry: boolean
  ): Promise<KubernetesState> {
    if (!this.isCurrentAttempt(context.name, generation)) {
      return this.getState();
    }
    this.state = {
      ...this.state,
      connection: isRetry ? 'reconnecting' : 'connecting',
      error: undefined,
    };

    try {
      const client = await this.options.createClient(context.name);
      if (!this.isCurrentAttempt(context.name, generation)) {
        // The request was invalidated while the client was being created.
        // Leave it owned by the queued invalidating operation so it can run
        // the normal resource-then-client cleanup sequence before publishing
        // the next disconnected state.
        this.client = client;
        return this.getState();
      }
      try {
        await client.probeConnection();
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
      if (!this.isCurrentAttempt(context.name, generation)) {
        this.client = client;
        return this.getState();
      }
      this.client = client;
      this.state = {
        ...this.state,
        connection: 'connected',
        error: undefined,
      };
      return this.getState();
    } catch (error) {
      if (!this.isCurrentAttempt(context.name, generation)) {
        return this.getState();
      }
      const kind = classifyKubernetesConnectionError(error);
      if (kind === 'transient' && retryAttempt < this.retryDelaysMs.length && this.isCurrentAttempt(context.name, generation)) {
        this.state = {
          ...this.state,
          connection: 'reconnecting',
          error: messageForFailure(kind, true),
        };
        this.scheduleRetry(context, generation, retryAttempt);
        return this.getState();
      }
      this.state = {
        ...this.state,
        connection: 'disconnected',
        error: messageForFailure(kind, false),
      };
      return this.getState();
    }
  }

  private scheduleRetry(context: KubernetesContextInfo, generation: number, retryAttempt: number): void {
    const delay = this.retryDelaysMs[retryAttempt];
    if (delay === undefined) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.enqueue(() => this.connect(context, generation, retryAttempt + 1, true));
    }, delay);
    this.retryTimer.unref?.();
  }

  private async disposeCurrent(): Promise<void> {
    const current = this.client;
    try {
      await this.options.disposeOwnedResources();
    } finally {
      this.client = undefined;
      if (current) {
        await current.close();
      }
    }
  }

  private async setContextsNow(
    contexts: KubernetesContextInfo[],
    generation: number,
    reconnectActiveContext: boolean
  ): Promise<void> {
    const selectedContext = this.state.selectedContext;
    const previousContext = selectedContext
      ? this.contexts.find((context) => context.name === selectedContext)
      : undefined;
    const nextSelectedContext = selectedContext
      ? contexts.find((context) => context.name === selectedContext)
      : undefined;
    const reconnectSelectedContext = Boolean(
      reconnectActiveContext
      && selectedContext
      && nextSelectedContext?.supported
      && this.client
      && this.state.connection === 'connected'
    );
    const mustDispose = Boolean(selectedContext && (
      !contextsMatch(previousContext, nextSelectedContext)
      || reconnectSelectedContext
      || this.state.connection === 'connecting'
      || this.state.connection === 'reconnecting'
    ));

    if (mustDispose) {
      try {
        await this.disposeCurrent();
      } catch {
        // A catalog replacement still must detach the stale Context. The
        // resource/client cleanup order is preserved by disposeCurrent().
      }
    }

    this.contexts = contexts.map(copyContext);
    if (!selectedContext) {
      this.state = {
        ...this.state,
        contexts: this.contexts.map(copyContext),
      };
      return;
    }

    if (!nextSelectedContext) {
      this.state = {
        ...this.state,
        contexts: this.contexts.map(copyContext),
        selectedContext: undefined,
        connection: 'disconnected',
        error: 'The selected Kubernetes Context is no longer available.',
      };
      return;
    }

    if (!nextSelectedContext.supported) {
      this.state = {
        ...this.state,
        contexts: this.contexts.map(copyContext),
        connection: 'unsupported-auth',
        error: unsupportedMessage(nextSelectedContext),
      };
      return;
    }

    if (mustDispose) {
      if (reconnectSelectedContext) {
        this.state = {
          ...this.state,
          contexts: this.contexts.map(copyContext),
          connection: 'disconnected',
          error: undefined,
        };
        await this.connect(nextSelectedContext, generation, 0, false);
        return;
      }
      this.state = {
        ...this.state,
        contexts: this.contexts.map(copyContext),
        connection: 'disconnected',
        error: 'The selected Kubernetes Context changed. Reconnect to continue.',
      };
      return;
    }

    this.state = {
      ...this.state,
      contexts: this.contexts.map(copyContext),
    };
  }

  private cancelRetries(): number {
    this.retryGeneration += 1;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    return this.retryGeneration;
  }

  private isCurrentAttempt(context: string, generation: number): boolean {
    return generation === this.retryGeneration && this.state.selectedContext === context;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation);
    this.operation = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}
