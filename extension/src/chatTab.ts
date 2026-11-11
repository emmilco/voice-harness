import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  AgentSession,
  BillingGuardError,
  SPEECH_LAYER,
  SpeechChunker,
  StepSequencer,
  editorContextLabel,
  formatEditorContext,
  parseDataFile,
  type Attachment,
  type ConfigOption,
  type ExplainStep,
  type Figure,
  type LiveChart,
  type PermissionRequest,
} from "@voice-harness/core";
import type { EditorControl } from "./editorControl";
import type { EditorTracker } from "./editorTracker";
import type { SessionState, TabMessage, TabRequest, TabSummary } from "./protocol";

/** A TabMessage without its tab id (the tab adds it). */
type TabPayload = TabMessage extends infer M ? (M extends unknown ? Omit<M, "tabId"> : never) : never;

type Image = { mimeType: string; data: string };
type FigureResult = { ok: true } | { ok: false; error: string };

/** What a tab needs from the panel it lives in. */
export interface TabServices {
  readonly workspace: string;
  readonly output: vscode.OutputChannel;
  readonly editor: EditorControl;
  readonly tracker: EditorTracker;
  /** Paths needed to start an agent, or what is missing. */
  agentPaths(): { nodePath: string; claudePath: string; agentEntry: string; mcpServerScript: string } | { missing: string[] };
  post(message: TabMessage): void;
  isActive(tab: ChatTab): boolean;
  /** Speaks the sentences if this tab is the visible one and speech is on; `ref` names the bubble they belong to. */
  speak(tab: ChatTab, sentences: string[], ref?: string): void;
  /** A permission request arrived in this tab. */
  approvalRequested(tab: ChatTab): void;
  /** Applies an editor effect when speech reaches this point (visible tab only; dropped otherwise). */
  inStepWithSpeech(tab: ChatTab, effect: () => void): void;
  /** Stops speech belonging to this tab. */
  silence(tab: ChatTab): void;
  /** A turn finished normally; the panel may listen for a spoken reply. */
  turnFinished(tab: ChatTab): void;
  /** The tab's label, activity or attention state changed. */
  changed(tab: ChatTab): void;
}

/**
 * One conversation in the panel: its agent session, transcript, queue, permissions, figures and
 * rewind points. Only the visible tab speaks or moves the editor; background tabs keep working.
 */
export class ChatTab {
  readonly id = randomBytes(6).toString("hex");
  private session: AgentSession | undefined;
  private state: SessionState = "starting";
  private title: string | undefined;
  /** The project folder (first path segment under the workspace) this conversation last worked in. */
  private project: string | undefined;
  unread = false;
  private readonly chunker = new SpeechChunker();
  private readonly steps = new StepSequencer<ExplainStep>((step) => this.presentStep(step));
  /** True while a loaded session's history is replayed: shown, not spoken, no editor effects. */
  private replaying = false;
  private replayUser = "";
  /** True from a cancel until the next turn starts: the cancelled turn's speech is dropped. */
  private suppressSpeech = false;
  private turn: Promise<void> | null = null;
  /**
   * Bumped whenever a turn is superseded (a new send, a restart, a rewind). A turn's cleanup
   * acts only if the generation it started under is still current, so a cancelled turn
   * cannot dequeue the next message under the one that replaced it, or report errors into a
   * transcript that has since been cleared.
   */
  private generation = 0;
  private readonly queue: { id: string; text: string; images: Image[] }[] = [];
  private readonly pendingPermissions = new Map<string, (optionId: string | null) => void>();
  private readonly pendingFigures = new Map<string, (result: { ok: boolean; error?: string }) => void>();
  private readonly liveCharts = new Map<string, ReturnType<typeof setInterval>>();
  /** The user's messages in order, each with the assistant message just before it (its rewind point). */
  private turns: { text: string; before?: string }[] = [];
  private lastAssistantId: string | undefined;
  /** The bubble agent text currently flows into; cleared when a tool call, step or turn end splits the reply. */
  private segment: string | undefined;
  private segmentCount = 0;
  private stepCount = 0;
  private disposed = false;

  constructor(private readonly services: TabServices) {}

  // MARK: State for the panel

  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  get agent(): AgentSession | undefined {
    return this.session;
  }

  get busy(): boolean {
    return this.turn !== null;
  }

  /** Idle, with nothing queued: a reply may be listened for. */
  get quiet(): boolean {
    return this.turn === null && this.queue.length === 0;
  }

