import { describe, expect, it } from 'vitest';
import { cosine, rankMemories, recency, score, rankByBm25 } from '../../src/main/memory/scoring';
import { applyAffinityDelta, stageOf, updateMood } from '../../src/main/memory/affinity';
import {
  effectiveIntervalMin, inQuietHours, isLateNight, needsGreeting, suppressedBy, type SuppressionInput,
} from '../../src/main/proactive/suppression';

const vec = (...xs: number[]) => new Float32Array(xs);
const NOW = new Date('2026-10-07T12:00:00');

describe('memory scoring (spec 5.7)', () => {
  it('cosine', () => {
    expect(cosine(vec(1, 0), vec(1, 0))).toBeCloseTo(1);
    expect(cosine(vec(1, 0), vec(0, 1))).toBeCloseTo(0);
    expect(cosine(vec(0, 0), vec(1, 0))).toBe(0);
  });
  it('recency halves every 30 days', () => {
    expect(recency(null, NOW.toISOString(), NOW)).toBeCloseTo(1);
    expect(recency(null, new Date(NOW.getTime() - 30 * 86_400_000).toISOString(), NOW)).toBeCloseTo(0.5);
    expect(recency(new Date(NOW.getTime() - 60 * 86_400_000).toISOString(), '2020-01-01', NOW)).toBeCloseTo(0.25);
  });
  it('weights 0.6 / 0.25 / 0.15', () => {
    expect(score(1, 1, 1)).toBeCloseTo(1);
    expect(score(0.5, 0.4, 0.2)).toBeCloseTo(0.3 + 0.1 + 0.03);
  });
  it('excludes cos < 0.35, ranks, and respects topK and token budget', () => {
    const mk = (id: number, e: Float32Array, importance = 0.5, content = 'x') => ({
      id, content, importance, embedding: e, lastUsedAt: null, createdAt: NOW.toISOString(),
    });
    const q = vec(1, 0);
    const items = [
      mk(1, vec(1, 0.1)),
      mk(2, vec(0.2, 1)), // cos ≈ 0.196 → excluded
      mk(3, vec(1, 0.5), 1.0),
      mk(4, vec(1, 0), 0, 'あ'.repeat(3000)), // too long for the budget
      mk(5, vec(1, 0), 0.2, ''),
    ];
    const r = rankMemories(q, items, NOW);
    expect(r.map((x) => x.item.id)).toEqual([3, 1, 5]);
    expect(rankMemories(q, items, NOW, { topK: 1 }).map((x) => x.item.id)).toEqual([3]);
  });
  it('BM25 fallback produces scores in range', () => {
    const row = (id: number) => ({ id, content: 'a', importance: 0.5, embedding: null, lastUsedAt: null, createdAt: NOW.toISOString() });
    const r = rankByBm25([{ row: row(1), rank: -5 }, { row: row(2), rank: -1 }], NOW);
    expect(r[0].item.id).toBe(1);
    expect(r[0].cos).toBeCloseTo(0.9);
    expect(r[1].cos).toBeCloseTo(0.35);
  });
});

