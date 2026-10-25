# spec 索引

計画書・設計書・検証記録の一覧です。実装済み・検証済み・計画を区別するため、全項目の実装を確認できた計画書だけを [`.archived/`](.archived/) へ移します。

archive の基準: その文書が担当した実装がコードにあり、本文の実施記録で個別検証まで確認できるもの。残りが担当外の全体gate、対象外の実機器、または廃止済みの経路だけなら archive します。文書の対象そのものが未完了の段階として残っているものは、spec/ 直下に残します。

## 進行中・未完了

| 文書 | 状態 |
| --- | --- |
| [docling-desk-integration-design-2026-10-25.md](docling-desk-integration-design-2026-10-25.md) | 別タブの入口を実装。Docling domain検証、固定結合、実モデル選択、実ブラウザのWord/PDF OCR・停止・文書とログイン保持を確認。利用側・全体gateには担当外と共有ファイルの未解決事項あり。[受入記録](verification/docling-desk-2026-10-25/acceptance.md) |
| [resource-uri-implementation-plan-2026-10-25.md](resource-uri-implementation-plan-2026-10-25.md) | 合意済み・P0〜P6 実装・固定試験済み（§13）。live・実機器の受入（P7）とサーバー反映は未実施。Eumenes内のリソース（生成物・TODO・会話の出来事）を `eumenes://<kind>/<id>` で指し、種類の登録＋ResourceAdapter（データドリブン）で開く・再生する・読む・探す。TODOの報告にリンク（`links_json`）を付けて完了報告の吹き出しにチップを出し、agency の `HostTodo` に担当名と `nextActions` を渡す。サブエージェントに `RESOURCES` 区画と説明文、`delegate` の `refs`、結果の `links` の検査。会話エージェントは番号 `a<n>` と即答の担当 `resources`（find・open・play・read）、画面への指示 `screen_commands`。run `f4764696`・`a3c89c6e` の対策 |
| [memory-activity-indicator-design-2026-10-25.md](memory-activity-indicator-design-2026-10-25.md) | 合意済み・実装済み（fixture 検証済み、live 未確認）。会話画面の経路表示の右端に独立チップ「メモリー整理」を置き、表示中の会話で steward の unit のジョブが実行中（running）のときだけ点灯する。失敗中（`larm_preempted` の譲りは飛ばして判定）は赤い点と小さな ⚠ アイコンボタンを出し、既存のエラーレポートModal（LLM貼り付け用）を開く。`GET /api/steward/activity`・`/error-report` と既存の change 購読で更新 |
| [dots-messaging-design-and-plan-2026-10-25.md](dots-messaging-design-and-plan-2026-10-25.md) | 合意済み。P0〜P4の機能実装と固定試験・画面試験を実施。既存OAuth・Eventsでメッセージ送信と返答・連携後の要約を受け取る。全体gateは保留、実dots受入・サーバー反映は未実施（§15） |
| [ocr-correction-region-qr-design-2026-10-25.md](ocr-correction-region-qr-design-2026-10-25.md) | 合意済み。拡大・既存OCR行の矩形選択・QR復号を実装し、固定試験とブラウザ確認を実施。補正指示の新版は実LLMの品質受入未達。実カメラ・稼働サーバー反映は未確認 |
| [agency-conversation-agent-design-2026-10-25.md](agency-conversation-agent-design-2026-10-25.md) | 合意済み・実装中（§11.4）。現行の会話担当（dialogue の生成）を削除し、agency を唯一の会話エージェントにする。返事・自発発話・TODOの完了の報告はすべて agency が行い、会話の流れで必要なら担当（toolchain）を呼んでサブエージェントに渡す（agency 側は `ToolPort` の mock）。記憶は直接のツールのまま。伝え終えたTODOは `heard: full` で `archived`。分類と根拠の検査を廃止し、TODOの結果の検査に置き換える会話が返答なしで失敗した run `6839d520`・`5145885e` の対策 |
| [user-condition-implementation-plan-2026-10-24.md](user-condition-implementation-plan-2026-10-24.md) | 計画のみ・保留・未実装。Memory・WorldModel・ContextWindowの大改修後に再確認。本人が明言した一時的な状態を既存の短期記憶で保持し、少量を文脈に提示する案を比較検証する |
| [larm-connection-cache-design-2026-10-25.md](larm-connection-cache-design-2026-10-25.md) | Q1・Q2を合意・実装済み（§8）、Q3未着手。LARMの入力キャッシュは接続に結び付くため、主会話の接続を稼働中ずっと保ち、再起動をまたいで同じclientで取り戻す。補助は先頭ごとの最大2本の接続へ送る。liveで再起動後も11,628token再利用を確認 |
| [prompt-edit-design-2026-10-24.md](prompt-edit-design-2026-10-24.md) | 実装済み（fixture 検証済み、2026-10-24 合意）。直前の利用者の発言だけを、行動が確定する前に止めて編集・再送信する。メッセージの訂正（ContextWindow §13）と未処理の発言の run の作り直しで実現し、Web に「止めて編集」・吹き出しの編集・編集の状態を足す |
| [cli-toolchain-design-2026-10-24.md](cli-toolchain-design-2026-10-24.md) | 合意済み（§13）・P0〜P3実装・固定試験済み。ブラウザ・実LLM受入は未実施。Claude Code 画面のPTY基盤を共通化し、新domain `shell` でログインシェルの画面「CLI」と、会話からのCLIコマンド実行（`cli_command`、一件ごとのPTY・実行台帳・完了通知、承認なし）を追加する |
| [code-review-2026-10-24.md](verification/code-review-2026-10-24.md) | 未commit差分全体のレビューと修正・隔離検証。完了確認失敗の波及、保留報告の解除、schema変換を修正。LARM live受入と全体gateの既存違反は未完了 |
| [artifact-form-direct-toolchain-design-2026-10-23.md](artifact-form-direct-toolchain-design-2026-10-23.md) | 合意済み・実装・固定試験済み（§8）。ブラウザE2E・live・実機器は未実施。画像・楽曲の画面フォームからの送信に担当IDを付け、メインエージェントの担当選択を通さず、その担当の専門エージェントへ依頼文を直接渡す。画像の画面で曲が作られた障害（run `5b08cd43`）の対策 |
| [task-pipeline-design-2026-10-22.md](task-pipeline-design-2026-10-22.md) | 合意済み。P0〜P2は実装・固定試験済み（§14）、liveは§14に記録。ブラウザE2E・実機器は未実施。3つ以上の担当を使う決まった手順をJSONの定義（入力・ステップ・変数・extract・合格条件）として `pipelines` ドメインに版で保存し、担当の検索で引き当てる。実行はアプリケーション層が1ステップずつ既存の委譲で進める。定義は協働型 `pipeline.studio` が作業文書を編集して作り、Artifactの編集画面で流れ・検索の拾われ方・選択と運転を試す。合わない依頼は一手ずつ照合する方式へ |
| [context-window-spec-2026-10-24.md](context-window-spec-2026-10-24.md) | 仕様・利用者合意済み・実装済み（fixture検証済み。live・実機器の受入は未実施。結果600 tokenの検査・tool結果の縮約・キャッシュ割合による再構成の判定・Agencyの自発発話の配信記録は未実装）。会話エージェントのContextWindowの唯一の正本。出所・権限ラベル付きのJSON、出来事の流れ、計画窓80%と作業領域の確保、準備と再構成によるキャッシュの維持、固定4種のtool、TODOへの一本化と確認結果の枠、想起、評価基盤（context-eval）。生成の分析・発話の契約・依頼前の予告・構造の修正・実行の確認と、根拠となる観測（§22）も集約。旧ContextWindow設計・構造と評価・キャッシュ案・使用済みtoolchainの保持・再設計案・応答時間の改善計画・2段の初期判断・委譲前の一時回答・記憶と一時ソースの調査は削除済み |
| [context-window-layout-spec-2026-10-25.md](context-window-layout-spec-2026-10-25.md) | 仕様・実装済み（fixture 検証済み、live は一部、実機器は未実施）。ContextWindow の構成仕様（ContextWindow仕様の§5・区画の置き場所と表記・§12.1・§12.4・自動想起・§15を置き換える）。共有の先頭（system・tools・タグ4区画 `<memory>`・`<history>`・`<state>`・`<log>`、1行1項目）と役割の末尾（主会話は `<now>`＋発言、背景は `<task>`）。log は追記だけ、短い番号で参照、今と過去を区画と「再開」の行で分ける。キャッシュされるもの・されないものの表、背景の呼出しも主会話の接続で先頭を共有。自動想起・会話の写しのメモを廃止 |
| [response-latency-implementation-2026-10-24.md](verification/response-latency-implementation-2026-10-24.md) | 実装・fixture・liveの記録。採否とProvider入力互換性、未受入項目を区別 |
| [larm-prompt-cache-request-prompt-2026-10-22.md](larm-prompt-cache-request-prompt-2026-10-22.md) | LARM への prompt キャッシュ（KV prefix 再利用）修正依頼 Prompt。同一 Connection・同一要求でも `cache_n` 0 を確認（2026-10-22）。LARM 側の回答・修正待ち |
| [browser-service-search-design-2026-10-21.md](browser-service-search-design-2026-10-21.md) | 自己評価を反映した設計案・実装前。共通子実行を再利用し、指定サイトの検索不能時は既存外部検索で補完。候補refと本文根拠の別契約、部分採取、330秒worker内の補完150秒予約、既存入口での早期観測→最小結合→複数サイト受入を定義 |
| [everyday-task-agent-implementation-plan-2026-10-21.md](everyday-task-agent-implementation-plan-2026-10-21.md) | 実装・固定検証済み、実モデル受入未達で無効を維持。合意済みの進行契約改訂を含む。task実行型、会話からの委譲/作業操作、必要時の能力探索、既存実行型との接続、原文とMemory等の参照、非同期完了・質問・訂正・取消、親子の予算、P0〜P6の検証・公開条件を定義。Pursuit/Harness2の取込は対象外 |
| [compute-toolchain-design-2026-10-20.md](compute-toolchain-design-2026-10-20.md) | 案・合意待ち（§12 Q1〜Q9）。即時計算 `calculate`（mathjs、instant）と、LARM 計算サービス（capability `compute.python.execute`、SciPy・scikit-learn・PyTorch 等）でジョブ実行する計算担当 `compute_python`（command）の2段。LARM 側 API は依頼仕様の案（§4）で未構築 |
| [browser-tabs-toolchain-design-2026-10-18.md](browser-tabs-toolchain-design-2026-10-18.md) | 合意済み・S0〜S2実装中。利用者の普段のBraveをPlaywright MCP Bridge拡張機能とbackendの子プロセス`@playwright/mcp`で操作・撮影する（Eumenes自身のタブ、Eumenesが開いたタブ・リンクから開いたタブを含む）。品質75固定WebP、各辺2,500px超過の拒否。S1接続とローカル撮影、S2操作ループ、S3 LARM送信（保留）。実機でBraveへの接続・スナップショット・撮影・タブの捕捉を確認済み。専用Chromium案（archive）を置換え |
| [instant-3d-model-toolchain-design-2026-10-18.md](instant-3d-model-toolchain-design-2026-10-18.md) | 合意済み・実装・固定試験済み（§15）。モデルGrid・枠内詳細・共通画像選択（§8.5）も実装・fixture試験済み。端末画像の本番取込・一覧・content・断線回復・削除後非復活を確認済み。Google写真取込は実装・fixture済み、本人同意と稼働画面の受入は未実施。インスタント3Dモデル（LARM 3D API、catalogの `media.mesh.generate`）を単発型commandで登録する。生成はキューのジョブで受付・進捗・取消、保存済みの検索・表示・名前とタグの変更・削除、three.jsでの表示、完了の会話通知。LARM確定仕様と実装契約は§14 |
| [subagent-task-and-session-agents-design-2026-10-18.md](subagent-task-and-session-agents-design-2026-10-18.md) | 合意済み。P0〜P2は実装・固定試験済み（§17）。単発型・協働型の整理、共通のエージェント核（参考資料の囲みと現在の依頼、`reply`付きinvoke、ツールごとのやり直し）、セッション記録（失敗・中断も記憶）、作業文書の部分編集（`doc.edit`/`doc.write`）、UI自由制作の移行とソースの手直し。P3（共有・非同期ツール）は詳細設計の追記待ち、P4は未着手。ブラウザE2E・live・実機器は未実施 |
| [object-recognition-custom-training-concept-2026-10-18.md](object-recognition-custom-training-concept-2026-10-18.md) | コンセプト、着手予定なし。判別機（YOLO26）の追加学習で家の決まった物を検出する。学習はRTX 3080（Windows）が第1候補。10種類×300枚で人の作業7〜12時間の見積もり。ターンテーブル・ロボットアームによる撮影と枠付けの自動化ができたら再検討 |
| [object-recognition-targets-and-llm-handoff-design-2026-10-18.md](object-recognition-targets-and-llm-handoff-design-2026-10-18.md) | 物体認識で探す物を名前で指定（上流をYOLOE-26へ、上流への依頼が必要）。カメラ・画面キャプチャの静止画1枚と検出結果のメタ情報JSONを、「会話に追加」でチャット欄へ添付、または音声（見せるモード案・viewing＋ask）で会話LLMへ渡す。OCR連携はしない。合意済み（Q3・Q6は上流対応後）、実装中 |
| [spatial-model-catalog-2026-10-18.md](spatial-model-catalog-2026-10-18.md) | 案・合意待ち。Spatial監視銀河の全17体（Eumenes 13・LARM 4）の形と動きの目録。ChatGPTへのモデリング依頼仕様を兼ねる。使用率では色を変えず、溜まりと出来事で異常を出す。LARMに届かないときは星系ごと消す。将来のContextStill（5〜8体）は別の星系として見込む。要合意事項M1〜M8 |
| [spatial-monitoring-eumenes-design-2026-10-18.md](spatial-monitoring-eumenes-design-2026-10-18.md) | 合意済み・実装・fixture済み（§10）。ブラウザE2E・liveは未実施。設定画面の背景説明文（bundle）は未更新。Spatial背景の12対象へEumenes側の実測（推論記録・画像/楽曲ジョブ・LARM状態・ホスト計測）を接続する。LARM側APIは後続。§12（2026-10-24合意）で接続断をfaultと同じ赤・減光なしにし、LAN外でのLARM不達はunknownにする |
| [larm-connection-retention-design-2026-10-18.md](larm-connection-retention-design-2026-10-18.md) | 画面表示中の既存Profile利用依頼POSTを実装。backend403件・Web48件成功。同じConnectionを実接続で6分保持・停止後300秒で解放。利用者の再起動後に稼働反映と実画面の接続済みを確認（§12）。認証・自動解放設定は変更なし |
| [toolchain-time-limits-design-2026-10-18.md](toolchain-time-limits-design-2026-10-18.md) | 合意済み・実装済み（fixture試験済み、live・実機は未了）。打ち切り時間（run・専門担当の1ターン・推論1回）をsession bindingの`timeLimits`で設定する。UI自由制作は run 20分・1ターン15分・推論10分 |
| [ui-studio-history-focus-design-2026-10-18.md](ui-studio-history-focus-design-2026-10-18.md) | 実装・固定試験済み。UI自由制作で、閲覧中は削除ボタンで保存作品を削除（§2）、専門担当のアクティブ中に履歴で選んだ作品を編集対象にする（§3、未保存は確認）。ブラウザE2E・live・実機器は未実施 |
| [ui-studio-one-shot-draft-design-2026-10-18.md](ui-studio-one-shot-draft-design-2026-10-18.md) | サブエージェントの二つの型の設計 §12 に統合して実装・固定試験済み。fixer（`composition-fixer.ts`）、`reply`付きの反映で1ターン1推論、自動の作り直しは無し（`doc.write`は再試行0回）、反映できなかった案の表示と手直し。live・実機は未実施 |
| [ui-studio-expressive-parts-implementation-plan-2026-10-17.md](ui-studio-expressive-parts-implementation-plan-2026-10-17.md) | 実装・固定試験・ブラウザE2E（§11、13件pass）済み。UI自由制作の表現力拡張（見せる部品とテーマ別picsum画像・紙芝居、状態と式・数式・電卓、図解）。live（実モデル）・実機器は未実施 |
| [conversation-subagent-llm-refactoring-plan-2026-10-17.md](conversation-subagent-llm-refactoring-plan-2026-10-17.md) | 合意済み。Dに依存しないP2/P3はfixture済み（§8）。P0の前提差分は後続コミットでコードに入った。D1〜D13の結論とP1・P4・P5は未了 |
| [research-failure-reply-and-readahead-2026-10-17.md](research-failure-reply-and-readahead-2026-10-17.md) | 実装・fixture済み（音声経路を含む）。readAhead修正後の天気調査はlive成功。失敗時の読み上げのliveは未確認 |
| [design/ocr-2026-10-17-redesign/README.md](design/ocr-2026-10-17-redesign/README.md) | 画面案の生成と目視は完了。製品への反映は作業ツリーで着手し、全文／行ごとの切替と部品試験ファイルがある。未コミットで、ブラウザ操作と確認記録は未了 |
| [codex-sdk-task-artifact-plan-2026-10-14.md](codex-sdk-task-artifact-plan-2026-10-14.md) | 共通KanbanとCodex SDK。P1〜P3とP4の隔離commit/pushは記録済み。改訂7の終了確認は実装し、ブラウザなし全件検証はpass。全子孫停止は未保証。P5は継続 |
| [kanban-claude-code-plan-2026-10-14.md](kanban-claude-code-plan-2026-10-14.md) | Claude Code実行。P1〜P3は実装・固定試験済み。実 `claude` のフック確認は記録済み。実 LARM の自然言語受入は未実施 |
| [kanban-implementation-assignments-2026-10-14.md](kanban-implementation-assignments-2026-10-14.md) | 上記の分担と固定契約。P1〜P3は実装済み。P4は実 `claude` のフックまで。自然言語受入は計画側に残る |
| [web-research-cache-implementation-plan-2026-10-09.md](web-research-cache-implementation-plan-2026-10-09.md) | 第15〜17章のキャッシュとToolchain接続は記録済み。調査メモは未実装。公開Webは後続のguidedが正本 |
| [delegated-coding-implementation-2026-10-09/](delegated-coding-implementation-2026-10-09/README.md) | 01のタスク基盤は archive 済み。02の実CLI隔離、03のlive、04の会話配送、05のモーダル、07は未完了。06はfixture範囲のみ |
| [improvement-plan-2026-10-10.md](improvement-plan-2026-10-10.md) | 改善手順の初版。延期項目は第2版へ移管済み。残件は第2版の再確認節 |
| [improvement-plan-2026-10-10-r2.md](improvement-plan-2026-10-10-r2.md) | 第2版。2026-10-17再確認で FE-15 の bundle budget は入っていた。FE-4、VO-16、DT-11、DT-13のpeer、CI保留は残る。FE-9の対象画面は置換済み |
| [test-quality-improvement-options-2026-10-15.md](test-quality-improvement-options-2026-10-15.md) | Replay・JiTTest等の評価候補。2026-10-16時点でも未導入 |
| [external-apps-artifacts-implementation-plan-2026-10-09.md](external-apps-artifacts-implementation-plan-2026-10-09.md) | 外部アプリの汎用契約。実装前。個別アーティファクトは別計画で実装済み |
| [avatar-expression-context-design-2026-10-09.md](avatar-expression-context-design-2026-10-09.md) | 表情とTTS感情の設計。接続済みのLaya判断は別計画。チャンク判断とヒステリシスは未実装 |
| [decision-model-benchmark-design.md](decision-model-benchmark-design.md) | 初版スクリプトは実装済み（[scripts/decision-bench/README.md](../scripts/decision-bench/README.md)）。実時間保持とGPU/NPU利用率は未実装。製品経路には未接続 |

