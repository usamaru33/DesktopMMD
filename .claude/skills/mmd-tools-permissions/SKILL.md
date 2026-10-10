---
name: mmd-tools-permissions
description: DesktopMMDの作業代行（ツール）とセキュリティの設計。ツール定義の形、権限レベルL0〜L2、PermissionGateの判定順序、パスの正規化と許可フォルダ照合、承認カードと音声承認の規則、「今日は常に許可」、プロンプトインジェクション対策、作業履歴と取り消し、MCPツールの取り込みを定める。新しいツールを追加するとき、ツールの挙動や権限を変えるとき、承認カードを触るとき、ファイル操作・コマンド実行・外部送信に関わるコードを書くときは必ず読む。
---

# ツールと権限（PermissionGate）

仕様書5.5と第7章の実装規則。**原則: LLMが何を言っても、PermissionGate を通らない実行経路は作らない。**

## 1. ツール定義の形

```ts
interface ToolDef<I> {
  name: string;                 // snake_case。Claudeに見せる名前
  title: string;                // 承認カードに出す日本語の作業名「ファイルを作成」
  description: string;          // Claude向けの説明（日本語可）
  inputSchema: z.ZodType<I>;    // zodで検証。JSON Schemaはここから生成
  level: 'L0' | 'L1' | 'L2';    // 定義値。設定で上げられるが下げられない
  pathArgs?: (keyof I)[];       // 許可フォルダ照合が必要な引数
  readsExternal?: boolean;      // 外部内容を読む（インジェクション源）
  undoable?: boolean;
  summarize(input: I): ApprovalSummary;    // 承認カード用: 対象、変更内容の要約
  run(input: I, ctx: ToolContext): Promise<ToolResult>;
}
```

- `run` は例外を投げずに `{ ok: false, error }` を返すのが基本。予期しない例外は Registry 側で捕まえて結果に変換する。
- 結果が長いときは先頭を返し「(以下省略、全N文字)」を付ける。DBの result_json は先頭2,000文字。
- 外部内容を返すツール（read_file、clipboard_read、MCP、web）は `<external_data source="…">` で包む。

## 2. 権限レベル（仕様書7.2）

| レベル | 動作 | 音声で許可 | 今日は常に許可 |
| --- | --- | --- | --- |
| L0 | 即実行。吹き出しに「○○を見ました」 | — | — |
| L1 | 承認カード | 可（「いいよ」「お願い」） | 可（外部内容を読んだターンは無効） |
| L2 | 承認カード、対象を全件表示 | **不可**（クリック必須） | **不可** |

実効レベル = max(定義レベル, settings.tools.levelOverrides[name])。MCPツールは登録時の level（既定L1）。

## 3. 判定順序（PermissionGate.check）— この順を崩さない

1. ツールが存在し有効か（run_command は settings.tools.runCommandEnabled が true のときだけ登録）
2. 引数を zod で検証（失敗→ `blocked: invalid_args`）
3. `pathArgs` の各パスを **pathGuard** で検証（失敗→ `blocked: outside_allowed`）
4. 「今日は常に許可」の記録を確認（L1のみ。そのターンに `readsExternal` なツールが実行済みなら無視）
5. レベルに応じて `auto` 実行、または承認待ち（60秒で `timeout`）

1〜3で落ちたものは承認カードを出さず、理由付きで Claude に返す。決定は tool_runs.decision に `auto|approved|denied|timeout|blocked` で記録。

## 4. pathGuard（main/tools/pathGuard.ts）— 純粋関数＋fs注入

```
normalize(p): 先頭の ~ をホームに、%VAR% を環境変数に展開 → path.resolve → fs.realpath（存在しなければ親ディレクトリをrealpathしてbasenameを足す）
isAllowed(real): allowedDirs（それぞれもrealpath済み）のどれかの「配下」か
```

