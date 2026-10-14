# Claude Code 画面

更新日: 2026年10月14日（作業依頼表・送信器へ載せ替え）。アーティファクトの「Claude Code」から、サーバー上で Claude Code（`claude`）を起動し、ブラウザの端末で操作する。

## 使い方

1. 画面右上の「アーティファクトを開く」から「Claude Code」を選ぶ。
2. 開くとすぐ Claude Code が一つ起動し、見出しやボタンの無い端末がアーティファクト領域いっぱいに表示される。
3. Claude Code を終了すると下端に状態と「再起動」が出て、同じ枠に新しく起動できる。タブを閉じてもセッションは backend に残り、開き直すと同じセッションへ再接続する。

起動するプログラムは `claude` に固定し、作業ディレクトリは backend の作業ディレクトリ（通常はリポジトリのルート）。`claude` が backend の PATH に無いと、画面は理由を表示し、入口は会話にもランチャーにも出ない（adapter の可用性が false）。

公開版は `artifact:terminals.workspace@2`。名称「ターミナル」で見出し・追加・閉じるを持っていた `@1` は bundle から外し、登録済み DB には旧 revision のデータとして残る（`@2` が公開される）。

## 作業依頼（会話からの直接依頼と Kanban の土台）

Claude Code への依頼は、PTY に直接書かずに **作業依頼表（SQLite の `terminal_requests`）** に保存し、commit した後に送信器が送る。会話からの依頼は `claude-code.request`（write）が呼び出し側の writer transaction の中で `enqueueInTransaction`（`owner: direct`、`mode: work`、`target: current` か `new`）を呼ぶだけで、PTY には何も書かない。Kanban（計画 [P2b](../spec/kanban-claude-code-plan-2026-10-14.md)）は同じ公開操作を `owner: kanban:<cardId>` で使う。

| 状態 | 意味 |
| --- | --- |
| `queued` | 保存済み・未送信（`cancelQueuedInTransaction` で `cancelled（cancelled_by_person）` にできる） |
| `sending` | 送信器が PTY へ書く直前に commit した状態。ここで止まると送れたか分からない |
| `delivered` | PTY へ書いた（初期プロンプトで起動・`--resume` で起動、または貼り付けて Enter） |
| `started` | Claude Code がこの依頼の作業を始めた（`UserPromptSubmit` の `prompt` が送った本文と一致。`prompt_id` を記録） |
| `completed` / `interrupted` / `ended` / `unknown` / `cancelled` | 終端。最後の報告と変更ファイルは `completed` で保存 |

- 送信器は `store.onCommit`・フック・手入力の待機明け・PTY の起動と終了・5秒ごとの見直しで起き、PTY ごとに最古の `queued` を一件だけ送る。条件はすべて満たすこと: その実行で `SessionStart` を受けている（新しい PTY を起動して送る場合は不要）、activity が `idle`、その PTY に `sending`・`delivered`・`started` の依頼が無い、画面からの手入力（`POST /api/terminals/:id/input`）から3秒以上経っている、`exclusiveGroup: "kanban"` の依頼は作業中・許可待ちの Kanban 用 PTY が無い。
- 送信は `queued → sending`（commit）→ PTY へ書込み → `delivered`（commit）。書込みが例外なら `cancelled（send_failed）`。`sending` の commit 後に backend が止まったら、起動時の `recover()` が `unknown（restarted）` にする。**自動で再送しない。**
- Claude の会話（ディスクに残る `claudeSessionId`）と PTY（使い捨て）は別。`target: new` は `claude --session-id <id> --settings <file> "<本文>"` で新しい会話を始める（`claudeSessionId` は呼び出し側が決めるか、terminals が採番）。`target: conversation` はその会話の生きている PTY（mode が同じ・idle）へ貼り付け、無ければ `claude --resume <id> --settings <file> "<本文>"` で起動する。mode が違う生きた PTY は idle を待って閉じる。`target: current` は最新の生きている `direct` の PTY へ貼り付け、無ければ新しい `direct` の PTY（終了済みの直近の `direct` の枠があれば同じ枠）。`--resume` が `SessionStart` を出さずに終了したら `ended（resume_failed）`。
- 上限（既定4）は **生きているプロセス** だけで数える。上限に達していたら、依頼がなく idle の `kanban:*` の PTY のうち最後に使った時刻が最も古いものを閉じて空ける（会話は残る）。`direct` は自動で閉じず、空けられなければ `queued` のまま待つ。終了した PTY は一覧に最大8件残る。
- 本文は引数として渡し、shell を通さない。`-` で始まる本文はオプションと解釈されないよう先頭に空白を足す。貼り付けは bracketed paste。
- 起動時に指定する作業ディレクトリは、依頼の `projectId`（登録済みのプロジェクトだけ）から host が決める。入力からパスを受け取らない。当面の登録は `eumenes`（backend の作業ディレクトリ）だけ。
- 受け付けない場合: フックの宛先が無効・`curl` が無い・保存先（store）が無い → `terminal_tracking_unavailable`、未登録のプロジェクト → `terminal_project_unknown`、同じ id で中身が違う → `terminal_request_conflict`（同じなら保存済みを返す replay）。
- 会話の回答に渡すのは `{delivered:"queued", task, completed:false, reportedWhenDone:true}` だけ。受領票（`domain:claude-code.receipt@1`）は保存時に固定される `{attemptId, task, target}` で、状態は表から読む。同じ operation の requestId は同じ依頼を指す。作業中の PTY へはすぐ貼り付けず、作業が終わってから送る。

