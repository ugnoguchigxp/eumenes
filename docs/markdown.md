# Markdown文書の編集とライブラリ

Artifactの「ファイル一覧」と「編集」を切り替えて使う。一覧と編集を切り替えても、入力中のPlate文書を保持する。Doclingが保存文書の正本であり、Eumenes独自の版履歴やごみ箱は持たない。

上部の新規文書・取込アイコンの隣にあるダウンロードアイコンで、編集中の本文を現在の文書名の`.md`ファイルとして保存できる。

同じ並びの削除アイコンは、一覧ではチェックした文書・フォルダー、編集画面では開いている保存済み文書を対象にする。確認画面で対象を確認し、「削除する」を押して実行する。保存先が未対応、対象未選択、保存中などで使えない場合は、アイコンにカーソルを合わせると理由を表示する。未保存の作業文書だけを消す機能は含まない。

## 保存と一時ファイル

編集画面の保存アイコンからDoclingへ保存する。既存文書は同じ文書IDを更新する。本文、Plateの装飾・表・段組み等の編集データ、取込原文を維持し、変更していないMarkdownとopaque recoveryを再シリアライズしない。

入力を止めると既存SSD cacheへ一時ファイルを自動保存する。cache保存済みとDocling保存済みは別の状態である。cacheは容量整理や再起動で消える。通常のブラウザー下書きも維持し、復元用の正本や版履歴とは扱わない。共同編集の「共同編集に反映」は作業用文書への反映であり、Doclingへの保存と区別する。

保存中の追記は入力として保持する。保存結果不明では同じIDのGETで確認し、PUTを自動再送しない。競合で最新ETagへ黙って載せ替えない。

## 一覧と管理操作

現行GET/PUTのみの保存先でも一覧・読込み・新規保存・更新を利用できる。この場合のフォルダー表示は、取得済み文書の論理パスから組み立てたもので、空フォルダーは表示できない。

保存先が拡張APIを公開している場合は、階層一覧から空フォルダーも取得する。フォルダーIDは保存先の応答を使う。ファイル名はpathの末尾、文書タイトルはtitleとして別に表示する。

一覧で対象を選び、名前・タイトル変更、移動、コピー、削除を行う。「新しいフォルダー」から空フォルダーを作成できる。複数選択では移動先・コピー先フォルダーを指定する。親子を重ねた移動・コピーは親へ整理し、同じ配下を重複操作しない。

単件フォルダーの削除は、配下を含めるか明示する。一括削除では選択したフォルダーの配下も対象になるため、確認画面に対象と範囲を表示する。rootの変更・namespaceをまたぐ移動・既存の移動先の上書きは行わない。非Markdown項目を含むフォルダーは操作できない。

対象に未保存入力がある場合は、編集に戻って保存する、明示的に変更を破棄する、キャンセルする流れへ進む。保存中・保存結果不明・共同編集中の対象はbackendでも保護する。コピーしても元エディタの接続先IDは変えない。

## 接続契約と機能発見

確定仕様は [LARMからの引継ぎ](../spec/reference/larm-document-library-handoff-2026-11-07.md)、実装設計は [対応設計](../spec/markdown-library-api-design-2026-11-07.md)。引継時点の拡張実装revisionは `f860294ba28d7e45990732fe343fbe230f1a973f`、本番未配備。

設定済みのLARM URLと既存のbackend credentialで `GET /v1/docling/capabilities` を取得する。methodsの未知の追加値と未知の追加項目は接続全体の拒否理由にしない。既知の機能に必要なmethod、固定の同一originパス、操作名、上限、コピーID規則の存在を確認し、操作ごとの利用可否を返す。未対応の変更APIを試送しない。

画面表示中はcapabilitiesを定期的に再取得する。backendの接続binding単位の短期cacheが期限を迎えた後に、新しい対応を判定できる。認証情報をArtifactやブラウザーへ渡さない。旧Wikiへのフォールバック、Doclingのensure・lease・activityは行わない。

