import { describe, expect, it } from 'vitest';
import { analyzeVoice, decodeWav, resample, semitones } from '../../src/main/speech/voiceAnalysis';
import { autoTune, fitStyle, guessPitchScale, screenText, type FitParams, type FitSynth } from '../../src/main/speech/voiceFit';

/**
 * 疑似 VOICEVOX: スタイルごとに地声の高さ・抑揚・声色（倍音の減り方）を持ち、
 * 本物と同じく 音高 = ln F0 × 2^pitchScale、抑揚 = 平均からのずれ × intonationScale、長さ ÷ speedScale で合成する。
 */
interface FakeStyle { f0: number; std: number; tilt: number; mora: number }
const SR = 24_000;
function render(st: FakeStyle, text: string, p: FitParams): Float32Array {
  const morae = [...text].filter((c) => !/[。、！？\s]/.test(c)).length;
  const speech = (morae * st.mora) / p.speedScale;
  const lead = 0.15;
  const n = Math.round((speech + 2 * lead) * SR);
  const out = new Float32Array(n);
  const mean = Math.log(st.f0) * 2 ** p.pitchScale;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR - lead;
    if (t < 0 || t > speech) continue;
    // 声の高さの動き（アクセントの上下）
    const dev = st.std * Math.SQRT2 * Math.sin((2 * Math.PI * t * p.speedScale) / 0.7) * p.intonationScale;
    const f0 = Math.exp(mean + dev);
    phase += (2 * Math.PI * f0) / SR;
    let s = 0;
    for (let h = 1; h * f0 < 7000; h++) s += Math.sin(h * phase) / h ** st.tilt;
    out[i] = 0.2 * s;
  }
  return out;
}

const STYLES: Record<number, FakeStyle> = {
  1: { f0: 300, std: 0.08, tilt: 1.0, mora: 0.12 }, // 高め・明るい
  2: { f0: 140, std: 0.07, tilt: 1.8, mora: 0.13 }, // 低め・こもった
  3: { f0: 230, std: 0.1, tilt: 1.4, mora: 0.11 },
  4: { f0: 260, std: 0.09, tilt: 0.7, mora: 0.12 },
};
let calls = 0;
const fakeSynth: FitSynth = async (id, text, p) => {
  calls++;
  return { samples: render(STYLES[id], text, p), sr: SR };
};
const TEXT = 'きょうはいいてんきですね。さんぽにいきましょう。';

describe('voiceAnalysis', () => {
  it('measures F0 of a harmonic tone and the speaking time', () => {
    const f = analyzeVoice(render({ f0: 220, std: 0, tilt: 1, mora: 0.1 }, 'あいうえおかきくけこ', { speedScale: 1, pitchScale: 0, intonationScale: 1 }), SR);
    expect(Math.abs(semitones(f.f0Hz, 220))).toBeLessThan(0.3);
    expect(f.activeSec).toBeGreaterThan(0.9);
    expect(f.activeSec).toBeLessThan(1.1);
    expect(f.logF0Std).toBeLessThan(0.01);
  });

  it('decodes 16-bit WAV and resamples', () => {
    const pcm = new Int16Array([0, 16384, -16384, 32767]);
    const buf = new ArrayBuffer(44 + pcm.byteLength);
    const v = new DataView(buf);
    const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 24000, true); v.setUint32(28, 48000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, pcm.byteLength, true);
    new Int16Array(buf, 44).set(pcm);
    const w = decodeWav(buf);
    expect(w.sr).toBe(24000);
    expect([...w.samples]).toEqual([0, 0.5, -0.5, 32767 / 32768]);
    expect(resample(new Float32Array(24000), 24000, 16000)).toHaveLength(16000);
  });
});

describe('voiceFit', () => {
  it('guessPitchScale follows ln F0 × 2^ps', () => {
    const ps = guessPitchScale(200, 250);
    expect(Math.exp(Math.log(200) * 2 ** ps)).toBeCloseTo(250, 3);
  });

  it('screenText cuts at a sentence end and falls back for short text', () => {
    expect(screenText('あ')).toContain('こんにちは');
    expect(screenText('きょうはいい天気ですね。散歩に行きましょう。そのあとでお昼ごはんを食べに行って、本屋さんにも寄りましょう。')).toBe('きょうはいい天気ですね。');
  });

  it('fits speed, pitch and intonation to a sample of the same voice', async () => {
    const truth = { speedScale: 1.2, pitchScale: 0.02, intonationScale: 1.4 };
    const target = analyzeVoice(render(STYLES[3], TEXT, truth), SR);
    const r = await fitStyle(fakeSynth, 3, TEXT, target, true);
    expect(r.params.speedScale).toBeCloseTo(truth.speedScale, 1);
    expect(Math.abs(semitones(r.result.f0Hz, target.f0Hz))).toBeLessThan(0.4);
    expect(r.params.intonationScale).toBeGreaterThan(1.2);
    expect(r.params.intonationScale).toBeLessThan(1.6);
  });

  it('autoTune ranks the matching style first and reports progress', async () => {
    const target = analyzeVoice(render(STYLES[2], TEXT, { speedScale: 0.9, pitchScale: -0.01, intonationScale: 1.1 }), SR);
    const seen: string[] = [];
    calls = 0;
    const r = await autoTune({
      synth: fakeSynth,
      styles: [1, 2, 3, 4].map((id) => ({ id, label: `style${id}` })),
      target,
      text: TEXT,
      topN: 2,
      onProgress: (p) => seen.push(p.phase),
    });
    expect(r[0].styleId).toBe(2);
    expect(r[0].score).toBeGreaterThan(r[1].score);
    expect(r[0].params.speedScale).toBeCloseTo(0.9, 1);
    expect(calls).toBe(4 + 2 * 3);
    expect(seen).toContain('screen');
    expect(seen).toContain('fit');
  });

  it('without a transcript it keeps the speed and still matches pitch', async () => {
    const target = analyzeVoice(render(STYLES[1], TEXT, { speedScale: 1.3, pitchScale: 0.03, intonationScale: 1 }), SR);
    const r = await fitStyle(fakeSynth, 1, 'べつのぶんしょうでためします。', target, false);
    expect(r.params.speedScale).toBe(1);
    expect(Math.abs(semitones(r.result.f0Hz, target.f0Hz))).toBeLessThan(0.4);
  });

  it('stops when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const target = analyzeVoice(render(STYLES[1], TEXT, { speedScale: 1, pitchScale: 0, intonationScale: 1 }), SR);
    await expect(autoTune({ synth: fakeSynth, styles: [{ id: 1, label: 'a' }], target, text: TEXT, signal: ac.signal })).rejects.toThrow('中止');
  });

  it('rejects a sample without voice', async () => {
    const target = analyzeVoice(new Float32Array(SR), SR);
    await expect(autoTune({ synth: fakeSynth, styles: [{ id: 1, label: 'a' }], target, text: '' })).rejects.toThrow('声の高さ');
  });
});
