import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import type { Note, NoteLanguage } from '../shared/types';
import { NOTE_LIMITS } from './notesStore';
import {
  normalizeS3EndpointBucket,
  signS3V2Request,
  type S3EndpointBucket,
  type S3V2SignedRequest,
  type S3V2SigningInput,
} from './s3SyncV2';

const SYNC_VERSION = 3 as const;
const SCHEMA_VERSION = 3 as const;
const LAYOUT_PREFIX = 'service-manager/v3';
const MAX_MANIFEST_BYTES = 50 * 1024 * 1024;
const MAX_MANIFEST_OBJECT_BYTES = 72 * 1024 * 1024;
// A locally valid Note may contain 1,048,576 UTF-16 code units. JSON escaping
// can expand each control or lone-surrogate code unit to six bytes, so the
// encrypted object bounds must cover that legitimate worst case plus metadata.
const MAX_NOTE_BYTES = 7 * 1024 * 1024;
const MAX_NOTE_OBJECT_BYTES = 10 * 1024 * 1024;
const MAX_HEAD_OBJECT_BYTES = 16 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_TOMBSTONES = 50_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MANIFEST_ENCRYPTION_INFO = Buffer.from('service-manager-s3-sync-v3-manifest', 'utf8');
const NOTE_ENCRYPTION_INFO = Buffer.from('service-manager-s3-sync-v3-note', 'utf8');
const ENCRYPTION_AAD_PREFIX = 'service-manager-s3-object-v3\0';
const NOTE_LANGUAGES = new Set<NoteLanguage>([
  'markdown',
  'bash',
  'javascript',
  'typescript',
  'sql',
  'json',
  'yaml',
  'text',
]);

export interface S3V3NoteReference {
  id: string;
  objectId: string;
  sha256: string;
  contentHash: string;
}

export interface S3V3NoteTombstone {
  id: string;
  deletedAt: string;
}

export interface S3V3ManifestData {
  schemaVersion: 3;
  hosts: Record<string, unknown>;
  notes: {
    schemaVersion: 3;
    items: S3V3NoteReference[];
    tombstones: S3V3NoteTombstone[];
  };
  proxy: Record<string, unknown>;
}

export interface ServiceManagerSyncManifestV3 {
  schemaVersion: 3;
  syncVersion: 3;
  app: 'service-manager';
  appVersion: string;
  revision: string;
  parentRevision?: string;
  clientId: string;
  createdAt: string;
  data: S3V3ManifestData;
}

export interface ServiceManagerNoteObjectV3 {
  schemaVersion: 3;
  syncVersion: 3;
  app: 'service-manager';
  objectType: 'note';
  objectId: string;
  note: Note;
}

export type S3V3ObjectType = 'manifest' | 'note';

export interface EncryptedS3ObjectV3 {
  schemaVersion: 3;
  syncVersion: 3;
  objectType: S3V3ObjectType;
  objectId: string;
  encryption: {
    algorithm: 'AES-256-GCM';
    kdf: 'HKDF-SHA256';
    salt: string;
    iv: string;
    authTag: string;
  };
  ciphertext: string;
}

export interface S3SyncHeadV3 {
  schemaVersion: 3;
  syncVersion: 3;
  app: 'service-manager';
  revision: string;
  parentRevision?: string;
  clientId: string;
  createdAt: string;
  manifestSha256: string;
}

export type S3V3SigningInput = S3V2SigningInput;
export type S3V3SignedRequest = S3V2SignedRequest;

