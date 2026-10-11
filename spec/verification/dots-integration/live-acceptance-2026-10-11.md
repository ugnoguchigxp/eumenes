# 実 dots の製品接続試験 — 2026-10-11

結果: **認証付きの依頼・報告の往復を確認。新規 Session と成果返却は未完了**。

ChatGPT の実 dots「セバスチャン」を使用した。試験用接続は `dots-live-20261011`、登録済みの native project は Eumenes (`936c8552-4e66-4179-8e35-466e859940be`)、host は `local`。一時 HTTPS と、この PC の `oidc-provider` を使う OAuth 認証サービスを登録・接続した。認証サービスの自動停止期限は2026-10-11 08:27 JST。恒久運用の配備を意味しない。

## 依頼と観測結果

送信本文:

> 秋の朝の様子を日本語で2文書き、その後に37×24の計算結果を添えてください。登録済みプロジェクトで新規Session1件だけを使い、成果をEumenesへ返してください。既存のチャットは続行せず、ファイル編集、commit、push、公開、外部への連絡は行わないでください。

許可操作は `read` / `create_session` / `check`、Session は最大1件、依頼期限は07:19 JST。本文と完了条件は Eumenes の既存タスク API で保存し、手動で dots に本文を渡さず、Events と MCP の読取ツールで取得させた。

| 観測 | 結果 |
| --- | --- |
| 公開境界 | 認証メタデータ200、未認証 MCP は401、製品 API と承認 API の経路は404 |
| OAuth | ChatGPT で認可・接続が成功。MCP の5ツールと Events を検出 |
| Events | `command.available` / `eumenes-dots` の購読後、配送 job が1回で完了 |
| 実 dots の処理 | command の取得・claim・snapshot 取得、接続先 Mac の project 照合 |
| 報告 | progress と blocked の2件を Eumenes が保存、sourceSequence=2 |
| Session と成果 | sessions=[]、state=waiting_user、結果本文なし。完了条件3件とも未達 |
| 購読終了 | dots が1件限定の指定に従い解除を報告 |

taskId: `c88ff79e-0154-4621-8a89-01e5111dca61`。API の保存結果は [live-result-2026-10-11.json](live-result-2026-10-11.json)、公開境界は [oauth-https-boundary.json](oauth-https-boundary.json)。OAuth 成功画面は [oauth-connected-events.png](oauth-connected-events.png)、購読確認は [dots-subscribed.png](dots-subscribed.png)。

## ブロッカーと残る確認

取得した `eumenes-coordinator` Skill は、要求された制限をプラットフォームが強制できなければ作業前にブロッカーを返すよう指示する。実 dots は `cloud_threads.create` に読取専用・外部送信不可を設定／確認する引数がないと報告し、Session 作成前に停止した。親 dots が代わりに回答を書いても、今回の新規 Session を含む完了条件を満たさない。

Codex のサンドボックス設定の存在と、dots が作成する子 Session にその制限を適用・確認できることは別である。実適用を確認せずに再開したり、Skill を弱めて完了扱いにしない。作成・再開・成果の返却、停止、再起動時の照合、予定からのリマインドは別途受入が必要。

06:55 JST に dots へ、Session を作らず設定も変更せずに利用可能なツールの定義を確認する依頼を送った。dots は `cloud_threads.create` に `environmentConfigId` 等はあるが制限を直接指定する引数はなく、`list_environments` と `read` に適用済み権限を確認する専用機能はないと回答した。これは当該 dots の利用可能なツールに関する報告であり、製品全体に機能が存在しないという証明ではない。[確認依頼と返答の画面](native-permissions-blocker.png)。

公式の [Permissions](https://learn.chatgpt.com/docs/permissions) は、ローカルコマンドの権限設定と、MCP・コネクター・ブラウザ等の権限を区別している。ローカルの read-only 設定だけでは全経路の外部送信禁止を証明できず、Work Cloud に同じ設定が適用されるとも仮定しない。

先行する Eumenes 会話からの依頼試行は `invalid_conversation_operation` で失敗し、タスクを作成していない。今回の実往復は既存タスク API による受付であり、会話からの受付の成功を証明しない。

## 利用者への表示

この試験では、dots に送る依頼内容を送信前に元の Codex チャットへ示し、受け取った進捗・回答・ブロッカーも同じチャットに共有する。MCP による直接の送受信は継続できるが、依頼や返答を利用者に知らせず処理しない。認証情報は表示しない。

## 試験の区別

OAuth のプロトコル試験3件と dots domain の検証は成功した。これらは、実 dots の新規 Session 作成や成果返却を代替しない。以前の [隔離検証](acceptance-2026-10-11.md) と本記録を分けて扱う。
