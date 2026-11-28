# 今後取り組む計画・残件

2026-11-28の整理。実装済みの部分をやり直すのではなく、各行に示した未実施・未受入を今後取り組む対象とする。ここに置いたことは、未合意の設計や新仕様への実装許可を意味しない。重複する計画は同じ問題の参照として扱い、着手前に現行コード・後続仕様・検証結果を照合する。

- 音声は固定試験・live・本人機器の受入を分け、実機器3往復までMVP完成としない。
- 外部依頼の文書を置いたことは、別チャットや外部サービスへの送信指示ではない。
- 大きな設計変更や、合意されていない案は、実装前に現行設計と合わせて合意する。

## 取り組む順序の推奨

1. 既存の作業が止まる・誤取消しする・結果が届かない問題と、登録目標の受入を優先する。[現行方式で引き継ぐ目的](current-continuity-and-safety.md)・[登録目標](registered-goal-autonomy-2026-11-23.md)
2. 音声の重複・遅延と本人機器での受入、文書保存など既存利用の品質を確認する。[音声の重複](completion-audio-duplication-2026-10-31.md)・[音声MVP](live-voice-design-2026-10-31.md)・[文書保存](markdown-larm-documents-integration-2026-11-07.md)
3. 新しい仕組みや保留案、性能・保守改善は、既存機能の未達と切り分けて検討する。複数の計画が同じ課題を指す場合は一件として扱う。

[やらない旧案と判断根拠](../../reports/spec-triage-2026-11-28.md)

## Agency・目標・記憶

| 計画 | 残ること・制約 |
| --- | --- |
| [always-on統合](agency-always-on-integration-plan-2026-11-08.md) | 未完。§10のP5実配送、P6全体検証、P7実モデル受入が残る。 |
| [自律性改善](agency-autonomy-improvement-design-2026-11-05.md) | 一部実施。P0だけ受入済み、P1以降未着手。 |
| [P0・P1実装依頼](agency-shadow-p0-p1-implementation-request-2026-11-05.md) | 一部実施。P1と実モデル計測が未実施。 |
| [Agency会話担当への置換](agency-conversation-agent-design-2026-10-25.md) | 一部実施・後続変更あり。§11.4では多数のdomain fixtureが通過したがapplicationは900件中899件。TODO完了通知などは後続設計で変更され、冒頭は実装中。 |
| [Agency全行動](agency-general-action-design-2026-11-07.md) | 一部実施。固定625件と稼働後の通常会話・判断は成功。ただし最新反映後の新規生成、成果物リンク永続化、調査の報告完了までの全受入は未確認。 |
| [Agenda取込](agency-agenda-integration-2026-11-11.md) | 一部実施。agenda取込みと後続修正を記録する一方、Liveへの発話は受付時に数え実際に話されたか未確認。設定変更で約束が消える制約も残る。 |
| [Agenda目標統合](agenda-goals-integration-2026-11-21.md) | 一部実施。現行コードに10枠の読取と `agenda-goals` scopeの取扱いがあり、対象scopeを使う固定試験もある。設計・許可・再開など全文書の条件について、この文書に実施結果はなく、後続実装との完全な対応は未確定。 |
| [目標の待機中思考](goal-idle-deliberation-redesign-2026-11-26.md) | 一部実施・進行中差分。§9に最終周の読取口が未実装とあり、思考方式の一部は後続で置換。 |
| [記憶の層の再設計](memory-architecture-redesign-2026-11-22.md) | 一部実施・部分的に後続変更。実装・fixtureの記録があるが、睡眠の層は直接curation設計で取り消し。基準計測は途中でサーバー停止し126件が接続失敗。 |
| [登録目標の自律実行](registered-goal-autonomy-2026-11-23.md) | 一部実施。初期の隔離実モデル通しは成功したが、後続補修後の実目標Live2D受入は未完了と検証記録に明記。 |
| [登録目標の実装手順](registered-goal-autonomy-implementation-2026-11-23.md) | 一部実施。段階別固定検証と初期の隔離実モデル通しは成功。後続補修後の実目標受入は検証記録上未完了。 |
| [登録目標の能力選択](registered-goal-capability-selection-2026-11-23.md) | 一部実施。正式検証済みだが補修版の実稼働再受入待ち。 |
| [登録目標のClaude実行](registered-goal-claude-execution-2026-11-26.md) | 一部実施。固定・結合と隔離Live2D検証は成功、稼働環境の独立検証2回は未確認。後続補修の固定検証後、既存目標の実runner受入は未確認。 |

