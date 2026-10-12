// Faster replacements for the two syncs three's MMDPhysics does around each simulation step: bones → bodies
// (_updateRigidBodies) and bodies → bones (_updateBones). three converts every transform through Ammo objects:
// transform products that read matrices out of wasm element by element and write the result into a new
// btTransform, about 30 calls across the wasm boundary per body. With ~150 bodies the write-back alone was a
// third of the physics time. Here each transform is read or written once and the rest is three.js math with the
// same formulas. The only difference is that intermediate results are no longer rounded to Bullet's 32-bit
// floats (≈1e-7; the bones agree within 0.001°).
import * as THREE from 'three';

interface BtVector3 {
  x(): number;
  y(): number;
  z(): number;
}
interface BtQuaternion extends BtVector3 {
  w(): number;
}
interface BtTransform {
  getOrigin(): BtVector3;
  getBasis(): { getRotation(q: BtQuaternion): void };
  setOrigin(v: BtVector3): void;
  setRotation(q: BtQuaternion): void;
}
interface BtBody {
  getCenterOfMassTransform(): BtTransform;
  setCenterOfMassTransform(t: BtTransform): void;
  getMotionState(): { getWorldTransform(t: BtTransform): void; setWorldTransform(t: BtTransform): void };
}

/** The parts of three's (untyped) MMDPhysics RigidBody this relies on. */
interface PhysicsBody {
  params: { type: number; boneIndex: number };
  bone: THREE.Bone;
  body: BtBody;
  boneOffsetForm: BtTransform;
  boneOffsetFormInverse: BtTransform;
}

export interface MMDPhysicsLike {
  bodies: PhysicsBody[];
  _updateBones(): void;
  _updateRigidBodies(): void;
}

type AmmoLike = {
  btQuaternion: new (x: number, y: number, z: number, w: number) => BtQuaternion & { setValue(x: number, y: number, z: number, w: number): void };
  btVector3: new (x: number, y: number, z: number) => BtVector3 & { setValue(x: number, y: number, z: number): void };
  btTransform: new () => BtTransform;
};

/** Swap in the fast syncs. Call once per physics instance, after it is created. */
export function installFastBoneSync(physics: MMDPhysicsLike): void {
  const Ammo = (globalThis as unknown as { Ammo: AmmoLike }).Ammo;
  const btQ = new Ammo.btQuaternion(0, 0, 0, 1);
  const btV = new Ammo.btVector3(0, 0, 0);
  const btT = new Ammo.btTransform();
  const readQ = (t: BtTransform, out: THREE.Quaternion) => {
    t.getBasis().getRotation(btQ);
    return out.set(btQ.x(), btQ.y(), btQ.z(), btQ.w());
  };
  const readV = (t: BtTransform, out: THREE.Vector3) => {
    const o = t.getOrigin();
    return out.set(o.x(), o.y(), o.z());
  };
  // the bone ↔ body offsets never change: read them once
  type Offset = { q: THREE.Quaternion; o: THREE.Vector3 };
  const read = (t: BtTransform): Offset => ({ q: readQ(t, new THREE.Quaternion()), o: readV(t, new THREE.Vector3()) });
  const toBone = new Map<PhysicsBody, Offset>(); // body → bone (boneOffsetFormInverse)
  const toBody = new Map<PhysicsBody, Offset>(); // bone → body (boneOffsetForm)
  for (const b of physics.bodies) {
    if (b.params.boneIndex === -1) continue;
    if (b.params.type !== 0) toBone.set(b, read(b.boneOffsetFormInverse));
    if (b.params.type !== 1) toBody.set(b, read(b.boneOffsetForm));
  }
  const boneP = new THREE.Vector3();
  const boneQ = new THREE.Quaternion();
  const boneS = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  /** the body's world transform from its bone's (MMDPhysics RigidBody._getBoneTransform), into btT */
  const bodyFromBone = (b: PhysicsBody, off: Offset, withRotation: boolean) => {
    b.bone.matrixWorld.decompose(boneP, boneQ, boneS);
    const o = boneP.add(tmp.copy(off.o).applyQuaternion(boneQ));
    if (withRotation) {
      const q = boneQ.multiply(off.q);
      btQ.setValue(q.x, q.y, q.z, q.w);
      btT.setRotation(btQ);
    }
    btV.setValue(o.x, o.y, o.z);
    btT.setOrigin(btV);
  };

  // bones → kinematic bodies (_setTransformFromBone)
  physics._updateRigidBodies = () => {
    for (const b of physics.bodies) {
      if (b.params.type !== 0) continue;
      const off = toBody.get(b);
      if (!off) continue;
      bodyFromBone(b, off, true);
      b.body.setCenterOfMassTransform(btT);
      b.body.getMotionState().setWorldTransform(btT);
    }
  };
  const bodyQ = new THREE.Quaternion();
  const bodyO = new THREE.Vector3();
  const worldQ = new THREE.Quaternion();
  const worldO = new THREE.Vector3();
  const q2 = new THREE.Quaternion();
  const q3 = new THREE.Quaternion();

  physics._updateBones = () => {
    for (const b of physics.bodies) {
      const off = toBone.get(b);
      if (!off) continue; // kinematic, or not attached to a bone (RigidBody.updateBone skips these too)
      // bone's world transform = body transform × offset⁻¹ (MMDPhysics._getWorldTransformForBone)
      const t = b.body.getCenterOfMassTransform();
      readQ(t, bodyQ);
      readV(t, bodyO);
      worldQ.multiplyQuaternions(bodyQ, off.q);
      worldO.copy(off.o).applyQuaternion(bodyQ).add(bodyO);
      const bone = b.bone;
      // _updateBoneRotation: local = (boneWorld⁻¹ · bodyWorld) · boneLocal, renormalized
      q2.setFromRotationMatrix(bone.matrixWorld).conjugate().multiply(worldQ);
      q3.setFromRotationMatrix(bone.matrix);
      bone.quaternion.copy(q2.multiply(q3).normalize());
      // _updateBonePosition (dynamic bodies only)
      if (b.params.type === 1) {
        if (bone.parent) bone.parent.worldToLocal(worldO);
        bone.position.copy(worldO);
      }
      bone.updateMatrixWorld(true);
      // _setPositionFromBone: a bone-following body keeps its simulated rotation but moves to the bone
      if (b.params.type === 2) {
        const ms = b.body.getMotionState();
        ms.getWorldTransform(btT);
        bodyFromBone(b, toBody.get(b)!, false);
        b.body.setCenterOfMassTransform(btT);
        ms.setWorldTransform(btT);
      }
    }
  };
}
