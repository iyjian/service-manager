import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  Note,
  NoteAttachmentReference,
  NoteAttachmentUploadInput,
  NoteAttachmentUploadResult,
  NoteImageLoadResult,
  NoteImageReference,
  NoteImageUploadInput,
  NoteImageUploadResult,
  NoteShareDurationHours,
  NoteShareView,
  NotesTreeSnapshot,
  S3ConnectionTestDraft,
  S3CredentialValues,
  S3SyncResult,
  S3SyncProgressPhase,
  S3SyncSettingsDraft,
  S3SyncSettingsView,
  S3SyncState,
  StartupS3SyncState,
} from '../../shared/types';
import {
  canonicalizeS3Path,
  normalizeS3Bucket,
  normalizeS3Endpoint,
  splitS3BucketUrl,
} from './s3Request';
import {
  S3V4ObjectStore,
  assertS3SyncHeadMatchesManifestV4,
  createS3SyncHeadV4,
  createS3SyncEncryptionKey,
  createServiceManagerNoteObjectV4,
  createServiceManagerNotesTreeObjectV4,
  createServiceManagerSyncManifestV4,
  createS3V4ObjectId,
  hashS3V4NoteContent,
  hashS3V4NotesTreeContent,
  getS3SyncEncryptionKeyId,
  normalizeS3SyncEncryptionKey,
  parseS3V4ManifestData,
  parseS3V4NotesTreePayload,
  testS3V4Connection,
  type S3V4ManifestData,
  type S3V4NoteReference,
  type S3V4NotesTreePayload,
  type S3V4NotesTreeReference,
  type ServiceManagerSyncManifestV4,
} from './s3SyncV4';
import {
  mergeS3SharedAppData,
  parseS3SharedAppData,
  type S3SharedAppData,
  type S3NoteTombstone,
} from './s3DataMerge';
import { NOTES_IMAGE_LIMITS, NotesImageS3Store } from '../notes/notesImageS3';
import {
  parseNoteAttachmentReference,
  parseNoteImageReference,
} from '../../shared/noteRichText';
import {
  NOTES_ATTACHMENT_LIMITS,
  NotesAttachmentS3Store,
} from '../notes/notesAttachmentS3';
import { NotesShareS3Store } from '../notes/notesShareS3';

const SETTINGS_SCHEMA_VERSION = 6;
const DEFAULT_REGION = 'us-east-1';
const DEFAULT_TIMEOUT_MS = 30_000;
const AUTO_SYNC_DEBOUNCE_MS = 2_000;
const MAX_RECONCILE_ATTEMPTS = 4;
const MAX_LOCAL_RECOVERY_FILES = 20;
const MAX_ACTIVE_NOTES_ATTACHMENT_TRANSFERS = 2;
const MAX_ENDPOINT_LENGTH = 4_096;
const MAX_REGION_LENGTH = 128;
const MAX_ACCESS_KEY_LENGTH = 512;
const MAX_SECRET_KEY_LENGTH = 4_096;
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;
const LOCAL_RECOVERY_SCHEMA_VERSION = 1 as const;
const LOCAL_RECOVERY_ENCRYPTION_INFO = Buffer.from('service-manager-s3-local-recovery', 'utf8');
const LOCAL_RECOVERY_AAD_PREFIX = 'service-manager-s3-local-recovery\0';

export interface S3CredentialProtector {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export type S3SnapshotProvider = () => Promise<unknown>;
export type S3SnapshotApplier = (
  data: S3SharedAppData,
  expectedLocal?: S3SharedAppData,
) => Promise<boolean | void>;

export type S3LocalChange =
  | { kind: 'full' }
  | {
    kind: 'notes';
    upsertIds?: readonly string[];
    deleteIds?: readonly string[];
    treeChanged?: boolean;
  };

export interface S3NotesIncrementalIntent {
  upsertIds: string[];
  deleteIds: string[];
  includeTree: boolean;
}

export interface S3NotesIncrementalSnapshot {
  notes: Note[];
  tombstones: S3NoteTombstone[];
  notesTree?: NotesTreeSnapshot;
}

export type S3NotesIncrementalProvider = (
  intent: S3NotesIncrementalIntent,
) => Promise<S3NotesIncrementalSnapshot>;

export interface S3SyncRuntimeOptions {
  userDataPath: string;
  appVersion: string;
  credentialProtector: S3CredentialProtector;
  snapshotProvider: S3SnapshotProvider;
  notesIncrementalProvider?: S3NotesIncrementalProvider;
  snapshotApplier?: S3SnapshotApplier;
  onStateChanged?: (state: S3SyncState) => void;
  onStartupStateChanged?: (state: StartupS3SyncState) => void;
  onDataApplied?: () => void;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  createRevision?: () => string;
  createObjectId?: () => string;
  createClientId?: () => string;
  createRandomBytes?: (size: number) => Buffer;
  timeoutMs?: number;
}

type S3SyncProgressReporter = (
  phase: S3SyncProgressPhase,
  completedItems?: number,
  totalItems?: number,
) => void;

interface PersistedS3SyncSettings {
  schemaVersion: 6;
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

export interface S3LocalRecoverySnapshot {
  schemaVersion: 1;
  app: 'service-manager';
  objectType: 'local-conflict-recovery';
  appVersion: string;
  recoveryId: string;
  clientId: string;
  createdAt: string;
  data: S3SharedAppData;
}

export interface EncryptedS3LocalRecovery {
  schemaVersion: 1;
  app: 'service-manager';
  objectType: 'local-conflict-recovery';
  recoveryId: string;
  encryption: {
    algorithm: 'AES-256-GCM';
    kdf: 'HKDF-SHA256';
    keySource: 'sync-key';
    salt: string;
    iv: string;
    authTag: string;
  };
  ciphertext: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function normalizedBucketUrl(value: unknown): string {
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

function bucketUrlFromStoredS3Url(value: unknown): string {
  const bucketUrl = normalizedBucketUrl(value);
  const url = new URL(bucketUrl);
  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    throw new Error('The S3 bucket URL contains an invalid path encoding.');
  }
  if (segments.length > 1 && /\.json$/i.test(segments[segments.length - 1])) {
    url.pathname = `/${encodeURIComponent(segments[0])}`;
    return normalizedBucketUrl(url.toString());
  }
  return bucketUrl;
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

function deriveLocalRecoveryKey(syncEncryptionKey: string, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(normalizeS3SyncEncryptionKey(syncEncryptionKey), 'utf8'),
    salt,
    LOCAL_RECOVERY_ENCRYPTION_INFO,
    32,
  ));
}

function strictRecoveryBase64(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SNAPSHOT_BYTES * 2) {
    throw new Error('invalid base64');
  }
  if (!isStrictRecoveryBase64(value)) {
    throw new Error('invalid base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)) {
    throw new Error('invalid base64');
  }
  return decoded;
}

function isStrictRecoveryBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const firstPaddingIndex = value.indexOf('=');
  const dataLength = firstPaddingIndex === -1 ? value.length : firstPaddingIndex;
  if (firstPaddingIndex !== -1) {
    const paddingLength = value.length - firstPaddingIndex;
    if (!((paddingLength === 1 && dataLength % 4 === 3) || (paddingLength === 2 && dataLength % 4 === 2))) {
      return false;
    }
    for (let index = firstPaddingIndex; index < value.length; index += 1) {
      if (value.charCodeAt(index) !== 61) return false;
    }
  }
  for (let index = 0; index < dataLength; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !(code >= 65 && code <= 90)
      && !(code >= 97 && code <= 122)
      && !(code >= 48 && code <= 57)
      && code !== 43
      && code !== 47
    ) {
      return false;
    }
  }
  return true;
}

function describeRecoveryBase64Field(value: unknown, expectedBytes?: number): Record<string, unknown> {
  if (typeof value !== 'string') {
    return { type: Array.isArray(value) ? 'array' : typeof value, expectedBytes };
  }
  const paddingBytes = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const estimatedDecodedBytes = value.length % 4 === 0 ? Math.max(0, (value.length / 4 * 3) - paddingBytes) : undefined;
  const shouldScan = value.length <= 4096;
  const base64Pattern = shouldScan
    ? isStrictRecoveryBase64(value)
    : undefined;
  let decodedBytes: number | undefined;
  let canonicalBase64: boolean | undefined;
  if (base64Pattern === true) {
    const decoded = Buffer.from(value, 'base64');
    decodedBytes = decoded.byteLength;
    canonicalBase64 = decoded.toString('base64') === value;
  }
  return {
    type: 'string',
    chars: value.length,
    expectedBytes,
    estimatedDecodedBytes,
    scanned: shouldScan,
    decodedBytes,
    base64Pattern,
    canonicalBase64,
  };
}

