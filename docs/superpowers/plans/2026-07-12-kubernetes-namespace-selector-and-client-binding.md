# Kubernetes Namespace Selector And Client Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore real read-only Kubernetes resource calls and provide a compact cluster-backed Namespace multi-select beside Context.

**Architecture:** Preserve the generic Kubernetes Object API dispatcher but invoke generated methods with their owning API object. Add a dedicated paged, no-Watch Namespace-name read through runtime and IPC, then simplify the renderer toolbar to a Context select plus a checkbox Namespace menu whose first shortcut is All Namespaces.

**Tech Stack:** Electron 33, TypeScript 5.7, `@kubernetes/client-node` 1.4.0, Tailwind CSS 3.4, Node built-in `node:test`, Electron DevTools/CDP.

## Global Constraints

- All Kubernetes operations remain strictly read-only.
- Use `@kubernetes/client-node`; do not shell out to `kubectl`.
- Do not install or upgrade dependencies.
- Keep kubeconfig credentials, transports, and raw API objects in the main process.
- Namespace names are renderer-safe but remain ephemeral and are never persisted or logged.
- Context and Namespace must share one toolbar row.
- Remove manual Add Namespace and Namespace tag controls.
- All Namespaces is the first Namespace shortcut; concrete entries support multiple selection.
- Use DOM nodes and `textContent` for Kubernetes-derived names.
- Update both `README.md` and `AGENTS.md`.
- Verify the authorized `开发环境外网(admin)` Context through DevTools/CDP without screenshots or Kubernetes mutations.

---

### Task 1: Preserve generated Object API method receivers

**Files:**
- Modify: `src/main/kubernetes/kubernetesClient.ts`
- Modify: `tests/clusterSession.test.js`

**Interfaces:**
- Keeps `KubernetesClientAdapter.call(api, method, params): Promise<unknown>`.
- Changes dispatch semantics from bare invocation to `operation.call(api, params)`.

- [ ] **Step 1: Add a failing real-adapter regression test**

Construct a client through `createKubernetesClient` whose fake Core API method reads `this.marker`, then request an all-Namespace Service list:

```js
const core = {
  marker: 'bound',
  async listServiceForAllNamespaces(params) {
    assert.equal(this.marker, 'bound');
    calls.push(params);
    return { items: [], metadata: { resourceVersion: '7' } };
  },
};
const page = await client.list({
  context: 'token',
  kind: 'services',
  scope: 'namespaced',
  namespaceScope: { mode: 'all', namespaces: [] },
});
assert.equal(page.resourceVersion, '7');
```

- [ ] **Step 2: Verify RED**

Run: cached pnpm 9.1.2 build, then `node --test --test-name-pattern='preserves generated Object API receivers' tests/clusterSession.test.js`.

Expected: FAIL because `this` is undefined inside the fake Object API method.

- [ ] **Step 3: Implement the single receiver fix**

```ts
private async call(api: ReadOnlyApi, method: string, params: Record<string, unknown>): Promise<unknown> {
  const operation = api[method];
  if (!operation) throw new Error(`Kubernetes client does not provide ${method}.`);
  return operation.call(api, params);
}
```

- [ ] **Step 4: Verify GREEN**

Run the receiver test plus existing Kubernetes client tests.

Expected: PASS with no `this.api` failure.

- [ ] **Step 5: Commit**

```bash
git add src/main/kubernetes/kubernetesClient.ts tests/clusterSession.test.js
git commit -m "fix: preserve Kubernetes API method receivers"
```

