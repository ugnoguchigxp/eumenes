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

ready URLはEumenesのWeb originにある`/#drawing/{referenceId}?revision={revision}`。URLにcredentialを含めない。歴史版も取得できるが、保存には現在版との一致が必要で、競合時に上書きはしない。版指定を省いた再表示は上流の最新版から復帰する。

図はExcalidraw scene APIへ保存し、Eumenesには参照と操作状態をSQLiteに保持する。保存応答のID・版と保存後のsceneを確認したときだけ保存済みとする。保存失敗時は同じkey/expectedRevisionで再送する。失敗した保存候補と、その後の編集は別々にブラウザ下書きへ残し、再読込み後に「下書きを復元」できる。保存未確定の画面は閉じる操作とbeforeunloadで保護し、下書きのダウンロードも提供する。

最後の実操作から30秒でEumenesのleaseを解放する。HTTP処理中・起動待ちは解放しない。Linux側gatewayは自身のleaseを30秒で解放し、service側の60秒idle確認後に停止する。実際の停止はLARMの正式設定に依存する。監視GETで常駐させず、次の編集・保存・再表示でensureする。bindingのgeneration/bootEpoch/revisionを確認し、取消・設定変更後の遅い応答は採用しない。backend再起動後は古いsessionをidleへ戻し、参照から新しいleaseで復帰する。

## 検証と配備状況

`bun test api/domains/excalidraw/test/excalidraw.test.ts api/application/excalidraw-e2e.test.ts`、`bun run verify -- --domain excalidraw`、利用側domainと`bun run verify:all`を使う。ブラウザfixtureは`bunx playwright test tests/browser/excalidraw.spec.ts`。fixtureは実サービスの応答形状（保存応答はmetadata、sceneは別GET）に合わせ、LARM/backend保存先は隔離する。

`bun scripts/excalidraw-live.ts --check`はbackend settingsの読み取り専用操作で保存済みLARM入口と専用接続の有無を確認する。consumer未設定時にLLM/admin tokenでlease要求はしない。

調査時点のgnosisはLocal Servicesが無効、`/etc/larm/local-services/consumers.json`なし、Excalidrawの正式systemd unitとgateway設定なし。正式配備・専用consumer登録・MacBook backendから到達するgateway経路が揃うまで、正式環境でのcold起動/編集/保存/idle停止のlive受入は未実施。fixtureの成功を正式配備済みとは扱わない。
