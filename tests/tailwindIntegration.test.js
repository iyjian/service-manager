const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('renderer includes a separate Tailwind utility stylesheet', async () => {
  const rendererDir = path.join(__dirname, '..', 'dist', 'renderer');
  const [html, tailwind] = await Promise.all([
    readFile(path.join(rendererDir, 'index.html'), 'utf8'),
    readFile(path.join(rendererDir, 'tailwind.css'), 'utf8'),
  ]);

  assert.match(html, /<link rel="stylesheet" href="\.\/styles\.css" \/>/);
  assert.match(html, /<link rel="stylesheet" href="\.\/tailwind\.css" \/>/);
  assert.ok(existsSync(path.join(rendererDir, 'tailwind.css')));
  assert.doesNotMatch(tailwind, /Tailwind CSS placeholder/);
  assert.match(tailwind, /\.host-panel/);
});

test('Tailwind is configured without preflight to avoid global reset drift', async () => {
  const config = await readFile(path.join(__dirname, '..', 'tailwind.config.cjs'), 'utf8');
  const input = await readFile(path.join(__dirname, '..', 'src', 'renderer', 'tailwind.css'), 'utf8');
  const pkg = JSON.parse(await readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));

  assert.match(config, /preflight:\s*false/);
  assert.match(input, /@tailwind utilities/);
  assert.equal(typeof pkg.devDependencies.tailwindcss, 'string');
});

test('runtime action buttons keep interactive and busy states explicit', async () => {
  const [renderer, tailwind] = await Promise.all([
    readFile(path.join(__dirname, '..', 'src', 'renderer', 'renderer.ts'), 'utf8'),
    readFile(path.join(__dirname, '..', 'src', 'renderer', 'tailwind.css'), 'utf8'),
  ]);

  assert.match(renderer, /runtime-action-btn-\$\{actionKind\}/);
  assert.match(renderer, /aria-busy="\$\{isBusy \? 'true' : 'false'\}"/);
  assert.match(renderer, /runtime-action-spinner/);
  assert.match(renderer, /m4 3\.5l5 5l-5 5zM21 20v-2H3v2/);
  assert.match(renderer, /M2 5h8l-4 5zM21 20v-2H3v2/);
  assert.match(renderer, /renderHostToggleIcon\(isCollapsed\)/);
  assert.match(renderer, /class="host-toggle-btn"[\s\S]*?<span class="host-panel-name">/);
  assert.match(renderer, /M12 2C6\.5 2 2 6\.5 2 12v10h20V12c0-5\.5-4\.5-10-10-10/);
  assert.match(renderer, /M5\.126 18\.874q-\.357-\.357-\.357-\.874t\.357-\.874/);
  assert.match(tailwind, /\.host-toggle-icon,\s*\.host-toggle-icon svg\s*\{[^}]*@apply block;[^}]*height:\s*18px;[^}]*width:\s*18px;/);
  assert.match(tailwind, /\.runtime-action-btn:not\(:disabled\):hover/);
  assert.match(tailwind, /\.runtime-action-btn:focus-visible/);
  assert.match(tailwind, /\.runtime-action-btn\s*\{/);
  assert.match(tailwind, /cursor-pointer/);
  assert.doesNotMatch(tailwind, /\.runtime-action-btn:not\(:disabled\):hover\s*\{[^}]*transform:/);
  assert.doesNotMatch(tailwind, /\.runtime-action-btn:not\(:disabled\):active\s*\{[^}]*transform:/);
  assert.doesNotMatch(tailwind, /\.runtime-row:hover/);
  assert.doesNotMatch(tailwind, /hover:bg-white/);
  assert.match(tailwind, /@keyframes runtime-spin/);
});
