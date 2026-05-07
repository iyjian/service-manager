# Service Manager (Electron + TypeScript)

Desktop service manager for remote servers over SSH.

Service Manager uses a host-centric Electron UI with a `TypeScript + tsc build + dist runtime` workflow.

## Design And Workflow

- Engineering style: `TypeScript + tsc build + dist runtime`
- Electron startup pattern: build first, then run Electron from `dist`
- UI interaction pattern:
  - brand header with quick actions
  - grouped list/table by Host
  - `Add/Edit Host` via modal dialog
  - add/remove services inside the host modal
- App UI language: English labels and actions

## Core Features

1. Host list with SSH connection settings.
   - supports optional `Jump Servers` chain configuration directly in Add/Edit Host form (no separate entry page/button)
   - older configs with a single legacy `jumpHost` are still read as a one-hop chain
   - host creation only requires host name and SSH connection info; forwarding rules and services are both optional
   - Add/Edit Host keeps `Save Host` / `Reset` / `Cancel` visible in a sticky footer while long configurations scroll
   - page header shows the local app logo plus the current app version when update state is available
   - home-page host blocks include a `Copy` action that writes the host config JSON to clipboard
   - Add Host dialog includes `Paste Config`, which reads one host config from clipboard and fills the form without auto-saving
   - user-facing buttons use local inline SVG icons matched to their actions, so recognition improves without introducing remote icon dependencies
   - host dialog validation/import errors are surfaced inside the dialog itself, and page-level success/error notices use right-top toast messages that auto-dismiss after a short delay while still allowing manual close
   - default desktop window size is `1230 x 820`, with minimum size kept at `900 x 620`
2. Per-host configuration now has **two independent lists**:
   - `Forwarding Rules` (tunnel rules)
   - `Services` (remote process lifecycle)
   - both lists start empty in Add/Edit Host; the dialog does not insert placeholder rows by default
   - forwarding-rule and service editors use compact summary rows by default; click a row to expand its full editor
   - empty editor sections show explicit empty states
3. Forwarding rule fields:
   - optional rule name (shown in the home-page tunnel list when present; older configs without it still work)
   - local host / local port
   - remote host / remote port
   - auto start
4. Service fields:
   - service name
   - start command
   - start command is edited in a full-width multi-line textarea inside the host dialog, so long shell commands remain readable and editable
   - exposed port (`0` means not exposed)
   - forward local port (optional; if empty, no local forwarding is created)
5. Service status in panel is managed through remote `systemd --user` transient units:
   - `active` -> `running`
   - `inactive` or missing unit -> `stopped`
   - while start/stop command is in progress: `starting` / `stopping`
   - start flow uses `systemd-run --user` and returns as soon as `MainPID` is available; port-listen/forward checks are handled asynchronously by refresh cycle.
   - when service `exposed port` is `0`, app skips port listen checks and disables service forwarding.
6. Service runtime stores the current `pid`; clicking the service name opens a terminal-like log view.
   - log view uses a single panel (stdout + stderr merged), supports ANSI color rendering and auto refresh.
   - logs are read from `journalctl --user` for the current systemd invocation, so the panel always shows the logs for the unit instance currently managed by the app.
   - log view opens as a larger dedicated dialog (about 80% of the viewport) with a slightly larger monospace font for easier reading.
   - log view includes an `Auto Scroll` toggle (default on); when off, logs still refresh but manual reading position is preserved.
   - while the log dialog is open, background page scrolling is locked so only the log viewport itself can scroll.
   - scrolling to the top of the log viewport automatically loads older lines for the same invocation instead of being capped to the initial recent slice.
   - background refresh avoids disrupting active text selection, so copying log snippets is no longer interrupted by periodic updates.
   - log view provides `Search` with previous/next match navigation and `Filter` to only show matching lines, similar to a lightweight grep view.
   - service status itself is auto-refreshed in background (no manual refresh button in list).
   - log open/refresh failures are caught in renderer so transient SSH errors, missing systemd support, or deleted targets do not surface as uncaught promise crashes; the error is shown through the page toast instead.
