import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type {
  NoteImageMimeType,
  NoteImageReference,
} from '../shared/types';
import {
  parseNoteImageReference as parseCanonicalNoteImageReference,
  RICH_TEXT_LIMITS,
} from '../shared/noteRichText';
import {
  normalizeS3EndpointBucket,
  type S3EndpointBucket,
} from './s3SyncV2';
import { signS3V3Request } from './s3SyncV3';

const NOTES_IMAGE_SCHEMA_VERSION = 1 as const;
const NOTES_IMAGE_OBJECT_TYPE = 'notes-image' as const;
const NOTES_IMAGE_PATH_PREFIX = 'service-manager/v3/images';
const NOTES_IMAGE_AAD_PREFIX = 'service-manager-notes-image-v1\0';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_ENCRYPTED_OBJECT_BYTES = 14 * 1024 * 1024;
const OBJECT_ID_BYTES = 24;
const ASSET_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export const NOTES_IMAGE_LIMITS = Object.freeze({
  bytes: RICH_TEXT_LIMITS.imageBytes,
  dimension: RICH_TEXT_LIMITS.imageDimension,
  pixels: RICH_TEXT_LIMITS.imagePixels,
  altCharacters: RICH_TEXT_LIMITS.imageAltCharacters,
});

export type NotesImageMimeType = NoteImageMimeType;

export interface NotesImageMetadata {
  mimeType: NotesImageMimeType;
  byteLength: number;
  width: number;
  height: number;
}

export type NotesImageReference = NoteImageReference;

export interface EncryptedNotesImageObject {
  schemaVersion: typeof NOTES_IMAGE_SCHEMA_VERSION;
  objectType: typeof NOTES_IMAGE_OBJECT_TYPE;
  objectId: string;
  encryption: {
    algorithm: 'AES-256-GCM';
    iv: string;
    authTag: string;
  };
  ciphertext: string;
}

export interface CreatedNotesImageObject {
  reference: NotesImageReference;
  encrypted: EncryptedNotesImageObject;
  body: string;
}

export interface NotesImageS3StoreOptions extends S3EndpointBucket {
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

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
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

function validateDimensions(width: number, height: number): void {
  if (
    width < 1
    || height < 1
    || width > NOTES_IMAGE_LIMITS.dimension
    || height > NOTES_IMAGE_LIMITS.dimension
    || width * height > NOTES_IMAGE_LIMITS.pixels
  ) {
    throw new Error('Notes image dimensions are not supported.');
  }
}

function copyImageBytes(value: unknown): Buffer {
  if (!(value instanceof Uint8Array)) {
    throw new Error('Notes image data is invalid.');
  }
  return Buffer.from(value);
}

function pngDimensions(value: Buffer): { width: number; height: number } | undefined {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (value.byteLength < 24 || !value.subarray(0, 8).equals(signature)) return undefined;
  if (value.readUInt32BE(8) !== 13 || value.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('The PNG image header is invalid.');
  }
  return { width: value.readUInt32BE(16), height: value.readUInt32BE(20) };
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(value: Buffer): { width: number; height: number } | undefined {
  if (value.byteLength < 4 || value[0] !== 0xff || value[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset < value.byteLength) {
    if (value[offset] !== 0xff) throw new Error('The JPEG image header is invalid.');
    while (offset < value.byteLength && value[offset] === 0xff) offset += 1;
    if (offset >= value.byteLength) break;
    const marker = value[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > value.byteLength) throw new Error('The JPEG image header is invalid.');
    const segmentLength = value.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > value.byteLength) {
      throw new Error('The JPEG image header is invalid.');
    }
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 8) throw new Error('The JPEG image header is invalid.');
      return {
        width: value.readUInt16BE(offset + 5),
        height: value.readUInt16BE(offset + 3),
      };
    }
    offset += segmentLength;
  }
  throw new Error('The JPEG image dimensions are unavailable.');
}

function readUInt24LE(value: Buffer, offset: number): number {
  return value[offset] | (value[offset + 1] << 8) | (value[offset + 2] << 16);
}

