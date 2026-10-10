// Timers / reminders and memory tools (L0). Spec 5.5, 5.7, FR-TL-05, FR-PS-03.
import { z } from 'zod';
import type { MemoryKind } from '@shared/types';
import type { ToolDef } from '../types';

export interface TimerPort {
  add(kind: 'timer' | 'reminder', label: string, fireAt: Date): { ok: true; id: number } | { ok: false; error: string };
  list(): { id: number; kind: string; label: string; fireAt: string }[];
  cancel(id: number): boolean;
}

export interface MemoryPort {
  save(m: { kind: MemoryKind; content: string; importance: number; dueAt: string | null; replacesQuery?: string }): Promise<string>;
  forget(query: string): Promise<string>;
}

function fmt(d: Date): string {
  return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', weekday: 'short' });
}

export interface CalendarPort {
  /** いまから hours 時間以内の予定を整形済みの文字列で返す */
  agenda(hours: number): string[];
  enabled(): boolean;
}

export function createAssistantTools(timers: TimerPort, memory: MemoryPort, calendar?: CalendarPort): ToolDef[] {
  const calendarAgenda: ToolDef<{ hours?: number }> = {
    name: 'calendar_agenda',
    title: 'カレンダーの予定',
    description: 'ユーザーのGoogleカレンダーから、いまから指定時間以内（既定24時間、最大48時間）の予定を読みます。「今日の予定は？」などに使います。読み取り専用です。',
    inputSchema: z.object({ hours: z.number().int().min(1).max(48).optional() }),
    level: 'L0',
    summarize: (i) => ({ targets: [], summary: `今後${i.hours ?? 24}時間の予定` }),
    async run(i) {
      if (!calendar?.enabled()) return { ok: false, content: 'Googleカレンダーが連携されていません（設定の「カレンダー」で非公開URLを登録してください）' };
      const l = calendar.agenda(i.hours ?? 24);
      return { ok: true, content: l.length ? l.join('\n') : '予定はありません' };
    },
  };

  const setTimer: ToolDef<{ seconds: number; label?: string }> = {
    name: 'set_timer',
    title: 'タイマー',
    description: '指定秒数後に知らせるタイマーを設定します（例: 3分→180）。',
    inputSchema: z.object({ seconds: z.number().int().min(1).max(24 * 3600), label: z.string().max(100).optional() }),
    level: 'L0',
    summarize: (i) => ({ targets: [], summary: `${i.seconds}秒のタイマー` }),
    async run(i, ctx) {
      const at = new Date(ctx.now().getTime() + i.seconds * 1000);
      const r = timers.add('timer', i.label ?? 'タイマー', at);
      return r.ok
        ? { ok: true, content: `タイマー#${r.id}を${fmt(at)}に設定しました`, note: 'タイマーを設定しました' }
        : { ok: false, content: r.error };
    },
  };

  const setReminder: ToolDef<{ at: string; label: string }> = {
    name: 'set_reminder',
    title: 'リマインダー',
    description: '指定日時にリマインドします。at はタイムゾーン付きISO 8601（例 2026-10-08T10:00:00+09:00）。相対日時は get_datetime で今日を確認してから計算してください。',
    inputSchema: z.object({
      at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), '日時の形式が正しくありません'),
      label: z.string().min(1).max(200),
    }),
    level: 'L0',
    summarize: (i) => ({ targets: [], summary: `${i.at} に「${i.label}」` }),
    async run(i, ctx) {
      const at = new Date(i.at);
      if (at.getTime() <= ctx.now().getTime()) return { ok: false, content: 'その日時は既に過ぎています' };
      const r = timers.add('reminder', i.label, at);
      return r.ok
        ? { ok: true, content: `リマインダー#${r.id}「${i.label}」を${fmt(at)}に設定しました`, note: 'リマインダーを設定しました' }
        : { ok: false, content: r.error };
    },
  };

  const listTimers: ToolDef<Record<string, never>> = {
    name: 'list_timers',
    title: 'タイマー一覧',
    description: '設定中のタイマーとリマインダーを一覧します。',
    inputSchema: z.object({}),
    level: 'L0',
    summarize: () => ({ targets: [], summary: 'タイマー一覧' }),
    async run() {
      const l = timers.list();
      return { ok: true, content: l.length ? l.map((t) => `#${t.id} ${t.kind} ${fmt(new Date(t.fireAt))} ${t.label}`).join('\n') : '設定中のタイマーはありません' };
    },
  };

  const cancelTimer: ToolDef<{ id: number }> = {
    name: 'cancel_timer',
    title: 'タイマー取り消し',
    description: 'タイマーまたはリマインダーを番号で取り消します。',
    inputSchema: z.object({ id: z.number().int() }),
    level: 'L0',
    summarize: (i) => ({ targets: [`#${i.id}`], summary: '取り消す' }),
    async run(i) {
      return timers.cancel(i.id) ? { ok: true, content: `#${i.id}を取り消しました` } : { ok: false, content: `#${i.id}は見つかりません` };
    },
  };

  const memorySave: ToolDef<{ content: string; kind: MemoryKind; importance?: number; due_at?: string; replaces_query?: string }> = {
    name: 'memory_save',
    title: '覚える',
    description:
      'ユーザーが「覚えて」と言ったとき、または「それは違う、本当は〜」と訂正したときに使います。content はユーザーについての簡潔な1文。訂正なら replaces_query に古い記憶を探す言葉を入れます。予定は kind=schedule と due_at（ISO 8601）。',
    inputSchema: z.object({
      content: z.string().min(1).max(300),
      kind: z.enum(['profile', 'preference', 'fact', 'episode', 'schedule']),
      importance: z.number().min(0).max(1).optional(),
      due_at: z.string().optional(),
      replaces_query: z.string().optional(),
    }),
    level: 'L0',
    summarize: (i) => ({ targets: [], summary: `覚える: ${i.content}` }),
    async run(i) {
      const msg = await memory.save({
        kind: i.kind,
        content: i.content,
        importance: i.importance ?? 0.7,
        dueAt: i.due_at && !Number.isNaN(Date.parse(i.due_at)) ? new Date(i.due_at).toISOString() : null,
        replacesQuery: i.replaces_query,
      });
      return { ok: true, content: msg, note: '覚えました' };
    },
  };

  const memoryForget: ToolDef<{ query: string }> = {
    name: 'memory_forget',
    title: '忘れる',
    description: 'ユーザーが「忘れて」と言ったときに使います。query に忘れる内容を表す言葉を入れます。忘れた記憶はごみ箱へ移り30日後に消えます。',
    inputSchema: z.object({ query: z.string().min(1) }),
    level: 'L0',
    summarize: (i) => ({ targets: [], summary: `忘れる: ${i.query}` }),
    async run(i) {
      return { ok: true, content: await memory.forget(i.query), note: '忘れました' };
    },
  };

  return [setTimer, setReminder, listTimers, cancelTimer, memorySave, memoryForget, ...(calendar ? [calendarAgenda] : [])];
}
