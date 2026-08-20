import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  AuthType,
  HostConfig,
  JumpHostConfig,
  Note,
  NotesTreeNode,
  NotesTreeSnapshot,
  ProxyCustomRule,
  ProxyMode,
  ProxySettings,
} from '../shared/types';
import { normalizeRichTextContent } from '../shared/noteRichText';
import { NOTE_LIMITS, NOTES_SCHEMA_VERSION, type NotesSnapshot } from './notesStore';
import {
  NOTES_TREE_MAX_DEPTH,
  NOTES_TREE_MAX_NODES,
  NOTES_TREE_SCHEMA_VERSION,
} from './notesTreeStore';
import { normalizeProxyCustomRules } from './proxy/proxyExceptions';

export const S3_SHARED_DATA_SCHEMA_VERSION = 2 as const;
export const S3_SHARED_NOTES_SCHEMA_VERSION = 2 as const;

const MAX_HOSTS = 10_000;
const MAX_JUMP_HOSTS = 64;
const MAX_HOST_CHILDREN = 10_000;
const MAX_TOMBSTONES = 50_000;
const MAX_ID_CHARACTERS = 128;
const MAX_SHORT_TEXT_CHARACTERS = 16_384;
const MAX_COMMAND_CHARACTERS = 1_048_576;
const MAX_CREDENTIAL_CHARACTERS = 4 * 1_048_576;
const MAX_SUBSCRIPTION_CHARACTERS = 20 * 1_048_576;
const MAX_PROXY_SELECTIONS = 10_000;
const MAX_PROXY_RULES = 10_000;
const CONFLICT_TAG = 'Conflict';
const CONFLICT_SUFFIX = ' (Conflict)';
const CONFLICT_ID_PREFIX = 's3-conflict-';
const CONFLICT_ID_DOMAIN = 'service-manager/s3-note-conflict/v1';
const PROXY_MODES = new Set<ProxyMode>(['direct', 'rule', 'global']);
const NOTES_TREE_ORDER_STEP = 1_024;

export interface S3SharedForwardRule {
  id: string;
  name?: string;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

export interface S3SharedServiceConfig {
  id: string;
  name: string;
  startCommand: string;
  port: number;
  forwardLocalPort?: number;
}

export interface S3SharedHostConfig {
  id: string;
  name: string;
  sshHost: string;
  sshPort: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  jumpHosts: JumpHostConfig[];
  forwards: S3SharedForwardRule[];
  services: S3SharedServiceConfig[];
}

export interface S3NoteTombstone {
  id: string;
  deletedAt: string;
}

export interface S3SharedProxySettings {
  mode: ProxyMode;
  selectedProxies?: Record<string, string>;
  customRules: ProxyCustomRule[];
  subscriptionUpdatedAt?: string;
  proxyCount?: number;
}

export interface S3SharedAppData {
  schemaVersion: typeof S3_SHARED_DATA_SCHEMA_VERSION;
  hosts: {
    schemaVersion: 1;
    items: S3SharedHostConfig[];
  };
  notes: {
    schemaVersion: typeof S3_SHARED_NOTES_SCHEMA_VERSION;
    notes: Note[];
    tombstones: S3NoteTombstone[];
    tree: NotesTreeSnapshot;
  };
  proxy: {
    schemaVersion: 1;
    settings: S3SharedProxySettings;
    subscriptionYaml?: string;
  };
}

export interface S3SharedDataSource {
  hosts: HostConfig[];
  notes: NotesSnapshot;
  notesTree: NotesTreeSnapshot;
  noteTombstones?: S3NoteTombstone[];
  proxy: {
    settings: ProxySettings;
    subscriptionYaml?: string;
  };
}

export interface S3NoteConflict {
  sourceNoteId: string;
  conflictNoteId: string;
}

export interface S3SharedDataMergeResult {
  data: S3SharedAppData;
  conflictCount: number;
  noteConflicts: S3NoteConflict[];
  discardedLocalSections: Array<'hosts' | 'proxy'>;
}

export interface S3LocalApplyStage {
  hosts: HostConfig[];
  notes: NotesSnapshot;
  notesTree: NotesTreeSnapshot;
  noteTombstones: S3NoteTombstone[];
  proxy: {
    settings: ProxySettings;
    subscriptionYaml?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, label: string, maximum = MAX_SHORT_TEXT_CHARACTERS): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label} is invalid.`);
  return normalized;
}

function optionalText(
  value: unknown,
  label: string,
  maximum = MAX_SHORT_TEXT_CHARACTERS,
  trim = false,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const normalized = trim ? value.trim() : value;
  if (!normalized || normalized.length > maximum) throw new Error(`${label} is invalid.`);
  return normalized;
}

function stableId(value: unknown, label: string): string {
  const id = requiredText(value, label, MAX_ID_CHARACTERS);
  if (/[\u0000-\u001f\u007f]/.test(id)) throw new Error(`${label} is invalid.`);
  return id;
}

function port(value: unknown, label: string, allowZero = false): number {
  if (!Number.isInteger(value) || Number(value) < (allowZero ? 0 : 1) || Number(value) > 65_535) {
    throw new Error(`${label} is invalid.`);
  }
  return Number(value);
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 64) throw new Error(`${label} is invalid.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid.`);
  return parsed.toISOString();
}

function authType(value: unknown, label: string): AuthType {
  if (value !== 'password' && value !== 'privateKey') throw new Error(`${label} is invalid.`);
  return value;
}

function boundedArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} is invalid.`);
  return value;
}

function assertUniqueId(ids: Set<string>, id: string, label: string): void {
  if (ids.has(id)) throw new Error(`${label} contains a duplicate ID.`);
  ids.add(id);
}

