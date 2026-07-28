const { copyFileSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
mkdirSync(join(root, 'dist', 'main'), { recursive: true });
for (const runtime of [
  { shared: 'codeHighlight.js', main: 'codeHighlight.cjs', label: 'code highlight' },
  { shared: 'noteRichText.js', main: 'noteRichText.cjs', label: 'rich text' },
  { shared: 'noteExport.js', main: 'noteExport.cjs', label: 'Note export' },
  { shared: 'notesMarkdown.js', main: 'notesMarkdown.cjs', label: 'Markdown tools' },
  { shared: 'sentryPrivacy.js', main: 'sentryPrivacy.cjs', label: 'Sentry privacy' },
]) {
  const sharedRuntime = join(root, 'dist', 'shared', runtime.shared);
  if (!existsSync(sharedRuntime)) {
    throw new Error(`The main-process ${runtime.label} runtime was not emitted.`);
  }
  copyFileSync(sharedRuntime, join(root, 'dist', 'main', runtime.main));
}
