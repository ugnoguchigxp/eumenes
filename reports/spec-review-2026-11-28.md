# spec 文書の照合記録（前ラウンドの記録）

本書は前ラウンド時点の状態を保存した記録。現在の採否と移動先は [今回の整理結果](spec-triage-2026-11-28.md) を正本とする。目的は、計画・設計文書の実装と個別検証の状態を確認し、完了分を `spec/.archived/` へ移すこと。未実施計画の採否判断と `.todo` への移動は次ラウンド。文書中の live・実機器の未実施は固定試験と分けて扱う。

直下の各文書を個別に記載し、実装済みであっても未受入・未確認の条件を明記する。複数の状態が混在する文書や、実施の根拠を確定できない文書はその旨を記す。`spec/verification/`、`spec/design/` などは検証根拠・補助資料であり、それ自体を一律に実装計画とみなさない。[補助資料一覧](spec-supporting-documents-2026-11-28.md)には付属の外部パッケージ文書も分けて掲載する。以前の [機械的な索引照合](spec-inventory-2026-11-28.md) は移動前の暫定スナップショットであり、移動先を判断する根拠ではない。

今回の対象だった直下の文書228件のうち、113件を移動し、115件を直下に保持した。下位の計画3件も移動し、完了・旧版の画面案は画像等と一緒に移動した。直下に保持したものには、一部実施の設計、未実施の計画、現行仕様、実施状況を確定できない文書が含まれる。`.todo` への移動と、今後実施するかの判断は行っていない。

## 移動済み：実装済み・終了した調査・後続に置き換わった旧案

| 文書 | 判断の根拠と留保 |
| --- | --- |
| [CLI対話](../spec/.archived/cli-chat-mode-design-2026-10-31.md) | 実装・固定とAPI結合・CLI実接続2往復。実モデル制作とWebブラウザ受入は未実施。 |
| [LARM接続保持](../spec/.archived/larm-connection-retention-design-2026-10-18.md) | §11〜12の固定・結合・実接続6分・稼働反映。 |
| [Pursuit実行経路](../spec/.archived/pursuit-eumenes-live-routing-2026-11-06.md) | 個別試験・実会話・報告表示。全題材での成功保証ではない。 |
| [調査メモの詳細と全文](../spec/.archived/research-note-levels-and-okf-design-2026-11-15.md) | 個別・実モデル・ブラウザー。全体検証の既存失敗は分離して記録。 |
| [画面フォームの担当指定](../spec/.archived/artifact-form-direct-toolchain-design-2026-10-23.md) | §8の実装と固定試験。ブラウザーE2E・live・実機器は未実施。 |
| [サーバー先行起動](../spec/.archived/server-listen-first-startup-design-2026-11-07.md) | L1〜L3と固定試験・レビュー後回帰。実機再起動確認は未実施。 |
| [自律調査統合](../spec/.archived/agency-autonomy-integration-2026-11-02.md) | 実装・配布・対象固定試験と2件の実モデル受入。後続の対象domain検証を記録。広い品質評価は未確認。 |
| [AgencyのSystemContext接続](../spec/.archived/agency-host-system-context-integration-2026-10-31.md) | 接続と個別96件・型を確認。標準verifyは既存整形で停止し、広域試験の失敗を切り分け。実モデルは対象外。 |
| [Agency関心・問いの取込](../spec/.archived/agency-interest-growth-integration-2026-11-01.md) | 配置・対象domain検証・実接続を記録。関心形成の品質比較と実機器は未実施。 |
| [アプリ専用SQLite](../spec/.archived/app-managed-sqlite-design-2026-11-09.md) | 固定試験と実モデル・画面で保存・編集・削除を確認。標準検証の既存阻害は別記。 |
| [音声生成の3用途](../spec/.archived/audio-routing-work-record-2026-10-20.md) | 部分・結合・対象domain・ブラウザー・実LARM生成を記録。実聴取・実LLM選択は未確認。 |
| [アバター音声連動](../spec/.archived/avatar-audio-control-2026-11-03.md) | 個別と対象domain・消音ブラウザーの実モデルを検証。実Provider・実機器は未実施。 |
| [アバター動作調整](../spec/.archived/avatar-motion-adjustment-2026-11-07.md) | 調整後の部分・結合・描画比較。全体型・verifyの既存阻害は分離。 |
| [アバター表示調整](../spec/.archived/avatar-view-adjustment-2026-11-07.md) | 部分・domain・消音ブラウザーで構図と背景色を検証。 |

| [ブラウザー履歴の再実行](../spec/.archived/browser-history-replay-design-2026-10-27.md) | 対象domain・結合・固定Web検証。実Braveは未実施。 |
| [ブラウザー履歴の保存](../spec/.archived/browser-run-history-design-2026-10-27.md) | 対象domain・結合を検証。実Brave・実LLMは未実施。 |
| [browser interact統合](../spec/.archived/browser-interact-integration-2026-11-05.md) | 検証用入口までの実装・domainと隔離Chrome受入。通常会話への有効化は対象外。 |
| [共同作業統合](../spec/.archived/collaboration-integration-2026-11-05.md) | 対象10領域と実会話・画面を検証。実外部サイト・音声実機は未受入。 |

| [チャット表示のスクロール](../spec/.archived/chat-scroll-optimization-2026-11-15.md) | 実装と部分・Web結合・消音Chromium検証。共通検証の既存違反は別記。 |

| [汎用Collaboration](../spec/.archived/collaboration-task-availability-design-2026-11-12.md) | 公開終了・旧セッション移行を固定試験と稼働APIで確認。旧機能の未受入は現行の残件にしない。 |
| [旧計算ツールチェーン案](../spec/.archived/compute-toolchain-design-2026-10-20.md) | 旧案はCPU統合設計へ置換。現行経路の未完受入は後続文書に保持。 |

| [担当依頼の継続](../spec/.archived/conversation-delegation-continuity-2026-11-22.md) | 実装、109件の関連固定試験と実モデルの隔離通し。実端末起動・稼働反映は対象外。 |
| [会話の診断](../spec/.archived/conversation-self-diagnostics-design-2026-11-12.md) | 固定・実モデル・隔離Claude Codeを検証。稼働反映と製品コード修正は対象外。 |

| [会話本文ストリーム](../spec/.archived/conversation-text-stream-design-2026-11-15.md) | 固定・消音Chromium・公開API liveで表示、取消、保存を確認。 |
| [Doclingの起動準備](../spec/.archived/docling-artifact-on-demand-2026-10-27.md) | 対象domain・固定ブラウザー試験を確認。実接続は未実施。 |
| [dotsメッセージ](../spec/.archived/dots-messaging-design-and-plan-2026-10-25.md) | 末尾のP5で試験接続による3往復・保存・画面確認。冒頭の未実施表記より後の実施記録を採用。恒久認証は対象外。 |
| [dots relay撤去](../spec/.archived/dots-no-relay-cleanup-2026-10-25.md) | 部分・結合・ブラウザー・稼働APIの記録と撤去済みコードを確認。 |

| [画像のモデル選択と入力保持](../spec/.archived/image-model-selection-work-record-2026-10-31.md) | domain・実画面・実生成を確認。外部未配備のモデルは対象外として区別。 |
| [Codex SDKソース調査](../spec/.archived/inspect-source-codex-sdk-design-2026-11-15.md) | 最終の非同期方式まで固定・実SDK・ブラウザーで確認。実機音声は未実施。 |
| [LARM接続容量](../spec/.archived/larm-agent-capacity-design-2026-11-01.md) | 対象domainと実LARM初回を確認。再確認時の503・稼働反映未確認は分離。 |

