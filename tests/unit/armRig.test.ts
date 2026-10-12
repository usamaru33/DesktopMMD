// 身ぶりの腕の解決 (renderer/character/character/armRig.ts) on a synthetic MMD-like skeleton.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ArmRig } from '../../src/renderer/character/character/armRig';
import { mirror, talkPose, TALK_GESTURES, type ArmTarget } from '../../src/renderer/character/character/talkGestures';

/** 上半身 → 右腕/左腕 (A-pose, 40° down) → ひじ → 手捩 → 手首 → 人指/小指, like the real models (no rest rotations). */
function makeMesh(withFingers: boolean): THREE.SkinnedMesh {
  const bones: THREE.Bone[] = [];
  const add = (name: string, parent: THREE.Bone | null, pos: [number, number, number]) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(...pos);
    parent?.add(b);
    bones.push(b);
    return b;
  };
  const upper = add('上半身', null, [0, 13, 0]);
  const dir = new THREE.Vector3(Math.cos((40 * Math.PI) / 180), -Math.sin((40 * Math.PI) / 180), 0);
  for (const [lr, sx] of [['右', -1], ['左', 1]] as const) {
    const d = dir.clone().multiply(new THREE.Vector3(sx, 1, 1));
    const arm = add(`${lr}腕`, upper, [sx * 1.3, 3.4, 0]);
    const elbow = add(`${lr}ひじ`, arm, d.clone().multiplyScalar(2.3).toArray() as [number, number, number]);
    const twist = add(`${lr}手捩`, elbow, d.clone().multiplyScalar(1.2).toArray() as [number, number, number]);
    add(`${lr}手捩1`, elbow, d.clone().multiplyScalar(0.6).toArray() as [number, number, number]);
    const wrist = add(`${lr}手首`, twist, d.clone().multiplyScalar(0.9).toArray() as [number, number, number]);
    if (withFingers) {
      // fingers fan out across the hand; the palm faces down-and-in
      const i1 = add(`${lr}人指１`, wrist, [d.x * 0.5, d.y * 0.5, 0.15]);
      add(`${lr}人指２`, i1, d.clone().multiplyScalar(0.25).toArray() as [number, number, number]);
      const l1 = add(`${lr}小指１`, wrist, [d.x * 0.45, d.y * 0.45, -0.15]);
      add(`${lr}小指２`, l1, d.clone().multiplyScalar(0.2).toArray() as [number, number, number]);
      add(`${lr}親指１`, wrist, [d.x * 0.2, d.y * 0.2, 0.25]);
    }
  }
  const geo = new THREE.BufferGeometry();
  const twistIdx = (lr: string) => bones.findIndex((b) => b.name === `${lr}手捩`);
  const helperIdx = (lr: string) => bones.findIndex((b) => b.name === `${lr}手捩1`);
  geo.userData.MMD = {
    grants: ['右', '左'].map((lr) => ({ index: helperIdx(lr), parentIndex: twistIdx(lr), ratio: 0.5, isLocal: false, affectRotation: true, affectPosition: false })),
  };
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
  mesh.add(bones[0]);
  mesh.bind(new THREE.Skeleton(bones));
  return mesh;
}

const bone = (m: THREE.SkinnedMesh, n: string) => m.skeleton.bones.find((b) => b.name === n)!;
const wpos = (b: THREE.Bone) => b.getWorldPosition(new THREE.Vector3());
const v = (a: readonly number[]) => new THREE.Vector3(a[0], a[1], a[2]).normalize();
const resetAll = (m: THREE.SkinnedMesh) => m.skeleton.bones.forEach((b) => b.quaternion.identity());

function pose(m: THREE.SkinnedMesh, rig: ArmRig, lr: '右' | '左', t: ArmTarget) {
  resetAll(m);
  const side = lr === '右' ? rig.right! : rig.left!;
  rig.apply(side, rig.solve(side, t));
  m.updateMatrixWorld(true);
  const pa = wpos(bone(m, `${lr}腕`));
  const pe = wpos(bone(m, `${lr}ひじ`));
  const pw = wpos(bone(m, `${lr}手首`));
  return { upper: pe.clone().sub(pa).normalize(), fore: pw.clone().sub(pe).normalize(), wrist: pw };
}

describe('ArmRig', () => {
  it('points the upper arm and forearm where every gesture asks, on both sides', () => {
    for (const fingers of [true, false]) {
      const m = makeMesh(fingers);
      const rig = new ArmRig(m);
      expect(rig.right && rig.left).toBeTruthy();
      for (const kind of TALK_GESTURES) {
        for (const tt of [0.2, 0.8]) {
          const p = talkPose(kind, tt);
          for (const [lr, target] of [['右', p.right], ['左', p.left]] as const) {
            if (!target) continue;
            const got = pose(m, rig, lr, target);
            expect(got.upper.angleTo(v(target.upper)), `${kind} ${lr} upper`).toBeLessThan(0.02);
            expect(got.fore.angleTo(v(target.fore)), `${kind} ${lr} fore`).toBeLessThan(0.02);
          }
        }
      }
    }
  });

  it('turns the palm toward the target around the forearm', () => {
    const m = makeMesh(true);
    const rig = new ArmRig(m);
    const t: ArmTarget = { upper: [-0.4, -0.8, 0.4], fore: [-0.4, 0.1, 0.9], palm: [0, 1, 0], curl: 0 };
    resetAll(m);
    const side = rig.right!;
    const sol = rig.solve(side, t);
    rig.apply(side, sol);
    m.updateMatrixWorld(true);
    // palm normal = rest palm normal carried by the wrist's world rotation
    const q = bone(m, '右手首').getWorldQuaternion(new THREE.Quaternion());
    const palm = side.n0.clone().applyQuaternion(q);
    const fore = v(t.fore);
    const want = v(t.palm).addScaledVector(fore, -v(t.palm).dot(fore)).normalize();
    expect(palm.angleTo(want)).toBeLessThan(0.05);
    // the twist helper took its share
    const helper = bone(m, '右手捩1').quaternion;
    expect(helper.angleTo(new THREE.Quaternion())).toBeCloseTo(sol.twist.angleTo(new THREE.Quaternion()) * 0.5, 3);
  });

  it('keeps the hands in front of the body in every gesture', () => {
    const m = makeMesh(true);
    const rig = new ArmRig(m);
    for (const kind of TALK_GESTURES) {
      const p = talkPose(kind, 0.8);
      for (const [lr, target] of [['右', p.right], ['左', p.left]] as const) {
        if (!target) continue;
        const got = pose(m, rig, lr, target);
        expect(got.wrist.z, `${kind} ${lr}`).toBeGreaterThan(0.3);
      }
    }
  });

  it('applies a partial weight while an arm VMD fades (0 = untouched, ½ = half the rotation)', () => {
    const m = makeMesh(true);
    const rig = new ArmRig(m);
    const sol = rig.solve(rig.right!, talkPose('wave', 0.5).right!);
    const arm = bone(m, '右腕');
    resetAll(m);
    rig.apply(rig.right!, sol, 0);
    expect(arm.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
    resetAll(m);
    rig.apply(rig.right!, sol, 0.5);
    expect(arm.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(sol.arm.angleTo(new THREE.Quaternion()) / 2, 5);
  });

  it('mirrors left and right', () => {
    const t = talkPose('present', 1, 1).right!;
    expect(mirror(t).upper[0]).toBe(-t.upper[0]);
    const flipped = talkPose('present', 1, -1);
    expect(flipped.right).toBeNull();
    expect(flipped.left!.upper[0]).toBeCloseTo(-t.upper[0], 10);
  });
});