## 音声・アバター

| 計画 | 残ること・制約 |
| --- | --- |
| [Agency感情](agency-emotion-design-2026-10-24.md) | 一部実施。発話・読み上げの感情表現はあるが、通常応答の15種化が未決、設定画面での切替は未追加。 |
| [音声入力セッション](asr-input-session-redesign-2026-11-15.md) | 一部実施。Eumenes側は実機確認済み、LARM逐次セッション契約待ち。 |
| [アバター感情アニメーション](avatar-emotion-animation-2026-11-12.md) | 一部実施。通常の表示・動作は検証済み、Liveの発話単位の感情適用は上流契約待ち。 |
| [アバター表情の文脈](avatar-expression-context-design-2026-10-09.md) | 一部実施。チャンク単位の判断・ヒステリシスは未実装。 |
| [完了音声の重複](completion-audio-duplication-2026-10-31.md) | 未完。TTS対象漏れは補修したが、二重再生の発生元の特定・根本修正・同条件受入は未完了。 |
| [改善計画3：Web・音声・検証](grok-improvement-plan-3-web-voice-verification-2026-11-17.md) | 一部実施。検証記録では初回JSを削減したが当時の上限に未達。複数項目の評価、統合検証、音声実機3往復は未実施。 |
| [ASR逐次契約依頼](larm-asr-streaming-contract-request-2026-11-15.md) | 未実施の外部契約提案。承認済み依頼書で、送信・実装は未実施。 |
| [LARM音声ready依頼文](larm-voice-connection-ready-request-prompt-2026-10-25.md) | 外部依頼資料。Eumenes側ではProvider別ready対応と本番API確認を完了したが、依頼先LARM側の原因調査・修正の完了はこの資料から確認できない。 |
| [Live音声](live-voice-design-2026-10-31.md) | 未完。製品実装と固定検証あり、本人機器での3往復を含む音声MVP受入は未完。 |
| [TTS初動待ち](tts-ack-latency-2026-11-15.md) | 未完。初回待ちとレビュー指摘が残り、個別変更の結果は別に記録。 |
| [TTS句ごとの先行再生](tts-async-clause-playback-2026-11-15.md) | 一部実施。固定と文字・音声入力の実測済み、遅延改善と本人機器3往復は未完。 |
| [音声の補修](voice-repair-work-record-2026-10-25.md) | 一部実施。関連domainの固定検証済みだが、15秒超のコールド起動成功と実機器3往復は未確認。 |

## 検索・ブラウザー・共同作業

| 計画 | 残ること・制約 |
| --- | --- |
| [画面状態と資源調査](artifact-state-and-resource-research-design-2026-11-15.md) | 一部実施。常駐判断への配信、選択区間、調査への観測引継ぎ等が将来範囲。 |
| [ブラウザー進捗画面](browser-script-progress-ui-design-2026-10-20.md) | 未完。固定試験済みだがBrave・実LLM・音声受入は未実施と明記。 |
| [サービス内検索](browser-service-search-design-2026-10-21.md) | 未完。実ブラウザー受入中、追加の修正と結果を検証記録で追う必要あり。 |
| [ブラウザータブ担当](browser-tabs-toolchain-design-2026-10-18.md) | 一部実施・後続追加あり。冒頭は共通核の固定試験済み・S0〜S2実装中と記載。後続の実タブ操作記録はあるが、全段階・受入との対応を確定できない。 |
| [改善計画1：会話・Pipeline](grok-improvement-plan-1-dialogue-pipeline-2026-11-17.md) | 一部実施。検証記録では1-01・1-02を確認し、1-03以降の多くの評価・修正、domain検証、liveが未実施。 |
| [Markdown共同編集フルbundle](markdown-collaboration-full-bundle-design-2026-11-07.md) | 未完。構築中・Docling保存を優先し、受入までを残す。 |
| [Pipeline強化](pipeline-0.1.0-hardening-2026-11-06.md) | 一部実施。実モデル記録ではPipelineに届いた1題材で子2件が完了。一方、通常の複数依頼の選択は未達で、計算した値を会話に届けない問題も残った。 |
| [調査失敗と先読み](research-failure-reply-and-readahead-2026-10-17.md) | 一部実施。fixture済みだが古い登録文面の相違と、調査失敗時の音声読み上げの実機確認が残る。 |
| [調査経路の性能](research-routing-performance-2026-11-08.md) | 一部実施。固定試験・実接続検証の結果、自然文取消と報告品質が未達。 |
| [Skillによるレビュー](skill-based-review-design-2026-11-14.md) | 一部実施。実モデルの評価は2回とも期限内に完了せず、稼働画面の受入も未確認。 |
| [専門担当の評価](specialist-evaluator-design-2026-11-13.md) | 提案・一部方針のみ合意。PursuitとCollaborationの廃案およびEvaluator任意利用は利用者方針だが、後継構成・移行順・評価範囲は合意前。 |
| [担当検索と選択](toolchain-search-choice-design-2026-10-30.md) | 一部実施。段階1・2は実装、予約とブラウザー汎用担当・パイプラインの段階3・4は本文で未実装。後続の各機能と元の全条件が同一かは未確定。 |
| [Web取得・キャッシュ](web-research-cache-implementation-plan-2026-10-09.md) | 一部実施。後続の調査経路はあるが、M1/M2等は当時未実装。 |

