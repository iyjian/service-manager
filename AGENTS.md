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
- Use `@kubernetes/client-node` for Kubernetes operations; do not shell out to `kubectl` or another system command.
- Keep `asn1` explicitly declared as a dependency.
- Do not install dependencies yourself. If dependencies are needed, stop and ask the user to run `pnpm install`.
- When Kubernetes/xterm dependency versions change, update the manifest and require the user to run `pnpm install` before build or runtime work resumes.
- Important changes must update both `README.md` and `AGENTS.md` when they affect features, architecture, runtime behavior, command flow, data model, limits, or developer workflow.
- Prefer incremental changes with tests.

## Current Architecture

- `src/main/main.ts`: Electron app/window/menu wiring and IPC orchestration.
- `src/main/validation.ts`: host, forwarding-rule, and service draft validation.
- `src/main/configTransfer.ts`: config import/export parsing, counting, and imported-ID normalization.
- `src/main/runtimeRegistry.ts`: in-memory service/forward runtime state and `HostView` assembly.
- `src/main/operationQueue.ts`: per-host/service async serialization for service mutations.
- `src/main/hostConnection.ts`: shared SSH endpoint and private-key resolution.
- `src/main/serviceRuntime.ts`: remote `systemd --user` lifecycle, categorized preflight checks, status checks, and journal log access.
- `src/main/runtimeLog.ts`: serialized, redacted local runtime diagnostic JSONL writer with 1 MiB current-file rotation.
- `src/main/portForwardManager.ts`: service-owned local port forwarding.
- `src/main/tunnelManager.ts`: forwarding-rule runtime and reconnect behavior.
- `src/main/proxy/proxyRuntime.ts`: local Mihomo lifecycle, parsed-cache loading/replacement, transient traffic/delay state, persisted settings and Custom Rule mutations, and system/TUN proxy controls.
- `src/main/proxy/proxyAutoStart.ts`: non-blocking Proxy running-intent restoration, bounded Mixed Port release retry, and startup error routing.
- `src/main/proxy/trafficStream.ts`: safe framing and validation of the Mihomo controller's sequential traffic stream.
- `src/main/proxy/proxyDelays.ts`: concrete selector-node filtering and bounded Mihomo delay-test execution.
- `src/main/proxy/subscriptionCache.ts`: versioned parsed-subscription cache serialization and validation.
- `src/main/proxy/proxyExceptions.ts`: Custom Rule validation, normalization, migration, and target-aware Mihomo rule generation.
- `src/main/proxy/proxyGroups.ts`: pure Mihomo runtime group conversion, manual-selector validation, and saved-selection compatibility helpers.
- `src/main/appMemory.ts`: local Electron and Mihomo working-set collection for the Hosts header Memory total.
- `src/main/kubernetes/kubeconfigStore.ts`: safe local kubeconfig Context/auth/TLS classification, Namespace-scope normalization, and file-reload detection.
- `src/main/kubernetes/kubeconfigCatalog.ts`: cross-platform first-level `.kube` discovery, invalid-file isolation, duplicate-Context labeling, stable source IDs, credential-sensitive fingerprints, and main-process-only source resolution.
- `src/main/kubernetes/contextPreference.ts`: durable user-data stable Context selection-ID preference only; it never stores kubeconfig credentials, absolute paths, or resource data.
- `src/main/kubernetes/kubernetesClient.ts`: main-process Kubernetes REST, CRD discovery, Watch, log, exec, port-forward, and on-demand relation adapter.
- `src/main/kubernetes/terminalInput.ts`: exact, bounded validation for Kubernetes terminal keyboard and control input.
- `src/main/kubernetes/clusterSession.ts`: one active Context session, categorized reconnect/retry, and ordered owned-resource disposal.
- `src/main/kubernetes/resourceQuery.ts`: stable resource keys, safe resource summaries, loaded-only projection, and virtual-window primitives.
- `src/main/kubernetes/resourceCache.ts`: two-minute bounded in-memory LRU and in-flight request deduplication.
- `src/main/kubernetes/resourceCoordinator.ts`: 200-item active-view LIST paging, shared Watch lifecycle, resourceVersion reconciliation, and 410 relist recovery.
- `src/main/kubernetes/podInteractions.ts`: 2,000-line bounded logs, terminal shell fallback/session ownership, and ten-forward lifecycle.
- `src/main/kubernetes/kubernetesRuntime.ts`: display-safe facade composing kubeconfig, persisted Context preference, session, resources, and Pod interactions for IPC.
- `src/renderer/renderer.ts`: UI orchestration and DOM event wiring.
- `src/renderer/kubernetesPage.ts`: Context/Namespace controls, category tables, full-page details, text-safe browser-YAML rendering, Events, on-demand relations, logs, and forward UI.
- `src/renderer/kubernetesDetailModel.ts`: pure compact Overview-field and declared TCP-port discovery/dialog helpers.
- `src/renderer/kubernetesVirtualTable.ts`: fixed-row virtual scrolling with request-animation-frame range requests; it never owns the complete loaded resource array.
- `src/renderer/kubernetesTerminal.ts`: global xterm terminal drawer and terminal session bridge.
- `src/renderer/tailwind.css`: primary renderer visual layer using Tailwind `@layer components` and `@apply`; generated output is `dist/renderer/tailwind.css`.
- `src/renderer/styles.css`: base-only renderer CSS for local fonts, CSS variables, browser defaults, and ANSI log helpers.
- `src/renderer/html.ts`: dynamic HTML escaping and ANSI-to-HTML rendering.
- `src/renderer/status.ts`: renderer status formatting and action-state helpers.
- `tailwind.config.cjs`: Tailwind content/theme configuration with preflight disabled to avoid global reset drift.
- `scripts/build-tailwind.cjs`: Tailwind CSS build wrapper.
- `scripts/copy-renderer.cjs`: renderer static asset copy helper, including local xterm and `js-yaml` browser assets.
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
- Only an auto-start Mixed Port conflict retries, after 200 ms, 500 ms, and 1,000 ms. Shutdown cancels a pending retry without clearing `startOnLaunch`. Explicit Start, missing-core, controller, download, and other failures do not retry.
- Serialize Proxy Start, explicit Stop, internal restart, shutdown, and complete System Proxy mutations through one lifecycle queue so a later Stop/shutdown cannot be undone by an in-flight Start or OS proxy activation. Missing-core and child spawn failures must settle to renderer-visible Proxy error state without uncaught process errors.
- Serialize Proxy settings-file writes in invocation order. Before an internal settings restart terminates Mihomo, recheck that Proxy is still running with enabled running intent so a later explicit Stop remains authoritative.
- Choose Mixed Port while Proxy is stopped, before starting it; the selected port takes effect only on Start. While Proxy is `starting`, `running`, or `stopping`, the port cannot change.
- Before Mihomo spawn, Start probes `127.0.0.1:<port>` for availability. If the port is occupied, it does not start Mihomo and does not overwrite the last saved port.
- Shutdown keeps the owned Mihomo child reference until its exit event. It sends `SIGTERM`, escalates to `SIGKILL` after three seconds only when needed, and does not complete runtime shutdown before that child exits and releases its Mixed Port.
- `before-quit`, `SIGINT`, and `SIGTERM` use one idempotent shutdown coordinator. It stops only app-owned updater/forward/tunnel/proxy resources, flushes runtime diagnostics, preserves Proxy `startOnLaunch`, and exits once cleanup settles.
- Only a successful Start persists the selected port with enabled `startOnLaunch`; a failed start or persistence retains the prior port and settings values.
- Subscription refresh must merge only its metadata into current settings and must not restore a stale full-settings snapshot over a concurrent explicit Stop.
- The Proxy page must show only Mihomo runtime `Selector` strategy groups as manual controls. URL-test, fallback, load-balance, relay, and other automatic groups are not selectable in the UI.
- While running, the Proxy header shows authenticated controller traffic rates. `Test Nodes` tests concrete selectable nodes only, through `http://cp.cloudflare.com/generate_204`, with a 10-second timeout and no more than four concurrent requests; routing actions and nested/automatic groups are skipped.
- Mihomo download tries `https://update.hwdns.net/<official-url>`, then `https://gh-proxy.org/<official-url>`, then direct GitHub. Each release archive requires a matching SHA-256 asset digest. Approved mirror digests detect corruption or mismatch but cannot cryptographically authenticate mirrored metadata when GitHub metadata is unavailable.
- A selector candidate can be a concrete node, `DIRECT`, `REJECT`, or another strategy group.
- Persist manual choices in `ProxySettings.selectedProxies` as `Record<groupName, candidateName>` and restore each valid choice after startup.
- Read the older `selectedProxy` field only to migrate its value to the detected primary selector group; all new writes use `selectedProxies`.
- If a subscription refresh removes a group or candidate, skip its saved selection without preventing proxy startup.
- Persist Custom Rules in `ProxySettings.customRules` and restore them after reopen. Each rule contains Type, Target (`PROXY` / `DIRECT`), and Value. Support exactly `DOMAIN`, `DOMAIN-SUFFIX`, `DOMAIN-KEYWORD`, `IP-CIDR`, `IP-CIDR6`, `SRC-IP-CIDR`, `GEOIP`, `DST-PORT`, and `SRC-PORT`.
- A `DIRECT` Custom Rule emits a direct rule. A `PROXY` Custom Rule dynamically resolves to the subscription primary selector, or the app-created primary selector for synthesized subscriptions; it skips if no selector exists. Custom Rules run before subscription/synthesized rules. legacy Direct Exceptions migrate to `DIRECT` custom rules, and subsequent settings writes use only `customRules`.

