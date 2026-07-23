# Note file icon sources

The Note attachment icons were adapted on 2026-07-23 from the local
`sd-pc-front/src/assets/iconify/icon.json` catalog. They are packaged locally;
the application does not fetch icon assets at runtime.

| Service Manager asset | Iconify source ID | Upstream set | Local changes |
| --- | --- | --- | --- |
| `pdf.svg` | `vscode-icons:file-type-pdf2` | VSCode Icons | Normalized to the shared 32px view box. |
| `document.svg` | `vscode-icons:file-type-word` | VSCode Icons | Normalized gradient IDs and path formatting. |
| `spreadsheet.svg` | `vscode-icons:file-type-excel` | VSCode Icons | Normalized gradient IDs and path formatting. |
| `presentation.svg` | `vscode-icons:file-type-powerpoint` | VSCode Icons | Normalized gradient IDs and path formatting. |
| `image.svg` | `vscode-icons:file-type-image` | VSCode Icons | Normalized to the shared 32px view box. |
| `code.svg` | `vscode-icons:file-type-json` | VSCode Icons | Normalized to the shared 32px view box. |
| `audio.svg` | `material-icon-theme:audio` | Material Icon Theme | Normalized to the shared 32px view box. |
| `video.svg` | `material-icon-theme:video` | Material Icon Theme | Normalized to the shared 32px view box. |
| `archive.svg` | Local generic archive drawing | Service Manager | Drawn locally to match the compact attachment-card set. |
| `file.svg` | Local generic file drawing | Service Manager | Drawn locally to match the compact attachment-card set. |

VSCode Icons and Material Icon Theme are distributed under the MIT License.
Their license texts are preserved in this directory.
