import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";
import { PROTOCOL_VERSION, client as acpClient, methods, ndJsonStream } from "@agentclientprotocol/sdk/unstable";
import { checkBilling } from "./billingGuard";
import { startRelay, type FigureKind, type Relay, type RelayReply, type RelayRequest } from "./relay";

export interface Location {
  path: string;
  line?: number;
}

/** What a tool call reports: text (descriptions, output as markdown) or a file diff. */
export type ToolContent =
  | { kind: "text"; text: string }
  | { kind: "diff"; path: string; oldText: string | null; newText: string };

export interface ToolCallInfo {
  id: string;
  /** The agent's tool name (e.g. Bash, Edit, mcp__harness__show_code), when reported. */
  name?: string;
  /** Latest reported content; replaces earlier content when present. */
  content?: ToolContent[];
  title?: string;
  kind?: string;
  status?: string;
  locations: Location[];
  /** The tool's input as the agent reported it, when available. */
  rawInput?: unknown;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PermissionRequest {
  title: string;
  kind?: string;
  /** What the call would do: the command's description, or the diff of an edit. */
  content?: ToolContent[];
  options: PermissionOption[];
}

/** A figure for the front end to render. For `image`, `content` is an absolute file path inside the workspace. */
export interface Figure {
  kind: FigureKind;
  content: string;
  caption?: string;
}

export interface CodeRange {
  path: string;
  startLine: number;
  endLine: number;
}

/** A Vega-Lite chart whose dataset named "live" follows a metrics file as it grows. */
export interface LiveChart {
  spec: string;
  /** Absolute path inside the workspace; may not exist yet. */
  dataFile: string;
  caption?: string;
}

/** One step of a walkthrough: a small range of code and the words that go with it. */
export interface ExplainStep {
  range: CodeRange;
  say: string;
  /** 1-based position in the walkthrough, when the agent numbered its steps. */
  step?: number;
}

/** Callbacks through which a front end (VS Code, a test script) presents the session. */
/** Something attached to a user turn besides its text. */
export type Attachment =
  | { kind: "file"; path: string }
  | { kind: "image"; mimeType: string; data: string };

/** A session setting the agent offers (model, mode, effort…), with its current value. */
export interface ConfigOption {
  id: string;
  name: string;
  current: string;
  choices: { value: string; name: string; description?: string }[];
}

/** A past conversation that can be loaded. */
export interface SessionSummary {
  id: string;
  title?: string;
  /** ISO 8601 time of the last activity, when known. */
  updatedAt?: string;
}

export interface SessionHandlers {
  /** Agent text; `messageId` identifies the assistant message it belongs to (a rewind point). */
  onText(chunk: string, messageId?: string): void;
  /** Text of a user message, reported while a loaded session's history is replayed. */
  onUserText?(chunk: string): void;
  /** The session's settings, whenever they are first known or change. */
  onConfigOptions?(options: ConfigOption[]): void;
  /** Context window use, in tokens. */
  onUsage?(usage: { used: number; size: number }): void;
  /** The conversation's title, when the agent sets or changes it. */
  onTitle?(title: string): void;
  /** The agent's task checklist (full list each time); empty when it is cleared. */
  onPlan?(entries: { content: string; status: string; priority?: string }[]): void;
  /** Slash commands (and skills) the agent accepts at the start of a message. */
  onCommands?(commands: { name: string; description: string; hint?: string }[]): void;
  /** A new tool call (`isUpdate` false) or a change to one already reported. */
  onToolCall(info: ToolCallInfo, isUpdate: boolean): void;
  /** Resolve with the chosen optionId, or null to cancel. `signal` aborts when the turn is cancelled. */
  onPermission(req: PermissionRequest, signal: AbortSignal): Promise<string | null>;
  onShowCode(range: CodeRange): Promise<void>;
  /** Show the step's words, speak them, and highlight its range as they begin. */
  onExplainCode(step: ExplainStep): Promise<void>;
  onClearHighlight(): Promise<void>;
  /** Render a figure; resolve with an error message if it could not be rendered. */
  onShowFigure(figure: Figure): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Render a live chart and keep its data in step with the file; resolve with an error if it cannot render. */
  onShowLiveChart(chart: LiveChart): Promise<{ ok: true } | { ok: false; error: string }>;
  onLog(line: string): void;
  /** The agent process ended. */
  onExit(reason: string): void;
}

export interface SessionOptions {
  /** Absolute path of the folder the agent works in. */
  workspace: string;
  /** Absolute path of the node binary used for the agent and the MCP server. */
  nodePath: string;
  /** Absolute path of the claude CLI the adapter drives. */
  claudePath: string;
  /** Absolute path of claude-agent-acp's dist/index.js. */
  agentEntry: string;
  /** Absolute path of the bundled MCP display-tool server. */
  mcpServerScript: string;
  /** Text appended to Claude Code's standard system prompt. */
  systemPromptAppend: string;
  handlers: SessionHandlers;
  /** Load (and replay) this past session instead of starting a new one. */
  loadSessionId?: string;
}

export class BillingGuardError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Refusing to start: ${problems.join("; ")}`);
  }
}

type AgentConnection = ReturnType<ReturnType<typeof acpClient>["connect"]>;
type McpServers = { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[];
type SystemPromptParam = { mode: "append"; content: { type: "text"; text: string }[] };

/**
 * One ACP session with claude-agent-acp, on the claude.ai subscription, with the
 * harness display tools attached.
 */
export class AgentSession {
  private turnAbort: AbortController | null = null;
  private disposed = false;
  private options: ConfigOption[] = [];
  private handlers!: SessionHandlers;

  private constructor(
    private readonly child: ChildProcess,
    private readonly connection: AgentConnection,
    private readonly relay: Relay,
    private readonly sessionSetup: { cwd: string; mcpServers: McpServers; systemPrompt: SystemPromptParam },
    private currentSessionId: string,
    readonly loginSummary: string,
  ) {}

  get sessionId(): string {
    return this.currentSessionId;
  }

  static async start(opts: SessionOptions): Promise<AgentSession> {
    const { handlers } = opts;
    const billing = checkBilling(opts.claudePath, opts.workspace);
    if (!billing.ok) throw new BillingGuardError(billing.problems);

    const relay = await startRelay(async (req: RelayRequest): Promise<RelayReply> => {
      switch (req.tool) {
        case "show_code":
          await handlers.onShowCode({ path: req.path, startLine: req.start_line, endLine: req.end_line });
          return { ok: true };
        case "clear_highlight":
          await handlers.onClearHighlight();
          return { ok: true };
        case "show_figure":
          return handlers.onShowFigure({ kind: req.kind, content: req.content, caption: req.caption });
        case "show_live_chart":
          return handlers.onShowLiveChart({ spec: req.spec, dataFile: req.data_file, caption: req.caption });
        case "explain_code":
          await handlers.onExplainCode({
            range: { path: req.path, startLine: req.start_line, endLine: req.end_line },
            say: req.say,
            step: req.step,
          });
          return { ok: true };
      }
    });

    const child = spawn(opts.nodePath, [opts.agentEntry], {
      cwd: opts.workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${path.dirname(opts.nodePath)}:${process.env.PATH ?? ""}`,
        CLAUDE_CODE_EXECUTABLE: opts.claudePath,
      },
    });
    child.stderr?.on("data", (d: Buffer) => handlers.onLog(d.toString().trimEnd()));
    child.stdin?.on("error", () => {});
    let session: AgentSession | undefined;
    child.on("exit", (code, signal) => {
      relay.close();
      if (!session?.disposed) handlers.onExit(`agent exited (code ${code}, signal ${signal})`);
    });

    const connection = acpClient({ name: "voice-harness" })
      .onNotification(methods.client.session.update, (ctx) => {
        const u = ctx.params.update;
        switch (u.sessionUpdate) {
          case "agent_message_chunk":
            if (u.content.type === "text") handlers.onText(u.content.text, u.messageId ?? undefined);
            break;
          case "user_message_chunk":
            if (u.content.type === "text") handlers.onUserText?.(u.content.text);
            break;
          case "config_option_update":
            session?.setOptions(u.configOptions);
            break;
          case "current_mode_update":
            session?.setCurrent("mode", u.currentModeId);
            break;
          case "usage_update":
            handlers.onUsage?.({ used: u.used, size: u.size });
            break;
          case "session_info_update":
            if (u.title) handlers.onTitle?.(u.title);
            break;
          case "plan":
            handlers.onPlan?.(u.entries.map((e) => ({ content: e.content, status: e.status, priority: e.priority ?? undefined })));
            break;
          case "plan_removed":
            handlers.onPlan?.([]);
            break;
          case "available_commands_update":
            handlers.onCommands?.(
              u.availableCommands.map((c) => ({
                name: c.name,
                description: c.description,
                hint: (c.input as { hint?: string } | null | undefined)?.hint ?? undefined,
              })),
            );
            break;
          case "tool_call":
            handlers.onToolCall(
              {
                id: u.toolCallId,
                name: toolName(u),
                content: toContent(u.content),
                title: u.title,
                kind: u.kind ?? undefined,
                status: u.status ?? undefined,
                locations: toLocations(u.locations),
                rawInput: u.rawInput ?? undefined,
              },
              false,
            );
            break;
          case "tool_call_update":
            handlers.onToolCall(
              {
                id: u.toolCallId,
                name: toolName(u),
                content: toContent(u.content),
                title: u.title ?? undefined,
                kind: u.kind ?? undefined,
                status: u.status ?? undefined,
                locations: toLocations(u.locations),
                rawInput: u.rawInput ?? undefined,
              },
              true,
            );
            break;
        }
      })
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        const { toolCall, options } = ctx.params;
        const signal = session?.turnAbort?.signal ?? new AbortController().signal;
        const chosen = await handlers.onPermission(
          {
            title: toolCall.title ?? "Tool call",
            kind: toolCall.kind ?? undefined,
            content: toContent(toolCall.content),
            options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
          },
          signal,
        );
        return chosen
          ? { outcome: { outcome: "selected" as const, optionId: chosen } }
          : { outcome: { outcome: "cancelled" as const } };
      })
      .connect(ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>));

    try {
      const agent = connection.agent;
      await agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const setup = {
        cwd: opts.workspace,
        mcpServers: [
          {
            name: "harness",
            command: opts.nodePath,
            args: [opts.mcpServerScript],
            env: [
              { name: "VH_SOCKET", value: relay.socketPath },
              { name: "VH_WORKSPACE", value: opts.workspace },
            ],
          },
        ],
        systemPrompt: { mode: "append" as const, content: [{ type: "text" as const, text: opts.systemPromptAppend }] },
      };
      let sessionId: string;
      let configOptions: unknown;
      if (opts.loadSessionId) {
        const loaded = (await agent.request(methods.agent.session.load, { ...setup, sessionId: opts.loadSessionId })) as { configOptions?: unknown };
        sessionId = opts.loadSessionId;
        configOptions = loaded.configOptions;
      } else {
        const created = (await agent.request(methods.agent.session.new, { ...setup })) as { sessionId: string; configOptions?: unknown };
        sessionId = created.sessionId;
        configOptions = created.configOptions;
      }
      session = new AgentSession(child, connection, relay, setup, sessionId, billing.summary);
      session.handlers = handlers;
      session.setOptions(configOptions);
      return session;
    } catch (err) {
      child.kill("SIGTERM");
      relay.close();
      throw err;
    }
  }

  /** The session's settings as last reported. */
  get configOptions(): ConfigOption[] {
    return this.options;
  }

  /** Changes a session setting (e.g. "model", "mode", "effort"). */
  async setConfigOption(configId: string, value: string): Promise<void> {
    const res = (await this.connection.agent.request(methods.agent.session.setConfigOption, {
      sessionId: this.currentSessionId,
      configId,
      value,
    } as never)) as { configOptions?: unknown };
    if (res?.configOptions) this.setOptions(res.configOptions);
    else this.setCurrent(configId, value);
  }

  private setOptions(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    this.options = raw.map(toConfigOption).filter((o): o is ConfigOption => o !== undefined);
    this.handlers.onConfigOptions?.(this.options);
  }

  private setCurrent(id: string, value: string): void {
    const option = this.options.find((o) => o.id === id);
    if (!option) return;
    option.current = value;
    this.handlers.onConfigOptions?.(this.options);
  }

  /** This folder's past sessions, most recently active first (up to `limit`). */
  async list(limit = 50): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.connection.agent.request(methods.agent.session.list, { cwd: this.sessionSetup.cwd, cursor });
      for (const s of page.sessions) out.push({ id: s.sessionId, title: s.title ?? undefined, updatedAt: s.updatedAt ?? undefined });
      cursor = page.nextCursor ?? undefined;
    } while (cursor && out.length < limit);
    return out
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, limit);
  }

  /**
   * Creates a copy of this conversation that ends with the assistant message `messageId`
   * (claude-agent-acp's fork-point extension); returns the new session's id. Load it to continue.
   */
  async forkAt(messageId: string): Promise<string> {
    const forked = (await this.connection.agent.request(methods.agent.session.fork, {
      ...this.sessionSetup,
      sessionId: this.currentSessionId,
      _meta: { jetbrains: { air: { fork: { version: 1, messageId } } } },
    } as never)) as { sessionId: string };
    return forked.sessionId;
  }

  /** Switches to a past session; its history is replayed through the handlers before this resolves. */
  async load(sessionId: string): Promise<void> {
    if (this.turnAbort) this.cancel();
    const loaded = (await this.connection.agent.request(methods.agent.session.load, { ...this.sessionSetup, sessionId })) as {
      configOptions?: unknown;
    };
    this.currentSessionId = sessionId;
    this.setOptions(loaded?.configOptions);
  }

  /** Sends one user turn (text plus any attached files or images); resolves with the stop reason when the turn ends. */
  async prompt(text: string, attachments: Attachment[] = []): Promise<string> {
    this.turnAbort = new AbortController();
    const blocks = [
      { type: "text" as const, text },
      ...attachments.map((a) => (a.kind === "file" ? fileBlock(a.path) : { type: "image" as const, mimeType: a.mimeType, data: a.data })),
    ];
    try {
      const result = (await this.connection.agent.request(methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: blocks,
      })) as { stopReason: string };
      return result.stopReason;
    } finally {
      this.turnAbort = null;
    }
  }

  /** Cancels the running turn; any pending permission request resolves as cancelled. */
  cancel(): void {
    this.turnAbort?.abort();
    void this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.turnAbort?.abort();
    this.child.kill("SIGTERM");
    this.relay.close();
  }
}

