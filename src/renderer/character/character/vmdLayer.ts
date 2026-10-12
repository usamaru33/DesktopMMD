// VMD playback for the character (emotion and idle motions): loading, starting, handing over and fading out.
// Every VMD plays once and is blended in and out; nothing snaps (see DEVELOPMENT.md「モーション同士のつなぎ」).
import * as THREE from 'three';
import type { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import type { Emotion } from '@shared/emotions';
import type { CharacterLoadPayload } from '@shared/ipc';

const LOWER_BODY = /(センター|グルーブ|全ての親|下半身|足|ひざ|つま先|腰|操作中心)/;
const ARM_TRACK = /\.bones\[(左|右)腕\]/;
/** how long before its end a VMD starts fading out */
const END_FADE = 0.4;

export interface VmdClips {
  /** two copies per emotion, so the same VMD can start again while the previous run is fading out */
  emotions: Partial<Record<Emotion, [THREE.AnimationClip, THREE.AnimationClip]>>;
  idle: THREE.AnimationClip[];
}

/** Load every VMD at once (fetching them one after another was slower). A VMD that fails to load is skipped. */
export async function loadVmdClips(loader: MMDLoader, mesh: THREE.SkinnedMesh, urls: CharacterLoadPayload['motionUrls']): Promise<VmdClips> {
  const load = (url: string) =>
    new Promise<THREE.AnimationClip | null>((resolve) =>
      loader.loadAnimation(url, mesh, (c) => resolve(upperBodyOnly(c as THREE.AnimationClip)), undefined, () => resolve(null)),
    );
  const emotions = Object.entries(urls.emotions).filter((e): e is [string, string] => !!e[1]);
  const [emoClips, idleClips] = await Promise.all([Promise.all(emotions.map(([, url]) => load(url))), Promise.all(urls.idle.map(load))]);
  const out: VmdClips['emotions'] = {};
  emotions.forEach(([emo], i) => {
    const clip = emoClips[i];
    if (clip) out[emo as Emotion] = [clip, clip.clone()];
  });
  return { emotions: out, idle: idleClips.filter((c): c is THREE.AnimationClip => !!c) };
}

/** Keep only upper-body bone tracks (spec 4.2: so the standing position never drifts). */
function upperBodyOnly(clip: THREE.AnimationClip): THREE.AnimationClip {
  const tracks = clip.tracks.filter((tr) => {
    const m = /^\.bones\[(.+?)\]\./.exec(tr.name);
    return !!m && !LOWER_BODY.test(m[1]);
  });
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

export class VmdLayer {
  /** VMD actions already fading out */
  private readonly ending = new WeakSet<THREE.AnimationAction>();
  private readonly armClip = new WeakMap<THREE.AnimationClip, boolean>();
  private pending: (() => void)[] = [];
  private nextIdle = 30;

  constructor(
    private readonly mixer: THREE.AnimationMixer,
    private readonly clips: VmdClips,
  ) {}

  hasEmotion(e: Emotion): boolean {
    return !!this.clips.emotions[e];
  }

  /** Start the emotion's VMD; whatever emotion VMD was playing hands over (fades out) instead of being cut. */
  playEmotion(e: Emotion): void {
    const pair = this.clips.emotions[e];
    if (!pair) return;
    // restarting a running action would jump it back to its first frame: use the idle copy instead
    const clip = this.mixer.existingAction(pair[0])?.isRunning() ? pair[1] : pair[0];
    for (const other of Object.values(this.clips.emotions).flat()) {
      const o = other && other !== clip ? this.mixer.existingAction(other) : null;
      if (o?.isRunning() && !this.ending.has(o)) {
        o.fadeOut(0.3);
        this.ending.add(o);
      }
    }
    this.playOnce(this.mixer.clipAction(clip), 0.25);
  }

  /** An idle VMD every `every` seconds (spec 4.3), while `idle`. */
  maybePlayIdle(time: number, idle: boolean, every: [number, number]): void {
    if (!idle || !this.clips.idle.length || time <= this.nextIdle) return;
    const [lo, hi] = every;
    this.nextIdle = time + lo + Math.random() * (hi - lo);
    const clip = this.clips.idle[Math.floor(Math.random() * this.clips.idle.length)];
    this.playOnce(this.mixer.clipAction(clip), 0.5);
  }

  /**
   * Start the VMDs requested since the last frame. Call while the bones are at rest, before the mixer runs:
   * when an action becomes active, three.js saves the bones' current rotation as the "original" it blends from
   * during the fade-in. Saved mid-frame it would contain last frame's gaze / sway / arm pose, and those would be
   * added twice for a moment (a jump).
   */
  startPending(): void {
    for (const play of this.pending.splice(0)) play();
  }

  /** After the mixer ran: a one-shot VMD that just stopped would snap the bones back, so fade it out first. */
  fadeOutEnding(): void {
    for (const a of this.actions()) {
      if (!a.isRunning() || this.ending.has(a)) continue;
      const left = a.getClip().duration - a.time;
      if (left <= END_FADE) {
        a.fadeOut(Math.max(0.15, left));
        this.ending.add(a);
      }
    }
  }

  /** How much of the arms the VMDs hold right now (0..1, follows their fade in / out). */
  armWeight(): number {
    let w = 0;
    for (const a of this.actions()) {
      if (!a.isRunning()) continue;
      const clip = a.getClip();
      let arms = this.armClip.get(clip);
      if (arms === undefined) {
        arms = clip.tracks.some((tr) => ARM_TRACK.test(tr.name));
        this.armClip.set(clip, arms);
      }
      if (arms) w += a.getEffectiveWeight();
    }
    return Math.min(1, w);
  }

  /** Play once: fade in, hold the last frame, fade out before the end (fadeOutEnding). Starts next frame. */
  private playOnce(a: THREE.AnimationAction, fadeIn: number): void {
    this.pending.push(() => {
      this.ending.delete(a);
      a.reset();
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.setEffectiveWeight(1);
      a.fadeIn(fadeIn).play();
    });
  }

  private actions(): THREE.AnimationAction[] {
    return (this.mixer as unknown as { _actions: THREE.AnimationAction[] })._actions ?? [];
  }
}
