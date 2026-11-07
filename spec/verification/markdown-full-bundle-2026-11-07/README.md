# Markdown共同編集フルbundle・検証記録

2026-11-07。実装と固定試験を進め、実Docling保存の受入は未実行。保存先はDocling Deskを優先し、独自の版履歴を追加していない。

## 判断

Plateは「編集データ＋取込原文をDoclingに保存する」合意済みの方式で採用可能。Markdownの完全互換エディタとは扱わない。既存の27ケースを変更せず測定し、保存用形式からの編集データと原文の復元は27/27、Markdown変換の意味一致は16/27、バイト一致は8/27だった。実DoclingのAPIを通した保存・読戻しと、実OSの日本語入力は受入待ち。

## 実装した接続

- bundle `markdown`、package/skill `markdown.collaborate@1`、toolchain `markdown.collaborate@2`。profileは既存`profile:collaboration@1`をdigest固定で再利用。
- `binding:markdown.collaborate@2`、`workspace:markdown.document@1`（`document.json`）、既存のcollaboratorと`doc.view/edit/write`。UI専用のAI編集領域は設けない。
- `artifact:markdown.workspace@2`、DesignSystemのMarkdownWorkspace、OpenUIの`markdown-workspace`、backend/Web adapter各1つ。既存のArtifact枠内だけを構成する。
- `markdown.new/apply/archive`と共通UI受付・outbox・receipt。本文は既存Artifact upload接続で一時保管し、受付の16 KiB上限を変更しない。
- Docling Wikiのcatalog/import/markdown APIへ既存のbackend専用設定で接続。同じnamespace/pathで同じ記事を更新。UTF8の本文と、末尾の「書き出し原本」以後の未使用Markdownリンク定義に入れた編集データ・原文を保持する。編集データを通常表示・検索本文へ出さない。
- queueから外部通信し、確認済みの保存結果だけを採用。結果不明時は利用者の操作によるGET照合を行い、POSTを自動再送しない。後から入力された内容は残す。

## 固定試験

1. `bun test ./api/domains/markdown/test/workspace.test.ts ./api/domains/docling/test/wiki.test.ts ./api/application/markdown/markdown-integration.test.ts ./api/application/markdown/markdown-registration.test.ts ./packages/artifact-ui/src/markdown-composition.test.ts ./api/application/migrations.test.ts` は最終40件成功・950 assertions。編集構造・原文の保存と復元、同じ記事の更新、SQLiteの再オープン、UIとAIの版競合、保存中の追記、取消・設定変更・再起動後の結果不採用、結果不明のGET照合、容量の事前拒否、旧保存形式の読取り、新形式の改変拒否を含む。
2. 既存DBのデータ・migration checksumを保った更新、公開済み@1から@2への登録・再seedの冪等性を確認。全bundleのfresh seed・再seedは別途 `./api/application/toolchain/capability-seed.test.ts` の3件成功・370 assertions。実行中のサーバーへ適用した結果とは区別する。
3. OpenUIの文書部品を説明文と同じ通常のlayout JSONへ組み合わせ、異なるsource kindの参照を拒否する。実共通collaboratorの`doc.*`を固定モデルから実行し、変更が作業文書とArtifact sourceへ返る結合も含む。
4. ブラウザーは32件成功・pageerror 0。既存OpenUIラッパーとDesignSystemの実部品をサーバーなしの固定画面で操作した。35個のtoolbarボタン、各文字装飾、色・フォント・配置・行間・見出し、3種類のリストと字下げ、チェック、表と行列操作、リンク・画像・数式・脚注・区切り線・コールアウト・折りたたみ・目次・段組み・絵文字、Undo/Redoと書式解除、保存と受付の順序、下書き復元、競合、狭い幅を確認した。
5. Chromiumのnative composition protocolで、かな入力→変換→確定→Undo、および確定済みの追記がある状態での変換取消とAI更新の保留を確認。OSの日本語IMEそのものを操作した結果ではない。未確定入力だけを取り消して画面がcleanに戻った場合は、保留中の新しい版を読み込めることを不具合と扱わない。

[ブラウザー結果](browser-results.json)、[27ケースの保持結果](preservation-results.json)。実行画面は `verification-reports/markdown-full-bundle-2026-11-07/artifact.png` と `artifact-formatted.png`、`artifact-narrow.png`（生成物のためgit対象外）。事前の[画像生成案](../../design/markdown-editor-2026-11-07/artifact-v2.png)とは区別する。

## 試験中に直した原因

- ネイティブ選択がPlateの内部選択へ届く前に書式を押すと別の範囲へ適用されるため、toolbar操作時に実際の選択範囲をPlateへ渡す。
- 下線・上下付き・callout・toc・columns等の書出しには公式`remarkMdx`設定が必要。設定なしではserializerが例外を出して保存へ進めなかった。
- PlateElementのHTML属性は`attributes`経由で渡す。通常のpropsとして渡していたdata属性はDOMへ出ず、段組み等の表示が適用されなかった。
- Indent/Listの既定対象は段落だけだったため、見出しと引用も対象として明示。リスト自体の描画・採番は公式pluginを再利用する。
- toolbarの1操作をUndoの1単位として分ける。脚注の作成も公式のreference＋definition挿入を使う。
- editorの初期化・更新で入力をcloneし、表示側のnode ID正規化が保存元を変更しないようにした。UI受付より先に新しいsourceが届いても保存要求が欠落しないようにした。
- 結果不明の送信内容を直近1件だけ保持し、再起動後にもGET照合できるようにした。独立した版履歴ではない。
- Plateと数式CSSを通常のDesignSystem importで読み込むと、Markdown以外のNode環境でCSS import例外が起きた。`@eumenes/design-system/markdown`を別入口として遅延読込みし、通常画面の試験を再確認した。
- DoclingはHTMLを無効化して描画するため、HTMLコメントも文字として表示する。保存形式を末尾の未使用リンク定義に変更した。`data:`も同じparserが拒否するため、取得されない予約ドメインのHTTPS形式を使う。

