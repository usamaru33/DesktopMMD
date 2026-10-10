---
name: mmd-architecture
description: DesktopMMD（MMDデスクトップアシスタント）の全体設計の地図。プロセス境界、ディレクトリ構成、モジュールの責務、IPCの契約、技術選定と仕様書からの逸脱点、コーディング規約をまとめたもの。DesktopMMDで新しい機能・モジュール・IPCチャネル・画面を追加するとき、どこに何を書くか迷ったとき、仕様書（Document/README.md）のどの章を見ればよいか知りたいとき、設計判断をするときは必ず最初に読む。Use whenever adding or moving code in the DesktopMMD Electron app.
---

# DesktopMMD アーキテクチャ

仕様の正本は `Document/README.md`（以下「仕様書」）。このskillは仕様書を**実装の言葉に翻訳した地図**であり、仕様と食い違ったら仕様書を優先し、意図的に変えた点は下の「逸脱表」に追記する。

## 1. 最重要の不変条件（破ると設計が崩れる）

1. **司令塔はメインプロセスだけ。** レンダラ同士、レンダラ⇔サイドカー、レンダラ⇔VOICEVOX/Claude を直接つながない。すべて main を経由する（仕様書2.1, 2.4）。
2. **APIキーとツール実行は main だけが持つ。** レンダラには絶対に渡さない。`settings:get` もキーを返さない（書き込み専用）。
3. **PMXは読むだけ。** モデルファイルを書き換える・コピーして同梱する・リポジトリに入れるコードは書かない（仕様書1.5, 7.5）。表情が足りなければ morphMap と自前動作で補う。
4. **権限判定はLLMに頼らない。** ツール実行は必ず `PermissionGate` を通る。L2は音声承認不可（`mmd-tools-permissions` skill）。
5. **差し替え可能なアダプタ。** STT・TTS・LLMはインターフェース（`src/main/adapters.ts` の型）越しに使い、具体クラスに依存しない（NFR-09）。
6. **どれかが落ちてもテキスト対話は続く。** VOICEVOX→Windows標準音声、サイドカー→自動再起動、という劣化経路を必ず持つ（NFR-08）。

## 2. ディレクトリ構成

```
DesktopMMD/
  Document/README.md          仕様書（正本）
  .claude/skills/             設計skill群（このファイル等）
  package.json, electron.vite.config.ts, tsconfig*.json, vitest.config.ts
  src/
    shared/                   main/preload/rendererで共有する型と定数（Nodeもthreeもimportしない）
      ipc.ts                  IPCチャネル名と引数型の単一の定義（仕様書5.9）
      types.ts                Emotion, CharacterState, Settings, CharacterPreset, Memory, ToolRun…
      emotions.ts             8感情の定義と既定の補正
    main/                     Electronメインプロセス（Node）
      index.ts                起動シーケンス、DI（各サービスを組み立てて配線する唯一の場所）
      adapters.ts             SttAdapter / TtsAdapter / LlmAdapter のインターフェース
      orchestrator/           Orchestrator（Turnキュー・状態機械）
      llm/                    LlmClient, PromptBuilder, ReplyParser, usage（利用額）
      tools/                  ToolRegistry, PermissionGate, pathGuard, builtin/*, undo
      mcp/                    McpHub
      memory/                 MemoryService, scoring, extraction, affinity
      proactive/              ProactiveEngine, suppression
      speech/                 SpeechService, VoicevoxClient, voiceTuning, ttsNormalize, fallback(SAPI)
      sidecar/                SidecarClient（WebSocket、生存監視）
      store/                  Db(node:sqlite), migrations, SettingsStore, Secrets, CharacterStore
      windows/                characterWindow, adminWindow, tray, hotkeys, cursorFeed, fullscreenWatch
      util/                   logger, latency, paths, events
    preload/
      index.ts                両ウィンドウ共通の1本。読み込んだページ（/admin/ かどうか）で mmd か mmdAdmin の片方だけを公開
      bridge.d.ts             window.mmd / window.mmdAdmin の型
    renderer/
      character/              SC-01〜05: main.ts（配線）, OverlayUI, AudioPlayer, MicCapture, mic-worklet.js, lipsync.ts
        character/            CharacterController（three.js）, FallbackAvatar, morphs.ts, motion.ts（純粋）
      admin/                  SC-10〜15: Preact(TSX)。main.tsx, ui.tsx, api.ts, pages/*Page.tsx
      shared/markdown.ts      marked + DOMPurify
      public/                 ammo.wasm.js / .wasm（postinstallでthreeからコピー。gitignore済み）
  sidecar/                    Pythonサイドカー（VAD/STT/埋め込み）
  tests/                      Vitest（unit/ と integration/）
  scripts/                    開発用スクリプト（サイドカーのvenv作成、VOICEVOX起動確認など）
```

