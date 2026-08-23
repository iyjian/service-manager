export type ToastLevel = 'default' | 'success' | 'error';

export type ToastAction = 'open-note-export';

/**
 * Emits a transient page-level message. The single sink in `renderer.ts`
 * listens for `service-manager:toast` and drives the shared `#page-message`
 * element, so pages only need to dispatch the event.
 */
export function toast(
  text: string,
  level: ToastLevel = 'default',
  action?: ToastAction,
): void {
  window.dispatchEvent(new CustomEvent('service-manager:toast', { detail: { text, level, action } }));
}
