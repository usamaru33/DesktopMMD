// Shown when no PMX is configured or loading failed: a small procedural figure that supports the same
// face/pose inputs, so the rest of the app (lip sync, emotions, gaze) keeps working (skill §1).
import * as THREE from 'three';
import type { Emotion } from '@shared/emotions';
import type { MouthWeights } from '../lipsync';
import type { Pose } from './motion';

export class FallbackAvatar {
  readonly root = new THREE.Group();
  private readonly upper = new THREE.Group();
  private readonly neck = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly eyes: THREE.Mesh[] = [];
  private readonly mouth: THREE.Mesh;
  private readonly cheeks: THREE.Mesh[] = [];
  private readonly browL: THREE.Mesh;
  private readonly browR: THREE.Mesh;
  readonly height = 20;

  constructor() {
    const skin = new THREE.MeshToonMaterial({ color: 0xffe3d3 });
    const hair = new THREE.MeshToonMaterial({ color: 0x3c3350 });
    const cloth = new THREE.MeshToonMaterial({ color: 0x6f86c9 });
    const dark = new THREE.MeshBasicMaterial({ color: 0x2a2233 });
    const pink = new THREE.MeshBasicMaterial({ color: 0xff8fa8, transparent: true, opacity: 0 });

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(2.6, 6, 8, 16), cloth);
    body.position.y = 6.2;
    const skirt = new THREE.Mesh(new THREE.ConeGeometry(4.2, 5, 24, 1, true), cloth);
    skirt.position.y = 3.2;
    const legs = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.1, 4, 12), skin);
    legs.position.y = 1.5;
    this.root.add(legs, skirt);

    this.upper.position.y = 7;
    body.position.y = -0.8;
    this.upper.add(body);
    this.neck.position.y = 4.6;
    this.upper.add(this.neck);
    this.head.position.y = 2.4;
    this.neck.add(this.head);

    const face = new THREE.Mesh(new THREE.SphereGeometry(3.4, 32, 24), skin);
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(3.65, 32, 24, 0, Math.PI * 2, 0, Math.PI * 0.55), hair);
    hairCap.rotation.x = -0.35;
    const back = new THREE.Mesh(new THREE.SphereGeometry(3.6, 24, 16), hair);
    back.position.set(0, -0.6, -0.9);
    back.scale.set(1.02, 1.1, 0.9);
    this.head.add(back, face, hairCap);

    for (const x of [-1.2, 1.2]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12), dark);
      eye.position.set(x, 0.2, 3.15);
      eye.scale.set(1, 1.5, 0.4);
      this.head.add(eye);
      this.eyes.push(eye);
      const cheek = new THREE.Mesh(new THREE.CircleGeometry(0.6, 16), pink.clone());
      cheek.position.set(x * 1.5, -0.8, 3.0);
      this.head.add(cheek);
      this.cheeks.push(cheek);
    }
    this.browL = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.15, 0.1), dark);
    this.browR = this.browL.clone();
    this.browL.position.set(-1.2, 1.3, 3.2);
    this.browR.position.set(1.2, 1.3, 3.2);
    this.head.add(this.browL, this.browR);

    this.mouth = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20), new THREE.MeshBasicMaterial({ color: 0x8a3044 }));
    this.mouth.position.set(0, -1.3, 3.25);
    this.head.add(this.mouth);

    this.root.add(this.upper);
  }

  apply(p: { pose: Pose; blink: number; mouth: MouthWeights; emotion: Emotion; emotionWeight: number; eyeYaw: number; eyePitch: number }): void {
    const { pose } = p;
    this.root.position.y = pose.rootY;
    this.upper.rotation.set(pose.upper[0], pose.upper[1], pose.upper[2]);
    this.neck.rotation.set(pose.neck[0], pose.neck[1], pose.neck[2]);
    this.head.rotation.set(pose.head[0], pose.head[1], pose.head[2]);

    const e = p.emotion;
    const w = p.emotionWeight;
    const smile = e === 'happy' ? w : e === 'shy' ? w * 0.5 : 0;
    const open = 1 - Math.max(p.blink, smile * 0.7);
    for (const eye of this.eyes) {
      eye.scale.y = 1.5 * Math.max(0.08, open) * (e === 'surprised' ? 1 + 0.3 * w : 1);
      eye.position.x = Math.sign(eye.position.x) * 1.2 + p.eyeYaw * 0.6;
      eye.position.y = 0.2 + p.eyePitch * 0.5;
    }
    for (const c of this.cheeks) (c.material as THREE.MeshBasicMaterial).opacity = e === 'shy' ? 0.7 * w : smile * 0.25;
    const browTilt = e === 'troubled' || e === 'sad' ? 0.35 * w : e === 'angry' ? -0.4 * w : 0;
    this.browL.rotation.z = -browTilt;
    this.browR.rotation.z = browTilt;
    this.browL.position.y = this.browR.position.y = 1.3 + (e === 'surprised' ? 0.3 * w : 0);

    const m = p.mouth;
    const openY = Math.max(m.a, m.o * 0.9, m.e * 0.6, m.u * 0.5, m.i * 0.3);
    const wideX = 1 + m.i * 0.6 + m.e * 0.4 - m.u * 0.4 - m.o * 0.2 + smile * 0.4;
    this.mouth.scale.set(wideX, 0.25 + openY * 1.4, 1);
  }
}
