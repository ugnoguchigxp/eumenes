# spec 索引

計画書・設計書・検証記録の一覧です。実装済み・検証済み・計画を区別するため、全項目の実装を確認できた計画書だけを [`.archived/`](.archived/) へ移します。

archive の基準: その文書が担当した実装がコードにあり、本文の実施記録で個別検証まで確認できるもの。残りが担当外の全体gate、対象外の実機器、または廃止済みの経路だけなら archive します。文書の対象そのものが未完了の段階として残っているものは、spec/ 直下に残します。

## 進行中・未完了(spec/ 直下)

| 文書 | 状態 |
| --- | --- |
| [toolchain-specialist-dialogue-implementation-plan-2026-10-17.md](toolchain-specialist-dialogue-implementation-plan-2026-10-17.md) | 実装・固定試験済み。専門担当への共通切替とUI自由制作の対話編集。ブラウザE2E・実モデル受入・実機器受入は未実施 |
| [toolchain-specialist-dialogue-p0-contract-2026-10-17.md](toolchain-specialist-dialogue-p0-contract-2026-10-17.md) | 上記のP0契約と担当分け。型契約はコードで固定。実装済み。実モデル測定は未実施 |
| [codex-sdk-task-artifact-plan-2026-10-14.md](codex-sdk-task-artifact-plan-2026-10-14.md) | 共通KanbanとCodex SDK。P1〜P3とP4の隔離commit/pushは記録済み。改訂7の終了確認は実装し、ブラウザなし全件検証はpass。全子孫停止は未保証。P5は継続 |
| [kanban-claude-code-plan-2026-10-14.md](kanban-claude-code-plan-2026-10-14.md) | Claude Code実行。P1〜P3は実装・固定試験済み。実 `claude` のフック確認は記録済み。実 LARM の自然言語受入は未実施 |
| [kanban-implementation-assignments-2026-10-14.md](kanban-implementation-assignments-2026-10-14.md) | 上記の分担と固定契約。P1〜P3は実装済み。P4は実 `claude` のフックまで。自然言語受入は計画側に残る |
| [web-research-cache-implementation-plan-2026-10-09.md](web-research-cache-implementation-plan-2026-10-09.md) | 第15〜17章のキャッシュとToolchain接続は記録済み。調査メモは未実装。公開Webは後続のguidedが正本 |
| [delegated-coding-implementation-2026-10-09/](delegated-coding-implementation-2026-10-09/README.md) | 01〜03と06のfixtureは記録済み。04の会話配送、05のモーダル、07、実CLI隔離は未完了 |
| [improvement-plan-2026-10-10.md](improvement-plan-2026-10-10.md) | 改善手順の初版。延期項目は第2版へ移管済み。残件は第2版の再確認節 |
| [improvement-plan-2026-10-10-r2.md](improvement-plan-2026-10-10-r2.md) | 第2版。2026-10-16再確認でも FE-4、FE-15、VO-16、DT-11、DT-13のpeer、CI保留が残る。FE-9の対象画面は置換済み |
| [test-quality-improvement-options-2026-10-15.md](test-quality-improvement-options-2026-10-15.md) | Replay・JiTTest等の評価候補。2026-10-16時点でも未導入 |
| [external-apps-artifacts-implementation-plan-2026-10-09.md](external-apps-artifacts-implementation-plan-2026-10-09.md) | 外部アプリの汎用契約。実装前。個別アーティファクトは別計画で実装済み |
| [avatar-expression-context-design-2026-10-09.md](avatar-expression-context-design-2026-10-09.md) | 表情とTTS感情の設計。接続済みのLaya判断は別計画。チャンク判断とヒステリシスは未実装 |
| [decision-model-benchmark-design.md](decision-model-benchmark-design.md) | 初版スクリプトは実装済み（[scripts/decision-bench/README.md](../scripts/decision-bench/README.md)）。実時間保持とGPU/NPU利用率は未実装。製品経路には未接続 |

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
| [ruri-sentence-language-tts-implementation-plan-2026-10-12.md](.archived/ruri-sentence-language-tts-implementation-plan-2026-10-12.md) | 廃案（2026-10-16）。Ruriの文章全体ja/en二分類は [正規表現判定](.archived/regex-speech-language-routing-plan-2026-10-16.md) に置換。接続記録は検証記録に残す |
| [openui-artifact-free-creation-implementation-plan-2026-10-14.md](.archived/openui-artifact-free-creation-implementation-plan-2026-10-14.md) | 旧UI自由制作の実装・検証記録。一回生成方式は2026-10-17に廃案とし、[専門担当との対話編集計画](toolchain-specialist-dialogue-implementation-plan-2026-10-17.md)で置換済み（旧コードは削除） |
| [music-playback-work-record-2026-10-11.md](.archived/music-playback-work-record-2026-10-11.md) | 保存曲の検索・再生。実装・固定試験・live・`verify:all` を記録し、残作業なし。実スピーカーの聴取は対象外 |
| [music-toolchain-work-record-2026-10-11.md](.archived/music-toolchain-work-record-2026-10-11.md) | 楽曲生成 toolchain。作業単位10で Opus・実生成・全体回帰まで記録。再生分離は playback 記録 |
| [music-generation-ui-work-record-2026-10-11.md](.archived/music-generation-ui-work-record-2026-10-11.md) | 生成UI。個別検証完了。全体gateは担当外のログ試験 |
| [music-desktop-work-record-2026-10-11.md](.archived/music-desktop-work-record-2026-10-11.md) | デスクトップ配置。部品・結合・保存音声の画面確認まで記録 |
| [singleton-music-artifact-work-record-2026-10-12.md](.archived/singleton-music-artifact-work-record-2026-10-12.md) | 生成と playlist の固定2画面。個別検証完了。全体gateは担当外の書式 |
| [chat-image-attachments-implementation-plan-2026-10-13.md](.archived/chat-image-attachments-implementation-plan-2026-10-13.md) | チャット画像添付。実装と部分・ブラウザ・実LARMを記録 |
| [chat-image-attachments-work-record-2026-10-13.md](.archived/chat-image-attachments-work-record-2026-10-13.md) | 上記の実装記録 |
| [image-toolchain-work-record-2026-10-13.md](.archived/image-toolchain-work-record-2026-10-13.md) | 画像生成 toolchain。固定試験・実LARM・UI受入を記録 |
| [image-ui-design-implementation-2026-10-13.md](.archived/image-ui-design-implementation-2026-10-13.md) | 承認デザインの画像UI。部分・結合・ブラウザ・保存画像表示を記録 |
| [image-embedded-implementation-2026-10-13.md](.archived/image-embedded-implementation-2026-10-13.md) | アーティファクト枠内表示。画面確認まで記録 |
| [image-delete-implementation-2026-10-13.md](.archived/image-delete-implementation-2026-10-13.md) | 画像削除。固定試験とブラウザ確認を記録 |
| [ocr-artifact-design-2026-10-14.md](.archived/ocr-artifact-design-2026-10-14.md) | OCR画面。実装と固定試験を記録。実gatewayと物理カメラは検証記録で未検証 |
| [ocr-llm-correction-design-2026-10-14.md](.archived/ocr-llm-correction-design-2026-10-14.md) | OCR補正案。実装と固定試験を記録。実LARMの品質受入は未実施 |
| [object-recognition-work-record-2026-10-13.md](.archived/object-recognition-work-record-2026-10-13.md) | 物体認識。固定試験と正式gatewayの実接続を記録。実カメラは未実施 |
| [excalidraw-work-record-2026-10-13.md](.archived/excalidraw-work-record-2026-10-13.md) | Excalidraw作業記録。実接続・MacBook・実LLMの受入を記録 |
| [timer-artifact-implementation-plan-2026-10-09.md](.archived/timer-artifact-implementation-plan-2026-10-09.md) | 会話タイマーの着手前手順。製品実装は後続の timer / clock 記録が正本 |
| [timer-ui-redesign-2026-10-12.md](.archived/timer-ui-redesign-2026-10-12.md) | 時計UI。個別検証完了。全体gateは担当外の size 制限 |
| [timer-launcher-work-record-2026-10-12.md](.archived/timer-launcher-work-record-2026-10-12.md) | タイマー入口の常設。個別検証と全体gateを記録 |
| [clock-workspace-compact-2026-10-13.md](.archived/clock-workspace-compact-2026-10-13.md) | コンパクト配置・ストップウォッチ・一時停止。個別検証を記録 |
| [settings-voice-input-implementation-2026-10-13.md](.archived/settings-voice-input-implementation-2026-10-13.md) | 音声と入力の設定移行。部分・結合・ブラウザ確認を記録 |
| [google-account-settings-2026-10-14.md](.archived/google-account-settings-2026-10-14.md) | Google接続・解除。固定試験とブラウザ確認を記録。実同意画面は未実施 |
| [light-spirit-skeletal-animation-plan-2026-10-14.md](.archived/light-spirit-skeletal-animation-plan-2026-10-14.md) | 光のアバターの骨格アニメーション。実装と fixture 検証を記録。実機GPUの目視は未実施 |
| [memory-steward-implementation-plan-2026-10-14.md](.archived/memory-steward-implementation-plan-2026-10-14.md) | 記憶担当。実装、fixture、live の主要シナリオを記録。製品DBを戻す復元など一部 live は fixture のみ |
| [memory-package-adoption-2026-10-16.md](.archived/memory-package-adoption-2026-10-16.md) | Memoryパッケージの Seed 接続。実装、固定試験、本体への28件登録を記録 |
| [memory-activation-implementation-plan-2026-10-13.md](.archived/memory-activation-implementation-plan-2026-10-13.md) | 記憶担当計画が置換。着手前の「未実装」は archive 注記のとおり |
| [world-reference-integration-2026-10-16.md](.archived/world-reference-integration-2026-10-16.md) | 収集資料台帳。隔離検証と本体 Seed 984件の投入を記録。通常起動を止めていた Web ツール版競合は別作業 |
| [research-route-learning-implementation-plan-2026-10-09.md](.archived/research-route-learning-implementation-plan-2026-10-09.md) | 廃止（2026-10-12）。`research-routes` を削除し toolchain-history へ置換 |
| [research-route-learning-implementation-tasks-2026-10-09.md](.archived/research-route-learning-implementation-tasks-2026-10-09.md) | 上記のチェックリスト。経路削除につき廃止 |
| [web-search-target-2026-10-11.md](.archived/web-search-target-2026-10-11.md) | 旧目標（quick@2 / search@1）。公開中は guided の recipe@4 / search@4 |
| [web-search-repair-implementation-plan-2026-10-11.md](.archived/web-search-repair-implementation-plan-2026-10-11.md) | 旧契約の A〜D。コードは入り、単発 live は失敗。経路は guided へ置換 |
| [toolchain-set-routing-design-2026-10-12.md](.archived/toolchain-set-routing-design-2026-10-12.md) | 定形セット P0〜P4 は実装済み。その後 guided へ進んだ |
| [conversation-and-research-simplification-plan-2026-10-10.md](.archived/conversation-and-research-simplification-plan-2026-10-10.md) | 調査の親子関係と Luna 接続は実装済み。live を含む P5 は未完了 |
| [research-and-history-tools-implementation-plan-2026-10-10.md](.archived/research-and-history-tools-implementation-plan-2026-10-10.md) | P0〜P5 と全体検証は通過。実モデル再受入は記録上未完了 |
| [world-steward-implementation-plan-2026-10-14.md](.archived/world-steward-implementation-plan-2026-10-14.md) | World と steward の接続。fixture 通過。live は一部 |
| [world-research-subagent-2026-10-15.md](.archived/world-research-subagent-2026-10-15.md) | World 照会を調査担当へ移した設計。fixture 通過。live は修正後に2問合格 |
| [regex-speech-language-routing-plan-2026-10-16.md](.archived/regex-speech-language-routing-plan-2026-10-16.md) | 日英区間の読み上げ。実装と fixture 検証済み。live と実機器は未実施 |
| [settings-openui-redesign-2026-10-12.md](.archived/settings-openui-redesign-2026-10-12.md) | 設定入口の全体設計。旧 `SettingsPage` は削除済み |
| [settings-openui-definition-storage-2026-10-12.md](.archived/settings-openui-definition-storage-2026-10-12.md) | 設定項目の保存先設計。データドリブン設定が後続の実装 |
| [settings-data-driven-design-2026-10-14.md](.archived/settings-data-driven-design-2026-10-14.md) | P1〜P4 の実装記録あり。実 LARM の接続確認は未実施 |
| [timer-data-driven-ui-acceptance-design-2026-10-13.md](.archived/timer-data-driven-ui-acceptance-design-2026-10-13.md) | タイマーのデータドリブン設計。実装は契約書側 |
| [timer-data-driven-implementation-contracts-2026-10-13.md](.archived/timer-data-driven-implementation-contracts-2026-10-13.md) | 固定契約は実装済み。自然言語 pilot は 12 run 中 success 0（旧 UI も 0/3） |
| [openui-artifact-foundation-plan-2026-10-09.md](.archived/openui-artifact-foundation-plan-2026-10-09.md) | P0/P1 ショーケース。P2 以降は後続アーティファクトで製品に入った |
| [provider-playground-design-2026-10-09.md](.archived/provider-playground-design-2026-10-09.md) | サービス試用の設計。実装と `verify:all` は検証記録 |
| [provider-playground-image-prompt-2026-10-09.txt](.archived/provider-playground-image-prompt-2026-10-09.txt) | 設計画像の生成プロンプト |
| [claude-agent-sdk-session-plan-2026-10-15.md](.archived/claude-agent-sdk-session-plan-2026-10-15.md) | セッション継続と課金経路。コードに接続済み。live のキャッシュ受入は文書に無い |
| [llm-native-implementation-plan-2026-10-10.md](.archived/llm-native-implementation-plan-2026-10-10.md) | S1〜S7 は実装。通し試験は記録済み。live は未合格 |
| [llm-native-remaining-domains-implementation-plan-2026-10-10.md](.archived/llm-native-remaining-domains-implementation-plan-2026-10-10.md) | Goals と World の対象修正。fixture と `verify:all` は通過。live は未実施 |
| [dots-script-mvp-implementation-plan-2026-10-10.md](.archived/dots-script-mvp-implementation-plan-2026-10-10.md) | 単体スクリプトは実 dots で成功。OAuth と製品統合は別計画 |
| [dots-toolchain-agent-skill-implementation-plan-2026-10-10.md](.archived/dots-toolchain-agent-skill-implementation-plan-2026-10-10.md) | 製品側の実装と隔離試験は実施。実 dots の製品受入は未実施 |
| [laya-voicevox-avatar-plan.md](.archived/laya-voicevox-avatar-plan.md) | 接続した範囲の話し方とアバター同期は実装済み。拡張案は未実装 |
| [memory-system-incremental-adoption-concept.md](.archived/memory-system-incremental-adoption-concept.md) | 初期の接続構想。記憶担当と Seed 接続が後続 |
| [test-environment-migration-plan-2026-10-14.md](.archived/test-environment-migration-plan-2026-10-14.md) | 初回範囲 A・B・M は検証記録どおり。snapshot と affected は後続 |

## 検証記録・レビュー・資料

| 場所 | 内容 |
| --- | --- |
| [verification/](verification/) | 機能ごとの検証記録(fixture、live、実機器を分けて記録)と画面キャプチャ |
| [reviews/](reviews/) | コードレビューの記録 |
| [design/](design/) | 設計画像 |
