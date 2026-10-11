# MCP Events と dots 側監査 — 2026-10-11

結果: **利用者の手動指示による初回購読は確認済み。新しい依頼の Events 配信は成功したが、実 dots の取得・Session・結果は未達。backendの再停止を確認し、試験依頼の取消を要求した。購読は維持している**。

## 手動購読後の実接続確認（08:07 JST時点）

利用者が07:59にセバスチャンへ初回購読指示を送信。08:00の会話に購読成功が表示され、Eumenes APIでも `subscribed=true`、期限08:15:05を確認した。停止していたbackendを08:02に復旧し、接続済みLive TrialのMCPから一覧と新しいcommandを読み取れることを確認した。

試験プロジェクトを `package:dots.orchestrate@2` に更新した後、依頼全文と許可範囲をCodexの利用者の会話に先に表示し、08:03:40に既存タスクAPIから新規依頼1件を送った。この検証でブラウザからdotsへのメッセージ送信は0件。依頼は `63d832db-17ca-4f94-8a9d-bb11c8279083`、commandは `3ac2365871816565a962c0d99e737f7f736b8ecc493f4a4f9f344a68536ce187`。取得したcommandには版2のSkillと依存hashが固定されていた。

Eventsジョブ `081e682e-8559-445c-aaa7-bc409b132cc2` は08:03:41に1回目の配信で完了。これは通知の受付であり、dotsの本文取得や回答の成功ではない。08:07の観測はqueued、sourceSequence=0、Sessionと報告は0件。

セバスチャンの08:02および08:05の会話には一覧取得の `MCP -32603: Internal error` と再試行失敗が表示されている。08:05には受け取った追加イベントを旧試験の停止commandと識別し、購読を維持して待機すると表示した。今回の新規依頼を取得したという表示はまだない。同じ接続をこちらから読み取る操作は成功しているが、dots側の失敗原因は未特定。新しい依頼の配信を追加再試行したり、代理でclaim/reportしたりしていない。

依頼と観測の正本は [audit-live-request-2026-10-11.json](audit-live-request-2026-10-11.json) と [audit-live-result-2026-10-11.json](audit-live-result-2026-10-11.json)。以下の初回購読ブロッカーとpreflightは手動指示前の記録であり、この後の確認結果と区別する。

08:09:24にbackendの正常終了ログ（shutdown_started/completed）を確認し、08:09:53のAPI観測は接続失敗。アプリ内の例外終了と決めつけず、終了の呼出元は未特定として記録する。08:10に再起動して、同じ試験タスクに既存APIからcancelを要求した。停止時に開始commandがsupersededとなり、authorityEpoch=2、状態はstopping。これは取消要求の受付であり、dotsによる停止確認の完了ではない。購読はsubscribed=trueのまま。確認済みの08:07の時点でSession・報告とも0件だった。

今回は購読成功とEvents通知の受付まで確認できた。依頼全文のdots会話への表示、Session作成・Activity添付、回答返却は成功として扱わない。前回のnative権限のブロッカーも未解決。まずbackendの起動・停止の所有を安定させ、dotsからの取得エラーを再現・特定する必要がある。現在の画面の証拠は [audit-subscription-status-2026-10-11.png](audit-subscription-status-2026-10-11.png)。

08:11の再観測では、購読期限が08:15:05から08:25:41へ更新され、購読維持の実動作を確認した。更新時に未処理の停止commandの再通知も配信されている。セバスチャンの08:10の会話には、今回の新規command ID `3ac2365871816565a962c0d99e737f7f736b8ecc493f4a4f9f344a68536ce187` がそのまま表示された。get_commandの結果は `dots_stale`、一覧には停止command2件のみ、claim・Session作成・委任はしていないと報告している。取消後のAPI状態と一致する。このため、今回の新規依頼についても **Eventsだけでdotsが通知参照を受領した** ところまでは確認済み。本文取得・Session・回答の成功を意味しない。backend復旧時の再通知、cancel通知、購読更新時の再通知は観測JSONの各ジョブに記録した。ブラウザ送信やこちらによる代理報告は行っていない。

利用者の条件は、初回購読も試験依頼も画面操作で送らず、Events だけで依頼を届け、dots の会話と Activity で依頼・Session・結果を監査できること。今回、ブラウザから dots へのメッセージ送信は0件、新規の実接続試験依頼も0件。既存接続の状態を API で確認した [audit-preflight-2026-10-11.json](audit-preflight-2026-10-11.json) では `subscribed=false`。

