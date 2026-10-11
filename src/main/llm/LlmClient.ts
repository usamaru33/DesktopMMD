// Claude API access (spec 5.4, skill mmd-reply-protocol §5).
// - Streaming via client.beta.messages.stream + finalMessage() (beta namespace for fallbacks / block_binding).
// - Own retry (1s, 3s) for 429 / 5xx / connection errors, only before any text was emitted.
import Anthropic from '@anthropic-ai/sdk';
import type { Effort } from '@shared/types';
import { capsOf, type UsageLike } from './models';

export type Msg = Anthropic.Beta.Messages.BetaMessageParam;
export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
export type BetaTool = Anthropic.Beta.Messages.BetaToolUnion;
export type SystemBlock = Anthropic.Beta.Messages.BetaTextBlockParam;

export interface StreamParams {
  model: string;
  system: SystemBlock[];
  messages: Msg[];
  tools: BetaTool[];
  maxTokens: number;
  effort?: Effort;
  signal: AbortSignal;
  onText?(delta: string): void;
  purpose: string;
  /** false: strip cache_control (a one-off request whose prefix won't be reused soon; avoids paying cache writes) */
  cache?: boolean;
  /** lifetime of every cache breakpoint in this request (default 5m) */
  cacheTtl?: '5m' | '1h';
  /** local models only: let the model think before answering (slow to the first word, but picks tools far better) */
  think?: boolean;
}

export interface JsonParams {
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  signal?: AbortSignal;
  purpose: string;
}

/** The seam the Orchestrator and MemoryService depend on (NFR-09). */
export interface LlmAdapter {
  readonly kind: 'claude' | 'fake' | 'local';
  stream(p: StreamParams): Promise<BetaMessage>;
  json<T>(p: JsonParams): Promise<T>;
  text(p: { model: string; system: string; user: string; maxTokens: number; purpose: string }): Promise<string>;
}

export type UsageSink = (model: string, usage: UsageLike, purpose: string) => void;

export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: 'no_key' | 'auth' | 'network' | 'rate_limit' | 'server' | 'bad_request' | 'refusal' | 'local_down',
  ) {
    super(message);
  }
}

const RETRY_DELAYS = [1000, 3000];

export class LlmClient implements LlmAdapter {
  readonly kind = 'claude' as const;
  private client: Anthropic | null = null;
  private keyUsed: string | null = null;