| [LARM Provider準備](../spec/.archived/larm-provider-readiness-design-2026-10-25.md) | 固定・実LARM・本番APIのASR/TTS確認。本人機器での音声3往復とは区別。 |
| [Live音声の設計レビュー](../spec/.archived/live-voice-design-review-2026-10-31.md) | レビューの成果は記録済み。設計の実装と本人機器受入は別文書に残す。 |
| [保守リファクタリング](../spec/.archived/maintenance-refactoring-2026-11-06.md) | 対象domain・WebGL比較・レビューを記録。外部Provider・本人機器は別。 |

| [旧Markdown単件削除案](../spec/.archived/markdown-document-delete-design-2026-11-07.md) | 後続のライブラリ拡張へ統合した事前調査。未配備の旧案を実装済みとは扱わない。 |
| [Memory配布物・CLI/MCP](../spec/.archived/memory-cli-mcp-package-adoption-2026-11-07.md) | 配布hash・部分・結合・対象domain検証がpass。稼働プロセス反映は別。 |
| [Memory本流統合](../spec/.archived/memory-integration-2026-11-05.md) | 最新結果で保存・取得・訂正・忘却・再起動後を実会話と対象domainで確認。 |

| [MemoryとWorldの初期整理](../spec/.archived/memory-world-default-set-proposal-2026-11-07.md) | 対象domain pass・利用者承認の実データ整理・非対象保持を記録。 |
| [音楽の自動再生](../spec/.archived/music-autoplay-work-record-2026-10-31.md) | 部分・結合・対象domain・ブラウザーfixture。稼働画面は未確認。 |
| [音楽promptの保持](../spec/.archived/music-prompt-retention-work-record-2026-10-27.md) | 部分・結合・固定ブラウザー。実生成は未実施。 |
| [通知履歴のクリア](../spec/.archived/notification-history-archive-2026-10-30.md) | 保存・API・画面の固定検証。対象外の既存境界違反とE2E未実施を分離。 |
| [通知音](../spec/.archived/notification-sounds-2026-10-31.md) | 固定検証と利用者の聴取確認。追加バリエーションは提案のまま。 |

| [Pipelineの取込み](../spec/.archived/pipeline-p0-3-integration-2026-11-05.md) | 旧実装撤去・固定・対象domain検証。稼働切替と実LLMは当時未実施。 |
| [Pursuit productive](../spec/.archived/pursuit-productive-integration-2026-11-10.md) | 対象domain・利用側固定試験と実会話からのMarkdown公開。 |
| [Pursuit Web調査の統合](../spec/.archived/pursuit-web-research-integration-2026-11-06.md) | 実Web・API・追加の通常会話受入を記録。 |
| [品質ガードレール](../spec/.archived/quality-guardrails-and-sustainability-plan-2026-11-22.md) | 合意範囲のPhase 0〜2を実装・検証。個別設計の6項目と随時のS3は対象外。 |

| [旧ルート文脈案](../spec/.archived/route-context-design-2026-10-29.md) | ローカルハーネス再構築で置換した履歴。 |
| [ハーネス一本化](../spec/.archived/single-harness-plan-2026-10-31.md) | 対象domain、固定試験、独立レビュー後の回帰。クラウドliveは未実施。 |

| [未参照コードの整理](../spec/.archived/subproject-dead-code-cleanup-2026-11-03.md) | 対象10domain・部分結合・差分点検を完了。 |
| [旧Pipeline設計](../spec/.archived/task-pipeline-design-2026-10-22.md) | 後続Pipeline取込みで置換した履歴。 |
| [旧TODO完了通知](../spec/.archived/todo-completion-notice-design-2026-10-29.md) | fixture済みの旧実装。後続の依頼項目設計でTODO自体を廃止。 |
| [旧TODO報告・履歴](../spec/.archived/todo-report-and-archive-work-record-2026-10-27.md) | 旧調査と実装記録。後続通知設計、さらに依頼項目へ置換。 |
| [旧TODO読み上げ](../spec/.archived/todo-spoken-report-delivery-design-2026-10-27.md) | 2026-10-29に廃止、旧経路削除済み。 |

| [UI制作の表現部品](../spec/.archived/ui-studio-expressive-parts-implementation-plan-2026-10-17.md) | 固定・domain・ブラウザーE2E済み。実モデル・音声実機・Storybookは未実施。 |
| [UI制作の履歴・切替](../spec/.archived/ui-studio-history-focus-design-2026-10-18.md) | 対象domain・画面・レビュー後の固定試験を記録。 |
| [UI制作の一回推論](../spec/.archived/ui-studio-one-shot-draft-design-2026-10-18.md) | 担当型設計§12に統合。fixer等は同設計の固定試験に記録。 |

| [未使用コードの共通化](../spec/.archived/unused-code-consolidation-design-2026-11-03.md) | 対象14domain・レビューを確認。実機器等は対象外。 |
| [利用状況画面](../spec/.archived/usage-dashboard-design-2026-10-31.md) | 対象6domain・複数画面幅のブラウザーfixtureを検証。 |
| [動画生成](../spec/.archived/video-generation-2026-11-14.md) | 固定・ブラウザーと実LARM生成。後の画面改訂は固定検証、追加実生成は未実施。 |
| [視覚解析](../spec/.archived/visual-perception-subsystem-design-2026-10-25.md) | 対象domain・実LARM・画面と停止観測を検証。 |
| [CodexによるWeb調査](../spec/.archived/web-note-codex-search-2026-11-11.md) | 固定と実検索、出典リンクの確認を記録。 |
| [調査結果のMarkdown保存](../spec/.archived/web-research-markdown-design-2026-11-08.md) | 固定・実モデル・Docling・画面受入。自然文取消・担当選択は別課題。 |
| [World出典統合](../spec/.archived/world-evidence-integration-2026-10-31.md) | 対象改修・固定domain検証。意味品質・運用受入は別。 |
| [World配布物の取込](../spec/.archived/world-package-adoption-2026-11-07.md) | 利用側6領域・移行・稼働API読取りを検証。新規書込み・意味品質は対象外。 |

| [天気の即時回答](../spec/.archived/weather-instant-toolchain-design-2026-10-18.md) | 地名解決・対象選択・障害時の固定試験を再実行し、株価と合わせて95件成功。過去の実API確認あり。Routerの記述は旧方式。 |
| [株価の即時回答](../spec/.archived/stock-instant-toolchain-design-2026-10-18.md) | 価格・銘柄解決・対象選択の固定試験を再実行。旧案のWeb検索への切替は現行では行わないことを試験で確認。実LLM選択は当時未確認。 |

