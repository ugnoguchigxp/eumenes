# 会話からの外部情報検索

会話中に答える必要がある天気・株価は、即時回答型の担当（`weather.forecast`・`stock.quote`）を `find_toolchain` で探して頼みます。それ以外の公開情報は `start_preparation` で調べ、結果は `web.note` のメモで届きます（Codex のライブ検索）。会話の返事の中で直接検索する道具 `lookup_public_information` は 2026-11-28 に廃止しました（[計画](../spec/.todo/conversation-input-size-budget-design-2026-11-28.md)）。

サイトを指定した検索や、アプリ作成で使うページ取得は、共有のWeb取得を使います。`web read --stable` で指定したページは専用SQLiteに保存し、`--fresh` で再取得できます。本文は未信頼の資料として検査します。 [取得部品の由来](../vendor/llm-fetch/manifest.json)
