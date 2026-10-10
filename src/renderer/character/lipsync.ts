// Vowel lip-sync timeline from a VOICEVOX AudioQuery (spec 4.4). Pure functions; no DOM.
import type { VoicevoxAudioQuery, VoicevoxMora } from '@shared/types';

export type Vowel = 'a' | 'i' | 'u' | 'e' | 'o';

export interface LipKey {
  t0: number; // seconds from playback start
  t1: number;
  vowel: Vowel | null; // null = closed
  weight: number; // target opening for this segment (0..1)
}

export const MAX_OPEN = 0.8;
export const CROSSFADE = 0.06;
const UNVOICED_WEIGHT = 0.3;
const CONSONANT_WEIGHT = 0.4;

function vowelOf(m: Pick<VoicevoxMora, 'vowel'>): { vowel: Vowel | null; unvoiced: boolean } {
  const v = m.vowel;
  if (v === 'N' || v === 'cl' || v === 'pau' || !v) return { vowel: null, unvoiced: false };
  const lower = v.toLowerCase();
  if (lower === 'a' || lower === 'i' || lower === 'u' || lower === 'e' || lower === 'o') {
    return { vowel: lower, unvoiced: v !== lower };
  }
  return { vowel: null, unvoiced: false };
}

/**
 * Build the timeline. VOICEVOX lengths are before speedScale is applied, so every duration is
 * divided by speedScale (pre/post phoneme lengths included, matching the engine's behavior).
 */
export function buildLipTimeline(q: VoicevoxAudioQuery): LipKey[] {
  const speed = q.speedScale > 0 ? q.speedScale : 1;
  const pauseScale = q.pauseLengthScale ?? 1;
  const keys: LipKey[] = [];
  let t = 0;
  let prev: Vowel | null = null;

  const push = (dur: number, vowel: Vowel | null, weight: number) => {
    if (dur <= 0) return;
    const last = keys[keys.length - 1];
    if (last && last.vowel === vowel && last.weight === weight && Math.abs(last.t1 - t) < 1e-9) {
      last.t1 = t + dur;
    } else {
      keys.push({ t0: t, t1: t + dur, vowel, weight });
    }
    t += dur;
  };

  push(q.prePhonemeLength / speed, null, 0);
  for (const ap of q.accent_phrases) {
    for (const m of ap.moras) {
      const c = (m.consonant_length ?? 0) / speed;
      const v = (m.vowel_length ?? 0) / speed;
      const { vowel, unvoiced } = vowelOf(m);
      // during the consonant the mouth keeps the previous shape, mostly closed
      if (c > 0) push(c, prev, prev ? CONSONANT_WEIGHT * MAX_OPEN : 0);
      if (vowel) push(v, vowel, (unvoiced ? UNVOICED_WEIGHT : 1) * MAX_OPEN);
      else push(v, null, 0);
      prev = vowel;
    }
    if (ap.pause_mora) {
      const pm = ap.pause_mora;
      const len = (q.pauseLength ?? (pm.vowel_length ?? 0)) * pauseScale;
      push(((pm.consonant_length ?? 0) + len) / speed, null, 0);
      prev = null;
    }
  }
  push(q.postPhonemeLength / speed, null, 0);
  return keys;
}

export function timelineDuration(keys: LipKey[]): number {
  return keys.length ? keys[keys.length - 1].t1 : 0;
}

export type MouthWeights = Record<Vowel, number>;

const ZERO: MouthWeights = { a: 0, i: 0, u: 0, e: 0, o: 0 };

/** Sample mouth weights at time t with a CROSSFADE-long linear blend into each new segment. */
export function sampleMouth(keys: LipKey[], t: number): MouthWeights {
  const out: MouthWeights = { ...ZERO };
  if (!keys.length || t < 0 || t > keys[keys.length - 1].t1) return out;
  // binary search for the segment containing t
  let lo = 0;
  let hi = keys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keys[mid].t0 <= t) lo = mid;
    else hi = mid - 1;
  }
  const cur = keys[lo];
  const prev = lo > 0 ? keys[lo - 1] : null;
  const k = Math.min(1, (t - cur.t0) / CROSSFADE);
  if (cur.vowel) out[cur.vowel] += cur.weight * k;
  if (prev?.vowel && k < 1) out[prev.vowel] += prev.weight * (1 - k);
  for (const v of Object.keys(out) as Vowel[]) out[v] = Math.min(MAX_OPEN, out[v]);
  return out;
}

/** Volume-based fallback (no mora info): smooth RMS into an "a" opening. */
export class VolumeLip {
  private level = 0;
  constructor(
    private readonly attack = 0.03,
    private readonly release = 0.08,
  ) {}
  update(rms: number, dt: number): number {
    const target = Math.min(1, Math.max(0, (rms - 0.02) * 6)) * MAX_OPEN;
    const tau = target > this.level ? this.attack : this.release;
    const a = 1 - Math.exp(-dt / tau);
    this.level += (target - this.level) * a;
    return this.level;
  }
}
