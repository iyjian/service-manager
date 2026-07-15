# Kubernetes Workspace Terminal Retention Design

## Goal

Keep every open Kubernetes Shell tab's xterm scrollback and prompt intact while
the user switches between Logs and Shell tabs, while refining the workspace tab
and Pod drawer container-action visual hierarchy.

## Confirmed UI Direction

- Logs tabs use an amber treatment; Shell tabs use blue.
- The visible tab caption contains only `namespace/pod · container`. It does
  not spell out `Logs` or `Shell`; the exact type remains available through
  accessible labels.
- The close control belongs inside the colored tab surface and uses a local
  inline SVG close icon instead of a text `×` glyph or a detached divider.
- In a Pod drawer, a container name begins at the same left edge as the
  `Containers` section content. The colored Logs and Shell actions immediately
  follow the name (amber and blue respectively), while the container kind stays
  on the far right.

## Root Cause

`renderLogPane()` currently calls `releaseTerminalPane()`, which invokes
`terminalPane.dispose()`. The pane disposes the selected xterm instance and
removes its DOM host. Switching back to that still-open remote Shell session
creates a brand-new xterm with no prompt or scrollback to replay. Output that
arrives while a Logs tab is selected is also ignored because the old pane only
accepts the one currently mounted terminal ID.

The main process deliberately does not cache terminal output, so shifting the
history to a main-process or persistent cache would expand sensitive-output
lifetime and violate the current ownership model.

## Terminal View Ownership

`createKubernetesTerminalPane()` will own an in-memory view map keyed by exact
remote terminal ID.

- `prepare(state)` creates an xterm host and xterm instance once a terminal is
  owned, even if that tab is not selected yet. It does not fit or resize a
  detached view.
- `mount(state, host)` re-parents that exact existing host into the selected
  Shell pane, attaches its resize listener, fits it, and focuses it. It never
  recreates a view for a still-open ID.
- Switching to Logs or another Shell tab calls `detach()`: it removes the
  active resize listener and detaches only the DOM host, retaining the xterm
  object and its own bounded xterm scrollback in renderer memory.
- `write(output)` looks up the exact terminal ID in the retained view map, so
  active and background Shell tabs accumulate their own output without
  cross-session delivery.
- Closing a Shell tab, receiving its final state, or disposing the Kubernetes
  workspace destroys only that exact view. Those paths tombstone the ID so a
  late output or final event cannot revive it.

This supports more than one Shell tab. It does not persist terminal data, add
an IPC history API, or change remote terminal/session ownership.

## Renderer Changes

### Workspace tabs

`kubernetesWorkspace.ts` adds a target-only caption helper, retains the
existing type-bearing label for ARIA, applies a type class to each tab wrapper,
and creates the close SVG through DOM APIs. The selected tab semantics and
individual close lifecycle remain unchanged.

### Pod drawer containers

`kubernetesPage.ts` groups the name and action buttons into a single leading
flex row. The Containers content receives a dedicated compact class that
removes accidental nested horizontal padding. Logs and Shell actions receive
semantic classes, so Tailwind applies the same amber/blue palette as workspace
tabs without relying on dynamic Kubernetes values.

## Safety and Lifecycle Constraints

- Kubernetes-derived values remain DOM `textContent`; no dynamic HTML is
  introduced.
- Terminal output remains renderer-memory-only and is released on individual
  tab close, Context change, page leave, disconnect, and application shutdown.
- Hidden/detached terminals never issue resize requests, avoiding accidental
  zero-column/zero-row PTY resizes.
- Existing exact terminal-ID ownership and late-final tombstones remain in
  force.

## Tests and Acceptance

Add focused tests that use a fake xterm and re-parenting fake DOM:

1. Open Shell A, receive a prompt, switch to Logs, receive background output,
   and return to Shell A. Assert the same xterm instance holds both chunks and
   has not been disposed.
2. Open Shell A and Shell B, send output to A while B is active, then return to
   A. Assert each view receives only its matching terminal ID.
3. Close a background Shell tab and verify its exact xterm is disposed once and
   late output cannot recreate it.
4. Assert tabs display target-only captions, retain accessible type labels,
   render an SVG close icon, and expose their type styling hooks.
5. Assert the drawer source retains DOM/text-safe rendering and applies the
   compact Containers/action styling hooks.

Run `pnpm test`, `git diff --check`, and validate the running Electron app with
DevTools using Context `开发环境(外网)`, Namespace `ai-dev`, and a live Pod:

- Open a Shell, wait for its prompt, open Logs, switch repeatedly, and verify
  the prompt plus subsequent background Shell output remain visible.
- Open two Shells and verify independent prompts/output after tab changes.
- Confirm tab colors/captions/close controls and aligned, adjacent drawer
  container actions at 1230×820 and a reduced window size.
