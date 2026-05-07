# AGENTS Guide

## Purpose

Service Manager is an Electron + TypeScript desktop app for managing remote development hosts over SSH.

It supports two host-scoped runtime resources:

- Forwarding rules: SSH local port forwards managed in-app.
- Services: remote processes managed through `systemd --user` transient units.

## Non-Negotiable Rules

- Keep the app consistent in English UI tone, modal host editing, grouped host lists, and `tsc` build-to-`dist` workflow.
- Use `ssh2` for SSH connections and remote command execution; do not shell out to system `ssh`.
- Keep `asn1` explicitly declared as a dependency.
- Do not install dependencies yourself. If dependencies are needed, stop and ask the user to run `pnpm install`.
- Important changes must update both `README.md` and `AGENTS.md` when they affect features, architecture, runtime behavior, command flow, data model, limits, or developer workflow.
- Prefer incremental changes with tests.

## Current Architecture

- `src/main/main.ts`: Electron app/window/menu wiring and IPC orchestration.
- `src/main/validation.ts`: host, forwarding-rule, and service draft validation.
- `src/main/configTransfer.ts`: config import/export parsing, counting, and imported-ID normalization.
- `src/main/runtimeRegistry.ts`: in-memory service/forward runtime state and `HostView` assembly.
- `src/main/operationQueue.ts`: per-host/service async serialization for service mutations.
- `src/main/hostConnection.ts`: shared SSH endpoint and private-key resolution.
- `src/main/serviceRuntime.ts`: remote `systemd --user` lifecycle, status checks, and journal log access.
- `src/main/portForwardManager.ts`: service-owned local port forwarding.
- `src/main/tunnelManager.ts`: forwarding-rule runtime and reconnect behavior.
- `src/renderer/renderer.ts`: UI orchestration and DOM event wiring.
- `src/renderer/tailwind.css`: primary renderer visual layer using Tailwind `@layer components` and `@apply`; generated output is `dist/renderer/tailwind.css`.
- `src/renderer/styles.css`: base-only renderer CSS for local fonts, CSS variables, browser defaults, and ANSI log helpers.
- `src/renderer/html.ts`: dynamic HTML escaping and ANSI-to-HTML rendering.
- `src/renderer/status.ts`: renderer status formatting and action-state helpers.
- `tailwind.config.cjs`: Tailwind content/theme configuration with preflight disabled to avoid global reset drift.
- `scripts/build-tailwind.cjs`: Tailwind CSS build wrapper.
- `scripts/copy-renderer.cjs`: renderer static asset copy helper.
- `src/shared/types.ts`: shared IPC/data contracts.
- `tests/*.test.js`: Node built-in tests against compiled `dist` output.

## Runtime Model

Hosts:

- Host creation/editing requires only name and SSH connection info.
- Forwarding rules and services are optional and start empty.
- Jump servers are configured inside Add/Edit Host as an ordered multi-hop chain.
- Private-key auth supports pasted key content and imported key files; import should default to `~/.ssh` when possible.

Forwarding rules:

- Use optional name, local host/port, remote host/port, auto-start, and start/stop from list.
- Use the host's jump-server chain when configured.
- Running local endpoints should be clickable links opened by the system browser.
- Runtime errors should expose status and reconnect countdown where applicable.

Services:

- Store only name, start command, exposed port, and optional local forward port.
- Exposed port `0` means not exposed; skip port checks and disable service forwarding.
- Start uses `systemd-run --user` transient units only. No raw background-process fallback.
- Stop uses `systemctl --user stop`; there is no configurable stop command.
- Commands must run through the remote account's login shell to preserve shell-managed PATH/runtime setup.
- `systemd active` means running; missing/inactive units mean stopped.
- Start should return once `MainPID` is available; port checks and forwarding are post-start work.
- Do not use `systemd-run --collect`; failed/exited units must remain inspectable.
- Intentional stop should settle to `stopped`, even if systemd briefly reports failed due to termination signal.
- Service `start`, `stop`, background `refresh`, and `delete` must be serialized per host/service key.

