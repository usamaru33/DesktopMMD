// 動きの活発さ (renderer/character/character/motion.ts).
import { describe, expect, it } from 'vitest';
import {
  FIDGETS, Fidgeter, fidgetGesture, idlePose, LIVELINESS, speakingPose, ZERO_POSE, type Pose,
} from '../../src/renderer/character/character/motion';

const mag = (p: Pose) => Math.max(...p.upper.map(Math.abs), ...p.neck.map(Math.abs), ...p.head.map(Math.abs), Math.abs(p.rootY));
const peak = (f: (t: number) => Pose, dur: number) => {
  let m = 0;
  for (let t = 0; t <= dur; t += 0.01) m = Math.max(m, mag(f(t)));
  return m;
};

describe('liveliness profiles', () => {
  it('normal keeps the old idle amplitudes; calm is smaller and lively larger', () => {
    // amp=1 must be exactly the previous idlePose(t, mood)
    const at = (amp: number) => peak((t) => idlePose(t, 0, amp), 30);
    expect(at(LIVELINESS.normal.amp)).toBeCloseTo(at(1), 10);
    expect(at(LIVELINESS.calm.amp)).toBeLessThan(at(1));
    expect(at(LIVELINESS.lively.amp)).toBeGreaterThan(at(1));
    // breathing grows slower than the sway (no gasping)
    const breath = (amp: number) => peak((t) => ({ ...ZERO_POSE(), upper: [idlePose(t, 0, amp).upper[0], 0, 0] }), 8);
    expect(breath(LIVELINESS.lively.amp) / breath(1)).toBeLessThan(LIVELINESS.lively.amp);
  });

  it('orders the knobs calm < normal < lively', () => {
    const { calm, normal, lively } = LIVELINESS;
    expect(calm.fidgetEvery).toBeNull();
    expect(lively.fidgetEvery![1]).toBeLessThan(normal.fidgetEvery![0]);
    expect([calm.speakingBob, normal.speakingBob, lively.speakingBob]).toEqual([...[calm.speakingBob, normal.speakingBob, lively.speakingBob]].sort((a, b) => a - b));
    expect(calm.gestureScale).toBeLessThan(normal.gestureScale);
    expect(lively.gestureScale).toBeGreaterThan(normal.gestureScale);
    expect(lively.idleVmdEvery[1]).toBeLessThan(normal.idleVmdEvery[1]);
  });
});

describe('fidgets', () => {
  it.each(FIDGETS)('%s starts and ends at rest, stays within a modest range, and scales', (kind) => {
    const g = fidgetGesture(kind);
    expect(mag(g.pose(0))).toBeLessThan(1e-6);
    expect(mag(g.pose(g.duration))).toBeLessThan(1e-6);
    const p1 = peak(g.pose, g.duration);
    expect(p1).toBeGreaterThan(0.01);
    expect(p1).toBeLessThan(0.35); // ≈20°, or 0.35 model units of bounce
    expect(peak(fidgetGesture(kind, 1.5).pose, g.duration)).toBeCloseTo(p1 * 1.5, 5);
  });

  it('Fidgeter waits for the interval, never repeats the same fidget twice in a row, and is off for calm', () => {
    let i = 0;
    const seq = [0.0, 0.0, 0.2, 0.5, 0.0, 0.9, 0.5, 0.0, 0.3, 0.5];
    const rng = () => seq[i++ % seq.length];
    const f = new Fidgeter(rng, 0);
    const lively = LIVELINESS.lively;
    expect(f.update(5, lively, true)).toBeNull(); // first one after 10 s
    const kinds: number[] = [];
    let t = 10;
    for (let n = 0; n < 6; n++) {
      const g = f.update(t, lively, true);
      expect(g).not.toBeNull();
      kinds.push(g!.duration);
      expect(f.update(t + 1, lively, true)).toBeNull(); // not again right away
      t += lively.fidgetEvery![1] + 0.1;
    }
    for (let k = 1; k < kinds.length; k++) expect(kinds[k] === kinds[k - 1] && kinds[k] !== 0).toBe(false);
    expect(new Fidgeter(rng, 0).update(1000, LIVELINESS.calm, true)).toBeNull();
  });

  it('Fidgeter is postponed while the character is busy', () => {
    const f = new Fidgeter(() => 0, 0);
    const p = LIVELINESS.lively;
    expect(f.update(20, p, false)).toBeNull(); // talking at t=20 → next not before 20 + 3.5
    expect(f.update(22, p, true)).toBeNull();
    expect(f.update(24, p, true)).not.toBeNull();
  });

  it('speaking bob is still at 0 and small otherwise', () => {
    expect(peak((t) => speakingPose(t, 0), 5)).toBe(0);
    const p = peak((t) => speakingPose(t, LIVELINESS.lively.speakingBob), 5);
    expect(p).toBeGreaterThan(0.02);
    expect(p).toBeLessThan(0.06); // ≈3°
  });
});
