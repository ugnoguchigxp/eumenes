# spec 索引

計画書・設計書・検証記録の一覧です。実装済み・検証済み・計画を区別するため、全項目の実装を確認できた計画書だけを [`.archived/`](.archived/) へ移します。

archive の基準: 本文の実施記録や完了記述で全項目が完了と読め、コードと試験で確認できたもの。live や実機器の受入が残る計画書、設計の一部だけが実装済みのもの、状態の記述が古く確認できないものは、進行中として残します。

## 進行中・未完了(spec/ 直下)

| 文書 | 状態 |
| --- | --- |
| [conversation-and-research-simplification-plan-2026-10-10.md](conversation-and-research-simplification-plan-2026-10-10.md) | 会話と調査の構造整理。残す機能・削除対象・移行・受入条件をまとめた実装前レビュー案 |
| [improvement-plan-2026-10-10.md](improvement-plan-2026-10-10.md) | 改善実装手順書(2026-10-10)。全 WP の完了後に archive |
| [research-and-history-tools-implementation-plan-2026-10-10.md](research-and-history-tools-implementation-plan-2026-10-10.md) | 調査・履歴ツールの実装計画。別セッションで作業中 |
| [delegated-coding-implementation-2026-10-09/](delegated-coding-implementation-2026-10-09/README.md) | 委任コーディングの実装計画(01〜06)。06 は作業中 |
| [web-research-cache-implementation-plan-2026-10-09.md](web-research-cache-implementation-plan-2026-10-09.md) | Web 取得・調査・キャッシュ。初期実装済み、実装記録は第15章 |
| [research-route-learning-implementation-plan-2026-10-09.md](research-route-learning-implementation-plan-2026-10-09.md) | 取得先学習の設計の正本。live gate 未実施 |
| [research-route-learning-implementation-tasks-2026-10-09.md](research-route-learning-implementation-tasks-2026-10-09.md) | 同チェックリスト(T00〜T25)。T25 の live gate と静岡市対応が未了 |
| [timer-artifact-implementation-plan-2026-10-09.md](timer-artifact-implementation-plan-2026-10-09.md) | 会話タイマー。live・実機器・一部 fixture が未実施 |
| [openui-artifact-foundation-plan-2026-10-09.md](openui-artifact-foundation-plan-2026-10-09.md) | OpenUI 基盤。P0/P1 実装済み、P2 以降は計画 |
| [external-apps-artifacts-implementation-plan-2026-10-09.md](external-apps-artifacts-implementation-plan-2026-10-09.md) | 外部アプリ成果物。レビュー用草案、実装前 |
| [provider-playground-design-2026-10-09.md](provider-playground-design-2026-10-09.md) | サービス試用機能の設計。実装は [検証記録](verification/service-tests/README.md) にあるが、設計との項目照合が未了のため残置 |
| [avatar-expression-context-design-2026-10-09.md](avatar-expression-context-design-2026-10-09.md) | アバター表情と TTS 感情制御の設計。製品実装は未着手 |
| [laya-voicevox-avatar-plan.md](laya-voicevox-avatar-plan.md) | Laya と VOICEVOX の話し方・アバター同期。接続した範囲のみ実装済み、拡張案は未実装 |
| [memory-system-incremental-adoption-concept.md](memory-system-incremental-adoption-concept.md) | 独立 MemorySystem の接続計画。E1/E2 の最小接続のみ実装済み |
| [decision-model-benchmark-design.md](decision-model-benchmark-design.md) | 判断モデルのベンチマーク設計。初版は実装済み([scripts/decision-bench/README.md](../scripts/decision-bench/README.md))、実時間の保持・GPU/NPU 利用率などは未実装 |
| [provider-playground-image-prompt-2026-10-09.txt](provider-playground-image-prompt-2026-10-09.txt) | 設計画像の生成プロンプト(資料) |

## archive 済み(spec/.archived/)

| 文書 | 備考 |
| --- | --- |
| [improvement-plan-2026-10-09.md](.archived/improvement-plan-2026-10-09.md) | 前回の改善実装計画。全 WP 完了、`verify:all` 成功を実施記録に記載 |
| [settings-screen-implementation-plan.md](.archived/settings-screen-implementation-plan.md) | 設定画面とクラウド自動フォールバック。実装・統合検証済み。実クラウドと実機器の受入は [検証記録](verification/settings/README.md) のとおり未実施 |
| [project-evaluation-2026-10-09.md](.archived/project-evaluation-2026-10-09.md) | プロジェクト評価(2026-10-09) |
| [toolchain-web-research-implementation-plan-2026-10-09.md](.archived/toolchain-web-research-implementation-plan-2026-10-09.md) | 会話からの調査 toolchain の実装計画 |
| [queue-scheduler-implementation-plan.md](.archived/queue-scheduler-implementation-plan.md) | queue・scheduler の実装計画 |
| [queue-scheduler-progress.md](.archived/queue-scheduler-progress.md) | 同進捗 |
| [continuity-bookmarks-preimplementation-plan.md](.archived/continuity-bookmarks-preimplementation-plan.md) | continuity ブックマークの実装前計画 |

## 検証記録・レビュー・資料

| 場所 | 内容 |
| --- | --- |
| [verification/](verification/) | 機能ごとの検証記録(fixture、live、実機器を分けて記録)と画面キャプチャ |
| [reviews/](reviews/) | コードレビューの記録(2026-10-07、2026-10-08、follow-up) |
| [design/](design/) | 設計画像 |
