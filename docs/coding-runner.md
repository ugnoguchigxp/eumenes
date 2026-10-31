# Codex SDK runner

`packages/coding-runner` は、Codex を `@openai/codex-sdk` で動かす独立したBun package。製品DBを開かない。Kanbanの実行者 `codex`、`codex-tasks` domain、`cli/codex-runner.ts` が使う。Codex CLIを直接起動する旧ランナー（`eumenes-coding/1`・`eumenes-coding/2`、MCP経由のworker、`coding` の実行記録、`coding-supervision`）は有効化されたことがなく、2026-10-31に削除した。計画02・03（`spec/delegated-coding-implementation-2026-10-09/`）はこの削除をもって中止とする。

## 構成

| 部分 | ファイル | 役割 |
| --- | --- | --- |
| 常駐プロセス | `src/sdk-cli.ts serve`、`src/sdk-server.ts` | 0600のUnixソケット `sdk.sock` で `POST /sdk` だけを受ける。要求は512 KiBまで |
| 起動と接続 | `src/sdk-daemon.ts`、`src/sdk-client.ts` | backendは `sdkDaemonClient` で常駐プロセスを切り離して起動する。backendの停止では常駐プロセスを止めない |
| 実行 | `src/sdk-service.ts`、`src/sdk-engine.ts`、`src/sdk-store.ts` | 実行ごとにspec・receipt・イベントを非公開directory（0700・0600）へ保存する。起動時に `epoch` を払い出す |
| CLIの起動 | `src/sdk-transport.ts`、`src/sdk-process-tree.ts` | SDKが起動するCLIを `--ignore-user-config --ignore-rules` 付きで包み、process treeを観測して停止する |
| Git | `src/sdk-git-*.ts` | 登録済みremoteへのcommit・pushを、固定したsnapshotとgrantで行う |
| 共通 | `src/storage.ts`、`src/workspace.ts`、`src/sdk-sensitive-files.ts` | 非公開file・lock・原子的な書込み、hardening済みのhost git、workspaceのsnapshot、読み書き禁止のfile名 |

protocolは `eumenes-codex-sdk/1`。操作は `list` `start` `inspect` `events` `stop` `release` `recover` の7個で、path・shell文字列・executableを要求に含めない。workspaceは常駐プロセスの設定（`workspaces`）に登録したIDだけを指し、`protectedPaths` と `remotes` もhost側の設定で、モデルの要求からは得ない。

状態は `accepted` `starting` `running` `settling` `stopping` の後に `succeeded` `blocked` `failed` `cancelled` `unknown` のいずれかで終わる。`sdkTerminal` が終端を判定する。receiptの `managedExecutionStopped` は所有するSDK transportの停止の証拠で、任意の子孫processの停止の証拠ではない。`workspaceReleaseConfirmed` はworkspaceを引き渡せる別の証拠で、CLIの終了やpsの観測だけでは立たない。process treeの観測は封じ込めの証明にしない（receiptの `containment` は `unproven`）。

## 使う側

`api/domains/coding/index.ts` はこのpackageの公開口（`contracts`・`client`）の再exportだけを持つ。`api/application/work/kanban-sdk-host.ts` と `codex-task-runner.ts` がここから常駐プロセスへ接続する。タスクやボードの方針は `codex-tasks` domain とapplicationが持ち、このpackageは実行の仕組みだけを持つ。

`bun cli/index.ts codex-runner list|inspect|events|stop|recover` は、常駐プロセスのソケット（既定は `data/codex-sdk-runner/sdk.sock`、`--socket` で変更）を直接呼ぶ復旧用の操作で、製品DBを開かない。

## DB

旧ランナーの表（`coding_workspaces` `coding_executions` `coding_supervisors` など）は行が0のまま残している。適用済みのマイグレーションは `api/application/retired-migrations.ts` にバイト単位で保存し、表を消すかどうかは別のマイグレーションで決める。

## 検証

`bun run verify -- --domain coding` にdomainとpackageの境界・整形・lint・型・試験を含める。`bun test packages/coding-runner/test` でpackageの試験（transport・Git・sensitive files・常駐プロセス）だけを実行できる。fixtureの結果は、実Codexでの確認と分けて記録する。
