# Claude Code 画面

更新日: 2026年10月14日。アーティファクトの「Claude Code」から、サーバー上で Claude Code（`claude`）を起動し、ブラウザの端末で操作する。

## 使い方

1. 画面右上の「アーティファクトを開く」から「Claude Code」を選ぶ。
2. 開くとすぐ Claude Code が一つ起動し、見出しやボタンの無い端末がアーティファクト領域いっぱいに表示される。
3. Claude Code を終了すると下端に状態と「再起動」が出て、同じ枠に新しく起動できる。タブを閉じてもセッションは backend に残り、開き直すと同じセッションへ再接続する。

起動するプログラムは `claude` に固定し、作業ディレクトリは backend の作業ディレクトリ（通常はリポジトリのルート）。`claude` が backend の PATH に無いと、画面は理由を表示し、入口は会話にもランチャーにも出ない（adapter の可用性が false）。

公開版は `artifact:terminals.workspace@2`。名称「ターミナル」で見出し・追加・閉じるを持っていた `@1` は bundle から外し、登録済み DB には旧 revision のデータとして残る（`@2` が公開される）。

## 会話から依頼する

会話で「Claude Code で〜して」と頼むと、ツールチェーン `toolchain:claude-code.request@1`（関数 `claude_code({request})`）が選ばれ、command 担当が `claude-code.request` を一つ実行する。結果の画面は `artifact:terminals.workspace@2` が開く。

| 状態 | 動き |
| --- | --- |
| 実行中のセッションがある | 依頼文を bracketed paste で貼り付け、少し待って Enter を送る（複数行でも一つの入力になる） |
| 終了したセッションだけがある | 直近のセッションを同じ枠・最後のサイズで再起動し、依頼文を Claude Code の初期プロンプト（引数）として渡す |
| セッションが無い | 新しく起動し、依頼文を初期プロンプトとして渡す |
| `session: "new"`（利用者が別セッションを明示） | 上限4の範囲で新しいセッションを起動する |

画面への反映: 依頼は画面が表示しているのと同じ PTY セッションに入るので、出力はそのまま画面に流れる。セッション一覧の `requests`（会話から渡した件数）が増えると Web の `useClaudeCodeArtifacts` が「Claude Code」画面を開く。一覧の query（root `terminals`）は backend の変更通知（会話の操作の commit）で読み直すため、開いたままの画面にも会話が起動・再起動したセッションが現れる。検証は `tests/browser/claude-code.spec.ts`（[記録](../spec/verification/claude-code-toolchain-2026-10-14/README.md)）。

依頼文は引数として渡し、shell を通さない。`-` で始まる依頼はオプションと解釈されないよう先頭に空白を足す。同じ requestId の再実行は受領票を返すだけで再送しない（受領票は backend のメモリに直近200件）。会話の回答に渡すのは `{delivered, task, completed:false, reportedWhenDone:true}` だけで、作業の完了・内容は回答しない（完了は後から報告される）。

| 単位 | revision |
| --- | --- |
| 担当（profile） | `profile:claude-code.request@1`：依頼を一つの操作で渡す。方針・対象・完了条件を自分で決めない |
| SKILL | `skill:claude-code.request@1`：依頼文を省略・言い換えしない、秘密を入れない、`new` は明示時だけ、対象も目的も無ければ一度確認、「渡した」ことだけを伝える |
| tool / package | `tool:claude-code.request@1`・`package:claude-code.request@1`（backend `claude-code`、入力 `builtin:claudeCodeRequest`） |
| binding | `binding:claude-code.request@1`：→ `adapter:terminals@1` の `claude-code.request`、結果 `domain:claude-code.receipt@1`、`projection:claude-code.result@1` |

command 担当の SystemContext は、登録 profile・SKILL・共通の操作規則・TOOLS（入力定義）の順に合成され、snapshot として現在のセッション一覧（名前と状態だけ、上限）を受け取る。会話担当の判断は「直接回答・確認・`claude_code` を呼ぶ」だけで、依頼文は command 担当が作る。

## 完了の報告と SE

状態は画面を読まず、Claude Code 自身のフックで受け取る。起動ごとに `--settings <file>` で `UserPromptSubmit`・`Stop`・`Notification`・`PostToolUse` のフックを足す（利用者の設定ファイルは変えない）。設定は 0600 の一時ファイルで渡し、実行の終了で消すので、token はプロセスの引数に出ない。フックは `curl -q --noproxy '*'`（利用者の curlrc とプロキシを使わない）で backend の `POST /hooks/terminals/:id` に送る。認証はその実行だけに有効な使い捨て token（`x-eumenes-hook-token`、再起動で変わる）で、本文を読む前に照合する。API token は子に渡さない。本文は 512 KiB まで、使うのはイベント名・`prompt`・`notification_type`・`last_assistant_message`（4000字まで）だけ。フックの宛先は `http://127.0.0.1|localhost|[::1]:<port>` だけを受け付け、それ以外ではフックを付けない。`curl` が無い環境では状態が分からないだけで、依頼と画面は動く。

| フック | 状態（一覧の `activity`） | タスク |
| --- | --- | --- |
| `UserPromptSubmit` | `working` | `prompt` が渡した依頼文と一致すればそのタスクの作業が始まる。一致しない作業（画面で直接打った依頼）はタスクにしない。前のタスクが Stop 無しで残っていれば「途中で止まった」と報告する |
| `PostToolUse` | 許可待ちのあとに `working` へ戻す | — |
| `Notification` | `permission_prompt`・`elicitation_dialog` のとき `waiting` | 報告はせず SE だけ。`idle_prompt`（放置）は無視する |
| `Stop` | `idle` | 作業中のタスクを「終わった」と報告する |
| 実行の終了 | — | 未報告のタスクを「作業担当が終了した」と報告する |

