const test = require('node:test');
const assert = require('node:assert/strict');
const { quitConfirmationOptions, confirmApplicationQuit } = require('../dist/main/core/quitConfirmation');

for (const status of ['not-configured', 'synced', 'pending', 'syncing', 'offline', 'remote-updated', 'diverged', 'unverified']) {
  test(`quit confirmation describes ${status} and defaults to Cancel`, () => {
    const { dialog, actions } = quitConfirmationOptions({ status, pending: status !== 'synced' && status !== 'not-configured' });
    assert.equal(dialog.message, 'Quit Service Manager?');
    assert.equal(actions[dialog.defaultId], 'cancel');
    assert.equal(actions[dialog.cancelId], 'cancel');
    if (status === 'not-configured') assert.doesNotMatch(dialog.detail, /Cloud Notes/);
    else assert.match(dialog.detail, /Local Notes: Saved\.[\s\S]*Cloud Notes:/);
    if (status === 'diverged' || status === 'remote-updated') assert.ok(!actions.includes('sync'));
  });
}

test('already synced and unconfigured sessions still ask before quitting', async () => {
  for (const status of ['synced', 'not-configured']) {
    let shown = 0;
    const result = await confirmApplicationQuit({
      state: async () => ({ status, pending: false }),
      choose: async (dialog) => { shown++; return dialog.cancelId; },
      sync: async () => assert.fail('must not sync'),
    });
    assert.equal(result, false);
    assert.equal(shown, 1);
  }
});

test('explicit quit confirms without a transfer and sync-and-quit waits for completion', async () => {
  let state = { status: 'pending', pending: true };
  let synced = 0;
  const options = { state: async () => state, choose: async () => 1,
    sync: async () => { synced++; state = { status: 'synced', pending: false }; } };
  assert.equal(await confirmApplicationQuit(options), true);
  assert.equal(synced, 0);
  assert.equal(await confirmApplicationQuit({ ...options, choose: async () => 0 }), true);
  assert.equal(synced, 1);
});

test('failed sync stays in the confirmation flow and can be cancelled', async () => {
  let shown = 0;
  assert.equal(await confirmApplicationQuit({
    state: async () => ({ status: 'offline', pending: true }),
    choose: async (dialog) => {
      if (shown++ === 0) return 0;
      assert.match(dialog.detail, /last sync attempt failed/);
      return dialog.cancelId;
    },
    sync: async () => { throw new Error('offline'); },
  }), false);
  assert.equal(shown, 2);
});
