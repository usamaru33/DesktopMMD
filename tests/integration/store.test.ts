import { describe, expect, it } from 'vitest';
import { Db } from '../../src/main/store/Db';
import { Store } from '../../src/main/store/repos';
import { MIGRATIONS } from '../../src/main/store/migrations';

function mem(): Store {
  const db = new Db(':memory:');
  db.migrate();
  return new Store(db);
}

describe('migrations', () => {
  it('apply once and are idempotent', () => {
    const db = new Db(':memory:');
    expect(db.migrate()).toBe(MIGRATIONS.length);
    expect(db.migrate()).toBe(0);
    expect(db.version).toBe(MIGRATIONS.at(-1)!.version);
  });
});

describe('migration v3 keeps old usage rows', () => {
  it('copies per-model rows into the per-purpose table as "other"', async () => {
    const { MIGRATIONS: all } = await import('../../src/main/store/migrations');
    const db = new Db(':memory:');
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    for (const m of all.filter((x) => x.version <= 2)) {
      db.exec(m.sql);
      db.run('INSERT INTO schema_version (version) VALUES (?)', m.version);
    }
    db.run("INSERT INTO usage_daily (date, model, input_tokens, usd) VALUES ('2026-10-07', 'claude-sonnet-5-5', 100, 1.5)");
    expect(db.migrate()).toBe(all.length - 2);
    const s = new Store(db);
    expect(s.usage.breakdownSince('2026-10-01')[0]).toMatchObject({ purpose: 'other', model: 'claude-sonnet-5-5', inputTokens: 100, usd: 1.5 });
  });
});

describe('conversations', () => {
  it('stores messages and finds them with trigram FTS (Japanese)', () => {
    const s = mem();
    const sess = s.conv.createSession();
    s.conv.addMessage({ sessionId: sess.id, role: 'user', source: 'text', content: '私はコーヒーが苦手です' });
    s.conv.addMessage({ sessionId: sess.id, role: 'assistant', source: 'text', content: '[happy:0.5]紅茶はいかがですか？' });
    const hits = s.conv.search('コーヒー');
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain('コーヒー');
    expect(s.conv.search('紅茶')).toHaveLength(1); // 2 chars → LIKE fallback
    expect(s.conv.messages(sess.id)).toHaveLength(2);
  });
});

describe('memories', () => {
  it('round-trips embeddings and supports FTS fallback search', () => {
    const s = mem();
    const e = new Float32Array(384).map((_, i) => i / 384);
    const m = s.memories.insert({ kind: 'preference', content: 'コーヒーが苦手', importance: 0.6, embedding: e });
    const back = s.memories.get(m.id)!;
    expect(back.embedding?.length).toBe(384);
    expect(back.embedding?.[100]).toBeCloseTo(100 / 384);
    expect(s.memories.ftsSearch('コーヒーは好き？').map((h) => h.row.id)).toEqual([m.id]);
  });

  it('trash, maintenance and full wipe', () => {
    const s = mem();
    const old = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-10-07T00:00:00Z');
    const a = s.memories.insert({ kind: 'fact', content: '古い些細な事実', importance: 0.1, embedding: null, now: old });
    const b = s.memories.insert({ kind: 'schedule', content: '10/1に面接', importance: 0.8, embedding: null, dueAt: '2026-10-01T01:00:00Z', now: old });
    const c = s.memories.insert({ kind: 'fact', content: '消す', importance: 0.5, embedding: null });
    s.memories.update(c.id, { status: 'trashed' }, old);
    const r = s.memories.maintain(now);
    expect(r).toEqual({ archived: 1, purged: 1, converted: 1 });
    expect(s.memories.get(a.id)!.status).toBe('archived');
    expect(s.memories.get(b.id)!.kind).toBe('episode');
    expect(s.memories.get(c.id)).toBeNull();
    s.wipePersonalData();
    expect(s.memories.list()).toHaveLength(0);
    expect(s.relationship.get().affinity).toBe(0);
  });
});

describe('usage, timers, tool runs', () => {
  it('accumulates usage per day and model', () => {
    const s = mem();
    s.usage.add('2026-10-07', 'm', 'chat', { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, webSearches: 1, usd: 0.5 });
    s.usage.add('2026-10-07', 'm', 'chat', { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, webSearches: 0, usd: 0.25 });
    s.usage.add('2026-10-08', 'h', 'proactive', { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, webSearches: 0, usd: 0.01 });
    expect(s.usage.sumSince('2026-10-01')).toBeCloseTo(0.76);
    expect(s.usage.breakdownSince('2026-10-01')).toEqual([
      { purpose: 'chat', model: 'm', requests: 2, inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 1, usd: 0.75 },
      { purpose: 'proactive', model: 'h', requests: 1, inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, usd: 0.01 },
    ]);
  });
  it('timers', () => {
    const s = mem();
    const id = s.timers.add('timer', 'ラーメン', new Date(Date.now() + 1000));
    expect(s.timers.pending()).toHaveLength(1);
    expect(s.timers.cancel(id)).toBe(true);
    expect(s.timers.pending()).toHaveLength(0);
  });
  it('tool runs keep at most 2000 chars of result', () => {
    const s = mem();
    const id = s.toolRuns.insert({ messageId: null, tool: 'read_file', level: 'L0', args: { path: 'x' }, decision: 'auto' });
    s.toolRuns.finish(id, { content: 'x'.repeat(10000) }, null);
    expect(s.toolRuns.get(id)!.resultJson.length).toBe(2000);
  });
});
