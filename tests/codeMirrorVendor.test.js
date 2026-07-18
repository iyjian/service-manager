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

test('CodeMirror browser vendor graph has generated import-map coverage for every bare dependency', async () => {
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
  ];
  for (const specifier of requiredEntries) {
    assert.equal(typeof imports[specifier], 'string', `missing generated import-map entry for ${specifier}`);
  }

  const vendorRoot = path.join(rendererRoot, 'vendor');
  const vendorFiles = (await readdir(vendorRoot)).filter((name) => name.endsWith('.js')).sort();
  assert.equal(vendorFiles.length, Object.keys(imports).length);

  for (const [specifier, target] of Object.entries(imports)) {
    assert.match(target, /^\.\/vendor\/[a-zA-Z0-9.-]+\.js$/);
    const targetPath = path.resolve(rendererRoot, target);
    assert.equal((await stat(targetPath)).isFile(), true, `${specifier} must map to a copied vendor file`);
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
