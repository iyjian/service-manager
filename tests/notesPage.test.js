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
    import(path.join(distRenderer, 'notesPage.js')),
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

test('Notes search ranks name matches ahead of global metadata and content matches', async () => {
  const { rankNotes } = await import(path.join(distRenderer, 'notesPage.js'));
  const notes = [
    note({ id: 'content', name: 'Runbook', content: 'deploy api server' }),
    note({ id: 'tag', name: 'Operations', tags: ['api'] }),
    note({ id: 'name-contains', name: 'Internal API client' }),
    note({ id: 'name-prefix', name: 'API examples' }),
    note({ id: 'name-exact', name: 'api' }),
  ];

  assert.deepEqual(
    rankNotes(notes, ' API ').map(({ id }) => id),
    ['name-exact', 'name-prefix', 'name-contains', 'tag', 'content'],
  );
});

test('Notes search includes lower-priority language matches and drops unrelated notes', async () => {
  const { rankNotes } = await import(path.join(distRenderer, 'notesPage.js'));
  const notes = [
    note({ id: 'language', name: 'Typed helper', language: 'typescript' }),
    note({ id: 'content', name: 'Compiler note', content: 'typescript narrowing' }),
    note({ id: 'unrelated', name: 'Shell aliases', language: 'bash' }),
  ];

  assert.deepEqual(rankNotes(notes, 'typescript').map(({ id }) => id), ['language', 'content']);
});

