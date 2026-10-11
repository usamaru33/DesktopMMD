// Local LLM (Ollama) adapter against a fake fetch: request shape, ndjson streaming, error mapping,
// provider routing and the hardware recommendation. No Ollama needed.
import { describe, expect, it, vi } from 'vitest';
import { LlmUnavailableError, type JsonParams, type LlmAdapter, type Msg, type StreamParams, type SystemBlock } from '../../src/main/llm/LlmClient';
import { listOllamaModels, LOCAL_NUM_CTX, needsThinking, OllamaClient, RoutingLlm, toOllamaMessages, toOllamaTools } from '../../src/main/llm/LocalLlm';
import { recommendLocal } from '../../src/main/llm/localProbe';

const sys = (t: string): SystemBlock => ({ type: 'text', text: t });

function ndjson(lines: object[], split = 7): Response {
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const enc = new TextEncoder();
  const parts = body.match(new RegExp(`[\\s\\S]{1,${split}}`, 'g')) ?? [];
  return new Response(
    new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    }),
    { status: 200 },
  );
}

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(handler: (n: number, sent: Sent) => Response | Promise<Response>, sent: Sent[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const s = { url: String(url), body: JSON.parse(String(init?.body ?? '{}')) };
    sent.push(s);
    return handler(sent.length - 1, s);
  }) as typeof fetch;
}

const params = (over: Partial<StreamParams> = {}): StreamParams => ({
  model: 'qwen3:8b',
  system: [sys('persona'), sys('rules')],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'こんにちは' }] }],
  tools: [],
  maxTokens: 1024,
  signal: new AbortController().signal,
  purpose: 'chat',
  ...over,
});

describe('toOllamaMessages', () => {
  it('joins system blocks, demotes mid-conversation system to the user turn, drops non-text blocks', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'やあ' }] },
      { role: 'system', content: [{ type: 'text', text: '現在: 10時' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: 's' }, { type: 'text', text: '[happy:0.5]こんにちは' }] },
      { role: 'user', content: 'またね' },
    ] as unknown as Msg[];
    expect(toOllamaMessages([sys('A'), sys('B')], messages)).toEqual([
      { role: 'system', content: 'A\n\nB' },
      { role: 'user', content: 'やあ\n\n<context>\n現在: 10時\n</context>' },
      { role: 'assistant', content: '[happy:0.5]こんにちは' },
      { role: 'user', content: 'またね' },
    ]);
  });
});

