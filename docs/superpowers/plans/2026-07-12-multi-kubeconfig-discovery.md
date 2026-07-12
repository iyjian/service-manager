# Multi-Kubeconfig Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover every valid first-level kubeconfig file under the user's `.kube` directory and safely expose all of its Contexts in one selector on macOS, Linux, and Windows.

**Architecture:** Add a main-process kubeconfig catalog that independently parses direct regular files and owns the private mapping from stable Context selection IDs to source paths and original Context names. Kubernetes runtime/session state continues to use one string identity, while renderer labels and client construction resolve through the catalog without exposing credentials or absolute paths.

**Tech Stack:** Electron 33, TypeScript 5.7, Node filesystem/path APIs, `js-yaml`, `@kubernetes/client-node`, Node built-in `node:test`.

## Global Constraints

- Scan only direct regular files in `path.join(app.getPath('home'), '.kube')`; do not recurse or follow symbolic links.
- Do not use shell expansion, `KUBECONFIG`, `kubectl`, or another system command.
- Keep kubeconfig bytes, credentials, absolute paths, raw parse errors, and client transports in the main process.
- Keep token and complete certificate-pair authentication support; keep `exec` and `auth-provider` unsupported.
- Apply post-start filesystem changes only after the existing explicit Reload confirmation.
- Do not add or upgrade dependencies and do not run `pnpm install`.
- Update both `README.md` and `AGENTS.md` because runtime behavior and architecture change.
- Run `pnpm test` for final verification.

---

### Task 1: Build the kubeconfig discovery catalog

**Files:**
- Create: `src/main/kubernetes/kubeconfigCatalog.ts`
- Modify: `src/main/kubernetes/kubeconfigStore.ts`
- Modify: `src/shared/types.ts`
- Create: `tests/kubeconfigCatalog.test.js`

**Interfaces:**
- Produces `KubeconfigCatalog` with `contexts`, private `sources`, and a credential-sensitive main-process-only `fingerprint`.
- Produces `scanKubeconfigDirectory(directory: string): Promise<KubeconfigCatalog>`.
- Produces `catalogFromDocument(filePath: string, document: KubeconfigDocument): KubeconfigCatalog` for deterministic runtime tests.
- Produces `resolveKubeconfigContext(catalog, selectionId)` returning `{ kubeconfigPath, contextName }`.
- Extends `KubernetesContextInfo` with display-safe `contextName` and `displayName`, while its existing `name` remains the stable selection identity to minimize IPC/query churn.

- [ ] **Step 1: Write failing catalog discovery tests**

Cover two valid files, duplicate names, unique labels, deterministic order, malformed YAML, non-kubeconfig files, directories, symlinks, a disappearing file, a missing directory, and the absence of credentials/URLs/absolute paths from `contexts`.

```js
const catalog = await scanKubeconfigDirectory(kubeDirectory);
assert.deepEqual(catalog.contexts.map(({ contextName, displayName }) => ({ contextName, displayName })), [
  { contextName: 'development', displayName: 'development' },
  { contextName: 'shared', displayName: 'shared — east.config' },
  { contextName: 'shared', displayName: 'shared — west.config' },
]);
assert.notEqual(catalog.contexts[1].name, catalog.contexts[2].name);
assert.doesNotMatch(JSON.stringify(catalog.contexts), /token-|api\.example|\/private\//);
```

- [ ] **Step 2: Run the catalog test and verify RED**

Run: `pnpm run build && node --test tests/kubeconfigCatalog.test.js`

Expected: FAIL because `dist/main/kubernetes/kubeconfigCatalog` does not exist.

- [ ] **Step 3: Implement the minimal catalog**

Use platform-aware `path.join`/`path.basename`, `fs.readdir({ withFileTypes: true })`, `Dirent.isFile()`, independent guarded reads, `yaml.load`, structural validation, and SHA-256 hashing. Build IDs from an unambiguous encoding of direct filename and original Context name; never include the parent directory.

