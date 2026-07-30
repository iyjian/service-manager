const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

async function loadCompletion() {
  return import(pathToFileURL(
    path.join(__dirname, '..', 'dist', 'renderer', 'sqlCompletion.js'),
  ).href);
}

const schema = {
  environment: 'production',
  tables: [
    {
      name: 't_user',
      columns: [
        { name: 'id', dataType: 'bigint' },
        { name: 'userName', dataType: 'varchar(255)' },
      ],
    },
    {
      name: 't_role',
      columns: [{ name: 'role-name', dataType: 'varchar(64)' }],
    },
  ],
};

test('SQL completion namespace preserves tables, typed columns, and quoted identifiers', async () => {
  const { buildSqlCompletionNamespace, defaultTableColumnCompletions } = await loadCompletion();
  const namespace = buildSqlCompletionNamespace(schema);

  assert.equal(namespace.t_user.self.label, 't_user');
  assert.equal(namespace.t_user.self.type, 'type');
  assert.deepEqual(namespace.t_user.children[0], {
    label: 'id',
    type: 'property',
    detail: 'bigint',
    boost: 30,
  });
  assert.equal(namespace.t_role.children[0].apply, '`role-name`');
  assert.deepEqual(
    defaultTableColumnCompletions(schema, 't_user').map((column) => column.label),
    ['id', 'userName'],
  );
});

test('SQL default-table inference is statement-local and ignores literals and comments', async () => {
  const { resolveSqlDefaultTable } = await loadCompletion();

  assert.equal(
    resolveSqlDefaultTable(
      "select * from t_user where userName = 'from t_role where' and us",
      schema,
    ),
    't_user',
  );
  assert.equal(
    resolveSqlDefaultTable(
      'select * from t_role /* join t_user */ where `role-name` = 1',
      schema,
    ),
    't_role',
  );
  assert.equal(
    resolveSqlDefaultTable(
      'select * from app.`t_user` u join t_role r on u.id = r.id where u.',
      schema,
    ),
    undefined,
  );
  assert.equal(resolveSqlDefaultTable('select * from t_user', schema), undefined);
});

test('official MySQL schema completion resolves table aliases from the generated namespace', async () => {
  const { EditorState } = require('@codemirror/state');
  const { MySQL, schemaCompletionSource, sql } = require('@codemirror/lang-sql');
  const { buildSqlCompletionNamespace } = await loadCompletion();
  const doc = 'select u. from t_user u';
  const state = EditorState.create({
    doc,
    extensions: [sql({ dialect: MySQL })],
  });
  const source = schemaCompletionSource({
    dialect: MySQL,
    schema: buildSqlCompletionNamespace(schema),
  });
  const result = await source({
    state,
    pos: doc.indexOf('.') + 1,
    explicit: true,
  });

  assert.ok(result);
  assert.deepEqual(result.options.map((option) => option.label), ['id', 'userName']);
});
