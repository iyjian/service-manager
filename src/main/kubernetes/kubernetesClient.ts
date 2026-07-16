import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import yaml from 'js-yaml';
import type * as KubernetesNode from '@kubernetes/client-node';
import type {
  KubernetesCustomResourceDefinition,
  KubernetesPodEnvironment,
  KubernetesPodTarget,
  KubernetesRelatedResourceRequest,
  KubernetesRelatedResources,
  KubernetesResourceKind,
} from '../../shared/types';
import { preflightKubeconfigContext } from './kubeconfigStore';
import {
  noPermissionPodEnvironment,
  resolvePodContainerEnvironment,
  safePodEnvironmentReadError,
} from './podEnvironment';
import { mapKubernetesResourceSummary } from './resourceSummary';
import type {
  KubernetesResourcePage,
  KubernetesResourceQuery,
  KubernetesResourceSummary,
} from './resourceQuery';

export interface KubernetesWatchEvent {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';
  object?: KubernetesResourceSummary;
  resourceVersion?: string;
  statusCode?: number;
  /** Main-process-only transport cause; it is never sent to the renderer. */
  error?: unknown;
}

export { mapKubernetesResourceSummary } from './resourceSummary';

export interface KubernetesPodLogRequest {
  namespace: string;
  podName: string;
  container: string;
  tailLines: number;
  follow: boolean;
  /** RFC3339 main-process boundary used for a bounded log snapshot/resume. */
  sinceTime?: string;
}

export interface KubernetesPodLogCallbacks {
  onLine(line: string): void;
}

export interface KubernetesPodLogHandle {
  completed: Promise<void>;
  close(): Promise<void>;
}

/**
 * Main-process-only Deployment membership resolved from a selected Pod's
 * controller chain. The Deployment selector never crosses into the renderer.
 */
export interface KubernetesPodDeploymentLogTargets {
  name: string;
  pods: Array<{ uid: string; podName: string }>;
}

export interface KubernetesPodExecRequest {
  namespace: string;
  podName: string;
  container: string;
  shell: string;
}

export interface KubernetesPodExecCallbacks {
  onData(data: string): void;
  onClose(): void;
  onError(error: Error): void;
  /** A command-status failure after the exec WebSocket has opened. */
  onStatusFailure(error: Error): void;
}

export interface KubernetesPodExecHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): Promise<void>;
}

export interface KubernetesPortForwardRequest {
  targetKind: 'pod' | 'service';
  namespace: string;
  targetName: string;
  remotePort: number;
  localPort?: number;
}

export interface KubernetesPortForwardHandle {
  localPort: number;
  close(): Promise<void>;
}

/**
 * Main-process-only Kubernetes capability. No kubeconfig, credential, or
 * transport types are shared with the renderer.
 */
export interface KubernetesClient {
  /** Verifies API transport/TLS reachability without reading a cluster resource. */
  probeConnection(): Promise<void>;
  list(query: KubernetesResourceQuery, continueToken?: string): Promise<KubernetesResourcePage>;
  get(query: KubernetesResourceQuery, name: string, namespace?: string): Promise<Record<string, unknown>>;
  listEvents(reference: { uid: string; namespace?: string }): Promise<KubernetesResourceSummary[]>;
  listCustomResourceDefinitions(): Promise<KubernetesCustomResourceDefinition[]>;
  getRelatedResources(request: KubernetesRelatedResourceRequest): Promise<KubernetesRelatedResources>;
  getPodContainerEnvironment(input: KubernetesPodTarget): Promise<KubernetesPodEnvironment>;
  /** Optional for compatibility with focused client fakes; the production adapter always implements it. */
  resolvePodDeploymentLogTargets?(
    input: KubernetesPodTarget
  ): Promise<KubernetesPodDeploymentLogTargets | undefined>;
  watch(
    query: KubernetesResourceQuery,
    resourceVersion: string,
    onEvent: (event: KubernetesWatchEvent) => void
  ): Promise<AbortController>;
  openPodLog(
    request: KubernetesPodLogRequest,
    callbacks: KubernetesPodLogCallbacks
  ): Promise<KubernetesPodLogHandle>;
  openPodExec(
    request: KubernetesPodExecRequest,
    callbacks: KubernetesPodExecCallbacks
  ): Promise<KubernetesPodExecHandle>;
  openPortForward(request: KubernetesPortForwardRequest): Promise<KubernetesPortForwardHandle>;
  close(): Promise<void>;
}

export interface KubernetesClientOptions {
  kubeconfigPath: string;
  context: string;
}

/** Main-process test seam; it is never exposed through IPC. */
export interface KubernetesClientDependencies {
  loadKubernetesNode?: () => Promise<KubernetesNodeModule>;
}

type KubernetesNodeModule = typeof KubernetesNode;

type ReadOnlyApi = Record<string, (params?: Record<string, unknown>) => Promise<unknown>>;

type WatchApi = {
  watch(
    path: string,
    queryParams: Record<string, string | number | boolean | undefined>,
    callback: (phase: string, object: unknown) => void,
    done: (error: unknown) => void
  ): Promise<AbortController>;
};

type KubeConfigLike = {
  loadFromString(config: string): void;
  makePathsAbsolute(rootDirectory: string): void;
  setCurrentContext(context: string): void;
  getContextObject(name: string): { name: string } | null;
  getCurrentUser(): {
    token?: string;
    certData?: string;
    keyData?: string;
    certFile?: string;
    keyFile?: string;
    exec?: unknown;
    authProvider?: unknown;
  } | null;
  makeApiClient<T>(api: new (...args: never[]) => T): T;
};

const PAGE_SIZE = 200;
const MULTI_NAMESPACE_CONTINUE_PREFIX = 'service-manager-kubernetes-v1:';

interface MultiNamespaceContinuation {
  namespaceIndex: number;
  continueToken?: string;
}

interface KubernetesListObject {
  items?: unknown[];
  metadata?: {
    continue?: string;
    resourceVersion?: string;
  };
}

const CUSTOM_RESOURCE_GROUP = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;
const CUSTOM_RESOURCE_PLURAL = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const CUSTOM_RESOURCE_VERSION = /^v[0-9]+(?:alpha[0-9]+|beta[0-9]+)?$/;
const CUSTOM_RESOURCE_KIND = /^[A-Za-z][A-Za-z0-9]*$/;

interface ResourceDefinition {
  apiVersion: string;
  plural: string;
  kind: string;
  scope: 'namespaced' | 'cluster';
  api: 'core' | 'apps' | 'networking';
  listAll?: string;
  listNamespaced?: string;
  listCluster?: string;
  getNamespaced?: string;
  getCluster?: string;
}

