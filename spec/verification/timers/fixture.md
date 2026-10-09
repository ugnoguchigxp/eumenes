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

## 2026-10-10 表示復旧・音声準備・繰り返し通知

- 会話 run 更新で保存済み active timer を再取得する。ローカル run callback や change event がなくても時計を開く回帰テストを追加。
- 音声未準備のページでは pending 通知を claim / ack しない。通知音の有効化後にビープ、TTS、played へ進む。
- 読み上げ後は同じクライアントで約3秒間隔のビープを続ける。「通知を停止」、ミュート、別の音声再生、アンマウントで停止する。別の音声が終わると再開し、TTS は繰り返さない。別クライアントの played 通知からはループを開始しない。
- Web の timer / audio 対象テスト46件、workspace typecheck / 対象 lint が通過。timer domain verify は backend 10件・Web 18件を含め通過。
- ブラウザの音声復旧テストで pending → 有効化 → 実 AudioBufferSource のビープ → TTS リクエスト → 2回目のビープ → 停止後に回数が増えないことを確認。
- 既存の clock 閉鎖後ビープ/TTS テストも単独実行で通過。並行検証中の初回実行は終了処理待ち・TTS待ちでタイムアウトしており、全ブラウザケースの通過とは区別する。
- 繰り返し音の所有権は今回再生に成功したページ内で保持する。ページの再読み込み後や別クライアントでは既配信通知から自動で再開しない。

- audio domain verify は28件を含め通過。verify:all は並行変更中の World query 3ファイルの書式チェックで停止した。該当箇所は今回の timer / audio 修正外。

## 2026-10-10 通知センターの再デザイン

- 共通 DesignSystem に NotificationCard を追加。Drawer にトリガーと閉じるボタンのラベル・背景指定を追加。
- 通知は右上のコンパクトなカードで最大3件表示し、残りは件数ボタンから確認する。右上の通知センターアイコンは通知が0件でも利用できる。
- Drawer は未停止の通知を新しい順に全件表示し、停止後は一覧・件数から除く。件数は未読件数ではなく、サーバーに残っている未停止通知の件数。停止済みの履歴の保存は今回の対象外。
- 通知UIをWorkspaceの外に置き、設定画面でも表示する。Drawerの開閉は通知音の停止・再読上げを起こさない。
- 通知の所有権・claim/ack・ミュート・会話音声の優先順位を維持し、停止処理中の連打を防ぐ。
- Web単体テストで空の一覧、最新3件と全件表示、Drawer開閉後もBeepが続くこと、Drawer内で停止できることを確認。
- ブラウザの表示fixtureで1840/1280/790/390px、明暗テーマ、12件のスクロール、Escapeでの閉鎖とトリガーへのフォーカス復帰、設定画面での通知表示を確認。
- 画像: `notification-banner-{dark,light}.png`、`notification-center-{dark,light}.png`、`notification-center-mobile-{dark,light}.png`。実機器の音声3往復受入とは区別する。

今回の検証結果:

- timer domain verify: backend10件・Web20件を含め通過。
- audio domain verify: 28件を含め通過。音声準備のタイミングをpointerdownからclick、keydownからkeyupへ移し、押している途中のボタンが消える競合を防止。
- artifact domain verify: 37件を含め通過。DesignSystem Drawerの既存9件も通過。
- workspace typecheck、Webの本番ビルドが通過。
- 表示fixtureと音声復旧fixtureを連続実行し、2件とも通過（50.3秒）。実AudioBufferSourceの初回ビープ、TTSリクエスト、2回目以降のビープ、停止後に回数が増えないことを確認。
- 途中の音声検証にはタイムアウトがあった。クリック中に準備カードが消える競合を修正し、別の実行は検証途中のDesignSystem再ビルドと重なったため、結果を採用しなかった。ビルド後、検証中のソース更新を避けた上記の連続実行が通過。
- verify:allは今回の変更外のWorld claims関連5ファイルの書式チェックで停止。全体検証の通過とは扱わない。
