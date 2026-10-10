import { describe, expect, it } from 'vitest';
import { MemoryService, type Embedder } from '../../src/main/memory/MemoryService';
import { Db } from '../../src/main/store/Db';
import { Store } from '../../src/main/store/repos';
import type { LlmAdapter } from '../../src/main/llm/LlmClient';

/** Deterministic toy embedding: hashed character bigrams → 384 dims, L2-normalized. */
const toyEmbedder: Embedder = {
  embedReady: true,
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(384);
      const s = t.replace(/\s+/g, '');
      for (let i = 0; i < s.length - 1; i++) {
        let h = 0;
        for (const ch of s.slice(i, i + 2)) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
        v[h % 384] += 1;
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  },
};

function llmReturning(extract: unknown, contradicts = false): LlmAdapter {
  return {
    kind: 'fake',
    stream: async () => { throw new Error('unused'); },
    json: async (p) => (p.purpose === 'conflict' ? { contradicts } : extract) as never,
    text: async () => '',
  };
}

function setup(llm: LlmAdapter, embedder: Embedder = toyEmbedder) {
  const db = new Db(':memory:');
  db.migrate();
  const store = new Store(db);
  const svc = new MemoryService({
    store, embedder, llm: () => llm, utilityModel: () => 'claude-haiku-4-5',
    now: () => new Date('2026-10-07T12:00:00+09:00'), log: { debug() {}, info() {}, warn() {}, error() {} }, enabled: () => true,
  });
  return { store, svc };
}

describe('MemoryService', () => {
  it('extracts memories from unprocessed messages and moves the cursor', async () => {
    const { store, svc } = setup(llmReturning({
      memories: [{ kind: 'preference', content: 'コーヒーが苦手', importance: 0.6, due_at: null, evidence_message_id: 1 }],
      affinity_delta: 2, mood: 0.3,
    }));
    const s = store.conv.createSession();
    store.conv.addMessage({ sessionId: s.id, role: 'user', source: 'text', content: '私はコーヒーが苦手なんだ' });
    store.conv.addMessage({ sessionId: s.id, role: 'assistant', source: 'text', content: '[neutral:0.5]覚えておきます。' });
    expect(await svc.runExtraction()).toBe(1);
    const mems = store.memories.list();
    expect(mems.map((m) => m.content)).toEqual(['コーヒーが苦手']);
    expect(mems[0].sourceMessageId).toBe(1);
    expect(store.relationship.get().affinity).toBe(2);
    // second run: nothing new
    expect(await svc.runExtraction()).toBe(0);
  });

  it('skips sessions marked "この会話は記憶しないで"', async () => {
    const { store, svc } = setup(llmReturning({ memories: [{ kind: 'fact', content: 'x', importance: 1, due_at: null, evidence_message_id: null }], affinity_delta: 0, mood: 0 }));
    const s = store.conv.createSession();
    store.conv.addMessage({ sessionId: s.id, role: 'user', source: 'text', content: '秘密の話' });
    store.conv.setNoMemory(s.id);
    expect(await svc.runExtraction()).toBe(0);
    expect(store.memories.list()).toHaveLength(0);
  });

  it('merges near-duplicates and supersedes contradictions', async () => {
    const { store, svc } = setup(llmReturning({}, true));
    const a = await svc.upsert({ kind: 'preference', content: '平日のお昼ごはんはいつも学食のカレー', importance: 0.5, dueAt: null, sourceMessageId: null });
    const b = await svc.upsert({ kind: 'preference', content: '平日のお昼ごはんはいつも学食のカレー', importance: 0.8, dueAt: null, sourceMessageId: null });
    expect(b.id).toBe(a.id);
    expect(store.memories.get(a.id)!.importance).toBe(0.8);
    const c = await svc.upsert({ kind: 'preference', content: '平日のお昼ごはんはいつも学食のうどん', importance: 0.6, dueAt: null, sourceMessageId: null });
    expect(c.id).not.toBe(a.id);
    expect(store.memories.get(a.id)!.status).toBe('superseded');
    expect(store.memories.get(a.id)!.supersededBy).toBe(c.id);
  });

  it('search returns relevant memories, never profile/pinned (those are always in the prompt)', async () => {
    const { svc } = setup(llmReturning({}));
    await svc.upsert({ kind: 'profile', content: '名前は山田', importance: 1, dueAt: null, sourceMessageId: null });
    await svc.upsert({ kind: 'preference', content: 'コーヒーが苦手', importance: 0.6, dueAt: null, sourceMessageId: null });
    await svc.upsert({ kind: 'fact', content: '研究テーマは音声対話システム', importance: 0.7, dueAt: null, sourceMessageId: null });
    const r = await svc.search('コーヒーが苦手だっけ');
    expect(r.map((m) => m.content)).toContain('コーヒーが苦手');
    expect(r.map((m) => m.content)).not.toContain('名前は山田');
    expect(svc.profile().map((m) => m.content)).toEqual(['名前は山田']);
  });

  it('falls back to FTS when the embedder is down', async () => {
    const down: Embedder = { embedReady: false, embed: async () => { throw new Error('down'); } };
    const { svc } = setup(llmReturning({}), down);
    await svc.upsert({ kind: 'preference', content: 'コーヒーが苦手', importance: 0.6, dueAt: null, sourceMessageId: null });
    expect((await svc.search('コーヒーは好き？')).map((m) => m.content)).toEqual(['コーヒーが苦手']);
  });

  it('TC-10: forget moves the memory to the trash and it is no longer used', async () => {
    const { store, svc } = setup(llmReturning({}));
    await svc.upsert({ kind: 'preference', content: 'コーヒーが苦手', importance: 0.6, dueAt: null, sourceMessageId: null });
    const msg = await svc.forget('コーヒーが苦手');
    expect(msg).toContain('ごみ箱');
    expect(store.memories.list({ status: 'trashed' })).toHaveLength(1);
    expect(await svc.search('コーヒーが苦手')).toHaveLength(0);
  });

  it('remember with replaces_query supersedes the old memory', async () => {
    const { store, svc } = setup(llmReturning({}));
    const old = await svc.upsert({ kind: 'fact', content: '研究室は田中研', importance: 0.6, dueAt: null, sourceMessageId: null });
    const msg = await svc.save({ kind: 'fact', content: '研究室は鈴木研', importance: 0.7, dueAt: null, replacesQuery: '研究室は田中研' });
    expect(msg).toContain('更新');
    expect(store.memories.get(old.id)!.status).toBe('superseded');
  });
});
