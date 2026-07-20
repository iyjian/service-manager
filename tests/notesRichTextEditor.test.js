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
  assert.match(source, /import \{ TableKit \} from '@tiptap\/extension-table'/);
  assert.match(source, /import StarterKit from '@tiptap\/starter-kit'/);
  assert.match(source, /return Image\.extend\(\{\s*name: 's3Image'/);

  const imageExtensionStart = source.indexOf('function createS3ImageExtension(');
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
    'displayWidth',
    'alignment',
  ]);
  assert.doesNotMatch(attributes, /\bsrc\b|\btitle\b/);

  assert.match(imageExtension, /parseHTML\(\) \{\s*if \(!importImages \|\| !importToken\) return \[\];/);
  assert.match(imageExtension, /tag: 'div\[data-trilium-import-image\]'/);
  assert.match(imageExtension, /const prefix = `\$\{importToken\}:`/);
  assert.match(imageExtension, /addInputRules\(\) \{\s*return \[\];\s*\}/);
  assert.match(imageExtension, /addPasteRules\(\) \{\s*return \[\];\s*\}/);
  assert.match(imageExtension, /addCommands\(\) \{[\s\S]*?return \{\};\s*\}/);
  assert.match(imageExtension, /parseMarkdown\(\) \{\s*return \[\];\s*\}/);
  assert.match(imageExtension, /renderHTML\(\) \{[\s\S]*?notes-richtext-image-serialized/);
  assert.doesNotMatch(imageExtension, /renderHTML\([^)]*HTMLAttributes/);
});

