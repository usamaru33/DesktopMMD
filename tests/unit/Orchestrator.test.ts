import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator, type OrchestratorDeps } from '../../src/main/orchestrator/Orchestrator';
import { Db } from '../../src/main/store/Db';
import { Store } from '../../src/main/store/repos';
import { ToolRegistry } from '../../src/main/tools/ToolRegistry';
import { PermissionGate } from '../../src/main/tools/PermissionGate';
import { ApprovalBroker } from '../../src/main/tools/ApprovalBroker';
import { PathGuard } from '../../src/main/tools/pathGuard';
import { createFileTools } from '../../src/main/tools/builtin/fileTools';
import { DEFAULT_CHARACTER, DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { BetaMessage, LlmAdapter, Msg, StreamParams } from '../../src/main/llm/LlmClient';
import { LlmUnavailableError } from '../../src/main/llm/LlmClient';
import type { ApprovalAnswer, Settings } from '../../src/shared/types';

type Step = { text: string; tool?: { name: string; input: unknown }; stop?: string; fail?: LlmUnavailableError; hang?: boolean };

function scripted(steps: Step[]): LlmAdapter & { calls: StreamParams[] } {
  const calls: StreamParams[] = [];
  let i = 0;
  return {
    kind: 'fake',
    calls,
    async stream(p) {
      calls.push({ ...p, messages: structuredClone(p.messages) });
      const s = steps[Math.min(i++, steps.length - 1)];
      if (s.fail) throw s.fail;
      for (const ch of s.text.match(/.{1,4}/gsu) ?? []) {
        if (p.signal.aborted) throw new Error('aborted');
        p.onText?.(ch);
        await new Promise((r) => setTimeout(r, 1));
      }
      if (s.hang) {
        await new Promise((_r, rej) => {
          if (p.signal.aborted) return rej(new Error('aborted'));
          p.signal.addEventListener('abort', () => rej(new Error('aborted')));
        });
      }
      const content: unknown[] = [{ type: 'text', text: s.text }];
      if (s.tool) content.push({ type: 'tool_use', id: `tu${i}`, name: s.tool.name, input: s.tool.input });
      return {
        content, stop_reason: s.stop ?? (s.tool ? 'tool_use' : 'end_turn'),
        usage: { input_tokens: 10, output_tokens: 5 },
      } as unknown as BetaMessage;
    },
    async json() { return {} as never; },
    async text() { return 'summary'; },
  };
}

function setup(llm: LlmAdapter, approval: ApprovalAnswer | 'timeout' = 'approve', extra: Partial<OrchestratorDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-orc-'));
  const db = new Db(':memory:');
  db.migrate();
  const store = new Store(db);
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  settings.tools.allowedDirs = [dir];
  const guard = new PathGuard({ allowedDirs: [dir], denyDirs: [] });
  const reg = new ToolRegistry();
  for (const t of createFileTools({ trashItem: async () => {} })) reg.register(t);
  const shown: string[] = [];
  const broker = new ApprovalBroker({ show: (r) => shown.push(r.id), resolved: () => {}, onPendingChange: () => {} });
  const gate = new PermissionGate({
    guard,
    levelOverride: () => undefined,
    requestApproval: async () => approval,
    recordRun: (r) => store.toolRuns.insert(r),
    finishRun: (id, res) => store.toolRuns.finish(id, res, res.undo ?? null),
    now: () => new Date(),
    backupDir: path.join(dir, '.backups'),
  });
  const sentences: { text: string; emotion: string }[] = [];
  const states: string[] = [];
  const tts = { enqueue: vi.fn(), cancel: vi.fn(), whenDrained: async () => {}, played: () => {} };
  const deps: OrchestratorDeps = {
    llm: () => llm,
    chatModel: () => 'claude-sonnet-5-5',
    proactiveModel: () => 'claude-haiku-4-5',
    cacheTtl: () => '1h',
    utilityModel: () => 'claude-haiku-4-5',
    effort: () => 'low',
    store,
    settings: () => settings,
    character: () => DEFAULT_CHARACTER,
    tools: reg,
    gate,
    broker,
    tts,
    ui: {
      state: (s) => states.push(s),
      sentence: (p) => sentences.push({ text: p.text, emotion: p.emotion }),
      detail: () => {},
      userEcho: () => {},
      toast: () => {},
      openInput: () => {},
    },
    memory: {
      search: async () => [],
      profile: () => [],
      markUsed: () => {},
      onTurnFinished: () => {},
      recordEmotion: () => {},
      stage: () => 0,
    },
    activeApp: () => null,
    webSearchEnabled: () => true,
    now: () => new Date(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    ...extra,
  };
  const orc = new Orchestrator(deps);
  const done = () =>
    new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (!orc.busy) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });
  return { orc, store, sentences, states, tts, dir, done, settings };
}

