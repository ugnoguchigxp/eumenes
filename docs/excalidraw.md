# Excalidrawの図を描く・編集する

2026年10月14日。Eumenesのアーティファクトメニュー「図を描く・編集する」または会話から編集画面を準備する。編集画面は右側のアーティファクト内にiframeで表示し、会話を見ながら図を編集できる。開いた直後は新しい図の編集画面を表示する。新しい図は何か描くか名前を変えて保存したときに初めてLARMへ作成し、何もしないで閉じた図は保存しない。「図一覧」のメニューから新しい図を作成し、保存済みの図をサムネイルから選ぶ。開いている図以外は一覧の削除ボタンから確認のうえ削除できる。選択後はメニューを閉じ、編集領域を広く使う。全画面は任意で、切替時にも同じ編集画面を保持する。

## 接続と認証

LARM接続先は既存のsettings.larmを使用する。Local Service IDは`excalidraw-host`。図保存用BearerとLocal Services consumer用Bearerを別々にbackend設定へ保存する。LLM/control/admin tokenは使用しない。credentialはsettingsの既存master keyで暗号化し、API・ブラウザ・モデル・URLへ返さない。

認証済み`PUT /api/settings/excalidraw`で`expectedRevision`、`gatewayUrl`（backendから到達するgateway入口）、`gatewayOrigin`（Linux側gatewayの元origin、省略時はgatewayUrl）、`leaseEndpoint`（ready leaseに返されるendpoint）、`consumerToken`、`appToken`を保存する。新規・入口変更時は両方のcredentialが必要。`GET /api/settings/excalidraw`は入口、設定revisionとcredentialの有無のみを返す。通常の編集操作で利用者へキー入力は求めない。

Linux上のloopback入口をMacBookから直接使わない。MacBook上のbackendから到達する認証済み中継を`gatewayUrl`へ設定する。中継のポートが元のgatewayと異なる場合は`gatewayOrigin`を保存する。backendはそのHostを送信し、Linux側gatewayのHost検査へ合わせる。EumenesはOrigin/Cookie/利用者Bearerを上流へ転送せず、上流業務Bearerだけを付ける。readyのendpointは設定済み`leaseEndpoint`と完全照合し、ポート番号をservice identityにはしない。

既存のhosted画面にはroot相対asset、`/api/documents`、`/auth/session`、`/activity`があり、接続キー入力を前提とする。prefix proxyでその画面を埋め込まず、同版（0.18.1）のExcalidraw編集部品をEumenesのWeb入口でホストする。asset・フォントは`/excalidraw-assets/`から配信し、sceneはEumenes APIを通して上流のscene保存APIへ送る。gatewayのブラウザ用auth cookieを作成する必要はない。Eumenesの既存API認証とOrigin検査をそのまま使う。現在のEumenesは一つのローカルAPI利用者を前提とし、その専用app credentialのownerが上流の図を所有する。

## 公開APIと保存

| API | 契約 |
| --- | --- |
| POST `/api/excalidraw/sessions` | `requestId`（UUID）、`conversationId`（既定main）、新規の`title`または保存済み`referenceId`、任意の`revision`。202でsessionのstarting/ready/failedを返す。冪等requestIdの内容変更は409。新規はleaseだけを確保し、上流の図は作らない |
| GET `/api/excalidraw/sessions/{id}` | 状態のみ。起動・renew・上流のactivity要求をしない |
| POST `/api/excalidraw/sessions/{id}/reconnect` | 利用者の操作による再接続。startingは重複起動しない |
| GET `/api/excalidraw/sessions/{id}/document` | 上流sceneと版を取得。利用者による再表示なので必要なら再起動 |
| POST `/api/excalidraw/sessions/{id}/document` | 新しい図の初回保存。`title`、`scene`と`Idempotency-Key`が必要。上流へ作成し、保存後のsceneを確認してから参照を作る。応答は図と`referenceId`。作成済みのsessionへの再送は同じ図を返し、同じsessionの同時作成は直列化する。lease交換後の再送は同じキーと同じpayloadで行い、上流がowner＋キーで永続的に重複排除して元の作成結果を返す（内容違いは409）。キーは上流と同じ8〜128文字の英数字・`.`・`_`・`-`だけを受け付ける |
| PUT `/api/excalidraw/sessions/{id}/document` | `title`、`scene`、`expectedRevision`と`Idempotency-Key`が必要。原本は上流へ保存し、確認後に参照の版を更新 |
| POST `/api/excalidraw/sessions/{id}/activity` | 編集・キー入力等の実操作で利用権を維持。表示/監視timerから呼ばない |
| DELETE `/api/excalidraw/sessions/{id}` | 自分のleaseだけを解放。共有serviceの強制停止ではない |
| GET `/api/excalidraw/references` | 保存済み図ID・版・名前・作成元会話の参照。sceneの二重正本を作らない |
| DELETE `/api/excalidraw/references/{id}` | `conversationId`（既定main）の参照だけを削除する。短いleaseで上流の`DELETE /api/documents/{documentId}`を確認してから参照を消す。上流のDELETEが404でも、文書を読み取れる場合は削除未対応のhostとして`excalidraw_delete_unsupported`を返し、参照を残す。読み取りも404なら削除済みとして参照を消す。削除した図を開いている編集sessionは閉じ、未保存の内容はブラウザ下書きとダウンロードで保護する。204 |
| GET `/api/excalidraw/operations` | 会話担当のplanning/starting/completed/failed/cancelled。モデルへ渡す結果とOpenUIの入口 |

