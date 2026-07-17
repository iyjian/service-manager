import { createRequire } from 'node:module';
import net from 'node:net';

const KUBEVIRT_API_VERSION = 'kubevirt.io/v1';
const KUBEVIRT_VNC_PROTOCOL = 'plain.kubevirt.io';
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const MAX_STARTUP_TIMEOUT_MS = 120_000;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_EARLY_VNC_BYTES = 1024 * 1024;

interface UnknownRecord {
  [key: string]: unknown;
}

export interface KubeVirtVncTarget {
  namespace: string;
  podName: string;
  podUid: string;
  vmiName: string;
  vmiUid: string;
}

export interface KubeVirtKubeConfig {
  getCurrentCluster(): { server: string } | null;
  applyToHTTPSOptions(options: Record<string, unknown>): Promise<void>;
}

export interface KubeVirtWebSocket {
  readonly protocol: string;
  readonly readyState: number;
  readonly bufferedAmount?: number;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  on(
    event: 'unexpected-response',
    listener: (request: unknown, response: { statusCode?: number; resume?: () => void }) => void
  ): this;
  send(data: Buffer, options: { binary: true }, callback: (error?: Error) => void): void;
  close(): void;
  terminate(): void;
  pause?(): void;
  resume?(): void;
}

export type KubeVirtWebSocketConstructor = new (
  url: string,
  protocol: string,
  options: Record<string, unknown>
) => KubeVirtWebSocket;

export interface KubeVirtVncBridgeOptions {
  kubeConfig: KubeVirtKubeConfig;
  namespace: string;
  vmiName: string;
  /** Bounds both authenticated upstream startup and subsequent viewer launch. */
  startupTimeoutMs?: number;
  /** Cancels an in-flight upstream handshake during Context disposal. */
  signal?: AbortSignal;
  /** Avoids displacing an already connected VNC viewer by default. */
  preserveSession?: boolean;
  onError?: (error: Error) => void;
  /** Main-process-only test seam. */
  createServer?: (listener: (socket: net.Socket) => void) => net.Server;
  /** Main-process-only test seam. */
  createWebSocket?: (
    url: string,
    protocol: string,
    options: Record<string, unknown>
  ) => KubeVirtWebSocket;
}

export interface KubeVirtVncBridgeHandle {
  localPort: number;
  /** Already resolved on return; represents authenticated upstream readiness. */
  connected: Promise<void>;
  /** Resolves after every local listener/socket and WebSocket handle is released. */
  completed: Promise<void>;
  close(): Promise<void>;
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function metadata(value: unknown): UnknownRecord | undefined {
  return record(record(value)?.metadata);
}

/**
 * Recognizes a real running virt-launcher Pod through its controller UID.
 * Name prefixes alone are intentionally insufficient because arbitrary Pods
 * can use the same display name or labels.
 */
export function parseKubeVirtVncTargetFromPod(pod: unknown): KubeVirtVncTarget | undefined {
  const podRecord = record(pod);
  const podMetadata = metadata(pod);
  if (!podRecord || !podMetadata || record(podRecord.status)?.phase !== 'Running') {
    return undefined;
  }

  const podName = nonEmptyText(podMetadata.name);
  const namespace = nonEmptyText(podMetadata.namespace);
  const podUid = nonEmptyText(podMetadata.uid);
  const labels = record(podMetadata.labels);
  const annotations = record(podMetadata.annotations);
  if (!podName || !namespace || !podUid || labels?.['kubevirt.io'] !== 'virt-launcher') {
    return undefined;
  }

  if (podMetadata.deletionTimestamp !== undefined && podMetadata.deletionTimestamp !== null) {
    return undefined;
  }
  const owners = Array.isArray(podMetadata.ownerReferences) ? podMetadata.ownerReferences : [];
  const controllerOwners = owners.map(record).filter((candidate) => candidate?.controller === true);
  if (controllerOwners.length !== 1
    || controllerOwners[0]?.apiVersion !== KUBEVIRT_API_VERSION
    || controllerOwners[0]?.kind !== 'VirtualMachineInstance') {
    return undefined;
  }
  const owner = controllerOwners[0];
  const vmiName = nonEmptyText(owner?.name);
  const vmiUid = nonEmptyText(owner?.uid);
  if (!vmiName || !vmiUid || labels['kubevirt.io/created-by'] !== vmiUid) {
    return undefined;
  }

  const labeledName = labels['vm.kubevirt.io/name'];
  const annotatedName = annotations?.['kubevirt.io/domain'];
  if ((labeledName === undefined && annotatedName === undefined)
    || (labeledName !== undefined && labeledName !== vmiName)
    || (annotatedName !== undefined && annotatedName !== vmiName)) {
    return undefined;
  }

  return { namespace, podName, podUid, vmiName, vmiUid };
}

/** Confirms that a freshly read VMI is the exact owner selected from the Pod. */
export function isMatchingKubeVirtVmi(target: KubeVirtVncTarget, vmi: unknown): boolean {
  const vmiRecord = record(vmi);
  const vmiMetadata = metadata(vmi);
  if (!vmiRecord || !vmiMetadata
    || vmiRecord.apiVersion !== KUBEVIRT_API_VERSION
    || vmiRecord.kind !== 'VirtualMachineInstance'
    || vmiMetadata.name !== target.vmiName
    || vmiMetadata.namespace !== target.namespace
    || vmiMetadata.uid !== target.vmiUid
    || record(vmiRecord.status)?.phase !== 'Running') {
    return false;
  }

  const activePods = record(record(vmiRecord.status)?.activePods);
  const devices = record(record(record(vmiRecord.spec)?.domain)?.devices);
  return devices?.autoattachGraphicsDevice !== false
    && !!activePods
    && Object.prototype.hasOwnProperty.call(activePods, target.podUid);
}

function safePathPart(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 253 || normalized.includes('\0')) {
    throw new Error(`KubeVirt VNC ${label} is invalid.`);
  }
  return encodeURIComponent(normalized);
}

