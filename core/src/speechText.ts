/**
 * Turns streamed markdown into sentences worth speaking. Content inside any
 * fenced block (code, `onscreen`) and table rows is never spoken. Complete
 * sentences are released as soon as they appear mid-line, so speech can start
 * before a paragraph finishes streaming.
 */
export class SpeechChunker {
  private line = "";
  private prose = "";
  private inFence = false;
  private firstReleased = false;

  /** Feeds streamed text; returns sentences now ready to speak. */
  push(chunk: string): string[] {
    this.line += chunk;
    let nl: number;
    while ((nl = this.line.indexOf("\n")) >= 0) {
      const complete = this.line.slice(0, nl);
      this.line = this.line.slice(nl + 1);
      this.takeLine(complete);
    }
    this.takeEagerSentences();
    return this.drainSentences(false);
  }

  /** Releases everything pending, e.g. at a tool call or the end of a turn. */
  flush(): string[] {
    if (this.line) {
      this.takeLine(this.line);
      this.line = "";
    }
    return this.drainSentences(true);
  }

  reset(): void {
    this.line = "";
    this.prose = "";
    this.inFence = false;
    this.firstReleased = false;
  }

  private takeLine(raw: string): void {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      this.inFence = !this.inFence;
      this.prose += " \n\n";
      return;
    }
    if (this.inFence || trimmed.startsWith("|")) return;
    if (trimmed === "") {
      this.prose += " \n\n";
      return;
    }
    this.prose += " " + cleanMarkdown(raw);
  }

  /** Moves complete sentences out of the unfinished current line. */
  private takeEagerSentences(): void {
    const trimmed = this.line.trimStart();
    if (this.inFence || trimmed.length < 4 || trimmed.startsWith("```") || trimmed.startsWith("~~~") || trimmed.startsWith("|")) return;
    let cut = -1;
    const boundary = /[.!?]["')\]]*\s/g;
    let m: RegExpExecArray | null;
    while ((m = boundary.exec(this.line))) cut = m.index + m[0].length;
    if (cut < 0) return;
    this.prose += " " + cleanMarkdown(this.line.slice(0, cut));
    this.line = this.line.slice(cut);
  }

  private drainSentences(all: boolean): string[] {
    const out: string[] = [];
    // Paragraph breaks always end a sentence; only the last paragraph can still be growing.
    const paragraphs = this.prose.split(/\s*\n\n\s*/);
    const open = all ? "" : (paragraphs.pop() ?? "");
    for (const p of paragraphs) {
      const { sentences, rest } = splitSentences(p);
      out.push(...sentences, rest);
    }
    if (all) {
      this.prose = "";
    } else {
      const { sentences, rest } = splitSentences(open);
      out.push(...sentences);
      this.prose = rest;
      if (rest.length > 300) {
        // A very long clause with no sentence end: speak up to its last comma.
        const comma = rest.lastIndexOf(", ");
        if (comma > 40) {
          out.push(rest.slice(0, comma + 1));
          this.prose = rest.slice(comma + 1);
        }
      }
    }
    return this.splitFirst(out.map(tidy).filter(isSpeakable));
  }

  /**
   * Speech can start once the first chunk is synthesized, and synthesis time grows with
   * length; so a long first sentence of a turn is split at its first comma.
   */
  private splitFirst(sentences: string[]): string[] {
    if (this.firstReleased || sentences.length === 0) return sentences;
    this.firstReleased = true;
    const [first, ...rest] = sentences;
    if (first.length <= 90) return sentences;
    const comma = first.indexOf(", ", 25);
    if (comma < 0 || first.length - comma < 20) return sentences;
    return [first.slice(0, comma + 1), first.slice(comma + 2), ...rest];
  }
}

/** Complete sentences (ending in . ! or ? before whitespace or the end) and the unfinished rest. */
export function splitSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  const end = /[.!?]+["')\]]*(?=\s|$)/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = end.exec(text))) {
    const stop = m.index + m[0].length;
    sentences.push(text.slice(start, stop));
    start = stop;
  }
  return { sentences, rest: text.slice(start) };
}

/** Strips markdown syntax and makes inline code pronounceable. */
export function cleanMarkdown(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, (_, code: string) => speakableCode(code))
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/\b(\w+)\.(py|ts|js|mjs|swift|md|json|yaml|toml|txt|sh)\b/g, (_, name: string, ext: string) => `${name} dot ${ext}`)
    .replace(/\b([A-Za-z]\w*)_(?=\w)/g, "$1 ")
    .replace(/(\w)_(?=\w)/g, "$1 ")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|\W)\*(\S[^*]*?)\*(?=\W|$)/g, "$1$2")
    .replace(/[*#]/g, "");
}

function speakableCode(code: string): string {
  return code
    .replace(/\(\)/g, "")
    .replace(/(\w)\.(\w)/g, "$1 dot $2")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function isSpeakable(s: string): boolean {
  return /[A-Za-z0-9]/.test(s);
}
