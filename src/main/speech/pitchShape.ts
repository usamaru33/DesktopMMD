// 音高（pitchScale）と抑揚（intonationScale）をエンジンに任せず、アプリ側でモーラの高さにかける。
// 同じ計算をしたうえで、抑揚を強めたときにその文の本来の音域（抑揚1.0のとき）から大きくはみ出す音だけを
// 緩やかに抑える（高い音でかすれる・裏返る、低い音でガラガラになるのを防ぐ）。
// 計算は VOICEVOX ENGINE の _apply_interrogative_upspeak → _apply_pitch_scale → _apply_intonation_scale と同じ。
import type { VoicevoxAudioQuery, VoicevoxMora } from '@shared/types';

/** 本来の音域の上端・下端からどこまで出してよいか（半音）。knee までは素通し、そこから max に向けて頭打ちにする */
export const PITCH_LIMITS = { upKnee: 0.5, upMax: 2, downKnee: 1.5, downMax: 3.5 };

// VOICEVOX ENGINE の疑問文の語尾上げ（UPSPEAK_*）
const UPSPEAK_LENGTH = 0.15;
const UPSPEAK_PITCH_ADD = 0.3;
const UPSPEAK_PITCH_MAX = 6.5;
const VOWEL_KANA: Record<string, string> = { a: 'ア', i: 'イ', u: 'ウ', e: 'エ', o: 'オ', N: 'ン' };

const ST = Math.LN2 / 12; // 1半音 = ln F0 でこれだけ

/** x ≤ knee はそのまま、それより先は max を超えないように丸める */
export function softLimit(x: number, knee: number, max: number): number {
  if (x <= knee) return x;
  if (max <= knee) return knee;
  return knee + (max - knee) * Math.tanh((x - knee) / (max - knee));
}

/**
 * 語尾上げ・音高・抑揚をモーラの高さに焼き込み、はみ出した音を抑えたクエリを返す。
 * 返すクエリは pitchScale=0 / intonationScale=1 なので、合成は語尾上げを切って（enable_interrogative_upspeak=false）呼ぶこと。
 */
export function shapePitch(q: VoicevoxAudioQuery, limits = PITCH_LIMITS): VoicevoxAudioQuery {
  const out = structuredClone(q);
  for (const ap of out.accent_phrases) {
    const last = ap.moras[ap.moras.length - 1];
    if (ap.is_interrogative && last && last.pitch > 0) {
      ap.moras.push({
        text: VOWEL_KANA[last.vowel] ?? last.text,
        consonant: null,
        consonant_length: null,
        vowel: last.vowel,
        vowel_length: UPSPEAK_LENGTH,
        pitch: Math.min(last.pitch + UPSPEAK_PITCH_ADD, UPSPEAK_PITCH_MAX),
      });
    }
  }
  const moras: VoicevoxMora[] = out.accent_phrases.flatMap((ap) => (ap.pause_mora ? [...ap.moras, ap.pause_mora] : ap.moras));
  const k = 2 ** (q.pitchScale ?? 0);
  for (const m of moras) m.pitch *= k;
  const voiced = moras.filter((m) => m.pitch > 0);
  if (voiced.length) {
    const mean = voiced.reduce((a, m) => a + m.pitch, 0) / voiced.length;
    const hi = Math.max(...voiced.map((m) => m.pitch));
    const lo = Math.min(...voiced.map((m) => m.pitch));
    const it = q.intonationScale ?? 1;
    for (const m of voiced) {
      const p = (m.pitch - mean) * it + mean;
      if (p > hi) m.pitch = hi + softLimit((p - hi) / ST, limits.upKnee, limits.upMax) * ST;
      else if (p < lo) m.pitch = lo - softLimit((lo - p) / ST, limits.downKnee, limits.downMax) * ST;
      else m.pitch = p;
    }
  }
  out.pitchScale = 0;
  out.intonationScale = 1;
  return out;
}
