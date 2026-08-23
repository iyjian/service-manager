import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type { NoteAttachmentReference } from '../../shared/types';
import {
  parseNoteAttachmentReference as parseCanonicalNoteAttachmentReference,
  RICH_TEXT_LIMITS,
} from '../../shared/noteRichText';
import {
  normalizeS3EndpointBucket,
  signS3Request,
  type S3EndpointBucket,
} from '../s3/s3Request';

const SCHEMA_VERSION = 1 as const;
const OBJECT_TYPE = 'notes-attachment' as const;
const OBJECT_PATH_PREFIX = 'service-manager/v4/attachments';
const AAD_PREFIX = 'service-manager-notes-attachment-v1\0';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_ENCRYPTED_OBJECT_BYTES = 36 * 1024 * 1024;
const OBJECT_ID_BYTES = 24;
const ASSET_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export const NOTES_ATTACHMENT_LIMITS = Object.freeze({
  bytes: RICH_TEXT_LIMITS.attachmentBytes,
  fileNameCharacters: RICH_TEXT_LIMITS.attachmentFileNameCharacters,
  mimeTypeCharacters: RICH_TEXT_LIMITS.attachmentMimeTypeCharacters,
});

export interface EncryptedNotesAttachmentObject {
  schemaVersion: typeof SCHEMA_VERSION;
  objectType: typeof OBJECT_TYPE;
  objectId: string;
  encryption: {
    algorithm: 'AES-256-GCM';
    iv: string;
    authTag: string;
  };
  ciphertext: string;
}

export interface CreatedNotesAttachmentObject {
  reference: NoteAttachmentReference;
  encrypted: EncryptedNotesAttachmentObject;
  body: string;
}

export interface NotesAttachmentS3StoreOptions extends S3EndpointBucket {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  createRandomBytes?: (size: number) => Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const allowed = new Set(required);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function strictBase64Url(value: unknown, expectedBytes: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('invalid base64url');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== expectedBytes || decoded.toString('base64url') !== value) {
    throw new Error('invalid base64url');
  }
  return decoded;
}

