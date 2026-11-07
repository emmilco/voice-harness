import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { AgentSession, BillingGuardError, SPEECH_LAYER, type PermissionRequest } from "@voice-harness/core";
import { EditorControl } from "./editorControl";
import type { FromWebview, ToWebview } from "./protocol";
import { resolveTool } from "./toolchain";

/** The chat panel: owns one agent session and the editor effects it causes. */
export class HarnessPanel implements vscode.Disposable {
  private static current: HarnessPanel | undefined;

  private session: AgentSession | undefined;
  private readonly pendingPermissions = new Map<string, (optionId: string | null) => void>();
  private readonly editor: EditorControl;
  private readonly output: vscode.OutputChannel;
  private disposed = false;

  static show(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
    if (HarnessPanel.current) {
      HarnessPanel.current.panel.reveal(vscode.ViewColumn.Two);
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showErrorMessage("Voice Harness needs an open folder: the agent works inside it.");
      return;
    }
    const panel = vscode.window.createWebviewPanel("voiceHarness", "Voice Harness", vscode.ViewColumn.Two, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
    });
    HarnessPanel.current = new HarnessPanel(panel, context, folder.uri.fsPath, output);
  }

  static restart(): void {
    void HarnessPanel.current?.startSession();
  }

  /** Ends the agent process when the extension deactivates. */
  static disposeCurrent(): void {
    HarnessPanel.current?.panel.dispose();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly workspace: string,
    output: vscode.OutputChannel,
  ) {
    this.output = output;
    this.editor = new EditorControl(workspace);
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
    panel.onDidDispose(() => this.dispose());
  }

  private post(message: ToWebview): void {
    if (!this.disposed) void this.panel.webview.postMessage(message);
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case "ready":
        await this.startSession();
        break;
      case "send":
        await this.send(m.text);
        break;
      case "stop":
        this.session?.cancel();
        break;
      case "restart":
        await this.startSession();
        break;
      case "permission":
        this.pendingPermissions.get(m.requestId)?.(m.optionId);
        break;
    }
  }

  private async startSession(): Promise<void> {
    this.session?.dispose();
    this.session = undefined;
    this.resolveAllPermissions();
    this.post({ type: "state", state: "starting", detail: "Starting Claude…" });

    const config = vscode.workspace.getConfiguration("voiceHarness");
    const nodePath = resolveTool("node", config.get<string>("nodePath"));
    const claudePath = resolveTool("claude", config.get<string>("claudePath"));
    const repoRoot = path.resolve(this.context.extensionPath, "..");
    const agentEntry = path.join(repoRoot, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
    const mcpServerScript = path.join(this.context.extensionPath, "dist", "mcpServer.mjs");

    const missing = [
      !nodePath && "node (set voiceHarness.nodePath)",
      !claudePath && "claude CLI (set voiceHarness.claudePath)",
      !existsSync(agentEntry) && `claude-agent-acp at ${agentEntry} (run npm install)`,
      !existsSync(mcpServerScript) && `${mcpServerScript} (run npm run build)`,
    ].filter(Boolean);
    if (missing.length) {
      this.post({ type: "state", state: "error", detail: `Cannot start — missing: ${missing.join("; ")}` });
      return;
    }

    try {
      this.session = await AgentSession.start({
        workspace: this.workspace,
        nodePath: nodePath!,
        claudePath: claudePath!,
        agentEntry,
        mcpServerScript,
        systemPromptAppend: SPEECH_LAYER,
        handlers: {
          onText: (chunk) => this.post({ type: "agentText", chunk }),
          onToolCall: (t, isUpdate) => {
            this.post({ type: "tool", id: t.id, title: t.title, kind: t.kind, status: t.status, isUpdate });
            if (t.locations.length && (t.kind === "read" || t.kind === "edit")) void this.editor.follow(t.locations);
          },
          onPermission: (req, signal) => this.askPermission(req, signal),
          onShowCode: (range) => this.editor.showCode(range),
          onClearHighlight: async () => this.editor.clearHighlight(),
          onLog: (line) => this.output.appendLine(line),
          onExit: (reason) => {
            this.session = undefined;
            this.resolveAllPermissions();
            this.post({ type: "state", state: "stopped", detail: `${reason}. Use Restart to begin a new session.` });
          },
        },
      });
      this.output.appendLine(`session ${this.session.sessionId} (${this.session.loginSummary}) in ${this.workspace}`);
      this.post({ type: "state", state: "ready", detail: this.session.loginSummary });
    } catch (err) {
      const detail = err instanceof BillingGuardError ? `Billing guard: ${err.problems.join("; ")}` : (err as Error).message;
      this.output.appendLine(`start failed: ${detail}`);
      this.post({ type: "state", state: "error", detail });
    }
  }

  private async send(text: string): Promise<void> {
    if (!this.session) return;
    this.post({ type: "user", text });
    this.post({ type: "state", state: "busy" });
    try {
      const stopReason = await this.session.prompt(text);
      this.post({ type: "turnEnd", stopReason });
      this.post({ type: "state", state: "ready", detail: this.session?.loginSummary });
    } catch (err) {
      this.post({ type: "error", text: (err as Error).message });
      this.post({ type: "state", state: this.session ? "ready" : "stopped" });
    }
  }

  private askPermission(req: PermissionRequest, signal: AbortSignal): Promise<string | null> {
    const requestId = randomBytes(8).toString("hex");
    return new Promise((resolve) => {
      const finish = (optionId: string | null) => {
        if (!this.pendingPermissions.delete(requestId)) return;
        this.post({ type: "permissionDone", requestId });
        resolve(optionId);
      };
      this.pendingPermissions.set(requestId, finish);
      signal.addEventListener("abort", () => finish(null), { once: true });
      this.post({ type: "permission", requestId, title: req.title, kind: req.kind, options: req.options });
    });
  }

  private resolveAllPermissions(): void {
    for (const finish of [...this.pendingPermissions.values()]) finish(null);
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString("base64");
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", name));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset("webview.css")}">
<title>Voice Harness</title>
</head>
<body>
<header id="status" class="status starting">Starting…</header>
<main id="log"></main>
<footer>
  <textarea id="input" rows="3" placeholder="Ask about the code… (Enter to send, Shift+Enter for a new line)"></textarea>
  <div class="buttons">
    <button id="send">Send</button>
    <button id="stop" class="secondary">Stop</button>
    <button id="restart" class="secondary">Restart</button>
  </div>
</footer>
<script nonce="${nonce}" src="${asset("webview.js")}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    HarnessPanel.current = undefined;
    this.resolveAllPermissions();
    this.session?.dispose();
    this.editor.dispose();
  }
}
