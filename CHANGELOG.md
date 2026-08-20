# Changelog

All notable changes to Service Manager are documented in this file. The newest releases are listed first.

## [0.3.69] - 2026-08-20

### Added
- Notes can now create expiring S3 share links. Shared Notes are published as single static HTML snapshots, with 24-hour, 3-day, or 7-day signed links, signed Rich Text media, link history, copy actions, and S3 share deletion.

### Changed
- The Notes share dialog is now narrower and more compact, with one-line current-link and history rows.
- Shared Note code blocks now use the same bounded syntax highlighting and inline styling as Note PDF/Rich Text output.

## [0.3.68] - 2026-08-19

### Added
- Inline cell editing in SQL query results: double-click a result cell to edit its value and run a generated UPDATE statement.
- A "What's New" dialog that shows the full changelog on first launch after an update, with Chinese/English tabs.

### Changed
- The SQL cell editor's Execute button now greys out when there are no changes or after a successful update (with a hover hint), and shows inline success/error status.

## [0.3.67] - 2026-08-18

### Changed
- Improved SQL auto-completion for tables, columns, and keywords.

## [0.3.66] - 2026-08-18

### Changed
- Small UI and layout refinements for the SQL and Kubernetes pages.

## [0.3.65] - 2026-08-15

### Changed
- Removed bundled code and CJK fonts so the app uses the native system fonts. This reduces the package size while keeping the interface crisp on every platform.

## [0.3.64] - 2026-08-15

### Changed
- Polished the Kubernetes browser and the SQL page layout and styling.

## [0.3.63] - 2026-08-14

### Changed
- Tuned the release workflow and packaging metadata.

## [0.3.62] - 2026-08-10

### Added
- Untitled SQL drafts are now saved automatically and restored after a restart, separately per environment (Production/Development).
- Richer Kubernetes resource summaries, pod interactions, and cluster session handling.

### Changed
- Broad polish across the Kubernetes workspace, drawers, and SQL statement editing.

## [0.3.61] - 2026-08-05

### Changed
- Improved the SQL page and result handling.

## [0.3.60] - 2026-08-03

### Added
- A single-instance lock now prevents a second copy of the app from opening the same user data, protecting against corrupted settings and conflicting writes.

## [0.3.59] - 2026-08-02

### Changed
- Improved Kubernetes client reliability and the Kubernetes page.

## [0.3.58] - 2026-08-02

### Added
- Virtualized scrolling for SQL query results, so large result sets stay smooth.

## [0.3.57] - 2026-08-01

### Added
- Virtualized SQL result tables and further Notes improvements.

## [0.3.56] - 2026-07-31

### Added
- SQL credentials are now protected with the operating-system credential store.
- Improved SQL statement parsing and result rendering.

## [0.3.55] - 2026-07-31

### Added
- SQL auto-completion: type or press Ctrl+Space to see keywords, tables, and columns.

## [0.3.54] - 2026-07-30

### Added
- Inline highlighting of the SQL statement that would be executed.

## [0.3.53] - 2026-07-30

### Added
- Expanded SQL completion and runtime support.

## [0.3.52] - 2026-07-30

### Added
- A startup S3 sync gate that keeps the app on a loading state until the initial cloud reconciliation finishes.

## [0.3.51] - 2026-07-30

### Added
- Virtualized SQL result table for fast, scrollable large results.
- Proxy Strategy Groups view: select a node per group and see live download/upload rates.

## [0.3.50] - 2026-07-30

### Added
- A font toggle (Default / Comic) for the SQL editor, with a locally bundled Comic Mono face.

## [0.3.49] - 2026-07-30

### Changed
- Refined the SQL page.

## [0.3.48] - 2026-07-30

### Changed
- Improved the SQL runtime and Notes page.

## [0.3.47] - 2026-07-30

### Changed
- Persistent Notes tree view state and rich text editor improvements.

## [0.3.46] - 2026-07-30

### Added
- A complete SQL query workspace: sign in, browse and run saved queries, edit with CodeMirror, and view structured results.
- S3 synchronization was upgraded to an encrypted, immutable v4 object layout with conflict-safe merging.

