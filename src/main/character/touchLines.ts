// Short fixed lines (no conversation turn, no LLM at the moment of speaking): what the character says when
// touched (FR-EX-05), when the user comes back, and when poked awake. Picked by scene, affinity stage and
// recent lines, spoken through the voice pipeline only. Pure; no Electron.
import { createHash } from 'node:crypto';
import { EMOTIONS, type Emotion } from '@shared/emotions';
import type { TouchKind, TouchPart } from '@shared/types';

export type TouchKey = TouchPart | 'head_pat' | 'many' | 'lift' | 'welcome' | 'welcome_sleepy' | 'sleep_poke';
export const TOUCH_KEYS: TouchKey[] = ['head_pat', 'head', 'cheek', 'hand', 'shoulder', 'body', 'legs', 'many', 'lift', 'welcome', 'welcome_sleepy', 'sleep_poke'];

export interface TouchLine {
  emotion: Emotion;
  intensity: number;
  text: string;
}

/** polite: 初対面・顔なじみ、close: 親しい・相棒 */
export type TouchLineSet = Record<'polite' | 'close', Record<TouchKey, TouchLine[]>>;

const L = (emotion: Emotion, intensity: number, text: string): TouchLine => ({ emotion, intensity, text });

/** Used until (or unless) lines in the character's own voice have been generated. */
export const DEFAULT_TOUCH_LINES: TouchLineSet = {
  polite: {
    head_pat: [L('happy', 0.7, 'えへへ、撫でてもらえるとうれしいです。'), L('shy', 0.6, 'ちょっと照れちゃいます……でも、うれしいです。'), L('happy', 0.6, 'なんだか落ち着きますね。')],
    head: [L('surprised', 0.5, 'わっ、どうしました？'), L('happy', 0.6, 'はい、ここにいますよ。'), L('shy', 0.5, '頭、ぽんってされちゃいました。')],
    cheek: [L('shy', 0.7, 'ほっぺ、つつかないでください……。'), L('surprised', 0.6, 'ひゃっ、くすぐったいです。'), L('shy', 0.6, 'もう、なんですか？')],
    hand: [L('happy', 0.6, '手、あったかいですね。'), L('shy', 0.6, '握手、ですか？えへへ。'), L('happy', 0.5, 'はい、なんでしょう？')],
    shoulder: [L('surprised', 0.5, 'わっ、呼びました？'), L('neutral', 0.5, 'はい、なんでしょうか？'), L('happy', 0.5, '肩をぽんってされると、なんだか安心します。')],
    body: [L('surprised', 0.7, 'ひゃっ、くすぐったいです！'), L('troubled', 0.5, 'わわ、びっくりしました。'), L('surprised', 0.6, 'ど、どうしました？')],
    legs: [L('shy', 0.8, 'そ、そこはちょっと……恥ずかしいです。'), L('troubled', 0.6, 'ええと、そこはだめです……。'), L('shy', 0.7, 'もう、どこを触ってるんですか……。')],
    many: [L('troubled', 0.6, 'もう、そんなにつつかないでください。'), L('angry', 0.4, 'むー、遊んでますね？'), L('troubled', 0.6, 'くすぐったいですってば。')],
    lift: [L('surprised', 0.8, 'わっ、わわっ！？'), L('surprised', 0.7, 'ひゃっ、浮いてます！'), L('troubled', 0.6, 'ど、どこへ連れていくんですか？')],
    welcome: [L('happy', 0.7, 'おかえりなさい。'), L('happy', 0.6, 'あ、おかえりなさい。待ってました。'), L('happy', 0.6, 'おかえりなさい。続き、がんばりましょうね。')],
    welcome_sleepy: [L('shy', 0.6, 'ふぁ……あ、おかえりなさい。ちょっと寝ちゃってました。'), L('surprised', 0.5, 'はっ……！お、おかえりなさい。'), L('shy', 0.6, 'んん……おかえりなさい。うとうとしてました。')],
    sleep_poke: [L('neutral', 0.4, 'むにゃ……あと五分……。'), L('troubled', 0.4, 'んん……まだ眠いです……。'), L('neutral', 0.4, 'すぅ……すぅ……。')],
  },
  close: {
    head_pat: [L('happy', 0.8, 'えへへ、もっと撫でて。'), L('happy', 0.7, 'ん……気持ちいい。'), L('shy', 0.6, '撫でてもらうの、好きだな。')],
    head: [L('happy', 0.6, 'なあに？'), L('happy', 0.6, 'ふふ、呼んだ？'), L('happy', 0.5, 'ちゃんとここにいるよ。')],
    cheek: [L('shy', 0.6, 'ほっぺつつくの、好きだよね。'), L('troubled', 0.5, 'むにってしないでよー。'), L('shy', 0.6, 'もう、くすぐったいってば。')],
    hand: [L('shy', 0.6, '手、つなぐ？'), L('happy', 0.7, 'えへへ、あったかい。'), L('happy', 0.5, 'どうしたの？')],
    shoulder: [L('neutral', 0.5, 'ん、どうしたの？'), L('happy', 0.6, '肩たたき？ありがとう。'), L('surprised', 0.5, 'なになに？')],
    body: [L('surprised', 0.7, 'ひゃっ、くすぐったい！'), L('surprised', 0.6, 'わっ、びっくりした。'), L('troubled', 0.5, 'こら、くすぐらないの。')],
    legs: [L('shy', 0.8, 'ちょ、ちょっと、そこはだめ！'), L('shy', 0.7, 'もう、どこ触ってるの……。'), L('troubled', 0.6, 'そこは恥ずかしいってば……。')],
    many: [L('angry', 0.4, 'もー、遊んでるでしょ。'), L('troubled', 0.6, 'つつきすぎ！'), L('happy', 0.5, 'はいはい、ここにいるよ。')],
    lift: [L('surprised', 0.8, 'わわっ、急に持ち上げないでよー！'), L('happy', 0.6, 'わーい、お散歩？'), L('surprised', 0.7, 'ひゃっ、どこ行くの？')],
    welcome: [L('happy', 0.8, 'おかえり！'), L('happy', 0.7, 'あ、おかえり。待ってたよ。'), L('happy', 0.7, 'おかえり。さ、続きやろっか。')],
    welcome_sleepy: [L('shy', 0.6, 'ふぁ……おかえり。ちょっと寝ちゃってた。'), L('surprised', 0.6, 'はっ……！お、おかえり！'), L('shy', 0.6, 'ん……おかえり。待ってたら眠くなっちゃった。')],
    sleep_poke: [L('neutral', 0.4, 'むにゃ……あと五分……。'), L('shy', 0.4, 'ん……なあに……？'), L('neutral', 0.4, 'すぅ……すぅ……。')],
  },
};