  get displayTitle(): string | undefined {
    return this.title;
  }

  summary(): TabSummary {
    const title = this.title ?? (this.state === "starting" ? "Starting…" : "New conversation");
    return {
      id: this.id,
      label: this.project ? `${this.project} · ${title}` : title,
      project: this.project,
      title,
      busy: this.busy,
      unread: this.unread,
      needsApproval: this.pendingPermissions.size > 0,
    };
  }

  private post(message: TabPayload): void {
    if (!this.disposed) this.services.post({ ...message, tabId: this.id } as TabMessage);
  }

  private setState(state: SessionState, detail?: string): void {
    this.state = state;
    this.post({ type: "state", state, detail });
    this.services.changed(this);
  }

  /** Marks background output so the tab strip can show a dot. */
  private noteOutput(): void {
    if (this.services.isActive(this) || this.unread) return;
    this.unread = true;
    this.services.changed(this);
  }

  // MARK: Requests from the webview

  async handle(m: TabRequest): Promise<void> {
    switch (m.type) {
      case "send":
        if (this.turn) this.enqueue(m.text, m.images ?? []);
        else await this.send(m.text, false, m.images ?? []);
        break;
      case "unqueue":
        this.removeQueued(m.id);
        break;
      case "sendNow": {
        const item = this.removeQueued(m.id);
        if (item) await this.send(item.text, false, item.images);
        break;
      }
      case "stop":
        this.stop();
        break;
      case "restart":
        this.post({ type: "clear" });
        await this.start();
        break;
      case "permission":
        this.pendingPermissions.get(m.requestId)?.(m.optionId);
        break;
      case "figureResult":
        this.pendingFigures.get(m.id)?.({ ok: m.ok, error: m.error });
        break;
      case "setOption":
        try {
          await this.session?.setConfigOption(m.id, m.value);
        } catch (err) {
          this.post({ type: "notice", text: `Could not change ${m.id}: ${(err as Error).message}` });
          if (this.session) this.postOptions(this.session.configOptions);
        }
        break;
      case "rewind":
        await this.rewind(m.turn);
        break;
      case "showStep":
        if (this.services.isActive(this)) void this.services.editor.showCode({ path: m.path, startLine: m.startLine, endLine: m.endLine });
        break;
    }
  }

  // MARK: Agent session

  /** Starts a new agent session, or loads (and replays) a past one. */
  async start(loadSessionId?: string): Promise<void> {
    this.generation++;
    const old = this.turn;
    this.session?.cancel();
    this.session?.dispose();
    this.session = undefined;
    this.turn = null;
    if (old) await old.catch(() => {});
    this.silence();
    this.resolveAllPermissions();
    this.clearQueue();
    this.stopLiveCharts();
    this.turns = [];
    this.lastAssistantId = undefined;
    this.title = undefined;
    this.setState("starting", loadSessionId ? "Loading conversation…" : "Starting Claude…");

    const paths = this.services.agentPaths();
    if ("missing" in paths) {
      this.setState("error", `Cannot start — missing: ${paths.missing.join("; ")}`);
      return;
    }
    this.replaying = !!loadSessionId;
    this.replayUser = "";
    try {
      this.session = await AgentSession.start({
        workspace: this.services.workspace,
        ...paths,
        systemPromptAppend: SPEECH_LAYER,
        loadSessionId,
        handlers: {
          onConfigOptions: (options) => this.postOptions(options),
          onUsage: (usage) => this.post({ type: "usage", used: usage.used, size: usage.size }),
          onTitle: (title) => this.setTitle(title),
          onCommands: (commands) => this.post({ type: "commands", commands }),
          onText: (chunk, messageId) => {
            this.flushReplayedUser();
            if (messageId) this.lastAssistantId = messageId;
            this.segment ??= `s${++this.segmentCount}`;
            this.post({ type: "agentText", chunk, segment: this.segment });
            if (!this.replaying) {
              this.noteOutput();
              this.speak(this.chunker.push(chunk), this.segment);
            }
          },
          onUserText: (chunk) => {
            if (this.replaying) this.replayUser += chunk;
          },
          onToolCall: (t, isUpdate) => {
            this.flushReplayedUser();
            this.post({
              type: "tool",
              id: t.id,
              title: t.title,
              kind: t.kind,
              status: t.status,
              name: t.name,
              content: t.content,
              hidden: t.name?.startsWith("mcp__harness__"),
              isUpdate,
            });
            if (t.locations.length) this.noteProject(t.locations[0].path);
            // Display tools keep the bubble but speak what came before them first, so their highlight follows it.
            if (!isUpdate) {
              if (t.name?.startsWith("mcp__harness__")) this.speak(this.chunker.flush(), this.segment);
              else this.endSegment();
            }
            if (this.replaying) return;
            if (!isUpdate && t.locations.length && (t.kind === "read" || t.kind === "edit") && this.services.isActive(this)) {
              void this.services.editor.follow(t.locations);
            }
          },
          onPermission: (req, signal) => this.askPermission(req, signal),
          onShowCode: async (range) => {
            this.noteProject(range.path);
            this.services.inStepWithSpeech(this, () => void this.services.editor.showCode(range));
          },
          onExplainCode: async (step) => {
            this.noteProject(step.range.path);
            this.steps.push(step, step.step);
          },
          onClearHighlight: async () => this.services.inStepWithSpeech(this, () => this.services.editor.clearHighlight()),
          onShowFigure: (figure) => this.showFigure(figure),
          onShowLiveChart: (chart) => this.showLiveChart(chart),
          onLog: (line) => this.services.output.appendLine(line),
          onExit: (reason) => {
            this.session = undefined;
            this.resolveAllPermissions();
            this.clearQueue();
            this.setState("stopped", `${reason}. Use Restart to begin a new session.`);
          },
        },
      });
      this.flushReplayedUser();
      this.services.output.appendLine(`session ${this.session.sessionId} (${this.session.loginSummary}) in ${this.services.workspace}`);
      if (loadSessionId) this.post({ type: "notice", text: "Conversation restored. New messages continue it." });
      this.setState("ready", this.session.loginSummary);
    } catch (err) {
      const detail = err instanceof BillingGuardError ? `Billing guard: ${err.problems.join("; ")}` : (err as Error).message;
      this.services.output.appendLine(`start failed: ${detail}`);
      this.setState("error", detail);
    } finally {
      this.replaying = false;
    }
  }