- タスク名: 会話から依頼するとき command 担当が依頼の言葉から短い `task`（40字以内）を付ける。依頼は順に並び、Claude Code が実際にその依頼を始めた時だけ作業中になるので、先に動いていた作業の Stop が後の依頼の完了と扱われない。フックが無い環境ではタスクを追わない。
- 報告: タスクが終わると host が会話へ通知を送る（dialogue の `notify`。requestId はセッション・実行・報告番号で決まる。入力は `presentation: "artifact"` で画面に出さず、`sourceKind: "notice"` は予約実行と同じく記憶の学習対象外・ツールチェーン無し・background）。会話担当はタスク名で何が起きたかを伝え、次の行動を「変更をコミットする・動作を確認する・追加で直す・やり直す」から一つ提案して確認する。作業担当やツールの名前は言わない。提案だけで実行はせず、利用者が「コミットして」と答えれば通常の `claude_code` 経路で同じセッションに渡る。Claude Code の最後の報告は JSON 文字列として通知に入れ（引用を閉じられない）、中の指示に従わない。通知を会話が受け付けなかった場合（キュー満杯など）はログだけで再送しない。通知文は `api/application/claude-code-reports.ts`。
- SE: `activity` が `idle` 以外から `idle` へ、または `waiting` に変わると、Web がタイマーと同じ短い音を鳴らす（`useClaudeCodeArtifacts`、出力先・音量・自動再生の解除はタイマー音と共通）。読み込み時点の状態では鳴らさない。
- 既知の制約: 通知は画面に出さないが会話の履歴（利用者側の入力）には残り、予約実行の入力と同じく World の抽出対象から外していない。Esc での中断は Stop が来ないため、次の作業が始まった時に初めて「途中で止まった」と分かる。

## 構成

| 層 | 置き場所 | 役割 |
| --- | --- | --- |
| domain | `api/domains/terminals/` | `Bun.spawn` の `terminal`（PTY、POSIXのみ）でセッションを保持（上限4。画面からは一つだけ起動する）。出力の直近 512 KiB を保持し、開き直した画面へ先に流す。保存はせず、サーバー停止で全セッションを終了する |
| HTTP | `GET/POST /api/terminals`、`POST …/:id/input`・`/resize`・`/restart`、`GET …/:id/output`（SSE: `output` は base64 の PTY 出力、`exit` は実行終了） | 他の API と同じ Bearer token・同一 origin・loopback を通る |
| bundle | `api/domains/capabilities/bundles/terminals-screen.bundle.json` | 単独公開 artifact `artifact:terminals.workspace@2`（launcher「Claude Code」）。source `terminals` → `adapter:terminals@1` の `query:terminals.sessions@1`。起動・再起動は `local` action |
| backend adapter | `api/application/terminals-adapter.ts` | セッション一覧の source と可用性、会話からの `claude-code.request`（write、requestId で replay） |
| OpenUI | `packages/artifact-ui/src/terminal-components.tsx`（view `terminal-workspace`） | source の一覧を DesignSystem の `TerminalWorkspace` へ渡す。セッションが無ければ開いた時に一つ起動する。出力・入力は `ArtifactRuntime.openTerminal` 経由。領域いっぱいの高さは `web/src/app.css` の `.artifact-panel-body:has(.terminal-workspace)` が渡す |
| Web adapter | `web/src/domains/terminals/` | 一覧の取得、local action の API 呼出し、出力の購読（`exit` 無しで切れたら端末を初期化して再接続）、入力の順序保証（一度に一件、待つ間の入力をまとめる）、resize の間引き |

PTY の入出力・会話本文はログに出さない。ログは `terminals.started` / `terminals.exited`（セッションIDと終了コードだけ）。入力・resize の HTTP 完了ログは debug にする（キー入力ごとに info を出さない）。

## 安全上の前提

この API は利用者の権限で Claude Code を動かすので、API token を持つ者は実質的にシェルを実行できる。守りは既存 API と同じ loopback 限定・Bearer token・同一 origin であり、token を他へ渡さない。

## 制約

- セッションは backend プロセスのメモリにだけある。backend を再起動すると全て終了し、画面は空になる。
- 子プロセスは backend の環境変数を引き継ぐ（Claude Code の認証・設定に必要なため）。ただし `EUMENES_*`（API token・鍵・DB の場所）、サーバー自身の出力向けの `NO_COLOR`・`FORCE_COLOR`、サーバーを起動した Claude Code セッションの印（`CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_SESSION_*`、`CLAUDE_CODE_MESSAGING_*` など）は渡さない。画面のセッションは利用者自身の独立したセッションとして起動する。
- 開き直した画面は保持済みの出力（直近 512 KiB）を再生するだけなので、古い部分が切り捨てられていると Claude Code の次の再描画まで表示が崩れることがある。
- 入力は HTTP の POST、出力は SSE。WebSocket は使わない（ブラウザの WebSocket は Authorization ヘッダーを送れないため）。
- Windows は Bun の PTY が未対応のため使えない。

## 検証

```sh
bun run verify -- --domain terminals   # 偽PTYの固定試験と、/bin/sh を実PTYで動かす試験
bun test api/application/terminals-adapter.test.ts api/application/claude-code-toolchain.test.ts
bunx playwright test tests/browser/claude-code.spec.ts   # 会話 → 画面が開き、セッションが表示される
bun run toolchain:bundle -- check api/domains/capabilities/bundles/terminals-screen.bundle.json
```
