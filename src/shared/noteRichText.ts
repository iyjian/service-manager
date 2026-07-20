import type {
  NoteImageAlignment,
  NoteImageMimeType,
  NoteImageNodeAttributes,
  NoteImageReference,
} from './types';

export type {
  NoteImageAlignment,
  NoteImageMimeType,
  NoteImageNodeAttributes,
  NoteImageReference,
} from './types';

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
  mathCharacters: 2_048,
  imageAltCharacters: 500,
  imageBytes: 10 * 1024 * 1024,
  imageDimension: 8_192,
  imagePixels: 40_000_000,
  tableRows: 1_000,
  tableColumns: 200,
  tableCellWidth: 8_192,
} as const);

export interface RichTextMark {
  type: 'bold' | 'italic' | 'strike' | 'underline' | 'code' | 'link' | 'textStyle' | 'highlight';
  attrs?: Record<string, string>;
}

export interface RichTextNode {
  type: string;
  attrs?: Record<string, unknown> | NoteImageNodeAttributes;
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
  'taskList',
  'taskItem',
  'codeBlock',
  'horizontalRule',
  'text',
  'hardBreak',
  'math',
  's3Image',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
]);
const MARK_ORDER = new Map([
  ['link', 0],
  ['bold', 1],
  ['italic', 2],
  ['underline', 3],
  ['strike', 4],
  ['code', 5],
  ['textStyle', 6],
  ['highlight', 7],
]);
const SIMPLE_MARKS = new Set(['bold', 'italic', 'strike', 'underline', 'code']);
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
  'codeBlock',
  'horizontalRule',
  's3Image',
  'table',
]);
const INLINE_TYPES = new Set(['text', 'hardBreak', 'math']);
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
const NOTE_IMAGE_REFERENCE_KEYS = new Set([
  'objectId',
  'assetKey',
  'ciphertextSha256',
  'contentSha256',
  'mimeType',
  'byteLength',
  'width',
  'height',
  'alt',
]);
const TEXT_STYLE_COLORS = new Set([
  '#9333EA',
  '#E00000',
  '#EAB308',
  '#2563EB',
  '#008A00',
  '#FFA500',
  '#BA4081',
  '#A8A29E',
]);
const HIGHLIGHT_COLORS = new Set([
  '#F3E8FF',
  '#FEE2E2',
  '#FEF9C3',
  '#DBEAFE',
  '#DCFCE7',
  '#FFEDD5',
  '#FCE7F3',
  '#E4E4E7',
]);

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
  assertAllowedKeys(value, NOTE_IMAGE_REFERENCE_KEYS, 'The rich text image reference');

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

/**
 * Validates an image node while keeping its mutable display width outside the
 * immutable S3 reference accepted by the main-process image IPC.
 */
export function parseNoteImageNodeAttributes(value: unknown): NoteImageNodeAttributes {
  if (!isRecord(value)) invalid('The rich text image attributes are invalid.');
  assertAllowedKeys(
    value,
    new Set([...NOTE_IMAGE_REFERENCE_KEYS, 'displayWidth', 'alignment']),
    'The rich text image attributes',
  );
  const referenceValue: Record<string, unknown> = {};
  for (const key of NOTE_IMAGE_REFERENCE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) referenceValue[key] = value[key];
  }
  const reference = parseNoteImageReference(referenceValue);
  const attributes: NoteImageNodeAttributes = { ...reference };
  if (value.displayWidth !== undefined && value.displayWidth !== null) {
    attributes.displayWidth = boundedInteger(
      value.displayWidth,
      48,
      RICH_TEXT_LIMITS.imageDimension,
      'The rich text image display width',
    );
  }
  if (value.alignment !== undefined && value.alignment !== null && value.alignment !== 'left') {
    if (value.alignment !== 'center' && value.alignment !== 'right') {
      invalid('The rich text image alignment is invalid.');
    }
    attributes.alignment = value.alignment as NoteImageAlignment;
  }
  return attributes;
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

