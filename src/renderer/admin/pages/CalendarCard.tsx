// Googleカレンダー連携の設定。非公開のiCal URLを登録すると、予定の少し前に声をかけてくれる。
import { useEffect, useState } from 'preact/hooks';
import type { DeepPartial } from '@shared/ipc';
import type { Settings } from '@shared/types';
import { api } from '../api';
import { Button, Card, Field, flash, Select, Toggle } from '../ui';

type Status = { hasUrl: boolean; masked: string; lastSyncAt: string | null; error: string | null; upcoming: string[] };

export function CalendarCard({ s, set }: { s: Settings; set: (p: DeepPartial<Settings>, msg?: string) => Promise<void> }) {
  const [st, setSt] = useState<Status | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => setSt(await api('calendar:status'));
  useEffect(() => void load(), []);

  const save = async () => {
    setBusy(true);
    const r = await api('calendar:set-url', url.trim());
    setBusy(false);
    if (r.ok) {
      setUrl('');
      flash(url.trim() ? `登録しました（今後48時間の予定 ${r.count ?? 0} 件）` : '登録を消しました');
    } else flash(r.error ?? '登録できませんでした', 'error');
    await load();
  };

  const sync = async () => {
    setBusy(true);
    const r = await api('calendar:sync');
    setBusy(false);
    if (r.ok) flash(`更新しました（今後48時間の予定 ${r.count ?? 0} 件）`);
    else flash(r.error ?? '更新できませんでした', 'error');
    await load();
  };

  return (
    <Card title="Googleカレンダー" desc="予定の少し前に声をかけます。Googleカレンダーの「非公開URL（iCal形式）」を登録してください。読み取り専用で、予定の追加や変更はできません。">
      <div class="grid2">
        <Field label="予定をお知らせする"><Toggle checked={s.calendar.enabled} onChange={(v) => set({ calendar: { enabled: v } })} /></Field>
        <Field label="何分前に知らせる">
          <Select
            value={String(s.calendar.leadMinutes)}
            options={[{ value: '5', label: '5分前' }, { value: '10', label: '10分前' }, { value: '15', label: '15分前' }, { value: '30', label: '30分前' }]}
            onChange={(v) => set({ calendar: { leadMinutes: Number(v) as 5 | 10 | 15 | 30 } })}
          />
        </Field>
        <Field
          label="非公開URL"
          wide
          hint={
            st?.hasUrl
              ? `登録済み: ${st.masked}${st.lastSyncAt ? ` ／ 最終更新 ${new Date(st.lastSyncAt).toLocaleTimeString('ja-JP')}` : ''}${st.error ? ` ／ ${st.error}` : ''}`
              : 'Googleカレンダーの設定 →「カレンダーの統合」→「iCal形式の非公開URL」をコピーして貼り付けます。このURLを知っている人は予定を見られるので、他人に見せないでください'
          }
        >
          <div class="row gap">
            <input type="password" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} autocomplete="off" />
            <Button variant="primary" disabled={busy || !url.trim()} onClick={save}>登録</Button>
            <Button disabled={busy || !st?.hasUrl} onClick={sync}>今すぐ更新</Button>
            {st?.hasUrl && (
              <Button
                disabled={busy}
                onClick={async () => {
                  setUrl('');
                  await api('calendar:set-url', '');
                  flash('登録を消しました');
                  await load();
                }}
              >
                削除
              </Button>
            )}
          </div>
        </Field>
        {st && st.upcoming.length > 0 && (
          <Field label="今後24時間の予定" wide>
            <ul class="small">
              {st.upcoming.map((e) => <li>{e}</li>)}
            </ul>
          </Field>
        )}
      </div>
    </Card>
  );
}