| [メモの根拠保持](../spec/.archived/agency-note-input-retention-2026-11-15.md) | [検証記録](../spec/verification/memory-stale-2026-11-15.md)で固定・結合と追加修正後の稼働API通し完了を確認。 |
| [Memory CLI/MCP起動](../spec/.archived/memory-cli-mcp-runtime-2026-11-07.md) | [稼働確認](../spec/verification/memory-live-2026-11-07/README.md)で部分・domain・CLI/MCP参照と再接続を確認。実データ書込みは対象外。 |
| [LARM容量の照合修正](../spec/.archived/larm-context-capacity-contract-fix-2026-11-01.md) | [受入記録](../spec/verification/larm-context-capacity-2026-11-01/acceptance.md)で容量契約の修正・実接続と稼働反映を確認。再起動後の生成はProvider準備待ちで未達。 |
| [撮影画像の保存](../spec/.archived/camera-image-larm-save-design-2026-10-27.md) | 現行の撮影資料・画像取込queue結合10件と画面hook3件を再実行し成功。実LARM・実カメラは未確認。 |

| [旧CLI runner・MCP](../spec/.archived/delegated-coding-implementation-2026-10-09/02-coding-runner-and-mcp.md) | 2026-10-31に利用者決定で旧方式を中止しコード削除。Codex SDK版は別計画。 |
| [旧コーディング監督](../spec/.archived/delegated-coding-implementation-2026-10-09/03-coding-supervision.md) | 旧CLI runnerとともに中止・旧domain削除済み。 |

| [記憶整理の活動表示](../spec/.archived/memory-activity-indicator-design-2026-10-25.md) | 現行stewardの活動・エラーAPI固定6件、画面部品12件を再実行して成功。liveは未確認。 |

| [Steward入力重複の比較](../spec/.archived/steward-input-dedup-2026-11-08.md) | [比較記録](../spec/verification/steward-input-dedup-2026-11-08/README.md)で品質未達・不採用・原状復帰を確認。成功した実装とは扱わない。 |
| [Steward入力の反復比較](../spec/.archived/steward-input-repeat-2026-11-08.md) | [反復記録](../spec/verification/steward-input-repeat-2026-11-08/README.md)と利用者の見送り決定を確認。追加実装・再評価は予定しない。 |

| [dots恒久委任](../spec/.archived/dots-permanent-delegation-design-and-plan-2026-10-25.md) | 旧常設relay計画は利用者が撤回し、no-relay方針に置換したため履歴へ移動。停止中の結果の自動回収は別途判断。 |
| [停止した目標の補修](../spec/.archived/goal-idle-stall-repair-2026-11-26.md) | 修正は実装・固定試験済み、残る再設計は後継設計へ統合したため移動。実目標での通し受入は後継設計で未了。 |
| [意図判定](../spec/.archived/intent-gate-design-2026-10-29.md) | 旧方式を履歴に移動。後続のlocalハーネス再構築 §11.2で旧ループ・5分類の使い方を置換し、固定検証した記録がある。 |
| [発言の編集](../spec/.archived/prompt-edit-design-2026-10-24.md) | 実装済みとして移動。2026-11-28に再送のbackend試験10件とWebの編集試験4件が成功。実機器受入は確認していない。 |
| [Agency初期統合スパイク](../spec/.archived/agency-integration-spike-design-2026-10-22.md) | 旧設計を会話エージェント置換設計で改訂したと本文に明記。後継の未受入は別途保持。 |
| [subproject未参照コード調査](../spec/.archived/subproject-dead-code-audit-2026-11-03.md) | 調査完了。後続の実装記録でA1〜A5の整理とB1・B2の共通化、検証を確認。 |
| [Kanban実装分担](../spec/.archived/kanban-implementation-assignments-2026-10-14.md) | 当時の分担と固定契約の履歴。現状は元計画と検証記録が正本で、実LARMの自然言語受入は未実施。 |
| [再起動後の仕事継続](../spec/.archived/restart-continuation-design-2026-10-31.md) | 利用者が2026-10-31に旧案を実施しないと決定。後日の目標別再開の設計とは分けて履歴に保管。 |

| [目標結果を依頼に統一](../spec/.archived/goal-results-as-assignments-2026-11-26.md) | 利用者合意・実装・固定試験済みとして移動。実稼働での受入は未確認。 |
| [目標の思考回数制限](../spec/.archived/goal-thought-budget-2026-11-26.md) | 利用者合意・実装・固定試験済みとして移動。実稼働での受入は未確認。 |
| [目標の単一思考セッション](../spec/.archived/goal-thought-session-2026-11-26.md) | 利用者合意・実装・固定試験済みとして移動。実稼働での受入は未確認。 |

| [背景画像](../spec/.archived/avatar-backdrop-image-2026-11-23.md) | 実装・fixture済みとして移動。初回画像の設定と実画面確認は未実施。 |
| [Claude Code完了改善](../spec/.archived/claude-code-completion-improvement-2026-11-23.md) | 実装・固定試験済みとして移動。実CLI・実モデル・実ブラウザーでの通し受入は未実施。 |
| [音楽出力境界](../spec/.archived/music-audio-output-boundary-2026-10-31.md) | 調査と規則の記録が完了。原因不明の音の発生源は未特定であり、障害解消を意味しない。 |

| [Spatial準備状態と色](../spec/.archived/spatial-readiness-and-status-colors-2026-10-31.md) | 現行の準備状態・状態色・描画の固定試験を2026-11-28に再実行し成功。実画面の受入は未確認。 |
| [Spatial状態表示](../spec/.archived/spatial-status-display-fix-2026-10-31.md) | 現行の時刻・stale・詳細表示の固定試験を2026-11-28に再実行し成功。実画面の受入は未確認。 |

| [記憶の直接curation](../spec/.archived/memory-direct-curation-2026-11-23.md) | 利用者合意・実装・fixture済みとして移動。実稼働後の記録集計は未確認。 |
| [担当の初回利用時起動](../spec/.archived/toolchain-on-demand-startup-design-2026-11-26.md) | 実装・隔離環境の固定試験済みとして移動。稼働環境の起動時間とブラウザー通しは未確認。 |
| [Pursuitの行動分析計画](../spec/.archived/verification/pursuit-behavior-analysis-2026-11-09/PLAN.md) | 156件の使用量照合、4件の時系列と分析レポートの作成・検算が完了。検証資料は元の場所に保持。 |

| [Markdown一覧・編集](../spec/.archived/markdown-file-browser-ui-design-2026-11-07.md) | Eumenes側実装・固定試験済み。後続の配備後記録でドラッグ移動と一覧フォーカスの実画面受入を確認。最終更新日時の提供・最新列表示の実画面は未確認。 |
| [MarkdownライブラリAPI](../spec/.archived/markdown-library-api-design-2026-11-07.md) | Eumenes側実装・固定試験済み。後続の配備後記録で文書・フォルダー管理と実画面を確認。2026-11-28に更新日時順を含むAPI 18件・Web 15件が成功。100件超の実接続は未確認。 |

| [背景モード](../spec/.archived/background-play-mode-design-2026-10-29.md) | 実装・固定検証済みとして移動。全画面Artifactのボタン分岐の試験と実画面受入は未実施。 |
| [Claude Codeの端末表示](../spec/.archived/claude-code-task-terminal-view-2026-11-25.md) | 実装・固定試験済みとして移動。実画面とrunner反映は未確認。 |
| [CLIツールチェーン](../spec/.archived/cli-toolchain-design-2026-10-24.md) | P0〜P3実装と固定・実PTY検証済みとして移動。P4実LLMとブラウザー受入は未実施。 |
| [専門担当の終了再試行](../spec/.archived/specialist-close-retry-design-2026-11-16.md) | 停止・再試行の実装と合成データの結合検証済み。稼働中2件への適用と確認は別作業。 |

