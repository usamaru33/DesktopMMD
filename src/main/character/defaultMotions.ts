// 標準の感情別モーション（VMD）。このアプリが自前で作る動きなので、第三者のモーションは含まない。
// 起動時にこのコードから VMD を書き出し、キャラクターに個別の指定がない感情にだけ使う（mmd://default-motion/<感情>.vmd）。
// 動かすのは「上半身」「首」「頭」だけ。腕や足は触らないので、どのモデルでも立ち位置と腕のポーズは崩れない。
import fs from 'node:fs';
import path from 'node:path';
import type { Emotion } from '../../shared/emotions';

export type MotionEmotion = Exclude<Emotion, 'neutral'>;
export type BoneKey = 'upper' | 'neck' | 'head';

/** [フレーム(30fps), x, y, z] 角度は度。x: うなずき（前に倒す+）、y: 左右に向く（左+）、z: 首をかしげる */
type Key = readonly [number, number, number, number];
export type MotionDef = Partial<Record<BoneKey, readonly Key[]>>;

/** ボーン名は VMD の規格どおり Shift_JIS（15バイトまで）。 */
export const BONE_SJIS: Record<BoneKey, number[]> = {
  upper: [0x8f, 0xe3, 0x94, 0xbc, 0x90, 0x67], // 上半身
  neck: [0x8e, 0xf1], // 首
  head: [0x93, 0xaa], // 頭
};

const FPS = 30;

export const DEFAULT_MOTIONS: Record<MotionEmotion, MotionDef> = {
  // 嬉しい: 小さく2回うなずきながら、首を左右にかしげる
  happy: {
    upper: [[0, 0, 0, 0], [6, -2, 0, 0], [12, 1, 0, 0], [18, -2, 0, 0], [24, 1, 0, 0], [36, 0, 0, 0]],
    head: [[0, 0, 0, 0], [6, 7, 0, 4], [12, 0, 0, 0], [18, 7, 0, -4], [24, 0, 0, 0], [36, 0, 0, 0]],
  },
  // 驚き: 一瞬のけぞって、ゆっくり戻る
  surprised: {
    upper: [[0, 0, 0, 0], [3, -9, 0, 0], [18, -7, 0, 0], [36, 0, 0, 0]],
    neck: [[0, 0, 0, 0], [3, -3, 0, 0], [18, -2, 0, 0], [36, 0, 0, 0]],
    head: [[0, 0, 0, 0], [3, -6, 0, 0], [18, -4, 0, 0], [36, 0, 0, 0]],
  },
  // 悲しい: ゆっくりうつむいて、間をおいて戻る
  sad: {
    upper: [[0, 0, 0, 0], [22, 4, 0, 0], [50, 4, 0, 0], [72, 0, 0, 0]],
    neck: [[0, 0, 0, 0], [22, 4, 0, 0], [50, 4, 0, 0], [72, 0, 0, 0]],
    head: [[0, 0, 0, 0], [22, 13, 0, 1], [50, 12, 0, 1], [72, 0, 0, 0]],
  },
  // 怒り: 少し前のめりに、顔を左右に小さく振る
  angry: {
    upper: [[0, 0, 0, 0], [5, 4, 0, 0], [30, 3, 0, 0], [40, 0, 0, 0]],
    head: [[0, 0, 0, 0], [5, 4, 0, 3], [10, 4, 4, 3], [15, 4, -4, 3], [20, 4, 3, 3], [30, 3, 0, 2], [40, 0, 0, 0]],
  },
  // 困った: 首をかしげて、少し視線をそらす
  troubled: {
    upper: [[0, 0, 0, 0], [14, 1, 0, 0], [40, 1, 0, 0], [54, 0, 0, 0]],
    head: [[0, 0, 0, 0], [14, 3, 5, 10], [40, 3, 5, 10], [54, 0, 0, 0]],
  },
  // 照れ: 目線をそらしてうつむく
  shy: {
    upper: [[0, 0, 0, 0], [16, 3, 4, 0], [44, 3, 4, 0], [60, 0, 0, 0]],
    neck: [[0, 0, 0, 0], [16, 2, 5, 0], [44, 2, 5, 0], [60, 0, 0, 0]],
    head: [[0, 0, 0, 0], [16, 7, 14, 3], [44, 7, 14, 3], [60, 0, 0, 0]],
  },
  // 考え中: 少し上を見て、首をかしげる
  thinking: {
    head: [[0, 0, 0, 0], [14, -4, 7, 8], [42, -4, 7, 8], [54, 0, 0, 0]],
    neck: [[0, 0, 0, 0], [14, -1, 3, 0], [42, -1, 3, 0], [54, 0, 0, 0]],
  },
};

