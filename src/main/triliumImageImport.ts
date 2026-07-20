import { createHash } from 'node:crypto';
import {
  inspectNotesImage,
  NOTES_IMAGE_LIMITS,
  parseNotesImageReference,
} from './notesImageS3';
import type {
  NoteImageReference,
  NoteImageUploadInput,
  NoteImageUploadResult,
} from '../shared/types';

export const TRILIUM_IMPORT_IMAGE_REQUEST_CONCURRENCY = 2;
export const TRILIUM_IMPORT_MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;

const MAX_IMAGE_SOURCE_CHARACTERS = 4_096;
const MAX_IMAGE_TARGETS = 50_000;
const MAX_REMOTE_MIME_CHARACTERS = 255;
const MAX_REMOTE_BLOB_ID_CHARACTERS = 256;
const MAX_REMOTE_TIMESTAMP_CHARACTERS = 64;
const REMOTE_ID_PATTERN = /^[A-Za-z0-9_]{4,32}$/;

export type TriliumImageTargetKind = 'attachment' | 'note' | 'invalid';
export type TriliumImageTargetStatus =
  | 'ready'
  | 'protected'
  | 'unsupported'
  | 'oversized'
  | 'missing'
  | 'invalid';

export type TriliumImagePlaceholderReason = Exclude<TriliumImageTargetStatus, 'ready'>;

export interface TriliumScannedImageSource {
  /** The exact bounded HTML attribute value. It is transient and is never persisted in a Note. */
  source: string;
  sourceKey: string;
  kind: TriliumImageTargetKind;
  remoteId?: string;
  status: 'pending' | 'invalid';
}

export interface TriliumImportImageTarget {
  sourceKey: string;
  kind: TriliumImageTargetKind;
  remoteId?: string;
  blobId: string;
  mimeType: string;
  utcDateModified: string;
  contentLength: number | null;
  status: TriliumImageTargetStatus;
}

export interface TriliumResolvedImageUpload {
  sourceKey: string;
  status: 'uploaded';
  reference: NoteImageReference;
}

export interface TriliumResolvedImagePlaceholder {
  sourceKey: string;
  status: 'placeholder';
  reason: TriliumImagePlaceholderReason;
}

export type TriliumResolvedImageAsset = TriliumResolvedImageUpload | TriliumResolvedImagePlaceholder;

export interface ResolveTriliumImportImagesPlan {
  endpoint: string;
  imageTargets: readonly TriliumImportImageTarget[];
}

export interface TriliumImageResolveProgress {
  total: number;
  processed: number;
  uploaded: number;
  placeholders: number;
  transferredBytes: number;
}

export interface ResolveTriliumImportImagesOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  onProgress?: (progress: TriliumImageResolveProgress) => void;
}

export type TriliumImageUploadCallback = (
  input: NoteImageUploadInput,
  context: { signal: AbortSignal },
) => Promise<NoteImageUploadResult>;

class TriliumImageSafeError extends Error {}
class TriliumImageResponseOversizedError extends Error {}

class TriliumImageHttpError extends Error {
  public constructor(public readonly status: number) {
    super(`Trilium image request failed (${status}).`);
  }
}

