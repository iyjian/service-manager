import { createHash, randomBytes } from 'node:crypto';
import type {
  Note,
  NoteAttachmentReference,
  NoteImageReference,
  NoteShareDurationHours,
  NoteShareView,
} from '../shared/types';
import {
  parseNoteAttachmentReference,
  parseNoteImageNodeAttributes,
  parseRichTextContent,
  type RichTextNode,
} from '../shared/noteRichText';
import {
  buildNoteShareDocument,
  richTextToShareHtml,
} from '../shared/noteExport';
import { renderMarkdownToSafeHtml } from '../shared/notesMarkdown';
import {
  buildS3BucketUrl,
  normalizeS3EndpointBucket,
  presignS3Get,
  signS3Request,
  type S3EndpointBucket,
} from './s3Request';
import { highlightSafeNoteCodeBlocks } from './noteCodeHighlight';

const SHARE_PREFIX = 'service-manager/v4/shares';
const SHARE_SCHEMA_VERSION = 1 as const;
const MAX_HISTORY = 100;
const MAX_LIST_BODY_BYTES = 512 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_DELETE_OBJECTS = 2_000;
const LIST_PAGE_LIMIT = 1_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const SHARE_HOURS = new Set<NoteShareDurationHours>([24, 72, 168]);
const NOTE_LANGUAGES = new Set<Note['language']>([
  'markdown', 'richtext', 'bash', 'javascript', 'typescript', 'sql', 'json', 'yaml', 'text',
]);

export interface NotesShareS3StoreOptions extends S3EndpointBucket {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  createRandomBytes?: (size: number) => Buffer;
  timeoutMs?: number;
}

export interface NoteShareAssetLoader {
  loadImage: (reference: NoteImageReference) => Promise<Buffer>;
  loadAttachment: (reference: NoteAttachmentReference) => Promise<Buffer>;
}

interface ShareAsset {
  identity: string;
  key: string;
  mimeType: string;
}

interface ShareSnapshot {
  name: string;
  content: string;
  language: Note['language'];
}

interface NoteShareManifest {
  schemaVersion: typeof SHARE_SCHEMA_VERSION;
  app: 'service-manager';
  noteId: string;
  shareId: string;
  createdAt: string;
  signedAt: string;
  expiresAt: string;
  indexKey: string;
  snapshot: ShareSnapshot;
  images: ShareAsset[];
  attachments: ShareAsset[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function escapedHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function validDuration(value: unknown): NoteShareDurationHours {
  if (!SHARE_HOURS.has(value as NoteShareDurationHours)) {
    throw new Error('The Note share expiry must be 24 hours, 3 days, or 7 days.');
  }
  return value as NoteShareDurationHours;
}

function validShareId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new Error('The Note share ID is invalid.');
  }
  return value;
}

function validTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('The Note share timestamp is invalid.');
  }
  return value;
}

function notePathId(noteId: string): string {
  if (typeof noteId !== 'string' || noteId.length < 1 || noteId.length > 128) {
    throw new Error('The Note share Note ID is invalid.');
  }
  return createHash('sha256').update(noteId, 'utf8').digest('hex');
}

function shareRoot(noteId: string, shareId: string): string {
  return `${SHARE_PREFIX}/${notePathId(noteId)}/${validShareId(shareId)}`;
}

function shareManifestKey(noteId: string, shareId: string): string {
  return `${shareRoot(noteId, shareId)}/manifest.json`;
}

function objectUrl(endpoint: string, bucket: string, key: string): string {
  if (!/^[A-Za-z0-9_./-]{1,1024}$/.test(key) || key.includes('..')) {
    throw new Error('The Note share object key is invalid.');
  }
  return `${buildS3BucketUrl(endpoint, bucket)}/${key}`;
}

function assetIdentity(kind: 'image' | 'attachment', reference: NoteImageReference | NoteAttachmentReference): string {
  return `${kind}:${reference.objectId}:${reference.contentSha256}`;
}

function imageExtension(mimeType: NoteImageReference['mimeType']): string {
  return mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp';
}

