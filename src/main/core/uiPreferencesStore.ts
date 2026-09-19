import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { UiPreferences, UiPreferencesDraft } from '../../shared/types';
import { DEFAULT_TERMINAL_PREFERENCES, normalizeTerminalPreferences } from '../../shared/terminalPreferences';

export const UI_PREFERENCES_SCHEMA_VERSION = 4 as const;
export const DEFAULT_NOTES_FONT_SIZE = 18;
export const MIN_NOTES_FONT_SIZE = 12;
export const MAX_NOTES_FONT_SIZE = 24;
export const DEFAULT_NOTES_SIDEBAR_WIDTH = 280;
export const MIN_NOTES_SIDEBAR_WIDTH = 240;
export const MAX_NOTES_SIDEBAR_WIDTH = 520;

const MAX_UI_PREFERENCES_BYTES = 16 * 1024;

interface PersistedUiPreferences {
  schemaVersion: typeof UI_PREFERENCES_SCHEMA_VERSION;
  terminal: UiPreferences['terminal'];
  notes: {
    fontSize: number;
    editorTheme: 'light' | 'dark';
    sidebarWidth: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function defaultPreferences(): UiPreferences {
  return {
    notesFontSize: DEFAULT_NOTES_FONT_SIZE,
    notesEditorTheme: 'light',
    notesSidebarWidth: DEFAULT_NOTES_SIDEBAR_WIDTH,
    terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
  };
}

export function normalizeUiPreferencesDraft(value: unknown): UiPreferencesDraft {
  if (!isRecord(value)
    || typeof value.notesFontSize !== 'number'
    || !Number.isInteger(value.notesFontSize)
    || value.notesFontSize < MIN_NOTES_FONT_SIZE
    || value.notesFontSize > MAX_NOTES_FONT_SIZE
    || (value.notesEditorTheme !== 'light' && value.notesEditorTheme !== 'dark')) {
    throw new Error('Notes preferences are invalid.');
  }
  return { notesFontSize: value.notesFontSize, notesEditorTheme: value.notesEditorTheme,
    ...(value.terminal === undefined ? {} : { terminal: normalizeTerminalPreferences(value.terminal) }) };
}

export function normalizeNotesSidebarWidth(value: unknown): number {
  if (typeof value !== 'number'
    || !Number.isInteger(value)
    || value < MIN_NOTES_SIDEBAR_WIDTH
    || value > MAX_NOTES_SIDEBAR_WIDTH) {
    throw new Error('Notes sidebar width is invalid.');
  }
  return value;
}

function parsePersistedPreferences(value: unknown): UiPreferences {
  if (!isRecord(value)
    || ![1, 2, 3, UI_PREFERENCES_SCHEMA_VERSION].includes(value.schemaVersion as number)
    || !isRecord(value.notes)) {
    throw new Error('UI preferences are invalid.');
  }
  const editorPreferences = normalizeUiPreferencesDraft({
    notesFontSize: value.notes.fontSize,
    notesEditorTheme: value.schemaVersion === 1 ? 'light' : value.notes.editorTheme,
  });
  return {
    ...editorPreferences,
    notesSidebarWidth: Number(value.schemaVersion) >= 3
      ? normalizeNotesSidebarWidth(value.notes.sidebarWidth)
      : DEFAULT_NOTES_SIDEBAR_WIDTH,
    terminal: value.schemaVersion === UI_PREFERENCES_SCHEMA_VERSION
      ? normalizeTerminalPreferences(value.terminal) : { ...DEFAULT_TERMINAL_PREFERENCES },
  };
}

function toPersistedPreferences(value: UiPreferences): PersistedUiPreferences {
  return {
    schemaVersion: UI_PREFERENCES_SCHEMA_VERSION,
    terminal: { ...value.terminal },
    notes: {
      fontSize: value.notesFontSize,
      editorTheme: value.notesEditorTheme,
      sidebarWidth: value.notesSidebarWidth,
    },
  };
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

export class UiPreferencesStore {
  private preferences = defaultPreferences();
  private hasPersistedPreferences = false;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    await this.flush();
    try {
      const metadata = await fs.lstat(this.filePath);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_UI_PREFERENCES_BYTES) {
        throw new Error('UI preferences file is invalid.');
      }
      const contents = await fs.readFile(this.filePath, 'utf8');
      this.preferences = parsePersistedPreferences(JSON.parse(contents) as unknown);
      this.hasPersistedPreferences = true;
    } catch {
      // UI preferences are optional. Missing, damaged, or unsupported files
      // safely fall back to stable defaults and can be repaired by the next Save.
      this.preferences = defaultPreferences();
      this.hasPersistedPreferences = false;
    }
  }

  get(): UiPreferences {
    return { ...this.preferences, terminal: { ...this.preferences.terminal } };
  }

  save(value: unknown): Promise<UiPreferences> {
    const normalized = normalizeUiPreferencesDraft(value);
    return this.enqueue(async () => {
      const next = { ...this.preferences, ...normalized };
      if (!this.hasPersistedPreferences
        || next.notesFontSize !== this.preferences.notesFontSize
        || next.notesEditorTheme !== this.preferences.notesEditorTheme
        || JSON.stringify(next.terminal) !== JSON.stringify(this.preferences.terminal)
        || next.notesSidebarWidth !== this.preferences.notesSidebarWidth) {
        await this.persist(next);
        this.preferences = next;
        this.hasPersistedPreferences = true;
      }
      return this.get();
    });
  }

  saveNotesSidebarWidth(value: unknown): Promise<UiPreferences> {
    const notesSidebarWidth = normalizeNotesSidebarWidth(value);
    return this.enqueue(async () => {
      const next = { ...this.preferences, notesSidebarWidth };
      if (!this.hasPersistedPreferences || notesSidebarWidth !== this.preferences.notesSidebarWidth) {
        await this.persist(next);
        this.preferences = next;
        this.hasPersistedPreferences = true;
      }
      return this.get();
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

  private async persist(value: UiPreferences): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    try {
      await fs.mkdir(directory, { recursive: true });
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(toPersistedPreferences(value), null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, this.filePath);
      await fs.chmod(this.filePath, 0o600).catch(() => undefined);
      await syncDirectory(directory);
    } catch {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw new Error('UI preferences could not be saved.');
    }
  }
}