export const TOUCH_TAP_COOLDOWN_MS = 3000;
export const TOUCH_PAT_COOLDOWN_MS = 9000;
/** this many taps within the window → "stop poking me" */
export const TOUCH_MANY_TAPS = 4;
export const TOUCH_MANY_WINDOW_MS = 8000;

/** Picks a line for a touch: rate-limited, escalates on repeated pokes, avoids repeating itself. */
export class TouchReactor {
  private lastSpoken = Number.NEGATIVE_INFINITY;
  private lastPat = Number.NEGATIVE_INFINITY;
  private taps: number[] = [];
  private recent = new Map<string, string[]>();

  constructor(private readonly rng: () => number = Math.random) {}

  /** A touch. asleep: she is sleeping, so any touch only gets a sleepy mumble. */
  react(part: TouchPart, kind: TouchKind, stage: number, lines: TouchLineSet, now: number, asleep = false): TouchLine | null {
    let key: TouchKey = asleep ? 'sleep_poke' : kind === 'pat' ? 'head_pat' : kind === 'lift' ? 'lift' : part;
    if (kind === 'tap' && !asleep) {
      this.taps = this.taps.filter((t) => now - t < TOUCH_MANY_WINDOW_MS);
      this.taps.push(now);
      if (this.taps.length >= TOUCH_MANY_TAPS) {
        key = 'many';
        this.taps = [];
        this.lastSpoken = Number.NEGATIVE_INFINITY; // being poked repeatedly always gets an answer
      }
    }
    // any line: a short gap; stroking on and on: a longer gap between its own lines
    if (now - this.lastSpoken < TOUCH_TAP_COOLDOWN_MS) return null;
    if (kind === 'pat' && now - this.lastPat < TOUCH_PAT_COOLDOWN_MS) return null;
    if (kind === 'pat') this.lastPat = now;
    return this.pick(key, stage, lines, now);
  }

