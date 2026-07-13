# Kubernetes Detail Workspace Implementation Plan

> **Execution note:** Use `superpowers:subagent-driven-development` to execute this plan task by task in the current session. Apply `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before the final handoff.

**Goal:** Deliver the approved compact Kubernetes detail workspace, reliable Follow behavior, Terminal-tab activation, and declared TCP-port discovery inside the default 1230×820 Electron window.

**Architecture:** Keep Kubernetes API/IPC and main-process lifecycle code unchanged. Add a renderer-only pure detail model for Overview fields and declared-port candidates, then let `kubernetesPage.ts` orchestrate the model, existing log APIs, existing terminal drawer, and existing port-forward dialog. Preserve the global terminal drawer and main-process validation/ten-forward ownership. Use bounded CSS grid tracks and internal overflow for all responsive behavior.

**Tech stack:** Electron 33, TypeScript 5.7, Tailwind CSS 3, local xterm, Node's built-in `node:test`, real Electron DevTools/CDP acceptance testing.

---

## Task 1: Establish the renderer detail model with tests

**Files:**

- Create: `src/renderer/kubernetesDetailModel.ts`
- Create: `tests/kubernetesDetailRenderer.test.js`

### Step 1: Run the baseline

Run:

```bash
pnpm test
```

Expected: the current suite passes before any production change.

### Step 2: Write failing pure-model tests

Add these `node:test` cases to `tests/kubernetesDetailRenderer.test.js`:

```js
test('detectKubernetesForwardPorts extracts stable deduplicated Pod TCP declarations with provenance', async () => {});
test('detectKubernetesForwardPorts extracts Service port values without targetPort or nodePort', async () => {});
test('buildKubernetesPortForwardDialogModel leaves zero blank, prefills one, and requires selection for many', async () => {});
test('formatKubernetesDeclaredPortLabel returns plain display text', async () => {});
test('buildKubernetesOverviewFields returns only Kind Namespace Status Name and Pod IP in order', async () => {});
```

Cover all of these inputs explicitly:

- Pod regular containers in declaration order.
- Missing protocol and `TCP` accepted.
- UDP, SCTP, unknown protocols, strings, fractions, 0, and 65536 rejected.
- `hostPort` and `hostIP` ignored.
- Ordinary init and ephemeral containers ignored.
- `initContainers` accepted only when `restartPolicy === 'Always'`.
- Duplicate numeric Pod ports collapsed while all name/container provenance is retained.
- Service `spec.ports[].port` used; `targetPort` and `nodePort` never become candidates.
- Zero candidates produce a blank editable Remote Port and manual-entry hint.
- One candidate produces an editable prefilled Remote Port.
- Multiple candidates produce a blank Remote Port and visible required selector.
- The real sample values produce exactly Kind `Pod`, Namespace `ai-dev`, Status `Running`, Name `ai-aigc-lms-ui-56877dd45b-6wv4s`, and Pod IP `10.244.173.30`, even when API Version, Created, and Resource Version are present.
- Non-Pod Overview omits Pod IP.

### Step 3: Verify RED

Run:

```bash
pnpm run build:renderer
node --test tests/kubernetesDetailRenderer.test.js
```

Expected: fail because `dist/renderer/kubernetesDetailModel.js` and its exports do not exist.

### Step 4: Implement the smallest pure model

In `src/renderer/kubernetesDetailModel.ts`, add dependency-free defensive helpers:

```ts
export interface KubernetesDeclaredPortSource {
  owner?: string;
  name?: string;
  source: 'container' | 'restartable-init' | 'service';
}

export interface KubernetesDeclaredPort {
  remotePort: number;
  declarations: KubernetesDeclaredPortSource[];
}

export function detectKubernetesForwardPorts(
  detail: Record<string, unknown>,
  targetKind: 'pod' | 'service',
): KubernetesDeclaredPort[];

export function formatKubernetesDeclaredPortLabel(port: KubernetesDeclaredPort): string;

export function buildKubernetesPortForwardDialogModel(
  ports: readonly KubernetesDeclaredPort[],
): {
  remotePort: string;
  selectorVisible: boolean;
  hint: string;
};

