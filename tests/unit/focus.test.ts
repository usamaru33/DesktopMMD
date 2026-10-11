// 集中モード: FocusService, the suppression rule, the engine hook and the tools.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { Settings } from '../../src/shared/types';
import type { TurnInput } from '../../src/main/adapters';
import { FocusService } from '../../src/main/proactive/FocusService';
import { ProactiveEngine } from '../../src/main/proactive/ProactiveEngine';
import { ActivityMonitor } from '../../src/main/proactive/ActivityMonitor';
import { suppressedBy, type SuppressionInput } from '../../src/main/proactive/suppression';
import { Db } from '../../src/main/store/Db';
import { Store } from '../../src/main/store/repos';
import { proactiveUserMessage } from '../../src/main/llm/PromptBuilder';
import { createAssistantTools } from '../../src/main/tools/builtin/assistantTools';
import type { ToolContext, ToolDef } from '../../src/main/tools/types';

const log = { debug() {}, info() {}, warn() {}, error() {} };

describe('FocusService', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-11T10:00:00') }));
  afterEach(() => vi.useRealTimers());

  it('is active for N minutes, then ends once and calls onEnd with the length', () => {
    const onEnd = vi.fn();
    const onChange = vi.fn();
    const f = new FocusService({ onEnd, onChange });
    expect(f.active).toBe(false);
    const r = f.start(25);
    expect(r).toMatchObject({ ok: true, replaced: false });
    expect(f.active).toBe(true);
    expect(f.status()).toMatchObject({ active: true, minutes: 25, remainingMin: 25 });
    vi.advanceTimersByTime(10 * 60_000);
    expect(f.status()).toMatchObject({ remainingMin: 15 });
    vi.advanceTimersByTime(15 * 60_000);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(25);
    expect(f.active).toBe(false);
    expect(f.status()).toEqual({ active: false });
    expect(onChange).toHaveBeenCalledTimes(2); // start, end
  });

  it('stop ends it early without the end-of-session line; stopping when idle is an error', () => {
    const onEnd = vi.fn();
    const f = new FocusService({ onEnd });
    expect(f.stop()).toMatchObject({ ok: false });
    f.start(30);
    vi.advanceTimersByTime(12 * 60_000);
    expect(f.stop()).toEqual({ ok: true, remainingMin: 18 });
    vi.advanceTimersByTime(60 * 60_000);
    expect(onEnd).not.toHaveBeenCalled();
    expect(f.active).toBe(false);
  });

  it('starting again replaces the running session (the old timer must not fire)', () => {
    const onEnd = vi.fn();
    const f = new FocusService({ onEnd });
    f.start(10);
    vi.advanceTimersByTime(5 * 60_000);
    expect(f.start(20)).toMatchObject({ ok: true, replaced: true });
    vi.advanceTimersByTime(6 * 60_000); // the first one would have ended by now
    expect(onEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(14 * 60_000);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(20);
  });

  it('rejects lengths outside 1–180 minutes', () => {
    const f = new FocusService({ onEnd: vi.fn() });
    for (const m of [0, -5, 181, NaN, Infinity]) expect(f.start(m)).toMatchObject({ ok: false });
    expect(f.active).toBe(false);
    expect(f.start(1)).toMatchObject({ ok: true });
    expect(f.start(180)).toMatchObject({ ok: true });
  });
});

describe('suppression while focusing', () => {
  const base: SuppressionInput = {
    now: new Date('2026-10-07T13:00:00'), enabled: true, fullscreen: false, micInUseByOtherApp: false, muted: false, sleeping: false,
    quietHours: ['00:30', '08:00'], lastConversationAt: null, firedInLastHour: 0, maxPerHour: 2,
  };

  it('stops everything except what the user asked for', () => {
    const f = { ...base, focusing: true };
    for (const k of ['greeting', 'break', 'schedule', 'late_night', 'small_talk', 'anniversary', 'chime'] as const) expect(suppressedBy(f, k)).toBe('focus');
    expect(suppressedBy(f, 'reminder')).toBeNull();
    expect(suppressedBy(f, 'focus_end')).toBeNull();
    expect(suppressedBy(base, 'break')).toBeNull();
  });

  it('the end-of-focus line ignores the "don\'t bother me" rules, but not full-screen or a call', () => {
    const quiet: SuppressionInput = { ...base, enabled: false, muted: true, sleeping: true, now: new Date('2026-10-07T03:00:00'), lastConversationAt: new Date('2026-10-07T02:59:00'), firedInLastHour: 5 };
    expect(suppressedBy(quiet, 'focus_end')).toBeNull();
    expect(suppressedBy({ ...base, fullscreen: true }, 'focus_end')).toBe('fullscreen');
    expect(suppressedBy({ ...base, micInUseByOtherApp: true }, 'focus_end')).toBe('in_call');
  });
});

