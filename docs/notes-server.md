# Notes Server

Notes can use a single Linux server as their authoritative workspace. The desktop keeps a separate read cache and durable drafts; it does not run a second offline database synchronization protocol. After migration, the original local Notes database is retained only for recovery and is no longer an active data source. Images, attachments and published shares continue to use S3.

## Configure and deploy

Open **Settings → Notes → Notes Server**, enter a direct SSH host, port, username and password or select a Vault private key, and select **Save Server**. **Add Private Key** opens the shared Vault form with paste/import and optional passphrase; stored credentials are never returned to the renderer. Saved credentials use Electron secure storage and are excluded from normal configuration exports and S3 synchronization. Linux clients require a functioning secure keyring; plaintext credential fallback is not supported.

Select **Test Connection**, then **Deploy & Start**. The target must have Linux x64 or ARM64 with glibc compatible with Node.js 24, systemd user services, `tar`, `sha256sum`, and at least 512 MiB free. Enable lingering for the SSH account with `sudo loginctl enable-linger <username>` if the preflight requests it. The application does not elevate privileges or install system packages. The server does not require an existing Node.js installation or outbound Internet access.

The desktop bundles both official Node.js v24.21.0 Linux runtimes and the server program. The build verifies pinned archive SHA-256 hashes; SSH upload is verified again on the target. The runtime compatibility check executes the bundled Node binary and loads its SQLite module before activation.

Production uses `~/.local/share/service-manager-notes` and `service-manager-notes.service`; development uses `~/.local/share/service-manager-dev-notes` and `service-manager-dev-notes.service`. The data directory, token and service are isolated. The API binds only to `127.0.0.1` (production port 47831; development 47832). The desktop uses a direct `ssh2` channel plus a random API token. No system SSH binary, SSH agent or public HTTP port is needed.

**Start**, **Stop**, **Restart**, **Logs** and **Cancel operation** manage the service. Closing the desktop does not stop it. Updates install a new version directory, take a consistent SQLite backup, switch the active symlink and check health. Failed upgrades restore the previous program, unit, config and database. Interrupted upgrades record a private recovery journal; the next deployment recovers it before proceeding. Old releases and upgrade backups are retained for recovery; administrators can prune them after confirming the new version works.

## Migrate to server storage

- **Migrate Local Notes & Use Server** first flushes editors and backs up the local SQLite database under the desktop profile's `notes-server-migration-backups` directory. It imports into an empty server, preserves note IDs, timestamps, hierarchy and tombstones, verifies the result, then activates server storage. Retrying the same migration is idempotent. A nonempty server is never overwritten.
- **Use Existing Server Notes** connects to an existing server workspace without importing local data. Additional clients use this option with the same SSH account and S3 settings for attachments.

Server mode disables S3 synchronization of the Notes database while preserving the settings-only S3 protocol and asset operations. Existing cloud Notes databases are not overwritten or deleted. Switching back to the original local database is not supported, including when the server is disconnected.

## Drafts, conflicts and backups

When disconnected, cached notes remain readable and edits are saved locally as drafts. Creating, moving and deleting notes require a connection. The editor explicitly displays **Draft saved locally** instead of claiming a server save. Drafts survive quit/restart and are isolated by connection and server identity. A replaced server database requires an explicit reconnect; drafts are never silently applied to another identity.

Edits use optimistic concurrency. A conflicting edit remains a draft. **Recover Drafts as Notes** retries unchanged bases and saves conflicts as separate `Conflict - …` notes, preserving both versions, including drafts whose original note was deleted. Reconnection and focused-window checks refresh the workspace without replacing dirty editors.

The service makes consistent daily SQLite backups and retains the newest seven daily files. Upgrade backups are separate. **Download Backup** creates and downloads a SQLite backup of the server database. Backup files contain private note content and should be stored privately. To restore manually, stop the user service, retain the current database, copy the selected backup to `data/notes.sqlite3`, remove stale WAL/SHM files only while stopped, and restart the service. Client identity and revision checks protect stale clients; reopen the workspace and resolve retained drafts after a restore.

## Development and API

Use Node.js 24 LTS for development. `pnpm build` compiles the independent CommonJS server and prepares verified Linux runtimes, cached under `node_modules/.cache/notes-runtime`. The first build needs access to nodejs.org; subsequent builds reuse verified cache entries. Electron packages unpack the server payload and runtimes so they can be transferred as files. No new npm dependencies are needed.

`pnpm test` runs the Electron application tests and `test:notes-server` under Node.js 24. Server tests use temporary databases and loopback ports. The API is versioned at `/v1`, requires Bearer authentication, and has bounded request sizes and timeouts. Endpoints include health, workspace, search, note CRUD/move/deletion preview, empty-workspace import, transactions and backup download. Writes require `requestId` and `expectedRevision`; conflicting writes return HTTP 409. The desktop stages existing Notes operations in its isolated SQLite cache and submits an atomic change set, including tree changes, to the server. A durable pending request handles lost commit acknowledgments without duplicate operations.

## Required startup setup

New installations and existing local-only profiles must complete Notes Server setup before opening any panel. The startup form uses the same encrypted, device-local configuration shown in Settings → Notes. Save, Deploy & Migrate deploys the server, backs up local Notes, imports them, verifies their contents, and opens the remote workspace. Saving a connection alone never unlocks the application; failures remain on the setup screen and can be retried. Completion persists across restarts. Previously connected server profiles are recognized automatically.

An empty local workspace can connect to an existing shared server. If both local and server workspaces contain notes, setup stops without overwriting either workspace; automatic merging is not supported. Cancel stops the current SSH operation but does not skip setup. After completed onboarding, server storage remains authoritative. The original local database and migration backup are retained only for manual recovery; there is no switch back to local storage.

Notes Server reuses the device-local [Private key Vault](vault.md). Existing inline keys migrate to Vault references automatically.

## Reuse an existing Host

The startup setup and Settings → Notes offer existing Hosts first. Selecting a Host copies its current direct SSH connection and authentication into the device-local Notes configuration without returning secrets to the renderer. Vault keys remain shared references. Hosts with jump servers are marked unavailable because Notes deployment requires direct SSH.

Choose **Add New Host…** to enter a new connection. Saving, testing, or beginning setup registers this Host in the same persistent store used by the Hosts panel; retries reuse an identical Host. It starts with no tunnels or services. The saved Host selection is shown in Settings → Notes. Later Host edits do not silently redirect an existing Notes service to another server.
