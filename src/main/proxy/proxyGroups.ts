import type { ProxyDelayResult, ProxyGroupOptionInfo, ProxyGroupsInfo } from '../../shared/types';

export interface MihomoProxyRecord {
  name: string;
  type: string;
  now?: string;
  all?: string[];
  history?: { time: string; delay: number }[];
}

export type MihomoProxyRecords = Record<string, MihomoProxyRecord>;

function isManualSelector(entry: MihomoProxyRecord): boolean {
  return entry.name !== 'GLOBAL' && entry.type.toLowerCase() === 'selector' && Array.isArray(entry.all);
}

function toOption(
  records: MihomoProxyRecords,
  name: string,
  delayResults: ReadonlyMap<string, ProxyDelayResult> | undefined
): ProxyGroupOptionInfo {
  const entry = records[name];
  const delayResult = delayResults?.get(name);
  const delay = entry?.history?.[entry.history.length - 1]?.delay;
  return {
    name,
    type: entry?.type ?? 'unknown',
    ...(delayResult?.status === 'ready' && typeof delayResult.delayMs === 'number'
      ? { delayMs: delayResult.delayMs, delayStatus: 'ready' as const }
      : delayResult?.status === 'unavailable'
        ? { delayStatus: 'unavailable' as const }
        : typeof delay === 'number' && delay > 0
          ? { delayMs: delay }
          : {}),
  };
}

export function listManualProxyGroups(
  records: MihomoProxyRecords,
  delayResults?: ReadonlyMap<string, ProxyDelayResult>
): ProxyGroupsInfo {
  return {
    groups: Object.values(records)
      .filter(isManualSelector)
      .map((group) => ({
        name: group.name,
        now: group.now,
        options: (group.all ?? []).map((name) => toOption(records, name, delayResults)),
      })),
  };
}

export function findManualProxyOption(
  records: MihomoProxyRecords,
  groupName: string,
  optionName: string
): ProxyGroupOptionInfo | undefined {
  const group = listManualProxyGroups(records).groups.find((item) => item.name === groupName);
  return group?.options.find((item) => item.name === optionName);
}

export function normalizeSavedProxySelections(
  selectedProxies: Record<string, string> | undefined,
  legacySelectedProxy: string | undefined,
  primaryGroup: string
): Record<string, string> {
  const normalized = { ...selectedProxies };
  if (legacySelectedProxy && !normalized[primaryGroup]) {
    normalized[primaryGroup] = legacySelectedProxy;
  }
  return normalized;
}

export function validSavedProxySelections(
  records: MihomoProxyRecords,
  selectedProxies: Record<string, string>
): [string, string][] {
  return Object.entries(selectedProxies).filter(([groupName, optionName]) =>
    Boolean(findManualProxyOption(records, groupName, optionName))
  );
}
