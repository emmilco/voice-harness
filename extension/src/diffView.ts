import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";

const SCHEME = "voice-harness-diff";

/**
 * Opens VS Code's diff editor for an edit the agent reported. When the file on disk still
 * contains the new text exactly once, the left side is the whole file with the old text put
 * back, so the diff shows the edit in context; otherwise both sides are just the snippets.
 */
export class DiffView implements vscode.Disposable {
  private readonly documents = new Map<string, string>();
  private readonly registration: vscode.Disposable;
  private next = 0;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: (uri) => this.documents.get(uri.path) ?? "",
    });
  }

  async open(file: string, oldText: string | null, newText: string): Promise<void> {
    const name = path.basename(file);
    const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const inContext = current !== undefined && oldText !== null && current.split(newText).length === 2;
    if (inContext) {
      const before = this.virtual(`${name} (before)`, current.replace(newText, oldText), name);
      await vscode.commands.executeCommand("vscode.diff", before, vscode.Uri.file(file), `${name}: Claude's edit`);
      return;
    }
    const left = this.virtual(`${name} (old)`, oldText ?? "", name);
    const right = this.virtual(`${name} (new)`, newText, name);
    await vscode.commands.executeCommand("vscode.diff", left, right, `${name}: Claude's edit (snippet)`);
  }

  /** A read-only document whose path keeps the file's extension, so it gets syntax highlighting. */
  private virtual(label: string, text: string, fileName: string): vscode.Uri {
    const key = `/${this.next++}/${label.replace(/[^\w. ()-]/g, "_")}${path.extname(fileName)}`;
    this.documents.set(key, text);
    return vscode.Uri.from({ scheme: SCHEME, path: key });
  }

  dispose(): void {
    this.registration.dispose();
    this.documents.clear();
  }
}
