# サードパーティの表記

DesktopMMD は次のソフトウェアを利用しています。それぞれのライセンスは各パッケージに従います。
このリポジトリ本体のライセンスは、これらや下記の外部データには及びません。

## npm 依存（実行時）

`npx license-checker --production --summary` の結果（2026-10-08 時点）。

| ライセンス | 件数 |
| --- | --- |
| MIT | 167 |
| ISC | 54 |
| BSD-2-Clause | 7 |
| BlueOak-1.0.0 | 6 |
| BSD-3-Clause | 4 |
| Apache-2.0 | 3 |
| (MPL-2.0 OR Apache-2.0) | 1（dompurify） |
| (MIT OR GPL-3.0-or-later) | 1（jszip。MITを選択） |
| (MIT AND Zlib) | 1（pako） |
| BSD* | 1（duck） |
| Unlicense | 1（fast-sha256） |
| MPL-2.0 | 1（ical.js。Googleカレンダーの予定の解析に使用。改変せずそのまま利用） |

主な直接依存: Electron、three.js、@anthropic-ai/sdk、@modelcontextprotocol/sdk、ical.js、preact、marked、dompurify、pdfjs-dist、mammoth、ws、zod、get-windows、uiohook-napi。
一覧の再生成: `npx license-checker --production`

## Python サイドカー

faster-whisper、onnxruntime、tokenizers、huggingface_hub、websockets、numpy、nvidia-cublas-cu12（任意）。
Silero VAD v6（faster-whisper に同梱の ONNX）を利用しています。

## 初回にダウンロードされるモデル（リポジトリには含まれません）

- 音声認識: Whisper large-v3-turbo（faster-whisper 形式。Hugging Face から取得）
- 埋め込み: Xenova/multilingual-e5-small（Hugging Face から取得）

各モデルのライセンスは配布元のページを確認してください。

## 含まれないもの

- MMDモデル・モーション（PMX/VMD）: 利用者が各自の規約に従って用意します。
- VOICEVOX: 利用者が別途入手します。音声を公開する場合は「VOICEVOX:キャラクター名」のクレジットが必要です。
