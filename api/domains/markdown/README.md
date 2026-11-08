# Markdown

Plateの編集データと取込原文を管理する作業用文書。保存先はLARMのDocling文書APIで、接続はapplicationが既存docling domainから渡す。共同作業の判断と文章の編集は既存collaborator、`doc.view/edit/write`、session workspaceを使う。

- repository: 現在の作業文書、session、受付結果、期限付き入力、結果確認用の直近1件。独立した版履歴は持たない。
- service/workspace: UIとcollaborator共通のrevision照合・文書検査。古いターンや古い版を拒否する。
- service/index: 共通queueへ保存を渡す。外部通信はwriter transactionの外で行い、保存中の追記は保存結果で置き換えない。
- service/archive-recovery: 結果不明の保存を新しいGETで照合する。POSTは再送しない。
- controller: Docling一覧・読戻し・照合と期限付き入力。認証とOrigin検査はアプリ共通middleware。

登録は `markdown.bundle.json` と `adapter:markdown@1`。画面はDesignSystemのMarkdownWorkspaceをOpenUIの`markdown-workspace`から表示する。WebやCLIからDBを開かない。

使い方と制約は [docs/markdown.md](../../../docs/markdown.md)、設計と検証記録は [設計書](../../../spec/markdown-collaboration-full-bundle-design-2026-11-07.md)を参照。

- service/generated・generated-job: タイトル付きMarkdownをsessionなしで新規保存する公開操作。ホストから注入する出所検査と一時ファイル接続を使い、既存ArchivePort・Queue・条件付きPUT・GET照合を共用する。生成文書の固定入力とreceiptを保持し、独自の文書版履歴は作らない。
