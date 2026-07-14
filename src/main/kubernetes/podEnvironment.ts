import type {
  KubernetesPodEnvironment,
  KubernetesPodEnvironmentEntry,
} from '../../shared/types';

export const MAX_POD_ENVIRONMENT_ENTRIES = 512;
export const MAX_POD_ENVIRONMENT_VALUE_BYTES = 16 * 1024;
export const MAX_POD_ENVIRONMENT_TOTAL_BYTES = 128 * 1024;

const MAX_BASE64_VALUE_LENGTH = Math.ceil(MAX_POD_ENVIRONMENT_VALUE_BYTES / 3) * 4;
const SAFE_CONNECTION_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

export interface PodEnvironmentResolverDependencies {
  readSecret(name: string): Promise<Record<string, unknown>>;
  isPermissionError(error: unknown): boolean;
}

type SecretReadResult =
  | { kind: 'value'; secret: Record<string, unknown> }
  | { kind: 'permission' }
  | { kind: 'missing' };

type SecretReader = (name: string) => Promise<SecretReadResult>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function statusCode(error: unknown): number | undefined {
  const value = record(error);
  if (!value) {
    return undefined;
  }
  for (const key of ['statusCode', 'status', 'code'] as const) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key] as number)) {
      return value[key] as number;
    }
  }
  return statusCode(value.response);
}

function safeSecretReadError(error: unknown): Error {
  const safe = new Error('Unable to read referenced Kubernetes Secret.');
  const status = statusCode(error);
  if (status !== undefined) {
    Object.assign(safe, { statusCode: status });
  }
  const code = text(record(error)?.code)?.toUpperCase();
  if (code && SAFE_CONNECTION_CODES.has(code)) {
    Object.assign(safe, { code });
  }
  return safe;
}

/**
 * Returns a deliberately target-free response when the selected Pod itself
 * cannot be read. It must not reveal a Pod name, namespace, or API error.
 */
export function noPermissionPodEnvironment(): KubernetesPodEnvironment {
  return {
    entries: [{ name: '(unavailable)', source: 'unknown', unavailable: 'no-permission' }],
    truncated: false,
    permissionDenied: true,
  };
}

/** Sanitizes initial Pod-read failures before they can cross the client boundary. */
export function safePodEnvironmentReadError(error: unknown): Error {
  const safe = new Error('Unable to read Kubernetes Pod environment.');
  const status = statusCode(error);
  if (status !== undefined) {
    Object.assign(safe, { statusCode: status });
  }
  const code = text(record(error)?.code)?.toUpperCase();
  if (code && SAFE_CONNECTION_CODES.has(code)) {
    Object.assign(safe, { code });
  }
  return safe;
}

function isUtf8Text(value: string): boolean {
  const bytes = Buffer.from(value, 'utf8');
  return bytes.toString('utf8') === value;
}