| [会話レビュー修正](../spec/.archived/conversation-review-fixes-2026-10-29.md) | レビュー修正と固定試験を実施。liveは未実施。 |
| [音声活動検出](../spec/.archived/ml-voice-activity-detection-design-2026-10-25.md) | P0〜P2は実装・固定試験済み。ブラウザーのworker実読み込みと実機録音P3は未受入。 |
| [技術評価の修正](../spec/.archived/review-remediation-plan-2026-10-31.md) | A1〜A7・B1〜B7の実施記録と個別検証あり。全体verifyと稼働反映は未実施。 |
| [TTS単一レーン](../spec/.archived/tts-single-lane-design-2026-11-01.md) | S1〜S3は実装・fixture済み。二画面での実機受入は未実施で、音声MVP完成とは扱わない。 |

| [未参照コード削除計画](../spec/.archived/unreferenced-code-cleanup-plan-2026-10-31.md) | C1〜C6の削除と固定検証を実施。別作業の失敗・ブラウザー試験、利用者手元の旧MCP設定削除は残件として区別。 |

| [scratch一時ファイル](../spec/.archived/server-scratch-cache-design-2026-11-07.md) | P1〜P5は実装済み。追加の漏れ修正後、対象927件・Web23件成功。実LARM・稼働画面・実機器の通し受入は未実施。 |

| [Bun更新](../spec/.archived/bun-security-update-preparation-2026-10-26.md) | Bun本体・プロジェクト・CI定義の更新と許可された固定検証済み。CI実行と稼働プロセスへの反映は未確認。 |
| [Codex入力キャッシュ](../spec/.archived/codex-input-cache-structure-2026-11-12.md) | P1〜P4の実装・fixture・CLI通信捕捉済み。P5の実接続受入は未実施。 |
| [会話からの記憶訂正](../spec/.archived/memory-conversation-correction-2026-11-15.md) | 指示・受付の調整と固定70件を検証。実会話・実LLMの訂正受入は未実施。 |
| [Spatial監視頻度](../spec/.archived/spatial-polling-frequency-fix-2026-10-31.md) | 取得周期と重複ログを修正しdomain固定検証済み。稼働環境の確認と別件の音声二重再生は未確認。 |

| [入力コンテキスト閲覧](../spec/.archived/context-window-inspector-design-2026-11-17.md) | Backend・CLI固定101件とWeb固定12件で実装を検証。標準verify、実ブラウザー、応答時間・メモリ実測は未了。 |
| [Spatial銀河採用](../spec/.archived/spatial-monitor-galaxy-adoption-2026-10-18.md) | 色表現の実装・固定検証、途中版の実画面確認済み。明るさ追加後の実画面確認は未実施。 |
| [TTS SQL停止とストリーミング](../spec/.archived/tts-sql-stall-and-streaming-design-2026-10-27.md) | SQL修正・ストリーミング実装と部分・結合固定試験済み。稼働環境のSQL適用、実音声比較、実機器3往復は未実施。音声MVP完成とは扱わない。 |

| [会話から担当を選択](../spec/.archived/conversation-first-toolchain-2026-11-21.md) | 会話主導の担当検索と通常会話からの独立Router撤去は後続の計測記録で確認。確認・TODOの旧契約は依頼項目の後続設計で変更。 |

| [Agency統合](../spec/.archived/agency-integration-2026-11-07.md) | 統合・固定検証と稼働反映を記録。実会話の品質・発話抑止・実機音声は未受入。 |
| [共同作業の状態統合](../spec/.archived/collaboration-state-integration-2026-11-07.md) | 出所付き条件状態の実装・固定検証・実モデルと実Webを記録。副シナリオは完全消去成功ではない。 |
| [Spatial監視接続](../spec/.archived/spatial-monitoring-eumenes-design-2026-10-18.md) | 監視接続と実画面を検証。後続LAN内外判定も2026-11-28に固定16件成功。接続断の色は後続状態色設計で更新。 |

## 照合済み：直下に保持

「未完」は実装がないことに限らず、文書の対象に未実施の段階・条件が残ることを示す。未実施部分や実施状況を確定できない部分の採否は判断していない。

