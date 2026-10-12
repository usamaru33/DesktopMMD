// Talking gestures (身ぶり): arm + upper-body poses chosen from what the character is saying.
// Pure data and math, no three.js. The arm targets are directions, solved per model by ArmRig.
import type { Emotion } from '@shared/emotions';
import { blendPose, type Pose, ZERO_POSE } from './motion';

export type V3 = [number, number, number];

/**
 * One arm's target, in model space (three.js: +Y up, +Z toward the viewer, +X = the character's left).
 * Written for the RIGHT arm (outward = -X); `mirror()` makes the left one.
 */
export interface ArmTarget {
  /** shoulder → elbow direction */
  upper: V3;
  /** elbow → wrist direction */
  fore: V3;
  /** which way the palm faces */
  palm: V3;
  /** wrist flex toward the palm (rad, negative = bend back) */
  wrist?: number;
  /** fingers: 0 open … 1 fist */
  curl: number;
  /** index finger curl (defaults to `curl`) */
  index?: number;
  /** thumb curl (defaults to `curl`) */
  thumb?: number;
}

export interface TalkPose {
  /** added to the upper body / neck / head like the other gestures */
  body: Pose;
  /** null = the relaxed arm */
  right: ArmTarget | null;
  left: ArmTarget | null;
}

export type TalkGestureKind =
  | 'present' // 右手を手のひら上に差し出す（紹介・説明）
  | 'self' // 胸に手を当てる（わたしが・まかせて）
  | 'guts' // 胸の前で両手を握る（がんばろう）
  | 'think' // 口元に手（うーん）
  | 'clap' // 胸の前で手を合わせる（やった・なるほど）
  | 'wave' // 手を振る（あいさつ）
  | 'bow' // お辞儀（ありがとう・ごめんなさい）
  | 'shrug' // 両手を軽く開く（わからない）
  | 'lean_in' // 身を乗り出す（ねえねえ）
  | 'count' // 人差し指を立てる（まず・1つ目）
  | 'beat' // 説明しながらの小さな手の動き
  | 'flail'; // つまみ上げられて慌てる（両腕をばたばた。話す内容では選ばない）

export const TALK_GESTURES: TalkGestureKind[] = ['present', 'self', 'guts', 'think', 'clap', 'wave', 'bow', 'shrug', 'lean_in', 'count', 'beat', 'flail'];

