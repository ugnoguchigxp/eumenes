# タイマー fixture

記録日: 2026-10-09。live と実機器は別ファイル。

対象は相対時間 1〜86400 秒。3分（180秒）は例であり、固定の期間ではない。

## 実行

`bun test api/domains/timers/test/timers.test.ts`

確認したこと:

- 0 / 86401 / 小数 / NaN / 81文字 / 未知フィールド / offset なし ISO は拒否。1秒と86400秒は受け付ける。
- 180秒の due は `2026-10-09T00:03:00.000Z`。同じ request は同じ receipt。別 duration は 409。scheduler 失敗時は timer / operation / schedule が残らない。
- 取消後に期限が来ても elapsed 通知を作らない。
- t=179999 は active、通知 0。t=180000 の dispatch 後は elapsed と通知 1。二度目の settle は stale。
- claim lease は 15秒。別 client は 409。期限から 300001ms では silent/stale。
- 同じ origin の再送は timer 1件。別 duration は request_conflict。

`bun test api/application/timer-toolchain.test.ts` で次を確認した。

- 「3分タイマー測って」は duration 180、once schedule 1、start operation 1、tool_action_invocations 1、agent_action_results 1、assistant 応答に「3分」。control は 1 回、回答 LLM と worker と web 取得は 0。
- 「90秒タイマー」は 90 秒で応答は「1分30秒」、「3分30秒のタイマー」は 210 秒で「3分30秒」、「1時間のタイマー」は 3600 秒で「1時間」。
- 応答保存後に会話 run を取り消しても timer は active のまま。
- timer ports なしでは timers 行が 0 で、開始したと答えない。

C04〜C08 も `bun test api/application/timer-toolchain.test.ts` で確認した。

- C04: Skill 失効、command への scope 追加、別 owner、scope 付き引数はタイマーを作らない。
- C05: action result 保存前の例外は timer / schedule / operation / action invocation を 0 件に戻す。同じ step の再実行は各 1 件、期間は 90 秒。
- C07: list と cancel を同じ step で二回呼んでも操作は各 1 件。取消後の state は cancelled。
- browser: `bunx playwright test tests/browser/timers.spec.ts`。「90秒タイマー測って」で duration 90、receipt の timerId とタブが一致し、応答は「1分30秒のタイマーを開始いたしました」。時計は `01:30` 付近。

## 未達

通知音の複数画面、live、実機器の 3 往復は未実施。live 済みではない。
