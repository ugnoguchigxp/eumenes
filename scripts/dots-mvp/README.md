# 単体スクリプト → dots → 回答

Eumenes の製品 runtime から独立した、単一利用者のテキスト依頼用 MVP。2026-10-10 に実 dots「セバスチャン」の回答返却と CLI 受信に成功した。内容の理解と回答は実 dots に任せ、コードは購読・署名付き配送・保存・期限・重複を管理する。製品 DB は使わない。

## 起動と送信

Bun が必要。依存はこの directory に閉じ込めている。

```sh
cd /Users/y.noguchi/Code/eumenes/scripts/dots-mvp
bun install --frozen-lockfile
bun cli.ts serve
```

別の端末から購読状況を確認し、有効なら送信する。

```sh
bun cli.ts status
bun cli.ts send --input-file example-request.txt --wait
bun cli.ts get REQUEST_UUID
bun cli.ts wait REQUEST_UUID --timeout-ms 120000
bun cli.ts cancel REQUEST_UUID
```

`send` は requestId/eventId を stderr、依頼または `--wait` の保存済み回答を JSON で stdout に出力する。入力は `--input-file` または標準入力。本文は UTF-8 32 KiB 以下。依頼期限は既定 10 分、`--deadline-ms` で変更できる。待機は最大 120 秒で、待機終了は依頼の取消ではない。未回答なら終了コード 2。再度 `wait` で待てる。

`--request-id UUID` を固定すると同じ本文・期限での再送が冪等になる。別の本文で同じ ID を使うと拒否する。取消・期限切れ後の回答、異なる回答での上書きも拒否する。`status` のイベント配送成功と回答保存は別の状態。

状態の既定位置は `~/.local/state/eumenes-dots-mvp`。`--state-dir` で変更できる。directory は 0700、ファイルは 0600。専用 SQLite の単一 writer を OS ロックで強制し、購読署名鍵は別ファイルの鍵で暗号化する。CLI は loopback API を使い、DB を直接開かない。状態ファイル・鍵・接続 URL をリポジトリへ追加しない。

## Codex 側の MCP

この PC では `eumenes-dots-mvp` として登録済み。Codex の MCP はローカルサーバーへ直接接続する。設定変更の反映には新しいセッション等が必要な場合がある。

```toml
[mcp_servers.eumenes-dots-mvp]
url = "http://127.0.0.1:8797/mcp"
http_headers_helper = "/opt/homebrew/bin/bun /Users/y.noguchi/Code/eumenes/scripts/dots-mvp/headers.ts"
```

`headers.ts` は同じ専用状態 directory のトークンを読む。トークン本文を設定へ貼り付けない。別の directory を使う場合は helper の引数に絶対パスを指定する。Codex への登録と、dots の Events 購読は別の接続。

## dots の接続と購読

MCP 2.0 `2026-07-28` を扱う公式 SDK 2.3.1 を使用する。`server/discover` に Events capability を出し、`events/list` / `subscribe` / `unsubscribe` を実装する。tools は `list_pending_requests`、`get_request`、`submit_answer`。

Secure MCP Tunnel を先に評価したが、現在の環境では workspace/組織の管理権限と対応する管理キーを利用できず、作成を完了できなかった。今回の非機密試験は下記の限定 bridge を HTTPS トンネル経由で接続した。

```sh
bun cli.ts bridge
cloudflared tunnel --url http://127.0.0.1:8798 --no-autoupdate
```

bridge は `/mcp/<bridge.token の値>` のみを公開する。他のパスや `/local` の制御 API を転送しない。この URL 自体が接続資格なので、画面やログへ不用意に出さない。ChatGPT の custom MCP plugin に HTTPS origin とこのパスを登録する。試験 plugin 名は **Eumenes Dots MVP**。

これは単一利用者・非機密テキストの試験用接続であり、OAuth による利用者識別は未実装。製品データや複数利用者へ広げる前に OAuth 2.1 の issuer/audience/scope/期限の検証を実装する。Quick Tunnel は再起動で origin が変わるため、恒久的な接続・自動起動は今回の範囲外。停止は起動した各端末で Ctrl-C。

plugin 接続後、dot に次の範囲を指定して監視を依頼する。接続登録だけでは購読は始まらない。

> Eumenes Dots MVP の request.created を queue_id=dots-script-mvp で購読してください。これから30分以内の非機密な試験依頼1件について、イベントの request_id / request_version を使って get_request で本文を読み、回答全文を submit_answer（outcome=answered）で返してください。通知に依頼参照がなければ list_pending_requests で未回答の参照を取得してください。このキューの一覧取得・本文取得と回答返却を許可します。購読が有効になったら知らせてください。

イベントには依頼参照のみを載せる。ツール入力では `requestId` / `requestVersion` に対応させる。回答の生成に固定フレーズの分岐や別モデルは使わない。

実接続では、公式形式のイベントが 200 で受理されて dots が起動した後、通知から依頼参照が見えない事例を確認した。`list_pending_requests` はこの実測に基づく復元手段で、当該 owner の未回答・期限内の参照を最大10件返す。本文や特定の発話で分岐せず、選択と処理は dots の指示に委ねる。

購読時に HTTPS 受信先を Standard Webhooks 署名付き challenge で検証する。共有 `llm-fetch` の公開 IP 検査を再利用し、検査済み IP を TLS 接続へ固定する。リダイレクト・私的 IP・大きな応答を拒否する。配送は同じ eventId/body で最大5回、試行ごとに署名を更新する。410/413 は再試行しない。購読と依頼は有限期限を持つ。

## 検証

```sh
bun test
bun run typecheck
```

fixture は署名検証・challenge・SDK 2 の実プロトコル・tools・永続化・待機・重複・取消・期限・配送再試行・単一 writer・bridge 境界・DNS lookup 契約を検証する。fixture の回答は実 dots の受入とは区別する。

実 dots の受入結果は `spec/verification/dots-mvp/acceptance-2026-10-10.md` に記録する。設計根拠と段階計画は `spec/dots-script-mvp-implementation-plan-2026-10-10.md`。
