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
    - kubeconfig TLS settings and relative certificate/key paths are resolved from each Context's own source file. A Context using `insecure-skip-tls-verify` is honored without a separate TLS warning in the page header; the connection badge remains the single visible connection-state indicator. A first-level kubeconfig file addition, removal, replacement, or content change prompts for explicit `Reload kubeconfig` confirmation before new credentials or Context metadata are used
    - resource APIs are strictly read-only: there are no create, delete, patch, Apply, Scale, Restart, or Pod lifecycle controls
    - the full-width Kubernetes browser alone uses the available application width rather than the shared centered-content width. Context and Namespace use matching compact custom selector components on one label-free toolbar row with non-wrapping category and resource controls; Context is deliberately narrower, while Namespace is wide enough for the active development scopes without wrapping. There is no UI Cluster category. The Namespace and Custom Resource popups remain visible outside their rows instead of being clipped, while the category, resource, and secondary control strips keep their own horizontal scrolling when space is constrained. The visible categories are Workloads, Network, Configuration, Storage, and Custom Resources. Custom Resource Definitions are discovered on demand through the read-only ApiextensionsV1 API; choosing Custom Resources immediately shows a compact local-search selector matching the Namespace control, without an intermediate resource-type button. Its menu groups entries by API group and shows a human-readable Kind with only the served version needed to disambiguate the actual query; Namespaced/Cluster scope badges are intentionally omitted. A confirmed kubeconfig reload invalidates and rediscovers CRD metadata, including after delayed reconnect, while a transient reconnect can retain the already-authorized metadata needed to restore the active list
    - the searchable Namespace dropdown loads the active cluster's Namespaces through the read-only API, filters them locally through a compact search field, and supports checkbox multi-select between selected Namespaces and the mutually-exclusive `All` menu item; there is no manual Namespace entry. Switching Context invalidates and reloads that list and resets the active scope to All Namespaces. The unclipped Namespace menu stays open during search and multi-select and closes after an outside pointer press. Nodes and Namespaces remain cluster-scoped regardless of this selection
    - a resource type without RBAC read permission remains visible as `No permission`; that local error does not disconnect the Context or block other resource types
    - each per-resource virtual list uses eight columns with non-wrapping values, 200-item paging, and virtual scrolling. Pods keep `Namespace, Name, CPU, Memory, Restarts, Status, Node, Age`; Deployments and StatefulSets show replica readiness and rollout strategy; Services show type, IPs, ports, and selector; Ingresses show class, hosts, address, ports, and TLS; ConfigMaps and Secrets show safe entry/metadata counts; PVCs show status, volume, capacity, access modes, and Storage Class. Custom Resources follow their CRD `additionalPrinterColumns` in Lens-style priority order, then use bounded generic fallbacks only when fewer fields are declared; only values which fit the visible eight-column list are evaluated, cached, and sent to the renderer. Printer JSONPath evaluation is non-executable and bounded, uses the first result, and applies the declared string/integer/number/boolean/date type. Secret list summaries expose only the number of top-level data entries—never Secret keys or values. Pod CPU and Memory are aggregates of ordinary containers' `resources.requests`, not limits or live metrics. Kubernetes lists are cached only in memory for a short period, while the active-view Watch belongs only to the currently displayed resource type and Namespace scope; the renderer requests only its current bounded virtual range rather than receiving every loaded row on list or Watch updates. Age is derived from normalized string or `Date` creation timestamps, and small table-header sort icons toggle ascending/descending loaded-only sorting; replica ratios, count columns, and typed Custom Resource printer columns use type-aware ordering. This avoids subscribing to every resource in every Namespace and keeps large lists responsive
    - resource details open as read-only right-side overlay drawers. The originating list remains visible underneath, and its active-view Watch and scroll state stay active beneath the drawer. Built-in drawers use concise resource-specific Properties in a Lens-inspired information hierarchy instead of one misleading generic Status block: Deployments and StatefulSets show rollout counts, strategies, selectors, images, conditions, and related Pods; Services show type, cluster/external addresses, ports, selectors, and display-safe backend readiness; Ingresses show class, addresses, compact host/path/backend rules, and TLS; ConfigMaps show read-only Data plus Binary Data sizes; Secrets show only type, entry count, immutable state, and Labels; PVCs keep bound capacity and requested storage distinct with access modes and selector. Empty ConfigMap/Label values remain visible as `(empty)`, while bounded tables and backend target lists explicitly show omitted-entry counts instead of appearing complete. Common Labels and non-empty Annotations remain collapsed and lazy, except Secret annotations are omitted because last-applied or third-party annotations can embed payload keys or values; low-value UID/resourceVersion/finalizer/affinity detail stays in YAML. Custom Resource drawers mirror Lens with Created/Name/Namespace plus every CRD printer property, bounded collapsible Labels and Annotations, and a condition fallback when no Status printer property exists. Pod basics retain Name, Namespace, Status, Node, Pod IP, and Pod IPs in compact full-width rows with keys aligned left and values aligned right; Labels and per-container Env are collapsible. Every container groups its aligned basic fields under a highlighted Info strip and, only when environment declarations exist, shows a separately colored Env strip. Expanded Env uses compact vertically centered key/value rows, fully displays wrapped values, and omits visible source/reference badges; a successfully resolved empty Env section disappears, while permission/truncation feedback remains visible. Long Env content uses the drawer's own scrolling instead of a nested list scrollbar. YAML is a header icon action; Events remain read-only and on-demand, are fetched only after their collapsed section first opens, and expose a local Retry after failure. The detail header's Port Forward action replaces Copy and is captioned only `Port Forward`: it stays gray when idle and turns green while that exact Pod or Service owns an active forward. Properties, related resources, YAML, Events, and the bottom workspace use bounded internal scrolling when space is constrained. Deployment/StatefulSet related Pods and Service Endpoints/EndpointSlices load only after expansion and never add a Watch; backend summaries include ready/not-ready counts, ports, and target names but never endpoint addresses. A missing backend API is treated as empty, while an unauthorized backend API emits a display-safe partial notice so results from the other backend API stay visible
    - a Pod detail header shows `VNC` only for a non-deleting, Running `virt-launcher` Pod whose KubeVirt controller metadata and UIDs identify one Running VMI with graphics enabled. Opening it makes the main process re-read and UID-check both the Pod and VMI, then uses the active `@kubernetes/client-node` KubeConfig to authenticate a `plain.kubevirt.io` WebSocket to the KubeVirt VNC subresource with `preserveSession=true`. The loopback-only, single-viewer TCP bridge negotiates KubeVirt's inner no-password RFB connection itself. On macOS it separately presents one random, eight-character, single-use VNCAuth credential to the system Screen Sharing client and passes that credential only through the main-process `vnc://` launch URL, so the VM opens without a password prompt; the credential is not a VM or Kubernetes password and never crosses renderer IPC, logs, diagnostics, settings, or disk. Other platforms retain the no-password local RFB path for their registered system handler. Context switch, disconnect, Kubernetes page leave, shutdown, viewer close, authentication failure, or startup timeout closes every listener, socket, and WebSocket. The selected identity needs RBAC read access to the Pod, VMI, and VNC subresource. Kubeconfig credentials and VNC transport handles remain main-process memory only and are never persisted
    - each Pod drawer container places its Logs and Shell actions next to the container name; they open or focus multiple closable Logs and Shell tabs in the bottom workspace, keyed by namespace, Pod, container, and type. A visible tab caption is target-only (`namespace/pod · container`), while its Logs or Shell type remains in the accessible name; the compact tabs are 24px high with a 140px caption cap, Logs tabs/icons are amber, Shell tabs/icons are blue, and each tab has an integrated SVG close control. The selected pane does not repeat its Logs/Shell target title. A 6px horizontal separator supports pointer dragging and keyboard resizing, with a 120px workspace minimum and an 80% Kubernetes-page maximum. Closing a drawer preserves tabs. An individual tab close or terminal final state, plus Context change, page leave, disconnect, and shutdown, disposes its exact local view/session and prevents late terminal output from reviving the tab. A Logs tab loads 500 initial lines, follows by default, and keeps a 2,000-line log cap. For a Pod owned through ReplicaSet by a Deployment, the main process resolves and UID-checks that controller chain, paginates selector-matched Pods that declare the same container, and enables a default-on `Deployment pods (N)` switch before search; turning it off returns to this Pod only. Aggregated lines include their source Pod and no Deployment name or selector is accepted from the renderer. At most 50 Deployment Pods are opened as one viewer. While following, Follow shows a pause icon; when paused it shows a play icon. Pause closes every owned stream, stops reads, and preserves the exact viewport even across pane rerenders. The compact second-precision `Since` control also pauses the viewer and asks the Kubernetes log API for a bounded `follow: false` snapshot from that timestamp; Deployment scope refreshes current membership and aggregates the same lower bound across its Pods. Resume clears `Since`, retrieves a bounded catch-up tail after the retained per-Pod timestamps, and immediately returns to the bottom. Clear drops the aggregate backing buffer, while a failed scope or time change restores the prior buffer in an explicitly paused state. The toolbar keeps its scope switch when applicable, a short left-side search, Since, Follow, Clear, and status controls at a compact 24px height on internally scrollable rows and exposes no manual older-page action
    - a Shell tab opens or focuses the matching Pod session in the reusable bottom workspace and tries `/bin/sh`, then `ash`, then `bash`. The first newly created Shell uses about half of the Kubernetes page when no inline workspace height exists; later Shell opens preserve a manually resized height. A preferred candidate that resolves to `dash` is rejected silently because dash builds can accept an editing option while still echoing xterm cursor sequences instead of providing Unicode-aware line editing; after the preferred candidates fail, one explicit degraded `/bin/sh` attempt preserves access on dash-only images. Once a shell is open and has produced output, a later non-zero exit ends that exact session instead of switching fallbacks. Each open Shell owns a retained exact-session xterm view in renderer memory: switching between Logs and Shell tabs detaches and reparents it rather than recreating it, preserving its prompt, scrollback, and background output from that exact session. Resizing the workspace refits the active xterm without recreating it or taking focus. A short bounded renderer-memory bridge keeps initial exec output that arrives before the asynchronous open result binds; terminal output is never persisted to main-process state, disk, settings, or logs. After exec connects, the session waits for the first remote output, with a one-second fallback for silent shells, before reporting open and accepting focused input; this avoids the kubelet PTY cooked/ECHOCTL startup race that can echo arrow-key escape sequences. Shell bootstrap selects an available UTF-8 `LC_CTYPE`, sets an appropriate `TERM`, and best-effort enables `stty iutf8`; stdout and stderr use independent streaming UTF-8 decoders so split multibyte characters remain intact. Each newly opened terminal then scrolls into view and is focused for immediate input, while terminal input preserves spaces, Enter, and xterm control sequences exactly within the bounded IPC payload
    - the header Port Forward dialog uses Pod regular containers and restartable native sidecar init containers to discover declared TCP ports, and uses a Service's `spec.ports[].port`; declared ports are not proof that a listener is running. With zero declarations, manual Remote Port entry remains available; with one declaration, the editable Remote Port prefills; with multiple declarations, the user selects a declared port or enters a Remote Port manually. The compact dialog omits redundant target/hint copy, accepts an automatic or selected local port, defaults `Open in default browser` on, and uses the authoritative bound port returned by main before opening `http://127.0.0.1:<port>`. At most ten active port forwards are allowed. A count button at the far right of the category row opens the bounded Forwarded Ports dialog only on demand; running loopback endpoints are clickable, and individual Stop plus one main-process snapshot `Close All` are available. Forwards survive a detail drawer close, but stop on Close All, Context switch, disconnect, or application exit
    - `secretKeyRef` and `envFrom.secretRef` values are decoded only through a narrow request in the main process for the active drawer. The result is bounded and locally searchable, and is never placed in caches, settings, runtime logs, diagnostics, or disk. Secret list caches remove `data` and `stringData`; decoded Secret detail values exist only in the active viewer
    - before a Context is published as connected, the main process performs a read-only Kubernetes Version endpoint reachability probe. A 401/403 response proves the API endpoint is reachable but does not replace resource-level RBAC handling. Transient probe or transport failures share one Context-scoped bounded exponential retry; the renderer keeps one stable `Reconnecting` view and sends no resource LIST until that exact Context connects, then activates the current view once. Retry exhaustion settles to `disconnected` instead of briefly publishing a false connected state
    - a transport disconnect (including an unexpectedly closed Watch stream) closes Watches, log/terminal streams, and forwards; the current resource page reconnects with bounded exponential backoff and reloads after success, but forwards are never recreated automatically. Concurrent failures share the same recovery, and switching Contexts fences the older recovery from publishing stale state. A supported disconnected Context also exposes a manual `Reconnect` action; it only reconnects and reloads the active read-only view
