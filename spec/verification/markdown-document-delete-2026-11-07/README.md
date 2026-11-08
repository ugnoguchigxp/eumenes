# Markdown削除の事前確認

2026-11-07。[追加設計](../../markdown-document-delete-design-2026-11-07.md)。削除機能は未実装。

## 読取り専用の本番調査

settings domainのreadonly操作で保存済みLARM接続先を取得し、既存のbackend認証でGET `/v1/docling/capabilities`とGET `/openapi.json`を確認した。[discovery.json](discovery.json)はcapabilitiesと文書パスの公開methodだけを含み、接続先・認証情報・文書本文は含まない。

capabilitiesはGET/PUTだけで、OpenAPIも文書IDのパスにget/putだけを持つ。公開削除契約がないため、DELETEの試送、空文書による上書き、一覧だけから隠す処理、DBやファイルの直接削除は行っていない。Eumenesの既存公開操作にも文書削除はない。

Codexのproject登録情報と既存のLARM参照資料から、LARMの作業場所はgnosis上の`/srv/ai/apps/local-LLM-harness`と確認した。SSHや別チャットへの送信、サーバー・配備操作は行っていない。

## 変更前baseline

- Docling文書client、Markdown workspace/文書保存の30件成功。
- DesignSystemの文書画面・一覧・cacheの14件成功。

これらは既存機能のbaselineであり、削除機能の検証成功ではない。製品コードを変更していないため、build・一括verify・削除の画面操作は実施していない。設計書と確認JSONの書式、差分空白を確認した。担当外の既存差分は維持した。

ContextStill（このチャット累計）: context_compile 8回 / compile_eval 8回。今回partial。

残作業は追加契約と変更範囲の合意、保存先側の実装・配備、Eumenesの接続と削除UI、部分・結合・実画面の検証。