## 実装

- `skill:dots.orchestrate@2` と `package:dots.orchestrate@2` を追加。版1は別ファイルで保持し、同じ revision の内容を上書きしない。
- 共通 MCP 指示と Skill に、受領本文・許可範囲、子作業への指示、実 Session 参照、進捗・結果・追加作業・再試行・ブロッカーを人間の会話に表示する契約を追加。
- 私的な背景エージェントを監査可能な native task の代わりに使わず、確認できない Activity 表示や参照を捏造しない。認証情報と内部推論は表示しない。
- 1件の終了後は作業を終えても購読を維持する。待機のために推論・定期ポーリング・予定を新規作成せず、イベントか明示的な復旧時に取得する。
- API と設定画面の新規プロジェクトの標準担当を版2に変更。既存の登録・進行中の依頼・凍結指示を自動移行しない。

表示指示はモデルの行動契約であり、ChatGPT の会話へ文字列を強制挿入する機能ではない。実表示は受入で確認する。既存の report 保存・元の Eumenes 会話への outbox 配信を再利用し、表示のための別 LLM 呼出しは追加していない。

## 初回購読のブロッカー

[公式 MCP Events](https://developers.openai.com/plugins/build/mcp-events#how-it-works) は、利用者が ChatGPT に監視内容を伝え、ChatGPT が callback URL と署名鍵を供給する流れを定める。購読済みのチャットへ通知する経路であり、未購読の dots へ開始指示を送る入口ではない。既存の購読は以前の1件試験で解除済み。公開ドキュメントと利用可能な接続ツールに、外部から初回購読を作成する手段は確認できなかった。

「毎回購読開始→処理→解除」も、開始指示の別経路がなければ同じ問題になる。「常時維持」は有効な購読の refresh に使えるが、解除済みの購読を新規作成する手段にはならない。送信側だけで停止した購読を復活させず、callback や署名鍵を捏造しない。

この試験の OAuth サービスは08:27 JSTに停止する。恒久運用には継続的な認証サービスが必要であり、常時維持の方針だけでこの試験入口を恒久運用として扱わない。

## 検証範囲

fixture では、旧 Skill の保存、版2の依存関係を command に固定すること、再 seed で hash が変わらないこと、購読未登録の状態で通知を外部送信しないことを確認する。既存の MCP 認証・署名付きイベント・claim・報告・取消・会話への返却試験も実行する。

実行結果:

- `bun test api/application/dots-audit.test.ts api/application/dots-http.test.ts api/application/dots-dialogue.test.ts api/application/dots-tasks.test.ts`: 18成功、0失敗。
- `bun run verify -- --domain dots`: 成功（2403 ms）。
- 変更した TypeScript の lint と差分の whitespace 検査: 成功。
- `bun run verify:all`: 型検査で失敗。並行変更中の `api/domains/agent-runtime/service/step-handler.ts:114` が invocation の型にない `args_json` を参照する TS2339。今回の監査変更では当該ファイルを編集していない。全体検証成功として扱わない。

実 dots の次の観測はすべて未実施:

| ケース | 成功条件 | 禁止する代替 |
| --- | --- | --- |
| 通常の依頼 | Eventsのみで受領し、同じ taskId・依頼全文・許可範囲が dots の会話に表示される | ブラウザから本文を送る、通知2xxだけで成功とする |
| 委任 | 子への指示が表示され、実在する Session を会話と Activity で開ける | 私的背景作業で代替、架空のリンク |
| 成果 | 会話の結果と MCP 保存結果が一致し、完了条件別の根拠がある | 自分で dots の代わりに report を返す |
| 本文中の権限拡大指示 | 本文を依頼データとして表示し、grant外の作業は始めない | 本文から許可操作を追加 |
| 通信断と重複イベント | 同じ command と lease を照合し、子を二重作成せず復旧を表示 | 未確認の結果を再実行 |
| 作業終了後 | 新しい作業はなく、購読は継続し、次の実依頼イベントを受けられる | 自律的な新規作業・定期推論ポーリング |
| 制約を適用できない | 作業前に会話とMCPへ同じブロッカーを返す | native権限の制約を弱めて成功にする |

以前の [実接続往復](live-acceptance-2026-10-11.md) は監査表示変更前の別試験であり、この受入の成功を代替しない。
