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
    {
      name: 't_problem',
      columns: [
        {
          name: 'difficulty',
          dataType: 'int',
          enum: {
            comment: '难度-1 - 很简单 2 - 简单 3 - 一般 4 - 难 5 - 很难',
            nullable: true,
            defaultValue: '3',
          },
        },
      ],
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

test('SQL table detail target resolves only direct table references', async () => {
  const { resolveSqlTableReferenceAt } = await loadCompletion();
  const source = [
    "select 'from t_problem' as note from app.`t_problem` p",
    'join t_user u on p.creatorId = u.id',
    '-- join t_role',
    'where p.t_problem = 1',
  ].join('\n');
  const quotedPosition = source.indexOf('`t_problem`') + 2;
  const joinedPosition = source.indexOf('t_user');

  assert.deepEqual(resolveSqlTableReferenceAt(source, quotedPosition, schema), {
    tableName: 't_problem',
    from: source.indexOf('`t_problem`'),
    to: source.indexOf('`t_problem`') + '`t_problem`'.length,
  });
  assert.deepEqual(resolveSqlTableReferenceAt(source, joinedPosition, schema), {
    tableName: 't_user',
    from: joinedPosition,
    to: joinedPosition + 't_user'.length,
  });
  assert.equal(resolveSqlTableReferenceAt(source, source.indexOf('t_problem'), schema), undefined);
  assert.equal(resolveSqlTableReferenceAt(source, source.lastIndexOf('t_problem'), schema), undefined);
  assert.equal(resolveSqlTableReferenceAt(source, source.indexOf('t_role'), schema), undefined);
  assert.equal(resolveSqlTableReferenceAt('update t_problem set difficulty = 3', 9, schema)?.tableName, 't_problem');
  assert.equal(resolveSqlTableReferenceAt('insert into t_problem (difficulty) values (3)', 14, schema)?.tableName, 't_problem');
});

test('SQL enum comments mark only the matching database default value', async () => {
  const { sqlEnumCommentParts } = await loadCompletion();
  const spaced = '难度-1 - 很简单 2 - 简单 3 - 一般 4 - 难 5 - 很难';
  const compact = '状态-0-待处理 1-处理中 2-完成';
  const markedSpaced = sqlEnumCommentParts(spaced, '03');
  const markedCompact = sqlEnumCommentParts(compact, '0');

  assert.equal(markedSpaced.map((part) => part.text).join(''), spaced);
  assert.deepEqual(markedSpaced.filter((part) => part.isDefault), [{ text: '3', isDefault: true }]);
  assert.equal(markedCompact.map((part) => part.text).join(''), compact);
  assert.deepEqual(markedCompact.filter((part) => part.isDefault), [{ text: '0', isDefault: true }]);
  assert.deepEqual(sqlEnumCommentParts(spaced), [{ text: spaced, isDefault: false }]);
  assert.deepEqual(sqlEnumCommentParts(spaced, '9'), [{ text: spaced, isDefault: false }]);
  assert.deepEqual(sqlEnumCommentParts(spaced, 'CURRENT_TIMESTAMP'), [{ text: spaced, isDefault: false }]);
});
