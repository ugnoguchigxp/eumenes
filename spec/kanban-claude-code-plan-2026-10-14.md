# Kanban から Claude Code でタスクを実行する 計画（2026-10-14、改訂4）

## 共通 Kanban への拡張に関する追補（2026-10-14）

利用者の追加指定により、Kanban UI は Claude Code と Codex で共有し、カードごとに実行担当を選ぶ。キューは担当別の二本に変更する。拡張の正本は [共通 Kanban と Codex SDK ツールチェーン計画・改訂2](codex-sdk-task-artifact-plan-2026-10-14.md)。本書の PTY・フック・Claude の会話継続の契約は Claude Code 実行部として引き継ぎ、下記の共通部分はリンク先を優先する。

| 本書の改訂4における前提 | 拡張後の扱い |
| --- | --- |
| ボード全体で単一キュー、全カードが Claude Code | 共通ボード内に `claude-code` と `codex` の独立キュー。各一件ずつ、別 workspace なら並行実行。同じ workspace は排他 |
| カード/run の Claude session、単一 `queue` | run に executorId/workspaceRef/sessionRef を固定し、board は `queues[]` を返す。既存カード・履歴は Claude Code に移行 |
| ボード上の「Claude Code を開く」、Claude 向け固定操作 | 対応機能に応じた操作。Claude は Terminal、Codex はイベント表示。追加依頼/git は元 run の担当へ戻す |
| Kanban 担当と実行機構 | カード・run・通知は共有。実行用サブエージェント・指示・会話・SDK/PTY は担当別に維持 |
| 全体のキュー停止・再開 | executorId と queue revision で対象を限定。一方の停止が他方の別 workspace 実行を止めない |

将来の Grok は専用担当と実行 port の登録で追加し、今回の実装には含めない。以下は改訂4の Claude Code 実行部と当時の検証・分担の基準を残すものであり、「ボード全体一本」を今後の共通設計として実装する指示ではない。進行中の固定契約・実装分担は本追補で直接書き換えず、拡張着手時に新しい revision と移行を確定する。

状態: P1〜P3 実装済み・固定試験済み（2026-10-15）。P4（実 `claude` での通し・実 LARM の自然言語受入）は未実施。改訂2で Astra のレビュー7件、改訂3で利用者の決定（§0.2）、改訂4で Astra の再レビュー4件（§0.1 後半）を反映した。実装の分担と記録は [分担書](kanban-implementation-assignments-2026-10-14.md)、独立レビュー（10件）は同じ回で全件修正済み。

## 0. 前提の整理

### 0.1 レビュー（Astra）への対応

初回レビュー（7件）:

| # | 指摘 | 対応（本書の節） |
| --- | --- | --- |
| 1 | DB の rollback 後に端末への送信だけが残る | 依頼を **作業依頼表（`terminal_requests`）に先に保存して commit し、commit 後に送る**。送信前に `sending` を確定し、送れたか分からないものは `unknown` として再送しない（§3.3） |
| 2 | 既存の pending は送信待ちではない | terminals に **送信器** を置き、手すきで、手入力の直後でなく、許可待ちでない時だけ送る。Kanban 側は **単一実行キュー** で一件ずつしか渡さない（§3.5、§3.6） |
| 3 | 開始から終了まで共通の実行IDが無い | 実行ごとに **`attemptId`** を発行し、フックは **`prompt_id`** でその attempt に結び付ける（§3.3、§3.7） |
| 4 | ボードからの実行では完了イベントが出ない | **作業の終了（domain の状態遷移）と通知を分離**（§3.7、§3.12） |
| 5 | 追加修正・コミットが別カードの作業へ向かう | **タスクごとの Claude の会話（`claude_session_id`）** を明示して送る。PTY が無ければ `--resume` で復元（§3.4、§3.8） |
| 6 | 楽観排他と並べ替えの入力が揃っていない | 変更系の全操作に `expectedRevision`、本文の固定、`beforeCardId`（§3.8） |
| 7 | フックが届かない・中断時の出口が無い | 起動前・起動直後の確認、止めてから Blocker、停止未確認ならキュー停止（§3.6、§3.11） |

再レビュー（4件）:

| # | 指摘 | 対応（本書の節） |
| --- | --- | --- |
| R1 | 「Blocker にする」が単一実行を破る（A が動いたまま B が始まる） | 操作を **「止めて Blocker にする」** に変更。プロセスの終了を確認してからキューを進め、10秒で確認できなければキューを `paused`。あわせて **「作業中・許可待ちの Kanban セッションがある間はキューを進めない」** をキューの不変条件にする（§3.6、§3.8） |
| R2 | expectedState だけでは、次の attempt 開始後に届く旧 Stop を区別できない | フックの **`prompt_id`（同じ依頼の `UserPromptSubmit` と `Stop` が同じ値を持つことを実機で確認）** で依頼に固定し、`session_id`（起動時に `--session-id` で指定）も照合する。受信時の「現在の依頼」には結び付けない（§3.7） |
| R3 | 専用セッションを増やし続けると上限4で止まる・再起動後に追加修正できない | **Claude の会話（ディスクに残る、ID をカードに保存）と Eumenes の PTY（使い捨て）を分ける**。上限は生きているプロセスだけで数え、空いていない時は使われていない Kanban の PTY を閉じる。追加修正・commit & push は PTY が無ければ `claude --resume <id> "<本文>"` で復元（実機で文脈が戻ることを確認）（§3.4） |
| R4 | 本文や追加依頼に「commit・push まで」とあれば、ボタン以外から通る | **二重の制限**: 通常の作業（task・followup）は `git commit`・`git push` を禁止した設定で起動し（`permissions.deny`）、本文に「commit・push はしない」共通指示を付ける。commit & push は **ボタン由来の UI 操作だけ** をホストが受け付け、禁止を外した設定で `--resume` して起動し直す（§3.9） |

既存の会話からの直接依頼（`claude-code.request`）も初回指摘1・2と同じ問題（transaction 内で PTY に送信）を持つため、**同じ作業依頼表と送信器へ載せ替える**（§3.5）。直接依頼は利用者がその場で明示した作業なので、R4 の git 制限は掛けない。

### 0.2 利用者の決定（2026-10-14）

