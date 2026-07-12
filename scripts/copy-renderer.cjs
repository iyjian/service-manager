const { copyFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outDir = join(root, 'dist', 'renderer');

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
