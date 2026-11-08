Eumenesの文書一覧・Artifact内Plate Markdownエディタを、LARMの文書ライブラリAPIへ対応させてください。既存実装を確認し、実装・固定試験・接続仕様の更新まで進めてください。

## 1. 目的と配備状況

Doclingを文書の正本とし、次を提供します。

- 文書の一覧・読込み・新規保存・更新・削除
- 文書の名前変更・タイトル変更・移動・コピー
- 空フォルダーの作成・一覧・名前変更・移動・コピー・削除
- 複数選択による移動・コピー・一括削除
- フォルダー配下を含む操作

2026年11月7日の引継時点で、LARM本番は `larm.docling-files.v1` のGET/PUTです。拡張APIはLARM側で実装・検証済みですが、本番未配備です。実装revisionは `f860294ba28d7e45990732fe343fbe230f1a973f` です。

まずEumenesを、現行GET/PUTと拡張APIの両方に対応させてください。拡張が未配備でも、現在の一覧・読込み・保存を壊さないことが必須です。LARMの配備やDoclingの起動は、このEumenes側作業では行わないでください。

対象は許可されたMarkdownライブラリです。独自の版履歴、ごみ箱・復元、添付ファイル管理、権限管理は追加しません。

## 2. 接続・認証・機能の発見

設定済みのLARMベースURLと、既存のサーバー側LARM接続を使ってください。接続先を推測して固定しないでください。

```http
Authorization: Bearer <既存のLARM API認証情報>
```

`docling-desk` が許可されたLocal Service認証も利用できます。Provider／Agent Connection用トークンは使えません。

認証情報はEumenesサーバー側に保持してください。Artifact・ブラウザーへ渡さず、本文・復元情報・認証情報を通常ログへ記録しないでください。SSH、共有フォルダー、サーバーの実ファイルパスを操作する構成にはしません。

機能の発見は次です。

```http
GET /v1/docling/capabilities
```

拡張配備後の応答例は次のとおりです。

```json
{
  "contractVersion": "larm.docling-files.v1",
  "basePath": "/v1/docling/documents",
  "requiresDocling": false,
  "methods": ["GET", "PUT", "PATCH", "POST", "DELETE"],
  "create": "PUT with If-None-Match: * and a client-generated wiki-<uuid hex> ID",
  "update": "PUT with the exact If-Match ETag",
  "recovery": "opaque UTF-8 string",
  "maxRequestBytes": 20971520,
  "maxMarkdownBytes": 8388608,
  "maxRecoveryBytes": 8388608,
  "maxPageSize": 100,
  "contentDigest": "sha256(ascii(markdownSha256 + LF + recoverySha256))",
  "delete": "DELETE with the exact strong If-Match ETag; no body; no automatic retries",
  "libraryPath": "/v1/docling/library",
  "foldersPath": "/v1/docling/folders",
  "operationsPath": "/v1/docling/operations",
  "libraryOperations": ["rename", "move", "copy", "delete", "recursive-delete"],
  "maxBatchItems": 100,
  "maxAffectedItems": 500,
  "maxCopyBytes": 20971520,
  "folderCopyIds": "Descendant ID prefix + first 32 hex of sha256(ascii(newRootId + LF + sourceId))"
}
```

現在のEumenesにある「methodsはGET/PUTだけ」という検証を改めてください。

- 現行応答では追加項目がなくても正常に動作すること。
- methodsの追加値や未知の追加項目だけを理由に接続全体を拒否しないこと。
- 既知の機能に必要なmethod・path・項目を確認し、利用可能な操作だけを有効にすること。
- 未配備の変更系APIを、試しに呼んで対応有無を調べないこと。
- 配備後にcapabilitiesを再取得して、新機能を利用可能にできること。

認証付き `GET /openapi.json` にも仕様があります。拡張前の本番OpenAPIには、新しい操作はまだ載りません。

旧 `/api/wiki` とその配下は廃止済みです。フォールバックしないでください。Doclingのensure、lease更新、activity通知も不要です。

## 3. 共通のデータと保存規則

```ts
type DocumentSummary = {
  id: string;
  namespace: string;
  path: string;
  title: string;
  etag: string;
  markdownSha256: string;
  recoverySha256: string;
  contentDigest: string;
};

type Document = DocumentSummary & {
  markdown: string;
  recovery: string;
};

type Folder = {
  id: string;
  namespace: string;
  path: string;
  name: string;
  etag: string;
  documentCount: number;
  folderCount: number;
  hasUnsupportedEntries: boolean;
};
```

