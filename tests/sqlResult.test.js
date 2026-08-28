const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function sqlResult() {
  return import(pathToFileURL(path.join(__dirname, '..', 'dist', 'renderer', 'models', 'sqlResult.js')).href);
}

test('SQL results normalize tables, mutations, scalars, and multiple result sets', async () => {
  const {
    normalizeSqlResult,
    parseSqlMutationMessage,
    sqlMutationSummaryMetrics,
    sqlResultRowCount,
    sqlResultRowCountInfo,
  } = await sqlResult();
  const table = normalizeSqlResult([{ id: 1, name: 'Ada' }, { id: 2, active: true }]);
  assert.equal(table.kind, 'table');
  assert.deepEqual(table.columns, ['id', 'name', 'active']);
  assert.equal(sqlResultRowCount(table), 2);
  assert.equal(sqlResultRowCountInfo(table), 2);

  const mutation = normalizeSqlResult({ affectedRows: 3, changedRows: 2, message: 'ok' });
  assert.equal(mutation.kind, 'summary');
  assert.equal(mutation.message, 'ok');
  assert.deepEqual(mutation.raw, { affectedRows: 3, changedRows: 2, message: 'ok' });
  assert.deepEqual(mutation.items.map((item) => item.label), ['affectedRows', 'changedRows']);
  assert.deepEqual(sqlMutationSummaryMetrics(mutation), {
    affectedRows: 3,
    matchedRows: 3,
    changedRows: 2,
  });

  const rawMutation = normalizeSqlResult([[], {
    affectedRows: 4,
    changedRows: 1,
    warningStatus: 2,
    info: 'Rows matched: 4  Changed: 1  Warnings: 2',
  }]);
  assert.equal(rawMutation.kind, 'summary');
  assert.equal(rawMutation.message, 'Rows matched: 4  Changed: 1  Warnings: 2');
  assert.deepEqual(sqlMutationSummaryMetrics(rawMutation), {
    affectedRows: 4,
    matchedRows: 4,
    changedRows: 1,
    warnings: 2,
  });
  assert.deepEqual(parseSqlMutationMessage('Rows matched: 9 Changed: 0 Warnings: 1'), {
    matchedRows: 9,
    changedRows: 0,
    warnings: 1,
  });

  const multi = normalizeSqlResult([[{ value: 1 }], 7, []]);
  assert.equal(multi.kind, 'multi');
  assert.equal(sqlResultRowCount(multi), 1);
  assert.equal(normalizeSqlResult('done').kind, 'scalar');
  const empty = normalizeSqlResult([]);
  assert.equal(empty.kind, 'empty');
  assert.equal(sqlResultRowCountInfo(empty), 0);
});

test('SQL cells keep NULL explicit and format structured values safely', async () => {
  const { formatSqlCell, formatSqlDuration, sqlCellPresentation } = await sqlResult();
  assert.equal(formatSqlCell(null), 'NULL');
  assert.equal(formatSqlCell(false), 'false');
  assert.equal(formatSqlCell({ ok: true }), '{"ok":true}');
  assert.equal(formatSqlCell('first\nsecond\tthird'), 'first second third');

  const json = sqlCellPresentation('{"enabled":true,"items":[1,2]}');
  assert.equal(json.kind, 'json');
  assert.match(json.formatted, /\n/);
  assert.doesNotMatch(json.display, /[\r\n]/);

  const html = sqlCellPresentation('<p>Hello <strong>world</strong></p>');
  assert.equal(html.kind, 'html');
  assert.equal(sqlCellPresentation('2 < 4').kind, 'text');
  assert.equal(sqlCellPresentation({ nested: { value: 1 } }).kind, 'json');

  assert.equal(formatSqlDuration(87), '87 ms');
  assert.equal(formatSqlDuration(1_250), '1.25 s');
  assert.equal(formatSqlDuration(12_300), '12.3 s');
});
