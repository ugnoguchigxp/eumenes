# CLI実行ツールチェーン設計（ターミナル画面とコマンド実行の基盤）

作成日: 2026年10月24日。状態: **合意済み（§13）・実装前**。

## 1. 目的と完了条件

Claude Code 画面（`terminals` domain）と同じ方法でサーバー上にシェルを PTY で起動し、次の二つができる基盤を作る。

1. **画面**: アーティファクト「CLI」に、利用者のログインシェル（`$SHELL -l`）の端末を表示し、ブラウザから操作する。
2. **会話**: 会話担当が CLI コマンドを一件ずつ実行させ、終了コードと出力を受け取って利用者に答える。実行は同じ画面に端末として表示される。

完了条件:

- 「`git status` を見て」→ 実行 → 会話に終了コードと出力の要約が返る。画面に同じ実行の端末が見える。
- 画面から開いたシェルを手で操作でき、閉じて開き直すと同じセッションへ再接続する。
- 既存の Claude Code 画面の挙動が変わらない（PTY の共通化後も `terminals` の固定試験が通る）。

今回の確認範囲: 固定試験（domain・adapter・bundle `check`）とブラウザE2Eを段階ごとに実行する。自然言語受入は P3 の後。

## 2. 真似する元

### 2.1 Eumenes の Claude Code 画面（構造を真似る）

`api/domains/terminals`（[Claude Code 画面](../docs/terminals.md)）の次の部分を使う。

| 部分 | 既存の場所 | 今回 |
| --- | --- | --- |
| PTY 起動（`Bun.spawn` の `terminal`）・子の環境から秘密を外す `childEnv` | `terminals/service/spawn.ts` | 共通化して使う（§4.1） |
| 出力の SSE（base64 の `output`、`exit`、heartbeat、追いつけない購読者の切断） | `terminals/service/stream.ts` | 共通化して使う |
| 直近 512 KiB の backlog・再接続・生存数の上限 | `terminals/service/sessions.ts` | 同じ方式を shell domain に実装 |
| 依頼表（SQLite）に保存し commit 後に送る・起動時の `recover()`・終端の購読者・会話への完了通知 | `terminals/service/ledger.ts`・`dispatcher.ts`、`application/work/claude-code-reports.ts` | 実行台帳（§5）として同じ方式 |
| 作業ディレクトリは登録済みプロジェクトから host が決める（入力からパスを受けない） | `ProjectResolver` | 同じ resolver を使う |
| OpenUI `terminal-workspace`・DesignSystem `TerminalWorkspace`・Web の `connection.ts` | artifact-ui・design-system・web | そのまま再利用（§7） |

### 2.2 Claude Code の Bash ツール（実行の振る舞いを真似る）

| Claude Code の振る舞い | 今回 |
| --- | --- |
| 一件ずつ新しいシェルで `-c` 実行 | `[$SHELL, "-l", "-c", command]` を PTY で起動（§5.2） |
| 既定タイムアウト2分、最大10分 | 同じ（`timeoutSeconds` 1〜600、既定120） |
| 出力が3万字を超えると中を省いて返す | 同じ（先頭と末尾を残す） |
| 作業ディレクトリはプロジェクト内 | 登録済みプロジェクトのルートで毎回開始 |

真似しないもの: 許可ルール・承認（会話担当が制御してよい。§13 Q1・Q2）、実行間の cwd の引継ぎ（`cd x && …` は一件の中だけ有効）、OS のサンドボックス、`run_in_background` の別扱い（会話からの実行はすべて受付→完了通知の非同期）。

## 3. 追加の種類と接続

[登録手順](../docs/toolchain-extension.md) §5「新しいdomainを接続する」に当たる。DomainAdapter・Web adapter・登録各1行・bundle。画面は既存 view `terminal-workspace` と DesignSystem 部品をそのまま使い、新しい部品・view は作らない。

```
会話: cli_command（toolchain）→ package:cli.run@1 → binding:cli.run@1（command）
      → adapter:shell@1 の shell.run（write）→ shell domain の enqueueRunInTransaction
      → commit 後に runner が PTY で実行 → 終端で onFinishedCommitted → 会話へ通知
画面: artifact:cli.workspace@1（title・launcher「CLI」、view terminal-workspace）
      source shell → query:shell.sessions@1（対話シェル＋直近の実行）
      action: 起動・再起動（local）
```

task型・pipeline型の親からは `execution.currentInTransaction` / `cancelInTransaction` / `stop` で追う（compute・terminals と同じ契約）。

