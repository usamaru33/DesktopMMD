// Runs against a real VOICEVOX engine at 127.0.0.1:50021. Skips (does not fail) when it isn't running.
import { beforeAll, describe, expect, it } from 'vitest';
import { VoicevoxClient, wavDurationSec } from '../../src/main/speech/VoicevoxClient';
import { buildLipTimeline, timelineDuration } from '../../src/renderer/character/lipsync';
import { applyTuning, computeTuning } from '../../src/main/speech/voiceTuning';
import { DEFAULT_CHARACTER } from '../../src/shared/defaults';

const vv = new VoicevoxClient('http://127.0.0.1:50021');
let up = false;

beforeAll(async () => {
  try {
    await vv.version(1500);
    up = true;
  } catch {
    up = false;
  }
});

describe('VOICEVOX engine', () => {
  it('version and speakers', async (ctx) => {
    if (!up) return ctx.skip();
    expect(await vv.version()).toMatch(/\d+\.\d+/);
    const sp = await vv.speakers();
    expect(sp.length).toBeGreaterThan(0);
    expect(sp[0].styles[0]).toHaveProperty('id');
  });

  it('synthesizes, and the lip-sync timeline matches the WAV length (±50ms)', async (ctx) => {
    if (!up) return ctx.skip();
    const speaker = (await vv.speakers())[0].styles[0].id;
    for (const emotion of ['neutral', 'happy', 'sad'] as const) {
      const t = computeTuning({ ...DEFAULT_CHARACTER.voice, speakerId: speaker }, emotion, 1, { speed: 1.1, volume: 1 });
      const q = applyTuning(await vv.audioQuery('こんにちは、今日はいい天気ですね。', speaker), t);
      const wav = await vv.synthesis(q, t.speaker);
      const dur = wavDurationSec(wav);
      expect(dur).toBeGreaterThan(0.5);
      expect(Math.abs(timelineDuration(buildLipTimeline(q)) - dur)).toBeLessThan(0.05);
    }
  }, 60_000);

  it('accent phrases → mora data round trip', async (ctx) => {
    if (!up) return ctx.skip();
    const speaker = (await vv.speakers())[0].styles[0].id;
    const ap = await vv.accentPhrases('おはようございます', speaker);
    expect(ap.length).toBeGreaterThan(0);
    ap[0].moras[0].pitch = 0; // edit
    const re = await vv.moraData(ap, speaker);
    expect(re[0].moras.length).toBe(ap[0].moras.length);
  });

  it('TC-17 building block: user dictionary add → list → delete', async (ctx) => {
    if (!up) return ctx.skip();
    const uuid = await vv.addWord({ surface: 'DesktopMMDテスト語', pronunciation: 'デスクトップエムエムディーテストゴ', accentType: 0, wordType: 'PROPER_NOUN', priority: 5 });
    try {
      const dict = await vv.userDict();
      expect(dict[uuid]?.pronunciation).toBe('デスクトップエムエムディーテストゴ');
    } finally {
      await vv.deleteWord(uuid);
    }
    expect((await vv.userDict())[uuid]).toBeUndefined();
  });
});
