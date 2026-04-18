# AGENTS Collaboration Guide

## Goal

Build a desktop Electron application to manage services on remote servers through SSH.

## Current Product Scope

1. Host management with SSH connection configuration.
   - Jump Servers are configured directly inside Add/Edit Host form as an ordered multi-hop chain.
   - Deleting a host requires confirmation.
   - creating or editing a host must only require host name and SSH connection info; empty forwarding-rule/service lists are valid
   - page header should show the packaged app logo and current app version
   - host list should provide a copy-config action per host, and Add Host should support pasting one host config from clipboard into the form
   - user-facing buttons should pair their labels with local inline icons that match the action, rather than relying on remote icon assets
   - host dialog validation/import feedback must be shown inside the modal, and page-level notices should use top-right auto-dismiss toast messages rather than permanent inline text
2. Service management under each host:
   - start command
   - start command editor in host modal must be full-width and multi-line so long shell commands stay practical to edit
   - exposed port (`0` means not exposed)
   - optional local forward port
3. Forwarding-rule management under each host (same capability model as `ssh-tunnel-manager`):
   - optional rule name, shown in the host tunnel list when present
   - local host / local port
   - remote host / remote port
   - auto-start flag
   - runtime start/stop in list (delete handled in host edit form, with confirmation)
   - tunnel status with reconnect countdown on error
   - when a tunnel is running, its local endpoint should be rendered as a clickable link
   - supports multi-hop jump-server chains when configured on the host
   - Add/Edit Host should not create placeholder forwarding-rule or service rows automatically; users add rows only when needed
4. Service status and runtime state:
   - save PID on start
   - service runtime is managed only through remote `systemd --user` transient units created by `systemd-run`
   - systemd `active` means running; missing/inactive unit means stopped
   - in-progress actions should surface explicit transition states (`starting` / `stopping`) instead of generic unknown
   - show PID in service list
   - click PID to view merged terminal-style logs (stdout + stderr), with auto refresh and ANSI color display
   - capture logs as a single merged stream at source to preserve original output order
   - clicking PID must read `journalctl --user` output for the unit's current invocation, so the panel always shows the logs for the currently managed process instance
   - log dialog should occupy about 80% of the viewport and use a comfortably readable monospace size
   - provide auto-scroll toggle in log dialog (default enabled); disabling keeps refresh but preserves manual scroll position
   - while the log dialog is open, page scrolling should be locked so only the log viewport can scroll
   - log refresh should avoid disrupting active text selection, so copying text is not interrupted by auto refresh
   - log dialog should provide search with previous/next match navigation plus grep-like filtering that only shows matching lines
   - log dialog is read-only (no start/stop/refresh buttons inside dialog)
   - start should be non-blocking after systemd `MainPID` capture; startup port checks are post-start and must not delay PID/log availability
   - transient systemd units must remain inspectable after exit/failure; do not use `systemd-run --collect`
   - intentional `Stop` must settle back to `stopped`; if systemd briefly marks the unit failed because of the termination signal, the app should wait for deactivation and clear that failed state
   - renderer must catch log open/refresh failures so missing targets or SSH errors do not escape as uncaught promise errors; surfaced failures should remain visible through the page toast
   - dialog open/close paths must be idempotent; repeated clicks must not throw browser `InvalidStateError`
   - if remote host lacks usable systemd user services, service actions must fail explicitly and tell the user to install/configure systemd instead of falling back to raw background processes
5. Service actions in panel:
   - start
   - stop
   - status refresh is automatic in background (no per-row refresh button)
   - service delete is provided in host edit form (not in list row actions)
   - start behavior is `systemd-run --user` transient unit creation; no raw shell background fallback
   - managed service commands should be launched through the remote account's login shell so shell-managed runtime PATH initialization remains compatible with manual SSH usage
   - stop behavior is `systemctl --user stop` on the transient unit; no configurable stop command
   - if local forward port is configured, start/refresh should ensure SSH local port forwarding is active; stop/delete should close forwarding.
   - if service exposed port is `0`, skip port-listen checks and disable service forwarding.
   - Port column must visualize forward result when forward port is set:
     - success: green check and clickable `http://127.0.0.1:<localPort>` link (opens via system default browser)
     - failure: red cross indicator (with error hint)
   - when forward local port is empty, treat forwarding as disabled (no forward attempt on start/refresh).
   - Home page structure must be host-centric:
     - each host is a top-level block
     - each host contains `Tunnel List` and `Service List`
     - each host block must be collapsible from the list page
     - `Tunnel List` and `Service List` should have clearly distinct visual section treatments inside the host block
     - section titles should carry slightly stronger typographic emphasis than table column headers so hierarchy remains clear in the compact layout
     - section titles should use local inline icons rather than remote icon assets, so packaging and offline usage stay self-contained
     - when a host has no tunnels or no services, the empty section should be omitted instead of rendering a placeholder block
6. Host edit page structure must follow same hierarchy:
   - Forwarding Rules section
   - Services section
7. Config import/export must be available from home page quick actions:
   - export current hosts/rules/services to JSON
   - import JSON and replace current config
   - imported IDs must be normalized for uniqueness
8. Host private key auth supports key content input and key file import.
   - private key import dialog should default to `~/.ssh` when available.
9. Release and update pipeline:
   - GitHub Actions release workflow must build macOS / Windows / Linux artifacts and publish release
   - app must support auto update (`electron-updater`) with state broadcast to renderer
   - manual check update entry should be in app menu (`Check for Updates...`), not a dedicated quick-action button
   - README must include unsigned macOS install guidance
10. App icon assets:
   - base image at `assets/source.png`
   - generated icons (`assets/icon.*`) are used for runtime window icon and packaging

## Alignment Requirement (with `ssh-tunnel-manager`)

The project must stay aligned with `ssh-tunnel-manager` in this workspace for:

- UI style and interaction model
  - header branding with quick actions
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
- Remote-host documentation requirement:
  - `README.md` must document the remote service-management preflight checks, including `systemd` tool availability, `systemctl --user` availability, lingering verification, and the `loginctl enable-linger` enablement command.
- Runtime stability requirement:
  - renderer must escape dynamic HTML text derived from host/service/error data before injecting into DOM
  - renderer should surface caught runtime errors through the page toast instead of failing silently
  - main process must log top-level runtime failures (`uncaughtException`, `unhandledRejection`, renderer-process exits) instead of failing silently

## Mandatory Documentation Rule

For every important change (features, architecture, data model, runtime behavior, command flow, limits):

- Update `README.md`
- Update `AGENTS.md`

This rule is mandatory for ongoing development.
