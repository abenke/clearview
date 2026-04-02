# WYSIWYG Markdown Editor — VS Code Extension

## Overview

A WYSIWYG markdown editor implemented as a VS Code extension using a webview panel with `contenteditable`. No external runtime dependencies — markdown parsing and serialization are built-in.

## Architecture

- **`src/extension.ts`** — Extension entry point. Registers two commands: `openEditor` (active column) and `openEditorToSide` (beside).
- **`src/editorProvider.ts`** — Core logic. Creates webview panels, manages file I/O, and generates the webview HTML/JS/CSS.

### Webview internals (embedded in `editorProvider.ts`)

- **`markdownToHtml()`** — Line-by-line markdown parser handling headings, lists, code blocks, blockquotes, tables, inline formatting, links, and images.
- **`htmlToMarkdown()` / `getInlineMarkdown()`** — DOM walker that serializes the contenteditable HTML back to clean markdown.
- **Toolbar** — Uses `document.execCommand()` for formatting and custom insertion for code blocks, tables, task lists, links, and images.
- **Save loop** — `input` events trigger a debounced (800ms) save that posts the serialized markdown back to the extension host, which writes it to disk.

## Build & Test

```bash
npm install
npm run compile    # or: npm run watch
```

Press F5 in VS Code to launch the Extension Development Host.

## Key Decisions

- **No external markdown library** — The built-in parser/serializer avoids bundling dependencies and keeps the extension lightweight. Trade-off: doesn't handle every edge case of the CommonMark spec.
- **`contenteditable` over CodeMirror/Monaco** — Simpler WYSIWYG experience. Trade-off: less control over the editing model.
- **`retainContextWhenHidden: true`** — Keeps editor state when the tab is backgrounded, at the cost of memory.
- **Debounced save (800ms)** — Balances responsiveness with avoiding excessive file writes.

## Extending

- To add new block types, update both `markdownToHtml()` and `htmlToMarkdown()` in the webview script.
- To add toolbar buttons, add a `<button>` in the toolbar HTML and wire an event listener.
- For syntax highlighting in code blocks, consider integrating highlight.js (add to CSP and `localResourceRoots`).
