// SC-15 voice tuning (spec 3.6): speaker/style, base tuning, per-emotion corrections, dictionary, fixed phrases.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { autoEmotionStyles, DEFAULT_EMOTION_VOICE, EMOTIONS, EMOTION_LABELS, type Emotion, type EmotionVoice, NEUTRAL_EMOTION_VOICE } from '@shared/emotions';
import { VOICE_RANGES, VOICEVOX_DEFAULT_BASE } from '@shared/defaults';
import type { DictWordInput } from '@shared/ipc';
import type { CharacterVoice, VoiceBase, VoiceDictWord, VoiceFilter, VoicePhrase, VoicevoxAccentPhrase, VoicevoxSpeaker, WordType } from '@shared/types';
import { type EngineKind, engineKindFromUrl, ENGINE_PRESETS } from '@shared/voiceEngine';
import { api, playWav, stopWav } from '../api';
import { Button, Card, Empty, Field, flash, Pill, Select, Slider, Tabs, Toggle } from '../ui';
import { VoiceFitTab } from './VoiceFitTab';

type Tab = 'speaker' | 'sample' | 'base' | 'emotion' | 'dict' | 'phrase';
/** 設定の「拡張設定」がONのときだけ出すタブ */
const ADVANCED_TABS: Tab[] = ['sample', 'emotion', 'phrase'];

/** これより外は高い音がかすれたり、間延びしたりしやすい（自動調声もこの範囲に収める） */
const NATURAL: Partial<Record<keyof VoiceBase, [number, number]>> = {
  speedScale: [0.75, 1.5],
  pitchScale: [-0.08, 0.08],
  intonationScale: [0.6, 1.5],
};
const outside = (k: keyof VoiceBase, v: number) => {
  const r = NATURAL[k];
  return !!r && (v < r[0] - 1e-9 || v > r[1] + 1e-9);
};

const SAMPLE: Record<Emotion, string> = {
  neutral: 'こんにちは。今日もよろしくお願いします。',
  happy: 'やったー！うまくいきましたね！',
  surprised: 'えっ、本当ですか？それはびっくりです。',
  sad: 'そうでしたか……それは残念でしたね。',
  angry: 'もう、ちゃんと休まないとだめですよ！',
  troubled: 'うーん、それはちょっと難しいかもしれません。',
  shy: 'そ、そんなに褒められると照れちゃいます……。',
  thinking: 'えっと、少し考えてみますね。',
};

const WORD_TYPES: { value: WordType; label: string }[] = [
  { value: 'PROPER_NOUN', label: '固有名詞' },
  { value: 'COMMON_NOUN', label: '普通名詞' },
  { value: 'VERB', label: '動詞' },
  { value: 'ADJECTIVE', label: '形容詞' },
  { value: 'SUFFIX', label: '接尾辞' },
];

