// Timers and reminders (FR-TL-05). Persisted in SQLite so they survive restarts.
import { LIMITS } from '@shared/defaults';
import type { Store } from '../store/repos';
import type { TimerPort } from '../tools/builtin/assistantTools';

export class TimerService implements TimerPort {
  private handles = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: Store,
    private readonly onFire: (label: string, kind: 'timer' | 'reminder') => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Re-arm pending timers after start; overdue ones fire immediately. */
  start(): void {
    for (const t of this.store.timers.pending()) this.arm(t.id, t.kind, t.label, new Date(t.fireAt));
  }

  add(kind: 'timer' | 'reminder', label: string, fireAt: Date): { ok: true; id: number } | { ok: false; error: string } {
    if (this.store.timers.pending().length >= LIMITS.maxTimers) return { ok: false, error: `同時に設定できるのは${LIMITS.maxTimers}件までです` };
    const id = this.store.timers.add(kind, label, fireAt);
    this.arm(id, kind, label, fireAt);
    return { ok: true, id };
  }

  list() {
    return this.store.timers.pending();
  }

  cancel(id: number): boolean {
    const h = this.handles.get(id);
    if (h) clearTimeout(h);
    this.handles.delete(id);
    return this.store.timers.cancel(id);
  }

  private arm(id: number, kind: 'timer' | 'reminder', label: string, at: Date): void {
    // setTimeout caps at ~24.8 days; re-arm in steps
    const delay = Math.max(0, at.getTime() - this.now().getTime());
    const step = Math.min(delay, 2 ** 31 - 1);
    const h = setTimeout(() => {
      if (step < delay) return this.arm(id, kind, label, at);
      this.handles.delete(id);
      this.store.timers.fired(id);
      this.onFire(label, kind);
    }, step);
    this.handles.set(id, h);
  }

  stop(): void {
    for (const h of this.handles.values()) clearTimeout(h);
    this.handles.clear();
  }
}
