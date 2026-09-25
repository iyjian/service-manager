import type { KubernetesOverview, KubernetesOverviewResource, KubernetesOverviewDisk } from '../../shared/types';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function overviewValue(value: number | null, key = ''): string {
  if (value === null) return '—';
  if (key === 'memory' || key === 'ephemeral-storage' || key === 'disk') {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    const index = value > 0 ? Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(value) / Math.log(1024)))) : 0;
    return `${Number((value / 1024 ** index).toFixed(1))} ${units[index]}`;
  }
  return new Intl.NumberFormat('en', { maximumFractionDigits: 3 }).format(value);
}
const label = (key: string): string => ({ cpu: 'CPU (cores)', memory: 'Memory', 'ephemeral-storage': 'Ephemeral storage' })[key] ?? key;
function table(headers: string[], rows: string[][]): HTMLElement {
  const wrap = element('div', undefined, 'kubernetes-overview-table-wrap');
  const table = element('table', undefined, 'kubernetes-overview-table');
  const head = element('thead'), tr = element('tr');
  for (const title of headers) tr.appendChild(element('th', title));
  head.appendChild(tr); table.appendChild(head);
  const body = element('tbody');
  for (const row of rows) { const tr = element('tr'); for (const value of row) tr.appendChild(element('td', value)); body.appendChild(tr); }
  table.appendChild(body); wrap.appendChild(table); return wrap;
}
function resourceRows(resources: KubernetesOverviewResource[]): string[][] {
  return resources.map(r => [label(r.key), ...[r.capacity, r.allocatable, r.requested, r.available, r.used].map(v => overviewValue(v, r.key))]);
}
function diskRow(name: string, disk: KubernetesOverviewDisk | null): string[] {
  return [name, ...[disk?.capacity ?? null, disk?.used ?? null, disk?.available ?? null].map(v => overviewValue(v, 'disk'))];
}
export function renderKubernetesOverview(root: HTMLElement, overview: KubernetesOverview): void {
  root.replaceChildren();
  const counts = element('div', undefined, 'kubernetes-overview-counts');
  for (const entry of overview.counts) {
    const item = element('div'); item.append(element('strong', overviewValue(entry.count)), element('span', entry.label)); counts.appendChild(item);
  }
  root.appendChild(counts);
  root.appendChild(element('h3', 'Cluster resources'));
  root.appendChild(table(['Resource', 'Capacity', 'Allocatable', 'Requested', 'Remaining', 'Actual usage'], resourceRows(overview.resources)));
  root.appendChild(element('p', '— = unavailable or not reported. Remaining = allocatable − requests from active, assigned Pods. It is not live idle capacity or a scheduling guarantee. GPU values are advertised device slots (MIG/shared resources stay separate); utilization is not provided by Metrics Server.', 'kubernetes-overview-note'));
  if (!overview.resources.some(r => !['cpu', 'memory', 'ephemeral-storage'].includes(r.key))) {
    root.appendChild(element('p', overview.counts.find(c => c.label === 'Nodes')?.count === null ? 'GPU capacity is unavailable.' : 'No GPU resources advertised by nodes.', 'kubernetes-overview-note'));
  }
  root.appendChild(element('h3', 'Storage'));
  root.appendChild(table(['Node filesystems', 'Capacity', 'Used', 'Available'], [diskRow('Cluster total', overview.disk)]));
  root.appendChild(table(['Persistent volumes', 'Provisioned capacity', 'Available PV capacity', 'PVC requested'], [[
    'Cluster total', overviewValue(overview.volumes.capacity, 'disk'), overviewValue(overview.volumes.available, 'disk'), overviewValue(overview.volumes.requested, 'disk'),
  ]]));
  root.appendChild(element('p', 'Filesystem figures describe node root filesystems reported by kubelet, not every physical disk. PV capacity is provisioned storage, not disk usage; shared volumes are not added to node disk totals.', 'kubernetes-overview-note'));
  const ready = overview.nodes.filter(node => node.ready).length;
  root.appendChild(element('h3', `Nodes · ${ready} ready / ${overview.counts.find(c => c.label === 'Nodes')?.count ?? '—'}`));
  const gpuKeys = overview.resources.filter(r => !['cpu', 'memory', 'ephemeral-storage'].includes(r.key)).map(r => r.key);
  const compact = (r: KubernetesOverviewResource | undefined): string => r ? `Total ${overviewValue(r.capacity, r.key)}\nAllocatable ${overviewValue(r.allocatable, r.key)}\nRequested ${overviewValue(r.requested, r.key)} · Left ${overviewValue(r.available, r.key)}\nUsed ${overviewValue(r.used, r.key)}` : '—';
  root.appendChild(table(['Node', 'Status', 'Pods / slots', 'CPU', 'Memory', ...gpuKeys, 'Ephemeral storage', 'Filesystem'], overview.nodes.map(node => [
    node.name, `${node.ready ? 'Ready' : 'Not ready'}${node.unschedulable ? '\nCordoned' : ''}`,
    `${overviewValue(node.pods)} / ${overviewValue(node.podCapacity)}`,
    ...['cpu', 'memory', ...gpuKeys, 'ephemeral-storage'].map(key => compact(node.resources.find(r => r.key === key))),
    node.disk ? `Total ${overviewValue(node.disk.capacity, 'disk')}\nUsed ${overviewValue(node.disk.used, 'disk')}\nAvailable ${overviewValue(node.disk.available, 'disk')}` : node.diskError ?? 'Unavailable',
  ])));
  if (overview.issues.length) {
    const issues = element('details', undefined, 'kubernetes-overview-issues'); issues.open = true;
    issues.appendChild(element('summary', `Partial data · ${overview.issues.length} notices`));
    for (const message of overview.issues) issues.appendChild(element('div', message));
    root.appendChild(issues);
  }
}