function engine(opts: { focusing: () => boolean; settings?: (s: Settings) => void }) {
  const db = new Db(':memory:');
  db.migrate();
  const st = new Store(db);
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  opts.settings?.(settings);
  const now = { t: new Date('2026-10-07T13:00:00') };
  const activity = new ActivityMonitor({
    idleSeconds: () => 0,
    activeWindow: async () => ({ app: 'Code', bounds: { x: 0, y: 0, width: 800, height: 600 } }),
    displayBoundsFor: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    ownPid: 1,
    watchApps: () => true,
    now: () => now.t,
    log,
  });
  vi.spyOn(activity, 'refreshMicInUse').mockResolvedValue(false);
  const submitted: TurnInput[] = [];
  const e = new ProactiveEngine({
    store: st, activity, settings: () => settings, lastConversationAt: () => null, focusing: opts.focusing,
    submit: (t) => (submitted.push(t), true), isIdle: () => true, now: () => now.t, log,
  });
  (activity as unknown as { tick(): void }).tick();
  return { e, submitted, activity };
}

describe('ProactiveEngine with focus mode', () => {
  afterEach(() => vi.restoreAllMocks());
  const triggers = (s: TurnInput[]) => s.map((x) => (x.kind === 'proactive' ? x.trigger : 'user'));

  it('says nothing while focusing, and greets normally otherwise', async () => {
    const quiet = engine({ focusing: () => true });
    await quiet.e.tick();
    expect(quiet.submitted).toEqual([]);
    const normal = engine({ focusing: () => false });
    await normal.e.tick();
    expect(triggers(normal.submitted)).toEqual(['greeting']);
  });

  it('fireFocusEnd speaks even if proactive speech is off and the voice is muted', async () => {
    const t = engine({ focusing: () => false, settings: (s) => { s.proactive.enabled = false; s.voice.muted = true; } });
    expect(await t.e.fireFocusEnd(25)).toBe(true);
    expect(t.submitted[0]).toMatchObject({ kind: 'proactive', trigger: 'focus_end', detail: '25分' });
    const full = engine({ focusing: () => false });
    full.activity.fullscreen = true;
    expect(await full.e.fireFocusEnd(25)).toBe(false);
  });

  it('the line the model gets asks for thanks and a short break', () => {
    const m = proactiveUserMessage('focus_end', '25分');
    expect(m).toMatch(/^<proactive trigger="focus_end">/);
    expect(m).toContain('25分');
    expect(m).toContain('休憩');
  });
});

describe('focus tools', () => {
  const ctx = (): ToolContext => ({ now: () => new Date('2026-10-11T10:00:00+09:00') }) as unknown as ToolContext;
  const timers = { add: vi.fn(), list: vi.fn(() => []), cancel: vi.fn() };
  const memory = { save: vi.fn(async () => ''), forget: vi.fn(async () => '') };
  const by = (l: ToolDef[], n: string) => l.find((t) => t.name === n)!;

  it('are only offered when a focus port is given', () => {
    expect(createAssistantTools(timers as never, memory).some((t) => t.name === 'start_focus')).toBe(false);
    const focus = { start: vi.fn(), stop: vi.fn() };
    const names = createAssistantTools(timers as never, memory, undefined, focus as never).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['start_focus', 'stop_focus']));
  });

  it('start_focus defaults to 25 minutes, reports errors, and stays L0', async () => {
    const focus = { start: vi.fn(() => ({ ok: true as const, endsAt: new Date('2026-10-11T10:25:00+09:00'), replaced: false })), stop: vi.fn(() => ({ ok: true as const, remainingMin: 7 })) };
    const tools = createAssistantTools(timers as never, memory, undefined, focus);
    const start = by(tools, 'start_focus');
    expect(start.level).toBe('L0');
    const r = await start.run({}, ctx());
    expect(focus.start).toHaveBeenCalledWith(25);
    expect(r.ok).toBe(true);
    expect(String(r.content)).toContain('25分間');
    expect(String(r.content)).toContain('声かけをしません');
    expect(start.inputSchema.safeParse({ minutes: 0 }).success).toBe(false);
    expect(start.inputSchema.safeParse({ minutes: 181 }).success).toBe(false);
    await start.run({ minutes: 50 }, ctx());
    expect(focus.start).toHaveBeenLastCalledWith(50);
    const stop = await by(tools, 'stop_focus').run({}, ctx());
    expect(String(stop.content)).toContain('残り7分');
    focus.start.mockReturnValueOnce({ ok: false, error: 'だめ' } as never);
    expect(await start.run({ minutes: 5 }, ctx())).toMatchObject({ ok: false, content: 'だめ' });
  });
});
