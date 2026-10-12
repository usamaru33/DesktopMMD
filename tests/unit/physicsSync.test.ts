// physicsSync.ts: the fast bone write-back must move the bones like three's MMDPhysics does, on a real Ammo
// (Bullet) world with hair-like chains, bodies listed child-first, a bone without a body mid-chain, and all
// three body types.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as THREE from 'three';
import { MMDPhysics } from 'three/examples/jsm/animation/MMDPhysics.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { installFastBoneSync, type MMDPhysicsLike } from '../../src/renderer/character/character/physicsSync';

const require = createRequire(import.meta.url);
const libs = path.resolve('node_modules/three/examples/jsm/libs');

beforeAll(async () => {
  // three's bundled ammo.wasm.js is an Emscripten script that defines a global `Ammo` factory
  const src = fs.readFileSync(path.join(libs, 'ammo.wasm.js'), 'utf8');
  const factory = new Function('module', 'exports', 'require', '__dirname', '__filename', `${src}\n;return Ammo;`)(
    { exports: {} }, {}, require, libs, path.join(libs, 'ammo.wasm.js'),
  ) as (o: object) => Promise<unknown>;
  (globalThis as { Ammo?: unknown }).Ammo = await factory({ wasmBinary: fs.readFileSync(path.join(libs, 'ammo.wasm.wasm')) });
}, 30_000);

/** head (kinematic) → 2 strands of 4 bones; strand A has a body-less bone mid-chain and lists bodies tip-first. */
function makeRig() {
  const bones: THREE.Bone[] = [];
  const bone = (name: string, parent: THREE.Bone | null, pos: [number, number, number]) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(...pos);
    parent?.add(b);
    bones.push(b);
    return b;
  };
  const root = bone('頭', null, [0, 10, 0]);
  const strand = (sx: number, prefix: string) => {
    let p = root;
    const out: THREE.Bone[] = [];
    for (let i = 0; i < 4; i++) {
      p = bone(`${prefix}${i}`, p, i === 0 ? [sx, 0, -0.5] : [sx * 0.2, -1, -0.1]);
      out.push(p);
    }
    return out;
  };
  const a = strand(1, 'A');
  const b = strand(-1, 'B');
  const idx = (x: THREE.Bone) => bones.indexOf(x);
  const world = (x: THREE.Bone) => {
    x.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixPosition(x.matrixWorld);
  };
  const body = (name: string, x: THREE.Bone, type: number) => {
    const p = world(x);
    return {
      name, boneIndex: idx(x), groupIndex: type === 0 ? 0 : 1, groupTarget: 0xffff & ~(1 << 1) /* strands don't hit each other */,
      shapeType: type === 0 ? 0 : 1, width: 0.3, height: 0.8, depth: 0.3,
      position: [p.x, p.y, p.z], rotation: [0.1, 0.2, 0.3],
      weight: type === 0 ? 0 : 1, positionDamping: 0.5, rotationDamping: 0.5, restitution: 0, friction: 0.5, type,
    };
  };
  const rigid = [
    body('root', root, 0), // 0
    body('A3', a[3], 1), // 1  strand A tip-first, A1 has no body
    body('A2', a[2], 2), // 2
    body('A0', a[0], 1), // 3
    body('B0', b[0], 2), // 4  strand B in order, mixed types
    body('B1', b[1], 1), // 5
    body('B2', b[2], 1), // 6
    body('B3', b[3], 2), // 7
  ];
  const joint = (i1: number, i2: number) => {
    const p = new THREE.Vector3().fromArray(rigid[i1].position).add(new THREE.Vector3().fromArray(rigid[i2].position)).multiplyScalar(0.5);
    return {
      name: `${i1}-${i2}`, rigidBodyIndex1: i1, rigidBodyIndex2: i2, position: p.toArray(), rotation: [0, 0, 0],
      translationLimitation1: [0, 0, 0], translationLimitation2: [0, 0, 0],
      rotationLimitation1: [-0.6, -0.6, -0.6], rotationLimitation2: [0.6, 0.6, 0.6],
      springPosition: [0, 0, 0], springRotation: [5, 5, 5],
    };
  };
  const constraints = [joint(0, 3), joint(3, 2), joint(2, 1), joint(0, 4), joint(4, 5), joint(5, 6), joint(6, 7)];
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.add(root);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.updateMatrixWorld(true);
  return { mesh, bones, rigid, constraints };
}

interface PhysicsInternals {
  _updateRigidBodies(): void;
  _stepSimulation(dt: number): void;
  _updateBones(): void;
}

