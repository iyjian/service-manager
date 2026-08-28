# AGENTS.md

## Project Overview

Service Manager is an Electron + TypeScript desktop application designed as a unified management console for remote development infrastructure and engineering workflows.

Main capabilities:

- SSH host management
- SSH local port forwarding
- Remote service lifecycle management via systemd user services
- Local Mihomo proxy management
- Kubernetes resource management
- SQL workspace
- Notes and cloud synchronization

The project uses:

- Electron
- TypeScript
- Node.js main process
- Renderer-based UI
- pnpm build workflow


## General Development Rules

- Keep changes small and focused.
- Prefer incremental improvements over large rewrites.
- Always preserve existing behavior unless explicitly requested.
- Add or update tests for important logic changes.
- Keep UI language and terminology consistent in English.
- Do not introduce unnecessary dependencies.


## Dependency Rules

- Do not install dependencies automatically.
- If a new dependency is required, ask the user to run:

```bash
pnpm install
```

- Keep dependency versions synchronized with package manifests.
- Update related documentation when dependency changes affect runtime behavior.


## Architecture Rules

### Electron

- Keep main-process responsibilities separate from renderer responsibilities.
- Sensitive operations must stay in the main process.
- Renderer code must communicate through controlled IPC interfaces.

Never expose:

- credentials
- tokens
- private keys
- S3 secrets
- raw backend access

to the renderer.


### Data Storage

Keep local runtime data isolated.

Development and packaged application data must never:

- share the same runtime profile
- overwrite each other's data
- fallback to each other's storage


## SSH Rules

SSH operations must use:

- `ssh2`

Do not:

- call system `ssh`
- execute shell SSH commands

All SSH operations should have:

- timeout handling
- cancellation support
- error handling


## Kubernetes Rules

Kubernetes operations must use:

- `@kubernetes/client-node`

Do not:

- call `kubectl`
- depend on system Kubernetes binaries

Keep Kubernetes operations:

- bounded
- cancellable
- resource efficient


## Security Rules

Never log:

- passwords
- tokens
- private keys
- credentials
- SQL sensitive data

Validate all external input.

Do not trust:

- renderer input
- remote API responses
- uploaded files
- imported content


## UI Rules

Follow the existing application design system:

- compact layout
- high information density
- English UI text
- consistent dialogs
- consistent spacing and typography

Avoid:

- unnecessary cards
- excessive animations
- duplicated information
- large empty areas


## SQL Workspace Rules

SQL execution must:

- happen through authenticated backend APIs
- keep credentials in main process only
- support cancellation and timeout
- avoid leaking SQL data into logs

Do not:

- execute SQL directly from renderer
- store credentials in renderer storage


## Sync Rules

Cloud synchronization must:

- preserve local data safety
- support conflict handling
- avoid destructive overwrite

Never upload:

- credentials
- tokens
- private keys
- local-only preferences

without explicit encryption.


## Notes / Content Rules

User-generated content must be treated as untrusted.

Validate:

- rich text structure
- links
- attachments
- imported content

Avoid:

- injecting raw HTML
- executing user content
- loading remote unsafe resources


## Build and Verification

Before finishing changes:

1. Run type checking.
2. Run relevant tests.
3. Verify build output.
4. Check affected documentation.

Typical workflow:

```bash
pnpm install
pnpm build
pnpm test
```


## Documentation Rules

Update documentation when changes affect:

- architecture
- user-visible features
- runtime behavior
- configuration
- developer workflow

Keep detailed design documents outside AGENTS.md.


## File Organization Guidance

AGENTS.md should contain:

- project context
- engineering rules
- constraints
- development workflow

Do not put here:

- detailed module descriptions
- long feature specifications
- UI mock requirements
- complete API documentation
- implementation history

Those belong in `/docs`.


## Changelog Rules

Every code change that affects user-visible behavior, UI, configuration, dependency-driven runtime behavior, or user experience must update both:

- `CHANGELOG.md`
- `CHANGELOG.zh.md`

after the implementation is completed.

When updating changelog files:

- Add the latest changes to the top of the changelog.
- Keep the newest release entries first.
- Do not create a placeholder version such as `NEXT VERSION`, `Unreleased`, or `TBD`.
- GitHub CI automatically increments the version number during release.
- Treat the local `package.json` version as the latest released production version.
- Calculate the changelog version from the local `package.json` version plus 1, not from the latest existing changelog entry.
- If the changelog already has an entry for that next version, add the new notes to that existing entry instead of creating a higher version.
- Changelog entries are for users. Include only user-visible changes, important fixes, and behavior changes.
- Do not mention internal refactors, test changes, CI changes, contributor workflow, changelog maintenance rules, or implementation details unless they directly change user-visible behavior.
- Update only the current next-release entry unless the user explicitly asks to edit historical changelog entries.

For example:

- Local `package.json` version: `0.3.77`
- New changelog version should be: `0.3.78`

The changelog entry should:

- Follow the existing release history format.
- Use the calculated next version number directly.
- Use the current date.
- Describe user-visible changes, important fixes, and behavior changes.
- Keep entries concise and meaningful.
- Avoid internal implementation details.

Example:

```markdown
## [0.3.73] - 2026-08-22

### Fixed

- Fixed SQL enum-field tooltip behavior when database comments contain unexpected whitespace.

### Changed

- Improved cloud sync reliability when local notes and remote data change at the same time.
