import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { normalizeNoteSnapshot, normalizeNoteDraft, rankNoteIdsForSearch, NOTE_LIMITS } from '../main/notes/notesStore';
import { NotesTreeStore } from '../main/notes/notesTreeStore';
import type { Note, NotesTreeSnapshot } from '../shared/types';
import { EMPTY_RICH_TEXT_CONTENT } from '../shared/noteRichText';

import { validateWorkspace, object, fail, type ServerWorkspace } from '../main/notesServer/workspace';
const MAX_BYTES = 128 * 1024 * 1024;
async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length; if (length > MAX_BYTES) return fail(413, 'Request too large.'); chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(400, 'Invalid JSON.'); }
}
export async function startNotesServer(options: { directory: string; token: string; port: number; version: string }) {
  if (!/^[a-f0-9]{64}$/.test(options.token)) throw new Error('Invalid server token.');
  await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
  const databasePath = path.join(options.directory, 'notes.sqlite3');
  const db = new DatabaseSync(databasePath);
  const schema = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (schema > 1) { db.close(); throw new Error('Unsupported database schema.'); }
  db.exec('PRAGMA user_version=1; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  db.exec('CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, hash TEXT NOT NULL, revision INTEGER NOT NULL);');
  if (!db.prepare('SELECT id FROM workspace').get()) db.prepare('INSERT INTO workspace VALUES(1,?)').run(JSON.stringify({
    instanceId: randomUUID(), revision: 0, notes: [], tombstones: [], tree: { schemaVersion: 1, nodes: [] },
  }));
  await fs.chmod(databasePath, 0o600);
  let state: ServerWorkspace = JSON.parse(String(db.prepare('SELECT data FROM workspace WHERE id=1').get()!.data));
  await validateWorkspace(state);
  let notesById = new Map(state.notes.map(note => [note.id, note]));
  const backups = path.join(options.directory, 'backups'); await fs.mkdir(backups, { recursive: true, mode: 0o700 });
  let backupQueue = Promise.resolve('');
  const makeBackup = (upgrade = false): Promise<string> => {
    const work = backupQueue.then(async () => {
      const name = `${upgrade ? 'upgrade' : 'daily'}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite3`;
      await backup(db, path.join(backups, name)); await fs.chmod(path.join(backups, name), 0o600);
      const daily = (await fs.readdir(backups)).filter(n => n.startsWith('daily-')).sort().reverse();
      for (const old of daily.slice(7)) await fs.unlink(path.join(backups, old));
      return name;
    });
    backupQueue = work.catch(() => ''); return work;
  };
  const timer = setInterval(() => { void makeBackup().catch(() => undefined); }, 24 * 60 * 60 * 1000); timer.unref();
  await makeBackup();
  let queue = Promise.resolve();
  const server = createServer((req, res) => {
    const run = async (): Promise<void> => {
      const supplied = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${options.token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return fail(401, 'Unauthorized.');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method;
      if (method === 'GET' && url.pathname === '/v1/health') return send(res, { version: options.version, protocol: 1, instanceId: state.instanceId, revision: state.revision });
      if (method === 'GET' && url.pathname === '/v1/workspace') return send(res, state);
      if (method === 'GET' && url.pathname === '/v1/search') return send(res, rankNoteIdsForSearch(state.notes, (url.searchParams.get('q') ?? '').slice(0, 512)));
      if (method === 'GET' && url.pathname === '/v1/notes') return send(res, state.notes.map(({ content, ...summary }) => summary));
      if (method === 'GET' && url.pathname.startsWith('/v1/notes/')) {
        const note = notesById.get(decodeURIComponent(url.pathname.slice(10)));
        return note ? send(res, note) : fail(404, 'Note not found.');
      }
      if (method === 'POST' && url.pathname === '/v1/backups') return send(res, { name: await makeBackup(true) });
      if (method === 'GET' && url.pathname === '/v1/backups') return send(res, (await fs.readdir(backups)).filter(n => /^(daily|upgrade)-[\dTZ-]+\.sqlite3$/.test(n)).sort().reverse());
      if (method === 'GET' && url.pathname.startsWith('/v1/backups/')) {
        const name = url.pathname.slice('/v1/backups/'.length);
        if (!/^(daily|upgrade)-[\dTZ-]+\.sqlite3$/.test(name)) return fail(400, 'Invalid backup name.');
        const bytes = await fs.readFile(path.join(backups, name)); res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(bytes); return;
      }
      if (method !== 'POST') return fail(404, 'Endpoint not found.');
      const input = object(await body(req));
      if (!['/v1/transactions', '/v1/import', '/v1/notes/create', '/v1/notes/update', '/v1/notes/move', '/v1/notes/delete-preview', '/v1/notes/delete'].includes(url.pathname)) return fail(404, 'Endpoint not found.');
      if (url.pathname === '/v1/notes/delete-preview') return send(res, subtree(state, input.id));
      if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.requestId)) return fail(400, 'Request ID is required.');
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const prior = db.prepare('SELECT hash, revision FROM requests WHERE id=?').get(input.requestId);
      if (prior) {
        if (prior.hash !== hash) return fail(409, 'Request ID reused with different content.');
        return send(res, { revision: Number(prior.revision), instanceId: state.instanceId });
      }
      if (input.expectedRevision !== state.revision) return fail(409, 'Workspace changed. Reload and resolve the conflict.');
      let next: Pick<ServerWorkspace, 'notes' | 'tombstones' | 'tree'>;
      if (url.pathname === '/v1/import') {
        if (state.revision !== 0 || state.notes.length || state.tombstones.length) return fail(409, 'Only an empty server can be migrated.');
        next = await validateWorkspace(input.workspace);
      } else if (url.pathname === '/v1/transactions') {
        if (!Array.isArray(input.upserts) || !Array.isArray(input.deletedIds) || input.deletedIds.length > NOTE_LIMITS.notes
          || input.upserts.length > NOTE_LIMITS.notes || input.deletedIds.some((id: unknown) => typeof id !== 'string' || !id || id.length > 128)
          || new Set(input.deletedIds).size !== input.deletedIds.length) return fail(400, 'Invalid transaction.');
        const notes = new Map(state.notes.map(n => [n.id, n]));
        for (const id of input.deletedIds) notes.delete(id);
        for (const note of input.upserts) { const valid = normalizeNoteSnapshot(note); notes.set(valid.id, valid); }
        next = await validateWorkspace({ notes: [...notes.values()], tombstones: input.tombstones ?? state.tombstones, tree: input.tree ?? state.tree });
      } else {
        next = await applyOperation(state, url.pathname, input);
      }
      const updated = { ...next, instanceId: state.instanceId, revision: state.revision + 1 };
      const data = JSON.stringify(updated); if (Buffer.byteLength(data) > MAX_BYTES) return fail(413, 'Workspace too large.');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE workspace SET data=? WHERE id=1').run(data);
        db.prepare('INSERT INTO requests VALUES(?,?,?)').run(input.requestId, hash, updated.revision);
        db.prepare('DELETE FROM requests WHERE revision < ?').run(updated.revision - 10000);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      // Publish only committed state; health and single-note reads never parse the full database.
      state = updated;
      notesById = new Map(state.notes.map(note => [note.id, note]));
      send(res, { revision: updated.revision, instanceId: state.instanceId });
    };
    // Serialize reads and writes with async validation so revisions cannot race.
    const work = queue.then(run); queue = work.catch(() => undefined);
    void work.catch(error => {
      if (!res.headersSent) send(res, { error: error?.status ? error.message : 'Invalid request or server operation failed.' }, error?.status ?? 400);
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve); });
  return { server, databasePath, close: async () => { clearInterval(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await queue; await backupQueue; db.close(); } };
}
function send(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value));
}
function subtree(state: ServerWorkspace, id: unknown): string[] {
  if (typeof id !== 'string') return fail(400, 'Invalid note ID.');
  if (!state.notes.some(n => n.id === id)) return [];
  const ids = new Set([id]); let changed = true;
  while (changed) { changed = false; for (const n of state.tree.nodes) if (n.parentId && ids.has(n.parentId) && !ids.has(n.noteId)) { ids.add(n.noteId); changed = true; } }
  return [...ids].sort();
}
async function applyOperation(state: ServerWorkspace, route: string, input: Record<string, any>) {
  let notes = [...state.notes], tombstones = [...state.tombstones]; let tree = state.tree;
  const store = new NotesTreeStore('', { read: async () => tree, write: async value => { tree = value; } });
  await store.load(notes.map(n => n.id));
  if (route.endsWith('/create')) {
    const now = new Date().toISOString(); const id = randomUUID();
    notes.push({ id, name: 'Untitled note', content: EMPTY_RICH_TEXT_CONTENT, language: 'richtext', tags: [], createdAt: now, updatedAt: now });
    await store.insert(id, input.parentId ?? null, input.beforeNoteId);
  } else if (route.endsWith('/update')) {
    const index = notes.findIndex(n => n.id === input.id); if (index < 0) return fail(404, 'Note not found.');
    notes[index] = { ...notes[index], ...normalizeNoteDraft(input.draft), updatedAt: new Date().toISOString() };
  } else if (route.endsWith('/move')) await store.move(input.id, input.parentId ?? null, input.beforeNoteId);
  else {
    const ids = subtree(state, input.id);
    if (!Array.isArray(input.expectedIds) || JSON.stringify([...input.expectedIds].sort()) !== JSON.stringify(ids)) return fail(409, 'Subtree changed.');
    notes = notes.filter(n => !ids.includes(n.id)); tombstones.push(...ids.map(id => ({ id, deletedAt: new Date().toISOString() })));
    await store.removeIds(ids);
  }
  return validateWorkspace({ notes, tombstones, tree });
}
if (require.main === module) {
  void (async () => {
    const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
    const instance = await startNotesServer(config);
    const close = (): void => { void instance.close().then(() => process.exit(0)); };
    process.once('SIGTERM', close); process.once('SIGINT', close);
  })().catch(() => { process.stderr.write('Notes server startup failed. Check configuration and database permissions.\n'); process.exitCode = 1; });
}
