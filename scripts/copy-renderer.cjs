const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { dirname, join, resolve, sep } = require('node:path');

const root = join(__dirname, '..');
const outDir = join(root, 'dist', 'renderer');
const vendorDir = join(outDir, 'vendor');
const sharedRichTextRuntime = join(root, 'dist', 'shared', 'noteRichText.js');
const mainRichTextRuntime = join(root, 'dist', 'main', 'noteRichText.cjs');
const rendererRichTextRuntime = join(outDir, 'noteRichText.js');

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
const tipTapSeedPackages = Object.freeze([
  '@tiptap/core',
  '@tiptap/starter-kit',
  '@tiptap/extension-image',
  '@tiptap/extension-table',
  '@tiptap/pm',
]);
const legacyModeSpecifiers = Object.freeze([
  '@codemirror/legacy-modes/mode/shell',
  '@codemirror/legacy-modes/mode/sql',
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

function resolvePackageRoot(name, requesterRoot) {
  const requesterRequire = createRequire(join(requesterRoot, 'package.json'));
  try {
    return findPackageRoot(name, requesterRequire.resolve(name));
  } catch (resolveError) {
    // Packages such as @tiptap/pm intentionally expose only subpaths, so
    // resolving the package root through Node's exports algorithm fails. Walk
    // the same package search paths without bypassing dependency ownership.
    for (const searchPath of requesterRequire.resolve.paths(name) ?? []) {
      const candidate = join(searchPath, name);
      const manifest = join(candidate, 'package.json');
      if (existsSync(manifest) && readPackage(candidate).name === name) {
        return realpathSync(candidate);
      }
    }
    throw resolveError;
  }
}

function collectBrowserPackages(initialRequests) {
  const packages = new Map();
  const pending = [...initialRequests];

  while (pending.length > 0) {
    const { name, requesterRoot } = pending.shift();
    const packageRoot = resolvePackageRoot(name, requesterRoot);
    const existingRoot = packages.get(name);
    if (existingRoot) {
      if (existingRoot !== packageRoot) {
        throw new Error(
          `Renderer browser graph contains multiple installed versions of ${name}; a single import map cannot select both`
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

function esmExportTarget(definition) {
  if (typeof definition === 'string') return definition;
  if (!definition || typeof definition !== 'object') return undefined;
  if (typeof definition.import === 'string') return definition.import;
  if (definition.import && typeof definition.import === 'object') {
    return esmExportTarget(definition.import);
  }
  if (typeof definition.browser === 'string') return definition.browser;
  if (typeof definition.default === 'string') return definition.default;
  return undefined;
}

function rootExportDefinition(exports) {
  if (typeof exports === 'string') return exports;
  if (!exports || typeof exports !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(exports, '.')) return exports['.'];
  if (Object.keys(exports).some((key) => key.startsWith('.'))) return undefined;
  return exports;
}

function browserEsmEntries(packageRoot) {
  const packageJson = readPackage(packageRoot);
  const rootTarget = esmExportTarget(rootExportDefinition(packageJson.exports)) ?? packageJson.module;
  const entries = [];
  if (typeof rootTarget === 'string') {
    const entry = join(packageRoot, rootTarget);
    if (!existsSync(entry)) {
      throw new Error(`Missing browser ESM entry for ${packageJson.name}`);
    }
    entries.push({ specifier: packageJson.name, entry });
  }

  for (const [exportKey, definition] of Object.entries(packageJson.exports ?? {})) {
    if (exportKey === '.' || !exportKey.startsWith('./') || exportKey.includes('*')) continue;
    const target = esmExportTarget(definition);
    if (typeof target !== 'string' || !/\.m?js$/i.test(target)) continue;
    const entry = join(packageRoot, target);
    if (!existsSync(entry)) {
      throw new Error(`Missing browser ESM entry for ${packageJson.name}${exportKey.slice(1)}`);
    }
    entries.push({ specifier: `${packageJson.name}${exportKey.slice(1)}`, entry });
  }
  if (entries.length === 0) {
    throw new Error(`Package ${packageJson.name} has no browser ESM entry`);
  }
  return entries.sort((left, right) => compareNames(left.specifier, right.specifier));
}

function exportedWildcardEsmEntry(packageRoot, exportKey, wildcard) {
  const packageJson = readPackage(packageRoot);
  const definition = packageJson.exports?.[exportKey];
  const exported = esmExportTarget(definition);
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

function claimVendorFileName(specifier, outputOwners) {
  const preferredName = vendorFileName(specifier);
  const preferredOwner = outputOwners.get(preferredName);
  if (!preferredOwner) {
    outputOwners.set(preferredName, specifier);
    return preferredName;
  }
  if (preferredOwner === specifier) {
    throw new Error(`Duplicate renderer vendor entry for ${specifier}`);
  }

  const digest = createHash('sha256').update(specifier).digest('hex').slice(0, 8);
  const collisionName = preferredName.replace(/\.js$/, `-${digest}.js`);
  const collisionOwner = outputOwners.get(collisionName);
  if (collisionOwner) {
    throw new Error(`Renderer vendor filename collision between ${collisionOwner} and ${specifier}`);
  }
  outputOwners.set(collisionName, specifier);
  return collisionName;
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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

function copyBrowserModule(entry, outputPath, packageRoot, copiedModules) {
  const sourcePath = realpathSync(entry);
  const output = resolve(outputPath);
  const allowedSourceRoot = `${realpathSync(packageRoot)}${sep}`;
  const allowedOutputRoot = `${resolve(outDir)}${sep}`;
  if (!sourcePath.startsWith(allowedSourceRoot) || !output.startsWith(allowedOutputRoot)) {
    throw new Error(`Renderer relative module escaped its package or output root: ${entry}`);
  }
  const owner = copiedModules.get(output);
  if (owner) {
    if (owner !== sourcePath) {
      throw new Error(`Renderer module output collision between ${owner} and ${sourcePath}`);
    }
    return;
  }
  copiedModules.set(output, sourcePath);
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(sourcePath, output);

  const source = readFileSync(sourcePath, 'utf8');
  for (const specifier of relativeModuleSpecifiers(source)) {
    const dependency = resolve(dirname(sourcePath), specifier);
    if (!existsSync(dependency)) {
      throw new Error(`Missing renderer relative module ${specifier} from ${sourcePath}`);
    }
    copyBrowserModule(
      dependency,
      resolve(dirname(output), specifier),
      packageRoot,
      copiedModules,
    );
  }
}

function copyBrowserVendor() {
  const legacyPackageName = '@codemirror/legacy-modes';
  const legacyRoots = legacyModeSpecifiers.map((specifier) =>
    findPackageRoot(legacyPackageName, rootRequire.resolve(specifier))
  );
  const legacyRoot = legacyRoots[0];
  if (!legacyRoot || legacyRoots.some((candidate) => candidate !== legacyRoot)) {
    throw new Error('CodeMirror legacy mode exports must resolve from one installed package');
  }
  const initialRequests = [...codeMirrorSeedPackages, ...tipTapSeedPackages].map((name) => ({
    name,
    requesterRoot: root,
  }));
  for (const dependency of Object.keys(readPackage(legacyRoot).dependencies ?? {}).sort()) {
    initialRequests.push({ name: dependency, requesterRoot: legacyRoot });
  }
  const packages = collectBrowserPackages(initialRequests);
  const imports = new Map();
  const outputOwners = new Map();
  const copiedModules = new Map();

  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });

  for (const [name, packageRoot] of [...packages].sort(([left], [right]) => compareNames(left, right))) {
    for (const { specifier, entry } of browserEsmEntries(packageRoot)) {
      const outputName = claimVendorFileName(specifier, outputOwners);
      copyBrowserModule(entry, join(vendorDir, outputName), packageRoot, copiedModules);
      imports.set(specifier, `./vendor/${outputName}`);
    }
  }

  for (const specifier of legacyModeSpecifiers) {
    const modeName = specifier.slice(specifier.lastIndexOf('/') + 1);
    const outputName = `codemirror-legacy-modes-${modeName}.js`;
    const outputOwner = outputOwners.get(outputName);
    if (outputOwner) {
      throw new Error(`Renderer vendor filename collision between ${outputOwner} and ${specifier}`);
    }
    outputOwners.set(outputName, specifier);
    copyFileSync(exportedWildcardEsmEntry(legacyRoot, './mode/*', modeName), join(vendorDir, outputName));
    imports.set(specifier, `./vendor/${outputName}`);
  }
  return imports;
}

function copyRendererHtml(imports) {
  const sourcePath = join(root, 'src', 'renderer', 'index.html');
  const source = readFileSync(sourcePath, 'utf8');
  const importMapPattern = /<script type="importmap">[\s\S]*?<\/script>/;
  if (!importMapPattern.test(source)) {
    throw new Error('Renderer HTML is missing its browser import-map placeholder');
  }

  const sortedImports = Object.fromEntries([...imports].sort(([left], [right]) => compareNames(left, right)));
  const importMapJson = JSON.stringify({ imports: sortedImports }, null, 2)
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
  const importMap = `<script type="importmap">\n${importMapJson}\n    </script>`;
  writeFileSync(join(outDir, 'index.html'), source.replace(importMapPattern, importMap));
}

function finalizeDualTargetRichTextRuntime() {
  if (!existsSync(sharedRichTextRuntime)) {
    throw new Error('The renderer rich text runtime was not emitted.');
  }
  // The shared TypeScript source is compiled once as CommonJS for Electron's
  // main process and once as ESM for the sandboxed browser renderer. Preserve
  // each artifact at the path consumed by that runtime, then restore the
  // CommonJS shared output that existing main-process imports require.
  const sharedSource = readFileSync(sharedRichTextRuntime, 'utf8');
  if (/^export\s|\nexport\s/m.test(sharedSource)) {
    copyFileSync(sharedRichTextRuntime, rendererRichTextRuntime);
  } else {
    const rendererSource = existsSync(rendererRichTextRuntime)
      ? readFileSync(rendererRichTextRuntime, 'utf8')
      : '';
    if (!/^export\s|\nexport\s/m.test(rendererSource)) {
      throw new Error('The renderer rich text ESM runtime is unavailable. Run build:renderer first.');
    }
  }
  if (existsSync(mainRichTextRuntime)) {
    copyFileSync(mainRichTextRuntime, sharedRichTextRuntime);
  }
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
finalizeDualTargetRichTextRuntime();
copyRendererHtml(copyBrowserVendor());