  /** A line for a scene, right now (no cooldown): avoids the last ones said for that scene. */
  pick(key: TouchKey, stage: number, lines: TouchLineSet, now: number): TouchLine {
    const group = stage >= 2 ? 'close' : 'polite';
    const pool = lines[group][key]?.length ? lines[group][key] : DEFAULT_TOUCH_LINES[group][key];
    const id = `${group}.${key}`;
    const used = this.recent.get(id) ?? [];
    const fresh = pool.filter((l) => !used.includes(l.text));
    const from = fresh.length ? fresh : pool;
    const line = from[Math.floor(this.rng() * from.length) % from.length];
    this.recent.set(id, [...used, line.text].slice(-Math.max(1, Math.min(2, pool.length - 1))));
    this.lastSpoken = now;
    return line;
  }
}

// ---------------- lines in the character's own voice (generated once per persona) ----------------

const KEY_DESC: Record<TouchKey, string> = {
  head_pat: '頭を撫でられている',
  head: '頭をぽんと触られた',
  cheek: 'ほっぺ（顔）をつつかれた',
  hand: '手に触れられた',
  shoulder: '肩をとんとんと叩かれた',
  body: 'お腹や体をつつかれた',
  legs: '脚やスカートのあたりを触られた（恥ずかしがる・やんわり断る。性的な表現はしない）',
  many: '短い間に何度もつつかれた（少し困る・すねる）',
  lift: 'マウスでつまみ上げられて、宙に浮いたまま運ばれ始めた（慌てる・驚く）',
  welcome: 'ユーザーが席を外していて、戻ってきた（うれしそうに迎える。待たされたと責めない）',
  welcome_sleepy: '待っている間にうたた寝していて、ユーザーが戻ってきて目が覚めた（寝ぼけ・照れ）',
  sleep_poke: '眠っているときにつつかれた（寝言・寝ぼけたつぶやき。起きない）',
};

export const TOUCH_LINES_SYSTEM = `あなたはキャラクターのセリフを書く係です。デスクトップに住んでいる3Dのキャラクターが、ユーザーにマウスで触られたときや、席を外していたユーザーが戻ってきたときなどに、思わず口にする短いひとことを書いてください。
- その瞬間の反応そのものを書く。何をされたかを説明しない。
  良い例: 「ひゃっ、くすぐったいです！」「えへへ、もっと撫でて」「そ、そこはだめです……」「むー、遊んでますね？」
  悪い例: 「ほっぺをつつかれて、少し困っています」「頭を撫でてくださって、ありがとうございます」
- キャラクターの設定（性格・口調・一人称・口ぐせ）に忠実に。感嘆詞（わっ、ひゃっ、えへへ、むー など）をそのキャラらしく使う。
- 1つのセリフは話し言葉で1〜2文、30文字くらいまで。読み上げるので、絵文字・顔文字・記号の連打は使わない。
- 同じ場面の3つのセリフは言い回しを変え、場面ごとにも書き分ける。ユーザーの名前を毎回入れない。
- polite は「初対面・顔なじみ」のころ（丁寧で少し遠慮がある）、close は「親しい・相棒」のころ（打ち解けて甘えたり、からかったりもする）。close は polite と同じ文にしない。
- emotion はそのセリフの気持ち（happy, surprised, troubled, shy, angry など）。neutral はほとんど使わない。
場面:
${TOUCH_KEYS.map((k) => `- ${k}: ${KEY_DESC[k]}`).join('\n')}`;

const LINE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { emotion: { type: 'string', enum: [...EMOTIONS] }, text: { type: 'string' } },
    required: ['emotion', 'text'],
    additionalProperties: false,
  },
};
const GROUP_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(TOUCH_KEYS.map((k) => [k, LINE_SCHEMA])),
  required: TOUCH_KEYS,
  additionalProperties: false,
};
export const TOUCH_LINES_SCHEMA = {
  type: 'object',
  properties: { polite: GROUP_SCHEMA, close: GROUP_SCHEMA },
  required: ['polite', 'close'],
  additionalProperties: false,
};

/** Bump when the prompt or the scenes change, so cached lines are made again. */
const TOUCH_LINES_VERSION = 4;

export function touchLinesKey(personaText: string): string {
  return createHash('sha256').update(`${TOUCH_LINES_VERSION}\n${personaText}`).digest('hex').slice(0, 16);
}

