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
import { isDeepStrictEqual } from 'node:util';
import type {
  Note,
  NoteImageLoadResult,
  NoteImageReference,
  NoteImageUploadInput,
  NoteImageUploadResult,
  S3ConnectionTestDraft,
  S3CredentialValues,
  S3SyncResult,
  S3SyncSettingsDraft,
  S3SyncSettingsView,
  S3SyncState,
} from '../shared/types';
import {
  createServiceManagerSyncRevisionV2,
  encryptS3RevisionV2,
  normalizeS3Bucket,
  normalizeS3Endpoint,
  splitLegacyS3BucketUrl,
  serializeEncryptedS3RevisionV2,
} from './s3SyncV2';
import {
  S3V3ObjectStore,
  assertS3SyncHeadMatchesManifestV3,
  createS3SyncHeadV3,
  createS3SyncEncryptionKey,
  createServiceManagerNoteObjectV3,
  createServiceManagerSyncManifestV3,
  createS3V3ObjectId,
  hashS3V3NoteContent,
  getS3SyncEncryptionKeyId,
  normalizeS3SyncEncryptionKey,
  parseS3V3ManifestData,
  testS3V3Connection,
  type S3V3ManifestData,
  type S3V3NoteReference,
  type ServiceManagerSyncManifestV3,
} from './s3SyncV3';
import {
  mergeS3SharedAppDataV2,
  parseS3SharedAppDataV2,
  type S3SharedAppDataV2,
} from './s3DataMerge';
import { NOTES_IMAGE_LIMITS, NotesImageS3Store } from './notesImageS3';
import { parseNoteImageReference } from '../shared/noteRichText';

const SETTINGS_SCHEMA_VERSION = 5;
const SNAPSHOT_SCHEMA_VERSION = 1;
const SYNC_VERSION = 1 as const;
const OBJECT_LAYOUT_VERSION = 1 as const;
const DEFAULT_REGION = 'us-east-1';
const DEFAULT_TIMEOUT_MS = 30_000;
const AUTO_SYNC_DEBOUNCE_MS = 2_000;
const AUTO_SYNC_INTERVAL_MS = 45_000;
const MAX_RECONCILE_ATTEMPTS = 4;
const MAX_LOCAL_RECOVERY_FILES = 20;
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

export type S3SnapshotProvider = () => Promise<unknown>;
export type S3SnapshotApplier = (
  data: S3SharedAppDataV2,
  expectedLocal?: S3SharedAppDataV2,
) => Promise<boolean | void>;

export interface S3SyncRuntimeOptions {
  userDataPath: string;
  appVersion: string;
  credentialProtector: S3CredentialProtector;
  snapshotProvider: S3SnapshotProvider;
  snapshotApplier?: S3SnapshotApplier;
  onStateChanged?: (state: S3SyncState) => void;
  onDataApplied?: () => void;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  createRevision?: () => string;
  createObjectId?: () => string;
  createClientId?: () => string;
  createRandomBytes?: (size: number) => Buffer;
  timeoutMs?: number;
}

interface PersistedS3SyncSettings {
  schemaVersion: 5;
  endpoint: string;
  bucket: string;
  region: string;
  clientId: string;
  encryptedAccessKeyId?: string;
  encryptedSecretAccessKey?: string;
  encryptedSyncEncryptionKey?: string;
  /** Retained only until an intentional Sync Encryption Key rotation succeeds. */
  encryptedPreviousSyncEncryptionKey?: string;
  lastSyncedAt?: string;
  lastRevision?: string;
  pendingSince?: string;
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
  const syncEncryptionKey = value.syncEncryptionKey === undefined
    ? undefined
    : normalizeS3SyncEncryptionKey(value.syncEncryptionKey);
  const clearCredentials = value.clearCredentials === true;
  if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
    throw new Error('Both the S3 access key ID and secret access key are required.');
  }
  if (clearCredentials && accessKeyId !== undefined) {
    throw new Error('Credentials cannot be saved and cleared at the same time.');
  }

  return {
    endpoint: normalizeS3Endpoint(value.endpoint),
    bucket: normalizeS3Bucket(value.bucket),
    region: normalizedRegion(value.region),
    ...(accessKeyId !== undefined ? { accessKeyId, secretAccessKey } : {}),
    ...(syncEncryptionKey !== undefined ? { syncEncryptionKey } : {}),
    ...(clearCredentials ? { clearCredentials: true } : {}),
  };
}

export function validateS3ConnectionTestDraft(value: unknown): S3ConnectionTestDraft {
  if (!isRecord(value)) {
    throw new Error('S3 connection settings are required.');
  }
  const accessKeyId = optionalCredential(value.accessKeyId, 'The S3 access key ID', MAX_ACCESS_KEY_LENGTH, true);
  const secretAccessKey = optionalCredential(value.secretAccessKey, 'The S3 secret access key', MAX_SECRET_KEY_LENGTH, false);
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error('Both the S3 access key ID and secret access key are required.');
  }
  return {
    endpoint: normalizeS3Endpoint(value.endpoint),
    bucket: normalizeS3Bucket(value.bucket),
    region: normalizedRegion(value.region),
    accessKeyId,
    secretAccessKey,
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
    endpoint: '',
    bucket: '',
    region: DEFAULT_REGION,
    clientId: normalizedClientId(clientId),
  };
}

function isConfigured(settings: PersistedS3SyncSettings): boolean {
  return Boolean(
    settings.endpoint
    && settings.bucket
    && settings.encryptedAccessKeyId
    && settings.encryptedSecretAccessKey
    && settings.encryptedSyncEncryptionKey,
  );
}

function cloneSyncState(state: S3SyncState): S3SyncState {
  return { ...state };
}

function settingsView(settings: PersistedS3SyncSettings, state: S3SyncState): S3SyncSettingsView {
  return {
    endpoint: settings.endpoint,
    bucket: settings.bucket,
    region: settings.region,
    hasCredentials: Boolean(settings.encryptedAccessKeyId && settings.encryptedSecretAccessKey),
    hasSyncEncryptionKey: Boolean(settings.encryptedSyncEncryptionKey),
    ...(settings.lastSyncedAt ? { lastSyncedAt: settings.lastSyncedAt } : {}),
    ...(settings.lastRevision ? { lastRevision: settings.lastRevision } : {}),
    syncState: cloneSyncState(state),
  };
}

function protectedCredential(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 16_384
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error('S3 sync settings are invalid.');
  }
  return value;
}