| 文書 | 分類と根拠 |
| --- | --- |
| [always-on統合](../spec/.todo/agency-always-on-integration-plan-2026-11-08.md) | 未完。§10のP5実配送、P6全体検証、P7実モデル受入が残る。 |
| [自律性改善](../spec/.todo/agency-autonomy-improvement-design-2026-11-05.md) | 一部実施。P0だけ受入済み、P1以降未着手。 |
| [P0・P1実装依頼](../spec/.todo/agency-shadow-p0-p1-implementation-request-2026-11-05.md) | 一部実施。P1と実モデル計測が未実施。 |
| [Agency会話担当への置換](../spec/.todo/agency-conversation-agent-design-2026-10-25.md) | 一部実施・後続変更あり。§11.4では多数のdomain fixtureが通過したがapplicationは900件中899件。TODO完了通知などは後続設計で変更され、冒頭は実装中。 |
| [Agency感情](../spec/.todo/agency-emotion-design-2026-10-24.md) | 一部実施。発話・読み上げの感情表現はあるが、通常応答の15種化が未決、設定画面での切替は未追加。 |
| [Agency全行動](../spec/.todo/agency-general-action-design-2026-11-07.md) | 一部実施。固定625件と稼働後の通常会話・判断は成功。ただし最新反映後の新規生成、成果物リンク永続化、調査の報告完了までの全受入は未確認。 |
| [Agenda取込](../spec/.todo/agency-agenda-integration-2026-11-11.md) | 一部実施。agenda取込みと後続修正を記録する一方、Liveへの発話は受付時に数え実際に話されたか未確認。設定変更で約束が消える制約も残る。 |
| [Agenda目標統合](../spec/.todo/agenda-goals-integration-2026-11-21.md) | 一部実施。現行コードに10枠の読取と `agenda-goals` scopeの取扱いがあり、対象scopeを使う固定試験もある。設計・許可・再開など全文書の条件について、この文書に実施結果はなく、後続実装との完全な対応は未確定。 |
| [役割とPursuit](../spec/.archived/agent-roles-and-pursuit-integration-design-2026-11-03.md) | 未実施の設計案。接続方式と段階導入は合意前。 |
| [画面状態と資源調査](../spec/.todo/artifact-state-and-resource-research-design-2026-11-15.md) | 一部実施。常駐判断への配信、選択区間、調査への観測引継ぎ等が将来範囲。 |
| [音声入力セッション](../spec/.todo/asr-input-session-redesign-2026-11-15.md) | 一部実施。Eumenes側は実機確認済み、LARM逐次セッション契約待ち。 |
| [アバター感情アニメーション](../spec/.todo/avatar-emotion-animation-2026-11-12.md) | 一部実施。通常の表示・動作は検証済み、Liveの発話単位の感情適用は上流契約待ち。 |
| [アバター表情の文脈](../spec/.todo/avatar-expression-context-design-2026-10-09.md) | 一部実施。チャンク単位の判断・ヒステリシスは未実装。 |
| [ブラウザー共同作業の継続](../spec/.archived/browser-collaboration-continuation-design-2026-11-12.md) | 一部実施。タブ引継ぎ・原文取得・音声再生の実受入は成功。ただし別のURL指定は3回失敗し、撮影画像のラベル再確認も失敗。 |
| [ブラウザー進捗画面](../spec/.todo/browser-script-progress-ui-design-2026-10-20.md) | 未完。固定試験済みだがBrave・実LLM・音声受入は未実施と明記。 |
| [サービス内検索](../spec/.todo/browser-service-search-design-2026-10-21.md) | 未完。実ブラウザー受入中、追加の修正と結果を検証記録で追う必要あり。 |
| [ブラウザータブ担当](../spec/.todo/browser-tabs-toolchain-design-2026-10-18.md) | 一部実施・後続追加あり。冒頭は共通核の固定試験済み・S0〜S2実装中と記載。後続の実タブ操作記録はあるが、全段階・受入との対応を確定できない。 |
| [Canvas改善](../spec/.todo/canvas-app-improvement-plan-2026-11-23.md) | 一部実施。改善・固定検証済み、保持方針とArtifact正式gateが残る。 |
| [Canvas統合](../spec/.todo/canvas-app-integration-2026-11-12.md) | 一部実施。描画・画面操作まで実受入した後、受付票の不具合を修正。修正後の会話通しは未確認。 |
| [Claude Code専任担当](../spec/.todo/claude-code-managed-task-design-2026-11-15.md) | 一部実施。主要経路の固定試験済み。複数選択、個別承認、独立package、イベント期限削除、停止未確認後の引継ぎは今後の実装対象で、認証済み隔離環境の受入も未確認。 |
| [クラウド画像入力](../spec/.todo/cloud-image-input-implementation-plan-2026-11-07.md) | 一部実施。§11では稼働Webからの画像送信・実モデル回答・再読込が成功。一方、能力を公開しない他の接続方式の有効化と全体gateはチェック未完了。 |
| [Codex SDK仕事・画面](../spec/.todo/codex-sdk-task-artifact-plan-2026-10-14.md) | 未完。P5と実API復元・通し等の記録が残る。 |
| [Codex再起動後の再開](../spec/.todo/codex-thread-resume-after-restart-2026-11-17.md) | 未実施の提案。停止中に記録を保持する方針が未決。 |
| [共同作業の評価](../spec/.archived/collaboration-evaluator-design-2026-11-12.md) | 一部実施。実モデルの下書き修正が契約不一致で失敗し、別版の評価と稼働画面の受入は未確認。 |
| [共同作業の後続設計](../spec/.archived/collaboration-followup-design-2026-11-05.md) | 一部実施。下書きと子操作連携を実装。一般化、通常候補への有効化、稼働サーバーでの受入は完了扱いに含めないと明記。 |
| [完了音声の重複](../spec/.todo/completion-audio-duplication-2026-10-31.md) | 未完。TTS対象漏れは補修したが、二重再生の発生元の特定・根本修正・同条件受入は未完了。 |
| [CPU計算統合](../spec/.todo/compute-cpu-integration-design-2026-10-21.md) | 一部実施。実CPU計算と表示は確認、親会話の最終文が形式エラーで失敗し通し受入は未完。 |
| [ContextWindow構成](../spec/context-window-layout-spec-2026-10-25.md) | 一部実施・現行参照。fixture済み、liveは一部のみ、実機器未実施。agencyの台帳番号を受け取る改修は未着手と記載。 |
| [ContextWindow仕様](../spec/context-window-spec-2026-10-24.md) | 現行仕様・一部未実施。索引には未実装の検査等が列挙され、後続設計の置換範囲もある。 |
| [会話の性能改善](../spec/.todo/conversation-agent-performance-improvement-plan-2026-11-21.md) | 一部実施。計測準備とCodex追記の固定試験は実施したが、各工程の同条件比較・速度と判断品質の完了条件は未確認。 |
| [会話のトークン効率・負債](../spec/.todo/conversation-agent-token-efficiency-and-debt-plan-2026-11-22.md) | 一部実施。複数項目の実装記録がある一方、live計測や設計変更候補が残る。 |
| [会話のキャッシュ・圧縮](../spec/.todo/conversation-cache-compaction-and-history-design-2026-11-22.md) | 一部実施。Phase 1〜3とCLI liveの記録あり。ただし追試9ターン中2件が失敗し、先行要約の採用と例外詳細は未確認。実機器も未受入。 |
| [会話デバッグ診断](../spec/.todo/conversation-debug-diagnostics-implementation-plan-2026-11-15.md) | 未実施の計画。導入の実施記録を確認できず、既存診断と同一と判断できない。 |
| [会話ハーネス](../spec/.archived/conversation-harness-design-2026-10-28.md) | 一部実施・後続設計へ移行。localの判断方式は後続の再構築と会話主導方式で変更されたが、文書全体の各条件の完了は確認できない。 |
| [会話入力仕様](../spec/conversation-input-spec-2026-10-26.md) | 一部実施・現行参照。fixture済みだがP0のlive測定・評価再実行は未実施と記載。入力順や圧縮は後続設計で変更されている。 |
| [会話の読取りツール](../spec/.todo/conversation-read-tools-design-2026-10-31.md) | 一部実施。R1〜R3と履歴担当は固定検証済み。§7.1にR4のWorld読取り口、反映後の検索・live測定が未実施と明記。 |
| [会話サブエージェント整理](../spec/.todo/conversation-subagent-llm-refactoring-plan-2026-10-17.md) | 一部実施。P2・P3はfixture済み、D項目とP1・P4・P5は未了。 |
| [ツール呼出しの安定化](../spec/.todo/conversation-toolcall-reliability-design-2026-10-27.md) | 一部実施・一部撤回。P1・P2はfixture済みで、順序案の一部は利用者判断で撤回。会話入力と呼出し方式は後続設計で変更された。 |
| [会話からの仕事引継ぎ](../spec/.todo/conversation-work-handoff-design-2026-11-23.md) | 未実施の設計案。合意前で、現行の訂正試験にも失敗が残る。 |
| [判断モデル比較](../spec/.todo/decision-model-benchmark-design.md) | 一部実施。初版CLI・集計はあるが、実時間保持・GPU/NPU・bootstrap等が未実装。 |
| [開発監督](../spec/.todo/development-supervisor-design-2026-11-22.md) | 一部実施。初版の実編集と隔離検証を§7に記録。後続の登録目標・Claude実行設計にも変更があり、最新版の実目標受入は未完了。 |
| [Docling Desk接続](../spec/.todo/docling-desk-integration-design-2026-10-25.md) | 未完。修正済み上流版の配備・実接続再受入と全体gateが未了。 |
| [LARM後続計画](../spec/.todo/eumenes-larm-followup-plan-2026-10-24.md) | 一部実施。A〜CとD切分けは完了、通常配置の受入と接続寿命の追加設計が保留。 |
| [Eumenes Toolchain MCP](../spec/.todo/eumenes-toolchain-mcp-plan-2026-11-26.md) | 未実施の計画案。製品実装・固定試験・liveは未実施と明記。 |
| [日常作業担当](../spec/.archived/everyday-task-agent-implementation-plan-2026-10-21.md) | 未完。P0〜P5は固定試験済み、P6実モデル受入不合格で公開を取り下げた。 |
| [日常作業の進行契約](../spec/.archived/everyday-task-agent-progress-contract-proposal-2026-10-21.md) | 一部実施。固定検証済みだが実モデル受入未達で有効化しない。 |
| [外部アプリ共通契約](../spec/.archived/external-apps-artifacts-implementation-plan-2026-10-09.md) | 未実施の草案。個別Artifactの実装を汎用契約の完成と混同しない。 |
| [生成画像・音楽の会話への配達](../spec/.todo/generated-media-delivery-design-2026-11-15.md) | 一部実施。段階1・2は記録済み、音声ファイルの受口と音の分析（段階3・4）は計画。 |
| [目標の待機中思考](../spec/.todo/goal-idle-deliberation-redesign-2026-11-26.md) | 一部実施・進行中差分。§9に最終周の読取口が未実装とあり、思考方式の一部は後続で置換。 |
| [改善計画1：会話・Pipeline](../spec/.todo/grok-improvement-plan-1-dialogue-pipeline-2026-11-17.md) | 一部実施。[検証記録](../spec/verification/grok-plan-1-dialogue-pipeline-2026-11-17.md)では1-01・1-02を確認し、1-03以降の多くの評価・修正、domain検証、liveが未実施。 |
| [改善計画2：状態・復旧](../spec/.todo/grok-improvement-plan-2-state-recovery-2026-11-17.md) | 一部実施。[検証記録](../spec/verification/grok-plan-2-state-recovery-2026-11-17.md)では2-01・02の既存差分を検証し、2-04・10を修正。2-03・07〜09・11・13〜19等は未実施または未実装。 |
| [改善計画3：Web・音声・検証](../spec/.todo/grok-improvement-plan-3-web-voice-verification-2026-11-17.md) | 一部実施。[検証記録](../spec/verification/grok-plan-3-web-voice-verification-2026-11-17.md)では初回JSを削減したが当時の上限に未達。複数項目の評価、統合検証、音声実機3往復は未実施。 |
| [ハーネスの自己改善](../spec/.todo/harness-self-improvement-design-2026-10-31.md) | 一部実施・将来案あり。自動起票と台帳は採用せず、依頼時に起動する修正担当を実装・固定試験。実Claude Codeのlive・自然言語受入は未実施。 |
| [旧改善計画 第2版](../spec/.todo/improvement-plan-2026-10-10-r2.md) | 一部実施。FE-4、VO-16、DT-11等が当時未着手、CIは保留。現在の後続実装と突き合わせる。 |
| [旧改善計画 初版](../spec/.archived/improvement-plan-2026-10-10.md) | 第2版へ残件移管済み。本文は第2版未完のため保持する方針を明記。 |
| [3Dモデル生成](../spec/.todo/instant-3d-model-toolchain-design-2026-10-18.md) | 一部実施。実装・固定試験済みだが実LARM・実アップロード・Googleフォト取込・実モデル会話受入は未実施。 |
| [KanbanとClaude Code](../spec/.todo/kanban-claude-code-plan-2026-10-14.md) | 一部実施。P1〜P3は固定検証済み、P4の実LARM自然言語等の受入は未実施。 |
| [ASR逐次契約依頼](../spec/.todo/larm-asr-streaming-contract-request-2026-11-15.md) | 未実施の外部契約提案。承認済み依頼書で、送信・実装は未実施。 |
| [LARM空き待ち](../spec/.todo/larm-capacity-wait-design-2026-11-01.md) | 一部実施。各domainの固定検証は成功したがT7・T8の専用試験、live・実機器受入は未了。 |
| [LARM接続キャッシュ](../spec/.todo/larm-connection-cache-design-2026-10-25.md) | 一部実施。Q1・Q2は実装済み、Q3は未着手と記載。 |
| [埋込み索引移行](../spec/.todo/larm-embedding-index-migration-2026-11-21.md) | 一部実施。固定・隔離環境の実LARM検索を検証し5件1位。ただし標準検証は既存の3件失敗等で完了せず、作業範囲は隔離環境までと記載。 |
| [LARMメイン接続再利用](../spec/.todo/larm-main-reuse-fix-2026-11-01.md) | 一部実施。[受入記録](../spec/verification/larm-main-reuse-2026-11-01/acceptance.md)で固定検証とASR/TTS実接続を確認。新メインの生成はpending、当時の稼働backendは未反映。 |
| [LARM prompt cache依頼文](../spec/.todo/larm-prompt-cache-request-prompt-2026-10-22.md) | 外部依頼・一部改善。新版の実接続では約14,000 tokenの対照入力で補助要求後も再利用できた。一方、通常配置では後方systemの欠落と初期判断のcache 0が残り、依頼全体の完了とは判定しない。 |
| [LARM Router依頼文](../spec/.archived/larm-router-request-prompt-2026-11-01.md) | 外部依頼資料。依頼先のRouter profileは後続設計で作業中と記録され、その後、独立Routerを撤去する会話主導方式に変更。外部側の受領・実施は未確認。 |
| [LARM空間監視](../spec/.todo/larm-spatial-monitoring-integration-design-2026-10-18.md) | 一部実施。本体の固定応答検証済み、本番API公開と実画面が未完。 |
| [LARM音声ready依頼文](../spec/.todo/larm-voice-connection-ready-request-prompt-2026-10-25.md) | 外部依頼資料。Eumenes側ではProvider別ready対応と本番API確認を完了したが、依頼先LARM側の原因調査・修正の完了はこの資料から確認できない。 |
| [Live音声](../spec/.todo/live-voice-design-2026-10-31.md) | 未完。製品実装と固定検証あり、本人機器での3往復を含む音声MVP受入は未完。 |
| [候補1位への誘導](../spec/.archived/local-choice-top-candidate-design-2026-10-31.md) | 未合意の案。一部不具合修正のみ実施、提案全体の採否は未決。 |
| [ローカル文脈の予算](../spec/.archived/local-context-budget-design-2026-10-29.md) | 一部実施。§4.3のみfixture済み、他は合意待ち。 |
| [ローカルハーネス再構築](../spec/.archived/local-harness-rebuild-plan-2026-10-30.md) | 一部実施。P0〜P2・切替と固定試験は完了。P3の測定、しきい値変更の判断、修正後のlive・実機器確認は未実施。 |
| [ローカルレビュー取込](../spec/.todo/local-review-intake-plan-2026-10-30.md) | 一部実施。Q1〜Q4の固定検証記録あり、Q5のlive測定と実機は未実施。 |
| [Markdown共同編集フルbundle](../spec/.todo/markdown-collaboration-full-bundle-design-2026-11-07.md) | 未完。構築中・Docling保存を優先し、受入までを残す。 |
| [MarkdownとLARM文書](../spec/.todo/markdown-larm-documents-integration-2026-11-07.md) | 一部実施。[検証記録](../spec/verification/markdown-larm-documents-2026-11-07/README.md)で実LARM保存・読戻しは確認、競合ダイアログ操作の完了は未観測。 |
| [記憶の層の再設計](../spec/.todo/memory-architecture-redesign-2026-11-22.md) | 一部実施・部分的に後続変更。実装・fixtureの記録があるが、睡眠の層は直接curation設計で取り消し。基準計測は途中でサーバー停止し126件が接続失敗。 |
| [記憶想起の実装](../spec/.archived/memory-recall-implementation-2026-11-23.md) | 一部実施・部分的に後続取消。fixtureと本番整理済み、live評価は利用者判断で行わない。Recall区画・類似記録・冪等鍵は直接curationで取消。 |
| [記憶想起の改善案](../spec/.archived/memory-recall-improvement-2026-11-23.md) | 一部実施・後続変更。§9の推奨は後続実装設計で利用者が承認したが、Recall区画・類似記録・冪等鍵はさらに後続設計で取消。全項目の現在の適用状況は未確定。 |
| [3D命令の準備](../spec/.todo/model3d-command-readiness-fix-2026-10-31.md) | 一部実施。domain検証は成功、実LARM依頼はwaiting_gpuからの完成・GLB取得未確認。 |
| [物体認識の独自学習](../spec/.archived/object-recognition-custom-training-concept-2026-10-18.md) | 未実施の構想。現時点の着手予定なし。 |
| [物体認識の対象・引継ぎ](../spec/.todo/object-recognition-targets-and-llm-handoff-design-2026-10-18.md) | 一部実施。対象指定は上流対応待ち、§5.3はfixture済み。 |
| [OCR補正・範囲・QR](../spec/.todo/ocr-correction-region-qr-design-2026-10-25.md) | 一部実施。固定・ブラウザー検証あり、実LLMの補正品質受入は未達。 |
| [Pipeline強化](../spec/.todo/pipeline-0.1.0-hardening-2026-11-06.md) | 一部実施。[実モデル記録](../spec/verification/pipeline-0.1.0-2026-11-06/live/README.md)ではPipelineに届いた1題材で子2件が完了。一方、通常の複数依頼の選択は未達で、計算した値を会話に届けない問題も残った。 |
| [全体課題](../spec/project-issues-2026-11-06.md) | 継続管理の一覧。複数の未完課題を含む。 |
| [全体課題の第1段](../spec/.todo/project-issues-first-batch-2026-11-06.md) | 一部実施。EUM001・002・004の意味品質受入が未完、EUM003追加案は撤回。 |
| [登録目標の自律実行](../spec/.todo/registered-goal-autonomy-2026-11-23.md) | 一部実施。初期の隔離実モデル通しは成功したが、後続補修後の実目標Live2D受入は未完了と検証記録に明記。 |
| [登録目標の実装手順](../spec/.todo/registered-goal-autonomy-implementation-2026-11-23.md) | 一部実施。段階別固定検証と初期の隔離実モデル通しは成功。後続補修後の実目標受入は検証記録上未完了。 |
| [登録目標の能力選択](../spec/.todo/registered-goal-capability-selection-2026-11-23.md) | 一部実施。正式検証済みだが補修版の実稼働再受入待ち。 |
| [登録目標のClaude実行](../spec/.todo/registered-goal-claude-execution-2026-11-26.md) | 一部実施。固定・結合と隔離Live2D検証は成功、稼働環境の独立検証2回は未確認。後続補修の固定検証後、既存目標の実runner受入は未確認。 |
| [調査失敗と先読み](../spec/.todo/research-failure-reply-and-readahead-2026-10-17.md) | 一部実施。fixture済みだが古い登録文面の相違と、調査失敗時の音声読み上げの実機確認が残る。 |
| [調査経路の後続案](../spec/.archived/research-routing-followup-design-2026-11-08.md) | 未合意・未実装の追加案。 |
| [調査経路の性能](../spec/.todo/research-routing-performance-2026-11-08.md) | 一部実施。固定試験・実接続検証の結果、自然文取消と報告品質が未達。 |
| [リソースURI](../spec/.todo/resource-uri-implementation-plan-2026-10-25.md) | 一部実施。P0〜P6の固定試験はあるが、一部削除・固定タブ登録とP7が未実施。 |
| [REST統一標準](../spec/.archived/rest-unified-standard-2026-10-27.md) | 未合意の案。現行実装への適用は未着手と記載。 |
| [再利用可能な制作](../spec/.todo/reusable-content-workflows-design-2026-11-09.md) | 一部実施。Web本文等の固定試験済み、実モデルの生成時間と結果確認が残る。 |
| [取消対象の構造解析](../spec/.archived/router-cancellation-structure-design-2026-11-06.md) | 一部実施。EUM002の固定実装済みだが実モデル受入は継続。 |
| [Routerパッケージ統合](../spec/.archived/router-package-integration-2026-11-04.md) | 一部実施・後続方式へ変更。固定・実モデル検証の記録あり。独立Routerは会話主導方式で撤去対象となり、旧設計全体の現行適用は確認できない。 |
| [runエラー報告](../spec/.todo/run-error-report-design-2026-10-17.md) | 一部実施。2026-11-28にAPIとCLIの固定・結合16件が成功。一方、設計のbuild commit hash表示は本文に未掲載と記録され、現行の組立コードにも確認できない。実機確認も未実施。 |
| [評価点改善計画](../spec/.todo/score-improvement-plan-2026-10-31.md) | 一部実施。音声実機受入・性能live測定等は未実施、再起動継続案は実施しないと決定。 |
| [Skillによるレビュー](../spec/.todo/skill-based-review-design-2026-11-14.md) | 一部実施。実モデルの評価は2回とも期限内に完了せず、稼働画面の受入も未確認。 |
| [Spatialモデル目録](../spec/spatial-model-catalog-2026-10-18.md) | 一部合意。アニメーションの周期・位相は未制作・未実装。 |
| [専門担当の評価](../spec/.todo/specialist-evaluator-design-2026-11-13.md) | 提案・一部方針のみ合意。PursuitとCollaborationの廃案およびEvaluator任意利用は利用者方針だが、後継構成・移行順・評価範囲は合意前。 |
| [サブエージェントの接続選択](../spec/.todo/subagent-selected-llm-fix-2026-10-31.md) | 一部実施。推論経路は実接続で成功したがLive音声出力はなく、追加のブラウザー確認も接続失敗と未確認内容の補完があり成功とは扱えない。 |
| [担当の二つの型](../spec/.todo/subagent-task-and-session-agents-design-2026-10-18.md) | 一部実施。P0〜P2の固定試験済み、P3とP4は未実装と記載。 |
| [テスト品質の候補](../spec/.todo/test-quality-improvement-options-2026-10-15.md) | 未導入の将来候補。Replay・property試験・JiTTestなど。 |
| [依頼を調べものと同じ流れに](../spec/.todo/toolchain-assignment-as-research-2026-11-25.md) | 一部実施。第1・2段と修復の固定試験済み。全体スイート・独立レビュー、実モデル・実Claude Code・実LARM・画面・実機器の確認は未実施。 |
| [依頼経路の第2段](../spec/.todo/toolchain-assignment-stage2-implementation-2026-11-25.md) | 一部実施。親設計に第2段の実装・domain別fixtureを記録。全体スイート・独立レビューとlive・実画面・実機器受入は未実施。 |
| [担当Router再設計](../spec/.archived/toolchain-router-redesign-2026-11-01.md) | 一部実施・後続変更。§12ではR3の一部とR4・R5が未実装。後続の会話主導方式は独立Routerを撤去する方針。 |
| [担当検索と選択](../spec/.todo/toolchain-search-choice-design-2026-10-30.md) | 一部実施。段階1・2は実装、予約とブラウザー汎用担当・パイプラインの段階3・4は本文で未実装。後続の各機能と元の全条件が同一かは未確定。 |
| [担当の時間上限](../spec/.todo/toolchain-time-limits-design-2026-10-18.md) | 一部実施。実装・fixture済みとあるがT7・T8の専用試験とlive・実機器は未了。 |
| [TTS初動待ち](../spec/.todo/tts-ack-latency-2026-11-15.md) | 未完。初回待ちとレビュー指摘が残り、個別変更の結果は別に記録。 |
| [TTS句ごとの先行再生](../spec/.todo/tts-async-clause-playback-2026-11-15.md) | 一部実施。固定と文字・音声入力の実測済み、遅延改善と本人機器3往復は未完。 |
| [一時的なユーザー状態](../spec/.todo/user-condition-implementation-plan-2026-10-24.md) | 未実施の保留計画。実装・試験は未着手。 |
| [音声の補修](../spec/.todo/voice-repair-work-record-2026-10-25.md) | 一部実施。関連domainの固定検証済みだが、15秒超のコールド起動成功と実機器3往復は未確認。 |
| [Webアプリ見本](../spec/.todo/web-app-samples-design-2026-11-10.md) | 計画・着手時検証失敗。週間予報の実モデル試行は応答形式・時間切れ・担当利用不可で下書きの仕様検査に到達せず、4見本の完了は確認できない。 |
| [Webアプリ担当の改善](../spec/.todo/web-app-toolchain-improvement-plan-2026-11-23.md) | 未完。W11安定化と必須9件の自然文受入は未完了。 |
| [Web取得・キャッシュ](../spec/.todo/web-research-cache-implementation-plan-2026-10-09.md) | 一部実施。後続の調査経路はあるが、M1/M2等は当時未実装。 |