function parseJumpHost(value: unknown, index: number): JumpHostConfig {
  if (!isRecord(value)) throw new Error(`Jump host ${index + 1} is invalid.`);
  const parsed: JumpHostConfig = {
    sshHost: requiredText(value.sshHost, `Jump host ${index + 1} SSH host`),
    sshPort: port(value.sshPort, `Jump host ${index + 1} SSH port`),
    username: requiredText(value.username, `Jump host ${index + 1} username`),
    authType: authType(value.authType, `Jump host ${index + 1} authentication type`),
    ...(optionalText(value.password, `Jump host ${index + 1} password`, MAX_CREDENTIAL_CHARACTERS) !== undefined
      ? { password: value.password as string }
      : {}),
    ...(optionalText(value.privateKey, `Jump host ${index + 1} private key`, MAX_CREDENTIAL_CHARACTERS) !== undefined
      ? { privateKey: value.privateKey as string }
      : {}),
    ...(optionalText(value.passphrase, `Jump host ${index + 1} passphrase`, MAX_CREDENTIAL_CHARACTERS) !== undefined
      ? { passphrase: value.passphrase as string }
      : {}),
  };
  if (parsed.authType === 'password' ? !parsed.password : !parsed.privateKey) {
    throw new Error(`Jump host ${index + 1} credentials are invalid.`);
  }
  return parsed;
}

function parseSharedForward(value: unknown, index: number): S3SharedForwardRule {
  if (!isRecord(value)) throw new Error(`Forward ${index + 1} is invalid.`);
  const name = optionalText(value.name, `Forward ${index + 1} name`, MAX_SHORT_TEXT_CHARACTERS, true);
  return {
    id: stableId(value.id, `Forward ${index + 1} ID`),
    ...(name ? { name } : {}),
    localHost: requiredText(value.localHost, `Forward ${index + 1} local host`),
    localPort: port(value.localPort, `Forward ${index + 1} local port`),
    remoteHost: requiredText(value.remoteHost, `Forward ${index + 1} remote host`),
    remotePort: port(value.remotePort, `Forward ${index + 1} remote port`),
  };
}

function parseSharedService(value: unknown, index: number): S3SharedServiceConfig {
  if (!isRecord(value)) throw new Error(`Service ${index + 1} is invalid.`);
  const servicePort = port(value.port, `Service ${index + 1} port`, true);
  const forwardLocalPort = value.forwardLocalPort === undefined
    ? undefined
    : port(value.forwardLocalPort, `Service ${index + 1} forward port`);
  return {
    id: stableId(value.id, `Service ${index + 1} ID`),
    name: requiredText(value.name, `Service ${index + 1} name`),
    startCommand: requiredText(value.startCommand, `Service ${index + 1} command`, MAX_COMMAND_CHARACTERS),
    port: servicePort,
    ...(servicePort !== 0 && forwardLocalPort !== undefined ? { forwardLocalPort } : {}),
  };
}

function parseSharedHost(value: unknown, index: number): S3SharedHostConfig {
  if (!isRecord(value)) throw new Error(`Host ${index + 1} is invalid.`);
  const jumpHosts = boundedArray(value.jumpHosts, `Host ${index + 1} jump hosts`, MAX_JUMP_HOSTS)
    .map(parseJumpHost);
  const forwardIds = new Set<string>();
  const forwards = boundedArray(value.forwards, `Host ${index + 1} forwards`, MAX_HOST_CHILDREN)
    .map(parseSharedForward);
  forwards.forEach((forward) => assertUniqueId(forwardIds, forward.id, `Host ${index + 1} forwards`));
  const serviceIds = new Set<string>();
  const services = boundedArray(value.services, `Host ${index + 1} services`, MAX_HOST_CHILDREN)
    .map(parseSharedService);
  services.forEach((service) => assertUniqueId(serviceIds, service.id, `Host ${index + 1} services`));
  const password = optionalText(value.password, `Host ${index + 1} password`, MAX_CREDENTIAL_CHARACTERS);
  const privateKey = optionalText(value.privateKey, `Host ${index + 1} private key`, MAX_CREDENTIAL_CHARACTERS);
  const passphrase = optionalText(value.passphrase, `Host ${index + 1} passphrase`, MAX_CREDENTIAL_CHARACTERS);
  const parsed: S3SharedHostConfig = {
    id: stableId(value.id, `Host ${index + 1} ID`),
    name: requiredText(value.name, `Host ${index + 1} name`),
    sshHost: requiredText(value.sshHost, `Host ${index + 1} SSH host`),
    sshPort: port(value.sshPort, `Host ${index + 1} SSH port`),
    username: requiredText(value.username, `Host ${index + 1} username`),
    authType: authType(value.authType, `Host ${index + 1} authentication type`),
    ...(password !== undefined ? { password } : {}),
    ...(privateKey !== undefined ? { privateKey } : {}),
    ...(passphrase !== undefined ? { passphrase } : {}),
    jumpHosts,
    forwards,
    services,
  };
  if (parsed.authType === 'password' ? !parsed.password : !parsed.privateKey) {
    throw new Error(`Host ${index + 1} credentials are invalid.`);
  }
  return parsed;
}

function parseHosts(value: unknown): S3SharedAppData['hosts'] {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('Shared Hosts data is invalid.');
  const ids = new Set<string>();
  const forwardIds = new Set<string>();
  const items = boundedArray(value.items, 'Shared Hosts data', MAX_HOSTS).map(parseSharedHost);
  items.forEach((host) => {
    assertUniqueId(ids, host.id, 'Shared Hosts data');
    host.forwards.forEach((forward) => assertUniqueId(forwardIds, forward.id, 'Shared Hosts forwards'));
  });
  return { schemaVersion: 1, items };
}

const NOTE_LANGUAGES = new Set<Note['language']>([
  'markdown', 'richtext', 'bash', 'javascript', 'typescript', 'sql', 'json', 'yaml', 'text',
]);

