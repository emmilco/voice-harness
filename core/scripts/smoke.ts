// Headless smoke test of the core: one real turn against the M0 fixture.
// Requires `npm run build` (for the bundled MCP server).
// Permission policy: allow the harness display tools, reject everything else.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession, SPEECH_LAYER } from "../src/index";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const WORKSPACE = path.join(ROOT, "spike", "m0", "fixture");
const MCP = path.join(ROOT, "extension", "dist", "mcpServer.mjs");
const AGENT = path.join(ROOT, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
const PROMPT =
  process.argv[2] ??
  "Show me where the loss is computed in tiny_gpt.py and tell me in two sentences why the logits get reshaped.";

for (const f of [MCP, AGENT]) if (!existsSync(f)) throw new Error(`missing ${f} (run npm install && npm run build)`);

const t0 = Date.now();
const log = (tag: string, msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s ${tag}] ${msg}`);
let text = "";
let shown = 0;

const session = await AgentSession.start({
  workspace: WORKSPACE,
  nodePath: process.execPath,
  claudePath: execFileSync("which", ["claude"], { encoding: "utf8" }).trim(),
  agentEntry: AGENT,
  mcpServerScript: MCP,
  systemPromptAppend: SPEECH_LAYER,
  handlers: {
    onText: (c) => (text += c),
    onToolCall: (t, isUpdate) => {
      if (!isUpdate) log("tool", `${t.title} [${t.kind}]${t.locations.length ? " @ " + t.locations.map((l) => `${path.basename(l.path)}:${l.line ?? "?"}`).join(", ") : ""}`);
    },
    onPermission: async (req) => {
      const allow = /show_code|clear_highlight/.test(req.title) && req.kind !== "execute";
      log("permission", `${allow ? "ALLOW" : "REJECT"} ${req.title} [${req.kind}]`);
      return req.options.find((o) => o.kind === (allow ? "allow_once" : "reject_once"))?.optionId ?? null;
    },
    onShowCode: async (r) => {
      shown++;
      log("editor", `show_code ${path.relative(WORKSPACE, r.path)}:${r.startLine}-${r.endLine}`);
    },
    onClearHighlight: async () => log("editor", "clear_highlight"),
    onLog: () => {},
    onExit: (reason) => log("exit", reason),
  },
});
log("session", `${session.sessionId} (${session.loginSummary})`);

const stop = await session.prompt(PROMPT);
log("claude", text.trim());
log("turn", `stopReason=${stop}`);
log("check", `show_code calls: ${shown}; onscreen block present: ${text.includes("```onscreen")}`);
session.dispose();
process.exit(shown > 0 ? 0 : 1);
