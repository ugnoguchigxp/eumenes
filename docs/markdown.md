# Markdown文書の共同編集

既存アーティファクトの中で文書を書き、会話から任意の部分の編集を依頼する。共同作業を始めると、通常の会話担当から既存collaboratorへ切り替わる。選択範囲や「AIが編集」の専用領域は設けない。

## 保存先

「Doclingに保存」でDocling Deskへ保存する。文字の装飾、表、段組みなどの編集データと取り込んだMarkdown原文を、Doclingで読めるMarkdown記事の中に保持する。同じ文書の保存は同じ記事を更新する。「Doclingから開く」で再読込みできる。

Eumenesには作業用下書き、編集競合を検査するrevision、最後に保存を確認した内容を置く。利用者向けの独自の版履歴は作らない。ブラウザーにも入力中の下書きを保管し、画面を読み込み直した際に復元する。「下書きに反映」はEumenesの作業用文書への反映であり、Doclingへの保存とは区別する。

保存結果が分からない場合は「保存状態を確認」を使う。同じ内容がDoclingにあるか読み取って照合し、自動で保存要求を再送しない。保存中に追記した内容は未保存の下書きとして残る。

## 手入力と会話の編集

AIの応答待ちでも入力できる。利用者とAIが同じ版から編集した場合、先に反映された変更を優先し、古い版による上書きを拒否する。入力中の内容がある画面へ新しい版が届いた場合も、画面の下書きを保持して競合を知らせる。書出しで手元に残すか、確認してから「最新を読み込む」で下書きを破棄する。

## Markdownの保持

Plateの編集データと取込原文を保存する方式である。Markdownの再書出しは編集データからの変換であり、原文と完全一致する保証はない。一部の改行、リンクの補足情報、表の配置、コードブロックの付加情報、先頭のメタ情報などは変わる場合がある。色、サイズ、段組み等の装飾は標準Markdownで表現できない。取込原文は別にダウンロードできる。

Doclingへ保存した記事の末尾にある「書き出し原本」以後には再編集用のデータがある。通常の表示にはデータ本体を出さず、検索本文にも混ぜない。Desk側で本文や復元用データを変更した文書は一致検査で拒否する場合があり、編集内容を黙って別形式へ置き換えない。DeskのAPIには条件付き更新がないため、外部の同時更新を完全に排他する保証はない。保存直前の版確認と保存直後の読戻しで検出できる範囲を確認する。

## 登録と検証

- bundle: `api/domains/capabilities/bundles/markdown.bundle.json`
- toolchain: `markdown.collaborate@2`、package/skill: `markdown.collaborate@1`
- profile: 既存の`profile:collaboration@1`
- binding: `binding:markdown.collaborate@2`、workspace: `workspace:markdown.document@1`（`document.json`）
- artifact: `artifact:markdown.workspace@2`、view: `markdown-workspace`
- backend: `adapter:markdown@1`、操作: `markdown.new/apply/archive`

本文は既存のArtifact upload接続で一時保管し、共通UI受付には参照IDを渡す。共通受付の容量を拡大しない。保存の一時入力は文書ごとに直近1件、通常の入力は1時間・20件まで。文書は編集データ1 MiB、Markdown読込みは256 KiB、Doclingの記事全体は2 MiB以内。

固定試験は `bun run verify -- --domain markdown --domain docling --domain capabilities --domain dialogue --domain artifact`。対象ブラウザー検証は `bun spec/verification/markdown-full-bundle-2026-11-07/browser.ts` で、サーバーを起動せず固定のArtifact画面を操作する。ブラウザーの日本語composition確認と、実OSの日本語入力受入は分ける。

実接続の事前確認は `bun api/application/markdown/markdown-live.ts`、実保存・同じ記事への更新・読戻しは `--save` を付ける。保存済み設定を使い、停止中のDoclingを起動しない。`--save` はDoclingに検証用の記事1件を作成し、同じ記事を2回保存する。サーバー操作にはプロジェクト規則による明示的な許可が必要。
