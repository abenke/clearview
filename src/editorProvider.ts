import * as vscode from 'vscode';
import * as path from 'path';

export class MarkdownEditorProvider {
    private panels = new Map<string, vscode.WebviewPanel>();

    constructor(private readonly context: vscode.ExtensionContext) {}

    async openEditor(uri?: vscode.Uri, viewColumn?: vscode.ViewColumn) {
        // Resolve the target file
        if (!uri) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'markdown') {
                uri = editor.document.uri;
            } else {
                vscode.window.showErrorMessage('No markdown file is active.');
                return;
            }
        }

        const filePath = uri.fsPath;

        // Reuse existing panel for same file
        const existing = this.panels.get(filePath);
        if (existing) {
            existing.reveal(viewColumn);
            return;
        }

        const fileName = path.basename(filePath);
        const panel = vscode.window.createWebviewPanel(
            'clearviewEditor',
            `Clearview: ${fileName}`,
            viewColumn || vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, 'media')
                ]
            }
        );

        this.panels.set(filePath, panel);

        // Set webview HTML
        panel.webview.html = this.getWebviewContent(panel.webview);

        // Track whether we are currently writing to avoid echo loops
        let isWriting = false;

        // Sync when the file changes in another VS Code editor tab
        const docChangeListener = vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.uri.fsPath === filePath && !isWriting && e.contentChanges.length > 0) {
                panel.webview.postMessage({
                    type: 'setContent',
                    markdown: e.document.getText()
                });
            }
        });

        // Sync when the file changes on disk (external editor, git, etc.).
        // Use RelativePattern so the watcher fires for files outside any
        // workspace folder — a plain string glob is silently ignored there.
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(
                vscode.Uri.file(path.dirname(filePath)),
                path.basename(filePath)
            )
        );
        const onDiskChange = async () => {
            if (isWriting) return;
            try {
                const bytes = await vscode.workspace.fs.readFile(uri!);
                const text = Buffer.from(bytes).toString('utf8');
                panel.webview.postMessage({
                    type: 'setContent',
                    markdown: text
                });
            } catch {
                // File may have been temporarily removed during an atomic save
            }
        };
        watcher.onDidChange(onDiskChange);
        watcher.onDidCreate(onDiskChange);

        // Reload when the panel becomes visible again, in case any change
        // event was missed while it was hidden.
        const visibilityListener = panel.onDidChangeViewState((e) => {
            if (e.webviewPanel.visible) {
                onDiskChange();
            }
        });

        // Handle messages from webview
        panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'update': {
                        isWriting = true;
                        try {
                            const doc = await vscode.workspace.openTextDocument(uri!);
                            const edit = new vscode.WorkspaceEdit();
                            const fullRange = new vscode.Range(
                                doc.positionAt(0),
                                doc.positionAt(doc.getText().length)
                            );
                            edit.replace(uri!, fullRange, message.markdown);
                            await vscode.workspace.applyEdit(edit);
                            await doc.save();
                        } finally {
                            // Small delay to let the watcher event pass before clearing
                            setTimeout(() => { isWriting = false; }, 300);
                        }
                        break;
                    }
                    case 'requestContent': {
                        const doc = await vscode.workspace.openTextDocument(uri!);
                        panel.webview.postMessage({
                            type: 'setContent',
                            markdown: doc.getText()
                        });
                        break;
                    }
                }
            },
            undefined,
            this.context.subscriptions
        );

        panel.onDidDispose(() => {
            this.panels.delete(filePath);
            watcher.dispose();
            docChangeListener.dispose();
            visibilityListener.dispose();
        });
    }

    private getWebviewContent(webview: vscode.Webview): string {
        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.js')
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <title>Clearview Editor</title>
    <style>
        :root {
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --border: var(--vscode-panel-border, #444);
            --toolbar-bg: var(--vscode-editorGroupHeader-tabsBackground, #252526);
            --btn-hover: var(--vscode-toolbar-hoverBackground, #383838);
            --btn-active: var(--vscode-toolbar-activeBackground, #505050);
            --accent: var(--vscode-textLink-foreground, #3794ff);
            --selection: var(--vscode-editor-selectionBackground, #264f78);
            --font: var(--vscode-editor-fontFamily, 'Segoe UI', Tahoma, sans-serif);
            --mono: var(--vscode-editor-fontFamily, 'Cascadia Code', 'Fira Code', 'Consolas', monospace);
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            background: var(--bg);
            color: var(--fg);
            font-family: var(--font);
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }

        /* Toolbar */
        .toolbar {
            display: flex;
            flex-wrap: wrap;
            gap: 2px;
            padding: 4px 8px;
            background: var(--toolbar-bg);
            border-bottom: 1px solid var(--border);
            align-items: center;
            min-height: 36px;
        }

        .toolbar .separator {
            width: 1px;
            height: 20px;
            background: var(--border);
            margin: 0 4px;
        }

        .toolbar button {
            background: transparent;
            color: var(--fg);
            border: 1px solid transparent;
            border-radius: 3px;
            padding: 3px 8px;
            cursor: pointer;
            font-size: 13px;
            font-family: var(--font);
            line-height: 1.4;
            min-width: 28px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .toolbar button:hover {
            background: var(--btn-hover);
            border-color: var(--border);
        }

        .toolbar button:active,
        .toolbar button.active {
            background: var(--btn-active);
            border-color: var(--accent);
        }

        .toolbar select {
            background: var(--toolbar-bg);
            color: var(--fg);
            border: 1px solid var(--border);
            border-radius: 3px;
            padding: 3px 6px;
            font-size: 12px;
            cursor: pointer;
        }

        .toolbar .status {
            margin-left: auto;
            font-size: 11px;
            opacity: 0.7;
            padding: 0 8px;
        }

        /* Editor */
        .editor-container {
            flex: 1;
            overflow: auto;
            padding: 24px 48px;
            position: relative;
        }

        #editor {
            outline: none;
            min-height: 100%;
            font-size: 15px;
            line-height: 1.7;
            max-width: 800px;
            margin: 0 auto;
            caret-color: var(--accent);
        }

        #editor::selection, #editor *::selection {
            background: var(--selection);
        }

        /* Typography */
        #editor h1 { font-size: 2em; margin: 0.8em 0 0.4em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
        #editor h2 { font-size: 1.5em; margin: 0.8em 0 0.4em; border-bottom: 1px solid var(--border); padding-bottom: 0.2em; }
        #editor h3 { font-size: 1.25em; margin: 0.7em 0 0.3em; }
        #editor h4 { font-size: 1.1em; margin: 0.6em 0 0.3em; }
        #editor h5 { font-size: 1em; margin: 0.5em 0 0.2em; }
        #editor h6 { font-size: 0.9em; margin: 0.5em 0 0.2em; color: #888; }

        #editor p { margin: 0.5em 0; }

        #editor strong, #editor b { font-weight: 700; }
        #editor em, #editor i { font-style: italic; }

        #editor code {
            font-family: var(--mono);
            background: rgba(128, 128, 128, 0.2);
            border-radius: 3px;
            padding: 1px 5px;
            font-size: 0.9em;
        }

        #editor pre {
            background: rgba(0, 0, 0, 0.3);
            border-radius: 6px;
            padding: 12px 16px;
            margin: 0.8em 0;
            overflow-x: auto;
            border: 1px solid var(--border);
        }

        #editor pre code {
            background: none;
            padding: 0;
            font-size: 0.88em;
            line-height: 1.5;
        }

        #editor blockquote {
            border-left: 4px solid var(--accent);
            margin: 0.8em 0;
            padding: 4px 16px;
            opacity: 0.85;
        }

        #editor ul, #editor ol {
            margin: 0.5em 0;
            padding-left: 1.8em;
        }

        #editor li ul, #editor li ol {
            margin: 0.2em 0;
        }

        #editor li { margin: 0.2em 0; }

        #editor hr {
            border: none;
            border-top: 2px solid var(--border);
            margin: 1.5em 0;
        }

        #editor a {
            color: var(--accent);
            text-decoration: underline;
        }

        #editor img {
            max-width: 100%;
            border-radius: 4px;
            margin: 0.5em 0;
        }

        #editor table {
            border-collapse: collapse;
            margin: 0.8em 0;
            width: 100%;
        }

        #editor th, #editor td {
            border: 1px solid var(--border);
            padding: 6px 12px;
            text-align: left;
        }

        #editor th {
            background: rgba(128, 128, 128, 0.15);
            font-weight: 600;
        }

        #editor input[type="checkbox"] {
            margin-right: 6px;
            cursor: pointer;
        }

        #editor li:has(> input[type="checkbox"]) {
            list-style: none;
            margin-left: -1.2em;
        }

        /* Table controls */
        .table-controls {
            display: none;
            position: absolute;
            z-index: 100;
            background: var(--toolbar-bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 3px 4px;
            gap: 2px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            align-items: center;
        }

        .table-controls.visible {
            display: flex;
        }

        .table-controls button {
            background: transparent;
            color: var(--fg);
            border: 1px solid transparent;
            border-radius: 3px;
            padding: 2px 6px;
            cursor: pointer;
            font-size: 11px;
            white-space: nowrap;
        }

        .table-controls button:hover {
            background: var(--btn-hover);
            border-color: var(--border);
        }

        .table-controls button.danger:hover {
            background: rgba(220, 50, 50, 0.25);
            border-color: #c44;
        }

        .table-controls .tc-sep {
            width: 1px;
            height: 16px;
            background: var(--border);
            margin: 0 2px;
        }

        /* Modal for links/images */
        .modal-overlay {
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.5);
            z-index: 1000;
            align-items: center;
            justify-content: center;
        }

        .modal-overlay.visible {
            display: flex;
        }

        .modal {
            background: var(--toolbar-bg);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 20px;
            min-width: 350px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        }

        .modal h3 {
            margin-bottom: 12px;
            font-size: 14px;
        }

        .modal label {
            display: block;
            font-size: 12px;
            margin-bottom: 4px;
            opacity: 0.8;
        }

        .modal input {
            width: 100%;
            padding: 6px 10px;
            margin-bottom: 12px;
            background: var(--bg);
            color: var(--fg);
            border: 1px solid var(--border);
            border-radius: 4px;
            font-size: 13px;
        }

        .modal .modal-actions {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }

        .modal .modal-actions button {
            padding: 5px 14px;
            border-radius: 4px;
            border: 1px solid var(--border);
            background: var(--toolbar-bg);
            color: var(--fg);
            cursor: pointer;
            font-size: 12px;
        }

        .modal .modal-actions button.primary {
            background: var(--accent);
            color: #fff;
            border-color: var(--accent);
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <select id="blockType" title="Block type">
            <option value="p">Paragraph</option>
            <option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option>
            <option value="h3">Heading 3</option>
            <option value="h4">Heading 4</option>
            <option value="h5">Heading 5</option>
            <option value="h6">Heading 6</option>
        </select>
        <div class="separator"></div>
        <button id="btnBold" title="Bold (Ctrl+B)"><strong>B</strong></button>
        <button id="btnItalic" title="Italic (Ctrl+I)"><em>I</em></button>
        <button id="btnStrike" title="Strikethrough" style="text-decoration: line-through;">S</button>
        <button id="btnCode" title="Inline Code">&lt;/&gt;</button>
        <div class="separator"></div>
        <button id="btnUl" title="Bullet List">&#8226; List</button>
        <button id="btnOl" title="Numbered List">1. List</button>
        <button id="btnTaskList" title="Task List">&#9744; Task</button>
        <button id="btnOutdent" title="Outdent (Shift+Tab)">&#8676;</button>
        <button id="btnIndent" title="Indent (Tab)">&#8677;</button>
        <div class="separator"></div>
        <button id="btnQuote" title="Blockquote">&#8220; Quote</button>
        <button id="btnCodeBlock" title="Code Block">{ } Block</button>
        <button id="btnHr" title="Horizontal Rule">&#8212; HR</button>
        <div class="separator"></div>
        <button id="btnLink" title="Insert Link">&#128279; Link</button>
        <button id="btnImage" title="Insert Image">&#128247; Image</button>
        <button id="btnTable" title="Insert Table">&#9638; Table</button>
        <div class="separator"></div>
        <button id="btnUndo" title="Undo (Ctrl+Z)">&#8617; Undo</button>
        <button id="btnRedo" title="Redo (Ctrl+Y)">&#8618; Redo</button>
        <span class="status" id="status">Ready</span>
    </div>

    <div class="editor-container">
        <div id="editor" contenteditable="true" spellcheck="true"></div>
        <div class="table-controls" id="tableControls">
            <button id="tblAddRowAbove" title="Add row above">+ Row &#8593;</button>
            <button id="tblAddRowBelow" title="Add row below">+ Row &#8595;</button>
            <div class="tc-sep"></div>
            <button id="tblAddColLeft" title="Add column left">+ Col &#8592;</button>
            <button id="tblAddColRight" title="Add column right">+ Col &#8594;</button>
            <div class="tc-sep"></div>
            <button id="tblDeleteRow" class="danger" title="Delete row">&#8722; Row</button>
            <button id="tblDeleteCol" class="danger" title="Delete column">&#8722; Col</button>
            <div class="tc-sep"></div>
            <button id="tblDeleteTable" class="danger" title="Delete table">&#10005; Table</button>
        </div>
    </div>

    <!-- Link Modal -->
    <div class="modal-overlay" id="linkModal">
        <div class="modal">
            <h3>Insert Link</h3>
            <label for="linkText">Text</label>
            <input type="text" id="linkText" placeholder="Link text">
            <label for="linkUrl">URL</label>
            <input type="text" id="linkUrl" placeholder="https://example.com">
            <div class="modal-actions">
                <button id="linkCancel">Cancel</button>
                <button id="linkInsert" class="primary">Insert</button>
            </div>
        </div>
    </div>

    <!-- Image Modal -->
    <div class="modal-overlay" id="imageModal">
        <div class="modal">
            <h3>Insert Image</h3>
            <label for="imageAlt">Alt text</label>
            <input type="text" id="imageAlt" placeholder="Image description">
            <label for="imageUrl">Image URL</label>
            <input type="text" id="imageUrl" placeholder="https://example.com/image.png">
            <div class="modal-actions">
                <button id="imageCancel">Cancel</button>
                <button id="imageInsert" class="primary">Insert</button>
            </div>
        </div>
    </div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
