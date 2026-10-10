// Draws the character and composes the four expression layers: idle → state gesture → emotion → lip sync
// (spec 4, skill mmd-character-expression). The PMX is only read, never modified.
import * as THREE from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { MMDAnimationHelper } from 'three/examples/jsm/animation/MMDAnimationHelper.js';
import { GAZE_LIMIT_DEFAULT } from '@shared/defaults';
import type { Emotion } from '@shared/emotions';
import type { CharacterLoadPayload } from '@shared/ipc';
import type { CharacterState } from '@shared/types';
import type { MouthWeights } from '../lipsync';
import { FallbackAvatar } from './FallbackAvatar';
import { type FacePart, PART_WEIGHT, resolveFace, type ResolvedFace, normalizeName } from './morphs';
import {
  addPose, Blinker, distributeGaze, emotionGesture, type Gesture, idlePose, limitGaze, type Pose, Spring2, statePose, touchGesture, ZERO_POSE,
} from './motion';

const ZERO_MOUTH: MouthWeights = { a: 0, i: 0, u: 0, e: 0, o: 0 };
const LOWER_BODY = /(センター|グルーブ|全ての親|下半身|足|ひざ|つま先|腰|操作中心)/;

interface ManagedBone {
  bone: THREE.Bone;
  rest: THREE.Quaternion;
}

interface ActiveGesture {
  g: Gesture;
  t: number;
}

declare global {
  // provided by public/ammo.wasm.js
  // eslint-disable-next-line no-var
  var Ammo: ((cfg?: unknown) => Promise<unknown>) | unknown;
}

export interface LoadResult {
  modelLoaded: boolean;
  found: string[];
  missing: string[];
  error?: string;
}