| LARMの入口 | 用途 |
| --- | --- |
| GET `/v1/docling/documents`、GET/PUT `/{id}` | 現行の一覧・読込み・作成・更新 |
| PATCH/DELETE `/v1/docling/documents/{id}`、POST `/{id}/copy` | 文書の管理 |
| GET `/v1/docling/library` | namespace/pathごとの直下一覧・namespace全体のETag |
| GET/PUT/PATCH/DELETE `/v1/docling/folders/{id}`、POST `/{id}/copy` | 空フォルダーと配下を含む管理 |
| POST `/v1/docling/operations` | library ETagによる一括確定 |

文書・フォルダー・libraryのETagは用途を分け、引用符を含む正確な値を送る。コピー先IDは送信前に固定する。フォルダーコピーの子ID照合は引継ぎのSHA256規則を使う。管理操作のためにMarkdownやrecoveryを変換しない。

Eumenesの既存APIに加え、次を公開する。すべて通常の認証・Origin検査を通す。

| Eumenesの入口 | 用途 |
| --- | --- |
| GET `/api/markdown/files?namespace=…&path=…&cursor=…` | 拡張の階層一覧 |
| POST `/api/markdown/management-inputs` | 固定した要求とコピー先IDの一時入力。ArtifactにはstageIdだけを渡す |
| POST `/api/markdown/management` | stageId、またはrequestIdとcommandで管理操作を1回だけ実行 |
| GET `/api/markdown/management` | 現接続の管理操作の結果・未確定状態 |
| POST `/api/markdown/management/{id}/check` | GETだけによる現在状態の照合 |

Artifactは `artifact:markdown.workspace@4`、binding/toolchainは `markdown.collaborate@4`。新しい担当や自律削除ツールは追加していない。既存revisionは変更しない。

## 結果不明と競合

管理操作の実行前に要求、元ETag、対象、コピー先ID、期待するpath/title/digestを記録する。同じrequestIdでは変更を再実行しない。保存queueが動いていないことをwriterで確認し、未確定の管理操作がある間は同じ接続・namespaceの保存と管理を抑止する。

通信断・タイムアウト・5xxでPUT/PATCH/DELETE/copy/batchを自動再送しない。GETによる限定した照合を行い、一致しなければ結果不明のまま保持する。フォルダー配下もID集合・path・本文digestとlibrary ETagを照合する。取得中に一覧ETagが変わった場合は選択を無効にし、再取得する。

確定した成功と、GETで現在状態の一致を確認した結果は表示を分ける。GET404は現在の不存在であり、特定の削除要求の成功履歴とはしない。412は競合として残し、手元の入力を保持する。

結果を採用する際は照合したmetadataをそのまま使い、別の更新から得たETagだけを採用しない。削除確認後は対応workspaceを除き、古いapply/saveや自動一時保存を契機に正本を再作成しない。SSDの一時ファイルは既存の整理・寿命に従い、バックアップ等の安全消去を保証する操作にはしない。

## Markdownと実機受入の範囲

Plateからの書出しでは一部の改行・リンク補足・表配置等が変わる場合がある。色・サイズ・段組みは標準Markdownへ表現できないため、編集データと取込原文を別に保持する。管理操作は書出しを呼ばず、保存済みの本文とrecoveryを扱う。

[検証記録](../spec/verification/markdown-library-api-2026-11-07/README.md)で固定試験とliveを分けている。拡張未配備の新機能は実機確認済みとしない。LARM配備とDoclingの起動はEumenes側作業では行わない。

## 調査から生成した文書

Pursuitの調査結果も、共同編集sessionを開始せずに新規文書として保存できる。`eumenes/research/` の文書は通常の一覧から開ける。初めて開くときに既存のPlate取込みを使い、それ以後は通常の編集・保存を使う。保存処理が生成本文を再執筆することはない。

生成文書も既存の条件付きPUT・digest照合・GET確認を使う。保存結果不明では再送せず、固定IDと要求を保持する。`POST /api/markdown/generated/{id}/check` はGETだけで保存先を照合する。生成文書の保存中・結果不明と同じ接続・namespaceの管理操作は競合させない。
