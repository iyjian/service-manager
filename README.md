# Service Manager (Electron + TypeScript)

Desktop service manager for remote servers over SSH.

This project is now aligned with the **UI style** and **development approach** of `ssh-tunnel-manager` in this workspace.

## What Was Aligned

- Same engineering style: `TypeScript + tsc build + dist runtime`
- Same Electron startup pattern: build first, then run Electron from `dist`
- Same UI interaction pattern:
  - `Overview` cards
  - grouped list/table by Host
  - `Add/Edit Host` via modal dialog
  - add/remove services inside the host modal (similar to how rules are added in `ssh-tunnel-manager`)
- Same language direction in app UI: English labels and actions

## Core Features

1. Host list with SSH connection settings.
   - supports optional `Jump Host` configuration directly in Add/Edit Host form (no separate entry page/button)
2. Per-host configuration now has **two independent lists**:
   - `Forwarding Rules` (tunnel rules, same model as `ssh-tunnel-manager`)
   - `Services` (remote process lifecycle)
3. Forwarding rule fields:
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
6. Service list shows `status` and `pid`; clicking PID opens a terminal-like log view.
   - log view uses a single panel (stdout + stderr merged), supports ANSI color rendering and auto refresh.
   - logs are read from `journalctl --user` for the current systemd invocation, so the panel always shows the logs for the unit instance currently managed by the app.
   - log view includes an `Auto Scroll` toggle (default on); when off, logs still refresh but scroll position is preserved.
   - service status itself is auto-refreshed in background (no manual refresh button in list).
   - log open/refresh failures are caught in renderer so transient SSH errors, missing systemd support, or deleted targets do not surface as uncaught promise crashes; the error is shown in the page message bar instead.
7. Tunnel list and service list are rendered under each host on home page:
   - `Tunnel List`: start/stop tunnel rule, status, auto-retry on runtime errors
   - `Service List`: start/stop service, PID/log, runtime forward indicator
   - Overview metrics are split clearly by domain:
     - tunnel running/stopped/errors
     - service running/stopped/errors
8. Service actions in list: `Start`, `Stop`.
   - `Start` creates a dedicated `systemd-run --user` transient unit per host/service.
   - the managed command is launched through the remote account's login shell so user-level PATH/runtime initialization (for example `nvm`, `conda`, shell-managed Node/Yarn installs) is closer to an interactive SSH session.
   - `Stop` uses `systemctl --user stop` on that transient unit; there is no stop-command config and no legacy PID-group fallback.
   - only `Start` / `Stop` remain in list actions; service delete is handled in host edit form.
   - when service is running and `forward local port` is configured, app auto creates SSH local port forwarding (`127.0.0.1:<local>` -> `remote:exposedPort`); forwarding is closed when service stops.
   - when `exposed port` is `0`, forwarding is disabled even if forward local port is filled.
   - Port column shows forwarding state: green check for success (with clickable `http://127.0.0.1:<local>` link opened by system default browser), red cross for failure.
9. Host private key supports both:
   - direct paste of key content
   - import key file from local filesystem
   - import dialog defaults to `~/.ssh` directory
10. Config transfer:
   - `Import Config` from JSON
   - `Export Config` to JSON
   - includes hosts, jump-host settings, forwarding rules, and services
11. Destructive deletes (`Delete Host`, `Delete` rule) always prompt for confirmation.

## Tech Stack

- Electron
- TypeScript
- `ssh2` (SSH connection and remote command execution)
- `asn1` (explicit dependency required by ssh2 stack in this project)
- Native HTML/CSS (renderer)
- Local JSON persistence in Electron userData

## Project Structure

- `src/main/*.ts`: main process, IPC, persistence, SSH execution
- `src/main/preload.ts`: secure renderer bridge
- `src/renderer/*`: UI and interaction logic
- `src/shared/types.ts`: shared type contracts
- `assets/source.png` + `assets/icon.*`: app icon source and generated icons (rounded white background) used by runtime/build
- `dist/*`: compiled output (generated)

## Development

Install dependencies manually (as requested):

1. `pnpm install`
2. `pnpm dev`

Build & run workflow:

- `pnpm build` -> compile TS and copy renderer assets to `dist`
- `pnpm dev` / `pnpm start` -> run Electron using `dist/main/main.js`

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
- In dev mode (unpackaged), updater state shows unsupported.

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
- Renderer now guards repeated dialog open/close calls, catches global `error` / `unhandledrejection`, surfaces failures through the page message bar, and escapes dynamic host/service/error text before writing HTML so bad runtime payloads do not break the page.
- Main process now logs top-level `uncaughtException` / `unhandledRejection`, renderer-process exits, and IPC broadcast failures to make crash diagnosis visible.
- `Add/Edit Host` now has hierarchical editing structure:
  - Forwarding Rules section
  - Services section
  - Jump Host section (optional)

## Change Discipline

Per project rule, every important change must update both:

- `README.md`
- `AGENTS.md`
