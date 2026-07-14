# Kubernetes Drawer and Workspace Design

## Goal

Redesign the Kubernetes page into a compact, full-width resource browser with a right-side resource drawer and a persistent multi-tab Logs/Shell workspace below the list.

## Approved Decisions

- The Kubernetes page may use the full available application width; it does not inherit the application shell's centered maximum width.
- Context, Namespace, and the category controls share one compact row without visible `Context` or `Namespace` labels.
- The visible categories are `Workloads`, `Network`, `Configuration`, `Storage`, and `Custom Resources`; `Cluster` is removed from the UI.
- The resource-kind controls and an unlabeled name search remain available in a compact second row.
- Pod list columns are exactly `Namespace`, `Name`, `CPU`, `Memory`, `Restarts`, `Status`, `Node`, and `Age`. Their text never wraps; the table itself scrolls horizontally when necessary.
- `CPU` and `Memory` mean the aggregate `resources.requests` of the Pod's ordinary containers. Init containers, limits, and real-time Metrics API values are excluded.
- Clicking a resource opens a right-side overlay drawer. It does not hide, resize, or stop updates to the list.
- The drawer is roughly 560 px wide at normal window sizes, grows moderately on large windows, and scrolls internally at narrow sizes.
- Pod drawer actions open or focus multiple closable workspace tabs. The same namespace, Pod, container, and tab type reuse one existing tab.
- The bottom workspace can retain multiple Logs and Shell tabs at once. Closing a drawer does not close a workspace tab.
- Both `env.valueFrom.secretKeyRef` and `envFrom.secretRef` values are decoded to plaintext for the active Pod drawer's current container and are locally searchable.

## Page Layout

### Top controls

The first control row contains, in reading order:

1. Context select with an accessible `aria-label`, but no visible field label.
2. Namespace multi-select trigger with an accessible label, but no visible field label.
3. Category tabs in one non-wrapping, internally horizontally scrollable control band.

`Cluster` is removed from `RESOURCE_CATEGORIES` so Nodes and Namespaces are not reachable through the page UI. Existing main-process support for cluster-scoped resource types remains intact but unused by this navigation.

The second compact row contains resource-kind controls, Custom Resource selection when active, and a search input with placeholder text only; the visible `Search loaded resources` label is removed.

Margins, gaps, borders, and row heights are reduced only inside the Kubernetes page. Host and Proxy page layouts are unchanged.

### Resource list

The Kubernetes shell overrides the shared centered maximum-width layout while the page is active. Its list and workspace expand to the available application content width.

The virtual table retains its fixed row height and renderer-side bounded-window contract. Header and row grids use the same eight columns:

`Namespace | Name | CPU | Memory | Restarts | Status | Node | Age`

Each field has `white-space: nowrap` and truncates in its own cell. A minimum grid width lets the table viewport provide horizontal scrolling rather than wrapping or changing the document width.

For Pods, the main-process summary projection adds display-safe strings:

- `cpu`: sum of normal-container `resources.requests.cpu` values.
- `memory`: sum of normal-container `resources.requests.memory` values.
- `restarts`: sum of normal and init `restartCount` status values.
- `node`: `spec.nodeName` or an em dash.

Quantity parsing and formatting remain pure main-process utilities and are applied to both LIST and Watch objects by the existing summary mapper. Non-Pod kinds show an em dash in these Pod-specific columns.

## Right Resource Drawer

The drawer is an overlay sibling of the list, positioned on the right of the Kubernetes page. It uses a scrim only to make close affordance clear; it does not suppress the active list Watch or prevent background list rendering. Opening another row replaces the drawer content with a new detail generation; no stale request may repaint the new drawer.

All resource kinds use the drawer frame. Non-Pod resources retain safe read-only summary, YAML, Events, and existing on-demand relationship behavior. Pod resources render this structure:

```text
Name: <name>                                  [View YAML]
Namespace: <namespace>
Labels: [expand]
Status: <phase>
Node: <node>
Pod IP: <podIP>
Pod IPs: <podIPs>

Containers
  <container name>                   [View logs] [Open shell]
  Status: <status>
  Image: <image>
  ImagePullPolicy: <policy or Default>
  Env: [expand]
  Mounts: <mount paths>
  Command: <command and args>

Events
  <timestamp/type/reason/message>
```

