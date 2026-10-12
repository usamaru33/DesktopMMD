// おやすみ中の描画: frame rate and physics stepping (renderer/character/character/motion.ts).
// Asleep it used to render at 5 fps with frames capped at 0.1 s: half-speed motion, and the MMD physics
// (≤3 × 1/65 s per call) fell behind the bones, so hair and skirts snapped.
import { describe, expect, it } from 'vitest';
import { frameRateFor, physicsSteps } from '../../src/renderer/character/character/motion';

describe('sleep mode rendering', () => {
  it('asleep renders at most 15 fps (not 5), never above the user setting', () => {
    expect(frameRateFor('sleeping', 60)).toBe(15);
    expect(frameRateFor('sleeping', 10)).toBe(10);
    expect(frameRateFor('idle', 60)).toBe(60);
  });

  it('splits long frames into physics steps the MMD physics can simulate in one call', () => {
    const max = 3 / 65;
    const steps = physicsSteps(0.1);
    expect(steps.every((s) => s <= max + 1e-9)).toBe(true);
    expect(steps.reduce((a, b) => a + b, 0)).toBeCloseTo(0.1, 9);
    expect(physicsSteps(1 / 60)).toEqual([1 / 60]); // normal frames are untouched
    expect(physicsSteps(0)).toEqual([]);
    expect(physicsSteps(10).length).toBe(8); // bounded after a long stall
  });
});
