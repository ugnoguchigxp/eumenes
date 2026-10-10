# docs 索引

プロジェクトの README は [../README.md](../README.md)、計画書・設計書は [../spec/README.md](../spec/README.md) にあります。

## 起動・運用

| 文書 | 内容 |
| --- | --- |
| [setup.md](setup.md) | 起動の詳細。API token、LARM、TTS、VOICEVOX の環境変数と起動後の動作 |
| [settings.md](settings.md) | 設定画面(AI の使い方・接続先・音声・予約)とサービスの試用・自己診断 |
| [realtime.md](realtime.md) | SSE 通知と再接続の仕様、定期取得をしない方針 |
| [larm.md](larm.md) | LARM の接続、claim、予算、session 構成 |
| [logging.md](logging.md) | JSONL ログの保存先・相関 ID・障害調査の手順 |

## 構造・検証

| 文書 | 内容 |
| --- | --- |
| [domains.md](domains.md) | domain の一覧・依存・公開入口(自動生成)、所有試験、migration の規則、音声 MVP の所有境界 |
| [verification.md](verification.md) | verify / verify:live / ログの使い分けと現在の限界の詳細 |
| [acceptance.md](acceptance.md) | 音声 MVP の受入記録(fixture、live、実機器の区別) |
| [saaa-provenance.md](saaa-provenance.md) | SAAA 参照元と教訓 |

## 調査・取得

| 文書 | 内容 |
| --- | --- |
| [toolchain.md](toolchain.md) | 会話からの調査(capabilities・tool-runtime・agent-runtime) |
| [web-research.md](web-research.md) | llm-fetch による Web 取得、保存と期限 |
| [research-routes.md](research-routes.md) | 取得先と手順の学習・画面・CLI |

## 委任タスクとコーディング

| 文書 | 内容 |
| --- | --- |
| [delegated-tasks.md](delegated-tasks.md) | 委任タスクの基盤 |
| [coding-runner.md](coding-runner.md) | CLI runner の実装状況 |
| [coding-supervision.md](coding-supervision.md) | CLI コーディングタスクの監督 |

## 判断モデル・態度判定

| 文書 | 内容 |
| --- | --- |
| [decision-benchmark.md](decision-benchmark.md) | 判断モデルのベンチマーク(Python Script) |
| [ruri-collection.md](ruri-collection.md) | Ruri 発話態度判定の収集・レビュー・export |
| [ruri-verification.md](ruri-verification.md) | Ruri 互換・収集機能の検証記録 |

## UI

| 文書 | 内容 |
| --- | --- |
| [openui-artifact-showcase.md](openui-artifact-showcase.md) | OpenUI Artifact Showcase |