function parsePersistedSettings(
  value: unknown,
  createClientId: () => string,
): { settings: PersistedS3SyncSettings; migrated: boolean } {
  if (!isRecord(value)
    || (value.schemaVersion !== 1
      && value.schemaVersion !== 2
      && value.schemaVersion !== 3
      && value.schemaVersion !== 4
      && value.schemaVersion !== 5)) {
    throw new Error('S3 sync settings are invalid.');
  }
  const legacyV1 = value.schemaVersion === 1;
  const legacyV2 = value.schemaVersion === 2;
  const legacyCloudLayout = value.schemaVersion !== SETTINGS_SCHEMA_VERSION;
  if (legacyV1 && value.syncVersion !== 1) throw new Error('S3 sync settings are invalid.');

  let endpoint: string;
  let bucket: string;
  if (legacyV1 || legacyV2) {
    const bucketUrl = legacyV1 ? migrateLegacyObjectUrl(value.endpoint) : normalizedEndpoint(value.bucketUrl);
    ({ endpoint, bucket } = splitLegacyS3BucketUrl(bucketUrl));
  } else {
    endpoint = normalizeS3Endpoint(value.endpoint);
    bucket = normalizeS3Bucket(value.bucket);
  }

  const encryptedAccessKeyId = protectedCredential(value.encryptedAccessKeyId);
  const encryptedSecretAccessKey = protectedCredential(value.encryptedSecretAccessKey);
  const encryptedSyncEncryptionKey = protectedCredential(value.encryptedSyncEncryptionKey);
  const encryptedPreviousSyncEncryptionKey = protectedCredential(value.encryptedPreviousSyncEncryptionKey);
  if ((encryptedAccessKeyId === undefined) !== (encryptedSecretAccessKey === undefined)) {
    throw new Error('S3 sync settings are invalid.');
  }
  const settings: PersistedS3SyncSettings = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    endpoint,
    bucket,
    region: normalizedRegion(value.region),
    clientId: legacyV1 ? normalizedClientId(createClientId()) : normalizedClientId(value.clientId),
    ...(encryptedAccessKeyId ? { encryptedAccessKeyId, encryptedSecretAccessKey } : {}),
    ...(!legacyCloudLayout && encryptedSyncEncryptionKey ? { encryptedSyncEncryptionKey } : {}),
    ...(!legacyCloudLayout && encryptedPreviousSyncEncryptionKey ? { encryptedPreviousSyncEncryptionKey } : {}),
    ...(!legacyCloudLayout && isValidIsoTimestamp(value.lastSyncedAt)
      ? { lastSyncedAt: value.lastSyncedAt }
      : {}),
    ...(!legacyCloudLayout && typeof value.lastRevision === 'string'
      ? { lastRevision: normalizedRevision(value.lastRevision) }
      : {}),
    ...(!legacyCloudLayout && isValidIsoTimestamp(value.pendingSince)
      ? { pendingSince: value.pendingSince }
      : {}),
  };
  return { settings, migrated: value.schemaVersion !== SETTINGS_SCHEMA_VERSION };
}

function isOfflineSyncError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /request failed|timed out|sync failed \(5\d\d|temporar|network/i.test(message);
}

const S3_NOTE_TRANSFER_CONCURRENCY = 4;

function cloneNoteValue(note: Note): Note {
  return { ...note, tags: [...note.tags] };
}

function noteContentKey(id: string, contentHash: string): string {
  return `${id}\u0000${contentHash}`;
}

function noteReferenceKey(reference: S3V3NoteReference): string {
  return [
    reference.id,
    reference.objectId,
    reference.sha256,
    reference.contentHash,
    reference.encryptionKeyId,
  ].join('\u0000');
}

function compareStableIds(left: { id: string }, right: { id: string }): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const workers = Array.from(
    { length: Math.min(values.length, Math.max(1, concurrency)) },
    async () => {
      while (true) {
        if (failed) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        try {
          results[index] = await operation(values[index], index);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
          return;
        }
      }
    },
  );
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}

function sharedDataFromManifest(
  data: S3V3ManifestData,
  notes: Note[],
): S3SharedAppDataV2 {
  const parsed = parseS3SharedAppDataV2({
    schemaVersion: 2,
    hosts: data.hosts,
    notes: {
      schemaVersion: 2,
      notes: [...notes].sort(compareStableIds),
      tombstones: [...data.notes.tombstones].sort(compareStableIds),
    },
    proxy: data.proxy,
  });
  measureBoundedJsonBytes(parsed);
  return parsed;
}

function manifestDataFromShared(
  data: S3SharedAppDataV2,
  noteReferences: S3V3NoteReference[],
): S3V3ManifestData {
  return parseS3V3ManifestData({
    schemaVersion: 3,
    hosts: data.hosts,
    notes: {
      schemaVersion: 3,
      items: [...noteReferences].sort(compareStableIds),
      tombstones: [...data.notes.tombstones].sort(compareStableIds),
    },
    proxy: data.proxy,
  });
}

function canonicalizeSharedNotes(data: S3SharedAppDataV2): S3SharedAppDataV2 {
  return parseS3SharedAppDataV2({
    ...data,
    notes: {
      ...data.notes,
      notes: [...data.notes.notes].sort(compareStableIds),
      tombstones: [...data.notes.tombstones].sort(compareStableIds),
    },
  });
}

export class S3SyncRuntime {
  private readonly settingsPath: string;
  private readonly recoveryDirectory: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly createRevision: () => string;
  private readonly createObjectId: () => string;
  private readonly createClientId: () => string;
  private readonly createRandomBytes: (size: number) => Buffer;
  private readonly timeoutMs: number;
  private settings?: PersistedS3SyncSettings;
  private loading?: Promise<PersistedS3SyncSettings>;
  private operationQueue: Promise<void> = Promise.resolve();
  private settingsMutationQueue: Promise<void> = Promise.resolve();
  private syncPromise?: Promise<S3SyncResult>;
  private activeAbortController?: AbortController;
  private readonly activeConnectionTests = new Map<AbortController, Promise<void>>();
  private readonly activeNotesImageStores = new Set<NotesImageS3Store>();
  private debounceTimer?: NodeJS.Timeout;
  private intervalTimer?: NodeJS.Timeout;
  private dirtyGeneration = 0;
  private syncAgain = false;
  private autoStarted = false;
  private shuttingDown = false;
  private state: S3SyncState = { status: 'not-configured', pending: false };

