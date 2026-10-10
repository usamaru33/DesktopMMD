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
- Claude APIキー（無くても `npm run dev:fake` で疑似LLMで動かせます）
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

- 音高の上限: `src/main/speech/pitchShape.ts`。VOICEVOX では pitchScale / intonationScale と疑問文の語尾上げをエンジンに任せず、同じ計算（ENGINE の `_apply_interrogative_upspeak` → `_apply_pitch_scale` → `_apply_intonation_scale`）をモーラの高さにかけてから、文の本来の音域（抑揚1.0のときの最高・最低モーラ）から上0.5〜2半音・下1.5〜3.5半音で tanh で頭打ちにする。結果は pitchScale=0 / intonationScale=1 で、合成は `enable_interrogative_upspeak=false` で呼ぶ（`VoicevoxClient.synthesis(…, upspeak=false)`）。範囲内は ENGINE と同じ値になる（`tests/unit/voiceQuality.test.ts`）。自動調声の合成も同じ経路を通す。
- 実測（満別花丸ぶりっ子、抑揚1.82）: モーラの高さの頭打ちは効くが、合成音のF0の98パーセンタイルはほとんど変わらない（ボコーダが目標より上振れするため）。効果が大きいのは抑揚と話速そのものを戻すこと。そのため調声画面で目安（話速0.75〜1.5・音高±0.08・抑揚0.6〜1.5）を外れると注意を出し、自動調声の `FIT_LIMITS` もこの範囲にした。
- 感情スタイル: `@shared/emotions` の `EMOTION_STYLE_WORDS` / `autoEmotionStyles`。基本のスタイルと同じ話者で、名前に感情語を含むスタイルを選ぶ（ささやき系は使わない）。`computeTuning(…, { autoStyles })` が、感情別の設定が無く強さ0.5以上のときだけ使い、そのときは音高・抑揚の補正をかけない。`CharacterVoice.autoEmotionStyles === false` で無効。話者一覧は `SpeechService` がエンジンURLごとに覚え、`warmUp` で捨てる。
- 音質フィルター: `src/renderer/shared/voiceFilter.ts`（3.2kHz −2.5dB のピーキング、8kHz −4dB のハイシェルフ、閾値−20dB・比2.5 の圧縮、`room` は0.35秒の残響を0.1）。キャラクター画面の `AudioPlayer` と管理画面の試聴（`playWav(wav, filter)`）で共通。設定 `voice.postFilter`、キャラクター画面へは `ViewSettingsPayload.voiceFilter`。
- AivisSpeech: `@shared/voiceEngine`。種類は `/engine_manifest` の name で見分け（取れなければポート10101なら aivis）、`SpeechService.engineKindOf` がURLごとに覚える。AivisSpeech はモーラの長さ・高さを返さない（0）ので、`SpeechAudioPayload.query` を null にして口パクを音量で動かす。定型文は使わず、感情の音高補正もかけない（pitchScale を動かすと音質が落ちる。intonationScale は感情表現の強さ）。自動調声は `fixPitch`。起動は `findEngineExe(…, 'aivis')` が `%LOCALAPPDATA%\Programs\AivisSpeech\AivisSpeech-Engine\run.exe` を探し、URLのポートから種類を決める。辞書APIはVOICEVOXと同じ。
- 確認: AivisSpeech Engine 1.2.0（Windows版を scratch に展開して :10101 で起動）で、話者一覧・合成・感情スタイル（まお: 悲しみ→せつなめ）・辞書の取得・管理画面での切り替えを確認した。

## インストーラーの作成

```powershell
npm run sidecar:build        # Pythonサイドカーを sidecar.exe にまとめる（cuBLAS同梱、約1GB）
npm run dist                 # dist/DesktopMMD-Setup-<version>.exe
python scripts/make-icon.py  # アイコン（build/icon.ico）を作り直すとき
```

インストーラーにMMDモデルは含まれません。

## 自動更新

- 起動の約8秒後に `src/main/update/UpdateService.ts` が `https://api.github.com/repos/usamaru33/DesktopMMD/releases/latest` を確認する（Electron非依存。通信・保存先・インストーラー起動は注入）。
- 現在の版（`app.getVersion()`）より新しければ、リリースの資産 `DesktopMMD-Setup-<版>.exe`（https の github.com のものだけ）を `%TEMP%\DesktopMMD-update` に落とし、サイズと sha256（GitHub が付ける `digest`）を検証してから、`App.runInstaller` が PowerShell を切り離して起動して終了する。PowerShell は3秒待って `/S`（サイレント）でインストールし、終わったら（失敗しても）アプリを起動し直す。
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

## 標準の感情モーション

- `src/main/character/defaultMotions.ts` が、起動時に `%APPDATA%\mmd-assistant\default-motions\<感情>.vmd` を書き出す（コードで作る自前の動きなので、第三者のモーションは含まない。`*.vmd` をコミット・同梱しない方針のまま）。
- 動かすのは「上半身」「首」「頭」のみ（位置は動かさない）。`mmd://default-motion/<感情>.vmd` で配信し、キャラクターに個別のVMD指定がない感情にだけ使う（`render.defaultMotions` でOFF可）。読み込めなければ従来の `emotionGesture()` に戻る。
- 動きの調整は `DEFAULT_MOTIONS` の表（フレーム=30fps, 角度は度）を直す。回転は three.js 側の向きで書き、VMD へは x,y を反転して書き出す（`tests/unit/defaultMotions.test.ts` が three の MMDParser でも読めることを確かめる）。
- 実際の見た目はモデルごとに違うので、動きを変えたら `npm run dev:fake` で目視する。

## 今後の予定（メモ）

- 好みの配布モーション（VMD）を標準にしたい場合は、配布条件を確かめ、`THIRD_PARTY_NOTICES.md` に記載してから `defaultMotions.ts` の生成に代えて同梱する。

## 公開用リポジトリへの反映

開発は DesktopMMD-dev（非公開）で行い、公開する内容は `scripts/sync-public.ps1` で DesktopMMD-public に反映する（履歴は引き継がず、差分を1コミットで積む）。

```powershell
.\scripts\sync-public.ps1 -Message "v0.2.3: 変更の要約" [-Push]
```

- 反映されるのはコミット済みの内容だけ。
- gitleaks（PATH 上）で秘密情報を、`.sync-deny.txt`（git管理外、1行1つの正規表現）で公開したくない文字列を検査し、見つかればコミットしない。
