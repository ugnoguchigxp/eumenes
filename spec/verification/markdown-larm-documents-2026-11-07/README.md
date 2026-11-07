# Plate Markdown → LARM文書APIの検証

2026-11-07。利用者が提示した `larm.docling-files.v1` を接続契約の正本とする。実装の設計は [接続設計](../../markdown-larm-documents-integration-2026-11-07.md)。Doclingの起動・停止・lease・activity操作は行っていない。サーバーの再起動は利用者が実施した。

## 実装

- 保存済みLARM URLと既存API credentialをbackendだけで使用し、capabilities検証後に常駐文書APIのGET/PUTへ接続した。旧Wikiのネットワーク実装を削除した。旧envelopeの変換関数は過去形式のオフライン検査だけに残る。
- Doclingを正本とし、既存workspace・共通queue・revision検証・ブラウザー下書きを再利用。新しい履歴・削除・Provider/Agent Connectionは追加していない。適用済みmigrationは変更せず0004を追加した。
- IDは初回送信前に固定し、強いETagを引用符ごと保存。新規5項目、更新は本文・復元文字列・題名だけを送る。本文とopaque recoveryは変更しない限り再シリアライズしない。
- 同時保存を直列化。結果不明では固定入力と条件を残し、同じIDのGETを最大3回行う。404は不明のまま残し、PUTを再送しない。412は内容一致でも競合を維持し、明示的な基準の採用と保存を分ける。
- 空のrecoveryだけ既存Plate importへ渡す。非空の不正なrecoveryは拒否する。復元前の空上書きを防ぐ。Plateが表示時に補うIDは、利用者の本文編集と分けて元のtreeを保持する。
- common API入口でMarkdown inputsだけownerの20 MiB制限へ渡す。他のJSON要求の1 MiB制限は維持。UTF-8本文・復元情報8 MiB、題名4096 byte、エスケープ後のPUT要求20 MiBを検査する。
- Artifact/binding/toolchain @3と入力schema新revisionを追加し、旧12 revisionの内容不変を確認した。本番のappServicesからMarkdown APIを登録する回帰試験を追加した。

## 固定試験

| 範囲 | 結果 | 補足 |
| --- | --- | --- |
| 広い影響範囲 | backend 1195件、Web 122件、DesignSystem 7件成功 | 最終の本番登録・容量入口・表示ID修正より前。`supplemental.json` と各ログに実行時点を残す |
| 最終backend対象 | 51件成功 | Markdown状態・競合・保存不明、Docling通信、共通HTTP入口、共同編集結合。追加で本番組立1件・旧revision維持1件成功 |
| 最終Plate画面 | 5件成功 | 原文・題名空白保持、保存中の追記、明示解決、読込み中の追記、実Markdown import後のtree保持 |
| Web接続 | 3件成功（広いWeb試験にも含む） | 空recoveryのみimport、非空不正recovery拒否、一覧cursorと領域 |
| 型・build・静的検査 | 対象は成功 | root 3089 files、DesignSystem 532 files、build、対象lint/format/size、diff whitespace |

`verify -- --domain markdown --domain docling --domain capabilities --domain dialogue --domain artifact` は、別作業の保存用コピー `artifacts/pursuit-integration-20261106` 内の大量の試験を一覧検査が拾って停止した。除外の追加や期待値の緩和はしていない。残りを個別に実行し、結果を `supplemental.json` に分けた。初回の対象lint・DesignSystem型の失敗は修正後に再検証済み。無関係なformat/sizeの指摘は修正していない。一括verifyの成功とは扱わない。

## 実LARM（常駐ファイルAPI）

[live.json](live.json)。保存済み設定をbackendの公開readonly操作で取得し、Docling停止中の一覧・新規・読込み・更新を確認。BOM、日本語、CRLF、末尾空白、装飾、取込原文が一致した。同じIDの更新と対照文書不変を確認した。

実PUTの応答をクライアント側で破棄する試験でもPUTは1回で、同じIDのGET照合によって確認できた。別クライアントの実更新による412と編集保持、明示解決、実保存応答を待つ間の追加編集の保持を確認した。ネットワーク故障や同時入力のタイミングは検証用runnerで制御しており、実障害が自然発生した結果ではない。処理前後ともDoclingは `stopped`。

## 実ブラウザーと利用者確認

[browser.json](browser.json)。実Artifact @3で一覧・領域表示、既存の装飾・原文復元、Markdownファイル取込み、新規保存、一覧からの再読込み、同じIDの更新を操作した。

BOM/CRLF/末尾空白/太字を含む1,080,089 byteのMarkdownと2 MiB超のrecoveryが保存できた。修正後の再読込み・題名だけの更新で、本文とopaque recoveryのdigest不変、ETag更新を確認した。実LARMへ別クライアントとして題名更新した後、画面が古いETagの保存を拒否し、手元の題名を保持して競合の選択肢を表示した。

確認ダイアログから先の自動操作は、ブラウザー操作のタイムアウト・タブ喪失で完了を観測できなかった。利用者は「保存済みになった」と回答したが、その後のbackend読取りでは当該検証文書は競合のままだった。したがって、実画面での解決完了は確認済みとしない。利用者が指定した「手元の編集を使って保存する」操作を公開resolve APIと登録済みArtifact actionから実行し、保存済み・dirty=false・最新ETag採用・同じID・原文とopaque recovery一致を確認した。固定のPlate画面試験と実APIの結果を、実画面のダイアログ完了の代わりに記載していない。

最後の読取りでもDoclingは `stopped`。実機器の音声やDocling本体起動・索引同期は対象外であり未実施。画像は [装飾復元](restored-style.jpg) と [競合表示](conflict.jpg) に保存した。競合表示の画像は確認時点のもので、後続の公開APIによる保存後の画面ではない。

## 通し確認で見つけた問題

1. 本番appServicesからMarkdown serviceが渡されず、試験用組立だけが成功した。実組立の回帰試験で修正。
2. Plate初期化時の内部ID補完が題名だけの変更でも本文再書出しを起こした。未編集treeを保持して修正。ViteのHMR/watchが無効なため、画面用サーバーの再起動後に修正版を確認した。
3. 競合選択のダイアログは自動操作だけで完了できず、上記の未確認として残した。

通常ログへ渡す値はHTTP route/status/request ID、queue job ID・状態・safe error codeのみで、接続先・credential・本文・復元文字列を渡す処理は追加していない。検証用文書は削除せず残した。並行作業のScratch・Agency等の差分も維持している。

ContextStill（このチャット累計）: context_compile 6回 / compile_eval 6回。今回の評価は partial（具体的契約は提示仕様と実APIで補完）。
