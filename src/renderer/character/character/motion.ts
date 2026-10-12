// Procedural motion primitives (spec 4.2 自前動作, 4.3 アイドル, 4.5 視線). Pure math, no three.js.
import type { Emotion } from '@shared/emotions';
import type { CharacterState, Liveliness } from '@shared/types';

/** Additive rotations in radians (x: pitch forward+, y: yaw left+, z: roll) and a root offset. */
export interface Pose {
  upper: [number, number, number];
  neck: [number, number, number];
  head: [number, number, number];
  rootY: number;
}

export const ZERO_POSE = (): Pose => ({ upper: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0], rootY: 0 });

export function addPose(a: Pose, b: Pose, k = 1): Pose {
  return {
    upper: [a.upper[0] + b.upper[0] * k, a.upper[1] + b.upper[1] * k, a.upper[2] + b.upper[2] * k],
    neck: [a.neck[0] + b.neck[0] * k, a.neck[1] + b.neck[1] * k, a.neck[2] + b.neck[2] * k],
    head: [a.head[0] + b.head[0] * k, a.head[1] + b.head[1] * k, a.head[2] + b.head[2] * k],
    rootY: a.rootY + b.rootY * k,
  };
}

const D = Math.PI / 180;
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const bell = (x: number) => Math.sin(Math.PI * Math.min(1, Math.max(0, x))); // 0→1→0
/** Rise quickly to 1 by `attack`, hold, then return to 0 over the last `release` of the duration. */
function envelope(t: number, dur: number, attack = 0.15, release = 0.45): number {
  if (t <= 0 || t >= dur) return 0;
  const a = attack * dur;
  const r = release * dur;
  if (t < a) return easeOut(t / a);
  if (t > dur - r) return easeOut((dur - t) / r);
  return 1;
}

export interface Gesture {
  duration: number;
  pose(t: number): Pose;
}

/** One-shot reactions used when no VMD is available for an emotion (spec 4.2 table). */
export function emotionGesture(e: Emotion, intensity: number, side: 1 | -1 = 1): Gesture | null {
  const k = Math.max(0.3, intensity);
  switch (e) {
    case 'happy':
      return {
        duration: 0.9,
        pose: (t) => {
          const p = ZERO_POSE();
          // two small hops
          const hop = t < 0.9 ? Math.abs(Math.sin((t / 0.45) * Math.PI)) : 0;
          p.rootY = 0.3 * k * hop;
          p.head[2] = 3 * D * k * Math.sin((t / 0.9) * Math.PI * 2) * side;
          return p;
        },
      };
    case 'surprised':
      return {
        duration: 1.0,
        pose: (t) => {
          const p = ZERO_POSE();
          const env = t < 0.12 ? easeOut(t / 0.12) : envelope(t, 1.0, 0, 0.8);
          p.upper[0] = -8 * D * k * env;
          p.head[0] = -5 * D * k * env;
          return p;
        },
      };
    case 'sad':
      return {
        duration: 2.0,
        pose: (t) => {
          const p = ZERO_POSE();
          const env = envelope(t, 2.0, 0.3, 0.5);
          p.head[0] = 12 * D * k * env;
          p.upper[0] = 3 * D * k * env;
          return p;
        },
      };
    case 'angry':
      return {
        duration: 1.0,
        pose: (t) => {
          const p = ZERO_POSE();
          const env = envelope(t, 1.0, 0.15, 0.5);
          p.neck[0] = -6 * D * k * env;
          p.head[2] = 4 * D * k * env * side;
          return p;
        },
      };
    case 'troubled':
    case 'thinking':
      return {
        duration: 1.6,
        pose: (t) => {
          const p = ZERO_POSE();
          const env = envelope(t, 1.6, 0.25, 0.4);
          p.head[2] = 10 * D * k * env * side;
          if (e === 'thinking') p.head[0] = -4 * D * k * env;
          return p;
        },
      };
    case 'shy':
      return {
        duration: 1.8,
        pose: (t) => {
          const p = ZERO_POSE();
          const env = envelope(t, 1.8, 0.2, 0.4);
          p.head[1] = 15 * D * k * env * side;
          p.head[0] = 5 * D * k * env;
          return p;
        },
      };
    default:
      return null;
  }
}

export function touchGesture(part: 'head' | 'body'): Gesture {
  if (part === 'head') {
    return {
      duration: 1.6,
      pose: (t) => {
        const p = ZERO_POSE();
        const env = envelope(t, 1.6, 0.2, 0.4);
        p.head[0] = 8 * D * env;
        p.head[2] = 3 * D * Math.sin(t * 6) * env;
        return p;
      },
    };
  }
  return emotionGesture('surprised', 0.5)!;
}

