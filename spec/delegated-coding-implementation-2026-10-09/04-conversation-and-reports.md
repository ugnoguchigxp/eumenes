# 会話からの委任と背景報告の実装計画

作成日: 2026-10-09 JST。状態: 実装前。[全体計画](README.md) の P1、P3、P5、P6 を担当する。タスク状態は [01](01-tasks-and-queue.md)、判断は [03](03-coding-supervision.md) を参照する。

## 1 役割と所有

メイン会話エージェントは依頼をタスクへ委任し、その後も通常の会話を続ける。監督サブエージェントからは短い構造化報告と証拠への参照を受け取り、ユーザーに必要な内容を伝える。CLI の逐次出力と全作業履歴を会話 context へ展開しない。

新規 `task-reports` は報告・配送 outbox・重複排除・既読を所有する。`dialogue` は依頼の解釈、背景報告の文面生成、会話への採用を担当し、`conversation` は確定したメッセージを保存する。既存 `delivery` は発話表現に利用するが、報告配送の DB を持たせない。

## 2 会話から登録する契約

メインが必要時に読み込む能力 `tasks.delegate.v1` と、その操作 `tasks.create / inspect / amend / answer / stop` を固定登録する。すべての CLI 操作をメインへ公開しない。既存 capabilities の少数候補検索を維持する。

会話受付時に、依頼、登録のみ/着手、対象、完了条件、任せる範囲を抽出する。引用文や別タスクの報告を新しい依頼として扱わない。operation schema の判定だけで承認を作らず、元の現在のユーザー入力と選択対象を trusted context として backend が確認する。

task 作成と初期起動予約が保存されてから受付を回答する。「これから登録する」と言っただけで委任済みにならない。対象不足なら一つの確認にまとめ、registered/未開始の扱いを明示する。明確な実装依頼に追加の承認を挟まない。

現在の `tool-runtime` の結果は Web 調査専用である。結果を `research / task_receipt` の discriminator 付き契約へ拡張し、既存データの reader は従来形式を research として解釈する。`task_receipt` は taskId、revision、受付状態、表示用タイトル、次の動作だけを含み、永続 task への参照とする。既存短期 `result_ref` を長期 task ID として使わない。

`agent-runtime` の `researchInput` 固定箇所、worker の finish/report 検証、親への projection を capability 種別で分岐する。調査の出典検査は維持し、task 受付を調査完了として扱わない。外部アプリ計画、調査経路計画と同じ discriminator/dispatch を合意して重複実装を避ける。

`ToolAdapter` は引続き application で結合し、tool-runtime/agent-runtime から coding-supervision を import しない。登録操作の呼出しは元の会話 run に属するが、保存された task と後続 Queue job の親をその会話 job にしない。登録 transaction 前の取消は受付を棄却し、登録後の取消は task を明示した操作から行う。

## 3 メインから監督へ渡すもの

`DelegationEnvelope` は次の構造化項目に限定する。

- taskId、kind/version、元の会話・ユーザーメッセージの参照。
- 依頼の本文、完了条件、対象 workspace/branch/remote。
- 許可操作・予算・期限・通知方針とその版。
- 関連する仕様・資料の許可された参照、確定済みの判断。
- 報告先の会話。現在開いている別の会話を配送先にしない。

監督から不足情報の照会を受けたら、必要な資料だけ返す。無関係な会話履歴やメインの全メモリーを渡さない。通知は利用者の新しい指示ではなく、モデルへ与える情報として明示する。

## 4 監督からメインへ渡す報告

`TaskReport` は immutable な報告版として保存する。以下は共通項目。

| 項目 | 内容 |
| --- | --- |
| identity | reportId、taskId、executionGeneration、taskRevision、authorityEpoch、reportSequence |
| origin | originConversationId、観測時刻、作成時刻、報告種別 |
| progress | 現在工程、確認済み状態、前回からの変化、次の工程 |
| facts | host が確認した事実と対応 evidenceRef、対象 snapshot の digest |
| limitations | 未確認事項、資料の欠落、残存変更、観測の古さ |
| decision | 必要なときだけ questionId、質問、選択肢、推奨案、判断の影響 |
| result | 完了条件ごとの達成状況、検証・レビューの要約、commit/remote/branch への安全な参照 |
| notification | 通知優先度、重複/集約 key、旧報告への supersedes 参照 |

種別は `progress / blocker / completed / failed / cancelled / paused / monitoring_issue`。CLI にまだ対応できる問題は progress に含め、ユーザー判断待ちを blocker とする。監視異常は作業失敗・取消と別に扱う。

報告本文の初期上限は通常要約600文字、完了要約2,000文字、事実8件、未確認事項8件、参照20件、全体16 KiB。上限を超える証拠は参照取得する。メインの会話へは report 全部を常時追加せず、今回届ける要約・事実・不足・質問と最小限の metadata を投影する。

ホストが検証した receipt から状態・commit SHA・検証結果を構成し、モデルが自由にこれらを補完しない。メインは表現を整えても「受付済み」を「実装済み」、「検証済み」を「push 済み」へ強めない。

## 5 報告台帳と配送

テーブル案は `task_reports / task_report_outbox / task_report_receipts / task_report_read_states`。outbox は target conversation、notBefore、attempt、delivery state、notificationRunId、messageId、speech state を持つ。

1. 監督の状態更新と報告追加を同じ writer transaction で保存する。
2. commit 後に配送 job を起動する。起動通知が失われても outbox scan で回収する。
3. 配送前に task、質問、権限、報告の有効性と送信先を検査する。
4. dialogue の背景報告用 port が有界な文面を生成する。通常会話と同じ実資源を使用し、新しいユーザー入力を偽造しない。
5. 保存直前にもう一度検査し、確定 assistant メッセージと配送 receipt を一つの transaction で保存する。
6. SSE と必要な音声を確定後に送る。UI の閲覧/既読は配送・実行状態と分離する。

