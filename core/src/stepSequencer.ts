/**
 * Delivers numbered walkthrough steps in order. Tool calls issued in parallel can
 * arrive slightly out of order, so a step that arrives ahead of its predecessor is
 * held until the gap fills or `waitMs` passes; then held steps go out in step order.
 * Step 1 starts a new walkthrough. Unnumbered steps are delivered at once.
 */
export class StepSequencer<T> {
  private expected = 1;
  private readonly held = new Map<number, T>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly deliver: (item: T) => void,
    private readonly waitMs = 400,
  ) {}

  push(item: T, step?: number): void {
    if (step === undefined) {
      this.deliver(item);
      return;
    }
    if (step === 1) {
      this.releaseHeld();
      this.expected = 1;
    }
    if (step < this.expected) {
      this.deliver(item);
      return;
    }
    if (step > this.expected) {
      this.held.set(step, item);
      this.timer ??= setTimeout(() => this.releaseHeld(), this.waitMs);
      return;
    }
    this.deliver(item);
    this.expected++;
    while (this.held.has(this.expected)) {
      this.deliver(this.held.get(this.expected)!);
      this.held.delete(this.expected);
      this.expected++;
    }
    if (this.held.size === 0) this.clearTimer();
  }

  /** Forgets held steps and expects a new walkthrough. */
  reset(): void {
    this.clearTimer();
    this.held.clear();
    this.expected = 1;
  }

  private releaseHeld(): void {
    this.clearTimer();
    const steps = [...this.held.keys()].sort((a, b) => a - b);
    for (const s of steps) this.deliver(this.held.get(s)!);
    this.held.clear();
    if (steps.length) this.expected = steps[steps.length - 1] + 1;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
