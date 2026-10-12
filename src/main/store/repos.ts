// Repositories over the SQLite schema (spec 6.4). Map snake_case rows to the shared camelCase types.
import type { Emotion } from '@shared/emotions';
import type {
  MemoryKind,
  MemoryRecord,
  MemoryStatus,
  MessageRecord,
  MessageRole,
  MessageSource,
  PermissionLevel,
  Relationship,
  SessionRecord,
  ToolDecision,
  ToolRunRecord,
  UsageBreakdownRow,
  VoiceDictWord,
  WordType,
} from '@shared/types';
import { type Db, type Row, fromBlob, toBlob } from './Db';

const iso = (d: Date = new Date()) => d.toISOString();

// ---------------- conversations ----------------

function toSession(r: Row): SessionRecord {
  return {
    id: Number(r.id),
    startedAt: String(r.started_at),
    endedAt: (r.ended_at as string) ?? null,
    summary: (r.summary as string) ?? null,
    extracted: !!r.extracted,
    noMemory: !!r.no_memory,
  };
}

function toMessage(r: Row): MessageRecord {
  return {
    id: Number(r.id),
    sessionId: Number(r.session_id),
    role: r.role as MessageRole,
    source: r.source as MessageSource,
    content: String(r.content),
    emotion: (r.emotion as Emotion) ?? null,
    tokensIn: Number(r.tokens_in),
    tokensOut: Number(r.tokens_out),
    createdAt: String(r.created_at),
  };
}

export class ConversationRepo {
  constructor(private readonly db: Db) {}

  createSession(now = new Date()): SessionRecord {
    const { lastId } = this.db.run('INSERT INTO sessions (started_at) VALUES (?)', iso(now));
    return this.session(lastId)!;
  }

  session(id: number): SessionRecord | null {
    const r = this.db.get('SELECT * FROM sessions WHERE id = ?', id);
    return r ? toSession(r) : null;
  }

  latestSession(): SessionRecord | null {
    const r = this.db.get('SELECT * FROM sessions ORDER BY id DESC LIMIT 1');
    return r ? toSession(r) : null;
  }

  touchSession(id: number, now = new Date()): void {
    this.db.run('UPDATE sessions SET ended_at = ? WHERE id = ?', iso(now), id);
  }

  setSessionSummary(id: number, summary: string): void {
    this.db.run('UPDATE sessions SET summary = ? WHERE id = ?', summary, id);
  }

  setNoMemory(id: number): void {
    this.db.run('UPDATE sessions SET no_memory = 1 WHERE id = ?', id);
  }

  markExtracted(id: number): void {
    this.db.run('UPDATE sessions SET extracted = 1 WHERE id = ?', id);
  }

  sessions(limit: number, offset: number): SessionRecord[] {
    return this.db.all('SELECT * FROM sessions ORDER BY id DESC LIMIT ? OFFSET ?', limit, offset).map(toSession);
  }

  addMessage(m: {
    sessionId: number; role: MessageRole; source: MessageSource; content: string;
    emotion?: Emotion | null; tokensIn?: number; tokensOut?: number; now?: Date;
  }): MessageRecord {
    const { lastId } = this.db.run(
      'INSERT INTO messages (session_id, role, source, content, emotion, tokens_in, tokens_out, created_at) VALUES (?,?,?,?,?,?,?,?)',
      m.sessionId, m.role, m.source, m.content, m.emotion ?? null, m.tokensIn ?? 0, m.tokensOut ?? 0, iso(m.now),
    );
    this.touchSession(m.sessionId, m.now);
    return this.message(lastId)!;
  }

  updateMessage(id: number, content: string, emotion: Emotion | null, tokensIn: number, tokensOut: number): void {
    this.db.run('UPDATE messages SET content = ?, emotion = ?, tokens_in = ?, tokens_out = ? WHERE id = ?', content, emotion, tokensIn, tokensOut, id);
  }

