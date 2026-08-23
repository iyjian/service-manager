const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

async function loadHelpers() {
  return import('../dist/renderer/models/triliumRichText.js');
}

test('Trilium checklist helpers recognize exact CKEditor class tokens', async () => {
  const {
    hasTriliumHtmlClass,
    isTriliumTodoDescriptionClass,
    isTriliumTodoLabelClass,
    isTriliumTodoListClass,
  } = await loadHelpers();

  assert.equal(isTriliumTodoListClass('todo-list'), true);
  assert.equal(isTriliumTodoListClass('ck-list todo-list compact'), true);
  assert.equal(isTriliumTodoListClass('todo-list-nested'), false);
  assert.equal(isTriliumTodoListClass('TODO-LIST'), false);
  assert.equal(isTriliumTodoListClass(null), false);

  assert.equal(isTriliumTodoLabelClass('todo-list__label'), true);
  assert.equal(isTriliumTodoLabelClass('field todo-list__label active'), true);
  assert.equal(isTriliumTodoDescriptionClass('todo-list__label__description'), true);
  assert.equal(isTriliumTodoDescriptionClass('todo-list__label'), false);
  assert.equal(hasTriliumHtmlClass('alpha\n beta\tfoo', 'beta'), true);
});

test('Trilium checklist helpers preserve checked state from DOM property or HTML attribute', async () => {
  const { isTriliumTodoCheckboxType, triliumTodoChecked } = await loadHelpers();

  assert.equal(isTriliumTodoCheckboxType('checkbox'), true);
  assert.equal(isTriliumTodoCheckboxType(' CHECKBOX '), true);
  assert.equal(isTriliumTodoCheckboxType('radio'), false);
  assert.equal(isTriliumTodoCheckboxType(undefined), false);

  assert.equal(triliumTodoChecked(false, false), false);
  assert.equal(triliumTodoChecked(true, false), true);
  assert.equal(triliumTodoChecked(false, true), true);
  assert.equal(triliumTodoChecked(true, true), true);
});

test('Trilium image sources map only same-instance UI routes to ETAPI targets', async () => {
  const { parseTriliumImageSource } = await loadHelpers();
  const endpoint = 'https://notes.example.test/trilium';

  assert.deepEqual(
    parseTriliumImageSource('api/attachments/attach_1/image/photo.png?version=2', endpoint),
    { sourceKey: 'attachment:attach_1', kind: 'attachment', remoteId: 'attach_1' },
  );
  assert.deepEqual(
    parseTriliumImageSource('/trilium/api/images/image_1/photo.webp', endpoint),
    { sourceKey: 'note:image_1', kind: 'note', remoteId: 'image_1' },
  );
  assert.deepEqual(
    parseTriliumImageSource('https://notes.example.test/trilium/api/images/image_2', endpoint),
    { sourceKey: 'note:image_2', kind: 'note', remoteId: 'image_2' },
  );

  for (const value of [
    'https://evil.example/trilium/api/images/image_1/a.png',
    'data:image/png;base64,AAAA',
    'blob:https://notes.example.test/id',
    '/api/images/image_1/a.png',
    '../api/images/image_1/a.png',
    '/trilium/api/attachments/attach_1/not-image/a.png',
    '/trilium/api/attachments/attach_1/image',
    '/trilium/api/images/no/a.png',
    '/trilium/api/images/image_1/a.png#fragment',
    '/trilium/api/images/%2e%2e/a.png',
  ]) assert.equal(parseTriliumImageSource(value, endpoint), undefined, value);
});

test('Trilium image layout keeps explicit alignment and safe pixel widths only', async () => {
  const { triliumImageAlignment, triliumImagePixelWidth } = await loadHelpers();

  assert.equal(triliumImageAlignment('image image-style-align-center', ''), 'center');
  assert.equal(triliumImageAlignment('image image-style-side', ''), 'right');
  assert.equal(triliumImageAlignment('image', 'image-style-align-left'), 'left');
  assert.equal(triliumImageAlignment('image image-style-block-align-right', ''), 'right');
  assert.equal(triliumImageAlignment('image', ''), 'center');
  assert.equal(triliumImageAlignment('', 'image_resized'), 'left');
  assert.equal(triliumImagePixelWidth('29.84%', '640px'), 298);
  assert.equal(triliumImagePixelWidth('4%', '991'), 48);
  assert.equal(triliumImagePixelWidth('900%', '991'), 8_192);
  assert.equal(triliumImagePixelWidth('320px'), 320);
  assert.equal(triliumImagePixelWidth('512'), 512);
  assert.equal(triliumImagePixelWidth('47%', 'calc(50% - 1px)'), 470);
  assert.equal(triliumImagePixelWidth('12px', '99999px'), undefined);
});

