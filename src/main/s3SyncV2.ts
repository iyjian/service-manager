import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

const SYNC_VERSION = 2 as const;
const SCHEMA_VERSION = 2 as const;
const LAYOUT_PREFIX = 'service-manager/v2';
const MAX_ENDPOINT_LENGTH = 4_096;
const MAX_BUCKET_LENGTH = 63;
const MAX_REGION_LENGTH = 128;
const MAX_REVISION_BYTES = 50 * 1024 * 1024;
const MAX_REVISION_OBJECT_BYTES = 72 * 1024 * 1024;
const MAX_HEAD_OBJECT_BYTES = 16 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const ENCRYPTION_INFO = Buffer.from('service-manager-s3-sync-v2', 'utf8');
const ENCRYPTION_AAD_PREFIX = 'service-manager-s3-revision-v2\0';

export interface S3EndpointBucket {
  endpoint: string;
  bucket: string;
}

export interface ServiceManagerSyncRevisionV2 {
  schemaVersion: 2;
  syncVersion: 2;
  app: 'service-manager';
  appVersion: string;
  revision: string;
  parentRevision?: string;
  clientId: string;
  createdAt: string;
  data: Record<string, unknown>;
}

export interface EncryptedS3RevisionV2 {
  schemaVersion: 2;
  syncVersion: 2;
  revision: string;
  encryption: {
    algorithm: 'AES-256-GCM';
    kdf: 'HKDF-SHA256';
    salt: string;
    iv: string;
    authTag: string;
  };
  ciphertext: string;
}

export interface S3SyncHeadV2 {
  schemaVersion: 2;
  syncVersion: 2;
  app: 'service-manager';
  revision: string;
  parentRevision?: string;
  clientId: string;
  createdAt: string;
  snapshotSha256: string;
}

export interface S3V2SigningInput {
  method: 'GET' | 'PUT';
  objectUrl: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  payload?: string | Buffer;
  ifMatch?: string;
  ifNoneMatch?: '*';
  now: Date;
}

export interface S3V2SignedRequest {
  url: string;
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export interface S3V2ObjectStoreOptions extends S3EndpointBucket {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  createRandomBytes?: (size: number) => Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type S3V2HeadReadResult =
  | { status: 'missing' }
  | { status: 'found'; head: S3SyncHeadV2; etag: string };

export type S3V2RevisionReadResult =
  | { status: 'missing' }
  | {
    status: 'found';
    revision: ServiceManagerSyncRevisionV2;
    encrypted: EncryptedS3RevisionV2;
    snapshotSha256: string;
  };

export type S3V2ConditionalWriteResult =
  | { status: 'written'; etag?: string }
  | { status: 'conflict' };

export interface S3V2RevisionWriteResult {
  status: 'written' | 'conflict';
  snapshotSha256: string;
  byteLength: number;
  etag?: string;
}

interface HttpResult {
  status: number;
  headers: Headers;
  body: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '[::1]'
    || normalized === '::1';
}

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function normalizedIdentifier(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string' || !new RegExp(`^[A-Za-z0-9_-]{1,${maximumLength}}$`).test(value)) {
    throw new Error(`The S3 ${label} is invalid.`);
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

function parseEndpoint(value: unknown, requireRootPath: boolean): URL {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_ENDPOINT_LENGTH) {
    throw new Error('An S3 endpoint is required.');
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('The S3 endpoint is invalid.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The S3 endpoint must use HTTPS.');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error('The S3 endpoint must use HTTPS unless it targets localhost.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The S3 endpoint cannot contain credentials, a query, or a fragment.');
  }
  if (requireRootPath && url.pathname !== '/' && url.pathname !== '') {
    throw new Error('The S3 endpoint cannot contain a bucket path.');
  }
  try {
    canonicalizeS3V2Path(url.pathname);
  } catch {
    throw new Error('The S3 endpoint contains an invalid path encoding.');
  }
  return url;
}

export function normalizeS3Endpoint(value: unknown): string {
  const url = parseEndpoint(value, true);
  return `${url.protocol}//${url.host}`;
}

export function normalizeS3Bucket(value: unknown): string {
  if (typeof value !== 'string') throw new Error('An S3 bucket is required.');
  const bucket = value.trim();
  if (
    bucket.length < 3
    || bucket.length > MAX_BUCKET_LENGTH
    || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)
    || bucket.includes('..')
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)
  ) {
    throw new Error('The S3 bucket must be a DNS-compatible name with 3 to 63 characters.');
  }
  return bucket;
}

