import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { NOTE_LIMITS, NOTES_SCHEMA_VERSION, type NotesSnapshot, type NoteTombstone } from './notesStore';
import {
  NOTES_TREE_MAX_DEPTH,
  NOTES_TREE_MAX_NODES,
  NOTES_TREE_SCHEMA_VERSION,
  type NotesTreeNode,
  type NotesTreeSnapshot,
} from './notesTreeStore';
import { normalizeRichTextContent } from '../shared/noteRichText';
import type { Note, NoteLanguage } from '../shared/types';
import {
  NOTES_IMAGE_LIMITS,
} from './notesImageS3';
import {
  normalizeTriliumImageMimeType,
  resolveTriliumImportImages,
  scanTriliumHtmlImages,
  TRILIUM_IMPORT_MAX_TOTAL_IMAGE_BYTES,
  triliumImageTargetFingerprint,
  validateTriliumImportImageTarget,
  type ResolveTriliumImportImagesOptions,
  type TriliumImageUploadCallback,
  type TriliumImportImageTarget,
  type TriliumResolvedImageAsset,
  type TriliumScannedImageSource,
} from './triliumImageImport';

export {
  resolveTriliumImportImages,
  scanTriliumHtmlImages,
  TRILIUM_IMPORT_MAX_TOTAL_IMAGE_BYTES,
  triliumImageTargetFingerprint,
  validateTriliumImportImageTarget,
};
export type {
  ResolveTriliumImportImagesOptions,
  TriliumImageUploadCallback,
  TriliumImportImageTarget,
  TriliumResolvedImageAsset,
  TriliumScannedImageSource,
};

export const TRILIUM_IMPORTER_VERSION = 'trilium-etapi-v3' as const;
export const TRILIUM_IMPORT_REQUEST_CONCURRENCY = 8;
export const TRILIUM_IMPORT_REQUEST_TIMEOUT_MS = 15_000;
export const TRILIUM_IMPORT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const TRILIUM_IMPORT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const TRILIUM_IMPORT_MAX_NOTES = NOTES_TREE_MAX_NODES;
export const TRILIUM_IMPORT_MAX_BRANCHES = 50_000;

const MAX_TOKEN_CHARACTERS = 16 * 1024;
const MAX_REMOTE_TITLE_CHARACTERS = 10_000;
const MAX_REMOTE_TYPE_CHARACTERS = 64;
const MAX_REMOTE_MIME_CHARACTERS = 255;
const MAX_REMOTE_BLOB_ID_CHARACTERS = 256;
const MAX_REMOTE_CHILD_BRANCHES = TRILIUM_IMPORT_MAX_BRANCHES;
const MAX_WARNING_COUNT = 1_000;
const ORDER_STEP = 1_024;
const REMOTE_ID_PATTERN = /^[A-Za-z0-9_]{4,32}$/;
const VERSION_TAG_PREFIX = 'trilium:v:';
const SOURCE_TAG_PREFIX = 'trilium:source:';
const REMOTE_ID_TAG_PREFIX = 'trilium:id:';

export type TriliumPlaceholderReason = 'protected' | 'oversized' | 'unsupported';

export type PreparedTriliumContent =
  | { kind: 'ready'; language: Exclude<NoteLanguage, 'richtext'>; content: string }
  | {
    kind: 'html';
    language: 'richtext';
    html: string;
    images: TriliumScannedImageSource[];
  }
  | { kind: 'image'; language: 'richtext'; sourceKey: string }
  | { kind: 'unchanged-source' }
  | { kind: 'placeholder'; language: 'markdown'; content: string; reason: TriliumPlaceholderReason };

export interface PreparedTriliumNote {
  remoteNoteId: string;
  localNoteId: string;
  parentLocalNoteId: string | null;
  remoteBranchId: string;
  remotePosition: number;
  depth: number;
  title: string;
  sourceVersion: string;
  sourceCreatedAt: string;
  sourceModifiedAt: string;
  content: PreparedTriliumContent;
}

export interface TriliumImportWarning {
  remoteNoteId: string;
  title: string;
  reason: 'protected' | 'oversized' | 'unsupported' | 'title-truncated';
}

export interface TriliumImportPlan {
  importerVersion: typeof TRILIUM_IMPORTER_VERSION;
  endpoint: string;
  sourceId: string;
  notes: PreparedTriliumNote[];
  /** Unique validated targets needed only by changed Notes in this plan. */
  imageTargets: TriliumImportImageTarget[];
  warnings: TriliumImportWarning[];
  clones: number;
  placeholders: number;
  skippedSystemTrees: number;
  /** True only when an explicit small-sample maxNotes stopped BFS early. */
  truncated: boolean;
  transferredBytes: number;
}

export interface TriliumImportProgress {
  phase: 'discovering' | 'content';
  discovered: number;
  processed: number;
  placeholders: number;
  clones: number;
}

