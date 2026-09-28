import { normalizeNoteSnapshot, NOTE_LIMITS } from '../notes/notesStore';
import type { Note, NotesTreeSnapshot } from '../../shared/types';

export interface ServerWorkspace {
  instanceId: string; revision: number; notes: Note[];
  tombstones: Array<{ id: string; deletedAt: string }>;
  tree: NotesTreeSnapshot;
}
export const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
export const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'Invalid request.');
  return value as Record<string, any>;
};
export async function validateWorkspace(value: unknown): Promise<Pick<ServerWorkspace, 'notes' | 'tombstones' | 'tree'>> {
  const raw = object(value);
  if (!Array.isArray(raw.notes) || raw.notes.length > NOTE_LIMITS.notes || !Array.isArray(raw.tombstones)
    || raw.tombstones.length > NOTE_LIMITS.tombstones) return fail(400, 'Invalid workspace limits.');
  const notes = raw.notes.map(normalizeNoteSnapshot);
  const ids = new Set(notes.map(n => n.id));
  if (ids.size !== notes.length) return fail(400, 'Duplicate note IDs.');
  const seen = new Set(ids);
  const tombstones = raw.tombstones.map((item: unknown) => {
    const row = object(item);
    if (typeof row.id !== 'string' || !row.id || row.id.length > 128 || seen.has(row.id)
      || typeof row.deletedAt !== 'string' || !Number.isFinite(Date.parse(row.deletedAt))) return fail(400, 'Invalid tombstone.');
    seen.add(row.id); return { id: row.id, deletedAt: row.deletedAt };
  });
  const tree = object(raw.tree);
  if (tree.schemaVersion !== 1 || !Array.isArray(tree.nodes) || tree.nodes.length !== notes.length) return fail(400, 'Invalid tree.');
  const treeIds = new Set<string>();
  for (const node of tree.nodes) {
    if (!node || !ids.has(node.noteId) || treeIds.has(node.noteId) || (node.parentId !== null && !ids.has(node.parentId))
      || !Number.isInteger(node.order) || node.order < 0) return fail(400, 'Invalid tree node.');
    treeIds.add(node.noteId);
  }
  const parents = new Map<string, string | null>(tree.nodes.map((n: any) => [n.noteId, n.parentId]));
  for (const id of ids) {
    let current: string | null = id; const visited = new Set<string>();
    while (current !== null) {
      if (visited.has(current) || visited.size >= 32) return fail(400, 'Invalid tree hierarchy.');
      visited.add(current); current = parents.get(current) ?? null;
    }
  }
  return { notes, tombstones, tree: { schemaVersion: 1, nodes: tree.nodes } };
}
