import type { KubernetesResourceKind, KubernetesResourceSummary } from '../shared/types';

type UnknownRecord = Record<string, unknown>;

export type KubernetesBuiltinDetailKind = Extract<
  KubernetesResourceKind,
  'deployments' | 'statefulsets' | 'services' | 'ingresses' | 'configmaps' | 'secrets' | 'persistentvolumeclaims'
>;

const KUBERNETES_BUILTIN_DETAIL_KINDS = new Set<KubernetesResourceKind>([
  'deployments',
  'statefulsets',
  'services',
  'ingresses',
  'configmaps',
  'secrets',
  'persistentvolumeclaims',
]);

export function isKubernetesBuiltinDetailKind(kind: KubernetesResourceKind): kind is KubernetesBuiltinDetailKind {
  return KUBERNETES_BUILTIN_DETAIL_KINDS.has(kind);
}

export interface KubernetesBuiltinDetailProperty {
  label: string;
  value: string;
}

export interface KubernetesBuiltinDetailCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface KubernetesBuiltinDetailPairsSection {
  kind: 'pairs';
  key: string;
  title: string;
  initiallyExpanded: boolean;
  entries: Array<[string, string]>;
}

export interface KubernetesBuiltinDetailTableSection {
  kind: 'table';
  key: string;
  title: string;
  initiallyExpanded: boolean;
  columns: string[];
  rows: string[][];
  multilineColumn?: number;
}

export interface KubernetesBuiltinDetailConditionsSection {
  kind: 'conditions';
  key: string;
  title: string;
  initiallyExpanded: boolean;
  conditions: KubernetesBuiltinDetailCondition[];
}

export type KubernetesBuiltinDetailSection =
  | KubernetesBuiltinDetailPairsSection
  | KubernetesBuiltinDetailTableSection
  | KubernetesBuiltinDetailConditionsSection;

export interface KubernetesBuiltinDetailModel {
  properties: KubernetesBuiltinDetailProperty[];
  labels: Array<[string, string]>;
  annotations: Array<[string, string]>;
  sections: KubernetesBuiltinDetailSection[];
}

const MAX_METADATA_ENTRIES = 100;
const MAX_TABLE_ROWS = 100;
const MAX_CONDITIONS = 24;
const MAX_DISPLAY_VALUE_LENGTH = 16_384;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function records(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const item = record(candidate);
    return item ? [item] : [];
  });
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return undefined;
}

function entryText(value: unknown): string | undefined {
  if (value === '') return '(empty)';
  return text(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((candidate) => {
      const item = text(candidate);
      return item ? [item] : [];
    })
    : [];
}

function boundedValue(value: string): string {
  if (value.length <= MAX_DISPLAY_VALUE_LENGTH) return value;
  return `${value.slice(0, MAX_DISPLAY_VALUE_LENGTH)}\n… value truncated for display`;
}

function mapEntries(value: unknown): Array<[string, string]> {
  const source = record(value);
  if (!source) return [];
  const entries = Object.entries(source)
    .flatMap(([key, candidate]) => {
      const valueText = entryText(candidate);
      return valueText === undefined ? [] : [[key, boundedValue(valueText)] as [string, string]];
    })
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length <= MAX_METADATA_ENTRIES) return entries;
  const visible = entries.slice(0, MAX_METADATA_ENTRIES - 1);
  visible.push(['…', `+${entries.length - visible.length} more`]);
  return visible;
}

function annotationEntries(value: unknown): Array<[string, string]> {
  return mapEntries(value).filter(([key]) => key !== 'kubectl.kubernetes.io/last-applied-configuration');
}

function valueOrDash(value: unknown): string {
  return text(value) ?? '—';
}

function joinOrDash(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '—';
}

function property(label: string, value: unknown): KubernetesBuiltinDetailProperty {
  return { label, value: valueOrDash(value) };
}

function commonProperties(
  detail: UnknownRecord,
  fallback: Pick<KubernetesResourceSummary, 'name' | 'namespace' | 'createdAt'>,
): KubernetesBuiltinDetailProperty[] {
  const metadata = record(detail.metadata);
  return [
    property('Name', text(metadata?.name) ?? fallback.name),
    property('Namespace', text(metadata?.namespace) ?? fallback.namespace),
    property('Created', text(metadata?.creationTimestamp) ?? fallback.createdAt),
  ];
}

