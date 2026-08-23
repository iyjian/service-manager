import type { ProxyCustomRule, ProxySettings } from '../../shared/types';

const PROXY_MODES = new Set(['direct', 'rule', 'global']);
const PROXY_RULE_TYPES = new Set([
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6',
  'SRC-IP-CIDR', 'GEOIP', 'DST-PORT', 'SRC-PORT',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function snapshotRules(value: unknown): ProxyCustomRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    if (
      typeof candidate.id !== 'string'
      || typeof candidate.type !== 'string'
      || !PROXY_RULE_TYPES.has(candidate.type)
      || typeof candidate.value !== 'string'
      || (candidate.target !== 'PROXY' && candidate.target !== 'DIRECT')
    ) {
      return [];
    }
    return [{
      id: candidate.id,
      type: candidate.type as ProxyCustomRule['type'],
      value: candidate.value,
      target: candidate.target,
    }];
  });
}

function snapshotSelections(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const selections: Record<string, string> = {};
  for (const [group, option] of Object.entries(value)) {
    if (group.length > 0 && typeof option === 'string' && option.length > 0) {
      selections[group] = option;
    }
  }
  return Object.keys(selections).length > 0 ? selections : undefined;
}

export function sanitizeProxySettingsForSnapshot(value: unknown): ProxySettings {
  const source = isRecord(value) ? value : {};
  const mode = typeof source.mode === 'string' && PROXY_MODES.has(source.mode) ? source.mode : 'rule';
  const mixedPort = Number.isInteger(source.mixedPort) && Number(source.mixedPort) >= 1 && Number(source.mixedPort) <= 65_535
    ? Number(source.mixedPort)
    : 7_890;
  const selectedProxies = snapshotSelections(source.selectedProxies);
  return {
    startOnLaunch: source.startOnLaunch === true,
    mode: mode as ProxySettings['mode'],
    mixedPort,
    tunEnabled: source.tunEnabled === true,
    systemProxyEnabled: source.systemProxyEnabled === true,
    customRules: snapshotRules(source.customRules),
    ...(typeof source.subscriptionUpdatedAt === 'string' && Number.isFinite(Date.parse(source.subscriptionUpdatedAt))
      ? { subscriptionUpdatedAt: source.subscriptionUpdatedAt }
      : {}),
    ...(Number.isInteger(source.proxyCount) && Number(source.proxyCount) >= 0
      ? { proxyCount: Number(source.proxyCount) }
      : {}),
    ...(selectedProxies ? { selectedProxies } : {}),
    ...(typeof source.selectedProxy === 'string' && source.selectedProxy.length > 0
      ? { selectedProxy: source.selectedProxy }
      : {}),
  };
}

export interface PersistentProxySnapshot {
  settings: ProxySettings;
  subscriptionYaml?: string;
}