function parseNote(value: unknown, index: number): Note {
  if (!isRecord(value)) throw new Error(`Shared Note ${index + 1} is invalid.`);
  const name = requiredText(value.name, `Shared Note ${index + 1} name`, NOTE_LIMITS.nameCharacters);
  if (typeof value.content !== 'string' || value.content.length > NOTE_LIMITS.contentCharacters) {
    throw new Error(`Shared Note ${index + 1} content is invalid.`);
  }
  if (typeof value.language !== 'string' || !NOTE_LANGUAGES.has(value.language as Note['language'])) {
    throw new Error(`Shared Note ${index + 1} language is invalid.`);
  }
  const rawTags = boundedArray(value.tags, `Shared Note ${index + 1} tags`, NOTE_LIMITS.tags);
  const tagKeys = new Set<string>();
  const tags = rawTags.map((tag, tagIndex) => {
    const normalized = requiredText(
      tag,
      `Shared Note ${index + 1} tag ${tagIndex + 1}`,
      NOTE_LIMITS.tagCharacters,
    );
    const key = normalized.toLocaleLowerCase();
    if (tagKeys.has(key)) throw new Error(`Shared Note ${index + 1} contains duplicate tags.`);
    tagKeys.add(key);
    return normalized;
  });
  let content = value.content;
  if (value.language === 'richtext') {
    try {
      content = normalizeRichTextContent(content);
    } catch {
      throw new Error(`Shared Note ${index + 1} rich text content is invalid.`);
    }
  }
  return {
    id: stableId(value.id, `Shared Note ${index + 1} ID`),
    name,
    content,
    language: value.language as Note['language'],
    tags,
    createdAt: isoTimestamp(value.createdAt, `Shared Note ${index + 1} created timestamp`),
    updatedAt: isoTimestamp(value.updatedAt, `Shared Note ${index + 1} updated timestamp`),
  };
}

function parseTombstone(value: unknown, index: number): S3NoteTombstone {
  if (!isRecord(value)) throw new Error(`Note tombstone ${index + 1} is invalid.`);
  return {
    id: stableId(value.id, `Note tombstone ${index + 1} ID`),
    deletedAt: isoTimestamp(value.deletedAt, `Note tombstone ${index + 1} timestamp`),
  };
}

function compareTreeNodes(left: NotesTreeNode, right: NotesTreeNode): number {
  if (left.order !== right.order) return left.order < right.order ? -1 : 1;
  return left.noteId < right.noteId ? -1 : left.noteId > right.noteId ? 1 : 0;
}

function cloneTreeNode(node: NotesTreeNode): NotesTreeNode {
  return { noteId: node.noteId, parentId: node.parentId, order: node.order };
}

function treeNodeMap(nodes: readonly NotesTreeNode[]): Map<string, NotesTreeNode> {
  return new Map(nodes.map((node) => [node.noteId, node]));
}