function decodeBase64(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_BASE64_VALUE_LENGTH) {
    return undefined;
  }
  const unpadded = value.replace(/=+$/, '');
  const paddingLength = value.length - unpadded.length;
  if (!/^[A-Za-z0-9+/]*$/.test(unpadded) || paddingLength > 2
    || (paddingLength > 0 && value.length % 4 !== 0) || unpadded.length % 4 === 1) {
    return undefined;
  }
  try {
    const bytes = Buffer.from(unpadded, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== unpadded || bytes.byteLength > MAX_POD_ENVIRONMENT_VALUE_BYTES) {
      return undefined;
    }
    const decoded = bytes.toString('utf8');
    return Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function findContainer(pod: Record<string, unknown>, containerName: string): Record<string, unknown> | undefined {
  const spec = record(pod.spec);
  return [...array(spec?.containers), ...array(spec?.initContainers)]
    .map(record)
    .find((container): container is Record<string, unknown> => text(container?.name) === containerName);
}

function secretReference(name: string | undefined, key?: string): string | undefined {
  if (!name) {
    return undefined;
  }
  return key === undefined ? `secret/${name}` : `secret/${name}/${key}`;
}

function configMapReference(name: string | undefined, key?: string): string | undefined {
  if (!name) {
    return undefined;
  }
  return key === undefined ? `configmap/${name}` : `configmap/${name}/${key}`;
}

function prefixedDeclarationName(prefix: unknown): string {
  return `${text(prefix) ?? ''}*`;
}

function isOptionalDeclaration(reference: Record<string, unknown>): boolean {
  return reference.optional === true;
}

class EnvironmentAccumulator {
  private readonly entries: KubernetesPodEnvironmentEntry[] = [];
  private totalBytes = 0;
  private exhausted = false;
  private truncated = false;
  private permissionDenied = false;

  public add(entry: KubernetesPodEnvironmentEntry): boolean {
    if (this.exhausted) {
      return false;
    }
    if (this.entries.length >= MAX_POD_ENVIRONMENT_ENTRIES) {
      this.exhausted = true;
      this.truncated = true;
      return false;
    }
    const serialized = JSON.stringify(entry);
    const delimiter = this.entries.length === 0 ? 0 : 1;
    const responseOverhead = Buffer.byteLength('{"entries":[],"truncated":true,"permissionDenied":true}', 'utf8');
    const nextBytes = Buffer.byteLength(serialized, 'utf8') + delimiter;
    if (this.totalBytes + nextBytes + responseOverhead > MAX_POD_ENVIRONMENT_TOTAL_BYTES) {
      this.exhausted = true;
      this.truncated = true;
      return false;
    }
    this.entries.push(entry);
    this.totalBytes += nextBytes;
    return true;
  }

  public markTruncated(): void {
    this.truncated = true;
  }

  public markPermissionDenied(): void {
    this.permissionDenied = true;
  }

  public isExhausted(): boolean {
    return this.exhausted;
  }

  public result(): KubernetesPodEnvironment {
    return {
      entries: this.entries,
      truncated: this.truncated,
      permissionDenied: this.permissionDenied,
    };
  }
}

function addTooLarge(
  accumulator: EnvironmentAccumulator,
  entry: Omit<KubernetesPodEnvironmentEntry, 'unavailable' | 'value'>
): void {
  accumulator.markTruncated();
  accumulator.add({ ...entry, unavailable: 'too-large' });
}

function addValue(
  accumulator: EnvironmentAccumulator,
  entry: Omit<KubernetesPodEnvironmentEntry, 'unavailable' | 'value'>,
  value: string | undefined
): void {
  if (value === undefined || Buffer.byteLength(value, 'utf8') > MAX_POD_ENVIRONMENT_VALUE_BYTES || !isUtf8Text(value)) {
    addTooLarge(accumulator, entry);
    return;
  }
  accumulator.add({ ...entry, value });
}

async function resolveSecretKeyRef(
  accumulator: EnvironmentAccumulator,
  entryName: string,
  reference: Record<string, unknown>,
  readSecret: SecretReader
): Promise<void> {
  const secretName = text(reference.name);
  const key = text(reference.key);
  const entry: Omit<KubernetesPodEnvironmentEntry, 'unavailable' | 'value'> = {
    name: entryName,
    source: 'secretKeyRef',
    ...(secretReference(secretName, key) ? { reference: secretReference(secretName, key) } : {}),
    optional: isOptionalDeclaration(reference),
  };
  if (!secretName || !key) {
    accumulator.add({ ...entry, unavailable: 'missing' });
    return;
  }
  const result = await readSecret(secretName);
  if (result.kind === 'permission') {
    accumulator.markPermissionDenied();
    accumulator.add({ ...entry, unavailable: 'no-permission' });
    return;
  }
  if (result.kind === 'missing') {
    accumulator.add({ ...entry, unavailable: 'missing' });
    return;
  }
  const data = record(result.secret.data);
  const encoded = data && hasOwn(data, key) ? data[key] : undefined;
  if (encoded === undefined) {
    accumulator.add({ ...entry, unavailable: 'missing' });
    return;
  }
  addValue(accumulator, entry, decodeBase64(encoded));
}

async function resolveEnvironmentVariable(
  value: unknown,
  readSecret: SecretReader,
  accumulator: EnvironmentAccumulator
): Promise<void> {
  const declaration = record(value);
  const entryName = text(declaration?.name) ?? '(unnamed)';
  if (!declaration) {
    accumulator.add({ name: entryName, source: 'unknown', unavailable: 'unsupported' });
    return;
  }
  if (hasOwn(declaration, 'value')) {
    const literal = text(declaration.value);
    if (literal === undefined) {
      accumulator.add({ name: entryName, source: 'literal', unavailable: 'unsupported' });
    } else {
      addValue(accumulator, { name: entryName, source: 'literal' }, literal);
    }
    return;
  }
  const valueFrom = record(declaration.valueFrom);
  if (!valueFrom) {
    accumulator.add({ name: entryName, source: 'unknown', unavailable: 'unsupported' });
    return;
  }
  const secretKeyRef = record(valueFrom.secretKeyRef);
  if (secretKeyRef) {
    await resolveSecretKeyRef(accumulator, entryName, secretKeyRef, readSecret);
    return;
  }
  const configMapKeyRef = record(valueFrom.configMapKeyRef);
  if (configMapKeyRef) {
    const configMapName = text(configMapKeyRef.name);
    const key = text(configMapKeyRef.key);
    const entry: KubernetesPodEnvironmentEntry = {
      name: entryName,
      source: 'configMapKeyRef',
      ...(configMapReference(configMapName, key) ? { reference: configMapReference(configMapName, key) } : {}),
      optional: isOptionalDeclaration(configMapKeyRef),
      unavailable: configMapName && key ? 'unsupported' : 'missing',
    };
    accumulator.add(entry);
    return;
  }
  const fieldRef = record(valueFrom.fieldRef);
  if (fieldRef) {
    const fieldPath = text(fieldRef.fieldPath);
    accumulator.add({
      name: entryName,
      source: 'fieldRef',
      ...(fieldPath ? { reference: `field/${fieldPath}` } : {}),
      unavailable: fieldPath ? 'unsupported' : 'missing',
    });
    return;
  }
  const resourceFieldRef = record(valueFrom.resourceFieldRef);
  if (resourceFieldRef) {
    const resource = text(resourceFieldRef.resource);
    accumulator.add({
      name: entryName,
      source: 'resourceFieldRef',
      ...(resource ? { reference: `resource/${resource}` } : {}),
      unavailable: resource ? 'unsupported' : 'missing',
    });
    return;
  }
  accumulator.add({ name: entryName, source: 'unknown', unavailable: 'unsupported' });
}

async function resolveEnvironmentFrom(
  value: unknown,
  readSecret: SecretReader,
  accumulator: EnvironmentAccumulator
): Promise<void> {
  const declaration = record(value);
  const entryName = prefixedDeclarationName(declaration?.prefix);
  if (!declaration) {
    accumulator.add({ name: entryName, source: 'unknown', unavailable: 'unsupported' });
    return;
  }
  const secretRef = record(declaration.secretRef);
  if (secretRef) {
    const secretName = text(secretRef.name);
    const entry: Omit<KubernetesPodEnvironmentEntry, 'unavailable' | 'value'> = {
      name: entryName,
      source: 'secretEnvFrom',
      ...(secretReference(secretName) ? { reference: secretReference(secretName) } : {}),
      optional: isOptionalDeclaration(secretRef),
    };
    if (!secretName) {
      accumulator.add({ ...entry, unavailable: 'missing' });
      return;
    }
    const result = await readSecret(secretName);
    if (result.kind === 'permission') {
      accumulator.markPermissionDenied();
      accumulator.add({ ...entry, unavailable: 'no-permission' });
      return;
    }
    if (result.kind === 'missing') {
      accumulator.add({ ...entry, unavailable: 'missing' });
      return;
    }
    const data = record(result.secret.data);
    if (!data) {
      return;
    }
    const prefix = text(declaration.prefix) ?? '';
    for (const key of Object.keys(data).sort((left, right) => left.localeCompare(right))) {
      if (accumulator.isExhausted()) {
        break;
      }
      const imported: Omit<KubernetesPodEnvironmentEntry, 'unavailable' | 'value'> = {
        name: `${prefix}${key}`,
        source: 'secretEnvFrom',
        reference: `secret/${secretName}/${key}`,
        optional: entry.optional,
      };
      if (data[key] === undefined) {
        accumulator.add({ ...imported, unavailable: 'missing' });
      } else {
        addValue(accumulator, imported, decodeBase64(data[key]));
      }
    }
    return;
  }
  const configMapRef = record(declaration.configMapRef);
  if (configMapRef) {
    const configMapName = text(configMapRef.name);
    accumulator.add({
      name: entryName,
      source: 'configMapEnvFrom',
      ...(configMapReference(configMapName) ? { reference: configMapReference(configMapName) } : {}),
      optional: isOptionalDeclaration(configMapRef),
      unavailable: configMapName ? 'unsupported' : 'missing',
    });
    return;
  }
  accumulator.add({ name: entryName, source: 'unknown', unavailable: 'unsupported' });
}

async function resolveDeclarations(container: Record<string, unknown>, readSecret: SecretReader): Promise<KubernetesPodEnvironment> {
  const accumulator = new EnvironmentAccumulator();
  for (const declaration of array(container.env)) {
    if (accumulator.isExhausted()) {
      break;
    }
    await resolveEnvironmentVariable(declaration, readSecret, accumulator);
  }
  for (const declaration of array(container.envFrom)) {
    if (accumulator.isExhausted()) {
      break;
    }
    await resolveEnvironmentFrom(declaration, readSecret, accumulator);
  }
  return accumulator.result();
}

export async function resolvePodContainerEnvironment(
  pod: Record<string, unknown>,
  containerName: string,
  dependencies: PodEnvironmentResolverDependencies,
): Promise<KubernetesPodEnvironment> {
  const container = findContainer(pod, containerName);
  if (!container) {
    throw new Error('Kubernetes Pod container is not available.');
  }
  const reads = new Map<string, Promise<SecretReadResult>>();
  const readSecret = (name: string): Promise<SecretReadResult> => {
    const existing = reads.get(name);
    if (existing) {
      return existing;
    }
    const next = dependencies.readSecret(name)
      .then((secret) => ({ kind: 'value' as const, secret }))
      .catch((error) => {
        if (dependencies.isPermissionError(error)) {
          return { kind: 'permission' as const };
        }
        if (statusCode(error) === 404) {
          return { kind: 'missing' as const };
        }
        return Promise.reject(safeSecretReadError(error));
      });
    reads.set(name, next);
    return next;
  };
  return resolveDeclarations(container, readSecret);
}
