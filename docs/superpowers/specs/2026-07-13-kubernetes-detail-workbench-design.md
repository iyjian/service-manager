# Kubernetes Detail Workbench Design

## Goal

Redesign the Kubernetes resource detail page to follow the supplied workbench-style reference, fit entirely within the default `1230×820` Electron window, and make enabled Pod log following keep the viewport pinned to the latest output after a user scrolls upward.

## Constraints

- Keep the UI in English and preserve the existing zinc/white Service Manager visual system.
- At `1230×820`, the Kubernetes page itself must not scroll vertically while a resource detail is open.
- At smaller supported window sizes, fixed detail controls remain usable while Overview, YAML, Events, related-resource content, and Logs scroll inside their own bounded regions.
- Keep Kubernetes operations read-only and continue using `@kubernetes/client-node`; no Kubernetes API or dependency changes are required.
- Keep Pod terminals in the existing global terminal drawer. A detail-page Terminal shortcut may open or focus the drawer but must not embed or duplicate terminal ownership.
- Preserve renderer text safety: Kubernetes-derived values continue to use DOM nodes and `textContent`.
- Preserve current Secret handling, list state restoration, Events, relations, Copy, terminal, and port-forward lifecycle behavior.

## Chosen Approach

Use a single-card Kubernetes detail workbench rather than compressing the current nested cards or embedding xterm inside the detail page. The card is a viewport-bounded grid whose final Logs row consumes the remaining height. Global terminal sessions and active port forwards render as viewport-contained docked or floating layers so they cannot extend the document.

This approach matches the reference closely without changing main-process resource ownership or Kubernetes runtime contracts.

## Layout

The Kubernetes application shell occupies `100dvh` and uses a fixed page header plus a `minmax(0, 1fr)` content row. The Kubernetes page and detail card propagate `height: 100%`, `min-height: 0`, and bounded overflow so body/document scrolling is never needed for the default detail view.

The white detail card contains five vertical regions:

1. A title row with Back to list, the namespace-qualified resource name, Kind subtitle, and Copy.
2. Independent Overview, YAML, and Events tabs with the active tab rendered as a dark pill.
3. A bounded content slot. Overview uses a three-column metadata grid at the default width, with compact single-line label/value rows, a status dot, truncation, and title text for long values. YAML, Events, and expanded related resources scroll within this slot when necessary.
4. For Pods, one inline action row containing the Container label, a flexible select, Open Terminal, and Port Forward. Service actions use the same compact region.
5. For Pods, a Logs workbench that fills all remaining space.

The Logs workbench contains a small view strip, a one-row Search/Follow/Clear toolbar, a black monospace output viewport, and a footer showing filtered/total line counts plus `Live` or `Paused`. Long log lines use `white-space: pre` and scroll horizontally instead of wrapping and consuming vertical space.

At narrower or shorter window sizes, responsive columns may collapse and the bounded content and log output regions scroll internally. The page frame and primary actions remain visible.

The empty global Port Forwards panel is hidden. Active forwards use a viewport-contained layer. The global terminal drawer likewise does not participate in normal document height.

## Log Following Behavior

Opening a Pod detail continues to request the latest 500 lines and enables Follow by default. The main-process buffer remains capped at 2,000 lines.

Renderer behavior is explicit:

- When a matching active log session publishes new lines while `following` is true, render the latest filtered text and move the output viewport to its bottom.
- A user may scroll upward without implicitly disabling Follow. The next incoming log update moves the viewport back to the bottom.
- `Pause Follow` stops the remote follow stream and preserves the current viewport position.
- `Resume Follow` resumes the stream and immediately moves the viewport to the bottom.
- Editing the search query preserves the current viewport position for that synchronous filter render. A later incoming update still moves to the bottom when Follow is enabled.
- Clear empties the current buffer without changing Follow state.

Auto-scroll work is coalesced to the next animation frame. Before applying it, the renderer verifies that the active detail, container, and session still match the render that scheduled it. Closing details or changing containers cancels stale work so an old session cannot scroll a new log view.

The status footer reports actual filtered and total retained line counts. It does not claim a fixed “latest 100 lines” because the application loads 500 initially and retains up to 2,000.

## Error Handling and Safety

- Existing Kubernetes failures continue to use the top-right ten-second toast.
- Missing or opening logs keep the bounded log workbench visible with text-safe status copy.
- All dynamic names, values, Events, YAML, log lines, and statuses continue to be assigned with `textContent` or DOM-node construction.
- Delayed animation-frame callbacks validate active identity and perform no work after detail close, container change, or log-session disposal.
- No kubeconfig path, credential material, Secret data, terminal credential, or transport handle crosses the existing renderer boundary.

## Files and Responsibilities

- `src/renderer/index.html`: restructure the detail/log workbench markup, add local inline icons and the log status footer.
- `src/renderer/tailwind.css`: implement the viewport-bounded grid, single-card presentation, responsive internal scrolling, inline Pod actions, terminal/forward layers, and no-wrap log viewport.
- `src/renderer/kubernetesPage.ts`: render status metadata, manage log auto-scroll scheduling and cancellation, hide empty forward UI, and preserve current behavior elsewhere.
- `tests/kubernetesRenderer.test.js`: cover pure scroll decisions and compiled renderer structure/styles.
- `README.md` and `AGENTS.md`: document the single-screen detail layout and enabled-Follow viewport behavior.

No shared type, dependency manifest, main-process Kubernetes client, runtime, or IPC contract change is planned.

## Testing and Acceptance

Automated checks must demonstrate:

- enabled Follow selects the bottom of the log viewport;
- paused Follow and a search-only render preserve the previous scroll position;
- Resume schedules an immediate scroll to the bottom;
- stale session/container scroll work is ignored or cancelled;
- detail markup contains the workbench/status structure and local icons;
- component CSS bounds the page/detail height, keeps log output internally scrollable and unwrapped, and hides the empty forward panel;
- the complete existing `pnpm test` suite passes.

Manual validation uses the real Electron application and DevTools with Context `开发环境(外网)`, Namespace `ai-dev`, and Pod `ai-aigc-lms-ui-56877dd45b-6wv4s`:

1. At `1230×820`, verify the document has no vertical overflow and all five detail regions are visible.
2. Resize smaller and verify scrolling is confined to the content and Logs regions.
3. With Follow enabled, set the log viewport near the top and wait for a new line; verify it returns to the bottom.
4. Pause, scroll, and wait; verify the position remains stable. Resume and verify it immediately returns to the bottom.
5. Exercise Overview/YAML/Events, search, Clear, Open Terminal, and Port Forward to confirm preserved behavior and safe layout.
