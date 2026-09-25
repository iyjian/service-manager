# Reusable panel windows

`src/main/core/panelRegistry.ts` is the trusted catalog of detachable panels. `PanelWindowManager` handles persistent views, native windows, bounds, focus, close-to-merge behavior, IPC authorization and disposal without panel-specific branches. The shell reads the catalog through the controlled `panelWindowApi.list()` API; it does not maintain another panel list.

## Adding a panel

1. Implement its renderer page with a matching `main[data-page="your-panel"]` root and call the existing `registerPage` API during renderer initialization. Supply its icon and lifecycle handlers as for existing pages.
2. Add `{ id: 'your-panel', title: 'Your Panel', icon: 'boxes' }` to `PANEL_DEFINITIONS`. IDs must be unique lowercase identifiers with optional digits and hyphens. The first entry is the startup fallback.

The optional `icon` uses the local Lucide icon registry and should match the renderer page icon; omitted or unknown names use the boxes icon.

No window-manager, preload, shell-navigation or detach-button changes are needed. Renderer business-page initialization is still required; the catalog does not dynamically load executable modules. Keep backend operations behind authenticated, validated IPC interfaces.

## Lifecycle

Each registered panel has at most one lazily created WebContentsView. Switching, detaching and merging retain that view. Window moves must not invoke page teardown or serialize editor/terminal state. Background panels remain alive; bound polling and resource use accordingly. Renderer destruction and application quit perform cleanup through the existing surface callbacks. A detached native window closing merges its view into the main window.

Only trusted main-process code registers panel definitions. Renderer requests supply a validated catalog ID, never a renderer URL, preload path or executable code. The registry can be injected into the manager for testing; tests exercise a future panel absent from the production catalog.
