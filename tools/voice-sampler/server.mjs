// Voice sampler: a local page for hearing every Kokoro English voice on your own text.
//
//   node tools/voice-sampler/server.mjs        then open http://127.0.0.1:4317
//
// Runs the harness voice process (microphone off) and renders requests to WAV.
// Listens on 127.0.0.1 only and rejects requests from other origins.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 4317);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const BINARY = path.join(ROOT, "voice", ".build", "release", "VoiceHarnessVoice");
const MODELS = process.env.VH_MODELS ?? "/Users/Shared/ai/models/fluidaudio";
const MAX_TEXT = 600;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// ---------------------------------------------------------------- voice process
const voice = spawn(BINARY, ["--models", MODELS, "--no-mic"], { stdio: ["pipe", "pipe", "inherit"] });
let nextId = 1;
const pending = new Map();
let resolveReady, resolveVoices;
const ready = new Promise((r) => (resolveReady = r));
const voices = new Promise((r) => (resolveVoices = r));

createInterface({ input: voice.stdout }).on("line", (line) => {
  if (!line.startsWith('{"event"')) return;
  const e = JSON.parse(line);
  if (e.event === "ready") {
    console.log(`voice process ready in ${e.startupMs} ms`);
    resolveReady();
  } else if (e.event === "voices") {
    resolveVoices(e.voices);
  } else if (e.event === "rendered" && pending.has(e.id)) {
    pending.get(e.id).resolve(e);
    pending.delete(e.id);
  } else if ((e.event === "error" || e.event === "fatal") && e.id !== undefined && pending.has(e.id)) {
    pending.get(e.id).reject(new Error(e.message));
    pending.delete(e.id);
  } else if (e.event === "fatal") {
    console.error(`voice process: ${e.message}`);
    process.exit(1);
  }
});
voice.on("exit", (code) => {
  console.error(`voice process exited (${code})`);
  process.exit(1);
});
const send = (command) => voice.stdin.write(JSON.stringify(command) + "\n");
await ready;
send({ cmd: "listVoices" });
// American (a) and British (b) voices; Kokoro's other-language voices need their own language
// pipelines, which the harness does not load.
const VOICES = (await voices).filter((v) => /^[ab][fm]_/.test(v));

function render(voiceName, text) {
  const id = nextId++;
  const file = path.join(os.tmpdir(), `voice-sampler-${randomBytes(6).toString("hex")}.wav`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: (e) => resolve({ ...e, file }), reject });
    send({ cmd: "render", id, text, voice: voiceName, path: file });
  });
}

// ---------------------------------------------------------------- http
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/sampler.js": ["sampler.js", "text/javascript; charset=utf-8"],
  "/sampler.css": ["sampler.css", "text/css; charset=utf-8"],
};
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; media-src 'self' blob:; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function reply(res, status, body, type = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  // Reject DNS-rebinding and cross-site requests: only our own host and origin.
  if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) return reply(res, 403, "forbidden host");
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, ""))) return reply(res, 403, "forbidden origin");

  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return reply(res, 200, await readFile(path.join(HERE, file)), type);
    }
    if (req.method === "GET" && url.pathname === "/api/voices") {
      return reply(res, 200, JSON.stringify({ voices: VOICES, current: "af_heart" }), "application/json");
    }
    if (req.method === "POST" && url.pathname === "/api/render") {
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return reply(res, 415, "send JSON");
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 10_000) return reply(res, 413, "too large");
      }
      const { voice: voiceName, text } = JSON.parse(raw);
      if (!VOICES.includes(voiceName)) return reply(res, 400, "unknown voice");
      if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) return reply(res, 400, `text must be 1-${MAX_TEXT} characters`);
      const result = await render(voiceName, text.trim());
      const wav = await readFile(result.file);
      await rm(result.file, { force: true });
      return reply(res, 200, wav, "audio/wav", { "X-Synth-Ms": String(result.ms), "X-Audio-Ms": String(result.audioMs) });
    }
    reply(res, 404, "not found");
  } catch (err) {
    reply(res, 500, err.message);
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`voice sampler: http://127.0.0.1:${PORT}`));
const shutdown = () => {
  voice.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