## 成果物・制作・画像

| 計画 | 残ること・制約 |
| --- | --- |
| [Eumenesの試作環境](instant-project-sandbox-plan-2026-11-28.md) | レビュー用の実装計画。共有依存・プレビュー、Claude Codeによる制作、LARM素材と生成、既存作品の移行と資源計測。実装前。 |
| [Canvas改善](canvas-app-improvement-plan-2026-11-23.md) | 一部実施。改善・固定検証済み、保持方針とArtifact正式gateが残る。 |
| [Canvas統合](canvas-app-integration-2026-11-12.md) | 一部実施。描画・画面操作まで実受入した後、受付票の不具合を修正。修正後の会話通しは未確認。 |
| [Docling Desk接続](docling-desk-integration-design-2026-10-25.md) | 未完。修正済み上流版の配備・実接続再受入と全体gateが未了。 |
| [MarkdownとLARM文書](markdown-larm-documents-integration-2026-11-07.md) | 一部実施。検証記録で実LARM保存・読戻しは確認、競合ダイアログ操作の完了は未観測。 |
| [3D命令の準備](model3d-command-readiness-fix-2026-10-31.md) | 一部実施。domain検証は成功、実LARM依頼はwaiting_gpuからの完成・GLB取得未確認。 |
| [物体認識の対象・引継ぎ](object-recognition-targets-and-llm-handoff-design-2026-10-18.md) | 一部実施。対象指定は上流対応待ち、§5.3はfixture済み。 |
| [OCR補正・範囲・QR](ocr-correction-region-qr-design-2026-10-25.md) | 一部実施。固定・ブラウザー検証あり、実LLMの補正品質受入は未達。 |
| [リソースURI](resource-uri-implementation-plan-2026-10-25.md) | 一部実施。P0〜P6の固定試験はあるが、一部削除・固定タブ登録とP7が未実施。 |
| [再利用可能な制作](reusable-content-workflows-design-2026-11-09.md) | 一部実施。Web本文等の固定試験済み、実モデルの生成時間と結果確認が残る。 |
| [Webアプリ見本](web-app-samples-design-2026-11-10.md) | 計画・着手時検証失敗。週間予報の実モデル試行は応答形式・時間切れ・担当利用不可で下書きの仕様検査に到達せず、4見本の完了は確認できない。 |
| [Webアプリ担当の改善](web-app-toolchain-improvement-plan-2026-11-23.md) | 未完。W11安定化と必須9件の自然文受入は未完了。 |

## 担当・作業の実行

