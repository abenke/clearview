import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './editorProvider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new MarkdownEditorProvider(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('clearview.openEditor', (uri?: vscode.Uri) => {
            provider.openEditor(uri, vscode.ViewColumn.Active);
        }),
        vscode.commands.registerCommand('clearview.openEditorToSide', (uri?: vscode.Uri) => {
            provider.openEditor(uri, vscode.ViewColumn.Beside);
        })
    );
}

export function deactivate() {}