文書IDは `^wiki-[a-f0-9]{32}$`、フォルダーIDは `^folder-[a-f0-9]{32}$` です。

新規作成・コピー先のIDは送信前に生成し、要求結果を確認できるまで保持してください。

```ts
const documentId =
  `wiki-${crypto.randomUUID().replaceAll("-", "").toLowerCase()}`;
const folderId =
  `folder-${crypto.randomUUID().replaceAll("-", "").toLowerCase()}`;
```

既存フォルダーのIDはAPIの返却値を使ってください。パスからEumenes独自のIDを作らないでください。

`path` はnamespace内の論理的な相対パスです。現在の本番許可領域は `eumenes` です。文書名はpathの末尾、タイトルはtitleで別の項目です。

`recovery` はJSONオブジェクトではなく、不透明なUTF-8文字列です。既存のPlate編集データ・装飾・取込原文を保持するEumenesの形式を使ってください。

Markdown・recoveryのCRLF、末尾空白、Unicode、BOMを勝手に正規化しないでください。移動・コピーのためにMarkdownをPlateから再生成する必要はありません。既存文書にrecoveryがない場合は空文字列が返ります。

応答のETagは、二重引用符を含む文字列です。そのまま保持し、条件ヘッダーへ送ってください。本文ハッシュから自作しないでください。

JSON要求は次を使います。

```http
Content-Type: application/json; charset=utf-8
```

Content-Encodingは省略またはidentityです。gzipは非対応です。応答はJSON、`Cache-Control: no-store` です。

## 4. 現行GET/PUTの維持

### 文書一覧

```http
GET /v1/docling/documents?limit=100&cursor=<前頁のnextCursor>
```

```ts
{
  documents: DocumentSummary[];
  namespaces: string[];
  nextCursor: string | null;
}
```

最初のcursorは省略します。limitは1～100、既定100です。

### 読込み

```http
GET /v1/docling/documents/{id}
```

`200 Document` とETagヘッダーを返します。

### 新規保存

```http
PUT /v1/docling/documents/{新規ID}
If-None-Match: *
```

```json
{
  "namespace": "eumenes",
  "path": "notes/打合せ.md",
  "title": "打合せ",
  "markdown": "# 打合せ\r\n",
  "recovery": "<Eumenes既存形式の復元文字列>"
}
```

5項目すべて必須です。成功は `201 Document` です。

### 更新

```http
PUT /v1/docling/documents/{既存ID}
If-Match: <保存済みの正確な引用符付きETag>
```

```json
{
  "markdown": "# 更新した本文\r\n",
  "recovery": "<現在の復元文字列>"
}
```

titleは任意です。namespace・pathは送信しません。成功は `200 Document` です。保存後のETagを採用してください。

## 5. 文書の管理操作

以下はすべて、対象文書の正確な `If-Match` が必須です。

### 名前変更・移動・タイトル変更

```http
PATCH /v1/docling/documents/{id}
```

```json
{
  "path": "整理済み/新しい名前.md",
  "title": "新しいタイトル"
}
```

pathとtitleの一方以上を指定します。成功は `200 Document` です。ID・本文・recoveryは保持されます。namespace間の移動は対象外です。

### コピー

```http
POST /v1/docling/documents/{コピー元ID}/copy
```

```json
{
  "id": "wiki-22222222222222222222222222222222",
  "path": "整理済み/複製.md"
}
```

成功はコピー先の `201 Document` です。要求のidは送信前に生成したコピー先IDです。コピーのたびに元Artifactの接続先IDを変更しないでください。

### 削除

```http
DELETE /v1/docling/documents/{id}
```

要求本文はありません。成功はHTTP200です。

```json
{
  "id": "wiki-11111111111111111111111111111111",
  "deleted": true
}
```

サーバーはファイル・管理情報の確定と確認を終えてから成功を返します。

## 6. フォルダーと階層一覧

### 階層一覧

```http
GET /v1/docling/library?namespace=eumenes&path=notes&limit=100
```

pathを省略または空にするとnamespaceのrootです。

```ts
{
  namespace: string;
  path: string;
  etag: string;
  entries: (
    | (DocumentSummary & { kind: "document" })
    | (Folder & { kind: "folder" })
  )[];
  nextCursor: string | null;
}
```

