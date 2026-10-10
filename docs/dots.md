# Codex／dots への作業委任

更新: 2026-10-11。

Eumenes は依頼、許可する範囲、質問、結果を保存する。dots はその依頼を受け取り、登録した Codex プロジェクトの Session を調整する。文章・資料・調査・実装を同じ契約で扱い、依頼の意味と委任先の選択は会話の LLM に委ねる。

製品側の処理と隔離試験を実装した。**製品接続での実 dots の受入は未実施**。以前の [単体 MVP](../spec/verification/dots-mvp/acceptance-2026-10-10.md) の成功と、今回の製品統合の検証は区別する。

## 設定して使う

1. 「設定 → Codexへの委任」で接続を保存する。
2. Codex で返された実際のプロジェクト ID とホスト ID を登録する。ローカル／クラウドの実行場所、許可操作、使用する担当の版も選ぶ。
3. 必要なら「担当とSkill」で役割と手順を保存し、プロジェクトの「担当」でその版を選ぶ。標準の調整担当も利用できる。
4. dots 側に MCP を登録し、`command.available` の受信を有効にする。設定画面の受信登録は購読の有効期限を表示する。購読が有効でも、仕事の実行成功を意味しない。
5. 会話で依頼するか、設定画面の「作業を依頼」から目的・完了条件・Session 数の上限を指定する。画面からの依頼の実行期限は2時間。会話の LLM は保存済みプロジェクトと許可操作から選び、対象が不明な場合は確認する。
6. dots の質問に回答すると、同じタスクに answer コマンドを追加する。元の許可範囲は広がらない。完了・失敗・次の作業なしの報告は元の会話にも届く。画面から作った作業の結果は作業詳細で確認する。

「一時停止」「取消」は停止要求を保存する。dots が全 Session の停止を報告するまで「停止確認待ち」となる。本文削除後も、停止に必要な識別子を保持する。Eumenes 自身が Codex の Session を直接強制停止する API は実装していない。

停止コマンドの24時間の期限が切れた場合は、maintenance が同じコマンドと lease のまま期限を更新して再配送する。Session 数の許可を減らした後も、既存の全 Session の停止確認は受け付ける。無効化した接続でも停止待ちが残る間は受信登録を更新できる。

### 同じ PC の Codex から接続する

OAuth を設定していない接続には、作成時に一度だけ専用のローカルトークンを表示する。Codex の MCP 接続設定に `http://127.0.0.1:8787/mcp/dots/<接続ID>` と、このトークンの Bearer ヘッダーを登録する。API のポートを変更している場合は実際のポートを使う。

このトークンは接続ごとに生成し、保存するのはハッシュだけ。Eumenes 全体の管理トークンを MCP に渡さない。トークンを紛失した場合は新しい接続を作り、プロジェクトを新しい参照として登録する。既存の接続のトークンを再表示・再発行する機能は今回含めていない。

ローカル接続は loopback の HTTP に限定する。転送を示すヘッダーがある要求を拒否する。Codex 側のローカル MCP 登録だけでは、クラウドの dots に対する Events 受信登録は完了しない。

作業の履歴があるローカル接続は OAuth へ変更できない。未開始の依頼や、実行前に取り消して本文が残っている依頼も対象となる。別の認証所有者へ依頼本文を引き継がないため、新しい接続を作成する。

### 外部の dots から接続する

公開 HTTPS と既存の OAuth 認証サービスを用意し、接続設定に次の値を保存する。

| 値 | 用途 |
| --- | --- |
| 発行元 `issuer` | トークンの `iss` と一致する認証サービス |
| 公開鍵 `jwksUrl` | HTTPS の JWKS。署名の検証に使用 |
| 公開 MCP URL `resource` | トークンの `aud` と一致する対象 URL |
| ユーザー識別子 `subject` | この接続の所有者の `sub` |

アクセストークンは署名付き JWT とし、`exp`、`iat`、`iss`、`aud`、`sub` を必須とする。署名は RS256／ES256／EdDSA、発行から最大1時間、必須 scope は `dots:read dots:report dots:events`。ブラウザや dots に製品の管理トークンを配布しない。

接続の認証所有者を固定するため、保存済みの発行元・対象 URL・ユーザー識別子は変更しない。変更には新しい接続を作る。ローカル接続で既に仕事を登録した場合も、OAuth用には新しい接続を作る。公開鍵 URL は更新できる。

OAuth Authorization Server 自体は外部サービスを使う。認可・コード交換・PKCE・refresh・クライアント登録など、dots が要求する認証フローはそのサービスで提供する。Eumenes は Resource Server として JWT を検証し、未認証応答の `WWW-Authenticate` と次の公開メタデータを返す。

```
/.well-known/oauth-protected-resource/mcp/dots/<接続ID>
/mcp/dots/<接続ID>
```

公開 URL のパスは `/mcp/dots/<接続ID>` にする。設定を保存した後、同じ管理認証環境のシェルから次の入口を起動できる。

```sh
bun scripts/dots-gateway.ts <接続ID>
```

