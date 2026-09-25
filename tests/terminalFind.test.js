const test = require('node:test');
const assert = require('node:assert/strict');

function buffer(rows) {
  const lines = rows.map(({ cells, wrapped = false }) => ({
    isWrapped: wrapped, length: cells.length,
    getCell: (col) => cells[col] && ({ getChars: () => cells[col][0], getWidth: () => cells[col][1] }),
    translateToString: (trim) => {
      const text = cells.filter((c) => c[1] !== 0).map((c) => c[0] || ' ').join('');
      return trim ? text.trimEnd() : text;
    },
  }));
  return { length: lines.length, getLine: (row) => lines[row] };
}
const ascii = (text, wrapped = false) => ({ cells: [...text].map((char) => [char, 1]), wrapped });

test('terminal search is literal, case insensitive and counts retained history', async () => {
  const { findTerminalMatches } = await import('../dist/renderer/models/terminalFind.js');
  const b = buffer([ascii('WuChong / wuchong'), ascii('a.*b')]);
  assert.deepEqual(findTerminalMatches(b, 'wuchong').matches.map((m) => [m.start.row, m.start.col, m.end.col]), [[0, 0, 6], [0, 10, 16]]);
  assert.equal(findTerminalMatches(b, '.*').matches.length, 1);
  assert.equal(findTerminalMatches(b, '').matches.length, 0);
  assert.equal(findTerminalMatches(b, 'missing').matches.length, 0);
});

test('terminal search spans soft wraps but never joins separate output lines', async () => {
  const { findTerminalMatches } = await import('../dist/renderer/models/terminalFind.js');
  assert.deepEqual(findTerminalMatches(buffer([ascii('wu'), ascii('chong', true)]), 'wuchong').matches,
    [{ start: { row: 0, col: 0, width: 1 }, end: { row: 1, col: 4, width: 1 } }]);
  assert.equal(findTerminalMatches(buffer([ascii('wu'), ascii('chong')]), 'wuchong').matches.length, 0);
});

test('Chinese, emoji and combining marks map to terminal columns rather than string offsets', async () => {
  const { findTerminalMatches } = await import('../dist/renderer/models/terminalFind.js');
  const b = buffer([{ cells: [['理', 2], ['', 0], ['论', 2], ['', 0], ['😀', 2], ['', 0], ['e\u0301', 1], ['x', 1]] }]);
  assert.deepEqual(findTerminalMatches(b, '理论😀').matches,
    [{ start: { row: 0, col: 0, width: 2 }, end: { row: 0, col: 4, width: 2 } }]);
  assert.equal(findTerminalMatches(b, 'x').matches[0].start.col, 7);
  assert.equal(findTerminalMatches(b, 'e\u0301').matches[0].start.col, 6);
});

test('wide-character wrap padding is excluded while actual spaces remain searchable', async () => {
  const { findTerminalMatches } = await import('../dist/renderer/models/terminalFind.js');
  const b = buffer([{ cells: [['a', 1], ['', 1]] }, { cells: [['中', 2], ['', 0]], wrapped: true }]);
  assert.equal(findTerminalMatches(b, 'a中').matches.length, 1);
  assert.equal(findTerminalMatches(buffer([ascii('a '), ascii('b', true)]), 'a b').matches.length, 1);
});

test('terminal search bounds result count and reports truncation only when another match exists', async () => {
  const { findTerminalMatches } = await import('../dist/renderer/models/terminalFind.js');
  assert.equal(findTerminalMatches(buffer([ascii('xx')]), 'x', 2).truncated, false);
  const result = findTerminalMatches(buffer([ascii('xx'), ascii('x')]), 'x', 2);
  assert.equal(result.truncated, true); assert.equal(result.matches.length, 2);
});
