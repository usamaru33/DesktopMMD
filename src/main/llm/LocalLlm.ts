// Local LLM (Ollama). The Orchestrator keeps talking to an LlmAdapter; this is the third implementation next
// to LlmClient (Claude) and FakeLlm. Measured on an RTX 4070 SUPER with Qwen3 8B (scripts/eval-local.ts):
// - format compliance is fine either way;
// - tool calling with default settings is poor (~6/14): "needs approval" wording makes the model ask in chat
//   instead of calling the tool (~9/14 without it), and with thinking on it reaches 14/14, but thinking costs
//   ~2.6 s before the first word. So: conversation-only by default; tools are an opt-in (settings.llm.localTools),
//   with no approval wording and thinking only for requests that look like work (needsThinking).
import type { BetaMessage, JsonParams, LlmAdapter, Msg, StreamParams, SystemBlock } from './LlmClient';
import { demoteSystemMessages, LlmUnavailableError } from './LlmClient';

/** The history cap is ~12k tokens (spec 5.2); Ollama silently truncates past num_ctx, so size it to fit. */
export const LOCAL_NUM_CTX = 12288;
const KEEP_ALIVE = '30m';
const REQUEST_TIMEOUT_MS = 180_000;

export interface OllamaMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: { type?: string; text?: string }) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[画像]' : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Claude-shaped messages → Ollama chat messages. Consecutive same-role text turns are merged; tool_use blocks
 * become `tool_calls` and tool_result blocks become `tool` messages (named after the call they answer).
 */
export function toOllamaMessages(system: SystemBlock[] | string, messages: Msg[]): OllamaMsg[] {
  const out: OllamaMsg[] = [];
  const sys = typeof system === 'string' ? system : system.map((b) => b.text).join('\n\n');
  if (sys.trim()) out.push({ role: 'system', content: sys });
  const toolNames = new Map<string, string>();
  const pushText = (role: 'user' | 'assistant', text: string) => {
    if (!text.trim()) return;
    const last = out[out.length - 1];
    if (last && last.role === role && !last.tool_calls) last.content += `\n\n${text}`;
    else out.push({ role, content: text });
  };
  for (const m of demoteSystemMessages(messages)) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (typeof m.content === 'string') {
      pushText(m.role, m.content);
      continue;
    }
    const text = m.content.map((b) => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
    if (m.role === 'assistant') {
      const calls = m.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }] : []));
      for (const c of calls) toolNames.set(c.id, c.name);
      if (calls.length) out.push({ role: 'assistant', content: text, tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.input } })) });
      else pushText('assistant', text);
      continue;
    }
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      const body = blockText(b.content);
      out.push({ role: 'tool', tool_name: toolNames.get(b.tool_use_id) ?? 'tool', content: b.is_error ? `エラー: ${body}` : body });
    }
    pushText('user', text);
  }
  return out;
}

/** Claude tool definitions → Ollama function tools (server tools such as web_search can't run locally and are dropped). */
export function toOllamaTools(tools: StreamParams['tools']): { type: 'function'; function: { name: string; description: string; parameters: unknown } }[] {
  return tools.flatMap((t) => {
    if (!('input_schema' in t) || !('name' in t)) return [];
    const d = t as { name: string; description?: string; input_schema: unknown };
    return [{ type: 'function' as const, function: { name: d.name, description: d.description ?? '', parameters: d.input_schema } }];
  });
}

const WORK_WORDS =
  /(ファイル|フォルダ|ディレクトリ|デスクトップ|ドキュメント|メモ.*(作|書|残|保存)|作って|作成|書いて|書き込|保存|開いて|開く|起動|立ち上げ|探して|検索|調べて|消して|削除|移動|名前を変|リネーム|コピー|貼り付|クリップボード|スクリーンショット|画面|タイマー|リマインド|予定|集中|覚えて|忘れて|それは違|じゃなくて|ではなく|https?:\/\/)/i;

/**
 * Does this utterance look like a request for work (files, timers, memory, web, screen…)? Only those turns pay
 * for thinking (~2.6 s to the first word); small talk keeps the ~0.06 s start. Biased towards "yes": a false
 * positive only costs time, a false negative makes the model talk about doing it instead of calling the tool.
 */
export function needsThinking(text: string): boolean {
  return WORK_WORDS.test(text);
}

