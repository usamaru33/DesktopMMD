import { describe, expect, it } from 'vitest';
import { computeTuning, scaleByIntensity, clampBase } from '../../src/main/speech/voiceTuning';
import { normalizeForTts, phraseKey } from '../../src/main/speech/ttsNormalize';
import { DEFAULT_CHARACTER } from '../../src/shared/defaults';
import type { CharacterVoice } from '../../src/shared/types';

const voice: CharacterVoice = {
  ...DEFAULT_CHARACTER.voice,
  speakerId: 3,
  base: { ...DEFAULT_CHARACTER.voice.base, speedScale: 1.05, intonationScale: 1.1 },
  emotions: {
    happy: { styleId: null, speedMul: 1.05, pitchAdd: 0.03, intonationMul: 1.15 },
    sad: { styleId: 7, speedMul: 0.92, pitchAdd: -0.02, intonationMul: 0.9 },
  },
};

describe('computeTuning (spec 5.6)', () => {
  it('speed = base × emotion × global, pitch = base + add, intonation = base × mul', () => {
    const t = computeTuning(voice, 'happy', 1, { speed: 1.0, volume: 1 });
    expect(t.params.speedScale).toBeCloseTo(1.05 * 1.05, 3);
    expect(t.params.pitchScale).toBeCloseTo(0.03, 3);
    expect(t.params.intonationScale).toBeCloseTo(1.1 * 1.15, 3);
    expect(t.speaker).toBe(3);
  });

  it('uses the emotion style id when present', () => {
    expect(computeTuning(voice, 'sad', 1, { speed: 1, volume: 1 }).speaker).toBe(7);
  });

  it('neutral has no correction; global speed and volume still apply', () => {
    const t = computeTuning(voice, 'neutral', 1, { speed: 1.2, volume: 0.5 });
    expect(t.params.speedScale).toBeCloseTo(1.05 * 1.2, 3);
    expect(t.params.volumeScale).toBeCloseTo(0.5, 3);
    expect(t.params.pitchScale).toBe(0);
  });

  it('falls back to built-in emotion defaults when the preset lacks an entry', () => {
    const t = computeTuning(voice, 'surprised', 1, { speed: 1, volume: 1 });
    expect(t.params.pitchScale).toBeCloseTo(0.04, 3);
  });

  it('scales corrections by intensity', () => {
    const s = scaleByIntensity({ styleId: null, speedMul: 1.2, pitchAdd: 0.1, intonationMul: 0.8 }, 0.5);
    expect(s.speedMul).toBeCloseTo(1.1);
    expect(s.pitchAdd).toBeCloseTo(0.05);
    expect(s.intonationMul).toBeCloseTo(0.9);
  });

  it('clamps to the ranges of spec 6.5', () => {
    const c = clampBase({
      speedScale: 5, pitchScale: -1, intonationScale: -1, volumeScale: 3,
      pauseLengthScale: 9, prePhonemeLength: 2, postPhonemeLength: -1,
    });
    expect(c).toEqual({
      speedScale: 2, pitchScale: -0.15, intonationScale: 0, volumeScale: 2,
      pauseLengthScale: 2, prePhonemeLength: 1.5, postPhonemeLength: 0,
    });
  });
});

describe('normalizeForTts', () => {
  it('replaces URLs and removes emoji / markdown', () => {
    expect(normalizeForTts('詳しくは https://example.com/a?b=1 を見てね😊 **重要**')).toBe('詳しくは リンク を見てね 重要');
  });
  it('applies ascii dictionary words case-insensitively at word boundaries', () => {
    const dict = [{ surface: 'GitHub', pronunciation: 'ギットハブ' }, { surface: 'Git', pronunciation: 'ギット' }];
    expect(normalizeForTts('githubとGitを使う。Gitter', dict)).toBe('ギットハブとギットを使う。Gitter');
  });
  it('returns empty when nothing is pronounceable', () => {
    expect(normalizeForTts('👍✨')).toBe('');
    expect(normalizeForTts('https://a.b')).toBe('リンク');
  });
  it('removes laughter marks', () => {
    expect(normalizeForTts('それは面白い(笑)')).toBe('それは面白い');
  });
  it('phraseKey ignores punctuation and spaces', () => {
    expect(phraseKey('おはよう、ございます！')).toBe(phraseKey('おはようございます'));
  });
});