Kubernetes:

- Support Kubernetes 1.28+ through the Kubernetes tab. On macOS, Linux, and Windows, derive the current user's `.kube` directory with platform path APIs and scan only its first-level direct regular files; do not recurse into subdirectories, follow symbolic links, expand `~`, or depend on `KUBECONFIG`. Skip invalid/non-kubeconfig candidates without blocking valid files. One active Context is connected at a time.
- Keep absolute kubeconfig paths and the stable selection-ID-to-source mapping in the main process. Unique Context names display normally; duplicate Context names display as `Context name — filename`. Persist only the stable non-credential selection ID, never credentials, kubeconfig contents, API URLs, or absolute paths, and never fall back to a same-named Context from another file when a saved source disappears.
- Support either kubeconfig token authentication or a complete matching client-certificate/client-key pair, supplied as inline data or matching file paths. Detect `exec` and `auth-provider` authentication as not supported; reject them before Kubernetes client construction or execution, and leave the Context visible with an actionable unsupported-auth state.
- Honor `insecure-skip-tls-verify` but display a persistent `TLS verification disabled` warning. Resolve relative certificate/key paths from each Context's own kubeconfig file. Watch the `.kube` directory and require explicit reload confirmation before applying added, removed, replaced, or changed Context or credential data.
- Kubernetes resource APIs are strictly read-only. Do not add create, delete, patch, edit, Apply, Scale, Restart, or Pod lifecycle controls.
- Categories are Workloads (Pods, Deployments, StatefulSets), Network (Services, Ingresses), Configuration (ConfigMaps, Secrets), Storage (PVC), Cluster (Nodes, Namespaces), and dynamically discovered Custom Resources. Discover CRDs only when that category is active, through read-only ApiextensionsV1 API; choosing Custom Resources must immediately show its Group/Version/Kind select without a redundant resource-type button.
- Keep Context and Namespace controls on one row. The Namespace dropdown lists cluster-discovered Namespaces through a read-only paged request and provides checkbox multi-select between selected Namespaces and the mutually-exclusive All Namespaces shortcut, with no manual Namespace entry. Keep the Namespace menu open during multi-select and close it after an outside pointer press. All Namespaces uses one active scope-wide Watch for the current resource type only; Nodes and Namespaces remain cluster-scoped.
- Each resource query key includes Context, group/version/kind, Namespace scope, and server-side label/field selectors. Identical in-flight requests are deduplicated. Initial and continuation requests use 200-item paging; inactive query/cache entries are in-memory only, bounded by LRU, and expire after two minutes.
- Lists must use virtual scrolling. Search and local sort apply only to loaded items in the main process after a 200 ms debounce; expose sorting through small table-header sort icons that toggle direction, not separate sort selects or explanatory hint text. Normalize valid string and `Date` creation timestamps before IPC so Age is present and sortable. The renderer requests/coalesces bounded current virtual windows and never receives or clones a complete loaded collection on a Watch/list update.
- Only the current resource page owns an active-view Watch. Leaving the resource type/Kubernetes page stops its Watch; Context switch, disconnect, and application shutdown close Watch transports, logs, terminal sessions, and port forwards. A 410/expired Watch relists the active query before restart; another Watch ERROR, including a client-node `done(null)` stream closure, stops that Watch, reports local 401/403 as `No permission`, and routes a recoverable transport failure through Context reconnect.
- A resource-level RBAC 401/403 is a local `No permission` state and never marks the entire Context unavailable. Transport failures retry with bounded exponential backoff, reload the active resource page after reconnect, and never recreate forwards automatically. A supported disconnected Context exposes a manual read-only `Reconnect` action; it reconnects and restores only the active view.
- Details are full-page, read-only Overview/YAML/Events views presented as a single-screen workbench at the default 1230×820 window size. The page frame never grows with detail content; Overview, YAML, Events, relations, and Logs use bounded internal scrolling when space is constrained. Compact Overview shows exactly Kind, Namespace, Status, Name, and Pod IP in one single-line strip; Name is flexible, values truncate with their full-value title, and narrow widths scroll the strip internally instead of wrapping. The detail header's Port Forward action replaces Copy. Events, Service Endpoints/EndpointSlices, and Workload selector-matched Pods are on-demand reads only and never create a Watch.
- Pod logs open automatically for the active Pod/container, start with 500 lines, follow by default, and retain at most 2,000-line log entries per viewer. While following, the control shows a pause icon; when paused, it shows a play icon. Every new log update returns a following viewport to the latest line even after manual upward scrolling; Pause preserves position and Resume immediately returns to the bottom. The Logs toolbar keeps Logs, Terminal, search, Follow, Clear, and Container on one internally scrollable row and exposes no manual older-page action. The log buffer, all Pod terminal sessions, and their streams are disposed on page leave, Context switch, disconnect, and shutdown.
- Selecting the Terminal tab opens or focuses the matching Pod session through the global terminal drawer; there is no Open Terminal button. The global terminal drawer supports multiple sessions and tries `/bin/sh`, then `ash`, then `bash`. Scroll each newly opened terminal into view and keep it focused for immediate input. Terminal input must preserve spaces, Enter, and xterm control sequences exactly while enforcing the bounded IPC payload; expose no shell credentials to the renderer beyond display-safe output/events.
- The header Port Forward dialog uses Pod regular containers and restartable native sidecar init containers to discover declared TCP ports, and uses a Service's `spec.ports[].port`; declared ports are not proof that a listener is running. With zero declarations, manual Remote Port entry remains available; with one declaration, the editable Remote Port prefills; with multiple declarations, the user selects a declared port or enters a Remote Port manually. Pod and Service port forwarding supports an auto-selected or manually chosen local port, with at most ten active port forwards. A forward survives detail close but stops on manual stop, Context switch, disconnect, or app shutdown; no unrelated process is terminated for a port conflict.
- Secret list summaries strip `data` and `stringData`. Decoded Secret detail exists only in the active viewer and Secret data never persists to settings, caches, runtime logs, diagnostics, or disk.

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
- Categorize systemd preflight failures as SSH timeout/failure, missing tools, unavailable user-manager D-Bus, tooling/user-manager check failures, or linger failures. Retry only a transient user-manager transport or D-Bus failure once; never mask the final categorized error.