| 項目 | 決定 |
| --- | --- |
| 列 | **3列: 未着手 / 実行中 / Done・Blocker**。3列目のカードに「Done」か「Blocker」のラベルを付けて見分ける |
| 実行 | **単一実行キュー**だけが実行する。一度に動くのは一件。**タスクごとに新しいセッション** |
| 作業ディレクトリ | 当面 eumenes。将来のマルチプロジェクトに備え、プロジェクトを通して変えられる作りにする |
| commit & push | Claude Code が commit と push を行う。**勝手にはやらせない**。Done のカードは人が確認し、Kanban の「commit & push」ボタンを押したときだけ依頼する。会話からは依頼しない（ボタンへ案内する） |
| 通知 | カードの移動は通知しない。Kanban のアクティビティ（Done・Blocker・許可待ち・commit & push の結果）は **通知センター** に出す。会話から実行したタスクも会話では報告しない |
| 状態を追えない場合 | **起動直後に確認し、届かなければ Blocker**（理由「状態を追えません」）。セッションを閉じ、キューを止める |
| 送らない条件 | 許可待ちの間、手入力の直後3秒、そのセッションで別の依頼が送信中・作業中の間は送らない（すべて採用） |

## 1. 目的と完了条件

アーティファクト「タスクボード」（Kanban）でタスクを登録・整理し、単一実行キューで一件ずつ Claude Code に実行させ、人が結果を確認してから commit & push を依頼する。会話からもボードを操作できる。

完了条件（実装済みと言える条件）:

1. ボードでタスクを追加・編集・削除・並べ替え・列移動でき、再読込み・backend 再起動後も残る。
2. 「実行」したカードは実行キューに入り、一度に一件だけ、タスクごとの新しいセッションで動く。依頼は **一度だけ** Claude Code に届き、DB の rollback・連打・再送・backend の停止と再起動で二重に送られない。
3. キュー待ち・送信待ち・作業中・許可待ち・Done・Blocker が、カードと Claude Code 画面の両方で区別できる。
4. 作業が終わるとカードが「Done」になり、その実行の最後の報告と変更したファイルが載る。別の実行（旧実行・他カード・手入力）の終了でカードが進まない。止まった・追えない・失敗した実行は「Blocker」になり、理由が分かる。
5. Done のカードは人が確認し、「commit & push」を押したときだけ依頼が飛ぶ。依頼は同じタスクのセッションへ、変更したファイルの一覧付きで届く。
6. Done・Blocker・許可待ち・commit & push の結果が通知センターに出て、SE が鳴る。カードの移動では通知しない。
7. 会話から「〜をタスクに登録して」「〜のタスクを実行して」「ボードの状況は？」が通る。会話で commit & push を頼まれたら、ボタンへ案内する。
8. 固定試験（domain・adapter・会話結合・ブラウザ E2E）、実機（実 `claude`）、自然言語受入（実 LARM）の結果を分けて記録し、§5 の試験表をすべて満たす。

## 2. 用語と状態

### 2.1 カード（kanban domain）

| 列 | ラベル | 意味 | 主な操作 |
| --- | --- | --- | --- |
| 未着手 `todo` | — | 登録しただけ | 編集・削除・並べ替え・実行 |
| 実行中 `running` | キュー待ち・送信待ち・作業中・許可待ち・停止中 | 現在の run が終わっていない | キュー待ちなら取消、送信後は「止めて Blocker にする」・Claude Code を開く |
| Done・Blocker `finished` | **Done** | 現在の run が完了した（`Stop`）。人の確認待ち | 確認済みにする・追加で直す・commit & push・未着手へ戻す・削除 |
| 〃 | **Blocker** | 現在の run が止まった・追えない・失敗した。理由を文で表示 | 編集・やり直す（実行キューへ）・未着手へ戻す・削除 |

- Done のカードには「確認済み」の印（人が内容を見た）と、「commit & push 依頼済み」「commit & push の報告あり」の印を付けられる。commit & push のボタンは確認済みでなくても押せるが、押す前に「変更したファイル」と報告を表示する（人が見てから押す前提）。
- Blocker の理由: 途中で止まった（Esc 等）、作業担当が終了した、実行状況を確認できない（送信中の停止・再起動）、状態を追えない（フックが届かない）、送る前に取り消した、送信に失敗した、人が止めた、前の会話を再開できない（`--resume` の失敗）。

### 2.2 Claude の会話・PTY・実行・作業依頼

| 単位 | 所有 | 寿命 | 識別 |
| --- | --- | --- | --- |
| **Claude の会話** | Claude Code（ディスクの transcript） | カードと同じ。backend 再起動でも残る | `claude_session_id`（UUID。Eumenes が決めて `--session-id` で起動し、カードに保存。「やり直す」で新しく作る） |
| **PTY セッション** | terminals（メモリ） | 使い捨て。閉じても会話は残る | `terminal_session_id`。`owner`（`kanban:<cardId>` か `direct`）、`mode`（`work`・`commit`）、`claude_session_id` を持つ |
| **run** | kanban（`kanban_runs`） | 実行一回 | `run.id`（= attemptId）。種類 `task`（最初の実行・やり直し）・`followup`・`commit_push`、実行時点の title・prompt・revision、`claude_session_id` |
| **request** | terminals（`terminal_requests`） | 依頼一件 | `id` = attemptId。`prompt_id`（`UserPromptSubmit` で記録） |

| request の状態 | 意味 | 次 |
| --- | --- | --- |
| `queued` | 保存済み・未送信 | `sending`・`cancelled` |
| `sending` | 送信器が PTY へ書く直前に確定。このまま backend が止まると送れたか分からない | `delivered`・`unknown`・`cancelled` |
| `delivered` | PTY へ書いた（初期プロンプトで起動・`--resume` で起動、または貼り付けて Enter） | `started`・`ended`・`unknown` |
| `started` | Claude Code がこの依頼の作業を始めた（`UserPromptSubmit`、`prompt_id` を記録） | `completed`・`interrupted`・`ended`・`unknown` |
| `completed` | この依頼の作業が終わった（同じ `prompt_id` の `Stop`）。最後の報告と変更ファイルを保存 | 終端 |
| `interrupted` | 同じ `prompt_id` の Stop の無いまま、別の `prompt_id` の作業が始まった | 終端 |
| `ended` | 送信後に Claude Code の実行が終了した（人が止めた以外） | 終端 |
| `unknown` | 送れたか・終わったかを確定できない（送信中の停止、再起動、追跡不能、人が止めた） | 終端 |
| `cancelled` | 送る前に取り消した・送信に失敗した・送り先が無くなった | 終端 |

- 遷移は `expectedState` 付きの更新で、条件に合わなければ何もしない。終端からは戻らない。
- run の結果 = request の終端。`completed` → カードは Done、それ以外 → Blocker（`reason` を写す）。