export interface PrepareTriliumImportOptions {
  endpoint: string;
  token: string;
  /** Deterministic local Note ID to its last imported source hash or full version tag. */
  knownSourceVersions?: Readonly<Record<string, string>>;
  /** Optional connected BFS sample size for QA. Ordinary imports leave this unset. */
  maxNotes?: number;
  /** Test-only request deadline override. Ordinary imports always use the fixed production timeout. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: TriliumImportProgress) => void;
}

export interface MergeTriliumImportOptions {
  plan: TriliumImportPlan;
  convertedHtml?: Readonly<Record<string, string>>;
  notes: NotesSnapshot;
  tombstones: readonly NoteTombstone[];
  tree: NotesTreeSnapshot;
  now?: string;
}

export interface TriliumImportSummary {
  created: number;
  updated: number;
  unchanged: number;
  placeholders: number;
  clones: number;
  imported: number;
}

export interface MergedTriliumImport {
  notes: NotesSnapshot;
  tombstones: NoteTombstone[];
  tree: NotesTreeSnapshot;
  summary: TriliumImportSummary;
}

interface RemoteTriliumNote {
  noteId: string;
  title: string;
  type: string;
  mime: string;
  isProtected: boolean;
  blobId: string;
  childBranchIds: string[];
  utcDateCreated: string;
  utcDateModified: string;
  contentLength: number | null;
}

interface RemoteTriliumAttachment {
  attachmentId: string;
  blobId: string;
  mime: string;
  utcDateModified: string;
  contentLength: number | null;
  isProtected: boolean;
}

interface RemoteTriliumBranch {
  branchId: string;
  noteId: string;
  parentNoteId: string;
  notePosition: number;
}

interface PendingPlacement extends RemoteTriliumBranch {
  parentLocalNoteId: string | null;
  depth: number;
}

interface PreparedNoteResult {
  note: PreparedTriliumNote;
  children: RemoteTriliumBranch[];
  imageTargets: TriliumImportImageTarget[];
}

class TriliumImportSafeError extends Error {}
class TriliumContentOversizedError extends Error {}

class TriliumHttpStatusError extends Error {
  public constructor(public readonly status: number) {
    super(`The Trilium ETAPI request failed (${status}).`);
  }
}

function safeError(message: string): TriliumImportSafeError {
  return new TriliumImportSafeError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRemoteBranches(left: RemoteTriliumBranch, right: RemoteTriliumBranch): number {
  return left.notePosition - right.notePosition
    || compareText(left.branchId, right.branchId)
    || compareText(left.noteId, right.noteId);
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function normalizeRemoteId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !REMOTE_ID_PATTERN.test(value)) {
    throw safeError(`The Trilium ${label} is invalid.`);
  }
  return value;
}

function normalizeBoundedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string'
    || value.length > maximum
    || /[\u0000\r\n]/.test(value)) {
    throw safeError(`The Trilium ${label} is invalid.`);
  }
  return value;
}

function normalizeRemoteTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 64) {
    throw safeError(`The Trilium ${label} is invalid.`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw safeError(`The Trilium ${label} is invalid.`);
  }
  return timestamp.toISOString();
}

function normalizeOptionalContentLength(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw safeError(`The Trilium ${label} is invalid.`);
  }
  return Number(value);
}

function normalizeRemoteIdList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_REMOTE_CHILD_BRANCHES) {
    throw safeError(`The Trilium ${label} list is invalid.`);
  }
  const ids: string[] = [];
  const unique = new Set<string>();
  for (const candidate of value) {
    const id = normalizeRemoteId(candidate, label);
    if (unique.has(id)) throw safeError(`The Trilium ${label} list is invalid.`);
    unique.add(id);
    ids.push(id);
  }
  return ids;
}

export function normalizeTriliumEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('A Trilium endpoint is required.');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2_048) throw new Error('The Trilium endpoint is invalid.');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('The Trilium endpoint is invalid.');
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    throw new Error('The Trilium endpoint is invalid.');
  }
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path.toLocaleLowerCase().endsWith('/etapi')) path = path.slice(0, -'/etapi'.length);
  path = path.replace(/\/+$/, '');
  return `${parsed.origin}${path}`;
}

export function normalizeTriliumToken(value: unknown): string {
  if (typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.length > MAX_TOKEN_CHARACTERS
    || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error('The Trilium ETAPI token is invalid.');
  }
  return value;
}

export function triliumSourceId(endpoint: unknown): string {
  return sha256Base64Url(normalizeTriliumEndpoint(endpoint)).slice(0, 22);
}

export function triliumLocalNoteId(endpoint: unknown, remoteNoteId: unknown): string {
  const canonicalEndpoint = normalizeTriliumEndpoint(endpoint);
  const normalizedRemoteNoteId = normalizeRemoteId(remoteNoteId, 'Note ID');
  return `trilium:${sha256Base64Url(canonicalEndpoint).slice(0, 22)}:${normalizedRemoteNoteId}`;
}

export function triliumSourceVersion(value: {
  title: string;
  type: string;
  mime: string;
  blobId: string;
  utcDateModified: string;
}, imageFingerprints: readonly string[] = []): string {
  return sha256Base64Url(JSON.stringify([
    TRILIUM_IMPORTER_VERSION,
    value.title,
    value.type,
    value.mime,
    value.blobId,
    value.utcDateModified,
    [...new Set(imageFingerprints)].sort(compareText),
  ]));
}

export function triliumVersionTag(version: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(version)) throw new Error('The Trilium source version is invalid.');
  return `${VERSION_TAG_PREFIX}${version}`;
}

export function triliumStoredSourceVersion(tags: readonly string[]): string | undefined {
  for (const tag of tags) {
    if (!tag.startsWith(VERSION_TAG_PREFIX)) continue;
    const version = tag.slice(VERSION_TAG_PREFIX.length);
    if (/^[A-Za-z0-9_-]{43}$/.test(version) && tag === triliumVersionTag(version)) return version;
  }
  return undefined;
}

function parseRemoteNote(value: unknown, expectedNoteId: string): RemoteTriliumNote {
  if (!isRecord(value)) throw safeError('The Trilium Note response is invalid.');
  const noteId = normalizeRemoteId(value.noteId, 'Note ID');
  if (noteId !== expectedNoteId) throw safeError('The Trilium Note response is invalid.');
  if (typeof value.isProtected !== 'boolean') throw safeError('The Trilium Note response is invalid.');
  return {
    noteId,
    title: normalizeBoundedText(value.title, MAX_REMOTE_TITLE_CHARACTERS, 'Note title'),
    type: normalizeBoundedText(value.type, MAX_REMOTE_TYPE_CHARACTERS, 'Note type'),
    mime: normalizeBoundedText(value.mime, MAX_REMOTE_MIME_CHARACTERS, 'Note MIME type'),
    isProtected: value.isProtected,
    blobId: normalizeBoundedText(value.blobId, MAX_REMOTE_BLOB_ID_CHARACTERS, 'Note blob ID'),
    childBranchIds: normalizeRemoteIdList(value.childBranchIds, 'child Branch ID'),
    utcDateCreated: normalizeRemoteTimestamp(value.utcDateCreated, 'creation timestamp'),
    utcDateModified: normalizeRemoteTimestamp(value.utcDateModified, 'modified timestamp'),
    contentLength: normalizeOptionalContentLength(value.contentLength, 'Note content length'),
  };
}

function parseRemoteAttachment(value: unknown, expectedAttachmentId: string): RemoteTriliumAttachment {
  if (!isRecord(value)) throw safeError('The Trilium Attachment response is invalid.');
  const attachmentId = normalizeRemoteId(value.attachmentId, 'Attachment ID');
  if (attachmentId !== expectedAttachmentId) {
    throw safeError('The Trilium Attachment response is invalid.');
  }
  if (value.isProtected !== undefined && typeof value.isProtected !== 'boolean') {
    throw safeError('The Trilium Attachment response is invalid.');
  }
  return {
    attachmentId,
    blobId: normalizeBoundedText(value.blobId, MAX_REMOTE_BLOB_ID_CHARACTERS, 'Attachment blob ID'),
    mime: normalizeBoundedText(value.mime, MAX_REMOTE_MIME_CHARACTERS, 'Attachment MIME type'),
    utcDateModified: normalizeRemoteTimestamp(value.utcDateModified, 'Attachment modified timestamp'),
    contentLength: normalizeOptionalContentLength(value.contentLength, 'Attachment content length'),
    isProtected: value.isProtected === true,
  };
}

function parseRemoteBranch(
  value: unknown,
  expectedBranchId: string,
  expectedParentNoteId: string,
): RemoteTriliumBranch {
  if (!isRecord(value)) throw safeError('The Trilium Branch response is invalid.');
  const branchId = normalizeRemoteId(value.branchId, 'Branch ID');
  const parentNoteId = normalizeRemoteId(value.parentNoteId, 'parent Note ID');
  if (branchId !== expectedBranchId || parentNoteId !== expectedParentNoteId) {
    throw safeError('The Trilium Branch response is invalid.');
  }
  if (typeof value.notePosition !== 'number'
    || !Number.isSafeInteger(value.notePosition)
    || value.notePosition < -2_147_483_648
    || value.notePosition > 2_147_483_647) {
    throw safeError('The Trilium Branch response is invalid.');
  }
  return {
    branchId,
    noteId: normalizeRemoteId(value.noteId, 'Note ID'),
    parentNoteId,
    notePosition: value.notePosition,
  };
}

function contentLanguage(
  type: string,
  mime: string,
): Exclude<NoteLanguage, 'richtext'> | 'html' | 'mermaid' | undefined {
  const normalizedType = type.toLocaleLowerCase();
  const normalizedMime = mime.split(';', 1)[0].trim().toLocaleLowerCase();
  // Trilium Text Notes store CKEditor HTML. The MIME field may be stale or
  // customized, so the Note type is the authoritative content contract.
  if (normalizedType === 'text') return 'html';
  if (normalizedType === 'mermaid') return 'mermaid';
  if (normalizedType !== 'code') return undefined;
  if (normalizedMime.includes('typescript') || normalizedMime === 'application/tsx') return 'typescript';
  if (normalizedMime.includes('javascript')
    || normalizedMime === 'application/ecmascript'
    || normalizedMime === 'text/ecmascript'
    || normalizedMime === 'application/jsx') return 'javascript';
  if (normalizedMime === 'text/markdown'
    || normalizedMime === 'text/x-markdown'
    || normalizedMime === 'text/x-gfm') return 'markdown';
  if (normalizedMime.includes('sql')) return 'sql';
  if (normalizedMime.includes('json')) return 'json';
  if (normalizedMime.includes('yaml') || normalizedMime.includes('yml')) return 'yaml';
  if (normalizedMime.includes('shell')
    || normalizedMime.includes('bash')
    || normalizedMime === 'application/x-sh'
    || normalizedMime === 'text/x-sh') return 'bash';
  return 'text';
}

function markdownMermaidBlock(source: string): string {
  let fenceLength = 3;
  for (const match of source.matchAll(/`+/g)) {
    fenceLength = Math.max(fenceLength, match[0].length + 1);
  }
  const fence = '`'.repeat(fenceLength);
  return `${fence}mermaid\n${source}${source.endsWith('\n') ? '' : '\n'}${fence}`;
}

function markdownPlaceholder(note: RemoteTriliumNote, reason: TriliumPlaceholderReason): string {
  const reasonText = reason === 'protected'
    ? 'This protected Trilium note cannot be read through ETAPI.'
    : reason === 'oversized'
      ? 'This Trilium note is larger than the supported Notes content limit.'
      : `This Trilium ${note.type || 'unsupported'} note is not a text or code note.`;
  return `> ${reasonText}\n>\n> Source Note ID: \`${note.noteId}\``;
}

function boundedTitle(title: string): { title: string; truncated: boolean } {
  if (title.length <= NOTE_LIMITS.nameCharacters) return { title: title.trim() || 'Untitled note', truncated: false };
  return {
    title: title.slice(0, NOTE_LIMITS.nameCharacters).trim() || 'Untitled note',
    truncated: true,
  };
}

class TransferBudget {
  private total = 0;

  add(bytes: number): void {
    this.total += bytes;
    if (this.total > TRILIUM_IMPORT_MAX_TOTAL_BYTES) {
      throw safeError('The Trilium import exceeds the supported transfer limit.');
    }
  }

  value(): number {
    return this.total;
  }
}

async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
  budget: TransferBudget,
  contentResponse: boolean,
): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const length = Number(declaredLength);
    if (length > TRILIUM_IMPORT_MAX_RESPONSE_BYTES
      || (contentResponse && length > NOTE_LIMITS.contentCharacters * 4)) {
      void response.body?.cancel().catch(() => undefined);
      if (contentResponse) throw new TriliumContentOversizedError();
      throw safeError('A Trilium response is too large.');
    }
  }

  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let responseBytes = 0;
  const cancelReader = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      responseBytes += chunk.byteLength;
      budget.add(chunk.byteLength);
      if (responseBytes > TRILIUM_IMPORT_MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        if (contentResponse) throw new TriliumContentOversizedError();
        throw safeError('A Trilium response is too large.');
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
  }
  return Buffer.concat(chunks, responseBytes);
}

class RequestLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= TRILIUM_IMPORT_REQUEST_CONCURRENCY) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

function imageMimeStatus(
  mimeType: string,
  isProtected: boolean,
  contentLength: number | null,
): TriliumImportImageTarget['status'] {
  if (isProtected) return 'protected';
  if (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp') return 'unsupported';
  if (contentLength !== null && contentLength > NOTES_IMAGE_LIMITS.bytes) return 'oversized';
  return 'ready';
}

function imageNoteTarget(remote: RemoteTriliumNote): TriliumImportImageTarget {
  const mimeType = normalizeTriliumImageMimeType(remote.mime);
  return {
    sourceKey: `note:${remote.noteId}`,
    kind: 'note',
    remoteId: remote.noteId,
    blobId: remote.blobId,
    mimeType,
    utcDateModified: remote.utcDateModified,
    contentLength: remote.contentLength,
    status: remote.type.toLocaleLowerCase() === 'image'
      ? imageMimeStatus(mimeType, remote.isProtected, remote.contentLength)
      : 'unsupported',
  };
}

function attachmentTarget(remote: RemoteTriliumAttachment): TriliumImportImageTarget {
  const mimeType = normalizeTriliumImageMimeType(remote.mime);
  return {
    sourceKey: `attachment:${remote.attachmentId}`,
    kind: 'attachment',
    remoteId: remote.attachmentId,
    blobId: remote.blobId,
    mimeType,
    utcDateModified: remote.utcDateModified,
    contentLength: remote.contentLength,
    status: imageMimeStatus(mimeType, remote.isProtected, remote.contentLength),
  };
}

function invalidImageTarget(source: TriliumScannedImageSource): TriliumImportImageTarget {
  return {
    sourceKey: source.sourceKey,
    kind: 'invalid',
    blobId: '',
    mimeType: '',
    utcDateModified: '',
    contentLength: null,
    status: 'invalid',
  };
}

class TriliumEtapiClient {
  private readonly limiter = new RequestLimiter();
  private readonly budget = new TransferBudget();
  private readonly notes = new Map<string, Promise<RemoteTriliumNote>>();
  private readonly imageTargets = new Map<string, Promise<TriliumImportImageTarget>>();

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch,
    private readonly operationSignal: AbortSignal,
    private readonly requestTimeoutMs: number,
  ) {}

  transferredBytes(): number {
    return this.budget.value();
  }

  async note(noteId: string): Promise<RemoteTriliumNote> {
    let pending = this.notes.get(noteId);
    if (!pending) {
      pending = this.json(`/notes/${encodeURIComponent(noteId)}`)
        .then((value) => parseRemoteNote(value, noteId));
      this.notes.set(noteId, pending);
    }
    return pending;
  }

  async branch(branchId: string, parentNoteId: string): Promise<RemoteTriliumBranch> {
    const value = await this.json(`/branches/${encodeURIComponent(branchId)}`);
    return parseRemoteBranch(value, branchId, parentNoteId);
  }

  async content(noteId: string): Promise<string> {
    const body = await this.request(`/notes/${encodeURIComponent(noteId)}/content`, true);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      throw safeError('A Trilium Note content response is not valid UTF-8.');
    }
    if (content.length > NOTE_LIMITS.contentCharacters) throw new TriliumContentOversizedError();
    return content;
  }

  async imageTarget(source: TriliumScannedImageSource): Promise<TriliumImportImageTarget> {
    if (source.kind === 'invalid' || source.status === 'invalid' || !source.remoteId) {
      return invalidImageTarget(source);
    }
    let pending = this.imageTargets.get(source.sourceKey);
    if (!pending) {
      pending = (async () => {
        try {
          if (source.kind === 'note') return imageNoteTarget(await this.note(source.remoteId as string));
          const value = await this.json(`/attachments/${encodeURIComponent(source.remoteId as string)}`);
          return attachmentTarget(parseRemoteAttachment(value, source.remoteId as string));
        } catch (error) {
          if (error instanceof TriliumHttpStatusError && error.status === 404) {
            return {
              sourceKey: source.sourceKey,
              kind: source.kind,
              remoteId: source.remoteId,
              blobId: '',
              mimeType: '',
              utcDateModified: '',
              contentLength: null,
              status: 'missing',
            };
          }
          throw error;
        }
      })();
      this.imageTargets.set(source.sourceKey, pending);
    }
    return pending;
  }

  private async json(pathname: string): Promise<unknown> {
    const body = await this.request(pathname, false);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
    } catch {
      throw safeError('A Trilium JSON response is invalid.');
    }
  }

  private request(pathname: string, contentResponse: boolean): Promise<Buffer> {
    return this.limiter.run(async () => {
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
          response = await this.fetchImpl(`${this.endpoint}/etapi${pathname}`, {
            method: 'GET',
            redirect: 'manual',
            signal: requestController.signal,
            headers: {
              accept: contentResponse ? 'text/plain, text/html;q=0.9, */*;q=0.1' : 'application/json',
              authorization: `Bearer ${this.token}`,
            },
          });
        } catch {
          if (abortReason === 'timeout') throw safeError('The Trilium ETAPI request timed out.');
          if (abortReason === 'owner' || requestController.signal.aborted) {
            throw safeError('The Trilium import was cancelled.');
          }
          throw safeError('The Trilium ETAPI request failed.');
        }
        if (abortReason === 'timeout') throw safeError('The Trilium ETAPI request timed out.');
        if (abortReason === 'owner' || requestController.signal.aborted) {
          throw safeError('The Trilium import was cancelled.');
        }
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => undefined);
          throw safeError('The Trilium ETAPI endpoint redirected the request.');
        }
        if (response.status < 200 || response.status >= 300) {
          void response.body?.cancel().catch(() => undefined);
          throw new TriliumHttpStatusError(response.status);
        }
        let body: Buffer;
        try {
          body = await readBoundedResponse(response, requestController.signal, this.budget, contentResponse);
        } catch (error) {
          if (abortReason === 'timeout') throw safeError('The Trilium ETAPI request timed out.');
          if (abortReason === 'owner' || requestController.signal.aborted) {
            throw safeError('The Trilium import was cancelled.');
          }
          throw error;
        }
        // Cancelling a web ReadableStream can resolve a pending read as `done`
        // instead of rejecting it. Recheck ownership after the body finishes so
        // a timed-out prefix can never be accepted as a complete response.
        if (abortReason === 'timeout') throw safeError('The Trilium ETAPI request timed out.');
        if (abortReason === 'owner' || requestController.signal.aborted) {
          throw safeError('The Trilium import was cancelled.');
        }
        return body;
      } finally {
        clearTimeout(timeout);
        this.operationSignal.removeEventListener('abort', abortFromOwner);
      }
    });
  }
}

