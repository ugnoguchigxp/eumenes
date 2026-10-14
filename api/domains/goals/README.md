# Goals

Goalの明示採用、提案、改訂、完了、取下げを管理する。提案は明示的に採用するまでadopted snapshotに含めない。現在のserverに自動提案writerは接続されていない。

`operationKey`はprincipal/scopeごとの操作再送ID。同じkeyと同じ入力なら保存済みGoalを返し、入力が異なれば`operation_conflict`になる。文面、priority、sourceの版も入力digestに含む。文面の大小文字、Unicode幅、空白を理由に別操作を統合しない。

keyは任意。keyなし、または別keyの入力は、文面が同じでも独立した操作として保存する。繰り返し処理のcallerは安定した操作IDを渡す。自由文の正規化から再送IDを作らない。提案50件、採用30件の既存上限、scope権限、revisionとepochの検証は維持する。

## 記憶担当（steward）向けの操作

- `applyInTransaction(db, access, ops)`: `propose` / `adopt`（新規、または`goalId`で提案から）/ `revise`（文面・priority）/ `complete` / `withdraw`を順に適用する。要素ごとにsavepointを張り、`applied`（`replayed`はoperationKeyの再送）か`rejected`（理由コード: `invalid_goal_input` `source_required` `goal_scope_forbidden` `invalid_goal` `revision_conflict` `goal_state_conflict` `goal_limit` `operation_conflict`）を返す。拒否された要素は何も書かず、他の要素は続行する。上限50件、`sourceMessageIds`は1件以上必須。
- `listForStewardInTransaction`は全状態の目標、`adoptedForContextInTransaction`は採用済みを優先度の高い順、同順位は直近に改訂した順で返す。文面の整形・切り詰めは呼び出し側。
- 根拠の追跡: 各改訂の`sourceMessageIds`を`goals_source(goal_id, revision, message_id)`に、関係するWorld対象`entityIds`を`goals_entity(goal_id, entity_id)`に書く。対象は改訂をまたいで**累積**する（古い改訂が触れた対象を忘れたときも届かせるため）。
- 忘却: `resolveForgetInTransaction`が消す目標と根拠のメッセージを読み取りだけで返し、`forgetGoalsInTransaction`が名指しの目標と対象に結び付いた目標を、完了・取下げ済みも含め、履歴と根拠の行ごと削除する。冪等で、影響したscopeのepochを進める。