## 3. 構成と契約

```
ボード操作 / 会話の kanban 操作 ──▶ kanban adapter ──┐
                                                      ▼  単一 writer transaction
                              kanban: run を作る（キュー末尾）、カードを running に
                              キューの先頭が空いていれば: terminals.enqueueInTransaction(run)
                                                      │ commit
                                                      ▼ store.onCommit / フック / 定期の見直し
                              terminals 送信器: queued → sending（commit）→ PTY → delivered（commit）
                                                      │
              Claude Code のフック（SessionStart / UserPromptSubmit / PostToolUse / Notification / Stop）
                                                      ▼  単一 writer transaction
              terminals: started / 変更ファイルの記録 / completed・interrupted …
              ＋ transaction 内の購読者: kanban.finishRunInTransaction(attemptId, …)
                    → カードを Done/Blocker、Kanban 通知を保存、キューの次の run を enqueue
                                                      │ commit
                                                      ▼
                              変更通知（ボード・通知センターの読み直し、SE）
```

### 3.1 domain の分担と依存

- `terminals`（下位）: PTY セッション、作業依頼表、送信器、フックの受付、セッションの持ち主（`owner`）。`owner_ref` は不透明な値として保存するだけで kanban を参照しない。SQLite を持つ（migration `terminals/0001-requests`）。
- `kanban`（上位）: カード・列・順序・revision、run と単一実行キュー、送る本文の組み立て、run の採用、Kanban 通知。terminals を import しない。
- application: adapter（`kanban-adapter`・既存の `terminals-adapter`）、terminals の transaction 内購読への kanban 公開操作の登録、プロジェクトの解決、通知センターの合成。複数 domain の保存は単一 writer の transaction で行う。
- `scripts/domains.ts`: `kanban` を追加（api 依存なし）。`terminals` は依存なしのまま。

### 3.2 プロジェクト（作業ディレクトリ）

- 将来のマルチプロジェクトに備え、作業ディレクトリは **プロジェクト** を通して決める。プロジェクトは id・表示名・作業ディレクトリを持つ登録（当面は host が起動時に作る `eumenes` 一件 = backend の作業ディレクトリ）。
- カードは `project_id` を持つ（当面は常に `eumenes`）。run と request は送信時点の `project_id` を保存し、terminals はセッションを起動するときに application から渡された作業ディレクトリを使う。**作業ディレクトリのパスを入力（画面・会話）から受け取らない**。登録済みプロジェクトの id だけを受け付ける。
- マルチプロジェクト対応（別計画）では、プロジェクトの登録 API・設定画面・許可するパスの範囲・カードごとのプロジェクト選択・同時実行の可否を決める。本計画では id を通す配線と、一件だけの登録に留める。

### 3.3 実行IDと保存（指摘1・3）

- **受付**: kanban の「実行」等は writer transaction の中で run（`queued_in_board`）をキュー末尾に作り、カードを `running`・`current_run_id = run.id` にする。§3.6 の不変条件 (a) を満たせば、同じ transaction で先頭の run を terminals に渡す（`terminals.enqueueInTransaction(tx, { attemptId: run.id, target, claudeSessionId, mode, projectId, prompt, task, owner: "kanban:<cardId>" })`）。PTY には何も書かない。
- **attemptId**: run の id。UI・会話の操作の requestId（受付台帳）から決定的に作るので、同じ操作の再送は同じ run を `replay` で返す。
- **rollback**: transaction が rollback すれば run も request もカードの変更も残らない。送信は commit 後にしか起きない。
- **送信の確定**: 送信器は送る直前に `queued → sending` を `expectedState` 付きで commit し、成功したものだけ PTY へ書き、書き終えたら `sending → delivered`（`run` 番号を記録）を commit する。`sending` の commit 後・PTY 書込み前に backend が止まれば、再起動時に `unknown`（再送しない）。PTY 書込みが例外なら `cancelled（send_failed）`。
- **既存 Queue を使わない理由**: 送信先は同じプロセス内の PTY で、Queue の再試行・lease は「無条件に再送しない」契約と合わない。作業依頼表を永続 outbox とし、送信器は commit 通知で起こす。会話の操作経路は adapter の `afterCommit` を呼ばない（`createRegistryActions`）ため、起点は `store.onCommit` にする。

### 3.4 Claude の会話と PTY セッション（R3・初回5）

- **会話の ID**: カードの最初の実行で `claude_session_id` を新しく作り、`claude --session-id <id>` で起動する。「追加で直す」「commit & push」は同じ ID を使う。「やり直す」は新しい ID（文脈を持ち越さない）。ID はカードと run に保存する。
- **PTY の持ち主と状態**: PTY セッションは `owner`（`kanban:<cardId>`・`direct`）、`mode`（`work`・`commit`。§3.9）、`claude_session_id`、activity（`idle`・`working`・`waiting`）を持つ。
- **上限**: 上限（既定4）は **生きているプロセスの数** で数える。終了した PTY は一覧に「終了」として最大8件残し（出力の確認用）、古いものから一覧から消す。終了した PTY は上限に数えない。
- **枠が足りない時**: 新しい PTY が要るのに上限に達していたら、`owner = kanban:*` で activity が `idle`、request が動いていない PTY のうち、最後に使った時刻が最も古いものを閉じる（会話はディスクに残るので失わない）。閉じられる PTY が無ければ（すべて作業中・許可待ち、または `direct`）、その request は `queued` のまま待つ。`direct` の PTY は自動で閉じない。
- **送り先の解決**（送信時に行う）:
  - `target: new`（task）: 新しい PTY を `claude --session-id <新しい ID> --settings <file> "<本文>"` で起動する。
  - `target: conversation`（followup・commit_push）: そのカードの `claude_session_id` を持つ生きている PTY があり、mode が合い（§3.9）、idle なら貼り付ける。無ければ（閉じた・終了した・backend 再起動・mode が違う）新しい PTY を `claude --resume <id> --settings <file> "<本文>"` で起動する（実機で、`--resume` に渡した本文が復元した会話の続きとして処理されることを確認済み）。mode が違う生きた PTY は idle を待ってから閉じる。
  - `--resume` で `SessionStart`（`source: "resume"`）が届かずに終了した場合は `ended（resume_failed）`、カードは Blocker（理由「前の会話を再開できません。やり直してください」）。
  - 直接依頼（`claude_code`）: `target: current` = 最新の生きている `direct` の PTY、無ければ新しい `direct` の PTY。Kanban の PTY には入らない。

