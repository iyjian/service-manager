import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

export const LLM_SETTINGS_SCHEMA_VERSION = 1 as const;

const MAX_LLM_SETTINGS_BYTES = 128 * 1024;
const MAX_LLM_ENDPOINT_CHARACTERS = 4_096;
const MAX_LLM_MODEL_ID_CHARACTERS = 512;
const MAX_LLM_TOKEN_CHARACTERS = 16 * 1024;
const MAX_PROTECTED_TOKEN_CHARACTERS = 96 * 1024;

export interface LlmCredentialProtector {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export interface LlmSettingsView {
  endpoint: string;
  selectedModel: string;
  hasToken: boolean;
}

export interface LlmSettingsDraft {
  endpoint: string;
  selectedModel: string;
  /** Missing or empty preserves the current token. */
  token?: string;
  /** Token removal must always be explicit. */
  clearToken?: boolean;
}

export interface NormalizedLlmSettingsDraft {
  endpoint: string;
  selectedModel: string;
  token?: string;
  clearToken: boolean;
}

export interface LlmSettingsStoreOptions {
  filePath: string;
  credentialProtector: LlmCredentialProtector;
}

interface PersistedLlmSettings {
  schemaVersion: typeof LLM_SETTINGS_SCHEMA_VERSION;
  endpoint: string;
  selectedModel: string;
  encryptedToken?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function defaultSettings(): PersistedLlmSettings {
  return {
    schemaVersion: LLM_SETTINGS_SCHEMA_VERSION,
    endpoint: '',
    selectedModel: '',
  };
}

/** Normalize an OpenAI-compatible API base without inventing a `/v1` path. */
export function normalizeLlmEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The LLM endpoint is invalid.');
  const input = value.trim();
  if (input.length === 0) return '';
  if (input.length > MAX_LLM_ENDPOINT_CHARACTERS || input.includes('?') || input.includes('#')) {
    throw new Error('The LLM endpoint is invalid.');
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('The LLM endpoint is invalid.');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('The LLM endpoint must be an HTTP(S) API base without credentials, a query, or a fragment.');
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  const normalized = `${parsed.protocol}//${parsed.host}${pathname === '' ? '' : pathname}`;
  if (normalized.length > MAX_LLM_ENDPOINT_CHARACTERS) {
    throw new Error('The LLM endpoint is invalid.');
  }
  return normalized;
}

export function normalizeLlmModelId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The selected LLM model is invalid.');
  const modelId = value.trim();
  if (modelId.length > MAX_LLM_MODEL_ID_CHARACTERS || /[\u0000-\u001f\u007f]/.test(modelId)) {
    throw new Error('The selected LLM model is invalid.');
  }
  return modelId;
}

function normalizeToken(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (
    typeof value !== 'string'
    || value.length > MAX_LLM_TOKEN_CHARACTERS
    || /[\u0000\r\n]/.test(value)
  ) {
    throw new Error('The LLM token is invalid.');
  }
  return value;
}

export function normalizeLlmSettingsDraft(value: unknown): NormalizedLlmSettingsDraft {
  if (!isRecord(value) || !hasOnlyKeys(value, ['endpoint', 'selectedModel', 'token', 'clearToken'])) {
    throw new Error('The LLM settings are invalid.');
  }
  if (value.clearToken !== undefined && typeof value.clearToken !== 'boolean') {
    throw new Error('The LLM settings are invalid.');
  }
  const token = normalizeToken(value.token);
  const clearToken = value.clearToken === true;
  if (token !== undefined && clearToken) {
    throw new Error('The LLM token cannot be replaced and cleared at the same time.');
  }
  return {
    endpoint: normalizeLlmEndpoint(value.endpoint),
    selectedModel: normalizeLlmModelId(value.selectedModel),
    ...(token === undefined ? {} : { token }),
    clearToken,
  };
}

function strictProtectedToken(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PROTECTED_TOKEN_CHARACTERS
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('LLM settings are invalid.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new Error('LLM settings are invalid.');
  }
  return value;
}

function parsePersistedSettings(value: unknown): PersistedLlmSettings {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'endpoint', 'selectedModel', 'encryptedToken'])
    || value.schemaVersion !== LLM_SETTINGS_SCHEMA_VERSION
  ) {
    throw new Error('LLM settings are invalid.');
  }
  const endpoint = normalizeLlmEndpoint(value.endpoint);
  const selectedModel = normalizeLlmModelId(value.selectedModel);
  if (endpoint !== value.endpoint || selectedModel !== value.selectedModel) {
    throw new Error('LLM settings are invalid.');
  }
  const encryptedToken = strictProtectedToken(value.encryptedToken);
  return {
    schemaVersion: LLM_SETTINGS_SCHEMA_VERSION,
    endpoint,
    selectedModel,
    ...(encryptedToken === undefined ? {} : { encryptedToken }),
  };
}

