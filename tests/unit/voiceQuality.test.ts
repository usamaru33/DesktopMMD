import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { shapePitch, softLimit } from '../../src/main/speech/pitchShape';
import { computeTuning } from '../../src/main/speech/voiceTuning';
import { findEngineExe } from '../../src/main/speech/VoicevoxLauncher';
import { autoEmotionStyles } from '../../src/shared/emotions';
import { DEFAULT_CHARACTER } from '../../src/shared/defaults';
import { engineKind, engineKindFromUrl } from '../../src/shared/voiceEngine';
import type { VoicevoxAccentPhrase, VoicevoxAudioQuery } from '../../src/shared/types';

const mora = (pitch: number, vowel = 'a') => ({ text: 'ア', vowel, vowel_length: 0.1, consonant: null, consonant_length: null, pitch });
const query = (aps: VoicevoxAccentPhrase[], o: Partial<VoicevoxAudioQuery> = {}): VoicevoxAudioQuery => ({
  accent_phrases: aps,
  speedScale: 1,
  pitchScale: 0,
  intonationScale: 1,
  volumeScale: 1,
  pauseLengthScale: 1,
  prePhonemeLength: 0.1,
  postPhonemeLength: 0.1,
  outputSamplingRate: 24000,
  outputStereo: false,
  ...o,
});
const pitches = (q: VoicevoxAudioQuery) => q.accent_phrases.flatMap((ap) => ap.moras.map((m) => m.pitch));
const ST = Math.LN2 / 12;

describe('shapePitch', () => {
  // 5.6〜6.0 の山がある文（無声モーラ 0 を含む）
  const aps = (): VoicevoxAccentPhrase[] => [
    { moras: [mora(5.6), mora(6.0), mora(0, 'U'), mora(5.8)], accent: 2 },
    { moras: [mora(5.7), mora(5.9)], accent: 1, pause_mora: { ...mora(0, 'pau'), text: '、' } },
  ];

  it('with intonation 1 and pitch 0 nothing changes, and the result asks the engine for no further scaling', () => {
    const q = shapePitch(query(aps()));
    expect(pitches(q)).toEqual([5.6, 6.0, 0, 5.8, 5.7, 5.9]);
    expect(q.pitchScale).toBe(0);
    expect(q.intonationScale).toBe(1);
  });

  it('reproduces VOICEVOX pitchScale / intonationScale inside the natural range', () => {
    const src = query(aps(), { pitchScale: 0.01, intonationScale: 1.2 });
    const p = pitches(src).map((x) => x * 2 ** 0.01);
    const voiced = p.filter((x) => x > 0);
    const mean = voiced.reduce((a, b) => a + b, 0) / voiced.length;
    const expected = p.map((x) => (x > 0 ? (x - mean) * 1.2 + mean : 0));
    const got = pitches(shapePitch(src));
    const hi = Math.max(...voiced);
    for (let i = 0; i < got.length; i++) {
      // 本来の上端から 0.5 半音までは計算どおり
      if (expected[i] <= hi + 0.5 * ST) expect(got[i]).toBeCloseTo(expected[i], 6);
    }
  });

  it('a strong intonation cannot push a note more than 2 semitones above the sentence\'s natural top', () => {
    const src = query(aps(), { intonationScale: 2 });
    const got = pitches(shapePitch(src));
    expect(Math.max(...got)).toBeGreaterThan(6.0);
    expect(Math.max(...got)).toBeLessThan(6.0 + 2 * ST);
    const voicedGot = got.filter((x) => x > 0);
    expect(Math.min(...voicedGot)).toBeGreaterThan(5.6 - 3.5 * ST);
  });

  it('a large whole-sentence pitch shift (emotion) cannot lift the top more than 3 semitones above the base-pitch top', () => {
    const src = query(aps(), { pitchScale: 0.15 });
    const got = pitches(shapePitch(src));
    expect(Math.max(...got)).toBeLessThan(6.0 + 3 * ST);
    expect(Math.max(...got)).toBeGreaterThan(6.0 + 1.5 * ST);
    // 基本の音高で上げた分は基準に含まれるので削られない
    const based = pitches(shapePitch(src, undefined, 0.15));
    expect(Math.max(...based)).toBeCloseTo(6.0 * 2 ** 0.15, 6);
  });

  it('adds the question rise itself (so it is limited too)', () => {
    const q = shapePitch(query([{ moras: [mora(5.6), mora(5.8, 'o')], accent: 1, is_interrogative: true }], { intonationScale: 1.8 }));
    const ms = q.accent_phrases[0].moras;
    expect(ms).toHaveLength(3);
    expect(ms[2]).toMatchObject({ text: 'オ', vowel: 'o', vowel_length: 0.15 });
    expect(ms[2].pitch).toBeLessThan(Math.min(5.8 + 0.3, 6.5) + 2 * ST);
  });

  it('softLimit passes small values, saturates large ones', () => {
    expect(softLimit(0.3, 0.5, 2)).toBe(0.3);
    expect(softLimit(10, 0.5, 2)).toBeLessThan(2);
    expect(softLimit(1, 0.5, 2)).toBeGreaterThan(0.5);
  });
});