15. Notes provides a compact local snippet library:
    - the viewport-contained two-column page uses the full available application width. Its Notion-style Note tree has a `280px` default sidebar that can be dragged or adjusted by keyboard between `240px` and `520px`; that exact device-local width survives window resizing and application restarts while only the editor column changes width. The tree owns inline root/child creation, collapse controls, subtree deletion, keyboard navigation, and before/inside/after drag-and-drop; clicking a node selects it and also toggles its children, while the dedicated disclosure icon remains available. Both constrained areas scroll internally at smaller window sizes. Rich Text keeps compact horizontal writing padding—24px at ordinary window widths and 12px below the narrow breakpoint—and compensates for its proportional-font metrics so its first visible text line aligns with Markdown while retaining bottom breathing room. Expanded nodes are device-local, while hierarchy and sibling order are durable shared data
    - search ignores collapsed state, ranks exact, prefix, and partial Name matches ahead of lower-priority Tag, Language, and full-content matches, and includes an ancestor breadcrumb for nested results
    - each note exposes only its Name, Language, and Content editor. Internal Tags remain available to sync, search, and conflict recovery but are not displayed or editable. Newly created Notes default to Rich Text, which is the first Language option; Markdown is second. Markdown, Bash, JavaScript, TypeScript, SQL, JSON, and YAML use CodeMirror 6 with parser-backed highlighting, while Plain Text remains unstyled. Markdown fenced blocks also highlight Bash, JavaScript, TypeScript, SQL, JSON, and YAML. Rich Text uses a local Tiptap editor and persists a validated canonical Tiptap JSON document instead of HTML; canonical hard breaks retain Tiptap's strictly validated inline marks so imported styled `<br>` elements round-trip without falling back. Its Novel-style prose uses the packaged Inter-compatible `STM UI` family with bundled Noto Sans SC for Chinese glyphs. CodeMirror and Tiptap share one device-local Light/Dark preference and default to Light
    - selecting text in Rich Text opens a compact Novel-style floating formatter instead of reserving a permanent toolbar row. It includes the complete Text/Heading 1–3/To-do/Bullet/Numbered/Quote/Code block selector, safe link apply/remove, inline math, Bold/Italic/Underline/Strike/Inline Code marks, and independent text/highlight colors; there is no Ask AI action. Typing `/` opens the matching Novel-style block menu for Text, To-do List, Heading 1/2/3, Bullet List, Numbered List, Quote, Code, Table, and Image. It deliberately omits feedback, YouTube, Twitter, and every AI action. The menu filters as the user types, remains keyboard navigable, and is suppressed inside code blocks. To-do items retain an explicit checked state in the validated canonical JSON model; after inserting an empty To-do, the generic empty-editor slash hint is suppressed
    - `/table` inserts a `3×3` table whose first row is a Header. Tiptap's official TableKit owns the table nodes, cell/multi-cell selection, keyboard editing, copy/paste, undo/redo, commands, and column resizing. A small renderer overlay adds Novel-aligned row, column, and whole-table hover menus while dispatching only official row/column/table commands; `Alt+F10` or `Shift+F10` moves keyboard focus from the current cell to those controls. Tables fill the writing width, use a 96px minimum column width with contained horizontal scrolling, support Light and Dark theme tokens, and pass bounded rectangular-geometry validation before persistence
    - switching a non-empty note between Rich Text and a CodeMirror language requires confirmation because the conversion is intentionally text-oriented and can lose formatting. Rich Text images require a configured S3 target and credentials; without them the image action shows a configuration prompt. Images may be selected from the slash command, pasted, or dropped; uploads accept only PNG, JPEG, and WebP up to 10 MiB, with each dimension limited to 8192px and the decoded image limited to 40 million pixels. An asynchronous paste/drop retains its requested insertion point when that point is still valid. Images default to true left alignment with browser `figure` margins explicitly reset. Selecting one opens a compact icon-only floating toolbar for left, center, or right alignment and retains the Node selection; Novel-style left and right handles resize it proportionally. Only bounded `displayWidth` and non-default alignment are persisted in the encrypted Note body, without changing or reloading the immutable S3 image object's original dimensions or metadata
    - edits save automatically after a short debounce, and tree mutations first flush every pending draft so a returned workspace cannot replace unsaved text. Save activity uses a tiny per-Note dot in the tree instead of toolbar text; the dot disappears after success, while a failed Note remains visibly marked and its error is surfaced without changing toolbar width. Every ordinary save carries the renderer's last persisted Note as a compare-and-swap base. Note/page changes, cloud apply, and window/application close also use the bounded flush path. The Notes page is briefly made non-interactive while a cloud-applied workspace is reloaded; if a new edit lands in the narrow interval after the final pre-apply flush and the cloud has changed or deleted that Note ID, the cloud Note stays canonical and the late draft is preserved as a new `(Conflict)` Note. Every Note ID has one independent versioned `<userData>/notes-v4/<sha256(note.id)>.json` file containing either the active Note or its deletion tombstone, so one edit rewrites only one file. The hierarchy is a separate private atomic `<userData>/notes-tree.json`; local expansion state is isolated in `<userData>/notes-tree-view.json`. This v4 Notes workspace intentionally starts empty and does not read or migrate retired Notes stores
    - the sidebar root and per-row child actions use compact icons. Each tree row owns an icon-only accessible Remove action; confirmation clearly identifies when the complete subtree will be deleted. Deletion uses a lightweight authoritative subtree preview before and after the native confirmation; if S3/import changes membership while that dialog is open, a concise `Updated deletion scope` confirmation shows the refreshed total without presenting the safe retry as an error. Once confirmed, the renderer immediately hides the pending subtree and moves selection, while the main process rechecks the exact ID set and atomically rewrites only those Note envelopes as tombstones instead of replacing the complete Notes directory. Late expand/collapse requests for a deleted row are harmless no-ops. A successful mutation reports the deleted Note count, and duplicate Remove clicks are collapsed into one flow. Copy remains an icon-labelled editor action
    - dynamic content is rendered only through CodeMirror/Tiptap state, form values, or text nodes; stored Rich Text is normalized through the shared safe-node model, fetched images are exposed to Tiptap only through short-lived blob URLs, and only absolute HTTP(S) links are retained. Link clicks cannot navigate or replace the Electron renderer
    - Notes typography is packaged with the application: Noto Sans SC Variable renders the Notes tree and mixed Chinese/Latin UI, the existing local Inter-compatible family renders Novel-style Rich Text Latin text, and JetBrains Mono Variable renders CodeMirror code. Chinese editor glyphs fall back to the bundled Noto family, so Notes does not depend on fonts installed by the operating system or fetch fonts at runtime. The Notes Settings tab adjusts the editor from 12–24px (14px by default) and switches both editors between Light (default) and Dark. Those choices and the resizable tree width are device-local values in the versioned private `<userData>/ui-preferences.json`; none enter S3 shared data
    - Settings > Notes also provides a read-only Trilium ETAPI import. Enter the Trilium Endpoint and ETAPI Token for that import only: neither is saved as importer configuration, the Token is never persisted, remains password-masked unless its eye action is used, and is cleared on success, cancellation, or dialog close. Canonical imported Note content can retain source URL text and resolved Trilium links just like any other Note content. The importer runs an explicit `prepare -> resolve/upload -> apply` lifecycle, with canonical renderer conversion after image resolution and before apply, and reports each phase in the fixed-height Settings dialog. Cancel is available through preparation, image resolution/upload, and conversion, but not after the final atomic apply begins. An HTTP Endpoint is allowed with a visible transport-security warning, while every ETAPI request rejects redirects
    - preparation walks the user hierarchy from Trilium's root through read-only Note, Branch, Attachment-metadata, and content requests, skips root system trees whose Note ID starts with `_`, and never creates, edits, or deletes anything in Trilium. A canonical Endpoint plus Trilium Note ID produces the stable local Note ID. The bounded source-version hash includes the importer conversion revision, source title/type/MIME/blob/modified metadata, and fingerprints for referenced Trilium images or attachments, so an attachment-only image change is detected. Reimporting an unchanged source version preserves the complete local Note, including local edits. When that source version changes, the imported Name, Language, Content, updated timestamp, and importer markers are refreshed while the original local creation time and unrelated internal Tags are retained. A Trilium deletion is not mirrored: previously imported local Notes absent from a later traversal remain local
    - image resolution accepts only same-Endpoint Trilium-owned `api/images/<noteId>/...` and `api/attachments/<attachmentId>/image/...` sources. The main process revalidates their metadata and reads bytes only through the corresponding read-only ETAPI Note or Attachment content route; it never follows an arbitrary HTML image URL and never sends ETAPI credentials or source bytes to Tiptap. Valid PNG, JPEG, and WebP bytes pass the ordinary Notes size, dimension, pixel, MIME, and digest checks, are deduplicated within the import, and are uploaded as private immutable per-image AES-256-GCM objects in the configured Notes S3 bucket. Canonical Rich Text stores only the validated `s3Image` reference, optional alt text, bounded display width, and alignment. A supported image that needs upload makes missing S3 configuration an explicit import failure rather than silently losing the image
    - a supported, readable Trilium Image Note becomes a Rich Text Note containing the imported image. Protected, missing, invalid, oversized, non-image, or unsupported image sources remain explicit `[Image unavailable: ...]` placeholders; protected/oversized Notes, File Notes, and unsupported structured or binary Note types remain explicit Markdown placeholders instead of exposing raw binary/JSON/HTML payloads. Image captions are retained as following Rich Text paragraphs. The image stage is separately bounded to 50,000 unique targets, 10 MiB per image, 50 MiB transferred in total, two concurrent requests, and a 15-second request timeout; image dimensions remain bounded to 8192px and 40 million pixels
    - Trilium clone placements are deduplicated by remote Note ID and use the first reachable breadth-first tree placement. Trilium `text` Notes are always treated as CKEditor HTML regardless of a stale/custom MIME: their HTML is sanitized, CKEditor task lists are adapted with checked state intact, and the result is converted through the same Tiptap extension schema before shared canonical Rich Text validation. CKEditor table `<colgroup>` percentage or pixel widths are normalized to bounded integer widths and propagated across valid row/column spans as official TableKit `colwidth` attributes; malformed width/span maps are left unset instead of inventing invalid table geometry. Only Trilium `code` Notes with `text/markdown`, `text/x-markdown`, or `text/x-gfm` remain Markdown source; other supported Code MIME values map to the corresponding Notes code language, while Mermaid Notes become fenced Markdown blocks. Text/hierarchy preparation remains bounded to 10,000 Notes, tree depth 32, 50,000 Branches, 4 MiB per ETAPI response, and 50 MiB transferred in total, with eight requests in flight and a 15-second per-request timeout
    - the prepared session retains the ETAPI Token only in transient main-process memory until image resolution completes; success zeroes it immediately, while cancellation, expiry, renderer loss, and shutdown abort owned work and dispose the session, and explicit cancellation/shutdown await tracked tasks before completing. Image bytes are neither persisted locally nor sent through renderer IPC. Because encrypted image objects are immutable and are uploaded before the local workspace commit, cancellation or a later failure can leave an unreachable encrypted S3 object, but a partial image set is never applied to Notes. The importer binds uploads to the current Endpoint/Bucket and rechecks that target before final apply
    - the final import flushes renderer drafts and applies the complete Note/tombstone/tree workspace while serialized against S3 shared-data collection and cloud apply. A failed durable write restores the prior Note files, tombstones, hierarchy, and local expansion state before the failure is returned. A changed import publishes one Notes reload event and marks one shared-data change, so configured S3 automatic synchronization picks it up through the ordinary reconciler; an unchanged import does not create a needless sync mutation
