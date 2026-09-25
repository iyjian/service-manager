import type { KubernetesOverview, KubernetesOverviewNode, KubernetesOverviewResource } from '../../shared/types';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const array = (value: unknown): RecordValue[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
export function overviewQuantity(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || value.length > 128) return null;
  const match = /^\+?(\d+(?:\.\d*)?|\.\d+)([eE][+-]?\d+|[KMGTPE]i|[numkMGTPE])?$/.exec(value);
  if (!match) return null;
  const suffix = match[2] ?? '';
  const scale: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
  const multiplier = suffix.endsWith('i') ? 1024 ** ('KMGTPE'.indexOf(suffix[0]) + 1)
    : /^[eE][+-]?\d+$/.test(suffix) ? 10 ** Number(suffix.slice(1)) : scale[suffix] ?? 1;
  const result = Number(match[1]) * multiplier;
  return Number.isFinite(result) && result >= 0 ? result : null;
}

/** Scheduler-style effective requests, including restartable init containers and overhead. */
export function podOverviewRequests(pod: RecordValue): Record<string, number> {
  const spec = record(pod.spec);
  const requests = (container: RecordValue): Record<string, number> => {
    const resources = record(container.resources), req = record(resources.requests), limits = record(resources.limits);
    return Object.fromEntries([...new Set([...Object.keys(req), ...Object.keys(limits)])]
      .map(key => [key, overviewQuantity(req[key] ?? limits[key]) ?? 0]));
  };
  const result: Record<string, number> = {}, sidecars: Record<string, number> = {}, initPeak: Record<string, number> = {};
  const add = (target: Record<string, number>, source: Record<string, number>): void => {
    for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
  };
  for (const container of array(spec.containers)) add(result, requests(container));
  for (const container of array(spec.initContainers)) {
    const req = requests(container);
    if (container.restartPolicy === 'Always') { add(sidecars, req); add(result, req); }
    const effective = { ...sidecars };
    if (container.restartPolicy !== 'Always') add(effective, req);
    for (const [key, value] of Object.entries(effective)) initPeak[key] = Math.max(initPeak[key] ?? 0, value);
  }
  for (const [key, value] of Object.entries(initPeak)) result[key] = Math.max(result[key] ?? 0, value);
  // Pod-level CPU/memory budgets override container-level effective requests.
  const podRequests = requests(spec);
  for (const key of ['cpu', 'memory']) if (key in podRequests) result[key] = podRequests[key];
  for (const [key, value] of Object.entries(record(spec.overhead))) result[key] = (result[key] ?? 0) + (overviewQuantity(value) ?? 0);
  return result;
}

export type OverviewRead = (group: string, method: string, params: RecordValue, signal: AbortSignal) => Promise<unknown>;
const SOURCES = [
  ['Nodes', 'core', 'listNode'], ['Pods', 'core', 'listPodForAllNamespaces'],
  ['Namespaces', 'core', 'listNamespace'], ['Deployments', 'apps', 'listDeploymentForAllNamespaces'],
  ['StatefulSets', 'apps', 'listStatefulSetForAllNamespaces'], ['DaemonSets', 'apps', 'listDaemonSetForAllNamespaces'],
  ['ReplicaSets', 'apps', 'listReplicaSetForAllNamespaces'], ['Jobs', 'batch', 'listJobForAllNamespaces'],
  ['CronJobs', 'batch', 'listCronJobForAllNamespaces'], ['Services', 'core', 'listServiceForAllNamespaces'],
  ['Ingresses', 'networking', 'listIngressForAllNamespaces'], ['ConfigMaps', 'core', 'listConfigMapForAllNamespaces'],
  ['Secrets', 'core', 'listSecretForAllNamespaces'], ['PVCs', 'core', 'listPersistentVolumeClaimForAllNamespaces'],
  ['PVs', 'core', 'listPersistentVolume'], ['StorageClasses', 'storage', 'listStorageClass'],
  ['CRDs', 'extensions', 'listCustomResourceDefinition'],
] as const;