export function VoicePage(p: { setDirty(d: boolean): void }) {
  const [tabSel, setTab] = useState<Tab>('speaker');
  const [adv, setAdv] = useState(false);
  const tab: Tab = adv || !ADVANCED_TABS.includes(tabSel) ? tabSel : 'speaker';
  const [saved, setSaved] = useState<CharacterVoice | null>(null);
  const [draft, setDraft] = useState<CharacterVoice | null>(null);
  const [speakers, setSpeakers] = useState<VoicevoxSpeaker[]>([]);
  const [engine, setEngine] = useState<{ ok: boolean; version?: string; kind?: EngineKind; error?: string } | null>(null);
  const [filter, setFilter] = useState<VoiceFilter>('soft');
  const [engineUrl, setEngineUrl] = useState('');
  const [text, setText] = useState(SAMPLE.neutral);
  const [previewEmotion, setPreviewEmotion] = useState<Emotion>('neutral');
  const [onModel, setOnModel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);

  const connect = async (url?: string) => {
    const r = await api('voice:speakers', url);
    setEngine({ ok: r.ok, version: r.version, kind: r.kind, error: r.error });
    setSpeakers(r.speakers);
    return r;
  };

  useEffect(() => {
    void (async () => {
      const c = await api('character:get');
      setSaved(c.voice);
      setDraft(structuredClone(c.voice));
      setEngineUrl(c.voice.engineUrl);
      void api('settings:get').then((s) => {
        setFilter(s.voice.postFilter);
        setAdv(s.ui.advanced);
      });
      await connect(c.voice.engineUrl);
    })();
  }, []);

  const dirty = useMemo(() => !!saved && !!draft && JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft]);
  useEffect(() => p.setDirty(dirty), [dirty]);

  if (!draft || !saved) return <div class="loading">読み込み中…</div>;

  const styles = speakers.flatMap((s) => s.styles.map((st) => ({ id: st.id, label: `${s.name}（${st.name}）`, speaker: s.name })));
  const currentSpeaker = speakers.find((s) => s.styles.some((st) => st.id === draft.speakerId));
  const kind: EngineKind = engine?.kind ?? engineKindFromUrl(engineUrl);
  const engineName = ENGINE_PRESETS[kind].label;
  const autoStyles = draft.autoEmotionStyles !== false ? autoEmotionStyles(speakers, draft.speakerId) : {};

  /** エンジンを切り替える。動いていなければ起動してみて、つながったら最初の話者を選ぶ（調声は初期値に戻す） */
  const switchEngine = async (url: string) => {
    if (url === draft.engineUrl && engine?.ok) return;
    setEngineUrl(url);
    let r = await connect(url);
    if (!r.ok) {
      setStarting(true);
      try {
        const s = await api('voice:engine-start', url);
        flash(s.message, s.ok ? 'ok' : 'error');
        if (s.ok) r = await connect(url);
      } finally {
        setStarting(false);
      }
    }
    if (!r.ok) return;
    const first = r.speakers.flatMap((sp) => sp.styles.filter((st) => !st.type || st.type === 'talk'))[0];
    const keep = r.speakers.some((sp) => sp.styles.some((st) => st.id === draft.speakerId));
    const back = url === saved.engineUrl;
    setDraft({
      ...draft,
      engineUrl: url,
      speakerId: back ? saved.speakerId : keep || !first ? draft.speakerId : first.id,
      base: back ? saved.base : { ...VOICEVOX_DEFAULT_BASE, volumeScale: draft.base.volumeScale },
      emotions: back ? saved.emotions : {},
    });
  };

  const preview = async (voice: CharacterVoice, emotion = previewEmotion, t = text) => {
    setBusy(true);
    try {
      const r = await api('voice:preview', { text: t, voice, emotion, intensity: 1, onModel });
      if (!r.ok) flash(r.error ?? '試聴できませんでした', 'error');
      else if (r.wav) await playWav(r.wav, filter);
      if (r.engine === 'fallback') flash(`${engineName}に接続できないため、Windows標準音声で再生しました`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    await api('voice:save', draft);
    setSaved(structuredClone(draft));
    flash('調声を保存しました。次の発話から反映されます');
  };

  const resetTab = () => {
    if (tab === 'base') setDraft({ ...draft, base: { ...VOICEVOX_DEFAULT_BASE } });
    if (tab === 'emotion') setDraft({ ...draft, emotions: {} });
    if (tab === 'speaker' || tab === 'sample') setDraft({ ...draft, speakerId: saved.speakerId, base: tab === 'sample' ? saved.base : draft.base, emotions: tab === 'sample' ? saved.emotions : draft.emotions });
    if (tab === 'phrase') setDraft({ ...draft, phrases: [] });
  };

  return (
    <div class="page">
      <div class="row between">
        <h1>調声</h1>
        <div class="row gap">
          {dirty && <Pill kind="warn">未保存の変更があります</Pill>}
          {tab !== 'dict' && <Button variant="ghost" onClick={resetTab}>このタブを初期値に戻す</Button>}
          <Button variant="primary" disabled={!dirty} onClick={save}>保存</Button>
        </div>
      </div>

      {!engine?.ok && (
        <Card title={`${engineName}に接続できません`} desc={`${engineName}を起動してから再接続してください。接続できない間は編集できません。`}>
          <div class="row gap">
            <input value={engineUrl} onInput={(e) => setEngineUrl((e.target as HTMLInputElement).value)} />
            <Button
              variant="primary"
              onClick={async () => {
                await connect(engineUrl);
                setDraft({ ...draft, engineUrl });
              }}
            >
              再接続
            </Button>
            <Button
              disabled={starting}
              onClick={async () => {
                setStarting(true);
                try {
                  const r = await api('voice:engine-start', engineUrl);
                  flash(r.message, r.ok ? 'ok' : 'error');
                  if (r.ok) await connect(engineUrl);
                } finally {
                  setStarting(false);
                }
              }}
            >
              {starting ? '起動中…' : `${engineName}を起動`}
            </Button>
          </div>
          {engine?.error && <p class="muted small mono">{engine.error}</p>}
        </Card>
      )}

      <div class={engine?.ok ? '' : 'disabled-area'}>
        <div class="preview-bar card">
          <input class="grow" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} placeholder="テスト文" />
          <Select value={previewEmotion} options={EMOTIONS.map((e) => ({ value: e, label: EMOTION_LABELS[e] }))} onChange={(v) => setPreviewEmotion(v)} />
          <Button variant="primary" disabled={busy} onClick={() => preview(draft)}>▶ 試聴</Button>
          <Button disabled={busy} onClick={() => preview(saved)} title="保存済みの声で再生（聞き比べ）">保存済みで</Button>
          <Button variant="ghost" onClick={() => { stopWav(); void api('voice:stop'); }}>■ 停止</Button>
          <Toggle checked={onModel} onChange={setOnModel} label="モデルに話させる" />
        </div>

        <Tabs
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          tabs={(
            [
              { id: 'speaker', label: '声の選択' },
              { id: 'sample', label: 'サンプルから' },
              { id: 'base', label: '基本の調声' },
              { id: 'emotion', label: '感情別' },
              { id: 'dict', label: '辞書' },
              { id: 'phrase', label: '定型文', badge: draft.phrases.length ? String(draft.phrases.length) : undefined },
            ] as { id: Tab; label: string; badge?: string }[]
          ).filter((t) => adv || !ADVANCED_TABS.includes(t.id))}
        />
        {!adv && <p class="muted small">サンプル音声からの自動調声・感情別の補正・定型文は、設定画面の「拡張設定」をONにすると使えます。</p>}

        {tab === 'speaker' && (
          <Card
            title="読み上げエンジン"
            desc="AivisSpeechはVOICEVOXと同じ使い方ができる別のエンジンで、抑揚がより自然です。音の高さの指定と定型文のアクセント調整は使えず、口の動きは音量に合わせます。"
          >
            <div class="row gap wrap">
              {(Object.keys(ENGINE_PRESETS) as EngineKind[]).map((k) => (
                <button type="button" class={`chip-btn ${engineKindFromUrl(draft.engineUrl) === k ? 'on' : ''}`} disabled={starting} onClick={() => void switchEngine(ENGINE_PRESETS[k].url)}>
                  {ENGINE_PRESETS[k].label}
                </button>
              ))}
              <Button small variant="ghost" onClick={() => api('app:open-external', kind === 'aivis' ? 'https://aivis-project.com/' : 'https://voicevox.hiroshiba.jp/')}>{engineName}の入手先</Button>
              {starting && <span class="muted small">起動中…（初回は1分ほどかかることがあります）</span>}
            </div>
          </Card>
        )}

        {tab === 'speaker' && (
          <Card
            title="話者とスタイル"
            desc={
              kind === 'aivis'
                ? `AivisSpeech ${engine?.version ?? ''}。音声合成モデルごとにライセンスが異なります。公開する作品で使うときは、モデルの配布ページの利用条件に従ってください。`
                : `VOICEVOX ${engine?.version ?? ''}。公開する作品では「VOICEVOX:キャラクター名」のクレジット表記を行い、キャラクターごとの利用規約に従ってください。`
            }
            actions={<Button small onClick={() => api('app:open-external', ENGINE_PRESETS[kind].termsUrl)}>利用規約を開く</Button>}
          >
            {currentSpeaker && (
              <p>
                選択中: <b>{styles.find((s) => s.id === draft.speakerId)?.label}</b>
                {kind === 'voicevox' && <span class="muted small">　クレジット表記: VOICEVOX:{currentSpeaker.name}</span>}
              </p>
            )}
            <div class="speaker-grid">
              {speakers.map((sp) => (
                <div class={`speaker ${sp.styles.some((st) => st.id === draft.speakerId) ? 'selected' : ''}`}>
                  <div class="speaker-name">{sp.name}</div>
                  <div class="row gap wrap">
                    {sp.styles.map((st) => (
                      <button
                        type="button"
                        class={`chip-btn ${st.id === draft.speakerId ? 'on' : ''}`}
                        onClick={() => {
                          const next = { ...draft, speakerId: st.id };
                          setDraft(next);
                          void preview(next, 'neutral', `${sp.name}です。よろしくお願いします。`);
                        }}
                      >
                        {st.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {tab === 'sample' && <VoiceFitTab draft={draft} onApply={setDraft} onPreview={(v, t) => preview(v, 'neutral', t)} />}

        {tab === 'base' && (
          <Card
            title="基本の調声"
            desc={
              kind === 'aivis'
                ? 'すべての発話にかかる基本値です。AivisSpeechでは「抑揚」は感情表現の強さになり、「音高」を0から動かすと音質が落ちることがあります。'
                : 'すべての発話にかかる基本値です。全体の話速倍率（設定画面）はこれに掛けられます。'
            }
          >
            {(Object.keys(NATURAL) as (keyof VoiceBase)[]).some((k) => outside(k, draft.base[k])) && (
              <div class="notice warn">
                <p>
                  <b>声が不自然になりやすい値です。</b>抑揚を強くしすぎると高い音がかすれたり裏返ったりし、話速を遅くしすぎると母音が間延びします。
                  目安は 話速 {NATURAL.speedScale!.join('〜')}、音高 {NATURAL.pitchScale!.join('〜')}、抑揚 {NATURAL.intonationScale!.join('〜')} です。
                </p>
                <Button
                  small
                  onClick={() => {
                    const b = { ...draft.base };
                    for (const k of Object.keys(NATURAL) as (keyof VoiceBase)[]) b[k] = Math.min(NATURAL[k]![1], Math.max(NATURAL[k]![0], b[k]));
                    setDraft({ ...draft, base: b });
                  }}
                >
                  目安の範囲に収める
                </Button>
              </div>
            )}
            <div class="grid1">
              {(Object.keys(VOICE_RANGES) as (keyof VoiceBase)[]).map((k) => {
                const r = VOICE_RANGES[k];
                return (
                  <Field label={r.label} hint={outside(k, draft.base[k]) ? `${k}（目安 ${NATURAL[k]!.join('〜')}）` : k}>
                    <Slider value={draft.base[k]} min={r.min} max={r.max} step={r.step} unit={k.endsWith('Length') ? '秒' : ''} onInput={(v) => setDraft({ ...draft, base: { ...draft.base, [k]: v } })} />
                  </Field>
                );
              })}
            </div>
          </Card>
        )}

        {tab === 'emotion' && (
          <Card
            title="感情別の補正"
            desc={`話速と抑揚は基本値への倍率、音高は加算値です${kind === 'aivis' ? '（AivisSpeechでは音高の補正は使いません）' : ''}。スタイルを指定すると、その感情のときだけ別スタイルで話します。`}
          >
            <Field label="感情に合うスタイルがあれば、それで話す" hint="喜び・悲しみ・怒りなどのスタイルを持つ話者なら、音の高さを上げて感情を出す代わりにスタイルを切り替えます（強めの感情のときだけ）。下の表で個別に設定した感情は、そちらが優先です。">
              <Toggle checked={draft.autoEmotionStyles !== false} onChange={(v) => setDraft({ ...draft, autoEmotionStyles: v })} />
            </Field>
            <table class="table emo-table">
              <thead>
                <tr><th>感情</th><th>スタイル</th><th>話速×</th><th>音高＋</th><th>抑揚×</th><th /></tr>
              </thead>
              <tbody>
                {EMOTIONS.filter((e) => e !== 'neutral').map((e) => {
                  const custom = !!draft.emotions[e];
                  const auto = custom ? undefined : autoStyles[e];
                  const dflt = DEFAULT_EMOTION_VOICE[e] ?? NEUTRAL_EMOTION_VOICE;
                  const ev: EmotionVoice = draft.emotions[e] ?? (auto != null ? { ...dflt, styleId: auto, pitchAdd: 0, intonationMul: 1 } : dflt);
                  const upd = (patch: Partial<EmotionVoice>) => setDraft({ ...draft, emotions: { ...draft.emotions, [e]: { ...ev, ...patch } } });
                  return (
                    <tr class={custom ? '' : 'muted-row'}>
                      <td><span class={`emo-dot emo-${e}`} />{EMOTION_LABELS[e]}</td>
                      <td>
                        <Select
                          value={ev.styleId ?? -1}
                          options={[{ value: -1, label: '基本と同じ' }, ...(currentSpeaker?.styles ?? []).map((st) => ({ value: st.id, label: st.id === auto ? `${st.name}（自動）` : st.name }))]}
                          onChange={(v) => upd({ styleId: v === -1 ? null : v })}
                        />
                      </td>
                      <td><Slider value={ev.speedMul} min={0.5} max={1.5} step={0.01} onInput={(v) => upd({ speedMul: v })} /></td>
                      <td><Slider value={ev.pitchAdd} min={-0.15} max={0.15} step={0.01} onInput={(v) => upd({ pitchAdd: v })} /></td>
                      <td><Slider value={ev.intonationMul} min={0} max={2} step={0.01} onInput={(v) => upd({ intonationMul: v })} /></td>
                      <td><Button small onClick={() => preview(draft, e, SAMPLE[e])}>▶</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}

        {tab === 'dict' && <DictTab onPreview={(t) => preview(draft, 'neutral', t)} />}

        {tab === 'phrase' && kind === 'aivis' && (
          <div class="notice warn"><p>AivisSpeechはアクセントや音の高さの指定を使わないため、定型文は読み上げに反映されません（VOICEVOXに戻すと使えます）。</p></div>
        )}
        {tab === 'phrase' && (
          <PhraseTab
            phrases={draft.phrases}
            styleId={draft.speakerId}
            onChange={(phrases) => setDraft({ ...draft, phrases })}
            onPreview={(t) => preview(draft, 'neutral', t)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------- dictionary ----------------

function DictTab(p: { onPreview(text: string): void }) {
  const [words, setWords] = useState<VoiceDictWord[]>([]);
  const empty: DictWordInput = { surface: '', pronunciation: '', accentType: 0, wordType: 'PROPER_NOUN', priority: 5 };
  const [form, setForm] = useState<DictWordInput>(empty);
  const [editing, setEditing] = useState<number | null>(null);
  const reload = async () => setWords(await api('voice:dict-list'));
  useEffect(() => void reload(), []);

  const submit = async () => {
    const r = editing ? await api('voice:dict-update', editing, form) : await api('voice:dict-add', form);
    if (!r.ok) return flash(r.error ?? '登録できませんでした', 'error');
    flash(editing ? '更新しました' : '登録しました');
    setForm(empty);
    setEditing(null);
    await reload();
  };

  return (
    <Card title="単語辞書" desc="読み間違いやアクセントを直します。VOICEVOXエンジンとアプリの両方に保存し、エンジン側から消えていたら起動時に再登録します。">
      <div class="dict-form">
        <Field label="表記"><input value={form.surface} onInput={(e) => setForm({ ...form, surface: (e.target as HTMLInputElement).value })} placeholder="例: DesktopMMD" /></Field>
        <Field label="読み（カタカナ）"><input value={form.pronunciation} onInput={(e) => setForm({ ...form, pronunciation: (e.target as HTMLInputElement).value })} placeholder="デスクトップエムエムディー" /></Field>
        <Field label="アクセント型" hint="0は平板。数字の位置で音が下がる"><input type="number" min={0} max={30} value={form.accentType} onInput={(e) => setForm({ ...form, accentType: Number((e.target as HTMLInputElement).value) })} /></Field>
        <Field label="品詞"><Select value={form.wordType} options={WORD_TYPES} onChange={(v) => setForm({ ...form, wordType: v })} /></Field>
        <Field label="優先度"><Slider value={form.priority} min={0} max={10} step={1} onInput={(v) => setForm({ ...form, priority: v })} /></Field>
        <div class="row gap end">
          <Button disabled={!form.surface} onClick={() => p.onPreview(`${form.surface}を使っています。`)}>この単語で試聴</Button>
          {editing && <Button variant="ghost" onClick={() => { setEditing(null); setForm(empty); }}>取消</Button>}
          <Button variant="primary" disabled={!form.surface || !form.pronunciation} onClick={submit}>{editing ? '更新' : '登録'}</Button>
        </div>
      </div>
      {words.length === 0 ? (
        <Empty>まだ単語がありません</Empty>
      ) : (
        <table class="table">
          <thead>
            <tr><th>表記</th><th>読み</th><th>アクセント</th><th>品詞</th><th>優先度</th><th>エンジン</th><th /></tr>
          </thead>
          <tbody>
            {words.map((w) => (
              <tr>
                <td>{w.surface}</td>
                <td>{w.pronunciation}</td>
                <td>{w.accentType}</td>
                <td>{WORD_TYPES.find((t) => t.value === w.wordType)?.label}</td>
                <td>{w.priority}</td>
                <td>{w.engineUuid ? <Pill kind="ok">登録済</Pill> : <Pill kind="warn">未同期</Pill>}</td>
                <td class="row gap end">
                  <Button small onClick={() => p.onPreview(`${w.surface}を使っています。`)}>▶</Button>
                  <Button small onClick={() => { setEditing(w.id); setForm({ surface: w.surface, pronunciation: w.pronunciation, accentType: w.accentType, wordType: w.wordType, priority: w.priority }); }}>編集</Button>
                  <Button small variant="ghost" onClick={async () => { await api('voice:dict-delete', w.id); await reload(); }}>削除</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------- fixed phrases with accent editing ----------------

function PhraseTab(p: { phrases: VoicePhrase[]; styleId: number; onChange(ph: VoicePhrase[]): void; onPreview(text: string): void }) {
  const [newText, setNewText] = useState('');
  const [open, setOpen] = useState<number | null>(p.phrases.length ? 0 : null);

  const add = async () => {
    const r = await api('voice:accent-phrases', newText, p.styleId);
    if (!r.ok || !r.accentPhrases) return flash(r.error ?? '取得できませんでした', 'error');
    p.onChange([...p.phrases, { text: newText, styleId: p.styleId, accentPhrases: r.accentPhrases }]);
    setOpen(p.phrases.length);
    setNewText('');
  };

  const update = (i: number, ph: VoicePhrase) => p.onChange(p.phrases.map((x, j) => (j === i ? ph : x)));

  return (
    <Card title="定型文" desc="挨拶などよく使う文を、アクセント句ごとに音の高さと長さまで調整して保存します。本文がこの文と一致したら、保存した通りに話します。">
      <div class="row gap">
        <input class="grow" value={newText} placeholder="例: おはようございます" onInput={(e) => setNewText((e.target as HTMLInputElement).value)} />
        <Button variant="primary" disabled={!newText.trim()} onClick={add}>追加</Button>
      </div>
      {p.phrases.length === 0 && <Empty>定型文はまだありません</Empty>}
      {p.phrases.map((ph, i) => (
        <div class="phrase">
          <div class="row between">
            <button type="button" class="link" onClick={() => setOpen(open === i ? null : i)}>{open === i ? '▾' : '▸'} {ph.text}</button>
            <div class="row gap">
              <Button small onClick={() => p.onPreview(ph.text)}>▶</Button>
              <Button small variant="ghost" onClick={() => p.onChange(p.phrases.filter((_, j) => j !== i))}>削除</Button>
            </div>
          </div>
          {open === i && <AccentEditor phrase={ph} onChange={(x) => update(i, x)} />}
        </div>
      ))}
    </Card>
  );
}

function AccentEditor(p: { phrase: VoicePhrase; onChange(ph: VoicePhrase): void }) {
  const ph = p.phrase;
  const setAP = (aps: VoicevoxAccentPhrase[]) => p.onChange({ ...ph, accentPhrases: aps });
  const recalc = async (aps: VoicevoxAccentPhrase[]) => {
    const r = await api('voice:mora-data', aps, ph.styleId);
    if (r.ok && r.accentPhrases) setAP(r.accentPhrases);
    else flash(r.error ?? '再計算できませんでした', 'error');
  };
  return (
    <div class="accent-editor">
      {ph.accentPhrases.map((ap, ai) => (
        <div class="ap">
          <div class="ap-row">
            <span class="small muted">アクセント</span>
            <Select
              value={ap.accent}
              options={ap.moras.map((_, k) => ({ value: k + 1, label: `${k + 1}（${ap.moras[k].text}）` }))}
              onChange={(v) => {
                const aps = structuredClone(ph.accentPhrases);
                aps[ai].accent = v;
                void recalc(aps);
              }}
            />
          </div>
          <div class="moras">
            {ap.moras.map((m, mi) => (
              <div class="mora">
                <input
                  type="range"
                  class="vertical"
                  min={0}
                  max={6.5}
                  step={0.01}
                  value={m.pitch}
                  title={`高さ ${m.pitch.toFixed(2)}`}
                  onInput={(e) => {
                    const aps = structuredClone(ph.accentPhrases);
                    aps[ai].moras[mi].pitch = Number((e.target as HTMLInputElement).value);
                    setAP(aps);
                  }}
                />
                <span class="mora-text">{m.text}</span>
                <input
                  type="number"
                  class="num tiny"
                  min={0.01}
                  max={0.5}
                  step={0.01}
                  value={m.vowel_length.toFixed(2)}
                  title="母音の長さ（秒）"
                  onChange={(e) => {
                    const aps = structuredClone(ph.accentPhrases);
                    aps[ai].moras[mi].vowel_length = Math.max(0.01, Number((e.target as HTMLInputElement).value));
                    setAP(aps);
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
      <p class="muted small">縦のスライダーで音の高さ、下の数字で母音の長さ（秒）を調整します。アクセント位置を変えると高さを自動で再計算します。</p>
    </div>
  );
}
