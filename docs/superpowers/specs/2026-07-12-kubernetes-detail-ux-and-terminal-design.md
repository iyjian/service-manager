# Kubernetes Detail UX and Terminal Design

## Scope

Improve the existing read-only Kubernetes page without changing its resource model or adding Kubernetes mutations. The work covers Namespace-menu dismissal, Pod detail density, automatic logs, terminal discoverability, and consistent spacing/alignment.

## Chosen approach

Use a focused renderer refinement rather than a full application redesign. A CSS-only change would not solve automatic logs or terminal focus, while a broad redesign would create unnecessary regression risk. The selected approach keeps all existing IPC and Kubernetes runtime boundaries and changes only renderer behavior, local DOM order, and Kubernetes-scoped Tailwind components.

## Interaction behavior

- The Namespace menu remains open while users check multiple entries, but any pointer press outside the Namespace control closes it.
- Pod details start the selected container's log stream automatically. Changing the container automatically opens that container's logs.
- The Pod detail page has no `Open logs` button and does not show buffer-limit explanatory copy. Search remains available as a compact input with an accessible label.
- Opening a terminal keeps the global multi-session drawer model, scrolls the new session into view, fits it, and focuses xterm so typing works immediately.
- Terminal commands still travel through the existing renderer-safe IPC and `@kubernetes/client-node` exec stream. No shell credentials cross IPC.

## Layout and visual hierarchy

- Add an explicit grid/gap layout to the Kubernetes list-page wrapper.
- Keep the required white Kubernetes outer content container, but place resource details on a light zinc canvas with white content panels to avoid a flat all-white page.
- Place the Pod container/action toolbar before Logs and place the global terminal drawer before Port Forwards.
- Render Overview metadata cards as compact single-line label/value rows. Both labels and values use `white-space: nowrap`; long values truncate rather than wrap and retain the full value in a title attribute.
- Normalize Namespace and Pod-action buttons to the same 32px height as selects. Align action buttons to input bottoms.
- Reset native margins for `dl`, `dd`, related headings, and feedback text because Tailwind preflight remains disabled.
- Give related-resource groups and rows explicit local styling so native margins/button appearance cannot disturb alignment.

## Error handling and lifecycle

- Automatic log opening reuses the existing error toast behavior and deduplicates concurrent opens per container.
- Leaving/changing details continues to close all detail-owned log sessions and clears pending renderer state.
- Terminal session cleanup remains unchanged; focus and scrolling occur only after a renderer session is successfully created.
- Namespace outside-click handling is renderer-only and does not change scope persistence or Kubernetes requests.

## Verification

- Add a pure test for outside-click classification.
- Update renderer contract tests to require automatic Logs and absence of the removed copy/button.
- Extend the terminal drawer DOM test to require fit, focus, and scroll-to-session behavior.
- Add compiled CSS assertions for list spacing, single-line Overview rows, aligned controls, and the detail canvas.
- Run `pnpm test`.
- Through Electron DevTools, use Context `开发环境(外网)`, Namespace `ai-dev`, and Pod `ai-aigc-lms-ui-56877dd45b-6wv4s`; confirm the menu closes on outside click, Logs load automatically, metadata stays inline, and `ls -l` produces output in the visible focused terminal.

## Safety

All Kubernetes operations remain read-only except the already-supported interactive Pod exec stream. Verification runs only `ls -l`, which reads the container directory and does not mutate Kubernetes resources or container files.
