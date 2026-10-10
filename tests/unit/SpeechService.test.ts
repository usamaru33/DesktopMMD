import { describe, expect, it, vi } from 'vitest';
import { SpeechService, type SpeechDeps } from '../../src/main/speech/SpeechService';
import { VoicevoxError } from '../../src/main/speech/VoicevoxClient';
import { DEFAULT_CHARACTER, DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { SpeechAudioPayload } from '../../src/shared/ipc';
import type { VoicevoxAudioQuery, VoicevoxSpeaker } from '../../src/shared/types';

function wav(sec = 0.5): ArrayBuffer {
  const rate = 24000;
  const n = Math.round(rate * sec);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  return buf;
}

const q: VoicevoxAudioQuery = {
  accent_phrases: [], speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1, pauseLengthScale: 1,
  prePhonemeLength: 0.1, postPhonemeLength: 0.1, outputSamplingRate: 24000, outputStereo: false,
};

function setup(opts: { down?: boolean; engine?: string; speakers?: VoicevoxSpeaker[] } = {}) {
  const sent: SpeechAudioPayload[] = [];
  const queries: { text: string; speaker: number }[] = [];
  const synthQueries: VoicevoxAudioQuery[] = [];
  let down = !!opts.down;
  const vv = {
    baseUrl: '',
    version: vi.fn(async () => { if (down) throw new VoicevoxError('down'); return '0.23.0'; }),
    engineName: vi.fn(async () => (down ? '' : (opts.engine ?? 'VOICEVOX Engine'))),
    speakers: vi.fn(async () => opts.speakers ?? []),
    initializeSpeaker: vi.fn(async () => {}),
    audioQuery: vi.fn(async (text: string, speaker: number) => {
      if (down) throw new VoicevoxError('down');
      queries.push({ text, speaker });
      return structuredClone(q);
    }),
    synthesis: vi.fn(async (query: VoicevoxAudioQuery, _speaker?: number, ..._rest: unknown[]) => {
      if (down) throw new VoicevoxError('down');
      synthQueries.push(query);
      return wav();
    }),
  };
  const fallback = { synthesize: vi.fn(async () => wav(0.3)) };
  const speaking: boolean[] = [];
  const deps: SpeechDeps = {
    vv: vv as never,
    fallback: fallback as never,
    character: () => ({ ...DEFAULT_CHARACTER, voice: { ...DEFAULT_CHARACTER.voice, speakerId: 3, phrases: [{ text: 'おはようございます', styleId: 8, accentPhrases: [{ moras: [{ text: 'オ', vowel: 'o', vowel_length: 0.1, pitch: 5 }], accent: 1 }] }] } }),
    settings: () => DEFAULT_SETTINGS,
    dict: () => [{ surface: 'GitHub', pronunciation: 'ギットハブ' }],
    send: (p) => sent.push(p),
    stop: vi.fn(),
    onSpeaking: (on) => speaking.push(on),
    onEngineStatus: vi.fn(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
  const svc = new SpeechService(deps);
  return { svc, sent, queries, synthQueries, vv, fallback, speaking, deps, setDown: (d: boolean) => (down = d) };
}

const job = (i: number, text = `文${i}です。`) => ({ turnId: 1, sentenceId: i, text, emotion: 'happy' as const, intensity: 1 });
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('SpeechService', () => {
  it('synthesizes at most 2 sentences ahead of playback', async () => {
    const s = setup();
    for (let i = 1; i <= 5; i++) s.svc.enqueue(job(i));
    await tick();
    expect(s.sent.map((p) => p.sentenceId)).toEqual([1, 2]);
    s.svc.played(1, 'start');
    await tick();
    expect(s.sent.map((p) => p.sentenceId)).toEqual([1, 2, 3]);
    s.svc.played(1, 'end');
    s.svc.played(2, 'start');
    await tick();
    expect(s.sent.map((p) => p.sentenceId)).toEqual([1, 2, 3, 4]);
  });

  it('applies tuning (emotion correction + global speed) and normalizes text with the dictionary', async () => {
    const s = setup();
    s.svc.enqueue(job(1, 'GitHubを見てね😊'));
    await tick();
    expect(s.queries[0]).toEqual({ text: 'ギットハブを見てね', speaker: 3 });
    expect(s.synthQueries[0].speedScale).toBeCloseTo(1.0 * 1.05 * 1.05, 3); // happy speedMul × settings.voice.speed
    // 音高（happy +0.03）と抑揚はアプリ側でモーラの高さにかけてから送る（shapePitch）
    expect(s.synthQueries[0].pitchScale).toBe(0);
    expect(s.synthQueries[0].intonationScale).toBe(1);
    expect(s.vv.synthesis).toHaveBeenCalledWith(expect.anything(), 3, expect.anything(), undefined, false);
    expect(s.sent[0].query).not.toBeNull();
  });

  it('switches to a matching style for a strong emotion instead of raising the pitch', async () => {
    const speakers = [{ name: 'A', speaker_uuid: 'a', styles: [{ id: 3, name: 'ノーマル' }, { id: 5, name: '喜び' }, { id: 6, name: '悲しみ' }] }] as VoicevoxSpeaker[];
    const s = setup({ speakers });
    s.svc.enqueue(job(1, 'やったね'));
    s.svc.enqueue({ ...job(2, 'まあまあ'), intensity: 0.3 });
    await tick();
    s.svc.played(1, 'start');
    await tick();
    expect(s.vv.synthesis.mock.calls[0][1]).toBe(5);
    expect(s.vv.synthesis.mock.calls[1][1]).toBe(3); // weak emotion keeps the base style
  });

  it('AivisSpeech: no mora timing (volume lip sync), no fixed phrases, no emotion pitch shift', async () => {
    const s = setup({ engine: 'AivisSpeech Engine' });
    s.svc.enqueue(job(1, 'おはようございます！'));
    await tick();
    expect(s.queries).toHaveLength(1);
    expect(s.synthQueries[0].pitchScale).toBe(0);
    expect(s.synthQueries[0].intonationScale).toBeCloseTo(1.15, 3); // emotion strength
    expect(s.sent[0].query).toBeNull();
  });

  it('uses a saved fixed phrase without calling audio_query', async () => {
    const s = setup();
    s.svc.enqueue(job(1, 'おはようございます！'));
    await tick();
    expect(s.queries).toHaveLength(0);
    expect(s.vv.synthesis).toHaveBeenCalledWith(expect.anything(), 8, expect.anything(), undefined, false);
  });

  it('whenDrained resolves after every sentence of the turn ended; speaking flag follows playback', async () => {
    const s = setup();
    s.svc.enqueue(job(1));
    s.svc.enqueue(job(2));
    await tick();
    let drained = false;
    void s.svc.whenDrained(1).then(() => (drained = true));
    s.svc.played(1, 'start');
    s.svc.played(1, 'end');
    s.svc.played(2, 'start');
    await tick();
    expect(drained).toBe(false);
    s.svc.played(2, 'end');
    await tick();
    expect(drained).toBe(true);
    expect(s.speaking).toEqual([true, false]);
  });

  it('cancel drops pending synthesis and tells the renderer to stop', async () => {
    const s = setup();
    for (let i = 1; i <= 4; i++) s.svc.enqueue(job(i));
    await tick();
    s.svc.cancel();
    expect(s.deps.stop).toHaveBeenCalled();
    await expect(s.svc.whenDrained(1)).resolves.toBeUndefined();
    s.svc.played(1, 'start');
    await tick();
    expect(s.sent).toHaveLength(2);
  });

  it('TC-12: VOICEVOX down → Windows voice, without mora info (volume lip sync)', async () => {
    const s = setup({ down: true });
    s.svc.enqueue(job(1));
    await tick();
    expect(s.fallback.synthesize).toHaveBeenCalled();
    expect(s.sent[0].query).toBeNull();
    expect(s.deps.onEngineStatus).toHaveBeenCalledWith('fallback');
    s.svc.dispose();
  });

  it('empty text after normalization is skipped without blocking the queue', async () => {
    const s = setup();
    s.svc.enqueue(job(1, '👍'));
    s.svc.enqueue(job(2, '次の文。'));
    await tick();
    expect(s.sent.map((p) => p.sentenceId)).toEqual([2]);
  });
});
