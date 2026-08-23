const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

async function loadCompletion() {
  return import(pathToFileURL(
    path.join(__dirname, '..', 'dist', 'renderer', 'components', 'sqlCompletion.js'),
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
    {
      name: 't_test_paper',
      columns: [
        { name: 'id', dataType: 'bigint' },
        {
          name: 'status',
          dataType: 'int',
          enum: {
            comment: '状态-0 - 未审核 1 - 审核不通过 2 - 审核通过',
            nullable: false,
            defaultValue: '0',
          },
        },
        {
          name: 'isProject',
          dataType: 'tinyint',
          enum: {
            comment: '是否项目-0 - 否 1 - 是',
            nullable: false,
            defaultValue: '0',
          },
        },
        { name: 'sourceTestPaperId', dataType: 'bigint' },
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

test('SQL default-table inference ignores preceding statements', async () => {
  const { resolveSqlDefaultTable } = await loadCompletion();

  assert.equal(
    resolveSqlDefaultTable('select * from t_user; select * from t_role where c', schema),
    't_role',
  );
  assert.equal(
    resolveSqlDefaultTable('select * from t_user;\nselect * from t_role where c', schema),
    't_role',
  );
  assert.equal(
    resolveSqlDefaultTable("select * from t_user where userName = 'x'; select * from t_role where c", schema),
    't_role',
  );
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
  const { resolveSqlTableReferenceAt, resolveSqlTableReferenceNear } = await loadCompletion();
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
  assert.deepEqual(resolveSqlTableReferenceAt('select * from app.t_problem p where p.difficulty = 3', 18, schema), {
    tableName: 't_problem',
    from: 18,
    to: 27,
  });
  const commentedUpdate = [
    '-- 把已售卖的课程标记为项目式单元',
    'update t_test_paper set isProject =1 where courseId in (select id from t_course where saleStatus=1) and type = 4;',
  ].join('\n');
  const commentedUpdateTable = commentedUpdate.indexOf('t_test_paper');
  assert.deepEqual(resolveSqlTableReferenceAt(commentedUpdate, commentedUpdateTable + 2, schema), {
    tableName: 't_test_paper',
    from: commentedUpdateTable,
    to: commentedUpdateTable + 't_test_paper'.length,
  });
  assert.deepEqual(
    resolveSqlTableReferenceNear(
      commentedUpdate,
      commentedUpdate.indexOf('update'),
      schema,
      {
        from: commentedUpdateTable,
        to: commentedUpdateTable + 't_test_paper'.length,
      },
    ),
    {
      tableName: 't_test_paper',
      from: commentedUpdateTable,
      to: commentedUpdateTable + 't_test_paper'.length,
    },
  );

  const multiTableUpdate = [
    'update t_test_paper s, t_test_paper t',
    'set s.isProject = 1',
    'where s.sourceTestPaperId = t.id and t.isProject = 1;',
  ].join('\n');
  const firstUpdatedTable = multiTableUpdate.indexOf('t_test_paper');
  const secondUpdatedTable = multiTableUpdate.lastIndexOf('t_test_paper');
  assert.deepEqual(resolveSqlTableReferenceAt(multiTableUpdate, firstUpdatedTable + 2, schema), {
    tableName: 't_test_paper',
    from: firstUpdatedTable,
    to: firstUpdatedTable + 't_test_paper'.length,
  });
  assert.deepEqual(resolveSqlTableReferenceAt(multiTableUpdate, secondUpdatedTable + 2, schema), {
    tableName: 't_test_paper',
    from: secondUpdatedTable,
    to: secondUpdatedTable + 't_test_paper'.length,
  });
  assert.equal(resolveSqlTableReferenceAt(multiTableUpdate, multiTableUpdate.indexOf(' s,') + 1, schema), undefined);
  assert.equal(resolveSqlTableReferenceAt(multiTableUpdate, multiTableUpdate.indexOf('t.id'), schema), undefined);
  assert.equal(
    resolveSqlTableReferenceAt('select extract(year from t_problem) from t_user', 25, schema),
    undefined,
  );
});

test('ANTLR SQL parsing does not print SQL syntax recovery to console', async () => {
  const { resolveSqlTableReferenceAt } = await loadCompletion();
  const originalError = console.error;
  const messages = [];
  console.error = (...args) => messages.push(args);
  try {
    const sql = [
      '-- 把已售卖的课程标记为项目式单元',
      'update t_test_paper set isProject =1 where courseId in (select id from t_course where saleStatus=1) and type = 4;',
    ].join('\n');
    resolveSqlTableReferenceAt(sql, sql.indexOf('t_test_paper') + 2, schema);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(messages, []);
});

test('SQL enum comments mark only the matching database default value', async () => {
  const { parseSqlEnumComment } = await loadCompletion();
  assert.deepEqual(parseSqlEnumComment('单元类型-1 - 练习 2 - 知识 3 - 竞赛 4 - 项目 5 - 错题集', '4'), {
    description: '单元类型',
    values: [
      { value: '1', description: '练习', isDefault: false },
      { value: '2', description: '知识', isDefault: false },
      { value: '3', description: '竞赛', isDefault: false },
      { value: '4', description: '项目', isDefault: true },
      { value: '5', description: '错题集', isDefault: false },
    ],
  });
});

test('ANTLR SQL completion resolves aliases and enum value candidates', async () => {
  const {
    resolveSqlEnumValueCompletion,
    resolveSqlQualifiedColumnCompletion,
  } = await loadCompletion();
  const unqualified = 'select  from t_test_paper where status =';
  const unqualifiedWithSpace = 'select * from t_test_paper where status = ';
  const unqualifiedWithNbsp = 'select * from t_test_paper where status =\u00a0';
  const qualified = 'select * from t_test_paper s where s.status =';
  const qualifiedWithSpace = 'select * from t_test_paper s where s.status = ';
  const qualifiedWithValue = 'select * from app.t_test_paper s where s.status = 1';
  const aliasColumns = 'select  from t_test_paper s where s.';

  assert.deepEqual(
    resolveSqlEnumValueCompletion(unqualified, unqualified.length, schema)?.options.map((option) => ({
      label: option.label,
      detail: option.detail,
    })),
    [
      { label: '0', detail: '未审核 default' },
      { label: '1', detail: '审核不通过' },
      { label: '2', detail: '审核通过' },
    ],
  );
  assert.equal(resolveSqlEnumValueCompletion(unqualifiedWithSpace, unqualifiedWithSpace.length, schema)?.from, unqualifiedWithSpace.length);
  assert.equal(resolveSqlEnumValueCompletion(unqualifiedWithNbsp, unqualifiedWithNbsp.length, schema)?.from, unqualifiedWithNbsp.length);
  assert.deepEqual(
    resolveSqlEnumValueCompletion(qualified, qualified.length, schema)?.options.map((option) => option.label),
    ['0', '1', '2'],
  );
  assert.deepEqual(
    resolveSqlEnumValueCompletion(qualifiedWithSpace, qualifiedWithSpace.length, schema)?.options.map((option) => option.label),
    ['0', '1', '2'],
  );
  assert.equal(resolveSqlEnumValueCompletion(qualifiedWithValue, qualifiedWithValue.length, schema)?.from, qualifiedWithValue.length - 1);
  assert.deepEqual(
    resolveSqlQualifiedColumnCompletion(aliasColumns, aliasColumns.length, schema)?.options.map((option) => option.label),
    ['id', 'status', 'isProject', 'sourceTestPaperId'],
  );
});
