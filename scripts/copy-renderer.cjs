const { copyFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outDir = join(root, 'dist', 'renderer');

mkdirSync(outDir, { recursive: true });
copyFileSync(join(root, 'src', 'renderer', 'index.html'), join(outDir, 'index.html'));
copyFileSync(join(root, 'src', 'renderer', 'styles.css'), join(outDir, 'styles.css'));