16. The bottom navigation Settings action provides automatic, cloud-authoritative synchronization through a MinIO-compatible S3 bucket:
    - Settings uses compact `S3`, `Notes`, and `LLM` tabs inside one fixed-height dialog, so switching tabs never moves or resizes it. One shared `Save` action persists all device-local settings and closes only after every requested write succeeds. The S3 tab owns `Test` and `Sync Now`: `Test` signs a bounded read of the canonical head with the current unsaved Endpoint/Bucket/Region/AK/SK draft without saving settings or starting reconciliation, while `Sync Now` saves the S3 draft and runs the ordinary single-flight reconciler
    - the LLM tab stores an OpenAI-compatible API base, optional password-masked Bearer Token, and selected model locally. `Load Models` makes one bounded main-process `GET <endpoint>/models` request and populates the selector without discarding a previously selected model that is temporarily absent. A saved Token can be explicitly removed with `Remove saved Token`, or by clearing a successfully hydrated field, and then pressing the shared `Save`; a failed hydration never clears the saved value implicitly. Unmodified Tokens are preserved without re-encryption during unrelated Settings saves. The Token is protected with Electron `safeStorage`; Endpoint, Token, selected model, and model responses are excluded from S3 shared data. An HTTP endpoint shows a warning whenever a Token would be sent without transport encryption
    - configure the S3 Endpoint (for example `https://s3.example.com`) and Bucket (for example `service-manager`) separately, followed by Region, Access Key ID, Secret Access Key, and Sync Encryption Key. A custom Sync Encryption Key may contain any characters but must contain at least nine characters after trimming; a cryptographically random 256-bit key is generated on first Save when none is supplied. Copy the same key to every client using that target. The app owns every object name and internal layout version; legacy settings containing one combined bucket URL are split during migration. If the local settings file is invalid, Settings opens with an error and an empty safe form so the next valid Save can replace it
    - automatic reconciliation runs after startup, on window focus, after system resume, every 45 seconds as a fallback, and two seconds after a local shared-data change. Offline edits remain in the per-Note JSON files and other local stores; their pending intent is persisted through an independent settings-mutation queue, without waiting for an active S3 request, so a restart still shows the pending/offline state and retries on a later trigger. `Sync Now` runs the same reconciler immediately for an explicit check or retry
    - all clients use the incompatible v4 object layout. The canonical `service-manager/v4/head.json` references one immutable encrypted `service-manager/v4/manifests/<revision>.json` manifest; that manifest carries the shared Hosts and Proxy sections, Note tombstones, one validated immutable-object reference for every active Note, and one independent encrypted Note-tree reference instead of embedding Note bodies or hierarchy. The head, encrypted envelopes, and references bind the Sync Encryption Key identity plus ciphertext/plaintext digests. Mixed-key manifests are rejected. The v1, v2, and v3 prefixes are never read, migrated, promoted, or deleted
    - each active Note version is encrypted independently and uploaded as its own immutable `service-manager/v4/notes/<opaque-object-id>.json` object; stable Note IDs and names never enter object paths. The hierarchy is encrypted independently at `service-manager/v4/notes-trees/<opaque-object-id>.json` as bounded root/order/parent data. A new manifest reuses unchanged Note and tree references, so routine reconciliation transfers only changed objects. Tree placement merges independently by stable Note ID, cloud wins a true same-node move conflict, and conflict-copy Notes retain their local placement where possible
    - a Rich Text image is a separate private immutable AES-256-GCM object at `service-manager/v4/images/<opaque-object-id>.json`. Each image receives an independent random key stored only in the image reference inside the already encrypted Note body; the Note never contains an S3 URL or credentials. A narrow main-process IPC validates, downloads, and decrypts an image before the renderer creates a revocable blob URL. Replacing or removing an image does not automatically delete the now-unreferenced immutable object in this release
    - the manifest plus every changed immutable Note/tree object is uploaded before the head is published, and the head is the only mutable v4 object. A conditional ETag update of the canonical head provides compare-and-swap publication; if another client wins, the loser reloads the new head and manifest, fetches newly referenced objects, merges, and retries instead of blindly overwriting newer cloud state
    - Notes merge independently by stable Note ID with three-way comparison. Tombstones propagate deletions and prevent stale clients from resurrecting a deleted ID. If both clients change the same Note differently, the cloud version remains canonical and the local version is preserved as a new Note whose name ends in `(Conflict)` and whose tags include `Conflict`
    - Hosts and Proxy are merged as complete sections: a one-sided change is retained, while a true same-section divergence follows the cloud. Before applying a cloud-winning Hosts or Proxy conflict, the app writes a Sync-Encryption-Key-encrypted local recovery revision under `<userData>/s3-sync-recovery` and retains the newest 20 files; recovery files are not applied automatically
    - synchronized data includes durable Host definitions and SSH authentication material, Notes, and shared Proxy mode, selections, Custom Rules, subscription metadata, and retained source subscription. A private-key file path is never uploaded; when needed, its bounded key contents are read into the encrypted manifest. Forward auto-start choices, service PIDs, Proxy start-on-launch, Mixed Port, TUN, System Proxy, Kubernetes Context preference, UI preferences, logs, caches, live sessions, runtime state, and S3 configuration/credentials remain device-local or excluded
    - AK, SK, and Sync Encryption Key are protected at rest with Electron `safeStorage`; Linux `basic_text` storage is rejected rather than persisting them insecurely. Ordinary settings reads disclose only whether credentials and a Sync Key exist. Opening Settings uses a dedicated narrow IPC to refill saved values into password-masked inputs; an eye reveals only its selected field and immediately re-masks the others, and the Sync Key has an explicit Copy action. A pasted backup Key can replace an unreadable local `safeStorage` value without discarding the merge base; an incorrect replacement still fails closed against the cloud. Losing every client copy and backup of the Sync Key makes the encrypted cloud data unrecoverable
    - the immutable manifest, every immutable Note object, and conflict-recovery files are separately encrypted with AES-256-GCM using HKDF-derived keys based on the independent Sync Encryption Key; AWS SigV4 alone uses AK/SK to authenticate S3 requests. Clients sharing a sync target must use the same Sync Key, but may rotate their S3 SK or use different S3 credentials without changing encryption or the merge base. A deliberate Sync Key change keeps the previous key until every active object is re-encrypted and the head CAS succeeds; a wrong key fails closed without applying data or replacing the head
    - legacy settings schemas keep only their validated Endpoint/Bucket/Region/credential/Sync-Key configuration where possible and discard every pre-v4 revision, merge base, and pending marker. Objects under the v1, v2, and v3 prefixes are intentionally unsupported and left untouched; this release does not migrate historical local Notes or cloud data
    - reconciliation is single-flight, local shared-data mutations are serialized against manifest collection/cloud apply, plaintext shared data is bounded to 50 MiB, requests time out after 30 seconds, and active work is aborted and awaited during application shutdown. A late local edit rejects and retries the apply before the local merge base advances. Superseded v4 manifests, Note objects, and tree objects are immutable history; the application does not delete them automatically

