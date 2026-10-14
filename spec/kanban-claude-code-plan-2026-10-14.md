# Kanban から Claude Code でタスクを実行する 計画（2026-10-14）

状態: 計画（未実装）。前提の Claude Code 画面・会話からの依頼・完了フックは実装済み・固定試験済み（[Claude Code 画面](../docs/terminals.md)、[検証記録](verification/claude-code-toolchain-2026-10-14/README.md)）。実 LARM・実 `claude` での通し確認は未実施。

## 1. 目的と完了条件

アーティファクト「タスクボード」（Kanban）でタスクを登録・整理し、ボードから Claude Code に実行させ、結果を確認して次の行動（コミット・追加修正・完了）へ進める。会話からも同じボードを操作できる。

完了条件:

1. ボードでタスクを追加・編集・削除・並べ替え・列移動でき、再読込みしても残る（SQLite 保存）。
2. カードの「実行」で、そのタスクが Claude Code に渡り、カードが「実行中」になる。Claude Code の画面で進み具合が見える。
3. 作業が終わると（Stop フック）カードが「確認待ち」になり、最後の報告がカードに載る。中断・終了は「中断」として分かる。SE が鳴る。
4. 確認待ちのカードから「完了にする」「追加で直す」「コミットを依頼」「やり直す」を選べる。
5. 会話で「〜をタスクに登録して」「README のタスクを実行して」「ボードの状況は？」が通る。会話から実行したタスクは、終わると会話でもタスク名で報告される（既存の通知経路）。
6. 固定試験（domain・adapter・会話結合・ブラウザ E2E）、実機（実 `claude`）、自然言語受入を分けて記録する。

## 2. 利用の流れ

| 列 | 意味 | カードの操作 |
| --- | --- | --- |
| 未着手 | 登録しただけ | 編集・削除・実行・並べ替え |
| 実行中 | Claude Code に渡した。順番待ち（同じセッションで前の作業が動いている）は「待機中」表示 | Claude Code を開く |
| 確認待ち | 作業が終わった。最後の報告を表示 | 完了にする・追加で直す（追記して再実行）・コミットを依頼・やり直す |
| 完了 | 利用者が完了にした | 未着手へ戻す・削除 |
| 中断 | 途中で止まった・Claude Code が終了した・backend の再起動で追えなくなった | やり直す・未着手へ戻す |

- 「コミットを依頼」は、そのタスクの続きとして「この作業の変更をコミットして」を同じセッションへ渡す（タスクは「実行中」へ戻り、終わると再び「確認待ち」）。
- カードは「タイトル（＝報告で使うタスク名、40字以内）」「依頼内容（Claude Code に渡す本文、8000字以内）」を持つ。会話から登録したときは command 担当が依頼の言葉からタイトルを選ぶ（既存の `task` と同じ規則）。

## 3. 構成

```
タスクボード（OpenUI view kanban-board）──source──▶ adapter:kanban@1 ──▶ kanban domain（SQLite）
        │ write action（受付台帳）                          │ run
        ▼                                                  ▼
  POST /api/toolchain-actions ─────────────▶ application（kanban-adapter）──▶ terminals.request(task, cardRef)
                                                           ▲
   terminals の TaskFinished（Stop / 中断 / 終了）── cardRef ┘ → kanban に結果を記録 → 変更通知（画面・SE）
                                                              └ conversationId があれば会話へ通知（既存）
```

### 3.1 kanban domain（新規 `api/domains/kanban/`）

- 表 `kanban_cards`（migration `kanban/0001-cards`）: `id`、`title`、`prompt`、`column`（`todo|running|review|done|stopped`）、`position`（列内の順序）、`revision`（楽観排他）、`session_id`・`run`・`task_seq`（実行の紐付け、NULL 可）、`last_report`（最後の報告、4000字まで）、`outcome`、`created_at`・`updated_at`。単一 scope（既存の `DEFAULT_TIMER_SCOPE` と同じ扱い。複数利用者は未設計）。
- 公開 transaction 操作: `addInTransaction`・`editInTransaction`・`moveInTransaction`（列・順序）・`removeInTransaction`・`startInTransaction`（running へ、実行参照を記録）・`finishInTransaction`（実行参照が一致するときだけ review/stopped へ）・`listInTransaction`。すべて `expectedRevision` で競合を `revision_conflict` にする。業務判断（どの列からどの操作が許されるか）は domain に置く。
- 操作の受領票（`domain:kanban.receipt@1`）を保存し、replay・再読込みに使う（タイマーと同じ）。
- backend 再起動時の回復: Claude Code のセッションはメモリにしか無いので、`running` のカードは起動時に `stopped`（理由「再起動で追えなくなった」）へ移す。

