import MarkdownIt from "markdown-it";
import type { ConfigOptionView, FromWebview, PanelMessage, SessionState, TabMessage, TabSummary, ToWebview } from "../src/protocol";
import { Completer } from "./completer";
import { renderFigure, type LiveUpdater } from "./figures";
import { highlight } from "./highlight";
import { ToolCards, renderToolContent, toolIcon } from "./tools";

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
    // Supporting detail (status lines, checks): collapsed under its first line, shown not spoken.
    const first = token.content.split("\n").find((l) => l.trim()) ?? "Details";
    const summary = first.replace(/[*_`#>[\]]/g, "").trim();
    return `<details class="onscreen"><summary title="Shown, not spoken">${md.utils.escapeHtml(summary.length > 90 ? summary.slice(0, 88) + "…" : summary)}</summary><div class="onscreen-body">${md.render(token.content)}</div></details>`;
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

const logs = document.getElementById("logs")!;
const status = document.getElementById("status")!;
const titleEl = document.getElementById("title")!;
const optionsEl = document.getElementById("options")!;
const usageEl = document.getElementById("usage")!;
const tabList = document.getElementById("tab-list")!;
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

function div(className: string, text?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

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

const openDiff = (path: string, oldText: string | null, newText: string) => vscode.postMessage({ type: "openDiff", path, oldText, newText });

// MARK: One conversation's view

/** Everything one tab shows: its transcript and its session bar state. */
class TabView {
  readonly log = div("log");
  state: SessionState = "starting";
  detail = "";
  busySince = 0;
  title = "";
  options: ConfigOptionView[] = [];
  usage: { used: number; size: number } | undefined;
  commands: { name: string; description: string; hint?: string }[] = [];
  private agentText = "";
  private agentBubble: HTMLElement | null = null;
  private agentSegment = "";
  /** Bubbles and steps that can be marked as "being read aloud", by ref. */
  private readonly spokenRefs = new Map<string, HTMLElement>();
  private speakingEl: HTMLElement | undefined;
  private renderQueued = false;
  private readonly tools = new ToolCards(md, openDiff);
  private readonly permissionCards = new Map<string, HTMLElement>();
  private readonly liveCharts = new Map<string, LiveUpdater>();
  private readonly queuedBubbles = new Map<string, HTMLElement>();
  /** Rows that arrived before their chart finished rendering. */
  private readonly earlyRows = new Map<string, Record<string, unknown>[]>();

  /** Follow new output only while the reader is at the bottom; scrolling up to re-read pauses it. */
  private pinned = true;
  /** The unsent message and images, kept while another tab is shown. */
  draft = "";
  draftImages: { mimeType: string; data: string; url: string }[] = [];

  constructor(readonly id: string) {
    this.log.hidden = true;
    logs.appendChild(this.log);
    this.log.addEventListener("scroll", () => {
      this.pinned = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 80;
    });
    this.showEmptyState();
  }

  /** Scrolls to the newest output: always when `force`, otherwise only if the reader is at the bottom. */
  scrollToEnd(force = false): void {
    if (force) this.pinned = true;
    if (this.pinned) this.log.scrollTop = this.log.scrollHeight;
  }

  append(el: HTMLElement): void {
    this.log.querySelector(".empty-state")?.remove();
    this.log.appendChild(el);
    this.scrollToEnd();
  }

  /** A start failure or agent exit, with a way to start over. */
  private showProblem(detail: string): void {
    const card = div("notice error problem", detail);
    const restart = document.createElement("button");
    restart.className = "secondary";
    restart.textContent = "Restart this conversation";
    restart.addEventListener("click", () => vscode.postMessage({ type: "restart", tabId: this.id }));
    card.appendChild(restart);
    this.append(card);
  }

  private showEmptyState(): void {
    const card = div("empty-state");
    card.appendChild(div("empty-title", "Ask about the code, typed or aloud."));
    const tips = [
      "Press the mic (Ctrl+Shift+Space) to talk; press it again when you're done.",
      "With auto-listen on, just answer after Claude speaks; a pause sends.",
      "Type / for commands and skills, @ to attach a file; paste or drop images.",
      "Press ↑ in an empty box to recall earlier messages.",
      "Messages you type while Claude works wait their turn; talking interrupts.",
      "Hover over one of your messages to rewind the conversation to it.",
    ];
    const list = document.createElement("ul");
    for (const tip of tips) {
      const li = document.createElement("li");
      li.textContent = tip;
      list.appendChild(li);
    }
    card.appendChild(list);
    this.log.appendChild(card);
  }

  /** Paragraphs already rendered into the bubble, by the length of agent text they cover. */
  private stableLength = 0;
  private stableEl: HTMLElement | null = null;
  private tailEl: HTMLElement | null = null;

  /**
   * Renders streamed text without rebuilding the whole bubble: finished paragraphs (up to the
   * last blank line outside a code fence) are rendered once; only the paragraph still being
   * written is re-rendered.
   */
  private renderAgent(): void {
    this.renderQueued = false;
    if (!this.agentBubble) return;
    if (!this.stableEl || !this.tailEl) {
      this.stableEl = div("md-stable");
      this.tailEl = div("md-tail");
      this.agentBubble.replaceChildren(this.stableEl, this.tailEl);
    }
    const cut = stableCut(this.agentText);
    if (cut > this.stableLength) {
      const block = document.createElement("div");
      block.innerHTML = md.render(this.agentText.slice(this.stableLength, cut));
      this.stableEl.append(...block.childNodes);
      this.stableLength = cut;
    }
    this.tailEl.innerHTML = md.render(this.agentText.slice(this.stableLength));
    this.scrollToEnd();
  }

  endAgentMessage(): void {
    if (this.agentBubble) this.renderAgent();
    this.agentBubble = null;
    this.agentText = "";
    this.agentSegment = "";
    this.stableLength = 0;
    this.stableEl = null;
    this.tailEl = null;
  }

  get awaitingApproval(): boolean {
    return this.permissionCards.size > 0;
  }

  /** Applies a message about this conversation. */
  apply(m: TabMessage): void {
    switch (m.type) {
      case "state":
        if (m.state === "busy" && this.state !== "busy") this.busySince = Date.now();
        this.state = m.state;
        this.detail = m.detail ?? "";
        if ((m.state === "error" || m.state === "stopped") && m.detail) this.showProblem(m.detail);
        break;
      case "user": {
        this.endAgentMessage();
        this.scrollToEnd(true);
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
        if (m.turn !== undefined) {
          const rewind = document.createElement("button");
          rewind.className = "rewind secondary";
          rewind.textContent = "↶ Rewind";
          rewind.title = "Go back to just before this message: later messages are removed and this one returns to the input box";
          const turn = m.turn;
          rewind.addEventListener("click", () => vscode.postMessage({ type: "rewind", tabId: this.id, turn }));
          bubble.appendChild(rewind);
        }
        this.append(bubble);
        break;
      }
      case "agentText":
        if (!this.agentBubble || m.segment !== this.agentSegment) {
          this.endAgentMessage();
          this.agentBubble = div("message agent");
          this.agentSegment = m.segment;
          this.spokenRefs.set(m.segment, this.agentBubble);
          this.append(this.agentBubble);
        }
        this.agentText += m.chunk;
        if (!this.renderQueued) {
          // About ten renders a second: smooth enough to read, cheap enough not to stutter.
          this.renderQueued = true;
          setTimeout(() => requestAnimationFrame(() => this.renderAgent()), 90);
        }
        break;
      case "turnEnd": {
        this.endAgentMessage();
        const reasons: Record<string, string> = {
          cancelled: "Stopped.",
          max_tokens: "Reply cut off (length limit).",
          max_turn_requests: "Stopped (too many steps in one turn).",
          refusal: "Claude declined to continue.",
        };
        if (m.stopReason !== "end_turn") this.append(div("notice", reasons[m.stopReason] ?? `Turn ended: ${m.stopReason}`));
        break;
      }
      case "tool": {
        if (m.hidden) break;
        // A tool call splits the reply: text after it starts a new bubble.
        if (!m.isUpdate) this.endAgentMessage();
        const created = this.tools.update(m.id, { title: m.title, kind: m.kind, status: m.status, content: m.content });
        if (created) this.append(created);
        break;
      }
      case "permission": {
        this.endAgentMessage();
        const card = div("permission");
        card.appendChild(div("permission-title", `Claude wants to: ${toolIcon(m.kind)} ${m.title}`));
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
          b.addEventListener("click", () => {
            vscode.postMessage({ type: "permission", tabId: this.id, requestId: m.requestId, optionId: o.optionId });
            input.focus();
          });
          row.appendChild(b);
        }
        card.appendChild(row);
        this.permissionCards.set(m.requestId, card);
        this.append(card);
        this.scrollToEnd(true);
        if (this.id === activeId) (row.querySelector("button.allow") as HTMLButtonElement | null)?.focus();
        break;
      }
      case "permissionDone": {
        const card = this.permissionCards.get(m.requestId);
        if (card) {
          card.classList.add("answered");
          card.querySelectorAll("button").forEach((b) => (b.disabled = true));
          this.permissionCards.delete(m.requestId);
        }
        break;
      }
      case "step": {
        this.endAgentMessage();
        const bubble = div("message agent step");
        const lines = m.startLine === m.endLine ? `line ${m.startLine}` : `lines ${m.startLine}–${m.endLine}`;
        const refButton = document.createElement("button");
        refButton.className = "step-ref";
        refButton.textContent = `${m.file} · ${lines}`;
        refButton.title = "Show these lines in the editor again";
        refButton.addEventListener("click", () =>
          vscode.postMessage({ type: "showStep", tabId: this.id, path: m.path, startLine: m.startLine, endLine: m.endLine }),
        );
        bubble.appendChild(refButton);
        this.spokenRefs.set(m.ref, bubble);
        const body = div("step-body");
        body.innerHTML = md.render(m.text);
        bubble.appendChild(body);
        this.append(bubble);
        break;
      }
      case "figure": {
        this.endAgentMessage();
        const block = div("figure");
        const canvas = div("figure-body");
        block.appendChild(canvas);
        if (m.caption) block.appendChild(div("figure-caption", m.caption));
        if (m.live) block.classList.add("live");
        block.dataset.figure = m.id;
        this.append(block);
        renderFigure(canvas, m.kind, m.content).then(
          (update) => {
            if (m.live && update) {
              this.liveCharts.set(m.id, update);
              const pending = this.earlyRows.get(m.id);
              this.earlyRows.delete(m.id);
              if (pending) void update(pending);
            }
            this.scrollToEnd();
            vscode.postMessage({ type: "figureResult", tabId: this.id, id: m.id, ok: true });
          },
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            canvas.replaceChildren(div("notice error", `Figure could not be rendered (${m.kind}): ${message}`));
            vscode.postMessage({ type: "figureResult", tabId: this.id, id: m.id, ok: false, error: message });
          },
        );
        break;
      }
      case "figureStopped":
        this.liveCharts.delete(m.id);
        this.log.querySelector(`[data-figure="${m.id}"]`)?.classList.remove("live");
        break;
      case "figureData": {
        const update = this.liveCharts.get(m.id);
        if (update) void update(m.rows);
        else this.earlyRows.set(m.id, m.rows);
        break;
      }
      case "nowSpeaking":
        this.speakingEl?.classList.remove("speaking");
        this.speakingEl = m.ref ? this.spokenRefs.get(m.ref) : undefined;
        this.speakingEl?.classList.add("speaking");
        break;
      case "options":
        this.options = m.options;
        break;
      case "usage":
        this.usage = { used: m.used, size: m.size };
        break;
      case "title":
        this.title = m.title;
        break;
      case "commands":
        this.commands = m.commands;
        break;
      case "queued": {
        const bubble = div("message user queued", m.text + (m.images ? `  (+${m.images} image${m.images > 1 ? "s" : ""})` : ""));
        const bar = div("queued-bar");
        bar.appendChild(div("queued-label", "queued — sends when Claude finishes (Talk interrupts)"));
        const now = document.createElement("button");
        now.className = "secondary";
        now.textContent = "Send now";
        now.title = "Interrupt Claude and send this now";
        now.addEventListener("click", () => vscode.postMessage({ type: "sendNow", tabId: this.id, id: m.id }));
        const drop = document.createElement("button");
        drop.className = "secondary";
        drop.textContent = "✕";
        drop.title = "Remove from the queue";
        drop.addEventListener("click", () => vscode.postMessage({ type: "unqueue", tabId: this.id, id: m.id }));
        bar.append(now, drop);
        bubble.appendChild(bar);
        this.queuedBubbles.set(m.id, bubble);
        this.append(bubble);
        this.scrollToEnd(true);
        break;
      }
      case "dequeued":
        this.queuedBubbles.get(m.id)?.remove();
        this.queuedBubbles.delete(m.id);
        break;
      case "clear":
        this.endAgentMessage();
        this.log.replaceChildren();
        this.tools.clear();
        this.permissionCards.clear();
        this.liveCharts.clear();
        this.earlyRows.clear();
        this.queuedBubbles.clear();
        this.spokenRefs.clear();
        this.speakingEl = undefined;
        this.title = "";
        this.usage = undefined;
        this.pinned = true;
        this.showEmptyState();
        break;
      case "prefill":
        if (this.id === activeId) {
          input.value = m.text;
          autosize();
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
        break;
      case "notice":
        this.append(div("notice", m.text));
        break;
      case "error":
        this.endAgentMessage();
        this.append(div("notice error", m.text));
        break;
    }
  }
}

const views = new Map<string, TabView>();
let activeId = "";

function view(id: string): TabView {
  let v = views.get(id);
  if (!v) {
    v = new TabView(id);
    views.set(id, v);
  }
  return v;
}

function activeView(): TabView | undefined {
  return views.get(activeId);
}

// MARK: Tab strip and session bar

function renderTabs(tabs: TabSummary[]): void {
  tabList.replaceChildren();
  for (const t of tabs) {
    const tab = document.createElement("div");
    tab.className = "tab" + (t.id === activeId ? " active" : "") + (t.busy ? " busy" : "");
    tab.title = t.label;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(t.id === activeId));
    tab.tabIndex = t.id === activeId ? 0 : -1;
    tab.dataset.id = t.id;
    const label = div("tab-label");
    if (t.needsApproval) label.appendChild(div("tab-mark attention", "!"));
    else if (t.unread) label.appendChild(div("tab-mark unread"));
    if (t.project) label.appendChild(div("tab-project", t.project));
    label.appendChild(div("tab-title", t.title));
    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "✕";
    close.title = "Close this conversation";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "closeTab", id: t.id });
    });
    tab.append(label, close);
    tab.addEventListener("click", () => {
      if (t.id !== activeId) vscode.postMessage({ type: "switchTab", id: t.id });
    });
    tab.addEventListener("keydown", (e) => {
      const all = [...tabList.querySelectorAll<HTMLElement>(".tab")];
      const i = all.indexOf(tab);
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (t.id !== activeId) vscode.postMessage({ type: "switchTab", id: t.id });
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const next = all[(i + (e.key === "ArrowRight" ? 1 : -1) + all.length) % all.length];
        next.focus();
        vscode.postMessage({ type: "switchTab", id: next.dataset.id! });
      }
    });
    tabList.appendChild(tab);
  }
  const activeTab = tabList.querySelector<HTMLElement>(".tab.active");
  activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (document.activeElement?.classList.contains("tab")) activeTab?.focus();
}

let busyTimer: ReturnType<typeof setInterval> | undefined;

/** Shows the active tab's status, settings, usage and title in the shared header. */
function renderActiveHeader(): void {
  const v = activeView();
  if (busyTimer) clearInterval(busyTimer);
  busyTimer = undefined;
  if (!v) return;
  status.className = `status ${v.state}`;
  const showWorking = () => (status.textContent = `Working · ${Math.floor((Date.now() - v.busySince) / 1000)} s`);
  if (v.awaitingApproval) {
    status.className = "status approval";
    status.textContent = "Waiting for your approval";
  } else if (v.state === "busy") {
    showWorking();
    busyTimer = setInterval(showWorking, 1000);
  } else {
    const short: Record<string, string> = { ready: "", starting: "Starting…", error: "Couldn't start (see below)", stopped: "Stopped (see below)" };
    status.textContent = v.state === "starting" && v.detail ? v.detail : (short[v.state] ?? v.state);
    status.title = v.detail;
  }
  refreshStatusline();
  titleEl.textContent = v.title;
  titleEl.hidden = !v.title;
  renderOptions(v);
  if (v.usage) {
    const { used, size } = v.usage;
    const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);
    const ratio = size ? used / size : 0;
    usageEl.textContent = `${k(used)} / ${k(size)}`;
    usageEl.title = `${used.toLocaleString()} of ${size.toLocaleString()} tokens (${Math.round(ratio * 100)}%)`;
    usageEl.classList.toggle("high", ratio > 0.8);
  } else {
    usageEl.textContent = "";
  }
  updateControls();
}

function renderOptions(v: TabView): void {
  optionsEl.replaceChildren();
  for (const o of v.options) {
    if (o.id === "fast") {
      const label = document.createElement("label");
      label.className = "option-toggle";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = o.current === "on";
      box.addEventListener("change", () => vscode.postMessage({ type: "setOption", tabId: v.id, id: o.id, value: box.checked ? "on" : "off" }));
      label.append(box, document.createTextNode(` ${o.name}`));
      optionsEl.appendChild(label);
      continue;
    }
    const select = document.createElement("select");
    select.className = "option-select";
    select.title = o.name;
    for (const c of o.choices) {
      const opt = new Option(o.id === "model" ? c.name : `${o.name.toLowerCase()}: ${c.name}`, c.value, false, c.value === o.current);
      if (c.description) opt.title = c.description;
      select.add(opt);
    }
    select.addEventListener("change", () => vscode.postMessage({ type: "setOption", tabId: v.id, id: o.id, value: select.value }));
    optionsEl.appendChild(select);
  }
}

function showTab(id: string): void {
  if (id === activeId && views.get(id) && !views.get(id)!.log.hidden) return;
  const previous = activeView();
  if (previous) {
    previous.draft = input.value;
    previous.draftImages = pendingImages.splice(0);
  }
  const next = view(id);
  input.value = next.draft;
  autosize();
  pendingImages.push(...next.draftImages.splice(0));
  renderImageTray();
  activeId = id;
  for (const v of views.values()) v.log.hidden = v.id !== id;
  view(id).log.hidden = false;
  sessionMenu.hidden = true;
  renderActiveHeader();
  activeView()?.scrollToEnd();
}

// MARK: Message box: completion, images, history

const completer = new Completer(input);
completer.addSource((text, caret) => {
  const m = /^\/(\S*)$/.exec(text.slice(0, caret));
  if (!m) return undefined;
  const typed = m[1].toLowerCase();
  const items = (activeView()?.commands ?? [])
    .filter((c) => c.name.toLowerCase().includes(typed))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(typed)) - Number(!b.name.toLowerCase().startsWith(typed)))
    .map((c) => ({ label: `/${c.name}`, detail: c.hint ? `${c.hint} — ${c.description}` : c.description, insert: `/${c.name} ` }));
  return { start: 0, items };
});

/** @-completion: the extension searches the workspace for what was typed; results are cached per query. */
const fileResults = new Map<string, string[]>();
let lastFileQuery = "";
completer.addSource((text, caret) => {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!m) return undefined;
  const typed = m[1];
  if (typed !== lastFileQuery && !fileResults.has(typed)) {
    lastFileQuery = typed;
    vscode.postMessage({ type: "listFiles", query: typed });
  }
  const lower = typed.toLowerCase();
  const files = fileResults.get(typed) ?? fileResults.get(typed.slice(0, -1)) ?? [];
  const scored = files
    .map((f) => {
      const path = f.toLowerCase();
      const base = path.slice(path.lastIndexOf("/") + 1);
      const score = base.startsWith(lower) ? 0 : base.includes(lower) ? 1 : path.includes(lower) ? 2 : -1;
      return { f, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.f.length - b.f.length);
  const items = scored.slice(0, 50).map(({ f }) => ({ label: f.slice(f.lastIndexOf("/") + 1), detail: f, insert: `@${f} ` }));
  return { start: caret - typed.length - 1, items };
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
  if (pendingImages.length >= MAX_IMAGES) return void activeView()?.append(div("notice", `At most ${MAX_IMAGES} images per message.`));
  if (file.size > MAX_IMAGE_BYTES) return void activeView()?.append(div("notice", "Images over 5 MB are not attached."));
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

// MARK: Voice state

/** What the speech line says in each voice state; idle says nothing. */
const VOICE_LABELS: Record<string, string> = {
  loading: "Speech loading…",
  idle: "",
  warming: "Starting mic…",
  listening: "Listening. Press the mic when you're done.",
  speaking: "Speaking",
  interrupted: "Paused while you speak",
  unavailable: "Speech unavailable",
};
const ICON_STOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';
const ICON_DISCARD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';

/** Shows the status line only while it has something to say. */
function refreshStatusline(): void {
  const line = status.parentElement!;
  line.hidden = !status.textContent && !voiceChip.textContent;
}

/** The message box grows with its content, up to about eight lines. */
function autosize(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}
input.addEventListener("input", autosize);
let voiceUsable = false;
let voiceUnavailableReason = "";
let listening = false;
let speaking = false;
let micTitle = "";

function updateControls(): void {
  const v = activeView();
  const ready = !!v && (v.state === "ready" || v.state === "busy");
  const busy = v?.state === "busy";
  sendButton.disabled = !ready;
  sendButton.classList.toggle("queue", busy);
  sendButton.title = busy ? "Queue: sends when Claude finishes (Enter)" : "Send (Enter)";
  sendButton.setAttribute("aria-label", busy ? "Queue" : "Send");
  stopButton.disabled = !busy && !listening && !speaking;
  stopButton.innerHTML = listening ? ICON_DISCARD : ICON_STOP;
  const stopLabel = listening ? "Discard this recording" : busy ? "Stop Claude" : "Stop speaking";
  stopButton.title = `${stopLabel} (Ctrl+Shift+Backspace)`;
  stopButton.setAttribute("aria-label", stopLabel);
  input.disabled = !ready;
  talkButton.disabled = !ready || !voiceUsable;
  talkButton.classList.toggle("listening", listening);
  talkButton.classList.toggle("speaking", speaking);
  const talkLabel = listening
    ? "Done: send what you said"
    : voiceUsable
      ? "Talk"
      : `Voice input unavailable: ${voiceUnavailableReason || "microphone not available"}`;
  talkButton.title = `${talkLabel} (Ctrl+Shift+Space)${micTitle && voiceUsable ? ` · ${micTitle}` : ""}`;
  talkButton.setAttribute("aria-label", talkLabel);
}

function send(): void {
  const v = activeView();
  const text = input.value.trim();
  if (!v || (!text && !pendingImages.length) || !(v.state === "ready" || v.state === "busy")) return;
  remember(text);
  input.value = "";
  autosize();
  const images = pendingImages.splice(0).map(({ mimeType, data }) => ({ mimeType, data }));
  renderImageTray();
  vscode.postMessage({ type: "send", tabId: v.id, text: text || "(see attached image)", images });
}

// MARK: Messages from the extension

function applyPanel(m: PanelMessage): void {
  switch (m.type) {
    case "tabs":
      for (const t of m.tabs) view(t.id);
      for (const id of [...views.keys()]) {
        if (!m.tabs.some((t) => t.id === id)) {
          views.get(id)!.log.remove();
          views.delete(id);
        }
      }
      showTab(m.activeId);
      renderTabs(m.tabs);
      break;
    case "voice": {
      voiceUsable = m.microphone && m.state !== "loading" && m.state !== "unavailable";
      listening = m.state === "listening";
      speaking = m.state === "speaking";
      const autoListen = document.getElementById("conversation")!;
      autoListen.classList.toggle("on", m.conversation);
      autoListen.setAttribute("aria-pressed", String(m.conversation));
      autoListen.title = `Auto-listen is ${m.conversation ? "on" : "off"}: after Claude finishes speaking, the mic opens for your answer and a pause sends it`;
      voiceChip.className = `voice ${m.state}`;
      micTitle = m.detail?.startsWith("mic: ") ? m.detail : "";
      const shownDetail = m.detail && !m.detail.startsWith("mic: ") ? `: ${m.detail}` : "";
      voiceChip.textContent =
        (m.state === "listening" && m.autoListening ? "Listening for your reply. Pause to send." : (VOICE_LABELS[m.state] ?? m.state)) + (VOICE_LABELS[m.state] === "" ? "" : shownDetail);
      if (m.state !== "listening" && m.state !== "interrupted") talkButton.style.setProperty("--level", "0");
      voiceUnavailableReason = m.state === "unavailable" ? (m.detail ?? "the voice process stopped") : m.state === "loading" ? "voice is still loading" : "";
      if (m.state === "unavailable") {
        const restart = document.createElement("button");
        restart.className = "secondary voice-restart";
        restart.textContent = "Restart voice";
        restart.addEventListener("click", () => vscode.postMessage({ type: "restartVoice" }));
        voiceChip.appendChild(restart);
      }
      speakButton.classList.toggle("on", m.speak);
      speakButton.setAttribute("aria-pressed", String(m.speak));
      speakButton.title = m.speak ? "Replies are spoken aloud (click to mute)" : "Replies are muted (click to speak them)";
      updateControls();
      refreshStatusline();
      break;
    }
    case "level": {
      // -60 dBFS (silence) .. -10 dBFS (loud speech) drives the mic's level ring, 0..1.
      const level = Math.max(0, Math.min(1, (m.db + 60) / 50));
      talkButton.style.setProperty("--level", level.toFixed(2));
      break;
    }
    case "partial":
      partial.hidden = !m.text;
      partial.textContent = m.text;
      partial.className = `partial ${m.source ?? ""}`;
      break;
    case "files":
      fileResults.set(m.query, m.files);
      completer.refresh();
      break;
    case "sessions": {
      sessionList.replaceChildren();
      if (!m.items.length) sessionList.appendChild(div("notice", "No conversations yet."));
      for (const item of m.items) {
        const row = document.createElement("button");
        row.className = "session-item" + (item.openInTab ? " current" : "");
        const name = document.createElement("span");
        name.className = "session-title";
        name.textContent = item.title;
        const when = document.createElement("span");
        when.className = "session-time";
        when.textContent = item.openInTab ? "open in a tab" : relativeTime(item.updatedAt);
        row.append(name, when);
        row.addEventListener("click", () => {
          sessionMenu.hidden = true;
          vscode.postMessage({ type: "openSession", id: item.id });
        });
        sessionList.appendChild(row);
      }
      sessionMenu.hidden = false;
      break;
    }
    case "notice":
      activeView()?.append(div("notice", m.text));
      break;
    case "focusInput":
      input.focus();
      break;
  }
}

/** The end of the text that is safe to render once: the last blank line outside a code fence. */
function stableCut(text: string): number {
  let cut = 0;
  let inFence = false;
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text[i] !== "\n") continue;
    const line = text.slice(lineStart, i);
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    else if (!inFence && line.trim() === "" && i < text.length) cut = i + 1;
    lineStart = i + 1;
  }
  return cut;
}

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const m = event.data;
  if ("tabId" in m) {
    view(m.tabId).apply(m);
    if (m.tabId === activeId && ["state", "options", "usage", "title", "clear", "permission", "permissionDone"].includes(m.type)) renderActiveHeader();
  } else {
    applyPanel(m);
  }
});

// MARK: Controls

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
sendButton.addEventListener("click", () => {
  send();
  input.focus();
});
stopButton.addEventListener("click", () => {
  if (activeId) vscode.postMessage({ type: "stop", tabId: activeId });
  input.focus();
});
talkButton.addEventListener("click", () => {
  vscode.postMessage({ type: "talk" });
  input.focus();
});
document.getElementById("new-tab")!.addEventListener("click", () => vscode.postMessage({ type: "newTab" }));
document.getElementById("sessions")!.addEventListener("click", () => {
  if (!sessionMenu.hidden) {
    sessionMenu.hidden = true;
    return;
  }
  vscode.postMessage({ type: "listSessions" });
});
document.getElementById("session-close")!.addEventListener("click", () => (sessionMenu.hidden = true));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !sessionMenu.hidden) {
    sessionMenu.hidden = true;
    input.focus();
  }
});
document.getElementById("session-new")!.addEventListener("click", () => {
  sessionMenu.hidden = true;
  vscode.postMessage({ type: "newTab" });
});
speakButton.addEventListener("click", () => vscode.postMessage({ type: "toggleSpeak" }));
document.getElementById("conversation")!.addEventListener("click", () => vscode.postMessage({ type: "toggleConversation" }));
/** Restart wipes the conversation, so it takes a second click within 3 seconds. */
let restartArmed: ReturnType<typeof setTimeout> | undefined;
restartButton.addEventListener("click", () => {
  if (!restartArmed) {
    restartButton.textContent = "Click again to restart";
    restartArmed = setTimeout(() => {
      restartArmed = undefined;
      restartButton.textContent = "Restart this conversation";
    }, 3000);
    return;
  }
  clearTimeout(restartArmed);
  restartArmed = undefined;
  restartButton.textContent = "Restart this conversation";
  sessionMenu.hidden = true;
  if (activeId) vscode.postMessage({ type: "restart", tabId: activeId });
});

updateControls();
vscode.postMessage({ type: "ready" });
