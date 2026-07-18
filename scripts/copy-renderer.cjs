const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');

const root = join(__dirname, '..');
const outDir = join(root, 'dist', 'renderer');
const vendorDir = join(outDir, 'vendor');

const rootRequire = createRequire(join(root, 'package.json'));
const codeMirrorSeedPackages = Object.freeze([
  'codemirror',
  '@codemirror/lang-javascript',
  '@codemirror/lang-json',
  '@codemirror/lang-markdown',
  '@codemirror/lang-yaml',
  '@codemirror/language',
  '@codemirror/state',
]);
const legacyShellSpecifier = '@codemirror/legacy-modes/mode/shell';

function readPackage(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
}

function findPackageRoot(name, resolvedEntry) {
  let current = dirname(realpathSync(resolvedEntry));
  while (current !== dirname(current)) {
    const manifest = join(current, 'package.json');
    if (existsSync(manifest) && readPackage(current).name === name) return current;
    current = dirname(current);
  }
  throw new Error(`Unable to locate package root for ${name}`);
}

function resolvePackageRoot(name, requesterRoot) {
  const requesterRequire = createRequire(join(requesterRoot, 'package.json'));
  return findPackageRoot(name, requesterRequire.resolve(name));
}

function collectCodeMirrorPackages(initialRequests) {
  const packages = new Map();
  const pending = [...initialRequests];

  while (pending.length > 0) {
    const { name, requesterRoot } = pending.shift();
    const packageRoot = resolvePackageRoot(name, requesterRoot);
    const existingRoot = packages.get(name);
    if (existingRoot) {
      if (existingRoot !== packageRoot) {
        throw new Error(
          `CodeMirror browser graph contains multiple installed versions of ${name}; a single import map cannot select both`
        );
      }
      continue;
    }
    packages.set(name, packageRoot);
    const packageJson = readPackage(packageRoot);
    for (const dependency of Object.keys(packageJson.dependencies ?? {}).sort()) {
      pending.push({ name: dependency, requesterRoot: packageRoot });
    }
  }
  return packages;
}

function esmEntry(packageRoot) {
  const packageJson = readPackage(packageRoot);
  const rootExport = packageJson.exports;
  const dotExport = typeof rootExport === 'object' ? rootExport?.['.'] : undefined;
  const exported =
    (typeof rootExport === 'string' ? rootExport : rootExport?.import) ??
    (typeof dotExport === 'string' ? dotExport : dotExport?.import);
  const relativeEntry = exported ?? packageJson.module;
  if (typeof relativeEntry !== 'string') {
    throw new Error(`Package ${packageJson.name} has no browser ESM entry`);
  }
  return join(packageRoot, relativeEntry);
}

function exportedWildcardEsmEntry(packageRoot, exportKey, wildcard) {
  const packageJson = readPackage(packageRoot);
  const definition = packageJson.exports?.[exportKey];
  const exported = typeof definition === 'string' ? definition : definition?.import;
  if (typeof exported !== 'string' || !exported.includes('*')) {
    throw new Error(`Package ${packageJson.name} has no ESM wildcard export for ${exportKey}`);
  }
  const entry = join(packageRoot, exported.replace('*', wildcard));
  if (!existsSync(entry)) {
    throw new Error(`Missing browser ESM entry for ${packageJson.name}/${wildcard}`);
  }
  return entry;
}

function vendorFileName(packageName) {
  return `${packageName.replace(/^@/, '').replace(/[^a-zA-Z0-9.-]+/g, '-')}.js`;
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function copyCodeMirrorVendor() {
  const legacyRoot = findPackageRoot(legacyShellSpecifier.split('/mode/')[0], rootRequire.resolve(legacyShellSpecifier));
  const initialRequests = codeMirrorSeedPackages.map((name) => ({ name, requesterRoot: root }));
  for (const dependency of Object.keys(readPackage(legacyRoot).dependencies ?? {}).sort()) {
    initialRequests.push({ name: dependency, requesterRoot: legacyRoot });
  }
  const packages = collectCodeMirrorPackages(initialRequests);
  const imports = new Map();
  const outputOwners = new Map();

  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });

  for (const [name, packageRoot] of [...packages].sort(([left], [right]) => compareNames(left, right))) {
    const outputName = vendorFileName(name);
    const outputOwner = outputOwners.get(outputName);
    if (outputOwner) {
      throw new Error(`CodeMirror vendor filename collision between ${outputOwner} and ${name}`);
    }
    outputOwners.set(outputName, name);
    copyFileSync(esmEntry(packageRoot), join(vendorDir, outputName));
    imports.set(name, `./vendor/${outputName}`);
  }

  const shellOutputName = 'codemirror-legacy-modes-shell.js';
  copyFileSync(exportedWildcardEsmEntry(legacyRoot, './mode/*', 'shell'), join(vendorDir, shellOutputName));
  imports.set(legacyShellSpecifier, `./vendor/${shellOutputName}`);
  return imports;
}

function copyRendererHtml(imports) {
  const sourcePath = join(root, 'src', 'renderer', 'index.html');
  const source = readFileSync(sourcePath, 'utf8');
  const importMapPattern = /<script type="importmap">[\s\S]*?<\/script>/;
  if (!importMapPattern.test(source)) {
    throw new Error('Renderer HTML is missing its CodeMirror import-map placeholder');
  }

  const sortedImports = Object.fromEntries([...imports].sort(([left], [right]) => compareNames(left, right)));
  const importMapJson = JSON.stringify({ imports: sortedImports }, null, 2)
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
  const importMap = `<script type="importmap">\n${importMapJson}\n    </script>`;
  writeFileSync(join(outDir, 'index.html'), source.replace(importMapPattern, importMap));
}

mkdirSync(outDir, { recursive: true });
copyFileSync(join(root, 'src', 'renderer', 'styles.css'), join(outDir, 'styles.css'));
copyFileSync(join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), join(outDir, 'xterm.css'));
copyFileSync(join(root, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'), join(outDir, 'xterm.js'));
copyFileSync(join(root, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'), join(outDir, 'xterm-fit.js'));
copyFileSync(
  join(root, 'node_modules', 'js-yaml', 'dist', 'browser', 'js-yaml.umd.min.js'),
  join(outDir, 'js-yaml.umd.min.js')
);
copyRendererHtml(copyCodeMirrorVendor());