### 3.5 送信器（初回2）

- 送信器は PTY ごとに、次をすべて満たすときだけ最古の `queued` を一件送る（新しい PTY を起動して送る場合は 1・2・4 を満たしたことにする）:
  1. その PTY の実行で `SessionStart` を受けている（フックで追跡できる）。
  2. activity が `idle`（`working`・`waiting` の間は送らない。許可の確認画面への誤入力を防ぐ）。
  3. その PTY に `sending`・`delivered`・`started` の依頼が無い（一 PTY 一依頼）。
  4. 画面からの手入力（`POST /api/terminals/:id/input`）から3秒以上経っている。
- 送り方: 起動して送る場合は初期プロンプト（`--session-id` または `--resume` 付き）。生きている idle の PTY へは bracketed paste → 150ms 後に Enter（同じ実行にだけ）。
- 起こす契機: `store.onCommit`、フック受信、手入力の待機明け、PTY の起動・終了、5秒ごとの見直し（`queued` が無ければ何もしない）。会話の操作経路は adapter の `afterCommit` を呼ばない（`createRegistryActions`）ため、`store.onCommit` を起点にする。
- 既存の直接依頼の載せ替え: `claude-code.request` も `enqueueInTransaction` で受け付ける（`owner: direct`、git 制限なし）。adapter のメモリ上の受領票、transaction 内での PTY 書込み、メモリの task tracker による照合は削除する。回答の projection は `{delivered: "queued", task, completed: false, reportedWhenDone: true}`。挙動の変更: 作業中の PTY へはすぐ貼り付けず、作業が終わってから送る。

### 3.6 単一実行キュー（kanban domain、R1）

- キューはボード全体で一本。run の順番は「実行」等を押した順。
- **不変条件**: 次の run を terminals に渡せるのは、(a) 渡し済みで終端になっていない run が無く、かつ (b) `owner = kanban:*` の生きている PTY がすべて `idle`（`working`・`waiting` が無い）のときだけ。(b) により、人が Kanban の PTY に直接打った作業が動いている間も次は始まらない。
- 先頭の run が終端（Done・Blocker）になった同じ transaction で (a) を満たし、(b) は送信器が PTY の activity で確認してから送る（(b) を満たすまで request は `queued`）。
- **キューの停止**: 「状態を追えない」で Blocker になったとき、「止めて Blocker にする」で終了を確認できなかったとき、backend 再起動の回復時は、キューを `paused`（理由付き）にして次を渡さない。ボードに「実行キューは停止中: {理由}」と「再開」ボタンを出す。再開は人が押す。再開時も (b) を確認する。
- キュー待ちの run の取消: run を `cancelled`、カードを Blocker（理由「送る前に取り消しました」）。渡した後（request が `queued` の間）は terminals の取消を同じ transaction で行う。`sending` 以降は取り消せない（「送信済み」。止めるには「止めて Blocker にする」）。
- 同時実行は将来（マルチプロジェクト）の判断。キューの行に `project_id` を持たせ、「プロジェクトごとに一本」へ広げられるようにする。

### 3.7 フックと終端（R2・初回3・4・7）

- フックは実行ごとの token で認証する（0600 の設定ファイルで渡し、本文を読む前に照合）。受けるイベント: `SessionStart`・`UserPromptSubmit`・`PostToolUse`・`Notification`・`Stop`。payload の `session_id` がその PTY の `claude_session_id` と違うものは捨てる。
- **依頼への結び付けは `prompt_id` で行う**（受信時の「現在の依頼」には結び付けない）:
  - `UserPromptSubmit`: その PTY の `delivered` の request があり、`prompt` が送った本文と一致すれば（空白の連続・前後の空白・`-` 始まりの依頼に足した先頭の空白を無視）、その request を `started` にして `prompt_id` を記録する。一致しなければ手入力の turn として、その `prompt_id` を「手入力の turn」として PTY に記録する（request は `delivered` のまま）。その PTY に `started` の request（別の `prompt_id`）が残っていれば、それを `interrupted` にする。
  - `Stop`: payload の `prompt_id` と一致する `started` の request だけを `completed` にし、`last_assistant_message`（4000字まで）を保存する。一致する request が無い Stop（手入力の turn、旧い turn の遅延・重複）は request を変えない。どの Stop でも activity は `idle` にし、送信器を起こす。
  - `PostToolUse`: `prompt_id` が一致する `started` の request について、`tool_name` が `Edit`・`Write`・`MultiEdit`・`NotebookEdit` の `tool_input.file_path` を作業ディレクトリからの相対パスで記録する（重複は一つに、200件まで、作業ディレクトリ外は記録しない）。`waiting` から `working` に戻す。
  - `Notification`（`permission_prompt`・`elicitation_dialog`）: activity を `waiting`。`prompt_id` が一致する Kanban の request があれば Kanban 通知「許可待ち」を一度だけ保存する。`idle_prompt` は無視。
  - `PostToolUse`・`Notification` に `prompt_id` が入っているかは実機で未確認（`UserPromptSubmit`・`Stop` は確認済み）。入っていない場合、変更ファイルと許可待ちは「その PTY の `started` の request」に結び付ける（どちらも状態遷移ではないので、取り違えても完了判定は誤らない）。P2a の最初に実機で確認する。
  - `UserPromptSubmit`・`Stop` に `prompt_id` が無い Claude Code では追跡できないものとして扱う（§3.11 の起動直後の確認で、`SessionStart` の後の最初の `UserPromptSubmit` に `prompt_id` が無ければ `tracking_lost`）。
- 実行の終了（プロセス終了）: その PTY の `delivered`・`started` は `ended`（人が止めた場合は `unknown（stopped_by_person）`）、`queued` は送り先の解決（§3.4）をやり直す（会話は残っているので `--resume` で送れる）。自動で同じ依頼を送り直すことはしない（`delivered` 以降は終端）。
- 終端の書込みは一つの writer transaction で、terminals の更新と **transaction 内の購読者**（kanban の `finishRunInTransaction(attemptId, outcome, report, files)`）を一緒に行う。kanban は `current_run_id` が一致するときだけカードに反映し、Kanban 通知を保存し、キューを進める。
- 再起動前の実行のフックは token で拒否する。同じ実行の中の旧い turn は `prompt_id` で区別する。
- 保存の失敗: 終端の書込みが失敗したら（writer キュー満杯など）フックの応答は 503 にし、メモリ上の「未保存の終端」に残して次のフック・定期の見直しで一度だけ再試行する。再試行も失敗したら request は `started` のまま、カードは実行中で「止めて Blocker にする」を出す。ログは `terminals.finish_save_failed`（attemptId のみ）。

