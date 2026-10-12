// Turns arm targets (directions in model space) into bone rotations for whatever arm the model has
// (A-pose or T-pose, long or short arms, with or without finger bones). The PMX is only read.
import * as THREE from 'three';
import type { ArmTarget } from './talkGestures';
import { normalizeName } from './morphs';

const Z = new THREE.Vector3(0, 0, 1);
const DOWN = new THREE.Vector3(0, -1, 0);
const D = Math.PI / 180;
/** per-segment bend of a fully curled finger (base, middle, tip) */
const CURL = [70 * D, 85 * D, 55 * D];
const THUMB_CURL = [30 * D, 45 * D];

interface Finger {
  bones: THREE.Bone[];
  /** local rotation axis that curls the finger toward the palm (all segments share the rest frame) */
  axis: THREE.Vector3;
  thumb: boolean;
  index: boolean;
}

interface Side {
  arm: THREE.Bone;
  elbow: THREE.Bone;
  wrist: THREE.Bone | null;
  /** 手捩: carries the forearm twist when present (so the twist helper bones follow) */
  twist: THREE.Bone | null;
  fingers: Finger[];
  u0: THREE.Vector3; // rest shoulder → elbow
  f0: THREE.Vector3; // rest elbow → wrist
  h0: THREE.Vector3; // rest elbow hinge axis (bending around it moves the forearm forward)
  restBend: number;
  n0: THREE.Vector3; // rest palm normal
}

export interface ArmSolution {
  arm: THREE.Quaternion;
  elbow: THREE.Quaternion;
  twist: THREE.Quaternion;
  wrist: THREE.Quaternion;
  /** fingers curl, 0..1 per finger in rig order */
  curls: number[];
}

type Grant = { index: number; parentIndex: number; ratio: number; affectRotation: boolean; isLocal: boolean };

export class ArmRig {
  readonly right: Side | null;
  readonly left: Side | null;
  private readonly grants: Grant[];
  private readonly bones: THREE.Bone[];

  /**
   * Build from the skeleton in its bind pose (call right after loading, before any animation).
   * Returns sides as null when the model lacks 腕/ひじ.
   */
  constructor(mesh: THREE.SkinnedMesh) {
    this.bones = mesh.skeleton.bones;
    const byName = new Map<string, THREE.Bone>();
    for (const b of this.bones) if (!byName.has(normalizeName(b.name))) byName.set(normalizeName(b.name), b);
    const find = (...names: string[]) => {
      for (const n of names) {
        const b = byName.get(normalizeName(n));
        if (b) return b;
      }
      return null;
    };
    // rest positions in model space: MMD bones have no rest rotation, so positions just add up
    const restPos = (b: THREE.Bone) => {
      const v = new THREE.Vector3();
      for (let o: THREE.Object3D | null = b; o && (o as THREE.Bone).isBone; o = o.parent) v.add(o.position);
      return v;
    };
    const build = (lr: '右' | '左'): Side | null => {
      const arm = find(`${lr}腕`);
      const elbow = find(`${lr}ひじ`, `${lr}肘`);
      const wrist = find(`${lr}手首`);
      if (!arm || !elbow) return null;
      const pa = restPos(arm);
      const pe = restPos(elbow);
      const pw = wrist ? restPos(wrist) : pe.clone().add(pe.clone().sub(pa));
      const u0 = pe.clone().sub(pa).normalize();
      const f0 = pw.clone().sub(pe).normalize();
      const h0 = u0.clone().cross(Z).normalize();
      const restBend = signedAngle(u0, f0, h0);
      const fingers: Finger[] = [];
      // palm normal: perpendicular to the forearm, facing down (A/T pose), refined by the finger fan if there is one
      let n0 = DOWN.clone().addScaledVector(f0, -DOWN.dot(f0)).normalize();
      const seg = (name: string, from: number) => {
        const out: THREE.Bone[] = [];
        for (let i = from; i <= 3; i++) {
          const b = find(`${lr}${name}${i}`, `${lr}${name}${String.fromCharCode(0xff10 + i)}`);
          if (b) out.push(b);
        }
        return out;
      };
      const index = seg('人指', 1).length ? seg('人指', 1) : seg('人差指', 1);
      const little = seg('小指', 1);
      if (wrist && index.length && little.length) {
        const across = restPos(index[0]).sub(restPos(little[0]));
        const n = f0.clone().cross(across).normalize();
        if (n.lengthSq() > 0.5) n0 = n.dot(n0) >= 0 ? n : n.negate();
      }
      for (const [name, isIndex] of [['人指', true], ['人差指', true], ['中指', false], ['薬指', false], ['小指', false]] as const) {
        const bones = seg(name, 1);
        if (!bones.length || (name === '人差指' && fingers.some((f) => f.index))) continue;
        const dir = bones.length > 1 ? restPos(bones[1]).sub(restPos(bones[0])).normalize() : f0.clone();
        fingers.push({ bones, axis: dir.clone().cross(n0).normalize(), thumb: false, index: isIndex });
      }
      const thumb = seg('親指', 1);
      if (thumb.length) {
        const dir = thumb.length > 1 ? restPos(thumb[1]).sub(restPos(thumb[0])).normalize() : f0.clone();
        fingers.push({ bones: thumb, axis: dir.clone().cross(n0).normalize(), thumb: true, index: false });
      }
      return { arm, elbow, wrist, twist: find(`${lr}手捩`), fingers, u0, f0, h0, restBend, n0 };
    };
    this.right = build('右');
    this.left = build('左');
    this.grants = ((mesh.geometry.userData as { MMD?: { grants?: Grant[] } }).MMD?.grants ?? []).filter((g) => g.affectRotation && !g.isLocal);
  }