function strictBase64(value: unknown, maximumBytes: number): Buffer {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > Math.ceil(maximumBytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('invalid base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength === 0 || decoded.byteLength > maximumBytes || decoded.toString('base64') !== value) {
    throw new Error('invalid base64');
  }
  return decoded;
}

function secureRandomBytes(createBytes: (size: number) => Buffer, size: number): Buffer {
  const value = createBytes(size);
  if (!Buffer.isBuffer(value) || value.byteLength !== size) {
    throw new Error('Secure Notes attachment randomness is unavailable.');
  }
  return Buffer.from(value);
}

function copyAttachmentBytes(value: unknown): Buffer {
  if (!(value instanceof Uint8Array)) throw new Error('Notes attachment data is invalid.');
  const bytes = Buffer.from(value);
  if (bytes.byteLength < 1 || bytes.byteLength > NOTES_ATTACHMENT_LIMITS.bytes) {
    throw new Error(`A Notes attachment must not exceed ${NOTES_ATTACHMENT_LIMITS.bytes / (1024 * 1024)} MiB.`);
  }
  return bytes;
}

function attachmentAad(reference: Pick<
  NoteAttachmentReference,
  'objectId' | 'contentSha256' | 'fileName' | 'mimeType' | 'byteLength'
>): Buffer {
  return Buffer.from([
    AAD_PREFIX,
    reference.objectId,
    reference.contentSha256,
    String(reference.byteLength),
    reference.fileName,
    reference.mimeType,
  ].join('\0'), 'utf8');
}

export function parseNotesAttachmentReference(value: unknown): NoteAttachmentReference {
  try {
    return parseCanonicalNoteAttachmentReference(value);
  } catch {
    throw new Error('The Notes attachment reference is invalid.');
  }
}

export function createEncryptedNotesAttachmentObject(
  value: Uint8Array,
  fileName: unknown,
  mimeType: unknown = 'application/octet-stream',
  createBytes: (size: number) => Buffer = randomBytes,
): CreatedNotesAttachmentObject {
  const bytes = copyAttachmentBytes(value);
  const objectId = secureRandomBytes(createBytes, OBJECT_ID_BYTES).toString('base64url');
  const assetKeyBytes = secureRandomBytes(createBytes, ASSET_KEY_BYTES);
  const iv = secureRandomBytes(createBytes, IV_BYTES);
  const contentSha256 = sha256(bytes);
  const metadata = parseNotesAttachmentReference({
    objectId,
    assetKey: assetKeyBytes.toString('base64url'),
    ciphertextSha256: '0'.repeat(64),
    contentSha256,
    fileName,
    mimeType: typeof mimeType === 'string' && mimeType ? mimeType : 'application/octet-stream',
    byteLength: bytes.byteLength,
  });
  const cipher = createCipheriv('aes-256-gcm', assetKeyBytes, iv);
  cipher.setAAD(attachmentAad(metadata));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const encrypted: EncryptedNotesAttachmentObject = {
    schemaVersion: SCHEMA_VERSION,
    objectType: OBJECT_TYPE,
    objectId,
    encryption: {
      algorithm: 'AES-256-GCM',
      iv: iv.toString('base64url'),
      authTag: cipher.getAuthTag().toString('base64url'),
    },
    ciphertext: ciphertext.toString('base64'),
  };
  const reference = parseNotesAttachmentReference({
    ...metadata,
    ciphertextSha256: sha256(ciphertext),
  });
  const body = JSON.stringify(encrypted);
  if (Buffer.byteLength(body, 'utf8') > MAX_ENCRYPTED_OBJECT_BYTES) {
    throw new Error('The encrypted Notes attachment object is too large.');
  }
  return { reference, encrypted, body };
}

export function parseEncryptedNotesAttachmentObject(value: unknown): EncryptedNotesAttachmentObject {
  try {
    if (
      !isRecord(value)
      || !hasExactKeys(value, ['schemaVersion', 'objectType', 'objectId', 'encryption', 'ciphertext'])
      || value.schemaVersion !== SCHEMA_VERSION
      || value.objectType !== OBJECT_TYPE
      || !isRecord(value.encryption)
      || !hasExactKeys(value.encryption, ['algorithm', 'iv', 'authTag'])
      || value.encryption.algorithm !== 'AES-256-GCM'
    ) {
      throw new Error('invalid object');
    }
    strictBase64Url(value.objectId, OBJECT_ID_BYTES);
    strictBase64Url(value.encryption.iv, IV_BYTES);
    strictBase64Url(value.encryption.authTag, AUTH_TAG_BYTES);
    strictBase64(value.ciphertext, NOTES_ATTACHMENT_LIMITS.bytes);
    return {
      schemaVersion: SCHEMA_VERSION,
      objectType: OBJECT_TYPE,
      objectId: value.objectId as string,
      encryption: {
        algorithm: 'AES-256-GCM',
        iv: value.encryption.iv as string,
        authTag: value.encryption.authTag as string,
      },
      ciphertext: value.ciphertext as string,
    };
  } catch {
    throw new Error('The encrypted Notes attachment object is invalid.');
  }
}

export function decryptNotesAttachmentObject(referenceValue: unknown, encryptedValue: unknown): Buffer {
  try {
    const reference = parseNotesAttachmentReference(referenceValue);
    const encrypted = parseEncryptedNotesAttachmentObject(encryptedValue);
    if (encrypted.objectId !== reference.objectId) throw new Error('object mismatch');
    const assetKey = strictBase64Url(reference.assetKey, ASSET_KEY_BYTES);
    const iv = strictBase64Url(encrypted.encryption.iv, IV_BYTES);
    const authTag = strictBase64Url(encrypted.encryption.authTag, AUTH_TAG_BYTES);
    const ciphertext = strictBase64(encrypted.ciphertext, NOTES_ATTACHMENT_LIMITS.bytes);
    if (sha256(ciphertext) !== reference.ciphertextSha256) throw new Error('ciphertext mismatch');
    const decipher = createDecipheriv('aes-256-gcm', assetKey, iv);
    decipher.setAAD(attachmentAad(reference));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.byteLength !== reference.byteLength || sha256(plaintext) !== reference.contentSha256) {
      throw new Error('content mismatch');
    }
    return plaintext;
  } catch {
    throw new Error('The encrypted Notes attachment could not be decrypted.');
  }
}

export function buildNotesAttachmentS3ObjectUrl(
  endpoint: unknown,
  bucket: unknown,
  objectIdValue: unknown,
): string {
  const target = normalizeS3EndpointBucket(endpoint, bucket);
  const objectId = typeof objectIdValue === 'string' ? objectIdValue : '';
  try {
    strictBase64Url(objectId, OBJECT_ID_BYTES);
  } catch {
    throw new Error('The Notes attachment object ID is invalid.');
  }
  return `${target.endpoint}/${target.bucket}/${OBJECT_PATH_PREFIX}/${objectId}.json`;
}

function safeS3Error(status: number, body: Buffer, operation: 'upload' | 'download'): Error {
  const code = body.toString('utf8').slice(0, MAX_ERROR_BYTES)
    .match(/<Code>\s*([A-Za-z0-9._-]{1,128})\s*<\/Code>/i)?.[1];
  return new Error(`Notes attachment ${operation} failed (${status}${code ? ` ${code}` : ''}).`);
}

async function readBoundedBody(response: Response, maximumBytes: number, signal: AbortSignal): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('The S3 Notes attachment response is too large.');
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
        throw new Error('The S3 Notes attachment response is too large.');
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  return Buffer.concat(chunks, total);
}

