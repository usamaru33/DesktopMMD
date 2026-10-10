import { describe, expect, it } from 'vitest';
import {
  buildSessionSystem, buildTurnContext, formatElapsed, formatNow, OUTPUT_RULES, proactiveUserMessage, workRules,
} from '../../src/main/llm/PromptBuilder';
import { DEFAULT_CHARACTER } from '../../src/shared/defaults';

describe('PromptBuilder', () => {
  const sys = buildSessionSystem({
    character: { ...DEFAULT_CHARACTER, name: 'ライス', firstPerson: 'ライス' },
    callName: 'お兄さま',
    affinityStage: 2,
    profile: [{ kind: 'profile', content: '名前は山田' }],
    allowedDirs: ['C:\\Users\\me\\Documents'],
    apps: ['メモ帳'],
    webSearch: true,
  });

  it('has five system blocks with cache breakpoints after the cross-session part and at the end', () => {
    expect(sys).toHaveLength(5);
    expect(sys.map((b) => !!b.cache_control)).toEqual([false, false, true, false, true]);
  });

  it('carries persona, rules, relationship and profile', () => {
    const all = sys.map((b) => b.text).join('\n');
    expect(all).toContain('「ライス」');
    expect(all).toContain('一人称は「ライス」');
    expect(all).toContain('「お兄さま」と呼ぶ');
    expect(all).toContain(OUTPUT_RULES);
    expect(all).toContain('C:\\Users\\me\\Documents');
    expect(all).toContain('今の関係は「親しい」');
    expect(all).toContain('- 名前は山田');
    expect(all).toContain('<external_data>');
  });

  it('is byte-identical for identical inputs (prompt cache)', () => {
    const again = buildSessionSystem({
      character: { ...DEFAULT_CHARACTER, name: 'ライス', firstPerson: 'ライス' }, callName: 'お兄さま', affinityStage: 2,
      profile: [{ kind: 'profile', content: '名前は山田' }], allowedDirs: ['C:\\Users\\me\\Documents'], apps: ['メモ帳'], webSearch: true,
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(sys));
  });

  it('web search rule only when enabled; no apps → なし', () => {
    expect(workRules({ allowedDirs: [], apps: [], webSearch: false })).not.toContain('web_search');
    expect(workRules({ allowedDirs: [], apps: [], webSearch: false })).toContain('許可フォルダ: なし');
  });

  it('turn context has time, elapsed, voice note, memories, dropped files and the last tool result', () => {
    const now = new Date('2026-10-07T23:05:00+09:00');
    const ctx = buildTurnContext({
      now,
      source: 'voice',
      lastConversationAt: new Date(now.getTime() - 3 * 3600_000),
      activeApp: 'Code',
      memories: [{ kind: 'schedule', content: '面接', dueAt: '2026-10-20T01:00:00.000Z' }, { kind: 'preference', content: 'コーヒーが苦手', dueAt: null }],
      lastToolSummary: 'ファイルを読む: 成功',
      droppedFiles: ['C:\\a.pdf'],
    });
    expect(ctx.startsWith('<context>')).toBe(true);
    expect(ctx).toContain('現在: 2026年10月7日(水) 23:05');
    expect(ctx).toContain('前回の会話から: 3時間');
    expect(ctx).toContain('聞き間違い');
    expect(ctx).toContain('Code');
    expect(ctx).toContain('- 面接（期日 2026年10月20日(火) 10:00）');
    expect(ctx).toContain('- コーヒーが苦手');
    expect(ctx).toContain('C:\\a.pdf');
    expect(ctx).toContain('直前の作業結果');
  });

  it('formats', () => {
    expect(formatElapsed(20_000)).toBe('たった今');
    expect(formatElapsed(5 * 60_000)).toBe('5分');
    expect(formatElapsed(72 * 3600_000)).toBe('3日');
    expect(formatNow(new Date('2026-01-02T03:04:00'))).toBe('2026年1月2日(金) 03:04');
  });

  it('proactive messages are marked as coming from the app', () => {
    const m = proactiveUserMessage('break', 'Codeで95分続けて作業している');
    expect(m).toMatch(/^<proactive trigger="break">/);
    expect(m).toContain('休憩');
    expect(proactiveUserMessage('unknown', 'x')).toContain('x');
  });
});
