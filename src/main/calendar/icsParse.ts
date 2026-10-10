// Googleカレンダーの「非公開URL（iCal形式）」を読んで、指定期間の予定を取り出す。繰り返しの予定も展開する。
import ICAL from 'ical.js';

export interface CalEvent {
  uid: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location: string;
}

const MAX_EVENTS = 500;

/** [from, to) に開始する予定を、開始が早い順に返す。壊れた予定は読み飛ばす。 */
export function parseIcs(text: string, from: Date, to: Date): CalEvent[] {
  const out: CalEvent[] = [];
  const root = new ICAL.Component(ICAL.parse(text));
  // VTIMEZONE を登録しておくと TZID 付きの時刻を正しく変換できる
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(tz);
    } catch {
      /* 同名の再登録などは無視 */
    }
  }
  const events = root.getAllSubcomponents('vevent').map((c) => new ICAL.Event(c));
  // 繰り返しの一部だけ変更された回は、元の回を飛ばして変更後の予定だけを出す
  const overridden = new Set<string>();
  for (const ev of events) if (ev.isRecurrenceException()) overridden.add(`${ev.uid}|${ev.recurrenceId.toJSDate().getTime()}`);

  const push = (ev: InstanceType<typeof ICAL.Event>, start: InstanceType<typeof ICAL.Time>, end: InstanceType<typeof ICAL.Time>) => {
    const s = start.toJSDate();
    if (s < from || s >= to) return;
    if (ev.component.getFirstPropertyValue('status') === 'CANCELLED') return;
    out.push({
      uid: ev.uid,
      title: (ev.summary || '（タイトルなし）').trim(),
      start: s,
      end: end.toJSDate(),
      allDay: start.isDate,
      location: (ev.location || '').trim(),
    });
  };

  for (const ev of events) {
    try {
      if (ev.isRecurring()) {
        // 毎日の予定が何年も続いていても、数千回で打ち切る
        const it = ev.iterator();
        for (let n = 0; n < 5000; n++) {
          const next = it.next();
          if (!next) break;
          if (next.toJSDate() >= to) break;
          if (overridden.has(`${ev.uid}|${next.toJSDate().getTime()}`)) continue;
          const d = ev.getOccurrenceDetails(next);
          push(ev, d.startDate, d.endDate);
        }
      } else {
        push(ev, ev.startDate, ev.endDate);
      }
    } catch {
      /* 1件が壊れていても他は読む */
    }
    if (out.length >= MAX_EVENTS) break;
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}
