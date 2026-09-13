export type NotesQuitStatus = 'not-configured' | 'synced' | 'pending' | 'syncing'
  | 'offline' | 'remote-updated' | 'diverged' | 'unverified';

export interface NotesQuitState {
  status: NotesQuitStatus;
  pending: boolean;
}

export function quitConfirmationOptions(state: NotesQuitState, failed = false) {
  const descriptions: Record<NotesQuitStatus, string> = {
    'not-configured': 'Your local data will be kept.',
    synced: 'Cloud Notes: Up to date at the last verification. No local Notes changes are waiting to upload.',
    pending: 'Cloud Notes: Local changes are waiting to upload.',
    syncing: 'Cloud Notes: Synchronization is in progress.',
    offline: 'Cloud Notes: Remote storage is unavailable. Its latest state cannot be verified.',
    'remote-updated': 'Cloud Notes: A remote update is waiting for manual synchronization.',
    diverged: 'Cloud Notes: Local and remote changes have diverged. Synchronization is blocked; both copies are preserved.',
    unverified: 'Cloud Notes: The synchronization state has not been verified.',
  };
  const canSync = (state.pending || state.status === 'syncing')
    && state.status !== 'diverged' && state.status !== 'remote-updated' && state.status !== 'not-configured';
  const actions: Array<'sync' | 'quit' | 'cancel'> = canSync ? ['sync', 'quit', 'cancel'] : ['quit', 'cancel'];
  return {
    actions,
    dialog: {
      type: state.status === 'synced' || state.status === 'not-configured' ? 'question' as const : 'warning' as const,
      title: 'Quit Service Manager', message: 'Quit Service Manager?',
      detail: (failed ? 'The last sync attempt failed.\n\n' : '')
        + (state.status === 'not-configured' ? '' : 'Local Notes: Saved.\n') + descriptions[state.status],
      buttons: actions.map((action) => action === 'sync' ? (failed ? 'Retry sync and quit' : 'Sync and quit')
        : action === 'quit' ? (state.pending ? 'Quit with local changes' : 'Quit') : 'Cancel'),
      defaultId: actions.indexOf('cancel'), cancelId: actions.indexOf('cancel'), noLink: true,
    },
  };
}

/** Both synced and local-only sessions must confirm; a successful explicit sync-and-quit grants consent. */
export async function confirmApplicationQuit(options: {
  state(): Promise<NotesQuitState>;
  choose(dialog: ReturnType<typeof quitConfirmationOptions>['dialog']): Promise<number>;
  sync(): Promise<void>;
}): Promise<boolean> {
  let failed = false;
  for (;;) {
    const state = await options.state();
    const view = quitConfirmationOptions(state, failed);
    const action = view.actions[await options.choose(view.dialog)];
    if (action === 'quit') return true;
    if (action !== 'sync') return false;
    try {
      await options.sync();
      const after = await options.state();
      if (!after.pending && after.status === 'synced') return true;
      failed = false;
    } catch { failed = true; }
  }
}