### 3.8 カードの操作と本文（初回5・6、R1）

すべての変更操作は `expectedRevision` を取り、一致しなければ `revision_conflict`（画面は読み直す。自動で再送しない）。

| 操作 | 入力 | 許される状態 | 動き |
| --- | --- | --- | --- |
| 追加 | title、prompt、beforeCardId?（未着手の中の位置） | — | 未着手に挿入。`project_id` は既定のプロジェクト |
| 編集 | cardId、expectedRevision、title?、prompt? | 未着手・Done・Blocker | revision を上げる |
| 移動・並べ替え | cardId、expectedRevision、column（`todo`・`finished`）、beforeCardId（`null` で末尾） | 実行中以外 | 通知しない。`finished` へ手で移すと Done（人が完了と判断）。実行中への移動は「実行」だけ |
| 削除 | cardId、expectedRevision | 実行中以外 | 物理削除（run と request は保存期間まで残る。Claude の会話は消さない） |
| 実行・やり直す | cardId、expectedRevision | 未着手・Blocker・Done | その revision の title・prompt を run に固定。`kind: task`、新しい `claude_session_id`、`target: new` |
| 追加で直す | cardId、expectedRevision、note（4000字以内） | Done・Blocker（会話がある） | `kind: followup`、同じ `claude_session_id`、`target: conversation` |
| commit & push | cardId、expectedRevision | Done（ボードのボタンからだけ。§3.9） | `kind: commit_push`、同じ `claude_session_id`、`target: conversation`、`mode: commit` |
| 確認済みにする | cardId、expectedRevision | Done | 印を付ける（列は変えない） |
| 取消 | cardId、expectedRevision | 実行中（キュー待ち・送信待ち） | §3.6 |
| 止めて Blocker にする | cardId、expectedRevision | 実行中（送信後） | その PTY に SIGTERM（5秒で終わらなければ SIGKILL）を送り、**プロセスの終了を確認してから** request を `unknown（stopped_by_person）`、カードを Blocker にしてキューを進める。10秒以内に終了を確認できなければ、カードは実行中のまま「停止を確認できません」と表示し、キューを `paused（stop_unconfirmed）` にする。会話はディスクに残るので、後で「追加で直す」で続けられる |
| 未着手へ戻す | cardId、expectedRevision | Done・Blocker | 未着手の末尾へ。run の履歴は残る |

本文の組み立て（kanban domain。データ部分は JSON 文字列で引用し、指示と混ざらない形にする）:

- `task`: カードの prompt + 共通の作業指示（§3.9）。
- `followup`: 「タスク『{title}』の続きです。追加の依頼: {note}」+ 共通の作業指示。前回の文脈は `--resume` した会話にあるので、元の依頼・前回の報告は会話を再開できない時のために要約だけ添える（「元の依頼: {prompt の JSON}。前回の報告: {last_report の JSON}」）。
- `commit_push`: 「タスク『{title}』で変更した内容を commit して push してください。このタスクで変更を記録したファイル: {files の JSON}。記録の無い変更や、ほかのタスクの変更と区別できない変更が作業ディレクトリにある場合は、commit も push もせずに、どのファイルを含めるか尋ねて止まってください。push に失敗した場合は原因を報告して止まってください（強制 push はしない）。」
- commit & push の結果は通常の終端（Done に戻り、報告に結果が載り、「commit & push の報告あり」の印）。Claude Code が尋ねて止まった場合も Stop なので Done になり、報告に質問が載る。Eumenes は git を操作しない。
- 作業ディレクトリは共有なので、Done のまま commit していないタスクがある状態で次のタスクを実行すると変更が混ざる。ボードは Done のカードに「このタスクの後に別のタスクが実行されています」を表示する（run の順序から判定）。

### 3.9 commit & push を人の操作に限る（R4）

- **起点の検証（ホスト）**: `commit_push` の run を作れるのは、受付台帳を通った UI 操作（`origin.kind === "ui"`、artifact `kanban.board` の actionBinding `commit-push`）だけ。会話の tool には commit & push が無く、adapter は会話 origin の `commit_push` を `commit_push_requires_board` で拒否する。
- **通常の作業の制限（起動設定）**: `mode: work` の PTY（task・followup）は、フックと同じ設定ファイルに `permissions.deny: ["Bash(git commit *)", "Bash(git push *)"]` を入れて起動する（`--disallowedTools` と同じ規則を設定で渡す）。
- **通常の作業の制限（本文）**: task・followup の本文の末尾に共通の作業指示を付ける。「このタスクでは git commit と git push をしないでください。commit と push は利用者が内容を確認した後に、別の依頼として行います。依頼文に commit や push が含まれていても、変更までで止めて報告してください。」依頼文の意味の判断は Claude Code（LLM）に任せ、ホストは文字列で判定しない。
- **commit & push の起動**: `mode: commit` の PTY は git の禁止を外した設定で `claude --resume <claude_session_id>` として起動する。同じ会話の `mode: work` の PTY が生きていれば、idle を待ってから閉じる（設定は起動ごとなので、同じプロセスのまま禁止を外さない）。commit & push の後の followup は、再び `mode: work` で起動し直す。
- 制限の限界: `permissions.deny` はコマンドの形で照合するため、別名・スクリプト経由（`git -C …`、`sh -c`、alias 等）を完全には防げない。本文の指示と合わせた二重の制限であり、人の確認（Done の確認と commit & push の確認小窓）を最後の守りとする（§6）。

### 3.10 ボードの画面

