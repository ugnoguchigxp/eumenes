# TODO完了の通知と即時アーカイブ

2026-10-29。利用者の明示依頼に基づく設計。状態: **合意済み（2026-10-29）・実装済み・fixture検証済み**（実機器の受入は未実施）。

- 依頼1: 完了報告の読み上げは違和感が強い。サブエージェントの完了をきっかけに通知を表示し、TODOを `archived` にする。
- 依頼2: 以後、会話エージェントはTODO（の完了）を拾わなくてよい。
- 依頼3: エラーのTODOを消す方法がない。TODO一覧にアーカイブするボタンを置く（§3.4）。
- 依頼4（同日）: 通知にアーティファクトを開くアイコンを付ける（§3.2）。仕事を頼んだとき、終わったら通知で知らせることを会話エージェントが言えるようにする（§5.2）。完了の報告は引き続き行わない。

置き換える現行の設計: [todo-spoken-report-delivery-design-2026-10-27.md](todo-spoken-report-delivery-design-2026-10-27.md)（音声の `heard: full` でアーカイブ確定）、[context-window-spec-2026-10-24.md](context-window-spec-2026-10-24.md) §9.3・§9.4・§10.1 の `archived` の担当、[agency-conversation-agent-design-2026-10-25.md](agency-conversation-agent-design-2026-10-25.md) §6 の完了報告とアーカイブ。

## 1. 変更の要点

| 項目 | 現行 | 変更後 |
| --- | --- | --- |
| 完了したTODO | `done` のまま残り、報告を待つ | `done` になった取引の中で `archived` にし、未読の通知を作る |
| 利用者への伝え方 | agency の自発発話（読み上げ）。通常の返答で伝えたかを背景の update が照合 | Web の通知センター（バナー・一覧・未読数）と短い通知音。読み上げない |
| アーカイブの確定 | 音声再生が最後まで終わった通知（live の played、replay の `POST /api/voice/replay/played`） | 完了と同時。音声とは無関係 |
| agency に渡すTODO | `todo`・`waiting`・`done` | `todo`・`waiting` だけ。`done` は渡さない |
| agency の報告枠 | 雑談の未応答上限と別の「完了報告の機会」（`createReportIdlePlanner`） | 廃止。既存の `createIdlePlanner` 一本 |
| 主会話の「## Host notice」 | `done`・`waiting` になったTODOの結果・質問 | `waiting` の質問だけ |
| 主会話の「## State」の仕事 | `完了 未報告`・`報告済み`（アーカイブ後2時間） | `通知済み`（アーカイブ後2時間、結果の本文なし） |
| TODO画面のタブ | `todo・done`／`報告済み` | `進行中`／`アーカイブ` |

## 2. 変えないもの

- サブエージェントの質問（`waiting`）は従来どおり agency が利用者に尋ね、主会話の「## Host notice」にも載せる。答えは work の `answer` で渡す。通知にはしない（答えは会話で受けるため）。
- 取消（`cancelled`）は従来どおり即時アーカイブ。忘却で消えたTODOも従来どおり。どちらも通知を作らない。
- 実行台帳・TODOの結果（`result_json`・`links_json`）・`work.result` の log 記録・TODO画面のアーカイブ一覧（直近20件）・work の `check`（アーカイブ済みも読める）。
- live 音声の played 通知と `delivered` の記録（何が聞こえたかは会話の文脈に使う）。外すのは TODO のアーカイブ確定への接続だけ。
- 雑談の自発発話、未応答上限、busy・非アクティブ会話の制約。

## 3. 通知

### 3.1 作る条件

| TODOの終わり方 | アーカイブ | 通知 | 通知の見出し |
| --- | --- | --- | --- |
| `succeeded` | 完了の取引で | 未読で作る | 仕事が完了しました |
| `partial` | 完了の取引で | 未読で作る | 仕事が一部完了しました |
| `failed` | 完了の取引で | 未読で作る | 仕事が失敗しました |
| `interrupted` | 完了の取引で | 未読で作る | 仕事が中断しました |
| `cancelled` | 即時（現行） | 作らない（既読で記録） | ― |
| 忘却・結果の削除 | 即時（現行） | 作らない（既読で記録） | ― |

- 対象は全会話のTODO。サブエージェント（research・command・image・music・task・pipeline など、TODOを作る全実行種別）の完了が同じ経路（`WorkLedger.reportInTransaction`）を通る。instant の即答はTODOを作らないため対象外。

### 3.2 表示（既存の通知センターに第3の発生元として足す）

2026-10-29、利用者の依頼で小さくした。アプリのアイコン・アプリ名・時刻・見出しは出さない。

