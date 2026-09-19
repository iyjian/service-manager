import type { ServiceApi, SshTerminalState, LocalTerminalState } from '../../shared/types';
import { createIcon } from './icon.js';
import { createTerminalPane } from './terminalPane.js';
import { createWorkspaceResize } from './workspaceResize.js';

interface SshTab {
  id: string;
  kind: 'ssh' | 'local';
  hostId: string;
  hostName: string;
  sequence: number;
  state: SshTerminalState | LocalTerminalState;
}

type SshApi = Pick<ServiceApi, 'openSshTerminal' | 'writeSshTerminal' | 'resizeSshTerminal'
  | 'closeSshTerminal' | 'onSshTerminalChanged' | 'onSshTerminalOutput' | 'acknowledgeSshTerminalOutput'
  | 'openLocalTerminal' | 'writeLocalTerminal' | 'resizeLocalTerminal' | 'closeLocalTerminal'
  | 'onLocalTerminalChanged' | 'onLocalTerminalOutput' | 'acknowledgeLocalTerminalOutput'>;

export function createSshWorkspace(options: {
  root: HTMLElement;
  resizeHandle: HTMLElement;
  tabList: HTMLElement;
  pane: HTMLElement;
  api: SshApi;
  reportError(error: unknown): void;
}) {
  const tabs = new Map<string, SshTab>();
  const sequences = new Map<string, number>();
  let selectedId: string | undefined;
  let visible = false;
  let disposed = false;
  let focusOnOpen: string | undefined;

  const terminal = createTerminalPane({
    retainFinalViews: true,
    onInput: (id, data) => (tabs.get(id)?.kind === 'local'
      ? options.api.writeLocalTerminal(id, data) : options.api.writeSshTerminal(id, data)).catch(options.reportError),
    onResize: (id, cols, rows) => tabs.get(id)?.kind === 'local'
      ? options.api.resizeLocalTerminal(id, cols, rows) : options.api.resizeSshTerminal(id, cols, rows),
    onOutputConsumed: (id, characters) => {
      if (!tabs.has(id)) return;
      void (tabs.get(id)?.kind === 'local' ? options.api.acknowledgeLocalTerminalOutput(id, characters)
        : options.api.acknowledgeSshTerminalOutput(id, characters)).catch(() => undefined);
    },
  });
  const resize = createWorkspaceResize({ ...options, onResize: () => terminal.resizeActive() });
  const status = document.createElement('div');
  status.className = 'ssh-terminal-status';
  status.setAttribute('role', 'status');
  const terminalHost = document.createElement('div');
  terminalHost.className = 'kubernetes-shell-pane-host ssh-terminal-pane-host';
  options.pane.append(status, terminalHost);

  const title = (tab: SshTab): string => `${tab.hostName} #${tab.sequence}`;
  const closeRemote = (tab: SshTab): void => {
    void (tab.kind === 'local' ? options.api.closeLocalTerminal(tab.id) : options.api.closeSshTerminal(tab.id)).catch(options.reportError);
  };
  const render = (): void => {
    options.root.classList.toggle('hidden', tabs.size === 0);
    const tabButtons: HTMLElement[] = [];
    for (const tab of tabs.values()) {
      const item = document.createElement('div');
      item.className = 'kubernetes-workspace-tab kubernetes-workspace-tab-shell';
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'kubernetes-workspace-tab-select ssh-workspace-tab-select';
      select.id = `ssh-tab-${tab.id}`;
      select.setAttribute('role', 'tab');
      select.setAttribute('aria-selected', String(tab.id === selectedId));
      select.setAttribute('aria-controls', options.pane.id);
      select.setAttribute('aria-label', `${title(tab)} ${tab.kind === 'ssh' ? 'SSH' : 'local shell'} ${tab.state.state}`);
      select.title = title(tab);
      select.tabIndex = tab.id === selectedId ? 0 : -1;
      const caption = document.createElement('span');
      caption.className = 'ssh-workspace-tab-caption';
      const hostLabel = document.createElement('span');
      hostLabel.className = 'ssh-workspace-tab-name';
      hostLabel.textContent = tab.hostName;
      const sequenceLabel = document.createElement('span');
      sequenceLabel.className = 'ssh-workspace-tab-sequence';
      sequenceLabel.textContent = ` #${tab.sequence}`;
      caption.append(hostLabel, sequenceLabel);
      select.append(caption);
      select.addEventListener('click', () => selectTab(tab.id));
      select.addEventListener('keydown', (event) => {
        const ids = [...tabs.keys()];
        const index = ids.indexOf(tab.id);
        let next: string | undefined;
        if (event.key === 'ArrowRight') next = ids[(index + 1) % ids.length];
        if (event.key === 'ArrowLeft') next = ids[(index + ids.length - 1) % ids.length];
        if (event.key === 'Home') next = ids[0];
        if (event.key === 'End') next = ids[ids.length - 1];
        if (event.key === 'Delete') { event.preventDefault(); close(tab.id); return; }
        if (!next) return;
        event.preventDefault();
        selectTab(next, false);
        document.getElementById(`ssh-tab-${next}`)?.focus();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn kubernetes-workspace-tab-close';
      remove.setAttribute('aria-label', `Close ${title(tab)}`);
      remove.title = `Close ${title(tab)}`;
      remove.append(createIcon('x'));
      remove.addEventListener('click', () => close(tab.id));
      item.append(select, remove);
      tabButtons.push(item);
    }
    options.tabList.replaceChildren(...tabButtons);
    const selected = selectedId ? tabs.get(selectedId) : undefined;
    if (!selected || !visible) {
      terminal.detach();
      if (!tabs.size) resize.finish();
      return;
    }
    options.pane.setAttribute('aria-labelledby', `ssh-tab-${selected.id}`);
    status.textContent = selected.state.state === 'connecting' ? 'Connecting…'
      : selected.state.state === 'open' ? '' : selected.state.error ?? 'Terminal session ended.';
    status.classList.toggle('hidden', selected.state.state === 'open');
    terminal.mount(selected.state, terminalHost);
    resize.sync();
    window.requestAnimationFrame(() => {
      if (!disposed && visible && selectedId === selected.id) terminal.resizeActive();
    });
  };

  const selectTab = (id: string, focus = true): void => {
    if (!tabs.has(id)) return;
    selectedId = id;
    focusOnOpen = focus ? id : undefined;
    render();
    if (visible && focus) terminal.focus();
    document.getElementById(`ssh-tab-${id}`)?.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const close = (id: string, notifyRemote = true): void => {
    const tab = tabs.get(id);
    if (!tab) return;
    const ids = [...tabs.keys()];
    const index = ids.indexOf(id);
    if (!tabs.delete(id)) return;
    const wasSelected = selectedId === id;
    terminal.remove(id);
    if (notifyRemote) closeRemote(tab);
    if (wasSelected) {
      selectedId = ids[index + 1] ?? ids[index - 1];
      focusOnOpen = selectedId;
    }
    render();
    if (visible && (notifyRemote || wasSelected)) terminal.focus();
  };

  const onState = (state: SshTerminalState | LocalTerminalState): void => {
    const tab = tabs.get(state.id);
    if (!tab || ('hostId' in state ? tab.kind !== 'ssh' || tab.hostId !== state.hostId : tab.kind !== 'local')
      || tab.state.state === 'closed' || tab.state.state === 'error') return;
    if (state.state === 'closed' && state.closeReason === 'shell-exit') {
      close(state.id, false);
      return;
    }
    tab.state = state;
    terminal.prepare(state);
    render();
    if (visible && selectedId === state.id && focusOnOpen === state.id && state.state === 'open') {
      focusOnOpen = undefined;
      terminal.focus();
    }
  };
  const unsubscribeState = options.api.onSshTerminalChanged(onState);
  const unsubscribeLocalState = options.api.onLocalTerminalChanged(onState);
  const unsubscribeLocalOutput = options.api.onLocalTerminalOutput((output) => {
    if (tabs.get(output.id)?.kind === 'local') terminal.write(output);
  });
  const unsubscribeOutput = options.api.onSshTerminalOutput((output) => {
    if (tabs.get(output.id)?.kind === 'ssh') terminal.write(output);
  });

  const openTab = async (host?: { id: string; name: string }): Promise<void> => {
      if (disposed) return;
      const key = host ? `ssh:${host.id}` : 'local';
      const sequence = (sequences.get(key) ?? 0) + 1;
      sequences.set(key, sequence);
      const id = crypto.randomUUID();
      const tab: SshTab = {
        id, kind: host ? 'ssh' : 'local', hostId: host?.id ?? '', hostName: host?.name ?? 'Local Terminal', sequence,
        state: host ? { id, hostId: host.id, state: 'connecting' } : { id, shell: 'Local', state: 'connecting' },
      };
      tabs.set(id, tab);
      // Bind the exact local ID before invoking IPC so even the first prompt has an owner.
      terminal.prepare(tab.state);
      if (!options.root.style.height) resize.applyHeight(resize.pageHeight() * 0.5);
      selectTab(id);
      try {
        const state = await (host ? options.api.openSshTerminal(host.id, id) : options.api.openLocalTerminal(id));
        if (!tabs.has(id) || disposed) { closeRemote(tab); return; }
        // An event can already have advanced the connecting snapshot returned by IPC.
        if (tab.state.state === 'connecting') onState(state);
      } catch (error) {
        onState({ ...tab.state, state: 'error', error: error instanceof Error ? error.message : 'Terminal session failed.' });
      }
  };

  return {
    open: (host: { id: string; name: string }): Promise<void> => openTab(host),
    openLocal: (): Promise<void> => openTab(),
    setVisible(next: boolean): void {
      visible = next;
      if (visible && tabs.size) resize.applyHeight(Number.parseFloat(options.root.style.height) || resize.pageHeight() * 0.5);
      if (!visible) resize.finish();
      render();
    },
    updateHosts(hosts: Array<{ id: string; name: string }>): void {
      const names = new Map(hosts.map((host) => [host.id, host.name]));
      for (const tab of tabs.values()) if (tab.kind === 'ssh') tab.hostName = names.get(tab.hostId) ?? tab.hostName;
      render();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribeState();
      unsubscribeOutput();
      unsubscribeLocalState();
      unsubscribeLocalOutput();
      for (const tab of tabs.values()) closeRemote(tab);
      tabs.clear();
      terminal.dispose();
      resize.dispose();
    },
  };
}