async function workers<T>(items: T[], action: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (index < items.length) await action(items[index++]);
  }));
}
function unavailable(error: unknown): string {
  const e = record(error), status = e.code ?? e.statusCode ?? record(e.response).statusCode;
  return status === 403 || status === 401 ? 'No permission' : status === 404 ? 'Not available' : 'Unavailable or timed out';
}
const sum = (values: Array<number | null>): number | null => values.some(v => v === null) ? null : values.reduce<number>((a, b) => a + (b ?? 0), 0);

export async function collectKubernetesOverview(read: OverviewRead, signal: AbortSignal): Promise<KubernetesOverview> {
  const issues: string[] = [], counts: KubernetesOverview['counts'] = [], saved = new Map<string, RecordValue[]>();
  const boundedRead = async (group: string, method: string, params: RecordValue): Promise<unknown> => {
    signal.throwIfAborted();
    const controller = new AbortController(), cancel = (): void => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 6000);
    try { return await read(group, method, params, controller.signal); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  };
  await workers([...SOURCES], async ([label, group, method]) => {
    let count = 0, next = '', items: RecordValue[] = [];
    const retain = ['Nodes', 'Pods', 'PVs', 'PVCs'].includes(label), seen = new Set<string>();
    try {
      do {
        const page = record(await boundedRead(group, method, { limit: 500, ...(next ? { _continue: next } : {}) }));
        if (!Array.isArray(page.items)) throw new Error('Invalid list');
        if (page.items.length > 10000 || (retain && count + page.items.length > 10000)) { count = 10000; throw new Error('List limit'); }
        const entries = array(page.items); count += entries.length;
        if (retain) items.push(...entries);
        const metadata = record(page.metadata);
        next = text(metadata._continue ?? metadata.continue);
        const remaining = metadata.remainingItemCount;
        if (!retain && typeof remaining === 'number' && Number.isSafeInteger(remaining) && remaining >= 0) { count += remaining; next = ''; }
        if (next && (seen.has(next) || count >= 10000 || seen.size >= 100)) throw new Error('List limit');
        seen.add(next);
      } while (next);
      counts.push({ label, count });
      if (retain) saved.set(label, items);
    } catch (error) {
      if (signal.aborted) throw error;
      const reason = count >= 10000 ? 'Too many resources to aggregate safely' : unavailable(error);
      counts.push({ label, count: null }); issues.push(`${label}: ${reason}.`);
    }
  });
  counts.sort((a, b) => SOURCES.findIndex(s => s[0] === a.label) - SOURCES.findIndex(s => s[0] === b.label));
  const metrics = new Map<string, RecordValue>();
  try {
    const response = record(await boundedRead('custom', 'listClusterCustomObject', { group: 'metrics.k8s.io', version: 'v1beta1', plural: 'nodes' }));
    for (const metric of array(response.items)) metrics.set(text(record(metric.metadata).name), record(metric.usage));
  } catch (error) { if (signal.aborted) throw error; issues.push(`CPU / memory usage: ${unavailable(error)} (metrics.k8s.io).`); }
  const pods = saved.get('Pods'), nodesRaw = saved.get('Nodes');
  const assigned = new Map<string, { count: number; requests: Record<string, number> }>();
  for (const pod of pods ?? []) {
    if (['Succeeded', 'Failed'].includes(text(record(pod.status).phase))) continue;
    const node = text(record(pod.spec).nodeName); if (!node) continue;
    const state = assigned.get(node) ?? { count: 0, requests: {} }; state.count++;
    for (const [key, value] of Object.entries(podOverviewRequests(pod))) state.requests[key] = (state.requests[key] ?? 0) + value;
    assigned.set(node, state);
  }
  const gpuKeys = new Set<string>();
  for (const node of nodesRaw ?? []) for (const key of Object.keys(record(record(node.status).capacity))) {
    if (/^(?:gpu\.[^/]+\/(?:i915|xe)|[^/]+\/(?:.*gpu.*|mig-.+))$/i.test(key)) gpuKeys.add(key);
  }
  const keys = ['cpu', 'memory', 'ephemeral-storage', ...[...gpuKeys].sort()];
  const nodes: KubernetesOverviewNode[] = (nodesRaw ?? []).map(node => {
    const metadata = record(node.metadata), status = record(node.status), spec = record(node.spec);
    const name = text(metadata.name), capacity = record(status.capacity), allocatable = record(status.allocatable);
    const ready = array(status.conditions).find(c => c.type === 'Ready')?.status === 'True';
    const resources: KubernetesOverviewResource[] = keys.map(key => {
      const gpu = gpuKeys.has(key), total = overviewQuantity(capacity[key]) ?? (gpu ? 0 : null);
      const availableCapacity = overviewQuantity(allocatable[key]) ?? (gpu && total === 0 ? 0 : null);
      const requested = pods ? assigned.get(name)?.requests[key] ?? 0 : null;
      return { key, capacity: total, allocatable: availableCapacity, requested,
        available: availableCapacity !== null && requested !== null ? Math.max(0, availableCapacity - requested) : null,
        used: overviewQuantity(metrics.get(name)?.[key]) };
    });
    return { name, ready, unschedulable: spec.unschedulable === true, pods: pods ? assigned.get(name)?.count ?? 0 : null,
      podCapacity: overviewQuantity(allocatable.pods), resources, disk: null };
  }).sort((a, b) => a.name.localeCompare(b.name));
  // Kubelet summary describes the node filesystem, not all physical disks or network PVs.
  await workers(nodes.slice(0, 200), async node => {
    try {
      const raw = await boundedRead('core', 'connectGetNodeProxyWithPath', { name: node.name, path: 'stats/summary' });
      const fs = record(record(record(typeof raw === 'string' ? JSON.parse(raw) : raw).node).fs);
      const capacity = overviewQuantity(fs.capacityBytes), used = overviewQuantity(fs.usedBytes), available = overviewQuantity(fs.availableBytes);
      if (capacity === null || used === null || available === null) throw new Error('No filesystem metrics');
      node.disk = { capacity, used, available };
    } catch (error) { if (signal.aborted) throw error; node.diskError = unavailable(error); }
  });
  if (nodes.length > 200) issues.push('Node filesystem metrics are limited to the first 200 nodes.');
  if (nodes.some(n => !n.disk)) issues.push('Some node filesystem metrics are unavailable; nodes/proxy access and kubelet stats are required.');
  const resources = keys.map(key => {
    const rows = nodes.map(n => n.resources.find(r => r.key === key)!);
    const total = (field: keyof Omit<KubernetesOverviewResource, 'key'>): number | null => nodesRaw ? sum(rows.map(row => row[field])) : null;
    return { key, capacity: total('capacity'), allocatable: total('allocatable'), requested: total('requested'), available: total('available'), used: total('used') };
  });
  const pvs = saved.get('PVs'), pvcs = saved.get('PVCs');
  return { updatedAt: new Date().toISOString(), counts, nodes, resources, issues,
    disk: nodesRaw && nodes.every(n => n.disk) ? {
      capacity: sum(nodes.map(n => n.disk!.capacity))!, used: sum(nodes.map(n => n.disk!.used))!, available: sum(nodes.map(n => n.disk!.available))!,
    } : null,
    volumes: {
      capacity: pvs ? sum(pvs.map(p => overviewQuantity(record(record(p.spec).capacity).storage))) : null,
      available: pvs ? sum(pvs.filter(p => record(p.status).phase === 'Available').map(p => overviewQuantity(record(record(p.spec).capacity).storage))) : null,
      requested: pvcs ? sum(pvcs.map(p => overviewQuantity(record(record(record(p.spec).resources).requests).storage))) : null,
    } };
}
