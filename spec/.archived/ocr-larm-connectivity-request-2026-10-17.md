# LARM担当への依頼：Eumenesから利用できるOCRの正式入口

対応後の記録: ユーザーから正式originを指定され、[Macからの設定保存・実接続受入](../verification/ocr-mac-gateway-2026-10-17/README.md)を完了した。以下は入口整備前の依頼内容を保持したもの。

2026年10月17日。依頼書のみ作成。LARM側への送信、設定変更、サービスの起動・停止は行っていない。

## 依頼したいこと

Macで動くEumenes backendから、既存のLARM共通トークンを使ってOCRを利用できる正式なgateway入口を用意してください。既存の接続経路がある場合は、その入口と接続条件の提示で構いません。新しいOCR専用キーを利用者へ要求する必要はありません。

現行のOCR gatewayは、LARM共通トークンをすでに受け付けています。今回確認できた阻害要因は、OCRの入口がAIサーバーのloopbackに限定され、Eumenesに保存できる到達可能なURLがないことです。共有トークンの認証実装そのものに不具合があると断定する依頼ではありません。

## 確認した事実

- Eumenesの稼働中backendに対する `GET /api/settings/ocr` はHTTP 200、`revision: 0`、`baseUrl: null`、`credentialConfigured: false`。OCR接続先は未保存。取得の `X-Request-Id` は `56b0f34b-8aec-4702-8dec-d3285ad82a38`。
- 保存済みLARM Controlに対する `GET /v1/local-services/ocr-host` はHTTP 200。`ocr-host` は登録されており、状態は `stopped`。
- gnosisの `larm-ocr-host-gateway.service` は稼働中。gatewayは `127.0.0.1:18794` だけで待受している。これは調査時の配備値であり、サービス識別や自動設定の固定値に使わない。
- gatewayの読取り専用 `GET /hosting/status` は、認証なし401、不正Bearer 401、Eumenes側にあるLARM共通トークンのBearerで200・`id: ocr-host`。SSHの標準入力でトークンをメモリー上へ渡し、ファイル・引数・ログには保存していない。
- この確認の後も `ocr-host` は `stopped`、generationは7のまま。OCR workerの起動、解析、job作成は行っていない。
- Mac側の18794には待受がなく、SSH設定にも同ポートの転送がない。

共通契約の正本は [Eumenes Excalidraw OCR OpenCV 連携の共通資料](https://chatgpt.com/space/page_e38fb71deba88191bcefebcaa046ea60)。OCRは既存のLARM共通トークンをBearerで使い、gatewayの `POST /api/analyze` とjob APIを利用する契約である。Excalidraw専用consumerToken・apiTokenへ切り替える依頼ではない。

## 提供してほしい接続契約

1. Eumenes backendから到達できる、OCR gateway用のHTTP(S) originを提示する。現在のEumenes設定はloopback・私設ネットワーク等のgatewayを対象とし、パス付きbase URLを扱わない。Control配下のprefix経由など、この契約と異なる入口を採る場合は、先にAPI契約を提示して合意する。
2. `Authorization: Bearer <既存のLARM共通トークン>` を、`POST /api/analyze`、`GET /api/jobs/{id}`、`POST /api/jobs/{id}/cancel`、読取り専用 `GET /hosting/status` で受け付ける。トークンなし・不正なトークンは拒否する。
3. 中継を使う場合は既存gatewayのHost・Origin検査に合わせ、正しい宛先へ転送する。workerの内部endpointをEumenesの通常接続先として公開しない。
4. `GET /hosting/status` はworkerを起動せず認証とservice IDを確認できる経路として維持する。解析要求で必要なworkerをオンデマンド起動する既存契約を維持する。
5. 画像の同期結果、動画の202・job ID、job照会・取消・所有者分離と、既存のmultipart契約を維持する。クライアントへ新たなmodel・owner指定を要求しない。

## 受入条件

- MacのEumenes backendと同じ実行環境から、提示されたoriginの `/hosting/status` へ共通トークン付きで到達し、200と `id: ocr-host` を得られる。認証なし・不正トークンでは拒否される。
- 状態確認だけでは停止中のworkerが起動しない。
- 正式入口をEumenesの認証済み `PUT /api/settings/ocr` で保存し、トークンをブラウザや会話へ渡さず、別キーの入力なしで画像OCRを実行できる。
- 起動を伴う受入はサービス起動の明示許可を得てから実施し、画像・短い動画・job照会・取消・所有者境界を確認する。状態確認の成功を解析成功とは扱わない。
- 受入記録にはHTTP status、service ID、request ID、job ID、generation等の必要な識別子を残す。資格情報と入力資料・OCR本文はログへ含めない。

## Eumenes側の対応と残作業

Eumenesには共通のトークン解決とBearer送信がすでにある。`LARM_API_TOKEN`、互換名の `LARM_CONTROL_TOKEN` の両方について、backendからgatewayへ送られることと公開レスポンスへ漏れないことを固定試験で確認する。接続先の未設定と資格情報の未設定を区別する表示も修正する。

正式入口が提示された後、設定APIへの保存と実接続確認を行う。新しい中継方式をEumenesへ無断追加したり、到達できないLinux loopback URLをMacの設定へ保存して完了扱いにしたりしない。

既存のSSH転送を運用経路にする場合はLARMの製品改修が不要な可能性がある。ただし、今回の調査では転送を起動していない。どちらの方式でも、利用者が認めた接続経路が利用可能になった時点で、Eumenes側の接続設定とOCR受入を完了する。
