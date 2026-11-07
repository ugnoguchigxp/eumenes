# 画像回答migrationの起動エラー修正

2026-11-07、`migration_checksum_mismatch:conversation/0017-image-answers` の利用者報告に対応した。サーバー操作、製品DBの変更、検査値の書換えは行っていない。

## 原因と修正

適用済みの0017は `answer_revision` / `source_revision` をTEXTとして保存する定義だった。同じIDのSQLが `answer_seq` / `source_seq` のINTEGERへ変更され、既存のchecksum検査が起動を拒否していた。保存済みの更新履歴とテーブル定義だけを読み取り専用で確認し、元のSQLを復元した。元のSHA-256は `9013b71e14303ae076d50890dac9a5cbf486203934d2d0195a34bc34b0a85a50` で、復元後と完全一致する。

連番への変更は追記型の `conversation/0018-image-answer-sequences` に分離した。既存の行、添付との対応、requestId、attemptId、採用時刻を保持する。旧revisionを採用時点までのoutboxへ照合して連番に変換し、照合できない証跡は無効な連番として保持する。訂正・撤回で失効した証跡から現在の連番を推測しない。既存のchecksum拒否、migration前バックアップ、transactionの仕組みをそのまま使う。

意味判断、LLMへの指示、入力語句や個別シナリオによる製品の分岐は追加していない。会話domainの保存形式の互換修正であり、別作業の画像機能・Markdown機能・依存変更は維持した。

## 検証

- 修正前: 独立した適用当時のSQLによる再オープンで同じchecksumエラーを再現した。
- 部分: migrationのchecksum固定・既存データ移行・画像回答証跡・既存の入力migrationの3ファイル7件成功。
- 結合: `bun test ./api/application/migrations.test.ts ./api/application/toolchain/chat-cloud-images.test.ts ./api/application/agency/image-history.test.ts ./api/domains/conversation/test` は65件成功。実行中のAPIソース変更なし。
- 関連domain: `bun run test:domain -- --domain conversation --domain dialogue` はbackend 622件とWeb 83件が成功。実行中に別作業のMarkdown関連3ファイルの追加を観測したため、全checkoutの固定状態の一括合格とは扱わない。今回変更したmigrationと試験に追加編集はない。
- 変更4ファイルのlint・format検査成功。
- 保存済みの全261件のmigration checksumは現在のコードと一致し、未適用は0018だけであることを読み取り専用で確認した。製品DBに0018はまだ適用していない。

移行試験では会話と添付、既存のmigration履歴とchecksumの保持、古い画像入力を訂正して元の文章へ戻しても証跡を復活させないこと、回答訂正による失効、再オープン、外部キー整合性を確認した。新規DBの適用は既存のapplication migration試験と画像回答証跡試験でも確認した。

## 一括検証の未達

`bun run verify -- --domain conversation --domain dialogue` はinventoryで停止した。既存の `artifacts/pursuit-integration-20261106/` 内の検証コピーが未登録の試験として検出されたためで、対象の削除や規則の緩和は行っていない。

全体の `bun check --no-pretty --all` は、実行時に別作業中の `api/domains/markdown/index.ts` が未作成の `./controller` を参照して停止した。今回の4ファイルには診断がなかった。この実行を全体型検査の成功とは扱わない。

画面・可聴出力を変更していないためブラウザE2E・実機器試験は省略した。実環境の起動確認は利用者の次回起動に委ねる。

ログはローカルの `/private/tmp/eumenes-image-migration-{verify,integration,domains,types}.log` に保存した。
