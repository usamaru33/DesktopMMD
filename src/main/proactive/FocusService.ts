// 集中モード（ポモドーロ）: for N minutes the assistant stays quiet (no greetings, break hints, small talk —
// only timers the user set), and when time is up she says お疲れさま and suggests a short break.
// In-memory on purpose: a restart of the app ends the session (nobody wants a stale "focus" to outlive the PC).
export interface FocusState {
  startedAt: Date;
  endsAt: Date;
  minutes: number;
}

export interface FocusPort {
  start(minutes: number): { ok: true; endsAt: Date; replaced: boolean } | { ok: false; error: string };
  stop(): { ok: true; remainingMin: number } | { ok: false; error: string };
  status(): { active: false } | { active: true; minutes: number; remainingMin: number; endsAt: Date };
}

export const FOCUS_LIMITS = { minMinutes: 1, maxMinutes: 180, defaultMinutes: 25 } as const;

export interface FocusDeps {
  /** time is up (not called when the user stops early) */
  onEnd(minutes: number): void;
  /** the state changed (start / stop / end): refresh the tray, tell the user… */
  onChange?(): void;
  now?(): Date;
}

export class FocusService implements FocusPort {
  private state: FocusState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => Date;

  constructor(private readonly d: FocusDeps) {
    this.now = d.now ?? (() => new Date());
  }

  /** The suppression input for ProactiveEngine. */
  get active(): boolean {
    return this.state !== null && this.state.endsAt.getTime() > this.now().getTime();
  }

  get current(): FocusState | null {
    return this.active ? this.state : null;
  }

  start(minutes: number): { ok: true; endsAt: Date; replaced: boolean } | { ok: false; error: string } {
    if (!Number.isFinite(minutes)) return { ok: false, error: '時間を指定してください' };
    const m = Math.round(minutes);
    if (m < FOCUS_LIMITS.minMinutes || m > FOCUS_LIMITS.maxMinutes) {
      return { ok: false, error: `集中モードは${FOCUS_LIMITS.minMinutes}〜${FOCUS_LIMITS.maxMinutes}分で指定してください` };
    }
    const replaced = this.active;
    this.clear();
    const startedAt = this.now();
    const endsAt = new Date(startedAt.getTime() + m * 60_000);
    this.state = { startedAt, endsAt, minutes: m };
    this.timer = setTimeout(() => this.finish(), m * 60_000);
    this.timer.unref?.();
    this.d.onChange?.();
    return { ok: true, endsAt, replaced };
  }

  stop(): { ok: true; remainingMin: number } | { ok: false; error: string } {
    const cur = this.current;
    if (!cur) return { ok: false, error: '集中モードは始まっていません' };
    const remainingMin = Math.max(0, Math.ceil((cur.endsAt.getTime() - this.now().getTime()) / 60_000));
    this.clear();
    this.d.onChange?.();
    return { ok: true, remainingMin };
  }

  status(): { active: false } | { active: true; minutes: number; remainingMin: number; endsAt: Date } {
    const cur = this.current;
    if (!cur) return { active: false };
    return { active: true, minutes: cur.minutes, remainingMin: Math.max(0, Math.ceil((cur.endsAt.getTime() - this.now().getTime()) / 60_000)), endsAt: cur.endsAt };
  }

  private finish(): void {
    const minutes = this.state?.minutes;
    this.clear();
    this.d.onChange?.();
    if (minutes) this.d.onEnd(minutes);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state = null;
  }

  dispose(): void {
    this.clear();
  }
}
