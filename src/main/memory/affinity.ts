// Affinity (0..100) and mood (-1..1) rules (spec 2.5 記憶の学習 ④, 4.6, skill mmd-memory-personalization §5).
import { EMOTION_VALENCE, type Emotion } from '@shared/emotions';
import type { Relationship } from '@shared/types';

export const STAGES = [
  { min: 0, name: '初対面', tone: '丁寧語中心で控えめに話す。踏み込んだ話題は避ける。' },
  { min: 20, name: '顔なじみ', tone: '丁寧語を基本に、ときどきくだけた口調を混ぜる。挨拶に一言添える。' },
  { min: 40, name: '親しい', tone: 'くだけた口調が中心。自分から話題を振ってよい。喜びは大きめに表す。' },
  { min: 70, name: '相棒', tone: 'くだけた口調で、これまでの出来事や内輪ネタにも触れる。記念日を大事にする。' },
] as const;

export function stageOf(affinity: number): number {
  let s = 0;
  for (let i = 0; i < STAGES.length; i++) if (affinity >= STAGES[i].min) s = i;
  return s;
}

const DAILY_UP = 5;
const DAILY_DOWN = -3;

/** Apply an affinity delta (±1..3 per extraction) with daily caps. Returns a new object. */
export function applyAffinityDelta(rel: Relationship, delta: number, today: string): Relationship {
  const d = Math.max(-3, Math.min(3, Math.round(delta)));
  const daily = rel.deltaDate === today ? rel.dailyDelta : 0;
  const allowed = Math.max(DAILY_DOWN - daily, Math.min(DAILY_UP - daily, d));
  const affinity = Math.max(0, Math.min(100, rel.affinity + allowed));
  return { ...rel, affinity, dailyDelta: daily + (affinity - rel.affinity), deltaDate: today };
}

/** Exponential moving average of emotion valence (α = 0.1). */
export function updateMood(mood: number, emotion: Emotion, intensity: number, alpha = 0.1): number {
  const v = EMOTION_VALENCE[emotion] * Math.min(1, Math.max(0, intensity));
  return Math.max(-1, Math.min(1, mood + alpha * (v - mood)));
}
