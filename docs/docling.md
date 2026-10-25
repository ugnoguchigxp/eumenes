# Docling Deskを開く

Docling Deskの既存画面を別タブで開く。アーティファクトメニューの「Docling Desk」から「Docling Deskを開く」を押すと、追加キー入力なしでログインする。文書の追加、Word/PDF等の閲覧、OCRと変換結果の確認はDocling側の画面で行う。

会話からも文書の取り込み・閲覧用の入口を依頼できる。`docling_desk` → `package:docling.desk@1` → `binding:docling.desk@1` → `adapter:docling@1` → `artifact:docling.workspace@1`のデータドリブン登録を使う。profile・実行用Skill・toolの正本は`api/domains/capabilities/bundles/docling-desk.bundle.json`。既存の指示合成を使い、会話へ専用の固定指示を追加しない。入口の準備だけで文書変換やログイン成功を報告しない。

## 接続と認証

LARMの接続先はsettingsの保存済み設定、資格情報はsettingsのbackend専用`doclingCredentials()`で既存のLARM資格情報を解決する。新しいキー、consumerToken/appToken、LARM接続先の環境変数は不要。Excalidraw専用の認証情報は使わない。

認証付き`GET /api/settings/docling`と`PUT /api/settings/docling`で`expectedRevision`、`gatewayUrl`、`publicOrigin`を扱う。保存するのは非秘密のURLとrevisionだけ。初版はHTTPのlocalhost/127.0.0.1、port 28765、ルートoriginに限定する。任意の接続先・path・認証情報付きURLを受け付けない。

Macでの初回受入では、許可済みSSH接続で`127.0.0.1:28765`をgnosisの`127.0.0.1:28765`へ中継した。backend入口は`http://127.0.0.1:28765`、ブラウザ入口は`http://localhost:28765`。中継が切れるとこの入口では開けなくなる。現在の作業指示ではSSH接続、配備変更、サービスの起動・再起動を行わない。LANへは公開しない。gatewayへ送るHostは`127.0.0.1:28765`、ブラウザのHostは`localhost:28765`で契約に合わせる。本体28766やlease endpointを業務入口へ使わない。

開く操作で、backendがgatewayの`POST /auth/ui-tickets`へBearerを付けて一回要求する。この要求自体が必要時の起動を含む。返された相対URLを検証して保存済みの公開originに解決し、ブラウザが別タブで交換する。303とSecure/HttpOnly/SameSite=None CookieをDoclingとブラウザの間で保持する。backendでは交換しない。

長期Bearerはbackendだけに留める。ticketのURLは専用APIの応答から別タブへ直ちに渡し、会話・モデル引数・Artifact JSON・query cache・汎用操作outbox・DB・ログへ保存しない。CookieをEumenesへ渡さない。任意の外部originへのredirectは追わない。

現在のライブラリは共通。Eumenesの認証・Origin検査は入口と設定に適用するが、利用者別の文書分離や、Eumenesからのlogoutで既発行Docling Cookieが失効することは保証しない。

## 待機・取消・停止

Eumenes独自の起動ジョブ、永続launch台帳、起動待ちページ、状態pollを持たない。HTTP要求中だけ「接続しています…」と表示し、重複操作を抑止する。gateway側の最大180秒の起動待ちに対応し、上流要求は190秒、該当HTTP要求だけ200秒の上限とする。他のAPIのtimeoutは変更しない。

別タブを最初のクリックで確保し、popup拒否時はticketを発行しない。接続失敗・期限切れ・交換済みの場合は「もう一度開く」で新しいticketを要求する。自動再送しない。タブを閉じた場合や接続設定が変わった場合は遅い応答を破棄する。これをDocling文書変換の取消とは扱わない。

leaseの取得・更新・解放はgatewayが担当する。Eumenesは独自lease、systemd、内部lifecycle APIを使わない。**対象通信・処理・leaseがなくなった後に停止する**。無操作だけを停止条件としない。Docling側レビューによるローカル設定はgatewayの無通信判定60秒・判定周期15秒、管理側の停止待ち120秒。以前の約196秒という受入観測とは整合するが、固定の停止時間ではない。

