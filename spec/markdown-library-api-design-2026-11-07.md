# LARM文書ライブラリ拡張への対応

2026-11-07。利用者添付の確定依頼（LARM実装revision `f860294ba28d7e45990732fe343fbe230f1a973f`、本番未配備）を実装仕様とする。従来の単件削除案を置き換える。新たな要件の承認待ちは設けず、提示された範囲で実装・固定試験・接続仕様更新を行う。

## 目的・完了条件

現行GET/PUTを維持し、capabilitiesで発見した操作だけで文書の管理、空フォルダーと階層一覧、複数選択・再帰操作を扱う。本文・opaque recoveryを管理操作のために変換しない。ETagの用途を区別し、自動再送せず、未保存編集・保存中・結果不明を保護する。拡張未配備時は既存一覧を使い、変更APIの試送はしない。

対象外: LARM配備、SSH、共有フォルダー、実ファイル・DBの直接操作、Docling/OCR/LLM起動、独自版履歴、ごみ箱、添付管理、権限管理、利用者文書の実削除。サーバー操作は利用者が行う。

## 既存機構と接続

- Docling domainのHTTP接続・保存済みsettings・backend credential・bounded read・digest検証を拡張する。methodsは未知値を許容し、拡張path/項目の不足は該当機能だけを無効にする。capabilitiesの有効期限後に再発見する。
- Markdown domainのwriter、workspace、保存queueとrevision/binding検証を再利用。管理操作は同期HTTP契約であり、実行前に固定要求と期待状態をDBへ記録する。専用の再送schedulerは作らない。同じ要求IDは再実行しない。未確定の操作は同じbinding/namespaceの保存・管理操作を抑止する。
- 管理要求は既存open/resolveと同様の認証済み公開APIへ接続し、Artifactの登録local actionから呼ぶ。新revisionのbundleを追加し、既存revisionは変えない。新しい会話担当・モデル指示・自律削除は追加しない。
- DesignSystemの既存文書一覧に階層取得、選択、操作フォーム・確認を追加する。部品はprops/eventsで動き、APIや認証を扱わない。既存Plateとscratch自動一時保存は維持する。

## 状態と安全性

文書・フォルダー・namespace libraryのETagは入力ごとに区別する。対象とコピー先IDは送信前に固定する。フォルダー配下は公開libraryをページングして固定manifestを作り、同じlibrary ETagで揃わない場合は変更前に競合として拒否する。重なるmove/copy選択は親へ整理し、deleteは重複を除く。rootは変更しない。

保存queueが進行中・結果不明、対象workspaceに未保存変更、共同編集中なら管理変更を受け付けない。画面で未反映入力がある対象の管理は、保存/破棄/キャンセルの導線へ戻す。破棄は既存の明示reloadで行う。変更確定後は対応するworkspaceの保存先metadataを更新し、削除したworkspaceは参照を整理して除く。コピーで元workspaceの接続先を変えない。古いapply/saveは存在・revision・bindingと管理操作の予約で拒否する。

通信断・タイムアウト・5xxは未確定として固定要求を保持する。現在状態をGETで回数・件数を限定して照合する。404だけで処理履歴の成功とは表示しない。確定応答の成功と、現在状態の一致確認を区別する。412は競合として保持し、新ETagへの暗黙の載替え・再送をしない。確認できない操作は未確定のまま残し、入力を破棄しない。

## 順序・検証・残作業

1. 既存Docling/Markdown/Artifactのbaselineと旧revisionの内容を記録。
2. capabilities互換・外部client・契約試験。
3. 管理要求の記録、排他、照合、workspace採用、公開APIと結合試験。
4. 階層・空フォルダー・選択とフォーム、Artifact新revision・Web接続と固定画面試験。
5. `verify -- --domain markdown --domain docling --domain capabilities --domain artifact`、型・build・境界・差分点検。既存inventory問題なら個別結果と区別。
6. 現行本番のreadonly互換を確認。拡張の実機受入はLARM配備後へ残し、fixture結果で代替しない。

実施済み: 1〜5、6の現行本番readonly確認。利用者の再起動後、Eumenes公開API・Artifact @4と旧API経路の実画面も確認した。結果は[検証記録](verification/markdown-library-api-2026-11-07/README.md)。残作業はLARM拡張配備後の実機受入。拡張未配備のため、fixture成功を新機能のlive成功としない。

## 実施記録

文書・フォルダー・一括操作、capabilities互換と機能判定、固定要求の永続化、保存との排他、GET限定照合、一覧・確認と既存Plate接続を実装した。管理用取得結果はmetadataのみ、Webのcapabilitiesは上限と判定結果のみを返す。原文・opaque recovery・コピー元の接続先を保持した。既存revisionの内容不変、新Artifact/binding/toolchain @4と入力schemaを検証した。

最終対象backend67件・文書画面22件・Web14件、型・build・対象静的検査が成功。一括verifyの既存inventory問題と担当外format2件は残る。LARM配備・製品サーバー操作・実文書の削除は行っていない。

## ドラッグ＆ドロップによる移動（2026-11-09）

利用者の追加依頼により、管理一覧の文書・フォルダー名から、一覧のフォルダー行、左のフォルダー階層、パンくずへドラッグできるようにする。チェック済みの項目を掴んだ場合はチェック済みの組、チェックしていない項目を掴んだ場合はその1件を対象にする。既存の「移動」はキーボードやタッチでも使える入口として維持する。

ドラッグは拡張一覧と移動が有効な場合に限り、複数件には一括操作の対応と件数上限も適用する。同一namespaceの別フォルダーだけを受け付け、フォルダー自身・配下への移動は拒否する。外部からのドロップは移動要求に使わない。一覧の場所やETagが変わったら開始時点のドラッグは無効とする。ドロップ時に対象と移動先を確定し、名前を保ったパスで既存の確認画面を開く。確認後に既存の単件PATCHまたは一括移動を送る。未保存保護、結果不明の確認、認証、保存APIは既存経路に従う。

検証は画面のドラッグイベント・既存操作の回帰、Web接続と契約試験、対象domain verifyとビルドの順に行う。旧GET/PUTと拡張の固定試験を区別し、実接続は設定済みLARMへのGETで配備状況を確認する。拡張配備後に検証専用文書の移動と読戻しを受け入れる。

実装済み。文書画面40件（追加5件）、Web接続16件、Docling契約・Markdown/Artifact結合48件が成功。旧・拡張capabilitiesの機能判定、正確なETag、本文・復元データの保持、競合・結果不明の試験を再実行した。型、対象lint・書式・サイズ、DesignSystem/Webビルドも成功。対象domain verifyは既存の保管試験の登録問題でinventory停止。[検査結果](../verification-reports/runs/2026-11-09T00-31-05-141Z-fca3df7a-6486-41e7-bdfe-07046f1a1415/report.json)

11月9日9時26分（JST）の実接続はGET/PUTのみ。文書一覧9件と1件の読込み・digestをGETで確認し、Doclingは前後とも停止状態だった。画面変更の反映後、LARMの機能再取得で拡張一覧・移動が有効になる。実環境での移動受入は配備後に、検証専用文書で単件・一括の移動、一覧への反映、移動後のID・本文・復元データの一致を確認する。