describe('OllamaClient.stream', () => {
  it('streams text across split chunks, reports usage, and sends no tools / thinking off / bounded context', async () => {
    const sent: Sent[] = [];
    const c = new OllamaClient({
      url: () => 'http://127.0.0.1:11434/',
      fetch: fakeFetch(
        () => ndjson([{ message: { content: '[happy:0.8]こん' } }, { message: { content: 'にちは！' } }, { done: true, prompt_eval_count: 321, eval_count: 12 }]),
        sent,
      ),
    });
    const got: string[] = [];
    const msg = await c.stream(params({ onText: (d) => got.push(d) }));
    expect(got.join('')).toBe('[happy:0.8]こんにちは！');
    expect(msg.content).toMatchObject([{ type: 'text', text: '[happy:0.8]こんにちは！' }]);
    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.usage).toMatchObject({ input_tokens: 321, output_tokens: 12 });
    expect(sent[0].url).toBe('http://127.0.0.1:11434/api/chat');
    expect(sent[0].body).toMatchObject({ model: 'qwen3:8b', stream: true, think: false, options: { num_ctx: LOCAL_NUM_CTX, num_predict: 1024 } });
    expect(sent[0].body.tools).toBeUndefined();
  });

  it('reports max_tokens when the reply was cut by length', async () => {
    const c = new OllamaClient({ url: () => 'http://x', fetch: fakeFetch(() => ndjson([{ message: { content: 'あ' } }, { done: true, done_reason: 'length' }])) });
    expect((await c.stream(params())).stop_reason).toBe('max_tokens');
  });

  it('maps connection failures and a missing model to local_down, server errors to server', async () => {
    const down = new OllamaClient({ url: () => 'http://x', fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await expect(down.stream(params())).rejects.toMatchObject({ reason: 'local_down' });
    const missing = new OllamaClient({ url: () => 'http://x', fetch: fakeFetch(() => new Response('{"error":"model not found"}', { status: 404 })) });
    await expect(missing.stream(params())).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(missing.stream(params())).rejects.toMatchObject({ reason: 'local_down' });
    const boom = new OllamaClient({ url: () => 'http://x', fetch: fakeFetch(() => new Response('oops', { status: 500 })) });
    await expect(boom.stream(params())).rejects.toMatchObject({ reason: 'server' });
  });

  it('rethrows the original error when the user aborted', async () => {
    const ac = new AbortController();
    const c = new OllamaClient({
      url: () => 'http://x',
      fetch: (async () => {
        ac.abort();
        throw new DOMException('aborted', 'AbortError');
      }) as typeof fetch,
    });
    await expect(c.stream(params({ signal: ac.signal }))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('retries once without `think` when the model rejects it, and remembers that', async () => {
    const sent: Sent[] = [];
    const c = new OllamaClient({
      url: () => 'http://x',
      fetch: fakeFetch((_n, s) => ('think' in s.body ? new Response('"gemma3" does not support thinking', { status: 400 }) : ndjson([{ message: { content: 'ok' } }, { done: true }])), sent),
    });
    await c.stream(params({ model: 'gemma3' }));
    expect(sent.map((s) => 'think' in s.body)).toEqual([true, false]);
    await c.stream(params({ model: 'gemma3' }));
    expect('think' in sent[2].body).toBe(false);
  });
});

describe('OllamaClient.json / text / warmUp', () => {
  it('passes the schema as `format` and parses the JSON', async () => {
    const sent: Sent[] = [];
    const c = new OllamaClient({ url: () => 'http://x', fetch: fakeFetch(() => new Response(JSON.stringify({ message: { content: '{"contradicts":true}' } })), sent) });
    const schema = { type: 'object', properties: { contradicts: { type: 'boolean' } } };
    expect(await c.json({ model: 'qwen3:8b', system: 's', user: 'u', schema, maxTokens: 100, purpose: 'conflict' })).toEqual({ contradicts: true });
    expect(sent[0].body).toMatchObject({ stream: false, format: schema, think: false });
  });

  it('turns broken JSON into a bad_request error', async () => {
    const c = new OllamaClient({ url: () => 'http://x', fetch: fakeFetch(() => new Response(JSON.stringify({ message: { content: 'not json' } }))) });
    await expect(c.json({ model: 'm', system: 's', user: 'u', schema: {}, maxTokens: 10, purpose: 'extract' })).rejects.toMatchObject({ reason: 'bad_request' });
  });

  it('text returns the trimmed content; warmUp loads the model with the same context size', async () => {
    const sent: Sent[] = [];
    const c = new OllamaClient({ url: () => 'http://x', fetch: fakeFetch(() => new Response(JSON.stringify({ message: { content: ' 要約 ' } })), sent) });
    expect(await c.text({ model: 'm', system: 's', user: 'u', maxTokens: 10, purpose: 'summary' })).toBe('要約');
    expect(await c.warmUp('m')).toBe(true);
    expect(sent[1].url).toBe('http://x/api/generate');
    expect(sent[1].body).toMatchObject({ model: 'm', options: { num_ctx: LOCAL_NUM_CTX } });
    expect(await new OllamaClient({ url: () => 'http://x', fetch: (async () => { throw new Error('x'); }) as typeof fetch }).warmUp('m')).toBe(false);
  });
});

describe('listOllamaModels', () => {
  it('lists installed models and the version, or the error', async () => {
    const f = (async (url: string | URL | Request) =>
      String(url).endsWith('/api/tags') ? new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'qwen3:14b' }] })) : new Response(JSON.stringify({ version: '0.40.2' }))) as typeof fetch;
    expect(await listOllamaModels('http://x/', f)).toEqual({ ok: true, version: '0.40.2', models: ['qwen3:8b', 'qwen3:14b'] });
    const bad = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    expect(await listOllamaModels('http://x', bad)).toEqual({ ok: false, error: 'ECONNREFUSED' });
  });
});

function stub(kind: LlmAdapter['kind']) {
  return {
    kind,
    stream: vi.fn(async (p: StreamParams) => ({ content: [], model: p.model }) as never),
    json: vi.fn(async (_p: JsonParams) => ({}) as never),
    text: vi.fn(async (_p: { model: string }) => ''),
  };
}

