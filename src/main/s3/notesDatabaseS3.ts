import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { normalizeS3EndpointBucket, signS3Request } from './s3Request';
import { getS3SyncEncryptionKeyId, normalizeS3SyncEncryptionKey } from './s3SyncV4';

export const NOTES_DATABASE_OBJECT_KEY = 'service-manager-sync-v5/notes/database.sqlite3.enc';

export type NotesDatabaseS3Options = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  syncEncryptionKey: string;
  previousSyncEncryptionKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const MAX_DATABASE_BYTES = 128 * 1024 * 1024;
const MAGIC = Buffer.from('SMNDBS3\0', 'ascii');
const VERSION = 5;
// Big endian: magic[8], version[u16], headerLength[u16], plaintextLength[u32],
// keyId[32], salt[32], iv[12], tag[16], ciphertext[plaintextLength].
// Bytes 0..91 are GCM AAD; the tag at 92..107 authenticates AAD and ciphertext.
const AAD_BYTES = 92;
const HEADER_BYTES = 108;
const MAX_OBJECT_BYTES = MAX_DATABASE_BYTES + HEADER_BYTES;
const HKDF_SALT_DOMAIN = Buffer.from('service-manager-sync-v5/notes/database/salt\0');
const HKDF_INFO = Buffer.from(`${NOTES_DATABASE_OBJECT_KEY}\0AES-256-GCM`);

class DatabaseS3Error extends Error {}

function invalidEnvelope(): never {
  throw new DatabaseS3Error('The encrypted Notes database format or size is invalid.');
}

function headerLength(header: Buffer): number {
  if (header.length < HEADER_BYTES || !header.subarray(0, 8).equals(MAGIC)
    || header.readUInt16BE(8) !== VERSION || header.readUInt16BE(10) !== HEADER_BYTES) {
    return invalidEnvelope();
  }
  const length = header.readUInt32BE(12);
  if (length > MAX_DATABASE_BYTES) return invalidEnvelope();
  return HEADER_BYTES + length;
}

function deriveKey(key: string, salt: Buffer): Buffer {
  const normalized = normalizeS3SyncEncryptionKey(key);
  // Match the existing identity rules for generated base64url keys and passphrases.
  const decoded = Buffer.from(normalized, 'base64url');
  const material = decoded.length === 32 && decoded.toString('base64url') === normalized
    ? decoded : Buffer.from(normalized, 'utf8');
  return Buffer.from(hkdfSync('sha256', material, Buffer.concat([HKDF_SALT_DOMAIN, salt]), HKDF_INFO, 32));
}

/** Returns the fixed binary envelope. SQLite content validation belongs to the caller. */
export function encryptNotesDatabase(
  bytes: Buffer,
  key: string,
  createBytes: (size: number) => Buffer = randomBytes,
): Buffer<ArrayBuffer> {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_DATABASE_BYTES) return invalidEnvelope();
  const normalized = normalizeS3SyncEncryptionKey(key);
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header);
  header.writeUInt16BE(VERSION, 8);
  header.writeUInt16BE(HEADER_BYTES, 10);
  header.writeUInt32BE(bytes.length, 12);
  Buffer.from(getS3SyncEncryptionKeyId(normalized), 'hex').copy(header, 16);
  for (const [offset, size] of [[48, 32], [80, 12]]) {
    const value = createBytes(size);
    if (!Buffer.isBuffer(value) || value.length !== size) {
      throw new DatabaseS3Error('Secure Notes database encryption randomness is unavailable.');
    }
    value.copy(header, offset);
  }
  const cipher = createCipheriv('aes-256-gcm', deriveKey(normalized, header.subarray(48, 80)), header.subarray(80, 92));
  cipher.setAAD(header.subarray(0, AAD_BYTES));
  const ciphertext = cipher.update(bytes);
  const final = cipher.final();
  cipher.getAuthTag().copy(header, AAD_BYTES);
  return Buffer.concat([header, ciphertext, final]);
}

