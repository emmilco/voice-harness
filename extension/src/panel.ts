import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  AgentSession,
  BillingGuardError,
  SPEECH_LAYER,
  SpeechChunker,
  VoiceClient,
  classifyInterruption,
  type Figure,
  type PermissionRequest,
  type VoiceEvent,
} from "@voice-harness/core";
import { EditorControl } from "./editorControl";
import type { FromWebview, ToWebview, VoiceUiState } from "./protocol";
import { resolveTool } from "./toolchain";

/**
 * The chat panel: owns one agent session, the voice process, and the editor
 * effects the agent causes.
 *
 * Speech: agent prose is chunked into sentences and spoken as it streams; a
 * user turn (typed or spoken) stops speech and, if the agent is mid-turn,
 * cancels that turn first. Speech from a cancelled turn is suppressed.
 */
export class HarnessPanel implements vscode.Disposable {
  private static current: HarnessPanel | undefined;

  private session: AgentSession | undefined;
  private voice: VoiceClient | undefined;
  private voiceState: VoiceUiState = "loading";
  private voiceDetail: string | undefined;
  private microphone = false;
  private inputDevice: string | undefined;
  private speakReplies: boolean;
  private readonly chunker = new SpeechChunker();
  /** True from a cancel (or the start of listening) until the next turn starts. */
  private suppressSpeech = false;
  private turn: Promise<void> | null = null;
  private readonly pendingPermissions = new Map<string, (optionId: string | null) => void>();
  private readonly pendingFigures = new Map<string, (result: { ok: boolean; error?: string }) => void>();
  private readonly editor: EditorControl;
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

  static toggleListening(): void {
    HarnessPanel.current?.talk();
  }

