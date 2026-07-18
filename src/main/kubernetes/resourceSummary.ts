import type { KubernetesCustomResourcePrinterColumn, KubernetesResourceKind } from '../../shared/types';
import {
  customResourcePrinterColumnKey,
  formatKubernetesPrinterColumnValue,
  readKubernetesPrinterColumnValue,
} from './customResourcePrinterColumns';
import { POD_SUMMARY_EMPTY, summarizePodListColumns } from './podSummary';
import { sanitizeSecretForCache } from './resourceQuery';
import type { KubernetesResourceSummary } from './resourceQuery';

const MAX_JOINED_VALUES = 5;
const MAX_COLUMN_LENGTH = 512;
const MAX_EVENT_MESSAGE_LENGTH = 16_384;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function objectValue(value: unknown, key: string): Record<string, unknown> {
  return record(record(value)?.[key]) ?? {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  const parsed = value instanceof Date
    ? value
    : typeof value === 'string'
      ? new Date(value)
      : undefined;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function bounded(value: string): string {
  return value.length <= MAX_COLUMN_LENGTH
    ? value
    : `${value.slice(0, MAX_COLUMN_LENGTH - 1)}…`;
}

function uniqueTexts(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const candidate = text(value);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

function joined(values: string[], separator = ', '): string {
  if (values.length === 0) return POD_SUMMARY_EMPTY;
  const visible = values.slice(0, MAX_JOINED_VALUES);
  const suffix = values.length > visible.length ? `${separator}+${values.length - visible.length}` : '';
  return bounded(`${visible.join(separator)}${suffix}`);
}

function countEntries(value: unknown): string {
  return String(Object.keys(record(value) ?? {}).length);
}

function yesNo(value: unknown): string {
  return value === true ? 'Yes' : 'No';
}

function labelCount(metadata: Record<string, unknown>): string {
  return countEntries(metadata.labels);
}

function annotationCount(metadata: Record<string, unknown>): string {
  return countEntries(metadata.annotations);
}

function replicaRatio(spec: Record<string, unknown>, status: Record<string, unknown>): string {
  const desired = numberValue(spec.replicas) ?? numberValue(status.replicas);
  const ready = numberValue(status.readyReplicas) ?? numberValue(status.availableReplicas);
  return desired === undefined && ready === undefined
    ? POD_SUMMARY_EMPTY
    : `${ready ?? 0}/${desired ?? 0}`;
}

function deploymentColumns(value: Record<string, unknown>): Record<string, string> {
  const spec = objectValue(value, 'spec');
  const status = objectValue(value, 'status');
  return {
    ready: replicaRatio(spec, status),
    updated: String(numberValue(status.updatedReplicas) ?? 0),
    available: String(numberValue(status.availableReplicas) ?? 0),
    unavailable: String(numberValue(status.unavailableReplicas) ?? 0),
    strategy: text(objectValue(spec, 'strategy').type) ?? POD_SUMMARY_EMPTY,
  };
}

function statefulSetColumns(value: Record<string, unknown>): Record<string, string> {
  const spec = objectValue(value, 'spec');
  const status = objectValue(value, 'status');
  return {
    ready: replicaRatio(spec, status),
    current: String(numberValue(status.currentReplicas) ?? 0),
    updated: String(numberValue(status.updatedReplicas) ?? 0),
    service: text(spec.serviceName) ?? POD_SUMMARY_EMPTY,
    strategy: text(objectValue(spec, 'updateStrategy').type) ?? POD_SUMMARY_EMPTY,
  };
}

function loadBalancerAddresses(value: Record<string, unknown>): string[] {
  return uniqueTexts(array(objectValue(objectValue(value, 'status'), 'loadBalancer').ingress).flatMap((entry) => {
    const ingress = record(entry);
    return ingress ? [ingress.ip, ingress.hostname] : [];
  }));
}

function servicePorts(spec: Record<string, unknown>): string {
  const values = array(spec.ports).flatMap((entry) => {
    const port = record(entry);
    const exposed = numberValue(port?.port);
    if (!port || exposed === undefined) return [];
    const name = text(port.name);
    const target = typeof port.targetPort === 'string' || typeof port.targetPort === 'number'
      ? String(port.targetPort)
      : undefined;
    const nodePort = numberValue(port.nodePort);
    const protocol = text(port.protocol) ?? 'TCP';
    const targetPart = target && target !== String(exposed) ? `→${target}` : '';
    const nodePart = nodePort === undefined ? '' : `:${nodePort}`;
    return [`${name ? `${name}:` : ''}${exposed}${targetPart}${nodePart}/${protocol}`];
  });
  return joined(values);
}

function serviceSelector(spec: Record<string, unknown>): string {
  const selector = record(spec.selector);
  if (!selector) return POD_SUMMARY_EMPTY;
  return joined(Object.keys(selector).sort().flatMap((key) => {
    const value = selector[key];
    return typeof value === 'string' ? [`${key}=${value}`] : [];
  }));
}

function serviceColumns(value: Record<string, unknown>): Record<string, string> {
  const spec = objectValue(value, 'spec');
  const type = text(spec.type) ?? 'ClusterIP';
  const clusterIPs = uniqueTexts(array(spec.clusterIPs));
  const externalAddresses = uniqueTexts([
    ...(type === 'ExternalName' ? [spec.externalName] : []),
    ...array(spec.externalIPs),
    ...loadBalancerAddresses(value),
  ]);
  return {
    type,
    clusterIP: joined(clusterIPs.length > 0 ? clusterIPs : uniqueTexts([spec.clusterIP])),
    externalIP: externalAddresses.length > 0
      ? joined(externalAddresses)
      : type === 'LoadBalancer' ? '<pending>' : POD_SUMMARY_EMPTY,
    ports: servicePorts(spec),
    selector: serviceSelector(spec),
  };
}

function ingressColumns(value: Record<string, unknown>): Record<string, string> {
  const metadata = objectValue(value, 'metadata');
  const spec = objectValue(value, 'spec');
  const rules = array(spec.rules);
  const tls = array(spec.tls);
  const defaultBackend = record(spec.defaultBackend);
  const hosts = uniqueTexts([
    ...rules.map((entry) => text(record(entry)?.host) ?? '*'),
    ...(rules.length === 0 && defaultBackend ? ['*'] : []),
  ]);
  const exposesHttp = rules.length > 0 || defaultBackend !== undefined;
  return {
    class: text(spec.ingressClassName)
      ?? text(record(metadata.annotations)?.['kubernetes.io/ingress.class'])
      ?? POD_SUMMARY_EMPTY,
    hosts: joined(hosts),
    address: joined(loadBalancerAddresses(value)),
    ports: joined([
      ...(exposesHttp ? ['80'] : []),
      ...(tls.length > 0 ? ['443'] : []),
    ]),
    tls: tls.length > 0 ? `Yes (${tls.length})` : 'No',
  };
}

function configurationColumns(value: Record<string, unknown>, dataCount?: string): Record<string, string> {
  const metadata = objectValue(value, 'metadata');
  return {
    data: dataCount ?? countEntries(value.data),
    binary: countEntries(value.binaryData),
    immutable: yesNo(value.immutable),
    labels: labelCount(metadata),
    annotations: annotationCount(metadata),
  };
}

function secretColumns(value: Record<string, unknown>, dataCount: string): Record<string, string> {
  const metadata = objectValue(value, 'metadata');
  return {
    type: text(value.type) ?? POD_SUMMARY_EMPTY,
    data: dataCount,
    immutable: yesNo(value.immutable),
    labels: labelCount(metadata),
    annotations: annotationCount(metadata),
  };
}

const ACCESS_MODE_LABELS: Record<string, string> = {
  ReadWriteOnce: 'RWO',
  ReadOnlyMany: 'ROX',
  ReadWriteMany: 'RWX',
  ReadWriteOncePod: 'RWOP',
};

function persistentVolumeClaimColumns(value: Record<string, unknown>): Record<string, string> {
  const metadata = objectValue(value, 'metadata');
  const spec = objectValue(value, 'spec');
  const status = objectValue(value, 'status');
  const modes = array(status.accessModes).length > 0 ? array(status.accessModes) : array(spec.accessModes);
  const annotations = record(metadata.annotations);
  return {
    status: text(status.phase) ?? POD_SUMMARY_EMPTY,
    volume: text(spec.volumeName) ?? POD_SUMMARY_EMPTY,
    capacity: text(record(status.capacity)?.storage)
      ?? text(record(record(spec.resources)?.requests)?.storage)
      ?? POD_SUMMARY_EMPTY,
    accessModes: joined(uniqueTexts(modes).map((mode) => ACCESS_MODE_LABELS[mode] ?? mode)),
    storageClass: text(spec.storageClassName)
      ?? text(annotations?.['volume.beta.kubernetes.io/storage-class'])
      ?? text(annotations?.['volume.kubernetes.io/storage-class'])
      ?? POD_SUMMARY_EMPTY,
  };
}

function customResourceColumns(
  value: Record<string, unknown>,
  printerColumns: KubernetesCustomResourcePrinterColumn[] = [],
): Record<string, string> {
  const metadata = objectValue(value, 'metadata');
  const status = objectValue(value, 'status');
  const statusValues = uniqueTexts([
    status.phase,
    status.state,
    objectValue(status, 'health').status,
    objectValue(status, 'sync').status,
  ]);
  const columns: Record<string, string> = {
    kind: text(value.kind) ?? POD_SUMMARY_EMPTY,
    apiVersion: text(value.apiVersion) ?? POD_SUMMARY_EMPTY,
    status: joined(statusValues, ' · '),
    generation: numberValue(metadata.generation)?.toString() ?? POD_SUMMARY_EMPTY,
    labels: labelCount(metadata),
  };
  printerColumns.forEach((column, index) => {
    const formatted = formatKubernetesPrinterColumnValue(
      readKubernetesPrinterColumnValue(value, column.jsonPath),
      { type: column.type },
    );
    columns[customResourcePrinterColumnKey(column.sourceIndex ?? index)] = formatted;
    if (column.name.toLocaleLowerCase() === 'status' && formatted !== POD_SUMMARY_EMPTY) {
      columns.status = formatted;
    }
  });
  return columns;
}

function nodeStatus(value: Record<string, unknown>): string | undefined {
  const ready = array(objectValue(value, 'status').conditions)
    .map(record)
    .find((candidate) => candidate?.type === 'Ready');
  return text(ready?.status);
}

function statusFor(
  kind: KubernetesResourceKind | 'events',
  value: Record<string, unknown>,
  columns: Record<string, string>,
): string | undefined {
  const status = objectValue(value, 'status');
  switch (kind) {
    case 'pods': return text(status.phase);
    case 'deployments':
    case 'statefulsets': return columns.ready === POD_SUMMARY_EMPTY ? undefined : columns.ready;
    case 'services': return columns.type === POD_SUMMARY_EMPTY ? undefined : columns.type;
    case 'ingresses': return columns.class === POD_SUMMARY_EMPTY ? undefined : columns.class;
    case 'secrets': return columns.type === POD_SUMMARY_EMPTY ? undefined : columns.type;
    case 'persistentvolumeclaims': return columns.status === POD_SUMMARY_EMPTY ? undefined : columns.status;
    case 'custom-resources': return columns.status === POD_SUMMARY_EMPTY ? undefined : columns.status;
    case 'nodes': return nodeStatus(value);
    case 'namespaces': return text(status.phase);
    case 'events': return text(value.reason) ?? text(value.type);
    default: return undefined;
  }
}

function columnsFor(
  kind: KubernetesResourceKind | 'events',
  value: Record<string, unknown>,
  createdAt: string | undefined,
  secretDataCount: string | undefined,
  customResourcePrinterColumns: KubernetesCustomResourcePrinterColumn[] | undefined,
): Record<string, string> {
  switch (kind) {
    case 'pods': return { ...summarizePodListColumns(value) };
    case 'deployments': return deploymentColumns(value);
    case 'statefulsets': return statefulSetColumns(value);
    case 'services': return serviceColumns(value);
    case 'ingresses': return ingressColumns(value);
    case 'configmaps': return configurationColumns(value);
    case 'secrets': return secretColumns(value, secretDataCount ?? '0');
    case 'persistentvolumeclaims': return persistentVolumeClaimColumns(value);
    case 'custom-resources': return customResourceColumns(value, customResourcePrinterColumns);
    case 'events': {
      const observed = timestamp(value.eventTime)
        ?? timestamp(objectValue(value, 'series').lastObservedTime)
        ?? timestamp(value.lastTimestamp)
        ?? createdAt;
      return {
        reason: text(value.reason) ?? POD_SUMMARY_EMPTY,
        type: text(value.type) ?? POD_SUMMARY_EMPTY,
        message: (text(value.message) ?? POD_SUMMARY_EMPTY).slice(0, MAX_EVENT_MESSAGE_LENGTH),
        count: String(numberValue(value.count) ?? 0),
        ...(observed ? { observedAt: observed } : {}),
      };
    }
    default: return {};
  }
}

/**
 * Maps a raw Kubernetes object to the bounded renderer-safe summary used by
 * both LIST pages and Watch events. For Secrets, the only derived payload
 * fact is the top-level `data` entry count; keys, values, and all stringData
 * are discarded before any other summary extraction.
 */
export function mapKubernetesResourceSummary(
  kind: KubernetesResourceKind | 'events',
  value: Record<string, unknown>,
  customResourcePrinterColumns?: KubernetesCustomResourcePrinterColumn[],
): KubernetesResourceSummary {
  const createdAt = timestamp(objectValue(value, 'metadata').creationTimestamp);
  const secretDataCount = kind === 'secrets' ? countEntries(value.data) : undefined;
  const source = kind === 'secrets' ? sanitizeSecretForCache(value) : value;
  const metadata = objectValue(source, 'metadata');
  const uid = text(metadata.uid);
  const name = text(metadata.name);
  const resourceVersion = text(metadata.resourceVersion);
  if (!uid || !name || !resourceVersion) {
    throw new Error('Kubernetes resource response is missing required metadata.');
  }

  const columns = columnsFor(kind, source, createdAt, secretDataCount, customResourcePrinterColumns);
  const status = statusFor(kind, source, columns);
  if (kind === 'pods' && status) columns.status = status;
  if ((kind === 'nodes' || kind === 'namespaces') && status) {
    columns.status = status;
  }

  return {
    uid,
    name,
    ...(text(metadata.namespace) ? { namespace: text(metadata.namespace) } : {}),
    resourceVersion,
    ...(createdAt ? { createdAt } : {}),
    ...(status ? { status } : {}),
    columns,
  };
}
