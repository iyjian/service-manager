import type {
  KubernetesPodEnvironment,
  KubernetesPodEnvironmentEntry,
  KubernetesPodEnvironmentUnavailable,
  KubernetesPodTarget,
  KubernetesResourceSummary,
} from '../shared/types';

export interface KubernetesDrawerContainer {
  name: string;
  init: boolean;
  target: KubernetesPodTarget;
  status: string;
  image: string;
  imagePullPolicy: string;
  mounts: string;
  command: string;
  environmentDeclared: boolean;
}

export interface KubernetesPodDrawerModel {
  header: Array<[string, string]>;
  labels: Array<[string, string]>;
  containers: KubernetesDrawerContainer[];
}

/** Display-only KubeVirt identity. Main re-reads and validates the Pod before opening VNC. */
export interface KubernetesVncLauncherTarget {
  namespace: string;
  podName: string;
  podUid: string;
  vmiName: string;
}

const ENVIRONMENT_UNAVAILABLE_LABELS: Record<KubernetesPodEnvironmentUnavailable, string> = {
  missing: 'Referenced value is missing',
  'no-permission': 'Value unavailable',
  unsupported: 'Value cannot be resolved',
  'too-large': 'Value omitted for safe display',
};

/** Keeps active-drawer filtering local to the already-held bounded result. */
export function filterKubernetesEnvironmentEntries(
  entries: readonly KubernetesPodEnvironmentEntry[],
  search: string,
): KubernetesPodEnvironmentEntry[] {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return [...entries];
  return entries.filter((entry) => [
    entry.name,
    entry.source,
    entry.reference ?? '',
    entry.value ?? '',
  ].some((value) => value.toLocaleLowerCase().includes(query)));
}

export function environmentUnavailableLabel(unavailable: KubernetesPodEnvironmentUnavailable | undefined): string {
  return unavailable ? ENVIRONMENT_UNAVAILABLE_LABELS[unavailable] : 'Value unavailable';
}

/**
 * Keeps declared Env available for its lazy read, but hides a definitively
 * empty result without suppressing permission or truncation notices.
 */
export function shouldRenderKubernetesEnvironment(
  environmentDeclared: boolean,
  result?: KubernetesPodEnvironment,
): boolean {
  if (!environmentDeclared) return false;
  if (!result) return true;
  return result.entries.length > 0 || result.permissionDenied || result.truncated;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function array(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const itemRecord = record(item);
    return itemRecord ? [itemRecord] : [];
  });
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Identifies a KubeVirt-owned virt-launcher Pod without trusting its generated
 * name alone. The renderer uses this only to decide whether to show the VNC
 * action; the main process remains authoritative for opening the connection.
 */
export function detectKubeVirtVncTarget(detail: Record<string, unknown>): KubernetesVncLauncherTarget | undefined {
  const metadata = record(detail.metadata);
  const status = record(detail.status);
  const labels = record(metadata?.labels);
  const annotations = record(metadata?.annotations);
  const deleting = metadata?.deletionTimestamp !== undefined && metadata.deletionTimestamp !== null;
  if (text(status?.phase) !== 'Running'
    || deleting
    || text(labels?.['kubevirt.io']) !== 'virt-launcher') return undefined;

  const controllerOwners = array(metadata?.ownerReferences).filter((candidate) => candidate.controller === true);
  if (controllerOwners.length !== 1) return undefined;
  const owner = controllerOwners[0];
  if (text(owner.apiVersion) !== 'kubevirt.io/v1'
    || text(owner.kind) !== 'VirtualMachineInstance') return undefined;
  const vmiName = text(owner.name);
  const vmiUid = text(owner.uid);
  if (!vmiName || !vmiUid) return undefined;

  const createdBy = text(labels?.['kubevirt.io/created-by']);
  if (createdBy !== vmiUid) return undefined;

  const declaredNames = [
    text(labels?.['vm.kubevirt.io/name']),
    text(annotations?.['kubevirt.io/domain']),
  ].filter((value): value is string => Boolean(value));
  if (declaredNames.length === 0 || declaredNames.some((name) => name !== vmiName)) return undefined;

  const namespace = text(metadata?.namespace);
  const podName = text(metadata?.name);
  const podUid = text(metadata?.uid);
  if (!namespace || !podName || !podUid) return undefined;
  return { namespace, podName, podUid, vmiName };
}