function parseS3LocalRecoverySnapshot(value: unknown): S3LocalRecoverySnapshot {
  if (
    !isRecord(value)
    || value.schemaVersion !== LOCAL_RECOVERY_SCHEMA_VERSION
    || value.app !== 'service-manager'
    || value.objectType !== 'local-conflict-recovery'
    || typeof value.appVersion !== 'string'
    || value.appVersion.length === 0
    || value.appVersion.length > 128
    || !isValidIsoTimestamp(value.createdAt)
  ) {
    throw new Error('The local S3 conflict recovery is invalid.');
  }
  return {
    schemaVersion: LOCAL_RECOVERY_SCHEMA_VERSION,
    app: 'service-manager',
    objectType: 'local-conflict-recovery',
    appVersion: value.appVersion,
    recoveryId: normalizedRevision(value.recoveryId),
    clientId: normalizedClientId(value.clientId),
    createdAt: value.createdAt,
    data: parseS3SharedAppData(value.data),
  };
}

export function createS3LocalRecoverySnapshot(
  data: S3SharedAppData,
  options: {
    appVersion: string;
    recoveryId: string;
    clientId: string;
    createdAt?: string;
  },
): S3LocalRecoverySnapshot {
  return parseS3LocalRecoverySnapshot({
    schemaVersion: LOCAL_RECOVERY_SCHEMA_VERSION,
    app: 'service-manager',
    objectType: 'local-conflict-recovery',
    appVersion: options.appVersion,
    recoveryId: options.recoveryId,
    clientId: options.clientId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    data,
  });
}

function parseEncryptedS3LocalRecovery(value: unknown): EncryptedS3LocalRecovery {
  if (
    !isRecord(value)
    || value.schemaVersion !== LOCAL_RECOVERY_SCHEMA_VERSION
    || value.app !== 'service-manager'
    || value.objectType !== 'local-conflict-recovery'
    || !isRecord(value.encryption)
    || value.encryption.algorithm !== 'AES-256-GCM'
    || value.encryption.kdf !== 'HKDF-SHA256'
    || value.encryption.keySource !== 'sync-key'
    || typeof value.ciphertext !== 'string'
  ) {
    throw new Error('The encrypted local S3 conflict recovery is invalid.');
  }
  try {
    strictRecoveryBase64(value.encryption.salt, 16);
    strictRecoveryBase64(value.encryption.iv, 12);
    strictRecoveryBase64(value.encryption.authTag, 16);
    const ciphertext = strictRecoveryBase64(value.ciphertext);
    if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_SNAPSHOT_BYTES) throw new Error('invalid ciphertext');
  } catch (error) {
    console.warn('[s3:local-recovery] Invalid encrypted local S3 conflict recovery envelope.', {
      reason: error instanceof Error ? error.message : String(error),
      salt: describeRecoveryBase64Field(value.encryption.salt, 16),
      iv: describeRecoveryBase64Field(value.encryption.iv, 12),
      authTag: describeRecoveryBase64Field(value.encryption.authTag, 16),
      ciphertext: describeRecoveryBase64Field(value.ciphertext),
      maxCiphertextBytes: MAX_SNAPSHOT_BYTES,
    });
    throw new Error('The encrypted local S3 conflict recovery is invalid.');
  }
  return {
    schemaVersion: LOCAL_RECOVERY_SCHEMA_VERSION,
    app: 'service-manager',
    objectType: 'local-conflict-recovery',
    recoveryId: normalizedRevision(value.recoveryId),
    encryption: {
      algorithm: 'AES-256-GCM',
      kdf: 'HKDF-SHA256',
      keySource: 'sync-key',
      salt: value.encryption.salt as string,
      iv: value.encryption.iv as string,
      authTag: value.encryption.authTag as string,
    },
    ciphertext: value.ciphertext as string,
  };
}