## 元から保管されていた文書の注意点

これらは今回の作業前から `.archived/` に存在した。過去の配置を変えず、未実施の内容を実装済みと扱わないように記録する。今後扱うかどうかは未実施計画の次ラウンドで判断する。

| 文書 | 内容と留保 |
| --- | --- |
| [テスト環境移行](../spec/.archived/test-environment-migration-plan-2026-10-14.md) | 初回A・B・Mの実装と継続検証を記録。自動選択、snapshot、CI分割は後続であり、当時の全件合格サンプルも未取得。 |
| [タイマーのデータドリブン設計](../spec/.archived/timer-data-driven-ui-acceptance-design-2026-10-13.md) | この文書の冒頭は実装前の記載。後続の契約書で実装・固定試験を記録しているが、自然言語pilotは未合格。 |
| [設定のデータドリブン化](../spec/.archived/settings-data-driven-design-2026-10-14.md) | 冒頭のP2〜P4未着手は作成時点の状態。本文後半に各移行の追記があり、実接続の確認は別扱い。 |
| [独立MemorySystemの段階的接続](../spec/.archived/memory-system-incremental-adoption-concept.md) | E1・E2の接続は実施。自動抽出は未接続のままで、後続のMemory・記憶担当設計を参照する。 |
| [旧Web検索の目標](../spec/.archived/web-search-target-2026-10-11.md) | 当時のG5〜G10・G14・G15の実装記録はあるが、実LLM再受入は未実施。検索経路は後続方式へ移行している。 |
| [サービス試用の設計](../spec/.archived/provider-playground-design-2026-10-09.md) | 文書自体は実装前の設計。後続の[検証記録](../spec/verification/service-tests/README.md)に実装・試験を記録し、実機音声受入とは区別する。 |