## 3. モジュール責務（仕様書2.3の実装先）

| 仕様のモジュール | 実装ファイル | 依存してよいもの |
| --- | --- | --- |
| Orchestrator | main/orchestrator/Orchestrator.ts | すべてのmainサービス（インターフェース越し） |
| LlmClient | main/llm/LlmClient.ts | @anthropic-ai/sdk、usage |
| PromptBuilder | main/llm/PromptBuilder.ts | 純粋関数。入力はプレーンなデータのみ |
| ReplyParser | main/llm/ReplyParser.ts | 純粋。I/Oなし（`mmd-reply-protocol`） |
| ToolRegistry / PermissionGate | main/tools/* | pathGuard, Store |
| McpHub | main/mcp/McpHub.ts | @modelcontextprotocol/sdk |
| MemoryService | main/memory/* | Store, SidecarClient(embed), LlmClient(utility) |
| ProactiveEngine | main/proactive/* | 時計・アクティブウィンドウ監視（注入可能にする） |
| SpeechService | main/speech/* | VoicevoxClient, FallbackTts |
| SidecarClient | main/sidecar/SidecarClient.ts | ws |
| Store | main/store/* | node:sqlite, fs |
| CharacterController | renderer/character/character/* | three r170 |
| AudioPlayer / MicCapture / OverlayUI | renderer/character/* | DOM, WebAudio |

**テスト容易性のルール:** 時刻（`now()`）、乱数、ファイルシステム、外部プロセスは引数かコンストラクタで注入する。純粋ロジック（パーサ、スコア、抑止判定、リップシンクのタイムライン、権限判定）は Electron を import しないファイルに置き、Vitest から直接テストする。

## 4. IPCの契約

- チャネル名と引数型は `src/shared/ipc.ts` にだけ書く。preload と main はそこから import する。文字列リテラルを各所に散らさない。
- 方向は仕様書5.9の表のとおり。renderer→main は `ipcRenderer.invoke`（戻り値あり）か `send`（通知）、main→renderer は `webContents.send`。
- preload で公開するのは「関数」だけ。`ipcRenderer` 自体や任意チャネルを送れる汎用関数は公開しない。
- 新チャネルを足す手順: ① shared/ipc.ts に型を追加 → ② main のハンドラ登録（windows/ 配下の register 関数） → ③ preload に関数を追加 → ④ renderer から使う → ⑤ 仕様書5.9に無いものは逸脱表に追記。
- 大きなバイナリ（WAV、マイクフレーム）は `ArrayBuffer`/`Uint8Array` で送る。Base64にしない。

## 5. 技術選定と仕様書からの逸脱

仕様書2.2を基本とし、2026-10時点の実環境で検証して次のとおり変えた。理由は検証結果に基づく。

| 項目 | 仕様書 | 実装 | 理由 |
| --- | --- | --- | --- |
| Electron | 33 | 44.x（Node 24） | 33はサポート切れ。44でnode:sqliteが使える |
| SQLite | better-sqlite3 | `node:sqlite`（DatabaseSync） | better-sqlite3はElectron 44向けのprebuiltが無く、VC++ビルド環境も無いため再ビルド不可。node:sqliteはFTS5 trigramまで動作確認済み（SQLite 3.53） |
| three.js | r170固定 | r170固定（0.170.0） | MMDLoaderはr172で削除。r170は警告付きで動く |
| 物理 | ammo.js | three r170同梱の `examples/jsm/libs/ammo.wasm.js` | npmのammo.jsは古い。同梱版をpublicへコピーして `<script>` で読む |
| 管理画面 | TypeScript | Preact + TSX | 画面数が多いので最小のUIライブラリを使う |
| Python | 3.11 | 3.13（venv） | 手元が3.13。faster-whisper/onnxruntimeは3.13で動く |
| preload | 画面ごと | 1本に統合 | sandboxのpreloadは共有チャンクをrequireできない。electron-vite 5の`isolatedEntries`は非TTY出力でクラッシュする不具合あり |
| プロンプト構成 | ①〜⑦を毎回system | ①〜⑤をセッション内固定のsystem、⑥⑦は毎ターン追記するmid-conversation systemメッセージ | Sonnet 5.5のpreserved thinking: systemやtools・過去の履歴を書き換えると以前のthinkingブロックが無効（新規アカウントは400） |
| VAD | Silero VAD | Silero VAD（onnx、faster-whisper同梱のモデルをonnxruntimeで直接ストリーミング実行） | torch不要で軽い |
| 埋め込み | multilingual-e5-small | 同（ONNX版をonnxruntime + tokenizersで実行） | torch不要。出力384次元は同じ |
| 会話モデル | claude-sonnet-5-5 | 同 | 仕様どおり。thinkingは無効化できないので effort で速さを調整（`mmd-reply-protocol`） |

## 6. コーディング規約

- TypeScript strict。`any` を使うのはSDK境界のみで、すぐ型を付ける。
- 例外を投げてよいのは本当に異常なときだけ。ツール失敗・拒否・タイムアウトは「結果」としてLLMへ返す値にする。
- ログは `util/logger.ts` 経由。**会話本文・APIキー・記憶本文はログに出さない**（仕様書7.4）。キーは `sk-ant-…xxxx` の形に伏せる。
- 時刻はすべて ISO 8601（`new Date().toISOString()`）で保存。表示だけローカル時刻。
- ユーザーに見える文言は日本語。コード上の識別子・コメントは英語でも日本語でもよいが、ファイル内で揃える。
- 設定値の既定は `src/shared/defaults.ts` に一か所だけ書く（仕様書6.2の表と一致させる）。

## 7. 起動シーケンス（main/index.ts）

1. 単一インスタンスロック → app:// と mmd:// プロトコル登録
2. Store を開く（マイグレーション適用）→ Settings / Secrets / Character 読込
3. 各サービス生成（DI）: LlmClient, SpeechService, SidecarClient, MemoryService, ToolRegistry+PermissionGate, McpHub, ProactiveEngine, Orchestrator
4. キャラクターウィンドウ生成 → トレイ → ホットキー登録
5. 非同期で子プロセス起動: サイドカー、VOICEVOX接続確認、MCPサーバー
6. APIキー未設定またはモデル未設定なら初回セットアップ（SC-14）を開く

## 8. 実装で分かったこと（落とし穴）

- Electron 44 では `clipboard.readText()` が Promise を返す。ツール側は `await` 前提で書く。
- `ipcMain.handle` はハンドラ内で送信元の webContents を確認する（App.ts の `handle()`）。
- 開発用の環境変数: `MMD_FAKE_LLM=1`（疑似LLM）、`MMD_SHOT=1`（起動後にスクリーンショットを out/shots へ）、`MMD_SHOT_QUIT=1`、`MMD_SHOT_DELAY=ms`、`MMD_NO_AUTOHIDE=1`（全画面アプリ検知で隠れない）、`MMD_DEBUG=1`（レンダラのconsoleも全部ログへ）、`MMD_DATA_DIR=<dir>`（データの置き場所を変える。Electronは環境変数APPDATAを見ないので、撮影・計測で本物のデータを汚さないにはこれを使う）。
- レンダラのエラーは main のログに `[character:error]` / `[admin:error]` として転送される。画面が真っ白・透明ならまずこれを見る。
- tsx でスクリプトを動かすときは `--tsconfig tsconfig.node.json`（`@shared` エイリアスのため）。

## 9. 迷ったときの参照先

| 知りたいこと | 見る場所 |
| --- | --- |
| 応答形式・感情タグ・文の切り方 | `mmd-reply-protocol` skill、仕様書5.3 |
| ツール追加・権限・承認カード | `mmd-tools-permissions` skill、仕様書5.5, 7 |
| 表情・モーション・口パク・視線 | `mmd-character-expression` skill、仕様書4 |
| VOICEVOX・調声・辞書・サイドカー | `mmd-voice-pipeline` skill、仕様書3.6, 5.6, 6.5 |
| 記憶・親密度・能動発話 | `mmd-memory-personalization` skill、仕様書5.7, 5.8, 4.6 |
| テスト・起動確認・完了条件 | `mmd-verify` skill、仕様書8 |