現行の定期取得はqueued/runningがある間は約2秒、処理なしのlibraryモードでは約5秒。約5秒の取得は別タブ・別利用者の共有ライブラリ更新の検知が目的で、文書閲覧中も続く。非表示タブでは定期取得を抑制する仕様だが、今回その実ブラウザ試験は再実施していない。進捗確認の通信と、変換中の処理数を管理側へ知らせる停止保護は別の役割である。

処理なしを30秒へ延長し、表示復帰時・更新操作後に即時取得する案は設計合意待ち。共有更新の検知が最大約30秒遅れる。この案だけでは表示中の停止につながらず、表示中も停止させるには監視を止める別仕様が必要。今回、通信間隔は変更していない。停止の受入は対象通信を終え、処理・leaseもなくなる条件でControlの`GET /v1/local-services/docling-desk`だけを使って観測する。`/api/jobs`を停止監視へ使わない。現在は再受入やサービス操作を行わない。

## APIと機能

- `GET /api/docling/status`: Eumenes内の設定revision、設定有無、公開origin。上流へ通信せず、Doclingの稼働状態を表すAPIではない。
- `POST /api/docling/ui-tickets`: Eumenes認証とOrigin検査後に一回だけ上流へ要求。検証済みの一回限りURLと残り秒数を`Cache-Control:no-store`で返す。入力から接続先やownerは指定できない。

文書はDoclingが正本で、Eumenesに文書DBやファイルを複製しない。現在のOCRはDocling内のTesseract。共有`ocr-host`へのadapterは未実装。Azure OCR、翻訳・解説、意味検索、Blob、TeX組版等の可否はDoclingの「機能の利用状態」に従う。

Docling側レビューで確認された解説のoverview事前判定不整合と汎用warningsの画面表示欠落は、後続報告でコード修正・隔離fixture検証済みとなった。解説は診断と同じローカルpreflightを使い、認証未設定で生成POSTを抑止しつつ、保存済み解説の閲覧・Markdown/JSON書き出しを維持する。warningsはJob型・応答形式検査・共通文書ビューアーの表示を追加し、TeX固有理由と別表示する修正との報告である。Python105件、frontend6ファイル・47件、型・変更箇所の検査は成功との報告だが、配備・配信資産更新・実接続・実ブラウザ再受入は未実施。稼働版への修正反映は未確認で、以前のTeX表示を汎用warnings表示の受入成功とは扱わない。

後日の実ブラウザ受入には修正済みbackendとfrontend配信資産を同じ版へ反映し、認証設定あり/なし×保存済み解説あり/なしの4条件、warningsの再読込後表示、failed/error、原本・ソース・保存済み解説と書き出しを確認する必要がある。現在はこれらの作業を開始しない。failed理由と通信状態の併記、翻訳入口の未設定表示は引き続き改善候補。Azure OCR・翻訳・embedding・Blob・TeXの開始制御は不具合と断定しない。担当・検証範囲・除外した予備試験・再受入条件は[受入記録](../spec/verification/docling-desk-2026-10-25/acceptance.md)を参照。

## 検証

設計・検証条件は[連携設計](../spec/docling-desk-integration-design-2026-10-25.md)、fixture・live API・実ブラウザの結果と制約は[受入記録](../spec/verification/docling-desk-2026-10-25/acceptance.md)に分ける。

後続の[コードレビューと改善](../spec/verification/docling-desk-2026-10-25/review.md)で、保存設定の変更通知、接続中の設定/client切替時の取消、Artifactの競合理由表示を修正した。このレビューはSSHを使わず、ローカルfixtureで検証した。

部分試験は`bun run verify -- --domain docling`、API/会話結合は`bun test api/application/docling/docling-e2e.test.ts api/application/docling/docling-toolchain.test.ts`、ブラウザfixtureは`bunx playwright test tests/browser/docling.spec.ts`。設定・capabilities・tool-runtime・agent-runtime・dialogue・artifactの影響範囲も確認する。

`bun scripts/docling-live.ts --check`は保存済み設定でControlとgateway healthだけを確認する。`--negative`は明示的な実接続受入で、独立したticketの交換・再利用・期限切れ、50 MiB超過、破損PDF、未設定TeX組版によるfailed/partialを確認する。test用の文書だけを新規作成し、POSTは自動再送しない。異なるEumenesの受入環境には`--api=<loopback URL>`と`--db=<そのbackendのDB path>`を指定する。新しいLARM接続先や資格情報は要求しない。
