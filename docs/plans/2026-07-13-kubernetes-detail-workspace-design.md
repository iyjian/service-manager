# Kubernetes Detail Workspace Redesign

**Date:** 2026-07-13

## Goal

Redesign the Kubernetes resource detail page to match the compact reference layout while keeping the complete Pod workflow usable inside the application's default 1230×820 window. Smaller windows must scroll within bounded detail regions instead of expanding the overall page.

The redesign also fixes log-follow behavior after manual upward scrolling and moves terminal and port-forward entry points into the detail workspace.

## Verified Example

The design was checked against the real development Context and Pod requested for testing:

- Context: `开发环境(外网)`
- Namespace: `ai-dev`
- Pod: `ai-aigc-lms-ui-56877dd45b-6wv4s`
- Status: `Running`
- Pod IP: `10.244.173.30`
- Container: `aigc-lms-ui`
- Declared TCP port: `3000`, named `http`

At the 1230×820 application window size, these values fit in a single compact metadata strip when the Name column receives the remaining horizontal space.

## Chosen Layout

### Detail header

Keep Back, the resource name, and the Kind label on the left. Replace Copy with a compact Port Forward action on the right.

Port Forward is visible for Pod and Service detail only. Its supporting text summarizes declared ports, for example `1 declared · 3000`. It opens a confirmation dialog and never starts a forward directly from the header.

Remove the separate Pod/Service action rows and remove Open Terminal.

### Resource navigation

Keep the Overview, YAML, and Events tabs and their existing read-only behavior. Removing Copy does not change text-safe YAML rendering.

### Compact overview

Overview contains only:

1. Kind
2. Namespace
3. Status
4. Name
5. Pod IP

Pod IP is read from `status.podIP`. Non-Pod resources omit Pod IP. API Version, Created, Resource Version, and other metadata are no longer rendered in Overview.

The five values use one nowrap row at the default window size. Kind, Namespace, Status, and Pod IP use compact bounded columns; Name owns the flexible column. Values truncate with a `title` containing the complete value. Padding and gaps are reduced. At narrower widths, the strip scrolls horizontally inside its own region instead of wrapping or widening the page.

### Pod runtime workspace

The Pod runtime panel owns the remaining vertical height and contains one toolbar row followed by the log viewport and compact status footer.

Toolbar order:

1. Logs tab
2. Terminal tab
3. Search logs field
4. Pause/Resume Follow icon button
5. Clear
6. Container selector

The toolbar stays on one line. It scrolls horizontally within the runtime panel when the available width is too small.

### Log follow behavior

Following is enabled by default.

- While following, the control displays a pause icon with accessible label `Pause log follow`.
- Pausing changes local follow state synchronously, preserves the current scroll position, and displays a play icon labeled `Resume log follow`.
- Resuming scrolls to the latest line and continues following incoming output.
- A manual upward scroll while follow remains enabled does not permanently detach the viewport. The next appended log batch follows the bottom again.
- Clear remains available on the same toolbar row.

Changing the selected container disposes the previous log stream and opens logs for the new container through the existing bounded 2,000-line viewer lifecycle.

### Terminal tab

Selecting Terminal automatically opens a terminal for the selected Pod and container and opens or focuses the existing global terminal drawer. The drawer remains the owner of terminal sessions, preserving the current lifecycle and multiple-session architecture.

The Terminal tab is active while the matching drawer is being opened. If terminal creation fails, the runtime panel returns to Logs and presents the failure through the normal page toast. Re-selecting Terminal should focus an already-open matching session when possible rather than create accidental duplicates.

### Port discovery and confirmation

Port discovery uses resource detail already available in the renderer. It performs no additional Kubernetes request and no runtime socket scan.

For Pods:

- Read `spec.containers[].ports[]`.
- Include valid integer ports from 1 through 65535 whose protocol is absent or TCP.
- Include restartable native sidecar init containers only when `restartPolicy` is `Always`.
- Exclude ordinary init containers, ephemeral containers, UDP, SCTP, malformed ports, `hostPort`, and `hostIP`.
- Deduplicate by numeric port because Pod containers share a network namespace, while retaining container and port-name provenance for display.

For Services:

- Read valid TCP/default-TCP `spec.ports[].port` values.
- Do not offer `targetPort` or `nodePort` as the Service remote-port choice.

These candidates are declared ports, not proof that a process is listening. Manual entry therefore remains available.

Confirmation dialog behavior:

- Zero candidates: leave Remote Port blank and explain that no TCP port is declared; allow manual entry.
- One candidate: prefill the editable Remote Port input and show its name/container provenance.
- Multiple candidates: show a declared-port selector with no arbitrary default; selecting an option populates the editable Remote Port input. Manual input remains possible.
- Local Port remains optional and auto-allocated when blank.
- Existing active forwards may be annotated but do not create declaration candidates or forbid another local mapping.
- The main process remains authoritative for validation, the ten-forward limit, and lifecycle ownership.

For the verified Pod, the dialog preselects `3000 · http (aigc-lms-ui)`.

## Responsive Behavior

At 1230×820, the detail header, resource tabs, one-line metadata strip, runtime toolbar, log viewport, and status footer fit without document scrolling. The log viewport receives the remaining height.

At smaller window sizes:

- The detail page stays bounded by the application content area.
- Overview and runtime toolbar use internal horizontal scrolling without wrapping.
- YAML, Events, relations, logs, and other tall content use their existing bounded internal vertical scroll regions.
- No control row increases the overall page width.

## Safety and Error Handling

- Kubernetes-derived names, values, port labels, Events, YAML, logs, and terminal output continue to use DOM nodes and `textContent`.
- Terminal and port-forward failures use page toasts or inline modal feedback and do not leave unhandled renderer promises.
- Leaving the detail/page, switching Context, disconnecting, or shutting down preserves existing Watch, log, terminal, and forward disposal rules.
- The Kubernetes API remains read-only; port forwarding and terminal streams retain their existing explicitly allowed interaction model.

## Documentation and Tests

Update README and AGENTS to describe the compact detail workspace, removal of Copy/Open Terminal, terminal-tab behavior, declared-port discovery, and icon-based Follow control.

Add focused tests for:

- Pod and Service TCP candidate extraction, validation, stable ordering, deduplication, provenance, and malformed input.
- Port dialog behavior for zero, one, and multiple candidates.
- Text-safe dynamic candidate labels.
- Pause preserving scroll position and Resume restoring bottom-follow behavior.
- Manual upward scrolling followed by new output while Follow remains enabled.
- Terminal-tab success and failure state transitions.
- Five-field compact overview rendering and Pod IP extraction.
- Default 1230×820 and narrower-window layout through real Electron DevTools inspection.
