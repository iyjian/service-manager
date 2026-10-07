import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { VaultAccountDraft, VaultEntryDraft, VaultEntryView, VaultKeyView } from '../../shared/types';
export interface VaultAccount { id: string; username: string; password: string; notes: string; }
export type VaultRecord = VaultKeyView & {
  type?: 'sshKey' | 'login' | 'secureNote'; privateKey?: string; passphrase?: string;
  deletedAt?: string; loginUrl?: string; accounts?: VaultAccount[];
  // Retained only for old data; never interpreted as new website input.
  application?: string; username?: string; password?: string; urls?: string[]; tags?: string[]; notes?: string;
};
export const vaultString = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('Invalid Vault field.');
  return value;
};
export function loginUrl(value: unknown): string {
  const text = vaultString(value, 2048).trim();
  let url: URL; try { url = new URL(text); } catch { throw new Error('Enter a valid HTTP or HTTPS login URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Login URLs must use HTTP or HTTPS without embedded credentials.');
  return url.href;
}
export function accountDraft(input: VaultAccountDraft, previous?: VaultAccount): VaultAccount {
  if (!input || typeof input !== 'object') throw new Error('Invalid account.');
  if (input.generatePassword !== undefined && typeof input.generatePassword !== 'boolean') throw new Error('Invalid password option.');
  if (input.id !== undefined && (!vaultString(input.id, 128) || !previous || previous.id !== input.id)) throw new Error('Account changed. Refresh before editing.');
  const password = input.password === undefined ? previous?.password ?? '' : vaultString(input.password, 65536);
  return { id: previous?.id ?? randomUUID(), username: vaultString(input.username, 1000), notes: vaultString(input.notes, 65536),
    password: input.generatePassword ? generatePassword() : password };
}
export function entryDraft(input: VaultEntryDraft, previous?: VaultRecord): Omit<VaultRecord, 'id' | 'createdAt'> {
  if (!input || input.type !== 'login') throw new Error('Invalid Vault entry type.');
  const url = loginUrl(input.loginUrl);
  if (!Array.isArray(input.accounts) || !input.accounts.length || input.accounts.length > 200) throw new Error('Add between 1 and 200 accounts.');
  const accounts = input.accounts.map(account => accountDraft(account, previous?.accounts?.find(saved => saved.id === account?.id)));
  if (new Set(accounts.map(account => account.id)).size !== accounts.length) throw new Error('Duplicate account ID.');
  return { type: 'login', name: new URL(url).hostname, loginUrl: url, accounts };
}
export function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*-_=+';
  return Array.from({ length: 24 }, () => alphabet[randomInt(alphabet.length)]).join('');
}
export function entryView(record: VaultRecord): VaultEntryView {
  if (record.type === 'secureNote') throw new Error('Unsupported Vault entry type.');
  return { id: record.id, name: record.name, createdAt: record.createdAt, updatedAt: record.updatedAt, revision: record.revision,
    type: record.type ?? 'sshKey', loginUrl: record.loginUrl ?? '',
    accounts: (record.accounts ?? []).map(({ id, username, notes, password }) => ({ id, username, notes, hasPassword: Boolean(password) })) };
}
const stableId = (id: string, suffix: string) => createHash('sha256').update(JSON.stringify([id, suffix])).digest('hex');
/** Normalization is deterministic on client and server, including expansion of legacy multi-URL records. */
export function validateRecords(input: unknown): VaultRecord[] {
  if (!Array.isArray(input) || input.length > 10000) throw new Error('Invalid Vault data.');
  const records: VaultRecord[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid Vault record.');
    const id = vaultString(raw.id, 128); if (!id) throw new Error('Invalid Vault ID.');
    const name = vaultString(raw.name, 2048); if (!name.trim()) throw new Error('Invalid Vault name.');
    const createdAt = vaultString(raw.createdAt, 50); if (!Number.isFinite(Date.parse(createdAt))) throw new Error('Invalid Vault date.');
    if (raw.revision !== undefined && (!Number.isSafeInteger(raw.revision) || raw.revision < 0)) throw new Error('Invalid Vault revision.');
    if (raw.updatedAt !== undefined && (typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt)))) throw new Error('Invalid Vault date.');
    const common = { id, name, createdAt, ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}), ...(raw.revision !== undefined ? { revision: raw.revision } : {}) };
    if (raw.deletedAt !== undefined) {
      if (raw.type !== 'login' || typeof raw.deletedAt !== 'string' || !Number.isFinite(Date.parse(raw.deletedAt))) throw new Error('Invalid deleted Login.');
      records.push({ ...common, name: 'Deleted login', type: 'login', deletedAt: raw.deletedAt, loginUrl: '', accounts: [] }); continue;
    }
    if (raw.type === undefined || raw.type === 'sshKey') {
      const privateKey = vaultString(raw.privateKey, 65536); if (!privateKey.trim()) throw new Error('Invalid private key.');
      records.push({ ...common, privateKey, ...(raw.passphrase !== undefined ? { passphrase: vaultString(raw.passphrase, 65536) } : {}) }); continue;
    }
    if (raw.type !== 'login' && raw.type !== 'secureNote') throw new Error('Invalid Vault entry type.');
    if (raw.type === 'login' && raw.accounts !== undefined) {
      if (!Array.isArray(raw.accounts) || !raw.accounts.length || raw.accounts.length > 200) throw new Error('Invalid account count.');
      const accounts = raw.accounts.map((account: VaultAccount) => {
        if (!account || typeof account !== 'object') throw new Error('Invalid account.');
        const accountId = vaultString(account.id, 128); if (!accountId) throw new Error('Invalid account ID.');
        return { id: accountId, username: vaultString(account.username, 1000), password: vaultString(account.password, 65536), notes: vaultString(account.notes, 65536) };
      });
      if (new Set(accounts.map((account: VaultAccount) => account.id)).size !== accounts.length) throw new Error('Duplicate account ID.');
      const url = raw.loginUrl === '' ? '' : loginUrl(raw.loginUrl);
      records.push({ ...common, type: 'login', loginUrl: url, accounts }); continue;
    }
    if (!Array.isArray(raw.urls) || raw.urls.length > 20 || !Array.isArray(raw.tags) || raw.tags.length > 30) throw new Error('Invalid legacy Vault data.');
    const legacy = { application: vaultString(raw.application, 200), username: vaultString(raw.username, 1000), password: raw.password === undefined ? '' : vaultString(raw.password, 65536),
      notes: vaultString(raw.notes, 65536), urls: raw.urls.map(loginUrl), tags: raw.tags.map((tag: unknown) => vaultString(tag, 80)) };
    if (raw.type === 'secureNote') { records.push({ ...common, type: 'secureNote', ...legacy }); continue; }
    const urls: string[] = legacy.urls.length ? [...new Set<string>(legacy.urls)] : [''];
    urls.forEach((url, index) => records.push({ ...common, id: index === 0 ? id : stableId(id, url), type: 'login', loginUrl: url,
      accounts: [{ id: stableId(id, 'account'), username: legacy.username, password: legacy.password, notes: legacy.notes }] }));
  }
  if (records.length > 10000 || new Set(records.map(record => record.id)).size !== records.length) throw new Error('Invalid or duplicate Vault IDs.');
  return records;
}