```
┌──────────────────────────────────────────┐
│ [画像の作成] 夕焼けの海の画像を作って    [🖼] │
│ 夕焼けの海の画像を1枚作りました。             │
└──────────────────────────────────────────┘
┌──────────────────────────────────────────┐
│ 失敗 [タイマー] 3分のタイマーを開始       [▭] │
│ タイマーを開始できませんでした。               │
└──────────────────────────────────────────┘
```

| 部分 | 内容 |
| --- | --- |
| 1行目 | `[担当名] TODOのタイトル`（担当名は toolchain の題、なければタイトルだけ）。成功以外は先頭に小さく「一部完了」「失敗」「中断」。長ければ1行で省略 |
| 2行目 | 結果の一行（200字。リソースURIは名前に置き換える）。画面では1行で省略。結果がなければ省く |
| 本文を押す | 既読にする。サーバーの応答を待たずにすぐ隠れる（既読の通知はバナーに出ない）。既読にできなければ戻してエラーを出す。ドロワーには既読として薄く残る |
| アイコン | アーティファクトを開く。作った物があれば、その種類のアイコン（会話のリソースチップと同じ）で、種類の既定の動作で開く（曲なら再生。最大3件、名前は `aria-label`・`title`「「夕焼けの海」を開く」）。作った物がなく、担当に登録された画面（binding の artifact）があれば、画面のアイコンでその画面を開く（「タイマーの画面を開く」）。どちらもなければ出さない。押すと既読になり隠れる |
| バナー | 既存と同じく8秒で畳む。畳んでも未読のまま一覧に残る |
| 未読数 | 通知のボタンのバッジに足す（タイマー・Kanbanと合算） |
| 通知音 | 新しい未読が届いたとき、Kanban と同じ短い音。画面の最初の読み込み時にあった分では鳴らさない |

### 3.3 API（dialogue domain）

| 操作 | 形 |
| --- | --- |
| 一覧 | `GET /api/todo-notices?limit=50` → `{ notices: TodoNotice[], unread: number }`。新しい順。`unread` は全件の未読数 |
| 既読 | `POST /api/todo-notices/:id/read` → `{ ok: true }`。存在しない・通知のないTODOは 404 |
| 更新の知らせ | 既存の `change` イベント（SSE）で一覧を取り直す |

```ts
type TodoNotice = {
	id: string; // TODOのID
	conversationId: string;
	title: string;
	toolchainTitle?: string;
	outcome: "succeeded" | "partial" | "failed" | "interrupted";
	summary: string | null; // 結果の一行
	artifactId?: string; // 担当に登録された画面（`timers.workspace`）
	links: Array<{ uri: string; label: string; kind: string }>;
	read: boolean;
	createdAt: string; // archived_at
};
```

### 3.4 TODO画面の手動アーカイブ

進行中のタブの各行に「アーカイブ」ボタンを置く。

| 行の状態 | 押したとき |
| --- | --- |
| `todo`（実行中）・`waiting`（確認待ち） | 確認の modal「実行中の仕事を止めてアーカイブしますか」→ 止めて（`done`・`cancelled`）アーカイブ。通知は作らない |
| すでにアーカイブ済み（別の画面・取引で先に終わった） | 成功として扱い、一覧を読み直す |

```
依頼内容                                   状態        操作
夕焼けの海の画像を作って                    実行中      [アーカイブ]
来週の天気を調べて  確認待ち：どの地域ですか   確認待ち    [アーカイブ]
```

| 部分 | 内容 |
| --- | --- |
| 画面の登録 | `agency.todos` の新revision。`actionBindings` に `archive`（eventAction `todo-archive`、effect `write`、operationId `todos.archive`、入力 `schema:todo-screen-archive@1` = `{ todoId }`）。クエリのschemaは `done` を除いた新revision |
| adapter | `adapter:task-execution@1` に操作 `todos.archive`（write）。dialogue の公開操作を呼ぶだけ。止めた job の中断は `afterCommit` で流す。受付の領収は TODO の ID と版から作る |
| 止め方（dialogue） | run を待つ仕事は work の `cancel` と同じ処理（子の取消・job の取消・run の終了）を共有の関数にして使う。task 実行は agent-runtime に、発話を根拠にしない host の取消（`cancel_requested`・`cancelled` で終える）を足して使う |
| 会話エージェント | 何も知らせない。State からは消える |

## 4. DB

dialogue の migration を1本足す（適用済みの migration は変えない）。

```sql
ALTER TABLE dialogue_work ADD COLUMN notice_read_at TEXT;
UPDATE dialogue_work SET notice_read_at = archived_at WHERE archived_at IS NOT NULL;
UPDATE dialogue_work SET archived_at = updated_at WHERE status = 'done' AND archived_at IS NULL;
ALTER TABLE dialogue_work DROP COLUMN archive_requested;
CREATE INDEX dialogue_work_archived ON dialogue_work(archived_at);
```