const BUILTIN_RESOURCES: Record<Exclude<KubernetesResourceKind, 'custom-resources'>, ResourceDefinition> = {
  pods: {
    apiVersion: 'v1',
    plural: 'pods',
    kind: 'Pod',
    scope: 'namespaced',
    api: 'core',
    listAll: 'listPodForAllNamespaces',
    listNamespaced: 'listNamespacedPod',
    getNamespaced: 'readNamespacedPod',
  },
  deployments: {
    apiVersion: 'apps/v1',
    plural: 'deployments',
    kind: 'Deployment',
    scope: 'namespaced',
    api: 'apps',
    listAll: 'listDeploymentForAllNamespaces',
    listNamespaced: 'listNamespacedDeployment',
    getNamespaced: 'readNamespacedDeployment',
  },
  statefulsets: {
    apiVersion: 'apps/v1',
    plural: 'statefulsets',
    kind: 'StatefulSet',
    scope: 'namespaced',
    api: 'apps',
    listAll: 'listStatefulSetForAllNamespaces',
    listNamespaced: 'listNamespacedStatefulSet',
    getNamespaced: 'readNamespacedStatefulSet',
  },
  services: {
    apiVersion: 'v1',
    plural: 'services',
    kind: 'Service',
    scope: 'namespaced',
    api: 'core',
    listAll: 'listServiceForAllNamespaces',
    listNamespaced: 'listNamespacedService',
    getNamespaced: 'readNamespacedService',
  },
  ingresses: {
    apiVersion: 'networking.k8s.io/v1',
    plural: 'ingresses',
    kind: 'Ingress',
    scope: 'namespaced',
    api: 'networking',
    listAll: 'listIngressForAllNamespaces',
    listNamespaced: 'listNamespacedIngress',
    getNamespaced: 'readNamespacedIngress',
  },
  configmaps: {
    apiVersion: 'v1',
    plural: 'configmaps',
    kind: 'ConfigMap',
    scope: 'namespaced',
    api: 'core',
    listAll: 'listConfigMapForAllNamespaces',
    listNamespaced: 'listNamespacedConfigMap',
    getNamespaced: 'readNamespacedConfigMap',
  },
  secrets: {
    apiVersion: 'v1',
    plural: 'secrets',
    kind: 'Secret',
    scope: 'namespaced',
    api: 'core',
    listAll: 'listSecretForAllNamespaces',
    listNamespaced: 'listNamespacedSecret',
    getNamespaced: 'readNamespacedSecret',
  },
  persistentvolumeclaims: {
    apiVersion: 'v1',
    plural: 'persistentvolumeclaims',
    kind: 'PersistentVolumeClaim',
    scope: 'namespaced',
    api: 'core',
    listAll: 'listPersistentVolumeClaimForAllNamespaces',
    listNamespaced: 'listNamespacedPersistentVolumeClaim',
    getNamespaced: 'readNamespacedPersistentVolumeClaim',
  },
  nodes: {
    apiVersion: 'v1',
    plural: 'nodes',
    kind: 'Node',
    scope: 'cluster',
    api: 'core',
    listCluster: 'listNode',
    getCluster: 'readNode',
  },
  namespaces: {
    apiVersion: 'v1',
    plural: 'namespaces',
    kind: 'Namespace',
    scope: 'cluster',
    api: 'core',
    listCluster: 'listNamespace',
    getCluster: 'readNamespace',
  },
};

function loadKubernetesNode(): Promise<KubernetesNodeModule> {
  // The Kubernetes client is ESM-only, while Electron's main TypeScript build
  // remains CommonJS. A native dynamic import avoids TypeScript lowering this
  // into require(), which would otherwise throw ERR_REQUIRE_ESM at runtime.
  const importModule = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<KubernetesNodeModule>;
  return importModule('@kubernetes/client-node');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Kubernetes API returned an invalid object.');
  }
  return value as Record<string, unknown>;
}

function objectValue(value: unknown, key: string): Record<string, unknown> {
  const candidate = asRecord(value)[key];
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

interface KubernetesControllerOwner {
  name: string;
  uid: string;
}

function controllerOwner(
  resource: Record<string, unknown>,
  kind: 'ReplicaSet' | 'Deployment'
): KubernetesControllerOwner | undefined {
  const references = objectValue(resource, 'metadata').ownerReferences;
  if (!Array.isArray(references)) {
    return undefined;
  }
  for (const value of references) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const reference = value as Record<string, unknown>;
    const name = stringValue(reference.name);
    const uid = stringValue(reference.uid);
    if (
      reference.controller === true
      && reference.apiVersion === 'apps/v1'
      && reference.kind === kind
      && name
      && uid
    ) {
      return { name, uid };
    }
  }
  return undefined;
}

function deploymentLabelSelector(deployment: Record<string, unknown>): string | undefined {
  const rawSelector = objectValue(deployment, 'spec').selector;
  if (!rawSelector || typeof rawSelector !== 'object' || Array.isArray(rawSelector)) {
    return undefined;
  }
  const selector = rawSelector as Record<string, unknown>;
  const requirements: string[] = [];
  if (selector.matchLabels !== undefined) {
    if (!selector.matchLabels || typeof selector.matchLabels !== 'object' || Array.isArray(selector.matchLabels)) {
      return undefined;
    }
    const labels = selector.matchLabels as Record<string, unknown>;
    for (const key of Object.keys(labels).sort()) {
      const value = labels[key];
      if (!isNonEmptyString(key) || typeof value !== 'string') {
        return undefined;
      }
      requirements.push(`${key}=${value}`);
    }
  }

  if (selector.matchExpressions !== undefined) {
    if (!Array.isArray(selector.matchExpressions)) {
      return undefined;
    }
    for (const value of selector.matchExpressions) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
      }
      const expression = value as Record<string, unknown>;
      const key = stringValue(expression.key);
      const operator = stringValue(expression.operator);
      if (!key || !operator) {
        return undefined;
      }
      if (operator === 'Exists') {
        requirements.push(key);
        continue;
      }
      if (operator === 'DoesNotExist') {
        requirements.push(`!${key}`);
        continue;
      }
      if (operator !== 'In' && operator !== 'NotIn') {
        return undefined;
      }
      if (!Array.isArray(expression.values)
        || expression.values.length === 0
        || !expression.values.every((item): item is string => typeof item === 'string')) {
        return undefined;
      }
      requirements.push(`${key} ${operator.toLowerCase()} (${expression.values.join(',')})`);
    }
  }
  return requirements.length > 0 ? requirements.join(',') : undefined;
}

