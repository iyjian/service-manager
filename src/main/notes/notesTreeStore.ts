import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

export const NOTES_TREE_SCHEMA_VERSION = 1 as const;
export const NOTES_TREE_MAX_DEPTH = 32;
export const NOTES_TREE_MAX_NODES = 10_000;

const MAX_STORED_NODES = NOTES_TREE_MAX_NODES * 5;
const MAX_TREE_FILE_BYTES = 4 * 1024 * 1024;
const ORDER_STEP = 1_024;
const MAX_NOTE_ID_CHARACTERS = 128;

export interface NotesTreeNode {
  noteId: string;
  parentId: string | null;
  order: number;
}

export interface NotesTreeSnapshot {
  schemaVersion: typeof NOTES_TREE_SCHEMA_VERSION;
  nodes: NotesTreeNode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneNode(node: NotesTreeNode): NotesTreeNode {
  return { ...node };
}

function cloneSnapshot(nodes: readonly NotesTreeNode[]): NotesTreeSnapshot {
  return {
    schemaVersion: NOTES_TREE_SCHEMA_VERSION,
    nodes: nodes.map(cloneNode),
  };
}

function normalizeNoteId(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_NOTE_ID_CHARACTERS
    || value.trim() !== value) {
    throw new Error('Note tree Note ID is invalid.');
  }
  return value;
}

function normalizeParentId(value: unknown): string | null {
  return value === null ? null : normalizeNoteId(value);
}

function normalizeActiveNoteIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > NOTES_TREE_MAX_NODES) {
    throw new Error('Active Note IDs are invalid.');
  }
  const result: string[] = [];
  const unique = new Set<string>();
  for (const candidate of value) {
    const noteId = normalizeNoteId(candidate);
    if (unique.has(noteId)) throw new Error('Active Note IDs contain a duplicate.');
    unique.add(noteId);
    result.push(noteId);
  }
  return result.sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNodes(left: NotesTreeNode, right: NotesTreeNode): number {
  return left.order - right.order || compareText(left.noteId, right.noteId);
}

function compareDuplicateCandidates(left: NotesTreeNode, right: NotesTreeNode): number {
  const order = left.order - right.order;
  if (order !== 0) return order;
  if (left.parentId === right.parentId) return 0;
  if (left.parentId === null) return -1;
  if (right.parentId === null) return 1;
  return compareText(left.parentId, right.parentId);
}

function parseSnapshot(value: unknown): NotesTreeNode[] {
  if (!isRecord(value)
    || value.schemaVersion !== NOTES_TREE_SCHEMA_VERSION
    || !Array.isArray(value.nodes)
    || value.nodes.length > MAX_STORED_NODES) {
    throw new Error('Notes tree data is invalid.');
  }

  return value.nodes.map((candidate) => {
    if (!isRecord(candidate)
      || !Number.isSafeInteger(candidate.order)
      || (candidate.order as number) < 0) {
      throw new Error('Notes tree data is invalid.');
    }
    try {
      return {
        noteId: normalizeNoteId(candidate.noteId),
        parentId: normalizeParentId(candidate.parentId),
        order: candidate.order as number,
      };
    } catch {
      throw new Error('Notes tree data is invalid.');
    }
  });
}

function nodeMap(nodes: readonly NotesTreeNode[]): Map<string, NotesTreeNode> {
  return new Map(nodes.map((node) => [node.noteId, node]));
}

function siblingGroups(nodes: readonly NotesTreeNode[]): Map<string | null, NotesTreeNode[]> {
  const groups = new Map<string | null, NotesTreeNode[]>();
  for (const node of nodes) {
    const siblings = groups.get(node.parentId) ?? [];
    siblings.push(node);
    groups.set(node.parentId, siblings);
  }
  for (const siblings of groups.values()) siblings.sort(compareNodes);
  return groups;
}

function rebalanceSiblings(siblings: readonly NotesTreeNode[]): void {
  const sorted = [...siblings].sort(compareNodes);
  for (let index = 0; index < sorted.length; index += 1) {
    sorted[index].order = (index + 1) * ORDER_STEP;
  }
}

function ensureDistinctSiblingOrders(nodes: readonly NotesTreeNode[]): void {
  for (const siblings of siblingGroups(nodes).values()) {
    let previous = -1;
    let requiresRebalance = false;
    for (const sibling of siblings) {
      if (sibling.order <= previous) {
        requiresRebalance = true;
        break;
      }
      previous = sibling.order;
    }
    if (requiresRebalance) rebalanceSiblings(siblings);
  }
}

