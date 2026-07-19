const { copyFileSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const sharedRichText = join(root, 'dist', 'shared', 'noteRichText.js');
const mainRuntime = join(root, 'dist', 'main', 'noteRichText.cjs');

if (!existsSync(sharedRichText)) {
  throw new Error('The main-process rich text runtime was not emitted.');
}

mkdirSync(join(root, 'dist', 'main'), { recursive: true });
copyFileSync(sharedRichText, mainRuntime);