async function remoteChildren(client: TriliumEtapiClient, note: RemoteTriliumNote): Promise<RemoteTriliumBranch[]> {
  const children = await Promise.all(note.childBranchIds.map((branchId) => client.branch(branchId, note.noteId)));
  return children.sort(compareRemoteBranches);
}

function pushWarning(warnings: TriliumImportWarning[], warning: TriliumImportWarning): void {
  if (warnings.length < MAX_WARNING_COUNT) warnings.push(warning);
}

async function prepareRemoteNote(
  client: TriliumEtapiClient,
  endpoint: string,
  placement: PendingPlacement,
  warnings: TriliumImportWarning[],
  knownSourceVersions: Readonly<Record<string, string>>,
): Promise<PreparedNoteResult> {
  const remote = await client.note(placement.noteId);
  const { title, truncated } = boundedTitle(remote.title);
  if (truncated) pushWarning(warnings, {
    remoteNoteId: remote.noteId,
    title,
    reason: 'title-truncated',
  });
  const localNoteId = triliumLocalNoteId(endpoint, remote.noteId);
  const knownSourceVersion = knownSourceVersions[localNoteId];
  let content: PreparedTriliumContent;
  let sourceVersion: string;
  let imageTargets: TriliumImportImageTarget[] = [];
  const language = contentLanguage(remote.type, remote.mime);
  const isKnown = (version: string): boolean => (
    knownSourceVersion === version || knownSourceVersion === triliumVersionTag(version)
  );

  if (language === 'html' && !remote.isProtected) {
    try {
      const remoteContent = await client.content(remote.noteId);
      const images = scanTriliumHtmlImages(endpoint, remoteContent);
      const uniqueSources = [...new Map(images.map((image) => [image.sourceKey, image])).values()];
      const targets = await Promise.all(uniqueSources.map((image) => client.imageTarget(image)));
      sourceVersion = triliumSourceVersion(remote, targets.map(triliumImageTargetFingerprint));
      if (isKnown(sourceVersion)) {
        content = { kind: 'unchanged-source' };
      } else {
        content = { kind: 'html', language: 'richtext', html: remoteContent, images };
        imageTargets = targets;
      }
    } catch (error) {
      if (!(error instanceof TriliumContentOversizedError)) throw error;
      sourceVersion = triliumSourceVersion(remote);
      content = {
        kind: 'placeholder',
        language: 'markdown',
        content: markdownPlaceholder(remote, 'oversized'),
        reason: 'oversized',
      };
    }
  } else if (remote.type.toLocaleLowerCase() === 'image') {
    const target = imageNoteTarget(remote);
    sourceVersion = triliumSourceVersion(remote, [triliumImageTargetFingerprint(target)]);
    if (isKnown(sourceVersion)) {
      content = { kind: 'unchanged-source' };
    } else if (target.status === 'ready') {
      content = { kind: 'image', language: 'richtext', sourceKey: target.sourceKey };
      imageTargets = [target];
    } else {
      const reason: TriliumPlaceholderReason = target.status === 'protected'
        ? 'protected'
        : target.status === 'oversized'
          ? 'oversized'
          : 'unsupported';
      content = {
        kind: 'placeholder',
        language: 'markdown',
        content: markdownPlaceholder(remote, reason),
        reason,
      };
    }
  } else {
    sourceVersion = triliumSourceVersion(remote);
    if (isKnown(sourceVersion)) {
      content = { kind: 'unchanged-source' };
    } else if (remote.isProtected) {
      content = {
        kind: 'placeholder',
        language: 'markdown',
        content: markdownPlaceholder(remote, 'protected'),
        reason: 'protected',
      };
    } else if (language === undefined) {
      content = {
        kind: 'placeholder',
        language: 'markdown',
        content: markdownPlaceholder(remote, 'unsupported'),
        reason: 'unsupported',
      };
    } else {
      if (language === 'html') throw safeError('The Trilium Note content contract is invalid.');
      try {
        const remoteContent = await client.content(remote.noteId);
        const readyContent: Extract<PreparedTriliumContent, { kind: 'ready' }> = language === 'mermaid'
          ? { kind: 'ready', language: 'markdown', content: markdownMermaidBlock(remoteContent) }
          : { kind: 'ready', language, content: remoteContent };
        if (readyContent.content.length > NOTE_LIMITS.contentCharacters) throw new TriliumContentOversizedError();
        content = readyContent;
      } catch (error) {
        if (!(error instanceof TriliumContentOversizedError)) throw error;
        content = {
          kind: 'placeholder',
          language: 'markdown',
          content: markdownPlaceholder(remote, 'oversized'),
          reason: 'oversized',
        };
      }
    }
  }
  if (content.kind === 'placeholder') pushWarning(warnings, {
    remoteNoteId: remote.noteId,
    title,
    reason: content.reason,
  });
  const children = await remoteChildren(client, remote);
  return {
    note: {
      remoteNoteId: remote.noteId,
      localNoteId,
      parentLocalNoteId: placement.parentLocalNoteId,
      remoteBranchId: placement.branchId,
      remotePosition: placement.notePosition,
      depth: placement.depth,
      title,
      sourceVersion,
      sourceCreatedAt: remote.utcDateCreated,
      sourceModifiedAt: remote.utcDateModified,
      content,
    },
    children,
    imageTargets,
  };
}

