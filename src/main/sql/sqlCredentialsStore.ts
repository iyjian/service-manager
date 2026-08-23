import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { SqlEnvironment } from '../../shared/types';

export const SQL_CREDENTIALS_SCHEMA_VERSION = 1 as const;

const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_PROTECTED_CREDENTIAL_CHARACTERS = 192 * 1024;
const MAX_USERNAME_CHARACTERS = 512;
const BASIC_TEXT_CREDENTIAL_PREFIX = 'service-manager-sql-basic-text-v1:';

export interface SqlCredentialProtector {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export interface SqlReloginCredential {
  userName: string;
  /** MD5 credential expected by the existing SD login API. */
  passwd: string;
}

export interface SqlCredentialsStoreOptions {
  filePath: string;
  credentialProtector: SqlCredentialProtector;
  allowBasicTextFallback?: boolean;
}

interface PersistedCredential {
  encryptedCredential: string;
}

interface PersistedSqlCredentials {
  schemaVersion: typeof SQL_CREDENTIALS_SCHEMA_VERSION;
  environments: Partial<Record<SqlEnvironment, PersistedCredential>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function emptySettings(): PersistedSqlCredentials {
  return {
    schemaVersion: SQL_CREDENTIALS_SCHEMA_VERSION,
    environments: {},
  };
}

function normalizeCredential(value: unknown): SqlReloginCredential {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['userName', 'passwd'])
    || typeof value.userName !== 'string'
    || value.userName.length === 0
    || value.userName.length > MAX_USERNAME_CHARACTERS
    || /[\u0000-\u001f\u007f]/.test(value.userName)
    || typeof value.passwd !== 'string'
    || !/^[a-f0-9]{32}$/.test(value.passwd)
  ) {
    throw new Error('The saved SQL login is invalid.');
  }
  return { userName: value.userName, passwd: value.passwd };
}

function strictProtectedCredential(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PROTECTED_CREDENTIAL_CHARACTERS
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('SQL login settings are invalid.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new Error('SQL login settings are invalid.');
  }
  return value;
}

function parsePersistedSettings(value: unknown): PersistedSqlCredentials {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'environments'])
    || value.schemaVersion !== SQL_CREDENTIALS_SCHEMA_VERSION
    || !isRecord(value.environments)
    || !hasOnlyKeys(value.environments, ['production', 'development'])
  ) {
    throw new Error('SQL login settings are invalid.');
  }

  const environments: PersistedSqlCredentials['environments'] = {};
  for (const environment of ['production', 'development'] as const) {
    const entry = value.environments[environment];
    if (entry === undefined) continue;
    if (!isRecord(entry) || !hasOnlyKeys(entry, ['encryptedCredential'])) {
      throw new Error('SQL login settings are invalid.');
    }
    environments[environment] = {
      encryptedCredential: strictProtectedCredential(entry.encryptedCredential),
    };
  }
  return { schemaVersion: SQL_CREDENTIALS_SCHEMA_VERSION, environments };
}

function protectBasicTextCredential(credential: SqlReloginCredential): string {
  return Buffer.from(`${BASIC_TEXT_CREDENTIAL_PREFIX}${JSON.stringify(credential)}`, 'utf8').toString('base64');
}

