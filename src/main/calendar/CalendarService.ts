// Googleカレンダー連携。非公開のiCal URL（秘密情報）を定期的に取得して、直近の予定を覚えておく。
import type { Logger } from '../util/logger';
import { parseIcs, type CalEvent } from './icsParse';

export const REFRESH_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 8 * 1024 * 1024;
const WINDOW_MS = 48 * 3600_000;

/** URLがGoogleカレンダーのiCal（https）かを確かめる。他のホストへは接続しない。 */
export function validateCalendarUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: 'URLの形式が正しくありません' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'https のURLを指定してください' };
  if (u.hostname !== 'calendar.google.com') return { ok: false, error: 'Googleカレンダー（calendar.google.com）のURLだけ使えます' };
  if (!u.pathname.endsWith('.ics')) return { ok: false, error: '「iCal形式の非公開URL」（末尾が .ics）を指定してください' };
  return { ok: true, url: u.toString() };
}

export interface CalendarDeps {
  getUrl(): string | null;
  enabled(): boolean;
  now(): Date;
  log: Logger;
  fetchFn?: typeof fetch;
}

export class CalendarService {
  private events: CalEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  lastError: string | null = null;
  lastSyncAt: Date | null = null;

  constructor(private readonly d: CalendarDeps) {}

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 取得に失敗しても前回の予定を残す。URLそのものはログにもエラーにも出さない。 */
  async refresh(): Promise<{ ok: boolean; count: number; error?: string }> {
    const url = this.d.getUrl();
    if (!this.d.enabled() || !url) {
      this.events = [];
      return { ok: false, count: 0, error: '未設定です' };
    }
    const v = validateCalendarUrl(url);
    if (!v.ok) return this.fail(v.error);
    try {
      const f = this.d.fetchFn ?? fetch;
      const res = await f(v.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error', headers: { Accept: 'text/calendar' } });
      if (!res.ok) return this.fail(`取得できませんでした（HTTP ${res.status}）。URLが無効になっているかもしれません`);
      const text = await res.text();
      if (text.length > MAX_BYTES) return this.fail('カレンダーが大きすぎます');
      const now = this.d.now();
      this.events = parseIcs(text, new Date(now.getTime() - 3600_000), new Date(now.getTime() + WINDOW_MS));
      this.lastError = null;
      this.lastSyncAt = now;
      this.d.log.info(`calendar: ${this.events.length} events in the next 48h`);
      return { ok: true, count: this.events.length };
    } catch (e) {
      return this.fail(e instanceof Error && e.name === 'TimeoutError' ? '時間内に取得できませんでした' : 'カレンダーに接続できませんでした');
    }
  }

  private fail(msg: string): { ok: false; count: number; error: string } {
    this.lastError = msg;
    this.d.log.warn(`calendar: ${msg}`);
    return { ok: false, count: this.events.length, error: msg };
  }

  /** いまから withinMin 分以内に始まる、終日ではない予定。 */
  startingSoon(now: Date, withinMin: number): CalEvent[] {
    const t = now.getTime();
    return this.events.filter((e) => !e.allDay && e.start.getTime() > t && e.start.getTime() - t <= withinMin * 60_000);
  }

  /** いまから hours 時間以内に始まる（または終日・進行中の）予定。 */
  agenda(now: Date, hours: number): CalEvent[] {
    const t = now.getTime();
    return this.events.filter((e) => e.end.getTime() > t && e.start.getTime() < t + hours * 3600_000);
  }
}

export function formatEvent(e: CalEvent): string {
  const hm = (d: Date) => d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  const day = e.start.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
  const when = e.allDay ? `${day} 終日` : `${day} ${hm(e.start)}-${hm(e.end)}`;
  // 招待された予定のタイトルは他人が決められるので、タグのように見える文字は除く
  const clean = (s: string) => s.replace(/[<>]/g, '').slice(0, 120);
  return `${when} ${clean(e.title)}${e.location ? `（${clean(e.location)}）` : ''}`;
}
