import type { NoteImageMimeType, NoteImageReference } from './types';

export type { NoteImageMimeType, NoteImageReference } from './types';

export const RICH_TEXT_LIMITS = Object.freeze({
  documentCharacters: 1_048_576,
  textCharacters: 1_000_000,
  nodes: 20_000,
  depth: 64,
  childrenPerNode: 20_000,
  marksPerTextNode: 8,
  linkCharacters: 2_048,
  linkTitleCharacters: 500,
  codeLanguageCharacters: 64,
  imageAltCharacters: 500,
  imageBytes: 10 * 1024 * 1024,
  imageDimension: 8_192,
  imagePixels: 40_000_000,
} as const);

export interface RichTextMark {
  type: 'bold' | 'italic' | 'strike' | 'underline' | 'code' | 'link';
  attrs?: Record<string, string>;
}

export interface RichTextNode {
  type: string;
  attrs?: Record<string, unknown> | NoteImageReference;
  content?: RichTextNode[];
  marks?: RichTextMark[];
  text?: string;
}

export interface RichTextDocument extends RichTextNode {
  type: 'doc';
}

export const EMPTY_RICH_TEXT_CONTENT = '{"type":"doc","content":[{"type":"paragraph"}]}';

const NODE_TYPES = new Set([
  'doc',
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'horizontalRule',
  'text',
  'hardBreak',
  's3Image',
]);
const MARK_ORDER = new Map([
  ['link', 0],
  ['bold', 1],
  ['italic', 2],
  ['underline', 3],
  ['strike', 4],
  ['code', 5],
]);
const SIMPLE_MARKS = new Set(['bold', 'italic', 'strike', 'underline', 'code']);
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'codeBlock',
  'horizontalRule',
  's3Image',
]);
const INLINE_TYPES = new Set(['text', 'hardBreak']);
const IMAGE_MIME_TYPES = new Set<NoteImageMimeType>([
  'image/png',
  'image/jpeg',
  'image/webp',
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
// 32 bytes encode to 43 unpadded base64url characters. The final character
// carries four data bits, so its unused low two bits must be zero.
const ASSET_KEY_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const CODE_LANGUAGE_PATTERN = /^[A-Za-z0-9_+.#-]{1,64}$/;
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:']);

interface ValidationState {
  nodes: number;
  textCharacters: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message = 'Rich text content is invalid.'): never {
  throw new Error(message);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${label} contains an unsupported field.`);
  }
}

function requiredString(
  value: unknown,
  pattern: RegExp,
  label: string,
): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid.`);
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalid(`${label} is invalid.`);
  }
  return Number(value);
}

/** Validates and returns the canonical safe reference stored by an s3Image node. */
export function parseNoteImageReference(value: unknown): NoteImageReference {
  if (!isRecord(value)) invalid('The rich text image reference is invalid.');
  assertAllowedKeys(value, new Set([
    'objectId',
    'assetKey',
    'ciphertextSha256',
    'contentSha256',
    'mimeType',
    'byteLength',
    'width',
    'height',
    'alt',
  ]), 'The rich text image reference');

  const objectId = requiredString(value.objectId, OBJECT_ID_PATTERN, 'The rich text image object identity');
  const assetKey = requiredString(value.assetKey, ASSET_KEY_PATTERN, 'The rich text image asset key');
  const ciphertextSha256 = requiredString(
    value.ciphertextSha256,
    SHA256_PATTERN,
    'The rich text image ciphertext digest',
  );
  const contentSha256 = requiredString(
    value.contentSha256,
    SHA256_PATTERN,
    'The rich text image content digest',
  );
  if (typeof value.mimeType !== 'string' || !IMAGE_MIME_TYPES.has(value.mimeType as NoteImageMimeType)) {
    invalid('The rich text image MIME type is invalid.');
  }
  const byteLength = boundedInteger(value.byteLength, 1, RICH_TEXT_LIMITS.imageBytes, 'The rich text image size');
  const width = boundedInteger(value.width, 1, RICH_TEXT_LIMITS.imageDimension, 'The rich text image width');
  const height = boundedInteger(value.height, 1, RICH_TEXT_LIMITS.imageDimension, 'The rich text image height');
  if (width * height > RICH_TEXT_LIMITS.imagePixels) {
    invalid('The rich text image dimensions are too large.');
  }
  let alt: string | undefined;
  if (value.alt !== undefined && value.alt !== null) {
    if (typeof value.alt !== 'string' || value.alt.length > RICH_TEXT_LIMITS.imageAltCharacters) {
      invalid('The rich text image alternative text is invalid.');
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.alt)) {
      invalid('The rich text image alternative text is invalid.');
    }
    if (value.alt) alt = value.alt;
  }
  return {
    objectId,
    assetKey,
    ciphertextSha256,
    contentSha256,
    mimeType: value.mimeType as NoteImageMimeType,
    byteLength,
    width,
    height,
    ...(alt !== undefined ? { alt } : {}),
  };
}

