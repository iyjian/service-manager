# Kubernetes Drawer Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Kubernetes full-page detail flow with a compact, full-width resource browser, right-side resource drawer, and persistent multi-tab Logs/Shell workspace while safely exposing requested Pod data.

**Architecture:** Keep the existing main-process-only Kubernetes ownership model and add two narrow pure main-process helpers: one projects Pod request/restart/node list columns, and one resolves only the selected Pod container's declared Secret-backed environment. The renderer keeps the virtual table and active Watch alive beneath an overlay drawer, builds drawer content through DOM nodes, and moves logs/xterm ownership into a page-scoped workspace keyed by namespace, Pod, container, and tab type.

**Tech Stack:** Electron, TypeScript, `@kubernetes/client-node`, DOM APIs with `textContent`, Tailwind component CSS, copied local `js-yaml`, `@xterm/xterm`, Node built-in `node:test`.

## Global Constraints

- Work directly on `main`; the user explicitly authorized direct edits, staging, and commits there. Do not create a worktree for this change.
- Keep Kubernetes APIs strictly read-only and continue using `@kubernetes/client-node`; do not invoke `kubectl` or system `ssh`.
- Do not add or update dependencies. If a dependency change becomes necessary, stop and ask the user to run `pnpm install` before build/runtime work resumes.
- Preserve the 200-item paging, in-memory-only cache, renderer bounded virtual-window contract, and one active-view Watch. Opening a drawer must not pause or replace the list Watch.
- CPU and Memory list values are aggregate ordinary-container `resources.requests`, never limits, init-container requests, or Metrics API usage. Restarts aggregate normal and init status restart counts.
- Keep only `Workloads`, `Network`, `Configuration`, `Storage`, and `Custom Resources` reachable in the Kubernetes UI. Do not delete the underlying supported cluster-scoped client types.
- Kubernetes dynamic values—including labels, YAML, Event messages, environment values, log output, terminal output, and errors—must be built with DOM nodes and `textContent`; never interpolate Kubernetes data into `innerHTML`.
- Decoded Pod environment Secret values may exist only in the current drawer/container's short-lived renderer state. They must not enter list/watch summaries, resource caches, settings, runtime diagnostics, toasts, console output, or disk.
- A 401/403 while resolving Pod environment Secrets is drawer-local: retain non-Secret declarations, show the fixed permission state, and do not disconnect the Context.
- Keep the existing ten-active-port-forward limit and Context/page/shutdown cleanup semantics. Closing a resource drawer must not close an already open Logs or Shell tab.
- Use a default 1230×820 window as the primary layout target. At smaller sizes (including 900×620), the Kubernetes page itself stays document-scroll-free and moves overflow into the table, drawer body, and workspace panes.
- Update both `README.md` and `AGENTS.md` for the changed Kubernetes behavior and architecture.
- Run `pnpm test` after behavioral changes; it builds `dist` before the Node tests. Run `git diff --check` before the final commit and validate the real Electron app through DevTools.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/shared/types.ts` | Renderer-safe Pod environment contract and monotonic log state revision. |
| `src/main/kubernetes/podSummary.ts` | Pure Kubernetes quantity parsing/formatting and Pod request, restart, and node summary projection. |
| `src/main/kubernetes/podEnvironment.ts` | Pure bounded declaration resolver that expands only explicitly referenced Secret values through a supplied read callback. |
| `src/main/kubernetes/kubernetesClient.ts` | Calls read-only Pod/Secret endpoints, maps safe list/Event summary fields, and never caches resolved environment values. |
| `src/main/kubernetes/kubernetesRuntime.ts` | Validates runtime ownership, forwards the narrow environment request, and copies only display-safe response data. |
| `src/main/kubernetes/podInteractions.ts` | Adds monotonically increasing `KubernetesLogState.revision` at every log-state mutation. |
| `src/main/main.ts` / `src/main/preload.ts` | Validated `kubernetes:get-pod-environment` IPC bridge. |
| `src/renderer/kubernetesDrawerModel.ts` | Pure display model for Pod header, labels, containers, command/mount text, and collapsed sections. |
| `src/renderer/kubernetesWorkspace.ts` | Page-scoped tab ownership, exact session routing, per-tab Log UI, and close/reopen guards. |
| `src/renderer/kubernetesTerminal.ts` | Reusable single-session xterm pane renderer used by the workspace instead of a floating terminal drawer. |
| `src/renderer/kubernetesPage.ts` | Compact controls/table rendering, overlay-drawer lifecycle, lazy Env/Event loading, workspace integration, and Context/page cleanup. |
| `src/renderer/index.html` / `src/renderer/tailwind.css` | Full-width Kubernetes shell, one-line controls, eight-column table, overlay drawer, and bottom workspace layout. |
| `tests/kubernetesPodSummary.test.js` | Pure Quantity/Pod summary and Event projection coverage. |
| `tests/kubernetesPodEnvironment.test.js` | Narrow Secret environment resolution, bounds, dedupe, and permission isolation coverage. |
| `tests/kubernetesDrawerModel.test.js` | Pod drawer model field and container-action coverage. |
| `tests/kubernetesWorkspace.test.js` | Target-key reuse, session routing, follow revision, close/reopen, and lifecycle cleanup coverage. |
| `tests/kubernetesRenderer.test.js` / `tests/kubernetesDetailRenderer.test.js` / `tests/kubernetesRuntime.test.js` / `tests/clusterSession.test.js` | Updated renderer shell, IPC/runtime, list/watch, and security regression coverage. |
| `README.md` / `AGENTS.md` | Durable user/developer documentation for the new page contract. |

## Target Contracts

Add the following renderer-safe contracts in `src/shared/types.ts` beside `KubernetesPodTarget` and `KubernetesLogState`:

```ts
export type KubernetesPodEnvironmentSource =
  | 'literal'
  | 'secretKeyRef'
  | 'secretEnvFrom'
  | 'configMapKeyRef'
  | 'configMapEnvFrom'
  | 'fieldRef'
  | 'resourceFieldRef'
  | 'unknown';

export type KubernetesPodEnvironmentUnavailable =
  | 'missing'
  | 'no-permission'
  | 'unsupported'
  | 'too-large';

export interface KubernetesPodEnvironmentEntry {
  name: string;
  source: KubernetesPodEnvironmentSource;
  value?: string;
  reference?: string;
  unavailable?: KubernetesPodEnvironmentUnavailable;
}

export interface KubernetesPodEnvironment {
  entries: KubernetesPodEnvironmentEntry[];
  truncated: boolean;
  permissionDenied: boolean;
}
```

Extend, rather than replace, the existing log contract:

```ts
export interface KubernetesLogState {
  sessionId: string;
  podName: string;
  namespace: string;
  container: string;
  lines: string[];
  following: boolean;
  hasOlder: boolean;
  revision: number;
}
```

`revision` is a per-session monotonic integer. A workspace ignores a matching session update whose revision is lower than the state it already owns; equal revisions are idempotent duplicate broadcasts.

### Task 1: Add deterministic Pod list and Event projections

**Files:**
- Create: `src/main/kubernetes/podSummary.ts`
- Modify: `src/main/kubernetes/kubernetesClient.ts:299-458, 782-801, 898-912`
- Modify: `src/renderer/kubernetesPage.ts:42-74, 2379-2400`
- Modify: `src/renderer/index.html:235-265`
- Modify: `src/renderer/tailwind.css:348-456`
- Modify: `tests/clusterSession.test.js:490-545`
- Create: `tests/kubernetesPodSummary.test.js`
- Modify: `tests/kubernetesRenderer.test.js:150-220, 300-380`

**Interfaces:**
- Consumes: raw main-process Pod/Event objects and the existing `KubernetesResourceSummary.columns: Record<string, string>`.
- Produces: `summarizePodListColumns(pod): { cpu, memory, restarts, node }`, `mapKubernetesResourceSummary()` columns for Pod and Event data, and the exact renderer column keys `cpu`, `memory`, `restarts`, and `node`.
- Preserves: non-Pod summaries remain safe and render em dashes for Pod-only table columns.

- [ ] **Step 1: Write failing pure summary and projection tests**

Create `tests/kubernetesPodSummary.test.js` with direct compiled-module tests. Keep the fixture intentionally mixed so it proves ordinary-container-only requests and normal-plus-init restarts:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const summaryPath = '../dist/main/kubernetes/podSummary';
const clientPath = '../dist/main/kubernetes/kubernetesClient';

test('summarizePodListColumns aggregates ordinary requests and all restart statuses', () => {
  const { summarizePodListColumns } = require(summaryPath);
  assert.deepEqual(summarizePodListColumns({
    spec: {
      nodeName: 'worker-a',
      containers: [
        { resources: { requests: { cpu: '250m', memory: '128Mi' } } },
        { resources: { requests: { cpu: '0.75', memory: '1Gi' } } },
      ],
      initContainers: [{ resources: { requests: { cpu: '8', memory: '8Gi' } } }],
    },
    status: {
      containerStatuses: [{ restartCount: 2 }, { restartCount: 1 }],
      initContainerStatuses: [{ restartCount: 3 }],
    },
  }), { cpu: '1', memory: '1152Mi', restarts: '6', node: 'worker-a' });
});

test('summary mapper applies Pod columns to both List and Watch objects and keeps Event messages safe', () => {
  const { mapKubernetesResourceSummary } = require(clientPath);
  const pod = mapKubernetesResourceSummary('pods', {
    metadata: { uid: 'pod-1', name: 'api', namespace: 'apps', resourceVersion: '9' },
    spec: { containers: [{ resources: { requests: { cpu: '500m', memory: '256Mi' } } }] },
    status: { phase: 'Running', containerStatuses: [{ restartCount: 0 }] },
  });
  assert.deepEqual(pod.columns, { status: 'Running', cpu: '500m', memory: '256Mi', restarts: '0', node: '—' });

  const event = mapKubernetesResourceSummary('events', {
    metadata: { uid: 'event-1', name: 'api.1', namespace: 'apps', resourceVersion: '10' },
    reason: 'BackOff', type: 'Warning', message: 'retrying <unsafe>', count: 4,
    lastTimestamp: '2026-07-14T00:00:00.000Z',
  });
  assert.equal(event.columns.message, 'retrying <unsafe>');
  assert.equal(event.columns.type, 'Warning');
  assert.equal(event.columns.count, '4');
});
```

