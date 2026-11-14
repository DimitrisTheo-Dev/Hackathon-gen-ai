# Agent client marks

These marks name MCP clients that can connect to Faceful. Each trademark and logo belongs to its owner. They are shown only to identify the client by name; no affiliation, sponsorship or endorsement is implied.

Only Claude Code and Codex CLI have been tested with Faceful. The others are named because they speak the same MCP standard, not because Faceful has verified them.

All files were retrieved on 14 November 2026, inspected as plain SVG (no scripts, event handlers, external references or embedded content) and are served from this folder with no third-party requests. An icon set's licence covers its SVG file, not the trademark the file depicts.

| File | Mark | Source | Changes made |
| --- | --- | --- | --- |
| `claude.svg` | Claude (Anthropic) | First party: https://claude.com/icon.svg | None |
| `codex.svg` | OpenAI mark, for Codex (OpenAI) | First party: https://chatgpt.com/cdn/assets/favicon-c80e01a96037.svg | Embedded stylesheet removed; fill fixed to `#0D0D0D` so the mark does not change with the viewer's colour scheme |
| `cursor.svg` | Cursor (Anysphere) | First party: https://cursor.com/favicon.svg | Cube path only; the favicon's own tile and hairline removed; view box cropped to the mark |
| `gemini.svg` | Gemini (Google), for Gemini CLI | `@lobehub/icons-static-svg` 1.102.0 (MIT): https://unpkg.com/@lobehub/icons-static-svg@1.102.0/icons/gemini-color.svg | Path and gradient values kept; markup rewritten; view box cropped to the mark |
| `vscode.svg` | Visual Studio Code (Microsoft) | Devicon 2.17.0 (MIT): https://cdn.jsdelivr.net/gh/devicons/devicon@v2.17.0/icons/vscode/vscode-original.svg | Explicit width and height added |
| `windsurf.svg` | Windsurf | First party: https://windsurf.com/favicon.svg | Mark path only; the favicon's own tile removed; view box cropped to the mark |
| `zed.svg` | Zed (Zed Industries) | `simple-icons` 16.37.0 (CC0-1.0): https://unpkg.com/simple-icons@16.37.0/icons/zedindustries.svg | Fill set to `#084CCF`; view box padded |

The app-icon tiles these marks sit on (rounded square, background colour, depth) are drawn by Faceful in `apps/web/src/components/AgentIcon.tsx`. Cursor, Zed and Claude are drawn in white on a tile in the mark's own colour; the colours come from the sources above.

"Any MCP client" and any mark that fails to load use a neutral plug glyph (the Lucide `plug` icon, ISC licence, drawn inline). It is not a vendor logo.

App icons (`app-*.png`, `apple-touch-icon.png`) are rendered from Faceful's own mark.
