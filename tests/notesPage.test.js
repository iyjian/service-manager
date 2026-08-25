const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const root = path.join(__dirname, '..');
const distRenderer = path.join(root, 'dist', 'renderer');

async function loadNoteLanguageModules() {
  const dependencyRequire = createRequire(require.resolve('@codemirror/language'));
  const highlightCommonJsEntry = dependencyRequire.resolve('@lezer/highlight');
  const highlightEsmEntry = path.join(path.dirname(highlightCommonJsEntry), 'index.js');
  const [notesPage, stateApi, languageApi, highlightApi] = await Promise.all([
    import(path.join(distRenderer, 'pages', 'notesPage.js')),
    import('@codemirror/state'),
    import('@codemirror/language'),
    import(pathToFileURL(highlightEsmEntry).href),
  ]);
  return { ...notesPage, ...stateApi, ...languageApi, ...highlightApi };
}

function highlightedSpans(state, syntaxTree, highlightTree, classHighlighter) {
  const spans = [];
  highlightTree(syntaxTree(state), classHighlighter, (from, to, classes) => {
    spans.push({
      text: state.doc.sliceString(from, to),
      classes: classes.split(/\s+/),
    });
  });
  return spans;
}

function note(overrides) {
  return {
    id: overrides.id,
    name: overrides.name ?? 'Untitled',
    content: overrides.content ?? '',
    language: overrides.language ?? 'markdown',
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

test('Notes page delegates body search while retaining lightweight tree indexes and bounded debounce', async () => {
  const source = await readFile(path.join(root, 'src', 'renderer', 'pages', 'notesPage.ts'), 'utf8');

  assert.match(source, /NOTE_SEARCH_DEBOUNCE_MS = 120/);
  assert.match(source, /this\.searchInput\.addEventListener\('input', \(\) => this\.queueSearchRender\(\)\)/);
  assert.match(source, /private readonly treeNodesById = new Map<string, NotesTreeNode>\(\)/);
  assert.match(source, /window\.notesApi\.searchNotes\(query, activeNote\)/);
  assert.match(source, /this\.searchResultIds = ids\.filter/);
  assert.match(source, /this\.searchResultIds\.flatMap\(\(id\)/);
  assert.match(source, /node: this\.treeNodesById\.get\(note\.id\)/);
  assert.match(source, /const cached = this\.breadcrumbCache\.get\(noteId\)/);
  assert.match(source, /noteTreeBreadcrumbFromIndexes\(noteId, this\.notesById, this\.treeNodesById\)/);
  assert.match(source, /this\.flushSearchRender\(\);\s*this\.finishSidebarResize\(\)/);
  assert.match(source, /finally \{\s*this\.flushSearchRender\(\);\s*\}/);
});

test('Notes name input updates one rendered row and only debounces ranking while search is active', async () => {
  const source = await readFile(path.join(root, 'src', 'renderer', 'pages', 'notesPage.ts'), 'utf8');

  assert.match(source, /private readonly renderedRowsById = new Map<string, HTMLElement>\(\)/);
  assert.match(source, /private updateListNoteName\(note: Note\): void \{[\s\S]*?this\.renderedRowsById\.get\(note\.id\)[\s\S]*?name\.textContent = displayName/);
  assert.match(source, /note\.name = this\.nameInput\.value;[\s\S]*?this\.updateListNoteName\(note\);[\s\S]*?this\.markNoteEdited\(note, Boolean\(this\.searchInput\.value\.trim\(\)\)\)/);
  assert.match(source, /if \(refreshSearchResults\) this\.queueSearchRender\(\)/);
});

test('Notes sidebar width clamp rounds finite pixels and enforces stable bounds', async () => {
  const { clampNotesSidebarWidth } = await import(path.join(distRenderer, 'pages', 'notesPage.js'));

  assert.equal(clampNotesSidebarWidth(Number.NaN), 280);
  assert.equal(clampNotesSidebarWidth(100), 240);
  assert.equal(clampNotesSidebarWidth(240), 240);
  assert.equal(clampNotesSidebarWidth(319.6), 320);
  assert.equal(clampNotesSidebarWidth(520), 520);
  assert.equal(clampNotesSidebarWidth(900), 520);
});

test('Notes save indicator only occupies a tree row while saving or after a failure', async () => {
  const { noteSaveIndicatorState } = await import(path.join(distRenderer, 'pages', 'notesPage.js'));

  assert.equal(noteSaveIndicatorState(false, false), undefined);
  assert.equal(noteSaveIndicatorState(true, false), 'saving');
  assert.equal(noteSaveIndicatorState(false, true), 'error');
  assert.equal(noteSaveIndicatorState(true, true), 'error');
});

test('Notes delete confirmation compares subtree membership without rejecting harmless reorders', async () => {
  const { sameNoteIdSet } = await import(path.join(distRenderer, 'pages', 'notesPage.js'));

  assert.equal(sameNoteIdSet(['root', 'child'], ['child', 'root']), true);
  assert.equal(sameNoteIdSet(['root', 'child'], ['root', 'other']), false);
  assert.equal(sameNoteIdSet(['root', 'child'], ['root', 'child', 'new-child']), false);
  assert.equal(sameNoteIdSet(['root', 'root'], ['root', 'root']), false);
});

test('Notes session tabs preserve order and choose the right adjacent surviving Note first', async () => {
  const {
    noteTabFallbackAfterRemoval,
    reconcileOpenNoteIds,
  } = await import(path.join(distRenderer, 'pages', 'notesPage.js'));
  const active = new Set(['a', 'b', 'c', 'd']);

  assert.deepEqual(
    reconcileOpenNoteIds(['a', 'missing', 'b', 'a'], active, 'd'),
    ['a', 'b', 'd'],
  );
  assert.equal(noteTabFallbackAfterRemoval(['a', 'b', 'c', 'd'], 'b', new Set(['b'])), 'c');
  assert.equal(noteTabFallbackAfterRemoval(['a', 'b', 'c', 'd'], 'b', new Set(['b', 'c'])), 'd');
  assert.equal(noteTabFallbackAfterRemoval(['a', 'b', 'c', 'd'], 'b', new Set(['b', 'c', 'd'])), 'a');
  assert.equal(noteTabFallbackAfterRemoval(['a', 'b'], 'b', new Set(['a', 'b'])), undefined);
  assert.equal(noteTabFallbackAfterRemoval(['a', 'b'], 'a', new Set(['b'])), 'a');
});

test('Notes tabs remain transient and reconcile through selection, reload, delta, and delete flows', async () => {
  const source = await readFile(path.join(root, 'src', 'renderer', 'pages', 'notesPage.ts'), 'utf8');

  assert.match(source, /private openNoteIds: string\[\] = \[\]/);
  assert.match(source, /private async selectNote\(id: string, source: 'tree' \| 'tab' = 'tree'\)[\s\S]*?this\.openNoteTab\(id, true\)/);
  assert.match(source, /if \(source === 'tab'\) \{\s*void this\.revealTreeNote\(id, false\);\s*this\.focusNoteTab\(id\);\s*\}/);
  assert.match(source, /private async revealTreeNote\(noteId: string, focusTreeRow: boolean\): Promise<void> \{[\s\S]*?this\.renderList\(focusTreeRow \? noteId : undefined\)[\s\S]*?scrollIntoView\(\{ block: 'nearest' \}\)/);
  assert.match(source, /if \(generation !== this\.treeRevealGeneration \|\| this\.selectedId !== noteId\) return;[\s\S]*?this\.expandedNoteIds = new Set\(persistedIds\)/);
  assert.match(source, /private async closeNoteTab\(id: string\)[\s\S]*?await this\.flushNote\(id\)[\s\S]*?this\.openNoteIds\.splice\(index, 1\)/);
  assert.match(source, /recoveredTabs = openTabsBeforeReload\.map\(\(id\) => recoveredByOriginalId\.get\(id\) \?\? id\)/);
  assert.match(source, /async applyPersistentDelta[\s\S]*?noteTabFallbackAfterRemoval\([\s\S]*?this\.reconcileOpenNoteTabs\(\)/);
  assert.match(source, /const openTabsBeforeDelete = \[\.\.\.this\.openNoteIds\][\s\S]*?noteTabFallbackAfterRemoval\(/);
  assert.doesNotMatch(source, /saveOpenNote|loadOpenNote|openNoteIds.*notesApi/);
});

test('Notes tree resolves before, inside, and after drops while rejecting self-descendant moves', async () => {
  const {
    isValidNoteTreeParent,
    resolveNoteTreeDropPlacement,
  } = await import(path.join(distRenderer, 'pages', 'notesPage.js'));
  const nodes = [
    { noteId: 'root', parentId: null, order: 10 },
    { noteId: 'child', parentId: 'root', order: 10 },
    { noteId: 'grandchild', parentId: 'child', order: 10 },
    { noteId: 'second-child', parentId: 'root', order: 20 },
    { noteId: 'sibling', parentId: null, order: 20 },
  ];

  assert.deepEqual(resolveNoteTreeDropPlacement(nodes, 'sibling', 'root', 'inside'), { parentId: 'root' });
  assert.deepEqual(resolveNoteTreeDropPlacement(nodes, 'second-child', 'child', 'before'), {
    parentId: 'root',
    beforeNoteId: 'child',
  });
  assert.deepEqual(resolveNoteTreeDropPlacement(nodes, 'child', 'second-child', 'after'), { parentId: 'root' });
  assert.deepEqual(resolveNoteTreeDropPlacement(nodes, 'grandchild', 'sibling', 'before'), {
    parentId: null,
    beforeNoteId: 'sibling',
  });
  assert.equal(resolveNoteTreeDropPlacement(nodes, 'root', 'child', 'inside'), undefined);
  assert.equal(resolveNoteTreeDropPlacement(nodes, 'root', 'grandchild', 'before'), undefined);
  assert.equal(resolveNoteTreeDropPlacement(nodes, 'child', 'child', 'after'), undefined);
  assert.equal(isValidNoteTreeParent(nodes, 'root', 'grandchild'), false);
  assert.equal(isValidNoteTreeParent(nodes, 'root', null), true);
  assert.equal(isValidNoteTreeParent(nodes, 'missing', null), false);
});

test('Note Language search keeps the product order and matches labels or useful aliases', async () => {
  const { NOTE_LANGUAGE_OPTIONS, filterNoteLanguageOptions } = await import(
    path.join(distRenderer, 'pages', 'notesPage.js')
  );
  assert.deepEqual(
    NOTE_LANGUAGE_OPTIONS.map(({ value, label }) => [value, label]),
    [
      ['richtext', 'Rich Text'],
      ['markdown', 'Markdown'],
      ['bash', 'Bash'],
      ['javascript', 'JavaScript'],
      ['typescript', 'TypeScript'],
      ['sql', 'SQL'],
      ['json', 'JSON'],
      ['yaml', 'YAML'],
      ['text', 'Plain Text'],
    ],
  );
  assert.deepEqual(filterNoteLanguageOptions('').map(({ value }) => value), NOTE_LANGUAGE_OPTIONS.map(({ value }) => value));
  assert.deepEqual(filterNoteLanguageOptions('RICH document').map(({ value }) => value), ['richtext']);
  assert.deepEqual(filterNoteLanguageOptions('md').map(({ value }) => value), ['markdown']);
  assert.deepEqual(filterNoteLanguageOptions('shell').map(({ value }) => value), ['bash']);
  assert.deepEqual(filterNoteLanguageOptions('TS').map(({ value }) => value), ['typescript']);
  assert.deepEqual(filterNoteLanguageOptions('yml').map(({ value }) => value), ['yaml']);
  assert.deepEqual(filterNoteLanguageOptions('txt').map(({ value }) => value), ['text']);
  assert.deepEqual(filterNoteLanguageOptions('not-a-language'), []);
});

test('Note Language switch fences reject stale selection, edits, and workspace generations', async () => {
  const { isNoteLanguageSwitchFenceCurrent } = await import(path.join(distRenderer, 'pages', 'notesPage.js'));
  const fence = {
    noteId: 'note-a',
    sourceLanguage: 'markdown',
    editVersion: 3,
    selectionVersion: 7,
    workspaceGeneration: 11,
  };

  assert.equal(isNoteLanguageSwitchFenceCurrent(fence, { ...fence }), true);
  for (const [field, value] of [
    ['noteId', 'note-b'],
    ['sourceLanguage', 'richtext'],
    ['editVersion', 4],
    ['selectionVersion', 8],
    ['workspaceGeneration', 12],
  ]) {
    assert.equal(isNoteLanguageSwitchFenceCurrent(fence, { ...fence, [field]: value }), false, field);
  }
});

test('Note Language filtering keeps exactly one preferred roving tab stop', async () => {
  const {
    filterNoteLanguageOptions,
    noteLanguageRovingTabStop,
  } = await import(path.join(distRenderer, 'pages', 'notesPage.js'));

  assert.equal(noteLanguageRovingTabStop(filterNoteLanguageOptions(''), 'markdown'), 'markdown');
  assert.equal(noteLanguageRovingTabStop(filterNoteLanguageOptions('ts'), 'markdown'), 'typescript');
  assert.equal(noteLanguageRovingTabStop(filterNoteLanguageOptions('not-a-language'), 'markdown'), undefined);
});

test('Note Language popup owns search, keyboard navigation, focus return, and explicit mode changes', async () => {
  const source = await readFile(path.join(root, 'src', 'renderer', 'pages', 'notesPage.ts'), 'utf8');

  assert.match(source, /this\.languageToggle\.addEventListener\('click', \(event\) => this\.toggleLanguageMenu\(event\)\)/);
  assert.match(source, /this\.languageSearch\.addEventListener\('input',[\s\S]*?this\.renderLanguageOptions\(\)/);
  assert.match(source, /option\.tabIndex = item\.value === tabStop \? 0 : -1/);
  assert.match(source, /option\.setAttribute\('role', 'option'\)/);
  assert.match(source, /option\.setAttribute\('aria-selected', String\(item\.value === selectedLanguage\)\)/);
  assert.match(source, /private openLanguageMenu\(\): void \{[\s\S]*?this\.languageFilter = ''[\s\S]*?this\.languageSearch\.focus\(\)/);
  assert.match(source, /private handleLanguageMenuKeyDown\(event: KeyboardEvent\): void \{[\s\S]*?event\.key === 'Escape'[\s\S]*?ArrowDown[\s\S]*?ArrowUp[\s\S]*?Home[\s\S]*?End/);
  assert.match(source, /this\.languageControl\.addEventListener\('focusout',[\s\S]*?requestAnimationFrame[\s\S]*?document\.activeElement[\s\S]*?this\.closeLanguageMenu\(\)/);
  assert.match(source, /private focusLanguageOption\([\s\S]*?candidate\.tabIndex = candidate === option \? 0 : -1[\s\S]*?option\.focus\(\)/);
  assert.match(source, /if \(!this\.languageControl\.contains\(source\)\) this\.closeLanguageMenu\(\)/);
  assert.match(source, /private async changeSelectedLanguage\(targetLanguage: NoteLanguage\): Promise<void>[\s\S]*?const switchFence: NoteLanguageSwitchFence[\s\S]*?isNoteLanguageSwitchFenceCurrent\(switchFence/);
  assert.match(source, /restoreLanguageToggle[\s\S]*?this\.switchingLanguage = false[\s\S]*?this\.languageToggle\.focus\(\)/);
  assert.doesNotMatch(source, /languageSelect|querySelector<.*>\('#note-language'\)/);
});

test('Notes maps every language choice to the intended CodeMirror parser', async () => {
  const { EditorState, language, noteLanguageExtension } = await loadNoteLanguageModules();
  const expectedLanguages = new Map([
    ['markdown', 'markdown'],
    ['bash', 'shell'],
    ['javascript', 'javascript'],
    ['typescript', 'typescript'],
    ['json', 'json'],
    ['yaml', 'yaml'],
    ['sql', 'sql'],
    ['text', null],
  ]);

  for (const [noteLanguage, parserName] of expectedLanguages) {
    const state = EditorState.create({
      doc: 'same content',
      extensions: [noteLanguageExtension(noteLanguage)],
    });
    assert.equal(state.facet(language)?.name ?? null, parserName, noteLanguage);
  }
});

test('Notes language parsers produce syntax highlight spans and Plain Text stays unstyled', async () => {
  const {
    EditorState,
    classHighlighter,
    highlightTree,
    noteLanguageExtension,
    syntaxTree,
  } = await loadNoteLanguageModules();
  const fixtures = [
    {
      language: 'markdown',
      content: '# Heading\n\n**strong**',
      token: 'Heading',
      className: 'tok-heading',
    },
    {
      language: 'bash',
      content: 'export NAME="hello" # comment',
      token: 'export',
      className: 'tok-keyword',
    },
    {
      language: 'javascript',
      content: 'const enabled = true; // comment',
      token: 'const',
      className: 'tok-keyword',
    },
    {
      language: 'typescript',
      content: 'interface User { name: string }',
      token: 'User',
      className: 'tok-typeName',
    },
    {
      language: 'json',
      content: '{"enabled": true, "count": 2}',
      token: 'enabled',
      className: 'tok-propertyName',
    },
    {
      language: 'yaml',
      content: 'enabled: true\ncount: 2',
      token: 'enabled',
      className: 'tok-propertyName',
    },
    {
      language: 'sql',
      content: 'SELECT id, name FROM users WHERE enabled = TRUE;',
      token: 'SELECT',
      className: 'tok-keyword',
    },
  ];

  for (const fixture of fixtures) {
    const state = EditorState.create({
      doc: fixture.content,
      extensions: [noteLanguageExtension(fixture.language)],
    });
    const spans = highlightedSpans(state, syntaxTree, highlightTree, classHighlighter);
    assert.ok(
      spans.some((span) => span.text.includes(fixture.token) && span.classes.includes(fixture.className)),
      `${fixture.language} did not highlight ${fixture.token} as ${fixture.className}: ${JSON.stringify(spans)}`,
    );
  }

  const plainText = EditorState.create({
    doc: 'const unstyled = true',
    extensions: [noteLanguageExtension('text')],
  });
  assert.deepEqual(highlightedSpans(plainText, syntaxTree, highlightTree, classHighlighter), []);
});

test('Markdown fenced blocks reuse every supported code-language parser', async () => {
  const {
    EditorState,
    classHighlighter,
    highlightTree,
    noteLanguageExtension,
    syntaxTree,
  } = await loadNoteLanguageModules();
  const fences = [
    ['bash', 'export NAME="value"', 'export', 'tok-keyword'],
    ['javascript', 'const enabled = true', 'const', 'tok-keyword'],
    ['typescript', 'interface User {}', 'User', 'tok-typeName'],
    ['json', '{"enabled": true}', 'enabled', 'tok-propertyName'],
    ['yaml', 'enabled: true', 'enabled', 'tok-propertyName'],
    ['sql', 'SELECT id FROM users WHERE enabled = TRUE;', 'SELECT', 'tok-keyword'],
  ];

  for (const [fenceLanguage, content, token, className] of fences) {
    const state = EditorState.create({
      doc: `\`\`\`${fenceLanguage}\n${content}\n\`\`\``,
      extensions: [noteLanguageExtension('markdown')],
    });
    const spans = highlightedSpans(state, syntaxTree, highlightTree, classHighlighter);
    assert.ok(
      spans.some((span) => span.text.includes(token) && span.classes.includes(className)),
      `Markdown ${fenceLanguage} fence did not highlight ${token} as ${className}`,
    );
  }
});

test('Notes reconfigures one language compartment without replacing same-content documents', async () => {
  const {
    Compartment,
    EditorState,
    language,
    noteLanguageExtension,
    syntaxTree,
  } = await loadNoteLanguageModules();
  const content = 'interface User { name: string }';
  const languageCompartment = new Compartment();
  let state = EditorState.create({
    doc: content,
    extensions: [languageCompartment.of(noteLanguageExtension('markdown'))],
  });

  assert.equal(state.facet(language)?.name, 'markdown');
  assert.equal(syntaxTree(state).topNode.name, 'Document');

  for (const [noteLanguage, parserName, topNodeName] of [
    ['javascript', 'javascript', 'Script'],
    ['typescript', 'typescript', 'Script'],
    ['sql', 'sql', 'Document'],
    ['text', null, ''],
  ]) {
    state = state.update({
      effects: languageCompartment.reconfigure(noteLanguageExtension(noteLanguage)),
    }).state;
    assert.equal(state.doc.toString(), content, `${noteLanguage} changed the document`);
    assert.equal(state.facet(language)?.name ?? null, parserName, noteLanguage);
    assert.equal(syntaxTree(state).topNode.name, topNodeName, noteLanguage);
  }
});

test('Notes page wires CRUD, copy, confirmation, and debounced flushes without unsafe dynamic HTML', async () => {
  const source = await readFile(path.join(root, 'src', 'renderer', 'pages', 'notesPage.ts'), 'utf8');

  assert.match(source, /registerPage\(\{\s*id: 'notes'/);
  assert.match(source, /window\.notesApi\.getWorkspace\(\)/);
  assert.match(source, /window\.notesApi\.createNote\(\{ parentId \}\)/);
  assert.match(source, /window\.notesApi\.updateNote\(id, draft, cloneNote\(expectedNote\)\)/);
  assert.match(source, /window\.notesApi\.previewNoteDelete\(id\)/);
  assert.match(source, /sameNoteIdSet\(preview\.expectedIds, confirmedPreview\.expectedIds\)/);
  assert.match(source, /window\.notesApi\.deleteNote\(\{[\s\S]*?expectedIds: confirmedPreview\.expectedIds/);
  assert.match(source, /result\.status === 'changed'/);
  assert.match(source, /note\.language === 'richtext'[\s\S]*?extractRichTextPlainText\(note\.content\)[\s\S]*?window\.serviceApi\.writeClipboardText\(content\)/);
  assert.match(source, /window\.serviceApi\.confirmAction\(\{/);
  assert.match(source, /NOTE_SAVE_DEBOUNCE_MS = 250/);
  assert.match(source, /setTimeout\([\s\S]*NOTE_SAVE_DEBOUNCE_MS/);
  assert.match(source, /hide\(\): void \{[\s\S]*?this\.active = false[\s\S]*?void this\.flush\(\)\.then\(\(\) => \{[\s\S]*?this\.releaseEditorResources\(\)/);
  assert.match(source, /A failed save keeps the editor and its document alive/);
  assert.match(source, /async flush\(\): Promise<void> \{[\s\S]*?this\.finishSidebarResize\(\)[\s\S]*?this\.flushQueuedSidebarWidthSave\(\)[\s\S]*?this\.waitForSidebarWidthSaves\(\)/);
  assert.match(source, /private async selectNote\(id: string, source: 'tree' \| 'tab' = 'tree'\): Promise<void>/);
  assert.match(source, /await this\.flushNote\(previousId\);\s*if \(this\.isDirty\(previousId\)\)/);
  assert.ok((source.match(/await this\.flushAllPendingSaves\(\)/g) ?? []).length >= 3);
  assert.match(source, /this\.notes\.some\(\(note\) => !this\.deletedIds\.has\(note\.id\) && this\.isDirty\(note\.id\)\)/);
  assert.match(source, /throw new Error\('Some notes could not be saved\. Fix the save error before syncing\.'\)/);
  assert.match(source, /const restoreFocusId = focusId \?\? activeItem\?\.dataset\.noteId/);
  assert.match(source, /if \(!this\.selectedId\) this\.newButton\.focus\(\)/);
  assert.match(source, /window\.notesApi\.onFlushRequested\(\(request\) => request\.persistentApplyId/);
  assert.match(source, /page\?\.lockForPersistentApply\(request\.persistentApplyId\)/);
  assert.match(source, /window\.notesApi\.onPersistentApplyReleased\(\(persistentApplyId\)/);
  assert.match(source, /name\.textContent = note\.name \|\| 'Untitled'/);
  assert.match(source, /this\.saveStatus\.textContent = text/);
  assert.match(source, /private async deleteNote\(id: string\)/);
  assert.match(source, /this\.treeNodes\.filter\(\(node\) => !this\.deletedIds\.has\(node\.noteId\)\)/);
  assert.match(source, /this\.selectedId = noteTabFallbackAfterRemoval\([\s\S]*?\?\? focusAfterDelete/);
  assert.match(source, /remove\.disabled = this\.deletingNoteIds\.has\(note\.id\)/);
  assert.match(source, /this\.pageRoot\.inert = true/);
  assert.match(source, /window\.notesApi\.recoverDrafts\(pending\)/);
  assert.match(source, /expectedNote: cloneNote\(expectedNote\)/);
  assert.match(source, /private readonly persistedNotes = new Map<string, Note>\(\)/);
  assert.match(source, /if \(saveGeneration !== this\.saveGeneration \|\| this\.deletedIds\.has\(id\)\) return/);
  assert.match(source, /preserved as Conflict/);
  assert.match(source, /remove\.setAttribute\('aria-label', `Remove \$\{note\.name \|\| 'Untitled'\}`\)/);
  assert.match(source, /remove\.addEventListener\('click', \(event\) => \{\s*event\.stopPropagation\(\);\s*void this\.deleteNote\(note\.id\);/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
});

test('Notes tree workspace mutations flush first, fence request-time edits, persist expansion, and expose keyboard navigation', async () => {
  const source = await readFile(path.join(root, 'src', 'renderer', 'pages', 'notesPage.ts'), 'utf8');

  assert.match(source, /const editedDuringRequest = local[\s\S]*?this\.editVersions\.get\(summary\.id\)[\s\S]*?> baselineVersion/);
  assert.match(source, /this\.applyWorkspace\(workspace, editVersionBaseline\)/);
  assert.match(source, /this\.applyWorkspace\(\{[\s\S]*?notes: this\.notes\.filter[\s\S]*?tree: result\.tree[\s\S]*?expandedNoteIds: result\.expandedNoteIds[\s\S]*?\}, editVersionBaseline, true\)/);
  assert.match(source, /window\.notesApi\.setTreeExpanded\(\{ noteId, expanded \}\)/);
  assert.match(source, /button\.addEventListener\('click', \(\) => \{\s*if \(searchActive\) \{\s*void this\.revealSearchResult\(note\.id\);\s*return;\s*\}\s*void this\.selectNote\(note\.id\);/);
  assert.match(source, /private async revealSearchResult\(noteId: string\): Promise<void> \{[\s\S]*?this\.clearWorkspaceSearch\(\);[\s\S]*?await this\.revealTreeNote\(noteId, true\)/);
  assert.match(source, /private async revealTreeNote\(noteId: string, focusTreeRow: boolean\): Promise<void> \{[\s\S]*?noteTreeAncestorIdsFromIndexes\(noteId, this\.treeNodesById\)[\s\S]*?this\.renderedRowsById\.get\(noteId\)\?\.scrollIntoView\(\{ block: 'nearest' \}\)[\s\S]*?window\.notesApi\.setTreeExpanded\(\{\s*noteIds: collapsedAncestorIds,\s*expanded: true,/);
  assert.match(source, /if \(hasChildren && !searchActive\) \{\s*button\.setAttribute\('aria-expanded', String\(this\.expandedNoteIds\.has\(note\.id\)\)\);/);
  assert.match(source, /toggleButton\.addEventListener\('click', \(event\) => \{\s*event\.stopPropagation\(\);\s*void this\.toggleTreeExpanded\(note\.id\);/);
  assert.match(source, /resolveNoteTreeDropPlacement\(this\.treeNodes, this\.draggingNoteId, target\.noteId, position\)/);
  assert.match(source, /if \(!isValidNoteTreeParent\(this\.treeNodes, noteId, parentId\)\)/);
  assert.match(source, /event\.key === 'ArrowRight' \|\| event\.key === 'ArrowLeft'/);
  assert.match(source, /if \(!this\.expandedNoteIds\.has\(noteId\)\) void this\.toggleTreeExpanded\(noteId\)/);
  assert.match(source, /else if \(node\?\.parentId\) items\.find\(\(candidate\) => candidate\.dataset\.noteId === node\.parentId\)\?\.focus\(\)/);
});

test('Notes tree distinguishes folders from leaf Notes and the title looks like text until interaction', async () => {
  const [source, styles] = await Promise.all([
    readFile(path.join(root, 'src', 'renderer', 'pages', 'notesPage.ts'), 'utf8'),
    readFile(path.join(distRenderer, 'tailwind.css'), 'utf8'),
  ]);

  assert.match(source, /const folderNoteIds = new Set\([\s\S]*?treeNode\.parentId[\s\S]*?typeof parentId === 'string'/);
  assert.match(source, /const hasChildren = folderNoteIds\.has\(note\.id\)/);
  assert.match(source, /typeIcon\.className = 'notes-tree-type-icon'/);
  assert.match(source, /typeIcon\.dataset\.type = hasChildren \? 'folder' : 'note'/);
  assert.match(source, /this\.expandedNoteIds\.has\(note\.id\)[\s\S]*?'M2\.25 4\.75h4l1\.25 1\.5h6\.25v6\.5H2\.25z[\s\S]*?'M4 2\.5h5l3 3v8H4z/);
  assert.doesNotMatch(source, /this\.expandedNoteIds\.has\(note\.id\) && !searchActive/);
  assert.match(styles, /\.notes-tree-type-icon\{[^}]*display:inline-flex[^}]*height:1rem[^}]*width:1rem/);
  assert.match(styles, /\.notes-tree-type-icon\[data-type=folder\]\{[^}]*color:/);

  assert.match(styles, /\.notes-editor-toolbar \.notes-name-input\{[^}]*border-color:transparent[^}]*background-color:transparent[^}]*font-weight:600[^}]*box-shadow:/);
  assert.match(styles, /\.notes-editor-toolbar \.notes-name-input:hover\{[^}]*border-color:/);
  assert.match(styles, /\.notes-editor-toolbar \.notes-name-input:focus,\.notes-editor-toolbar \.notes-name-input:hover\{[^}]*background-color:/);
  assert.match(source, /this\.nameInput\.addEventListener\('input', \(\) => this\.updateSelectedMetadata\(\)\)/);
});

test('Notes page connects Markdown tooling, attachment actions, and PDF or Markdown downloads', async () => {
  const source = await readFile(path.join(root, 'src', 'renderer', 'pages', 'notesPage.ts'), 'utf8');

  assert.match(source, /import \{[\s\S]*?applyMarkdownFormat,[\s\S]*?extractMarkdownOutline,[\s\S]*?getMarkdownStats,[\s\S]*?renderMarkdownToSafeHtml,[\s\S]*?\} from '\.\.\/notesMarkdown\.js'/);
  assert.match(source, /const edit = applyMarkdownFormat\([\s\S]*?changes: edit\.change,[\s\S]*?anchor: edit\.selection\.from, head: edit\.selection\.to/);
  for (const command of ['bold', 'italic', 'strike', 'code', 'heading1', 'heading2', 'heading3', 'link', 'quote', 'bullet', 'numbered', 'task', 'table', 'horizontalRule']) {
    assert.match(source, new RegExp(`${command}: \\{ command:`));
  }
  assert.match(source, /DOMParser\(\)\.parseFromString\([\s\S]*?renderMarkdownToSafeHtml\(markdown\)/);
  assert.match(source, /const headings = extractMarkdownOutline\(this\.codeEditor\.state\.doc\.toString\(\)\)/);
  assert.match(source, /this\.markdownDocumentStatsText = `\$\{stats\.words\} words · \$\{stats\.characters\} characters · \$\{stats\.lines\} lines/);
  assert.match(source, /this\.markdownStatus\.textContent = `\$\{this\.markdownDocumentStatsText\}\$\{selectionText\}`/);

  assert.match(source, /onRequestAttachment: \(file, position\) => \{[\s\S]*?this\.uploadAttachmentFile\(file, position\)[\s\S]*?this\.attachmentInput\.click\(\)/);
  assert.match(source, /NOTE_ATTACHMENT_MAX_BYTES = 25 \* 1024 \* 1024/);
  assert.match(source, /window\.notesApi\.uploadAttachment\(\{[\s\S]*?normalizeNoteAttachmentFileName\(file\.name\)[\s\S]*?application\/octet-stream/);
  assert.match(source, /this\.richTextEditor\.insertAttachment\(result\.reference, capturedPosition\)/);
  assert.match(source, /if \(action === 'view'\) \{\s*await this\.openAttachmentPreview\(reference, opener\);\s*return;/);
  assert.match(source, /const expectedKind = noteAttachmentPreviewKind\(reference\)/);
  assert.match(source, /openDialog\(this\.attachmentPreviewDialog\)[\s\S]*?window\.notesApi\.viewAttachment\(reference\)/);
  assert.match(source, /result\.preview\.kind === 'text'[\s\S]*?this\.attachmentPreviewText\.textContent = result\.preview\.text/);
  assert.match(source, /result\.preview\.kind === 'pdf' \? 'application\/pdf'[\s\S]*?URL\.createObjectURL\(new Blob/);
  assert.match(source, /this\.attachmentPreviewPdf\.src = `\$\{objectUrl\}#toolbar=0&navpanes=0`/);
  assert.match(source, /removeAttribute\('src'\)[\s\S]*?URL\.revokeObjectURL\(this\.attachmentPreviewObjectUrl\)/);
  assert.match(source, /request !== this\.attachmentPreviewRequest \|\| !this\.attachmentPreviewDialog\.open/);
  assert.match(source, /if \(opener\?\.isConnected\) opener\.focus\(\)/);
  assert.match(source, /window\.notesApi\.downloadAttachment\(reference\)/);

  const downloadStart = source.indexOf('  private async handleDownloadMenuClick(event: Event): Promise<void> {');
  const downloadEnd = source.indexOf('  private async copySelectedNote(): Promise<void> {', downloadStart);
  assert.ok(downloadStart >= 0 && downloadEnd > downloadStart);
  const download = source.slice(downloadStart, downloadEnd);
  assert.match(download, /format !== 'pdf' && format !== 'markdown'/);
  assert.match(download, /this\.captureEditorContent\(note\.id\)[\s\S]*?await this\.flushNote\(note\.id\)[\s\S]*?window\.notesApi\.exportNote\(\{/);
  assert.match(download, /language: current\.language,[\s\S]*?content: current\.content,[\s\S]*?format/);
  assert.match(download, /format === 'pdf' \? 'PDF' : 'Markdown'/);
  assert.match(download, /result\.canOpen \? `\$\{label\} saved\. Click to open\.` : `\$\{label\} saved\.`/);
  assert.match(download, /result\.canOpen \? 'open-note-export' : undefined/);
  assert.doesNotMatch(download, /result\.path/);
  assert.match(download, /this\.noteExportInFlight = true;[\s\S]*?this\.updateDownloadButtonState\(\)[\s\S]*?finally \{[\s\S]*?this\.noteExportInFlight = false;[\s\S]*?this\.updateDownloadButtonState\(\)/);

  const showEditorModeStart = source.indexOf('  private showEditorMode(language: NoteLanguage): void {');
  const updateDownloadStateStart = source.indexOf('  private updateDownloadButtonState(): void {', showEditorModeStart);
  const saveStatusStart = source.indexOf('  private setSaveStatus(', updateDownloadStateStart);
  assert.ok(showEditorModeStart >= 0 && updateDownloadStateStart > showEditorModeStart && saveStatusStart > updateDownloadStateStart);
  const showEditorMode = source.slice(showEditorModeStart, updateDownloadStateStart);
  const updateDownloadState = source.slice(updateDownloadStateStart, saveStatusStart);
  assert.match(showEditorMode, /this\.updateDownloadButtonState\(\)/);
  assert.doesNotMatch(showEditorMode, /downloadButton\.disabled\s*=/);
  assert.match(updateDownloadState, /this\.downloadButton\.disabled = this\.noteExportInFlight \|\| !exportable/);
  assert.match(updateDownloadState, /aria-busy/);
});

test('Notes share action sits between Copy and Download and owns link history workflow', async () => {
  const [source, html, styles] = await Promise.all([
    readFile(path.join(root, 'src', 'renderer', 'pages', 'notesPage.ts'), 'utf8'),
    readFile(path.join(root, 'src', 'renderer', 'index.html'), 'utf8'),
    readFile(path.join(distRenderer, 'tailwind.css'), 'utf8'),
  ]);

  const copyIndex = html.indexOf('id="note-copy-btn"');
  const shareIndex = html.indexOf('id="note-share-btn"');
  const downloadIndex = html.indexOf('id="note-download-btn"');
  assert.ok(copyIndex >= 0 && shareIndex > copyIndex && downloadIndex > shareIndex);
  assert.match(html, /id="note-share-dialog"/);
  assert.match(html, /id="note-share-duration"[\s\S]*?<option value="24">24 hours<\/option>[\s\S]*?<option value="72">3 days<\/option>[\s\S]*?<option value="168">7 days<\/option>/);
  assert.match(html, /<span id="note-share-url" class="note-share-url" aria-label="Current share link"><\/span>/);
  assert.doesNotMatch(html, /<input[^>]+id="note-share-url"/);
  assert.match(html, /id="note-share-copy"[\s\S]*>Copy Link<\/button>/);
  assert.match(html, /id="note-share-history"/);

  assert.match(source, /private readonly shareButton = requireElement<HTMLButtonElement>\('#note-share-btn'\)/);
  assert.match(source, /this\.shareButton\.addEventListener\('click', \(\) => void this\.openShareDialog\(\)\)/);
  assert.match(source, /this\.captureEditorContent\(note\.id\)[\s\S]*?await this\.flushNote\(note\.id\)[\s\S]*?window\.notesApi\.createShare\(\{/);
  assert.match(source, /expiresInHours: this\.shareSelectedDuration/);
  assert.match(source, /window\.notesApi\.resignShare\(\{/);
  assert.match(source, /window\.notesApi\.deleteShare\(noteId, deleteShareId\)/);
  assert.match(source, /window\.serviceApi\.writeClipboardText\(url\)/);
  assert.match(source, /this\.shareHistoryList\.replaceChildren\(this\.renderShareHistoryFragment\(\)\)/);
  assert.match(source, /document\.createElement\('article'\)/);
  assert.match(source, /dataset\.noteShareCopy = share\.shareId/);
  assert.match(source, /dataset\.noteShareMenu = share\.shareId/);
  assert.match(source, /dataset\.noteShareDelete = share\.shareId/);
  assert.doesNotMatch(source, /note-share-history[\s\S]*?innerHTML\s*=/);

  assert.match(styles, /\.note-share-panel\{/);
  assert.match(styles, /\.note-share-history\{/);
  assert.match(styles, /\.note-share-current-row\{/);
  assert.match(styles, /\.note-share-history-menu\{/);
});

test('Notes page keeps user content in form values and reconfigurable CodeMirror state created through DOM APIs', async () => {
  const source = await readFile(path.join(root, 'src', 'renderer', 'pages', 'notesPage.ts'), 'utf8');

  assert.match(source, /import \{ basicSetup, EditorView \} from 'codemirror'/);
  assert.match(source, /import \{ Compartment, EditorState, type Extension \} from '@codemirror\/state'/);
  assert.match(source, /new EditorView\(\{\s*state: this\.createEditorState\('', 'markdown'\)/);
  assert.match(source, /return EditorState\.create\(\{/);
  assert.match(source, /EditorView\.updateListener\.of/);
  assert.match(source, /EditorView\.contentAttributes\.of/);
  assert.match(source, /document\.createElement\('button'\)/);
  assert.match(source, /document\.createElement\('span'\)/);
  assert.match(source, /createIcon\(/);
  assert.match(source, /this\.nameInput\.value = note\.name/);
  assert.match(source, /this\.codeEditor\.setState\(this\.createEditorState\(note\.content, note\.language\)\)/);
  assert.match(source, /this\.replaceEditorDocument\(note\.content\)/);
  assert.match(source, /const content = note\.language === 'richtext'[\s\S]*?this\.codeEditor\.state\.doc\.toString\(\)/);
  assert.match(source, /new NotesRichTextEditor\(\{/);
  assert.match(source, /this\.replaceRichTextDocument\(note\.content\)/);
  assert.match(source, /note\.content = content/);
  assert.match(source, /this\.languageCompartment\.of\(noteLanguageExtension\(language\)\)/);
  assert.match(source, /this\.languageCompartment\.reconfigure\(noteLanguageExtension\(language\)\)/);
  assert.match(source, /this\.setEditorLanguage\(note\.language\)/);
  assert.match(source, /this\.codeEditor\.dispatch\(\{/);
  assert.doesNotMatch(source, /tagsInput|normalizeTags/);
  assert.match(source, /tags: \[\.\.\.note\.tags\]/);
});

test('Notes editor input marks dirty without serializing the complete document until capture', async () => {
  const source = await readFile(path.join(root, 'src', 'renderer', 'pages', 'notesPage.ts'), 'utf8');
  const codeUpdateStart = source.indexOf('  private updateSelectedCodeContent(): void {');
  const codeUpdateEnd = source.indexOf('  private markdownActive(): boolean {', codeUpdateStart);
  const richUpdateStart = source.indexOf('  private updateSelectedRichTextContent(): void {');
  const markEditedStart = source.indexOf('  private markNoteEdited(', richUpdateStart);
  const captureStart = source.indexOf('  private captureEditorContent(', markEditedStart);
  const languageStart = source.indexOf('  private async changeSelectedLanguage(', captureStart);
  assert.ok(codeUpdateStart >= 0 && codeUpdateEnd > codeUpdateStart && richUpdateStart > codeUpdateEnd);
  assert.ok(markEditedStart > richUpdateStart && captureStart > markEditedStart && languageStart > captureStart);

  const codeUpdate = source.slice(codeUpdateStart, codeUpdateEnd);
  const richUpdate = source.slice(richUpdateStart, markEditedStart);
  const capture = source.slice(captureStart, languageStart);
  assert.doesNotMatch(codeUpdate, /doc\.toString\(\)/);
  assert.doesNotMatch(richUpdate, /getContent\(\)|normalizeRichTextContent|JSON\.stringify/);
  assert.match(codeUpdate, /this\.markNoteEdited\(note, false, false\)/);
  assert.match(richUpdate, /this\.markNoteEdited\(note, false, false\)/);
  assert.match(capture, /this\.richTextEditor\.getContent\(\)/);
  assert.match(capture, /this\.codeEditor\.state\.doc\.toString\(\)/);
  assert.match(source, /private flushNote\(id: string\)[\s\S]*?this\.captureEditorContent\(id\)/);
});

test('Notes workspace mutations capture deferred editor content and preserve newer selection intent', async () => {
  const source = await readFile(path.join(root, 'src', 'renderer', 'pages', 'notesPage.ts'), 'utf8');
  const moveStart = source.indexOf('  private async moveNote(');
  const createStart = source.indexOf('  private async createNote(', moveStart);
  const downloadStart = source.indexOf('  private toggleDownloadMenu(', createStart);
  const deleteStart = source.indexOf('  private async deleteNote(');
  const listKeydownStart = source.indexOf('  private handleListKeydown(', deleteStart);
  assert.ok(moveStart >= 0 && createStart > moveStart && downloadStart > createStart);
  assert.ok(deleteStart > downloadStart && listKeydownStart > deleteStart);

  const move = source.slice(moveStart, createStart);
  const create = source.slice(createStart, downloadStart);
  const deletion = source.slice(deleteStart, listKeydownStart);
  assert.match(move, /await window\.notesApi\.moveNote\([\s\S]*?this\.captureActiveEditorContent\(\);[\s\S]*?this\.applyWorkspace/);
  assert.match(create, /const selectionIntentVersion = this\.selectionVersion/);
  assert.match(create, /await window\.notesApi\.createNote\([\s\S]*?this\.captureActiveEditorContent\(\);[\s\S]*?this\.applyWorkspace/);
  assert.match(create, /selectionIntentVersion === this\.selectionVersion/);
  assert.match(create, /committedSelectionVersion !== this\.selectionVersion \|\| this\.selectedId !== note\.id/);
  assert.match(deletion, /this\.captureActiveEditorContent\(\);[\s\S]*?let optimisticSelectionVersion/);
  assert.match(deletion, /optimisticSelectionVersion === this\.selectionVersion/g);
  assert.match(source, /const selectionVersion = \+\+this\.selectionVersion;\s*if \(id === this\.selectedId\) \{[\s\S]*?this\.openNoteTab\(id, true\)/);
});

test('Notes flush owns active uploads and captured insertion positions are edit and workspace fenced', async () => {
  const source = await readFile(path.join(root, 'src', 'renderer', 'pages', 'notesPage.ts'), 'utf8');
  assert.match(source, /private readonly editorUploadTasks = new Set<Promise<void>>\(\)/);
  assert.match(source, /async flush\(\): Promise<void> \{[\s\S]*?await this\.waitForEditorUploads\(\);[\s\S]*?this\.flushAllPendingSaves\(\)/);
  assert.match(source, /private async waitForEditorUploads\(\): Promise<void> \{[\s\S]*?Promise\.allSettled\(\[\.\.\.this\.editorUploadTasks\]\)/);
  assert.match(source, /this\.pageRoot\.inert = true;[\s\S]*?await this\.flush\(\)/);
  assert.match(source, /await this\.waitForEditorUploads\(\);\s*this\.workspaceMutationGeneration \+= 1/);
  assert.match(source, /const insertionFence = \{[\s\S]*?editVersion:[\s\S]*?selectionVersion:[\s\S]*?workspaceGeneration:/g);
  assert.match(source, /insertionFence\.workspaceGeneration !== this\.workspaceMutationGeneration/g);
  assert.match(source, /insertionFence\.editVersion === \(this\.editVersions\.get\(destination\.id\) \?\? 0\)[\s\S]*?insertionFence\.selectionVersion === this\.selectionVersion/g);
});
