import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { PROTOCOL_VERSION, client as acpClient, methods, ndJsonStream } from "@agentclientprotocol/sdk/unstable";
import { checkBilling } from "./billingGuard";
import { startRelay, type FigureKind, type Relay, type RelayReply, type RelayRequest } from "./relay";

export interface Location {
  path: string;
  line?: number;
}

export interface ToolCallInfo {
  id: string;
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
/** A past conversation that can be loaded. */
export interface SessionSummary {
  id: string;
  title?: string;
  /** ISO 8601 time of the last activity, when known. */
  updatedAt?: string;
}

export interface SessionHandlers {
  onText(chunk: string): void;
  /** Text of a user message, reported while a loaded session's history is replayed. */
  onUserText?(chunk: string): void;
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
            if (u.content.type === "text") handlers.onText(u.content.text);
            break;
          case "user_message_chunk":
            if (u.content.type === "text") handlers.onUserText?.(u.content.text);
            break;
          case "tool_call":
            handlers.onToolCall(
              {
                id: u.toolCallId,
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
      if (opts.loadSessionId) {
        await agent.request(methods.agent.session.load, { ...setup, sessionId: opts.loadSessionId });
        sessionId = opts.loadSessionId;
      } else {
        const created = (await agent.request(methods.agent.session.new, { ...setup })) as { sessionId: string };
        sessionId = created.sessionId;
      }
      session = new AgentSession(child, connection, relay, setup, sessionId, billing.summary);
      return session;
    } catch (err) {
      child.kill("SIGTERM");
      relay.close();
      throw err;
    }
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

  /** Switches to a past session; its history is replayed through the handlers before this resolves. */
  async load(sessionId: string): Promise<void> {
    if (this.turnAbort) this.cancel();
    await this.connection.agent.request(methods.agent.session.load, { ...this.sessionSetup, sessionId });
    this.currentSessionId = sessionId;
  }

  /** Sends one user turn; resolves with the stop reason when the turn ends. */
  async prompt(text: string): Promise<string> {
    this.turnAbort = new AbortController();
    try {
      const result = await this.connection.agent.request(methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      });
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

function toLocations(locations: ReadonlyArray<{ path: string; line?: number | null }> | null | undefined): Location[] {
  return (locations ?? []).map((l) => ({ path: l.path, line: l.line ?? undefined }));
}