  /**
   * Local rotations that point the upper arm along `t.upper` and the forearm along `t.fore`, bending only
   * at the elbow's hinge, then turn the forearm so the palm faces `t.palm` as well as it can.
   */
  solve(side: Side, t: ArmTarget): ArmSolution {
    const U = vec(t.upper);
    let F = vec(t.fore);
    // the elbow only bends one way and not past ~150°
    let bend = Math.acos(THREE.MathUtils.clamp(U.dot(F), -1, 1));
    if (bend > 150 * D) {
      F = rotateToward(U, F, 150 * D);
      bend = 150 * D;
    }
    let H: THREE.Vector3;
    if (bend < 4 * D) {
      H = side.h0.clone().applyQuaternion(new THREE.Quaternion().setFromUnitVectors(side.u0, U));
    } else H = U.clone().cross(F).normalize();
    const arm = basisQuat(U, H).multiply(basisQuat(side.u0, side.h0).invert());
    const elbow = new THREE.Quaternion().setFromAxisAngle(side.h0, bend - side.restBend);
    // palm: where it ends up without a twist, measured around the forearm
    const chain = arm.clone().multiply(elbow);
    const fore = side.f0.clone().applyQuaternion(chain);
    const cur = side.n0.clone().applyQuaternion(chain);
    const want = vec(t.palm);
    const twistAngle = signedAngle(flatten(cur, fore), flatten(want, fore), fore);
    const twist = new THREE.Quaternion().setFromAxisAngle(side.f0, Number.isFinite(twistAngle) ? twistAngle : 0);
    const flexAxis = side.f0.clone().cross(side.n0).normalize();
    const wrist = new THREE.Quaternion().setFromAxisAngle(flexAxis, t.wrist ?? 0);
    const curls = side.fingers.map((f) => (f.thumb ? t.thumb ?? t.curl : f.index ? t.index ?? t.curl : t.curl));
    return { arm, elbow, twist, wrist, curls };
  }