| 計画 | 残ること・制約 |
| --- | --- |
| [Claude Code専任担当](claude-code-managed-task-design-2026-11-15.md) | 一部実施。主要経路の固定試験済み。複数選択、個別承認、独立package、イベント期限削除、停止未確認後の引継ぎは今後の実装対象で、認証済み隔離環境の受入も未確認。 |
| [Codex SDK仕事・画面](codex-sdk-task-artifact-plan-2026-10-14.md) | 未完。P5と実API復元・通し等の記録が残る。 |
| [Codex再起動後の再開](codex-thread-resume-after-restart-2026-11-17.md) | 未実施の提案。停止中に記録を保持する方針が未決。 |
| [開発監督](development-supervisor-design-2026-11-22.md) | 一部実施。初版の実編集と隔離検証を§7に記録。後続の登録目標・Claude実行設計にも変更があり、最新版の実目標受入は未完了。 |
| [KanbanとClaude Code](kanban-claude-code-plan-2026-10-14.md) | 一部実施。P1〜P3は固定検証済み、P4の実LARM自然言語等の受入は未実施。 |
| [依頼を調べものと同じ流れに](toolchain-assignment-as-research-2026-11-25.md) | 一部実施。第1・2段と修復の固定試験済み。全体スイート・独立レビュー、実モデル・実Claude Code・実LARM・画面・実機器の確認は未実施。 |
| [依頼経路の第2段](toolchain-assignment-stage2-implementation-2026-11-25.md) | 一部実施。親設計に第2段の実装・domain別fixtureを記録。全体スイート・独立レビューとlive・実画面・実機器受入は未実施。 |

## 基盤・検証・運用

| 計画 | 残ること・制約 |
| --- | --- |
| [クラウド画像入力](cloud-image-input-implementation-plan-2026-11-07.md) | 一部実施。§11では稼働Webからの画像送信・実モデル回答・再読込が成功。一方、能力を公開しない他の接続方式の有効化と全体gateはチェック未完了。 |
| [CPU計算統合](compute-cpu-integration-design-2026-10-21.md) | 一部実施。実CPU計算と表示は確認、親会話の最終文が形式エラーで失敗し通し受入は未完。 |
| [判断モデル比較](decision-model-benchmark-design.md) | 一部実施。初版CLI・集計はあるが、実時間保持・GPU/NPU・bootstrap等が未実装。 |
| [Eumenes Toolchain MCP](eumenes-toolchain-mcp-plan-2026-11-26.md) | 未実施の計画案。製品実装・固定試験・liveは未実施と明記。 |
| [生成画像・音楽の会話への配達](generated-media-delivery-design-2026-11-15.md) | 一部実施。段階1・2は記録済み、音声ファイルの受口と音の分析（段階3・4）は計画。 |
| [改善計画2：状態・復旧](grok-improvement-plan-2-state-recovery-2026-11-17.md) | 一部実施。検証記録では2-01・02の既存差分を検証し、2-04・10を修正。2-03・07〜09・11・13〜19等は未実施または未実装。 |
| [ハーネスの自己改善](harness-self-improvement-design-2026-10-31.md) | 一部実施・将来案あり。自動起票と台帳は採用せず、依頼時に起動する修正担当を実装・固定試験。実Claude Codeのlive・自然言語受入は未実施。 |
| [旧改善計画 第2版](improvement-plan-2026-10-10-r2.md) | 一部実施。FE-4、VO-16、DT-11等が当時未着手、CIは保留。現在の後続実装と突き合わせる。 |
| [3Dモデル生成](instant-3d-model-toolchain-design-2026-10-18.md) | 一部実施。実装・固定試験済みだが実LARM・実アップロード・Googleフォト取込・実モデル会話受入は未実施。 |
| [ローカルレビュー取込](local-review-intake-plan-2026-10-30.md) | 一部実施。Q1〜Q4の固定検証記録あり、Q5のlive測定と実機は未実施。 |
| [全体課題の第1段](project-issues-first-batch-2026-11-06.md) | 一部実施。EUM001・002・004の意味品質受入が未完、EUM003追加案は撤回。 |
| [runエラー報告](run-error-report-design-2026-10-17.md) | 一部実施。2026-11-28にAPIとCLIの固定・結合16件が成功。一方、設計のbuild commit hash表示は本文に未掲載と記録され、現行の組立コードにも確認できない。実機確認も未実施。 |
| [評価点改善計画](score-improvement-plan-2026-10-31.md) | 一部実施。音声実機受入・性能live測定等は未実施、再起動継続案は実施しないと決定。 |
| [サブエージェントの接続選択](subagent-selected-llm-fix-2026-10-31.md) | 一部実施。推論経路は実接続で成功したがLive音声出力はなく、追加のブラウザー確認も接続失敗と未確認内容の補完があり成功とは扱えない。 |
| [担当の二つの型](subagent-task-and-session-agents-design-2026-10-18.md) | 一部実施。P0〜P2の固定試験済み、P3とP4は未実装と記載。 |
| [テスト品質の候補](test-quality-improvement-options-2026-10-15.md) | 未導入の将来候補。Replay・property試験・JiTTestなど。 |
| [担当の時間上限](toolchain-time-limits-design-2026-10-18.md) | 一部実施。実装・fixture済みとあるがT7・T8の専用試験とlive・実機器は未了。 |
| [一時的なユーザー状態](user-condition-implementation-plan-2026-10-24.md) | 未実施の保留計画。実装・試験は未着手。 |

