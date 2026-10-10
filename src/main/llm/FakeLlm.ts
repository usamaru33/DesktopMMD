// Offline stand-in for Claude (MMD_FAKE_LLM=1 or no API key in dev): streams canned emotion-tagged
// replies so the UI, expressions, lip sync and approval cards can be exercised without spending money.
import type { BetaMessage, JsonParams, LlmAdapter, Msg, StreamParams } from './LlmClient';

const CANNED = [
  '[happy:0.8] こんにちは！今日も一緒にがんばりましょうね。[thinking:0.4] 何から始めましょうか？',
  '[surprised:0.7] えっ、本当ですか？[happy:0.6] それはよかったです！',
  '[troubled:0.6] うーん、それはちょっと難しいかもしれません。[neutral:0.5] 別の方法を考えてみますね。',
  '[shy:0.7] そんなに褒められると照れちゃいます……。[happy:0.5] ありがとうございます。',
  '[sad:0.6] そうでしたか、それは残念でしたね。[happy:0.4] でも、次はきっと大丈夫ですよ。',
  '[thinking:0.6] 少し考えてみますね。[neutral:0.5] 表にまとめておきました。<detail>\n| 項目 | 内容 |\n| --- | --- |\n| 例 | 疑似LLMの詳細パネル |\n</detail>',
];

function lastUserText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const t = m.content.find((b) => b.type === 'text');
    if (t && t.type === 'text') return t.text;
    return '';
  }
  return '';
}

function lastToolResult(messages: Msg[]): { isError: boolean } | null {
  const m = messages[messages.length - 1];
  if (!m || m.role !== 'user' || !Array.isArray(m.content)) return null;
  const r = m.content.find((b) => b.type === 'tool_result');
  return r && r.type === 'tool_result' ? { isError: !!r.is_error } : null;
}

export class FakeLlm implements LlmAdapter {
  readonly kind = 'fake' as const;
  private n = 0;

  constructor(
    private readonly sandboxDir: () => string,
    private readonly delayMs = 35,
  ) {}

  async stream(p: StreamParams): Promise<BetaMessage> {
    // the fake ignores mid-conversation system messages (context)
    const userText = lastUserText(p.messages.filter((m) => m.role !== 'system'));
    let text: string;
    let toolUse: { name: string; input: Record<string, unknown> } | null = null;

    const tr = lastToolResult(p.messages);
    if (tr) {
      text = tr.isError
        ? '[troubled:0.5] わかりました、今回はやめておきますね。別の方法がよければ言ってください。'
        : '[happy:0.7] できました！ほかにも何かあれば言ってくださいね。';
    } else if (/ファイル|メモ|保存/.test(userText)) {
      text = '[neutral:0.5] メモを作ってみますね。';
      toolUse = {
        name: 'write_file',
        input: { path: `${this.sandboxDir()}\\desktopmmd-test.txt`, content: `疑似LLMのテスト: ${userText}\n`, mode: 'append' },
      };
    } else if (/消して|削除/.test(userText)) {
      text = '[troubled:0.5] 削除するには確認が必要です。';
      toolUse = { name: 'delete_file', input: { paths: [`${this.sandboxDir()}\\desktopmmd-test.txt`] } };
    } else {
      text = CANNED[this.n++ % CANNED.length];
    }

    for (const chunk of text.match(/.{1,3}/gsu) ?? []) {
      if (p.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      await new Promise((r) => setTimeout(r, this.delayMs));
      p.onText?.(chunk);
    }

    const content: BetaMessage['content'] = [{ type: 'text', text, citations: null }] as BetaMessage['content'];
    if (toolUse) {
      content.push({ type: 'tool_use', id: `toolu_fake_${Date.now()}`, name: toolUse.name, input: toolUse.input } as BetaMessage['content'][number]);
    }
    return {
      id: `msg_fake_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: p.model,
      content,
      stop_reason: toolUse ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } as unknown as BetaMessage;
  }

  async json<T>(p: JsonParams): Promise<T> {
    if (p.purpose === 'extract') return { memories: [], affinity_delta: 1, mood: 0.1 } as T;
    if (p.purpose === 'conflict') return { contradicts: false } as T;
    return {} as T;
  }

  async text(): Promise<string> {
    return '（疑似LLMの要約）';
  }
}
