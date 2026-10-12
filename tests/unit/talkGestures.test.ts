// 話す内容に合わせた身ぶり (renderer/character/character/talkGestures.ts).
import { describe, expect, it } from 'vitest';
import {
  blendArm, chooseTalkGesture, HOLD, slerpDir, TALK_GESTURES, talkPose, type ArmTarget, type ChooseOptions,
} from '../../src/renderer/character/character/talkGestures';

const always: ChooseOptions = { beatChance: 1, matchChance: 1, rng: () => 0.5 };
const pick = (text: string, emotion: Parameters<typeof chooseTalkGesture>[1] = 'neutral', o: Partial<ChooseOptions> = {}) =>
  chooseTalkGesture(text, emotion, { ...always, ...o });

describe('chooseTalkGesture', () => {
  it.each([
    ['明日の東京の天気予報はこんな感じです。', 'present'],
    ['今日の予定はこちらです。', 'present'],
    ['こんにちは！今日も一緒にがんばりましょうね。', 'wave'],
    ['おはようございます。', 'wave'],
    ['ありがとうございます。', 'bow'],
    ['ごめんなさい、うまくいきませんでした。', 'bow'],
    ['今日もがんばろうね！', 'guts'],
    ['やった、うまくいきましたね！', 'clap'],
    ['なるほど、そういうことですか。', 'clap'],
    ['うーん、それはちょっと難しいかもしれません。', 'think'],
    ['ごめん、それはわからないなあ。', 'bow'], // apology first
    ['それはわかりません。', 'shrug'],
    ['まず、ファイルを開きます。', 'count'],
    ['ねえ、ちょっと聞いてもいい？', 'lean_in'],
    ['わたしが調べておきますね。', 'self'],
    ['まかせてください。', 'self'],
  ] as const)('%s → %s', (text, kind) => {
    expect(pick(text)).toBe(kind);
  });

  it('uses the character’s own first person for "self"', () => {
    expect(pick('あたしがやっておくね。', 'neutral', { firstPerson: 'あたし' })).toBe('self');
    expect(pick('あたしがやっておくね。', 'neutral', { beatChance: 0 })).toBeNull();
  });

  it('falls back to the emotion, then to a beat on long sentences, else nothing', () => {
    expect(pick('そうなんですね。', 'thinking')).toBe('think');
    expect(pick('ファイルの中身を確認して、必要なところを直しておきます。')).toBe('beat');
    expect(pick('ファイルの中身を確認して、必要なところを直しておきます。', 'neutral', { beatChance: 0 })).toBeNull();
    expect(pick('はい。')).toBeNull();
    expect(pick('   ')).toBeNull();
  });

  it('skips matched gestures by chance for calm characters', () => {
    expect(pick('ありがとうございます。', 'neutral', { matchChance: 0.5, rng: () => 0.7 })).toBeNull();
    expect(pick('ありがとうございます。', 'neutral', { matchChance: 0.5, rng: () => 0.2 })).toBe('bow');
  });

  it('does not repeat an explanatory gesture back to back', () => {
    expect(pick('結果はこちらです。', 'neutral', { last: 'present' })).toBe('beat');
    expect(pick('ありがとう！', 'neutral', { last: 'bow' })).toBe('bow');
  });
});

describe('talkPose', () => {
  const finite = (a: ArmTarget | null) => !a || [...a.upper, ...a.fore, ...a.palm, a.curl].every(Number.isFinite);

  it.each(TALK_GESTURES)('%s is finite, uses at least one arm, and keeps the body motion modest', (kind) => {
    for (let t = 0; t <= HOLD[kind]; t += 0.05) {
      const p = talkPose(kind, t, 1, 1.35);
      expect(finite(p.right) && finite(p.left)).toBe(true);
      expect(p.right || p.left).toBeTruthy();
      for (const v of [...p.body.upper, ...p.body.neck, ...p.body.head]) expect(Math.abs(v)).toBeLessThan((20 * Math.PI) / 180);
      expect(Math.abs(p.body.rootY)).toBeLessThan(0.25);
    }
  });

  it('one-handed gestures lead with the right hand, or the left when mirrored', () => {
    expect(talkPose('present', 1, 1).left).toBeNull();
    expect(talkPose('present', 1, -1).right).toBeNull();
    expect(talkPose('present', 1, 1).body.upper[1]).toBeCloseTo(-talkPose('present', 1, -1).body.upper[1], 10);
  });
});

describe('blending', () => {
  it('slerpDir keeps unit length and hits both ends', () => {
    const a: [number, number, number] = [0, -1, 0];
    const b: [number, number, number] = [0, 0.6, 0.8];
    expect(slerpDir(a, b, 0)).toEqual([0, -1, 0].map((x) => expect.closeTo(x, 9)));
    expect(slerpDir(a, b, 1).map((x) => +x.toFixed(9))).toEqual(b);
    for (const k of [0.25, 0.5, 0.75]) expect(Math.hypot(...slerpDir(a, b, k))).toBeCloseTo(1, 9);
    // opposite vectors don't produce NaN
    expect(slerpDir([1, 0, 0], [-1, 0, 0], 0.5).every(Number.isFinite)).toBe(true);
  });

  it('blendArm goes the short way: the hand never rises above both ends on the way', () => {
    const relaxed: ArmTarget = { upper: [-0.1, -0.99, 0.05], fore: [-0.05, -0.98, 0.2], palm: [0.9, 0, 0.3], curl: 0.2 };
    const wave = talkPose('wave', 0.5).right!;
    let maxY = -Infinity;
    for (let k = 0; k <= 1; k += 0.05) maxY = Math.max(maxY, blendArm(relaxed, wave, k).upper[1]);
    expect(maxY).toBeLessThanOrEqual(Math.max(relaxed.upper[1], wave.upper[1]) + 1e-9);
  });
});