  /** Starts a user turn, cancelling (and silencing) any turn still running. */
  async send(text: string, spoken: boolean, images: Image[] = []): Promise<void> {
    if (!this.session) return;
    this.silence();
    if (this.turn) {
      this.generation++;
      this.session.cancel();
      await this.turn;
    }
    const session = this.session;
    if (!session) return;
    this.suppressSpeech = false;
    // A slash command must start the message, so it is sent without editor context.
    const context =
      !text.startsWith("/") && vscode.workspace.getConfiguration("voiceHarness").get<boolean>("sendEditorContext", true)
        ? this.services.tracker.current()
        : undefined;
    const prompt = context ? `${formatEditorContext(context)}\n\n${text}` : text;
    const attachments: Attachment[] = [...this.mentionedFiles(text), ...images.map((i) => ({ kind: "image" as const, ...i }))];
    this.turns.push({ text, before: this.lastAssistantId });
    this.post({
      type: "user",
      text,
      spoken,
      context: context ? editorContextLabel(context) : undefined,
      attachments: attachments.map((a) => (a.kind === "file" ? path.relative(this.services.workspace, a.path) : "pasted image")),
      turn: this.turns.length - 1,
    });
    this.setState("busy");
    const generation = this.generation;
    // `turn` is read in `finally`, which always runs after this assignment completes.
    let turn!: Promise<void>;
    turn = (async () => {
      let finishedNormally = false;
      try {
        const stopReason = await session.prompt(prompt, attachments);
        if (generation !== this.generation) return;
        this.endSegment();
        this.post({ type: "turnEnd", stopReason });
        finishedNormally = stopReason === "end_turn" && !this.suppressSpeech;
      } catch (err) {
        if (generation === this.generation) this.post({ type: "error", text: (err as Error).message });
      } finally {
        if (this.turn === turn) this.turn = null;
        // A superseded turn leaves state to whatever replaced it.
        if (generation === this.generation) {
          this.setState(this.session ? "ready" : "stopped", this.session?.loginSummary);
          this.noteOutput();
          if (this.turn === null && this.queue.length) {
            const next = this.queue.shift()!;
            this.post({ type: "dequeued", id: next.id });
            setTimeout(() => void this.send(next.text, false, next.images), 0);
          } else if (finishedNormally) {
            this.services.turnFinished(this);
          }
        }
      }
    })();
    this.turn = turn;
    await turn;
  }