## archive 済み(spec/.archived/)

| 文書 | 備考 |
| --- | --- |
| [01-tasks-and-queue.md](.archived/01-tasks-and-queue.md) | 委任タスクの永続台帳。実装とfixture、レビュー再試験を本文に記録。会話配送・モーダル・実CLIは後続計画 |
| [ocr-larm-connectivity-request-2026-10-17.md](.archived/ocr-larm-connectivity-request-2026-10-17.md) | OCRの正式入口の依頼。Macからの設定保存と画像・動画・取消の受入は [検証記録](verification/ocr-mac-gateway-2026-10-17/README.md) |
| [run-error-report-design-2026-10-17.md](run-error-report-design-2026-10-17.md) | 実装・fixture済み。失敗したrunの診断を固定形式・約3,000文字で組み立て、画面のダイアログ・CLIからLLMへ貼れるようにする |
| [weather-instant-toolchain-design-2026-10-18.md](weather-instant-toolchain-design-2026-10-18.md) | 実装・fixture済み。天気専用ツールチェーン（weather.tsukumijima.net）でR1から即時回答、一時回答なし、API障害時はweb_searchへ切替。§7: 地名を気象庁area.jsonでhostが解決（revision 2） |
| [stock-instant-toolchain-design-2026-10-18.md](stock-instant-toolchain-design-2026-10-18.md) | 実装・fixture済み（実機未確認）。株価専用ツールチェーン（Yahooチャート＋EDINETコードリスト＋Yahoo検索）で即時回答、日本株優先、同順位は資本金の大きい順、障害時はweb_searchへ切替 |
| [request-url-boundary-design-2026-10-17.md](.archived/request-url-boundary-design-2026-10-17.md) | 依頼文のURLは「、」「。」で区切る（U2）。`request-urls.test.ts` で確認。助詞直結（U1）は対応しない |
| [toolchain-specialist-dialogue-implementation-plan-2026-10-17.md](.archived/toolchain-specialist-dialogue-implementation-plan-2026-10-17.md) | 専門担当への共通切替とUI自由制作の対話編集。実装と固定試験を§15に記録。ブラウザE2E・実モデル・実機器は未実施 |
| [toolchain-specialist-dialogue-p0-contract-2026-10-17.md](.archived/toolchain-specialist-dialogue-p0-contract-2026-10-17.md) | 上記の型契約。コードで固定済み。実モデルの容量測定は未実施 |
| [kanban-planning-ui-2026-10-17.md](.archived/kanban-planning-ui-2026-10-17.md) | 未着手＋Planning、担当ロゴ、横並び。domain試験と静的描画を記録。稼働中画面のE2Eはサーバー未許可のため未実施 |
| [notification-banner-collapse-2026-10-17.md](.archived/notification-banner-collapse-2026-10-17.md) | 通知カードは8秒でバーへ収納。部品試験が期限・バッジ・既読副作用なしを固定している。ブラウザE2Eは未実施 |
| [image-larm-connection-2026-10-17.md](.archived/image-larm-connection-2026-10-17.md) | 画像生成は接続応答の pending／probing／ready から開始。Providerのready待ちはProvider経路だけ。固定試験と実モデルの通しを記録 |
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
| [openui-artifact-free-creation-implementation-plan-2026-10-14.md](.archived/openui-artifact-free-creation-implementation-plan-2026-10-14.md) | 旧UI自由制作の実装・検証記録。一回生成方式は2026-10-17に廃案とし、[専門担当との対話編集計画](.archived/toolchain-specialist-dialogue-implementation-plan-2026-10-17.md)で置換済み（旧コードは削除） |
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
