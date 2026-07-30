import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type {
  SqlAuthState,
  SqlDatabaseSchema,
  SqlEnvironment,
  SqlExecutionResult,
  SqlJsonValue,
  SqlLoginInput,
  SqlQueryDraft,
  SqlQueryRecord,
  SqlUserView,
} from '../shared/types';
import { SqlCredentialsStore, type SqlReloginCredential } from './sqlCredentialsStore';

export const SQL_API_BASE_URLS: Readonly<Record<SqlEnvironment, string>> = Object.freeze({
  production: 'https://sd-pc.tiusolution.com/api',
  development: 'https://sd-pc.dev.tiusolution.com/api',
});

export const SQL_REQUEST_TIMEOUT_MS = 120_000;
export const SQL_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const SQL_MAX_STATEMENT_CHARACTERS = 1_000_000;
export const SQL_SCHEMA_TABLE_BATCH_SIZE = 20;

const MAX_USERNAME_CHARACTERS = 512;
const MAX_PASSWORD_CHARACTERS = 16 * 1024;
const MAX_QUERY_NAME_CHARACTERS = 300;
const MAX_SEARCH_CHARACTERS = 300;
const MAX_RESULT_CHARACTERS = 16 * 1024 * 1024;
const MAX_ERROR_CHARACTERS = 600;
const MAX_SCHEMA_TABLES = 1_000;
const MAX_SCHEMA_COLUMNS = 50_000;
const MAX_SCHEMA_COLUMNS_PER_BATCH = 5_000;
const MAX_SCHEMA_IDENTIFIER_CHARACTERS = 256;
const MAX_SCHEMA_DATA_TYPE_CHARACTERS = 256;
const SQL_SCHEMA_CACHE_TTL_MS = 5 * 60 * 1_000;

const SQL_SCHEMA_TABLES_STATEMENT = `select table_name as tableName
from information_schema.tables
where table_schema = database()
order by table_name;`;

interface SqlSession {
  token: string;
  user: SqlUserView;
}

interface SqlSchemaCacheEntry {
  session: SqlSession;
  schema: SqlDatabaseSchema;
  expiresAt: number;
}

interface SqlRuntimeOptions {
  credentialsStore: SqlCredentialsStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface SqlApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: URLSearchParams;
  body?: SqlJsonValue;
  token?: string;
  purpose?: 'login';
}

class SqlApiError extends Error {
  public constructor(message: string, public readonly unauthorized = false) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

export function normalizeSqlEnvironment(value: unknown): SqlEnvironment {
  if (value !== 'production' && value !== 'development') {
    throw new Error('The SQL environment is invalid.');
  }
  return value;
}

function normalizeSqlId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error('The saved query ID is invalid.');
  }
  return value;
}

function normalizeUserName(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_USERNAME_CHARACTERS
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('Enter a valid username.');
  }
  return value;
}

function normalizePassword(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PASSWORD_CHARACTERS
    || /[\u0000\r\n]/.test(value)
  ) {
    throw new Error('Enter a valid password.');
  }
  return value;
}

function loginCredential(input: SqlLoginInput): SqlReloginCredential {
  const password = normalizePassword(input.password);
  return {
    userName: normalizeUserName(input.userName),
    passwd: hashSqlPassword(password),
  };
}

/** Matches jcjy-components' `Md5.appendAsciiStr`, including byte truncation. */
export function hashSqlPassword(password: string): string {
  return createHash('md5').update(Buffer.from(password, 'latin1')).digest('hex');
}

function isJsonValue(value: unknown, depth = 0): value is SqlJsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, item]) =>
    key.length <= 4_096 && isJsonValue(item, depth + 1)
  );
}

