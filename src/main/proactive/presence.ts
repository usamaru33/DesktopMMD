// Is the user at the PC? Away after a few minutes without input (or the PC sleeping / locked); back on
// the first input after that. Pure; fed by powerMonitor (spec 4.3 放置反応).

/** without input this long, the user counts as away */
export const AWAY_AFTER_SEC = 5 * 60;
/** input within this many seconds counts as "back" */
const BACK_WITHIN_SEC = 5;
/** away this long: she has dozed off (drowsy from 10 min, asleep at 30 min) */
export const ASLEEP_AFTER_MS = 30 * 60_000;

export interface Returned {
  awayMs: number;
  /** she had fallen asleep while waiting */
  asleep: boolean;
}

/** Drowsiness (0..1) for how long there has been no input: drowsy after 10 min, asleep at 30 min. */
export function sleepinessFor(idleSec: number): number {
  const m = idleSec / 60;
  return m < 10 ? 0 : m >= 30 ? 1 : 0.3 + ((m - 10) / 20) * 0.6;
}

export class PresenceTracker {
  private awaySince: number | null = null;

  get away(): boolean {
    return this.awaySince !== null;
  }

  /** Poll with the system idle time. Returns once when the user comes back. */
  update(idleSec: number, now: number): Returned | null {
    if (this.awaySince === null) {
      if (idleSec >= AWAY_AFTER_SEC) this.awaySince = now - idleSec * 1000;
      return null;
    }
    if (idleSec < BACK_WITHIN_SEC) return this.back(now);
    return null;
  }

  /** The PC went to sleep or was locked: away from then (if not already). */
  leave(now: number): void {
    if (this.awaySince === null) this.awaySince = now;
  }

  /** Back for sure (screen unlocked, or the user touched the character): returns the away info if away. */
  back(now: number): Returned | null {
    if (this.awaySince === null) return null;
    const awayMs = Math.max(0, now - this.awaySince);
    this.awaySince = null;
    return { awayMs, asleep: awayMs >= ASLEEP_AFTER_MS };
  }
}
