# Kubernetes Table and Input Polish Implementation Plan

> Execute autonomously on `main`; the user explicitly waived review checkpoints.

1. Add a pure terminal-input validator and failing tests proving that spaces, Enter/control input, and complete commands are preserved exactly while invalid/oversized values fail.
2. Replace the terminal IPC handler's trimming text validator with the terminal-specific validator; keep ID validation unchanged.
3. Extend resource-summary tests with a client-style `Date` creation timestamp, then normalize valid string/Date timestamps to ISO text in `kubernetesClient.ts`.
4. Add a pure sort transition helper and renderer contract tests for clickable table headers, active direction semantics, and removal of the sort selects/hint.
5. Store sort state in the Kubernetes page controller, wire header-button delegation, update back-stack restoration, and add local inline sort SVGs plus aligned Tailwind styles.
6. Put Logs search and actions in one header, remove the Load older control and renderer call path, and retain automatic bounded following logs.
7. Hide the resource-type tab strip when Custom Resources is active and render its discovery select immediately.
8. Update README.md and AGENTS.md for terminal input preservation, timestamp/Age behavior, header sorting, Logs controls, and Custom Resources selection.
9. Run focused tests and `pnpm test`; then launch `pnpm dev`, use DevTools against the development external Context and `ai-dev` Pod for read-only keyboard/UI validation, stop the app, stage all intended changes, and commit.
