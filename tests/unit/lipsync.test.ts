import { describe, expect, it } from 'vitest';
import { buildLipTimeline, sampleMouth, timelineDuration, MAX_OPEN, VolumeLip } from '../../src/renderer/character/lipsync';
import type { VoicevoxAudioQuery } from '../../src/shared/types';

// 「こんにちは、ね」 roughly as VOICEVOX returns it
function query(speed = 1): VoicevoxAudioQuery {
  return {
    accent_phrases: [
      {
        accent: 5,
        moras: [
          { text: 'コ', consonant: 'k', consonant_length: 0.05, vowel: 'o', vowel_length: 0.1, pitch: 5.5 },
          { text: 'ン', consonant: null, consonant_length: null, vowel: 'N', vowel_length: 0.08, pitch: 5.6 },
          { text: 'ニ', consonant: 'n', consonant_length: 0.04, vowel: 'i', vowel_length: 0.09, pitch: 5.7 },
          { text: 'チ', consonant: 'ch', consonant_length: 0.06, vowel: 'I', vowel_length: 0.07, pitch: 0 },
          { text: 'ワ', consonant: 'w', consonant_length: 0.05, vowel: 'a', vowel_length: 0.12, pitch: 5.6 },
        ],
        pause_mora: { text: '、', consonant: null, consonant_length: null, vowel: 'pau', vowel_length: 0.3, pitch: 0 },
      },
      {
        accent: 1,
        moras: [{ text: 'ネ', consonant: 'n', consonant_length: 0.04, vowel: 'e', vowel_length: 0.15, pitch: 5.4 }],
      },
    ],
    speedScale: speed,
    pitchScale: 0,
    intonationScale: 1,
    volumeScale: 1,
    pauseLengthScale: 1,
    prePhonemeLength: 0.1,
    postPhonemeLength: 0.1,
    outputSamplingRate: 24000,
    outputStereo: false,
  };
}

const SUM = 0.1 + 0.05 + 0.1 + 0.08 + 0.04 + 0.09 + 0.06 + 0.07 + 0.05 + 0.12 + 0.3 + 0.04 + 0.15 + 0.1;

describe('buildLipTimeline', () => {
  it('total duration equals the sum of all phoneme lengths', () => {
    expect(timelineDuration(buildLipTimeline(query()))).toBeCloseTo(SUM, 6);
  });

  it('stretches with speedScale', () => {
    expect(timelineDuration(buildLipTimeline(query(2)))).toBeCloseTo(SUM / 2, 6);
  });

  it('closes the mouth on ん, pauses and silence', () => {
    const keys = buildLipTimeline(query());
    const at = (t: number) => keys.find((k) => k.t0 <= t && t < k.t1)!;
    expect(at(0.05).vowel).toBeNull(); // pre-phoneme silence
    expect(at(0.1 + 0.05 + 0.1 + 0.04).vowel).toBeNull(); // ン
    expect(at(0.85).vowel).toBeNull(); // pause mora
  });

  it('opens vowels at MAX_OPEN and unvoiced vowels weaker', () => {
    const keys = buildLipTimeline(query());
    const o = keys.find((k) => k.vowel === 'o')!;
    expect(o.weight).toBeCloseTo(MAX_OPEN);
    const iUnvoiced = keys.filter((k) => k.vowel === 'i');
    expect(Math.min(...iUnvoiced.map((k) => k.weight))).toBeLessThan(MAX_OPEN * 0.5);
  });

  it('respects explicit pauseLength', () => {
    const q = { ...query(), pauseLength: 0.1 };
    expect(timelineDuration(buildLipTimeline(q))).toBeCloseTo(SUM - 0.3 + 0.1, 6);
  });
});

describe('sampleMouth', () => {
  const keys = buildLipTimeline(query());
  it('is closed before and after', () => {
    expect(sampleMouth(keys, -1)).toEqual({ a: 0, i: 0, u: 0, e: 0, o: 0 });
    expect(sampleMouth(keys, 99).a).toBe(0);
  });
  it('fully opens mid-vowel and crossfades at boundaries', () => {
    const oStart = 0.1 + 0.05;
    expect(sampleMouth(keys, oStart + 0.08).o).toBeCloseTo(MAX_OPEN);
    const mid = sampleMouth(keys, oStart + 0.1 + 0.03); // 30ms into ン: o fading out
    expect(mid.o).toBeGreaterThan(0);
    expect(mid.o).toBeLessThan(MAX_OPEN);
  });
  it('never exceeds MAX_OPEN', () => {
    for (let t = 0; t < SUM; t += 0.005) {
      const w = sampleMouth(keys, t);
      for (const v of Object.values(w)) expect(v).toBeLessThanOrEqual(MAX_OPEN + 1e-9);
    }
  });
});

describe('VolumeLip', () => {
  it('rises with loud input and falls with silence', () => {
    const v = new VolumeLip();
    let x = 0;
    for (let i = 0; i < 20; i++) x = v.update(0.3, 1 / 60);
    expect(x).toBeGreaterThan(0.5);
    for (let i = 0; i < 60; i++) x = v.update(0, 1 / 60);
    expect(x).toBeLessThan(0.05);
  });
});
