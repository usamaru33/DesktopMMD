import { afterEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../../src/main/store/Db';
import { Store } from '../../src/main/store/repos';
import { birthdayToday, daysSince, followUpCandidate, ProactiveEngine } from '../../src/main/proactive/ProactiveEngine';
import { ActivityMonitor } from '../../src/main/proactive/ActivityMonitor';
import { buildJournalPrompt, cleanJournalBody, closingHeading } from '../../src/main/journal/journal';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { TurnInput } from '../../src/main/adapters';

const log = { debug() {}, info() {}, warn() {}, error() {} };

function setup(now: { t: Date }) {
  const db = new Db(':memory:');
  db.migrate();
  const st = new Store(db);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.proactive.quietHours = ['03:00', '03:01'];
  const activity = new ActivityMonitor({
    idleSeconds: () => 0,
    activeWindow: async () => null,
    displayBoundsFor: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    ownPid: 1,
    watchApps: () => false,
    now: () => now.t,
    log,
  });
  vi.spyOn(activity, 'refreshMicInUse').mockResolvedValue(false);
  const submitted: TurnInput[] = [];
  const engine = new ProactiveEngine({
    store: st,
    activity,
    settings: () => settings,
    lastConversationAt: () => null,
    submit: (t) => (submitted.push(t), true),
    isIdle: () => true,
    now: () => now.t,
    log,
  });
  // the day's greeting is out of the way
  st.proactive.add('greeting', new Date(now.t.getTime() - 60_000));
  (engine as unknown as { lastGreetingAt: Date }).lastGreetingAt = now.t;
  const said = () => submitted.flatMap((s) => (s.kind === 'proactive' ? [`${s.trigger}: ${s.detail}`] : []));
  return { st, engine, said };
}

afterEach(() => vi.restoreAllMocks());

describe('once-only moments', () => {
  it('a day count since the first meeting, once', async () => {
    const now = { t: new Date('2026-10-12T15:00:00') };
    const a = setup(now);
    a.st.relationship.save({ ...a.st.relationship.get(), firstMetAt: new Date('2026-07-04T10:00:00').toISOString() });
    await a.engine.tick();
    expect(a.said()).toEqual(['milestone: 出会って100日']);
    now.t = new Date(now.t.getTime() + 2 * 3600_000);
    await a.engine.tick();
    expect(a.said()).toHaveLength(1);
  });

  it('a remembered birthday, once a year', async () => {
    const now = { t: new Date('2026-05-03T12:00:00') };
    const a = setup(now);
    a.st.memories.insert({ kind: 'profile', content: 'ユーザーの誕生日は5月3日', importance: 0.8, embedding: null });
    await a.engine.tick();
    expect(a.said()).toEqual(['birthday: ユーザーの誕生日は5月3日']);
    await a.engine.tick();
    expect(a.said()).toHaveLength(1);
  });

  it('the relationship deepening, at the next good moment, once', async () => {
    const now = { t: new Date('2026-10-12T15:00:00') };
    const a = setup(now);
    a.st.relationship.save({ ...a.st.relationship.get(), affinity: 41 });
    a.engine.noteStageUp(2);
    await a.engine.tick();
    expect(a.said()).toEqual(['stage_up: 親しい間柄になった']);
    a.engine.noteStageUp(2);
    await a.engine.tick();
    expect(a.said()).toHaveLength(1);
  });

  it('asks how a past plan went, once per plan and not too often', async () => {
    const now = { t: new Date('2026-10-12T13:00:00') };
    const a = setup(now);
    a.st.memories.insert({ kind: 'schedule', content: '面接', importance: 0.8, embedding: null, dueAt: new Date('2026-10-12T10:00:00').toISOString() });
    a.st.memories.insert({ kind: 'schedule', content: '歯医者', importance: 0.5, embedding: null, dueAt: new Date('2026-10-11T10:00:00').toISOString() });
    await a.engine.tick();
    expect(a.said()).toEqual(['follow_up: 面接（10月12日）']);
    a.engine.onUserTurn(); // the user answered (an ignored question would make the next one wait longer)
    now.t = new Date(now.t.getTime() + 3600_000);
    await a.engine.tick();
    expect(a.said()).toHaveLength(1); // the next one waits (at most one every 6 hours)
    now.t = new Date(now.t.getTime() + 6 * 3600_000);
    await a.engine.tick();
    expect(a.said()[1]).toBe('follow_up: 歯医者（10月11日）');
  });

  it('a line that could not be said is tried again later', async () => {
    const now = { t: new Date('2026-10-12T15:00:00') };
    const a = setup(now);
    a.st.relationship.save({ ...a.st.relationship.get(), firstMetAt: new Date('2026-07-04T10:00:00').toISOString() });
    const id = a.st.proactive.add('milestone', now.t, 'day-100');
    a.st.proactive.forgetRef(id);
    expect(a.st.proactive.said('milestone', 'day-100')).toBe(false);
  });
});

describe('moment helpers', () => {
  it('counts local days', () => {
    expect(daysSince(new Date('2026-07-04T23:50:00'), new Date('2026-10-12T00:10:00'))).toBe(100);
  });

  it('finds a birthday in several wordings, not someone else\'s plans', () => {
    const day = new Date('2026-05-03T09:00:00');
    expect(birthdayToday([{ kind: 'profile', content: '誕生日: 5/3' }], day)).toBe('誕生日: 5/3');
    expect(birthdayToday([{ kind: 'fact', content: 'わたしの誕生日は５月３日です' }], day)).not.toBeNull();
    expect(birthdayToday([{ kind: 'profile', content: '誕生日は5月4日' }], day)).toBeNull();
    expect(birthdayToday([{ kind: 'schedule', content: '友達の誕生日会 5月3日' }], day)).toBeNull();
  });

  it('follows up only plans that are over (2 hours to 7 days ago)', () => {
    const now = new Date('2026-10-12T12:00:00');
    const m = (id: number, at: string) => ({ id, kind: 'schedule' as const, content: `予定${id}`, dueAt: new Date(at).toISOString() });
    const list = [m(1, '2026-10-12T11:00:00'), m(2, '2026-10-01T12:00:00'), m(3, '2026-10-12T15:00:00'), m(4, '2026-10-10T12:00:00')];
    expect(followUpCandidate(list, now, () => false)?.id).toBe(4);
    expect(followUpCandidate(list, now, (id) => id === 4)).toBeNull();
  });
});

describe('closing word in the diary', () => {
  const m = { messages: [{ role: 'user' as const, content: '今日は面接だった', at: new Date('2026-10-12T20:00:00') }], works: [], memories: [], tomorrow: [] };
  it('adds the heading and the character only when there is a character', () => {
    const day = new Date('2026-10-12T22:30:00');
    expect(buildJournalPrompt(m, day)).not.toContain('より');
    const p = buildJournalPrompt({ ...m, character: { name: 'サトイモ', persona: '明るく素直' } }, day);
    expect(p).toContain('使う見出し（これだけを、この順で）: ## 今日話したこと / ## サトイモより');
    expect(p).toContain('<character>\n明るく素直\n</character>');
  });
  it('keeps the heading to one clean line', () => {
    expect(closingHeading('サト#イモ\n')).toBe('サトイモより');
    expect(closingHeading('  ')).toBe('アシスタントより');
  });
  it('drops emotion tags copied into the closing word', () => {
    expect(cleanJournalBody('## サトイモより\n[neutral:0.4] 面接、どうでした？[happy]がんばって')).toBe('## サトイモより\n面接、どうでした？がんばって');
  });
});
