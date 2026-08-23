import { TextDecoder } from 'node:util';
import { normalizeLlmEndpoint, normalizeLlmModelId } from './llmSettingsStore';

export const LLM_MODELS_DEFAULT_TIMEOUT_MS = 30_000;
export const LLM_MODELS_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const LLM_MODELS_MAX_IDS = 2_000;

const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_TOKEN_CHARACTERS = 16 * 1024;

export interface FetchLlmModelsOptions {
  endpoint: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

class SafeLlmModelsError extends Error {}

function safeError(message: string): SafeLlmModelsError {
  return new SafeLlmModelsError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTimeout(value: unknown): number {
  const timeoutMs = value === undefined ? LLM_MODELS_DEFAULT_TIMEOUT_MS : value;
  if (
    typeof timeoutMs !== 'number'
    || !Number.isInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error('The LLM model request timeout is invalid.');
  }
  return timeoutMs;
}

function normalizeRequestToken(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (
    typeof value !== 'string'
    || value.length > MAX_TOKEN_CHARACTERS
    || /[\u0000\r\n]/.test(value)
  ) {
    throw new Error('The LLM token is invalid.');
  }
  return value;
}

export function buildLlmModelsUrl(value: unknown): string {
  const endpoint = normalizeLlmEndpoint(value);
  if (!endpoint) throw new Error('An LLM endpoint is required.');
  return `${endpoint}/models`;
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength
    && /^\d+$/.test(declaredLength)
    && Number(declaredLength) > LLM_MODELS_MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw safeError('The LLM model response is too large.');
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
      total += chunk.byteLength;
      if (total > LLM_MODELS_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw safeError('The LLM model response is too large.');
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
  }
  return Buffer.concat(chunks, total);
}

export function parseLlmModelsResponse(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('The LLM model response is invalid.');
  }
  const modelIds = new Set<string>();
  for (const item of value.data) {
    if (!isRecord(item) || typeof item.id !== 'string') {
      throw new Error('The LLM model response is invalid.');
    }
    const modelId = normalizeLlmModelId(item.id);
    if (!modelId || modelId !== item.id) {
      throw new Error('The LLM model response is invalid.');
    }
    modelIds.add(modelId);
    if (modelIds.size > LLM_MODELS_MAX_IDS) {
      throw new Error(`The LLM model response cannot contain more than ${LLM_MODELS_MAX_IDS} unique models.`);
    }
  }
  return [...modelIds].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
}

/** Fetch a bounded OpenAI-compatible `GET /models` response. */
export async function fetchLlmModels(options: FetchLlmModelsOptions): Promise<string[]> {
  const url = buildLlmModelsUrl(options.endpoint);
  const token = normalizeRequestToken(options.token);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let abortReason: 'owner' | 'timeout' | undefined;
  const abortFromOwner = (): void => {
    if (!abortReason) abortReason = 'owner';
    controller.abort();
  };
  if (options.signal?.aborted) abortFromOwner();
  else options.signal?.addEventListener('abort', abortFromOwner, { once: true });
  const timeout = setTimeout(() => {
    if (!abortReason) abortReason = 'timeout';
    controller.abort();
  }, timeoutMs);

  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      if (abortReason === 'timeout') throw safeError('The LLM model request timed out.');
      if (abortReason === 'owner' || controller.signal.aborted) {
        throw safeError('The LLM model request was cancelled.');
      }
      throw safeError('The LLM model request failed.');
    }

    if (abortReason === 'timeout') throw safeError('The LLM model request timed out.');
    if (abortReason === 'owner' || controller.signal.aborted) {
      throw safeError('The LLM model request was cancelled.');
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      throw safeError(`The LLM model request failed (${response.status}).`);
    }

    const body = await readBoundedBody(response, controller.signal);
    if (abortReason === 'timeout') throw safeError('The LLM model request timed out.');
    if (abortReason === 'owner' || controller.signal.aborted) {
      throw safeError('The LLM model request was cancelled.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
    } catch {
      throw safeError('The LLM model response is invalid.');
    }
    try {
      return parseLlmModelsResponse(parsed);
    } catch {
      throw safeError('The LLM model response is invalid.');
    }
  } catch (error) {
    if (abortReason === 'timeout') throw new Error('The LLM model request timed out.');
    if (abortReason === 'owner') throw new Error('The LLM model request was cancelled.');
    if (error instanceof SafeLlmModelsError) throw new Error(error.message);
    throw new Error('The LLM model request failed.');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromOwner);
  }
}