function settingsView(value: PersistedLlmSettings): LlmSettingsView {
  return {
    endpoint: value.endpoint,
    selectedModel: value.selectedModel,
    hasToken: Boolean(value.encryptedToken),
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

export class LlmSettingsStore {
  private settings = defaultSettings();
  private hasPersistedSettings = false;
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly options: LlmSettingsStoreOptions) {}

  public load(): Promise<void> {
    return this.enqueue(async () => {
      try {
        const metadata = await fs.lstat(this.options.filePath);
        if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_LLM_SETTINGS_BYTES) {
          throw new Error('LLM settings are invalid.');
        }
        const contents = await fs.readFile(this.options.filePath, 'utf8');
        this.settings = parsePersistedSettings(JSON.parse(contents) as unknown);
        this.hasPersistedSettings = true;
      } catch {
        // LLM integration is optional. Missing, damaged, or unsupported settings
        // safely resolve to an empty form that the next valid Save can repair.
        this.settings = defaultSettings();
        this.hasPersistedSettings = false;
      }
    });
  }

  public get(): LlmSettingsView {
    return settingsView(this.settings);
  }

  public save(value: unknown): Promise<LlmSettingsView> {
    const draft = normalizeLlmSettingsDraft(value);
    return this.enqueue(async () => {
      let encryptedToken = this.settings.encryptedToken;
      if (draft.clearToken) {
        encryptedToken = undefined;
      } else if (draft.token !== undefined) {
        encryptedToken = this.protectToken(draft.token);
      }

      const next: PersistedLlmSettings = {
        schemaVersion: LLM_SETTINGS_SCHEMA_VERSION,
        endpoint: draft.endpoint,
        selectedModel: draft.selectedModel,
        ...(encryptedToken === undefined ? {} : { encryptedToken }),
      };
      if (!this.hasPersistedSettings || JSON.stringify(next) !== JSON.stringify(this.settings)) {
        await this.persist(next);
        this.settings = next;
        this.hasPersistedSettings = true;
      }
      return settingsView(this.settings);
    });
  }

  /** Dedicated secret-bearing read; ordinary `get` never returns the token. */
  public revealToken(): Promise<string> {
    return this.enqueue(async () => {
      const encryptedToken = this.settings.encryptedToken;
      if (!encryptedToken || !this.hasSecureCredentialStorage()) {
        throw new Error('The LLM token is unavailable. Save it again.');
      }
      try {
        const token = this.options.credentialProtector.decryptString(Buffer.from(encryptedToken, 'base64'));
        if (!normalizeToken(token)) throw new Error('empty token');
        return token;
      } catch {
        throw new Error('The LLM token is unavailable. Save it again.');
      }
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

  private protectToken(token: string): string {
    if (!this.hasSecureCredentialStorage()) {
      throw new Error('Secure credential storage is unavailable for the LLM token.');
    }
    try {
      const protectedToken = this.options.credentialProtector.encryptString(token);
      if (!Buffer.isBuffer(protectedToken) || protectedToken.length === 0) throw new Error('empty token');
      return protectedToken.toString('base64');
    } catch {
      throw new Error('The LLM token could not be protected.');
    }
  }

  private async persist(value: PersistedLlmSettings): Promise<void> {
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
      throw new Error('LLM settings could not be saved.');
    }
  }
}
