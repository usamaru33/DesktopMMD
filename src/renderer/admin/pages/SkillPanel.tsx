// 設定 > キャラクター: skill.md（キャラクタースキル）の状態と操作。
import { useEffect, useState } from 'preact/hooks';
import type { SkillStatus } from '@shared/types';
import { api, onAdmin } from '../api';
import { Button, Field, flash, Pill, Select } from '../ui';

export function useSkillStatus(): [SkillStatus | null, () => Promise<void>] {
  const [st, setSt] = useState<SkillStatus | null>(null);
  const reload = async () => setSt(await api('character:skill-status'));
  useEffect(() => {
    void reload();
    return onAdmin('admin:settings-changed', () => void reload());
  }, []);
  return [st, reload];
}

export function SkillPanel(p: { status: SkillStatus | null; reload(): Promise<void> }) {
  const st = p.status;
  const [mode, setMode] = useState<{ list: string[]; current: string | null } | null>(null);
  useEffect(() => void api('character:mode-get').then(setMode), [st?.state, st?.overlays.join(',')]);
  if (!st) return null;
  const errors = st.issues.filter((i) => i.level === 'error');
  const warnings = st.issues.filter((i) => i.level === 'warning');

  const create = async (kind: 'draft' | 'sample') => {
    const r = await api('character:skill-create', kind);
    if (r.ok) flash('skill.md を作りました。エディタで開いたので、書き終えて保存すると読み込まれます');
    else flash(r.error ?? '作れませんでした', 'error');
    await p.reload();
  };

  return (
    <Field
      label="キャラクタースキル（skill.md）"
      wide
      hint="性格と口調を skill.md に書くと、下の「性格と口調」の代わりに使われます。保存すると次の発話から反映されます。書き方は README の「キャラクタースキルの書き方」へ"
    >
      <div class="skill-panel">
        <div class="row gap wrap">
          {st.state === 'ok' && <Pill kind="ok">使用中</Pill>}
          {st.state === 'invalid' && <Pill kind="error">エラーがあるため使っていません</Pill>}
          {st.state === 'none' && <Pill kind="info">なし（「性格と口調」を使用）</Pill>}
          {st.name && <b>{st.name}</b>}
          {st.version && <span class="muted small">v{st.version}</span>}
          {st.state !== 'none' && <span class="muted small">本文 {st.chars} 文字（推奨 1,500〜2,500）</span>}
        </div>
        <div class="mono muted small">{st.path}</div>

        {(errors.length > 0 || warnings.length > 0) && (
          <ul class="skill-issues">
            {[...errors, ...warnings].slice(0, 12).map((i) => (
              <li class={i.level}>
                <span class={`pill ${i.level === 'error' ? 'error' : 'warn'}`}>{i.level === 'error' ? 'エラー' : '警告'}</span>
                {i.line > 0 && <span class="mono muted">{i.line}行目</span>} {i.message}
              </li>
            ))}
            {errors.length + warnings.length > 12 && <li class="muted small">ほか {errors.length + warnings.length - 12} 件</li>}
          </ul>
        )}

        <div class="row gap wrap">
          <Button small onClick={() => api('character:open-folder')}>フォルダを開く</Button>
          {st.state === 'none' && (
            <>
              <Button small variant="primary" onClick={() => create('draft')} title="今の名前・一人称・性格を下書きに入れたテンプレートから作ります">今の設定から下書きを作る</Button>
              <Button small onClick={() => create('sample')} title="サンプル（灯野ほたる）をコピーします">サンプルから作る</Button>
            </>
          )}
          <Button small variant="ghost" onClick={async () => { await p.reload(); flash('読み直しました'); }}>状態を更新</Button>
          {mode && mode.list.length > 0 && (
            <label class="row gap small nowrap">
              モード
              <Select
                value={mode.current ?? ''}
                options={[{ value: '', label: 'なし（基本）' }, ...mode.list.map((m) => ({ value: m, label: m }))]}
                onChange={async (v) => {
                  const r = await api('character:mode-set', v === '' ? null : v);
                  if (r.ok) setMode({ ...mode, current: r.current });
                  else flash(r.error ?? '切り替えられませんでした', 'error');
                }}
              />
            </label>
          )}
        </div>
      </div>
    </Field>
  );
}
