import type { ITheme } from '@xterm/xterm';
import type { TerminalPreferences } from '../../shared/types';
import { DEFAULT_TERMINAL_PREFERENCES, normalizeTerminalPreferences } from '../terminalPreferences.js';

const themes: Record<TerminalPreferences['theme'], ITheme> = {
  default: { background: '#18181b', foreground: '#f4f4f5' },
  light: { background: '#fafafa', foreground: '#27272a', cursor: '#27272a', selectionBackground: '#bfdbfe',
    black: '#27272a', red: '#b91c1c', green: '#15803d', yellow: '#a16207', blue: '#1d4ed8', magenta: '#a21caf', cyan: '#0e7490', white: '#d4d4d8',
    brightBlack: '#71717a', brightRed: '#dc2626', brightGreen: '#16a34a', brightYellow: '#ca8a04', brightBlue: '#2563eb', brightMagenta: '#c026d3', brightCyan: '#0891b2', brightWhite: '#fafafa' },
  dracula: { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff' },
  'solarized-dark': { background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selectionBackground: '#073642',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' },
};
let preferences = { ...DEFAULT_TERMINAL_PREFERENCES };
const listeners = new Set<() => void>();

export function terminalFontFamily(font: string): string {
  return `"${font}", "JetBrains Mono", monospace`;
}
export function terminalTheme(theme: TerminalPreferences['theme']): ITheme { return { ...themes[theme] }; }
export function getTerminalPreferences(): TerminalPreferences { return { ...preferences }; }
export function onTerminalAppearanceChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function applyTerminalPreferences(value: TerminalPreferences = { ...DEFAULT_TERMINAL_PREFERENCES }): void {
  const next = normalizeTerminalPreferences(value);
  const changed = JSON.stringify(next) !== JSON.stringify(preferences);
  preferences = next;
  document.documentElement.style.setProperty('--terminal-background', themes[next.theme].background!);
  document.documentElement.style.setProperty('--terminal-status-color', next.theme === 'light' ? '#92400e' : '#fcd34d');
  if (changed) for (const listener of listeners) listener();
  // Font loading can finish after an existing terminal was measured. Refit in
  // place without reconnecting or moving focus when the local fallback arrives.
  void document.fonts?.load(`${next.fontSize}px ${terminalFontFamily(next.fontFamily)}`).then(() => {
    if (preferences === next) for (const listener of listeners) listener();
  }).catch(() => undefined);
}
