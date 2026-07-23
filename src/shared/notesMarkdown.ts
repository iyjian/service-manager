export type MarkdownFormatCommand =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'link'
  | 'inlineCode'
  | 'inline-code'
  | 'heading'
  | 'quote'
  | 'bullet'
  | 'numbered'
  | 'task'
  | 'table'
  | 'hr';

export interface MarkdownSelection {
  from: number;
  to: number;
}

export interface MarkdownTextChange {
  from: number;
  to: number;
  insert: string;
}

export interface MarkdownFormatOptions {
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  linkUrl?: string;
  linkLabel?: string;
  tableColumns?: number;
  tableRows?: number;
}

export interface MarkdownFormatEdit {
  markdown: string;
  change: MarkdownTextChange;
  selection: MarkdownSelection;
}

export interface MarkdownOutlineHeading {
  id: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  line: number;
  offset: number;
}

export interface MarkdownDocumentStats {
  words: number;
  lines: number;
  characters: number;
  charactersWithoutSpaces: number;
}

interface MarkdownSourceLine {
  text: string;
  offset: number;
}

interface MarkdownListMarker {
  indent: number;
  markerLength: number;
  ordered: boolean;
  order: number;
  content: string;
}

interface MarkdownTableData {
  headers: string[];
  alignments: Array<'left' | 'center' | 'right' | undefined>;
}

interface MarkdownRenderContext {
  headingIds: Map<string, number>;
}

const MAX_LINK_CHARACTERS = 2_048;
const MAX_INLINE_DEPTH = 16;
const MAX_BLOCK_DEPTH = 24;
const MAX_FILENAME_CHARACTERS = 120;
const MAX_FILENAME_UTF8_BYTES = 255;
const WINDOWS_RESERVED_FILENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const BIDI_CONTROL_CHARACTERS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    const characterBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function clampOffset(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(length, Math.trunc(value)));
}

function normalizeSelection(markdown: string, selection: MarkdownSelection): MarkdownSelection {
  const first = clampOffset(selection.from, markdown.length);
  const second = clampOffset(selection.to, markdown.length);
  return first <= second ? { from: first, to: second } : { from: second, to: first };
}

function editMarkdown(
  markdown: string,
  change: MarkdownTextChange,
  selection: MarkdownSelection,
): MarkdownFormatEdit {
  return {
    markdown: `${markdown.slice(0, change.from)}${change.insert}${markdown.slice(change.to)}`,
    change,
    selection,
  };
}

function wrapInlineSelection(
  markdown: string,
  selection: MarkdownSelection,
  opening: string,
  closing: string,
  placeholder: string,
): MarkdownFormatEdit {
  const selected = markdown.slice(selection.from, selection.to);

  if (selected.startsWith(opening)
    && selected.endsWith(closing)
    && selected.length >= opening.length + closing.length) {
    const inner = selected.slice(opening.length, selected.length - closing.length);
    return editMarkdown(markdown, {
      from: selection.from,
      to: selection.to,
      insert: inner,
    }, {
      from: selection.from,
      to: selection.from + inner.length,
    });
  }

  if (selection.from >= opening.length
    && markdown.slice(selection.from - opening.length, selection.from) === opening
    && markdown.slice(selection.to, selection.to + closing.length) === closing) {
    return editMarkdown(markdown, {
      from: selection.from - opening.length,
      to: selection.to + closing.length,
      insert: selected,
    }, {
      from: selection.from - opening.length,
      to: selection.to - opening.length,
    });
  }

  const inner = selected || placeholder;
  const insert = `${opening}${inner}${closing}`;
  return editMarkdown(markdown, {
    from: selection.from,
    to: selection.to,
    insert,
  }, {
    from: selection.from + opening.length,
    to: selection.from + opening.length + inner.length,
  });
}

function backtickFenceFor(value: string): string {
  let longest = 0;
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(longest + 1);
}

function formatInlineCode(
  markdown: string,
  selection: MarkdownSelection,
): MarkdownFormatEdit {
  const selected = markdown.slice(selection.from, selection.to);
  const value = selected || 'code';
  const fence = backtickFenceFor(value);
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  const insert = `${fence}${padding}${value}${padding}${fence}`;
  return editMarkdown(markdown, {
    from: selection.from,
    to: selection.to,
    insert,
  }, {
    from: selection.from + fence.length + padding.length,
    to: selection.from + fence.length + padding.length + value.length,
  });
}

