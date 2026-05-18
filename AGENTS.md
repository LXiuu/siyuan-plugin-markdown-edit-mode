# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A SiYuan plugin that adds a temporary Markdown source-edit mode to the currently open document. The user clicks a lower-left status button (or double-taps `Ctrl`), the plugin loads the doc's Markdown via SiYuan's export API, presents it in a fullscreen CodeMirror 6 editor, and writes edits back through SiYuan's `updateBlock` API. The plugin never touches `workspace/data` directly — every read and write goes through the SiYuan kernel HTTP API.

## Commands

```bash
npm run dev        # vite build --watch (rebuilds dist/ on change)
npm run build      # one-shot production build to dist/
npm run package    # build + zip dist/ to package.zip (for plugin marketplace)
npm run typecheck  # tsc --noEmit (no test runner is configured)
```

There is no test script and no linter configured — `typecheck` is the only static check.

To develop against a running SiYuan: build/watch, then symlink `dist/` into SiYuan's `data/plugins/siyuan-plugin-markdown-edit-mode/`, and reload SiYuan to pick up changes.

## Package and sync to local SiYuan

Use this when the plugin should be rebuilt and copied into the local SiYuan workspace:

```powershell
npm run typecheck
npm run package

$source = 'E:\Dev\projects\开源工具\siyuan-plugin-markdown-edit-mode\dist'
$target = 'E:\SiYuan\data\plugins\siyuan-plugin-markdown-edit-mode'
$sourceFull = [System.IO.Path]::GetFullPath($source)
$targetFull = [System.IO.Path]::GetFullPath($target)
$pluginsRoot = [System.IO.Path]::GetFullPath('E:\SiYuan\data\plugins')

if (-not (Test-Path -LiteralPath $sourceFull)) {
  throw "Source dist directory does not exist: $sourceFull"
}

if (-not $targetFull.StartsWith($pluginsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write outside plugins root: $targetFull"
}

New-Item -ItemType Directory -Force -Path $targetFull | Out-Null
Get-ChildItem -LiteralPath $targetFull -Force | Remove-Item -Recurse -Force
Get-ChildItem -LiteralPath $sourceFull -Force | Copy-Item -Destination $targetFull -Recurse -Force
```

`npm run package` already runs `npm run build`, refreshes `dist/`, and writes `package.zip`. The sync block intentionally clears only `E:\SiYuan\data\plugins\siyuan-plugin-markdown-edit-mode` before copying the latest `dist/` contents.

## Build configuration

`vite.config.ts` produces a CJS bundle at `dist/index.js` with `siyuan` marked external (provided by the host at runtime). The `copy-siyuan-plugin-assets` plugin hook copies `plugin.json`, both READMEs, `LICENSE`, `icon.png`, `preview.png`, and `src/i18n/` into `dist/` at the end of every build — these must end up in `dist/` or the plugin will not load. CSS is emitted as a single `dist/index.css`.

## Architecture

The plugin is one default-exported class (`MarkdownEditModePlugin` in `src/index.ts`) coordinating five concerns split across files:

- **`src/index.ts`** — Plugin lifecycle, fullscreen editor mount, save state machine, keyboard shortcuts (double-tap `Ctrl`, `Ctrl+S`, `Esc`, `Tab`), and the lower-left status button positioning. The class fields track a lot of orthogonal state — read the field declarations at the top before editing flow logic.
- **`src/api.ts`** — Thin wrappers over `fetchSyncPost` for `/api/export/exportMdContent` (read) and `/api/block/updateBlock` (write). Both paths run input through `normalizeSiyuanExportMarkdown` so front-matter and duplicate title headings are stripped symmetrically.
- **`src/cursor.ts`** — The largest and most subtle module (~3000 lines). Bidirectional cursor mapping between the protyle DOM and Markdown text. Four public entry points:
  - `captureProtyleCursorHint` / `restoreProtyleCursorFromHint` — DOM side.
  - `captureMarkdownCursorHint` / `resolveMarkdownCursorPosition` — Markdown side.
  - Restoration uses cascading strategies: exact block-markdown match → visible-text match → approximate index/ratio. Hints carry both block context and document-relative ratio so they degrade gracefully when the doc has been reshaped by the kernel round-trip.
- **`src/dom.ts`** — Finds the active protyle element and its `docId`. Tries `getActiveEditor()` from the SiYuan API first; falls back to DOM selectors (`.layout__wnd--active .protyle:not(.fn__none)` → `.layout-tab-container .protyle:not(.fn__none)` → any visible `.protyle`). Returns a `ReloadableEditor` when one is available so the post-save flow can refresh the rendered view in place.
- **`src/markdown.ts`** — Normalization. `normalizeMarkdownForSave` (line endings, NBSP, zero-width chars), `normalizeSiyuanExportMarkdown` (strips SiYuan export front matter `title`/`date`/`lastmod` and leading H1 matching the doc title), `normalizePastedMarkdown` (strips outer ``` fence and dedents indented Markdown).

### Save state machine

The realtime-save flow in `src/index.ts` is the trickiest part of the plugin. Key invariants:

- Edits trigger `scheduleRealtimeSave`, which debounces by `REALTIME_SAVE_DELAY` (1000 ms).
- `flushRealtimeSave` reuses an in-flight promise (`realtimeSavePromise`) and drains queued requests in `drainRealtimeSaveQueue` — never spawn parallel writes for the same doc.
- `operationGeneration` is bumped at the start of every user-initiated operation. Stale callbacks (cursor restore, reload) compare against it and bail out — this is how the plugin cancels in-flight async work when the user re-enters or switches docs mid-flight.
- Exit flow: flush pending save → if anything was actually written (`saved || hasRealtimeSaved`), call `editor.reload(false)` and run cursor restore against the freshly rendered DOM; otherwise restore directly without reload.
- Read-only or publish-mode contexts (`siyuan.config.readonly || siyuan.isPublish`) skip writes and show a status banner instead.

### Lossy round-trip caveat

Saving from source mode re-parses standard Markdown through the SiYuan kernel. The README enumerates content that is **not** guaranteed to survive: database blocks, super blocks, embed blocks, block attributes, custom attributes, child block IDs, block references, PDF annotations, complex HTML blocks. When changing save behavior, preserve the existing `confirm` dialog (`confirmWriteRisk`) and the front-matter / duplicate-title cleanup — these compensate for the export side adding metadata the user did not author.
