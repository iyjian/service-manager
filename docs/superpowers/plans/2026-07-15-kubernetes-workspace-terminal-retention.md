# Kubernetes Workspace Terminal Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve each open Kubernetes Shell tab's xterm prompt and scrollback across Logs/Shell switches, and make workspace tabs plus Pod-drawer container actions compact, integrated, and type-colored.

**Architecture:** Keep xterm objects only in renderer memory, retaining a separate terminal view for each exact remote terminal ID. An inactive view detaches its DOM host and resize listener rather than being disposed; returning to its Shell reparents that same host. The workspace owns exact-tab cleanup, while the drawer supplies compact semantic styling hooks for adjacent Logs/Shell action icons.

**Tech Stack:** Electron renderer TypeScript, local `@xterm/xterm`, DOM APIs, Tailwind component CSS, Node built-in `node:test`.

---

## Constraints

- Work directly on `main`; the user authorized edits, staging, and commits.
- Do not add dependencies or modify the read-only Kubernetes main-process API.
- Terminal output remains only in renderer/xterm memory. Never add main-process history, disk cache, settings, diagnostic logging, or dynamic HTML.
- Only the visibly mounted Shell may issue a terminal resize.
- Close, final, Context/page-dispose, disconnect, and shutdown remove only the exact terminal view and block late output revival.
- Update `README.md` and `AGENTS.md`; run `pnpm test`, `git diff --check`, and real Electron DevTools validation.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/renderer/kubernetesTerminal.ts` | Retained exact-ID xterm views, detach/mount, output routing, and final cleanup. |
| `src/renderer/kubernetesWorkspace.ts` | Shell preparation, exact view removal, target-only tab captions, and close SVG. |
| `src/renderer/kubernetesPage.ts` | Compact Container name/action leading group and semantic action classes. |
| `src/renderer/tailwind.css` | Amber Logs / blue Shell tabs and actions, integrated close control, and aligned container content. |
| `tests/kubernetesWorkspace.test.js` | Fake DOM/xterm prompt retention, background routing, multi-shell isolation, and tab semantics. |
| `tests/kubernetesDetailRenderer.test.js` | Drawer DOM safety and compact action hooks. |
| `tests/kubernetesRenderer.test.js` | Tailwind palette/integrated-close contract. |
| `README.md`, `AGENTS.md` | Persistent terminal-ownership and visual behavior documentation. |

### Task 1: Write a failing retained-xterm regression test

**Files:**
- Modify: `tests/kubernetesWorkspace.test.js`

- [ ] **Step 1: Make the fake DOM reparent correctly**

Replace `FakeElement.appendChild()` so a retained host is removed from its prior parent before it is appended. Add `document.createElementNS` in `withWorkspaceDom()`:

```js
appendChild(child) {
  if (child.parentElement && child.parentElement !== this) {
    const index = child.parentElement.children.indexOf(child);
    if (index >= 0) child.parentElement.children.splice(index, 1);
  }
  child.parentElement = this;
  this.children.push(child);
  return child;
}

global.document = {
  createElement: (tagName) => new FakeElement(tagName),
  createElementNS: (_namespace, tagName) => new FakeElement(tagName),
};
```

- [ ] **Step 2: Add an xterm fake used only by the new regression**

Install `window.Terminal` and `window.FitAddon` before constructing the workspace:

```js
class FakeTerminal {
  static instances = [];
  constructor() {
    this.cols = 80;
    this.rows = 24;
    this.writes = [];
    this.disposed = false;
    FakeTerminal.instances.push(this);
  }
  loadAddon() {}
  open(host) { this.host = host; }
  onData(listener) { this.onDataListener = listener; return { dispose() {} }; }
  write(data) { this.writes.push(data); }
  focus() { this.focused = true; }
  dispose() { this.disposed = true; }
}
class FakeFitAddon { fit() {} }
window.Terminal = FakeTerminal;
window.FitAddon = { FitAddon: FakeFitAddon };
```

- [ ] **Step 3: Add the failing Shell → Logs → Shell test**

Add a test named `workspace retains exact xterm views across Logs and independent Shell tabs`. Fake APIs return `terminal-api` for `apps/api`, `terminal-api-2` for `apps/api-2`, and a normal `KubernetesLogState` for Logs.

```js
await workspace.openShell(target);
const first = FakeTerminal.instances[0];
workspace.onTerminalOutput({ id: 'terminal-api', data: '# ' });

