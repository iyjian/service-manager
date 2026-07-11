# AGENTS Guide

## Purpose

Service Manager is an Electron + TypeScript desktop app for managing remote development hosts over SSH.

It supports two host-scoped runtime resources:

- Forwarding rules: SSH local port forwards managed in-app.
- Services: remote processes managed through `systemd --user` transient units.

It also supports a local Mihomo proxy runtime backed by a Clash-format subscription.

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
- `src/main/proxy/proxyRuntime.ts`: local Mihomo lifecycle, parsed-cache loading/replacement, persisted settings and Custom Rule mutations, and system/TUN proxy controls.
- `src/main/proxy/proxyAutoStart.ts`: non-blocking Proxy running-intent restoration and startup error routing.
- `src/main/proxy/subscriptionCache.ts`: versioned parsed-subscription cache serialization and validation.
- `src/main/proxy/proxyExceptions.ts`: Custom Rule validation, normalization, migration, and target-aware Mihomo rule generation.
- `src/main/proxy/proxyGroups.ts`: pure Mihomo runtime group conversion, manual-selector validation, and saved-selection compatibility helpers.
- `src/main/appMemory.ts`: local Electron and Mihomo working-set collection for the Hosts header Memory total.
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
- The Hosts header shows the total local Service Manager Memory in GB. It aggregates all Electron `app.getAppMetrics()` processes and local Mihomo RSS when running, refreshes every five seconds only while Hosts is active, and replaces the old host/tunnel/service aggregate. Remote SSH services are excluded, as is system-wide memory.

Local proxy:

- Preserve the subscription's proxies, proxy-groups, rules, proxy-providers, and rule-providers; override only local runtime control fields.
- The Proxy page accepts a one-time subscription URL through `Save & Fetch`; it clears the input after a successful cache replacement and retains only `subscription.yaml`, validated `subscription.parsed.json`, node count, and fetch time, never the remote URL.
- Only `Save & Fetch` fetches the remote URL and replaces the cache. It must not start or restart Mihomo; a running proxy must be manually stopped and started to apply the new cache. Ordinary startup/restart must read the parsed cache first and safely fall back to the retained source YAML when the parsed cache is absent or invalid.
- Persist desired Proxy running state in `ProxySettings.startOnLaunch`. A successful Start enables it; only explicit Stop disables it. Application shutdown and unexpected Mihomo exit must preserve it.
- Restore enabled running intent asynchronously after the main window and Proxy state broadcast are ready. Auto-start failure must not abort app startup; retain the intent, expose Proxy error state, log the failure, and retry on a later launch.
- Serialize Proxy Start, explicit Stop, internal restart, and shutdown through one lifecycle queue so a later Stop/shutdown cannot be undone by an in-flight Start. Missing-core and child spawn failures must settle to renderer-visible Proxy error state without uncaught process errors.
- Serialize Proxy settings-file writes in invocation order. Before an internal settings restart terminates Mihomo, recheck that Proxy is still running with enabled running intent so a later explicit Stop remains authoritative.
- After a port-change restart, reactivate System Proxy only when Proxy is still running with enabled running intent. Subscription refresh must merge only its metadata into current settings and must not restore a stale full-settings snapshot over a concurrent explicit Stop.
- The Proxy page must show only Mihomo runtime `Selector` strategy groups as manual controls. URL-test, fallback, load-balance, relay, and other automatic groups are not selectable in the UI.
- A selector candidate can be a concrete node, `DIRECT`, `REJECT`, or another strategy group.
- Persist manual choices in `ProxySettings.selectedProxies` as `Record<groupName, candidateName>` and restore each valid choice after startup.
- Read the older `selectedProxy` field only to migrate its value to the detected primary selector group; all new writes use `selectedProxies`.
- If a subscription refresh removes a group or candidate, skip its saved selection without preventing proxy startup.
- Persist Custom Rules in `ProxySettings.customRules` and restore them after reopen. Each rule contains Type, Target (`PROXY` / `DIRECT`), and Value. Support exactly `DOMAIN`, `DOMAIN-SUFFIX`, `DOMAIN-KEYWORD`, `IP-CIDR`, `IP-CIDR6`, `SRC-IP-CIDR`, `GEOIP`, `DST-PORT`, and `SRC-PORT`.
- A `DIRECT` Custom Rule emits a direct rule. A `PROXY` Custom Rule dynamically resolves to the subscription primary selector, or the app-created primary selector for synthesized subscriptions; it skips if no selector exists. Custom Rules run before subscription/synthesized rules. legacy Direct Exceptions migrate to `DIRECT` custom rules, and subsequent settings writes use only `customRules`.

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
- For app-generated canonical UUID identities, resolve existing remote Service Manager units by parsing the complete `service-manager-{hostUuid}-{serviceUuid}.service` shape within the target SSH account; compare the parsed Service UUID exactly and do not require the Host UUID to match the configured Host ID.
- For arbitrary imported IDs, match only the exact conventional unit name. Do not use suffix-only matching because hyphenated or sanitized IDs can alias another service.
- Keep `service-manager-{hostId}-{serviceId}.service` for creation when no existing Service ID match is loaded. Do not rename or migrate existing units.
- Treat multiple matching units for one Service ID as an explicit ambiguity error and do not mutate a candidate automatically.
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
- Proxy Strategy Groups use compact per-group sections with a current selection and safe text-only rendering of dynamic group and candidate names.
- Custom Rules use text-safe custom-rule rendering for all dynamic rule values and actions.
- Proxy controls, Strategy Groups, and Custom Rules must share one white Proxy content container that remains responsive on narrow windows.
- The Host page must retain the outer navigation logo but use no-duplicate-Host-logo behavior in its internal header.
- Section header icons must be local inline SVGs with semantic shapes and enough visual weight to match their titles; the tunnel section should use the filled tunnel glyph, and the service section should use the filled process-grid glyph.
- Empty tunnel/service columns should keep the two-column layout stable.
- Use local inline icons/assets only; do not depend on remote icon assets.
- Page-level notices should be top-right, manually dismissible toasts that remain visible for ten seconds. Modal validation/import feedback stays inside the modal.

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
- Automatic update checks retry transient network failures once and remain quiet after a failed retry; manual update-check failures use a top-right toast.
- Manual update check belongs in the app menu as `Check for Updates...`, not as a home-page quick action.
- README must include unsigned macOS install/quarantine guidance.
- Runtime/build icons come from `assets/source.png` and generated `assets/icon.*` files.
