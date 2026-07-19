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
  assert.match(source, /import \{[\s\S]*?\bEditor,[\s\S]*?from '@tiptap\/core'/);
  assert.match(source, /import Image from '@tiptap\/extension-image'/);
  assert.match(source, /import StarterKit from '@tiptap\/starter-kit'/);
  assert.match(source, /return Image\.extend\(\{\s*name: 's3Image'/);

  const imageExtensionStart = source.indexOf("function createS3ImageExtension(onError: (message: string) => void)");
  assert.notEqual(imageExtensionStart, -1);
  const imageExtension = source.slice(imageExtensionStart);
  const attributeStart = source.indexOf('    addAttributes() {', imageExtensionStart);
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

  assert.match(imageExtension, /parseHTML\(\) \{\s*return \[\];\s*\}/);
  assert.match(imageExtension, /addInputRules\(\) \{\s*return \[\];\s*\}/);
  assert.match(imageExtension, /addPasteRules\(\) \{\s*return \[\];\s*\}/);
  assert.match(imageExtension, /addCommands\(\) \{[\s\S]*?return \{\};\s*\}/);
  assert.match(imageExtension, /parseMarkdown\(\) \{\s*return \[\];\s*\}/);
  assert.match(imageExtension, /renderHTML\(\) \{[\s\S]*?notes-richtext-image-serialized/);
  assert.doesNotMatch(imageExtension, /renderHTML\([^)]*HTMLAttributes/);
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
  assert.match(source, /normalizeRichTextContent\(stripTiptapLinkDefaults\(value\)\)/);
  assert.match(source, /return normalizeEditorContent\(this\.editor\.getJSON\(\)\)/);
  assert.match(source, /extractRichTextPlainText\(this\.getContent\(\)\)/);
  assert.match(source, /type: 's3Image',\s*attrs: reference/);

  const expectedCommands = [
    'undo',
    'redo',
    'bold',
    'italic',
    'underline',
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

test('rich text provides the requested Novel-style slash blocks without embeds or AI actions', async () => {
  const source = await readEditorSource();
  const slashStart = source.indexOf('    this.commandItems = [');
  const slashEnd = source.indexOf('    ];', slashStart);
  assert.notEqual(slashStart, -1);
  assert.notEqual(slashEnd, -1);
  const slashSource = source.slice(slashStart, slashEnd);
  const expectedTitles = [
    'Text',
    'To-do List',
    'Heading 1',
    'Heading 2',
    'Heading 3',
    'Bullet List',
    'Numbered List',
    'Quote',
    'Code',
    'Image',
  ];
  assert.deepEqual(
    [...slashSource.matchAll(/title: '([^']+)'/g)].map((match) => match[1]),
    expectedTitles,
  );
  assert.doesNotMatch(slashSource, /feedback|youtube|twitter|ask\s*ai/i);
  assert.match(source, /class NotesRichTextSlashMenu/);
  assert.match(source, /if \(editor\.isActive\('codeBlock'\)\) return undefined/);
  assert.match(source, /event\.key === 'ArrowDown'/);
  assert.match(source, /event\.key === 'Enter'/);
  assert.match(source, /empty\.textContent = 'No results'/);
  assert.match(source, /coordsAtPos\(this\.range\.to\)/);
  assert.match(source, /scrollIntoView\(\{ block: 'nearest' \}\)/);
  assert.match(source, /createTaskListExtension\(\)/);
  assert.match(source, /createTaskItemExtension\(\)/);
  assert.match(source, /checked: checkbox\.checked/);
  assert.match(source, /Enter: \(\) => this\.editor\.commands\.splitListItem\(this\.name\)/);
  assert.match(source, /Tab: \(\) => this\.editor\.commands\.sinkListItem\(this\.name\)/);
  assert.match(source, /'Shift-Tab': \(\) => this\.editor\.commands\.liftListItem\(this\.name\)/);
  assert.match(source, /aria-label', 'Mark task complete'/);
});

test('rich text uses a selection-only non-AI formatter with safe block and link controls', async () => {
  const source = await readEditorSource();
  assert.match(source, /class NotesRichTextBubbleMenu/);
  assert.match(source, /hasFormattableSelection\(this\.editor\)/);
  assert.match(source, /posToDOMRect\(this\.editor\.view, selection\.from, selection\.to\)/);
  assert.match(source, /RICH_TEXT_BLOCK_ITEMS:[\s\S]*?label: 'Text'[\s\S]*?label: 'To-do List'[\s\S]*?label: 'Heading 1'[\s\S]*?label: 'Heading 2'[\s\S]*?label: 'Heading 3'[\s\S]*?label: 'Bullet List'[\s\S]*?label: 'Numbered List'[\s\S]*?label: 'Quote'[\s\S]*?label: 'Code'/);
  assert.match(source, /case 'underline': return chain\.toggleUnderline\(\)/);
  assert.match(source, /isAllowedRichTextLinkHref\(href\)/);
  assert.match(source, /extendMarkRange\('link'\)\.unsetLink\(\)/);
  assert.match(source, /chain\.setLink\(\{ href \}\)\.run\(\)/);
  assert.doesNotMatch(source, /Ask AI|askAI|GenerativeMenu|AISelector/);
});

test('rich text routes pasted and dropped image files through the existing S3 upload flow', async () => {
  const source = await readEditorSource();
  assert.match(source, /handlePaste: \(view, event\) => \{[\s\S]*?firstImageFile\(event\.clipboardData\?\.files\)[\s\S]*?options\.onRequestImage\(file, view\.state\.selection\.to\)/);
  assert.match(source, /handleDrop: \(view, event, _slice, moved\) => \{[\s\S]*?firstImageFile\(event\.dataTransfer\?\.files\)[\s\S]*?view\.posAtCoords\([\s\S]*?options\.onRequestImage\(file, position\)/);
  assert.match(source, /insertAt !== undefined[\s\S]*?insertContentAt\(insertAt, content\)[\s\S]*?insertContent\(content\)/);
});

test('Tiptap Link uses the canonical absolute-http policy and never opens a browser window', async () => {
  const source = await readEditorSource();
  assert.match(source, /StarterKit\.configure\(\{[\s\S]*?link:\s*\{[\s\S]*?openOnClick:\s*false/);
  assert.match(source, /enableClickSelection:\s*false/);
  assert.match(source, /protocols:\s*\[\]/);
  assert.match(source, /defaultProtocol:\s*'https'/);
  assert.match(source, /isAllowedUri:\s*\(url\)\s*=>\s*isAllowedRichTextLinkHref\(url\)/);
  assert.match(source, /shouldAutoLink:\s*\(url\)\s*=>\s*isAllowedRichTextLinkHref\(url\)/);
  assert.doesNotMatch(source, /window\.open\s*\(/);
  assert.match(source, /handleClick:\s*\(_view, _position, event\)\s*=>\s*\{[\s\S]*?source\.closest\('a\[href\]'\)[\s\S]*?event\.preventDefault\(\);[\s\S]*?return true/);

  const stripStart = source.indexOf('function stripTiptapLinkDefaults(');
  const stripEnd = source.indexOf('function normalizeEditorContent(', stripStart);
  assert.notEqual(stripStart, -1);
  assert.notEqual(stripEnd, -1);
  const strip = source.slice(stripStart, stripEnd);
  assert.match(strip, /result\.attrs\.class === null/);
  assert.match(strip, /const \{ class: _class, \.\.\.attrs \} = result\.attrs/);
  assert.doesNotMatch(strip, /delete\s+result\.attrs\.(?:target|rel|href)/);
});

test('invalid editor updates roll back to the latest successfully emitted canonical content', async () => {
  const source = await readEditorSource();
  assert.match(source, /private lastCanonicalContent = EMPTY_RICH_TEXT_CONTENT/);
  assert.match(source, /private restoringCanonicalContent = false/);
  assert.match(source, /this\.lastCanonicalContent = normalized/);
  assert.match(source, /if \(this\.restoringCanonicalContent\) return/);
  assert.match(source, /const content = this\.getContent\(\);[\s\S]*?this\.onUpdate\(content\);[\s\S]*?this\.lastCanonicalContent = content/);
  assert.match(source, /catch \(error\) \{[\s\S]*?this\.restoreLastCanonicalContent\(\);[\s\S]*?safelyReport/);
  assert.match(source, /private restoreLastCanonicalContent\(\): void \{[\s\S]*?parseRichTextContent\(this\.lastCanonicalContent\)[\s\S]*?emitUpdate: false[\s\S]*?errorOnInvalidContent: true/);
  assert.match(source, /finally \{\s*this\.restoringCanonicalContent = false/);
});
