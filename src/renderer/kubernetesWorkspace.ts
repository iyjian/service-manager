import type {
  KubernetesLogState,
  KubernetesPodTarget,
  KubernetesTerminalState,
} from '../shared/types';

export type KubernetesWorkspaceTabType = 'logs' | 'shell';

export interface KubernetesWorkspaceTab {
  id: string;
  key: string;
  type: KubernetesWorkspaceTabType;
  target: KubernetesPodTarget;
  log?: KubernetesLogState;
  terminalId?: string;
  logSearch: string;
  closed: boolean;
}

export interface KubernetesWorkspaceState {
  open(type: KubernetesWorkspaceTabType, target: KubernetesPodTarget): { tab: KubernetesWorkspaceTab; created: boolean };
  close(tabId: string): boolean;
  bindLog(tabId: string, log: KubernetesLogState): boolean;
  bindTerminal(tabId: string, terminalId: string): boolean;
  routeTerminalFinal(state: Pick<KubernetesTerminalState, 'id' | 'state'>): boolean;
  applyLog(state: KubernetesLogState): boolean;
  logForSession(sessionId: string): KubernetesLogState | undefined;
  tabs(): KubernetesWorkspaceTab[];
}

export function kubernetesWorkspaceTabKey(type: KubernetesWorkspaceTabType, target: KubernetesPodTarget): string {
  return [type, target.namespace, target.podName, target.container].join('\u0000');
}

function copyTarget(target: KubernetesPodTarget): KubernetesPodTarget {
  return { ...target };
}

function copyLog(log: KubernetesLogState): KubernetesLogState {
  return { ...log, lines: [...log.lines] };
}

function copyTab(tab: KubernetesWorkspaceTab): KubernetesWorkspaceTab {
  return {
    ...tab,
    target: copyTarget(tab.target),
    ...(tab.log ? { log: copyLog(tab.log) } : {}),
  };
}

function sameTarget(left: KubernetesPodTarget, right: KubernetesPodTarget): boolean {
  return left.namespace === right.namespace
    && left.podName === right.podName
    && left.container === right.container;
}

/**
 * Owns only the pure, target/session mapping rules. UI selection and remote
 * lifecycle work intentionally remain outside this model.
 */
export function createKubernetesWorkspaceState(): KubernetesWorkspaceState {
  const tabsById = new Map<string, KubernetesWorkspaceTab>();
  const tabIdByKey = new Map<string, string>();
  const tabIdByLogSession = new Map<string, string>();
  const tabIdByTerminal = new Map<string, string>();
  let nextTabId = 0;

  const current = (tabId: string): KubernetesWorkspaceTab | undefined => {
    const tab = tabsById.get(tabId);
    return tab && !tab.closed ? tab : undefined;
  };

  const releaseLog = (tab: KubernetesWorkspaceTab): void => {
    if (tab.log && tabIdByLogSession.get(tab.log.sessionId) === tab.id) {
      tabIdByLogSession.delete(tab.log.sessionId);
    }
  };

  const releaseTerminal = (tab: KubernetesWorkspaceTab): void => {
    if (tab.terminalId && tabIdByTerminal.get(tab.terminalId) === tab.id) {
      tabIdByTerminal.delete(tab.terminalId);
    }
  };

  return {
    open(type, target) {
      const key = kubernetesWorkspaceTabKey(type, target);
      const existingId = tabIdByKey.get(key);
      const existing = existingId ? current(existingId) : undefined;
      if (existing) return { tab: copyTab(existing), created: false };
      if (existingId) tabIdByKey.delete(key);

      const tab: KubernetesWorkspaceTab = {
        id: `kubernetes-workspace-tab-${++nextTabId}`,
        key,
        type,
        target: copyTarget(target),
        logSearch: '',
        closed: false,
      };
      tabsById.set(tab.id, tab);
      tabIdByKey.set(key, tab.id);
      return { tab: copyTab(tab), created: true };
    },

    close(tabId) {
      const tab = current(tabId);
      if (!tab) return false;
      tab.closed = true;
      tabsById.delete(tab.id);
      if (tabIdByKey.get(tab.key) === tab.id) tabIdByKey.delete(tab.key);
      releaseLog(tab);
      releaseTerminal(tab);
      return true;
    },

    bindLog(tabId, log) {
      const tab = current(tabId);
      if (!tab || tab.type !== 'logs' || !sameTarget(tab.target, log)) return false;
      const ownerId = tabIdByLogSession.get(log.sessionId);
      if (ownerId && ownerId !== tab.id) return false;
      if (tab.log?.sessionId === log.sessionId && log.revision < tab.log.revision) return false;
      releaseLog(tab);
      tab.log = copyLog(log);
      tabIdByLogSession.set(log.sessionId, tab.id);
      return true;
    },

    bindTerminal(tabId, terminalId) {
      const tab = current(tabId);
      if (!tab || tab.type !== 'shell') return false;
      const ownerId = tabIdByTerminal.get(terminalId);
      if (ownerId && ownerId !== tab.id) return false;
      releaseTerminal(tab);
      tab.terminalId = terminalId;
      tabIdByTerminal.set(terminalId, tab.id);
      return true;
    },

    routeTerminalFinal(state) {
      if (state.state !== 'closed' && state.state !== 'error') return false;
      const tabId = tabIdByTerminal.get(state.id);
      const tab = tabId ? current(tabId) : undefined;
      return Boolean(tab && tab.type === 'shell' && tab.terminalId === state.id);
    },

    applyLog(state) {
      const tabId = tabIdByLogSession.get(state.sessionId);
      const tab = tabId ? current(tabId) : undefined;
      if (!tab || tab.type !== 'logs' || !tab.log || tab.log.sessionId !== state.sessionId) return false;
      if (!sameTarget(tab.target, state) || state.revision < tab.log.revision) return false;
      tab.log = copyLog(state);
      return true;
    },

    logForSession(sessionId) {
      const tabId = tabIdByLogSession.get(sessionId);
      const tab = tabId ? current(tabId) : undefined;
      return tab?.log?.sessionId === sessionId ? copyLog(tab.log) : undefined;
    },

    tabs() {
      return [...tabsById.values()].filter((tab) => !tab.closed).map(copyTab);
    },
  };
}