7. Tunnel list and service list are rendered under each host on home page:
   - the page header is sticky, so branding and quick actions remain available while long host lists scroll
   - `Tunnel List`: start/stop tunnel rule, status, auto-retry on runtime errors
   - running tunnel rows expose the local endpoint as a clickable `http://...` link, matching service-forward behavior
   - `Service List`: start/stop service, PID/log, runtime forward indicator
   - hosts are rendered as distinct collapsible blocks so dense host lists remain scannable
   - the home page does not wrap hosts in a separate `Hosts` card; each host is its own container with spacing between hosts
   - host names align to the left edge of their container so they read as the first hierarchy level; the host collapse control uses an 18px local inline SVG icon placed before the host name, with a down triangle when expanded and the original right triangle when collapsed
   - each host has a subtle divider between host connection metadata and its runtime tunnel/service area
   - base UI font tokens are raised by about 2px, with host names, runtime section titles, rows, status markers, and power buttons scaled together for clearer scanability
   - host runtime rows use a compact local monospace layout for terminal-like scanability, with contextual power-icon start/stop actions colored by runtime status and explicit hover/active/focus/busy feedback
   - runtime rows do not use whole-row hover highlighting; interactive feedback belongs to the service name link and the power action button
   - runtime power buttons keep their outer hit area stable on hover/active; motion is limited to the inner icon to avoid pointer flicker
   - every expanded host always uses two compact columns: tunnels on the left and services on the right, even when one side is empty
   - the two runtime columns are separated by a very light vertical divider
   - runtime rows use fixed proportional columns; names and ports align to the left within their columns, while the start/stop action is centered
   - the two runtime section titles and data rows use fixed heights so left and right columns stay horizontally aligned
   - runtime status is shown through the tunnel/service name color instead of a separate status column
   - service PID is not shown as a separate column; clicking the service name opens the log dialog
   - port text is formatted for fast scanning: tunnels and forwarded services use `L:<local> → R:<remote>`, while non-forwarded services use `:<exposedPort>`
   - port numbers are right-aligned in fixed five-character slots so local and remote ports line up vertically
   - status colors are fixed to muted green running (`#15803d`), gray stopped (`#6b7280`), and red error (`#ef4444`)
   - `Tunnel List` and `Service List` use separate visual section treatments to improve in-host distinction
   - `Tunnel List` and `Service List` section headers do not show standalone collapse arrows because those sections are not individually collapsible
   - section titles use a slightly stronger typographic emphasis than column headers, so list hierarchy stays readable in the compact layout
   - section titles include larger semantic local inline SVG icons, avoiding any remote icon dependency while making the hierarchy easier to scan; the tunnel section uses a filled tunnel glyph and the service section uses a filled process-grid glyph
   - empty `Tunnel List` or `Service List` columns remain visible with a compact empty state, so the two-column structure stays stable
8. Service actions in list: `Start`, `Stop`.
   - `Start` creates a dedicated `systemd-run --user` transient unit per host/service.
   - the managed command is launched through the remote account's login shell so user-level PATH/runtime initialization (for example `nvm`, `conda`, shell-managed Node/Yarn installs) is closer to an interactive SSH session.
   - `Stop` uses `systemctl --user stop` on that transient unit; there is no stop-command config and no legacy PID-group fallback.
   - service `Start` / `Stop` / background `Refresh` / `Delete` operations are serialized per host/service key, so a background refresh cannot race a user action and overwrite its transition state.
   - only `Start` / `Stop` remain in list actions; service delete is handled in host edit form.
   - when service is running and `forward local port` is configured, app auto creates SSH local port forwarding (`127.0.0.1:<local>` -> `remote:exposedPort`); forwarding is closed when service stops.
   - when `exposed port` is `0`, forwarding is disabled even if forward local port is filled.
   - Port column shows forwarding state: green check for success (with clickable `http://127.0.0.1:<local>` link opened by system default browser), red cross for failure.
9. Host private key supports both:
   - direct paste of key content
   - import key file from local filesystem
   - import dialog defaults to `~/.ssh` directory
   - Add/Edit Host shows the current key source in a compact summary and keeps pasted key content collapsed until needed
10. Config transfer:
   - `Import Config` from JSON
   - `Export Config` to JSON
   - includes hosts, jump-server chain settings, forwarding rules, and services
