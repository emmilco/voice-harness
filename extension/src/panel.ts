import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { AutoTurnEnder, RestartPolicy, VoiceClient, classifyInterruption, type VoiceEvent } from "@voice-harness/core";
import { ChatTab, withoutEditorContext, type TabServices } from "./chatTab";
import { DiffView } from "./diffView";
import { EditorControl } from "./editorControl";
import { EditorTracker } from "./editorTracker";
import type { FromWebview, PanelMessage, TabRequest, ToWebview, VoiceUiState } from "./protocol";
import { resolveTool } from "./toolchain";

/** Where the chat lives: an editor tab or a sidebar view. */
export interface HarnessHost {
  readonly webview: vscode.Webview;
  setTitle(title: string): void;
  reveal(): void;
  onDidDispose(listener: () => void): vscode.Disposable;
  /** Closes the host when that is possible (an editor tab); a sidebar view stays. */
  close(): void;
}

function tabHost(panel: vscode.WebviewPanel): HarnessHost {
  return {
    webview: panel.webview,
    setTitle: (title) => (panel.title = title),
    reveal: () => panel.reveal(vscode.ViewColumn.Two),
    onDidDispose: (listener) => panel.onDidDispose(listener),
    close: () => panel.dispose(),
  };
}

function viewHost(view: vscode.WebviewView): HarnessHost {
  return {
    webview: view.webview,
    setTitle: (title) => (view.description = title.replace(/^Voice Harness: /, "")),
    reveal: () => view.show(false),
    onDidDispose: (listener) => view.onDidDispose(listener),
    close: () => {},
  };
}

const TAB_REQUESTS = new Set(["send", "stop", "restart", "permission", "figureResult", "setOption", "unqueue", "sendNow", "rewind", "showStep"]);

/**
 * The chat panel: a set of conversation tabs (each its own agent session) sharing one voice
 * process and one editor. Only the visible tab speaks, listens, or moves the editor.
 *
 * Speech: the visible tab's prose is chunked into sentences and spoken as it streams; a user
 * turn (typed or spoken) stops speech. Switching tabs turns conversation mode off and discards
 * an unsent recording.
 */
export class HarnessPanel implements vscode.Disposable, TabServices {
  private static current: HarnessPanel | undefined;

  private readonly tabs = new Map<string, ChatTab>();
  private activeId = "";
  private voice: VoiceClient | undefined;
  private voiceState: VoiceUiState = "loading";
  private voiceDetail: string | undefined;
  private microphone = false;
  private inputDevice: string | undefined;
  private speakReplies: boolean;
  private readonly voiceRestarts = new RestartPolicy();
  /** Conversation mode: after Claude finishes, listen for a reply that ends on a pause. */
  private conversation: boolean;
  /** The visible tab finished a turn whose spoken reply hasn't been answered yet. */
  private awaitingReply = false;
  /** Speech queued and not yet finished; auto-listening waits for it so the reply isn't cut off. */
  private speechPending = false;
  private readonly autoTurn = new AutoTurnEnder(
    () => this.voice?.listenStop(),
    () => this.voice?.listenCancel(),
  );
  /** Editor effects waiting for speech to reach their place, keyed by voice marker id. */
  private readonly pendingMarks = new Map<number, () => void>();
  /** Sentences sent to the voice process and not yet finished, in order, with the bubble each belongs to. */
  private spoken: { id: number; tabId: string; ref?: string }[] = [];
  private nowSpeaking: { tabId: string; ref?: string } | undefined;
  /**
   * While the user records a turn started with Talk, the visible tab's speech and editor effects
   * wait here: dropped if the recording is sent (it replaces the turn), replayed if it is discarded.
   */
  private held: (() => void)[] | null = null;
  readonly editor: EditorControl;
  readonly tracker: EditorTracker;
  private readonly diffs = new DiffView();
  private disposed = false;

  static readonly VIEW_ID = "voiceHarness.view";
  static readonly DEFAULT_MODELS = path.join(os.homedir(), "Library", "Application Support", "voice-harness", "models");

