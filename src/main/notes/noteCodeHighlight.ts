import type { HLJSApi } from 'highlight.js';
import {
  CODE_HIGHLIGHT_LIMITS,
  findCodeHighlightLanguage,
} from '../../shared/codeHighlight';

// Highlight.js publishes this curated 37-language entry as CommonJS for the
// Electron main process. Keep Lowlight itself renderer-only because v3 is ESM.
const commonHighlight = require('highlight.js/lib/common') as HLJSApi;

const SAFE_CODE_BLOCK = /<pre><code(?: class="language-([A-Za-z0-9_+.#-]{1,64})")?>([\s\S]*?)<\/code><\/pre>/g;

function decodeEscapedCode(value: string): string {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/** Adds token-only spans to HTML already produced by the strict Note renderers. */
export function highlightSafeNoteCodeBlocks(bodyHtml: string): string {
  let highlightedCharacters = 0;
  return bodyHtml.replace(SAFE_CODE_BLOCK, (complete, rawLanguage: string | undefined, encoded: string) => {
    const source = decodeEscapedCode(encoded);
    const knownLanguage = findCodeHighlightLanguage(rawLanguage);
    const limit = knownLanguage
      ? CODE_HIGHLIGHT_LIMITS.explicitCharacters
      : CODE_HIGHLIGHT_LIMITS.automaticCharacters;
    if (
      source.length > limit
      || highlightedCharacters + source.length > CODE_HIGHLIGHT_LIMITS.pdfTotalCharacters
    ) return complete;

    try {
      const result = knownLanguage && commonHighlight.getLanguage(knownLanguage.value)
        ? commonHighlight.highlight(source, { language: knownLanguage.value, ignoreIllegals: true })
        : commonHighlight.highlightAuto(source);
      highlightedCharacters += source.length;
      const renderedLanguage = knownLanguage?.value
        ?? findCodeHighlightLanguage(result.language)?.value;
      const className = renderedLanguage ? ` class="hljs language-${renderedLanguage}"` : ' class="hljs"';
      return `<pre><code${className}>${result.value}</code></pre>`;
    } catch {
      return complete;
    }
  });
}
