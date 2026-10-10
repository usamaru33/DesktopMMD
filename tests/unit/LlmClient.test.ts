// LlmClient against a fake fetch: checks the exact request we send and the SSE parsing / retry paths,
// without calling the real API.
import { describe, expect, it } from 'vitest';
import { LlmClient, demoteSystemMessages, LlmUnavailableError } from '../../src/main/llm/LlmClient';
import { costUsd, capsOf } from '../../src/main/llm/models';

function sse(events: object[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function textStream(text: string, stop = 'end_turn') {
  const chunks = text.match(/.{1,5}/gsu) ?? [];
  return sse([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    ...chunks.map((c) => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: c } })),
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ]);
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(responses: (() => Response)[], captured: Captured[]): typeof fetch {
  let i = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (h[k] = v));
    captured.push({ url: String(url), headers: h, body: JSON.parse(String(init?.body ?? '{}')) });
    const r = responses[Math.min(i++, responses.length - 1)];
    return r();
  }) as typeof fetch;
}

const ok = (body: string) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const err = (status: number) => () => new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'x' } }), { status, headers: { 'content-type': 'application/json' } });

function client(responses: (() => Response)[], captured: Captured[], usage: unknown[] = []) {
  const c = new LlmClient(() => 'sk-ant-test', (m, u) => usage.push({ m, u }), async () => {});
  // inject the fake fetch into the SDK client the first time it is created
  const orig = (c as unknown as { sdk: () => unknown }).sdk.bind(c);
  const f = fakeFetch(responses, captured);
  (c as unknown as { sdk: () => unknown }).sdk = () => {
    const s = orig() as { fetch?: unknown };
    (s as { fetch: typeof fetch }).fetch = f;
    return s;
  };
  return c;
}

