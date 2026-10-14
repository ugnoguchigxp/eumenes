# Claude Code 作業依頼の土台（P2a）検証記録（2026-10-14）

計画: [Kanban × Claude Code 計画（改訂4）](../../kanban-claude-code-plan-2026-10-14.md) の P2a。terminals の作業依頼表・送信器・フックの結び付け・会話の復元・git 制限の起動設定と、会話からの直接依頼（`claude-code.request`）の載せ替え。実装・利用手順は [Claude Code 画面](../../../docs/terminals.md)。

fixture（固定試験）・実機（実 `claude`）の結果を分けて記録する。実 LARM の通し確認は未実施。

## 実機確認（実 `claude` 2.1.299、モデル haiku、一時 git リポジトリ）

作業ディレクトリは eumenes の外（セッションのスクラッチ領域の一時 git リポジトリ。ローカルの bare リポジトリを remote にした）。各フックは `--settings` のファイルで、受けた JSON をそのまま追記するだけのコマンドにして記録した。依頼は些細なもの（ファイル一つ作る・コマンドを一つ実行する・「OK とだけ答える」）にしてコストを抑えた。

| 確認項目 | 結果 |
| --- | --- |
| `SessionStart` の中身 | 対話・`-p` とも届く。`source` は新規 `startup`、`--resume` で `resume`。`session_id`・`transcript_path`・`cwd`・`model` を持つ |
| `--session-id <uuid>` | 以後のフックの `session_id` がその uuid と一致する（`-p`・対話とも） |
| `PostToolUse` の `prompt_id` | **ある**。同じ turn の `UserPromptSubmit`・`Stop` と同じ値。`tool_name`・`tool_input`（`Write` は `file_path` が **絶対パス**、`Bash` は `command`）も届く |
| `Notification` の `prompt_id` | **ある**（同じ turn の値）。`notification_type: "permission_prompt"`、`message: "Claude needs your permission"`。許可後の `PostToolUse` も同じ `prompt_id` |
| `UserPromptSubmit` の `prompt` | 初期プロンプト（引数）は本文と一致する。**貼り付け**（bracketed paste + Enter）の短い複数行（約60字・日本語・引用符・バックスラッシュ入り）は空白も含めて一致する。**長い貼り付け（約4.6 KB）は `\n\n<pasted_content id="74ba">\n…\n</pasted_content id="74ba">\n` に包まれて届く**。→ 一致判定で包みを外してから空白を畳んで比べる（`requests.ts` の `sameTurn`） |
| `--resume <id> --settings <file> "<本文>"`（対話） | `SessionStart`（`source: "resume"`、同じ `session_id`）の後、`UserPromptSubmit` の `prompt` が引数の本文と一致し、`prompt_id` が付く |
| 存在しない会話の `--resume` | 約2秒で `No conversation found with session ID: …` を出して終了コード 1。`SessionStart` は届かない（→ `ended（resume_failed）`） |
| `permissions.deny: ["Bash(git commit *)", "Bash(git push *)"]`（`--settings`） | `git add … && git commit …` は「権限拒否」で実行されず、HEAD は進まない。`git push origin main` も拒否（remote に何も届かない）。**対照**: deny を外した設定では同じ `git add && git commit` が成功して commit された（`git push` の対照は利用者の設定に `Bash(git push*)` の ask があるため `-p` では実行できず、拒否はコマンド形の deny によることまでは確認、対照の push 成功は未確認） |
| trust 確認 | 初めて開く一時ディレクトリの対話起動では trust の確認画面が出る（`--settings` では避けられない）。`-p` では出ない。この確認では画面操作で「信頼する」を選んだ（一時ディレクトリのみ。`~/.claude.json` にそのパスの信頼が残る） |

未確認: Esc 中断時の挙動、`disableAllHooks` 相当、`permissions.deny` を回避するコマンド形（`git -C …`・`sh -c` など。計画 §6 のとおり二重の制限で補う前提）、`mode: commit`（deny 無し）での実際の commit & push（P2b の受入）。

## 固定試験（fixture。偽 PTY と偽 `claude`）

| 区分 | 試験 | 結果 |
| --- | --- | --- |
| domain | `bun test api/domains/terminals`（4ファイル） | 39 pass / 0 fail |
| adapter・会話結合 | `bun test api/application/terminals-adapter.test.ts api/application/claude-code-reports.test.ts api/application/claude-code-toolchain.test.ts` | 6 pass / 0 fail |
| Web・画面 | `bunx vitest run web/src/domains/terminals`、`packages/design-system` の TerminalWorkspace | 7 pass、9 pass（unit 4 + storybook 5）|
| ブラウザ E2E | `bunx playwright test tests/browser/claude-code.spec.ts`（偽 `claude` = `tests/browser/fixtures/fake-claude.sh` が `SessionStart`・`prompt_id` 付きのフックを送る） | 1 pass |

域の試験が確認していること（計画 §5.1 の行）:

- 受付: 同じ id の再送は replay（PTY への書込み無し）、中身が違えば `terminal_request_conflict`、rollback した transaction は何も残さず送らない、追跡不能は `terminal_tracking_unavailable`、未登録 project は `terminal_project_unknown`。
- 送信: `sending` を spawn の前に確定、一 PTY 一依頼、手入力の直後は待つ、許可待ち・作業中の PTY には貼らない、書込み・起動の例外は `cancelled（send_failed）`で再送しない、`recover()` は `queued → cancelled`・送信後 → `unknown（restarted）`。
- 追跡: 10秒（試験では短縮）`SessionStart` が無ければ `unknown（tracking_lost）`・PTY を閉じる、`prompt_id` の無い最初の `UserPromptSubmit` も同じ、別の `session_id` のフックは捨てる、token で拒否。
- 開始・終了: 手入力の turn は依頼を変えない、A の遅れた・重複した Stop で B（同じ会話の次の依頼）は完了しない、別の `prompt_id` の turn で `interrupted`、プロセス終了で `ended`、終端の保存失敗は503・一度の再試行・二度失敗で `started` のまま、購読者の例外で終端が巻き戻る、`stop()` は SIGTERM→SIGKILL・確認できなければ何も書かない。
- 会話の復元: 生きた idle の PTY へ貼り付け、無ければ `--resume <id> --settings`、`--resume` の失敗は `resume_failed`、mode が違う PTY は idle を待って閉じ `--resume`。
- 上限と解放: 上限2で5件の連続実行（別の会話・別の PTY、LRU で idle の Kanban を閉じる）、`direct` は閉じない、生きているプロセスだけを数える、終了済みは8件まで。
- 変更ファイル: 絶対・相対・`notebook_path`、重複なし、プロジェクト外は記録しない、200件まで、別 `prompt_id` の PostToolUse は記録しない。
- 起動設定: Kanban の `work` の PTY の設定ファイルだけに `permissions.deny`（本文が「commit・push まで」でも同じ）。`commit` の PTY と `direct` には無い。設定は 0600、token は引数に出ない。
- 直接依頼: `direct` の PTY だけに入る（Kanban の PTY には入らない）。会話への完了報告は `origin: conversation` かつ `owner: direct` のものだけ、commit 後に requestId `terminal-request:{attemptId}:{state}` で通知。追跡できず止めたときも報告する。

画面: [会話から依頼](conversation-started.png)・[完了の報告](conversation-reported.png)・[追加の依頼を同じ枠へ](conversation-followup.png)。

## 共有ファイルの登録（監督者）

固定試験は共有ファイル未登録でも通るよう、fixture が terminals の migration を自分で足している。登録後は重複を避けて足さない。必要な差分は作業報告に記載した。
