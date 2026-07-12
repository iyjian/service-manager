# Kubernetes Detail UX and Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Kubernetes Namespace selector and Pod detail page compact, aligned, automatically useful, and keyboard-ready while preserving read-only lifecycle boundaries.

**Architecture:** Keep the main-process Kubernetes implementation unchanged. Implement behavior in `kubernetesPage.ts` and `kubernetesTerminal.ts`, restructure only the Kubernetes renderer markup, and isolate visual changes to Kubernetes Tailwind component selectors.

**Tech Stack:** Electron 33, TypeScript, DOM APIs, Tailwind CSS component layer, xterm, Node `node:test` against compiled `dist`.

## Global Constraints

- UI copy remains English.
- Kubernetes resource APIs remain strictly read-only.
- Use `@kubernetes/client-node`; never shell out to `kubectl`.
- Keep Tailwind preflight disabled and keep component styling in `src/renderer/tailwind.css`.
- Kubernetes-derived values use DOM nodes and `textContent`, never `innerHTML`.
- No dependency versions change and no dependency installation is required.
- Update both `README.md` and `AGENTS.md` for the changed runtime/UI behavior.

---

### Task 1: Namespace outside-click dismissal

**Files:**
- Modify: `src/renderer/kubernetesPage.ts`
- Test: `tests/kubernetesRenderer.test.js`

**Interfaces:**
- Produces: `shouldCloseNamespaceMenu(control: Pick<HTMLElement, 'contains'>, target: Node | null): boolean`.

- [ ] **Step 1: Write a failing test** that passes fake controls/targets to `shouldCloseNamespaceMenu` and requires outside targets to return true while inside/null targets return false.
- [ ] **Step 2: Build and run** `node --test tests/kubernetesRenderer.test.js`; expect failure because the export does not exist.
- [ ] **Step 3: Implement the helper** and a document `pointerdown` listener registered once by `ensureBound`; close only when the menu is open and the target is outside the Namespace control.
- [ ] **Step 4: Rebuild and rerun** the renderer test; expect pass.
- [ ] **Step 5: Commit** `tests/kubernetesRenderer.test.js` and `src/renderer/kubernetesPage.ts` with `fix: dismiss Kubernetes namespace menu outside`.

### Task 2: Automatic Pod logs and detail structure

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/kubernetesPage.ts`
- Test: `tests/kubernetesRenderer.test.js`

**Interfaces:**
- `openLogsForSelectedContainer(): Promise<void>` remains the single log-open path.
- A renderer-only `Set<string>` deduplicates pending opens by container.

- [ ] **Step 1: Write failing contract tests** requiring no `kubernetes-log-open`, no buffer-limit copy, the Pod action section before the log panel, and an automatic call to `openLogsForSelectedContainer` after Pod/container selection.
- [ ] **Step 2: Rebuild and run** the renderer test; expect the old markup/behavior assertions to fail.
- [ ] **Step 3: Move Pod actions before Logs**, remove the Open Logs button and explanatory copy, convert search copy to an accessible compact input, and move the global terminal drawer before Port Forwards.
- [ ] **Step 4: Remove obsolete button bindings**, add pending-open deduplication, automatically open logs after selecting/rendering a Pod container, and preserve toast/cleanup behavior.
- [ ] **Step 5: Rebuild and rerun** the renderer test; expect pass.
- [ ] **Step 6: Commit** markup, renderer, and test changes with `feat: open Kubernetes Pod logs by default`.

### Task 3: Terminal focus and visibility

**Files:**
- Modify: `src/renderer/kubernetesTerminal.ts`
- Test: `tests/kubernetesRenderer.test.js`

**Interfaces:**
- `KubernetesTerminalDrawer.open(state)` remains unchanged for callers.

- [ ] **Step 1: Extend the fake DOM/xterm test** with `scrollIntoView` and `focus` counters and require both after opening a session.
- [ ] **Step 2: Rebuild and run** the renderer test; expect the new counters to remain zero.
- [ ] **Step 3: In the first animation frame**, fit, resize, scroll the session into the nearest visible block, and focus xterm.
- [ ] **Step 4: Rebuild and rerun** the renderer test; expect pass.
- [ ] **Step 5: Commit** with `fix: focus visible Kubernetes terminals`.

### Task 4: Kubernetes layout and visual hierarchy

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/kubernetesPage.ts`
- Modify: `src/renderer/tailwind.css`
- Test: `tests/kubernetesRenderer.test.js`

**Interfaces:**
- Overview keeps the existing safe DOM construction; descriptions gain only a display `title` attribute.

- [ ] **Step 1: Add failing compiled-CSS/markup tests** for the list-page class, detail canvas, inline Overview grid columns, zero `dd` margin, no-wrap metadata, 32px aligned Namespace/action controls, and styled related-resource rows.
- [ ] **Step 2: Rebuild and run** the renderer test; expect missing selectors/properties.
- [ ] **Step 3: Add the list-page class and full-value titles**, then implement Kubernetes-scoped spacing, gray detail canvas, white panels, inline metadata rows, control alignment, and related-resource resets/styles.
- [ ] **Step 4: Rebuild and rerun** the renderer test; expect pass.
- [ ] **Step 5: Commit** with `style: refine Kubernetes detail layout`.

### Task 5: Documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Test: `tests/kubernetesRenderer.test.js`

**Interfaces:** None.

- [ ] **Step 1: Add failing documentation assertions** for automatic Pod logs and terminal focus/visibility.
- [ ] **Step 2: Rebuild and run** the renderer test; expect documentation assertions to fail.
- [ ] **Step 3: Update README and AGENTS** with outside-click Namespace behavior, automatic logs, compact inline Overview rows, and visible focused terminal behavior.
- [ ] **Step 4: Run `pnpm test`** and require 0 failures.
- [ ] **Step 5: Launch Electron with DevTools** and verify the exact Context/Namespace/Pod flow; use the existing terminal IPC path to enter `ls -l` and confirm output, without mutating Kubernetes resources.
- [ ] **Step 6: Run `git diff --check` and `git status --short`**, preserve unrelated `.pnpm-store/`, then stage and commit the documentation/final test changes.