function progress(
  options: PrepareTriliumImportOptions,
  phase: TriliumImportProgress['phase'],
  discovered: number,
  processed: number,
  placeholders: number,
  clones: number,
): void {
  options.onProgress?.({ phase, discovered, processed, placeholders, clones });
}

/** Read one bounded Trilium hierarchy without mutating local Notes state. */
export async function prepareTriliumImport(options: PrepareTriliumImportOptions): Promise<TriliumImportPlan> {
  const endpoint = normalizeTriliumEndpoint(options.endpoint);
  const token = normalizeTriliumToken(options.token);
  const controller = new AbortController();
  const abortFromOwner = (): void => controller.abort();
  if (options.signal?.aborted) abortFromOwner();
  else options.signal?.addEventListener('abort', abortFromOwner, { once: true });
  const requestTimeoutMs = options.requestTimeoutMs ?? TRILIUM_IMPORT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs)
    || requestTimeoutMs < 1
    || requestTimeoutMs > TRILIUM_IMPORT_REQUEST_TIMEOUT_MS) {
    throw new Error('The Trilium request timeout is invalid.');
  }
  const client = new TriliumEtapiClient(
    endpoint,
    token,
    options.fetchImpl ?? fetch,
    controller.signal,
    requestTimeoutMs,
  );
  const seenNoteIds = new Set<string>();
  const seenBranchIds = new Set<string>();
  const notes: PreparedTriliumNote[] = [];
  const imageTargets = new Map<string, TriliumImportImageTarget>();
  const warnings: TriliumImportWarning[] = [];
  let clones = 0;
  let skippedSystemTrees = 0;
  const sampleMaxNotes = options.maxNotes;
  if (sampleMaxNotes !== undefined
    && (!Number.isInteger(sampleMaxNotes) || sampleMaxNotes < 1 || sampleMaxNotes > TRILIUM_IMPORT_MAX_NOTES)) {
    throw new Error(`A Trilium sample must contain between 1 and ${TRILIUM_IMPORT_MAX_NOTES} Notes.`);
  }
  const maximumNotes = sampleMaxNotes ?? TRILIUM_IMPORT_MAX_NOTES;
  let truncated = false;

  try {
    const root = await client.note('root');
    const rootChildren = await remoteChildren(client, root);
    for (const child of rootChildren) {
      if (seenBranchIds.has(child.branchId)) {
        throw safeError('The Trilium hierarchy contains a duplicate Branch ID.');
      }
      seenBranchIds.add(child.branchId);
      if (seenBranchIds.size > TRILIUM_IMPORT_MAX_BRANCHES) {
        throw safeError(`The Trilium import cannot contain more than ${TRILIUM_IMPORT_MAX_BRANCHES} Branches.`);
      }
    }
    let frontier: PendingPlacement[] = rootChildren.flatMap((branch) => {
      if (branch.noteId.startsWith('_')) {
        skippedSystemTrees += 1;
        return [];
      }
      return [{ ...branch, parentLocalNoteId: null, depth: 0 }];
    });
    progress(options, 'discovering', frontier.length, 0, 0, clones);

    while (frontier.length > 0) {
      const uniqueFrontier: PendingPlacement[] = [];
      for (const placement of frontier) {
        if (placement.depth > NOTES_TREE_MAX_DEPTH) {
          throw safeError(`The Trilium hierarchy exceeds the supported depth of ${NOTES_TREE_MAX_DEPTH}.`);
        }
        if (seenNoteIds.has(placement.noteId)) {
          clones += 1;
          continue;
        }
        if (seenNoteIds.size >= maximumNotes) {
          if (sampleMaxNotes === undefined) {
            throw safeError(`The Trilium import cannot contain more than ${TRILIUM_IMPORT_MAX_NOTES} Notes.`);
          }
          truncated = true;
          break;
        }
        seenNoteIds.add(placement.noteId);
        uniqueFrontier.push(placement);
      }

      let completedInFrontier = 0;
      let placeholdersInFrontier = 0;
      const previousPlaceholderCount = notes.filter((note) => note.content.kind === 'placeholder').length;
      const results = await Promise.all(uniqueFrontier.map(async (placement) => {
        const result = await prepareRemoteNote(
          client,
          endpoint,
          placement,
          warnings,
          options.knownSourceVersions ?? {},
        );
        completedInFrontier += 1;
        if (result.note.content.kind === 'placeholder') placeholdersInFrontier += 1;
        progress(
          options,
          'content',
          notes.length + uniqueFrontier.length,
          notes.length + completedInFrontier,
          previousPlaceholderCount + placeholdersInFrontier,
          clones,
        );
        return result;
      }));
      const nextFrontier: PendingPlacement[] = [];
      for (const result of results) {
        notes.push(result.note);
        for (const target of result.imageTargets) {
          const existing = imageTargets.get(target.sourceKey);
          if (existing
            && triliumImageTargetFingerprint(existing) !== triliumImageTargetFingerprint(target)) {
            throw safeError('A Trilium image changed while the import was being prepared.');
          }
          if (!existing && imageTargets.size >= TRILIUM_IMPORT_MAX_BRANCHES) {
            throw safeError(`The Trilium import cannot contain more than ${TRILIUM_IMPORT_MAX_BRANCHES} images.`);
          }
          imageTargets.set(target.sourceKey, target);
        }
        for (const child of result.children) {
          if (seenBranchIds.has(child.branchId)) {
            throw safeError('The Trilium hierarchy contains a duplicate Branch ID.');
          }
          seenBranchIds.add(child.branchId);
          if (seenBranchIds.size > TRILIUM_IMPORT_MAX_BRANCHES) {
            throw safeError(`The Trilium import cannot contain more than ${TRILIUM_IMPORT_MAX_BRANCHES} Branches.`);
          }
          nextFrontier.push({
            ...child,
            parentLocalNoteId: result.note.localNoteId,
            depth: result.note.depth + 1,
          });
        }
      }
      const placeholderCount = notes.filter((note) => note.content.kind === 'placeholder').length;
      progress(options, 'content', notes.length + nextFrontier.length, notes.length, placeholderCount, clones);
      if (truncated) break;
      if (sampleMaxNotes !== undefined && seenNoteIds.size >= maximumNotes && nextFrontier.length > 0) {
        truncated = true;
        break;
      }
      frontier = nextFrontier;
    }

    const placeholders = notes.filter((note) => note.content.kind === 'placeholder').length;
    const noteOrder = new Map(notes.map((note, index) => [note.remoteNoteId, index]));
    warnings.sort((left, right) => (noteOrder.get(left.remoteNoteId) ?? Number.MAX_SAFE_INTEGER)
      - (noteOrder.get(right.remoteNoteId) ?? Number.MAX_SAFE_INTEGER)
      || compareText(left.reason, right.reason));
    return {
      importerVersion: TRILIUM_IMPORTER_VERSION,
      endpoint,
      sourceId: triliumSourceId(endpoint),
      notes,
      imageTargets: [...imageTargets.values()].sort((left, right) => compareText(left.sourceKey, right.sourceKey)),
      warnings,
      clones,
      placeholders,
      skippedSystemTrees,
      truncated,
      transferredBytes: client.transferredBytes(),
    };
  } catch (error) {
    controller.abort();
    if (options.signal?.aborted) throw new Error('The Trilium import was cancelled.');
    if (error instanceof TriliumImportSafeError
      || error instanceof TriliumContentOversizedError
      || error instanceof TriliumHttpStatusError) {
      throw new Error(error.message || 'A Trilium Note is too large.');
    }
    throw new Error('The Trilium import failed.');
  } finally {
    options.signal?.removeEventListener('abort', abortFromOwner);
  }
}

