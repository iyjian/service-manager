export const CODE_HIGHLIGHT_LIMITS = Object.freeze({
  automaticCharacters: 10_000,
  explicitCharacters: 50_000,
  pdfTotalCharacters: 100_000,
});

export interface CodeHighlightLanguage {
  value: string;
  label: string;
  aliases: readonly string[];
}

function language(value: string, label: string, aliases: readonly string[] = []): CodeHighlightLanguage {
  return Object.freeze({ value, label, aliases: Object.freeze([...aliases]) });
}

/**
 * The exact Lowlight `common` grammar set, ordered for a compact authoring UI:
 * familiar choices first, then the remaining grammars alphabetically.
 */
export const CODE_HIGHLIGHT_LANGUAGES: readonly CodeHighlightLanguage[] = Object.freeze([
  language('plaintext', 'Plain Text', ['text', 'txt']),
  language('javascript', 'JavaScript', ['js', 'jsx', 'node']),
  language('typescript', 'TypeScript', ['ts', 'tsx']),
  language('json', 'JSON'),
  language('yaml', 'YAML', ['yml']),
  language('bash', 'Bash', ['sh', 'zsh']),
  language('shell', 'Shell Session', ['console', 'terminal']),
  language('sql', 'SQL'),
  language('python', 'Python', ['py']),
  language('markdown', 'Markdown', ['md']),
  language('xml', 'HTML / XML', ['html', 'xhtml', 'svg']),
  language('css', 'CSS'),
  language('arduino', 'Arduino'),
  language('c', 'C'),
  language('cpp', 'C++', ['c++']),
  language('csharp', 'C#', ['c#', 'cs']),
  language('diff', 'Diff', ['patch']),
  language('go', 'Go', ['golang']),
  language('graphql', 'GraphQL', ['gql']),
  language('ini', 'INI', ['toml']),
  language('java', 'Java'),
  language('kotlin', 'Kotlin', ['kt']),
  language('less', 'Less'),
  language('lua', 'Lua'),
  language('makefile', 'Makefile', ['make']),
  language('objectivec', 'Objective-C', ['objc']),
  language('perl', 'Perl', ['pl']),
  language('php', 'PHP'),
  language('php-template', 'PHP Template'),
  language('python-repl', 'Python REPL'),
  language('r', 'R'),
  language('ruby', 'Ruby', ['rb']),
  language('rust', 'Rust', ['rs']),
  language('scss', 'SCSS'),
  language('swift', 'Swift'),
  language('vbnet', 'Visual Basic .NET', ['vb']),
  language('wasm', 'WebAssembly', ['wat', 'webassembly']),
]);

const CODE_HIGHLIGHT_LANGUAGE_LOOKUP = new Map<string, CodeHighlightLanguage>();
for (const item of CODE_HIGHLIGHT_LANGUAGES) {
  CODE_HIGHLIGHT_LANGUAGE_LOOKUP.set(item.value, item);
  for (const alias of item.aliases) CODE_HIGHLIGHT_LANGUAGE_LOOKUP.set(alias, item);
}

export function findCodeHighlightLanguage(value: unknown): CodeHighlightLanguage | undefined {
  if (typeof value !== 'string') return undefined;
  return CODE_HIGHLIGHT_LANGUAGE_LOOKUP.get(value.trim().toLocaleLowerCase());
}

export function codeHighlightSearchText(item: CodeHighlightLanguage): string {
  return [item.label, item.value, ...item.aliases].join(' ').toLocaleLowerCase();
}
