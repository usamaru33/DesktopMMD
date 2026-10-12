import { describe, expect, it } from 'vitest';
import { faceLevel, findMorph, resolveFace } from '../../src/renderer/character/character/morphs';

const dict: Record<string, number> = { まばたき: 0, 笑い: 1, あ: 2, い: 3, う: 4, え: 5, お: 6, 困る: 7, 'にこり ': 8, ｷﾘｯ: 9, 照れ: 10, あ２: 11 };

describe('morph lookup', () => {
  it('takes the first candidate present', () => {
    expect(findMorph(dict, ['ウィンク', '笑い'])).toBe(1);
    expect(findMorph(dict, ['存在しない'])).toBeNull();
  });
  it('matches after normalization (spaces, half/full width)', () => {
    expect(findMorph(dict, ['にこり'])).toBe(8);
    expect(findMorph(dict, ['キリッ'])).toBe(9);
  });
  it('morphMap override wins', () => {
    expect(findMorph(dict, ['あ'], 'あ２')).toBe(11);
  });
  it('resolves a whole face and reports missing parts', () => {
    const f = resolveFace(dict, { 'mouth.a': 'あ２' });
    expect(f.vowels.a).toBe(11);
    expect(f.blink).toBe(0);
    expect(f.emotions.happy?.eye).toBe(1);
    expect(f.emotions.shy?.cheek).toBe(10);
    expect(f.missing).toContain('surprised.eye');
    expect(f.found).toContain('happy.eye');
  });
});

describe('faceLevel', () => {
  it('keeps the ends and lifts mild intensities', () => {
    expect(faceLevel(0)).toBe(0);
    expect(faceLevel(1)).toBe(1);
    expect(faceLevel(0.4)).toBeCloseTo(0.64);
    expect(faceLevel(-1)).toBe(0);
    expect(faceLevel(2)).toBe(1);
  });
  it('is monotonic', () => {
    for (let k = 0; k < 1; k += 0.05) expect(faceLevel(k + 0.05)).toBeGreaterThan(faceLevel(k));
  });
});