| 既存の行 | 移行後 |
| --- | --- |
| アーカイブ済み | 既読（通知に出さない未読を作らない） |
| `done` で未アーカイブ（報告待ちだった分） | 完了時刻でアーカイブし、未読の通知として一度出る |
| `todo`・`waiting` | 変えない |

- 未読の条件: `archived_at IS NOT NULL AND notice_read_at IS NULL`。取消・忘却・結果の削除は、アーカイブと同時に `notice_read_at` を入れる。

## 5. 会話エージェント

### 5.1 agency（`api/application/agency`）

| 対象 | 変更 |
| --- | --- |
| `hostTodoOf` | `done` は返さない。`todo`・`waiting` だけ |
| `newWork`（`result_received` を開く判定） | `waiting` の新しい質問だけで開く |
| 報告枠 `report-idle.ts` | 削除。`createIdlePlanner` をそのまま使う。`reportsOnly`・`completed_todo_required`・`reportSpoke` も削除 |
| 自発発話の保存 | `todoRefs` によるアーカイブ要求を削除（質問を引用した発話の知らせ・チップの紐づけは残す） |
| 返答の照合 `archiveReported`・`takeReportedTodos` | 削除（`done` を渡さないので照合する報告がない） |

### 5.2 主会話（dialogue の生成）

| 対象 | 変更 |
| --- | --- |
| 結果だけで起きる run | 現行どおり生成せずに完了し、サブエージェントの答えを消費する。agency に知らせるのは質問のときだけ |
| 保留中の発言がある run の「## Host notice」 | `done` の結果を載せない。`waiting` の質問は載せる |
| 「## State」の仕事 | `done` の行（`完了 未報告`）はなくなる。アーカイブ後2時間の行を `- t3 夕焼けの海の画像を作って 通知済み a5「夕焼けの海」`（失敗は `通知済み（失敗）`、取消は `取消済み`）にする |
| 表示中の結果の読み直し（`refreshActionResults`） | 未アーカイブの `done` がなくなるため削除 |
| system の文 | `toolchains.context.toml` の予告の規則: 時間のかかる仕事では、終わったら画面の通知で知らせることも予告（delegate の `announcement`）に含める。後で自分から報告するとは言わない。delegate の `announcement` の説明にも同じ旨を足す。決まった文言は書かず、言い方とどの仕事が時間のかかるものかはモデルが判断する。結果の伝え方の規則は、check で読んだ結果を伝えるときに使うため残す |

## 6. 削除するもの

| 場所 | 削除 |
| --- | --- |
| dialogue | `speech-delivery.ts`（`speechHeard`・`reportPending`・`recordMessageHeardInTransaction`）、`delivery-record.ts` の `archiveReportedInTransaction`・`archiveDone`・`recordHeardInTransaction` の `acknowledge`、ledger の `requestArchiveInTransaction`・`waitingArchivesInTransaction`・`reportedByRunInTransaction`、repository の `requestArchive`・`waitingArchives`・`workReportedBy`・`archiveRequested`、`hostTodosInTransaction` の結果の読み直し引数、TODO画面の `done` の状態と件数 |
| voice-dialogue | `POST /api/voice/replay/played`、`replayPlayedSchema`、`replay-playback.ts` |
| client・Web | `replayPlayed`、replay の再生完了の集計（`completed`・`heardClauses` など、この通知のためだけのもの） |
| agency | `report-idle.ts` と試験、`archiveReportedInTransaction` の依存 |
| 試験 | `tests/browser/spoken-report.spec.ts`、上記の機能だけを確かめる試験 |

## 7. 実装・検証の順

1. dialogue: migration、完了の取引でのアーカイブと通知、取消・忘却の既読、通知の一覧・既読の API、`done` の除外（Host notice・State・agency 向けの一覧）、削除。domain 試験で、完了→`archived`＋未読、取消・忘却→通知なし、既読、移行（未アーカイブの `done`→未読、アーカイブ済み→既読）、質問は従来どおり Host notice に載ることを確認する。
2. agency: 報告枠と照合の削除、`done` を渡さない。`api/application/agency` の試験で、`done` で機会が開かないこと、質問で `result_received` が開くこと、雑談の上限が従来どおりであることを確認する。
3. voice-dialogue・client・Web: replay の played の削除、通知センターへの TODO の通知（表示・開く・既読・通知音）、TODO画面のタブ。Web の単体試験と `tests/browser/agency-todos.spec.ts` を個別に実行する。
4. `bun run verify -- --domain dialogue --domain voice-dialogue` と `api/application/agency` の試験、型検査。fixture・live・実機器を分けて記録する。
5. 置き換えた設計書（冒頭の3件）に、この変更が優先する旨と変更後の規則を反映する。

## 8. 非目標