ready URLはEumenesのWeb originにある`/#drawing/{referenceId}?revision={revision}`。新しい図は`/#drawing/new/{draftId}`（任意で`title`・`conversationId`）で、ブラウザ内の未保存の編集画面を開く。初回保存で作成した参照のURLへ再読み込みなしで置き換える。会話から新しい図を頼まれた場合もこの未保存リンクを返し、LARMには接続しない。main以外の会話では`conversationId`もURLへ付け、編集画面の再表示要求へ渡す。会話と参照の一致はbackendで引き続き検査する。URLにcredentialを含めない。歴史版も取得できるが、保存には現在版との一致が必要で、競合時に上書きはしない。版指定を省いた再表示は上流の最新版から復帰する。

アーティファクトはこのURLの同一origin・図ID・版・会話を検証し、専用入口`/excalidraw?embedded=1#drawing/{referenceId}?...`へ変換する。専用入口だけが同一originのiframeを許可し、親子の通知も送信元originとwindowを照合する。通知するのは表示状態と編集操作で、credentialやsceneは渡さない。APIと通常画面の埋め込み拒否は維持する。保存処理は既存のEumenes編集画面とAPIを使用し、原本はLARMに保存する。LARMの画面や認証方式の追加開発は不要。

メニューを開いたときだけ保存済みsceneから小さなPNGを生成する。メニューを閉じたら未完了の取得を取り消し、取得用sessionを解放する。表示中のサムネイルを定期取得してserviceを常駐させない。未保存の変更がある場合は図の切替とアーティファクトの閉じる操作を止め、保存・再接続・下書き復元・ダウンロードを選べる。別のアーティファクトへ切り替えても編集中のiframeは保持する。

図はExcalidraw scene APIへ保存し、Eumenesには参照と操作状態をSQLiteに保持する。保存応答のID・版と保存後のsceneを確認したときだけ保存済みとする。保存失敗時は同じkey/expectedRevisionで再送する。失敗した保存候補と、その後の編集は別々にブラウザ下書きへ残し、再読込み後に「下書きを復元」できる。保存未確定の画面は閉じる操作とbeforeunloadで保護し、下書きのダウンロードも提供する。

最後の実操作から30秒でEumenesのleaseを解放する。HTTP処理中・起動待ちは解放しない。Linux側の正式gatewayは最後の業務要求から180秒で自身のleaseを解放し、service側の120秒idle確認後に停止する。実際の停止はLARMの正式設定に依存する。監視GETで常駐させず、次の編集・保存・再表示でensureする。bindingのgeneration/bootEpoch/revisionを確認し、取消・設定変更後の遅い応答は採用しない。backend再起動後は古いsessionをidleへ戻し、参照から新しいleaseで復帰する。

## 検証と配備状況

`bun test api/domains/excalidraw/test/excalidraw.test.ts api/application/media/excalidraw-e2e.test.ts`、`bun run verify -- --domain excalidraw`、影響のある利用側domainのverifyを使う。ブラウザfixtureは`bunx playwright test tests/browser/excalidraw.spec.ts`。fixtureは実サービスの応答形状（保存応答はmetadata、sceneは別GET）に合わせ、LARM/backend保存先は隔離する。

`bun scripts/excalidraw-live.ts --check`はbackend settingsの読み取り専用操作で保存済みLARM入口と専用接続の有無を確認する。consumer未設定時にLLM/admin tokenでlease要求はしない。

