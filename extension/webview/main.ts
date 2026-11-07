import MarkdownIt from "markdown-it";
import type { FromWebview, ToWebview } from "../src/protocol";

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

let ready = false;
let busy = false;
let agentText = "";
let agentBubble: HTMLElement | null = null;
let renderQueued = false;
const toolRows = new Map<string, HTMLElement>();
const permissionCards = new Map<string, HTMLElement>();

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
  stopButton.disabled = !busy;
  input.disabled = !ready;
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
    case "user":
      endAgentMessage();
      append(div("message user", m.text));
      break;
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
restartButton.addEventListener("click", () => {
  endAgentMessage();
  append(div("notice", "Restarting session…"));
  vscode.postMessage({ type: "restart" });
});

updateControls();
vscode.postMessage({ type: "ready" });
