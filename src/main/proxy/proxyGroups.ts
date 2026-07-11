export interface MihomoProxyRecord {
  name: string;
  type: string;
  now?: string;
  all?: string[];
  history?: { time: string; delay: number }[];
}

export type MihomoProxyRecords = Record<string, MihomoProxyRecord>;

export interface ProxyGroupOptionInfo {
  name: string;
  type: string;
  delayMs?: number;
}

export interface ProxyGroupInfo {
  name: string;
  now?: string;
  options: ProxyGroupOptionInfo[];
}

export interface ManualProxyGroupsInfo {
  groups: ProxyGroupInfo[];
}

function isManualSelector(entry: MihomoProxyRecord): boolean {
  return entry.name !== 'GLOBAL' && entry.type.toLowerCase() === 'selector' && Array.isArray(entry.all);
}

function toOption(records: MihomoProxyRecords, name: string): ProxyGroupOptionInfo {
  const entry = records[name];
  const delay = entry?.history?.[entry.history.length - 1]?.delay;
  return {
    name,
    type: entry?.type ?? 'unknown',
    ...(typeof delay === 'number' && delay > 0 ? { delayMs: delay } : {}),
  };
}

export function listManualProxyGroups(records: MihomoProxyRecords): ManualProxyGroupsInfo {
  return {
    groups: Object.values(records)
      .filter(isManualSelector)
      .map((group) => ({
        name: group.name,
        now: group.now,
        options: (group.all ?? []).map((name) => toOption(records, name)),
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