function selectorEntries(value: unknown): Array<[string, string]> {
  const selector = record(value);
  if (!selector) return [];
  const entries = mapEntries(selector.matchLabels);
  for (const expression of records(selector.matchExpressions)) {
    const key = text(expression.key);
    const operator = text(expression.operator);
    if (!key || !operator) continue;
    const values = stringList(expression.values);
    entries.push([key, values.length > 0 ? `${operator} (${values.join(', ')})` : operator]);
  }
  return entries.slice(0, MAX_METADATA_ENTRIES);
}

function conditions(value: unknown): KubernetesBuiltinDetailCondition[] {
  return records(record(value)?.conditions)
    .flatMap((condition) => {
      const type = text(condition.type);
      const status = text(condition.status);
      if (!type || !status) return [];
      return [{
        type,
        status,
        ...(text(condition.reason) ? { reason: text(condition.reason) } : {}),
        ...(text(condition.message) ? { message: boundedValue(text(condition.message) as string) } : {}),
        ...(text(condition.lastTransitionTime) ? { lastTransitionTime: text(condition.lastTransitionTime) } : {}),
      }];
    })
    .slice(0, MAX_CONDITIONS);
}

function conditionsSection(status: unknown): KubernetesBuiltinDetailConditionsSection | undefined {
  const values = conditions(status);
  return values.length > 0 ? {
    kind: 'conditions',
    key: 'conditions',
    title: 'Conditions',
    initiallyExpanded: false,
    conditions: values,
  } : undefined;
}

function pairsSection(
  key: string,
  title: string,
  entries: Array<[string, string]>,
  initiallyExpanded = false,
): KubernetesBuiltinDetailPairsSection | undefined {
  return entries.length > 0 ? { kind: 'pairs', key, title, entries, initiallyExpanded } : undefined;
}

function tableSection(
  key: string,
  title: string,
  columns: string[],
  rows: string[][],
  initiallyExpanded: boolean,
  multilineColumn?: number,
): KubernetesBuiltinDetailTableSection | undefined {
  const visibleRows = rows.length <= MAX_TABLE_ROWS
    ? rows
    : [
      ...rows.slice(0, MAX_TABLE_ROWS - 1),
      columns.map((_, index) => index === 0
        ? '…'
        : index === 1
          ? `+${rows.length - (MAX_TABLE_ROWS - 1)} more`
          : ''),
    ];
  return rows.length > 0 ? {
    kind: 'table',
    key,
    title,
    columns,
    rows: visibleRows,
    initiallyExpanded,
    ...(multilineColumn === undefined ? {} : { multilineColumn }),
  } : undefined;
}

function compactSections(
  sections: Array<KubernetesBuiltinDetailSection | undefined>,
): KubernetesBuiltinDetailSection[] {
  return sections.filter((section): section is KubernetesBuiltinDetailSection => Boolean(section));
}

function containerImageRows(template: unknown): string[][] {
  const podSpec = record(record(template)?.spec);
  return [
    ...records(podSpec?.containers).map((container) => [
      text(container.name) ?? 'Unnamed container',
      valueOrDash(container.image),
      'Container',
    ]),
    ...records(podSpec?.initContainers).map((container) => [
      text(container.name) ?? 'Unnamed container',
      valueOrDash(container.image),
      'Init',
    ]),
  ];
}

function deploymentModel(
  detail: UnknownRecord,
  fallback: Pick<KubernetesResourceSummary, 'name' | 'namespace' | 'createdAt'>,
): KubernetesBuiltinDetailModel {
  const metadata = record(detail.metadata);
  const spec = record(detail.spec);
  const status = record(detail.status);
  const desired = numberValue(spec?.replicas) ?? 1;
  const properties = [
    ...commonProperties(detail, fallback),
    property('Ready', `${numberValue(status?.readyReplicas) ?? 0} / ${desired}`),
    property('Updated', numberValue(status?.updatedReplicas) ?? 0),
    property('Available', numberValue(status?.availableReplicas) ?? 0),
    property('Unavailable', numberValue(status?.unavailableReplicas) ?? 0),
    property('Strategy', text(record(spec?.strategy)?.type) ?? 'RollingUpdate'),
  ];
  return {
    properties,
    labels: mapEntries(metadata?.labels),
    annotations: annotationEntries(metadata?.annotations),
    sections: compactSections([
      pairsSection('selector', 'Selector', selectorEntries(spec?.selector)),
      tableSection('images', 'Images', ['Container', 'Image', 'Type'], containerImageRows(record(spec?.template)), false),
      conditionsSection(status),
    ]),
  };
}

