const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

async function loadModule(name) {
  return import(pathToFileURL(path.join(__dirname, '..', 'dist', 'renderer', name)).href);
}

test('SQL statement scanner ignores semicolons inside strings, identifiers, and comments', async () => {
  const { findSqlStatementBoundaries } = await loadModule('sqlStatement.js');
  const splitSqlStatements = (src) => findSqlStatementBoundaries(src).map(({ from, to }) => ({ from, to, sql: src.slice(from, to) }));
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
  const {
    findSqlStatementBoundaries,
    resolveSqlStatementBoundary,
    resolveSqlStatement,
    resolveSqlStatementFromBoundaries,
  } = await loadModule('sqlStatement.js');
  const source = 'select 1;\n\nselect 2;\nselect 3;';
  const boundaries = findSqlStatementBoundaries(source);
  let caretReadCount = 0;

  assert.equal(resolveSqlStatement(source, source.indexOf('2')).statement.sql, 'select 2;');
  assert.equal(resolveSqlStatement(source, 10).statement.sql, 'select 2;');
  assert.equal(resolveSqlStatement(source, 0, 'select 1'.length).statement.sql, 'select 1');
  assert.equal(
    resolveSqlStatementFromBoundaries(source, boundaries, source.indexOf('3')).statement.sql,
    'select 3;',
  );
  assert.deepEqual(
    resolveSqlStatementBoundary(
      source.length,
      boundaries,
      source.indexOf('2'),
      source.indexOf('2'),
      () => {
        caretReadCount += 1;
        return '';
      },
    ),
    {
      ok: true,
      statement: boundaries[1],
    },
  );
  assert.equal(caretReadCount, 0);
  assert.deepEqual(resolveSqlStatement(source, 0, source.length), {
    ok: false,
    message: 'Select exactly one SQL statement to run.',
  });
});

test('SQL template parameters preserve reference behavior', async () => {
  const {
    extractSqlTemplateParamNames,
    replaceSqlTemplateParams,
  } = await loadModule('sqlStatement.js');

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
    normalizeSqlEditorSource,
    normalizeSqlSelectLimit,
    sqlSaveShortcutLabel,
    sqlShortcutLabel,
  } = await loadModule('sqlPage.js');
  const event = (overrides) => ({
    key: 'Enter', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides,
  });

  assert.equal(isSqlRunShortcut(event({ metaKey: true }), true), true);
  assert.equal(isSqlRunShortcut(event({ key: 'r', metaKey: true }), true), false);
  assert.equal(isSqlRunShortcut(event({ metaKey: true, ctrlKey: true }), true), false);
  assert.equal(isSqlRunShortcut(event({ ctrlKey: true }), false), true);
  assert.equal(isSqlRunShortcut(event({ metaKey: true }), false), false);
  assert.equal(isSqlSaveShortcut(event({ key: 's', metaKey: true }), true), true);
  assert.equal(isSqlSaveShortcut(event({ key: 's', ctrlKey: true }), true), false);
  assert.equal(isSqlSaveShortcut(event({ key: 'S', ctrlKey: true }), false), true);
  assert.equal(isSqlSaveShortcut(event({ key: 's', ctrlKey: true, shiftKey: true }), false), false);
  assert.equal(sqlShortcutLabel('MacIntel'), '⌘Enter');
  assert.equal(sqlShortcutLabel('Win32'), 'Ctrl+Enter');
  assert.equal(sqlSaveShortcutLabel('MacIntel'), '⌘S');
  assert.equal(sqlSaveShortcutLabel('Linux x86_64'), 'Ctrl+S');
  assert.equal(normalizeSqlSelectLimit(''), 100);
  assert.equal(normalizeSqlSelectLimit('0'), 1);
  assert.equal(normalizeSqlSelectLimit('250.8'), 250);
  assert.equal(normalizeSqlSelectLimit('10001'), 10000);
  assert.equal(normalizeSqlEditorSource('SELECT\t*\nFROM\tusers;'), 'SELECT  *\nFROM  users;');
  assert.equal(normalizeSqlEditorSource('SELECT  *\nFROM users;'), 'SELECT  *\nFROM users;');
});
