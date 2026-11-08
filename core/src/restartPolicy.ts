/**
 * When a crashed helper process should be restarted: after a short, growing delay, unless it has
 * already been restarted `maxRestarts` times within `windowMs` (a persistent fault, not a crash).
 */
export class RestartPolicy {
  private readonly restarts: number[] = [];

  constructor(
    private readonly maxRestarts = 3,
    private readonly windowMs = 120_000,
  ) {}

  /** Records a crash at `now`; returns the delay before restarting, or null to give up. */
  next(now = Date.now()): number | null {
    while (this.restarts.length && now - this.restarts[0] > this.windowMs) this.restarts.shift();
    if (this.restarts.length >= this.maxRestarts) return null;
    this.restarts.push(now);
    return 1000 * this.restarts.length;
  }

  /** Forgets past crashes, e.g. after a manual restart. */
  reset(): void {
    this.restarts.length = 0;
  }
}
