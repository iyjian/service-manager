import { promises as fs } from 'node:fs';
import path from 'node:path';

export const RUNTIME_LOG_FILE_NAME = 'runtime.jsonl';
export const RUNTIME_LOG_PREVIOUS_FILE_NAME = 'runtime.previous.jsonl';
export const RUNTIME_LOG_MAX_BYTES = 1024 * 1024;

const REDACTED_VALUE = '[redacted]';
const OMITTED_VALUE = '[omitted]';
const MAX_STRING_LENGTH = 2000;
const SENSITIVE_CONTEXT_KEY_FRAGMENTS = [
  'password',
  'passphrase',
  'privatekey',
  'token',
  'secret',
  'authorization',
  'cookie',
  'subscription',
  'command',
];

export interface RuntimeLogWriterOptions {
  maxBytes?: number;
  now?: () => Date;
}

interface RuntimeLogEntry {
  timestamp: string;
  level: 'error';
  scope: string;
  message: string;
  context?: Record<string, string | number | boolean | null>;
}

type RuntimeLogNow = Date | (() => Date);

function isSensitiveContextKey(key: string): boolean {
  const normalizedKey = key.replace(/[-_]/g, '').toLowerCase();
  return SENSITIVE_CONTEXT_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment));
}

export function sanitizeRuntimeDiagnosticString(value: string): string {
  const redacted = value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, '[redacted-private-key]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|(?:data|mailto|urn):)[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/\bCommand failed:\s*[^\r\n]+/gi, 'Command failed: [redacted-command]')
    .replace(
      /\b((?:systemd-run|systemctl|journalctl)(?:\s+[^\s:]+)?)\s+failed:\s*[^\r\n]+/gi,
      '$1 failed: [redacted-command]',
    )
    .replace(
      /(\-\-(?:[A-Za-z0-9_-]*?(?:password|passphrase|private[_-]?key|token|secret|authorization|cookie|subscription)[A-Za-z0-9_-]*))\s*(?:=|\s+)\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
      '$1=[redacted]',
    )
    .replace(
      /\b((?:[A-Za-z_][A-Za-z0-9_-]*?)?(?:password|passphrase|private[_-]?key|token|secret|authorization|cookie|subscription)[A-Za-z0-9_-]*)\s*(?:=|:)\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;]+)/gi,
      '$1=[redacted]',
    )
    .replace(
      /\b((?:[A-Za-z_][A-Za-z0-9_-]*?)?command[A-Za-z0-9_-]*)\s*(?:=|:)\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;]+)/gi,
      '$1=[redacted]',
    );

  return redacted.slice(0, MAX_STRING_LENGTH);
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeRuntimeDiagnosticString(error.message);
  }
  if (typeof error === 'string') {
    return sanitizeRuntimeDiagnosticString(error);
  }
  if (typeof error === 'number' || typeof error === 'boolean' || error === null) {
    return sanitizeRuntimeDiagnosticString(String(error));
  }
  return OMITTED_VALUE;
}

function sanitizeContext(context: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> | undefined {
  if (!context) {
    return undefined;
  }

  const safeContext: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(context)) {
    const safeKey = sanitizeRuntimeDiagnosticString(key);
    if (isSensitiveContextKey(key)) {
      safeContext[safeKey] = REDACTED_VALUE;
    } else if (typeof value === 'string') {
      safeContext[safeKey] = sanitizeRuntimeDiagnosticString(value);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      safeContext[safeKey] = value;
    } else {
      safeContext[safeKey] = OMITTED_VALUE;
    }
  }

  return Object.keys(safeContext).length > 0 ? safeContext : undefined;
}

export function createRuntimeLogEntry(
  scope: string,
  error: unknown,
  context?: Record<string, unknown>,
  now: RuntimeLogNow = () => new Date(),
): string {
  const entry: RuntimeLogEntry = {
    timestamp: (now instanceof Date ? now : now()).toISOString(),
    level: 'error',
    scope: sanitizeRuntimeDiagnosticString(scope),
    message: sanitizeError(error),
  };
  const safeContext = sanitizeContext(context);
  if (safeContext) {
    entry.context = safeContext;
  }
  return JSON.stringify(entry);
}

export class RuntimeLogWriter {
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string, options: RuntimeLogWriterOptions = {}) {
    this.maxBytes = options.maxBytes ?? RUNTIME_LOG_MAX_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  record(scope: string, error: unknown, context?: Record<string, unknown>): Promise<void> {
    const entry = createRuntimeLogEntry(scope, error, context, this.now);
    const write = this.writeQueue.then(() => this.append(`${entry}\n`));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }

  private async append(entry: string): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });

    const activePath = path.join(this.directory, RUNTIME_LOG_FILE_NAME);
    const previousPath = path.join(this.directory, RUNTIME_LOG_PREVIOUS_FILE_NAME);
    const entryBytes = Buffer.byteLength(entry, 'utf8');
    const activeBytes = await this.getFileSize(activePath);

    if (activeBytes > 0 && activeBytes + entryBytes > this.maxBytes) {
      await fs.rm(previousPath, { force: true });
      await fs.rename(activePath, previousPath);
    }

    await fs.appendFile(activePath, entry, 'utf8');
  }

  private async getFileSize(filePath: string): Promise<number> {
    try {
      return (await fs.stat(filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
  }
}
