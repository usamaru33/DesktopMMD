import { describe, expect, it } from 'vitest';
import { ReplyParser, type ReplyEvent, stripReplyMarkup, dominantEmotion } from '../../src/main/llm/ReplyParser';

function parseAll(text: string, chunkSize = Infinity): ReplyEvent[] {
  const p = new ReplyParser();
  const out: ReplyEvent[] = [];
  if (chunkSize === Infinity) out.push(...p.push(text));
  else for (let i = 0; i < text.length; i += chunkSize) out.push(...p.push(text.slice(i, i + chunkSize)));
  out.push(...p.end());
  return out;
}

const sentences = (evs: ReplyEvent[]) =>
  evs.filter((e) => e.type === 'sentence').map((e) => (e.type === 'sentence' ? [e.text, e.emotion, e.intensity] : null));

const SPEC_EXAMPLE = `[happy:0.8] おはようございます！今日は午前中にゼミがありますね。
[thinking:0.5] 資料の最終版、まだ更新されてないみたいです。
<detail>
未更新のファイル: slides_v3.pptx（最終更新 10/5）
</detail>
`;

describe('ReplyParser', () => {
  it('parses the spec example', () => {
    const evs = parseAll(SPEC_EXAMPLE);
    expect(sentences(evs)).toEqual([
      ['おはようございます！', 'happy', 0.8],
      ['今日は午前中にゼミがありますね。', 'happy', 0.8],
      ['資料の最終版、まだ更新されてないみたいです。', 'thinking', 0.5],
    ]);
    const detail = evs.find((e) => e.type === 'detail');
    expect(detail).toEqual({ type: 'detail', markdown: '未更新のファイル: slides_v3.pptx（最終更新 10/5）' });
  });

  it('gives identical results when fed one character at a time (tags split across chunks)', () => {
    const whole = parseAll(SPEC_EXAMPLE);
    for (const size of [1, 2, 3, 5, 7]) {
      expect(parseAll(SPEC_EXAMPLE, size)).toEqual(whole);
    }
  });

  it('treats a reply without tags as neutral and flags it malformed', () => {
    const p = new ReplyParser();
    const evs = [...p.push('こんにちは。元気です。'), ...p.end()];
    expect(sentences(evs)).toEqual([
      ['こんにちは。', 'neutral', 0.5],
      ['元気です。', 'neutral', 0.5],
    ]);
    expect(p.malformed).toBe(true);
  });

  it('maps unknown emotions to neutral and clamps intensity', () => {
    const p = new ReplyParser();
    const evs = [...p.push('[excited:1.7] やったー！[sad:-1]ううん。'), ...p.end()];
    expect(sentences(evs)).toEqual([
      ['やったー！', 'neutral', 1],
      // "-1" doesn't match the number pattern, so the bracket is plain text
      ['[sad:-1]ううん。', 'neutral', 1],
    ]);
    expect(p.stats.unknownEmotions).toBe(1);
  });

  it('accepts a tag without strength and a tag in the middle of a line', () => {
    const evs = parseAll('ええと[surprised]本当ですか？');
    expect(sentences(evs)).toEqual([
      ['ええと', 'neutral', 0.5],
      ['本当ですか？', 'surprised', 0.6],
    ]);
  });

  it('inherits the previous emotion when a sentence has no tag', () => {
    const evs = parseAll('[shy:0.7]えへへ。ありがとうございます。');
    expect(sentences(evs).map((s) => s?.[1])).toEqual(['shy', 'shy']);
  });

  it('absorbs closing brackets and repeated marks into the sentence, even across chunks', () => {
    const text = '[happy:0.9]「すごい！？」と言われました。';
    for (const size of [Infinity, 1, 2]) {
      expect(sentences(parseAll(text, size))).toEqual([
        ['「すごい！？」', 'happy', 0.9],
        ['と言われました。', 'happy', 0.9],
      ]);
    }
  });

  it('splits only the first sentence at a comma once it is 15+ chars long', () => {
    const evs = parseAll('[neutral:0.5]今日の天気を調べたところによると、東京は晴れ、最高気温は25度です。');
    expect(sentences(evs).map((s) => s?.[0])).toEqual([
      '今日の天気を調べたところによると、',
      '東京は晴れ、最高気温は25度です。',
    ]);
  });

  it('does not split short first sentences at commas', () => {
    const evs = parseAll('はい、わかりました。');
    expect(sentences(evs).map((s) => s?.[0])).toEqual(['はい、わかりました。']);
  });

  it('does not split decimal numbers', () => {
    const evs = parseAll('円周率は3.14です。');
    expect(sentences(evs).map((s) => s?.[0])).toEqual(['円周率は3.14です。']);
  });

  it('treats an unterminated detail block as detail until the end', () => {
    const evs = parseAll('[happy:0.5]これです。<detail>\n```ts\nconst a = 1;\n```');
    expect(sentences(evs).map((s) => s?.[0])).toEqual(['これです。']);
    expect(evs.at(-1)).toEqual({ type: 'detail', markdown: '```ts\nconst a = 1;\n```' });
  });

  it('keeps detail markdown intact even with brackets and punctuation inside', () => {
    const md = '| a | b |\n| --- | --- |\n| [x] | 1。2！ |';
    const evs = parseAll(`[thinking:0.4]表にしました。<detail>${md}</detail>以上です。`, 3);
    expect(evs.find((e) => e.type === 'detail')).toEqual({ type: 'detail', markdown: md });
    expect(sentences(evs).map((s) => s?.[0])).toEqual(['表にしました。', '以上です。']);
  });

  it('drops symbol-only fragments and treats long bracket runs as text', () => {
    const evs = parseAll('…。[これはタグではなくて長い括弧書きの文章です]ね。');
    expect(sentences(evs).map((s) => s?.[0])).toEqual(['[これはタグではなくて長い括弧書きの文章です]ね。']);
  });

  it('flushes the final sentence without a terminator', () => {
    expect(sentences(parseAll('[happy:0.5]またね'))).toEqual([['またね', 'happy', 0.5]]);
  });

  it('assigns increasing ids', () => {
    const evs = parseAll('一。二。三。');
    expect(evs.map((e) => (e.type === 'sentence' ? e.id : -1))).toEqual([0, 1, 2]);
  });
});

describe('helpers', () => {
  it('stripReplyMarkup removes tags and details', () => {
    expect(stripReplyMarkup(SPEC_EXAMPLE)).toBe(
      'おはようございます！今日は午前中にゼミがありますね。\n資料の最終版、まだ更新されてないみたいです。',
    );
  });

  it('dominantEmotion picks the strongest non-neutral', () => {
    expect(dominantEmotion(parseAll('[happy:0.4]a。[sad:0.9]b。[neutral:1]c。'))).toBe('sad');
    expect(dominantEmotion(parseAll('ただの文。'))).toBe('neutral');
  });
});
