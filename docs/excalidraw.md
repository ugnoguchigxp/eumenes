# Excalidrawの図を描く・編集する

2026年10月13日。Eumenesのアーティファクトメニュー「図を描く・編集する」または会話から編集画面を準備する。新しい図を作成し、利用可能になってから「Excalidrawを開く」で別のブラウザタブへ移動する。保存済みの図は一覧から再表示できる。

## 接続と認証

LARM接続先は既存のsettings.larmを使用する。Local Service IDは`excalidraw-host`。図保存用BearerとLocal Services consumer用Bearerを別々にbackend設定へ保存する。LLM/control/admin tokenは使用しない。credentialはsettingsの既存master keyで暗号化し、API・ブラウザ・モデル・URLへ返さない。

認証済み`PUT /api/settings/excalidraw`で`expectedRevision`、`gatewayUrl`（backendから到達するgateway入口）、`gatewayOrigin`（Linux側gatewayの元origin、省略時はgatewayUrl）、`leaseEndpoint`（ready leaseに返されるendpoint）、`consumerToken`、`appToken`を保存する。新規・入口変更時は両方のcredentialが必要。`GET /api/settings/excalidraw`は入口、設定revisionとcredentialの有無のみを返す。通常の編集操作で利用者へキー入力は求めない。

Linux上のloopback入口をMacBookから直接使わない。MacBook上のbackendから到達する認証済み中継を`gatewayUrl`へ設定する。中継のポートが元のgatewayと異なる場合は`gatewayOrigin`を保存する。backendはそのHostを送信し、Linux側gatewayのHost検査へ合わせる。EumenesはOrigin/Cookie/利用者Bearerを上流へ転送せず、上流業務Bearerだけを付ける。readyのendpointは設定済み`leaseEndpoint`と完全照合し、ポート番号をservice identityにはしない。

既存のhosted画面にはroot相対asset、`/api/documents`、`/auth/session`、`/activity`があり、接続キー入力を前提とする。prefix proxyでその画面を埋め込まず、同版（0.18.1）のExcalidraw編集部品をEumenesのWeb入口でホストする。asset・フォントは`/excalidraw-assets/`から配信し、sceneはEumenes APIを通して上流のscene保存APIへ送る。gatewayのブラウザ用auth cookieを作成する必要はない。Eumenesの既存API認証とOrigin検査をそのまま使う。現在のEumenesは一つのローカルAPI利用者を前提とし、その専用app credentialのownerが上流の図を所有する。

## 公開APIと保存

| API | 契約 |
| --- | --- |
| POST `/api/excalidraw/sessions` | `requestId`（UUID）、`conversationId`（既定main）、新規の`title`または保存済み`referenceId`、任意の`revision`。202でsessionのstarting/ready/failedを返す。冪等requestIdの内容変更は409 |
| GET `/api/excalidraw/sessions/{id}` | 状態のみ。起動・renew・上流のactivity要求をしない |
| POST `/api/excalidraw/sessions/{id}/reconnect` | 利用者の操作による再接続。startingは重複起動しない |
| GET `/api/excalidraw/sessions/{id}/document` | 上流sceneと版を取得。利用者による再表示なので必要なら再起動 |
| PUT `/api/excalidraw/sessions/{id}/document` | `title`、`scene`、`expectedRevision`と`Idempotency-Key`が必要。原本は上流へ保存し、確認後に参照の版を更新 |
| POST `/api/excalidraw/sessions/{id}/activity` | 編集・キー入力等の実操作で利用権を維持。表示/監視timerから呼ばない |
| DELETE `/api/excalidraw/sessions/{id}` | 自分のleaseだけを解放。共有serviceの強制停止ではない |
| GET `/api/excalidraw/references` | 保存済み図ID・版・名前・作成元会話の参照。sceneの二重正本を作らない |
| GET `/api/excalidraw/operations` | 会話担当のplanning/starting/completed/failed/cancelled。モデルへ渡す結果とOpenUIの入口 |

ready URLはEumenesのWeb originにある`/#drawing/{referenceId}?revision={revision}`。main以外の会話では`conversationId`もURLへ付け、編集画面の再表示要求へ渡す。会話と参照の一致はbackendで引き続き検査する。URLにcredentialを含めない。歴史版も取得できるが、保存には現在版との一致が必要で、競合時に上書きはしない。版指定を省いた再表示は上流の最新版から復帰する。

図はExcalidraw scene APIへ保存し、Eumenesには参照と操作状態をSQLiteに保持する。保存応答のID・版と保存後のsceneを確認したときだけ保存済みとする。保存失敗時は同じkey/expectedRevisionで再送する。失敗した保存候補と、その後の編集は別々にブラウザ下書きへ残し、再読込み後に「下書きを復元」できる。保存未確定の画面は閉じる操作とbeforeunloadで保護し、下書きのダウンロードも提供する。

最後の実操作から30秒でEumenesのleaseを解放する。HTTP処理中・起動待ちは解放しない。Linux側gatewayは自身のleaseを30秒で解放し、service側の60秒idle確認後に停止する。実際の停止はLARMの正式設定に依存する。監視GETで常駐させず、次の編集・保存・再表示でensureする。bindingのgeneration/bootEpoch/revisionを確認し、取消・設定変更後の遅い応答は採用しない。backend再起動後は古いsessionをidleへ戻し、参照から新しいleaseで復帰する。