function normalizeSqlQueryDraft(value: unknown): SqlQueryDraft {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'name',
    'sql',
    'config',
    'lastQueryResult',
    'lastQueryDate',
  ])) {
    throw new Error('The saved query is invalid.');
  }
  if (
    typeof value.name !== 'string'
    || typeof value.sql !== 'string'
    || value.sql.trim().length === 0
    || value.sql.length > SQL_MAX_STATEMENT_CHARACTERS
    || (value.config !== undefined && !isJsonValue(value.config))
    || (value.lastQueryResult !== undefined
      && (typeof value.lastQueryResult !== 'string' || value.lastQueryResult.length > MAX_RESULT_CHARACTERS))
    || (value.lastQueryDate !== undefined
      && (typeof value.lastQueryDate !== 'string'
        || value.lastQueryDate.length > 64
        || !Number.isFinite(Date.parse(value.lastQueryDate))))
  ) {
    throw new Error('The saved query is invalid.');
  }
  return {
    name: normalizeSqlQueryName(value.name),
    sql: value.sql,
    ...(value.config === undefined ? {} : { config: value.config }),
    ...(value.lastQueryResult === undefined ? {} : { lastQueryResult: value.lastQueryResult }),
    ...(value.lastQueryDate === undefined ? {} : { lastQueryDate: value.lastQueryDate }),
  };
}

function normalizeSqlQueryName(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.trim().length > MAX_QUERY_NAME_CHARACTERS
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('Enter a valid query name.');
  }
  return value.trim();
}

function normalizeStatement(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > SQL_MAX_STATEMENT_CHARACTERS
    || value.includes('\u0000')
  ) {
    throw new Error('Select a single SQL statement to run.');
  }
  return value.trim();
}

function normalizeSearch(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > MAX_SEARCH_CHARACTERS || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('The saved query search is invalid.');
  }
  return value.trim();
}

function safeApiMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const text = value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_CHARACTERS);
  return text || fallback;
}

function normalizeSchemaText(
  value: unknown,
  maximumCharacters: number,
): string | undefined {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximumCharacters
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return undefined;
  }
  return value;
}

function escapeSqlStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export function buildSqlSchemaColumnsStatement(tableNames: readonly string[]): string {
  if (
    tableNames.length === 0
    || tableNames.length > SQL_SCHEMA_TABLE_BATCH_SIZE
    || tableNames.some((name) => !normalizeSchemaText(name, MAX_SCHEMA_IDENTIFIER_CHARACTERS))
  ) {
    throw new Error('The SQL schema table batch is invalid.');
  }
  const names = tableNames.map(escapeSqlStringLiteral).join(', ');
  return `select table_name as tableName,
column_name as columnName,
column_type as dataType
from information_schema.columns
where table_schema = database()
and table_name in (${names})
order by table_name, ordinal_position;`;
}

function cloneSqlDatabaseSchema(schema: SqlDatabaseSchema): SqlDatabaseSchema {
  return {
    environment: schema.environment,
    tables: schema.tables.map((table) => ({
      name: table.name,
      columns: table.columns.map((column) => ({ ...column })),
    })),
  };
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > SQL_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new SqlApiError('The SQL response is too large.');
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const cancelReader = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > SQL_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SqlApiError('The SQL response is too large.');
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
  }
  return Buffer.concat(chunks, total);
}

