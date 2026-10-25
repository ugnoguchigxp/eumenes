# Docling Deskを開く

Docling Deskの既存画面を別タブで開く。アーティファクトメニューの「Docling Desk」から「Docling Deskを開く」を押すと、追加キー入力なしでログインする。文書の追加、Word/PDF等の閲覧、OCRと変換結果の確認はDocling側の画面で行う。

会話からも文書の取り込み・閲覧用の入口を依頼できる。`docling_desk` → `package:docling.desk@1` → `binding:docling.desk@1` → `adapter:docling@1` → `artifact:docling.workspace@1`のデータドリブン登録を使う。profile・実行用Skill・toolの正本は`api/domains/capabilities/bundles/docling-desk.bundle.json`。既存の指示合成を使い、会話へ専用の固定指示を追加しない。入口の準備だけで文書変換やログイン成功を報告しない。

## 接続と認証

LARMの接続先はsettingsの保存済み設定、資格情報はsettingsのbackend専用`doclingCredentials()`で既存のLARM資格情報を解決する。新しいキー、consumerToken/appToken、LARM接続先の環境変数は不要。Excalidraw専用の認証情報は使わない。

認証付き`GET /api/settings/docling`と`PUT /api/settings/docling`で`expectedRevision`、`gatewayUrl`、`publicOrigin`を扱う。保存するのは非秘密のURLとrevisionだけ。初版はHTTPのlocalhost/127.0.0.1、port 28765、ルートoriginに限定する。任意の接続先・path・認証情報付きURLを受け付けない。

Macでは、認可済みSSH接続を使い、`127.0.0.1:28765`をgnosisの`127.0.0.1:28765`へ中継する。backend入口は`http://127.0.0.1:28765`、ブラウザ入口は`http://localhost:28765`。SSH接続が切れると開けなくなる。LANへは公開しない。gatewayへ送るHostは`127.0.0.1:28765`、ブラウザのHostは`localhost:28765`で契約に合わせる。本体28766やlease endpointを業務入口へ使わない。

開く操作で、backendがgatewayの`POST /auth/ui-tickets`へBearerを付けて一回要求する。この要求自体が必要時の起動を含む。返された相対URLを検証して保存済みの公開originに解決し、ブラウザが別タブで交換する。303とSecure/HttpOnly/SameSite=None CookieをDoclingとブラウザの間で保持する。backendでは交換しない。

長期Bearerはbackendだけに留める。ticketのURLは専用APIの応答から別タブへ直ちに渡し、会話・モデル引数・Artifact JSON・query cache・汎用操作outbox・DB・ログへ保存しない。CookieをEumenesへ渡さない。任意の外部originへのredirectは追わない。

現在のライブラリは共通。Eumenesの認証・Origin検査は入口と設定に適用するが、利用者別の文書分離や、Eumenesからのlogoutで既発行Docling Cookieが失効することは保証しない。

## 待機・取消・停止

Eumenes独自の起動ジョブ、永続launch台帳、起動待ちページ、状態pollを持たない。HTTP要求中だけ「接続しています…」と表示し、重複操作を抑止する。gateway側の最大180秒の起動待ちに対応し、上流要求は190秒、該当HTTP要求だけ200秒の上限とする。他のAPIのtimeoutは変更しない。

別タブを最初のクリックで確保し、popup拒否時はticketを発行しない。接続失敗・期限切れ・交換済みの場合は「もう一度開く」で新しいticketを要求する。自動再送しない。タブを閉じた場合や接続設定が変わった場合は遅い応答を破棄する。これをDocling文書変換の取消とは扱わない。

leaseの取得・更新・解放はgatewayが担当する。Eumenesは独自lease、systemd、内部lifecycle APIを使わない。最後の通信から約60秒でgatewayがleaseを解放し、その後の本体idle確認で停止する。Doclingのライブラリ画面は表示中に定期通信するため、表示したままの自然停止は保証しない。停止の受入ではDoclingのタブを閉じ、Controlの`GET /v1/local-services/docling-desk`だけで観測する。`/api/jobs`を常時監視しない。

## APIと機能

- `GET /api/docling/status`: Eumenes内の設定revision、設定有無、公開origin。上流へ通信せず、Doclingの稼働状態を表すAPIではない。
- `POST /api/docling/ui-tickets`: Eumenes認証とOrigin検査後に一回だけ上流へ要求。検証済みの一回限りURLと残り秒数を`Cache-Control:no-store`で返す。入力から接続先やownerは指定できない。

文書はDoclingが正本で、Eumenesに文書DBやファイルを複製しない。現在のOCRはDocling内のTesseract。共有`ocr-host`へのadapterは未実装。Azure OCR、翻訳・解説、意味検索、Blob、TeX組版等の可否はDoclingの「機能の利用状態」に従う。

## 検証

設計・検証条件は[連携設計](../spec/docling-desk-integration-design-2026-10-25.md)、fixture・live API・実ブラウザの結果と制約は[受入記録](../spec/verification/docling-desk-2026-10-25/acceptance.md)に分ける。

後続の[コードレビューと改善](../spec/verification/docling-desk-2026-10-25/review.md)で、保存設定の変更通知、接続中の設定/client切替時の取消、Artifactの競合理由表示を修正した。このレビューはSSHを使わず、ローカルfixtureで検証した。

部分試験は`bun run verify -- --domain docling`、API/会話結合は`bun test api/application/docling/docling-e2e.test.ts api/application/docling/docling-toolchain.test.ts`、ブラウザfixtureは`bunx playwright test tests/browser/docling.spec.ts`。設定・capabilities・tool-runtime・agent-runtime・dialogue・artifactの影響範囲も確認する。

`bun scripts/docling-live.ts --check`は保存済み設定でControlとgateway healthだけを確認する。`--negative`は明示的な実接続受入で、独立したticketの交換・再利用・期限切れ、50 MiB超過、破損PDF、未設定TeX組版によるfailed/partialを確認する。test用の文書だけを新規作成し、POSTは自動再送しない。異なるEumenesの受入環境には`--api=<loopback URL>`と`--db=<そのbackendのDB path>`を指定する。新しいLARM接続先や資格情報は要求しない。