export interface S3V3ObjectStoreOptions extends S3EndpointBucket {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  createRandomBytes?: (size: number) => Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type S3V3HeadReadResult =
  | { status: 'missing' }
  | { status: 'found'; head: S3SyncHeadV3; etag: string };

export type S3V3ManifestReadResult =
  | { status: 'missing' }
  | {
    status: 'found';
    manifest: ServiceManagerSyncManifestV3;
    encrypted: EncryptedS3ObjectV3;
    manifestSha256: string;
  };

export type S3V3NoteReadResult =
  | { status: 'missing' }
  | {
    status: 'found';
    object: ServiceManagerNoteObjectV3;
    encrypted: EncryptedS3ObjectV3;
    reference: S3V3NoteReference;
  };

export type S3V3ConditionalWriteResult =
  | { status: 'written'; etag?: string }
  | { status: 'conflict' };

export type S3V3ManifestWriteResult =
  | {
    status: 'written';
    manifestSha256: string;
    byteLength: number;
    etag?: string;
  }
  | { status: 'conflict' };

export type S3V3NoteWriteResult =
  | {
    status: 'written';
    reference: S3V3NoteReference;
    byteLength: number;
    etag?: string;
  }
  | { status: 'conflict' };

interface HttpResult {
  status: number;
  headers: Headers;
  body: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function isoTimestamp(value: unknown, label: string): string {
  if (!isValidIsoTimestamp(value)) throw new Error(`${label} is invalid.`);
  return new Date(value).toISOString();
}

function normalizedIdentifier(value: unknown, label: string, maximumLength = 256): string {
  if (typeof value !== 'string' || !new RegExp(`^[A-Za-z0-9_-]{1,${maximumLength}}$`).test(value)) {
    throw new Error(`The S3 ${label} is invalid.`);
  }
  return value;
}

function stableNoteId(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > NOTE_LIMITS.idCharacters
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function cloneJsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  try {
    measureBoundedJsonBytes(value, MAX_MANIFEST_BYTES);
    const cloned = JSON.parse(JSON.stringify(value)) as unknown;
    if (!isRecord(cloned)) throw new Error('invalid object');
    return cloned;
  } catch (error) {
    if (error instanceof Error && /too large to sync/.test(error.message)) throw error;
    throw new Error(`${label} is invalid.`);
  }
}

function parseNote(value: unknown): Note {
  if (!isRecord(value)) throw new Error('The S3 Note is invalid.');
  const id = stableNoteId(value.id, 'The S3 Note ID');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > NOTE_LIMITS.nameCharacters) {
    throw new Error('The S3 Note name is invalid.');
  }
  if (typeof value.content !== 'string' || value.content.length > NOTE_LIMITS.contentCharacters) {
    throw new Error('The S3 Note content is invalid.');
  }
  if (typeof value.language !== 'string' || !NOTE_LANGUAGES.has(value.language as NoteLanguage)) {
    throw new Error('The S3 Note language is invalid.');
  }
  if (!Array.isArray(value.tags) || value.tags.length > NOTE_LIMITS.tags) {
    throw new Error('The S3 Note tags are invalid.');
  }
  const tagKeys = new Set<string>();
  const tags = value.tags.map((candidate) => {
    if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > NOTE_LIMITS.tagCharacters) {
      throw new Error('The S3 Note tags are invalid.');
    }
    const tag = candidate.trim();
    const key = tag.toLocaleLowerCase();
    if (tagKeys.has(key)) throw new Error('The S3 Note tags are invalid.');
    tagKeys.add(key);
    return tag;
  });
  return {
    id,
    name: value.name.trim(),
    content: value.content,
    language: value.language as NoteLanguage,
    tags,
    createdAt: isoTimestamp(value.createdAt, 'The S3 Note created timestamp'),
    updatedAt: isoTimestamp(value.updatedAt, 'The S3 Note updated timestamp'),
  };
}

function parseNoteReference(value: unknown): S3V3NoteReference {
  if (!isRecord(value)) throw new Error('The S3 Note reference is invalid.');
  return {
    id: stableNoteId(value.id, 'The S3 Note reference ID'),
    objectId: normalizedIdentifier(value.objectId, 'Note object identity', 128),
    sha256: digest(value.sha256, 'The S3 Note object digest'),
    contentHash: digest(value.contentHash, 'The S3 Note content digest'),
  };
}

function parseTombstone(value: unknown): S3V3NoteTombstone {
  if (!isRecord(value)) throw new Error('The S3 Note tombstone is invalid.');
  return {
    id: stableNoteId(value.id, 'The S3 Note tombstone ID'),
    deletedAt: isoTimestamp(value.deletedAt, 'The S3 Note tombstone timestamp'),
  };
}