- 「配下」の判定は `path.relative(dir, real)` が `..` で始まらず絶対パスでもないこと。文字列 startsWith は使わない（`C:\Docs2` が `C:\Docs` に一致してしまう）。
- Windowsは大文字小文字を区別しない比較にする。
- 常に拒否: `C:\Windows`、`C:\Program Files*`、`%APPDATA%\mmd-assistant` 自身、ドライブ直下、UNCパス（`\\`）、代替データストリーム（`:` を2つ以上含む）。
- シンボリックリンク・ジャンクションは realpath で解決してから照合（TC-05）。
- 例外: ユーザーがモデルにドロップしたファイル（FR-IN-06）は `guard.allowReadFiles()` に登録され、**そのファイルだけ**を L0 の読み取りツールで読める（`check(p, {forRead: true})`）。書き込み・移動・削除は従来どおり許可フォルダ内のみ。

## 5. 承認フロー

- main が `approval:request {id, tool, title, target[], summary, level, voiceAllowed}` を送る → キャラは Awaiting 状態（伺う仕草）。
- renderer が `approval:answer {id, decision: 'approve'|'deny'|'always_today'}` を返す。
- 音声承認: Awaiting 中の文字起こしが肯定語（いいよ/お願い/OK/はい/許可）なら L1 のみ承認、否定語（だめ/やめて/いいえ/キャンセル）なら拒否。L2 では肯定語に「画面のボタンで許可してね」と返し、承認しない（TC-07）。
- Esc は拒否扱い。60秒で自動拒否（timeout）。
- 拒否・timeout は `is_error: true` の tool_result「ユーザーが許可しませんでした」として返し、プロンプトの作業規則で代替案を出させる。

## 6. 取り消し（undo）

- write_file（上書き・追記）: 実行前に元ファイルを `backups/<日付>/<tool_run_id>_<basename>` へコピー。undo_json に `{restore: backupPath, to: originalPath}`。新規作成は `{deleteCreated: path}`（ごみ箱へ）。
- move/rename: `{moveBack: {from: newPath, to: oldPath}}`。
- delete_file: ごみ箱へ移動（`shell.trashItem`）。undo は「ごみ箱から戻してください」と案内するだけ（API無し）。
- undo 実行時も、戻し先が許可フォルダ内かを pathGuard で再確認する。
- backups は30日で掃除。

## 7. 組み込みツール一覧（仕様書5.5）

| name | level | 備考 |
| --- | --- | --- |
| get_datetime | L0 | |
| list_dir, search_files | L0 | 許可フォルダ内。search は名前一致＋内容grep（テキストのみ、5MB以下、最大200件） |
| read_file | L0 | テキスト／PDF（pdf.js系で抽出）／docx（mammoth等）。5MBまで。readsExternal |
| set_timer, set_reminder | L0 | 同時20件。発火は ProactiveEngine 経由で能動発話 |
| memory_save, memory_forget | L0 | forget はごみ箱（trashed、30日） |
| write_file | L1 | 上書き時は退避。undoable |
| move_file, rename_file | L1 | 移動先も許可フォルダ内。undoable |
| open_app | L1 | settings.tools.apps に登録済みの name のみ |
| open_url, open_path | L1 | http/https のみ。open_path は許可フォルダのみ |
| clipboard_read / clipboard_write | L1 | read は readsExternal |
| take_screenshot | L1 | desktopCapturer。画像は保存しない。Claudeへ image ブロックで渡す |
| delete_file | L2 | ごみ箱へ |
| run_command | L2 | 既定無効。PowerShell。全文を承認カードに表示。30秒タイムアウト、出力4,000文字 |
| web_search | L0 | Claudeのサーバーツール（ローカル実行なし） |

## 8. MCP（McpHub）

- settings.mcp.servers の `{name, command, args, level}` を stdio で起動。ツール名は `mcp__<server>__<tool>` に改名して衝突を避ける。
- 名前に delete/remove/send/post/create_event 等を含むものは、登録時 level が L1 でも **L2 に引き上げる**。
- MCPの結果は readsExternal 扱い。

## 9. 新しいツールを足す手順

1. `src/main/tools/builtin/<name>.ts` に ToolDef を書く（level を慎重に。迷ったら上げる）
2. `builtin/index.ts` の配列に追加（名前順を保つ＝プロンプトキャッシュ安定）
3. tests/unit/tools/<name>.test.ts で: 許可外パス拒否、スキーマ不正拒否、正常系、undo
4. 承認カードの summarize が「何を・どこに」を一目で示すか確認
5. 仕様書5.5の表に無いツールなら逸脱表（mmd-architecture）に追記
