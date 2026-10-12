import { describe, expect, it } from 'vitest';
import { classifyTouch, faceUnit, PatDetector, sideOf, type TouchPoints } from '../../src/renderer/character/character/touchZones';
import { touchGesture } from '../../src/renderer/character/character/motion';

// a standing model, 720 px tall window: face at y=150, neck 40 px below, hands at the hips
const pts: TouchPoints = {
  face: { x: 240, y: 150 },
  neck: { x: 240, y: 190 },
  hands: [{ x: 300, y: 380 }, { x: 180, y: 380 }],
  shoulders: [{ x: 280, y: 215 }, { x: 200, y: 215 }],
  hips: { x: 240, y: 360 },
};
const u = faceUnit(pts, 720);
const at = (x: number, y: number) => classifyTouch({ x, y }, pts, u);

describe('classifyTouch', () => {
  it('uses the eyes→neck distance as the unit', () => {
    expect(u).toBe(40);
    expect(faceUnit({ ...pts, neck: null }, 720)).toBe(36);
  });
  it('tells the parts apart', () => {
    expect(at(240, 110)).toBe('head'); // top of the head
    expect(at(240, 60)).toBe('head'); // hair, further up
    expect(at(255, 170)).toBe('cheek');
    expect(at(300, 385)).toBe('hand');
    expect(at(285, 220)).toBe('shoulder');
    expect(at(240, 290)).toBe('body');
    expect(at(240, 500)).toBe('legs');
  });
  it('hands win where they overlap the legs', () => {
    expect(at(180, 395)).toBe('hand');
  });
  it('sides are the character\'s own (her right = viewer\'s left)', () => {
    expect(sideOf({ x: 100, y: 0 }, pts)).toBe(1);
    expect(sideOf({ x: 400, y: 0 }, pts)).toBe(-1);
  });
});

describe('PatDetector', () => {
  const stroke = (d: PatDetector, from: number, t0: number) => {
    const out: (string | null)[] = [];
    let t = t0;
    for (const x of [0, 10, 20, 30, 20, 10, 0, 10, 20, 30, 20, 10, 0].map((v) => from + v)) out.push(d.move(x, (t += 0.033)));
    return { out, t };
  };
  it('starts after a few back-and-forth strokes and stops when they stop', () => {
    const d = new PatDetector();
    const { out, t } = stroke(d, 100, 0);
    expect(out.filter((o) => o === 'start')).toHaveLength(1);
    expect(d.active).toBe(true);
    expect(d.tick(t + 0.3)).toBe(false);
    expect(d.tick(t + 2)).toBe(true);
    expect(d.active).toBe(false);
  });
  it('ignores tiny jitter and a single pass', () => {
    const d = new PatDetector();
    let t = 0;
    for (const x of [100, 103, 100, 103, 100, 103, 100]) expect(d.move(x, (t += 0.033))).toBeNull();
    const e = new PatDetector();
    for (let x = 0; x < 300; x += 10) expect(e.move(x, (t += 0.033))).toBeNull();
  });
  it('forgets the motion when the cursor leaves the head', () => {
    const d = new PatDetector();
    d.move(100, 0);
    d.move(130, 0.03);
    d.leave();
    expect(d.move(100, 0.06)).toBeNull();
  });
});

describe('touchGesture', () => {
  it('turns toward a tapped shoulder and away from a poked cheek', () => {
    const mid = (g: ReturnType<typeof touchGesture>) => g.pose(g.duration * 0.4);
    // her right (+1): turning toward it is -yaw
    expect(mid(touchGesture('shoulder', 1)).head[1]).toBeLessThan(0);
    expect(mid(touchGesture('shoulder', -1)).head[1]).toBeGreaterThan(0);
    expect(mid(touchGesture('cheek', 1)).head[1]).toBeGreaterThan(0);
  });
  it('every part settles back to rest', () => {
    for (const part of ['head', 'cheek', 'hand', 'shoulder', 'body', 'legs'] as const) {
      const g = touchGesture(part, 1);
      const end = g.pose(g.duration);
      for (const v of [...end.head, ...end.neck, ...end.upper, end.rootY]) expect(Math.abs(v)).toBeLessThan(1e-6);
    }
  });
});