/** The user's latest words, or null when the turn is answering a tool result (no need to think again). */
function lastUserText(messages: Msg[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'system') continue;
    if (m.role !== 'user') return null;
    if (typeof m.content === 'string') return m.content;
    if (m.content.some((b) => b.type === 'tool_result')) return null;
    return m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  }
  return null;
}

export interface OllamaDeps {
  url(): string;
  fetch?: typeof fetch;
}

export class OllamaClient implements LlmAdapter {
  readonly kind = 'local' as const;
  /** models that rejected the `think` field (non-thinking models on some Ollama versions) */
  private readonly noThink = new Set<string>();

  constructor(private readonly d: OllamaDeps) {}

  private get f(): typeof fetch {
    return this.d.fetch ?? fetch;
  }

  private endpoint(path: string): string {
    return `${this.d.url().replace(/\/+$/, '')}${path}`;
  }

  private async post(path: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    const model = String(body.model);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.f(this.endpoint(path), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(this.noThink.has(model) ? { ...body, think: undefined } : body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
      } catch (e) {
        if (signal.aborted) throw e;
        throw new LlmUnavailableError(`Ollama に接続できません: ${(e as Error).message}`, 'local_down');
      }
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      if (res.status === 400 && attempt === 0 && 'think' in body && /think/i.test(text)) {
        this.noThink.add(model);
        continue;
      }
      // 404: the model isn't pulled. Both cases are fixed the same way (start Ollama / pull the model).
      throw new LlmUnavailableError(`Ollama HTTP ${res.status}: ${text.slice(0, 200)}`, res.status === 404 ? 'local_down' : res.status >= 500 ? 'server' : 'bad_request');
    }
  }

