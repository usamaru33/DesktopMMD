// Memory retrieval score (spec 5.7):
//   score = 0.6·cos(q, m) + 0.25·importance + 0.15·2^(−Δt/30days)
import { LIMITS } from '@shared/defaults';

export interface Scorable {
  id: number;
  content: string;
  importance: number;
  embedding: Float32Array | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export function recency(lastUsedAt: string | null, createdAt: string, now: Date): number {
  const t = Date.parse(lastUsedAt ?? createdAt);
  const days = Math.max(0, (now.getTime() - t) / 86_400_000);
  return Math.pow(2, -days / 30);
}

export function score(cos: number, importance: number, rec: number): number {
  return 0.6 * cos + 0.25 * importance + 0.15 * rec;
}

/** Rough token estimate for Japanese-heavy text (skill: 文字数/1.5). */
export function estimateTokens(s: string): number {
  return Math.ceil([...s].length / 1.5);
}

export interface Ranked<T> {
  item: T;
  cos: number;
  score: number;
}

export function rankMemories<T extends Scorable>(
  query: Float32Array,
  items: T[],
  now: Date,
  opts: { topK?: number; tokenBudget?: number; minCos?: number } = {},
): Ranked<T>[] {
  const topK = opts.topK ?? LIMITS.memoryTopK;
  const budget = opts.tokenBudget ?? LIMITS.memoryTokenBudget;
  const minCos = opts.minCos ?? LIMITS.memoryMinCos;
  const ranked: Ranked<T>[] = [];
  for (const m of items) {
    if (!m.embedding) continue;
    const c = cosine(query, m.embedding);
    if (c < minCos) continue;
    ranked.push({ item: m, cos: c, score: score(c, m.importance, recency(m.lastUsedAt, m.createdAt, now)) });
  }
  ranked.sort((a, b) => b.score - a.score);
  const out: Ranked<T>[] = [];
  let used = 0;
  for (const r of ranked) {
    if (out.length >= topK) break;
    const t = estimateTokens(r.item.content);
    if (used + t > budget) continue;
    used += t;
    out.push(r);
  }
  return out;
}

/** FTS fallback when embeddings are unavailable: BM25 rank (lower is better) → pseudo-cosine 0.35..0.9. */
export function rankByBm25<T extends Scorable>(hits: { row: T; rank: number }[], now: Date, topK = LIMITS.memoryTopK): Ranked<T>[] {
  if (!hits.length) return [];
  const ranks = hits.map((h) => h.rank);
  const lo = Math.min(...ranks);
  const hi = Math.max(...ranks);
  return hits
    .map((h) => {
      const norm = hi === lo ? 1 : (hi - h.rank) / (hi - lo);
      const c = 0.35 + 0.55 * norm;
      return { item: h.row, cos: c, score: score(c, h.row.importance, recency(h.row.lastUsedAt, h.row.createdAt, now)) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
