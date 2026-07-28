const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CODE_HIGHLIGHT_LANGUAGES,
  CODE_HIGHLIGHT_LIMITS,
  codeHighlightSearchText,
  findCodeHighlightLanguage,
} = require('../dist/shared/codeHighlight');
const { highlightSafeNoteCodeBlocks } = require('../dist/main/noteCodeHighlight');
const { richTextToMarkdown, richTextToSafeHtml } = require('../dist/shared/noteExport');

const COMMON_LANGUAGE_VALUES = [
  'arduino', 'bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'go', 'graphql', 'ini',
  'java', 'javascript', 'json', 'kotlin', 'less', 'lua', 'makefile', 'markdown',
  'objectivec', 'perl', 'php', 'php-template', 'plaintext', 'python', 'python-repl',
  'r', 'ruby', 'rust', 'scss', 'shell', 'sql', 'swift', 'typescript', 'vbnet',
  'wasm', 'xml', 'yaml',
];

test('Rich Text code-language catalog is the exact Lowlight common set with stable limits', () => {
  assert.equal(CODE_HIGHLIGHT_LANGUAGES.length, 37);
  assert.deepEqual(
    CODE_HIGHLIGHT_LANGUAGES.map(({ value }) => value).sort(),
    [...COMMON_LANGUAGE_VALUES].sort(),
  );
  assert.deepEqual(CODE_HIGHLIGHT_LIMITS, {
    automaticCharacters: 10_000,
    explicitCharacters: 50_000,
    pdfTotalCharacters: 100_000,
  });
  assert.equal(findCodeHighlightLanguage(' TS ')?.value, 'typescript');
  assert.equal(findCodeHighlightLanguage('c++')?.value, 'cpp');
  assert.equal(findCodeHighlightLanguage('unknown'), undefined);
  assert.match(codeHighlightSearchText(findCodeHighlightLanguage('javascript')), /javascript js jsx node/);
});

test('PDF code highlighting prefers explicit languages, detects Auto, and keeps token HTML inert', () => {
  const explicit = highlightSafeNoteCodeBlocks(
    '<pre><code class="language-typescript">const value: number = 1;</code></pre>',
  );
  assert.match(explicit, /^<pre><code class="hljs language-typescript">/);
  assert.match(explicit, /hljs-keyword/);
  assert.match(explicit, /hljs-built_in/);

  const aliasedExplicit = highlightSafeNoteCodeBlocks(
    '<pre><code class="language-c++">int main() { return 0; }</code></pre>',
  );
  assert.match(aliasedExplicit, /^<pre><code class="hljs language-cpp">/);
  assert.match(aliasedExplicit, /hljs-keyword/);

  const automatic = highlightSafeNoteCodeBlocks(
    '<pre><code>SELECT * FROM users WHERE id = 1;</code></pre>',
  );
  assert.match(automatic, /^<pre><code class="hljs language-sql">/);
  assert.match(automatic, /hljs-keyword/);

  const inert = highlightSafeNoteCodeBlocks(
    '<pre><code class="language-xml">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</code></pre>',
  );
  assert.doesNotMatch(inert, /<script>/);
  assert.match(inert, /&lt;\/.*script|&lt;script|hljs-name/);
});

test('editor and PDF highlight work is bounded per block and across one PDF', () => {
  const automaticTooLarge = `<pre><code>${'x'.repeat(10_001)}</code></pre>`;
  const explicitTooLarge = `<pre><code class="language-plaintext">${'x'.repeat(50_001)}</code></pre>`;
  assert.equal(highlightSafeNoteCodeBlocks(automaticTooLarge), automaticTooLarge);
  assert.equal(highlightSafeNoteCodeBlocks(explicitTooLarge), explicitTooLarge);

  const source = 'x'.repeat(40_000);
  const block = `<pre><code class="language-plaintext">${source}</code></pre>`;
  const result = highlightSafeNoteCodeBlocks(block.repeat(3));
  assert.equal((result.match(/class="hljs language-plaintext"/g) ?? []).length, 2);
  assert.equal(result.endsWith(block), true, 'the third block must remain plain after the PDF budget is spent');
});

test('language metadata reaches print HTML while Markdown export remains source-oriented', () => {
  const document = {
    type: 'doc',
    content: [{
      type: 'codeBlock',
      attrs: { language: 'typescript' },
      content: [{ type: 'text', text: 'const answer: number = 42;' }],
    }],
  };
  assert.equal(
    richTextToMarkdown(document),
    '```typescript\nconst answer: number = 42;\n```',
  );
  assert.equal(
    richTextToSafeHtml(document),
    '<pre><code class="language-typescript">const answer: number = 42;</code></pre>',
  );
});