Logs:

- Open logs from the service name in the list.
- Read logs with `journalctl --user` for the current unit invocation.
- Preserve stdout/stderr ordering as a single terminal-like stream.
- Render ANSI colors, auto-refresh, auto-scroll toggle, older-line loading, search, and filter.
- Log dialog is read-only and must catch failures without uncaught renderer promises.
- Local runtime diagnostics for later intermittent SSH/systemd troubleshooting are written under Electron `<userData>/logs/runtime.jsonl`. Rotate the active file to `runtime.previous.jsonl` before it exceeds 1 MiB, retaining only those two files. Store only a redacted, safe diagnostic scope and context; omit or redact credentials, keys, tokens, URLs, and command text.

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
- Keep background service-refresh failures inline on the affected row; manual service-action failures also receive top-right toast feedback.
- Proxy Strategy Groups use compact per-group sections with a current selection and safe text-only rendering of dynamic group and candidate names.
- Custom Rules use text-safe custom-rule rendering for all dynamic rule values and actions.
- Proxy controls, Strategy Groups, and Custom Rules must share one white Proxy content container that remains responsive on narrow windows.
- The Kubernetes tab follows the existing white content-container style: Context selector, TLS/disconnect state, selected Namespace scope, category tabs, and virtual resource tables. Resource details are full-page and preserve the originating list's loaded pages, filters, sort, and scroll position on return. The default 1230×820 detail workbench must fit without document scrolling; smaller windows keep primary controls visible and move overflow into the active content and Logs regions. Empty Port Forwards UI stays hidden, and active forwards plus the global terminal drawer remain viewport-contained layers.
- Kubernetes dynamic values, including resource names, labels, YAML, Events, logs, and terminal output, must use DOM nodes and `textContent`; never insert Kubernetes-derived values with `innerHTML`.
- Kubernetes YAML uses the copied local `js-yaml` browser asset and renders through `textContent`. Decoded Secret YAML remains only in the active detail DOM and is cleared when that detail closes or changes.
- Kubernetes terminals belong in the global Kubernetes drawer. Leaving the Kubernetes tab stops Watches, logs, and terminal sessions, while explicit port forwards remain until their Context lifecycle ends.
- The Host page must retain the outer navigation logo but use no-duplicate-Host-logo behavior in its internal header.
- Section header icons must be local inline SVGs with semantic shapes and enough visual weight to match their titles; the tunnel section should use the filled tunnel glyph, and the service section should use the filled process-grid glyph.
- Empty tunnel/service columns should keep the two-column layout stable.
- Use local inline icons/assets only; do not depend on remote icon assets.
- Page-level notices should be top-right, manually dismissible toasts that remain visible for ten seconds. Modal validation/import feedback stays inside the modal.

