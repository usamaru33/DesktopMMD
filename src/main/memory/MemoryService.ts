// Long-term memory: search, extraction, merge/supersede, remember/forget, affinity & mood
// (spec 2.5 記憶の学習, 5.7; skill mmd-memory-personalization).
import type { Emotion } from '@shared/emotions';
import { LIMITS } from '@shared/defaults';
import type { MemoryKind, MemoryRecord, MessageRecord } from '@shared/types';
import type { MemoryPortForTurns } from '../adapters';
import type { LlmAdapter } from '../llm/LlmClient';
import { CONFLICT_SCHEMA, CONFLICT_SYSTEM, EXTRACTION_SCHEMA, EXTRACTION_SYSTEM, formatNow } from '../llm/PromptBuilder';
import { stripReplyMarkup } from '../llm/ReplyParser';
import { type MemoryRow, type Store, stripEmbedding } from '../store/repos';
import type { MemoryPort } from '../tools/builtin/assistantTools';
import { localDate } from '../tools/PermissionGate';
import type { Logger } from '../util/logger';
import { applyAffinityDelta, stageOf, updateMood } from './affinity';
import { cosine, rankByBm25, rankMemories } from './scoring';

export interface Embedder {
  readonly embedReady: boolean;
  embed(texts: string[], kind: 'query' | 'passage', timeoutMs?: number): Promise<Float32Array[]>;
}

export interface MemoryDeps {
  store: Store;
  embedder: Embedder;
  llm(): LlmAdapter;
  utilityModel(): string;
  now(): Date;
  log: Logger;
  onChanged?(): void;
  onMood?(mood: number): void;
  enabled(): boolean; // privacy.saveTranscripts
}

interface Extracted {
  memories: { kind: MemoryKind; content: string; importance: number; due_at: string | null; evidence_message_id: number | null }[];
  affinity_delta: number;
  mood: number;
}

export class MemoryService implements MemoryPortForTurns, MemoryPort {
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private extracting = false;
  private activeSession: number | null = null;

  constructor(private readonly d: MemoryDeps) {}

  // ---------------- retrieval ----------------

  async search(query: string, signal?: AbortSignal): Promise<MemoryRecord[]> {
    const now = this.d.now();
    const candidates = this.d.store.memories.active().filter((m) => !m.pinned && m.kind !== 'profile');
    if (!candidates.length) return [];
    let ranked: { item: MemoryRow }[] = [];
    if (this.d.embedder.embedReady) {
      try {
        const [q] = await raceAbort(this.d.embedder.embed([query], 'query', 2000), signal);
        ranked = rankMemories(q, candidates, now);
      } catch (e) {
        this.d.log.debug('embedding search unavailable, using FTS', e);
      }
    }
    if (!ranked.length) {
      const hits = this.d.store.memories.ftsSearch(query).filter((h) => !h.row.pinned && h.row.kind !== 'profile');
      ranked = rankByBm25(hits, now);
    }
    // upcoming schedules within 7 days are always relevant
    const soon = candidates.filter(
      (m) => m.kind === 'schedule' && m.dueAt && Date.parse(m.dueAt) > now.getTime() && Date.parse(m.dueAt) - now.getTime() < 7 * 86_400_000,
    );
    const out = new Map<number, MemoryRow>();
    for (const r of ranked) out.set(r.item.id, r.item);
    for (const s of soon) if (out.size < LIMITS.memoryTopK + 2) out.set(s.id, s);
    return [...out.values()].map(stripEmbedding);
  }

