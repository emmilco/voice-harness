// Headless smoke test of the core: one real turn against the M0 fixture.
// Requires `npm run build` (for the bundled MCP server).
// Permission policy: allow the harness display tools, reject everything else.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as vega from "vega";
import { compile } from "vega-lite";
import { expressionInterpreter } from "vega-interpreter";
import { AgentSession, SPEECH_LAYER, SpeechChunker, VoiceClient, type Figure } from "../src/index";

/** Validates a figure the way the panel would render it, where that is possible without a browser. */
async function checkFigure(f: Figure): Promise<string | null> {
  try {
    if (f.kind === "vega-lite") {
      const view = new vega.View(vega.parse(compile(JSON.parse(f.content)).spec, undefined, { ast: true }), {
        expr: expressionInterpreter,
        renderer: "none",
      });
      const svg = await view.toSVG();
      return svg.startsWith("<svg") ? null : "Vega produced no SVG";
    }
    if (f.kind === "svg") return /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(f.content) ? null : "content is not an <svg> document";
    if (f.kind === "image") return existsSync(f.content) ? null : "image file not found";
    return null; // mermaid needs a browser; checked in the panel only
  } catch (err) {
    return (err as Error).message;
  }
}
let figures = 0;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const WORKSPACE = path.join(ROOT, "spike", "m0", "fixture");
// VH_MCP_SERVER / VH_AGENT_ENTRY point the test at another build, e.g. an unpacked .vsix.
const MCP = process.env.VH_MCP_SERVER ?? path.join(ROOT, "extension", "dist", "mcpServer.mjs");
const AGENT = process.env.VH_AGENT_ENTRY ?? path.join(ROOT, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
// --speak: also speak the reply through the chunker and the voice process (plays audio).
const SPEAK = process.argv.includes("--speak");
const VOICE_BIN = path.join(ROOT, "voice", ".build", "release", "VoiceHarnessVoice");
const PROMPT =
  process.argv.slice(2).find((a) => !a.startsWith("--")) ??
  "Show me where the loss is computed in tiny_gpt.py and tell me in two sentences why the logits get reshaped.";

for (const f of [MCP, AGENT]) if (!existsSync(f)) throw new Error(`missing ${f} (run npm install && npm run build)`);

const t0 = Date.now();
const log = (tag: string, msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s ${tag}] ${msg}`);
let text = "";
let shown = 0;
const chunker = new SpeechChunker();
const spoken: string[] = [];
const pendingMarks = new Map<number, string>();
let voiceIdle: () => void = () => {};
let voiceReady: () => void = () => {};
const ready = new Promise<void>((r) => (voiceReady = r));
const voice = SPEAK
  ? VoiceClient.start({
      binary: VOICE_BIN,
      modelsDirectory: path.join(process.env.HOME ?? "", "Library", "Application Support", "voice-harness", "models"),
      voice: "af_heart",
      voiceProcessing: false,
      interruptions: false,
      onEvent: (e) => {
        if (e.event === "ready") voiceReady();
        if (e.event === "speechIdle") voiceIdle();
        if (e.event === "spoke") log("voice", `spoke #${e.id}`);
        if (e.event === "marked" && pendingMarks.has(e.id)) {
          log("editor", `APPLIED ${pendingMarks.get(e.id)}`);
          pendingMarks.delete(e.id);
        }
        if (e.event === "error" || e.event === "fatal") log("voice", e.message);
      },
      onExit: (r) => log("voice", r),
    })
  : undefined;
const say = (sentences: string[]) => {
  for (const s of sentences) {
    spoken.push(s);
    log("speak", `#${voice?.speak(s)} ${s}`);
  }
};
if (voice) await ready;