function statefulSetModel(
  detail: UnknownRecord,
  fallback: Pick<KubernetesResourceSummary, 'name' | 'namespace' | 'createdAt'>,
): KubernetesBuiltinDetailModel {
  const metadata = record(detail.metadata);
  const spec = record(detail.spec);
  const status = record(detail.status);
  const desired = numberValue(spec?.replicas) ?? 1;
  return {
    properties: [
      ...commonProperties(detail, fallback),
      property('Ready', `${numberValue(status?.readyReplicas) ?? 0} / ${desired}`),
      property('Current', numberValue(status?.currentReplicas) ?? 0),
      property('Updated', numberValue(status?.updatedReplicas) ?? 0),
      property('Service', spec?.serviceName),
      property('Strategy', text(record(spec?.updateStrategy)?.type) ?? 'RollingUpdate'),
      property('Pod management', text(spec?.podManagementPolicy) ?? 'OrderedReady'),
    ],
    labels: mapEntries(metadata?.labels),
    annotations: annotationEntries(metadata?.annotations),
    sections: compactSections([
      pairsSection('selector', 'Selector', selectorEntries(spec?.selector)),
      tableSection('images', 'Images', ['Container', 'Image', 'Type'], containerImageRows(record(spec?.template)), false),
      conditionsSection(status),
    ]),
  };
}

function serviceExternalAddresses(spec: UnknownRecord | undefined, status: UnknownRecord | undefined): string[] {
  const loadBalancer = record(status?.loadBalancer);
  const loadBalancerAddresses = records(loadBalancer?.ingress).flatMap((entry) => {
    const address = text(entry.ip) ?? text(entry.hostname);
    return address ? [address] : [];
  });
  return [...new Set([
    ...stringList(spec?.externalIPs),
    ...(text(spec?.loadBalancerIP) ? [text(spec?.loadBalancerIP) as string] : []),
    ...loadBalancerAddresses,
  ])];
}

function servicePortRows(spec: UnknownRecord | undefined): string[][] {
  return records(spec?.ports).map((port) => {
    const targetPort = text(port.targetPort) ?? text(port.port) ?? '—';
    return [
      text(port.name) ?? '—',
      valueOrDash(port.port),
      targetPort,
      text(port.nodePort) ?? '—',
      text(port.protocol) ?? 'TCP',
    ];
  });
}

function serviceModel(
  detail: UnknownRecord,
  fallback: Pick<KubernetesResourceSummary, 'name' | 'namespace' | 'createdAt'>,
): KubernetesBuiltinDetailModel {
  const metadata = record(detail.metadata);
  const spec = record(detail.spec);
  const status = record(detail.status);
  const clusterIPs = stringList(spec?.clusterIPs);
  if (clusterIPs.length === 0 && text(spec?.clusterIP)) clusterIPs.push(text(spec?.clusterIP) as string);
  const properties = [
    ...commonProperties(detail, fallback),
    property('Type', text(spec?.type) ?? 'ClusterIP'),
    property('Cluster IPs', joinOrDash(clusterIPs)),
    property('External IPs', joinOrDash(serviceExternalAddresses(spec, status))),
  ];
  if (text(spec?.externalName)) properties.push(property('External name', spec?.externalName));
  const sessionAffinity = text(spec?.sessionAffinity);
  if (sessionAffinity && sessionAffinity !== 'None') {
    properties.push(property('Session affinity', sessionAffinity));
  }
  return {
    properties,
    labels: mapEntries(metadata?.labels),
    annotations: annotationEntries(metadata?.annotations),
    sections: compactSections([
      tableSection('ports', 'Ports', ['Name', 'Port', 'Target', 'Node', 'Protocol'], servicePortRows(spec), true),
      pairsSection('selector', 'Selector', mapEntries(spec?.selector)),
    ]),
  };
}