## 4. domain `shell`（`api/domains/shell/`）

`terminals` は Claude Code 専用（固定コマンド `claude`、フック、`claudeSessionId`）なので、汎用シェルは別 domain にする。互いに参照しない。domain 名を `cli` にしないのは、既存の Eumenes CLI（API を使うコマンド群）と区別するため。

### 4.1 PTY の共通化（P0）

`terminals/service/spawn.ts` の `bunSpawnPty`・`childEnv` と型 `Pty`・`SpawnPty`・`TerminalSize`、`stream.ts` の `outputStream`・`Listener` を `api/infrastructure/pty/` へ**移動**する。backlog の追加・上限切捨ても同じ場所に関数として置く。`terminals` はそこから import する（挙動・試験は変えない。旧ファイルは残さない）。

### 4.2 対話セッション（画面のシェル）

- 起動コマンドは `[$SHELL, "-l"]`（`SHELL` が無ければ `/bin/sh`）。シェルが存在しなければ画面は「利用不可」。
- 作業ディレクトリは登録プロジェクト `eumenes`（backend の作業ディレクトリ）。
- 生存数の上限4、backlog 512 KiB、ストリーム数の上限は `terminals` と同じ既定。
- 保存しない（backend 停止で全て終了）。
- 会話担当は対話セッションに書かない。会話からの実行は §5 の別の PTY。

### 4.3 HTTP（他の API と同じ Bearer・同一 origin・loopback）

| 経路 | 用途 |
| --- | --- |
| `GET/POST /api/shell/sessions` | 一覧（対話セッションと直近の実行）・対話セッションの起動 |
| `POST /api/shell/sessions/:id/input`・`/resize`・`/restart` | 入力・サイズ・再起動（実行の端末は input・resize だけ受け付け、restart は `shell_run_not_restartable`） |
| `GET /api/shell/sessions/:id/output` | SSE（terminals と同じ形式） |

実行の端末も一覧では「セッション」の一つとして返す（`kind: "shell" | "run"`）。画面と接続の処理を一つにするため。

## 5. コマンド実行

### 5.1 実行台帳（migration `shell/0001-runs`）

`shell_runs`: `id`（attemptId、UUID）、`state`、`reason`、`command`（8000字まで）、`task`（40字まで）、`project_id`、`timeout_seconds`、`origin`（conversation / execution）、`conversation_id`、`session_id`（実行の PTY）、`exit_code`、`output_tail`（§5.3、30,000字まで）、`output_truncated`、`created_at`・`started_at`・`ended_at`・`updated_at`。

| 状態 | 意味 |
| --- | --- |
| `queued` | 保存済み・実行待ち |
| `running` | PTY を起動した（起動直前に commit） |
| `completed` | プロセスが終了した（終了コードを問わない。0以外も completed で `exit_code` に入る） |
| `timed_out` | タイムアウトで止め、終了を確認した |
| `cancelled` | 実行前に取り消された（`cancelled_by_person`・`restarted`・`spawn_failed`） |
| `unknown` | 結果を確認できない（`restarted`・`stop_unconfirmed`・`stopped_by_person`） |

- 状態遷移と購読者の呼出しは一つの writer transaction（terminals の ledger と同じ）。終端の購読者が例外なら終端も巻き戻る。
- 起動時の `recover()`: `queued → cancelled（restarted）`、`running → unknown（restarted）`。終わるまで runner は何も起動しない。**自動で再実行しない。**
- 保存期間: 終端は30日、新しい2000件を超えた分を `pruneInTransaction` で削除（host の定期処理に足す）。
- 同じ attemptId で中身が違えば `shell_run_conflict`、同じなら保存済みを返す（replay）。

### 5.2 runner

