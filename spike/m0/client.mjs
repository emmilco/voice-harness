// M0 spike: ACP client -> claude-agent-acp, with a stdio MCP display tool whose
// calls are relayed back to this process over a Unix socket.
//
// Permission policy: approve only the harness's own display tool; reject
// everything else. Run non-interactively, this is the safe default.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, client as acpClient, methods, ndJsonStream } from "@agentclientprotocol/sdk/unstable";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(HERE, "fixture");
const AGENT_BIN = path.join(HERE, "node_modules", ".bin", "claude-agent-acp");
const SOCKET = path.join(os.tmpdir(), `vh-m0-${process.pid}.sock`);
const TIMEOUT_MS = 240_000;
const PROMPT =
  process.argv[2] ??
  "Use the show_code tool to show me where the loss is computed in tiny_gpt.py. " +
    "Then explain in two sentences why the logits are reshaped before cross-entropy.";

const t0 = Date.now();
const log = (tag, msg) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1)}s ${tag}] ${msg}\n`);

// ---------------------------------------------------------------- billing guard
function billingGuard() {
  const problems = [];
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
    if (process.env[name]) problems.push(`${name} is set in the environment`);
  }
  const settingsFiles = [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(os.homedir(), ".claude", "settings.local.json"),
    path.join(WORKSPACE, ".claude", "settings.json"),
    path.join(WORKSPACE, ".claude", "settings.local.json"),
  ];
  for (const f of settingsFiles) {
    if (existsSync(f) && readFileSync(f, "utf8").includes("apiKeyHelper")) problems.push(`apiKeyHelper in ${f}`);
  }
  const status = JSON.parse(execFileSync("claude", ["auth", "status", "--json"], { encoding: "utf8" }));
  if (status.authMethod !== "claude.ai") problems.push(`claude auth method is ${status.authMethod}, not claude.ai`);
  if (problems.length) {
    log("guard", `REFUSING TO START:\n  - ${problems.join("\n  - ")}`);
    process.exit(2);
  }
  log("guard", `ok: authMethod=${status.authMethod}, plan=${status.subscriptionType}, no API key configured`);
}

// ---------------------------------------------------------------- editor relay
const relayed = [];
function startRelay() {
  rmSync(SOCKET, { force: true });
  const srv = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const msg = JSON.parse(buf.slice(0, nl));
      relayed.push(msg);
      log("editor", `${msg.tool} ${path.relative(HERE, msg.path)}:${msg.start_line}-${msg.end_line}`);
      conn.write(JSON.stringify({ ok: true }) + "\n");
    });
  });
  srv.listen(SOCKET);
  return srv;
}

// ---------------------------------------------------------------- permissions
function isHarnessDisplayTool(toolCall) {
  const meta = JSON.stringify(toolCall?._meta ?? {});
  const title = toolCall?.title ?? "";
  const named = title.includes("show_code") || meta.includes("mcp__harness__show_code");
  return named && !["execute", "edit", "delete", "move"].includes(toolCall?.kind);
}

// ---------------------------------------------------------------- main
billingGuard();
const relayServer = startRelay();

const child = spawn(AGENT_BIN, [], {
  cwd: WORKSPACE,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, CLAUDE_CODE_EXECUTABLE: execFileSync("which", ["claude"], { encoding: "utf8" }).trim() },
});
child.stderr.on("data", (d) => process.stderr.write(`[agent stderr] ${d}`));

let textBuf = "";
const flushText = () => {
  if (textBuf.trim()) log("claude", textBuf.trim());
  textBuf = "";
};

const connection = acpClient({ name: "voice-harness-m0" })
  .onNotification(methods.client.session.update, (ctx) => {
    const u = ctx.params.update;
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      textBuf += u.content.text;
    } else if (u.sessionUpdate === "tool_call") {
      flushText();
      const locs = (u.locations ?? []).map((l) => `${path.relative(HERE, l.path)}${l.line ? ":" + l.line : ""}`);
      log("tool", `${u.title} [${u.kind}]${locs.length ? " @ " + locs.join(", ") : ""}`);
    } else if (u.sessionUpdate === "tool_call_update" && u.status && u.status !== "in_progress") {
      log("tool", `${u.toolCallId.slice(0, 8)} -> ${u.status}`);
    }
  })
  .onRequest(methods.client.session.requestPermission, (ctx) => {
    flushText();
    const { toolCall, options } = ctx.params;
    const allow = isHarnessDisplayTool(toolCall);
    const option = allow
      ? options.find((o) => o.kind === "allow_once")
      : options.find((o) => o.kind === "reject_once");
    log("permission", `${allow ? "ALLOW" : "REJECT"} ${toolCall?.title} [${toolCall?.kind}]`);
    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  })
  .connect(
    ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
    ),
  );

const agent = connection.agent;
const timer = setTimeout(() => {
  log("client", "TIMEOUT");
  shutdown(3);
}, TIMEOUT_MS);

function shutdown(code) {
  clearTimeout(timer);
  relayServer.close();
  rmSync(SOCKET, { force: true });
  child.kill("SIGTERM");
  process.exit(code);
}

try {
  const init = await agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  log("client", `connected: ${init.agentInfo?.name} ${init.agentInfo?.version}; auth methods offered: ${(init.authMethods ?? []).map((m) => m.id).join(", ")}`);

  const session = await agent.request(methods.agent.session.new, {
    cwd: WORKSPACE,
    mcpServers: [
      {
        name: "harness",
        command: process.execPath,
        args: [path.join(HERE, "mcp-tool.mjs")],
        env: [
          { name: "VH_SOCKET", value: SOCKET },
          { name: "VH_WORKSPACE", value: WORKSPACE },
        ],
      },
    ],
  });
  log("client", `session ${session.sessionId}`);

  const tPrompt = Date.now();
  const result = await agent.request(methods.agent.session.prompt, {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: PROMPT }],
  });
  flushText();
  log("client", `stopReason=${result.stopReason}; turn took ${((Date.now() - tPrompt) / 1000).toFixed(1)}s`);
  log("result", relayed.length ? `PASS: ${relayed.length} show_code call(s) reached the editor relay` : "FAIL: no show_code call reached the relay");
  shutdown(relayed.length ? 0 : 1);
} catch (err) {
  log("client", `ERROR: ${err?.stack ?? err}`);
  shutdown(1);
}
