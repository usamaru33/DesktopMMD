// Applying character tuning + emotion corrections to a VOICEVOX AudioQuery (spec 5.6 "調声の反映").
import { AUTO_STYLE_MIN_INTENSITY, DEFAULT_EMOTION_VOICE, type Emotion, type EmotionVoice, NEUTRAL_EMOTION_VOICE } from '@shared/emotions';
import type { EngineKind } from '@shared/voiceEngine';
import { VOICE_RANGES } from '@shared/defaults';
import type { CharacterVoice, VoiceBase, VoicevoxAudioQuery } from '@shared/types';

export interface GlobalVoice {
  speed: number; // settings.voice.speed
  volume: number; // settings.voice.volume
}

export function emotionVoiceFor(voice: CharacterVoice, emotion: Emotion, useDefaults = true): EmotionVoice {
  return voice.emotions[emotion] ?? (useDefaults ? DEFAULT_EMOTION_VOICE[emotion] : undefined) ?? NEUTRAL_EMOTION_VOICE;
}

/** Scale an emotion correction by intensity: mul' = 1 + (mul-1)*i, add' = add*i. */
export function scaleByIntensity(ev: EmotionVoice, intensity: number): EmotionVoice {
  const i = Math.min(1, Math.max(0, intensity));
  return {
    styleId: ev.styleId,
    speedMul: 1 + (ev.speedMul - 1) * i,
    pitchAdd: ev.pitchAdd * i,
    intonationMul: 1 + (ev.intonationMul - 1) * i,
  };
}

export function clampBase(b: VoiceBase): VoiceBase {
  const out = { ...b };
  for (const k of Object.keys(VOICE_RANGES) as (keyof VoiceBase)[]) {
    const r = VOICE_RANGES[k];
    const v = Number.isFinite(out[k]) ? out[k] : 0;
    out[k] = Math.round(Math.min(r.max, Math.max(r.min, v)) * 1000) / 1000;
  }
  return out;
}

export interface TunedParams {
  speaker: number;
  params: VoiceBase;
}

export interface TuningContext {
  /** 感情ごとに自動で選んだスタイル（autoEmotionStyles）。感情別の設定が無い感情にだけ使う */
  autoStyles?: Partial<Record<Emotion, number>>;
  /** AivisSpeech は音高を変えると音質が落ちるので、感情の音高補正をかけない */
  engine?: EngineKind;
}

export function computeTuning(
  voice: CharacterVoice,
  emotion: Emotion,
  intensity: number,
  global: GlobalVoice,
  ctx: TuningContext = {},
): TunedParams {
  let entry = emotionVoiceFor(voice, emotion);
  const auto = !voice.emotions[emotion] && voice.autoEmotionStyles !== false ? ctx.autoStyles?.[emotion] : undefined;
  if (auto != null && intensity >= AUTO_STYLE_MIN_INTENSITY) {
    // 感情はスタイルが出すので、音高・抑揚は上げない（上げると高い音が崩れやすい）
    entry = { ...entry, styleId: auto, pitchAdd: 0, intonationMul: 1 };
  }
  const ev = scaleByIntensity(entry, intensity);
  const b = voice.base;
  const params = clampBase({
    speedScale: b.speedScale * ev.speedMul * global.speed,
    pitchScale: b.pitchScale + (ctx.engine === 'aivis' ? 0 : ev.pitchAdd),
    intonationScale: b.intonationScale * ev.intonationMul,
    volumeScale: b.volumeScale * global.volume,
    pauseLengthScale: b.pauseLengthScale,
    prePhonemeLength: b.prePhonemeLength,
    postPhonemeLength: b.postPhonemeLength,
  });
  // styleId from the emotion entry wins even when intensity is low
  const speaker = entry.styleId ?? voice.speakerId;
  return { speaker, params };
}

export function applyTuning(q: VoicevoxAudioQuery, t: TunedParams): VoicevoxAudioQuery {
  return { ...q, ...t.params };
}