Extend `tests/clusterSession.test.js` to assert invalid/negative quantities are ignored, a missing request renders `—`, and `mapKubernetesResourceSummary('secrets', ...)` still strips `data` and `stringData`.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
pnpm build && node --test tests/kubernetesPodSummary.test.js tests/clusterSession.test.js
```

Expected: FAIL because `podSummary.js` and the new Pod/Event column projection do not exist yet.

- [ ] **Step 3: Implement bounded pure Quantity and Pod-summary helpers**

Create `src/main/kubernetes/podSummary.ts`. Parse only finite non-negative Kubernetes quantities; use `bigint` so ordinary decimal CPU units do not silently lose precision. The canonical display rules are exact: whole cores render without a suffix, exact milli/µ/nano values render `m`/`u`/`n`, and memory renders the largest exact binary or decimal SI unit before falling back to exact bytes.

```ts
export const POD_SUMMARY_EMPTY = '—';

export interface KubernetesPodListColumns {
  cpu: string;
  memory: string;
  restarts: string;
  node: string;
}

export function summarizePodListColumns(pod: Record<string, unknown>): KubernetesPodListColumns {
  const spec = record(pod.spec);
  const regular = array(spec?.containers);
  const statuses = [...array(record(pod.status)?.containerStatuses), ...array(record(pod.status)?.initContainerStatuses)];
  const cpu = sum(regular.map((container) => parseCpu(record(record(container)?.resources)?.requests?.cpu)));
  const memory = sum(regular.map((container) => parseMemory(record(record(container)?.resources)?.requests?.memory)));
  return {
    cpu: cpu === undefined ? POD_SUMMARY_EMPTY : formatCpu(cpu),
    memory: memory === undefined ? POD_SUMMARY_EMPTY : formatMemory(memory),
    restarts: String(statuses.reduce((total, status) => total + restartCount(status), 0)),
    node: text(spec?.nodeName) ?? POD_SUMMARY_EMPTY,
  };
}
```

Implement local `record`, `array`, `text`, `parseDecimal`, `parseCpu`, `parseMemory`, `sum`, `formatCpu`, `formatMemory`, and `restartCount` helpers in that file. Reject signed negative, malformed, non-finite, and unsupported-unit values rather than coercing them. Do not inspect `initContainers` while summing requests.

In `mapKubernetesResourceSummary()` merge the result only for `kind === 'pods'`:

```ts
if (kind === 'pods') Object.assign(columns, summarizePodListColumns(source));
```

For `kind === 'events'`, add safe bounded fields to the existing `columns` map without exposing raw event objects:

```ts
columns.reason = stringValue(source.reason) ?? POD_SUMMARY_EMPTY;
columns.type = stringValue(source.type) ?? POD_SUMMARY_EMPTY;
columns.message = (stringValue(source.message) ?? POD_SUMMARY_EMPTY).slice(0, 16_384);
columns.count = String(numericValue(source.count) ?? 0);
const observed = timestampValue(source.eventTime)
  ?? timestampValue(objectValue(source, 'series').lastObservedTime)
  ?? timestampValue(source.lastTimestamp)
  ?? createdAt;
if (observed) columns.observedAt = observed;
```

Keep the existing `status` field for compatibility (`reason` first, then type), and continue to map all List and Watch objects through this one mapper.

- [ ] **Step 4: Render the exact compact eight-column list**

In `src/renderer/index.html`, replace the four header cells with sortable columns in this exact order:

```html
Namespace | Name | CPU | Memory | Restarts | Status | Node | Age
```

Give every header a `data-kubernetes-sort` value: `namespace`, `name`, `cpu`, `memory`, `restarts`, `status`, `node`, and `age`. Extend `KubernetesSortColumn`, `kubernetesSortColumn()`, and `renderSortHeaders()` to accept those values. Keep sorting loaded-only through `resourceQuery.ts`; its existing `columns[column]` fallback already handles the four new display columns.

Replace the row fields in `renderRow()` with:

```ts
const fields = [
  item.namespace ?? '—',
  item.name,
  item.columns.cpu ?? '—',
  item.columns.memory ?? '—',
  item.columns.restarts ?? '—',
  item.status ?? '—',
  item.columns.node ?? '—',
  formatAge(item.createdAt),
];
```

Set one matching minimum-width grid on both header and row:

```css
grid-template-columns:
  minmax(128px, 1.05fr) minmax(240px, 2fr) 88px 106px 82px
  minmax(104px, 0.95fr) minmax(148px, 1.2fr) 68px;