function revealBasicTextCredential(encryptedCredential: string): SqlReloginCredential | undefined {
  const plaintext = Buffer.from(encryptedCredential, 'base64').toString('utf8');
  if (!plaintext.startsWith(BASIC_TEXT_CREDENTIAL_PREFIX)) return undefined;
  return normalizeCredential(JSON.parse(plaintext.slice(BASIC_TEXT_CREDENTIAL_PREFIX.length)) as unknown);
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

export class SqlCredentialsStore {
  private settings = emptySettings();
  private hasPersistedSettings = false;
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly options: SqlCredentialsStoreOptions) {}

  public load(): Promise<void> {
    return this.enqueue(async () => {
      try {
        const metadata = await fs.lstat(this.options.filePath);
        if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_SETTINGS_BYTES) {
          throw new Error('SQL login settings are invalid.');
        }
        const contents = await fs.readFile(this.options.filePath, 'utf8');
        this.settings = parsePersistedSettings(JSON.parse(contents) as unknown);
        this.hasPersistedSettings = true;
      } catch {
        this.settings = emptySettings();
        this.hasPersistedSettings = false;
      }
    });
  }

  public has(environment: SqlEnvironment): boolean {
    return Boolean(this.settings.environments[environment]?.encryptedCredential);
  }

  public save(environment: SqlEnvironment, credentialValue: unknown): Promise<void> {
    const credential = normalizeCredential(credentialValue);
    return this.enqueue(async () => {
      const encryptedCredential = this.protectCredential(credential);
      const next: PersistedSqlCredentials = {
        schemaVersion: SQL_CREDENTIALS_SCHEMA_VERSION,
        environments: {
          ...this.settings.environments,
          [environment]: { encryptedCredential },
        },
      };
      await this.persist(next);
      this.settings = next;
      this.hasPersistedSettings = true;
    });
  }

  public reveal(environment: SqlEnvironment): Promise<SqlReloginCredential> {
    return this.enqueue(async () => {
      const encryptedCredential = this.settings.environments[environment]?.encryptedCredential;
      if (!encryptedCredential) {
        throw new Error('The saved SQL login is unavailable. Sign in again.');
      }
      try {
        const basicTextCredential = revealBasicTextCredential(encryptedCredential);
        if (basicTextCredential) return basicTextCredential;
        if (!this.hasUsableCredentialStorage()) {
          throw new Error('credential storage unavailable');
        }
        const plaintext = this.options.credentialProtector.decryptString(
          Buffer.from(encryptedCredential, 'base64'),
        );
        return normalizeCredential(JSON.parse(plaintext) as unknown);
      } catch {
        throw new Error('The saved SQL login is unavailable. Sign in again.');
      }
    });
  }

  public remove(environment: SqlEnvironment): Promise<void> {
    return this.enqueue(async () => {
      if (!this.settings.environments[environment] && this.hasPersistedSettings) return;
      const environments = { ...this.settings.environments };
      delete environments[environment];
      const next: PersistedSqlCredentials = {
        schemaVersion: SQL_CREDENTIALS_SCHEMA_VERSION,
        environments,
      };
      await this.persist(next);
      this.settings = next;
      this.hasPersistedSettings = true;
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

  private isEncryptionAvailable(): boolean {
    try {
      return this.options.credentialProtector.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private isBasicTextCredentialStorage(): boolean {
    try {
      return this.options.credentialProtector.getSelectedStorageBackend?.() === 'basic_text';
    } catch {
      return false;
    }
  }

  private canUseBasicTextFallback(): boolean {
    return this.options.allowBasicTextFallback === true || this.isBasicTextCredentialStorage();
  }

  private hasUsableCredentialStorage(): boolean {
    return this.isEncryptionAvailable() || this.canUseBasicTextFallback();
  }

  private protectCredential(credential: SqlReloginCredential): string {
    const canUseBasicTextFallback = this.canUseBasicTextFallback();
    if (this.isBasicTextCredentialStorage()) return protectBasicTextCredential(credential);
    if (!this.isEncryptionAvailable()) {
      if (canUseBasicTextFallback) return protectBasicTextCredential(credential);
      throw new Error('Secure credential storage is unavailable for SQL login.');
    }
    try {
      const protectedCredential = this.options.credentialProtector.encryptString(JSON.stringify(credential));
      if (!Buffer.isBuffer(protectedCredential) || protectedCredential.length === 0) {
        throw new Error('empty protected credential');
      }
      return protectedCredential.toString('base64');
    } catch {
      if (canUseBasicTextFallback) return protectBasicTextCredential(credential);
      throw new Error('The SQL login could not be protected.');
    }
  }

  private async persist(value: PersistedSqlCredentials): Promise<void> {
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
      throw new Error('SQL login settings could not be saved.');
    }
  }
}
