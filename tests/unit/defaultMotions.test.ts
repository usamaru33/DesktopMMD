import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BONE_SJIS, buildVmd, DEFAULT_MOTIONS, MOTION_EMOTIONS, motionDuration, writeDefaultMotions } from '../../src/main/character/defaultMotions';

/** VMD を読み戻す（three の MMDParser と同じ並び）。 */
function readBones(buf: Buffer) {
  expect(buf.subarray(0, 25).toString('ascii')).toBe('Vocaloid Motion Data 0002');
  const n = buf.readUInt32LE(50);
  const out: { name: string; frame: number; pos: number[]; q: number[]; interp: number[] }[] = [];
  let o = 54;
  for (let i = 0; i < n; i++) {
    const name = new TextDecoder('shift_jis').decode(buf.subarray(o, o + 15)).replace(/\0.*$/, '');
    const frame = buf.readUInt32LE(o + 15);
    const f = (k: number) => buf.readFloatLE(o + 19 + k * 4);
    out.push({ name, frame, pos: [f(0), f(1), f(2)], q: [f(3), f(4), f(5), f(6)], interp: [...buf.subarray(o + 47, o + 111)] });
    o += 111;
  }
  // 残りは morph/camera/light/shadow/ik の件数（すべて0）
  expect(buf.length).toBe(o + 20);
  for (let i = 0; i < 5; i++) expect(buf.readUInt32LE(o + i * 4)).toBe(0);
  return out;
}

describe('three.js の MMDParser で読める', () => {
  it.each(MOTION_EMOTIONS)('%s', async (e) => {
    const mod = (await import('three/examples/jsm/libs/mmdparser.module.js' as string)) as { MMDParser: { Parser: new () => { parseVmd(b: ArrayBuffer, lr: boolean): any } } };
    const buf = buildVmd(DEFAULT_MOTIONS[e]);
    const v = new mod.MMDParser.Parser().parseVmd(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, true);
    const total = Object.values(DEFAULT_MOTIONS[e]).reduce((n, k) => n + (k?.length ?? 0), 0);
    expect(v.metadata.motionCount).toBe(total);
    expect(v.motions.map((m: { boneName: string }) => m.boneName).every((n: string) => ['上半身', '首', '頭'].includes(n))).toBe(true);
  });
});

describe('default motions', () => {
  it('ボーン名がShift_JISで読める', () => {
    const dec = (b: number[]) => new TextDecoder('shift_jis').decode(Uint8Array.from(b));
    expect(dec(BONE_SJIS.upper)).toBe('上半身');
    expect(dec(BONE_SJIS.neck)).toBe('首');
    expect(dec(BONE_SJIS.head)).toBe('頭');
  });

  it.each(MOTION_EMOTIONS)('%s: 正しいVMDで、始まりと終わりが元の姿勢に戻る', (e) => {
    const bones = readBones(buildVmd(DEFAULT_MOTIONS[e]));
    expect(bones.length).toBeGreaterThan(2);
    for (const name of new Set(bones.map((b) => b.name))) {
      expect(['上半身', '首', '頭']).toContain(name);
      const own = bones.filter((b) => b.name === name).sort((a, b) => a.frame - b.frame);
      for (const k of [own[0]!, own[own.length - 1]!]) {
        expect(k.q[0]).toBeCloseTo(0, 5);
        expect(k.q[1]).toBeCloseTo(0, 5);
        expect(k.q[2]).toBeCloseTo(0, 5);
        expect(k.q[3]).toBeCloseTo(1, 5);
      }
      expect(own[0]!.frame).toBe(0);
    }
    for (const b of bones) {
      expect(b.pos).toEqual([0, 0, 0]);
      expect(b.interp.slice(0, 16)).toEqual([20, 20, 20, 20, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 107]);
      expect(Math.hypot(...b.q)).toBeCloseTo(1, 5);
    }
    expect(motionDuration(DEFAULT_MOTIONS[e])).toBeGreaterThan(0.5);
    expect(motionDuration(DEFAULT_MOTIONS[e])).toBeLessThan(3);
  });

  it('うなずき(x+)は、読み込み時の反転(-x,-y,z,w)を経て three 座標で x+ の回転になる', () => {
    const b = readBones(buildVmd({ head: [[0, 0, 0, 0], [10, 20, 0, 0]] })).find((k) => k.frame === 10)!;
    const threeQx = -b.q[0]!; // MMDLoader は x,y を反転して読む
    expect(threeQx).toBeCloseTo(Math.sin((20 * Math.PI) / 360), 5);
  });

  it('書き出しは冪等で、感情ごとにファイルができる', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-motions-'));
    writeDefaultMotions(dir);
    const first = fs.statSync(path.join(dir, 'happy.vmd')).mtimeMs;
    writeDefaultMotions(dir);
    expect(fs.statSync(path.join(dir, 'happy.vmd')).mtimeMs).toBe(first);
    expect(fs.readdirSync(dir).sort()).toEqual(MOTION_EMOTIONS.map((e) => `${e}.vmd`).sort());
    fs.rmSync(dir, { recursive: true });
  });
});