function safeContentType(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/.test(value)
    ? value
    : 'application/octet-stream';
}

function randomId(createBytes: (size: number) => Buffer, bytes = 18): string {
  const value = createBytes(bytes);
  if (!Buffer.isBuffer(value) || value.byteLength !== bytes) throw new Error('Secure Note share randomness is unavailable.');
  return value.toString('base64url');
}

function parseShareAsset(value: unknown, expectedPrefix: string): ShareAsset {
  if (!isRecord(value) || typeof value.identity !== 'string' || typeof value.key !== 'string' || typeof value.mimeType !== 'string'
    || !value.identity.startsWith(expectedPrefix) || !/^[A-Za-z0-9_./-]{1,1024}$/.test(value.key)) {
    throw new Error('The Note share manifest is invalid.');
  }
  return { identity: value.identity, key: value.key, mimeType: safeContentType(value.mimeType) };
}

function parseShareManifest(value: unknown): NoteShareManifest {
  if (!isRecord(value)
    || value.schemaVersion !== SHARE_SCHEMA_VERSION
    || value.app !== 'service-manager'
    || typeof value.noteId !== 'string'
    || value.noteId.length < 1
    || value.noteId.length > 128
    || !isRecord(value.snapshot)
    || typeof value.snapshot.name !== 'string'
    || typeof value.snapshot.content !== 'string'
    || !NOTE_LANGUAGES.has(value.snapshot.language as Note['language'])
    || !Array.isArray(value.images)
    || !Array.isArray(value.attachments)
    || typeof value.indexKey !== 'string'
    || !/^[A-Za-z0-9_./-]{1,1024}$/.test(value.indexKey)) {
    throw new Error('The Note share manifest is invalid.');
  }
  if (value.snapshot.name.length > 200 || value.snapshot.content.length > 1_048_576) {
    throw new Error('The Note share manifest is invalid.');
  }
  const manifest: NoteShareManifest = {
    schemaVersion: SHARE_SCHEMA_VERSION,
    app: 'service-manager',
    noteId: value.noteId,
    shareId: validShareId(value.shareId),
    createdAt: validTimestamp(value.createdAt),
    signedAt: validTimestamp(value.signedAt),
    expiresAt: validTimestamp(value.expiresAt),
    indexKey: value.indexKey,
    snapshot: {
      name: value.snapshot.name,
      content: value.snapshot.content,
      language: value.snapshot.language as Note['language'],
    },
    images: value.images.map((asset) => parseShareAsset(asset, 'image:')),
    attachments: value.attachments.map((asset) => parseShareAsset(asset, 'attachment:')),
  };
  if (Date.parse(manifest.expiresAt) <= Date.parse(manifest.signedAt)
    || Date.parse(manifest.expiresAt) - Date.parse(manifest.signedAt) > 7 * 24 * 60 * 60 * 1_000) {
    throw new Error('The Note share manifest is invalid.');
  }
  return manifest;
}

function xmlValues(body: string, tag: string): string[] {
  const expression = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = expression.exec(body))) {
    const decoded = match[1]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    values.push(decoded);
  }
  return values;
}