function importedTags(current: readonly string[], plan: TriliumImportPlan, note: PreparedTriliumNote): string[] {
  const retained = current.filter((tag) => (
    !tag.startsWith(VERSION_TAG_PREFIX)
    && !tag.startsWith(SOURCE_TAG_PREFIX)
    && !tag.startsWith(REMOTE_ID_TAG_PREFIX)
  )).slice(0, NOTE_LIMITS.tags - 3);
  return [
    ...retained,
    `${SOURCE_TAG_PREFIX}${plan.sourceId}`,
    `${REMOTE_ID_TAG_PREFIX}${note.remoteNoteId}`,
    triliumVersionTag(note.sourceVersion),
  ];
}

function preparedBody(
  note: PreparedTriliumNote,
  convertedHtml: Readonly<Record<string, string>>,
): Pick<Note, 'content' | 'language'> {
  if (note.content.kind === 'unchanged-source') {
    throw new Error(`Imported Note ${note.title} was marked unchanged but has no current local body.`);
  }
  if (note.content.kind === 'html' || note.content.kind === 'image') {
    const converted = convertedHtml[note.localNoteId];
    if (typeof converted !== 'string') {
      throw new Error(`Converted Rich Text is missing for imported Note ${note.title}.`);
    }
    const content = normalizeRichTextContent(converted);
    if (content.length > NOTE_LIMITS.contentCharacters) {
      throw new Error(`Converted Rich Text is too large for imported Note ${note.title}.`);
    }
    return { content, language: 'richtext' };
  }
  if (note.content.content.length > NOTE_LIMITS.contentCharacters) {
    throw new Error(`Imported Note content is too large for ${note.title}.`);
  }
  return { content: note.content.content, language: note.content.language };
}

