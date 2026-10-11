// SC-14 first-run setup: API key, PMX, VOICEVOX check, mic test, how to call the user, then how to talk.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AdminPage } from '@shared/ipc';
import type { Settings, VoicevoxSpeaker } from '@shared/types';
import { api } from '../api';
import { Button, Card, Field, flash, Pill } from '../ui';

const STEPS = [
  { title: '会話のAI', sub: '必須' },
  { title: 'キャラクター', sub: '任意' },
  { title: '声', sub: '任意' },
  { title: 'マイク', sub: '任意' },
  { title: '呼び名', sub: '任意' },
  { title: '使い方', sub: '' },
] as const;

const VOICEVOX_URL = 'https://voicevox.hiroshiba.jp/';
const OLLAMA_URL = 'https://ollama.com/download';

type Vv = { ok: boolean; version?: string; speakers: VoicevoxSpeaker[]; error?: string };

/** 各手順の下に出す「戻る / あとで / 次へ」 */
function Nav(p: { back?(): void; skip?(): void; next(): void; nextLabel?: string; nextDisabled?: boolean }) {
  return (
    <div class="row gap end setup-nav">
      {p.back && <Button variant="ghost" onClick={p.back}>戻る</Button>}
      <span class="grow" />
      {p.skip && <Button variant="ghost" onClick={p.skip}>あとで設定する</Button>}
      <Button variant="primary" disabled={p.nextDisabled} onClick={p.next}>{p.nextLabel ?? '次へ'}</Button>
    </div>
  );
}

function Why(p: { children: ComponentChildren }) {
  return <p class="setup-why small">{p.children}</p>;
}