export function buildKubernetesOverviewFields(
  detail: Record<string, unknown>,
  fallback: { kind: string; name: string; namespace?: string; status?: string },
): Array<{ label: 'Kind' | 'Namespace' | 'Status' | 'Name' | 'Pod IP'; value: string }>;
```

Use record/array guards, valid integer range 1–65535, stable numeric deduplication, and plain strings only. Do not import Kubernetes client code and do not add IPC fields.

### Step 5: Verify GREEN

Run:

```bash
pnpm run build:renderer
node --test tests/kubernetesDetailRenderer.test.js
```

Expected: all new model tests pass.

### Step 6: Commit

```bash
git add src/renderer/kubernetesDetailModel.ts tests/kubernetesDetailRenderer.test.js
git commit -m "feat: model kubernetes detail ports"
```

---

## Task 2: Replace detail Copy/actions with compact Overview and Port Forward

**Files:**

- Modify: `src/renderer/index.html`
- Modify: `src/renderer/kubernetesPage.ts`
- Modify: `tests/kubernetesDetailRenderer.test.js`
- Modify: `tests/kubernetesRenderer.test.js`

### Step 1: Write failing renderer-contract tests

Add or update tests so they require:

- The detail header contains `#kubernetes-detail-port-forward` and `#kubernetes-detail-port-summary`.
- `#kubernetes-detail-copy`, `#kubernetes-terminal-open`, `#kubernetes-detail-pod-actions`, and `#kubernetes-detail-service-actions` are absent.
- YAML still renders through `serializeKubernetesDetailYaml()` and `textContent`; remove clipboard/copy-helper expectations.
- Overview rendering consumes `buildKubernetesOverviewFields()` and assigns every value through `textContent` plus a full-value `title`.
- The port-forward dialog contains a hidden declared-port field/select and a text-safe hint.
- Renderer candidate options are created with `option.textContent`; candidate data never enters `innerHTML`.
- Port Forward is hidden for unsupported kinds, enabled independently of the selected Pod container, and maps Pod/Service detail to the correct target kind.

### Step 2: Verify RED

Run:

```bash
pnpm run build:renderer
pnpm run copy:renderer
node --test tests/kubernetesDetailRenderer.test.js tests/kubernetesRenderer.test.js
```

Expected: fail on the old Copy/Open Terminal/action-row markup and missing dialog controls.

### Step 3: Restructure the header and dialog markup

In `src/renderer/index.html`:

- Replace Copy with a local inline-SVG Port Forward button.
- Give the button a primary `Port Forward` label and secondary declared-port summary.
- Remove the Pod and Service action sections entirely.
- Add `#kubernetes-port-forward-declared-field`, `#kubernetes-port-forward-declared-port`, and `#kubernetes-port-forward-hint` before the editable Remote Port field.
- Keep Local Port optional and keep the existing submit/cancel controls.

### Step 4: Integrate the pure model in the page controller

In `src/renderer/kubernetesPage.ts`:

- Import the detail-model helpers.
- Replace Copy/action-row element references with one header Port Forward button and summary.
- Delete `copyActiveDetail()` and the now-unused `copyKubernetesDetailYaml()` helper while retaining YAML serialization.
- Render exactly the approved Overview fields.
- Detect Pod/Service candidates from the already-loaded active detail.
- Render a compact header summary: `No declared TCP ports`, `1 declared · 3000`, or `<n> declared`.
- Open the existing confirmation dialog without starting a forward.
- For zero/one/many candidates, apply the tested dialog model.
- Build multi-port options with `document.createElement('option')` and `textContent`.
- Selecting an option populates the editable Remote Port input; manual typing clears the selector.
- Keep manual Remote Port entry and optional Local Port allocation.
- Preflight the renderer-known ten-active-forward limit for feedback, while leaving the main process authoritative.

For the real Pod, the visible candidate text must be `3000 · http (aigc-lms-ui)`.

### Step 5: Verify GREEN

Run:

```bash
pnpm run build:renderer
pnpm run copy:renderer
node --test tests/kubernetesDetailRenderer.test.js tests/kubernetesRenderer.test.js
```

Expected: detail model/markup tests and existing renderer lifecycle tests pass.

### Step 6: Commit

```bash
git add src/renderer/index.html src/renderer/kubernetesPage.ts tests/kubernetesDetailRenderer.test.js tests/kubernetesRenderer.test.js
git commit -m "feat: add declared port forwarding to details"
```

---