/** Every request must keep the API's ordering rules. */
function assertValidHistory(msgs: Msg[]) {
  expect(msgs[0].role).toBe('user');
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'system') {
      expect(['user'].includes(msgs[i - 1].role)).toBe(true);
      if (i < msgs.length - 1) expect(msgs[i + 1].role).toBe('assistant');
    }
    if (m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use')) {
      const next = msgs[i + 1];
      expect(next?.role).toBe('user');
      expect(Array.isArray(next.content) && next.content.every((b) => b.type === 'tool_result')).toBe(true);
    }
  }
}

describe('Orchestrator', () => {
  it('TC-01 flow: streams sentences with emotions, saves both messages, appends context as a system message', async () => {
    const llm = scripted([{ text: '[happy:0.8]こんにちは！今日もがんばりましょう。' }]);
    const { orc, store, sentences, tts, done } = setup(llm);
    orc.submit({ kind: 'user', source: 'text', text: 'こんにちは' });
    await done();
    expect(sentences).toEqual([
      { text: 'こんにちは！', emotion: 'happy' },
      { text: '今日もがんばりましょう。', emotion: 'happy' },
    ]);
    expect(tts.enqueue).toHaveBeenCalledTimes(2);
    const req = llm.calls[0];
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'system']);
    expect(JSON.stringify(req.messages[1].content)).toContain('<context>');
    expect(req.system.length).toBe(5);
    expect(req.tools.some((t) => 'name' in t && t.name === 'web_search')).toBe(true);
    const sess = store.conv.latestSession()!;
    expect(store.conv.messages(sess.id).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('keeps system and tools byte-identical across turns of a session, history append-only', async () => {
    const llm = scripted([{ text: '[happy:0.5]はい。' }, { text: '[neutral:0.5]そうですね。' }]);
    const { orc, done } = setup(llm);
    orc.submit({ kind: 'user', source: 'text', text: '一つ目' });
    await done();
    orc.submit({ kind: 'user', source: 'text', text: '二つ目' });
    await done();
    const [a, b] = llm.calls;
    expect(JSON.stringify(b.system)).toBe(JSON.stringify(a.system));
    expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools));
    // first request's messages (minus cache markers) are a prefix of the second's
    const strip = (m: Msg[]) => JSON.stringify(m).replace(/,"cache_control":\{"type":"ephemeral"\}/g, '');
    const prefix = strip(a.messages).slice(0, -1);
    expect(strip(b.messages).startsWith(prefix)).toBe(true);
    assertValidHistory(b.messages);
  });

  it('runs an approved tool and continues the reply', async () => {
    const llm = scripted([
      { text: '[neutral:0.5]作りますね。', tool: { name: 'write_file', input: { path: 'PLACEHOLDER', content: 'hi', mode: 'create' } } },
      { text: '[happy:0.7]できました。' },
    ]);
    const s = setup(llm);
    // patch the placeholder to the sandbox dir
    const target = path.join(s.dir, 'memo.txt');
    (llm as unknown as { calls: unknown[] }).calls.length = 0;
    const steps = llm as unknown as { stream: LlmAdapter['stream'] };
    const orig = steps.stream.bind(llm);
    steps.stream = async (p) => {
      const m = await orig(p);
      for (const b of m.content as { type: string; input?: { path?: string } }[]) if (b.type === 'tool_use' && b.input) b.input.path = target;
      return m;
    };
    s.orc.submit({ kind: 'user', source: 'text', text: 'メモを作って' });
    await s.done();
    expect(fs.readFileSync(target, 'utf8')).toBe('hi');
    expect(s.sentences.map((x) => x.text)).toEqual(['作りますね。', 'できました。']);
    const second = llm.calls[1];
    const last = second.messages[second.messages.length - 1];
    expect(Array.isArray(last.content) && last.content[0].type).toBe('tool_result');
    assertValidHistory(second.messages);
    expect(s.store.toolRuns.list(5)[0]).toMatchObject({ tool: 'write_file', decision: 'approved' });
    expect(llm.calls.map((c) => c.purpose)).toEqual(['chat', 'tool_followup']);
  });

  it('denied tools come back as error results and the model continues', async () => {
    const llm = scripted([
      { text: '[neutral:0.5]消しますね。', tool: { name: 'delete_file', input: { paths: ['C:\\Windows\\win.ini'] } } },
      { text: '[troubled:0.5]その場所は触れませんでした。' },
    ]);
    const s = setup(llm, 'deny');
    s.orc.submit({ kind: 'user', source: 'text', text: '消して' });
    await s.done();
    const tr = llm.calls[1].messages.at(-1)!;
    expect(JSON.stringify(tr.content)).toContain('is_error');
    expect(s.store.toolRuns.list(5)[0].decision).toBe('blocked');
  });

  it('barge-in aborts generation and leaves a valid history for the next turn', async () => {
    const llm = scripted([{ text: '[happy:0.5]長いお話をします。それは', hang: true }, { text: '[neutral:0.5]はい、どうぞ。' }]);
    const s = setup(llm);
    s.orc.submit({ kind: 'user', source: 'voice', text: '話して' });
    await new Promise((r) => setTimeout(r, 300));
    s.orc.bargeIn();
    await s.done();
    expect(s.tts.cancel).toHaveBeenCalled();
    s.orc.setListening(false);
    s.orc.submit({ kind: 'user', source: 'voice', text: 'ちょっと待って' });
    await s.done();
    const msgs = llm.calls[1].messages;
    assertValidHistory(msgs);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'system', 'assistant', 'user', 'system']);
    expect(JSON.stringify(msgs[2].content)).toContain('長いお話をします。');
  });

  it('no API key: answers with a troubled fixed sentence instead of crashing', async () => {
    const llm = scripted([{ text: '', fail: new LlmUnavailableError('no key', 'no_key') }]);
    const s = setup(llm);
    s.orc.submit({ kind: 'user', source: 'text', text: 'やあ' });
    await s.done();
    expect(s.sentences[0].emotion).toBe('troubled');
    expect(s.sentences.map((x) => x.text).join('')).toContain('APIキー');
  });

  it('proactive turns are dropped while busy', async () => {
    const llm = scripted([{ text: '[neutral:0.5]うん。' }]);
    const s = setup(llm);
    s.orc.submit({ kind: 'user', source: 'text', text: 'a' });
    expect(s.orc.submit({ kind: 'proactive', trigger: 'break', detail: 'x' })).toBe(false);
    await s.done();
    expect(s.orc.submit({ kind: 'proactive', trigger: 'break', detail: 'x' })).toBe(true);
    await s.done();
    const req = llm.calls[1];
    expect(JSON.stringify(req.messages)).toContain('<proactive trigger=\\"break\\">');
    // proactive lines use the cheaper model, no cache writes, and are booked separately
    expect(req.model).toBe('claude-haiku-4-5');
    expect(req.purpose).toBe('proactive');
    expect(req.cache).toBe(false);
    expect(llm.calls[0]).toMatchObject({ model: 'claude-sonnet-5-5', purpose: 'chat', cacheTtl: '1h' });
  });

  it('muted: sentences shown, nothing synthesized', async () => {
    const llm = scripted([{ text: '[happy:0.5]静かにね。' }]);
    const s = setup(llm);
    s.settings.voice.muted = true;
    s.orc.submit({ kind: 'user', source: 'text', text: 'a' });
    await s.done();
    expect(s.sentences).toHaveLength(1);
    expect(s.tts.enqueue).not.toHaveBeenCalled();
  });

  it('skill.md: persona comes from the skill, and mode switches are appended once without touching the system prompt', async () => {
    const { parseSkill } = await import('../../src/main/character/skillFile');
    const skillSrc = (await import('node:fs')).readFileSync(path.join(__dirname, '../../characters/sample/skill.md'), 'utf8');
    const sk = parseSkill(skillSrc).skill;
    let mode: string | null = null;
    const llm = scripted([{ text: '[neutral:0.5]はい。' }]);
    const s = setup(llm, 'approve', { skill: () => sk, mode: () => mode });
    const turn = async (t: string) => {
      s.orc.submit({ kind: 'user', source: 'text', text: t });
      await s.done();
    };
    await turn('一');
    mode = '集中';
    await turn('二');
    await turn('三');
    mode = null;
    await turn('四');
    const ctxOf = (i: number) => JSON.stringify(llm.calls[i].messages.at(-1)!.content);
    expect(llm.calls[0].system[0].text).toContain('灯野ほたる');
    expect(ctxOf(0)).not.toContain('モード');
    expect(ctxOf(1)).toContain('「集中」に切り替わった');
    expect(ctxOf(2)).not.toContain('モード');
    expect(ctxOf(3)).toContain('解除');
    // system prompt stays byte-identical through the switches (preserved thinking / cache)
    for (const c of llm.calls) expect(JSON.stringify(c.system)).toBe(JSON.stringify(llm.calls[0].system));
  });
});
