import MarkdownIt from "markdown-it";
import type { FromWebview, ToWebview } from "../src/protocol";
import { renderFigure, type LiveUpdater } from "./figures";

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void };
const vscode = acquireVsCodeApi();

// Raw HTML in agent output is escaped, never rendered.
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.info.trim() === "onscreen") {
    return `<div class="onscreen" title="Shown, not spoken">${md.render(token.content)}</div>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

const log = document.getElementById("log")!;
const status = document.getElementById("status")!;
const input = document.getElementById("input") as HTMLTextAreaElement;
const sendButton = document.getElementById("send") as HTMLButtonElement;
const stopButton = document.getElementById("stop") as HTMLButtonElement;
const restartButton = document.getElementById("restart") as HTMLButtonElement;
const talkButton = document.getElementById("talk") as HTMLButtonElement;
const speakButton = document.getElementById("speak") as HTMLButtonElement;
const voiceChip = document.getElementById("voice")!;
const partial = document.getElementById("partial")!;
const sessionMenu = document.getElementById("session-menu")!;
const sessionList = document.getElementById("session-list")!;

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} d ago` : new Date(iso).toLocaleDateString();
}

const VOICE_LABELS: Record<string, string> = {
  loading: "Voice loading…",
  idle: "Voice ready",
  warming: "Starting mic…",
  listening: "● Listening — press Send (or Ctrl+Shift+Space) when done",
  speaking: "Speaking",
  interrupted: "Paused — you're speaking",
  unavailable: "Voice unavailable",
};
let voiceUsable = false;
let voiceText = "";
const meter = document.createElement("span");
meter.className = "meter";
let listening = false;
let autoListening = false;

let ready = false;
let busy = false;
let agentText = "";
let agentBubble: HTMLElement | null = null;
let renderQueued = false;
const toolRows = new Map<string, HTMLElement>();
const permissionCards = new Map<string, HTMLElement>();
const liveCharts = new Map<string, LiveUpdater>();
/** Rows that arrived before their chart finished rendering. */
const earlyRows = new Map<string, Record<string, unknown>[]>();

function scrollToEnd(): void {
  log.scrollTop = log.scrollHeight;
}

function append(el: HTMLElement): void {
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.appendChild(el);
  if (nearBottom) scrollToEnd();
}

