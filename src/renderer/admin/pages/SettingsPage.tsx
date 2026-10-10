// SC-10 settings: API key, models, character, voice input, permissions, proactive speech, display, privacy.
import { useEffect, useState } from 'preact/hooks';
import type { DeepPartial, EngineInfo } from '@shared/ipc';
import type { CharacterPreset, McpServerConfig, PermissionLevel, ServiceStatus, Settings, UsageBreakdownRow, UsageSummary } from '@shared/types';
import { GAZE_LIMIT_RANGE } from '@shared/defaults';
import { EMOTIONS, EMOTION_LABELS } from '@shared/emotions';
import { api, onAdmin } from '../api';
import { Button, Card, Field, flash, Pill, Select, Slider, Toggle } from '../ui';
import { CalendarCard } from './CalendarCard';
import { SkillPanel, useSkillStatus } from './SkillPanel';

const TOOL_LEVELS: { name: string; title: string; level: PermissionLevel }[] = [
  { name: 'read_file', title: 'ファイルを読む', level: 'L0' },
  { name: 'list_dir', title: 'フォルダの中を見る', level: 'L0' },
  { name: 'search_files', title: 'ファイルを探す', level: 'L0' },
  { name: 'write_file', title: 'ファイルに書き込む', level: 'L1' },
  { name: 'move_file', title: 'ファイルを移動', level: 'L1' },
  { name: 'rename_file', title: '名前を変更', level: 'L1' },
  { name: 'open_app', title: 'アプリを起動', level: 'L1' },
  { name: 'open_url', title: 'Webページを開く', level: 'L1' },
  { name: 'open_path', title: 'フォルダやファイルを開く', level: 'L1' },
  { name: 'clipboard_read', title: 'クリップボードを読む', level: 'L1' },
  { name: 'clipboard_write', title: 'クリップボードに書く', level: 'L1' },
  { name: 'take_screenshot', title: '画面を撮影', level: 'L1' },
  { name: 'delete_file', title: 'ファイルを削除', level: 'L2' },
  { name: 'run_command', title: 'コマンド実行', level: 'L2' },
];

const NL = String.fromCharCode(10);

const PURPOSE_LABEL: Record<string, string> = {
  chat: '会話の返答',
  tool_followup: '作業のあとの返答',
  proactive: '声かけ',
  extract: '記憶の抽出',
  conflict: '記憶の矛盾判定',
  summary: '会話の要約',
  other: 'その他（内訳の記録前）',
};
const MODEL_LABEL: Record<string, string> = {
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-opus-5-5': 'Opus 5.5',
};
const fmtTok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** 読み上げエンジン（VOICEVOX / AivisSpeech）の自動起動と場所 */
function EngineSettings(p: { s: Settings; set(patch: DeepPartial<Settings>, msg?: string): Promise<void>; running: boolean }) {
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = async () => setInfo(await api('voice:engine-info'));
  useEffect(() => void reload(), [p.s.voice.enginePath, p.running]);
  const start = async () => {
    setBusy(true);
    try {
      const r = await api('voice:engine-start');
      flash(r.message, r.ok ? 'ok' : 'error');
    } finally {
      setBusy(false);
      await reload();
    }
  };
  return (
    <div class="grid2" style={{ marginTop: '12px' }}>
      <Field label="アプリ起動時に読み上げエンジンも起動する" hint="調声画面で選んだエンジン（VOICEVOX / AivisSpeech）が動いていなければ裏で起動し、アプリを終了するときに一緒に止めます（自分で起動したものには触りません）">
        <Toggle checked={p.s.voice.autoStartEngine} onChange={(v) => p.set({ voice: { autoStartEngine: v } })} />
      </Field>
      <Field label="エンジンの場所" hint={info?.path ? `使うエンジン: ${info.path}` : '見つかりません。VOICEVOX / AivisSpeech をインストールするか、場所を指定してください'}>
        <div class="row gap">
          <input class="grow" value={p.s.voice.enginePath} placeholder="自動で探す" onChange={(e) => p.set({ voice: { enginePath: (e.target as HTMLInputElement).value.trim() } })} />
          <Button
            small
            onClick={async () => {
              const f = await api('voice:pick-engine');
              if (f.path) await p.set({ voice: { enginePath: f.path } });
              else if (!f.canceled) flash('そこには読み上げエンジン（vv-engine / AivisSpeech-Engine フォルダの run.exe）が見つかりません', 'error');
            }}
          >
            参照…
          </Button>
          {p.s.voice.enginePath && <Button small variant="ghost" onClick={() => p.set({ voice: { enginePath: '' } })}>自動に戻す</Button>}
        </div>
      </Field>
      <Field label="エンジンの状態">
        <div class="row gap">
          {p.running ? <Pill kind="ok">接続中{info?.ownsEngine ? '（このアプリが起動）' : ''}</Pill> : <Pill kind="warn">未接続</Pill>}
          {!p.running && <Button small disabled={busy || !info?.path} onClick={start}>{busy ? '起動中…' : '今すぐ起動'}</Button>}
        </div>
      </Field>
    </div>
  );
}

