# Plate文書をLARMの常駐文書APIへ接続する

2026-11-07。利用者が提示した`larm.docling-files.v1`の接続・保存・競合・結果不明・検証要件を正本として実装する。既存のMarkdown共同編集設計で合意済みのPlate形式と取込原文、Docling正本、作業用下書きだけの保持を維持する。

## 目的と範囲

Artifactから文書の一覧、読込み、新規保存、同じ文書の更新を行う。本文と復元情報の完全一致、条件付き更新、応答喪失後の照合、追加編集の保持を完了条件とする。Doclingの起動・lease・activity、旧Wiki API、独自版履歴、削除、ファイルシステム操作は追加しない。並行中のAgency・Scratch差分は保持する。サーバーの起動停止は利用者が行う。

## 確認済みの既存構成と再利用

- `MarkdownWorkspace`、Plateの`importMarkdown`、EditorDocument（formatVersion/nodes/originalMarkdown）、ブラウザー下書き、共通Artifact uploadとUI操作を再利用する。
- `markdown` domainはworkspace、revision CAS、保存時点の固定入力、共通queue（同時1件・試行1回）、結果採用、設定bindingを保持する。Doclingの保存文書の複製ライブラリや履歴は作らない。
- `docling` domainのbackend専用接続を拡張し、LARMの保存済みbase URLと既存API credentialをapplicationから注入する。Desk画面用gateway・UI ticket・prepareとは別の公開操作とし、ファイル操作では一切起動しない。
- 新しいHTTP接続が必要な根拠は、旧`/api/wiki`の廃止、GET/PUT・strong ETag・独立したrecovery・新しい上限という、利用者が示した外部仕様である。意味判断やLLMの計画は変更しない。

## 接続と保存契約

1. 接続bindingごとに`GET /v1/docling/capabilities`で契約、basePath、GET/PUT、requiresDocling=false、上限、digest規則を検証する。相対パスを同じLARM originに限定し、認証・本文・復元文字列を通常ログへ渡さない。PUTを共通の再送処理へ通さない。
2. 一覧は許可namespaceとnextCursorを返し、画面の追加読込みへ渡す。IDは`wiki-`形式、ETagは引用符込みで保持する。既存のAPI credential以外のProvider/Agent Connectionを作らない。
3. 初回送信前に安定した外部文書IDをworkspaceに結び付け、namespace/pathを固定する。既定の新規保存先は利用者指定の`eumenes`が実一覧の許可領域にある場合に限り、既存のUUIDベースの論理パスを使用する。許可されていなければ別領域を推測して保存しない。更新時は保存済みnamespace/pathを送信せず、正確なIf-Matchを送る。
4. recoveryは既存EditorDocumentを含むUTF-8文字列として独立保存する。本文に復元情報・空行・見出しを付加しない。非空recoveryの解析失敗をMarkdown取込みへ切り替えない。空の場合のみWebの既存Plate取込みを使い、一時入力と取得したETagで確認してからworkspaceに採用する。
5. 作業用DBの新migrationで、文書の接続情報、最後に確認した本文と復元文字列、競合情報と、直近の保存1件の固定内容・digest・元の条件を保持する。適用済みSQLを変更しない。再読込みした文書は外部IDから同じworkspaceへ対応付ける。
6. 編集していない本文・復元文字列はそのまま再利用する。編集したときだけPlateの既存書出しとEditorDocumentのシリアライズを使う。取込原文は別の既存フィールドに保持し、UTF-8読込みでBOMを除去しない。外部の上限をUTF-8とJSON実体で検査し、既存のノード数・深さ検査は維持する。

## 競合と保存結果不明

- 412は競合として最新文書をGETし、ローカル編集を保持する。画面に最新版と手元の編集を区別して提示し、利用者が明示して解決した保存だけに最新ETagを使う。黙った載替えやワイルドカード更新は行わない。
- タイムアウト・切断・5xxのPUTは再送せず、同じIDのGETでdigest、title、namespace、pathを照合する。404は上限付きの読取りを行い、確認できなければ結果不明のまま固定入力を残す。現在一致を確認するもので、操作履歴の証明とは表示しない。
- 保存中の追加編集、取消、設定変更、別の保存・読込みによって古くなった応答で、現在の内容や未保存状態を上書きしない。recoveryの読込み・取込み完了前は保存を受け付けない。
- 画面には保存中・保存済み・未保存・競合・保存結果不明を別に表示する。確定した拒否とPUT結果不明を混同しない。

## 登録と検証

既存の登録済みrevisionは上書きせず、必要なArtifact・binding・入力schema・toolchainの新revisionを追加する。会話からの共同編集、既存session workspace、保存と成果物の参照を維持する。

部分試験（API契約、ETag、digest、容量、非再送、状態）→実queue/公開APIの結合→影響domain検証→実LARMと利用者Webの順とする。実LARMの失敗を固定モデルの成功で代替しない。実環境の停止状態は読み取って前後比較し、Doclingを停止する操作は行わない。

着手時の基準: 既存Markdown・Wiki・共同編集の21件が成功。実capabilities/OpenAPIは200で指定契約・8 MiB/8 MiB/20 MiB・page 100と一致。Doclingはstoppedで一覧200、許可領域eumenesを確認。新APIへの保存・画面での一連操作は未検証。

残作業: 文書client、作業保存と結果照合、読込みと競合解決、Artifact接続、固定試験、実LARM・Web受入、差分と記録。

## 実施記録

2026-11-07、文書client、状態管理、読込み・明示解決、Artifact @3、公開API、本番組立への接続を実装した。固定・結合・実LARM・実Artifactの保存と読戻しを実施し、詳細は [検証記録](verification/markdown-larm-documents-2026-11-07/README.md) に整理した。共通HTTP入口の旧1 MiB制限、本番API登録漏れ、Plate表示IDによる未編集原文の再書出しも修正した。Viteの画面更新には利用者による再起動が必要だった。

残る未確認は、実画面の確認ダイアログから競合解決・保存までの完了観測（ブラウザー自動操作の制限）。競合の実表示と編集保持、固定画面の解決操作、実公開API・登録actionによる解決・保存は確認済み。一括verifyは無関係な保管コピー内の試験一覧の検査で止まっており、対象の個別検査の成功と区別する。これらを含むため、設計書は実画面まで全完了としてarchiveしない。