## 委任コーディング計画の下位文書

| 文書 | 分類 |
| --- | --- |
| [全体計画](../spec/.archived/delegated-coding-implementation-2026-10-09/README.md) | 01はarchive済み。旧02・03は利用者決定で中止・削除。04・05・07に当時の未実施事項が残る。 |
| [04 会話と報告](../spec/.archived/delegated-coding-implementation-2026-10-09/04-conversation-and-reports.md) | 一部実施。旧方式の報告DTO等のみで会話受付・配送・音声は未実装。新しい依頼項目への移管範囲は次ラウンドで判断。 |
| [05 タスクモーダル](../spec/.archived/delegated-coding-implementation-2026-10-09/05-task-modal.md) | 未実施。後続のKanbanは当時のwork_tasks投影ではない。 |
| [06 観測契約](../spec/.archived/delegated-coding-implementation-2026-10-09/06-agent-observation-contract.md) | 旧監督方式のfixtureは当時済み、live等は未実施。旧経路は削除済みのため現在の採否判断が必要。 |
| [06 計画レビュー](../spec/.archived/delegated-coding-implementation-2026-10-09/06-agent-observation-contract-review.md) | 設計レビューの記録。実装検証の代用ではない。 |
| [07 復旧質問](../spec/.archived/delegated-coding-implementation-2026-10-09/07-recovery-question.md) | 未実施の設計案。旧監督方式を前提とするため採否を次ラウンドで判断。 |