export function normalizeS3EndpointBucket(endpoint: unknown, bucket: unknown): S3EndpointBucket {
  return {
    endpoint: normalizeS3Endpoint(endpoint),
    bucket: normalizeS3Bucket(bucket),
  };
}

export function buildS3BucketUrl(endpoint: unknown, bucket: unknown): string {
  const normalized = normalizeS3EndpointBucket(endpoint, bucket);
  return `${normalized.endpoint}/${normalized.bucket}`;
}

export function splitLegacyS3BucketUrl(value: unknown): S3EndpointBucket {
  const url = parseEndpoint(value, false);
  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    throw new Error('The legacy S3 bucket URL contains an invalid path encoding.');
  }
  if (segments.length !== 1) {
    throw new Error('The legacy S3 bucket URL must contain exactly one bucket path.');
  }
  return {
    endpoint: `${url.protocol}//${url.host}`,
    bucket: normalizeS3Bucket(segments[0]),
  };
}

export function buildS3V2HeadObjectUrl(endpoint: unknown, bucket: unknown): string {
  return `${buildS3BucketUrl(endpoint, bucket)}/${LAYOUT_PREFIX}/head.json`;
}

export function buildS3V2RevisionObjectUrl(endpoint: unknown, bucket: unknown, revision: unknown): string {
  const normalizedRevision = normalizedIdentifier(revision, 'snapshot revision', 256);
  return `${buildS3BucketUrl(endpoint, bucket)}/${LAYOUT_PREFIX}/revisions/${normalizedRevision}.json`;
}

export function createServiceManagerSyncRevisionV2(
  data: Record<string, unknown>,
  options: {
    appVersion: string;
    revision: string;
    parentRevision?: string;
    clientId: string;
    createdAt?: string;
  },
): ServiceManagerSyncRevisionV2 {
  const candidate: ServiceManagerSyncRevisionV2 = {
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    app: 'service-manager',
    appVersion: options.appVersion,
    revision: options.revision,
    ...(options.parentRevision ? { parentRevision: options.parentRevision } : {}),
    clientId: options.clientId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    data,
  };
  return parseServiceManagerSyncRevisionV2(candidate);
}

export function parseServiceManagerSyncRevisionV2(value: unknown): ServiceManagerSyncRevisionV2 {
  if (
    !isRecord(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.syncVersion !== SYNC_VERSION
    || value.app !== 'service-manager'
    || typeof value.appVersion !== 'string'
    || value.appVersion.length === 0
    || value.appVersion.length > 128
    || !isRecord(value.data)
    || !isValidIsoTimestamp(value.createdAt)
  ) {
    throw new Error('The S3 sync revision is invalid.');
  }
  const revision = normalizedIdentifier(value.revision, 'snapshot revision', 256);
  const clientId = normalizedIdentifier(value.clientId, 'client identity', 128);
  const parentRevision = value.parentRevision === undefined
    ? undefined
    : normalizedIdentifier(value.parentRevision, 'parent revision', 256);
  if (parentRevision === revision) throw new Error('The S3 sync revision is invalid.');
  measureBoundedJsonBytes(value, MAX_REVISION_BYTES);
  return {
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    app: 'service-manager',
    appVersion: value.appVersion,
    revision,
    ...(parentRevision ? { parentRevision } : {}),
    clientId,
    createdAt: value.createdAt,
    data: value.data,
  };
}

export function createS3SyncHeadV2(
  revision: ServiceManagerSyncRevisionV2,
  snapshotSha256: string,
): S3SyncHeadV2 {
  return parseS3SyncHeadV2({
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    app: 'service-manager',
    revision: revision.revision,
    ...(revision.parentRevision ? { parentRevision: revision.parentRevision } : {}),
    clientId: revision.clientId,
    createdAt: revision.createdAt,
    snapshotSha256,
  });
}

export function parseS3SyncHeadV2(value: unknown): S3SyncHeadV2 {
  if (
    !isRecord(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.syncVersion !== SYNC_VERSION
    || value.app !== 'service-manager'
    || !isValidIsoTimestamp(value.createdAt)
    || typeof value.snapshotSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.snapshotSha256)
  ) {
    throw new Error('The S3 sync head is invalid.');
  }
  const revision = normalizedIdentifier(value.revision, 'snapshot revision', 256);
  const clientId = normalizedIdentifier(value.clientId, 'client identity', 128);
  const parentRevision = value.parentRevision === undefined
    ? undefined
    : normalizedIdentifier(value.parentRevision, 'parent revision', 256);
  if (parentRevision === revision) throw new Error('The S3 sync head is invalid.');
  return {
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    app: 'service-manager',
    revision,
    ...(parentRevision ? { parentRevision } : {}),
    clientId,
    createdAt: value.createdAt,
    snapshotSha256: value.snapshotSha256,
  };
}

export function assertS3SyncHeadMatchesRevisionV2(
  headValue: S3SyncHeadV2,
  revisionValue: ServiceManagerSyncRevisionV2,
  snapshotSha256: string,
): void {
  const head = parseS3SyncHeadV2(headValue);
  const revision = parseServiceManagerSyncRevisionV2(revisionValue);
  if (
    snapshotSha256 !== head.snapshotSha256
    || revision.revision !== head.revision
    || revision.parentRevision !== head.parentRevision
    || revision.clientId !== head.clientId
    || revision.createdAt !== head.createdAt
  ) {
    throw new Error('The S3 sync revision does not match the shared head.');
  }
}

function deriveRevisionKey(secretAccessKey: string, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secretAccessKey, 'utf8'), salt, ENCRYPTION_INFO, 32));
}

