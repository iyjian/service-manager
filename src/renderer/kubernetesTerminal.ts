import type { FitAddon as XtermFitAddon } from '@xterm/addon-fit';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import type {
  KubernetesTerminalOutput,
  KubernetesTerminalState,
} from '../shared/types';

type XtermConstructor = new (options?: ConstructorParameters<typeof XtermTerminal>[0]) => XtermTerminal;
type FitAddonConstructor = new () => XtermFitAddon;

interface XtermGlobals {
  Terminal?: XtermConstructor;
  FitAddon?: { FitAddon?: FitAddonConstructor };
}

interface TerminalPaneView {
  state: KubernetesTerminalState;
  host: HTMLElement;
  terminal?: XtermTerminal;
  fit?: XtermFitAddon;
  resize: () => void;
}

export interface KubernetesTerminalPane {
  prepare(state: KubernetesTerminalState): boolean;
  mount(state: KubernetesTerminalState, host: HTMLElement): boolean;
  /** Detaches the active DOM host without disposing any retained xterm view. */
  detach(): void;
  focus(): boolean;
  write(output: KubernetesTerminalOutput): boolean;
  finalize(state: Pick<KubernetesTerminalState, 'id' | 'state'>): boolean;
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

function isTerminalFinal(state: Pick<KubernetesTerminalState, 'state'>): boolean {
  return state.state === 'closed' || state.state === 'error';
}

/**
 * Renderer-memory xterm views keyed by their exact remote terminal ID. The
 * workspace owns remote session cleanup; this pane only attaches/detaches and
 * disposes local views as their owning workspace tabs change lifecycle.
 */
export function createKubernetesTerminalPane(options: {
  onInput: (id: string, data: string) => Promise<void>;
  onResize: (id: string, cols: number, rows: number) => Promise<void>;
}): KubernetesTerminalPane {
  const finalizedIds = new Set<string>();
  const views = new Map<string, TerminalPaneView>();
  let activeId: string | undefined;
  let focusGeneration = 0;
  let paneDisposed = false;

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

  const finalize = (state: Pick<KubernetesTerminalState, 'id' | 'state'>): boolean => {
    if (!isTerminalFinal(state)) return false;
    // Final broadcasts can race ahead of an open result or first mount.
    // Tombstone first so no delayed state/output can revive that ID.
    finalizedIds.add(state.id);
    return destroy(state.id);
  };

  const ensure = (state: KubernetesTerminalState): TerminalPaneView | undefined => {
    const existing = views.get(state.id);
    if (existing) {
      existing.state = state;
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

    const terminal = new runtime.Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      theme: { background: '#18181b', foreground: '#f4f4f5' },
    });
    const fit = new runtime.FitAddon();
    terminal.loadAddon(fit);
    terminal.open(terminalHost);
    const resize = (): void => {
      if (activeId !== next.state.id || views.get(next.state.id) !== next || finalizedIds.has(next.state.id)) return;
      fit.fit();
      if (terminal.cols > 0 && terminal.rows > 0) {
        void options.onResize(next.state.id, terminal.cols, terminal.rows).catch(() => undefined);
      }
    };
    terminal.onData((data) => {
      if (activeId !== next.state.id || views.get(next.state.id) !== next || finalizedIds.has(next.state.id)) return;
      void options.onInput(next.state.id, data).catch(() => undefined);
    });
    next.terminal = terminal;
    next.fit = fit;
    next.resize = resize;
    return next;
  };

  const prepare = (state: KubernetesTerminalState): boolean => {
    if (isTerminalFinal(state)) return finalize(state);
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

    focus() {
      const id = activeId;
      const current = id ? views.get(id) : undefined;
      if (!id || !current || finalizedIds.has(id)) return false;
      const generation = ++focusGeneration;
      window.requestAnimationFrame(() => {
        if (generation !== focusGeneration || activeId !== id || views.get(id) !== current || finalizedIds.has(id)) return;
        current.resize();
        current.host.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        current.terminal?.focus();
      });
      return true;
    },

    write(output) {
      const current = views.get(output.id);
      if (!current || current.state.id !== output.id || finalizedIds.has(output.id)) return false;
      if (output.data) current.terminal?.write(output.data);
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
      focusGeneration += 1;
      for (const id of [...views.keys()]) {
        finalizedIds.add(id);
        destroy(id);
      }
    },
  };
}