const MAX_LEN = 50;

/**
 * Keep only usable generated lines; a scene with fewer than 2 good ones falls back to the default lines.
 * Returns null if nothing usable came back at all.
 */
export function sanitizeTouchLines(raw: unknown): TouchLineSet | null {
  if (!raw || typeof raw !== 'object') return null;
  let good = 0;
  const out = { polite: {}, close: {} } as TouchLineSet;
  for (const group of ['polite', 'close'] as const) {
    const g = (raw as Record<string, unknown>)[group] as Record<string, unknown> | undefined;
    for (const key of TOUCH_KEYS) {
      const items = Array.isArray(g?.[key]) ? (g[key] as unknown[]) : [];
      const lines: TouchLine[] = [];
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const { emotion, text } = it as { emotion?: unknown; text?: unknown };
        if (typeof text !== 'string' || !(EMOTIONS as readonly string[]).includes(String(emotion))) continue;
        const t = text.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
        if (t.length < 2 || t.length > MAX_LEN || lines.some((l) => l.text === t)) continue;
        // being touched where one shouldn't be, or poked again and again, is never a happy thing
        if ((key === 'legs' || key === 'many') && emotion === 'happy') continue;
        lines.push({ emotion: emotion as Emotion, intensity: emotion === 'neutral' ? 0.5 : 0.65, text: t });
      }
      if (lines.length >= 2) {
        out[group][key] = lines.slice(0, 4);
        good++;
      } else out[group][key] = DEFAULT_TOUCH_LINES[group][key];
    }
  }
  if (!good) return null;
  // a weak model tends to answer every scene alike in a flat voice: keep the defaults rather than that
  // (sleep talk is allowed to be flat)
  const all = (['polite', 'close'] as const).flatMap((g) => TOUCH_KEYS.filter((k) => k !== 'sleep_poke').flatMap((k) => out[g][k]));
  const neutral = all.filter((l) => l.emotion === 'neutral').length;
  const endings = new Set(all.map((l) => l.text.slice(-6)));
  if (neutral > all.length * 0.4 || endings.size < all.length * 0.5) return null;
  return out;
}

export interface TouchLineLibraryDeps {
  /** the saved cache file's contents (undefined if none) */
  load(): unknown;
  save(cache: Record<string, TouchLineSet>): void;
  /** ask the LLM for lines (TOUCH_LINES_SYSTEM / TOUCH_LINES_SCHEMA); null = no LLM to ask (e.g. the offline fake) */
  generate(personaText: string): Promise<unknown> | null;
  log: { info(msg: string): void; warn(msg: string, e?: unknown): void };
}

const MAX_CACHED = 6;

/**
 * Lines per persona: the default lines right away, and in the background (once per persona) lines in
 * the character's own voice, cached by a hash of the persona so a changed skill.md makes new ones.
 */
export class TouchLineLibrary {
  private cache: Record<string, TouchLineSet> | null = null;
  private readonly busy = new Set<string>();
  private readonly failed = new Set<string>();

  constructor(private readonly d: TouchLineLibraryDeps) {}

  get(personaText: string): TouchLineSet {
    const key = touchLinesKey(personaText);
    const hit = this.all()[key];
    if (hit) return hit;
    void this.make(key, personaText);
    return DEFAULT_TOUCH_LINES;
  }

  private all(): Record<string, TouchLineSet> {
    if (!this.cache) {
      const raw = this.d.load();
      this.cache = {};
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          const s = sanitizeTouchLines(v);
          if (s) this.cache[k] = s;
        }
      }
    }
    return this.cache;
  }

  private async make(key: string, personaText: string): Promise<void> {
    if (this.busy.has(key) || this.failed.has(key)) return;
    const p = this.d.generate(personaText);
    if (!p) return;
    this.busy.add(key);
    try {
      const lines = sanitizeTouchLines(await p);
      if (!lines) throw new Error('no usable lines');
      const all = this.all();
      all[key] = lines;
      for (const k of Object.keys(all).slice(0, -MAX_CACHED)) delete all[k];
      this.d.save(all);
      this.d.log.info('touch lines generated for the current character');
    } catch (e) {
      this.failed.add(key); // don't retry (and spend) on every touch; next launch tries again
      this.d.log.warn('touch line generation failed; using the default lines', e);
    } finally {
      this.busy.delete(key);
    }
  }
}
