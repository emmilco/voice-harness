/** Words that, at the end of what has been said so far, suggest the speaker isn't finished. */
const CONTINUATION_WORDS = new Set([
  "and", "but", "or", "so", "because", "if", "then", "that", "which", "who", "when", "while",
  "the", "a", "an", "of", "to", "with", "for", "in", "on", "at", "from", "about", "like",
  "is", "are", "was", "were", "my", "your", "this", "these", "um", "uh", "er", "hmm",
]);

/** True when a transcript so far ends mid-thought: a trailing comma or a continuation word. */
export function endsMidThought(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || /[.?!]["')\]]*$/.test(trimmed)) return false;
  if (trimmed.endsWith(",")) return true;
  const last = trimmed.toLowerCase().match(/([a-z']+)\W*$/)?.[1] ?? "";
  return CONTINUATION_WORDS.has(last);
}

export interface AutoTurnTimings {
  /** Silence after speech ends before the turn ends, counted from the speech-end event. */
  pauseMs: number;
  /** The same when the words so far end mid-thought. */
  midThoughtPauseMs: number;
  /** Give up if no speech starts within this time of listening. */
  noSpeechMs: number;
}

/** speechEnd arrives after ~0.7 s of silence, so these mean about 1.7 s, 3.2 s and 8 s of quiet. */
export const DEFAULT_AUTO_TURN: AutoTurnTimings = { pauseMs: 1000, midThoughtPauseMs: 2500, noSpeechMs: 8000 };

/**
 * Ends a hands-free user turn on a pause. Feed it speech start/end events and the running
 * transcript; it calls `end` when the user has paused long enough, or `giveUp` if they never
 * start speaking.
 */
export class AutoTurnEnder {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private partial = "";
  private pauseStartedAt = 0;

  constructor(
    private readonly end: () => void,
    private readonly giveUp: () => void,
    private readonly timings: AutoTurnTimings = DEFAULT_AUTO_TURN,
  ) {}

  get running(): boolean {
    return this.active;
  }

  start(): void {
    this.active = true;
    this.partial = "";
    this.schedule(this.timings.noSpeechMs, () => this.finish(this.giveUp));
  }

  stop(): void {
    this.active = false;
    this.clear();
  }

  speechStart(): void {
    if (this.active) this.clear();
  }

  speechEnd(): void {
    if (!this.active) return;
    this.pauseStartedAt = Date.now();
    this.schedule(this.timings.pauseMs, () => this.pauseElapsed());
  }

  partialText(text: string): void {
    this.partial = text;
  }

  /** The transcript can settle after speech ends, so whether it ends mid-thought is checked when the pause elapses. */
  private pauseElapsed(): void {
    const waited = Date.now() - this.pauseStartedAt;
    if (endsMidThought(this.partial) && waited < this.timings.midThoughtPauseMs) {
      this.schedule(this.timings.midThoughtPauseMs - waited, () => this.finish(this.end));
    } else {
      this.finish(this.end);
    }
  }

  private finish(callback: () => void): void {
    if (!this.active) return;
    this.stop();
    callback();
  }

  private schedule(ms: number, fn: () => void): void {
    this.clear();
    this.timer = setTimeout(fn, ms);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