  public constructor(private readonly options: S3SyncRuntimeOptions) {
    this.settingsPath = path.join(options.userDataPath, 's3-sync.json');
    this.recoveryDirectory = path.join(options.userDataPath, 's3-sync-recovery');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.createRevision = options.createRevision ?? randomUUID;
    this.createObjectId = options.createObjectId ?? (() => createS3V3ObjectId());
    this.createClientId = options.createClientId ?? randomUUID;
    this.createRandomBytes = options.createRandomBytes ?? randomBytes;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async getSettings(): Promise<S3SyncSettingsView> {
    const settings = await this.ensureSettings();
    return settingsView(settings, this.state);
  }

  public getS3SyncSettings(): Promise<S3SyncSettingsView> {
    return this.getSettings();
  }

  public getSyncState(): S3SyncState {
    return cloneSyncState(this.state);
  }

  public async startAutoSync(): Promise<void> {
    if (this.shuttingDown || this.autoStarted) return;
    this.autoStarted = true;
    const settings = await this.ensureSettings();
    if (this.shuttingDown) return;
    if (isConfigured(settings)) this.scheduleSync(0, false);
    this.intervalTimer = setInterval(() => {
      if (!this.shuttingDown) this.checkForRemoteChanges();
    }, AUTO_SYNC_INTERVAL_MS);
    this.intervalTimer.unref?.();
  }

  public checkForRemoteChanges(): void {
    if (this.shuttingDown) return;
    void this.ensureSettings().then((settings) => {
      if (isConfigured(settings) && !this.shuttingDown) this.scheduleSync(0, false);
    }).catch(() => undefined);
  }

  public markLocalChange(): void {
    if (this.shuttingDown) return;
    this.dirtyGeneration += 1;
    const pendingSince = this.state.pendingSince ?? this.now().toISOString();
    void this.enqueueSettingsMutation(async () => {
      const settings = await this.ensureSettings();
      if (!isConfigured(settings)) return false;
      const durablePendingSince = settings.pendingSince ?? pendingSince;
      let current = settings;
      let persistenceError: string | undefined;
      if (!settings.pendingSince) {
        const next = { ...settings, pendingSince: durablePendingSince };
        try {
          await this.persist(next);
          this.settings = next;
          current = next;
        } catch (error) {
          persistenceError = error instanceof Error ? error.message : 'S3 sync settings could not be saved.';
        }
      }
      this.updateState({
        status: persistenceError ? 'error' : this.syncPromise ? 'syncing' : 'pending',
        pending: true,
        pendingSince: durablePendingSince,
        ...(current.lastSyncedAt ? { lastSyncedAt: current.lastSyncedAt } : {}),
        ...(current.lastRevision ? { lastRevision: current.lastRevision } : {}),
        ...(persistenceError ? { message: persistenceError } : {}),
      });
      return true;
    }).then((configured) => {
      if (configured) this.scheduleSync(AUTO_SYNC_DEBOUNCE_MS, true);
    }).catch(() => undefined);
  }

  public revealS3SyncCredentials(): Promise<S3CredentialValues> {
    return this.enqueue(async () => {
      const settings = await this.ensureSettings();
      const result: S3CredentialValues = {};
      if (settings.encryptedAccessKeyId && settings.encryptedSecretAccessKey) {
        Object.assign(result, this.credentials(settings));
      }
      const syncEncryptionKey = this.syncEncryptionKey(settings, false);
      if (syncEncryptionKey) result.syncEncryptionKey = syncEncryptionKey;
      if (!result.accessKeyId && !result.syncEncryptionKey) {
        throw new Error('S3 credentials and Sync Encryption Key are unavailable.');
      }
      return result;
    });
  }

  public saveSettings(value: unknown): Promise<S3SyncSettingsView> {
    return this.enqueue(async () => {
      if (this.shuttingDown) throw new Error('S3 sync is shutting down.');
      const draft = validateS3SyncSettingsDraft(value);
      return this.enqueueSettingsMutation(async () => {
        const current = await this.ensureSettings();
        let encryptedAccessKeyId = current.encryptedAccessKeyId;
        let encryptedSecretAccessKey = current.encryptedSecretAccessKey;
        const sameS3Target = current.endpoint === draft.endpoint && current.bucket === draft.bucket;

        if (draft.clearCredentials) {
          encryptedAccessKeyId = undefined;
          encryptedSecretAccessKey = undefined;
        } else if (draft.accessKeyId !== undefined && draft.secretAccessKey !== undefined) {
          if (!this.hasSecureCredentialStorage()) throw new Error('Secure credential storage is unavailable.');
          try {
            encryptedAccessKeyId = this.options.credentialProtector.encryptString(draft.accessKeyId).toString('base64');
            encryptedSecretAccessKey = this.options.credentialProtector.encryptString(draft.secretAccessKey).toString('base64');
          } catch {
            throw new Error('S3 credentials could not be stored securely.');
          }
        }

        let encryptedSyncEncryptionKey = sameS3Target ? current.encryptedSyncEncryptionKey : undefined;
        let encryptedPreviousSyncEncryptionKey = sameS3Target
          ? current.encryptedPreviousSyncEncryptionKey
          : undefined;
        let currentSyncEncryptionKey: string | undefined;
        let currentSyncEncryptionKeyUnreadable = false;
        let previousSyncEncryptionKey: string | undefined;
        if (draft.syncEncryptionKey !== undefined && current.encryptedSyncEncryptionKey) {
          try {
            currentSyncEncryptionKey = this.syncEncryptionKey(current, false);
          } catch {
            currentSyncEncryptionKeyUnreadable = true;
          }
        }
        if (draft.syncEncryptionKey !== undefined && sameS3Target && encryptedPreviousSyncEncryptionKey) {
          try {
            previousSyncEncryptionKey = normalizeS3SyncEncryptionKey(
              this.optionalProtectedValue(
                encryptedPreviousSyncEncryptionKey,
                'The previous Sync Encryption Key',
              ),
            );
          } catch {
            // A damaged fallback must not permanently block Settings repair.
            encryptedPreviousSyncEncryptionKey = undefined;
          }
        }
        let nextSyncEncryptionKey = draft.syncEncryptionKey;
        if (!sameS3Target && nextSyncEncryptionKey === currentSyncEncryptionKey) {
          // Settings hydrates saved secrets into masked inputs. Carrying that
          // unchanged value to a different target is not an explicit key
          // choice, so target changes receive fresh encryption material.
          nextSyncEncryptionKey = undefined;
        }
        if (!nextSyncEncryptionKey && !sameS3Target && encryptedAccessKeyId && encryptedSecretAccessKey) {
          nextSyncEncryptionKey = createS3SyncEncryptionKey(this.createRandomBytes);
        } else if (!nextSyncEncryptionKey && !encryptedSyncEncryptionKey && encryptedAccessKeyId && encryptedSecretAccessKey) {
          nextSyncEncryptionKey = createS3SyncEncryptionKey(this.createRandomBytes);
        }
        if (nextSyncEncryptionKey) {
          const normalizedKey = normalizeS3SyncEncryptionKey(nextSyncEncryptionKey);
          if (currentSyncEncryptionKeyUnreadable) {
            if (!this.hasSecureCredentialStorage()) throw new Error('Secure credential storage is unavailable.');
            try {
              encryptedSyncEncryptionKey = this.protectValue(normalizedKey);
              if (previousSyncEncryptionKey === normalizedKey) {
                encryptedPreviousSyncEncryptionKey = undefined;
              }
            } catch {
              throw new Error('The Sync Encryption Key could not be stored securely.');
            }
          } else if (currentSyncEncryptionKey !== normalizedKey) {
            if (sameS3Target && encryptedPreviousSyncEncryptionKey) {
              throw new Error('Finish the pending Sync Encryption Key migration before changing it again.');
            }
            if (!this.hasSecureCredentialStorage()) throw new Error('Secure credential storage is unavailable.');
            try {
              if (sameS3Target && currentSyncEncryptionKey) {
                encryptedPreviousSyncEncryptionKey = current.encryptedSyncEncryptionKey;
              } else {
                encryptedPreviousSyncEncryptionKey = undefined;
              }
              encryptedSyncEncryptionKey = this.protectValue(normalizedKey);
            } catch {
              throw new Error('The Sync Encryption Key could not be stored securely.');
            }
          }
        }

        const configured = Boolean(
          draft.endpoint
          && draft.bucket
          && encryptedAccessKeyId
          && encryptedSecretAccessKey
          && encryptedSyncEncryptionKey,
        );
        const pendingSince = configured
          ? (current.pendingSince ?? this.now().toISOString())
          : undefined;
        const next: PersistedS3SyncSettings = {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          endpoint: draft.endpoint,
          bucket: draft.bucket,
          region: draft.region,
          clientId: current.clientId,
          ...(encryptedAccessKeyId && encryptedSecretAccessKey
            ? { encryptedAccessKeyId, encryptedSecretAccessKey }
            : {}),
          ...(encryptedSyncEncryptionKey ? { encryptedSyncEncryptionKey } : {}),
          ...(encryptedPreviousSyncEncryptionKey ? { encryptedPreviousSyncEncryptionKey } : {}),
          ...(sameS3Target && current.lastSyncedAt ? { lastSyncedAt: current.lastSyncedAt } : {}),
          ...(sameS3Target && current.lastRevision ? { lastRevision: current.lastRevision } : {}),
          ...(pendingSince ? { pendingSince } : {}),
        };
        await this.persist(next);
        this.settings = next;
        if (isConfigured(next)) {
          this.updateState({
            status: 'pending',
            pending: true,
            pendingSince: next.pendingSince as string,
            ...(next.lastSyncedAt ? { lastSyncedAt: next.lastSyncedAt } : {}),
            ...(next.lastRevision ? { lastRevision: next.lastRevision } : {}),
          });
          this.scheduleSync(0, true);
        } else {
          this.updateState({ status: 'not-configured', pending: false });
        }
        return settingsView(next, this.state);
      });
    });
  }

  public saveS3SyncSettings(value: unknown): Promise<S3SyncSettingsView> {
    return this.saveSettings(value);
  }

  public async testS3Connection(value: unknown): Promise<void> {
    if (this.shuttingDown) throw new Error('S3 connection test was cancelled.');
    const draft = validateS3ConnectionTestDraft(value);
    const controller = new AbortController();
    const test = testS3V3Connection({
      ...draft,
      fetchImpl: this.fetchImpl,
      now: this.now,
      timeoutMs: this.timeoutMs,
      signal: controller.signal,
    });
    this.activeConnectionTests.set(controller, test);
    try {
      await test;
    } finally {
      this.activeConnectionTests.delete(controller);
    }
  }

  public syncAllDataToS3(): Promise<S3SyncResult> {
    return this.requestSync(true);
  }

  public async uploadNoteImage(value: unknown): Promise<NoteImageUploadResult> {
    if (this.shuttingDown) throw new Error('Notes image upload was cancelled.');
    const input = this.validateNoteImageUploadInput(value);
    const settings = await this.ensureSettings();
    if (this.shuttingDown) throw new Error('Notes image upload was cancelled.');
    const store = this.createNotesImageStore(settings);
    if (!store) return { status: 'not-configured' };
    const target = `${settings.endpoint}\0${settings.bucket}`;
    this.activeNotesImageStores.add(store);
    try {
      const reference = await store.uploadImage(input.bytes, input.mimeType, input.alt);
      const current = await this.ensureSettings();
      if (`${current.endpoint}\0${current.bucket}` !== target) {
        throw new Error('S3 settings changed during the Notes image upload. Add the image again.');
      }
      return { status: 'uploaded', reference };
    } finally {
      await store.shutdown();
      this.activeNotesImageStores.delete(store);
    }
  }

  public async loadNoteImage(value: unknown): Promise<NoteImageLoadResult> {
    if (this.shuttingDown) return { status: 'error' };
    let reference: NoteImageReference;
    try {
      reference = parseNoteImageReference(value);
    } catch {
      return { status: 'error' };
    }
    const settings = await this.ensureSettings();
    if (this.shuttingDown) return { status: 'error' };
    const store = this.createNotesImageStore(settings);
    if (!store) return { status: 'not-configured' };
    this.activeNotesImageStores.add(store);
    try {
      const bytes = await store.downloadImage(reference);
      return {
        status: 'loaded',
        bytes: new Uint8Array(bytes),
        mimeType: reference.mimeType,
      };
    } catch (error) {
      return error instanceof Error && error.message === 'The S3 Notes image is unavailable.'
        ? { status: 'missing' }
        : { status: 'error' };
    } finally {
      await store.shutdown();
      this.activeNotesImageStores.delete(store);
    }
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.debounceTimer = undefined;
    this.intervalTimer = undefined;
    this.activeAbortController?.abort();
    for (const controller of this.activeConnectionTests.keys()) controller.abort();
    const imageShutdowns = [...this.activeNotesImageStores].map((store) => store.shutdown());
    try {
      await this.syncPromise;
    } catch {
      // Cancellation and request failures are already reflected in state.
    }
    await this.operationQueue;
    await this.settingsMutationQueue;
    await Promise.allSettled(this.activeConnectionTests.values());
    await Promise.allSettled(imageShutdowns);
  }

  private validateNoteImageUploadInput(value: unknown): NoteImageUploadInput {
    if (!isRecord(value) || !(value.bytes instanceof Uint8Array)) {
      throw new Error('The Notes image upload is invalid.');
    }
    if (Object.keys(value).some((key) => !['bytes', 'mimeType', 'alt'].includes(key))) {
      throw new Error('The Notes image upload is invalid.');
    }
    if (value.bytes.byteLength < 1 || value.bytes.byteLength > NOTES_IMAGE_LIMITS.bytes) {
      throw new Error(`A Notes image must not exceed ${NOTES_IMAGE_LIMITS.bytes / (1024 * 1024)} MiB.`);
    }
    if (value.mimeType !== undefined && (typeof value.mimeType !== 'string' || value.mimeType.length > 128)) {
      throw new Error('The Notes image type is invalid.');
    }
    if (value.alt !== undefined && (typeof value.alt !== 'string' || value.alt.length > 500)) {
      throw new Error('The Notes image alternative text is invalid.');
    }
    return {
      bytes: value.bytes,
      ...(value.mimeType !== undefined ? { mimeType: value.mimeType } : {}),
      ...(value.alt !== undefined ? { alt: value.alt } : {}),
    };
  }

  private createNotesImageStore(settings: PersistedS3SyncSettings): NotesImageS3Store | undefined {
    if (
      !settings.endpoint
      || !settings.bucket
      || !settings.encryptedAccessKeyId
      || !settings.encryptedSecretAccessKey
    ) {
      return undefined;
    }
    const credentials = this.credentials(settings);
    return new NotesImageS3Store({
      endpoint: settings.endpoint,
      bucket: settings.bucket,
      region: settings.region,
      ...credentials,
      fetchImpl: this.fetchImpl,
      now: this.now,
      createRandomBytes: this.createRandomBytes,
      timeoutMs: this.timeoutMs,
    });
  }

  private updateState(next: S3SyncState): void {
    this.state = cloneSyncState(next);
    try {
      this.options.onStateChanged?.(cloneSyncState(this.state));
    } catch {
      // Renderer state publication is best effort.
    }
  }

  private scheduleSync(delayMs: number, requireRerun: boolean): void {
    if (this.shuttingDown) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.requestSync(requireRerun).catch(() => undefined);
    }, Math.max(0, delayMs));
    this.debounceTimer.unref?.();
  }

  private requestSync(requireRerun: boolean): Promise<S3SyncResult> {
    if (this.shuttingDown) return Promise.reject(new Error('S3 sync was cancelled.'));
    if (this.syncPromise) {
      if (requireRerun) this.syncAgain = true;
      return this.syncPromise;
    }
    const promise = this.enqueue(() => this.performReconcile());
    this.syncPromise = promise;
    void promise.finally(() => {
      if (this.syncPromise === promise) this.syncPromise = undefined;
      if (this.syncAgain && !this.shuttingDown) {
        this.syncAgain = false;
        this.scheduleSync(0, false);
      }
    }).catch(() => undefined);
    return promise;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private enqueueSettingsMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.settingsMutationQueue.then(operation, operation);
    this.settingsMutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureSettings(): Promise<PersistedS3SyncSettings> {
    if (this.settings) return this.settings;
    if (!this.loading) {
      const loading = this.loadSettings().then((settings) => {
        this.settings = settings;
        if (isConfigured(settings)) {
          this.state = settings.pendingSince
            ? {
                status: 'pending',
                pending: true,
                pendingSince: settings.pendingSince,
                ...(settings.lastSyncedAt ? { lastSyncedAt: settings.lastSyncedAt } : {}),
                ...(settings.lastRevision ? { lastRevision: settings.lastRevision } : {}),
              }
            : settings.lastRevision
            ? {
                status: 'synced',
                pending: false,
                ...(settings.lastSyncedAt ? { lastSyncedAt: settings.lastSyncedAt } : {}),
                lastRevision: settings.lastRevision,
              }
            : { status: 'pending', pending: true, pendingSince: this.now().toISOString() };
        }
        return settings;
      }).catch((error) => {
        const settings = defaultSettings(this.createClientId());
        this.settings = settings;
        this.updateState({
          status: 'error',
          pending: false,
          message: error instanceof Error ? error.message : 'S3 sync settings could not be loaded.',
        });
        return settings;
      }).finally(() => {
        if (this.loading === loading) this.loading = undefined;
      });
      this.loading = loading;
    }
    return this.loading;
  }

  private async loadSettings(): Promise<PersistedS3SyncSettings> {
    try {
      const parsed = parsePersistedSettings(JSON.parse(await fs.readFile(this.settingsPath, 'utf8')), this.createClientId);
      let generatedSyncEncryptionKey = false;
      if (
        !parsed.settings.encryptedSyncEncryptionKey
        && this.hasSecureCredentialStorage()
        && (parsed.migrated || (
          parsed.settings.encryptedAccessKeyId
          && parsed.settings.encryptedSecretAccessKey
        ))
      ) {
        parsed.settings.encryptedSyncEncryptionKey = this.protectValue(
          createS3SyncEncryptionKey(this.createRandomBytes),
        );
        generatedSyncEncryptionKey = true;
      }
      if (parsed.migrated || generatedSyncEncryptionKey) await this.persist(parsed.settings);
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
    if (!this.hasSecureCredentialStorage()) throw new Error('S3 credentials are unavailable. Save them again.');
    try {
      const accessKeyId = this.options.credentialProtector.decryptString(Buffer.from(settings.encryptedAccessKeyId, 'base64'));
      const secretAccessKey = this.options.credentialProtector.decryptString(Buffer.from(settings.encryptedSecretAccessKey, 'base64'));
      if (!accessKeyId || !secretAccessKey) throw new Error('empty credentials');
      return { accessKeyId, secretAccessKey };
    } catch {
      throw new Error('S3 credentials are unavailable. Save them again.');
    }
  }

  private protectValue(value: string): string {
    if (!value || !this.hasSecureCredentialStorage()) throw new Error('Secure credential storage is unavailable.');
    return this.options.credentialProtector.encryptString(value).toString('base64');
  }

  private unprotectValue(value: string, label: string): string {
    if (!this.hasSecureCredentialStorage()) throw new Error(`${label} is unavailable. Save it again.`);
    try {
      return this.options.credentialProtector.decryptString(Buffer.from(value, 'base64'));
    } catch {
      throw new Error(`${label} is unavailable. Save it again.`);
    }
  }

  private syncEncryptionKey(settings: PersistedS3SyncSettings, required = true): string | undefined {
    if (!settings.encryptedSyncEncryptionKey) {
      if (required) throw new Error('A Sync Encryption Key is required.');
      return undefined;
    }
    try {
      return normalizeS3SyncEncryptionKey(
        this.unprotectValue(settings.encryptedSyncEncryptionKey, 'The Sync Encryption Key'),
      );
    } catch (error) {
      if (!required && !settings.encryptedSyncEncryptionKey) return undefined;
      throw error;
    }
  }

  private optionalProtectedValue(value: string | undefined, label: string): string | undefined {
    return value ? this.unprotectValue(value, label) : undefined;
  }

  private clearPendingIntent(expectedGeneration: number): Promise<PersistedS3SyncSettings> {
    return this.enqueueSettingsMutation(async () => {
      const current = await this.ensureSettings();
      if (this.dirtyGeneration !== expectedGeneration || !current.pendingSince) return current;
      const { pendingSince: _pendingSince, ...next } = current;
      await this.persist(next);
      this.settings = next;
      return next;
    });
  }

  private hasSecureCredentialStorage(): boolean {
    try {
      if (!this.options.credentialProtector.isEncryptionAvailable()) return false;
      return this.options.credentialProtector.getSelectedStorageBackend?.() !== 'basic_text';
    } catch {
      return false;
    }
  }

  private async collectLocalData(): Promise<S3SharedAppDataV2> {
    let data: unknown;
    try {
      data = await this.options.snapshotProvider();
    } catch {
      throw new Error('Unable to prepare the S3 snapshot.');
    }
    return canonicalizeSharedNotes(parseS3SharedAppDataV2(data));
  }

  private async applyData(
    data: S3SharedAppDataV2,
    expectedLocal?: S3SharedAppDataV2,
  ): Promise<boolean> {
    if (!this.options.snapshotApplier) throw new Error('Cloud data cannot be applied by this application version.');
    const applied = await this.options.snapshotApplier(data, expectedLocal);
    if (applied === false) return false;
    try {
      this.options.onDataApplied?.();
    } catch {
      // Renderer refresh publication is best effort.
    }
    return true;
  }

  private async applyDataIfLocalUnchanged(
    expectedLocal: S3SharedAppDataV2,
    expectedGeneration: number,
    data: S3SharedAppDataV2,
  ): Promise<boolean> {
    const currentLocal = await this.collectLocalData();
    if (this.dirtyGeneration !== expectedGeneration || !isDeepStrictEqual(currentLocal, expectedLocal)) {
      this.dirtyGeneration += 1;
      return false;
    }
    const applied = await this.applyData(data, expectedLocal);
    if (!applied) this.dirtyGeneration += 1;
    return applied;
  }

  private async commitSuccessfulRevision(
    _settings: PersistedS3SyncSettings,
    revision: string,
  ): Promise<{ settings: PersistedS3SyncSettings; syncedAt: string }> {
    return this.enqueueSettingsMutation(async () => {
      const current = await this.ensureSettings();
      const syncedAt = this.now().toISOString();
      const {
        encryptedPreviousSyncEncryptionKey: _previousKey,
        ...retained
      } = current;
      const next: PersistedS3SyncSettings = { ...retained, lastSyncedAt: syncedAt, lastRevision: revision };
      await this.persist(next);
      this.settings = next;
      return { settings: next, syncedAt };
    });
  }

  private async persistLocalRecovery(
    settings: PersistedS3SyncSettings,
    data: S3SharedAppDataV2,
    syncEncryptionKey: string,
  ): Promise<void> {
    const recoveryId = randomUUID();
    const revision = createServiceManagerSyncRevisionV2({ ...data }, {
      appVersion: this.options.appVersion,
      revision: recoveryId,
      clientId: settings.clientId,
      createdAt: this.now().toISOString(),
    });
    const body = serializeEncryptedS3RevisionV2(
      encryptS3RevisionV2(revision, syncEncryptionKey, this.createRandomBytes),
    );
    const filename = `${String(this.now().getTime()).padStart(16, '0')}-${recoveryId}.json`;
    const target = path.join(this.recoveryDirectory, filename);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await fs.mkdir(this.recoveryDirectory, { recursive: true });
      await fs.writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600).catch(() => undefined);
      const files = (await fs.readdir(this.recoveryDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /^\d{16}-[A-Za-z0-9_-]+\.json$/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
      await Promise.all(files.slice(0, Math.max(0, files.length - MAX_LOCAL_RECOVERY_FILES)).map((name) =>
        fs.unlink(path.join(this.recoveryDirectory, name)).catch(() => undefined)
      ));
    } catch {
      await fs.unlink(temporary).catch(() => undefined);
      throw new Error('A local encrypted conflict recovery could not be saved. Cloud data was not applied.');
    }
  }

  private async materializeManifest(
    objectStore: S3V3ObjectStore,
    manifest: ServiceManagerSyncManifestV3,
    manifestEncryptionKeyId: string,
    knownNotes: Map<string, Note>,
    objectCache: Map<string, Note>,
  ): Promise<S3SharedAppDataV2> {
    if (manifest.data.notes.items.some((reference) =>
      reference.encryptionKeyId !== manifestEncryptionKeyId
    )) {
      throw new Error('The S3 manifest mixes Note objects encrypted with a different key.');
    }
    const dataWithoutActiveNotes = sharedDataFromManifest(manifest.data, []);
    let materializedSnapshotBytes = measureBoundedJsonBytes(dataWithoutActiveNotes);
    let materializedNoteCount = 0;
    const retain = (note: Note): Note => {
      materializedSnapshotBytes += Buffer.byteLength(JSON.stringify(note), 'utf8')
        + (materializedNoteCount > 0 ? 1 : 0);
      materializedNoteCount += 1;
      if (materializedSnapshotBytes > MAX_SNAPSHOT_BYTES) {
        throw new Error('The application data snapshot is too large to sync.');
      }
      return cloneNoteValue(note);
    };
    const notes = await mapWithConcurrency(
      manifest.data.notes.items,
      S3_NOTE_TRANSFER_CONCURRENCY,
      async (reference) => {
        const key = noteContentKey(reference.id, reference.contentHash);
        const known = knownNotes.get(key);
        if (known) return retain(known);

        const referenceKey = noteReferenceKey(reference);
        const cached = objectCache.get(referenceKey);
        if (cached) {
          knownNotes.set(key, cloneNoteValue(cached));
          return retain(cached);
        }

        const result = await objectStore.getNote(reference);
        if (result.status === 'missing') {
          throw new Error('The S3 sync manifest points to a missing Note object.');
        }
        const note = cloneNoteValue(result.object.note);
        objectCache.set(referenceKey, note);
        knownNotes.set(key, note);
        return retain(note);
      },
    );
    return sharedDataFromManifest(manifest.data, notes);
  }

  private async publishRevision(
    objectStore: S3V3ObjectStore,
    settings: PersistedS3SyncSettings,
    data: S3SharedAppDataV2,
    parentRevision: string | undefined,
    expectedHeadEtag: string | undefined,
    reusableReferences: readonly S3V3NoteReference[],
  ): Promise<
    | { status: 'conflict'; noteReferences: S3V3NoteReference[] }
    | {
      status: 'written';
      manifest: ServiceManagerSyncManifestV3;
      byteLength: number;
      etag?: string;
    }
  > {
    measureBoundedJsonBytes(data);
    const currentEncryptionKeyId = getS3SyncEncryptionKeyId(this.syncEncryptionKey(settings) as string);
    const reusable = new Map<string, S3V3NoteReference>();
    for (const reference of reusableReferences) {
      if (reference.encryptionKeyId === currentEncryptionKeyId) {
        reusable.set(noteContentKey(reference.id, reference.contentHash), { ...reference });
      }
    }

    const revision = normalizedRevision(this.createRevision());
    const createdAt = this.now().toISOString();
    const plannedNotes: Array<
      | { note: Note; contentHash: string; reference: S3V3NoteReference }
      | {
        note: Note;
        contentHash: string;
        object: ReturnType<typeof createServiceManagerNoteObjectV3>;
      }
    > = data.notes.notes.map((note) => {
      const contentHash = hashS3V3NoteContent(note);
      const existing = reusable.get(noteContentKey(note.id, contentHash));
      if (existing) return { note, contentHash, reference: { ...existing } };
      return {
        note,
        contentHash,
        object: createServiceManagerNoteObjectV3(note, this.createObjectId()),
      };
    });

    // Validate every local Note, generated identity, revision, and the complete
    // manifest shape before the first immutable object is uploaded. The digest
    // placeholder has the same fixed width as the encrypted object digest.
    const placeholderReferences = plannedNotes.map((planned): S3V3NoteReference => (
      'reference' in planned
        ? { ...planned.reference }
        : {
          id: planned.note.id,
          objectId: planned.object.objectId,
          sha256: '0'.repeat(64),
          contentHash: planned.contentHash,
          encryptionKeyId: currentEncryptionKeyId,
        }
    ));
    createServiceManagerSyncManifestV3(
      manifestDataFromShared(data, placeholderReferences),
      {
        appVersion: this.options.appVersion,
        revision,
        ...(parentRevision ? { parentRevision } : {}),
        clientId: settings.clientId,
        createdAt,
      },
    );

    let byteLength = 0;
    const noteReferences = await mapWithConcurrency(
      plannedNotes,
      S3_NOTE_TRANSFER_CONCURRENCY,
      async (planned) => {
        if ('reference' in planned) return { ...planned.reference };

        for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
          const object = attempt === 0
            ? planned.object
            : createServiceManagerNoteObjectV3(planned.note, this.createObjectId());
          const written = await objectStore.putNote(object);
          if (written.status === 'conflict') continue;
          byteLength += written.byteLength;
          return { ...written.reference };
        }
        throw new Error('A unique S3 Note object could not be created. Try again.');
      },
    );

    const manifest = createServiceManagerSyncManifestV3(
      manifestDataFromShared(data, noteReferences),
      {
        appVersion: this.options.appVersion,
        revision,
        ...(parentRevision ? { parentRevision } : {}),
        clientId: settings.clientId,
        createdAt,
      },
    );
    const written = await objectStore.putManifest(manifest);
    if (written.status === 'conflict') return { status: 'conflict', noteReferences };
    byteLength += written.byteLength;
    const head = createS3SyncHeadV3(
      manifest,
      written.manifestSha256,
      currentEncryptionKeyId,
    );
    const headResult = await objectStore.putHead(head, expectedHeadEtag);
    if (headResult.status === 'conflict') return { status: 'conflict', noteReferences };
    return {
      status: 'written',
      manifest,
      byteLength,
      ...(headResult.etag ? { etag: headResult.etag } : {}),
    };
  }

  private async reconcile(
    settings: PersistedS3SyncSettings,
    signal: AbortSignal,
  ): Promise<S3SyncResult> {
    const { accessKeyId, secretAccessKey } = this.credentials(settings);
    const syncEncryptionKey = this.syncEncryptionKey(settings) as string;
    const previousSyncEncryptionKey = this.optionalProtectedValue(
      settings.encryptedPreviousSyncEncryptionKey,
      'The previous Sync Encryption Key',
    );
    if (previousSyncEncryptionKey) normalizeS3SyncEncryptionKey(previousSyncEncryptionKey);
    const objectStore = new S3V3ObjectStore({
      endpoint: settings.endpoint,
      bucket: settings.bucket,
      region: settings.region,
      accessKeyId,
      secretAccessKey,
      syncEncryptionKey,
      ...(previousSyncEncryptionKey ? { previousSyncEncryptionKey } : {}),
      fetchImpl: this.fetchImpl,
      now: this.now,
      createRandomBytes: this.createRandomBytes,
      timeoutMs: this.timeoutMs,
      signal,
    });
    let recoveredLocal: S3SharedAppDataV2 | undefined;
    const retainedUploadReferences = new Map<string, S3V3NoteReference>();
    const retainUploadedReferences = (references: readonly S3V3NoteReference[]): void => {
      for (const reference of references) {
        retainedUploadReferences.set(
          noteContentKey(reference.id, reference.contentHash),
          { ...reference },
        );
      }
    };

    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
      if (signal.aborted || this.shuttingDown) throw new Error('S3 sync was cancelled.');
      const headResult = await objectStore.getHead();

      if (headResult.status === 'missing') {
        const local = await this.collectLocalData();
        measureBoundedJsonBytes(local);
        const published = await this.publishRevision(
          objectStore,
          settings,
          local,
          undefined,
          undefined,
          [...retainedUploadReferences.values()],
        );
        if (published.status === 'conflict') {
          retainUploadedReferences(published.noteReferences);
          continue;
        }
        const committed = await this.commitSuccessfulRevision(settings, published.manifest.revision);
        return {
          action: 'pushed',
          syncedAt: committed.syncedAt,
          revision: published.manifest.revision,
          byteLength: published.byteLength,
          ...(published.etag ? { etag: published.etag } : {}),
        };
      }

      const remoteResult = await objectStore.getManifest(
        headResult.head.revision,
        headResult.head.manifestSha256,
      );
      if (remoteResult.status === 'missing') {
        throw new Error('The S3 sync head points to a missing manifest.');
      }
      assertS3SyncHeadMatchesManifestV3(
        headResult.head,
        remoteResult.manifest,
        remoteResult.manifestSha256,
      );
      if (headResult.head.encryptionKeyId !== remoteResult.encryptionKeyId) {
        throw new Error('The S3 sync head has an invalid Sync Encryption Key identity.');
      }
      const requiresEncryptionMigration = remoteResult.encryptionKeyId
        !== getS3SyncEncryptionKeyId(syncEncryptionKey);

      let baseManifest: ServiceManagerSyncManifestV3 | undefined;
      let baseReferencesUseCurrentEncryption = true;
      let baseEncryptionKeyId: string | undefined;
      if (settings.lastRevision === headResult.head.revision) {
        baseManifest = remoteResult.manifest;
        baseEncryptionKeyId = remoteResult.encryptionKeyId;
      } else if (settings.lastRevision) {
        const baseResult = await objectStore.getManifest(settings.lastRevision);
        if (baseResult.status === 'missing') {
          throw new Error('The previous S3 sync manifest is missing. Local changes were not merged.');
        }
        baseManifest = baseResult.manifest;
        baseEncryptionKeyId = baseResult.encryptionKeyId;
        baseReferencesUseCurrentEncryption = baseResult.encryptionKeyId
          === getS3SyncEncryptionKeyId(syncEncryptionKey);
      }

      const local = await this.collectLocalData();
      measureBoundedJsonBytes(local);
      const localGeneration = this.dirtyGeneration;
      const knownNotes = new Map<string, Note>();
      for (const note of local.notes.notes) {
        knownNotes.set(noteContentKey(note.id, hashS3V3NoteContent(note)), cloneNoteValue(note));
      }
      const objectCache = new Map<string, Note>();
      const cloud = await this.materializeManifest(
        objectStore,
        remoteResult.manifest,
        remoteResult.encryptionKeyId,
        knownNotes,
        objectCache,
      );
      const base = baseManifest
        ? await this.materializeManifest(
          objectStore,
          baseManifest,
          baseEncryptionKeyId as string,
          knownNotes,
          objectCache,
        )
        : undefined;

      const merged = mergeS3SharedAppDataV2({ base, local, cloud, now: this.now().toISOString() });
      const mergedData = canonicalizeSharedNotes(merged.data);
      measureBoundedJsonBytes(mergedData);
      if (merged.discardedLocalSections.length > 0
        && (!recoveredLocal || !isDeepStrictEqual(recoveredLocal, local))) {
        await this.persistLocalRecovery(settings, local, syncEncryptionKey);
        recoveredLocal = local;
      }
      const conflictCount = merged.conflictCount + merged.discardedLocalSections.length;
      const applyRequired = !isDeepStrictEqual(local, mergedData);
      if (isDeepStrictEqual(mergedData, cloud) && !requiresEncryptionMigration) {
        if (applyRequired
          && !await this.applyDataIfLocalUnchanged(local, localGeneration, mergedData)) {
          continue;
        }
        const committed = await this.commitSuccessfulRevision(settings, headResult.head.revision);
        return {
          action: conflictCount > 0 ? 'conflict' : applyRequired ? 'pulled' : 'up-to-date',
          syncedAt: committed.syncedAt,
          revision: headResult.head.revision,
          ...(conflictCount > 0 ? { conflictCount } : {}),
        };
      }

      const reusableReferences = [
        ...(!requiresEncryptionMigration && baseManifest && baseReferencesUseCurrentEncryption
          ? baseManifest.data.notes.items
          : []),
        ...retainedUploadReferences.values(),
        ...(!requiresEncryptionMigration ? remoteResult.manifest.data.notes.items : []),
      ];
      const published = await this.publishRevision(
        objectStore,
        settings,
        mergedData,
        headResult.head.revision,
        headResult.etag,
        reusableReferences,
      );
      if (published.status === 'conflict') {
        retainUploadedReferences(published.noteReferences);
        continue;
      }
      if (applyRequired
        && !await this.applyDataIfLocalUnchanged(local, localGeneration, mergedData)) {
        continue;
      }
      const committed = await this.commitSuccessfulRevision(settings, published.manifest.revision);
      return {
        action: conflictCount > 0 ? 'conflict' : 'pushed',
        syncedAt: committed.syncedAt,
        revision: published.manifest.revision,
        byteLength: published.byteLength,
        ...(published.etag ? { etag: published.etag } : {}),
        ...(conflictCount > 0 ? { conflictCount } : {}),
      };
    }
    throw new Error('S3 sync changed concurrently too many times. Try again.');
  }

  private async performReconcile(): Promise<S3SyncResult> {
    if (this.shuttingDown) throw new Error('S3 sync was cancelled.');
    const settings = { ...(await this.ensureSettings()) };
    if (!isConfigured(settings)) {
      this.updateState({ status: 'not-configured', pending: false });
      throw new Error('S3 sync settings are incomplete.');
    }
    const startingGeneration = this.dirtyGeneration;
    this.updateState({
      status: 'syncing',
      pending: this.state.pending,
      ...(this.state.pendingSince ? { pendingSince: this.state.pendingSince } : {}),
      ...(settings.lastSyncedAt ? { lastSyncedAt: settings.lastSyncedAt } : {}),
      ...(settings.lastRevision ? { lastRevision: settings.lastRevision } : {}),
    });
    const controller = new AbortController();
    this.activeAbortController = controller;
    try {
      const result = await this.reconcile(settings, controller.signal);
      if (this.dirtyGeneration !== startingGeneration) {
        this.updateState({
          status: 'pending',
          pending: true,
          pendingSince: this.state.pendingSince ?? this.now().toISOString(),
          lastSyncedAt: result.syncedAt,
          ...(result.revision ? { lastRevision: result.revision } : {}),
        });
        this.scheduleSync(AUTO_SYNC_DEBOUNCE_MS, true);
      } else {
        await this.clearPendingIntent(startingGeneration);
        if (this.dirtyGeneration !== startingGeneration) {
          this.updateState({
            status: 'pending',
            pending: true,
            pendingSince: this.state.pendingSince ?? this.now().toISOString(),
            lastSyncedAt: result.syncedAt,
            ...(result.revision ? { lastRevision: result.revision } : {}),
          });
          this.scheduleSync(AUTO_SYNC_DEBOUNCE_MS, true);
        } else {
          this.updateState({
            status: result.action === 'conflict' ? 'conflict' : 'synced',
            pending: false,
            lastSyncedAt: result.syncedAt,
            ...(result.revision ? { lastRevision: result.revision } : {}),
            ...(result.conflictCount ? { conflictCount: result.conflictCount } : {}),
          });
        }
      }
      return result;
    } catch (error) {
      if (this.shuttingDown || controller.signal.aborted) throw new Error('S3 sync was cancelled.');
      const message = error instanceof Error ? error.message : 'S3 sync failed.';
      this.updateState({
        status: isOfflineSyncError(error) ? 'offline' : 'error',
        pending: Boolean(settings.pendingSince)
          || this.state.pending
          || !settings.lastRevision
          || this.dirtyGeneration !== startingGeneration,
        ...(this.state.pendingSince ? { pendingSince: this.state.pendingSince } : {}),
        ...(settings.lastSyncedAt ? { lastSyncedAt: settings.lastSyncedAt } : {}),
        ...(settings.lastRevision ? { lastRevision: settings.lastRevision } : {}),
        message,
      });
      throw error;
    } finally {
      if (this.activeAbortController === controller) this.activeAbortController = undefined;
    }
  }
}
