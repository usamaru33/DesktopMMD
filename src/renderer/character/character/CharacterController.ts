// Draws the character and composes the four expression layers: idle → state gesture → emotion → lip sync
// (spec 4, skill mmd-character-expression). The PMX is only read, never modified.
import * as THREE from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { MMDAnimationHelper } from 'three/examples/jsm/animation/MMDAnimationHelper.js';
import { GAZE_LIMIT_DEFAULT } from '@shared/defaults';
import type { Emotion } from '@shared/emotions';
import type { CharacterLoadPayload } from '@shared/ipc';
import type { CharacterState, Liveliness, TouchPart } from '@shared/types';
import type { MouthWeights } from '../lipsync';
import { ArmRig } from './armRig';
import { FallbackAvatar } from './FallbackAvatar';
import { installFastBoneSync, type MMDPhysicsLike } from './physicsSync';
import { classifyTouch, faceUnit, type ScreenPt, sideOf, type TouchPoints } from './touchZones';
import { loadVmdClips, VmdLayer } from './vmdLayer';
import { type FacePart, faceLevel, PART_WEIGHT, resolveFace, type ResolvedFace, normalizeName } from './morphs';
import {
  addPose, Blinker, blendPose, CrossFader, distributeGaze, emotionGesture, Fidgeter, frameRateFor, type Gesture, idlePose, limitGaze, LIVELINESS,
  type LivelinessProfile, patPose, physicsSteps, smootherstep, type Pose, speakingPose, Spring2, statePose, touchGesture, ZERO_POSE,
} from './motion';
import { blendLayer, chooseTalkGesture, HOLD, type TalkGestureKind, type TalkLayer, talkPose } from './talkGestures';

const ZERO_MOUTH: MouthWeights = { a: 0, i: 0, u: 0, e: 0, o: 0 };

interface ManagedBone {
  bone: THREE.Bone;
  rest: THREE.Quaternion;
}

interface TalkGesture {
  kind: TalkGestureKind;
  start: number;
  side: 1 | -1;
  until: number;
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
  private bones: Partial<Record<'upper' | 'neck' | 'head' | 'eyeL' | 'eyeR', ManagedBone>> = {};
  private modelHeight = 20;
  private vmd: VmdLayer | null = null;
  private physicsOn = true;
  /** radians to rotate 腕 down from the bind pose (character.json could override later) */
  private armDown = THREE.MathUtils.degToRad(42);

  // layers
  private state: CharacterState = 'idle';
  /** the state posture (thinking, listening…) cross-fades when the state changes */
  private stateSrc: { s: CharacterState; side: 1 | -1 } = { s: 'idle', side: 1 };
  private readonly stateFade = new CrossFader<Pose>(blendPose, () => statePose('idle', this.time, 1));
  /** 0..1: how much of the talking head bob shows (eases in and out with the speaking state) */
  private speakAmt = 0;
  /** bones used only to tell where a click landed (hands, shoulders, waist) */
  private touchBones: { hands: [THREE.Bone, THREE.Bone | null][]; shoulders: THREE.Bone[]; hips: THREE.Bone | null } = { hands: [], shoulders: [], hips: null };
  /** being stroked on the head (PatDetector in main.ts) */
  private patting = false;
  /** 0..1: how much the "being patted" posture shows */
  private patAmt = 0;
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
  private stage = 0;
  private live: LivelinessProfile = LIVELINESS.normal;
  private readonly fidgeter = new Fidgeter();
  // talking gestures (身ぶり)
  private rig: ArmRig | null = null;
  private rigBones: THREE.Bone[] = [];
  private rigRest = new Map<THREE.Bone, THREE.Quaternion>();
  private talkG: TalkGesture | null = null;
  /** the gesture the talk layer currently shows (changes → cross-fade) */
  private talkSrc: TalkGesture | null = null;
  private readonly talkFade = new CrossFader<TalkLayer>(blendLayer, () => this.talkLayer(null));
  private breathe = 0;
  private lastTalk: TalkGestureKind | null = null;
  private firstPerson = '';

