import { app, ipcMain, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PrivateKeyVault } from './privateKeyVault';
export function registerVaultIpc(vault: PrivateKeyVault): void {
  const pending = new Map<number, string>();
  ipcMain.handle('vault:list', () => vault.list());
  ipcMain.handle('vault:import', async event => {
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
  ipcMain.handle('vault:add', async (event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid private key.');
    const draft = input as { name: string; useImportedKey?: boolean; privateKey?: string; passphrase?: string };
    const result = await vault.add(draft.name, draft.privateKey || (draft.useImportedKey === true ? pending.get(event.sender.id) : '') || '', draft.passphrase);
    pending.delete(event.sender.id); return result;
  });
}
