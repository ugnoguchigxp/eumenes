# docs 索引

プロジェクトの README は [../README.md](../README.md)、計画書・設計書は [../spec/README.md](../spec/README.md) にあります。

## 起動・運用

| 文書 | 内容 |
| --- | --- |
| [setup.md](setup.md) | 起動の詳細。API token、LARM、TTS、VOICEVOX の環境変数と起動後の動作 |
| [settings.md](settings.md) | 設定アーティファクト(会話・AIと接続・音声と入力・表示・記録)とサービスの試用・自己診断 |
| [realtime.md](realtime.md) | SSE 通知と再接続の仕様、定期取得をしない方針 |
| [larm.md](larm.md) | LARM の接続、claim、予算、session 構成 |
| [logging.md](logging.md) | JSONL ログの保存先・相関 ID・障害調査の手順 |
| [memory.md](memory.md) | 記憶担当(steward)：ContextWindow の層と予算、step と実行単位、依頼キュー、忘却の範囲、判断記録の見方、Seed候補の導入 |
| [google-accounts.md](google-accounts.md) | Googleアカウント1件の接続・再接続・解除。Calendar・Gmailと実アカウント受入は対象外 |

## 構造・検証

| 文書 | 内容 |
| --- | --- |
| [domains.md](domains.md) | domain の一覧・依存・公開入口(自動生成)、所有試験、migration の規則、音声 MVP の所有境界 |
| [verification.md](verification.md) | verify / verify:live / ログの使い分けと現在の限界の詳細 |
| [acceptance.md](acceptance.md) | 音声 MVP の受入記録(fixture、live、実機器の区別) |
| [nl-acceptance.md](nl-acceptance.md) | 自然言語UI受入。固定Playwright回帰の上に足す層。タイマーpilotは未合格 |
| [saaa-provenance.md](saaa-provenance.md) | SAAA 参照元と教訓 |

## 調査・取得

| 文書 | 内容 |
| --- | --- |
| [toolchain.md](toolchain.md) | 会話からのツールチェーン(capabilities・tool-runtime・agent-runtime・toolchain-history) |
| [toolchain-extension.md](toolchain-extension.md) | 追加の種類ごとの変更箇所・最小登録例・revision更新・登録漏れの確認手順 |
| [toolchain-extension-verification.md](toolchain-extension-verification.md) | ツールチェーン追加の段階別検証・停止条件と2026年10月11日の基準記録 |
| [web-research.md](web-research.md) | llm-fetch による Web 取得、保存と期限、検索地域 |
| [Web検索 実装目標](../spec/.archived/web-search-target-2026-10-11.md) | Web検索経路の目標仕様と現行との差分(計画) |
| [ツールチェーン設計](../spec/.archived/toolchain-set-routing-design-2026-10-12.md) | 定形セット・候補検索・選択の記録・手順キャッシュの設計 |

## 委任タスクとコーディング

| 文書 | 内容 |
| --- | --- |
| [delegated-tasks.md](delegated-tasks.md) | 委任タスクの基盤 |
| [coding-runner.md](coding-runner.md) | CLI runner の実装状況 |
| [coding-supervision.md](coding-supervision.md) | CLI コーディングタスクの監督 |
| [kanban.md](kanban.md) | タスクボードと会話からのカード操作。実 `claude` の通しと自然言語受入は未実施 |
| [terminals.md](terminals.md) | Claude Code画面と作業依頼表。Kanbanと同じ送信経路 |

## 判断モデル・態度判定

| 文書 | 内容 |
| --- | --- |
| [decision-benchmark.md](decision-benchmark.md) | 判断モデルのベンチマーク(Python Script) |
| [ruri-collection.md](ruri-collection.md) | Ruri 発話態度判定の収集・レビュー・export |
| [ruri-verification.md](ruri-verification.md) | Ruri 互換・収集機能の検証記録 |

## 制作・観測・UI

| 文書 | 内容 |
| --- | --- |
| [openui-artifact.md](openui-artifact.md) | OpenUI Artifact |
| [images.md](images.md) | 画像生成・一覧・削除 |
| [chat-images.md](chat-images.md) | チャット入力へのJPG・PNG・BMP添付 |
| [excalidraw.md](excalidraw.md) | Excalidrawの編集・保存・再表示 |
| [object-recognition.md](object-recognition.md) | 静止画・短い動画の物体検出 |
| [ocr.md](ocr.md) | 画像・短い動画のOCRと補正案。実gateway・実カメラは未受入 |
| [backgrounds.md](backgrounds.md) | 背景の切替、Three.js描画基盤、Dotsのモデルを組み込む方法 |
