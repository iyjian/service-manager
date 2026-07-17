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
- `src/main/portForwardManager.ts`: service-owned local port forwarding with active-socket ownership, failed-listen cleanup, and cancellation-fenced in-flight starts for bounded shutdown.
- `src/main/tunnelManager.ts`: forwarding-rule runtime and reconnect behavior.
- `src/main/quitCoordinator.ts`: single-flight normal/signal/update quit intent merging with an eight-second cleanup deadline before the final Electron or installer action; main-process final actions have a short forced-exit fallback after graceful cleanup.
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
- `src/main/kubernetes/kubernetesClient.ts`: main-process Kubernetes REST with a read-only Version reachability probe, CRD discovery, UID-checked Pod→ReplicaSet→Deployment log-target resolution, Watch, log, UTF-8/TTY-bootstrapped exec with streaming output decoding, port-forward, UID-checked KubeVirt VNC ownership, and on-demand relation adapter.
- `src/main/kubernetes/customResourcePrinterColumns.ts`: bounded non-executable CRD printer JSONPath normalization, first-result/type formatting, and visible-list column selection.
- `src/main/kubernetes/kubeVirtVnc.ts`: strict Running virt-launcher/VMI recognition, KubeConfig-authenticated `plain.kubevirt.io` transport, bounded RFB handshake termination, and the loopback bridge with macOS single-use VNCAuth compatibility.
- `src/main/kubernetes/podExecTransport.ts`: silent portable Pod-shell locale/TERM/TTY bootstrap command construction and incremental UTF-8 stream decoding.
- `src/main/kubernetes/resourceSummary.ts`: bounded resource-specific LIST/Watch summary extraction, including Secret count-only projection before payload stripping.
- `src/main/kubernetes/terminalInput.ts`: exact, bounded validation for Kubernetes terminal keyboard and control input.
- `src/main/kubernetes/clusterSession.ts`: one active Context session, probe-before-connected state publication, categorized reconnect/retry, and ordered owned-resource disposal.
- `src/main/kubernetes/resourceQuery.ts`: stable resource keys, safe resource summaries, loaded-only projection, and virtual-window primitives.
- `src/main/kubernetes/resourceCache.ts`: two-minute bounded in-memory LRU and in-flight request deduplication.
- `src/main/kubernetes/resourceCoordinator.ts`: 200-item active-view LIST paging, shared Watch lifecycle, resourceVersion reconciliation, and 410 relist recovery.
- `src/main/kubernetes/podSummary.ts`: safe Pod-list CPU, Memory, restart, and node summary projection from ordinary-container requests.
- `src/main/kubernetes/podEnvironment.ts`: bounded active-drawer Pod environment and Secret-reference resolution with non-persistence boundaries.
- `src/main/kubernetes/podInteractions.ts`: 2,000-line bounded single-Pod/Deployment aggregate logs with multi-stream and start-time snapshot generation fencing, terminal shell fallback/session ownership and first-output readiness gating, and ten-forward lifecycle.
- `src/main/kubernetes/kubernetesRuntime.ts`: display-safe facade composing kubeconfig, persisted Context preference, Context-scoped single-flight recovery, session, resources, and Pod interactions for IPC.
- `src/renderer/renderer.ts`: UI orchestration and DOM event wiring.
- `src/renderer/kubernetesPage.ts`: full-width Context/Namespace controls with an unclipped Namespace popup, category lists, right-side overlay drawers with aligned Labels and fully expanded Env rows, text-safe browser-YAML rendering, Events, on-demand relations, bottom workspace, and count-backed Forwarded Ports dialog.
- `src/renderer/kubernetesDrawerModel.ts`: pure display-safe Pod drawer fields, container metadata, and active-drawer environment filtering helpers.
- `src/renderer/kubernetesDetailModel.ts`: pure compact Overview-field and declared TCP-port discovery/dialog helpers.
- `src/renderer/kubernetesCustomResourcePrinterColumns.ts`: renderer-local bounded printer JSONPath reader for Custom Resource details.
- `src/renderer/kubernetesCustomResourceModel.ts`: Lens-style Custom Resource Properties, bounded metadata, and condition-fallback model.
- `src/renderer/kubernetesVirtualTable.ts`: fixed-row virtual scrolling with request-animation-frame range requests; it never owns the complete loaded resource array.
- `src/renderer/kubernetesWorkspace.ts`: reusable multi-tab bottom Logs/Shell workspace with Deployment scope switches, second-precision log start-time snapshots, post-layout paused-scroll restoration, half-page first-Shell sizing, compact target-only type-accessible tab visuals, integrated SVG close controls, bounded pointer/keyboard height resizing, a bounded pre-bind renderer terminal-output bridge, and exact tab/session lifecycle-disposal ownership.
- `src/renderer/kubernetesTerminal.ts`: reusable xterm pane retaining exact-session views for bottom-workspace Shell tabs; selected views detach/reparent and refit after workspace resizing without recreation, preserving prompt, scrollback, exact-session output, and exact input/shell fallback behavior.
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
- `before-quit`, `SIGINT`, `SIGTERM`, and update installation use one idempotent shutdown coordinator. It stops only app-owned updater/forward/tunnel/proxy/Kubernetes resources, flushes runtime diagnostics, preserves Proxy `startOnLaunch`, and performs the final quit, signal exit, or installer launch after cleanup settles. An eight-second final deadline reports a best-effort diagnostic and continues the final action if any cleanup remains stuck. After that final Electron action begins, a 1.5-second process-exit fallback prevents a leftover framework/debug/network handle from stranding the executable. A downloaded Windows NSIS update must never launch before cleanup settles or the eight-second deadline expires.
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
- Honor `insecure-skip-tls-verify` without displaying a separate TLS warning; the connection badge is the only visible connection-state indicator. Resolve relative certificate/key paths from each Context's own kubeconfig file. Watch the `.kube` directory and require explicit reload confirmation before applying added, removed, replaced, or changed Context or credential data.
- Kubernetes resource APIs are strictly read-only. Do not add create, delete, patch, edit, Apply, Scale, Restart, or Pod lifecycle controls.
- Kubernetes alone uses the available application width as the full-width Kubernetes browser rather than the shared centered-content width. Context and Namespace use matching compact custom selector components on one label-free toolbar row with non-wrapping category and resource controls; keep Context narrower than Namespace and keep every option on one line. Namespace and Custom Resource popups must remain unclipped while category, resource, and secondary control strips retain their own horizontal scrolling. There is no UI Cluster category. Categories are Workloads (Pods, Deployments, StatefulSets), Network (Services, Ingresses), Configuration (ConfigMaps, Secrets), Storage (PVC), and dynamically discovered Custom Resources. Discover CRDs only when that category is active, through read-only ApiextensionsV1 API; choosing Custom Resources must immediately show a compact locally searchable Kind/group/version selector matching the Namespace component, without a redundant resource-type button. A confirmed kubeconfig reload must invalidate and rediscover CRD metadata even after delayed reconnect; a transient transport reconnect may retain authorized metadata to restore the active list. CRD-discovery 401/403 remains a resource-local `No permission` state rather than failing the Context reload.
- Keep Context and Namespace controls on one row. The searchable Namespace dropdown lists active-Context Namespaces through a read-only paged request, provides a compact local filter, and provides checkbox multi-select between selected Namespaces and the mutually-exclusive `All` menu item, with no manual Namespace entry. A real Context change must invalidate/reload the Namespace list, clear the filter, and reset scope to All Namespaces. Keep the unclipped Namespace menu open during search and multi-select and close it after an outside pointer press. All Namespaces uses one active scope-wide Watch for the current resource type only; Nodes and Namespaces remain cluster-scoped.
- Each resource query key includes Context, group/version/kind, Namespace scope, and server-side label/field selectors. Identical in-flight requests are deduplicated. Initial and continuation requests use 200-item paging; inactive query/cache entries are in-memory only, bounded by LRU, and expire after two minutes.
- Lists must use virtual scrolling; each per-resource list uses eight columns with non-wrapping values. Pods use `Namespace, Name, CPU, Memory, Restarts, Status, Node, Age`; Deployments/StatefulSets expose replica rollout fields; Services expose type/IPs/ports/selector; Ingresses expose class/hosts/address/ports/TLS; ConfigMaps/Secrets expose safe entry and metadata counts; PVCs expose status/volume/capacity/access modes/Storage Class. Custom Resources prioritize CRD `additionalPrinterColumns` like Lens and fill unused slots with bounded generic fields. Evaluate/cache/send only printer values that fit the visible eight-column list; retain full safe printer metadata for details. Printer JSONPath is a bounded non-executable subset, takes the first result, obeys declared string/integer/number/boolean/date types, and retains original CRD indices across priority ordering. Secret summaries may derive only a top-level data-entry count before recursively stripping `data` and `stringData`; never expose Secret keys or values. Pod CPU and Memory are aggregates of ordinary containers' `resources.requests`, not limits or live metrics. Search and local sort apply only to loaded items in the main process after a 200 ms debounce; replica ratios, integer counts, and typed printer columns compare numerically/type-aware. Expose sorting through small table-header sort icons that toggle direction, not separate sort selects or explanatory hint text. Normalize valid string and `Date` creation timestamps before IPC so Age is present and sortable. The renderer requests/coalesces bounded current virtual windows and never receives or clones a complete loaded collection on a Watch/list update.
- Only the current resource page owns an active-view Watch. Leaving the resource type/Kubernetes page stops its Watch; Context switch, disconnect, and application shutdown close Watch transports, logs, terminal sessions and retained local xterm views, VNC bridges, and port forwards. Kubernetes page leave also closes VNC bridges while retaining explicit port forwards. A 410/expired Watch relists the active query before restart; another Watch ERROR, including a client-node `done(null)` stream closure, stops that Watch, reports local 401/403 as `No permission`, and routes a recoverable transport failure through Context reconnect.
- A resource-level RBAC 401/403 is a local `No permission` state and never marks the entire Context unavailable. Transport failures retry with bounded exponential backoff, reload the active resource page after reconnect, and never recreate forwards automatically. A supported disconnected Context exposes a manual read-only `Reconnect` action; it reconnects and restores only the active view.
- Before publishing a Context as connected, run a read-only Kubernetes Version endpoint reachability probe in the main process. Treat a Version-endpoint 401/403 as reachable while retaining resource-local RBAC behavior. Transient probe and transport failures must share one Context-scoped recovery, keep the renderer in one stable reconnecting state without resource LIST requests, activate the current view once after delayed success, and settle disconnected after retry exhaustion. A newer Context selection/reload must fence stale recovery state from the older Context.
- Details are read-only right-side overlay drawers; the originating resource list remains visible beneath them, with its active-view Watch and scroll state staying active beneath the drawer. Custom Resource details mirror Lens with Created/Name/Namespace plus every CRD printer property, bounded collapsible Labels/Annotations, a condition fallback when no Status printer exists, YAML, and on-demand Events. Pod basics and Labels use compact full-width rows with keys aligned left and values aligned right; Drawer Labels and per-container Env are collapsible. Container basics live under a highlighted Info strip; Env uses a distinct highlighted strip, compact vertically centered aligned rows, and is omitted when undeclared or successfully resolved empty. Permission/truncation feedback remains visible. Expanded Env fully displays wrapped values without visible source/reference badges and relies on drawer-level scrolling rather than a nested Env scrollbar. YAML is a header icon action, and Events remain read-only/on-demand. The page frame never grows with detail content; Overview, YAML, Events, relations, and the bottom workspace use bounded internal scrolling when space is constrained. Compact Overview shows exactly Kind, Namespace, Status, Name, and Pod IP in one single-line strip; Name is flexible, values truncate with their full-value title, and narrow widths scroll the strip internally instead of wrapping. The detail header's Port Forward action replaces Copy and is captioned only `Port Forward`; it remains gray when idle and turns green while the exact Pod or Service owns a starting or running forward. It also shows VNC only for a strictly recognized Running KubeVirt virt-launcher Pod. Events, Service Endpoints/EndpointSlices, and Workload selector-matched Pods are on-demand reads only and never create a Watch.
- Each Pod drawer container's adjacent Logs and Shell actions open or focus multiple closable Logs and Shell tabs in the bottom workspace, keyed by namespace, Pod, container, and type. A tab visibly captions only its target (`namespace/pod · container`), while its Logs or Shell type remains accessible; tabs are 24px high with a 140px caption cap, Logs tabs/icons are amber, Shell tabs/icons are blue, and each tab has an integrated SVG close control. The selected pane does not repeat its Logs/Shell target title. A 6px horizontal separator supports pointer and keyboard height adjustment, clamps the workspace between 120px and 80% of the Kubernetes page, and refits an active xterm without recreating it. Closing a drawer preserves tabs. An individual tab close or terminal final state, plus Context change, page leave, disconnect, and shutdown, disposes its exact local view/session and prevents late terminal output from reviving a closed tab. A Logs tab starts with 500 lines, follows by default, and retains at most a 2,000-line log cap. A Pod owned through ReplicaSet by a Deployment defaults to a `Deployment pods (N)` scope switch before search; the main process UID-checks that controller chain, paginates the Deployment selector, filters Pods that declare the same container, and opens at most 50 streams. Deployment names/selectors never come from the renderer, aggregate lines identify their source Pod, and Pod-only mode keeps the capability switch visible. While following the control shows a pause icon; while paused it shows a play icon. Pause first invalidates and closes every owned stream, stops reads, and restores the exact viewport only after the new output node is attached. A compact second-precision `Since` control closes follow streams and issues bounded `follow: false` API snapshots with `sinceTime`; Deployment scope refreshes current membership and aggregates the same timestamp across at most 50 Pods. Resume clears that timestamp, refreshes Deployment membership, retrieves a bounded catch-up tail derived from the viewer's 500-line initial budget after the retained per-Pod timestamps, and immediately returns to the bottom. Clear also drops the aggregate backing buffer; a failed scope switch or time snapshot restores the prior buffer in an explicitly paused state. The scope switch, short search, Since, Follow, Clear, and status controls use a compact 24px height on internally scrollable rows and expose no manual older-page action.
- A Shell tab opens or focuses the matching Pod session in the reusable bottom workspace and tries `/bin/sh`, then `ash`, then `bash`. The first newly created Shell uses about half of the Kubernetes page when no explicit workspace height exists; later Shell opens preserve the user's resized height. Each preferred attempt that resolves to `dash` is rejected silently because dash builds may echo xterm cursor sequences instead of providing Unicode-aware command-line editing; after all preferred candidates fail, one explicit degraded `/bin/sh` attempt preserves access on dash-only images. Once a shell is open and has emitted output, a later non-zero exit ends that exact session instead of incorrectly opening the next fallback. Each open Shell owns a retained exact-session xterm view in renderer memory; switching Logs/Shell detaches and reparents it rather than recreating it, preserving its prompt, scrollback, and exact-session background output. Workspace resizing refits only the active xterm without changing focus or recreating its view. A short bounded renderer-memory bridge retains initial exec output that arrives before its asynchronous open result binds; terminal output is never persisted to main-process state, disk, settings, or logs. After exec connects, wait for the first remote output, with a one-second fallback for silent shells, before marking the session open and accepting focused input so kubelet PTY cooked/ECHOCTL startup cannot echo arrow-key escape sequences. Select an available UTF-8 `LC_CTYPE`, set an appropriate `TERM`, best-effort enable `stty iutf8`, and decode stdout/stderr with independent streaming UTF-8 decoders. Then scroll each newly opened terminal into view and keep it focused for immediate input. Terminal input must preserve spaces, Enter, and xterm control sequences exactly while enforcing the bounded IPC payload; expose no shell credentials to the renderer beyond display-safe output/events.
- The header Port Forward dialog uses Pod regular containers and restartable native sidecar init containers to discover declared TCP ports, and uses a Service's `spec.ports[].port`; declared ports are not proof that a listener is running. With zero declarations, manual Remote Port entry remains available; with one declaration, the editable Remote Port prefills; with multiple declarations, the user selects a declared port or enters a Remote Port manually. Pod and Service port forwarding supports an auto-selected or manually chosen local port, with at most ten active port forwards. The dialog has no redundant target/hint copy, defaults `Open in default browser` on, and uses the authoritative bound local port returned by main before opening `http://127.0.0.1:<port>`. A compact toolbar button always shows the active forward count; its opt-in dialog supports clickable running endpoints, individual Stop, and one main-process snapshot `Close All` that also fences in-flight starts. A forward survives detail close but stops on manual stop, Close All, Context switch, disconnect, or app shutdown; no unrelated process is terminated for a port conflict.
- KubeVirt VNC must require a non-deleting Running `virt-launcher` Pod and re-read both Pod and VMI in the main process. Verify the renderer-supplied Pod UID, the Pod controller's VMI UID, the VMI `activePods` Pod UID, Running phase, and graphics availability before opening. Use the active `@kubernetes/client-node` KubeConfig to authenticate the `plain.kubevirt.io` VNC subresource with `preserveSession=true`, terminate its bounded inner RFB handshake, select only upstream SecurityType None, and bridge it only through an ephemeral single-viewer `127.0.0.1` TCP listener. On macOS, present a random eight-character, single-use VNCAuth credential only to the local Screen Sharing client and pass it through a main-process-only `vnc://vnc:<credential>@127.0.0.1:<port>` URL so no password prompt appears; the credential must never cross renderer IPC or enter logs, diagnostics, settings, errors, caches, or disk. Other platforms retain the no-password local RFB path. RBAC must permit reading the Pod, VMI, and VNC subresource. Viewer close, authentication failure, startup timeout, page leave, Context switch, disconnect, and shutdown release every listener, socket, WebSocket, handshake buffer, challenge, and expected response.
- `secretKeyRef` and `envFrom.secretRef` values decode only through a narrow request in the main process for the active drawer. The result is bounded and locally searchable, and is never placed in caches, settings, runtime logs, diagnostics, or disk. Secret list summaries strip `data` and `stringData`; decoded Secret detail exists only in the active viewer.

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
- Kubernetes alone uses the available application width in the existing white content-container style: matching compact label-free Context/Namespace custom selectors, a searchable non-wrapping Namespace popup, connection/disconnect state, selected Namespace scope, non-wrapping category/resource controls, and resource-specific eight-column virtual tables; no UI Cluster category is visible. The Namespace popup remains unclipped, while other constrained control strips scroll internally. Resource details are right-side overlay drawers that preserve the originating list's loaded pages, filters, sort, active Watch, and scroll state beneath. Pod basics and Labels align keys left and values right; expanded Env shows fully wrapped bounded key/value rows without source/reference badges and scrolls with the drawer. YAML is an icon action, Events are read-only/on-demand, and VNC is a Pod-header action only for a strictly recognized Running KubeVirt launcher. At 1230×820, drawer/workspace scrolling stays internal; smaller windows keep primary controls visible and move overflow into the active drawer and bottom workspace. The category row keeps a compact Forwarded Ports count button at its far right; active forwards appear only after that button opens its bounded dialog, while the bottom Logs/Shell workspace remains a viewport-contained layer.
- Kubernetes dynamic values, including resource names, labels, YAML, Events, logs, and terminal output, must use DOM nodes and `textContent`; never insert Kubernetes-derived values with `innerHTML`.
- Kubernetes YAML uses the copied local `js-yaml` browser asset and renders through `textContent`. Decoded Secret YAML remains only in the active detail DOM and is cleared when that detail closes or changes.
- Kubernetes container actions sit next to the container name and open/focus multiple closable bottom Logs/Shell workspace tabs keyed by namespace/Pod/container/type. Their 24px-high visible captions are target-only (`namespace/pod · container`) with a 140px caption cap, their type remains accessible, Logs tabs/icons are amber, Shell tabs/icons are blue, and close uses an integrated SVG. Do not repeat the target title inside the selected Logs/Shell pane. Keep the short search, second-precision Since control, actions, and status at 24px, and expose the 6px pointer/keyboard resize separator with a 120px minimum and 80%-of-page maximum; refit an active xterm without recreating it. A first Shell without an explicit workspace height uses about half the page; user resizing remains authoritative. Drawer close preserves tabs; individual close/final and Context/page/disconnect/shutdown cleanup dispose exact local views/sessions and block late output from reviving closed tabs. Leaving the Kubernetes tab stops Watches, logs, and terminal sessions, while explicit port forwards remain until their Context lifecycle ends.
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
- Kubeconfig bytes, absolute source paths, stable-ID source mappings, tokens, client certificates/keys, client transport/VNC handles, and terminal/port-forward/VNC credentials stay in the main process and never cross renderer IPC or persist to disk. Terminal output may be transiently relayed but must never be persisted to main-process state, disk, settings, or logs; retained xterm views and the bounded pre-bind bridge are renderer-memory-only.
- Kubernetes Secret `data`/`stringData` must be absent from list/cache/diagnostic/settings data. Decode `secretKeyRef` and `envFrom.secretRef` only through a narrow request in the main process for the active drawer; keep its result bounded and locally searchable, clear it when that drawer closes or changes, and never cache, persist to settings, log, diagnose, or write it to disk.
- Dialog open/close paths must be idempotent.
- Missing remote `systemd --user` support must fail explicitly with setup guidance; never silently switch to an unmanaged process model.

## Testing

- Run `pnpm test` after behavioral or architecture changes.
- `pnpm test` must build first, then run `node --test tests/*.test.js`.
- Add `node:test` coverage for extracted pure logic, runtime orchestration helpers, import/export behavior, and command-building logic.
- Kubernetes changes need coverage for safe kubeconfig classification, query/cache deduplication, 200-item paging, virtual scrolling, Watch cleanup/410 recovery, logs/terminals/forwards, strict KubeVirt VNC identity/bridge cleanup, Secret non-persistence, local RBAC failure, and renderer-safe IPC.
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
- `Restart Now` must route through the shutdown coordinator and launch the downloaded installer only after app-owned runtime cleanup and diagnostic flush, or after the coordinator's eight-second final deadline; never start Windows NSIS first and race ordinary cleanup of the old executable. Once installation starts, the shared 1.5-second final-exit fallback must prevent a stale Electron process from retaining installed files.
- Automatic update checks retry transient network failures once and remain quiet after a failed retry; manual update-check failures use a top-right toast.
- Manual update check belongs in the app menu as `Check for Updates...`, not as a home-page quick action.
- README must include unsigned macOS install/quarantine guidance.
- Runtime/build icons come from `assets/source.png` and generated `assets/icon.*` files.
