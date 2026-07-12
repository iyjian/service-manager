# Multi-Kubeconfig Discovery Design

## Goal

Automatically discover Kubernetes Contexts from valid kubeconfig files stored directly under the current user's `.kube` directory while preserving the application's read-only Kubernetes model, credential isolation, explicit reload confirmation, and cross-platform behavior.

## Scope

- Scan regular files in the first level of the user's `.kube` directory.
- Do not recurse into subdirectories and do not follow symbolic links.
- Keep one active Context connection at a time.
- Support duplicate Context names from different kubeconfig files without connecting to the wrong source.
- Preserve the existing authentication restrictions: token credentials or a complete matching client-certificate/client-key pair are supported; `exec` and `auth-provider` credentials remain unsupported.
- Preserve the existing explicit `Reload kubeconfig` confirmation before applying file changes after startup.
- Do not add or upgrade dependencies.

## Path and Platform Behavior

The main process derives the scan directory with Electron's home path and Node's platform-aware path functions:

```ts
path.join(app.getPath('home'), '.kube')
```

The implementation must not expand `~`, assume `/` as a separator, depend on a shell, or depend on the `KUBECONFIG` environment variable. Directory enumeration uses `fs.readdir` with `withFileTypes: true`, which provides the same discovery model on macOS, Linux, and Windows.

Only direct regular-file entries are candidates. Directories, symbolic links, sockets, and other entry types are ignored.

## Architecture

A new main-process kubeconfig catalog owns discovery and source resolution. Each candidate file is independently read, parsed, structurally validated, and classified. The catalog returns two views:

1. A display-safe Context catalog for the existing Kubernetes session and renderer.
2. A private lookup from stable selection ID to the Context's absolute kubeconfig path and original Context name.

The Kubernetes session and renderer use the stable selection ID as Context identity. When a Context is selected, the runtime resolves the ID through the private catalog and constructs `@kubernetes/client-node` with that Context's source file and original name. This preserves relative certificate and key path resolution because every client remains rooted at its own kubeconfig file.

The implementation must not merge kubeconfig documents. Merging would require collision-prone renaming of Contexts, clusters, and users and would change the base directory for relative credential paths.

## Context Identity and Display

Each display-safe Context record contains:

- A stable selection ID derived from the direct child filename and original Context name.
- The original Context name.
- A display label.
- Existing safe cluster name, user name, authentication-support classification, and TLS-verification warning metadata.

The selection ID must be deterministic and collision-free for two Contexts in the same scanned directory, but it must not contain the absolute home directory or kubeconfig contents.

If a Context name is unique across all valid files, its display label is the original Context name. If the name is duplicated, every duplicate is labeled `Context name — filename`. Dynamic names and labels continue to be rendered with DOM nodes and `textContent`.

The durable preference stores only the stable non-credential selection ID. It never stores kubeconfig contents, tokens, certificates, keys, API server URLs, cluster resource data, or an absolute path. If the selected file is removed or the Context is renamed, the stale preference is cleared. The runtime must not fall back to a same-named Context in another file.

## Discovery and Classification

The catalog processes candidates independently and sorts the resulting Contexts deterministically by display label, filename, and original Context name. One invalid candidate cannot prevent valid files from loading.

The following candidates are skipped:

- Files that are not structurally valid kubeconfig documents.
- Malformed YAML.
- Files that disappear between directory enumeration and reading.
- Files that cannot be read individually.
- Valid kubeconfig files that contain no Contexts.

Authentication classification remains visible per Context. A structurally valid kubeconfig containing unsupported authentication is still a valid catalog source; its Context appears as unsupported rather than being silently removed.

If the `.kube` directory does not exist, or no valid Contexts are discovered, the renderer shows the existing `No kubeconfig contexts found` state. If the directory exists but cannot be enumerated, the runtime exposes a generic local kubeconfig read error. Renderer state and persisted diagnostics must not include a candidate filename, absolute path, YAML parsing message, or file contents.

## Change Detection and Reload

The runtime watches the `.kube` directory rather than a single file. Any relevant filesystem notification triggers a fresh private catalog scan and fingerprint comparison. This supports content updates, atomic file replacement, file creation, deletion, and renaming on macOS, Linux, and Windows without relying on platform-specific event filenames.

A detected catalog or credential-content change sets the existing `kubeconfigReloadAvailable` state. It does not immediately replace the active catalog or connection. The user must select `Reload kubeconfig` to apply the change.

After confirmed reload:

- The runtime replaces the complete catalog atomically.
- An unchanged selected Context is reconnected using its current source file so credential changes take effect.
- A missing selected Context is disconnected, its owned Kubernetes resources are disposed, and its durable preference is cleared.
- No Pod terminal, log stream, Watch, or port forward is recreated automatically.

Directory watcher errors remain best-effort and cannot become uncaught main-process errors. A later explicit reload or application restart can rescan the directory.

## Security and Diagnostics

Kubeconfig bytes, credentials, absolute source paths, parsed documents, client transports, and the private selection lookup remain in the main process.

Renderer IPC may receive only the stable selection ID and existing display-safe Context metadata. It must never receive raw kubeconfig data, API server URLs, credential fields, or absolute filesystem paths.

Diagnostics may record only a generic failure category and aggregate file or Context counts. They must not record filenames, Context names, cluster names, user names, paths, YAML errors, URLs, tokens, certificates, keys, or parsed values.

## Error Handling

- A missing `.kube` directory produces an empty catalog.
- A directory enumeration permission or I/O failure produces the generic `The local Kubernetes kubeconfig directory could not be read.` state.
- An invalid or unreadable individual candidate is skipped.
- A file removed during a scan is skipped.
- A stale selection is cleared and never redirected to another source.
- A supported Context connection failure continues through the existing categorized connection and retry behavior.
- An unsupported Context remains selectable and shows the existing actionable unsupported-auth state without constructing a Kubernetes client.

## Testing

Catalog tests use temporary directories and cover:

- Multiple valid kubeconfig files.
- Non-kubeconfig files and malformed YAML being skipped.
- Unreadable or disappearing candidates not blocking valid files.
- Subdirectories and symbolic links being ignored.
- Deterministic sorting.
- Duplicate Context names receiving distinct IDs and filename-qualified labels.
- Unique Context names retaining their simple labels.
- Renderer-safe results excluding credentials, URLs, absolute paths, and parsed error content.
- Platform-neutral path construction, including Windows-style paths without separator assumptions.

Runtime and session tests cover:

- Selecting an ID constructs the client with the correct source file and original Context name.
- A directory change exposes reload confirmation without immediately replacing the active catalog.
- Confirmed credential-only changes rebuild the active client.
- Removing the active Context disconnects, disposes owned resources, and clears the preference.
- A removed Context cannot fall through to a same-named Context in another file.
- Directory-watcher disposal on runtime shutdown remains correct, while existing resource Watch, log, terminal, and forward cleanup behavior is unchanged.
- Credentials and absolute paths never appear in renderer state, settings, caches, or diagnostic payloads.

The complete verification command is `pnpm test`, which builds the application before running `node --test tests/*.test.js`.

## Documentation Changes

`README.md` and `AGENTS.md` must document:

- First-level automatic discovery under the user's `.kube` directory.
- Non-recursive regular-file scanning.
- Duplicate-name labels.
- Explicit reload confirmation after filesystem changes.
- One active Context at a time.
- Platform-aware macOS, Linux, and Windows path behavior.
- Main-process-only credentials and source-path handling.
- Existing authentication restrictions.
