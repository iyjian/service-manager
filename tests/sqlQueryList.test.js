const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const loadModel = () => import(pathToFileURL(
  path.join(__dirname, '..', 'dist', 'renderer', 'models', 'sqlQueryList.js'),
).href);

test('refresh then opening a Chinese query preserves the sidebar order regardless of backend collation', async () => {
  const { sortSqlQueryRecords, upsertSqlQueryRecord } = await loadModel();
  const records = [
    { id: 1, name: '财务运营 - 花费明细' },
    { id: 2, name: '用户管理' },
    { id: 3, name: '订单明细' },
    { id: 4, name: 'Zulu' },
    { id: 5, name: 'Alpha' },
  ];
  const refreshed = sortSqlQueryRecords(records);
  assert.deepEqual(refreshed.map(record => record.id), [4, 5, 2, 3, 1]);
  assert.deepEqual(sortSqlQueryRecords([...records].reverse()), refreshed);
  const opened = upsertSqlQueryRecord(refreshed, { ...records[0], sql: 'SELECT 1' });
  assert.deepEqual(opened.map(record => record.id), refreshed.map(record => record.id));
  assert.equal(opened.find(record => record.id === 1).sql, 'SELECT 1');
  assert.deepEqual(records.map(record => record.id), [1, 2, 3, 4, 5]);
});

test('duplicate names have stable order and rename/create use the refresh ordering', async () => {
  const { sortSqlQueryRecords, upsertSqlQueryRecord } = await loadModel();
  const records = [{ id: 2, name: 'Beta' }, { id: 1, name: 'Beta' }];
  assert.deepEqual(sortSqlQueryRecords(records).map(record => record.id), [1, 2]);
  let updated = upsertSqlQueryRecord(records, { id: 1, name: 'Alpha' });
  updated = upsertSqlQueryRecord(updated, { id: 3, name: 'Zulu' });
  assert.deepEqual(updated.map(record => record.id), [3, 2, 1]);
  assert.deepEqual(sortSqlQueryRecords([...updated].reverse()), updated);
});