function statusByName(value: unknown): Map<string, Record<string, unknown>> {
  const statuses = new Map<string, Record<string, unknown>>();
  for (const item of array(value)) {
    const name = text(item.name);
    if (name) statuses.set(name, item);
  }
  return statuses;
}

function containerStatusText(status: Record<string, unknown> | undefined): string {
  const state = record(status?.state);
  if (record(state?.running)) return 'Running';
  const waiting = record(state?.waiting);
  if (waiting) return `Waiting: ${text(waiting.reason) ?? 'Unknown'}`;
  const terminated = record(state?.terminated);
  if (terminated) return `Terminated: ${text(terminated.reason) ?? 'Unknown'}`;
  return 'Unknown';
}

function containerStartedAt(status: Record<string, unknown> | undefined): string | undefined {
  const state = record(status?.state);
  const raw = text(record(state?.running)?.startedAt) ?? text(record(state?.terminated)?.startedAt);
  if (!raw) return undefined;
  const timestamp = new Date(raw);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}

function toContainer(
  container: Record<string, unknown>,
  init: boolean,
  status: Record<string, unknown> | undefined,
  namespace: string,
  podName: string,
): KubernetesDrawerContainer {
  const name = text(container.name) ?? 'Unnamed container';
  const startedAt = containerStartedAt(status);
  const command = [...strings(container.command), ...strings(container.args)].join(' ') || '—';
  const mounts = array(container.volumeMounts)
    .flatMap((item) => {
      const mountPath = text(item.mountPath);
      return mountPath ? [mountPath] : [];
    })
    .join(', ') || '—';
  return {
    name,
    init,
    target: {
      namespace,
      podName,
      container: name,
      ...(startedAt ? { containerStartedAt: startedAt } : {}),
    },
    status: containerStatusText(status),
    image: text(container.image) ?? '—',
    imagePullPolicy: text(container.imagePullPolicy) ?? 'Default',
    mounts,
    command,
    // The drawer deliberately exposes only whether Env was declared. It does
    // not inspect values or references, which could expose Secret data.
    environmentDeclared: array(container.env).length > 0 || array(container.envFrom).length > 0,
  };
}

function buildContainers(
  spec: Record<string, unknown> | undefined,
  status: Record<string, unknown> | undefined,
  namespace: string,
  podName: string,
): KubernetesDrawerContainer[] {
  const normalStatuses = statusByName(status?.containerStatuses);
  const initStatuses = statusByName(status?.initContainerStatuses);
  const normal = array(spec?.containers).map((container) => {
    const name = text(container.name);
    return toContainer(container, false, name ? normalStatuses.get(name) : undefined, namespace, podName);
  });
  const init = array(spec?.initContainers).map((container) => {
    const name = text(container.name);
    return toContainer(container, true, name ? initStatuses.get(name) : undefined, namespace, podName);
  });
  return [...normal, ...init];
}

export function buildKubernetesDrawerModel(
  detail: Record<string, unknown>,
  fallback: Pick<KubernetesResourceSummary, 'name' | 'namespace' | 'status'>,
): KubernetesPodDrawerModel {
  const metadata = record(detail.metadata);
  const spec = record(detail.spec);
  const status = record(detail.status);
  const name = text(metadata?.name) ?? fallback.name;
  const namespace = text(metadata?.namespace) ?? fallback.namespace ?? '—';
  const podIPs = array(status?.podIPs).flatMap((item) => {
    const ip = text(item.ip);
    return ip ? [ip] : [];
  });
  return {
    header: [
      ['Name', name],
      ['Namespace', namespace],
      ['Status', text(status?.phase) ?? fallback.status ?? '—'],
      ['Node', text(spec?.nodeName) ?? '—'],
      ['Pod IP', text(status?.podIP) ?? '—'],
      ['Pod IPs', podIPs.length > 0 ? podIPs.join(', ') : '—'],
    ],
    labels: Object.entries(record(metadata?.labels) ?? {})
      .map(([key, value]) => [key, text(value) ?? ''] as [string, string])
      .sort(([left], [right]) => left.localeCompare(right)),
    containers: buildContainers(spec, status, namespace, name),
  };
}
