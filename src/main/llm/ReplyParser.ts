// Incremental parser for the emotion-tagged reply stream (spec 5.3, skill mmd-reply-protocol §2).
// Pure state machine: no I/O. Feed chunks with push(), flush with end().
import { type Emotion, isEmotion } from '@shared/emotions';

export type ReplyEvent =
  | { type: 'sentence'; id: number; text: string; emotion: Emotion; intensity: number }
  | { type: 'detail'; markdown: string };

const TAG_MAX = 24;
const DEFAULT_INTENSITY = 0.6;
const TERMINATORS = new Set(['。', '！', '？', '!', '?', '\n']);
const TRAILING = new Set(['」', '』', '）', ')', '】', '〕', '］', '"', '”', '’', '！', '？', '!', '?', '。', '…', '♪', '〜', '～']);
const FIRST_SENTENCE_COMMA_MIN = 15;
const DETAIL_OPEN = '<detail>';
const DETAIL_CLOSE = '</detail>';

export interface ReplyParserStats {
  tags: number;
  sentences: number;
  unknownEmotions: number;
}

export class ReplyParser {
  private buf = '';
  private sentence = '';
  private emotion: Emotion = 'neutral';
  private intensity = DEFAULT_INTENSITY;
  private inDetail = false;
  private detail = '';
  private nextId = 0;
  private pendingFlush = false;
  private emittedSentences = 0;
  readonly stats: ReplyParserStats = { tags: 0, sentences: 0, unknownEmotions: 0 };

  constructor(initialEmotion: Emotion = 'neutral') {
    this.emotion = initialEmotion;
    this.intensity = initialEmotion === 'neutral' ? 0.5 : DEFAULT_INTENSITY;
  }

  /** True if no emotion tag was seen in the whole reply (format violation, logged only). */
  get malformed(): boolean {
    return this.stats.tags === 0;
  }

  push(chunk: string): ReplyEvent[] {
    this.buf += chunk;
    return this.drain(false);
  }

  end(): ReplyEvent[] {
    const out = this.drain(true);
    if (this.pendingFlush) {
      this.pendingFlush = false;
      this.flushSentence(out);
    }
    if (this.inDetail) {
      // unterminated <detail>: everything that's left is detail
      this.detail += this.buf;
      this.buf = '';
      if (this.detail.trim()) out.push({ type: 'detail', markdown: this.detail.trim() });
      this.detail = '';
      this.inDetail = false;
    } else {
      this.sentence += this.buf;
      this.buf = '';
      this.flushSentence(out);
    }
    return out;
  }

  private drain(final: boolean): ReplyEvent[] {
    const out: ReplyEvent[] = [];
    if (this.pendingFlush) {
      this.absorbTrailing();
      if (this.buf.length === 0 && !final) return out;
      this.pendingFlush = false;
      this.flushSentence(out);
    }
    while (this.buf.length > 0) {
      if (this.inDetail) {
        const close = this.buf.indexOf(DETAIL_CLOSE);
        if (close >= 0) {
          this.detail += this.buf.slice(0, close);
          this.buf = this.buf.slice(close + DETAIL_CLOSE.length);
          this.inDetail = false;
          if (this.detail.trim()) out.push({ type: 'detail', markdown: this.detail.trim() });
          this.detail = '';
          continue;
        }
        // keep a possible partial "</detail" at the end
        const keep = partialSuffix(this.buf, DETAIL_CLOSE);
        this.detail += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        if (final) {
          this.detail += this.buf;
          this.buf = '';
        }
        break;
      }

      const ch = this.buf[0];

      if (ch === '[') {
        const close = this.buf.indexOf(']');
        if (close < 0) {
          if (this.buf.length <= TAG_MAX && !final) break; // wait for more
          this.consumeChar(out);
          continue;
        }
        const body = this.buf.slice(1, close);
        const tag = close <= TAG_MAX ? parseTag(body) : null;
        if (tag) {
          this.buf = this.buf.slice(close + 1);
          // a tag ends the current sentence: the following text belongs to the new emotion
          this.flushSentence(out);
          this.stats.tags++;
          if (!tag.known) this.stats.unknownEmotions++;
          this.emotion = tag.emotion;
          this.intensity = tag.intensity;
          // swallow a single space after the tag
          if (this.buf[0] === ' ' || this.buf[0] === '　') this.buf = this.buf.slice(1);
          continue;
        }
        this.consumeChar(out);
        continue;
      }

      if (ch === '<') {
        if (this.buf.startsWith(DETAIL_OPEN)) {
          this.flushSentence(out);
          this.buf = this.buf.slice(DETAIL_OPEN.length);
          this.inDetail = true;
          continue;
        }
        if (DETAIL_OPEN.startsWith(this.buf) && !final) break; // partial "<deta"
        if (this.buf.startsWith(DETAIL_CLOSE)) {
          // stray close tag: drop it
          this.buf = this.buf.slice(DETAIL_CLOSE.length);
          continue;
        }
        if (DETAIL_CLOSE.startsWith(this.buf) && !final) break;
        this.consumeChar(out);
        continue;
      }

      this.consumeChar(out);
      if (this.pendingFlush) break;
    }
    return out;
  }