/** Returns plaintext bytes and the identity of the current/previous key that decrypted them. */
export function decryptNotesDatabase(
  envelope: Buffer,
  key: string,
  previousKey?: string,
): { bytes: Buffer; encryptionKeyId: string } {
  if (!Buffer.isBuffer(envelope) || envelope.length > MAX_OBJECT_BYTES
    || headerLength(envelope) !== envelope.length) return invalidEnvelope();
  const keys = [normalizeS3SyncEncryptionKey(key)];
  if (previousKey !== undefined) keys.push(normalizeS3SyncEncryptionKey(previousKey));
  const encryptionKeyId = envelope.subarray(16, 48).toString('hex');
  const matchingKey = keys.find((candidate) => getS3SyncEncryptionKeyId(candidate) === encryptionKeyId);
  if (!matchingKey) throw new DatabaseS3Error('The Notes database encryption key does not match.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(matchingKey, envelope.subarray(48, 80)), envelope.subarray(80, 92));
    decipher.setAAD(envelope.subarray(0, AAD_BYTES));
    decipher.setAuthTag(envelope.subarray(AAD_BYTES, HEADER_BYTES));
    const bytes = decipher.update(envelope.subarray(HEADER_BYTES));
    try {
      decipher.final();
    } catch {
      bytes.fill(0);
      throw new DatabaseS3Error('The Notes database could not be decrypted or authenticated.');
    }
    return { bytes, encryptionKeyId };
  } catch {
    throw new DatabaseS3Error('The Notes database could not be decrypted or authenticated.');
  }
}

function etag(value: string | null | undefined, required: boolean): string | undefined {
  if (value === null || value === undefined) {
    if (required) throw new DatabaseS3Error('The S3 Notes database response is missing an ETag.');
    return undefined;
  }
  // Require one strong entity tag, preventing wildcard/list conditions and header injection.
  if (value.length > 512 || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value)) {
    throw new DatabaseS3Error('The S3 Notes database ETag is invalid.');
  }
  return value;
}

// Never await cancellation: a custom/failed transport can leave cancel() pending forever.
function discardBody(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* No response details. */ }
}

class RequestScope {
  readonly controller = new AbortController();
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private timedOut = false;
  private readonly abort = (): void => { this.controller.abort(); };