export function parseS3V3ManifestData(value: unknown): S3V3ManifestData {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || !isRecord(value.notes)) {
    throw new Error('The S3 manifest data is invalid.');
  }
  if (!Array.isArray(value.notes.items) || value.notes.items.length > NOTE_LIMITS.notes) {
    throw new Error('The S3 manifest Notes are invalid.');
  }
  if (!Array.isArray(value.notes.tombstones) || value.notes.tombstones.length > MAX_TOMBSTONES) {
    throw new Error('The S3 manifest Note tombstones are invalid.');
  }
  if (value.notes.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('The S3 manifest Notes are invalid.');
  }
  const items = value.notes.items.map(parseNoteReference);
  const tombstones = value.notes.tombstones.map(parseTombstone);
  const noteIds = new Set<string>();
  const objectIds = new Set<string>();
  for (const item of items) {
    if (noteIds.has(item.id) || objectIds.has(item.objectId)) {
      throw new Error('The S3 manifest Notes contain duplicate identities.');
    }
    noteIds.add(item.id);
    objectIds.add(item.objectId);
  }
  for (const tombstone of tombstones) {
    if (noteIds.has(tombstone.id)) {
      throw new Error('The S3 manifest contains an active and deleted copy of one Note.');
    }
    noteIds.add(tombstone.id);
  }
  const parsed: S3V3ManifestData = {
    schemaVersion: SCHEMA_VERSION,
    hosts: cloneJsonRecord(value.hosts, 'The S3 manifest Hosts data'),
    notes: {
      schemaVersion: SCHEMA_VERSION,
      items,
      tombstones,
    },
    proxy: cloneJsonRecord(value.proxy, 'The S3 manifest Proxy data'),
  };
  measureBoundedJsonBytes(parsed, MAX_MANIFEST_BYTES);
  return parsed;
}

export function createServiceManagerSyncManifestV3(
  data: S3V3ManifestData,
  options: {
    appVersion: string;
    revision: string;
    parentRevision?: string;
    clientId: string;
    createdAt?: string;
  },
): ServiceManagerSyncManifestV3 {
  return parseServiceManagerSyncManifestV3({
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    app: 'service-manager',
    appVersion: options.appVersion,
    revision: options.revision,
    ...(options.parentRevision ? { parentRevision: options.parentRevision } : {}),
    clientId: options.clientId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    data,
  });
}

export function parseServiceManagerSyncManifestV3(value: unknown): ServiceManagerSyncManifestV3 {
  if (
    !isRecord(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.syncVersion !== SYNC_VERSION
    || value.app !== 'service-manager'
    || typeof value.appVersion !== 'string'
    || !value.appVersion
    || value.appVersion.length > 128
  ) {
    throw new Error('The S3 sync manifest is invalid.');
  }
  const revision = normalizedIdentifier(value.revision, 'manifest revision', 256);
  const parentRevision = value.parentRevision === undefined
    ? undefined
    : normalizedIdentifier(value.parentRevision, 'parent manifest revision', 256);
  if (parentRevision === revision) throw new Error('The S3 sync manifest is invalid.');
  const parsed: ServiceManagerSyncManifestV3 = {
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    app: 'service-manager',
    appVersion: value.appVersion,
    revision,
    ...(parentRevision ? { parentRevision } : {}),
    clientId: normalizedIdentifier(value.clientId, 'client identity', 128),
    createdAt: isoTimestamp(value.createdAt, 'The S3 manifest timestamp'),
    data: parseS3V3ManifestData(value.data),
  };
  measureBoundedJsonBytes(parsed, MAX_MANIFEST_BYTES);
  return parsed;
}

export function createServiceManagerNoteObjectV3(
  note: Note,
  objectId: string,
): ServiceManagerNoteObjectV3 {
  return parseServiceManagerNoteObjectV3({
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    app: 'service-manager',
    objectType: 'note',
    objectId,
    note,
  });
}

export function parseServiceManagerNoteObjectV3(value: unknown): ServiceManagerNoteObjectV3 {
  if (
    !isRecord(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.syncVersion !== SYNC_VERSION
    || value.app !== 'service-manager'
    || value.objectType !== 'note'
  ) {
    throw new Error('The S3 Note object is invalid.');
  }
  const parsed: ServiceManagerNoteObjectV3 = {
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    app: 'service-manager',
    objectType: 'note',
    objectId: normalizedIdentifier(value.objectId, 'Note object identity', 128),
    note: parseNote(value.note),
  };
  measureBoundedJsonBytes(parsed, MAX_NOTE_BYTES, 'The S3 Note is too large to sync.');
  return parsed;
}

export function createS3V3ObjectId(
  createBytes: (size: number) => Buffer = randomBytes,
): string {
  const bytes = createBytes(24);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== 24) {
    throw new Error('Secure S3 object identity randomness is unavailable.');
  }
  return bytes.toString('base64url');
}

export function hashS3V3Object(value: string | Buffer): string {
  return sha256Hex(value);
}

export function hashS3V3NoteContent(value: Note | ServiceManagerNoteObjectV3): string {
  const note = isRecord(value) && value.objectType === 'note'
    ? parseServiceManagerNoteObjectV3(value).note
    : parseNote(value);
  return sha256Hex(JSON.stringify(note));
}

function encryptionInfo(objectType: S3V3ObjectType): Buffer {
  return objectType === 'manifest' ? MANIFEST_ENCRYPTION_INFO : NOTE_ENCRYPTION_INFO;
}

function objectPlaintextLimit(objectType: S3V3ObjectType): number {
  return objectType === 'manifest' ? MAX_MANIFEST_BYTES : MAX_NOTE_BYTES;
}

function objectCiphertextLimit(objectType: S3V3ObjectType): number {
  return objectType === 'manifest' ? MAX_MANIFEST_BYTES : MAX_NOTE_BYTES;
}

function objectResponseLimit(objectType: S3V3ObjectType): number {
  return objectType === 'manifest' ? MAX_MANIFEST_OBJECT_BYTES : MAX_NOTE_OBJECT_BYTES;
}

function deriveObjectKey(
  secretAccessKey: string,
  salt: Buffer,
  objectType: S3V3ObjectType,
): Buffer {
  return Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(secretAccessKey, 'utf8'),
    salt,
    encryptionInfo(objectType),
    32,
  ));
}

