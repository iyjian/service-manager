const assert = require('node:assert/strict');
const test = require('node:test');

async function loadMarkdownTools() {
  return import('../dist/shared/notesMarkdown.js');
}

test('Markdown formatting emits minimal inline edits and useful resulting selections', async () => {
  const { applyMarkdownFormat } = await loadMarkdownTools();

  const bold = applyMarkdownFormat('hello world', { from: 6, to: 11 }, 'bold');
  assert.equal(bold.markdown, 'hello **world**');
  assert.deepEqual(bold.change, { from: 6, to: 11, insert: '**world**' });
  assert.deepEqual(bold.selection, { from: 8, to: 13 });

  const toggled = applyMarkdownFormat(bold.markdown, bold.selection, 'bold');
  assert.equal(toggled.markdown, 'hello world');
  assert.deepEqual(toggled.selection, { from: 6, to: 11 });

  const code = applyMarkdownFormat('a`b', { from: 0, to: 3 }, 'inlineCode');
  assert.equal(code.markdown, '``a`b``');
  assert.deepEqual(code.selection, { from: 2, to: 5 });
});

test('Markdown formatting supports safe links and line-oriented block commands', async () => {
  const { applyMarkdownFormat } = await loadMarkdownTools();

  const link = applyMarkdownFormat('Service Manager', { from: 0, to: 15 }, 'link', {
    linkUrl: 'https://example.test/docs?q=notes',
  });
  assert.equal(link.markdown, '[Service Manager](https://example.test/docs?q=notes)');
  assert.deepEqual(link.selection, { from: 1, to: 16 });

  const unsafeLink = applyMarkdownFormat('label', { from: 0, to: 5 }, 'link', {
    linkUrl: 'javascript:alert(1)',
  });
  assert.equal(unsafeLink.markdown, '[label](https://)');
  assert.deepEqual(unsafeLink.selection, { from: 8, to: 16 });

  const heading = applyMarkdownFormat('alpha\nbeta', { from: 0, to: 10 }, 'heading', { headingLevel: 3 });
  assert.equal(heading.markdown, '### alpha\n### beta');
  assert.equal(applyMarkdownFormat(heading.markdown, heading.selection, 'heading', {
    headingLevel: 3,
  }).markdown, 'alpha\nbeta');

  assert.equal(
    applyMarkdownFormat('alpha\nbeta', { from: 0, to: 10 }, 'quote').markdown,
    '> alpha\n> beta',
  );
  assert.equal(
    applyMarkdownFormat('alpha\nbeta', { from: 0, to: 10 }, 'numbered').markdown,
    '1. alpha\n2. beta',
  );
  assert.equal(
    applyMarkdownFormat('- alpha\n- beta', { from: 0, to: 14 }, 'task').markdown,
    '- [ ] alpha\n- [ ] beta',
  );
});

test('Markdown formatting inserts configurable GFM tables and horizontal rules', async () => {
  const { applyMarkdownFormat } = await loadMarkdownTools();

  const table = applyMarkdownFormat('', { from: 0, to: 0 }, 'table', {
    tableColumns: 2,
    tableRows: 1,
  });
  assert.equal(table.markdown, '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |');
  assert.deepEqual(table.selection, { from: 2, to: 10 });

  const rule = applyMarkdownFormat('beforeafter', { from: 6, to: 6 }, 'hr');
  assert.equal(rule.markdown, 'before\n\n---\n\nafter');
});

test('Markdown outline handles ATX and Setext headings, duplicate ids, and fenced code', async () => {
  const { extractMarkdownOutline } = await loadMarkdownTools();
  const markdown = [
    '# **Intro**',
    '',
    '```md',
    '# not a heading',
    '```',
    'Intro',
    '-----',
    '## 中文 标题 ##',
  ].join('\n');

  assert.deepEqual(extractMarkdownOutline(markdown), [
    { id: 'intro', level: 1, text: 'Intro', line: 1, offset: 0 },
    { id: 'intro-1', level: 2, text: 'Intro', line: 6, offset: 39 },
    { id: '中文-标题', level: 2, text: '中文 标题', line: 8, offset: 51 },
  ]);

  assert.deepEqual(extractMarkdownOutline('> ## Quoted\n\n- # Listed'), [
    { id: 'quoted', level: 2, text: 'Quoted', line: 1, offset: 0 },
    { id: 'listed', level: 1, text: 'Listed', line: 3, offset: 13 },
  ]);
});

test('Markdown stats count readable Latin words and Han characters without syntax markers', async () => {
  const { getMarkdownStats, markdownToPlainText } = await loadMarkdownTools();
  const markdown = '# Hello **world**\n\n你好 [docs](https://example.test)';

  assert.equal(markdownToPlainText(markdown), 'Hello world\n\n你好 docs');
  assert.deepEqual(getMarkdownStats(markdown), {
    words: 5,
    lines: 3,
    characters: 20,
    charactersWithoutSpaces: 16,
  });
});