function safeError(message: string): TriliumImageSafeError {
  return new TriliumImageSafeError(message);
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function isSupportedImageMime(value: string): boolean {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp';
}

export function normalizeTriliumImageMimeType(value: string): string {
  const normalized = value.split(';', 1)[0].trim().toLowerCase();
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function invalidScannedSource(source: string, identity: string): TriliumScannedImageSource {
  return {
    source,
    sourceKey: `invalid:${sha256Base64Url(identity)}`,
    kind: 'invalid',
    status: 'invalid',
  };
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#(?:x[0-9a-fA-F]+|[0-9]+));/g, (entity) => {
    if (entity === '&amp;') return '&';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    const numeric = entity.slice(2, -1);
    const codePoint = numeric[0]?.toLocaleLowerCase() === 'x'
      ? Number.parseInt(numeric.slice(1), 16)
      : Number.parseInt(numeric, 10);
    if (!Number.isSafeInteger(codePoint)
      || codePoint < 1
      || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(codePoint);
  });
}

function imageTagSources(html: string): Array<{ source: string; identity: string }> {
  const results: Array<{ source: string; identity: string }> = [];
  let cursor = 0;
  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor);
    if (tagStart < 0) break;
    if (html.startsWith('<!--', tagStart)) {
      const commentEnd = html.indexOf('-->', tagStart + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    let nameStart = tagStart + 1;
    if (html[nameStart] === '/') nameStart += 1;
    while (/\s/.test(html[nameStart] ?? '')) nameStart += 1;
    let nameEnd = nameStart;
    while (/[A-Za-z0-9:-]/.test(html[nameEnd] ?? '')) nameEnd += 1;
    const tagName = html.slice(nameStart, nameEnd).toLocaleLowerCase();
    let quote: '"' | "'" | undefined;
    let tagEnd = nameEnd;
    for (; tagEnd < html.length; tagEnd += 1) {
      const character = html[tagEnd];
      if (quote) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
    }
    if (tagEnd >= html.length) {
      if (tagName === 'img' && html[tagStart + 1] !== '/') {
        results.push({ source: '', identity: html.slice(tagStart) });
      }
      break;
    }
    cursor = tagEnd + 1;
    if (tagName !== 'img' || html[tagStart + 1] === '/') continue;

    const tagBody = html.slice(nameEnd, tagEnd);
    const sourceValues: string[] = [];
    let attributeCursor = 0;
    while (attributeCursor < tagBody.length) {
      while (/\s|\//.test(tagBody[attributeCursor] ?? '')) attributeCursor += 1;
      const attributeStart = attributeCursor;
      while (/[^\s=/>]/.test(tagBody[attributeCursor] ?? '')) attributeCursor += 1;
      if (attributeCursor === attributeStart) {
        attributeCursor += 1;
        continue;
      }
      const attributeName = tagBody.slice(attributeStart, attributeCursor).toLocaleLowerCase();
      while (/\s/.test(tagBody[attributeCursor] ?? '')) attributeCursor += 1;
      let attributeValue = '';
      if (tagBody[attributeCursor] === '=') {
        attributeCursor += 1;
        while (/\s/.test(tagBody[attributeCursor] ?? '')) attributeCursor += 1;
        const attributeQuote = tagBody[attributeCursor];
        if (attributeQuote === '"' || attributeQuote === "'") {
          attributeCursor += 1;
          const valueStart = attributeCursor;
          while (attributeCursor < tagBody.length && tagBody[attributeCursor] !== attributeQuote) {
            attributeCursor += 1;
          }
          attributeValue = tagBody.slice(valueStart, attributeCursor);
          if (tagBody[attributeCursor] === attributeQuote) attributeCursor += 1;
        } else {
          const valueStart = attributeCursor;
          while (/[^\s>]/.test(tagBody[attributeCursor] ?? '')) attributeCursor += 1;
          attributeValue = tagBody.slice(valueStart, attributeCursor);
        }
      }
      if (attributeName === 'src') sourceValues.push(decodeHtmlAttribute(attributeValue));
    }
    if (sourceValues.length === 1) {
      results.push({ source: sourceValues[0], identity: sourceValues[0] });
    } else {
      results.push({ source: '', identity: html.slice(tagStart, tagEnd + 1) });
    }
  }
  return results;
}

function hasUnsafePathSegment(pathname: string): boolean {
  for (const rawSegment of pathname.split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return true;
    }
    if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) return true;
    if (/[\u0000-\u001f\u007f]/.test(segment)) return true;
  }
  return false;
}