/** Returns a canonical absolute HTTP(S) URL, or undefined for unsafe/relative URLs. */
export function safeMarkdownHttpUrl(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_LINK_CHARACTERS || /[\u0000-\u001f\u007f]/.test(candidate)) {
    return undefined;
  }
  try {
    const parsed = new URL(candidate);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || !parsed.hostname
      || parsed.username
      || parsed.password) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, '\\$1');
}

function formatMarkdownLink(
  markdown: string,
  selection: MarkdownSelection,
  options: MarkdownFormatOptions,
): MarkdownFormatEdit {
  const selected = markdown.slice(selection.from, selection.to);
  const existing = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(selected);
  if (existing) {
    return editMarkdown(markdown, {
      from: selection.from,
      to: selection.to,
      insert: existing[1],
    }, {
      from: selection.from,
      to: selection.from + existing[1].length,
    });
  }

  const selectedUrl = safeMarkdownHttpUrl(selected);
  const suppliedUrl = options.linkUrl ? safeMarkdownHttpUrl(options.linkUrl) : undefined;
  const label = escapeMarkdownLinkLabel(
    options.linkLabel?.trim() || (selectedUrl ? selected : selected || 'link text'),
  );
  const url = suppliedUrl ?? selectedUrl ?? 'https://';
  const insert = `[${label}](${url})`;
  const selectUrl = !suppliedUrl && !selectedUrl;
  return editMarkdown(markdown, {
    from: selection.from,
    to: selection.to,
    insert,
  }, selectUrl ? {
    from: selection.from + label.length + 3,
    to: selection.from + label.length + 3 + url.length,
  } : {
    from: selection.from + 1,
    to: selection.from + 1 + label.length,
  });
}

function selectedLineRange(markdown: string, selection: MarkdownSelection): MarkdownSelection {
  const from = markdown.lastIndexOf('\n', Math.max(0, selection.from - 1)) + 1;
  const effectiveTo = selection.to > selection.from && markdown[selection.to - 1] === '\n'
    ? selection.to - 1
    : selection.to;
  const nextBreak = markdown.indexOf('\n', effectiveTo);
  return { from, to: nextBreak < 0 ? markdown.length : nextBreak };
}

function lineIndentAndContent(line: string): { indent: string; content: string } {
  const match = /^(\s*)(.*)$/.exec(line);
  return { indent: match?.[1] ?? '', content: match?.[2] ?? line };
}

function lineHasPrefix(command: MarkdownFormatCommand, content: string, headingLevel: number): boolean {
  switch (command) {
    case 'heading': return new RegExp(`^#{${headingLevel}}(?:\\s+|$)`).test(content);
    case 'quote': return /^>\s?/.test(content);
    case 'bullet': return /^[-+*]\s+/.test(content) && !/^-\s+\[[ xX]\]\s+/.test(content);
    case 'numbered': return /^\d{1,9}[.)]\s+/.test(content);
    case 'task': return /^[-+*]\s+\[[ xX]\]\s+/.test(content);
    default: return false;
  }
}

function stripListPrefix(content: string): string {
  return content.replace(/^(?:[-+*]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)/, '');
}

function formatSelectedLines(
  markdown: string,
  selection: MarkdownSelection,
  command: MarkdownFormatCommand,
  options: MarkdownFormatOptions,
): MarkdownFormatEdit {
  const range = selectedLineRange(markdown, selection);
  const lines = markdown.slice(range.from, range.to).split('\n');
  const headingLevel = boundedInteger(options.headingLevel, 2, 1, 6);
  const nonEmpty = lines.map(lineIndentAndContent).filter(({ content }) => content.length > 0);
  const removePrefix = nonEmpty.length > 0
    && nonEmpty.every(({ content }) => lineHasPrefix(command, content, headingLevel));
  let orderedIndex = 1;
  const replacement = lines.map((line) => {
    const { indent, content } = lineIndentAndContent(line);
    if (!content) return line;
    if (removePrefix) {
      switch (command) {
        case 'heading': return `${indent}${content.replace(/^#{1,6}(?:\s+|$)/, '')}`;
        case 'quote': return `${indent}${content.replace(/^>\s?/, '')}`;
        case 'bullet': return `${indent}${content.replace(/^[-+*]\s+/, '')}`;
        case 'numbered': return `${indent}${content.replace(/^\d{1,9}[.)]\s+/, '')}`;
        case 'task': return `${indent}${content.replace(/^[-+*]\s+\[[ xX]\]\s+/, '')}`;
        default: return line;
      }
    }
    switch (command) {
      case 'heading': return `${indent}${'#'.repeat(headingLevel)} ${content.replace(/^#{1,6}(?:\s+|$)/, '')}`;
      case 'quote': return `${indent}> ${content}`;
      case 'bullet': return `${indent}- ${stripListPrefix(content)}`;
      case 'numbered': return `${indent}${orderedIndex++}. ${stripListPrefix(content)}`;
      case 'task': return `${indent}- [ ] ${stripListPrefix(content)}`;
      default: return line;
    }
  }).join('\n');

  return editMarkdown(markdown, {
    from: range.from,
    to: range.to,
    insert: replacement,
  }, {
    from: range.from,
    to: range.from + replacement.length,
  });
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value as number)));
}