function normalizeColorMark(
  value: Record<string, unknown>,
  type: 'textStyle' | 'highlight',
): RichTextMark {
  if (!isRecord(value.attrs)) invalid(`The rich text ${type} attributes are invalid.`);
  assertAllowedKeys(value.attrs, new Set(['color']), `The rich text ${type}`);
  if (typeof value.attrs.color !== 'string') invalid(`The rich text ${type} color is invalid.`);
  const color = value.attrs.color.toUpperCase();
  const allowed = type === 'textStyle' ? TEXT_STYLE_COLORS : HIGHLIGHT_COLORS;
  if (!allowed.has(color)) invalid(`The rich text ${type} color is invalid.`);
  return { type, attrs: { color } };
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
    if (candidate.type === 'textStyle' || candidate.type === 'highlight') {
      marks.push(normalizeColorMark(candidate, candidate.type));
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
  if (parentType === 'taskList') return childType === 'taskItem';
  if (parentType === 'taskItem') return BLOCK_TYPES.has(childType);
  if (parentType === 'paragraph' || parentType === 'heading') {
    return INLINE_TYPES.has(childType);
  }
  if (parentType === 'codeBlock') return childType === 'text';
  if (parentType === 'table') return childType === 'tableRow';
  if (parentType === 'tableRow') return childType === 'tableHeader' || childType === 'tableCell';
  if (parentType === 'tableHeader' || parentType === 'tableCell') {
    return BLOCK_TYPES.has(childType);
  }
  return false;
}

function normalizeTableCellAttributes(value: unknown): Record<string, unknown> {
  if (value !== undefined && !isRecord(value)) {
    invalid('Rich text table cell attributes are invalid.');
  }
  const attributes = value ?? {};
  if (!isRecord(attributes)) invalid('Rich text table cell attributes are invalid.');
  assertAllowedKeys(
    attributes,
    new Set(['colspan', 'rowspan', 'colwidth', 'align']),
    'A rich text table cell',
  );

  const colspan = attributes.colspan === undefined
    ? 1
    : boundedInteger(
      attributes.colspan,
      1,
      RICH_TEXT_LIMITS.tableColumns,
      'The rich text table cell column span',
    );
  const rowspan = attributes.rowspan === undefined
    ? 1
    : boundedInteger(
      attributes.rowspan,
      1,
      RICH_TEXT_LIMITS.tableRows,
      'The rich text table cell row span',
    );

  let colwidth: number[] | null = null;
  if (attributes.colwidth !== undefined && attributes.colwidth !== null) {
    if (!Array.isArray(attributes.colwidth) || attributes.colwidth.length !== colspan) {
      invalid('The rich text table cell column widths are invalid.');
    }
    const widths = attributes.colwidth.map((width) => boundedInteger(
      width,
      0,
      RICH_TEXT_LIMITS.tableCellWidth,
      'A rich text table cell column width',
    ));
    // prosemirror-tables uses zero placeholders for the untouched columns of
    // a spanning cell. An entirely unset vector is equivalent to null.
    if (widths.some((width) => width > 0)) colwidth = widths;
  }

  let align: 'left' | 'center' | 'right' | null = null;
  if (attributes.align !== undefined && attributes.align !== null) {
    if (attributes.align !== 'left' && attributes.align !== 'center' && attributes.align !== 'right') {
      invalid('The rich text table cell alignment is invalid.');
    }
    align = attributes.align;
  }

  return { colspan, rowspan, colwidth, align };
}

function tableCellSpans(node: RichTextNode): { colspan: number; rowspan: number } {
  if (!isRecord(node.attrs)) invalid('Rich text table cell attributes are invalid.');
  return {
    colspan: boundedInteger(
      node.attrs.colspan,
      1,
      RICH_TEXT_LIMITS.tableColumns,
      'The rich text table cell column span',
    ),
    rowspan: boundedInteger(
      node.attrs.rowspan,
      1,
      RICH_TEXT_LIMITS.tableRows,
      'The rich text table cell row span',
    ),
  };
}

/** Rejects malformed span maps before ProseMirror's table plugins can allocate or repair them. */
function validateTableGeometry(rows: RichTextNode[]): void {
  const occupied = Array.from({ length: rows.length }, () => [] as boolean[]);
  let tableWidth: number | undefined;

  for (const [rowIndex, row] of rows.entries()) {
    const cells = row.content ?? [];
    let column = 0;
    for (const cell of cells) {
      while (occupied[rowIndex][column]) column += 1;
      const { colspan, rowspan } = tableCellSpans(cell);
      if (
        column + colspan > RICH_TEXT_LIMITS.tableColumns
        || rowIndex + rowspan > rows.length
      ) {
        invalid('Rich text table cell spans are outside the table.');
      }
      for (let targetRow = rowIndex; targetRow < rowIndex + rowspan; targetRow += 1) {
        for (let targetColumn = column; targetColumn < column + colspan; targetColumn += 1) {
          if (occupied[targetRow][targetColumn]) {
            invalid('Rich text table cell spans overlap.');
          }
          occupied[targetRow][targetColumn] = true;
        }
      }
      column += colspan;
    }

    const rowWidth = occupied[rowIndex].length;
    let rowHasGap = false;
    for (let occupiedColumn = 0; occupiedColumn < rowWidth; occupiedColumn += 1) {
      if (!occupied[rowIndex][occupiedColumn]) {
        rowHasGap = true;
        break;
      }
    }
    if (
      rowWidth < 1
      || rowWidth > RICH_TEXT_LIMITS.tableColumns
      || rowHasGap
    ) {
      invalid('Rich text table rows must form a complete rectangle.');
    }
    if (tableWidth === undefined) tableWidth = rowWidth;
    else if (rowWidth !== tableWidth) invalid('Rich text table rows must have the same width.');
  }
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

  if (type === 'hardBreak') {
    // ProseMirror permits marks on inline leaf nodes. Tiptap's HTML parser
    // emits them for markup such as <strong>before<br>after</strong>, so keep
    // the same strictly validated mark representation used by text nodes.
    assertAllowedKeys(value, new Set(['type', 'marks']), 'A rich text hardBreak node');
    const marks = normalizeMarks(value.marks);
    return { type, ...(marks ? { marks } : {}) };
  }

  if (type === 'horizontalRule') {
    assertAllowedKeys(value, new Set(['type']), 'A rich text horizontalRule node');
    return { type };
  }

  if (type === 'math') {
    assertAllowedKeys(value, new Set(['type', 'attrs']), 'A rich text math node');
    if (!isRecord(value.attrs)) invalid('Rich text math attributes are invalid.');
    assertAllowedKeys(value.attrs, new Set(['latex']), 'A rich text math node');
    if (
      typeof value.attrs.latex !== 'string'
      || !value.attrs.latex
      || value.attrs.latex.length > RICH_TEXT_LIMITS.mathCharacters
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.attrs.latex)
    ) {
      invalid('The rich text math expression is invalid.');
    }
    state.textCharacters += value.attrs.latex.length;
    if (state.textCharacters > RICH_TEXT_LIMITS.textCharacters) {
      invalid('Rich text content contains too much text.');
    }
    return { type, attrs: { latex: value.attrs.latex } };
  }

  if (type === 's3Image') {
    assertAllowedKeys(value, new Set(['type', 'attrs']), 'A rich text image node');
    const attrs = parseNoteImageNodeAttributes(value.attrs);
    if (attrs.alt) {
      state.textCharacters += attrs.alt.length;
      if (state.textCharacters > RICH_TEXT_LIMITS.textCharacters) {
        invalid('Rich text content contains too much text.');
      }
    }
    return { type, attrs };
  }

  if (type === 'table') {
    assertAllowedKeys(value, new Set(['type', 'content']), 'A rich text table node');
    if (
      !Array.isArray(value.content)
      || value.content.length < 1
      || value.content.length > RICH_TEXT_LIMITS.tableRows
    ) {
      invalid('A rich text table must contain a bounded set of rows.');
    }
    const content = normalizeContentArray(value.content, type, depth + 1, state);
    if (!content) invalid('A rich text table must contain a row.');
    validateTableGeometry(content);
    return { type, content };
  }

  if (type === 'tableRow') {
    assertAllowedKeys(value, new Set(['type', 'content']), 'A rich text table row node');
    if (
      value.content !== undefined
      && (!Array.isArray(value.content) || value.content.length > RICH_TEXT_LIMITS.tableColumns)
    ) {
      invalid('A rich text table row must contain a bounded set of cells.');
    }
    const content = normalizeContentArray(value.content, type, depth + 1, state);
    return { type, ...(content ? { content } : {}) };
  }

  if (type === 'tableHeader' || type === 'tableCell') {
    assertAllowedKeys(value, new Set(['type', 'attrs', 'content']), `A rich text ${type} node`);
    const attrs = normalizeTableCellAttributes(value.attrs);
    const content = normalizeContentArray(value.content, type, depth + 1, state);
    if (!content) invalid('A rich text table cell must contain block content.');
    return { type, attrs, content };
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

  if (type === 'taskItem') {
    assertAllowedKeys(value, new Set(['type', 'attrs', 'content']), 'A rich text task item node');
    let checked = false;
    if (value.attrs !== undefined) {
      if (!isRecord(value.attrs)) invalid('Rich text task item attributes are invalid.');
      assertAllowedKeys(value.attrs, new Set(['checked']), 'A rich text task item');
      if (value.attrs.checked !== undefined && typeof value.attrs.checked !== 'boolean') {
        invalid('The rich text task item checked state is invalid.');
      }
      checked = value.attrs.checked === true;
    }
    const content = normalizeContentArray(value.content, type, depth + 1, state);
    if (!content || content[0]?.type !== 'paragraph') {
      invalid('A rich text task item must start with a paragraph.');
    }
    return { type, attrs: { checked }, content };
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
  if ((type === 'blockquote' || type === 'bulletList' || type === 'listItem' || type === 'taskList') && !content) {
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
  if (node.type === 'math') {
    if (isRecord(node.attrs) && typeof node.attrs.latex === 'string') chunks.push(node.attrs.latex);
    return;
  }
  if (node.type === 's3Image') {
    const attrs = parseNoteImageNodeAttributes(node.attrs);
    if (attrs.alt) chunks.push(attrs.alt);
    return;
  }
  if (node.type === 'horizontalRule') {
    chunks.push('\n');
    return;
  }
  if (node.type === 'table') {
    for (const row of node.content ?? []) {
      const cells = row.content ?? [];
      for (const [index, cell] of cells.entries()) {
        const cellChunks: string[] = [];
        for (const child of cell.content ?? []) appendPlainText(child, cellChunks);
        chunks.push(cellChunks.join('').replace(/\n+$/g, ''));
        if (index < cells.length - 1) chunks.push('\t');
      }
      chunks.push('\n');
    }
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