### Task 2: Add paged read-only Namespace discovery

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/kubernetes/kubernetesRuntime.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`
- Modify: `tests/kubernetesRuntime.test.js`
- Modify: `tests/rendererModules.test.js`

**Interfaces:**
- Adds `KubernetesApi.listNamespaces(): Promise<string[]>`.
- Adds IPC channel `kubernetes:list-namespaces`.
- Adds `KubernetesRuntime.listNamespaces(): Promise<string[]>`.

- [ ] **Step 1: Add failing runtime and bridge tests**

Runtime test pages two Namespace responses without ResourceCoordinator activation:

```js
assert.deepEqual(await runtime.listNamespaces(), ['apps', 'default', 'monitoring']);
assert.deepEqual(client.listCalls.map((call) => call.continueToken), [undefined, 'next']);
assert.equal(calls.some((call) => call.startsWith('activate:')), false);
```

Bridge test asserts compiled preload exposes only `ipcRenderer.invoke('kubernetes:list-namespaces')` and the main handler delegates to `runtime.listNamespaces()`.

- [ ] **Step 2: Verify RED**

Run: build, then `node --test tests/kubernetesRuntime.test.js tests/rendererModules.test.js`.

Expected: FAIL because `listNamespaces` and its IPC channel do not exist.

- [ ] **Step 3: Implement runtime paging**

Use the selected Context ID and the existing client:

```ts
public async listNamespaces(): Promise<string[]> {
  this.assertUsable();
  this.assertConnected();
  const context = this.session.getState().selectedContext;
  if (!context) throw new Error('No active Kubernetes Context is connected.');
  const names = new Set<string>();
  let continueToken: string | undefined;
  do {
    const page = await this.observedClient().list({
      context,
      kind: 'namespaces',
      scope: 'cluster',
      namespaceScope: { mode: 'all', namespaces: [] },
    }, continueToken);
    for (const item of page.items) if (item.name.trim()) names.add(item.name.trim());
    continueToken = page.continueToken;
  } while (continueToken);
  return [...names].sort();
}
```

Wrap failures with the existing `onOperationFailure` behavior so only transient transport failures trigger Context recovery.

- [ ] **Step 4: Wire typed IPC and preload**

Add the shared method, channel constant, handler, and preload invocation. No raw Namespace objects cross IPC.

- [ ] **Step 5: Verify GREEN**

Run runtime and renderer bridge tests.

Expected: all pass; no coordinator activation or Watch occurs.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/kubernetes/kubernetesRuntime.ts src/main/main.ts src/main/preload.ts tests/kubernetesRuntime.test.js tests/rendererModules.test.js
git commit -m "feat: list Kubernetes Namespaces read-only"
```

### Task 3: Replace manual Namespace entry with compact multi-select

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/kubernetesPage.ts`
- Modify: `src/renderer/tailwind.css`
- Modify: `tests/kubernetesRenderer.test.js`
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes `window.kubernetesApi.listNamespaces()`.
- Keeps `setNamespaceScope(scope)` and `KubernetesNamespaceScope` unchanged.
- Renderer owns `availableNamespaces: string[]`, a request generation, and the selected-name set only while the page is active.

- [ ] **Step 1: Add failing renderer and documentation tests**

Assert compiled/static output has one toolbar row, no `kubernetes-namespace-add`, no Namespace tags, `listNamespaces()`, All Namespaces first, checkbox concrete options, and stale Context guards.

```js
assert.doesNotMatch(html, /kubernetes-namespace-add|kubernetes-namespace-tags/);
assert.match(page, /window\.kubernetesApi\.listNamespaces\(\)/);
assert.match(page, /All Namespaces/);
assert.match(page, /input\.type = 'checkbox'/);
```

- [ ] **Step 2: Verify RED**

Run: build, then `node --test tests/kubernetesRenderer.test.js`.

Expected: FAIL because manual Add and tag controls still exist and Namespace discovery is absent.

- [ ] **Step 3: Simplify markup and styles**

Keep Context and Namespace as the only two controls inside `.kubernetes-toolbar`. Remove the add row and tags. Make both controls compact flex children and anchor the menu directly below the Namespace button.

- [ ] **Step 4: Implement ephemeral discovery and multi-selection**

Load names after a connected Context becomes active. Guard every result with page generation and selected Context. Render All Namespaces first, then every available Namespace as a text-safe checkbox. Concrete changes send sorted selected names; an empty set sends All Namespaces.

- [ ] **Step 5: Update documentation**

Document cluster-backed paged Namespace names, multi-selection, All Namespaces, no manual entry, and receiver-safe client-node dispatch in both README and AGENTS.

- [ ] **Step 6: Verify GREEN**

Run renderer, runtime, and API bridge tests.

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/index.html src/renderer/kubernetesPage.ts src/renderer/tailwind.css tests/kubernetesRenderer.test.js README.md AGENTS.md
git commit -m "feat: add Kubernetes Namespace multi-select"
```

### Task 4: DevTools/CDP and full verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Build and launch an isolated Electron DevTools instance**

Use remote debugging and a temporary user-data directory. Do not use screenshots.

- [ ] **Step 2: Operate the authorized Context read-only**

Through CDP, open Kubernetes, select `开发环境外网(admin)`, wait for connected state, inspect Namespace menu text, select one and multiple concrete Namespaces, then select All Namespaces.

- [ ] **Step 3: Verify real resource lists**

Use existing UI category/resource buttons to load Pods and Services. Confirm rows or legitimate empty/no-permission states and confirm there is no `this.api` error in page or main-process output.

- [ ] **Step 4: Audit for forbidden writes**

Inspect the exercised calls and source diff for create, patch, delete, Apply, Scale, Restart, or lifecycle mutations. Only LIST/Watch operations may occur.

- [ ] **Step 5: Run full verification**

Run: pinned pnpm 9.1.2 `pnpm test` outside the socket-restricted sandbox.

Expected: build succeeds and every test passes.

- [ ] **Step 6: Inspect final repository state**

Run: `git diff --check`, `git status --short`, and recent `git log`. Preserve the pre-existing untracked `.pnpm-store/`.
