# Clearview — Markdown Editor for VS Code

A rich text markdown editor for Visual Studio Code. Edit markdown visually with a toolbar, keyboard shortcuts, and live sync back to the source file.

## Features

- **Rich text editing** — Edit markdown as formatted text instead of raw syntax
- **Formatting toolbar** — Bold, italic, strikethrough, inline code, headings (H1–H6)
- **Lists** — Bullet lists, numbered lists, and task lists with checkboxes
- **Block elements** — Blockquotes, fenced code blocks, horizontal rules
- **Links & images** — Insert via modal dialogs with text/URL fields
- **Tables** — Insert and edit markdown tables visually
- **Drag & drop** — Drop images directly into the editor
- **Auto-save** — Changes are debounced (800ms) and written back to the `.md` file
- **External sync** — File watcher updates the editor when the file changes outside VS Code
- **Theme-aware** — Matches your current VS Code color theme
- **Keyboard shortcuts**:
  - `Ctrl+B` / `Cmd+B` — Bold
  - `Ctrl+I` / `Cmd+I` — Italic
  - `Ctrl+Z` / `Cmd+Z` — Undo
  - `Ctrl+Y` / `Cmd+Shift+Z` — Redo
  - `Ctrl+Shift+V` / `Cmd+Shift+V` — Open editor to the side (when a markdown file is active)

## Usage

1. Open any `.md` file in VS Code
2. Run **"Open Clearview Editor"** from the Command Palette (`Ctrl+Shift+P`)
3. Or click the preview icon in the editor title bar
4. Or right-click a `.md` file in the Explorer and select **"Open Clearview Editor"**

## Building from Source

```bash
# Install dependencies
cd clearview
npm install

# Compile TypeScript
npm run compile

# Watch for changes during development
npm run watch
```

## Testing Locally

### Option 1: F5 (Extension Development Host)

1. Open the `clearview` folder in VS Code
2. Press `F5` to launch an Extension Development Host window
3. In the new window, open any `.md` file
4. Run the command **"Open Clearview Editor"** from the Command Palette

### Option 2: Install as .vsix

```bash
# Install the packaging tool
npm install -g @vscode/vsce

# Package the extension
vsce package

# Install it
code --install-extension clearview-0.1.0.vsix
```

## Project Structure

```
clearview/
├── src/
│   ├── extension.ts        # Extension entry point, command registration
│   └── editorProvider.ts   # Webview panel provider, markdown ↔ HTML conversion
├── out/                    # Compiled JS (generated)
├── package.json            # Extension manifest
├── tsconfig.json           # TypeScript config
├── .vscodeignore           # Files excluded from .vsix package
└── .gitignore
```

## How It Works

1. The extension opens a **webview panel** with a `contenteditable` div
2. Markdown is parsed into HTML using a built-in parser (no external dependencies)
3. User edits are serialized back to markdown using an HTML→Markdown converter
4. Changes are written to the source `.md` file with debounced auto-save
5. A file watcher syncs external changes back into the editor