## Task 3: Merge the Logs toolbar and make Pause/Resume immediate

**Files:**

- Modify: `src/renderer/index.html`
- Modify: `src/renderer/kubernetesPage.ts`
- Modify: `tests/kubernetesDetailRenderer.test.js`
- Modify: `tests/kubernetesRenderer.test.js`

### Step 1: Write failing Follow and toolbar tests

Require one Pod toolbar containing, in order:

1. Logs tab
2. Terminal tab
3. Search logs
4. Follow icon button
5. Clear
6. Container selector

Add behavior tests:

```js
test('Kubernetes Pause applies local state and cancels queued auto-scroll before follow IPC settles', async () => {});
test('Kubernetes Resume applies local state and schedules bottom follow before IPC settles', async () => {});
test('Kubernetes followed output returns to bottom after manual upward scroll', async () => {});
test('Kubernetes failed Follow mutation rolls the optimistic state back and reports the error', async () => {});
```

Update the viewport harness to assert icon visibility and accessible state instead of button text:

- Following: pause icon shown, play icon hidden, `aria-label`/`title` are `Pause log follow`.
- Paused: play icon shown, pause icon hidden, `aria-label`/`title` are `Resume log follow`.

Use a deferred `setFollowing` promise to prove Pause changes local state and cancels an already queued animation frame before the promise resolves.

### Step 2: Verify RED

Run:

```bash
pnpm run build:renderer
pnpm run copy:renderer
node --test --test-name-pattern='Kubernetes (Pause|Resume|followed output|failed Follow|Pod interactions)' tests/kubernetesRenderer.test.js tests/kubernetesDetailRenderer.test.js
```

Expected: fail because the old toolbar is split and the old handler awaits IPC before changing local follow state.

### Step 3: Merge the toolbar markup

In `src/renderer/index.html`:

- Replace the separate tab row and log header with one `kubernetes-log-toolbar`.
- Move the Container selector into the same row.
- Keep Search and Clear.
- Replace `Pause Follow` text with static local pause/play SVG children inside one icon button.
- Add accessible label/title state; do not add dynamic SVG markup with `innerHTML`.

### Step 4: Implement optimistic Follow orchestration

In `src/renderer/kubernetesPage.ts`:

- Extend the log viewport element boundary with pause/play icon elements and attribute setters.
- Render the icon and accessible label from the current `following` state.
- Extract a small exported `runKubernetesLogFollowToggle()` orchestration seam that:
  1. computes the desired state,
  2. applies it locally and renders `preserve` for Pause or `follow` for Resume,
  3. only then awaits `setLogFollowing`,
  4. reconciles the returned state,
  5. rolls back only if the optimistic state is still current when the request fails.
- Ensure Pause cancels any queued auto-scroll frame immediately and keeps the current `scrollTop`.
- Keep `onLogChanged()` using the `follow` intent so every appended update returns a still-following viewer to the bottom after manual upward scrolling.

### Step 5: Verify GREEN

Run:

```bash
pnpm run build:renderer
pnpm run copy:renderer
node --test tests/kubernetesDetailRenderer.test.js tests/kubernetesRenderer.test.js
```

Expected: toolbar, icon, optimistic mutation, scroll, and existing bounded-log tests pass.

### Step 6: Commit

```bash
git add src/renderer/index.html src/renderer/kubernetesPage.ts tests/kubernetesDetailRenderer.test.js tests/kubernetesRenderer.test.js
git commit -m "fix: make kubernetes log follow immediate"
```

---

## Task 4: Make Terminal a real workspace tab

**Files:**

- Modify: `src/renderer/kubernetesTerminal.ts`
- Modify: `src/renderer/kubernetesPage.ts`
- Modify: `tests/kubernetesDetailRenderer.test.js`
- Modify: `tests/kubernetesRenderer.test.js`

### Step 1: Write failing terminal-tab and drawer tests

Add tests for:

- Clicking/selecting Terminal marks it active before opening.
- An existing exact namespace/Pod/container terminal is focused, scrolled into view, and revealed without another `openTerminal()` call.
- A different container does not match.
- A successful new session opens/focuses the global drawer.
- An open failure returns the workspace to Logs and reports a toast.
- Selecting Logs hides the drawer without closing its sessions.
- Closing/erroring the active matching terminal returns the workspace to Logs when no matching session remains.

