import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  S3CredentialValues,
  S3SyncResult,
  S3SyncSettingsDraft,
  S3SyncSettingsView,
} from '../shared/types';

const SETTINGS_SCHEMA_VERSION = 2;
const SNAPSHOT_SCHEMA_VERSION = 1;
const SYNC_VERSION = 1 as const;
const OBJECT_LAYOUT_VERSION = 1 as const;
const DEFAULT_REGION = 'us-east-1';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ENDPOINT_LENGTH = 4_096;
const MAX_REGION_LENGTH = 128;
const MAX_ACCESS_KEY_LENGTH = 512;
const MAX_SECRET_KEY_LENGTH = 4_096;
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;
const ENCRYPTION_INFO = Buffer.from('service-manager-s3-sync-v1', 'utf8');
const ENCRYPTION_AAD = Buffer.from('service-manager-s3-snapshot-v1', 'utf8');

export interface S3CredentialProtector {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export type S3SnapshotProvider = () => Promise<Record<string, unknown>>;

export interface S3SyncRuntimeOptions {
  userDataPath: string;
  appVersion: string;
  credentialProtector: S3CredentialProtector;
  snapshotProvider: S3SnapshotProvider;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  createRevision?: () => string;
  createClientId?: () => string;
  createRandomBytes?: (size: number) => Buffer;
  timeoutMs?: number;
}

interface PersistedS3SyncSettings {
  schemaVersion: 2;
  bucketUrl: string;
  region: string;
  clientId: string;
  encryptedAccessKeyId?: string;
  encryptedSecretAccessKey?: string;
  lastSyncedAt?: string;
  lastRevision?: string;
}

export interface ServiceManagerSnapshotV1 {
  schemaVersion: 1;
  syncVersion: 1;
  app: 'service-manager';
  appVersion: string;
  revision: string;
  createdAt: string;
  data: Record<string, unknown>;
}

export interface EncryptedS3SnapshotV1 {
  schemaVersion: 1;
  syncVersion: 1;
  encryption: {
    algorithm: 'AES-256-GCM';
    kdf: 'HKDF-SHA256';
    salt: string;
    iv: string;
    authTag: string;
  };
  ciphertext: string;
}

export interface S3SigningInput {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  payload: string | Buffer;
  now: Date;
}

export interface S3SignedRequest {
  url: string;
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]' || normalized === '::1';
}

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function normalizedEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_ENDPOINT_LENGTH) {
    throw new Error('A full S3 bucket URL is required.');
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('The S3 bucket URL is invalid.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The S3 bucket URL must use HTTPS.');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error('The S3 bucket URL must use HTTPS unless it targets localhost.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The S3 bucket URL cannot contain credentials, a query, or a fragment.');
  }
  if (url.pathname === '/' || url.pathname.length === 0) {
    throw new Error('The S3 bucket URL must include a bucket path.');
  }

  try {
    canonicalizeS3Path(url.pathname);
  } catch {
    throw new Error('The S3 bucket URL contains an invalid path encoding.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

function migrateLegacyObjectUrl(value: unknown): string {
  const endpoint = normalizedEndpoint(value);
  const url = new URL(endpoint);
  const originalPath = url.pathname;
  if (/\/service-manager\/snapshot\.json$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/service-manager\/snapshot\.json$/i, '');
  } else if (/\/[^/]+\.json$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/[^/]+\.json$/i, '');
  }
  if (url.pathname && url.pathname !== '/' && url.pathname !== originalPath) {
    return normalizedEndpoint(url.toString());
  }
  return endpoint;
}

function normalizedClientId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('The S3 client identity is invalid.');
  }
  return value;
}

function normalizedRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw new Error('The S3 snapshot revision is invalid.');
  }
  return value;
}

export function buildS3SnapshotObjectUrl(bucketUrl: string, clientId: string, revision: string): string {
  const base = normalizedEndpoint(bucketUrl).replace(/\/+$/, '');
  const client = normalizedClientId(clientId);
  const snapshotRevision = normalizedRevision(revision);
  return `${base}/service-manager/v${OBJECT_LAYOUT_VERSION}/clients/${client}/${snapshotRevision}.json`;
}

function normalizedRegion(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > MAX_REGION_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.trim())
  ) {
    throw new Error('A valid S3 region is required.');
  }
  return value.trim();
}