export const MOTION_EMOTIONS = Object.keys(DEFAULT_MOTIONS) as MotionEmotion[];

const D = Math.PI / 180;

/** オイラー角(度, XYZ順)→クォータニオン。three.js側の座標で考え、VMD(左手系)へは x,y を反転して書く。 */
function toVmdQuat(xDeg: number, yDeg: number, zDeg: number): [number, number, number, number] {
  const hx = (xDeg * D) / 2, hy = (yDeg * D) / 2, hz = (zDeg * D) / 2;
  const c1 = Math.cos(hx), c2 = Math.cos(hy), c3 = Math.cos(hz);
  const s1 = Math.sin(hx), s2 = Math.sin(hy), s3 = Math.sin(hz);
  // three.js Euler 'XYZ'
  const qx = s1 * c2 * c3 + c1 * s2 * s3;
  const qy = c1 * s2 * c3 - s1 * c2 * s3;
  const qz = c1 * c2 * s3 + s1 * s2 * c3;
  const qw = c1 * c2 * c3 - s1 * s2 * s3;
  return [-qx, -qy, qz, qw];
}

const HEADER = 'Vocaloid Motion Data 0002';
const BONE_FRAME_BYTES = 111;

/** ボーンのキーフレームだけを持つ VMD（モーフ・カメラ・照明・影・IKは0件）を作る。 */
export function buildVmd(def: MotionDef, modelName = 'DesktopMMD'): Buffer {
  const frames: { bone: BoneKey; key: Key }[] = [];
  for (const bone of Object.keys(def) as BoneKey[]) for (const key of def[bone] ?? []) frames.push({ bone, key });
  const buf = Buffer.alloc(30 + 20 + 4 + frames.length * BONE_FRAME_BYTES + 4 * 5);
  let o = 0;
  buf.write(HEADER, o, 'ascii');
  o += 30;
  buf.write(modelName, o, 'ascii');
  o += 20;
  buf.writeUInt32LE(frames.length, o);
  o += 4;
  for (const { bone, key } of frames) {
    Buffer.from(BONE_SJIS[bone]).copy(buf, o);
    o += 15;
    buf.writeUInt32LE(key[0], o);
    o += 4;
    for (let i = 0; i < 3; i++, o += 4) buf.writeFloatLE(0, o); // 位置は動かさない
    const q = toVmdQuat(key[1], key[2], key[3]);
    for (let i = 0; i < 4; i++, o += 4) buf.writeFloatLE(q[i]!, o);
    // 補間は直線: x1=y1=20, x2=y2=107（MMDの既定値）
    for (let i = 0; i < 64; i++) buf[o + i] = i % 16 < 8 ? 20 : 107;
    o += 64;
  }
  // 以降は morph / camera / light / shadow / ik がすべて0件（Alloc済みで0）
  return buf;
}

export function motionDuration(def: MotionDef): number {
  let last = 0;
  for (const keys of Object.values(def)) for (const k of keys ?? []) last = Math.max(last, k[0]);
  return last / FPS;
}

/** dir に <感情>.vmd を書き出す。内容が同じなら書き換えない。 */
export function writeDefaultMotions(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const e of MOTION_EMOTIONS) {
    const file = path.join(dir, `${e}.vmd`);
    const data = buildVmd(DEFAULT_MOTIONS[e]);
    try {
      if (fs.readFileSync(file).equals(data)) continue;
    } catch {
      /* 未作成 */
    }
    fs.writeFileSync(file, data);
  }
}