function collectAssets(value: string): { images: NoteImageReference[]; attachments: NoteAttachmentReference[] } {
  const images: NoteImageReference[] = [];
  const attachments: NoteAttachmentReference[] = [];
  const seenImages = new Set<string>();
  const seenAttachments = new Set<string>();
  const visit = (node: RichTextNode): void => {
    if (node.type === 's3Image') {
      const image = parseNoteImageNodeAttributes(node.attrs);
      const identity = assetIdentity('image', image);
      if (!seenImages.has(identity)) {
        seenImages.add(identity);
        images.push(image);
      }
    } else if (node.type === 's3Attachment') {
      const attachment = parseNoteAttachmentReference(node.attrs);
      const identity = assetIdentity('attachment', attachment);
      if (!seenAttachments.has(identity)) {
        seenAttachments.add(identity);
        attachments.push(attachment);
      }
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const node of parseRichTextContent(value).content ?? []) visit(node);
  return { images, attachments };
}

function staticBody(snapshot: ShareSnapshot, imageUrls: Map<string, string>, attachmentUrls: Map<string, string>): string {
  if (snapshot.language === 'richtext') {
    return richTextToShareHtml(snapshot.content, {
      imageUrl: (reference) => {
        const value = imageUrls.get(assetIdentity('image', reference));
        if (!value) throw new Error('A shared Note image is unavailable.');
        return value;
      },
      attachmentUrl: (reference) => {
        const value = attachmentUrls.get(assetIdentity('attachment', reference));
        if (!value) throw new Error('A shared Note attachment is unavailable.');
        return value;
      },
    });
  }
  if (snapshot.language === 'markdown') return renderMarkdownToSafeHtml(snapshot.content);
  return `<pre><code class="language-${escapedHtml(snapshot.language)}">${escapedHtml(snapshot.content)}</code></pre>`;
}

/** Owns only the isolated S3 share prefix; it never touches sync objects. */
export class NotesShareS3Store {
  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly createRandomBytes: (size: number) => Buffer;
  private readonly timeoutMs: number;

  public constructor(private readonly options: NotesShareS3StoreOptions) {
    const target = normalizeS3EndpointBucket(options.endpoint, options.bucket);
    this.endpoint = target.endpoint;
    this.bucket = target.bucket;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.createRandomBytes = options.createRandomBytes ?? randomBytes;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async list(noteId: string): Promise<NoteShareView[]> {
    const noteRoot = `${SHARE_PREFIX}/${notePathId(noteId)}/`;
    const response = await this.request('GET', buildS3BucketUrl(this.endpoint, this.bucket), undefined, undefined, {
      'list-type': '2', prefix: noteRoot, delimiter: '/', 'max-keys': String(MAX_HISTORY),
    }, MAX_LIST_BODY_BYTES);
    if (response.status < 200 || response.status >= 300) throw new Error('Unable to list Note shares.');
    const shareIds = xmlValues(response.body.toString('utf8'), 'Prefix')
      .map((prefix) => prefix.match(new RegExp(`^${noteRoot}([A-Za-z0-9_-]{16,128})/$`))?.[1])
      .filter((shareId): shareId is string => Boolean(shareId));
    const views: NoteShareView[] = [];
    for (const shareId of shareIds) {
      try {
        const manifest = await this.readManifest(noteId, shareId);
        views.push(this.toView(manifest));
      } catch {
        // One malformed or partially removed share must not hide other history.
      }
    }
    return views.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  public async create(note: Note, expiresInHours: NoteShareDurationHours, loader: NoteShareAssetLoader): Promise<NoteShareView> {
    const hours = validDuration(expiresInHours);
    const shareId = randomId(this.createRandomBytes);
    const root = shareRoot(note.id, shareId);
    const snapshot: ShareSnapshot = { name: note.name, content: note.content, language: note.language };
    const images: ShareAsset[] = [];
    const attachments: ShareAsset[] = [];
    try {
      if (note.language === 'richtext') {
        const assets = collectAssets(note.content);
        for (const [index, reference] of assets.images.entries()) {
          const key = `${root}/assets/images/${String(index + 1).padStart(3, '0')}.${imageExtension(reference.mimeType)}`;
          const bytes = await loader.loadImage(reference);
          if (!Buffer.isBuffer(bytes) || bytes.byteLength !== reference.byteLength) throw new Error('A shared Note image is unavailable.');
          await this.put(key, bytes, reference.mimeType);
          images.push({ identity: assetIdentity('image', reference), key, mimeType: reference.mimeType });
        }
        for (const [index, reference] of assets.attachments.entries()) {
          const key = `${root}/assets/attachments/${String(index + 1).padStart(3, '0')}`;
          const bytes = await loader.loadAttachment(reference);
          if (!Buffer.isBuffer(bytes) || bytes.byteLength !== reference.byteLength) throw new Error('A shared Note attachment is unavailable.');
          await this.put(key, bytes, safeContentType(reference.mimeType));
          attachments.push({ identity: assetIdentity('attachment', reference), key, mimeType: safeContentType(reference.mimeType) });
        }
      }
      const manifest = await this.writeSignedIndex({
        schemaVersion: SHARE_SCHEMA_VERSION,
        app: 'service-manager',
        noteId: note.id,
        shareId,
        createdAt: this.now().toISOString(),
        signedAt: '',
        expiresAt: '',
        indexKey: '',
        snapshot,
        images,
        attachments,
      }, hours);
      await this.put(shareManifestKey(note.id, shareId), Buffer.from(JSON.stringify(manifest), 'utf8'), 'application/json');
      return this.toView(manifest);
    } catch (error) {
      await this.deletePrefix(`${root}/`).catch(() => undefined);
      throw error;
    }
  }

  public async resign(noteId: string, shareIdValue: string, expiresInHours: NoteShareDurationHours): Promise<NoteShareView> {
    const hours = validDuration(expiresInHours);
    const shareId = validShareId(shareIdValue);
    const current = await this.readManifest(noteId, shareId);
    const next = await this.writeSignedIndex(current, hours);
    await this.put(shareManifestKey(noteId, shareId), Buffer.from(JSON.stringify(next), 'utf8'), 'application/json');
    return this.toView(next);
  }

  public async delete(noteId: string, shareIdValue: string): Promise<void> {
    const shareId = validShareId(shareIdValue);
    await this.deletePrefix(`${shareRoot(noteId, shareId)}/`);
  }

  private async writeSignedIndex(manifest: NoteShareManifest, expiresInHours: NoteShareDurationHours): Promise<NoteShareManifest> {
    const signedAt = this.now();
    const expiresInSeconds = expiresInHours * 60 * 60;
    const expiresAt = new Date(signedAt.getTime() + expiresInSeconds * 1_000).toISOString();
    const root = shareRoot(manifest.noteId, manifest.shareId);
    const version = `${signedAt.getTime()}-${randomId(this.createRandomBytes, 8)}`;
    const indexKey = `${root}/versions/${version}/index.html`;
    const imageUrls = new Map(manifest.images.map((asset) => [asset.identity, this.presign(asset.key, signedAt, expiresInSeconds)]));
    const attachmentUrls = new Map(manifest.attachments.map((asset) => [asset.identity, this.presign(asset.key, signedAt, expiresInSeconds)]));
    const bodyHtml = highlightSafeNoteCodeBlocks(staticBody(manifest.snapshot, imageUrls, attachmentUrls));
    const page = buildNoteShareDocument(manifest.snapshot.name || 'Untitled', bodyHtml);
    await this.put(indexKey, Buffer.from(page, 'utf8'), 'text/html; charset=utf-8');
    return parseShareManifest({
      ...manifest,
      signedAt: signedAt.toISOString(),
      expiresAt,
      indexKey,
    });
  }

  private async readManifest(noteId: string, shareId: string): Promise<NoteShareManifest> {
    const result = await this.request('GET', objectUrl(this.endpoint, this.bucket, shareManifestKey(noteId, shareId)), undefined, undefined, undefined, MAX_MANIFEST_BYTES);
    if (result.status === 404) throw new Error('The Note share is unavailable.');
    if (result.status < 200 || result.status >= 300) throw new Error('Unable to read the Note share.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.body.toString('utf8'));
    } catch {
      throw new Error('The Note share manifest is invalid.');
    }
    const manifest = parseShareManifest(parsed);
    if (manifest.noteId !== noteId || manifest.shareId !== shareId) throw new Error('The Note share manifest is invalid.');
    return manifest;
  }

  private toView(manifest: NoteShareManifest): NoteShareView {
    const signedAt = Date.parse(manifest.signedAt);
    const expiresAt = Date.parse(manifest.expiresAt);
    const expiresInSeconds = Math.round((expiresAt - signedAt) / 1_000);
    const active = this.now().getTime() < expiresAt;
    return {
      shareId: manifest.shareId,
      title: manifest.snapshot.name || 'Untitled',
      createdAt: manifest.createdAt,
      expiresAt: manifest.expiresAt,
      status: active ? 'active' : 'expired',
      ...(active ? { url: this.presign(manifest.indexKey, new Date(signedAt), expiresInSeconds) } : {}),
    };
  }

  private presign(key: string, now: Date, expiresInSeconds: number): string {
    return presignS3Get({
      objectUrl: objectUrl(this.endpoint, this.bucket, key),
      region: this.options.region,
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      now,
      expiresInSeconds,
    });
  }

  private async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const result = await this.request('PUT', objectUrl(this.endpoint, this.bucket, key), body, contentType, undefined, MAX_ERROR_BYTES);
    if (result.status < 200 || result.status >= 300) throw new Error('Unable to store the Note share.');
  }

  private async deletePrefix(prefix: string): Promise<void> {
    const keys = await this.listKeys(prefix);
    if (keys.length > MAX_DELETE_OBJECTS) throw new Error('The Note share contains too many objects to delete.');
    for (const key of keys) {
      const result = await this.request('DELETE', objectUrl(this.endpoint, this.bucket, key), undefined, undefined, undefined, MAX_ERROR_BYTES);
      if (result.status !== 404 && (result.status < 200 || result.status >= 300)) {
        throw new Error('Unable to delete the Note share.');
      }
    }
  }

  private async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    while (true) {
      const remaining = MAX_DELETE_OBJECTS + 1 - keys.length;
      if (remaining <= 0) throw new Error('The Note share contains too many objects to delete.');
      const result = await this.request('GET', buildS3BucketUrl(this.endpoint, this.bucket), undefined, undefined, {
        'list-type': '2',
        prefix,
        'max-keys': String(Math.min(LIST_PAGE_LIMIT, remaining)),
        ...(continuationToken ? { 'continuation-token': continuationToken } : {}),
      }, MAX_LIST_BODY_BYTES);
      if (result.status < 200 || result.status >= 300) throw new Error('Unable to list Note share objects.');
      const body = result.body.toString('utf8');
      for (const key of xmlValues(body, 'Key')) {
        if (key.startsWith(prefix) && /^[A-Za-z0-9_./-]{1,1024}$/.test(key)) keys.push(key);
        if (keys.length > MAX_DELETE_OBJECTS) throw new Error('The Note share contains too many objects to delete.');
      }
      const truncated = xmlValues(body, 'IsTruncated')[0]?.trim() === 'true';
      if (!truncated) return keys;
      const nextToken = xmlValues(body, 'NextContinuationToken')[0];
      if (!nextToken || nextToken === continuationToken) throw new Error('Unable to list all Note share objects.');
      continuationToken = nextToken;
    }
  }

  private async request(
    method: 'GET' | 'PUT' | 'DELETE',
    url: string,
    body: Buffer | undefined,
    contentType: string | undefined,
    query: Readonly<Record<string, string>> | undefined,
    maximumResponseBytes: number,
  ): Promise<{ status: number; body: Buffer }> {
    const signed = signS3Request({
      method,
      objectUrl: url,
      region: this.options.region,
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      ...(body ? { payload: body } : {}),
      ...(contentType ? { contentType } : {}),
      ...(query ? { query } : {}),
      now: this.now(),
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(signed.url, {
        method,
        headers: signed.headers,
        ...(body ? { body: body as unknown as BodyInit } : {}),
        signal: controller.signal,
        redirect: 'manual',
      });
      const declared = response.headers.get('content-length');
      if (declared && /^\d+$/.test(declared) && Number(declared) > maximumResponseBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('The Note share S3 response is too large.');
      }
      const reader = response.body?.getReader();
      if (!reader) return { status: response.status, body: Buffer.alloc(0) };
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = Buffer.from(chunk.value);
        total += value.byteLength;
        if (total > maximumResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error('The Note share S3 response is too large.');
        }
        chunks.push(value);
      }
      return { status: response.status, body: Buffer.concat(chunks, total) };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('The Note share S3 request timed out.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