  message(id: number): MessageRecord | null {
    const r = this.db.get('SELECT * FROM messages WHERE id = ?', id);
    return r ? toMessage(r) : null;
  }

  messages(sessionId: number): MessageRecord[] {
    return this.db.all('SELECT * FROM messages WHERE session_id = ? ORDER BY id', sessionId).map(toMessage);
  }

  /**
   * Messages written in [fromIso, toIso) for the journal. Sessions flagged "この会話は記憶しないで" are left out,
   * and so are the app's own proactive turns (the user said nothing there).
   */
  messagesBetween(fromIso: string, toIso: string): MessageRecord[] {
    return this.db
      .all(
        "SELECT m.* FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.no_memory = 0 AND m.source != 'proactive' AND m.created_at >= ? AND m.created_at < ? ORDER BY m.id",
        fromIso, toIso,
      )
      .map(toMessage);
  }

  /** Messages not yet passed to the memory extractor, per session, oldest first. */
  unextracted(limit = 200): { session: SessionRecord; messages: MessageRecord[] }[] {
    const rows = this.db.all('SELECT * FROM sessions WHERE extracted = 0 ORDER BY id LIMIT 20');
    return rows
      .map((r) => ({
        session: toSession(r),
        messages: this.db
          .all('SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?', Number(r.id), Number(r.extracted_upto ?? 0), limit)
          .map(toMessage),
      }))
      .filter((x) => x.messages.length > 0 || !x.session.extracted);
  }