export function buildKubeVirtVncWebSocketPath(
  namespace: string,
  vmiName: string,
  preserveSession = true
): string {
  return `/apis/subresources.kubevirt.io/v1/namespaces/${safePathPart(namespace, 'Namespace')}`
    + `/virtualmachineinstances/${safePathPart(vmiName, 'VMI name')}`
    + `/vnc?preserveSession=${preserveSession ? 'true' : 'false'}`;
}

/**
 * Loads `ws` from the package scope that declares it as a runtime dependency.
 * This avoids relying on pnpm hoisting and does not add a project dependency.
 */
export function loadKubernetesPackageWebSocket(): KubeVirtWebSocketConstructor {
  const kubernetesRequire = createRequire(require.resolve('@kubernetes/client-node/package.json'));
  return kubernetesRequire('ws') as KubeVirtWebSocketConstructor;
}

function buildWebSocketUrl(clusterServer: string, path: string): string {
  let url: URL;
  try {
    url = new URL(clusterServer);
  } catch {
    throw new Error('The Kubernetes API server URL is invalid.');
  }
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else {
    throw new Error('The Kubernetes API server protocol is not supported.');
  }
  const prefix = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  url.pathname = `${prefix}${path.split('?')[0]}`;
  url.search = path.includes('?') ? path.slice(path.indexOf('?')) : '';
  url.hash = '';
  return url.toString();
}

function normalizeWebSocketData(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every(Buffer.isBuffer)) {
    return Buffer.concat(value);
  }
  return undefined;
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function statusError(statusCode: number | undefined): Error {
  if (statusCode === 401 || statusCode === 403) {
    return Object.assign(new Error('No permission to open this KubeVirt VNC console.'), { statusCode });
  }
  return Object.assign(new Error('Unable to open the KubeVirt VNC stream.'), {
    ...(statusCode === undefined ? {} : { statusCode }),
  });
}

function transportError(value: unknown): Error {
  const code = nonEmptyText(record(value)?.code);
  const safeCode = code && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined;
  return Object.assign(new Error('Unable to open the KubeVirt VNC stream.'), {
    ...(safeCode ? { code: safeCode } : {}),
  });
}

/**
 * Opens one loopback-only TCP listener and transparently bridges its first
 * client to an authenticated KubeVirt VNC WebSocket. The returned handle owns
 * every listener/socket/WebSocket and is safe to close repeatedly.
 */
