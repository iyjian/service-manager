import {
  parseNoteAttachmentReference,
  parseNoteImageNodeAttributes,
  parseRichTextContent,
  type RichTextMark,
  type RichTextNode,
} from './noteRichText.js';
import type { NoteAttachmentReference, NoteImageReference } from './types.js';

export interface NoteShareAssetResolver {
  imageUrl: (reference: NoteImageReference) => string;
  attachmentUrl: (reference: NoteAttachmentReference) => string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, '\\$1');
}

function escapeMarkdownParagraphStarts(value: string): string {
  return value
    .replace(/(^|\n)( {0,3})(#{1,6})(?=[ \t]|$)/g, '$1$2\\$3')
    .replace(/(^|\n)( {0,3})([-+])(?=[ \t]|$)/g, '$1$2\\$3')
    .replace(/(^|\n)( {0,3})(-)(?=-{2,}[ \t]*(?:\n|$))/g, '$1$2\\$3')
    .replace(/(^|\n)( {0,3})(\d{1,9})([.)])(?=[ \t]|$)/g, '$1$2$3\\$4')
    .replace(/(^|\n)( {0,3})(=)(?==*[ \t]*(?:\n|$))/g, '$1$2\\$3');
}

function nodeAttribute(node: RichTextNode, key: string): unknown {
  return node.attrs && typeof node.attrs === 'object'
    ? (node.attrs as unknown as Record<string, unknown>)[key]
    : undefined;
}

function longestBacktickRun(value: string, minimum = 0): number {
  let longest = minimum;
  let current = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 96) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

function markdownCode(value: string): string {
  const longest = longestBacktickRun(value);
  const fence = '`'.repeat(Math.max(1, longest + 1));
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${value}${padding}${fence}`;
}

function applyMarkdownMarks(text: string, marks: readonly RichTextMark[] | undefined): string {
  let result = escapeMarkdownText(text);
  for (const mark of [...(marks ?? [])].reverse()) {
    switch (mark.type) {
      case 'bold': result = `**${result}**`; break;
      case 'italic': result = `_${result}_`; break;
      case 'strike': result = `~~${result}~~`; break;
      case 'code': result = markdownCode(text); break;
      case 'link': {
        const href = mark.attrs?.href ?? '';
        const title = mark.attrs?.title ? ` "${mark.attrs.title.replace(/"/g, '\\"')}"` : '';
        result = `[${result}](${href}${title})`;
        break;
      }
      case 'underline':
      case 'textStyle':
      case 'highlight':
        break;
    }
  }
  return result;
}

function inlineMarkdown(node: RichTextNode): string {
  if (node.type === 'text') return applyMarkdownMarks(node.text ?? '', node.marks);
  if (node.type === 'hardBreak') return '  \n';
  if (node.type === 'math') {
    const latexValue = nodeAttribute(node, 'latex');
    const latex = typeof latexValue === 'string' ? latexValue : '';
    return `$${latex.replace(/\$/g, '\\$')}$`;
  }
  return (node.content ?? []).map(inlineMarkdown).join('');
}

function plainNodeText(node: RichTextNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'math') {
    const latex = nodeAttribute(node, 'latex');
    return typeof latex === 'string' ? latex : '';
  }
  if (node.type === 's3Image') return parseNoteImageNodeAttributes(node.attrs).alt ?? 'Image';
  if (node.type === 's3Attachment') return parseNoteAttachmentReference(node.attrs).fileName;
  return (node.content ?? []).map(plainNodeText).join('');
}

function listItemMarkdown(node: RichTextNode, marker: string, depth: number): string {
  const content = node.content ?? [];
  const first = content[0];
  const firstText = first ? blockMarkdown(first, depth) : '';
  const prefix = `${'  '.repeat(depth)}${marker} `;
  const continuation = content.slice(1).map((child) => blockMarkdown(child, depth + 1)).join('\n');
  return `${prefix}${firstText}${continuation ? `\n${continuation}` : ''}`;
}

