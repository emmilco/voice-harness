/** What the user is looking at in their editor when they send a turn. */
export interface EditorContext {
  /** Path relative to the workspace when inside it, otherwise absolute. */
  file: string;
  /** 1-based line of the cursor. */
  cursorLine: number;
  /** Visible line range, 1-based inclusive. */
  visible?: { start: number; end: number };
  /** The selection, when not empty. */
  selection?: { start: number; end: number; text: string };
}

const MAX_SELECTION_CHARS = 4000;

/**
 * The block prefixed to a user turn so the agent can resolve "this", "here" and "these lines".
 * Long selections are truncated; the agent can read the file for more.
 */
export function formatEditorContext(ctx: EditorContext): string {
  const lines = [`file: ${ctx.file}`];
  if (ctx.visible) lines.push(`visible: lines ${ctx.visible.start}-${ctx.visible.end}`);
  lines.push(`cursor: line ${ctx.cursorLine}`);
  if (ctx.selection) {
    const { start, end, text } = ctx.selection;
    const shown = text.length > MAX_SELECTION_CHARS ? `${text.slice(0, MAX_SELECTION_CHARS)}\n… (selection truncated)` : text;
    const fence = shown.includes("```") ? "~~~~" : "```";
    lines.push(`selection: lines ${start}-${end}`, fence, shown, fence);
  }
  return `<editor-context>\n${lines.join("\n")}\n</editor-context>`;
}

/** A short label for the chat, e.g. "model.py:52" or "model.py:50-55". */
export function editorContextLabel(ctx: EditorContext): string {
  const name = ctx.file.split("/").pop() ?? ctx.file;
  return ctx.selection ? `${name}:${ctx.selection.start}-${ctx.selection.end}` : `${name}:${ctx.cursorLine}`;
}
