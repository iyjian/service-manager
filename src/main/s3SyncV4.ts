import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { normalizeRichTextContent } from '../shared/noteRichText';
import type { Note, NoteLanguage } from '../shared/types';
import { NOTE_LIMITS } from './notesStore';
import {
  normalizeS3EndpointBucket,
  signS3Request,
  type S3EndpointBucket,
  type S3SignedRequest,
  type S3SigningInput,
} from './s3Request';

const SYNC_VERSION = 4 as const;
const SCHEMA_VERSION = 4 as const;
const LAYOUT_VERSION = 4 as const;
const LAYOUT_PREFIX = 'service-manager/v4';
const MAX_MANIFEST_BYTES = 50 * 1024 * 1024;
const MAX_MANIFEST_OBJECT_BYTES = 72 * 1024 * 1024;
// A locally valid Note may contain 1,048,576 UTF-16 code units. JSON escaping
// can expand each control or lone-surrogate code unit to six bytes, so the
// encrypted object bounds must cover that legitimate worst case plus metadata.
const MAX_NOTE_BYTES = 7 * 1024 * 1024;
const MAX_NOTE_OBJECT_BYTES = 10 * 1024 * 1024;
const NOTES_TREE_SCHEMA_VERSION = 1 as const;
const MAX_NOTES_TREE_DEPTH = 32;
const MAX_NOTES_TREE_BYTES = 8 * 1024 * 1024;
const MAX_NOTES_TREE_OBJECT_BYTES = 12 * 1024 * 1024;
const MAX_HEAD_OBJECT_BYTES = 16 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_TOMBSTONES = 50_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MANIFEST_ENCRYPTION_INFO = Buffer.from('service-manager-s3-sync-v4-manifest', 'utf8');
const NOTE_ENCRYPTION_INFO = Buffer.from('service-manager-s3-sync-v4-note', 'utf8');
const NOTES_TREE_ENCRYPTION_INFO = Buffer.from('service-manager-s3-sync-v4-notes-tree', 'utf8');
const ENCRYPTION_AAD_PREFIX = 'service-manager-s3-object-v4\0';
const SYNC_ENCRYPTION_KEY_BYTES = 32;
const NOTE_LANGUAGES = new Set<NoteLanguage>([
  'markdown',
  'richtext',
  'bash',
  'javascript',
  'typescript',
  'sql',
  'json',
  'yaml',
  'text',
]);

export interface S3V4NoteReference {
  id: string;
  objectId: string;
  sha256: string;
  contentHash: string;
  encryptionKeyId: string;
}

export interface S3V4NoteTombstone {
  id: string;
  deletedAt: string;
}

export interface S3V4NotesTreePayload {
  schemaVersion: 1;
  root: string[];
  order: Record<string, number>;
  parent: Record<string, string | null>;
}

export interface S3V4NotesTreeReference {
  objectId: string;
  sha256: string;
  contentHash: string;
  encryptionKeyId: string;
}

export interface S3V4ManifestData {
  schemaVersion: 4;
  hosts: Record<string, unknown>;
  notes: {
    schemaVersion: 4;
    items: S3V4NoteReference[];
    tombstones: S3V4NoteTombstone[];
    tree: S3V4NotesTreeReference;
  };
  proxy: Record<string, unknown>;
}

export interface ServiceManagerSyncManifestV4 {
  schemaVersion: 4;
  syncVersion: 4;
  layoutVersion: 4;
  app: 'service-manager';
  appVersion: string;
  revision: string;
  parentRevision?: string;
  clientId: string;
  createdAt: string;
  data: S3V4ManifestData;
}

export interface ServiceManagerNoteObjectV4 {
  schemaVersion: 4;
  syncVersion: 4;
  layoutVersion: 4;
  app: 'service-manager';
  objectType: 'note';
  objectId: string;
  note: Note;
}

export interface ServiceManagerNotesTreeObjectV4 {
  schemaVersion: 4;
  syncVersion: 4;
  layoutVersion: 4;
  app: 'service-manager';
  objectType: 'notes-tree';
  objectId: string;
  tree: S3V4NotesTreePayload;
}

export type S3V4ObjectType = 'manifest' | 'note' | 'notes-tree';

export interface EncryptedS3ObjectV4 {
  schemaVersion: 4;
  syncVersion: 4;
  layoutVersion: 4;
  objectType: S3V4ObjectType;
  objectId: string;
  encryption: {
    algorithm: 'AES-256-GCM';
    kdf: 'HKDF-SHA256';
    keySource: 'sync-key-v1';
    keyId: string;
    salt: string;
    iv: string;
    authTag: string;
  };
  ciphertext: string;
}

export interface S3SyncHeadV4 {
  schemaVersion: 4;
  syncVersion: 4;
  layoutVersion: 4;
  app: 'service-manager';
  revision: string;
  parentRevision?: string;
  clientId: string;
  createdAt: string;
  manifestSha256: string;
  encryptionKeyId: string;
}

export type S3V4SigningInput = S3SigningInput;
export type S3V4SignedRequest = S3SignedRequest;