function tableMarkdown(node: RichTextNode): string {
  const rows = node.content ?? [];
  if (rows.length === 0) return '';
  const cells = rows.map((row) => (row.content ?? []).map((cell) =>
    plainNodeText(cell).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, '<br>')
  ));
  const width = Math.max(1, ...cells.map((row) => row.length));
  const normalized = cells.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')]);
  const header = normalized[0];
  return [
    `| ${header.join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function blockMarkdown(node: RichTextNode, depth = 0): string {
  switch (node.type) {
    case 'paragraph': return escapeMarkdownParagraphStarts(inlineMarkdown(node));
    case 'heading': return `${'#'.repeat(Number(nodeAttribute(node, 'level')) || 1)} ${inlineMarkdown(node)}`;
    case 'blockquote': return (node.content ?? []).map((child) => blockMarkdown(child, depth))
      .join('\n\n').split('\n').map((line) => `> ${line}`).join('\n');
    case 'bulletList': return (node.content ?? []).map((item) => listItemMarkdown(item, '-', depth)).join('\n');
    case 'orderedList': {
      const start = Number(nodeAttribute(node, 'start')) || 1;
      return (node.content ?? []).map((item, index) => listItemMarkdown(item, `${start + index}.`, depth)).join('\n');
    }
    case 'taskList': return (node.content ?? []).map((item) => {
      const checked = nodeAttribute(item, 'checked') === true ? 'x' : ' ';
      return listItemMarkdown(item, `- [${checked}]`, depth);
    }).join('\n');
    case 'listItem':
    case 'taskItem': return listItemMarkdown(node, '-', depth);
    case 'codeBlock': {
      const source = (node.content ?? []).map((child) => child.text ?? '').join('');
      const longest = longestBacktickRun(source, 2);
      const fence = '`'.repeat(longest + 1);
      const languageValue = nodeAttribute(node, 'language');
      const language = typeof languageValue === 'string' ? languageValue : '';
      return `${fence}${language}\n${source}\n${fence}`;
    }
    case 'horizontalRule': return '---';
    case 's3Image': {
      const image = parseNoteImageNodeAttributes(node.attrs);
      return `[Image: ${escapeMarkdownText(image.alt ?? 'Embedded image')}]`;
    }
    case 's3Attachment': {
      const attachment = parseNoteAttachmentReference(node.attrs);
      return `[Attachment: ${escapeMarkdownText(attachment.fileName)} · ${formatByteSize(attachment.byteLength)}]`;
    }
    case 'table': return tableMarkdown(node);
    default: return (node.content ?? []).map((child) => blockMarkdown(child, depth)).join('\n\n');
  }
}

/** Deterministic, portable Markdown representation of the canonical Rich Text document. */
export function richTextToMarkdown(value: unknown): string {
  const document = parseRichTextContent(value);
  return (document.content ?? []).map((node) => blockMarkdown(node)).join('\n\n').replace(/\n{4,}/g, '\n\n\n');
}

function applyHtmlMarks(text: string, marks: readonly RichTextMark[] | undefined): string {
  let result = text;
  for (const mark of [...(marks ?? [])].reverse()) {
    switch (mark.type) {
      case 'bold': result = `<strong>${result}</strong>`; break;
      case 'italic': result = `<em>${result}</em>`; break;
      case 'underline': result = `<u>${result}</u>`; break;
      case 'strike': result = `<s>${result}</s>`; break;
      case 'code': result = `<code>${result}</code>`; break;
      case 'link': result = `<a href="${escapeHtml(mark.attrs?.href ?? '')}">${result}</a>`; break;
      case 'textStyle': result = `<span style="color:${escapeHtml(mark.attrs?.color ?? '')}">${result}</span>`; break;
      case 'highlight': result = `<mark style="background:${escapeHtml(mark.attrs?.color ?? '')}">${result}</mark>`; break;
    }
  }
  return result;
}

function inlineHtml(node: RichTextNode): string {
  if (node.type === 'text') return applyHtmlMarks(escapeHtml(node.text ?? ''), node.marks);
  if (node.type === 'hardBreak') return '<br>';
  if (node.type === 'math') return `<span class="math">${escapeHtml(String(nodeAttribute(node, 'latex') ?? ''))}</span>`;
  return (node.content ?? []).map(inlineHtml).join('');
}

function listItemHtml(node: RichTextNode, task = false, assets?: NoteShareAssetResolver): string {
  const checked = task && nodeAttribute(node, 'checked') === true;
  return `<li${task ? ` class="task${checked ? ' checked' : ''}"` : ''}>${task ? `<span class="checkbox">${checked ? '✓' : ''}</span>` : ''}${(node.content ?? []).map((child) => blockHtml(child, assets)).join('')}</li>`;
}

function safeShareUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return escapeHtml(url.toString());
  } catch {
    // The main process owns generated signed asset URLs.
  }
  throw new Error('The shared Note asset URL is invalid.');
}

