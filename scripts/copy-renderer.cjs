const { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } = require('node:fs');
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');

const root = join(__dirname, '..');
const outDir = join(root, 'dist', 'renderer');
const vendorDir = join(outDir, 'vendor');

const codeMirrorVendorFiles = new Map([
  ['codemirror', 'codemirror.js'],
  ['@codemirror/autocomplete', 'codemirror-autocomplete.js'],
  ['@codemirror/commands', 'codemirror-commands.js'],
  ['@codemirror/language', 'codemirror-language.js'],
  ['@codemirror/lint', 'codemirror-lint.js'],
  ['@codemirror/search', 'codemirror-search.js'],
  ['@codemirror/state', 'codemirror-state.js'],
  ['@codemirror/view', 'codemirror-view.js'],
  ['@lezer/common', 'lezer-common.js'],
  ['@lezer/highlight', 'lezer-highlight.js'],
  ['@lezer/lr', 'lezer-lr.js'],
  ['@marijn/find-cluster-break', 'find-cluster-break.js'],
  ['crelt', 'crelt.js'],
  ['style-mod', 'style-mod.js'],
  ['w3c-keyname', 'w3c-keyname.js'],
]);

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

function collectCodeMirrorPackages() {
  const codeMirrorRoot = realpathSync(join(root, 'node_modules', 'codemirror'));
  const packages = new Map([['codemirror', codeMirrorRoot]]);
  const pending = ['codemirror'];

  while (pending.length > 0) {
    const name = pending.shift();
    const packageRoot = packages.get(name);
    const packageJson = readPackage(packageRoot);
    const packageRequire = createRequire(join(packageRoot, 'package.json'));
    for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
      if (packages.has(dependency)) continue;
      const dependencyRoot = findPackageRoot(dependency, packageRequire.resolve(dependency));
      packages.set(dependency, dependencyRoot);
      pending.push(dependency);
    }
  }
  return packages;
}

function esmEntry(packageRoot) {
  const packageJson = readPackage(packageRoot);
  const exported = packageJson.exports?.import ?? packageJson.exports?.['.']?.import;
  const relativeEntry = exported ?? packageJson.module;
  if (typeof relativeEntry !== 'string') {
    throw new Error(`Package ${packageJson.name} has no browser ESM entry`);
  }
  return join(packageRoot, relativeEntry);
}

function copyCodeMirrorVendor() {
  const packages = collectCodeMirrorPackages();
  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });
  for (const [name, outputName] of codeMirrorVendorFiles) {
    const packageRoot = packages.get(name);
    if (!packageRoot) throw new Error(`Missing CodeMirror browser dependency: ${name}`);
    copyFileSync(esmEntry(packageRoot), join(vendorDir, outputName));
  }
}

mkdirSync(outDir, { recursive: true });
copyFileSync(join(root, 'src', 'renderer', 'index.html'), join(outDir, 'index.html'));
copyFileSync(join(root, 'src', 'renderer', 'styles.css'), join(outDir, 'styles.css'));
copyFileSync(join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), join(outDir, 'xterm.css'));
copyFileSync(join(root, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'), join(outDir, 'xterm.js'));
copyFileSync(join(root, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'), join(outDir, 'xterm-fit.js'));
copyFileSync(
  join(root, 'node_modules', 'js-yaml', 'dist', 'browser', 'js-yaml.umd.min.js'),
  join(outDir, 'js-yaml.umd.min.js')
);
copyCodeMirrorVendor();