  /** Ends the agent and voice processes when the extension deactivates. */
  static disposeCurrent(): void {
    HarnessPanel.current?.panel.dispose();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly workspace: string,
    private readonly output: vscode.OutputChannel,
  ) {
    this.editor = new EditorControl(workspace);
    this.speakReplies = vscode.workspace.getConfiguration("voiceHarness").get<boolean>("speakReplies", true);
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
        this.startVoice();
        await this.startSession();
        break;
      case "send":
        await this.send(m.text, false);
        break;
      case "stop":
        this.stopEverything();
        break;
      case "restart":
        await this.startSession();
        break;
      case "talk":
        this.talk();
        break;
      case "toggleSpeak":
        this.speakReplies = !this.speakReplies;
        if (!this.speakReplies) this.silence();
        this.postVoice();
        break;
      case "permission":
        this.pendingPermissions.get(m.requestId)?.(m.optionId);
        break;
      case "figureResult":
        this.pendingFigures.get(m.id)?.({ ok: m.ok, error: m.error });
        break;
    }
  }

  // MARK: Agent session

  private async startSession(): Promise<void> {
    this.session?.dispose();
    this.session = undefined;
    this.turn = null;
    this.silence();
    this.resolveAllPermissions();
    this.post({ type: "state", state: "starting", detail: "Starting Claude…" });

    const config = vscode.workspace.getConfiguration("voiceHarness");
    const nodePath = resolveTool("node", config.get<string>("nodePath"));
    const claudePath = resolveTool("claude", config.get<string>("claudePath"));
    const agentEntry = path.join(this.repoRoot, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
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
          onText: (chunk) => {
            this.post({ type: "agentText", chunk });
            this.speak(this.chunker.push(chunk));
          },
          onToolCall: (t, isUpdate) => {
            this.post({ type: "tool", id: t.id, title: t.title, kind: t.kind, status: t.status, isUpdate });
            if (!isUpdate) this.speak(this.chunker.flush());
            if (t.locations.length && (t.kind === "read" || t.kind === "edit")) void this.editor.follow(t.locations);
          },
          onPermission: (req, signal) => this.askPermission(req, signal),
          onShowCode: (range) => this.editor.showCode(range),
          onClearHighlight: async () => this.editor.clearHighlight(),
          onShowFigure: (figure) => this.showFigure(figure),
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

  /** Starts a user turn, cancelling (and silencing) any turn still running. */
  private async send(text: string, spoken: boolean): Promise<void> {
    if (!this.session) return;
    this.silence();
    if (this.turn) {
      this.session.cancel();
      await this.turn;
    }
    const session = this.session;
    if (!session) return;
    this.suppressSpeech = false;
    this.post({ type: "partial", text: "", source: null });
    this.post({ type: "user", text, spoken });
    this.post({ type: "state", state: "busy" });
    // `turn` is read in `finally`, which always runs after this assignment completes.
    let turn!: Promise<void>;
    turn = (async () => {
      try {
        const stopReason = await session.prompt(text);
        this.speak(this.chunker.flush());
        this.post({ type: "turnEnd", stopReason });
      } catch (err) {
        this.post({ type: "error", text: (err as Error).message });
      } finally {
        if (this.turn === turn) this.turn = null;
        this.post({ type: "state", state: this.session ? "ready" : "stopped", detail: this.session?.loginSummary });
      }
    })();
    this.turn = turn;
    await turn;
  }

  private stopEverything(): void {
    this.silence();
    if (this.voiceState === "listening") this.voice?.listenCancel();
    this.session?.cancel();
  }

  // MARK: Voice

  private startVoice(): void {
    const config = vscode.workspace.getConfiguration("voiceHarness");
    const binary = path.join(this.repoRoot, "voice", ".build", "release", "VoiceHarnessVoice");
    if (!existsSync(binary)) {
      this.setVoice("unavailable", `voice process not built (run npm run build): ${binary}`);
      return;
    }
    this.setVoice("loading", "Loading voice…");
    this.voice = VoiceClient.start({
      binary,
      modelsDirectory: config.get<string>("modelsDirectory") || "/Users/Shared/ai/models/fluidaudio",
      voice: config.get<string>("voice") || "af_heart",
      voiceProcessing: config.get<boolean>("echoCancellation", false),
      interruptions: config.get<boolean>("autoInterrupt", false),
      onEvent: (e) => this.onVoiceEvent(e),
      onExit: (reason) => {
        this.voice = undefined;
        this.output.appendLine(reason);
        this.setVoice("unavailable", reason);
      },
    });
  }

  private onVoiceEvent(e: VoiceEvent): void {
    switch (e.event) {
      case "loading":
        this.setVoice("loading", "Loading voice…");
        break;
      case "ready":
        this.microphone = e.microphone;
        this.output.appendLine(`voice ready: ${JSON.stringify(e)}`);
        this.inputDevice = e.inputDevice;
        this.setVoice("idle", e.microphone ? `mic: ${e.inputDevice}` : "microphone unavailable — speech output only");
        break;
      case "deviceChanged":
        this.inputDevice = e.input;
        this.output.appendLine(`audio devices changed: input ${e.input}, output ${e.output}`);
        this.post({ type: "notice", text: `Audio switched to ${e.output} (mic: ${e.input}).` });
        this.setVoice(this.voiceState === "listening" ? "listening" : "idle", `mic: ${e.input}`);
        break;
      case "level":
        this.post({ type: "level", db: e.db });
        break;
      case "micStats":
        this.output.appendLine(`[voice] mic during turn: ${JSON.stringify(e)}`);
        break;
      case "synthesized":
        this.output.appendLine(`[voice] synthesized #${e.id}: ${e.ms} ms for ${e.audioMs} ms of audio`);
        break;
      case "micUnavailable":
        this.output.appendLine(`microphone unavailable: ${e.reason}`);
        break;
      case "speechActive":
        if (this.voiceState !== "listening") this.setVoice("speaking");
        break;
      case "speechIdle":
        if (this.voiceState === "speaking") this.setVoice("idle");
        break;
      case "micWarming":
        this.setVoice("warming", this.inputDevice ? `mic: ${this.inputDevice}` : undefined);
        break;
      case "listening":
        this.setVoice("listening", this.inputDevice ? `mic: ${this.inputDevice}` : undefined);
        break;
      case "partial":
        this.post({ type: "partial", text: e.text, source: e.source });
        break;
      case "transcript":
        this.setVoice("idle", this.inputDevice ? `mic: ${this.inputDevice}` : undefined);
        this.post({ type: "partial", text: "", source: null });
        if (e.text) void this.send(e.text, true);
        else this.post({ type: "notice", text: "Didn't catch anything." });
        break;
      case "listenCancelled":
        this.setVoice("idle");
        this.post({ type: "partial", text: "", source: null });
        break;
      case "bargeIn":
        this.setVoice("interrupted");
        break;
      case "interruption": {
        const action = classifyInterruption(e.text);
        this.output.appendLine(`interruption "${e.text}" → ${action}`);
        this.post({ type: "partial", text: "", source: null });
        if (action === "resume") {
          this.voice?.resumeSpeaking();
          this.setVoice("speaking");
        } else {
          this.setVoice("idle");
          void this.send(e.text, true);
        }
        break;
      }
      case "spoke":
        break;
      case "error":
        if (this.voiceState === "warming") this.setVoice("idle", this.inputDevice ? `mic: ${this.inputDevice}` : undefined);
        this.output.appendLine(`voice error: ${e.message}`);
        this.post({ type: "notice", text: `Voice: ${e.message}` });
        break;
      case "fatal":
        this.output.appendLine(`voice fatal: ${e.message}`);
        this.setVoice("unavailable", e.message);
        break;
      case "log":
        this.output.appendLine(`[voice] ${e.message}`);
        break;
    }
  }

  /** Talk key: start a spoken turn, or end the one in progress. */
  private talk(): void {
    if (!this.voice || !this.microphone || this.voiceState === "loading" || this.voiceState === "unavailable") {
      this.post({ type: "notice", text: "Voice input isn't available yet." });
      return;
    }
    if (this.voiceState === "listening") {
      this.voice.listenStop();
      return;
    }
    if (this.voiceState === "warming") return;
    // Whatever the agent says next belongs to the turn being replaced.
    this.silence();
    this.voice.listenStart();
  }

  private speak(sentences: string[]): void {
    if (!this.voice || !this.speakReplies || this.suppressSpeech) return;
    for (const s of sentences) this.voice.speak(s);
  }

  /** Stops speech now and drops speech for the rest of the current turn. */
  private silence(): void {
    this.suppressSpeech = true;
    this.chunker.reset();
    this.voice?.stopSpeaking();
  }

  private setVoice(state: VoiceUiState, detail?: string): void {
    this.voiceState = state;
    this.voiceDetail = detail;
    this.postVoice();
  }

  private postVoice(): void {
    this.post({ type: "voice", state: this.voiceState, speak: this.speakReplies, microphone: this.microphone, detail: this.voiceDetail });
  }

  // MARK: Figures

  private static readonly IMAGE_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  private static readonly MAX_IMAGE_BYTES = 15 * 1024 * 1024;

  /** Sends a figure to the webview and waits (up to 10 s) for it to report whether it rendered. */
  private async showFigure(figure: Figure): Promise<{ ok: true } | { ok: false; error: string }> {
    let content = figure.content;
    if (figure.kind === "image") {
      const type = HarnessPanel.IMAGE_TYPES[path.extname(figure.content).toLowerCase()];
      if (!type) return { ok: false, error: "unsupported image type" };
      if (!existsSync(figure.content)) return { ok: false, error: `no such file: ${figure.content}` };
      if (statSync(figure.content).size > HarnessPanel.MAX_IMAGE_BYTES) return { ok: false, error: "image is larger than 15 MB" };
      content = `data:${type};base64,${readFileSync(figure.content).toString("base64")}`;
    }
    const id = randomBytes(8).toString("hex");
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const finish = (r: { ok: boolean; error?: string }) => {
        if (!this.pendingFigures.delete(id)) return;
        resolve(r);
      };
      this.pendingFigures.set(id, finish);
      setTimeout(() => finish({ ok: false, error: "the panel did not report rendering within 10 s" }), 10_000);
      this.post({ type: "figure", id, kind: figure.kind, content, caption: figure.caption });
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? "rendering failed" };
  }

  // MARK: Permissions

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

  // MARK: Webview

  /** The repository root. The extension may be installed as a link to `<repo>/extension`, so links are resolved first. */
  private get repoRoot(): string {
    return path.resolve(realpathSync(this.context.extensionPath), "..");
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString("base64");
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", name));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset("webview.css")}">
<title>Voice Harness</title>
</head>
<body>
<header>
  <div id="status" class="status starting">Starting…</div>
  <div id="voice" class="voice loading">Voice loading…</div>
</header>
<main id="log"></main>
<div id="partial" class="partial" hidden></div>
<footer>
  <textarea id="input" rows="3" placeholder="Ask about the code… (Enter to send, Shift+Enter for a new line, Ctrl+Shift+Space to talk)"></textarea>
  <div class="buttons">
    <button id="talk" title="Ctrl+Shift+Space">🎙 Talk</button>
    <button id="send">Send</button>
    <button id="stop" class="secondary">Stop</button>
    <span class="spacer"></span>
    <button id="speak" class="secondary" title="Speak Claude's replies">🔊 Voice on</button>
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
    for (const finish of [...this.pendingFigures.values()]) finish({ ok: false, error: "the panel was closed" });
    this.session?.dispose();
    this.voice?.dispose();
    this.editor.dispose();
  }
}