正式gatewayはactive/enabled、workerはオンデマンド起動する。専用consumer `eumenes-excalidraw`は登録済みで、許可サービスが`excalidraw-host`だけであること、consumer用と図保存API用の資格情報が別であることを確認した。Eumenesの暗号化設定revision 1とMacBookのSSH中継を使い、正式環境の編集・保存・停止・復帰を実接続で確認した。Linux側の配備・登録は変更していない。

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

## 検証順序

1. `bun run verify -- --domain excalidraw`とsettings/client関連試験で、会話付きURL、履歴復帰、下書き領域の障害、取消後の解放を確認する。
2. application結合試験と`bunx playwright test tests/browser/excalidraw.spec.ts`で、既存の作成・描画・保存・下書き復元・再表示を確認する。
3. 影響のある利用側domainをverifyし、変更範囲に応じて型検査・buildを確認する。全件ブラウザE2Eは実行しない。以前の境界違反は、その時点の状態を再確認する。
4. LARMの専用登録・MacBook backend用経路・Eumenes設定が揃い、他consumerがworkerを利用していない状態で、以下の正式接続ブラウザ試験を明示的に有効化する。

```sh
EUMENES_EXCALIDRAW_LIVE=1 bunx playwright test tests/browser/excalidraw-live.spec.ts
```

正式接続試験は稼働中のEumenes Web/APIを使い、cold起動→ブラウザ描画→版2/3保存→sceneの再取得→無操作解放→systemd workerの実停止→再起動と再表示を確認する。通常の試験実行ではskipする。workerの強制停止は行わず、受入用の新規図を作成し、証拠として残す。SSHはsystemdのPIDを読み取るだけで、配備や管理者操作は行わない。Web originは`EUMENES_EXCALIDRAW_WEB_ORIGIN`、観測用SSHホストは`EUMENES_EXCALIDRAW_SSH_HOST`で指定可能（既定5173/gnosis）。

証拠は`spec/verification/excalidraw-live/`へ保存する。Eumenes backend自体の再起動後の復帰、実LLMによる会話からの起動は別に確認する。保存応答喪失・版競合・下書き保護は固定試験で確認しており、liveで障害を発生させた結果とは区別する。

## 現在の受入状況

### Artifact内iframeへの変更

2026年10月14日、採用した画面案をmainに実装した。Excalidrawのdomain verify（backend 7件、Web 18件）、利用側Artifactのverify（50件）、API結合4件とWebビルドは成功。最終確認時には並行改修中のsettings-dataとToolchainArtifactHostに4件の型エラーがあったが、commit前の再確認では解消され、1,374ファイルの型検査が成功した。対象ブラウザの別タブ編集シナリオとArtifact内iframeシナリオは個別に成功し、未保存の図切替・タブ閉じの保護、下書き復元、保存失敗、無操作解放、再接続、fixtureの再起動復帰を確認した。全件E2Eは実行していない。

正式接続ではMacBook上のブラウザでArtifact内に矩形を描画し、LARMへの版2/3保存、サムネイル表示、再読み込み後の版3・矩形1個、無操作解放後の再接続を確認した。workerの物理停止とbackend再起動は今回繰り返しておらず、以下の旧画面の実機受入と区別する。証拠と変更範囲は[iframe編集の記録](../spec/.archived/excalidraw-artifact-2026-10-14.md)、実接続の結果は`spec/verification/excalidraw-live/artifact-2026-10-14.json`に保存した。LARM側の追加開発・配備変更は不要だった。

### 旧画面での実機受入

2026年10月14日、当時のmainの固定版（0cacd23）で実接続受入を実施した。MacBookのBraveで、実LLMが返したURLから描画・版2保存・再表示、backend再起動後の同じsceneと設定の保持、追加編集・版3保存を確認した。ブラウザを表示したままworkerがPID 0へ自然停止し、「再接続」から別PIDで復帰した後、矩形3個を版4で保存・再表示できた。実LLMによるmain会話の担当選択、回答リンク、Artifactの一覧・準備中・利用可能・編集画面への移動も確認済み。

固定の部分試験・API結合・ブラウザfixtureは成功。正式接続の自動通し試験は、自然停止後にブラウザが閉じられたため未完走であり、MacBook実画面による受入とは分ける。当時のverify:allは既存のsettings→memory試験依存違反で未完了であり、当時の並行改修による共有clientの契約不整合も実接続受入には含めていなかった。この旧記録を現在の全体gateの結果として扱わない。証拠は`spec/verification/excalidraw-live/native-acceptance-2026-10-14.json`、詳細は`spec/.archived/excalidraw-work-record-2026-10-13.md`に記録する。
