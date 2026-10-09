# 取得先と手順（research-routes）

検索キーワード（天気・株価の有限文法）ごとに、成功した取得手順を版管理して保存します。仕様の正本は `spec/research-route-learning-implementation-plan-2026-10-09.md`。

## 画面

設定の「取得先と手順」で、キーワード・対象・状態・取得先・最終成功日時、SKILLとContextの該当内容を確認できます。編集（説明のみ）、停止、次回検索、全削除を提供します。

## CLI

```sh
bun run cli research-routes list [--cursor <c>] [--limit <1-50>]
bun run cli research-routes show <key>
bun run cli research-routes edit <key> <stateToken> <instruction-file>
bun run cli research-routes disable <key> <stateToken>
bun run cli research-routes rediscover <key> <stateToken>
bun run cli research-routes clear <expectedEpoch>
```

`stateToken` は `show`、`epoch` は `list` の結果から取ります。変更系の失敗時は使った `Request ID` を標準エラーへ出すので、`--request-id <UUID>` を付けて同じ要求を再送できます（二重適用されません）。編集の指示はファイルから読みます。URL・tool・引数の変更は受け付けず、`rediscover` で次回検索に戻します。

## 状態

`unregistered / preparing / active / suspended / expired / disabled`。disabledは明示の `rediscover` か `clear` まで保持され、通常回答のみ行います。古い `stateToken`・`epoch` は409です。

## 運用

ログは `docs/logging.md` の「取得先学習」を参照。実LARM・実Webの受入は `EUMENES_LIVE_RESEARCH_ROUTES=1 bun run verify:live -- --domain research-routes`。