11. Destructive deletes (`Delete Host`, `Delete` rule) always prompt for confirmation.

## Tech Stack

- Electron
- TypeScript
- Tailwind CSS renderer component/utilities layer (`tailwind.css`, preflight disabled)
- `ssh2` (SSH connection and remote command execution)
- `asn1` (explicit dependency required by ssh2 stack in this project)
- Base renderer CSS for local fonts, CSS variables, and terminal ANSI log colors
- Local JSON persistence in Electron userData

## Project Structure

- `src/main/main.ts`: Electron app/window/menu wiring and IPC orchestration
- `src/main/preload.ts`: secure renderer bridge
- `src/main/validation.ts`: host/forward/service draft validation and runtime-field preservation
- `src/main/configTransfer.ts`: config import/export parsing, counting, and imported-ID normalization
- `src/main/runtimeRegistry.ts`: in-memory service/forward runtime state and `HostView` assembly
- `src/main/operationQueue.ts`: per-key async queue used to serialize service mutations
- `src/main/hostConnection.ts`: shared SSH endpoint/private-key resolution for service, tunnel, and forwarding paths
- `src/main/serviceRuntime.ts`: remote `systemd --user` service lifecycle and journal log access
- `src/main/portForwardManager.ts` / `src/main/tunnelManager.ts`: SSH local forwarding runtime
- `src/renderer/renderer.ts`: UI orchestration and DOM event wiring
- `src/renderer/tailwind.css`: primary renderer visual layer built with Tailwind `@layer components` and `@apply`; generated output is `dist/renderer/tailwind.css`
- `src/renderer/styles.css`: base-only renderer CSS for local fonts, CSS variables, browser defaults, and ANSI log helpers
- `src/renderer/html.ts`: dynamic HTML escaping and ANSI-to-HTML rendering helpers
- `src/renderer/status.ts`: shared renderer status formatting and action-state helpers
- `tailwind.config.cjs`: Tailwind content/theme configuration; preflight is disabled to avoid global reset drift
- `scripts/build-tailwind.cjs`: Tailwind CSS build wrapper
- `scripts/copy-renderer.cjs`: renderer static asset copy helper
- `src/shared/types.ts`: shared type contracts
- `tests/*.test.js`: Node built-in test runner coverage for extracted main-process pure/runtime helpers
- `assets/source.png` + `assets/icon.*`: app icon source and generated icons (rounded white background) used by runtime/build
- `dist/*`: compiled output (generated)

## Development

Install dependencies manually (as requested):

1. `pnpm install`
2. `pnpm dev`

Build & run workflow:

- `pnpm build` -> compile TS and copy renderer assets to `dist`
- `pnpm run build:css` -> generate `dist/renderer/tailwind.css`
- `pnpm dev` / `pnpm start` -> run Electron using `dist/main/main.js`
- `pnpm test` -> build first, then run `node --test tests/*.test.js`

## Build Packaging

```bash
pnpm run package:mac
pnpm run package:win
pnpm run package:linux
```

Artifacts are generated under `release/`.

## Auto Update

- Auto update is integrated via `electron-updater` (GitHub Releases channel).
- In packaged app:
  - checks automatically after startup, then on interval
  - supports manual `Check for Updates...` from app menu (macOS style)
  - prompts for download and restart install
- Header update text is intentionally quiet for `unsupported` and `up-to-date` states; the header already shows the current app version.
- In dev mode (unpackaged), updater state is unsupported but no header hint is shown.

## CI/CD Release Workflow

- Workflow: `.github/workflows/release.yml`
- Behavior:
  - auto bump patch version
  - create git tag
  - build artifacts for macOS / Windows / Linux
  - publish GitHub Release with generated artifacts
  - inject current repository owner/name into electron-builder publish config during CI build (for updater metadata)

## macOS Notice (Unsigned Build)

Current macOS artifacts are unsigned. If macOS blocks first launch:

1. Right click app in Finder and choose `Open`, or
2. Run:

```bash
xattr -dr com.apple.quarantine "/Applications/Service Manager.app"
open -a "Service Manager"
```

## Remote Host Preflight

Before using service start/stop/log features on a remote Linux host, verify the SSH account satisfies the following requirements.

