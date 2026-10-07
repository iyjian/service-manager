import { parse } from 'csv/sync';
import { randomUUID } from 'node:crypto';
import type { VaultImportRow } from '../../shared/types';
import { loginUrl, validateRecords, vaultString, type VaultRecord } from './entries';
export interface ChromeRow { id: string; loginUrl: string; username: string; password: string; notes: string; invalid?: string; }
export function parseChromeCsv(text: string): ChromeRow[] {
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Chrome CSV is too large (maximum 8 MiB).');
  let rows: string[][];
  try { rows = parse(text, { bom: true, skip_empty_lines: true, max_record_size: 150000 }); }
  catch { throw new Error('Invalid Chrome CSV. Export passwords from Chrome Password Manager and try again.'); }
  if (!rows.length || rows.length > 10001) throw new Error('Import between 1 and 10,000 CSV rows.');
  const header = rows.shift()!.map(value => value.trim().toLowerCase());
  if (new Set(header).size !== header.length || !['url', 'username', 'password'].every(key => header.includes(key))) throw new Error('Chrome CSV must include url, username and password columns.');
  if (!rows.length) throw new Error('The CSV contains no accounts.');
  const field = (row: string[], name: string) => row[header.indexOf(name)] ?? '';
  return rows.map(row => {
    const id = randomUUID();
    try {
      return { id, loginUrl: loginUrl(field(row, 'url')), username: vaultString(field(row, 'username'), 1000),
        password: vaultString(field(row, 'password'), 65536), notes: vaultString(field(row, 'note') || field(row, 'notes'), 65536) };
    } catch {
      // Invalid input may contain credentials in the URL; do not echo it into the preview.
      return { id, loginUrl: '', username: '', password: '', notes: '', invalid: 'Unsupported website URL or oversized field.' };
    }
  });
}
export function planChromeImport(records: VaultRecord[], rows: ChromeRow[]): { records: VaultRecord[]; rows: VaultImportRow[]; accounts: number; websites: number } {
  const next = structuredClone(records); let count = 0, websites = 0;
  const preview = rows.map(row => {
    const view: VaultImportRow = { id: row.id, loginUrl: row.loginUrl, username: row.username, notes: row.notes, hasPassword: Boolean(row.password),
      status: 'ready', message: 'Add account' };
    if (row.invalid) return { ...view, status: 'invalid' as const, message: row.invalid };
    const matches = next.filter(record => record.type === 'login' && record.loginUrl === row.loginUrl);
    const existing = matches.flatMap(record => record.accounts ?? []).filter(account => account.username === row.username);
    if (existing.some(account => account.password === row.password && account.notes === row.notes)) return { ...view, status: 'duplicate' as const, message: 'Already saved; skipped' };
    if (existing.length) return { ...view, status: 'conflict' as const, message: 'Same username has different password or notes; skipped' };
    const record = matches[0];
    if (record && record.accounts!.length >= 200) return { ...view, status: 'invalid' as const, message: 'Website account limit reached (200)' };
    const account = { id: row.id, username: row.username, password: row.password, notes: row.notes };
    const now = new Date().toISOString();
    if (record) { record.accounts!.push(account); record.revision = (record.revision ?? 0) + 1; record.updatedAt = now; }
    else {
      next.push({ id: randomUUID(), name: new URL(row.loginUrl).hostname, type: 'login', loginUrl: row.loginUrl, accounts: [account], createdAt: now, revision: 0 }); websites++;
    }
    count++;
    return view;
  });
  return { records: validateRecords(next), rows: preview, accounts: count, websites };
}
