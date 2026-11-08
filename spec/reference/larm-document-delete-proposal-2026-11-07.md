# LARM常駐文書APIへの削除追加案

2026-11-07。EumenesのMarkdown一覧に削除を追加するための依頼案。現行本番APIには未実装であり、以下を配備済み契約として呼び出さない。

## 再利用する構成

`larm.docling-files.v1`、既存Bearer認証、許可namespace、文書ID、強いETag、Docling側の既存ファイル管理処理と共通ロックを使う。Docling本体が停止中でも操作でき、起動・lease・activity・OCR・LLMを要求しない。SQLiteや検索索引をLARMから直接更新しない。文書の削除に伴う通常の索引同期は既存の正規手順に従う。

## 提案するHTTP契約

```http
DELETE /v1/docling/documents/{id}
Authorization: Bearer <既存のLARM API認証情報>
If-Match: "<一覧またはGETで取得した正確なETag>"
```

- 本文なし、IDで1件だけを削除する。任意のローカルパス・namespace・再帰削除は受け付けない。
- 正確なIf-Matchを必須とし、ワイルドカード・欠落・弱いETagを受け付けない。照合と削除を既存共通ロックの中で行う。
- Markdown本文とopaque recoveryを同じ文書単位で整理する。成功応答の後に片方だけが残る状態を正当な成功として返さない。
- 成功はHTTP200と`{"id":"wiki-...","deleted":true}`。応答IDと要求IDの一致をEumenes側でも検証する。キャッシュさせない。
- `capabilities.methods`に`DELETE`を追加し、OpenAPIに要求条件・応答・失敗を記載する。既存GET/PUTの契約を維持する。

## 必要な失敗の区別

| 状態 | 提案する応答 |
| --- | --- |
| ID・If-Matchが不正 | 400 `invalid_request` |
| 認証不可・権限外 | 401 `unauthorized` / 403 `forbidden` |
| 対象が存在しない | 404 `not_found`。削除成功の履歴としては扱わない |
| 文書が更新済み | 412 `etag_mismatch`。一切削除しない |
| 保存先が利用不可 | 503 `unavailable` |
| 削除途中で結果を確定できない | 既存形式で結果不明を示し、成功を返さない |

Eumenesは通信断・5xx・結果不明でDELETEを自動再送しない。結果の照合は同じIDのGETに限る。GETの404は現在の不存在であり、特定の削除要求が成功した履歴の証明とはしない。

## 保存先側の受入

検証専用文書の作成→GET→ETag付きDELETE→GET404、本文・recoveryの整理、別文書不変を確認する。古いETag・権限外・不正ID・If-Match欠落で文書が不変であること、保存との競合、削除応答喪失を確認する。Docling停止中の試験と、通常起動時の既存索引同期を分けて記録する。既存の利用者文書を削除しない。