function parseQueryRecord(value: unknown): SqlQueryRecord {
  if (!isRecord(value)) throw new SqlApiError('The saved query response is invalid.');
  const id = normalizeSqlId(value.id);
  if (
    typeof value.name !== 'string'
    || value.name.length === 0
    || value.name.length > MAX_QUERY_NAME_CHARACTERS
    || typeof value.sql !== 'string'
    || value.sql.length > SQL_MAX_STATEMENT_CHARACTERS
    || (value.config !== undefined && !isJsonValue(value.config))
    || (value.lastQueryResult !== undefined && value.lastQueryResult !== null
      && (typeof value.lastQueryResult !== 'string' || value.lastQueryResult.length > MAX_RESULT_CHARACTERS))
    || (value.lastQueryDate !== undefined && value.lastQueryDate !== null && typeof value.lastQueryDate !== 'string')
    || (value.creatorId !== undefined && typeof value.creatorId !== 'number')
    || (value.creator !== undefined && value.creator !== null && !isRecord(value.creator))
  ) {
    throw new SqlApiError('The saved query response is invalid.');
  }
  const creator = isRecord(value.creator) ? {
    ...(typeof value.creator.id === 'number' ? { id: value.creator.id } : {}),
    ...(typeof value.creator.name === 'string' || value.creator.name === null ? { name: value.creator.name } : {}),
    ...(typeof value.creator.nickname === 'string' || value.creator.nickname === null
      ? { nickname: value.creator.nickname }
      : {}),
    ...(typeof value.creator.username === 'string' || value.creator.username === null
      ? { username: value.creator.username }
      : {}),
    ...(typeof value.creator.userName === 'string' || value.creator.userName === null
      ? { userName: value.creator.userName }
      : {}),
  } : value.creator;
  return {
    id,
    ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
    name: value.name,
    sql: value.sql,
    ...(value.config === undefined ? {} : { config: value.config }),
    ...(value.lastQueryResult === undefined ? {} : { lastQueryResult: value.lastQueryResult }),
    ...(value.lastQueryDate === undefined ? {} : { lastQueryDate: value.lastQueryDate }),
    ...(typeof value.creatorId === 'number' ? { creatorId: value.creatorId } : {}),
    ...(creator === undefined ? {} : { creator }),
  };
}

function recordCreatorId(record: SqlQueryRecord): number | undefined {
  return record.creator?.id ?? record.creatorId;
}

function parseUser(value: unknown): SqlUserView {
  if (!isRecord(value) || typeof value.id !== 'number' || !Number.isInteger(value.id) || value.id <= 0) {
    throw new SqlApiError('The signed-in user response is invalid.');
  }
  const userName = typeof value.userName === 'string'
    ? value.userName
    : typeof value.username === 'string'
      ? value.username
      : '';
  const name = typeof value.name === 'string' && value.name.trim()
    ? value.name
    : userName;
  if (!userName || userName.length > MAX_USERNAME_CHARACTERS || name.length > MAX_USERNAME_CHARACTERS) {
    throw new SqlApiError('The signed-in user response is invalid.');
  }
  return { id: value.id, name, userName };
}

export class SqlRuntime {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sessions = new Map<SqlEnvironment, SqlSession>();
  private readonly loginFlights = new Map<SqlEnvironment, Promise<SqlSession>>();
  private readonly schemaCache = new Map<SqlEnvironment, SqlSchemaCacheEntry>();
  private readonly schemaFlights = new Map<SqlEnvironment, Promise<SqlDatabaseSchema>>();
  private readonly schemaGenerations = new Map<SqlEnvironment, number>();
  private readonly activeRequests = new Set<AbortController>();

  public constructor(private readonly options: SqlRuntimeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? SQL_REQUEST_TIMEOUT_MS;
  }

  public async getAuthState(environmentValue: unknown): Promise<SqlAuthState> {
    const environment = normalizeSqlEnvironment(environmentValue);
    let session = this.sessions.get(environment);
    let message: string | undefined;
    if (!session && this.options.credentialsStore.has(environment)) {
      try {
        session = await this.loginSaved(environment);
      } catch {
        message = 'Automatic sign-in failed. Sign in again.';
      }
    }
    return this.authState(environment, session, message);
  }

  public async login(value: unknown): Promise<SqlAuthState> {
    if (!isRecord(value) || !hasOnlyKeys(value, ['environment', 'userName', 'password'])) {
      throw new Error('The SQL login request is invalid.');
    }
    const input = value as unknown as SqlLoginInput;
    const environment = normalizeSqlEnvironment(input.environment);
    this.clearSchemaState(environment);
    this.sessions.delete(environment);
    const existing = this.loginFlights.get(environment);
    if (existing) await existing.catch(() => undefined);
    const session = await this.loginWithCredential(environment, loginCredential(input), true);
    return this.authState(environment, session);
  }