function normalizeSafeLink(value: unknown): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > RICH_TEXT_LIMITS.linkCharacters
    || /[\u0000-\u0020\u007f]/.test(value)
    || value.includes('\\')
    || !/^https?:\/\//i.test(value)
  ) {
    invalid('The rich text link is invalid.');
  }
  const href = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    invalid('The rich text link is invalid.');
  }
  if (!SAFE_LINK_PROTOCOLS.has(parsed.protocol.toLocaleLowerCase())) {
    invalid('The rich text link protocol is not supported.');
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    invalid('The rich text link is invalid.');
  }
  return href;
}

/** Matches the exact absolute-link policy used by the renderer's Tiptap Link extension. */
export function isAllowedRichTextLinkHref(value: unknown): value is string {
  try {
    normalizeSafeLink(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeLinkMark(value: Record<string, unknown>): RichTextMark {
  if (!isRecord(value.attrs)) invalid('The rich text link attributes are invalid.');
  assertAllowedKeys(value.attrs, new Set(['href', 'target', 'rel', 'title']), 'The rich text link');
  const href = normalizeSafeLink(value.attrs.href);
  let target = '_blank';
  if (value.attrs.target !== undefined && value.attrs.target !== null) {
    if (value.attrs.target !== '_blank') {
      invalid('The rich text link target is invalid.');
    }
    target = value.attrs.target;
  }
  let rel = 'nofollow noopener noreferrer';
  if (value.attrs.rel !== undefined && value.attrs.rel !== null) {
    if (typeof value.attrs.rel !== 'string') invalid('The rich text link relationship is invalid.');
    const tokens = [...new Set(value.attrs.rel.trim().split(/\s+/).filter(Boolean))].sort();
    if (tokens.some((token) => !['nofollow', 'noopener', 'noreferrer'].includes(token))) {
      invalid('The rich text link relationship is invalid.');
    }
    if (target === '_blank') {
      tokens.push('noopener', 'noreferrer');
    }
    rel = [...new Set(tokens)].sort().join(' ');
  }
  let title: string | undefined;
  if (value.attrs.title !== undefined && value.attrs.title !== null) {
    if (
      typeof value.attrs.title !== 'string'
      || value.attrs.title.length > RICH_TEXT_LIMITS.linkTitleCharacters
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.attrs.title)
    ) {
      invalid('The rich text link title is invalid.');
    }
    if (value.attrs.title) title = value.attrs.title;
  }
  return {
    type: 'link',
    attrs: {
      href,
      target,
      rel,
      ...(title ? { title } : {}),
    },
  };
}

function normalizeMarks(value: unknown): RichTextMark[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > RICH_TEXT_LIMITS.marksPerTextNode) {
    invalid('The rich text marks are invalid.');
  }
  const marks: RichTextMark[] = [];
  const types = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.type !== 'string') invalid('A rich text mark is invalid.');
    assertAllowedKeys(candidate, new Set(['type', 'attrs']), 'A rich text mark');
    if (types.has(candidate.type)) invalid('Rich text marks contain a duplicate.');
    types.add(candidate.type);
    if (candidate.type === 'link') {
      marks.push(normalizeLinkMark(candidate));
      continue;
    }
    if (!SIMPLE_MARKS.has(candidate.type)) invalid('A rich text mark is not supported.');
    if (candidate.attrs !== undefined && candidate.attrs !== null) {
      if (!isRecord(candidate.attrs) || Object.keys(candidate.attrs).length > 0) {
        invalid('A rich text mark contains unsupported attributes.');
      }
    }
    marks.push({ type: candidate.type as RichTextMark['type'] });
  }
  if (types.has('code') && types.size > 1) {
    invalid('The rich text code mark cannot be combined with another mark.');
  }
  marks.sort((left, right) => (MARK_ORDER.get(left.type) ?? 99) - (MARK_ORDER.get(right.type) ?? 99));
  return marks.length > 0 ? marks : undefined;
}

