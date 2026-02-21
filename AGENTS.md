# AGENTS Collaboration Guide

## Goal

Build a desktop Electron application to manage services on remote servers through SSH.

## Current Product Scope

1. Host management with SSH connection configuration.
   - Jump Host is configured directly inside Add/Edit Host form.
2. Service management under each host:
   - start command
   - exposed port
   - optional local forward port
3. Forwarding-rule management under each host (same capability model as `ssh-tunnel-manager`):
   - local host / local port
   - remote host / remote port
   - auto-start flag
   - runtime start/stop/delete in list
   - tunnel status with reconnect countdown on error
   - supports jump-host chain when host has jump configured
4. Service status and runtime state:
   - save PID on start
   - PID-alive means running; missing/dead PID means stopped
   - in-progress actions should surface explicit transition states (`starting` / `stopping`) instead of generic unknown
   - show PID in service list
   - click PID to view merged terminal-style logs (stdout + stderr), with auto refresh and ANSI color display
   - capture logs as a single merged stream at source to preserve original output order
   - provide auto-scroll toggle in log dialog (default enabled); disabling keeps refresh but preserves manual scroll position
   - log dialog is read-only (no start/stop/refresh buttons inside dialog)
   - start should be non-blocking after PID capture; startup port checks are post-start and must not delay PID/log availability
5. Service actions in panel:
   - start
   - stop
   - status refresh is automatic in background (no per-row refresh button)
   - service delete is provided in host edit form (not in list row actions)
   - stop behavior is group kill by PID (`SIGTERM` to process group); no configurable stop command.
   - if local forward port is configured, start/refresh should ensure SSH local port forwarding is active; stop/delete should close forwarding.
   - Port column must visualize forward result when forward port is set:
     - success: green check and clickable `http://127.0.0.1:<localPort>` link (opens via system default browser)
     - failure: red cross indicator (with error hint)
   - when forward local port is empty, treat forwarding as disabled (no forward attempt on start/refresh).
   - Home page structure must be host-centric:
     - each host is a top-level block
     - each host contains `Tunnel List` and `Service List`
6. Host edit page structure must follow same hierarchy:
   - Forwarding Rules section
   - Services section
7. Overview cards must keep tunnel/service metrics explicit and separate:
   - tunnel: running / stopped / errors
   - service: running / stopped / errors
   - layout should remain compact enough to stay one-line in default window width
8. Config import/export must be available from home page quick actions:
   - export current hosts/rules/services to JSON
   - import JSON and replace current config
   - imported IDs must be normalized for uniqueness
9. Host private key auth supports key content input and key file import.
   - private key import dialog should default to `~/.ssh` when available.
10. Release and update pipeline:
   - GitHub Actions release workflow must build macOS / Windows / Linux artifacts and publish release
   - app must support auto update (`electron-updater`) with state broadcast to renderer
   - manual check update entry should be in app menu (`Check for Updates...`), not a dedicated quick-action button
   - README must include unsigned macOS install guidance

## Alignment Requirement (with `ssh-tunnel-manager`)

The project must stay aligned with `ssh-tunnel-manager` in this workspace for:

- UI style and interaction model
  - overview cards
  - grouped host/service list
  - modal-based host creation/editing
  - service creation/editing flow inside host modal
- language tone in UI (English)
- engineering approach
  - TypeScript source
  - `tsc` build to `dist`
  - Electron runs compiled output from `dist`

## Working Constraints

- If dependency installation is needed, stop and let the user run `pnpm install`.
- Prefer incremental, testable changes.
- SSH layer requirement:
  - Must use `ssh2` for host connection and remote command execution.
  - Keep `asn1` explicitly declared in dependencies for this project.

## Mandatory Documentation Rule

For every important change (features, architecture, data model, runtime behavior, command flow, limits):

- Update `README.md`
- Update `AGENTS.md`

This rule is mandatory for ongoing development.