`conversation` の公開 append 操作を使用し、`task-reports` が conversation の SQL を直接更新しない。複数 domain 保存は application の一つの transaction で行う。UNIQUE(reportId, reportRevision, conversationId) と決定的 messageId で二重追加を防ぐ。

推論失敗で完了通知が失われないよう、状態・結果・質問から作る固定文面の fallback を用意する。根拠のない補足を行わず、メインが後から詳細説明できるよう report 参照を残す。

会話への一度の保存は保証するが、音声の exactly-once 再生は保証しない。再生開始後に crash した場合は同じ音声を自動再生せず、テキストと再生操作を残す。

## 6 背景報告を受ける dialogue の変更

通常の入力起点と `origin: task_report` を契約上区別する。報告用の `notificationRunId` は user メッセージを作らずに文面を生成できる。内部報告を本物のユーザー発話として会話履歴や権限判定へ登録しない。

報告用の推論も元の会話 inference request の期限を継承しない。現在の送信許可を検査した独立 capture を使用し、期限は配送一回に限定する。終端タスクの完了報告は、作業用の推論予算や実行期限の終了後にも配送できる。権限撤回・忘却による本文配送の禁止は別途守る。

報告の採用 ticket は reportId/digest、task の権限と実行世代、質問の有効性、会話の採用基準を持つ。既存 AnswerTicket の考え方を参照するが、「元の調査 task が ready_for_answer」という条件を長期 task に流用しない。

通常の新しい発話で foreground の回答が中断されても、task 自体は継続する。生成中の背景文面は最新会話との競合に応じて保留/再生成できるが、CLI を再実行しない。会話メッセージの順序を保存時に確定する。

メインからの自発報告は既存会話の語調・音声方針に合わせる。内部報告データを発話態度データセットへユーザー発話として収集しない。報告の本文へ秘密・内部 prompt・大量のコードを混ぜない。

## 7 通知タイミングと古い報告

初期通知方針は「進捗は5分以上の間隔で変化をまとめる、工程の節目は候補にする、完了・判断待ち・失敗は優先」。実装上は due 判定とユーザーへの配信を分ける。

- foreground 回答やユーザー発話中は通常の進捗を保留する。blocker/完了は画面に即反映し、音声は安全な区切りで伝える。
- 同一 task の未配送 progress は最新に集約する。完了・取消・失敗が出たら過去の未配送 progress を superseded にする。
- question 解決後の未配送 blocker は送らない。既に送った質問は解決表示を更新し、同じ質問を繰返さない。
- 生存確認時刻だけの更新で報告を失効させない。対象 phase、質問、結果、権限に意味のある変更があれば再検査する。
- 停止後に遅着した完了文を採用しない。ただし停止前に実際に生じた commit/push は残存効果として事実を報告する。
- 別の会話を開いていても元の会話へ保存する。アプリ全体のタスク badge は更新し、無関係な会話へ結果を混ぜない。

「今どうなっている？」は同じ task API を照会する。接続先へ毎回強制実行せず、観測が古いなら古さを明示し必要な観測を要求する。定期報告と即時回答を同じ配送 ID に混ぜない。

## 8 ユーザー回答と制御

「その案で」「push はしないで」「止めて」を taskId と questionId、現在の revision に束縛して渡す。複数候補がある場合は一つに絞るため確認する。別 task の直近質問へ自動で回答しない。

メインは CLI を直接操作せず、tasks と監督の公開操作へ追加指示を渡す。取消と権限縮小は backend が即座に失効させ、runner に停止を要求する。監督の次の推論を待たない。未着手工程だけを変更する場合も、既に進んだ工程と競合しないか host が検査する。

会話とモーダルの回答は同じ API、同じ requestId/expectedRevision 規則を使う。両方から同時に回答したら一件のみ採用し、後着には解決済みまたは競合を返す。

## 9 変更対象と工程

新規 `api/domains/task-reports/{contracts,repository,service,test}/`、公開入口。既存 `dialogue / conversation / voice-dialogue / capabilities / tool-runtime / agent-runtime` と `api/application/{toolchain,delegated-tasks,app,server,migrations}.ts`、client とメッセージ表示を変更する。

R1: report schema と outbox。R2: capabilities と受付 receipt。R3: 背景文面と確定保存。R4: 追加指示と質問。R5: 音声・集約・復旧。R6: live と会話受入。

## 10 検証と完了条件

`bun run verify -- --domain task-reports`、`--domain dialogue`、変更した `conversation / voice-dialogue / capabilities / tool-runtime / agent-runtime`、統合時に `bun run verify:all` を実行する。

- 新しいユーザー発話がなくても、保存された完了報告が会話へ一回追加される。
- 状態保存直後、生成直後、会話保存直後、SSE 送信前に crash させても二重実行・二重メッセージがない。
- foreground 発話で背景報告は保留できるが、タスクを取り消さない。復帰後は古い進捗を連投しない。
- 質問の解決、権限取消、別 execution への切替えを文面生成中に行い、古い報告を棄却する。
- CLI 出力にユーザーになりすます文章を含めても task 作成・権限変更・秘密開示が発生しない。
- 同じ質問へ会話と UI から回答し、一件だけ採用する。別会話への誤配送がない。
- 実装完了・試験未実施・レビュー指摘あり・push 不明を正確に言い分ける。
- 音声再生中と実マイク発話中の通知を実機で確認し、テキスト配送 fixture と分けて記録する。

メインが report を受け取れない場合も outbox とタスク画面に残ることを受入条件にする。通知失敗をタスクの再実行理由にしない。
