const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('host dialog keeps compact editor structure and non-misleading labels', async () => {
  const rendererDir = path.join(__dirname, '..', 'dist', 'renderer');
  const [html, renderer, styles] = await Promise.all([
    readFile(path.join(rendererDir, 'index.html'), 'utf8'),
    readFile(path.join(rendererDir, 'renderer.js'), 'utf8'),
    readFile(path.join(rendererDir, 'styles.css'), 'utf8'),
  ]);

  assert.match(html, /id="private-key-source-status"/);
  assert.match(html, /id="toggle-private-key-btn"/);
  assert.match(html, /data-empty="No forwarding rules"/);
  assert.match(html, /data-empty="No services"/);
  assert.match(html, /id="use-jump-host"[^>]*class="hidden"/);

  assert.match(renderer, /Exposed Port \(0 = disabled\)/);
  assert.doesNotMatch(renderer, /\n\s*Local Port \(Optional\)\n/);
  assert.doesNotMatch(renderer, /\n\s*Remote Port \(Optional\)\n/);
  assert.doesNotMatch(renderer, /\n\s*Exposed Port \(Optional\)\n/);

  assert.match(styles, /\.form-actions\s*\{[\s\S]*position: sticky/);
  assert.match(styles, /\.editor-summary\s*\{/);
});