  public async logout(environmentValue: unknown): Promise<SqlAuthState> {
    const environment = normalizeSqlEnvironment(environmentValue);
    this.clearSchemaState(environment);
    this.sessions.delete(environment);
    await this.options.credentialsStore.remove(environment);
    return this.authState(environment);
  }

  public async listQueries(environmentValue: unknown, searchValue?: unknown): Promise<SqlQueryRecord[]> {
    const environment = normalizeSqlEnvironment(environmentValue);
    const search = normalizeSearch(searchValue);
    return this.withAuthentication(environment, async (session) => {
      const query = new URLSearchParams();
      query.set('skipPaging', 'true');
      query.set('sort[0][key]', 'name');
      query.set('sort[0][order]', 'desc');
      query.set('creatorId', String(session.user.id));
      if (search) query.set('search', search);
      const result = await this.request(environment, '/sqlQuery', { query, token: session.token });
      if (!isRecord(result) || !Array.isArray(result.rows)) {
        throw new SqlApiError('The saved query response is invalid.');
      }
      return result.rows
        .map(parseQueryRecord)
        .filter((record) => recordCreatorId(record) === session.user.id);
    });
  }

  public async getQuery(environmentValue: unknown, idValue: unknown): Promise<SqlQueryRecord> {
    const environment = normalizeSqlEnvironment(environmentValue);
    const id = normalizeSqlId(idValue);
    return this.withAuthentication(environment, async (session) => {
      const record = parseQueryRecord(await this.request(environment, `/sqlQuery/${id}`, {
        token: session.token,
      }));
      this.assertRecordOwner(record, session.user.id);
      return record;
    });
  }

  public async createQuery(environmentValue: unknown, draftValue: unknown): Promise<SqlQueryRecord> {
    const environment = normalizeSqlEnvironment(environmentValue);
    const draft = normalizeSqlQueryDraft(draftValue);
    return this.withAuthentication(environment, async (session) => {
      const created = parseQueryRecord(await this.request(environment, '/sqlQuery', {
        method: 'POST',
        token: session.token,
        body: draft as unknown as SqlJsonValue,
      }));
      this.assertRecordOwner(created, session.user.id);
      return created;
    });
  }

  public async updateQuery(environmentValue: unknown, idValue: unknown, draftValue: unknown): Promise<SqlQueryRecord> {
    const environment = normalizeSqlEnvironment(environmentValue);
    const id = normalizeSqlId(idValue);
    const draft = normalizeSqlQueryDraft(draftValue);
    return this.withAuthentication(environment, async (session) => {
      const existing = parseQueryRecord(await this.request(environment, `/sqlQuery/${id}`, {
        token: session.token,
      }));
      this.assertRecordOwner(existing, session.user.id);
      await this.request(environment, `/sqlQuery/${id}`, {
        method: 'PATCH',
        token: session.token,
        body: draft as unknown as SqlJsonValue,
      });
      const updated = parseQueryRecord(await this.request(environment, `/sqlQuery/${id}`, {
        token: session.token,
      }));
      this.assertRecordOwner(updated, session.user.id);
      return updated;
    });
  }

  public async renameQuery(environmentValue: unknown, idValue: unknown, nameValue: unknown): Promise<SqlQueryRecord> {
    const environment = normalizeSqlEnvironment(environmentValue);
    const id = normalizeSqlId(idValue);
    const name = normalizeSqlQueryName(nameValue);
    return this.withAuthentication(environment, async (session) => {
      const existing = parseQueryRecord(await this.request(environment, `/sqlQuery/${id}`, {
        token: session.token,
      }));
      this.assertRecordOwner(existing, session.user.id);
      await this.request(environment, `/sqlQuery/${id}`, {
        method: 'PATCH',
        token: session.token,
        body: { name },
      });
      const updated = parseQueryRecord(await this.request(environment, `/sqlQuery/${id}`, {
        token: session.token,
      }));
      this.assertRecordOwner(updated, session.user.id);
      return updated;
    });
  }

