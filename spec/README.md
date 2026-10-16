# spec 索引

計画書・設計書・検証記録の一覧です。実装済み・検証済み・計画を区別するため、全項目の実装を確認できた計画書だけを [`.archived/`](.archived/) へ移します。

archive の基準: 本文の実施記録や完了記述で全項目が完了と読め、コードと試験で確認できたもの。live や実機器の受入が残る計画書、設計の一部だけが実装済みのもの、状態の記述が古く確認できないものは、進行中として残します。

## 進行中・未完了(spec/ 直下)

| 文書 | 状態 |
| --- | --- |
| [claude-agent-sdk-session-plan-2026-10-15.md](claude-agent-sdk-session-plan-2026-10-15.md) | 計画書の状態欄は未実装。設定文書と `api/domains/inference/adapters/claude-session.ts` には認証方式の明示、実行時のモデル一覧、セッション台帳がある。計画の全項目と受入の照合は未了 |
| [codex-sdk-task-artifact-plan-2026-10-14.md](codex-sdk-task-artifact-plan-2026-10-14.md) | 共通KanbanとCodex SDK。P1〜P3のホスト接続とP4の隔離commit/pushは記録済み。Git復旧・共通画面の最終受入とP5は継続 |
| [kanban-claude-code-plan-2026-10-14.md](kanban-claude-code-plan-2026-10-14.md) | Claude Code実行。P1〜P3は実装・固定試験済み。実 `claude` の通しと自然言語受入（P4）は未実施 |
| [kanban-implementation-assignments-2026-10-14.md](kanban-implementation-assignments-2026-10-14.md) | 上記の分担と固定契約。P4の実機・自然言語受入は計画側に残る |
| [world-steward-implementation-plan-2026-10-14.md](world-steward-implementation-plan-2026-10-14.md) | 冒頭は未実装、本文は実装済み・fixture検証中。live受入の完了記述は無い |
| [world-research-subagent-2026-10-15.md](world-research-subagent-2026-10-15.md) | World照会を調査担当へ移す設計。現行の `world_query` 経路と対応する記述がある。文書内に完了記録は無い |
| [world-reference-integration-2026-10-16.md](world-reference-integration-2026-10-16.md) | 収集資料台帳と調査担当への接続。隔離検証と本体Seed 984件の投入は記録済み。通常起動の版競合は未完了。全件抽出・自動採用は対象外 |
| [memory-steward-implementation-plan-2026-10-14.md](memory-steward-implementation-plan-2026-10-14.md) | 実装済み・fixture検証済み・liveは一部。[検証記録](verification/memory-steward-2026-10-14/README.md) |
| [memory-package-adoption-2026-10-16.md](memory-package-adoption-2026-10-16.md) | パッケージAPIへの移行とSeed導入。固定試験は記録済み。規定ゲートは担当外の型エラーで停止 |
| [memory-activation-implementation-plan-2026-10-13.md](memory-activation-implementation-plan-2026-10-13.md) | 状態欄は計画・未実装。後続のsteward実装と本文の照合は未了のため残置 |
| [memory-system-incremental-adoption-concept.md](memory-system-incremental-adoption-concept.md) | E1/E2の最小接続のみ。一覧UI・実モデルは未実装 |
| [regex-speech-language-routing-plan-2026-10-16.md](regex-speech-language-routing-plan-2026-10-16.md) | 日英混在の区間判定。実装済み・fixture検証済み。liveと実機器受入は未実施 |
| [settings-data-driven-design-2026-10-14.md](settings-data-driven-design-2026-10-14.md) | P1実装済み・固定試験通過。P2〜P4は未着手 |
| [settings-openui-definition-storage-2026-10-12.md](settings-openui-definition-storage-2026-10-12.md) | 設定項目の保存先設計。設計案 |
| [settings-openui-redesign-2026-10-12.md](settings-openui-redesign-2026-10-12.md) | 設定入口の全体設計。音声と入力は移行済み。全フォームの移行完了とは読んでいない |
| [settings-voice-input-implementation-2026-10-13.md](settings-voice-input-implementation-2026-10-13.md) | 音声と入力の移行は部分・結合・ブラウザ確認済み。全体gateは担当外のsize制限で停止 |
| [google-account-settings-2026-10-14.md](google-account-settings-2026-10-14.md) | 接続・解除の固定試験とブラウザ確認は完了。配布用クライアントと同梱、実アカウント受入は未実施 |
| [timer-data-driven-ui-acceptance-design-2026-10-13.md](timer-data-driven-ui-acceptance-design-2026-10-13.md) | タイマーのデータドリブン移行と自然言語受入の設計。状態欄は設計案 |
| [timer-data-driven-implementation-contracts-2026-10-13.md](timer-data-driven-implementation-contracts-2026-10-13.md) | 固定契約は実装済み・`verify:all` の固定試験は通過。自然言語pilotは12 run中 success 0 |
| [timer-artifact-implementation-plan-2026-10-09.md](timer-artifact-implementation-plan-2026-10-09.md) | 会話タイマー。live・実機器・一部fixtureは未実施 |
| [timer-ui-redesign-2026-10-12.md](timer-ui-redesign-2026-10-12.md) | 時計UIの実装と個別検証は完了。全体gateは担当外修正後の再実行が残る |
| [timer-launcher-work-record-2026-10-12.md](timer-launcher-work-record-2026-10-12.md) | 入口を一つの「タイマー」に整理。終了読み上げの既存ブラウザ失敗が残る |
| [clock-workspace-compact-2026-10-13.md](clock-workspace-compact-2026-10-13.md) | コンパクト配置・ストップウォッチ・一時停止は個別検証済み。全体size制限と終了読み上げは未解決 |
| [toolchain-set-routing-design-2026-10-12.md](toolchain-set-routing-design-2026-10-12.md) | 定形セットの設計。本文はP0〜P4実装済み・試験未実行。現行のguided Webと照合し直すまで残置 |
| [web-search-target-2026-10-11.md](web-search-target-2026-10-11.md) | Web検索の目標仕様。差分が残る間は正本として残す |
| [web-search-repair-implementation-plan-2026-10-11.md](web-search-repair-implementation-plan-2026-10-11.md) | 状態欄は未実装。検証記録ではA〜Dのコードは入り、単発liveは失敗。完成とは扱わない |
| [web-research-cache-implementation-plan-2026-10-09.md](web-research-cache-implementation-plan-2026-10-09.md) | 初期実装とレビューは第15章以降。調査メモなど未実装範囲が残る |
| [conversation-and-research-simplification-plan-2026-10-10.md](conversation-and-research-simplification-plan-2026-10-10.md) | Web調査の汎用化とLuna接続は実装。liveと実機器を含むP5は未完了 |
| [research-and-history-tools-implementation-plan-2026-10-10.md](research-and-history-tools-implementation-plan-2026-10-10.md) | P0〜P5は固定試験と全体検証を通過。P6の実モデル再受入と実機器は未完了 |
| [research-route-learning-implementation-plan-2026-10-09.md](research-route-learning-implementation-plan-2026-10-09.md) | 取得先学習の設計。live gate未了。実行経路は2026-10-12に廃止済みで、計画の完了移動条件は満たしていない |
| [research-route-learning-implementation-tasks-2026-10-09.md](research-route-learning-implementation-tasks-2026-10-09.md) | 同チェックリスト。T25のlive gateは未了 |
| [dots-toolchain-agent-skill-implementation-plan-2026-10-10.md](dots-toolchain-agent-skill-implementation-plan-2026-10-10.md) | 製品側の実装と隔離試験は実施。認証付き公開接続と実dotsの製品受入は未実施 |
| [dots-script-mvp-implementation-plan-2026-10-10.md](dots-script-mvp-implementation-plan-2026-10-10.md) | 独立MVPは実dotsで成功。OAuthと製品統合は未実装 |
| [delegated-coding-implementation-2026-10-09/](delegated-coding-implementation-2026-10-09/README.md) | 委任コーディングの実装計画(01〜06)。実CLI隔離と全体受入は未完了 |
| [llm-native-implementation-plan-2026-10-10.md](llm-native-implementation-plan-2026-10-10.md) | S1〜S7は実装。通し試験は記録済み。live未合格・実機器未実施 |
| [llm-native-remaining-domains-implementation-plan-2026-10-10.md](llm-native-remaining-domains-implementation-plan-2026-10-10.md) | GoalsとWorldの対象修正はfixture実施。live・実機器は未達。計画自身が全項目完了までarchiveしないと書いている |
| [improvement-plan-2026-10-10.md](improvement-plan-2026-10-10.md) | 改善手順の初版。延期項目は第2版へ移管。第2版の未完了が残るため同時archiveしない |
| [improvement-plan-2026-10-10-r2.md](improvement-plan-2026-10-10-r2.md) | 第2版。多数のWPは実施記録あり。CI関連・FE-4・VO-16・FE-9・DT-11・DT-13が残るためarchiveしない |
| [test-environment-migration-plan-2026-10-14.md](test-environment-migration-plan-2026-10-14.md) | 状態欄は未着手。本文ではA・B・Mを実装。affected自動選択とsnapshotは未導入 |
| [test-quality-improvement-options-2026-10-15.md](test-quality-improvement-options-2026-10-15.md) | Replay・JiTTest等の評価候補。未着手 |
| [openui-artifact-foundation-plan-2026-10-09.md](openui-artifact-foundation-plan-2026-10-09.md) | P0/P1は実装・fixture E2E済み。P2以降は計画 |
| [external-apps-artifacts-implementation-plan-2026-10-09.md](external-apps-artifacts-implementation-plan-2026-10-09.md) | 外部アプリ成果物。レビュー用草案、実装前 |
| [provider-playground-design-2026-10-09.md](provider-playground-design-2026-10-09.md) | サービス試用の設計。実装は [検証記録](verification/service-tests/README.md)。設計項目との照合は未了 |
| [provider-playground-image-prompt-2026-10-09.txt](provider-playground-image-prompt-2026-10-09.txt) | 設計画像の生成プロンプト |
| [avatar-expression-context-design-2026-10-09.md](avatar-expression-context-design-2026-10-09.md) | アバター表情とTTS感情の設計。製品実装は未着手 |
| [laya-voicevox-avatar-plan.md](laya-voicevox-avatar-plan.md) | 接続した範囲の話し方・アバター同期は実装済み。拡張案は未実装 |
| [light-spirit-skeletal-animation-plan-2026-10-14.md](light-spirit-skeletal-animation-plan-2026-10-14.md) | 実装済み・fixture検証済み。実機GPUの目視は未実施 |
| [decision-model-benchmark-design.md](decision-model-benchmark-design.md) | 初版は実装済み（[scripts/decision-bench/README.md](../scripts/decision-bench/README.md)）。実時間の保持、GPU/NPU利用率などは未実装 |
| [ocr-artifact-design-2026-10-14.md](ocr-artifact-design-2026-10-14.md) | 画面は実装済み。実gatewayと物理カメラは [検証記録](verification/ocr-2026-10-14/README.md) のとおり未検証 |
| [ocr-llm-correction-design-2026-10-14.md](ocr-llm-correction-design-2026-10-14.md) | 補正案は実装済み・固定試験済み。実LARMの品質受入は未実施 |
| [object-recognition-work-record-2026-10-13.md](object-recognition-work-record-2026-10-13.md) | 正式接続の記録あり。実カメラと、live結果のブラウザ表示は未実施 |
| [excalidraw-work-record-2026-10-13.md](excalidraw-work-record-2026-10-13.md) | 実接続・MacBook・実LLMの受入は確認済み。作業ツリー全体のgateは未完了 |
| [chat-image-attachments-implementation-plan-2026-10-13.md](chat-image-attachments-implementation-plan-2026-10-13.md) | 添付は実装済み。部分・ブラウザ・実LARMは確認済み。全体gateの項目は未了 |
| [chat-image-attachments-work-record-2026-10-13.md](chat-image-attachments-work-record-2026-10-13.md) | 上記の実装記録。全体gateは担当外の境界違反待ち |
| [image-toolchain-work-record-2026-10-13.md](image-toolchain-work-record-2026-10-13.md) | 生成toolchainの実装・固定試験・実LARM・UI受入は完了。全体gateは担当外の境界違反で未完了 |
| [image-ui-design-implementation-2026-10-13.md](image-ui-design-implementation-2026-10-13.md) | 承認デザインのUIは確認済み。全体gateは担当外エラーのまま |
| [image-embedded-implementation-2026-10-13.md](image-embedded-implementation-2026-10-13.md) | アーティファクト枠内表示は確認済み。全体gateは未完了 |
| [image-delete-implementation-2026-10-13.md](image-delete-implementation-2026-10-13.md) | 削除の固定試験とブラウザ確認は済み。実LARM画像の削除と全体gateは未了 |
| [music-toolchain-work-record-2026-10-11.md](music-toolchain-work-record-2026-10-11.md) | 楽曲生成・Opus・全体回帰は記録の後半で完了。文書末尾の再生分離は playback 記録で実施済み。末尾が残作業のままなので、playback記録と一緒には移していない |
| [music-generation-ui-work-record-2026-10-11.md](music-generation-ui-work-record-2026-10-11.md) | 生成UIの個別検証は完了。全体gateは担当外のログ試験で未合格 |
| [music-desktop-work-record-2026-10-11.md](music-desktop-work-record-2026-10-11.md) | デスクトップ配置の部品確認は完了。回帰検証は次作業として残したまま |
| [singleton-music-artifact-work-record-2026-10-12.md](singleton-music-artifact-work-record-2026-10-12.md) | 生成とplaylistを固定2画面にした記録。全体gateは担当外の書式エラーで未合格 |

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
| [ruri-sentence-language-tts-implementation-plan-2026-10-12.md](.archived/ruri-sentence-language-tts-implementation-plan-2026-10-12.md) | 廃案（2026-10-16）。Ruriの文章全体ja/en二分類は [正規表現判定](regex-speech-language-routing-plan-2026-10-16.md) に置換。接続記録は検証記録に残す |
| [openui-artifact-free-creation-implementation-plan-2026-10-14.md](.archived/openui-artifact-free-creation-implementation-plan-2026-10-14.md) | UI自由制作。保存・制作・登録・画面・デモは実装済み。部分、公開API結合、ブラウザ、実モデルを記録。親runへの自動追記は対象外 |
| [music-playback-work-record-2026-10-11.md](.archived/music-playback-work-record-2026-10-11.md) | 保存曲の検索・再生。実装・固定試験・live・`verify:all` を記録し、残作業なし。実スピーカーの聴取は対象外 |

## 検証記録・レビュー・資料

| 場所 | 内容 |
| --- | --- |
| [verification/](verification/) | 機能ごとの検証記録(fixture、live、実機器を分けて記録)と画面キャプチャ |
| [reviews/](reviews/) | コードレビューの記録 |
| [design/](design/) | 設計画像 |