command 担当の SystemContext は、登録 profile・SKILL・共通の操作規則・TOOLS（入力定義）の順に合成され、snapshot として現在のセッション一覧（名前と状態だけ、上限）を受け取る。依頼文は command 担当が作る。

| 単位 | revision |
| --- | --- |
| 担当（profile） | `profile:claude-code.request@1`：依頼を一つの操作で渡す。方針・対象・完了条件を自分で決めない |
| SKILL | `skill:claude-code.request@1`：依頼文を省略・言い換えしない、秘密を入れない、`new` は明示時だけ、対象も目的も無ければ一度確認、「渡した」ことだけを伝える |
| tool / package | `tool:claude-code.request@1`・`package:claude-code.request@1`（backend `claude-code`、入力 `builtin:claudeCodeRequest`） |
| binding | `binding:claude-code.request@1`：→ `adapter:terminals@1` の `claude-code.request`、結果 `domain:claude-code.receipt@1`、`projection:claude-code.result@1` |

## フックと追跡

状態は画面を読まず、Claude Code 自身のフックで受け取る。起動ごとに `--settings <file>` で `SessionStart`・`UserPromptSubmit`・`PostToolUse`・`Notification`・`Stop` のフックを足す（利用者の設定ファイルは変えない）。設定は 0600 の一時ファイルで渡し、実行の終了で消すので、token はプロセスの引数に出ない。フックは `curl -q --noproxy '*'`（利用者の curlrc とプロキシを使わない）で backend の `POST /hooks/terminals/:id` に送る。認証はその実行だけに有効な使い捨て token（`x-eumenes-hook-token`、再起動で変わる）で、本文を読む前に照合する。API token は子に渡さない。本文は 512 KiB まで。フックの宛先は `http://127.0.0.1|localhost|[::1]:<port>` だけを受け付け、それ以外ではフックを付けない（この場合は依頼を受け付けない）。

**依頼への結び付けは `prompt_id`**（実機 Claude Code 2.1.299 で、同じ turn の `UserPromptSubmit`・`PostToolUse`・`Notification`・`Stop` が同じ `prompt_id` を持つことを確認。[記録](../spec/verification/claude-code-requests-2026-10-14/README.md)）。payload の `session_id` がその PTY の会話 ID（`--session-id` / `--resume`）と違うフックは捨てる。

