# DesktopMMD 開発ガイド

使う人向けの説明は [README.md](README.md)、仕様書は [Document/README.md](Document/README.md)、設計の地図は `.claude/skills/mmd-*` にあります。

## 構成

- 透過・最前面のキャラクターウィンドウ（Electron 44 + three.js r170 + MMDLoader + ammo.js物理）
- Claude API（Sonnet 5.5）でストリーミング応答。文ごとに感情タグ付きで表示・読み上げ
- VOICEVOX（または AivisSpeech）で読み上げ、モーラ単位のリップシンク。調声画面（エンジン・話者・サンプル音声からの自動調声・基本値・感情別・辞書・定型文）
- Windowsログイン時の自動起動、VOICEVOXエンジンの自動起動
- 押して話す音声入力（Pythonサイドカー: Silero VAD + faster-whisper、GPU対応）と割り込み
- 許可フォルダ内のファイル操作、アプリ・URL起動、Web検索、タイマー、クリップボード、画面撮影、MCP
- 3段階の権限（自動・確認・承認）と作業履歴からの取り消し
- 長期記憶（node:sqlite + FTS5、multilingual-e5-small埋め込み）、親密度、能動発話

## 必要なもの

- Windows 10/11（64bit）、Node.js 22以上、Python 3.11以上
- [VOICEVOX](https://voicevox.hiroshiba.jp/)
- Claude APIキー（無くても `npm run dev:fake` で疑似LLMで動かせます。ローカルAIを試すなら [Ollama](https://ollama.com/) と `ollama pull qwen3:8b`）
- テスト用のMMDモデル（PMX）。リポジトリには入れないこと（`*.pmx` は .gitignore 済み）

## セットアップと起動

```powershell
npm install                  # postinstall で ammo.wasm を src/renderer/public にコピー
npm run sidecar:setup        # sidecar/.venv を作成（GPUが無ければ: npm run sidecar:setup -- -Cpu）
npm run voicevox             # VOICEVOXエンジンを起動（アプリも起動時に自動で起動するので、普段は不要）
npm run dev                  # 開発起動
npm run dev:fake             # 疑似LLMで起動（API不要）
```

## テスト

```powershell
npm run typecheck
npm test                     # 単体・結合テスト（Vitest）
npm run test:voicevox        # VOICEVOXとの結合テスト（起動していなければskip）
npm run test:sidecar         # サイドカー（VAD・Whisper・埋め込み）の実地テスト。初回はモデルDLあり
npm run coverage
npm run latency-report       # 応答遅延の中央値
npm run eval:llm -- --yes    # 実APIでの評価（費用がかかる）
npx tsx --tsconfig tsconfig.node.json scripts/eval-local.ts --runs 3   # Ollama での同じ評価（無料。形式・ツール選択・インジェクション・速度）
```

## キャラクタースキル

- 書式の仕様: [docs/CHARACTER_SKILL_FORMAT.md](docs/CHARACTER_SKILL_FORMAT.md)
- 解析と検証: `src/main/character/skillFile.ts`（Electron非依存）
- 読み込み（更新日時でキャッシュ、エラー時は不使用）: `src/main/character/CharacterSkillService.ts`
- プロンプトへの差し込みとモードの知らせ: `src/main/character/skillPrompt.ts`（PromptBuilder と Orchestrator から使う）
- App が `characters/<id>/` を `fs.watch` で監視し、保存されたら `orc.endSession()` で次の発話から反映
- 検証: `npx tsx scripts/validate-skill.ts characters/sample/skill.md`
- テスト: `tests/unit/skillFile.test.ts`、`tests/unit/skillLoader.test.ts`、Orchestrator のモード切替テスト。壊した例は `tests/fixtures/skill/broken/skill.md`

## 自動起動（Windowsログイン時・VOICEVOX）

- ログイン時の起動: `src/main/system/autoLaunch.ts`。`HKCU\...\Run` に値名 `DesktopMMD`、引数 `--autostart` で登録する。**インストール版（`app.isPackaged`）でだけ登録**し、開発中は何もしない（electron.exe を登録してしまうため）。アンインストーラが `build/installer.nsh` で同じ値を消す（更新時は消さない）。
- 既定はON。v0.2.2 以前の settings.json は `autoLaunch: false` が保存されているので、`SettingsStore.migrateSettings`（settingsVersion 1→2）で一度だけONにする。
- VOICEVOX / AivisSpeech: `src/main/speech/VoicevoxLauncher.ts`。エンジンURLがこのPCのときだけ、`vv-engine\run.exe`（AivisSpeech はURLのポートが10101なら `AivisSpeech-Engine\run.exe`。`voice.enginePath` か既定のインストール先）を `--host 127.0.0.1 --port <URLのポート>` で起動する。ポートが既に使われている（VOICEVOXエディタが起動中など）ときは二重に起動せず応答を待つ。自分で起動したものだけ終了時に `taskkill /T` で止める。
- 確かめ方: インストール版を動かすのと同じ条件は `npx electron-builder --win dir` の `dist\win-unpacked\DesktopMMD.exe` で作れる（実行すると Run にその場所が登録されるので、確認後に消すこと）。

## サンプル音声からの自動調声

- 解析: `src/main/speech/voiceAnalysis.ts`（純TS。YINでF0、ln F0 の標準偏差で抑揚、音量しきい値で発話時間、MFCC平均で声色）。サンプルの雑音スペクトルと発話しきい値の深さを `NoiseRef` に入れ、合成音の解析でも同じ雑音を足して条件をそろえる（入れないと雑音で声色の比較が崩れる）。
- 探索: `src/main/speech/voiceFit.ts`。全スタイルで短い文を既定値で合成して声色＋地声の高さでふるい分け → 上位3つで「合成→測定→補正」を3回（音高は `ln F0 × 2^pitchScale` の式で見当を付けて割線法、抑揚と話速は比で直す）。
- デコードは管理画面（WebAudio で mp3 等 → 16kHz モノラルの先頭20秒）、書き起こしはサイドカーの `transcribe_clip`。どちらも `App.runVoiceFit` がまとめる。
- 実エンジンでの確認（scratch で実施）: 話者の出力を雑音入りでサンプルにして99スタイルから探し、正しい話者が1位、話速・音高・抑揚の誤差は 0.02 / 0.003 / 0.07 程度。全スタイル探索は約1.5〜2分、VOICEVOXのメモリが数GB増える。

## 声の質（音高の上限・感情スタイル・音質フィルター・AivisSpeech）

- 音高の上限: `src/main/speech/pitchShape.ts`。VOICEVOX では pitchScale / intonationScale と疑問文の語尾上げをエンジンに任せず、同じ計算（ENGINE の `_apply_interrogative_upspeak` → `_apply_pitch_scale` → `_apply_intonation_scale`）をモーラの高さにかけてから、文の本来の音域（抑揚1.0のときの最高・最低モーラ）から上0.5〜2半音・下1.5〜3.5半音で tanh で頭打ちにする。さらに、感情の音高補正で文全体が持ち上がっても、基本の音高（`voice.base.pitchScale`）で動かした本来の最高音から上1.5〜3半音までに頭打ちにする（`ABSOLUTE_UP_LIMIT`、`shapePitch` の第3引数）。結果は pitchScale=0 / intonationScale=1 で、合成は `enable_interrogative_upspeak=false` で呼ぶ（`VoicevoxClient.synthesis(…, upspeak=false)`）。範囲内は ENGINE と同じ値になる（`tests/unit/voiceQuality.test.ts`）。自動調声の合成も同じ経路を通す。
- 実測（満別花丸ぶりっ子、抑揚1.82）: モーラの高さの頭打ちは効くが、合成音のF0の98パーセンタイルはほとんど変わらない（ボコーダが目標より上振れするため）。効果が大きいのは抑揚と話速そのものを戻すこと。そのため調声画面で目安（話速0.75〜1.5・音高±0.08・抑揚0.6〜1.5）を外れると注意を出し、自動調声の `FIT_LIMITS` もこの範囲にした。
- 感情スタイル: `@shared/emotions` の `EMOTION_STYLE_WORDS` / `autoEmotionStyles`。基本のスタイルと同じ話者で、名前に感情語を含むスタイルを選ぶ（ささやき系は使わない）。`computeTuning(…, { autoStyles })` が、感情別の設定が無く強さ0.5以上のときだけ使い、そのときは音高・抑揚の補正をかけない。`CharacterVoice.autoEmotionStyles === false` で無効。話者一覧は `SpeechService` がエンジンURLごとに覚え、`warmUp` で捨てる。
- 音質フィルター: `src/renderer/shared/voiceFilter.ts`（3.2kHz −2.5dB のピーキング、8kHz −4dB のハイシェルフ、閾値−20dB・比2.5 の圧縮、`room` は0.35秒の残響を0.1）。キャラクター画面の `AudioPlayer` と管理画面の試聴（`playWav(wav, filter)`）で共通。設定 `voice.postFilter`、キャラクター画面へは `ViewSettingsPayload.voiceFilter`。
- AivisSpeech: `@shared/voiceEngine`。種類は `/engine_manifest` の name で見分け（取れなければポート10101なら aivis）、`SpeechService.engineKindOf` がURLごとに覚える。AivisSpeech はモーラの長さ・高さを返さない（0）ので、`SpeechAudioPayload.query` を null にして口パクを音量で動かす。定型文は使わず、感情の音高補正もかけない（pitchScale を動かすと音質が落ちる。intonationScale は感情表現の強さ）。自動調声は `fixPitch`。起動は `findEngineExe(…, 'aivis')` が `%LOCALAPPDATA%\Programs\AivisSpeech\AivisSpeech-Engine\run.exe` を探し、URLのポートから種類を決める。辞書APIはVOICEVOXと同じ。
- 確認: AivisSpeech Engine 1.2.0（Windows版を scratch に展開して :10101 で起動）で、話者一覧・合成・感情スタイル（まお: 悲しみ→せつなめ）・辞書の取得・管理画面での切り替えを確認した。

## 管理画面の構成（基本と拡張設定・使い始めの確認）

- 設定画面は、よく使う項目だけを常に出し、細かい項目は設定 `ui.advanced`（右上の「拡張設定」トグル）がONのときだけ各カードの下に出す。区画は `ui.tsx` の `<Advanced show={adv}>`（OFFなら何も描かない）。新しい設定項目を足すときは、初めて使う人が触る必要があるかで基本か拡張かを決める。迷ったら拡張に入れる。
- 調声画面の「サンプルから」「感情別」「定型文」のタブも拡張設定のときだけ出す（`VoicePage.tsx` の `ADVANCED_TABS`）。
- `ui.*` だけの変更は表示のためなので、`App.onSettingsChanged` の重い処理（許可フォルダの再設定・キャラクター画面への通知など）を走らせない（`window` と同じ扱い）。
- 設定画面のいちばん上の「使い始めの確認」（`pages/ReadinessCard.tsx`）は、会話のAI・PMX・読み上げエンジン・音声認識・呼び名の状態を「必要／おすすめ／準備中／OK」で並べ、足りないものへのボタン（はじめに・モデル選択・エンジン起動・調声）を出す。`setupCompleted` が false の間は「はじめの設定を続ける」も出す。
- 「はじめに」（`pages/SetupPage.tsx`）は、会話のAI（必須）→キャラクター→声→マイク→呼び名→使い方の6手順。会話のAI以外は「あとで設定する」で飛ばせる。声の手順に入ると `voice:speakers` で自動で接続を確かめ、つながらなければ `voice:engine-start` と配布ページを出す。最後の手順で `setup:complete`。
- 注意: `style.css` の `.num` は数値入力用（`width: 76px !important`）なので、ほかの用途の要素には別の名前を付ける（手順の丸は `.step-num`）。

## インストーラーの作成

```powershell
npm run sidecar:build        # Pythonサイドカーを sidecar.exe にまとめる（cuBLAS同梱、約1GB）
npm run dist                 # dist/DesktopMMD-Setup-<version>.exe
python scripts/make-icon.py  # アイコン（build/icon.ico）を作り直すとき
```

インストーラーにMMDモデルは含まれません。

`npm run dist` は最初に `scripts/build-readme.mjs` で README.md を `build/README.html`（インストーラーに同梱する1ファイルの説明書）に変換する。`docs/images/` の画像は埋め込み、見出しには GitHub と同じ規則の id を付ける。README 内のリンク（`#見出し`）の行き先が無いとエラーで止まるので、見出しの名前を変えたらリンクも直す。

## 自動更新

- 起動の約8秒後に `src/main/update/UpdateService.ts` が `https://api.github.com/repos/usamaru33/DesktopMMD/releases/latest` を確認する（Electron非依存。通信・保存先・インストーラー起動は注入）。
- 現在の版（`app.getVersion()`）より新しければ、リリースの資産 `DesktopMMD-Setup-<版>.exe`（https の github.com のものだけ）を `%TEMP%\DesktopMMD-update` に落とし、サイズと sha256（GitHub が付ける `digest`）を検証してから、`App.runInstaller` がインストーラーを `--updated /S --force-run` で直接（detached で）起動し、サイドカーを止めてから終了する。インストーラー（electron-builder の NSIS）は `--updated` でアプリの終了を待ち（残っていれば終了させ）、`/S` で静かに入れ、`--force-run` で終わったらアプリを起動し直す（electron-updater と同じ）。0.5.0 までは PowerShell を detached で起動して同じことをさせていたが、コンソールのない状態で起動された PowerShell は何も実行せずに終了コード0で終わるため、インストーラーが一度も動いていなかった（Electron から `detached: true` で起動するのは GUI のプログラムにすること）。
- 開発起動（`app.isPackaged` が false）、`MMD_FAKE_LLM=1`、設定 `autoUpdate` が OFF のときは何もしない。通信や検証の失敗はログ（`update`）に残すだけで、アプリは通常どおり使える。
- リリースの出し方: `package.json` の version を上げて `npm run dist` → GitHub で `v<版>` のタグでリリースを作り、`dist/DesktopMMD-Setup-<版>.exe` を添付する（prerelease・draft は対象外）。
- 手動確認: 設定画面の「バージョン」カードのボタン → IPC `update:check`（`checkAndUpdate(true)`。自動更新の設定がOFFでも動くが、開発起動では `disabled`）。版の表示は IPC `app:version` とトレイメニューの先頭。
- テスト: `tests/unit/update.test.ts`

## 開発用の環境変数

| 変数 | 効果 |
| --- | --- |
| `MMD_FAKE_LLM=1` | 疑似LLMを使う |
| `MMD_SHOT=1` | 起動後に各画面のスクリーンショットを `out/shots/` に保存（`MMD_SHOT_QUIT=1` で終了、`MMD_SHOT_DELAY=ms`） |
| `MMD_NO_AUTOHIDE=1` | 全画面アプリを検知しても隠れない |
| `MMD_DEBUG=1` | レンダラのコンソールもすべてログに出す |
| `MMD_DATA_DIR=<フォルダ>` | データ（設定・DB・ログ）の置き場所を変える。撮影やテストで本物のデータを汚さないため |

データは `%APPDATA%\mmd-assistant`、ログは `%APPDATA%\mmd-assistant\logs` に出ます。

## Googleカレンダー連携

- OAuth は使わず、Googleカレンダーの「非公開URL（iCal形式）」を読む方式。Google Cloud のプロジェクトも審査も要らない。読み取り専用。
- `src/main/calendar/`: `icsParse.ts`（ical.js で繰り返し・TZID・EXDATE を展開）、`CalendarService.ts`（15分ごとに取得、前回分を保持）。接続先は `https://calendar.google.com/…*.ics` に限る（SSRF対策）。リダイレクトは拒否。
- URLは秘密情報。`Secrets`（`secrets.bin`、safeStorage）にだけ置き、ログ・エラー・設定取得・レンダラへは出さない（画面には末尾8文字のマスクだけ）。
- 声かけは `ProactiveEngine` の `schedule` 候補（`calendarSoon`）。同じ予定は一度だけ。「今日の予定は？」は読み取りツール `calendar_agenda`（L0）。予定の題名は他人が決められるので、`<` `>` を除いてから使う。
- 将来、予定の追加・変更が必要になったら OAuth（デスクトップ用クライアント＋ループバック）か、MCP サーバー（`mcp.servers`）経由にする。

## ローカルLLM（Ollama・会話のみ）

- 設定 `llm.provider`（`claude` / `local`）、`llm.localUrl`、`llm.localModel`。実装は `src/main/llm/LocalLlm.ts`（`OllamaClient` と `RoutingLlm`）、診断は `localProbe.ts`。
- `LlmAdapter` の3つ目の実装。`RoutingLlm` が会話（`stream`）を設定どおりに振り分け、記憶抽出などの裏の処理（`json`/`text`）は「APIキーがあればClaude、無ければローカル」。呼び出し側はClaudeのモデル名を渡すので、ローカル向けは `localModel` に差し替える。
- **既定は会話のみ**（`Orchestrator` の `chatOnly`: ツールもWeb検索も渡さず、システムは `CHAT_ONLY_RULES`＝できないと正直に言わせる）。`llm.localTools` をONにするとツールを渡す（実験的）。Web検索はClaudeのサーバーツールなのでローカルでは常に無し。
- ツール選択の実測（Qwen3 8B、`scripts/eval-local.ts`、14件×3回。出荷前の素のままだと 6〜7/14）:

  | 条件 | ツール選択 | 最初の文字 |
  | --- | --- | --- |
  | そのまま（思考オフ） | 約6.3/14 | 約0.06秒 |
  | 「承認が必要」の文言を外す | 約9.3/14 | 約0.06秒 |
  | 文言を外す＋思考オン | 14/14（2回） | 約2.6秒 |
  | **出荷: 文言を外す＋依頼らしい発話のときだけ思考オン** | 12〜14/14 | 雑談 約0.05秒 |

  - 主因は文言: 「承認が必要」を読むと、小さなモデルは会話で「よろしいですか？」と聞くだけでツールを呼ばない。承認は `PermissionGate` が必ず取るので、ローカルでは `toClaudeTools({ approvalHint: false })` と `approvalNote: false`（`Orchestrator` の `approvalHint`）で文言を外す。
  - 「ツールを必ず呼べ」と強く書き足すだけでは効かない（ばらつきの範囲）。granite4.1:8b は Qwen3 8B より悪かった（形式7/10、ツール6/14）。
  - 思考は `needsThinking`（`LocalLlm.ts`）で、ファイル・タイマー・記憶・画面・URL などの語を含む発話だけオンにする。ツール結果への返答では考え直さない。偽陽性は遅くなるだけ、偽陰性は「やります」と言うだけになる。
  - 残る失敗は記憶系（「忘れて」「それは違う」）で、ときどき呼ばずに言葉で済ませる。
- 14B はVRAM 12GBでは他アプリと同居できずCPUに溢れて約7 tok/s。8B級が上限の目安（`recommendLocal`）。
- Ollama の `num_ctx` は履歴の上限に合わせて 12288（`LOCAL_NUM_CTX`）。溢れると古い側が黙って切られる。起動時とモデル変更時に `warmUp` で先に読み込む（コールドロードは約1分）。
- `llm.localForProactive`: Claudeで会話していても、声かけ（`purpose: 'proactive'`）だけは `RoutingLlm` がローカルに回す（ツールなし・思考なし）。`local_down` のときだけ Claude にフォールバック（まだ何も話していないので安全）。他のエラー・中止はそのまま投げる。声かけは直前10分に会話が無いときにしか出ずキャッシュが冷えているため、Claudeに比べて損が無い。
- 切り替え・モデル変更・`localTools` の切り替えは `endSession()` で次の発話から新しいセッション（ツール一覧とシステムが変わるため）。
- 再測定: `scripts/eval-local.ts`（ケースは `scripts/eval-cases.ts` で `eval-llm.ts` と共有。出荷と同じ経路を通る。`--runs 3` でばらつきを見る、`--legacy` で出荷前の挙動、`--think` で常時思考）。

## 集中モード

- `src/main/proactive/FocusService.ts`: 開始・終了・残り時間（メモリのみ。アプリの再起動で終わる）。`start(1〜180分)`、置き換え可、`stop()` では終了の声かけを出さない。時間切れで `onEnd(分)` → `ProactiveEngine.fireFocusEnd`（抑止されたらトーストだけ）。
- 抑止: `suppressedBy` に `focusing` を渡し、`reminder` と `focus_end`（ユーザーが頼んだもの）以外はすべて `focus` で止める。`focus_end` は、能動発話OFF・ミュート・おやすみ・静かな時間帯・直近の会話・回数上限を無視する（全画面と通話中は従う）。1時間あたりの回数の数え方からも除く。
- 入口はツール `start_focus`（分は省略で25）/ `stop_focus`（どちらもL0）と、トレイの「集中モード」。ツールは `createAssistantTools` の第4引数 `FocusToolPort` を渡したときだけ登録される。
- 声かけの文面は `PROACTIVE_PROMPTS.focus_end`。評価ケース（`scripts/eval-cases.ts`）にも入っている。ローカルAI（Qwen3 8B、ツール有効）で `start_focus` はほぼ呼べるが、`stop_focus` は集中中かどうかを知らないので、言葉だけで済ませることがある。

## ふりかえり日記

- `src/main/journal/`: `journal.ts`（純粋: 日の範囲、素材→プロンプト、出力の整形、ファイル名、マーカー）と `JournalService.ts`（素材の収集、フォルダ検証、書き込み、スケジュール）。設定 `journal.{enabled,time,folder}`（既定OFF・22:30・`~\Documents\DesktopMMD日記`）。IPC は `journal:run` / `journal:open-folder`。
- 流れ: `App` が1分ごとに `tick()`（起動30秒後にも1回）。設定時刻を過ぎていて今日の分が未作成なら `run()`。起動後の最初の `tick` では前日の分も見る（PCが落ちていた日）。素材が無ければ LLM を呼ばず次の分にもう一度見る（夜遅くに話すこともあるため）。失敗は30分あけて再試行。
- 素材: `ConversationRepo.messagesBetween`（`no_memory` のセッションと `source='proactive'` を除く）、`ToolRunRepo.executedBetween`（実行された作業のみ。拒否・ブロックは含めない）、`MemoryRepo.createdBetween` / `schedulesDueBetween`。LLM へは `purpose: 'journal'` の `text()`（`RoutingLlm` により、APIキーがあればClaude、無ければローカル）。
- 安全: 書くのはアプリで、モデルはパスを決めない。保存先は `PathGuard.check` で許可フォルダ内を確認（フォルダ作成の前と後の2回。ジャンクションで外に出られないように）。同名のファイルは、先頭が `generated-by: DesktopMMD` のマーカーなら再生成してよく、無ければ上書きせず `-2` … に回す。会話本文は `<conversation>` などのタグで囲み、本文中の同名タグは取り除く（データの中の指示に従わない）。ログに日記の内容は出さない。

## 標準の感情モーション

- `src/main/character/defaultMotions.ts` が、起動時に `%APPDATA%\mmd-assistant\default-motions\<感情>.vmd` を書き出す（コードで作る自前の動きなので、第三者のモーションは含まない。`*.vmd` をコミット・同梱しない方針のまま）。
- 動かすのは「上半身」「首」「頭」のみ（位置は動かさない）。`mmd://default-motion/<感情>.vmd` で配信し、キャラクターに個別のVMD指定がない感情にだけ使う（`render.defaultMotions` でOFF可）。読み込めなければ従来の `emotionGesture()` に戻る。
- 動きの調整は `DEFAULT_MOTIONS` の表（フレーム=30fps, 角度は度）を直す。回転は three.js 側の向きで書き、VMD へは x,y を反転して書き出す（`tests/unit/defaultMotions.test.ts` が three の MMDParser でも読めることを確かめる）。
- 実際の見た目はモデルごとに違うので、動きを変えたら `npm run dev:fake` で目視する。

## 動きの活発さとおやすみ中の描画

- 設定 `render.liveliness`（`calm` / `normal` / `lively`、既定 `normal`）。中身は `motion.ts` の `LIVELINESS`: 呼吸・揺れの振幅（呼吸は √ で控えめに）、手持ちぶさたの仕草（`fidgetGesture`: 見回す・かしげる・伸び・リズム・重心移動・ぴょこっと）の間隔、話しながらのうなずき（`speakingPose`）、手続き的な感情の仕草の大きさ、よそ見の頻度、アイドルVMDの間隔。`normal` の呼吸・揺れは従来と同じ値（テストで固定）。
- 仕草は `Fidgeter` が、待機中・起きている・他の動きが無いときだけ出す。話し終わった直後には出さない（忙しい間は先送り）。同じ仕草は続けない。動かすのは上半身・首・頭・全体の上下だけ（腕や足は触らない）。
- `lively` で感情のVMDがあるときは、VMDに小さめの手続き的な仕草を重ねる。
- おやすみ中が「重い」と感じられた原因: 描画を 5fps に落としていたうえ、1フレームの時間を 0.1 秒で打ち切っていたので動きが半分の速さになり、さらに MMD の物理は1回の更新で最大 3×1/65 秒しか進まないため、0.2 秒ごとの描画では髪やスカートが骨格に取り残されて引っ張られていた。いまは `frameRateFor`（おやすみ中は設定値と 15fps の小さい方）と `physicsSteps`（長いフレームは物理を ≤3/65 秒ずつに分けて進める）。

## 話す内容に合わせた身ぶり

- 文の読み上げが始まったとき（音声なしなら文が届いたとき）に `CharacterController.talk(text, emotion)` が身ぶりを選び、文の終わり（`endTalk()`）で腕を下ろす。長い文でも `HOLD[kind]` 秒で終える。
- 選び方は `talkGestures.ts` の `chooseTalkGesture`: 言葉のルール（あいさつ→手を振る、お礼・おわび→お辞儀、こんな感じ・予報・こちら→差し出す…）→ 一人称＋「が調べ／やり」→ 感情（thinking/troubled→考える）→ 長い文なら小さな「beat」。説明系の同じ身ぶりは続けない。頻度は `LIVELINESS` の `talkMatch` / `talkBeat`（おとなしい は控えめ、beat なし）。
- 腕の形は「肩→ひじ」「ひじ→手首」「手のひらの向き」の**方向**（モデル空間、右腕で書き、左は `mirror`）で持つ。`armRig.ts` の `ArmRig.solve` が、モデルの休止姿勢（Aポーズ/Tポーズ、腕の長さ）から、ひじは蝶番として曲げ、前腕のねじり（`手捩` があればそこ、無ければ手首）で手のひらを向ける。`手捩1..3` などの付与ボーンにはねじりの分を足し直す（helper の付与計算はこちらの回転より前に済んでいるため）。指（`人指`/`人差指`・中指・薬指・小指・親指の1〜3）があれば曲げる。
- 腕の補間は回転ではなく方向で行う（`blendArm`）。回転どうしを補間すると、上腕のねじれの差で腕が頭の上を回ることがあった。
- 腕のVMDが動いている間は手を出さない（`armsAnimated()`）。PMXは読むだけで、ボーンの回転をメモリ上で足すだけ。
- 形を直すときは `tests/unit/armRig.test.ts`（狙った方向を向く・手が体の前にある）を通したうえで、指のあるモデルと袖の大きいモデルの両方で目視する。

## 触ったときの反応（FR-EX-05）

- 部位の判定は `renderer/character/character/touchZones.ts`（純粋関数）。ボーンの画面位置（両目の中点・首・手首からひじの逆向きに0.45延ばした手の中心・左右の腕・下半身）と、目〜首の距離を単位に、手 → 顔（目より上なら頭、下ならほっぺ）→ 顔より上は頭 → 肩 → 下半身より下は脚 → 体、の順で決める。
- 撫でる: `PatDetector` が頭の上のカーソルの左右の切り返し（12px以上の往復が1.6秒に3回）を数える。止まって0.9秒で終わり。撫でている間は `patPose` と happy の表情を保つ。
- レンダラはその場で仕草と表情を出し（`touchGesture`、手は触った側の手で振り返す）、`character:touch {part, kind}` を main へ送る。
- main（`main/character/touchLines.ts`）の `TouchReactor` がセリフを選ぶ: 部位×親密度（0〜1段階は polite、2以上は close）、直前の2つを避ける、どのセリフも3秒あける、撫でのセリフ同士は9秒あける、8秒に4回つついたら「many」。会話のターンにはせず（履歴にも残らない）、`speech.preview` で合成して `character:touch-line` と `speech:audio`（preview）で送る。待機中だけ話す。
- キャラ専用のセリフ: `TouchLineLibrary` が人格ブロック（skill.md があればそれ）＋関係性ブロック（段階0と2）を utility モデルに渡して一度だけ作り、人格のハッシュをキーに `<データフォルダ>\cache\touch-lines.json` に保存する（skill.md を変えると作り直す）。使い道は「触ったときのセリフ作り」として記録される。品質チェック（感情が neutral ばかり・同じ言い回しの使い回し・脚や連打で happy）に通らなければ標準のセリフを使う。ローカルAIのみのとき（APIキーなし）は作らない: qwen3 8b/14b では場面を書き分けられず、不適切な組み合わせも出たため。
- 設定 `render.touchVoice`（既定ON）。OFFでも仕草と表情の反応はする。

## モーション同士のつなぎ（補間）

- 切り替わる動きは `motion.ts` の `CrossFader` でつなぐ。古い動きを動かしたまま、速度・加速度が両端で0になる曲線（`smootherstep`）で新しい動きへ移る。途中でさらに切り替わったときは、途中のフェードそのものを「元」として動かし続けるので、一瞬止まったり跳んだりしない。
  - 状態の姿勢（考え中・聞いている…）: 0.45秒（おやすみの出入りは1.2秒）。
  - 話しながらの身ぶり（体と両腕の `TalkLayer`）: 構える0.35秒、身ぶりから身ぶりへ0.4秒、下ろす0.55秒。
  - 話しながらのうなずき: 0.4秒で出入り。
- VMD（感情・アイドル）は 1回再生・最後のフレームで止めて、終わりの0.4秒で薄くする（以前は再生が終わった瞬間に元の姿勢へ戻っていた）。次の感情のVMDが来たら前のものは0.3秒で薄くする。同じVMDを続けて再生するときは、もう1つの複製を使う（再生中のものを最初に戻すと跳ぶ）。
- VMDの再生開始は `update()` の中、ボーンを休止姿勢に戻した直後にまとめて行う（`pendingPlays`）。three.js はアクションが有効になった瞬間のボーンの回転を「元の姿勢」として保存し、フェードイン中はそれと混ぜるため、フレームの途中で始めると前フレームの視線・揺れが二重にかかって首が跳ねていた。
- 腕のVMDが動いている間は、身ぶり・下ろした腕の層をVMDの重みに応じて弱める（`ArmRig.apply` の `weight`）。VMDの出入りで腕が一瞬Tポーズに戻らない。
- 実測（手元のモデル、手首の位置と頭の向きをフレームごとに記録し、加速度の最大値を比較）: 腕の身ぶりの出入りで 1/4〜1/14、身ぶりの途中切り替えで約1/5（前段の版比）、感情VMDの終わり際の首の跳ね 216 → 45。

## 軽さ（計測の仕方と結果）

- 隠れている間は描画しない: キャラクターウィンドウは音声やタイマーのために `backgroundThrottling: false` で、隠しても描画ループが 60fps で回り続けていた（実測 CPU 37%）。main がウィンドウの show / hide / minimize / restore を `M2C.visible` で知らせ、renderer は `CharacterController.setVisible(false)` で requestAnimationFrame 自体を止める（空のコールバックでも renderer と GPU プロセスが毎秒60回起きて 8% ほど使っていた）。再表示で再開し、隠れていた時間は1フレームに数えない。起動直後の状態は `C2M.ready` の応答で送る。実測: 隠れている間 37% → 1.2%。
- 物理演算の同期を速く: three の MMDPhysics は1ステップごとに「骨→剛体」「剛体→骨」の同期で、変換を Ammo のオブジェクト経由で計算していた（1剛体あたり wasm 境界越えの呼び出しが30回ほど）。`physicsSync.ts` の `installFastBoneSync` が、変換を1回だけ読み書きして残りを three.js の計算でする同じ式に差し替える。違いは途中結果を Bullet の32ビット浮動小数に丸めないことだけ（骨の向きは 0.001° 以内で一致）。`tests/unit/physicsSync.test.ts` は本物の Ammo で、同じ状態から元の同期と比べる（ammo.js の `getRotation()` は共有の一時オブジェクトを返すので、比べる前に数値へ写すこと）。実測: 物理 115 → 90 ms/秒。残りは Bullet 本体（wasm）の計算で、剛体170・ジョイント280のモデルで約1.5ms/ステップ。
- 試してやめたこと: 物理の書き戻しで骨の行列更新を遅延させる案（計測すると行列更新は全体の1割未満で、かえって遅くなった）。ソルバーの反復回数を減らす（10→4 でも 1割しか減らず、揺れ方が変わる）。テクスチャの画像をCPU側から捨てる（Chromium がすでに破棄していて減らなかった）。
- 読み込み: 物理エンジン（ammo.wasm）の準備・PMX・VMD を並行して読む（以前は順番待ち）。VMD は `vmdLayer.ts` の `loadVmdClips` がまとめて読む。
- 構成: VMD の再生（読み込み・開始・受け渡し・終わり際のフェード・腕の受け渡し量）は `VmdLayer` にまとめ、`CharacterController` は層の合成に専念する。使われていない関数・定数は削除し、`tsconfig.base.json` で `noUnusedLocals` / `noUnusedParameters` を有効にした（使われないコードがあると typecheck が落ちる）。
- 計測: 一時データフォルダ（設定・character.json・skill.md のコピー）で開発版を `--remote-debugging-port` 付きで起動し、DevTools プロトコルで gl.clear の回数（fps）、`Performance.getMetrics`（JS時間）、CPUプロファイルを取り、プロセスごとのCPU時間・ワーキングセットを PowerShell で読む。改善前のビルドは `git worktree` で同じ条件にして比べる。

## 今後の予定（メモ）

- 好みの配布モーション（VMD）を標準にしたい場合は、配布条件を確かめ、`THIRD_PARTY_NOTICES.md` に記載してから `defaultMotions.ts` の生成に代えて同梱する。

## 公開用リポジトリへの反映

開発は DesktopMMD-dev（非公開）で行い、公開する内容は `scripts/sync-public.ps1` で DesktopMMD-public に反映する（履歴は引き継がず、差分を1コミットで積む）。

```powershell
.\scripts\sync-public.ps1 -Message "v0.2.3: 変更の要約" [-Push]
```

- 反映されるのはコミット済みの内容だけ。
- gitleaks（PATH 上）で秘密情報を、`.sync-deny.txt`（git管理外、1行1つの正規表現）で公開したくない文字列を検査し、見つかればコミットしない。
