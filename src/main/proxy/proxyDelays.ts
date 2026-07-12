import type { ProxyDelayResult } from '../../shared/types';
import { listManualProxyGroups, type MihomoProxyRecord, type MihomoProxyRecords } from './proxyGroups';

export const PROXY_DELAY_TEST_URL = 'http://cp.cloudflare.com/generate_204';
export const PROXY_DELAY_TIMEOUT_MS = 10_000;
export const PROXY_DELAY_CONCURRENCY = 4;

const ROUTING_ACTION_NAMES = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE']);
const NON_CONCRETE_PROXY_TYPES = new Set(['selector', 'urltest', 'fallback', 'loadbalance', 'relay']);

function isConcreteProxyCandidate(name: string, entry: MihomoProxyRecord | undefined): boolean {
  if (!entry || ROUTING_ACTION_NAMES.has(name.toUpperCase())) {
    return false;
  }
  return !NON_CONCRETE_PROXY_TYPES.has(entry.type.toLowerCase().replace(/[\s_-]/g, ''));
}

export function collectDelayTestTargets(records: MihomoProxyRecords): string[] {
  const targets = new Set<string>();
  for (const group of listManualProxyGroups(records).groups) {
    for (const option of group.options) {
      if (isConcreteProxyCandidate(option.name, records[option.name])) {
        targets.add(option.name);
      }
    }
  }
  return [...targets];
}

export async function runBoundedDelayTests(
  targets: readonly string[],
  limit: number,
  run: (name: string) => Promise<number>
): Promise<Map<string, ProxyDelayResult>> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Delay test concurrency must be at least one.');
  }

  const uniqueTargets = [...new Set(targets)];
  const results = new Map<string, ProxyDelayResult>();
  let nextTargetIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextTargetIndex < uniqueTargets.length) {
      const name = uniqueTargets[nextTargetIndex++];
      try {
        const delayMs = await run(name);
        if (!Number.isFinite(delayMs) || delayMs < 0) {
          throw new Error('Delay test returned an invalid value.');
        }
        results.set(name, { delayMs: Math.round(delayMs), status: 'ready' });
      } catch {
        results.set(name, { status: 'unavailable' });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, uniqueTargets.length) }, () => worker()));
  return results;
}