LLM・音声 Provider、TODOの完了条件、サブエージェントの質問の扱い、通知のOS通知（ブラウザのNotification API）化、サーバー操作と実機器の受入。

## 実装と検証結果

2026-10-29、実装・fixture検証済み。

| 部分 | 実装 |
| --- | --- |
| dialogue | `WorkLedger.reportInTransaction` が `done` を同じ取引でアーカイブ。通知の一覧・既読は `repository/work.ts` の `workNotices`・`readWorkNotice`、窓口は `service/work-stop.ts` の `createTodoScreenPorts`、経路は `GET /api/todo-notices`・`POST /api/todo-notices/:id/read`。結果の一行は `service/todo-notices.ts`（agency から移した `resultLine`）。忘却したTODOは `## State` に出さない |
| 手動アーカイブ | `work-stop.ts` の `archiveByUserInTransaction`（work の cancel と `stopWaitingRunInTransaction` を共有）。task・pipeline の実行は agent-runtime の `cancelByUserInTransaction`。adapter 操作 `todos.archive`（UI origin のみ、止めた job は `afterCommit` で中断）。bundle は `artifact:agency.todos@4`・`schema:todo-screen-query@4`・`schema:todo-screen-archive@1` |
| agency | `report-idle.ts` と返答の照合を削除。`hostTodoOf` は `todo`・`waiting` だけ。`result_received` は新しい質問でだけ開く |
| 削除 | `speech-delivery.ts`、replay の `POST /api/voice/replay/played`、Web replay の再生完了の集計、`tests/browser/spoken-report.spec.ts` と fixture、`archive_requested` 列 |
| Web | 通知センターに TODO の通知（`useTodoNotices`、新しい未読で通知音、`TodoNoticeCard` のアーティファクトを開くアイコン）。TODO画面は「進行中」「アーカイブ」、行ごとの「アーカイブ」と確認 modal |
| 依頼4 | 通知に担当の画面（`artifactId`、catalog の binding の artifact から）を載せ、作った物の種類アイコンか画面アイコンで開く。予告の規則は `toolchains.context.toml` と delegate の説明を変え、`bun run context:build` で `.s11tnext/catalog.json` を作り直した（このとき、コミット済みで未 build だったブラウザ担当の page-operator 参照文も一緒に反映された） |

移行: `dialogue/0026-work-notices` は実装中の作業ツリーの再読み込みで本番DBに適用済み（2026-10-29 12:45 JST）。適用済みSQLの checksum と現行の定義の一致を確認した。本番DBの読み取り専用コピーで、報告待ちだった `done` 5件（失敗4・成功1）がアーカイブされ未読の通知になり、既存のアーカイブ済み・取消は既読になったことを確認した。

検証:

- `bun test api/domains/dialogue api/application/agency api/application/toolchain/agency-todos-screen.test.ts api/domains/voice-dialogue api/domains/agent-runtime`: **765件通過**。
- Web（vitest、dialogue・voice-dialogue の replay・通知センター・TODO画面・workspace）: **21ファイル・111件通過**。
- `bunx playwright test tests/browser/agency-todos.spec.ts`: **1件通過**（route fixture。確認 modal から `archive` の送信まで）。
- 依頼4の追加後: 上の backend 試験 765件、Web（通知センター・resources・dialogue・workspace）22ファイル104件が通過。`bun run context:check`・`context:lint` 通過。通知カードの表示は scratch のページをヘッドレスブラウザで撮って確認（画像の通知に画像アイコン、タイマーの通知に画面アイコン）。予告の言い方は実LLMで未確認。
- `bun run toolchain:bundle -- check`（TODO画面の bundle）: 問題なし。
- 型検査: 本変更のファイルに型エラーなし。並行作業中の `api/domains/dialogue/test/conversation-input.test.ts` の1件は担当外。
- 変更ファイルの format・lint: 通過。size-budget: 変更で超えた関数は分割して解消（`agency/host.ts` の既存超過は 989→924 行に減少）。
- `bun run verify -- --domain dialogue --domain voice-dialogue --domain agent-runtime --domain capabilities`: 既存の `api/domains/voice-dialogue/test/settings-integration.test.ts`（1,001行）の size-budget 違反で停止。voice-dialogue を外した実行は並行作業の上記の型エラーで停止。どちらも担当外で、verify の合格とはしていない。
- 独立レビュー（1回）: 高・中の指摘なし。低4件（作った物のない通知の開く先、忘却したTODOの State 表示、adapter の止めた job の持ち越し、開く失敗の表示が残る）を修正した。

未実施・担当外: 実機器での受入、サーバーの再起動による反映。`scripts/context-eval/harness-compose.ts` は State の仕事を「報告済み」で合成しており、本番の「通知済み」と異なる（並行作業の測定範囲のため未変更）。2026-10-24 の評価実験の case が持つ `archived` は無視される。

