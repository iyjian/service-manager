import yaml from 'js-yaml';
import type { ProxyException, ProxySettings } from '../../shared/types';
import { buildDirectExceptionRules } from './proxyExceptions';

// Fallback group name when a subscription ships no proxy-groups of its own.
export const PROXY_GROUP_MAIN = '代理';

// Control fields the app owns and overrides on top of the subscription
// (mirrors clash-verge-rev's HANDLE_FIELDS). Everything else in the
// subscription — proxies, proxy-groups, rules, rule-providers, proxy-providers
// — is preserved as-is so the subscription's own routing keeps working.
const CONTROLLED_FIELDS = [
  'mixed-port',
  'port',
  'socks-port',
  'redir-port',
  'tproxy-port',
  'mode',
  'allow-lan',
  'bind-address',
  'log-level',
  'ipv6',
  'external-controller',
  'external-controller-cors',
  'secret',
  'tun',
];

export interface SubscriptionInfo {
  base: Record<string, unknown>;
  proxies: Record<string, unknown>[];
  // The primary selectable group the simplified node picker drives. Detected
  // from the subscription (e.g. "🚀 节点选择"). It is absent when a
  // subscription has groups but none are manually selectable.
  primaryGroup?: string;
  synthesized: boolean;
}

export interface RuntimeConfigOptions {
  controllerPort: number;
  secret: string;
}

interface ProxyGroup {
  name: string;
  type?: string;
  proxies?: string[];
}

function decodeMaybeBase64(raw: string): string {
  const trimmed = raw.trim();
  // Clash YAML always contains a "proxies" key; if absent, try base64.
  if (/(^|\n)\s*proxies\s*:/.test(trimmed)) {
    return trimmed;
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    try {
      const decoded = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64').toString('utf8');
      if (/(^|\n)\s*proxies\s*:/.test(decoded)) {
        return decoded;
      }
    } catch {
      // fall through to YAML parse of the original text
    }
  }
  return trimmed;
}

function detectPrimaryGroup(groups: ProxyGroup[], nodeNames: Set<string>): string | null {
  // Prefer the first `select` group that actually contains real proxy nodes —
  // this is the group a user switches nodes on (e.g. "🚀 节点选择"), not a
  // policy group like "全球直连" that only holds DIRECT/other groups.
  const selectWithNodes = groups.find(
    (group) =>
      (group.type ?? 'select') === 'select' &&
      Array.isArray(group.proxies) &&
      group.proxies.some((name) => nodeNames.has(name))
  );
  if (selectWithNodes) {
    return selectWithNodes.name;
  }
  const anySelect = groups.find((group) => (group.type ?? 'select') === 'select');
  return anySelect?.name ?? null;
}

export function parseSubscription(raw: string): SubscriptionInfo {
  const text = decodeMaybeBase64(raw);
  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (error) {
    throw new Error(`Subscription is not valid Clash YAML: ${(error as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { proxies?: unknown }).proxies)) {
    throw new Error('Subscription does not contain a "proxies" list. Only Clash-format subscriptions are supported.');
  }

  const base = parsed as Record<string, unknown>;
  const proxies = (base.proxies as unknown[]).filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string'
  );

  if (proxies.length === 0) {
    throw new Error('Subscription contains no usable proxy nodes.');
  }

  const nodeNames = new Set(proxies.map((proxy) => String(proxy.name)));
  const groups = Array.isArray(base['proxy-groups'])
    ? (base['proxy-groups'] as ProxyGroup[]).filter((group) => group && typeof group.name === 'string')
    : [];

  const detected = detectPrimaryGroup(groups, nodeNames);

  return {
    base,
    proxies,
    primaryGroup: detected ?? (groups.length === 0 ? PROXY_GROUP_MAIN : undefined),
    synthesized: groups.length === 0,
  };
}

function buildTun(): Record<string, unknown> {
  return {
    enable: true,
    stack: 'system',
    'auto-route': true,
    'auto-detect-interface': true,
    'dns-hijack': ['any:53'],
  };
}

function buildPersistedDirectExceptionRules(exceptions: unknown): string[] {
  if (!Array.isArray(exceptions)) {
    return [];
  }

  return exceptions.flatMap((exception) => {
    try {
      return buildDirectExceptionRules([exception as ProxyException]);
    } catch {
      // Settings are durable user data. A malformed legacy entry must not
      // prevent the remaining validated exceptions or subscription from starting.
      return [];
    }
  });
}

export function buildRuntimeConfig(
  settings: ProxySettings,
  subscription: SubscriptionInfo,
  options: RuntimeConfigOptions
): Record<string, unknown> {
  // Start from the subscription itself so its proxies / proxy-groups / rules /
  // rule-providers all stay intact, then strip the fields we control and set
  // our own values on top (clash-verge-rev's merge model).
  const config: Record<string, unknown> = { ...subscription.base };
  for (const field of CONTROLLED_FIELDS) {
    delete config[field];
  }

  if (subscription.synthesized) {
    // Subscription shipped no groups/rules of its own — provide a minimal
    // routing policy so traffic still flows.
    config.proxies = subscription.proxies;
    config['proxy-groups'] = [
      { name: PROXY_GROUP_MAIN, type: 'select', proxies: subscription.proxies.map((proxy) => String(proxy.name)) },
    ];
    config.rules = [
      'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
      'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
      'IP-CIDR6,::1/128,DIRECT,no-resolve',
      'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
      `MATCH,${PROXY_GROUP_MAIN}`,
    ];
  }

  const directExceptionRules = buildPersistedDirectExceptionRules(settings.exceptions);
  const existingRules = Array.isArray(config.rules) ? config.rules : [];
  config.rules = [...directExceptionRules, ...existingRules];

  config['mixed-port'] = settings.mixedPort;
  config['allow-lan'] = false;
  config['bind-address'] = '127.0.0.1';
  config.mode = settings.mode;
  config['log-level'] = 'info';
  config['external-controller'] = `127.0.0.1:${options.controllerPort}`;
  config.secret = options.secret;
  // store-selected off: node choices are re-applied via the controller after
  // startup, so a refreshed subscription can't pin a removed node.
  config.profile = { 'store-selected': false };

  if (settings.tunEnabled) {
    config.tun = buildTun();
    // fake-ip is required for TUN to route domain traffic correctly; only
    // override dns when the subscription didn't configure fake-ip itself.
    const existingDns = (config.dns as Record<string, unknown> | undefined) ?? {};
    if (existingDns['enhanced-mode'] !== 'fake-ip') {
      config.dns = {
        ...existingDns,
        enable: true,
        'enhanced-mode': 'fake-ip',
        'fake-ip-range': existingDns['fake-ip-range'] ?? '198.18.0.1/16',
        nameserver: existingDns.nameserver ?? ['223.5.5.5', '119.29.29.29'],
      };
    }
  }

  return config;
}

export function dumpRuntimeConfig(config: Record<string, unknown>): string {
  return yaml.dump(config, { lineWidth: 200, noRefs: true });
}
