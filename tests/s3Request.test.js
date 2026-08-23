const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildS3BucketUrl,
  canonicalizeS3Path,
  hashS3Payload,
  normalizeS3Bucket,
  normalizeS3Endpoint,
  presignS3Get,
  signS3Request,
  splitS3BucketUrl,
} = require('../dist/main/s3/s3Request');

const ENDPOINT = 'https://s3.example.test';
const BUCKET = 'service-manager';
const ACCESS_KEY = 'AKIDEXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const NOW = new Date('2026-07-18T04:05:06.000Z');

test('S3 request helpers separate a root endpoint from a DNS-compatible bucket', () => {
  assert.equal(normalizeS3Endpoint(`${ENDPOINT}/`), ENDPOINT);
  assert.equal(normalizeS3Endpoint('http://localhost:9000/'), 'http://localhost:9000');
  assert.equal(normalizeS3Bucket(' service-manager.backup '), 'service-manager.backup');
  assert.equal(buildS3BucketUrl(ENDPOINT, BUCKET), `${ENDPOINT}/${BUCKET}`);
  assert.deepEqual(splitS3BucketUrl(`${ENDPOINT}/${BUCKET}/`), {
    endpoint: ENDPOINT,
    bucket: BUCKET,
  });

  assert.throws(() => normalizeS3Endpoint(`${ENDPOINT}/${BUCKET}`), /cannot contain a bucket path/);
  assert.throws(() => normalizeS3Endpoint('http://s3.example.test'), /must use HTTPS unless it targets localhost/);
  assert.throws(() => normalizeS3Endpoint('https://user:secret@s3.example.test'), /cannot contain credentials/);
  assert.throws(() => normalizeS3Bucket('UPPERCASE'), /DNS-compatible/);
  assert.throws(() => normalizeS3Bucket('ab'), /DNS-compatible/);
  assert.throws(() => normalizeS3Bucket('192.168.1.1'), /DNS-compatible/);
  assert.throws(() => normalizeS3Bucket('invalid..bucket'), /DNS-compatible/);
  assert.throws(() => splitS3BucketUrl(`${ENDPOINT}/bucket/prefix`), /exactly one bucket path/);
});

test('S3 request helpers sign GET and conditional PUT headers', () => {
  const objectUrl = `${ENDPOINT}/${BUCKET}/service-manager/v4/head.json`;
  const get = signS3Request({
    method: 'GET',
    objectUrl,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    now: NOW,
  });
  assert.match(get.canonicalRequest, /^GET\n\/service-manager\/service-manager\/v4\/head\.json\n/m);
  assert.match(get.headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  assert.equal(get.headers['x-amz-content-sha256'], hashS3Payload(''));

  const put = signS3Request({
    method: 'PUT',
    objectUrl,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    payload: '{"revision":"revision-2"}',
    ifMatch: '"head-etag"',
    now: NOW,
  });
  assert.equal(put.headers['if-match'], '"head-etag"');
  assert.match(
    put.headers.authorization,
    /SignedHeaders=content-type;host;if-match;x-amz-content-sha256;x-amz-date/,
  );
  assert.throws(
    () => signS3Request({
      method: 'PUT',
      objectUrl,
      region: 'us-east-1',
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      ifMatch: '"etag"',
      ifNoneMatch: '*',
      now: NOW,
    }),
    /Conflicting S3 request conditions/,
  );
});

test('S3 request helpers sign query strings and DELETE requests for share management', () => {
  const list = signS3Request({
    method: 'GET',
    objectUrl: buildS3BucketUrl(ENDPOINT, BUCKET),
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    query: { prefix: 'service-manager/v4/shares/note 1/', 'list-type': '2', delimiter: '/' },
    now: NOW,
  });
  assert.match(
    list.canonicalRequest,
    /^GET\n\/service-manager\ndelimiter=%2F&list-type=2&prefix=service-manager%2Fv4%2Fshares%2Fnote%201%2F\n/m,
  );
  assert.match(list.url, /\?delimiter=%2F&list-type=2&prefix=service-manager%2Fv4%2Fshares%2Fnote%201%2F$/);

  const deleted = signS3Request({
    method: 'DELETE',
    objectUrl: `${ENDPOINT}/${BUCKET}/service-manager/v4/shares/note/share/manifest.json`,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    now: NOW,
  });
  assert.match(deleted.canonicalRequest, /^DELETE\n\/service-manager\/service-manager\/v4\/shares\/note\/share\/manifest\.json\n\n/m);
  assert.match(deleted.headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  assert.throws(
    () => signS3Request({
      method: 'DELETE',
      objectUrl: `${ENDPOINT}/${BUCKET}/service-manager/v4/shares/note/share/manifest.json`,
      region: 'us-east-1',
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      payload: 'not allowed',
      now: NOW,
    }),
    /DELETE request cannot contain a payload/,
  );
});

test('S3 request helpers create deterministic presigned GET URLs capped at seven days', () => {
  const signed = presignS3Get({
    objectUrl: `${ENDPOINT}/${BUCKET}/service-manager/v4/shares/note/share/index.html`,
    region: 'us-east-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    expiresInSeconds: 604_800,
    now: NOW,
  });
  const url = new URL(signed);
  assert.equal(url.origin, ENDPOINT);
  assert.equal(url.pathname, `/${BUCKET}/service-manager/v4/shares/note/share/index.html`);
  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(url.searchParams.get('X-Amz-Date'), '20260718T040506Z');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '604800');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.equal(url.searchParams.get('X-Amz-Credential'), `${ACCESS_KEY}/20260718/us-east-1/s3/aws4_request`);
  assert.match(url.searchParams.get('X-Amz-Signature') ?? '', /^[a-f0-9]{64}$/);
  assert.doesNotMatch(signed, new RegExp(SECRET_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.throws(
    () => presignS3Get({
      objectUrl: `${ENDPOINT}/${BUCKET}/service-manager/v4/shares/note/share/index.html`,
      region: 'us-east-1',
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      expiresInSeconds: 604_801,
      now: NOW,
    }),
    /presigned URL expiry is invalid/,
  );
});

test('S3 request helpers canonicalize object paths', () => {
  assert.equal(
    canonicalizeS3Path('/example-bucket/folder/hello world+中文.json'),
    '/example-bucket/folder/hello%20world%2B%E4%B8%AD%E6%96%87.json',
  );
});
