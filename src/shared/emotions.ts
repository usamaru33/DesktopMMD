// The eight emotions the LLM can tag sentences with (spec 4.1 / 5.3).

export const EMOTIONS = [
  'neutral',
  'happy',
  'surprised',
  'sad',
  'angry',
  'troubled',
  'shy',
  'thinking',
] as const;

export type Emotion = (typeof EMOTIONS)[number];

export const EMOTION_LABELS: Record<Emotion, string> = {
  neutral: '平常',
  happy: '喜び',
  surprised: '驚き',
  sad: '悲しみ',
  angry: '怒り',
  troubled: '困り',
  shy: '照れ',
  thinking: '考える',
};

export function isEmotion(v: unknown): v is Emotion {
  return typeof v === 'string' && (EMOTIONS as readonly string[]).includes(v);
}

/** Per-emotion voice correction (spec 5.6 / 6.5). */
export interface EmotionVoice {
  styleId: number | null;
  speedMul: number;
  pitchAdd: number;
  intonationMul: number;
}

export const NEUTRAL_EMOTION_VOICE: EmotionVoice = {
  styleId: null,
  speedMul: 1,
  pitchAdd: 0,
  intonationMul: 1,
};

/** Defaults used when a character preset has no entry for an emotion. */
export const DEFAULT_EMOTION_VOICE: Partial<Record<Emotion, EmotionVoice>> = {
  happy: { styleId: null, speedMul: 1.05, pitchAdd: 0.03, intonationMul: 1.15 },
  sad: { styleId: null, speedMul: 0.92, pitchAdd: -0.02, intonationMul: 0.9 },
  surprised: { styleId: null, speedMul: 1.08, pitchAdd: 0.04, intonationMul: 1.2 },
  angry: { styleId: null, speedMul: 1.03, pitchAdd: -0.01, intonationMul: 1.1 },
  troubled: { styleId: null, speedMul: 0.97, pitchAdd: -0.01, intonationMul: 0.95 },
  shy: { styleId: null, speedMul: 0.97, pitchAdd: 0.02, intonationMul: 1.05 },
  thinking: { styleId: null, speedMul: 0.95, pitchAdd: 0, intonationMul: 0.95 },
};

/** Valence used for the mood moving average (spec 4.1, skill mmd-memory-personalization §5). */
export const EMOTION_VALENCE: Record<Emotion, number> = {
  neutral: 0,
  happy: 0.6,
  surprised: 0.1,
  sad: -0.6,
  angry: -0.5,
  troubled: -0.3,
  shy: 0.3,
  thinking: 0,
};

/**
 * 感情に合うスタイル名（話者のスタイル名に含まれていれば使う。先にあるものほど優先）。
 * 音高や抑揚を上げて感情を出すより、その感情で録られたスタイルに切り替えたほうが自然に聞こえる。
 */
export const EMOTION_STYLE_WORDS: Partial<Record<Emotion, string[]>> = {
  happy: ['喜び', 'うれし', '嬉し', 'たのしい', '楽しい', 'わーい', 'うきうき', '上機嫌', '楽々', '元気', 'テンション高'],
  surprised: ['おどろき', '驚', 'びっくり'],
  sad: ['悲しみ', 'かなしみ', 'かなしい', '哀', 'せつな', '泣き', 'びえーん'],
  angry: ['怒り', 'おこ', '不機嫌', 'ツンツン'],
  troubled: ['困', 'おどおど', 'びくびく', 'こわがり', '不安', 'なみだめ'],
  shy: ['照れ', '恥', '人見知り', 'あまあま'],
  thinking: ['おちつき', '落ち着', 'しっとり', 'のんびり'],
};

/** これより弱い感情では自動のスタイル切り替えをしない（文ごとに声色が変わりすぎないように） */
export const AUTO_STYLE_MIN_INTENSITY = 0.5;

/**
 * 基本のスタイルと同じ話者のスタイルから、感情ごとに使うスタイルを選ぶ。
 * styles は話者ごとのスタイル一覧（/speakers の形）。基本のスタイルと同じになるものは入れない。
 */
export function autoEmotionStyles(speakers: { styles: { id: number; name: string }[] }[], baseStyleId: number): Partial<Record<Emotion, number>> {
  const sp = speakers.find((s) => s.styles.some((st) => st.id === baseStyleId));
  const out: Partial<Record<Emotion, number>> = {};
  if (!sp) return out;
  for (const [e, words] of Object.entries(EMOTION_STYLE_WORDS) as [Emotion, string[]][]) {
    for (const w of words) {
      const st = sp.styles.find((s) => s.name.includes(w));
      if (st) {
        if (st.id !== baseStyleId) out[e] = st.id;
        break;
      }
    }
  }
  return out;
}
