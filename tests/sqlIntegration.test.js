const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('compiled SQL page uses the narrow main-process bridge and Service Manager layout', async () => {
  const dist = path.join(__dirname, '..', 'dist');
  const html = await readFile(path.join(dist, 'renderer', 'index.html'), 'utf8');
  const page = await readFile(path.join(dist, 'renderer', 'sqlPage.js'), 'utf8');
  const styles = await readFile(path.join(dist, 'renderer', 'tailwind.css'), 'utf8');
  const preload = await readFile(path.join(dist, 'main', 'preload.js'), 'utf8');
  const main = await readFile(path.join(dist, 'main', 'main.js'), 'utf8');

  assert.match(html, /data-page="sql"/);
  assert.match(html, /id="sql-production-tab"/);
  assert.match(html, /id="sql-development-tab"/);
  assert.match(html, /id="sql-query-list"/);
  assert.match(html, /id="sql-query-tabs"/);
  assert.match(html, /id="sql-save-shortcut"/);
  assert.match(html, /id="sql-run-shortcut"/);
  assert.match(html, /id="sql-value-dialog"/);
  assert.match(html, /id="sql-value-modes"/);
  assert.match(html, /id="sql-value-content"/);
  assert.doesNotMatch(html, /id="sql-result-status"/);
  assert.match(html, /class="sql-shortcut-prefix">Tips:<\/span>/);
  assert.doesNotMatch(html, /<h1[^>]*>\s*SQL\s*<\/h1>/);
  assert.doesNotMatch(html, /id="sql-query-count"/);
  assert.doesNotMatch(html, /<h[1-6][^>]*>\s*Saved Queries(?:\s*\([^)]*\))?\s*<\/h[1-6]>/i);
  assert.match(
    html,
    /class="sql-sidebar-tools">[\s\S]*id="sql-query-search"[\s\S]*id="sql-refresh-queries"[\s\S]*id="sql-new-query"[\s\S]*<\/div>\s*<div id="sql-query-list"/,
  );
  assert.doesNotMatch(html, /id="sql-(?:run|save|delete|query-name)"/);
  assert.doesNotMatch(html, /sql-active-environment|sql-query-toolbar-meta/);
  assert.match(html, /class="sql-query-toolbar">\s*<div id="sql-query-tabs"[^>]*><\/div>\s*<\/div>/);
  assert.match(html, /class="sql-session-actions"[\s\S]*id="sql-save-shortcut"[\s\S]*id="sql-run-shortcut"[\s\S]*id="sql-session-user"[\s\S]*id="sql-sign-out"/);
  assert.doesNotMatch(html, />Mine<|>All<|>Others</);
  assert.match(styles, /\.sql-workspace/);
  assert.match(styles, /\.sql-query-tab-dirty/);
  assert.match(styles, /max-width:200px/);
  assert.match(styles, /\.sql-query-tab\[data-dirty=true\] \.sql-query-tab-close/);
  assert.match(styles, /\.sql-query-row-edit/);
  assert.match(styles, /\.sql-result-table/);
  assert.match(styles, /\.sql-result-table-wrap\{[^}]*width:max-content/);
  assert.match(styles, /\.sql-result-cell-value\{[^}]*max-width:320px[^}]*white-space:nowrap/);
  assert.match(styles, /\.sql-result-cell-detail/);
  assert.match(styles, /\.sql-value-dialog/);
  assert.match(styles, /\.sql-value-json-editor/);
  assert.match(styles, /\.sql-value-html-frame\{[^}]*pointer-events:none/);
  assert.match(page, /resolveSqlStatement/);
  assert.match(page, /isSqlRunShortcut/);
  assert.match(page, /isSqlSaveShortcut/);
  assert.match(page, /window\.sqlApi\.renameQuery/);
  assert.match(page, /window\.sqlApi\.execute/);
  assert.match(page, /sqlCellPresentation/);
  assert.match(page, /Formatted JSON cell value/);
  assert.match(page, /formatSqlDuration/);
  assert.match(page, /highlightAuto/);
  assert.match(page, /setAttribute\(['"]sandbox['"], ['"]{2}\)/);
  assert.match(page, /Content-Security-Policy/);
  assert.match(page, /new DOMParser\(\)\.parseFromString/);
  assert.match(page, /form-action 'none'/);
  assert.match(page, /script,noscript,style,meta,base,link,iframe/);
  assert.match(page, /durationMs/);
  assert.doesNotMatch(page, /resultStatus/);
  assert.match(page, /sessionUser\.textContent = user\?\.userName \?\? ['"]{2}/);
  assert.doesNotMatch(page, /sessionUser\.textContent\s*=.*user\?\.name/);
  assert.match(page, /textContent = formatSqlCell/);
  assert.doesNotMatch(page, /innerHTML\s*=\s*[^;]*(?:record\.name|result|row\[)/);

  for (const channel of [
    'sql:auth-state',
    'sql:login',
    'sql:logout',
    'sql:queries:list',
    'sql:query:get',
    'sql:query:create',
    'sql:query:update',
    'sql:query:rename',
    'sql:query:delete',
    'sql:execute',
  ]) {
    assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(main, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(main, /CmdOrCtrl\+Alt\+R/);
  assert.doesNotMatch(preload, /sd-pc\.tiusolution|sd-pc\.dev\.tiusolution|private-token|passwd/);
});