  // loop
  private fps = 30;
  private lastFrame = 0;
  private hidden = false;
  private loop: ((now: number) => void) | null = null;
  private raf = 0;
  private pickReq: { x: number; y: number; cb: (hit: boolean) => void } | null = null;
  private readonly pixel = new Uint8Array(4);
  /** the canvas fills the window (CSS px); kept from resize() instead of asking the layout every frame */
  private viewSize = { width: 1, height: 1 };
  private time = 0;

  constructor(canvas: HTMLCanvasElement) {
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
    this.firstPerson = p.preset.firstPerson ?? '';
    this.physicsOn = physics;
    if (!p.modelUrl) {
      this.useFallback();
      return { modelLoaded: false, found: [], missing: [], error: 'モデルが設定されていません' };
    }
    try {
      // the physics engine (wasm) compiles while the model downloads and parses
      const ammo = physics ? ensureAmmo() : null;
      ammo?.catch(() => undefined); // a failure is reported by the await below, not as an unhandled rejection
      const loader = new MMDLoader();
      // PMX texture paths use backslashes
      loader.manager.setURLModifier((u) => u.replace(/\\/g, '/'));
      const mesh = await loader.loadAsync(p.modelUrl);
      const motions = loadVmdClips(loader, mesh, p.motionUrls);
      if (ammo) await ammo;
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
      };
      const bone = (name: string) => mesh.skeleton.bones.find((b) => b.name === name) ?? null;
      this.touchBones = {
        // [wrist, elbow]: the palm is past the wrist, along the forearm
        hands: (['左', '右'] as const).flatMap((s) => {
          const w = bone(`${s}手首`);
          return w ? [[w, bone(`${s}ひじ`)] as [THREE.Bone, THREE.Bone | null]] : [];
        }),
        shoulders: ['左腕', '右腕'].map(bone).filter((b): b is THREE.Bone => !!b),
        hips: bone('下半身'),
      };
      this.rig = new ArmRig(mesh);
      this.rigBones = this.rig.managedBones();
      this.rigRest = new Map(this.rigBones.map((b) => [b, b.quaternion.clone()]));

      // fit the camera to the bind-pose bounding box
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox!;
      this.modelHeight = Math.max(1, box.max.y - box.min.y);
      this.fitCamera(box.min.y, box.max.y);

      this.helper = new MMDAnimationHelper({ afterglow: 2.0 });
      this.helper.add(mesh, { animation: [], physics });
      // physics is stepped manually after our additive bone rotations (see update())
      this.helper.enable('physics', false);
      const physicsObj = (this.helper as unknown as { objects: WeakMap<object, { physics?: MMDPhysicsLike }> }).objects.get(mesh)?.physics;
      if (physicsObj) installFastBoneSync(physicsObj);

      const mixer = (this.helper as unknown as { objects: WeakMap<object, { mixer?: THREE.AnimationMixer }> }).objects.get(mesh)?.mixer;
      const clips = await motions;
      if (mixer) this.vmd = new VmdLayer(mixer, clips);
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
    this.touchBones = { hands: [], shoulders: [], hips: null };
    this.rig = null;
    this.rigBones = [];
    this.rigRest.clear();
    this.talkG = null;
    this.talkSrc = null;
    this.vmd = null;
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
    this.viewSize = { width: w, height: h };
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.fitCamera(this.fitBox.minY, this.fitBox.maxY);
  }

  // ---------------- inputs ----------------

  /** Hidden windows draw nothing: stop the loop (physics included) until shown again. */
  setVisible(v: boolean): void {
    if (this.hidden === !v) return;
    this.hidden = !v;
    if (!v) {
      // even an empty requestAnimationFrame callback keeps the renderer and the GPU process waking 60×/s
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.pickReq?.cb(false);
      this.pickReq = null;
    } else if (this.loop) {
      this.clock.getDelta(); // don't count the hidden time as one long frame
      this.raf = requestAnimationFrame(this.loop);
    }
  }

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