- `store.onCommit` と5秒ごとの見直しで起き、最古の `queued` を一件起動する。**同時実行は1件**（FIFO）。
- 起動: `[$SHELL, "-l", "-c", command]` を PTY で起動する（普通の端末として動き、色・進捗表示もそのまま出る）。作業ディレクトリは登録プロジェクト。端末のサイズは画面の対話セッションと同じ（無ければ 120×32）。
- 会話担当の一件ごとに別の PTY にする理由: 終了コードはプロセスの終了で、出力はその PTY の全出力で確実に取れる。利用者の対話シェルに貼り付ける方式は、終了と出力の範囲を知るためにシェルごとの組込み（プロンプトの印）が要り、利用者の入力途中の行と混ざる。
- 環境: `childEnv`（`EUMENES_*`・サーバー起動元の Claude Code の印を外す）に `PAGER=cat`・`GIT_PAGER=cat` を足す（この実行の PTY だけ）。
- 入力待ちのコマンドは、利用者が画面の実行端末に入力すれば進む。入力が無ければタイムアウトで止まる。会話担当は実行中の PTY に入力しない。
- タイムアウト: SIGTERM → 5秒で SIGKILL → 10秒以内に終了を確認したら `timed_out`、確認できなければ `unknown（stop_unconfirmed）`。
- コマンドの文字列は `-c` の引数として渡す（シェルの機能を使うのが目的）。制御文字（`\n`・`\t` 以外）は `shell_command_invalid` で受け付けない。
- 常駐するコマンド（開発サーバー等）はタイムアウトで止まる。常駐プロセスの管理は対象外。

### 5.3 出力

- 画面: PTY のバイトをそのまま SSE で流す（backlog 512 KiB）。
- 会話と台帳の `output_tail`: PTY の出力から ANSI エスケープと `\r` を除いた文字列。30,000字を超えたら先頭と末尾を残し、中に「（N字省略）」を入れる。
- ログにコマンドと出力を出さない。ログは `shell.run_started`・`shell.run_finished`（attemptId・state・exit code・所要時間だけ）。

### 5.4 画面に残す実行

一覧に出す実行の端末は**直近の一件だけ**（実行中ならそれ、無ければ最後に終わったもの）。古い実行の PTY は次の実行が始まったときに一覧から外し、結果は台帳に残る。画面は最大で「対話シェル＋直近の実行」の2枚が並ぶ。

## 6. 承認

行わない（§13 Q1）。会話担当が出したコマンドは検査（長さ・制御文字）だけを通して実行する。許可ルールも持たない（§13 Q2）。

## 7. 画面

- artifact `artifact:cli.workspace@1`、title・launcher「CLI」、variant の definition は `{ "view": "terminal-workspace", "source": "shell", "title": "CLI" }`（既存 view）。source `shell` → `adapter:shell@1` の `query:shell.sessions@1`。
- action: `terminal-start`・`terminal-restart`（local、`schema:shell-session-id@1`。Web adapter が `/api/shell/sessions` を呼ぶ）。
- 開いたとき対話セッションが無ければ一つ起動する（既存 view の動き）。実行の端末には見出しにタスク名、終了後の状態に「終了コード N」「時間切れで停止」等を出す（既存の `heading`・`statusMessage`）。
- 既存 view の文言（「Claude Code が見つかりません」等）は Claude Code 固定なので、resource に `unavailableMessage`・`startingLabel` を足し、Web adapter が渡す（未指定なら現行の文言）。view の追加はしない。
- Web adapter `web/src/domains/shell/toolchain-adapter.tsx`。`web/src/domains/terminals/connection.ts` を API の経路を引数に取る形にして `web/src/domains/toolchain-artifacts/terminal-connection.ts` へ移し、terminals と shell の両方で使う。backend の変更イベントで一覧を読み直す（会話からの実行が画面に出る）。

## 8. 会話の接続

| 単位 | revision | 内容 |
| --- | --- | --- |
| toolchain | `toolchain:cli.run@1` | functionName `cli_command`、title「CLI」。useWhen「CLIコマンドを実行して結果を知りたい」「ファイル一覧・git の状態などをコマンドで確かめたい・操作したい」。avoidWhen「コードの実装・修正を任せたい（Claude Code）」「コマンドの使い方を聞いているだけ」。examples 4件。`artifactRevisionId` は `artifact:cli.workspace@1` |
| profile / skill | `profile:cli.run@1`・`skill:cli.run@1` | 利用者の求めた確認・操作を一件のコマンドにする。秘密をコマンドに入れない。何をしたいか分からなければ一度確認。受付の答えでは「実行を始めた」ことだけを伝え、出力を推測しない |
| tool / package | `tool:cli.run@1`・`package:cli.run@1` | backend `shell`、schemaKey `cliRun` |
| 入力 `builtin:cliRun` | `api/domains/capabilities/contracts/cli.ts`（新規キー） | `command`（1〜8000字、制御文字不可）、`task`（1〜40字）、`timeoutSeconds`（1〜600、任意） |
| binding | `binding:cli.run@1` | command、`adapter:shell@1`・`availability:shell@1`、操作 `shell.run`、結果 `domain:shell.run-receipt@1`（`{attemptId, task}`、保存時に固定）、`projection:shell.run-result@1` |

