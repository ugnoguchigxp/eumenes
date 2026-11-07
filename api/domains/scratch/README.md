# Scratch

サーバーの稼働中だけ残る一時ファイル。会話の前後で引用ID（台帳の `a<n>`）を付け、エージェント間で内容を共有する置き場。持ち主のない内容（添付・長い貼り付け・担当の書出し）を `eumenes://scratch/<uuid>` のリソースにする。

- contracts: 上限（合計2 GiB、掃除の目標1.5 GiB、空き5 GiB、1件100 MiB、2,000件）、受け付けるMIME、エラーコード。
- service/store: `<dataDir>/scratch/<bootId>/<uuid>` のファイルとメモリーの索引。LRUの掃除、貸出（lease）、起動時に前回のディレクトリを背景で消す。SQLiteに書かない。
- service/describe: 会話に出す一行（作り手・種類・大きさ）と `resource.read` のページ（`offset` は文字数）。
- service/resource-adapter: kind `scratch` の ResourceAdapter。
- controller: `GET /api/scratch/:id`・`/content`、利用者のファイル添付 `POST /api/conversations/:id/scratch`。認証とOrigin検査はアプリ共通middleware。

ほかの domain を参照しない。添付・貼り付けの登録、サブエージェントの `scratch.write`、model3d への橋渡しは application が接続する。設計は [設計書](../../../spec/server-scratch-cache-design-2026-11-07.md)。