/** Private-bucket immutable attachment store. Credentials never leave this class. */
export class NotesAttachmentS3Store {
  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly createRandomBytes: (size: number) => Buffer;
  private readonly timeoutMs: number;
  private readonly activeRequests = new Map<AbortController, Promise<unknown>>();
  private shuttingDown = false;

  public constructor(private readonly options: NotesAttachmentS3StoreOptions) {
    const target = normalizeS3EndpointBucket(options.endpoint, options.bucket);
    this.endpoint = target.endpoint;
    this.bucket = target.bucket;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.createRandomBytes = options.createRandomBytes ?? randomBytes;
    this.timeoutMs = Number.isInteger(options.timeoutMs) && (options.timeoutMs as number) > 0
      ? options.timeoutMs as number
      : DEFAULT_TIMEOUT_MS;
  }

  public uploadAttachment(
    value: Uint8Array,
    fileName: unknown,
    mimeType?: unknown,
  ): Promise<NoteAttachmentReference> {
    if (this.shuttingDown) return Promise.reject(new Error('Notes attachment storage is shutting down.'));
    const created = createEncryptedNotesAttachmentObject(value, fileName, mimeType, this.createRandomBytes);
    return this.trackRequest(async (signal) => {
      const result = await this.request(
        'PUT',
        buildNotesAttachmentS3ObjectUrl(this.endpoint, this.bucket, created.reference.objectId),
        created.body,
        signal,
      );
      if (result.status === 409 || result.status === 412) {
        throw new Error('Notes attachment upload conflicted. Try again.');
      }
      if (result.status < 200 || result.status >= 300) throw safeS3Error(result.status, result.body, 'upload');
      return parseNotesAttachmentReference(created.reference);
    });
  }

  public downloadAttachment(referenceValue: unknown): Promise<Buffer> {
    if (this.shuttingDown) return Promise.reject(new Error('Notes attachment storage is shutting down.'));
    const reference = parseNotesAttachmentReference(referenceValue);
    return this.trackRequest(async (signal) => {
      const result = await this.request(
        'GET',
        buildNotesAttachmentS3ObjectUrl(this.endpoint, this.bucket, reference.objectId),
        undefined,
        signal,
      );
      if (result.status === 404) throw new Error('The S3 Notes attachment is unavailable.');
      if (result.status < 200 || result.status >= 300) throw safeS3Error(result.status, result.body, 'download');
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.body.toString('utf8'));
      } catch {
        throw new Error('The encrypted Notes attachment object is invalid.');
      }
      return decryptNotesAttachmentObject(reference, parsed);
    });
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const requests = [...this.activeRequests.values()];
    for (const controller of this.activeRequests.keys()) controller.abort();
    await Promise.allSettled(requests);
  }

  private trackRequest<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new Error('Notes attachment storage is shutting down.'));
    const controller = new AbortController();
    const abortFromOwner = (): void => controller.abort();
    if (this.options.signal?.aborted) controller.abort();
    else this.options.signal?.addEventListener('abort', abortFromOwner, { once: true });
    const request = Promise.resolve().then(() => operation(controller.signal)).finally(() => {
      this.options.signal?.removeEventListener('abort', abortFromOwner);
      this.activeRequests.delete(controller);
    });
    this.activeRequests.set(controller, request);
    return request;
  }

  private async request(
    method: 'GET' | 'PUT',
    objectUrl: string,
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<{ status: number; body: Buffer }> {
    const signed = signS3Request({
      method,
      objectUrl,
      region: this.options.region,
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      ...(body !== undefined ? { payload: body } : {}),
      ...(method === 'PUT' ? { ifNoneMatch: '*' as const } : {}),
      now: this.now(),
    });
    const controller = new AbortController();
    let timedOut = false;
    const abortFromOwner = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abortFromOwner, { once: true });
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
        if (timedOut) throw new Error('Notes attachment request timed out.');
        if (controller.signal.aborted) throw new Error('Notes attachment request was cancelled.');
        throw new Error('Notes attachment request failed.');
      }
      const successful = response.status >= 200 && response.status < 300;
      const maximumBytes = method === 'GET' && successful ? MAX_ENCRYPTED_OBJECT_BYTES : MAX_ERROR_BYTES;
      let responseBody: Buffer;
      if (method === 'PUT' && successful) {
        await response.body?.cancel().catch(() => undefined);
        responseBody = Buffer.alloc(0);
      } else {
        responseBody = await readBoundedBody(response, maximumBytes, controller.signal);
      }
      if (timedOut) throw new Error('Notes attachment request timed out.');
      if (controller.signal.aborted) throw new Error('Notes attachment request was cancelled.');
      return { status: response.status, body: responseBody };
    } catch (error) {
      if (timedOut) throw new Error('Notes attachment request timed out.');
      if (controller.signal.aborted) throw new Error('Notes attachment request was cancelled.');
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abortFromOwner);
    }
  }
}
