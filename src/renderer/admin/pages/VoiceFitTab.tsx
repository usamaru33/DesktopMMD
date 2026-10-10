// 調声 › サンプルから: 音声ファイル（mp3 など）に近い VOICEVOX / AivisSpeech の声と、話速・音高・抑揚を自動で探す。
import { useEffect, useState } from 'preact/hooks';
import type { VoiceFitProgressEvent, VoiceFitResult } from '@shared/ipc';
import type { CharacterVoice, FitCandidate } from '@shared/types';
import { api, onAdmin, playWav, stopWav } from '../api';
import { Button, Card, Empty, Field, flash, Pill, Select } from '../ui';

const FIT_SR = 16_000;
const MAX_SEC = 20;

interface Sample {
  name: string;
  duration: number;
  /** 再生用の元ファイル */
  raw: ArrayBuffer;
  pcm: Float32Array;
}

/** mp3 / wav / m4a / ogg などをデコードし、16kHz モノラルの先頭20秒にする */
async function decodeSample(file: File): Promise<Sample> {
  const raw = await file.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const ab = await ctx.decodeAudioData(raw.slice(0));
    const len = Math.max(1, Math.ceil(Math.min(ab.duration, MAX_SEC) * FIT_SR));
    const off = new OfflineAudioContext(1, len, FIT_SR);
    const src = off.createBufferSource();
    src.buffer = ab;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    return { name: file.name, duration: ab.duration, raw, pcm: out.getChannelData(0).slice() };
  } finally {
    void ctx.close();
  }
}

function progressText(p: VoiceFitProgressEvent): string {
  if (p.phase === 'transcribe') return 'サンプルを書き起こしています…';
  if (p.phase === 'screen') return `声を聞き比べています ${p.done + 1}/${p.total}${p.label ? `（${p.label}）` : ''}`;
  return p.done >= p.total ? '仕上げています…' : `調声を合わせています ${p.done + 1}/${p.total}${p.label ? `（${p.label}）` : ''}`;
}

/** 聞き比べ（全体の8割の時間）→ 調声合わせ（残り2割） */
function progressRatio(p: VoiceFitProgressEvent | null): number {
  if (!p || !p.total) return 0;
  const r = Math.min(1, p.done / p.total);
  return p.phase === 'screen' ? 0.8 * r : p.phase === 'fit' ? 0.8 + 0.2 * r : 0;
}

const signed = (v: number) => (v >= 0 ? `+${v.toFixed(3)}` : v.toFixed(3));