describe('RoutingLlm', () => {
  const setup = (provider: 'claude' | 'local', hasKey: boolean) => {
    const claude = stub('claude');
    const local = stub('local');
    const r = new RoutingLlm(claude, local, { provider: () => provider, localModel: () => 'qwen3:8b', hasKey: () => hasKey });
    return { claude, local, r };
  };
  const jp = { model: 'claude-haiku-4-5', system: 's', user: 'u', schema: {}, maxTokens: 10, purpose: 'extract' };

  it('claude mode sends everything to Claude', async () => {
    const { claude, local, r } = setup('claude', true);
    await r.stream(params({ model: 'claude-sonnet-5-5' }));
    await r.json(jp);
    expect(claude.stream).toHaveBeenCalledOnce();
    expect(claude.json).toHaveBeenCalledOnce();
    expect(local.stream).not.toHaveBeenCalled();
    expect(r.kind).toBe('claude');
  });

  it('local mode: conversation goes local with the local model with the session tools as given; background jobs stay on Claude while a key exists', async () => {
    const { claude, local, r } = setup('local', true);
    const tools = [{ name: 'x', description: '', input_schema: { type: 'object' } }] as never;
    await r.stream(params({ model: 'claude-sonnet-5-5', tools }));
    expect(local.stream.mock.calls[0][0]).toMatchObject({ model: 'qwen3:8b', tools });
    await r.json(jp);
    expect(claude.json).toHaveBeenCalledOnce();
    expect(local.json).not.toHaveBeenCalled();
    expect(r.kind).toBe('local');
  });

  it('local mode without an API key runs background jobs locally too', async () => {
    const { claude, local, r } = setup('local', false);
    await r.json(jp);
    await r.text({ model: 'claude-haiku-4-5', system: 's', user: 'u', maxTokens: 10, purpose: 'summary' });
    expect(local.json.mock.calls[0][0]).toMatchObject({ model: 'qwen3:8b' });
    expect(local.text.mock.calls[0][0]).toMatchObject({ model: 'qwen3:8b' });
    expect(claude.json).not.toHaveBeenCalled();
  });
});

describe('recommendLocal', () => {
  it.each([
    [12, 'good', 'qwen3:8b'],
    [10, 'good', 'qwen3:8b'],
    [8, 'ok', 'qwen3:8b'],
    [6, 'light', 'qwen3:4b'],
    [4, 'api', null],
    [null, 'api', null],
  ] as const)('VRAM %s GB → %s', (vramGb, level, model) => {
    expect(recommendLocal({ vramGb, ramGb: 32 })).toMatchObject({ level, model });
  });
});

describe('local tools: history conversion, tool_calls, thinking', () => {
  const toolDef = { name: 'set_timer', description: 'タイマー', input_schema: { type: 'object', properties: { minutes: { type: 'number' } } } };

  it('turns tool_use / tool_result blocks into tool_calls / tool messages and drops server tools', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '3分タイマー' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'はい' }, { type: 'tool_use', id: 'tu1', name: 'set_timer', input: { minutes: 3 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '設定した' }, { type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: [{ type: 'text', text: 'だめ' }] }] },
    ] as unknown as Msg[];
    const out = toOllamaMessages('S', messages);
    expect(out.slice(1)).toEqual([
      { role: 'user', content: '3分タイマー' },
      { role: 'assistant', content: 'はい', tool_calls: [{ function: { name: 'set_timer', arguments: { minutes: 3 } } }] },
      { role: 'tool', tool_name: 'set_timer', content: '設定した' },
      { role: 'tool', tool_name: 'set_timer', content: 'エラー: だめ' },
    ]);
    const tools = toOllamaTools([toolDef, { type: 'web_search_20260209', name: 'web_search', max_uses: 3 }] as never);
    expect(tools).toEqual([{ type: 'function', function: { name: 'set_timer', description: 'タイマー', parameters: toolDef.input_schema } }]);
  });

  it('sends tools and thinking, and returns tool_calls as tool_use blocks with stop_reason tool_use', async () => {
    const sent: Sent[] = [];
    const c = new OllamaClient({
      url: () => 'http://x',
      fetch: fakeFetch(() => ndjson([{ message: { content: 'はい。' } }, { message: { tool_calls: [{ function: { name: 'set_timer', arguments: { minutes: 3 } } }] } }, { done: true, prompt_eval_count: 5, eval_count: 6 }]), sent),
    });
    const msg = await c.stream(params({ tools: [toolDef] as never, think: true }));
    expect(sent[0].body).toMatchObject({ think: true, tools: [{ type: 'function', function: { name: 'set_timer' } }] });
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content).toMatchObject([{ type: 'text', text: 'はい。' }, { type: 'tool_use', name: 'set_timer', input: { minutes: 3 } }]);
    expect((msg.content[1] as { id: string }).id).toMatch(/^toolu_local_/);
  });

  it('a reply that is only a tool call has no empty text block', async () => {
    const c = new OllamaClient({ url: () => 'http://x', fetch: fakeFetch(() => ndjson([{ message: { tool_calls: [{ function: { name: 'set_timer', arguments: {} } }] } }, { done: true }])) });
    const msg = await c.stream(params({ tools: [toolDef] as never }));
    expect(msg.content.map((b) => b.type)).toEqual(['tool_use']);
  });
});

