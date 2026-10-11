---
name: mmd-voice-pipeline
description: DesktopMMDの音声まわりの設計。VOICEVOX（とAivisSpeech）エンジンHTTP APIの使い方（audio_query/synthesis/accent_phrases/mora_data/user_dict/speakers）、調声値の計算式と範囲、音高の頭打ち、感情別の補正とスタイル切り替え、音質フィルター、定型文、単語辞書のアプリ側控えと再登録、文単位の先行合成キューと中止、Windows標準音声へのフォールバック、Pythonサイドカー（Silero VAD v6のストリーミング、faster-whisper、multilingual-e5-small埋め込み、WebSocketプロトコル、生存監視）、マイク取得と割り込み判定を定める。SpeechService・VoicevoxClient・調声画面・サイドカー・MicCaptureを書く／直すとき、音声が出ない・遅い・聞き取れないといった問題を調べるときに使う。
---

# 音声パイプライン

仕様書3.6、5.6、6.5の実装規則。

## 1. VOICEVOX エンジン API（http://127.0.0.1:50021）

ローカルに `%LOCALAPPDATA%\Programs\VOICEVOX\vv-engine\run.exe` がある。開発中はこれを起動すれば使える（`scripts/start-voicevox.ps1`）。

- アプリ起動時の自動起動: `speech/VoicevoxLauncher.ts`（settings.voice.autoStartEngine / enginePath）。URLがこのPCのときだけ、`/version` が答えず**ポートも空いている**ときに run.exe を `--host 127.0.0.1 --port <URLのポート>` で起動する。ポートが使用中（エディタが起動中で /version がまだ答えない等）なら二重起動せず応答を待つ。自分で起動したものだけ終了時に `taskkill /T /F`（同期）で止める。

| 用途 | 呼び出し | 備考 |
| --- | --- | --- |
| 生存確認 | `GET /version` | 文字列 |
| 話者一覧 | `GET /speakers` | `[{name, speaker_uuid, styles:[{name, id}]}]` |
| 話者の初期化 | `POST /initialize_speaker?speaker=ID&skip_reinit=true` | 初回合成の遅延を消す。起動時と話者変更時に呼ぶ |
| クエリ作成 | `POST /audio_query?text=…&speaker=ID` | AudioQuery を返す |
| 合成 | `POST /synthesis?speaker=ID`（body: AudioQuery JSON） | `audio/wav` |
| アクセント句 | `POST /accent_phrases?text=…&speaker=ID` | 定型文編集用 |
| モーラ再計算 | `POST /mora_data?speaker=ID`（body: accent_phrases） | 高さと長さを再計算 |
| 辞書一覧 | `GET /user_dict` | `{uuid: {surface, pronunciation, accent_type, word_type, priority, …}}` |
| 辞書追加 | `POST /user_dict_word?surface=&pronunciation=&accent_type=&word_type=&priority=` | uuid（JSON文字列）を返す |
| 辞書更新 | `PUT /user_dict_word/{uuid}?surface=&pronunciation=&accent_type=&word_type=&priority=` | 204 |
| 辞書削除 | `DELETE /user_dict_word/{uuid}` | 204 |

- word_type は `PROPER_NOUN | COMMON_NOUN | VERB | ADJECTIVE | SUFFIX`。pronunciation はカタカナのみ、accent_type は 0〜モーラ数。
- AudioQuery のキー: `accent_phrases, speedScale, pitchScale, intonationScale, volumeScale, prePhonemeLength, postPhonemeLength, pauseLength(null可), pauseLengthScale, outputSamplingRate, outputStereo, kana`。
- Mora: `text, consonant?, consonant_length?, vowel, vowel_length, pitch`。AccentPhrase: `moras, accent, pause_mora?, is_interrogative`。
- タイムアウト: audio_query 10秒、synthesis 15秒（自動調声の長文は60秒）。失敗したら FallbackTts へ。

## 2. 調声の計算（speech/voiceTuning.ts、純粋関数）

```
q.speedScale       = base.speedScale × emo.speedMul × settings.voice.speed
q.pitchScale       = base.pitchScale + emo.pitchAdd
q.intonationScale  = base.intonationScale × emo.intonationMul
q.volumeScale      = base.volumeScale × settings.voice.volume
q.pauseLengthScale, prePhonemeLength, postPhonemeLength = base の値
speaker            = emo.styleId ?? voice.speakerId
```

