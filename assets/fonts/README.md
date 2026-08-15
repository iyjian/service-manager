# Local Fonts

The application packages local UI font assets and never fetches fonts at
runtime. Notes itself follows the running Novel editor's platform-native font
stacks, so rendered families intentionally depend on the operating system.

## Shared application UI

The shared renderer loads the following Inter-compatible files through the
`STM UI` family:

- `app-ui-regular.ttf`   (weight 400)
- `app-ui-medium.ttf`    (weight 500)
- `app-ui-semibold.ttf`  (weight 600)

## SQL editor font

- `comic-mono.ttf` is Comic Mono 0.1.1 from the official upstream repository,
  pinned from commit `13eb162648d01d61ece424088dbf750ec80a1a62`; its MIT license
  is in `LICENSE-ComicMono.txt`. It is available only through the SQL editor's
  local font selector.

Sources:

- Comic Mono: https://github.com/dtinth/comic-mono-font