## 検証と配備状況

`bun test api/domains/excalidraw/test/excalidraw.test.ts api/application/excalidraw-e2e.test.ts`、`bun run verify -- --domain excalidraw`、利用側domainと`bun run verify:all`を使う。ブラウザfixtureは`bunx playwright test tests/browser/excalidraw.spec.ts`。fixtureは実サービスの応答形状（保存応答はmetadata、sceneは別GET）に合わせ、LARM/backend保存先は隔離する。

`bun scripts/excalidraw-live.ts --check`はbackend settingsの読み取り専用操作で保存済みLARM入口と専用接続の有無を確認する。consumer未設定時にLLM/admin tokenでlease要求はしない。

初回調査ではLocal Servicesと正式サービスが未配備だった。2026年10月13日22:28 JSTの再確認では正式gatewayがactive/enabled、worker unitは登録済み/inactive、Local Servicesは有効。現行consumerに`eumenes-hosted-apps`があるが、LLM tokenと分離されたExcalidraw専用Eumenes consumerの登録完了は未確認。正式配備と専用登録は利用者からLARM側へ依頼済み。こちらからLinux設定を変更しない。正式環境の編集・保存・停止・復帰は未検証。

## LARM側の準備後に行う接続設定

LARM側から、backendから到達する`gatewayUrl`、gatewayの元originである`gatewayOrigin`、ready leaseに返る`leaseEndpoint`、Eumenes専用の`consumerToken`と`appToken`を受け取る。credentialの引渡し方法はLARM側と合わせ、チャット本文やリポジトリに保存しない。SSHの固定パスから既存秘密を取り出す処理や、暫定sudo登録スクリプトは使用しない。

接続情報をMacBookのリポジトリ外に、現在の利用者だけが読める通常ファイル（0600、最大16KiB）として準備できる場合、以下の受入処理を使う。JSONのキーは上記の5つ。`gatewayOrigin`は省略可能。consumer/appの双方が必要で、役割間やLLM credentialとの流用は拒否する。API認証トークンは既存のbackend用読取処理で取得する。

```sh
bun scripts/excalidraw/configure-live.ts /absolute/private/connection.json
bun scripts/excalidraw/configure-live.ts /absolute/private/connection.json --apply
```

1行目は入力を確認するだけで、通信・設定保存を行わない。2行目は稼働中のEumenes backendから設定revisionを取得し、既存の認証済み設定APIへ暗号化保存を依頼する。接続先のprobe、lease確保、描画は行わず、保存成功を実接続成功と表示しない。backend APIの既定入口は127.0.0.1:8787。異なる場合だけ`EUMENES_API_URL`で指定し、既存clientのloopback検査を適用する。

## 編集画面の復帰と保護

ブラウザ履歴から編集画面が復元された場合は、pagehideで解放したsessionを再利用せず、新しいsessionを取得する。編集中のscene・タイトル・未確定の保存候補は保持する。再接続中に画面を閉じた場合は結果の採用を取り消し、遅れて返ったsessionも解放する。ブラウザの保存領域へのアクセスが拒否されても編集画面は開ける。上流保存成功後に下書きの削除だけ失敗した場合は、保存済みと削除失敗を分けて表示する。

## 次回の検証順序（今回は未実行）

1. `bun run verify -- --domain excalidraw`とsettings/client関連試験で、会話付きURL、履歴復帰、下書き領域の障害、取消後の解放を確認する。
2. application結合試験と`bunx playwright test tests/browser/excalidraw.spec.ts`で、既存の作成・描画・保存・下書き復元・再表示を確認する。
3. 利用側domain、型検査、buildと`bun run verify:all`を実施する。以前の全体gate停止地点（settings→memoryの境界違反）は、その時点の状態を再確認する。
4. LARMの専用登録・MacBook backend用経路・Eumenes設定が揃い、他consumerがworkerを利用していない状態で、以下の正式接続ブラウザ試験を明示的に有効化する。

```sh
EUMENES_EXCALIDRAW_LIVE=1 bunx playwright test tests/browser/excalidraw-live.spec.ts
```

正式接続試験は稼働中のEumenes Web/APIを使い、cold起動→ブラウザ描画→版2/3保存→sceneの再取得→無操作解放→systemd workerの実停止→再起動と再表示を確認する。通常の試験実行ではskipする。workerの強制停止は行わず、受入用の新規図を作成し、証拠として残す。SSHはsystemdのPIDを読み取るだけで、配備や管理者操作は行わない。Web originは`EUMENES_EXCALIDRAW_WEB_ORIGIN`、観測用SSHホストは`EUMENES_EXCALIDRAW_SSH_HOST`で指定可能（既定5173/gnosis）。

証拠は`spec/verification/excalidraw-live/`へ保存する。Eumenes backend自体の再起動後の復帰、実LLMによる会話からの起動、保存応答喪失や版競合のlive確認は別に実施し、このブラウザ試験だけで合格としない。
