export const POD_SUMMARY_EMPTY = '—';

export interface KubernetesPodListColumns {
  cpu: string;
  memory: string;
  restarts: string;
  node: string;
}

export interface KubernetesPodMetric {
  namespace: string;
  name: string;
  cpu: string;
  memory: string;
}

interface DecimalQuantity {
  coefficient: bigint;
  scale: number;
}

interface ParsedQuantity {
  decimal: DecimalQuantity;
  suffix: string;
}

const MAX_QUANTITY_LENGTH = 256;
const MAX_DECIMAL_DIGITS = 128;
const MAX_DECIMAL_SCALE = 128;
const CPU_NANO = 1_000_000_000n;
const CPU_MICRO = 1_000n;
const CPU_MILLI = 1_000_000n;

const QUANTITY = /^(\+?(?:\d+(?:\.\d+)?))(?:([eE][+-]?\d+)|(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E))?$/;
const DECIMAL_SCALES: Record<string, number> = {
  n: -9,
  u: -6,
  m: -3,
  '': 0,
  k: 3,
  M: 6,
  G: 9,
  T: 12,
  P: 15,
  E: 18,
};
const BINARY_MULTIPLIERS: Record<string, bigint> = {
  Ki: 1_024n,
  Mi: 1_024n ** 2n,
  Gi: 1_024n ** 3n,
  Ti: 1_024n ** 4n,
  Pi: 1_024n ** 5n,
  Ei: 1_024n ** 6n,
};
const MEMORY_DISPLAY_UNITS: Array<[string, bigint]> = [
  ['Ei', BINARY_MULTIPLIERS.Ei],
  ['E', 10n ** 18n],
  ['Pi', BINARY_MULTIPLIERS.Pi],
  ['P', 10n ** 15n],
  ['Ti', BINARY_MULTIPLIERS.Ti],
  ['T', 10n ** 12n],
  ['Gi', BINARY_MULTIPLIERS.Gi],
  ['G', 10n ** 9n],
  ['Mi', BINARY_MULTIPLIERS.Mi],
  ['M', 10n ** 6n],
  ['Ki', BINARY_MULTIPLIERS.Ki],
  ['k', 10n ** 3n],
];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseDecimal(value: string): DecimalQuantity | undefined {
  const match = /^(\+?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match || value.length > MAX_QUANTITY_LENGTH) return undefined;

  const integer = match[2];
  const fractional = match[3] ?? '';
  if (integer.length + fractional.length > MAX_DECIMAL_DIGITS) return undefined;

  const exponentText = match[4];
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  if (!Number.isSafeInteger(exponent)) return undefined;
  const scale = exponent - fractional.length;
  if (Math.abs(scale) > MAX_DECIMAL_SCALE) return undefined;

  const digits = `${integer}${fractional}`.replace(/^0+/, '') || '0';
  return { coefficient: BigInt(digits), scale };
}

function parseQuantity(value: unknown): ParsedQuantity | undefined {
  if (typeof value !== 'string' || value.length > MAX_QUANTITY_LENGTH) return undefined;
  const match = QUANTITY.exec(value);
  if (!match) return undefined;
  const decimal = parseDecimal(`${match[1]}${match[2] ?? ''}`);
  if (!decimal) return undefined;
  return { decimal, suffix: match[3] ?? '' };
}

function scaledInteger(decimal: DecimalQuantity, multiplier: bigint, unitScale = 0): bigint | undefined {
  const scale = decimal.scale + unitScale;
  if (Math.abs(scale) > MAX_DECIMAL_SCALE || multiplier < 0n) return undefined;
  if (scale >= 0) return decimal.coefficient * multiplier * (10n ** BigInt(scale));

  const divisor = 10n ** BigInt(-scale);
  const numerator = decimal.coefficient * multiplier;
  return numerator % divisor === 0n ? numerator / divisor : undefined;
}

export function parseKubernetesCpuQuantity(value: unknown): bigint | undefined {
  const quantity = parseQuantity(value);
  if (!quantity) return undefined;

  const binary = BINARY_MULTIPLIERS[quantity.suffix];
  if (binary !== undefined) return scaledInteger(quantity.decimal, binary * CPU_NANO);
  const unitScale = DECIMAL_SCALES[quantity.suffix];
  return unitScale === undefined ? undefined : scaledInteger(quantity.decimal, CPU_NANO, unitScale);
}

export function parseKubernetesMemoryQuantity(value: unknown): bigint | undefined {
  const quantity = parseQuantity(value);
  if (!quantity) return undefined;

  const binary = BINARY_MULTIPLIERS[quantity.suffix];
  if (binary !== undefined) return scaledInteger(quantity.decimal, binary);
  const unitScale = DECIMAL_SCALES[quantity.suffix];
  return unitScale === undefined ? undefined : scaledInteger(quantity.decimal, 1n, unitScale);
}

function sum(values: readonly (bigint | undefined)[]): bigint | undefined {
  let total = 0n;
  let found = false;
  for (const value of values) {
    if (value === undefined) continue;
    total += value;
    found = true;
  }
  return found ? total : undefined;
}

function formatCpu(nanoCores: bigint): string {
  if (nanoCores % CPU_NANO === 0n) return String(nanoCores / CPU_NANO);
  if (nanoCores % CPU_MILLI === 0n) return `${nanoCores / CPU_MILLI}m`;
  if (nanoCores % CPU_MICRO === 0n) return `${nanoCores / CPU_MICRO}u`;
  return `${nanoCores}n`;
}

function formatMemory(bytes: bigint): string {
  for (const [suffix, multiplier] of MEMORY_DISPLAY_UNITS) {
    if (bytes >= multiplier && bytes % multiplier === 0n) {
      return `${bytes / multiplier}${suffix}`;
    }
  }
  return String(bytes);
}

function restartCount(value: unknown): number {
  const count = record(value)?.restartCount;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function summarizePodListColumns(pod: Record<string, unknown>): KubernetesPodListColumns {
  const spec = record(pod.spec);
  const statuses = [
    ...array(record(pod.status)?.containerStatuses),
    ...array(record(pod.status)?.initContainerStatuses),
  ];
  return {
    // CPU and Memory are live usage columns. They are filled independently
    // from metrics.k8s.io so requests/limits can never masquerade as usage.
    cpu: POD_SUMMARY_EMPTY,
    memory: POD_SUMMARY_EMPTY,
    restarts: String(statuses.reduce<number>((total, status) => total + restartCount(status), 0)),
    node: text(spec?.nodeName) ?? POD_SUMMARY_EMPTY,
  };
}

/** Maps one metrics.k8s.io PodMetrics object to display-safe aggregate usage. */
export function summarizePodMetric(value: Record<string, unknown>): KubernetesPodMetric | undefined {
  const metadata = record(value.metadata);
  const namespace = text(metadata?.namespace);
  const name = text(metadata?.name);
  if (!namespace || !name) return undefined;
  const containers = array(value.containers);
  const cpu = sum(containers.map((container) => (
    parseKubernetesCpuQuantity(record(record(container)?.usage)?.cpu)
  )));
  const memory = sum(containers.map((container) => (
    parseKubernetesMemoryQuantity(record(record(container)?.usage)?.memory)
  )));
  if (cpu === undefined && memory === undefined) return undefined;
  return {
    namespace,
    name,
    cpu: cpu === undefined ? POD_SUMMARY_EMPTY : formatCpu(cpu),
    memory: memory === undefined ? POD_SUMMARY_EMPTY : formatMemory(memory),
  };
}
