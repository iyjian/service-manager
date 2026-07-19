const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

async function source(file) {
  return readFile(path.join(root, file), 'utf8');
}

test('rich text registers the official resizable TableKit and a 3 by 3 header slash command', async () => {
  const editor = await source('src/renderer/notesRichTextEditor.ts');
  assert.match(editor, /import \{ TableKit \} from '@tiptap\/extension-table'/);
  assert.match(
    editor,
    /TableKit\.configure\(\{\s*table: \{\s*cellMinWidth: 96,\s*resizable: true,\s*\},\s*\}\)/,
  );
  assert.match(editor, /title: 'Table', description: 'Insert a table'/);
  assert.match(editor, /icon: 'table'/);
  assert.match(
    editor,
    /deleteRange\(range\)\.insertTable\(\{\s*rows: 3,\s*cols: 3,\s*withHeaderRow: true,\s*\}\)\.run\(\)/,
  );
  assert.match(editor, /'M8 2\.5v11'/, 'slash command uses the local Lucide Table geometry');
});

test('Notion-style table controls remain a DOM adapter around official Tiptap commands', async () => {
  const controls = await source('src/renderer/notesRichTextTable.ts');
  for (const label of [
    'Add Row Above',
    'Add Row Below',
    'Delete Row',
    'Add Column Left',
    'Add Column Right',
    'Delete Column',
    'Delete Table',
  ]) {
    assert.match(controls, new RegExp(`label: '${label}'`));
  }
  for (const command of [
    'addRowBefore',
    'addRowAfter',
    'deleteRow',
    'addColumnBefore',
    'addColumnAfter',
    'deleteColumn',
    'deleteTable',
  ]) {
    assert.match(controls, new RegExp(`chain\\.${command}\\(\\)\\.run\\(\\)`));
  }
  assert.match(controls, /setCellSelection\(\{ anchorCell: position \}\)/);
  assert.match(controls, /target\.table\.rows\.item\(0\) === target\.row/);
  assert.match(controls, /data-table-handle/);
  assert.match(controls, /'Row options'/);
  assert.match(controls, /'Column options'/);
  assert.match(controls, /'Table options'/);
  assert.match(controls, /host\.addEventListener\('scroll', this\.handleScroll, true\)/);
  assert.match(controls, /element\.addEventListener\('pointerleave', this\.handleControlsPointerLeave\)/);
  assert.match(controls, /element\.addEventListener\('focusin', this\.handleControlsFocusIn\)/);
  assert.match(controls, /element\.addEventListener\('focusout', this\.handleControlsFocusOut\)/);
  assert.match(controls, /if \(this\.replacingMenuItems \|\| !this\.menuKind\) return/);
  assert.match(
    controls,
    /this\.replacingMenuItems = true;\s*try \{\s*this\.menu\.replaceChildren\(\.\.\.items\);\s*\} finally \{\s*this\.replacingMenuItems = false;/,
  );
  assert.match(controls, /host\.addEventListener\('blur', this\.handleHostBlur, true\)/);
  assert.match(controls, /this\.hoveredTarget = source instanceof Element\s*\? tableTarget\(this\.host, source\)/);
  assert.match(controls, /window\.addEventListener\('resize', this\.handleViewportChange\)/);
  assert.match(controls, /selectionTableTarget\(this\.editor, this\.host\)/);
  assert.match(controls, /event\.key !== 'F10'/);
  assert.match(controls, /event\.altKey/);
  assert.match(controls, /event\.shiftKey/);
  assert.match(controls, /aria-keyshortcuts', 'Alt\+F10 Shift\+F10'/);
  assert.match(controls, /event\.key === 'ArrowDown'/);
  assert.match(controls, /event\.key === 'ArrowUp'/);
  assert.match(controls, /event\.key === 'Home'/);
  assert.match(controls, /event\.key === 'End'/);
  assert.match(controls, /event\.key === 'Escape'/);
  assert.match(controls, /!this\.menu\.contains\(document\.activeElement\)/);
  assert.doesNotMatch(
    controls,
    /\bNode\.create\(|new Plugin\(|CellSelection\.create\(|setNodeMarkup\(|replaceSelection/,
  );
});

test('table presentation uses existing theme tokens and official resize and cell-selection hooks', async () => {
  const css = await source('src/renderer/tailwind.css');
  const start = css.indexOf('  .notes-richtext-content .ProseMirror .tableWrapper {');
  const end = css.indexOf('  .notes-richtext-slash-menu {', start);
  assert.ok(start >= 0 && end > start);
  const tableCss = css.slice(start, end);
  assert.match(tableCss, /overflow-x-auto/);
  assert.match(tableCss, /w-full/);
  assert.match(tableCss, /!w-full/);
  assert.match(tableCss, /table-layout: fixed/);
  assert.match(tableCss, /\.selectedCell::after/);
  assert.match(tableCss, /\.column-resize-handle/);
  assert.match(tableCss, /\.resize-cursor/);
  assert.match(tableCss, /h-10/);
  assert.match(tableCss, /bg-zinc-50 font-semibold/);
  assert.doesNotMatch(tableCss, /#[0-9a-f]{3,8}|rgba?\(/i);

  assert.match(css, /data-theme='dark'[\s\S]*?\.tableWrapper th[\s\S]*?bg-zinc-900 text-zinc-50/);
  assert.match(css, /data-theme='dark'[\s\S]*?\.notes-richtext-table-menu/);
});
