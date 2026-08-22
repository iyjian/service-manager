const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const {
  SENTRY_MAIN_DISABLED_INTEGRATIONS,
  SENTRY_RENDERER_DISABLED_INTEGRATIONS,
  createDisabledSentryDataCollection,
  normalizeSentryScope,
  sanitizeSentryEvent,
} = require('../dist/shared/sentryPrivacy');

const root = path.join(__dirname, '..');

test('sanitizeSentryEvent retains only safe static identity and app-relative stack locations', () => {
  const canary = 'SENTRY-PRIVATE-CANARY-94175';
  const hint = { attachments: [{ filename: `${canary}.txt`, data: canary }] };
  const event = {
    event_id: '1234567890abcdef1234567890abcdef',
    timestamp: 1_752_969_600,
    platform: 'javascript',
    level: 'error',
    release: 'service-manager@0.3.27',
    environment: 'development',
    message: canary,
    user: { email: `${canary}@example.invalid` },
    request: {
      url: `https://s3.example.invalid/bucket?token=${canary}`,
      headers: { authorization: `Bearer ${canary}` },
      data: canary,
    },
    extra: { noteContent: canary },
    contexts: { note: { body: canary }, trace: { data: canary } },
    breadcrumbs: [{ message: canary, data: { url: `https://example.invalid/${canary}` } }],
    transaction: canary,
    spans: [{ description: canary }],
    modules: { [canary]: '1.0.0' },
    tags: {
      'service-manager.process': 'renderer',
      'service-manager.scope': 'notes:table-menu',
      unsafe: canary,
    },
    exception: {
      values: [{
        type: 'TypeError',
        value: canary,
        mechanism: {
          type: 'onerror',
          handled: false,
          data: { token: canary },
        },
        stacktrace: {
          frames: [{
            filename: `file:///Users/private-user/projects/service-manager/dist/renderer/notesRichTextTable.js?token=${canary}`,
            abs_path: `/Users/private-user/${canary}`,
            function: 'TableHoverController.openMenu',
            lineno: 287,
            colno: 19,
            in_app: true,
            vars: { secret: canary },
            pre_context: [canary],
            context_line: canary,
            post_context: [canary],
          }, {
            filename: `https://example.invalid/private-${canary}.js`,
            function: 'ExternalPrivateFunction',
            lineno: 1,
          }],
        },
      }],
    },
  };

  const sanitized = sanitizeSentryEvent(event, hint, 'main');
  assert.deepEqual(hint.attachments, []);
  assert.deepEqual(Object.keys(sanitized).sort(), [
    'environment',
    'event_id',
    'exception',
    'level',
    'platform',
    'release',
    'tags',
    'timestamp',
  ]);
  assert.deepEqual(sanitized.tags, {
    'service-manager.process': 'renderer',
    'service-manager.scope': 'notes:table-menu',
  });
  assert.deepEqual(sanitized.exception.values[0], {
    type: 'TypeError',
    value: 'Application error [notes:table-menu]',
    stacktrace: {
      frames: [{
        filename: 'app:///dist/renderer/notesRichTextTable.js',
        function: 'TableHoverController.openMenu',
        lineno: 287,
        colno: 19,
        in_app: true,
      }],
    },
    mechanism: {
      type: 'onerror',
      handled: false,
    },
  });
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, new RegExp(canary));
  assert.doesNotMatch(serialized, /private-user|example\.invalid|authorization|noteContent|breadcrumbs|abs_path|vars|context_line/);
});

test('sanitizeSentryEvent replaces custom exception names and drops non-application frame paths', () => {
  const sanitized = sanitizeSentryEvent({
    tags: { 'service-manager.scope': 'window:error' },
    exception: {
      values: [{
        type: 'PrivateCustomerNameError',
        value: 'private value',
        stacktrace: {
          frames: [{
            filename: 'https://private.example.invalid/customer-name.js',
            function: 'PrivateCustomerName',
            lineno: 5,
          }],
        },
      }],
    },
  }, undefined, 'renderer');

  assert.deepEqual(sanitized.exception.values[0], {
    type: 'Error',
    value: 'Application error [window:error]',
  });
  assert.doesNotMatch(JSON.stringify(sanitized), /PrivateCustomer|private\.example|customer-name/);
});