function normalizeContentArray(
  value: unknown,
  parentType: string,
  depth: number,
  state: ValidationState,
): RichTextNode[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > RICH_TEXT_LIMITS.childrenPerNode) {
    invalid('Rich text child nodes are invalid.');
  }
  const content: RichTextNode[] = [];
  for (const candidate of value) {
    const node = normalizeNode(candidate, parentType, depth, state);
    const previous = content[content.length - 1];
    if (
      previous?.type === 'text'
      && node.type === 'text'
      && JSON.stringify(previous.marks ?? []) === JSON.stringify(node.marks ?? [])
    ) {
      previous.text = `${previous.text ?? ''}${node.text ?? ''}`;
    } else {
      content.push(node);
    }
  }
  return content.length > 0 ? content : undefined;
}

function isAllowedChild(parentType: string, childType: string): boolean {
  if (parentType === 'doc' || parentType === 'blockquote' || parentType === 'listItem') {
    return BLOCK_TYPES.has(childType);
  }
  if (parentType === 'bulletList' || parentType === 'orderedList') return childType === 'listItem';
  if (parentType === 'paragraph' || parentType === 'heading') {
    return INLINE_TYPES.has(childType);
  }
  if (parentType === 'codeBlock') return childType === 'text';
  return false;
}

function normalizeNode(
  value: unknown,
  parentType: string | null,
  depth: number,
  state: ValidationState,
): RichTextNode {
  if (depth > RICH_TEXT_LIMITS.depth) invalid('Rich text content is nested too deeply.');
  state.nodes += 1;
  if (state.nodes > RICH_TEXT_LIMITS.nodes) invalid('Rich text content contains too many nodes.');
  if (!isRecord(value) || typeof value.type !== 'string' || !NODE_TYPES.has(value.type)) {
    invalid('A rich text node is not supported.');
  }
  const type = value.type;
  if (parentType === null ? type !== 'doc' : !isAllowedChild(parentType, type)) {
    invalid('A rich text node appears in an invalid location.');
  }

  if (type === 'text') {
    assertAllowedKeys(value, new Set(['type', 'text', 'marks']), 'A rich text text node');
    if (typeof value.text !== 'string' || !value.text) invalid('A rich text text node is invalid.');
    state.textCharacters += value.text.length;
    if (state.textCharacters > RICH_TEXT_LIMITS.textCharacters) {
      invalid('Rich text content contains too much text.');
    }
    const marks = normalizeMarks(value.marks);
    if (parentType === 'codeBlock' && marks !== undefined) {
      invalid('Code block text cannot contain marks.');
    }
    return { type, ...(marks ? { marks } : {}), text: value.text };
  }

  if (type === 'hardBreak' || type === 'horizontalRule') {
    assertAllowedKeys(value, new Set(['type']), `A rich text ${type} node`);
    return { type };
  }

  if (type === 's3Image') {
    assertAllowedKeys(value, new Set(['type', 'attrs']), 'A rich text image node');
    const attrs = parseNoteImageReference(value.attrs);
    if (attrs.alt) {
      state.textCharacters += attrs.alt.length;
      if (state.textCharacters > RICH_TEXT_LIMITS.textCharacters) {
        invalid('Rich text content contains too much text.');
      }
    }
    return { type, attrs };
  }

  if (type === 'heading') {
    assertAllowedKeys(value, new Set(['type', 'attrs', 'content']), 'A rich text heading node');
    if (!isRecord(value.attrs)) invalid('Rich text heading attributes are invalid.');
    assertAllowedKeys(value.attrs, new Set(['level']), 'A rich text heading');
    const level = boundedInteger(value.attrs.level, 1, 6, 'The rich text heading level');
    const content = normalizeContentArray(value.content, type, depth + 1, state);
    return { type, attrs: { level }, ...(content ? { content } : {}) };
  }

  if (type === 'orderedList') {
    assertAllowedKeys(value, new Set(['type', 'attrs', 'content']), 'A rich text ordered list node');
    let start = 1;
    let listType: string | undefined;
    if (value.attrs !== undefined) {
      if (!isRecord(value.attrs)) invalid('Rich text ordered list attributes are invalid.');
      assertAllowedKeys(value.attrs, new Set(['start', 'type']), 'A rich text ordered list');
      if (value.attrs.start !== undefined && value.attrs.start !== null) {
        start = boundedInteger(value.attrs.start, 1, 1_000_000, 'The rich text ordered list start');
      }
      if (value.attrs.type !== undefined && value.attrs.type !== null) {
        if (!['1', 'a', 'A', 'i', 'I'].includes(String(value.attrs.type))) {
          invalid('The rich text ordered list type is invalid.');
        }
        listType = String(value.attrs.type);
      }
    }
    const content = normalizeContentArray(value.content, type, depth + 1, state);
    if (!content) invalid('A rich text ordered list must contain a list item.');
    return {
      type,
      attrs: { start, ...(listType ? { type: listType } : {}) },
      content,
    };
  }

  if (type === 'codeBlock') {
    assertAllowedKeys(value, new Set(['type', 'attrs', 'content']), 'A rich text code block node');
    let language: string | undefined;
    if (value.attrs !== undefined) {
      if (!isRecord(value.attrs)) invalid('Rich text code block attributes are invalid.');
      assertAllowedKeys(value.attrs, new Set(['language']), 'A rich text code block');
      if (value.attrs.language !== undefined && value.attrs.language !== null) {
        language = requiredString(
          value.attrs.language,
          CODE_LANGUAGE_PATTERN,
          'The rich text code block language',
        );
      }
    }
    const content = normalizeContentArray(value.content, type, depth + 1, state);
    return {
      type,
      ...(language ? { attrs: { language } } : {}),
      ...(content ? { content } : {}),
    };
  }

  assertAllowedKeys(value, new Set(['type', 'content']), `A rich text ${type} node`);
  const content = normalizeContentArray(value.content, type, depth + 1, state);
  if ((type === 'blockquote' || type === 'bulletList' || type === 'listItem') && !content) {
    invalid(`A rich text ${type} must contain child content.`);
  }
  if (type === 'listItem' && content?.[0]?.type !== 'paragraph') {
    invalid('A rich text list item must start with a paragraph.');
  }
  if (type === 'doc' && !content) {
    return { type, content: [{ type: 'paragraph' }] };
  }
  return { type, ...(content ? { content } : {}) };
}