直下の項目をID昇順で返します。cursorには前頁のnextCursorをそのまま渡してください。ページ間で固定されたsnapshotではありません。取得中にetagが変わった場合は、一覧を更新してから一括操作を判断してください。

この応答のetagはnamespace全体のlibrary ETagです。文書ETag・フォルダーETagとは用途が異なります。

### フォルダー取得

```http
GET /v1/docling/folders/{id}
```

`200 Folder` とETagを返します。フォルダーETagは配下の文書内容・管理情報・子フォルダーの変更も検出します。

### 空フォルダー作成

```http
PUT /v1/docling/folders/{新規ID}
If-None-Match: *
```

```json
{
  "namespace": "eumenes",
  "path": "notes/新しいフォルダー"
}
```

成功は `201 Folder` です。

### 名前変更・移動

```http
PATCH /v1/docling/folders/{id}
If-Match: <フォルダーETag>
```

```json
{"path":"整理済み/移動後の名前"}
```

配下を含めて移動し、文書・フォルダーのIDを維持します。成功は `200 Folder` です。

### 配下を含むコピー

```http
POST /v1/docling/folders/{コピー元ID}/copy
If-Match: <コピー元フォルダーETag>
```

```json
{
  "id": "folder-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "path": "整理済み/複製フォルダー"
}
```

成功はコピー先の `201 Folder` です。

コピー先root以外の子IDは、元IDと同じprefixに、次のSHA256の小文字16進数先頭32桁を付けた値です。

```text
ASCII(コピー先root ID + "\n" + コピー元の子ID)
```

コピー先rootは要求したIDそのものです。この規則を結果不明時の照合にも使えます。

### 削除

```http
DELETE /v1/docling/folders/{id}
If-Match: <フォルダーETag>
```

空フォルダーだけを削除します。配下も削除する場合は明示的に指定します。

```http
DELETE /v1/docling/folders/{id}?recursive=true
```

本文はありません。成功は `200 {"id":"folder-…","deleted":true}` です。root自体は削除・移動の対象にしません。

## 7. 複数選択の操作

```http
POST /v1/docling/operations
If-Match: <GET /libraryで取得したnamespace全体のETag>
```

一括削除の例です。

```json
{
  "namespace": "eumenes",
  "action": "delete",
  "items": [
    {
      "kind": "document",
      "id": "wiki-11111111111111111111111111111111"
    },
    {
      "kind": "folder",
      "id": "folder-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
}
```

actionとitemの形式は次です。

- `delete`：kind、id。選択フォルダーの配下も削除対象。
- `move`：kind、id、移動先path。
- `copy`：kind、id、移動先path、事前生成したコピー先newId。

kindは `document` または `folder` です。namespaceは要求全体で1つです。

全対象を検査してから一括確定します。要求順の逐次操作や部分成功ではありません。

親フォルダーとその子を重ねて選択した場合、deleteは重複を除去します。move/copyは `400 overlapping_selection` になるため、Eumenes側で選択を整理してください。

成功はHTTP200です。

```ts
{
  namespace: string;
  etag: string;
  items: (
    | { kind: "document" | "folder"; id: string; deleted: true }
    | {
        kind: "document" | "folder";
        id: string;
        sourceId: string;
        ids: Record<string, string>;
      }
  )[];
}
```

idsは元IDから確定後IDへの対応表です。移動時は同じIDです。応答のetagは確定後のlibrary ETagです。

## 8. 競合・エラー・結果不明

既存のエラー形式を使います。

```json
{"error":{"code":"etag_mismatch"}}
```

| HTTP | 主な意味 |
|---|---|
| 400 | 入力・ID・path不正、DELETEの本文、重複する移動・コピー選択 |
| 401 / 403 | 認証失敗／サービス・namespaceの許可不足 |
| 404 | 追加APIはnot_found。現行文書GET/PUTはdocument_not_found |
| 409 | path_exists、invalid_destination、folder_not_empty、unsupported_items |
| 412 | etag_mismatch |
| 413 | 容量・件数超過 |
| 415 | JSON・Content-Encoding不正 |
| 428 | precondition_required |
| 503 | storage_unavailable、save_outcome_unknown、delete_outcome_unknown、operation_outcome_unknownなど |

弱いETag、`If-Match: *`、複数ETag、作成条件と更新条件の同時指定は拒否されます。

412では手元の変更を保持し、最新状態を取得して競合を解決できるようにしてください。最新ETagへ黙って差し替えて再送してはいけません。

