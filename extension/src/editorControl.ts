import * as vscode from "vscode";
import type { CodeRange, Location } from "@voice-harness/core";

/**
 * Editor side effects the agent can cause: a strong highlight for ranges it
 * deliberately shows (show_code), and a faint one for files it is reading or
 * editing (follow-along). Editors open in the first column, beside the panel,
 * without taking focus.
 */
export class EditorControl implements vscode.Disposable {
  private readonly shown = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.findMatchForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  private readonly followed = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
  });

  constructor(private readonly workspaceRoot: string) {}

  async showCode(range: CodeRange): Promise<void> {
    const editor = await this.open(range.path);
    const last = editor.document.lineCount - 1;
    const start = Math.min(Math.max(range.startLine - 1, 0), last);
    const end = Math.min(Math.max(range.endLine - 1, start), last);
    const r = new vscode.Range(start, 0, end, editor.document.lineAt(end).text.length);
    this.clearAll();
    editor.setDecorations(this.shown, [r]);
    editor.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  clearHighlight(): void {
    this.clearAll();
  }

  /** Reveals the first location of a read/edit tool call that lies inside the workspace. */
  async follow(locations: Location[]): Promise<void> {
    const loc = locations.find((l) => l.path.startsWith(this.workspaceRoot));
    if (!loc) return;
    const editor = await this.open(loc.path);
    const line = Math.min(Math.max((loc.line ?? 1) - 1, 0), editor.document.lineCount - 1);
    const r = new vscode.Range(line, 0, line, 0);
    for (const e of vscode.window.visibleTextEditors) e.setDecorations(this.followed, []);
    editor.setDecorations(this.followed, [r]);
    editor.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private async open(file: string): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    return vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false });
  }

  private clearAll(): void {
    for (const e of vscode.window.visibleTextEditors) {
      e.setDecorations(this.shown, []);
      e.setDecorations(this.followed, []);
    }
  }

  dispose(): void {
    this.shown.dispose();
    this.followed.dispose();
  }
}
