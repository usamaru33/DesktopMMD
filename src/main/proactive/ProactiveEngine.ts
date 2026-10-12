// Decides when to speak unprompted (spec 5.8). Conditions AND suppression must both pass.
import type { MemoryRecord, Settings } from '@shared/types';
import type { TurnInput } from '../adapters';
import type { Store } from '../store/repos';
import type { Logger } from '../util/logger';
import { stageOf } from '../memory/affinity';
import type { ActivityMonitor } from './ActivityMonitor';
import { effectiveIntervalMin, isLateNight, needsGreeting, suppressedBy, type TriggerKind } from './suppression';

export interface ProactiveDeps {
  store: Store;
  activity: ActivityMonitor;
  settings(): Settings;
  lastConversationAt(): Date | null;
  submit(t: TurnInput): boolean;
  isIdle(): boolean;
  now(): Date;
  log: Logger;
  /** カレンダーの予定のうち、withinMin 分以内に始まるもの（key は同じ予定を二度知らせないための識別子） */
  /** 集中モード中か（声かけを止める） */
  focusing?(): boolean;
  calendarSoon?(now: Date, withinMin: number): { key: string; text: string; minutes: number }[];
}

const IGNORE_WINDOW_MS = 30_000;

function chimeSlot(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes() >= 30 ? 1 : 0}`;
}

export class ProactiveEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFired = new Map<TriggerKind, number>();
  private lastGreetingAt: Date | null = null;
  private announcedSchedules = new Set<number>();
  private lastChimeSlot = '';
  private announcedCalendar = new Set<string>();
  /** the relationship just reached this stage (celebrated once, when a good moment comes) */
  private stageUp: number | null = null;
  private pending: { eventId: number; trigger: TriggerKind; at: number } | null = null;

  constructor(private readonly d: ProactiveDeps) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.d.activity.on('returned', () => setTimeout(() => void this.tick(), 3000));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** The affinity stage went up (from MemoryService): say something about it at the next good moment. */
  noteStageUp(stage: number): void {
    this.stageUp = stage;
  }

  /** The user answered (any user turn) → the pending proactive event counts as replied. */
  onUserTurn(): void {
    if (!this.pending) return;
    this.d.store.proactive.setReaction(this.pending.eventId, 'replied');
    this.pending = null;
  }

  /** Esc / "今いい" right after a proactive line → dismissed. */
  onDismiss(): void {
    if (!this.pending) return;
    this.d.store.proactive.setReaction(this.pending.eventId, 'dismissed');
    this.pending = null;
  }

  async tick(): Promise<void> {
    const now = this.d.now();
    // a proactive line nobody reacted to within 30s → ignored
    if (this.pending && now.getTime() - this.pending.at > IGNORE_WINDOW_MS) {
      this.d.store.proactive.setReaction(this.pending.eventId, 'ignored');
      this.pending = null;
    }
    if (!this.d.isIdle()) return;
    const cand = this.candidate(now);
    if (!cand) return;
    await this.d.activity.refreshMicInUse();
    this.fire(cand.kind, cand.detail, now, cand.scheduleId, cand.calendarKey, cand.ref);
  }

  /** 集中モードが終わった: お疲れさまと休憩の提案（ユーザーが頼んだものなので、ミュート等以外の抑止は受けない） */
  async fireFocusEnd(minutes: number): Promise<boolean> {
    await this.d.activity.refreshMicInUse();
    return this.fire('focus_end', `${minutes}分`, this.d.now());
  }

  /** Exposed for timers/reminders, which go through the same suppression (minus a few rules). */
  async fireReminder(label: string): Promise<boolean> {
    await this.d.activity.refreshMicInUse();
    return this.fire('reminder', label, this.d.now());
  }

  private fire(kind: TriggerKind, detail: string, now: Date, scheduleId?: number, calendarKey?: string, ref?: string): boolean {
    const s = this.d.settings();
    const hourAgo = new Date(now.getTime() - 3600_000);
    const firedInLastHour = this.d.store.proactive.since(hourAgo).filter((e) => e.trigger !== 'reminder' && e.trigger !== 'chime' && e.trigger !== 'focus_end').length;
    const reason = suppressedBy(
      {
        now,
        enabled: s.proactive.enabled,
        fullscreen: this.d.activity.fullscreen,
        micInUseByOtherApp: this.d.activity.micInUse,
        muted: s.voice.muted,
        sleeping: s.sleeping,
        quietHours: s.proactive.quietHours,
        lastConversationAt: this.d.lastConversationAt(),
        firedInLastHour,
        maxPerHour: s.proactive.maxPerHour,
        focusing: this.d.focusing?.() ?? false,
      },
      kind,
    );
    if (reason) {
      this.d.log.debug(`proactive ${kind} suppressed: ${reason}`);
      return false;
    }
    const eventId = this.d.store.proactive.add(kind, now, ref ?? null);
    const ok = this.d.submit({ kind: 'proactive', trigger: kind, detail, eventId });
    if (!ok) {
      this.d.store.proactive.setReaction(eventId, 'ignored');
      if (ref) this.d.store.proactive.forgetRef(eventId);
      return false;
    }
    if (kind === 'stage_up') this.stageUp = null;
    this.lastFired.set(kind, now.getTime());
    if (kind === 'greeting') this.lastGreetingAt = now;
    if (scheduleId) this.announcedSchedules.add(scheduleId);
    if (calendarKey) this.announcedCalendar.add(calendarKey);
    if (kind === 'chime') this.lastChimeSlot = chimeSlot(now);
    this.pending = { eventId, trigger: kind, at: now.getTime() };
    this.d.log.info(`proactive: ${kind}`);
    return true;
  }

  private due(kind: TriggerKind, now: Date): boolean {
    const last = this.lastFired.get(kind);
    if (!last) return true;
    const reactions = this.d.store.proactive.recentReactions(kind, 6);
    return now.getTime() - last >= effectiveIntervalMin(kind, reactions) * 60_000;
  }

  private candidate(now: Date): { kind: TriggerKind; detail: string; scheduleId?: number; calendarKey?: string; ref?: string } | null {
    const s = this.d.settings();
    const act = this.d.activity.state();

    // カレンダーの予定: 設定した分数前に1回だけ
    if (s.calendar.enabled && this.d.calendarSoon) {
      const ev = this.d.calendarSoon(now, s.calendar.leadMinutes).find((e) => !this.announcedCalendar.has(e.key));
      if (ev) return { kind: 'schedule', detail: `${ev.text}（あと${Math.max(1, ev.minutes)}分）`, calendarKey: ev.key };
    }

    // schedule: 15 min before
    for (const m of this.d.store.memories.active()) {
      if (m.kind !== 'schedule' || !m.dueAt || this.announcedSchedules.has(m.id)) continue;
      const until = Date.parse(m.dueAt) - now.getTime();
      if (until > 0 && until <= 15 * 60_000) return { kind: 'schedule', detail: `${m.content}（あと${Math.round(until / 60_000)}分）`, scheduleId: m.id };
    }

    // a restart of the app is not "coming back": skip if we greeted within the last 4 hours
    const greetedRecently = this.d.store.proactive.since(new Date(now.getTime() - 4 * 3600_000)).some((e) => e.trigger === 'greeting');
    if (!greetedRecently && needsGreeting(now, this.lastGreetingAt, act.returnedAt)) {
      const away = this.d.lastConversationAt();
      return { kind: 'greeting', detail: away ? `前回の会話から${Math.round((now.getTime() - away.getTime()) / 3600_000)}時間ぶり` : '今日はじめて' };
    }

    // 時報: 30分/60分ごとの区切り（その後2分以内）に、作業中なら時刻を伝えて休憩を提案する
    const ci = s.proactive.chimeMinutes;
    if (ci > 0 && now.getMinutes() % ci < 2 && act.idleSec < 300 && this.lastChimeSlot !== chimeSlot(now)) {
      const hh = now.getHours();
      const mm = now.getMinutes() >= 30 ? 30 : 0;
      return { kind: 'chime', detail: `いま${hh}時${mm === 0 ? 'ちょうど' : `${mm}分`}` };
    }

    if (isLateNight(now, s.proactive.bedtime) && act.idleSec < 60 && this.due('late_night', now)) {
      return { kind: 'late_night', detail: `就寝時刻は${s.proactive.bedtime}` };
    }

    // break: 90 min (extended up to 120 for people who usually work long stretches)
    const breakMin = this.breakThresholdMin();
    if (act.activeStreakMin >= breakMin && this.due('break', now)) {
      const what = act.streakApp && s.privacy.watchActiveWindow ? `${act.streakApp}で${Math.round(act.activeStreakMin)}分続けて作業している` : `${Math.round(act.activeStreakMin)}分続けてPCで作業している`;
      return { kind: 'break', detail: what };
    }

    const rel = this.d.store.relationship.get();
    const stage = stageOf(rel.affinity);
    const said = (kind: TriggerKind, ref: string) => this.d.store.proactive.said(kind, ref);
    // once-only moments, while the user is at the PC: the relationship deepened, a day count, a birthday
    if (act.idleSec < 120) {
      if (this.stageUp !== null && this.stageUp <= stage && !said('stage_up', `stage-${this.stageUp}`)) {
        return { kind: 'stage_up', detail: STAGE_UP_DETAIL[this.stageUp] ?? '前より打ち解けた', ref: `stage-${this.stageUp}` };
      }
      const days = daysSince(new Date(rel.firstMetAt), now);
      if (MILESTONE_DAYS.includes(days) && !said('milestone', `day-${days}`)) return { kind: 'milestone', detail: `出会って${days}日`, ref: `day-${days}` };
      const bday = birthdayToday(this.d.store.memories.active(), now);
      if (bday && !said('birthday', `${now.getFullYear()}`)) return { kind: 'birthday', detail: bday, ref: `${now.getFullYear()}` };
      const done = followUpCandidate(this.d.store.memories.active(), now, (id) => said('follow_up', `memory-${id}`));
      if (done && this.due('follow_up', now)) return { kind: 'follow_up', detail: done.detail, ref: `memory-${done.id}` };
    }

    const last = this.d.lastConversationAt();
    if (stage >= 2 && act.idleSec < 120 && last && now.getTime() - last.getTime() >= 60 * 60_000 && this.due('small_talk', now)) {
      // learned pattern: don't start small talk in hours the user is usually away
      if (this.d.store.patterns.activityRate(now.getHours(), 14, now) >= 0.3) return { kind: 'small_talk', detail: '話題は自由' };
    }

    if (stage >= 3 && this.due('anniversary', now)) {
      const met = new Date(rel.firstMetAt);
      if (met.getDate() === now.getDate() && (met.getMonth() !== now.getMonth() || met.getFullYear() !== now.getFullYear())) {
        const months = (now.getFullYear() - met.getFullYear()) * 12 + now.getMonth() - met.getMonth();
        return { kind: 'anniversary', detail: months % 12 === 0 ? `出会って${months / 12}年` : `出会って${months}か月` };
      }
    }
    return null;
  }

  private breakThresholdMin(): number {
    return 90; // FR-PS-06 extension point: could be raised to 120 from usage_patterns
  }
}

/** 出会ってからの日数のうち、ひとこと触れる日（1年以上は anniversary が毎月・毎年扱う） */
export const MILESTONE_DAYS = [100, 200, 300, 500, 1000];

const STAGE_UP_DETAIL: Record<number, string> = {
  1: '顔なじみになって、少し打ち解けてきた',
  2: '親しい間柄になった',
  3: '何でも話せる相棒のような間柄になった',
};

/** Whole local days from the first meeting to today. */
export function daysSince(met: Date, now: Date): number {
  const a = new Date(met.getFullYear(), met.getMonth(), met.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

const DIGITS = (s: string) => Number(s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));

/** A remembered birthday ("誕生日は5月3日", "誕生日: 5/3") that is today: the memory text, or null. */
export function birthdayToday(memories: Pick<MemoryRecord, 'kind' | 'content'>[], now: Date): string | null {
  for (const m of memories) {
    if (m.kind === 'schedule' || m.kind === 'episode') continue; // someone else's birthday party, etc.
    const r = /(?:ユーザー|わたし|私|自分|僕|俺)?の?誕生日[^0-9０-９]{0,6}([0-9０-９]{1,2})\s*(?:月|\/)\s*([0-9０-９]{1,2})/.exec(m.content);
    if (r && DIGITS(r[1]) === now.getMonth() + 1 && DIGITS(r[2]) === now.getDate()) return m.content;
  }
  return null;
}

/**
 * A schedule the user told us about that is now over (between 2 hours and 7 days ago) and not followed up
 * yet: "how did the interview go?". The most recent one first.
 */
export function followUpCandidate(
  memories: Pick<MemoryRecord, 'id' | 'kind' | 'content' | 'dueAt'>[],
  now: Date,
  alreadyAsked: (id: number) => boolean,
): { id: number; detail: string } | null {
  const t = now.getTime();
  const done = memories
    .filter((m) => m.kind === 'schedule' && m.dueAt)
    .map((m) => ({ m, at: Date.parse(m.dueAt!) }))
    .filter(({ at }) => t - at >= 2 * 3600_000 && t - at <= 7 * 86_400_000)
    .sort((a, b) => b.at - a.at)
    .find(({ m }) => !alreadyAsked(m.id));
  if (!done) return null;
  const d = new Date(done.at);
  return { id: done.m.id, detail: `${done.m.content}（${d.getMonth() + 1}月${d.getDate()}日）` };
}