### 3.2 terminals との連携（application）

- `HandedTask` に任意の `ref?: { owner: "kanban"; id: string }` を足し、`TaskFinished` にそのまま載せる。terminals は ref の中身を解釈しない（下位 domain は上位を参照しない規則のため、kanban を知らない）。
- `kanban-adapter` の `run` 操作が、domain の `startInTransaction` と `terminals.request({ prompt, task: title, ref })` を呼ぶ。会話からの実行なら `conversationId` も渡す（終わると会話で報告）。
- application の購読: `onTaskFinished` で `ref.owner === "kanban"` のものを `finishInTransaction`（completed → review、interrupted/ended → stopped、`last_report` を保存）。commit で変更通知が出て、画面が読み直し、SE が鳴る（既存）。
- PTY への書込みは DB transaction の外の副作用になる。受付台帳の requestId で replay を防ぐ（既存の `claude-code.request` と同じ）。transaction が rollback した場合の取りこぼしは、カードが `running` のまま実行参照が無いので、起動時回復と同じ規則で `stopped` にする。

### 3.3 画面

- DesignSystem `KanbanBoard`（新規）: 列・カード・カード詳細（依頼内容・最後の報告）・追加フォーム。並べ替えと列移動は、ボタンとキーボード（矢印で移動）を必須にし、ドラッグは補助。狭い幅では列を縦に積む。状態は既存トークン、確認待ちと中断は色だけに頼らず文言で示す。Storybook（空・各列・実行中・確認待ち・中断・失敗）と操作試験。
- OpenUI view `kanban-board`（`source` = `kanban`）。描画 adapter はカード操作を `kanban-*` event で送る。
- bundle の artifact（`artifact:kanban.board@1`、launcher「タスクボード」）: sourceBindings `kanban` → `query:kanban.cards@1`。actionBindings は `effect: write`（受付台帳経由、追加・編集・移動・削除・実行・完了・追加で直す・コミット依頼・やり直し）と、「Claude Code を開く」の `effect: navigate`（`terminals.workspace`）。
- Web adapter（`web/src/domains/kanban/`）は query root `kanban` を変更通知で読み直す。書込みは共通 host の outbox に任せる（専用 host は作らない）。

### 3.4 会話（新しいサブエージェントとツールチェーン）

既存の `claude_code`（直接依頼）を流用せず、ボード専用の担当とツールチェーンを新設する。

- **サブエージェント（profile `kanban.manage@1`「タスク管理担当」）**: ボードのカードを登録・整理・実行・確認する担当。会話担当から `kanban({request})` で呼ばれ、登録済みの操作を一つ選ぶか確認質問を返す。作業そのもの（コードの変更）は行わず、実行は Claude Code に渡すだけ。完了・成功は domain の結果（カードの列・最後の報告）からだけ述べる。
- **SKILL（`skill:kanban.manage@1`）**: 依頼内容は利用者の指示を省略・言い換えしない。タイトルは依頼の言葉から短く（40字以内、報告で使う名前）。対象カードは snapshot の id からだけ選び、タイトルが一意に決まらなければ確認する。実行・削除・完了は登録済みカードだけ。確認待ちのカードについて聞かれたら、最後の報告を要約し、次の行動を「完了にする・追加で直す・コミットを依頼・やり直す」から一つ提案する。
- **tools（package `kanban.manage@1`、backend `kanban`）**: `kanban.add`（title・prompt）、`kanban.list`、`kanban.edit`（cardId・title/prompt・expectedRevision）、`kanban.move`（cardId・column・expectedRevision）、`kanban.run`（cardId）、`kanban.followup`（cardId・prompt：追加で直す／コミット依頼）、`kanban.remove`（cardId）。入力 schema は `builtin:` に新しいキーで追加し、モデルへ渡すのは平坦な object。
- **binding（`binding:kanban.manage@1`）**: 各 tool → `adapter:kanban@1` の操作、`questions` で対象カード選択（`choiceField: cardId`、候補は `choicesInTransaction` がホストのデータから出す）、`outputSchemaRef: domain:kanban.receipt@1`、`resultProjectionRef: projection:kanban.result@1`、`artifactRevisionId: artifact:kanban.board@1`（会話の結果でボードが開く）。
- **toolchain（`toolchain:kanban.manage@1`、関数 `kanban`）**: useWhen「作業をタスクとして登録・整理したい」「登録したタスクを実行・確認したい」、avoidWhen「その場で Claude Code に直接頼むだけ」。examples は登録・実行・状況確認・コミット依頼を含む4件以上。`claude_code` との使い分けは useWhen・examples と LLM の選択に任せ、発話の語句で振り分けるコードは書かない。
- **完了の報告**: 会話から実行（`kanban.run`・`kanban.followup`）したカードは、終わると既存の通知経路で会話に報告される（タスク名＝カードのタイトル、次の行動の提案）。ボードから実行したカードは会話に報告せず、カードの列・SE・画面で知らせる（推奨。§5-6）。

