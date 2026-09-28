import { notesServerHostOptions, notesServerDraftFromHost } from './hostSelection';
import { ipcMain, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { HostConfig, NotesServerSettingsDraft } from '../../shared/types';
import { RemoteNotesBackend, type RemoteWorkspace } from './backend';
import { NotesServerSettings } from './settings';
import { NotesServerDeployment } from './deployment';
export function registerNotesServerIpc(options: {
  settings: NotesServerSettings; deployment: NotesServerDeployment; backend: RemoteNotesBackend; userData: string;
  hosts(): HostConfig[];
  createHost(draft: NotesServerSettingsDraft): Promise<HostConfig>;
  snapshot(): Omit<RemoteWorkspace, 'revision' | 'instanceId'>;
  backup(): Promise<Buffer>;
  freeze(): Promise<{ release(): void; reload(): void }>;
}) {
  const { settings, deployment, backend } = options;
  let busy = false;
  let importedKey: string | undefined;
  ipcMain.handle('notes-server:hosts', () => notesServerHostOptions(options.hosts()));
  ipcMain.handle('notes-server:save-host', async (_event, id: unknown) => {
    if (busy) throw new Error('Notes Server is busy.');
    busy = true;
    try {
      backend.assertNoDrafts();
      await settings.save(notesServerDraftFromHost(options.hosts(), id));
      await backend.initialize(); return settings.view();
    } finally { busy = false; }
  });
  ipcMain.handle('notes-server:settings', () => settings.view());
  ipcMain.handle('notes-server:status', () => backend.status());
  ipcMain.handle('notes-server:poll', async () => {
    if (!busy && backend.enabled) await backend.run(async () => undefined);
    return backend.status();
  });
  ipcMain.handle('notes-server:import-key', async () => {
    const result = await dialog.showOpenDialog({ title: 'Select SSH Private Key', properties: ['openFile'] });
    if (result.canceled || !result.filePaths[0]) return false;
    if ((await fs.stat(result.filePaths[0])).size > 65536) throw new Error('Private key file is too large.');
    importedKey = await fs.readFile(result.filePaths[0], 'utf8'); return true;
  });
  ipcMain.handle('notes-server:cancel', () => deployment.cancel());
  ipcMain.handle('notes-server:save', async (_event, input: NotesServerSettingsDraft) => {
    if (busy) throw new Error('Notes Server is busy.');
    busy = true;
    try {
      backend.assertNoDrafts();
      if (!input || typeof input !== 'object') throw new Error('Invalid server connection.');
      const draft = { ...input, sourceHostId: undefined, privateKey: input.privateKey || importedKey };
      if (input.createHost) {
        if (settings.enabled) throw new Error('The active Notes Server connection cannot be replaced.');
        const host = await options.createHost(draft);
        await settings.save(notesServerDraftFromHost([host], host.id));
      } else await settings.save(draft);
      importedKey = undefined; await backend.initialize(); return settings.view();
    } finally { busy = false; }
  });
  ipcMain.handle('notes-server:draft', async (_event, id, expected, draft) => backend.preserve(id, expected, draft));
  ipcMain.handle('notes-server:get-draft', (_event, id) => backend.enabled ? backend.draft(id) : undefined);
  ipcMain.handle('notes-server:action', async (_event, action: unknown) => {
    if (busy) throw new Error('Notes Server is busy.');
    if (!['test', 'deploy', 'start', 'stop', 'restart', 'logs', 'migrate', 'use-server', 'backup', 'recover-drafts'].includes(String(action))) throw new Error('Unknown server action.');
    const progress = (message: string) => { if (!_event.sender.isDestroyed()) _event.sender.send('notes-server:progress', message); };
    busy = true;
    try {
      await backend.idle();
      if (action === 'test') return await deployment.test();
      if (action === 'deploy') return await deployment.deploy();
      if (action === 'start' || action === 'stop' || action === 'restart' || action === 'logs') return await deployment.control(action);
      if (action === 'backup') {
        const result = await dialog.showSaveDialog({ title: 'Download Notes Server Backup', defaultPath: 'notes-server-backup.sqlite3' });
        if (result.canceled || !result.filePath) return 'Backup cancelled.';
        const backup = await deployment.api<{ name: string }>('/v1/backups', {});
        if (!/^upgrade-[\dTZ-]+\.sqlite3$/.test(backup.name)) throw new Error('Invalid backup name.');
        const bytes = await deployment.api<Buffer>(`/v1/backups/${backup.name}`, undefined, true);
        await fs.writeFile(result.filePath, bytes, { mode: 0o600 }); return 'Backup downloaded.';
      }
      const frozen = await options.freeze();
      try {
        if (action === 'recover-drafts') {
          if (!backend.enabled) throw new Error('Connect to Notes Server first.');
          await backend.recoverDrafts(); frozen.reload(); return 'Drafts recovered. Conflicting edits were saved as separate Notes.';
        }
        if (backend.enabled && backend.status().pendingDrafts) await backend.reconnectDrafts();
        backend.assertNoDrafts();
        if (backend.enabled) {
          await backend.run(async () => undefined, true);
          await settings.completeSetup();
          return 'Already using Notes Server.';
        }
        progress('Connecting to Notes Server…');
        const health = await deployment.health();
        if (!settings.setupComplete && action === 'use-server' && options.snapshot().notes.length) throw new Error('Migrate local Notes before continuing. Existing server content will not be overwritten.');
        let usedExistingWorkspace = false;
        if (action === 'migrate') {
          progress('1 / 4 · Backing up local Notes…');
          const state = options.snapshot();
          const directory = path.join(options.userData, 'notes-server-migration-backups'); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
          await fs.writeFile(path.join(directory, `notes-${Date.now()}.sqlite3`), await options.backup(), { mode: 0o600 });
          const requestId = createHash('sha256').update(JSON.stringify(state)).digest('hex');
          progress(`2 / 4 · Migrating ${state.notes.length} notes and folders…`);
          const existing = await deployment.api<RemoteWorkspace>('/v1/workspace');
          const populated = existing.revision !== 0 || existing.notes.length > 0 || existing.tombstones.length > 0;
          let connectExisting = state.notes.length === 0 && state.tombstones.length === 0 && populated;
          if (populated && !connectExisting) {
            const choice = await dialog.showMessageBox({
              type: 'question', title: 'Use existing server notes?',
              message: 'This server already has a Notes workspace.',
              detail: `Your local notes have been backed up to ${directory}. Use the server workspace to continue. Local notes will not be merged or uploaded, and server notes will not be overwritten. The original local database will be retained for recovery.`,
              buttons: ['Cancel', 'Use Server Notes'], defaultId: 0, cancelId: 0, noLink: true,
            });
            if (choice.response !== 1) throw new Error('Setup cancelled. Local notes and server notes are unchanged.');
            connectExisting = true;
          }
          if (!connectExisting) await deployment.api('/v1/import', { requestId, expectedRevision: 0, workspace: state });
          usedExistingWorkspace = connectExisting;
          progress(connectExisting ? '3 / 4 · Verifying server workspace…' : '3 / 4 · Verifying migrated content…');
          const imported = await deployment.api<RemoteWorkspace>('/v1/workspace');
          const canonical = (value: typeof state) => JSON.stringify({ notes: [...value.notes].sort((a,b) => a.id.localeCompare(b.id)), tombstones: [...value.tombstones].sort((a,b) => a.id.localeCompare(b.id)), tree: value.tree });
          if (!connectExisting && canonical(state) !== canonical(imported)) throw new Error('Migration verification failed. Local Notes remain active.');
        }
        progress('4 / 4 · Opening the server workspace…');
        await settings.setMode(true, health.instanceId);
        try { await backend.initialize(); await backend.run(async () => undefined, true); await settings.completeSetup(); }
        catch (error) { await settings.setMode(false); throw error; }
        frozen.reload(); return action === 'migrate' && !usedExistingWorkspace ? 'Notes migrated and verified. Using Notes Server.' : 'Connected to the server Notes workspace.';
      } finally { frozen.release(); }
    } finally { busy = false; }
  });
}