function UsageBreakdown() {
  const [rows, setRows] = useState<UsageBreakdownRow[] | null>(null);
  useEffect(() => void api('usage:breakdown').then(setRows), []);
  if (!rows) return null;
  if (!rows.length) return <p class="muted small">今月はまだAPIを使っていません。</p>;
  const total = rows.reduce((s, r) => s + r.usd, 0);
  return (
    <table class="table compact">
      <thead>
        <tr><th>処理</th><th>モデル</th><th>回数</th><th>入力</th><th>うちキャッシュ読込</th><th>出力</th><th>金額</th><th>割合</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr>
            <td>{PURPOSE_LABEL[r.purpose] ?? r.purpose}</td>
            <td class="small">{MODEL_LABEL[r.model] ?? r.model}</td>
            <td>{r.requests}</td>
            <td>{fmtTok(r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens)}</td>
            <td>{fmtTok(r.cacheReadTokens)}</td>
            <td>{fmtTok(r.outputTokens)}</td>
            <td>${r.usd.toFixed(3)}</td>
            <td>{total > 0 ? Math.round((r.usd / total) * 100) : 0}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
const LEVEL_LABEL: Record<PermissionLevel, string> = { L0: 'L0 自動', L1: 'L1 確認', L2: 'L2 承認' };
const RANK: Record<PermissionLevel, number> = { L0: 0, L1: 1, L2: 2 };

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [key, setKey] = useState<{ hasKey: boolean; masked: string } | null>(null);
  const [newKey, setNewKey] = useState('');
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [ch, setCh] = useState<CharacterPreset | null>(null);
  const [chars, setChars] = useState<{ id: string; name: string }[]>([]);
  const [morph, setMorph] = useState<{ found: string[]; missing: string[]; modelLoaded: boolean } | null>(null);
  const [newChar, setNewChar] = useState('');
  const [skill, reloadSkill] = useSkillStatus();

  const reload = async () => {
    setS(await api('settings:get'));
    setKey(await api('secrets:status'));
    setUsage(await api('usage:get'));
    setStatus(await api('status:get'));
    setCh(await api('character:get'));
    setChars(await api('character:list'));
    setMorph(await api('character:morph-report'));
  };
  useEffect(() => {
    void reload();
    const off1 = onAdmin('admin:status', (st) => setStatus(st as ServiceStatus));
    const off2 = onAdmin('admin:settings-changed', async () => setS(await api('settings:get')));
    return () => {
      off1();
      off2();
    };
  }, []);

  if (!s || !ch) return <div class="loading">読み込み中…</div>;

  const set = async (patch: DeepPartial<Settings>, msg = '保存しました') => {
    setS(await api('settings:set', patch));
    if (msg) flash(msg);
  };
  const saveChar = async (patch: Partial<CharacterPreset>) => {
    const next = { ...ch, ...patch };
    setCh(next);
    const r = await api('character:save', next);
    if (r.ok) flash('キャラクター設定を保存しました');
    else flash(r.error ?? '保存できませんでした', 'error');
    setTimeout(async () => setMorph(await api('character:morph-report')), 3000);
  };

  return (
    <div class="page">
      <h1>設定</h1>

      <Card title="サービスの状態">
        <div class="status-grid">
          <div>
            Claude API{' '}
            {status?.llm === 'ok' ? <Pill kind="ok">接続可</Pill> : status?.llm === 'fake' ? <Pill kind="info">疑似LLM</Pill> : <Pill kind="error">APIキー未設定</Pill>}
          </div>
          <div>
            VOICEVOX {status?.voicevox === 'ok' ? <Pill kind="ok">接続中</Pill> : <Pill kind="warn">未接続（Windows音声で代替）</Pill>}
          </div>
          <div>
            音声認識{' '}
            {status?.sidecar === 'ok' ? (
              <Pill kind="ok">準備完了 {status.sidecarDevice ? `(${status.sidecarDevice})` : ''}</Pill>
            ) : status?.sidecar === 'starting' ? (
              <Pill kind="info">起動中…（初回はモデルのダウンロードに時間がかかります）</Pill>
            ) : status?.sidecar === 'disabled' ? (
              <Pill kind="warn">未インストール（npm run sidecar:setup）</Pill>
            ) : (
              <Pill kind="error">停止</Pill>
            )}
          </div>
          {status?.mcp.map((m) => (
            <div>
              MCP {m.name} <Pill kind={m.status === 'ok' ? 'ok' : m.status === 'error' ? 'error' : 'info'}>{m.status === 'ok' ? `${m.tools}ツール` : m.status}</Pill>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Claude API" desc="APIキーはWindowsの暗号化領域（DPAPI）に保存され、画面には表示されません。">
        <div class="grid2">
          <Field label="APIキー" hint={key?.hasKey ? `登録済み: ${key.masked}` : '未登録'}>
            <div class="row gap">
              <input type="password" placeholder="sk-ant-…" value={newKey} onInput={(e) => setNewKey((e.target as HTMLInputElement).value)} autocomplete="off" />
              <Button
                variant="primary"
                disabled={!newKey.trim()}
                onClick={async () => {
                  const r = await api('secrets:set-api-key', newKey.trim());
                  if (r.ok) {
                    setNewKey('');
                    setKey(await api('secrets:status'));
                    flash('APIキーを保存しました');
                  } else flash(r.error ?? '保存できませんでした', 'error');
                }}
              >
                保存
              </Button>
            </div>
          </Field>
          <Field label="今月の利用額（目安）" hint={usage?.degraded ? '上限に達したため軽量モデルで応答しています' : `今日 $${usage?.todayUsd.toFixed(3) ?? '0'}`}>
            <div class="meter">
              <div class={`meter-bar ${usage && usage.monthUsd >= usage.budgetUsd * 0.8 ? 'warn' : ''}`} style={{ width: `${usage ? Math.min(100, (usage.monthUsd / Math.max(0.01, usage.budgetUsd)) * 100) : 0}%` }} />
            </div>
            <span class="small">
              ${usage?.monthUsd.toFixed(2) ?? '0.00'} / ${s.llm.monthlyBudgetUsd}
            </span>
          </Field>
          <Field label="会話モデル">
            <Select value={s.llm.chatModel} options={[{ value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（標準）' }, { value: 'claude-opus-5-5', label: 'Claude Opus 5.5（高性能・高価）' }, { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5（軽量）' }]} onChange={(v) => set({ llm: { chatModel: v } })} />
          </Field>
          <Field label="声かけのモデル" hint="挨拶・休憩の提案・リマインダーなど短いセリフに使います">
            <Select value={s.llm.proactiveModel} options={[{ value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5（安い）' }, { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }]} onChange={(v) => set({ llm: { proactiveModel: v } })} />
          </Field>
          <Field label="内部処理モデル" hint="記憶の抽出・要約に使います">
            <Select value={s.llm.utilityModel} options={[{ value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }, { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }]} onChange={(v) => set({ llm: { utilityModel: v } })} />
          </Field>
          <Field label="考える深さ（effort）" hint="低いほど返事が速く安くなります">
            <Select value={s.llm.effort} options={[{ value: 'low', label: '低（速い）' }, { value: 'medium', label: '中' }, { value: 'high', label: '高（じっくり）' }]} onChange={(v) => set({ llm: { effort: v } })} />
          </Field>
          <Field label="キャッシュの保持時間" hint="1時間: 間をあけて話しかけても安く済む（おすすめ）。5分: 続けて話すことが多いならわずかに安い">
            <Select value={s.llm.cacheTtl} options={[{ value: '1h', label: '1時間（おすすめ）' }, { value: '5m', label: '5分' }]} onChange={(v) => set({ llm: { cacheTtl: v } })} />
          </Field>
          <Field label="月の上限額（米ドル）" hint="80%で警告、100%で軽量モデルに切替">
            <input type="number" min={0} step={1} value={s.llm.monthlyBudgetUsd} onChange={(e) => set({ llm: { monthlyBudgetUsd: Number((e.target as HTMLInputElement).value) } })} />
          </Field>
          <Field label="今月の内訳" wide hint="金額はAnthropicの公開価格からの推定です（実際の請求はコンソールで確認してください）">
            <UsageBreakdown />
          </Field>
        </div>
      </Card>

      <Card
        title="キャラクター"
        desc="モデル（PMX）は読み込むだけで、書き換えもコピーもしません。モデルの利用規約を守って使ってください。"
        actions={
          <>
            <Select value={s.activeCharacter} options={chars.map((c) => ({ value: c.id, label: c.name }))} onChange={async (v) => { await api('character:activate', v); setCh(await api('character:get')); flash('キャラクターを切り替えました'); }} />
            <input class="w160" placeholder="新しいキャラクター名" value={newChar} onInput={(e) => setNewChar((e.target as HTMLInputElement).value)} />
            <Button small disabled={!newChar.trim()} onClick={async () => { const { id } = await api('character:create', newChar.trim()); setNewChar(''); await api('character:activate', id); setChars(await api('character:list')); setCh(await api('character:get')); }}>新規作成</Button>
          </>
        }
      >
        <div class="grid2">
          <Field label="名前" hint={skill?.state === 'ok' && skill.name ? `会話では skill.md の名前「${skill.name}」を名乗ります（ここは一覧の表示名）` : undefined}><input value={ch.name} onChange={(e) => saveChar({ name: (e.target as HTMLInputElement).value })} /></Field>
          <Field label="一人称"><input value={ch.firstPerson} onChange={(e) => saveChar({ firstPerson: (e.target as HTMLInputElement).value })} /></Field>
          <Field label="ユーザーの呼び方"><input value={s.user.callName} placeholder="例: ゆうたろうさん" onChange={(e) => set({ user: { callName: (e.target as HTMLInputElement).value } })} /></Field>
          <Field label="表示倍率"><Slider value={s.window.scale} min={0.5} max={2} step={0.05} onInput={(v) => set({ window: { scale: v } }, '')} /></Field>
          <SkillPanel status={skill} reload={reloadSkill} />
          <Field label="性格と口調" wide hint={skill?.state === 'ok' ? 'skill.md を使用中のため、この欄・一人称・口調の例は会話に使われません' : undefined}>
            <textarea rows={3} value={ch.persona} onChange={(e) => saveChar({ persona: (e.target as HTMLTextAreaElement).value })} />
          </Field>
          <Field label="親密度の段階ごとの口調の例" wide hint="1行に1文。プロンプトの「関係性」に入ります（初対面 → 顔なじみ → 親しい → 相棒）">
            <div class="grid2">
              {['初対面', '顔なじみ', '親しい', '相棒'].map((label, i) => (
                <label class="field">
                  <span class="field-hint">{label}</span>
                  <textarea
                    rows={2}
                    value={(ch.speechExamples[i] ?? []).join(NL)}
                    onChange={(e) => {
                      const next = [0, 1, 2, 3].map((j) => ch.speechExamples[j] ?? []);
                      next[i] = (e.target as HTMLTextAreaElement).value.split(NL).map((x) => x.trim()).filter(Boolean);
                      void saveChar({ speechExamples: next });
                    }}
                  />
                </label>
              ))}
            </div>
          </Field>
          <Field label="モデル（PMX）" wide hint={morph ? (morph.modelLoaded ? `読み込み済み。見つからない表情: ${morph.missing.join('、') || 'なし'}` : '読み込めていません（代替アバター表示中）') : ''}>
            <div class="row gap">
              <input value={ch.model} placeholder="未設定（代替アバター）" readOnly />
              <Button onClick={async () => { const p = await api('character:pick-model'); if (p) await saveChar({ model: p }); }}>選択…</Button>
              {ch.model && <Button variant="ghost" onClick={() => saveChar({ model: '' })}>外す</Button>}
            </div>
          </Field>
          <Field label="モーフ名の上書き（morphMap）" wide hint='例: {"happy.eye": "笑い2", "mouth.a": "あ２", "blink": "まばたき"}'>
            <textarea
              rows={2}
              class="mono"
              value={JSON.stringify(ch.morphMap)}
              onChange={(e) => {
                try {
                  saveChar({ morphMap: JSON.parse((e.target as HTMLTextAreaElement).value || '{}') });
                } catch {
                  flash('JSONの形式が正しくありません', 'error');
                }
              }}
            />
          </Field>
          <Field label="感情別モーション（VMD）" wide hint="characters/<id>/motions 内のファイル名、または絶対パス。空なら標準のモーションを使います（下の設定でOFFにすると簡単な動きになります）">
            <div class="vmd-grid">
              {EMOTIONS.filter((e) => e !== 'neutral').map((e) => (
                <label class="row gap small">
                  <span class="w4">{EMOTION_LABELS[e]}</span>
                  <input value={ch.motions.emotions[e] ?? ''} placeholder={`${e}.vmd`} onChange={(ev) => saveChar({ motions: { ...ch.motions, emotions: { ...ch.motions.emotions, [e]: (ev.target as HTMLInputElement).value || undefined } } })} />
                </label>
              ))}
            </div>
          </Field>
          <Field label="クレジット・規約URL" wide>
            <input value={ch.credits.model} placeholder="モデル作者" onChange={(e) => saveChar({ credits: { ...ch.credits, model: (e.target as HTMLInputElement).value } })} />
          </Field>
        </div>
      </Card>

      <Card title="音声入力" desc="押して話すホットキーを押している間だけ録音します。">
        <div class="grid2">
          <Field label="方式">
            <Select value={s.voice.input} options={[{ value: 'push', label: '押して話す' }, { value: 'wake', label: '名前で呼びかけ（常時待受け）' }, { value: 'off', label: '使わない（文字のみ）' }]} onChange={(v) => set({ voice: { input: v } })} />
          </Field>
          <Field label="マイク"><Toggle checked={s.voice.micEnabled} onChange={(v) => set({ voice: { micEnabled: v } })} label={s.voice.micEnabled ? 'ON' : 'OFF'} /></Field>
          <Field label="文字起こしモデル" hint="GPUが無い環境では自動で small に切り替えます">
            <Select value={s.voice.sttModel} options={[{ value: 'large-v3-turbo', label: 'large-v3-turbo（高精度）' }, { value: 'medium', label: 'medium' }, { value: 'small', label: 'small（軽量）' }, { value: 'base', label: 'base' }]} onChange={(v) => set({ voice: { sttModel: v } })} />
          </Field>
          <Field label="実行デバイス">
            <Select value={s.voice.sttDevice} options={[{ value: 'auto', label: '自動' }, { value: 'cuda', label: 'GPU（CUDA）' }, { value: 'cpu', label: 'CPU' }]} onChange={(v) => set({ voice: { sttDevice: v } })} />
          </Field>
          {s.voice.input === 'wake' && (
            <Field label="呼びかけの言葉" hint="空ならキャラクターの名前">
              <input value={s.voice.wakeWord} onChange={(e) => set({ voice: { wakeWord: (e.target as HTMLInputElement).value } })} />
            </Field>
          )}
          <Field label="押して話す"><input value={s.hotkeys.pushToTalk} onChange={(e) => set({ hotkeys: { pushToTalk: (e.target as HTMLInputElement).value } })} /></Field>
          <Field label="ミュート切替"><input value={s.hotkeys.mute} onChange={(e) => set({ hotkeys: { mute: (e.target as HTMLInputElement).value } })} /></Field>
          <Field label="表示/非表示"><input value={s.hotkeys.toggleVisible} onChange={(e) => set({ hotkeys: { toggleVisible: (e.target as HTMLInputElement).value } })} /></Field>
        </div>
      </Card>

      <Card title="読み上げ">
        <div class="grid2">
          <Field label="ミュート（文字のみ）"><Toggle checked={s.voice.muted} onChange={(v) => set({ voice: { muted: v } })} /></Field>
          <Field label="全体の音量"><Slider value={s.voice.volume} min={0} max={2} step={0.05} onInput={(v) => set({ voice: { volume: v } }, '')} /></Field>
          <Field label="全体の話速倍率" hint="キャラクターの調声値に掛けます"><Slider value={s.voice.speed} min={0.5} max={2} step={0.05} onInput={(v) => set({ voice: { speed: v } }, '')} /></Field>
          <Field label="音質フィルター" hint="再生する前に、耳障りな高い音を少し削って音量をそろえます。「部屋の響き」はごく短い残響も足します">
            <Select
              value={s.voice.postFilter}
              options={[
                { value: 'soft', label: 'やわらかく（おすすめ）' },
                { value: 'room', label: 'やわらかく＋部屋の響き' },
                { value: 'off', label: 'なし（エンジンの音そのまま）' },
              ]}
              onChange={(v) => set({ voice: { postFilter: v } })}
            />
          </Field>
        </div>
        <EngineSettings s={s} set={set} running={status?.voicevox === 'ok'} />
      </Card>

      <PermissionsCard s={s} set={set} />

      <Card title="能動発話" desc="休憩の提案や予定の予告など、こちらから話しかける機能です。">
        <div class="grid2">
          <Field label="有効"><Toggle checked={s.proactive.enabled} onChange={(v) => set({ proactive: { enabled: v } })} /></Field>
          <Field label="1時間あたりの上限"><input type="number" min={0} max={10} value={s.proactive.maxPerHour} onChange={(e) => set({ proactive: { maxPerHour: Number((e.target as HTMLInputElement).value) } })} /></Field>
          <Field label="静かな時間帯">
            <div class="row gap">
              <input type="time" value={s.proactive.quietHours[0]} onChange={(e) => set({ proactive: { quietHours: [(e.target as HTMLInputElement).value, s.proactive.quietHours[1]] } })} />
              〜
              <input type="time" value={s.proactive.quietHours[1]} onChange={(e) => set({ proactive: { quietHours: [s.proactive.quietHours[0], (e.target as HTMLInputElement).value] } })} />
            </div>
          </Field>
          <Field label="時報と休憩の声かけ">
            <Select
              value={String(s.proactive.chimeMinutes)}
              options={[{ value: '0', label: 'しない' }, { value: '30', label: '30分ごと' }, { value: '60', label: '1時間ごと' }]}
              onChange={(v) => set({ proactive: { chimeMinutes: Number(v) as 0 | 30 | 60 } })}
            />
          </Field>
          <Field label="就寝時刻"><input type="time" value={s.proactive.bedtime} onChange={(e) => set({ proactive: { bedtime: (e.target as HTMLInputElement).value } })} /></Field>
        </div>
      </Card>

      <CalendarCard s={s} set={set} />

      <Card title="表示と動作">
        <div class="grid2">
          <Field label="描画の上限（fps）"><Slider value={s.render.fps} min={10} max={60} step={5} onInput={(v) => set({ render: { fps: v } }, '')} /></Field>
          <Field label="標準の感情モーション" hint="感情ごとにうなずきや首のかしげを付けます。OFFにすると、より簡単な動きになります（切り替えるとモデルを読み込み直します）"><Toggle checked={s.render.defaultMotions} onChange={(v) => set({ render: { defaultMotions: v } })} /></Field>
          <Field label="会話の吹き出しを表示" hint="OFFにすると文字の吹き出しを出しません（読み上げは続きます）"><Toggle checked={s.render.showBubble} onChange={(v) => set({ render: { showBubble: v } })} /></Field>
          <Field label="視線の上限角度" hint="カーソルを目で追うときの最大の角度。画面の端で白目が目立つときは小さくします（0で正面のまま）">
            <Slider value={s.render.gazeLimit} min={GAZE_LIMIT_RANGE.min} max={GAZE_LIMIT_RANGE.max} step={5} unit="°" onInput={(v) => set({ render: { gazeLimit: v } }, '')} />
          </Field>
          <Field label="揺れ物（物理演算）"><Toggle checked={s.render.physics} onChange={(v) => set({ render: { physics: v } })} /></Field>
          <Field label="ハードウェアアクセラレーション" hint="透過部分が黒くなる場合はOFF（再起動後に反映）"><Toggle checked={s.render.hardwareAcceleration} onChange={(v) => set({ render: { hardwareAcceleration: v } })} /></Field>
          <Field label="全画面のアプリを使っている間は隠れる" hint="ゲーム・動画・スライドショーを全画面で表示している間だけ隠れます。OFFにすると常に表示します">
            <Toggle checked={s.window.hideOnFullscreen} onChange={(v) => set({ window: { hideOnFullscreen: v } })} />
          </Field>
          <Field label="起動時に新しい版を確認して自動で更新" hint="GitHub のリリースを確認し、新しい版があれば更新して再起動します">
            <Toggle checked={s.autoUpdate} onChange={(v) => set({ autoUpdate: v })} />
          </Field>
          <Field label="Windows起動時に自動起動" hint="サインインすると自動で立ち上がります（インストール版のみ。Windowsの設定→アプリ→スタートアップでも切り替えられます）">
            <Toggle checked={s.autoLaunch} onChange={(v) => set({ autoLaunch: v })} />
          </Field>
          <Field label="おやすみモード"><Toggle checked={s.sleeping} onChange={(v) => set({ sleeping: v })} /></Field>
        </div>
      </Card>

      <Card title="プライバシー" desc="記憶・会話・音声はこのPCの中だけに保存されます。外部に送るのはClaude APIへの会話とWeb検索の語だけです。">
        <div class="grid2">
          <Field label="会話ログを保存" hint="OFFにすると記憶の学習も止まります"><Toggle checked={s.privacy.saveTranscripts} onChange={(v) => set({ privacy: { saveTranscripts: v } })} /></Field>
          <Field label="使っているアプリ名を使う" hint="ウィンドウのタイトルは保存しません"><Toggle checked={s.privacy.watchActiveWindow} onChange={(v) => set({ privacy: { watchActiveWindow: v } })} /></Field>
        </div>
      </Card>

      <VersionCard autoUpdate={s.autoUpdate} />
    </div>
  );
}

const UPDATE_MESSAGE: Record<string, string> = {
  disabled: '開発用の起動では更新できません',
  busy: 'すでに確認中です',
  'no-installer': '新しい版がありますが、インストーラーが見つかりませんでした',
  installing: '新しい版をダウンロードして更新します。このあと自動で再起動します',
  failed: '確認できませんでした。ネットワークの接続を確かめてください（詳しくはログ）',
};

function VersionCard({ autoUpdate }: { autoUpdate: boolean }) {
  const [version, setVersion] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api('app:version').then(setVersion);
  }, []);
  const check = async () => {
    setBusy(true);
    setMsg('確認しています…');
    try {
      const r = await api('update:check');
      setMsg(r.result === 'up-to-date' ? `最新の版です（${r.current}）` : UPDATE_MESSAGE[r.result] ?? '');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="バージョン">
      <div class="grid2">
        <Field label="いまの版"><span>DesktopMMD {version}</span></Field>
        <Field label="更新" hint={autoUpdate ? '起動するたびに自動でも確認しています' : '自動の確認はOFFです。ここから手動で確認できます'}>
          <div class="row gap">
            <Button small disabled={busy} onClick={check}>今すぐ確認</Button>
            <span class="muted small">{msg}</span>
          </div>
        </Field>
      </div>
    </Card>
  );
}

function PermissionsCard({ s, set }: { s: Settings; set: (p: DeepPartial<Settings>, msg?: string) => Promise<void> }) {
  const [app, setApp] = useState({ name: '', path: '' });
  const [mcp, setMcp] = useState<McpServerConfig>({ name: '', command: '', args: [], level: 'L1' });
  return (
    <Card title="作業の権限" desc="L0は自動、L1は確認（声でも可）、L2はクリックでの承認が必要です。レベルは上げることはできますが、下げることはできません。">
      <Field label="許可フォルダ" wide hint="この中のファイルだけを読み書きできます">
        <ul class="list">
          {s.tools.allowedDirs.map((d, i) => (
            <li class="row between">
              <span class="mono">{d}</span>
              <Button small variant="ghost" onClick={() => set({ tools: { allowedDirs: s.tools.allowedDirs.filter((_, j) => j !== i) } })}>削除</Button>
            </li>
          ))}
        </ul>
        <Button small onClick={async () => { const p = await api('character:pick-folder'); if (p && !s.tools.allowedDirs.includes(p)) await set({ tools: { allowedDirs: [...s.tools.allowedDirs, p] } }); }}>フォルダを追加…</Button>
      </Field>

      <Field label="起動を許すアプリ" wide>
        <ul class="list">
          {s.tools.apps.map((a, i) => (
            <li class="row between">
              <span><b>{a.name}</b> <span class="mono muted">{a.path}</span></span>
              <Button small variant="ghost" onClick={() => set({ tools: { apps: s.tools.apps.filter((_, j) => j !== i) } })}>削除</Button>
            </li>
          ))}
        </ul>
        <div class="row gap">
          <input placeholder="呼び名（例: メモ帳）" value={app.name} onInput={(e) => setApp({ ...app, name: (e.target as HTMLInputElement).value })} />
          <input placeholder="実行ファイルのパス" value={app.path} onInput={(e) => setApp({ ...app, path: (e.target as HTMLInputElement).value })} />
          <Button small disabled={!app.name || !app.path} onClick={async () => { await set({ tools: { apps: [...s.tools.apps, app] } }); setApp({ name: '', path: '' }); }}>追加</Button>
        </div>
      </Field>

      <Field label="ツールごとのレベル" wide>
        <table class="table compact">
          <tbody>
            {TOOL_LEVELS.map((t) => {
              const cur = s.tools.levelOverrides[t.name] ?? t.level;
              const options = (['L0', 'L1', 'L2'] as PermissionLevel[]).filter((l) => RANK[l] >= RANK[t.level]).map((l) => ({ value: l, label: LEVEL_LABEL[l] }));
              return (
                <tr>
                  <td>{t.title}</td>
                  <td class="mono muted small">{t.name}</td>
                  <td>
                    <Select value={cur} options={options} onChange={(v) => set({ tools: { levelOverrides: { ...s.tools.levelOverrides, [t.name]: v } } })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Field>

      <Field label="コマンド実行（PowerShell）" hint="有効にしても毎回、全文を表示してクリック承認を求めます">
        <Toggle checked={s.tools.runCommandEnabled} onChange={(v) => set({ tools: { runCommandEnabled: v } })} />
      </Field>

      <Field label="MCPサーバー" wide hint="カレンダーなどのツールを追加します。送信・削除系のツールは自動でL2になります。">
        <ul class="list">
          {s.mcp.servers.map((m, i) => (
            <li class="row between">
              <span>
                <b>{m.name}</b> <span class="mono muted">{m.command} {m.args.join(' ')}</span> <span class="pill info">{m.level}</span>
              </span>
              <span class="row gap">
                <Toggle checked={m.enabled !== false} onChange={(v) => set({ mcp: { servers: s.mcp.servers.map((x, j) => (j === i ? { ...x, enabled: v } : x)) } })} />
                <Button small variant="ghost" onClick={() => set({ mcp: { servers: s.mcp.servers.filter((_, j) => j !== i) } })}>削除</Button>
              </span>
            </li>
          ))}
        </ul>
        <div class="row gap wrap">
          <input placeholder="名前" value={mcp.name} onInput={(e) => setMcp({ ...mcp, name: (e.target as HTMLInputElement).value })} />
          <input placeholder="コマンド（例: npx）" value={mcp.command} onInput={(e) => setMcp({ ...mcp, command: (e.target as HTMLInputElement).value })} />
          <input placeholder="引数（空白区切り）" value={mcp.args.join(' ')} onInput={(e) => setMcp({ ...mcp, args: (e.target as HTMLInputElement).value.split(/\s+/).filter(Boolean) })} />
          <Select value={mcp.level} options={[{ value: 'L1', label: 'L1 確認' }, { value: 'L2', label: 'L2 承認' }]} onChange={(v) => setMcp({ ...mcp, level: v })} />
          <Button small disabled={!mcp.name || !mcp.command} onClick={async () => { await set({ mcp: { servers: [...s.mcp.servers, mcp] } }); setMcp({ name: '', command: '', args: [], level: 'L1' }); }}>追加</Button>
        </div>
      </Field>
    </Card>
  );
}
