const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

async function loadVirtualWindow() {
  return import(pathToFileURL(
    path.join(__dirname, '..', 'dist', 'renderer', 'models', 'sqlResultVirtualWindow.js'),
  ).href);
}

test('small SQL results retain the complete original table body', async () => {
  const { calculateSqlResultVirtualWindow } = await loadVirtualWindow();
  assert.deepEqual(calculateSqlResultVirtualWindow({
    rowCount: 100,
    scrollTop: 900,
    viewportHeight: 340,
    rowHeight: 31,
  }), {
    start: 0,
    end: 100,
    topSpacerHeight: 0,
    bottomSpacerHeight: 0,
  });
});

test('large SQL results retain only a chunked visible row window', async () => {
  const { calculateSqlResultVirtualWindow } = await loadVirtualWindow();
  assert.deepEqual(calculateSqlResultVirtualWindow({
    rowCount: 1_000,
    scrollTop: 0,
    viewportHeight: 340,
    rowHeight: 31,
  }), {
    start: 0,
    end: 24,
    topSpacerHeight: 0,
    bottomSpacerHeight: 30_256,
  });

  assert.deepEqual(calculateSqlResultVirtualWindow({
    rowCount: 1_000,
    scrollTop: (500 * 31) + 34,
    viewportHeight: 340,
    rowHeight: 31,
  }), {
    start: 488,
    end: 520,
    topSpacerHeight: 15_128,
    bottomSpacerHeight: 14_880,
  });
});

test('the final SQL result window reaches the last row without a bottom gap', async () => {
  const { calculateSqlResultVirtualWindow } = await loadVirtualWindow();
  const range = calculateSqlResultVirtualWindow({
    rowCount: 1_000,
    scrollTop: Number.MAX_SAFE_INTEGER,
    viewportHeight: 340,
    rowHeight: 31,
  });
  assert.equal(range.start, 984);
  assert.equal(range.end, 1_000);
  assert.equal(range.topSpacerHeight, 30_504);
  assert.equal(range.bottomSpacerHeight, 0);
});

