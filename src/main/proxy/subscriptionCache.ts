import type { SubscriptionInfo } from './configBuilder';

const CACHE_VERSION = 1;

interface SubscriptionCache {
  version: number;
  subscription: SubscriptionInfo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUsableName(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.name === 'string' && value.name.trim().length > 0;
}

function validateSubscription(value: unknown): SubscriptionInfo {
  if (!isRecord(value)) {
    throw new Error('Subscription cache does not contain a valid subscription.');
  }

  const { base, proxies, synthesized, primaryGroup } = value;
  if (!isRecord(base)) {
    throw new Error('Subscription cache has an invalid subscription base.');
  }
  const baseProxies = base.proxies;
  if (!Array.isArray(baseProxies) || !baseProxies.some(hasUsableName)) {
    throw new Error('Subscription cache has an invalid base proxies list.');
  }
  if (!Array.isArray(proxies) || proxies.length === 0 || !proxies.every(hasUsableName)) {
    throw new Error('Subscription cache has an invalid proxies list.');
  }
  if (typeof synthesized !== 'boolean') {
    throw new Error('Subscription cache has an invalid synthesized flag.');
  }
  if (!synthesized) {
    const groups = base['proxy-groups'];
    if (!Array.isArray(groups) || !groups.some(hasUsableName)) {
      throw new Error('Subscription cache has an invalid proxy groups list.');
    }
  }
  if (primaryGroup !== undefined && (typeof primaryGroup !== 'string' || primaryGroup.trim().length === 0)) {
    throw new Error('Subscription cache has an invalid primary group.');
  }

  return {
    base,
    proxies,
    synthesized,
    ...(primaryGroup === undefined ? {} : { primaryGroup }),
  };
}

export function serializeSubscriptionCache(subscription: SubscriptionInfo): string {
  const cache: SubscriptionCache = { version: CACHE_VERSION, subscription };
  return JSON.stringify(cache);
}

export function parseSubscriptionCache(raw: string): SubscriptionInfo {
  let cache: unknown;
  try {
    cache = JSON.parse(raw);
  } catch {
    throw new Error('Subscription cache is not valid JSON.');
  }

  if (!isRecord(cache) || cache.version !== CACHE_VERSION) {
    throw new Error('Subscription cache has an unsupported version.');
  }

  return validateSubscription(cache.subscription);
}
