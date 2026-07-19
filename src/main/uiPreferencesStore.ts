import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { UiPreferences, UiPreferencesDraft } from '../shared/types';

export const UI_PREFERENCES_SCHEMA_VERSION = 1 as const;
export const DEFAULT_NOTES_FONT_SIZE = 14;
export const MIN_NOTES_FONT_SIZE = 12;
export const MAX_NOTES_FONT_SIZE = 24;

const MAX_UI_PREFERENCES_BYTES = 16 * 1024;

interface PersistedUiPreferences {
  schemaVersion: typeof UI_PREFERENCES_SCHEMA_VERSION;
  notes: {
    fontSize: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function defaultPreferences(): UiPreferences {
  return { notesFontSize: DEFAULT_NOTES_FONT_SIZE };
}

export function normalizeUiPreferencesDraft(value: unknown): UiPreferencesDraft {
  if (!isRecord(value)
    || typeof value.notesFontSize !== 'number'
    || !Number.isInteger(value.notesFontSize)
    || value.notesFontSize < MIN_NOTES_FONT_SIZE
    || value.notesFontSize > MAX_NOTES_FONT_SIZE) {
    throw new Error(
      `Notes font size must be a whole number from ${MIN_NOTES_FONT_SIZE} to ${MAX_NOTES_FONT_SIZE}.`,
    );
  }
  return { notesFontSize: value.notesFontSize };
}

function parsePersistedPreferences(value: unknown): UiPreferences {
  if (!isRecord(value)
    || value.schemaVersion !== UI_PREFERENCES_SCHEMA_VERSION
    || !isRecord(value.notes)) {
    throw new Error('UI preferences are invalid.');
  }
  return normalizeUiPreferencesDraft({ notesFontSize: value.notes.fontSize });
}

function toPersistedPreferences(value: UiPreferences): PersistedUiPreferences {
  return {
    schemaVersion: UI_PREFERENCES_SCHEMA_VERSION,
    notes: { fontSize: value.notesFontSize },
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
    return { ...this.preferences };
  }

  save(value: unknown): Promise<UiPreferences> {
    const normalized = normalizeUiPreferencesDraft(value);
    return this.enqueue(async () => {
      const next = { ...normalized };
      if (!this.hasPersistedPreferences || next.notesFontSize !== this.preferences.notesFontSize) {
        await this.persist(next);
        this.preferences = next;
        this.hasPersistedPreferences = true;
      }
      return { ...this.preferences };
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
