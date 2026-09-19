import type { FitAddon as XtermFitAddon } from '@xterm/addon-fit';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import { getTerminalPreferences, onTerminalAppearanceChanged, terminalFontFamily, terminalTheme } from './terminalAppearance.js';
import type {
  TerminalOutput,
  TerminalState,
} from '../../shared/types';

type XtermConstructor = new (options?: ConstructorParameters<typeof XtermTerminal>[0]) => XtermTerminal;
type FitAddonConstructor = new () => XtermFitAddon;

interface XtermGlobals {
  Terminal?: XtermConstructor;
  FitAddon?: { FitAddon?: FitAddonConstructor };
}

interface TerminalPaneView {
  state: TerminalState;
  host: HTMLElement;
  terminal?: XtermTerminal;
  fit?: XtermFitAddon;
  resize: () => void;
}

export interface TerminalPane {
  prepare(state: TerminalState): boolean;
  mount(state: TerminalState, host: HTMLElement): boolean;
  /** Detaches the active DOM host without disposing any retained xterm view. */
  detach(): void;
  /** Refits the active xterm without changing focus or scrolling the page. */
  resizeActive(): boolean;
  focus(): boolean;
  write(output: TerminalOutput): boolean;
  finalize(state: Pick<TerminalState, 'id' | 'state'>): boolean;
  /** Tombstones and disposes one exact local xterm view. */
  remove(id: string): boolean;
  /** Releases every retained local xterm view; remote sessions stay workspace-owned. */
  dispose(): void;
}

function xtermGlobals(): XtermGlobals {
  return window as unknown as XtermGlobals;
}

function terminalRuntime(): { Terminal: XtermConstructor; FitAddon: FitAddonConstructor } | undefined {
  const globals = xtermGlobals();
  const Terminal = globals.Terminal;
  const FitAddon = globals.FitAddon?.FitAddon;
  return Terminal && FitAddon ? { Terminal, FitAddon } : undefined;
}

function isTerminalFinal(state: Pick<TerminalState, 'state'>): boolean {
  return state.state === 'closed' || state.state === 'error';
}

/**
 * Renderer-memory xterm views keyed by their exact remote terminal ID. The
 * workspace owns remote session cleanup; this pane only attaches/detaches and
 * disposes local views as their owning workspace tabs change lifecycle.
 */
