const assert = require('node:assert/strict');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const rendererRoot = path.join(__dirname, '..', 'dist', 'renderer');

function readImportMap(html) {
  const match = html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(match, 'renderer HTML must contain an import map');
  return JSON.parse(match[1]);
}

function bareModuleSpecifiers(source) {
  const specifiers = new Set();
  const declaration = /\b(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  const dynamicImport = /\bimport\s*\(\s*['"]([^'"]+)['"]/g;
  for (const expression of [declaration, dynamicImport]) {
    for (const match of source.matchAll(expression)) {
      const specifier = match[1];
      if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes('://')) {
        specifiers.add(specifier);
      }
    }
  }
  return specifiers;
}

function relativeModuleSpecifiers(source) {
  const specifiers = new Set();
  const declaration = /\b(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"](\.\.?\/[^'"]+)['"]/g;
  const dynamicImport = /\bimport\s*\(\s*['"](\.\.?\/[^'"]+)['"]/g;
  for (const expression of [declaration, dynamicImport]) {
    for (const match of source.matchAll(expression)) specifiers.add(match[1]);
  }
  return specifiers;
}

test('renderer browser vendor graph has exact import-map coverage for CodeMirror, Tiptap, and Sentry', async () => {
  const html = await readFile(path.join(rendererRoot, 'index.html'), 'utf8');
  const imports = readImportMap(html).imports;
  const requiredEntries = [
    'codemirror',
    '@codemirror/lang-javascript',
    '@codemirror/lang-json',
    '@codemirror/lang-markdown',
    '@codemirror/lang-sql',
    '@codemirror/lang-yaml',
    '@codemirror/language',
    '@codemirror/state',
    '@codemirror/legacy-modes/mode/shell',
    '@codemirror/legacy-modes/mode/sql',
    '@tiptap/core',
    '@tiptap/extension-code-block-lowlight',
    '@tiptap/starter-kit',
    '@tiptap/extension-image',
    '@tiptap/extension-table',
    'highlight.js/lib/core',
    'lowlight',
    '@sentry/electron/renderer',
  ];
  for (const specifier of requiredEntries) {
    assert.equal(typeof imports[specifier], 'string', `missing generated import-map entry for ${specifier}`);
  }
  assert.equal(
    imports['@codemirror/legacy-modes/mode/shell'],
    './vendor/codemirror-legacy-modes-shell.js'
  );
  assert.equal(imports['@codemirror/legacy-modes/mode/sql'], './vendor/codemirror-legacy-modes-sql.js');

  const highlightLanguageSpecifiers = Object.keys(imports)
    .filter((specifier) => specifier.startsWith('highlight.js/lib/languages/'))
    .sort();
  assert.equal(highlightLanguageSpecifiers.length, 37, 'Lowlight common must vendor exactly 37 grammars');
  assert.equal(imports['highlight.js'], undefined, 'the CommonJS Highlight.js root must not enter the browser graph');
  assert.equal(imports['highlight.js/lib/common'], undefined, 'the CommonJS Highlight.js common wrapper is unused');

  const highlightCore = await readFile(
    path.resolve(rendererRoot, imports['highlight.js/lib/core']),
    'utf8',
  );
  assert.match(highlightCore, /export \{ highlight as HighlightJS \};\s*export default highlight;/);
  assert.doesNotMatch(highlightCore, /\bmodule\.exports\b|\brequire\s*\(/);
  const lowlightFacade = await readFile(path.resolve(rendererRoot, imports.lowlight), 'utf8');
  assert.match(lowlightFacade, /grammars as common/);
  assert.match(lowlightFacade, /createLowlight/);
  assert.doesNotMatch(lowlightFacade, /\ball\b/);

  const tipTapPmManifest = JSON.parse(
    await readFile(path.join(__dirname, '..', 'node_modules', '@tiptap', 'pm', 'package.json'), 'utf8')
  );
  const tipTapPmSpecifiers = Object.keys(tipTapPmManifest.exports)
    .filter((exportKey) => exportKey.startsWith('./') && !exportKey.includes('*'))
    .map((exportKey) => `@tiptap/pm${exportKey.slice(1)}`)
    .sort();
  assert.equal(imports['@tiptap/pm'], undefined, '@tiptap/pm intentionally has no root export');
  assert.deepEqual(
    Object.keys(imports)
      .filter((specifier) => specifier.startsWith('@tiptap/pm/'))
      .sort(),
    tipTapPmSpecifiers
  );
  for (const specifier of [
    'prosemirror-commands',
    'prosemirror-model',
    'prosemirror-state',
    'prosemirror-tables',
    'prosemirror-transform',
    'prosemirror-view',
    'orderedmap',
    'rope-sequence',
    'w3c-keyname',
  ]) {
    assert.equal(typeof imports[specifier], 'string', `missing recursive Tiptap dependency ${specifier}`);
  }

  assert.deepEqual(Object.keys(imports), Object.keys(imports).sort(), 'import-map entries must be stable');
  assert.equal(
    Object.keys(imports).some((specifier) => specifier.endsWith('/')),
    false,
    'import-map entries must map exact specifiers instead of package prefixes'
  );
  assert.equal(
    new Set(Object.values(imports)).size,
    Object.keys(imports).length,
    'each exact import-map entry must own one vendor file'
  );

  for (const [specifier, target] of Object.entries(imports)) {
    assert.match(target, /^\.\/vendor\/(?:[a-zA-Z0-9@._+-]+\/)*[a-zA-Z0-9@._+-]+\.js$/);
    const targetPath = path.resolve(rendererRoot, target);
    assert.equal((await stat(targetPath)).isFile(), true, `${specifier} must map to a copied vendor file`);
  }

  const visitedModules = new Set();
  async function verifyRelativeClosure(file) {
    if (visitedModules.has(file)) return;
    visitedModules.add(file);
    const source = await readFile(file, 'utf8');
    for (const specifier of relativeModuleSpecifiers(source)) {
      const dependency = path.resolve(path.dirname(file), specifier);
      assert.equal((await stat(dependency)).isFile(), true, `${file} must retain ${specifier}`);
      await verifyRelativeClosure(dependency);
    }
  }
  for (const target of Object.values(imports)) {
    await verifyRelativeClosure(path.resolve(rendererRoot, target));
  }

  for (const file of visitedModules) {
    const source = await readFile(file, 'utf8');
    for (const specifier of bareModuleSpecifiers(source)) {
      assert.equal(
        typeof imports[specifier],
        'string',
        `${path.relative(rendererRoot, file)} imports ${specifier}, which is absent from the generated import map`
      );
    }
  }

  const notesPage = await readFile(path.join(rendererRoot, 'pages', 'notesPage.js'), 'utf8');
  for (const specifier of bareModuleSpecifiers(notesPage)) {
    assert.equal(
      typeof imports[specifier],
      'string',
      `compiled Notes page imports ${specifier}, which is absent from the generated import map`
    );
  }
  const richTextEditor = await readFile(path.join(rendererRoot, 'components', 'notesRichTextEditor.js'), 'utf8');
  for (const specifier of bareModuleSpecifiers(richTextEditor)) {
    assert.equal(
      typeof imports[specifier],
      'string',
      `compiled Rich Text editor imports ${specifier}, which is absent from the generated import map`
    );
  }
});
