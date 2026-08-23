import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type {
  ProxyCustomRule,
  ProxyCustomRuleDraft,
  ProxyExceptionType,
  ProxyRuleTarget,
} from '../../shared/types';

const EXCEPTION_TYPES = new Set<ProxyExceptionType>([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'IP-CIDR',
  'IP-CIDR6',
  'SRC-IP-CIDR',
  'GEOIP',
  'DST-PORT',
  'SRC-PORT',
]);

function isProxyExceptionType(value: unknown): value is ProxyExceptionType {
  return typeof value === 'string' && EXCEPTION_TYPES.has(value as ProxyExceptionType);
}

function normalizeTarget(value: unknown): ProxyRuleTarget {
  if (value === undefined) {
    return 'DIRECT';
  }
  if (value === 'PROXY' || value === 'DIRECT') {
    return value;
  }
  throw new Error('Custom rule target must be PROXY or DIRECT.');
}

function normalizeCidr(value: string, family: 4 | 6, label: string): string {
  const slash = value.lastIndexOf('/');
  if (slash <= 0 || slash !== value.indexOf('/')) {
    throw new Error(`${label} must include an address and prefix length.`);
  }

  const address = value.slice(0, slash);
  const prefixText = value.slice(slash + 1);
  const maxPrefix = family === 4 ? 32 : 128;
  if (
    isIP(address) !== family ||
    !/^\d+$/.test(prefixText) ||
    !Number.isSafeInteger(Number(prefixText)) ||
    Number(prefixText) > maxPrefix
  ) {
    throw new Error(`${label} is invalid.`);
  }

  return `${address}/${Number(prefixText)}`;
}

function normalizePort(value: string): string {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value);
  if (!match) {
    throw new Error('A port must be a number or inclusive start-end range.');
  }

  const start = Number(match[1]);
  const end = match[2] === undefined ? undefined : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    start < 1 ||
    start > 65535 ||
    (end !== undefined && (!Number.isSafeInteger(end) || end < start || end > 65535))
  ) {
    throw new Error('A port must be within 1-65535 and ranges must be inclusive.');
  }

  return end === undefined ? String(start) : `${start}-${end}`;
}

function normalizeValue(type: ProxyExceptionType, value: string): string {
  switch (type) {
    case 'IP-CIDR':
      return normalizeCidr(value, 4, 'IPv4 CIDR');
    case 'IP-CIDR6':
      return normalizeCidr(value, 6, 'IPv6 CIDR');
    case 'SRC-IP-CIDR':
      return normalizeCidr(value, 4, 'Source IPv4 CIDR');
    case 'GEOIP':
      if (!/^[a-z]{2}$/i.test(value)) {
        throw new Error('GeoIP must be a two-letter country code.');
      }
      return value.toUpperCase();
    case 'DST-PORT':
    case 'SRC-PORT':
      return normalizePort(value);
    default:
      return value;
  }
}

export function normalizeProxyCustomRules(drafts: ProxyCustomRuleDraft[]): ProxyCustomRule[] {
  if (!Array.isArray(drafts)) {
    throw new Error('Custom rules must be a list.');
  }

  return drafts.map((draft) => {
    if (!draft || !isProxyExceptionType(draft.type) || typeof draft.value !== 'string') {
      throw new Error('Each custom rule requires a supported type and string value.');
    }

    if (/[\r\n,]/.test(draft.value)) {
      throw new Error('Custom rule values cannot contain commas or newlines.');
    }
    const value = draft.value.trim();
    if (!value) {
      throw new Error('Custom rule values cannot be empty.');
    }

    return {
      id: typeof draft.id === 'string' && draft.id.length > 0 ? draft.id : randomUUID(),
      type: draft.type,
      value: normalizeValue(draft.type, value),
      target: normalizeTarget(draft.target),
    };
  });
}

export function buildCustomRuleRules(rules: ProxyCustomRuleDraft[], proxyTarget: string | undefined): string[] {
  return normalizeProxyCustomRules(rules).flatMap((rule) => {
    if (rule.target === 'DIRECT') {
      return `${rule.type},${rule.value},DIRECT`;
    }
    return proxyTarget ? `${rule.type},${rule.value},${proxyTarget}` : [];
  });
}
