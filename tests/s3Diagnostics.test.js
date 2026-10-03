const assert = require('node:assert/strict');
const test = require('node:test');
const { withS3Diagnostics } = require('../dist/main/s3/s3Diagnostics');

test('upload 404 diagnostics retain safe metadata without consuming the response or exposing secrets', async () => {
  const events = [];
  const body = '<Error><Code>NoSuchBucket</Code><Message>private-password secret-access-key</Message></Error>';
  const fetch = withS3Diagnostics(async () => new Response(body, { status: 404,
    headers: { 'x-amz-request-id': '18DAE516FA7C85FA', 'set-cookie': 'private-cookie' } }), event => events.push(event));
  const response = await fetch('https://private.example/private-bucket/service-manager/v4/manifests/private-object.json?signature=private-signature',
    { method: 'PUT', headers: { Authorization: 'private-authorization' }, body: 'private-data' });
  assert.equal(await response.text(), body);
  assert.equal(events.length, 1);
  assert.equal(events[0].method, 'PUT');
  assert.equal(events[0].objectType, 'manifest');
  assert.equal(events[0].status, 404);
  assert.equal(events[0].code, 'NoSuchBucket');
  assert.equal(events[0].requestId, '18DAE516FA7C85FA');
  assert.equal(events[0].expected, false);
  assert.match(events[0].targetId, /^[a-f0-9]{24}$/);
  assert.doesNotMatch(JSON.stringify(events), /private|secret-access-key|https|Authorization|cookie/);
});

test('expected missing reads and conditional conflicts are distinguished from failed uploads', async () => {
  const events = [];
  for (const [method, status, expected] of [['GET', 404, true], ['PUT', 412, true], ['PUT', 503, false]]) {
    const fetch = withS3Diagnostics(async () => new Response('<Code>unknown-sensitive-value</Code>', { status }), event => events.push(event));
    await fetch('https://example.test/bucket/service-manager/v4/head.json', { method });
    assert.equal(events.at(-1).expected, expected);
    assert.equal(events.at(-1).code, 'unrecognized');
  }
});

test('transport failures are logged without exception contents and logger failure cannot change requests', async () => {
  const events = [];
  const failure = new Error('private signed URL and credential');
  const fetch = withS3Diagnostics(async () => { throw failure; }, event => events.push(event));
  await assert.rejects(fetch('https://example.test/bucket/object', { method: 'GET' }), error => error === failure);
  assert.equal(events[0].kind, 'transport-failure');
  assert.doesNotMatch(JSON.stringify(events), /private|credential/);
  const throwingLogger = withS3Diagnostics(async () => new Response('', { status: 403 }), () => { throw new Error('disk full'); });
  assert.equal((await throwingLogger('https://example.test/bucket/object')).status, 403);
});

test('diagnostic body reads are bounded and stalled bodies cannot block the original response', async () => {
  const events = [];
  const oversized = withS3Diagnostics(async () => new Response('x'.repeat(4096) + '<Code>AccessDenied</Code>', { status: 403 }), event => events.push(event));
  await oversized('https://example.test/bucket/object');
  assert.equal(events[0].code, 'unrecognized');
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const stalled = withS3Diagnostics(async () => new Response(stream, { status: 504 }), event => events.push(event));
  const started = Date.now();
  const result = await stalled('https://example.test/bucket/object');
  assert.ok(Date.now() - started < 2000);
  assert.equal(result.status, 504);
  assert.equal(events.at(-1).code, 'unavailable');
  controller.close();
  await result.text();
});

test('successful requests do not generate failure logs', async () => {
  const fetch = withS3Diagnostics(async () => new Response('ok'), assert.fail);
  assert.equal(await (await fetch('https://example.test/bucket/object')).text(), 'ok');
});