export function VoiceFitTab(p: {
  draft: CharacterVoice;
  onApply(next: CharacterVoice): void;
  onPreview(voice: CharacterVoice, text: string): Promise<void>;
}) {
  const [sample, setSample] = useState<Sample | null>(null);
  const [text, setText] = useState('');
  const [scope, setScope] = useState<'speaker' | 'all'>('all');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<VoiceFitProgressEvent | null>(null);
  const [result, setResult] = useState<VoiceFitResult | null>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => onAdmin('admin:voice-fit-progress', (ev) => setProgress(ev as VoiceFitProgressEvent)), []);

  const load = async (file: File | undefined) => {
    if (!file) return;
    try {
      const s = await decodeSample(file);
      if (s.duration < 2) return flash('音声が短すぎます（2秒以上の話し声を使ってください）', 'error');
      setSample(s);
      setResult(null);
    } catch {
      flash('この音声ファイルは読み込めませんでした（mp3・wav・m4a・ogg に対応しています）', 'error');
    }
  };

  const run = async () => {
    if (!sample) return;
    setRunning(true);
    setResult(null);
    setProgress(null);
    try {
      const r = await api('voice:fit', { pcm: sample.pcm, sr: FIT_SR, text, scope, speakerId: p.draft.speakerId, engineUrl: p.draft.engineUrl });
      setResult(r);
      if (!r.ok) flash(r.error ?? '調べられませんでした', 'error');
      else if (r.transcribed && r.text) setText(r.text);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const withCandidate = (c: FitCandidate): CharacterVoice => {
    const sameVoice = c.styleId === p.draft.speakerId;
    return {
      ...p.draft,
      speakerId: c.styleId,
      base: { ...p.draft.base, ...c.params },
      // 話者が変わったら、感情別のスタイル指定（前の話者のスタイル）は外す
      emotions: sameVoice ? p.draft.emotions : Object.fromEntries(Object.entries(p.draft.emotions).map(([k, v]) => [k, v && { ...v, styleId: null }])),
    };
  };

  const previewText = (result?.text || text || 'こんにちは。今日もよろしくお願いします。').slice(0, 80);

  return (
    <Card
      title="サンプル音声から自動調声"
      desc="似せたい声の音声ファイルを選ぶと、今のエンジン（VOICEVOX / AivisSpeech）の声の中から声色と高さが近いものを探し、話速・音高・抑揚をサンプルに合わせます。声そのものを複製するのではなく、エンジンの声と調声値を選ぶ機能です。"
    >
      <label
        class={`drop-zone ${dragOver ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void load(e.dataTransfer?.files[0]);
        }}
      >
        <input type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac" style={{ display: 'none' }} onChange={(e) => void load((e.target as HTMLInputElement).files?.[0])} />
        {sample ? (
          <span>
            <b>{sample.name}</b>　{sample.duration.toFixed(1)}秒{sample.duration > MAX_SEC ? `（先頭${MAX_SEC}秒を使います）` : ''}　<span class="muted small">クリックで選び直す</span>
          </span>
        ) : (
          <span>ここに音声ファイル（mp3・wav・m4a など）をドロップ、またはクリックして選択</span>
        )}
      </label>
      <p class="muted small">BGMや効果音の無い、1人の話し声だけの5〜20秒くらいの音声がいちばんよく合います。</p>

      <div class="grid2">
        <Field label="話している内容（任意）" hint="空なら音声認識で自動で書き起こします。分かっていれば入れると話速が正確になります">
          <input value={text} placeholder="例: こんにちは、今日はいい天気ですね。" onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="探す範囲" hint="すべての話者から探すと、エンジンが全部の声を読み込むためメモリを数GB使います（エンジンを再起動すると元に戻ります）">
          <Select
            value={scope}
            options={[
              { value: 'all', label: 'すべての話者から（数分かかります）' },
              { value: 'speaker', label: '今の話者のスタイルから（速い）' },
            ]}
            onChange={(v) => setScope(v as 'speaker' | 'all')}
          />
        </Field>
      </div>

      <div class="row gap">
        <Button disabled={!sample} onClick={() => sample && void playWav(sample.raw)}>▶ サンプルを再生</Button>
        <Button variant="ghost" onClick={() => stopWav()}>■ 停止</Button>
        <span class="grow" />
        {running ? (
          <Button variant="danger" onClick={() => void api('voice:fit-cancel')}>中止</Button>
        ) : (
          <Button variant="primary" disabled={!sample} onClick={run}>近い声を探す</Button>
        )}
      </div>

      {running && (
        <div class="fit-progress">
          <div class="bar"><div style={{ width: `${Math.round(progressRatio(progress) * 100)}%` }} /></div>
          <span class="muted small">{progress ? progressText(progress) : '準備しています…'}</span>
        </div>
      )}

      {result?.ok && result.sample && (
        <>
          <p class="small">
            サンプルの声: 高さ <b>{Math.round(result.sample.f0Hz)} Hz</b>　抑揚 <b>{result.sample.logF0Std.toFixed(3)}</b>　話している時間 <b>{result.sample.activeSec.toFixed(1)}秒</b>
            {result.text ? <span class="muted">　内容「{result.text.slice(0, 60)}{result.text.length > 60 ? '…' : ''}」{result.transcribed ? '（自動書き起こし）' : ''}</span> : <span class="muted">　内容が分からないため話速は合わせていません</span>}
          </p>
          {!result.candidates?.length ? (
            <Empty>近い声が見つかりませんでした</Empty>
          ) : (
            <table class="table">
              <thead>
                <tr><th>声</th><th>近さ</th><th>話速</th><th>音高</th><th>抑揚</th><th /></tr>
              </thead>
              <tbody>
                {result.candidates.map((c, i) => (
                  <tr>
                    <td>{c.label}{i === 0 && <> <Pill kind="ok">いちばん近い</Pill></>}{c.styleId === p.draft.speakerId && <> <Pill kind="info">選択中</Pill></>}</td>
                    <td>{c.score}</td>
                    <td>{c.params.speedScale.toFixed(2)}</td>
                    <td>{signed(c.params.pitchScale)}</td>
                    <td>{c.params.intonationScale.toFixed(2)}</td>
                    <td class="row gap end">
                      <Button small onClick={() => p.onPreview(withCandidate(c), previewText)}>▶ 試聴</Button>
                      <Button
                        small
                        variant="primary"
                        onClick={() => {
                          p.onApply(withCandidate(c));
                          flash('調声に反映しました。「保存」で確定します');
                        }}
                      >
                        この声にする
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p class="muted small">「近さ」は声色と地声の高さの近さの目安（100が同じ）です。反映後も「基本の調声」タブで細かく直せます。音量・間の長さは今の値のままです。</p>
        </>
      )}
    </Card>
  );
}
