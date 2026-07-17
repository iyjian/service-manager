import type { KubernetesCustomResourcePrinterColumnType } from '../shared/types';

const MAX_JSON_PATH_LENGTH = 512;
const MAX_PATH_STEPS = 24;
const MAX_RESULT_NODES = 128;
const MAX_VISITED_NODES = 256;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

type FilterPathStep = { kind: 'field'; key: string } | { kind: 'index'; index: number };
type PathStep = FilterPathStep
  | { kind: 'wildcard' }
  | { kind: 'filter'; path: FilterPathStep[]; operator: '==' | '!='; expected: unknown };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function ownValue(value: unknown, key: string): unknown {
  const source = record(value);
  return source && !FORBIDDEN_KEYS.has(key) && Object.prototype.hasOwnProperty.call(source, key)
    ? source[key]
    : undefined;
}

function readQuoted(value: string, quote: string): string | undefined {
  try {
    if (quote === '"') return JSON.parse(`"${value}"`) as string;
    return value.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  } catch {
    return undefined;
  }
}

function parseExpected(value: string): unknown {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return readQuoted(trimmed.slice(1, -1), trimmed[0] as string);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return undefined;
}

function parseFilter(value: string): PathStep | undefined {
  const match = /^\?\(\s*@((?:\\.|[^=!])+)\s*(==|!=)\s*(.+?)\s*\)$/.exec(value);
  if (!match) return undefined;
  const [, rawPath = '', operator, rawExpected = ''] = match;
  const parsed = parsePath(rawPath.trim());
  if (!parsed || parsed.some((step) => step.kind === 'wildcard' || step.kind === 'filter')) return undefined;
  const expected = parseExpected(rawExpected);
  if (expected === undefined) return undefined;
  return { kind: 'filter', path: parsed as FilterPathStep[], operator: operator as '==' | '!=', expected };
}

function bracketEnd(value: string, start: number): number {
  let quote = '';
  let escaped = false;
  let nested = 0;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index] as string;
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '[') {
      nested += 1;
    } else if (character === ']') {
      if (nested > 0) nested -= 1;
      else return index;
    }
  }
  return -1;
}

function parseBracket(value: string): PathStep | undefined {
  const trimmed = value.trim();
  if (trimmed === '*') return { kind: 'wildcard' };
  if (/^(?:0|[1-9]\d*)$/.test(trimmed)) {
    const index = Number(trimmed);
    return Number.isSafeInteger(index) && index <= 10_000 ? { kind: 'index', index } : undefined;
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const key = readQuoted(trimmed.slice(1, -1), trimmed[0] as string);
    return key && !FORBIDDEN_KEYS.has(key) ? { kind: 'field', key } : undefined;
  }
  return parseFilter(trimmed);
}

function parsePath(value: string): PathStep[] | undefined {
  const path = value.trim();
  if (!path || path.length > MAX_JSON_PATH_LENGTH) return undefined;
  const steps: PathStep[] = [];
  let index = path.startsWith('$') ? 1 : 0;
  while (index < path.length) {
    if (steps.length >= MAX_PATH_STEPS) return undefined;
    if (path[index] === '.') {
      index += 1;
      let key = '';
      while (index < path.length && path[index] !== '.' && path[index] !== '[') {
        if (path[index] === '\\') {
          index += 1;
          if (index >= path.length) return undefined;
        }
        key += path[index] as string;
        index += 1;
      }
      if (!key || FORBIDDEN_KEYS.has(key)) return undefined;
      steps.push({ kind: 'field', key });
    } else if (path[index] === '[') {
      const end = bracketEnd(path, index + 1);
      if (end < 0) return undefined;
      const step = parseBracket(path.slice(index + 1, end));
      if (!step) return undefined;
      steps.push(step);
      index = end + 1;
    } else {
      return undefined;
    }
  }
  return steps.length > 0 ? steps : undefined;
}

function readFilterPath(value: unknown, path: FilterPathStep[]): unknown {
  let current = value;
  for (const step of path) {
    current = step.kind === 'field'
      ? ownValue(current, step.key)
      : Array.isArray(current) ? current[step.index] : undefined;
    if (current === undefined) return undefined;
  }
  return current;
}

interface EvaluationBudget {
  remaining: number;
}

function visit(budget: EvaluationBudget): boolean {
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

function applyPathStep(nodes: unknown[], step: PathStep, budget: EvaluationBudget): unknown[] {
  const next: unknown[] = [];
  const append = (value: unknown): void => {
    if (value !== undefined && next.length < MAX_RESULT_NODES) next.push(value);
  };
  for (const node of nodes) {
    if (!visit(budget)) break;
    if (step.kind === 'field') {
      if (Array.isArray(node)) {
        for (const child of node) {
          if (!visit(budget)) break;
          append(ownValue(child, step.key));
          if (next.length >= MAX_RESULT_NODES) break;
        }
      } else {
        append(ownValue(node, step.key));
      }
    } else if (step.kind === 'index') {
      if (Array.isArray(node)) append(node[step.index]);
    } else if (step.kind === 'wildcard') {
      if (Array.isArray(node)) {
        for (const child of node) {
          if (!visit(budget)) break;
          append(child);
          if (next.length >= MAX_RESULT_NODES) break;
        }
      } else {
        const source = record(node);
        for (const key in source ?? {}) {
          if (!Object.prototype.hasOwnProperty.call(source, key) || FORBIDDEN_KEYS.has(key)) continue;
          if (!visit(budget)) break;
          append(ownValue(source, key));
          if (next.length >= MAX_RESULT_NODES) break;
        }
      }
    } else if (Array.isArray(node)) {
      for (const child of node) {
        if (!visit(budget)) break;
        const matches = readFilterPath(child, step.path) === step.expected;
        if (step.operator === '==' ? matches : !matches) append(child);
        if (next.length >= MAX_RESULT_NODES) break;
      }
    }
    if (next.length >= MAX_RESULT_NODES) break;
  }
  return next;
}

export function readKubernetesPrinterColumnValue(source: unknown, jsonPath: string): unknown {
  const path = parsePath(jsonPath);
  if (!path) return undefined;
  let nodes: unknown[] = [source];
  const budget: EvaluationBudget = { remaining: MAX_VISITED_NODES };
  for (const step of path) {
    nodes = applyPathStep(nodes, step, budget);
    if (nodes.length === 0) return undefined;
  }
  return nodes[0];
}

function bounded(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatKubernetesPrinterColumnValue(
  value: unknown,
  options: {
    pretty?: boolean;
    maxLength?: number;
    type?: KubernetesCustomResourcePrinterColumnType;
  } = {},
): string {
  const maxLength = Math.max(16, Math.min(options.maxLength ?? 512, 16_384));
  if (value === undefined) return '—';
  if (options.type === 'string') return typeof value === 'string' ? bounded(value, maxLength) : '—';
  if (options.type === 'integer') {
    return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '—';
  }
  if (options.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
  }
  if (options.type === 'boolean') return typeof value === 'boolean' ? String(value) : '—';
  if (options.type === 'date') {
    const parsed = typeof value === 'string' || value instanceof Date ? new Date(value) : undefined;
    return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : '—';
  }
  if (value === null) return 'null';
  if (typeof value === 'string') return bounded(value, maxLength);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—';
  try {
    return bounded(JSON.stringify(value, null, options.pretty ? 2 : undefined), maxLength);
  } catch {
    return '—';
  }
}

export function customResourcePrinterColumnKey(index: number): string {
  return `printer${index}`;
}