function repairTreeCycles(nodes: readonly NotesTreeNode[]): void {
  const byId = treeNodeMap(nodes);
  const complete = new Set<string>();
  for (const startId of [...byId.keys()].sort()) {
    if (complete.has(startId)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let currentId: string | null = startId;
    while (currentId !== null && !complete.has(currentId)) {
      const cycleStart = positions.get(currentId);
      if (cycleStart !== undefined) {
        for (const cycleId of path.slice(cycleStart)) {
          const node = byId.get(cycleId);
          if (node) node.parentId = null;
        }
        break;
      }
      positions.set(currentId, path.length);
      path.push(currentId);
      currentId = byId.get(currentId)?.parentId ?? null;
    }
    for (const noteId of path) complete.add(noteId);
  }
}

function repairTreeDepth(nodes: readonly NotesTreeNode[]): void {
  const byId = treeNodeMap(nodes);
  for (const noteId of [...byId.keys()].sort()) {
    const node = byId.get(noteId) as NotesTreeNode;
    let parentId = node.parentId;
    let depth = 0;
    while (parentId !== null) {
      depth += 1;
      if (depth > NOTES_TREE_MAX_DEPTH) {
        node.parentId = null;
        break;
      }
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
}

function canonicalTreeNodes(nodes: readonly NotesTreeNode[]): NotesTreeNode[] {
  const groups = new Map<string | null, NotesTreeNode[]>();
  for (const node of nodes) {
    const group = groups.get(node.parentId) ?? [];
    group.push(cloneTreeNode(node));
    groups.set(node.parentId, group);
  }
  for (const group of groups.values()) {
    group.sort(compareTreeNodes);
    let previousOrder = -1;
    const needsRebalance = group.some((node) => {
      const duplicateOrRegressing = node.order <= previousOrder;
      previousOrder = node.order;
      return duplicateOrRegressing;
    });
    if (needsRebalance) {
      group.forEach((node, index) => { node.order = (index + 1) * NOTES_TREE_ORDER_STEP; });
    }
  }
  const result: NotesTreeNode[] = [];
  const append = (parentId: string | null): void => {
    for (const node of groups.get(parentId) ?? []) {
      result.push(cloneTreeNode(node));
      append(node.noteId);
    }
  };
  append(null);
  return result;
}

/**
 * Validates and deterministically repairs the shared Note hierarchy against
 * the exact active Note set. Stale nodes are removed, missing/orphaned nodes
 * move to the root, and cycles/depth/order anomalies cannot survive.
 */
export function normalizeS3NotesTreeSnapshot(
  value: unknown,
  activeNoteIdsValue: readonly string[],
): NotesTreeSnapshot {
  if (!isRecord(value)
    || value.schemaVersion !== NOTES_TREE_SCHEMA_VERSION
    || !Array.isArray(value.nodes)
    || value.nodes.length > NOTES_TREE_MAX_NODES
    || activeNoteIdsValue.length > NOTES_TREE_MAX_NODES) {
    throw new Error('Shared Notes tree is invalid.');
  }
  const activeNoteIds = activeNoteIdsValue.map((id, index) => stableId(id, `Active Note ${index + 1} ID`));
  const active = new Set(activeNoteIds);
  if (active.size !== activeNoteIds.length) throw new Error('Shared Notes tree active IDs contain a duplicate.');

  const seen = new Set<string>();
  const nodes: NotesTreeNode[] = [];
  for (const [index, candidate] of value.nodes.entries()) {
    if (!isRecord(candidate)
      || !Number.isSafeInteger(candidate.order)
      || Number(candidate.order) < 0
      || (candidate.parentId !== null && typeof candidate.parentId !== 'string')) {
      throw new Error('Shared Notes tree is invalid.');
    }
    const noteId = stableId(candidate.noteId, `Shared Notes tree node ${index + 1} ID`);
    const parentId = candidate.parentId === null
      ? null
      : stableId(candidate.parentId, `Shared Notes tree node ${index + 1} parent ID`);
    if (seen.has(noteId)) throw new Error('Shared Notes tree contains a duplicate Note ID.');
    seen.add(noteId);
    if (!active.has(noteId)) continue;
    nodes.push({ noteId, parentId, order: Number(candidate.order) });
  }

  const selected = new Set(nodes.map((node) => node.noteId));
  for (const node of nodes) {
    if (node.parentId !== null && !active.has(node.parentId)) node.parentId = null;
  }
  for (const noteId of [...active].sort()) {
    if (!selected.has(noteId)) {
      nodes.push({ noteId, parentId: null, order: Number.MAX_SAFE_INTEGER });
    }
  }
  repairTreeCycles(nodes);
  repairTreeDepth(nodes);
  return {
    schemaVersion: NOTES_TREE_SCHEMA_VERSION,
    nodes: canonicalTreeNodes(nodes),
  };
}

function parseNotes(value: unknown): S3SharedAppData['notes'] {
  if (!isRecord(value) || value.schemaVersion !== S3_SHARED_NOTES_SCHEMA_VERSION) {
    throw new Error('Shared Notes data is invalid.');
  }
  const ids = new Set<string>();
  const notes = boundedArray(value.notes, 'Shared Notes data', NOTE_LIMITS.notes).map(parseNote);
  notes.forEach((note) => assertUniqueId(ids, note.id, 'Shared Notes data'));
  const tombstones = boundedArray(value.tombstones, 'Shared Notes tombstones', MAX_TOMBSTONES)
    .map(parseTombstone);
  tombstones.forEach((tombstone) => assertUniqueId(ids, tombstone.id, 'Shared Notes data'));
  const tree = normalizeS3NotesTreeSnapshot(value.tree, notes.map((note) => note.id));
  return { schemaVersion: S3_SHARED_NOTES_SCHEMA_VERSION, notes, tombstones, tree };
}

function parseSelectedProxies(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length > MAX_PROXY_SELECTIONS) {
    throw new Error('Shared Proxy selections are invalid.');
  }
  const selectedProxies: Record<string, string> = {};
  for (const [group, candidate] of Object.entries(value)) {
    const normalizedGroup = requiredText(group, 'Shared Proxy selection group');
    const normalizedCandidate = requiredText(candidate, 'Shared Proxy selection candidate');
    if (Object.prototype.hasOwnProperty.call(selectedProxies, normalizedGroup)) {
      throw new Error('Shared Proxy selections contain a duplicate group.');
    }
    Object.defineProperty(selectedProxies, normalizedGroup, {
      value: normalizedCandidate,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return Object.keys(selectedProxies).length > 0 ? selectedProxies : undefined;
}

function parseProxyRule(value: unknown, index: number): ProxyCustomRule {
  if (!isRecord(value)) throw new Error(`Shared Proxy rule ${index + 1} is invalid.`);
  stableId(value.id, `Shared Proxy rule ${index + 1} ID`);
  const normalized = normalizeProxyCustomRules([value as unknown as ProxyCustomRule])[0];
  if (normalized.id !== value.id) throw new Error(`Shared Proxy rule ${index + 1} ID is invalid.`);
  return normalized;
}

function parseProxy(value: unknown): S3SharedAppData['proxy'] {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.settings)) {
    throw new Error('Shared Proxy data is invalid.');
  }
  const settings = value.settings;
  if (typeof settings.mode !== 'string' || !PROXY_MODES.has(settings.mode as ProxyMode)) {
    throw new Error('Shared Proxy mode is invalid.');
  }
  const ruleIds = new Set<string>();
  const customRules = boundedArray(settings.customRules, 'Shared Proxy rules', MAX_PROXY_RULES)
    .map(parseProxyRule);
  customRules.forEach((rule) => assertUniqueId(ruleIds, rule.id, 'Shared Proxy rules'));
  const selectedProxies = parseSelectedProxies(settings.selectedProxies);
  const subscriptionUpdatedAt = settings.subscriptionUpdatedAt === undefined
    ? undefined
    : isoTimestamp(settings.subscriptionUpdatedAt, 'Shared Proxy subscription timestamp');
  const proxyCount = settings.proxyCount === undefined ? undefined : Number(settings.proxyCount);
  if (proxyCount !== undefined && (!Number.isInteger(proxyCount) || proxyCount < 0)) {
    throw new Error('Shared Proxy count is invalid.');
  }
  if (value.subscriptionYaml !== undefined
    && (typeof value.subscriptionYaml !== 'string' || value.subscriptionYaml.length > MAX_SUBSCRIPTION_CHARACTERS)) {
    throw new Error('Shared Proxy subscription is invalid.');
  }
  return {
    schemaVersion: 1,
    settings: {
      mode: settings.mode as ProxyMode,
      ...(selectedProxies ? { selectedProxies } : {}),
      customRules,
      ...(subscriptionUpdatedAt ? { subscriptionUpdatedAt } : {}),
      ...(proxyCount !== undefined ? { proxyCount } : {}),
    },
    ...(typeof value.subscriptionYaml === 'string' ? { subscriptionYaml: value.subscriptionYaml } : {}),
  };
}

/**
 * Validates untrusted decrypted shared data and returns a detached field-allowlisted
 * object suitable for merge or staged local application.
 */
export function parseS3SharedAppData(value: unknown): S3SharedAppData {
  if (!isRecord(value) || value.schemaVersion !== S3_SHARED_DATA_SCHEMA_VERSION) {
    throw new Error('Shared application data is invalid.');
  }
  return {
    schemaVersion: S3_SHARED_DATA_SCHEMA_VERSION,
    hosts: parseHosts(value.hosts),
    notes: parseNotes(value.notes),
    proxy: parseProxy(value.proxy),
  };
}

/** Builds the cloud-shareable projection and strips every device-local field. */
export function createS3SharedAppData(source: S3SharedDataSource): S3SharedAppData {
  return parseS3SharedAppData({
    schemaVersion: S3_SHARED_DATA_SCHEMA_VERSION,
    hosts: {
      schemaVersion: 1,
      items: source.hosts.map((host) => ({
        id: host.id,
        name: host.name,
        sshHost: host.sshHost,
        sshPort: host.sshPort,
        username: host.username,
        authType: host.authType,
        ...(host.password ? { password: host.password } : {}),
        ...(host.privateKey ? { privateKey: host.privateKey } : {}),
        ...(host.passphrase ? { passphrase: host.passphrase } : {}),
        jumpHosts: host.jumpHosts.map((jumpHost) => ({ ...jumpHost })),
        forwards: host.forwards.map((forward) => ({
          id: forward.id,
          ...(forward.name ? { name: forward.name } : {}),
          localHost: forward.localHost,
          localPort: forward.localPort,
          remoteHost: forward.remoteHost,
          remotePort: forward.remotePort,
        })),
        services: host.services.map((service) => ({
          id: service.id,
          name: service.name,
          startCommand: service.startCommand,
          port: service.port,
          ...(service.forwardLocalPort !== undefined ? { forwardLocalPort: service.forwardLocalPort } : {}),
        })),
      })),
    },
    notes: {
      schemaVersion: S3_SHARED_NOTES_SCHEMA_VERSION,
      notes: source.notes.notes.map((note) => ({ ...note, tags: [...note.tags] })),
      tombstones: (source.noteTombstones ?? []).map((tombstone) => ({ ...tombstone })),
      tree: source.notesTree,
    },
    proxy: {
      schemaVersion: 1,
      settings: {
        mode: source.proxy.settings.mode,
        ...(source.proxy.settings.selectedProxies
          ? { selectedProxies: { ...source.proxy.settings.selectedProxies } }
          : {}),
        customRules: (source.proxy.settings.customRules ?? []).map((rule) => ({ ...rule })),
        ...(source.proxy.settings.subscriptionUpdatedAt
          ? { subscriptionUpdatedAt: source.proxy.settings.subscriptionUpdatedAt }
          : {}),
        ...(source.proxy.settings.proxyCount !== undefined
          ? { proxyCount: source.proxy.settings.proxyCount }
          : {}),
      },
      ...(source.proxy.subscriptionYaml !== undefined
        ? { subscriptionYaml: source.proxy.subscriptionYaml }
        : {}),
    },
  });
}

type NoteState =
  | { kind: 'absent' }
  | { kind: 'note'; note: Note }
  | { kind: 'deleted'; tombstone: S3NoteTombstone };

const ABSENT_NOTE_STATE: NoteState = Object.freeze({ kind: 'absent' });

function rawNoteState(
  notes: ReadonlyMap<string, Note>,
  tombstones: ReadonlyMap<string, S3NoteTombstone>,
  id: string,
): NoteState {
  const note = notes.get(id);
  if (note) return { kind: 'note', note };
  const tombstone = tombstones.get(id);
  return tombstone ? { kind: 'deleted', tombstone } : ABSENT_NOTE_STATE;
}

function effectiveBranchState(branch: NoteState, base: NoteState): NoteState {
  if (branch.kind !== 'absent') return branch;
  // Deletion is explicit. A missing per-Note file must not turn a fresh or
  // partially recovered local directory into a deletion of the cloud Note.
  return base;
}

function notesEquivalent(left: Note, right: Note): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.content === right.content
    && left.language === right.language
    && left.createdAt === right.createdAt
    && isDeepStrictEqual(left.tags, right.tags);
}

function noteStatesEquivalent(left: NoteState, right: NoteState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'absent') return true;
  if (left.kind === 'deleted') return true;
  return right.kind === 'note' && notesEquivalent(left.note, right.note);
}

function conflictName(name: string): string {
  const available = NOTE_LIMITS.nameCharacters - CONFLICT_SUFFIX.length;
  return `${name.slice(0, Math.max(1, available)).trimEnd()}${CONFLICT_SUFFIX}`;
}

function conflictTags(tags: string[]): string[] {
  if (tags.some((tag) => tag.toLocaleLowerCase() === CONFLICT_TAG.toLocaleLowerCase())) return [...tags];
  return [...tags.slice(0, NOTE_LIMITS.tags - 1), CONFLICT_TAG];
}

function conflictNoteIdentityValue(note: Note): readonly unknown[] {
  // Keep this aligned with notesEquivalent. updatedAt alone is not a content
  // divergence and conflict copies receive the merge timestamp anyway.
  return [
    note.id,
    note.name,
    note.content,
    note.language,
    note.tags,
    note.createdAt,
  ];
}

function conflictStateIdentityValue(state: NoteState): readonly unknown[] {
  if (state.kind === 'absent') return ['absent'];
  if (state.kind === 'deleted') return ['deleted', state.tombstone.id, state.tombstone.deletedAt];
  return ['note', ...conflictNoteIdentityValue(state.note)];
}

function stableConflictId(
  source: Note,
  baseState: NoteState,
  cloudState: NoteState,
  attempt: number,
): string {
  const identity = JSON.stringify([
    CONFLICT_ID_DOMAIN,
    conflictStateIdentityValue(baseState),
    conflictNoteIdentityValue(source),
    conflictStateIdentityValue(cloudState),
    attempt,
  ]);
  const digest = createHash('sha256').update(identity, 'utf8').digest('base64url');
  return stableId(`${CONFLICT_ID_PREFIX}${digest}`, 'Conflict Note ID');
}

function isConflictCopyPayload(note: Note, source: Note): boolean {
  return note.name === conflictName(source.name)
    && note.content === source.content
    && note.language === source.language
    && isDeepStrictEqual(note.tags, conflictTags(source.tags));
}

type ConflictNoteResolution =
  | { kind: 'created'; note: Note }
  | { kind: 'reused'; id: string };

function resolveConflictNote(
  source: Note,
  baseState: NoteState,
  cloudState: NoteState,
  timestamp: string,
  reservedIds: Set<string>,
  createId: (() => string) | undefined,
  baseNotes: ReadonlyMap<string, Note>,
  baseTombstones: ReadonlyMap<string, S3NoteTombstone>,
  localNotes: ReadonlyMap<string, Note>,
  localTombstones: ReadonlyMap<string, S3NoteTombstone>,
  cloudNotes: ReadonlyMap<string, Note>,
): ConflictNoteResolution {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = createId
      ? stableId(createId(), 'Conflict Note ID')
      : stableConflictId(source, baseState, cloudState, attempt);
    if (!reservedIds.has(candidate)) {
      reservedIds.add(candidate);
      return {
        kind: 'created',
        note: {
          ...source,
          id: candidate,
          name: conflictName(source.name),
          tags: conflictTags(source.tags),
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      };
    }
    if (!createId
      && rawNoteState(baseNotes, baseTombstones, candidate).kind === 'absent') {
      // This is a revision that this client already published but did not get
      // to apply locally. Reuse only when cloud still owns the exact copy and
      // local has not deleted or independently changed that candidate; its
      // existing cloud tree placement must remain authoritative.
      const cloudConflict = cloudNotes.get(candidate);
      const localConflict = rawNoteState(localNotes, localTombstones, candidate);
      if (cloudConflict
        && isConflictCopyPayload(cloudConflict, source)
        && (localConflict.kind === 'absent'
          || (localConflict.kind === 'note' && notesEquivalent(localConflict.note, cloudConflict)))) {
        return { kind: 'reused', id: candidate };
      }
    }
  }
  throw new Error('A unique conflict Note ID could not be created.');
}

function sectionChoice<T>(
  section: 'hosts' | 'proxy',
  base: T | undefined,
  local: T,
  cloud: T,
  discardedLocalSections: Array<'hosts' | 'proxy'>,
): T {
  if (isDeepStrictEqual(local, cloud)) return cloud;
  if (base === undefined) {
    const localRecord = local as Record<string, unknown>;
    const meaningful = section === 'hosts'
      ? isRecord(localRecord) && Array.isArray(localRecord.items) && localRecord.items.length > 0
      : isRecord(localRecord)
        && (
          typeof localRecord.subscriptionYaml === 'string'
          || (isRecord(localRecord.settings)
            && (localRecord.settings.mode !== 'rule'
              || (Array.isArray(localRecord.settings.customRules) && localRecord.settings.customRules.length > 0)
              || (isRecord(localRecord.settings.selectedProxies) && Object.keys(localRecord.settings.selectedProxies).length > 0)))
        );
    if (meaningful) discardedLocalSections.push(section);
    return cloud;
  }
  const localChanged = !isDeepStrictEqual(local, base);
  const cloudChanged = !isDeepStrictEqual(cloud, base);
  if (!localChanged) return cloud;
  if (!cloudChanged) return local;
  discardedLocalSections.push(section);
  return cloud;
}

function treePlacementsEquivalent(left: NotesTreeNode | undefined, right: NotesTreeNode | undefined): boolean {
  if (!left || !right) return left === right;
  return left.noteId === right.noteId
    && left.parentId === right.parentId
    && left.order === right.order;
}

export function mergeS3NotesTreeSnapshots(options: {
  base?: NotesTreeSnapshot;
  local: NotesTreeSnapshot;
  cloud: NotesTreeSnapshot;
  activeNoteIds: readonly string[];
  conflicts?: readonly S3NoteConflict[];
  newConflicts?: readonly S3NoteConflict[];
}): NotesTreeSnapshot {
  const normalizeBranch = (tree: NotesTreeSnapshot): NotesTreeSnapshot =>
    normalizeS3NotesTreeSnapshot(tree, tree.nodes.map((node) => node.noteId));
  const base = options.base ? normalizeBranch(options.base) : undefined;
  const local = normalizeBranch(options.local);
  const cloud = normalizeBranch(options.cloud);
  const baseNodes = new Map((base?.nodes ?? []).map((node) => [node.noteId, node]));
  const localNodes = new Map(local.nodes.map((node) => [node.noteId, node]));
  const cloudNodes = new Map(cloud.nodes.map((node) => [node.noteId, node]));
  const selected: NotesTreeNode[] = [];

  for (const noteId of options.activeNoteIds) {
    const baseNode = baseNodes.get(noteId);
    const localNode = localNodes.get(noteId);
    const cloudNode = cloudNodes.get(noteId);
    let chosen: NotesTreeNode | undefined;
    if (localNode && cloudNode) {
      if (!baseNode) chosen = cloudNode;
      else {
        const localChanged = !treePlacementsEquivalent(localNode, baseNode);
        const cloudChanged = !treePlacementsEquivalent(cloudNode, baseNode);
        if (!localChanged) chosen = cloudNode;
        else if (!cloudChanged) chosen = localNode;
        else if (treePlacementsEquivalent(localNode, cloudNode)) chosen = cloudNode;
        else chosen = cloudNode;
      }
    } else {
      chosen = cloudNode ?? localNode ?? baseNode;
    }
    if (chosen) selected.push(cloneTreeNode(chosen));
  }

  const conflictMap = new Map((options.conflicts ?? []).map((conflict) => [
    conflict.sourceNoteId,
    conflict.conflictNoteId,
  ]));
  for (const conflict of options.newConflicts ?? options.conflicts ?? []) {
    const source = localNodes.get(conflict.sourceNoteId);
    if (!source) continue;
    selected.push({
      noteId: conflict.conflictNoteId,
      parentId: source.parentId === null
        ? null
        : conflictMap.get(source.parentId) ?? source.parentId,
      order: source.order,
    });
  }

  return normalizeS3NotesTreeSnapshot({
    schemaVersion: NOTES_TREE_SCHEMA_VERSION,
    nodes: selected,
  }, options.activeNoteIds);
}

/**
 * Three-way merge for a CAS retry. Cloud wins true conflicts; independent Note
 * IDs merge, and a divergent local Note becomes a visible conflict copy.
 */
export function mergeS3SharedAppData(options: {
  base?: S3SharedAppData;
  local: S3SharedAppData;
  cloud: S3SharedAppData;
  now?: string;
  createId?: () => string;
}): S3SharedDataMergeResult {
  const base = options.base ? parseS3SharedAppData(options.base) : undefined;
  const local = parseS3SharedAppData(options.local);
  const cloud = parseS3SharedAppData(options.cloud);
  const now = isoTimestamp(options.now ?? new Date().toISOString(), 'Merge timestamp');
  const createId = options.createId;
  const discardedLocalSections: Array<'hosts' | 'proxy'> = [];

  const baseNotes = new Map((base?.notes.notes ?? []).map((note) => [note.id, note]));
  const baseTombstones = new Map((base?.notes.tombstones ?? []).map((item) => [item.id, item]));
  const localNotes = new Map(local.notes.notes.map((note) => [note.id, note]));
  const localTombstones = new Map(local.notes.tombstones.map((item) => [item.id, item]));
  const cloudNotes = new Map(cloud.notes.notes.map((note) => [note.id, note]));
  const cloudTombstones = new Map(cloud.notes.tombstones.map((item) => [item.id, item]));
  const orderedIds = new Set<string>([
    ...cloud.notes.notes.map((note) => note.id),
    ...cloud.notes.tombstones.map((item) => item.id),
    ...local.notes.notes.map((note) => note.id),
    ...local.notes.tombstones.map((item) => item.id),
    ...(base?.notes.notes.map((note) => note.id) ?? []),
    ...(base?.notes.tombstones.map((item) => item.id) ?? []),
  ]);
  const reservedIds = new Set(orderedIds);
  const mergedNotes: Note[] = [];
  const mergedTombstones: S3NoteTombstone[] = [];
  const conflictNotes: Note[] = [];
  const noteConflicts: S3NoteConflict[] = [];
  const newNoteConflicts: S3NoteConflict[] = [];
  let deletionConflicts = 0;

  for (const id of orderedIds) {
    const baseState = rawNoteState(baseNotes, baseTombstones, id);
    const localState = effectiveBranchState(rawNoteState(localNotes, localTombstones, id), baseState);
    const cloudState = effectiveBranchState(rawNoteState(cloudNotes, cloudTombstones, id), baseState);
    const localChanged = !noteStatesEquivalent(localState, baseState);
    const cloudChanged = !noteStatesEquivalent(cloudState, baseState);
    let chosen: NoteState;

    // A client whose merge base already contains this exact tombstone has
    // observed the deletion. Reintroducing the Note after that point is an
    // explicit restore (for example, a deliberate Trilium re-import), not a
    // stale client resurrecting data it has never seen deleted.
    if (cloudState.kind === 'deleted' && localState.kind === 'note') {
      const restoresKnownDeletion = baseState.kind === 'deleted'
        && baseState.tombstone.id === cloudState.tombstone.id
        && baseState.tombstone.deletedAt === cloudState.tombstone.deletedAt;
      if (restoresKnownDeletion) {
        chosen = localState;
      } else {
        chosen = cloudState;
      }
      if (!restoresKnownDeletion && localChanged) {
        const conflict = resolveConflictNote(
          localState.note,
          baseState,
          cloudState,
          now,
          reservedIds,
          createId,
          baseNotes,
          baseTombstones,
          localNotes,
          localTombstones,
          cloudNotes,
        );
        const mapping = {
          sourceNoteId: id,
          conflictNoteId: conflict.kind === 'created' ? conflict.note.id : conflict.id,
        };
        noteConflicts.push(mapping);
        if (conflict.kind === 'created') {
          conflictNotes.push(conflict.note);
          newNoteConflicts.push(mapping);
        }
      }
    } else if (!localChanged) chosen = cloudState;
    else if (!cloudChanged) chosen = localState;
    else if (noteStatesEquivalent(localState, cloudState)) chosen = cloudState;
    else {
      chosen = cloudState;
      if (localState.kind === 'note') {
        const conflict = resolveConflictNote(
          localState.note,
          baseState,
          cloudState,
          now,
          reservedIds,
          createId,
          baseNotes,
          baseTombstones,
          localNotes,
          localTombstones,
          cloudNotes,
        );
        const mapping = {
          sourceNoteId: id,
          conflictNoteId: conflict.kind === 'created' ? conflict.note.id : conflict.id,
        };
        noteConflicts.push(mapping);
        if (conflict.kind === 'created') {
          conflictNotes.push(conflict.note);
          newNoteConflicts.push(mapping);
        }
      } else if (localState.kind === 'deleted' && cloudState.kind === 'note') {
        // There is no local body to preserve as a conflict copy, but the cloud
        // edit did override an intentional local deletion and must remain
        // visible as a synchronization conflict rather than an ordinary pull.
        deletionConflicts += 1;
      }
    }

    if (chosen.kind === 'note') mergedNotes.push({ ...chosen.note, tags: [...chosen.note.tags] });
    else if (chosen.kind === 'deleted') mergedTombstones.push({ ...chosen.tombstone });
  }

  mergedNotes.push(...conflictNotes);
  if (mergedNotes.length > NOTE_LIMITS.notes) throw new Error('The merged Notes exceed the supported limit.');
  if (mergedTombstones.length > MAX_TOMBSTONES) throw new Error('The merged Note tombstones exceed the supported limit.');

  const mergedTree = mergeS3NotesTreeSnapshots({
    ...(base ? { base: base.notes.tree } : {}),
    local: local.notes.tree,
    cloud: cloud.notes.tree,
    activeNoteIds: mergedNotes.map((note) => note.id),
    conflicts: noteConflicts,
    newConflicts: newNoteConflicts,
  });
  const data = parseS3SharedAppData({
    schemaVersion: S3_SHARED_DATA_SCHEMA_VERSION,
    hosts: sectionChoice('hosts', base?.hosts, local.hosts, cloud.hosts, discardedLocalSections),
    notes: {
      schemaVersion: S3_SHARED_NOTES_SCHEMA_VERSION,
      notes: mergedNotes,
      tombstones: mergedTombstones,
      tree: mergedTree,
    },
    proxy: sectionChoice('proxy', base?.proxy, local.proxy, cloud.proxy, discardedLocalSections),
  });
  return {
    data,
    conflictCount: noteConflicts.length + deletionConflicts,
    noteConflicts,
    discardedLocalSections,
  };
}

/**
 * Produces a detached apply plan. The caller can persist it with store-specific
 * atomic operations after all validation succeeds. Device-only values are
 * overlaid from the current installation and never accepted from S3.
 */
export function stageS3SharedAppDataForLocalApply(
  untrustedCloudData: unknown,
  local: {
    hosts: HostConfig[];
    proxy: { settings: ProxySettings; subscriptionYaml?: string };
  },
): S3LocalApplyStage {
  const cloud = parseS3SharedAppData(untrustedCloudData);
  const localHosts = new Map(local.hosts.map((host) => [host.id, host]));
  const hosts: HostConfig[] = cloud.hosts.items.map((sharedHost) => {
    const localHost = localHosts.get(sharedHost.id);
    const localForwards = new Map((localHost?.forwards ?? []).map((forward) => [forward.id, forward]));
    const localServices = new Map((localHost?.services ?? []).map((service) => [service.id, service]));
    return {
      ...sharedHost,
      ...(sharedHost.authType === 'privateKey' && localHost?.privateKeyPath
        ? { privateKeyPath: localHost.privateKeyPath }
        : {}),
      jumpHosts: sharedHost.jumpHosts.map((jumpHost) => ({ ...jumpHost })),
      forwards: sharedHost.forwards.map((forward) => ({
        ...forward,
        autoStart: localForwards.get(forward.id)?.autoStart === true,
      })),
      services: sharedHost.services.map((service) => {
        const localService = localServices.get(service.id);
        const keepPid = localService?.startCommand === service.startCommand
          && localService.port === service.port
          && typeof localService.pid === 'number';
        return { ...service, ...(keepPid ? { pid: localService.pid } : {}) };
      }),
    };
  });
  const localProxy = local.proxy.settings;
  const sharedProxy = cloud.proxy.settings;
  const settings: ProxySettings = {
    startOnLaunch: localProxy.startOnLaunch === true,
    mode: sharedProxy.mode,
    mixedPort: Number.isInteger(localProxy.mixedPort) && localProxy.mixedPort >= 1 && localProxy.mixedPort <= 65_535
      ? localProxy.mixedPort
      : 7_890,
    tunEnabled: localProxy.tunEnabled === true,
    systemProxyEnabled: localProxy.systemProxyEnabled === true,
    ...(sharedProxy.selectedProxies ? { selectedProxies: { ...sharedProxy.selectedProxies } } : {}),
    customRules: sharedProxy.customRules.map((rule) => ({ ...rule })),
    ...(sharedProxy.subscriptionUpdatedAt ? { subscriptionUpdatedAt: sharedProxy.subscriptionUpdatedAt } : {}),
    ...(sharedProxy.proxyCount !== undefined ? { proxyCount: sharedProxy.proxyCount } : {}),
  };
  return {
    hosts,
    notes: {
      schemaVersion: NOTES_SCHEMA_VERSION,
      notes: cloud.notes.notes.map((note) => ({ ...note, tags: [...note.tags] })),
    },
    notesTree: normalizeS3NotesTreeSnapshot(
      cloud.notes.tree,
      cloud.notes.notes.map((note) => note.id),
    ),
    noteTombstones: cloud.notes.tombstones.map((tombstone) => ({ ...tombstone })),
    proxy: {
      settings,
      ...(cloud.proxy.subscriptionYaml !== undefined ? { subscriptionYaml: cloud.proxy.subscriptionYaml } : {}),
    },
  };
}