Extend the fake xterm drawer test to verify a second focus does not construct a second xterm instance.

### Step 2: Verify RED

Run:

```bash
pnpm run build:renderer
node --test --test-name-pattern='Kubernetes terminal' tests/kubernetesRenderer.test.js tests/kubernetesDetailRenderer.test.js
```

Expected: fail because `KubernetesTerminalDrawer` cannot focus by target or hide without disposal, and the page has no terminal-tab state.

### Step 3: Extend the terminal drawer boundary

In `src/renderer/kubernetesTerminal.ts`:

- Store display-safe terminal state with each session view.
- Add `focusTarget(target: KubernetesPodTarget): boolean`.
- Exact-match namespace, Pod name, and container.
- On match, unhide the drawer, scroll the existing session into view, fit it, and focus xterm.
- Add `hide(): void` that only hides the drawer; it must not close sessions.
- Preserve existing `dispose()`, output text safety, focus-on-open, and resize cleanup.

### Step 4: Add workspace-tab orchestration

In `src/renderer/kubernetesPage.ts`:

- Track `'logs' | 'terminal'` for the active Pod workspace.
- Render tab active classes and `aria-selected` consistently.
- Logs selection hides the drawer and leaves sessions alive.
- Terminal selection marks Terminal active, first calls `focusTarget()`, and opens a new terminal only when no exact session exists.
- Guard duplicate clicks while one exact target is opening.
- If opening fails or the matching terminal finalizes with no replacement, select Logs and show the existing toast feedback.
- Reset the visual tab to Logs when entering another detail while preserving the established page/Context terminal lifecycle.

### Step 5: Verify GREEN

Run:

```bash
pnpm run build:renderer
node --test tests/kubernetesDetailRenderer.test.js tests/kubernetesRenderer.test.js
```

Expected: terminal focus/reuse, hide, error fallback, and existing exact-input/lifecycle tests pass.

### Step 6: Commit

```bash
git add src/renderer/kubernetesTerminal.ts src/renderer/kubernetesPage.ts tests/kubernetesDetailRenderer.test.js tests/kubernetesRenderer.test.js
git commit -m "feat: open pod terminal from detail tab"
```

---

## Task 5: Fit the approved layout and update project documentation

**Files:**

- Modify: `src/renderer/tailwind.css`
- Modify: `tests/kubernetesDetailRenderer.test.js`
- Modify: `tests/kubernetesRenderer.test.js`
- Modify: `README.md`
- Modify: `AGENTS.md`

### Step 1: Write failing layout and documentation contracts

Require:

- A four-track Pod detail grid: header, resource tabs, bounded detail content, remaining-height runtime panel.
- No action-row track.
- A single-line five-field Overview grid with a flexible Name column, reduced gap/padding, nowrap values, minimum width, and internal horizontal overflow.
- A nowrap runtime toolbar with its own horizontal overflow.
- Log output owns remaining runtime height and scrolls vertically.
- The detail page remains `h-full min-h-0 min-w-0 overflow-hidden`.
- The `max-width: 900px` rules preserve four bounded tracks and never wrap Overview or the runtime toolbar.
- README and AGENTS describe only the five Overview fields, icon Follow, Terminal-tab opening, and declared TCP-port selection; they no longer claim Kubernetes detail Copy exists.

### Step 2: Verify RED

Run:

```bash
pnpm run build:renderer
pnpm run copy:renderer
pnpm run build:css
node --test --test-name-pattern='Kubernetes detail|Kubernetes minimum viewport|documentation' tests/kubernetesDetailRenderer.test.js tests/kubernetesRenderer.test.js
```

Expected: fail on the old five-track Pod grid, card grid, split log chrome, and stale Copy documentation.

### Step 3: Implement bounded Tailwind layout

In `src/renderer/tailwind.css`:

- Reduce detail-page padding/gaps while preserving the white content-container style.
- Set the Pod grid to `auto auto minmax(...) minmax(...)` with the log panel receiving the larger fraction.
- Make resource tabs nowrap/internal-scroll when needed.
- Make the Overview wrapper internally horizontally scrollable and give its grid a stable minimum width with compact label/value items.
- Keep Name flexible and all values truncated/nowrap with their `title` fallback.
- Make the merged log toolbar one nowrap/internal-scroll row.
- Reduce fixed log chrome so useful log output remains at narrow heights.
- Remove unused Copy/action-row/Open Terminal rules.
- Preserve viewport-contained terminal and active-forward overlays.

