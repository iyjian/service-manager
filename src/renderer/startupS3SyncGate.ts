import type { S3SyncProgressPhase, StartupS3SyncState } from '../shared/types';

const STARTUP_PHASE_LABELS: Readonly<Record<S3SyncProgressPhase, string>> = {
  checking: 'Checking S3 for updates…',
  'reading-local': 'Reading local data…',
  'reading-cloud': 'Reading cloud data…',
  merging: 'Merging synchronized data…',
  uploading: 'Uploading synchronized data…',
  applying: 'Applying synchronized data…',
  finishing: 'Finishing synchronization…',
};

let gatePromise: Promise<void> | undefined;
let resolveGate: (() => void) | undefined;
let removeStateListener: (() => void) | undefined;
let mainReady = false;
let pendingRendererWork = 0;
let released = false;

export function startupS3SyncDetail(state: StartupS3SyncState): string {
  if (state.status === 'checking') {
    return 'Checking S3 synchronization status…';
  }
  const syncState = state.syncState;
  const phase = syncState.phase;
  const base = phase ? STARTUP_PHASE_LABELS[phase] : 'Synchronizing application data…';
  if (
    Number.isSafeInteger(syncState.completedItems)
    && Number.isSafeInteger(syncState.totalItems)
    && (syncState.totalItems as number) > 0
  ) {
    const total = syncState.totalItems as number;
    const completed = Math.min(total, Math.max(0, syncState.completedItems as number));
    return `${base} ${completed} of ${total}`;
  }
  return base;
}

function maybeReleaseGate(): void {
  if (released || !mainReady || pendingRendererWork > 0) {
    return;
  }
  released = true;
  removeStateListener?.();
  removeStateListener = undefined;
  const overlay = document.querySelector<HTMLElement>('#app-startup-sync');
  const appLayout = document.querySelector<HTMLElement>('#app-layout');
  overlay?.classList.add('hidden');
  overlay?.setAttribute('aria-busy', 'false');
  if (appLayout) {
    appLayout.inert = false;
    appLayout.removeAttribute('aria-hidden');
  }
  document.body.removeAttribute('data-startup-sync');
  resolveGate?.();
  resolveGate = undefined;
}

function renderStartupState(state: StartupS3SyncState): void {
  if (released) return;
  const detail = document.querySelector<HTMLElement>('#app-startup-sync-detail');
  if (detail) detail.textContent = startupS3SyncDetail(state);
  if (state.status === 'ready') {
    mainReady = true;
    maybeReleaseGate();
  }
}

export function waitForStartupS3Sync(): Promise<void> {
  if (gatePromise) return gatePromise;
  gatePromise = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });

  const appLayout = document.querySelector<HTMLElement>('#app-layout');
  if (appLayout) {
    appLayout.inert = true;
    appLayout.setAttribute('aria-hidden', 'true');
  }
  document.body.dataset.startupSync = 'true';

  removeStateListener = window.settingsApi.onStartupS3SyncStateChanged(renderStartupState);
  void window.settingsApi.getStartupS3SyncState().then(renderStartupState).catch((error) => {
    console.error('[renderer:startup-s3-sync]', error);
    mainReady = true;
    maybeReleaseGate();
  });
  return gatePromise;
}

export function trackStartupS3SyncWork<T>(work: Promise<T>): Promise<T> {
  if (released) return work;
  pendingRendererWork += 1;
  void work.then(
    () => {
      pendingRendererWork = Math.max(0, pendingRendererWork - 1);
      maybeReleaseGate();
    },
    () => {
      pendingRendererWork = Math.max(0, pendingRendererWork - 1);
      maybeReleaseGate();
    },
  );
  return work;
}
