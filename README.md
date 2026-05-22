# Markdown Source Mode

A lightweight SiYuan plugin that temporarily switches the current document into a Markdown source editor.

This version supports desktop frontends only: `desktop`, `browser-desktop`, and `desktop-window`.

The plugin adds a source-mode button near the lower-left corner of the active document. Click it to open a full-screen Markdown source editor, edit the document as plain Markdown, then leave source mode to return to SiYuan’s rendered editing view.

## Before You Use It

- **Source mode writes Markdown back to SiYuan and lets SiYuan reparse it into blocks; it is not a lossless internal block-source editor.**
- **Database blocks, super blocks, embeds, block/custom attributes, child block IDs, block references, PDF annotations, and complex HTML may not be preserved completely.**
- **Edits are written back automatically while you type; avoid changing content if you only want to inspect the source.**
- **Back up important or complex documents first. If an update fails, copy the current Markdown before handling the error.**

## Overview

- Adds a lower-left source mode toggle that visually fits SiYuan’s status-bar style.
- Uses CodeMirror 6 for Markdown editing, syntax highlighting, line numbers, wrapping, bracket matching, and edit history.
- Opens near the current cursor position when possible and tries to preserve the current reading position.
- Automatically performs delayed real-time updates while editing and shows the save status in the lower-right corner.
- Refreshes the current editor after leaving source mode so rendered content and the outline update promptly.
- Normalizes pasted Markdown by removing an outer Markdown code fence and common indentation when appropriate.
- Removes SiYuan export front matter such as `title`, `date`, and `lastmod`.
- Removes leading duplicate H1 document-title headings from exported Markdown before writing it back.
- Does not directly read or write files under `workspace/data`; all reads and writes go through SiYuan kernel APIs.

## Usage

1. Open a regular document.
2. Click `Source` in the lower-left corner.
3. Edit the Markdown source.
4. Wait for the lower-right status to show that the real-time update succeeded, or click `Exit` to save pending changes and return to the rendered view.

Keyboard shortcuts:

| Shortcut | Action |
| --- | --- |
| Double-tap `Ctrl` | Enter source mode; save and exit while already in source mode |
| `Ctrl + S` | Save and exit source mode |
| `Esc` | Save and exit source mode |
| `Tab` | Indent in the source editor |

Status messages:

| Status | Meaning |
| --- | --- |
| `Real-time updates enabled` | Source mode is open and waiting for edits |
| `Updating...` | Markdown is being written back to the current document |
| `Updated HH:MM:SS` | The latest change has been written back |
| `Update failed HH:MM:SS` | The latest write failed; avoid closing source mode before handling it |
| `The current context is read-only; real-time updates are disabled` | The current environment does not allow writes |

## Changelog

### v0.1.5

- Avoided stale editor context during document switches.
- Canceled pending reload and cursor-restore work when switching documents.
- Compressed the preview image without changing its resolution.

### v0.1.4

- Improved the source-mode button in split views so it follows the document area currently being edited.
- Fixed missing, misplaced, and overlapping buttons in vertical and horizontal split views.
- Updated the source-mode and exit buttons to better match SiYuan’s bottom status bar style.
- Improved source editor width in narrow split views for a more comfortable reading area.

### v0.1.3

- Moved and bolded usage notes with shorter risk guidance.
- Set backend compatibility to `all`.

### v0.1.2

- Added dynamic read-only synchronization for source mode, including SiYuan editor read-only settings, publish mode, and disabled Protyle instances.
- Made the source editor non-editable in read-only contexts and blocked paste dispatches while read-only.
- Hardened cleanup during plugin unload, reload, and update so pending cursor-restore observers, timers, and animation frames are released.
- Avoided calling stale editor reload handles after a document tab has been destroyed or reopened.
- Verified the desktop UI on the declared frontends: `desktop`, `browser-desktop`, and `desktop-window`.

### v0.1.1

- Removed `all` from the plugin manifest frontend declarations so mobile clients do not load the desktop source editor after sync.
- Added touch-event guards for the source-mode buttons to avoid focusing the editor and opening the soft keyboard when tapping exit.

### v0.1.0

- Added Markdown source editing for the current document.
- Added the lower-left source-mode toggle.
- Added a CodeMirror 6 editor with Markdown highlighting, line numbers, wrapping, bracket matching, and edit history.
- Added delayed real-time updates with a visible save status.
- Added double-tap `Ctrl`, `Ctrl + S`, and `Esc` shortcuts.
- Added cursor positioning on entry and cursor restoration after exit.
- Added pasted Markdown cleanup for outer code fences and common indentation.
- Added cleanup for SiYuan export metadata and duplicate document-title headings.
- Added current-editor refresh after saving to improve rendered-view synchronization.
