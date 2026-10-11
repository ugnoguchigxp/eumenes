# 実 dots 接続の試験用 OAuth

この入口は、この PC で許可した Eumenes 接続一つを公開し、実 dots の受入試験を行うためのもの。恒久運用には、永続化・鍵管理・利用者認証を備えた認証サービスを使う。

OAuth のコード交換、S256 PKCE、JWT、refresh、失効は `oidc-provider` 9.12.2 に任せる。独自の認証プロトコルは実装しない。所有者の許可だけを loopback の別ポートで受け付ける。

## 起動

1. このディレクトリで `npm ci --ignore-scripts --no-audit --no-fund` を実行する。
2. HTTPS トンネルの転送先を `http://127.0.0.1:8801` にする。
3. リポジトリ直下から `node scripts/dots-oauth/start.mjs <HTTPSのorigin> <新しい接続ID>` を起動する。
4. `~/.local/state/eumenes-dots-oauth-trial/configuration.json` に書かれた issuer相当の `origin`、`resource`、`subject` と、`origin/jwks` を Eumenes の接続 API で保存する。製品 DB を直接開かない。
5. 同じ管理認証環境から `bun scripts/dots-oauth/public.ts <接続ID>` を起動する。
6. ChatGPT に `resource` の MCP URL、OAuth、保存された公開 `clientId`、クライアント認証方式 `none`、`dots:read dots:report dots:events` を登録する。シークレットは空欄。許可した callback は `https://chatgpt.com/connector_platform_oauth_redirect` だけ。

ローカル承認 API は `127.0.0.1:8802`。`admin.token` の Bearer 認証で `GET /pending` の要求を確認し、登録した clientId、callback、resource、scope と一致する要求だけに `POST /approve` の `{ "uid": "要求ID" }` を送る。ブラウザは承認待ち画面を更新し、標準 OAuth フローへ戻る。login と consent は別々の承認要求になる場合がある。

承認トークン、認可コード、アクセストークンをログ、文書、ブラウザ入力、Git に載せない。状態ディレクトリは 0700、ファイルは 0600。管理トークンと Eumenes API の管理認証はクラウドへ渡さない。

## 制限

- 認証サービスは起動から2時間で自動停止する。アクセストークンは最大15分で、試験終了時刻を超えない。
- protocol 状態と署名鍵はメモリ内だけ。再起動すると既存の認証状態は失われ、clientId と subject も変わる。新しい接続IDでやり直す。
- 公開するのは、登録した MCP と保護対象メタデータ、認可・コード交換・公開鍵・失効の必要経路だけ。製品の `/api` とローカル承認 API は公開しない。
- Eumenes の API は既存の `127.0.0.1:8787` を使う。この試験コードは既存の製品設定や認証を別サービスへコピーしない。
- 認証サービスの停止後もトンネルと公開入口のプロセスは残り得る。試験終了時に、それぞれ起動したプロセスを停止する。
- OAuth の成功、Events の受信登録、実 dots の成果返却は別の検証結果として記録する。

## 検証

`node --test scripts/dots-oauth/*.test.mjs` で実際の認可コード交換、署名・所有者・対象・scope、有効期限、refresh、再利用拒否、PKCE、callback、ローカル承認の分離を検査する。

公開入口は未認証の MCP が401と認証メタデータを返し、`/api`、`/approve`、`/pending` が404になることを確認する。実 dots の受入では ChatGPT で OAuth を完了し、Events を購読してから Eumenes に新しい試験依頼を作る。fixture や自分で行った `report_task` を実 dots の回答として扱わない。
