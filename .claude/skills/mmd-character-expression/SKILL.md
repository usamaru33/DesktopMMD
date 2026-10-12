---
name: mmd-character-expression
description: DesktopMMDのキャラクター表現（three.js r170でのMMD描画）の設計。PMX/VMDの読み込み方、4層（アイドル・状態の仕草・感情・口パク）の合成順、感情→モーフ候補名の探索とmorphMap、自前動作（プロシージャルなボーン回転）、VOICEVOXモーラ列からのリップシンク、まばたき・呼吸・視線追従・放置反応、親密度による変化、透過ウィンドウとクリック透過、30fps制限を定める。CharacterControllerやレンダラの描画・表情・口パク・視線・ドラッグ・拡縮・クリック透過を実装／修正するとき、表情が出ない・口が合わない・重いといった問題を調べるときに使う。
---

# キャラクター表現（renderer/character）

仕様書第4章と3.2の実装規則。

## 0. 規約上の絶対ルール

- **PMXを書き換えない。** モーフ追加・ボーン追加・テクスチャ差し替えをファイルに書き戻すコードは禁止。メモリ上でモーフの重みやボーン回転を動かすのは可（=MMDで踊らせるのと同じ）。
- モデルはリポジトリに入れない。character.json の `model` はキャラクターフォルダ相対パス**または絶対パス**で、main の `mmd://` プロトコルが許可したディレクトリ（キャラクターフォルダと model の親フォルダ）だけを読む。
- 読み込み後もファイルのハッシュと更新日時が変わらないこと（TC-18）。

## 1. 読み込み（three r170）

```ts
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { MMDAnimationHelper } from 'three/examples/jsm/animation/MMDAnimationHelper.js';
```

- r170 の MMDLoader は「r172で削除」の警告を出すが動く。three は `0.170.0` に**固定**（package.json で `~` も `^` も付けない）。
- 物理は `three/examples/jsm/libs/ammo.wasm.js` を `public/` にコピーし、`<script src="./ammo.wasm.js">` で読み、`await Ammo()` してから `globalThis.Ammo` を設定 → helper に `physics: true` で add。CSP に `'wasm-unsafe-eval'` が必要。
- 物理OFF設定（render.physics=false）のときは Ammo を読まない。
- PMXのURLは `mmd://model/<相対パス>`。テクスチャはMMDLoaderがPMXと同じ階層から相対で読むので、プロトコルハンドラはディレクトリ単位で解決する。ファイル名は日本語を含むので encodeURIComponent を必ず通す。
- モデルが無い／読み込み失敗のときは**代替アバター**（簡単なプリミティブで作った顔付きの球体）を出し、表情API（setEmotion/口パク）は同じインターフェースで動かす。アプリは止めない。

### 実装メモ

