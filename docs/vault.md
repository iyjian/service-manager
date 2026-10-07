# Vault

The **Vault** panel stores Logins and reusable SSH keys. Use the category sidebar, search by SSH key name, website URL or username, and select an item to view its details. Select **Add Private Key**, enter a name, paste the key or choose **Import**, and provide its passphrase if needed. Import opens `~/.ssh` by default, or the user home directory if that directory is unavailable, matching Add Host. New keys and passphrases are validated before saving. Host targets, jump hosts, and Notes Server select keys by name. The panel supports the same detach/merge workflow as other panels. The Notes startup setup can also add a key without opening the main workspace.

On startup, existing inline Host keys, imported key files, and jump-host keys migrate automatically. Names are assigned as `privateKey1`, `privateKey2`, and so on; identical key contents with the same passphrase reuse an existing entry. Existing Notes Server keys also migrate. The encrypted Vault is written first, then host configuration is atomically replaced with key references. Interrupted migration can be retried without duplicate entries. Original imported key files are not deleted.

The local recovery cache is encrypted using the operating system's secure storage in the active application profile. Development and packaged profiles remain separate. Renderers receive only key IDs, names, and creation dates; importing a file keeps its contents in the main process. Use **Rename** to change a label or **Replace key** to import/paste a replacement and its passphrase. Both preserve the key ID, so Host, jump-host, and Notes Server references remain valid. Replacement validates the new key before atomically saving it; invalid credentials or storage failures preserve the previous key. Concurrent edits from another window are rejected instead of overwriting newer changes. Deletion is not exposed. Existing sessions remain open; new SSH connections and automatic tunnel reconnects use the replacement. The corresponding public key must already be authorized on the target servers.

Plain JSON configuration exports contain Vault references, not private keys or passphrases. A reference exported to another device requires the corresponding key to be added and selected there. The existing encrypted S3 Host synchronization continues to transfer credentials within its encrypted payload; receiving clients migrate these credentials into their own Vault. Unused Vault keys and Notes-only keys are not added to cloud synchronization.

Keep the original private key files securely backed up; see remote backup requirements below.

The Vault list supports name search and shows creation/update dates. Key changes refresh open windows and selection lists automatically. Renaming does not reveal or change the private key or its passphrase.

## Website logins

**Add Login** sits under **Logins** in the category sidebar; **Add SSH Key** sits under **SSH Keys**. Only **Refresh** remains in the page header. Search is in the list pane, and a single footer line reports connection, recovery cache and clipboard status.

A website Login contains one required HTTP/HTTPS **Login URL** and 1–200 accounts. Each account has its own **Username**, **Password**, and **Notes**. Use **Add Account** or **Remove** while editing. There are no Name, Application, or Tags inputs. URLs containing embedded credentials or non-web protocols are rejected. Adding a second entry for the same normalized URL is rejected; edit the existing website to add accounts.

Passwords are hidden by default. The eye icon reads only the selected account through trusted, revision-checked IPC and reveals it inline. Clicking again, switching entries, leaving the window, or waiting 30 seconds hides it and clears the displayed value. Copy/show actions target the selected account. **Open Website** opens the login URL. Password generation creates a cryptographically random 24-character password for the selected account when saved. The editor pre-fills saved passwords, masks them by default, and provides an eye toggle. Saving a blank password clears it; new accounts may also have an empty password. Removing an account removes its credentials on Save. Concurrent edits reject stale revisions.

Existing Login records automatically convert to account groups. Multiple legacy URLs split deterministically into separate website entries, preserving passwords and notes for each URL. A legacy entry with no URL remains available with “Website URL needed”; enter a website URL to save further edits. SSH key IDs and references do not change.

Copied Vault values are excluded from the application’s clipboard history and cleared after 30 seconds only if the clipboard still contains that value.

## Import from Chrome

In Chrome Password Manager, open **Settings → Export passwords** to save a CSV. In Vault, choose **Add Login → Import from Chrome** and select that file. The file picker reads the CSV in the main process; no Chrome profile or operating-system password store is accessed directly. The export contains plaintext passwords, so delete the exported file yourself when it is no longer needed.

