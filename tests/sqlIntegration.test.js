const assert = require('node:assert/strict');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

test('compiled SQL page uses the narrow main-process bridge and Service Manager layout', async () => {
  const dist = path.join(__dirname, '..', 'dist');
  const html = await readFile(path.join(dist, 'renderer', 'index.html'), 'utf8');
  const page = await readFile(path.join(dist, 'renderer', 'pages', 'sqlPage.js'), 'utf8');
  const virtualTable = await readFile(path.join(dist, 'renderer', 'components', 'sqlVirtualResultTable.js'), 'utf8');
  const styles = await readFile(path.join(dist, 'renderer', 'tailwind.css'), 'utf8');
  const baseStyles = await readFile(path.join(dist, 'renderer', 'styles.css'), 'utf8');
  const preload = await readFile(path.join(dist, 'main', 'core', 'preload.js'), 'utf8');
  const [mainEntry, appWindow, ipcChannels] = await Promise.all([
    readFile(path.join(dist, 'main', 'core', 'main.js'), 'utf8'),
    readFile(path.join(dist, 'main', 'core', 'appWindow.js'), 'utf8'),
    readFile(path.join(dist, 'main', 'core', 'ipcChannels.js'), 'utf8'),
  ]);
  const main = `${mainEntry}\n${appWindow}\n${ipcChannels}`;

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
  assert.match(html, /id="sql-select-limit"[^>]*max="10000"[^>]*value="100"/);
  assert.match(html, /id="sql-value-dialog"/);
  assert.match(
    html,
    /id="sql-value-dialog-title">Cell value<\/h2>[\s\S]*id="sql-value-copy-raw"[^>]*aria-label="Copy raw cell value"[^>]*disabled[\s\S]*id="sql-value-kind"/,
  );
  assert.match(html, /id="sql-value-modes"/);
  assert.match(html, /id="sql-value-content"/);
  assert.match(html, /id="sql-value-find-bar" class="sql-value-find-bar hidden"/);
  assert.match(html, /id="sql-value-find-input"/);
  assert.match(html, /id="sql-value-find-previous"/);
  assert.match(html, /id="sql-value-find-next"/);
  assert.match(html, /id="sql-value-find-close"/);
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
  assert.match(styles, /\.cm-tooltip\.sql-table-enum-tooltip,\.sql-table-enum-tooltip\{/);
  assert.match(styles, /\.sql-table-enum-tooltip\{/);
  assert.match(styles, /width:min\(960px,calc\(100vw - 48px\)\)/);
  assert.match(styles, /\.sql-table-enum-tooltip-grid\{/);
  assert.match(styles, /\.sql-table-enum-tooltip-scroll\{[^}]*max-height:320px[^}]*overflow:auto/);
  assert.match(styles, /\.sql-table-enum-tooltip-value\.default:{1,2}after\{/);
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
  assert.match(styles, /\.sql-value-dialog-shell\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(styles, /\.sql-value-copy-raw/);
  assert.match(styles, /\.sql-value-find-bar\{/);
  assert.match(styles, /\.sql-value-find-input\{/);
  assert.match(styles, /\.sql-value-find-match-active\{/);
  assert.doesNotMatch(styles, /\.sql-value-code\.sql-value-code-raw/);
  assert.match(styles, /\.sql-value-line-numbers\{[^}]*position:sticky[^}]*left:0/);
  assert.match(styles, /\.sql-value-code>code\{[^}]*min-width:max-content/);
  assert.match(
    styles,
    /\.sql-value-code,\.sql-value-line-numbers\{[^}]*font-size:calc\(var\(--sql-editor-font-size\)\*\.88889\)/,
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
  assert.match(page, /EditorState\.tabSize\.of\(SQL_INDENT\.length\)/);
  assert.match(page, /key:\s*['"]Enter['"],\s*run:\s*acceptSqlCompletionOrInsertNewline/);
  assert.match(page, /function acceptSqlCompletionOrInsertNewline\(view\) \{[\s\S]*?acceptCompletion\(view\) \|\| insertSqlNewline\(view\)/);
  const sqlEditorExtensions = page.slice(
    page.indexOf('this.editor = new EditorView'),
    page.indexOf('EditorView.clipboardInputFilter', page.indexOf('this.editor = new EditorView')),
  );
  assert.ok(
    sqlEditorExtensions.indexOf('Prec.highest(keymap.of([')
      < sqlEditorExtensions.indexOf('basicSetup,'),
    'SQL Enter keymap must register before basicSetup completion bindings',
  );
  assert.match(page, /key:\s*['"]Tab['"],\s*run:\s*insertSqlIndent/);
  assert.match(page, /key:\s*['"]Shift-Tab['"],\s*run:\s*removeSqlIndent/);
  assert.match(page, /clipboardInputFilter\.of\(\(?text\)?\s*=>\s*normalizeSqlEditorSource\(text\)\)/);
  assert.match(page, /restoreUntitledDrafts\(\)/);
  assert.match(page, /tab\.recordId === undefined\)\s*this\.scheduleUntitledDraftPersistence\(\)/);
  assert.match(page, /window\.addEventListener\(['"]beforeunload['"], \(\) => this\.persistUntitledDrafts\(\)\)/);
  assert.match(page, /state\.tabs\.filter\(\(?tab\)? => tab\.recordId === undefined\)/);
  assert.match(page, /SQL_UNTITLED_DRAFTS_STORAGE_KEY/);
  assert.match(page, /window\.serviceApi\.onCloseShortcutRequested\(\(\) => this\.handleCloseShortcut\(\)\)/);
  assert.match(
    page,
    /async handleCloseShortcut\(\) \{[\s\S]*?if \(!this\.active\)\s*return false;[\s\S]*?if \(state\.tabs\.length <= 1\)\s*return false;[\s\S]*?await this\.closeTab\(key\);[\s\S]*?return true;/,
  );
  assert.match(
    page,
    /async closeTab\(key\) \{[\s\S]*?if \(index < 0\)\s*return false;[\s\S]*?toast\('Wait for the current query operation to finish\.', 'error'\);\s*return true;[\s\S]*?Close Unsaved Query\?[\s\S]*?if \(!confirmed\)\s*return true;/,
  );
  assert.match(page, /sql:editor-font-size/);
  assert.match(page, /sql:editor-font-family/);
  assert.match(page, /clampSqlEditorFontSize/);
  assert.match(page, /normalizeSqlSelectLimit/);
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
  assert.match(page, /limit:\s*this\.normalizeSelectLimitInput\(\)/);
  assert.match(page, /window\.sqlApi\.getSchema/);
  assert.match(page, /schemaCompletionSource/);
  assert.match(page, /showTooltip/);
  assert.match(page, /SQL_TABLE_ENUM_TOOLTIP_EFFECT/);
  assert.match(page, /sqlTableEnumTooltipField/);
  assert.match(page, /EditorView\.domEventObservers\(\{\s*mousedown:/);
  assert.match(page, /event\.detail < 2/);
  assert.match(page, /handleTableEnumMouseDown/);
  assert.doesNotMatch(page, /EditorView\.domEventHandlers\(\{\s*mousedown:/);
  assert.match(page, /resolveSqlTableReferenceNear/);
  assert.match(page, /view\.dispatch\(\{ effects: SQL_TABLE_ENUM_TOOLTIP_EFFECT\.of\(tooltip\) \}\)/);
  assert.match(page, /transaction\.docChanged \? null : tooltip/);
  assert.match(page, /SQL_TABLE_ENUM_TOOLTIP_EFFECT\.of\(null\)/);
  assert.doesNotMatch(page, /activateHover/);
  assert.match(page, /parseSqlEnumComment\(column\.enum\.comment, column\.enum\.defaultValue\)/);
  assert.match(page, /nullable\.textContent = column\.enum\.nullable \? 'Yes' : 'No'/);
  assert.match(page, /item\.className = `sql-table-enum-tooltip-value\$\{part\.isDefault \? ' default' : ''\}`/);
  assert.match(page, /SQL_ENUM_TOOLTIP_MAX_ROWS = 100/);
  assert.match(page, /dialect:\s*MySQL/);
  assert.doesNotMatch(page, /StreamLanguage\.define\(standardSQL\)/);
  assert.match(page, /sqlCellPresentation/);
  assert.match(page, /Formatted JSON cell value/);
  assert.match(page, /sqlValueModesForKind/);
  assert.match(page, /openValueDialog\(column, sqlCellPresentation\(row\[column\]\), row, 'edit'\)/);
  assert.match(page, /openValueDialog\(column, presentation, row, 'view'\)/);
  assert.match(page, /const initialText = presentation\.kind === 'json' && presentation\.formatted !== undefined\s*\? presentation\.formatted\s*: presentation\.raw/);
  assert.match(page, /valueSqlOriginalText = initialText/);
  assert.match(page, /sqlEditedTextForUpdate\(this\.valuePresentation, this\.valueEditInput\.value\)/);
  assert.match(page, /detectSqlValueLanguage/);
  assert.match(page, /retryTableEnumAfterSchemaLoad\(view, position, selectedRange\)/);
  assert.match(page, /ensureSchemaLoaded\(environment, true\)/);
  assert.match(page, /this\.tableEnumPendingPosition !== pending/);
  assert.match(page, /pending\.source !== view\.state\.doc\.toString\(\)/);
  assert.match(page, /pending\.tabKey !== this\.currentState\(\)\.activeTabKey/);
  assert.match(page, /const existing = this\.schemaFlights\.get\(environment\)/);
  assert.match(page, /existing\?\.loadVersion === loadVersion/);
  assert.match(page, /The SQL schema could not be loaded\. Double-click a table name to retry\./);
  assert.match(page, /mode === 'highlighted'/);
  assert.match(page, /valueModes\.classList\.remove\('hidden'\)/);
  assert.match(page, /const text = this\.valueFormatted \?\? this\.valueRaw;/);
  assert.match(page, /window\.serviceApi\.writeClipboardText\(text\)/);
  assert.match(page, /findNotesTextMatches\(this\.currentValueFindText\(\), this\.valueFindInput\.value\)/);
  assert.match(page, /openValueFind\(\)/);
  assert.match(page, /moveValueFind\(event\.shiftKey \? -1 : 1\)/);
  assert.match(page, /sql-value-find-match-active/);
  assert.match(page, /lineNumbers\.className = 'sql-value-line-numbers'/);
  assert.match(page, /pre\.append\(lineNumbers, code\)/);
  assert.match(page, /function sqlValueLineNumbers\(lineCount\)/);
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
  assert.match(virtualTable, /this\.onOpenValue\(column, sqlCellPresentation\(row\[column\]\), row, 'view'\)/);
  assert.match(virtualTable, /this\.onOpenValue\(column, sqlCellPresentation\(dataRow\[column\]\), dataRow, 'edit'\)/);
  assert.doesNotMatch(page, /resultStatus/);
  assert.doesNotMatch(page, /Query ran/);
  assert.match(page, /replace\(\/\^Error invoking remote method '\[\^'\]\+': \(\?:Error: \)\?\//);
  assert.match(page, /sessionUser\.textContent = user\?\.userName \?\? ['"]{2}/);
  assert.doesNotMatch(page, /sessionUser\.textContent\s*=.*user\?\.name/);
  assert.match(page, /textContent = formatSqlCell/);
  assert.doesNotMatch(page, /innerHTML\s*=\s*[^;]*(?:record\.name|result|row\[)/);
  assert.match(preload, /const closeShortcutListeners = new Set\(\)/);
  assert.match(preload, /onCloseShortcutRequested/);
  assert.match(preload, /closeShortcutListeners\.add\(listener\)/);
  assert.match(preload, /return \(\) => closeShortcutListeners\.delete\(listener\)/);
  assert.match(preload, /ipcRenderer\.on\('app:close-shortcut-request'/);
  assert.match(preload, /Promise\.all\(\[\.\.\.closeShortcutListeners\]\.map/);
  assert.match(preload, /ipcRenderer\.send\('app:close-shortcut-result', \{ requestId, handled: results\.some\(Boolean\) \}\)/);
  assert.match(main, /window\.webContents\.on\('before-input-event', \(event, input\) =>/);
  assert.match(main, /requestRendererCloseShortcut\(window\)/);
  assert.match(main, /pendingCloseShortcutRequests\.delete\(requestId\);\s*resolve\(true\);/);
  assert.match(main, /if \(!handled && !window\.isDestroyed\(\)\)\s*window\.close\(\)/);
  assert.match(main, /pending\.senderId !== event\.sender\.id/);

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
    path.join(__dirname, '..', 'dist', 'renderer', 'pages', 'sqlPage.js'),
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
    path.join(__dirname, '..', 'dist', 'renderer', 'pages', 'sqlPage.js'),
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
  assert.equal(
    page.sqlEditedTextForUpdate({ kind: 'json' }, '{\n  "enabled": true,\n  "items": [\n    1,\n    2\n  ]\n}'),
    '{"enabled":true,"items":[1,2]}',
  );
  assert.equal(
    page.sqlEditedTextForUpdate({ kind: 'json' }, '{ invalid json'),
    '{ invalid json',
  );
  assert.equal(
    page.sqlEditedTextForUpdate({ kind: 'text' }, '{\n  "enabled": true\n}'),
    '{\n  "enabled": true\n}',
  );
});