  stop(): void {
    this.clearQueue();
    this.silence();
    this.session?.cancel();
  }

  private clearQueue(): void {
    for (const q of this.queue.splice(0)) this.post({ type: "dequeued", id: q.id });
  }

  private stopLiveCharts(): void {
    for (const timer of this.liveCharts.values()) clearInterval(timer);
    this.liveCharts.clear();
  }

  /** Drops this tab's speech for the rest of the current turn. */
  silence(): void {
    this.suppressSpeech = true;
    this.steps.reset();
    this.chunker.reset();
    this.services.silence(this);
  }

  private speak(sentences: string[], ref?: string): void {
    if (this.suppressSpeech || this.replaying) return;
    this.services.speak(this, sentences, ref);
  }

  /** Ends the current text bubble: its unfinished sentence is spoken and later text starts a new one. */
  private endSegment(): void {
    this.speak(this.chunker.flush(), this.segment);
    this.segment = undefined;
  }

  // MARK: Rewind

  /**
   * Rolls the conversation back to just before the user's message number `index`: the agent
   * session is forked at the assistant message before it (or restarted, for the first message),
   * the shortened conversation is replayed, and the message's text goes back in the input box.
   */
  private async rewind(index: number): Promise<void> {
    const target = this.turns[index];
    if (!target || !this.session) return;
    this.generation++;
    this.stop();
    if (this.turn) await this.turn.catch(() => {});
    this.stopLiveCharts();
    this.post({ type: "clear" });
    if (!target.before) {
      await this.start();
    } else {
      const session = this.session;
      this.setState("starting", "Rewinding…");
      this.turns = [];
      this.lastAssistantId = undefined;
      this.replaying = true;
      this.replayUser = "";
      try {
        await session.load(await session.forkAt(target.before));
        this.flushReplayedUser();
        this.setState("ready", session.loginSummary);
      } catch (err) {
        this.post({ type: "error", text: `Could not rewind: ${(err as Error).message}` });
        this.setState("ready", session.loginSummary);
      } finally {
        this.replaying = false;
      }
    }
    this.post({ type: "prefill", text: target.text });
  }

  private flushReplayedUser(): void {
    if (!this.replayUser) return;
    const text = withoutEditorContext(this.replayUser).trim();
    this.replayUser = "";
    if (!text) return;
    this.turns.push({ text, before: this.lastAssistantId });
    this.post({ type: "user", text, spoken: false, turn: this.turns.length - 1 });
  }

  // MARK: Labels and settings

  /** Settings shown in the session bar, in this order; others the agent offers are not shown. */
  private static readonly SHOWN_OPTIONS = ["model", "mode", "effort", "fast"];
  /** Never offered in the mode picker (the user's AI security protocol rules it out). */
  private static readonly HIDDEN_CHOICES = new Set(["bypassPermissions"]);

  private postOptions(options: ConfigOption[]): void {
    const shown = ChatTab.SHOWN_OPTIONS.flatMap((id) => {
      const o = options.find((x) => x.id === id);
      if (!o) return [];
      return [{ ...o, choices: o.choices.filter((c) => !ChatTab.HIDDEN_CHOICES.has(c.value) || c.value === o.current) }];
    });
    this.post({ type: "options", options: shown });
  }

  private setTitle(title: string): void {
    const clean = withoutEditorContext(title).trim();
    if (!clean) return;
    this.title = clean;
    this.post({ type: "title", title: clean });
    this.services.changed(this);
  }