  profile(): MemoryRecord[] {
    return this.d.store.memories
      .active()
      .filter((m) => m.kind === 'profile' || m.pinned)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 30)
      .map(stripEmbedding);
  }

  markUsed(ids: number[]): void {
    this.d.store.memories.markUsed(ids, this.d.now());
  }

  stage(): number {
    return stageOf(this.d.store.relationship.get().affinity);
  }

  recordEmotion(emotion: Emotion, intensity: number): void {
    const rel = this.d.store.relationship.get();
    rel.mood = updateMood(rel.mood, emotion, intensity);
    this.d.store.relationship.save(rel);
    this.d.onMood?.(rel.mood);
  }

  // ---------------- extraction scheduling (spec 2.5 ①) ----------------

  onTurnFinished(sessionId: number): void {
    if (!this.d.enabled()) return;
    if (this.activeSession !== null && this.activeSession !== sessionId) {
      // the previous session ended: extract it now
      void this.runExtraction();
    }
    this.activeSession = sessionId;
    if (this.d.store.conv.countUnextractedUserMessages(sessionId) >= LIMITS.extractTurns) {
      void this.runExtraction();
      return;
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.runExtraction(), LIMITS.extractIdleMs);
  }

  async runExtraction(): Promise<number> {
    if (this.extracting) return 0;
    this.extracting = true;
    let saved = 0;
    try {
      for (const { session, messages } of this.d.store.conv.unextracted()) {
        const closed = session.id !== this.activeSession;
        if (session.noMemory || !messages.length) {
          const last = messages.at(-1)?.id ?? 0;
          this.d.store.conv.setExtractedUpto(session.id, last, closed);
          continue;
        }
        const r = await this.d.llm().json<Extracted>({
          model: this.d.utilityModel(),
          system: EXTRACTION_SYSTEM,
          user: `今日: ${formatNow(this.d.now())}（${this.d.now().toISOString()}）\n\n会話ログ:\n${transcriptFor(messages)}`,
          schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
          maxTokens: LIMITS.extractMaxTokens,
          purpose: 'extract',
        });
        const ids = new Set(messages.map((m) => m.id));
        for (const m of r.memories ?? []) {
          if (!m.content?.trim()) continue;
          await this.upsert({
            kind: m.kind,
            content: m.content.trim(),
            importance: clamp01(m.importance),
            dueAt: m.due_at && !Number.isNaN(Date.parse(m.due_at)) ? new Date(m.due_at).toISOString() : null,
            sourceMessageId: m.evidence_message_id && ids.has(m.evidence_message_id) ? m.evidence_message_id : null,
          });
          saved++;
        }
        const rel = applyAffinityDelta(this.d.store.relationship.get(), r.affinity_delta ?? 0, localDate(this.d.now()));
        if (typeof r.mood === 'number') rel.mood = Math.max(-1, Math.min(1, rel.mood * 0.7 + r.mood * 0.3));
        this.d.store.relationship.save(rel);
        this.d.store.conv.setExtractedUpto(session.id, messages[messages.length - 1].id, closed);
      }
      if (saved) this.d.onChanged?.();
    } catch (e) {
      this.d.log.warn('memory extraction failed', e);
    } finally {
      this.extracting = false;
    }
    return saved;
  }

  /** Merge with near-duplicates (cos ≥ 0.9), supersede contradictions (0.75–0.9, same kind). Spec 2.5 ③. */
  async upsert(m: { kind: MemoryKind; content: string; importance: number; dueAt: string | null; sourceMessageId: number | null; pinned?: boolean }): Promise<MemoryRow> {
    const now = this.d.now();
    let emb: Float32Array | null = null;
    if (this.d.embedder.embedReady) {
      try {
        [emb] = await this.d.embedder.embed([m.content], 'passage');
      } catch {
        emb = null;
      }
    }
    if (emb) {
      let best: { row: MemoryRow; cos: number } | null = null;
      for (const row of this.d.store.memories.active()) {
        if (!row.embedding) continue;
        const c = cosine(emb, row.embedding);
        if (!best || c > best.cos) best = { row, cos: c };
      }
      if (best && best.cos >= 0.9) {
        return this.d.store.memories.update(
          best.row.id,
          { content: m.content, importance: Math.max(best.row.importance, m.importance), embedding: emb, dueAt: m.dueAt ?? best.row.dueAt },
          now,
        )!;
      }
      if (best && best.cos >= 0.75 && best.row.kind === m.kind) {
        let contradicts = false;
        try {
          const r = await this.d.llm().json<{ contradicts: boolean }>({
            model: this.d.utilityModel(),
            system: CONFLICT_SYSTEM,
            user: `古い記憶: ${best.row.content}\n新しい記憶: ${m.content}`,
            schema: CONFLICT_SCHEMA as unknown as Record<string, unknown>,
            maxTokens: 100,
            purpose: 'conflict',
          });
          contradicts = !!r.contradicts;
        } catch (e) {
          this.d.log.debug('conflict check failed', e);
        }
        if (contradicts) {
          const created = this.d.store.memories.insert({ ...m, embedding: emb, now });
          this.d.store.memories.update(best.row.id, { status: 'superseded', supersededBy: created.id }, now);
          return created;
        }
      }
    }
    return this.d.store.memories.insert({ ...m, embedding: emb, now });
  }

  // ---------------- tools: remember / forget (FR-PS-03) ----------------

  async save(m: { kind: MemoryKind; content: string; importance: number; dueAt: string | null; replacesQuery?: string }): Promise<string> {
    let replaced: MemoryRow | null = null;
    if (m.replacesQuery) {
      const hits = await this.findSimilar(m.replacesQuery, 0.55);
      replaced = hits[0] ?? null;
    }
    const row = await this.upsert({ ...m, sourceMessageId: null });
    if (replaced && replaced.id !== row.id) {
      this.d.store.memories.update(replaced.id, { status: 'superseded', supersededBy: row.id }, this.d.now());
    }
    this.d.onChanged?.();
    return replaced ? `「${replaced.content}」を「${row.content}」に更新しました` : `「${row.content}」を覚えました`;
  }

  async forget(query: string): Promise<string> {
    const hits = await this.findSimilar(query, 0.6);
    if (!hits.length) return `「${query}」に当てはまる記憶は見つかりませんでした`;
    const targets = hits.slice(0, 3);
    for (const h of targets) this.d.store.memories.update(h.id, { status: 'trashed' }, this.d.now());
    this.d.onChanged?.();
    return `次の記憶をごみ箱に移しました（30日後に消えます）: ${targets.map((t) => `「${t.content}」`).join('、')}`;
  }

  private async findSimilar(query: string, minCos: number): Promise<MemoryRow[]> {
    const active = this.d.store.memories.active();
    if (this.d.embedder.embedReady) {
      try {
        const [q] = await this.d.embedder.embed([query], 'query');
        return active
          .filter((m) => m.embedding)
          .map((m) => ({ m, c: cosine(q, m.embedding!) }))
          .filter((x) => x.c >= minCos)
          .sort((a, b) => b.c - a.c)
          .map((x) => x.m);
      } catch {
        /* fall through */
      }
    }
    const fts = this.d.store.memories.ftsSearch(query).map((h) => h.row);
    if (fts.length) return fts;
    return active.filter((m) => m.content.includes(query) || query.includes(m.content));
  }

  // ---------------- maintenance ----------------

  /** Embed memories saved while the sidecar was down. */
  async backfillEmbeddings(): Promise<number> {
    if (!this.d.embedder.embedReady) return 0;
    const missing = this.d.store.memories.list({ status: 'active' }).filter((m) => !m.embedding);
    let n = 0;
    for (let i = 0; i < missing.length; i += 16) {
      const batch = missing.slice(i, i + 16);
      const vecs = await this.d.embedder.embed(batch.map((m) => m.content), 'passage');
      batch.forEach((m, j) => this.d.store.memories.update(m.id, { embedding: vecs[j] }));
      n += batch.length;
    }
    return n;
  }

  maintain(): void {
    const r = this.d.store.memories.maintain(this.d.now());
    if (r.archived || r.purged || r.converted) this.d.log.info('memory maintenance', r);
  }

  /** Admin screen: add / update with re-embedding. */
  async adminAdd(m: { kind: MemoryKind; content: string; importance: number; pinned: boolean }): Promise<MemoryRecord> {
    const row = await this.upsert({ ...m, dueAt: null, sourceMessageId: null });
    if (m.pinned) this.d.store.memories.update(row.id, { pinned: true });
    return stripEmbedding(this.d.store.memories.get(row.id)!);
  }

  async adminUpdate(id: number, patch: Parameters<Store['memories']['update']>[1]): Promise<MemoryRecord | null> {
    if (patch.content !== undefined && this.d.embedder.embedReady) {
      try {
        [patch.embedding] = await this.d.embedder.embed([patch.content], 'passage');
      } catch {
        patch.embedding = null;
      }
    } else if (patch.content !== undefined) patch.embedding = null;
    const row = this.d.store.memories.update(id, patch, this.d.now());
    return row ? stripEmbedding(row) : null;
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }
}

function clamp01(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

export function transcriptFor(messages: MessageRecord[]): string {
  return messages
    .map((m) => {
      if (m.role === 'user') {
        if (m.source === 'proactive') return `[#${m.id}] （アプリからの声かけの合図。ユーザーの発言ではない）`;
        return `[#${m.id}] ユーザー: ${m.content}`;
      }
      if (m.role === 'assistant') return `[#${m.id}] アシスタント: ${stripReplyMarkup(m.content)}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    p.then(resolve, reject);
  });
}