```ts
export interface KubeconfigContextSource {
  kubeconfigPath: string;
  contextName: string;
}

export interface KubeconfigCatalog {
  contexts: KubernetesContextInfo[];
  sources: ReadonlyMap<string, KubeconfigContextSource>;
  fingerprint: string;
}

export async function scanKubeconfigDirectory(directory: string): Promise<KubeconfigCatalog>;
export function catalogFromDocument(filePath: string, document: KubeconfigDocument): KubeconfigCatalog;
export function resolveKubeconfigContext(
  catalog: KubeconfigCatalog,
  selectionId: string
): KubeconfigContextSource | undefined;
```

Treat `ENOENT` on the directory as an empty catalog. Skip all individual-file failures. Re-throw other directory enumeration failures as `The local Kubernetes kubeconfig directory could not be read.`.

- [ ] **Step 4: Run catalog tests and existing classification tests**

Run: `pnpm run build && node --test tests/kubeconfigCatalog.test.js tests/kubeconfigStore.test.js`

Expected: PASS with zero failures.

- [ ] **Step 5: Commit the catalog**

```bash
git add src/main/kubernetes/kubeconfigCatalog.ts src/main/kubernetes/kubeconfigStore.ts src/shared/types.ts tests/kubeconfigCatalog.test.js
git commit -m "feat: discover kubeconfig contexts"
```

### Task 2: Make runtime selection source-aware

**Files:**
- Modify: `src/main/kubernetes/kubernetesRuntime.ts`
- Modify: `src/main/kubernetes/clusterSession.ts`
- Modify: `src/main/kubernetes/contextPreference.ts`
- Modify: `tests/kubernetesRuntime.test.js`
- Modify: `tests/clusterSession.test.js`
- Modify: `tests/kubeconfigStore.test.js`

**Interfaces:**
- `KubernetesRuntimeOptions` consumes `kubeconfigDirectory`, `readKubeconfigCatalog`, and `watchKubeconfigDirectory` injection points.
- Runtime resolves a selected stable ID through its active private catalog before calling `createKubernetesClient({ kubeconfigPath, context })`.
- `KubernetesContextPreference` continues to load/save one safe string, now documented as a stable Context selection ID.

- [ ] **Step 1: Write failing source-resolution and reload tests**

Add tests proving that two same-named Contexts invoke client creation with different source files, directory notifications only expose Reload before confirmation, confirmed credential-only changes rebuild the client, deleting the selected source disconnects and clears preference, and no same-named fallback occurs.

```js
assert.deepEqual(createdClients, [
  { kubeconfigPath: eastPath, context: 'shared' },
  { kubeconfigPath: westPath, context: 'shared' },
]);
assert.equal(runtime.getState().kubeconfigReloadAvailable, true);
assert.equal(await preference.load(), undefined);
```

- [ ] **Step 2: Run runtime/session tests and verify RED**

Run: `pnpm run build && node --test tests/kubernetesRuntime.test.js tests/clusterSession.test.js tests/kubeconfigStore.test.js`

Expected: FAIL because runtime still accepts one fixed kubeconfig path and cannot resolve catalog IDs.

- [ ] **Step 3: Replace single-file runtime state with active and pending catalogs**

Initialize from `scanKubeconfigDirectory(kubeconfigDirectory)`. Keep the active catalog unchanged when the directory watcher produces a different fingerprint; set only `kubeconfigReloadAvailable`. On confirmed reload, atomically replace it, call `session.setContexts(..., { reconnectActiveContext: true })`, and clear a stale preference. Resolve client construction through the active catalog:

```ts
const source = resolveKubeconfigContext(this.activeCatalog, selectionId);
if (!source) throw new Error('The selected Kubernetes Context is no longer available.');
return createKubernetesClient({
  kubeconfigPath: source.kubeconfigPath,
  context: source.contextName,
});
```

Watch the entire directory and ignore platform-specific event filenames. Preserve best-effort watcher error handling and close the watcher during shutdown.

- [ ] **Step 4: Update identity copies and preference documentation**

Ensure `ClusterSession` copies `contextName` and `displayName` and continues matching/selecting by stable `name`. Update preference comments and tests to assert the persisted JSON contains only `selectedContext` and no path, token, certificate, key, server, or URL.

- [ ] **Step 5: Run runtime/session tests**