## 会話・接続・性能

| 計画 | 残ること・制約 |
| --- | --- |
| [会話の性能改善](conversation-agent-performance-improvement-plan-2026-11-21.md) | 一部実施。計測準備とCodex追記の固定試験は実施したが、各工程の同条件比較・速度と判断品質の完了条件は未確認。 |
| [会話のトークン効率・負債](conversation-agent-token-efficiency-and-debt-plan-2026-11-22.md) | 一部実施。複数項目の実装記録がある一方、live計測や設計変更候補が残る。 |
| [会話のキャッシュ・圧縮](conversation-cache-compaction-and-history-design-2026-11-22.md) | 一部実施。Phase 1〜3とCLI liveの記録あり。ただし追試9ターン中2件が失敗し、先行要約の採用と例外詳細は未確認。実機器も未受入。 |
| [会話デバッグ診断](conversation-debug-diagnostics-implementation-plan-2026-11-15.md) | 未実施の計画。導入の実施記録を確認できず、既存診断と同一と判断できない。 |
| [会話の読取りツール](conversation-read-tools-design-2026-10-31.md) | 一部実施。R1〜R3と履歴担当は固定検証済み。§7.1にR4のWorld読取り口、反映後の検索・live測定が未実施と明記。 |
| [会話サブエージェント整理](conversation-subagent-llm-refactoring-plan-2026-10-17.md) | 一部実施。P2・P3はfixture済み、D項目とP1・P4・P5は未了。 |
| [ツール呼出しの安定化](conversation-toolcall-reliability-design-2026-10-27.md) | 一部実施・一部撤回。P1・P2はfixture済みで、順序案の一部は利用者判断で撤回。会話入力と呼出し方式は後続設計で変更された。 |
| [会話からの仕事引継ぎ](conversation-work-handoff-design-2026-11-23.md) | 未実施の設計案。合意前で、現行の訂正試験にも失敗が残る。 |
| [LARM後続計画](eumenes-larm-followup-plan-2026-10-24.md) | 一部実施。A〜CとD切分けは完了、通常配置の受入と接続寿命の追加設計が保留。 |
| [LARM空き待ち](larm-capacity-wait-design-2026-11-01.md) | 一部実施。各domainの固定検証は成功したがT7・T8の専用試験、live・実機器受入は未了。 |
| [LARM接続キャッシュ](larm-connection-cache-design-2026-10-25.md) | 一部実施。Q1・Q2は実装済み、Q3は未着手と記載。 |
| [埋込み索引移行](larm-embedding-index-migration-2026-11-21.md) | 一部実施。固定・隔離環境の実LARM検索を検証し5件1位。ただし標準検証は既存の3件失敗等で完了せず、作業範囲は隔離環境までと記載。 |
| [LARMメイン接続再利用](larm-main-reuse-fix-2026-11-01.md) | 一部実施。受入記録で固定検証とASR/TTS実接続を確認。新メインの生成はpending、当時の稼働backendは未反映。 |
| [LARM prompt cache依頼文](larm-prompt-cache-request-prompt-2026-10-22.md) | 外部依頼・一部改善。新版の実接続では約14,000 tokenの対照入力で補助要求後も再利用できた。一方、通常配置では後方systemの欠落と初期判断のcache 0が残り、依頼全体の完了とは判定しない。 |
| [LARM空間監視](larm-spatial-monitoring-integration-design-2026-10-18.md) | 一部実施。本体の固定応答検証済み、本番API公開と実画面が未完。 |

## 現行仕様に残す未完事項

[現行仕様に残す未完事項](current-reference-gaps.md) は仕様の正本を動かさず、未着手の検証・設計判断を追跡する。

## 現行経路で引き継ぐ利用者の目的

[旧方式から引き継ぐ目的](current-continuity-and-safety.md) は、取り下げた旧Router・旧Collaboration・旧CLI監督を復活させずに確認する項目。
