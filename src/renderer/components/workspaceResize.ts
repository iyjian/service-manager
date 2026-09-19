const WORKSPACE_MIN_HEIGHT = 120;
const WORKSPACE_MAX_HEIGHT_RATIO = 0.8;
const WORKSPACE_KEYBOARD_STEP = 20;

export function clampWorkspaceHeight(requestedHeight: number, pageHeight: number): number {
  const safePageHeight = Number.isFinite(pageHeight) ? Math.max(0, pageHeight) : 0;
  const maximum = Math.floor(safePageHeight * WORKSPACE_MAX_HEIGHT_RATIO);
  const minimum = Math.min(WORKSPACE_MIN_HEIGHT, maximum);
  const requested = Number.isFinite(requestedHeight) ? Math.round(requestedHeight) : minimum;
  return Math.min(maximum, Math.max(minimum, requested));
}

export function createWorkspaceResize(options: { root: HTMLElement; resizeHandle?: HTMLElement; onResize(): void }) {
  let disposed = false;
  let workspaceResizeFrame: number | undefined;
  let workspaceResizeDrag: { pointerId: number; startY: number; startHeight: number } | undefined;

  const workspacePageHeight = (): number => {
    const parentHeight = options.root.parentElement?.clientHeight ?? 0;
    return parentHeight > 0 ? parentHeight : window.innerHeight;
  };

  const workspaceHeightBounds = (): { minimum: number; maximum: number } => {
    const maximum = Math.floor(Math.max(0, workspacePageHeight()) * WORKSPACE_MAX_HEIGHT_RATIO);
    return { minimum: Math.min(WORKSPACE_MIN_HEIGHT, maximum), maximum };
  };

  const scheduleTerminalResize = (): void => {
    if (workspaceResizeFrame !== undefined) return;
    workspaceResizeFrame = window.requestAnimationFrame(() => {
      workspaceResizeFrame = undefined;
      options.onResize();
    });
  };

  const applyWorkspaceHeight = (requestedHeight: number, resizeTerminal = true): void => {
    const pageHeight = workspacePageHeight();
    const height = clampWorkspaceHeight(requestedHeight, pageHeight);
    const bounds = workspaceHeightBounds();
    options.root.style.maxHeight = `${bounds.maximum}px`;
    options.root.style.height = `${height}px`;
    options.resizeHandle?.setAttribute('aria-valuemin', String(bounds.minimum));
    options.resizeHandle?.setAttribute('aria-valuemax', String(bounds.maximum));
    options.resizeHandle?.setAttribute('aria-valuenow', String(height));
    if (resizeTerminal) scheduleTerminalResize();
  };

  const finishWorkspaceResize = (pointerId?: number, releaseCapture = true): void => {
    const drag = workspaceResizeDrag;
    if (!drag || (pointerId !== undefined && pointerId !== drag.pointerId)) return;
    workspaceResizeDrag = undefined;
    options.root.classList.remove('kubernetes-workspace-resizing');
    const handle = options.resizeHandle;
    if (releaseCapture && handle?.hasPointerCapture(drag.pointerId)) {
      try {
        handle.releasePointerCapture(drag.pointerId);
      } catch {
        // Pointer capture can already be gone after a native cancellation.
      }
    }
  };

  const onWorkspaceResizePointerDown = (event: PointerEvent): void => {
    if (disposed || event.button !== 0 || event.isPrimary === false) return;
    finishWorkspaceResize();
    const currentHeight = options.root.getBoundingClientRect().height;
    workspaceResizeDrag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: clampWorkspaceHeight(currentHeight, workspacePageHeight()),
    };
    options.root.classList.add('kubernetes-workspace-resizing');
    options.resizeHandle?.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onWorkspaceResizePointerMove = (event: PointerEvent): void => {
    const drag = workspaceResizeDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    applyWorkspaceHeight(drag.startHeight + drag.startY - event.clientY);
    event.preventDefault();
  };

  const onWorkspaceResizePointerEnd = (event: PointerEvent): void => {
    finishWorkspaceResize(event.pointerId);
  };

  const onWorkspaceResizeLostCapture = (event: PointerEvent): void => {
    finishWorkspaceResize(event.pointerId, false);
  };

  const onWorkspaceResizeKeyDown = (event: KeyboardEvent): void => {
    const currentHeight = options.root.getBoundingClientRect().height;
    const { minimum, maximum } = workspaceHeightBounds();
    let requested: number | undefined;
    if (event.key === 'ArrowUp') requested = currentHeight + WORKSPACE_KEYBOARD_STEP;
    if (event.key === 'ArrowDown') requested = currentHeight - WORKSPACE_KEYBOARD_STEP;
    if (event.key === 'Home') requested = minimum;
    if (event.key === 'End') requested = maximum;
    if (requested === undefined) return;
    applyWorkspaceHeight(requested);
    event.preventDefault();
  };

  const syncWorkspaceResizeAttributes = (): void => {
    const handle = options.resizeHandle;
    if (!handle) return;
    const { minimum, maximum } = workspaceHeightBounds();
    const currentHeight = clampWorkspaceHeight(options.root.getBoundingClientRect().height, workspacePageHeight());
    options.root.style.maxHeight = `${maximum}px`;
    handle.setAttribute('aria-valuemin', String(minimum));
    handle.setAttribute('aria-valuemax', String(maximum));
    handle.setAttribute('aria-valuenow', String(currentHeight));
  };

  const onWorkspaceWindowResize = (): void => {
    finishWorkspaceResize();
    const inlineHeight = Number.parseFloat(options.root.style.height);
    if (Number.isFinite(inlineHeight)) {
      // The active terminal pane owns the native window resize fit. Avoid a
      // second request-animation-frame fit/IPC from the workspace listener.
      applyWorkspaceHeight(inlineHeight, false);
      return;
    }
    syncWorkspaceResizeAttributes();
  };

  const bindWorkspaceResize = (): void => {
    const handle = options.resizeHandle;
    if (!handle) return;
    syncWorkspaceResizeAttributes();
    handle.addEventListener('pointerdown', onWorkspaceResizePointerDown);
    handle.addEventListener('pointermove', onWorkspaceResizePointerMove);
    handle.addEventListener('pointerup', onWorkspaceResizePointerEnd);
    handle.addEventListener('pointercancel', onWorkspaceResizePointerEnd);
    handle.addEventListener('lostpointercapture', onWorkspaceResizeLostCapture);
    handle.addEventListener('keydown', onWorkspaceResizeKeyDown);
    window.addEventListener('resize', onWorkspaceWindowResize);
  };

  const unbindWorkspaceResize = (): void => {
    const handle = options.resizeHandle;
    finishWorkspaceResize();
    if (!handle) return;
    handle.removeEventListener('pointerdown', onWorkspaceResizePointerDown);
    handle.removeEventListener('pointermove', onWorkspaceResizePointerMove);
    handle.removeEventListener('pointerup', onWorkspaceResizePointerEnd);
    handle.removeEventListener('pointercancel', onWorkspaceResizePointerEnd);
    handle.removeEventListener('lostpointercapture', onWorkspaceResizeLostCapture);
    handle.removeEventListener('keydown', onWorkspaceResizeKeyDown);
    window.removeEventListener('resize', onWorkspaceWindowResize);
  };

  bindWorkspaceResize();

  return {
    applyHeight: applyWorkspaceHeight,
    sync: syncWorkspaceResizeAttributes,
    finish: finishWorkspaceResize,
    pageHeight: workspacePageHeight,
    dispose() {
      disposed = true;
      unbindWorkspaceResize();
      if (workspaceResizeFrame !== undefined) window.cancelAnimationFrame(workspaceResizeFrame);
    },
  };

}
