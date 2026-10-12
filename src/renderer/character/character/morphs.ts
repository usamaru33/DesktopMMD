// Emotion → morph candidate lookup (spec 4.2, skill mmd-character-expression §3). Pure; no three.js.
import type { Emotion } from '@shared/emotions';

export type FacePart = 'eye' | 'brow' | 'mouth' | 'cheek';

export const EMOTION_MORPHS: Record<Exclude<Emotion, 'neutral'>, Partial<Record<FacePart, string[]>>> = {
  happy: { eye: ['笑い', 'にこり', 'ウィンク'], brow: ['にこり', '上'], mouth: ['にっこり', '∇', 'ワ', '口角上げ'] },
  surprised: { eye: ['びっくり', '瞳小', '見開き'], brow: ['上', '驚き'], mouth: ['お', '▲', 'あ'] },
  sad: { eye: ['じと目', 'なごみ'], brow: ['困る'], mouth: ['へ', '∧', '口角下げ', 'ん'] },
  angry: { eye: ['じと目', 'ｷﾘｯ', 'キリッ'], brow: ['怒り', '真面目'], mouth: ['へ', '∧', 'ω'] },
  troubled: { eye: ['なごみ', 'はぅ', '困り目', 'じと目'], brow: ['困る'], mouth: ['ん', 'い', '∧'] },
  shy: { eye: ['にこり', 'なごみ'], brow: ['困る'], mouth: ['ん', '口すぼめ', 'ω'], cheek: ['照れ', '赤面', '頬染め'] },
  thinking: { brow: ['真面目', '困る'], mouth: ['ん', '口すぼめ', '∧'] },
};

/**
 * Emotion intensity (0..1) → how strongly the face shows it. Concave so that the mild intensities
 * the LLM usually picks (0.4〜0.5) still read clearly (0.4 → 0.64), while 0 stays 0 and 1 stays 1.
 */
export function faceLevel(intensity: number): number {
  const k = Math.min(1, Math.max(0, intensity));
  return 1 - (1 - k) * (1 - k);
}

/** Weight of each part relative to the emotion intensity. */
export const PART_WEIGHT: Record<FacePart, number> = { eye: 0.9, brow: 0.8, mouth: 0.6, cheek: 1.0 };

export const VOWEL_MORPHS: Record<'a' | 'i' | 'u' | 'e' | 'o', string[]> = {
  a: ['あ', 'あ２', 'a'],
  i: ['い', 'い２', 'i'],
  u: ['う', 'う２', 'u'],
  e: ['え', 'え２', 'e'],
  o: ['お', 'お２', 'o'],
};

export const BLINK_MORPHS = ['まばたき', 'まばたき２', 'blink'];

export function normalizeName(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/**
 * Find the first candidate present in the model. Exact match first, then a normalized match
 * (full/half width, spaces, case). `override` (character.json morphMap) wins.
 */
export function findMorph(dict: Record<string, number>, candidates: string[], override?: string): number | null {
  if (override !== undefined) {
    if (override in dict) return dict[override];
    const n = findNormalized(dict, override);
    if (n !== null) return n;
  }
  for (const c of candidates) if (c in dict) return dict[c];
  for (const c of candidates) {
    const n = findNormalized(dict, c);
    if (n !== null) return n;
  }
  return null;
}

function findNormalized(dict: Record<string, number>, name: string): number | null {
  const target = normalizeName(name);
  for (const [k, v] of Object.entries(dict)) if (normalizeName(k) === target) return v;
  return null;
}

export interface ResolvedFace {
  emotions: Partial<Record<Exclude<Emotion, 'neutral'>, Partial<Record<FacePart, number>>>>;
  vowels: Partial<Record<'a' | 'i' | 'u' | 'e' | 'o', number>>;
  blink: number | null;
  found: string[];
  missing: string[];
}

/** Resolve every morph the controller needs, honoring morphMap overrides like {"happy.eye": "笑い2", "mouth.a": "あ２", "blink": "まばたきL"}. */
export function resolveFace(dict: Record<string, number>, morphMap: Record<string, string> = {}): ResolvedFace {
  const found: string[] = [];
  const missing: string[] = [];
  const emotions: ResolvedFace['emotions'] = {};
  for (const [emo, parts] of Object.entries(EMOTION_MORPHS) as [Exclude<Emotion, 'neutral'>, Partial<Record<FacePart, string[]>>][]) {
    emotions[emo] = {};
    for (const [part, cands] of Object.entries(parts) as [FacePart, string[]][]) {
      const idx = findMorph(dict, cands, morphMap[`${emo}.${part}`]);
      if (idx !== null) {
        emotions[emo]![part] = idx;
        found.push(`${emo}.${part}`);
      } else missing.push(`${emo}.${part}`);
    }
  }
  const vowels: ResolvedFace['vowels'] = {};
  for (const [v, cands] of Object.entries(VOWEL_MORPHS) as ['a' | 'i' | 'u' | 'e' | 'o', string[]][]) {
    const idx = findMorph(dict, cands, morphMap[`mouth.${v}`]);
    if (idx !== null) {
      vowels[v] = idx;
      found.push(`mouth.${v}`);
    } else missing.push(`mouth.${v}`);
  }
  const blink = findMorph(dict, BLINK_MORPHS, morphMap.blink);
  if (blink !== null) found.push('blink');
  else missing.push('blink');
  return { emotions, vowels, blink, found, missing };
}
