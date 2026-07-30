const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

async function readEditorSource() {
  return readFile(path.join(root, 'src', 'renderer', 'notesRichTextEditor.ts'), 'utf8');
}

async function readTailwindSource() {
  return readFile(path.join(root, 'src', 'renderer', 'tailwind.css'), 'utf8');
}

test('rich text offscreen layout containment is limited to ordinary top-level paragraphs', async () => {
  const styles = await readTailwindSource();
  const ruleStart = styles.indexOf('  .notes-richtext-content .ProseMirror > p {');
  const ruleEnd = styles.indexOf('\n  }', ruleStart);
  assert.notEqual(ruleStart, -1);
  assert.notEqual(ruleEnd, -1);

  const rule = styles.slice(ruleStart, ruleEnd);
  assert.match(rule, /content-visibility:\s*auto/);
  assert.match(rule, /contain-intrinsic-block-size:\s*auto 1\.7777778em/);
  assert.doesNotMatch(
    styles,
    /\.notes-richtext-content \.ProseMirror > \*\s*\{[^}]*content-visibility/s,
  );
  assert.doesNotMatch(
    styles,
    /\.notes-richtext-content \.ProseMirror > (?:ul|ol|blockquote|pre|figure|div|table)[^{]*\{[^}]*content-visibility/s,
  );
});

test('rich text code blocks keep selected text visible against their dark surface', async () => {
  const styles = await readTailwindSource();
  assert.match(
    styles,
    /\.notes-richtext-content \.ProseMirror pre code::selection,\s*\.notes-richtext-content \.ProseMirror pre code \*::selection\s*\{\s*@apply bg-blue-600 text-white;\s*\}/,
  );
});

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
  assert.match(nodeView, /if \(!visible\)[\s\S]*?showState\('deferred', 'Image loads when visible\.'\)/);
  assert.match(nodeView, /await imageLoads\.load\(reference\)/);
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

test('rich text image loading is visibility-gated, bounded, and deduplicated in flight', async () => {
  const source = await readEditorSource();
  assert.match(source, /MAX_CONCURRENT_NOTE_IMAGE_LOADS = 3/);
  assert.match(source, /new IntersectionObserver\([\s\S]*?rootMargin: '480px 0px'/);
  assert.match(source, /this\.visibilityCallbacks\.delete\(entry\.target\)[\s\S]*?callback\(\)/);
  assert.match(source, /const existing = this\.inFlight\.get\(key\);\s*if \(existing\) return existing;/);
  assert.match(source, /this\.active < this\.maximumConcurrency/);
  assert.match(source, /this\.imageLoads\.destroy\(\)/);

  const { BoundedNoteImageLoader } = await import('../dist/renderer/notesRichTextEditor.js');
  let active = 0;
  let maximumActive = 0;
  const releases = [];
  const sourceLoad = () => new Promise((resolve) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    releases.push(() => {
      active -= 1;
      resolve({ status: 'missing' });
    });
  });
  const loader = new BoundedNoteImageLoader(sourceLoad, 2);
  const reference = (id) => ({
    objectId: id,
    assetKey: `asset-${id}`,
    ciphertextSha256: `cipher-${id}`,
    contentSha256: `content-${id}`,
    mimeType: 'image/png',
    byteLength: 1,
    width: 1,
    height: 1,
  });

  const first = loader.load(reference('a'));
  const duplicate = loader.load(reference('a'));
  const second = loader.load(reference('b'));
  const third = loader.load(reference('c'));
  assert.strictEqual(first, duplicate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximumActive, 2);
  assert.equal(releases.length, 2);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximumActive, 2);
  assert.equal(releases.length, 2);
  while (releases.length > 0) releases.shift()();
  await Promise.all([first, second, third]);
  loader.destroy();
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
    'insertAttachment',
    'run',
    'runToolbarCommand',
    'destroy',
  ]) {
    assert.match(source, new RegExp(`public ${name}\\(`));
  }

  assert.match(source, /normalizeRichTextContent\(\s*value === undefined \|\| value === null \? EMPTY_RICH_TEXT_CONTENT : value/);
  assert.match(source, /setContent\(parseRichTextContent\(normalized\), \{/);
  assert.match(source, /normalizeRichTextContent\(stripTiptapLinkDefaults\(value\)\)/);
  assert.match(source, /const content = normalizeEditorContent\(this\.editor\.getJSON\(\)\)/);
  assert.match(source, /this\.lastCanonicalContent = content;\s*return content/);
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
  const [source, styles] = await Promise.all([readEditorSource(), readTailwindSource()]);
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
    'Heading 4',
    'Bullet List',
    'Numbered List',
    'Quote',
    'Code',
    'Table',
    'Image',
    'File',
  ];
  assert.deepEqual(
    [...slashSource.matchAll(/title: '([^']+)'/g)].map((match) => match[1]),
    expectedTitles,
  );
  assert.doesNotMatch(slashSource, /feedback|youtube|twitter|ask\s*ai/i);
  assert.match(slashSource, /title: 'Heading 4',[\s\S]*?searchTerms: \['h4', 'heading4', 'compact'\],[\s\S]*?setHeading\(\{ level: 4 \}\)/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror h4 \{[^}]*font-size: 1\.1111111em;[^}]*font-weight: 600;/s);
  assert.match(slashSource, /title: 'File',[\s\S]*?searchTerms: \['attachment', 'upload', 'document'\],[\s\S]*?icon: 'file'/);
  assert.match(slashSource, /deleteRange\(range\)\.run\(\);\s*window\.requestAnimationFrame\(\(\) => requestAttachment\(undefined, range\.from\)\)/);
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

test('six-dot block commands initially select the captured block format', async () => {
  const { richTextBlockCommandTitle } = await import('../dist/renderer/notesRichTextEditor.js');

  assert.equal(richTextBlockCommandTitle('paragraph'), 'Text');
  assert.equal(richTextBlockCommandTitle('heading', { level: 1 }), 'Heading 1');
  assert.equal(richTextBlockCommandTitle('heading', { level: 4 }), 'Heading 4');
  assert.equal(richTextBlockCommandTitle('taskList'), 'To-do List');
  assert.equal(richTextBlockCommandTitle('bulletList'), 'Bullet List');
  assert.equal(richTextBlockCommandTitle('orderedList'), 'Numbered List');
  assert.equal(richTextBlockCommandTitle('blockquote'), 'Quote');
  assert.equal(richTextBlockCommandTitle('codeBlock'), 'Code');
  assert.equal(richTextBlockCommandTitle('table'), 'Table');
  assert.equal(richTextBlockCommandTitle('s3Image'), 'Image');
  assert.equal(richTextBlockCommandTitle('s3Attachment'), 'File');
  assert.equal(richTextBlockCommandTitle('heading', { level: 5 }), undefined);
  assert.equal(richTextBlockCommandTitle('unknown'), undefined);
});

test('six-dot block handle follows hovered blocks, opens commands, and owns native block dragging', async () => {
  const source = await readEditorSource();
  const handleStart = source.indexOf('class NotesRichTextBlockHandle');
  const handleEnd = source.indexOf('interface RichTextCodeBlockTarget', handleStart);
  assert.ok(handleStart >= 0 && handleEnd > handleStart);
  const handle = source.slice(handleStart, handleEnd);

  assert.match(handle, /private readonly element = document\.createElement\('button'\)/);
  assert.match(handle, /className = 'notes-richtext-block-handle hidden'/);
  assert.match(handle, /this\.element\.draggable = true/);
  assert.match(handle, /setAttribute\('aria-label', 'Drag block or open block commands'\)/);
  assert.match(handle, /setAttribute\('aria-haspopup', 'listbox'\)/);
  assert.match(handle, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg', 'svg'\)/);
  assert.match(handle, /icon\.setAttribute\('viewBox', '0 0 20 20'\)/);
  assert.match(handle, /M5 3\.25a1\.5 1\.5[\s\S]*?m7 0a1\.5 1\.5/);
  assert.match(handle, /iconPath\.setAttribute\('fill', 'currentColor'\)/);
  assert.doesNotMatch(handle, /grid-cols-2|createElement\('span'\)/);
  assert.match(handle, /const target = this\.selectActiveBlock\(\);[\s\S]*?if \(!target\) return;[\s\S]*?this\.menu\.isOpenForCurrentBlock\(\)[\s\S]*?this\.menu\.closeCurrentBlock\(\)[\s\S]*?this\.menu\.openForCurrentBlock\(this\.element, target\.node\)[\s\S]*?this\.editor\.commands\.focus\(\)/);
  assert.match(handle, /this\.element\.addEventListener\('keydown',[\s\S]*?this\.menu\.handleKeyDown\(event\)[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)/);
  assert.match(handle, /this\.overlayRoot\.addEventListener\('pointermove', this\.handlePointerMove\)/);
  assert.match(handle, /this\.overlayRoot\.addEventListener\('pointerleave', this\.handlePointerLeave\)/);
  assert.match(handle, /this\.blockAtGutterPoint\(event\.clientX, event\.clientY\)/);
  assert.match(handle, /const gutterRight = writingLeft \+ 4/);
  assert.match(handle, /this\.editor\.view\.posAtCoords\(\{[\s\S]*?left:[\s\S]*?top: clientY/);
  assert.match(handle, /const target = hoveredBlock \?\? this\.selectionBlock\(\)/);
  assert.match(handle, /this\.editor\.view\.coordsAtPos\(target\.anchor\)/);
  assert.match(handle, /const editableBounds = this\.editor\.view\.dom\.getBoundingClientRect\(\)/);
  assert.match(handle, /getComputedStyle\(this\.editor\.view\.dom\)\.paddingLeft/);
  assert.match(handle, /writingLeft - buttonBounds\.width - 4/);
  assert.match(handle, /const lineMiddle = \(anchor\.top \+ anchor\.bottom\) \/ 2 - overlayBounds\.top/);
  assert.match(handle, /this\.element\.style\.top = `\$\{top\}px`/);
  assert.match(handle, /NodeSelection\.create\(this\.editor\.state\.doc, target\.from\)/);
  assert.match(handle, /this\.editor\.view\.serializeForClipboard\(selection\.content\(\)\)/);
  assert.match(handle, /this\.editor\.view\.dragging = \{ slice: serialized\.slice, move: true \}/);
  assert.match(handle, /dataTransfer\.setDragImage\(preview, 12, 12\)/);
  assert.match(handle, /this\.editor\.view\.dragging = null/);

  const helpers = source.slice(source.indexOf('function firstTextPosition('), handleStart);
  assert.match(helpers, /while \(!current\.isTextblock && current\.childCount > 0\)/);
  assert.match(helpers, /return current\.isTextblock \? position \+ 1 : from/);
  assert.match(helpers, /resolved\.before\(1\)/);
  assert.match(helpers, /anchor: firstTextPosition\(node, from\)/);

  assert.match(source, /public openForCurrentBlock\(trigger: HTMLElement, block: ProseMirrorNode\): void \{[\s\S]*?this\.manualSelection = \{ from: selection\.from, to: selection\.to \}[\s\S]*?this\.items = this\.commandItems[\s\S]*?richTextBlockCommandTitle\(block\.type\.name, block\.attrs\)[\s\S]*?this\.selectedIndex = currentIndex >= 0 \? currentIndex : 0/);
  assert.match(source, /const cursor = this\.manualTrigger\?\.getBoundingClientRect\(\)[\s\S]*?\?\? this\.editor\.view\.coordsAtPos\(this\.range\.to\)/);
  assert.doesNotMatch(source, /manualAnchor/);
  assert.match(handle, /if \(menuOpen\) this\.menu\.repositionCurrentBlock\(\)/);
  assert.match(source, /this\.blockHandle = new NotesRichTextBlockHandle\(this\.editor, this\.overlayRoot, this\.slashMenu\)/);
  assert.match(source, /this\.blockHandle\.sync\(\)/);
  assert.match(source, /this\.blockHandle\.destroy\(\)/);
  assert.match(source, /dropcursor:\s*\{\s*color: '#3b82f6',\s*width: 2,\s*class: 'notes-richtext-block-dropcursor'/);

  const styles = await readTailwindSource();
  assert.match(styles, /\.notes-richtext-block-handle\s*\{[^}]*cursor-grab/s);
  assert.match(styles, /\.notes-richtext-block-handle\[data-dragging='true'\]\s*\{/);
  assert.match(styles, /\.notes-richtext-block-dropcursor\s*\{[^}]*pointer-events-none/s);
  assert.match(styles, /\.notes-richtext-block-drag-preview\s*\{/);
});

test('rich text attachment cards show compact metadata and only supported preview actions', async () => {
  const source = await readEditorSource();
  const extensionStart = source.indexOf('function createS3AttachmentExtension(');
  const extensionEnd = source.indexOf('function createNotesRichTextExtensions(', extensionStart);
  assert.ok(extensionStart >= 0 && extensionEnd > extensionStart);
  const extension = source.slice(extensionStart, extensionEnd);

  assert.match(extension, /name: 's3Attachment',[\s\S]*?group: 'block',[\s\S]*?atom: true,[\s\S]*?selectable: true/);
  for (const attribute of [
    'objectId', 'assetKey', 'ciphertextSha256', 'contentSha256',
    'fileName', 'mimeType', 'byteLength',
  ]) assert.match(extension, new RegExp(`${attribute}: \\{ default: null \\}`));
  assert.match(extension, /parseHTML\(\) \{\s*return \[\];\s*\}/);
  assert.match(extension, /notes-richtext-attachment-serialized/);
  assert.match(extension, /dom\.className = 'notes-richtext-attachment'/);
  assert.match(extension, /dom\.contentEditable = 'false'/);
  assert.match(extension, /icon\.className = 'notes-richtext-attachment-type'/);
  assert.match(extension, /footer\.className = 'notes-richtext-attachment-footer'/);
  assert.match(extension, /footer\.append\(metadata, actions\)/);
  assert.match(extension, /copy\.append\(name, footer\)/);
  assert.match(extension, /dom\.append\(icon, copy\)/);
  assert.match(extension, /name\.textContent = reference\.fileName/);
  assert.match(extension, /name\.title = reference\.fileName/);
  assert.match(extension, /metadata\.textContent = attachmentSize\(reference\.byteLength\)/);
  assert.doesNotMatch(extension, /metadata\.textContent[^\n]*reference\.mimeType/);
  assert.match(extension, /icon\.replaceChildren\(createAttachmentTypeIcon\(kind\)\)/);
  assert.doesNotMatch(extension, /pdf: 'PDF'[\s\S]*?document: 'DOC'/);
  assert.match(extension, /noteAttachmentPreviewKind\(reference\) \? \[createActionButton\('view', reference\)\] : \[\]/);
  assert.match(extension, /createActionButton\('download', reference\)/);
  assert.match(extension, /button\.setAttribute\('aria-label', `\$\{actionLabel\} \$\{reference\.fileName\}`\)/);
  assert.match(extension, /onAction\(action, parseNoteAttachmentReference\(node\.attrs\), button\)/);
  assert.doesNotMatch(extension, /button\.addEventListener\('mousedown'/);
  assert.match(extension, /dom\.addEventListener\('click',[\s\S]*?getPos\(\)[\s\S]*?editor\.commands\.setNodeSelection\(position\)/);
  assert.match(extension, /selectNode: \(\) => dom\.classList\.add\('ProseMirror-selectednode'\)/);
  assert.match(extension, /deselectNode: \(\) => dom\.classList\.remove\('ProseMirror-selectednode'\)/);
  assert.match(extension, /stopEvent: \(event\) => event\.target instanceof window\.Node && actions\.contains\(event\.target\)/);
  assert.doesNotMatch(extension, /setAttribute\([^\n]*(?:assetKey|ciphertextSha256|contentSha256|objectId)/);

  assert.match(source, /NOTE_ATTACHMENT_ICON_SOURCES: Readonly<Record<NoteAttachmentIconKind, string>> = \{[\s\S]*?pdf: '\.\.\/\.\.\/assets\/note-file-icons\/pdf\.svg'[\s\S]*?file: '\.\.\/\.\.\/assets\/note-file-icons\/file\.svg'/);
  assert.match(source, /function createAttachmentTypeIcon\(kind: NoteAttachmentIconKind\): HTMLImageElement \{[\s\S]*?image\.alt = ''[\s\S]*?image\.draggable = false/);
  const iconStart = source.indexOf('export function noteAttachmentIconKind(');
  const iconEnd = source.indexOf('function attachmentSize(', iconStart);
  const iconClassifier = source.slice(iconStart, iconEnd);
  assert.ok(iconStart >= 0 && iconEnd > iconStart);
  for (const kind of ['pdf', 'document', 'spreadsheet', 'presentation', 'archive', 'image', 'audio', 'video', 'code', 'file']) {
    assert.match(iconClassifier, new RegExp(`return '${kind}'`));
  }
  assert.match(source, /public insertAttachment\(value: NoteAttachmentReference, position\?: number\): boolean/);
  assert.match(source, /const content = \{ type: 's3Attachment', attrs: reference \}/);
  assert.match(source, /createS3AttachmentExtension\(onError, onAttachmentAction\)/);
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
  const bubbleStart = source.indexOf('class NotesRichTextBubbleMenu');
  const bubbleSyncStart = source.indexOf('  public sync(): void {', bubbleStart);
  const bubbleSyncEnd = source.indexOf('  public destroy(): void {', bubbleSyncStart);
  const bubbleSync = source.slice(bubbleSyncStart, bubbleSyncEnd);
  assert.ok(bubbleSync.indexOf('if (!hasTextSelection && !editingLink)') < bubbleSync.indexOf('this.updateBlockState()'));
  assert.ok(bubbleSync.indexOf('if (!hasTextSelection && !editingLink)') < bubbleSync.indexOf('this.updateColorState()'));
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
  assert.match(source, /return this\.commandChain\(command, this\.editor\.can\(\)\.chain\(\)\)\.run\(\)/);
  assert.match(source, /isAllowedRichTextLinkHref\(href\)/);
  assert.match(source, /extendMarkRange\('link'\)\.unsetLink\(\)/);
  assert.match(source, /chain\.setLink\(\{ href \}\)\.run\(\)/);
  assert.match(source, /this\.linkInput\.placeholder = 'Paste a link'/);
  assert.match(source, /this\.applyLinkButton\.hidden = linkActive/);
  assert.match(source, /this\.removeLinkButton\.hidden = !linkActive/);
  assert.doesNotMatch(source, /Ask AI|askAI|GenerativeMenu|AISelector/);
});

test('rich text selection formatter stays hidden for code block selections', async () => {
  const source = await readEditorSource();
  const helperStart = source.indexOf('function hasFormattableSelection(');
  const helperEnd = source.indexOf('\nfunction ', helperStart + 1);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);

  assert.match(helper, /editor\.state\.doc\.nodesBetween\(selection\.from, selection\.to/);
  assert.match(helper, /node\.type\.name === 'codeBlock'/);
  assert.match(helper, /return hasFormattableContent && !intersectsCodeBlock/);
});

test('Rich Text code blocks use bounded common highlighting and a searchable language pill', async () => {
  const [source, styles] = await Promise.all([readEditorSource(), readTailwindSource()]);
  assert.match(source, /import CodeBlockLowlight from '@tiptap\/extension-code-block-lowlight'/);
  assert.match(source, /import \{ common, createLowlight \} from 'lowlight'/);
  assert.match(source, /StarterKit\.configure\(\{\s*codeBlock: false/);
  assert.match(source, /CodeBlockLowlight\.configure\(\{ lowlight: notesCodeLowlight \}\)/);
  assert.match(source, /value\.length > CODE_HIGHLIGHT_LIMITS\.explicitCharacters/);
  assert.match(source, /value\.length > CODE_HIGHLIGHT_LIMITS\.automaticCharacters/);
  assert.match(source, /findCodeHighlightLanguage\(language\)\?\.value \?\? language/);
  assert.match(source, /listLanguages\(\) \{\s*return \[\.\.\.notesCodeLanguageNames\]/);

  const menuStart = source.indexOf('class NotesRichTextCodeLanguageMenu');
  const menuEnd = source.indexOf('class NotesRichTextBubbleMenu', menuStart);
  assert.ok(menuStart >= 0 && menuEnd > menuStart);
  const menu = source.slice(menuStart, menuEnd);
  assert.match(menu, /className = 'notes-richtext-code-language-trigger hidden'/);
  assert.match(menu, /textContent = knownLanguage\?\.label \?\? 'Auto'/);
  assert.match(menu, /placeholder = 'Search languages'/);
  assert.match(menu, /RICH_TEXT_CODE_LANGUAGE_CHOICES\.filter\(\(choice\) => choice\.searchText\.includes\(query\)\)/);
  assert.match(menu, /event\.altKey[\s\S]*?event\.key !== 'F10'/);
  assert.match(menu, /setNodeMarkup\(target\.position, undefined, attributes\)/);
  assert.match(menu, /language: choice\.value/);
  assert.match(menu, /Unsupported saved language/);
  assert.doesNotMatch(menu, /unknownStatus|Saved tag/);
  assert.match(menu, /const visibleTop = Math\.max\(blockBounds\.top, overlayBounds\.top\)/);
  assert.match(menu, /const visibleRight = Math\.min\(blockBounds\.right, overlayBounds\.right\)/);
  assert.match(menu, /const preferredTop = visibleTop - overlayBounds\.top \+ inset/);
  assert.doesNotMatch(menu, /blockBounds\.top - overlayBounds\.top - triggerBounds\.height \/ 2/);
  assert.match(styles, /\.notes-richtext-content \.ProseMirror pre \{[\s\S]*?padding: 1em 1\.5em;/);
  assert.doesNotMatch(styles, /\.notes-richtext-content \.ProseMirror pre \{[\s\S]*?padding: 2\.75em 1\.5em 1em;/);
  assert.match(styles, /\.notes-richtext-code-language-trigger/);
  assert.match(styles, /\.notes-richtext-code-language-menu/);
  assert.match(styles, /\.hljs-keyword/);
});

test('Rich Text Code blocks scope the first Select All and let the second select the Note', async () => {
  const source = await readEditorSource();
  assert.match(source, /import \{ NodeSelection, Plugin, PluginKey, TextSelection \} from '@tiptap\/pm\/state'/);
  const helperStart = source.indexOf('function handleScopedCodeBlockSelectAll(');
  const helperEnd = source.indexOf('\nclass NotesRichTextCodeLanguageMenu', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);

  assert.match(helper, /const modifier = event\.metaKey \|\| event\.ctrlKey/);
  assert.match(helper, /event\.altKey[\s\S]*?event\.shiftKey[\s\S]*?event\.isComposing[\s\S]*?event\.key\.toLocaleLowerCase\(\) !== 'a'/);
  assert.match(helper, /selection instanceof TextSelection/);
  assert.match(helper, /codeBlockTextRangeAtPosition\(editor, selection\.from\)[\s\S]*?codeBlockTextRangeAtPosition\(editor, selection\.to\)/);
  assert.match(helper, /start\.position !== end\.position[\s\S]*?selection\.from < start\.from[\s\S]*?selection\.to > start\.to/);
  assert.match(helper, /start\.from === start\.to/);
  assert.match(helper, /if \(alreadySelected\) \{\s*if \(!event\.repeat\) return false;\s*event\.preventDefault\(\);\s*return true;/);
  assert.match(helper, /editor\.commands\.setTextSelection\(\{ from: start\.from, to: start\.to \}\)/);
  assert.match(source, /handleKeyDown: \(_view, event\) => \{\s*if \(handleScopedCodeBlockSelectAll\(this\.editor, event\)\) return true;/);
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

test('rich text routes pasted and dropped images or other files through the matching S3 upload flow', async () => {
  const source = await readEditorSource();
  assert.match(source, /function isSupportedImageFile\(file: File\): boolean \{\s*return file\.type === 'image\/png'\s*\|\| file\.type === 'image\/jpeg'\s*\|\| file\.type === 'image\/webp';\s*\}/);
  assert.match(source, /handlePaste: \(view, event\) => \{[\s\S]*?firstSupportedImageFile\(event\.clipboardData\?\.files\)[\s\S]*?isSupportedImageFile\(file\)[\s\S]*?options\.onRequestImage\(file, view\.state\.selection\.to\)[\s\S]*?options\.onRequestAttachment\(file, view\.state\.selection\.to\)/);
  assert.match(source, /handleDrop: \(view, event, _slice, moved\) => \{[\s\S]*?firstSupportedImageFile\(event\.dataTransfer\?\.files\)[\s\S]*?view\.posAtCoords\([\s\S]*?isSupportedImageFile\(file\)[\s\S]*?options\.onRequestImage\(file, position\)[\s\S]*?options\.onRequestAttachment\(file, position\)/);
  assert.doesNotMatch(source, /file\.type\.startsWith\('image\/'\)/);
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

test('invalid editor capture rolls back to the latest canonical content', async () => {
  const source = await readEditorSource();
  assert.match(source, /private lastCanonicalContent = EMPTY_RICH_TEXT_CONTENT/);
  assert.match(source, /private restoringCanonicalContent = false/);
  assert.match(source, /this\.lastCanonicalContent = normalized/);
  assert.match(source, /public getContent\(\): string \{[\s\S]*?catch \(error\) \{[\s\S]*?this\.restoreLastCanonicalContent\(\);[\s\S]*?safelyReport/);
  assert.match(source, /private restoreLastCanonicalContent\(\): void \{[\s\S]*?parseRichTextContent\(this\.lastCanonicalContent\)[\s\S]*?emitUpdate: false[\s\S]*?errorOnInvalidContent: true/);
  assert.match(source, /finally \{\s*this\.restoringCanonicalContent = false/);
});

test('rich text input defers canonical capture and coalesces editor chrome to one animation frame', async () => {
  const source = await readEditorSource();
  const updateStart = source.indexOf('      onUpdate: () => {');
  const selectionStart = source.indexOf('      onSelectionUpdate: () => {', updateStart);
  const queueStart = source.indexOf('  private queueViewSync(): void {');
  const commandStart = source.indexOf('  private commandChain(', queueStart);
  assert.ok(updateStart >= 0 && selectionStart > updateStart);
  assert.ok(queueStart > selectionStart && commandStart > queueStart);

  const update = source.slice(updateStart, selectionStart);
  const queue = source.slice(queueStart, commandStart);
  assert.match(update, /this\.onChange\(\);\s*this\.queueViewSync\(\)/);
  assert.doesNotMatch(update, /getContent\(\)|getJSON\(\)|normalizeEditorContent/);
  assert.match(queue, /if \(this\.editor\.isDestroyed \|\| this\.viewSyncFrame !== undefined\) return/);
  assert.equal((queue.match(/window\.requestAnimationFrame/g) ?? []).length, 1);
  assert.match(queue, /if \(hasFormattableSelection\(this\.editor\)\) this\.updateToolbarState\(\)/);
  for (const call of [
    'updateToolbarState',
    'updateEmptyState',
    'bubbleMenu.sync',
    'imageBubbleMenu.sync',
    'tableControls.sync',
    'slashMenu.sync',
  ]) assert.match(queue, new RegExp(`this\\.${call.replace('.', '\\.')}`));
});
