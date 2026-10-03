import { createHash } from 'node:crypto';

export type S3DiagnosticReporter = (event: Record<string, string | number | boolean>) => void;

const ERROR_CODES = new Set(['NoSuchBucket', 'NoSuchKey', 'AccessDenied', 'InvalidAccessKeyId',
  'SignatureDoesNotMatch', 'RequestTimeTooSkewed', 'ExpiredToken', 'InvalidToken', 'InternalError',
  'ServiceUnavailable', 'SlowDown', 'PermanentRedirect', 'AuthorizationHeaderMalformed',
  'PreconditionFailed', 'OperationAborted', 'NotImplemented', 'InvalidRequest']);

function identity(input: Parameters<typeof fetch>[0]): Record<string, string> {
  try {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const object = segments.slice(1).join('/');
    const type = object === 'service-manager/v4/head.json' ? 'head'
      : object.startsWith('service-manager/v4/manifests/') ? 'manifest'
        : object.startsWith('service-manager/v4/notes-trees/') ? 'notes-tree'
          : object.startsWith('service-manager/v4/notes/') ? 'note'
            : object === 'service-manager-sync-v5/notes/database.sqlite3.enc' ? 'notes-database' : 'other';
    const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
    return { objectType: type, targetId: digest(`${url.origin}/${segments[0] ?? ''}`), objectId: digest(object) };
  } catch { return { objectType: 'unknown' }; }
}

async function errorCode(response: Response): Promise<string> {
  const reader = response.clone().body?.getReader();
  if (!reader) return 'unavailable';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      const parts: Uint8Array[] = [];
      let length = 0;
      while (length < 4096) {
        const result = await reader.read();
        if (result.done) break;
        const part = result.value.subarray(0, 4096 - length);
        parts.push(part);
        length += part.length;
      }
      const text = Buffer.concat(parts).toString('utf8');
      const code = text.match(/<Code>\s*([A-Za-z0-9]+)\s*<\/Code>/)?.[1];
      return code && ERROR_CODES.has(code) ? code : 'unrecognized';
    };
    return await Promise.race([read(), new Promise<string>(resolve => {
      timer = setTimeout(() => resolve('unavailable'), 500);
    })]);
  } catch { return 'unavailable'; }
  finally {
    clearTimeout(timer);
    // A cloned stream can wait for the original consumer, so cancellation must not be awaited.
    void reader.cancel().catch(() => undefined);
  }
}

/** Diagnostics contain only bounded metadata, never URLs, headers, bodies or credentials. */
export function withS3Diagnostics(fetchImpl: typeof fetch, report?: S3DiagnosticReporter): typeof fetch {
  if (!report) return fetchImpl;
  const emit = (event: Record<string, string | number | boolean>) => { try { report(event); } catch { /* Best effort. */ } };
  return async (input, init) => {
    const started = performance.now();
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const metadata = { ...identity(input), method: ['GET', 'PUT', 'DELETE', 'HEAD'].includes(method) ? method : 'other' };
    let response: Response;
    try { response = await fetchImpl(input, init); }
    catch (error) {
      emit({ ...metadata, kind: 'transport-failure', aborted: Boolean(init?.signal?.aborted), durationMs: Math.round(performance.now() - started) });
      // Transport exceptions can contain signed URLs; preserve the caller's existing safe error handling.
      throw error;
    }
    if (response.status >= 400) {
      const code = await errorCode(response);
      const requestId = response.headers.get('x-amz-request-id');
      emit({ ...metadata, kind: 'http-failure', status: response.status, code,
        expected: (method === 'GET' && response.status === 404) || [409, 412].includes(response.status),
        durationMs: Math.round(performance.now() - started),
        ...(requestId && /^[A-Za-z0-9-]{1,128}$/.test(requestId) ? { requestId } : {}) });
    }
    return response;
  };
}
