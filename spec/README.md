# spec 索引

計画書・設計書・検証記録の一覧です。実装済み・検証済み・計画を区別するため、全項目の実装を確認できた計画書だけを [`.archived/`](.archived/) へ移します。

archive の基準: 本文の実施記録や完了記述で全項目が完了と読め、コードと試験で確認できたもの。live や実機器の受入が残る計画書、設計の一部だけが実装済みのもの、状態の記述が古く確認できないものは、進行中として残します。

## 進行中・未完了(spec/ 直下)

| 文書 | 状態 |
| --- | --- |
| [claude-agent-sdk-session-plan-2026-10-15.md](claude-agent-sdk-session-plan-2026-10-15.md) | Claude Agent SDKのサブスク／APIキー認証の明示切替、モデル一覧の実行時取得、チャット画面左上の推論先SelectBox、会話エージェントのSessionID維持（接続×認証×モデル単位の台帳とWindow照合）、サブエージェントのタスク単位セッション。レビュー用計画・未実装 |
| [timer-data-driven-ui-acceptance-design-2026-10-13.md](timer-data-driven-ui-acceptance-design-2026-10-13.md) | Astraによるタイマーの定義登録・共通実行・OpenUI・質問継続の移行設計。既存Playwright回帰を維持し、自然言語目的によるAI自律UI受入を追加。設計案・未実装・試験未実行 |
| [settings-openui-definition-storage-2026-10-12.md](settings-openui-definition-storage-2026-10-12.md) | 設定項目の軽量登録と保存先の詳細設計。実テーブル・列・JSONパス、管理操作と読取のbinding、型と保存範囲、追加手順と受入を定義。設計案・未実装 |
| [settings-openui-redesign-2026-10-12.md](settings-openui-redesign-2026-10-12.md) | Astraレビューに基づく薄い設定入口と目的別OpenUIアーティファクトの全体設計。現行全項目の編集先、共同下書き、個別保存、タブの寿命、秘密入力、段階移行と受入を整理。設計案・未実装 |
| [ruri-sentence-language-tts-implementation-plan-2026-10-12.md](ruri-sentence-language-tts-implementation-plan-2026-10-12.md) | Ruriの文章全体ja/en二分類とVOICEVOX・KittenTTS振分け。内部契約・固定試験の先行、LARM公開契約への依存、取消・採用、回帰・live・実機器受入を定めた実装計画。常駐分類Providerと両TTSを公開接続し試用有効化済み。全体gate・実機器受入は未完了 |
| [toolchain-set-routing-design-2026-10-12.md](toolchain-set-routing-design-2026-10-12.md) | ツールチェーンを定形セット(ツール・SystemContext・SKILL・実行metadata)として登録し、候補検索→会話担当の選択→調査担当の実行へ統一する設計。`kind` 欠落障害の原因記録、`web_search` の手順キャッシュ、選択トレース(新domain toolchain-history)、research-routes廃止。P0〜P4実装済み・未検証 |
| [web-search-target-2026-10-11.md](web-search-target-2026-10-11.md) | Web検索(web.quick@2・Luna web.search@1)の実装目標の正本。SystemContextの層構成、会話方針と公開ツールの一致、結果返却の必須規則、現行との差分G1〜G12と受入。計画・未着手 |
| [dots-toolchain-agent-skill-implementation-plan-2026-10-10.md](dots-toolchain-agent-skill-implementation-plan-2026-10-10.md) | dots を統括担当にする製品統合計画。Session 委任、ブロッカー・再開・完了報告、担当／Skill 設定、次作業リマインドを設計。製品統合は未実装 |
| [dots-script-mvp-implementation-plan-2026-10-10.md](dots-script-mvp-implementation-plan-2026-10-10.md) | 独立 MVP 実装済み。実 dots→回答保存→CLI 受信に成功。OAuth・恒久接続・製品統合は未実装。第18章と受入記録参照 |
| [llm-native-remaining-domains-implementation-plan-2026-10-10.md](llm-native-remaining-domains-implementation-plan-2026-10-10.md) | Goals内容同一視の撤去とWorld保留入力保持を実装。Memoryは接続前条件の文書化のみ。fixture実施、live・実機器未達 |
| [llm-native-implementation-plan-2026-10-10.md](llm-native-implementation-plan-2026-10-10.md) | LLM-Native設計への移行。要件データ・共通検証・残存5件の撤去を、契約・変更箇所・移行・受入まで定めたSol実装用計画。実装前 |
| [conversation-and-research-simplification-plan-2026-10-10.md](conversation-and-research-simplification-plan-2026-10-10.md) | 会話と調査の構造整理。残す機能・削除対象・移行・受入条件をまとめた実装前レビュー案 |
| [improvement-plan-2026-10-10-r2.md](improvement-plan-2026-10-10-r2.md) | 改善実装手順書 第2版(2026-10-10 再評価)。全改善点 77 WP(AP/AG/VO/DT/FE)と旧計画の延期項目。実装前 |
| [improvement-plan-2026-10-10.md](improvement-plan-2026-10-10.md) | 改善実装手順書(2026-10-10)。延期項目は第2版へ移管。第2版と同時に archive |
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
| [excalidraw-artifact-2026-10-14.md](.archived/excalidraw-artifact-2026-10-14.md) | Excalidraw の iframe 編集。実装・`verify --domain excalidraw --domain artifact` 通過・正式接続の live 記録（[artifact-2026-10-14.json](verification/excalidraw-live/artifact-2026-10-14.json)）あり |
| [larm-multimodal-contract-inquiry-prompt-2026-10-13.md](.archived/larm-multimodal-contract-inquiry-prompt-2026-10-13.md) | LARM 画像入力契約の問い合わせ Prompt。回答を受けた契約（MIME・入力予算）を `larm/contracts/chat-input.ts` に実装済み |

## 検証記録・レビュー・資料

| 場所 | 内容 |
| --- | --- |
| [music-toolchain-work-record-2026-10-11.md](music-toolchain-work-record-2026-10-11.md) | 楽曲生成と再生の着手記録。既存API・会話・Artifactの調査、未決事項、Skill化に向けた手順候補。製品実装・楽曲生成・試験は未実施 |
| [verification/llm-native-remaining-domains-2026-10-10/](verification/llm-native-remaining-domains-2026-10-10/README.md) | Goalsの内容同一視撤去・World保留入力修正の実施記録。Memoryは接続前条件の文書化のみ、live・実機器未実施 |
| [reviews/llm-native-remaining-domains-2026-10-10/](reviews/llm-native-remaining-domains-2026-10-10/README.md) | Memory・World・coding系と隣接domainのLLM-Native監査。到達性・反証・再現・fixture420件、live未実施 |
| [verification/ruri-sentence-language-2026-10-12/](verification/ruri-sentence-language-2026-10-12/README.md) | 常駐文章二分類・両TTS・通常APIの接続記録。試用有効、通信込みのP95測定、全体gate・実機器の残作業 |
| [verification/](verification/) | 機能ごとの検証記録(fixture、live、実機器を分けて記録)と画面キャプチャ |
| [reviews/](reviews/) | コードレビューの記録(2026-10-07、2026-10-08、follow-up) |
| [design/](design/) | 設計画像 |