await workspace.openLogs(target);
workspace.onTerminalOutput({ id: 'terminal-api', data: 'echo retained\r\n' });
findByAriaLabel(tabList, 'Shell apps/api · web').listeners.get('click')();

assert.equal(FakeTerminal.instances.length, 1);
assert.equal(first.disposed, false);
assert.deepEqual(first.writes, ['# ', 'echo retained\r\n']);
```

Then open `apps/api-2` Shell, send one exact-ID output to each while the second Shell is active, return to `apps/api`, and assert the two FakeTerminal write arrays remain separate. Close the first Shell, assert it is disposed, send late output for `terminal-api`, and assert no write is added.

- [ ] **Step 4: Add tab semantics assertions**

Before closing the first Shell:

```js
const select = findByAriaLabel(tabList, 'Shell apps/api · web');
assert.equal(select.textContent, 'apps/api · web');
assert.equal(select.parentElement.classList.contains('kubernetes-workspace-tab-shell'), true);
const close = findByAriaLabel(tabList, 'Close Shell apps/api · web');
assert.equal(close.children[0].tagName, 'SVG');
```

- [ ] **Step 5: Verify the focused test fails**

Run:

```bash
pnpm build && node --test tests/kubernetesWorkspace.test.js
```

Expected: FAIL because the Logs render path disposes the old xterm and the visible caption currently contains `Shell`.

### Task 2: Retain terminal views by exact ID

**Files:**
- Modify: `src/renderer/kubernetesTerminal.ts`
- Modify: `src/renderer/kubernetesWorkspace.ts`
- Test: `tests/kubernetesWorkspace.test.js`

- [ ] **Step 1: Expand the terminal-pane contract**

Replace the current one-view interface with:

```ts
export interface KubernetesTerminalPane {
  prepare(state: KubernetesTerminalState): boolean;
  mount(state: KubernetesTerminalState, host: HTMLElement): boolean;
  detach(): void;
  focus(): boolean;
  write(output: KubernetesTerminalOutput): boolean;
  finalize(state: Pick<KubernetesTerminalState, 'id' | 'state'>): boolean;
  remove(id: string): boolean;
  dispose(): void;
}
```

- [ ] **Step 2: Replace the single `view` with retained exact-ID views**

Inside `createKubernetesTerminalPane()`, use:

```ts
const finalizedIds = new Set<string>();
const views = new Map<string, TerminalPaneView>();
let activeId: string | undefined;
let focusGeneration = 0;

const detachActive = (): void => {
  const current = activeId ? views.get(activeId) : undefined;
  activeId = undefined;
  if (!current) return;
  window.removeEventListener('resize', current.resize);
  current.host.remove();
};