1. Check that required `systemd` tools exist:

```bash
command -v systemd-run systemctl journalctl loginctl
```

Expected result:
- all four commands resolve successfully

If any command is missing:
- install/configure `systemd` on the remote host
- this app does not fall back to raw background shell processes

2. Check that the SSH account has a working user manager:

```bash
systemctl --user show-environment
```

Expected result:
- command exits successfully and prints user manager environment

If it fails:
- the remote host does not have a usable `systemd --user` session for that account
- fix the host's `systemd` user-session configuration before using service management

3. Check that lingering is enabled for the SSH account:

```bash
loginctl show-user "$USER" -p Linger --value
```

Expected result:
- output is exactly `yes`

If output is `no`, enable it with a privileged account:

```bash
sudo loginctl enable-linger <username>
```

Then re-check:

```bash
loginctl show-user "$USER" -p Linger --value
```

4. Check that the SSH account can access the service directory and execute the start command:

```bash
whoami
echo "$SHELL"
cd /path/to/app && pwd
command -v yarn
```

Expected result:
- the account is the one you configured in the app
- the project directory is accessible
- command dependencies such as `yarn`, `node`, `pnpm`, `python`, etc. are resolvable for that login shell

If command dependencies are missing:
- ensure the login shell initializes the runtime environment correctly, or
- use absolute binary paths in `Start Command`, or
- explicitly source the runtime environment in `Start Command`, for example:

```bash
source ~/.nvm/nvm.sh && cd /path/to/app && exec yarn start:dev
```

5. Recommended debug commands when a start attempt fails:

```bash
systemctl --user list-units --all --plain | grep service-manager-
systemctl --user status <unit-name> --no-pager
journalctl --user -u <unit-name> -n 200 --no-pager
```

## Notes / Current Limits

- SSH command execution now uses `ssh2` directly (not shelling out to system `ssh`).
- In `Add/Edit Host`, private key auth includes `Private Key` + optional `Passphrase`, and supports `Import` file action.
- Service lifecycle is managed only through `systemd-run --user`, `systemctl --user`, and `journalctl --user`; there is no fallback to raw background shell processes.
- Service commands are executed through the remote account's detected login shell; this improves compatibility with shell-managed runtimes, but absolute binary paths are still the most stable choice for production services.
- Transient units are intentionally kept inspectable after exit/failure; the app does not use `systemd-run --collect`, so `systemctl --user status` and `journalctl --user -u <unit>` remain useful for debugging startup failures.
- Manual `Stop` waits for the transient unit to deactivate and clears any temporary failed state caused by the termination signal, so an intentional stop settles back to `stopped` instead of surfacing as an error.
- Remote hosts must provide working `systemd` user services for the SSH account:
  - `systemd-run`, `systemctl`, `journalctl`, and `loginctl` must exist
  - `systemctl --user` must work for that account
  - lingering must be enabled, for example: `sudo loginctl enable-linger <username>`
- When those systemd prerequisites are missing, service start/stop/log actions surface an explicit install/configuration error in the UI instead of falling back to raw background processes.
- The app persists the latest `MainPID` reported by systemd for display and refresh, but start/stop/log ownership is defined by the transient unit, not by a log file path or `kill -0`.
- Renderer now guards repeated dialog open/close calls, catches global `error` / `unhandledrejection`, surfaces failures through the page toast, and escapes dynamic host/service/error text before writing HTML so bad runtime payloads do not break the page.
- Main process now logs top-level `uncaughtException` / `unhandledRejection`, renderer-process exits, and IPC broadcast failures to make crash diagnosis visible.
- Main-process validation, config transfer, runtime-state assembly, SSH endpoint resolution, and service-operation serialization are split into focused modules so they can be tested without launching Electron.
- Unit tests use Node's built-in test runner against compiled `dist/main/*` output; no extra test framework dependency is required.
- `Add/Edit Host` now has hierarchical editing structure:
  - Forwarding Rules section
  - Services section
  - Jump Servers section (optional, supports multi-hop chains)
- Jump Servers are enabled by adding one or more hops; there is no separate enable checkbox to keep the modal state model simple.

## Change Discipline

Per project rule, every important change must update both:

- `README.md`
- `AGENTS.md`