describe('LlmClient request shape (claude-sonnet-5-5)', () => {
  it('streams text, sends adaptive thinking + effort, drop_block binding, fallbacks, betas, cache-friendly params', async () => {
    const captured: Captured[] = [];
    const usage: unknown[] = [];
    const c = client([ok(textStream('[happy:0.8]こんにちは！元気です。'))], captured, usage);
    let streamed = '';
    const msg = await c.stream({
      model: 'claude-sonnet-5-5',
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'やあ' }] }, { role: 'system', content: [{ type: 'text', text: '<context>x</context>' }] }],
      tools: [{ name: 'read_file', description: 'd', input_schema: { type: 'object', properties: {} } }, { type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
      maxTokens: 1024,
      effort: 'low',
      signal: new AbortController().signal,
      onText: (d) => (streamed += d),
      purpose: 'chat',
    });
    expect(streamed).toBe('[happy:0.8]こんにちは！元気です。');
    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.content.map((b) => b.type)).toEqual(['thinking', 'text']);

    const req = captured[0];
    expect(req.url).toContain('/v1/messages');
    expect(req.body.model).toBe('claude-sonnet-5-5');
    expect(req.body.stream).toBe(true);
    expect(req.body.max_tokens).toBe(1024);
    expect(req.body.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(req.body.output_config).toEqual({ effort: 'low' });
    expect(req.body.fallbacks).toBe('default');
    expect(req.body).not.toHaveProperty('tool_choice');
    expect(req.body).not.toHaveProperty('temperature');
    const betas = req.headers['anthropic-beta'];
    expect(betas).toContain('thinking-binding-controls-2026-08-01');
    expect(betas).toContain('server-side-fallback-2026-07-01');
    expect(req.headers['x-api-key']).toBe('sk-ant-test');
    // mid-conversation system message is passed through as-is for Sonnet 5.5
    expect((req.body.messages as { role: string }[]).map((m) => m.role)).toEqual(['user', 'system']);
    expect(usage).toHaveLength(1);
  });

  it("cacheTtl: '1h' puts a 1-hour TTL on every breakpoint (system and messages), and nothing else changes", () => {
    const base = {
      model: 'claude-sonnet-5-5',
      system: [{ type: 'text' as const, text: 's1' }, { type: 'text' as const, text: 's2', cache_control: { type: 'ephemeral' as const } }],
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'a', cache_control: { type: 'ephemeral' as const } }] }],
      tools: [],
      maxTokens: 10,
    };
    const p = LlmClient.buildParams({ ...base, cacheTtl: '1h' });
    const json = JSON.stringify(p);
    expect(json.match(/"cache_control"/g)).toHaveLength(2);
    expect(json.match(/"ttl":"1h"/g)).toHaveLength(2);
    expect((p.system as { text: string; cache_control?: unknown }[])[0].cache_control).toBeUndefined();
    // default stays 5m (no ttl field) and the inputs are not mutated
    expect(JSON.stringify(LlmClient.buildParams(base))).not.toContain('ttl');
    expect(JSON.stringify(base)).not.toContain('ttl');
    // a one-off request without cache wins over the TTL
    expect(JSON.stringify(LlmClient.buildParams({ ...base, cache: false, cacheTtl: '1h' }))).not.toContain('cache_control');
  });

  it('cache: false strips every cache_control marker', () => {
    const p = LlmClient.buildParams({
      model: 'claude-haiku-4-5',
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] }],
      tools: [],
      maxTokens: 10,
      cache: false,
    });
    expect(JSON.stringify(p)).not.toContain('cache_control');
    expect((p.system as { text: string }[])[0].text).toBe('s');
  });

  it('Haiku 4.5: no thinking/effort/fallbacks, system messages demoted, basic web search tool', () => {
    const p = LlmClient.buildParams({
      model: 'claude-haiku-4-5',
      system: [],
      messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 'ctx' }],
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
      maxTokens: 100,
      effort: 'low',
    });
    expect(p.thinking).toBeUndefined();
    expect(p.output_config).toBeUndefined();
    expect(p.fallbacks).toBeUndefined();
    expect(p.betas).toBeUndefined();
    expect(p.messages.map((m) => m.role)).toEqual(['user', 'user']);
    expect((p.tools as { type: string }[])[0].type).toBe('web_search_20250305');
  });

  it('retries 529/500 twice before the first token, then succeeds', async () => {
    const captured: Captured[] = [];
    const c = client([err(529), err(500), ok(textStream('はい。'))], captured);
    const msg = await c.stream({ model: 'claude-sonnet-5-5', system: [], messages: [{ role: 'user', content: 'a' }], tools: [], maxTokens: 10, signal: new AbortController().signal, purpose: 'chat' });
    expect(captured).toHaveLength(3);
    expect(msg.stop_reason).toBe('end_turn');
  });

  it('gives up after two retries with a typed error; 401 is not retried', async () => {
    const captured: Captured[] = [];
    const c = client([err(529)], captured);
    await expect(c.stream({ model: 'claude-sonnet-5-5', system: [], messages: [{ role: 'user', content: 'a' }], tools: [], maxTokens: 10, signal: new AbortController().signal, purpose: 'chat' })).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(captured).toHaveLength(3);
    const cap2: Captured[] = [];
    const c2 = client([err(401)], cap2);
    await expect(c2.stream({ model: 'claude-sonnet-5-5', system: [], messages: [{ role: 'user', content: 'a' }], tools: [], maxTokens: 10, signal: new AbortController().signal, purpose: 'chat' })).rejects.toMatchObject({ reason: 'auth' });
    expect(cap2).toHaveLength(1);
  });

  it('no key → no_key error without any request', async () => {
    const c = new LlmClient(() => null, () => {});
    await expect(c.stream({ model: 'claude-sonnet-5-5', system: [], messages: [], tools: [], maxTokens: 1, signal: new AbortController().signal, purpose: 'chat' })).rejects.toMatchObject({ reason: 'no_key' });
  });
});

describe('models', () => {
  it('cost of 1-hour cache writes uses the 2x price', () => {
    // Sonnet 5.5: 5m write $2.50/M, 1h write $4/M
    expect(costUsd('claude-sonnet-5-5', { cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 } })).toBeCloseTo(4);
    expect(costUsd('claude-sonnet-5-5', { cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 } })).toBeCloseTo(2.5);
    // responses without the split are treated as 5m
    expect(costUsd('claude-sonnet-5-5', { cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(2.5);
  });

  it('cost', () => {
    expect(costUsd('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(2 + 1 + 0.2);
    expect(costUsd('claude-haiku-4-5', { input_tokens: 1000, output_tokens: 0, server_tool_use: { web_search_requests: 2 } })).toBeCloseTo(0.001 + 0.02);
  });
  it('caps', () => {
    expect(capsOf('claude-sonnet-5-5')).toMatchObject({ adaptive: true, midConversationSystem: true, serverFallback: true });
    expect(capsOf('claude-haiku-4-5')).toMatchObject({ adaptive: false, midConversationSystem: false, serverFallback: false });
  });
  it('demoteSystemMessages wraps context', () => {
    expect(demoteSystemMessages([{ role: 'system', content: 'x' }])[0]).toEqual({ role: 'user', content: '<context>\nx\n</context>' });
  });
});
