import { randomUUID } from 'node:crypto';
import { parseChromeCsv, type ChromeRow } from './chromeImport';
import { copyVaultValue } from './clipboard';
import type { VaultKeyView, VaultKeyReplacement } from '../../shared/types';
import { app, ipcMain, dialog, clipboard, shell, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PrivateKeyVault } from './privateKeyVault';
export function registerVaultIpc(vault: PrivateKeyVault, options: {
  trustedSender(id: number): boolean;
  mutate(work: () => Promise<VaultKeyView>): Promise<VaultKeyView>;
  changed(id: string, replaced: boolean): Promise<void>;
}): void {
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!options.trustedSender(event.sender.id) || event.senderFrame !== event.sender.mainFrame) throw new Error('Unknown Vault window.');
      return listener(event, ...args);
    });
  };
  handle('vault:status', () => vault.status());
  handle('vault:entries', () => vault.entries());
  handle('vault:refresh', () => vault.refresh());
  handle('vault:save-entry', async (_event, input) => {
    const saved = await vault.saveEntry(input); await options.changed(saved.id, false); return saved;
  });
  handle('vault:read-password', (_event, id: string, revision: number, accountId: string) => {
    const entry = vault.entries().find(item => item.id === id && item.type === 'login');
    if (!entry || (entry.revision ?? 0) !== revision || typeof accountId !== 'string' || !entry.accounts.some(account => account.id === accountId)) throw new Error('Account changed. Refresh before revealing.');
    return vault.secret(id, 'password', accountId);
  });
  handle('vault:edit-passwords', (_event, id: string, revision: number) => {
    const entry = vault.entries().find(item => item.id === id && item.type === 'login');
    if (!entry || (entry.revision ?? 0) !== revision) throw new Error('Login changed. Refresh before editing.');
    return entry.accounts.map(account => ({ id: account.id, password: vault.secret(id, 'password', account.id) }));
  });
  handle('vault:delete-login', async (_event, id: string, revision: number) => {
    const entry = vault.entries().find(item => item.id === id && item.type === 'login');
    if (!entry || (entry.revision ?? 0) !== revision) throw new Error('Login changed. Refresh before deleting.');
    const result = await dialog.showMessageBox({ type: 'warning', title: 'Delete Login', message: 'Delete this website Login?',
      detail: `${entry.loginUrl || 'Website URL needed'}\n\nAll ${entry.accounts.length} accounts and their notes will be deleted. This cannot be undone.`,
      buttons: ['Cancel', 'Delete Login'], defaultId: 0, cancelId: 0, noLink: true });
    if (result.response !== 1) return false;
    await vault.deleteLogin(id, revision); await options.changed(id, false); return true;
  });
  handle('vault:copy', async (_event, id: string, field: 'username' | 'password' | 'notes', accountId: string) => {
    const value = vault.secret(id, field, accountId);
    copyVaultValue(clipboard, value);
  });
  handle('vault:reveal', async (_event, id: string, accountId: string) => {
    const entry = vault.entries().find(item => item.id === id);
    if (!entry || entry.type !== 'login') throw new Error('Entry is unavailable.');
    await dialog.showMessageBox({ type: 'info', title: entry.name, message: 'Password',
      detail: vault.secret(id, 'password', accountId) || '(empty)', buttons: ['Close'], noLink: true });
  });
  handle('vault:open-url', async (_event, id: string) => {
    const entry = vault.entries().find(item => item.id === id);
    if (!entry || entry.type !== 'login' || !entry.loginUrl) throw new Error('Invalid login URL.');
    const { loginUrl } = await import('./entries'); await shell.openExternal(loginUrl(entry.loginUrl));
  });
  const imports = new Map<number, { token: string; rows: ChromeRow[]; fingerprint: string; timer: ReturnType<typeof setTimeout> }>();
  const clearImport = (sender: number): void => { clearTimeout(imports.get(sender)?.timer); imports.delete(sender); };
  const importing = new Set<number>();
  const watchedImportSenders = new Set<number>();
  handle('vault:chrome-preview', async event => {
    const sender = event.sender.id;
    if (importing.has(sender)) throw new Error('An import is already in progress.');
    importing.add(sender); clearImport(sender);
    try {
      const result = await dialog.showOpenDialog({ title: 'Import Chrome Passwords', message: 'Choose a CSV exported from Chrome Password Manager → Settings → Export passwords.', properties: ['openFile'], filters: [{ name: 'Chrome password CSV', extensions: ['csv'] }] });
      if (result.canceled || !result.filePaths[0] || event.sender.isDestroyed()) return null;
      const file = await fs.open(result.filePaths[0], 'r');
      let bytes: Buffer;
      try {
        const stat = await file.stat(); if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Choose a Chrome CSV file up to 8 MiB.');
        bytes = Buffer.alloc(8 * 1024 * 1024 + 1); let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) break; offset += bytesRead;
        }
        if (offset > 8 * 1024 * 1024) throw new Error('Chrome CSV is too large.'); bytes = bytes.subarray(0, offset);
      } finally { await file.close(); }
      let rows: ChromeRow[];
      try { rows = parseChromeCsv(bytes.toString('utf8')); } finally { bytes.fill(0); }
      const preview = await vault.previewImport(rows);
      if (event.sender.isDestroyed()) return null;
      const token = randomUUID();
      const ready = new Set(preview.rows.filter(row => row.status === 'ready').map(row => row.id));
      const timer = setTimeout(() => clearImport(sender), 10 * 60_000); timer.unref();
      imports.set(sender, { token, rows: rows.filter(row => ready.has(row.id)), fingerprint: preview.fingerprint, timer });
      if (!watchedImportSenders.has(sender)) { watchedImportSenders.add(sender); event.sender.once('destroyed', () => { clearImport(sender); watchedImportSenders.delete(sender); }); }
      return { token, rows: preview.rows };
    } finally { importing.delete(sender); }
  });
  handle('vault:chrome-cancel', (event, token: string) => { if (imports.get(event.sender.id)?.token === token) clearImport(event.sender.id); });
  handle('vault:chrome-confirm', async (event, token: string, ids: unknown) => {
    const sender = event.sender.id; const pending = imports.get(sender);
    if (!pending || token !== pending.token || importing.has(sender)) throw new Error('Import preview expired or is busy. Open it again.');
    if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Select accounts to import.');
    const selected = pending.rows.filter(row => ids.includes(row.id));
    if (selected.length !== ids.length) throw new Error('Invalid import selection.');
    importing.add(sender);
    try {
      const result = await vault.importAccounts(selected, pending.fingerprint);
      clearImport(sender); await options.changed('', false); return result;
    } finally { importing.delete(sender); }
  });
  const pending = new Map<number, string>();
  handle('vault:list', () => vault.list());
  handle('vault:rename', (_event, id: string, name: string, revision: number) => options.mutate(async () => {
    const key = await vault.rename(id, name, revision); await options.changed(key.id, false); return key;
  }));
  handle('vault:replace', (event, input: VaultKeyReplacement) => options.mutate(async () => {
    if (!input || typeof input !== 'object') throw new Error('Invalid private key.');
    const key = await vault.replace(input.id, input.privateKey || (input.useImportedKey === true ? pending.get(event.sender.id) : '') || '', input.passphrase, input.revision);
    pending.delete(event.sender.id); await options.changed(key.id, true); return key;
  }));
  handle('vault:import', async event => {
    let defaultPath = path.join(app.getPath('home'), '.ssh');
    try { await fs.access(defaultPath); } catch { defaultPath = app.getPath('home'); }
    const result = await dialog.showOpenDialog({ title: 'Import Private Key', defaultPath, properties: ['openFile'], filters: [{ name: 'All Files', extensions: ['*'] }] });
    if (result.canceled || !result.filePaths[0]) return false;
    const file = result.filePaths[0];
    if ((await fs.stat(file)).size > 65536) throw new Error('Private key file is too large.');
    pending.set(event.sender.id, await fs.readFile(file, 'utf8'));
    event.sender.once('destroyed', () => pending.delete(event.sender.id));
    return true;
  });
  handle('vault:add', (event, input: unknown) => options.mutate(async () => {
    if (!input || typeof input !== 'object') throw new Error('Invalid private key.');
    const draft = input as { name: string; useImportedKey?: boolean; privateKey?: string; passphrase?: string };
    const result = await vault.add(draft.name, draft.privateKey || (draft.useImportedKey === true ? pending.get(event.sender.id) : '') || '', draft.passphrase);
    pending.delete(event.sender.id); await options.changed(result.id, false); return result;
  }));
}
