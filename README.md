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
   - exposed port
   - forward local port (optional; if empty, no local forwarding is created)
5. Service status in panel based on saved PID:
   - PID exists and is alive: `running`
   - PID missing or dead: `stopped`
   - while start/stop command is in progress: `starting` / `stopping`
6. Service list shows `status` and `pid`; clicking PID opens a terminal-like log view.
   - log view uses a single panel (stdout + stderr merged), supports ANSI color rendering and auto refresh.
   - logs are captured as a single combined stream on server side, preserving stdout/stderr ordering like terminal output.
   - log view includes an `Auto Scroll` toggle (default on); when off, logs still refresh but scroll position is preserved.
   - service status itself is auto-refreshed in background (no manual refresh button in list).
7. Tunnel list and service list are rendered under each host on home page:
   - `Tunnel List`: start/stop/delete tunnel rule, status, auto-retry on runtime errors
   - `Service List`: start/stop service, PID/log, runtime forward indicator
   - Overview metrics are split clearly by domain:
     - tunnel running/stopped/errors
     - service running/stopped/errors
8. Service actions in list: `Start`, `Stop`.
   - `Stop` sends `SIGTERM` to the PID's process group on remote host (no stop command config), so process trees (e.g. watch mode) can be stopped together.
   - only `Start` / `Stop` remain in list actions; service delete is handled in host edit form.
   - when service is running and `forward local port` is configured, app auto creates SSH local port forwarding (`127.0.0.1:<local>` -> `remote:exposedPort`); forwarding is closed when service stops.
   - Port column shows forwarding state: green check for success (with clickable `http://127.0.0.1:<local>` link opened by system default browser), red cross for failure.
9. Host private key supports both:
   - direct paste of key content
   - import key file from local filesystem
   - import dialog defaults to `~/.ssh` directory
10. Config transfer:
   - `Import Config` from JSON
   - `Export Config` to JSON
   - includes hosts, jump-host settings, forwarding rules, and services

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
- Start command runs in background and records PID plus stdout/stderr log file paths under `/tmp/service-manager`.
- PID is persisted with the service config, and status checks use `kill -0 <pid>`.
- `Add/Edit Host` now has hierarchical editing structure:
  - Forwarding Rules section
  - Services section
  - Jump Host section (optional)

## Change Discipline

Per project rule, every important change must update both:

- `README.md`
- `AGENTS.md`