function div(className: string, text?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function renderAgent(): void {
  renderQueued = false;
  if (!agentBubble) return;
  agentBubble.innerHTML = md.render(agentText);
  scrollToEnd();
}

function endAgentMessage(): void {
  if (agentBubble) renderAgent();
  agentBubble = null;
  agentText = "";
}

function updateControls(): void {
  sendButton.disabled = !ready || busy;
  stopButton.disabled = !busy && !listening;
  input.disabled = !ready;
  talkButton.disabled = !ready || !voiceUsable;
  talkButton.textContent = listening ? "■ Send" : "🎙 Talk";
  talkButton.title = listening ? "Send what you said (Ctrl+Shift+Space)" : "Start talking (Ctrl+Shift+Space)";
  talkButton.classList.toggle("listening", listening);
  stopButton.textContent = listening ? "✕ Discard" : "Stop";
  stopButton.title = listening ? "Throw away this recording" : "Stop Claude";
}

function send(): void {
  const text = input.value.trim();
  if (!text || !ready || busy) return;
  input.value = "";
  vscode.postMessage({ type: "send", text });
}

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const m = event.data;
  switch (m.type) {
    case "state":
      ready = m.state === "ready" || m.state === "busy";
      busy = m.state === "busy";
      status.className = `status ${m.state}`;
      status.textContent =
        m.state === "busy" ? "Claude is working…" : m.state === "ready" ? `Ready — ${m.detail ?? ""}` : (m.detail ?? m.state);
      updateControls();
      if (m.state === "ready") input.focus();
      break;
    case "user": {
      endAgentMessage();
      const bubble = div("message user", m.text);
      if (m.spoken) bubble.classList.add("spoken");
      if (m.context) {
        const chip = div("context-chip", `📎 ${m.context}`);
        chip.title = "Your editor position was sent with this message";
        bubble.appendChild(chip);
      }
      append(bubble);
      break;
    }
    case "voice":
      voiceUsable = m.microphone && m.state !== "loading" && m.state !== "unavailable";
      listening = m.state === "listening";
      autoListening = m.autoListening;
      document.getElementById("conversation")!.textContent = m.conversation ? "💬 Conversation on" : "💬 Conversation off";
      voiceChip.className = `voice ${m.state}`;
      voiceText =
        (m.state === "listening" && autoListening ? "● Listening for your reply — pause to send" : (VOICE_LABELS[m.state] ?? m.state)) +
        (m.detail ? ` — ${m.detail}` : "");
      voiceChip.textContent = voiceText;
      meter.textContent = "";
      if (m.state === "listening" || m.state === "interrupted") voiceChip.appendChild(meter);
      speakButton.textContent = m.speak ? "🔊 Voice on" : "🔇 Voice off";
      updateControls();
      break;
    case "level": {
      // -60 dBFS (silence) .. 0 dBFS (loud) mapped to 0..10 bars.
      const bars = Math.max(0, Math.min(10, Math.round((m.db + 60) / 6)));
      meter.textContent = ` ${"▮".repeat(bars)}${"▯".repeat(10 - bars)}`;
      break;
    }
    case "partial":
      partial.hidden = !m.text;
      partial.textContent = m.text;
      partial.className = `partial ${m.source ?? ""}`;
      break;
    case "notice":
      append(div("notice", m.text));
      break;
    case "clear":
      endAgentMessage();
      log.replaceChildren();
      toolRows.clear();
      permissionCards.clear();
      liveCharts.clear();
      earlyRows.clear();
      sessionMenu.hidden = true;
      break;
    case "sessions": {
      sessionList.replaceChildren();
      if (!m.items.length) sessionList.appendChild(div("notice", "No conversations yet."));
      for (const item of m.items) {
        const row = document.createElement("button");
        row.className = "session-item" + (item.id === m.currentId ? " current" : "");
        row.appendChild(div("session-title", item.title));
        row.appendChild(div("session-time", item.id === m.currentId ? "current" : relativeTime(item.updatedAt)));
        row.disabled = item.id === m.currentId;
        row.addEventListener("click", () => {
          sessionMenu.hidden = true;
          vscode.postMessage({ type: "loadSession", id: item.id });
        });
        sessionList.appendChild(row);
      }
      sessionMenu.hidden = false;
      break;
    }
    case "step": {
      endAgentMessage();
      const bubble = div("message agent step");
      const lines = m.startLine === m.endLine ? `line ${m.startLine}` : `lines ${m.startLine}–${m.endLine}`;
      bubble.appendChild(div("step-ref", `${m.file} · ${lines}`));
      const body = div("step-body");
      body.innerHTML = md.render(m.text);
      bubble.appendChild(body);
      append(bubble);
      break;
    }
    case "figureData": {
      const update = liveCharts.get(m.id);
      if (update) void update(m.rows);
      else earlyRows.set(m.id, m.rows);
      break;
    }
    case "figure": {
      endAgentMessage();
      const block = div("figure");
      const canvas = div("figure-body");
      block.appendChild(canvas);
      if (m.caption) block.appendChild(div("figure-caption", m.caption));
      append(block);
      if (m.live) block.classList.add("live");
      renderFigure(canvas, m.kind, m.content).then(
        (update) => {
          if (m.live && update) {
            liveCharts.set(m.id, update);
            const pending = earlyRows.get(m.id);
            earlyRows.delete(m.id);
            if (pending) void update(pending);
          }
          scrollToEnd();
          vscode.postMessage({ type: "figureResult", id: m.id, ok: true });
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          canvas.replaceChildren(div("notice error", `Figure could not be rendered (${m.kind}): ${message}`));
          vscode.postMessage({ type: "figureResult", id: m.id, ok: false, error: message });
        },
      );
      break;
    }
    case "agentText":
      if (!agentBubble) {
        agentBubble = div("message agent");
        append(agentBubble);
      }
      agentText += m.chunk;
      if (!renderQueued) {
        renderQueued = true;
        requestAnimationFrame(renderAgent);
      }
      break;
    case "tool": {
      // A tool call splits the reply: text after it starts a new bubble.
      if (!m.isUpdate) endAgentMessage();
      let row = toolRows.get(m.id);
      if (!row) {
        row = div("tool");
        toolRows.set(m.id, row);
        append(row);
      }
      if (m.title) row.dataset.title = m.title;
      if (m.status) row.dataset.status = m.status;
      row.textContent = `${row.dataset.title ?? "tool"}${row.dataset.status ? ` — ${row.dataset.status}` : ""}`;
      break;
    }
    case "permission": {
      endAgentMessage();
      const card = div("permission");
      card.appendChild(div("permission-title", `Claude wants to run: ${m.title}${m.kind ? ` (${m.kind})` : ""}`));
      const row = div("permission-buttons");
      for (const o of m.options) {
        const b = document.createElement("button");
        b.textContent = o.name;
        b.className = o.kind.startsWith("allow") ? "allow" : "secondary";
        b.addEventListener("click", () => vscode.postMessage({ type: "permission", requestId: m.requestId, optionId: o.optionId }));
        row.appendChild(b);
      }
      card.appendChild(row);
      permissionCards.set(m.requestId, card);
      append(card);
      scrollToEnd();
      break;
    }
    case "permissionDone": {
      const card = permissionCards.get(m.requestId);
      if (card) {
        card.classList.add("answered");
        card.querySelectorAll("button").forEach((b) => (b.disabled = true));
        permissionCards.delete(m.requestId);
      }
      break;
    }
    case "turnEnd":
      endAgentMessage();
      if (m.stopReason !== "end_turn") append(div("notice", `Turn ended: ${m.stopReason}`));
      break;
    case "error":
      endAgentMessage();
      append(div("notice error", m.text));
      break;
  }
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
sendButton.addEventListener("click", send);
stopButton.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
talkButton.addEventListener("click", () => vscode.postMessage({ type: "talk" }));
document.getElementById("sessions")!.addEventListener("click", () => {
  if (!sessionMenu.hidden) {
    sessionMenu.hidden = true;
    return;
  }
  vscode.postMessage({ type: "listSessions" });
});
document.getElementById("session-close")!.addEventListener("click", () => (sessionMenu.hidden = true));
document.getElementById("session-new")!.addEventListener("click", () => {
  sessionMenu.hidden = true;
  vscode.postMessage({ type: "newSession" });
});
speakButton.addEventListener("click", () => vscode.postMessage({ type: "toggleSpeak" }));
document.getElementById("conversation")!.addEventListener("click", () => vscode.postMessage({ type: "toggleConversation" }));
restartButton.addEventListener("click", () => {
  endAgentMessage();
  append(div("notice", "Restarting session…"));
  vscode.postMessage({ type: "restart" });
});

updateControls();
vscode.postMessage({ type: "ready" });