test('Notes empty search sorts by updated time descending and stays stable for ties', async () => {
  const { rankNotes } = await import(path.join(distRenderer, 'notesPage.js'));
  const notes = [
    note({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
    note({ id: 'new-a', updatedAt: '2026-03-01T00:00:00.000Z' }),
    note({ id: 'new-b', updatedAt: '2026-03-01T00:00:00.000Z' }),
  ];

  assert.deepEqual(rankNotes(notes, '  ').map(({ id }) => id), ['new-a', 'new-b', 'old']);
  assert.deepEqual(notes.map(({ id }) => id), ['old', 'new-a', 'new-b']);
});

test('Notes ranking keeps one hundred list entries available for the scrolling sidebar', async () => {
  const { rankNotes } = await import(path.join(distRenderer, 'notesPage.js'));
  const notes = Array.from({ length: 100 }, (_, index) => note({
    id: `note-${index}`,
    name: `Snippet ${String(index).padStart(3, '0')}`,
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }));

  const ranked = rankNotes(notes, '');
  assert.equal(ranked.length, 100);
  assert.equal(ranked[0].id, 'note-99');
  assert.equal(ranked[99].id, 'note-0');
});

test('Notes tree renders arbitrary expanded levels and search breadcrumbs keep the complete ancestor path', async () => {
  const {
    noteTreeBreadcrumb,
    noteTreeSubtreeIds,
    visibleNoteTreeRows,
  } = await import(path.join(distRenderer, 'notesPage.js'));
  const notes = [
    note({ id: 'root', name: 'Root' }),
    note({ id: 'child', name: 'Child' }),
    note({ id: 'grandchild', name: 'Grandchild' }),
    note({ id: 'second-child', name: 'Second child' }),
    note({ id: 'sibling', name: 'Sibling' }),
  ];
  const nodes = [
    { noteId: 'root', parentId: null, order: 10 },
    { noteId: 'child', parentId: 'root', order: 10 },
    { noteId: 'grandchild', parentId: 'child', order: 10 },
    { noteId: 'second-child', parentId: 'root', order: 20 },
    { noteId: 'sibling', parentId: null, order: 20 },
  ];

  assert.deepEqual(
    visibleNoteTreeRows(notes, nodes, new Set(['root', 'child']))
      .map(({ note: item, depth }) => [item.id, depth]),
    [['root', 0], ['child', 1], ['grandchild', 2], ['second-child', 1], ['sibling', 0]],
  );
  assert.deepEqual(
    visibleNoteTreeRows(notes, nodes, new Set(['root']))
      .map(({ note: item, depth }) => [item.id, depth]),
    [['root', 0], ['child', 1], ['second-child', 1], ['sibling', 0]],
  );
  assert.equal(noteTreeBreadcrumb('grandchild', notes, nodes), 'Root / Child');
  assert.deepEqual(noteTreeSubtreeIds('root', nodes), ['root', 'child', 'grandchild', 'second-child']);
  assert.deepEqual(noteTreeSubtreeIds('missing', nodes), []);
});

test('Notes tree resolves before, inside, and after drops while rejecting self-descendant moves', async () => {
  const {
    isValidNoteTreeParent,
    resolveNoteTreeDropPlacement,
  } = await import(path.join(distRenderer, 'notesPage.js'));
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
  const source = await readFile(path.join(root, 'src', 'renderer', 'notesPage.ts'), 'utf8');

  assert.match(source, /registerPage\(\{\s*id: 'notes'/);
  assert.match(source, /window\.notesApi\.getWorkspace\(\)/);
  assert.match(source, /window\.notesApi\.createNote\(\{ parentId \}\)/);
  assert.match(source, /window\.notesApi\.updateNote\(id, draft, cloneNote\(expectedNote\)\)/);
  assert.match(source, /window\.notesApi\.deleteNote\(\{ id: note\.id, expectedIds: subtreeIds \}\)/);
  assert.match(source, /note\.language === 'richtext'[\s\S]*?extractRichTextPlainText\(note\.content\)[\s\S]*?window\.serviceApi\.writeClipboardText\(content\)/);
  assert.match(source, /window\.serviceApi\.confirmAction\(\{/);
  assert.match(source, /NOTE_SAVE_DEBOUNCE_MS = 250/);
  assert.match(source, /setTimeout\([\s\S]*NOTE_SAVE_DEBOUNCE_MS/);
  assert.match(source, /hide\(\): void \{\s*void this\.flushAllPendingSaves\(\)\.catch\(\(\) => undefined\);/);
  assert.match(source, /private async selectNote\(id: string\): Promise<void>/);
  assert.match(source, /await this\.flushNote\(previousId\);\s*if \(this\.isDirty\(previousId\)\)/);
  assert.ok((source.match(/await this\.flushAllPendingSaves\(\)/g) ?? []).length >= 3);
  assert.match(source, /this\.notes\.some\(\(note\) => !this\.deletedIds\.has\(note\.id\) && this\.isDirty\(note\.id\)\)/);
  assert.match(source, /throw new Error\('Some notes could not be saved\. Fix the save error before syncing\.'\)/);
  assert.match(source, /const restoreFocusId = focusId \?\? activeItem\?\.dataset\.noteId/);
  assert.match(source, /if \(!this\.selectedId\) this\.newButton\.focus\(\)/);
  assert.match(source, /window\.notesApi\.onFlushRequested\(\(\) => page\?\.flush\(\) \?\? Promise\.resolve\(\)\)/);
  assert.match(source, /name\.textContent = note\.name \|\| 'Untitled'/);
  assert.match(source, /this\.saveStatus\.textContent = text/);
  assert.match(source, /private async deleteNote\(id: string\)/);
  assert.match(source, /const subtreeIds = noteTreeSubtreeIds\(id, this\.treeNodes\)/);
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
  const source = await readFile(path.join(root, 'src', 'renderer', 'notesPage.ts'), 'utf8');

  assert.match(source, /const editedDuringRequest = local[\s\S]*?this\.editVersions\.get\(note\.id\)[\s\S]*?> baselineVersion/);
  assert.match(source, /this\.applyWorkspace\(workspace, editVersionBaseline\)/);
  assert.match(source, /this\.applyWorkspace\(result\.workspace, editVersionBaseline\)/);
  assert.match(source, /window\.notesApi\.setTreeExpanded\(\{ noteId, expanded \}\)/);
  assert.match(source, /resolveNoteTreeDropPlacement\(this\.treeNodes, this\.draggingNoteId, target\.noteId, position\)/);
  assert.match(source, /if \(!isValidNoteTreeParent\(this\.treeNodes, noteId, parentId\)\)/);
  assert.match(source, /event\.key === 'ArrowRight' \|\| event\.key === 'ArrowLeft'/);
  assert.match(source, /if \(!this\.expandedNoteIds\.has\(noteId\)\) void this\.toggleTreeExpanded\(noteId\)/);
  assert.match(source, /else if \(node\?\.parentId\) items\.find\(\(candidate\) => candidate\.dataset\.noteId === node\.parentId\)\?\.focus\(\)/);
});

test('Notes page keeps user content in form values and reconfigurable CodeMirror state created through DOM APIs', async () => {
  const source = await readFile(path.join(root, 'src', 'renderer', 'notesPage.ts'), 'utf8');

  assert.match(source, /import \{ basicSetup, EditorView \} from 'codemirror'/);
  assert.match(source, /import \{ Compartment, EditorState, type Extension \} from '@codemirror\/state'/);
  assert.match(source, /new EditorView\(\{\s*state: this\.createEditorState\('', 'markdown'\)/);
  assert.match(source, /return EditorState\.create\(\{/);
  assert.match(source, /EditorView\.updateListener\.of/);
  assert.match(source, /EditorView\.contentAttributes\.of/);
  assert.match(source, /document\.createElement\('button'\)/);
  assert.match(source, /document\.createElement\('span'\)/);
  assert.match(source, /document\.createElementNS\(namespace, 'svg'\)/);
  assert.match(source, /this\.nameInput\.value = note\.name/);
  assert.match(source, /this\.codeEditor\.setState\(this\.createEditorState\(note\.content, note\.language\)\)/);
  assert.match(source, /this\.replaceEditorDocument\(note\.content\)/);
  assert.match(source, /note\.content = this\.codeEditor\.state\.doc\.toString\(\)/);
  assert.match(source, /new NotesRichTextEditor\(\{/);
  assert.match(source, /this\.replaceRichTextDocument\(note\.content\)/);
  assert.match(source, /note\.content = content/);
  assert.match(source, /this\.languageCompartment\.of\(noteLanguageExtension\(language\)\)/);
  assert.match(source, /this\.languageCompartment\.reconfigure\(noteLanguageExtension\(language\)\)/);
  assert.match(source, /this\.setEditorLanguage\(note\.language\)/);
  assert.match(source, /this\.codeEditor\.dispatch\(\{/);
  assert.match(source, /note\.tags = normalizeTags\(this\.tagsInput\.value\)/);
});

test('Notes rich text mode searches readable content, confirms lossy changes, and uploads images through narrow IPC', async () => {
  const { rankNotes, plainTextToRichTextContent } = await loadNoteLanguageModules();
  const richContent = plainTextToRichTextContent('Alpha rich body');
  const richNote = note({ id: 'rich', language: 'richtext', content: richContent });
  assert.deepEqual(rankNotes([richNote], 'rich body').map(({ id }) => id), ['rich']);

  const source = await readFile(path.join(root, 'src', 'renderer', 'notesPage.ts'), 'utf8');
  assert.match(source, /title: leavingRichText \? 'Leave Rich Text\?' : 'Switch to Rich Text\?'/);
  assert.match(source, /window\.notesApi\.uploadImage\(\{/);
  assert.match(source, /Configure S3 in Settings before adding images\./);
  assert.match(source, /NOTE_IMAGE_MAX_BYTES = 10 \* 1024 \* 1024/);
  assert.match(source, /this\.richTextEditor\.insertImage\(result\.reference\)/);
});