export class CharacterController {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 2000);
  private readonly clock = new THREE.Clock();
  private mesh: THREE.SkinnedMesh | null = null;
  private helper: MMDAnimationHelper | null = null;
  private fallback: FallbackAvatar | null = null;
  private face: ResolvedFace | null = null;
  private bones: Partial<Record<'upper' | 'neck' | 'head' | 'eyeL' | 'eyeR' | 'armL' | 'armR' | 'elbowL' | 'elbowR', ManagedBone>> = {};
  private rootRestY = 0;
  private modelHeight = 20;
  private emotionClips: Partial<Record<Emotion, THREE.AnimationClip>> = {};
  private idleClips: THREE.AnimationClip[] = [];
  private physicsOn = true;
  /** radians to rotate 腕 down from the bind pose (character.json could override later) */
  private armDown = THREE.MathUtils.degToRad(42);

  // layers
  private state: CharacterState = 'idle';
  private statePoseCur: Pose = ZERO_POSE();
  private emo: { cur: Emotion; level: number; target: number; prev: Emotion; prevLevel: number } = { cur: 'neutral', level: 0, target: 0, prev: 'neutral', prevLevel: 0 };
  private emoHoldUntil = 0;
  private gestures: ActiveGesture[] = [];
  private mouthSource: (() => MouthWeights) | null = null;
  private blinker = new Blinker();
  private mood = 0;
  private sleepy = 0;
  private side: 1 | -1 = 1;
  private gaze = new Spring2(8);
  private gazeTarget: { x: number; y: number } | 'camera' = 'camera';
  private gazeIdleSince = 0;
  private gazeLimit = GAZE_LIMIT_DEFAULT;
  private lastCursor = { x: 0, y: 0 };
  private lookAway = { until: 0, x: 0, y: 0 };
  private nextIdleMotion = 30;
  private stage = 0;

  // loop
  private fps = 30;
  private lastFrame = 0;
  private raf = 0;
  private pickReq: { x: number; y: number; cb: (hit: boolean) => void } | null = null;
  private readonly pixel = new Uint8Array(4);
  private time = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'low-power' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const ambient = new THREE.AmbientLight(0xaaaaaa, 2.6);
    const dir = new THREE.DirectionalLight(0xffffff, 2.6);
    dir.position.set(-1, 1, 1).normalize();
    this.scene.add(ambient, dir);
    this.resize(window.innerWidth, window.innerHeight);
  }

  // ---------------- loading ----------------

  async load(p: CharacterLoadPayload, physics: boolean): Promise<LoadResult> {
    this.unload();
    this.stage = p.affinityStage;
    this.physicsOn = physics;
    if (!p.modelUrl) {
      this.useFallback();
      return { modelLoaded: false, found: [], missing: [], error: 'モデルが設定されていません' };
    }
    try {
      if (physics) await ensureAmmo();
      const loader = new MMDLoader();
      // PMX texture paths use backslashes
      loader.manager.setURLModifier((u) => u.replace(/\\/g, '/'));
      const mesh = await loader.loadAsync(p.modelUrl);
      mesh.castShadow = false;
      this.mesh = mesh;
      this.scene.add(mesh);

      this.face = resolveFace(mesh.morphTargetDictionary ?? {}, p.preset.morphMap);
      const find = (...names: string[]) => {
        for (const n of names) {
          const b = mesh.skeleton.bones.find((x) => x.name === n) ?? mesh.skeleton.bones.find((x) => normalizeName(x.name) === normalizeName(n));
          if (b) return { bone: b, rest: b.quaternion.clone() };
        }
        return undefined;
      };
      this.bones = {
        upper: find('上半身'), neck: find('首'), head: find('頭'), eyeL: find('左目'), eyeR: find('右目'),
        armL: find('左腕'), armR: find('右腕'), elbowL: find('左ひじ'), elbowR: find('右ひじ'),
      };
      const center = find('センター');
      this.rootRestY = center ? center.bone.position.y : 0;

      // fit the camera to the bind-pose bounding box
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox!;
      this.modelHeight = Math.max(1, box.max.y - box.min.y);
      this.fitCamera(box.min.y, box.max.y);

      this.helper = new MMDAnimationHelper({ afterglow: 2.0 });
      this.helper.add(mesh, { animation: [], physics });
      // physics is stepped manually after our additive bone rotations (see update())
      this.helper.enable('physics', false);

      await this.loadMotions(loader, p);
      const missing = [...this.face.missing];
      for (const k of ['upper', 'neck', 'head'] as const) if (!this.bones[k]) missing.push(`bone.${k}`);
      return { modelLoaded: true, found: this.face.found, missing };
    } catch (e) {
      console.error('model load failed', e);
      this.unload();
      this.useFallback();
      return { modelLoaded: false, found: [], missing: [], error: String((e as Error)?.message ?? e) };
    }
  }

  private async loadMotions(loader: MMDLoader, p: CharacterLoadPayload): Promise<void> {
    const mesh = this.mesh!;
    const load = (url: string) =>
      new Promise<THREE.AnimationClip | null>((resolve) =>
        loader.loadAnimation(url, mesh, (c) => resolve(upperBodyOnly(c as THREE.AnimationClip)), undefined, () => resolve(null)),
      );
    for (const [emo, url] of Object.entries(p.motionUrls.emotions)) {
      if (!url) continue;
      const clip = await load(url);
      if (clip) this.emotionClips[emo as Emotion] = clip;
    }
    for (const url of p.motionUrls.idle) {
      const clip = await load(url);
      if (clip) this.idleClips.push(clip);
    }
  }

  private useFallback(): void {
    this.fallback = new FallbackAvatar();
    this.scene.add(this.fallback.root);
    this.modelHeight = this.fallback.height;
    this.fitCamera(0, this.fallback.height);
  }

  private unload(): void {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      for (const m of [this.mesh.material].flat()) {
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
        m.dispose();
      }
    }
    if (this.fallback) this.scene.remove(this.fallback.root);
    this.mesh = null;
    this.fallback = null;
    this.helper = null;
    this.face = null;
    this.bones = {};
    this.emotionClips = {};
    this.idleClips = [];
  }

  private fitBox = { minY: 0, maxY: 20 };

  private fitCamera(minY: number, maxY: number): void {
    this.fitBox = { minY, maxY };
    const h = maxY - minY;
    const aspect = this.camera.aspect;
    // leave ~14% on top for the status icons and the bubble's tail
    const visibleH = h * 1.16;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    let dist = visibleH / 2 / Math.tan(fov / 2);
    // make sure the width (arms, skirt) fits too
    const neededW = h * 0.62;
    const hfov = 2 * Math.atan(Math.tan(fov / 2) * aspect);
    dist = Math.max(dist, neededW / 2 / Math.tan(hfov / 2));
    const cy = minY + visibleH / 2 - h * 0.02;
    this.camera.position.set(0, cy, dist);
    this.camera.lookAt(0, cy, 0);
    this.camera.near = dist / 20;
    this.camera.far = dist * 5;
    this.camera.updateProjectionMatrix();
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.fitCamera(this.fitBox.minY, this.fitBox.maxY);
  }

  // ---------------- inputs ----------------

  setFps(fps: number): void {
    this.fps = fps;
  }

  /** 視線の上限角度（度） */
  setGazeLimit(deg: number): void {
    this.gazeLimit = deg;
  }

  setPhysics(on: boolean): void {
    this.physicsOn = on;
  }

  setStage(stage: number): void {
    this.stage = stage;
  }

  setMood(m: number): void {
    this.mood = m;
  }

  setSleepy(s: number): void {
    this.sleepy = Math.max(0, Math.min(1, s));
  }

  setState(s: CharacterState): void {
    if (s === this.state) return;
    const prev = this.state;
    this.state = s;
    if (s === 'listening' || s === 'thinking' || s === 'awaiting') this.side = Math.random() < 0.5 ? 1 : -1;
    // spec 4.1: after speaking, fade back to neutral over 3 s
    if (prev === 'speaking' && s !== 'speaking') {
      this.emoHoldUntil = this.time + 0.5;
      this.emo.target = 0;
    }
  }

  /** A new sentence started with this emotion (spec 4.1: 0.25 s rise, linear blend between sentences). */
  setEmotion(e: Emotion, intensity: number): void {
    let k = intensity;
    if (this.stage >= 2 && e === 'happy') k = Math.min(1, k * 1.2);
    if (e !== this.emo.cur) {
      this.emo.prev = this.emo.cur;
      this.emo.prevLevel = this.emo.level;
      this.emo.cur = e;
      this.emo.level = 0;
      this.playEmotionMotion(e, k);
    }
    this.emo.target = e === 'neutral' ? 0 : k;
    this.emoHoldUntil = Number.POSITIVE_INFINITY;
  }

  private playEmotionMotion(e: Emotion, k: number): void {
    const clip = this.emotionClips[e];
    const mixer = this.mixer();
    if (clip && mixer) {
      const a = mixer.clipAction(clip);
      a.reset();
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = false;
      a.setEffectiveWeight(1);
      a.fadeIn(0.25).play();
      return;
    }
    const g = emotionGesture(e, k, Math.random() < 0.5 ? 1 : -1);
    if (g) this.gestures.push({ g, t: 0 });
  }

  touch(part: 'head' | 'body'): void {
    this.gestures.push({ g: touchGesture(part), t: 0 });
    if (part === 'head') {
      // being patted: eyes close happily, a bit shy at low affinity
      this.setEmotion(this.stage === 0 ? 'shy' : 'happy', 0.7);
      this.emoHoldUntil = this.time + 1.5;
    } else {
      this.setEmotion('surprised', 0.5);
      this.emoHoldUntil = this.time + 1.0;
    }
  }

  setMouthSource(fn: (() => MouthWeights) | null): void {
    this.mouthSource = fn;
  }

  /** Cursor in window-local CSS pixels, or 'camera' to look at the user. */
  lookAt(target: { x: number; y: number } | 'camera'): void {
    if (target !== 'camera' && (Math.abs(target.x - this.lastCursor.x) > 2 || Math.abs(target.y - this.lastCursor.y) > 2)) {
      this.gazeIdleSince = this.time;
      this.lastCursor = { ...target };
    }
    this.gazeTarget = target;
  }

  /** true while a running action has tracks for the arm bones */
  private armsAnimated(): boolean {
    const mixer = this.mixer();
    if (!mixer) return false;
    const actions = (mixer as unknown as { _actions: THREE.AnimationAction[] })._actions ?? [];
    return actions.some((a) => a.isRunning() && a.getClip().tracks.some((tr) => /\.bones\[(左|右)腕\]/.test(tr.name)));
  }

  private mixer(): THREE.AnimationMixer | null {
    if (!this.helper || !this.mesh) return null;
    const obj = (this.helper as unknown as { objects: WeakMap<object, { mixer?: THREE.AnimationMixer }> }).objects.get(this.mesh);
    return obj?.mixer ?? null;
  }

  /** Screen position (CSS px, window-local) of the head, for bubble placement and head/body hit tests. */
  headScreenPos(): { x: number; y: number } {
    const v = new THREE.Vector3();
    if (this.bones.head) this.bones.head.bone.getWorldPosition(v);
    else v.set(0, this.fitBox.minY + this.modelHeight * 0.88, 0);
    v.project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height };
  }

  /** Pixel-accurate hit test against the rendered model (alpha at the mouse), resolved after the next render. */
  pick(x: number, y: number): Promise<boolean> {
    return new Promise((cb) => {
      this.pickReq = { x, y, cb };
    });
  }

  // ---------------- loop ----------------

  start(): void {
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const minDt = 1000 / (this.state === 'sleeping' ? 5 : this.fps);
      if (now - this.lastFrame < minDt - 1) {
        if (this.pickReq) this.renderFrame(0); // answer hit tests promptly
        return;
      }
      this.lastFrame = now;
      const dt = Math.min(0.1, this.clock.getDelta());
      this.renderFrame(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  private renderFrame(dt: number): void {
    if (dt > 0) this.update(dt);
    this.renderer.render(this.scene, this.camera);
    if (this.pickReq) {
      const { x, y, cb } = this.pickReq;
      this.pickReq = null;
      const gl = this.renderer.getContext();
      const pr = this.renderer.getPixelRatio();
      const px = Math.floor(x * pr);
      const py = Math.floor(gl.drawingBufferHeight - y * pr);
      if (px < 0 || py < 0 || px >= gl.drawingBufferWidth || py >= gl.drawingBufferHeight) cb(false);
      else {
        gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel);
        cb(this.pixel[3] > 24);
      }
    }
  }

  private update(dt: number): void {
    this.time += dt;
    const t = this.time;

    // ---- emotion level (rise 0.25 s; fall over 3 s after the hold ends) ----
    const e = this.emo;
    if (t > this.emoHoldUntil) e.target = 0;
    const rate = e.level < e.target ? dt / 0.25 : dt / 3;
    e.level = e.level < e.target ? Math.min(e.target, e.level + rate) : Math.max(e.target, e.level - rate * Math.max(0.3, e.level));
    e.prevLevel = Math.max(0, e.prevLevel - dt / 0.25);
    if (e.level === 0 && e.target === 0 && e.cur !== 'neutral' && t > this.emoHoldUntil) e.cur = 'neutral';

    // ---- pose: idle + state + gestures ----
    let pose = idlePose(t, this.mood);
    const target = statePose(this.state, t, this.side);
    const k = 1 - Math.exp(-dt * 6);
    this.statePoseCur = addPose(this.statePoseCur, addPose(target, this.statePoseCur, -1), k);
    pose = addPose(pose, this.statePoseCur);
    this.gestures = this.gestures.filter((g) => (g.t += dt) < g.g.duration);
    for (const g of this.gestures) pose = addPose(pose, g.g.pose(g.t));
    if (this.sleepy > 0 && this.state !== 'sleeping') {
      pose.head[0] += 0.12 * this.sleepy * (0.6 + 0.4 * Math.sin(t * 0.8));
    }

    // ---- gaze ----
    let gx = 0;
    let gy = 0;
    const lookCamera = this.state === 'speaking' || this.state === 'awaiting' || this.gazeTarget === 'camera';
    if (this.state === 'thinking') gy = 0.35;
    else if (this.state === 'acting') gy = -0.35;
    else if (this.state === 'sleeping') gy = -0.2;
    else if (!lookCamera && this.gazeTarget !== 'camera') {
      const head = this.headScreenPos();
      const r = this.canvas.getBoundingClientRect();
      const dx = (this.gazeTarget.x - head.x) / Math.max(200, r.width * 1.5);
      const dy = (head.y - this.gazeTarget.y) / Math.max(200, r.height);
      [gx, gy] = limitGaze(Math.atan(dx * 1.6), Math.atan(dy * 1.2), this.gazeLimit);
      // cursor resting for 3 s → relax and sometimes glance away
      if (t - this.gazeIdleSince > 3) {
        gx *= 0.5;
        gy *= 0.5;
        if (t > this.lookAway.until && Math.random() < dt * 0.15) this.lookAway = { until: t + 1.2, x: (Math.random() - 0.5) * 0.8, y: (Math.random() - 0.3) * 0.4 };
      }
    }
    if (t < this.lookAway.until && this.state === 'idle') {
      gx = this.lookAway.x;
      gy = this.lookAway.y;
    }
    if (this.stage === 0 && this.state === 'idle' && Math.random() < dt * 0.05) this.lookAway = { until: t + 0.8, x: (Math.random() - 0.5) * 0.9, y: -0.15 };
    this.gaze.update(gx, gy, dt);
    const gz = distributeGaze(this.gaze.x, this.gaze.y);

    // ---- face ----
    const blink = this.state === 'sleeping' || this.sleepy >= 1 ? 1 : this.blinker.update(t, this.sleepy);
    const mouth = this.mouthSource?.() ?? ZERO_MOUTH;
    const speaking = this.state === 'speaking' || Object.values(mouth).some((v) => v > 0.01);
    // mood lifts the resting face a little (spec 4.1)
    const baseline = this.state === 'idle' && e.cur === 'neutral' && this.mood > 0.3 ? (this.mood - 0.3) * 0.3 : 0;

    if (this.fallback) {
      this.fallback.apply({
        pose: addPose(pose, { upper: [0, 0, 0], neck: [-gz.neck[1], gz.neck[0], 0], head: [-gz.head[1], gz.head[0], 0], rootY: 0 }),
        blink,
        mouth,
        emotion: e.cur === 'neutral' && baseline > 0 ? 'happy' : e.cur,
        emotionWeight: Math.max(e.level, baseline),
        eyeYaw: gz.eyes[0],
        eyePitch: gz.eyes[1],
      });
      return;
    }
    if (!this.mesh || !this.helper || !this.face) return;

    // reset managed bones to rest before the mixer runs
    for (const b of Object.values(this.bones)) if (b) b.bone.quaternion.copy(b.rest);
    this.helper.update(dt);

    const infl = this.mesh.morphTargetInfluences!;
    const touched = new Set<number>();
    const set = (idx: number | undefined, v: number) => {
      if (idx === undefined) return;
      infl[idx] = touched.has(idx) ? Math.min(1, Math.max(infl[idx], v)) : Math.min(1, Math.max(0, v));
      touched.add(idx);
    };
    // clear everything we drive
    const f = this.face;
    for (const parts of Object.values(f.emotions)) for (const idx of Object.values(parts ?? {})) if (idx !== undefined) infl[idx] = 0;
    for (const idx of Object.values(f.vowels)) if (idx !== undefined) infl[idx] = 0;
    if (f.blink !== null) infl[f.blink] = 0;

    const applyEmotion = (emo: Emotion, level: number) => {
      if (emo === 'neutral' || level <= 0) return;
      const parts = f.emotions[emo] ?? {};
      for (const [part, idx] of Object.entries(parts) as [FacePart, number][]) {
        let w = level * PART_WEIGHT[part];
        if (part === 'mouth' && speaking) w *= 0.5;
        if (part === 'eye') w *= 1 - blink;
        set(idx, w);
      }
    };
    applyEmotion(e.prev, e.prevLevel);
    applyEmotion(e.cur, e.level);
    if (baseline > 0) applyEmotion('happy', baseline);
    if (this.state === 'thinking') set(f.emotions.thinking?.brow, 0.5);
    for (const [v, idx] of Object.entries(f.vowels) as [keyof MouthWeights, number][]) set(idx, mouth[v]);
    if (f.blink !== null) set(f.blink, blink);

    // additive bones on top of whatever the mixer produced
    const rot = (mb: ManagedBone | undefined, x: number, y: number, z: number) => {
      if (!mb) return;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));
      mb.bone.quaternion.multiply(q);
    };
    rot(this.bones.upper, pose.upper[0], pose.upper[1], pose.upper[2]);
    rot(this.bones.neck, pose.neck[0] - gz.neck[1], pose.neck[1] + gz.neck[0], pose.neck[2]);
    rot(this.bones.head, pose.head[0] - gz.head[1], pose.head[1] + gz.head[0], pose.head[2]);
    rot(this.bones.eyeL, -gz.eyes[1] * 0.5, gz.eyes[0] * 0.5, 0);
    rot(this.bones.eyeR, -gz.eyes[1] * 0.5, gz.eyes[0] * 0.5, 0);
    // PMX bind pose is a T/A-pose: lower the arms into a relaxed stance unless a VMD drives them
    if (!this.armsAnimated()) {
      const breathe = Math.sin((t / 4) * Math.PI * 2) * 0.01;
      rot(this.bones.armL, 0, 0, -this.armDown + breathe);
      rot(this.bones.armR, 0, 0, this.armDown - breathe);
      rot(this.bones.elbowL, 0, -0.18, 0);
      rot(this.bones.elbowR, 0, 0.18, 0);
    }
    this.mesh.position.y = pose.rootY * (this.modelHeight / 20);

    // idle VMD every 30–90 s (spec 4.3)
    if (this.state === 'idle' && this.idleClips.length && t > this.nextIdleMotion) {
      this.nextIdleMotion = t + 30 + Math.random() * 60;
      const mixer = this.mixer();
      if (mixer) {
        const clip = this.idleClips[Math.floor(Math.random() * this.idleClips.length)];
        const a = mixer.clipAction(clip);
        a.reset().setLoop(THREE.LoopOnce, 1).fadeIn(0.5).play();
      }
    }

    this.mesh.updateMatrixWorld(true);
    if (this.physicsOn) {
      const obj = (this.helper as unknown as { objects: WeakMap<object, { physics?: { update(dt: number): void } }> }).objects.get(this.mesh);
      obj?.physics?.update(dt);
    }
  }

  dispose(): void {
    this.stop();
    this.unload();
    this.renderer.dispose();
  }
}