describe('installFastBoneSync', () => {
  it('syncs bones and bodies like three does, step after step', () => {
    // A swinging chain is chaotic: two runs that differ in the 7th digit drift apart after a few seconds whatever
    // the cause. So compare the two write-backs on the same simulated state at every step, then continue.
    const r = makeRig();
    const phys = new MMDPhysics(r.mesh, r.rigid, r.constraints) as unknown as PhysicsInternals;
    const original = phys._updateBones.bind(phys);
    installFastBoneSync(phys as unknown as MMDPhysicsLike);
    const fast = phys._updateBones;
    const originalPre = (phys as unknown as { bodies: { updateFromBone(): void }[] }).bodies;
    const fastPre = phys._updateRigidBodies;
    // the write-back also moves bone-following bodies (type 2) to their bone: save / restore those too
    type Bt = { getOrigin(): { x(): number; y(): number; z(): number }; getRotation(): { x(): number; y(): number; z(): number; w(): number } };
    type BtBody = { getCenterOfMassTransform(): Bt; setCenterOfMassTransform(t: unknown): void; getMotionState(): { getWorldTransform(t: unknown): void; setWorldTransform(t: unknown): void } };
    const A = (globalThis as unknown as { Ammo: { btTransform: new () => Bt & { setOrigin(v: unknown): void; setRotation(q: unknown): void }; btVector3: new (x: number, y: number, z: number) => unknown; btQuaternion: new (x: number, y: number, z: number, w: number) => unknown } }).Ammo;
    const bodies = (phys as unknown as { bodies: { body: BtBody }[] }).bodies.map((b) => b.body);
    const copyOf = (t: Bt) => {
      const o = t.getOrigin();
      const q = t.getRotation();
      const c = new A.btTransform();
      c.setOrigin(new A.btVector3(o.x(), o.y(), o.z()));
      c.setRotation(new A.btQuaternion(q.x(), q.y(), q.z(), q.w()));
      return c;
    };
    const snap = () => ({
      bones: r.bones.map((b) => ({ q: b.quaternion.clone(), p: b.position.clone() })),
      bodies: bodies.map((b) => {
        const ms = new A.btTransform();
        b.getMotionState().getWorldTransform(ms);
        return { com: copyOf(b.getCenterOfMassTransform()), ms: copyOf(ms) };
      }),
    });
    const restore = (s: ReturnType<typeof snap>) => {
      r.bones.forEach((b, i) => {
        b.quaternion.copy(s.bones[i].q);
        b.position.copy(s.bones[i].p);
      });
      bodies.forEach((b, i) => {
        b.setCenterOfMassTransform(s.bodies[i].com);
        b.getMotionState().setWorldTransform(s.bodies[i].ms);
      });
      r.mesh.updateMatrixWorld(true);
    };
    const tip = () => r.bones.find((b) => b.name === 'A3')!.getWorldPosition(new THREE.Vector3());
    const start = tip();
    let worst = 0;
    let worstBody = 0;
    // ammo.js returns getRotation() results in one shared temporary: copy to numbers before the next call
    const vals = (t: Bt) => {
      const o = t.getOrigin();
      const oa = [o.x(), o.y(), o.z()];
      const q = t.getRotation();
      return { o: oa, q: [q.x(), q.y(), q.z(), q.w()] };
    };
    const bodyDiff = (x: ReturnType<typeof snap>, y: ReturnType<typeof snap>) => {
      let m = 0;
      x.bodies.forEach((bx, i) => {
        for (const k of ['com', 'ms'] as const) {
          const a = vals(bx[k]);
          const b = vals(y.bodies[i][k]);
          m = Math.max(m, Math.hypot(a.o[0] - b.o[0], a.o[1] - b.o[1], a.o[2] - b.o[2]));
          // compare components (q and −q are the same rotation): acos-based angles blow 32-bit noise up to ~1e-4
          const sign = a.q.reduce((acc, v, j) => acc + v * b.q[j], 0) < 0 ? -1 : 1;
          for (let j = 0; j < 4; j++) m = Math.max(m, Math.abs(a.q[j] - sign * b.q[j]));
        }
      });
      return m;
    };
    for (let f = 0; f < 240; f++) {
      // swing the head (kinematic root) like a nod and a turn
      r.bones[0].quaternion.setFromEuler(new THREE.Euler(0.5 * Math.sin(f * 0.15), 0.8 * Math.sin(f * 0.07), 0));
      r.mesh.updateMatrixWorld(true);
      // bones → kinematic bodies
      const pre = snap();
      fastPre();
      const preFast = snap();
      restore(pre);
      for (const b of originalPre) b.updateFromBone();
      worstBody = Math.max(worstBody, bodyDiff(snap(), preFast));
      phys._stepSimulation(1 / 60);
      // bodies → bones (and bone-following bodies → their bones' positions)
      const before = snap();
      fast();
      const viaFast = snap();
      const worldFast = r.bones.map((b) => b.matrixWorld.clone());
      restore(before);
      original();
      r.bones.forEach((b, i) => {
        worst = Math.max(worst, b.quaternion.angleTo(viaFast.bones[i].q), b.position.distanceTo(viaFast.bones[i].p));
        for (let k = 0; k < 16; k++) worst = Math.max(worst, Math.abs(b.matrixWorld.elements[k] - worldFast[i].elements[k]));
      });
      worstBody = Math.max(worstBody, bodyDiff(snap(), viaFast));
    }
    expect(tip().distanceTo(start)).toBeGreaterThan(0.5); // the hair really swung
    // the original rounds an intermediate transform to 32-bit floats; that's all that may differ
    // (≈1e-7 typically, ≈2e-5 rad = 0.001° at worst while the chain whips around)
    expect(worst).toBeLessThan(1e-4);
    expect(worstBody).toBeLessThan(1e-4);
  });
});