function normalizeMergeTimestamp(value: string | undefined): string {
  const timestamp = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('The Trilium import timestamp is invalid.');
  return timestamp.toISOString();
}

function compareNotes(left: Note, right: Note): number {
  return compareText(left.id, right.id);
}

function importedTree(
  currentNodes: readonly NotesTreeNode[],
  planNotes: readonly PreparedTriliumNote[],
): NotesTreeNode[] {
  const refreshedIds = new Set(planNotes.map((note) => note.localNoteId));
  const retained = currentNodes
    .filter((node) => !refreshedIds.has(node.noteId))
    .map((node) => ({ ...node }));
  const grouped = new Map<string | null, PreparedTriliumNote[]>();
  for (const note of planNotes) {
    const siblings = grouped.get(note.parentLocalNoteId) ?? [];
    siblings.push(note);
    grouped.set(note.parentLocalNoteId, siblings);
  }
  for (const [parentId, siblings] of grouped) {
    siblings.sort((left, right) => left.remotePosition - right.remotePosition
      || compareText(left.remoteBranchId, right.remoteBranchId)
      || compareText(left.localNoteId, right.localNoteId));
    let order = retained
      .filter((node) => node.parentId === parentId)
      .reduce((maximum, node) => Math.max(maximum, node.order), 0);
    for (const sibling of siblings) {
      if (order > Number.MAX_SAFE_INTEGER - ORDER_STEP) {
        throw new Error('The Notes tree has no remaining ordering capacity.');
      }
      order += ORDER_STEP;
      retained.push({
        noteId: sibling.localNoteId,
        parentId,
        order,
      });
    }
  }
  return retained.sort((left, right) => {
    if (left.parentId !== right.parentId) return compareText(left.parentId ?? '', right.parentId ?? '');
    return left.order - right.order || compareText(left.noteId, right.noteId);
  });
}