function rawSourcePath(source: string): string {
  const withoutQuery = source.split(/[?#]/, 1)[0];
  return withoutQuery.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+/, '');
}

/**
 * Extracts only Trilium-owned image routes. External/data/blob sources are
 * represented as inert invalid targets and are never requested.
 */
export function scanTriliumHtmlImages(endpointValue: string, html: string): TriliumScannedImageSource[] {
  if (typeof html !== 'string') throw new Error('The Trilium HTML is invalid.');
  const endpoint = new URL(endpointValue);
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  const routePrefix = `${basePath}/api/`.replace(/^\/\//, '/');
  const sources = imageTagSources(html);
  if (sources.length > MAX_IMAGE_TARGETS) throw new Error('The Trilium HTML contains too many images.');
  return sources.map(({ source, identity }) => {
    if (!source
      || source.length > MAX_IMAGE_SOURCE_CHARACTERS
      || source !== source.trim()
      || /[\u0000-\u0020\u007f\\]/.test(source)
      || source.startsWith('//')
      || source.startsWith('./')
      || source.startsWith('../')
      || hasUnsafePathSegment(rawSourcePath(source))) {
      return invalidScannedSource(source, identity);
    }
    let parsed: URL;
    try {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)) parsed = new URL(source);
      else if (source.startsWith('/')) parsed = new URL(source, endpoint.origin);
      else if (source.startsWith('api/')) parsed = new URL(`${basePath || ''}/${source}`, endpoint.origin);
      else return invalidScannedSource(source, identity);
    } catch {
      return invalidScannedSource(source, identity);
    }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      || parsed.origin !== endpoint.origin
      || parsed.username
      || parsed.password
      || parsed.hash
      || !parsed.pathname.startsWith(routePrefix)
      || hasUnsafePathSegment(parsed.pathname)) {
      return invalidScannedSource(source, identity);
    }
    const route = parsed.pathname.slice(routePrefix.length).split('/');
    if (route[0] === 'attachments'
      && route.length >= 4
      && REMOTE_ID_PATTERN.test(route[1] ?? '')
      && route[2] === 'image'
      && route.slice(3).every(Boolean)) {
      return {
        source,
        sourceKey: `attachment:${route[1]}`,
        kind: 'attachment',
        remoteId: route[1],
        status: 'pending',
      };
    }
    if (route[0] === 'images'
      && route.length >= 2
      && REMOTE_ID_PATTERN.test(route[1] ?? '')
      && route.slice(2).every(Boolean)) {
      return {
        source,
        sourceKey: `note:${route[1]}`,
        kind: 'note',
        remoteId: route[1],
        status: 'pending',
      };
    }
    return invalidScannedSource(source, identity);
  });
}

export function triliumImageTargetFingerprint(target: TriliumImportImageTarget): string {
  return sha256Base64Url(JSON.stringify([
    target.kind,
    target.remoteId ?? '',
    target.blobId,
    target.mimeType,
    target.utcDateModified,
    target.contentLength,
    target.status,
  ]));
}

function normalizeResolveEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    throw new Error('The prepared Trilium image endpoint is invalid.');
  }
  const parsed = new URL(value);
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== '/' && parsed.pathname.endsWith('/'))) {
    throw new Error('The prepared Trilium image endpoint is invalid.');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function validateTriliumImportImageTarget(target: TriliumImportImageTarget): TriliumImportImageTarget {
  if (!target
    || typeof target !== 'object'
    || typeof target.sourceKey !== 'string'
    || target.sourceKey.length > 128
    || !['attachment', 'note', 'invalid'].includes(target.kind)
    || !['ready', 'protected', 'unsupported', 'oversized', 'missing', 'invalid'].includes(target.status)
    || typeof target.blobId !== 'string'
    || target.blobId.length > MAX_REMOTE_BLOB_ID_CHARACTERS
    || typeof target.mimeType !== 'string'
    || target.mimeType.length > MAX_REMOTE_MIME_CHARACTERS
    || typeof target.utcDateModified !== 'string'
    || target.utcDateModified.length > MAX_REMOTE_TIMESTAMP_CHARACTERS
    || (target.contentLength !== null
      && (!Number.isSafeInteger(target.contentLength)
        || target.contentLength < 0
        || target.contentLength > Number.MAX_SAFE_INTEGER))) {
    throw new Error('A prepared Trilium image target is invalid.');
  }
  if (target.kind === 'invalid') {
    if (!/^invalid:[A-Za-z0-9_-]{43}$/.test(target.sourceKey)
      || target.remoteId !== undefined
      || target.status !== 'invalid') {
      throw new Error('A prepared Trilium image target is invalid.');
    }
  } else if (!target.remoteId
    || !REMOTE_ID_PATTERN.test(target.remoteId)
    || target.sourceKey !== `${target.kind}:${target.remoteId}`) {
    throw new Error('A prepared Trilium image target is invalid.');
  }
  if (target.status === 'ready' && (!target.blobId || !isSupportedImageMime(target.mimeType))) {
    throw new Error('A prepared Trilium image target is invalid.');
  }
  return target;
}

class ImageTransferBudget {
  private transferred = 0;

  add(bytes: number): void {
    this.transferred += bytes;
    if (this.transferred > TRILIUM_IMPORT_MAX_TOTAL_IMAGE_BYTES) {
      throw safeError('The Trilium image import exceeds the supported transfer limit.');
    }
  }

  value(): number {
    return this.transferred;
  }
}

async function readImageBody(response: Response, signal: AbortSignal, budget: ImageTransferBudget): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > NOTES_IMAGE_LIMITS.bytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new TriliumImageResponseOversizedError();
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
      budget.add(chunk.byteLength);
      if (total > NOTES_IMAGE_LIMITS.bytes) {
        await reader.cancel().catch(() => undefined);
        throw new TriliumImageResponseOversizedError();
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  return Buffer.concat(chunks, total);
}

async function readMetadataBody(response: Response, signal: AbortSignal, budget: ImageTransferBudget): Promise<Buffer> {
  const maximumBytes = 64 * 1024;
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw safeError('A Trilium image metadata response is too large.');
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
      budget.add(chunk.byteLength);
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw safeError('A Trilium image metadata response is too large.');
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  return Buffer.concat(chunks, total);
}

function parseMetadataRecord(body: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw safeError('A Trilium image metadata response is invalid.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw safeError('A Trilium image metadata response is invalid.');
  }
  return value as Record<string, unknown>;
}

function metadataString(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length <= maximum && !/[\u0000\r\n]/.test(value)
    ? value
    : undefined;
}

function metadataContentLength(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function refreshedTargetFromMetadata(
  expected: TriliumImportImageTarget,
  body: Buffer,
): TriliumImportImageTarget {
  const value = parseMetadataRecord(body);
  const idField = expected.kind === 'attachment' ? 'attachmentId' : 'noteId';
  if (value[idField] !== expected.remoteId) throw safeError('A Trilium image metadata response is invalid.');
  const blobId = metadataString(value.blobId, MAX_REMOTE_BLOB_ID_CHARACTERS);
  const rawMime = metadataString(value.mime, MAX_REMOTE_MIME_CHARACTERS);
  const utcDateModified = metadataString(value.utcDateModified, MAX_REMOTE_TIMESTAMP_CHARACTERS);
  const contentLength = metadataContentLength(value.contentLength);
  if (blobId === undefined || rawMime === undefined || utcDateModified === undefined || contentLength === undefined) {
    throw safeError('A Trilium image metadata response is invalid.');
  }
  const timestamp = new Date(utcDateModified);
  if (!Number.isFinite(timestamp.getTime())) throw safeError('A Trilium image metadata response is invalid.');
  if (value.isProtected !== undefined && typeof value.isProtected !== 'boolean') {
    throw safeError('A Trilium image metadata response is invalid.');
  }
  const noteType = expected.kind === 'note' ? metadataString(value.type, 64) : undefined;
  if (expected.kind === 'note' && (noteType === undefined || typeof value.isProtected !== 'boolean')) {
    throw safeError('A Trilium image metadata response is invalid.');
  }
  const mimeType = normalizeTriliumImageMimeType(rawMime);
  const protectedAsset = value.isProtected === true;
  let status: TriliumImageTargetStatus;
  if (expected.kind === 'note' && noteType?.toLocaleLowerCase() !== 'image') status = 'unsupported';
  else if (protectedAsset) status = 'protected';
  else if (!isSupportedImageMime(mimeType)) status = 'unsupported';
  else if (contentLength !== null && contentLength > NOTES_IMAGE_LIMITS.bytes) status = 'oversized';
  else status = 'ready';
  return {
    sourceKey: expected.sourceKey,
    kind: expected.kind,
    remoteId: expected.remoteId,
    blobId,
    mimeType,
    utcDateModified: timestamp.toISOString(),
    contentLength,
    status,
  };
}

class TriliumImageClient {
  private readonly budget = new ImageTransferBudget();

  public constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch,
    private readonly operationSignal: AbortSignal,
    private readonly requestTimeoutMs: number,
  ) {}

  public transferredBytes(): number {
    return this.budget.value();
  }

  public async metadata(target: TriliumImportImageTarget): Promise<TriliumImportImageTarget> {
    const remoteId = target.remoteId as string;
    const route = target.kind === 'attachment'
      ? `/attachments/${encodeURIComponent(remoteId)}`
      : `/notes/${encodeURIComponent(remoteId)}`;
    const body = await this.request(route, 'application/json', readMetadataBody);
    return refreshedTargetFromMetadata(target, body);
  }

  public async content(target: TriliumImportImageTarget): Promise<Buffer> {
    const remoteId = target.remoteId as string;
    const route = target.kind === 'attachment'
      ? `/attachments/${encodeURIComponent(remoteId)}/content`
      : `/notes/${encodeURIComponent(remoteId)}/content`;
    return this.request(route, 'image/png, image/jpeg, image/jpg, image/webp', readImageBody);
  }

  private async request(
    route: string,
    accept: string,
    readBody: (response: Response, signal: AbortSignal, budget: ImageTransferBudget) => Promise<Buffer>,
  ): Promise<Buffer> {
    const requestController = new AbortController();
    let abortReason: 'owner' | 'timeout' | undefined;
    const abortFromOwner = (): void => {
      if (!abortReason) abortReason = 'owner';
      requestController.abort();
    };
    if (this.operationSignal.aborted) abortFromOwner();
    else this.operationSignal.addEventListener('abort', abortFromOwner, { once: true });
    const timeout = setTimeout(() => {
      if (!abortReason) abortReason = 'timeout';
      requestController.abort();
    }, this.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.endpoint}/etapi${route}`, {
          method: 'GET',
          redirect: 'manual',
          signal: requestController.signal,
          headers: {
            accept,
            authorization: `Bearer ${this.token}`,
          },
        });
      } catch {
        if (abortReason === 'timeout') throw safeError('The Trilium image request timed out.');
        if (abortReason === 'owner' || requestController.signal.aborted) {
          throw safeError('The Trilium image import was cancelled.');
        }
        throw safeError('The Trilium image request failed.');
      }
      if (abortReason === 'timeout') throw safeError('The Trilium image request timed out.');
      if (abortReason === 'owner' || requestController.signal.aborted) {
        throw safeError('The Trilium image import was cancelled.');
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw safeError('The Trilium image endpoint redirected the request.');
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined);
        throw new TriliumImageHttpError(response.status);
      }
      const body = await readBody(response, requestController.signal, this.budget);
      if (abortReason === 'timeout') throw safeError('The Trilium image request timed out.');
      if (abortReason === 'owner' || requestController.signal.aborted) {
        throw safeError('The Trilium image import was cancelled.');
      }
      return body;
    } finally {
      clearTimeout(timeout);
      this.operationSignal.removeEventListener('abort', abortFromOwner);
    }
  }
}

function placeholder(sourceKey: string, reason: TriliumImagePlaceholderReason): TriliumResolvedImagePlaceholder {
  return { sourceKey, status: 'placeholder', reason };
}

function targetPlaceholderReason(target: TriliumImportImageTarget): TriliumImagePlaceholderReason | undefined {
  return target.status === 'ready' ? undefined : target.status;
}

function classifyInspectionFailure(error: unknown, bytes: Uint8Array): TriliumImagePlaceholderReason {
  const message = error instanceof Error ? error.message : '';
  if (/must not exceed|dimensions are not supported|too large/i.test(message)) return 'oversized';
  if (/only PNG, JPEG, and WebP/i.test(message)) {
    const prefix = Buffer.from(bytes).subarray(0, 64).toString('utf8').trimStart().toLocaleLowerCase();
    if (Buffer.from(bytes).subarray(0, 6).toString('ascii') === 'GIF87a'
      || Buffer.from(bytes).subarray(0, 6).toString('ascii') === 'GIF89a'
      || prefix.startsWith('<svg')
      || prefix.startsWith('<?xml')) return 'unsupported';
  }
  return 'invalid';
}

/**
 * Resolves a prepared plan's changed image targets. ETAPI remains read-only;
 * the caller exclusively owns immutable Notes-S3 writes through `upload`.
 */
export async function resolveTriliumImportImages(
  plan: ResolveTriliumImportImagesPlan,
  tokenValue: string,
  upload: TriliumImageUploadCallback,
  options: ResolveTriliumImportImagesOptions = {},
): Promise<TriliumResolvedImageAsset[]> {
  const endpoint = normalizeResolveEndpoint(plan.endpoint);
  if (typeof tokenValue !== 'string'
    || tokenValue.length === 0
    || tokenValue.length > 16 * 1024
    || tokenValue !== tokenValue.trim()
    || /[\u0000-\u0020\u007f]/.test(tokenValue)) {
    throw new Error('The Trilium ETAPI token is invalid.');
  }
  if (typeof upload !== 'function') throw new Error('The Trilium image uploader is invalid.');
  if (!Array.isArray(plan.imageTargets) || plan.imageTargets.length > MAX_IMAGE_TARGETS) {
    throw new Error('The prepared Trilium image targets are invalid.');
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 15_000) {
    throw new Error('The Trilium image request timeout is invalid.');
  }
  const targets = plan.imageTargets.map(validateTriliumImportImageTarget);
  const sourceKeys = new Set<string>();
  for (const target of targets) {
    if (sourceKeys.has(target.sourceKey)) throw new Error('The prepared Trilium image targets are invalid.');
    sourceKeys.add(target.sourceKey);
  }

  const controller = new AbortController();
  const abortFromOwner = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abortFromOwner, { once: true });
  const client = new TriliumImageClient(
    endpoint,
    tokenValue,
    options.fetchImpl ?? fetch,
    controller.signal,
    requestTimeoutMs,
  );
  const results = new Map<string, TriliumResolvedImageAsset>();
  let processed = 0;
  let uploaded = 0;
  let placeholders = 0;
  const report = (): void => options.onProgress?.({
    total: targets.length,
    processed,
    uploaded,
    placeholders,
    transferredBytes: client.transferredBytes(),
  });

  try {
    for (const target of targets) {
      const reason = targetPlaceholderReason(target);
      if (!reason) continue;
      results.set(target.sourceKey, placeholder(target.sourceKey, reason));
      processed += 1;
      placeholders += 1;
      report();
    }

    const pendingMetadataTargets = targets.filter((target) => target.status === 'ready');
    const readyTargets: TriliumImportImageTarget[] = [];
    let nextMetadata = 0;
    let metadataError: unknown;
    const metadataWorker = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        const targetIndex = nextMetadata;
        nextMetadata += 1;
        if (targetIndex >= pendingMetadataTargets.length) return;
        const target = pendingMetadataTargets[targetIndex];
        let refreshed: TriliumImportImageTarget;
        try {
          refreshed = await client.metadata(target);
        } catch (error) {
          if (error instanceof TriliumImageHttpError && error.status === 404) {
            results.set(target.sourceKey, placeholder(target.sourceKey, 'missing'));
            processed += 1;
            placeholders += 1;
            report();
            continue;
          }
          throw error;
        }
        if (refreshed.status !== 'ready') {
          results.set(target.sourceKey, placeholder(target.sourceKey, refreshed.status));
          processed += 1;
          placeholders += 1;
          report();
          continue;
        }
        if (triliumImageTargetFingerprint(refreshed) !== triliumImageTargetFingerprint(target)) {
          throw safeError('A Trilium image changed while the import was being resolved. Retry the import.');
        }
        readyTargets.push(refreshed);
      }
    };
    const metadataWorkers = Array.from(
      { length: Math.min(TRILIUM_IMPORT_IMAGE_REQUEST_CONCURRENCY, pendingMetadataTargets.length) },
      async () => {
        try {
          await metadataWorker();
        } catch (error) {
          if (metadataError === undefined) metadataError = error;
          controller.abort();
        }
      },
    );
    await Promise.all(metadataWorkers);
    if (metadataError !== undefined) throw metadataError;

    const groupedByBlob = new Map<string, TriliumImportImageTarget[]>();
    for (const target of readyTargets) {
      const blobIdentity = `${target.blobId}\0${target.mimeType}\0${target.contentLength ?? ''}`;
      const group = groupedByBlob.get(blobIdentity) ?? [];
      group.push(target);
      groupedByBlob.set(blobIdentity, group);
    }
    const groups = [...groupedByBlob.values()];
    const uploadByDigest = new Map<string, Promise<NoteImageReference>>();
    let nextGroup = 0;
    let firstError: unknown;

    const worker = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        const groupIndex = nextGroup;
        nextGroup += 1;
        if (groupIndex >= groups.length) return;
        const group = groups[groupIndex];
        const representative = group[0];
        let bytes: Buffer;
        try {
          bytes = await client.content(representative);
        } catch (error) {
          let reason: TriliumImagePlaceholderReason | undefined;
          if (error instanceof TriliumImageResponseOversizedError) reason = 'oversized';
          else if (error instanceof TriliumImageHttpError) {
            if (error.status === 400) reason = 'protected';
            else if (error.status === 404) reason = 'missing';
            else if (error.status === 413) reason = 'oversized';
            else if (error.status === 415 || error.status === 422) reason = 'unsupported';
          }
          if (!reason) throw error;
          for (const target of group) {
            results.set(target.sourceKey, placeholder(target.sourceKey, reason));
            processed += 1;
            placeholders += 1;
          }
          report();
          continue;
        }

        let metadata;
        try {
          metadata = inspectNotesImage(bytes, representative.mimeType);
        } catch (error) {
          const reason = classifyInspectionFailure(error, bytes);
          for (const target of group) {
            results.set(target.sourceKey, placeholder(target.sourceKey, reason));
            processed += 1;
            placeholders += 1;
          }
          report();
          continue;
        }
        if (representative.contentLength !== null && representative.contentLength !== bytes.byteLength) {
          throw safeError('A Trilium image changed while the import was being downloaded. Retry the import.');
        }

        const digest = sha256Hex(bytes);
        let uploadPromise = uploadByDigest.get(digest);
        if (!uploadPromise) {
          uploadPromise = (async () => {
            let result: NoteImageUploadResult;
            try {
              result = await upload({ bytes: new Uint8Array(bytes), mimeType: metadata.mimeType }, {
                signal: controller.signal,
              });
            } catch {
              throw safeError('Unable to upload a Trilium image to Notes S3.');
            }
            if (result.status === 'not-configured') {
              throw safeError('Configure Notes S3 before importing Trilium images.');
            }
            let reference: NoteImageReference;
            try {
              reference = parseNotesImageReference(result.reference);
            } catch {
              throw safeError('The Notes S3 image upload returned an invalid reference.');
            }
            if (reference.contentSha256 !== digest
              || reference.mimeType !== metadata.mimeType
              || reference.byteLength !== metadata.byteLength
              || reference.width !== metadata.width
              || reference.height !== metadata.height) {
              throw safeError('The Notes S3 image upload returned a mismatched reference.');
            }
            return reference;
          })();
          uploadByDigest.set(digest, uploadPromise);
        }
        const reference = await uploadPromise;
        for (const target of group) {
          results.set(target.sourceKey, { sourceKey: target.sourceKey, status: 'uploaded', reference });
          processed += 1;
          uploaded += 1;
        }
        report();
      }
    };

    const workers = Array.from(
      { length: Math.min(TRILIUM_IMPORT_IMAGE_REQUEST_CONCURRENCY, groups.length) },
      async () => {
        try {
          await worker();
        } catch (error) {
          if (firstError === undefined) firstError = error;
          controller.abort();
        }
      },
    );
    await Promise.all(workers);
    if (firstError !== undefined) throw firstError;
    if (options.signal?.aborted) throw safeError('The Trilium image import was cancelled.');
    return targets.map((target) => {
      const result = results.get(target.sourceKey);
      if (!result) throw safeError('A Trilium image could not be resolved.');
      return result;
    });
  } catch (error) {
    controller.abort();
    if (options.signal?.aborted) throw new Error('The Trilium image import was cancelled.');
    if (error instanceof TriliumImageSafeError || error instanceof TriliumImageHttpError) {
      throw new Error(error.message);
    }
    throw new Error('The Trilium image import failed.');
  } finally {
    controller.abort();
    options.signal?.removeEventListener('abort', abortFromOwner);
  }
}
