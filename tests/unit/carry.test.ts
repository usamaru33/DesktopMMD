import { describe, expect, it } from 'vitest';
import { Carry, carryPose, inertialGravity } from '../../src/renderer/character/character/carry';
import { landGesture } from '../../src/renderer/character/character/motion';

describe('Carry', () => {
  it('follows a steady drag and settles when it stops', () => {
    const c = new Carry();
    for (let i = 0; i < 60; i++) {
      c.push(10, 0); // 10 px per 1/60 s = 600 px/s
      c.update(1 / 60);
    }
    expect(c.vx).toBeGreaterThan(550);
    expect(Math.abs(c.ax)).toBeLessThan(200);
    for (let i = 0; i < 120; i++) c.update(1 / 60);
    expect(c.still).toBe(true);
    expect(c.vx).toBe(0);
  });

  it('a sudden start accelerates in the direction of motion', () => {
    const c = new Carry();
    c.push(0, 0);
    c.update(1 / 60);
    for (let i = 0; i < 4; i++) {
      c.push(-15, 0);
      c.update(1 / 60);
    }
    expect(c.ax).toBeLessThan(-1000);
  });

  it('ignores a zero or negative frame time', () => {
    const c = new Carry();
    c.push(50, 0);
    c.update(0);
    expect(c.vx).toBe(0);
  });
});

describe('inertialGravity', () => {
  it('pushes against the acceleration (screen y is down, world y up)', () => {
    const [gx, gy] = inertialGravity(1000, 1000, 0.01, 1e9);
    expect(gx).toBeCloseTo(-10);
    expect(gy).toBeCloseTo(10);
  });
  it('is capped', () => {
    const [gx, gy] = inertialGravity(1e7, 0, 0.01, 50);
    expect(Math.hypot(gx, gy)).toBeCloseTo(50);
  });
});

describe('carried and landing poses', () => {
  it('leans within limits, however fast the window flies', () => {
    for (const v of [-1e5, -500, 0, 500, 1e5]) {
      const p = carryPose(v, v);
      for (const a of [...p.upper, ...p.head]) expect(Math.abs(a)).toBeLessThan((12 * Math.PI) / 180);
    }
  });
  it('the landing settles back to rest', () => {
    const g = landGesture();
    const end = g.pose(g.duration);
    for (const v of [...end.head, ...end.neck, ...end.upper, end.rootY]) expect(Math.abs(v)).toBeLessThan(1e-6);
    expect(g.pose(0.12).rootY).toBeLessThan(-0.1);
  });
});