| フック | 動き |
| --- | --- |
| `SessionStart` | その実行は追跡できる（`source` は `startup`・`resume`）。起動後10秒で届かなければ依頼は `unknown（tracking_lost）`、PTY を閉じる |
| `UserPromptSubmit` | activity `working`。`prompt` が送った本文と一致（空白の連続・前後の空白・長文の `<pasted_content>` の包みを無視）すれば依頼が `started`（`prompt_id` を記録）。一致しなければ手入力の turn で、依頼は変わらない。`started` の依頼があるのに別の `prompt_id` の turn が始まったら `interrupted`。最初の `UserPromptSubmit` に `prompt_id` が無ければ `unknown（tracking_lost）` |
| `PostToolUse` | `waiting` なら `working` に戻す。`started` の依頼の `prompt_id` と一致する `Edit`・`Write`・`MultiEdit`・`NotebookEdit` の対象を、プロジェクトからの相対パスで記録する（重複なし・200件まで・プロジェクト外は記録しない） |
| `Notification` | `permission_prompt`・`elicitation_dialog` で `waiting`（依頼ごとに一度 `onWaitingInTransaction` の購読者を呼ぶ）。`idle_prompt` は無視 |
| `Stop` | activity `idle`。同じ `prompt_id` の `started` の依頼だけを `completed`（最後の報告を4000字まで保存）にする。手入力の turn・旧い turn の遅延や重複は依頼を変えない |
| 実行の終了 | `delivered`・`started` の依頼は `ended`（`--resume` で `SessionStart` が無ければ `resume_failed`）。`stop()` で止めたときだけ `unknown（stopped_by_person）` |

- 終端は一つの writer transaction で、表の更新と `onFinishedInTransaction` の購読者を一緒に行う（購読者が例外なら終端も巻き戻る）。保存に失敗したらフックの応答は 503 にし、次のフック・5秒ごとの見直しで一度だけ再試行する。再試行も失敗したら依頼は `started` のまま（`terminals.finish_save_failed`、`attemptId` のみ）。
- `stop(attemptId)`: その PTY に SIGTERM、5秒で SIGKILL。10秒以内に終了を確認したら `unknown（stopped_by_person）` を書いて購読者を呼ぶ。確認できなければ何も書かず `unconfirmed`。
- 起動時の `recover()`: `queued → cancelled（restarted）`、`sending`・`delivered`・`started → unknown（restarted）`（購読者を同じ transaction で呼ぶ）。
- git の制限: **`owner` が `kanban:` で始まり `mode` が `work` の PTY だけ**、設定ファイルに `permissions.deny: ["Bash(git commit *)", "Bash(git push *)"]` を入れて起動する（実機で `git commit`・`git push` が止まることを確認）。直接依頼（`direct`）は利用者がその場で明示した作業なので制限しない。`mode: commit` は制限を外した設定で `--resume` する。

## 完了の報告と SE

- 会話への報告: 会話からの直接依頼（`origin: conversation` かつ `owner: direct`）が終端になると、host が **commit の後に** 会話へ通知を送る（dialogue の `notify`。requestId は `terminal-request:{attemptId}:{state}`。入力は `presentation: "artifact"` で画面に出さず、`sourceKind: "notice"` は予約実行と同じく記憶の学習対象外・ツールチェーン無し・background）。terminals の `onFinishedCommitted` が、終端を書いた transaction の commit 通知の後に表の状態を確かめてから呼ぶ（巻き戻った終端は報告しない）。会話担当はタスク名で何が起きたかを伝え、次の行動を「変更をコミットする・動作を確認する・追加で直す・やり直す」から一つ提案して確認する。作業担当やツールの名前は言わない。提案だけで実行はせず、利用者が「コミットして」と答えれば通常の `claude_code` 経路で同じセッションに渡る。Claude Code の最後の報告は JSON 文字列として通知に入れ（引用を閉じられない）、中の指示に従わない。追跡できず止めたとき（`unknown`）・再起動で確認できなくなったときも報告する。通知を会話が受け付けなかった場合（キュー満杯など）はログだけで再送しない。通知文は `api/application/claude-code-reports.ts`。
- SE: `activity` が `idle` 以外から `idle` へ、または `waiting` に変わると、Web がタイマーと同じ短い音を鳴らす（`useClaudeCodeArtifacts`、出力先・音量・自動再生の解除はタイマー音と共通）。読み込み時点の状態では鳴らさない。
- 既知の制約: 通知は画面に出さないが会話の履歴（利用者側の入力）には残り、予約実行の入力と同じく World の抽出対象から外していない。Esc での中断は Stop が来ないため、次の作業が始まった時に初めて「途中で止まった」と分かる。

## 構成