min-width: 1064px;
```

Keep `white-space: nowrap` and `overflow: hidden; text-overflow: ellipsis` on every table cell. Put horizontal overflow on `.kubernetes-table-shell`; keep `.kubernetes-table-viewport` vertically scrollable only so the header and virtual rows remain horizontally aligned.

- [ ] **Step 5: Run focused tests and commit the independently working data/list change**

Run:

```bash
pnpm build && node --test --test-name-pattern="Pod|summary|table sorting|renderer keeps dynamic" tests/*.test.js
git diff --check
git add src/main/kubernetes/podSummary.ts src/main/kubernetes/kubernetesClient.ts src/renderer/index.html src/renderer/tailwind.css src/renderer/kubernetesPage.ts tests/kubernetesPodSummary.test.js tests/clusterSession.test.js tests/kubernetesRenderer.test.js
git commit -m "feat: project compact kubernetes pod list columns"
```

Expected: focused Node tests pass; the table has exactly eight non-wrapping columns; only Pod summaries contain CPU, Memory, Restarts, and Node values.

### Task 2: Add the narrow, non-cached Pod environment resolver and IPC bridge

**Files:**
- Create: `src/main/kubernetes/podEnvironment.ts`
- Modify: `src/shared/types.ts:246-410`
- Modify: `src/main/kubernetes/kubernetesClient.ts:83-106, 692-1050`
- Modify: `src/main/kubernetes/kubernetesRuntime.ts:72-96, 634-786, 1299-1345`
- Modify: `src/main/main.ts:66-128, 281-290, 1103-1204`
- Modify: `src/main/preload.ts:121-156`
- Create: `tests/kubernetesPodEnvironment.test.js`
- Modify: `tests/kubernetesRuntime.test.js:60-180, 400-490`
- Modify: `tests/kubernetesRenderer.test.js:1-130`

**Interfaces:**
- Consumes: `KubernetesPodTarget`, the active main-process `KubernetesClient`, raw Pod `spec.containers`/`initContainers`, and read-only `readNamespacedSecret` results.
- Produces: `KubernetesPodEnvironment` through `window.kubernetesApi.getPodContainerEnvironment(input)`.
- Does not produce: a raw Secret, resource-cache entry, list summary, Event, setting, diagnostic payload, or renderer-side credential.

- [ ] **Step 1: Write failing resolver, bound, and bridge tests**

Create `tests/kubernetesPodEnvironment.test.js` with an injected `readSecret` callback. Test all target cases without using a real cluster:

```js
test('resolves literal, secretKeyRef, and prefixed envFrom secret values with one Secret read', async () => {
  const { resolvePodContainerEnvironment } = require('../dist/main/kubernetes/podEnvironment');
  let reads = 0;
  const result = await resolvePodContainerEnvironment({
    spec: { containers: [{ name: 'api', env: [
      { name: 'MODE', value: 'prod' },
      { name: 'PASSWORD', valueFrom: { secretKeyRef: { name: 'app-env', key: 'password' } } },
    ], envFrom: [{ prefix: 'APP_', secretRef: { name: 'app-env' } }] }] },
  }, 'api', {
    async readSecret(name) {
      reads += 1;
      assert.equal(name, 'app-env');
      return { data: { password: 'c2VjcmV0', host: 'ZGI=' } };
    },
    isPermissionError: () => false,
  });
  assert.equal(reads, 1);
  assert.deepEqual(result.entries, [
    { name: 'MODE', source: 'literal', value: 'prod' },
    { name: 'PASSWORD', source: 'secretKeyRef', value: 'secret', reference: 'secret/app-env/password' },
    { name: 'APP_host', source: 'secretEnvFrom', value: 'db', reference: 'secret/app-env/host' },
    { name: 'APP_password', source: 'secretEnvFrom', value: 'secret', reference: 'secret/app-env/password' },
  ]);
});

test('marks missing, optional, permission, and oversized Secret declarations without returning hidden data', async () => {
  const { resolvePodContainerEnvironment, MAX_POD_ENVIRONMENT_VALUE_BYTES } = require('../dist/main/kubernetes/podEnvironment');
  const result = await resolvePodContainerEnvironment({
    spec: { containers: [{ name: 'api', env: [
      { name: 'MISSING', valueFrom: { secretKeyRef: { name: 'missing', key: 'password' } } },
      { name: 'OPTIONAL', valueFrom: { secretKeyRef: { name: 'missing', key: 'optional', optional: true } } },
      { name: 'DENIED', valueFrom: { secretKeyRef: { name: 'denied', key: 'token' } } },
      { name: 'LARGE', valueFrom: { secretKeyRef: { name: 'large', key: 'value' } } },
    ] }] },
  }, 'api', {
    async readSecret(name) {
      if (name === 'missing') return { data: {} };
      if (name === 'denied') throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      return { data: { value: Buffer.from('x'.repeat(MAX_POD_ENVIRONMENT_VALUE_BYTES + 1)).toString('base64') } };
    },
    isPermissionError: (error) => error?.statusCode === 403,
  });
  assert.deepEqual(result.entries.map(({ name, unavailable }) => [name, unavailable]), [
    ['MISSING', 'missing'], ['OPTIONAL', 'missing'], ['DENIED', 'no-permission'], ['LARGE', 'too-large'],
  ]);
  assert.equal(result.permissionDenied, true);
  assert.doesNotMatch(JSON.stringify(result), /x{100}|forbidden/);
});
```

Add test cases for `configMapKeyRef`, `configMapEnvFrom`, `fieldRef`, and `resourceFieldRef` source labels; a missing non-optional key; optional `secretKeyRef`; a 403 sentinel; 513 decoded `envFrom` keys; a value exceeding 16 KiB; and a total response exceeding 128 KiB. Extend `tests/kubernetesRuntime.test.js` with a fake client that records `getPodContainerEnvironment()` calls, proving the runtime bypasses the coordinator/list cache and returns a defensive copy.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
pnpm build && node --test tests/kubernetesPodEnvironment.test.js tests/kubernetesRuntime.test.js
```

Expected: FAIL because there is no environment resolver method or IPC contract.

- [ ] **Step 3: Implement the pure bounded resolver**

Create `src/main/kubernetes/podEnvironment.ts` with these fixed bounds and no module-level cache:

```ts
export const MAX_POD_ENVIRONMENT_ENTRIES = 512;
export const MAX_POD_ENVIRONMENT_VALUE_BYTES = 16 * 1024;
export const MAX_POD_ENVIRONMENT_TOTAL_BYTES = 128 * 1024;

export interface PodEnvironmentResolverDependencies {
  readSecret(name: string): Promise<Record<string, unknown>>;
  isPermissionError(error: unknown): boolean;
}

type SecretReadResult =
  | { kind: 'value'; secret: Record<string, unknown> }
  | { kind: 'permission' };

export async function resolvePodContainerEnvironment(
  pod: Record<string, unknown>,
  containerName: string,
  dependencies: PodEnvironmentResolverDependencies,
): Promise<KubernetesPodEnvironment> {
  const container = findContainer(pod, containerName);
  if (!container) throw new Error('Kubernetes Pod container is not available.');
  const reads = new Map<string, Promise<SecretReadResult>>();
  const readSecret = (name: string): Promise<SecretReadResult> => {
    const existing = reads.get(name);
    if (existing) return existing;
    const next = dependencies.readSecret(name)
      .then((secret) => ({ kind: 'value' as const, secret }))
      .catch((error) => dependencies.isPermissionError(error)
        ? ({ kind: 'permission' as const })
        : Promise.reject(error));
    reads.set(name, next);
    return next;
  };
  return resolveDeclarations(container, readSecret);
}
```

Use these deterministic declaration rules:

1. `env[].value` returns `{ source: 'literal', value }`.
2. `env[].valueFrom.secretKeyRef` reads only the referenced Secret object, decodes the referenced `data[key]` UTF-8 value, and uses `reference: secret/<name>/<key>`.
3. `envFrom[].secretRef` reads the named Secret once, enumerates its `data` keys lexicographically, prepends `prefix`, and returns one `secretEnvFrom` entry per decoded key.
4. ConfigMap, field, resource-field, unknown, and optional/missing declarations return an explicit source/reference/unavailable label. They never pretend to be evaluated runtime values.
5. Decode base64 in the main process, reject non-UTF-8 or over-bound values as `unavailable: 'too-large'`, and set `truncated: true` whenever either response bound is hit.
6. Catch only an authorization failure per Secret read and turn each dependent entry into `unavailable: 'no-permission'`, with `permissionDenied: true`. Rethrow transport and other operational failures without including a Secret value in the error.

Use a per-invocation `Map<string, Promise<SecretReadResult>>` so a `secretKeyRef` and an `envFrom` for the same Secret issue one read. Never attach the resolved values back to the raw Pod or any cache object.

- [ ] **Step 4: Expose the resolver only through the active client/runtime/IPC chain**

Add the shared types from the Target Contracts section, then add this exact method to `KubernetesClient` and its implementation:

```ts
getPodContainerEnvironment(input: KubernetesPodTarget): Promise<KubernetesPodEnvironment>;
```

The client implementation must call `readNamespacedPod` with the target namespace/name, call `resolvePodContainerEnvironment()` with a local `readNamespacedSecret` callback, and use the existing status-code helper to recognize 401/403. It must not call `ResourceCoordinator`, `ResourceCache`, or `sanitizeSecretForCache`.

Thread the method through `KubernetesRuntime`, `KubernetesInteractions`-independent runtime validation, `IPC_CHANNELS.kubernetesGetPodEnvironment = 'kubernetes:get-pod-environment'`, `validateKubernetesPodTarget`, and `preload.ts`:

```ts
getPodContainerEnvironment: (input: KubernetesPodTarget) =>
  ipcRenderer.invoke('kubernetes:get-pod-environment', input),
```

`KubernetesRuntime.getPodContainerEnvironment()` returns new entry objects (`entries.map((entry) => ({ ...entry }))`) and only invokes existing `onOperationFailure` for a thrown transport/non-authorization operation. Do not write source errors or decoded values to a toast, diagnostic, or console.

- [ ] **Step 5: Run focused tests and commit the secure main-process capability**

Run:

```bash
pnpm build && node --test --test-name-pattern="environment|Secret|runtime" tests/*.test.js
git diff --check
git add src/shared/types.ts src/main/kubernetes/podEnvironment.ts src/main/kubernetes/kubernetesClient.ts src/main/kubernetes/kubernetesRuntime.ts src/main/main.ts src/main/preload.ts tests/kubernetesPodEnvironment.test.js tests/kubernetesRuntime.test.js tests/kubernetesRenderer.test.js
git commit -m "feat: resolve active pod environment secrets safely"
```

Expected: all resolver cases pass, a 403 is represented only by the fixed environment state, and no test fixture secret plaintext appears in any snapshot/cache assertion.

### Task 3: Create the pure drawer and workspace ownership models

**Files:**
- Create: `src/renderer/kubernetesDrawerModel.ts`
- Create: `src/renderer/kubernetesWorkspace.ts`
- Modify: `src/renderer/kubernetesTerminal.ts:13-206`
- Modify: `src/shared/types.ts:246-260`
- Modify: `src/main/kubernetes/podInteractions.ts:26-220, 340-450`
- Create: `tests/kubernetesDrawerModel.test.js`
- Create: `tests/kubernetesWorkspace.test.js`
- Modify: `tests/podInteractions.test.js`
- Modify: `tests/kubernetesRuntime.test.js`
- Modify: `tests/kubernetesRenderer.test.js`
- Modify: `tests/kubernetesTerminalInput.test.js`

**Interfaces:**
- Consumes: display-safe Pod detail, `KubernetesPodTarget`, `KubernetesLogState`, `KubernetesTerminalState`, and terminal output chunks.
- Produces: `buildKubernetesDrawerModel()`, `kubernetesWorkspaceTabKey()`, `createKubernetesWorkspaceState()`, and a reusable `createKubernetesTerminalPane()` with exact session-ID ownership.
- Preserves: xterm input/resize behavior, `/bin/sh` → `ash` → `bash` backend fallback, 2,000-line buffers, and local close fences.

- [ ] **Step 1: Write failing drawer-model and workspace-state tests**

Create `tests/kubernetesDrawerModel.test.js`:

```js
test('buildKubernetesDrawerModel exposes compact Pod header and container values without evaluating Env', async () => {
  const { buildKubernetesDrawerModel } = await import('../dist/renderer/kubernetesDrawerModel.js');
  const model = buildKubernetesDrawerModel({
    metadata: { name: 'api', namespace: 'apps', labels: { tier: 'backend', app: 'api' } },
    spec: { nodeName: 'worker-a', containers: [{
      name: 'api', image: 'example/api:v1', imagePullPolicy: 'IfNotPresent',
      command: ['node'], args: ['server.js'], volumeMounts: [{ mountPath: '/work' }],
      env: [{ name: 'PASSWORD', valueFrom: { secretKeyRef: { name: 'db', key: 'password' } } }],
    }] },
    status: { phase: 'Running', podIP: '10.0.0.5', podIPs: [{ ip: '10.0.0.5' }], containerStatuses: [{ name: 'api', ready: true, state: { running: {} } }] },
  }, { name: 'api', namespace: 'apps', status: 'Running' });
  assert.deepEqual(model.header, [
    ['Name', 'api'], ['Namespace', 'apps'], ['Status', 'Running'], ['Node', 'worker-a'],
    ['Pod IP', '10.0.0.5'], ['Pod IPs', '10.0.0.5'],
  ]);
  assert.deepEqual(model.labels, [['app', 'api'], ['tier', 'backend']]);
  assert.deepEqual(model.containers[0].target, { namespace: 'apps', podName: 'api', container: 'api' });
  assert.equal(model.containers[0].environmentDeclared, true);
});
```

Create `tests/kubernetesWorkspace.test.js` with pure-state cases:

```js
test('same target and type reuses one tab while different types and Pods stay distinct', async () => {
  const { kubernetesWorkspaceTabKey, createKubernetesWorkspaceState } = await import('../dist/renderer/kubernetesWorkspace.js');
  const target = { namespace: 'apps', podName: 'api', container: 'web' };
  const state = createKubernetesWorkspaceState();
  assert.equal(state.open('logs', target).created, true);
  assert.equal(state.open('logs', target).created, false);
  assert.notEqual(kubernetesWorkspaceTabKey('logs', target), kubernetesWorkspaceTabKey('shell', target));
  assert.notEqual(kubernetesWorkspaceTabKey('logs', target), kubernetesWorkspaceTabKey('logs', { ...target, podName: 'api-2' }));
});

test('workspace rejects stale log revisions and old terminal final events after close and reopen', async () => {
  const { createKubernetesWorkspaceState } = await import('../dist/renderer/kubernetesWorkspace.js');
  const target = { namespace: 'apps', podName: 'api', container: 'web' };
  const state = createKubernetesWorkspaceState();
  const first = state.open('shell', target).tab;
  state.bindTerminal(first.id, 'terminal-old');
  state.close(first.id);
  const second = state.open('shell', target).tab;
  state.bindTerminal(second.id, 'terminal-new');
  assert.equal(state.routeTerminalFinal({ id: 'terminal-old', state: 'closed' }), false);
  assert.deepEqual(state.tabs().map((tab) => tab.id), [second.id]);
  const logTab = state.open('logs', target).tab;
  state.bindLog(logTab.id, { sessionId: 'log-1', ...target, lines: ['new'], following: false, hasOlder: false, revision: 8 });
  state.applyLog({ sessionId: 'log-1', ...target, lines: ['old'], following: true, hasOlder: false, revision: 7 });
  assert.equal(state.logForSession('log-1')?.following, false);
  assert.deepEqual(state.logForSession('log-1')?.lines, ['new']);
});
```

Add a Log test that applies revision 8 followed by revision 7 and asserts the UI state stays at revision 8 and its `following` value. This is the regression guard for a stale Follow broadcast after a successful Pause/Resume mutation.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
pnpm build && node --test tests/kubernetesDrawerModel.test.js tests/kubernetesWorkspace.test.js tests/podInteractions.test.js tests/kubernetesRuntime.test.js tests/kubernetesTerminalInput.test.js
```

Expected: FAIL because the drawer model, workspace state, and log revision do not exist.

- [ ] **Step 3: Implement the pure Pod drawer model**

Create `src/renderer/kubernetesDrawerModel.ts` with display-only types and no DOM side effects:

```ts
export interface KubernetesDrawerContainer {
  name: string;
  init: boolean;
  target: KubernetesPodTarget;
  status: string;
  image: string;
  imagePullPolicy: string;
  mounts: string;
  command: string;
  environmentDeclared: boolean;
}

export interface KubernetesPodDrawerModel {
  header: Array<[string, string]>;
  labels: Array<[string, string]>;
  containers: KubernetesDrawerContainer[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((item) => record(item) ? [record(item)!] : []) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function buildContainers(
  spec: Record<string, unknown> | undefined,
  status: Record<string, unknown> | undefined,
  namespace: string,
  podName: string,
): KubernetesDrawerContainer[] {
  const normalStatuses = new Map(array(status?.containerStatuses).map((item) => [text(item.name), item]));
  const initStatuses = new Map(array(status?.initContainerStatuses).map((item) => [text(item.name), item]));
  return [
    ...array(spec?.containers).map((item) => toContainer(item, false, normalStatuses.get(text(item.name)), namespace, podName)),
    ...array(spec?.initContainers).map((item) => toContainer(item, true, initStatuses.get(text(item.name)), namespace, podName)),
  ];
}

function toContainer(
  container: Record<string, unknown>,
  init: boolean,
  status: Record<string, unknown> | undefined,
  namespace: string,
  podName: string,
): KubernetesDrawerContainer {
  const name = text(container.name) ?? 'Unnamed container';
  const command = [...strings(container.command), ...strings(container.args)].join(' ') || '—';
  const mounts = array(container.volumeMounts).map((item) => text(item.mountPath)).filter(Boolean).join(', ') || '—';
  return {
    name, init, target: { namespace, podName, container: name }, status: containerStatusText(status),
    image: text(container.image) ?? '—', imagePullPolicy: text(container.imagePullPolicy) ?? 'Default',
    mounts, command, environmentDeclared: array(container.env).length > 0 || array(container.envFrom).length > 0,
  };
}

function containerStatusText(status: Record<string, unknown> | undefined): string {
  const state = record(status?.state);
  if (record(state?.running)) return 'Running';
  const waiting = record(state?.waiting);
  if (waiting) return `Waiting: ${text(waiting.reason) ?? 'Unknown'}`;
  const terminated = record(state?.terminated);
  if (terminated) return `Terminated: ${text(terminated.reason) ?? 'Unknown'}`;
  return 'Unknown';
}

export function buildKubernetesDrawerModel(
  detail: Record<string, unknown>,
  fallback: Pick<KubernetesResourceSummary, 'name' | 'namespace' | 'status'>,
): KubernetesPodDrawerModel {
  const metadata = record(detail.metadata);
  const spec = record(detail.spec);
  const status = record(detail.status);
  const name = text(metadata?.name) ?? fallback.name;
  const namespace = text(metadata?.namespace) ?? fallback.namespace ?? '—';
  const podIPs = array(status?.podIPs).map((item) => text(record(item)?.ip)).filter((value): value is string => Boolean(value));
  return {
    header: [
      ['Name', name], ['Namespace', namespace], ['Status', text(status?.phase) ?? fallback.status ?? '—'],
      ['Node', text(spec?.nodeName) ?? '—'], ['Pod IP', text(status?.podIP) ?? '—'],
      ['Pod IPs', podIPs.length > 0 ? podIPs.join(', ') : '—'],
    ],
    labels: Object.entries(record(metadata?.labels) ?? {}).map(([key, value]) => [key, text(value) ?? '']).sort(([a], [b]) => a.localeCompare(b)),
    containers: buildContainers(spec, status, namespace, name),
  };
}
```

Sort labels lexically; use `Default` when `imagePullPolicy` is omitted; join mount paths with `, `; join `command` and `args` with spaces; return `—` where a display value is absent. Join `status.containerStatuses`/`initContainerStatuses` to spec containers by name and present `Running`, `Waiting: <reason>`, `Terminated: <reason>`, or `Unknown`. The model does not resolve, decode, or store Secret values.

- [ ] **Step 4: Implement workspace keys, terminal pane reuse, and log revisions**

In `src/renderer/kubernetesWorkspace.ts`, define a target-specific key and a unique tab instance ID:

```ts
export type KubernetesWorkspaceTabType = 'logs' | 'shell';

export function kubernetesWorkspaceTabKey(type: KubernetesWorkspaceTabType, target: KubernetesPodTarget): string {
  return [type, target.namespace, target.podName, target.container].join('\u0000');
}

export interface KubernetesWorkspaceTab {
  id: string;
  key: string;
  type: KubernetesWorkspaceTabType;
  target: KubernetesPodTarget;
  log?: KubernetesLogState;
  terminalId?: string;
  logSearch: string;
  closed: boolean;
}
```

Define this state interface in the same module so its tests and the DOM controller share the exact ownership rules:

```ts
export interface KubernetesWorkspaceState {
  open(type: KubernetesWorkspaceTabType, target: KubernetesPodTarget): { tab: KubernetesWorkspaceTab; created: boolean };
  close(tabId: string): boolean;
  bindLog(tabId: string, log: KubernetesLogState): boolean;
  bindTerminal(tabId: string, terminalId: string): boolean;
  routeTerminalFinal(state: Pick<KubernetesTerminalState, 'id' | 'state'>): boolean;
  applyLog(state: KubernetesLogState): boolean;
  logForSession(sessionId: string): KubernetesLogState | undefined;
  tabs(): KubernetesWorkspaceTab[];
}
```

`createKubernetesWorkspaceState()` creates/focuses a same-key tab, never duplicates one, and allocates a new `id` after a close so an old async completion cannot attach to a reopened same-target tab. Route Logs only by exact `sessionId`; route Shell output/final state only by exact terminal ID; ignore unknown/closed IDs.

Refactor `kubernetesTerminal.ts` from a multi-session floating drawer to a reusable `createKubernetesTerminalPane(options)` that mounts exactly one owned terminal into a host supplied by the workspace. Keep its `finalizedIds` behavior, but record the local close before calling `onClose`. The workspace controls tab selection and calls the pane's `mount`, `focus`, `write`, `finalize`, and `dispose` methods.

In `podInteractions.ts`, initialize every log state with `revision: 0` and call a small `emitLog(session, changed = true)` helper:

```ts
private emitLog(session: LogSession, changed = true): void {
  if (changed) session.state.revision += 1;
  const state = copyLogState(session.state);
  for (const listener of this.logListeners) listener(state);
}
```

Use `changed = true` for line append, clear, older-load completion, and Follow state changes. Use `changed = false` only when forwarding the already current open state. The workspace accepts a state only when `incoming.revision >= existing.revision`, allowing equal duplicate runtime broadcasts while rejecting late older state.

- [ ] **Step 5: Run focused tests and commit the reusable renderer primitives**

Run:

```bash
pnpm build && node --test --test-name-pattern="drawer model|workspace|terminal|Follow|log revision" tests/*.test.js
git diff --check
git add src/shared/types.ts src/main/kubernetes/podInteractions.ts src/renderer/kubernetesDrawerModel.ts src/renderer/kubernetesWorkspace.ts src/renderer/kubernetesTerminal.ts tests/kubernetesDrawerModel.test.js tests/kubernetesWorkspace.test.js tests/podInteractions.test.js tests/kubernetesRuntime.test.js tests/kubernetesRenderer.test.js tests/kubernetesTerminalInput.test.js
git commit -m "feat: add kubernetes drawer and workspace models"
```

Expected: model tests pass, a same-target Logs/Shell request reuses only its matching type, a stale revision cannot undo Follow, and an old terminal close cannot affect a reopened tab.

### Task 4: Replace the page shell with compact controls, full-width table, and overlay drawer

**Files:**
- Modify: `src/renderer/index.html:186-332`
- Modify: `src/renderer/tailwind.css:42-50, 259-750, 1539-1565`
- Modify: `src/renderer/kubernetesPage.ts:42-110, 733-1068, 1561-2050, 2379-2400`
- Modify: `tests/kubernetesRenderer.test.js:130-600`
- Modify: `tests/kubernetesDetailRenderer.test.js:180-560`

**Interfaces:**
- Consumes: the Task 1 table columns and Task 3 `buildKubernetesDrawerModel()`.
- Produces: the compact DOM IDs consumed by `KubernetesPage`, the right overlay drawer, and a list that keeps rendering during drawer detail loading.
- Preserves: resource-kind/Custom Resource controls, namespace multi-select behavior, read-only details, relation loading, Secret-detail active-view handling, and Port Forward dialog behavior.

- [ ] **Step 1: Write failing shell and drawer lifecycle tests**

Replace old full-page-detail assertions with these exact acceptance checks in renderer tests:

```js
test('Kubernetes shell has label-free compact controls, no Cluster category, and one eight-column table', async () => {
  const html = await readFile(path.join(distRenderer, 'index.html'), 'utf8');
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  const controlStart = html.indexOf('class="kubernetes-control-row"');
  const controlEnd = html.indexOf('class="kubernetes-secondary-row"', controlStart);
  const controls = html.slice(controlStart, controlEnd);
  assert.match(html, /id="kubernetes-context"[^>]*aria-label="Kubernetes Context"/);
  assert.match(html, /id="kubernetes-namespace-toggle"[^>]*aria-label="Kubernetes Namespace scope"/);
  assert.doesNotMatch(controls, />Context\s*</);
  assert.doesNotMatch(controls, />Namespace\s*</);
  assert.doesNotMatch(page, /Cluster:\s*\[/);
  for (const heading of ['Namespace', 'Name', 'CPU', 'Memory', 'Restarts', 'Status', 'Node', 'Age']) assert.match(html, new RegExp(`>${heading}<`));
  assert.match(html, /id="kubernetes-detail-drawer"/);
  assert.doesNotMatch(html, /id="kubernetes-detail-page"/);
});

test('drawer replacement keeps the resource list rendering and fences stale detail completion', async () => {
  const { isCurrentKubernetesDrawerRequest } = await import(path.join(distRenderer, 'kubernetesPage.js'));
  assert.equal(isCurrentKubernetesDrawerRequest({ visible: true, pageGeneration: 2, drawerGeneration: 4, uid: 'pod-a' }, { visible: true, pageGeneration: 2, drawerGeneration: 4, uid: 'pod-a' }), true);
  assert.equal(isCurrentKubernetesDrawerRequest({ visible: true, pageGeneration: 2, drawerGeneration: 4, uid: 'pod-a' }, { visible: true, pageGeneration: 2, drawerGeneration: 5, uid: 'pod-b' }), false);
});
```

Also assert no visible `Search loaded resources` label remains, static dynamic drawer render paths use `textContent`, and `onListChanged()` calls `renderList()` even when a drawer is active.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
pnpm build && node --test tests/kubernetesRenderer.test.js tests/kubernetesDetailRenderer.test.js
```

Expected: FAIL because the legacy full-page detail shell and `Cluster` category are still present.

- [ ] **Step 3: Replace the Kubernetes page markup and styles**

In `index.html`, preserve Context/Namespace/select IDs and build this body hierarchy:

```html
<div id="kubernetes-list-page" class="kubernetes-list-page">
  <div class="kubernetes-control-row">
    <select id="kubernetes-context" class="input" aria-label="Kubernetes Context"></select>
    <div class="kubernetes-namespace-control">
      <button id="kubernetes-namespace-toggle" class="btn btn-secondary btn-sm" aria-label="Kubernetes Namespace scope">All Namespaces</button>
      <div id="kubernetes-namespace-menu" class="kubernetes-namespace-menu hidden" aria-label="Namespaces"></div>
    </div>
    <div id="kubernetes-category-tabs" class="kubernetes-category-tabs" role="tablist" aria-label="Resource categories"></div>
  </div>
  <div class="kubernetes-secondary-row">
    <div id="kubernetes-resource-tabs" class="kubernetes-resource-tabs" role="tablist" aria-label="Resource types"></div>
    <label id="kubernetes-custom-resource-control" class="kubernetes-custom-resource-control hidden"><select id="kubernetes-custom-resource-select" class="input" aria-label="Custom Resource Definition"></select></label>
    <input id="kubernetes-resource-search" class="input kubernetes-search-field" type="search" placeholder="Search resources" aria-label="Search loaded resources" spellcheck="false" />
  </div>
  <!-- existing table, empty, permission, error, and loaded-count nodes -->
  <section id="kubernetes-workspace" class="kubernetes-workspace hidden" aria-label="Pod workspace">
    <div id="kubernetes-workspace-tabs" class="kubernetes-workspace-tabs" role="tablist" aria-label="Open Logs and Shell tabs"></div>
    <div id="kubernetes-workspace-pane" class="kubernetes-workspace-pane"></div>
  </section>
</div>
<aside id="kubernetes-detail-drawer" class="kubernetes-detail-drawer hidden" aria-label="Kubernetes resource detail">
  <button id="kubernetes-detail-drawer-scrim" class="kubernetes-detail-drawer-scrim" type="button" aria-label="Close resource detail"></button>
  <section class="kubernetes-detail-drawer-panel">
    <header class="kubernetes-detail-drawer-head">
      <div><h2 id="kubernetes-detail-title" class="section-title">Resource detail</h2><p id="kubernetes-detail-subtitle" class="kubernetes-detail-subtitle"></p></div>
      <div class="kubernetes-detail-drawer-actions"><button id="kubernetes-detail-port-forward" class="btn btn-secondary btn-sm hidden" type="button"><span>Port Forward</span><span id="kubernetes-detail-port-summary"></span></button><button id="kubernetes-detail-yaml-toggle" class="icon-btn" type="button" aria-label="View YAML"></button><button id="kubernetes-detail-close" class="icon-btn" type="button" aria-label="Close resource detail">×</button></div>
    </header>
    <div id="kubernetes-detail-overview" class="kubernetes-detail-drawer-body"></div>
    <pre id="kubernetes-detail-yaml" class="kubernetes-detail-code hidden"></pre>
  </section>
</aside>
```

Retain the existing Port Forward dialog and Port Forward list after the workspace. Remove the old back button, Overview/YAML/Events tab strip, detail-contained logs panel, and `#kubernetes-terminal-drawer`.

Update Tailwind component rules with these layout guarantees:

```css
.app-shell[data-page='kubernetes'] { @apply mx-0 max-w-none px-3 py-3; }
.kubernetes-page { @apply relative h-full min-h-0 min-w-0 gap-2 overflow-hidden p-2; }
.kubernetes-list-page { grid-template-rows: auto auto minmax(160px, 1fr) auto; @apply min-h-0 gap-2 overflow-hidden; }
.kubernetes-control-row { @apply flex min-w-0 items-center gap-1.5 overflow-x-auto; }
.kubernetes-category-tabs { @apply flex min-w-0 flex-1 flex-nowrap gap-1 overflow-x-auto border-0 p-0; }
.kubernetes-secondary-row { @apply flex min-w-0 items-center gap-1.5 overflow-x-auto; }
.kubernetes-detail-drawer-panel { width: clamp(560px, 38vw, 720px); @apply absolute bottom-0 right-0 top-0 grid min-h-0 max-w-full grid-rows-[auto_minmax(0,1fr)] border-l border-zinc-200 bg-white shadow-2xl; }
.kubernetes-detail-drawer-body { @apply min-h-0 overflow-y-auto p-3; }
.kubernetes-workspace { height: min(35dvh, 300px); @apply grid min-h-[180px] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-zinc-200; }
```

At widths below 640px, make the panel `width: min(100%, 560px)` and keep its own vertical scroll. Do not alter Hosts or Proxy max-width behavior.

- [ ] **Step 4: Migrate `KubernetesPage` from full-page detail to overlay drawer**

Remove `Cluster` from `RESOURCE_CATEGORIES`, but leave `isClusterScoped()` and lower-level support intact. Replace `DetailBackStack` with a drawer target/generation record:

```ts
interface DrawerRequest {
  visible: boolean;
  pageGeneration: number;
  drawerGeneration: number;
  uid: string;
}

export function isCurrentKubernetesDrawerRequest(current: DrawerRequest, candidate: DrawerRequest): boolean {
  return current.visible
    && candidate.visible
    && current.pageGeneration === candidate.pageGeneration
    && current.drawerGeneration === candidate.drawerGeneration
    && current.uid === candidate.uid;
}
```

Use one `beginDrawerReplacement()` path for row click and `openRelatedPod()`:

```ts
private beginDrawerReplacement(): number {
  const generation = ++this.detailGeneration;
  this.invalidateRelatedDetail();
  this.activeDetail = undefined;
  this.detailPortForwardButton.disabled = true;
  this.detailPortForwardButton.classList.add('hidden');
  this.detailPortSummary.textContent = '';
  this.detailOverview.replaceChildren();
  this.detailYaml.textContent = '';
  this.detailDrawer.classList.remove('hidden');
  return generation;
}
```

This reset happens before every await, so a stale related-resource transition cannot offer the old Service/Pod Port Forward while the drawer title says that a new Pod is loading. `openDetail()` accepts a new row even when `activeDetail` exists; it does not hide `listPage`, does not reset virtual-table scroll, and only paints a result after `visible`, page generation, drawer generation, query identity, and summary UID still match. `closeDetail()` becomes synchronous local drawer cleanup plus invalidation; it does not close Logs, Shells, or port forwards.

Make `onListChanged()` and `renderList()` always update the virtual table after query checks. Preserve current read-only relation loading but use the same drawer request guard before rendering a relation response.

Render the Pod drawer by consuming `buildKubernetesDrawerModel()` and constructing `dl`, `section`, `button`, and `span` elements. Render generic resources through the existing compact overview helper. Create collapsible Labels and Containers sections with `aria-expanded`; all values use `textContent`. The header YAML icon toggles the `pre` section and renders active-view Secret YAML only into that `pre`, then clears it on every drawer replacement/close. Request Events after a drawer detail becomes current, show `Loading events…`, then append reason/type/time/message/count nodes from the safe Event summary columns; all Event response paths must pass the same drawer guard.

- [ ] **Step 5: Run focused tests and commit the visual drawer/list migration**

Run:

```bash
pnpm build && node --test --test-name-pattern="Kubernetes shell|drawer|detail|eight-column|Custom Resources|virtual table" tests/*.test.js
git diff --check
git add src/renderer/index.html src/renderer/tailwind.css src/renderer/kubernetesPage.ts src/renderer/kubernetesDrawerModel.ts tests/kubernetesRenderer.test.js tests/kubernetesDetailRenderer.test.js
git commit -m "feat: redesign kubernetes resources as drawer workspace"
```

Expected: existing list rows stay visible and update beneath the drawer, Cluster is no longer reachable, and a stale detail/related response cannot repaint or enable an obsolete action.

### Task 5: Connect drawer container actions to persistent multi-tab Logs and Shell workspace

**Files:**
- Modify: `src/renderer/kubernetesPage.ts:733-1068, 1768-2230`
- Modify: `src/renderer/kubernetesWorkspace.ts`
- Modify: `src/renderer/kubernetesTerminal.ts`
- Modify: `src/renderer/index.html:205-332`
- Modify: `src/renderer/tailwind.css:600-750`
- Modify: `tests/kubernetesWorkspace.test.js`
- Modify: `tests/kubernetesRenderer.test.js:1100-1950`
- Modify: `tests/kubernetesDetailRenderer.test.js:300-560`

**Interfaces:**
- Consumes: Task 3 workspace state/controller, existing `window.kubernetesApi` Logs/Terminal IPC functions, and explicit `KubernetesPodTarget` from a drawer container action.
- Produces: multiple closable `logs`/`shell` tabs in `#kubernetes-workspace`, each with exact async ownership.
- Preserves: 500 initial lines, 2,000-line cap, ANSI log rendering, Follow pause/play, search, Clear, xterm exact input, terminal resize, and Context/page shutdown cleanup.

- [ ] **Step 1: Write failing integration tests for explicit actions and lifecycle**

Add tests that assert the old automatic detail log path is gone and the new action targets are exact:

```js
test('drawer container actions open reusable workspace tabs without closing them with the drawer', async () => {
  const page = await readFile(path.join(distRenderer, 'kubernetesPage.js'), 'utf8');
  assert.match(page, /this\.workspace\.openLogs\(container\.target\)/);
  assert.match(page, /this\.workspace\.openShell\(container\.target\)/);
  assert.doesNotMatch(page, /void this\.openLogsForSelectedContainer\(\);/);
  assert.doesNotMatch(page, /closeDetailLogs\(\)/);
});

test('workspace cleanup happens on Kubernetes hide, Context replacement, disconnect, and shutdown-facing deactivation', async () => {
  const { disposeKubernetesWorkspaceSessions } = await import(path.join(distRenderer, 'kubernetesWorkspace.js'));
  const calls = [];
  await disposeKubernetesWorkspaceSessions([
    { type: 'logs', log: { sessionId: 'log-1', namespace: 'apps', podName: 'api', container: 'a', lines: [], following: true, hasOlder: false, revision: 1 } },
    { type: 'shell', terminalId: 'terminal-1' },
  ], {
    closeLogs: async (id) => { calls.push(`log:${id}`); },
    closeTerminal: async (id) => { calls.push(`terminal:${id}`); },
  });
  assert.deepEqual(calls.sort(), ['log:log-1', 'terminal:terminal-1']);
});
```

Add DOM/controller tests for: Logs then Shell on one container produces two tabs; a second click focuses rather than opens a duplicate; a same-named container in a different Pod gets a different tab; closing one tab closes only that remote session; closing the resource drawer leaves all tabs visible.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
pnpm build && node --test tests/kubernetesWorkspace.test.js tests/kubernetesRenderer.test.js tests/kubernetesDetailRenderer.test.js
```

Expected: FAIL because Logs remain detail-owned and terminal sessions use the floating drawer.

- [ ] **Step 3: Render explicit Logs and Shell icon actions from every Pod container**

When rendering a Pod container in the drawer, append two static-icon buttons after the container name:

```ts
const logs = document.createElement('button');
logs.type = 'button';
logs.className = 'icon-btn';
logs.setAttribute('aria-label', `View logs for ${container.name}`);
logs.addEventListener('click', () => { void this.workspace.openLogs(container.target); });

const shell = document.createElement('button');
shell.type = 'button';
shell.className = 'icon-btn';
shell.setAttribute('aria-label', `Open shell for ${container.name}`);
shell.addEventListener('click', () => { void this.workspace.openShell(container.target); });
```

Do not auto-open Logs when a drawer opens and do not retain a drawer-level container selector. Render the container's Status, Image, ImagePullPolicy, Env expander, Mounts, and Command directly beneath its header.

- [ ] **Step 4: Make the workspace the only owner of live Logs and xterm panes**

Instantiate one workspace in `KubernetesPage.show()` after binding the page, with roots `#kubernetes-workspace`, `#kubernetes-workspace-tabs`, and `#kubernetes-workspace-pane`. Pass exact API operations:

```ts
this.workspace = createKubernetesWorkspace({
  root: this.workspaceRoot,
  tabList: this.workspaceTabs,
  pane: this.workspacePane,
  openLogs: (target) => window.kubernetesApi.openLogs(target),
  setLogFollowing: (id, following) => window.kubernetesApi.setLogFollowing(id, following),
  clearLogs: (id) => window.kubernetesApi.clearLogs(id),
  closeLogs: (id) => window.kubernetesApi.closeLogs(id),
  openTerminal: (target) => window.kubernetesApi.openTerminal(target),
  writeTerminal: (id, data) => window.kubernetesApi.writeTerminal(id, data),
  resizeTerminal: (id, cols, rows) => window.kubernetesApi.resizeTerminal(id, cols, rows),
  closeTerminal: (id) => window.kubernetesApi.closeTerminal(id),
  reportError: (error) => setMessage(toErrorMessage(error), 'error'),
});
```

Route all subscriptions directly:

```ts
this.unsubscribeLog = window.kubernetesApi.onLogChanged((state) => this.workspace?.onLogChanged(state));
this.unsubscribeTerminal = window.kubernetesApi.onTerminalChanged((state) => this.workspace?.onTerminalChanged(state));
this.unsubscribeTerminalOutput = window.kubernetesApi.onTerminalOutput((output) => this.workspace?.onTerminalOutput(output));
```

The Logs pane uses a per-tab search input, the existing ANSI conversion helper, a pause/play Follow icon, and Clear. Its auto-scroll scheduler key includes tab ID, log session ID, and revision; a manual upward scroll still returns to bottom on the next newer follow update, while Pause preserves scroll position and Resume immediately scrolls down.

The Shell pane mounts only the selected tab's xterm host. Selecting/opening a Shell tab schedules `fit()`, scrolls it into view, and calls `focus()`. Do not keep an off-screen terminal owner or `#kubernetes-terminal-drawer`.

On individual tab close, mark the tab closed and remove it before invoking the remote close. On an `openLogs`/`openTerminal` result, attach it only if its unique tab instance is still current; otherwise immediately close the returned remote session and discard it. Terminal closed/error broadcasts remove only the exact tab owning that terminal ID; an old close event cannot target a newly opened same-key tab.

Extract the session-close loop so it has a direct pure test seam and never closes the same ID twice:

```ts
export async function disposeKubernetesWorkspaceSessions(
  tabs: Array<Pick<KubernetesWorkspaceTab, 'type' | 'log' | 'terminalId'>>,
  close: { closeLogs(id: string): Promise<void>; closeTerminal(id: string): Promise<void> },
): Promise<void> {
  const logIds = new Set(tabs.flatMap((tab) => tab.type === 'logs' && tab.log ? [tab.log.sessionId] : []));
  const terminalIds = new Set(tabs.flatMap((tab) => tab.type === 'shell' && tab.terminalId ? [tab.terminalId] : []));
  await Promise.all([
    ...[...logIds].map((id) => close.closeLogs(id).catch(() => undefined)),
    ...[...terminalIds].map((id) => close.closeTerminal(id).catch(() => undefined)),
  ]);
}
```

On `hide()`, Context ID change, disconnected state, and `deactivatePage()` start, call `await workspace.dispose()` before dropping the workspace reference. It closes every current log/terminal ID once, clears tab/pane DOM, and leaves explicit port forwards untouched.

- [ ] **Step 5: Run focused tests and commit the live workspace migration**

Run:

```bash
pnpm build && node --test --test-name-pattern="workspace|logs|terminal|Follow|Context|drawer container" tests/*.test.js
git diff --check
git add src/renderer/kubernetesPage.ts src/renderer/kubernetesWorkspace.ts src/renderer/kubernetesTerminal.ts src/renderer/index.html src/renderer/tailwind.css tests/kubernetesWorkspace.test.js tests/kubernetesRenderer.test.js tests/kubernetesDetailRenderer.test.js
git commit -m "feat: add kubernetes logs and shell workspace tabs"
```

Expected: a drawer can close without interrupting tabs, all active tabs have independent target/session ownership, and no terminal/log late event can recreate a closed tab.

### Task 6: Render lazy, searchable active-drawer environment values

**Files:**
- Modify: `src/renderer/kubernetesPage.ts:733-1068, 1667-2050`
- Modify: `src/renderer/kubernetesDrawerModel.ts`
- Modify: `src/renderer/tailwind.css:458-705`
- Modify: `tests/kubernetesDrawerModel.test.js`
- Modify: `tests/kubernetesWorkspace.test.js`
- Modify: `tests/kubernetesRenderer.test.js:500-900`

**Interfaces:**
- Consumes: `window.kubernetesApi.getPodContainerEnvironment(target)` and Task 2's short-lived `KubernetesPodEnvironment` model.
- Produces: a collapsed-by-default Env section per container with local search over that one model.
- Clears: resolved environment values before drawer replacement/close, container replacement, Context transition, page hide, disconnect, and shutdown-facing deactivation.

- [ ] **Step 1: Write failing lazy Env behavior tests**

Add unit-level lifecycle tests around pure guards exported from `kubernetesPage.ts`:

```js
test('drawer Env completion applies only to its current drawer generation and target', async () => {
  const { isCurrentKubernetesEnvironmentRequest } = await import(path.join(distRenderer, 'kubernetesPage.js'));
  const target = { namespace: 'apps', podName: 'api', container: 'api' };
  assert.equal(isCurrentKubernetesEnvironmentRequest({ visible: true, drawerGeneration: 7, target }, { visible: true, drawerGeneration: 7, target }), true);
  assert.equal(isCurrentKubernetesEnvironmentRequest({ visible: true, drawerGeneration: 7, target }, { visible: true, drawerGeneration: 8, target }), false);
});
```

Add renderer source/DOM tests that the Env section starts collapsed, sends one request only on first expansion, has an `aria-label="Search environment"` input after data arrives, renders values via `textContent`, uses the fixed `No permission to read referenced Secret` message, and removes old environment DOM/state on drawer close/replacement.

- [ ] **Step 2: Run focused tests to verify they fail**

Run:

```bash
pnpm build && node --test tests/kubernetesDrawerModel.test.js tests/kubernetesRenderer.test.js tests/kubernetesPodEnvironment.test.js
```

Expected: FAIL because the drawer has no active-container Env loader or search state.

- [ ] **Step 3: Add short-lived drawer Env state and a guarded lazy request**

Add only this page-local state shape:

```ts
interface DrawerEnvironmentState {
  target: KubernetesPodTarget;
  drawerGeneration: number;
  loading: boolean;
  expanded: boolean;
  search: string;
  result?: KubernetesPodEnvironment;
  error?: 'permission' | 'unavailable';
}
```

Create `clearDrawerEnvironment()` that replaces the state with `undefined` and removes the corresponding DOM nodes. Invoke it at the start of `beginDrawerReplacement()`, on `closeDetail()`, `hide()`, Context transition/disconnect handling, and before a container panel is removed.

When the user expands an Env section, create `DrawerEnvironmentState` with the current `detailGeneration` and exact `container.target`. If it has no result and is not loading, call the narrow API once. Apply a response only when all fields below still match:

```ts
export function isCurrentKubernetesEnvironmentRequest(
  current: { visible: boolean; drawerGeneration: number; target: KubernetesPodTarget },
  candidate: { visible: boolean; drawerGeneration: number; target: KubernetesPodTarget },
): boolean {
  return current.visible === candidate.visible
    && current.visible
    && current.drawerGeneration === candidate.drawerGeneration
    && sameKubernetesPodTarget(current.target, candidate.target);
}
```

An authorization result displays exactly `No permission to read referenced Secret` above the safe declaration entries. A transport failure displays exactly `Unable to load environment` and invokes the existing Context error path without including the original message in a toast. The renderer never serializes or logs the response.

- [ ] **Step 4: Render Env entries and local search safely**

On expansion, append a local search input and a list. Filter only `state.result.entries` using lower-cased name, source, reference, and already-held value; do not send the query over IPC. Render each entry as DOM nodes:

```ts
const row = document.createElement('div');
row.className = 'kubernetes-env-row';
const name = document.createElement('code');
name.textContent = entry.name;
const source = document.createElement('span');
source.textContent = environmentSourceLabel(entry);
const value = document.createElement('pre');
value.textContent = entry.value ?? environmentUnavailableLabel(entry.unavailable);
row.append(name, source, value);
```

Show `Environment values truncated for safe display` when `result.truncated` is true. Keep the section internally scrollable and compact; do not embed it into YAML or a global search index.

- [ ] **Step 5: Run focused tests and commit the active-only Env UI**

Run:

```bash
pnpm build && node --test --test-name-pattern="environment|Env|drawer|Secret" tests/*.test.js
git diff --check
git add src/renderer/kubernetesPage.ts src/renderer/kubernetesDrawerModel.ts src/renderer/tailwind.css tests/kubernetesDrawerModel.test.js tests/kubernetesWorkspace.test.js tests/kubernetesRenderer.test.js
git commit -m "feat: show active kubernetes container environment values"
```

Expected: values appear only after expanding the current drawer container, search remains local, and close/replacement/context changes remove the in-memory model before a late response can paint it.

### Task 7: Update durable documentation and perform complete automated and DevTools verification

**Files:**
- Modify: `README.md:140-168, 189-201`
- Modify: `AGENTS.md:45-62, 107-124, 180-206`
- Modify: `tests/kubernetesRenderer.test.js:1-130`
- Modify: `tests/kubernetesDetailRenderer.test.js`

**Interfaces:**
- Consumes: completed implementation and compiled `dist` tests.
- Produces: accurate user/developer documentation and evidence-backed final verification.

- [ ] **Step 1: Write failing documentation assertions for the durable behavior**

Replace legacy documentation assertions that describe full-page details and the global terminal drawer with checks for these phrases/semantics:

```js
assert.match(document, /full-width.*Kubernetes|Kubernetes.*full-width/i);
assert.match(document, /right-side.*overlay drawer|overlay drawer.*right-side/i);
assert.match(document, /Namespace.*Name.*CPU.*Memory.*Restarts.*Status.*Node.*Age/i);
assert.match(document, /ordinary containers.*resources\.requests|resources\.requests.*ordinary containers/i);
assert.match(document, /multiple.*closable.*Logs.*Shell|Logs.*Shell.*multiple.*closable/i);
assert.match(document, /secretKeyRef.*envFrom.*active drawer|active drawer.*secretKeyRef.*envFrom/i);
assert.match(document, /never.*cache.*settings.*diagnostics.*disk|cache.*settings.*diagnostics.*disk.*never/i);
```

- [ ] **Step 2: Run the documentation tests to verify they fail**

Run:

```bash
pnpm build && node --test tests/kubernetesRenderer.test.js tests/kubernetesDetailRenderer.test.js
```

Expected: FAIL because README/AGENTS still describe full-page detail and the global terminal drawer.

- [ ] **Step 3: Update README and AGENTS without changing safety constraints**

Update both documents to state all of the following exactly:

1. Kubernetes alone uses the available application width; controls are compact, label-free Context/Namespace selectors plus non-wrapping category/resource controls, with no UI Cluster category.
2. The virtual list has `Namespace, Name, CPU, Memory, Restarts, Status, Node, Age`; CPU/Memory are normal-container request aggregates, not limits or live metrics.
3. Resource details are right-side overlay drawers; list Watch/scroll stays active beneath them; drawer labels/Env collapse; YAML is an icon action; Events stay read-only/on-demand.
4. Drawer container icons open/focus multiple closable bottom Logs/Shell tabs keyed by namespace/Pod/container/type. Closing a drawer preserves tabs; Context/page/shutdown cleanup closes them.
5. `secretKeyRef` and `envFrom.secretRef` are decoded only through a main-process narrow active-drawer request; values are bounded, searchable only locally, and never cached/persisted/logged/diagnosed/written to disk.
6. The terminal architecture description names the bottom workspace rather than a global drawer, while preserving exact input and shell fallback rules.

Update the architecture file lists for `podSummary.ts`, `podEnvironment.ts`, `kubernetesDrawerModel.ts`, and `kubernetesWorkspace.ts`; change the description of `kubernetesTerminal.ts` to the reusable xterm pane.

- [ ] **Step 4: Run the complete test suite and static checks**

Run:

```bash
pnpm test
git diff --check
git status --short
```

Expected: `pnpm test` reports all Node tests passing; `git diff --check` has no output; status contains only the planned documentation/test changes before staging.

- [ ] **Step 5: Validate the real Electron app through DevTools**

Build first through the prior test, then launch a disposable profile with remote debugging:

```bash
pnpm exec electron --user-data-dir=/tmp/service-manager-kubernetes-drawer-cdp --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --remote-allow-origins='*' .
```

Using Chrome DevTools Protocol against the Electron renderer, validate the actual configured environment:

1. Select Context `开发环境(外网)`, Namespace `ai-dev`, and Pods; inspect `ai-aigc-lms-ui-56877dd45b-6wv4s`.
2. At 1230×820, confirm Context/Namespace/category controls stay on one compact row, no Cluster tab appears, no visible `Search loaded resources` label exists, and the Kubernetes content expands beyond the shared 1280px center constraint when the window is widened.
3. Confirm all eight table headers and row cells remain single-line. At 900×620, verify horizontal table scrolling and drawer/workspace internal scrolling without document-level overflow.
4. Click the target Pod. Confirm the resource list remains visible behind an approximately 560px right overlay drawer, then inspect Name, Namespace, labels expander, Status, Node, Pod IP, Pod IPs, container Image/Pull Policy/Mounts/Command, YAML icon, and Events.
5. Expand Env. If the target container declares Secret-backed environment, search a decoded value locally and confirm no secret value appears in DevTools console, toast text, loaded list snapshot, or drawer after close. If it has no Secret-backed declaration, use a Pod in the same selected namespace that does; do not alter cluster resources.
6. Open Logs and Shell from a container. Open a second target/type, verify multiple tabs, click the original action again to verify focus/reuse, close the drawer, and verify all tabs remain. Close one tab and verify only its session disappears. Do not execute commands in the shell.
7. With Logs Follow enabled, scroll upward, wait for the next log event, and verify it returns to bottom. Pause and verify new events preserve the scroll position; Resume returns to bottom.
8. Inspect DevTools console for renderer exceptions and unhandled rejections. The known optional local-font `ERR_FILE_NOT_FOUND` fallback probes may appear; do not count them as an application exception.

- [ ] **Step 6: Commit the documentation and final verification state**

Run:

```bash
git add README.md AGENTS.md tests/kubernetesRenderer.test.js tests/kubernetesDetailRenderer.test.js
git commit -m "docs: document kubernetes drawer workspace"
git status --short
git log --oneline -7
```

Expected: the worktree is clean, the final commit documents the new Kubernetes contract, and the prior feature commits are visible in history.

## Plan Self-Review

### Spec coverage

| Approved requirement | Implementing task(s) |
| --- | --- |
| Full-width Kubernetes page, compact one-line controls, no visible Context/Namespace labels, no Cluster | Task 4 |
| Unlabeled search and compact vertical spacing | Task 4 |
| Eight non-wrapping list columns and request aggregation semantics | Task 1 |
| Right-side overlay drawer with basic Pod fields, labels, YAML, container detail, and Events | Tasks 1, 3, and 4 |
| Secret-backed `secretKeyRef` and `envFrom.secretRef` plaintext plus local search | Tasks 2 and 6 |
| Multiple reusable/closable Logs and Shell tabs below list | Tasks 3 and 5 |
| Follow after manual upward scroll and late async-event safety | Tasks 3 and 5 |
| Drawer close preserves workspaces; Context/page/shutdown cleans them | Task 5 |
| Secret non-persistence, local 403 behavior, read-only APIs | Tasks 2 and 6 |
| README/AGENTS, automated tests, real DevTools validation | Task 7 |

### Placeholder scan

The plan has no deferred implementation markers or unspecified error-handling steps. Every implementation task names concrete files, contracts, test cases, commands, expected outcomes, and commit messages.

### Type consistency

- `KubernetesPodEnvironment`, `KubernetesPodEnvironmentEntry`, and `KubernetesPodTarget` are defined in the shared contract before Tasks 2 and 6 consume them.
- `KubernetesLogState.revision` is introduced before Task 3 routes log updates and Task 5 mounts live Log tabs.
- `KubernetesWorkspaceTabType` uses exactly `logs | shell` throughout Task 3 and Task 5.
- `detailGeneration` remains the drawer generation used by `isCurrentKubernetesDrawerRequest` and `isCurrentKubernetesEnvironmentRequest`; neither helper accepts the retired full-page back-stack state.