/** Keep only upper-body bone tracks (spec 4.2: so the standing position never drifts). */
function upperBodyOnly(clip: THREE.AnimationClip): THREE.AnimationClip {
  const tracks = clip.tracks.filter((tr) => {
    const m = /^\.bones\[(.+?)\]\./.exec(tr.name);
    return !!m && !LOWER_BODY.test(m[1]);
  });
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

let ammoPromise: Promise<void> | null = null;

/** Load three r170's bundled ammo.wasm.js once (copied to public/ by scripts/copy-ammo.mjs). */
function ensureAmmo(): Promise<void> {
  if (ammoPromise) return ammoPromise;
  ammoPromise = new Promise((resolve, reject) => {
    if (typeof (globalThis as { Ammo?: unknown }).Ammo === 'object') return resolve();
    const s = document.createElement('script');
    s.src = '../ammo.wasm.js';
    s.onload = async () => {
      try {
        const factory = (globalThis as { Ammo?: (cfg?: unknown) => Promise<unknown> }).Ammo!;
        const inst = await factory({ locateFile: (f: string) => `../${f}` });
        (globalThis as { Ammo?: unknown }).Ammo = inst;
        resolve();
      } catch (e) {
        reject(e);
      }
    };
    s.onerror = () => reject(new Error('ammo.wasm.js not found'));
    document.head.appendChild(s);
  });
  return ammoPromise;
}
