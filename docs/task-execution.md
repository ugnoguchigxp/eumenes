# 日常の複数操作担当

会話担当は、一つの結果から次の能力を使う必要がある依頼を `execute_task` へ渡す。意味の判断と完了の判定はLLM、台帳・権限・予算・副作用の実行はhostが担当する。Pursuitへの自動転送や長期探索は含まない。

## 入口と状態

登録は `capabilities/bundles/task-execution.bundle.json` と `adapter:task-execution@1`。専用Artifactはない。質問と結果は既存の会話通知を使う。R1には既に組み立てたMemory/Worldの背景とhost発行ref、同じ会話の短い作業projectionだけを追加し、開始時の追加分類・planner・能力探索を行わない。

親実行のIDと原発言の会話runを分離する。会話が回答を終えたり画面を離れたりしても親は継続できる。作業の操作はR1の `task_control` で `workRef`、`expectedRevision`、action（status / answer / amend / cancel）を指定する。回答には質問refと所有domainのschemaに一致する入力が必要で、別会話・古い版・回答済みの質問は再開できない。進捗照会は制御適用後の状態を返す。

読み取りAPIは `GET /api/agent-executions?conversationId=…` と `GET /api/agent-executions/:id`。変更は既存の会話入口から行う。

## 子の実行と確認

親は一推論で一つのnative functionを選ぶ。最初の親推論はset_planで一子呼出しごとの操作本文と依存を決め、hostがstepRefを発行する。計画推論も親12回・総48回に含める。子呼出しは未実行で依存が終了したstepRefだけを指定し、保存した本文と選択した参照を使う。同じstepRef・同じ入力の再送は同じ子とreceiptを返し、入力変更は競合とする。同内容でも別項目なら別操作になる。全項目実行後はcomplete_task/report_partialだけを提示し、能力探索・読取り・追加計画を止める。不足があればpartialで返す。検索で提示するのは上位4候補。子が終わるまでは同じ選択のための検索を繰り返さない。使用済み能力は最大4件、定義4,096推定token以内を保持する。全文の実行履歴や全catalogを毎回渡さない。

参照引数のnative schemaにはhostが発行済みのIDだけを列挙する。参照がなければ空配列のみを許し、読取り関数は提示しない。URLや資料名をIDとして送った場合は拒否する。未完了の最終通知は既存のhost回答経路で状態と実行担当の報告を表示し、追加の会話推論が取得結果や将来の実行を補完しない。確認済みの部分結果も保持する。通知は作業の版・質問・結果digestを準備時と採用時に照合する。

親への結果には手順台帳にある能力と依頼内容を対応付ける。短い構造化outputはobjectとして渡し、同じJSONの要約と参照previewを重複送信しない。背景の部分読取りはrefと範囲を残し、背景previewを失わない。質問への回答には質問文も残す。操作後のcomplete_taskは実際の結果refを必須にし、背景refだけで完了することを拒否する。子の残枠がないときは能力探索を提示しない。

共通のcommand入力には元runと親・子IDを渡す。所有domainが示す作成元と今回の実行結果を区別し、同種・同名の過去対象だけで新規依頼を重複扱いしない。親bindingの無効化は背景の回収だけでなく、各判断と子の認可でも検査する。

承認の参照元となる直前のassistant発言がないR1では、approved=falseだけを提示する。発言がある場合、その意味が今回の承認かどうかはLLMが判断する。過去の承認をhost側で自動的に再利用しない。

research、bound command、instant、生成系、旧commandは既存の実行機構を使う。instantの明示fallbackも同じ論理子として追跡する。非同期処理の受付後は所有domainの終了を待つ。生成系は実呼出しIDごとに保存し、同一会話run内の二回の生成が上書きされない。

browserには原文と短い作業説明を別々に渡す。承認待ちで物理taskが終わった場合、回答後に新しい物理taskを同じ論理子へ関連付け、元の期限・残予算・承認対象を引き継ぐ。受付やタブを開いたことだけで再生成功とは報告しない。sessionは現在状態と未保存確認を含む引継ぎrefを返し、親はpartialで会話へ戻す。

## 上限と終了

| 項目 | 上限 |
| --- | --- |
| 親の判断 / 論理子 / 能力探索 | 12回 / 6回 / 3回 |
| Eumenesが行う親子のLLM推論 | 48回。最終親推論1回を予約 |
| 親の絶対期限 / 一推論 | 300秒 / 45秒 |
| 子の期限 | 親期限から最終返却45秒を引き、所有domainの上限と短い方 |
| 未終了作業 | 同じ会話4件、host全体32件 |
| 親状態 / 開始入力 / 結果 / 参照読取り | 64KiB / 24KiB / 16KiB / 8KiB |
| 参照 / 未回答質問 / 質問累計 | 32件 / 1件 / 3件 |
| R1の制御定義と作業projectionの追加量 | 1,024推定token以内。背景本文は既存Memory割当内 |

外部のcoding担当内部の推論数は取得できないため48回に加算せず、外部担当の予算、親の絶対期限、停止操作で制約する。取得可能なEumenesの子推論は予約してから開始し、失敗で未確定の消費は予約上限まで使用済みと扱う。

計画版は依頼版と区別する。実行途中のset_planは未実行部分だけを置き換え、実行済み項目とreceiptは残す。訂正は依頼版を進め、実行中の古い子を止めてから残りの計画を作り直す。過去の実行を新条件の達成と自動的に扱わない。停止が確認できない書込みは不足・未確定として返し、自動で新しい操作を送らない。取消は後続操作を止め、既に発生した外部の副作用を自動で巻き戻さない。

起動時はqueued・判断中・子待ち・質問待ちをすべてinterruptedにする。副作用を自動再送しない。質問待ちにも期限を適用する。入力・質問・手順本文は14日、最小receiptは30日で回収する。忘却時は元資料と結果refを失効し、親・子の派生コピーを消去し、未配送通知を取消す。既に会話へ採用された回答の扱いは既存の会話・Memoryの忘却規則に従う。

## 検証と運用

2026-10-21の実モデル受入は未達。現在の製品DBではtask.executeを無効化し、実装と登録revisionを保持している。固定試験の成功だけで有効化しない。成否と再開条件は下記の検証記録を参照する。

[実装レビュー](../spec/verification/everyday-task-agent/implementation-review-2026-10-21.md)で情報・契約の不具合を修正したが、最新の二操作3件は0/3で重複実行が残る。[進行契約の改訂](../spec/everyday-task-agent-progress-contract-proposal-2026-10-21.md)は利用者合意後に実装した。[新契約の検証](../spec/verification/everyday-task-agent/progress-contract-verification-2026-10-21.md)は公式Bun764件・Web75件成功、二操作の実モデル受入は0/3。以前の0/3と区別して記録し、有効化しない。

実装箇所はagent-runtimeの `execution-*`、application/toolchainの `task-execution-*`、所有domainの公開操作。domainをまたぐSQLや、題材・発話の語句で判断する分岐を追加しない。

[契約・基準](../spec/verification/everyday-task-agent/contract-matrix.md)、[実装計画](../spec/everyday-task-agent-implementation-plan-2026-10-21.md)、[検証記録](../spec/verification/everyday-task-agent/implementation-verification-2026-10-21.md)を参照。新規登録を止める場合はtask bindingの公開を外す。migration削除や同一revisionの上書きで切り戻さない。