- ammo は `public/ammo.wasm.js` を `<script src="../ammo.wasm.js">`（ページは `character/index.html` なので一つ上）で読み、`locateFile` も `../`。
- 物理の「骨→剛体」「剛体→骨」の同期は `installFastBoneSync`（`physicsSync.ts`）で速い版に差し替える（式は three と同じ）。
- 物理は `helper.add(mesh, {animation: [], physics: true})` の後 `helper.enable('physics', false)` にし、加算回転を適用した後で `helper.objects.get(mesh).physics.update(dt)` を手動で呼ぶ（揺れ物が最新の姿勢に追従する）。
- 毎フレーム、管理するボーンをレスト姿勢に戻してから `helper.update` → 加算回転、の順。戻さないと回転が累積する。
- PMXのバインド姿勢はT/Aポーズなので、腕VMDが動いていない間は 左腕/右腕 を Z 軸で約42°下げ、ひじを少し曲げる（ライスシャワーで確認済み）。
- MMD のボーンはローカル軸＝モデル軸（レスト回転なし）。モデルは +Z を向く。うなずき=+X、左を向く=+Y。
- PMX内のテクスチャパスは `\` 区切りなので `loader.manager.setURLModifier(u => u.replace(/\\/g, '/'))`。mmd:// 側でも大文字小文字違いを吸収する。

## 2. 層の合成（毎フレーム）

```
最終モーフ重み = clamp(
   idle層(まばたき)               ← まばたき中は感情の目モーフを抑制
 + 状態層(Thinking: 視線上・真面目眉)
 + 感情層(emotion × intensity × fade)
 + 口パク層(あいうえお)            ← 発話中は感情の口モーフを ×0.5
)
ボーン回転 = 基本ポーズ ⊕ 呼吸/揺れ ⊕ 状態の仕草 ⊕ 自前動作 ⊕ 視線(首/頭/目)
```

- モーフは「層ごとに目標値を書き込み → 最後に max または加算して clamp(0,1)」。同じモーフを複数層が触る場合、上の層（口パク＞感情＞状態＞アイドル）が優先。
- ボーンは VMD 再生後（helper.update 後）に、上半身・首・頭・目へ**加算回転**する。VMD は上半身系ボーンのみに適用（下半身・センター・足IKのトラックを除いた clip を作る）。
- 感情の立ち上がり 0.25秒、発話終了後 3秒で平常へ、文間は線形補間。

## 3. 感情→モーフの対応（候補を左から探索）

```ts
const EMOTION_MORPHS = {
  happy:     { eye: ['笑い','にこり','ウィンク'], brow: ['にこり','上'], mouth: ['にっこり','∇','ワ','口角上げ'] },
  surprised: { eye: ['びっくり','瞳小','見開き'], brow: ['上','驚き'], mouth: ['お','▲','あ'] },
  sad:       { eye: ['じと目','なごみ'], brow: ['困る'], mouth: ['へ','∧','口角下げ','ん'] },
  angry:     { eye: ['じと目','ｷﾘｯ','キリッ'], brow: ['怒り','真面目'], mouth: ['へ','∧','ω'] },
  troubled:  { eye: ['なごみ','はぅ','困り目','じと目'], brow: ['困る'], mouth: ['ん','い','∧'] },
  shy:       { eye: ['にこり','なごみ'], brow: ['困る'], mouth: ['ん','口すぼめ','ω'], cheek: ['照れ','赤面','頬染め'] },
  thinking:  { eye: [], brow: ['真面目','困る'], mouth: ['ん','口すぼめ','∧'] },
};
// 口形: あ い う え お、まばたき: まばたき / ウィンク左右
```

- 探索は `mesh.morphTargetDictionary` の完全一致 → 前後空白除去・全半角正規化した一致の順。
- character.json の `morphMap` が最優先（例 `{ "happy.eye": "笑い2", "mouth.a": "あ２" }`）。
- 候補は実装 `renderer/character/character/morphs.ts` が正本。新しいモデルで見つからない表情があれば、three の `MMDParser.parsePmx` でモーフ名を読み取り専用で一覧して、よくある別名なら候補に足す（そのモデル固有の名前なら morphMap で）。
- 見つからなかったモーフの一覧を起動時に main へ通知し、初回セットアップと設定画面に表示する（仕様書8.4のリスク対策）。
- モーフが無い感情は自前動作だけで表す（例: shy で頬モーフが無ければ目をそらす動作だけ）。

## 4. 自前動作（VMDが無い場合の最低保証）

各感情に0.6〜1.2秒の短いカーブを持たせる（スプライン／イージング）。対象は `上半身`、`首`、`頭`、モデル全体の位置。

| 感情 | 動作 |
| --- | --- |
| happy | 全体を+Y方向に小さく2回跳ねる（振幅 0.3、モデル単位） |
| surprised | 上半身を後ろへ -8°、頭 -5°、0.2秒で戻り始める |
| sad | 頭を前へ +12°、ゆっくり戻る |
| angry | 首を後ろへ引く -6°、頭を少し傾ける |
| troubled / thinking | 頭を左右どちらかへ 10° かしげる（thinking は視線も上へ） |
| shy | 頭を横へ 15° 向け、視線をそらす |
| 撫でられる | 目を閉じ（笑い）、頭を少し下げる |
| つつかれる | surprised を弱め(0.5)で |

状態の仕草: Listening=頭を少し傾け、2秒ごとに小さく頷く／Thinking=視線を上、首を傾ける／Acting=視線を下（手元）／Awaiting=頭を傾け、視線をユーザーへ／Sleeping=目を閉じ、頭を前へ。

## 5. アイドル（仕様書4.3）

- まばたき: 間隔 2〜6秒の一様乱数、15%で2回連続。閉じ0.08秒・開き0.12秒。
- 呼吸: 周期約4秒の sin で `上半身` を X に ±1.2°、全体を Y に ±0.01。
- 揺れ: `上半身`/`下半身` を Y・Z に振幅1〜2°の低周波（異なる周期を2つ重ねる）。
- アイドルVMD: 30〜90秒ごとに idle_*.vmd から機嫌（mood）で重み付けして1つ再生。無ければスキップ。
- 放置: 操作なし10分でうとうと（まぶた半分＋頭ゆっくり前後）、30分で Sleeping。入力で起きる。
- 乱数・時刻は注入できる形にする（テスト用）。
- 動きの活発さ（`render.liveliness` → `LIVELINESS`）: 呼吸・揺れの振幅、手持ちぶさたの仕草（`Fidgeter` / `fidgetGesture`、待機中・起きている・他の動きが無いときだけ）、話しながらのうなずき（`speakingPose`）、感情の仕草の大きさ、よそ見の頻度、アイドルVMDの間隔をまとめて変える。`normal` の呼吸・揺れは従来値。
- 話しながらの身ぶり: `talkGestures.ts`（言葉→身ぶりの選択 `chooseTalkGesture`、腕の目標方向 `talkPose`、方向での補間 `blendArm`）と `armRig.ts`（方向→ボーン回転。ひじは蝶番、手のひらは前腕のねじり、付与ボーンへの足し直し、指の曲げ）。文の再生開始で `talk()`、終了で `endTalk()`。腕のVMDが動いている間は、その重みに応じて弱める。
- 補間: 切り替わる層（状態の姿勢・身ぶり）は `CrossFader`（最小ジャーク曲線、途中切り替えでも速度が続く）でつなぐ。VMDは `vmdLayer.ts` の `VmdLayer`（`update()` 内でボーンを休止姿勢に戻した直後に開始、最後で止めて終わり0.4秒でフェードアウト、同じ感情の連続は複製で）。指数関数的な追従（`1-exp(-dt·k)`）は動き出しが急なので使わない。

## 6. リップシンク（renderer/character/lipsync.ts、純粋関数）

入力: VOICEVOX の AudioQuery（accent_phrases[].moras[] と pause_mora、prePhonemeLength、postPhonemeLength、speedScale）。

```
t = prePhonemeLength
for 各アクセント句:
  for 各モーラ: 子音長(consonant_length ?? 0) → 口は直前の形を保ちつつ閉じ気味(×0.4)
                 母音長 → vowel(a/i/u/e/o) を開く。N(ん)/cl(っ)/pau は閉じる
  pause_mora があれば閉じる
