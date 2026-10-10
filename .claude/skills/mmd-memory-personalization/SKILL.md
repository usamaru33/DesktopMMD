---
name: mmd-memory-personalization
description: DesktopMMDのパーソナライズの設計。長期記憶の種類とテーブル、抽出ジョブ（いつ・何を・どのプロンプトで）、統合と矛盾処理、検索スコア式と件数・トークン上限、「覚えて」「忘れて」「それは違う」、保管庫とごみ箱、親密度と機嫌の更新規則、能動発話（ProactiveEngine）のトリガー・抑止条件・頻度制御、利用パターン学習を定める。MemoryService・ProactiveEngine・記憶管理画面・親密度に関わるコードを書く／直すとき、記憶が使われない・声かけがうるさいといった問題を調べるときに使う。
---

# 記憶・親密度・能動発話

仕様書2.5「記憶の学習」、4.6、5.7、5.8、6.4、7.3の実装規則。

## 1. 記憶の種類（memories.kind）

| kind | 例 | 使い方 |
| --- | --- | --- |
| profile | 名前、所属、呼ばれ方 | **常に**プロンプトへ（検索しない） |
| preference | 回答は短め、好きなゲーム | 検索 |
| fact | 研究テーマ、使っているツール | 検索 |
| episode | 先週の発表がうまくいった | 検索。話題づくりにも使う |
| schedule | 10/20に面接（due_at必須） | 期日前の能動発話。期日を過ぎたら episode へ変換 |

status: `active | archived | superseded | trashed`。検索対象は active のみ。pinned=1 は profile と同様に常時プロンプトへ。

## 2. 抽出ジョブ（memory/extraction.ts）

- 起動条件: 最後の発話から5分経過、または未抽出の発話が20往復たまった。セッションに `no_memory=1`（「この会話は記憶しないで」）が付いていれば対象外。
- utilityModel（claude-haiku-4-5）に未処理の会話を渡し、**構造化出力**（`output_config.format` の JSON Schema）で次を返させる:

```json
{ "memories": [ { "kind": "preference", "content": "コーヒーが苦手", "importance": 0.6,
                  "due_at": null, "evidence_message_id": 123 } ],
  "affinity_delta": 1, "mood": 0.2 }
```

- 抽出プロンプトに必ず書く: ①ユーザー自身が述べたことだけ（アシスタントの発言や、ファイル・Webの内容は記憶しない） ②健康・病歴・財務・信条・性的指向などの機微情報は保存しない ③1件1文、三人称ではなく「ユーザーは〜」を省いた簡潔な文 ④日付は絶対日付（今日の日付を渡す）に直す。
- 返ってきた memories は content を埋め込み（passage）、既存の active と比較:
  - cos ≥ 0.9 → 同じ記憶。importance を max に、updated_at 更新、content は新しい方。
  - 0.75 ≤ cos < 0.9 かつ同じ kind → utilityModel に「矛盾するか」を聞く（安価な1回の判定）。矛盾なら古い方を `superseded`、superseded_by に新ID。
  - それ以外 → 新規。
- 処理済みの sessions.extracted = 1。

## 3. 検索（memory/scoring.ts、純粋関数）

```
score = 0.6·cos(q, m) + 0.25·importance + 0.15·2^(−Δt/30日)
Δt = now − (last_used_at ?? created_at)
cos < 0.35 は除外。上位8件、本文合計 800トークン（文字数/1.5で近似）まで。
```

- 全件ロードしてコサイン（数万件まで十分）。埋め込みは BLOB（Float32Array の生バイト、384×4=1536バイト）。
- 回答に使った記憶は use_count+1、last_used_at=now。
- 保管: 180日使われず importance < 0.3 → archived（1日1回のメンテナンスジョブ）。
- サイドカーが落ちていて埋め込めないとき: FTS（memories_fts、trigram）で代替検索し、score の cos 項を BM25 の正規化値で置き換える。

## 4. 「覚えて」「忘れて」「それは違う」