  public async deleteQuery(environmentValue: unknown, idValue: unknown): Promise<void> {
    const environment = normalizeSqlEnvironment(environmentValue);
    const id = normalizeSqlId(idValue);
    await this.withAuthentication(environment, async (session) => {
      const existing = parseQueryRecord(await this.request(environment, `/sqlQuery/${id}`, {
        token: session.token,
      }));
      this.assertRecordOwner(existing, session.user.id);
      await this.request(environment, `/sqlQuery/${id}`, { method: 'DELETE', token: session.token });
    });
  }

  public async execute(environmentValue: unknown, statementValue: unknown): Promise<SqlExecutionResult> {
    const environment = normalizeSqlEnvironment(environmentValue);
    const statement = normalizeStatement(statementValue);
    const startedAt = Date.now();
    return this.withAuthentication(environment, async (session) => {
      const value = await this.executeProfileStatement(environment, session, statement);
      if (value !== undefined && !isJsonValue(value)) {
        throw new SqlApiError('The SQL response is invalid.');
      }
      return {
        value,
        executedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    });
  }

  public async getSchema(environmentValue: unknown): Promise<SqlDatabaseSchema> {
    const environment = normalizeSqlEnvironment(environmentValue);
    const existing = this.schemaFlights.get(environment);
    if (existing) return cloneSqlDatabaseSchema(await existing);

    const generation = this.schemaGenerations.get(environment) ?? 0;
    const flight = this.withAuthentication(environment, async (session) => {
      const cached = this.schemaCache.get(environment);
      if (cached && cached.session === session && cached.expiresAt > Date.now()) {
        return cached.schema;
      }
      const schema = await this.fetchSchema(environment, session);
      if (
        (this.schemaGenerations.get(environment) ?? 0) === generation
        && this.sessions.get(environment) === session
      ) {
        this.schemaCache.set(environment, {
          session,
          schema,
          expiresAt: Date.now() + SQL_SCHEMA_CACHE_TTL_MS,
        });
      }
      return schema;
    });
    this.schemaFlights.set(environment, flight);
    void flight.finally(() => {
      if (this.schemaFlights.get(environment) === flight) {
        this.schemaFlights.delete(environment);
      }
    }).catch(() => undefined);
    return cloneSqlDatabaseSchema(await flight);
  }

  public async shutdown(): Promise<void> {
    for (const controller of this.activeRequests) controller.abort();
    await Promise.allSettled([...this.loginFlights.values()]);
    await this.options.credentialsStore.flush();
    this.schemaCache.clear();
    this.schemaFlights.clear();
    this.sessions.clear();
  }

  private clearSchemaState(environment: SqlEnvironment): void {
    this.schemaGenerations.set(environment, (this.schemaGenerations.get(environment) ?? 0) + 1);
    this.schemaCache.delete(environment);
    this.schemaFlights.delete(environment);
  }

  private async fetchSchema(
    environment: SqlEnvironment,
    session: SqlSession,
  ): Promise<SqlDatabaseSchema> {
    const tableValue = await this.executeProfileStatement(
      environment,
      session,
      SQL_SCHEMA_TABLES_STATEMENT,
    );
    if (!Array.isArray(tableValue) || tableValue.length > MAX_SCHEMA_TABLES) {
      throw new SqlApiError('The SQL schema response is invalid.');
    }
    const tables = new Map<string, SqlDatabaseSchema['tables'][number]>();
    for (const row of tableValue) {
      if (!isRecord(row)) throw new SqlApiError('The SQL schema response is invalid.');
      const tableName = normalizeSchemaText(row.tableName, MAX_SCHEMA_IDENTIFIER_CHARACTERS);
      if (!tableName || tables.has(tableName)) continue;
      tables.set(tableName, { name: tableName, columns: [] });
    }

    const tableNames = [...tables.keys()];
    let totalColumns = 0;
    for (let index = 0; index < tableNames.length; index += SQL_SCHEMA_TABLE_BATCH_SIZE) {
      const batch = tableNames.slice(index, index + SQL_SCHEMA_TABLE_BATCH_SIZE);
      const columnValue = await this.executeProfileStatement(
        environment,
        session,
        buildSqlSchemaColumnsStatement(batch),
      );
      if (!Array.isArray(columnValue) || columnValue.length > MAX_SCHEMA_COLUMNS_PER_BATCH) {
        throw new SqlApiError('The SQL schema response is invalid.');
      }
      totalColumns += columnValue.length;
      if (totalColumns > MAX_SCHEMA_COLUMNS) {
        throw new SqlApiError('The SQL schema response is too large.');
      }
      for (const row of columnValue) {
        if (!isRecord(row)) throw new SqlApiError('The SQL schema response is invalid.');
        const tableName = normalizeSchemaText(row.tableName, MAX_SCHEMA_IDENTIFIER_CHARACTERS);
        const columnName = normalizeSchemaText(row.columnName, MAX_SCHEMA_IDENTIFIER_CHARACTERS);
        const table = tableName ? tables.get(tableName) : undefined;
        if (!table || !columnName || table.columns.some((column) => column.name === columnName)) continue;
        const dataType = normalizeSchemaText(row.dataType, MAX_SCHEMA_DATA_TYPE_CHARACTERS);
        table.columns.push({
          name: columnName,
          ...(dataType ? { dataType } : {}),
        });
      }
    }
    return {
      environment,
      tables: [...tables.values()],
    };
  }

  private executeProfileStatement(
    environment: SqlEnvironment,
    session: SqlSession,
    statement: string,
  ): Promise<unknown> {
    return this.request(environment, '/system/profile', {
      method: 'POST',
      token: session.token,
      body: { statement },
    });
  }

  private authState(
    environment: SqlEnvironment,
    session?: SqlSession,
    message?: string,
  ): SqlAuthState {
    return {
      environment,
      status: session ? 'signed-in' : 'signed-out',
      hasSavedCredentials: this.options.credentialsStore.has(environment),
      ...(session ? { user: session.user } : {}),
      ...(message ? { message } : {}),
    };
  }

  private assertRecordOwner(record: SqlQueryRecord, userId: number): void {
    if (recordCreatorId(record) !== userId) {
      throw new Error('This saved query is not available for the signed-in user.');
    }
  }

  private async withAuthentication<T>(
    environment: SqlEnvironment,
    operation: (session: SqlSession) => Promise<T>,
  ): Promise<T> {
    let session = await this.ensureSession(environment);
    try {
      return await operation(session);
    } catch (error) {
      if (!(error instanceof SqlApiError) || !error.unauthorized) throw error;
      this.sessions.delete(environment);
      try {
        session = await this.loginSaved(environment);
      } catch {
        throw new Error('Your SQL session expired and automatic sign-in failed. Sign in again.');
      }
      try {
        return await operation(session);
      } catch (retryError) {
        if (retryError instanceof SqlApiError && retryError.unauthorized) {
          this.sessions.delete(environment);
          throw new Error('Your SQL session expired. Sign in again.');
        }
        throw retryError;
      }
    }
  }

  private async ensureSession(environment: SqlEnvironment): Promise<SqlSession> {
    const session = this.sessions.get(environment);
    if (session) return session;
    if (!this.options.credentialsStore.has(environment)) {
      throw new Error(`Sign in to ${environment === 'production' ? 'Production' : 'Development'} first.`);
    }
    try {
      return await this.loginSaved(environment);
    } catch {
      throw new Error('Automatic sign-in failed. Sign in again.');
    }
  }

  private async loginSaved(environment: SqlEnvironment): Promise<SqlSession> {
    const credential = await this.options.credentialsStore.reveal(environment);
    return this.loginWithCredential(environment, credential, false);
  }

  private loginWithCredential(
    environment: SqlEnvironment,
    credential: SqlReloginCredential,
    persist: boolean,
  ): Promise<SqlSession> {
    const existing = this.loginFlights.get(environment);
    if (existing) return existing;
    const flight = (async () => {
      const loginResult = await this.request(environment, '/auth/users/login', {
        method: 'POST',
        body: { userName: credential.userName, passwd: credential.passwd },
        purpose: 'login',
      });
      if (!isRecord(loginResult) || typeof loginResult.token !== 'string'
        || loginResult.token.length === 0 || loginResult.token.length > 64 * 1024
        || /[\u0000\r\n]/.test(loginResult.token)) {
        throw new SqlApiError('The SQL login response is invalid.');
      }
      const token = loginResult.token;
      const user = parseUser(await this.request(environment, '/user/detail', {
        token,
        purpose: 'login',
      }));
      const session = { token, user };
      if (persist) await this.options.credentialsStore.save(environment, credential);
      this.sessions.set(environment, session);
      return session;
    })();
    this.loginFlights.set(environment, flight);
    void flight.finally(() => {
      if (this.loginFlights.get(environment) === flight) this.loginFlights.delete(environment);
    }).catch(() => undefined);
    return flight;
  }

  private async request(
    environment: SqlEnvironment,
    requestPath: string,
    options: SqlApiRequestOptions = {},
  ): Promise<unknown> {
    const baseUrl = SQL_API_BASE_URLS[environment];
    const url = new URL(`${baseUrl}${requestPath}`);
    const loginRequest = options.purpose === 'login';
    if (options.query) url.search = options.query.toString();
    const controller = new AbortController();
    this.activeRequests.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        deviceId: '',
        version: '',
      };
      if (options.token) headers.token = options.token;
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: options.method ?? 'GET',
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch {
        if (timedOut) throw new SqlApiError(loginRequest ? 'Login timed out.' : 'The SQL request timed out.');
        if (controller.signal.aborted) {
          throw new SqlApiError(loginRequest ? 'Login was cancelled.' : 'The SQL request was cancelled.');
        }
        throw new SqlApiError(loginRequest ? 'Login failed.' : 'The SQL request failed.');
      }
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        if (loginRequest) throw new SqlApiError('Login failed (401).');
        throw new SqlApiError('The SQL session expired.', true);
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined);
        throw new SqlApiError(
          loginRequest
            ? `Login failed (${response.status}).`
            : `The SQL request failed (${response.status}).`,
        );
      }
      const rawBody = await readBoundedBody(response, controller.signal);
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)) as unknown;
      } catch {
        throw new SqlApiError('The SQL response is invalid.');
      }
      if (!isRecord(payload)
        || !Object.prototype.hasOwnProperty.call(payload, 'err')
        || (!Object.prototype.hasOwnProperty.call(payload, 'data')
          && !Object.prototype.hasOwnProperty.call(payload, 'errMsg'))) {
        throw new SqlApiError('The SQL response is invalid.');
      }
      if (payload.err) {
        const unauthorized = payload.err === 401 || payload.err === '401';
        if (loginRequest) {
          const detail = safeApiMessage(payload.errMsg, '');
          throw new SqlApiError(detail ? `Login failed: ${detail}` : 'Login failed.');
        }
        throw new SqlApiError(
          safeApiMessage(payload.errMsg, unauthorized ? 'The SQL session expired.' : 'The SQL request failed.'),
          unauthorized,
        );
      }
      return payload.data;
    } finally {
      clearTimeout(timeout);
      this.activeRequests.delete(controller);
    }
  }
}