const destroy = (id: string): boolean => {
  const current = views.get(id);
  if (!current) return false;
  if (activeId === id) detachActive();
  window.removeEventListener('resize', current.resize);
  current.terminal?.dispose();
  current.host.remove();
  views.delete(id);
  return true;
};
```

Build an `ensure(state)` helper that updates an existing view or creates one detached `kubernetes-terminal-host`, xterm, fit addon, data handler, and resize closure once. The closure returns unless `activeId === state.id`, then fits and invokes `onResize` only for positive cols/rows. A missing xterm runtime appends the existing unavailable message and still returns a retained view.

- [ ] **Step 3: Implement public lifecycle semantics**

Implement:

```ts
prepare(final state) => finalize(final state)
prepare(open state) => ensure it unless the ID is tombstoned
mount(open state, host) => prepare, detach a different active view, append cached host, add resize listener, set activeId
write(output) => use views.get(output.id), reject missing/tombstoned IDs, then terminal.write(output.data)
finalize(final state) => tombstone then destroy only that ID
remove(id) => tombstone then destroy only that ID
dispose() => invalidate scheduled focus and destroy all views
```

`focus()` must only fit, scroll, and focus the current `activeId`. `detach()` must not dispose a terminal.

- [ ] **Step 4: Update workspace lifecycle wiring**

In `src/renderer/kubernetesWorkspace.ts`:

1. Rename `releaseTerminalPane` to `detachTerminalPane` and make it call `terminalPane.detach()`.
2. Use detachment when rendering Logs, no selected tab, or another Shell. Reserve `terminalPane.dispose()` for full workspace disposal.
3. In `openShell()`, after `terminalStates.set`, call `terminalPane.prepare(terminal)` before render. If it fails, close only that local tab and its deduplicated remote terminal ID.
4. In `onTerminalChanged()`, call `terminalPane.prepare(next)` after setting an owned non-final terminal so a newly backgrounded Shell receives output.
5. In `closeTab()`, pair `terminalStates.delete(tab.terminalId)` with `terminalPane.remove(tab.terminalId)` before render.
6. Keep `onTerminalOutput()` as direct exact-ID `terminalPane.write(output)` routing.

- [ ] **Step 5: Run focused test**

```bash
pnpm build && node --test tests/kubernetesWorkspace.test.js
```

Expected: PASS. The first xterm survives a Logs switch, background output is retained, two Shells remain isolated, and a closed ID cannot receive late output.

- [ ] **Step 6: Commit the behavior**

```bash
git add src/renderer/kubernetesTerminal.ts src/renderer/kubernetesWorkspace.ts tests/kubernetesWorkspace.test.js
git commit -m "fix: retain kubernetes shell tabs across workspace switches"
```

### Task 3: Implement compact tab and Container action styling

**Files:**
- Modify: `src/renderer/kubernetesWorkspace.ts`
- Modify: `src/renderer/kubernetesPage.ts`
- Modify: `src/renderer/tailwind.css`
- Modify: `tests/kubernetesDetailRenderer.test.js`
- Modify: `tests/kubernetesRenderer.test.js`

- [ ] **Step 1: Add target-only visible tab captions and SVG close icon**

Keep `tabLabel()` for ARIA. Add `tabCaption()` returning `namespace/pod · container`. In `renderTabs()`:

```ts
item.className = `kubernetes-workspace-tab kubernetes-workspace-tab-${tab.type}`;
select.setAttribute('aria-label', tabLabel(tab));
select.textContent = tabCaption(tab);
close.appendChild(createWorkspaceCloseIcon());
```

`createWorkspaceCloseIcon()` uses `document.createElementNS`, `viewBox="0 0 16 16"`, `currentColor` stroke, and path `m4 4 8 8m0-8-8 8`. Preserve the existing accessible `Close Logs...` / `Close Shell...` label.

- [ ] **Step 2: Group the Container name and actions**

At the start of the Containers callback in `src/renderer/kubernetesPage.ts`:

```ts
content.classList.add('kubernetes-drawer-containers-content');
```

Replace the flat heading content with:

```ts
const primary = document.createElement('div');
primary.className = 'kubernetes-drawer-container-primary';
logs.className = 'icon-btn kubernetes-drawer-container-action-logs';
shell.className = 'icon-btn kubernetes-drawer-container-action-shell';
actions.append(logs, shell);
primary.append(name, actions);
head.append(primary, kind);
```

Preserve all current ARIA labels, titles, event handlers, targets, and `textContent` rendering.

- [ ] **Step 3: Add the shared amber/blue Tailwind rules**

Use these component rules, retaining `min-w-0`/truncate for the dynamic name and no `border-l` on close:

```css
.kubernetes-workspace-tab-logs { @apply border-amber-200 bg-amber-50 text-amber-800; }
.kubernetes-workspace-tab-shell { @apply border-blue-200 bg-blue-50 text-blue-800; }
.kubernetes-workspace-tab-logs:has(.kubernetes-workspace-tab-select[aria-selected='true']) { @apply border-amber-300 bg-amber-100; }
.kubernetes-workspace-tab-shell:has(.kubernetes-workspace-tab-select[aria-selected='true']) { @apply border-blue-300 bg-blue-100; }
.kubernetes-workspace-tab-close { @apply h-8 w-7 rounded-none border-0 bg-transparent text-inherit hover:bg-black/5 hover:text-inherit; }
.kubernetes-workspace-tab-close svg { @apply h-3 w-3; }

