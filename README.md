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
   - host dialog validation/import errors are surfaced inside the dialog itself, and page-level success/error notices use top-right, manually dismissible toast messages that remain visible for ten seconds
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
   - for app-generated UUID identities, remote service identity is the Service ID within the target SSH account; status, start, stop, and log operations discover an existing canonical `service-manager-{hostUuid}-{serviceUuid}.service` unit without requiring its Host UUID to match the current host configuration.
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
   - a background refresh failure stays inline on the affected service row; an error from a manual service action is also promoted to a top-right toast so the user receives immediate feedback.
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
   - if no existing unit matches the Service ID, `Start` keeps the conventional `service-manager-{hostId}-{serviceId}.service` name; existing units are not renamed or migrated.
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
12. Local Clash-compatible proxy runtime:
    - downloads and runs the platform-specific Mihomo core locally, with one-time `Save & Fetch` subscription input, mode, mixed port, system proxy, TUN, and log controls
    - preserves a Clash-format subscription's proxies, proxy-groups, rules, and providers while overriding only the local runtime controls owned by the app
    - `Save & Fetch` accepts a one-time URL, clears it after successful cache replacement, and retains only the fetched source `subscription.yaml`, validated `subscription.parsed.json`, node count, and fetch time; it never persists the remote URL
    - only `Save & Fetch` fetches the remote URL and replaces the cache; it does not start or restart Mihomo. If the proxy is already running, manually stop and start it to apply the new cached subscription
    - ordinary startup and restart read the parsed cache first; if it is absent or invalid, the runtime safely falls back to the retained source YAML, rebuilds the parsed cache, and does not require a network request
    - Proxy remembers desired running state in `ProxySettings.startOnLaunch`: a successful Start enables restoration, and an explicit Stop disables it
    - application shutdown and unexpected Mihomo exit preserve enabled intent; on the next launch, Service Manager restores Mihomo asynchronously through the ordinary cached-subscription startup path
    - auto-start failure leaves the application open, retains enabled intent for a later launch retry, and exposes the Proxy error state
    - a short-lived Mixed Port release race during auto-start retries after 200 ms, 500 ms, and 1,000 ms; shutdown cancels any pending retry without clearing the saved intent, while explicit Start and every other startup failure keep their original actionable error
    - Proxy Start, Stop, internal restart, shutdown, and System Proxy mutations are serialized; settings-file writes are also serialized, and a queued settings restart rechecks the current running intent so a later Stop remains authoritative. Child spawn failures surface as Proxy errors instead of uncaught process errors
    - choose `Mixed Port` while Proxy is stopped, before starting it; the selected port takes effect only on Start. While Proxy is `starting`, `running`, or `stopping`, the port cannot change
    - before Mihomo spawn, Start probes `127.0.0.1:<port>` for availability. If the port is occupied, it does not start Mihomo and does not overwrite the last saved port
    - only a successful Start persists the selected port with enabled `startOnLaunch`; a failed start or persistence retains the prior port and settings values
    - Save & Fetch merges only subscription metadata so it cannot restore stale running intent
    - `Strategy Groups` shows every manually selectable Mihomo `Selector` group from the running subscription, such as node selection, global direct, or final-match groups
    - each Strategy Group can independently select a node, `DIRECT`, `REJECT`, or another strategy group; automatic URL-test, fallback, load-balance, and relay groups remain non-interactive
    - selections persist per group and are restored after the core starts or the app is reopened; a removed group or candidate is skipped safely after a subscription refresh
    - while running, the `RUNNING` badge shows current download and upload rates from the main-process Mihomo controller stream. `Test Nodes` checks each concrete selectable node once with `http://cp.cloudflare.com/generate_204`, a ten-second timeout, and at most four concurrent requests; routing actions and nested/automatic groups are not tested
    - Mihomo downloads try `https://update.hwdns.net/<official-url>`, then `https://gh-proxy.org/<official-url>`, then the official GitHub URL. A release asset must include a matching SHA-256 digest before it is installed. The two mirrors are trusted distribution endpoints; the digest detects corruption or mismatch but cannot independently authenticate mirror metadata when GitHub metadata is unavailable
    - `Custom Rules` persist in `ProxySettings.customRules`. Each rule contains Type, Target (`PROXY` / `DIRECT`), and Value, and supports `DOMAIN`, `DOMAIN-SUFFIX`, `DOMAIN-KEYWORD`, `IP-CIDR`, `IP-CIDR6`, `SRC-IP-CIDR`, `GEOIP`, `DST-PORT`, and `SRC-PORT`
    - `DIRECT` emits a direct rule. `PROXY` dynamically resolves to the subscription primary selector, or the app-created primary selector for synthesized subscriptions; it skips if no selector exists
    - Custom Rules run before subscription/synthesized rules. legacy Direct Exceptions migrate to `DIRECT` custom rules, and subsequent settings writes use only `customRules`
    - Proxy controls, Strategy Groups, and Custom Rules share one white content container; the Host page keeps the navigation logo only, without a duplicate page logo in its internal header
    - terminal `Ctrl+C` (`SIGINT`) and `SIGTERM` share the normal orderly shutdown path: Service Manager stops owned runtime resources, waits for Mihomo to exit and release its Mixed Port, flushes runtime diagnostics, and then exits without clearing the saved running intent