function webpDimensions(value: Buffer): { width: number; height: number } | undefined {
  if (
    value.byteLength < 20
    || value.toString('ascii', 0, 4) !== 'RIFF'
    || value.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return undefined;
  }
  if (value.readUInt32LE(4) + 8 !== value.byteLength) {
    throw new Error('The WebP image header is invalid.');
  }
  let offset = 12;
  while (offset + 8 <= value.byteLength) {
    const chunkType = value.toString('ascii', offset, offset + 4);
    const chunkLength = value.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkLength;
    if (dataEnd > value.byteLength) throw new Error('The WebP image header is invalid.');

    if (chunkType === 'VP8X') {
      if (chunkLength !== 10) throw new Error('The WebP image header is invalid.');
      return {
        width: readUInt24LE(value, dataOffset + 4) + 1,
        height: readUInt24LE(value, dataOffset + 7) + 1,
      };
    }
    if (chunkType === 'VP8L') {
      if (chunkLength < 5 || value[dataOffset] !== 0x2f) {
        throw new Error('The WebP image header is invalid.');
      }
      const bits = value.readUInt32LE(dataOffset + 1);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    if (chunkType === 'VP8 ') {
      if (
        chunkLength < 10
        || (value[dataOffset] & 0x01) !== 0
        || value[dataOffset + 3] !== 0x9d
        || value[dataOffset + 4] !== 0x01
        || value[dataOffset + 5] !== 0x2a
      ) {
        throw new Error('The WebP image header is invalid.');
      }
      return {
        width: value.readUInt16LE(dataOffset + 6) & 0x3fff,
        height: value.readUInt16LE(dataOffset + 8) & 0x3fff,
      };
    }
    offset = dataEnd + (chunkLength % 2);
  }
  throw new Error('The WebP image dimensions are unavailable.');
}

/** Validates an image from its bytes rather than trusting renderer metadata. */
export function inspectNotesImage(value: Uint8Array, declaredMimeType?: unknown): NotesImageMetadata {
  const bytes = copyImageBytes(value);
  if (bytes.byteLength === 0 || bytes.byteLength > NOTES_IMAGE_LIMITS.bytes) {
    throw new Error(`A Notes image must not exceed ${NOTES_IMAGE_LIMITS.bytes / (1024 * 1024)} MiB.`);
  }

  let mimeType: NotesImageMimeType;
  let dimensions: { width: number; height: number } | undefined;
  if ((dimensions = pngDimensions(bytes))) mimeType = 'image/png';
  else if ((dimensions = jpegDimensions(bytes))) mimeType = 'image/jpeg';
  else if ((dimensions = webpDimensions(bytes))) mimeType = 'image/webp';
  else throw new Error('Only PNG, JPEG, and WebP Notes images are supported.');

  if (declaredMimeType !== undefined && declaredMimeType !== mimeType) {
    throw new Error('The Notes image type does not match its content.');
  }
  validateDimensions(dimensions.width, dimensions.height);
  return {
    mimeType,
    byteLength: bytes.byteLength,
    width: dimensions.width,
    height: dimensions.height,
  };
}

export function parseNotesImageReference(value: unknown): NotesImageReference {
  try {
    return parseCanonicalNoteImageReference(value);
  } catch {
    throw new Error('The Notes image reference is invalid.');
  }
}

export function parseEncryptedNotesImageObject(value: unknown): EncryptedNotesImageObject {
  try {
    if (
      !isRecord(value)
      || !hasExactKeys(value, ['schemaVersion', 'objectType', 'objectId', 'encryption', 'ciphertext'])
      || value.schemaVersion !== NOTES_IMAGE_SCHEMA_VERSION
      || value.objectType !== NOTES_IMAGE_OBJECT_TYPE
      || !isRecord(value.encryption)
      || !hasExactKeys(value.encryption, ['algorithm', 'iv', 'authTag'])
      || value.encryption.algorithm !== 'AES-256-GCM'
    ) {
      throw new Error('invalid object');
    }
    strictBase64Url(value.objectId, OBJECT_ID_BYTES);
    strictBase64Url(value.encryption.iv, IV_BYTES);
    strictBase64Url(value.encryption.authTag, AUTH_TAG_BYTES);
    strictBase64(value.ciphertext, NOTES_IMAGE_LIMITS.bytes);
    return {
      schemaVersion: NOTES_IMAGE_SCHEMA_VERSION,
      objectType: NOTES_IMAGE_OBJECT_TYPE,
      objectId: value.objectId as string,
      encryption: {
        algorithm: 'AES-256-GCM',
        iv: value.encryption.iv as string,
        authTag: value.encryption.authTag as string,
      },
      ciphertext: value.ciphertext as string,
    };
  } catch {
    throw new Error('The encrypted Notes image object is invalid.');
  }
}

function secureRandomBytes(createBytes: (size: number) => Buffer, size: number): Buffer {
  const value = createBytes(size);
  if (!Buffer.isBuffer(value) || value.byteLength !== size) {
    throw new Error('Secure Notes image randomness is unavailable.');
  }
  return Buffer.from(value);
}

/** Creates an immutable encrypted object and the exact reference stored by Tiptap. */
export function createEncryptedNotesImageObject(
  value: Uint8Array,
  declaredMimeType?: unknown,
  altValue?: unknown,
  createBytes: (size: number) => Buffer = randomBytes,
): CreatedNotesImageObject {
  const bytes = copyImageBytes(value);
  const metadata = inspectNotesImage(bytes, declaredMimeType);
  const objectId = secureRandomBytes(createBytes, OBJECT_ID_BYTES).toString('base64url');
  const assetKeyBytes = secureRandomBytes(createBytes, ASSET_KEY_BYTES);
  const assetKey = assetKeyBytes.toString('base64url');
  const iv = secureRandomBytes(createBytes, IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', assetKeyBytes, iv);
  cipher.setAAD(Buffer.from(`${NOTES_IMAGE_AAD_PREFIX}${objectId}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const encrypted: EncryptedNotesImageObject = {
    schemaVersion: NOTES_IMAGE_SCHEMA_VERSION,
    objectType: NOTES_IMAGE_OBJECT_TYPE,
    objectId,
    encryption: {
      algorithm: 'AES-256-GCM',
      iv: iv.toString('base64url'),
      authTag: cipher.getAuthTag().toString('base64url'),
    },
    ciphertext: ciphertext.toString('base64'),
  };
  const body = JSON.stringify(encrypted);
  if (Buffer.byteLength(body, 'utf8') > MAX_ENCRYPTED_OBJECT_BYTES) {
    throw new Error('The encrypted Notes image object is too large.');
  }
  const reference = parseNotesImageReference({
    objectId,
    assetKey,
    ciphertextSha256: sha256(ciphertext),
    contentSha256: sha256(bytes),
    ...metadata,
    ...(altValue !== undefined ? { alt: altValue } : {}),
  });
  return {
    reference,
    encrypted,
    body,
  };
}

export function decryptNotesImageObject(referenceValue: unknown, encryptedValue: unknown): Buffer {
  try {
    const reference = parseNotesImageReference(referenceValue);
    const encrypted = parseEncryptedNotesImageObject(encryptedValue);
    if (encrypted.objectId !== reference.objectId) throw new Error('object mismatch');
    const assetKey = strictBase64Url(reference.assetKey, ASSET_KEY_BYTES);
    const iv = strictBase64Url(encrypted.encryption.iv, IV_BYTES);
    const authTag = strictBase64Url(encrypted.encryption.authTag, AUTH_TAG_BYTES);
    const ciphertext = strictBase64(encrypted.ciphertext, NOTES_IMAGE_LIMITS.bytes);
    if (sha256(ciphertext) !== reference.ciphertextSha256) throw new Error('ciphertext mismatch');
    const decipher = createDecipheriv('aes-256-gcm', assetKey, iv);
    decipher.setAAD(Buffer.from(`${NOTES_IMAGE_AAD_PREFIX}${reference.objectId}`, 'utf8'));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (sha256(plaintext) !== reference.contentSha256) throw new Error('content mismatch');
    const metadata = inspectNotesImage(plaintext, reference.mimeType);
    if (
      metadata.byteLength !== reference.byteLength
      || metadata.width !== reference.width
      || metadata.height !== reference.height
    ) {
      throw new Error('metadata mismatch');
    }
    return plaintext;
  } catch {
    throw new Error('The encrypted Notes image could not be decrypted.');
  }
}

export function buildNotesImageS3ObjectUrl(endpoint: unknown, bucket: unknown, objectIdValue: unknown): string {
  const target = normalizeS3EndpointBucket(endpoint, bucket);
  const objectId = typeof objectIdValue === 'string' ? objectIdValue : '';
  try {
    strictBase64Url(objectId, OBJECT_ID_BYTES);
  } catch {
    throw new Error('The Notes image object ID is invalid.');
  }
  return `${target.endpoint}/${target.bucket}/${NOTES_IMAGE_PATH_PREFIX}/${objectId}.json`;
}

function safeS3Error(status: number, body: Buffer, operation: 'upload' | 'download'): Error {
  const code = body.toString('utf8').slice(0, MAX_ERROR_BYTES)
    .match(/<Code>\s*([A-Za-z0-9._-]{1,128})\s*<\/Code>/i)?.[1];
  return new Error(`Notes image ${operation} failed (${status}${code ? ` ${code}` : ''}).`);
}

async function readBoundedBody(response: Response, maximumBytes: number, signal: AbortSignal): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('The S3 Notes image response is too large.');
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
        throw new Error('The S3 Notes image response is too large.');
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  return Buffer.concat(chunks, total);
}

/** Private-bucket immutable image store. Credentials never leave this class. */
export class NotesImageS3Store {
  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly createRandomBytes: (size: number) => Buffer;
  private readonly timeoutMs: number;
  private readonly activeRequests = new Map<AbortController, Promise<unknown>>();
  private shuttingDown = false;

  public constructor(private readonly options: NotesImageS3StoreOptions) {
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

  public uploadImage(value: Uint8Array, declaredMimeType?: unknown, alt?: unknown): Promise<NotesImageReference> {
    if (this.shuttingDown) return Promise.reject(new Error('Notes image storage is shutting down.'));
    const created = createEncryptedNotesImageObject(value, declaredMimeType, alt, this.createRandomBytes);
    return this.trackRequest(async (signal) => {
      const result = await this.request(
        'PUT',
        buildNotesImageS3ObjectUrl(this.endpoint, this.bucket, created.reference.objectId),
        created.body,
        signal,
      );
      if (result.status === 409 || result.status === 412) {
        throw new Error('Notes image upload conflicted. Try again.');
      }
      if (result.status < 200 || result.status >= 300) throw safeS3Error(result.status, result.body, 'upload');
      return parseNotesImageReference(created.reference);
    });
  }

  public downloadImage(referenceValue: unknown): Promise<Buffer> {
    if (this.shuttingDown) return Promise.reject(new Error('Notes image storage is shutting down.'));
    const reference = parseNotesImageReference(referenceValue);
    return this.trackRequest(async (signal) => {
      const result = await this.request(
        'GET',
        buildNotesImageS3ObjectUrl(this.endpoint, this.bucket, reference.objectId),
        undefined,
        signal,
      );
      if (result.status === 404) throw new Error('The S3 Notes image is unavailable.');
      if (result.status < 200 || result.status >= 300) throw safeS3Error(result.status, result.body, 'download');
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.body.toString('utf8'));
      } catch {
        throw new Error('The encrypted Notes image object is invalid.');
      }
      return decryptNotesImageObject(reference, parsed);
    });
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const requests = [...this.activeRequests.values()];
    for (const controller of this.activeRequests.keys()) controller.abort();
    await Promise.allSettled(requests);
  }

  private trackRequest<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new Error('Notes image storage is shutting down.'));
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
    const signed = signS3V3Request({
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
        if (timedOut) throw new Error('Notes image request timed out.');
        if (controller.signal.aborted) throw new Error('Notes image request was cancelled.');
        throw new Error('Notes image request failed.');
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
      if (timedOut) throw new Error('Notes image request timed out.');
      if (controller.signal.aborted) throw new Error('Notes image request was cancelled.');
      return { status: response.status, body: responseBody };
    } catch (error) {
      if (timedOut) throw new Error('Notes image request timed out.');
      if (controller.signal.aborted) throw new Error('Notes image request was cancelled.');
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abortFromOwner);
    }
  }
}
