/**
 * Opens a modal dialog without throwing when it is already open. The native
 * `cancel` event closes the dialog on Escape, and `closeOnBackdropClick`
 * extends that with a click-outside-to-close affordance.
 */
export function openDialog(dialog: HTMLDialogElement): void {
  if (!dialog.open) dialog.showModal();
}

/** Closes `dialog` when its backdrop (not its content) is clicked. */
export function closeOnBackdropClick(dialog: HTMLDialogElement, close: () => void): void {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
}
