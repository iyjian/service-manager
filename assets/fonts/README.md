# Local Fonts

The application packages its UI fonts so Notes typography does not depend on the
fonts installed on macOS, Windows, or Linux. No font is fetched at runtime.

## Shared application UI

The shared renderer loads the following optional Inter-compatible files through
the `STM UI` family:

- `app-ui-regular.woff2` / `app-ui-regular.ttf`  (weight 400)
- `app-ui-medium.woff2` / `app-ui-medium.ttf`    (weight 500)
- `app-ui-semibold.woff2` / `app-ui-semibold.ttf` (weight 600)

If a WOFF2 file is absent, the corresponding bundled TTF is used.

## Notes

- `notes-ui-variable.woff2` is Noto Sans SC Variable, used for the Notes list,
  metadata, inputs, and mixed Chinese/Latin content. It was converted from the
  official variable TTF to WOFF2 while retaining the complete glyph repertoire.
  Its license is in `OFL-NotoSansCJK.txt`.
- `notes-code-variable.woff2` is JetBrains Mono Variable, used by CodeMirror.
  Its license is in `OFL-JetBrainsMono.txt`.
- Rich Text places the existing local Inter-compatible `STM UI` family first,
  with Noto Sans SC retained as its Chinese-glyph fallback. This matches the
  running Novel editor's system-sans proportions without a runtime font fetch.
- CodeMirror falls back to the bundled Notes UI font for glyphs that JetBrains
  Mono does not contain, including Chinese characters.

The renderer exposes these fonts only through the local `STM Notes UI` and
`STM Notes Code` family aliases. This keeps the UI stable without relying on a
platform-specific font name.

Sources:

- Noto CJK: https://github.com/notofonts/noto-cjk
- JetBrains Mono: https://github.com/JetBrains/JetBrainsMono