function insertMarkdownBlock(
  markdown: string,
  selection: MarkdownSelection,
  block: string,
  selectedWithinBlock?: MarkdownSelection,
): MarkdownFormatEdit {
  const needsLeadingBreak = selection.from > 0 && markdown[selection.from - 1] !== '\n';
  const needsTrailingBreak = selection.to < markdown.length && markdown[selection.to] !== '\n';
  const prefix = needsLeadingBreak ? '\n\n' : '';
  const suffix = needsTrailingBreak ? '\n\n' : '';
  const insert = `${prefix}${block}${suffix}`;
  const localSelection = selectedWithinBlock ?? { from: 0, to: block.length };
  return editMarkdown(markdown, {
    from: selection.from,
    to: selection.to,
    insert,
  }, {
    from: selection.from + prefix.length + localSelection.from,
    to: selection.from + prefix.length + localSelection.to,
  });
}

function formatMarkdownTable(
  markdown: string,
  selection: MarkdownSelection,
  options: MarkdownFormatOptions,
): MarkdownFormatEdit {
  const columns = boundedInteger(options.tableColumns, 3, 2, 8);
  const rows = boundedInteger(options.tableRows, 2, 1, 20);
  const selected = markdown.slice(selection.from, selection.to).trim().replace(/\s+/g, ' ');
  const firstHeader = selected || 'Column 1';
  const headers = Array.from({ length: columns }, (_, index) => index === 0 ? firstHeader : `Column ${index + 1}`);
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...Array.from({ length: rows }, () => `| ${headers.map(() => '').join(' | ')} |`),
  ];
  const block = lines.join('\n');
  return insertMarkdownBlock(markdown, selection, block, {
    from: 2,
    to: 2 + firstHeader.length,
  });
}

/**
 * Builds one CodeMirror-friendly Markdown edit. `change` is the minimal range to
 * dispatch and `selection` is expressed in the resulting document.
 */
export function applyMarkdownFormat(
  markdown: string,
  inputSelection: MarkdownSelection,
  command: MarkdownFormatCommand,
  options: MarkdownFormatOptions = {},
): MarkdownFormatEdit {
  const selection = normalizeSelection(markdown, inputSelection);
  switch (command) {
    case 'bold': return wrapInlineSelection(markdown, selection, '**', '**', 'bold text');
    case 'italic': return wrapInlineSelection(markdown, selection, '*', '*', 'italic text');
    case 'strike': return wrapInlineSelection(markdown, selection, '~~', '~~', 'strikethrough');
    case 'link': return formatMarkdownLink(markdown, selection, options);
    case 'inlineCode':
    case 'inline-code': return formatInlineCode(markdown, selection);
    case 'heading':
    case 'quote':
    case 'bullet':
    case 'numbered':
    case 'task': return formatSelectedLines(markdown, selection, command, options);
    case 'table': return formatMarkdownTable(markdown, selection, options);
    case 'hr': return insertMarkdownBlock(markdown, selection, '---');
  }
}

export const formatMarkdownSelection = applyMarkdownFormat;

function splitSourceLines(markdown: string): MarkdownSourceLine[] {
  if (!markdown) return [];
  const lines: MarkdownSourceLine[] = [];
  let offset = 0;
  while (offset <= markdown.length) {
    const newline = markdown.indexOf('\n', offset);
    const end = newline < 0 ? markdown.length : newline;
    let text = markdown.slice(offset, end);
    if (text.endsWith('\r')) text = text.slice(0, -1);
    lines.push({ text, offset });
    if (newline < 0) break;
    offset = newline + 1;
  }
  return lines;
}

