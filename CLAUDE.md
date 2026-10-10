# DesktopMMD

Windowsデスクトップに常駐するMMDモデルのアシスタント（Electron 44 + three.js r170 + Claude API + VOICEVOX + Pythonサイドカー）。
仕様の正本は `Document/README.md`。設計の地図は `.claude/skills/mmd-*`。`README.md` は使う人向けの説明書、開発手順は `DEVELOPMENT.md`（機能を変えたら両方を更新する）。

## まず読むもの

| 作業 | skill |
| --- | --- |
| どこに何を書くか・IPC・技術選定と仕様からの逸脱 | `mmd-architecture` |
| 応答形式・ReplyParser・プロンプト・Claude API | `mmd-reply-protocol` |
| ツール・権限・承認・パス検証・取り消し | `mmd-tools-permissions` |
| 描画・表情・口パク・視線・クリック透過 | `mmd-character-expression` |
| VOICEVOX・調声・辞書・サイドカー・マイク | `mmd-voice-pipeline` |
| 記憶・親密度・能動発話 | `mmd-memory-personalization` |
| テスト・起動確認・完了条件 | `mmd-verify` |
| キャラクターの人格定義（skill.md）の書式・検証 | `docs/CHARACTER_SKILL_FORMAT.md`、`src/main/character/skillFile.ts` |

## コマンド

```powershell
npm install                 # postinstall で three 同梱の ammo.wasm を src/renderer/public にコピー
npm run sidecar:setup       # sidecar/.venv を作って Python 依存を入れる（GPU無しなら -Cpu）
npm run voicevox            # ローカルの VOICEVOX エンジンを起動
npm run dev                 # 開発起動（APIキーが無ければ初回セットアップが開く）
npm run dev:fake            # 疑似LLMで起動（API不要）
npm run typecheck; npm test; npm run build   # 変更後は必ず3つとも通す
npm run test:voicevox       # VOICEVOX結合テスト（起動していなければskip）
npm run test:sidecar        # サイドカー実地テスト（初回はモデルDLあり）
npm run eval:llm -- --yes   # 実APIでの評価。費用がかかるので実行前にユーザーに確認する
```

## 守ること

- PMXは読むだけ。書き換え・コピー・同梱・コミットをしない（モデル規約）。`*.pmx` は .gitignore 済み。
- ツール実行は必ず `PermissionGate` を通す。L2は音声承認不可。
- APIキーはmainだけが持つ。ログ・レンダラ・設定取得に出さない。
- Claude API: 会話は `claude-sonnet-5-5`（thinkingは無効化不可→effortで調整）、内部処理は `claude-haiku-4-5`。セッション中は system と tools を変えず、履歴は追記のみ（preserved thinking）。
- ユーザー向けの文言は日本語。
