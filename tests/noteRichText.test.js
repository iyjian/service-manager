const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EMPTY_RICH_TEXT_CONTENT,
  RICH_TEXT_LIMITS,
  extractRichTextPlainText,
  isAllowedRichTextLinkHref,
  normalizeRichTextContent,
  parseNoteImageNodeAttributes,
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

test('rich text task lists preserve a bounded checked state and safe structure', () => {
  const normalized = normalizeRichTextContent({
    type: 'doc',
    content: [{
      type: 'taskList',
      content: [{
        type: 'taskItem',
        attrs: { checked: true },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Publish the release' }] }],
      }],
    }],
  });
  assert.equal(normalized, JSON.stringify({
    type: 'doc',
    content: [{
      type: 'taskList',
      content: [{
        type: 'taskItem',
        attrs: { checked: true },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Publish the release' }] }],
      }],
    }],
  }));
  assert.equal(extractRichTextPlainText(normalized), 'Publish the release');

  assert.throws(() => normalizeRichTextContent({
    type: 'doc',
    content: [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: 'yes' }, content: [{ type: 'paragraph' }] }] }],
  }), /checked state is invalid/);
  assert.throws(() => normalizeRichTextContent({
    type: 'doc',
    content: [{ type: 'taskList', content: [{ type: 'taskItem', content: [{ type: 'heading', attrs: { level: 1 } }] }] }],
  }), /must start with a paragraph/);
});

test('rich text safely canonicalizes the bounded Novel math and color model', () => {
  const normalized = normalizeRichTextContent({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{
        type: 'text',
        text: 'Energy ',
        marks: [
          { type: 'highlight', attrs: { color: '#dbeafe' } },
          { type: 'textStyle', attrs: { color: '#2563eb' } },
          { type: 'underline' },
        ],
      }, {
        type: 'math',
        attrs: { latex: 'E=mc^2' },
      }],
    }],
  });
  assert.deepEqual(JSON.parse(normalized), {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{
        type: 'text',
        marks: [
          { type: 'underline' },
          { type: 'textStyle', attrs: { color: '#2563EB' } },
          { type: 'highlight', attrs: { color: '#DBEAFE' } },
        ],
        text: 'Energy ',
      }, {
        type: 'math',
        attrs: { latex: 'E=mc^2' },
      }],
    }],
  });
  assert.equal(extractRichTextPlainText(normalized), 'Energy E=mc^2');

  for (const [type, color] of [
    ['textStyle', 'red'],
    ['textStyle', '#FFFFFF'],
    ['textStyle', 'var(--secret)'],
    ['highlight', '#000000'],
    ['highlight', 'url(https://example.test/pixel)'],
    ['highlight', '#DBEAFE;display:none'],
  ]) {
    assert.throws(() => normalizeRichTextContent({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'unsafe', marks: [{ type, attrs: { color } }] }],
      }],
    }), /rich text (?:textStyle|highlight) color is invalid/i);
  }
  assert.throws(() => normalizeRichTextContent({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{
        type: 'text',
        text: 'foreign color field',
        marks: [{ type: 'textStyle', attrs: { color: '#2563EB', style: 'display:none' } }],
      }],
    }],
  }), /unsupported field/);

  for (const math of [
    { type: 'math' },
    { type: 'math', attrs: { latex: '' } },
    { type: 'math', attrs: { latex: 'x'.repeat(RICH_TEXT_LIMITS.mathCharacters + 1) } },
    { type: 'math', attrs: { latex: 'x\u0000y' } },
    { type: 'math', attrs: { latex: 'x', onclick: 'run()' } },
  ]) {
    assert.throws(() => normalizeRichTextContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [math] }],
    }), /rich text math/i);
  }
  assert.throws(() => normalizeRichTextContent({
    type: 'doc',
    content: [{ type: 'math', attrs: { latex: 'x' } }],
  }), /invalid location/);
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
        displayWidth: { default: null },
        alignment: { default: null },
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
      attrs: { ...imageReference(), displayWidth: 360, alignment: 'center' },
    }],
  });

  const tiptapJson = schema.nodeFromJSON(JSON.parse(canonical)).toJSON();
  assert.throws(() => normalizeRichTextContent(tiptapJson), /unsupported field/);
  for (const block of tiptapJson.content ?? []) {
    for (const inline of block.content ?? []) {
      for (const mark of inline.marks ?? []) {
        if (mark.type === 'link' && mark.attrs?.class === null) delete mark.attrs.class;
      }
    }
  }
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
  assert.throws(
    () => parseNoteImageReference({ ...reference, displayWidth: 320 }),
    /image reference contains an unsupported field/,
  );
  assert.throws(
    () => parseNoteImageReference({ ...reference, alignment: 'center' }),
    /image reference contains an unsupported field/,
  );
});