  /** The relaxed arm as a target (the old fixed pose: lowered from the bind pose, elbow slightly bent). */
  relaxed(side: Side, sign: 1 | -1, armDown: number, breathe: number, curl: number): ArmTarget {
    const arm = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, sign * (armDown - breathe), 'YXZ'));
    const chain = arm.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, sign * 0.18, 0, 'YXZ')));
    const arr = (x: THREE.Vector3): [number, number, number] => [x.x, x.y, x.z];
    return {
      upper: arr(side.u0.clone().applyQuaternion(arm)),
      fore: arr(side.f0.clone().applyQuaternion(chain)),
      palm: arr(side.n0.clone().applyQuaternion(chain)),
      curl,
    };
  }

  /**
   * Write a solution onto the bones (after the mixer and the grant solver have run). `weight` < 1 while an
   * arm VMD fades in or out: the VMD then holds the rest of the pose, so the hand-over has no jump.
   */
  apply(side: Side, sol: ArmSolution, weight = 1): void {
    const w = THREE.MathUtils.clamp(weight, 0, 1);
    if (w <= 0) return;
    const part = (q: THREE.Quaternion) => (w >= 1 ? q : new THREE.Quaternion().slerp(q, w));
    const s: ArmSolution = { arm: part(sol.arm), elbow: part(sol.elbow), twist: part(sol.twist), wrist: part(sol.wrist), curls: sol.curls.map((c) => c * w) };
    side.arm.quaternion.multiply(s.arm);
    side.elbow.quaternion.multiply(s.elbow);
    const twistBone = side.twist ?? side.wrist;
    twistBone?.quaternion.multiply(s.twist);
    side.wrist?.quaternion.multiply(s.wrist);
    side.fingers.forEach((f, i) => {
      const c = THREE.MathUtils.clamp(s.curls[i], 0, 1);
      const per = f.thumb ? THUMB_CURL : CURL;
      f.bones.forEach((b, j) => b.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(f.axis, c * per[Math.min(j, per.length - 1)])));
    });
    // twist helper bones (手捩1..3 etc.) took their share of 手捩 before our rotation: give them the rest
    if (side.twist) {
      const ti = this.bones.indexOf(side.twist);
      for (const g of this.grants) {
        if (g.parentIndex !== ti) continue;
        this.bones[g.index].quaternion.multiply(new THREE.Quaternion().slerp(s.twist, g.ratio));
      }
    }
  }

  /** Every bone this rig writes (the controller resets them to rest each frame). */
  managedBones(): THREE.Bone[] {
    const out: THREE.Bone[] = [];
    for (const s of [this.right, this.left]) {
      if (!s) continue;
      out.push(s.arm, s.elbow);
      if (s.wrist) out.push(s.wrist);
      if (s.twist) out.push(s.twist);
      for (const f of s.fingers) out.push(...f.bones);
    }
    return out;
  }
}

function vec(v: readonly [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(v[0], v[1], v[2]).normalize();
}

/** Rotation taking the standard basis to (a, b, a×b); a and b must be orthonormal. */
function basisQuat(a: THREE.Vector3, b: THREE.Vector3): THREE.Quaternion {
  const c = a.clone().cross(b);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(a, b, c));
}

/** Angle from a to b around axis (both projected onto the plane ⟂ axis). */
function signedAngle(a: THREE.Vector3, b: THREE.Vector3, axis: THREE.Vector3): number {
  const pa = flatten(a, axis);
  const pb = flatten(b, axis);
  if (pa.lengthSq() < 1e-8 || pb.lengthSq() < 1e-8) return 0;
  return Math.atan2(pa.clone().cross(pb).dot(axis), pa.dot(pb));
}

function flatten(v: THREE.Vector3, axis: THREE.Vector3): THREE.Vector3 {
  const n = axis.clone().normalize();
  return v.clone().addScaledVector(n, -v.dot(n));
}

/** Rotate `from` toward `to` by exactly `angle`. */
function rotateToward(from: THREE.Vector3, to: THREE.Vector3, angle: number): THREE.Vector3 {
  const axis = from.clone().cross(to).normalize();
  return from.clone().applyAxisAngle(axis, angle);
}
