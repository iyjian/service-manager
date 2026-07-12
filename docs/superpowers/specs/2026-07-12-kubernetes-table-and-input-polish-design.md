# Kubernetes Table and Input Polish Design

## Goal

Make the Kubernetes browser's terminal, logs, resource table, and Custom Resources controls behave like direct desktop controls while preserving the existing read-only and bounded-data contracts.

## Decisions

- Terminal input is an opaque, bounded string after IPC shape validation. Spaces, carriage returns, line feeds, tabs, and other xterm control sequences are preserved exactly; only non-string, empty, or oversized payloads are rejected.
- Kubernetes timestamps accept both wire-format strings and `Date` objects produced by `@kubernetes/client-node`. Valid dates are normalized to ISO strings before crossing IPC, so Age can always render and sort.
- Resource sorting moves from two selects to four small table-header buttons. Clicking a different column selects ascending order; clicking the active column toggles ascending/descending. The active direction is exposed with `aria-sort` and a local inline SVG indicator.
- The loaded-only explanatory sort sentence is removed. Search remains explicitly labeled as applying to loaded resources.
- The Logs title, search field, Follow button, and Clear button share one responsive toolbar row. The renderer no longer exposes or invokes loading an older 500-line page; bounded 500-initial/2,000-retained streaming remains unchanged.
- Selecting Custom Resources immediately reveals its CRD select. The synthetic `Custom Resources` resource-type tab is hidden for that category, while normal categories retain their resource tabs.

## Safety and Compatibility

- No Kubernetes mutation API is added or called.
- Terminal input remains capped at 65,536 characters and terminal IDs continue through the normal nonblank text validator.
- Timestamp normalization rejects invalid dates without leaking raw resource objects.
- Dynamic Kubernetes values continue to use DOM nodes and `textContent`.
- Sorting remains a main-process projection over already-loaded items and does not create a new LIST or Watch.

## Verification

- Pure tests cover whitespace/control terminal input and `Date` timestamp normalization.
- Renderer contract tests cover header sorting, responsive Logs controls, removed older-log UI, removed sort hint, and direct Custom Resources selection.
- `pnpm test` builds and executes the complete Node test suite.
- A real read-only development-cluster check opens the named Pod, confirms Age, types `ls -l` into xterm with the keyboard, exercises table sorting, and inspects Logs/Custom Resources without mutating cluster resources.
