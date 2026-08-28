const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

async function loadModules() {
  const [cellEdit, completion] = await Promise.all([
    import(pathToFileURL(path.join(__dirname, '..', 'dist', 'renderer', 'models', 'sqlCellEdit.js')).href),
    import(pathToFileURL(path.join(__dirname, '..', 'dist', 'renderer', 'components', 'sqlCompletion.js')).href),
  ]);
  return { cellEdit, completion };
}

test('SQL cell update statements quote identifiers and infer literals by runtime type', async () => {
  const { cellEdit } = await loadModules();

  assert.equal(
    cellEdit.buildUpdateStatement({
      table: 't_user',
      column: 'name',
      originalValue: 'Development',
      editedText: 'Production',
      primaryKey: [{ column: 'id', value: 5 }],
    }),
    "UPDATE `t_user` SET `name` = 'Production' WHERE `id` = 5;",
  );

  assert.equal(
    cellEdit.buildUpdateStatement({
      table: 't_user',
      column: 'age',
      originalValue: 5,
      editedText: '6',
      primaryKey: [{ column: 'id', value: 5 }],
    }),
    'UPDATE `t_user` SET `age` = 6 WHERE `id` = 5;',
  );

  assert.equal(
    cellEdit.buildUpdateStatement({
      table: 't_user',
      column: 'active',
      originalValue: true,
      editedText: 'false',
      primaryKey: [{ column: 'id', value: 1 }],
    }),
    'UPDATE `t_user` SET `active` = FALSE WHERE `id` = 1;',
  );

  assert.equal(
    cellEdit.buildUpdateStatement({
      table: 't_user',
      column: 'nickname',
      originalValue: null,
      editedText: 'NULL',
      primaryKey: [{ column: 'id', value: 9 }],
    }),
    'UPDATE `t_user` SET `nickname` = NULL WHERE `id` = 9;',
  );
});

test('SQL cell SET literal keeps NULL, quotes strings, and falls back for unparsable numbers', async () => {
  const { cellEdit } = await loadModules();

  assert.equal(cellEdit.buildSqlSetLiteral(null, ''), 'NULL');
  assert.equal(cellEdit.buildSqlSetLiteral(null, 'NULL'), 'NULL');
  assert.equal(cellEdit.buildSqlSetLiteral(null, 'hello'), "'hello'");
  assert.equal(cellEdit.buildSqlSetLiteral('Dev', 'Dev'), "'Dev'");
  assert.equal(cellEdit.buildSqlSetLiteral('NULL', 'NULL'), "'NULL'");
  assert.equal(cellEdit.buildSqlSetLiteral(5, '6'), '6');
  assert.equal(cellEdit.buildSqlSetLiteral(5, 'not-a-number'), "'not-a-number'");
  assert.equal(cellEdit.buildSqlSetLiteral(5, ''), 'NULL');
});

test('SQL cell edits compare against the current runtime value after execution', async () => {
  const { cellEdit } = await loadModules();
  const text = { kind: 'text' };

  assert.equal(cellEdit.sqlEditedRuntimeValue(1, text, '2'), 2);
  assert.equal(cellEdit.isSqlEditedValueChanged(2, text, '2'), false);
  assert.equal(cellEdit.isSqlEditedValueChanged(2, text, '1'), true);
  assert.equal(cellEdit.sqlEditedRuntimeValue(true, text, '0'), false);
  assert.equal(cellEdit.sqlEditedRuntimeValue(null, text, 'NULL'), null);
});

test('SQL JSON cell edits use canonical text for dirty checks and local table values', async () => {
  const { cellEdit } = await loadModules();
  const json = { kind: 'json' };

  assert.equal(
    cellEdit.isSqlEditedValueChanged('{"enabled":true}', json, '{\n  "enabled": true\n}'),
    false,
  );
  assert.equal(
    cellEdit.sqlEditedRuntimeValue('{"enabled":true}', json, '{\n  "enabled": false\n}'),
    '{"enabled":false}',
  );
  assert.deepEqual(
    cellEdit.sqlEditedRuntimeValue({ enabled: true }, json, '{\n  "enabled": false\n}'),
    { enabled: false },
  );
  assert.equal(
    cellEdit.isSqlEditedValueChanged({ enabled: true }, json, '{\n  "enabled": false\n}'),
    true,
  );
});

test('SQL cell literals escape quotes and composite primary keys join with AND', async () => {
  const { cellEdit } = await loadModules();

  assert.equal(cellEdit.buildSqlSetLiteral('O\'Brien', 'O\'Brien'), "'O''Brien'");
  assert.equal(cellEdit.quoteSqlIdentifier('a`b'), '`a``b`');

  assert.equal(
    cellEdit.buildUpdateStatement({
      table: 't_pair',
      column: 'value',
      originalValue: 1,
      editedText: '2',
      primaryKey: [
        { column: 'a', value: 1 },
        { column: 'b', value: 2 },
      ],
    }),
    'UPDATE `t_pair` SET `value` = 2 WHERE `a` = 1 AND `b` = 2;',
  );
});

test('SQL cell highlighting escapes markup and annotates keywords, identifiers, and values', async () => {
  const { cellEdit } = await loadModules();

  const html = cellEdit.highlightUpdateSql(
    "UPDATE `t_user` SET `name` = '<b>x</b>' WHERE `id` = 5;",
  );

  assert.match(html, /<span class="sql-keyword">UPDATE<\/span>/);
  assert.match(html, /<span class="sql-ident">`t_user`<\/span>/);
  assert.match(html, /<span class="sql-value">'&lt;b&gt;x&lt;\/b&gt;'<\/span>/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
});

test('SQL single-table detection masks literals and comments and lists FROM/JOIN tables', async () => {
  const { completion } = await loadModules();

  assert.deepEqual(completion.resolveSqlSelectTables('select * from t_user'), ['t_user']);
  assert.deepEqual(
    completion.resolveSqlSelectTables('select * from t_user join t_order on t_order.uid = t_user.id'),
    ['t_user', 't_order'],
  );
  assert.deepEqual(
    completion.resolveSqlSelectTables('select * from t_user where note = "from t_evil"'),
    ['t_user'],
  );
  assert.deepEqual(completion.resolveSqlSelectTables('select * from `t_user`'), ['t_user']);
  assert.deepEqual(completion.resolveSqlSelectTables('select 1'), []);
});