describe('affinity and mood', () => {
  const rel = { affinity: 10, mood: 0, dailyDelta: 0, deltaDate: '2026-10-07', firstMetAt: '2026-10-01' };
  it('stages', () => {
    expect([0, 19, 20, 39, 40, 69, 70, 100].map(stageOf)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });
  it('caps daily increase at +5 and decrease at -3', () => {
    let r = rel;
    for (let i = 0; i < 4; i++) r = applyAffinityDelta(r, 3, '2026-10-07');
    expect(r.affinity).toBe(15);
    let d = rel;
    for (let i = 0; i < 4; i++) d = applyAffinityDelta(d, -3, '2026-10-07');
    expect(d.affinity).toBe(7);
  });
  it('resets the daily budget on a new day and clamps to 0..100', () => {
    const r = applyAffinityDelta({ ...rel, dailyDelta: 5 }, 3, '2026-10-08');
    expect(r.affinity).toBe(13);
    expect(r.dailyDelta).toBe(3);
    expect(applyAffinityDelta({ ...rel, affinity: 99 }, 3, '2026-10-07').affinity).toBe(100);
    expect(applyAffinityDelta({ ...rel, affinity: 1 }, -3, '2026-10-07').affinity).toBe(0);
  });
  it('mood moves toward the emotion valence', () => {
    let m = 0;
    for (let i = 0; i < 50; i++) m = updateMood(m, 'happy', 1);
    expect(m).toBeGreaterThan(0.5);
    expect(updateMood(0, 'sad', 1)).toBeCloseTo(-0.06);
  });
});

describe('proactive suppression (spec 5.8, TC-11)', () => {
  const base: SuppressionInput = {
    now: NOW, enabled: true, fullscreen: false, micInUseByOtherApp: false, muted: false, sleeping: false,
    quietHours: ['00:30', '08:00'], lastConversationAt: null, firedInLastHour: 0, maxPerHour: 2,
  };
  it('allows when nothing applies', () => {
    expect(suppressedBy(base, 'break')).toBeNull();
  });
  it('TC-11: full-screen app suppresses everything, even reminders', () => {
    expect(suppressedBy({ ...base, fullscreen: true }, 'break')).toBe('fullscreen');
    expect(suppressedBy({ ...base, fullscreen: true }, 'reminder')).toBe('fullscreen');
  });
  it('call / mute / sleep / quiet hours / recent conversation / rate limit', () => {
    expect(suppressedBy({ ...base, micInUseByOtherApp: true }, 'greeting')).toBe('in_call');
    expect(suppressedBy({ ...base, muted: true }, 'break')).toBe('muted');
    expect(suppressedBy({ ...base, sleeping: true }, 'break')).toBe('sleeping');
    expect(suppressedBy({ ...base, now: new Date('2026-10-07T03:00:00') }, 'late_night')).toBe('quiet_hours');
    expect(suppressedBy({ ...base, lastConversationAt: new Date(NOW.getTime() - 5 * 60_000) }, 'small_talk')).toBe('recent_conversation');
    expect(suppressedBy({ ...base, firedInLastHour: 2 }, 'break')).toBe('rate_limit');
  });
  it('reminders bypass recent-conversation, mute, quiet hours and the rate limit', () => {
    const busy = { ...base, muted: true, firedInLastHour: 9, lastConversationAt: NOW, now: new Date('2026-10-07T03:00:00') };
    expect(suppressedBy(busy, 'reminder')).toBeNull();
  });
  it('quiet hours across midnight', () => {
    const q: [string, string] = ['23:00', '07:00'];
    expect(inQuietHours(new Date('2026-10-07T23:30:00'), q)).toBe(true);
    expect(inQuietHours(new Date('2026-10-07T06:59:00'), q)).toBe(true);
    expect(inQuietHours(new Date('2026-10-07T07:00:00'), q)).toBe(false);
    expect(inQuietHours(new Date('2026-10-07T12:00:00'), ['09:00', '17:00'])).toBe(true);
  });
  it('late night after bedtime', () => {
    expect(isLateNight(new Date('2026-10-07T01:30:00'), '01:00')).toBe(true);
    expect(isLateNight(new Date('2026-10-07T23:30:00'), '01:00')).toBe(false);
    expect(isLateNight(new Date('2026-10-07T23:30:00'), '23:00')).toBe(true);
    expect(isLateNight(new Date('2026-10-07T02:00:00'), '23:00')).toBe(true);
    expect(isLateNight(new Date('2026-10-07T12:00:00'), '23:00')).toBe(false);
  });
  it('ignored triggers double their interval until replied', () => {
    expect(effectiveIntervalMin('break', [])).toBe(90);
    expect(effectiveIntervalMin('break', ['ignored'])).toBe(180);
    expect(effectiveIntervalMin('break', ['dismissed', 'ignored', 'replied', 'ignored'])).toBe(360);
    expect(effectiveIntervalMin('small_talk', Array(10).fill('ignored'))).toBe(1440);
  });
  it('greeting right after returning, once', () => {
    const back = new Date(NOW.getTime() - 60_000);
    expect(needsGreeting(NOW, null, back)).toBe(true);
    expect(needsGreeting(NOW, NOW, back)).toBe(false);
    expect(needsGreeting(NOW, null, new Date(NOW.getTime() - 3600_000))).toBe(false);
  });
});