/** Parses JSON or an object and returns a detached, safe, canonical document value. */
export function parseRichTextContent(value: unknown): RichTextDocument {
  let candidate = value;
  if (typeof value === 'string') {
    if (!value.trim()) candidate = JSON.parse(EMPTY_RICH_TEXT_CONTENT) as unknown;
    else {
      if (value.length > RICH_TEXT_LIMITS.documentCharacters) {
        invalid('Rich text content is too large.');
      }
      try {
        candidate = JSON.parse(value) as unknown;
      } catch {
        invalid('Rich text content is not valid JSON.');
      }
    }
  }
  const state: ValidationState = { nodes: 0, textCharacters: 0 };
  const document = normalizeNode(candidate, null, 1, state) as RichTextDocument;
  const serialized = JSON.stringify(document);
  if (serialized.length > RICH_TEXT_LIMITS.documentCharacters) invalid('Rich text content is too large.');
  return document;
}

/** Returns the one canonical JSON representation stored in Note.content. */
export function normalizeRichTextContent(value: unknown): string {
  return JSON.stringify(parseRichTextContent(value));
}

function appendPlainText(node: RichTextNode, chunks: string[]): void {
  if (node.type === 'text') {
    chunks.push(node.text ?? '');
    return;
  }
  if (node.type === 'hardBreak') {
    chunks.push('\n');
    return;
  }
  if (node.type === 's3Image') {
    const attrs = parseNoteImageReference(node.attrs);
    if (attrs.alt) chunks.push(attrs.alt);
    return;
  }
  if (node.type === 'horizontalRule') {
    chunks.push('\n');
    return;
  }
  for (const child of node.content ?? []) appendPlainText(child, chunks);
  if (BLOCK_TYPES.has(node.type) || node.type === 'listItem') chunks.push('\n');
}

/** Extracts bounded searchable/copyable plain text without interpreting HTML. */
export function extractRichTextPlainText(value: unknown): string {
  const document = parseRichTextContent(value);
  const chunks: string[] = [];
  appendPlainText(document, chunks);
  return chunks.join('').replace(/\n{3,}/g, '\n\n').trim();
}
