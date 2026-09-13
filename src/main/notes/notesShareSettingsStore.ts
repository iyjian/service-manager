import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type {
  NoteShareSettingsDraft,
  NoteShareSettingsView,
  NoteShareShortenerCredentialValues,
  NoteShareView,
} from '../../shared/types';

export const NOTE_SHARE_SETTINGS_SCHEMA_VERSION = 1 as const;

const MAX_SETTINGS_BYTES = 128 * 1024;
const MAX_ENDPOINT_CHARACTERS = 4_096;
const MAX_API_KEY_CHARACTERS = 16 * 1024;
const MAX_PROTECTED_API_KEY_CHARACTERS = 96 * 1024;
const MAX_SHLINK_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface NotesShareCredentialProtector {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export interface NormalizedNoteShareSettingsDraft {
  shortenerBaseUrl: string;
  shortenerApiKey?: string;
  clearShortenerApiKey: boolean;
}

export interface NoteShareShortenerConfig {
  baseUrl: string;
  apiKey: string;
}

export interface NotesShareSettingsStoreOptions {
  filePath: string;
  credentialProtector: NotesShareCredentialProtector;
}

interface PersistedNoteShareSettings {
  schemaVersion: typeof NOTE_SHARE_SETTINGS_SCHEMA_VERSION;
  shortenerBaseUrl: string;
  encryptedShortenerApiKey?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function defaultSettings(): PersistedNoteShareSettings {
  return {
    schemaVersion: NOTE_SHARE_SETTINGS_SCHEMA_VERSION,
    shortenerBaseUrl: '',
  };
}

export function normalizeNoteShareShortenerBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The Note share shortener URL is invalid.');
  const input = value.trim();
  if (input.length === 0) return '';
  if (input.length > MAX_ENDPOINT_CHARACTERS) {
    throw new Error('The Note share shortener URL is invalid.');
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('The Note share shortener URL is invalid.');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('The Note share shortener URL must be an HTTP(S) URL without credentials, a query, or a fragment.');
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  const normalized = `${parsed.protocol}//${parsed.host}${pathname === '' ? '' : pathname}`;
  if (normalized.length > MAX_ENDPOINT_CHARACTERS) {
    throw new Error('The Note share shortener URL is invalid.');
  }
  return normalized;
}

function normalizeShortenerApiKey(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (
    typeof value !== 'string'
    || value.length > MAX_API_KEY_CHARACTERS
    || /[\u0000\r\n]/.test(value)
  ) {
    throw new Error('The Note share shortener API key is invalid.');
  }
  return value;
}

export function normalizeNoteShareSettingsDraft(value: unknown): NormalizedNoteShareSettingsDraft {
  if (!isRecord(value) || !hasOnlyKeys(value, ['shortenerBaseUrl', 'shortenerApiKey', 'clearShortenerApiKey'])) {
    throw new Error('The Note share settings are invalid.');
  }
  if (value.clearShortenerApiKey !== undefined && typeof value.clearShortenerApiKey !== 'boolean') {
    throw new Error('The Note share settings are invalid.');
  }
  const shortenerApiKey = normalizeShortenerApiKey(value.shortenerApiKey);
  const clearShortenerApiKey = value.clearShortenerApiKey === true;
  if (shortenerApiKey !== undefined && clearShortenerApiKey) {
    throw new Error('The Note share shortener API key cannot be replaced and cleared at the same time.');
  }
  return {
    shortenerBaseUrl: normalizeNoteShareShortenerBaseUrl(value.shortenerBaseUrl),
    ...(shortenerApiKey === undefined ? {} : { shortenerApiKey }),
    clearShortenerApiKey,
  };
}

function strictProtectedApiKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PROTECTED_API_KEY_CHARACTERS
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('Note share settings are invalid.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new Error('Note share settings are invalid.');
  }
  return value;
}

function parsePersistedSettings(value: unknown): PersistedNoteShareSettings {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'shortenerBaseUrl', 'encryptedShortenerApiKey'])
    || value.schemaVersion !== NOTE_SHARE_SETTINGS_SCHEMA_VERSION
  ) {
    throw new Error('Note share settings are invalid.');
  }
  const shortenerBaseUrl = normalizeNoteShareShortenerBaseUrl(value.shortenerBaseUrl);
  if (shortenerBaseUrl !== value.shortenerBaseUrl) {
    throw new Error('Note share settings are invalid.');
  }
  const encryptedShortenerApiKey = strictProtectedApiKey(value.encryptedShortenerApiKey);
  return {
    schemaVersion: NOTE_SHARE_SETTINGS_SCHEMA_VERSION,
    shortenerBaseUrl,
    ...(encryptedShortenerApiKey === undefined ? {} : { encryptedShortenerApiKey }),
  };
}

