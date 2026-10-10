// SC-14 first-run setup: API key, PMX, VOICEVOX check, mic test, how to call the user.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { VoicevoxSpeaker } from '@shared/types';
import { api } from '../api';
import { Button, Card, Field, flash, Pill } from '../ui';

const STEPS = ['APIキー', 'モデル', 'VOICEVOX', 'マイク', '呼び名'] as const;

export function SetupPage(p: { onDone(): void }) {
  const [step, setStep] = useState(0);
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [model, setModel] = useState('');
  const [morph, setMorph] = useState<{ found: string[]; missing: string[]; modelLoaded: boolean } | null>(null);
  const [vv, setVv] = useState<{ ok: boolean; version?: string; speakers: VoicevoxSpeaker[]; error?: string } | null>(null);
  const [callName, setCallName] = useState('');

  useEffect(() => {
    void (async () => {
      setHasKey((await api('secrets:status')).hasKey);
      setModel((await api('character:get')).model);
      setCallName((await api('settings:get')).user.callName);
    })();
  }, []);

  return (
    <div class="page setup">
      <h1>はじめに</h1>
      <ol class="stepper">
        {STEPS.map((s, i) => (
          <li class={i === step ? 'current' : i < step ? 'done' : ''} onClick={() => setStep(i)}>
            <span class="num">{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card title="Claude APIキー" desc="会話にはAnthropicのClaude APIを使います。キーはこのPCの暗号化領域に保存されます。">
          {hasKey && <p><Pill kind="ok">登録済み</Pill> 変更する場合だけ入力してください。</p>}
          <Field label="APIキー">
            <input type="password" placeholder="sk-ant-…" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
          </Field>
          <div class="row gap end">
            <Button onClick={() => api('app:open-external', 'https://console.anthropic.com/settings/keys')}>キーを取得するページを開く</Button>
            <Button
              variant="primary"
              onClick={async () => {
                if (key.trim()) {
                  const r = await api('secrets:set-api-key', key.trim());
                  if (!r.ok) return flash(r.error ?? '保存できませんでした', 'error');
                  setHasKey(true);
                }
                setStep(1);
              }}
            >
              {key.trim() ? '保存して次へ' : '次へ'}
            </Button>
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card title="MMDモデル（PMX）" desc="使いたいモデルのPMXファイルを選びます。ファイルは読み込むだけで、書き換えもコピーもしません（モデルの規約で改変・再配布が禁じられていることが多いため）。">
          <div class="row gap">
            <input class="grow" value={model} placeholder="未選択（代替アバターで動きます）" readOnly />
            <Button
              onClick={async () => {
                const path = await api('character:pick-model');
                if (!path) return;
                const c = await api('character:get');
                await api('character:save', { ...c, model: path });
                setModel(path);
                setTimeout(async () => setMorph(await api('character:morph-report')), 4000);
              }}
            >
              選択…
            </Button>
          </div>
          {morph && (
            <p class="small">
              {morph.modelLoaded ? <Pill kind="ok">読み込み成功</Pill> : <Pill kind="error">読み込み失敗</Pill>}{' '}
              {morph.missing.length > 0 ? `見つからない表情: ${morph.missing.join('、')}（設定画面のmorphMapで別名を指定できます）` : '必要な表情はすべて見つかりました'}
            </p>
          )}
          <div class="row gap end">
            <Button variant="primary" onClick={() => setStep(2)}>次へ</Button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card title="VOICEVOX" desc="声はローカルで動くVOICEVOXエンジンで作ります。VOICEVOXを起動してから接続を確認してください。">
          <Button variant="primary" onClick={async () => setVv(await api('voice:speakers'))}>接続を確認</Button>
          {vv && (vv.ok ? <p><Pill kind="ok">接続OK</Pill> VOICEVOX {vv.version}、話者{vv.speakers.length}人。声は「調声」画面で選べます。</p> : <p><Pill kind="error">接続できません</Pill> <span class="small mono">{vv.error}</span><br /><span class="small muted">接続できなくても、Windows標準の音声で話します。</span></p>)}
          <div class="row gap end">
            <Button variant="primary" onClick={() => setStep(3)}>次へ</Button>
          </div>
        </Card>
      )}

      {step === 3 && <MicTest onNext={() => setStep(4)} />}

      {step === 4 && (
        <Card title="呼び名" desc="アシスタントがあなたを何と呼ぶかを決めます（あとで変えられます）。">
          <Field label="呼び名"><input value={callName} placeholder="例: ゆうたろうさん" onInput={(e) => setCallName((e.target as HTMLInputElement).value)} /></Field>
          <div class="row gap end">
            <Button
              variant="primary"
              onClick={async () => {
                await api('settings:set', { user: { callName } });
                await api('setup:complete');
                flash('セットアップが完了しました。Ctrl+Alt+Space を押しながら話しかけてみてください');
                p.onDone();
              }}
            >
              完了
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function MicTest(p: { onNext(): void }) {
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState('');
  const [on, setOn] = useState(false);
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);

  const start = async () => {
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
    <Card title="マイクテスト" desc="話しかけてバーが動けばOKです。音声は文字起こしに使ったあとすぐ破棄され、保存されません。">
      <div class="row gap">
        {!on ? <Button variant="primary" onClick={start}>テスト開始</Button> : <Button onClick={() => stop.current()}>停止</Button>}
        <div class="meter grow"><div class="meter-bar" style={{ width: `${Math.min(100, level * 140)}%` }} /></div>
      </div>
      {err && <p class="small"><Pill kind="error">マイクを使えません</Pill> {err}</p>}
      <div class="row gap end">
        <Button variant="primary" onClick={() => { stop.current(); p.onNext(); }}>次へ</Button>
      </div>
    </Card>
  );
}