const MAX_EMBEDDED_FILE_BYTES = 256 * 1024;

/**
 * A mentioned file as a prompt block: small text files are embedded with their contents (as
 * Claude Code's own @-mentions do); large or binary files are linked, for the agent to read.
 */
function fileBlock(file: string) {
  const uri = pathToFileURL(file).href;
  const link = { type: "resource_link" as const, uri, name: path.basename(file) };
  try {
    if (statSync(file).size > MAX_EMBEDDED_FILE_BYTES) return link;
    const bytes = readFileSync(file);
    if (bytes.includes(0)) return link;
    return { type: "resource" as const, resource: { uri, text: bytes.toString("utf8"), mimeType: "text/plain" } };
  } catch {
    return link;
  }
}

/** A select-type setting with its choices flattened (grouped choices lose their headers). */
function toConfigOption(raw: unknown): ConfigOption | undefined {
  const o = raw as { id?: string; name?: string; currentValue?: string; options?: unknown[] };
  if (typeof o?.id !== "string" || typeof o.currentValue !== "string" || !Array.isArray(o.options)) return undefined;
  const choices: ConfigOption["choices"] = [];
  for (const item of o.options as { value?: string; name?: string; description?: string | null; options?: unknown[] }[]) {
    if (Array.isArray(item.options)) {
      for (const sub of item.options as { value?: string; name?: string; description?: string | null }[]) {
        if (typeof sub.value === "string") choices.push({ value: sub.value, name: sub.name ?? sub.value, description: sub.description ?? undefined });
      }
    } else if (typeof item.value === "string") {
      choices.push({ value: item.value, name: item.name ?? item.value, description: item.description ?? undefined });
    }
  }
  return { id: o.id, name: o.name ?? o.id, current: o.currentValue, choices };
}

/** Tool content in a front-end friendly form; undefined when the update carries none. */
function toContent(content: ReadonlyArray<unknown> | null | undefined): ToolContent[] | undefined {
  if (!content || content.length === 0) return undefined;
  const out: ToolContent[] = [];
  for (const raw of content) {
    const c = raw as { type?: string; content?: { type?: string; text?: string }; path?: string; oldText?: string | null; newText?: string };
    if (c.type === "content" && c.content?.type === "text" && typeof c.content.text === "string") {
      out.push({ kind: "text", text: c.content.text });
    } else if (c.type === "diff" && typeof c.path === "string" && typeof c.newText === "string") {
      out.push({ kind: "diff", path: c.path, oldText: c.oldText ?? null, newText: c.newText });
    }
  }
  return out;
}

function toolName(update: unknown): string | undefined {
  const u = update as { name?: string; _meta?: { claudeCode?: { toolName?: string } } };
  return u.name ?? u._meta?.claudeCode?.toolName;
}

function toLocations(locations: ReadonlyArray<{ path: string; line?: number | null }> | null | undefined): Location[] {
  return (locations ?? []).map((l) => ({ path: l.path, line: l.line ?? undefined }));
}