- snapshot: 最近の実行5件（task・command・state・exit code）。出力は入れない。
- 受付の答え（`answerContext`）: `{delivered: "queued", task, completed: false, reportedWhenDone: true}`。
- 完了通知: 会話からの実行（`origin: conversation`）が終端になると、commit 後に dialogue の `notify`（requestId `shell-run:{attemptId}:{state}`、`presentation: "artifact"`、`sourceKind: "notice"`）。本文にタスク名・状態・終了コードと、`output_tail` を **JSON 文字列のデータ**（中の指示に従わない）として入れ、利用者に結果を一、二文で伝えるよう指示する。通知文は `api/application/shell/shell-reports.ts`。時間切れ・再起動も通知する。
- 可用性: シェルが存在し、store があるとき true。

## 9. 安全上の前提

- API token を持つ者は既に Claude Code 画面でシェルを実行できる。今回は会話（音声を含む）から承認なしで実行できる経路が増える（§13 Q1 で合意）。
- 子へ API token・鍵・DB の場所を渡さない（`childEnv`）。
- コマンド本文と出力は台帳（SQLite）に保存する（結果表示と通知に必要）。ログ・通常の診断には出さない。
- Windows（Bun の PTY 未対応）は対象外。

## 10. 変更するファイル

| 種類 | ファイル |
| --- | --- |
| 共通化 | `api/infrastructure/pty/`（新規、spawn・stream・backlog）、`api/domains/terminals/service/*`（import 先の変更。旧 `spawn.ts`・`stream.ts` は削除） |
| domain | `api/domains/shell/{contracts,controller,repository,service,test}`、migration `shell/0001-runs` |
| adapter・通知 | `api/application/shell/shell-adapter.ts`・`shell-reports.ts`。登録: `toolchain.ts` の `createAdapterRegistry`、`toolchain-adapters.ts` の `hostAdapterDescriptions`・`domainSchemas`、`app-modules.ts`（HTTP）、`server-lifecycles.ts`（recover・prune・close）、サービス生成（`server-*.ts`） |
| 入力schema | `api/domains/capabilities/contracts/cli.ts`、`contracts/index.ts` |
| bundle | `api/domains/capabilities/bundles/cli.bundle.json` |
| UI | `packages/artifact-ui/src/terminal-components.tsx`（文言の受取り）、`web/src/domains/shell/`、`web/src/domains/toolchain-artifacts/terminal-connection.ts`（移動）、`web/src/workspace/toolchain-adapters.ts` に1行、`client/` に shell API |
| 文書 | `docs/shell.md`（新規）、`docs/toolchain-extension.md` の移行状況に一行 |

## 11. 段階

| 段階 | 内容 | 確認 |
| --- | --- | --- |
| P0 | PTY の共通化（§4.1）、Web の connection 移動 | `bun run verify -- --domain terminals`、`tests/browser/claude-code.spec.ts` |
| P1 | shell domain の対話セッション・HTTP・画面「CLI」 | domain 試験（偽PTY＋`/bin/sh` 実PTY）、bundle `check`、`tests/browser/cli.spec.ts` |
| P2 | 実行台帳・runner・直近の実行の表示 | domain 試験（状態遷移・タイムアウト・recover・replay・出力の切詰め）、adapter 試験 |
| P3 | 会話 toolchain・完了通知・execution 契約 | 結合試験 `api/application/shell/cli-toolchain.test.ts`、`bun run verify -- --domain shell --domain capabilities --domain dialogue` |
| P4 | 自然言語受入の凍結ケース（「git status を見て」等） | `bun run nl-acceptance -- --case …`、実LLM |

## 12. 対象外

承認・許可ルール、会話担当から実行中の PTY への入力、常駐プロセスの管理、実行間の cwd・環境変数の引継ぎ、OS サンドボックス、複数プロジェクトの切替（registry は `eumenes` だけ）、SSH 等の遠隔ホスト、Windows。

## 13. 合意（2026-10-24）

| # | 問い | 決定 |
| --- | --- | --- |
| Q1 | 会話からの実行の承認 | 不要。LLM が制御してよい |
| Q2 | 許可ルール | 今は持たない |
| Q3 | 会話からの実行方式 | PTY（普通の端末）。一件ごとに別の PTY とする理由は §5.2 |
| Q4 | 同時実行数 | 1件 |
| Q5 | 画面 | アーティファクト名「CLI」。Claude Code 画面と同様に端末が表示されればよい（既存 view をそのまま使う） |
