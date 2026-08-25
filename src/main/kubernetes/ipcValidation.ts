import type {
  KubernetesNamespaceScope,
  KubernetesPodTarget,
  KubernetesPortForwardInput,
  KubernetesRelatedResourceRequest,
  KubernetesResourceQuery,
  KubernetesVncTarget,
} from '../../shared/types';

const KUBERNETES_RESOURCE_KINDS = new Set([
  'pods', 'deployments', 'statefulsets', 'services', 'ingresses', 'configmaps',
  'secrets', 'persistentvolumeclaims', 'nodes', 'namespaces', 'custom-resources',
]);
const KUBERNETES_CUSTOM_RESOURCE_PART = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;
const KUBERNETES_CUSTOM_RESOURCE_VERSION = /^v[0-9]+(?:alpha[0-9]+|beta[0-9]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateKubernetesText(value: unknown, label: string, maximum = 16_384): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`Kubernetes ${label} is required and must be within the allowed size.`);
  }
  return value;
}

export function validateKubernetesNamespaceScope(value: unknown): KubernetesNamespaceScope {
  if (!isRecord(value) || (value.mode !== 'all' && value.mode !== 'selected') || !Array.isArray(value.namespaces)) {
    throw new Error('Kubernetes Namespace scope is invalid.');
  }
  if (value.namespaces.some((namespace) => typeof namespace !== 'string' || namespace.length > 253)) {
    throw new Error('Kubernetes Namespace names must be text within the allowed size.');
  }
  return { mode: value.mode, namespaces: [...value.namespaces] as string[] };
}

export function validateKubernetesQuery(value: unknown): KubernetesResourceQuery {
  if (!isRecord(value) || !KUBERNETES_RESOURCE_KINDS.has(value.kind as string)) {
    throw new Error('Kubernetes resource query is invalid.');
  }
  const query: KubernetesResourceQuery = {
    context: validateKubernetesText(value.context, 'Context name'),
    kind: value.kind as KubernetesResourceQuery['kind'],
    namespaceScope: validateKubernetesNamespaceScope(value.namespaceScope),
  };
  for (const field of ['apiVersion', 'plural', 'labelSelector', 'fieldSelector', 'nameFilter'] as const) {
    if (value[field] !== undefined) {
      query[field] = validateKubernetesText(value[field], field);
    }
  }
  if (value.scope !== undefined) {
    if (value.scope !== 'namespaced' && value.scope !== 'cluster') {
      throw new Error('Kubernetes resource scope is invalid.');
    }
    query.scope = value.scope;
  }
  if (value.sort !== undefined) {
    if (!isRecord(value.sort) || (value.sort.direction !== 'asc' && value.sort.direction !== 'desc')) {
      throw new Error('Kubernetes resource sort is invalid.');
    }
    query.sort = { column: validateKubernetesText(value.sort.column, 'sort column'), direction: value.sort.direction };
  }
  if (query.kind === 'custom-resources') {
    const apiVersion = validateKubernetesText(query.apiVersion, 'custom resource API version');
    const plural = validateKubernetesText(query.plural, 'custom resource plural');
    const [group, version, ...extra] = apiVersion.split('/');
    if (!group || !version || extra.length > 0 || !KUBERNETES_CUSTOM_RESOURCE_PART.test(group)
      || !KUBERNETES_CUSTOM_RESOURCE_VERSION.test(version) || !KUBERNETES_CUSTOM_RESOURCE_PART.test(plural)) {
      throw new Error('Kubernetes custom resource query is invalid.');
    }
  }
  return query;
}

export function validateKubernetesWindowRange(value: unknown): { start: number; end: number } {
  if (!isRecord(value)) {
    throw new Error('Kubernetes resource window is invalid.');
  }
  const start = value.start;
  const end = value.end;
  if (typeof start !== 'number' || typeof end !== 'number'
    || !Number.isInteger(start) || !Number.isInteger(end)
    || start < 0 || end < start || end - start > 256) {
    throw new Error('Kubernetes resource window is invalid.');
  }
  return { start, end };
}

export function validateKubernetesPodTarget(value: unknown): KubernetesPodTarget {
  if (!isRecord(value)) {
    throw new Error('Kubernetes Pod target is invalid.');
  }
  return {
    namespace: validateKubernetesText(value.namespace, 'Namespace'),
    podName: validateKubernetesText(value.podName, 'Pod name'),
    container: validateKubernetesText(value.container, 'container'),
  };
}

export function validateKubernetesVncTarget(value: unknown): KubernetesVncTarget {
  if (!isRecord(value)) {
    throw new Error('Kubernetes VNC target is invalid.');
  }
  return {
    namespace: validateKubernetesText(value.namespace, 'Namespace', 253),
    podName: validateKubernetesText(value.podName, 'Pod name', 253),
    podUid: validateKubernetesText(value.podUid, 'Pod UID', 253),
  };
}

export function validateKubernetesPortForward(value: unknown): KubernetesPortForwardInput {
  if (!isRecord(value) || (value.targetKind !== 'pod' && value.targetKind !== 'service')) {
    throw new Error('Kubernetes port forward is invalid.');
  }
  if (typeof value.remotePort !== 'number' || !Number.isInteger(value.remotePort)
    || value.remotePort < 1 || value.remotePort > 65_535) {
    throw new Error('Kubernetes remote port must be an integer between 1 and 65535.');
  }
  const input: KubernetesPortForwardInput = {
    targetKind: value.targetKind,
    namespace: validateKubernetesText(value.namespace, 'Namespace'),
    targetName: validateKubernetesText(value.targetName, 'port forward target name'),
    remotePort: value.remotePort,
  };
  if (value.localPort !== undefined) {
    if (typeof value.localPort !== 'number' || !Number.isInteger(value.localPort) || value.localPort < 0 || value.localPort > 65_535) {
      throw new Error('Kubernetes local port must be an integer between 0 and 65535.');
    }
    input.localPort = value.localPort;
  }
  return input;
}

export function validateKubernetesRelatedResourceRequest(value: unknown): KubernetesRelatedResourceRequest {
  if (!isRecord(value) || (value.kind !== 'service' && value.kind !== 'deployment' && value.kind !== 'statefulset')) {
    throw new Error('Kubernetes related resource request is invalid.');
  }
  const request: KubernetesRelatedResourceRequest = {
    kind: value.kind,
    namespace: validateKubernetesText(value.namespace, 'Namespace'),
    name: validateKubernetesText(value.name, 'resource name'),
  };
  if (value.selector !== undefined) {
    request.selector = validateKubernetesText(value.selector, 'Workload selector');
  }
  if ((request.kind === 'deployment' || request.kind === 'statefulset') && !request.selector) {
    throw new Error('Kubernetes Workload selector is required.');
  }
  return request;
}