Run: `pnpm run build && node --test tests/kubernetesRuntime.test.js tests/clusterSession.test.js tests/kubeconfigStore.test.js tests/kubeconfigCatalog.test.js`

Expected: PASS with zero failures.

- [ ] **Step 6: Commit runtime integration**

```bash
git add src/main/kubernetes/kubernetesRuntime.ts src/main/kubernetes/clusterSession.ts src/main/kubernetes/contextPreference.ts tests/kubernetesRuntime.test.js tests/clusterSession.test.js tests/kubeconfigStore.test.js
git commit -m "feat: connect discovered kubeconfig contexts"
```

### Task 3: Wire Electron, renderer labels, and documentation

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/renderer/kubernetesPage.ts`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `tests/kubernetesRenderer.test.js`

**Interfaces:**
- Main constructs `KubernetesRuntime` with `kubeconfigDirectory: path.join(app.getPath('home'), '.kube')`.
- Renderer option values remain stable selection IDs (`context.name`) and visible text uses `context.displayName`.

- [ ] **Step 1: Write failing renderer-safe display tests**

Add a renderer test with duplicate labels that proves option values are distinct IDs, visible labels are filename-qualified, unsupported suffixes remain English, and dynamic values are text-only.

```js
assert.equal(options[0].value, 'east-id');
assert.equal(options[0].textContent, 'shared — east.config');
assert.equal(options[1].textContent, 'shared — west.config (unsupported)');
```

- [ ] **Step 2: Run renderer tests and verify RED**

Run: `pnpm run build && node --test tests/kubernetesRenderer.test.js`

Expected: FAIL because the renderer still displays `context.name`.

- [ ] **Step 3: Wire directory discovery and display labels**

Change main-process construction to pass the `.kube` directory. Render each option as:

```ts
option.value = context.name;
option.textContent = context.supported
  ? context.displayName
  : `${context.displayName} (unsupported)`;
```

Keep selection, resource-query identity, TLS lookup, and custom-resource lifecycle keyed by stable `context.name`/`selectedContext`.

- [ ] **Step 4: Update README and AGENTS**

Document first-level regular-file discovery, non-recursion, duplicate labels, explicit Reload, one active Context, platform-aware home paths, source-aware relative credentials, and main-process-only paths/credentials. Replace every statement that says the app reads only `~/.kube/config`.

- [ ] **Step 5: Run renderer and documentation-adjacent tests**

Run: `pnpm run build && node --test tests/kubernetesRenderer.test.js tests/kubernetesRuntime.test.js tests/kubeconfigCatalog.test.js`

Expected: PASS with zero failures.

- [ ] **Step 6: Commit UI and documentation**

```bash
git add src/main/main.ts src/renderer/kubernetesPage.ts README.md AGENTS.md tests/kubernetesRenderer.test.js
git commit -m "feat: show discovered kubeconfig contexts"
```

### Task 4: Full verification and requirements audit

**Files:**
- Verify all modified files.

**Interfaces:**
- Consumes the completed discovery catalog, runtime integration, renderer labels, and documentation.
- Produces fresh build and test evidence for the final handoff.

- [ ] **Step 1: Audit the implementation against the design**

Check every requirement in `docs/superpowers/specs/2026-07-12-multi-kubeconfig-discovery-design.md`, including Windows path handling, duplicate isolation, reload confirmation, stale selection behavior, no recursion/symlink following, authentication restrictions, and IPC/diagnostic redaction.

- [ ] **Step 2: Inspect the complete diff**

Run: `git diff --check && git status --short && git diff HEAD~3 --stat`

Expected: no whitespace errors; only scoped source, tests, docs, and the pre-existing untracked `.pnpm-store/` appear.

- [ ] **Step 3: Run the full project verification**

Run: `pnpm test`

Expected: build exits 0 and every `node:test` test passes with zero failures.

- [ ] **Step 4: Commit any verification-only corrections**

If the audit required a scoped correction, repeat its failing test, minimal fix, targeted passing test, and `pnpm test`, then commit only those correction files with `git commit -m "fix: complete multi-kubeconfig discovery"`.