既存の移動先は上書きしません。自分自身・配下へのフォルダー移動やコピーも拒否されます。hasUnsupportedEntriesがtrueのフォルダーは、非Markdown記事などを含むため、操作が409 unsupported_itemsで拒否されます。

PUT・PATCH・DELETE・copy・batchを、通信障害や5xxで自動再送する共通リトライから除外してください。

通信断・タイムアウト・5xxでは、確定している可能性があります。要求時点のID、元ETag、内容、コピー先ID、期待したpath/title/digestを保持し、GETで現在状態を照合します。

- 削除：同じIDをGETして存在を確認する。404は現在の不存在であり、特定要求の成功履歴の証明ではない。
- 移動：同じIDと期待したpath/titleを確認する。
- コピー：事前確定したコピー先IDと内容を確認する。
- 保存：contentDigestとtitleなどを確認する。
- 一括操作：保持した対象・コピー先IDと、最新libraryを照合する。

元要求が処理中の場合もあるため、読取りによる確認は回数を制限して行います。後続の別編集と区別できなければ、結果不明・競合として保持してください。

本文の照合方法は次です。文字列を正規化せず計算します。

```text
markdownSha256 = SHA256(UTF8(markdown)) の小文字16進数
recoverySha256 = SHA256(UTF8(recovery)) の小文字16進数
contentDigest =
  SHA256(ASCII(markdownSha256 + "\n" + recoverySha256))
  の小文字16進数
```

末尾に追加の改行はありません。

## 9. 容量・UI・編集状態

現在の上限です。capabilitiesの値を優先してください。

- 要求JSON全体：20 MiB。JSONエスケープ分を含む。
- Markdown・recovery：それぞれUTF-8で8 MiB。
- title：UTF-8で4096バイト、空は禁止。
- path：UTF-8で2048バイト以内、かつ512文字以内。
- 一覧：1ページ100件。
- 一括選択：100件。
- 配下を展開した文書・フォルダー：500件。
- コピーするMarkdownとrecoveryの合計：20 MiB。

pathは相対パスで、絶対パス、空・`.`・`..`要素、バックスラッシュ、制御文字、前後の余白は使えません。文書は `.md` または `.markdown` が必要です。

既存の一覧・編集UIを確認し、フォルダー移動、複数選択、名前変更、コピー、削除を一貫した操作で実装してください。再帰・一括削除では対象範囲を確認できるようにし、ごみ箱へ移す操作として表示しないでください。

同じ文書の保存と管理操作を競合させないでください。未保存の編集がある場合は、既存の保存・破棄・キャンセルの流れに接続し、古い保存応答で新しい編集を上書きしないでください。

削除・結果不明・404を契機に、自動保存が同じIDの文書を再作成しないことも必須です。コピーでは元文書とコピー先の接続情報を区別してください。

削除は現在の正本からの除去です。過去の未参照revision、外部backup、派生SQLiteの安全消去や、ごみ箱からの復元を提供するものではありません。

## 10. 検証と完了報告

まず既存のArtifact接続情報、Plate復元形式、LARM認証、capabilities検証、通信リトライ、未保存状態の管理を確認してください。

固定試験には最低限、次を含めてください。

1. 現行GET/PUTのみのcapabilitiesでも既存機能が動く。
2. 拡張応答と追加項目を受け入れ、利用可能な機能だけを有効にする。
3. 文書の名前変更・移動でIDを維持し、コピーで別IDになる。
4. 日本語・CRLF・末尾空白・装飾・取込原文を含む本文とrecoveryが一致する。
5. 空フォルダー、配下を含む移動・コピー・削除、一括操作が正しい要求を送る。
6. 文書・フォルダー・libraryのETagを取り違えず、412で上書きしない。
7. 通信断・5xx・応答喪失で自動再送せず、現在状態を照合する。
8. 保存中の追加編集、未保存文書の管理操作、削除後の自動保存で編集を失ったり文書を再作成したりしない。
9. 容量超過、保存先重複、権限不足、unsupported_itemsを適切に表示する。

実機試験は検証専用文書・フォルダーだけで行い、既存利用者文書は削除しないでください。Docling本体・OCR・LLMを起動しないでください。

新APIは本番未配備なので、模擬応答・契約試験と実機受入を区別してください。未配備の新機能を実機確認済みとは報告しないでください。

完了時には、変更箇所、旧・新capabilitiesの互換性、試験結果、実機確認範囲、配備状況、LARM拡張配備後に残る受入項目を報告してください。