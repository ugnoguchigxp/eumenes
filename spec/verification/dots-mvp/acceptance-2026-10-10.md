# 単体スクリプト → 実 dots → スクリプト：受入記録

2026-10-10 JST。**非機密テキストの一往復に成功**。実 dots は「セバスチャン」。依頼本文や ID を dots の入力欄へ直接渡さず、ローカル CLI から MCP Events を送信して処理を開始した。

## 成功した実行

| 項目 | 観測 |
| --- | --- |
| requestId | `d4924ba0-84af-40ae-9703-e0ba7cb88866` |
| requestVersion | `1` |
| eventId | `evt_2bff86e4-6137-4043-bfb2-84ad92e79454` |
| 購読 ID | `sub_d5d25cc3ab354b4ff1da3430ba300df2fe27707923983543426156ea27d673ac` |
| 保存 | 23:00:00.702 JST |
| 配送 | 23:00:01.704 JST、1試行、HTTP 200 |
| 実 dots の本文取得 | 23:00:18.463 JST、`request.read` に同じ requestId |
| 実 dots の回答保存 | 23:00:31.788 JST、`answer.saved` に同じ requestId |
| 所要時間 | 送信から回答保存まで 31.086 秒。この一回の観測で、保証時間ではない |
| CLI | `send --wait` が回答 JSON を stdout へ出し、終了コード 0 |
| 購読停止 | 1件限定の指示に従って実 dots が解除。`subscription.stopped` を確認 |

入力は `scripts/dots-mvp/example-request.txt`。実 dots が返した全文:

> 春の雨が芽吹いた枝を静かに濡らし、若葉の先に小さな雫が光っている。傘の下まで届く土の匂いに、冬の名残がゆっくりほどけていく。
>
> 23×19＝437

証拠:

- [answer-record.json](answer-record.json): ローカル API から取得した永続回答。上記 ID、receipt、配送結果を含む。
- [cli-answer.json](cli-answer.json): 保存済み回答を CLI の `wait` から再取得した stdout。終了コード 0。
- [status-record.json](status-record.json): 本文・受信先 URL・秘密を含めない監査記録。イベント配送・依頼取得・回答保存・購読停止を照合できる。
- [dot-success.jpg](dot-success.jpg): 実 dots が回答全文の返却と保存成功を報告した画面。
- [plugin-events.jpg](plugin-events.jpg): 初回スキャン時に Events が検出された画面。復元用読取ツールを追加する前のもの。

## 接続と実装

サーバーと状態はこの PC に作成。Codex に `eumenes-dots-mvp` を登録し、loopback HTTP と専用トークン helper で接続する設定を確認した。現在の Codex チャットへのツール再読込は確認していない。

dots 向けにはユーザーが許可した ChatGPT Web で接続登録・購読指示を行った。plugin は **Eumenes Dots MVP**。公式 SDK `@modelcontextprotocol/server` / `core` **2.3.1** を独立 package に固定し、MCP 2.0 **2026-07-28** を使用した。既存 coding runner の SDK を変更していない。

Secure MCP Tunnel は管理権限・対応キーの不足により作成できず、HTTPS Quick Tunnel と `/mcp/<乱数資格>` に限定した bridge で非機密の試験を行った。`/local/*`、製品 API、DB、ファイル実行を公開しない。トンネル origin と資格 URL、callback URL、署名鍵、認証トークンは受入資料に保存しない。

**OAuth 2.1、複数利用者、恒久接続、自動起動、Eumenes 製品統合は未実装。** この結果は当初計画の OAuth を伴う正式運用の完了を意味しない。ローカルサーバー・bridge・試験トンネルは今回起動したプロセスとして稼働中で、dot の購読は停止済み。再試験には購読が必要。

## 実接続で見つかった問題

1. 初回の challenge 通信で Node/Bun の DNS lookup が `{all:true}` を要求した際、単一 IP 用の戻り値を返して通信に失敗した。検査済み IP 配列を返す契約を実装し、単一／配列の両方を回帰試験へ追加した。公開 HTTPS POST の到達と、実 dots の challenge 成功を確認した。
2. 最初のイベントは公式の `eventId/name/timestamp/data/cursor` 形式で送信し、HTTP 200 と実 dots の起動を確認した。しかし dot は通知に `request_id/request_version` が見えないと報告し、本文取得できなかった。この依頼 `d9099e86-5a0f-403c-94cc-7fc2a188ee1c` は取消した。
3. 再現した通知コンテキストの欠落に対し、owner 限定で未回答・期限内の参照を返す `list_pending_requests` を追加した。plugin を再スキャンし、実 dots が一覧→本文取得→回答返却した。依頼本文や特定フレーズをコードで解釈する処理は追加していない。

## 検証範囲

| 種別 | 結果 |
| --- | --- |
| 独立 fixture | `bun test`: 5 pass / 0 fail / 60 assertions |
| 独立型検査 | `scripts/dots-mvp` の `bun run typecheck`: 成功 |
| lint | `bun run lint -- scripts/dots-mvp`: 成功 |
| 実接続 | 実 dots 一往復、保存済み回答の CLI 再取得、dot による購読停止に成功 |
| root 型検査 | 作業中の既存 agent-runtime/tool-runtime/coding 周辺の型エラーで失敗。今回の独立 package の型検査とは区別 |
| `bun run verify:all` | 既存 settings/web-research/coding-runner/音声/Web 等の size budget 超過で停止。全体成功とは扱わない |

fixture は SDK の実 HTTP 契約、署名・challenge、保存と再起動、冪等性、取消・期限、owner 分離、配送再試行、410/413 停止、単一 writer、公開 IP 検査と bridge 境界を扱う。実 dots の再起動・失効認証・burst/batching・異なる依頼の反復は今回未実施。

最後に今回の追加ファイルを確認した。正規表現は署名鍵・HTTP パス等の構造検証に限定され、意味分類・個別発話の固定回答はない。専用実装は Events 契約、共有検査部品では扱えない署名付き POST、SQLite 単一 writer、実測した通知参照の復元に限定している。