/** Continuous per-state posture, blended in/out by the controller (spec 3.5 仕草). */
export function statePose(s: CharacterState, time: number, side: 1 | -1): Pose {
  const p = ZERO_POSE();
  switch (s) {
    case 'listening':
      p.head[2] = 6 * D * side;
      // a small nod every 2 s
      p.head[0] = 4 * D * Math.max(0, Math.sin((time % 2) * Math.PI)) * (time % 2 < 1 ? 1 : 0);
      break;
    case 'thinking':
      p.head[0] = -6 * D;
      p.head[2] = 8 * D * side;
      break;
    case 'acting':
      p.head[0] = 14 * D;
      p.neck[0] = 4 * D;
      break;
    case 'awaiting':
      p.head[2] = 9 * D * side;
      p.head[0] = 3 * D;
      break;
    case 'sleeping':
      p.head[0] = 16 * D + 2 * D * Math.sin(time * 0.6);
      p.neck[0] = 4 * D;
      p.upper[0] = 3 * D;
      break;
    default:
      break;
  }
  return p;
}

/** Breathing (≈4 s period) and slow sway (two incommensurate periods), spec 4.3. amp: liveliness scale. */
export function idlePose(time: number, mood: number, amp = 1): Pose {
  const p = ZERO_POSE();
  const breath = Math.sin((time / 4) * Math.PI * 2);
  // breathing grows less than the sway: a big breath looks like gasping
  p.upper[0] = 1.2 * D * breath * Math.sqrt(amp);
  p.rootY = 0.01 * breath * Math.sqrt(amp);
  const swayAmp = (1 + Math.max(0, mood)) * D * amp; // a happier mood sways a bit more
  p.upper[1] = swayAmp * 0.6 * Math.sin(time * 0.37) + swayAmp * 0.4 * Math.sin(time * 0.23 + 1.3);
  p.upper[2] = swayAmp * 0.5 * Math.sin(time * 0.29 + 0.7);
  return p;
}

// ---------------- blinking ----------------

export class Blinker {
  private next: number;
  private start = -1;
  private doubleLeft = 0;
  constructor(
    private readonly rng: () => number = Math.random,
    now = 0,
  ) {
    this.next = now + 2 + rng() * 4;
  }

  /** Returns the blink morph weight 0..1 at time t (seconds). */
  update(t: number, sleepy = 0): number {
    if (this.start < 0 && t >= this.next) {
      this.start = t;
      if (this.doubleLeft === 0 && this.rng() < 0.15) this.doubleLeft = 1;
    }
    if (this.start >= 0) {
      const dt = t - this.start;
      const close = 0.08;
      const open = 0.12 * (1 + sleepy * 3);
      if (dt < close) return dt / close;
      if (dt < close + open) return 1 - (dt - close) / open;
      this.start = -1;
      if (this.doubleLeft > 0) {
        this.doubleLeft--;
        this.next = t + 0.08;
      } else this.next = t + (2 + this.rng() * 4) * (1 - sleepy * 0.5);
    }
    return sleepy * 0.45;
  }
}

// ---------------- gaze ----------------

/** Critically damped spring toward a target (per axis). */
export class Spring2 {
  x = 0;
  y = 0;
  private vx = 0;
  private vy = 0;
  constructor(private readonly omega = 8) {}
  update(tx: number, ty: number, dt: number): void {
    const w = this.omega;
    // implicit Euler step of a critically damped spring (stable for any dt)
    const step = (x: number, v: number, target: number) => {
      const f = 1 + 2 * dt * w;
      const hoo = dt * w * w;
      const hhoo = dt * hoo;
      const inv = 1 / (f + hhoo);
      return [(f * x + dt * v + hhoo * target) * inv, (v + hoo * (target - x)) * inv];
    };
    [this.x, this.vx] = step(this.x, this.vx, tx);
    [this.y, this.vy] = step(this.y, this.vy, ty);
  }
}

export const GAZE_LIMITS = { yaw: 35 * D, pitch: 20 * D };

/** カーソル方向の視線（rad）を上限角度に収める。画面の端でも目が寄りすぎないようにする。縦は横の6割まで。 */
export function limitGaze(yaw: number, pitch: number, limitDeg: number): [number, number] {
  const lim = Math.max(0, limitDeg) * D;
  const py = lim * 0.6;
  return [Math.max(-lim, Math.min(lim, yaw)), Math.max(-py, Math.min(py, pitch))];
}

/** Split a gaze direction (yaw, pitch in radians) into eyes 60% / head 30% / neck 10%, head clamped. */
export function distributeGaze(yaw: number, pitch: number): { eyes: [number, number]; head: [number, number]; neck: [number, number] } {
  const cy = Math.max(-GAZE_LIMITS.yaw / 0.3, Math.min(GAZE_LIMITS.yaw / 0.3, yaw));
  const cp = Math.max(-GAZE_LIMITS.pitch / 0.3, Math.min(GAZE_LIMITS.pitch / 0.3, pitch));
  return {
    eyes: [cy * 0.6, cp * 0.6],
    head: [cy * 0.3, cp * 0.3],
    neck: [cy * 0.1, cp * 0.1],
  };
}