function ingressBackend(value: unknown): string {
  const backend = record(value);
  if (!backend) return '—';
  const service = record(backend.service);
  const serviceName = text(service?.name) ?? text(backend.serviceName);
  const servicePort = record(service?.port);
  const port = text(servicePort?.name) ?? text(servicePort?.number) ?? text(backend.servicePort);
  if (!serviceName) return '—';
  return port ? `${serviceName}:${port}` : serviceName;
}

function ingressRuleRows(spec: UnknownRecord | undefined): string[][] {
  const rows: string[][] = [];
  const defaultBackend = spec?.defaultBackend ?? spec?.backend;
  if (record(defaultBackend)) rows.push(['*', 'Default', '—', ingressBackend(defaultBackend)]);
  for (const rule of records(spec?.rules)) {
    const host = text(rule.host) ?? '*';
    const http = record(rule.http);
    for (const path of records(http?.paths)) {
      rows.push([
        host,
        text(path.path) ?? '/',
        text(path.pathType) ?? '—',
        ingressBackend(path.backend),
      ]);
    }
  }
  return rows;
}

function ingressTlsRows(spec: UnknownRecord | undefined): string[][] {
  return records(spec?.tls).map((entry) => [
    joinOrDash(stringList(entry.hosts)),
    text(entry.secretName) ?? '—',
  ]);
}

function ingressAddresses(status: UnknownRecord | undefined): string[] {
  return records(record(status?.loadBalancer)?.ingress).flatMap((entry) => {
    const address = text(entry.ip) ?? text(entry.hostname);
    return address ? [address] : [];
  });
}

function ingressModel(
  detail: UnknownRecord,
  fallback: Pick<KubernetesResourceSummary, 'name' | 'namespace' | 'createdAt'>,
): KubernetesBuiltinDetailModel {
  const metadata = record(detail.metadata);
  const annotations = record(metadata?.annotations);
  const spec = record(detail.spec);
  const status = record(detail.status);
  const ruleRows = ingressRuleRows(spec);
  const tlsRows = ingressTlsRows(spec);
  return {
    properties: [
      ...commonProperties(detail, fallback),
      property('Class', text(spec?.ingressClassName) ?? text(annotations?.['kubernetes.io/ingress.class'])),
      property('Address', joinOrDash(ingressAddresses(status))),
      property('Ports', tlsRows.length > 0 ? '80, 443' : ruleRows.length > 0 ? '80' : '—'),
      property('TLS', tlsRows.length > 0 ? `${tlsRows.length} configuration${tlsRows.length === 1 ? '' : 's'}` : '—'),
    ],
    labels: mapEntries(metadata?.labels),
    annotations: annotationEntries(metadata?.annotations),
    sections: compactSections([
      tableSection('rules', 'Rules', ['Host', 'Path', 'Type', 'Backend'], ruleRows, true),
      tableSection('tls', 'TLS', ['Hosts', 'Secret'], tlsRows, false),
    ]),
  };
}

function dataRows(value: unknown): string[][] {
  return mapEntries(value).map(([key, item]) => [key, item]);
}

function approximateBase64Bytes(value: string): number {
  const normalized = value.replace(/\s/g, '');
  if (!normalized) return 0;
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

function binaryDataRows(value: unknown): string[][] {
  const source = record(value);
  if (!source) return [];
  const entries = Object.entries(source)
    .flatMap(([key, candidate]) => typeof candidate === 'string'
      ? [[key, formatBytes(approximateBase64Bytes(candidate))]]
      : [])
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length <= MAX_TABLE_ROWS) return entries;
  const visible = entries.slice(0, MAX_TABLE_ROWS - 1);
  visible.push(['…', `+${entries.length - visible.length} more`]);
  return visible;
}