function optionalCredential(value: unknown, label: string, maxLength: number, trim: boolean): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${label} must be text.`);
  }
  const normalized = trim ? value.trim() : value;
  if (normalized.length === 0 || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

export function validateS3SyncSettingsDraft(value: unknown): S3SyncSettingsDraft {
  if (!isRecord(value)) {
    throw new Error('S3 sync settings are required.');
  }

  const accessKeyId = optionalCredential(value.accessKeyId, 'The S3 access key ID', MAX_ACCESS_KEY_LENGTH, true);
  const secretAccessKey = optionalCredential(value.secretAccessKey, 'The S3 secret access key', MAX_SECRET_KEY_LENGTH, false);
  const clearCredentials = value.clearCredentials === true;
  if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
    throw new Error('Both the S3 access key ID and secret access key are required.');
  }
  if (clearCredentials && accessKeyId !== undefined) {
    throw new Error('Credentials cannot be saved and cleared at the same time.');
  }

  return {
    endpoint: normalizedEndpoint(value.endpoint),
    region: normalizedRegion(value.region),
    ...(accessKeyId !== undefined ? { accessKeyId, secretAccessKey } : {}),
    ...(clearCredentials ? { clearCredentials: true } : {}),
  };
}

export function createServiceManagerSnapshot(
  data: Record<string, unknown>,
  appVersion: string,
  revision: string = randomUUID(),
  createdAt: string = new Date().toISOString(),
): ServiceManagerSnapshotV1 {
  if (!isRecord(data)) {
    throw new Error('Snapshot data is invalid.');
  }
  if (typeof appVersion !== 'string' || appVersion.length === 0 || appVersion.length > 128) {
    throw new Error('The application version is invalid.');
  }
  if (typeof revision !== 'string' || revision.length === 0 || revision.length > 256) {
    throw new Error('The snapshot revision is invalid.');
  }
  if (!isValidIsoTimestamp(createdAt)) {
    throw new Error('The snapshot timestamp is invalid.');
  }

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    app: 'service-manager',
    appVersion,
    revision,
    createdAt,
    data,
  };
}

export function measureBoundedJsonBytes(value: unknown, maximumBytes = MAX_SNAPSHOT_BYTES): number {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('The snapshot size limit is invalid.');
  }
  let bytes = 0;
  const ancestors = new WeakSet<object>();
  const add = (amount: number): void => {
    bytes += amount;
    if (bytes > maximumBytes) {
      throw new Error('The application data snapshot is too large to sync.');
    }
  };
  const addJsonString = (value: string): void => {
    add(1); // opening quote
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code === 0x22 || code === 0x5c) {
        add(2); // quote and reverse solidus use a two-byte escape
      } else if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
        add(2); // short JSON control escapes: \b, \t, \n, \f, \r
      } else if (code <= 0x1f) {
        add(6); // remaining controls use \u00XX
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          add(4); // one supplementary code point encoded as UTF-8
          index += 1;
        } else {
          add(6); // well-formed JSON.stringify escapes a lone surrogate
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        add(6);
      } else if (code <= 0x7f) {
        add(1);
      } else if (code <= 0x7ff) {
        add(2);
      } else {
        add(3);
      }
    }
    add(1); // closing quote
  };
  const addSerializedPrimitive = (primitive: unknown): void => {
    if (typeof primitive === 'string') {
      addJsonString(primitive);
      return;
    }
    const serialized = JSON.stringify(primitive);
    if (serialized === undefined) throw new Error('Snapshot data could not be serialized.');
    add(Buffer.byteLength(serialized, 'utf8'));
  };
  const visit = (candidate: unknown, arrayItem = false): void => {
    if (candidate === undefined || typeof candidate === 'function' || typeof candidate === 'symbol') {
      if (arrayItem) add(4);
      return;
    }
    if (candidate === null || typeof candidate !== 'object') {
      if (typeof candidate === 'bigint') throw new Error('Snapshot data could not be serialized.');
      addSerializedPrimitive(candidate);
      return;
    }
    if (ancestors.has(candidate)) throw new Error('Snapshot data could not be serialized.');
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        add(2);
        if (candidate.length > 0) {
          // Reserve one byte per item plus separators first. This rejects an
          // impossible-to-fit sparse array before walking millions of holes.
          add((candidate.length * 2) - 1);
          for (let index = 0; index < candidate.length; index += 1) {
            bytes -= 1;
            visit(candidate[index], true);
          }
        }
        return;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('Snapshot data could not be serialized.');
      }
      add(2);
      let written = 0;
      for (const [key, item] of Object.entries(candidate)) {
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
        if (written > 0) add(1);
        addJsonString(key);
        add(1);
        visit(item);
        written += 1;
      }
    } finally {
      ancestors.delete(candidate);
    }
  };
  visit(value);
  return bytes;
}

function deriveSnapshotKey(secretAccessKey: string, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secretAccessKey, 'utf8'), salt, ENCRYPTION_INFO, 32));
}

function parseEncryptedSnapshot(value: unknown): EncryptedS3SnapshotV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.syncVersion !== 1 || !isRecord(value.encryption)) {
    throw new Error('Encrypted S3 snapshot is invalid.');
  }
  const encryption = value.encryption;
  if (
    encryption.algorithm !== 'AES-256-GCM'
    || encryption.kdf !== 'HKDF-SHA256'
    || typeof encryption.salt !== 'string'
    || typeof encryption.iv !== 'string'
    || typeof encryption.authTag !== 'string'
    || typeof value.ciphertext !== 'string'
  ) {
    throw new Error('Encrypted S3 snapshot is invalid.');
  }
  return value as unknown as EncryptedS3SnapshotV1;
}

export function encryptS3Snapshot(
  snapshot: ServiceManagerSnapshotV1,
  secretAccessKey: string,
  createBytes: (size: number) => Buffer = randomBytes,
): EncryptedS3SnapshotV1 {
  if (typeof secretAccessKey !== 'string' || secretAccessKey.length === 0) {
    throw new Error('The S3 secret access key is unavailable.');
  }

  measureBoundedJsonBytes(snapshot);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.from(JSON.stringify(snapshot), 'utf8');
  } catch {
    throw new Error('Snapshot data could not be serialized.');
  }
  if (plaintext.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error('The application data snapshot is too large to sync.');
  }

  const salt = createBytes(16);
  const iv = createBytes(12);
  if (!Buffer.isBuffer(salt) || salt.byteLength !== 16 || !Buffer.isBuffer(iv) || iv.byteLength !== 12) {
    throw new Error('Secure snapshot randomness is unavailable.');
  }
  const cipher = createCipheriv('aes-256-gcm', deriveSnapshotKey(secretAccessKey, salt), iv);
  cipher.setAAD(ENCRYPTION_AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    encryption: {
      algorithm: 'AES-256-GCM',
      kdf: 'HKDF-SHA256',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    },
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptS3Snapshot(value: unknown, secretAccessKey: string): ServiceManagerSnapshotV1 {
  try {
    const envelope = parseEncryptedSnapshot(value);
    const salt = Buffer.from(envelope.encryption.salt, 'base64');
    const iv = Buffer.from(envelope.encryption.iv, 'base64');
    const authTag = Buffer.from(envelope.encryption.authTag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    if (salt.byteLength !== 16 || iv.byteLength !== 12 || authTag.byteLength !== 16) {
      throw new Error('invalid encryption parameters');
    }
    const decipher = createDecipheriv('aes-256-gcm', deriveSnapshotKey(secretAccessKey, salt), iv);
    decipher.setAAD(ENCRYPTION_AAD);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const snapshot: unknown = JSON.parse(plaintext.toString('utf8'));
    if (!isRecord(snapshot) || snapshot.schemaVersion !== 1 || snapshot.syncVersion !== 1 || snapshot.app !== 'service-manager') {
      throw new Error('invalid snapshot');
    }
    return snapshot as unknown as ServiceManagerSnapshotV1;
  } catch {
    throw new Error('Encrypted S3 snapshot could not be decrypted.');
  }
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function canonicalizeS3Path(pathname: string): string {
  const canonical = pathname
    .split('/')
    .map((segment) => awsUriEncode(decodeURIComponent(segment)))
    .join('/');
  return canonical.startsWith('/') ? canonical : `/${canonical}`;
}

function amzTimestamp(value: Date): { amzDate: string; dateStamp: string } {
  if (!Number.isFinite(value.getTime())) {
    throw new Error('The S3 signing timestamp is invalid.');
  }
  const amzDate = value.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export function signS3PutRequest(input: S3SigningInput): S3SignedRequest {
  const endpoint = normalizedEndpoint(input.endpoint);
  const region = normalizedRegion(input.region);
  if (!input.accessKeyId || !input.secretAccessKey) {
    throw new Error('S3 credentials are unavailable.');
  }
  const url = new URL(endpoint);
  const canonicalUri = canonicalizeS3Path(url.pathname);
  const requestUrl = `${url.protocol}//${url.host}${canonicalUri}`;
  const payloadHash = sha256Hex(input.payload);
  const { amzDate, dateStamp } = amzTimestamp(input.now);
  const canonicalHeaders = [
    'content-type:application/json',
    `host:${url.host.toLowerCase()}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    '',
  ].join('\n');
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const dateKey = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: requestUrl,
    canonicalRequest,
    stringToSign,
    signature,
    headers: {
      'content-type': 'application/json',
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization,
    },
  };
}

function defaultSettings(clientId: string): PersistedS3SyncSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    bucketUrl: '',
    region: DEFAULT_REGION,
    clientId: normalizedClientId(clientId),
  };
}

function settingsView(settings: PersistedS3SyncSettings): S3SyncSettingsView {
  return {
    endpoint: settings.bucketUrl,
    region: settings.region,
    hasCredentials: Boolean(settings.encryptedAccessKeyId && settings.encryptedSecretAccessKey),
    ...(settings.lastSyncedAt ? { lastSyncedAt: settings.lastSyncedAt } : {}),
    ...(settings.lastRevision ? { lastRevision: settings.lastRevision } : {}),
  };
}

function parsePersistedSettings(
  value: unknown,
  createClientId: () => string,
): { settings: PersistedS3SyncSettings; migrated: boolean } {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== SETTINGS_SCHEMA_VERSION)) {
    throw new Error('S3 sync settings are invalid.');
  }
  const legacy = value.schemaVersion === 1;
  if (legacy && value.syncVersion !== 1) {
    throw new Error('S3 sync settings are invalid.');
  }
  const bucketUrl = legacy
    ? migrateLegacyObjectUrl(value.endpoint)
    : normalizedEndpoint(value.bucketUrl);
  const region = normalizedRegion(value.region);
  const encryptedAccessKeyId = typeof value.encryptedAccessKeyId === 'string' && value.encryptedAccessKeyId.length > 0
    ? value.encryptedAccessKeyId
    : undefined;
  const encryptedSecretAccessKey = typeof value.encryptedSecretAccessKey === 'string' && value.encryptedSecretAccessKey.length > 0
    ? value.encryptedSecretAccessKey
    : undefined;
  if ((encryptedAccessKeyId === undefined) !== (encryptedSecretAccessKey === undefined)) {
    throw new Error('S3 sync settings are invalid.');
  }
  if (encryptedAccessKeyId && (!/^[A-Za-z0-9+/]+={0,2}$/.test(encryptedAccessKeyId) || encryptedAccessKeyId.length > 16_384)) {
    throw new Error('S3 sync settings are invalid.');
  }
  if (encryptedSecretAccessKey && (!/^[A-Za-z0-9+/]+={0,2}$/.test(encryptedSecretAccessKey) || encryptedSecretAccessKey.length > 16_384)) {
    throw new Error('S3 sync settings are invalid.');
  }
  const settings: PersistedS3SyncSettings = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    bucketUrl,
    region,
    clientId: legacy ? normalizedClientId(createClientId()) : normalizedClientId(value.clientId),
    ...(encryptedAccessKeyId ? { encryptedAccessKeyId, encryptedSecretAccessKey } : {}),
    ...(isValidIsoTimestamp(value.lastSyncedAt) ? { lastSyncedAt: value.lastSyncedAt } : {}),
    ...(typeof value.lastRevision === 'string' && value.lastRevision.length > 0 && value.lastRevision.length <= 256
      ? { lastRevision: value.lastRevision }
      : {}),
  };
  return { settings, migrated: legacy };
}

function safeHttpError(status: number, body: string): Error {
  const match = body.slice(0, 8_192).match(/<Code>\s*([A-Za-z0-9._-]{1,128})\s*<\/Code>/i);
  const suffix = match ? ` ${match[1]}` : '';
  return new Error(`S3 sync failed (${status}${suffix}).`);
}

async function readBoundedResponseText(response: Response, signal: AbortSignal, maximumBytes = 8_192): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Buffer[] = [];
  let total = 0;
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (total < maximumBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      const retained = chunk.subarray(0, maximumBytes - total);
      chunks.push(retained);
      total += retained.byteLength;
      if (retained.byteLength < chunk.byteLength || total >= maximumBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export class S3SyncRuntime {
  private readonly settingsPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly createRevision: () => string;
  private readonly createClientId: () => string;
  private readonly createRandomBytes: (size: number) => Buffer;
  private readonly timeoutMs: number;
  private settings?: PersistedS3SyncSettings;
  private loading?: Promise<PersistedS3SyncSettings>;
  private operationQueue: Promise<void> = Promise.resolve();
  private syncPromise?: Promise<S3SyncResult>;
  private activeAbortController?: AbortController;
  private shuttingDown = false;

  public constructor(private readonly options: S3SyncRuntimeOptions) {
    this.settingsPath = path.join(options.userDataPath, 's3-sync.json');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.createRevision = options.createRevision ?? randomUUID;
    this.createClientId = options.createClientId ?? randomUUID;
    this.createRandomBytes = options.createRandomBytes ?? randomBytes;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async getSettings(): Promise<S3SyncSettingsView> {
    return settingsView(await this.ensureSettings());
  }

  public getS3SyncSettings(): Promise<S3SyncSettingsView> {
    return this.getSettings();
  }

  public revealS3SyncCredentials(): Promise<S3CredentialValues> {
    return this.enqueue(async () => ({ ...this.credentials(await this.ensureSettings()) }));
  }

  public saveSettings(value: unknown): Promise<S3SyncSettingsView> {
    return this.enqueue(async () => {
      if (this.shuttingDown) throw new Error('S3 sync is shutting down.');
      const draft = validateS3SyncSettingsDraft(value);
      const current = await this.ensureSettings();
      let encryptedAccessKeyId = current.encryptedAccessKeyId;
      let encryptedSecretAccessKey = current.encryptedSecretAccessKey;

      if (draft.clearCredentials) {
        encryptedAccessKeyId = undefined;
        encryptedSecretAccessKey = undefined;
      } else if (draft.accessKeyId !== undefined && draft.secretAccessKey !== undefined) {
        if (!this.hasSecureCredentialStorage()) {
          throw new Error('Secure credential storage is unavailable.');
        }
        try {
          encryptedAccessKeyId = this.options.credentialProtector.encryptString(draft.accessKeyId).toString('base64');
          encryptedSecretAccessKey = this.options.credentialProtector.encryptString(draft.secretAccessKey).toString('base64');
        } catch {
          throw new Error('S3 credentials could not be stored securely.');
        }
      }

      const next: PersistedS3SyncSettings = {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        bucketUrl: draft.endpoint,
        region: draft.region,
        clientId: current.clientId,
        ...(encryptedAccessKeyId && encryptedSecretAccessKey
          ? { encryptedAccessKeyId, encryptedSecretAccessKey }
          : {}),
        ...(current.bucketUrl === draft.endpoint && current.region === draft.region && current.lastSyncedAt
          ? { lastSyncedAt: current.lastSyncedAt }
          : {}),
        ...(current.bucketUrl === draft.endpoint && current.region === draft.region && current.lastRevision
          ? { lastRevision: current.lastRevision }
          : {}),
      };
      await this.persist(next);
      this.settings = next;
      return settingsView(next);
    });
  }

  public saveS3SyncSettings(value: unknown): Promise<S3SyncSettingsView> {
    return this.saveSettings(value);
  }

  public syncAllDataToS3(): Promise<S3SyncResult> {
    if (this.syncPromise) return this.syncPromise;
    const promise = this.enqueue(() => this.performSync());
    this.syncPromise = promise;
    void promise.finally(() => {
      if (this.syncPromise === promise) this.syncPromise = undefined;
    }).catch(() => undefined);
    return promise;
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.activeAbortController?.abort();
    try {
      await this.syncPromise;
    } catch {
      // Cancellation and request failures are already reported to the caller.
    }
    await this.operationQueue;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureSettings(): Promise<PersistedS3SyncSettings> {
    if (this.settings) return this.settings;
    if (!this.loading) {
      this.loading = this.loadSettings().then((settings) => {
        this.settings = settings;
        return settings;
      });
    }
    return this.loading;
  }

  private async loadSettings(): Promise<PersistedS3SyncSettings> {
    try {
      const parsed = parsePersistedSettings(
        JSON.parse(await fs.readFile(this.settingsPath, 'utf8')),
        this.createClientId,
      );
      if (parsed.migrated) await this.persist(parsed.settings);
      return parsed.settings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSettings(this.createClientId());
      if (error instanceof Error && error.message === 'S3 sync settings are invalid.') throw error;
      throw new Error('S3 sync settings could not be loaded.');
    }
  }

  private async persist(settings: PersistedS3SyncSettings): Promise<void> {
    const temporaryPath = `${this.settingsPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
      await fs.writeFile(temporaryPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, this.settingsPath);
      await fs.chmod(this.settingsPath, 0o600).catch(() => undefined);
    } catch {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw new Error('S3 sync settings could not be saved.');
    }
  }

  private credentials(settings: PersistedS3SyncSettings): { accessKeyId: string; secretAccessKey: string } {
    if (!settings.encryptedAccessKeyId || !settings.encryptedSecretAccessKey) {
      throw new Error('S3 credentials are unavailable.');
    }
    if (!this.hasSecureCredentialStorage()) {
      throw new Error('S3 credentials are unavailable. Save them again.');
    }
    try {
      const accessKeyId = this.options.credentialProtector.decryptString(Buffer.from(settings.encryptedAccessKeyId, 'base64'));
      const secretAccessKey = this.options.credentialProtector.decryptString(Buffer.from(settings.encryptedSecretAccessKey, 'base64'));
      if (!accessKeyId || !secretAccessKey) throw new Error('empty credentials');
      return { accessKeyId, secretAccessKey };
    } catch {
      throw new Error('S3 credentials are unavailable. Save them again.');
    }
  }

  private hasSecureCredentialStorage(): boolean {
    try {
      if (!this.options.credentialProtector.isEncryptionAvailable()) return false;
      return this.options.credentialProtector.getSelectedStorageBackend?.() !== 'basic_text';
    } catch {
      return false;
    }
  }

  private async performSync(): Promise<S3SyncResult> {
    if (this.shuttingDown) throw new Error('S3 sync was cancelled.');
    const settings = { ...(await this.ensureSettings()) };
    if (!settings.bucketUrl) throw new Error('S3 sync settings are incomplete.');
    const { accessKeyId, secretAccessKey } = this.credentials(settings);

    let data: Record<string, unknown>;
    try {
      data = await this.options.snapshotProvider();
    } catch {
      throw new Error('Unable to prepare the S3 snapshot.');
    }
    if (!isRecord(data)) throw new Error('Unable to prepare the S3 snapshot.');

    const createdAt = this.now().toISOString();
    const revision = this.createRevision();
    const snapshot = createServiceManagerSnapshot(data, this.options.appVersion, revision, createdAt);
    const encrypted = encryptS3Snapshot(snapshot, secretAccessKey, this.createRandomBytes);
    const body = JSON.stringify(encrypted);
    const signed = signS3PutRequest({
      endpoint: buildS3SnapshotObjectUrl(settings.bucketUrl, settings.clientId, revision),
      region: settings.region,
      accessKeyId,
      secretAccessKey,
      payload: body,
      now: this.now(),
    });

    if (this.shuttingDown) throw new Error('S3 sync was cancelled.');

    const controller = new AbortController();
    this.activeAbortController = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      try {
        response = await this.fetchImpl(signed.url, {
          method: 'PUT',
          headers: signed.headers,
          body,
          signal: controller.signal,
          redirect: 'manual',
        });
      } catch {
        if (timedOut) throw new Error('S3 sync timed out.');
        if (this.shuttingDown || controller.signal.aborted) throw new Error('S3 sync was cancelled.');
        throw new Error('S3 sync request failed.');
      }

      if (!response.ok) {
        let responseBody = '';
        try {
          responseBody = await readBoundedResponseText(response, controller.signal);
        } catch {
          if (timedOut) throw new Error('S3 sync timed out.');
          if (this.shuttingDown || controller.signal.aborted) throw new Error('S3 sync was cancelled.');
        }
        if (timedOut) throw new Error('S3 sync timed out.');
        if (this.shuttingDown || controller.signal.aborted) throw new Error('S3 sync was cancelled.');
        throw safeHttpError(response.status, responseBody);
      }
      await response.body?.cancel().catch(() => undefined);
      if (timedOut) throw new Error('S3 sync timed out.');
      if (this.shuttingDown || controller.signal.aborted) throw new Error('S3 sync was cancelled.');
    } finally {
      clearTimeout(timeout);
      if (this.activeAbortController === controller) this.activeAbortController = undefined;
    }

    const syncedAt = this.now().toISOString();
    const etagHeader = response.headers.get('etag');
    const etag = etagHeader && etagHeader.length <= 512 && !/[\u0000-\u001f\u007f]/.test(etagHeader)
      ? etagHeader
      : undefined;
    const next: PersistedS3SyncSettings = {
      ...settings,
      lastSyncedAt: syncedAt,
      lastRevision: revision,
    };
    await this.persist(next);
    this.settings = next;
    return {
      syncedAt,
      revision,
      byteLength: Buffer.byteLength(body, 'utf8'),
      ...(etag ? { etag } : {}),
    };
  }
}
