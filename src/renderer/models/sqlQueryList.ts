type NamedQuery = { id: number; name: string };

// Use the same collation on refresh and edits, independent of Electron's locale
// and the backend database's collation. Chinese names use pinyin ordering.
const queryNameCollator = new Intl.Collator('zh-CN');

export function sortSqlQueryRecords<T extends NamedQuery>(records: readonly T[]): T[] {
  return [...records].sort((left, right) => (
    queryNameCollator.compare(right.name, left.name) || left.id - right.id
  ));
}

export function upsertSqlQueryRecord<T extends NamedQuery>(records: readonly T[], record: T): T[] {
  return sortSqlQueryRecords([...records.filter((item) => item.id !== record.id), record]);
}