## Safety Requirements

- Renderer must escape dynamic HTML derived from host, service, tunnel, log, or error data before injecting into the DOM.
- Renderer runtime failures should be surfaced through page toasts instead of failing silently.
- Main process must log top-level `uncaughtException`, `unhandledRejection`, renderer-process exits, and IPC broadcast failures.
- Runtime diagnostic logging must be best-effort and must never interrupt lifecycle handling. Redact sensitive error/context material before local persistence.
- Kubeconfig bytes, absolute source paths, stable-ID source mappings, tokens, client certificates/keys, client transport handles, and terminal/port-forward credentials stay in the main process and never cross renderer IPC.
- Kubernetes Secret `data`/`stringData` must be absent from list/cache/diagnostic/settings data. Decode only for the active resource-detail viewer, clear it when that viewer closes or changes, and never log it.
- Dialog open/close paths must be idempotent.
- Missing remote `systemd --user` support must fail explicitly with setup guidance; never silently switch to an unmanaged process model.

## Testing

- Run `pnpm test` after behavioral or architecture changes.
- `pnpm test` must build first, then run `node --test tests/*.test.js`.
- Add `node:test` coverage for extracted pure logic, runtime orchestration helpers, import/export behavior, and command-building logic.
- Kubernetes changes need coverage for safe kubeconfig classification, query/cache deduplication, 200-item paging, virtual scrolling, Watch cleanup/410 recovery, logs/terminals/forwards, Secret non-persistence, local RBAC failure, and renderer-safe IPC.
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
