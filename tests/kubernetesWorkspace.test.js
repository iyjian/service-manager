const assert = require('node:assert/strict');
const test = require('node:test');

test('same target and type reuses one tab while different types and Pods stay distinct', async () => {
  const { kubernetesWorkspaceTabKey, createKubernetesWorkspaceState } = await import('../dist/renderer/kubernetesWorkspace.js');
  const target = { namespace: 'apps', podName: 'api', container: 'web' };
  const state = createKubernetesWorkspaceState();
  const first = state.open('logs', target);
  const reused = state.open('logs', target);

  assert.equal(first.created, true);
  assert.equal(reused.created, false);
  assert.equal(reused.tab.id, first.tab.id);
  assert.equal(kubernetesWorkspaceTabKey('logs', target), 'logs\u0000apps\u0000api\u0000web');
  assert.notEqual(kubernetesWorkspaceTabKey('logs', target), kubernetesWorkspaceTabKey('shell', target));
  assert.notEqual(kubernetesWorkspaceTabKey('logs', target), kubernetesWorkspaceTabKey('logs', { ...target, podName: 'api-2' }));
  assert.notEqual(kubernetesWorkspaceTabKey('logs', target), kubernetesWorkspaceTabKey('logs', { ...target, container: 'worker' }));
});

test('workspace rejects stale log revisions and old terminal final events after close and reopen', async () => {
  const { createKubernetesWorkspaceState } = await import('../dist/renderer/kubernetesWorkspace.js');
  const target = { namespace: 'apps', podName: 'api', container: 'web' };
  const state = createKubernetesWorkspaceState();
  const first = state.open('shell', target).tab;
  assert.equal(state.bindTerminal(first.id, 'terminal-old'), true);
  assert.equal(state.close(first.id), true);
  const second = state.open('shell', target).tab;
  assert.notEqual(second.id, first.id);
  assert.equal(state.bindTerminal(second.id, 'terminal-new'), true);
  assert.equal(state.routeTerminalFinal({ id: 'terminal-old', state: 'closed' }), false);
  assert.deepEqual(state.tabs().map((tab) => tab.id), [second.id]);

  const logTab = state.open('logs', target).tab;
  assert.equal(state.bindLog(logTab.id, {
    sessionId: 'log-1', ...target, lines: ['new'], following: false, hasOlder: false, revision: 8,
  }), true);
  assert.equal(state.applyLog({
    sessionId: 'log-1', ...target, lines: ['old'], following: true, hasOlder: false, revision: 7,
  }), false);
  assert.equal(state.logForSession('log-1')?.following, false);
  assert.deepEqual(state.logForSession('log-1')?.lines, ['new']);
  assert.equal(state.applyLog({
    sessionId: 'log-1', ...target, lines: ['new'], following: false, hasOlder: false, revision: 8,
  }), true);
  assert.equal(state.applyLog({
    sessionId: 'unknown', ...target, lines: ['ignored'], following: true, hasOlder: false, revision: 99,
  }), false);
});
