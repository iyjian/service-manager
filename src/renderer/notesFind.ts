export const NOTES_FIND_MATCH_LIMIT = 10_000;

export interface NotesFindMatch {
  from: number;
  to: number;
}

export interface NotesFindResult {
  matches: readonly NotesFindMatch[];
  truncated: boolean;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Finds bounded, non-overlapping, case-insensitive literal matches. */
export function findNotesTextMatches(
  text: string,
  query: string,
  limit = NOTES_FIND_MATCH_LIMIT,
): NotesFindResult {
  const maximum = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : NOTES_FIND_MATCH_LIMIT;
  if (!query || maximum === 0) return { matches: [], truncated: false };

  const matcher = new RegExp(escapeRegularExpression(query), 'giu');
  const matches: NotesFindMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    if (matches.length === maximum) return { matches, truncated: true };
    matches.push({ from: match.index, to: match.index + match[0].length });
  }
  return { matches, truncated: false };
}

/** Selects the first result at or after the editor caret, wrapping to the start. */
export function initialNotesFindIndex(
  matches: readonly NotesFindMatch[],
  anchor: number,
): number {
  if (matches.length === 0) return -1;
  const index = matches.findIndex((match) => match.from >= anchor);
  return index >= 0 ? index : 0;
}

export function moveNotesFindIndex(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  const normalized = current >= 0 && current < count ? current : direction > 0 ? -1 : 0;
  return (normalized + direction + count) % count;
}