  /** 動きの活発さ（呼吸・揺れ、手持ちぶさたの仕草、話しながらのうなずき、感情の仕草の大きさ） */
  setLiveliness(l: Liveliness): void {
    this.live = LIVELINESS[l] ?? LIVELINESS.normal;
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
    if (this.vmd?.hasEmotion(e)) {
      this.vmd.playEmotion(e);
      // lively: add a smaller procedural gesture on top of the VMD (the VMD only moves upper body / neck / head)
      if (this.live.gestureScale > 1) {
        const extra = emotionGesture(e, k * (this.live.gestureScale - 1) * 1.5, Math.random() < 0.5 ? 1 : -1);
        if (extra) this.gestures.push({ g: extra, t: 0 });
      }
      return;
    }
    const g = emotionGesture(e, k * this.live.gestureScale, Math.random() < 0.5 ? 1 : -1);
    if (g) this.gestures.push({ g, t: 0 });
  }

  /**
   * A sentence started (its audio began, or it was shown without voice): pick a gesture from its words.
   * The gesture is held while the sentence plays (at most HOLD[kind]) and released by endTalk().
   */
  talk(text: string, emotion: Emotion): void {
    if (this.state === 'sleeping' || this.sleepy >= 0.6) return;
    const kind = chooseTalkGesture(text, emotion, {
      firstPerson: this.firstPerson,
      beatChance: this.live.talkBeat,
      matchChance: this.live.talkMatch,
      last: this.lastTalk,
    });
    this.lastTalk = kind;
    if (!kind) {
      this.talkG = null;
      return;
    }
    // keep the same hand for back-to-back gestures; otherwise mostly the right hand
    const side = this.talkG ? this.talkG.side : Math.random() < 0.75 ? 1 : -1;
    this.talkG = { kind, start: this.time, side, until: this.time + HOLD[kind] };
  }

  /** The sentence finished: let the arms come back down shortly after. */
  endTalk(): void {
    if (this.talkG) this.talkG.until = Math.min(this.talkG.until, this.time + 0.35);
  }

  /** Where a click at window CSS px (x, y) landed, and on which side of the body. */
  touchPartAt(x: number, y: number): { part: TouchPart; side: 1 | -1 } {
    const pts = this.touchPoints();
    const p = { x, y };
    return { part: classifyTouch(p, pts, faceUnit(pts, this.viewSize.height)), side: sideOf(p, pts) };
  }

