# Kubernetes Namespace Selector And Client Binding Design

## Goal

Fix real Kubernetes read-only API calls against `@kubernetes/client-node` 1.4.0 and replace manual Namespace entry with a compact cluster-backed multi-select control on the same toolbar row as Context.

## Confirmed Root Cause

The main-process adapter stores generated Object API clients such as `CoreV1Api` and dispatches operations through a generic helper. The helper currently extracts a method and invokes it as a bare function:

```ts
const operation = api[method];
return operation(params);
```

Client-node 1.4.0 generated Object API methods access `this.api`. Bare invocation loses the owning client object, so `this` is `undefined` and every generic resource call can fail with `Cannot read properties of undefined (reading 'api')`.

This was reproduced through Electron DevTools/CDP with the authorized `开发环境外网(admin)` Context. The Context connected, then a read-only all-Namespace Pod LIST failed inside `listPodForAllNamespaces` before any resource rows were returned. No Kubernetes mutation was performed.

## API Call Fix

Keep the existing generic, read-only dispatch boundary and invoke the generated method with its original client as receiver:

```ts
return operation.call(api, params);
```

This is preferred over binding every method at construction time because it fixes all existing generated API clients in one auditable location. It is preferred over replacing string dispatch with a large typed switch because that would duplicate the resource-definition table and increase unrelated change risk.

A regression test must use an API method that reads a property from `this`, ensuring a future bare invocation fails the test.

## Namespace Discovery

Namespace choices come from the connected cluster rather than manual text entry. Add a dedicated read-only `listNamespaces(): Promise<string[]>` renderer bridge:

1. The runtime verifies there is a connected Context.
2. It calls the existing main-process Kubernetes client with a cluster-scoped `namespaces` query.
3. It follows 200-item continuation tokens until all Namespace pages are read.
4. It returns unique, non-empty Namespace names in deterministic sort order.
5. It opens no Watch and does not replace, page, filter, or scroll the active resource list.

The returned names are display-safe metadata. They are held only in renderer memory for the active Kubernetes page and Context. They are not persisted to settings, the Context preference, logs, diagnostics, or disk.

RBAC or transport errors use existing behavior: a Namespace-list 401/403 is local to the selector and produces an English page toast while the connected Context remains usable; a categorized transport failure follows the existing connection-loss path.

## Toolbar And Interaction Design

Context and Namespace remain side by side on a single toolbar row. Each control has one label and one compact control below it.

Remove:

- The `Add Namespace` text field.
- The Add button.
- Selected-Namespace tag chips and per-tag remove buttons.

The Namespace button opens a checkbox menu populated from `listNamespaces()`:

- `All Namespaces` is the first shortcut and represents `{ mode: 'all', namespaces: [] }`.
- Selecting `All Namespaces` clears concrete selections and immediately activates the all-Namespace scope.
- Concrete Namespace entries support multiple checked values.
- Selecting a concrete Namespace leaves All Namespaces mode and sends the sorted selected set.
- Unchecking the final concrete Namespace returns to All Namespaces so an invalid empty selected scope is never emitted.
- The closed button reads `All Namespaces`, one Namespace name, or `<N> Namespaces`.
- While names are loading, the menu shows `Loading Namespaces…`; an empty result shows `No Namespaces available`.

On initial page show, Context change, reconnect, or confirmed kubeconfig reload, the renderer reloads Namespace names only after the Context is connected. A stale response is discarded if the page closes or Context changes before it resolves.

All Namespace names are created with DOM nodes and `textContent`; Kubernetes-derived values never enter `innerHTML`.

## Lifecycle And Resource Behavior

The existing `KubernetesNamespaceScope` data model remains unchanged. Resource queries continue to include either All Namespaces or the selected concrete set. Nodes and Namespaces remain cluster-scoped regardless of the selector.

Context switching still disposes the former Context's Watch, log, terminal, and forward resources. Namespace discovery creates no owned stream. Page hide clears renderer-held Namespace names and invalidates any pending response.

Changing Namespace selection continues to deactivate the old active-view Watch and activate exactly one Watch for the new scope.

## Testing

Main-process tests cover:

- Generated Object API methods retain their receiver during all-Namespace and namespaced LIST calls.
- Namespace names are read through 200-item continuation pages, deduplicated, filtered, and sorted.
- Namespace discovery does not activate or replace ResourceCoordinator state and does not open a Watch.
- 401/403 remains selector-local; transport failures use existing connection handling.
- Namespace values and API responses are not persisted or logged.

Renderer/static tests cover:

- Context and Namespace share one toolbar row.
- Add Namespace controls and selected tag markup/code are absent.
- All Namespaces is the first shortcut.
- Concrete options are checkbox-based and text-safe.
- Multiple selection sends sorted selected Namespaces.
- Removing the last selection returns to All Namespaces.
- Context changes invalidate stale Namespace-list responses.

Real application validation uses Electron DevTools/CDP without screenshots:

- Select `开发环境外网(admin)`.
- Confirm connected state.
- Confirm Namespace options load from the cluster.
- Select one concrete Namespace, then multiple Namespaces, then All Namespaces.
- Confirm read-only Pods and Services lists load without `this.api` errors.
- Confirm no create, patch, delete, Apply, Scale, Restart, or lifecycle operation is invoked.

Final verification is `pnpm test`, using the repository's pinned pnpm 9.1.2.

## Documentation

Update `README.md` and `AGENTS.md` to describe cluster-backed Namespace discovery, compact multi-selection, All Namespaces behavior, no manual Namespace entry, and receiver-safe client-node Object API dispatch.