Logs:

- Open logs from the service name in the list.
- Read logs with `journalctl --user` for the current unit invocation.
- Preserve stdout/stderr ordering as a single terminal-like stream.
- Render ANSI colors, auto-refresh, auto-scroll toggle, older-line loading, search, and filter.
- Log dialog is read-only and must catch failures without uncaught renderer promises.

## UI Principles

- UI language is English.
- Tailwind CSS owns renderer component/layout styling through `src/renderer/tailwind.css`; keep `src/renderer/styles.css` limited to base fonts, tokens, browser defaults, and ANSI log helpers.
- Keep Tailwind preflight disabled unless intentionally redesigning global base styles.
- Home page is host-centric: each host is a top-level block with tunnel and service sections.
- Home page header must stay sticky so quick actions remain reachable on long host lists.
- Host collapse control belongs before the host name and uses the local filled list-toggle SVG with a restrained 18px visual icon size; expanded state points the triangle down, collapsed state keeps the original right-pointing triangle.
- Host edit form follows the same hierarchy: forwarding rules, services, jump servers.
- Host edit actions must stay visible in a sticky footer for long configs.
- Host edit forwarding-rule and service editors should use compact summary rows with expandable details.
- Private-key auth should show a compact key-source summary; pasted key content stays collapsed unless explicitly opened.
- Jump Servers are enabled by adding hop rows, not by a separate visible enable checkbox.
- Keep dense runtime rows scannable: compact monospace layout, aligned port text, status by name color, and power-icon start/stop actions with clear hover, active, focus, disabled, and busy feedback.
- Do not add whole-row hover highlights to runtime service/tunnel rows; keep feedback on the clickable service name and power action button.
- Runtime power buttons must keep a stable outer hit area on hover/active; do not move or scale the button container because that can cause pointer flicker. Animate the inner icon instead.
- Section header icons must be local inline SVGs with semantic shapes and enough visual weight to match their titles; the tunnel section should use the filled tunnel glyph, and the service section should use the filled process-grid glyph.
- Empty tunnel/service columns should keep the two-column layout stable.
- Use local inline icons/assets only; do not depend on remote icon assets.
- Page-level notices should be top-right auto-dismiss toasts. Modal validation/import feedback stays inside the modal.

## Safety Requirements

- Renderer must escape dynamic HTML derived from host, service, tunnel, log, or error data before injecting into the DOM.
- Renderer runtime failures should be surfaced through page toasts instead of failing silently.
- Main process must log top-level `uncaughtException`, `unhandledRejection`, renderer-process exits, and IPC broadcast failures.
- Dialog open/close paths must be idempotent.
- Missing remote `systemd --user` support must fail explicitly with setup guidance; never silently switch to an unmanaged process model.

## Testing

- Run `pnpm test` after behavioral or architecture changes.
- `pnpm test` must build first, then run `node --test tests/*.test.js`.
- Add `node:test` coverage for extracted pure logic, runtime orchestration helpers, import/export behavior, and command-building logic.
- No extra test framework should be introduced unless there is a clear need and the user installs it.

## Remote Host Documentation

`README.md` must document the remote service preflight checklist:

- `systemd-run`, `systemctl`, `journalctl`, and `loginctl` availability.
- `systemctl --user` availability for the SSH account.
- Lingering verification.
- `sudo loginctl enable-linger <username>` setup command.

## Release And Updates

- GitHub Actions must build macOS, Windows, and Linux artifacts.
- Auto update uses `electron-updater` with state broadcast to renderer.
- Manual update check belongs in the app menu as `Check for Updates...`, not as a home-page quick action.
- README must include unsigned macOS install/quarantine guidance.
- Runtime/build icons come from `assets/source.png` and generated `assets/icon.*` files.
