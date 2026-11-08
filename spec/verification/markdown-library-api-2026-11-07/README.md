# LARM文書ライブラリ対応の検証

2026-11-07。[対応設計](../../markdown-library-api-design-2026-11-07.md)、[確定引継ぎ](../../reference/larm-document-library-handoff-2026-11-07.md)、[接続・利用仕様](../../../docs/markdown.md)。利用者の範囲はEumenesの実装・固定試験・接続仕様更新。LARM拡張の配備とDocling起動は対象外。

## 実装

- 旧GET/PUTのcapabilitiesを受け入れ、未知method・未知追加項目だけでは全体を拒否しない。既知method/path/操作/上限を検査し、利用可能な機能だけを有効にする。短期cacheの期限後に再発見する。Webには数値上限と判定済みfeature flagsを渡し、任意の外部拡張値を転送しない。
- Docling domainの既存接続・認証・bounded read・ETag/digest検証を再利用。文書PATCH/copy/DELETE、library、folder、operationsを実装し、変更系を汎用再送へ通さない。DELETEは本文なし。本文・recoveryを管理用に再シリアライズしない。
- Markdown domainに`markdown/0005-library-operations`を追加。固定要求・対象・期待するpath/title/digest・コピー先IDを変更前に保持する。同期APIの意図記録であり、独自の再送runnerや版履歴ではない。同じrequestIdは再実行しない。
- writerで保存queue・dirty workspace・共同編集を検査する。未確定の管理操作がある接続/namespaceへの保存と管理を抑止する。古いapply/save/session開始を既存の存在・revision・bindingと予約で防ぐ。
- GET限定の照合は件数・回数を制限する。フォルダーは配下のID集合・path・本文digestと一貫したlibrary ETagを確認する。412で新ETagへ載せ替えない。成功応答と現在状態の一致確認を別の結果にする。取消後や接続変更後の応答は採用しない。
- 管理用の取得結果は検証済みmetadataだけとし、配下全件の本文を操作状態へ抱え込まない。workspaceへは照合したETagをそのまま採用する。移動・名前・タイトル変更は同じID、コピーは固定した別ID。コピーで元workspaceを接続し直さない。
- 保存先が対応した場合は実libraryから空フォルダーも表示し、複数選択・操作フォーム・確認・結果照会を提供する。親子の選択を整理し、再帰削除の範囲を確認する。未保存入力は保存へ戻る/明示破棄/キャンセルへ接続する。削除後はworkspaceを除き、遅い保存で正本を再作成しない。既存のブラウザー下書きとSSD一時ファイル機構を維持した。

新規の表示viewや会話担当は作らず、既存DesignSystem文書画面、OpenUI、Artifact staging、Web adapter、公開APIを使う。Artifactの管理要求は一時入力へ置き、イベントにはstageIdだけを渡す。100件の長いUnicodeパスもイベントの文字列上限へ押し込まない。

登録は `toolchain:markdown.collaborate@4` → `binding:markdown.collaborate@4` → `adapter:markdown@1` → `artifact:markdown.workspace@4`。`schema:markdown-files@1`・`schema:markdown-management@1`を追加した。会話へ新しい削除ツールや自律操作を公開していない。[revision-compatibility.json](revision-compatibility.json)で既存5 definitions/2 bindings/2 artifacts/10 schemasの内容不変を確認。fresh/旧版fixtureからの再seed試験も成功した。利用者の再起動後、公開APIと実画面でArtifact @4の反映を確認した（下記）。

## 固定試験

| 範囲 | 結果 | 根拠 |
| --- | --- | --- |
| 着手前baseline | 32件成功 | Docling文書client・Markdown・共同編集結合 |
| 最終backend対象 | 67件成功 | 旧/新capabilities、全操作の要求、条件とdigest、workspace、公開API、登録、本番組立、公開値・metadataの投影 |
| 最終文書画面 | 22件成功 | 一覧・入力保持、空フォルダー、名前とタイトル、選択と削除範囲、未保存保護、同じ要求の結果確認、未対応の再帰削除無効化 |
| Web接続対象 | 14件成功 | 旧APIでは拡張を試送しない、ページETag変更、固定stage、結果照合、ブラウザーでのschema検証、cache維持 |
| 広い影響範囲 | bun 678件 / Web 118件 / DesignSystem 23件成功 | 最後の公開値・metadata投影と確認ボタン調整より前。以降は上の最終対象と型・静的検査・buildを再実行 |
| 最終型 | root 3126 files / DesignSystem 545 files成功 | tests/storiesを含む |
| 最終build・対象lint/format/size | 成功 | DesignSystemとWeb、58ファイルの書式、42 source filesのサイズ、diff whitespace |

最低限の要件と対応する確認は次のとおり。

