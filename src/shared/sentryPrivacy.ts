export type SentryProcess = 'main' | 'renderer';

type UnknownRecord = Record<string, unknown>;

interface SentryHintLike {
  attachments?: unknown[];
}

const SAFE_EVENT_LEVELS = new Set(['fatal', 'error', 'warning', 'log', 'info', 'debug']);
const SAFE_ENVIRONMENTS = new Set(['development', 'production']);
const SAFE_EXCEPTION_TYPES = new Set([
  'AbortError',
  'AggregateError',
  'DOMException',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);
const SAFE_PLATFORMS = new Set(['javascript', 'node']);
const SAFE_SCOPE_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,79}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_.$:<>{}\[\]()/ -]{0,255}$/;
const SAFE_MECHANISM_PATTERN = /^(?:generic|onerror|onunhandledrejection|auto(?:\.[a-z0-9_-]+)+|electron(?:\.[a-z0-9_-]+)+)$/;
const SAFE_RELEASE_PATTERN = /^[A-Za-z0-9_.@+-]{1,120}$/;
const EVENT_ID_PATTERN = /^[a-f0-9]{32}$/i;

export const SENTRY_MAIN_DISABLED_INTEGRATIONS = new Set([
  'AdditionalContext',
  'ChildProcess',
  'Console',
  'ContextLines',
  'ElectronBreadcrumbs',
  'ElectronContext',
  'ElectronMinidump',
  'ElectronNet',
  'GpuContext',
  'LocalVariables',
  'MainProcessSession',
  'NativeNodeFetch',
  'NodeContext',
  'RendererEventLoopBlock',
  'RendererProfiling',
  'Screenshots',
  'SentryMinidump',
]);

export const SENTRY_RENDERER_DISABLED_INTEGRATIONS = new Set([
  'Breadcrumbs',
  'BrowserApiErrors',
  'BrowserSession',
  'ConversationId',
  'GlobalHandlers',
  'HttpContext',
]);

export function createDisabledSentryDataCollection() {
  return {
    userInfo: false,
    cookies: false,
    httpHeaders: {
      request: false,
      response: false,
    },
    httpBodies: [],
    queryParams: false,
    genAI: {
      inputs: false,
      outputs: false,
    },
    stackFrameVariables: false,
    frameContextLines: 0,
  };
}

export function normalizeSentryScope(scope: string): string {
  const normalized = scope.trim().toLowerCase();
  return SAFE_SCOPE_PATTERN.test(normalized) ? normalized : 'unknown';
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeFrameFilename(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const withoutQuery = value.replace(/\\/g, '/').split(/[?#]/, 1)[0];
  if (/^node:[a-z0-9_./-]+$/i.test(withoutQuery)) return withoutQuery;
  if (withoutQuery === '<anonymous>' || withoutQuery === '[native code]') return withoutQuery;

  for (const marker of ['/dist/', '/app.asar/']) {
    const markerIndex = withoutQuery.lastIndexOf(marker);
    if (markerIndex >= 0) {
      const relative = withoutQuery.slice(markerIndex + 1);
      return relative.length <= 500 && /^[A-Za-z0-9_@./+-]+$/.test(relative)
        ? `app:///${relative}`
        : undefined;
    }
  }

  return undefined;
}

function sanitizeStackFrame(value: unknown): UnknownRecord | undefined {
  if (!isRecord(value)) return undefined;
  const filename = safeFrameFilename(value.filename);
  if (!filename) return undefined;
  const functionName = safeString(value.function, SAFE_IDENTIFIER_PATTERN);
  const lineno = safeNumber(value.lineno);
  const colno = safeNumber(value.colno);
  return {
    filename,
    ...(functionName ? { function: functionName } : {}),
    ...(lineno !== undefined ? { lineno } : {}),
    ...(colno !== undefined ? { colno } : {}),
    ...(typeof value.in_app === 'boolean' ? { in_app: value.in_app } : {}),
  };
}

function sanitizeStacktrace(value: unknown): UnknownRecord | undefined {
  if (!isRecord(value) || !Array.isArray(value.frames)) return undefined;
  const frames = value.frames
    .slice(-100)
    .map(sanitizeStackFrame)
    .filter((frame): frame is UnknownRecord => Boolean(frame));
  return frames.length > 0 ? { frames } : undefined;
}

function sanitizeMechanism(value: unknown): UnknownRecord | undefined {
  if (!isRecord(value)) return undefined;
  const type = safeString(value.type, SAFE_MECHANISM_PATTERN);
  const handled = typeof value.handled === 'boolean' ? value.handled : undefined;
  if (!type && handled === undefined) return undefined;
  return {
    ...(type ? { type } : {}),
    ...(handled !== undefined ? { handled } : {}),
  };
}

function sanitizeException(value: unknown, safeValue: string): UnknownRecord | undefined {
  if (!isRecord(value) || !Array.isArray(value.values)) return undefined;
  const values = value.values.slice(-5).flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const type = typeof candidate.type === 'string' && SAFE_EXCEPTION_TYPES.has(candidate.type)
      ? candidate.type
      : 'Error';
    const stacktrace = sanitizeStacktrace(candidate.stacktrace);
    const mechanism = sanitizeMechanism(candidate.mechanism);
    return [{
      type,
      value: safeValue,
      ...(stacktrace ? { stacktrace } : {}),
      ...(mechanism ? { mechanism } : {}),
    }];
  });
  return values.length > 0 ? { values } : undefined;
}

function sanitizedProcess(source: UnknownRecord, fallback: SentryProcess): SentryProcess {
  if (!isRecord(source.tags)) return fallback;
  return source.tags['service-manager.process'] === 'renderer' ? 'renderer' : fallback;
}

function sanitizedScope(source: UnknownRecord): string | undefined {
  if (!isRecord(source.tags)) return undefined;
  const scope = source.tags['service-manager.scope'];
  return typeof scope === 'string' ? normalizeSentryScope(scope) : undefined;
}

export function sanitizeSentryEvent<T>(
  event: T,
  hint: SentryHintLike | undefined,
  fallbackProcess: SentryProcess,
): T {
  if (hint) hint.attachments = [];
  const source: UnknownRecord = isRecord(event) ? event : {};
  const process = sanitizedProcess(source, fallbackProcess);
  const scope = sanitizedScope(source);
  const exception = sanitizeException(
    source.exception,
    `Application error [${scope ?? process}]`,
  );
  const eventId = safeString(source.event_id, EVENT_ID_PATTERN);
  const timestamp = safeNumber(source.timestamp);
  const platform = typeof source.platform === 'string' && SAFE_PLATFORMS.has(source.platform)
    ? source.platform
    : undefined;
  const level = typeof source.level === 'string' && SAFE_EVENT_LEVELS.has(source.level)
    ? source.level
    : undefined;
  const release = safeString(source.release, SAFE_RELEASE_PATTERN);
  const environment = typeof source.environment === 'string' && SAFE_ENVIRONMENTS.has(source.environment)
    ? source.environment
    : undefined;

  const sanitized: UnknownRecord = {
    ...(eventId ? { event_id: eventId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(platform ? { platform } : {}),
    ...(level ? { level } : {}),
    ...(release ? { release } : {}),
    ...(environment ? { environment } : {}),
    ...(exception ? { exception } : { message: 'Application error' }),
    tags: {
      'service-manager.process': process,
      ...(scope ? { 'service-manager.scope': scope } : {}),
    },
  };
  return sanitized as T;
}