  constructor(
    private readonly getKey: () => string | null,
    private readonly onUsage: UsageSink,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private sdk(): Anthropic {
    const key = this.getKey();
    if (!key) throw new LlmUnavailableError('APIキーが設定されていません', 'no_key');
    if (!this.client || this.keyUsed !== key) {
      this.client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 120_000 });
      this.keyUsed = key;
    }
    return this.client;
  }

  /** Build request params according to what the model accepts. Exported for tests. */
  static buildParams(p: Omit<StreamParams, 'signal' | 'onText' | 'purpose'>): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
    const caps = capsOf(p.model);
    if (p.cache === false) p = { ...p, system: stripCache(p.system), messages: p.messages.map(stripCacheMsg) };
    else if (p.cacheTtl === '1h') p = { ...p, system: setTtl(p.system, '1h'), messages: p.messages.map((m) => setTtlMsg(m, '1h')) };
    const betas: Anthropic.Beta.AnthropicBeta[] = [];
    const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
      model: p.model,
      max_tokens: p.maxTokens,
      system: p.system,
      messages: caps.midConversationSystem ? p.messages : demoteSystemMessages(p.messages),
      tools: p.tools.map((t) =>
        'type' in t && typeof t.type === 'string' && t.type.startsWith('web_search_') ? { ...t, type: caps.webSearchType } as BetaTool : t,
      ),
    };
    if (caps.adaptive) {
      // Sonnet 5.5 can't disable thinking; keep it short with effort, and degrade instead of failing
      // if a replayed thinking block no longer matches the history (preserved thinking).
      params.thinking = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
      params.output_config = { effort: p.effort ?? 'low' };
      betas.push('thinking-binding-controls-2026-08-01');
    }
    if (caps.serverFallback) {
      params.fallbacks = 'default';
      betas.push('server-side-fallback-2026-07-01');
    }
    if (betas.length) params.betas = betas;
    if (!p.tools.length) delete params.tools;
    return params;
  }

  async stream(p: StreamParams): Promise<BetaMessage> {
    const params = LlmClient.buildParams(p);
    let emitted = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const stream = this.sdk().beta.messages.stream(params, { signal: p.signal });
        stream.on('text', (delta) => {
          emitted = true;
          p.onText?.(delta);
        });
        const msg = await stream.finalMessage();
        this.onUsage(p.model, msg.usage as UsageLike, p.purpose);
        return msg;
      } catch (e) {
        if (p.signal.aborted) throw e;
        const reason = classify(e);
        if (!emitted && attempt < RETRY_DELAYS.length && (reason === 'rate_limit' || reason === 'server' || reason === 'network')) {
          await this.sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        throw new LlmUnavailableError((e as Error).message, reason);
      }
    }
  }

  async json<T>(p: JsonParams): Promise<T> {
    const msg = await this.createWithRetry(
      {
        model: p.model,
        max_tokens: p.maxTokens,
        system: p.system,
        messages: [{ role: 'user', content: p.user }],
        output_config: { format: { type: 'json_schema', schema: p.schema } },
      },
      p.purpose,
      p.signal,
    );
    const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return JSON.parse(text) as T;
  }

  async text(p: { model: string; system: string; user: string; maxTokens: number; purpose: string }): Promise<string> {
    const msg = await this.createWithRetry(
      { model: p.model, max_tokens: p.maxTokens, system: p.system, messages: [{ role: 'user', content: p.user }] },
      p.purpose,
    );
    return msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim();
  }

  private async createWithRetry(
    params: Anthropic.Messages.MessageCreateParamsNonStreaming,
    purpose: string,
    signal?: AbortSignal,
  ): Promise<Anthropic.Message> {
    for (let attempt = 0; ; attempt++) {
      try {
        const msg = await this.sdk().messages.create(params, { signal });
        this.onUsage(params.model, msg.usage as UsageLike, purpose);
        if (msg.stop_reason === 'refusal') throw new LlmUnavailableError('refusal', 'refusal');
        return msg;
      } catch (e) {
        if (e instanceof LlmUnavailableError) throw e;
        const reason = classify(e);
        if (attempt < RETRY_DELAYS.length && (reason === 'rate_limit' || reason === 'server' || reason === 'network')) {
          await this.sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        throw new LlmUnavailableError((e as Error).message, reason);
      }
    }
  }
}

export function classify(e: unknown): LlmUnavailableError['reason'] {
  if (e instanceof LlmUnavailableError) return e.reason;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return 'auth';
  if (e instanceof Anthropic.RateLimitError) return 'rate_limit';
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.UnprocessableEntityError) return 'bad_request';
  if (e instanceof Anthropic.InternalServerError) return 'server';
  if (e instanceof Anthropic.APIConnectionError) return 'network';
  if (e instanceof Anthropic.APIError) return e.status && e.status >= 500 ? 'server' : 'bad_request';
  return 'network';
}

function stripCache<T extends { cache_control?: unknown }>(blocks: T[]): T[] {
  return blocks.map((b) => {
    if (!('cache_control' in b)) return b;
    const { cache_control: _c, ...rest } = b;
    return rest as T;
  });
}

function setTtl<T extends { cache_control?: unknown }>(blocks: T[], ttl: '5m' | '1h'): T[] {
  return blocks.map((b) => (b.cache_control ? { ...b, cache_control: { type: 'ephemeral', ttl } } : b));
}

function setTtlMsg(m: Msg, ttl: '5m' | '1h'): Msg {
  return typeof m.content === 'string' ? m : { ...m, content: setTtl(m.content as { cache_control?: unknown }[], ttl) as Msg['content'] };
}

function stripCacheMsg(m: Msg): Msg {
  return typeof m.content === 'string' ? m : { ...m, content: stripCache(m.content as { cache_control?: unknown }[]) as Msg['content'] };
}

/** For models without mid-conversation system messages, turn them into user turns (API merges consecutive same-role turns). */
export function demoteSystemMessages(messages: Msg[]): Msg[] {
  return messages.map((m) => {
    if (m.role !== 'system') return m;
    const text = typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    return { role: 'user', content: `<context>\n${text}\n</context>` };
  });
}