const session = await AgentSession.start({
  workspace: WORKSPACE,
  nodePath: process.execPath,
  claudePath: execFileSync("which", ["claude"], { encoding: "utf8" }).trim(),
  agentEntry: AGENT,
  mcpServerScript: MCP,
  systemPromptAppend: SPEECH_LAYER,
  handlers: {
    onText: (c) => {
      text += c;
      if (voice) say(chunker.push(c));
    },
    onCommands: (cmds) => log("commands", `${cmds.length} available: ${cmds.slice(0, 6).map((c) => "/" + c.name).join(" ")} …`),
    onToolCall: (t, isUpdate) => {
      if (process.env.VH_LOG_CONTENT && t.content?.length) {
        log("content", `${t.name ?? "?"} ${t.status ?? ""} ${t.content.map((c) => (c.kind === "diff" ? `diff(${path.basename(c.path)})` : `text(${c.text.length})`)).join(", ")}`);
      }
      if (process.env.VH_LOG_RAW && /explain_code/.test(t.title ?? "")) {
        log("raw", `${isUpdate ? "update" : "announce"} ${t.id.slice(-6)} status=${t.status} input=${JSON.stringify(t.rawInput ?? null).slice(0, 90)}`);
      }
      if (!isUpdate && voice) say(chunker.flush());
      if (!isUpdate) log("tool", `${t.title} [${t.kind}]${t.locations.length ? " @ " + t.locations.map((l) => `${path.basename(l.path)}:${l.line ?? "?"}`).join(", ") : ""}`);
    },
    onPermission: async (req) => {
      const allow = /show_code|clear_highlight/.test(req.title) && req.kind !== "execute";
      log("permission", `${allow ? "ALLOW" : "REJECT"} ${req.title} [${req.kind}]${req.content?.length ? " content: " + req.content.map((c) => c.kind).join(",") : ""}`);
      return req.options.find((o) => o.kind === (allow ? "allow_once" : "reject_once"))?.optionId ?? null;
    },
    onShowCode: async (r) => {
      shown++;
      if (voice) {
        const where = `show_code ${path.relative(WORKSPACE, r.path)}:${r.startLine}-${r.endLine}`;
        pendingMarks.set(voice.mark(), where);
        log("editor", `queued ${where}`);
        return;
      }
      log("editor", `show_code ${path.relative(WORKSPACE, r.path)}:${r.startLine}-${r.endLine}`);
    },
    onClearHighlight: async () => log("editor", "clear_highlight"),
    onShowLiveChart: async (c) => {
      figures++;
      const problem = await checkFigure({ kind: "vega-lite", content: c.spec, caption: c.caption });
      log("figure", `live chart following ${path.relative(WORKSPACE, c.dataFile)} → ${problem ?? "renders"}`);
      return problem ? { ok: false as const, error: problem } : { ok: true as const };
    },
    onExplainCode: async (s) => {
      shown++;
      const where = `explain_code #${s.step ?? "?"} ${path.relative(WORKSPACE, s.range.path)}:${s.range.startLine}-${s.range.endLine}`;
      if (voice) {
        say(chunker.flush());
        pendingMarks.set(voice.mark(), where);
        log("editor", `queued ${where}`);
        const words = new SpeechChunker();
        say([...words.push(s.say + "\n"), ...words.flush()]);
      } else {
        log("step", `${where}: ${s.say}`);
      }
    },
    onShowFigure: async (f) => {
      figures++;
      const problem = await checkFigure(f);
      log("figure", `${f.kind}${f.caption ? ` "${f.caption}"` : ""} (${f.content.length} chars) → ${problem ?? "renders"}`);
      return problem ? { ok: false as const, error: problem } : { ok: true as const };
    },
    onLog: () => {},
    onExit: (reason) => log("exit", reason),
  },
});
// Prompting mode, so the permission policy above sees every action (the user's default may be "auto").
await session.setConfigOption("mode", "default");
log("session", `${session.sessionId} (${session.loginSummary}); options: ${session.configOptions.map((o) => `${o.id}=${o.current}`).join(", ")}`);

const stop = await session.prompt(PROMPT);
if (voice) {
  say(chunker.flush());
  await new Promise<void>((r) => {
    voiceIdle = r;
    setTimeout(r, 60_000);
  });
  voice.dispose();
}
log("claude", text.trim());
log("turn", `stopReason=${stop}`);
log("check", `show_code calls: ${shown}; figures: ${figures}; onscreen block present: ${text.includes("```onscreen")}${voice ? `; sentences spoken: ${spoken.length}` : ""}`);
session.dispose();
process.exit(shown > 0 ? 0 : 1);
