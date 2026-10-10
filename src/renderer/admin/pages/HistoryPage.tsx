// SC-12 conversation history: sessions by date, full-text search (FTS5 trigram).
import { useEffect, useState } from 'preact/hooks';
import type { SearchHit } from '@shared/ipc';
import type { MessageRecord, SessionRecord } from '@shared/types';
import { EMOTION_LABELS, type Emotion } from '@shared/emotions';
import { api, fmtDateTime } from '../api';
import { Card, Empty } from '../ui';

const strip = (s: string) => s.replace(/<detail>[\s\S]*?(<\/detail>|$)/g, '［詳細］').replace(/\[[a-z]+(:[0-9.]+)?\]\s?/g, '');

export function HistoryPage() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [msgs, setMsgs] = useState<MessageRecord[]>([]);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);

  useEffect(() => {
    void api('history:sessions', 100, 0).then((s) => {
      setSessions(s);
      if (s[0]) setSel(s[0].id);
    });
  }, []);
  useEffect(() => {
    if (sel !== null) void api('history:messages', sel).then(setMsgs);
  }, [sel]);
  useEffect(() => {
    const t = setTimeout(async () => setHits(q.trim() ? await api('history:search', q) : null), 250);
    return () => clearTimeout(t);
  }, [q]);

  const byDay = new Map<string, SessionRecord[]>();
  for (const s of sessions) {
    const day = s.startedAt.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), s]);
  }

  return (
    <div class="page">
      <div class="row between">
        <h1>会話履歴</h1>
        <input class="search" placeholder="全文検索（3文字以上が速い）" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </div>
      {hits ? (
        <Card title={`検索結果 ${hits.length}件`}>
          {hits.length === 0 ? (
            <Empty>見つかりませんでした</Empty>
          ) : (
            <ul class="hits">
              {hits.map((h) => (
                <li onClick={() => { setSel(h.message.sessionId); setQ(''); }}>
                  <span class="muted small">{fmtDateTime(h.message.createdAt)} {h.message.role === 'user' ? 'あなた' : 'アシスタント'}</span>
                  <div>{strip(h.snippet)}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <div class="split">
          <div class="card session-list">
            {sessions.length === 0 && <Empty>まだ会話がありません</Empty>}
            {[...byDay.entries()].map(([day, list]) => (
              <div>
                <div class="day">{day}</div>
                {list.map((s) => (
                  <button type="button" class={`session ${s.id === sel ? 'active' : ''}`} onClick={() => setSel(s.id)}>
                    <span>{fmtDateTime(s.startedAt).slice(11)}〜{s.endedAt ? fmtDateTime(s.endedAt).slice(11) : ''}</span>
                    {s.noMemory && <span class="pill warn">記憶しない</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div class="card chat-pane">
            <div class="chat">
              {msgs.map((m) => (
                <div class={`msg ${m.role} ${m.source}`}>
                  <div class="msg-meta small muted">
                    {fmtDateTime(m.createdAt).slice(11)} {m.source === 'voice' ? '🎤' : m.source === 'proactive' ? '（声かけ）' : ''}
                    {m.emotion && m.role === 'assistant' ? ` ${EMOTION_LABELS[m.emotion as Emotion] ?? ''}` : ''}
                  </div>
                  {m.source === 'proactive' && m.role === 'user' ? <i class="muted">（アプリからの声かけ）</i> : strip(m.content)}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
