import MarkdownIt from "markdown-it";
import type { FromWebview, ToWebview } from "../src/protocol";
import { renderFigure, type LiveUpdater } from "./figures";
import { Completer } from "./completer";
import { highlight } from "./highlight";
import { ToolCards, renderToolContent } from "./tools";

declare function acquireVsCodeApi(): {
  postMessage(message: FromWebview): void;
  getState(): { history?: string[] } | undefined;
  setState(state: { history?: string[] }): void;
};
const vscode = acquireVsCodeApi();

// Raw HTML in agent output is escaped, never rendered.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight: (code, language) => highlight(code, language) ?? "",
});
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.info.trim() === "onscreen") {
    return `<div class="onscreen" title="Shown, not spoken">${md.render(token.content)}</div>`;
  }
  return `<div class="code-block"><button class="copy-code" title="Copy">Copy</button>${defaultFence(tokens, idx, options, env, self)}</div>`;
};

// One handler for every code block's Copy button, wherever it was rendered.
document.addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest(".copy-code");
  if (!button) return;
  const code = button.parentElement?.querySelector("code")?.textContent ?? "";
  void navigator.clipboard.writeText(code).then(() => {
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy"), 1200);
  });
});

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
const completer = new Completer(input);
let commands: { name: string; description: string; hint?: string }[] = [];
completer.addSource((text, caret) => {
  const m = /^\/(\S*)$/.exec(text.slice(0, caret));
  if (!m) return undefined;
  const typed = m[1].toLowerCase();
  const items = commands
    .filter((c) => c.name.toLowerCase().includes(typed))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(typed)) - Number(!b.name.toLowerCase().startsWith(typed)))
    .map((c) => ({ label: `/${c.name}`, detail: c.hint ? `${c.hint} — ${c.description}` : c.description, insert: `/${c.name} ` }));
  return { start: 0, items };
});
let files: string[] = [];
let filesRequestedAt = 0;
completer.addSource((text, caret) => {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!m) return undefined;
  if (Date.now() - filesRequestedAt > 30_000) {
    filesRequestedAt = Date.now();
    vscode.postMessage({ type: "listFiles" });
  }
  const typed = m[1].toLowerCase();
  const scored = files
    .map((f) => {
      const lower = f.toLowerCase();
      const base = lower.slice(lower.lastIndexOf("/") + 1);
      const score = base.startsWith(typed) ? 0 : base.includes(typed) ? 1 : lower.includes(typed) ? 2 : -1;
      return { f, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.f.length - b.f.length);
  const items = scored.slice(0, 50).map(({ f }) => ({ label: f.slice(f.lastIndexOf("/") + 1), detail: f, insert: `@${f} ` }));
  return { start: caret - m[1].length - 1, items };
});
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const pendingImages: { mimeType: string; data: string; url: string }[] = [];
const imageTray = document.createElement("div");
imageTray.className = "image-tray";
input.parentElement!.insertBefore(imageTray, input);

function renderImageTray(): void {
  imageTray.replaceChildren();
  pendingImages.forEach((img, i) => {
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const pic = document.createElement("img");
    pic.src = img.url;
    const remove = document.createElement("button");
    remove.className = "thumb-remove";
    remove.textContent = "✕";
    remove.title = "Remove image";
    remove.addEventListener("click", () => {
      pendingImages.splice(i, 1);
      renderImageTray();
    });
    thumb.append(pic, remove);
    imageTray.appendChild(thumb);
  });
}

function addImage(file: File): void {
  if (!file.type.startsWith("image/")) return;
  if (pendingImages.length >= MAX_IMAGES) return void append(div("notice", `At most ${MAX_IMAGES} images per message.`));
  if (file.size > MAX_IMAGE_BYTES) return void append(div("notice", "Images over 5 MB are not attached."));
  const reader = new FileReader();
  reader.onload = () => {
    const url = String(reader.result);
    pendingImages.push({ mimeType: file.type, data: url.slice(url.indexOf(",") + 1), url });
    renderImageTray();
  };
  reader.readAsDataURL(file);
}

input.addEventListener("paste", (e) => {
  const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  if (!images.length) return;
  e.preventDefault();
  images.forEach(addImage);
});
input.addEventListener("dragover", (e) => e.preventDefault());
input.addEventListener("drop", (e) => {
  const images = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  if (!images.length) return;
  e.preventDefault();
  images.forEach(addImage);
});
/** Sent messages, oldest first; ↑/↓ walk it like a shell history. */
const history: string[] = vscode.getState()?.history ?? [];
let historyIndex = history.length;
let draft = "";

function remember(text: string): void {
  if (text && history[history.length - 1] !== text) history.push(text);
  if (history.length > 100) history.splice(0, history.length - 100);
  vscode.setState({ ...(vscode.getState() ?? {}), history });
  historyIndex = history.length;
}

/** ↑ at the start of the box (or in an empty box) and ↓ at its end move through history. */
function walkHistory(e: KeyboardEvent): boolean {
  const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
  const atEnd = input.selectionStart === input.value.length;
  if (e.key === "ArrowUp" && (atStart || !input.value) && historyIndex > 0) {
    if (historyIndex === history.length) draft = input.value;
    historyIndex--;
  } else if (e.key === "ArrowDown" && atEnd && historyIndex < history.length) {
    historyIndex++;
  } else {
    return false;
  }
  input.value = historyIndex === history.length ? draft : history[historyIndex];
  const at = e.key === "ArrowUp" ? 0 : input.value.length;
  input.setSelectionRange(at, at);
  return true;
}
let voiceUsable = false;
let voiceText = "";
const meter = document.createElement("span");
meter.className = "meter";
let listening = false;
let autoListening = false;

let ready = false;
let busy = false;
let busySince = 0;
let busyTimer: ReturnType<typeof setInterval> | undefined;

function showWorking(): void {
  const seconds = Math.floor((Date.now() - busySince) / 1000);
  status.textContent = `Claude is working… ${seconds} s`;
}
let agentText = "";
let agentBubble: HTMLElement | null = null;
let renderQueued = false;
const openDiff = (path: string, oldText: string | null, newText: string) =>
  vscode.postMessage({ type: "openDiff", path, oldText, newText });
const tools = new ToolCards(md, openDiff);
const permissionCards = new Map<string, HTMLElement>();
const liveCharts = new Map<string, LiveUpdater>();
const queuedBubbles = new Map<string, HTMLElement>();
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
  sendButton.disabled = !ready;
  sendButton.textContent = busy ? "Queue" : "Send";
  sendButton.title = busy ? "Claude is working; this message waits for the current turn to finish" : "Send (Enter)";
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
  if ((!text && !pendingImages.length) || !ready) return;
  remember(text);
  input.value = "";
  const images = pendingImages.splice(0).map(({ mimeType, data }) => ({ mimeType, data }));
  renderImageTray();
  vscode.postMessage({ type: "send", text: text || "(see attached image)", images });
}

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const m = event.data;
  switch (m.type) {
    case "state":
      ready = m.state === "ready" || m.state === "busy";
      if (m.state === "busy" && !busy) {
        busySince = Date.now();
        busyTimer = setInterval(showWorking, 1000);
      } else if (m.state !== "busy" && busyTimer) {
        clearInterval(busyTimer);
        busyTimer = undefined;
      }
      busy = m.state === "busy";
      status.className = `status ${m.state}`;
      if (busy) showWorking();
      else status.textContent = m.state === "ready" ? `Ready — ${m.detail ?? ""}` : (m.detail ?? m.state);
      updateControls();
      if (m.state === "ready") input.focus();
      break;
    case "user": {
      endAgentMessage();
      const bubble = div("message user", m.text);
      if (m.spoken) bubble.classList.add("spoken");
      if (m.context) {
        const chip = div("context-chip", `📍 ${m.context}`);
        chip.title = "Your editor position was sent with this message";
        bubble.appendChild(chip);
      }
      for (const name of m.attachments ?? []) {
        const chip = div("context-chip", `📎 ${name}`);
        chip.title = "Attached to this message";
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
    case "options": {
      const holder = document.getElementById("options")!;
      holder.replaceChildren();
      for (const o of m.options) {
        if (o.id === "fast") {
          const label = document.createElement("label");
          label.className = "option-toggle";
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = o.current === "on";
          box.addEventListener("change", () => vscode.postMessage({ type: "setOption", id: o.id, value: box.checked ? "on" : "off" }));
          label.append(box, document.createTextNode(` ${o.name}`));
          holder.appendChild(label);
          continue;
        }
        const select = document.createElement("select");
        select.className = "option-select";
        select.title = o.name;
        for (const c of o.choices) {
          const opt = new Option(`${o.name}: ${c.name}`, c.value, false, c.value === o.current);
          if (c.description) opt.title = c.description;
          select.add(opt);
        }
        select.addEventListener("change", () => vscode.postMessage({ type: "setOption", id: o.id, value: select.value }));
        holder.appendChild(select);
      }
      break;
    }
    case "usage": {
      const usage = document.getElementById("usage")!;
      const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);
      const ratio = m.size ? m.used / m.size : 0;
      usage.textContent = `context ${k(m.used)} / ${k(m.size)}`;
      usage.title = `${m.used.toLocaleString()} of ${m.size.toLocaleString()} tokens (${Math.round(ratio * 100)}%)`;
      usage.classList.toggle("high", ratio > 0.8);
      break;
    }
    case "queued": {
      const bubble = div("message user queued", m.text + (m.images ? `  (+${m.images} image${m.images > 1 ? "s" : ""})` : ""));
      const bar = div("queued-bar");
      bar.appendChild(div("queued-label", "queued — sends when Claude finishes"));
      const now = document.createElement("button");
      now.className = "secondary";
      now.textContent = "Send now";
      now.title = "Interrupt Claude and send this now";
      now.addEventListener("click", () => vscode.postMessage({ type: "sendNow", id: m.id }));
      const drop = document.createElement("button");
      drop.className = "secondary";
      drop.textContent = "✕";
      drop.title = "Remove from the queue";
      drop.addEventListener("click", () => vscode.postMessage({ type: "unqueue", id: m.id }));
      bar.append(now, drop);
      bubble.appendChild(bar);
      queuedBubbles.set(m.id, bubble);
      append(bubble);
      scrollToEnd();
      break;
    }
    case "dequeued":
      queuedBubbles.get(m.id)?.remove();
      queuedBubbles.delete(m.id);
      break;
    case "commands":
      commands = m.commands;
      break;
    case "files":
      files = m.files;
      completer.refresh();
      break;
    case "title": {
      const title = document.getElementById("title")!;
      title.textContent = m.title;
      title.hidden = false;
      break;
    }
    case "clear":
      endAgentMessage();
      log.replaceChildren();
      tools.clear();
      permissionCards.clear();
      liveCharts.clear();
      earlyRows.clear();
      sessionMenu.hidden = true;
      document.getElementById("title")!.hidden = true;
      document.getElementById("usage")!.textContent = "";
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
      if (m.hidden) break;
      // A tool call splits the reply: text after it starts a new bubble.
      if (!m.isUpdate) endAgentMessage();
      const created = tools.update(m.id, { title: m.title, kind: m.kind, status: m.status, content: m.content });
      if (created) append(created);
      break;
    }
    case "permission": {
      endAgentMessage();
      const card = div("permission");
      card.appendChild(div("permission-title", `Claude wants to run: ${m.title}${m.kind ? ` (${m.kind})` : ""}`));
      if (m.content?.length) {
        const detail = div("permission-detail");
        renderToolContent(detail, m.content, md, openDiff);
        card.appendChild(detail);
      }
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
  if (completer.handleKey(e) || walkHistory(e)) {
    e.preventDefault();
    return;
  }
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
