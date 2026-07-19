const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LLM_MODELS_MAX_IDS,
  LLM_MODELS_MAX_RESPONSE_BYTES,
  buildLlmModelsUrl,
  fetchLlmModels,
  parseLlmModelsResponse,
} = require('../dist/main/llmModels');

const ENDPOINT = 'https://llm.example.test/v1';
const TOKEN = 'private-bearer-token';

function response(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

test('LLM model URL appends models to the normalized API base', () => {
  assert.equal(buildLlmModelsUrl(' https://LLM.example.test/v1/// '), `${ENDPOINT}/models`);
  assert.throws(() => buildLlmModelsUrl(''), /endpoint is required/);
});

test('LLM model fetch uses one manual-redirect GET and an optional Bearer token', async () => {
  const calls = [];
  const models = await fetchLlmModels({
    endpoint: `${ENDPOINT}/`,
    token: TOKEN,
    timeoutMs: 100,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({
        object: 'list',
        data: [
          { id: 'z-model', object: 'model', owned_by: 'vendor' },
          { id: 'a-model' },
          { id: 'z-model' },
        ],
      });
    },
  });

  assert.deepEqual(models, ['a-model', 'z-model']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ENDPOINT}/models`);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.headers.accept, 'application/json');

  await fetchLlmModels({
    endpoint: ENDPOINT,
    timeoutMs: 100,
    fetchImpl: async (_url, options) => {
      assert.equal('authorization' in options.headers, false);
      return response({ data: [] });
    },
  });
});

test('LLM model parser accepts only the standard data array with valid bounded IDs', () => {
  assert.deepEqual(parseLlmModelsResponse({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }), ['a', 'b']);
  for (const value of [
    [],
    {},
    { models: [{ id: 'a' }] },
    { data: 'not-an-array' },
    { data: [null] },
    { data: [{}] },
    { data: [{ id: '' }] },
    { data: [{ id: ' padded ' }] },
    { data: [{ id: 'x'.repeat(513) }] },
  ]) {
    assert.throws(() => parseLlmModelsResponse(value), /LLM model response|selected LLM model/);
  }

  assert.throws(
    () => parseLlmModelsResponse({
      data: Array.from({ length: LLM_MODELS_MAX_IDS + 1 }, (_, index) => ({ id: `model-${index}` })),
    }),
    /more than 2000 unique models/,
  );
});

test('HTTP, redirect, transport, and response errors never expose body, token, or full URL', async () => {
  const cases = [
    async () => fetchLlmModels({
      endpoint: ENDPOINT,
      token: TOKEN,
      timeoutMs: 100,
      fetchImpl: async () => new Response(`body ${TOKEN} ${ENDPOINT}`, { status: 401 }),
    }),
    async () => fetchLlmModels({
      endpoint: ENDPOINT,
      token: TOKEN,
      timeoutMs: 100,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: `https://redirect.example.test/?token=${TOKEN}` },
      }),
    }),
    async () => fetchLlmModels({
      endpoint: ENDPOINT,
      token: TOKEN,
      timeoutMs: 100,
      fetchImpl: async () => { throw new Error(`${TOKEN} ${ENDPOINT}`); },
    }),
    async () => fetchLlmModels({
      endpoint: ENDPOINT,
      token: TOKEN,
      timeoutMs: 100,
      fetchImpl: async () => new Response(`not json ${TOKEN} ${ENDPOINT}`, { status: 200 }),
    }),
  ];

  for (const run of cases) {
    await assert.rejects(run(), (error) => {
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      assert.doesNotMatch(error.message, /llm\.example\.test/);
      assert.match(error.message, /LLM model/);
      return true;
    });
  }
});

test('LLM model fetch rejects declared and streamed responses above 2 MiB', async () => {
  await assert.rejects(fetchLlmModels({
    endpoint: ENDPOINT,
    timeoutMs: 100,
    fetchImpl: async () => new Response(null, {
      status: 200,
      headers: { 'content-length': String(LLM_MODELS_MAX_RESPONSE_BYTES + 1) },
    }),
  }), { message: 'The LLM model response is too large.' });

  await assert.rejects(fetchLlmModels({
    endpoint: ENDPOINT,
    timeoutMs: 100,
    fetchImpl: async () => new Response('x'.repeat(LLM_MODELS_MAX_RESPONSE_BYTES + 1), { status: 200 }),
  }), { message: 'The LLM model response is too large.' });
});

test('LLM model fetch has an injectable timeout and supports owner cancellation', async () => {
  await assert.rejects(fetchLlmModels({
    endpoint: ENDPOINT,
    timeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('private abort details')), { once: true });
    }),
  }), { message: 'The LLM model request timed out.' });

  const controller = new AbortController();
  const pending = fetchLlmModels({
    endpoint: ENDPOINT,
    timeoutMs: 1_000,
    signal: controller.signal,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('private abort details')), { once: true });
    }),
  });
  controller.abort();
  await assert.rejects(pending, { message: 'The LLM model request was cancelled.' });
});
