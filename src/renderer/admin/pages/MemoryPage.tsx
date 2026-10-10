// SC-11 memory: list by kind, search, edit, delete, delete all, export, affinity (spec 3.1, 7.3).
import { useEffect, useState } from 'preact/hooks';
import type { MemoryKind, MemoryRecord, MessageRecord, Relationship, SessionRecord } from '@shared/types';
import { api, fmtDateTime, onAdmin } from '../api';
import { Button, Card, Empty, flash, KIND_LABELS, Pill, Select, Slider, Tabs, Toggle } from '../ui';

type KindTab = 'all' | MemoryKind | 'trashed';

export function MemoryPage() {
  const [kind, setKind] = useState<KindTab>('all');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<MemoryRecord[]>([]);
  const [rel, setRel] = useState<(Relationship & { stage: number; stageName: string }) | null>(null);
  const [source, setSource] = useState<{ session: SessionRecord; messages: MessageRecord[]; focus: number } | null>(null);
  const [adding, setAdding] = useState({ kind: 'fact' as MemoryKind, content: '', importance: 0.6, pinned: false });

  const reload = async () => {
    const filter = kind === 'all' ? {} : kind === 'trashed' ? { status: 'trashed' as const } : { kind };
    setItems(await api('memory:list', { ...filter, query: q || undefined }));
    setRel(await api('relationship:get'));
  };
  useEffect(() => void reload(), [kind, q]);
  useEffect(() => onAdmin('admin:memory-changed', () => void reload()), [kind, q]);

  const update = async (id: number, patch: Partial<MemoryRecord>) => {
    await api('memory:update', id, patch);
    await reload();
  };

  return (
    <div class="page">
      <div class="row between">
        <h1>記憶</h1>
        <div class="row gap">
          <Button onClick={async () => { const p = await api('memory:export'); if (p) flash(`書き出しました: ${p}`); }}>JSONで書き出し</Button>
          <Button
            variant="danger"
            onClick={async () => {
              if (!confirm('記憶・会話ログ・親密度をすべて消去します。元に戻せません。よろしいですか？')) return;
              await api('memory:delete-all');
              flash('すべて消去しました');
              await reload();
            }}
          >
            すべて消去
          </Button>
        </div>
      </div>

      {rel && (
        <Card>
          <div class="rel">
            <div>
              <div class="muted small">親密度</div>
              <div class="rel-value">{rel.affinity.toFixed(0)}<span class="small muted"> / 100</span></div>
              <Pill kind="info">段階{rel.stage + 1}「{rel.stageName}」</Pill>
            </div>
            <div class="grow">
              <div class="meter big"><div class="meter-bar" style={{ width: `${rel.affinity}%` }} /></div>
              <div class="stages small muted"><span>初対面</span><span>顔なじみ</span><span>親しい</span><span>相棒</span></div>
            </div>
            <div>
              <div class="muted small">機嫌</div>
              <div class="rel-value">{rel.mood >= 0.3 ? 'ごきげん' : rel.mood <= -0.3 ? 'しょんぼり' : 'ふつう'}</div>
              <div class="small muted">初めて会った日 {fmtDateTime(rel.firstMetAt).slice(0, 10)}</div>
            </div>
          </div>
        </Card>
      )}

      <Card title="覚えていること">
        <div class="row between wrap gap">
          <Tabs
            value={kind}
            onChange={(v) => setKind(v as KindTab)}
            tabs={[
              { id: 'all', label: 'すべて' },
              ...(['profile', 'preference', 'fact', 'episode', 'schedule'] as MemoryKind[]).map((k) => ({ id: k, label: KIND_LABELS[k] })),
              { id: 'trashed', label: 'ごみ箱' },
            ]}
          />
          <input class="search" placeholder="検索" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>

        {kind !== 'trashed' && (
          <div class="add-memory row gap">
            <Select value={adding.kind} options={(['profile', 'preference', 'fact', 'episode', 'schedule'] as MemoryKind[]).map((k) => ({ value: k, label: KIND_LABELS[k] }))} onChange={(v) => setAdding({ ...adding, kind: v })} />
            <input class="grow" placeholder="覚えてほしいことを1文で（例: 研究テーマは音声対話）" value={adding.content} onInput={(e) => setAdding({ ...adding, content: (e.target as HTMLInputElement).value })} />
            <Toggle checked={adding.pinned} onChange={(v) => setAdding({ ...adding, pinned: v })} label="常に使う" />
            <Button variant="primary" disabled={!adding.content.trim()} onClick={async () => { await api('memory:add', { ...adding, content: adding.content.trim() }); setAdding({ ...adding, content: '' }); flash('追加しました'); await reload(); }}>追加</Button>
          </div>
        )}

        {items.length === 0 ? (
          <Empty>{kind === 'trashed' ? 'ごみ箱は空です' : 'まだ何も覚えていません。会話の中で「覚えて」と言うか、ここで追加できます。'}</Empty>
        ) : (
          <ul class="memories">
            {items.map((m) => (
              <MemoryRow
                m={m}
                onUpdate={(patch) => update(m.id, patch)}
                onDelete={async () => { await api('memory:delete', m.id); await reload(); }}
                onSource={async () => {
                  if (!m.sourceMessageId) return;
                  const r = await api('memory:source', m.sourceMessageId);
                  if (r) setSource({ ...r, focus: m.sourceMessageId });
                }}
              />
            ))}
          </ul>
        )}
      </Card>

      {source && (
        <div class="modal" onClick={() => setSource(null)}>
          <div class="modal-body" onClick={(e) => e.stopPropagation()}>
            <div class="row between">
              <h3>根拠になった会話（{fmtDateTime(source.session.startedAt)}）</h3>
              <Button variant="ghost" onClick={() => setSource(null)}>閉じる</Button>
            </div>
            <div class="chat">
              {source.messages.map((msg) => (
                <div class={`msg ${msg.role} ${msg.id === source.focus ? 'focus' : ''}`}>{msg.content.replace(/\[[a-z]+(:[0-9.]+)?\]\s?/g, '')}</div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MemoryRow(p: { m: MemoryRecord; onUpdate(patch: Partial<MemoryRecord>): void; onDelete(): void; onSource(): void }) {
  const { m } = p;
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(m.content);
  const trashed = m.status === 'trashed';
  return (
    <li class={`memory ${m.status}`}>
      <div class="row gap">
        <Pill kind={m.kind === 'schedule' ? 'warn' : 'info'}>{KIND_LABELS[m.kind]}</Pill>
        {m.pinned && <Pill kind="ok">常に使う</Pill>}
        {m.status === 'archived' && <Pill kind="info">保管庫</Pill>}
        {edit ? (
          <input class="grow" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} onKeyDown={(e) => { if (e.key === 'Enter') { p.onUpdate({ content: text }); setEdit(false); } }} />
        ) : (
          <span class="grow mem-text" onDblClick={() => !trashed && setEdit(true)}>{m.content}{m.dueAt && <span class="muted small">（期日 {fmtDateTime(m.dueAt)}）</span>}</span>
        )}
      </div>
      <div class="row gap small muted mem-meta">
        <span>重要度</span>
        <div class="w160"><Slider value={m.importance} min={0} max={1} step={0.05} onInput={(v) => p.onUpdate({ importance: v })} disabled={trashed} /></div>
        <span>使用 {m.useCount}回</span>
        <span>更新 {fmtDateTime(m.updatedAt)}</span>
        <span class="grow" />
        {!trashed && <Toggle checked={m.pinned} onChange={(v) => p.onUpdate({ pinned: v })} label="常に使う" />}
        {m.sourceMessageId && <Button small variant="ghost" onClick={p.onSource}>根拠</Button>}
        {!trashed && !edit && <Button small variant="ghost" onClick={() => setEdit(true)}>編集</Button>}
        {edit && <Button small variant="primary" onClick={() => { p.onUpdate({ content: text }); setEdit(false); }}>保存</Button>}
        {trashed ? (
          <Button small onClick={() => p.onUpdate({ status: 'active' })}>元に戻す</Button>
        ) : (
          <Button small variant="ghost" onClick={p.onDelete}>削除</Button>
        )}
      </div>
    </li>
  );
}