export { bell };

// ---------------- liveliness (動きの活発さ) ----------------

export interface LivelinessProfile {
  /** idle breathing / sway amplitude */
  amp: number;
  /** seconds between idle fidgets [min, max]; null = none */
  fidgetEvery: [number, number] | null;
  /** head bob while speaking (0 = still) */
  speakingBob: number;
  /** scale of the procedural gestures (above 1 goes a bit beyond the spec amplitudes) */
  gestureScale: number;
  /** how often the eyes wander while idle (×) */
  glance: number;
  /** seconds between idle VMDs [min, max] */
  idleVmdEvery: [number, number];
  /** talking gestures: chance to use one whose words matched, and of a small "beat" on other long sentences */
  talkMatch: number;
  talkBeat: number;
}

export const LIVELINESS: Record<Liveliness, LivelinessProfile> = {
  calm: { amp: 0.6, fidgetEvery: null, speakingBob: 0, gestureScale: 0.75, glance: 0.6, idleVmdEvery: [45, 120], talkMatch: 0.5, talkBeat: 0 },
  normal: { amp: 1, fidgetEvery: [40, 90], speakingBob: 0.5, gestureScale: 1, glance: 1, idleVmdEvery: [30, 90], talkMatch: 0.9, talkBeat: 0.3 },
  lively: { amp: 1.7, fidgetEvery: [7, 18], speakingBob: 1, gestureScale: 1.35, glance: 2, idleVmdEvery: [12, 30], talkMatch: 1, talkBeat: 0.65 },
};

/** Curve through [time, value] keys, smoothstepped between keys (0 outside). */
function curve(t: number, keys: readonly (readonly [number, number])[]): number {
  if (t <= keys[0][0] || t >= keys[keys.length - 1][0]) return 0;
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      const x = (t - t0) / (t1 - t0);
      return v0 + (v1 - v0) * x * x * (3 - 2 * x);
    }
  }
  return 0;
}

export type FidgetKind = 'look_around' | 'tilt' | 'stretch' | 'hum' | 'sway' | 'perk';
export const FIDGETS: FidgetKind[] = ['look_around', 'tilt', 'stretch', 'hum', 'sway', 'perk'];

/** Small idle actions so the character doesn't stand like a statue (upper body / neck / head / root only). */
export function fidgetGesture(kind: FidgetKind, scale = 1, side: 1 | -1 = 1): Gesture {
  const k = scale;
  switch (kind) {
    case 'look_around': // glance to one side, then the other
      return {
        duration: 2.8,
        pose: (t) => {
          const p = ZERO_POSE();
          const y = curve(t, [[0, 0], [0.5, 1], [1.1, 1], [1.7, -0.8], [2.2, -0.8], [2.8, 0]]);
          p.head[1] = 16 * D * k * y * side;
          p.neck[1] = 5 * D * k * y * side;
          return p;
        },
      };
    case 'tilt': // a curious head tilt
      return {
        duration: 2.0,
        pose: (t) => {
          const p = ZERO_POSE();
          const env = envelope(t, 2.0, 0.25, 0.35);
          p.head[2] = 12 * D * k * env * side;
          p.upper[2] = 2.5 * D * k * env * side;
          return p;
        },
      };
    case 'stretch': // lean back, look up, rise a little
      return {
        duration: 2.6,
        pose: (t) => {
          const p = ZERO_POSE();
          const env = envelope(t, 2.6, 0.35, 0.4);
          p.upper[0] = -7 * D * k * env;
          p.head[0] = -8 * D * k * env;
          p.rootY = 0.15 * k * env;
          return p;
        },
      };
    case 'hum': // sway to a rhythm only she can hear
      return {
        duration: 2.4,
        pose: (t) => {
          const p = ZERO_POSE();
          const env = envelope(t, 2.4, 0.15, 0.25);
          const beat = Math.sin(t * Math.PI * 2 * 1.25);
          p.head[2] = 6 * D * k * env * beat;
          p.head[0] = 2.5 * D * k * env * Math.abs(beat);
          p.upper[2] = 2 * D * k * env * beat;
          return p;
        },
      };
    case 'sway': // shift the weight from one side to the other
      return {
        duration: 3.2,
        pose: (t) => {
          const p = ZERO_POSE();
          const w = curve(t, [[0, 0], [0.8, 1], [1.6, 1], [2.4, -0.6], [3.2, 0]]);
          p.upper[2] = 4 * D * k * w * side;
          p.head[2] = -2 * D * k * w * side;
          return p;
        },
      };
    case 'perk': // notices something: a small bounce, head up
      return {
        duration: 1.1,
        pose: (t) => {
          const p = ZERO_POSE();
          p.rootY = 0.18 * k * bell(t / 0.45);
          p.head[0] = -5 * D * k * envelope(t, 1.1, 0.12, 0.5);
          return p;
        },
      };
  }
}