test('s3Image node attributes canonicalize bounded display width and alignment independently', () => {
  const reference = imageReference();
  const attributes = { ...reference, displayWidth: 360, alignment: 'center' };
  assert.deepEqual(parseNoteImageNodeAttributes(attributes), attributes);

  const normalized = normalizeRichTextContent({
    type: 'doc',
    content: [{ type: 's3Image', attrs: attributes }],
  });
  assert.deepEqual(JSON.parse(normalized), {
    type: 'doc',
    content: [{ type: 's3Image', attrs: attributes }],
  });
  assert.equal(extractRichTextPlainText(normalized), reference.alt);

  assert.deepEqual(parseNoteImageNodeAttributes({ ...reference, displayWidth: null }), reference);
  assert.deepEqual(parseNoteImageNodeAttributes({ ...reference, alignment: null }), reference);
  assert.deepEqual(parseNoteImageNodeAttributes({ ...reference, alignment: 'left' }), reference);
  assert.deepEqual(parseNoteImageNodeAttributes({ ...reference, alignment: 'center' }), {
    ...reference,
    alignment: 'center',
  });
  assert.deepEqual(parseNoteImageNodeAttributes({ ...reference, alignment: 'right' }), {
    ...reference,
    alignment: 'right',
  });
  assert.deepEqual(parseNoteImageNodeAttributes({ ...reference, displayWidth: 48 }), {
    ...reference,
    displayWidth: 48,
  });
  assert.deepEqual(parseNoteImageNodeAttributes({
    ...reference,
    displayWidth: RICH_TEXT_LIMITS.imageDimension,
  }), {
    ...reference,
    displayWidth: RICH_TEXT_LIMITS.imageDimension,
  });

  for (const displayWidth of [
    47,
    RICH_TEXT_LIMITS.imageDimension + 1,
    320.5,
    '320',
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.throws(
      () => parseNoteImageNodeAttributes({ ...reference, displayWidth }),
      /image display width is invalid/,
    );
  }
  assert.throws(
    () => parseNoteImageNodeAttributes({ ...reference, displayWidth: 320, src: 'blob:renderer-only' }),
    /image attributes contains an unsupported field/,
  );
  for (const alignment of ['', 'Left', 'centre', ' left ', 1, false, {}]) {
    assert.throws(
      () => parseNoteImageNodeAttributes({ ...reference, alignment }),
      /image alignment is invalid/,
    );
  }
});

test('rich text allows only absolute http/https links with canonical safe attributes', () => {
  assert.equal(isAllowedRichTextLinkHref('https://example.test/docs?q=1#part'), true);
  assert.equal(isAllowedRichTextLinkHref('http://127.0.0.1:8080/path'), true);
  for (const href of [
    'mailto:user@example.test',
    'ftp://example.test/file',
    'tel:+123456789',
    '/relative/path',
    './relative/path',
    'example.test/no-protocol',
    'http:example.test/no-slashes',
    'https://example.test\\backslash',
    'https://user:secret@example.test/private',
  ]) {
    assert.equal(isAllowedRichTextLinkHref(href), false);
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
    }), /rich text link/i);
  }

  const safeLinkDocument = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{
        type: 'text',
        text: 'safe',
        marks: [{
          type: 'link',
          attrs: {
            href: 'https://example.test/docs',
            target: '_blank',
            rel: 'noreferrer',
            title: 'Documentation',
          },
        }],
      }],
    }],
  };
  assert.match(normalizeRichTextContent(safeLinkDocument), /"target":"_blank","rel":"noopener noreferrer"/);
  assert.throws(() => normalizeRichTextContent({
    ...safeLinkDocument,
    content: [{
      type: 'paragraph',
      content: [{
        type: 'text',
        text: 'same window',
        marks: [{ type: 'link', attrs: { href: 'https://example.test', target: '_self' } }],
      }],
    }],
  }), /link target is invalid/);
  for (const attrs of [
    { href: 'https://example.test', class: null },
    { href: 'https://example.test', onclick: 'window.open()' },
    { href: 'https://example.test', download: 'secret' },
  ]) {
    assert.throws(() => normalizeRichTextContent({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'foreign', marks: [{ type: 'link', attrs }] }],
      }],
    }), /unsupported field/);
  }
});

test('rich text rejects HTML, unsafe links, invalid structure, and excessive depth', () => {
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
    }), /rich text link/i);
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
