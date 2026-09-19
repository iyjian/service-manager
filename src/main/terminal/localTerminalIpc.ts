import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../core/ipcChannels';
import { LocalTerminalRuntime, validateLocalTerminalId } from './localTerminalRuntime';

export function registerLocalTerminalIpc(runtime: LocalTerminalRuntime, isOwner: (event: IpcMainInvokeEvent) => boolean): void {
  const bind = (channel: string, handler: (owner: number, input: Record<string, unknown>) => unknown): void => {
    ipcMain.handle(channel, (event, input: unknown) => {
      if (!isOwner(event) || event.senderFrame !== event.sender.mainFrame) throw new Error('Local terminal window is unavailable.');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid local terminal request.');
      return handler(event.sender.id, input as Record<string, unknown>);
    });
  };
  bind(IPC_CHANNELS.localTerminalOpen, (owner, input) => runtime.open(owner, validateLocalTerminalId(input.id)));
  bind(IPC_CHANNELS.localTerminalWrite, (owner, input) => runtime.write(owner, validateLocalTerminalId(input.id), input.data));
  bind(IPC_CHANNELS.localTerminalResize, (owner, input) => runtime.resize(owner, validateLocalTerminalId(input.id), input.cols, input.rows));
  bind(IPC_CHANNELS.localTerminalClose, (owner, input) => runtime.close(owner, validateLocalTerminalId(input.id)));
  bind(IPC_CHANNELS.localTerminalAcknowledge, (owner, input) => runtime.acknowledge(owner, validateLocalTerminalId(input.id), input.characters));
}