export interface S3V4ObjectStoreOptions extends S3EndpointBucket {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  syncEncryptionKey: string;
  previousSyncEncryptionKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  createRandomBytes?: (size: number) => Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface S3V4ConnectionTestOptions extends S3EndpointBucket {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type S3V4HeadReadResult =
  | { status: 'missing' }
  | { status: 'found'; head: S3SyncHeadV4; etag: string };

export type S3V4ManifestReadResult =
  | { status: 'missing' }
  | {
    status: 'found';
    manifest: ServiceManagerSyncManifestV4;
    encrypted: EncryptedS3ObjectV4;
    manifestSha256: string;
    encryptionKeyId: string;
  };

export type S3V4NoteReadResult =
  | { status: 'missing' }
  | {
    status: 'found';
    object: ServiceManagerNoteObjectV4;
    encrypted: EncryptedS3ObjectV4;
    reference: S3V4NoteReference;
    encryptionKeyId: string;
  };

export type S3V4NotesTreeReadResult =
  | { status: 'missing' }
  | {
    status: 'found';
    object: ServiceManagerNotesTreeObjectV4;
    encrypted: EncryptedS3ObjectV4;
    reference: S3V4NotesTreeReference;
    encryptionKeyId: string;
  };

export type S3V4ConditionalWriteResult =
  | { status: 'written'; etag?: string }
  | { status: 'conflict' };

export type S3V4ManifestWriteResult =
  | {
    status: 'written';
    manifestSha256: string;
    byteLength: number;
    etag?: string;
  }
  | { status: 'conflict' };

export type S3V4NoteWriteResult =
  | {
    status: 'written';
    reference: S3V4NoteReference;
    byteLength: number;
    etag?: string;
  }
  | { status: 'conflict' };

export type S3V4NotesTreeWriteResult =
  | {
    status: 'written';
    reference: S3V4NotesTreeReference;
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
  let content = value.content;
  if (value.language === 'richtext') {
    try {
      content = normalizeRichTextContent(content);
    } catch {
      throw new Error('The S3 Note rich text content is invalid.');
    }
  }
  return {
    id,
    name: value.name.trim(),
    content,
    language: value.language as NoteLanguage,
    tags,
    createdAt: isoTimestamp(value.createdAt, 'The S3 Note created timestamp'),
    updatedAt: isoTimestamp(value.updatedAt, 'The S3 Note updated timestamp'),
  };
}

function parseNoteReference(value: unknown): S3V4NoteReference {
  if (!isRecord(value)) throw new Error('The S3 Note reference is invalid.');
  return {
    id: stableNoteId(value.id, 'The S3 Note reference ID'),
    objectId: normalizedIdentifier(value.objectId, 'Note object identity', 128),
    sha256: digest(value.sha256, 'The S3 Note object digest'),
    contentHash: digest(value.contentHash, 'The S3 Note content digest'),
    encryptionKeyId: digest(value.encryptionKeyId, 'The Sync Encryption Key identity'),
  };
}

function parseTombstone(value: unknown): S3V4NoteTombstone {
  if (!isRecord(value)) throw new Error('The S3 Note tombstone is invalid.');
  return {
    id: stableNoteId(value.id, 'The S3 Note tombstone ID'),
    deletedAt: isoTimestamp(value.deletedAt, 'The S3 Note tombstone timestamp'),
  };
}

function treeNoteId(value: unknown, label: string): string {
  const parsed = stableNoteId(value, label);
  if (parsed !== value) throw new Error(`${label} is invalid.`);
  return parsed;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseS3V4NotesTreePayload(value: unknown): S3V4NotesTreePayload {
  if (!isRecord(value) || value.schemaVersion !== NOTES_TREE_SCHEMA_VERSION) {
    throw new Error('The S3 Notes tree is invalid.');
  }
  try {
    measureBoundedJsonBytes(value, MAX_NOTES_TREE_BYTES, 'The S3 Notes tree is too large to sync.');
  } catch (error) {
    if (error instanceof Error && /too large to sync/.test(error.message)) throw error;
    throw new Error('The S3 Notes tree is invalid.');
  }
  if (
    !Array.isArray(value.root)
    || value.root.length > NOTE_LIMITS.notes
    || !isRecord(value.order)
    || !isRecord(value.parent)
  ) {
    throw new Error('The S3 Notes tree is invalid.');
  }

  const orderEntries = Object.entries(value.order);
  const parentEntries = Object.entries(value.parent);
  if (orderEntries.length > NOTE_LIMITS.notes || parentEntries.length !== orderEntries.length) {
    throw new Error('The S3 Notes tree is invalid.');
  }

  const order = new Map<string, number>();
  for (const [rawNoteId, rawOrder] of orderEntries) {
    const noteId = treeNoteId(rawNoteId, 'The S3 Notes tree Note ID');
    if (!Number.isSafeInteger(rawOrder) || (rawOrder as number) < 0) {
      throw new Error('The S3 Notes tree order is invalid.');
    }
    order.set(noteId, rawOrder as number);
  }

  const parent = new Map<string, string | null>();
  for (const [rawNoteId, rawParentId] of parentEntries) {
    const noteId = treeNoteId(rawNoteId, 'The S3 Notes tree Note ID');
    if (!order.has(noteId)) throw new Error('The S3 Notes tree key sets do not match.');
    const parentId = rawParentId === null
      ? null
      : treeNoteId(rawParentId, 'The S3 Notes tree parent Note ID');
    if (parentId === noteId || (parentId !== null && !order.has(parentId))) {
      throw new Error('The S3 Notes tree parent is invalid.');
    }
    parent.set(noteId, parentId);
  }
  if (parent.size !== order.size) throw new Error('The S3 Notes tree key sets do not match.');

  const roots: string[] = [];
  const rootSet = new Set<string>();
  for (const candidate of value.root) {
    const noteId = treeNoteId(candidate, 'The S3 Notes tree root Note ID');
    if (rootSet.has(noteId)) throw new Error('The S3 Notes tree roots contain a duplicate.');
    if (!order.has(noteId) || parent.get(noteId) !== null) {
      throw new Error('The S3 Notes tree roots are invalid.');
    }
    rootSet.add(noteId);
    roots.push(noteId);
  }
  const expectedRoots = [...parent.entries()]
    .filter(([, parentId]) => parentId === null)
    .map(([noteId]) => noteId)
    .sort((left, right) => (order.get(left) as number) - (order.get(right) as number) || compareText(left, right));
  if (expectedRoots.length !== roots.length || expectedRoots.some((noteId, index) => roots[index] !== noteId)) {
    throw new Error('The S3 Notes tree roots are invalid.');
  }

  const siblingOrders = new Map<string | null, Set<number>>();
  for (const [noteId, parentId] of parent) {
    const orders = siblingOrders.get(parentId) ?? new Set<number>();
    const noteOrder = order.get(noteId) as number;
    if (orders.has(noteOrder)) throw new Error('The S3 Notes tree sibling order is invalid.');
    orders.add(noteOrder);
    siblingOrders.set(parentId, orders);
  }

  const depths = new Map<string, number>();
  for (const startId of order.keys()) {
    if (depths.has(startId)) continue;
    const path: string[] = [];
    const positions = new Set<string>();
    let currentId: string | null = startId;
    while (currentId !== null && !depths.has(currentId)) {
      if (positions.has(currentId)) throw new Error('The S3 Notes tree contains a cycle.');
      positions.add(currentId);
      path.push(currentId);
      currentId = parent.get(currentId) as string | null;
    }
    let depth = currentId === null ? -1 : (depths.get(currentId) as number);
    for (let index = path.length - 1; index >= 0; index -= 1) {
      depth += 1;
      if (depth > MAX_NOTES_TREE_DEPTH) {
        throw new Error(`The S3 Notes tree exceeds the maximum depth of ${MAX_NOTES_TREE_DEPTH}.`);
      }
      depths.set(path[index], depth);
    }
  }

  const sortedIds = [...order.keys()].sort(compareText);
  const parsed: S3V4NotesTreePayload = {
    schemaVersion: NOTES_TREE_SCHEMA_VERSION,
    root: [...roots],
    order: Object.fromEntries(sortedIds.map((noteId) => [noteId, order.get(noteId) as number])),
    parent: Object.fromEntries(sortedIds.map((noteId) => [noteId, parent.get(noteId) as string | null])),
  };
  measureBoundedJsonBytes(parsed, MAX_NOTES_TREE_BYTES, 'The S3 Notes tree is too large to sync.');
  return parsed;
}

export function parseS3V4NotesTreeReference(value: unknown): S3V4NotesTreeReference {
  if (!isRecord(value)) throw new Error('The S3 Notes tree reference is invalid.');
  return {
    objectId: normalizedIdentifier(value.objectId, 'Notes tree object identity', 128),
    sha256: digest(value.sha256, 'The S3 Notes tree object digest'),
    contentHash: digest(value.contentHash, 'The S3 Notes tree content digest'),
    encryptionKeyId: digest(value.encryptionKeyId, 'The Sync Encryption Key identity'),
  };
}

export function parseS3V4ManifestData(value: unknown): S3V4ManifestData {
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
  const tree = parseS3V4NotesTreeReference(value.notes.tree);
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
  const parsed: S3V4ManifestData = {
    schemaVersion: SCHEMA_VERSION,
    hosts: cloneJsonRecord(value.hosts, 'The S3 manifest Hosts data'),
    notes: {
      schemaVersion: SCHEMA_VERSION,
      items,
      tombstones,
      tree,
    },
    proxy: cloneJsonRecord(value.proxy, 'The S3 manifest Proxy data'),
  };
  measureBoundedJsonBytes(parsed, MAX_MANIFEST_BYTES);
  return parsed;
}

export function createServiceManagerSyncManifestV4(
  data: S3V4ManifestData,
  options: {
    appVersion: string;
    revision: string;
    parentRevision?: string;
    clientId: string;
    createdAt?: string;
  },
): ServiceManagerSyncManifestV4 {
  return parseServiceManagerSyncManifestV4({
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    layoutVersion: LAYOUT_VERSION,
    app: 'service-manager',
    appVersion: options.appVersion,
    revision: options.revision,
    ...(options.parentRevision ? { parentRevision: options.parentRevision } : {}),
    clientId: options.clientId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    data,
  });
}

export function parseServiceManagerSyncManifestV4(value: unknown): ServiceManagerSyncManifestV4 {
  if (
    !isRecord(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.syncVersion !== SYNC_VERSION
    || value.layoutVersion !== LAYOUT_VERSION
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
  const parsed: ServiceManagerSyncManifestV4 = {
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    layoutVersion: LAYOUT_VERSION,
    app: 'service-manager',
    appVersion: value.appVersion,
    revision,
    ...(parentRevision ? { parentRevision } : {}),
    clientId: normalizedIdentifier(value.clientId, 'client identity', 128),
    createdAt: isoTimestamp(value.createdAt, 'The S3 manifest timestamp'),
    data: parseS3V4ManifestData(value.data),
  };
  measureBoundedJsonBytes(parsed, MAX_MANIFEST_BYTES);
  return parsed;
}

export function createServiceManagerNoteObjectV4(
  note: Note,
  objectId: string,
): ServiceManagerNoteObjectV4 {
  return parseServiceManagerNoteObjectV4({
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    layoutVersion: LAYOUT_VERSION,
    app: 'service-manager',
    objectType: 'note',
    objectId,
    note,
  });
}

export function parseServiceManagerNoteObjectV4(value: unknown): ServiceManagerNoteObjectV4 {
  if (
    !isRecord(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.syncVersion !== SYNC_VERSION
    || value.layoutVersion !== LAYOUT_VERSION
    || value.app !== 'service-manager'
    || value.objectType !== 'note'
  ) {
    throw new Error('The S3 Note object is invalid.');
  }
  const parsed: ServiceManagerNoteObjectV4 = {
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    layoutVersion: LAYOUT_VERSION,
    app: 'service-manager',
    objectType: 'note',
    objectId: normalizedIdentifier(value.objectId, 'Note object identity', 128),
    note: parseNote(value.note),
  };
  measureBoundedJsonBytes(parsed, MAX_NOTE_BYTES, 'The S3 Note is too large to sync.');
  return parsed;
}

export function createServiceManagerNotesTreeObjectV4(
  tree: S3V4NotesTreePayload,
  objectId: string,
): ServiceManagerNotesTreeObjectV4 {
  return parseServiceManagerNotesTreeObjectV4({
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    layoutVersion: LAYOUT_VERSION,
    app: 'service-manager',
    objectType: 'notes-tree',
    objectId,
    tree,
  });
}

export function parseServiceManagerNotesTreeObjectV4(value: unknown): ServiceManagerNotesTreeObjectV4 {
  if (
    !isRecord(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.syncVersion !== SYNC_VERSION
    || value.layoutVersion !== LAYOUT_VERSION
    || value.app !== 'service-manager'
    || value.objectType !== 'notes-tree'
  ) {
    throw new Error('The S3 Notes tree object is invalid.');
  }
  const parsed: ServiceManagerNotesTreeObjectV4 = {
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    layoutVersion: LAYOUT_VERSION,
    app: 'service-manager',
    objectType: 'notes-tree',
    objectId: normalizedIdentifier(value.objectId, 'Notes tree object identity', 128),
    tree: parseS3V4NotesTreePayload(value.tree),
  };
  measureBoundedJsonBytes(parsed, MAX_NOTES_TREE_BYTES, 'The S3 Notes tree is too large to sync.');
  return parsed;
}

export function createS3V4ObjectId(
  createBytes: (size: number) => Buffer = randomBytes,
): string {
  const bytes = createBytes(24);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== 24) {
    throw new Error('Secure S3 object identity randomness is unavailable.');
  }
  return bytes.toString('base64url');
}

/** Generates a portable random key while still allowing user-defined passphrases. */
export function createS3SyncEncryptionKey(
  createBytes: (size: number) => Buffer = randomBytes,
): string {
  const bytes = createBytes(SYNC_ENCRYPTION_KEY_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== SYNC_ENCRYPTION_KEY_BYTES) {
    throw new Error('Secure Sync Encryption Key randomness is unavailable.');
  }
  return bytes.toString('base64url');
}

export function normalizeS3SyncEncryptionKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('The Sync Encryption Key must contain at least 9 characters.');
  }
  const normalized = value.trim();
  if (Array.from(normalized).length <= 8) {
    throw new Error('The Sync Encryption Key must contain at least 9 characters.');
  }
  return normalized;
}

function syncEncryptionKeyMaterial(value: unknown): Buffer {
  const normalized = normalizeS3SyncEncryptionKey(value);
  if (/^[A-Za-z0-9_-]{43}$/.test(normalized)) {
    const decoded = Buffer.from(normalized, 'base64url');
    if (decoded.byteLength === SYNC_ENCRYPTION_KEY_BYTES && decoded.toString('base64url') === normalized) {
      // Preserve the encryption identity of keys generated by earlier builds.
      return decoded;
    }
  }
  return Buffer.from(normalized, 'utf8');
}

export function getS3SyncEncryptionKeyId(value: unknown): string {
  return sha256Hex(syncEncryptionKeyMaterial(value));
}

export function hashS3V4Object(value: string | Buffer): string {
  return sha256Hex(value);
}

export function hashS3V4NoteContent(value: Note | ServiceManagerNoteObjectV4): string {
  const note = isRecord(value) && value.objectType === 'note'
    ? parseServiceManagerNoteObjectV4(value).note
    : parseNote(value);
  return sha256Hex(JSON.stringify(note));
}

export function hashS3V4NotesTreeContent(
  value: S3V4NotesTreePayload | ServiceManagerNotesTreeObjectV4,
): string {
  const tree = isRecord(value) && value.objectType === 'notes-tree'
    ? parseServiceManagerNotesTreeObjectV4(value).tree
    : parseS3V4NotesTreePayload(value);
  return sha256Hex(JSON.stringify(tree));
}

function encryptionInfo(objectType: S3V4ObjectType): Buffer {
  if (objectType === 'manifest') return MANIFEST_ENCRYPTION_INFO;
  if (objectType === 'note') return NOTE_ENCRYPTION_INFO;
  return NOTES_TREE_ENCRYPTION_INFO;
}

function objectPlaintextLimit(objectType: S3V4ObjectType): number {
  if (objectType === 'manifest') return MAX_MANIFEST_BYTES;
  if (objectType === 'note') return MAX_NOTE_BYTES;
  return MAX_NOTES_TREE_BYTES;
}

function objectCiphertextLimit(objectType: S3V4ObjectType): number {
  return objectPlaintextLimit(objectType);
}

function objectResponseLimit(objectType: S3V4ObjectType): number {
  if (objectType === 'manifest') return MAX_MANIFEST_OBJECT_BYTES;
  if (objectType === 'note') return MAX_NOTE_OBJECT_BYTES;
  return MAX_NOTES_TREE_OBJECT_BYTES;
}

function deriveObjectKey(
  keyMaterial: Buffer,
  salt: Buffer,
  objectType: S3V4ObjectType,
): Buffer {
  return Buffer.from(hkdfSync(
    'sha256',
    keyMaterial,
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

export function parseEncryptedS3ObjectV4(value: unknown): EncryptedS3ObjectV4 {
  if (
    !isRecord(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.syncVersion !== SYNC_VERSION
    || value.layoutVersion !== LAYOUT_VERSION
    || (value.objectType !== 'manifest' && value.objectType !== 'note' && value.objectType !== 'notes-tree')
    || !isRecord(value.encryption)
    || value.encryption.algorithm !== 'AES-256-GCM'
    || value.encryption.kdf !== 'HKDF-SHA256'
  ) {
    throw new Error('The encrypted S3 object is invalid.');
  }
  const objectType = value.objectType;
  const keySource = value.encryption.keySource;
  const keyId = value.encryption.keyId;
  if (
    keySource !== 'sync-key-v1'
    || typeof keyId !== 'string'
    || !/^[a-f0-9]{64}$/.test(keyId)
  ) {
    throw new Error('The encrypted S3 object is invalid.');
  }
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
    layoutVersion: LAYOUT_VERSION,
    objectType,
    objectId: normalizedIdentifier(value.objectId, `${objectType} object identity`, objectType === 'manifest' ? 256 : 128),
    encryption: {
      algorithm: 'AES-256-GCM',
      kdf: 'HKDF-SHA256',
      keySource,
      keyId,
      salt: value.encryption.salt as string,
      iv: value.encryption.iv as string,
      authTag: value.encryption.authTag as string,
    },
    ciphertext: value.ciphertext as string,
  };
}

function encryptS3ObjectV4(
  value: ServiceManagerSyncManifestV4 | ServiceManagerNoteObjectV4 | ServiceManagerNotesTreeObjectV4,
  syncEncryptionKey: string,
  createBytes: (size: number) => Buffer,
): EncryptedS3ObjectV4 {
  const normalizedKey = normalizeS3SyncEncryptionKey(syncEncryptionKey);
  const parsed = parsePlainS3ObjectV4(value);
  return encryptParsedS3ObjectV4(
    parsed,
    syncEncryptionKeyMaterial(normalizedKey),
    createBytes,
    getS3SyncEncryptionKeyId(normalizedKey),
  );
}

type PlainS3ObjectV4 =
  | ServiceManagerSyncManifestV4
  | ServiceManagerNoteObjectV4
  | ServiceManagerNotesTreeObjectV4;

function parsePlainS3ObjectV4(value: PlainS3ObjectV4): PlainS3ObjectV4 {
  const objectType: S3V4ObjectType = 'objectType' in value
    ? value.objectType
    : 'manifest';
  return objectType === 'manifest'
    ? parseServiceManagerSyncManifestV4(value)
    : objectType === 'note'
      ? parseServiceManagerNoteObjectV4(value)
      : parseServiceManagerNotesTreeObjectV4(value);
}

function serializePlainS3ObjectV4(
  value: PlainS3ObjectV4,
  objectType: S3V4ObjectType,
): Buffer {
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  if (plaintext.byteLength > objectPlaintextLimit(objectType)) {
    throw new Error(`The S3 ${objectType} is too large to sync.`);
  }
  return plaintext;
}

function encryptParsedS3ObjectV4(
  value: ServiceManagerSyncManifestV4 | ServiceManagerNoteObjectV4 | ServiceManagerNotesTreeObjectV4,
  keyMaterial: Buffer,
  createBytes: (size: number) => Buffer,
  keyId: string,
  serializedPlaintext?: Buffer,
): EncryptedS3ObjectV4 {
  const objectType: S3V4ObjectType = 'objectType' in value
    ? value.objectType
    : 'manifest';
  const objectId = objectType === 'manifest'
    ? (value as ServiceManagerSyncManifestV4).revision
    : (value as ServiceManagerNoteObjectV4 | ServiceManagerNotesTreeObjectV4).objectId;
  const plaintext = serializedPlaintext ?? serializePlainS3ObjectV4(value, objectType);
  const salt = createBytes(16);
  const iv = createBytes(12);
  if (!Buffer.isBuffer(salt) || salt.byteLength !== 16 || !Buffer.isBuffer(iv) || iv.byteLength !== 12) {
    throw new Error('Secure S3 object randomness is unavailable.');
  }
  const cipher = createCipheriv('aes-256-gcm', deriveObjectKey(keyMaterial, salt, objectType), iv);
  cipher.setAAD(Buffer.from(`${ENCRYPTION_AAD_PREFIX}${objectType}\0${objectId}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    layoutVersion: LAYOUT_VERSION,
    objectType,
    objectId,
    encryption: {
      algorithm: 'AES-256-GCM',
      kdf: 'HKDF-SHA256',
      keySource: 'sync-key-v1',
      keyId,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    },
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptS3ObjectV4(
  value: unknown,
  encryptionKey: string,
  expectedType: S3V4ObjectType,
): ServiceManagerSyncManifestV4 | ServiceManagerNoteObjectV4 | ServiceManagerNotesTreeObjectV4 {
  try {
    if (!encryptionKey) throw new Error('missing key');
    const envelope = parseEncryptedS3ObjectV4(value);
    const keyMaterial = syncEncryptionKeyMaterial(encryptionKey);
    if (envelope.encryption.keyId !== sha256Hex(keyMaterial)) {
      throw new Error('key identity mismatch');
    }
    return decryptParsedS3ObjectV4(envelope, keyMaterial, expectedType);
  } catch {
    throw new Error(`The encrypted S3 ${expectedType} could not be decrypted.`);
  }
}

function decryptParsedS3ObjectV4(
  envelope: EncryptedS3ObjectV4,
  keyMaterial: Buffer,
  expectedType: S3V4ObjectType,
): ServiceManagerSyncManifestV4 | ServiceManagerNoteObjectV4 | ServiceManagerNotesTreeObjectV4 {
  try {
    if (envelope.objectType !== expectedType) throw new Error('object type mismatch');
    const maximumBytes = objectCiphertextLimit(expectedType);
    const salt = strictBase64(envelope.encryption.salt, 16, 16);
    const iv = strictBase64(envelope.encryption.iv, 12, 12);
    const authTag = strictBase64(envelope.encryption.authTag, 16, 16);
    const ciphertext = strictBase64(envelope.ciphertext, maximumBytes);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveObjectKey(keyMaterial, salt, expectedType),
      iv,
    );
    decipher.setAAD(Buffer.from(`${ENCRYPTION_AAD_PREFIX}${expectedType}\0${envelope.objectId}`, 'utf8'));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.byteLength > objectPlaintextLimit(expectedType)) throw new Error('oversized plaintext');
    const raw = JSON.parse(plaintext.toString('utf8')) as unknown;
    if (expectedType === 'manifest') {
      const manifest = parseServiceManagerSyncManifestV4(raw);
      if (manifest.revision !== envelope.objectId) throw new Error('object identity mismatch');
      return manifest;
    }
    if (expectedType === 'note') {
      const noteObject = parseServiceManagerNoteObjectV4(raw);
      if (noteObject.objectId !== envelope.objectId) throw new Error('object identity mismatch');
      return noteObject;
    }
    const treeObject = parseServiceManagerNotesTreeObjectV4(raw);
    if (treeObject.objectId !== envelope.objectId) throw new Error('object identity mismatch');
    return treeObject;
  } catch {
    throw new Error(`The encrypted S3 ${expectedType} could not be decrypted.`);
  }
}

export function encryptS3ManifestV4(
  value: ServiceManagerSyncManifestV4,
  syncEncryptionKey: string,
  createBytes: (size: number) => Buffer = randomBytes,
): EncryptedS3ObjectV4 {
  return encryptS3ObjectV4(value, syncEncryptionKey, createBytes);
}

export function decryptS3ManifestV4(
  value: unknown,
  encryptionKey: string,
): ServiceManagerSyncManifestV4 {
  return decryptS3ObjectV4(value, encryptionKey, 'manifest') as ServiceManagerSyncManifestV4;
}

export function encryptS3NoteV4(
  value: ServiceManagerNoteObjectV4,
  syncEncryptionKey: string,
  createBytes: (size: number) => Buffer = randomBytes,
): EncryptedS3ObjectV4 {
  return encryptS3ObjectV4(value, syncEncryptionKey, createBytes);
}

export function decryptS3NoteV4(
  value: unknown,
  encryptionKey: string,
): ServiceManagerNoteObjectV4 {
  return decryptS3ObjectV4(value, encryptionKey, 'note') as ServiceManagerNoteObjectV4;
}

export function encryptS3NotesTreeV4(
  value: ServiceManagerNotesTreeObjectV4,
  syncEncryptionKey: string,
  createBytes: (size: number) => Buffer = randomBytes,
): EncryptedS3ObjectV4 {
  return encryptS3ObjectV4(value, syncEncryptionKey, createBytes);
}

export function decryptS3NotesTreeV4(
  value: unknown,
  encryptionKey: string,
): ServiceManagerNotesTreeObjectV4 {
  return decryptS3ObjectV4(value, encryptionKey, 'notes-tree') as ServiceManagerNotesTreeObjectV4;
}

export function serializeEncryptedS3ObjectV4(value: EncryptedS3ObjectV4): string {
  return JSON.stringify(parseEncryptedS3ObjectV4(value));
}

export function buildS3V4HeadObjectUrl(endpoint: unknown, bucket: unknown): string {
  const normalized = normalizeS3EndpointBucket(endpoint, bucket);
  return `${normalized.endpoint}/${normalized.bucket}/${LAYOUT_PREFIX}/head.json`;
}

export function buildS3V4ManifestObjectUrl(
  endpoint: unknown,
  bucket: unknown,
  revision: unknown,
): string {
  const normalized = normalizeS3EndpointBucket(endpoint, bucket);
  const id = normalizedIdentifier(revision, 'manifest revision', 256);
  return `${normalized.endpoint}/${normalized.bucket}/${LAYOUT_PREFIX}/manifests/${id}.json`;
}

export function buildS3V4NoteObjectUrl(
  endpoint: unknown,
  bucket: unknown,
  objectId: unknown,
): string {
  const normalized = normalizeS3EndpointBucket(endpoint, bucket);
  const id = normalizedIdentifier(objectId, 'Note object identity', 128);
  return `${normalized.endpoint}/${normalized.bucket}/${LAYOUT_PREFIX}/notes/${id}.json`;
}

export function buildS3V4NotesTreeObjectUrl(
  endpoint: unknown,
  bucket: unknown,
  objectId: unknown,
): string {
  const normalized = normalizeS3EndpointBucket(endpoint, bucket);
  const id = normalizedIdentifier(objectId, 'Notes tree object identity', 128);
  return `${normalized.endpoint}/${normalized.bucket}/${LAYOUT_PREFIX}/notes-trees/${id}.json`;
}

export function createS3SyncHeadV4(
  manifest: ServiceManagerSyncManifestV4,
  manifestSha256: string,
  encryptionKeyId: string,
): S3SyncHeadV4 {
  const parsed = parseServiceManagerSyncManifestV4(manifest);
  return parseS3SyncHeadV4({
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    layoutVersion: LAYOUT_VERSION,
    app: 'service-manager',
    revision: parsed.revision,
    ...(parsed.parentRevision ? { parentRevision: parsed.parentRevision } : {}),
    clientId: parsed.clientId,
    createdAt: parsed.createdAt,
    manifestSha256,
    encryptionKeyId,
  });
}

export function parseS3SyncHeadV4(value: unknown): S3SyncHeadV4 {
  if (
    !isRecord(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.syncVersion !== SYNC_VERSION
    || value.layoutVersion !== LAYOUT_VERSION
    || value.app !== 'service-manager'
  ) {
    throw new Error('The S3 v4 sync head is invalid.');
  }
  const revision = normalizedIdentifier(value.revision, 'manifest revision', 256);
  const parentRevision = value.parentRevision === undefined
    ? undefined
    : normalizedIdentifier(value.parentRevision, 'parent manifest revision', 256);
  if (parentRevision === revision) throw new Error('The S3 v4 sync head is invalid.');
  const encryptionKeyId = digest(value.encryptionKeyId, 'The Sync Encryption Key identity');
  return {
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    layoutVersion: LAYOUT_VERSION,
    app: 'service-manager',
    revision,
    ...(parentRevision ? { parentRevision } : {}),
    clientId: normalizedIdentifier(value.clientId, 'client identity', 128),
    createdAt: isoTimestamp(value.createdAt, 'The S3 v4 head timestamp'),
    manifestSha256: digest(value.manifestSha256, 'The S3 manifest digest'),
    encryptionKeyId,
  };
}

export function assertS3SyncHeadMatchesManifestV4(
  headValue: S3SyncHeadV4,
  manifestValue: ServiceManagerSyncManifestV4,
  manifestSha256: string,
): void {
  const head = parseS3SyncHeadV4(headValue);
  const manifest = parseServiceManagerSyncManifestV4(manifestValue);
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

export function signS3V4Request(input: S3V4SigningInput): S3V4SignedRequest {
  return signS3Request(input);
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

function safeS3ErrorCode(body: Buffer): string | undefined {
  return body.toString('utf8').slice(0, MAX_ERROR_BYTES)
    .match(/<Code>\s*([A-Za-z0-9._-]{1,128})\s*<\/Code>/i)?.[1];
}

function safeHttpError(status: number, body: Buffer, operation = 'S3 sync'): Error {
  const code = safeS3ErrorCode(body);
  return new Error(`${operation} failed (${status}${code ? ` ${code}` : ''}).`);
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
  operation = 'S3 sync',
): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`The ${operation} response is too large.`);
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
        throw new Error(`The ${operation} response is too large.`);
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Sends one signed GET for the canonical v4 head. A missing object is a
 * successful connectivity result because a newly configured bucket has no
 * head yet; a missing bucket remains an error. Existing head content is
 * deliberately neither parsed nor decrypted.
 */
export async function testS3V4Connection(options: S3V4ConnectionTestOptions): Promise<void> {
  const target = normalizeS3EndpointBucket(options.endpoint, options.bucket);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error('The S3 request timeout is invalid.');
  }
  const signed = signS3V4Request({
    method: 'GET',
    objectUrl: buildS3V4HeadObjectUrl(target.endpoint, target.bucket),
    region: options.region,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    now: (options.now ?? (() => new Date()))(),
  });
  const controller = new AbortController();
  const abortFromOwner = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abortFromOwner, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(signed.url, {
        method: 'GET',
        headers: signed.headers,
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch {
      if (timedOut) throw new Error('S3 connection test timed out.');
      if (controller.signal.aborted) throw new Error('S3 connection test was cancelled.');
      throw new Error('S3 connection test request failed.');
    }
    if (response.status === 200) {
      await response.body?.cancel().catch(() => undefined);
    } else {
      const body = await readBoundedBody(response, MAX_ERROR_BYTES, controller.signal, 'S3 connection test');
      const missingHead = response.status === 404
        && safeS3ErrorCode(body) === 'NoSuchKey';
      if (!missingHead) throw safeHttpError(response.status, body, 'S3 connection test');
    }
    if (timedOut) throw new Error('S3 connection test timed out.');
    if (controller.signal.aborted) throw new Error('S3 connection test was cancelled.');
  } catch (error) {
    if (timedOut) throw new Error('S3 connection test timed out.');
    if (controller.signal.aborted) throw new Error('S3 connection test was cancelled.');
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromOwner);
  }
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

export class S3V4ObjectStore {
  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly createRandomBytes: (size: number) => Buffer;
  private readonly timeoutMs: number;
  private readonly syncEncryptionKeyMaterial: Buffer;
  private readonly syncEncryptionKeyId: string;
  private readonly previousSyncEncryptionKeyMaterial?: Buffer;
  private readonly previousSyncEncryptionKeyId?: string;
  private readonly activeControllers = new Set<AbortController>();

  public constructor(private readonly options: S3V4ObjectStoreOptions) {
    const target = normalizeS3EndpointBucket(options.endpoint, options.bucket);
    this.endpoint = target.endpoint;
    this.bucket = target.bucket;
    if (!options.region || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(options.region.trim())) {
      throw new Error('A valid S3 region is required.');
    }
    if (!options.accessKeyId || !options.secretAccessKey) throw new Error('S3 credentials are unavailable.');
    const normalizedSyncEncryptionKey = normalizeS3SyncEncryptionKey(options.syncEncryptionKey);
    this.syncEncryptionKeyMaterial = syncEncryptionKeyMaterial(normalizedSyncEncryptionKey);
    this.syncEncryptionKeyId = sha256Hex(this.syncEncryptionKeyMaterial);
    if (options.previousSyncEncryptionKey !== undefined) {
      const normalizedPreviousKey = normalizeS3SyncEncryptionKey(options.previousSyncEncryptionKey);
      this.previousSyncEncryptionKeyMaterial = syncEncryptionKeyMaterial(normalizedPreviousKey);
      this.previousSyncEncryptionKeyId = sha256Hex(this.previousSyncEncryptionKeyMaterial);
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.createRandomBytes = options.createRandomBytes ?? randomBytes;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new Error('The S3 request timeout is invalid.');
    }
  }

  public async getHead(): Promise<S3V4HeadReadResult> {
    const result = await this.request('GET', buildS3V4HeadObjectUrl(this.endpoint, this.bucket), undefined, {}, MAX_HEAD_OBJECT_BYTES);
    if (result.status === 404) return { status: 'missing' };
    this.requireSuccess(result);
    return {
      status: 'found',
      head: parseS3SyncHeadV4(parseJsonBody(result.body, 'v4 head')),
      etag: responseEtag(result.headers, true) as string,
    };
  }

  public async getManifest(revision: string, expectedSha256?: string): Promise<S3V4ManifestReadResult> {
    const id = normalizedIdentifier(revision, 'manifest revision', 256);
    const expected = expectedSha256 === undefined
      ? undefined
      : digest(expectedSha256, 'The expected S3 manifest digest');
    const result = await this.request(
      'GET',
      buildS3V4ManifestObjectUrl(this.endpoint, this.bucket, id),
      undefined,
      {},
      objectResponseLimit('manifest'),
    );
    if (result.status === 404) return { status: 'missing' };
    this.requireSuccess(result);
    const manifestSha256 = hashS3V4Object(result.body);
    if (expected !== undefined && manifestSha256 !== expected) {
      throw new Error('The S3 sync manifest digest does not match the shared head.');
    }
    const encrypted = parseEncryptedS3ObjectV4(parseJsonBody(result.body, 'manifest'));
    if (encrypted.objectType !== 'manifest' || encrypted.objectId !== id) {
      throw new Error('The S3 sync manifest is invalid.');
    }
    const manifest = this.decryptManifest(encrypted);
    return {
      status: 'found',
      manifest,
      encrypted,
      manifestSha256,
      encryptionKeyId: encrypted.encryption.keyId,
    };
  }

  public async putManifest(manifestValue: ServiceManagerSyncManifestV4): Promise<S3V4ManifestWriteResult> {
    const manifest = parseServiceManagerSyncManifestV4(manifestValue);
    const plaintext = serializePlainS3ObjectV4(manifest, 'manifest');
    const encrypted = encryptParsedS3ObjectV4(
      manifest,
      this.syncEncryptionKeyMaterial,
      this.createRandomBytes,
      this.syncEncryptionKeyId,
      plaintext,
    );
    // This envelope was produced immediately above from already validated
    // plaintext, so avoid reparsing the complete base64 ciphertext solely to
    // serialize it for the owned PUT request.
    const body = JSON.stringify(encrypted);
    const manifestSha256 = hashS3V4Object(body);
    const byteLength = Buffer.byteLength(body, 'utf8');
    const result = await this.request(
      'PUT',
      buildS3V4ManifestObjectUrl(this.endpoint, this.bucket, manifest.revision),
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

  public async getNote(referenceValue: S3V4NoteReference): Promise<S3V4NoteReadResult> {
    const reference = parseNoteReference(referenceValue);
    const result = await this.request(
      'GET',
      buildS3V4NoteObjectUrl(this.endpoint, this.bucket, reference.objectId),
      undefined,
      {},
      objectResponseLimit('note'),
    );
    if (result.status === 404) return { status: 'missing' };
    this.requireSuccess(result);
    if (hashS3V4Object(result.body) !== reference.sha256) {
      throw new Error('The S3 Note object digest does not match its manifest reference.');
    }
    const encrypted = parseEncryptedS3ObjectV4(parseJsonBody(result.body, 'Note object'));
    if (encrypted.objectType !== 'note' || encrypted.objectId !== reference.objectId) {
      throw new Error('The S3 Note object is invalid.');
    }
    if (reference.encryptionKeyId !== encrypted.encryption.keyId) {
      throw new Error('The S3 Note object encryption identity does not match its manifest reference.');
    }
    const object = this.decryptNote(encrypted);
    if (object.note.id !== reference.id || hashS3V4NoteContent(object) !== reference.contentHash) {
      throw new Error('The S3 Note object does not match its manifest reference.');
    }
    return {
      status: 'found',
      object,
      encrypted,
      reference,
      encryptionKeyId: encrypted.encryption.keyId,
    };
  }

  public async putNote(objectValue: ServiceManagerNoteObjectV4): Promise<S3V4NoteWriteResult> {
    const object = parseServiceManagerNoteObjectV4(objectValue);
    const plaintext = serializePlainS3ObjectV4(object, 'note');
    const contentHash = sha256Hex(JSON.stringify(object.note));
    const encrypted = encryptParsedS3ObjectV4(
      object,
      this.syncEncryptionKeyMaterial,
      this.createRandomBytes,
      this.syncEncryptionKeyId,
      plaintext,
    );
    const body = JSON.stringify(encrypted);
    const reference: S3V4NoteReference = {
      id: object.note.id,
      objectId: object.objectId,
      sha256: hashS3V4Object(body),
      contentHash,
      encryptionKeyId: this.syncEncryptionKeyId,
    };
    const result = await this.request(
      'PUT',
      buildS3V4NoteObjectUrl(this.endpoint, this.bucket, object.objectId),
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

  public async getNotesTree(referenceValue: S3V4NotesTreeReference): Promise<S3V4NotesTreeReadResult> {
    const reference = parseS3V4NotesTreeReference(referenceValue);
    const result = await this.request(
      'GET',
      buildS3V4NotesTreeObjectUrl(this.endpoint, this.bucket, reference.objectId),
      undefined,
      {},
      objectResponseLimit('notes-tree'),
    );
    if (result.status === 404) return { status: 'missing' };
    this.requireSuccess(result);
    if (hashS3V4Object(result.body) !== reference.sha256) {
      throw new Error('The S3 Notes tree object digest does not match its manifest reference.');
    }
    const encrypted = parseEncryptedS3ObjectV4(parseJsonBody(result.body, 'Notes tree object'));
    if (encrypted.objectType !== 'notes-tree' || encrypted.objectId !== reference.objectId) {
      throw new Error('The S3 Notes tree object is invalid.');
    }
    if (reference.encryptionKeyId !== encrypted.encryption.keyId) {
      throw new Error('The S3 Notes tree encryption identity does not match its manifest reference.');
    }
    const object = this.decryptNotesTree(encrypted);
    if (hashS3V4NotesTreeContent(object) !== reference.contentHash) {
      throw new Error('The S3 Notes tree object does not match its manifest reference.');
    }
    return {
      status: 'found',
      object,
      encrypted,
      reference,
      encryptionKeyId: encrypted.encryption.keyId,
    };
  }

  public async putNotesTree(
    objectValue: ServiceManagerNotesTreeObjectV4,
  ): Promise<S3V4NotesTreeWriteResult> {
    const object = parseServiceManagerNotesTreeObjectV4(objectValue);
    const plaintext = serializePlainS3ObjectV4(object, 'notes-tree');
    const contentHash = sha256Hex(JSON.stringify(object.tree));
    const encrypted = encryptParsedS3ObjectV4(
      object,
      this.syncEncryptionKeyMaterial,
      this.createRandomBytes,
      this.syncEncryptionKeyId,
      plaintext,
    );
    const body = JSON.stringify(encrypted);
    const reference: S3V4NotesTreeReference = {
      objectId: object.objectId,
      sha256: hashS3V4Object(body),
      contentHash,
      encryptionKeyId: this.syncEncryptionKeyId,
    };
    const result = await this.request(
      'PUT',
      buildS3V4NotesTreeObjectUrl(this.endpoint, this.bucket, object.objectId),
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

  public async putHead(headValue: S3SyncHeadV4, expectedEtag?: string): Promise<S3V4ConditionalWriteResult> {
    const head = parseS3SyncHeadV4(headValue);
    if (head.encryptionKeyId !== this.syncEncryptionKeyId) {
      throw new Error('The S3 sync head must use the active Sync Encryption Key.');
    }
    const body = JSON.stringify(head);
    const conditions = expectedEtag === undefined
      ? { ifNoneMatch: '*' as const }
      : { ifMatch: normalizedEtag(expectedEtag) };
    const result = await this.request(
      'PUT',
      buildS3V4HeadObjectUrl(this.endpoint, this.bucket),
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

  private decryptManifest(encrypted: EncryptedS3ObjectV4): ServiceManagerSyncManifestV4 {
    return this.decryptWithAvailableKeys(encrypted, 'manifest') as ServiceManagerSyncManifestV4;
  }

  private decryptNote(encrypted: EncryptedS3ObjectV4): ServiceManagerNoteObjectV4 {
    return this.decryptWithAvailableKeys(encrypted, 'note') as ServiceManagerNoteObjectV4;
  }

  private decryptNotesTree(encrypted: EncryptedS3ObjectV4): ServiceManagerNotesTreeObjectV4 {
    return this.decryptWithAvailableKeys(encrypted, 'notes-tree') as ServiceManagerNotesTreeObjectV4;
  }

  private decryptWithAvailableKeys(
    encrypted: EncryptedS3ObjectV4,
    expectedType: S3V4ObjectType,
  ): PlainS3ObjectV4 {
    const keyId = encrypted.encryption.keyId;
    if (keyId === this.syncEncryptionKeyId) {
      return decryptParsedS3ObjectV4(encrypted, this.syncEncryptionKeyMaterial, expectedType);
    }
    if (
      this.previousSyncEncryptionKeyMaterial
      && keyId === this.previousSyncEncryptionKeyId
    ) {
      return decryptParsedS3ObjectV4(encrypted, this.previousSyncEncryptionKeyMaterial, expectedType);
    }
    throw new Error('The Sync Encryption Key does not match the S3 data.');
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
    const signed = signS3V4Request({
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