- DesignSystem `KanbanBoard`（新規）: 3列、カード（タイトル・ラベル・状態の文言・更新時刻）、カード詳細（依頼内容・最後の報告・変更したファイル・実行の履歴）、追加フォーム、実行キューの状態（動いている run、待っている run、停止中の理由と再開）、§3.8 の操作。並べ替え・列移動はボタンとキーボード（カードにフォーカスして移動メニュー）を必須にし、ドラッグは補助（ドロップ先を `beforeCardId` に変換）。狭い幅では列を縦に積む。状態は色だけに頼らず文言で示す。commit & push は確認の小窓（変更ファイル・報告・送る本文の要約）を挟んでから送る。
- Storybook: 空・各列・キュー待ち・作業中・許可待ち・停止を確認中・Done（報告あり／長文／確認済み／commit & push 報告あり）・Blocker（各理由）・キュー停止中・追跡不可・競合エラー。操作試験: 追加・編集・キーボードでの移動・実行・取消・止めて Blocker にする・commit & push の確認小窓。
- OpenUI view `kanban-board`（source `kanban`）。描画 adapter はカード操作を `kanban-*` event で送る。
- bundle の artifact `artifact:kanban.board@1`（launcher「タスクボード」）: sourceBindings `kanban` → `adapter:kanban@1` の `query:kanban.board@1`（カード一覧 + 各カードの現在の run と request の状態 + キューの状態 + 各タスク用セッションの activity を一つの読取り transaction で合成）。actionBindings はすべて `effect: write`（受付台帳経由）で、「Claude Code を開く」だけ `effect: navigate`（`terminals.workspace`。そのカードのセッションを前面に出す）。
- Web adapter（`web/src/domains/kanban/`）: query root `kanban` を変更通知で読み直す。書込みは共通 host の outbox。`revision_conflict` は読み直して知らせる。
- Claude Code 画面（`terminals.workspace`）: 複数のタスク用セッションが並ぶので、各ペインに持ち主（タスク名）を小さく表示する（DesignSystem の `TerminalPane` に任意の見出しを足す。現行の枠なし表示は保つ）。

### 3.11 追跡の確認と出口（初回7、R1・R3）

- 起動前の確認: フックの宛先が無効（loopback の URL とポートが無い）か `curl` が見つからない場合、Kanban の実行・会話の直接依頼を `terminal_tracking_unavailable` で受け付けない。ボードは実行ボタンを無効にし「この環境では作業の状態を追えないため実行できません」を表示する。
- 起動直後の確認: PTY を起動してから **10秒以内に `SessionStart` が届かなければ**、その request を `unknown（tracking_lost）`、カードを Blocker（理由「状態を追えません。フックが届いていません（管理設定・プロキシ・curl を確認してください）」）にし、PTY を閉じ（終了を確認する）、キューを `paused` にする。`SessionStart` の後の最初の `UserPromptSubmit` に `prompt_id` が無い場合も同じ扱い。Kanban 通知 `blocker` と `queue_paused` を保存する。
- 実行中のまま動かないカードには必ず操作を出す: キュー待ち・送信待ち → 取消、送信後 → 「止めて Blocker にする」・Claude Code を開く。
- backend 再起動（terminals・kanban の recover、同じ transaction）: `queued` → `cancelled（restarted）`、`sending`・`delivered`・`started` → `unknown（restarted）`。カードは Blocker、キューは `paused（restarted）`。PTY はすべて無くなるが、Claude の会話は残るので、Done・Blocker のカードの「追加で直す」「commit & push」は `--resume` で続けられる。自動で再送しない。
- 安全な再開: キューの再開・「追加で直す」・「やり直す」は、§3.6 の不変条件（Kanban の PTY に作業中・許可待ちが無い）を満たすまで送らない。「止めて Blocker にする」で終了を確認できなかった PTY が残っている間は、そのカードの「追加で直す」「commit & push」を受け付けない（同じ会話を二つのプロセスで開かない）。
- 会話の直接依頼の追跡不能（`SessionStart` が届かない）も同じ確認で `unknown（tracking_lost）` にし、会話へ「状態を追えないため止めました」と通知する（既存の notice 経路）。

### 3.12 通知センターと SE

- 現行の通知センターはタイマー専用（`TimerNotificationCenter`、タイマーの通知だけ）。複数の発信元を並べられるようにする。
  - kanban domain が **Kanban 通知**（`kanban_notices`: id・card_id・run_id・種類・本文・作成日時・既読）を保存し、`GET /api/kanban/notices`・既読化の操作を持つ。
  - Web の通知センターはタイマーの通知と Kanban 通知を一つのドロワーに時刻順で並べる（発信元ごとの見た目と操作。タイマーは鳴動停止、Kanban は「カードを開く」「既読にする」）。未読数をボタンに出す。
- Kanban 通知の種類: `done`（タスク『{title}』が終わりました）、`blocker`（タスク『{title}』が止まりました: {理由}）、`waiting`（タスク『{title}』が許可を待っています）、`commit_push`（タスク『{title}』の commit & push の報告があります）、`queue_paused`（実行キューが止まりました: {理由}）。カードの移動・編集・追加は通知しない。
- SE: Kanban 通知が保存されたとき（Web が新しい通知を受けたとき、読込み時点の既存通知では鳴らさない）にタイマーと同じ短い音を一度鳴らす。Kanban のタスク用セッションでは、現行の activity 遷移の SE（`useClaudeCodeArtifacts`）を鳴らさない（二重に鳴らさない）。`direct` のセッションは現行どおり。
- 会話への報告: Kanban の run は起点（ボード・会話）に関係なく会話へ報告しない。会話からの直接依頼（`claude_code`）の会話報告は現行どおり。

### 3.13 会話（新しいサブエージェントとツールチェーン）

既存の `claude_code`（その場で直接頼む）を流用せず、ボード専用の担当とツールチェーンを新設する。

