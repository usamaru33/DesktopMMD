import { describe, expect, it } from 'vitest';
import { parseIcs } from '../../src/main/calendar/icsParse';
import { CalendarService, validateCalendarUrl } from '../../src/main/calendar/CalendarService';

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:a@test
DTSTART;TZID=Asia/Tokyo:20261010T100000
DTEND;TZID=Asia/Tokyo:20261010T110000
SUMMARY:定例ミーティング
LOCATION:会議室A
END:VEVENT
BEGIN:VEVENT
UID:daily@test
DTSTART:20261001T030000Z
DTEND:20261001T033000Z
RRULE:FREQ=DAILY;COUNT=30
EXDATE:20261011T030000Z
SUMMARY:朝会
END:VEVENT
BEGIN:VEVENT
UID:allday@test
DTSTART;VALUE=DATE:20261010
DTEND;VALUE=DATE:20261011
SUMMARY:祝日
END:VEVENT
BEGIN:VEVENT
UID:gone@test
DTSTART:20261010T050000Z
DTEND:20261010T060000Z
STATUS:CANCELLED
SUMMARY:中止
END:VEVENT
END:VCALENDAR`;

describe('parseIcs', () => {
  const from = new Date('2026-10-09T15:00:00Z'); // 10/10 00:00 JST
  const to = new Date('2026-10-12T15:00:00Z');
  const evs = parseIcs(ICS, from, to);

  it('TZID付きの予定をJSTとして読む', () => {
    const e = evs.find((x) => x.uid === 'a@test')!;
    expect(e.start.toISOString()).toBe('2026-10-10T01:00:00.000Z');
    expect(e.location).toBe('会議室A');
  });
  it('繰り返しを展開し、EXDATEと中止を除く', () => {
    const daily = evs.filter((x) => x.uid === 'daily@test').map((x) => x.start.toISOString());
    expect(daily).toEqual(['2026-10-10T03:00:00.000Z', '2026-10-12T03:00:00.000Z']);
    expect(evs.some((x) => x.uid === 'gone@test')).toBe(false);
  });
  it('終日の予定を判別する', () => {
    expect(evs.find((x) => x.uid === 'allday@test')!.allDay).toBe(true);
  });
  it('開始順に並ぶ', () => {
    const t = evs.map((x) => x.start.getTime());
    expect([...t].sort((a, b) => a - b)).toEqual(t);
  });
});

describe('validateCalendarUrl', () => {
  it('Googleカレンダーのhttps iCal URLだけ通す', () => {
    expect(validateCalendarUrl('https://calendar.google.com/calendar/ical/x%40gmail.com/private-abc/basic.ics').ok).toBe(true);
    expect(validateCalendarUrl('http://calendar.google.com/a.ics').ok).toBe(false);
    expect(validateCalendarUrl('https://example.com/a.ics').ok).toBe(false);
    expect(validateCalendarUrl('https://calendar.google.com/a').ok).toBe(false);
    expect(validateCalendarUrl('nonsense').ok).toBe(false);
  });
});

describe('CalendarService', () => {
  const log = { debug() {}, info() {}, warn() {}, error() {} } as never;
  const now = new Date('2026-10-10T00:50:00Z');
  const mk = (fetchFn: typeof fetch) =>
    new CalendarService({ getUrl: () => 'https://calendar.google.com/calendar/ical/x/private-k/basic.ics', enabled: () => true, now: () => now, log, fetchFn });

  it('取得して直近の予定を返す', async () => {
    const svc = mk((async () => new Response(ICS)) as typeof fetch);
    expect((await svc.refresh()).ok).toBe(true);
    expect(svc.startingSoon(now, 15).map((e) => e.uid)).toEqual(['a@test']);
    expect(svc.startingSoon(now, 5)).toEqual([]);
  });
  it('失敗してもURLをエラーに含めず、前回の予定を残す', async () => {
    let ok = true;
    const svc = mk((async () => (ok ? new Response(ICS) : new Response('', { status: 404 }))) as typeof fetch);
    await svc.refresh();
    ok = false;
    const r = await svc.refresh();
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain('private-k');
    expect(r.count).toBeGreaterThan(0);
  });
});
