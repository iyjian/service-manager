import type { Terminal } from '@xterm/xterm';
import { findTerminalMatches, type TerminalFindMatch } from '../models/terminalFind.js';
import { moveNotesFindIndex } from '../models/notesFind.js';
import { createIcon } from './icon.js';

export function bindTerminalSearch(host: HTMLElement, terminal: Terminal): { dispose(): void; focus(): void } {
  const screen = host.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) return { dispose() {}, focus: () => terminal.focus() };
  const launcher = document.createElement('button');
  launcher.type = 'button'; launcher.className = 'terminal-find-launcher notes-find-button';
  launcher.title = 'Find in terminal (⌘F / Ctrl+F)'; launcher.setAttribute('aria-label', 'Find in terminal');
  launcher.append(createIcon('search'));
  const bar = document.createElement('div');
  bar.className = 'notes-find-bar terminal-find-bar hidden';
  bar.setAttribute('role', 'search'); bar.setAttribute('aria-label', 'Find in terminal');
  const wrap = document.createElement('label'); wrap.className = 'notes-find-input-wrap';
  wrap.append(createIcon('search'));
  const input = document.createElement('input');
  input.type = 'search'; input.className = 'notes-find-input'; input.placeholder = 'Find in terminal';
  input.setAttribute('aria-label', 'Find in terminal'); input.spellcheck = false; input.autocomplete = 'off';
  wrap.append(input); bar.append(wrap);
  const counter = document.createElement('span'); counter.className = 'notes-find-counter';
  counter.setAttribute('aria-live', 'polite'); bar.append(counter);
  const button = (label: string, icon: 'chevron-left' | 'chevron-right' | 'x', action: () => void): HTMLButtonElement => {
    const element = document.createElement('button'); element.type = 'button'; element.className = 'notes-find-button';
    element.title = label; element.setAttribute('aria-label', label); element.append(createIcon(icon));
    element.addEventListener('click', action); bar.append(element); return element;
  };
  const previous = button('Previous match (Shift+Enter)', 'chevron-left', () => move(-1));
  const next = button('Next match (Enter)', 'chevron-right', () => move(1));
  button('Close search (Esc)', 'x', () => close());
  const overlay = document.createElement('div'); overlay.className = 'terminal-find-highlights';
  overlay.setAttribute('aria-hidden', 'true'); screen.append(overlay); host.append(launcher, bar);
  let opened = false;
  let matches: TerminalFindMatch[] = [];
  let index = -1;
  let truncated = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const paint = (): void => {
    overlay.replaceChildren();
    if (!opened) return;
    const viewport = terminal.buffer.active.viewportY;
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      for (let row = Math.max(match.start.row, viewport); row <= Math.min(match.end.row, viewport + terminal.rows - 1); row++) {
        const from = row === match.start.row ? match.start.col : 0;
        const to = row === match.end.row ? match.end.col + match.end.width : terminal.cols;
        const mark = document.createElement('span');
        mark.className = i === index ? 'terminal-find-highlight active' : 'terminal-find-highlight';
        mark.style.left = `${from / terminal.cols * 100}%`;
        mark.style.width = `${(to - from) / terminal.cols * 100}%`;
        mark.style.top = `${(row - viewport) / terminal.rows * 100}%`;
        mark.style.height = `${100 / terminal.rows}%`;
        fragment.append(mark);
      }
    }
    overlay.append(fragment);
  };
  const update = (): void => {
    counter.textContent = `${index + 1} / ${matches.length}${truncated ? '+' : ''}`;
    bar.dataset.noResults = String(Boolean(input.value) && matches.length === 0);
    previous.disabled = next.disabled = matches.length === 0;
    paint();
  };
  const reveal = (): void => {
    const match = matches[index];
    if (match) terminal.scrollToLine(Math.max(0, match.start.row - Math.floor(terminal.rows / 2)));
    update();
  };
  const refresh = (navigate = false): void => {
    clearTimeout(timer); timer = undefined;
    if (!opened || disposed) return;
    const anchor = matches[index]?.start;
    ({ matches, truncated } = findTerminalMatches(terminal.buffer.active, input.value));
    index = matches.length ? 0 : -1;
    if (!navigate && anchor) {
      const retained = matches.findIndex((match) => match.start.row === anchor.row && match.start.col === anchor.col);
      if (retained >= 0) index = retained;
    }
    if (navigate) reveal(); else update();
  };
  const schedule = (): void => {
    if (opened && timer === undefined) timer = setTimeout(() => refresh(), 100);
  };
  const move = (direction: 1 | -1): void => {
    if (timer !== undefined) refresh();
    index = moveNotesFindIndex(index, matches.length, direction); reveal(); input.focus();
  };
  const open = (): void => {
    opened = true; launcher.classList.add('hidden'); bar.classList.remove('hidden');
    refresh(); input.focus(); input.select();
  };
  const close = (): void => {
    opened = false; clearTimeout(timer); timer = undefined;
    bar.classList.add('hidden'); launcher.classList.remove('hidden'); overlay.replaceChildren();
    terminal.focus();
  };
  const keydown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229) return;
    const mac = /mac/i.test(navigator.platform);
    if ((mac ? event.metaKey : event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault(); event.stopImmediatePropagation(); open();
    } else if (opened && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); close();
    } else if (opened && event.target === input && event.key === 'Enter') {
      event.preventDefault(); event.stopImmediatePropagation(); move(event.shiftKey ? -1 : 1);
    }
  };
  launcher.addEventListener('click', open);
  input.addEventListener('input', (event) => { if (!(event as InputEvent).isComposing) refresh(true); });
  input.addEventListener('compositionend', () => refresh(true));
  host.addEventListener('keydown', keydown, true);
  const listeners = [terminal.onWriteParsed(schedule), terminal.onResize(schedule), terminal.onScroll(paint),
    terminal.onRender(paint), terminal.buffer.onBufferChange(() => refresh())];
  update();
  return {
    focus: () => opened ? input.focus() : terminal.focus(),
    dispose() {
      disposed = true; clearTimeout(timer);
      host.removeEventListener('keydown', keydown, true);
      for (const listener of listeners) listener.dispose();
      launcher.remove(); bar.remove(); overlay.remove();
    },
  };
}