13. The Hosts header shows total local Service Manager Memory in GB. It aggregates every Electron `app.getAppMetrics()` process and local Mihomo RSS while running, refreshes every five seconds only while Hosts is active, and replaces the former host/tunnel/service count summary. Remote SSH services are excluded, along with system-wide memory.
14. Kubernetes is a local-kubeconfig, strictly read-only cluster browser for Kubernetes 1.28+:
    - it automatically scans direct regular files in the first level of the current user's `.kube` directory and presents every valid kubeconfig Context in one selector. It does not recurse into subdirectories or follow symbolic links. The home-directory path is built with platform path APIs for macOS, Linux, and Windows; it does not depend on shell `~` expansion or `KUBECONFIG`
    - one active Context is connected at a time. Unique Context names display normally; duplicate Context names are qualified as `Context name — filename`, and their stable source-aware selection IDs prevent fallback to a same-named Context in another file
    - the last choice is restored from a user-data preference containing only its stable non-credential selection ID. Kubeconfig contents, absolute source paths, credentials, API URLs, and client transports stay in the main process
    - authentication supports either a token or a complete matching client-certificate/client-key pair, supplied as inline data or matching file paths. `exec` and `auth-provider` authentication are not supported and are rejected before Kubernetes client construction or execution; such Contexts stay visible with an actionable unsupported-authentication state
    - kubeconfig TLS settings and relative certificate/key paths are resolved from each Context's own source file. A Context using `insecure-skip-tls-verify` continuously displays `TLS verification disabled`; a first-level kubeconfig file addition, removal, replacement, or content change prompts for explicit `Reload kubeconfig` confirmation before new credentials or Context metadata are used
    - resource APIs are strictly read-only: there are no create, delete, patch, Apply, Scale, Restart, or Pod lifecycle controls
    - the full-width Kubernetes browser alone uses the available application width rather than the shared centered-content width. Its compact, label-free Context and Namespace selectors share one toolbar row with non-wrapping category and resource controls; there is no UI Cluster category. The visible categories are Workloads, Network, Configuration, Storage, and Custom Resources. Custom Resource Definitions are discovered on demand through the read-only ApiextensionsV1 API; choosing Custom Resources immediately opens its Group/Version/Kind discovery select without an intermediate resource-type button
    - the Namespace dropdown loads the cluster's Namespaces through the read-only API and supports checkbox multi-select between selected Namespaces and the mutually-exclusive All Namespaces shortcut; there is no manual Namespace entry. The Namespace menu stays open during multi-select and closes after an outside pointer press. Nodes and Namespaces remain cluster-scoped regardless of this selection
    - a resource type without RBAC read permission remains visible as `No permission`; that local error does not disconnect the Context or block other resource types
    - each virtual list uses the non-wrapping columns `Namespace, Name, CPU, Memory, Restarts, Status, Node, Age` with 200-item paging and virtual scrolling. Pod CPU and Memory are aggregates of ordinary containers' `resources.requests`, not limits or live metrics. Kubernetes lists are cached only in memory for a short period, while the active-view Watch belongs only to the currently displayed resource type and Namespace scope; the renderer requests only its current bounded virtual range rather than receiving every loaded row on list or Watch updates. Age is derived from normalized string or `Date` creation timestamps, and small table-header sort icons toggle ascending/descending loaded-only sorting. This avoids subscribing to every resource in every Namespace and keeps large Pod lists responsive
    - compact Overview shows exactly Kind, Namespace, Status, Name, and Pod IP in one single-line strip; Name receives the flexible space, long values truncate with their full-value title, and narrower windows scroll the strip internally instead of wrapping it
    - resource details open as read-only right-side overlay drawers. The originating list remains visible underneath, and its active-view Watch and scroll state stay active beneath the drawer. Labels and per-container Env are collapsible; YAML is a header icon action; Events remain read-only and on-demand. The detail header's Port Forward action replaces Copy. Overview metadata, related resources, YAML, Events, and the bottom workspace use bounded internal scrolling when space is constrained. Deployment/StatefulSet related Pods and Service Endpoints/EndpointSlices load only after expansion and never add a Watch
    - each Pod drawer container has Logs and Shell icons that open or focus multiple closable Logs and Shell tabs in the bottom workspace, keyed by namespace, Pod, container, and type. Closing a drawer preserves its tabs; Context change, page leave, disconnect, and shutdown cleanup close them. A Logs tab loads 500 initial lines, follows by default, and keeps a 2,000-line log cap. While following, Follow shows a pause icon; when paused it shows a play icon. A manual upward scroll does not detach follow permanently: the next log update returns the viewport to the bottom, while Pause preserves position and Resume immediately returns to the bottom. The Logs toolbar keeps Logs, Shell, search, Follow, Clear, and Container on one internally scrollable row and exposes no manual older-page action
    - a Shell tab opens or focuses the matching Pod session in the reusable bottom workspace and tries `/bin/sh`, then `ash`, then `bash`; each newly opened terminal scrolls into view and is focused for immediate input, while terminal input preserves spaces, Enter, and xterm control sequences exactly within the bounded IPC payload
    - the header Port Forward dialog uses Pod regular containers and restartable native sidecar init containers to discover declared TCP ports, and uses a Service's `spec.ports[].port`; declared ports are not proof that a listener is running. With zero declarations, manual Remote Port entry remains available; with one declaration, the editable Remote Port prefills; with multiple declarations, the user selects a declared port or enters a Remote Port manually. Pod and Service forwards can use an automatic or selected local port; at most ten active port forwards are allowed. Forwards survive a detail drawer close, but stop on Context switch, disconnect, or application exit
    - `secretKeyRef` and `envFrom.secretRef` values are decoded only through a narrow request in the main process for the active drawer. The result is bounded and locally searchable, and is never placed in caches, settings, runtime logs, diagnostics, or disk. Secret list caches remove `data` and `stringData`; decoded Secret detail values exist only in the active viewer
    - a transport disconnect (including an unexpectedly closed Watch stream) closes Watches, log/terminal streams, and forwards; the current resource page reconnects with bounded exponential backoff and reloads after success, but forwards are never recreated automatically. A supported disconnected Context also exposes a manual `Reconnect` action; it only reconnects and reloads the active read-only view

