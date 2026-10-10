import { afterEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../../src/main/store/Db';
import { Store } from '../../src/main/store/repos';
import { ProactiveEngine, type ProactiveDeps } from '../../src/main/proactive/ProactiveEngine';
import { ActivityMonitor, isFullscreenWindow } from '../../src/main/proactive/ActivityMonitor';
import { TimerService } from '../../src/main/proactive/TimerService';
import { UsageService } from '../../src/main/llm/UsageService';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { Settings } from '../../src/shared/types';
import type { TurnInput } from '../../src/main/adapters';

const log = { debug() {}, info() {}, warn() {}, error() {} };

function store() {
  const db = new Db(':memory:');
  db.migrate();
  return new Store(db);
}

function setup(nowRef: { t: Date }, opts: { idleSec?: number; fullscreen?: boolean; settings?: Partial<Settings>; calendarSoon?: ProactiveDeps['calendarSoon'] } = {}) {
  const st = store();
  const settings: Settings = { ...structuredClone(DEFAULT_SETTINGS), ...opts.settings };
  const activity = new ActivityMonitor({
    idleSeconds: () => opts.idleSec ?? 0,
    activeWindow: async () => ({ app: 'Code', bounds: { x: 0, y: 0, width: 800, height: 600 } }),
    displayBoundsFor: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    ownPid: 1,
    watchApps: () => true,
    now: () => nowRef.t,
    log,
  });
  activity.fullscreen = !!opts.fullscreen;
  vi.spyOn(activity, 'refreshMicInUse').mockResolvedValue(false);
  const submitted: TurnInput[] = [];
  let lastConv: Date | null = null;
  const engine = new ProactiveEngine({
    store: st,
    activity,
    settings: () => settings,
    lastConversationAt: () => lastConv,
    submit: (t) => (submitted.push(t), true),
    isIdle: () => true,
    now: () => nowRef.t,
    log,
    calendarSoon: opts.calendarSoon,
  });
  return { st, activity, engine, submitted, settings, setLastConv: (d: Date | null) => (lastConv = d) };
}

afterEach(() => vi.restoreAllMocks());

describe('ProactiveEngine: calendar and chime', () => {
  const triggers = (a: ReturnType<typeof setup>) => a.submitted.map((s) => (s.kind === 'proactive' ? s.trigger : 'user'));

  it('announces a calendar event once, with the minutes left', async () => {
    const now = { t: new Date('2026-10-07T13:00:00') };
    const settings = { ...structuredClone(DEFAULT_SETTINGS), calendar: { enabled: true, leadMinutes: 15 as const } };
    const asked: number[] = [];
    let upcoming = false; // 挨拶が済んでから予定が近づく
    const a = setup(now, { settings, calendarSoon: (_n, m) => (asked.push(m), upcoming ? [{ key: 'k1', text: '会議', minutes: 10 }] : []) });
    (a.activity as unknown as { tick(): void }).tick();
    await a.engine.tick(); // greeting
    a.submitted.length = 0;
    upcoming = true;
    asked.length = 0;
    now.t = new Date(now.t.getTime() + 11 * 60_000);
    await a.engine.tick();
    const first = a.submitted[0];
    expect(first && first.kind === 'proactive' && first.trigger).toBe('schedule');
    expect(first && first.kind === 'proactive' && first.detail).toContain('会議（あと10分）');
    expect(asked[0]).toBe(15);
    now.t = new Date(now.t.getTime() + 60_000);
    await a.engine.tick();
    expect(triggers(a)).toEqual(['schedule']);
  });

  it('does not ask the calendar when the feature is off', async () => {
    const now = { t: new Date('2026-10-07T13:00:00') };
    const spy = vi.fn(() => [{ key: 'k', text: 'x', minutes: 1 }]);
    const a = setup(now, { calendarSoon: spy });
    (a.activity as unknown as { tick(): void }).tick();
    await a.engine.tick();
    await a.engine.tick();
    expect(spy).not.toHaveBeenCalled();
  });

  it('chimes once per half hour slot with the time, even right after a conversation', async () => {
    const now = { t: new Date('2026-10-07T13:00:00') };
    const settings = { ...structuredClone(DEFAULT_SETTINGS), proactive: { ...DEFAULT_SETTINGS.proactive, chimeMinutes: 30 as const } };
    const a = setup(now, { settings });
    (a.activity as unknown as { tick(): void }).tick();
    await a.engine.tick(); // greeting
    a.submitted.length = 0;
    a.setLastConv(new Date(now.t.getTime() + 20 * 60_000)); // talked 1 minute ago
    now.t = new Date('2026-10-07T13:30:20');
    await a.engine.tick();
    const c = a.submitted[0];
    expect(c && c.kind === 'proactive' && c.trigger).toBe('chime');
    expect(c && c.kind === 'proactive' && c.detail).toContain('13時30分');
    now.t = new Date('2026-10-07T13:31:10');
    await a.engine.tick();
    expect(triggers(a)).toEqual(['chime']);
    now.t = new Date('2026-10-07T14:00:05');
    await a.engine.tick();
    expect(triggers(a)).toEqual(['chime', 'chime']);
  });

  it('is silent between slots and when chime is off', async () => {
    const now = { t: new Date('2026-10-07T13:00:00') };
    const a = setup(now);
    (a.activity as unknown as { tick(): void }).tick();
    await a.engine.tick();
    a.submitted.length = 0;
    now.t = new Date('2026-10-07T14:00:10');
    await a.engine.tick();
    expect(triggers(a)).toEqual([]);
  });
});

describe('ProactiveEngine', () => {
  it('greets once when the user shows up, not again after an app restart within 4 h', async () => {
    const now = { t: new Date('2026-10-07T09:00:00') };
    const a = setup(now);
    (a.activity as unknown as { tick(): void }).tick();
    await a.engine.tick();
    expect(a.submitted.map((s) => s.kind === 'proactive' && s.trigger)).toEqual(['greeting']);
    await a.engine.tick();
    expect(a.submitted).toHaveLength(1);
    // a new engine on the same store (= app restart) must not greet again
    const b = new ProactiveEngine({
      store: a.st, activity: a.activity, settings: () => a.settings, lastConversationAt: () => null,
      submit: (t) => (a.submitted.push(t), true), isIdle: () => true, now: () => now.t, log,
    });
    await b.tick();
    expect(a.submitted).toHaveLength(1);
  });

  it('suggests a break after 90 minutes of continuous activity, then waits 90 minutes (doubled if ignored)', async () => {
    const now = { t: new Date('2026-10-07T13:00:00') };
    const a = setup(now);
    const tick = () => (a.activity as unknown as { tick(): void }).tick();
    tick(); // start streak
    await a.engine.tick(); // greeting
    a.submitted.length = 0;
    for (let m = 1; m <= 91; m++) {
      now.t = new Date(now.t.getTime() + 60_000);
      tick();
    }
    await a.engine.tick();
    expect(a.submitted.map((s) => s.kind === 'proactive' && s.trigger)).toEqual(['break']);
    // nobody reacted within 30 s → ignored
    now.t = new Date(now.t.getTime() + 31_000);
    await a.engine.tick();
    const ev = a.st.proactive.since(new Date(0)).find((e) => e.trigger === 'break')!;
    expect(ev.reaction).toBe('ignored');
    // 100 minutes later: still suppressed because the interval doubled to 180
    now.t = new Date(now.t.getTime() + 100 * 60_000);
    tick();
    await a.engine.tick();
    expect(a.submitted.filter((s) => s.kind === 'proactive' && s.trigger === 'break')).toHaveLength(1);
  });

  it('TC-11: nothing is said while a full-screen app is in front', async () => {
    const now = { t: new Date('2026-10-07T09:00:00') };
    const a = setup(now, { fullscreen: true });
    (a.activity as unknown as { tick(): void }).tick();
    await a.engine.tick();
    expect(a.submitted).toHaveLength(0);
  });

  it('announces schedule memories 15 minutes ahead, once', async () => {
    const now = { t: new Date('2026-10-07T09:50:00') };
    const a = setup(now);
    a.st.memories.insert({ kind: 'schedule', content: '10時から面接', importance: 0.9, embedding: null, dueAt: new Date('2026-10-07T10:00:00').toISOString() });
    // greet first so the greeting doesn't take the slot
    a.st.proactive.add('greeting', now.t);
    await a.engine.tick();
    expect(a.submitted.map((s) => s.kind === 'proactive' && s.detail)).toEqual(['10時から面接（あと10分）']);
    a.setLastConv(null);
    await a.engine.tick();
    expect(a.submitted).toHaveLength(1);
  });

  it('reminders fire through the engine even right after a conversation', async () => {
    const now = { t: new Date('2026-10-07T15:00:00') };
    const a = setup(now);
    a.setLastConv(now.t);
    expect(await a.engine.fireReminder('ラーメン')).toBe(true);
    expect(a.submitted[0]).toMatchObject({ kind: 'proactive', trigger: 'reminder' });
  });

  it('replied / dismissed reactions are recorded', async () => {
    const now = { t: new Date('2026-10-07T09:00:00') };
    const a = setup(now);
    (a.activity as unknown as { tick(): void }).tick();
    await a.engine.tick();
    a.engine.onUserTurn();
    expect(a.st.proactive.since(new Date(0))[0].reaction).toBe('replied');
    await a.engine.fireReminder('x');
    a.engine.onDismiss();
    expect(a.st.proactive.since(new Date(0))[1].reaction).toBe('dismissed');
  });
});

describe('ActivityMonitor', () => {
  it('detects full-screen windows (bounds covering the display)', async () => {
    const now = { t: new Date() };
    const st = setup(now);
    const m = new ActivityMonitor({
      idleSeconds: () => 0,
      activeWindow: async () => ({ app: 'game.exe', bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
      displayBoundsFor: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      ownPid: 1, watchApps: () => true, now: () => now.t, log,
    });
    const events: boolean[] = [];
    m.on('fullscreen', (f: boolean) => events.push(f));
    await (m as unknown as { pollWindow(): Promise<void> }).pollWindow();
    expect(m.fullscreen).toBe(false); // needs two consecutive polls (alt-tab flicker)
    await (m as unknown as { pollWindow(): Promise<void> }).pollWindow();
    expect(m.fullscreen).toBe(true);
    expect(events).toEqual([true]);
    expect(m.activeApp).toBe('game.exe');
    void st;
  });
});

describe('TimerService', () => {
  it('fires timers, survives restarts, caps at 20 and cancels', async () => {
    vi.useFakeTimers();
    const st = store();
    const fired: string[] = [];
    const t = new TimerService(st, (label) => fired.push(label), () => new Date(Date.now()));
    const r = t.add('timer', 'カップ麺', new Date(Date.now() + 180_000));
    expect(r.ok).toBe(true);
    vi.advanceTimersByTime(179_000);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(fired).toEqual(['カップ麺']);
    // restart: a pending reminder is re-armed from the DB
    st.timers.add('reminder', '会議', new Date(Date.now() + 60_000));
    const t2 = new TimerService(st, (label) => fired.push(label), () => new Date(Date.now()));
    t2.start();
    vi.advanceTimersByTime(61_000);
    expect(fired).toEqual(['カップ麺', '会議']);
    for (let i = 0; i < 20; i++) t2.add('timer', `t${i}`, new Date(Date.now() + 3600_000));
    expect(t2.add('timer', 'over', new Date(Date.now() + 3600_000)).ok).toBe(false);
    const id = t2.list()[0].id;
    expect(t2.cancel(id)).toBe(true);
    t2.stop();
    vi.useRealTimers();
  });
});

describe('UsageService', () => {
  it('records cost, warns at 80%, degrades the chat model at 100%', () => {
    const st = store();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.llm.monthlyBudgetUsd = 1;
    const notes: string[] = [];
    const u = new UsageService(st, () => settings, (t, k) => notes.push(`${k}:${t}`), () => new Date('2026-10-07T12:00:00'));
    u.record('claude-sonnet-5-5', { input_tokens: 100_000, output_tokens: 50_000 }); // $0.2 + $0.5
    expect(u.summary().monthUsd).toBeCloseTo(0.7);
    expect(u.chatModel()).toBe('claude-sonnet-5-5');
    expect(notes).toHaveLength(0);
    u.record('claude-sonnet-5-5', { input_tokens: 50_000, output_tokens: 10_000 }); // +$0.2 → 0.9
    expect(notes[0]).toMatch(/^warn:/);
    u.record('claude-sonnet-5-5', { input_tokens: 0, output_tokens: 20_000 }); // +$0.2 → 1.1
    expect(notes[1]).toMatch(/^error:/);
    expect(u.summary().degraded).toBe(true);
    expect(u.chatModel()).toBe('claude-haiku-4-5');
    expect(u.proactiveModel()).toBe('claude-haiku-4-5');
  });

  it('books spend per purpose and model', () => {
    const st = store();
    const u = new UsageService(st, () => DEFAULT_SETTINGS, () => {}, () => new Date('2026-10-07T12:00:00'));
    u.record('claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 100 }, 'chat');
    u.record('claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 100 }, 'chat');
    u.record('claude-haiku-4-5', { input_tokens: 500, output_tokens: 50 }, 'proactive');
    u.record('claude-haiku-4-5', { input_tokens: 2000, output_tokens: 300 }, 'extract');
    const b = u.breakdown();
    expect(b.map((r) => `${r.purpose}/${r.model}/${r.requests}`)).toEqual([
      'chat/claude-sonnet-5-5/2', 'extract/claude-haiku-4-5/1', 'proactive/claude-haiku-4-5/1',
    ]);
    expect(b[0].usd).toBeCloseTo(2 * (1000 * 2 + 100 * 10) / 1e6);
  });
});

describe('isFullscreenWindow', () => {
  const disp = { x: 0, y: 0, width: 1920, height: 1080 };
  const win = (bounds: { x: number; y: number; width: number; height: number }, app: string, path: string) => ({ app, path, bounds });

  it('a borderless full-screen game / video covers the display exactly', () => {
    expect(isFullscreenWindow(win({ x: 0, y: 0, width: 1920, height: 1080 }, 'Game', 'C:\\Games\\game.exe'), disp)).toBe(true);
  });

  it('the desktop is not a full-screen app, whatever its localized name is (minimize / show desktop)', () => {
    const desk = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(isFullscreenWindow(win(desk, 'エクスプローラー', 'C:\\Windows\\explorer.exe'), disp)).toBe(false);
    expect(isFullscreenWindow(win(desk, 'Windows Explorer', 'C:\\Windows\\explorer.exe'), disp)).toBe(false);
    expect(isFullscreenWindow(win(desk, 'エクスプローラー', ''), disp)).toBe(false);
    expect(isFullscreenWindow(win(desk, 'Search', 'C:\\Windows\\SystemApps\\SearchHost.exe'), disp)).toBe(false);
  });

  it('maximized windows overhang the display by their invisible borders and are not full screen', () => {
    // auto-hide taskbar: a maximized browser is larger than the display on every side
    expect(isFullscreenWindow(win({ x: -8, y: -8, width: 1936, height: 1096 }, 'Google Chrome', 'C:\\chrome.exe'), disp)).toBe(false);
    // normal taskbar
    expect(isFullscreenWindow(win({ x: -8, y: -8, width: 1936, height: 1048 }, 'Google Chrome', 'C:\\chrome.exe'), disp)).toBe(false);
  });

  it('works on a second display and tolerates 1px rounding', () => {
    const second = { x: 1920, y: 0, width: 2560, height: 1440 };
    expect(isFullscreenWindow(win({ x: 1920, y: 0, width: 2561, height: 1440 }, 'Video', 'C:\\vlc.exe'), second)).toBe(true);
    expect(isFullscreenWindow(win({ x: 0, y: 0, width: 1920, height: 1080 }, 'Video', 'C:\\vlc.exe'), second)).toBe(false);
  });
});

