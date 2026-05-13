# Markdown Edit Mode

A lightweight SiYuan plugin that temporarily switches the current document into a Markdown source editor.

The plugin adds a source-mode button near the lower-left corner of the active document. Click it to open a full-screen Markdown source editor, edit the document as plain Markdown, then leave source mode to return to SiYuan’s rendered editing view.

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
2. Click `源码模式` in the lower-left corner.
3. Edit the Markdown source.
4. Wait for the lower-right status to show that the real-time update succeeded, or click `退出源码模式` to save pending changes and return to the rendered view.

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
| `实时更新已启用` | Source mode is open and waiting for edits |
| `正在实时更新...` | Markdown is being written back to the current document |
| `实时更新成功` | The latest change has been written back |
| `实时更新失败` | The latest write failed; avoid closing source mode before handling it |
| `当前处于只读模式，无法实时更新` | The current environment does not allow writes |

## Notes

Source mode writes standard Markdown back to SiYuan. When saved, SiYuan reparses that Markdown into block structures, so this is not a lossless internal block-source mode.

The following content is not guaranteed to be preserved losslessly:

- Database blocks
- Super blocks
- Embed blocks
- Block attributes and custom attributes
- Child block IDs
- Block references and backlink relationships
- PDF annotations
- Complex HTML blocks
- Other content that depends on SiYuan’s internal block structure

Use this plugin first with ordinary Markdown documents. Back up important or complex documents before editing them in source mode.

Edits in source mode are written back automatically after a short delay. If you only want to inspect the source, avoid changing the content.

If a real-time update fails, the source editor is kept open so your current Markdown is not discarded.

## Changelog

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