期待値や元の27ケースは弱めていない。型確認に失敗したビルド後に古いdistで動いた1回は検証結果に採用せず、ビルド成功後の結果を記録した。

## Doclingの表示・索引確認

`bun spec/verification/markdown-full-bundle-2026-11-07/docling-format-input.ts` と `uv run --no-project spec/verification/markdown-full-bundle-2026-11-07/docling-format.py` で再現する。Doclingソースから純粋な`content.render`・`catalog.evidence_body`・`split_frontmatter`等だけを読み、Docling指定のMarkdownIt/PyYAMLバージョンで実行した。アプリを起動せず、Docling本体・設定・DBを変更しない。

frontmatterで始まる日本語本文を入力し、読めるHTML、復元用データの非表示、本文だけの索引、frontmatter抽出による本文改変の防止を確認。[実測と参照元hash](docling-format-results.json)を保存した。実HTTP経由の保存確認とは区別する。旧v1コメント形式の読取りは維持する。

## 全体確認と実接続

| 確認 | 結果 |
| --- | --- |
| capabilities domain | 258件成功、3,239 assertions、56 files |
| artifact domain | Bun 336件、Web 74件成功 |
| resources domain | Bun 15件、Web 13件成功 |
| Webの閲覧中文書・共同編集接続 | 18件成功 |
| 型確認 | `bun check` 最終workspace 3,060 files、検証コピー3,059 files、ともに成功 |
| 対象lint / サイズ / bundle check | 成功。サイズ18 files。最新版@2の契約を検査 |
| DesignSystem・Web build | 成功 |
| ブラウザー | 32件成功、pageerror 0 |

検証用にgit対象・未追跡の現在ソースを独立ディレクトリへコピーした。依存パッケージだけを再利用し、workspace packageとDesignSystem distはコピー内へ接続。入力の整合性を確認し、実行中にはコピーを編集していない。途中の部分コピーで他作業のfixture分割との不整合が出た実行は採用せず、全6,517 filesの整合性確認後にcapabilitiesを実行した。最後の保存形式変更後は保存・登録・合成・移行40件、保持27ケース、型・lint・サイズ・bundleを再確認した。最終点検で要素のchildrenを持たないroot nodeの拒否も確認した。追加試験のfixture変数の参照誤りで1回失敗した結果は採用せず、参照を直した後の40件・950 assertionsを最終結果とする。変更していないブラウザー・他domainの成功結果は繰り返していない。

全体gateは未通過。通常workspaceの`bun run verify -- --domain markdown`は、別件のgit対象外`artifacts/pursuit-integration-20261106/...`ソースコピーが試験inventoryへ含まれて停止した。このコピーは変更・削除していない。検証用コピーで規定の`--domain markdown --domain docling --domain capabilities --domain dialogue --domain artifact --domain resources`を実行すると、別作業の`dialogue/service/agency-actions.ts`のdialogue→settings依存違反で停止。dialogueを外した実行も全体formatの別作業15ファイルで停止した。境界や期待値を緩めず、到達しなかった対象試験を上表の個別実行で確認した。別作業の差分と同じファイルの変更も点検し、巻き戻していない。

Web全体の初期gzip予算も未通過。Markdownの接続だけを外した比較用コピーでも entry 195,184 / initial 342,041 bytesと既存予算を超える。比較時のMarkdown追加分は1,744 bytes、編集本体は開いたときの遅延chunk（約414 KiB gzip）。予算値は変更していない。

稼働中Eumenesの読み取り専用APIでは`artifact:markdown.workspace@1`を確認したが、最新版@2は未反映だった（[読み取り結果](registration-live-status.json)）。公開済みrevisionは上書きしていない。実接続の読み取り確認ではDocling Deskが`stopped`だったため終了し、文書POSTは0回。[事前確認結果](live-status.json)。保存済み設定を使い、接続先やcredentialを再要求していない。

起動・再起動の明示許可後に最新版の登録を反映し、準備済み`api/application/markdown/markdown-live.ts --save`で検証用記事1件を2回更新する。装飾・原文と同じsource IDでの読戻しを確認してから、実接続済みと記録する。

## 制約・残る受入

- Markdown変換の不一致: loose-list、table alignment、code fenceの付加情報、inline/reference linkのtitle・inline image構造、soft break類、frontmatter、HTML details。原文と編集データは保存するが、変換後の完全一致を保証しない。画面にも読込み・書出しの制約を表示する。
- Desk APIにCASがないため、外部の同時更新を完全に排他できない。直前の版と直後の読戻しを確認する範囲に限定する。外部で復元用データや本文を変更した文書は一致検査で拒否する場合がある。
- 実Docling保存・実LLMによる自然発話の担当選択・実OSの日本語入力はfixtureと区別し、未確認のまま受入完了としない。
- この構築ターンのcontext_compileは1回。返却内容は既存のtoolchain/Artifact機構の再利用判断に使った。compile_evalも1回登録済み（useful平均80、run `00000000-0000-0000-18e5-a41958f6390f`）。

## 最終差分点検

利用者の発話・題材・例文に対応する分岐は追加していない。担当選択と編集内容は既存collaboratorへ委ねる。専用実装はPlate値の契約検査、UIの編集中状態、Doclingの公開API・容量・索引仕様への接続に限定した。保存形式の日本語区切りはDoclingの既存外部契約による。サーバーの手動起動・停止・再起動、別チャットへの送信、commit・pushは実施していない。
