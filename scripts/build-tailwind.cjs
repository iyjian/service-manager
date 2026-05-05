const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = join(__dirname, '..');
const output = join(root, 'dist', 'renderer', 'tailwind.css');

mkdirSync(dirname(output), { recursive: true });

let cliPath;
try {
  cliPath = require.resolve('tailwindcss/lib/cli.js', { paths: [root] });
} catch {
  writeFileSync(
    output,
    '/* Tailwind CSS placeholder. Run pnpm install to enable Tailwind utility generation. */\n',
    'utf8'
  );
  console.warn('[build:css] tailwindcss is not installed; wrote placeholder dist/renderer/tailwind.css.');
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [
    cliPath,
    '-c',
    join(root, 'tailwind.config.cjs'),
    '-i',
    join(root, 'src', 'renderer', 'tailwind.css'),
    '-o',
    output,
    '--minify',
  ],
  {
    cwd: root,
    stdio: 'inherit',
  }
);

process.exit(result.status ?? 1);
