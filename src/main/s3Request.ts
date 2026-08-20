import {
  createHash,
  createHmac,
} from 'node:crypto';

const MAX_ENDPOINT_LENGTH = 4_096;
const MAX_BUCKET_LENGTH = 63;
const MAX_REGION_LENGTH = 128;

export interface S3EndpointBucket {
  endpoint: string;
  bucket: string;
}

export interface S3SigningInput {
  method: 'GET' | 'PUT' | 'DELETE';
  objectUrl: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  payload?: string | Buffer;
  /** Defaults to JSON for application-owned PUT objects. */
  contentType?: string;
  /** Query values are signed as part of the canonical request. */
  query?: Readonly<Record<string, string>>;
  ifMatch?: string;
  ifNoneMatch?: '*';
  now: Date;
}

export interface S3SignedRequest {
  url: string;
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export interface S3PresignedGetInput {
  objectUrl: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresInSeconds: number;
  now: Date;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '[::1]'
    || normalized === '::1';
}

function parseEndpoint(value: unknown, requireRootPath: boolean): URL {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_ENDPOINT_LENGTH) {
    throw new Error('An S3 endpoint is required.');
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('The S3 endpoint is invalid.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The S3 endpoint must use HTTPS.');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error('The S3 endpoint must use HTTPS unless it targets localhost.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The S3 endpoint cannot contain credentials, a query, or a fragment.');
  }
  if (requireRootPath && url.pathname !== '/' && url.pathname !== '') {
    throw new Error('The S3 endpoint cannot contain a bucket path.');
  }
  try {
    canonicalizeS3Path(url.pathname);
  } catch {
    throw new Error('The S3 endpoint contains an invalid path encoding.');
  }
  return url;
}

export function normalizeS3Endpoint(value: unknown): string {
  const url = parseEndpoint(value, true);
  return `${url.protocol}//${url.host}`;
}

export function normalizeS3Bucket(value: unknown): string {
  if (typeof value !== 'string') throw new Error('An S3 bucket is required.');
  const bucket = value.trim();
  if (
    bucket.length < 3
    || bucket.length > MAX_BUCKET_LENGTH
    || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)
    || bucket.includes('..')
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)
  ) {
    throw new Error('The S3 bucket must be a DNS-compatible name with 3 to 63 characters.');
  }
  return bucket;
}

export function normalizeS3EndpointBucket(endpoint: unknown, bucket: unknown): S3EndpointBucket {
  return {
    endpoint: normalizeS3Endpoint(endpoint),
    bucket: normalizeS3Bucket(bucket),
  };
}

export function buildS3BucketUrl(endpoint: unknown, bucket: unknown): string {
  const normalized = normalizeS3EndpointBucket(endpoint, bucket);
  return `${normalized.endpoint}/${normalized.bucket}`;
}

export function splitS3BucketUrl(value: unknown): S3EndpointBucket {
  const url = parseEndpoint(value, false);
  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    throw new Error('The S3 bucket URL contains an invalid path encoding.');
  }
  if (segments.length !== 1) {
    throw new Error('The S3 bucket URL must contain exactly one bucket path.');
  }
  return {
    endpoint: `${url.protocol}//${url.host}`,
    bucket: normalizeS3Bucket(segments[0]),
  };
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function canonicalizeS3Path(pathname: string): string {
  const canonical = pathname
    .split('/')
    .map((segment) => awsUriEncode(decodeURIComponent(segment)))
    .join('/');
  return canonical.startsWith('/') ? canonical : `/${canonical}`;
}

function amzTimestamp(value: Date): { amzDate: string; dateStamp: string } {
  if (!Number.isFinite(value.getTime())) throw new Error('The S3 signing timestamp is invalid.');
  const amzDate = value.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function normalizedRegion(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > MAX_REGION_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.trim())
  ) {
    throw new Error('A valid S3 region is required.');
  }
  return value.trim();
}

function normalizedEtag(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 2
    || value.length > 512
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('The S3 object ETag is invalid.');
  }
  return value;
}

