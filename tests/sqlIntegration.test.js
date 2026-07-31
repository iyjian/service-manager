const assert = require('node:assert/strict');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

test('compiled SQL page uses the narrow main-process bridge and Service Manager layout', async () => {
  const dist = path.join(__dirname, '..', 'dist');
  const html = await readFile(path.join(dist, 'renderer', 'index.html'), 'utf8');
  const page = await readFile(path.join(dist, 'renderer', 'sqlPage.js'), 'utf8');
  const virtualTable = await readFile(path.join(dist, 'renderer', 'sqlVirtualResultTable.js'), 'utf8');
  const styles = await readFile(path.join(dist, 'renderer', 'tailwind.css'), 'utf8');
  const baseStyles = await readFile(path.join(dist, 'renderer', 'styles.css'), 'utf8');
  const preload = await readFile(path.join(dist, 'main', 'preload.js'), 'utf8');
  const main = await readFile(path.join(dist, 'main', 'main.js'), 'utf8');

  assert.match(html, /data-page="sql"/);
  assert.match(html, /id="sql-production-tab"/);
  assert.match(html, /id="sql-development-tab"/);
  assert.match(
    html,
    /id="sql-development-tab"[\s\S]*id="sql-editor-font-controls" class="sql-editor-font-controls hidden"[\s\S]*id="sql-font-size-decrease"[\s\S]*>A−<\/button>[\s\S]*id="sql-font-size-increase"[\s\S]*>A\+<\/button>[\s\S]*data-sql-font-label="default">Default<\/span>[\s\S]*id="sql-font-family-switch"[^>]*role="switch"[^>]*aria-checked="false"[\s\S]*data-sql-font-label="comic-mono">Comic<\/span>/,
  );
  assert.match(html, /id="sql-query-list"/);
  assert.match(html, /id="sql-query-tabs"/);
  assert.match(html, /id="sql-save-shortcut"/);
  assert.match(html, /id="sql-run-shortcut">⌘Enter<\/kbd>/);
  assert.match(html, /id="sql-value-dialog"/);
  assert.match(
    html,
    /id="sql-value-dialog-title">Cell value<\/h2>[\s\S]*id="sql-value-copy-raw"[^>]*aria-label="Copy raw cell value"[^>]*disabled[\s\S]*id="sql-value-kind"/,
  );
  assert.match(html, /id="sql-value-modes"/);
  assert.match(html, /id="sql-value-content"/);
  assert.doesNotMatch(html, /id="sql-result-status"/);
  assert.match(html, /id="sql-session-actions" class="sql-session-actions hidden"/);
  assert.doesNotMatch(html, /Tips:/);
  assert.match(html, /id="sql-save-action"[^>]*data-action="save"[\s\S]*>Save<\/span><kbd id="sql-save-shortcut">⌘S<\/kbd>/);
  assert.match(html, /id="sql-run-action"[^>]*data-action="run"[\s\S]*>Run<\/span><kbd id="sql-run-shortcut">⌘Enter<\/kbd>/);
  assert.match(html, /id="sql-login-environment"[^>]*>Production<\/span>\s*<h2 id="sql-login-title">Sign in<\/h2>/);
  const loginStart = html.indexOf('<section id="sql-signed-out"');
  const loginEnd = html.indexOf('<div id="sql-workspace"', loginStart);
  assert.ok(loginStart >= 0 && loginEnd > loginStart);
  const loginHtml = html.slice(loginStart, loginEnd);
  assert.match(loginHtml, />\s*Username\s*</);
  assert.match(loginHtml, />\s*Password\s*</);
  assert.doesNotMatch(loginHtml, /Sign in to SQL|protected by the operating system|reused until/i);
  const loginHeadingStart = loginHtml.indexOf('<div class="sql-login-heading">');
  const loginHeadingEnd = loginHtml.indexOf('</div>', loginHeadingStart);
  assert.ok(loginHeadingStart >= 0 && loginHeadingEnd > loginHeadingStart);
  assert.doesNotMatch(loginHtml.slice(loginHeadingStart, loginHeadingEnd), /<p\b/);
  assert.doesNotMatch(html, /<h1[^>]*>\s*SQL\s*<\/h1>/);
  assert.doesNotMatch(html, /id="sql-query-count"/);
  assert.doesNotMatch(html, /<h[1-6][^>]*>\s*Saved Queries(?:\s*\([^)]*\))?\s*<\/h[1-6]>/i);
  assert.match(
    html,
    /class="sql-sidebar-tools">[\s\S]*id="sql-query-search"[\s\S]*id="sql-refresh-queries"[\s\S]*id="sql-new-query"[\s\S]*<\/div>\s*<div id="sql-query-list"/,
  );
  assert.doesNotMatch(html, /id="sql-(?:delete|query-name)"/);
  assert.doesNotMatch(html, /sql-active-environment|sql-query-toolbar-meta/);
  assert.match(html, /class="sql-query-toolbar">\s*<div id="sql-query-tabs"[^>]*><\/div>\s*<\/div>/);
  assert.match(html, /id="sql-session-actions"[\s\S]*id="sql-save-action"[\s\S]*id="sql-save-shortcut"[\s\S]*id="sql-run-action"[\s\S]*id="sql-run-shortcut"[\s\S]*id="sql-session-user"[\s\S]*id="sql-sign-out"/);
  assert.doesNotMatch(html, />Mine<|>All<|>Others</);
  assert.match(styles, /\.sql-workspace/);
  assert.match(styles, /--sql-editor-font-size:21px/);
  assert.match(styles, /--sql-editor-font-family:var\(--font-family-notes-code-block\)/);
  assert.match(styles, /\.sql-page\[data-editor-font=comic-mono\]\{--sql-editor-font-family:["']STM Comic Mono["'],var\(--font-family-notes-code-block\)\}/);
  assert.match(styles, /#sql-font-family-switch\{[^}]*width:2rem[^}]*border-radius:9999px/);
  assert.match(styles, /#sql-font-family-switch\[aria-checked=true\] \.sql-font-family-switch-thumb\{transform:translateX\(16px\)\}/);
  assert.match(styles, /\.sql-session-action\{[^}]*height:2rem[^}]*font-size:12px/);
  assert.match(styles, /\.sql-session-action kbd\{[^}]*font-size:12px[^}]*font-weight:600/);
  assert.match(styles, /\.sql-editor \.cm-editor\{font-family:var\(--sql-editor-font-family\)\}/);
  assert.match(styles, /\.sql-editor \.cm-editor\{[^}]*font-size:calc\(var\(--sql-editor-font-size\)\*\.88889\)[^}]*font-weight:400/);
  assert.match(styles, /\.sql-editor \.cm-scroller\{[^}]*font-family:var\(--sql-editor-font-family\)[^}]*line-height:1\.75/);
  assert.match(styles, /\.sql-editor \.cm-sql-current-statement\{/);
  assert.match(styles, /\.sql-editor \.cm-tooltip-hover:has\(>\.sql-table-enum-tooltip\)/);
  assert.match(styles, /\.sql-table-enum-tooltip\{/);
  assert.match(styles, /\.sql-table-enum-tooltip-scroll\{[^}]*max-height:320px[^}]*overflow:auto/);
  assert.match(styles, /\.sql-table-enum-tooltip-default-badge\{/);
  assert.match(baseStyles, /@font-face\s*\{[^}]*font-family:\s*'STM Comic Mono'[^}]*comic-mono\.ttf[^}]*font-weight:\s*400/);
  assert.ok((await stat(path.join(__dirname, '..', 'assets', 'fonts', 'comic-mono.ttf'))).size > 10_000);
  assert.match(styles, /\.sql-query-tab-dirty/);
  assert.match(styles, /max-width:200px/);
  assert.match(styles, /\.sql-query-tab\[data-dirty=true\] \.sql-query-tab-close/);
  assert.match(styles, /\.sql-query-row-edit/);
  assert.match(styles, /\.sql-result-table/);
  assert.match(styles, /\.sql-result-table-wrap\{[^}]*width:max-content/);
  assert.match(styles, /\.sql-result-cell-value\{[^}]*max-width:320px[^}]*white-space:nowrap/);
  assert.match(styles, /\.sql-result-cell-detail/);
  assert.match(styles, /\.sql-value-dialog/);
  assert.match(styles, /\.sql-value-copy-raw/);
  assert.match(
    styles,
    /\.sql-value-code\.sql-value-code-raw\{[^}]*white-space:pre-wrap[^}]*overflow-wrap:anywhere/,
  );
  assert.match(
    styles,
    /\.sql-value-code\{[^}]*font-size:calc\(var\(--sql-editor-font-size\)\*\.88889\)/,
  );
  assert.match(styles, /\.sql-value-code code::selection\{[^}]*background-color:rgb\(37 99 235/);
  assert.match(styles, /\.sql-value-json-editor/);
  assert.match(
    styles,
    /\.sql-value-json-editor \.cm-editor\{[^}]*font-size:calc\(var\(--sql-editor-font-size\)\*\.88889\)/,
  );
  assert.match(styles, /\.sql-value-json-editor \.cm-selectionBackground/);
  assert.match(styles, /\.sql-value-html-frame\{[^}]*pointer-events:none/);
  assert.match(page, /resolveSqlStatement/);
  assert.match(page, /sqlCurrentStatementHighlight/);
  assert.match(page, /isSqlRunShortcut/);
  assert.match(page, /isSqlSaveShortcut/);
  assert.match(page, /sql:editor-font-size/);
  assert.match(page, /sql:editor-font-family/);
  assert.match(page, /clampSqlEditorFontSize/);
  assert.match(page, /normalizeSqlEditorFontFamily/);
  assert.match(page, /writeStoredValue\(EDITOR_FONT_SIZE_KEY,\s*String\(next\)\)/);
  assert.match(page, /writeStoredValue\(EDITOR_FONT_FAMILY_KEY,\s*fontFamily\)/);
  assert.match(page, /fontFamilySwitch\.addEventListener\('click'/);
  assert.match(page, /saveActionButton\.addEventListener\('click', \(\) => void this\.saveCurrentQuery\(\)\)/);
  assert.match(page, /runActionButton\.addEventListener\('click', \(\) => void this\.runCurrentStatement\(\)\)/);
  assert.match(page, /saveActionButton\.disabled = state\.auth\?\.status !== 'signed-in' \|\| !tab \|\| tab\.saving/);
  assert.match(page, /runActionButton\.disabled = state\.auth\?\.status !== 'signed-in' \|\| !tab \|\| tab\.executing/);
  assert.match(page, /tab\.saving = true;\s*this\.renderTabs\(\);\s*this\.renderBusyState\(\)/);
  assert.match(page, /fontFamilySwitch\.setAttribute\('aria-checked', String\(comic\)\)/);
  assert.match(page, /style\.setProperty\('--sql-editor-font-size',\s*`\$\{fontSize\}px`\)/);
  assert.match(page, /valueDialog\.style\.setProperty\('--sql-editor-font-size',\s*`\$\{fontSize\}px`\)/);
  assert.match(page, /setAuthenticatedHeaderVisible\(visible\) \{[\s\S]*?this\.fontControls\.classList\.toggle\('hidden', !visible\)[\s\S]*?this\.sessionActions\.classList\.toggle\('hidden', !visible\)/);
  assert.match(page, /renderLoading\(\) \{\s*this\.setAuthenticatedHeaderVisible\(false\)/);
  assert.match(page, /renderSignedOut\(message\) \{\s*this\.closeTableEnumHover\(\);\s*this\.setAuthenticatedHeaderVisible\(false\)/);
  assert.match(page, /renderAuthenticated\(\) \{[\s\S]*?this\.setAuthenticatedHeaderVisible\(true\)/);
  assert.match(page, /window\.sqlApi\.renameQuery/);
  assert.match(page, /window\.sqlApi\.execute/);
  assert.match(page, /window\.sqlApi\.getSchema/);
  assert.match(page, /schemaCompletionSource/);
  assert.match(page, /hoverTooltip/);
  assert.match(page, /EditorView\.domEventHandlers\(\{\s*dblclick:/);
  assert.match(page, /resolveSqlTableReferenceAt/);
  assert.match(page, /activateHover\(view, target\.from, 1/);
  assert.match(page, /closeHoverTooltip\(this\.tableEnumHover\)/);
  assert.match(page, /sqlEnumCommentParts\(column\.enum\.comment, column\.enum\.defaultValue\)/);
  assert.match(page, /nullable\.textContent = column\.enum\.nullable \? 'Yes' : 'No'/);
  assert.match(page, /badge\.textContent = '\(default\)'/);
  assert.match(page, /SQL_ENUM_TOOLTIP_MAX_ROWS = 100/);
  assert.match(page, /dialect:\s*MySQL/);
  assert.doesNotMatch(page, /StreamLanguage\.define\(standardSQL\)/);
  assert.match(page, /sqlCellPresentation/);
  assert.match(page, /Formatted JSON cell value/);
  assert.match(page, /sqlValueModesForKind/);
  assert.match(page, /detectSqlValueLanguage/);
  assert.match(page, /mode === 'highlighted'/);
  assert.match(page, /valueModes\.classList\.remove\('hidden'\)/);
  assert.match(page, /window\.serviceApi\.writeClipboardText\(raw\)/);
  assert.match(page, /rawCode\?\.classList\.add\('sql-value-code-raw'\)/);
  assert.match(page, /handleValueDialogSelectAll/);
  assert.match(page, /selectedRange\.compareBoundaryPoints\(Range\.START_TO_START, contentRange\)/);
  assert.match(page, /if \(!event\.repeat\)\s*return/);
  assert.match(page, /formatSqlDuration/);
  assert.match(page, /highlightAuto/);
  assert.match(page, /setAttribute\(['"]sandbox['"], ['"]{2}\)/);
  assert.match(page, /Content-Security-Policy/);
  assert.match(page, /new DOMParser\(\)\.parseFromString/);
  assert.match(page, /form-action 'none'/);
  assert.match(page, /script,noscript,style,meta,base,link,iframe/);
  assert.match(page, /durationMs/);
  assert.match(page, /new SqlVirtualResultTable/);
  assert.match(page, /destroyResultTable\(\)/);
  assert.match(virtualTable, /className = 'sql-result-table-wrap'/);
  assert.match(virtualTable, /className = 'sql-result-table'/);
  assert.match(virtualTable, /calculateSqlResultVirtualWindow/);
  assert.match(virtualTable, /data-sql-cell-detail/);
  assert.doesNotMatch(page, /resultStatus/);
  assert.doesNotMatch(page, /Query ran/);
  assert.match(page, /replace\(\/\^Error invoking remote method '\[\^'\]\+': \(\?:Error: \)\?\//);
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
    'sql:schema:get',
  ]) {
    assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(main, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(main, /CmdOrCtrl\+Alt\+R/);
  assert.doesNotMatch(preload, /sd-pc\.tiusolution|sd-pc\.dev\.tiusolution|private-token|passwd/);
});

test('SQL editor font preferences stay within the local supported values', async () => {
  const page = await import(pathToFileURL(
    path.join(__dirname, '..', 'dist', 'renderer', 'sqlPage.js'),
  ));

  assert.equal(page.clampSqlEditorFontSize(Number.NaN), 21);
  assert.equal(page.clampSqlEditorFontSize(10), 12);
  assert.equal(page.clampSqlEditorFontSize(13.4), 13);
  assert.equal(page.clampSqlEditorFontSize(13.6), 14);
  assert.equal(page.clampSqlEditorFontSize(25), 24);
  assert.equal(page.normalizeSqlEditorFontFamily('default'), 'default');
  assert.equal(page.normalizeSqlEditorFontFamily('comic-mono'), 'comic-mono');
  assert.equal(page.normalizeSqlEditorFontFamily('Comic Mono'), 'default');
  assert.equal(page.normalizeSqlEditorFontFamily(null), 'default');
});

test('SQL field detail modes always expose Raw', async () => {
  const page = await import(pathToFileURL(
    path.join(__dirname, '..', 'dist', 'renderer', 'sqlPage.js'),
  ));

  assert.deepEqual(page.sqlValueModesForKind('json').map((mode) => mode.id), ['formatted', 'raw']);
  assert.deepEqual(page.sqlValueModesForKind('html').map((mode) => mode.id), ['preview', 'raw']);
  assert.deepEqual(page.sqlValueModesForKind('text').map((mode) => mode.id), ['raw']);
  assert.deepEqual(
    page.sqlValueModesForKind('text', 'markdown').map((mode) => [mode.id, mode.label]),
    [['highlighted', 'Markdown'], ['raw', 'Raw']],
  );
  assert.deepEqual(
    page.sqlValueModesForKind('text', 'sql').map((mode) => [mode.id, mode.label]),
    [['highlighted', 'SQL'], ['raw', 'Raw']],
  );
  assert.equal(
    page.detectSqlValueLanguage('# Heading\n\nThis is **bold** and [a link](https://example.com).\n\n- one\n- two'),
    'markdown',
  );
});