  constructor(timeoutMs: number, private readonly owner?: AbortSignal) {
    this.deadline = performance.now() + timeoutMs;
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, timeoutMs);
    if (owner?.aborted) this.abort();
    else owner?.addEventListener('abort', this.abort, { once: true });
  }

  check(): void {
    if (this.timedOut || performance.now() >= this.deadline) {
      this.timedOut = true;
      this.controller.abort();
      throw new DatabaseS3Error('The S3 Notes database request timed out.');
    }
    if (this.controller.signal.aborted) throw new DatabaseS3Error('The S3 Notes database request was cancelled.');
  }

  async wait<T>(promise: Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    let onAbort = (): void => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new DatabaseS3Error('The S3 Notes database request was cancelled.'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      const result = await Promise.race([promise, aborted]);
      this.check();
      return result;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  close(): void {
    clearTimeout(this.timer);
    this.owner?.removeEventListener('abort', this.abort);
    this.controller.abort();
  }
}

async function readEnvelope(response: Response, scope: RequestScope): Promise<Buffer> {
  const rawLength = response.headers.get('content-length');
  const contentLength = rawLength === null ? undefined : Number(rawLength);
  if (rawLength !== null && (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(contentLength)
    || contentLength! < HEADER_BYTES || contentLength! > MAX_OBJECT_BYTES)) return invalidEnvelope();
  if (!response.body) return invalidEnvelope();
  const reader = response.body.getReader();
  let envelope = Buffer.alloc(HEADER_BYTES);
  let length = 0;
  let expectedLength: number | undefined;
  try {
    while (true) {
      scope.check();
      const chunk = await scope.wait(reader.read());
      if (chunk.done) break;
      const value = chunk.value;
      if (!(value instanceof Uint8Array) || length + value.byteLength > (expectedLength ?? MAX_OBJECT_BYTES)) {
        return invalidEnvelope();
      }
      let offset = 0;
      if (length < HEADER_BYTES) {
        offset = Math.min(HEADER_BYTES - length, value.byteLength);
        envelope.set(value.subarray(0, offset), length);
        length += offset;
        if (length === HEADER_BYTES) {
          expectedLength = headerLength(envelope);
          if ((contentLength !== undefined && contentLength !== expectedLength)
            || length + value.byteLength - offset > expectedLength) return invalidEnvelope();
          const full = Buffer.allocUnsafe(expectedLength);
          envelope.copy(full);
          envelope = full;
        }
      }
      if (offset < value.byteLength) {
        envelope.set(value.subarray(offset), length);
        length += value.byteLength - offset;
      }
    }
    if (expectedLength === undefined || length !== expectedLength) return invalidEnvelope();
    return envelope;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class NotesDatabaseS3Store {
  private readonly options: NotesDatabaseS3Options;
  private readonly objectUrl: string;
  private readonly timeoutMs: number;

  constructor(options: NotesDatabaseS3Options) {
    const target = normalizeS3EndpointBucket(options.endpoint, options.bucket);
    this.options = {
      ...options,
      ...target,
      syncEncryptionKey: normalizeS3SyncEncryptionKey(options.syncEncryptionKey),
      ...(options.previousSyncEncryptionKey !== undefined
        ? { previousSyncEncryptionKey: normalizeS3SyncEncryptionKey(options.previousSyncEncryptionKey) } : {}),
    };
    this.objectUrl = `${target.endpoint}/${target.bucket}/${NOTES_DATABASE_OBJECT_KEY}`;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new DatabaseS3Error('The S3 request timeout is invalid.');
    }
    if (typeof options.region !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(options.region.trim())) {
      throw new DatabaseS3Error('A valid S3 region is required.');
    }
    if (typeof options.accessKeyId !== 'string' || !options.accessKeyId.trim()
      || /[\s\x00-\x1f\x7f]/.test(options.accessKeyId)
      || typeof options.secretAccessKey !== 'string' || !options.secretAccessKey.trim()) {
      throw new DatabaseS3Error('S3 credentials are unavailable.');
    }
  }

  async get(knownEtag?: string): Promise<{ status: 'missing' } | { status: 'not-modified' }
    | { status: 'found'; bytes: Buffer; etag: string; encryptionKeyId: string }> {
    return this.run(async (scope) => {
      const condition = knownEtag === undefined ? undefined : etag(knownEtag, true);
      const response = await this.request('GET', scope, undefined, condition);
      try {
        if (response.status === 304 && condition !== undefined) return { status: 'not-modified' };
        if (response.status === 404) return { status: 'missing' };
        if (response.status !== 200) throw this.statusError(response.status);
        const identity = etag(response.headers.get('etag'), true)!;
        const envelope = await readEnvelope(response, scope);
        scope.check();
        const decrypted = decryptNotesDatabase(envelope, this.options.syncEncryptionKey, this.options.previousSyncEncryptionKey);
        return { status: 'found', ...decrypted, etag: identity };
      } finally { discardBody(response); }
    });
  }

  /** byteLength is the uploaded encrypted object's size, including its 108-byte header. */
  async put(bytes: Buffer, expectedEtag?: string): Promise<{ status: 'conflict' } | { status: 'written'; etag?: string; byteLength: number }> {
    return this.run(async (scope) => {
      const condition = expectedEtag === undefined ? undefined : etag(expectedEtag, true);
      const envelope = encryptNotesDatabase(bytes, this.options.syncEncryptionKey);
      scope.check();
      const response = await this.request('PUT', scope, envelope, condition);
      try {
        if (response.status === 409 || response.status === 412) return { status: 'conflict' };
        if (response.status < 200 || response.status >= 300) throw this.statusError(response.status);
        const identity = etag(response.headers.get('etag'), false);
        return { status: 'written', ...(identity !== undefined ? { etag: identity } : {}), byteLength: envelope.length };
      } finally { discardBody(response); }
    });
  }

  private statusError(status: number): Error {
    return new DatabaseS3Error(`The S3 Notes database request failed (HTTP ${status}).`);
  }

  private async request(method: 'GET' | 'PUT', scope: RequestScope, payload?: Buffer<ArrayBuffer>, conditionEtag?: string): Promise<Response> {
    scope.check();
    const signed = signS3Request({
      method, objectUrl: this.objectUrl,
      region: this.options.region, accessKeyId: this.options.accessKeyId, secretAccessKey: this.options.secretAccessKey,
      now: this.options.now?.() ?? new Date(), payload, contentType: 'application/octet-stream',
      ...(method === 'PUT'
        ? (conditionEtag === undefined ? { ifNoneMatch: '*' } : { ifMatch: conditionEtag })
        : (conditionEtag === undefined ? {} : { ifNoneMatch: conditionEtag })),
    });
    scope.check();
    let received: Response | undefined;
    const pending = (this.options.fetchImpl ?? fetch)(signed.url, {
      method, headers: signed.headers, ...(payload !== undefined ? { body: payload } : {}),
      signal: scope.controller.signal, redirect: 'manual',
    }).then((response) => {
      received = response;
      if (scope.controller.signal.aborted) discardBody(response);
      return response;
    });
    try {
      return await scope.wait(pending);
    } catch (error) {
      // Cancellation can arrive between fetch resolving and handing off the response.
      if (received) discardBody(received);
      throw error;
    }
  }

  private async run<T>(operation: (scope: RequestScope) => Promise<T>): Promise<T> {
    const scope = new RequestScope(this.timeoutMs, this.options.signal);
    try {
      scope.check();
      const result = await operation(scope);
      scope.check();
      return result;
    } catch (error) {
      scope.check();
      if (error instanceof DatabaseS3Error) throw error;
      throw new DatabaseS3Error('The S3 Notes database request failed.');
    } finally { scope.close(); }
  }
}