## 設計資料の個別確認

| 文書・資料 | 分類 |
| --- | --- |
| [OCR画面の再設計と画像一式](../spec/.archived/design/ocr-2026-10-17-redesign/README.md) | 製品実装・固定試験・配布ビルド・ブラウザー・稼働画面を[検証記録](../spec/verification/ocr-redesign-2026-10-17/README.md)で確認し、画像・プロンプトも一緒に移動。 |
| [旧TODO画面の表示改善と画像一式](../spec/.archived/design/todo-artifact-2026-10-24/implementation.md) | 当時の実装・固定試験の記録。TODO画面は後続の依頼項目設計で廃止されたため、画像を含めて旧記録として移動。 |
| [旧Pipeline資料受渡しモーダル](../spec/.archived/design/pipeline-studio-2026-10-22/handoff-modal-design.md) | 実装・固定・ブラウザー受入済み。別の未実装画像案は元フォルダーに保持。 |
| [旧Pipeline制作画面案](../spec/.archived/design/pipeline-studio-2026-10-22/README.md) | 当時未実装の画像案。旧制作画面は後続のPipeline方式で廃止されたため、画像・プロンプトとともに履歴へ移動。 |
| [物体認識画面案](../spec/design/object-recognition-2026-10-14/README.md) | 画面案・対応する画像資料。機能の実装完了を画像だけで判定しない。 |
| [予約アジェンダ画面案](../spec/design/scheduler-agenda-2026-11-09/README.md) | 画面案。READMEはscheduler.pending@2へ配置を反映したと記録し、bundleにも登録がある。描画試験・全表示条件の受入結果は確認できない。 |
| [設定追加画面見本](../spec/design/settings-missing-mockups-2026-10-14/README.md) | 3画面の見本画像と生成資料。登録bundle・各domainが仕様の正本。 |
| [設定画面見本](../spec/design/settings-openui-2026-10-12/README.md) | 画像資料。当時の製品移行状況は未実装と記載。後続のデータドリブン設定への移行と区別する。 |
| [予約・委任画面のレビュー](../spec/design/settings-openui-2026-10-12/management-screen-review.md) | 調査レビュー。ロックで当時の試験が未実行と明記。 |
| [動画生成の画面案](../spec/.archived/design/video-generation-2026-11-14/embedded-design.md) | [実装済み動画設計](../spec/.archived/video-generation-2026-11-14.md)が承認画面案の実装を明記。関連する画像・プロンプト10点も一緒に移動。 |
| [計算画面の画像案](../spec/assets/compute-ui-2026-10-21/README.md) | v2の履歴レイアウトは反映、未接続時の入口改善は対象外と記録。 |
