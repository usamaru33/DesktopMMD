// Proactive speech: trigger conditions and suppression (spec 5.8). Pure functions over a snapshot.

export type TriggerKind = 'greeting' | 'break' | 'schedule' | 'late_night' | 'small_talk' | 'reminder' | 'anniversary' | 'chime';

export const BASE_INTERVAL_MIN: Record<TriggerKind, number> = {
  greeting: 0, // handled by "first of the day / after 4h away"
  break: 90,
  schedule: 0, // once per event
  late_night: 60,
  small_talk: 180,
  reminder: 0,
  anniversary: 24 * 60,
  chime: 0, // 時刻の区切りごとに1回
};

export interface SuppressionInput {
  now: Date;
  enabled: boolean;
  fullscreen: boolean;
  micInUseByOtherApp: boolean;
  muted: boolean;
  sleeping: boolean;
  quietHours: [string, string];
  lastConversationAt: Date | null;
  firedInLastHour: number;
  maxPerHour: number;
}

export type SuppressReason =
  | 'disabled'
  | 'fullscreen'
  | 'in_call'
  | 'muted'
  | 'sleeping'
  | 'quiet_hours'
  | 'recent_conversation'
  | 'rate_limit';

/** Reminders ignore "recent conversation" (the user asked for them) but respect everything else except quiet hours rate limit. */
export function suppressedBy(input: SuppressionInput, kind: TriggerKind): SuppressReason | null {
  if (!input.enabled && kind !== 'reminder') return 'disabled';
  if (input.fullscreen) return 'fullscreen';
  if (input.micInUseByOtherApp) return 'in_call';
  if (input.muted && kind !== 'reminder') return 'muted';
  if (input.sleeping && kind !== 'reminder') return 'sleeping';
  if (kind !== 'reminder' && inQuietHours(input.now, input.quietHours)) return 'quiet_hours';
  if (kind !== 'reminder' && kind !== 'chime' && input.lastConversationAt && input.now.getTime() - input.lastConversationAt.getTime() < 10 * 60_000) {
    return 'recent_conversation';
  }
  if (kind !== 'reminder' && kind !== 'chime' && input.firedInLastHour >= input.maxPerHour) return 'rate_limit';
  return null;
}

export function parseHm(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** [start, end) in local time; handles ranges crossing midnight (e.g. 23:00–07:00). */
export function inQuietHours(now: Date, [start, end]: [string, string]): boolean {
  const s = parseHm(start);
  const e = parseHm(end);
  if (Number.isNaN(s) || Number.isNaN(e) || s === e) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** Past bedtime (until 5:00) → late night. */
export function isLateNight(now: Date, bedtime: string): boolean {
  const b = parseHm(bedtime);
  if (Number.isNaN(b)) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  const morning = 5 * 60;
  if (b >= morning) return t >= b || t < morning; // e.g. 23:30
  return t >= b && t < morning; // e.g. 01:00
}

/** Interval doubles per consecutive ignored/dismissed reaction (cap 24h); a reply resets it. */
export function effectiveIntervalMin(kind: TriggerKind, recentReactions: (string | null)[], base = BASE_INTERVAL_MIN[kind]): number {
  let n = 0;
  for (const r of recentReactions) {
    if (r === 'ignored' || r === 'dismissed') n++;
    else break;
  }
  return Math.min(24 * 60, base * Math.pow(2, n));
}

export interface ActivityState {
  /** minutes of continuous activity (no idle gap ≥ 5 min) */
  activeStreakMin: number;
  /** app that has been in front for the whole streak (null if unknown/disabled) */
  streakApp: string | null;
  /** idle seconds right now */
  idleSec: number;
  /** last time the user came back after ≥ 4h idle (or first activity of the day) */
  returnedAt: Date | null;
}

export function needsGreeting(now: Date, lastGreetingAt: Date | null, returnedAt: Date | null): boolean {
  if (!returnedAt) return false;
  if (now.getTime() - returnedAt.getTime() > 5 * 60_000) return false; // only right after coming back
  return !lastGreetingAt || lastGreetingAt.getTime() < returnedAt.getTime();
}
