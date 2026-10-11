// 設定 > いちばん上: 使い始めるのに必要なものが揃っているかの一覧と、足りないものへの近道。
import { useState } from 'preact/hooks';
import type { AdminPage } from '@shared/ipc';
import type { ServiceStatus, Settings } from '@shared/types';
import { api } from '../api';
import { Button, Card, flash, Pill } from '../ui';

type Kind = 'ok' | 'todo' | 'optional' | 'wait';
interface Item {
  title: string;
  kind: Kind;
  detail: string;
  action?: { label: string; run(): void | Promise<void>; primary?: boolean };
}

const MARK: Record<Kind, { pill: 'ok' | 'error' | 'warn' | 'info'; label: string }> = {
  ok: { pill: 'ok', label: 'OK' },
  todo: { pill: 'error', label: '必要' },
  optional: { pill: 'warn', label: 'おすすめ' },
  wait: { pill: 'info', label: '準備中' },
};

const VOICEVOX_URL = 'https://voicevox.hiroshiba.jp/';

export function ReadinessCard(p: {
  s: Settings;
  status: ServiceStatus | null;
  hasKey: boolean;
  model: string;
  modelLoaded: boolean;
  pickModel(): Promise<void>;
  navigate(page: AdminPage): void;
}) {
  const { s, status } = p;
  const [starting, setStarting] = useState(false);
  const local = s.llm.provider === 'local';

  const items: Item[] = [
    local
      ? {
          title: '会話のAI（このPCのAI）',
          kind: status?.llm === 'ok' || status?.llm === 'fake' ? 'ok' : 'todo',
          detail: status?.llm === 'ok' || status?.llm === 'fake' ? `Ollama のモデル ${s.llm.localModel} で会話します` : 'Ollama に接続できません。下の「会話のAI」で接続を確認してください',
        }
      : status?.llm === 'fake'
        ? { title: '会話のAI（疑似LLM）', kind: 'ok', detail: '開発用の疑似LLMで動いています' }
        : {
            title: '会話のAI（Claude API）',
            kind: p.hasKey ? 'ok' : 'todo',
            detail: p.hasKey ? 'APIキーは登録済みです' : '会話にはAPIキーが必要です。キーなしでこのPCのAI（Ollama）を使うこともできます',
            action: p.hasKey ? undefined : { label: 'APIキーを登録', primary: true, run: () => p.navigate('setup') },
          },
    {
      title: 'キャラクターのモデル（PMX）',
      kind: p.modelLoaded ? 'ok' : 'optional',
      detail: p.modelLoaded ? p.model.split(/[\\/]/).pop() ?? '' : p.model ? '選んだモデルを読み込めていません（代替アバターで表示中）' : '未選択です。選ばなくても代替アバターで動きます',
      action: p.modelLoaded ? undefined : { label: 'モデルを選ぶ…', run: p.pickModel },
    },
    {
      title: '読み上げエンジン（VOICEVOX / AivisSpeech）',
      kind: status?.voicevox === 'ok' ? 'ok' : 'optional',
      detail: status?.voicevox === 'ok' ? '接続しています。声は「調声」画面で選べます' : '未接続です。今は Windows 標準の声で話します。VOICEVOX を入れると声を選べます',
      action:
        status?.voicevox === 'ok'
          ? { label: '声を選ぶ', run: () => p.navigate('voice') }
          : {
              label: starting ? '起動中…' : '起動する',
              run: async () => {
                setStarting(true);
                try {
                  const r = await api('voice:engine-start');
                  flash(r.ok ? r.message : `${r.message}。インストールしていなければ、配布ページから入れてください`, r.ok ? 'ok' : 'error');
                } finally {
                  setStarting(false);
                }
              },
            },
    },
    {
      title: '音声認識（話しかける）',
      kind: status?.sidecar === 'ok' ? 'ok' : status?.sidecar === 'starting' ? 'wait' : 'optional',
      detail:
        status?.sidecar === 'ok'
          ? `準備できています${status.sidecarDevice ? `（${status.sidecarDevice}）` : ''}`
          : status?.sidecar === 'starting'
            ? '起動中です。初回は音声認識のモデルをダウンロードするので数分かかります'
            : status?.sidecar === 'disabled'
              ? '音声認識が入っていません（開発版は npm run sidecar:setup）。文字入力では話せます'
              : '停止しています。自動で再起動を試みます。文字入力では話せます',
    },
    {
      title: 'あなたの呼び方',
      kind: s.user.callName.trim() ? 'ok' : 'optional',
      detail: s.user.callName.trim() ? `「${s.user.callName}」と呼びます` : '未設定です。下の「キャラクター」で決められます',
    },
  ];

  const todo = items.filter((i) => i.kind === 'todo').length;
  const rest = items.filter((i) => i.kind === 'optional').length;
  const voiceIn = s.voice.input !== 'off' && s.voice.micEnabled;

  return (
    <Card
      title="使い始めの確認"
      desc={todo ? `あと ${todo} つ設定すると会話できます。` : rest ? `会話できます。おすすめの設定があと ${rest} つあります。` : 'すべて準備できています。'}
      actions={!s.setupCompleted && <Button variant="primary" onClick={() => p.navigate('setup')}>はじめの設定を続ける</Button>}
    >
      <ul class="ready-list">
        {items.map((i) => (
          <li class={`ready-item ${i.kind}`}>
            <Pill kind={MARK[i.kind].pill}>{MARK[i.kind].label}</Pill>
            <div class="grow">
              <div class="ready-title">{i.title}</div>
              <div class="field-hint">{i.detail}</div>
            </div>
            {i.title.startsWith('読み上げ') && status?.voicevox !== 'ok' && (
              <Button small variant="ghost" onClick={() => api('app:open-external', VOICEVOX_URL)}>配布ページ</Button>
            )}
            {i.action && (
              <Button small variant={i.action.primary ? 'primary' : 'default'} disabled={starting && i.title.startsWith('読み上げ')} onClick={() => void i.action!.run()}>
                {i.action.label}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p class="ready-howto small">
        <b>話しかけ方:</b>{' '}
        {voiceIn ? (
          s.voice.input === 'wake' ? (
            <>名前で呼びかけてから話します（常時待受け）。</>
          ) : (
            <>
              <span class="kbd">{s.hotkeys.pushToTalk}</span> を押している間に話します。短く押すと文字の入力欄が開きます。
            </>
          )
        ) : (
          <>音声入力はOFFです。</>
        )}{' '}
        キャラクターを右クリックするとメニューが出ます。
      </p>
    </Card>
  );
}