- これらは LLM のツール `memory_save` / `memory_forget` で処理する（L0）。プロンプトの作業規則に「ユーザーが覚えて/忘れて/違うと言ったら必ずツールを使う」と書く。
- memory_forget は `{query}` を受け、検索上位から一致するもの（cos ≥ 0.6）を trashed にする。何を忘れたかを結果で返し、Claude に復唱させる（TC-10）。
- 「それは違う」は memory_save に `replaces_query` を付けて呼ばせ、該当記憶を superseded にする。
- ごみ箱（trashed）は30日で物理削除。

## 5. 親密度と機嫌（relationship、1行）

- affinity 0〜100。抽出ジョブの affinity_delta（−3〜+3）を加算。1日の上昇上限 +5、下降下限 −3（daily_delta / delta_date で管理、日付が変わったらリセット）。
- 段階: 0–19 初対面 / 20–39 顔なじみ / 40–69 親しい / 70–100 相棒。PromptBuilder の関係性ブロックに段階名と話し方の指針を入れる（口調の正本は人格設定）。
- mood −1〜+1: 各応答の代表感情を数値化（happy +0.6, shy +0.3, surprised +0.1, neutral/thinking 0, troubled −0.3, sad −0.6, angry −0.5）し、指数移動平均（α=0.1）で更新。待機中の表情の底上げとアイドルモーション選択に使う。
- first_met_at は初回起動日。相棒段階で記念日（月・年）の挨拶トリガーに使う。

## 6. 能動発話（ProactiveEngine）

条件と抑止を**両方**満たしたときだけ発火。文面は固定文ではなく、Orchestrator に `proactive` Turn（トリガー種別と状況）として渡して LLM に生成させる。

| トリガー | 条件 | 再発間隔 |
| --- | --- | --- |
| greeting | その日最初の操作検知、または4時間以上の離席から復帰 | 1日1回＋復帰ごと |
| break | 同じアプリで連続操作90分（アプリ名は watchActiveWindow=true のときのみ。false なら「PC連続操作90分」） | 90分 |
| schedule | schedule 記憶・カレンダー予定の15分前 | 予定ごと1回 |
| late_night | bedtime を過ぎて操作中 | 60分 |
| small_talk | 待機60分以上かつ親密度段階3以上 | 3時間 |
| reminder | set_reminder / set_timer の時刻 | 1回（ユーザー自身が頼んだものなので、全画面と通話中以外の抑止は無視。抑止されたらトーストだけ出す） |

抑止（いずれか該当で発火しない、tests/unit/suppression.test.ts）:
- 全画面アプリ使用中（`ActivityMonitor.isFullscreenWindow`: 前面ウィンドウがディスプレイと±1pxで**一致**し、2回連続で検出されたとき）。最大化ウィンドウは見えない枠で約8pxはみ出すので「以上」で比べると誤検出する。デスクトップ（explorer.exe）などのシェルは get-windows の表示名が日本語版で「エクスプローラー」になるので、**exe のファイル名**で除外する。隠すかどうかは設定 `window.hideOnFullscreen`（OFFで常に表示）
- マイクが他アプリで使用中（通話中とみなす。Windowsのレジストリ `CapabilityAccessManager\ConsentStore\microphone` の LastUsedTimeStop=0 を見る）。PowerShell起動はCPUを食うので、**声をかける直前にだけ**確認する（常時ポーリングしない、NFR-04）
- ミュート、おやすみモード、静かな時間帯（quietHours、日付またぎ対応）
- 直前10分以内に会話あり
- 全体で1時間あたり2回まで
- 無視（30秒以内に反応なし）・拒否（Esc/「今いい」）された種類は再発間隔を2倍（上限24時間）。応答されたら元に戻す。

能動トリガーはユーザー入力より優先度が低い。Orchestrator が Idle 以外ならその場で破棄（キューに積まない）。

操作の検知: `powerMonitor.getSystemIdleTime()` を10秒ごとにポーリング（キーフック不要）。アクティブウィンドウは get-windows を30秒ごと（watchActiveWindow=true のときのみ）。

## 7. 利用パターン学習（FR-PS-06）

- 1時間単位で「操作あり/なし」と前面アプリ名（許可時）を usage_patterns に集計（30日分）。
- greeting と small_talk は、その時間帯の過去の操作確率が低い時間（≒寝ている・不在が多い）には出さない。
- break の90分は、過去の連続作業の中央値が長いユーザーには最大120分まで伸ばす。