function configMapModel(
  detail: UnknownRecord,
  fallback: Pick<KubernetesResourceSummary, 'name' | 'namespace' | 'createdAt'>,
): KubernetesBuiltinDetailModel {
  const metadata = record(detail.metadata);
  const data = record(detail.data);
  const binaryData = record(detail.binaryData);
  return {
    properties: [
      ...commonProperties(detail, fallback),
      property('Immutable', detail.immutable === true ? 'Yes' : 'No'),
      property('Data entries', Object.keys(data ?? {}).length),
      property('Binary entries', Object.keys(binaryData ?? {}).length),
    ],
    labels: mapEntries(metadata?.labels),
    annotations: annotationEntries(metadata?.annotations),
    sections: compactSections([
      tableSection('data', 'Data', ['Key', 'Value'], dataRows(data), false, 1),
      tableSection('binary-data', 'Binary Data', ['Key', 'Decoded size'], binaryDataRows(binaryData), false),
    ]),
  };
}

function secretModel(
  detail: UnknownRecord,
  fallback: Pick<KubernetesResourceSummary, 'name' | 'namespace' | 'createdAt'>,
): KubernetesBuiltinDetailModel {
  const metadata = record(detail.metadata);
  const data = record(detail.data);
  return {
    properties: [
      ...commonProperties(detail, fallback),
      property('Type', detail.type),
      property('Data entries', Object.keys(data ?? {}).length),
      property('Immutable', detail.immutable === true ? 'Yes' : 'No'),
    ],
    labels: mapEntries(metadata?.labels),
    // Secret annotations can embed payload keys or values (for example,
    // last-applied manifests), so the concise drawer omits them entirely.
    annotations: [],
    // Secret key names and values deliberately stay out of this display model.
    // Decoded values remain available only through the already-scoped YAML view.
    sections: [],
  };
}

function pvcSelectorEntries(value: unknown): Array<[string, string]> {
  return selectorEntries(value);
}

function persistentVolumeClaimModel(
  detail: UnknownRecord,
  fallback: Pick<KubernetesResourceSummary, 'name' | 'namespace' | 'createdAt'>,
): KubernetesBuiltinDetailModel {
  const metadata = record(detail.metadata);
  const annotations = record(metadata?.annotations);
  const spec = record(detail.spec);
  const status = record(detail.status);
  const requested = record(record(spec?.resources)?.requests);
  const capacity = record(status?.capacity);
  const storageClass = text(spec?.storageClassName)
    ?? text(annotations?.['volume.beta.kubernetes.io/storage-class'])
    ?? text(annotations?.['volume.kubernetes.io/storage-class']);
  return {
    properties: [
      ...commonProperties(detail, fallback),
      property('Status', status?.phase),
      property('Volume', spec?.volumeName),
      property('Capacity', capacity?.storage),
      property('Requested', requested?.storage),
      property('Access modes', joinOrDash(stringList(status?.accessModes).length > 0
        ? stringList(status?.accessModes)
        : stringList(spec?.accessModes))),
      property('Storage class', storageClass),
      property('Volume mode', text(spec?.volumeMode) ?? 'Filesystem'),
    ],
    labels: mapEntries(metadata?.labels),
    annotations: annotationEntries(metadata?.annotations),
    sections: compactSections([
      pairsSection('selector', 'Selector', pvcSelectorEntries(spec?.selector)),
      conditionsSection(status),
    ]),
  };
}

/** Builds the bounded, display-only Lens-inspired model for built-in resource drawers. */
export function buildKubernetesBuiltinDetailModel(
  kind: KubernetesBuiltinDetailKind,
  detail: Record<string, unknown>,
  fallback: Pick<KubernetesResourceSummary, 'name' | 'namespace' | 'createdAt'>,
): KubernetesBuiltinDetailModel {
  switch (kind) {
    case 'deployments': return deploymentModel(detail, fallback);
    case 'statefulsets': return statefulSetModel(detail, fallback);
    case 'services': return serviceModel(detail, fallback);
    case 'ingresses': return ingressModel(detail, fallback);
    case 'configmaps': return configMapModel(detail, fallback);
    case 'secrets': return secretModel(detail, fallback);
    case 'persistentvolumeclaims': return persistentVolumeClaimModel(detail, fallback);
  }
}