test('S3 image NodeView owns Blob URLs, strips layout metadata from loads, and exposes only safe UI states', async () => {
  const source = await readEditorSource();
  const nodeViewStart = source.indexOf('function createS3ImageNodeView(');
  const nodeViewEnd = source.indexOf('function createS3ImageExtension(', nodeViewStart);
  assert.notEqual(nodeViewStart, -1);
  assert.notEqual(nodeViewEnd, -1);
  const nodeView = source.slice(nodeViewStart, nodeViewEnd);

  assert.match(nodeView, /parseNoteImageNodeAttributes\(node\.attrs\)/);
  assert.match(nodeView, /displayWidth: _displayWidth,[\s\S]*?alignment: _alignment,[\s\S]*?\.\.\.assetReference/);
  assert.match(nodeView, /parseNoteImageReference\(assetReference\)/);
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
    'math',
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
    'Table',
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
  assert.match(source, /this\.updateSelection\(\)/);
  assert.match(source, /revealMenuItemScrollTop\(\{/);
  assert.doesNotMatch(source, /scrollIntoView\(/);
  assert.match(source, /createTaskListExtension\(\)/);
  assert.match(source, /createTaskItemExtension\(\)/);
  assert.match(source, /checked: checkbox\.checked/);
  assert.match(source, /Enter: \(\) => this\.editor\.commands\.splitListItem\(this\.name\)/);
  assert.match(source, /Tab: \(\) => this\.editor\.commands\.sinkListItem\(this\.name\)/);
  assert.match(source, /'Shift-Tab': \(\) => this\.editor\.commands\.liftListItem\(this\.name\)/);
  assert.match(source, /aria-label', 'Mark task complete'/);
});

test('empty To-do does not inherit the empty-editor slash hint', async () => {
  const source = await readEditorSource();
  assert.match(source, /documentNode\.childCount === 1/);
  assert.match(source, /documentNode\.firstChild\?\.type\.name === 'paragraph'/);
  assert.match(source, /classList\.toggle\('is-editor-empty', showRootPlaceholder\)/);
  assert.match(source, /delete editorElement\.dataset\.placeholder/);
  assert.doesNotMatch(source, /notes-richtext-node-placeholder/);
});

test('slash menu reveal math keeps keyboard selection inside its own scrolling viewport', async () => {
  const { revealMenuItemScrollTop } = await import('../dist/renderer/notesRichTextMenuScroll.js');
  const base = {
    scrollHeight: 496,
    clientHeight: 330,
    itemHeight: 48,
    paddingTop: 8,
    paddingBottom: 8,
  };

  assert.equal(revealMenuItemScrollTop({ ...base, scrollTop: 0, itemTop: 8 }), 0);
  assert.equal(revealMenuItemScrollTop({ ...base, scrollTop: 0, itemTop: 440 }), 166);
  assert.equal(revealMenuItemScrollTop({ ...base, scrollTop: 166, itemTop: 8 }), 0);
  assert.equal(revealMenuItemScrollTop({ ...base, scrollTop: 72, itemTop: 200 }), 72);
});

test('rich text uses a Novel-style selection-only formatter without Ask AI', async () => {
  const source = await readEditorSource();
  assert.match(source, /class NotesRichTextBubbleMenu/);
  assert.match(source, /this\.editor\.isEditable && hasFormattableSelection\(this\.editor\)/);
  assert.match(source, /posToDOMRect\(this\.editor\.view, selection\.from, selection\.to\)/);
  const blockItemsStart = source.indexOf('const RICH_TEXT_BLOCK_ITEMS:');
  const blockItemsEnd = source.indexOf('] as const;', blockItemsStart);
  assert.ok(blockItemsStart >= 0 && blockItemsEnd > blockItemsStart);
  assert.deepEqual(
    [...source.slice(blockItemsStart, blockItemsEnd).matchAll(/label: '([^']+)'/g)].map((match) => match[1]),
    ['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'To-do List', 'Bullet List', 'Numbered List', 'Quote', 'Code'],
  );
  assert.match(source, /const chain = this\.editor\.chain\(\)\.focus\(\)\.clearNodes\(\)/);
  assert.match(source, /case 'heading1': chain\.toggleHeading\(\{ level: 1 \}\)\.run\(\)/);
  assert.match(source, /activeItems\.length === 1 \? activeItems\[0\] : undefined/);
  assert.match(source, /this\.blockLabel\.textContent = activeItem\?\.label \?\? 'Multiple'/);
  assert.match(source, /notes-richtext-block-icon/);
  assert.match(source, /notes-richtext-block-check/);
  assert.match(source, /this\.positionPopover\(this\.blockMenu, this\.blockTrigger\)/);
  assert.match(source, /event\.key !== 'Escape'/);
  assert.match(source, /case 'underline': return chain\.toggleUnderline\(\)/);
  assert.match(source, /case 'math': return chain/);
  assert.match(source, /isAllowedRichTextLinkHref\(href\)/);
  assert.match(source, /extendMarkRange\('link'\)\.unsetLink\(\)/);
  assert.match(source, /chain\.setLink\(\{ href \}\)\.run\(\)/);
  assert.match(source, /this\.linkInput\.placeholder = 'Paste a link'/);
  assert.match(source, /this\.applyLinkButton\.hidden = linkActive/);
  assert.match(source, /this\.removeLinkButton\.hidden = !linkActive/);
  assert.doesNotMatch(source, /Ask AI|askAI|GenerativeMenu|AISelector/);
});

test('Novel-style math and color controls use closed renderer extensions and canonical commands', async () => {
  const source = await readEditorSource();

  for (const factory of ['createTextStyleExtension', 'createHighlightExtension', 'createMathExtension']) {
    const start = source.indexOf(`function ${factory}(`);
    const end = source.indexOf('\nfunction ', start + 1);
    assert.ok(start >= 0 && end > start, `${factory} must be present`);
    assert.match(source.slice(start, end), /parseHTML\(\) \{\s*return \[\];\s*\}/);
  }
  assert.match(source, /name: 'textStyle'[\s\S]*?excludes: 'code'/);
  assert.match(source, /name: 'highlight'[\s\S]*?excludes: 'code'/);
  assert.match(source, /name: 'math'[\s\S]*?inline: true[\s\S]*?atom: true[\s\S]*?marks: ''/);
  assert.match(source, /insertContentAt\(\{ from: selection\.from, to: selection\.to \}, \{\s*type: 'math',\s*attrs: \{ latex \}/);
  assert.match(source, /if \(!inserted\) return false;\s*return this\.editor\.commands\.setTextSelection\(\{\s*from: selection\.from,\s*to: selection\.from \+ 1/);
  assert.match(source, /if \(this\.editor\.isActive\('math'\)\)[\s\S]*?tr\.insertText\(latex, selection\.from, selection\.to\)/);
  assert.match(source, /latex\.length > RICH_TEXT_LIMITS\.mathCharacters/);
  assert.match(source, /doc\.nodesBetween\(selection\.from, selection\.to,[\s\S]*?node\.type\.name === 'math'/);
  assert.match(source, /appendColorSection\('Color', 'text', RICH_TEXT_COLORS\)/);
  assert.match(source, /appendColorSection\('Background', 'background', RICH_TEXT_HIGHLIGHTS\)/);
  assert.match(source, /const mark = kind === 'text' \? 'textStyle' : 'highlight'/);
  assert.match(source, /if \(color\) chain\.setMark\(mark, \{ color \}\)\.run\(\)/);
  assert.match(source, /else chain\.unsetMark\(mark\)\.run\(\)/);
  assert.match(source, /this\.updateColorState\(\)/);
});

test('S3 image NodeView provides selected resize handles and commits only displayWidth', async () => {
  const source = await readEditorSource();
  const nodeViewStart = source.indexOf('function createS3ImageNodeView(');
  const nodeViewEnd = source.indexOf('function createS3ImageExtension(', nodeViewStart);
  assert.ok(nodeViewStart >= 0 && nodeViewEnd > nodeViewStart);
  const nodeView = source.slice(nodeViewStart, nodeViewEnd);

  assert.match(nodeView, /notes-richtext-image-handle-west/);
  assert.match(nodeView, /notes-richtext-image-handle-east/);
  assert.match(nodeView, /aria-label', 'Resize image from left'/);
  assert.match(nodeView, /aria-label', 'Resize image from right'/);
  assert.match(nodeView, /attributes\.displayWidth \?\? attributes\.width/);
  assert.match(nodeView, /dom\.dataset\.alignment = attributes\.alignment \?\? 'left'/);
  assert.match(nodeView, /calculateRichTextImageDisplayWidth\(/);
  assert.match(nodeView, /window\.addEventListener\('pointermove', handlePointerMove, true\)/);
  assert.match(nodeView, /window\.addEventListener\('pointerup', handlePointerUp, true\)/);
  assert.match(nodeView, /window\.addEventListener\('pointercancel', handlePointerCancel, true\)/);
  assert.match(nodeView, /nextAttrs\.displayWidth = resize\.previewWidth/);
  assert.match(nodeView, /delete nextAttrs\.displayWidth/);
  assert.match(nodeView, /setNodeMarkup\(position, undefined, nextAttrs\)/);
  assert.match(nodeView, /selectNode\(\): void \{\s*dom\.classList\.add\('ProseMirror-selectednode'\)/);
  assert.match(nodeView, /deselectNode\(\): void \{\s*finishResize\(false\)/);
  assert.match(nodeView, /stopEvent: \(event\) =>[\s\S]*?westHandle\.contains\(event\.target\)[\s\S]*?eastHandle\.contains\(event\.target\)/);
  assert.match(nodeView, /destroy\(\): void \{[\s\S]*?finishResize\(false\)[\s\S]*?removeEventListener\('pointerdown', beginResize\)/);
});

test('selected S3 images expose a single icon-only alignment bubble menu', async () => {
  const source = await readEditorSource();
  const menuStart = source.indexOf('class NotesRichTextImageBubbleMenu');
  const menuEnd = source.indexOf('function createS3ImageNodeView(', menuStart);
  assert.ok(menuStart >= 0 && menuEnd > menuStart);
  const menu = source.slice(menuStart, menuEnd);

  assert.match(source, /const NOTE_IMAGE_ALIGNMENTS:[^=]+= \['left', 'center', 'right'\]/);
  assert.match(menu, /className = 'notes-richtext-image-toolbar hidden'/);
  assert.match(menu, /setAttribute\('role', 'toolbar'\)/);
  assert.match(menu, /setAttribute\('aria-label', 'Image alignment'\)/);
  assert.match(menu, /button\.append\(createStrokeIcon\(NOTE_IMAGE_ALIGNMENT_ICONS\[alignment\]\)\)/);
  assert.match(menu, /button\.setAttribute\('aria-pressed', String\(active\)\)/);
  assert.match(menu, /node\?\.type\.name !== 's3Image'/);
  assert.match(menu, /this\.editor\.view\.nodeDOM\(selection\.from\)/);
  assert.match(menu, /if \(alignment === 'left'\) delete nextAttributes\.alignment/);
  assert.match(menu, /else nextAttributes\.alignment = alignment/);
  assert.match(menu, /setNodeMarkup\(selected\.position, undefined, nextAttributes\)/);
  assert.match(menu, /setNodeSelection\(selected\.position\)/);
  assert.match(menu, /handleMouseDown[\s\S]*?event\.preventDefault\(\)/);
  assert.match(menu, /imageBounds\.top - overlayBounds\.top - toolbarBounds\.height/);
  assert.match(menu, /if \(top < inset\) top = imageBounds\.bottom - overlayBounds\.top \+ inset/);
  assert.match(source, /this\.imageBubbleMenu = new NotesRichTextImageBubbleMenu\(this\.editor, this\.overlayRoot\)/);
  assert.match(source, /this\.imageBubbleMenu\.destroy\(\)/);
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