全時刻を speedScale で割る（VOICEVOX の長さは speedScale 適用前の値）
```

- 出力は `{t0, t1, vowel}` の配列（キーフレーム）。再生位置（AudioContext.currentTime − 再生開始時刻）で引き、隣接母音は60msでクロスフェード。最大開口0.8。
- 母音の大文字（無声化 `A I U E O`）は弱め（×0.3）。
- 代替: モーラが無い音声（Windows標準音声）は AnalyserNode のRMSから「あ」の開きだけを決める（平滑化 attack 30ms / release 80ms）。
- tests/unit/lipsync.test.ts で: 合計時間が WAV 長とほぼ一致（±50ms）、ん/っで閉じる、speedScale で伸縮。

## 7. 視線追従（仕様書4.5）

- main から `cursor:position`（画面座標、30Hz）を受け、ウィンドウ位置を引いてモデル頭部からの角度にする。
- 配分: 目60%、頭30%、首10%。頭は左右35°・上下20°で制限。臨界減衰バネ（ω≈8）で追う。
- Speaking と Awaiting はカメラ（正面）を見る。カーソル停止3秒で視線をゆるめ、時々よそ見。
- 目のボーンは `両目` があればそれ、無ければ `左目`/`右目`。

## 8. ウィンドウとクリック透過（仕様書3.2, FR-EX-01/02）

- BrowserWindow: `transparent: true, frame: false, alwaysOnTop: true('screen-saver'は使わず'floating'), skipTaskbar: true, resizable: false, hasShadow: false`、初期 480×720、プライマリの作業領域右下。
- クリック透過: 既定は `setIgnoreMouseEvents(true, {forward: true})`。renderer は mousemove を30Hzに間引き、**モデルのメッシュかUI要素の上か**を判定して `window:ignore-mouse` で切り替える。メッシュ判定はレイキャスト（SkinnedMesh はボーン変形を考慮しないので、代わりに**オフスクリーンの1pxピッキング**：描画済みのアルファを `readPixels` で読む方式を使う。`preserveDrawingBuffer` は不要、マウス位置で毎回 render 直後に読む）。
- ドラッグ移動: mousedown（モデル上）→ `window:drag {dx, dy}` を送り、main が setPosition。終了時に位置を settings に保存。
- ホイール拡縮 50%〜200%：カメラ距離ではなくウィンドウサイズとモデル scale を同時に変えるとクリック判定がずれない。ウィンドウサイズを 480×720×scale にする。
- 常に表示: Win+D（デスクトップの表示）や最小化で隠れたら、隠すべき状況（ユーザーが非表示にした／全画面アプリ）でない限り `CharacterWindow.reassert()` が復帰させる（minimize イベント＋3秒ごとの見張り）。
- ウィンドウが隠れている（hide / minimize）間は `M2C.visible` を受けて requestAnimationFrame 自体を止める（`setVisible`）。backgroundThrottling を切っているので、止めないと隠れていても描画し続ける。
- 描画は設定の fps 上限（requestAnimationFrame で経過時間を見て間引く）。Sleeping 中は設定値と 15fps の小さい方（`frameRateFor`）。5fps まで落とすと、1フレームの時間の打ち切り（0.1秒）でスローモーションになり、MMD物理（1回の更新で最大 3×1/65 秒）が骨格に追いつかず揺れ物が暴れる。物理は `physicsSteps` で ≤3/65 秒ずつに分けて進める。
- 頭・体の判定: クリック位置のピッキングで当たった頂点に一番近いボーン名を見る代わりに、画面上の頭ボーン位置からの距離で「頭」か「体」かを決める（簡単で十分）。

## 9. 親密度による変化（仕様書4.6）

レンダラ側で変えるのは「振れ幅」と「専用モーション」だけ。段階1は目をそらす頻度を上げ、段階3以上は happy の intensity を ×1.2（最大1.0）。口調はプロンプト側（PromptBuilder の関係性ブロック）。