  async stream(p: StreamParams): Promise<BetaMessage> {
    const tools = toOllamaTools(p.tools);
    const res = await this.post(
      '/api/chat',
      {
        model: p.model,
        messages: toOllamaMessages(p.system, p.messages),
        ...(tools.length ? { tools } : {}),
        stream: true,
        think: p.think === true,
        keep_alive: KEEP_ALIVE,
        options: { num_ctx: LOCAL_NUM_CTX, num_predict: p.maxTokens, temperature: 0.7 },
      },
      p.signal,
    );
    let text = '';
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    let inTok = 0;
    let outTok = 0;
    let cut = false;
    const dec = new TextDecoder();
    let buf = '';
    const line = (raw: string) => {
      if (!raw.trim()) return;
      const j = JSON.parse(raw) as {
        message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: Record<string, unknown> } }[] };
        done?: boolean;
        done_reason?: string;
        prompt_eval_count?: number;
        eval_count?: number;
        error?: string;
      };
      if (j.error) throw new LlmUnavailableError(j.error, 'server');
      const c = j.message?.content ?? '';
      if (c) {
        text += c;
        p.onText?.(c);
      }
      for (const tc of j.message?.tool_calls ?? []) {
        if (tc.function?.name) calls.push({ name: tc.function.name, input: tc.function.arguments ?? {} });
      }
      if (j.done) {
        inTok = j.prompt_eval_count ?? 0;
        outTok = j.eval_count ?? 0;
        cut = j.done_reason === 'length';
      }
    };
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          line(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
      line(buf);
    } catch (e) {
      if (p.signal.aborted || e instanceof LlmUnavailableError) throw e;
      throw new LlmUnavailableError(`Ollama の応答を読めませんでした: ${(e as Error).message}`, 'network');
    }
    const stamp = Date.now();
    return {
      id: `msg_local_${stamp}`,
      type: 'message',
      role: 'assistant',
      model: p.model,
      content: [
        ...(text || !calls.length ? [{ type: 'text', text, citations: null }] : []),
        ...calls.map((c, i) => ({ type: 'tool_use', id: `toolu_local_${stamp}_${i}`, name: c.name, input: c.input })),
      ],
      stop_reason: calls.length ? 'tool_use' : cut ? 'max_tokens' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: inTok, output_tokens: outTok },
    } as unknown as BetaMessage;
  }

  private async once(model: string, system: string, user: string, maxTokens: number, format: unknown, signal?: AbortSignal): Promise<string> {
    const res = await this.post(
      '/api/chat',
      {
        model,
        messages: toOllamaMessages(system, [{ role: 'user', content: user }]),
        stream: false,
        think: false,
        keep_alive: KEEP_ALIVE,
        ...(format ? { format } : {}),
        options: { num_ctx: LOCAL_NUM_CTX, num_predict: maxTokens, temperature: format ? 0 : 0.3 },
      },
      signal ?? new AbortController().signal,
    );
    const j = (await res.json()) as { message?: { content?: string } };
    return (j.message?.content ?? '').trim();
  }

  async json<T>(p: JsonParams): Promise<T> {
    const text = await this.once(p.model, p.system, p.user, p.maxTokens, p.schema, p.signal);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new LlmUnavailableError('ローカルAIの出力がJSONになっていません', 'bad_request');
    }
  }

  async text(p: { model: string; system: string; user: string; maxTokens: number; purpose: string }): Promise<string> {
    return this.once(p.model, p.system, p.user, p.maxTokens, null);
  }

  /** Load the model into memory ahead of the first message (a cold load took ~54 s in the measurements). */
  async warmUp(model: string): Promise<boolean> {
    try {
      const res = await this.f(this.endpoint('/api/generate'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: KEEP_ALIVE, options: { num_ctx: LOCAL_NUM_CTX } }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/** Installed model names, or the reason Ollama can't be reached. */
export async function listOllamaModels(url: string, f: typeof fetch = fetch, timeoutMs = 2500): Promise<{ ok: true; version: string | null; models: string[] } | { ok: false; error: string }> {
  const base = url.replace(/\/+$/, '');
  try {
    const res = await f(`${base}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = (await res.json()) as { models?: { name?: string }[] };
    let version: string | null = null;
    try {
      version = ((await (await f(`${base}/api/version`, { signal: AbortSignal.timeout(timeoutMs) })).json()) as { version?: string }).version ?? null;
    } catch {
      /* optional */
    }
    return { ok: true, version, models: (j.models ?? []).map((m) => String(m.name ?? '')).filter(Boolean) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Picks Claude or the local model per request. Conversation (`stream`) follows the setting (and proactive
 * lines can go local even in Claude mode, `proactiveLocal`); tools are only
 * present when the session was built with them (Orchestrator `chatOnly`). The background jobs (memory
 * extraction, summaries) use Claude when a key exists, and fall back to the local model without one.
 * Callers pass Claude model names, so local calls swap in the configured local model.
 */
export class RoutingLlm implements LlmAdapter {
  constructor(
    private readonly claude: LlmAdapter,
    private readonly local: LlmAdapter,
    private readonly cfg: { provider(): 'claude' | 'local'; localModel(): string; hasKey(): boolean; proactiveLocal?(): boolean },
  ) {}

  get kind(): LlmAdapter['kind'] {
    return this.cfg.provider() === 'local' ? 'local' : this.claude.kind;
  }

  private utilityLocal(): boolean {
    return this.cfg.provider() === 'local' && !this.cfg.hasKey();
  }

  async stream(p: StreamParams): Promise<BetaMessage> {
    if (this.cfg.provider() !== 'local') {
      // short proactive lines (greetings, break hints) can come from the local model for free; if Ollama
      // isn't there, nothing has been said yet, so fall back to Claude
      if (p.purpose === 'proactive' && this.cfg.proactiveLocal?.()) {
        try {
          return await this.local.stream({ ...p, model: this.cfg.localModel(), tools: [], think: false });
        } catch (e) {
          if (p.signal.aborted || !(e instanceof LlmUnavailableError) || e.reason !== 'local_down') throw e;
        }
      }
      return this.claude.stream(p);
    }
    // think only when tools are on offer and the user's words look like a work request
    const text = p.tools.length ? lastUserText(p.messages) : null;
    return this.local.stream({ ...p, model: this.cfg.localModel(), think: text !== null && needsThinking(text) });
  }

  json<T>(p: JsonParams): Promise<T> {
    return this.utilityLocal() ? this.local.json<T>({ ...p, model: this.cfg.localModel() }) : this.claude.json<T>(p);
  }

  text(p: { model: string; system: string; user: string; maxTokens: number; purpose: string }): Promise<string> {
    return this.utilityLocal() ? this.local.text({ ...p, model: this.cfg.localModel() }) : this.claude.text(p);
  }
}
