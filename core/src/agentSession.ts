import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { PROTOCOL_VERSION, client as acpClient, methods, ndJsonStream } from "@agentclientprotocol/sdk/unstable";
import { checkBilling } from "./billingGuard";
import { startRelay, type Relay, type RelayReply, type RelayRequest } from "./relay";

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

export interface CodeRange {
  path: string;
  startLine: number;
  endLine: number;
}

/** Callbacks through which a front end (VS Code, a test script) presents the session. */
export interface SessionHandlers {
  onText(chunk: string): void;
  /** A new tool call (`isUpdate` false) or a change to one already reported. */
  onToolCall(info: ToolCallInfo, isUpdate: boolean): void;
  /** Resolve with the chosen optionId, or null to cancel. `signal` aborts when the turn is cancelled. */
  onPermission(req: PermissionRequest, signal: AbortSignal): Promise<string | null>;
  onShowCode(range: CodeRange): Promise<void>;
  onClearHighlight(): Promise<void>;
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
}

export class BillingGuardError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Refusing to start: ${problems.join("; ")}`);
  }
}

type AgentConnection = ReturnType<ReturnType<typeof acpClient>["connect"]>;

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
    readonly sessionId: string,
    readonly loginSummary: string,
  ) {}

  static async start(opts: SessionOptions): Promise<AgentSession> {
    const { handlers } = opts;
    const billing = checkBilling(opts.claudePath, opts.workspace);
    if (!billing.ok) throw new BillingGuardError(billing.problems);

    const relay = await startRelay(async (req: RelayRequest): Promise<RelayReply> => {
      if (req.tool === "show_code") {
        await handlers.onShowCode({ path: req.path, startLine: req.start_line, endLine: req.end_line });
      } else {
        await handlers.onClearHighlight();
      }
      return { ok: true };
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
          case "tool_call":
            handlers.onToolCall(
              { id: u.toolCallId, title: u.title, kind: u.kind ?? undefined, status: u.status ?? undefined, locations: toLocations(u.locations) },
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
      const created = await agent.request(methods.agent.session.new, {
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
        systemPrompt: { mode: "append", content: [{ type: "text", text: opts.systemPromptAppend }] },
      });
      session = new AgentSession(child, connection, relay, created.sessionId, billing.summary);
      return session;
    } catch (err) {
      child.kill("SIGTERM");
      relay.close();
      throw err;
    }
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
