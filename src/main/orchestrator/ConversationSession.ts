// Short-term conversation state for one session (spec 5.1). The message history is append-only so
// replayed thinking blocks stay valid (preserved thinking); compaction is "simple compaction":
// summarize everything into one message and start a fresh history with it.
import type { BetaTool, Msg, SystemBlock } from '../llm/LlmClient';
import { estimateTokens } from '../memory/scoring';

export interface SessionInit {
  dbId: number;
  system: SystemBlock[];
  tools: BetaTool[];
  startedAt: Date;
}

export class ConversationSession {
  readonly dbId: number;
  readonly system: SystemBlock[];
  readonly tools: BetaTool[];
  readonly startedAt: Date;
  lastActivityAt: Date;
  /** このセッションの会話に最後に伝えたキャラクターのモード（null = なし） */
  modeSent: string | null = null;
  private history: Msg[] = [];
  private turns = 0;
  private pendingSummary: string | null = null;

  constructor(init: SessionInit) {
    this.dbId = init.dbId;
    this.system = init.system;
    this.tools = init.tools;
    this.startedAt = init.startedAt;
    this.lastActivityAt = init.startedAt;
  }

  get messages(): readonly Msg[] {
    return this.history;
  }

  get turnCount(): number {
    return this.turns;
  }

  /** Approximate token size of the history (text only). */
  approxTokens(): number {
    let n = 0;
    for (const m of this.history) {
      if (typeof m.content === 'string') n += estimateTokens(m.content);
      else
        for (const b of m.content) {
          if (b.type === 'text') n += estimateTokens(b.text);
          else if (b.type === 'tool_result') n += estimateTokens(typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''));
          else if (b.type === 'tool_use') n += estimateTokens(JSON.stringify(b.input));
          else if (b.type === 'image') n += 1500;
        }
    }
    return n;
  }

  needsCompaction(maxTurns: number, maxTokens: number): boolean {
    return this.turns >= maxTurns || this.approxTokens() > maxTokens;
  }

  /** Plain transcript for the summarizer. */
  transcript(): string {
    const out: string[] = [];
    for (const m of this.history) {
      if (m.role === 'system') continue;
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_use' ? `（ツール ${b.name} を使用）` : b.type === 'tool_result' ? '（ツール結果）' : ''))
              .filter(Boolean)
              .join(' ');
      if (text.trim()) out.push(`${m.role === 'user' ? 'ユーザー' : 'アシスタント'}: ${text}`);
    }
    return out.join('\n');
  }

  compact(summary: string): void {
    this.history = [];
    this.turns = 0;
    this.pendingSummary = summary;
  }

  /** Append the user's turn followed by the per-turn context as a mid-conversation system message. */
  appendUser(text: string, context: string, now: Date): void {
    const blocks: { type: 'text'; text: string }[] = [];
    if (this.pendingSummary) {
      blocks.push({ type: 'text', text: `<summary>\nこれまでの会話の要約:\n${this.pendingSummary}\n</summary>` });
      this.pendingSummary = null;
    }
    blocks.push({ type: 'text', text });
    // always block arrays: adding a cache_control marker later must not change the shape of the turn
    this.history.push({ role: 'user', content: blocks });
    this.history.push({ role: 'system', content: [{ type: 'text', text: context }] });
    this.turns++;
    this.lastActivityAt = now;
  }

  appendAssistant(content: Msg['content']): void {
    this.history.push({ role: 'assistant', content });
  }

  appendToolResults(results: Extract<Msg['content'], unknown[]>): void {
    this.history.push({ role: 'user', content: results });
  }

  /**
   * Messages for a request: the same history with a cache breakpoint on the newest block.
   * (Adding/moving cache_control markers doesn't invalidate thinking blocks.)
   */
  requestMessages(): Msg[] {
    const msgs = this.history.slice();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'system') continue;
      if (typeof m.content === 'string') {
        msgs[i] = { ...m, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] };
      } else if (m.content.length) {
        const last = m.content[m.content.length - 1];
        if (last.type === 'text' || last.type === 'tool_result' || last.type === 'tool_use') {
          msgs[i] = { ...m, content: [...m.content.slice(0, -1), { ...last, cache_control: { type: 'ephemeral' } } as typeof last] };
        }
      }
      break;
    }
    return msgs;
  }
}