function strictBase64(value: unknown, maximumBytes: number, expectedBytes?: number): Buffer {
  const maximumCharacters = Math.ceil(maximumBytes / 3) * 4;
  if (
    typeof value !== 'string'
    || !value
    || value.length > maximumCharacters
    || value.length % 4 !== 0
  ) {
    throw new Error('invalid base64');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bodyLength = value.length - padding;
  for (let index = 0; index < bodyLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2b
      || code === 0x2f;
    if (!valid) throw new Error('invalid base64');
  }
  for (let index = bodyLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) throw new Error('invalid base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.toString('base64') !== value
    || decoded.byteLength > maximumBytes
    || (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)
  ) {
    throw new Error('invalid base64');
  }
  return decoded;
}

export function parseEncryptedS3ObjectV3(value: unknown): EncryptedS3ObjectV3 {
  if (
    !isRecord(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.syncVersion !== SYNC_VERSION
    || (value.objectType !== 'manifest' && value.objectType !== 'note')
    || !isRecord(value.encryption)
    || value.encryption.algorithm !== 'AES-256-GCM'
    || value.encryption.kdf !== 'HKDF-SHA256'
  ) {
    throw new Error('The encrypted S3 object is invalid.');
  }
  const objectType = value.objectType;
  const maximumBytes = objectCiphertextLimit(objectType);
  try {
    strictBase64(value.encryption.salt, 16, 16);
    strictBase64(value.encryption.iv, 12, 12);
    strictBase64(value.encryption.authTag, 16, 16);
    const ciphertext = strictBase64(value.ciphertext, maximumBytes);
    if (ciphertext.byteLength === 0) throw new Error('empty ciphertext');
  } catch {
    throw new Error('The encrypted S3 object is invalid.');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    objectType,
    objectId: normalizedIdentifier(value.objectId, `${objectType} object identity`, objectType === 'note' ? 128 : 256),
    encryption: {
      algorithm: 'AES-256-GCM',
      kdf: 'HKDF-SHA256',
      salt: value.encryption.salt as string,
      iv: value.encryption.iv as string,
      authTag: value.encryption.authTag as string,
    },
    ciphertext: value.ciphertext as string,
  };
}

function encryptS3ObjectV3(
  value: ServiceManagerSyncManifestV3 | ServiceManagerNoteObjectV3,
  secretAccessKey: string,
  createBytes: (size: number) => Buffer,
): EncryptedS3ObjectV3 {
  if (!secretAccessKey) throw new Error('The S3 secret access key is unavailable.');
  const objectType: S3V3ObjectType = 'objectType' in value && value.objectType === 'note'
    ? 'note'
    : 'manifest';
  const parsed = objectType === 'note'
    ? parseServiceManagerNoteObjectV3(value)
    : parseServiceManagerSyncManifestV3(value);
  const objectId = objectType === 'note'
    ? (parsed as ServiceManagerNoteObjectV3).objectId
    : (parsed as ServiceManagerSyncManifestV3).revision;
  const plaintext = Buffer.from(JSON.stringify(parsed), 'utf8');
  if (plaintext.byteLength > objectPlaintextLimit(objectType)) {
    throw new Error(`The S3 ${objectType} is too large to sync.`);
  }
  const salt = createBytes(16);
  const iv = createBytes(12);
  if (!Buffer.isBuffer(salt) || salt.byteLength !== 16 || !Buffer.isBuffer(iv) || iv.byteLength !== 12) {
    throw new Error('Secure S3 object randomness is unavailable.');
  }
  const cipher = createCipheriv('aes-256-gcm', deriveObjectKey(secretAccessKey, salt, objectType), iv);
  cipher.setAAD(Buffer.from(`${ENCRYPTION_AAD_PREFIX}${objectType}\0${objectId}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    objectType,
    objectId,
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

function decryptS3ObjectV3(
  value: unknown,
  secretAccessKey: string,
  expectedType: S3V3ObjectType,
): ServiceManagerSyncManifestV3 | ServiceManagerNoteObjectV3 {
  try {
    if (!secretAccessKey) throw new Error('missing key');
    const envelope = parseEncryptedS3ObjectV3(value);
    if (envelope.objectType !== expectedType) throw new Error('object type mismatch');
    const maximumBytes = objectCiphertextLimit(expectedType);
    const salt = strictBase64(envelope.encryption.salt, 16, 16);
    const iv = strictBase64(envelope.encryption.iv, 12, 12);
    const authTag = strictBase64(envelope.encryption.authTag, 16, 16);
    const ciphertext = strictBase64(envelope.ciphertext, maximumBytes);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveObjectKey(secretAccessKey, salt, expectedType),
      iv,
    );
    decipher.setAAD(Buffer.from(`${ENCRYPTION_AAD_PREFIX}${expectedType}\0${envelope.objectId}`, 'utf8'));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.byteLength > objectPlaintextLimit(expectedType)) throw new Error('oversized plaintext');
    const raw = JSON.parse(plaintext.toString('utf8')) as unknown;
    if (expectedType === 'manifest') {
      const manifest = parseServiceManagerSyncManifestV3(raw);
      if (manifest.revision !== envelope.objectId) throw new Error('object identity mismatch');
      return manifest;
    }
    const noteObject = parseServiceManagerNoteObjectV3(raw);
    if (noteObject.objectId !== envelope.objectId) throw new Error('object identity mismatch');
    return noteObject;
  } catch {
    throw new Error(`The encrypted S3 ${expectedType} could not be decrypted.`);
  }
}

export function encryptS3ManifestV3(
  value: ServiceManagerSyncManifestV3,
  secretAccessKey: string,
  createBytes: (size: number) => Buffer = randomBytes,
): EncryptedS3ObjectV3 {
  return encryptS3ObjectV3(value, secretAccessKey, createBytes);
}

export function decryptS3ManifestV3(
  value: unknown,
  secretAccessKey: string,
): ServiceManagerSyncManifestV3 {
  return decryptS3ObjectV3(value, secretAccessKey, 'manifest') as ServiceManagerSyncManifestV3;
}

export function encryptS3NoteV3(
  value: ServiceManagerNoteObjectV3,
  secretAccessKey: string,
  createBytes: (size: number) => Buffer = randomBytes,
): EncryptedS3ObjectV3 {
  return encryptS3ObjectV3(value, secretAccessKey, createBytes);
}

export function decryptS3NoteV3(
  value: unknown,
  secretAccessKey: string,
): ServiceManagerNoteObjectV3 {
  return decryptS3ObjectV3(value, secretAccessKey, 'note') as ServiceManagerNoteObjectV3;
}

export function serializeEncryptedS3ObjectV3(value: EncryptedS3ObjectV3): string {
  return JSON.stringify(parseEncryptedS3ObjectV3(value));
}

export function buildS3V3HeadObjectUrl(endpoint: unknown, bucket: unknown): string {
  const normalized = normalizeS3EndpointBucket(endpoint, bucket);
  return `${normalized.endpoint}/${normalized.bucket}/${LAYOUT_PREFIX}/head.json`;
}

export function buildS3V3ManifestObjectUrl(
  endpoint: unknown,
  bucket: unknown,
  revision: unknown,
): string {
  const normalized = normalizeS3EndpointBucket(endpoint, bucket);
  const id = normalizedIdentifier(revision, 'manifest revision', 256);
  return `${normalized.endpoint}/${normalized.bucket}/${LAYOUT_PREFIX}/manifests/${id}.json`;
}

export function buildS3V3NoteObjectUrl(
  endpoint: unknown,
  bucket: unknown,
  objectId: unknown,
): string {
  const normalized = normalizeS3EndpointBucket(endpoint, bucket);
  const id = normalizedIdentifier(objectId, 'Note object identity', 128);
  return `${normalized.endpoint}/${normalized.bucket}/${LAYOUT_PREFIX}/notes/${id}.json`;
}

export function createS3SyncHeadV3(
  manifest: ServiceManagerSyncManifestV3,
  manifestSha256: string,
): S3SyncHeadV3 {
  const parsed = parseServiceManagerSyncManifestV3(manifest);
  return parseS3SyncHeadV3({
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    app: 'service-manager',
    revision: parsed.revision,
    ...(parsed.parentRevision ? { parentRevision: parsed.parentRevision } : {}),
    clientId: parsed.clientId,
    createdAt: parsed.createdAt,
    manifestSha256,
  });
}

export function parseS3SyncHeadV3(value: unknown): S3SyncHeadV3 {
  if (
    !isRecord(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.syncVersion !== SYNC_VERSION
    || value.app !== 'service-manager'
  ) {
    throw new Error('The S3 v3 sync head is invalid.');
  }
  const revision = normalizedIdentifier(value.revision, 'manifest revision', 256);
  const parentRevision = value.parentRevision === undefined
    ? undefined
    : normalizedIdentifier(value.parentRevision, 'parent manifest revision', 256);
  if (parentRevision === revision) throw new Error('The S3 v3 sync head is invalid.');
  return {
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    app: 'service-manager',
    revision,
    ...(parentRevision ? { parentRevision } : {}),
    clientId: normalizedIdentifier(value.clientId, 'client identity', 128),
    createdAt: isoTimestamp(value.createdAt, 'The S3 v3 head timestamp'),
    manifestSha256: digest(value.manifestSha256, 'The S3 manifest digest'),
  };
}

export function assertS3SyncHeadMatchesManifestV3(
  headValue: S3SyncHeadV3,
  manifestValue: ServiceManagerSyncManifestV3,
  manifestSha256: string,
): void {
  const head = parseS3SyncHeadV3(headValue);
  const manifest = parseServiceManagerSyncManifestV3(manifestValue);
  if (
    manifestSha256 !== head.manifestSha256
    || manifest.revision !== head.revision
    || manifest.parentRevision !== head.parentRevision
    || manifest.clientId !== head.clientId
    || manifest.createdAt !== head.createdAt
  ) {
    throw new Error('The S3 sync manifest does not match the shared head.');
  }
}

export function signS3V3Request(input: S3V3SigningInput): S3V3SignedRequest {
  return signS3V2Request(input);
}

function normalizedEtag(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 2
    || value.length > 512
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('The S3 object ETag is invalid.');
  }
  return value;
}

function safeHttpError(status: number, body: Buffer): Error {
  const match = body.toString('utf8').slice(0, MAX_ERROR_BYTES)
    .match(/<Code>\s*([A-Za-z0-9._-]{1,128})\s*<\/Code>/i);
  return new Error(`S3 sync failed (${status}${match ? ` ${match[1]}` : ''}).`);
}

async function readBoundedBody(response: Response, maximumBytes: number, signal: AbortSignal): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('The S3 sync response is too large.');
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('The S3 sync response is too large.');
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  return Buffer.concat(chunks, total);
}

function responseEtag(headers: Headers, required: boolean): string | undefined {
  const value = headers.get('etag');
  if (!value) {
    if (required) throw new Error('The S3 sync head response is missing an ETag.');
    return undefined;
  }
  return normalizedEtag(value);
}

function parseJsonBody(body: Buffer, label: string): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new Error(`The S3 sync ${label} is invalid.`);
  }
}

export class S3V3ObjectStore {
  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly createRandomBytes: (size: number) => Buffer;
  private readonly timeoutMs: number;
  private readonly activeControllers = new Set<AbortController>();

  public constructor(private readonly options: S3V3ObjectStoreOptions) {
    const target = normalizeS3EndpointBucket(options.endpoint, options.bucket);
    this.endpoint = target.endpoint;
    this.bucket = target.bucket;
    if (!options.region || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(options.region.trim())) {
      throw new Error('A valid S3 region is required.');
    }
    if (!options.accessKeyId || !options.secretAccessKey) throw new Error('S3 credentials are unavailable.');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.createRandomBytes = options.createRandomBytes ?? randomBytes;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new Error('The S3 request timeout is invalid.');
    }
  }

  public async getHead(): Promise<S3V3HeadReadResult> {
    const result = await this.request('GET', buildS3V3HeadObjectUrl(this.endpoint, this.bucket), undefined, {}, MAX_HEAD_OBJECT_BYTES);
    if (result.status === 404) return { status: 'missing' };
    this.requireSuccess(result);
    return {
      status: 'found',
      head: parseS3SyncHeadV3(parseJsonBody(result.body, 'v3 head')),
      etag: responseEtag(result.headers, true) as string,
    };
  }

  public async getManifest(revision: string, expectedSha256?: string): Promise<S3V3ManifestReadResult> {
    const id = normalizedIdentifier(revision, 'manifest revision', 256);
    const expected = expectedSha256 === undefined
      ? undefined
      : digest(expectedSha256, 'The expected S3 manifest digest');
    const result = await this.request(
      'GET',
      buildS3V3ManifestObjectUrl(this.endpoint, this.bucket, id),
      undefined,
      {},
      objectResponseLimit('manifest'),
    );
    if (result.status === 404) return { status: 'missing' };
    this.requireSuccess(result);
    const manifestSha256 = hashS3V3Object(result.body);
    if (expected !== undefined && manifestSha256 !== expected) {
      throw new Error('The S3 sync manifest digest does not match the shared head.');
    }
    const encrypted = parseEncryptedS3ObjectV3(parseJsonBody(result.body, 'manifest'));
    if (encrypted.objectType !== 'manifest' || encrypted.objectId !== id) {
      throw new Error('The S3 sync manifest is invalid.');
    }
    const manifest = decryptS3ManifestV3(encrypted, this.options.secretAccessKey);
    return { status: 'found', manifest, encrypted, manifestSha256 };
  }

  public async putManifest(manifestValue: ServiceManagerSyncManifestV3): Promise<S3V3ManifestWriteResult> {
    const manifest = parseServiceManagerSyncManifestV3(manifestValue);
    const encrypted = encryptS3ManifestV3(manifest, this.options.secretAccessKey, this.createRandomBytes);
    const body = serializeEncryptedS3ObjectV3(encrypted);
    const manifestSha256 = hashS3V3Object(body);
    const byteLength = Buffer.byteLength(body, 'utf8');
    const result = await this.request(
      'PUT',
      buildS3V3ManifestObjectUrl(this.endpoint, this.bucket, manifest.revision),
      body,
      { ifNoneMatch: '*' },
    );
    if (result.status === 409 || result.status === 412) return { status: 'conflict' };
    this.requireSuccess(result);
    const etag = responseEtag(result.headers, false);
    return {
      status: 'written',
      manifestSha256,
      byteLength,
      ...(etag ? { etag } : {}),
    };
  }

  public async getNote(referenceValue: S3V3NoteReference): Promise<S3V3NoteReadResult> {
    const reference = parseNoteReference(referenceValue);
    const result = await this.request(
      'GET',
      buildS3V3NoteObjectUrl(this.endpoint, this.bucket, reference.objectId),
      undefined,
      {},
      objectResponseLimit('note'),
    );
    if (result.status === 404) return { status: 'missing' };
    this.requireSuccess(result);
    if (hashS3V3Object(result.body) !== reference.sha256) {
      throw new Error('The S3 Note object digest does not match its manifest reference.');
    }
    const encrypted = parseEncryptedS3ObjectV3(parseJsonBody(result.body, 'Note object'));
    if (encrypted.objectType !== 'note' || encrypted.objectId !== reference.objectId) {
      throw new Error('The S3 Note object is invalid.');
    }
    const object = decryptS3NoteV3(encrypted, this.options.secretAccessKey);
    if (object.note.id !== reference.id || hashS3V3NoteContent(object) !== reference.contentHash) {
      throw new Error('The S3 Note object does not match its manifest reference.');
    }
    return { status: 'found', object, encrypted, reference };
  }

  public async putNote(objectValue: ServiceManagerNoteObjectV3): Promise<S3V3NoteWriteResult> {
    const object = parseServiceManagerNoteObjectV3(objectValue);
    const encrypted = encryptS3NoteV3(object, this.options.secretAccessKey, this.createRandomBytes);
    const body = serializeEncryptedS3ObjectV3(encrypted);
    const reference: S3V3NoteReference = {
      id: object.note.id,
      objectId: object.objectId,
      sha256: hashS3V3Object(body),
      contentHash: hashS3V3NoteContent(object),
    };
    const result = await this.request(
      'PUT',
      buildS3V3NoteObjectUrl(this.endpoint, this.bucket, object.objectId),
      body,
      { ifNoneMatch: '*' },
    );
    if (result.status === 409 || result.status === 412) return { status: 'conflict' };
    this.requireSuccess(result);
    const etag = responseEtag(result.headers, false);
    return {
      status: 'written',
      reference,
      byteLength: Buffer.byteLength(body, 'utf8'),
      ...(etag ? { etag } : {}),
    };
  }

  public async putHead(headValue: S3SyncHeadV3, expectedEtag?: string): Promise<S3V3ConditionalWriteResult> {
    const head = parseS3SyncHeadV3(headValue);
    const body = JSON.stringify(head);
    const conditions = expectedEtag === undefined
      ? { ifNoneMatch: '*' as const }
      : { ifMatch: normalizedEtag(expectedEtag) };
    const result = await this.request(
      'PUT',
      buildS3V3HeadObjectUrl(this.endpoint, this.bucket),
      body,
      conditions,
    );
    if (result.status === 409 || result.status === 412) return { status: 'conflict' };
    this.requireSuccess(result);
    const etag = responseEtag(result.headers, false);
    return { status: 'written', ...(etag ? { etag } : {}) };
  }

  public abortActiveRequests(): void {
    for (const controller of this.activeControllers) controller.abort();
  }

  private requireSuccess(result: HttpResult): void {
    if (result.status < 200 || result.status >= 300) throw safeHttpError(result.status, result.body);
  }

  private async request(
    method: 'GET' | 'PUT',
    objectUrl: string,
    body: string | undefined,
    conditions: { ifMatch?: string; ifNoneMatch?: '*' },
    successBodyLimit?: number,
  ): Promise<HttpResult> {
    const signed = signS3V3Request({
      method,
      objectUrl,
      region: this.options.region.trim(),
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      ...(body !== undefined ? { payload: body } : {}),
      ...conditions,
      now: this.now(),
    });
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const abortFromOwner = (): void => controller.abort();
    if (this.options.signal?.aborted) controller.abort();
    else this.options.signal?.addEventListener('abort', abortFromOwner, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(signed.url, {
          method,
          headers: signed.headers,
          ...(body !== undefined ? { body } : {}),
          signal: controller.signal,
          redirect: 'manual',
        });
      } catch {
        if (timedOut) throw new Error('S3 sync timed out.');
        if (controller.signal.aborted) throw new Error('S3 sync was cancelled.');
        throw new Error('S3 sync request failed.');
      }
      const expectedWithoutBody = (method === 'PUT' && response.status >= 200 && response.status < 300)
        || response.status === 404
        || response.status === 409
        || response.status === 412;
      let responseBody: Buffer;
      if (expectedWithoutBody) {
        await response.body?.cancel().catch(() => undefined);
        responseBody = Buffer.alloc(0);
      } else {
        const limit = response.status >= 200 && response.status < 300
          ? (successBodyLimit ?? MAX_ERROR_BYTES)
          : MAX_ERROR_BYTES;
        responseBody = await readBoundedBody(response, limit, controller.signal);
      }
      if (timedOut) throw new Error('S3 sync timed out.');
      if (controller.signal.aborted) throw new Error('S3 sync was cancelled.');
      return { status: response.status, headers: response.headers, body: responseBody };
    } catch (error) {
      if (timedOut) throw new Error('S3 sync timed out.');
      if (controller.signal.aborted) throw new Error('S3 sync was cancelled.');
      throw error;
    } finally {
      clearTimeout(timeout);
      this.options.signal?.removeEventListener('abort', abortFromOwner);
      this.activeControllers.delete(controller);
    }
  }
}

function measureBoundedJsonBytes(
  value: unknown,
  maximumBytes: number,
  oversizedMessage = 'The application data snapshot is too large to sync.',
): number {
  let bytes = 0;
  const ancestors = new WeakSet<object>();
  const add = (amount: number): void => {
    bytes += amount;
    if (bytes > maximumBytes) throw new Error(oversizedMessage);
  };
  const addString = (text: string): void => {
    add(Buffer.byteLength(JSON.stringify(text), 'utf8'));
  };
  const visit = (candidate: unknown, arrayItem = false): void => {
    if (candidate === undefined || typeof candidate === 'function' || typeof candidate === 'symbol') {
      if (arrayItem) add(4);
      return;
    }
    if (candidate === null || typeof candidate !== 'object') {
      if (typeof candidate === 'bigint') throw new Error('Snapshot data could not be serialized.');
      const serialized = JSON.stringify(candidate);
      if (serialized === undefined) throw new Error('Snapshot data could not be serialized.');
      add(Buffer.byteLength(serialized, 'utf8'));
      return;
    }
    if (ancestors.has(candidate)) throw new Error('Snapshot data could not be serialized.');
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        add(2);
        if (candidate.length > 0) {
          add(candidate.length - 1);
          for (let index = 0; index < candidate.length; index += 1) visit(candidate[index], true);
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
        addString(key);
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