function fenceOpening(line: string): { marker: '`' | '~'; length: number; info: string } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return undefined;
  return { marker: match[1][0] as '`' | '~', length: match[1].length, info: match[2].trim() };
}

function isFenceClosing(line: string, opening: { marker: '`' | '~'; length: number }): boolean {
  const trimmed = line.trim();
  if (trimmed.length < opening.length || trimmed[0] !== opening.marker) return false;
  return trimmed.split('').every((character) => character === opening.marker);
}

function parseAtxHeading(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | undefined {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(line);
  if (!match) return undefined;
  const text = (match[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
  return { level: match[1].length as 1 | 2 | 3 | 4 | 5 | 6, text };
}

function setextHeadingLevel(line: string): 1 | 2 | undefined {
  if (/^ {0,3}=+[ \t]*$/.test(line)) return 1;
  if (/^ {0,3}-+[ \t]*$/.test(line)) return 2;
  return undefined;
}

function plainInlineText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<((?:https?):\/\/[^>]+)>/gi, '$1')
    .replace(/(`+)([\s\S]*?)\1/g, '$2')
    .replace(/\\([\\`*{}\[\]()#+\-.!_>~|])/g, '$1')
    .replace(/(?:\*\*|__|~~|[*_])/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function headingSlug(value: string): string {
  const slug = value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
  return slug || 'section';
}

function nextHeadingId(value: string, ids: Map<string, number>): string {
  const base = headingSlug(value);
  const occurrence = ids.get(base) ?? 0;
  ids.set(base, occurrence + 1);
  return occurrence === 0 ? base : `${base}-${occurrence}`;
}

function outlineBlockContent(line: string): string {
  let content = line;
  for (let depth = 0; depth < MAX_BLOCK_DEPTH; depth += 1) {
    const quote = /^ {0,3}> ?(.*)$/.exec(content);
    if (quote) {
      content = quote[1];
      continue;
    }
    const list = /^ {0,3}(?:[-+*]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(content);
    if (list) {
      content = list[1];
      continue;
    }
    break;
  }
  return content;
}

/** Extracts ATX and Setext headings while ignoring fenced code blocks. */
export function extractMarkdownOutline(markdown: string): MarkdownOutlineHeading[] {
  const lines = splitSourceLines(markdown);
  const result: MarkdownOutlineHeading[] = [];
  const ids = new Map<string, number>();
  let activeFence: ReturnType<typeof fenceOpening>;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const content = outlineBlockContent(line.text);
    if (activeFence) {
      if (isFenceClosing(content, activeFence)) activeFence = undefined;
      continue;
    }
    activeFence = fenceOpening(content);
    if (activeFence) continue;

    const atx = parseAtxHeading(content);
    if (atx) {
      const text = plainInlineText(atx.text);
      if (text) result.push({
        id: nextHeadingId(text, ids),
        level: atx.level,
        text,
        line: index + 1,
        offset: line.offset,
      });
      continue;
    }
    const nextLine = lines[index + 1];
    const level = nextLine ? setextHeadingLevel(outlineBlockContent(nextLine.text)) : undefined;
    const text = plainInlineText(content);
    if (level && text) {
      result.push({
        id: nextHeadingId(text, ids),
        level,
        text,
        line: index + 1,
        offset: line.offset,
      });
      index += 1;
    }
  }
  return result;
}

/** Returns readable Markdown text without executing or interpreting raw HTML. */
export function markdownToPlainText(markdown: string): string {
  const lines = splitSourceLines(markdown);
  const output: string[] = [];
  let activeFence: ReturnType<typeof fenceOpening>;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].text;
    if (activeFence) {
      if (isFenceClosing(line, activeFence)) activeFence = undefined;
      else output.push(line);
      continue;
    }
    activeFence = fenceOpening(line);
    if (activeFence) continue;
    if (isHorizontalRule(line) || isTableDelimiterLine(line)) continue;
    if (setextHeadingLevel(line)) continue;
    const withoutBlockMarkers = line
      .replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, '')
      .replace(/^\s*\|?/, '')
      .replace(/\|?\s*$/, '')
      .replace(/\s*\|\s*/g, ' ');
    output.push(plainInlineText(withoutBlockMarkers));
  }
  return output.join('\n').trim();
}

/** Word/character counts describe readable content; lines describe source lines. */
export function getMarkdownStats(markdown: string): MarkdownDocumentStats {
  const plainText = markdownToPlainText(markdown);
  const han = plainText.match(/\p{Script=Han}/gu)?.length ?? 0;
  const nonHan = plainText.replace(/\p{Script=Han}/gu, ' ');
  const otherWords = nonHan.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  return {
    words: han + otherWords,
    lines: markdown ? splitSourceLines(markdown).length : 0,
    characters: Array.from(plainText).length,
    charactersWithoutSpaces: Array.from(plainText.replace(/\s/gu, '')).length,
  };
}

export const calculateMarkdownStats = getMarkdownStats;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function findUnescaped(value: string, token: string, from: number): number {
  let offset = value.indexOf(token, from);
  while (offset >= 0) {
    let slashes = 0;
    for (let index = offset - 1; index >= 0 && value[index] === '\\'; index -= 1) slashes += 1;
    if (slashes % 2 === 0) return offset;
    offset = value.indexOf(token, offset + token.length);
  }
  return -1;
}

function inlineLinkAt(
  value: string,
  offset: number,
  image: boolean,
): { label: string; destination: string; end: number } | undefined {
  const labelStart = offset + (image ? 2 : 1);
  let labelEnd = -1;
  // Nested labels are outside this deliberately small preview dialect. Failing
  // at the next opener also prevents malformed repeated `[x](` input from
  // rescanning the complete remaining source for every possible link.
  for (let cursor = labelStart; cursor < value.length; cursor += 1) {
    if (value[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (value[cursor] === '[' || value[cursor] === '\n' || value[cursor] === '\r') return undefined;
    if (value[cursor] === ']') {
      labelEnd = cursor;
      break;
    }
  }
  if (labelEnd < 0 || value[labelEnd + 1] !== '(') return undefined;
  let depth = 0;
  let end = labelEnd + 2;
  for (; end < value.length; end += 1) {
    if (value[end] === '\\') {
      end += 1;
      continue;
    }
    if (value[end] === '(') depth += 1;
    if (value[end] === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    if ((value[end] === '[' || value[end] === '\n' || value[end] === '\r') && depth === 0) {
      return undefined;
    }
  }
  if (end >= value.length) return undefined;
  const body = value.slice(labelEnd + 2, end).trim();
  let destination = body;
  if (destination.startsWith('<')) {
    const closing = destination.indexOf('>');
    if (closing < 0) return undefined;
    destination = destination.slice(1, closing);
  } else {
    const title = /\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/.exec(destination);
    if (title) destination = destination.slice(0, title.index);
  }
  return { label: value.slice(labelStart, labelEnd), destination, end: end + 1 };
}

function remoteImagePlaceholder(label: string): string {
  const text = plainInlineText(label).slice(0, 300) || 'Image';
  const accessible = escapeHtml(`Remote image not loaded: ${text}`);
  return `<span class="markdown-image-placeholder" role="img" aria-label="${accessible}">`
    + '<span class="markdown-image-placeholder-icon" aria-hidden="true">&#128444;</span>'
    + `<span class="markdown-image-placeholder-name">${escapeHtml(text)}</span>`
    + '<span class="markdown-image-placeholder-status">Remote image not loaded</span>'
    + '</span>';
}

function renderInline(value: string, depth = 0): string {
  if (!value) return '';
  if (depth >= MAX_INLINE_DEPTH) return escapeHtml(value);
  let output = '';
  let index = 0;
  let nextAngleClose = value.indexOf('>');
  while (index < value.length) {
    if (value[index] === '\\' && index + 1 < value.length
      && /[\\`*{}\[\]()#+\-.!_>~|]/.test(value[index + 1])) {
      output += escapeHtml(value[index + 1]);
      index += 2;
      continue;
    }

    if (value[index] === '`') {
      let fenceLength = 1;
      while (value[index + fenceLength] === '`') fenceLength += 1;
      const fence = '`'.repeat(fenceLength);
      const end = findUnescaped(value, fence, index + fenceLength);
      if (end >= 0) {
        let code = value.slice(index + fenceLength, end).replace(/\n/g, ' ');
        if (/^\s[\s\S]*\s$/.test(code) && /\S/.test(code)) code = code.slice(1, -1);
        output += `<code>${escapeHtml(code)}</code>`;
        index = end + fenceLength;
        continue;
      }
    }

    if (value.startsWith('![', index)) {
      const image = inlineLinkAt(value, index, true);
      if (image) {
        output += remoteImagePlaceholder(image.label);
        index = image.end;
        continue;
      }
    }

    if (value[index] === '[') {
      const link = inlineLinkAt(value, index, false);
      if (link) {
        const label = renderInline(link.label, depth + 1);
        const href = safeMarkdownHttpUrl(link.destination.replace(/\\([()])/g, '$1'));
        output += href
          ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${label}</a>`
          : label;
        index = link.end;
        continue;
      }
    }

    if (value[index] === '<') {
      while (nextAngleClose >= 0 && nextAngleClose <= index) {
        nextAngleClose = value.indexOf('>', nextAngleClose + 1);
      }
      const nestedOpen = value.indexOf('<', index + 1);
      const end = nextAngleClose;
      if (end >= 0 && (nestedOpen < 0 || nestedOpen > end)) {
        const candidate = value.slice(index + 1, end);
        const href = safeMarkdownHttpUrl(candidate);
        if (href) {
          output += `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(candidate)}</a>`;
          index = end + 1;
          continue;
        }
      }
    }

    const pairedMarkers: ReadonlyArray<readonly [string, string]> = [
      ['**', 'strong'],
      ['__', 'strong'],
      ['~~', 'del'],
      ['*', 'em'],
      ['_', 'em'],
    ];
    let renderedMarker = false;
    for (const [marker, tag] of pairedMarkers) {
      if (!value.startsWith(marker, index)
        || !value[index + marker.length]
        || /\s/.test(value[index + marker.length])) continue;
      if (marker === '_' && index > 0 && /[\p{L}\p{N}]/u.test(value[index - 1])) continue;
      const end = findUnescaped(value, marker, index + marker.length);
      if (end <= index + marker.length || /\s/.test(value[end - 1])) continue;
      output += `<${tag}>${renderInline(value.slice(index + marker.length, end), depth + 1)}</${tag}>`;
      index = end + marker.length;
      renderedMarker = true;
      break;
    }
    if (renderedMarker) continue;

    if (value[index] === '\n') {
      if (index >= 2 && value.slice(index - 2, index) === '  ' && output.endsWith('  ')) {
        output = `${output.slice(0, -2)}<br>`;
      } else output += '\n';
      index += 1;
      continue;
    }
    output += escapeHtml(value[index]);
    index += 1;
  }
  return output;
}

function isHorizontalRule(line: string): boolean {
  const compact = line.trim().replace(/[ \t]/g, '');
  return compact.length >= 3
    && (/^\*{3,}$/.test(compact) || /^-{3,}$/.test(compact) || /^_{3,}$/.test(compact));
}

function parseListMarker(line: string): MarkdownListMarker | undefined {
  const match = /^( *)([-+*]|(\d{1,9})[.)])\s+(.*)$/.exec(line);
  if (!match) return undefined;
  return {
    indent: match[1].length,
    markerLength: match[1].length + match[2].length + 1,
    ordered: Boolean(match[3]),
    order: match[3] ? Number(match[3]) : 1,
    content: match[4],
  };
}

function splitTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let codeFence = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\\' && value[index + 1] === '|') {
      cell += '\\|';
      index += 1;
      continue;
    }
    if (value[index] === '`') {
      let count = 1;
      while (value[index + count] === '`') count += 1;
      if (codeFence === 0) codeFence = count;
      else if (codeFence === count) codeFence = 0;
      cell += '`'.repeat(count);
      index += count - 1;
      continue;
    }
    if (value[index] === '|' && codeFence === 0) {
      cells.push(cell.trim());
      cell = '';
    } else cell += value[index];
  }
  cells.push(cell.trim());
  return cells;
}

function parseTable(lines: string[], index: number): MarkdownTableData | undefined {
  if (index + 1 >= lines.length || (!lines[index].includes('|') && !lines[index + 1].includes('|'))) {
    return undefined;
  }
  const headers = splitTableRow(lines[index]);
  const delimiters = splitTableRow(lines[index + 1]);
  if (headers.length !== delimiters.length || headers.length === 0) return undefined;
  const alignments: MarkdownTableData['alignments'] = [];
  for (const delimiter of delimiters) {
    const compact = delimiter.replace(/\s/g, '');
    if (!/^:?-{3,}:?$/.test(compact)) return undefined;
    alignments.push(compact.startsWith(':') && compact.endsWith(':')
      ? 'center'
      : compact.endsWith(':') ? 'right' : compact.startsWith(':') ? 'left' : undefined);
  }
  return { headers, alignments };
}

function isTableDelimiterLine(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')));
}

function alignmentClass(alignment: 'left' | 'center' | 'right' | undefined): string {
  return alignment ? ` class="markdown-align-${alignment}"` : '';
}

function renderTable(lines: string[], index: number, table: MarkdownTableData): { html: string; next: number } {
  let cursor = index + 2;
  const rows: string[][] = [];
  while (cursor < lines.length && lines[cursor].trim() && lines[cursor].includes('|')) {
    const cells = splitTableRow(lines[cursor]);
    rows.push(Array.from({ length: table.headers.length }, (_, cellIndex) => cells[cellIndex] ?? ''));
    cursor += 1;
  }
  const head = table.headers.map((cell, cellIndex) => (
    `<th scope="col"${alignmentClass(table.alignments[cellIndex])}>${renderInline(cell)}</th>`
  )).join('');
  const body = rows.map((row) => `<tr>${row.map((cell, cellIndex) => (
    `<td${alignmentClass(table.alignments[cellIndex])}>${renderInline(cell)}</td>`
  )).join('')}</tr>`).join('');
  return {
    html: `<div class="markdown-table-scroll"><table><thead><tr>${head}</tr></thead>`
      + `${body ? `<tbody>${body}</tbody>` : ''}</table></div>`,
    next: cursor,
  };
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  return Boolean(
    fenceOpening(line)
    || parseAtxHeading(line)
    || isHorizontalRule(line)
    || /^ {0,3}>/.test(line)
    || ((parseListMarker(line)?.indent ?? 4) <= 3)
    || /^(?: {4}|\t)/.test(line)
    || parseTable(lines, index),
  );
}

function stripSingleParagraph(html: string): string {
  const match = /^<p>([\s\S]*)<\/p>$/.exec(html);
  return match ? match[1] : html;
}

function renderList(
  lines: string[],
  index: number,
  context: MarkdownRenderContext,
  depth: number,
): { html: string; next: number } {
  const first = parseListMarker(lines[index]) as MarkdownListMarker;
  const items: Array<{ lines: string[]; checked?: boolean }> = [];
  let cursor = index;
  while (cursor < lines.length) {
    const marker = parseListMarker(lines[cursor]);
    if (!marker || marker.indent !== first.indent || marker.ordered !== first.ordered) break;
    const itemLines = [marker.content];
    cursor += 1;
    while (cursor < lines.length) {
      const nextMarker = parseListMarker(lines[cursor]);
      if (nextMarker?.indent === first.indent) break;
      if (!lines[cursor].trim()) {
        if (cursor + 1 >= lines.length || (!lines[cursor + 1].trim())) break;
        const afterBlank = parseListMarker(lines[cursor + 1]);
        const indentation = /^( *)/.exec(lines[cursor + 1])?.[1].length ?? 0;
        if ((!afterBlank || afterBlank.indent <= first.indent) && indentation <= first.indent) break;
        itemLines.push('');
        cursor += 1;
        continue;
      }
      const indentation = /^( *)/.exec(lines[cursor])?.[1].length ?? 0;
      if (indentation > first.indent) {
        itemLines.push(lines[cursor].slice(Math.min(lines[cursor].length, first.indent + 2)));
        cursor += 1;
        continue;
      }
      if (!startsBlock(lines, cursor)) {
        itemLines.push(lines[cursor]);
        cursor += 1;
        continue;
      }
      break;
    }
    const task = !first.ordered ? /^\[([ xX])\]\s+(.*)$/.exec(itemLines[0]) : undefined;
    if (task) itemLines[0] = task[2];
    items.push({ lines: itemLines, ...(task ? { checked: task[1].toLocaleLowerCase() === 'x' } : {}) });
  }
  const hasTasks = items.some((item) => item.checked !== undefined);
  const tag = first.ordered ? 'ol' : 'ul';
  const attributes = first.ordered && first.order !== 1
    ? ` start="${first.order}"`
    : hasTasks ? ' class="task-list"' : '';
  const body = items.map((item) => {
    const itemHtml = stripSingleParagraph(renderBlocks(item.lines, context, depth + 1));
    if (item.checked === undefined) return `<li>${itemHtml}</li>`;
    return `<li class="task-list-item"><input type="checkbox" disabled${item.checked ? ' checked' : ''}`
      + ` aria-label="${item.checked ? 'Completed task' : 'Incomplete task'}">${itemHtml}</li>`;
  }).join('');
  return { html: `<${tag}${attributes}>${body}</${tag}>`, next: cursor };
}

function renderBlocks(lines: string[], context: MarkdownRenderContext, depth = 0): string {
  if (depth >= MAX_BLOCK_DEPTH) return `<p>${renderInline(lines.join('\n'))}</p>`;
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    const fence = fenceOpening(lines[index]);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !isFenceClosing(lines[index], fence)) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      const language = /^[A-Za-z0-9_+-]{1,40}$/.test(fence.info.split(/\s+/, 1)[0] ?? '')
        ? fence.info.split(/\s+/, 1)[0].toLocaleLowerCase()
        : '';
      output.push(`<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>`
        + `${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const atx = parseAtxHeading(lines[index]);
    if (atx) {
      const text = plainInlineText(atx.text);
      const id = nextHeadingId(text, context.headingIds);
      output.push(`<h${atx.level} id="${escapeHtml(id)}">${renderInline(atx.text)}</h${atx.level}>`);
      index += 1;
      continue;
    }

    const setextLevel = index + 1 < lines.length ? setextHeadingLevel(lines[index + 1]) : undefined;
    if (setextLevel && lines[index].trim()) {
      const text = plainInlineText(lines[index]);
      const id = nextHeadingId(text, context.headingIds);
      output.push(`<h${setextLevel} id="${escapeHtml(id)}">${renderInline(lines[index].trim())}</h${setextLevel}>`);
      index += 2;
      continue;
    }

    if (isHorizontalRule(lines[index])) {
      output.push('<hr>');
      index += 1;
      continue;
    }

    if (/^ {0,3}>/.test(lines[index])) {
      const quoted: string[] = [];
      while (index < lines.length && (/^ {0,3}>/.test(lines[index]) || !lines[index].trim())) {
        quoted.push(lines[index].replace(/^ {0,3}> ?/, ''));
        index += 1;
      }
      output.push(`<blockquote>${renderBlocks(quoted, context, depth + 1)}</blockquote>`);
      continue;
    }

    const marker = parseListMarker(lines[index]);
    if (marker && marker.indent <= 3) {
      const list = renderList(lines, index, context, depth);
      output.push(list.html);
      index = list.next;
      continue;
    }

    if (/^(?: {4}|\t)/.test(lines[index])) {
      const code: string[] = [];
      while (index < lines.length && (/^(?: {4}|\t)/.test(lines[index]) || !lines[index].trim())) {
        code.push(lines[index].replace(/^(?: {4}|\t)/, ''));
        index += 1;
      }
      while (code.at(-1) === '') code.pop();
      output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const table = parseTable(lines, index);
    if (table) {
      const rendered = renderTable(lines, index, table);
      output.push(rendered.html);
      index = rendered.next;
      continue;
    }

    const paragraph = [lines[index]];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)
      && !setextHeadingLevel(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    output.push(`<p>${renderInline(paragraph.join('\n'))}</p>`);
  }
  return output.join('\n');
}

/**
 * Renders a deliberately small Markdown dialect into inert HTML. Every source
 * character is escaped before insertion, links are absolute HTTP(S) only, and
 * Markdown images become non-loading placeholders (an img/src is never emitted).
 */
export function renderMarkdownToSafeHtml(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  return renderBlocks(normalized ? normalized.split('\n') : [], { headingIds: new Map() });
}

export const renderMarkdownSafeHtml = renderMarkdownToSafeHtml;

/** Creates a cross-platform leaf filename; path separators and reserved names are removed. */
export function createSafeNoteFilename(title: string, extension: string = 'md'): string {
  const safeExtension = extension.replace(/^\.+/, '').toLocaleLowerCase();
  const suffix = /^[a-z0-9]{1,10}$/.test(safeExtension) ? safeExtension : 'md';
  let stem = title
    .normalize('NFKC')
    .replace(BIDI_CONTROL_CHARACTERS, ' ')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim();
  if (!stem) stem = 'Note';
  if (WINDOWS_RESERVED_FILENAME.test(stem)) stem = `_${stem}`;
  const maximumStemLength = Math.max(1, MAX_FILENAME_CHARACTERS - suffix.length - 1);
  const maximumStemBytes = MAX_FILENAME_UTF8_BYTES - utf8ByteLength(`.${suffix}`);
  stem = truncateUtf8(
    Array.from(stem).slice(0, maximumStemLength).join(''),
    maximumStemBytes,
  ).replace(/[. ]+$/g, '') || 'Note';
  return `${stem}.${suffix}`;
}

export const safeMarkdownFilename = createSafeNoteFilename;
