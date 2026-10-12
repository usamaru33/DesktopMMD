import { describe, expect, it } from 'vitest';
import { ASLEEP_AFTER_MS, AWAY_AFTER_SEC, PresenceTracker, sleepinessFor } from '../../src/main/proactive/presence';

describe('PresenceTracker', () => {
  it('becomes away after a few idle minutes and reports the return once', () => {
    const p = new PresenceTracker();
    const t0 = 1_000_000;
    expect(p.update(60, t0)).toBeNull();
    expect(p.away).toBe(false);
    expect(p.update(AWAY_AFTER_SEC, t0 + 240_000)).toBeNull();
    expect(p.away).toBe(true);
    const back = p.update(1, t0 + 600_000)!;
    // away since the last input (idle counted back from when it was noticed)
    expect(back.awayMs).toBe(600_000 + 60_000);
    expect(back.asleep).toBe(false);
    expect(p.update(0, t0 + 602_000)).toBeNull();
  });

  it('a long absence means she had dozed off', () => {
    const p = new PresenceTracker();
    p.update(AWAY_AFTER_SEC, 0);
    expect(p.update(0, ASLEEP_AFTER_MS)!.asleep).toBe(true);
  });

  it('sleep or lock starts the absence; unlock or a touch ends it', () => {
    const p = new PresenceTracker();
    p.leave(1000);
    expect(p.away).toBe(true);
    expect(p.back(61_000)).toEqual({ awayMs: 60_000, asleep: false });
    expect(p.back(62_000)).toBeNull();
  });

  it('is still away while the idle time keeps growing', () => {
    const p = new PresenceTracker();
    p.update(AWAY_AFTER_SEC, 0);
    expect(p.update(AWAY_AFTER_SEC + 100, 100_000)).toBeNull();
    expect(p.away).toBe(true);
  });
});

describe('sleepinessFor', () => {
  it('drowsy from 10 min, asleep at 30', () => {
    expect(sleepinessFor(9 * 60)).toBe(0);
    expect(sleepinessFor(10 * 60)).toBeCloseTo(0.3);
    expect(sleepinessFor(20 * 60)).toBeCloseTo(0.6);
    expect(sleepinessFor(30 * 60)).toBe(1);
  });
});