export async function openKubeVirtVncBridge(
  options: KubeVirtVncBridgeOptions
): Promise<KubeVirtVncBridgeHandle> {
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  if (!Number.isFinite(startupTimeoutMs)
    || startupTimeoutMs <= 0
    || startupTimeoutMs > MAX_STARTUP_TIMEOUT_MS) {
    throw new Error(`KubeVirt VNC startup timeout must be between 1 and ${MAX_STARTUP_TIMEOUT_MS} ms.`);
  }

  const cluster = options.kubeConfig.getCurrentCluster();
  if (!cluster || !nonEmptyText(cluster.server)) {
    throw new Error('No Kubernetes cluster is selected.');
  }
  const webSocketOptions: Record<string, unknown> = {};
  try {
    await options.kubeConfig.applyToHTTPSOptions(webSocketOptions);
  } catch (error) {
    throw transportError(error);
  }
  Object.assign(webSocketOptions, {
    followRedirects: false,
    handshakeTimeout: startupTimeoutMs,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });
  const webSocketUrl = buildWebSocketUrl(
    cluster.server,
    buildKubeVirtVncWebSocketPath(
      options.namespace,
      options.vmiName,
      options.preserveSession !== false
    )
  );

  const WebSocketConstructor = options.createWebSocket ? undefined : loadKubernetesPackageWebSocket();
  const createWebSocket = options.createWebSocket
    ?? ((url: string, protocol: string, wsOptions: Record<string, unknown>) => (
      new WebSocketConstructor!(url, protocol, wsOptions)
    ));
  const createServer = options.createServer ?? ((listener) => net.createServer(listener));

  let viewer: net.Socket | undefined;
  let webSocket: KubeVirtWebSocket | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let listenerStopPromise: Promise<void> | undefined;
  let listenStarted = false;
  let listenSettled = false;
  let resolveListenSettled!: () => void;
  const listeningOutcome = new Promise<void>((resolve) => {
    resolveListenSettled = resolve;
  });
  const earlyFrames: Buffer[] = [];
  let earlyFrameBytes = 0;
  let closed = false;
  let connectedSettled = false;
  let failure: Error | undefined;
  let closePromise: Promise<void> | undefined;
  let resolveConnected!: () => void;
  let rejectConnected!: (error: Error) => void;
  let resolveCompleted!: () => void;
  const connected = new Promise<void>((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  // A caller may only need the local endpoint. Keep a later startup failure
  // from becoming an unhandled rejection while retaining the public promise.
  void connected.catch(() => undefined);
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });

  const server = createServer((socket) => {
    if (closed || viewer) {
      socket.destroy();
      return;
    }
    viewer = socket;
    socket.pause();
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }
    socket.on('error', () => fail(new Error('The system VNC viewer connection failed.'), true));
    socket.once('close', () => {
      if (!closed) {
        void close();
      }
    });
    // Stop accepting immediately; this is a deliberately single-viewer proxy.
    listenerStopPromise ??= stopServerWhenReady();

    socket.on('data', (data) => {
      if (closed || !webSocket) return;
      socket.pause();
      try {
        webSocket.send(data, { binary: true }, (error) => {
          if (error) {
            fail(transportError(error), true);
          } else if (!closed) {
            socket.resume();
          }
        });
      } catch (error) {
        fail(transportError(error), true);
      }
    });

    for (const frame of earlyFrames.splice(0)) {
      if (!socket.write(frame)) {
        webSocket?.pause?.();
        socket.once('drain', () => webSocket?.resume?.());
      }
    }
    earlyFrameBytes = 0;
    socket.resume();
  });

  function settleListen(): void {
    if (listenSettled) return;
    listenSettled = true;
    resolveListenSettled();
  }

  async function stopServerWhenReady(): Promise<void> {
    if (listenStarted) {
      await listeningOutcome;
    }
    await closeServer(server);
  }

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }
    options.signal?.removeEventListener('abort', onAbort);
    if (!connectedSettled) {
      connectedSettled = true;
      rejectConnected(new Error('KubeVirt VNC was closed before it connected.'));
    }
    listenerStopPromise ??= stopServerWhenReady();
    viewer?.destroy();
    earlyFrames.length = 0;
    earlyFrameBytes = 0;
    if (webSocket) {
      try {
        webSocket.close();
      } catch {
        // Continue with termination below.
      }
      try {
        webSocket.terminate();
      } catch {
        // WebSocket cleanup is best effort and remains idempotent.
      }
    }
    closePromise = listenerStopPromise.then(() => {
      resolveCompleted();
    });
    return closePromise;
  }

  function fail(error: Error, report: boolean): void {
    if (closed) return;
    failure ??= error;
    if (!connectedSettled) {
      connectedSettled = true;
      rejectConnected(error);
    }
    if (report) {
      try {
        options.onError?.(error);
      } catch {
        // Diagnostic/UI callbacks cannot interrupt transport cleanup.
      }
    }
    void close();
  }

  function onAbort(): void {
    fail(Object.assign(new Error('KubeVirt VNC opening was cancelled.'), { code: 'ABORT_ERR' }), false);
  }

  if (options.signal?.aborted) {
    await close();
    throw Object.assign(new Error('KubeVirt VNC opening was cancelled.'), { code: 'ABORT_ERR' });
  }
  options.signal?.addEventListener('abort', onAbort, { once: true });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      settleListen();
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      settleListen();
      server.on('error', (error) => fail(error, true));
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    listenStarted = true;
    try {
      server.listen({ host: '127.0.0.1', port: 0 });
    } catch (error) {
      server.off('error', onError);
      server.off('listening', onListening);
      settleListen();
      reject(error);
    }
  }).catch(async () => {
    await close();
    throw new Error('Unable to open the local KubeVirt VNC proxy.');
  });

  const address = server.address();
  if (closed) {
    await close();
    throw failure ?? new Error('KubeVirt VNC closed while opening.');
  }
  if (!address || typeof address === 'string') {
    await close();
    throw new Error('KubeVirt VNC did not allocate a local TCP port.');
  }

  startupTimer = setTimeout(() => {
    fail(new Error('Timed out opening the KubeVirt VNC stream.'), true);
  }, startupTimeoutMs);
  startupTimer.unref?.();

  try {
    webSocket = createWebSocket(webSocketUrl, KUBEVIRT_VNC_PROTOCOL, webSocketOptions);
  } catch (error) {
    fail(transportError(error), true);
  }
  webSocket?.on('unexpected-response', (_request, response) => {
    response.resume?.();
    fail(statusError(response.statusCode), true);
  });
  webSocket?.on('error', (error) => fail(transportError(error), true));
  webSocket?.on('close', () => {
    if (!closed) {
      void close();
    }
  });
  webSocket?.on('message', (data, isBinary) => {
    if (closed) return;
    const buffer = isBinary ? normalizeWebSocketData(data) : undefined;
    if (!buffer) {
      fail(new Error('KubeVirt VNC returned an invalid data frame.'), true);
      return;
    }
    if (!viewer || viewer.destroyed) {
      if (earlyFrameBytes + buffer.length > MAX_EARLY_VNC_BYTES) {
        fail(new Error('KubeVirt VNC sent too much data before the viewer connected.'), true);
        return;
      }
      earlyFrames.push(Buffer.from(buffer));
      earlyFrameBytes += buffer.length;
      return;
    }
    if (!viewer.write(buffer)) {
      webSocket?.pause?.();
      viewer.once('drain', () => webSocket?.resume?.());
    }
  });
  webSocket?.on('open', () => {
    if (closed || !webSocket) {
      void close();
      return;
    }
    if (webSocket.protocol !== KUBEVIRT_VNC_PROTOCOL) {
      fail(new Error('KubeVirt VNC negotiated an unsupported protocol.'), true);
      return;
    }
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }
    connectedSettled = true;
    resolveConnected();
  });

  try {
    await connected;
  } catch (error) {
    await close();
    throw error;
  }
  if (closed) {
    await close();
    throw failure ?? new Error('KubeVirt VNC closed while opening.');
  }

  // Once the authenticated upstream is ready, bound how long its initial RFB
  // bytes may remain buffered while the system viewer is being launched.
  startupTimer = setTimeout(() => {
    fail(new Error('Timed out waiting for the system VNC viewer.'), true);
  }, startupTimeoutMs);
  startupTimer.unref?.();

  return {
    localPort: address.port,
    connected,
    completed,
    close,
  };
}