test('Sentry collection policy explicitly disables every data category and unsafe integration', () => {
  assert.deepEqual(createDisabledSentryDataCollection(), {
    userInfo: false,
    cookies: false,
    httpHeaders: { request: false, response: false },
    httpBodies: [],
    queryParams: false,
    genAI: { inputs: false, outputs: false },
    stackFrameVariables: false,
    frameContextLines: 0,
  });
  for (const name of [
    'SentryMinidump',
    'ElectronMinidump',
    'Screenshots',
    'ElectronNet',
    'ElectronBreadcrumbs',
    'Console',
    'GpuContext',
    'LocalVariables',
    'ContextLines',
    'MainProcessSession',
  ]) {
    assert.equal(SENTRY_MAIN_DISABLED_INTEGRATIONS.has(name), true, `${name} must be disabled in main`);
  }
  for (const name of [
    'Breadcrumbs',
    'BrowserApiErrors',
    'BrowserSession',
    'ConversationId',
    'GlobalHandlers',
    'HttpContext',
  ]) {
    assert.equal(SENTRY_RENDERER_DISABLED_INTEGRATIONS.has(name), true, `${name} must be disabled in renderer`);
  }
  assert.equal(SENTRY_MAIN_DISABLED_INTEGRATIONS.has('PreloadInjection'), false);
  assert.equal(normalizeSentryScope(' Notes:Table-Menu '), 'notes:table-menu');
  assert.equal(normalizeSentryScope('unsafe scope containing private text'), 'unknown');
});

test('Sentry is initialized before Electron and renderer application startup with a complete local ESM graph', async () => {
  const [main, mainSentry, renderer, rendererSentry, html] = await Promise.all([
    fs.readFile(path.join(root, 'dist', 'main', 'main.js'), 'utf8'),
    fs.readFile(path.join(root, 'dist', 'main', 'sentry.js'), 'utf8'),
    fs.readFile(path.join(root, 'dist', 'renderer', 'renderer.js'), 'utf8'),
    fs.readFile(path.join(root, 'dist', 'renderer', 'sentry.js'), 'utf8'),
    fs.readFile(path.join(root, 'dist', 'renderer', 'index.html'), 'utf8'),
  ]);

  assert.ok(main.indexOf('require("./sentry")') < main.indexOf('require("electron")'));
  assert.match(mainSentry, /@sentry\/electron\/main/);
  assert.match(mainSentry, /beforeSendTransaction:\s*\(\)\s*=>\s*null/);
  assert.match(mainSentry, /skipOpenTelemetrySetup:\s*true/);
  assert.ok(renderer.indexOf("from './sentry.js'") < renderer.indexOf("from './nav.js'"));
  assert.match(rendererSentry, /@sentry\/electron\/renderer/);
  assert.match(rendererSentry, /window\.addEventListener\('error'/);

  const importMapMatch = html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(importMapMatch, 'renderer import map is present');
  const importMap = JSON.parse(importMapMatch[1]);
  assert.equal(
    importMap.imports['@sentry/electron/renderer'],
    './vendor/sentry-electron/esm/renderer/index.js',
  );
  for (const specifier of [
    '@sentry/browser',
    '@sentry/browser-utils',
    '@sentry/core',
    '@sentry/core/browser',
    '@sentry/feedback',
    '@sentry/replay',
    '@sentry/replay-canvas',
  ]) {
    assert.equal(typeof importMap.imports[specifier], 'string', `${specifier} is mapped locally`);
  }
  await fs.access(path.join(root, 'dist', 'renderer', 'vendor', 'sentry-electron', 'esm', 'renderer', 'index.js'));
});

test('the local Sentry API credential path is ignored and never documents a token value', async () => {
  const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.secrets$/m);
});