describe('emotion styles', () => {
  const speakers = [
    { styles: [{ id: 69, name: 'ノーマル' }, { id: 70, name: '元気' }, { id: 71, name: 'ささやき' }, { id: 72, name: 'ぶりっ子' }] },
    { styles: [{ id: 1, name: 'ノーマル' }, { id: 2, name: '喜び' }, { id: 3, name: 'かなしみ' }, { id: 4, name: '怒り' }] },
  ];

  it('picks the matching styles of the same speaker only, and never whispering', () => {
    expect(autoEmotionStyles(speakers, 72)).toEqual({ happy: 70 });
    expect(autoEmotionStyles(speakers, 1)).toEqual({ happy: 2, sad: 3, angry: 4 });
    expect(autoEmotionStyles(speakers, 2)).toEqual({ sad: 3, angry: 4 }); // the base style itself is not an override
    expect(autoEmotionStyles(speakers, 999)).toEqual({});
  });

  it('a strong emotion uses the style without pitch/intonation boost; explicit settings and OFF win', () => {
    const voice = { ...DEFAULT_CHARACTER.voice, speakerId: 1 };
    const g = { speed: 1, volume: 1 };
    const auto = { happy: 2 };
    const t = computeTuning(voice, 'happy', 1, g, { autoStyles: auto });
    expect(t.speaker).toBe(2);
    expect(t.params.pitchScale).toBe(0);
    expect(t.params.intonationScale).toBe(1);
    expect(t.params.speedScale).toBeCloseTo(1.05, 3);
    expect(computeTuning(voice, 'happy', 0.3, g, { autoStyles: auto }).speaker).toBe(1);
    expect(computeTuning({ ...voice, autoEmotionStyles: false }, 'happy', 1, g, { autoStyles: auto }).speaker).toBe(1);
    const custom = { ...voice, emotions: { happy: { styleId: null, speedMul: 1, pitchAdd: 0.05, intonationMul: 1 } } };
    expect(computeTuning(custom, 'happy', 1, g, { autoStyles: auto })).toMatchObject({ speaker: 1, params: { pitchScale: 0.05 } });
    // AivisSpeech: no emotion pitch shift
    expect(computeTuning(voice, 'happy', 1, g, { engine: 'aivis' }).params.pitchScale).toBe(0);
  });
});

describe('engine kind', () => {
  it('is read from the engine manifest name, or guessed from the port', () => {
    expect(engineKind('AivisSpeech Engine', 'http://127.0.0.1:50021')).toBe('aivis');
    expect(engineKind('VOICEVOX Engine', 'http://127.0.0.1:10101')).toBe('voicevox');
    expect(engineKind('', 'http://127.0.0.1:10101')).toBe('aivis');
    expect(engineKindFromUrl('http://127.0.0.1:50021')).toBe('voicevox');
    expect(engineKindFromUrl('not a url')).toBe('voicevox');
  });

  it('finds the AivisSpeech engine in its install folder, and ignores a VOICEVOX path for it', () => {
    const env = { LOCALAPPDATA: String.raw`C:\Users\u\AppData\Local`, ProgramFiles: String.raw`C:\Program Files` };
    const aivis = path.join(env.LOCALAPPDATA, 'Programs', 'AivisSpeech', 'AivisSpeech-Engine', 'run.exe');
    const vv = path.join(env.LOCALAPPDATA, 'Programs', 'VOICEVOX', 'vv-engine', 'run.exe');
    const exists = (p: string) => p === aivis || p === vv;
    expect(findEngineExe('', env, exists, 'aivis')).toBe(aivis);
    expect(findEngineExe('', env, exists, 'voicevox')).toBe(vv);
    expect(findEngineExe(path.dirname(path.dirname(vv)), env, exists, 'aivis')).toBe(aivis);
    const custom = path.join(String.raw`D:\Apps\AivisSpeech`, 'AivisSpeech-Engine', 'run.exe');
    expect(findEngineExe(String.raw`D:\Apps\AivisSpeech\AivisSpeech.exe`, env, (p) => p === custom, 'aivis')).toBe(custom);
  });
});