- **サブエージェント（profile `kanban.manage@1`「タスク管理担当」）**: ボードのカードを登録・整理・実行キューへ入れる担当。会話担当から `kanban({request})` で呼ばれ、登録済みの操作を一つ選ぶか確認質問を返す。作業（コード変更）・commit & push は行わない。完了・成功は domain の結果（列・ラベル・最後の報告）からだけ述べる。
- **SKILL（`skill:kanban.manage@1`）**: 依頼内容は利用者の指示を省略・言い換えしない。タイトルは依頼の言葉から短く（40字以内、通知で使う名前）。対象カードは snapshot の id からだけ選び、一意に決まらなければ確認する。変更系は snapshot の revision を `expectedRevision` に入れる。実行・削除は登録済みカードだけ。commit & push を頼まれたら操作せず、「タスクボードで内容を確認してから commit & push を押してください」と伝える。「修正して push まで」のように登録や実行の依頼に commit・push が含まれる場合は、作業部分だけをタスクとして登録・実行し（本文は利用者の言葉のまま。実行時は §3.9 の制限で commit・push は行われない）、commit・push はボタンで行うと伝える。Done のカードについて聞かれたら最後の報告を要約する。
- **tools（package `kanban.manage@1`、backend `kanban`）**: `kanban.add`（title・prompt）、`kanban.list`、`kanban.edit`（cardId・expectedRevision・title?・prompt?）、`kanban.move`（cardId・expectedRevision・column・beforeCardId?）、`kanban.run`（cardId・expectedRevision）、`kanban.followup`（cardId・expectedRevision・note）、`kanban.cancel`（cardId・expectedRevision）、`kanban.remove`（cardId・expectedRevision）。**commit & push の tool は持たない**。入力 schema は `builtin:` に新しいキーで追加し、モデルへ渡すのは平坦な object。
- **snapshot**: カードの id・タイトル・列・ラベル・revision・run の状態、キューの状態（本文と報告は含めない。報告が要る質問は `kanban.list` の結果で渡す）。
- **binding（`binding:kanban.manage@1`）**: 各 tool → `adapter:kanban@1` の操作、`questions` で対象カード選択（`choiceField: cardId`、候補は `choicesInTransaction` がホストのデータから出す）、`outputSchemaRef: domain:kanban.receipt@1`、`resultProjectionRef: projection:kanban.result@1`、`artifactRevisionId: artifact:kanban.board@1`。
- **toolchain（`toolchain:kanban.manage@1`、関数 `kanban`）**: useWhen「作業をタスクとして登録・整理したい」「登録したタスクを実行キューに入れたい・状況を知りたい」、avoidWhen「その場で Claude Code に直接頼むだけ」。examples は登録・実行・状況確認・追加修正・commit & push の依頼（案内になる）を含む5件。`claude_code` との使い分けは useWhen・examples と LLM の選択に任せ、発話の語句で振り分けるコードは書かない。
- 会話から実行したカードの結果も通知センターだけに出る（会話では報告しない）。回答は「実行キューに入れました。終わったら通知センターでお知らせします」。

## 4. 未決（実装に入る前に必要なら決める）

- なし（§0.2 で確定）。マルチプロジェクト・同時実行・Bash による変更の記録は別計画。

## 5. 試験と受入

### 5.1 固定試験（必須）

| 区分 | 試験 | 期待 |
| --- | --- | --- |
| 受付 | 同じ requestId の再送 | run・request は一件、replay を返す。PTY への書込み一回 |
| 受付 | 受付の transaction が rollback | run・request・カード変更が残らず、PTY への書込み無し |
| 受付 | 起動前の確認で追跡不可 | `terminal_tracking_unavailable`、カードは変わらない |
| キュー | 実行を短時間に3回（別カード） | 一件目だけ terminals へ。二件目は一件目の終端と同じ transaction で渡り、Kanban の PTY がすべて idle になってから送られる |
| キュー | **5件以上の連続実行**（上限4） | 各タスクが別の会話・別の PTY で順に動く。上限に達したら使われていない Kanban の PTY が閉じられ、6件目まで止まらずに進む |
| キュー | 一件目が Blocker | 二件目へ進む（追跡不能・停止未確認・再起動のときは停止） |
| キュー | キュー待ちの取消 / 送信後の取消 | 前者は Blocker（取り消し）、後者は拒否 |
| キュー | 停止中の再開 | 人が再開を押し、Kanban の PTY がすべて idle なら先頭から渡る |
| キュー | **A の作業中に「止めて Blocker にする」** | A のプロセスの終了を確認するまで B は始まらない。終了確認後に A は Blocker、B が送られる |
| キュー | **止めても終了を確認できない**（SIGTERM・SIGKILL を無視する偽プロセス） | 10秒後にキューは `paused（stop_unconfirmed）`、B は送られない、A の追加で直すは受け付けない |
| キュー | **人が Kanban の PTY に直接打った作業が動いている** | その作業の Stop まで次の run は送られない |
| 送信 | 直接依頼と Kanban の PTY | 直接依頼は `direct` の PTY だけに送られ、Kanban の PTY には入らない |
| 送信 | 許可待ち中に追加で直す | `queued` のまま。`PostToolUse`→`Stop` 後に送る |
| 送信 | 手入力の直後に送信条件が揃う | 3秒待ってから送る |
| 送信 | `sending` 確定後に PTY 書込みが例外 | `cancelled（send_failed）`、Blocker、再送しない |
| 送信 | `sending` 確定後に停止 → 再起動 | `unknown（restarted）`、Blocker、キュー停止、再送しない |
| 追跡 | 起動後10秒 `SessionStart` 無し | `unknown（tracking_lost）`、PTY を閉じる、Blocker、キュー停止、通知 |
| 追跡 | `UserPromptSubmit` に `prompt_id` が無い | 同上 |
| 追跡 | payload の `session_id` が PTY の会話 ID と違う | 捨てる |
| 開始・終了 | 送った本文と違う `UserPromptSubmit`（手入力） | `delivered` のまま。その `prompt_id` の Stop で Done にならない |
| 開始・終了 | **同じ会話で A（task）が完了し、B（followup）が始まった後に A の Stop が遅れて・重複して届く** | `prompt_id` が A なので B は `started` のまま。B 自身の Stop でだけ B が完了 |
| 開始・終了 | 再起動前の実行の Stop | token で拒否 |
| 開始・終了 | やり直し中のカードに旧 run の終端 | カードは新 run のまま |
| 開始・終了 | Stop 無しで別の `prompt_id` の作業が始まる（Esc） | `interrupted`、Blocker |
| 開始・終了 | 実行中にプロセス終了 | `ended`。`queued` は送り先を解決し直す |
| 開始・終了 | 終端の保存が一度失敗 | 一度再試行して保存。二度失敗なら実行中のまま「止めて Blocker にする」を出す |
| 会話の復元 | **backend 再起動後に Done のカードへ追加で直す** | `claude --resume <id> --settings <file> "<本文>"` で起動し、Done → 実行中 → Done。報告は再開した会話の続き |
| 会話の復元 | PTY を閉じられた Done のカードへ commit & push | `mode: commit` で `--resume` して起動 |
| 会話の復元 | `--resume` が失敗（会話の記録が無い） | `ended（resume_failed）`、Blocker（「前の会話を再開できません」） |
| 変更ファイル | `Edit`・`Write` の `PostToolUse` | 相対パスで記録、重複なし、作業ディレクトリ外は記録しない、200件まで |
| commit 制限 | **カード本文が「修正して commit・push まで」** | task は `permissions.deny` 付きの `mode: work` で起動し、本文に共通の作業指示が付く（設定ファイルと本文を検査） |
| commit 制限 | **追加で直すの note に「commit して」** | 同上（followup も `mode: work`） |
| commit 制限 | 会話から commit & push の run を作ろうとする | `commit_push_requires_board` で拒否、会話はボタンへ案内 |
| commit 制限 | ボタンからの commit & push | 同じ会話の `mode: work` の PTY が idle になってから閉じ、`mode: commit` で `--resume`。後の followup は再び `mode: work` |
| カード | 古い revision での操作 | `revision_conflict`、何も変わらない |
| カード | 実行後に本文を編集 | 送られるのは実行時の revision の本文 |
| カード | 並べ替え（`beforeCardId`・末尾・列移動） | 順序が保存され、再読込み後も同じ。通知は出ない |
| 通知 | Done・Blocker・許可待ち・commit & push・キュー停止 | Kanban 通知が一件ずつ保存され、通知センターに出る。SE は一度。Kanban の PTY の activity の SE は鳴らない |
| 会話 | 登録・曖昧な対象（候補の確認質問）・実行・状況確認 | 結果は通知センターだけ、会話で完了報告しない |
| 会話 | commit & push を頼む | 操作せずボタンへ案内 |
| 会話 | 直接依頼（`claude_code`）の載せ替え | 既存の会話結合試験が新しい送信器で通る。git 制限は掛からない |
| プロジェクト | 入力にパスを入れる | 受け付けない（登録済みプロジェクト id のみ） |
| 画面 | ブラウザ E2E（偽 `claude`、フックと `prompt_id`・`session_id` を送る fake、`--resume` を模す） | 登録 → 実行 → キュー待ち → 作業中 → Done → 追加で直す → Done → commit & push（確認小窓）→ 報告あり。5件の連続実行、止めて Blocker にする、再読込み・競合表示・取消・通知センター |