.kubernetes-drawer-containers-content { @apply gap-0 p-0; }
.kubernetes-drawer-container { @apply gap-2 rounded-none border-x-0 border-b-0 p-2.5; }
.kubernetes-drawer-container-primary { @apply flex min-w-0 flex-1 items-center gap-1; }
.kubernetes-drawer-container-actions { @apply inline-flex shrink-0 items-center gap-0.5; }
.kubernetes-drawer-container-action-logs { @apply border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 hover:text-amber-900 focus-visible:ring-amber-300; }
.kubernetes-drawer-container-action-shell { @apply border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:text-blue-900 focus-visible:ring-blue-300; }
```

- [ ] **Step 4: Add source safety/style tests**

Extend `tests/kubernetesDetailRenderer.test.js` to assert:

```js
assert.match(drawer, /content\.classList\.add\('kubernetes-drawer-containers-content'\)/);
assert.match(drawer, /primary\.className = 'kubernetes-drawer-container-primary'/);
assert.match(drawer, /logs\.className = 'icon-btn kubernetes-drawer-container-action-logs'/);
assert.match(drawer, /shell\.className = 'icon-btn kubernetes-drawer-container-action-shell'/);
assert.match(drawer, /primary\.append\(name, actions\)/);
assert.match(drawer, /head\.append\(primary, kind\)/);
assert.doesNotMatch(drawer, /innerHTML/);
```

In `tests/kubernetesRenderer.test.js`, read `tailwind.css` and assert the amber/blue tab selectors, `text-inherit` close rule, absence of `border-l` within that close rule, compact Containers content selector, and matching drawer action selectors.

- [ ] **Step 5: Run renderer-focused tests**

```bash
pnpm build && node --test tests/kubernetesWorkspace.test.js tests/kubernetesDetailRenderer.test.js tests/kubernetesRenderer.test.js
```

Expected: PASS. Target-only captions, accessible type labels, SVG close control, DOM-safe drawer implementation, and matching color hooks are covered.

- [ ] **Step 6: Commit UI changes**

```bash
git add src/renderer/kubernetesWorkspace.ts src/renderer/kubernetesPage.ts src/renderer/tailwind.css tests/kubernetesDetailRenderer.test.js tests/kubernetesRenderer.test.js
git commit -m "feat: polish kubernetes workspace tabs and container actions"
```

### Task 4: Document and validate

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update durable docs**

In both Kubernetes behavior sections, state that each Shell owns a renderer-memory xterm view and scrollback while inactive, accepts exact-session background output, and is destroyed only on tab close, Context/page cleanup, disconnect, or shutdown. Document target-only visible captions, accessible type labels, amber Logs / blue Shell tabs, and matching drawer action colors.

Update both architecture bullets for `kubernetesTerminal.ts` to say it owns retained exact-session bottom-workspace xterm views.

- [ ] **Step 2: Run automated verification**

```bash
pnpm test
git diff --check
git status --short
```

Expected: all Node tests pass, whitespace check is silent, and only intended documentation files remain before the documentation commit.

- [ ] **Step 3: Validate in actual Electron DevTools**

Use Context `开发环境(外网)`, Namespace `ai-dev`, and a live Pod:

1. Open Shell and wait for its prompt.
2. Open Logs, switch at least three times, and ensure the original prompt remains.
3. Open a second Shell, alternate both Shell tabs, and verify their output does not mix.
4. At 1230×820 and a reduced viewport, inspect target-only captions, integrated close icons, amber Logs / blue Shell colors, and left-aligned adjacent Container actions.
5. Check DevTools console for renderer exceptions and unhandled rejections.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md AGENTS.md
git commit -m "docs: describe retained kubernetes shell workspace views"
git status --short
```

Expected: clean worktree.

## Self-Review

- **Spec coverage:** Task 2 resolves prompt/scrollback loss, exact background delivery, multiple Shell support, and exact cleanup. Task 3 implements all requested visual changes. Task 4 covers documentation, full tests, and real DevTools validation.
- **Placeholder scan:** Every task names concrete files, operations, test shape, commands, and expected output.
- **Type consistency:** `prepare`, `detach`, `remove`, `mount`, `write`, `finalize`, and `dispose` are defined and used with identical names; DOM/CSS action class names match exactly.