test('Trilium table widths normalize percentage and pixel colgroups without losing proportions', async () => {
  const { normalizeTriliumTableColumnWidths } = await loadHelpers();

  assert.deepEqual(
    normalizeTriliumTableColumnWidths(['5.62%', '29.84%', '17.23%', '47.31%']),
    [96, 510, 294, 808],
  );
  assert.deepEqual(
    normalizeTriliumTableColumnWidths(['120px', '240px', '360px']),
    [120, 240, 360],
  );
  assert.deepEqual(normalizeTriliumTableColumnWidths(['48px', '240px']), [96, 480]);
  assert.deepEqual(normalizeTriliumTableColumnWidths(['10000px', '20000px']), [4096, 8192]);
  assert.deepEqual(normalizeTriliumTableColumnWidths(['120', '240']), [120, 240]);
});

test('Trilium table widths reject incomplete, mixed-unit, unsafe, and oversized colgroups', async () => {
  const { normalizeTriliumTableColumnWidths } = await loadHelpers();

  for (const widths of [
    [],
    ['50%', null],
    ['50%', '200px'],
    ['0%', '100%'],
    ['-10px', '20px'],
    ['calc(50% - 1px)', '50%'],
    ['Infinitypx', '10px'],
  ]) assert.equal(normalizeTriliumTableColumnWidths(widths), undefined);

  assert.equal(
    normalizeTriliumTableColumnWidths(Array.from({ length: 201 }, () => '1%')),
    undefined,
  );
});

test('Trilium table cell widths follow the logical grid across row and column spans', async () => {
  const { mapTriliumTableCellColumnWidths } = await loadHelpers();

  assert.deepEqual(mapTriliumTableCellColumnWidths([
    [{ colspan: 1, rowspan: 2 }, { colspan: 2, rowspan: 1 }],
    [{ colspan: 1, rowspan: 1 }, { colspan: 1, rowspan: 1 }],
  ], [100, 200, 300]), [
    [[100], [200, 300]],
    [[200], [300]],
  ]);

  assert.deepEqual(mapTriliumTableCellColumnWidths([
    [
      { colspan: 1, rowspan: 1 },
      { colspan: 1, rowspan: 2 },
      { colspan: 1, rowspan: 1 },
    ],
    [{ colspan: 1, rowspan: 1 }, { colspan: 1, rowspan: 1 }],
  ], [100, 200, 300]), [
    [[100], [200], [300]],
    [[100], [300]],
  ]);
});

test('Trilium table cell width mapping rejects malformed or incomplete span geometry', async () => {
  const { mapTriliumTableCellColumnWidths } = await loadHelpers();

  for (const rows of [
    [[{ colspan: 1, rowspan: 1 }]],
    [[{ colspan: 3, rowspan: 1 }]],
    [[{ colspan: 2, rowspan: 2 }]],
    [
      [{ colspan: 1, rowspan: 1 }, { colspan: 1, rowspan: 2 }],
      [{ colspan: 2, rowspan: 1 }],
    ],
  ]) assert.equal(mapTriliumTableCellColumnWidths(rows, [100, 200]), undefined);

  assert.equal(mapTriliumTableCellColumnWidths([
    [{ colspan: 2, rowspan: 1 }],
  ], [0, 200]), undefined);
});

test('Trilium checklist adaptation runs before generic form stripping and owns HTML list parsing', async () => {
  const source = await readFile(
    path.join(root, 'src', 'renderer', 'components', 'notesRichTextEditor.ts'),
    'utf8',
  );
  const conversionStart = source.indexOf('export function convertTriliumHtmlToRichText(');
  const conversionEnd = source.indexOf('/** Small renderer adapter', conversionStart);
  const conversion = source.slice(conversionStart, conversionEnd);

  const adaptationIndex = conversion.indexOf('adaptTriliumTodoLists(parsed.body);');
  const unsafeRemovalIndex = conversion.indexOf("'script,style,iframe,object,embed,form,input");
  assert.ok(adaptationIndex >= 0);
  assert.ok(unsafeRemovalIndex > adaptationIndex);

  assert.match(source, /tag: 'ul\[data-type="taskList"\]', priority: 60/);
  assert.match(source, /tag: 'li\[data-task-item\]', priority: 60/);
  assert.match(source, /while \(child\.firstChild\) paragraph\.append\(child\.firstChild\)/);
  assert.match(source, /ensureTriliumTaskItemStartsWithParagraph\(candidate\)/);
});

test('Trilium table adaptation runs before Tiptap conversion and uses official width attributes', async () => {
  const source = await readFile(
    path.join(root, 'src', 'renderer', 'components', 'notesRichTextEditor.ts'),
    'utf8',
  );
  const conversionStart = source.indexOf('export function convertTriliumHtmlToRichText(');
  const conversionEnd = source.indexOf('/** Small renderer adapter', conversionStart);
  const conversion = source.slice(conversionStart, conversionEnd);

  const adaptationIndex = conversion.indexOf('adaptTriliumTableColumnWidths(parsed.body);');
  const generationIndex = conversion.indexOf('generateJSON(');
  assert.ok(adaptationIndex >= 0);
  assert.ok(generationIndex > adaptationIndex);
  assert.match(source, /column\.setAttribute\('width', String\(width\)\)/);
  assert.match(source, /cell\.setAttribute\('colwidth', widths\.join\(','\)\)/);
  assert.match(source, /TableKit\.configure\(\{\s*table: \{\s*cellMinWidth: 96,\s*resizable: true,/);
});