function validatePlan(plan: TriliumImportPlan): void {
  if (plan.importerVersion !== TRILIUM_IMPORTER_VERSION
    || normalizeTriliumEndpoint(plan.endpoint) !== plan.endpoint
    || triliumSourceId(plan.endpoint) !== plan.sourceId
    || !Array.isArray(plan.notes)
    || plan.notes.length > TRILIUM_IMPORT_MAX_NOTES
    || !Array.isArray(plan.imageTargets)
    || plan.imageTargets.length > TRILIUM_IMPORT_MAX_BRANCHES) {
    throw new Error('The prepared Trilium import is invalid.');
  }
  const imageTargetKeys = new Set<string>();
  try {
    for (const target of plan.imageTargets) {
      validateTriliumImportImageTarget(target);
      if (imageTargetKeys.has(target.sourceKey)) throw new Error('duplicate target');
      imageTargetKeys.add(target.sourceKey);
    }
  } catch {
    throw new Error('The prepared Trilium import is invalid.');
  }
  const ids = new Set<string>();
  for (const note of plan.notes) {
    if (triliumLocalNoteId(plan.endpoint, note.remoteNoteId) !== note.localNoteId
      || ids.has(note.localNoteId)
      || note.title.length === 0
      || note.title.length > NOTE_LIMITS.nameCharacters
      || note.depth < 0
      || note.depth > NOTES_TREE_MAX_DEPTH
      || (note.parentLocalNoteId !== null && !ids.has(note.parentLocalNoteId))) {
      throw new Error('The prepared Trilium import is invalid.');
    }
    if (note.content.kind === 'html') {
      if (!Array.isArray(note.content.images)
        || note.content.images.some((image) => !imageTargetKeys.has(image.sourceKey))) {
        throw new Error('The prepared Trilium import is invalid.');
      }
    } else if (note.content.kind === 'image' && !imageTargetKeys.has(note.content.sourceKey)) {
      throw new Error('The prepared Trilium import is invalid.');
    }
    ids.add(note.localNoteId);
  }
}

