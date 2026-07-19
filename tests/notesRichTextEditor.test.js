const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

async function readEditorSource() {
  return readFile(path.join(root, 'src', 'renderer', 'notesRichTextEditor.ts'), 'utf8');
}

test('rich text adapter uses Tiptap with a JSON-only S3 image node', async () => {
  const source = await readEditorSource();
  assert.match(source, /import \{ Editor,[\s\S]*from '@tiptap\/core'/);
  assert.match(source, /import Image from '@tiptap\/extension-image'/);
  assert.match(source, /import StarterKit from '@tiptap\/starter-kit'/);
  assert.match(source, /return Image\.extend\(\{\s*name: 's3Image'/);

  const attributeStart = source.indexOf('    addAttributes() {');
  const attributeEnd = source.indexOf('    // Rich text is loaded only', attributeStart);
  assert.notEqual(attributeStart, -1);
  assert.notEqual(attributeEnd, -1);
  const attributes = source.slice(attributeStart, attributeEnd);
  const names = [...attributes.matchAll(/^\s{8}([A-Za-z][A-Za-z0-9]*): \{ default: null \},$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(names, [
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
  assert.doesNotMatch(attributes, /\bsrc\b|\btitle\b/);

  assert.match(source, /parseHTML\(\) \{\s*return \[\];\s*\}/);
  assert.match(source, /addInputRules\(\) \{\s*return \[\];\s*\}/);
  assert.match(source, /addPasteRules\(\) \{\s*return \[\];\s*\}/);
  assert.match(source, /addCommands\(\) \{[\s\S]*?return \{\};\s*\}/);
  assert.match(source, /parseMarkdown\(\) \{\s*return \[\];\s*\}/);
  assert.match(source, /renderHTML\(\) \{[\s\S]*?notes-richtext-image-serialized/);
  assert.doesNotMatch(source, /renderHTML\([^)]*HTMLAttributes/);
});

test('S3 image NodeView owns Blob URLs and exposes only safe UI states', async () => {
  const source = await readEditorSource();
  const nodeViewStart = source.indexOf('function createS3ImageNodeView(');
  const nodeViewEnd = source.indexOf('function createS3ImageExtension(', nodeViewStart);
  assert.notEqual(nodeViewStart, -1);
  assert.notEqual(nodeViewEnd, -1);
  const nodeView = source.slice(nodeViewStart, nodeViewEnd);

  assert.match(nodeView, /parseNoteImageReference\(node\.attrs\)/);
  assert.match(nodeView, /await loadNoteImage\(reference\)/);
  assert.match(nodeView, /URL\.createObjectURL\(new Blob\(\[imageBytes\]/);
  assert.match(nodeView, /URL\.revokeObjectURL\(objectUrl\)/);
  assert.match(nodeView, /if \(referenceKey === requestedReferenceKey\) return/);
  assert.match(nodeView, /destroy\(\): void \{[\s\S]*?loadGeneration \+= 1;[\s\S]*?revokeObjectUrl\(\)/);
  assert.match(nodeView, /updatedNode\.type\.name !== 's3Image'/);
  assert.match(nodeView, /showState\('not-configured', 'Configure S3 to view this image\.'\)/);
  assert.match(nodeView, /showState\('missing', 'Image is unavailable\.'\)/);
  assert.match(nodeView, /showState\('error', 'Unable to load image\.'\)/);
  assert.match(nodeView, /image\.src = nextObjectUrl/);
  assert.doesNotMatch(nodeView, /setAttribute\([^\n]*(?:assetKey|ciphertextSha256|contentSha256|objectId)/);
  assert.doesNotMatch(nodeView, /image\.src = reference\./);
});

test('rich text adapter normalizes persistence and provides the complete toolbar API', async () => {
  const source = await readEditorSource();
  for (const name of [
    'setContent',
    'getContent',
    'getPlainText',
    'focus',
    'requestMeasure',
    'insertImage',
    'run',
    'runToolbarCommand',
    'destroy',
  ]) {
    assert.match(source, new RegExp(`public ${name}\\(`));
  }

  assert.match(source, /normalizeRichTextContent\(\s*value === undefined \|\| value === null \? EMPTY_RICH_TEXT_CONTENT : value/);
  assert.match(source, /setContent\(parseRichTextContent\(normalized\), \{/);
  assert.match(source, /normalizeRichTextContent\(this\.editor\.getJSON\(\)\)/);
  assert.match(source, /extractRichTextPlainText\(this\.editor\.getJSON\(\)\)/);
  assert.match(source, /this\.onUpdate\(this\.getContent\(\)\)/);
  assert.match(source, /type: 's3Image',\s*attrs: reference/);

  const expectedCommands = [
    'undo',
    'redo',
    'bold',
    'italic',
    'strike',
    'code',
    'heading',
    'bulletList',
    'orderedList',
    'blockquote',
  ];
  for (const command of expectedCommands) {
    assert.match(source, new RegExp(`case '${command}'`));
  }
  assert.match(source, /\[data-richtext-command\]/);
  assert.match(source, /control\.classList\.toggle\('is-active', active\)/);
  assert.match(source, /control\.dataset\.active = String\(active\)/);
  assert.match(source, /delete control\.dataset\.active/);
  assert.match(source, /control\.setAttribute\('aria-pressed', String\(active\)\)/);
  assert.match(source, /control\.disabled = disabled/);
});