function strictBase64(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REVISION_OBJECT_BYTES * 2) {
    throw new Error('invalid base64');
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)) {
    throw new Error('invalid base64');
  }
  return decoded;
}

export function parseEncryptedS3RevisionV2(value: unknown): EncryptedS3RevisionV2 {
  if (
    !isRecord(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.syncVersion !== SYNC_VERSION
    || !isRecord(value.encryption)
    || value.encryption.algorithm !== 'AES-256-GCM'
    || value.encryption.kdf !== 'HKDF-SHA256'
  ) {
    throw new Error('The encrypted S3 revision is invalid.');
  }
  const revision = normalizedIdentifier(value.revision, 'snapshot revision', 256);
  try {
    strictBase64(value.encryption.salt, 16);
    strictBase64(value.encryption.iv, 12);
    strictBase64(value.encryption.authTag, 16);
    const ciphertext = strictBase64(value.ciphertext);
    if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_REVISION_BYTES) throw new Error('invalid ciphertext');
  } catch {
    throw new Error('The encrypted S3 revision is invalid.');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    revision,
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

export function encryptS3RevisionV2(
  value: ServiceManagerSyncRevisionV2,
  secretAccessKey: string,
  createBytes: (size: number) => Buffer = randomBytes,
): EncryptedS3RevisionV2 {
  if (typeof secretAccessKey !== 'string' || secretAccessKey.length === 0) {
    throw new Error('The S3 secret access key is unavailable.');
  }
  const revision = parseServiceManagerSyncRevisionV2(value);
  const plaintext = Buffer.from(JSON.stringify(revision), 'utf8');
  if (plaintext.byteLength > MAX_REVISION_BYTES) {
    throw new Error('The application data snapshot is too large to sync.');
  }
  const salt = createBytes(16);
  const iv = createBytes(12);
  if (!Buffer.isBuffer(salt) || salt.byteLength !== 16 || !Buffer.isBuffer(iv) || iv.byteLength !== 12) {
    throw new Error('Secure snapshot randomness is unavailable.');
  }
  const cipher = createCipheriv('aes-256-gcm', deriveRevisionKey(secretAccessKey, salt), iv);
  cipher.setAAD(Buffer.from(`${ENCRYPTION_AAD_PREFIX}${revision.revision}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    schemaVersion: SCHEMA_VERSION,
    syncVersion: SYNC_VERSION,
    revision: revision.revision,
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

export function decryptS3RevisionV2(value: unknown, secretAccessKey: string): ServiceManagerSyncRevisionV2 {
  try {
    if (typeof secretAccessKey !== 'string' || secretAccessKey.length === 0) throw new Error('missing key');
    const envelope = parseEncryptedS3RevisionV2(value);
    const salt = strictBase64(envelope.encryption.salt, 16);
    const iv = strictBase64(envelope.encryption.iv, 12);
    const authTag = strictBase64(envelope.encryption.authTag, 16);
    const ciphertext = strictBase64(envelope.ciphertext);
    const decipher = createDecipheriv('aes-256-gcm', deriveRevisionKey(secretAccessKey, salt), iv);
    decipher.setAAD(Buffer.from(`${ENCRYPTION_AAD_PREFIX}${envelope.revision}`, 'utf8'));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.byteLength > MAX_REVISION_BYTES) throw new Error('oversized plaintext');
    const revision = parseServiceManagerSyncRevisionV2(JSON.parse(plaintext.toString('utf8')));
    if (revision.revision !== envelope.revision) throw new Error('revision mismatch');
    return revision;
  } catch {
    throw new Error('The encrypted S3 revision could not be decrypted.');
  }
}

export function serializeEncryptedS3RevisionV2(value: EncryptedS3RevisionV2): string {
  return JSON.stringify(parseEncryptedS3RevisionV2(value));
}

export function hashS3V2RevisionObject(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
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

export function canonicalizeS3V2Path(pathname: string): string {
  const canonical = pathname
    .split('/')
    .map((segment) => awsUriEncode(decodeURIComponent(segment)))
    .join('/');
  return canonical.startsWith('/') ? canonical : `/${canonical}`;
}

function amzTimestamp(value: Date): { amzDate: string; dateStamp: string } {
  if (!Number.isFinite(value.getTime())) throw new Error('The S3 signing timestamp is invalid.');
  const amzDate = value.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
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

export function signS3V2Request(input: S3V2SigningInput): S3V2SignedRequest {
  const url = parseEndpoint(input.objectUrl, false);
  if (url.pathname === '/' || url.pathname === '') throw new Error('The S3 object URL is invalid.');
  const region = normalizedRegion(input.region);
  if (!input.accessKeyId || !input.secretAccessKey) throw new Error('S3 credentials are unavailable.');
  if (input.ifMatch !== undefined && input.ifNoneMatch !== undefined) {
    throw new Error('Conflicting S3 request conditions are invalid.');
  }
  const payload = input.payload ?? '';
  if (input.method === 'GET' && Buffer.byteLength(payload) !== 0) {
    throw new Error('An S3 GET request cannot contain a payload.');
  }
  const canonicalUri = canonicalizeS3V2Path(url.pathname);
  const requestUrl = `${url.protocol}//${url.host}${canonicalUri}`;
  const payloadHash = sha256Hex(payload);
  const { amzDate, dateStamp } = amzTimestamp(input.now);
  const requestHeaders: Record<string, string> = {
    ...(input.method === 'PUT' ? { 'content-type': 'application/json' } : {}),
    host: url.host.toLowerCase(),
    ...(input.ifMatch !== undefined ? { 'if-match': normalizedEtag(input.ifMatch) } : {}),
    ...(input.ifNoneMatch !== undefined ? { 'if-none-match': '*' } : {}),
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const headerNames = Object.keys(requestHeaders).sort();
  const canonicalHeaders = `${headerNames.map((name) => `${name}:${requestHeaders[name]}`).join('\n')}\n`;
  const signedHeaders = headerNames.join(';');
  const canonicalRequest = [
    input.method,
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
  const fetchHeaders = { ...requestHeaders };
  delete fetchHeaders.host;
  return {
    url: requestUrl,
    canonicalRequest,
    stringToSign,
    signature,
    headers: { ...fetchHeaders, authorization },
  };
}

function safeHttpError(status: number, body: Buffer): Error {
  const match = body.toString('utf8').slice(0, MAX_ERROR_BYTES).match(/<Code>\s*([A-Za-z0-9._-]{1,128})\s*<\/Code>/i);
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

export class S3V2ObjectStore {
  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly region: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly createRandomBytes: (size: number) => Buffer;
  private readonly timeoutMs: number;
  private readonly activeControllers = new Set<AbortController>();

  public constructor(private readonly options: S3V2ObjectStoreOptions) {
    const target = normalizeS3EndpointBucket(options.endpoint, options.bucket);
    this.endpoint = target.endpoint;
    this.bucket = target.bucket;
    this.region = normalizedRegion(options.region);
    if (!options.accessKeyId || !options.secretAccessKey) throw new Error('S3 credentials are unavailable.');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.createRandomBytes = options.createRandomBytes ?? randomBytes;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new Error('The S3 request timeout is invalid.');
    }
  }

  public async getHead(): Promise<S3V2HeadReadResult> {
    const result = await this.request(
      'GET',
      buildS3V2HeadObjectUrl(this.endpoint, this.bucket),
      undefined,
      {},
      MAX_HEAD_OBJECT_BYTES,
    );
    if (result.status === 404) return { status: 'missing' };
    this.requireSuccess(result);
    const head = parseS3SyncHeadV2(parseJsonBody(result.body, 'head'));
    return { status: 'found', head, etag: responseEtag(result.headers, true) as string };
  }

  public async getRevision(revision: string, expectedSha256?: string): Promise<S3V2RevisionReadResult> {
    const normalizedRevision = normalizedIdentifier(revision, 'snapshot revision', 256);
    if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new Error('The expected S3 snapshot digest is invalid.');
    }
    const result = await this.request(
      'GET',
      buildS3V2RevisionObjectUrl(this.endpoint, this.bucket, normalizedRevision),
      undefined,
      {},
      MAX_REVISION_OBJECT_BYTES,
    );
    if (result.status === 404) return { status: 'missing' };
    this.requireSuccess(result);
    const snapshotSha256 = hashS3V2RevisionObject(result.body);
    if (expectedSha256 !== undefined && snapshotSha256 !== expectedSha256) {
      throw new Error('The S3 sync revision digest does not match the shared head.');
    }
    const encrypted = parseEncryptedS3RevisionV2(parseJsonBody(result.body, 'revision'));
    if (encrypted.revision !== normalizedRevision) throw new Error('The S3 sync revision is invalid.');
    const decrypted = decryptS3RevisionV2(encrypted, this.options.secretAccessKey);
    return { status: 'found', revision: decrypted, encrypted, snapshotSha256 };
  }

  public async putRevision(revision: ServiceManagerSyncRevisionV2): Promise<S3V2RevisionWriteResult> {
    const validated = parseServiceManagerSyncRevisionV2(revision);
    const encrypted = encryptS3RevisionV2(validated, this.options.secretAccessKey, this.createRandomBytes);
    const body = serializeEncryptedS3RevisionV2(encrypted);
    const snapshotSha256 = hashS3V2RevisionObject(body);
    const byteLength = Buffer.byteLength(body, 'utf8');
    const result = await this.request(
      'PUT',
      buildS3V2RevisionObjectUrl(this.endpoint, this.bucket, validated.revision),
      body,
      { ifNoneMatch: '*' },
    );
    if (result.status === 409 || result.status === 412) {
      return { status: 'conflict', snapshotSha256, byteLength };
    }
    this.requireSuccess(result);
    const etag = responseEtag(result.headers, false);
    return { status: 'written', snapshotSha256, byteLength, ...(etag ? { etag } : {}) };
  }

  public async putHead(head: S3SyncHeadV2, expectedEtag?: string): Promise<S3V2ConditionalWriteResult> {
    const validated = parseS3SyncHeadV2(head);
    const body = JSON.stringify(validated);
    const conditions = expectedEtag === undefined
      ? { ifNoneMatch: '*' as const }
      : { ifMatch: normalizedEtag(expectedEtag) };
    const result = await this.request(
      'PUT',
      buildS3V2HeadObjectUrl(this.endpoint, this.bucket),
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
    const signed = signS3V2Request({
      method,
      objectUrl,
      region: this.region,
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      ...(body !== undefined ? { payload: body } : {}),
      ...conditions,
      now: this.now(),
    });
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const abortFromOwner = (): void => controller.abort();
    if (this.options.signal?.aborted) {
      controller.abort();
    } else {
      this.options.signal?.addEventListener('abort', abortFromOwner, { once: true });
    }
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

function measureBoundedJsonBytes(value: unknown, maximumBytes: number): number {
  let bytes = 0;
  const ancestors = new WeakSet<object>();
  const add = (amount: number): void => {
    bytes += amount;
    if (bytes > maximumBytes) throw new Error('The application data snapshot is too large to sync.');
  };
  const addString = (text: string): void => {
    const serialized = JSON.stringify(text);
    add(Buffer.byteLength(serialized, 'utf8'));
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
      if (prototype !== Object.prototype && prototype !== null) throw new Error('Snapshot data could not be serialized.');
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