## [0.3.45] - 2026-07-29

### Changed
- Notes page refinements.

## [0.3.44] - 2026-07-29

### Added
- A durable Notes workspace apply coordinator that stages and commits tree changes safely.

## [0.3.43] - 2026-07-29

### Added
- Notes search: find notes by name, tag, language, and content, with ranked results.

## [0.3.42] - 2026-07-28

### Added
- Syntax highlighting inside rich text code blocks for 37 programming languages.

## [0.3.41] - 2026-07-26

### Added
- Notes editor font size (12-24px) and Light/Dark theme preferences, saved per device.

## [0.3.40] - 2026-07-26

### Changed
- Rich text editor improvements.

## [0.3.39] - 2026-07-26

### Changed
- Rich text editor styling refinements.

## [0.3.38] - 2026-07-26

### Changed
- Rich text editor refinements.

## [0.3.37] - 2026-07-22

### Added
- File attachments in Notes: attach files up to 25 MiB, preview supported types, and download the rest.
- Markdown export for Notes.
- Note file-type icons for attachments.

### Changed
- Notes attachments are stored as private encrypted S3 objects.

## [0.3.36] - 2026-07-22

### Changed
- Minor Notes UI tweaks.

## [0.3.35] - 2026-07-22

### Added
- A runtime data profile for the app, with related Notes settings refinements.

## [0.3.34] - 2026-07-22

### Fixed
- Resolved UI lag (jank) during typing and page interactions.

## [0.3.33] - 2026-07-20

### Changed
- Major Kubernetes workspace and pod interaction improvements, plus a hardened service runtime.

## [0.3.32] - 2026-07-20

### Changed
- Notes store and S3 sync improvements (v3 layout), plus renderer stability work.

## [0.3.31] - 2026-07-20

### Fixed
- Raised the Trilium image import budget.
- Prevented S3 note conflict storms.

## [0.3.30] - 2026-07-20

### Added
- Compact S3 sync progress display.
- Click tree nodes to toggle expansion.

### Fixed
- Trilium image/jpg attachments now import correctly.
- Marked Tiptap hard breaks import correctly.
- Subtree deletion is now responsive and recoverable.

## [0.3.29] - 2026-07-19

### Added
- Privacy-safe Sentry error reporting to catch and report crashes without sensitive data.

### Fixed
- Prevented the rich text table menu from trapping focus.

## [0.3.28] - 2026-07-19

### Added
- Import Notes from Trilium through its ETAPI, including images and attachments.

## [0.3.27] - 2026-07-19

### Added
- Refined Notes split pane and save state behavior.

## [0.3.26] - 2026-07-19

### Added
- Notion-style rich text tables.
- Improved rich text image layout, aligned with the Novel editor.

## [0.3.25] - 2026-07-19

### Changed
- Refined to-do items and Notes tree controls.

## [0.3.24] - 2026-07-19

### Added
- A Novel-style slash command menu for rich text.

### Fixed
- Kept the slash selection visible while scrolling.

## [0.3.23] - 2026-07-19

### Added
- Hierarchical Notes with a collapsible tree.
- Local LLM settings (OpenAI-compatible endpoint and model).

## [0.3.22] - 2026-07-19

### Added
- Rich text Notes with images stored in S3.

## [0.3.21] - 2026-07-19

### Added
- Local Notes with encrypted S3 backup.
- Cloud-authoritative S3 auto sync (MinIO-compatible).
- Tabbed Settings with S3 connection test.
- An independent sync encryption key and bundled note fonts.
- SQL and Notes syntax highlighting.

### Fixed
- Accept custom sync encryption passphrases.
- Align S3 credential visibility icons.

## [0.3.20] - 2026-07-18

### Added
- Kubernetes port forwarding and a log workspace.
- Custom resource columns now follow CRD printer columns.

## [0.3.19] - 2026-07-17

### Changed
- Refined the Kubernetes pod detail status UI.

## [0.3.18] - 2026-07-17

