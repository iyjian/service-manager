import type { KubernetesCustomResourceDefinition } from '../shared/types';
import {
  formatKubernetesPrinterColumnValue,
  readKubernetesPrinterColumnValue,
} from './kubernetesCustomResourcePrinterColumns.js';

export interface KubernetesCustomResourceProperty {
  name: string;
  value: string;
  multiline: boolean;
}

export interface KubernetesCustomResourceCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface KubernetesCustomResourceDetailModel {
  kind: string;
  apiVersion: string;
  properties: KubernetesCustomResourceProperty[];
  labels: Array<[string, string]>;
  annotations: Array<[string, string]>;
  conditions: KubernetesCustomResourceCondition[];
}

const MAX_METADATA_ENTRIES = 128;
const MAX_METADATA_KEY_LENGTH = 256;
const MAX_METADATA_VALUE_LENGTH = 4_096;
const MAX_METADATA_TOTAL_LENGTH = 32_768;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function sortedStringEntries(value: unknown): Array<[string, string]> {
  const entries = Object.entries(record(value) ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([left], [right]) => left.localeCompare(right));
  const result: Array<[string, string]> = [];
  let totalLength = 0;
  for (const [rawKey, rawValue] of entries) {
    if (result.length >= MAX_METADATA_ENTRIES) break;
    const key = boundedText(rawKey, MAX_METADATA_KEY_LENGTH);
    const remaining = MAX_METADATA_TOTAL_LENGTH - totalLength - key.length;
    if (remaining <= 0) break;
    const valueLength = Math.min(MAX_METADATA_VALUE_LENGTH, remaining);
    const entryValue = boundedText(rawValue, valueLength);
    result.push([key, entryValue]);
    totalLength += key.length + entryValue.length;
  }
  if (result.length < entries.length) {
    result.push(['…', `${entries.length - result.length} more entries not shown`]);
  }
  return result;
}

function property(
  name: string,
  value: unknown,
  type?: KubernetesCustomResourceDefinition['printerColumns'][number]['type'],
): KubernetesCustomResourceProperty | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const formatted = formatKubernetesPrinterColumnValue(value, { pretty: true, maxLength: 8_192, type });
  return {
    name,
    value: formatted,
    multiline: formatted.includes('\n') || formatted.length > 120,
  };
}

export function buildKubernetesCustomResourceDetailModel(
  detail: Record<string, unknown>,
  definition: KubernetesCustomResourceDefinition,
): KubernetesCustomResourceDetailModel {
  const metadata = record(detail.metadata) ?? {};
  const status = record(detail.status) ?? {};
  const properties: KubernetesCustomResourceProperty[] = [];
  for (const candidate of [
    property('Created', metadata.creationTimestamp),
    property('Name', metadata.name),
    property('Namespace', metadata.namespace),
    ...(definition.printerColumns ?? []).map((column) => property(
      column.name,
      readKubernetesPrinterColumnValue(detail, column.jsonPath),
      column.type,
    )),
  ]) {
    if (candidate) properties.push(candidate);
  }
  if ((definition.printerColumns ?? []).length === 0) {
    for (const candidate of [
      property('Generation', metadata.generation),
      property('Status', status.phase ?? status.state),
    ]) {
      if (candidate) properties.push(candidate);
    }
  }

  const hasStatusPrinterColumn = (definition.printerColumns ?? [])
    .some((column) => column.name.toLocaleLowerCase() === 'status');
  const conditions = hasStatusPrinterColumn || !Array.isArray(status.conditions)
    ? []
    : status.conditions.slice(0, 64).flatMap((value) => {
      const condition = record(value);
      const type = text(condition?.type) ?? text(condition?.reason);
      if (!condition || !type) return [];
      return [{
        type,
        status: text(condition.status) ?? 'Unknown',
        ...(text(condition.reason) ? { reason: text(condition.reason) } : {}),
        ...(text(condition.message) ? { message: text(condition.message)?.slice(0, 4_096) } : {}),
        ...(text(condition.lastTransitionTime) ? { lastTransitionTime: text(condition.lastTransitionTime) } : {}),
      }];
    });

  return {
    kind: text(detail.kind) ?? definition.kind,
    apiVersion: text(detail.apiVersion) ?? `${definition.group}/${definition.version}`,
    properties,
    labels: sortedStringEntries(metadata.labels),
    annotations: sortedStringEntries(metadata.annotations),
    conditions,
  };
}