### 5.2 実機・受入（記録を分ける）

- 実 `claude`（P2a の最初）: `PostToolUse`・`Notification` の `prompt_id` の有無、`SessionStart` の中身（`source`）、`permissions.deny` で `git commit`・`git push` が実際に止まること（テスト用の一時リポジトリで確認）。
- 実 `claude`（P2b 以降）: タスク5件の連続実行（キューの順番・別の会話・PTY の解放）、許可待ちを挟む1件、追加で直す1件、backend 再起動後の追加で直す1件（`--resume`）、本文に「commit・push まで」を含むタスク1件（commit されないこと）、commit & push 1件（テスト用の枝で、push 先は人が用意）、止めて Blocker にする1件、Esc 中断1件、フック禁止（`disableAllHooks` 相当）での追跡不能1件。
- 実 LARM の自然言語受入: 凍結ケース（登録、曖昧な対象の確認、実行、状況確認、追加修正、commit & push の案内、「修正して push まで」と頼まれた登録、直接依頼との使い分け）を用意して `nl-acceptance` で評価。

## 6. 既知の制約・残る危険

- PTY は backend のメモリにしか無い。backend 再起動で実行中の依頼は `unknown` になり、Claude Code の作業も止まる（会話はディスクに残り、`--resume` で続けられる）。
- Claude の会話の記録は Claude Code が `~/.claude/projects/` に保存する。利用者や Claude Code の設定で消えると `--resume` できない（Blocker「前の会話を再開できません」→ やり直す）。
- git の制限はコマンドの形の照合（`permissions.deny`）と本文の指示の二重で、別名・スクリプト経由の commit・push を完全には防げない。人の確認（Done の確認と commit & push の確認小窓）を最後の守りとする。
- 手入力の待機（3秒）は、入力欄に書きかけの文字が残っている場合の混入を完全には防げない（生きている PTY へ貼り付ける場合）。
- Esc 中断は次の作業が始まるまで分からない（それまでは「止めて Blocker にする」で抜ける）。
- 変更ファイルの記録は `Edit`・`Write`・`MultiEdit`・`NotebookEdit` だけ。`Bash` での変更（生成・移動・削除）は記録されないので、commit & push の指示で「記録の無い変更があれば止まって尋ねる」に頼る（利用者が明示した制約）。
- 作業ディレクトリは共有。Done のまま commit していないタスクがあると次のタスクの変更と混ざる（利用者が明示した制約。表示で知らせ、commit & push の指示で区別を求める）。
- 通知の入力（会話への notice）は会話の履歴に残り、World の抽出対象から外していない（直接依頼の会話報告・予約実行と同じ。[既知の制約](../docs/terminals.md#完了の報告と-se)）。
- 複数利用者の scope は未設計（単一 scope）。

## 7. 作業の段階

| 段階 | 内容 | 完了の確認 |
| --- | --- | --- |
| P1 ボード | kanban domain（カード・列・順序・revision・プロジェクト id・migration）、`query:kanban.board@1`、追加・編集・移動・削除、DesignSystem `KanbanBoard`、OpenUI view、bundle の artifact | domain・adapter 試験、Storybook、ブラウザ E2E（登録・移動・再読込み・競合） |
| P2a 実行の土台 | 最初に §5.2 の実機確認（`prompt_id`・`SessionStart`・`permissions.deny`）。terminals の作業依頼表・送信器・PTY の持ち主と mode・会話 ID（`--session-id`・`--resume`）・上限と解放・`prompt_id` による結び付け・`SessionStart` の追跡確認・変更ファイルの記録・終端保存・transaction 内購読・recover・プロジェクトの解決。既存 `claude-code.request` の載せ替え（旧経路の削除） | §5.1 の受付・送信・追跡・開始終了・会話の復元・変更ファイルの行、既存の会話結合試験・ブラウザ E2E |
| P2b ボードの実行 | run と単一実行キュー（不変条件・停止・再開・取消）、実行・やり直す・追加で直す・commit & push（確認小窓、起点の検証、mode の切替）・確認済み・止めて Blocker にする・未着手へ戻す、Claude Code 画面の持ち主表示 | §5.1 のキュー・commit 制限・カードの行、ブラウザ E2E（偽 `claude`）、実 `claude` での実行 |
| P2c 通知 | Kanban 通知、通知センターの複数発信元化、SE の切替（Kanban の PTY） | §5.1 の通知の行、通知センターのブラウザ E2E（タイマー通知と並ぶこと） |
| P3 会話 | profile・SKILL・tools・package・toolchain `kanban`・binding（確認質問の候補）、commit & push の案内 | `toolchain:bundle check`、会話結合試験、凍結ケース |
| P4 受入 | §5.2 | fixture・live・実機の記録 |

各段階で `bun run verify -- --domain kanban`・`--domain terminals`（と利用側 `capabilities`・`dialogue`・`timers`（通知センター））、対象のブラウザ E2E を個別に実行する。P2a は既存機能の作り直しを含むので、P2b より先に単独で完了させる。