1. GET/PUTだけの旧応答、未知method、追加項目、cache期限後の新応答を確認した。
2. malformedな拡張情報は該当機能を無効にし、旧読込みを維持した。未対応変更の試送はない。
3. 名前・移動・タイトル変更で同じID、文書/フォルダーコピーで固定した別ID、元workspaceと別文書の不変を確認した。
4. 日本語、BOM、CRLF、末尾空白、装飾、取込原文とopaque recoveryを保持した。
5. 空フォルダー、配下を含む移動・コピー・削除、一括移動・コピー・削除を確認した。親子を重ねたmove/copyは拒否系、整理した選択は正常系として分けた。
6. 文書/フォルダーETagとlibrary ETagの送信を区別し、412・一覧の途中変更で上書きしない。
7. 故障時に変更を再送せず、同じrequestIdの再実行を防ぎ、限定GETで現在状態を確認した。意図記録はstoreを閉じて再度開いても残った。
8. 保存中・dirty・共同編集を変更前に拒否し、取消後の遅い応答を保留した。削除後の古い編集による再作成を拒否した。
9. 件数・容量・不正条件・保存先重複・権限不足・unsupported_itemsを検査し、入力を保持する。

ログは [focused-backend.txt](focused-backend.txt)、[focused-ui.txt](focused-ui.txt)、[focused-web.txt](focused-web.txt)、広域は [supplemental.json](supplemental.json) と各runnerログ。初回の参照境界・memo依存・新JSONの書式は修正済み。再open試験で二重writerを開いた初回失敗も、正規のclose→open手順に直して再確認した。制約や期待値を弱めていない。

## 一括検査と残る全体gate

`bun run verify -- --domain markdown --domain docling --domain capabilities --domain artifact`はinventoryで停止した。保管コピー`artifacts/pursuit-integration-20261106`内の試験が実行経路未登録として検出される既存問題であり、除外や期待値を変更していない。

同じverificationPlanの残りを個別に実行した結果がsupplemental.json。境界・context・size・SQL・domain docs・lint・各runnerは対象成功。型とbuildは別に実施した。全体formatは担当外の`browser-interact.bundle.json`と`chat-image-attachments.spec.ts`の2件で失敗し、今回の対象は個別format成功。一括verifyの成功とは報告しない。初回の失敗はfirst-*に保存し、最終対象の追加確認は個別ログとして分けた。

## 本番readonlyと未配備の範囲

[live-readonly.json](live-readonly.json)。保存済みsettingsの公開readonly操作と既存backend credentialを使い、更新したDocling clientで本番capabilities・文書一覧・1件のGETを確認した。GET/PUTのみ、追加機能はすべて無効。一覧5件、取得とdigest検証は成功した。前後ともDoclingはstopped。全要求はGETであり、文書を変更・削除せず、Docling/LLM/OCRを起動していない。

LARM拡張は本番未配備のため、新しい操作はfixture/契約試験まで。実Artifactでの新操作、最大規模での実運用性能、実Doclingの配下同期は確認済みとしない。Eumenesサーバーの起動・停止・再起動、LARM配備、SSH、別チャットへの送信を行っていない。

## 利用者の再起動後の確認

2026-11-07 20:34以降（JST）。[公開APIの結果](restart-api.json)と[保存先の再確認](restart-live-readonly.json)。Eumenesはready、文書capabilities・一覧・管理状態・Artifact @4はHTTP 200。一覧5文書、未確定管理操作なし。保存先の再確認もGET/PUTのみで、追加機能はすべて無効。文書GETのdigest検証は成功し、Doclingは前後ともstoppedだった。

実ブラウザーでMarkdown @4を開き、ルートの3文書と1フォルダー、子フォルダーの2文書、パンくずからの移動を確認した。既存の小さな検証文書を開き、保存アイコンが文字なしで有効、Doclingに保存済み、cacheに一時保存済みと表示されることを確認。一覧→編集の切り替え後も文書名・見出し・保存状態を保持した。[一覧](restart-files.jpg)、[編集と一時保存](restart-editor.jpg)。文書本文の編集・正本への保存・削除は行っていない。cacheへの自動保存は既存動作として発生した。

追加操作は保存先のcapabilitiesが未対応のため、変更要求を試送していない。今回の確認は再起動反映と旧API経路の受入であり、LARM拡張の実環境受入を代替しない。

## 配備後の受入

1. 完了: 利用者がEumenesを再起動し、今回のmethods互換対応・migration・Artifact @4を反映。公開APIと開き直したMarkdownの実画面で確認した。
2. LARM担当が拡張を配備した後、capabilitiesの再取得で既知機能が有効になることを確認する。
3. 検証専用文書・フォルダーで、作成→名前/タイトル→移動→コピー→削除、空フォルダー、配下を含む操作、一括操作を実画面から受け入れる。既存利用者文書を削除しない。
4. 実ETag競合、応答喪失、保存との競合、再読込み、旧GET/PUT保存、別文書不変を確認する。Doclingの起動はこの受入に含めない。

差分点検: 業務SQLと試験は所有domainに置き、意味判断を専用分岐へ移していない。分岐はAPI操作、状態、制約の検証である。担当外のAgency等の差分は維持し、branch・commit・公開操作は行っていない。

ContextStill（このチャット累計）: context_compile 9回 / compile_eval 9回。今回useful。