  // MARK: Opening

  /** Opens the chat where the `voiceHarness.location` setting says (sidebar by default). */
  static show(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
    if (HarnessPanel.current) {
      HarnessPanel.current.host.reveal();
      return;
    }
    if (vscode.workspace.getConfiguration("voiceHarness").get<string>("location", "sidebar") === "sidebar") {
      void vscode.commands.executeCommand(`${HarnessPanel.VIEW_ID}.focus`);
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      void vscode.window.showErrorMessage("Voice Harness needs an open folder: the agent works inside it.");
      return;
    }
    const panel = vscode.window.createWebviewPanel("voiceHarness", "Voice Harness", vscode.ViewColumn.Two, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
    });
    HarnessPanel.current = new HarnessPanel(tabHost(panel), context, folder, output);
  }

  /** Hosts the chat in the sidebar view when VS Code first shows it. */
  static attachView(view: vscode.WebviewView, context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")] };
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (HarnessPanel.current || !folder) {
      view.webview.html = `<!DOCTYPE html><html><body style="padding:12px;font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground)">${
        folder ? "Voice Harness is open in an editor tab." : "Open a folder to use Voice Harness: the agent works inside it."
      }</body></html>`;
      return;
    }
    HarnessPanel.current = new HarnessPanel(viewHost(view), context, folder, output);
  }

  static restart(): void {
    const panel = HarnessPanel.current;
    const tab = panel?.active;
    if (tab) void tab.handle({ type: "restart", tabId: tab.id });
  }

  static toggleListening(): void {
    HarnessPanel.current?.talk();
  }

  static focusInput(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
    if (!HarnessPanel.current) {
      HarnessPanel.show(context, output);
      return;
    }
    HarnessPanel.current.host.reveal();
    HarnessPanel.current.postPanel({ type: "focusInput" });
  }

  static stop(): void {
    void HarnessPanel.current?.stopActive();
  }

  static cycleTab(step: number): void {
    const panel = HarnessPanel.current;
    if (!panel || panel.tabs.size < 2) return;
    const ids = [...panel.tabs.keys()];
    const index = ids.indexOf(panel.activeId);
    panel.activate(ids[(index + step + ids.length) % ids.length]);
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
    const current = HarnessPanel.current;
    current?.host.close();
    current?.dispose();
  }

  private constructor(
    private readonly host: HarnessHost,
    private readonly context: vscode.ExtensionContext,
    readonly workspace: string,
    readonly output: vscode.OutputChannel,
  ) {
    this.editor = new EditorControl(workspace);
    this.tracker = new EditorTracker(workspace);
    this.speakReplies = vscode.workspace.getConfiguration("voiceHarness").get<boolean>("speakReplies", true);
    this.conversation = vscode.workspace.getConfiguration("voiceHarness").get<boolean>("conversationMode", true);
    host.webview.html = this.html();
    host.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
    host.onDidDispose(() => this.dispose());
  }

  private get active(): ChatTab | undefined {
    return this.tabs.get(this.activeId);
  }

  // MARK: TabServices

  post(message: ToWebview): void {
    if (!this.disposed) void this.host.webview.postMessage(message);
  }

  private postPanel(message: PanelMessage): void {
    this.post(message);
  }

  isActive(tab: ChatTab): boolean {
    return tab.id === this.activeId;
  }

  agentPaths() {
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
    ].filter((x): x is string => !!x);
    return missing.length ? { missing } : { nodePath: nodePath!, claudePath: claudePath!, agentEntry, mcpServerScript };
  }

  speak(tab: ChatTab, sentences: string[], ref?: string): void {
    if (!this.isActive(tab) || !this.voice || !this.speakReplies || !sentences.length) return;
    if (this.held) {
      this.held.push(() => this.speak(tab, sentences, ref));
      return;
    }
    for (const s of sentences) this.spoken.push({ id: this.voice.speak(s), tabId: tab.id, ref });
    this.speechPending = true;
  }

  approvalRequested(tab: ChatTab): void {
    this.voice?.cue();
    if (!this.isActive(tab)) this.postPanel({ type: "notice", text: `“${tab.summary().label}” is waiting for your approval.` });
  }

  /** Marks the bubble being read aloud: the oldest sentence still playing. */
  private updateNowSpeaking(): void {
    const next = this.spoken[0];
    const current = next ? { tabId: next.tabId, ref: next.ref } : undefined;
    if (current?.tabId === this.nowSpeaking?.tabId && current?.ref === this.nowSpeaking?.ref) return;
    if (this.nowSpeaking) this.post({ type: "nowSpeaking", tabId: this.nowSpeaking.tabId, ref: null });
    this.nowSpeaking = current;
    if (current?.ref) this.post({ type: "nowSpeaking", tabId: current.tabId, ref: current.ref });
  }

  /** Stops all speech and forgets what was queued. */
  private stopVoiceOutput(): void {
    this.voice?.stopSpeaking();
    this.pendingMarks.clear();
    this.speechPending = false;
    this.spoken = [];
    this.updateNowSpeaking();
  }

  /** Replays speech and editor effects held during a recording that was discarded. */
  private releaseHeld(): void {
    const held = this.held;
    this.held = null;
    if (held?.length) {
      this.postPanel({ type: "notice", text: "Recording discarded; Claude's reply continues aloud." });
      for (const action of held) action();
    }
  }

  /**
   * Applies an editor effect when speech reaches the point where the agent asked for it, so
   * highlights move with the spoken explanation rather than with (faster) generation. Without
   * speech the effect applies at once; background tabs never move the editor.
   */
  inStepWithSpeech(tab: ChatTab, effect: () => void): void {
    if (!this.isActive(tab)) return;
    if (this.held) {
      this.held.push(() => this.inStepWithSpeech(tab, effect));
      return;
    }
    if (!this.voice || !this.speakReplies || this.voiceState === "loading" || this.voiceState === "unavailable") {
      effect();
      return;
    }
    this.pendingMarks.set(this.voice.mark(), effect);
  }

  silence(tab: ChatTab): void {
    if (!this.isActive(tab)) return;
    this.awaitingReply = false;
    this.held = null;
    this.stopVoiceOutput();
  }

  turnFinished(tab: ChatTab): void {
    if (!this.isActive(tab)) return;
    this.awaitingReply = true;
    // With no speech in flight, listen now; otherwise speechIdle starts it.
    if (!this.speechPending) setTimeout(() => this.maybeListenForReply(), 0);
  }

  changed(tab: ChatTab): void {
    this.postTabs();
    if (this.isActive(tab)) this.updateHostTitle();
  }

  // MARK: Tabs

  private newTab(loadSessionId?: string): ChatTab {
    const tab = new ChatTab(this);
    this.tabs.set(tab.id, tab);
    this.activate(tab.id);
    void tab.start(loadSessionId);
    return tab;
  }

  /** Shows a tab. Conversation mode turns off and an unsent recording is discarded. */
  private activate(id: string): void {
    const previous = this.active;
    if (previous && previous.id !== id) {
      this.held = null;
      this.stopVoiceOutput();
      this.awaitingReply = false;
      if (this.autoTurn.running || this.voiceState === "listening" || this.voiceState === "warming") this.cancelListening();
    }
    const turnOffAutoListen = !!previous && previous.id !== id && this.conversation;
    if (turnOffAutoListen) {
      this.conversation = false;
      this.postVoice();
    }
    this.activeId = id;
    const tab = this.active;
    if (tab) tab.unread = false;
    this.postTabs();
    this.updateHostTitle();
    if (turnOffAutoListen) this.postPanel({ type: "notice", text: "Auto-listen turned off because you switched conversations." });
  }

  /**
   * Stop, for the visible tab: discards a recording in progress; otherwise stops Claude's turn;
   * after the turn, silences a reply that is still being spoken.
   */
  private async stopActive(): Promise<void> {
    const tab = this.active;
    if (!tab) return;
    if (this.voiceState === "listening" || this.voiceState === "warming") {
      this.cancelListening();
      return;
    }
    if (!tab.busy) {
      this.stopVoiceOutput();
      return;
    }
    await tab.handle({ type: "stop", tabId: tab.id });
  }

  private closeTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const order = [...this.tabs.keys()];
    const index = order.indexOf(id);
    if (this.activeId === id) this.cancelListening();
    tab.dispose();
    this.tabs.delete(id);
    if (!this.tabs.size) {
      this.newTab();
      return;
    }
    if (this.activeId === id) this.activate(order[index + 1] ?? order[index - 1]);
    else this.postTabs();
  }

  private postTabs(): void {
    if (!this.activeId) return;
    this.postPanel({ type: "tabs", tabs: [...this.tabs.values()].map((t) => t.summary()), activeId: this.activeId });
  }

  private updateHostTitle(): void {
    const title = this.active?.displayTitle;
    this.host.setTitle(title ? `Voice Harness: ${title}` : "Voice Harness");
  }

  // MARK: Messages from the webview

  private async onMessage(m: FromWebview): Promise<void> {
    if (TAB_REQUESTS.has(m.type)) {
      const request = m as TabRequest;
      const tab = this.tabs.get(request.tabId);
      if (!tab) return;
      if (request.type === "send" || request.type === "sendNow") {
        if (this.autoTurn.running && this.isActive(tab)) this.cancelListening();
      }
      if (request.type === "stop" && this.isActive(tab)) {
        await this.stopActive();
        return;
      }
      await tab.handle(request);
      return;
    }
    switch (m.type) {
      case "ready":
        this.startVoice();
        if (!this.tabs.size) this.newTab();
        else this.postTabs();
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
        if (!this.speakReplies) this.stopVoiceOutput();
        this.postVoice();
        break;
      case "listFiles":
        this.postPanel({ type: "files", query: m.query, files: await this.findFiles(m.query) });
        break;
      case "openDiff":
        await this.diffs.open(m.path, m.oldText, m.newText);
        break;
      case "listSessions":
        await this.listSessions();
        break;
      case "openSession": {
        const open = [...this.tabs.values()].find((t) => t.sessionId === m.id);
        if (open) this.activate(open.id);
        else this.newTab(m.id);
        break;
      }
      case "newTab":
        this.newTab();
        break;
      case "closeTab":
        this.closeTab(m.id);
        break;
      case "switchTab":
        if (this.tabs.has(m.id)) this.activate(m.id);
        break;
      case "restartVoice":
        HarnessPanel.restartVoice();
        break;
    }
  }

  /** Workspace files matching what the user typed after @ (paths relative to the workspace). */
  private async findFiles(query: string): Promise<string[]> {
    const safe = query.replace(/[^\w./-]/g, "");
    const pattern = safe ? `**/*${safe.split("/").pop()}*` : "*";
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.workspace, pattern),
      "{**/node_modules/**,**/.git/**,**/.build/**,**/dist/**,**/build/**,**/.venv/**,**/__pycache__/**}",
      300,
    );
    return uris.map((u) => path.relative(this.workspace, u.fsPath)).sort();
  }

  private async listSessions(): Promise<void> {
    const agent = this.active?.agent ?? [...this.tabs.values()].find((t) => t.agent)?.agent;
    if (!agent) return;
    try {
      const openIn = new Map([...this.tabs.values()].filter((t) => t.sessionId).map((t) => [t.sessionId!, t.id]));
      const items = (await agent.list()).map((s) => ({
        id: s.id,
        title: withoutEditorContext(s.title ?? "").trim() || "Untitled conversation",
        updatedAt: s.updatedAt,
        openInTab: openIn.get(s.id),
      }));
      this.postPanel({ type: "sessions", items });
    } catch (err) {
      this.postPanel({ type: "notice", text: `Could not list conversations: ${(err as Error).message}` });
    }
  }

  // MARK: Voice

  private cancelListening(): void {
    this.autoTurn.stop();
    this.voice?.listenCancel();
  }

  /** In conversation mode, opens the mic for the user's reply once Claude has finished speaking. */
  private maybeListenForReply(): void {
    const tab = this.active;
    if (!this.conversation || !this.awaitingReply || !tab?.quiet || !this.voice || !this.microphone) return;
    if (this.voiceState !== "idle") return;
    this.awaitingReply = false;
    this.autoTurn.start();
    this.voice.listenStart();
  }

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
        this.speechPending = false;
        this.spoken = [];
        this.updateNowSpeaking();
        this.held = null;
        this.autoTurn.stop();
        this.output.appendLine(reason);
        if (this.disposed) return;
        const delay = this.voiceRestarts.next();
        if (delay === null) {
          this.setVoice("unavailable", `${reason}; it keeps stopping, so it was not restarted (Voice Harness: Restart Speech, or the Restart voice button, to try again)`);
          return;
        }
        this.setVoice("loading", "Voice stopped unexpectedly; restarting…");
        this.postPanel({ type: "notice", text: "Speech stopped unexpectedly and is restarting." });
        setTimeout(() => {
          if (!this.disposed && !this.voice) this.startVoice();
        }, delay);
      },
    });
  }

  private onVoiceEvent(e: VoiceEvent): void {
    const mic = () => (this.inputDevice ? `mic: ${this.inputDevice}` : undefined);
    switch (e.event) {
      case "loading":
        this.setVoice("loading", "Loading voice…");
        break;
      case "ready":
        this.microphone = e.microphone;
        this.output.appendLine(`voice ready: ${JSON.stringify(e)}`);
        this.inputDevice = e.inputDevice;
        this.setVoice("idle", e.microphone ? mic() : "microphone unavailable — speech output only");
        break;
      case "deviceChanged":
        this.inputDevice = e.input;
        this.output.appendLine(`audio devices changed: input ${e.input}, output ${e.output}`);
        this.postPanel({ type: "notice", text: `Audio switched to ${e.output} (mic: ${e.input}).` });
        this.setVoice(this.voiceState === "listening" ? "listening" : "idle", mic());
        break;
      case "level":
        this.postPanel({ type: "level", db: e.db });
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
        this.updateNowSpeaking();
        break;
      case "speechIdle":
        this.speechPending = false;
        this.spoken = [];
        this.updateNowSpeaking();
        if (this.voiceState === "speaking") this.setVoice("idle");
        if (!this.active?.busy) this.maybeListenForReply();
        break;
      case "speechStart":
        this.autoTurn.speechStart();
        break;
      case "speechEnd":
        this.autoTurn.speechEnd();
        break;
      case "micWarming":
        this.setVoice("warming", mic());
        break;
      case "listening":
        this.setVoice("listening", mic());
        break;
      case "partial":
        if (e.source === "user") this.autoTurn.partialText(e.text);
        this.postPanel({ type: "partial", text: e.text, source: e.source });
        break;
      case "transcript":
        this.autoTurn.stop();
        this.setVoice("idle", mic());
        this.postPanel({ type: "partial", text: "", source: null });
        if (e.text) {
          this.held = null;
          void this.active?.send(e.text, true);
        } else {
          this.postPanel({ type: "notice", text: "Didn't catch anything." });
          this.releaseHeld();
        }
        break;
      case "listenCancelled":
        this.autoTurn.stop();
        this.setVoice("idle", mic());
        this.postPanel({ type: "partial", text: "", source: null });
        this.releaseHeld();
        break;
      case "bargeIn":
        this.setVoice("interrupted");
        break;
      case "interruption": {
        const action = classifyInterruption(e.text);
        this.output.appendLine(`interruption "${e.text}" → ${action}`);
        this.postPanel({ type: "partial", text: "", source: null });
        if (action === "resume") {
          this.voice?.resumeSpeaking();
          this.setVoice("speaking");
        } else {
          this.setVoice("idle");
          void this.active?.send(e.text, true);
        }
        break;
      }
      case "spoke": {
        const index = this.spoken.findIndex((s) => s.id === e.id);
        if (index >= 0) this.spoken.splice(0, index + 1);
        this.updateNowSpeaking();
        break;
      }
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
        if (this.voiceState === "warming") this.setVoice("idle", mic());
        this.output.appendLine(`voice error: ${e.message}`);
        this.postPanel({ type: "notice", text: `Speech: ${e.message}` });
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

  /** Talk key: start a spoken turn in the visible tab, or end the one in progress. */
  private talk(): void {
    if (!this.voice || !this.microphone || this.voiceState === "loading" || this.voiceState === "unavailable") {
      this.postPanel({ type: "notice", text: "Mic input isn't available yet." });
      return;
    }
    if (this.voiceState === "listening") {
      this.autoTurn.stop();
      this.voice.listenStop();
      return;
    }
    this.awaitingReply = false;
    if (this.voiceState === "warming") return;
    // Hold the reply while the user speaks: dropped if they send, resumed if they discard.
    this.stopVoiceOutput();
    this.held = [];
    this.voice.listenStart();
  }

  private setVoice(state: VoiceUiState, detail?: string): void {
    this.voiceState = state;
    this.voiceDetail = detail;
    this.postVoice();
  }

  private postVoice(): void {
    this.postPanel({
      type: "voice",
      state: this.voiceState,
      speak: this.speakReplies,
      microphone: this.microphone,
      conversation: this.conversation,
      autoListening: this.autoTurn.running,
      detail: this.voiceDetail,
    });
  }

  // MARK: Webview

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
    const webview = this.host.webview;
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
<nav id="tabs" class="tabs"><div id="tab-list" class="tab-list"></div><button id="new-tab" class="tab-new secondary" title="New conversation">+</button></nav>
<header>
  <div id="title" class="conversation-title" hidden></div>
  <div id="status" class="status starting">Starting…</div>
  <div id="session-bar" class="session-bar"><span id="options" class="options"></span><span id="usage" class="usage"></span></div>
  <div id="voice" class="voice loading">Voice loading…</div>
</header>
<div id="logs" class="logs"></div>
<div id="partial" class="partial" hidden></div>
<div id="session-menu" class="session-menu" hidden>
  <div class="session-menu-head"><span>Conversations in this folder</span><button id="session-new" class="secondary">+ New conversation</button><button id="session-close" class="secondary" title="Close">✕</button></div>
  <div id="session-list" class="session-list"></div>
  <button id="restart" class="secondary session-restart" title="Clear this conversation and start it over with a fresh session">↺ Restart this conversation</button>
</div>
<footer>
  <textarea id="input" rows="3" placeholder="Ask about the code… (Enter to send, Shift+Enter for a new line, Ctrl+Shift+Space to talk)"></textarea>
  <div class="buttons">
    <button id="talk" title="Ctrl+Shift+Space">🎙 Talk</button>
    <button id="send">Send</button>
    <button id="stop" class="secondary">Stop</button>
    <span class="spacer"></span>
    <button id="sessions" class="secondary" title="Past conversations in this folder; open one in a new tab">☰ Conversations</button>
    <button id="conversation" class="secondary toggle" aria-pressed="false" title="Auto-listen: after Claude finishes speaking, the mic opens for your answer and a pause sends it">🎧 Auto-listen</button>
    <button id="speak" class="secondary toggle" aria-pressed="false" title="Speak Claude's replies aloud">🔊 Speak replies</button>
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
    for (const tab of this.tabs.values()) tab.dispose();
    this.tabs.clear();
    this.voice?.dispose();
    this.editor.dispose();
    this.tracker.dispose();
    this.diffs.dispose();
  }
}

