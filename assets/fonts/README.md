# Local Fonts

The application packages local font assets and never fetches fonts at runtime.
Windows uses the shared Inter/Source Han Sans UI stack and JetBrains Mono code
stack, including Notes. macOS/Linux retain their existing platform-native Notes
stacks and shared UI fallback order.

## Shared application UI

The shared renderer loads the following Inter files through the
`STM UI` family:

- `app-ui-regular.ttf`   (weight 400)
- `app-ui-medium.ttf`    (weight 500)
- `app-ui-semibold.ttf`  (weight 600)

Windows adds `source-han-sans-cn-variable.woff2` as its Chinese fallback after
Inter (CSS family `Source Han Sans CN`, variable weights 250–900). This is
Adobe's unmodified, language-specific Simplified Chinese subset from
[Source Han Sans 2.005R](https://github.com/adobe-fonts/source-han-sans/blob/2.005R/Variable/WOFF2/TTF/Subset/SourceHanSansCN-VF.ttf.woff2).
It is approximately 7.4 MiB and is bundled under the SIL Open Font License in
`LICENSE-SourceHanSans.txt`. Its SHA-256 is
`f971e3bff46f76b49e1d5510556c2297c618ec4b491a295a4e741cdd38257799`.

The Windows class changes only font stacks and compact control typography;
saved Notes, SQL, and Terminal font sizes are not rewritten. Other platforms
do not request the Chinese font unless it is explicitly selected.

## SQL editor font

- Windows Default mode resolves to the registered `JetBrains Mono` family,
  with Source Han Sans for Chinese characters. macOS/Linux keep their existing
  code font stack.
- `comic-mono.ttf` is Comic Mono 0.1.1 from the official upstream repository,
  pinned from commit `13eb162648d01d61ece424088dbf750ec80a1a62`; its MIT license
  is in `LICENSE-ComicMono.txt`. It is available only through the SQL editor's
  local font selector.

Sources:

- Comic Mono: https://github.com/dtinth/comic-mono-font

## Terminal fonts

Terminals prefer the locally installed Monaco font. Monaco is not redistributed.
`jetbrains-mono-regular.ttf` and `jetbrains-mono-bold.ttf` provide an offline
JetBrains Mono fallback on every platform. They are from the official
[JetBrains Mono v2.304 release](https://github.com/JetBrains/JetBrainsMono/tree/v2.304/fonts/ttf),
under the SIL Open Font License in `LICENSE-JetBrainsMono.txt`.

`jetbrains-mono-medium.ttf` (500) and `jetbrains-mono-semibold.ttf` (600) come
from the same v2.304 release and license, so Windows labels and code headings
use real weights rather than substituting the 400/700 faces. Windows terminals
also use Source Han Sans for Chinese glyphs after the selected font and
JetBrains Mono. The user's chosen terminal font retains first priority.