Labels and Env are collapsed by default. YAML uses a header icon and an internally scrolling drawer section instead of the former full-page YAML tab. Events are loaded on demand and display safe event text, not HTML.

Every Kubernetes-derived label, value, YAML text, Event message, environment entry, and error presentation is created through DOM nodes and `textContent`.

## Container Environment Values

The renderer never reads raw Kubernetes credentials or performs Secret reads itself. A narrow, main-process-only, read-only API resolves the selected Pod/container's declared environment:

- Literal `env.value` is returned directly.
- `secretKeyRef` reads only the referenced Secret key and returns its decoded plaintext value.
- `envFrom.secretRef` reads the referenced Secret, returns all imported decoded key/value entries, and applies the configured prefix.
- ConfigMap, field, resource-field, missing, optional, and unsupported declarations are explicitly labeled; they are not presented as fabricated evaluated values.

The API re-reads the target Pod and only reads Secrets that its selected container actually references. Secret reads are deduplicated within one request, bounded by entry count/value size/total payload size, and never enter the resource cache, list snapshots, Watch data, settings, runtime diagnostics, console output, toasts, or disk.

The returned environment model exists only in the active drawer/container panel. It is cleared before drawer replacement or close, Context switch, page leave, disconnect, and app shutdown. Local Env search runs only over that short-lived renderer model. A 401/403 shows a fixed local `No permission to read referenced Secret` state without disconnecting the Context; missing data is shown as `Missing` without leaking values in an error.

## Bottom Logs and Shell Workspace

The list page owns a bottom workspace that appears when at least one tab is open. A tab key includes namespace, Pod name, container, and type (`logs` or `shell`). Selecting a container action:

- opens a new matching tab if none exists;
- focuses the existing matching tab otherwise;
- never opens duplicate log streams or terminal sessions for the same key.

Logs tabs retain search, Follow pause/play, Clear, ANSI rendering, bounded 2,000-line buffers, and immediate bottom-follow behavior. Shell tabs reuse the existing terminal shell fallback, xterm lifecycle, exact session-ID ownership, and late-final-event fences, but render the active terminal inside the bottom workspace rather than a floating terminal drawer.

Closing an individual tab closes only its own log stream or terminal session. Closing the right detail drawer preserves all workspace tabs. Leaving Kubernetes, changing/disconnecting Context, and application shutdown close every workspace tab and clear their UI ownership before late broadcasts can recreate them.

## Error Handling and Race Safety

- Drawer replacement increments the existing detail generation before any async detail, Event, environment, relation, or action request.
- The list keeps its Watch and virtual rendering active while a drawer is open.
- A response only changes the drawer when its generation, target identity, and page visibility still match.
- Workspace log updates are routed by exact session ID and tab ownership, not just container name, so similarly named containers in different Pods never cross-update.
- Workspace terminal final events require exact owned terminal session ID and cannot reopen a locally closed tab.
- The existing ten-active-forward limit, read-only Kubernetes operations, port-forward lifecycle, and Secret non-persistence rules remain unchanged.

## Testing and Acceptance

Add focused Node tests for:

- CPU/Memory request aggregation, restart totals, Node projection, quantity formatting, Watch projection, and compact eight-column list rendering.
- Full-width Kubernetes-only layout, label-free compact control rows, removed Cluster category, non-wrapping table cells, and internal horizontal scrolling.
- Pod drawer model fields, labels/YAML/Events rendering, container actions, drawer replacement, and stale completion guards.
- Environment resolver behavior for literal values, `secretKeyRef`, `envFrom` prefixes, missing/optional values, 403 isolation, deduplicated reads, bounded results, and non-persistence.
- Multiple Logs/Shell tabs, target-key reuse, individual tab close, drawer-close preservation, Context/page cleanup, late log broadcasts, terminal finals, and Follow behavior.

Run `pnpm test`, `git diff --check`, then validate with the real Electron app and DevTools using Context `开发环境(外网)`, Namespace `ai-dev`, and Pod `ai-aigc-lms-ui-56877dd45b-6wv4s`. Verify the default 1230×820 view, a 900×620 view, the eight-column list, right drawer content, decoded Env search, multiple workspace tabs, and no renderer exception/unhandled rejection.
