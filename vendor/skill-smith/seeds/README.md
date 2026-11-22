# SkillSmithのRuriカタログ

検索と本文取得に使うSkillSmithの読み取り専用SQLiteです。検証済みカタログと同じ4,259件のSkill本文・版・512次元ベクトルを収録しています。2件は本文が一部省略されており、完全性フラグにも反映しています。

- `ruri-catalog.sqlite` はSkillSmithの `createSqliteRuriSkills` に渡すカタログです。
- `ruri-catalog.seed.sql.gz` は同じ内容を新しいSQLiteに復元する圧縮SQLです。
- `ruri-catalog.manifest.json` で件数、埋め込みモデルの版、配布ファイルのバイト数とSHA-256を確認できます。

## seedからの復元

Eumenesリポジトリのルートで実行します。復元先には新しい一時ディレクトリを使います。

```sh
set -o pipefail
ruri_rebuild_dir=$(mktemp -d)
gzip -dc vendor/skill-smith/seeds/ruri-catalog.seed.sql.gz |
  sqlite3 -bail "$ruri_rebuild_dir/ruri-catalog.sqlite"
sqlite3 -readonly "$ruri_rebuild_dir/ruri-catalog.sqlite" 'PRAGMA integrity_check;'
sqlite3 -readonly "$ruri_rebuild_dir/ruri-catalog.sqlite" 'SELECT count(*) FROM ruri_catalog_skills;'
```

出力は `ok` と `4259` です。カタログを接続するホストは、manifestに記録された版と埋め込み空間に対応するRuriクエリベクトルを渡します。

復元後のSQLiteファイルは内部のページ配置によってバイト列が変わることがあります。復元時はスキーマ、版、本文、ベクトルが一致することを確認しています。