gateway は保存済み接続設定を API から取得し、既定で `127.0.0.1:8799` に待ち受ける。既存の TLS リバースプロキシをこの入口へ接続する。MCP とメタデータの2つのパスだけを転送し、`/api` や Cookie は転送しない。転送済みの印を必ず付けるため、ローカル専用トークンを公開接続に流用できない。`EUMENES_URL` と `EUMENES_DOTS_GATEWAY_PORT` でローカルの転送先とポートを指定できる。

HTTPS 証明書、公開 DNS、OAuth サービスの配備は今回の実装に含めていない。単体 MVP の一時公開接続に製品 DB・設定・秘密を接続しない。

## 会話と実行契約

会話 LLM に `delegate_task` の start／inspect／answer／stop と、保存済み対象の参照を提示する。利用者の manual／voice 発話からだけ実行を受け付け、別の会話のタスク参照や、準備後に設定が変わった参照を拒否する。資料や報告の本文を権限に変えない。保存済み受付を再度 LLM に渡すため、受付の説明だけを行う再推論では新しいタスクを作らない。

会話からの依頼は、LLM が整理した作業内容を task.request に保存し、元の発話をコマンドの snapshot.sourceRequest に別途固定する。長い日本語の発話と作業内容を一つの本文へ重ねて保存し、保存上限を超えることを避ける。

`kind: orchestration` は既存 tasks の状態・CAS・期限・質問を使用する。coding の runner、権限、decision budget は別契約として維持する。外部 Events の購読・署名と Session のコマンド台帳だけを dots domain に追加した。

| MCP ツール | 内容 |
| --- | --- |
| `list_pending_commands` | この接続の pending／claimed コマンドの参照。最大100件、cursor で続きを取得 |
| `get_command` | 権限・期限・版を検査した固定スナップショット |
| `claim_command` | UUID lease による実行の取得。別 lease からの二重取得は拒否 |
| `get_task_snapshot` | 最新状態、質問、Session 参照、最後に採用した sourceSequence |
| `report_task` | 進捗・質問・成果・停止・リマインドの構造化報告 |

start／answer／reconcile／stop／reminder は別のコマンド。取得後に状態が変わっても、claim と report の採用時に再度検査する。authorityEpoch、executionGeneration、期限、接続・プロジェクトの版、担当の hash／generation が合わない報告を採用しない。停止時だけ、失効した担当本文を渡さず停止の照合を許可する。

再起動時は未回答質問を維持し、実行中の仕事には reconcile を作る。保存済みの Session を再利用する。Session 作成後にその参照が保存される前に途切れたケースでは、dots が taskId で既存 Session を照合する。照合できなければ質問を報告する。Eumenes が未報告の native Session の存在を独立して確認する機能はない。

### 報告と再試行

報告は UUID の `reportId`、`commandId`、`taskId`、authorityEpoch、executionGeneration、sourceSequence を含める。同じ reportId と同じ内容の再送は保存済み受付を返す。内容が異なる再送は拒否する。

sourceSequence はタスク全体で1ずつ増やす。**順不同のバッファは持たず、欠番を409で拒否する**。通信結果が不明な場合は同じ報告を再送し、欠番では snapshot を取得して保存済み番号を照合してから順番に再送する。日時や本文の意味で重複を推定しない。

- `accepted`／`session_started`／`progress`: 受領・作業中の状態。Session ごとに threadId／projectId／hostId／parentThreadId を報告する。
- `blocked`: questionId、質問文、回答形式、選択肢を付ける。回答を待ち、answer で再開する。
- `completed`: 完了条件と同数の completionChecks を付け、各条件と報告全体に根拠参照を付ける。
- `failed`／`no_next_work`: 失敗または次の許可済み作業がないことを報告する。
- `stopped`: childrenStopped=true と、保存済みの全 Session 参照を付ける。停止不能な子が残る場合は完了扱いにしない。

返却の `verification: dots_reported` は、dots の報告を契約に沿って採用したことを示す。検証結果や native Session の実在を独立に証明した値ではない。Eumenes は他プロジェクト、他ホスト、Session 数の超過、重複所有、取消後の完了報告を拒否する。native の編集・公開・送信などの実操作の制限は Codex 側にも設定する。MCP の検査だけで native の全ツールを制御できるとは扱わない。

Session を開始できる前の blocked／failed も報告できる。完了済みのタスクへ新しい Session を追加することはできない。

## 担当、サブエージェント、Skill

「担当とSkill」の保存で、profile、1〜4個の Skill、既存の dots ツールを束ねた capability package の新しい版を作る。保存時に stateToken を検査し、既存の本文を上書きしない。版・依存・hash・generation の固定と失効検査は既存 capabilities を使う。指示と手順の合計は UTF-8 JSON 表現で14,000バイト以内。

Session 数はタスク grant の上限で管理する。サブエージェントの分け方や役割、使うツールは dots が依頼から判断し、全子 Session の参照を報告する。Eumenes は特定の語句ごとに「調査」「実装」へ振り分けるコードを追加していない。既存チャットへ続行指示を送る場合は、その参照と操作権限が明示されている必要がある。