/** Merge a prepared import into snapshots. The caller owns every durable write. */
export function mergeTriliumImport(options: MergeTriliumImportOptions): MergedTriliumImport {
  validatePlan(options.plan);
  if (options.notes.schemaVersion !== NOTES_SCHEMA_VERSION
    || options.tree.schemaVersion !== NOTES_TREE_SCHEMA_VERSION) {
    throw new Error('The current Notes workspace is invalid.');
  }
  const convertedHtml = options.convertedHtml ?? {};
  const currentById = new Map(options.notes.notes.map((note) => [note.id, note]));
  const resultById = new Map(options.notes.notes.map((note) => [note.id, {
    ...note,
    tags: [...note.tags],
  }]));
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const prepared of options.plan.notes) {
    const current = currentById.get(prepared.localNoteId);
    const versionTag = triliumVersionTag(prepared.sourceVersion);
    if (current?.tags.includes(versionTag)) {
      resultById.set(prepared.localNoteId, {
        ...current,
        tags: [...current.tags],
      });
      unchanged += 1;
      continue;
    }
    const body = preparedBody(prepared, convertedHtml);
    const createdAt = current?.createdAt ?? prepared.sourceCreatedAt;
    const updatedAt = prepared.sourceModifiedAt || normalizeMergeTimestamp(options.now);
    resultById.set(prepared.localNoteId, {
      id: prepared.localNoteId,
      name: prepared.title,
      ...body,
      tags: importedTags(current?.tags ?? [], options.plan, prepared),
      createdAt,
      updatedAt,
    });
    if (current) updated += 1;
    else created += 1;
  }

  if (resultById.size > NOTE_LIMITS.notes) {
    throw new Error(`The import would exceed the supported limit of ${NOTE_LIMITS.notes} Notes.`);
  }
  const importedIds = new Set(options.plan.notes.map((note) => note.localNoteId));
  const tombstones = options.tombstones
    .filter((tombstone) => !importedIds.has(tombstone.id))
    .map((tombstone) => ({ ...tombstone }))
    .sort((left, right) => compareText(left.id, right.id));
  const notes = [...resultById.values()].sort(compareNotes);
  const treeNodes = importedTree(options.tree.nodes, options.plan.notes);
  if (treeNodes.length > NOTES_TREE_MAX_NODES) {
    throw new Error(`The import would exceed the supported tree limit of ${NOTES_TREE_MAX_NODES} Notes.`);
  }

  return {
    notes: { schemaVersion: NOTES_SCHEMA_VERSION, notes },
    tombstones,
    tree: { schemaVersion: NOTES_TREE_SCHEMA_VERSION, nodes: treeNodes },
    summary: {
      created,
      updated,
      unchanged,
      placeholders: options.plan.placeholders,
      clones: options.plan.clones,
      imported: options.plan.notes.length,
    },
  };
}
