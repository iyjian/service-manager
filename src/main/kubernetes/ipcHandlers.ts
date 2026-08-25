import { ipcMain } from 'electron';
import type { KubernetesLogScope, KubernetesVncLaunchResult } from '../../shared/types';
import { IPC_CHANNELS } from '../core/ipcChannels';
import type { KubernetesRuntime } from './kubernetesRuntime';
import { validateKubernetesTerminalInput } from './terminalInput';
import {
  validateKubernetesNamespaceScope,
  validateKubernetesPodTarget,
  validateKubernetesPortForward,
  validateKubernetesQuery,
  validateKubernetesRelatedResourceRequest,
  validateKubernetesText,
  validateKubernetesVncTarget,
  validateKubernetesWindowRange,
} from './ipcValidation';

export interface KubernetesIpcHandlersOptions {
  getRuntime(): KubernetesRuntime;
  openExternal(url: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function registerKubernetesIpcHandlers(options: KubernetesIpcHandlersOptions): void {
  const getKubernetesRuntime = options.getRuntime;

  ipcMain.handle(IPC_CHANNELS.kubernetesGetState, async () => getKubernetesRuntime().getState());
  ipcMain.handle(IPC_CHANNELS.kubernetesSelectContext, async (_event, name: unknown) =>
    getKubernetesRuntime().selectContext(validateKubernetesText(name, 'Context name'))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesReconnect, async () => getKubernetesRuntime().reconnect());
  ipcMain.handle(IPC_CHANNELS.kubernetesReloadKubeconfig, async () => getKubernetesRuntime().reloadKubeconfig());
  ipcMain.handle(IPC_CHANNELS.kubernetesSetNamespaceScope, async (_event, scope: unknown) =>
    getKubernetesRuntime().setNamespaceScope(validateKubernetesNamespaceScope(scope))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesListNamespaces, async () =>
    getKubernetesRuntime().listNamespaces()
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesListResources, async (_event, query: unknown) =>
    getKubernetesRuntime().listResources(validateKubernetesQuery(query))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesGetResourceWindow, async (_event, payload: unknown) => {
    if (!isRecord(payload)) throw new Error('Kubernetes resource window request is invalid.');
    return getKubernetesRuntime().getResourceWindow(
      validateKubernetesQuery(payload.query),
      validateKubernetesWindowRange(payload.range)
    );
  });
  ipcMain.handle(IPC_CHANNELS.kubernetesLoadMoreResources, async (_event, query: unknown) =>
    getKubernetesRuntime().loadMoreResources(validateKubernetesQuery(query))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesListCustomResourceDefinitions, async () =>
    getKubernetesRuntime().listCustomResourceDefinitions()
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesGetResourceDetail,
    async (_event, payload: unknown) => {
      if (!isRecord(payload)) throw new Error('Kubernetes resource detail request is invalid.');
      return getKubernetesRuntime().getResourceDetail(
        validateKubernetesQuery(payload.query),
        validateKubernetesText(payload.name, 'resource name'),
        payload.namespace === undefined ? undefined : validateKubernetesText(payload.namespace, 'Namespace')
      );
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesGetResourceEvents,
    async (_event, payload: unknown) => {
      if (!isRecord(payload)) throw new Error('Kubernetes Events request is invalid.');
      return getKubernetesRuntime().getResourceEvents(
        validateKubernetesText(payload.uid, 'resource UID'),
        payload.namespace === undefined ? undefined : validateKubernetesText(payload.namespace, 'Namespace')
      );
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesGetRelatedResources,
    async (_event, request: unknown) => getKubernetesRuntime().getRelatedResources(
      validateKubernetesRelatedResourceRequest(request)
    )
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesGetPodEnvironment, async (_event, input: unknown) =>
    getKubernetesRuntime().getPodContainerEnvironment(validateKubernetesPodTarget(input))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesOpenLogs, async (_event, input: unknown) =>
    getKubernetesRuntime().openLogs(validateKubernetesPodTarget(input))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesLoadOlderLogs, async (_event, id: unknown) =>
    getKubernetesRuntime().loadOlderLogs(validateKubernetesText(id, 'log session ID'))
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesSetLogScope,
    async (_event, payload: unknown) => {
      if (!isRecord(payload) || (payload.scope !== 'pod' && payload.scope !== 'deployment')) {
        throw new Error('Kubernetes log scope request is invalid.');
      }
      return getKubernetesRuntime().setLogScope(
        validateKubernetesText(payload.id, 'log session ID'),
        payload.scope as KubernetesLogScope
      );
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesSetLogFollowing,
    async (_event, payload: unknown) => {
      if (!isRecord(payload) || typeof payload.following !== 'boolean') throw new Error('Kubernetes log following request is invalid.');
      return getKubernetesRuntime().setLogFollowing(validateKubernetesText(payload.id, 'log session ID'), payload.following);
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesSetLogStartTime,
    async (_event, payload: unknown) => {
      if (!isRecord(payload) || (payload.startTime !== undefined && typeof payload.startTime !== 'string')) {
        throw new Error('Kubernetes log start time request is invalid.');
      }
      return getKubernetesRuntime().setLogStartTime(
        validateKubernetesText(payload.id, 'log session ID'),
        payload.startTime === undefined
          ? undefined
          : validateKubernetesText(payload.startTime, 'log start time', 64)
      );
    }
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesClearLogs, async (_event, id: unknown) =>
    getKubernetesRuntime().clearLogs(validateKubernetesText(id, 'log session ID'))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesCloseLogs, async (_event, id: unknown) =>
    getKubernetesRuntime().closeLogs(validateKubernetesText(id, 'log session ID'))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesOpenTerminal, async (_event, input: unknown) =>
    getKubernetesRuntime().openTerminal(validateKubernetesPodTarget(input))
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesWriteTerminal,
    async (_event, payload: unknown) => {
      if (!isRecord(payload)) throw new Error('Kubernetes terminal input is invalid.');
      return getKubernetesRuntime().writeTerminal(
        validateKubernetesText(payload.id, 'terminal ID'),
        validateKubernetesTerminalInput(payload.data)
      );
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesResizeTerminal,
    async (_event, payload: unknown) => {
      if (!isRecord(payload) || typeof payload.cols !== 'number' || !Number.isInteger(payload.cols) || payload.cols < 1
        || typeof payload.rows !== 'number' || !Number.isInteger(payload.rows) || payload.rows < 1) {
        throw new Error('Kubernetes terminal dimensions are invalid.');
      }
      return getKubernetesRuntime().resizeTerminal(
        validateKubernetesText(payload.id, 'terminal ID'),
        payload.cols,
        payload.rows
      );
    }
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesCloseTerminal, async (_event, id: unknown) =>
    getKubernetesRuntime().closeTerminal(validateKubernetesText(id, 'terminal ID'))
  );
  ipcMain.handle(
    IPC_CHANNELS.kubernetesOpenVnc,
    async (_event, input: unknown): Promise<KubernetesVncLaunchResult> => {
      const handle = await getKubernetesRuntime().openVnc(validateKubernetesVncTarget(input));
      const viewerPassword = handle.takeViewerPassword();
      const authority = viewerPassword
        ? `vnc:${encodeURIComponent(viewerPassword)}@127.0.0.1`
        : '127.0.0.1';
      try {
        await options.openExternal(`vnc://${authority}:${handle.localPort}`);
      } catch {
        await handle.close().catch(() => undefined);
        throw new Error('Unable to open the system VNC client. Install or configure a VNC client that handles vnc:// links.');
      }
      return {
        namespace: handle.namespace,
        podName: handle.podName,
        vmiName: handle.vmiName,
        localPort: handle.localPort,
      };
    }
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesStartPortForward, async (_event, input: unknown) =>
    getKubernetesRuntime().startPortForward(validateKubernetesPortForward(input))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesStopPortForward, async (_event, id: unknown) =>
    getKubernetesRuntime().stopPortForward(validateKubernetesText(id, 'port forward ID'))
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesStopAllPortForwards, async () =>
    getKubernetesRuntime().stopAllPortForwards()
  );
  ipcMain.handle(IPC_CHANNELS.kubernetesListPortForwards, async () => getKubernetesRuntime().listPortForwards());
  ipcMain.handle(IPC_CHANNELS.kubernetesDeactivatePage, async () => getKubernetesRuntime().deactivatePage());
}