- **自動の感情スタイル**: emotions に無い感情で、強さ0.5以上、`voice.autoEmotionStyles !== false` のとき、`autoEmotionStyles(speakers, speakerId)`（同じ話者で名前に「喜び」「かなしみ」「怒り」等を含むスタイル）があればそれを speaker にし、pitchAdd=0・intonationMul=1 にする（音を上げて感情を出すと高音が崩れるため）。
- **VOICEVOX は音高・抑揚をアプリ側でかける**（speech/pitchShape.ts の `shapePitch`）: 語尾上げ→pitchScale→intonationScale を ENGINE と同じ式でモーラの高さに焼き、文の本来の音域（抑揚1.0の最高・最低）からのはみ出しを上0.5〜2半音・下1.5〜3.5半音で tanh で頭打ち。さらに**絶対上限**として、全体が感情の音高補正などで持ち上がっても、基本の音高（`voice.base.pitchScale`）での本来の最高音から上1.5〜3半音までに頭打ち（`ABSOLUTE_UP_LIMIT`、第3引数 `basePitchScale`）。送るクエリは pitchScale=0・intonationScale=1、`synthesis(…, upspeak=false)`。renderer に渡す query もこれ（語尾上げモーラ入りなので口パクも合う）。
- **AivisSpeech**（@shared/voiceEngine、`SpeechService.engineKindOf` が /engine_manifest の name で判定）: モーラの長さ・高さが 0 で返るので query=null（口パクは音量）、定型文は使わない、emo.pitchAdd は無視（pitchScale を動かすと劣化。intonationScale は感情表現の強さ）。shapePitch もかけない。既定ポート10101、`run.exe` は `AivisSpeech\AivisSpeech-Engine\`。
- 調声の目安（UIの注意と自動調声の FIT_LIMITS）: 話速0.75〜1.5、音高±0.08、抑揚0.6〜1.5。
- 再生前の音質フィルター（renderer/shared/voiceFilter.ts、設定 `voice.postFilter`: off / soft / room）はキャラクター画面と試聴で共通。

- emotions に無い感情は補正なし（mul=1, add=0）。intensity が 1 未満なら補正を線形に弱める: `mul' = 1 + (mul−1)×intensity`、`add' = add×intensity`。
- 結果は 6.5 の範囲で clamp（speed 0.5〜2.0、pitch −0.15〜0.15、intonation/volume/pause 0〜2、pre/post 0〜1.5）。
- 既定の感情補正（character.json に無い場合のプリセット）: happy {speed 1.05, pitch +0.03, inton 1.15}、sad {0.92, −0.02, 0.9}、surprised {1.08, +0.04, 1.2}、angry {1.03, −0.01, 1.1}、troubled {0.97, −0.01, 0.95}、shy {0.97, +0.02, 1.05}、thinking {0.95, 0, 0.95}。
- 定型文: 本文（整形後、句読点と空白を除いて比較）が phrases の text と一致したら、保存済み accentPhrases で AudioQuery を組み立て（audio_query を省略）、調声値だけ上書きして synthesis。

### サンプル音声からの自動調声（speech/voiceAnalysis.ts・voiceFit.ts、純粋関数）

- 特徴量は合成音もサンプルも**同じ解析器**で測る（解析のくせを打ち消すため）: F0中央値（YIN、8kHz）、ln F0 の標準偏差（＝intonationScale が掛かる量）、発話時間（音量しきい値超え）、MFCC c1〜c12 平均（声色）。
- 雑音対策: サンプルの無音区間の平均パワースペクトルと「しきい値がピークから何dB下か」を `NoiseRef` に入れ、合成音の解析では声の大きさをそろえてから同じ雑音を足し、同じ深さのしきい値を使う。これが無いと雑音入りのサンプルで話者の順位も話速も崩れた（実測）。
- 音高は `ln F0 × 2^pitchScale`（エンジンの実装）で見当 → 2点の割線で補正。抑揚・話速は測定値の比で補正。合成は 1スタイル3回。
- 探索はふるい分け（短い文・既定値で全スタイル）→ 上位3つを調整。全99スタイルで1.5〜2分。**エンジンが全部の声を読み込むのでメモリが数GB増える**（エンジン再起動で戻る）。
- 書き起こしはサイドカーの `transcribe_clip`。内容が無い（認識不可）ときは話速を合わせない。

## 3. SpeechService（文単位の先行合成キュー）

- `enqueue(sentence)` → 合成ジョブを作る。**同時に先行するのは2文まで**（再生中の文＋次の2文）。
- 合成結果 `{sentenceId, wav: ArrayBuffer, audioQuery|null, durationMs}` を `speech:audio` で renderer へ。renderer の AudioPlayer は sentenceId 順に連続再生し、各文の再生開始・終了を `speech:played` で返す。
- `cancel()`: 進行中の fetch を AbortController で止め、未再生分を破棄し、renderer に `speech:stop` を送る。
- ミュート時は合成しない（吹き出しだけ）。
- 試聴（voice:preview）は**別キュー**。会話中なら会話を優先し、試聴は待たせる。
- 遅延計測: 文の enqueue 時刻と最初の `speech:played(start)` を latency に記録（NFR-01）。

## 4. フォールバック（Windows標準音声）

VOICEVOX に接続できない／合成失敗が続く場合、PowerShell の `System.Speech.Synthesis.SpeechSynthesizer` で WAV を一時ファイルに出して読み込む（`SetOutputToWaveFile`）。ファイルはすぐ消す。audioQuery は null なので口パクは音量方式。30秒ごとに VOICEVOX の /version を見て戻れるか確認する。

## 5. 単語辞書の控え（voice_dict テーブル）

- 追加・更新・削除は **エンジンとアプリの控えを同時に**更新（どちらか失敗したら控えを優先して再試行キューへ）。
- 起動時同期: `GET /user_dict` の surface+pronunciation 集合と控えを比べ、エンジンに無いものを再登録し engine_uuid を更新（TC-17）。

## 6. Pythonサイドカー（sidecar/）

起動: main が `sidecar/.venv/Scripts/python.exe -I sidecar/main.py --port 0 --token <random>`（パッケージ時は PyInstaller の exe）。標準出力の最初の1行 `{"port": N}` を読んで WebSocket 接続。

プロトコル（JSONテキストフレーム＋音声はバイナリフレーム）:

| 方向 | type | 内容 |
| --- | --- | --- |
| main→py | hello | `{token, sttModel, device:'auto'|'cuda'|'cpu', wake:false, vocab:[...]}` 最初の1通。トークン不一致なら即切断 |
| main→py | listen_start / listen_stop | `{mode:'push'|'vad'}` push は stop 時に確定、vad は無音700msで自動確定 |
| main→py | (binary) | 16kHz/16bit/mono PCM。長さ任意（サイドカー側で512サンプルに組み直す） |
| main→py | embed | `{id, texts:[...], kind:'query'|'passage'}` |
| main→py | set_threshold | `{speakingBoost: true|false}` 発話中は割り込み閾値を上げる |
| py→main | ready | `{device, sttModel, loadMs}` |
| py→main | speech_start / speech_end | `{t}` |
| py→main | transcript | `{text, confidence, durationMs, procMs}` |
| py→main | embedding | `{id, vectors:[[384 floats]...]}` |
| main→py | transcribe_clip | `{id, pcm: base64 PCM16 16kHz mono}`（自動調声のサンプル、最大20秒） |
| py→main | clip_transcript | `{id, text}`（聞き取れなければ空）。失敗は `error{component:'clip', id}` |
| 双方向 | ping / pong / error | 5秒間隔。main は応答なし15秒で kill→再起動（指数バックオフ最大30秒） |

VAD（Silero v6 ONNX、faster_whisper/assets/silero_vad_v6.onnx）:
- 入力 `input:[1,576]`（直前64サンプルの文脈＋512サンプル=32ms）、状態 `h,c:[1,1,128]` を持ち回す。出力 speech_probs。
- 開始: prob ≥ 0.5 が 3フレーム連続（約100ms）→ speech_start。発話中は閾値 0.65（自分の声対策）。
- 終了: prob < 0.35 が 700ms 続く → speech_end。開始前 300ms のリングバッファも含めて認識に回す。
- 0.4秒未満の発話は捨てる。最長30秒で強制確定。

STT（faster-whisper）:
- `WhisperModel(name, device='cuda', compute_type='float16')`、失敗したら `device='cpu', compute_type='int8'` かつモデルを `small` に落とす。
- `transcribe(audio, language='ja', beam_size=1, vad_filter=False, initial_prompt=<アシスタント名と辞書の語>, condition_on_previous_text=False)`。
- 幻聴フィルタ: 「ご視聴ありがとうございました」「チャンネル登録」「字幕」等を含む／同一文字の反復が多い／no_speech_prob>0.6 のものを捨てる。

埋め込み（multilingual-e5-small、ONNX）:
- `Xenova/multilingual-e5-small` の `onnx/model.onnx` と `tokenizer.json` を huggingface_hub でダウンロード（初回のみ、`%APPDATA%\mmd-assistant\models`）。
- 前置: query は `"query: "`、記憶本文は `"passage: "`。mean pooling → L2正規化。384次元 float32。

### 実測（RTX 4070 SUPER, 2026-10）

- `nvidia-cublas-cu12` を venv に入れ、`stt.add_cuda_dll_dirs()` で DLL フォルダを追加すると CUDA で動く。実際に読み込まれるのは `cublas64_12.dll` と `cublasLt64_12.dll` だけ（cuDNN・NVRTC は不要。プロセスのモジュール一覧で確認済み）。large-v3-turbo の読み込み 2.75秒、VOICEVOX音声（約3秒）の文字起こし 136ミリ秒。
- モデルは初回に `%APPDATA%\mmd-assistant\models\{whisper,hf}` へダウンロード（Whisper 約1.6GB、e5 約120MB）。HFは xet 経由で、進捗は `~/.cache/huggingface/xet/logs` に出る。
- VOICEVOX 0.23.0 で、リップシンクのタイムライン長と WAV 長の差は 50ms 未満（tests/integration/voicevox.test.ts）。

### exe化（インストーラー用）

- `npm run sidecar:build` → `sidecar/sidecar.spec`（PyInstaller one-folder）→ `sidecar/dist/sidecar/sidecar.exe`（約970MB、うち cuBLAS 約770MB）。
- cuBLAS は `_internal/nvidia/cublas/bin` に置く。凍結時は `stt.add_cuda_dll_dirs()` が `sys._MEIPASS` も探す。
- hf_xet（モデルの高速ダウンロード）は、モジュールだけでなく `copy_metadata('hf_xet')` で dist-info も同梱する。huggingface_hub は importlib.metadata で有無を判定するので、メタデータが無いと「入っていない」扱いになり通常のHTTPダウンロードに落ちる。
- 確認: `MMD_IT_SIDECAR=1 MMD_IT_SIDECAR_EXE=1 npx vitest run tests/integration/sidecar.test.ts`（exe でGPU起動・文字起こし・再起動まで）。
- electron-builder は `extraResources` で `resources/sidecar/` に入れ、パッケージ版は `process.resourcesPath/sidecar/sidecar.exe` を起動する（util/paths.ts）。

## 7. マイクとUI（renderer）

- `getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1}})`。AudioWorklet で 16kHz にダウンサンプルして Int16 に変換、約100msごとに `mic:frame` で送る。
- マイクは聞き取り中だけ送る（常時待受け＝wake が有効なときのみ常時）。
- 割り込み（FR-IN-05）: Speaking 中も VAD を回し（閾値高め）、speech_start が来たら Orchestrator が再生と生成を止めて Listening へ（0.3秒以内、TC-03）。
- Push-to-talk: Electron の globalShortcut は keyup を取れないので、**押して話す**ホットキーだけは `uiohook-napi`（N-API prebuilt、Electron 44で動作確認済み）で keydown/keyup を監視する（main/windows/pushToTalk.ts）。押下で listen_start(push)、離して listen_stop。押下が300ms未満なら録音を破棄して入力欄を開く（短押し）。他のホットキー（ミュート・表示切替）は globalShortcut。
- uiohook が起動できない環境では globalShortcut のトグル方式（1回目で開始、VAD終了か2回目で確定）に自動で切り替える。
