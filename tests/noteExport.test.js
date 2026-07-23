const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildNotePrintDocument,
  formatByteSize,
  richTextToMarkdown,
  richTextToSafeHtml,
} = require('../dist/shared/noteExport');

function imageReference() {
  return {
    objectId: Buffer.alloc(24, 0x01).toString('base64url'),
    assetKey: Buffer.alloc(32, 0x02).toString('base64url'),
    ciphertextSha256: 'a'.repeat(64),
    contentSha256: 'b'.repeat(64),
    mimeType: 'image/png',
    byteLength: 24,
    width: 320,
    height: 180,
    alt: 'Architecture diagram',
  };
}

function attachmentReference() {
  return {
    objectId: Buffer.alloc(24, 0x03).toString('base64url'),
    assetKey: Buffer.alloc(32, 0x04).toString('base64url'),
    ciphertextSha256: 'c'.repeat(64),
    contentSha256: 'd'.repeat(64),
    fileName: 'roadmap.pdf',
    mimeType: 'application/pdf',
    byteLength: 12_345,
  };
}

function richTextFixture() {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Release plan' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Safe & ', marks: [{ type: 'bold' }] },
          {
            type: 'text',
            text: 'linked',
            marks: [{
              type: 'link',
              attrs: { href: 'https://example.com/docs', target: '_blank', rel: 'nofollow noopener noreferrer' },
            }],
          },
          { type: 'hardBreak' },
          { type: 'text', text: '<literal>' },
        ],
      },
      {
        type: 'taskList',
        content: [{
          type: 'taskItem',
          attrs: { checked: true },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ship it' }] }],
        }],
      },
      { type: 's3Image', attrs: imageReference() },
      { type: 's3Attachment', attrs: attachmentReference() },
    ],
  };
}

test('Rich Text Markdown export is deterministic, GFM-readable, and never leaks private asset keys', () => {
  const fixture = richTextFixture();
  const markdown = richTextToMarkdown(fixture);
  assert.match(markdown, /^# Release plan/m);
  assert.match(markdown, /\*\*Safe & \*\*/);
  assert.match(markdown, /\[linked\]\(https:\/\/example\.com\/docs\)/);
  assert.match(markdown, /- \[x\] Ship it/);
  assert.match(markdown, /\[Image: Architecture diagram\]/);
  assert.match(markdown, /\[Attachment: roadmap\.pdf · 12 KiB\]/);
  assert.doesNotMatch(markdown, new RegExp(imageReference().objectId));
  assert.doesNotMatch(markdown, new RegExp(attachmentReference().assetKey));
  assert.equal(richTextToMarkdown(fixture), markdown);
});

test('Rich Text Markdown export escapes block syntax at the start of plain paragraph lines', () => {
  const paragraphs = [
    '# literal heading',
    '- literal bullet',
    '+ literal bullet',
    '1. literal ordered item',
    '2) literal ordered item',
    '---',
    '===',
  ].map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }));
  paragraphs.push({
    type: 'paragraph',
    content: [
      { type: 'text', text: 'first line' },
      { type: 'hardBreak' },
      { type: 'text', text: '  - literal nested-looking bullet' },
    ],
  });

  assert.equal(richTextToMarkdown({ type: 'doc', content: paragraphs }), [
    '\\# literal heading',
    '\\- literal bullet',
    '\\+ literal bullet',
    '1\\. literal ordered item',
    '2\\) literal ordered item',
    '\\---',
    '\\===',
    'first line  \n  \\- literal nested-looking bullet',
  ].join('\n\n'));
});

test('Rich Text Markdown export handles near-limit backtick-heavy inline and block code iteratively', () => {
  const source = '`x'.repeat(490_000);
  const inlineMarkdown = richTextToMarkdown({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text: source, marks: [{ type: 'code' }] }],
    }],
  });
  assert.equal(inlineMarkdown, `\`\` ${source} \`\``);

  const blockMarkdown = richTextToMarkdown({
    type: 'doc',
    content: [{
      type: 'codeBlock',
      attrs: { language: 'text' },
      content: [{ type: 'text', text: source }],
    }],
  });
  assert.equal(blockMarkdown, `\`\`\`text\n${source}\n\`\`\``);
});

test('Rich Text PDF HTML escapes text and emits only validated absolute links and inert asset cards', () => {
  const html = richTextToSafeHtml(richTextFixture());
  assert.match(html, /<strong>Safe &amp; <\/strong>/);
  assert.match(html, /href="https:\/\/example\.com\/docs"/);
  assert.match(html, /&lt;literal&gt;/);
  assert.match(html, /Architecture diagram/);
  assert.match(html, /roadmap\.pdf/);
  assert.doesNotMatch(html, /<img|objectId|assetKey|ciphertextSha256/);
});

test('Print documents isolate content with CSP, print CSS, and escaped titles', () => {
  const document = buildNotePrintDocument('</title><script>alert(1)</script>', '<p>Safe body</p>');
  assert.match(document, /Content-Security-Policy/);
  assert.match(document, /default-src 'none'/);
  assert.match(document, /@page\{size:A4/);
  assert.match(document, /&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(document, /<script>alert/);
});

test('Export byte sizes stay compact and stable', () => {
  assert.equal(formatByteSize(42), '42 B');
  assert.equal(formatByteSize(1_024), '1.0 KiB');
  assert.equal(formatByteSize(12_345), '12 KiB');
  assert.equal(formatByteSize(5 * 1_024 * 1_024), '5.0 MiB');
});