| 層 | 置き場所 | 役割 |
| --- | --- | --- |
| domain | `api/domains/terminals/` | `Bun.spawn` の `terminal`（PTY、POSIXのみ）でセッションを保持（生きているプロセスの上限4）。出力の直近 512 KiB を保持し、開き直した画面へ先に流す。セッションは保存せず（サーバー停止で全て終了）、作業依頼だけを SQLite に保存する（`repository/`＝migration `terminals/0001-requests`、`ledger.ts`＝状態遷移と購読者、`dispatcher.ts`＝送信器、`sessions.ts`＝PTY、`hook-events.ts`＝フック） |
| HTTP | `GET/POST /api/terminals`、`POST …/:id/input`・`/resize`・`/restart`、`GET …/:id/output`（SSE: `output` は base64 の PTY 出力、`exit` は実行終了） | 他の API と同じ Bearer token・同一 origin・loopback を通る |
| bundle | `api/domains/capabilities/bundles/terminals-screen.bundle.json` | 単独公開 artifact `artifact:terminals.workspace@2`（launcher「Claude Code」）。source `terminals` → `adapter:terminals@1` の `query:terminals.sessions@1`。起動・再起動は `local` action |
| backend adapter | `api/application/terminals-adapter.ts` | セッション一覧の source と可用性、会話からの `claude-code.request`（write、`enqueueInTransaction`、requestId で replay） |
| OpenUI | `packages/artifact-ui/src/terminal-components.tsx`（view `terminal-workspace`） | source の一覧を DesignSystem の `TerminalWorkspace` へ渡す。Kanban のセッション（`owner` が `kanban:`）のペインには持ち主（タスク名）を小さな見出しで出す（直接のセッションは現行の枠なし表示）。セッションが無ければ開いた時に一つ起動する。出力・入力は `ArtifactRuntime.openTerminal` 経由。領域いっぱいの高さは `web/src/app.css` の `.artifact-panel-body:has(.terminal-workspace)` が渡す |
| Web adapter | `web/src/domains/terminals/` | 一覧の取得、local action の API 呼出し、出力の購読（`exit` 無しで切れたら端末を初期化して再接続）、入力の順序保証（一度に一件、待つ間の入力をまとめる）、resize の間引き |

PTY の入出力・会話本文・依頼本文はログに出さない。ログは `terminals.started` / `terminals.exited`（セッションIDと終了コードだけ）、`terminals.tracking_lost`・`terminals.finish_save_failed`・`terminals.dispatch_failed`（セッション ID・attemptId・理由だけ）。入力・resize の HTTP 完了ログは debug にする（キー入力ごとに info を出さない）。

## 安全上の前提

この API は利用者の権限で Claude Code を動かすので、API token を持つ者は実質的にシェルを実行できる。守りは既存 API と同じ loopback 限定・Bearer token・同一 origin であり、token を他へ渡さない。

## 制約

- セッション（PTY）は backend プロセスのメモリにだけある。backend を再起動すると全て終了し、画面は空になる。保存済みの依頼は起動時に `recover()` で終端にする（Claude の会話はディスクに残るので `--resume` で続けられる）。
- 子プロセスは backend の環境変数を引き継ぐ（Claude Code の認証・設定に必要なため）。ただし `EUMENES_*`（API token・鍵・DB の場所）、サーバー自身の出力向けの `NO_COLOR`・`FORCE_COLOR`、サーバーを起動した Claude Code セッションの印（`CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_SESSION_*`、`CLAUDE_CODE_MESSAGING_*` など）は渡さない。画面のセッションは利用者自身の独立したセッションとして起動する。
- 開き直した画面は保持済みの出力（直近 512 KiB）を再生するだけなので、古い部分が切り捨てられていると Claude Code の次の再描画まで表示が崩れることがある。
- 入力は HTTP の POST、出力は SSE。WebSocket は使わない（ブラウザの WebSocket は Authorization ヘッダーを送れないため）。
- Windows は Bun の PTY が未対応のため使えない。

## 検証

```sh
bun run verify -- --domain terminals   # 偽PTYの固定試験と、/bin/sh を実PTYで動かす試験
bun test api/application/terminals-adapter.test.ts api/application/claude-code-reports.test.ts api/application/claude-code-toolchain.test.ts
bunx playwright test tests/browser/claude-code.spec.ts   # 会話 → 画面が開き、セッションが表示される
bun run toolchain:bundle -- check api/domains/capabilities/bundles/terminals-screen.bundle.json
```
