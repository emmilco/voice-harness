import { diffLines } from "diff";
import type MarkdownItConstructor from "markdown-it";

type MarkdownIt = InstanceType<typeof MarkdownItConstructor>;
import type { ToolContentView } from "../src/protocol";

/** Monochrome glyphs (they take the text colour), one per kind of tool call. */
const ICONS: Record<string, string> = {
  execute: "$",
  read: "≡",
  edit: "✎",
  delete: "⌫",
  move: "↦",
  search: "⌕",
  fetch: "⇣",
  think: "∴",
  switch_mode: "⇄",
  other: "•",
};

interface ToolState {
  title?: string;
  kind?: string;
  status?: string;
  content?: ToolContentView[];
  startedAt: number;
  endedAt?: number;
  /** Set once the user toggles the card, after which automatic opening stops. */
  userToggled: boolean;
  card: HTMLElement;
  header: HTMLElement;
  body: HTMLElement;
}

/** The icon shown for a tool call of this kind. */
export function toolIcon(kind: string | undefined): string {
  return ICONS[kind ?? "other"] ?? ICONS.other;
}

export type OpenDiff = (path: string, oldText: string | null, newText: string) => void;

/** Tool-call cards: a one-line header that expands to the call's output or diff. */
export class ToolCards {
  private readonly cards = new Map<string, ToolState>();

  constructor(
    private readonly md: MarkdownIt,
    private readonly openDiff: OpenDiff,
  ) {}

  /** Creates or updates a card; returns the element when it was newly created. */
  update(id: string, patch: { title?: string; kind?: string; status?: string; content?: ToolContentView[] }): HTMLElement | undefined {
    let state = this.cards.get(id);
    let created: HTMLElement | undefined;
    if (!state) {
      const card = el("div", "tool-card");
      const header = el("button", "tool-head");
      const body = el("div", "tool-body");
      body.hidden = true;
      card.append(header, body);
      state = { startedAt: Date.now(), userToggled: false, card, header, body };
      header.addEventListener("click", () => {
        state!.userToggled = true;
        body.hidden = !body.hidden;
        card.classList.toggle("open", !body.hidden);
      });
      this.cards.set(id, state);
      created = card;
    }
    if (patch.title) state.title = patch.title;
    if (patch.kind) state.kind = patch.kind;
    if (patch.content) state.content = patch.content;
    if (patch.status) {
      state.status = patch.status;
      if ((patch.status === "completed" || patch.status === "failed") && !state.endedAt) state.endedAt = Date.now();
    }
    this.render(state);
    return created;
  }

  clear(): void {
    this.cards.clear();
  }

  private render(s: ToolState): void {
    const done = s.status === "completed";
    const failed = s.status === "failed";
    const mark = failed ? "✗" : done ? "✓" : "…";
    // Durations under a tenth of a second (including replayed history) say nothing useful.
    const elapsed = s.endedAt ? (s.endedAt - s.startedAt) / 1000 : 0;
    const seconds = elapsed >= 0.1 ? `${elapsed.toFixed(1)} s` : "";
    s.header.replaceChildren(
      el("span", "tool-icon", ICONS[s.kind ?? "other"] ?? ICONS.other),
      el("span", "tool-title", s.title ?? "Tool"),
      el("span", `tool-status ${failed ? "failed" : done ? "done" : "running"}`, `${mark} ${seconds}`.trim()),
    );
    s.card.classList.toggle("failed", failed);
    const hasBody = !!s.content?.length;
    s.header.classList.toggle("expandable", hasBody);
    if (!hasBody) return;
    renderToolContent(s.body, s.content!, this.md, this.openDiff);
    if (!s.userToggled && (failed || s.content!.some((c) => c.kind === "diff"))) {
      s.body.hidden = false;
      s.card.classList.add("open");
    }
  }
}

/** Renders tool content (markdown text and diffs) into `target`, replacing what was there. */
export function renderToolContent(target: HTMLElement, content: ToolContentView[], md: MarkdownIt, openDiff: OpenDiff): void {
  target.replaceChildren();
  for (const item of content) {
    if (item.kind === "text") {
      const text = el("div", "tool-text");
      text.innerHTML = md.render(item.text.length > 20_000 ? item.text.slice(0, 20_000) + "\n… (output truncated)" : item.text);
      target.appendChild(text);
    } else {
      target.appendChild(renderDiff(item.path, item.oldText, item.newText, openDiff));
    }
  }
}

function renderDiff(path: string, oldText: string | null, newText: string, openDiff: OpenDiff): HTMLElement {
  const box = el("div", "diff");
  const head = el("div", "diff-head");
  head.appendChild(el("span", "diff-file", path.split("/").pop() ?? path));
  const open = el("button", "secondary diff-open", "Open diff");
  open.addEventListener("click", () => openDiff(path, oldText, newText));
  head.appendChild(open);
  box.appendChild(head);
  const lines = el("pre", "diff-lines");
  for (const part of diffLines(oldText ?? "", newText)) {
    const kind = part.added ? "add" : part.removed ? "del" : "ctx";
    const sign = part.added ? "+" : part.removed ? "-" : " ";
    for (const line of part.value.replace(/\n$/, "").split("\n")) {
      lines.appendChild(el("div", `diff-line ${kind}`, `${sign} ${line}`));
    }
  }
  box.appendChild(lines);
  return box;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
