---
name: mmd-verify
description: DesktopMMDの検証手順。型チェック・単体テスト・結合テスト・ビルド・アプリ起動・サイドカーとVOICEVOXの起動確認・LLM評価・手動チェックリストの実行方法と、仕様書のテストケース（TC-01〜18）・非機能要件（NFR）・フェーズ完了条件との対応を定める。DesktopMMDで変更を終えたとき、「動くか確認して」「テストして」と言われたとき、フェーズを完了とする前、コミットの前に必ず使う。
---

# 検証手順

仕様書第8章の実装版。**変更を「完了」と言う前に、少なくとも §1 の3つを通す。** 失敗は隠さず出力ごと報告する。

## 1. 毎回（コミット前）

```powershell
npm run typecheck      # tsc --noEmit（main/preload/renderer/shared の各tsconfig）
npm test               # vitest run（tests/unit）
npm run build          # electron-vite build
```

Python を触ったら:

```powershell
sidecar\.venv\Scripts\python.exe -m pytest sidecar\tests -q
```

## 2. 単体テストが必ず持つもの（NFR-10: 主要ロジックのカバレッジ70%以上）

| 対象 | ファイル | 対応 |
| --- | --- | --- |
| ReplyParser | tests/unit/ReplyParser.test.ts | TC-02、5.3 |
| PermissionGate / pathGuard | tests/unit/PermissionGate.test.ts, pathGuard.test.ts | TC-04, 05, 06, 07 |
| 記憶スコア | tests/unit/scoring.test.ts | 5.7 |
| 能動発話の抑止 | tests/unit/suppression.test.ts | TC-11, 5.8 |
| リップシンク | tests/unit/lipsync.test.ts | 4.4 |
| 調声の計算 | tests/unit/voiceTuning.test.ts | TC-16, 5.6 |
| TTS整形 | tests/unit/ttsNormalize.test.ts | 5.3 |
| マイグレーション・リポジトリ | tests/integration/store.test.ts | 6.4（node:sqlite はシステムの Node 22 でも FTS5 trigram まで動く） |
| undo | tests/unit/PermissionGate.test.ts | TC-08（一時ディレクトリで実ファイル） |
| Orchestrator | tests/unit/Orchestrator.test.ts | TC-01、割り込み後の履歴の整合、追記のみの履歴 |
| LlmClient | tests/unit/LlmClient.test.ts | 送信内容（thinking/effort/fallbacks/betas）、SSE、再試行 |
| 記憶 | tests/unit/MemoryService.test.ts | TC-10、統合・置き換え、FTS代替 |

カバレッジは `npm run coverage`（対象は src/main/llm, tools, memory, proactive, speech の純粋部分と renderer/character/lipsync）。

## 3. 結合テスト（フェーズ完了時）

- VOICEVOX: `scripts/start-voicevox.ps1` で起動 → `npm run test:voicevox`（/version、話者一覧、合成、辞書の追加→削除→再登録 TC-17）。起動していなければ skip と表示（失敗扱いにしない）。
- サイドカー: `npm run test:sidecar`（起動→hello→ready→embed→ping、kill後10秒以内の再起動 TC-13）。
- Claude API: `npm run eval:llm`（キーがあるときだけ。固定入力30件で感情タグ遵守率・ツール選択・インジェクション耐性 TC-06 を採点）。**実APIを呼ぶので費用がかかる。実行前にユーザーに確認する。**

## 4. アプリを起動して見る

```powershell
npm run dev            # electron-vite dev（HMR）
```

- 起動ログ（`%APPDATA%\mmd-assistant\logs\main.log`）で「store ready / sidecar ready / voicevox ok / window shown」を確認。
- APIキーが無い環境では初回セットアップが開く。テキスト対話は `MMD_FAKE_LLM=1` で**疑似LLM**（固定の感情タグ付き応答を数文ストリームする）に切り替えて、表示・口パク・表情・承認カードを確かめられる。疑似LLMは「ファイル」を含む入力に write_file の tool_use を返し、承認カードも試せる。
- スクリーンショット確認: `npx electron-vite build` の後 `MMD_FAKE_LLM=1 MMD_SHOT=1 MMD_SHOT_QUIT=1 MMD_SHOT_DELAY=9000 electron .` → `out/shots/` に character.png / character-talking.png / admin-*.png。Read で見る。透過PNGは白く見えるので、本当に空かどうかはPILでアルファ値を数える。
- 全画面のアプリ（ゲーム等）が前面にあるとキャラクターは仕様どおり自動で隠れる。撮影・計測時は `MMD_NO_AUTOHIDE=1`。

## 5. 手動チェックリスト（音・見た目・OS依存）

- [ ] モデル外の透明部分をクリック → 背後のアプリが反応（TC-14）
- [ ] モデルをドラッグで移動、ホイールで拡縮、再起動で位置復元
- [ ] Ctrl+Alt+Space で聞き取り → 話し終わりで送信、口パクが音と合う
- [ ] 読み上げ中に話しかけて止まる（TC-03）
- [ ] Esc で読み上げと生成が止まる
- [ ] 承認カード: L1 で「いいよ」が通る、L2 で通らない（TC-07）
- [ ] VOICEVOX を終了しても Windows 音声で続く（TC-12）
- [ ] 全画面動画中に隠れて声かけしない（TC-11, FR-EX-05）
- [ ] マルチモニターで右下に出る／別モニターへ移動できる
- [ ] PMX のハッシュと更新日時が変わっていない（TC-18: `Get-FileHash`）

## 6. 性能（NFR-01〜05）

- アプリ内の遅延ログ（latency）: 各ターンの `speech_end → transcript → first_token → first_audio` を記録。`npm run latency-report` で中央値を出す。目標: 話し終わり→初音声 2.5秒、テキスト→初文字 1.5秒。
- 待機1時間で CPU 5%以下、メモリ（サイドカー込み）1.5GB以下（TC-15）。タスクマネージャーか `Get-Process` で確認。

## 7. インストーラー

```powershell
npm run sidecar:build      # サイドカーexe（先に）
npm run dist               # electron-vite build → electron-builder（NSIS, 日本語） → dist/DesktopMMD-Setup-<ver>.exe
```

- 確認: `dist/win-unpacked/DesktopMMD.exe` を起動し、`%APPDATA%\mmd-assistant\logs` に「sidecar STT ready on cuda」「voicevox ok」「model loaded」が出ること。モデル（PMX）が dist に入っていないこと（`*.pmx` を検索して0件）。
- アイコンは `python scripts/make-icon.py` で `build/icon.ico` を再生成できる。

## 8. フェーズ完了条件（仕様書8.3）

各フェーズの終わりに、該当TCを上の手段で確認し、結果（通った／未確認／失敗）を表にして報告する。実機の声や見た目でしか確かめられないものは「手動未確認」と正直に書く。
