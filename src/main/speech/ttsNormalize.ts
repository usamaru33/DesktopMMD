// Text cleanup before speech synthesis (spec 5.3 "読み上げ前の整形", skill mmd-reply-protocol §3).

export interface DictEntry {
  surface: string;
  pronunciation: string;
}

const URL_RE = /\bhttps?:\/\/[^\s　）)」』】]+/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const MARKDOWN_RE = /[*_~`#>|]+/g;
// Emoji & pictographs, variation selectors, ZWJ, keycaps
const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu;
const LAUGH_RE = /[（(]笑[)）]|ｗ{2,}|w{2,}(?![a-z])/gi;

export function normalizeForTts(text: string, dict: DictEntry[] = []): string {
  let s = text.normalize('NFKC');
  s = s.replace(URL_RE, 'リンク');
  s = s.replace(EMAIL_RE, '');
  s = s.replace(EMOJI_RE, '');
  s = s.replace(LAUGH_RE, '');
  s = s.replace(MARKDOWN_RE, '');
  // stray brackets left by markup
  s = s.replace(/\[\s*\]|\(\s*\)|（\s*）/g, '');
  s = applyDict(s, dict);
  s = s.replace(/\s+/g, ' ').trim();
  // nothing pronounceable left
  if (!/[\p{L}\p{N}]/u.test(s)) return '';
  return s;
}

/** Longest-surface-first replacement of dictionary words (mainly English words → katakana). */
export function applyDict(text: string, dict: DictEntry[]): string {
  if (dict.length === 0) return text;
  const sorted = [...dict].filter((d) => d.surface).sort((a, b) => b.surface.length - a.surface.length);
  let out = text;
  for (const d of sorted) {
    const surf = d.surface.normalize('NFKC');
    if (/^[A-Za-z0-9 .+#-]+$/.test(surf)) {
      // ascii word: match case-insensitively at word boundaries
      const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(surf)}(?![A-Za-z0-9])`, 'gi');
      out = out.replace(re, d.pronunciation);
    }
    // non-ascii surfaces are handled by the VOICEVOX user dictionary itself
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Key used to match a sentence against saved fixed phrases (spec 5.6): no punctuation / spaces. */
export function phraseKey(text: string): string {
  return text.normalize('NFKC').replace(/[\s、。！？!?,.・「」『』（）()〜~ー－-]/g, '');
}