function canonicalQueryString(query: Readonly<Record<string, string>> | undefined): string {
  if (!query) return '';
  const values = Object.entries(query).map(([key, value]) => {
    if (typeof value !== 'string') throw new Error('The S3 request query is invalid.');
    return [awsUriEncode(key), awsUriEncode(value)] as const;
  });
  values.sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey === rightKey
    ? leftValue.localeCompare(rightValue)
    : leftKey.localeCompare(rightKey));
  return values.map(([key, value]) => `${key}=${value}`).join('&');
}

function signingKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

function signedRequestUrl(url: URL, canonicalUri: string, canonicalQuery: string): string {
  return `${url.protocol}//${url.host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
}

export function signS3Request(input: S3SigningInput): S3SignedRequest {
  const url = parseEndpoint(input.objectUrl, false);
  if (url.pathname === '/' || url.pathname === '') throw new Error('The S3 object URL is invalid.');
  const region = normalizedRegion(input.region);
  if (!input.accessKeyId || !input.secretAccessKey) throw new Error('S3 credentials are unavailable.');
  if (input.ifMatch !== undefined && input.ifNoneMatch !== undefined) {
    throw new Error('Conflicting S3 request conditions are invalid.');
  }
  const payload = input.payload ?? '';
  if ((input.method === 'GET' || input.method === 'DELETE') && Buffer.byteLength(payload) !== 0) {
    throw new Error(`An S3 ${input.method} request cannot contain a payload.`);
  }
  const canonicalUri = canonicalizeS3Path(url.pathname);
  const canonicalQuery = canonicalQueryString(input.query);
  const requestUrl = signedRequestUrl(url, canonicalUri, canonicalQuery);
  const payloadHash = sha256Hex(payload);
  const { amzDate, dateStamp } = amzTimestamp(input.now);
  const requestHeaders: Record<string, string> = {
    ...(input.method === 'PUT' ? { 'content-type': input.contentType ?? 'application/json' } : {}),
    host: url.host.toLowerCase(),
    ...(input.ifMatch !== undefined ? { 'if-match': normalizedEtag(input.ifMatch) } : {}),
    ...(input.ifNoneMatch !== undefined ? { 'if-none-match': '*' } : {}),
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const headerNames = Object.keys(requestHeaders).sort();
  const canonicalHeaders = `${headerNames.map((name) => `${name}:${requestHeaders[name]}`).join('\n')}\n`;
  const signedHeaders = headerNames.join(';');
  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signature = createHmac('sha256', signingKey(input.secretAccessKey, dateStamp, region))
    .update(stringToSign, 'utf8')
    .digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const fetchHeaders = { ...requestHeaders };
  delete fetchHeaders.host;
  return {
    url: requestUrl,
    canonicalRequest,
    stringToSign,
    signature,
    headers: { ...fetchHeaders, authorization },
  };
}

/**
 * Creates a browser-safe SigV4 GET URL. The credential secret is never
 * embedded; callers must constrain the expiry to the S3 maximum of seven days.
 */
export function presignS3Get(input: S3PresignedGetInput): string {
  const url = parseEndpoint(input.objectUrl, false);
  if (url.pathname === '/' || url.pathname === '') throw new Error('The S3 object URL is invalid.');
  const region = normalizedRegion(input.region);
  if (!input.accessKeyId || !input.secretAccessKey) throw new Error('S3 credentials are unavailable.');
  if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 1 || input.expiresInSeconds > 604_800) {
    throw new Error('The S3 presigned URL expiry is invalid.');
  }
  const canonicalUri = canonicalizeS3Path(url.pathname);
  const { amzDate, dateStamp } = amzTimestamp(input.now);
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = canonicalQueryString(query);
  const canonicalHeaders = `host:${url.host.toLowerCase()}\n`;
  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signature = createHmac('sha256', signingKey(input.secretAccessKey, dateStamp, region))
    .update(stringToSign, 'utf8')
    .digest('hex');
  return signedRequestUrl(url, canonicalUri, `${canonicalQuery}&X-Amz-Signature=${signature}`);
}

export function hashS3Payload(value: string | Buffer): string {
  return sha256Hex(value);
}
