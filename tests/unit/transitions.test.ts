// モーション同士の補間 (renderer/character/character/motion.ts の CrossFader / smootherstep、talkGestures の blendLayer).
import { describe, expect, it } from 'vitest';
import { blendPose, CrossFader, type Pose, smootherstep, statePose, ZERO_POSE } from '../../src/renderer/character/character/motion';
import { blendLayer, talkPose, type TalkLayer } from '../../src/renderer/character/character/talkGestures';

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

describe('smootherstep', () => {
  it('goes 0→1 with zero speed at both ends', () => {
    expect(smootherstep(0)).toBe(0);
    expect(smootherstep(1)).toBe(1);
    expect(smootherstep(-1)).toBe(0);
    expect(smootherstep(2)).toBe(1);
    const h = 1e-4;
    expect((smootherstep(h) - smootherstep(0)) / h).toBeLessThan(1e-6);
    expect((smootherstep(1) - smootherstep(1 - h)) / h).toBeLessThan(1e-6);
    for (let u = 0; u < 1; u += 0.01) expect(smootherstep(u + 0.01)).toBeGreaterThanOrEqual(smootherstep(u));
  });
});

/** run a fader at 60 fps; returns the outputs */
function run(f: CrossFader<number>, frames: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames; i++) out.push(f.update(1 / 60));
  return out;
}
const steps = (xs: number[], start: number) => xs.map((x, i) => Math.abs(x - (i ? xs[i - 1] : start)));

describe('CrossFader', () => {
  it('shows the initial source until the first switch', () => {
    const f = new CrossFader<number>(lerp, () => 5);
    expect(f.update(1 / 60)).toBe(5);
    expect(f.fading).toBe(false);
  });

  it('fades from the old source to the new one without a jump, easing in and out', () => {
    const f = new CrossFader<number>(lerp, () => 0);
    f.update(1 / 60);
    f.switchTo(() => 1, 0.5);
    const xs = run(f, 40);
    expect(xs[39]).toBe(1);
    expect(f.fading).toBe(false);
    const st = steps(xs, 0);
    // a jump straight to 1 would be a step of 1; the fade spreads it over 30 frames, slowest at the ends
    expect(Math.max(...st)).toBeLessThan(0.07);
    expect(st[0]).toBeLessThan(0.002);
    expect(st[29]).toBeLessThan(0.002);
  });

  it('keeps the old source moving during the fade', () => {
    let time = 0;
    const wave = () => Math.sin(time * 10);
    const f = new CrossFader<number>(lerp, wave);
    f.switchTo(() => 0, 1);
    time += 1 / 60;
    expect(f.update(1 / 60)).toBeCloseTo(Math.sin(time * 10), 2);
  });

  it('a switch in the middle of a fade carries on at the same speed (no stop, no jump)', () => {
    const f = new CrossFader<number>(lerp, () => 0);
    f.switchTo(() => 1, 0.5);
    const before = run(f, 15); // halfway, moving fastest
    const v0 = before[14] - before[13];
    f.switchTo(() => -1, 0.5);
    const after = run(f, 3);
    expect(Math.abs(after[0] - before[14])).toBeLessThan(v0 * 1.5); // no jump
    expect(after[0] - before[14]).toBeGreaterThan(v0 * 0.5); // still moving the old way, not frozen
    // and it then turns around smoothly and ends at the new source
    const rest = run(f, 60);
    expect(rest[59]).toBe(-1);
    // 1.5 to cover in 0.5 s: the minimum-jerk peak is 1.875 × 1.5 / 30 ≈ 0.094 per frame, plus the old fade's own motion
    expect(Math.max(...steps(rest, after[2]))).toBeLessThan(0.15);
  });

  it('blends whole poses and talk layers', () => {
    const f = new CrossFader<Pose>(blendPose, () => ZERO_POSE());
    const thinking = statePose('thinking', 0, 1);
    f.switchTo(() => thinking, 0.45);
    let prev = 0;
    for (let i = 0; i < 30; i++) {
      const p = f.update(1 / 60);
      expect(Math.abs(p.head[2] - prev)).toBeLessThan(thinking.head[2] * 0.1);
      prev = p.head[2];
    }
    expect(prev).toBeCloseTo(thinking.head[2], 10);

    const relaxed: TalkLayer = { body: ZERO_POSE(), right: { upper: [-0.1, -0.99, 0.05], fore: [-0.05, -0.98, 0.2], palm: [0.9, 0, 0.3], curl: 0.2 } };
    const p = talkPose('present', 1);
    const present: TalkLayer = { body: p.body, right: p.right! };
    const mid = blendLayer(relaxed, present, 0.5);
    expect(mid.right!.curl).toBeCloseTo(0.16, 10);
    expect(Math.hypot(...mid.right!.upper)).toBeCloseTo(1, 9);
    expect(mid.body.upper[1]).toBeCloseTo(p.body.upper[1] / 2, 10);
    // an arm only one side has is kept as is
    expect(blendLayer({ body: ZERO_POSE() }, present, 0.5).right).toEqual(present.right);
  });
});