test('safe Markdown rendering supports core inline constructs while escaping raw HTML', async () => {
  const { renderMarkdownToSafeHtml } = await loadMarkdownTools();
  const html = renderMarkdownToSafeHtml([
    '# Hello <script>alert(1)</script>',
    '',
    '**bold** *em* ~~gone~~ `a < b`',
    '',
    '[safe](https://example.test/a?x=1) [relative](/admin) [bad](javascript:alert(1))',
  ].join('\n'));

  assert.match(html, /^<h1 id="hello-scriptalert1script">/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|javascript:/i);
  assert.match(html, /<strong>bold<\/strong> <em>em<\/em> <del>gone<\/del> <code>a &lt; b<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.test\/a\?x=1" rel="noopener noreferrer">safe<\/a>/);
  assert.doesNotMatch(html, /href="\/admin"/);
  assert.match(html, /safe<\/a> relative bad/);
});

test('safe Markdown rendering emits inert image placeholders and no loading element', async () => {
  const { renderMarkdownToSafeHtml } = await loadMarkdownTools();
  const html = renderMarkdownToSafeHtml(
    'before ![diagram <unsafe>](https://tracker.test/pixel.png "title") after',
  );

  assert.match(html, /class="markdown-image-placeholder"/);
  assert.match(html, /diagram &lt;unsafe&gt;/);
  assert.match(html, /Remote image not loaded/);
  assert.doesNotMatch(html, /<img|\ssrc\s*=|tracker\.test/i);
});

test('safe Markdown rendering supports fences, quotes, lists, tasks, tables, and rules', async () => {
  const { renderMarkdownToSafeHtml } = await loadMarkdownTools();
  const html = renderMarkdownToSafeHtml([
    '> quoted **text**',
    '',
    '- item',
    '- [x] done',
    '',
    '3. third',
    '4. fourth',
    '',
    '| Name | State |',
    '| :--- | ---: |',
    '| api | `ready` |',
    '',
    '---',
    '',
    '```html',
    '<img src=x onerror=alert(1)>',
    '```',
  ].join('\n'));

  assert.match(html, /<blockquote><p>quoted <strong>text<\/strong><\/p><\/blockquote>/);
  assert.match(html, /<ul class="task-list"><li>item<\/li><li class="task-list-item"><input type="checkbox" disabled checked/);
  assert.match(html, /<ol start="3"><li>third<\/li><li>fourth<\/li><\/ol>/);
  assert.match(html, /<table><thead><tr><th scope="col" class="markdown-align-left">Name<\/th>/);
  assert.match(html, /<td class="markdown-align-right"><code>ready<\/code><\/td>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<pre><code class="language-html">&lt;img src=x onerror=alert\(1\)&gt;<\/code><\/pre>/);
  assert.doesNotMatch(html, /<img/);
});

test('safe filename helper removes paths, reserved characters, and unsafe extensions', async () => {
  const { createSafeNoteFilename } = await loadMarkdownTools();

  assert.equal(createSafeNoteFilename('  Release / Notes: July  '), 'Release Notes July.md');
  assert.equal(createSafeNoteFilename('CON', 'pdf'), '_CON.pdf');
  assert.equal(createSafeNoteFilename('../'), 'Note.md');
  assert.equal(createSafeNoteFilename('计划', '../../exe'), '计划.md');
  assert.equal(createSafeNoteFilename('invoice\u202Efdp.exe', 'pdf'), 'invoice fdp.exe.pdf');

  const multibyte = createSafeNoteFilename('界'.repeat(120), 'pdf');
  assert.equal(multibyte, `${'界'.repeat(83)}.pdf`);
  assert.ok(Buffer.byteLength(multibyte, 'utf8') <= 255);
  assert.doesNotMatch(multibyte, /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
});

test('malformed repeated link openers render in bounded time without creating anchors', async () => {
  const { renderMarkdownToSafeHtml } = await loadMarkdownTools();
  const source = '[x]('.repeat(32 * 1024);
  const startedAt = performance.now();
  const html = renderMarkdownToSafeHtml(source);
  const elapsed = performance.now() - startedAt;
  assert.doesNotMatch(html, /<a\b/);
  assert.ok(elapsed < 2_000, `malformed link rendering took ${elapsed.toFixed(0)} ms`);
});

test('malformed repeated autolink openers stay linear with or without a distant closer', async () => {
  const { renderMarkdownToSafeHtml } = await loadMarkdownTools();
  for (const source of ['<x'.repeat(256 * 1024), `${'<x'.repeat(256 * 1024)}>`]) {
    const startedAt = performance.now();
    const html = renderMarkdownToSafeHtml(source);
    const elapsed = performance.now() - startedAt;
    assert.doesNotMatch(html, /<a\b/);
    assert.ok(elapsed < 2_000, `malformed autolink rendering took ${elapsed.toFixed(0)} ms`);
  }
});
