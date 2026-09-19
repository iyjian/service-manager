import type { TerminalPreferences } from './types';

export const DEFAULT_TERMINAL_PREFERENCES: Readonly<TerminalPreferences> = Object.freeze({
  fontFamily: 'Monaco', fontSize: 18, theme: 'default',
});
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 40;
export const TERMINAL_THEMES = ['default', 'light', 'dracula', 'solarized-dark'] as const;

export function normalizeTerminalPreferences(value: unknown): TerminalPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Terminal preferences are invalid.');
  const draft = value as Record<string, unknown>;
  if (typeof draft.fontFamily !== 'string' || !draft.fontFamily.trim()
    || draft.fontFamily.length > 100 || /[\x00-\x1f\x7f"'\\;,{}<>]/.test(draft.fontFamily)) {
    throw new Error('Enter a valid terminal font name.');
  }
  if (!Number.isInteger(draft.fontSize) || Number(draft.fontSize) < MIN_TERMINAL_FONT_SIZE
    || Number(draft.fontSize) > MAX_TERMINAL_FONT_SIZE) {
    throw new Error(`Terminal font size must be a whole number from ${MIN_TERMINAL_FONT_SIZE} to ${MAX_TERMINAL_FONT_SIZE}.`);
  }
  if (!TERMINAL_THEMES.includes(draft.theme as TerminalPreferences['theme'])) throw new Error('Terminal theme is invalid.');
  return { fontFamily: draft.fontFamily.trim(), fontSize: Number(draft.fontSize), theme: draft.theme as TerminalPreferences['theme'] };
}
