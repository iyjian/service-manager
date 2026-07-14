import type { KubernetesPodTarget, KubernetesResourceSummary } from '../shared/types';

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

function toContainer(
  container: Record<string, unknown>,
  init: boolean,
  status: Record<string, unknown> | undefined,
  namespace: string,
  podName: string,
): KubernetesDrawerContainer {
  const name = text(container.name) ?? 'Unnamed container';
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
    target: { namespace, podName, container: name },
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