function blockHtml(node: RichTextNode, assets?: NoteShareAssetResolver): string {
  switch (node.type) {
    case 'paragraph': return `<p>${inlineHtml(node)}</p>`;
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(nodeAttribute(node, 'level')) || 1));
      return `<h${level}>${inlineHtml(node)}</h${level}>`;
    }
    case 'blockquote': return `<blockquote>${(node.content ?? []).map((child) => blockHtml(child, assets)).join('')}</blockquote>`;
    case 'bulletList': return `<ul>${(node.content ?? []).map((item) => listItemHtml(item, false, assets)).join('')}</ul>`;
    case 'orderedList': return `<ol start="${Number(nodeAttribute(node, 'start')) || 1}">${(node.content ?? []).map((item) => listItemHtml(item, false, assets)).join('')}</ol>`;
    case 'taskList': return `<ul class="tasks">${(node.content ?? []).map((item) => listItemHtml(item, true, assets)).join('')}</ul>`;
    case 'listItem': return listItemHtml(node, false, assets);
    case 'taskItem': return listItemHtml(node, true, assets);
    case 'codeBlock': {
      const languageValue = nodeAttribute(node, 'language');
      const language = typeof languageValue === 'string' ? languageValue : '';
      return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml((node.content ?? []).map((child) => child.text ?? '').join(''))}</code></pre>`;
    }
    case 'horizontalRule': return '<hr>';
    case 's3Image': {
      const image = parseNoteImageNodeAttributes(node.attrs);
      if (assets) {
        const source = safeShareUrl(assets.imageUrl(image));
        return `<figure class="asset image"><img src="${source}" alt="${escapeHtml(image.alt ?? '')}"><figcaption>${escapeHtml(image.alt ?? 'Embedded image')}</figcaption></figure>`;
      }
      return `<figure class="asset"><div class="asset-icon">▧</div><figcaption>${escapeHtml(image.alt ?? 'Embedded image')}</figcaption></figure>`;
    }
    case 's3Attachment': {
      const attachment = parseNoteAttachmentReference(node.attrs);
      if (assets) {
        const source = safeShareUrl(assets.attachmentUrl(attachment));
        return `<a class="attachment" href="${source}" download><span class="attachment-icon">↧</span><span><strong>${escapeHtml(attachment.fileName)}</strong><small>${escapeHtml(attachment.mimeType)} · ${formatByteSize(attachment.byteLength)}</small></span></a>`;
      }
      return `<div class="attachment"><span class="attachment-icon">↧</span><span><strong>${escapeHtml(attachment.fileName)}</strong><small>${escapeHtml(attachment.mimeType)} · ${formatByteSize(attachment.byteLength)}</small></span></div>`;
    }
    case 'table': return `<table><tbody>${(node.content ?? []).map((child) => blockHtml(child, assets)).join('')}</tbody></table>`;
    case 'tableRow': return `<tr>${(node.content ?? []).map((child) => blockHtml(child, assets)).join('')}</tr>`;
    case 'tableHeader': return `<th>${(node.content ?? []).map((child) => blockHtml(child, assets)).join('')}</th>`;
    case 'tableCell': return `<td>${(node.content ?? []).map((child) => blockHtml(child, assets)).join('')}</td>`;
    default: return (node.content ?? []).map((child) => blockHtml(child, assets)).join('');
  }
}

/** Strict HTML generated only from the already canonical Rich Text allowlist. */
export function richTextToSafeHtml(value: unknown): string {
  const document = parseRichTextContent(value);
  return (document.content ?? []).map((node) => blockHtml(node)).join('');
}

/** Safe Rich Text HTML with main-process-owned signed media URLs. */
export function richTextToShareHtml(value: unknown, assets: NoteShareAssetResolver): string {
  const document = parseRichTextContent(value);
  return (document.content ?? []).map((node) => blockHtml(node, assets)).join('');
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

/** Complete isolated print document. The body HTML must come from a strict renderer in this package. */
export function buildNotePrintDocument(title: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>
    @page{size:A4;margin:18mm 17mm 20mm}*{box-sizing:border-box}body{margin:0;color:#18181b;font-family:Inter,"Noto Sans SC",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:11pt;line-height:1.65;overflow-wrap:anywhere}h1.title{margin:0 0 1.25em;padding-bottom:.45em;border-bottom:1px solid #e4e4e7;font-size:24pt;line-height:1.2}h1,h2,h3,h4,h5,h6{break-after:avoid;line-height:1.3;margin:1.2em 0 .45em}p{margin:.5em 0}a{color:#2563eb;text-decoration:underline}pre{white-space:pre-wrap;word-break:break-word;background:#1f2937;color:#e5e7eb;border-radius:6px;padding:10px;break-inside:avoid}code,.math{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Consolas,monospace;background:#f4f4f5;border-radius:3px;padding:.1em .25em}pre code{background:transparent;padding:0}.hljs-comment,.hljs-quote{color:#8b949e}.hljs-variable,.hljs-template-variable,.hljs-attribute,.hljs-tag,.hljs-name,.hljs-regexp,.hljs-link,.hljs-selector-id,.hljs-selector-class{color:#f98181}.hljs-number,.hljs-meta,.hljs-built_in,.hljs-builtin-name,.hljs-literal,.hljs-type,.hljs-params{color:#fbbc88}.hljs-string,.hljs-symbol,.hljs-bullet{color:#b9f18d}.hljs-title,.hljs-section{color:#faf594}.hljs-keyword,.hljs-selector-tag{color:#70cff8}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}blockquote{margin:.8em 0;padding:.1em 1em;border-left:3px solid #a1a1aa;color:#52525b}table{width:100%;border-collapse:collapse;margin:1em 0;font-size:9.5pt}th,td{border:1px solid #d4d4d8;padding:6px 8px;vertical-align:top}th{background:#f4f4f5;text-align:left}.tasks{list-style:none;padding-left:0}.task{display:flex;gap:.55em}.checkbox{display:inline-flex;width:1.1em;height:1.1em;align-items:center;justify-content:center;border:1px solid #a1a1aa;border-radius:3px;margin-top:.25em;font-size:.75em}.checked{color:#71717a;text-decoration:line-through}.asset,.attachment{display:flex;align-items:center;gap:10px;margin:1em 0;padding:10px;border:1px solid #d4d4d8;border-radius:7px;break-inside:avoid}.asset{flex-direction:column;align-items:flex-start}.asset-icon,.attachment-icon{font-size:20px;color:#71717a}.attachment small{display:block;color:#71717a;font-size:8.5pt}hr{border:0;border-top:1px solid #d4d4d8;margin:1.5em 0}mark{padding:0 .1em}
  </style></head><body><h1 class="title">${escapeHtml(title || 'Untitled')}</h1><main>${bodyHtml}</main></body></html>`;
}

