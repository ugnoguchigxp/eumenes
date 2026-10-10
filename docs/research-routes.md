# 取得先と手順（research-routes）

この画面とAPIは旧方式で保存された取得先と手順の管理用です。天気・株価の固定文法による分類、専用の本文抽出・回答生成、自動学習・再利用・編集の実行コードは削除しました。現在のWeb調査ではLLMが共通ツールで資料を選び、結果を返します。既存DBとmigrationは保持しています。

保存済みデータの閲覧・停止・手順の解除・全削除は利用できます。編集APIは既存クライアント向けに残し、`409 route_not_editable` を返します。旧仕様の正本は `spec/research-route-learning-implementation-plan-2026-10-09.md`、現在の方針は `spec/conversation-and-research-simplification-plan-2026-10-10.md` です。

## 画面

設定の「取得先と手順」で、キーワード・対象・状態・取得先・最終成功日時、SKILLとContextの該当内容を確認できます。停止、保存した手順の解除、全削除を提供します。

## CLI

```sh
bun run cli research-routes list [--cursor <c>] [--limit <1-50>]
bun run cli research-routes show <key>
bun run cli research-routes disable <key> <stateToken>
bun run cli research-routes rediscover <key> <stateToken>
bun run cli research-routes clear <expectedEpoch>
```

`stateToken` は `show`、`epoch` は `list` の結果から取ります。変更系の失敗時は使った `Request ID` を標準エラーへ出すので、`--request-id <UUID>` を付けて同じ要求を再送できます（二重適用されません）。編集は廃止済みです。`rediscover` は保存した手順の参照を解除します。

## 状態

`unregistered / preparing / active / suspended / expired / disabled`。これは保存済みレコードの状態です。新しい調査への適用状態ではありません。disabledは明示の `rediscover` か `clear` まで保持されます。古い `stateToken`・`epoch` は409です。

## 運用

ログは `docs/logging.md` の「取得先学習」を参照。旧自動学習のlive実行スクリプトは廃止しました。過去の受入結果は現行版の成功を示しません。

## 旧仕様の記録（現行の実行仕様ではない）

初回の「天気予報 鎌倉」「株価 AAPL」のような依頼はWeb検索で取得先を探し、回答後に成功した1サイトの取得手順を登録します。同じキーワードの次回は登録サイトを直接確認し、値は毎回取得し直します。サイト故障時は再検索して新しい取得先に更新します。操作は設定の「取得先と手順」またはCLI（`bun run cli research-routes list|show|edit|disable|rediscover|clear`）で、どちらもAPIだけを使います。静岡市のlive対応は未確認で、実機器の音声3往復も未実施です（[検証記録](../spec/verification/research-routes/README.md)）。
