import type { SqlEnvironment } from '../shared/types';

export const SQL_UNTITLED_DRAFTS_STORAGE_KEY = 'sql:untitled-drafts:v1';
export const SQL_UNTITLED_DRAFT_MAX_TABS_PER_ENVIRONMENT = 32;
export const SQL_UNTITLED_DRAFT_MAX_SOURCE_CHARACTERS = 1_000_000;
export const SQL_UNTITLED_DRAFT_MAX_TOTAL_CHARACTERS = 2_000_000;

export interface SqlUntitledDraftEnvironmentState {
  sources: string[];
  activeIndex: number;
}

export type SqlUntitledDraftState = Record<SqlEnvironment, SqlUntitledDraftEnvironmentState>;

interface SqlUntitledDraftWireState {
  version: 1;
  environments: SqlUntitledDraftState;
}

function emptyEnvironmentState(): SqlUntitledDraftEnvironmentState {
  return { sources: [], activeIndex: 0 };
}

export function emptySqlUntitledDraftState(): SqlUntitledDraftState {
  return {
    production: emptyEnvironmentState(),
    development: emptyEnvironmentState(),
  };
}

export function normalizeSqlEditorSource(source: string): string {
  return source.replace(/\t/g, '  ');
}

function parseEnvironmentState(
  value: unknown,
  totalCharacters: { value: number },
): SqlUntitledDraftEnvironmentState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as { sources?: unknown; activeIndex?: unknown };
  if (!Array.isArray(candidate.sources)
    || candidate.sources.length > SQL_UNTITLED_DRAFT_MAX_TABS_PER_ENVIRONMENT) return undefined;
  const sources: string[] = [];
  for (const source of candidate.sources) {
    if (typeof source !== 'string' || source.length > SQL_UNTITLED_DRAFT_MAX_SOURCE_CHARACTERS) {
      return undefined;
    }
    const normalized = normalizeSqlEditorSource(source);
    totalCharacters.value += normalized.length;
    if (totalCharacters.value > SQL_UNTITLED_DRAFT_MAX_TOTAL_CHARACTERS) return undefined;
    sources.push(normalized);
  }
  if (!Number.isInteger(candidate.activeIndex)) return undefined;
  const activeIndex = candidate.activeIndex as number;
  if (sources.length === 0) {
    if (activeIndex !== 0) return undefined;
  } else if (activeIndex < 0 || activeIndex >= sources.length) {
    return undefined;
  }
  return { sources, activeIndex };
}

/** Invalid or oversized local data fails closed to an empty draft workspace. */
export function parseSqlUntitledDraftState(raw: string | null): SqlUntitledDraftState {
  if (!raw) return emptySqlUntitledDraftState();
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptySqlUntitledDraftState();
    const wire = value as { version?: unknown; environments?: unknown };
    if (wire.version !== 1 || !wire.environments || typeof wire.environments !== 'object'
      || Array.isArray(wire.environments)) return emptySqlUntitledDraftState();
    const environments = wire.environments as Record<string, unknown>;
    const totalCharacters = { value: 0 };
    const production = parseEnvironmentState(environments.production, totalCharacters);
    const development = parseEnvironmentState(environments.development, totalCharacters);
    if (!production || !development) return emptySqlUntitledDraftState();
    return { production, development };
  } catch {
    return emptySqlUntitledDraftState();
  }
}

function validateEnvironmentState(
  state: SqlUntitledDraftEnvironmentState,
  totalCharacters: { value: number },
): SqlUntitledDraftEnvironmentState {
  if (state.sources.length > SQL_UNTITLED_DRAFT_MAX_TABS_PER_ENVIRONMENT) {
    throw new Error('Too many Untitled SQL drafts are open to save locally.');
  }
  const sources = state.sources.map((source) => {
    const normalized = normalizeSqlEditorSource(source);
    if (normalized.length > SQL_UNTITLED_DRAFT_MAX_SOURCE_CHARACTERS) {
      throw new Error('An Untitled SQL draft is too large to save locally.');
    }
    totalCharacters.value += normalized.length;
    if (totalCharacters.value > SQL_UNTITLED_DRAFT_MAX_TOTAL_CHARACTERS) {
      throw new Error('Untitled SQL drafts are too large to save locally.');
    }
    return normalized;
  });
  const activeIndex = sources.length === 0
    ? 0
    : Math.min(Math.max(Math.trunc(state.activeIndex), 0), sources.length - 1);
  return { sources, activeIndex };
}

export function serializeSqlUntitledDraftState(state: SqlUntitledDraftState): string {
  const totalCharacters = { value: 0 };
  const wire: SqlUntitledDraftWireState = {
    version: 1,
    environments: {
      production: validateEnvironmentState(state.production, totalCharacters),
      development: validateEnvironmentState(state.development, totalCharacters),
    },
  };
  return JSON.stringify(wire);
}