function settingsView(value: PersistedNoteShareSettings): NoteShareSettingsView {
  return {
    shortenerBaseUrl: value.shortenerBaseUrl,
    hasShortenerApiKey: Boolean(value.encryptedShortenerApiKey),
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

async function readResponseBody(response: Response, maximumBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('The Note share shortener response is too large.');
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const value = Buffer.from(chunk.value);
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('The Note share shortener response is too large.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function parseShlinkShortUrl(value: unknown): string {
  if (!isRecord(value) || typeof value.shortUrl !== 'string') {
    throw new Error('The Note share shortener response is invalid.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.shortUrl);
  } catch {
    throw new Error('The Note share shortener response is invalid.');
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
    throw new Error('The Note share shortener response is invalid.');
  }
  return value.shortUrl;
}

export async function createShlinkShortUrl(
  longUrl: string,
  config: NoteShareShortenerConfig,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  const target = new URL(longUrl);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error('The Note share URL cannot be shortened.');
  }
  const baseUrl = normalizeNoteShareShortenerBaseUrl(config.baseUrl);
  const apiKey = normalizeShortenerApiKey(config.apiKey);
  if (!baseUrl || !apiKey) throw new Error('The Note share shortener is not configured.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/rest/v3/short-urls`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify({
        longUrl,
        findIfExists: true,
      }),
      signal: controller.signal,
      redirect: 'manual',
    });
    const body = await readResponseBody(response, MAX_SHLINK_RESPONSE_BYTES);
    let parsed: unknown;
    try {
      parsed = body.byteLength ? JSON.parse(body.toString('utf8')) : {};
    } catch {
      throw new Error('The Note share shortener response is invalid.');
    }
    if (!response.ok) {
      const detail = isRecord(parsed) && typeof parsed.detail === 'string' ? ` ${parsed.detail.slice(0, 500)}` : '';
      throw new Error(`The Note share shortener rejected the URL (${response.status}).${detail}`);
    }
    return parseShlinkShortUrl(parsed);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The Note share shortener request timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function shortenNoteShareViewUrls(
  shares: readonly NoteShareView[],
  config: NoteShareShortenerConfig | undefined,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<NoteShareView[]> {
  if (!config) return shares.map((share) => ({ ...share }));
  const result: NoteShareView[] = [];
  for (const share of shares) {
    let shortUrl: string | undefined;
    if (share.url) {
      try {
        shortUrl = await createShlinkShortUrl(share.url, config, options);
      } catch {
        shortUrl = undefined;
      }
    }
    result.push({
      ...share,
      ...(shortUrl ? { url: shortUrl } : {}),
    });
  }
  return result;
}

export class NotesShareSettingsStore {
  private settings = defaultSettings();
  private hasPersistedSettings = false;
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly options: NotesShareSettingsStoreOptions) {}

  public load(): Promise<void> {
    return this.enqueue(async () => {
      try {
        const metadata = await fs.lstat(this.options.filePath);
        if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_SETTINGS_BYTES) {
          throw new Error('Note share settings are invalid.');
        }
        const contents = await fs.readFile(this.options.filePath, 'utf8');
        this.settings = parsePersistedSettings(JSON.parse(contents) as unknown);
        this.hasPersistedSettings = true;
      } catch {
        this.settings = defaultSettings();
        this.hasPersistedSettings = false;
      }
    });
  }

  public get(): NoteShareSettingsView {
    return settingsView(this.settings);
  }

  public save(value: unknown): Promise<NoteShareSettingsView> {
    const draft = normalizeNoteShareSettingsDraft(value);
    return this.enqueue(async () => {
      let encryptedShortenerApiKey = this.settings.encryptedShortenerApiKey;
      if (draft.clearShortenerApiKey) {
        encryptedShortenerApiKey = undefined;
      } else if (draft.shortenerApiKey !== undefined) {
        encryptedShortenerApiKey = this.protectApiKey(draft.shortenerApiKey);
      }

      const next: PersistedNoteShareSettings = {
        schemaVersion: NOTE_SHARE_SETTINGS_SCHEMA_VERSION,
        shortenerBaseUrl: draft.shortenerBaseUrl,
        ...(encryptedShortenerApiKey === undefined ? {} : { encryptedShortenerApiKey }),
      };
      if (!this.hasPersistedSettings || JSON.stringify(next) !== JSON.stringify(this.settings)) {
        await this.persist(next);
        this.settings = next;
        this.hasPersistedSettings = true;
      }
      return settingsView(this.settings);
    });
  }

  public revealShortenerApiKey(): Promise<string> {
    return this.enqueue(async () => {
      const encrypted = this.settings.encryptedShortenerApiKey;
      if (!encrypted || !this.hasSecureCredentialStorage()) {
        throw new Error('The Note share shortener API key is unavailable. Save it again.');
      }
      return this.unprotectApiKey(encrypted);
    });
  }

  public revealShortenerCredentials(): Promise<NoteShareShortenerCredentialValues> {
    return this.revealShortenerApiKey().then((shortenerApiKey) => ({ shortenerApiKey }));
  }

  public getShortenerConfig(): Promise<NoteShareShortenerConfig | undefined> {
    return this.enqueue(async () => {
      if (!this.settings.shortenerBaseUrl || !this.settings.encryptedShortenerApiKey) return undefined;
      return {
        baseUrl: this.settings.shortenerBaseUrl,
        apiKey: this.unprotectApiKey(this.settings.encryptedShortenerApiKey),
      };
    });
  }

  public async flush(): Promise<void> {
    await this.operationQueue;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private hasSecureCredentialStorage(): boolean {
    try {
      return this.options.credentialProtector.isEncryptionAvailable()
        && this.options.credentialProtector.getSelectedStorageBackend?.() !== 'basic_text';
    } catch {
      return false;
    }
  }

  private protectApiKey(apiKey: string): string {
    if (!this.hasSecureCredentialStorage()) {
      throw new Error('Secure credential storage is unavailable for the Note share shortener API key.');
    }
    try {
      const protectedApiKey = this.options.credentialProtector.encryptString(apiKey);
      if (!Buffer.isBuffer(protectedApiKey) || protectedApiKey.length === 0) throw new Error('empty API key');
      return protectedApiKey.toString('base64');
    } catch {
      throw new Error('The Note share shortener API key could not be protected.');
    }
  }

  private unprotectApiKey(encryptedApiKey: string): string {
    if (!this.hasSecureCredentialStorage()) {
      throw new Error('The Note share shortener API key is unavailable. Save it again.');
    }
    try {
      const apiKey = this.options.credentialProtector.decryptString(Buffer.from(encryptedApiKey, 'base64'));
      if (!normalizeShortenerApiKey(apiKey)) throw new Error('empty API key');
      return apiKey;
    } catch {
      throw new Error('The Note share shortener API key is unavailable. Save it again.');
    }
  }

  private async persist(value: PersistedNoteShareSettings): Promise<void> {
    const directory = path.dirname(this.options.filePath);
    const temporaryPath = `${this.options.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    try {
      await fs.mkdir(directory, { recursive: true });
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, this.options.filePath);
      await fs.chmod(this.options.filePath, 0o600).catch(() => undefined);
      await syncDirectory(directory);
    } catch {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw new Error('Note share settings could not be saved.');
    }
  }
}