  private absorbTrailing(): void {
    while (this.buf.length > 0 && TRAILING.has(this.buf[0])) {
      this.sentence += this.buf[0];
      this.buf = this.buf.slice(1);
    }
  }

  private consumeChar(out: ReplyEvent[]): void {
    const ch = this.buf[0];
    this.buf = this.buf.slice(1);
    this.sentence += ch;

    if (TERMINATORS.has(ch)) {
      // absorb closing brackets / repeated marks that follow; if the chunk ends here we can't know
      // yet whether a 」 follows, so defer the flush to the next push()/end().
      this.absorbTrailing();
      if (this.buf.length === 0) {
        this.pendingFlush = true;
        return;
      }
      this.flushSentence(out);
      return;
    }

    if (
      ch === '、' &&
      this.emittedSentences === 0 &&
      [...this.sentence.trim()].length >= FIRST_SENTENCE_COMMA_MIN
    ) {
      this.flushSentence(out);
    }
  }

  private flushSentence(out: ReplyEvent[]): void {
    const text = this.sentence.replace(/\s+/g, ' ').trim();
    this.sentence = '';
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return;
    out.push({ type: 'sentence', id: this.nextId++, text, emotion: this.emotion, intensity: this.intensity });
    this.emittedSentences++;
    this.stats.sentences++;
  }
}

function parseTag(body: string): { emotion: Emotion; intensity: number; known: boolean } | null {
  const m = /^\s*([a-zA-Z_]+)\s*(?:[:：]\s*([0-9]*\.?[0-9]+))?\s*$/.exec(body);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const known = isEmotion(name);
  let intensity = m[2] !== undefined ? Number(m[2]) : DEFAULT_INTENSITY;
  if (!Number.isFinite(intensity)) intensity = DEFAULT_INTENSITY;
  intensity = Math.min(1, Math.max(0, intensity));
  return { emotion: known ? (name as Emotion) : 'neutral', intensity, known };
}

/** Length of the longest suffix of `s` that is a proper prefix of `token`. */
function partialSuffix(s: string, token: string): number {
  for (let n = Math.min(token.length - 1, s.length); n > 0; n--) {
    if (token.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

/** Strip emotion tags and detail blocks — for plain text views (history, logs). */
export function stripReplyMarkup(raw: string): string {
  return raw
    .replace(/<detail>[\s\S]*?(<\/detail>|$)/g, '')
    .replace(/\[[a-zA-Z_]+(?:[:：][0-9.]+)?\]\s?/g, '')
    .trim();
}

/** The dominant emotion of a full reply (first tagged emotion with highest intensity). */
export function dominantEmotion(events: ReplyEvent[]): Emotion {
  let best: { e: Emotion; i: number } = { e: 'neutral', i: -1 };
  for (const ev of events) {
    if (ev.type === 'sentence' && ev.emotion !== 'neutral' && ev.intensity > best.i) best = { e: ev.emotion, i: ev.intensity };
  }
  return best.e;
}
