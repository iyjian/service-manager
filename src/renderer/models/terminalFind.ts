import type { IBuffer } from '@xterm/xterm';
import { findNotesTextMatches } from './notesFind.js';

export interface TerminalFindCell { row: number; col: number; width: number }
export interface TerminalFindMatch { start: TerminalFindCell; end: TerminalFindCell }
export const TERMINAL_FIND_LIMIT = 2000;

/** Search logical lines, mapping UTF-16 offsets back to terminal cells. */
export function findTerminalMatches(buffer: IBuffer, query: string, limit = TERMINAL_FIND_LIMIT): {
  matches: TerminalFindMatch[]; truncated: boolean;
} {
  const matches: TerminalFindMatch[] = [];
  if (!query) return { matches, truncated: false };
  let text = '';
  let positions: TerminalFindCell[] = [];
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const wrappedNext = buffer.getLine(row + 1)?.isWrapped;
    const length = line.translateToString(!wrappedNext).length;
    let lineText = '';
    for (let col = 0; col < line.length && lineText.length < length; col++) {
      const cell = line.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
      // A wide character can leave an unused final cell before wrapping.
      if (wrappedNext && col === line.length - 1 && !cell.getChars()
        && buffer.getLine(row + 1)?.getCell(0)?.getWidth() === 2) continue;
      const chars = cell.getChars() || ' ';
      const position = { row, col, width: cell.getWidth() };
      lineText += chars;
      for (let i = 0; i < chars.length; i++) positions.push(position);
    }
    text += lineText;
    if (wrappedNext) continue;
    const found = findNotesTextMatches(text, query, Math.max(1, limit - matches.length + 1));
    for (const match of found.matches) {
      if (matches.length >= limit) return { matches, truncated: true };
      matches.push({ start: positions[match.from], end: positions[match.to - 1] });
    }
    text = ''; positions = [];
  }
  return { matches, truncated: false };
}
