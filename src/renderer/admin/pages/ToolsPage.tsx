// SC-13 tool log with undo (FR-TL-10).
import { useEffect, useState } from 'preact/hooks';
import type { ToolRunRecord } from '@shared/types';
import { api, fmtDateTime, onAdmin } from '../api';
import { Button, Card, Empty, flash, Pill } from '../ui';

const DECISION: Record<string, { label: string; kind: 'ok' | 'warn' | 'error' | 'info' }> = {
  auto: { label: '自動', kind: 'info' },
  approved: { label: '許可', kind: 'ok' },
  denied: { label: '拒否', kind: 'warn' },
  timeout: { label: '時間切れ', kind: 'warn' },
  blocked: { label: 'ブロック', kind: 'error' },
};

function short(json: string, n = 140): string {
  try {
    const v = JSON.parse(json);
    const s = typeof v === 'object' && v && 'content' in v ? String((v as { content: unknown }).content) : JSON.stringify(v);
    return s.length > n ? `${s.slice(0, n)}…` : s;
  } catch {
    return json.slice(0, n);
  }
}

export function ToolsPage() {
  const [runs, setRuns] = useState<ToolRunRecord[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const reload = async () => setRuns(await api('tool-log:list', 200));
  useEffect(() => {
    void reload();
    return onAdmin('admin:tool-run', () => void reload());
  }, []);

  return (
    <div class="page">
      <h1>作業履歴</h1>
      <Card desc="実行した作業と結果です。ファイルの作成・上書き・移動は取り消せます（上書き前の内容は30日間保管）。">
        {runs.length === 0 ? (
          <Empty>まだ作業の記録はありません</Empty>
        ) : (
          <table class="table">
            <thead>
              <tr><th>日時</th><th>作業</th><th>レベル</th><th>判定</th><th>内容</th><th /></tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <>
                  <tr class="clickable" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td class="nowrap small">{fmtDateTime(r.createdAt)}</td>
                    <td class="mono small">{r.tool}</td>
                    <td><Pill kind={r.level === 'L2' ? 'error' : r.level === 'L1' ? 'warn' : 'info'}>{r.level}</Pill></td>
                    <td><Pill kind={DECISION[r.decision]?.kind}>{DECISION[r.decision]?.label ?? r.decision}</Pill></td>
                    <td class="small">{short(r.argsJson, 80)}</td>
                    <td class="nowrap">
                      {r.undoJson && !r.undoneAt && (
                        <Button
                          small
                          onClick={async (e) => {
                            e.stopPropagation();
                            const res = await api('tool-log:undo', r.id);
                            flash(res.message, res.ok ? 'ok' : 'error');
                            await reload();
                          }}
                        >
                          取り消す
                        </Button>
                      )}
                      {r.undoneAt && <span class="muted small">取り消し済み</span>}
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr class="detail-row">
                      <td colSpan={6}>
                        <div class="small"><b>引数</b><pre>{r.argsJson}</pre></div>
                        <div class="small"><b>結果</b><pre>{short(r.resultJson, 2000)}</pre></div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