function repairCycles(nodes: readonly NotesTreeNode[]): void {
  const byId = nodeMap(nodes);
  const complete = new Set<string>();
  for (const startId of [...byId.keys()].sort(compareText)) {
    if (complete.has(startId)) continue;
    const pathIds: string[] = [];
    const pathPositions = new Map<string, number>();
    let currentId: string | null = startId;
    while (currentId !== null && !complete.has(currentId)) {
      const cycleStart = pathPositions.get(currentId);
      if (cycleStart !== undefined) {
        for (const cycleId of pathIds.slice(cycleStart)) {
          const cycleNode = byId.get(cycleId);
          if (cycleNode) cycleNode.parentId = null;
        }
        break;
      }
      pathPositions.set(currentId, pathIds.length);
      pathIds.push(currentId);
      currentId = byId.get(currentId)?.parentId ?? null;
    }
    for (const pathId of pathIds) complete.add(pathId);
  }
}

function nodeDepth(node: NotesTreeNode, byId: ReadonlyMap<string, NotesTreeNode>): number {
  let depth = 0;
  let parentId = node.parentId;
  while (parentId !== null) {
    depth += 1;
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return depth;
}

function repairExcessiveDepth(nodes: readonly NotesTreeNode[]): void {
  const byId = nodeMap(nodes);
  const excessive = nodes
    .filter((node) => {
      let depth = 0;
      let parentId = node.parentId;
      while (parentId !== null) {
        depth += 1;
        if (depth > NOTES_TREE_MAX_DEPTH) return true;
        parentId = byId.get(parentId)?.parentId ?? null;
      }
      return false;
    })
    .map((node) => node.noteId)
    .sort(compareText);
  for (const noteId of excessive) {
    const node = byId.get(noteId);
    if (node) node.parentId = null;
  }
}

function canonicalizeNodes(nodes: readonly NotesTreeNode[]): NotesTreeNode[] {
  const groups = siblingGroups(nodes);
  const result: NotesTreeNode[] = [];
  const append = (parentId: string | null): void => {
    for (const node of groups.get(parentId) ?? []) {
      result.push(cloneNode(node));
      append(node.noteId);
    }
  };
  append(null);
  return result;
}

function appendMissingRoots(nodes: NotesTreeNode[], missingNoteIds: readonly string[]): void {
  if (missingNoteIds.length === 0) return;

  const roots = nodes.filter((node) => node.parentId === null).sort(compareNodes);
  let lastOrder = roots.at(-1)?.order ?? 0;
  const requiredOrderSpace = ORDER_STEP * missingNoteIds.length;
  if (lastOrder > Number.MAX_SAFE_INTEGER - requiredOrderSpace) {
    rebalanceSiblings(roots);
    lastOrder = roots.at(-1)?.order ?? 0;
  }

  for (const noteId of missingNoteIds) {
    lastOrder += ORDER_STEP;
    nodes.push({ noteId, parentId: null, order: lastOrder });
  }
}

function repairSnapshot(rawNodes: readonly NotesTreeNode[], activeNoteIds: readonly string[]): NotesTreeNode[] {
  const active = new Set(activeNoteIds);
  const selected = new Map<string, NotesTreeNode>();

  for (const rawNode of rawNodes) {
    if (!active.has(rawNode.noteId)) continue;
    const candidate = cloneNode(rawNode);
    const current = selected.get(candidate.noteId);
    if (!current || compareDuplicateCandidates(candidate, current) < 0) {
      selected.set(candidate.noteId, candidate);
    }
  }

  const nodes = [...selected.values()];
  for (const node of nodes) {
    if (node.parentId !== null && !active.has(node.parentId)) node.parentId = null;
  }

  const missing = activeNoteIds.filter((noteId) => !selected.has(noteId));
  appendMissingRoots(nodes, missing);

  repairCycles(nodes);
  repairExcessiveDepth(nodes);
  ensureDistinctSiblingOrders(nodes);
  return canonicalizeNodes(nodes);
}

function snapshotsEqual(left: readonly NotesTreeNode[], right: readonly NotesTreeNode[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftNode = left[index];
    const rightNode = right[index];
    if (leftNode.noteId !== rightNode.noteId
      || leftNode.parentId !== rightNode.parentId
      || leftNode.order !== rightNode.order) return false;
  }
  return true;
}

function allocateOrder(
  nodes: readonly NotesTreeNode[],
  parentId: string | null,
  beforeNoteId?: string | null,
): number {
  const siblings = nodes.filter((node) => node.parentId === parentId).sort(compareNodes);
  if (beforeNoteId === undefined || beforeNoteId === null) {
    if (siblings.length === 0) return ORDER_STEP;
    const last = siblings[siblings.length - 1];
    if (last.order <= Number.MAX_SAFE_INTEGER - ORDER_STEP) return last.order + ORDER_STEP;
    rebalanceSiblings(siblings);
    return siblings[siblings.length - 1].order + ORDER_STEP;
  }

  let beforeIndex = siblings.findIndex((node) => node.noteId === beforeNoteId);
  if (beforeIndex < 0) throw new Error('The target sibling was not found.');
  let nextOrder = siblings[beforeIndex].order;
  let previousOrder = beforeIndex === 0 ? -1 : siblings[beforeIndex - 1].order;
  if (nextOrder - previousOrder <= 1) {
    rebalanceSiblings(siblings);
    beforeIndex = siblings.findIndex((node) => node.noteId === beforeNoteId);
    nextOrder = siblings[beforeIndex].order;
    previousOrder = beforeIndex === 0 ? -1 : siblings[beforeIndex - 1].order;
  }
  return previousOrder + Math.floor((nextOrder - previousOrder) / 2);
}

function subtreeHeight(noteId: string, nodes: readonly NotesTreeNode[]): number {
  const children = siblingGroups(nodes);
  const visit = (parentId: string): number => {
    let maximum = 0;
    for (const child of children.get(parentId) ?? []) {
      maximum = Math.max(maximum, 1 + visit(child.noteId));
    }
    return maximum;
  };
  return visit(noteId);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory handles cannot be flushed on every supported filesystem.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class NotesTreeStore {
  private nodes: NotesTreeNode[] = [];
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  load(activeNoteIds: readonly string[]): Promise<NotesTreeSnapshot> {
    const normalizedActiveIds = normalizeActiveNoteIds(activeNoteIds);
    return this.enqueue(async () => {
      let storedNodes: NotesTreeNode[];
      let missing = false;
      try {
        storedNodes = await this.readSnapshot();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        storedNodes = [];
        missing = true;
      }

      const repaired = repairSnapshot(storedNodes, normalizedActiveIds);
      if (missing || !snapshotsEqual(storedNodes, repaired)) await this.persist(repaired);
      this.nodes = repaired.map(cloneNode);
      return cloneSnapshot(this.nodes);
    });
  }

  snapshot(): NotesTreeSnapshot {
    return cloneSnapshot(this.nodes);
  }

  exportSnapshot(): NotesTreeSnapshot {
    return this.snapshot();
  }

  get(): NotesTreeSnapshot;
  get(noteId: string): NotesTreeNode | undefined;
  get(noteId?: string): NotesTreeSnapshot | NotesTreeNode | undefined {
    if (noteId === undefined) return this.snapshot();
    const normalizedId = normalizeNoteId(noteId);
    const node = this.nodes.find((candidate) => candidate.noteId === normalizedId);
    return node ? cloneNode(node) : undefined;
  }

  insert(
    noteId: string,
    parentId: string | null,
    beforeNoteId?: string | null,
  ): Promise<NotesTreeSnapshot> {
    const normalizedId = normalizeNoteId(noteId);
    const normalizedParentId = normalizeParentId(parentId);
    const normalizedBeforeId = beforeNoteId === undefined || beforeNoteId === null
      ? beforeNoteId
      : normalizeNoteId(beforeNoteId);
    return this.enqueue(async () => {
      if (this.nodes.length >= NOTES_TREE_MAX_NODES) throw new Error('The Notes tree is full.');
      if (this.nodes.some((node) => node.noteId === normalizedId)) {
        throw new Error('The Note already exists in the tree.');
      }
      const byId = nodeMap(this.nodes);
      if (normalizedParentId !== null && !byId.has(normalizedParentId)) {
        throw new Error('The parent Note was not found.');
      }
      if (normalizedBeforeId !== undefined && normalizedBeforeId !== null) {
        const before = byId.get(normalizedBeforeId);
        if (!before || before.parentId !== normalizedParentId) {
          throw new Error('The target sibling was not found.');
        }
      }
      const depth = normalizedParentId === null
        ? 0
        : nodeDepth(byId.get(normalizedParentId) as NotesTreeNode, byId) + 1;
      if (depth > NOTES_TREE_MAX_DEPTH) throw new Error('The Notes tree exceeds the maximum depth of 32.');

      const next = this.nodes.map(cloneNode);
      const order = allocateOrder(next, normalizedParentId, normalizedBeforeId);
      next.push({ noteId: normalizedId, parentId: normalizedParentId, order });
      const canonical = canonicalizeNodes(next);
      await this.persist(canonical);
      this.nodes = canonical;
      return this.snapshot();
    });
  }

  move(
    noteId: string,
    parentId: string | null,
    beforeNoteId?: string | null,
  ): Promise<NotesTreeSnapshot> {
    const normalizedId = normalizeNoteId(noteId);
    const normalizedParentId = normalizeParentId(parentId);
    const normalizedBeforeId = beforeNoteId === undefined || beforeNoteId === null
      ? beforeNoteId
      : normalizeNoteId(beforeNoteId);
    return this.enqueue(async () => {
      const byId = nodeMap(this.nodes);
      const moving = byId.get(normalizedId);
      if (!moving) throw new Error('The Note was not found in the tree.');
      if (normalizedParentId === normalizedId) throw new Error('A Note cannot be its own parent.');
      if (normalizedBeforeId === normalizedId) throw new Error('A Note cannot be placed before itself.');
      if (normalizedParentId !== null && !byId.has(normalizedParentId)) {
        throw new Error('The parent Note was not found.');
      }
      if (normalizedBeforeId !== undefined && normalizedBeforeId !== null) {
        const before = byId.get(normalizedBeforeId);
        if (!before || before.parentId !== normalizedParentId) {
          throw new Error('The target sibling was not found.');
        }
      }

      let ancestorId = normalizedParentId;
      while (ancestorId !== null) {
        if (ancestorId === normalizedId) throw new Error('A Note cannot be moved into its own descendant.');
        ancestorId = byId.get(ancestorId)?.parentId ?? null;
      }
      const targetDepth = normalizedParentId === null
        ? 0
        : nodeDepth(byId.get(normalizedParentId) as NotesTreeNode, byId) + 1;
      if (targetDepth + subtreeHeight(normalizedId, this.nodes) > NOTES_TREE_MAX_DEPTH) {
        throw new Error('The Notes tree exceeds the maximum depth of 32.');
      }

      const next = this.nodes.map(cloneNode);
      const movingNext = next.find((node) => node.noteId === normalizedId) as NotesTreeNode;
      const placementNodes = next.filter((node) => node.noteId !== normalizedId);
      movingNext.parentId = normalizedParentId;
      movingNext.order = allocateOrder(placementNodes, normalizedParentId, normalizedBeforeId);
      const canonical = canonicalizeNodes(next);
      await this.persist(canonical);
      this.nodes = canonical;
      return this.snapshot();
    });
  }

  removeIds(noteIds: readonly string[]): Promise<NotesTreeSnapshot> {
    const normalizedIds = normalizeActiveNoteIds(noteIds);
    return this.enqueue(async () => {
      const removed = new Set(normalizedIds);
      if (!this.nodes.some((node) => removed.has(node.noteId))) return this.snapshot();
      const next = this.nodes
        .filter((node) => !removed.has(node.noteId))
        .map((node) => ({
          ...node,
          parentId: node.parentId !== null && removed.has(node.parentId) ? null : node.parentId,
        }));
      ensureDistinctSiblingOrders(next);
      const canonical = canonicalizeNodes(next);
      await this.persist(canonical);
      this.nodes = canonical;
      return this.snapshot();
    });
  }

  replaceSnapshot(value: unknown, activeNoteIds: readonly string[]): Promise<NotesTreeSnapshot> {
    const parsed = parseSnapshot(value);
    const normalizedActiveIds = normalizeActiveNoteIds(activeNoteIds);
    const repaired = repairSnapshot(parsed, normalizedActiveIds);
    return this.enqueue(async () => {
      await this.persist(repaired);
      this.nodes = repaired.map(cloneNode);
      return this.snapshot();
    });
  }

  async flush(): Promise<void> {
    await this.operationQueue;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readSnapshot(): Promise<NotesTreeNode[]> {
    let metadata;
    try {
      metadata = await fs.lstat(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw new Error('Notes tree data could not be read.');
    }
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_TREE_FILE_BYTES) {
      throw new Error('Notes tree data is invalid.');
    }

    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(this.filePath, 'r');
      const opened = await handle.stat();
      if (!opened.isFile()
        || opened.size > MAX_TREE_FILE_BYTES
        || (metadata.ino !== 0 && opened.ino !== 0 && metadata.ino !== opened.ino)
        || metadata.dev !== opened.dev) {
        throw new Error('Notes tree data is invalid.');
      }
      const contents = await handle.readFile();
      if (contents.byteLength > MAX_TREE_FILE_BYTES) throw new Error('Notes tree data is invalid.');
      let value: unknown;
      try {
        value = JSON.parse(contents.toString('utf8')) as unknown;
      } catch {
        throw new Error('Notes tree data is invalid.');
      }
      return parseSnapshot(value);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async persist(nodes: readonly NotesTreeNode[]): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryMetadata = await fs.lstat(directory);
      if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
        throw new Error('Notes tree directory is invalid.');
      }
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(cloneSnapshot(nodes), null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, this.filePath);
      await fs.chmod(this.filePath, 0o600).catch(() => undefined);
      await syncDirectory(directory);
    } catch {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw new Error('Notes tree data could not be saved.');
    }
  }
}
