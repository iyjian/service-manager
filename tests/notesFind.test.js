const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const distRenderer = path.join(root, 'dist', 'renderer');

test('in-note find performs case-insensitive non-overlapping literal matching', async () => {
  const { findNotesTextMatches } = await import(path.join(distRenderer, 'models', 'notesFind.js'));

  assert.deepEqual(findNotesTextMatches('Alpha ALPHA alpha', 'alpha'), {
    matches: [
      { from: 0, to: 5 },
      { from: 6, to: 11 },
      { from: 12, to: 17 },
    ],
    truncated: false,
  });
  assert.deepEqual(findNotesTextMatches('a+b a.b a+b', 'a+b').matches, [
    { from: 0, to: 3 },
    { from: 8, to: 11 },
  ]);
  assert.deepEqual(findNotesTextMatches('aaaa', 'aa').matches, [
    { from: 0, to: 2 },
    { from: 2, to: 4 },
  ]);
  assert.deepEqual(findNotesTextMatches('anything', ''), { matches: [], truncated: false });
});

test('in-note find reports its bounded result set and wraps navigation', async () => {
  const {
    findNotesTextMatches,
    initialNotesFindIndex,
    moveNotesFindIndex,
  } = await import(path.join(distRenderer, 'models', 'notesFind.js'));
  const result = findNotesTextMatches('x x x x', 'x', 3);

  assert.equal(result.truncated, true);
  assert.deepEqual(result.matches, [
    { from: 0, to: 1 },
    { from: 2, to: 3 },
    { from: 4, to: 5 },
  ]);
  assert.equal(initialNotesFindIndex(result.matches, 3), 2);
  assert.equal(initialNotesFindIndex(result.matches, 9), 0);
  assert.equal(initialNotesFindIndex([], 0), -1);
  assert.equal(moveNotesFindIndex(2, 3, 1), 0);
  assert.equal(moveNotesFindIndex(0, 3, -1), 2);
  assert.equal(moveNotesFindIndex(-1, 3, 1), 0);
  assert.equal(moveNotesFindIndex(-1, 0, 1), -1);
});

test('Rich Text find crosses inline marks but not hard breaks or text blocks', async () => {
  const { findRichTextMatches } = await import(path.join(distRenderer, 'components', 'notesRichTextEditor.js'));
  const text = (value) => ({ isText: true, text: value });
  const hardBreak = { isText: false };
  const textblock = (children) => ({
    isTextblock: true,
    forEach(callback) {
      let offset = 0;
      for (const child of children) {
        callback(child, offset);
        offset += child.isText ? child.text.length : 1;
      }
    },
  });
  const blocks = [
    { node: textblock([text('Al'), text('pha'), hardBreak, text('Alpha')]), position: 0 },
    { node: textblock([text('Alpha')]), position: 12 },
    { node: { isTextblock: false, attrs: { fileName: 'Alpha.pdf' } }, position: 19 },
  ];
  const document = {
    descendants(callback) {
      for (const block of blocks) callback(block.node, block.position);
    },
  };

  assert.deepEqual(findRichTextMatches(document, 'alpha'), {
    matches: [
      { from: 1, to: 6 },
      { from: 7, to: 12 },
      { from: 13, to: 18 },
    ],
    truncated: false,
  });
  assert.deepEqual(findRichTextMatches(document, 'phaAl'), {
    matches: [],
    truncated: false,
  });
});

test('Notes page owns one accessible find bar and editor-specific highlight adapters', async () => {
  const [html, page, richText, styles] = await Promise.all([
    readFile(path.join(root, 'src', 'renderer', 'index.html'), 'utf8'),
    readFile(path.join(root, 'src', 'renderer', 'pages', 'notesPage.ts'), 'utf8'),
    readFile(path.join(root, 'src', 'renderer', 'components', 'notesRichTextEditor.ts'), 'utf8'),
    readFile(path.join(root, 'src', 'renderer', 'tailwind.css'), 'utf8'),
  ]);

  assert.match(html, /id="note-find-bar"[^>]*role="search"[^>]*aria-label="Find in Note"/);
  assert.match(html, /id="note-find-input"[^>]*placeholder="Find in Note"/);
  assert.match(html, /id="note-find-counter"[^>]*aria-live="polite"/);
  assert.match(html, /id="note-find-previous"[^>]*aria-label="Previous match"/);
  assert.match(html, /id="note-find-next"[^>]*aria-label="Next match"/);
  assert.match(html, /id="note-find-close"[^>]*aria-label="Close find"/);

  assert.match(page, /event\.key\.toLocaleLowerCase\(\) === 'f'/);
  assert.match(page, /this\.moveInNoteFind\(event\.shiftKey \? -1 : 1\)/);
  assert.match(page, /this\.resetInNoteFind\(false\);[\s\S]*?this\.editorNoteId = note\.id/);
  assert.match(page, /findNotesTextMatches\(this\.codeEditor\.state\.doc\.toString\(\), query\)/);
  assert.match(page, /this\.codeEditor\.visibleRanges/);
  assert.match(page, /window\.CSS[\s\S]*?highlights/);
  assert.match(page, /this\.richTextEditor\.findText\(query\)/);
  assert.match(page, /this\.richTextEditor\.setFindMatches\(matches, activeIndex\)/);

  assert.match(richText, /new Plugin<DecorationSet>/);
  assert.match(richText, /if \(!node\.isTextblock\) return true/);
  assert.match(richText, /if \(!child\.isText \|\| !child\.text\)/);
  assert.match(richText, /richTextFindRuns\(node, position \+ 1\)/);
  assert.match(richText, /public revealFindMatch\(\): void/);
  assert.match(richText, /\.notes-find-match-active/);

  assert.match(styles, /\.notes-find-bar \{/);
  assert.match(styles, /\.notes-content\[data-language='markdown'\] \.notes-find-bar/);
  assert.match(styles, /::highlight\(notes-code-find-match\)/);
  assert.match(styles, /\.notes-find-match-active/);
  assert.match(styles, /\.notes-content\[data-theme='dark'\] \.notes-find-bar/);
});