/** Complete inert browser document used for expiring S3 Note shares. */
export function buildNoteShareDocument(title: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: http:; font-src 'none'"><title>${escapeHtml(title)}</title><style>
    *{box-sizing:border-box}body{max-width:900px;margin:0 auto;padding:48px 24px 72px;color:#18181b;background:#fff;font-family:Inter,"Noto Sans SC",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:16px;line-height:1.7;overflow-wrap:anywhere}h1.title{margin:0 0 1.35em;padding-bottom:.55em;border-bottom:1px solid #e4e4e7;font-size:2rem;line-height:1.2}h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.25em 0 .5em}p{margin:.65em 0}a{color:#2563eb;text-decoration:underline}pre{overflow:auto;max-height:24rem;background:#1f2937;color:#e5e7eb;border-radius:6px;margin:2em 0;padding:1em 1.5em;font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.8888889em;font-weight:400;line-height:1.75}code,.math{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace;background:#f4f4f5;border-radius:4px;padding:.1em .28em}pre code{background:transparent;padding:0;color:inherit;font-family:inherit;font-weight:400;line-height:inherit}.hljs-comment,.hljs-quote{color:#8b949e}.hljs-variable,.hljs-template-variable,.hljs-attribute,.hljs-tag,.hljs-name,.hljs-regexp,.hljs-link,.hljs-selector-id,.hljs-selector-class{color:#f98181}.hljs-number,.hljs-meta,.hljs-built_in,.hljs-builtin-name,.hljs-literal,.hljs-type,.hljs-params{color:#fbbc88}.hljs-string,.hljs-symbol,.hljs-bullet{color:#b9f18d}.hljs-title,.hljs-section{color:#faf594}.hljs-keyword,.hljs-selector-tag{color:#70cff8}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}blockquote{margin:1em 0;padding:.15em 1em;border-left:3px solid #a1a1aa;color:#52525b}table{width:100%;border-collapse:collapse;margin:1em 0}th,td{border:1px solid #d4d4d8;padding:7px 9px;vertical-align:top}th{background:#f4f4f5;text-align:left}.tasks{list-style:none;padding-left:0}.task{display:flex;gap:.55em}.checkbox{display:inline-flex;width:1.1em;height:1.1em;align-items:center;justify-content:center;border:1px solid #a1a1aa;border-radius:3px;margin-top:.3em;font-size:.75em}.checked{color:#71717a;text-decoration:line-through}.asset,.attachment{display:flex;align-items:center;gap:10px;margin:1em 0;padding:11px;border:1px solid #d4d4d8;border-radius:8px}.asset.image{display:block;padding:0;overflow:hidden}.asset.image img{display:block;max-width:100%;height:auto}.asset.image figcaption{padding:8px 10px;color:#52525b;font-size:.875rem}.attachment{text-decoration:none;color:inherit}.attachment:hover{background:#fafafa}.attachment-icon{font-size:20px;color:#71717a}.attachment small{display:block;color:#71717a;font-size:.82rem}hr{border:0;border-top:1px solid #d4d4d8;margin:1.5em 0}mark{padding:0 .1em}@media(max-width:600px){body{padding:28px 16px 48px;font-size:15px}}
  </style></head><body><h1 class="title">${escapeHtml(title || 'Untitled')}</h1><main>${bodyHtml}</main></body></html>`;
}