const D = Math.PI / 180;

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const lerp3 = (a: V3, b: V3, k: number): V3 => norm([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);

/** Turn unit vector a toward b by the fraction k of the angle between them (great-circle path). */
export function slerpDir(a: V3, b: V3, k: number): V3 {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const ang = Math.acos(dot);
  if (ang < 1e-5) return [...b];
  if (Math.PI - ang < 1e-3) return lerp3(a, b, k); // opposite: any path is as good, avoid dividing by sin 0
  const s = Math.sin(ang);
  const wa = Math.sin((1 - k) * ang) / s;
  const wb = Math.sin(k * ang) / s;
  return norm([a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb]);
}

/**
 * Blend arm targets by direction, so the hand travels the short way (blending the joint rotations instead
 * can swing the arm up past the head when the upper arm's twist differs a lot between the two poses).
 */
export function blendArm(a: ArmTarget, b: ArmTarget, k: number): ArmTarget {
  const n = (x: number | undefined, y: number | undefined, d: number) => (x ?? d) + ((y ?? d) - (x ?? d)) * k;
  return {
    upper: slerpDir(a.upper, b.upper, k),
    fore: slerpDir(a.fore, b.fore, k),
    palm: slerpDir(a.palm, b.palm, k),
    wrist: n(a.wrist, b.wrist, 0),
    curl: n(a.curl, b.curl, 0),
    index: n(a.index ?? a.curl, b.index ?? b.curl, 0),
    thumb: n(a.thumb ?? a.curl, b.thumb ?? b.curl, 0),
  };
}

/** What the talk layer shows: body offsets plus both arms resolved (the relaxed arm filled in; absent = no arm). */
export interface TalkLayer {
  body: Pose;
  right?: ArmTarget;
  left?: ArmTarget;
}

export function blendLayer(a: TalkLayer, b: TalkLayer, k: number): TalkLayer {
  const arm = (x?: ArmTarget, y?: ArmTarget) => (x && y ? blendArm(x, y, k) : y ?? x);
  return { body: blendPose(a.body, b.body, k), right: arm(a.right, b.right), left: arm(a.left, b.left) };
}

export function mirror(a: ArmTarget): ArmTarget {
  const m = (v: V3): V3 => [-v[0], v[1], v[2]];
  return { ...a, upper: m(a.upper), fore: m(a.fore), palm: m(a.palm) };
}

/** Smooth 0→1 over [t0, t1]. */
function ramp(t: number, t0: number, t1: number): number {
  const x = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  return x * x * (3 - 2 * x);
}

/**
 * How long each gesture is held at most (s). Gestures that "say something by themselves" (bow, wave, clap)
 * end even if the sentence goes on; explanatory ones (present, self, count) hold through the sentence.
 */
export const HOLD: Record<TalkGestureKind, number> = {
  present: 4.5,
  self: 3.0,
  guts: 2.0,
  think: 3.5,
  clap: 1.6,
  wave: 2.0,
  bow: 1.5,
  shrug: 2.2,
  lean_in: 2.5,
  count: 3.5,
  beat: 1.3,
  flail: 2.0, // held while being dragged (the controller extends it)
};

// key arm shapes (right arm). Directions are tuned on short-armed (chibi) and normal-proportion models alike:
// hands stay in front of the body (z > 0) so they don't sink into the chest or skirt.
const ARMS = {
  presentOut: { upper: norm([-0.42, -0.82, 0.4]), fore: norm([-0.45, 0.12, 0.88]), palm: norm([0.15, 0.95, 0.25]), wrist: -0.25, curl: 0.12 },
  self: { upper: norm([-0.38, -0.88, 0.3]), fore: norm([0.68, 0.45, 0.58]), palm: norm([0.1, 0.0, -1]), curl: 0.3 },
  fist: { upper: norm([-0.4, -0.86, 0.32]), fore: norm([0.25, 0.8, 0.55]), palm: norm([0.9, 0, -0.4]), curl: 1 },
  chin: { upper: norm([-0.28, -0.88, 0.4]), fore: norm([0.45, 0.78, 0.43]), palm: norm([0.4, 0, -0.9]), wrist: 0.35, curl: 0.55, index: 0.25 },
  clapOpen: { upper: norm([-0.36, -0.84, 0.42]), fore: norm([0.3, 0.38, 0.88]), palm: norm([0.95, 0.1, 0.1]), curl: 0.1 },
  clapShut: { upper: norm([-0.32, -0.84, 0.44]), fore: norm([0.58, 0.4, 0.71]), palm: norm([0.95, 0.1, 0.1]), curl: 0.1 },
  waveUp: { upper: norm([-0.8, -0.4, 0.45]), fore: norm([-0.12, 0.97, 0.2]), palm: norm([0, 0.1, 1]), curl: 0.08 },
  bowHands: { upper: norm([-0.2, -0.95, 0.24]), fore: norm([0.62, -0.62, 0.48]), palm: norm([0.3, 0.2, -0.93]), curl: 0.25 },
  shrug: { upper: norm([-0.42, -0.9, 0.12]), fore: norm([-0.6, 0.06, 0.8]), palm: norm([0, 1, 0.1]), wrist: -0.2, curl: 0.15 },
  countUp: { upper: norm([-0.3, -0.93, 0.22]), fore: norm([-0.12, 0.9, 0.42]), palm: norm([0.1, 0.1, 1]), curl: 1, index: 0, thumb: 0.9 },
  beat: { upper: norm([-0.38, -0.88, 0.28]), fore: norm([-0.25, -0.08, 0.96]), palm: norm([0.2, 0.9, 0.3]), wrist: -0.1, curl: 0.2 },
  flail: { upper: norm([-0.72, -0.62, 0.3]), fore: norm([-0.55, 0.45, 0.7]), palm: norm([0, 0.2, 1]), curl: 0.1 },
} satisfies Record<string, ArmTarget>;

/**
 * The pose of a gesture `t` seconds after it started. `side` 1 = the right hand leads, -1 = mirrored.
 * `scale` (動きの活発さ) widens the body motion; the arm shapes themselves stay the same.
 */
export function talkPose(kind: TalkGestureKind, t: number, side: 1 | -1 = 1, scale = 1): TalkPose {
  const body = ZERO_POSE();
  let right: ArmTarget | null = null;
  let left: ArmTarget | null = null;
  const k = scale;
  switch (kind) {
    case 'present': {
      // reach out, then hold; a small "here it is" settle after the stroke
      const settle = Math.exp(-3 * Math.max(0, t - 0.35)) * Math.sin(Math.max(0, t - 0.35) * 9) * ramp(t, 0.3, 0.4);
      right = { ...ARMS.presentOut, fore: lerp3(ARMS.presentOut.fore, [-0.45, 0.25, 0.86], 0.4 * settle) };
      body.upper[1] = -6 * D * k; // turn toward the presenting hand (her right = -yaw)
      body.upper[2] = -2 * D * k;
      body.head[2] = -4 * D * k;
      body.head[0] = 2 * D * k;
      break;
    }
    case 'self':
      right = ARMS.self;
      body.upper[0] = -2 * D * k;
      body.head[0] = -3 * D * k;
      body.rootY = 0.04 * k * Math.exp(-4 * t) * Math.sin(t * 10);
      break;
    case 'guts': {
      // two pumps of the fists
      const pump = Math.max(0, Math.sin(t * Math.PI * 2.6)) * Math.exp(-1.2 * t);
      const f: ArmTarget = { ...ARMS.fist, fore: lerp3(ARMS.fist.fore, [0.15, 0.93, 0.33], pump) };
      right = f;
      left = mirror(f);
      body.upper[0] = 3 * D * k * pump;
      body.head[0] = 4 * D * k * pump;
      body.rootY = 0.12 * k * pump;
      break;
    }
    case 'think':
      right = ARMS.chin;
      body.head[2] = -7 * D * k;
      body.head[0] = -4 * D * k;
      body.upper[1] = -3 * D * k;
      break;
    case 'clap': {
      // hands come together at 0.3 s, a second little clap at 0.6 s, then stay joined
      const open = 1 - ramp(t, 0.12, 0.3) + (ramp(t, 0.38, 0.46) - ramp(t, 0.5, 0.6)) * 0.6;
      const r: ArmTarget = {
        ...ARMS.clapShut,
        upper: lerp3(ARMS.clapShut.upper, ARMS.clapOpen.upper, open),
        fore: lerp3(ARMS.clapShut.fore, ARMS.clapOpen.fore, open),
      };
      right = r;
      left = mirror(r);
      body.head[2] = 5 * D * k * side;
      body.rootY = 0.1 * k * (ramp(t, 0.2, 0.3) - ramp(t, 0.3, 0.55));
      break;
    }
    case 'wave': {
      const sway = Math.sin(t * Math.PI * 2 * 1.6) * ramp(t, 0.15, 0.35);
      right = { ...ARMS.waveUp, fore: lerp3(ARMS.waveUp.fore, [-0.55, 0.82, 0.2], 0.5 + 0.5 * sway) };
      body.head[2] = -5 * D * k;
      body.upper[2] = -2 * D * k;
      break;
    }
    case 'bow': {
      // bow down by 0.35 s, hold, come back up before the hold ends
      const b = ramp(t, 0, 0.35) * (1 - ramp(t, 0.9, HOLD.bow));
      right = ARMS.bowHands;
      left = mirror(ARMS.bowHands);
      body.upper[0] = 16 * D * b;
      body.neck[0] = 4 * D * b;
      body.head[0] = 10 * D * b;
      break;
    }
    case 'shrug':
      right = ARMS.shrug;
      left = mirror(ARMS.shrug);
      body.head[2] = 8 * D * k * side;
      body.rootY = 0.08 * k * ramp(t, 0.1, 0.3);
      body.upper[0] = -2 * D * k;
      break;
    case 'lean_in':
      right = ARMS.bowHands;
      left = mirror(ARMS.bowHands);
      body.upper[0] = 8 * D * k;
      body.head[0] = -6 * D * k; // keep looking up at the user
      body.head[2] = 6 * D * k * side;
      break;
    case 'count': {
      const bob = Math.max(0, Math.sin(Math.max(0, t - 0.3) * Math.PI * 2 * 1.2)) * Math.exp(-1.5 * Math.max(0, t - 0.3));
      right = { ...ARMS.countUp, fore: lerp3(ARMS.countUp.fore, [-0.05, 0.85, 0.5], bob) };
      body.head[2] = -4 * D * k;
      body.head[0] = 3 * D * k * bob;
      break;
    }
    case 'beat': {
      const beat = Math.max(0, Math.sin(t * Math.PI * 2 * 1.4)) * ramp(t, 0, 0.2);
      right = { ...ARMS.beat, fore: lerp3(ARMS.beat.fore, [-0.3, 0.12, 0.95], beat) };
      body.upper[1] = -3 * D * k;
      body.head[0] = 2.5 * D * k * beat;
      break;
    }
    case 'flail': {
      // both forearms flap, out of step with each other
      const a = Math.sin(t * Math.PI * 2 * 2.2);
      const b = Math.sin(t * Math.PI * 2 * 2.2 + 2.1);
      right = { ...ARMS.flail, fore: lerp3(ARMS.flail.fore, [-0.75, -0.1, 0.65], 0.5 + 0.5 * a) };
      left = mirror({ ...ARMS.flail, fore: lerp3(ARMS.flail.fore, [-0.75, -0.1, 0.65], 0.5 + 0.5 * b) });
      break;
    }
  }
  if (side === -1) {
    [right, left] = [left && mirror(left), right && mirror(right)];
    body.upper[1] *= -1;
    body.upper[2] *= -1;
    body.neck[1] *= -1;
    body.neck[2] *= -1;
    body.head[1] *= -1;
    body.head[2] *= -1;
  }
  return { body, right, left };
}

// ---------------- choosing a gesture from the sentence ----------------

/** Keyword rules, first match wins. Ordered so that the specific ones beat the generic "explaining" ones. */
const RULES: [TalkGestureKind, RegExp][] = [
  ['wave', /^(?:[^\p{L}\p{N}]*)(おはよう|こんにちは|こんばんは|おかえり|ただいま|はじめまして|やっほ|またね|じゃあね|いってらっしゃい|行ってらっしゃい|ばいばい|バイバイ|おやすみ(?:なさい)?[!！。〜ー]*$)/u],
  ['bow', /ありがと|すみません|ごめん(?:なさい|ね)?|申し訳|よろしくお願い|お疲れさま|お疲れ様|おつかれさま|お願いします|失礼しました/],
  ['guts', /がんば|頑張|ファイト|負けない|気合|いけます|いけるよ|いけるって|一緒にやろ|やってみよう|やりましょう/],
  ['clap', /やった|すごい|凄い|素敵|すてき|おめでとう|いいですね|いいね[！!]|なるほど|最高|わーい|うれしい|嬉しい|楽しみ/],
  ['shrug', /わかりません|分かりません|わからない|分からない|さあ[、…]|どうでしょう|しかたない|仕方ない|しょうがない|知らない/],
  ['count', /(?:^|[、。])(?:まず|最初に|はじめに|次に|それから|最後に|1つ目|一つ目|ひとつ目|2つ目|二つ目|ふたつ目|ポイントは|第一に)/],
  ['think', /^(?:うーん|ううん|えーと|ええと|えっと|んー|そうですね[ぇえ]?、)|かなあ|かなぁ|でしょうか|考えて|悩/],
  ['lean_in', /^(?:ねえ|ねぇ|あのね|聞いて|実は|ところで)/],
  ['present', /こんな感じ|こちら|こうなって|以下の|次のとおり|次の通り|予報|結果は|まとめ|一覧|紹介|見てください|見てみて|どうぞ|おすすめ|オススメ|ありました|見つかりました|できました|用意しました|予定は|天気は/],
];

export interface ChooseOptions {
  /** the character's first person (わたし, あたし…): "self" on "わたしが" / "まかせて" */
  firstPerson?: string;
  /** chance of a plain "beat" when nothing matched (0 = never) */
  beatChance: number;
  /** chance to use a matched gesture at all (calm characters skip some) */
  matchChance: number;
  /** the previous gesture: explanatory gestures don't repeat back to back */
  last?: TalkGestureKind | null;
  rng?: () => number;
}

/** Pick a gesture for a sentence, or null to keep the arms relaxed. */
export function chooseTalkGesture(text: string, emotion: Emotion, opt: ChooseOptions): TalkGestureKind | null {
  const rng = opt.rng ?? Math.random;
  const s = text.trim();
  if (!s) return null;
  let kind: TalkGestureKind | null = null;
  for (const [k, re] of RULES) {
    if (re.test(s)) {
      kind = k;
      break;
    }
  }
  if (!kind) {
    const me = [opt.firstPerson, 'わたし', '私'].filter((x): x is string => !!x).map(escapeRe).join('|');
    if (new RegExp(`(?:${me})(?:が|に)(?:やり|やっ|調べ|探し|まかせ|任せ|お手伝い|手伝)|まかせて|任せて|わたしの番`).test(s)) kind = 'self';
  }
  if (!kind) {
    if (emotion === 'thinking' || emotion === 'troubled') kind = 'think';
    else if (emotion === 'happy' && rng() < 0.3) kind = 'clap';
  }
  if (kind) {
    if (rng() >= opt.matchChance) return null;
    // the same explanatory gesture twice in a row looks mechanical: fall back to a beat
    if (kind === opt.last && (kind === 'present' || kind === 'count' || kind === 'think' || kind === 'self')) kind = 'beat';
    return kind;
  }
  // nothing specific: a small explanatory hand movement on longer sentences
  if (s.length >= 14 && rng() < opt.beatChance) return 'beat';
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
