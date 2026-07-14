import type { FitAddon as XtermFitAddon } from '@xterm/addon-fit';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import type {
  KubernetesPodTarget,
  KubernetesTerminalOutput,
  KubernetesTerminalState,
} from '../shared/types';

type XtermConstructor = new (options?: ConstructorParameters<typeof XtermTerminal>[0]) => XtermTerminal;
type FitAddonConstructor = new () => XtermFitAddon;

interface XtermGlobals {
  Terminal?: XtermConstructor;
  FitAddon?: { FitAddon?: FitAddonConstructor };
}

interface TerminalSessionView {
  state: KubernetesTerminalState;
  host: HTMLElement;
  terminal?: XtermTerminal;
  fit?: XtermFitAddon;
  resize: () => void;
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
  dispose(): void;
}

export interface KubernetesTerminalDrawer {
  open(state: KubernetesTerminalState, activate?: boolean): void;
  focusTarget(target: KubernetesPodTarget): string | undefined;
  focusSession(id: string): boolean;
  sessionIdForTarget(target: KubernetesPodTarget): string | undefined;
  hide(): void;
  write(id: string, data: string): void;
  close(id: string): void;
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

function sessionTitle(state: KubernetesTerminalState): string {
  return `${state.namespace}/${state.podName} · ${state.container}`;
}

function matchesTarget(state: KubernetesTerminalState, target: KubernetesPodTarget): boolean {
  return state.namespace === target.namespace
    && state.podName === target.podName
    && state.container === target.container;
}

function isTerminalFinal(state: Pick<KubernetesTerminalState, 'state'>): boolean {
  return state.state === 'closed' || state.state === 'error';
}

/**
 * A single terminal owner for one workspace Shell tab. The host belongs to
 * the caller, so this primitive never creates a floating/global drawer.
 * Terminal output and final events are accepted only for the owned ID.
 */
export function createKubernetesTerminalPane(options: {
  onInput: (id: string, data: string) => Promise<void>;
  onResize: (id: string, cols: number, rows: number) => Promise<void>;
  onClose: (id: string) => Promise<void>;
}): KubernetesTerminalPane {
  const finalizedIds = new Set<string>();
  let view: TerminalPaneView | undefined;
  let focusGeneration = 0;

  const release = (notify: boolean): void => {
    const current = view;
    if (!current) return;
    // Fence the ID before the callback. A callback can synchronously trigger
    // async renderer events, which must never revive this terminal instance.
    finalizedIds.add(current.state.id);
    view = undefined;
    window.removeEventListener('resize', current.resize);
    current.terminal?.dispose();
    current.host.remove();
    if (notify) void options.onClose(current.state.id).catch(() => undefined);
  };

  return {
    mount(state, host) {
      if (isTerminalFinal(state)) return this.finalize(state);
      if (finalizedIds.has(state.id)) return false;
      if (view?.state.id === state.id) {
        view.state = state;
        return true;
      }
      if (view) release(true);

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
      // A final event can arrive before the workspace has mounted its pane.
      // Keep that ID fenced so a later stale open/output cannot revive it.
      finalizedIds.add(state.id);
      if (view?.state.id !== state.id) return false;
      release(false);
      return true;
    },

    dispose() {
      focusGeneration += 1;
      release(true);
    },
  };
}

/**
 * The xterm renderer is intentionally owned by this small UI boundary. Raw
 * output is passed to xterm only through `terminal.write`, never HTML.
 */
export function createKubernetesTerminalDrawer(options: {
  root: HTMLElement;
  onInput: (id: string, data: string) => Promise<void>;
  onResize: (id: string, cols: number, rows: number) => Promise<void>;
  onClose: (id: string) => Promise<void>;
}): KubernetesTerminalDrawer {
  const sessions = new Map<string, TerminalSessionView>();
  const finalizedIds = new Set<string>();
  let focusGeneration = 0;

  const removeSession = (id: string, notify: boolean): void => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    window.removeEventListener('resize', session.resize);
    session.terminal?.dispose();
    session.host.remove();
    if (sessions.size === 0) options.root.classList.add('hidden');
    if (notify) void options.onClose(id).catch(() => undefined);
  };

