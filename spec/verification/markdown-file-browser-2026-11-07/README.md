# 文書一覧・保存アイコン・SSD cacheの検証

2026-11-07。[設計](../../markdown-file-browser-ui-design-2026-11-07.md)に従う。画像案を先に生成して提示し、その後に実装した。

## 実装

- Artifactのファイル一覧と編集をタブで切替。左のフォルダ、パンくず、検索、文書表、作業用文書を表示する。namespace/pathは実APIの値を使い、ID・ETag・版番号・未取得の日時や所有者を表示しない。
- 一覧は既存library/open/select/moreを再利用。空・読込中・失敗・続きを区別する。フォルダは読み込み済みの文書パスから表示するため、空フォルダや未取得の階層は表示対象外。
- 旧Selectと文書ボタンの羅列を削除。両ビューを保持し、切替だけでPlateの入力を消さない。
- 既存SaveButtonのiconOnlyを公開したSaveIconButtonを使用する。通常編集では共同編集への反映ボタンを表示せず、保存はアイコンに集約。既存の保存・競合・原文保持の処理を維持した。
- 既存scratch uploadへ入力停止後のJSON一時ファイルを送る。題名、Plate、原文、Markdownを保持し、日本語変換中は送らない。同じ成功内容は送らず、進行中は直列化し、待機した古い要求をまとめる。失敗で入力を消さず、自動再送ループを作らない。
- Doclingが正本。cacheは既存の容量整理・貸出・起動寿命に従う独立した一時ファイルで、版履歴を追加しない。提案したputLatest/latestは利用者の訂正で不採用。scratch store/API、DB、migration、toolchain登録の変更は今回追加していない。既存ブラウザー下書きも維持する。

## 固定試験と静的検査

| 範囲 | 結果 |
| --- | --- |
| baseline | Plate画面5件、Web接続3件成功 |
| DesignSystem | 14件成功。階層・検索・失敗・入力保持・アイコン、cacheの待機・同一内容・直列化・失敗・日本語入力、編集から自動保存への接続 |
| Web | 80件成功。うちMarkdown接続と既存uploadへのcache接続6件 |
| backend・Artifact等 | 363件成功。既存Markdown保存とArtifact利用側を含む。cacheファイルの原文・装飾保持も含む |
| 型 | root 3103 files、DesignSystem 539 files成功 |
| ビルド | DesignSystemとWeb成功 |
| 対象lint・format・size | 成功。24ファイルの書式と差分空白も確認 |

`bun run verify -- --domain markdown --domain artifact` は、保管コピー `artifacts/pursuit-integration-20261106` 内の試験が実行経路未登録として検出され、inventoryで停止した。除外や期待値は変更していない。同じverificationPlanの残りを個別に実施した結果が [supplemental.json](supplemental.json)。既に成功した型とビルドは再実行せず別ログを残した。

残りの検査では、全体formatが並行作業のAgency等12ファイルの指摘で失敗した。今回の対象は個別formatで成功している。境界・context・size・SQL・domain docs・lintは対象成功、担当外の指摘は記録して維持した。一括verifyが成功したとは扱わない。

## 稼働APIと実画面

[cache-live.json](cache-live.json): 既存upload APIへの書込みとcontent APIの読戻しを確認。同じ要求IDの再送は同じファイルで、題名・Plate装飾・日本語・BOM・CRLF・末尾空白が一致。前後でDocling文書のID・ETag等が不変だった。

利用者がEumenesを再起動した後、Braveの実Artifact画面で次を確認した。[browser.json](browser.json)に結果を残す。

- 実一覧のフォルダを開き、パンくずと直下の文書表が変わった。[一覧画面](folders.png)
- 新規の検証用作業文書に題名と本文を入力し、ボタンを押さずに「cacheに一時保存済み」になった。Doclingは「未保存」のまま。[編集画面](editor-cache.png)
- 一覧→作業用文書→編集に戻り、入力中の題名と本文が一致した。保存アイコンには可視テキストがなく、アクセシブル名「Doclingに保存」とSVGがある。
- Doclingの文書5件は画面操作の前後で不変。前の起動中に作ったcacheは、利用者の再起動後に公開GETで404となり、既存の一時ファイル寿命を確認できた。

新規の検証用作業文書とcacheは残し、正本への保存はこの画面試験では実行していない。正本への保存と競合の扱いは既存実装と固定試験を維持した。サーバー操作・Docling起動・音声再生は実施していない。

## 差分点検

意味判断を固定分岐へ移す変更はない。フォルダはAPIの構造、検索は表示上の部分一致、保存状態は既存状態に基づく。今回以外のScratch・Agency・画像添付等の差分も存在し、削除・巻戻し・commitしていない。

画像生成は組込みimage_genを使用。[画像案](design.png)と[生成条件](image-generation.md)を保存した。ContextStillはこのチャット累計context_compile 7回 / compile_eval 7回（今回useful）。

## ヘッダーの追加表示調整

利用者の追加指定により「新規文書」「Markdownを読み込む」も既存CreateButton/ActionButtonのiconOnlyへ変更した。操作名はaria-labelとtitleに残し、クリック処理とpendingによる無効化は維持した。既存MarkdownWorkspace画面試験5件、対象lint/format、DesignSystemのbuild用型検査とDesignSystem/Web buildは成功。表示だけの調整のため、新しい試験やAPI変更は追加していない。

対象domainのverifyは従来と同じ保管コピー内の試験一覧で停止した。[今回のreport](../../../verification-reports/runs/2026-11-07T11-42-49-333Z-1189a389-c931-432d-8a6f-93607bc16245/report.json)。差分点検では今回の表示調整と説明追記以外の変更を維持した。稼働画面は再起動待ちであり、この調整後の実画面確認は未実施。ContextStill累計context_compile 10回 / compile_eval 10回（今回partial）。
