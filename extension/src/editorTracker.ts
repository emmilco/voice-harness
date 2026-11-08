import path from "node:path";
import * as vscode from "vscode";
import type { EditorContext } from "@voice-harness/core";

/**
 * Remembers the last file editor the user worked in. While the chat panel has focus VS Code
 * reports no active text editor, so the context for a turn comes from this memory.
 */
export class EditorTracker implements vscode.Disposable {
  private last: vscode.TextEditor | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly workspace: string) {
    this.remember(vscode.window.activeTextEditor);
    this.subscription = vscode.window.onDidChangeActiveTextEditor((e) => this.remember(e));
  }

  private remember(editor: vscode.TextEditor | undefined): void {
    if (editor && editor.document.uri.scheme === "file") this.last = editor;
  }

  /** The user's current file, cursor, visible lines and selection, if a file editor is open. */
  current(): EditorContext | undefined {
    const active = vscode.window.activeTextEditor;
    const editor = active?.document.uri.scheme === "file" ? active : this.last;
    if (!editor || editor.document.isClosed) return undefined;
    const file = editor.document.uri.fsPath;
    const relative = path.relative(this.workspace, file);
    const sel = editor.selection;
    const visible = editor.visibleRanges[0];
    return {
      file: relative.startsWith("..") || path.isAbsolute(relative) ? file : relative,
      cursorLine: sel.active.line + 1,
      visible: visible ? { start: visible.start.line + 1, end: visible.end.line + 1 } : undefined,
      selection: sel.isEmpty
        ? undefined
        : { start: sel.start.line + 1, end: sel.end.line + 1, text: editor.document.getText(sel) },
    };
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