A paginated preview shows URLs, usernames, hidden-password indicators, per-account notes, and the result for each row. Select the accounts to import, then choose **Import Selected**. Cancel does not change the Vault. Preview secrets remain in main-process memory, expire after ten minutes, and are discarded on cancellation or window closure.

Accounts with the same normalized URL merge under that website. Exact duplicates are skipped. An existing username with a different password or note is marked as a conflict and skipped, never overwritten. Invalid/non-web URLs are skipped without echoing embedded URL credentials. `name` columns are ignored; `note` and `notes` columns are supported. Imports accept UTF-8 CSV with an optional BOM, quoted commas and multiline notes, up to 8 MiB and 10,000 rows. A website can contain at most 200 accounts.

The selected import is one atomic Vault write. The confirmation button shows `Importing…` during the write; progress and errors remain visible beside the footer buttons. A committed import closes the preview even if refreshing the list subsequently fails. If the Vault changes after preview, confirmation requires a fresh preview. Importing the same file again skips already saved accounts. A failed connection or write preserves the previous Vault and existing credentials.

## Remote database and automatic migration

Vault reuses the configured, enabled Notes Server through its authenticated SSH API. It has an independent `vault` table in the server's `data/notes.sqlite3`; it is not part of the Notes workspace or S3 Notes payload. All Vault records are encrypted at rest with AES-256-GCM. The encryption key is stored separately in `data/vault-encryption.key` with owner-only permissions. SSH encrypts transport. The server operator can decrypt Vault contents with this key; this is server-managed encryption, not a user-master-password or zero-knowledge service.

On application startup, after the Notes connection settings and local SSH keys load, Vault checks the server (checking both the Notes Server version and Vault format capability; a same-version server with an older Vault format is upgraded once per launch using the backed-up deployment flow), copies the original encrypted local file to `vault.json.migration-backup`, imports entries without changing their IDs, reads them back, and marks the verified database identity in the encrypted cache. Existing server entries are preserved. A conflicting ID fails migration rather than overwriting either copy. Interrupted imports are idempotent. No source key files or local backups are deleted. Migration failure does not block startup; **Refresh** retries, and later writes also retry connecting. Without an enabled Notes Server, the Vault continues to use local encrypted storage until setup is complete.

After migration the server is authoritative: writes require a connection and reject stale revisions. The local encrypted recovery cache supports startup SSH authentication (including the key used to connect to Notes Server), so there is no circular dependency. It also allows existing keys to remain usable during an outage. A different server database identity is rejected instead of automatically importing the old cache elsewhere. Remote changes are loaded at startup, on **Refresh**, and before writes. A network failure after a committed write may require Refresh to see the successful change before retrying an edit.

Development and packaged applications keep their separate local profiles and separate Notes Server deployment directories. No production files are read or migrated by the development profile.

Back up **both** the server database and `data/vault-encryption.key`; SQLite backups include encrypted Vault data but deliberately do not contain its key. The local encrypted cache is device-bound and is not a portable backup. Restoring a database without its original encryption key must fail rather than create a replacement key.

Switching Vault categories selects the first matching item. The active list row stays highlighted; changing entries clears detail text selections. Username and password occupy separate aligned rows: a 96px label column, a value column capped at 320px, and 36px icon buttons. Copy icons align vertically; the password eye follows its copy icon. Larger dark labels improve readability. Narrow panes place labels above their values while keeping icons alongside.

Each website Login row has a Delete button. A native confirmation defaults to Cancel and explains that all accounts and notes are removed. Deletion checks the reviewed revision, clears credentials from the current record, and keeps an identity-only tombstone to prevent stale caches from restoring it. Existing encrypted disaster-recovery backups retain their historical contents. SSH keys cannot be deleted through this action.

Login editing loads passwords for only the selected entry through trusted, revision-checked IPC. Inputs are pre-filled and masked by default; the eye button toggles visibility. Saving an empty input clears that password. This editing flow holds passwords temporarily in renderer form memory (never renderer storage), and clears the inputs on close. General list/detail responses still exclude passwords.
