# Markdown Source Mode

A lightweight SiYuan plugin that temporarily switches the current document into a Markdown source editor.

This version supports SiYuan on desktop. Phones and tablets are not supported.

The plugin adds a `Source` button near the lower-left corner of the current document. Click it to edit the document like a regular Markdown file, then exit source mode to return to SiYuan’s normal editor.

## Editing

- Regular Markdown can be edited directly, including text, headings, code blocks, math, dividers, HTML, lists, blockquotes, and tables.
- SiYuan-specific content that cannot yet be changed safely appears as a locked card and is left untouched.
- If a change might damage existing content or layout, the plugin stops the save and explains why.
- Changes are saved automatically after about one second.
- If saving fails, you can discard unsaved changes and exit source mode normally.

## Overview

- Adds a `Source` button in the lower-left corner of the document.
- Includes Markdown highlighting, line numbers, wrapping, bracket matching, and undo history.
- Lets you edit regular content as one continuous Markdown document while clearly marking content that is locked.
- Saves changes automatically and shows the current save status in the lower-right corner.
- Tries to keep your reading position when entering and leaving source mode.
- Refreshes the document and outline after you exit.

## Usage

1. Open a regular document.
2. Click `Source` in the lower-left corner.
3. Edit the Markdown source.
4. Wait for the lower-right status to show that saving is complete, or click `Exit` to save and return to the normal editor.

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
| `Block-safe updates · N editable · M protected` | Shows how much content can be edited and how much is locked |
| `Changes pending · protected blocks stay untouched` | Your changes will be saved shortly |
| `Updating N content block(s)...` | Changes are being saved |
| `Updated N content block(s) HH:MM:SS` | Changes were saved successfully |
| `<Block type> is protected in this version` | This content cannot yet be changed safely |
| `The current context is read-only; real-time updates are disabled` | The current environment does not allow writes |

## Changelog

### v0.1.8

- Regular Markdown is now easier to edit and saves automatically.
- Improved editing for lists, task lists, blockquotes, and tables.
- Fixed some HTML content turning into paragraphs or being split apart after saving.
- SiYuan-specific content that cannot yet be changed safely is locked automatically.
- A failed save can now be discarded and exited without entering a repeated save loop.

### v0.1.7

- Fixed the font menu being hidden behind the Settings window.
- Prevented source mode from affecting other parts of SiYuan.

### v0.1.6

- Fixed extra blank or whitespace-only lines disappearing after saving.

### v0.1.5

- Fixed refresh and cursor-position problems when switching documents.
- Reduced the preview image file size.

### v0.1.4

- Improved the source-mode button and editor layout in split views.

### v0.1.3

- Improved the usage notes and compatibility.

### v0.1.2

- Source mode now follows SiYuan’s read-only state and locks editing when needed.
- Fixed leftover actions after reloading the plugin, updating it, or closing a document.
- Checked the interface on desktop versions of SiYuan.

### v0.1.1

- Prevented the plugin from loading on phones and tablets.
- Improved the touch behavior of the exit button.

### v0.1.0

- Added Markdown source editing for the current document.
- Added highlighting, line numbers, wrapping, undo history, and common shortcuts.
- Added automatic saving, save-status messages, and cursor-position recovery.
- Improved Markdown pasting and document refresh after exit.