function podDeclaresContainer(pod: Record<string, unknown>, containerName: string): boolean {
  const spec = objectValue(pod, 'spec');
  return [spec.containers, spec.initContainers].some((containers) => (
    Array.isArray(containers) && containers.some((container) => (
      container !== null
      && typeof container === 'object'
      && !Array.isArray(container)
      && (container as Record<string, unknown>).name === containerName
    ))
  ));
}

function isUnavailableDeploymentLogDiscoveryError(error: unknown): boolean {
  const status = statusCodeFrom(error);
  return status === 401 || status === 403 || status === 404;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isPort(value: unknown, allowZero = false): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= (allowZero ? 0 : 1)
    && value <= 65_535;
}

function errorFrom(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function splitLogChunks(value: string): { lines: string[]; remainder: string } {
  const normalized = value.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  return {
    lines: parts.slice(0, -1),
    remainder: parts.at(-1) ?? '',
  };
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Reduces CRDs to only the information needed to construct a subsequent
 * read-only CustomObjects query. Metadata, schemas, conversion webhooks, and
 * annotations are deliberately omitted from the discovery result.
 */
export function mapCustomResourceDefinitions(values: unknown[]): KubernetesCustomResourceDefinition[] {
  if (!Array.isArray(values)) {
    throw new Error('Kubernetes API returned an invalid Custom Resource Definition list.');
  }
  const definitions: KubernetesCustomResourceDefinition[] = [];
  for (const value of values) {
    const spec = objectValue(value, 'spec');
    const names = objectValue(spec, 'names');
    const group = stringValue(spec.group);
    const kind = stringValue(names.kind);
    const plural = stringValue(names.plural);
    const scope = spec.scope === 'Namespaced'
      ? 'namespaced'
      : spec.scope === 'Cluster'
        ? 'cluster'
        : undefined;
    if (!group || !kind || !plural || !scope
      || !CUSTOM_RESOURCE_GROUP.test(group)
      || !CUSTOM_RESOURCE_KIND.test(kind)
      || !CUSTOM_RESOURCE_PLURAL.test(plural)) {
      continue;
    }
    const versions = Array.isArray(spec.versions) ? spec.versions : [];
    for (const entry of versions) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const versionRecord = entry as Record<string, unknown>;
      const version = stringValue(versionRecord.name);
      if (versionRecord.served === true && version && CUSTOM_RESOURCE_VERSION.test(version)) {
        definitions.push({ group, version, kind, plural, scope });
      }
    }
  }
  return definitions.sort((left, right) => (
    left.group.localeCompare(right.group)
    || left.kind.localeCompare(right.kind)
    || left.version.localeCompare(right.version)
  ));
}

function scopeFor(query: KubernetesResourceQuery): 'namespaced' | 'cluster' {
  if (query.kind === 'nodes' || query.kind === 'namespaces') {
    return 'cluster';
  }
  return query.scope ?? 'namespaced';
}

function customResourceParts(query: KubernetesResourceQuery): { group: string; version: string; plural: string } {
  if (!isNonEmptyString(query.apiVersion) || !isNonEmptyString(query.plural)) {
    throw new Error('Custom Resources require an API version and plural resource name.');
  }
  const [group, version, ...rest] = query.apiVersion.split('/');
  if (!isNonEmptyString(group) || !isNonEmptyString(version) || rest.length > 0) {
    throw new Error('Custom Resource API version must use group/version form.');
  }
  return { group, version, plural: query.plural };
}

function resourceDefinition(query: KubernetesResourceQuery): ResourceDefinition {
  if (query.kind === 'custom-resources') {
    const custom = customResourceParts(query);
    return {
      apiVersion: `${custom.group}/${custom.version}`,
      plural: custom.plural,
      kind: 'CustomResource',
      scope: scopeFor(query),
      api: 'core',
    };
  }
  return BUILTIN_RESOURCES[query.kind];
}

function apiPath(apiVersion: string, plural: string, namespace?: string): string {
  const prefix = apiVersion === 'v1' ? `/api/${apiVersion}` : `/apis/${apiVersion}`;
  return namespace ? `${prefix}/namespaces/${encodeURIComponent(namespace)}/${plural}` : `${prefix}/${plural}`;
}

function listParameters(query: KubernetesResourceQuery, continueToken?: string): Record<string, unknown> {
  return {
    limit: PAGE_SIZE,
    ...(continueToken ? { _continue: continueToken } : {}),
    ...(query.labelSelector ? { labelSelector: query.labelSelector } : {}),
    ...(query.fieldSelector ? { fieldSelector: query.fieldSelector } : {}),
  };
}

function decodeMultiNamespaceContinuation(value: string | undefined): MultiNamespaceContinuation {
  if (!value) {
    return { namespaceIndex: 0 };
  }
  if (!value.startsWith(MULTI_NAMESPACE_CONTINUE_PREFIX)) {
    throw new Error('Namespace page continuation does not match the active query.');
  }
  try {
    const decoded = JSON.parse(Buffer.from(value.slice(MULTI_NAMESPACE_CONTINUE_PREFIX.length), 'base64url').toString('utf8'));
    if (!Number.isInteger(decoded?.namespaceIndex) || decoded.namespaceIndex < 0) {
      throw new Error('invalid continuation');
    }
    if (decoded.continueToken !== undefined && !isNonEmptyString(decoded.continueToken)) {
      throw new Error('invalid continuation');
    }
    return decoded as MultiNamespaceContinuation;
  } catch {
    throw new Error('Namespace page continuation does not match the active query.');
  }
}

function encodeMultiNamespaceContinuation(value: MultiNamespaceContinuation): string {
  return `${MULTI_NAMESPACE_CONTINUE_PREFIX}${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
}

function statusCodeFrom(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const status = numericValue(record.statusCode) ?? numericValue(record.status) ?? numericValue(record.code);
  if (status !== undefined) {
    return status;
  }
  const response = record.response;
  return response && typeof response === 'object'
    ? statusCodeFrom(response)
    : undefined;
}

function isWatchType(value: string): value is KubernetesWatchEvent['type'] {
  return value === 'ADDED' || value === 'MODIFIED' || value === 'DELETED' || value === 'BOOKMARK' || value === 'ERROR';
}

function requireSupportedUser(kubeConfig: KubeConfigLike): void {
  const user = kubeConfig.getCurrentUser();
  if (!user) {
    throw new Error('The selected Kubernetes Context does not use supported token or client-certificate credentials.');
  }
  // The client-node KubeConfig installs auth-provider plugins, including exec
  // providers. Reject any provider before it can construct an API client or
  // accept a co-located token/certificate credential.
  if (isConfigured(user.authProvider)) {
    throw new Error('The selected Kubernetes Context uses unsupported auth-provider credentials.');
  }
  if (isConfigured(user.exec)) {
    throw new Error('The selected Kubernetes Context uses unsupported exec credentials.');
  }
  const hasToken = isNonEmptyString(user.token);
  const certificateCredential = classifyCertificateCredential(user);
  if (certificateCredential === 'incomplete' || (!hasToken && certificateCredential !== 'complete')) {
    throw new Error('The selected Kubernetes Context does not use supported token or client-certificate credentials.');
  }
}

async function readAndPreflightKubeconfig(options: KubernetesClientOptions): Promise<string> {
  let rawKubeconfig: string;
  let document: unknown;
  try {
    rawKubeconfig = await fs.readFile(options.kubeconfigPath, 'utf8');
    document = yaml.load(rawKubeconfig);
  } catch {
    throw new Error('The selected Kubernetes kubeconfig could not be read.');
  }

  switch (preflightKubeconfigContext(document, options.context)) {
    case 'supported':
      return rawKubeconfig;
    case 'missing-context':
      throw new Error('The selected Kubernetes Context is no longer available.');
    case 'auth-provider':
      throw new Error('The selected Kubernetes Context uses unsupported auth-provider credentials.');
    case 'exec-auth':
      throw new Error('The selected Kubernetes Context uses unsupported exec credentials.');
    case 'missing-auth':
    case 'unsupported-auth':
      throw new Error('The selected Kubernetes Context does not use supported token or client-certificate credentials.');
  }
}

function isConfigured(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function classifyCertificateCredential(
  user: NonNullable<ReturnType<KubeConfigLike['getCurrentUser']>>
): 'none' | 'complete' | 'incomplete' {
  const inlineCertificate = isNonEmptyString(user.certData);
  const inlineKey = isNonEmptyString(user.keyData);
  const fileCertificate = isNonEmptyString(user.certFile);
  const fileKey = isNonEmptyString(user.keyFile);
  const hasCertificateField = inlineCertificate || inlineKey || fileCertificate || fileKey;

  if (!hasCertificateField) {
    return 'none';
  }
  if (inlineCertificate && inlineKey && !fileCertificate && !fileKey) {
    return 'complete';
  }
  if (fileCertificate && fileKey && !inlineCertificate && !inlineKey) {
    return 'complete';
  }

  return 'incomplete';
}

/**
 * Creates a main-process-only adapter from the local kubeconfig. The caller
 * must select a safe Context through ClusterSession before invoking this.
 */
export async function createKubernetesClient(
  options: KubernetesClientOptions,
  dependencies: KubernetesClientDependencies = {}
): Promise<KubernetesClient> {
  const rawKubeconfig = await readAndPreflightKubeconfig(options);
  const kubernetes = await (dependencies.loadKubernetesNode ?? loadKubernetesNode)();
  const kubeConfig = new kubernetes.KubeConfig() as unknown as KubeConfigLike;
  kubeConfig.loadFromString(rawKubeconfig);
  kubeConfig.makePathsAbsolute(path.dirname(options.kubeconfigPath));
  if (!kubeConfig.getContextObject(options.context)) {
    throw new Error('The selected Kubernetes Context is no longer available.');
  }
  kubeConfig.setCurrentContext(options.context);
  requireSupportedUser(kubeConfig);

  return new KubernetesClientAdapter(kubernetes, kubeConfig);
}

class KubernetesClientAdapter implements KubernetesClient {
  private readonly version: ReadOnlyApi;
  private readonly core: ReadOnlyApi;
  private readonly discovery: ReadOnlyApi;
  private readonly apps: ReadOnlyApi;
  private readonly networking: ReadOnlyApi;
  private readonly extensions: ReadOnlyApi;
  private readonly custom: ReadOnlyApi;
  private readonly watchApi: WatchApi;
  private readonly runtimeKubeConfig: KubernetesNode.KubeConfig;
  private readonly logApi: KubernetesNode.Log;
  private readonly execApi: KubernetesNode.Exec;
  private readonly portForwardApi: KubernetesNode.PortForward;
  private readonly activeWatches = new Set<AbortController>();
  private closed = false;

  public constructor(kubernetes: KubernetesNodeModule, kubeConfig: KubeConfigLike) {
    this.runtimeKubeConfig = kubeConfig as unknown as KubernetesNode.KubeConfig;
    this.version = kubeConfig.makeApiClient(kubernetes.VersionApi) as unknown as ReadOnlyApi;
    this.core = kubeConfig.makeApiClient(kubernetes.CoreV1Api) as unknown as ReadOnlyApi;
    this.discovery = kubeConfig.makeApiClient(kubernetes.DiscoveryV1Api) as unknown as ReadOnlyApi;
    this.apps = kubeConfig.makeApiClient(kubernetes.AppsV1Api) as unknown as ReadOnlyApi;
    this.networking = kubeConfig.makeApiClient(kubernetes.NetworkingV1Api) as unknown as ReadOnlyApi;
    this.extensions = kubeConfig.makeApiClient(kubernetes.ApiextensionsV1Api) as unknown as ReadOnlyApi;
    this.custom = kubeConfig.makeApiClient(kubernetes.CustomObjectsApi) as unknown as ReadOnlyApi;
    this.watchApi = new kubernetes.Watch(
      this.runtimeKubeConfig
    ) as unknown as WatchApi;
    this.logApi = new kubernetes.Log(this.runtimeKubeConfig);
    this.execApi = new kubernetes.Exec(this.runtimeKubeConfig);
    this.portForwardApi = new kubernetes.PortForward(this.runtimeKubeConfig);
  }

  public async probeConnection(): Promise<void> {
    this.assertOpen();
    try {
      await this.call(this.version, 'getCode', {});
    } catch (error) {
      const status = statusCodeFrom(error);
      if (status === 401 || status === 403) {
        return;
      }
      throw error;
    }
  }

  public async list(query: KubernetesResourceQuery, continueToken?: string): Promise<KubernetesResourcePage> {
    this.assertOpen();
    const definition = resourceDefinition(query);
    if (definition.scope === 'cluster' || query.namespaceScope.mode === 'all') {
      const response = await this.listOne(query, undefined, continueToken);
      return this.toPage(query.kind, response);
    }

    const namespaces = [...new Set(query.namespaceScope.namespaces.map((namespace) => namespace.trim()).filter(Boolean))].sort();
    if (namespaces.length === 0) {
      throw new Error('Select at least one Namespace.');
    }
    const continuation = decodeMultiNamespaceContinuation(continueToken);
    const namespace = namespaces[continuation.namespaceIndex];
    if (!namespace) {
      throw new Error('Namespace page continuation does not match the active query.');
    }
    const response = await this.listOne(query, namespace, continuation.continueToken);
    const serverContinue = stringValue(response.metadata?.continue);
    const nextContinuation = serverContinue
      ? encodeMultiNamespaceContinuation({ namespaceIndex: continuation.namespaceIndex, continueToken: serverContinue })
      : continuation.namespaceIndex + 1 < namespaces.length
        ? encodeMultiNamespaceContinuation({ namespaceIndex: continuation.namespaceIndex + 1 })
        : undefined;

    return {
      items: this.summaryItems(query.kind, response.items),
      ...(nextContinuation ? { continueToken: nextContinuation } : {}),
      resourceVersion: stringValue(response.metadata?.resourceVersion) ?? '',
    };
  }

  public async get(
    query: KubernetesResourceQuery,
    name: string,
    namespace?: string
  ): Promise<Record<string, unknown>> {
    this.assertOpen();
    if (!isNonEmptyString(name)) {
      throw new Error('Kubernetes resource name is required.');
    }
    const definition = resourceDefinition(query);
    const scope = definition.scope;
    const targetNamespace = scope === 'namespaced' ? namespace : undefined;
    if (scope === 'namespaced' && !isNonEmptyString(targetNamespace)) {
      throw new Error(`Namespace is required to read ${query.kind}.`);
    }

    if (query.kind === 'custom-resources') {
      const custom = customResourceParts(query);
      const method = scope === 'namespaced' ? 'getNamespacedCustomObject' : 'getClusterCustomObject';
      return asRecord(await this.call(this.custom, method, {
        ...custom,
        name,
        ...(targetNamespace ? { namespace: targetNamespace } : {}),
      }));
    }

    const method = scope === 'namespaced' ? definition.getNamespaced : definition.getCluster;
    if (!method) {
      throw new Error(`Reading ${query.kind} is not supported.`);
    }
    return asRecord(await this.call(this.apiFor(definition), method, {
      name,
      ...(targetNamespace ? { namespace: targetNamespace } : {}),
    }));
  }

  /**
   * Resolves Deployment-wide log membership without accepting a renderer-
   * supplied Deployment or selector. Every controller hop is read directly
   * and its UID is checked before the next resource is trusted.
   */
  public async resolvePodDeploymentLogTargets(
    input: KubernetesPodTarget
  ): Promise<KubernetesPodDeploymentLogTargets | undefined> {
    this.assertOpen();
    this.assertPodStreamRequest(input);
    try {
      const pod = asRecord(await this.call(this.core, 'readNamespacedPod', {
        name: input.podName,
        namespace: input.namespace,
      }));
      const replicaSetOwner = controllerOwner(pod, 'ReplicaSet');
      if (!replicaSetOwner) {
        return undefined;
      }

      const replicaSet = asRecord(await this.call(this.apps, 'readNamespacedReplicaSet', {
        name: replicaSetOwner.name,
        namespace: input.namespace,
      }));
      if (stringValue(objectValue(replicaSet, 'metadata').uid) !== replicaSetOwner.uid) {
        return undefined;
      }
      const deploymentOwner = controllerOwner(replicaSet, 'Deployment');
      if (!deploymentOwner) {
        return undefined;
      }

      const deployment = asRecord(await this.call(this.apps, 'readNamespacedDeployment', {
        name: deploymentOwner.name,
        namespace: input.namespace,
      }));
      const deploymentMetadata = objectValue(deployment, 'metadata');
      const deploymentName = stringValue(deploymentMetadata.name);
      if (stringValue(deploymentMetadata.uid) !== deploymentOwner.uid
        || deploymentName !== deploymentOwner.name) {
        return undefined;
      }
      const labelSelector = deploymentLabelSelector(deployment);
      if (!labelSelector) {
        return undefined;
      }

      const pods: Array<{ uid: string; podName: string }> = [];
      const seenUids = new Set<string>();
      const seenNames = new Set<string>();
      const seenContinuations = new Set<string>();
      let continueToken: string | undefined;
      do {
        const page = asRecord(await this.call(this.core, 'listNamespacedPod', {
          namespace: input.namespace,
          labelSelector,
          limit: PAGE_SIZE,
          ...(continueToken ? { _continue: continueToken } : {}),
        })) as KubernetesListObject;
        if (page.items !== undefined && !Array.isArray(page.items)) {
          throw new Error('Kubernetes API returned an invalid Pod list.');
        }
        for (const value of page.items ?? []) {
          const candidate = asRecord(value);
          const metadata = objectValue(candidate, 'metadata');
          const uid = stringValue(metadata.uid);
          const podName = stringValue(metadata.name);
          if (!uid || !podName || seenUids.has(uid) || seenNames.has(podName)
            || !podDeclaresContainer(candidate, input.container)) {
            continue;
          }
          seenUids.add(uid);
          seenNames.add(podName);
          pods.push({ uid, podName });
        }
        const next = stringValue(page.metadata?.continue);
        if (next && seenContinuations.has(next)) {
          throw new Error('Kubernetes API returned a repeated Pod list continuation.');
        }
        if (next) seenContinuations.add(next);
        continueToken = next;
      } while (continueToken);

      pods.sort((left, right) => (
        left.podName < right.podName ? -1
          : left.podName > right.podName ? 1
            : left.uid < right.uid ? -1
              : left.uid > right.uid ? 1 : 0
      ));
      return { name: deploymentName, pods };
    } catch (error) {
      if (isUnavailableDeploymentLogDiscoveryError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Active-detail-only Pod environment resolution. This deliberately avoids
   * list summaries, ResourceCoordinator, and every cache because decoded
   * Secret values must exist only for the immediate caller.
   */
  public async getPodContainerEnvironment(input: KubernetesPodTarget): Promise<KubernetesPodEnvironment> {
    this.assertOpen();
    this.assertPodStreamRequest(input);
    let pod: Record<string, unknown>;
    try {
      pod = asRecord(await this.call(this.core, 'readNamespacedPod', {
        name: input.podName,
        namespace: input.namespace,
      }));
    } catch (error) {
      const status = statusCodeFrom(error);
      if (status === 401 || status === 403) {
        return noPermissionPodEnvironment();
      }
      throw safePodEnvironmentReadError(error);
    }
    return resolvePodContainerEnvironment(pod, input.container, {
      readSecret: async (name) => asRecord(await this.call(this.core, 'readNamespacedSecret', {
        name,
        namespace: input.namespace,
      })),
      isPermissionError: (error) => {
        const code = statusCodeFrom(error);
        return code === 401 || code === 403;
      },
    });
  }

  public async listEvents(reference: { uid: string; namespace?: string }): Promise<KubernetesResourceSummary[]> {
    this.assertOpen();
    if (!isNonEmptyString(reference.uid)) {
      throw new Error('Kubernetes resource UID is required to list Events.');
    }
    const response = await this.call(
      this.core,
      reference.namespace ? 'listNamespacedEvent' : 'listEventForAllNamespaces',
      {
        ...(reference.namespace ? { namespace: reference.namespace } : {}),
        fieldSelector: `involvedObject.uid=${reference.uid}`,
        limit: PAGE_SIZE,
      }
    ) as KubernetesListObject;
    return this.summaryItems('events', response.items);
  }

  /** CRD discovery is on-demand and does not create a resource Watch. */
  public async listCustomResourceDefinitions(): Promise<KubernetesCustomResourceDefinition[]> {
    this.assertOpen();
    const response = asRecord(await this.call(this.extensions, 'listCustomResourceDefinition', {}));
    if (!Array.isArray(response.items)) {
      throw new Error('Kubernetes API returned an invalid Custom Resource Definition list.');
    }
    return mapCustomResourceDefinitions(response.items);
  }

  /**
   * Detail-only, bounded relationship reads. They deliberately bypass the
   * ResourceCoordinator: no list snapshot, Watch, raw endpoint address, or
   * transport handle is retained for a collapsed detail section.
   */
  public async getRelatedResources(
    request: KubernetesRelatedResourceRequest
  ): Promise<KubernetesRelatedResources> {
    this.assertOpen();
    this.assertRelatedResourceRequest(request);

    if (request.kind === 'service') {
      const [endpoint, endpointSlices] = await Promise.all([
        this.call(this.core, 'readNamespacedEndpoints', {
          name: request.name,
          namespace: request.namespace,
        }),
        this.call(this.discovery, 'listNamespacedEndpointSlice', {
          namespace: request.namespace,
          labelSelector: `kubernetes.io/service-name=${request.name}`,
          limit: PAGE_SIZE,
        }),
      ]);
      const sliceList = asRecord(endpointSlices) as KubernetesListObject;
      return {
        endpoints: this.summaryItems('services', [endpoint]),
        endpointSlices: this.summaryItems('services', sliceList.items),
      };
    }

    if (!isNonEmptyString(request.selector)) {
      throw new Error('Kubernetes Workload selector is required.');
    }
    const pods = await this.call(this.core, 'listNamespacedPod', {
      namespace: request.namespace,
      labelSelector: request.selector,
      limit: PAGE_SIZE,
    }) as KubernetesListObject;
    return { pods: this.summaryItems('pods', pods.items) };
  }

  public async watch(
    query: KubernetesResourceQuery,
    resourceVersion: string,
    onEvent: (event: KubernetesWatchEvent) => void
  ): Promise<AbortController> {
    this.assertOpen();
    const definition = resourceDefinition(query);
    const namespaces = definition.scope === 'cluster' || query.namespaceScope.mode === 'all'
      ? [undefined]
      : [...new Set(query.namespaceScope.namespaces.map((namespace) => namespace.trim()).filter(Boolean))].sort();
    if (namespaces.length === 0) {
      throw new Error('Select at least one Namespace.');
    }

    const group = new AbortController();
    const children: AbortController[] = [];
    let terminalEventSent = false;
    this.activeWatches.add(group);
    group.signal.addEventListener('abort', () => {
      for (const child of children) {
        child.abort();
      }
      this.activeWatches.delete(group);
    }, { once: true });

    const reportTerminalWatchEvent = (event: KubernetesWatchEvent): void => {
      if (group.signal.aborted || terminalEventSent) {
        return;
      }
      terminalEventSent = true;
      onEvent(event);
    };

    try {
      await Promise.all(namespaces.map(async (namespace) => {
        const child = await this.watchApi.watch(
          apiPath(definition.apiVersion, definition.plural, namespace),
          {
            resourceVersion,
            allowWatchBookmarks: true,
            ...(query.labelSelector ? { labelSelector: query.labelSelector } : {}),
            ...(query.fieldSelector ? { fieldSelector: query.fieldSelector } : {}),
          },
          (phase, object) => {
            const type = phase.toUpperCase();
            if (!isWatchType(type)) {
              return;
            }
            if (type === 'ERROR') {
              reportTerminalWatchEvent({ type, statusCode: statusCodeFrom(object) });
              return;
            }
            if (type === 'BOOKMARK') {
              const metadata = objectValue(object, 'metadata');
              onEvent({ type, resourceVersion: stringValue(metadata.resourceVersion) });
              return;
            }
            try {
              onEvent({ type, object: mapKubernetesResourceSummary(query.kind, asRecord(object)) });
            } catch {
              reportTerminalWatchEvent({ type: 'ERROR' });
            }
          },
          (error) => {
            // client-node calls `done(null)` for a cleanly closed HTTP Watch
            // stream. A closed stream is not a healthy Watch: surface it as a
            // recoverable transport error so the coordinator releases the
            // group and the session can reconnect/relist the active view.
            const closure = error ?? Object.assign(
              new Error('The Kubernetes resource Watch stream ended.'),
              { code: 'ECONNRESET' }
            );
            reportTerminalWatchEvent({
              type: 'ERROR',
              statusCode: statusCodeFrom(closure),
              error: closure,
            });
          }
        );
        children.push(child);
        if (group.signal.aborted) {
          child.abort();
        }
      }));
      return group;
    } catch (error) {
      group.abort();
      throw error;
    }
  }

  public async openPodLog(
    request: KubernetesPodLogRequest,
    callbacks: KubernetesPodLogCallbacks
  ): Promise<KubernetesPodLogHandle> {
    this.assertOpen();
    this.assertPodStreamRequest(request);
    if (!Number.isInteger(request.tailLines) || request.tailLines < 1) {
      throw new Error('Kubernetes log tail line count must be a positive integer.');
    }
    if (request.sinceTime !== undefined && Number.isNaN(new Date(request.sinceTime).getTime())) {
      throw new Error('Kubernetes log sinceTime must be an RFC3339 timestamp.');
    }

    let remainder = '';
    let resolveCompleted: () => void;
    let completed = false;
    const completedPromise = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const settle = () => {
      if (!completed) {
        completed = true;
        resolveCompleted();
      }
    };
    const output = new Writable({
      write: (chunk, _encoding, callback) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        const parsed = splitLogChunks(`${remainder}${text}`);
        remainder = parsed.remainder;
        for (const line of parsed.lines) {
          callbacks.onLine(line);
        }
        callback();
      },
      final: (callback) => {
        if (remainder) {
          callbacks.onLine(remainder);
          remainder = '';
        }
        settle();
        callback();
      },
    });
    output.once('error', settle);

    let controller: AbortController;
    try {
      controller = await this.logApi.log(
        request.namespace,
        request.podName,
        request.container,
        output,
        {
          tailLines: request.tailLines,
          follow: request.follow,
          timestamps: true,
          ...(request.sinceTime ? { sinceTime: request.sinceTime } : {}),
        }
      );
    } catch (error) {
      output.destroy();
      settle();
      throw error;
    }

    return {
      completed: completedPromise,
      close: async () => {
        controller.abort();
        output.destroy();
        settle();
        await completedPromise;
      },
    };
  }

  public async openPodExec(
    request: KubernetesPodExecRequest,
    callbacks: KubernetesPodExecCallbacks
  ): Promise<KubernetesPodExecHandle> {
    this.assertOpen();
    this.assertPodStreamRequest(request);
    if (!isNonEmptyString(request.shell)) {
      throw new Error('Kubernetes Pod shell is required.');
    }

    const stdin = new PassThrough();
    const createOutput = (): Writable & { columns: number; rows: number } => {
      const output = new Writable({
        write: (chunk, _encoding, callback) => {
          callbacks.onData(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
          callback();
        },
      }) as Writable & { columns: number; rows: number };
      output.columns = 80;
      output.rows = 24;
      return output;
    };
    const stdout = createOutput();
    const stderr = createOutput();
    let closed = false;
    const closeCallbacks = () => {
      if (!closed) {
        closed = true;
        callbacks.onClose();
      }
    };

    let socket: { close?: () => void; addEventListener?: (name: string, listener: () => void) => void };
    try {
      socket = await this.execApi.exec(
        request.namespace,
        request.podName,
        request.container,
        [request.shell],
        stdout,
        stderr,
        stdin,
        true,
        (status) => {
          if (status.status === 'Failure') {
            callbacks.onStatusFailure(new Error(status.message ?? 'Kubernetes Pod terminal exited with an error.'));
          }
        }
      ) as unknown as typeof socket;
    } catch (error) {
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
      throw error;
    }

    socket.addEventListener?.('close', closeCallbacks);
    socket.addEventListener?.('error', () => {
      callbacks.onError(new Error('Kubernetes Pod terminal connection failed.'));
      closeCallbacks();
    });
    return {
      write: (data) => {
        if (!closed) {
          stdin.write(data);
        }
      },
      resize: (cols, rows) => {
        if (!closed) {
          stdout.columns = cols;
          stdout.rows = rows;
          stdout.emit('resize');
        }
      },
      close: async () => {
        if (!closed) {
          stdin.end();
          socket.close?.();
          stdout.destroy();
          stderr.destroy();
          closeCallbacks();
        }
      },
    };
  }

  public async openPortForward(
    request: KubernetesPortForwardRequest
  ): Promise<KubernetesPortForwardHandle> {
    this.assertOpen();
    if (request.targetKind !== 'pod' && request.targetKind !== 'service') {
      throw new Error('Kubernetes port forward target must be a Pod or Service.');
    }
    if (!isNonEmptyString(request.namespace) || !isNonEmptyString(request.targetName)) {
      throw new Error('Kubernetes port forward target namespace and name are required.');
    }
    if (!isPort(request.remotePort) || (request.localPort !== undefined && !isPort(request.localPort, true))) {
      throw new Error('Kubernetes port forward ports must be valid integer TCP ports.');
    }

    const target = await this.resolvePortForwardTarget(request);
    const sockets = new Set<net.Socket>();
    const connections = new Set<{ close?: () => void }>();
    const socketConnections = new Map<net.Socket, { close?: () => void }>();
    let closing = false;
    let closePromise: Promise<void> | undefined;
    const closeConnection = (connection: { close?: () => void }): void => {
      connections.delete(connection);
      for (const [socket, mappedConnection] of socketConnections) {
        if (mappedConnection === connection) {
          socketConnections.delete(socket);
        }
      }
      try {
        connection.close?.();
      } catch {
        // PortForward connections are owned cleanup handles. A close failure
        // must not escape a local socket event handler as an uncaught error.
      }
    };
    const closeSocketConnection = (socket: net.Socket): void => {
      sockets.delete(socket);
      const connection = socketConnections.get(socket);
      if (connection) {
        socketConnections.delete(socket);
        closeConnection(connection);
      }
    };
    const server = net.createServer((socket) => {
      sockets.add(socket);
      // A remote port-forward rejection is reported by destroying this local
      // socket with an Error. Keep an error listener for the full socket
      // lifetime so Node never turns that expected rejection into an
      // unhandled EventEmitter error.
      socket.on('error', () => closeSocketConnection(socket));
      socket.once('close', () => closeSocketConnection(socket));
      void this.portForwardApi.portForward(
        request.namespace,
        target.podName,
        [target.remotePort],
        socket,
        socket,
        socket
      ).then((connection) => {
        const candidate = typeof connection === 'function' ? connection() : connection;
        if (!candidate) {
          return;
        }
        const closable = candidate as unknown as { close?: () => void };
        // The local client can disconnect while the Kubernetes WebSocket is
        // still opening. Do not retain that late remote handle; close it
        // immediately instead.
        if (closing || socket.destroyed || !sockets.has(socket)) {
          closeConnection(closable);
        } else {
          socketConnections.set(socket, closable);
          connections.add(closable);
        }
      }).catch((error: unknown) => {
        if (!socket.destroyed) {
          socket.destroy(errorFrom(error, 'Kubernetes port forward failed.'));
        }
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host: '127.0.0.1', port: request.localPort ?? 0 });
      });
    } catch (error) {
      await closeServer(server);
      throw error;
    }

    const address = server.address();
    if (!address || typeof address === 'string') {
      await closeServer(server);
      throw new Error('Kubernetes port forward did not allocate a local TCP port.');
    }
    return {
      localPort: address.port,
      close: async () => {
        if (closePromise) {
          return closePromise;
        }
        closing = true;
        // `server.close()` synchronously stops new accepts. Start it before
        // destroying active sockets so a teardown cannot race a newly
        // accepted connection into an orphaned remote forward.
        const listenerStopped = closeServer(server);
        closePromise = (async () => {
          for (const socket of [...sockets]) {
            socket.destroy();
          }
          for (const connection of [...connections]) {
            closeConnection(connection);
          }
          socketConnections.clear();
          await listenerStopped;
        })();
        return closePromise;
      },
    };
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const watch of [...this.activeWatches]) {
      watch.abort();
    }
    this.activeWatches.clear();
    // KubeConfig and generated read-only API clients do not own a standalone
    // connection pool. Aborting every active Watch releases the network work.
  }

  private async listOne(
    query: KubernetesResourceQuery,
    namespace: string | undefined,
    continueToken: string | undefined
  ): Promise<KubernetesListObject> {
    const definition = resourceDefinition(query);
    const params = listParameters(query, continueToken);

    if (query.kind === 'custom-resources') {
      const custom = customResourceParts(query);
      const method = definition.scope === 'cluster'
        ? 'listClusterCustomObject'
        : namespace
          ? 'listNamespacedCustomObject'
          : 'listCustomObjectForAllNamespaces';
      return asRecord(await this.call(this.custom, method, {
        ...params,
        ...custom,
        ...(namespace ? { namespace } : {}),
      })) as KubernetesListObject;
    }

    const method = definition.scope === 'cluster'
      ? definition.listCluster
      : namespace
        ? definition.listNamespaced
        : definition.listAll;
    if (!method) {
      throw new Error(`Listing ${query.kind} is not supported.`);
    }
    return asRecord(await this.call(this.apiFor(definition), method, {
      ...params,
      ...(namespace ? { namespace } : {}),
    })) as KubernetesListObject;
  }

  private toPage(kind: KubernetesResourceKind, value: KubernetesListObject): KubernetesResourcePage {
    const continueToken = stringValue(value.metadata?.continue);
    return {
      items: this.summaryItems(kind, value.items),
      ...(continueToken ? { continueToken } : {}),
      resourceVersion: stringValue(value.metadata?.resourceVersion) ?? '',
    };
  }

  private summaryItems(kind: KubernetesResourceKind | 'events', items: unknown[] | undefined): KubernetesResourceSummary[] {
    if (!items) {
      return [];
    }
    if (!Array.isArray(items)) {
      throw new Error('Kubernetes API returned an invalid resource list.');
    }
    return items.map((item) => mapKubernetesResourceSummary(kind, asRecord(item)));
  }

  private apiFor(definition: ResourceDefinition): ReadOnlyApi {
    switch (definition.api) {
      case 'core':
        return this.core;
      case 'apps':
        return this.apps;
      case 'networking':
        return this.networking;
    }
  }

  private async call(api: ReadOnlyApi, method: string, params: Record<string, unknown>): Promise<unknown> {
    const operation = api[method];
    if (!operation) {
      throw new Error(`Kubernetes client does not provide ${method}.`);
    }
    return operation.call(api, params);
  }

  private assertPodStreamRequest(request: {
    namespace: string;
    podName: string;
    container: string;
  }): void {
    if (!isNonEmptyString(request.namespace) || !isNonEmptyString(request.podName) || !isNonEmptyString(request.container)) {
      throw new Error('Kubernetes Pod namespace, name, and container are required.');
    }
  }

  private async resolvePortForwardTarget(
    request: KubernetesPortForwardRequest
  ): Promise<{ podName: string; remotePort: number }> {
    if (request.targetKind === 'pod') {
      return { podName: request.targetName, remotePort: request.remotePort };
    }

    const service = asRecord(await this.call(this.core, 'readNamespacedService', {
      name: request.targetName,
      namespace: request.namespace,
    }));
    const servicePorts = objectValue(service, 'spec').ports;
    if (!Array.isArray(servicePorts)) {
      throw new Error(`Service ${request.targetName} does not expose any ports.`);
    }
    const matchingServicePort = servicePorts
      .filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value))
      .find((value) => numericValue(value.port) === request.remotePort);
    if (!matchingServicePort) {
      throw new Error(`Service ${request.targetName} does not expose port ${request.remotePort}.`);
    }
    const targetPort = numericValue(matchingServicePort.targetPort)
      ?? stringValue(matchingServicePort.targetPort)
      ?? request.remotePort;

    const endpoints = asRecord(await this.call(this.core, 'readNamespacedEndpoints', {
      name: request.targetName,
      namespace: request.namespace,
    }));
    const subsets = endpoints.subsets;
    if (!Array.isArray(subsets)) {
      throw new Error(`Service ${request.targetName} has no ready Pod endpoint.`);
    }
    for (const subset of subsets) {
      if (!subset || typeof subset !== 'object' || Array.isArray(subset)) {
        continue;
      }
      const record = subset as Record<string, unknown>;
      const address = Array.isArray(record.addresses)
        ? record.addresses.find((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
          }
          const targetRef = objectValue(value, 'targetRef');
          return targetRef.kind === 'Pod' && isNonEmptyString(targetRef.name);
        })
        : undefined;
      if (!address || typeof address !== 'object' || Array.isArray(address)) {
        continue;
      }
      const endpointPorts = Array.isArray(record.ports)
        ? record.ports.filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value))
        : [];
      const endpointPort = endpointPorts.find((value) => (
        typeof targetPort === 'number'
          ? numericValue(value.port) === targetPort
          : stringValue(value.name) === targetPort
      ));
      const targetRef = objectValue(address, 'targetRef');
      const podName = stringValue(targetRef.name);
      const endpointRemotePort = endpointPort ? numericValue(endpointPort.port) : undefined;
      if (podName && isPort(endpointRemotePort)) {
        return { podName, remotePort: endpointRemotePort };
      }
    }
    throw new Error(`Service ${request.targetName} has no ready Pod endpoint for port ${request.remotePort}.`);
  }

  private assertRelatedResourceRequest(request: KubernetesRelatedResourceRequest): void {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new Error('Kubernetes related resource request is invalid.');
    }
    if (request.kind !== 'service' && request.kind !== 'deployment' && request.kind !== 'statefulset') {
      throw new Error('Kubernetes related resource kind is invalid.');
    }
    if (!isNonEmptyString(request.namespace) || !isNonEmptyString(request.name)) {
      throw new Error('Kubernetes related resource namespace and name are required.');
    }
    if (request.selector !== undefined && !isNonEmptyString(request.selector)) {
      throw new Error('Kubernetes Workload selector is required.');
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Kubernetes client is closed.');
    }
  }
}