describe('needsThinking', () => {
  it.each([
    ['3分のタイマーをセットして', true],
    ['ドキュメントフォルダに今日のメモってファイルを作って', true],
    ['私はコーヒーが苦手って覚えておいて', true],
    ['さっき覚えたコーヒーの話は忘れて', true],
    ['それは違うよ、研究テーマは画像認識', true],
    ['今の画面に何が映ってるか教えて', true],
    ['https://example.com を開いて', true],
    ['こんにちは、元気？', false],
    ['1+1は？', false],
    ['今日はちょっと疲れちゃった', false],
    ['Pythonでリストを逆順にする方法を教えて', false],
    ['ありがとう、助かった！', false],
  ])('%s → %s', (text, want) => {
    expect(needsThinking(text)).toBe(want);
  });

  it('RoutingLlm thinks only for work-like requests with tools on offer, and not when answering a tool result', async () => {
    const claude = stub('claude');
    const local = stub('local');
    const r = new RoutingLlm(claude, local, { provider: () => 'local', localModel: () => 'qwen3:8b', hasKey: () => false });
    const tools = [toolDef2] as never;
    const user = (t: string) => [{ role: 'user', content: [{ type: 'text', text: t }] }, { role: 'system', content: [{ type: 'text', text: 'ctx' }] }] as unknown as Msg[];
    await r.stream(params({ tools, messages: user('3分のタイマーをセットして') }));
    await r.stream(params({ tools, messages: user('こんにちは') }));
    await r.stream(params({ tools: [], messages: user('3分のタイマーをセットして') }));
    const afterTool = [...user('タイマー'), { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'x', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] }] as unknown as Msg[];
    await r.stream(params({ tools, messages: afterTool }));
    expect(local.stream.mock.calls.map((c) => c[0].think)).toEqual([true, false, false, false]);
  });
});

const toolDef2 = { name: 'x', description: '', input_schema: { type: 'object' } };

describe('RoutingLlm: proactive lines on the local model (Claude mode)', () => {
  const build = (proactiveLocal: boolean, localFails = false) => {
    const claude = stub('claude');
    const local = stub('local');
    if (localFails) local.stream.mockRejectedValue(new LlmUnavailableError('down', 'local_down'));
    const r = new RoutingLlm(claude, local, { provider: () => 'claude', localModel: () => 'qwen3:8b', hasKey: () => true, proactiveLocal: () => proactiveLocal });
    return { claude, local, r };
  };
  const tools = [{ name: 'x', description: '', input_schema: { type: 'object' } }] as never;

  it('goes local without tools only for purpose=proactive, and only when enabled', async () => {
    const on = build(true);
    await on.r.stream(params({ purpose: 'proactive', model: 'claude-haiku-4-5', tools }));
    await on.r.stream(params({ purpose: 'chat', model: 'claude-sonnet-5-5', tools }));
    expect(on.local.stream).toHaveBeenCalledOnce();
    expect(on.local.stream.mock.calls[0][0]).toMatchObject({ model: 'qwen3:8b', tools: [], think: false });
    expect(on.claude.stream).toHaveBeenCalledOnce();
    const off = build(false);
    await off.r.stream(params({ purpose: 'proactive' }));
    expect(off.local.stream).not.toHaveBeenCalled();
    expect(off.claude.stream).toHaveBeenCalledOnce();
  });

  it('falls back to Claude when Ollama is down, but not on other errors or aborts', async () => {
    const down = build(true, true);
    await down.r.stream(params({ purpose: 'proactive' }));
    expect(down.claude.stream).toHaveBeenCalledOnce();
    const bad = build(true);
    bad.local.stream.mockRejectedValue(new LlmUnavailableError('x', 'bad_request'));
    await expect(bad.r.stream(params({ purpose: 'proactive' }))).rejects.toMatchObject({ reason: 'bad_request' });
    expect(bad.claude.stream).not.toHaveBeenCalled();
  });
});