  /** Remembers which project folder (under the workspace) the conversation is working in. */
  private noteProject(file: string): void {
    const relative = path.relative(this.services.workspace, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return;
    const first = relative.split(path.sep)[0];
    // Hidden folders (.claude, .git, .vscode) hold tooling, not projects.
    if (!first || first === relative || first.startsWith(".")) return;
    if (first !== this.project) {
      this.project = first;
      this.services.changed(this);
    }
  }

  // MARK: Queue and attachments

  private enqueue(text: string, images: Image[]): void {
    const id = randomBytes(6).toString("hex");
    this.queue.push({ id, text, images });
    this.post({ type: "queued", id, text, images: images.length });
  }

  private removeQueued(id: string): { id: string; text: string; images: Image[] } | undefined {
    const index = this.queue.findIndex((q) => q.id === id);
    if (index < 0) return undefined;
    const [item] = this.queue.splice(index, 1);
    this.post({ type: "dequeued", id });
    return item;
  }

  /** Files named with @path in a message that exist inside the workspace. */
  private mentionedFiles(text: string): Attachment[] {
    const out: Attachment[] = [];
    const root = this.services.workspace;
    for (const m of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
      const file = path.resolve(root, m[1].replace(/[.,;:!?)]+$/, ""));
      if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) continue;
      if (!out.some((a) => a.kind === "file" && a.path === file)) out.push({ kind: "file", path: file });
    }
    return out;
  }

  // MARK: Walkthrough steps

  /** One walkthrough step: its words in the chat, its highlight as speech reaches it, then its words spoken. */
  private presentStep(step: ExplainStep): void {
    this.endSegment();
    const ref = `step${++this.stepCount}`;
    this.post({
      type: "step",
      ref,
      path: step.range.path,
      file: path.relative(this.services.workspace, step.range.path),
      startLine: step.range.startLine,
      endLine: step.range.endLine,
      text: step.say,
    });
    this.services.inStepWithSpeech(this, () => void this.services.editor.showCode(step.range));
    const words = new SpeechChunker();
    this.speak([...words.push(step.say + "\n"), ...words.flush()], ref);
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

  private async showFigure(figure: Figure): Promise<FigureResult> {
    return (await this.sendFigure(figure, false)).result;
  }

  private async showLiveChart(chart: LiveChart): Promise<FigureResult> {
    const { id, result } = await this.sendFigure({ kind: "vega-lite", content: chart.spec, caption: chart.caption }, true);
    if (result.ok) this.followDataFile(id, chart.dataFile);
    return result;
  }

  /** Re-reads the data file whenever its size or modification time changes, about once a second. */
  private followDataFile(id: string, file: string): void {
    if (this.liveCharts.size >= ChatTab.MAX_LIVE_CHARTS) {
      const [oldest, timer] = this.liveCharts.entries().next().value!;
      clearInterval(timer);
      this.liveCharts.delete(oldest);
      this.post({ type: "figureStopped", id: oldest });
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
        this.post({ type: "figureData", id, rows: parseDataFile(file, readTail(file, ChatTab.MAX_LIVE_READ_BYTES)) });
      } catch (err) {
        this.services.output.appendLine(`live chart: could not read ${file}: ${(err as Error).message}`);
      }
    };
    tick();
    this.liveCharts.set(id, setInterval(tick, 1000));
  }

  /** Sends a figure to the webview and waits (up to 10 s) for it to report whether it rendered. */
  private async sendFigure(figure: Figure, live: boolean): Promise<{ id: string; result: FigureResult }> {
    let content = figure.content;
    if (figure.kind === "image") {
      const type = ChatTab.IMAGE_TYPES[path.extname(figure.content).toLowerCase()];
      const fail = (error: string) => ({ id: "", result: { ok: false as const, error } });
      if (!type) return fail("unsupported image type");
      if (!existsSync(figure.content)) return fail(`no such file: ${figure.content}`);
      if (statSync(figure.content).size > ChatTab.MAX_IMAGE_BYTES) return fail("image is larger than 15 MB");
      content = `data:${type};base64,${readFileSync(figure.content).toString("base64")}`;
    }
    this.noteOutput();
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
        this.services.changed(this);
        resolve(optionId);
      };
      this.pendingPermissions.set(requestId, finish);
      signal.addEventListener("abort", () => finish(null), { once: true });
      this.endSegment();
      this.post({ type: "permission", requestId, title: req.title, kind: req.kind, content: req.content, options: req.options });
      this.services.changed(this);
      this.services.approvalRequested(this);
    });
  }

  private resolveAllPermissions(): void {
    for (const finish of [...this.pendingPermissions.values()]) finish(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.resolveAllPermissions();
    for (const finish of [...this.pendingFigures.values()]) finish({ ok: false, error: "the tab was closed" });
    this.stopLiveCharts();
    this.silence();
    this.disposed = true;
    this.session?.dispose();
  }
}

export function withoutEditorContext(text: string): string {
  return text.replace(/<editor-context>[\s\S]*?<\/editor-context>\s*/g, "");
}

/** The file's text, or only its last `maxBytes` (from a line start) when it is large. */
function readTail(file: string, maxBytes: number): string {
  const size = statSync(file).size;
  if (size <= maxBytes) return readFileSync(file, "utf8");
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    const text = buffer.toString("utf8");
    return text.slice(text.indexOf("\n") + 1);
  } finally {
    closeSync(fd);
  }
}