/** Gentle head bob while talking (bob 0 = still). Small enough to sit under lip sync and emotion gestures. */
export function speakingPose(time: number, bob: number): Pose {
  const p = ZERO_POSE();
  if (bob <= 0) return p;
  p.head[0] = 2.5 * D * bob * Math.max(0, Math.sin(time * Math.PI * 2 * 1.6));
  p.head[2] = 1.8 * D * bob * Math.sin(time * 1.1);
  p.upper[1] = 1.5 * D * bob * Math.sin(time * 0.9 + 0.5);
  return p;
}

/** Schedules idle fidgets. Postponed while the character is busy, so one never fires right after talking. */
export class Fidgeter {
  private next: number;
  private last: FidgetKind | null = null;
  constructor(
    private readonly rng: () => number = Math.random,
    now = 0,
  ) {
    this.next = now + 10;
  }

  /** eligible: idle, awake, not already moving. Returns a gesture when one is due. */
  update(t: number, profile: LivelinessProfile, eligible: boolean): Gesture | null {
    const range = profile.fidgetEvery;
    if (!range) return null;
    if (!eligible) {
      this.next = Math.max(this.next, t + range[0] * 0.5);
      return null;
    }
    if (t < this.next) return null;
    this.next = t + range[0] + this.rng() * (range[1] - range[0]);
    let kind = FIDGETS[Math.min(FIDGETS.length - 1, Math.floor(this.rng() * FIDGETS.length))];
    if (kind === this.last) kind = FIDGETS[(FIDGETS.indexOf(kind) + 1) % FIDGETS.length]; // no immediate repeats
    this.last = kind;
    return fidgetGesture(kind, profile.gestureScale, this.rng() < 0.5 ? 1 : -1);
  }
}

/** Frame rate while asleep: lower than awake to save power, but not so low that motion (and physics) stutter. */
export function frameRateFor(state: CharacterState, fps: number): number {
  return state === 'sleeping' ? Math.min(fps, 15) : fps;
}

/** Split a frame's time into steps the MMD physics can take in one call (it simulates at most 3 × 1/65 s). */
export function physicsSteps(dt: number, maxStep = 3 / 65): number[] {
  const out: number[] = [];
  let rest = dt;
  while (rest > 1e-6 && out.length < 8) {
    const s = Math.min(rest, maxStep);
    out.push(s);
    rest -= s;
  }
  return out;
}

// ---------------- transitions (補間) ----------------

/** 0→1 with zero speed and zero acceleration at both ends (minimum-jerk curve). */
export function smootherstep(u: number): number {
  const x = Math.min(1, Math.max(0, u));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** a + (b − a)·k */
export function blendPose(a: Pose, b: Pose, k: number): Pose {
  return addPose(a, addPose(b, a, -1), k);
}

/**
 * Cross-fades from one motion source (a function of time) to the next over `dur` seconds on a minimum-jerk
 * curve. The old source keeps running during the fade, so a wave or a breath doesn't freeze half-way. If the
 * source changes again mid-fade, the unfinished fade itself keeps running as the "from" side, so the motion
 * carries its speed into the new fade instead of stopping for a moment.
 */
export class CrossFader<T> {
  private clock = 0;
  private source: () => T;
  private fade: { from: () => T; to: () => T; start: number; dur: number } | null = null;
  constructor(
    private readonly blend: (a: T, b: T, k: number) => T,
    initial: () => T,
  ) {
    this.source = initial;
  }

  switchTo(next: () => T, dur: number): void {
    const f = this.fade;
    let from = this.source;
    if (f && this.clock < f.start + f.dur) {
      const clock = () => this.clock;
      from = () => {
        const u = (clock() - f.start) / f.dur;
        return u >= 1 ? f.to() : this.blend(f.from(), f.to(), smootherstep(u));
      };
    }
    this.fade = { from, to: next, start: this.clock, dur: Math.max(1e-3, dur) };
    this.source = next;
  }

  /** Advance by dt and return what to show. */
  update(dt: number): T {
    this.clock += dt;
    const f = this.fade;
    if (f) {
      const u = (this.clock - f.start) / f.dur;
      if (u < 1) return this.blend(f.from(), f.to(), smootherstep(u));
      this.fade = null;
    }
    return this.source();
  }

  get fading(): boolean {
    return this.fade !== null;
  }
}
