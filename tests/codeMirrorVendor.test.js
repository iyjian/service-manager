const assert = require('node:assert/strict');
const { readdir, readFile, stat } = require('node:fs/promises');
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

test('renderer browser vendor graph has exact import-map coverage for CodeMirror and Tiptap', async () => {
  const html = await readFile(path.join(rendererRoot, 'index.html'), 'utf8');
  const imports = readImportMap(html).imports;
  const requiredEntries = [
    'codemirror',
    '@codemirror/lang-javascript',
    '@codemirror/lang-json',
    '@codemirror/lang-markdown',
    '@codemirror/lang-yaml',
    '@codemirror/language',
    '@codemirror/state',
    '@codemirror/legacy-modes/mode/shell',
    '@codemirror/legacy-modes/mode/sql',
    '@tiptap/core',
    '@tiptap/starter-kit',
    '@tiptap/extension-image',
    '@tiptap/extension-table',
  ];
  for (const specifier of requiredEntries) {
    assert.equal(typeof imports[specifier], 'string', `missing generated import-map entry for ${specifier}`);
  }
  assert.equal(
    imports['@codemirror/legacy-modes/mode/shell'],
    './vendor/codemirror-legacy-modes-shell.js'
  );
  assert.equal(imports['@codemirror/legacy-modes/mode/sql'], './vendor/codemirror-legacy-modes-sql.js');

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

  const vendorRoot = path.join(rendererRoot, 'vendor');
  const vendorFiles = (await readdir(vendorRoot)).filter((name) => name.endsWith('.js')).sort();
  assert.equal(vendorFiles.length, Object.keys(imports).length);

  for (const [specifier, target] of Object.entries(imports)) {
    assert.match(target, /^\.\/vendor\/[a-zA-Z0-9.-]+\.js$/);
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

  for (const file of vendorFiles) {
    const source = await readFile(path.join(vendorRoot, file), 'utf8');
    for (const specifier of bareModuleSpecifiers(source)) {
      assert.equal(
        typeof imports[specifier],
        'string',
        `${file} imports ${specifier}, which is absent from the generated import map`
      );
    }
  }

  const notesPage = await readFile(path.join(rendererRoot, 'notesPage.js'), 'utf8');
  for (const specifier of bareModuleSpecifiers(notesPage)) {
    assert.equal(
      typeof imports[specifier],
      'string',
      `compiled Notes page imports ${specifier}, which is absent from the generated import map`
    );
  }
});
