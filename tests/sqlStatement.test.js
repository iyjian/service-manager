const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadModule(name) {
  return import(pathToFileURL(path.join(__dirname, '..', 'dist', 'renderer', name)).href);
}

test('SQL statement scanner ignores semicolons inside strings, identifiers, and comments', async () => {
  const { splitSqlStatements } = await loadModule('sqlStatement.js');
  const source = [
    "select ';' as value;",
    'select `semi;column` from demo /* ; ignored */;',
    '-- ; ignored\nselect "second;value";',
    '# comment;\nselect 4',
  ].join('\n');
  const statements = splitSqlStatements(source);

  assert.equal(statements.length, 4);
  assert.equal(statements[0].sql, "select ';' as value;");
  assert.match(statements[1].sql, /`semi;column`/);
  assert.match(statements[2].sql, /select "second;value";/);
  assert.match(statements[3].sql, /select 4$/);

  const mysqlMinus = splitSqlStatements('select 1--2; select 3;');
  assert.equal(mysqlMinus.length, 2);
  assert.equal(mysqlMinus[0].sql, 'select 1--2;');
});

test('SQL execution resolves a selection first and otherwise the cursor statement', async () => {
  const { resolveSqlStatement } = await loadModule('sqlStatement.js');
  const source = 'select 1;\n\nselect 2;\nselect 3;';

  assert.equal(resolveSqlStatement(source, source.indexOf('2')).statement.sql, 'select 2;');
  assert.equal(resolveSqlStatement(source, 10).statement.sql, 'select 2;');
  assert.equal(resolveSqlStatement(source, 0, 'select 1'.length).statement.sql, 'select 1');
  assert.deepEqual(resolveSqlStatement(source, 0, source.length), {
    ok: false,
    message: 'Select exactly one SQL statement to run.',
  });
});

test('SQL production guard is conservative and template parameters preserve reference behavior', async () => {
  const {
    extractSqlTemplateParamNames,
    isLikelyReadOnlySql,
    replaceSqlTemplateParams,
  } = await loadModule('sqlStatement.js');

  assert.equal(isLikelyReadOnlySql('/* safe */ SELECT 1'), true);
  assert.equal(isLikelyReadOnlySql('-- comment\nshow tables'), true);
  assert.equal(isLikelyReadOnlySql('with rows as (select 1) select * from rows'), false);
  assert.equal(isLikelyReadOnlySql('update users set active = 1'), false);
  assert.deepEqual(extractSqlTemplateParamNames('select {{ id }}, {{name}}, {{id}}'), ['id', 'name']);
  assert.equal(
    replaceSqlTemplateParams('select * from users where id={{ id }} and name={{name}}', { id: '7', name: "'Ada'" }),
    "select * from users where id=7 and name='Ada'",
  );
});

test('SQL shortcuts match the platform-specific Save and Run behavior', async () => {
  const {
    isSqlRunShortcut,
    isSqlSaveShortcut,
    sqlSaveShortcutLabel,
    sqlShortcutLabel,
  } = await loadModule('sqlPage.js');
  const event = (overrides) => ({
    key: 'Enter', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides,
  });

  assert.equal(isSqlRunShortcut(event({ key: 'r', metaKey: true }), true), true);
  assert.equal(isSqlRunShortcut(event({ metaKey: true }), true), false);
  assert.equal(isSqlRunShortcut(event({ ctrlKey: true }), false), true);
  assert.equal(isSqlRunShortcut(event({ metaKey: true }), false), false);
  assert.equal(isSqlSaveShortcut(event({ key: 's', metaKey: true }), true), true);
  assert.equal(isSqlSaveShortcut(event({ key: 's', ctrlKey: true }), true), false);
  assert.equal(isSqlSaveShortcut(event({ key: 'S', ctrlKey: true }), false), true);
  assert.equal(isSqlSaveShortcut(event({ key: 's', ctrlKey: true, shiftKey: true }), false), false);
  assert.equal(sqlShortcutLabel('MacIntel'), '⌘R');
  assert.equal(sqlShortcutLabel('Win32'), 'Ctrl+Enter');
  assert.equal(sqlSaveShortcutLabel('MacIntel'), '⌘S');
  assert.equal(sqlSaveShortcutLabel('Linux x86_64'), 'Ctrl+S');
});
