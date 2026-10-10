import { describe, expect, it } from 'vitest';
import { Blinker, distributeGaze, emotionGesture, GAZE_LIMITS, idlePose, Spring2 } from '../../src/renderer/character/character/motion';
import { EMOTIONS } from '../../src/shared/emotions';

describe('procedural motion', () => {
  it('every non-neutral emotion has a gesture that starts and ends at rest', () => {
    for (const e of EMOTIONS) {
      const g = emotionGesture(e, 1);
      if (e === 'neutral') {
        expect(g).toBeNull();
        continue;
      }
      const start = g!.pose(0);
      const end = g!.pose(g!.duration);
      for (const p of [start, end]) {
        for (const v of [...p.upper, ...p.neck, ...p.head, p.rootY]) expect(Math.abs(v)).toBeLessThan(0.02);
      }
      // and actually moves in the middle
      const mid = g!.pose(g!.duration * 0.4);
      const mag = [...mid.upper, ...mid.neck, ...mid.head, mid.rootY].reduce((s, v) => s + Math.abs(v), 0);
      expect(mag).toBeGreaterThan(0.02);
    }
  });

  it('idle breathing has a ~4 s period', () => {
    expect(idlePose(0, 0).upper[0]).toBeCloseTo(idlePose(4, 0).upper[0], 5);
  });

  it('blinks every 2–6 s, sometimes twice', () => {
    let seq = 0;
    const rng = () => [0.5, 0.1, 0.5, 0.9, 0.5][seq++ % 5];
    const b = new Blinker(rng, 0);
    const closedAt: number[] = [];
    let prev = 0;
    for (let t = 0; t < 30; t += 1 / 60) {
      const w = b.update(t);
      if (w > 0.95 && prev <= 0.95) closedAt.push(t);
      prev = w;
    }
    expect(closedAt.length).toBeGreaterThanOrEqual(5);
    const gaps = closedAt.slice(1).map((t, i) => t - closedAt[i]);
    expect(Math.min(...gaps)).toBeLessThan(0.5); // a double blink
    expect(Math.max(...gaps)).toBeLessThanOrEqual(6.3);
  });

  it('spring converges without overshoot', () => {
    const s = new Spring2(8);
    let max = 0;
    for (let i = 0; i < 120; i++) {
      s.update(1, 0, 1 / 30);
      max = Math.max(max, s.x);
    }
    expect(s.x).toBeCloseTo(1, 2);
    expect(max).toBeLessThanOrEqual(1.0001);
  });

  it('gaze split: eyes 60 / head 30 / neck 10, head within ±35°', () => {
    const g = distributeGaze(0.5, 0.1);
    expect(g.eyes[0]).toBeCloseTo(0.3);
    expect(g.head[0]).toBeCloseTo(0.15);
    expect(g.neck[0]).toBeCloseTo(0.05);
    const far = distributeGaze(10, -10);
    expect(Math.abs(far.head[0])).toBeLessThanOrEqual(GAZE_LIMITS.yaw + 1e-9);
    expect(Math.abs(far.head[1])).toBeLessThanOrEqual(GAZE_LIMITS.pitch + 1e-9);
  });
});
