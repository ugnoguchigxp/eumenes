# CLI

アーティファクト一覧の「CLI」から、backendのログインシェルを開く。閉じて開き直しても同じセッションへ再接続する。シェルが終了したら画面から再起動できる。

会話の `cli_command` は登録プロジェクトのルートでコマンドを一件ずつ実行する。受付後、終わるとタスク名・終了コード・出力の要点を会話へ返す。画面には対話シェルと直近の実行が表示される。入力待ちには実行の端末から手で入力できる。実行端末は再起動できない。

実行は一件ごとに `$SHELL -l -c` のPTYを作る。`cd`の効果は一件の中だけ有効。既定の期限は120秒、最大600秒。時間切れはSIGTERM、5秒後にSIGKILL、10秒以内に終了を確認する。停止を確認できなければ結果不明とし、そのプロセスが残っている間は次の実行を開始しない。常駐プロセスの管理は対象外。

実行台帳は `shell_runs`。再起動後は未実行を取消、実行中を結果不明にして、自動再実行しない。確定結果は30日・最新2000件を保持する。PTYセッションはbackendのメモリにだけあり、backend停止で終了する。会話用出力はANSIとCRを除き、3万字を超えると先頭と末尾を残す。画面は直近512KiBを再送する。子に渡す環境変数はログインセッションの分（`HOME`・`PATH`・`TMPDIR`・ロケール・`SSH_AUTH_SOCK` など）だけで、LARMのtoken・クラウドのキー・`EUMENES_*`・起動元Claude Codeの印は渡さない（一覧は [terminals.md](terminals.md)）。コマンド・出力を運用ログに出さない。

HTTPは `GET/POST /api/shell/sessions`、`POST /api/shell/sessions/:id/input`・`/resize`・`/restart`、`GET /api/shell/sessions/:id/output`。既存APIと同じBearer・同一origin・loopbackの認証を使う。

接続: `cli_command` → `toolchain:cli.run@1` → `package:cli.run@1` → `binding:cli.run@1` → `adapter:shell@1` の `shell.run` → shell domain。画面は `artifact:cli.workspace@1`、source `shell`、query `query:shell.sessions@1`。既存のOpenUI `terminal-workspace` とDesignSystemを使う。

## 検証

```sh
bun run verify -- --domain shell --domain terminals --domain capabilities --domain dialogue --domain artifact
bun test api/application/shell/cli-toolchain.test.ts api/application/work/claude-code-toolchain.test.ts api/application/toolchain/capability-seed.test.ts
bun run toolchain:bundle -- check api/domains/capabilities/bundles/cli.bundle.json
# サーバー操作の許可がある場合だけ
bunx playwright test tests/browser/cli.spec.ts tests/browser/claude-code.spec.ts
```

自然言語のlive受入では「git statusを見て」「作業ディレクトリを確認して」を実LLMから依頼し、実際の台帳・画面・最終回答と突き合わせる。固定モデルの結合試験とは区別する。