## 4. 作業の段階

| 段階 | 内容 | 確認 |
| --- | --- | --- |
| P1 ボード | kanban domain・migration・adapter（source と追加・編集・移動・削除）・DesignSystem `KanbanBoard`・OpenUI view・bundle の artifact | domain 試験、adapter 試験、Storybook、ブラウザ E2E（登録・移動・再読込み） |
| P2 実行 | `run`・terminals 連携（ref・TaskFinished → finish）・確認待ちの操作（完了・追加で直す・コミット依頼・やり直す）・起動時回復・Claude Code を開く | 偽 `claude`（フックを送る fake）でのブラウザ E2E、実 `claude` での実行1件 |
| P3 会話 | 新しいサブエージェント（profile・SKILL）、tools・package・toolchain `kanban`・binding（確認質問の候補を含む）、会話から実行したカードの完了報告 | `toolchain:bundle check`、会話結合試験（固定応答：登録・曖昧な対象の確認質問・実行・完了報告）、自然言語受入の凍結ケース |
| P4 受入 | 実 LARM での会話受入、実 `claude` での登録 → 実行 → 確認 → コミット依頼の通し | 記録を fixture・live・実機に分けて残す |

各段階で `bun run verify -- --domain kanban`（と利用側 `terminals`・`capabilities`）、対象のブラウザ E2E を個別に実行する。

## 5. 決めてほしいこと（推奨）

1. **列の構成**: 「未着手・実行中・確認待ち・完了・中断」の5列（推奨）。中断を確認待ちに含めて4列にもできる。
2. **連続実行**: 推奨は「実行」を押したカードだけを渡す（実行中に別のカードを実行すると、同じセッションで順番待ちになる）。ボードの上から自動で次々実行する「まとめて実行」は P2 の後に追加判断。
3. **セッション**: 推奨は全カード共通で1つの Claude Code セッション（いまの画面と同じ）。カードごとに新しいセッションにすると並行で動くが、同じ作業ディレクトリで競合しやすい。
4. **作業ディレクトリ**: 推奨は backend の作業ディレクトリ（いまと同じ）。カードごとにリポジトリを選べるようにするのは別計画（許可するパスの範囲と安全面の設計が要る）。
5. **コミット**: 推奨は「コミットを依頼」で Claude Code に頼む（Eumenes 自身は git を操作しない）。
6. **ボードから実行したカードの完了報告**: 推奨は会話に報告しない（カードの列・SE・画面で知らせる）。会話にも報告する場合は、ボード操作に会話 ID が無いため、既定の会話（`main`）へ送る規則を足す。

## 6. 既知の制約・未決

- Claude Code のセッションは backend のメモリにしか無い。backend 再起動で実行中のカードは「中断」になる（再開は利用者が「やり直す」）。
- 通知の入力は会話の履歴に残り、World の抽出対象から外していない（予約実行と同じ。[既知の制約](../docs/terminals.md#完了の報告と-se)）。
- 複数利用者の scope は未設計（単一 scope）。
