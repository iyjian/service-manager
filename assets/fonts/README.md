# Local Fonts

The application packages compatibility UI font assets and never fetches fonts at
runtime. Notes itself follows the running Novel editor's platform-native font
stacks, so rendered families intentionally depend on the operating system.

## Shared application UI

The shared renderer loads the following optional Inter-compatible files through
the `STM UI` family:

- `app-ui-regular.woff2` / `app-ui-regular.ttf`  (weight 400)
- `app-ui-medium.woff2` / `app-ui-medium.ttf`    (weight 500)
- `app-ui-semibold.woff2` / `app-ui-semibold.ttf` (weight 600)

If a WOFF2 file is absent, the corresponding bundled TTF is used.

## Retained Notes compatibility assets

- `notes-ui-variable.woff2` is Noto Sans SC Variable. It was converted from the
  official variable TTF to WOFF2 while retaining the complete glyph repertoire;
  its license is in `OFL-NotoSansCJK.txt`.
- `notes-code-variable.woff2` is JetBrains Mono Variable; its license is in
  `OFL-JetBrainsMono.txt`.
- `comic-mono.ttf` is Comic Mono 0.1.1 from the official upstream repository,
  pinned from commit `13eb162648d01d61ece424088dbf750ec80a1a62`; its MIT license
  is in `LICENSE-ComicMono.txt`. It is available only through the SQL editor's
  local font selector.

The renderer retains the local `STM Notes UI` and `STM Notes Code` aliases for
artifact compatibility, but current Notes UI, CodeMirror, inline code, and Rich
Text do not select them ahead of Novel's system stacks. On macOS this normally
resolves to the native UI and SF Mono/Menlo families; on Windows it normally
resolves to Segoe UI/Microsoft YaHei UI and Consolas. Exact glyphs may differ by
platform while font sizes, line heights, weights, and spacing remain aligned.

Sources:

- Noto CJK: https://github.com/notofonts/noto-cjk
- JetBrains Mono: https://github.com/JetBrains/JetBrainsMono
- Comic Mono: https://github.com/dtinth/comic-mono-font
