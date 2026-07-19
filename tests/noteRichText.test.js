const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EMPTY_RICH_TEXT_CONTENT,
  RICH_TEXT_LIMITS,
  extractRichTextPlainText,
  normalizeRichTextContent,
  parseNoteImageReference,
  parseRichTextContent,
} = require('../dist/shared/noteRichText');

const imageReference = (overrides = {}) => ({
  objectId: Buffer.alloc(24, 0x2a).toString('base64url'),
  assetKey: Buffer.alloc(32, 0x3b).toString('base64url'),
  ciphertextSha256: 'a'.repeat(64),
  contentSha256: 'b'.repeat(64),
  mimeType: 'image/webp',
  byteLength: 4096,
  width: 640,
  height: 480,
  alt: 'Architecture diagram',
  ...overrides,
});

test('rich text content is normalized to one bounded canonical Tiptap JSON representation', () => {
  const input = JSON.stringify({
    content: [{
      content: [{
        marks: [
          { type: 'bold', attrs: {} },
          {
            attrs: {
              class: null,
              rel: 'noreferrer noopener noreferrer',
              target: '_blank',
              href: 'https://example.test/docs?q=1',
              title: '',
            },
            type: 'link',
          },
        ],
        text: 'Read the guide',
        type: 'text',
      }],
      type: 'paragraph',
    }, {
      attrs: { language: 'typescript' },
      content: [{ type: 'text', text: 'const answer = 42;' }],
      type: 'codeBlock',
    }],
    type: 'doc',
  }, null, 2);

  const normalized = normalizeRichTextContent(input);
  assert.equal(normalized, JSON.stringify({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{
        type: 'text',
        marks: [{
          type: 'link',
          attrs: {
            href: 'https://example.test/docs?q=1',
            target: '_blank',
            rel: 'noopener noreferrer',
          },
        }, { type: 'bold' }],
        text: 'Read the guide',
      }],
    }, {
      type: 'codeBlock',
      attrs: { language: 'typescript' },
      content: [{ type: 'text', text: 'const answer = 42;' }],
    }],
  }));
  assert.equal(normalizeRichTextContent(normalized), normalized);
  assert.deepEqual(parseRichTextContent(normalized), JSON.parse(normalized));
  assert.equal(extractRichTextPlainText(normalized), 'Read the guide\nconst answer = 42;');
  assert.equal(normalizeRichTextContent(''), EMPTY_RICH_TEXT_CONTENT);
  assert.equal(normalizeRichTextContent({ type: 'doc', content: [] }), EMPTY_RICH_TEXT_CONTENT);
  assert.equal(normalizeRichTextContent({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text: 'joined ' }, { type: 'text', text: 'text' }],
    }],
  }), '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"joined text"}]}]}');
  assert.equal(normalizeRichTextContent({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{
        type: 'text',
        text: 'default link',
        marks: [{ type: 'link', attrs: { href: 'https://example.test' } }],
      }],
    }],
  }), '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","marks":[{"type":"link","attrs":{"href":"https://example.test","target":"_blank","rel":"nofollow noopener noreferrer"}}],"text":"default link"}]}]}');
});

test('canonical rich text round-trips through the configured Tiptap schema without drift', async () => {
  const [{ getSchema }, { default: StarterKit }, { default: Image }] = await Promise.all([
    import('@tiptap/core'),
    import('@tiptap/starter-kit'),
    import('@tiptap/extension-image'),
  ]);
  const S3Image = Image.extend({
    name: 's3Image',
    addAttributes() {
      return {
        objectId: { default: null },
        assetKey: { default: null },
        ciphertextSha256: { default: null },
        contentSha256: { default: null },
        mimeType: { default: null },
        byteLength: { default: null },
        width: { default: null },
        height: { default: null },
        alt: { default: null },
      };
    },
  });
  const schema = getSchema([StarterKit, S3Image]);
  const canonical = normalizeRichTextContent({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{
        type: 'text',
        text: 'Read safely',
        marks: [{ type: 'link', attrs: { href: 'https://example.test' } }, { type: 'bold' }],
      }],
    }, {
      type: 'orderedList',
      attrs: { start: 2, type: null },
      content: [{
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }],
      }],
    }, {
      type: 's3Image',
      attrs: imageReference(),
    }],
  });

  const tiptapJson = schema.nodeFromJSON(JSON.parse(canonical)).toJSON();
  assert.equal(normalizeRichTextContent(tiptapJson), canonical);
});

test('s3Image nodes retain only strict non-URL S3 asset references and searchable alt text', () => {
  const reference = imageReference();
  assert.deepEqual(parseNoteImageReference(reference), reference);
  const content = normalizeRichTextContent({
    type: 'doc',
    content: [{ type: 's3Image', attrs: reference }],
  });
  assert.deepEqual(JSON.parse(content), {
    type: 'doc',
    content: [{ type: 's3Image', attrs: reference }],
  });
  assert.equal(extractRichTextPlainText(content), reference.alt);

  assert.throws(
    () => parseNoteImageReference({ ...reference, src: 'data:image/png;base64,AA==' }),
    /unsupported field/,
  );
  assert.throws(
    () => parseNoteImageReference({ ...reference, assetKey: `${reference.assetKey.slice(0, -1)}B` }),
    /asset key is invalid/,
  );
  assert.throws(
    () => parseNoteImageReference({ ...reference, mimeType: 'image/gif' }),
    /MIME type is invalid/,
  );
  assert.throws(
    () => parseNoteImageReference({ ...reference, byteLength: RICH_TEXT_LIMITS.imageBytes + 1 }),
    /size is invalid/,
  );
  assert.throws(
    () => parseNoteImageReference({ ...reference, width: 8_000, height: 8_000 }),
    /dimensions are too large/,
  );
  assert.throws(
    () => parseNoteImageReference({ ...reference, alt: 'x'.repeat(RICH_TEXT_LIMITS.imageAltCharacters + 1) }),
    /alternative text is invalid/,
  );
});

test('rich text rejects HTML, unsafe links, foreign attributes, invalid structure, and excessive depth', () => {
  for (const href of [
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'blob:https://example.test/id',
    'file:///tmp/private',
  ]) {
    assert.throws(() => normalizeRichTextContent({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'text',
          text: 'unsafe',
          marks: [{ type: 'link', attrs: { href } }],
        }],
      }],
    }), /link protocol is not supported/);
  }

  assert.throws(
    () => normalizeRichTextContent({ type: 'doc', content: [{ type: 'html', text: '<b>unsafe</b>' }] }),
    /node is not supported/,
  );
  assert.throws(
    () => normalizeRichTextContent({ type: 'doc', content: [{ type: 'paragraph', attrs: { innerHTML: 'x' } }] }),
    /unsupported field/,
  );
  assert.throws(
    () => normalizeRichTextContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'paragraph' }] }],
    }),
    /invalid location/,
  );

  let nested = { type: 'paragraph' };
  for (let index = 0; index < RICH_TEXT_LIMITS.depth; index += 1) {
    nested = { type: 'blockquote', content: [nested] };
  }
  assert.throws(
    () => normalizeRichTextContent({ type: 'doc', content: [nested] }),
    /nested too deeply/,
  );

  assert.throws(
    () => normalizeRichTextContent({
      type: 'doc',
      content: Array.from({ length: RICH_TEXT_LIMITS.nodes }, () => ({ type: 'paragraph' })),
    }),
    /too many nodes/,
  );
  assert.throws(
    () => normalizeRichTextContent({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'x'.repeat(RICH_TEXT_LIMITS.textCharacters + 1) }],
      }],
    }),
    /too much text/,
  );
});