## Tech Stack

- Electron
- TypeScript
- Tailwind CSS renderer component/utilities layer (`tailwind.css`, preflight disabled)
- `ssh2` (SSH connection and remote command execution)
- `asn1` (explicit dependency required by ssh2 stack in this project)
- `@kubernetes/client-node` (main-process read-only Kubernetes REST, Watch, log, exec, and port-forward client)
- `@xterm/xterm` and `@xterm/addon-fit` (Kubernetes bottom workspace)
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
- `src/main/proxy/proxyRuntime.ts`: local Mihomo process lifecycle, parsed-cache loading/replacement, persisted proxy settings and Custom Rule mutations, and system/TUN proxy controls
- `src/main/proxy/subscriptionCache.ts`: versioned parsed-subscription cache serialization and validation
- `src/main/proxy/proxyExceptions.ts`: Custom Rule validation, normalization, migration, and target-aware Mihomo rule generation
- `src/main/proxy/proxyGroups.ts`: pure conversion, selection validation, and saved-selection compatibility helpers for Mihomo runtime groups
- `src/main/appMemory.ts`: local Electron and Mihomo working-set collection for the Hosts header Memory total
- `src/main/kubernetes/kubeconfigStore.ts`: local kubeconfig classification, safe Context metadata, Namespace normalization, and reload detection
- `src/main/kubernetes/contextPreference.ts`: durable Context-name-only user-data preference; no kubeconfig credentials or resources persist here
- `src/main/kubernetes/kubernetesClient.ts`: main-process-only Kubernetes client adapter for read/list/watch/detail/events, on-demand CRD discovery, logs, Pod exec, port forwards, and on-demand related-resource reads
- `src/main/kubernetes/terminalInput.ts`: bounded exact-input validation for Kubernetes terminal keyboard/control data
- `src/main/kubernetes/clusterSession.ts`: one active Context connection, categorized reconnect behavior, and ordered resource disposal
- `src/main/kubernetes/resourceQuery.ts` / `src/main/kubernetes/resourceCache.ts`: normalized query keys, loaded-only projection, virtual-window primitives, and bounded in-memory request/cache deduplication
- `src/main/kubernetes/resourceCoordinator.ts`: 200-item active-view LIST paging, shared Watch lifecycle, resourceVersion reconciliation, and 410 relist recovery
- `src/main/kubernetes/podSummary.ts`: safe Pod-list CPU, Memory, restart, and node summary projection from ordinary-container requests
- `src/main/kubernetes/podEnvironment.ts`: bounded active-drawer Pod environment and Secret-reference resolution with non-persistence boundaries
- `src/main/kubernetes/podInteractions.ts`: bounded logs, terminal shell fallback/session lifecycle, and ten-forward ownership
- `src/main/kubernetes/kubernetesRuntime.ts`: renderer-safe Kubernetes lifecycle facade, Context-preference restore, bounded resource-window IPC, and resource interactions
- `src/renderer/renderer.ts`: UI orchestration and DOM event wiring
- `src/renderer/kubernetesPage.ts`: full-width Kubernetes controls/lists, right-side overlay drawers, text-safe browser-YAML rendering, on-demand relations, workspace, and forwards UI
- `src/renderer/kubernetesDrawerModel.ts`: pure display-safe Pod drawer fields, container metadata, and active-drawer environment filtering helpers
- `src/renderer/kubernetesDetailModel.ts`: pure compact Overview-field and declared TCP-port discovery/dialog helpers
- `src/renderer/kubernetesVirtualTable.ts`: fixed-row virtual scrolling and request-animation-frame bounded range requests
- `src/renderer/kubernetesWorkspace.ts`: reusable multi-tab bottom Logs/Shell workspace with close and lifecycle disposal ownership
- `src/renderer/kubernetesTerminal.ts`: reusable xterm pane for the selected bottom-workspace Shell tab, preserving exact input and shell fallback behavior
- `src/renderer/tailwind.css`: primary renderer visual layer built with Tailwind `@layer components` and `@apply`; generated output is `dist/renderer/tailwind.css`
- `src/renderer/styles.css`: base-only renderer CSS for local fonts, CSS variables, browser defaults, and ANSI log helpers
- `src/renderer/html.ts`: dynamic HTML escaping and ANSI-to-HTML rendering helpers
- `src/renderer/status.ts`: shared renderer status formatting and action-state helpers
- `tailwind.config.cjs`: Tailwind content/theme configuration; preflight is disabled to avoid global reset drift
- `scripts/build-tailwind.cjs`: Tailwind CSS build wrapper
- `scripts/copy-renderer.cjs`: renderer static asset copy helper, including local xterm and `js-yaml` browser assets
- `src/shared/types.ts`: shared type contracts
- `tests/*.test.js`: Node built-in test runner coverage for extracted main-process pure/runtime helpers
- `assets/source.png` + `assets/icon.*`: app icon source and generated icons (rounded white background) used by runtime/build
- `dist/*`: compiled output (generated)

