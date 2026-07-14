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
  mount(state: KubernetesTerminalState, host: HTMLElement): boolean;
  focus(): boolean;
  write(output: KubernetesTerminalOutput): boolean;
  finalize(state: Pick<KubernetesTerminalState, 'id' | 'state'>): boolean;
  /** Releases only the local xterm view; remote session ownership stays with the workspace tab. */
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
 * A single mounted xterm view for the selected workspace Shell tab. It has no
 * remote close callback: switching tabs or disposing the workspace must never
 * accidentally terminate a still-owned background tab. The workspace closes
 * remote sessions explicitly after it has removed their local tab instance.
 */
export function createKubernetesTerminalPane(options: {
  onInput: (id: string, data: string) => Promise<void>;
  onResize: (id: string, cols: number, rows: number) => Promise<void>;
}): KubernetesTerminalPane {
  const finalizedIds = new Set<string>();
  let view: TerminalPaneView | undefined;
  let focusGeneration = 0;

  const release = (): void => {
    const current = view;
    if (!current) return;
    view = undefined;
    window.removeEventListener('resize', current.resize);
    current.terminal?.dispose();
    current.host.remove();
  };

  return {
    mount(state, host) {
      if (isTerminalFinal(state)) return this.finalize(state);
      if (finalizedIds.has(state.id)) return false;
      if (view?.state.id === state.id) {
        view.state = state;
        return true;
      }
      release();

      const terminalHost = document.createElement('div');
      terminalHost.className = 'kubernetes-terminal-host';
      host.appendChild(terminalHost);
      const next: TerminalPaneView = {
        state,
        host: terminalHost,
        resize: () => undefined,
      };
      view = next;
      const runtime = terminalRuntime();
      if (!runtime) {
        const unavailable = document.createElement('p');
        unavailable.className = 'kubernetes-terminal-unavailable';
        unavailable.textContent = 'Terminal renderer is unavailable.';
        terminalHost.appendChild(unavailable);
        return true;
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
        if (view !== next || finalizedIds.has(next.state.id)) return;
        fit.fit();
        if (terminal.cols > 0 && terminal.rows > 0) {
          void options.onResize(next.state.id, terminal.cols, terminal.rows).catch(() => undefined);
        }
      };
      terminal.onData((data) => {
        if (view !== next || finalizedIds.has(next.state.id)) return;
        void options.onInput(next.state.id, data).catch(() => undefined);
      });
      window.addEventListener('resize', resize);
      next.terminal = terminal;
      next.fit = fit;
      next.resize = resize;
      return true;
    },

    focus() {
      const current = view;
      if (!current) return false;
      const generation = ++focusGeneration;
      window.requestAnimationFrame(() => {
        if (generation !== focusGeneration || view !== current) return;
        current.resize();
        current.host.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        current.terminal?.focus();
      });
      return true;
    },

    write(output) {
      const current = view;
      if (!current || current.state.id !== output.id || finalizedIds.has(output.id)) return false;
      if (output.data) current.terminal?.write(output.data);
      return true;
    },

    finalize(state) {
      if (!isTerminalFinal(state)) return false;
      // Final broadcasts can race ahead of an open result or first mount.
      // Tombstone first so no delayed state/output can revive that ID.
      finalizedIds.add(state.id);
      if (view?.state.id !== state.id) return false;
      release();
      return true;
    },

    dispose() {
      focusGeneration += 1;
      release();
    },
  };
}