### Step 4: Update README and AGENTS

Document:

- Exactly Kind, Namespace, Status, Name, and Pod IP in compact Overview.
- Pause/play icon semantics and reliable bottom-follow after upward scrolling.
- Terminal tab auto-open/focus through the global drawer; no Open Terminal button.
- Header Port Forward replacing Copy.
- Pod regular/restartable-sidecar declared TCP ports and Service `.port` discovery.
- One-port prefill, multi-port selection, zero-port manual fallback, and the fact that declaration does not prove a listener.
- `src/renderer/kubernetesDetailModel.ts` in the architecture maps.

### Step 5: Run the complete suite

Run:

```bash
pnpm test
git diff --check
```

Expected: all tests pass and no whitespace errors are reported.

### Step 6: Commit

```bash
git add src/renderer/tailwind.css tests/kubernetesDetailRenderer.test.js tests/kubernetesRenderer.test.js README.md AGENTS.md
git commit -m "style: compact kubernetes detail workspace"
```

---

## Task 6: Review the complete implementation

**Files:** all files changed since design commit `b7b04d9`.

### Step 1: Invoke code review

Read and apply `superpowers:requesting-code-review`. Review the complete diff against:

- `docs/plans/2026-07-13-kubernetes-detail-workspace-design.md`
- This implementation plan
- Repository AGENTS constraints

The review must specifically check dynamic-text safety, async Follow races, stale detail/terminal completions, duplicate terminal sessions, malformed port declarations, the ten-forward race boundary, and unrelated regressions.

### Step 2: Address findings test-first

For every accepted finding, add or strengthen a failing regression test first, make the minimum fix, rerun the focused test, and commit the correction. Do not accept speculative changes without reproducing or proving the issue.

### Step 3: Re-run the suite

```bash
pnpm test
git diff --check
```

Expected: all tests pass.

---

## Task 7: Verify with the real Electron app and DevTools

### Step 1: Start the built app at its default window size

Launch Electron with an isolated user-data directory and a remote-debugging port. Confirm the BrowserWindow outer bounds are exactly 1230×820.

### Step 2: Inspect the requested live resource

Using Electron's real DevTools/CDP target, navigate to:

- Context: `开发环境(外网)`
- Namespace: `ai-dev`
- Pod: `ai-aigc-lms-ui-56877dd45b-6wv4s`

Verify in the live DOM and visually:

- No Copy or Open Terminal button exists.
- Kind, Namespace, Status, Name, and Pod IP are the only Overview values and share one row.
- The values are `Pod`, `ai-dev`, `Running`, `ai-aigc-lms-ui-56877dd45b-6wv4s`, and `10.244.173.30`.
- Header summary reports `1 declared · 3000`.
- Port Forward opens a confirmation dialog with editable Remote Port `3000` and plain-text label `3000 · http (aigc-lms-ui)`; do not submit a real forward merely to validate detection.
- Logs, Terminal, Search, Follow, Clear, and Container share one toolbar row.
- Manual upward scroll followed by new output returns to bottom while Follow is enabled.
- Pause immediately holds the current position and displays play; Resume returns to bottom and displays pause.
- Terminal selection opens and focuses a real xterm session; reselecting focuses it without a duplicate; close the test session afterward.
- The detail document itself does not scroll at 1230×820 and the log viewport has useful remaining height.

### Step 3: Verify a smaller window

Use DevTools window bounds to reduce the window below the default size. Verify:

- The document does not gain horizontal overflow.
- Overview and the runtime toolbar remain one row and scroll only inside their own regions.
- Tall content and logs scroll vertically inside bounded regions.
- Restore 1230×820 before closing the app.

### Step 4: Inspect screenshots and console

Capture default and narrow screenshots, inspect them visually, and confirm there are no renderer errors or unhandled promise rejections in the DevTools console.

### Step 5: Final verification gate

Read and apply `superpowers:verification-before-completion`, then run fresh:

```bash
pnpm test
git diff --check
git status --short --branch
git log --oneline -7
```

Expected: complete suite passes, working tree is clean, and the implementation commits are present directly on `main`.