## Development

Install dependencies manually (as requested):

1. `pnpm install`
2. `pnpm dev`

When Kubernetes/xterm dependency versions change, update the manifest and have the user run `pnpm install` before building or running the app. Do not install dependencies automatically.

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
- Automatic checks retry once after a transient network error. If the retry also fails, the app records the failure in its runtime log without interrupting the page.
- A manual update check surfaces failures as a short-lived top-right notification.
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
- the app distinguishes an SSH timeout or other SSH failure from an unavailable `systemd --user` D-Bus session and from another `systemctl --user` check failure
- a transient user-manager transport or D-Bus failure receives one retry before the operation fails
- fix the reported remote user-session configuration before using service management

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

## Service Runtime Diagnostics

For later troubleshooting of intermittent SSH or `systemd` service failures, the app records structured local diagnostics in Electron's user-data directory at `logs/runtime.jsonl` (that is, `<userData>/logs/runtime.jsonl`). When the active file would exceed 1 MiB, it is rotated to `runtime.previous.jsonl`; only the current file and one previous file are retained.

These diagnostics are deliberately narrow: they capture app/runtime and `systemd` preflight failure scope, category, attempt, timing, and other safe context needed to investigate a later failure. Sensitive material—including passwords, passphrases, private keys, tokens, authorization/cookie data, subscription URLs, and command text—is redacted or omitted. This local diagnostic stream is not a replacement for the service's `journalctl --user` logs.

Remote service preflight reports differentiated failures for SSH timeout/connection errors, missing required systemd tools, unavailable user-manager D-Bus sessions, other tooling or user-manager check failures, and lingering failures. A disabled linger setting continues to provide the `sudo loginctl enable-linger <username>` setup guidance.

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
- A Host ID change does not detach an app-generated UUID service from its existing unit as long as exactly one canonical unit with that Service ID is loaded in the target SSH account. Arbitrary imported IDs use only the exact conventional unit name because suffix matching would be ambiguous.
- Multiple units with the same Service ID in one remote user manager are treated as ambiguous and are not mutated automatically.
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
    - Proxy subscriptions keep their own routing policy. The Proxy page surfaces only runtime Mihomo `Selector` Strategy Groups as manual controls, and stores their choices as a group-name-to-candidate map so `全球直连`, `漏网之鱼`, and other independent policy groups retain separate selections.
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