  const closeSession = (id: string): void => {
    finalizedIds.add(id);
    removeSession(id, true);
  };

  const focusSession = (session: TerminalSessionView): void => {
    const generation = ++focusGeneration;
    const id = session.state.id;
    options.root.classList.remove('hidden');
    window.requestAnimationFrame(() => {
      if (generation !== focusGeneration || sessions.get(id) !== session) return;
      session.resize();
      session.host.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      session.terminal?.focus();
    });
  };

  const findTarget = (target: KubernetesPodTarget): TerminalSessionView | undefined => (
    [...sessions.values()].find((session) => matchesTarget(session.state, target))
  );

  const open = (state: KubernetesTerminalState, activate = true): void => {
    if (state.state === 'closed' || state.state === 'error') {
      finalizedIds.add(state.id);
      removeSession(state.id, false);
      return;
    }
    if (finalizedIds.has(state.id)) return;
    const existing = sessions.get(state.id);
    if (existing) {
      existing.state = state;
      if (activate) focusSession(existing);
      return;
    }

    const runtime = terminalRuntime();
    const session = document.createElement('section');
    session.className = 'kubernetes-terminal-session';
    const header = document.createElement('header');
    header.className = 'kubernetes-terminal-session-head';
    const title = document.createElement('span');
    title.textContent = sessionTitle(state);
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'icon-btn';
    closeButton.setAttribute('aria-label', `Close terminal ${sessionTitle(state)}`);
    closeButton.textContent = '×';
    header.append(title, closeButton);
    const host = document.createElement('div');
    host.className = 'kubernetes-terminal-host';
    session.append(header, host);
    options.root.appendChild(session);
    const view: TerminalSessionView = {
      state,
      host: session,
      resize: () => undefined,
    };
    sessions.set(state.id, view);
    closeButton.addEventListener('click', () => closeSession(state.id));

    if (!runtime) {
      const unavailable = document.createElement('p');
      unavailable.className = 'kubernetes-terminal-unavailable';
      unavailable.textContent = 'Terminal renderer is unavailable.';
      host.appendChild(unavailable);
      if (activate) focusSession(view);
      return;
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
    terminal.open(host);
    const resize = (): void => {
      fit.fit();
      if (terminal.cols > 0 && terminal.rows > 0) {
        void options.onResize(state.id, terminal.cols, terminal.rows).catch(() => undefined);
      }
    };
    terminal.onData((data) => {
      void options.onInput(state.id, data).catch(() => undefined);
    });
    window.addEventListener('resize', resize);
    view.terminal = terminal;
    view.fit = fit;
    view.resize = resize;
    if (activate) focusSession(view);
  };

  return {
    open,
    focusTarget(target: KubernetesPodTarget): string | undefined {
      const session = findTarget(target);
      if (!session) return undefined;
      focusSession(session);
      return session.state.id;
    },
    focusSession(id: string): boolean {
      const session = sessions.get(id);
      if (!session) return false;
      focusSession(session);
      return true;
    },
    sessionIdForTarget(target: KubernetesPodTarget): string | undefined {
      return findTarget(target)?.state.id;
    },
    hide(): void {
      focusGeneration += 1;
      options.root.classList.add('hidden');
    },
    write(id: string, data: string): void {
      const terminal = sessions.get(id)?.terminal;
      if (terminal && data) terminal.write(data);
    },
    close(id: string): void {
      closeSession(id);
    },
    dispose(): void {
      for (const id of [...sessions.keys()]) closeSession(id);
      options.root.replaceChildren();
      options.root.classList.add('hidden');
    },
  };
}