export function encryptS3LocalRecovery(
  snapshot: S3LocalRecoverySnapshot,
  syncEncryptionKey: string,
  createBytes: (size: number) => Buffer = randomBytes,
): EncryptedS3LocalRecovery {
  const parsed = parseS3LocalRecoverySnapshot(snapshot);
  measureBoundedJsonBytes(parsed);
  const plaintext = Buffer.from(JSON.stringify(parsed), 'utf8');
  if (plaintext.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error('The application data snapshot is too large to sync.');
  }
  const salt = createBytes(16);
  const iv = createBytes(12);
  if (!Buffer.isBuffer(salt) || salt.byteLength !== 16 || !Buffer.isBuffer(iv) || iv.byteLength !== 12) {
    throw new Error('Secure snapshot randomness is unavailable.');
  }
  const cipher = createCipheriv('aes-256-gcm', deriveLocalRecoveryKey(syncEncryptionKey, salt), iv);
  cipher.setAAD(Buffer.from(`${LOCAL_RECOVERY_AAD_PREFIX}${parsed.recoveryId}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    schemaVersion: LOCAL_RECOVERY_SCHEMA_VERSION,
    app: 'service-manager',
    objectType: 'local-conflict-recovery',
    recoveryId: parsed.recoveryId,
    encryption: {
      algorithm: 'AES-256-GCM',
      kdf: 'HKDF-SHA256',
      keySource: 'sync-key',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    },
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptS3LocalRecovery(value: unknown, syncEncryptionKey: string): S3LocalRecoverySnapshot {
  try {
    const envelope = parseEncryptedS3LocalRecovery(value);
    const salt = strictRecoveryBase64(envelope.encryption.salt, 16);
    const iv = strictRecoveryBase64(envelope.encryption.iv, 12);
    const authTag = strictRecoveryBase64(envelope.encryption.authTag, 16);
    const ciphertext = strictRecoveryBase64(envelope.ciphertext);
    const decipher = createDecipheriv('aes-256-gcm', deriveLocalRecoveryKey(syncEncryptionKey, salt), iv);
    decipher.setAAD(Buffer.from(`${LOCAL_RECOVERY_AAD_PREFIX}${envelope.recoveryId}`, 'utf8'));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.byteLength > MAX_SNAPSHOT_BYTES) throw new Error('oversized plaintext');
    const recovery = parseS3LocalRecoverySnapshot(JSON.parse(plaintext.toString('utf8')));
    if (recovery.recoveryId !== envelope.recoveryId) throw new Error('recovery identity mismatch');
    return recovery;
  } catch {
    throw new Error('The encrypted local S3 conflict recovery could not be decrypted.');
  }
}

export function serializeEncryptedS3LocalRecovery(value: EncryptedS3LocalRecovery): string {
  return JSON.stringify(parseEncryptedS3LocalRecovery(value));
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
      && value.schemaVersion !== 5
      && value.schemaVersion !== 6)) {
    throw new Error('S3 sync settings are invalid.');
  }
  const schemaUsesObjectUrl = value.schemaVersion === 1;
  const schemaUsesBucketUrl = value.schemaVersion === 2;
  const currentCloudLayout = value.schemaVersion === SETTINGS_SCHEMA_VERSION;
  const hasIndependentSyncKey = value.schemaVersion === 5 || currentCloudLayout;
  if (schemaUsesObjectUrl && value.syncVersion !== 1) throw new Error('S3 sync settings are invalid.');

  let endpoint: string;
  let bucket: string;
  if (schemaUsesObjectUrl || schemaUsesBucketUrl) {
    const bucketUrl = schemaUsesObjectUrl
      ? bucketUrlFromStoredS3Url(value.endpoint)
      : normalizedBucketUrl(value.bucketUrl);
    ({ endpoint, bucket } = splitS3BucketUrl(bucketUrl));
  } else {
    endpoint = normalizeS3Endpoint(value.endpoint);
    bucket = normalizeS3Bucket(value.bucket);
  }

  const encryptedAccessKeyId = protectedCredential(value.encryptedAccessKeyId);
  const encryptedSecretAccessKey = protectedCredential(value.encryptedSecretAccessKey);
  const encryptedSyncEncryptionKey = hasIndependentSyncKey
    ? protectedCredential(value.encryptedSyncEncryptionKey)
    : undefined;
  const encryptedPreviousSyncEncryptionKey = currentCloudLayout
    ? protectedCredential(value.encryptedPreviousSyncEncryptionKey)
    : undefined;
  if ((encryptedAccessKeyId === undefined) !== (encryptedSecretAccessKey === undefined)) {
    throw new Error('S3 sync settings are invalid.');
  }
  const settings: PersistedS3SyncSettings = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    endpoint,
    bucket,
    region: normalizedRegion(value.region),
    clientId: schemaUsesObjectUrl ? normalizedClientId(createClientId()) : normalizedClientId(value.clientId),
    ...(encryptedAccessKeyId ? { encryptedAccessKeyId, encryptedSecretAccessKey } : {}),
    ...(hasIndependentSyncKey && encryptedSyncEncryptionKey ? { encryptedSyncEncryptionKey } : {}),
    ...(currentCloudLayout && encryptedPreviousSyncEncryptionKey ? { encryptedPreviousSyncEncryptionKey } : {}),
    ...(currentCloudLayout && isValidIsoTimestamp(value.lastSyncedAt)
      ? { lastSyncedAt: value.lastSyncedAt }
      : {}),
    ...(currentCloudLayout && typeof value.lastRevision === 'string'
      ? { lastRevision: normalizedRevision(value.lastRevision) }
      : {}),
    ...(currentCloudLayout && isValidIsoTimestamp(value.pendingSince)
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

function cloneNotesTreeValue(tree: NotesTreeSnapshot): NotesTreeSnapshot {
  return {
    schemaVersion: 1,
    nodes: tree.nodes.map((node) => ({ ...node })),
  };
}

function noteContentKey(id: string, contentHash: string): string {
  return `${id}\u0000${contentHash}`;
}

function noteReferenceKey(reference: S3V4NoteReference): string {
  return [
    reference.id,
    reference.objectId,
    reference.sha256,
    reference.contentHash,
    reference.encryptionKeyId,
  ].join('\u0000');
}

function notesTreeReferenceKey(reference: S3V4NotesTreeReference): string {
  return [
    reference.objectId,
    reference.sha256,
    reference.contentHash,
    reference.encryptionKeyId,
  ].join('\u0000');
}

function notesTreePayloadFromSnapshot(tree: NotesTreeSnapshot): S3V4NotesTreePayload {
  const nodes = [...tree.nodes];
  const root = nodes
    .filter((node) => node.parentId === null)
    .sort((left, right) => left.order - right.order || (left.noteId < right.noteId ? -1 : left.noteId > right.noteId ? 1 : 0))
    .map((node) => node.noteId);
  const sorted = nodes.sort((left, right) => left.noteId < right.noteId ? -1 : left.noteId > right.noteId ? 1 : 0);
  return parseS3V4NotesTreePayload({
    schemaVersion: 1,
    root,
    order: Object.fromEntries(sorted.map((node) => [node.noteId, node.order])),
    parent: Object.fromEntries(sorted.map((node) => [node.noteId, node.parentId])),
  });
}

function notesTreeSnapshotFromPayload(tree: S3V4NotesTreePayload): NotesTreeSnapshot {
  const parsed = parseS3V4NotesTreePayload(tree);
  return {
    schemaVersion: 1,
    nodes: Object.keys(parsed.order).map((noteId) => ({
      noteId,
      parentId: parsed.parent[noteId],
      order: parsed.order[noteId],
    })),
  };
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
  data: S3V4ManifestData,
  notes: Note[],
  notesTree: NotesTreeSnapshot,
): S3SharedAppData {
  const parsed = parseS3SharedAppData({
    schemaVersion: 2,
    hosts: data.hosts,
    notes: {
      schemaVersion: 2,
      notes: [...notes].sort(compareStableIds),
      tombstones: [...data.notes.tombstones].sort(compareStableIds),
      tree: notesTree,
    },
    proxy: data.proxy,
  });
  measureBoundedJsonBytes(parsed);
  return parsed;
}

function manifestDataFromShared(
  data: S3SharedAppData,
  noteReferences: S3V4NoteReference[],
  notesTreeReference: S3V4NotesTreeReference,
): S3V4ManifestData {
  return parseS3V4ManifestData({
    schemaVersion: 4,
    hosts: data.hosts,
    notes: {
      schemaVersion: 4,
      items: [...noteReferences].sort(compareStableIds),
      tombstones: [...data.notes.tombstones].sort(compareStableIds),
      tree: notesTreeReference,
    },
    proxy: data.proxy,
  });
}

function canonicalizeSharedNotes(data: S3SharedAppData): S3SharedAppData {
  return parseS3SharedAppData({
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
  private shareOperationQueue: Promise<void> = Promise.resolve();
  private syncPromise?: Promise<S3SyncResult>;
  private activeAbortController?: AbortController;
  private readonly activeConnectionTests = new Map<AbortController, Promise<void>>();
  private readonly activeNotesImageStores = new Set<NotesImageS3Store>();
  private readonly activeNotesAttachmentStores = new Set<NotesAttachmentS3Store>();
  private readonly activeNotesAttachmentLoads = new Map<string, Promise<
    | { status: 'loaded'; bytes: Buffer; reference: NoteAttachmentReference }
    | { status: 'not-configured' | 'missing' | 'error' }
  >>();
  private activeNotesAttachmentTransfers = 0;
  private debounceTimer?: NodeJS.Timeout;
  private dirtyGeneration = 0;
  private pendingFullGeneration?: number;
  private readonly pendingNoteUpserts = new Map<string, number>();
  private readonly pendingNoteDeletes = new Map<string, number>();
  private pendingNotesTreeGeneration?: number;
  private baselineManifest?: ServiceManagerSyncManifestV4;
  private baselineHeadEtag?: string;
  private baselineEncryptionKeyId?: string;
  private startupSyncComplete = false;
  private syncAgain = false;
  private syncFullAgain = false;
  private autoStarted = false;
  private startupStatus: StartupS3SyncState['status'] = 'checking';
  private shuttingDown = false;
  private state: S3SyncState = { status: 'not-configured', pending: false };

  public constructor(private readonly options: S3SyncRuntimeOptions) {
    this.settingsPath = path.join(options.userDataPath, 's3-sync.json');
    this.recoveryDirectory = path.join(options.userDataPath, 's3-sync-recovery');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.createRevision = options.createRevision ?? randomUUID;
    this.createObjectId = options.createObjectId ?? (() => createS3V4ObjectId());
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

  public getStartupSyncState(): StartupS3SyncState {
    return {
      status: this.startupStatus,
      syncState: cloneSyncState(this.state),
    };
  }

  public async startAutoSync(): Promise<void> {
    if (this.shuttingDown || this.autoStarted) return;
    this.autoStarted = true;
    const settings = await this.ensureSettings();
    if (this.shuttingDown || !isConfigured(settings)) {
      this.updateStartupStatus('ready');
      return;
    }
    this.updateStartupStatus('syncing');
    try {
      await this.requestSync(false, true);
    } finally {
      this.updateStartupStatus('ready');
    }
  }

  public markLocalChange(change: S3LocalChange = { kind: 'full' }): void {
    if (this.shuttingDown) return;
    this.dirtyGeneration += 1;
    this.recordLocalChange(change, this.dirtyGeneration);
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
      const syncActive = !persistenceError && this.state.status === 'syncing';
      this.updateState({
        status: persistenceError ? 'error' : syncActive ? 'syncing' : 'pending',
        pending: true,
        pendingSince: durablePendingSince,
        ...(current.lastSyncedAt ? { lastSyncedAt: current.lastSyncedAt } : {}),
        ...(current.lastRevision ? { lastRevision: current.lastRevision } : {}),
        ...(persistenceError ? { message: persistenceError } : {}),
        ...(syncActive && this.state.phase ? {
          phase: this.state.phase,
          ...(this.state.completedItems !== undefined ? { completedItems: this.state.completedItems } : {}),
          ...(this.state.totalItems !== undefined ? { totalItems: this.state.totalItems } : {}),
        } : {}),
      });
      return true;
    }).then((configured) => {
      if (configured) this.scheduleSync(AUTO_SYNC_DEBOUNCE_MS, true, false);
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
        this.clearIncrementalBaseline();
        this.pendingFullGeneration = this.dirtyGeneration;
        if (isConfigured(next)) {
          this.updateState({
            status: 'pending',
            pending: true,
            pendingSince: next.pendingSince as string,
            ...(next.lastSyncedAt ? { lastSyncedAt: next.lastSyncedAt } : {}),
            ...(next.lastRevision ? { lastRevision: next.lastRevision } : {}),
          });
          this.scheduleSync(0, true, true);
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
    const test = testS3V4Connection({
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
    return this.requestSync(true, true);
  }

  public listNoteShares(noteId: string): Promise<NoteShareView[]> {
    return this.enqueueShareOperation(async () => {
      if (this.shuttingDown) throw new Error('Note sharing is shutting down.');
      const settings = await this.ensureSettings();
      const store = this.createNotesShareStore(settings);
      if (!store) return [];
      return store.list(noteId);
    });
  }

  public createNoteShare(note: Note, expiresInHours: NoteShareDurationHours): Promise<NoteShareView> {
    return this.enqueueShareOperation(async () => {
      if (this.shuttingDown) throw new Error('Note sharing is shutting down.');
      const settings = await this.ensureSettings();
      const store = this.createNotesShareStore(settings);
      if (!store) throw new Error('Configure S3 before sharing a Note.');
      return store.create(note, expiresInHours, {
        loadImage: async (reference) => {
          const loaded = await this.loadNoteImage(reference);
          if (loaded.status !== 'loaded') throw new Error('A shared Note image is unavailable.');
          return Buffer.from(loaded.bytes);
        },
        loadAttachment: async (reference) => {
          const loaded = await this.loadNoteAttachment(reference);
          if (loaded.status !== 'loaded') throw new Error('A shared Note attachment is unavailable.');
          return loaded.bytes;
        },
      });
    });
  }

  public resignNoteShare(
    noteId: string,
    shareId: string,
    expiresInHours: NoteShareDurationHours,
  ): Promise<NoteShareView> {
    return this.enqueueShareOperation(async () => {
      if (this.shuttingDown) throw new Error('Note sharing is shutting down.');
      const settings = await this.ensureSettings();
      const store = this.createNotesShareStore(settings);
      if (!store) throw new Error('Configure S3 before sharing a Note.');
      return store.resign(noteId, shareId, expiresInHours);
    });
  }

  public deleteNoteShare(noteId: string, shareId: string): Promise<void> {
    return this.enqueueShareOperation(async () => {
      if (this.shuttingDown) throw new Error('Note sharing is shutting down.');
      const settings = await this.ensureSettings();
      const store = this.createNotesShareStore(settings);
      if (!store) throw new Error('Configure S3 before managing Note shares.');
      await store.delete(noteId, shareId);
    });
  }

  public async uploadNoteImage(value: unknown, signal?: AbortSignal): Promise<NoteImageUploadResult> {
    if (this.shuttingDown || signal?.aborted) throw new Error('Notes image upload was cancelled.');
    const input = this.validateNoteImageUploadInput(value);
    const settings = await this.ensureSettings();
    if (this.shuttingDown || signal?.aborted) throw new Error('Notes image upload was cancelled.');
    const store = this.createNotesImageStore(settings, signal);
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

  public async uploadNoteAttachment(value: unknown): Promise<NoteAttachmentUploadResult> {
    if (this.shuttingDown) throw new Error('Notes attachment upload was cancelled.');
    const input = this.validateNoteAttachmentUploadInput(value);
    const releaseTransfer = this.beginNotesAttachmentTransfer();
    try {
      const settings = await this.ensureSettings();
      if (this.shuttingDown) throw new Error('Notes attachment upload was cancelled.');
      const store = this.createNotesAttachmentStore(settings);
      if (!store) return { status: 'not-configured' };
      const target = `${settings.endpoint}\0${settings.bucket}`;
      this.activeNotesAttachmentStores.add(store);
      try {
        const reference = await store.uploadAttachment(input.bytes, input.fileName, input.mimeType);
        const current = await this.ensureSettings();
        if (`${current.endpoint}\0${current.bucket}` !== target) {
          throw new Error('S3 settings changed during the Notes attachment upload. Add the file again.');
        }
        return { status: 'uploaded', reference };
      } finally {
        await store.shutdown();
        this.activeNotesAttachmentStores.delete(store);
      }
    } finally {
      releaseTransfer();
    }
  }

  public async loadNoteAttachment(value: unknown): Promise<
    | { status: 'loaded'; bytes: Buffer; reference: NoteAttachmentReference }
    | { status: 'not-configured' | 'missing' | 'error' }
  > {
    if (this.shuttingDown) return { status: 'error' };
    let reference: NoteAttachmentReference;
    try {
      reference = parseNoteAttachmentReference(value);
    } catch {
      return { status: 'error' };
    }
    const loadKey = [
      reference.objectId,
      reference.assetKey,
      reference.ciphertextSha256,
      reference.contentSha256,
      reference.fileName,
      reference.mimeType,
      String(reference.byteLength),
    ].join('\0');
    const existing = this.activeNotesAttachmentLoads.get(loadKey);
    if (existing) return existing;
    const request = this.loadNoteAttachmentOwned(reference);
    this.activeNotesAttachmentLoads.set(loadKey, request);
    try {
      return await request;
    } finally {
      if (this.activeNotesAttachmentLoads.get(loadKey) === request) {
        this.activeNotesAttachmentLoads.delete(loadKey);
      }
    }
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.activeAbortController?.abort();
    for (const controller of this.activeConnectionTests.keys()) controller.abort();
    const imageShutdowns = [...this.activeNotesImageStores].map((store) => store.shutdown());
    const attachmentShutdowns = [...this.activeNotesAttachmentStores].map((store) => store.shutdown());
    try {
      await this.syncPromise;
    } catch {
      // Cancellation and request failures are already reflected in state.
    }
    await this.operationQueue;
    await this.settingsMutationQueue;
    await this.shareOperationQueue;
    await Promise.allSettled(this.activeConnectionTests.values());
    await Promise.allSettled(this.activeNotesAttachmentLoads.values());
    await Promise.allSettled(imageShutdowns);
    await Promise.allSettled(attachmentShutdowns);
  }

  private beginNotesAttachmentTransfer(): () => void {
    if (this.shuttingDown) {
      throw new Error('Notes attachment storage is shutting down.');
    }
    if (this.activeNotesAttachmentTransfers >= MAX_ACTIVE_NOTES_ATTACHMENT_TRANSFERS) {
      throw new Error('Too many Notes attachment transfers are active. Try again shortly.');
    }
    this.activeNotesAttachmentTransfers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeNotesAttachmentTransfers = Math.max(0, this.activeNotesAttachmentTransfers - 1);
    };
  }

  private async loadNoteAttachmentOwned(reference: NoteAttachmentReference): Promise<
    | { status: 'loaded'; bytes: Buffer; reference: NoteAttachmentReference }
    | { status: 'not-configured' | 'missing' | 'error' }
  > {
    let releaseTransfer: (() => void) | undefined;
    try {
      releaseTransfer = this.beginNotesAttachmentTransfer();
      const settings = await this.ensureSettings();
      if (this.shuttingDown) return { status: 'error' };
      const store = this.createNotesAttachmentStore(settings);
      if (!store) return { status: 'not-configured' };
      this.activeNotesAttachmentStores.add(store);
      try {
        const bytes = await store.downloadAttachment(reference);
        return { status: 'loaded', bytes, reference };
      } catch (error) {
        return error instanceof Error && error.message === 'The S3 Notes attachment is unavailable.'
          ? { status: 'missing' }
          : { status: 'error' };
      } finally {
        await store.shutdown();
        this.activeNotesAttachmentStores.delete(store);
      }
    } catch {
      return { status: 'error' };
    } finally {
      releaseTransfer?.();
    }
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

  private validateNoteAttachmentUploadInput(value: unknown): NoteAttachmentUploadInput {
    if (!isRecord(value) || !(value.bytes instanceof Uint8Array)) {
      throw new Error('The Notes attachment upload is invalid.');
    }
    if (Object.keys(value).some((key) => !['bytes', 'fileName', 'mimeType'].includes(key))) {
      throw new Error('The Notes attachment upload is invalid.');
    }
    if (value.bytes.byteLength < 1 || value.bytes.byteLength > NOTES_ATTACHMENT_LIMITS.bytes) {
      throw new Error(`A Notes attachment must not exceed ${NOTES_ATTACHMENT_LIMITS.bytes / (1024 * 1024)} MiB.`);
    }
    if (
      typeof value.fileName !== 'string'
      || value.fileName.length < 1
      || value.fileName.length > NOTES_ATTACHMENT_LIMITS.fileNameCharacters
    ) {
      throw new Error('The Notes attachment file name is invalid.');
    }
    if (
      value.mimeType !== undefined
      && (typeof value.mimeType !== 'string' || value.mimeType.length > NOTES_ATTACHMENT_LIMITS.mimeTypeCharacters)
    ) {
      throw new Error('The Notes attachment type is invalid.');
    }
    return {
      bytes: value.bytes,
      fileName: value.fileName,
      ...(value.mimeType !== undefined ? { mimeType: value.mimeType } : {}),
    };
  }

  private createNotesImageStore(
    settings: PersistedS3SyncSettings,
    signal?: AbortSignal,
  ): NotesImageS3Store | undefined {
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
      ...(signal ? { signal } : {}),
    });
  }

  private createNotesAttachmentStore(
    settings: PersistedS3SyncSettings,
  ): NotesAttachmentS3Store | undefined {
    if (
      !settings.endpoint
      || !settings.bucket
      || !settings.encryptedAccessKeyId
      || !settings.encryptedSecretAccessKey
    ) {
      return undefined;
    }
    const credentials = this.credentials(settings);
    return new NotesAttachmentS3Store({
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

  private createNotesShareStore(settings: PersistedS3SyncSettings): NotesShareS3Store | undefined {
    if (
      !settings.endpoint
      || !settings.bucket
      || !settings.encryptedAccessKeyId
      || !settings.encryptedSecretAccessKey
    ) {
      return undefined;
    }
    const credentials = this.credentials(settings);
    return new NotesShareS3Store({
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

  private enqueueShareOperation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.shareOperationQueue.then(operation, operation);
    this.shareOperationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private updateState(next: S3SyncState): void {
    this.state = cloneSyncState(next);
    try {
      this.options.onStateChanged?.(cloneSyncState(this.state));
    } catch {
      // Renderer state publication is best effort.
    }
    this.publishStartupState();
  }

  private updateStartupStatus(status: StartupS3SyncState['status']): void {
    if (this.startupStatus === status) return;
    this.startupStatus = status;
    this.publishStartupState();
  }

  private publishStartupState(): void {
    try {
      this.options.onStartupStateChanged?.(this.getStartupSyncState());
    } catch {
      // Renderer startup-state publication is best effort.
    }
  }

  private reportSyncProgress(
    phase: S3SyncProgressPhase,
    completedItems?: number,
    totalItems?: number,
  ): void {
    if (this.state.status !== 'syncing') return;
    const hasCount = Number.isSafeInteger(completedItems)
      && Number.isSafeInteger(totalItems)
      && (totalItems as number) > 0;
    const normalizedTotal = hasCount ? Math.max(1, totalItems as number) : undefined;
    const normalizedCompleted = hasCount
      ? Math.min(normalizedTotal as number, Math.max(0, completedItems as number))
      : undefined;

    if (this.state.phase === phase) {
      if (normalizedTotal === undefined && this.state.totalItems === undefined) return;
      if (
        normalizedTotal !== undefined
        && normalizedCompleted !== undefined
        && this.state.totalItems === normalizedTotal
        && this.state.completedItems !== undefined
      ) {
        const previousPercent = Math.floor((this.state.completedItems * 100) / normalizedTotal);
        const nextPercent = Math.floor((normalizedCompleted * 100) / normalizedTotal);
        if (previousPercent === nextPercent && normalizedCompleted < normalizedTotal) return;
      }
    }

    const {
      phase: _phase,
      completedItems: _completedItems,
      totalItems: _totalItems,
      ...current
    } = this.state;
    this.updateState({
      ...current,
      status: 'syncing',
      phase,
      ...(normalizedCompleted !== undefined ? { completedItems: normalizedCompleted } : {}),
      ...(normalizedTotal !== undefined ? { totalItems: normalizedTotal } : {}),
    });
  }

  private recordLocalChange(change: S3LocalChange, generation: number): void {
    if (change.kind === 'full' || !this.options.notesIncrementalProvider) {
      this.pendingFullGeneration = generation;
      return;
    }
    for (const id of change.upsertIds ?? []) {
      this.pendingNoteDeletes.delete(id);
      this.pendingNoteUpserts.set(id, generation);
    }
    for (const id of change.deleteIds ?? []) {
      this.pendingNoteUpserts.delete(id);
      this.pendingNoteDeletes.set(id, generation);
    }
    if (change.treeChanged) this.pendingNotesTreeGeneration = generation;
  }

  private pendingNotesIntent(maximumGeneration: number): S3NotesIncrementalIntent | undefined {
    const upsertIds = [...this.pendingNoteUpserts]
      .filter(([, generation]) => generation <= maximumGeneration)
      .map(([id]) => id)
      .sort();
    const deleteIds = [...this.pendingNoteDeletes]
      .filter(([, generation]) => generation <= maximumGeneration)
      .map(([id]) => id)
      .sort();
    const includeTree = this.pendingNotesTreeGeneration !== undefined
      && this.pendingNotesTreeGeneration <= maximumGeneration;
    return upsertIds.length > 0 || deleteIds.length > 0 || includeTree
      ? { upsertIds, deleteIds, includeTree }
      : undefined;
  }

  private clearLocalChangesThrough(maximumGeneration: number): void {
    if (this.pendingFullGeneration !== undefined
      && this.pendingFullGeneration <= maximumGeneration) {
      this.pendingFullGeneration = undefined;
    }
    for (const [id, generation] of this.pendingNoteUpserts) {
      if (generation <= maximumGeneration) this.pendingNoteUpserts.delete(id);
    }
    for (const [id, generation] of this.pendingNoteDeletes) {
      if (generation <= maximumGeneration) this.pendingNoteDeletes.delete(id);
    }
    if (this.pendingNotesTreeGeneration !== undefined
      && this.pendingNotesTreeGeneration <= maximumGeneration) {
      this.pendingNotesTreeGeneration = undefined;
    }
  }

  private clearIncrementalBaseline(): void {
    this.baselineManifest = undefined;
    this.baselineHeadEtag = undefined;
    this.baselineEncryptionKeyId = undefined;
    this.startupSyncComplete = false;
  }

  private updateIncrementalBaseline(
    manifest: ServiceManagerSyncManifestV4,
    headEtag: string | undefined,
    encryptionKeyId: string,
  ): void {
    this.baselineManifest = manifest;
    this.baselineHeadEtag = headEtag;
    this.baselineEncryptionKeyId = encryptionKeyId;
    this.startupSyncComplete = true;
  }

  private scheduleSync(delayMs: number, requireRerun: boolean, forceFull: boolean): void {
    if (this.shuttingDown) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.requestSync(requireRerun, forceFull).catch(() => undefined);
    }, Math.max(0, delayMs));
    this.debounceTimer.unref?.();
  }

  private requestSync(requireRerun: boolean, forceFull: boolean): Promise<S3SyncResult> {
    if (this.shuttingDown) return Promise.reject(new Error('S3 sync was cancelled.'));
    if (this.syncPromise) {
      if (requireRerun) this.syncAgain = true;
      if (forceFull) this.syncFullAgain = true;
      return this.syncPromise;
    }
    const promise = this.enqueue(() => this.performSync(forceFull));
    this.syncPromise = promise;
    void promise.finally(() => {
      if (this.syncPromise === promise) this.syncPromise = undefined;
      if (this.syncAgain && !this.shuttingDown) {
        const rerunFull = this.syncFullAgain;
        this.syncAgain = false;
        this.syncFullAgain = false;
        this.scheduleSync(0, false, rerunFull);
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

  private async collectLocalData(): Promise<S3SharedAppData> {
    let data: unknown;
    try {
      data = await this.options.snapshotProvider();
    } catch {
      throw new Error('Unable to prepare the S3 snapshot.');
    }
    return canonicalizeSharedNotes(parseS3SharedAppData(data));
  }

  private async applyData(
    data: S3SharedAppData,
    expectedLocal?: S3SharedAppData,
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
    expectedLocal: S3SharedAppData,
    expectedGeneration: number,
    data: S3SharedAppData,
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
    data: S3SharedAppData,
    syncEncryptionKey: string,
  ): Promise<void> {
    const recoveryId = randomUUID();
    const recovery = createS3LocalRecoverySnapshot(data, {
      appVersion: this.options.appVersion,
      recoveryId,
      clientId: settings.clientId,
      createdAt: this.now().toISOString(),
    });
    const body = serializeEncryptedS3LocalRecovery(
      encryptS3LocalRecovery(recovery, syncEncryptionKey, this.createRandomBytes),
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
    objectStore: S3V4ObjectStore,
    manifest: ServiceManagerSyncManifestV4,
    manifestEncryptionKeyId: string,
    knownNotes: Map<string, Note>,
    objectCache: Map<string, Note>,
    knownTrees: Map<string, NotesTreeSnapshot>,
    treeObjectCache: Map<string, NotesTreeSnapshot>,
    onItemProcessed?: () => void,
  ): Promise<S3SharedAppData> {
    if (manifest.data.notes.items.some((reference) =>
      reference.encryptionKeyId !== manifestEncryptionKeyId
    )) {
      throw new Error('The S3 manifest mixes Note objects encrypted with a different key.');
    }
    if (manifest.data.notes.tree.encryptionKeyId !== manifestEncryptionKeyId) {
      throw new Error('The S3 manifest references a Notes tree encrypted with a different key.');
    }
    const treeReference = manifest.data.notes.tree;
    let notesTree = knownTrees.get(treeReference.contentHash);
    if (notesTree) {
      notesTree = cloneNotesTreeValue(notesTree);
    } else {
      const referenceKey = notesTreeReferenceKey(treeReference);
      notesTree = treeObjectCache.get(referenceKey);
      if (notesTree) {
        notesTree = cloneNotesTreeValue(notesTree);
      } else {
        const result = await objectStore.getNotesTree(treeReference);
        if (result.status === 'missing') {
          throw new Error('The S3 sync manifest points to a missing Notes tree object.');
        }
        notesTree = notesTreeSnapshotFromPayload(result.object.tree);
        treeObjectCache.set(referenceKey, cloneNotesTreeValue(notesTree));
      }
      knownTrees.set(treeReference.contentHash, cloneNotesTreeValue(notesTree));
    }

    const dataWithoutActiveNotes = sharedDataFromManifest(manifest.data, [], {
      schemaVersion: 1,
      nodes: [],
    });
    let materializedSnapshotBytes = measureBoundedJsonBytes(dataWithoutActiveNotes)
      + Buffer.byteLength(JSON.stringify(notesTree), 'utf8');
    if (materializedSnapshotBytes > MAX_SNAPSHOT_BYTES) {
      throw new Error('The application data snapshot is too large to sync.');
    }
    onItemProcessed?.();
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
    const retainAndReport = (note: Note): Note => {
      const retained = retain(note);
      onItemProcessed?.();
      return retained;
    };
    const notes = await mapWithConcurrency(
      manifest.data.notes.items,
      S3_NOTE_TRANSFER_CONCURRENCY,
      async (reference) => {
        const key = noteContentKey(reference.id, reference.contentHash);
        const known = knownNotes.get(key);
        if (known) return retainAndReport(known);

        const referenceKey = noteReferenceKey(reference);
        const cached = objectCache.get(referenceKey);
        if (cached) {
          knownNotes.set(key, cloneNoteValue(cached));
          return retainAndReport(cached);
        }

        const result = await objectStore.getNote(reference);
        if (result.status === 'missing') {
          throw new Error('The S3 sync manifest points to a missing Note object.');
        }
        const note = cloneNoteValue(result.object.note);
        objectCache.set(referenceKey, note);
        knownNotes.set(key, note);
        return retainAndReport(note);
      },
    );
    return sharedDataFromManifest(manifest.data, notes, notesTree);
  }

  private async publishRevision(
    objectStore: S3V4ObjectStore,
    settings: PersistedS3SyncSettings,
    data: S3SharedAppData,
    parentRevision: string | undefined,
    expectedHeadEtag: string | undefined,
    reusableReferences: readonly S3V4NoteReference[],
    reusableTreeReferences: readonly S3V4NotesTreeReference[],
    reportProgress: S3SyncProgressReporter,
  ): Promise<
    | {
      status: 'conflict';
      noteReferences: S3V4NoteReference[];
      notesTreeReference: S3V4NotesTreeReference;
    }
    | {
      status: 'written';
      manifest: ServiceManagerSyncManifestV4;
      byteLength: number;
      etag?: string;
    }
  > {
    measureBoundedJsonBytes(data);
    const currentEncryptionKeyId = getS3SyncEncryptionKeyId(this.syncEncryptionKey(settings) as string);
    const reusable = new Map<string, S3V4NoteReference>();
    for (const reference of reusableReferences) {
      if (reference.encryptionKeyId === currentEncryptionKeyId) {
        reusable.set(noteContentKey(reference.id, reference.contentHash), { ...reference });
      }
    }
    const reusableTrees = new Map<string, S3V4NotesTreeReference>();
    for (const reference of reusableTreeReferences) {
      if (reference.encryptionKeyId === currentEncryptionKeyId) {
        reusableTrees.set(reference.contentHash, { ...reference });
      }
    }

    const revision = normalizedRevision(this.createRevision());
    const createdAt = this.now().toISOString();
    const plannedNotes: Array<
      | { note: Note; contentHash: string; reference: S3V4NoteReference }
      | {
        note: Note;
        contentHash: string;
        object: ReturnType<typeof createServiceManagerNoteObjectV4>;
      }
    > = data.notes.notes.map((note) => {
      const contentHash = hashS3V4NoteContent(note);
      const existing = reusable.get(noteContentKey(note.id, contentHash));
      if (existing) return { note, contentHash, reference: { ...existing } };
      return {
        note,
        contentHash,
        object: createServiceManagerNoteObjectV4(note, this.createObjectId()),
      };
    });
    const notesTreePayload = notesTreePayloadFromSnapshot(data.notes.tree);
    const notesTreeContentHash = hashS3V4NotesTreeContent(notesTreePayload);
    const existingTreeReference = reusableTrees.get(notesTreeContentHash);
    const plannedNotesTree:
      | { kind: 'reference'; reference: S3V4NotesTreeReference }
      | { kind: 'object'; object: ReturnType<typeof createServiceManagerNotesTreeObjectV4> }
      = existingTreeReference
        ? { kind: 'reference', reference: { ...existingTreeReference } }
        : {
          kind: 'object',
          object: createServiceManagerNotesTreeObjectV4(notesTreePayload, this.createObjectId()),
        };

    // Validate every local Note, generated identity, revision, and the complete
    // manifest shape before the first immutable object is uploaded. The digest
    // placeholder has the same fixed width as the encrypted object digest.
    const placeholderReferences = plannedNotes.map((planned): S3V4NoteReference => (
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
    const placeholderTreeReference: S3V4NotesTreeReference = plannedNotesTree.kind === 'reference'
      ? { ...plannedNotesTree.reference }
      : {
        objectId: plannedNotesTree.object.objectId,
        sha256: '0'.repeat(64),
        contentHash: notesTreeContentHash,
        encryptionKeyId: currentEncryptionKeyId,
      };
    createServiceManagerSyncManifestV4(
      manifestDataFromShared(data, placeholderReferences, placeholderTreeReference),
      {
        appVersion: this.options.appVersion,
        revision,
        ...(parentRevision ? { parentRevision } : {}),
        clientId: settings.clientId,
        createdAt,
      },
    );

    const totalWrites = plannedNotes.reduce(
      (total, planned) => total + ('reference' in planned ? 0 : 1),
      plannedNotesTree.kind === 'object' ? 3 : 2,
    );
    let completedWrites = 0;
    const reportCompletedWrite = (): void => {
      completedWrites += 1;
      reportProgress('uploading', completedWrites, totalWrites);
    };
    reportProgress('uploading', 0, totalWrites);

    let byteLength = 0;
    const noteReferences = await mapWithConcurrency(
      plannedNotes,
      S3_NOTE_TRANSFER_CONCURRENCY,
      async (planned) => {
        if ('reference' in planned) return { ...planned.reference };

        for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
          const object = attempt === 0
            ? planned.object
            : createServiceManagerNoteObjectV4(planned.note, this.createObjectId());
          const written = await objectStore.putNote(object);
          if (written.status === 'conflict') continue;
          byteLength += written.byteLength;
          reportCompletedWrite();
          return { ...written.reference };
        }
        throw new Error('A unique S3 Note object could not be created. Try again.');
      },
    );

    let notesTreeReference: S3V4NotesTreeReference;
    if (plannedNotesTree.kind === 'reference') {
      notesTreeReference = { ...plannedNotesTree.reference };
    } else {
      let writtenReference: S3V4NotesTreeReference | undefined;
      for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
        const object = attempt === 0
          ? plannedNotesTree.object
          : createServiceManagerNotesTreeObjectV4(notesTreePayload, this.createObjectId());
        const writtenTree = await objectStore.putNotesTree(object);
        if (writtenTree.status === 'conflict') continue;
        byteLength += writtenTree.byteLength;
        writtenReference = { ...writtenTree.reference };
        break;
      }
      if (!writtenReference) throw new Error('A unique S3 Notes tree object could not be created. Try again.');
      notesTreeReference = writtenReference;
      reportCompletedWrite();
    }

    const manifest = createServiceManagerSyncManifestV4(
      manifestDataFromShared(data, noteReferences, notesTreeReference),
      {
        appVersion: this.options.appVersion,
        revision,
        ...(parentRevision ? { parentRevision } : {}),
        clientId: settings.clientId,
        createdAt,
      },
    );
    const written = await objectStore.putManifest(manifest);
    if (written.status === 'conflict') {
      return { status: 'conflict', noteReferences, notesTreeReference };
    }
    byteLength += written.byteLength;
    reportCompletedWrite();
    const head = createS3SyncHeadV4(
      manifest,
      written.manifestSha256,
      currentEncryptionKeyId,
    );
    const headResult = await objectStore.putHead(head, expectedHeadEtag);
    if (headResult.status === 'conflict') {
      return { status: 'conflict', noteReferences, notesTreeReference };
    }
    reportCompletedWrite();
    return {
      status: 'written',
      manifest,
      byteLength,
      ...(headResult.etag ? { etag: headResult.etag } : {}),
    };
  }

  private async publishIncrementalNotes(
    settings: PersistedS3SyncSettings,
    intent: S3NotesIncrementalIntent,
    expectedGeneration: number,
    signal: AbortSignal,
    reportProgress: S3SyncProgressReporter,
  ): Promise<{ status: 'conflict' } | { status: 'written'; result: S3SyncResult }> {
    const provider = this.options.notesIncrementalProvider;
    const baseline = this.baselineManifest;
    const expectedHeadEtag = this.baselineHeadEtag;
    const syncEncryptionKey = this.syncEncryptionKey(settings) as string;
    const currentEncryptionKeyId = getS3SyncEncryptionKeyId(syncEncryptionKey);
    if (!provider
      || !baseline
      || !expectedHeadEtag
      || this.baselineEncryptionKeyId !== currentEncryptionKeyId
      || settings.encryptedPreviousSyncEncryptionKey) {
      return { status: 'conflict' };
    }

    reportProgress('reading-local');
    let snapshot: S3NotesIncrementalSnapshot;
    try {
      snapshot = await provider(intent);
    } catch {
      throw new Error('Unable to prepare the changed Notes for S3 sync.');
    }
    if (this.dirtyGeneration !== expectedGeneration) return { status: 'conflict' };
    const requestedIds = new Set([...intent.upsertIds, ...intent.deleteIds]);
    const requestedUpserts = new Set(intent.upsertIds);
    const requestedDeletes = new Set(intent.deleteIds);
    const changedIds = new Set<string>();
    const notes: Note[] = [];
    for (const candidate of snapshot.notes) {
      const note = cloneNoteValue(candidate);
      hashS3V4NoteContent(note);
      if (!requestedUpserts.has(note.id) || changedIds.has(note.id)) {
        throw new Error('The changed Notes snapshot is invalid.');
      }
      changedIds.add(note.id);
      notes.push(note);
    }
    const tombstones: S3NoteTombstone[] = [];
    for (const candidate of snapshot.tombstones) {
      if (!requestedDeletes.has(candidate.id) || changedIds.has(candidate.id)) {
        throw new Error('The changed Notes snapshot is invalid.');
      }
      changedIds.add(candidate.id);
      tombstones.push({ id: candidate.id, deletedAt: candidate.deletedAt });
    }
    if (changedIds.size !== requestedIds.size) {
      throw new Error('The changed Notes snapshot is incomplete.');
    }
    if (intent.includeTree !== Boolean(snapshot.notesTree)) {
      throw new Error('The changed Notes tree snapshot is invalid.');
    }

    const { accessKeyId, secretAccessKey } = this.credentials(settings);
    const objectStore = new S3V4ObjectStore({
      endpoint: settings.endpoint,
      bucket: settings.bucket,
      region: settings.region,
      accessKeyId,
      secretAccessKey,
      syncEncryptionKey,
      fetchImpl: this.fetchImpl,
      now: this.now,
      createRandomBytes: this.createRandomBytes,
      timeoutMs: this.timeoutMs,
      signal,
    });
    const references = new Map(
      baseline.data.notes.items.map((reference) => [reference.id, { ...reference }]),
    );
    const nextTombstones = new Map(
      baseline.data.notes.tombstones.map((tombstone) => [tombstone.id, { ...tombstone }]),
    );
    const usedObjectIds = new Set([
      ...baseline.data.notes.items.map((reference) => reference.objectId),
      baseline.data.notes.tree.objectId,
    ]);
    const nextObjectId = (): string => {
      for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
        const objectId = this.createObjectId();
        if (!usedObjectIds.has(objectId)) {
          usedObjectIds.add(objectId);
          return objectId;
        }
      }
      throw new Error('A unique S3 object identity could not be created. Try again.');
    };
    const plannedNotes: Array<
      | { kind: 'reference'; note: Note; reference: S3V4NoteReference }
      | {
        kind: 'object';
        note: Note;
        contentHash: string;
        object: ReturnType<typeof createServiceManagerNoteObjectV4>;
      }
    > = [];
    for (const note of notes) {
      const contentHash = hashS3V4NoteContent(note);
      const existing = references.get(note.id);
      if (existing?.contentHash === contentHash
        && existing.encryptionKeyId === currentEncryptionKeyId) {
        plannedNotes.push({ kind: 'reference', note, reference: existing });
      } else {
        plannedNotes.push({
          kind: 'object',
          note,
          contentHash,
          object: createServiceManagerNoteObjectV4(note, nextObjectId()),
        });
      }
      nextTombstones.delete(note.id);
    }
    for (const tombstone of tombstones) {
      references.delete(tombstone.id);
      nextTombstones.set(tombstone.id, { ...tombstone });
    }

    let plannedTree:
      | { kind: 'reference'; reference: S3V4NotesTreeReference }
      | {
        kind: 'object';
        payload: S3V4NotesTreePayload;
        contentHash: string;
        object: ReturnType<typeof createServiceManagerNotesTreeObjectV4>;
      } = { kind: 'reference', reference: { ...baseline.data.notes.tree } };
    if (snapshot.notesTree) {
      const payload = notesTreePayloadFromSnapshot(snapshot.notesTree);
      const contentHash = hashS3V4NotesTreeContent(payload);
      if (contentHash !== baseline.data.notes.tree.contentHash
        || baseline.data.notes.tree.encryptionKeyId !== currentEncryptionKeyId) {
        plannedTree = {
          kind: 'object',
          payload,
          contentHash,
          object: createServiceManagerNotesTreeObjectV4(payload, nextObjectId()),
        };
      }
    }

    for (const planned of plannedNotes) {
      references.set(planned.note.id, planned.kind === 'reference'
        ? { ...planned.reference }
        : {
          id: planned.note.id,
          objectId: planned.object.objectId,
          sha256: '0'.repeat(64),
          contentHash: planned.contentHash,
          encryptionKeyId: currentEncryptionKeyId,
        });
    }
    const placeholderTreeReference: S3V4NotesTreeReference = plannedTree.kind === 'reference'
      ? { ...plannedTree.reference }
      : {
        objectId: plannedTree.object.objectId,
        sha256: '0'.repeat(64),
        contentHash: plannedTree.contentHash,
        encryptionKeyId: currentEncryptionKeyId,
      };
    const placeholderData = parseS3V4ManifestData({
      schemaVersion: 4,
      hosts: baseline.data.hosts,
      notes: {
        schemaVersion: 4,
        items: [...references.values()].sort(compareStableIds),
        tombstones: [...nextTombstones.values()].sort(compareStableIds),
        tree: placeholderTreeReference,
      },
      proxy: baseline.data.proxy,
    });
    if (isDeepStrictEqual(placeholderData, baseline.data)) {
      reportProgress('finishing');
      const committed = await this.commitSuccessfulRevision(settings, baseline.revision);
      return {
        status: 'written',
        result: {
          action: 'up-to-date',
          syncedAt: committed.syncedAt,
          revision: baseline.revision,
        },
      };
    }

    const noteObjects = plannedNotes.filter((planned): planned is Extract<
      (typeof plannedNotes)[number],
      { kind: 'object' }
    > => planned.kind === 'object');
    const totalWrites = noteObjects.length + (plannedTree.kind === 'object' ? 1 : 0) + 2;
    let completedWrites = 0;
    const reportCompletedWrite = (): void => {
      completedWrites += 1;
      reportProgress('uploading', completedWrites, totalWrites);
    };
    reportProgress('uploading', 0, totalWrites);
    let byteLength = 0;
    const writtenReferences = await mapWithConcurrency(
      noteObjects,
      S3_NOTE_TRANSFER_CONCURRENCY,
      async (planned) => {
        for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
          const object = attempt === 0
            ? planned.object
            : createServiceManagerNoteObjectV4(planned.note, nextObjectId());
          const written = await objectStore.putNote(object);
          if (written.status === 'conflict') continue;
          byteLength += written.byteLength;
          reportCompletedWrite();
          return { ...written.reference };
        }
        throw new Error('A unique S3 Note object could not be created. Try again.');
      },
    );
    for (const reference of writtenReferences) references.set(reference.id, reference);

    let notesTreeReference = plannedTree.kind === 'reference'
      ? { ...plannedTree.reference }
      : undefined;
    if (plannedTree.kind === 'object') {
      for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
        const object = attempt === 0
          ? plannedTree.object
          : createServiceManagerNotesTreeObjectV4(plannedTree.payload, nextObjectId());
        const written = await objectStore.putNotesTree(object);
        if (written.status === 'conflict') continue;
        byteLength += written.byteLength;
        notesTreeReference = { ...written.reference };
        reportCompletedWrite();
        break;
      }
      if (!notesTreeReference) throw new Error('A unique S3 Notes tree object could not be created. Try again.');
    }

    const revision = normalizedRevision(this.createRevision());
    const manifest = createServiceManagerSyncManifestV4(
      parseS3V4ManifestData({
        schemaVersion: 4,
        hosts: baseline.data.hosts,
        notes: {
          schemaVersion: 4,
          items: [...references.values()].sort(compareStableIds),
          tombstones: [...nextTombstones.values()].sort(compareStableIds),
          tree: notesTreeReference,
        },
        proxy: baseline.data.proxy,
      }),
      {
        appVersion: this.options.appVersion,
        revision,
        parentRevision: baseline.revision,
        clientId: settings.clientId,
        createdAt: this.now().toISOString(),
      },
    );
    const writtenManifest = await objectStore.putManifest(manifest);
    if (writtenManifest.status === 'conflict') return { status: 'conflict' };
    byteLength += writtenManifest.byteLength;
    reportCompletedWrite();
    const head = createS3SyncHeadV4(
      manifest,
      writtenManifest.manifestSha256,
      currentEncryptionKeyId,
    );
    const writtenHead = await objectStore.putHead(head, expectedHeadEtag);
    if (writtenHead.status === 'conflict') return { status: 'conflict' };
    reportCompletedWrite();
    reportProgress('finishing');
    const committed = await this.commitSuccessfulRevision(settings, manifest.revision);
    this.updateIncrementalBaseline(manifest, writtenHead.etag, currentEncryptionKeyId);
    return {
      status: 'written',
      result: {
        action: 'pushed',
        syncedAt: committed.syncedAt,
        revision: manifest.revision,
        byteLength,
        ...(writtenHead.etag ? { etag: writtenHead.etag } : {}),
      },
    };
  }

  private async reconcile(
    settings: PersistedS3SyncSettings,
    signal: AbortSignal,
    reportProgress: S3SyncProgressReporter,
  ): Promise<S3SyncResult> {
    const { accessKeyId, secretAccessKey } = this.credentials(settings);
    const syncEncryptionKey = this.syncEncryptionKey(settings) as string;
    const previousSyncEncryptionKey = this.optionalProtectedValue(
      settings.encryptedPreviousSyncEncryptionKey,
      'The previous Sync Encryption Key',
    );
    if (previousSyncEncryptionKey) normalizeS3SyncEncryptionKey(previousSyncEncryptionKey);
    const objectStore = new S3V4ObjectStore({
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
    let recoveredLocal: S3SharedAppData | undefined;
    const retainedUploadReferences = new Map<string, S3V4NoteReference>();
    const retainedUploadTreeReferences = new Map<string, S3V4NotesTreeReference>();
    const retainUploadedReferences = (references: readonly S3V4NoteReference[]): void => {
      for (const reference of references) {
        retainedUploadReferences.set(
          noteContentKey(reference.id, reference.contentHash),
          { ...reference },
        );
      }
    };
    const retainUploadedTreeReference = (reference: S3V4NotesTreeReference): void => {
      retainedUploadTreeReferences.set(reference.contentHash, { ...reference });
    };

    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
      if (signal.aborted || this.shuttingDown) throw new Error('S3 sync was cancelled.');
      reportProgress('checking');
      const headResult = await objectStore.getHead();

      if (headResult.status === 'missing') {
        reportProgress('reading-local');
        const local = await this.collectLocalData();
        measureBoundedJsonBytes(local);
        const published = await this.publishRevision(
          objectStore,
          settings,
          local,
          undefined,
          undefined,
          [...retainedUploadReferences.values()],
          [...retainedUploadTreeReferences.values()],
          reportProgress,
        );
        if (published.status === 'conflict') {
          retainUploadedReferences(published.noteReferences);
          retainUploadedTreeReference(published.notesTreeReference);
          continue;
        }
        reportProgress('finishing');
        const committed = await this.commitSuccessfulRevision(settings, published.manifest.revision);
        this.updateIncrementalBaseline(
          published.manifest,
          published.etag,
          getS3SyncEncryptionKeyId(syncEncryptionKey),
        );
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
      assertS3SyncHeadMatchesManifestV4(
        headResult.head,
        remoteResult.manifest,
        remoteResult.manifestSha256,
      );
      if (headResult.head.encryptionKeyId !== remoteResult.encryptionKeyId) {
        throw new Error('The S3 sync head has an invalid Sync Encryption Key identity.');
      }
      const requiresEncryptionMigration = remoteResult.encryptionKeyId
        !== getS3SyncEncryptionKeyId(syncEncryptionKey);

      let baseManifest: ServiceManagerSyncManifestV4 | undefined;
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

      reportProgress('reading-local');
      const local = await this.collectLocalData();
      measureBoundedJsonBytes(local);
      const localGeneration = this.dirtyGeneration;
      const knownNotes = new Map<string, Note>();
      for (const note of local.notes.notes) {
        knownNotes.set(noteContentKey(note.id, hashS3V4NoteContent(note)), cloneNoteValue(note));
      }
      const objectCache = new Map<string, Note>();
      const knownTrees = new Map<string, NotesTreeSnapshot>();
      const localTreePayload = notesTreePayloadFromSnapshot(local.notes.tree);
      knownTrees.set(hashS3V4NotesTreeContent(localTreePayload), cloneNotesTreeValue(local.notes.tree));
      const treeObjectCache = new Map<string, NotesTreeSnapshot>();
      const cloudItemTotal = remoteResult.manifest.data.notes.items.length + 1
        + (baseManifest ? baseManifest.data.notes.items.length + 1 : 0);
      let cloudItemsCompleted = 0;
      const reportCloudItem = (): void => {
        cloudItemsCompleted += 1;
        reportProgress('reading-cloud', cloudItemsCompleted, cloudItemTotal);
      };
      reportProgress('reading-cloud', 0, cloudItemTotal);
      const cloud = await this.materializeManifest(
        objectStore,
        remoteResult.manifest,
        remoteResult.encryptionKeyId,
        knownNotes,
        objectCache,
        knownTrees,
        treeObjectCache,
        reportCloudItem,
      );
      const base = baseManifest
        ? await this.materializeManifest(
          objectStore,
          baseManifest,
          baseEncryptionKeyId as string,
          knownNotes,
          objectCache,
          knownTrees,
          treeObjectCache,
          reportCloudItem,
        )
        : undefined;

      reportProgress('merging');
      const merged = mergeS3SharedAppData({ base, local, cloud, now: this.now().toISOString() });
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
        if (applyRequired) {
          reportProgress('applying');
          if (!await this.applyDataIfLocalUnchanged(local, localGeneration, mergedData)) continue;
        }
        reportProgress('finishing');
        const committed = await this.commitSuccessfulRevision(settings, headResult.head.revision);
        this.updateIncrementalBaseline(
          remoteResult.manifest,
          headResult.etag,
          remoteResult.encryptionKeyId,
        );
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
      const reusableTreeReferences = [
        ...(!requiresEncryptionMigration && baseManifest && baseReferencesUseCurrentEncryption
          ? [baseManifest.data.notes.tree]
          : []),
        ...retainedUploadTreeReferences.values(),
        ...(!requiresEncryptionMigration ? [remoteResult.manifest.data.notes.tree] : []),
      ];
      const published = await this.publishRevision(
        objectStore,
        settings,
        mergedData,
        headResult.head.revision,
        headResult.etag,
        reusableReferences,
        reusableTreeReferences,
        reportProgress,
      );
      if (published.status === 'conflict') {
        retainUploadedReferences(published.noteReferences);
        retainUploadedTreeReference(published.notesTreeReference);
        continue;
      }
      if (applyRequired) {
        reportProgress('applying');
        if (!await this.applyDataIfLocalUnchanged(local, localGeneration, mergedData)) continue;
      }
      reportProgress('finishing');
      const committed = await this.commitSuccessfulRevision(settings, published.manifest.revision);
      this.updateIncrementalBaseline(
        published.manifest,
        published.etag,
        getS3SyncEncryptionKeyId(syncEncryptionKey),
      );
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

  private async performSync(forceFull: boolean): Promise<S3SyncResult> {
    if (this.shuttingDown) throw new Error('S3 sync was cancelled.');
    const settings = { ...(await this.ensureSettings()) };
    if (!isConfigured(settings)) {
      this.updateState({ status: 'not-configured', pending: false });
      throw new Error('S3 sync settings are incomplete.');
    }
    const startingGeneration = this.dirtyGeneration;
    const notesIntent = this.pendingNotesIntent(startingGeneration);
    let performedFull = forceFull
      || !this.startupSyncComplete
      || !this.baselineManifest
      || !this.baselineHeadEtag
      || (this.pendingFullGeneration !== undefined
        && this.pendingFullGeneration <= startingGeneration)
      || !notesIntent;
    this.updateState({
      status: 'syncing',
      pending: this.state.pending,
      ...(this.state.pendingSince ? { pendingSince: this.state.pendingSince } : {}),
      ...(settings.lastSyncedAt ? { lastSyncedAt: settings.lastSyncedAt } : {}),
      ...(settings.lastRevision ? { lastRevision: settings.lastRevision } : {}),
      phase: 'checking',
    });
    const controller = new AbortController();
    this.activeAbortController = controller;
    try {
      const reportProgress = (phase: S3SyncProgressPhase, completedItems?: number, totalItems?: number): void =>
        this.reportSyncProgress(phase, completedItems, totalItems);
      let result: S3SyncResult;
      if (!performedFull && notesIntent) {
        const incremental = await this.publishIncrementalNotes(
          settings,
          notesIntent,
          startingGeneration,
          controller.signal,
          reportProgress,
        );
        if (incremental.status === 'written') {
          result = incremental.result;
        } else {
          this.clearIncrementalBaseline();
          performedFull = true;
          result = await this.reconcile(settings, controller.signal, reportProgress);
        }
      } else {
        result = await this.reconcile(settings, controller.signal, reportProgress);
      }
      this.clearLocalChangesThrough(startingGeneration);
      if (this.dirtyGeneration !== startingGeneration) {
        this.updateState({
          status: 'pending',
          pending: true,
          pendingSince: this.state.pendingSince ?? this.now().toISOString(),
          lastSyncedAt: result.syncedAt,
          ...(result.revision ? { lastRevision: result.revision } : {}),
        });
        this.scheduleSync(AUTO_SYNC_DEBOUNCE_MS, true, false);
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
          this.scheduleSync(AUTO_SYNC_DEBOUNCE_MS, true, false);
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
      if (performedFull) this.clearIncrementalBaseline();
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