export function createTerminalPane(options: {
  onInput: (id: string, data: string) => Promise<void>;
  onResize: (id: string, cols: number, rows: number) => Promise<void>;
  retainFinalViews?: boolean;
  onOutputConsumed?: (id: string, characters: number) => void;
}): TerminalPane {
  const finalizedIds = new Set<string>();
  const views = new Map<string, TerminalPaneView>();
  let activeId: string | undefined;
  let focusGeneration = 0;
  let paneDisposed = false;
  const unsubscribeAppearance = onTerminalAppearanceChanged(() => {
    const preferences = getTerminalPreferences();
    for (const view of views.values()) {
      if (!view.terminal) continue;
      view.terminal.options.fontFamily = terminalFontFamily(preferences.fontFamily);
      view.terminal.options.fontSize = preferences.fontSize;
      view.terminal.options.theme = terminalTheme(preferences.theme);
      view.host.style.backgroundColor = terminalTheme(preferences.theme).background!;
      view.resize();
    }
  });

  const detachActive = (): void => {
    focusGeneration += 1;
    const current = activeId ? views.get(activeId) : undefined;
    activeId = undefined;
    if (!current) return;
    window.removeEventListener('resize', current.resize);
    current.host.remove();
  };

  const destroy = (id: string): boolean => {
    const current = views.get(id);
    if (!current) return false;
    if (activeId === id) detachActive();
    else {
      window.removeEventListener('resize', current.resize);
      current.host.remove();
    }
    current.terminal?.dispose();
    views.delete(id);
    return true;
  };

  const finalize = (state: Pick<TerminalState, 'id' | 'state'>): boolean => {
    if (!isTerminalFinal(state)) return false;
    if (options.retainFinalViews) {
      const current = views.get(state.id);
      if (!current) return false;
      current.state = { ...current.state, ...state };
      if (current.terminal) current.terminal.options.disableStdin = true;
      return true;
    }
    // Final broadcasts can race ahead of an open result or first mount.
    // Tombstone first so no delayed state/output can revive that ID.
    finalizedIds.add(state.id);
    return destroy(state.id);
  };

  const ensure = (state: TerminalState): TerminalPaneView | undefined => {
    const existing = views.get(state.id);
    if (existing) {
      existing.state = state;
      if (options.retainFinalViews && existing.terminal) existing.terminal.options.disableStdin = state.state !== 'open';
      return existing;
    }

    const terminalHost = document.createElement('div');
    terminalHost.className = 'kubernetes-terminal-host';
    const next: TerminalPaneView = {
      state,
      host: terminalHost,
      resize: () => undefined,
    };
    views.set(state.id, next);
    const runtime = terminalRuntime();
    if (!runtime) {
      const unavailable = document.createElement('p');
      unavailable.className = 'kubernetes-terminal-unavailable';
      unavailable.textContent = 'Terminal renderer is unavailable.';
      terminalHost.appendChild(unavailable);
      return next;
    }

    const preferences = getTerminalPreferences();
    const terminal = new runtime.Terminal({
      cursorBlink: true,
      ...(options.retainFinalViews ? { scrollback: 2000, disableStdin: state.state !== 'open' } : {}),
      convertEol: true,
      fontFamily: terminalFontFamily(preferences.fontFamily),
      fontSize: preferences.fontSize,
      theme: terminalTheme(preferences.theme),
    });
    terminalHost.style.backgroundColor = terminalTheme(preferences.theme).background!;
    const fit = new runtime.FitAddon();
    terminal.loadAddon(fit);
    // FitAddon measures its immediate parent's size, including any padding.
    // Give it an unpadded surface inside the host's visible spacing so the
    // final terminal row and rightmost columns cannot extend into that space.
    const terminalSurface = document.createElement('div');
    terminalSurface.className = 'kubernetes-terminal-surface';
    terminalHost.appendChild(terminalSurface);
    terminal.open(terminalSurface);
    const resize = (): void => {
      if ((!options.retainFinalViews && next.state.state !== 'open')
        || activeId !== next.state.id
        || views.get(next.state.id) !== next
        || finalizedIds.has(next.state.id)) return;
      fit.fit();
      if (next.state.state === 'open' && terminal.cols > 0 && terminal.rows > 0) {
        void options.onResize(next.state.id, terminal.cols, terminal.rows).catch(() => undefined);
      }
    };
    terminal.onData((data) => {
      if (next.state.state !== 'open'
        || activeId !== next.state.id
        || views.get(next.state.id) !== next
        || finalizedIds.has(next.state.id)) return;
      void options.onInput(next.state.id, data).catch(() => undefined);
    });
    next.terminal = terminal;
    next.fit = fit;
    next.resize = resize;
    return next;
  };

  const prepare = (state: TerminalState): boolean => {
    if (isTerminalFinal(state) && !options.retainFinalViews) return finalize(state);
    if (paneDisposed || finalizedIds.has(state.id)) return false;
    return Boolean(ensure(state));
  };

  return {
    prepare,

    mount(state, host) {
      if (!prepare(state)) return false;
      const current = views.get(state.id);
      if (!current) return false;
      const alreadyMounted = activeId === state.id && current.host.parentElement === host;
      if (alreadyMounted) return true;
      if (activeId === state.id) {
        window.removeEventListener('resize', current.resize);
        current.host.remove();
        activeId = undefined;
      } else {
        detachActive();
      }
      host.appendChild(current.host);
      activeId = state.id;
      window.addEventListener('resize', current.resize);
      return true;
    },

    detach() {
      detachActive();
    },

    resizeActive() {
      const id = activeId;
      const current = id ? views.get(id) : undefined;
      if (!id || !current || (!options.retainFinalViews && current.state.state !== 'open') || finalizedIds.has(id)) return false;
      current.resize();
      return true;
    },

    focus() {
      const id = activeId;
      const current = id ? views.get(id) : undefined;
      if (!id || !current || (!options.retainFinalViews && current.state.state !== 'open') || finalizedIds.has(id)) return false;
      const generation = ++focusGeneration;
      window.requestAnimationFrame(() => {
        if (generation !== focusGeneration
          || (!options.retainFinalViews && current.state.state !== 'open')
          || activeId !== id
          || views.get(id) !== current
          || finalizedIds.has(id)) return;
        current.resize();
        current.host.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        current.terminal?.focus();
      });
      return true;
    },

    write(output) {
      const current = views.get(output.id);
      if (!current || current.state.id !== output.id || finalizedIds.has(output.id)) return false;
      if (isTerminalFinal(current.state)) return false;
      if (output.data) {
        if (options.onOutputConsumed) {
          if (current.terminal) current.terminal.write(output.data, () => options.onOutputConsumed?.(output.id, output.data.length));
          else options.onOutputConsumed(output.id, output.data.length);
        } else current.terminal?.write(output.data);
      }
      return true;
    },

    finalize(state) {
      return finalize(state);
    },

    remove(id) {
      finalizedIds.add(id);
      return destroy(id);
    },

    dispose() {
      if (paneDisposed) return;
      paneDisposed = true;
      unsubscribeAppearance();
      focusGeneration += 1;
      for (const id of [...views.keys()]) {
        finalizedIds.add(id);
        destroy(id);
      }
    },
  };
}