### Added
- Launch KubeVirt virtual machine consoles over VNC, including a password-free macOS flow.

## [0.3.17] - 2026-07-16

### Fixed
- Fixed Kubernetes shell Unicode input.
- Fixed app shutdown and Kubernetes shell editing.

## [0.3.16] - 2026-07-16

### Fixed
- Fixed Kubernetes context reconnect flashing.
- Improved Kubernetes selectors and resource lists.

## [0.3.15] - 2026-07-15

### Changed
- Improved Kubernetes namespace and pod log UX.

## [0.3.14] - 2026-07-13

### Changed
- Redesigned Kubernetes resources as a drawer-based workspace.

## [0.3.13] - 2026-07-12

### Changed
- Introduced a Kubernetes detail workbench.

## [0.3.12] - 2026-07-12

### Changed
- Refined Kubernetes detail interactions, namespace multiselect, and default pod log opening.

## [0.3.11] - 2026-07-12

### Added
- Multi-kubeconfig discovery: scan your .kube directory and connect any discovered context.

## [0.3.10] - 2026-07-12

### Added
- A full read-only Kubernetes browser: contexts, namespaces, workloads, network, configuration, storage, and custom resources, with virtualized tables, detail drawers, logs, and terminals.

## [0.3.9] - 2026-07-12

### Added
- Proxy node delay testing, auto-start, and live traffic streaming.

## [0.3.8] - 2026-07-12

### Added
- A runtime log writer and an improved service runtime.

## [0.3.7] - 2026-07-11

### Fixed
- Serialized proxy lifecycle operations to avoid startup/shutdown races.
- Match remote services unambiguously by service ID.

## [0.3.6] - 2026-07-11

### Added
- A full Clash-compatible proxy runtime (Mihomo core) with subscription, mixed port, system proxy, and TUN support.

## [0.3.5] - 2026-07-11

### Added
- Selectable proxy strategy groups.
- Cleaner update error handling.

### Changed
- Tightened UI density and added host identity cues.

## [0.3.4] - 2026-05-09

### Changed
- Minor UI refinements.

## [0.3.3] - 2026-05-07

### Changed
- Migrated the interface styling to Tailwind CSS.

## [0.3.2] - 2026-05-05

### Added
- Host config validation, config transfer (import/export), and a dedicated host connection layer.

### Changed
- Refactored the service runtime into a cleaner, more reliable structure.

## [0.2.17] - 2026-05-05

### Changed
- Minor styling adjustments.

## [0.2.16] - 2026-05-05

### Changed
- Minor styling adjustments.

## [0.2.15] - 2026-05-05

### Changed
- UI improvements to the host list and dialog.

## [0.2.14] - 2026-04-18

### Changed
- Service runtime and renderer refinements.

## [0.2.13] - 2026-04-18

### Changed
- UI improvements.

## [0.2.12] - 2026-04-18

### Changed
- UI improvements and design refinements.

## [0.2.11] - 2026-04-18

### Changed
- UI improvements and design refinements.

## [0.2.10] - 2026-04-11

### Added
- SSH jump-chain support: connect to a target through one or more intermediate hosts.

## [0.2.9] - 2026-04-11

### Changed
- Documentation updates.

## [0.2.8] - 2026-03-08

### Changed
- Service runtime and UI improvements.

## [0.2.7] - 2026-02-22

### Added
- App icons for all platforms.

## [0.2.6] - 2026-02-21

### Added
- Automatic update checking and download.

## [0.2.5] - 2026-02-21

### Changed
- Service and tunnel management refinements.

## [0.2.4] - 2026-02-21

### Changed
- CI/CD release workflow improvements.

## [0.2.3] - 2026-02-21

### Fixed
- Fixed automatic updates.

## [0.2.2] - 2026-02-20

### Changed
- CI/CD release workflow setup.

## [0.2.1] - 2026-02-20

### Added
- The first release of Service Manager: manage remote servers over SSH, including hosts, jump chains, tunnels, and services with live status and logs.
- Automatic updates and CI/CD packaging.