前のタスクの Session を続行する場合は、同じ接続・登録プロジェクトで、grant.sessionRefs と continue_session を明示する。前の作業が終了または一時停止している必要があり、同じ Session を複数の実行中タスクで使うことは拒否する。タスクごとの Session 紐付けを保存するため、旧タスクの保持期限や本文削除で新しいタスクの参照は消えない。

MCP は `skills/list`／`skills/get`／`resources/read` で標準の `eumenes-coordinator` Skill を提供し、UTF-8 本文の SHA-256 digest を返す。これは MCP の接続・報告手順で、変更した場合は dots 側のツール／Skill 検出を更新する。設定画面の担当・Skill はコマンド取得時に渡す実行コンテキストで、native の Skill インストールそのものではない。

## 登録済み予定からのリマインド

予定は利用者が Codex 側で作る。Eumenes でタスクの「登録済みのリマインドを紐付ける」にその予定 ID を登録すると、専用の reminder commandId と7日間の報告期限を発行する。画面に表示する指示を、その Codex 予定へ渡す。

管理 API は `POST /api/dots/tasks/<taskId>/schedules` に `{ "scheduleRef": "予定ID" }` を送り、`{ taskId, scheduleRef, commandId, expiresAt }` を受け取る。予定の実在を Eumenes から照会する機能はない。利用者が登録した識別子を結び付ける操作である。

各予定実行では現在の snapshot を取得し、同じ reminder コマンドと lease を使う。report_task の kind=reminder と reminder={scheduleRef, occurrenceRef} を付ける。同じ occurrenceRef は二度通知しない。作業が完了し、元の実行期限が過ぎても期限内のリマインドは受け付ける。リマインドの権限で新規 Session を開始・再開できない。取消・本文削除・接続やプロジェクト設定の変更後は旧リマインドを拒否する。

質問への回答と再起動だけでは予定の紐付けを失効させない。一時停止後の再開などで権限が変わった場合は、同じ予定IDを明示的に紐付け直すと、新しい reminder コマンドを返す。

今回、利用者の Codex 予定は作成・変更していない。Eumenes の60秒ごとの maintenance は期限・失効の照合であり、次に着手する仕事を選ぶための LLM は動かさない。

## 保存と配送の制限

- 接続8件、プロジェクト64件、担当 package32件。
- コマンドは通常3840件まで。停止用に256件を残し、総数4096件まで。
- 通常報告は各タスク1000件まで。停止確認はその件数制限とは別に受け付ける。
- summary、facts、limitations、evidenceRefs の合計は UTF-8 JSON 表現で12,000バイト以内。日本語を含む報告も共通の保存上限に収まるよう、MCP の契約で検査する。
- dots のコマンド・報告・会話受付の本文は合計64 MiB。通常処理は56 MiBまでとし、停止用に8 MiBを残す。担当の revision は別の64 MiB上限を持つ。
- tasks の既存保存期限・本文削除を dots 台帳と報告にも適用する。削除後に元本文や担当のスナップショットを再公開しない。

Webhook に本文を載せず、command_id と queue_id のみを送る。challenge 検証、署名、暗号化した secret 保存、60秒の旧新署名の併用、HTTP 応答サイズ・時間制限、公開 HTTPS と DNS／接続先の検査を行う。同じ callback と secret の確認を10分キャッシュする。購読期限は認証した JWT の失効時刻も超えない。

JWT の exp が長く設定されていても、購読期限は iat から最大1時間までに制限する。

Queue が満杯でもコマンドを保存し、60秒ごとの maintenance で配送登録を再試行する。停止要求の保存を配送待ちで取り消さない。Queue で最大5回配送を再試行し、同じ配送の eventId を保持する。HTTP 2xx は受信確認であり、仕事の受領・完了の証明ではない。再購読では pending 参照を再配送できる。lease を時間だけで他者へ自動譲渡せず、二重実行を避ける。

## 検証と次の受入

隔離した一時 DB とテスト用認証情報で、会話からの受付、固定版の失効、MCP の実要求、署名付き Events、質問・回答・再開・完了・取消、再起動、リマインド重複、保存容量と停止を試験した。ブラウザ試験は実 backend と画面を使い、Session 自体と報告内容は fixture である。

```sh
bun run verify -- --domain dots
bun run verify:all
bun test api/domains/dots api/application/dots-tasks.test.ts api/application/dots-review.test.ts api/application/dots-dialogue.test.ts api/application/dots-http.test.ts scripts/dots-gateway.test.ts packages/dots-mcp/test
bun x playwright test tests/browser/dots.spec.ts
```

実 dots の製品受入には、認証付きの公開 MCP 接続と対象プロジェクトの登録が必要。接続後に、新規 Session、ブロッカー、回答後の同一 Session の再開、成果と根拠、no_next_work、取消後の全子停止、再起動時の照合、予定からの一回のリマインドを確認する。これらを確認するまで、製品接続の完成とは記録しない。

参照: [実装計画](../spec/dots-toolchain-agent-skill-implementation-plan-2026-10-10.md)、[MCP server](https://developers.openai.com/plugins/build/mcp-server)、[MCP Events](https://developers.openai.com/plugins/build/mcp-events)、[OAuth](https://developers.openai.com/plugins/build/auth)。
