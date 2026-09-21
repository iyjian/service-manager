import type { Terminal } from '@xterm/xterm';

/** macOS keeps xterm's native copy/paste events and the application's Edit menu. */
export function bindTerminalClipboard(
  host: HTMLElement,
  terminal: Pick<Terminal, 'getSelection' | 'clearSelection' | 'paste' | 'focus'>,
  clipboard: { readClipboardText(): Promise<string>; writeClipboardText(text: string): Promise<void> },
  isActive: () => boolean,
  canPaste: () => boolean,
  platform: string,
): () => void {
  if (!/^win/i.test(platform)) return () => undefined;
  let disposed = false;
  let pending = Promise.resolve();
  const active = (): boolean => !disposed && isActive();
  // Capture before xterm moves its textarea or reports mouse input to a TUI.
  const stopRightMouse = (event: MouseEvent): void => {
    if (event.button !== 2) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const contextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
    // Serialize quick consecutive clicks so paste waits for the preceding copy.
    pending = pending.then(async () => {
      if (!active()) return;
      const selected = terminal.getSelection();
      if (selected) {
        await clipboard.writeClipboardText(selected);
        if (active() && terminal.getSelection() === selected) terminal.clearSelection();
      } else if (canPaste()) {
        const text = await clipboard.readClipboardText();
        if (!active() || !canPaste()) return;
        terminal.focus();
        // Keep xterm's newline normalization and bracketed paste handling.
        terminal.paste(text);
      }
    }).catch(() => undefined);
  };
  for (const name of ['mousedown', 'mouseup', 'auxclick'] as const) host.addEventListener(name, stopRightMouse, { capture: true });
  host.addEventListener('contextmenu', contextMenu, { capture: true });
  return () => {
    disposed = true;
    for (const name of ['mousedown', 'mouseup', 'auxclick'] as const) host.removeEventListener(name, stopRightMouse, { capture: true });
    host.removeEventListener('contextmenu', contextMenu, { capture: true });
  };
}
