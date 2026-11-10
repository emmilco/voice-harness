/** One completion: what the list shows and what replaces the typed trigger. */
export interface Completion {
  label: string;
  detail?: string;
  insert: string;
}

/**
 * Finds what the user is completing at the caret: returns the start index of the trigger
 * text being replaced and the items to offer, or undefined for no completion.
 */
export type CompletionSource = (text: string, caret: number) => { start: number; items: Completion[] } | undefined;

/**
 * A completion popup above a textarea. ↑/↓ move, Tab or Enter accept, Esc closes. Several
 * sources can be registered (slash commands, @-mentions); the first that matches wins.
 */
export class Completer {
  private readonly list: HTMLElement;
  private items: Completion[] = [];
  private start = 0;
  private selected = 0;
  private readonly sources: CompletionSource[] = [];

  constructor(private readonly input: HTMLTextAreaElement) {
    this.list = document.createElement("div");
    this.list.className = "completions";
    this.list.hidden = true;
    input.parentElement!.insertBefore(this.list, input);
    input.addEventListener("input", () => this.refresh());
    input.addEventListener("click", () => this.refresh());
    input.addEventListener("blur", () => setTimeout(() => this.close(), 150));
  }

  addSource(source: CompletionSource): void {
    this.sources.push(source);
  }

  get open(): boolean {
    return !this.list.hidden;
  }

  /** Handles navigation keys while open; returns true when the key was used. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      this.selected = (this.selected + (e.key === "ArrowDown" ? 1 : -1) + this.items.length) % this.items.length;
      this.render();
      return true;
    }
    if (e.key === "Enter" && !e.shiftKey && this.items.length === 1 && this.input.value.trim() === this.items[0].insert.trim()) {
      // Already fully typed: let Enter send the message.
      this.close();
      return false;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      this.accept(this.selected);
      return true;
    }
    if (e.key === "Escape") {
      this.close();
      return true;
    }
    return false;
  }

  refresh(): void {
    const caret = this.input.selectionStart ?? this.input.value.length;
    for (const source of this.sources) {
      const found = source(this.input.value, caret);
      if (found && found.items.length) {
        this.items = found.items.slice(0, 50);
        this.start = found.start;
        this.selected = 0;
        this.render();
        return;
      }
    }
    this.close();
  }

  close(): void {
    this.list.hidden = true;
    this.items = [];
  }

  private accept(index: number): void {
    const item = this.items[index];
    if (!item) return;
    const caret = this.input.selectionStart ?? this.input.value.length;
    const value = this.input.value;
    this.input.value = value.slice(0, this.start) + item.insert + value.slice(caret);
    const at = this.start + item.insert.length;
    this.input.setSelectionRange(at, at);
    this.close();
    this.input.focus();
  }

  private render(): void {
    this.list.replaceChildren();
    this.items.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "completion" + (i === this.selected ? " selected" : "");
      const label = document.createElement("span");
      label.className = "completion-label";
      label.textContent = item.label;
      row.appendChild(label);
      if (item.detail) {
        const detail = document.createElement("span");
        detail.className = "completion-detail";
        detail.textContent = item.detail;
        row.appendChild(detail);
      }
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.accept(i);
      });
      this.list.appendChild(row);
    });
    this.list.hidden = false;
    this.list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  }
}
