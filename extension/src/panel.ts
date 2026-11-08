import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import {
  AgentSession,
  BillingGuardError,
  SPEECH_LAYER,
  AutoTurnEnder,
  RestartPolicy,
  SpeechChunker,
  StepSequencer,
  VoiceClient,
  classifyInterruption,
  editorContextLabel,
  formatEditorContext,
  parseDataFile,
  type ExplainStep,
  type Figure,
  type LiveChart,
  type PermissionRequest,
  type VoiceEvent,
} from "@voice-harness/core";
import { EditorControl } from "./editorControl";
import { EditorTracker } from "./editorTracker";
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
  private readonly voiceRestarts = new RestartPolicy();
  /** Conversation mode: after Claude finishes, listen for a reply that ends on a pause. */
  private conversation: boolean;
  /** A finished agent turn whose spoken reply hasn't been answered yet. */
  private awaitingReply = false;
  /** Speech queued and not yet finished; auto-listening waits for it so the reply isn't cut off. */
  private speechPending = false;
  private readonly autoTurn = new AutoTurnEnder(
    () => this.voice?.listenStop(),
    () => this.voice?.listenCancel(),
  );
  private readonly steps = new StepSequencer<ExplainStep>((step) => this.presentStep(step));
  /** True while a loaded session's history is replayed: shown, not spoken, no editor effects. */
  private replaying = false;
  /** User text of the replayed message currently being assembled. */
  private replayUser = "";
  /** True from a cancel (or the start of listening) until the next turn starts. */
  private suppressSpeech = false;
  private turn: Promise<void> | null = null;
  private readonly pendingPermissions = new Map<string, (optionId: string | null) => void>();
  private readonly pendingFigures = new Map<string, (result: { ok: boolean; error?: string }) => void>();
  /** Live charts following their data files, oldest first. */
  private readonly liveCharts = new Map<string, ReturnType<typeof setInterval>>();
  /** Editor effects waiting for speech to reach their place, keyed by voice marker id. */
  private readonly pendingMarks = new Map<number, () => void>();
  private readonly editor: EditorControl;
  private readonly tracker: EditorTracker;
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

  static restartVoice(): void {
    const panel = HarnessPanel.current;
    if (!panel) return;
    panel.voiceRestarts.reset();
    panel.voice?.dispose();
    panel.voice = undefined;
    panel.startVoice();
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
    this.tracker = new EditorTracker(workspace);
    this.speakReplies = vscode.workspace.getConfiguration("voiceHarness").get<boolean>("speakReplies", true);
    this.conversation = vscode.workspace.getConfiguration("voiceHarness").get<boolean>("conversationMode", true);
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
      case "toggleConversation":
        this.conversation = !this.conversation;
        if (!this.conversation) {
          this.awaitingReply = false;
          if (this.autoTurn.running) this.cancelListening();
        }
        this.postVoice();
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
      case "listSessions":
        await this.listSessions();
        break;
      case "loadSession":
        await this.loadSession(m.id);
        break;
      case "newSession":
        this.post({ type: "clear" });
        await this.startSession();
        break;
    }
  }

  // MARK: Agent session

  private async startSession(loadSessionId?: string): Promise<void> {
    this.session?.dispose();
    this.session = undefined;
    this.turn = null;
    this.silence();
    this.resolveAllPermissions();
    this.post({ type: "state", state: "starting", detail: "Starting Claude…" });

    const config = vscode.workspace.getConfiguration("voiceHarness");
    const nodePath = resolveTool("node", config.get<string>("nodePath"));
    const claudePath = resolveTool("claude", config.get<string>("claudePath"));
    const agentEntry = this.runtimeFile(path.join("node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js"));
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
        loadSessionId,
        handlers: {
          onText: (chunk) => {
            this.flushReplayedUser();
            this.post({ type: "agentText", chunk });
            if (!this.replaying) this.speak(this.chunker.push(chunk));
          },
          onUserText: (chunk) => {
            if (this.replaying) this.replayUser += chunk;
          },
          onToolCall: (t, isUpdate) => {
            this.flushReplayedUser();
            this.post({ type: "tool", id: t.id, title: t.title, kind: t.kind, status: t.status, isUpdate });
            if (this.replaying) return;
            if (!isUpdate) this.speak(this.chunker.flush());
            if (t.locations.length && (t.kind === "read" || t.kind === "edit")) void this.editor.follow(t.locations);
          },
          onPermission: (req, signal) => this.askPermission(req, signal),
          onShowCode: async (range) => this.inStepWithSpeech(() => void this.editor.showCode(range)),
          onExplainCode: async (step) => this.steps.push(step, step.step),
          onClearHighlight: async () => this.inStepWithSpeech(() => this.editor.clearHighlight()),
          onShowFigure: (figure) => this.showFigure(figure),
          onShowLiveChart: (chart) => this.showLiveChart(chart),
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

  // MARK: Past sessions

  private async listSessions(): Promise<void> {
    if (!this.session) return;
    try {
      const items = (await this.session.list()).map((s) => ({
        id: s.id,
        title: HarnessPanel.withoutEditorContext(s.title ?? "").trim() || "Untitled conversation",
        updatedAt: s.updatedAt,
      }));
      this.post({ type: "sessions", items, currentId: this.session.sessionId });
    } catch (err) {
      this.post({ type: "notice", text: `Could not list conversations: ${(err as Error).message}` });
    }
  }

  /** Replaces the chat with a past conversation, replayed silently. */
  private async loadSession(id: string): Promise<void> {
    if (!this.session) return;
    this.silence();
    if (this.turn) {
      this.session.cancel();
      await this.turn;
    }
    this.post({ type: "clear" });
    this.post({ type: "state", state: "starting", detail: "Loading conversation…" });
    this.replaying = true;
    this.replayUser = "";
    try {
      await this.session.load(id);
      this.flushReplayedUser();
      this.post({ type: "notice", text: "Conversation restored. New messages continue it." });
    } catch (err) {
      this.post({ type: "error", text: `Could not load the conversation: ${(err as Error).message}` });
    } finally {
      this.replaying = false;
      this.post({ type: "state", state: "ready", detail: this.session?.loginSummary });
    }
  }

  private flushReplayedUser(): void {
    if (!this.replayUser) return;
    const text = HarnessPanel.withoutEditorContext(this.replayUser).trim();
    this.replayUser = "";
    if (text) this.post({ type: "user", text, spoken: false });
  }

  private static withoutEditorContext(text: string): string {
    return text.replace(/<editor-context>[\s\S]*?<\/editor-context>\s*/g, "");
  }

  /** Starts a user turn, cancelling (and silencing) any turn still running. */
  private async send(text: string, spoken: boolean): Promise<void> {
    if (!this.session) return;
    this.awaitingReply = false;
    if (this.autoTurn.running) this.cancelListening();
    this.silence();
    if (this.turn) {
      this.session.cancel();
      await this.turn;
    }
    const session = this.session;
    if (!session) return;
    this.suppressSpeech = false;
    const context = vscode.workspace.getConfiguration("voiceHarness").get<boolean>("sendEditorContext", true)
      ? this.tracker.current()
      : undefined;
    const prompt = context ? `${formatEditorContext(context)}\n\n${text}` : text;
    this.post({ type: "partial", text: "", source: null });
    this.post({ type: "user", text, spoken, context: context ? editorContextLabel(context) : undefined });
    this.post({ type: "state", state: "busy" });
    // `turn` is read in `finally`, which always runs after this assignment completes.
    let turn!: Promise<void>;
    turn = (async () => {
      try {
        const stopReason = await session.prompt(prompt);
        this.speak(this.chunker.flush());
        this.post({ type: "turnEnd", stopReason });
        if (stopReason === "end_turn" && !this.suppressSpeech) {
          this.awaitingReply = true;
          // With no speech in flight, listen now; otherwise speechIdle starts it.
          if (!this.speechPending) setTimeout(() => this.maybeListenForReply(), 0);
        }
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
    this.awaitingReply = false;
    this.silence();
    if (this.voiceState === "listening" || this.voiceState === "warming") this.cancelListening();
    this.session?.cancel();
  }

  private cancelListening(): void {
    this.autoTurn.stop();
    this.voice?.listenCancel();
  }

  /** In conversation mode, opens the mic for the user's reply once Claude has finished speaking. */
  private maybeListenForReply(): void {
    if (!this.conversation || !this.awaitingReply || this.turn || !this.voice || !this.microphone) return;
    if (this.voiceState !== "idle") return;
    this.awaitingReply = false;
    this.autoTurn.start();
    this.voice.listenStart();
  }

  // MARK: Voice

  private startVoice(): void {
    const config = vscode.workspace.getConfiguration("voiceHarness");
    const binary = this.runtimeFile(path.join("bin", "VoiceHarnessVoice"), path.join("voice", ".build", "release", "VoiceHarnessVoice"));
    const modelsDirectory = config.get<string>("modelsDirectory") || HarnessPanel.DEFAULT_MODELS;
    mkdirSync(modelsDirectory, { recursive: true });
    if (!existsSync(binary)) {
      this.setVoice("unavailable", `voice process not built (run npm run build): ${binary}`);
      return;
    }
    this.setVoice("loading", "Loading voice…");
    this.voice = VoiceClient.start({
      binary,
      modelsDirectory,
      voice: config.get<string>("voice") || "af_heart",
      voiceProcessing: config.get<boolean>("echoCancellation", false),
      interruptions: config.get<boolean>("autoInterrupt", false),
      onEvent: (e) => this.onVoiceEvent(e),
      onExit: (reason) => {
        this.voice = undefined;
        this.pendingMarks.clear();
        this.chunker.reset();
        this.speechPending = false;
        this.autoTurn.stop();
        this.output.appendLine(reason);
        if (this.disposed) return;
        const delay = this.voiceRestarts.next();
        if (delay === null) {
          this.setVoice("unavailable", `${reason}; it keeps stopping, so it was not restarted (Voice Harness: Restart Voice to try again)`);
          return;
        }
        this.setVoice("loading", "Voice stopped unexpectedly; restarting…");
        this.post({ type: "notice", text: "The voice process stopped unexpectedly and is restarting." });
        setTimeout(() => {
          if (!this.disposed && !this.voice) this.startVoice();
        }, delay);
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
        this.speechPending = false;
        if (this.voiceState === "speaking") this.setVoice("idle");
        if (!this.turn) this.maybeListenForReply();
        break;
      case "speechStart":
        this.autoTurn.speechStart();
        break;
      case "speechEnd":
        this.autoTurn.speechEnd();
        break;
      case "micWarming":
        this.setVoice("warming", this.inputDevice ? `mic: ${this.inputDevice}` : undefined);
        break;
      case "listening":
        this.setVoice("listening", this.inputDevice ? `mic: ${this.inputDevice}` : undefined);
        break;
      case "partial":
        if (e.source === "user") this.autoTurn.partialText(e.text);
        this.post({ type: "partial", text: e.text, source: e.source });
        break;
      case "transcript":
        this.autoTurn.stop();
        this.setVoice("idle", this.inputDevice ? `mic: ${this.inputDevice}` : undefined);
        this.post({ type: "partial", text: "", source: null });
        if (e.text) void this.send(e.text, true);
        else this.post({ type: "notice", text: "Didn't catch anything." });
        break;
      case "listenCancelled":
        this.autoTurn.stop();
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
      case "marked": {
        const effect = this.pendingMarks.get(e.id);
        this.pendingMarks.delete(e.id);
        effect?.();
        break;
      }
      case "rendered":
      case "voices":
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
      this.autoTurn.stop();
      this.voice.listenStop();
      return;
    }
    this.awaitingReply = false;
    if (this.voiceState === "warming") return;
    // Whatever the agent says next belongs to the turn being replaced.
    this.silence();
    this.voice.listenStart();
  }

  /**
   * Applies an editor effect when speech reaches the point where the agent asked for it, so
   * highlights move with the spoken explanation rather than with (faster) generation. Without
   * speech the effect applies at once.
   */
  private inStepWithSpeech(effect: () => void): void {
    if (!this.voice || !this.speakReplies || this.suppressSpeech || this.voiceState === "loading" || this.voiceState === "unavailable") {
      effect();
      return;
    }
    this.pendingMarks.set(this.voice.mark(), effect);
  }

  /** One walkthrough step: its words in the chat, its highlight as speech reaches it, then its words spoken. */
  private presentStep(step: ExplainStep): void {
    this.speak(this.chunker.flush());
    this.post({
      type: "step",
      file: path.relative(this.workspace, step.range.path),
      startLine: step.range.startLine,
      endLine: step.range.endLine,
      text: step.say,
    });
    this.inStepWithSpeech(() => void this.editor.showCode(step.range));
    const words = new SpeechChunker();
    this.speak([...words.push(step.say + "\n"), ...words.flush()]);
  }

  private speak(sentences: string[]): void {
    if (!this.voice || !this.speakReplies || this.suppressSpeech) return;
    for (const s of sentences) this.voice.speak(s);
    if (sentences.length) this.speechPending = true;
  }

  /** Stops speech now and drops speech for the rest of the current turn. */
  private silence(): void {
    this.suppressSpeech = true;
    this.speechPending = false;
    this.pendingMarks.clear();
    this.steps.reset();
    this.chunker.reset();
    this.voice?.stopSpeaking();
  }

  private setVoice(state: VoiceUiState, detail?: string): void {
    this.voiceState = state;
    this.voiceDetail = detail;
    this.postVoice();
  }

  private postVoice(): void {
    this.post({
      type: "voice",
      state: this.voiceState,
      speak: this.speakReplies,
      microphone: this.microphone,
      conversation: this.conversation,
      autoListening: this.autoTurn.running,
      detail: this.voiceDetail,
    });
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

  private static readonly MAX_LIVE_CHARTS = 3;
  private static readonly MAX_LIVE_READ_BYTES = 4 * 1024 * 1024;

  private async showLiveChart(chart: LiveChart): Promise<{ ok: true } | { ok: false; error: string }> {
    const { id, result } = await this.sendFigure({ kind: "vega-lite", content: chart.spec, caption: chart.caption }, true);
    if (result.ok) this.followDataFile(id, chart.dataFile);
    return result;
  }

  /** Re-reads the data file whenever its size or modification time changes, about once a second. */
  private followDataFile(id: string, file: string): void {
    if (this.liveCharts.size >= HarnessPanel.MAX_LIVE_CHARTS) {
      const [oldest, timer] = this.liveCharts.entries().next().value!;
      clearInterval(timer);
      this.liveCharts.delete(oldest);
    }
    let lastSeen = "";
    const tick = () => {
      let seen = "missing";
      try {
        const st = statSync(file);
        seen = `${st.size}:${st.mtimeMs}`;
      } catch {
        // not written yet
      }
      if (seen === lastSeen || seen === "missing") return;
      lastSeen = seen;
      try {
        this.post({ type: "figureData", id, rows: parseDataFile(file, HarnessPanel.readTail(file)) });
      } catch (err) {
        this.output.appendLine(`live chart: could not read ${file}: ${(err as Error).message}`);
      }
    };
    tick();
    this.liveCharts.set(id, setInterval(tick, 1000));
  }

  /** The file's text, or only its last few megabytes (from a line start) when it is large. */
  private static readTail(file: string): string {
    const size = statSync(file).size;
    if (size <= HarnessPanel.MAX_LIVE_READ_BYTES) return readFileSync(file, "utf8");
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(HarnessPanel.MAX_LIVE_READ_BYTES);
      readSync(fd, buffer, 0, buffer.length, size - buffer.length);
      const text = buffer.toString("utf8");
      return text.slice(text.indexOf("\n") + 1);
    } finally {
      closeSync(fd);
    }
  }

  private async showFigure(figure: Figure): Promise<{ ok: true } | { ok: false; error: string }> {
    return (await this.sendFigure(figure, false)).result;
  }

  /** Sends a figure to the webview and waits (up to 10 s) for it to report whether it rendered. */
  private async sendFigure(figure: Figure, live: boolean): Promise<{ id: string; result: { ok: true } | { ok: false; error: string } }> {
    let content = figure.content;
    if (figure.kind === "image") {
      const type = HarnessPanel.IMAGE_TYPES[path.extname(figure.content).toLowerCase()];
      const fail = (error: string) => ({ id: "", result: { ok: false as const, error } });
      if (!type) return fail("unsupported image type");
      if (!existsSync(figure.content)) return fail(`no such file: ${figure.content}`);
      if (statSync(figure.content).size > HarnessPanel.MAX_IMAGE_BYTES) return fail("image is larger than 15 MB");
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
      this.post({ type: "figure", id, kind: figure.kind, content, caption: figure.caption, live });
    });
    return { id, result: result.ok ? { ok: true } : { ok: false, error: result.error ?? "rendering failed" } };
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

  static readonly DEFAULT_MODELS = path.join(os.homedir(), "Library", "Application Support", "voice-harness", "models");

  /**
   * A file the extension runs: inside the extension when packaged (`.vsix`), otherwise in the
   * repository (development install, where the extension folder may be a link to `<repo>/extension`).
   */
  private runtimeFile(packaged: string, inRepo: string = packaged): string {
    const extensionDir = realpathSync(this.context.extensionPath);
    const candidate = path.join(extensionDir, packaged);
    return existsSync(candidate) ? candidate : path.join(path.resolve(extensionDir, ".."), inRepo);
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
<div id="session-menu" class="session-menu" hidden>
  <div class="session-menu-head"><span>Conversations in this folder</span><button id="session-new" class="secondary">+ New conversation</button><button id="session-close" class="secondary" title="Close">✕</button></div>
  <div id="session-list" class="session-list"></div>
</div>
<footer>
  <textarea id="input" rows="3" placeholder="Ask about the code… (Enter to send, Shift+Enter for a new line, Ctrl+Shift+Space to talk)"></textarea>
  <div class="buttons">
    <button id="talk" title="Ctrl+Shift+Space">🎙 Talk</button>
    <button id="send">Send</button>
    <button id="stop" class="secondary">Stop</button>
    <span class="spacer"></span>
    <button id="sessions" class="secondary" title="Past conversations in this folder">☰ Sessions</button>
    <button id="conversation" class="secondary" title="After Claude replies, listen for your answer; a pause ends it">💬 Conversation on</button>
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
    for (const timer of this.liveCharts.values()) clearInterval(timer);
    this.liveCharts.clear();
    this.session?.dispose();
    this.voice?.dispose();
    this.editor.dispose();
    this.tracker.dispose();
  }
}
