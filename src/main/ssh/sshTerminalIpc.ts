import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../core/ipcChannels';
import { SshTerminalRuntime, validateSshId } from './sshTerminalRuntime';

export function registerSshTerminalIpc(runtime: SshTerminalRuntime, isOwner: (event: IpcMainInvokeEvent) => boolean): void {
  const bind = (channel: string, handler: (owner: number, input: Record<string, unknown>) => unknown): void => {
    ipcMain.handle(channel, (event, input: unknown) => {
      if (!isOwner(event) || event.senderFrame !== event.sender.mainFrame) throw new Error('SSH terminal window is unavailable.');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid SSH terminal request.');
      return handler(event.sender.id, input as Record<string, unknown>);
    });
  };
  bind(IPC_CHANNELS.sshTerminalOpen, (owner, input) => runtime.open(owner, validateSshId(input.hostId), validateSshId(input.id)));
  bind(IPC_CHANNELS.sshTerminalWrite, (owner, input) => runtime.write(owner, validateSshId(input.id), input.data));
  bind(IPC_CHANNELS.sshTerminalResize, (owner, input) => runtime.resize(owner, validateSshId(input.id), input.cols as number, input.rows as number));
  bind(IPC_CHANNELS.sshTerminalClose, (owner, input) => runtime.close(owner, validateSshId(input.id)));
  bind(IPC_CHANNELS.sshTerminalAcknowledge, (owner, input) => runtime.acknowledge(owner, validateSshId(input.id), input.characters));
}