  private touchPoints(): TouchPoints {
    const screen = (o: THREE.Object3D): ScreenPt => this.toScreen(o.getWorldPosition(new THREE.Vector3()));
    const { eyeL, eyeR, neck } = this.bones;
    let face = this.headScreenPos();
    if (eyeL && eyeR) {
      const a = screen(eyeL.bone);
      const b = screen(eyeR.bone);
      face = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    return {
      face,
      neck: neck ? screen(neck.bone) : null,
      hands: this.touchBones.hands.map(([w, e]) => {
        const a = screen(w);
        if (!e) return a;
        const b = screen(e);
        return { x: a.x + (a.x - b.x) * 0.45, y: a.y + (a.y - b.y) * 0.45 };
      }),
      shoulders: this.touchBones.shoulders.map(screen),
      hips: this.touchBones.hips ? screen(this.touchBones.hips) : null,
    };
  }

  /** A click on the model: a quick reaction right away (the line, if any, comes from main a moment later). */
  touch(part: TouchPart, side: 1 | -1 = 1): void {
    if (this.state === 'sleeping') return;
    this.gestures.push({ g: touchGesture(part, side), t: 0 });
    const react: Record<TouchPart, [Emotion, number, number]> = {
      // being patted on the head: eyes close happily, a bit shy at low affinity
      head: [this.stage === 0 ? 'shy' : 'happy', 0.7, 1.5],
      cheek: ['shy', 0.6, 1.5],
      hand: ['happy', 0.6, 1.5],
      shoulder: ['surprised', 0.4, 1.0],
      body: ['surprised', 0.5, 1.0],
      legs: ['shy', 0.8, 1.8],
    };
    const [emo, k, hold] = react[part];
    this.setEmotion(emo, k);
    this.emoHoldUntil = this.time + hold;
    // a hand that was touched waves back a little
    if (part === 'hand' && this.state === 'idle' && this.rig) this.talkG = { kind: 'wave', start: this.time, side, until: this.time + 1.6 };
  }

  /** Being stroked on the head (true while it lasts). */
  pat(on: boolean): void {
    if (on === this.patting || (on && this.state === 'sleeping')) return;
    this.patting = on;
    if (on) {
      this.setEmotion('happy', 0.85);
      this.emoHoldUntil = Number.POSITIVE_INFINITY;
    } else this.emoHoldUntil = this.time + 1.2;
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

  /** The talk layer for a gesture (null = relaxed arms, no body offset). */
  private talkLayer(g: TalkGesture | null): TalkLayer {
    const breathe = this.breathe;
    const p = g ? talkPose(g.kind, this.time - g.start, g.side, this.live.gestureScale) : null;
    const out: TalkLayer = { body: p?.body ?? ZERO_POSE() };
    if (this.rig) {
      if (this.rig.right) out.right = p?.right ?? this.rig.relaxed(this.rig.right, 1, this.armDown, breathe, 0.2);
      if (this.rig.left) out.left = p?.left ?? this.rig.relaxed(this.rig.left, -1, this.armDown, breathe, 0.2);
    }
    return out;
  }

  /** Screen position (CSS px, window-local) of the head, for bubble placement and head/body hit tests. */
  headScreenPos(): { x: number; y: number } {
    const v = new THREE.Vector3();
    if (this.bones.head) this.bones.head.bone.getWorldPosition(v);
    else v.set(0, this.fitBox.minY + this.modelHeight * 0.88, 0);
    return this.toScreen(v);
  }

  private toScreen(world: THREE.Vector3): ScreenPt {
    const v = world.project(this.camera);
    const r = this.viewSize;
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height };
  }

  /** Pixel-accurate hit test against the rendered model (alpha at the mouse), resolved after the next render. */
  pick(x: number, y: number): Promise<boolean> {
    if (this.hidden) return Promise.resolve(false);
    return new Promise((cb) => {
      this.pickReq = { x, y, cb };
    });
  }

  // ---------------- loop ----------------

  start(): void {
    const loop = (now: number) => {
      if (this.hidden) return;
      this.raf = requestAnimationFrame(loop);
      const minDt = 1000 / frameRateFor(this.state, this.fps);
      if (now - this.lastFrame < minDt - 1) {
        if (this.pickReq) this.renderFrame(0); // answer hit tests promptly
        return;
      }
      this.lastFrame = now;
      const dt = Math.min(0.1, this.clock.getDelta());
      this.renderFrame(dt);
    };
    this.loop = loop;
    if (!this.hidden) this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.loop = null;
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
    let pose = idlePose(t, this.mood, this.live.amp);
    this.speakAmt = Math.min(1, Math.max(0, this.speakAmt + (this.state === 'speaking' ? dt : -dt) / 0.4));
    if (this.speakAmt > 0) pose = addPose(pose, speakingPose(t, this.live.speakingBob), smootherstep(this.speakAmt));
    if (this.state !== this.stateSrc.s || this.side !== this.stateSrc.side) {
      const slow = this.stateSrc.s === 'sleeping' || this.state === 'sleeping';
      const { state: s, side } = this;
      this.stateFade.switchTo(() => statePose(s, this.time, side), slow ? 1.2 : 0.45);
      this.stateSrc = { s, side };
    }
    pose = addPose(pose, this.stateFade.update(dt));
    // idle fidgets (look around, tilt, stretch…): only while idle, awake and not already moving
    const fidget = this.fidgeter.update(t, this.live, this.state === 'idle' && this.sleepy < 0.3 && this.gestures.length === 0 && e.level < 0.05);
    if (fidget) this.gestures.push({ g: fidget, t: 0 });
    this.gestures = this.gestures.filter((g) => (g.t += dt) < g.g.duration);
    for (const g of this.gestures) pose = addPose(pose, g.g.pose(g.t));
    // talking gesture: body part here, the arms below (after the mixer). Gesture changes cross-fade.
    this.breathe = Math.sin((t / 4) * Math.PI * 2) * 0.01;
    if (this.talkG && (t > this.talkG.until || this.state === 'sleeping')) this.talkG = null;
    if (this.talkG !== this.talkSrc) {
      const g = this.talkG;
      this.talkFade.switchTo(() => this.talkLayer(g), g ? (this.talkSrc ? 0.4 : 0.35) : 0.55);
      this.talkSrc = g;
    }
    const talk = this.talkFade.update(dt);
    pose = addPose(pose, talk.body);
    if (this.sleepy > 0 && this.state !== 'sleeping') {
      pose.head[0] += 0.12 * this.sleepy * (0.6 + 0.4 * Math.sin(t * 0.8));
    }
    this.patAmt = Math.min(1, Math.max(0, this.patAmt + (this.patting ? dt / 0.5 : -dt / 0.7)));
    if (this.patAmt > 0) pose = addPose(pose, patPose(t), smootherstep(this.patAmt));

    // ---- gaze ----
    let gx = 0;
    let gy = 0;
    const lookCamera = this.state === 'speaking' || this.state === 'awaiting' || this.gazeTarget === 'camera';
    if (this.state === 'thinking') gy = 0.35;
    else if (this.state === 'acting') gy = -0.35;
    else if (this.state === 'sleeping') gy = -0.2;
    else if (!lookCamera && this.gazeTarget !== 'camera') {
      const head = this.headScreenPos();
      const r = this.viewSize;
      const dx = (this.gazeTarget.x - head.x) / Math.max(200, r.width * 1.5);
      const dy = (head.y - this.gazeTarget.y) / Math.max(200, r.height);
      [gx, gy] = limitGaze(Math.atan(dx * 1.6), Math.atan(dy * 1.2), this.gazeLimit);
      // cursor resting for 3 s → relax and sometimes glance away
      if (t - this.gazeIdleSince > 3) {
        gx *= 0.5;
        gy *= 0.5;
        if (t > this.lookAway.until && Math.random() < dt * 0.15 * this.live.glance) this.lookAway = { until: t + 1.2, x: (Math.random() - 0.5) * 0.8, y: (Math.random() - 0.3) * 0.4 };
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
    for (const [b, q] of this.rigRest) b.quaternion.copy(q);
    this.vmd?.startPending();
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
    applyEmotion(e.prev, faceLevel(e.prevLevel));
    applyEmotion(e.cur, faceLevel(e.level));
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
    // and while talking, the gesture's arms. An arm VMD takes over in proportion to its fade weight.
    this.vmd?.fadeOutEnding();
    const ours = 1 - (this.vmd?.armWeight() ?? 0);
    if (this.rig && ours > 0) {
      for (const name of ['right', 'left'] as const) {
        const side = this.rig[name];
        const target = talk[name];
        if (side && target) this.rig.apply(side, this.rig.solve(side, target), ours);
      }
    }
    this.mesh.position.y = pose.rootY * (this.modelHeight / 20);

    this.vmd?.maybePlayIdle(t, this.state === 'idle', this.live.idleVmdEvery);

    this.mesh.updateMatrixWorld(true);
    if (this.physicsOn) {
      const obj = (this.helper as unknown as { objects: WeakMap<object, { physics?: { update(dt: number): void } }> }).objects.get(this.mesh);
      // at low frame rates one frame is longer than the physics can simulate in one call (≤3 × 1/65 s):
      // step in pieces so hair and skirts keep up with the body instead of lagging and snapping
      for (const step of physicsSteps(dt)) obj?.physics?.update(step);
    }
  }

  dispose(): void {
    this.stop();
    this.unload();
    this.renderer.dispose();
  }
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