  countUnextractedUserMessages(sessionId: number): number {
    return (
      this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.id = ? AND m.role = 'user' AND m.id > s.extracted_upto",
        sessionId,
      )?.n ?? 0
    );
  }

  setExtractedUpto(sessionId: number, messageId: number, closed: boolean): void {
    this.db.run('UPDATE sessions SET extracted_upto = MAX(extracted_upto, ?), extracted = ? WHERE id = ?', messageId, closed ? 1 : 0, sessionId);
  }

  search(q: string, limit = 50): { message: MessageRecord; snippet: string }[] {
    const term = q.trim();
    if (!term) return [];
    if ([...term].length < 3) {
      // trigram needs 3+ chars: fall back to LIKE
      return this.db
        .all("SELECT * FROM messages WHERE content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?", `%${term.replace(/[%_\\]/g, '\\$&')}%`, limit)
        .map((r) => ({ message: toMessage(r), snippet: snippetAround(String(r.content), term) }));
    }
    return this.db
      .all(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ? ORDER BY m.id DESC LIMIT ?`,
        ftsQuote(term), limit,
      )
      .map((r) => ({ message: toMessage(r), snippet: snippetAround(String(r.content), term) }));
  }

  deleteAll(): void {
    this.db.exec('DELETE FROM messages; DELETE FROM sessions;');
  }
}

export function ftsQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function snippetAround(text: string, term: string): string {
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return text.slice(0, 80);
  return (i > 30 ? '…' : '') + text.slice(Math.max(0, i - 30), i + term.length + 50) + (i + term.length + 50 < text.length ? '…' : '');
}

// ---------------- memories ----------------

export interface MemoryRow extends MemoryRecord {
  embedding: Float32Array | null;
}

function toMemory(r: Row): MemoryRow {
  return {
    id: Number(r.id),
    kind: r.kind as MemoryKind,
    content: String(r.content),
    importance: Number(r.importance),
    embedding: fromBlob(r.embedding),
    dueAt: (r.due_at as string) ?? null,
    sourceMessageId: r.source_message_id == null ? null : Number(r.source_message_id),
    status: r.status as MemoryStatus,
    supersededBy: r.superseded_by == null ? null : Number(r.superseded_by),
    pinned: !!r.pinned,
    useCount: Number(r.use_count),
    lastUsedAt: (r.last_used_at as string) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function stripEmbedding(m: MemoryRow): MemoryRecord {
  const { embedding: _e, ...rest } = m;
  return rest;
}

export class MemoryRepo {
  constructor(private readonly db: Db) {}

  insert(m: { kind: MemoryKind; content: string; importance: number; embedding: Float32Array | null; dueAt?: string | null; sourceMessageId?: number | null; pinned?: boolean; now?: Date }): MemoryRow {
    const t = iso(m.now);
    const { lastId } = this.db.run(
      'INSERT INTO memories (kind, content, importance, embedding, due_at, source_message_id, pinned, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      m.kind, m.content, m.importance, m.embedding ? toBlob(m.embedding) : null, m.dueAt ?? null, m.sourceMessageId ?? null, m.pinned ? 1 : 0, t, t,
    );
    return this.get(lastId)!;
  }

  get(id: number): MemoryRow | null {
    const r = this.db.get('SELECT * FROM memories WHERE id = ?', id);
    return r ? toMemory(r) : null;
  }

  active(): MemoryRow[] {
    return this.db.all("SELECT * FROM memories WHERE status = 'active'").map(toMemory);
  }

  /** Active memories created in [fromIso, toIso). */
  createdBetween(fromIso: string, toIso: string): MemoryRow[] {
    return this.db.all("SELECT * FROM memories WHERE status = 'active' AND created_at >= ? AND created_at < ? ORDER BY id", fromIso, toIso).map(toMemory);
  }

  /** Active schedule memories due in [fromIso, toIso). */
  schedulesDueBetween(fromIso: string, toIso: string): MemoryRow[] {
    return this.db.all("SELECT * FROM memories WHERE status = 'active' AND kind = 'schedule' AND due_at >= ? AND due_at < ? ORDER BY due_at", fromIso, toIso).map(toMemory);
  }

  list(filter: { kind?: MemoryKind; status?: MemoryStatus; query?: string } = {}): MemoryRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.kind) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    } else where.push("status IN ('active','archived')");
    if (filter.query) {
      where.push("content LIKE ? ESCAPE '\\'");
      params.push(`%${filter.query.replace(/[%_\\]/g, '\\$&')}%`);
    }
    return this.db.all(`SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY pinned DESC, updated_at DESC LIMIT 2000`, ...params).map(toMemory);
  }

  update(id: number, patch: Partial<{ kind: MemoryKind; content: string; importance: number; pinned: boolean; status: MemoryStatus; dueAt: string | null; embedding: Float32Array | null; supersededBy: number | null }>, now = new Date()): MemoryRow | null {
    const sets: string[] = [];
    const params: (string | number | null | Uint8Array)[] = [];
    const add = (col: string, v: string | number | null | Uint8Array) => {
      sets.push(`${col} = ?`);
      params.push(v);
    };
    if (patch.kind !== undefined) add('kind', patch.kind);
    if (patch.content !== undefined) add('content', patch.content);
    if (patch.importance !== undefined) add('importance', Math.min(1, Math.max(0, patch.importance)));
    if (patch.pinned !== undefined) add('pinned', patch.pinned ? 1 : 0);
    if (patch.status !== undefined) {
      add('status', patch.status);
      add('trashed_at', patch.status === 'trashed' ? iso(now) : null);
    }
    if (patch.dueAt !== undefined) add('due_at', patch.dueAt);
    if (patch.embedding !== undefined) add('embedding', patch.embedding ? toBlob(patch.embedding) : null);
    if (patch.supersededBy !== undefined) add('superseded_by', patch.supersededBy);
    if (!sets.length) return this.get(id);
    add('updated_at', iso(now));
    params.push(id);
    this.db.run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return this.get(id);
  }

  markUsed(ids: number[], now = new Date()): void {
    for (const id of ids) this.db.run('UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?', iso(now), id);
  }

  ftsSearch(q: string, limit = 20): { row: MemoryRow; rank: number }[] {
    const term = q.trim();
    if ([...term].length < 3) return [];
    // OR of 3-char shingles so partial overlaps still match
    const grams = new Set<string>();
    const chars = [...term.replace(/\s+/g, '')];
    for (let i = 0; i + 3 <= chars.length && grams.size < 24; i++) grams.add(chars.slice(i, i + 3).join(''));
    if (!grams.size) return [];
    const match = [...grams].map(ftsQuote).join(' OR ');
    return this.db
      .all(`SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid WHERE memories_fts MATCH ? AND m.status = 'active' ORDER BY rank LIMIT ?`, match, limit)
      .map((r) => ({ row: toMemory(r), rank: Number(r.rank) }));
  }

  /** Daily maintenance: archive stale, purge old trash, turn past schedules into episodes. */
  maintain(now = new Date()): { archived: number; purged: number; converted: number } {
    const cutoff180 = iso(new Date(now.getTime() - 180 * 86_400_000));
    const cutoff30 = iso(new Date(now.getTime() - 30 * 86_400_000));
    const archived = this.db.run(
      "UPDATE memories SET status = 'archived', updated_at = ? WHERE status = 'active' AND pinned = 0 AND kind != 'profile' AND importance < 0.3 AND COALESCE(last_used_at, created_at) < ?",
      iso(now), cutoff180,
    ).changes;
    const purged = this.db.run("DELETE FROM memories WHERE status = 'trashed' AND trashed_at < ?", cutoff30).changes;
    const converted = this.db.run(
      "UPDATE memories SET kind = 'episode', updated_at = ? WHERE kind = 'schedule' AND status = 'active' AND due_at IS NOT NULL AND due_at < ?",
      iso(now), iso(now),
    ).changes;
    return { archived, purged, converted };
  }

  deleteAll(): void {
    this.db.exec('DELETE FROM memories;');
  }
}

// ---------------- relationship ----------------

export class RelationshipRepo {
  constructor(private readonly db: Db) {}

  get(now = new Date()): Relationship {
    let r = this.db.get('SELECT * FROM relationship WHERE id = 1');
    if (!r) {
      this.db.run('INSERT INTO relationship (id, first_met_at) VALUES (1, ?)', iso(now));
      r = this.db.get('SELECT * FROM relationship WHERE id = 1')!;
    }
    return {
      affinity: Number(r.affinity),
      mood: Number(r.mood),
      dailyDelta: Number(r.daily_delta),
      deltaDate: String(r.delta_date),
      firstMetAt: String(r.first_met_at),
    };
  }

  save(rel: Relationship): void {
    this.get();
    this.db.run(
      'UPDATE relationship SET affinity = ?, mood = ?, daily_delta = ?, delta_date = ?, first_met_at = ? WHERE id = 1',
      rel.affinity, rel.mood, rel.dailyDelta, rel.deltaDate, rel.firstMetAt,
    );
  }

  reset(now = new Date()): void {
    this.db.run('DELETE FROM relationship');
    this.get(now);
  }
}

// ---------------- tool runs ----------------

function toToolRun(r: Row): ToolRunRecord {
  return {
    id: Number(r.id),
    messageId: r.message_id == null ? null : Number(r.message_id),
    tool: String(r.tool),
    level: r.level as PermissionLevel,
    argsJson: String(r.args_json),
    resultJson: String(r.result_json),
    decision: r.decision as ToolDecision,
    undoJson: (r.undo_json as string) ?? null,
    undoneAt: (r.undone_at as string) ?? null,
    createdAt: String(r.created_at),
  };
}

export class ToolRunRepo {
  constructor(private readonly db: Db) {}

  insert(r: { messageId: number | null; tool: string; level: PermissionLevel; args: unknown; decision: ToolDecision }): number {
    return this.db.run(
      'INSERT INTO tool_runs (message_id, tool, level, args_json, decision, created_at) VALUES (?,?,?,?,?,?)',
      r.messageId, r.tool, r.level, safeJson(r.args), r.decision, iso(),
    ).lastId;
  }

  finish(id: number, result: unknown, undo: unknown | null): void {
    this.db.run('UPDATE tool_runs SET result_json = ?, undo_json = ? WHERE id = ?', safeJson(result).slice(0, 2000), undo ? JSON.stringify(undo) : null, id);
  }

  setMessage(ids: number[], messageId: number): void {
    for (const id of ids) this.db.run('UPDATE tool_runs SET message_id = ? WHERE id = ?', messageId, id);
  }

  markUndone(id: number): void {
    this.db.run('UPDATE tool_runs SET undone_at = ? WHERE id = ?', iso(), id);
  }

  get(id: number): ToolRunRecord | null {
    const r = this.db.get('SELECT * FROM tool_runs WHERE id = ?', id);
    return r ? toToolRun(r) : null;
  }

  list(limit: number): ToolRunRecord[] {
    return this.db.all('SELECT * FROM tool_runs ORDER BY id DESC LIMIT ?', limit).map(toToolRun);
  }

  /** Runs that actually executed (auto-run or approved) in [fromIso, toIso). */
  executedBetween(fromIso: string, toIso: string): ToolRunRecord[] {
    return this.db
      .all("SELECT * FROM tool_runs WHERE decision IN ('auto','approved') AND created_at >= ? AND created_at < ? ORDER BY id", fromIso, toIso)
      .map(toToolRun);
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (typeof val === 'string' && val.length > 4000 ? `${val.slice(0, 4000)}…` : val)) ?? '';
  } catch {
    return String(v);
  }
}

// ---------------- usage ----------------

export class UsageRepo {
  constructor(private readonly db: Db) {}

  add(date: string, model: string, purpose: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number; webSearches: number; usd: number }): void {
    this.db.run(
      `INSERT INTO usage_daily (date, model, purpose, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, web_searches, usd)
       VALUES (?,?,?,1,?,?,?,?,?,?)
       ON CONFLICT(date, model, purpose) DO UPDATE SET
         requests = requests + 1,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
         web_searches = web_searches + excluded.web_searches,
         usd = usd + excluded.usd`,
      date, model, purpose, u.input, u.output, u.cacheRead, u.cacheWrite, u.webSearches, u.usd,
    );
  }

  sumSince(date: string): number {
    return this.db.get<{ s: number | null }>('SELECT SUM(usd) AS s FROM usage_daily WHERE date >= ?', date)?.s ?? 0;
  }

  sumOn(date: string): number {
    return this.db.get<{ s: number | null }>('SELECT SUM(usd) AS s FROM usage_daily WHERE date = ?', date)?.s ?? 0;
  }

  /** Per purpose × model totals since `date`, most expensive first. */
  breakdownSince(date: string): UsageBreakdownRow[] {
    return this.db
      .all(
        `SELECT purpose, model, SUM(requests) AS requests, SUM(input_tokens) AS i, SUM(output_tokens) AS o,
                SUM(cache_read_tokens) AS cr, SUM(cache_write_tokens) AS cw, SUM(web_searches) AS ws, SUM(usd) AS usd
         FROM usage_daily WHERE date >= ? GROUP BY purpose, model ORDER BY usd DESC`,
        date,
      )
      .map((r) => ({
        purpose: String(r.purpose),
        model: String(r.model),
        requests: Number(r.requests),
        inputTokens: Number(r.i),
        outputTokens: Number(r.o),
        cacheReadTokens: Number(r.cr),
        cacheWriteTokens: Number(r.cw),
        webSearches: Number(r.ws),
        usd: Number(r.usd),
      }));
  }
}

// ---------------- voice dictionary ----------------

function toDict(r: Row): VoiceDictWord {
  return {
    id: Number(r.id),
    surface: String(r.surface),
    pronunciation: String(r.pronunciation),
    accentType: Number(r.accent_type),
    wordType: r.word_type as WordType,
    priority: Number(r.priority),
    engineUuid: (r.engine_uuid as string) ?? null,
    updatedAt: String(r.updated_at),
  };
}

export class VoiceDictRepo {
  constructor(private readonly db: Db) {}
  list(): VoiceDictWord[] {
    return this.db.all('SELECT * FROM voice_dict ORDER BY surface').map(toDict);
  }
  get(id: number): VoiceDictWord | null {
    const r = this.db.get('SELECT * FROM voice_dict WHERE id = ?', id);
    return r ? toDict(r) : null;
  }
  insert(w: Omit<VoiceDictWord, 'id' | 'updatedAt'>): VoiceDictWord {
    const { lastId } = this.db.run(
      'INSERT INTO voice_dict (surface, pronunciation, accent_type, word_type, priority, engine_uuid, updated_at) VALUES (?,?,?,?,?,?,?)',
      w.surface, w.pronunciation, w.accentType, w.wordType, w.priority, w.engineUuid, iso(),
    );
    return this.get(lastId)!;
  }
  update(id: number, w: Omit<VoiceDictWord, 'id' | 'updatedAt'>): void {
    this.db.run(
      'UPDATE voice_dict SET surface = ?, pronunciation = ?, accent_type = ?, word_type = ?, priority = ?, engine_uuid = ?, updated_at = ? WHERE id = ?',
      w.surface, w.pronunciation, w.accentType, w.wordType, w.priority, w.engineUuid, iso(), id,
    );
  }
  setUuid(id: number, uuid: string | null): void {
    this.db.run('UPDATE voice_dict SET engine_uuid = ? WHERE id = ?', uuid, id);
  }
  delete(id: number): void {
    this.db.run('DELETE FROM voice_dict WHERE id = ?', id);
  }
}

// ---------------- timers ----------------

export interface TimerRow {
  id: number;
  kind: 'timer' | 'reminder';
  label: string;
  fireAt: string;
}

export class TimerRepo {
  constructor(private readonly db: Db) {}
  add(kind: 'timer' | 'reminder', label: string, fireAt: Date): number {
    return this.db.run('INSERT INTO timers (kind, label, fire_at, created_at) VALUES (?,?,?,?)', kind, label, iso(fireAt), iso()).lastId;
  }
  pending(): TimerRow[] {
    return this.db
      .all('SELECT * FROM timers WHERE fired_at IS NULL AND cancelled = 0 ORDER BY fire_at')
      .map((r) => ({ id: Number(r.id), kind: r.kind as TimerRow['kind'], label: String(r.label), fireAt: String(r.fire_at) }));
  }
  fired(id: number): void {
    this.db.run('UPDATE timers SET fired_at = ? WHERE id = ?', iso(), id);
  }
  cancel(id: number): boolean {
    return this.db.run('UPDATE timers SET cancelled = 1 WHERE id = ? AND fired_at IS NULL AND cancelled = 0', id).changes > 0;
  }
}

// ---------------- proactive events / patterns / latency ----------------

export class ProactiveRepo {
  constructor(private readonly db: Db) {}
  add(trigger: string, at: Date, ref: string | null = null): number {
    return this.db.run('INSERT INTO proactive_events (trigger, fired_at, ref) VALUES (?, ?, ?)', trigger, iso(at), ref).lastId;
  }
  /** A one-off line about `ref` was already said. */
  said(trigger: string, ref: string): boolean {
    return !!this.db.get('SELECT 1 AS x FROM proactive_events WHERE trigger = ? AND ref = ? LIMIT 1', trigger, ref);
  }
  /** The line could not be said after all (the app was busy): let it be tried again. */
  forgetRef(id: number): void {
    this.db.run('UPDATE proactive_events SET ref = NULL WHERE id = ?', id);
  }
  setReaction(id: number, reaction: 'replied' | 'ignored' | 'dismissed'): void {
    this.db.run('UPDATE proactive_events SET reaction = ? WHERE id = ?', reaction, id);
  }
  since(at: Date): { id: number; trigger: string; firedAt: string; reaction: string | null }[] {
    return this.db
      .all('SELECT * FROM proactive_events WHERE fired_at >= ? ORDER BY fired_at', iso(at))
      .map((r) => ({ id: Number(r.id), trigger: String(r.trigger), firedAt: String(r.fired_at), reaction: (r.reaction as string) ?? null }));
  }
  /** Most recent reactions per trigger, newest first. */
  recentReactions(trigger: string, n: number): (string | null)[] {
    return this.db.all('SELECT reaction FROM proactive_events WHERE trigger = ? ORDER BY id DESC LIMIT ?', trigger, n).map((r) => (r.reaction as string) ?? null);
  }
}

export class PatternRepo {
  constructor(private readonly db: Db) {}
  addMinute(hourKey: string, app: string | null): void {
    this.db.run(
      `INSERT INTO usage_patterns (hour, active_minutes, top_app) VALUES (?, 1, ?)
       ON CONFLICT(hour) DO UPDATE SET active_minutes = active_minutes + 1, top_app = COALESCE(excluded.top_app, top_app)`,
      hourKey, app,
    );
  }
  /** Fraction of the last `days` days in which the user was active during local hour `h`. */
  activityRate(h: number, days: number, now = new Date()): number {
    const from = new Date(now.getTime() - days * 86_400_000);
    const rows = this.db.all<{ hour: string; m: number }>('SELECT hour, active_minutes AS m FROM usage_patterns WHERE hour >= ?', localHourKey(from));
    const hits = rows.filter((r) => Number(r.hour.slice(11, 13)) === h && r.m >= 5).length;
    return hits / days;
  }
  prune(now = new Date()): void {
    this.db.run('DELETE FROM usage_patterns WHERE hour < ?', localHourKey(new Date(now.getTime() - 30 * 86_400_000)));
  }
}

export function localHourKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

export class LatencyRepo {
  constructor(private readonly db: Db) {}
  add(r: { turnId: number; source: string; speechEnd?: number; transcript?: number; firstToken?: number; firstSentence?: number; firstAudio?: number }): void {
    this.db.run(
      'INSERT INTO latency (turn_id, source, created_at, speech_end_ms, transcript_ms, first_token_ms, first_sentence_ms, first_audio_ms) VALUES (?,?,?,?,?,?,?,?)',
      r.turnId, r.source, iso(), r.speechEnd ?? null, r.transcript ?? null, r.firstToken ?? null, r.firstSentence ?? null, r.firstAudio ?? null,
    );
  }
  all(limit = 1000): Row[] {
    return this.db.all('SELECT * FROM latency ORDER BY id DESC LIMIT ?', limit);
  }
}

export class Store {
  readonly conv: ConversationRepo;
  readonly memories: MemoryRepo;
  readonly relationship: RelationshipRepo;
  readonly toolRuns: ToolRunRepo;
  readonly usage: UsageRepo;
  readonly voiceDict: VoiceDictRepo;
  readonly timers: TimerRepo;
  readonly proactive: ProactiveRepo;
  readonly patterns: PatternRepo;
  readonly latency: LatencyRepo;

  constructor(readonly db: Db) {
    this.conv = new ConversationRepo(db);
    this.memories = new MemoryRepo(db);
    this.relationship = new RelationshipRepo(db);
    this.toolRuns = new ToolRunRepo(db);
    this.usage = new UsageRepo(db);
    this.voiceDict = new VoiceDictRepo(db);
    this.timers = new TimerRepo(db);
    this.proactive = new ProactiveRepo(db);
    this.patterns = new PatternRepo(db);
    this.latency = new LatencyRepo(db);
  }

  /** Full reset from the memory screen: memories, conversations, relationship (spec 7.3). */
  wipePersonalData(): void {
    this.db.tx(() => {
      this.memories.deleteAll();
      this.conv.deleteAll();
      this.db.exec('DELETE FROM proactive_events; DELETE FROM usage_patterns;');
      this.relationship.reset();
    });
  }
}