## Tech Stack

- Electron
- TypeScript
- Tailwind CSS renderer component/utilities layer (`tailwind.css`, preflight disabled)
- `ssh2` (SSH connection and remote command execution)
- `asn1` (explicit dependency required by ssh2 stack in this project)
- `@kubernetes/client-node` (main-process Kubernetes REST, Watch, log, exec, port-forward, and authenticated KubeVirt VNC transport)
- `@sentry/electron` (privacy-minimal main/renderer JavaScript error reporting through Electron IPC)
- `@xterm/xterm` and `@xterm/addon-fit` (Kubernetes bottom workspace)
- CodeMirror 6 (local browser-ESM snippet editor and language parsers copied into `dist/renderer/vendor` during the renderer asset step)
- Tiptap (local Rich Text editor and recursively copied browser-ESM dependency graph)
- Base renderer CSS for local fonts, CSS variables, and terminal ANSI log colors
- Local JSON persistence in Electron userData

## Project Structure

- `src/main/main.ts`: Electron app/window/menu wiring and IPC orchestration
- `src/main/preload.ts`: secure renderer bridge
- `src/main/sentry.ts`: pre-ready main-process Sentry initialization and bounded shutdown flush
- `src/main/validation.ts`: host/forward/service draft validation and runtime-field preservation
- `src/main/configTransfer.ts`: config import/export parsing, counting, and imported-ID normalization
- `src/main/runtimeRegistry.ts`: in-memory service/forward runtime state and `HostView` assembly
- `src/main/operationQueue.ts`: per-key async queue used to serialize service mutations
- `src/main/hostConnection.ts`: shared SSH endpoint/private-key resolution for service, tunnel, and forwarding paths
- `src/main/serviceRuntime.ts`: remote `systemd --user` service lifecycle and journal log access
- `src/main/notesStore.ts`: versioned, bounded local Notes CRUD with serialized atomic per-ID persistence, target-only batch tombstone writes for subtree deletion, and recoverable staged whole-set replacement for cloud apply
- `src/main/notesTreeStore.ts`: private atomic Note hierarchy/order JSON with bounded-depth insert, move, subtree removal, validation, and deterministic repair against active Note IDs
- `src/main/notesTreeViewStore.ts`: private device-local expanded-node state kept outside S3 shared data
- `src/main/notesImageS3.ts`: bounded PNG/JPEG/WebP validation plus private immutable per-image S3 encryption, upload, download, digest verification, and cancellation ownership
- `src/main/triliumImport.ts`: bounded read-only Trilium ETAPI hierarchy/content traversal, image-dependency source versioning, Image Note planning, clone deduplication, placeholder generation, and deterministic local Note/tree merge planning
- `src/main/triliumImageImport.ts`: strict Trilium-owned image-source recognition plus bounded ETAPI metadata/content revalidation, binary inspection, within-import deduplication, placeholder classification, and cancellable S3-upload orchestration
- `src/main/appDataSnapshot.ts`: durable Proxy snapshot sanitization plus the retained legacy v1 aggregate snapshot allowlist
- `src/main/s3DataMerge.ts`: strict shared-data projection, per-ID Notes/tombstone/tree-placement three-way merge, cloud-winning conflict copies/recovery signals, and device-local field overlays
- `src/main/s3SyncV3.ts`: active v4 wire contract (historical filename/export names retained internally) for head/manifest/per-Note/Note-tree objects, independent Sync-Key AES-GCM envelopes with mandatory key-identity binding, digest-bound references, SigV4 object access, ETag head compare-and-swap, and abortable request bounds
- `src/main/s3SyncV2.ts`: retained legacy protocol plus shared endpoint/SigV4 and local-recovery helpers; the active runtime may reuse those protocol-neutral primitives but never reads, migrates, or deletes v2 S3 object paths
- `src/main/s3Sync.ts`: `safeStorage`-protected MinIO/S3 credentials and independent Sync Encryption Key, v4-only automatic single-flight reconciliation, same-key Note/tree-reference reuse, independently serialized durable offline/pending intent, encrypted conflict recovery, key rotation, and bounded shutdown ownership
- `src/main/llmSettingsStore.ts`: device-local OpenAI-compatible Endpoint/model preferences plus a `safeStorage`-protected optional Token
- `src/main/llmModels.ts`: bounded, cancellable, redirect-denying OpenAI-compatible model discovery
- `src/main/portForwardManager.ts` / `src/main/tunnelManager.ts`: SSH local forwarding runtime; service forwards release failed-start SSH chains, fence in-flight starts during bulk stop, and destroy active local sockets before waiting for listener close
- `src/main/quitCoordinator.ts`: single-flight normal/signal/update quit sequencing with an eight-second cleanup deadline before the final Electron or installer action, plus a 1.5-second forced-exit fallback after that action begins
- `src/main/proxy/proxyRuntime.ts`: local Mihomo process lifecycle, parsed-cache loading/replacement, persisted proxy settings and Custom Rule mutations, and system/TUN proxy controls
- `src/main/proxy/subscriptionCache.ts`: versioned parsed-subscription cache serialization and validation
- `src/main/proxy/proxyExceptions.ts`: Custom Rule validation, normalization, migration, and target-aware Mihomo rule generation
- `src/main/proxy/proxyGroups.ts`: pure conversion, selection validation, and saved-selection compatibility helpers for Mihomo runtime groups
- `src/main/appMemory.ts`: local Electron and Mihomo working-set collection for the Hosts header Memory total
- `src/main/kubernetes/kubeconfigStore.ts`: local kubeconfig classification, safe Context metadata, Namespace normalization, and reload detection
- `src/main/kubernetes/contextPreference.ts`: durable Context-name-only user-data preference; no kubeconfig credentials or resources persist here
- `src/main/kubernetes/kubernetesClient.ts`: main-process-only Kubernetes client adapter with a read-only Version reachability probe, read/list/watch/detail/events, on-demand CRD and Pod→ReplicaSet→Deployment log-target discovery, logs, UTF-8/TTY-bootstrapped Pod exec with streaming output decoding, port forwards, UID-checked KubeVirt VNC ownership, and on-demand related-resource reads
- `src/main/kubernetes/customResourcePrinterColumns.ts`: bounded non-executable CRD printer JSONPath normalization, first-result/type formatting, and visible-list column selection
- `src/main/kubernetes/kubeVirtVnc.ts`: strict Running virt-launcher/VMI identity checks, authenticated `plain.kubevirt.io` WebSocket transport, bounded RFB handshake termination, and the loopback VNC bridge with macOS single-use VNCAuth compatibility
- `src/main/kubernetes/podExecTransport.ts`: silent portable Pod-shell locale/TERM/TTY bootstrap command construction and incremental UTF-8 stream decoding
- `src/main/kubernetes/resourceSummary.ts`: bounded, resource-specific eight-column LIST/Watch summaries, including Secret count-only projection with payload stripping
- `src/main/kubernetes/terminalInput.ts`: bounded exact-input validation for Kubernetes terminal keyboard/control data
- `src/main/kubernetes/clusterSession.ts`: one active Context connection, probe-before-connected state publication, categorized reconnect behavior, and ordered resource disposal
- `src/main/kubernetes/resourceQuery.ts` / `src/main/kubernetes/resourceCache.ts`: normalized query keys, loaded-only projection, virtual-window primitives, and bounded in-memory request/cache deduplication
- `src/main/kubernetes/resourceCoordinator.ts`: 200-item active-view LIST paging, shared Watch lifecycle, resourceVersion reconciliation, and 410 relist recovery
- `src/main/kubernetes/podSummary.ts`: safe Pod-list CPU, Memory, restart, and node summary projection from ordinary-container requests
- `src/main/kubernetes/podEnvironment.ts`: bounded active-drawer Pod environment and Secret-reference resolution with non-persistence boundaries
- `src/main/kubernetes/relatedResourceSummary.ts`: bounded display-safe Service Endpoints/EndpointSlice readiness, port, and target summaries that strip endpoint addresses
- `src/main/kubernetes/podInteractions.ts`: bounded single-Pod/Deployment aggregate logs with live-stream and second-precision snapshot generation fencing, terminal shell fallback/first-output readiness/session lifecycle, and ten-forward ownership
- `src/main/kubernetes/kubernetesRuntime.ts`: renderer-safe Kubernetes lifecycle facade with Context-scoped single-flight recovery, Context-preference restore, bounded resource-window IPC, and resource interactions
- `src/renderer/renderer.ts`: UI orchestration and DOM event wiring
- `src/main/uiPreferencesStore.ts`: versioned private device-local Notes font-size, shared CodeMirror/Tiptap Light/Dark theme, and fixed-pixel tree width with serialized atomic persistence and merge-safe narrow width updates
- `src/renderer/notesPage.ts`: full-width split-pane CodeMirror 6/Tiptap Notes orchestration with a searchable drag-and-drop hierarchy, persisted accessible tree resizing, optimistic subtree deletion with lightweight authoritative previews, request-generation draft fencing, configurable theme/font sizing, S3-image flow, and debounced live save
- `src/renderer/notesRichTextEditor.ts`: isolated Tiptap adapter with a selection-only Novel-style formatter, keyboard-contained slash block menu, official resizable TableKit, checked task lists, canonical-document serialization, absolute-HTTP(S)-only inert link editing, safe S3-image paste/drop and node views, revocable blob-URL ownership, and disabled remote-image ingestion
- `src/renderer/notesRichTextTable.ts`: DOM-only hover controller for row, column, and whole-table menus that targets official Tiptap cell selections and table commands without redefining nodes, selections, or resize behavior
- `src/renderer/notesRichTextMenuScroll.ts`: pure slash-menu reveal math that keeps keyboard selection visible without scrolling the editor or page
- `src/renderer/settingsDialog.ts`: fixed-height tabbed S3/Notes/LLM settings with a shared save-and-close action, masked credential hydration, non-mutating S3/LLM checks, automatic sync state, and explicit `Sync Now` retry/check UI
- `src/renderer/kubernetesPage.ts`: full-width Kubernetes controls/lists, right-side overlay drawers, text-safe browser-YAML rendering, on-demand relations, workspace, and count-backed Forwarded Ports dialog
- `src/renderer/kubernetesDrawerModel.ts`: pure display-safe Pod drawer fields, container metadata, and active-drawer environment filtering helpers
- `src/renderer/kubernetesBuiltinResourceModel.ts`: pure bounded Lens-inspired detail models for Deployments, StatefulSets, Services, Ingresses, ConfigMaps, Secrets, and PVCs
- `src/renderer/kubernetesDetailModel.ts`: pure compact Overview-field and declared TCP-port discovery/dialog helpers
- `src/renderer/kubernetesCustomResourcePrinterColumns.ts`: renderer-local bounded printer JSONPath reader used by the detail drawer
- `src/renderer/kubernetesCustomResourceModel.ts`: Lens-style Custom Resource Properties, metadata, and condition-fallback model
- `src/renderer/kubernetesVirtualTable.ts`: fixed-row virtual scrolling and request-animation-frame bounded range requests
- `src/renderer/kubernetesWorkspace.ts`: reusable multi-tab bottom Logs/Shell workspace with Deployment scope switches, second-precision start-time snapshots, post-layout paused-scroll restoration, half-page first-Shell sizing, target-only type-accessible tab visuals, integrated SVG close controls, a bounded pre-bind terminal-output bridge, and exact tab/session lifecycle disposal ownership
- `src/renderer/kubernetesTerminal.ts`: reusable xterm pane retaining exact-session views for bottom-workspace Shell tabs; selected views detach/reparent without recreation, preserving prompt, scrollback, exact-session output, and exact input
- `src/renderer/tailwind.css`: primary renderer visual layer built with Tailwind `@layer components` and `@apply`; generated output is `dist/renderer/tailwind.css`
- `src/renderer/styles.css`: base-only renderer CSS for local fonts, CSS variables, browser defaults, and ANSI log helpers
- `src/renderer/html.ts`: dynamic HTML escaping and ANSI-to-HTML rendering helpers
- `src/renderer/status.ts`: shared renderer status formatting and action-state helpers
- `src/renderer/sentry.ts`: early renderer exception capture through the official Electron renderer SDK
- `src/renderer/triliumRichText.ts`: pure CKEditor task-list, internal-image URL/layout, and table colwidth/span helpers used by the bounded Trilium HTML-to-Tiptap adapter
- `tailwind.config.cjs`: Tailwind content/theme configuration; preflight is disabled to avoid global reset drift
- `scripts/build-tailwind.cjs`: Tailwind CSS build wrapper
- `scripts/copy-main-runtime.cjs`: preserves shared Rich Text and Sentry-privacy CommonJS main-process runtime artifacts before renderer compilation
- `scripts/copy-renderer.cjs`: renderer static asset copy helper, including local xterm, `js-yaml`, CodeMirror, recursively resolved Tiptap and Sentry browser-ESM dependency graphs, and renderer ESM builds of shared runtime products while restoring their main-process CommonJS counterparts
- `src/shared/noteRichText.ts`: bounded canonical Tiptap JSON, table-span/rectangular-geometry, and S3-image-reference validation shared through separate CommonJS main-process and ESM renderer build products
- `src/shared/types.ts`: shared type contracts
- `src/shared/sentryPrivacy.ts`: strict shared telemetry allowlist and disabled data-collection policy
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
- `Restart Now` first runs the same single-flight app-owned runtime cleanup and diagnostic flush used by normal quit, then launches the downloaded installer. An eight-second final deadline records a best-effort diagnostic and continues if a remote cleanup is stuck; once the final Electron action begins, a 1.5-second forced-exit fallback prevents a leftover framework or network handle from retaining the executable. On Windows this prevents NSIS from racing ordinary cleanup of a still-running Service Manager process; active service-forward sockets are destroyed and failed/in-flight starts are fenced so listener shutdown cannot wait indefinitely or reappear after cleanup.
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

## Sentry Error Reporting

Service Manager initializes the official Electron Sentry SDK before Electron is ready and initializes its renderer SDK before the renderer application. JavaScript exceptions from both processes are delivered through Sentry's Electron IPC transport; the main process owns the project DSN and performs a short best-effort flush during orderly shutdown.

Reporting is deliberately error-only and uses a strict allowlist. Events retain a generated safe error title, validated exception type, static process/scope tags, release/environment, and app-relative stack filenames/functions/line numbers. Minidumps, screenshots, sessions, breadcrumbs, console/network/DOM context, local variables, source context, logs, metrics, traces, profiles, attachments, client reports, URLs, headers, bodies, cookies, IPC payloads, and arbitrary error text are not sent. In particular, Notes content and names, Host/Kubernetes resource identifiers, decoded Kubernetes Secrets, endpoints, credentials, home paths, and runtime-log context are excluded.

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