export function SetupPage(p: { onDone(): void; navigate(page: AdminPage): void }) {
  const [step, setStep] = useState(0);
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [s, setS] = useState<Settings | null>(null);
  const [model, setModel] = useState('');
  const [morph, setMorph] = useState<{ found: string[]; missing: string[]; modelLoaded: boolean } | null>(null);
  const [vv, setVv] = useState<Vv | null>(null);
  const [vvBusy, setVvBusy] = useState(false);
  const [micOk, setMicOk] = useState(false);
  const [callName, setCallName] = useState('');

  useEffect(() => {
    void (async () => {
      setHasKey((await api('secrets:status')).hasKey);
      setModel((await api('character:get')).model);
      const st = await api('settings:get');
      setS(st);
      setCallName(st.user.callName);
    })();
  }, []);

  const checkVv = async () => {
    setVvBusy(true);
    try {
      setVv(await api('voice:speakers'));
    } finally {
      setVvBusy(false);
    }
  };
  const startVv = async () => {
    setVvBusy(true);
    try {
      const r = await api('voice:engine-start');
      flash(r.message, r.ok ? 'ok' : 'error');
      setVv(await api('voice:speakers'));
    } finally {
      setVvBusy(false);
    }
  };
  // 声の手順に来たら、まず今つながるかを自動で確かめる
  useEffect(() => {
    if (step === 2 && !vv) void checkVv();
  }, [step]);

  const local = s?.llm.provider === 'local';
  const done = [hasKey || local, !!model, !!vv?.ok, micOk, !!callName.trim(), false];
  const go = (i: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, i)));
  const ptt = s?.hotkeys.pushToTalk ?? 'Ctrl+Alt+Space';

  return (
    <div class="page setup">
      <h1>はじめに</h1>
      <p class="muted page-lead">
        5つの手順で使い始められます。必要なのは「会話のAI」だけで、ほかは飛ばしてもあとから設定画面で変えられます。
      </p>
      <ol class="stepper">
        {STEPS.map((st, i) => (
          <li class={i === step ? 'current' : done[i] ? 'done' : ''} onClick={() => go(i)}>
            <span class="step-num">{done[i] && i !== step ? '✓' : i + 1}</span>
            <span class="step-text">
              {st.title}
              {st.sub && <span class="step-sub">{st.sub}</span>}
            </span>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card title="会話のAIを決める" desc="キャラクターの返事を作るAIです。どちらか一つを選んでください。">
          <div class="choice-grid">
            <div class={`choice ${!local ? 'selected' : ''}`}>
              <div class="choice-title">Claude API <Pill kind="info">おすすめ</Pill></div>
              <p class="small muted">賢く、ファイル操作やタイマーなどの作業も頼めます。使った分だけ料金がかかります（月の上限を設定できます）。</p>
              {hasKey && <p class="small"><Pill kind="ok">APIキー登録済み</Pill> 変えるときだけ入力してください。</p>}
              <Field label="APIキー">
                <input type="password" placeholder="sk-ant-…" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} autocomplete="off" />
              </Field>
              <div class="row gap wrap">
                <Button small onClick={() => api('app:open-external', 'https://console.anthropic.com/settings/keys')}>キーを取得するページを開く</Button>
                <Button
                  small
                  variant="primary"
                  disabled={!key.trim() && !hasKey}
                  onClick={async () => {
                    if (key.trim()) {
                      const r = await api('secrets:set-api-key', key.trim());
                      if (!r.ok) return flash(r.error ?? '保存できませんでした', 'error');
                      setHasKey(true);
                      setKey('');
                    }
                    setS(await api('settings:set', { llm: { provider: 'claude' } }));
                    go(1);
                  }}
                >
                  {key.trim() ? '保存してClaudeを使う' : 'Claudeを使う'}
                </Button>
              </div>
            </div>
            <div class={`choice ${local ? 'selected' : ''}`}>
              <div class="choice-title">このPCのAI（Ollama）</div>
              <p class="small muted">無料で、会話の内容がPCの外に出ません。おしゃべりだけで、作業の代行はできません。PCの性能（GPU）が必要です。</p>
              <div class="row gap wrap">
                <Button small onClick={() => api('app:open-external', OLLAMA_URL)}>Ollamaを入手</Button>
                <Button
                  small
                  variant={local ? 'primary' : 'default'}
                  onClick={async () => {
                    setS(await api('settings:set', { llm: { provider: 'local' } }));
                    flash('このPCのAIで会話します。モデルの準備は設定画面の「会話のAI」で確認できます');
                    go(1);
                  }}
                >
                  このPCのAIを使う
                </Button>
              </div>
            </div>
          </div>
          <Nav next={() => go(1)} nextDisabled={!hasKey && !local} nextLabel={!hasKey && !local ? 'どちらかを選んでください' : '次へ'} />
        </Card>
      )}

      {step === 1 && (
        <Card title="キャラクターのモデル（PMX）" desc="デスクトップに表示するMMDモデルを選びます。選ばなくても、代わりの簡単なアバターで動きます。">
          <Why>ファイルは読み込むだけで、書き換えもコピーもしません（モデルの規約で改変・再配布が禁じられていることが多いため）。モデルの利用規約を守って使ってください。</Why>
          <div class="row gap">
            <input class="grow" value={model} placeholder="未選択（代替アバターで動きます）" readOnly />
            <Button
              variant="primary"
              onClick={async () => {
                const path = await api('character:pick-model');
                if (!path) return;
                const c = await api('character:get');
                await api('character:save', { ...c, model: path });
                setModel(path);
                setMorph(null);
                setTimeout(async () => setMorph(await api('character:morph-report')), 4000);
              }}
            >
              モデルを選ぶ…
            </Button>
          </div>
          {model && !morph && <p class="small muted">読み込みを確かめています…</p>}
          {morph && (
            <p class="small">
              {morph.modelLoaded ? <Pill kind="ok">読み込み成功</Pill> : <Pill kind="error">読み込み失敗</Pill>}{' '}
              {morph.missing.length > 0 ? `見つからない表情: ${morph.missing.join('、')}（設定の「拡張設定」にあるmorphMapで別名を指定できます）` : '必要な表情はすべて見つかりました'}
            </p>
          )}
          <Nav back={() => go(0)} skip={model ? undefined : () => go(2)} next={() => go(2)} />
        </Card>
      )}

      {step === 2 && (
        <Card title="声（読み上げエンジン）" desc="キャラクターの声は、無料の音声合成ソフト VOICEVOX（または AivisSpeech）で作ります。">
          <Why>入っていなくても、Windows標準の声で話せます。VOICEVOXを入れると、たくさんの声から選べます。インストールしてあれば、このアプリが自動で起動します。</Why>
          <div class="status-line">
            {vvBusy ? (
              <Pill kind="info">確認中…</Pill>
            ) : vv?.ok ? (
              <span><Pill kind="ok">接続OK</Pill> VOICEVOX {vv.version}、{vv.speakers.length}人の声が使えます。声は「調声」画面で選べます。</span>
            ) : vv ? (
              <span><Pill kind="warn">接続できません</Pill> <span class="small muted">いまはWindows標準の声で話します。</span></span>
            ) : null}
          </div>
          <div class="row gap wrap">
            {!vv?.ok && <Button variant="primary" disabled={vvBusy} onClick={startVv}>VOICEVOXを起動する</Button>}
            {!vv?.ok && <Button disabled={vvBusy} onClick={() => api('app:open-external', VOICEVOX_URL)}>VOICEVOXを入手</Button>}
            <Button variant="ghost" disabled={vvBusy} onClick={checkVv}>もう一度確認</Button>
            {vv?.ok && <Button onClick={() => p.navigate('voice')}>調声で声を選ぶ</Button>}
          </div>
          <Nav back={() => go(1)} skip={vv?.ok ? undefined : () => go(3)} next={() => go(3)} />
        </Card>
      )}

      {step === 3 && <MicTest onOk={() => setMicOk(true)} back={() => go(2)} next={() => go(4)} ok={micOk} />}

      {step === 4 && (
        <Card title="あなたの呼び方" desc="キャラクターがあなたを何と呼ぶかを決めます（あとで変えられます）。">
          <Field label="呼び名"><input value={callName} placeholder="例: ゆうたろうさん" onInput={(e) => setCallName((e.target as HTMLInputElement).value)} /></Field>
          <Nav
            back={() => go(3)}
            next={async () => {
              setS(await api('settings:set', { user: { callName: callName.trim() } }));
              go(5);
            }}
          />
        </Card>
      )}

      {step === 5 && (
        <Card title="準備ができました" desc="話しかけ方を覚えておいてください。">
          <ul class="howto">
            {s?.voice.input === 'push' && (
              <>
                <li>
                  <span class="kbd">{ptt}</span> を<b>押している間</b>に話すと、離したところで聞き取ります。
                </li>
                <li>
                  <span class="kbd">{ptt}</span> を<b>短く押す</b>と、文字で入力する欄が開きます。
                </li>
              </>
            )}
            <li>キャラクターを<b>右クリック</b>すると「話しかける（入力欄）」や「管理画面」のメニューが出ます。ドラッグで移動できます。</li>
            <li>「10分後に教えて」「デスクトップのファイルを整理して」のように、作業も頼めます（実行前に必ず確認します）。</li>
          </ul>
          <div class="row gap end setup-nav">
            <Button variant="ghost" onClick={() => go(4)}>戻る</Button>
            <span class="grow" />
            <Button
              onClick={async () => {
                await api('setup:complete');
                p.navigate('voice');
              }}
            >
              声を選ぶ（調声）
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                await api('setup:complete');
                flash(`セットアップが完了しました。${ptt} を押しながら話しかけてみてください`);
                p.onDone();
              }}
            >
              使い始める
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function MicTest(p: { onOk(): void; back(): void; next(): void; ok: boolean }) {
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState('');
  const [on, setOn] = useState(false);
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);

  const start = async () => {
    setErr('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      const data = new Float32Array(an.fftSize);
      let raf = 0;
      const loop = () => {
        an.getFloatTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v));
        setLevel(peak);
        if (peak > 0.1) p.onOk();
        raf = requestAnimationFrame(loop);
      };
      loop();
      setOn(true);
      stop.current = () => {
        cancelAnimationFrame(raf);
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
        setOn(false);
      };
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  return (
    <Card title="マイクのテスト" desc="「テスト開始」を押して話しかけ、バーが動けばOKです。">
      <Why>音声は文字起こしに使ったあとすぐ破棄され、保存されません。マイクを使わず、文字だけで話すこともできます。</Why>
      <div class="row gap">
        {!on ? <Button variant="primary" onClick={start}>テスト開始</Button> : <Button onClick={() => stop.current()}>停止</Button>}
        <div class="meter big grow"><div class="meter-bar" style={{ width: `${Math.min(100, level * 140)}%` }} /></div>
        {p.ok && <Pill kind="ok">聞こえています</Pill>}
      </div>
      {err && <p class="small"><Pill kind="error">マイクを使えません</Pill> {err}</p>}
      <Nav
        back={() => { stop.current(); p.back(); }}
        skip={p.ok ? undefined : () => { stop.current(); p.next(); }}
        next={() => { stop.current(); p.next(); }}
      />
    </Card>
  );
}
