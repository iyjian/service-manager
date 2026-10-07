const test = require('node:test');
const assert = require('node:assert/strict');
const { parseChromeCsv, planChromeImport } = require('../dist/main/vault/chromeImport');
const { validateRecords, entryView } = require('../dist/main/vault/entries');
const csv = 'name,url,username,password,note\r\nExample,https://EXAMPLE.com,alice,password-one,"line one, with comma\nline two"\r\nExample,https://example.com/,bob,password-two,Other account';
test('Chrome CSV supports BOM, quoted commas, multiline notes and groups accounts by URL', () => {
 const rows = parseChromeCsv('\ufeff' + csv); const plan = planChromeImport([], rows);
 assert.equal(plan.accounts, 2); assert.equal(plan.websites, 1);
 assert.equal(plan.records[0].accounts.length, 2); assert.equal(plan.records[0].loginUrl, 'https://example.com/');
 assert.equal(plan.records[0].accounts[0].notes, 'line one, with comma\nline two');
 assert.ok(!JSON.stringify(plan.rows).includes('password-one'));
 assert.ok(!JSON.stringify(entryView(plan.records[0])).includes('password-two'));
});
test('import detects duplicates and conflicting usernames without overwriting existing secrets', () => {
 const rows = parseChromeCsv(csv); const first = planChromeImport([], rows);
 const duplicate = planChromeImport(first.records, rows); assert.equal(duplicate.accounts, 0); assert.ok(duplicate.rows.every(row => row.status === 'duplicate'));
 const conflict = planChromeImport(first.records, [{ ...rows[0], password: 'different' }]);
 assert.equal(conflict.rows[0].status, 'conflict'); assert.deepEqual(conflict.records, first.records);
 const repeated = planChromeImport([], [rows[0], rows[0], { ...rows[0], password: 'different' }]);
 assert.deepEqual(repeated.rows.map(row => row.status), ['ready', 'duplicate', 'conflict']);
});
test('invalid rows never echo embedded URL credentials and malformed CSV errors are sanitized', () => {
 const rows = parseChromeCsv('url,username,password\nhttps://u:do-not-show@example.com,alice,secret\nandroid://app,alice,secret');
 assert.ok(rows.every(row => row.invalid)); assert.ok(!JSON.stringify(planChromeImport([], rows).rows).includes('do-not-show'));
 assert.throws(() => parseChromeCsv('url,username\nhttps://example.com,alice'), /must include/);
 assert.throws(() => parseChromeCsv('url,username,password\nhttps://example.com,alice,"SECRET'), error => !error.message.includes('SECRET'));
});
test('legacy multiple URLs expand deterministically while preserving all passwords and account notes', () => {
 const legacy = { id: 'old', name: 'Old name', type: 'login', createdAt: '2026-10-05T00:00:00Z', application: 'Old app', username: 'alice', password: 'secret', notes: 'account note', urls: ['https://one.example/login', 'https://two.example/login'], tags: [] };
 const migrated = validateRecords([legacy]); assert.equal(migrated.length, 2); assert.equal(migrated[0].id, 'old');
 assert.deepEqual(validateRecords([legacy]), migrated); assert.deepEqual(validateRecords(migrated), migrated);
 for (const record of migrated) { assert.equal(record.accounts[0].password, 'secret'); assert.equal(record.accounts[0].notes, 'account note'); }
 const noUrl = validateRecords([{ ...legacy, urls: [] }])[0]; assert.equal(noUrl.loginUrl, ''); assert.equal(noUrl.accounts[0].password, 'secret');
});
