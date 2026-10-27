# TODO報告停止の調査とアーカイブ一覧の変更

後続の明示依頼により、報告上限と音声再生完了時アーカイブも修正した。[後続の設計・検証結果](todo-spoken-report-delivery-design-2026-10-27.md)を参照。以下は最初の調査・一覧変更時点の記録。

2026-10-27。報告経路は調査済み、アーカイブ一覧は実装・fixture検証済み。実環境への適用・実機器での読み上げ確認は未実施。

## 目的・範囲・完了条件

- TODOの結果を会話エージェントが報告・アーカイブしない原因を、既存の指示、台帳、実行経路、運用ログ、固定試験で調べる。
- アーカイブはタブ表示時に直近20件だけ取得・表示する。進行中一覧のページ操作は維持する。
- 既存の報告・アーカイブ機構を再利用する前提で調査する。報告の優先順位、自発発話の抑制規則、保存時アーカイブの設計変更は実装範囲に含めない。DBスキーマ・認証・接続設定も変更しない。
- 完了条件は原因と根拠の記録、一覧の契約からブラウザまでの接続、部分→結合→ブラウザでの確認、差分点検。サーバーの停止・起動・再起動は行わない。

## 調査結果

正本は `agency-conversation-agent-design-2026-10-25.md` §6・11.4、`context-window-spec-2026-10-24.md` §9.4。完了したTODOは agency の `decide` が報告し、`todo:<id>` を根拠として発話へ紐づける。通常の返答が報告した場合は背景の `update` が照合する。

### 複数の完了TODOが残る再現

`api/application/agency/host.ts` は、完了報告を含む自発発話が保存されると、すべて `planner.proactiveSpoke()` に渡す。vendor の `createIdlePlanner` は `maxUnanswered` に達すると `unanswered` で停止する。一方、agency の `selectHostTodos` 指示は「一度に一つだけ、古いものから報告」と指定している。`newWork()` は、その時点で見えた完了TODOすべてを通知済みとして記録し、同じTODOでは新しい `result_received` を開かない。

既存の `host.fixture.ts` を使い、完了TODOを2件同時に渡し、1件目を引用して報告する診断を一時試験で実施。報告済みの1件を台帳投影から外し、2件目だけを残して時計を1時間進めても、追加の報告は起きなかった。

- 条件: `idleSec: 20`、`maxUnanswered: 1`（fixtureの設定）。
- 結果: 報告1件、未報告1件、`blockedBy: unanswered`、次のタイマー0件。
- 初回診断は、台帳の代用データを書かなかったためコミット通知が起きずタイムアウト。実際の更新と同じく代用行を書き込む条件に直して再現した。
- これは固定試験による実装上の再現であり、現在の全TODOがこの理由で残ったと断定するものではない。

### 運用ログで観測した報告の不採用・省略

`bun run logs -- --level warn` から開始し、agency の記録を絞って確認した。

- 2026-10-27 07:30:43（日本時間）、`main` の `result_received`、`o1`: `select` が `bad_tool` で不採用。Eumenes の背景用 agency は `tools: []` で構築するため、ツール実行を選ぶ提案は採用できない。`update` にも `unknown_ref` の不採用がある。
- 同日07:31:16、`o2`: `idle` で発話が保存され、その後の `agency.idle_cycle` は `phase: unanswered`、`count: 1`。上記の抑制経路に入ったことがログでも確認できる。
- 同日07:38:21、`o3`: 別の `result_received` では発話保存に成功している。報告経路が常に壊れているわけではない。
- 2026-10-25 23:20〜23:22の記録では、背景更新の不採用後、`skipped:budget`・`host_budget` で報告判断が省略され、最後は idle が `exhausted` になっている。これは過去の別時点の要因として区別する。

既存機構での修正案は、まず `decide` の指示と提示文脈を整合させ、発話による報告と通常応答のツール実行をモデルが区別できるようにすること。複数完了の処理については、報告と雑談が同じ未応答上限を消費する現行ルールをどう扱うか、既存plannerの責務に沿って設計を決める必要がある。固定文や依頼語句による専用分岐は追加しない。

### 読み上げ完了とアーカイブの違い

`dialogue/service/delivery-record.ts` の `recordSpontaneousInTransaction` は、引用した完了TODOを発話保存時にアーカイブする。自動読み上げはWebの `useAutomaticSpeech` が保存後のメッセージを見て別途行う。音声の自動再生が無効・中断・失敗でも、保存時のアーカイブは取り消されない。

通常のrun付き返答については、`update` の報告照合と `heard: full` が揃ってから確定する。自発発話まで実際の再生完了に揃えることは、今回は変更していない。

現在の実データ一覧のAPI読取りは認証で拒否されたため、認証を迂回せず、保存済みの運用ログと隔離fixtureで調査した。

## 実装した画面変更

- `todosWebAdapter` は最初に active のみを取得する。archived の選択時に `state: archived, pageIndex: 0, pageSize: 20` で取得する。非表示のArtifactへの外部更新通知でも強制再取得しない。
- アーカイブの件数選択・ページ移動を表示しない。タブを戻した際は active の表示条件を保つ。
- `ServerDataTable` の既存部品に、ページ操作を非表示にする任意propを追加。既定の動作は維持する。
- SQLは既存 `workPage` の `archived_at DESC, id DESC LIMIT ? OFFSET ?` をそのまま再利用。日付の並べ替えや20件への切詰めをブラウザだけで済ませない。
- 新規登録は `artifact:agency.todos@3` と `schema:todo-screen-query@3`。旧artifact・schemaの内容が変更されていないことをJSON比較で確認した。
- 接続は既存の `agency.todos` → `query:agent-runtime.todos@1` → `adapter:task-execution@1` → dialogue台帳。新しい判断機構や依頼に依存する分岐は追加していない。

元の実装も初期表示でアーカイブ本文を取得するものではなかった（activeの応答にアーカイブ総数は含む）。今回も総数表示は維持し、アーカイブ本文は表示時の最新20件に限定した。

## 検証

- 部分・結合: `bun test api/domains/dialogue/test/todo-screen.test.ts api/application/toolchain/agency-todos-screen.test.ts api/application/agency/host-work.test.ts` — 20件通過。
- 登録dry-run: `bun run toolchain:bundle -- check api/domains/capabilities/bundles/agency-todos-screen.bundle.json` — 登録可能。
- `verify`（agent-runtime・artifact・capabilities・dialogue）— 既存のdialogueのサイズ制限違反で停止。該当箇所は編集していない。
- `verify`（agent-runtime・artifact・capabilities）— 型・build・静的工程、Bun 605件、Web 90件は通過したが、実行中の別作業による入力変更を検知して **invalidated**。実行全体を合格とは扱わない。記録: `verification-reports/runs/2026-10-26T23-26-54-090Z-22e8ff62-05ec-4fd6-8808-c07545ca71d4/report.json`。
- `bun run --cwd packages/design-system test src/components/ServerDataTable/ServerDataTable.test.tsx` — 2件通過。
- `bunx vitest run web/src/domains/agent-runtime/toolchain-adapter.test.tsx` — 最終差分で個別に4件通過。まとめた検証の無効化と区別して記録した。
- `bunx playwright test tests/browser/agency-todos.spec.ts` — 1件通過。アーカイブ未選択時の取得なし、選択後20行、ページ操作なし、activeページ操作、狭い画面、空一覧を確認。アプリ・fixtureサーバーを起動しないroute fixture方式。画像は `test-results/todo-artifact/`。
- `bun run test:domain -- --domain dialogue` — 353件通過、20件失敗、1 error。既存作業部分の `FIXED_TRIGGER_TEXT` のexport不整合、context-evalやspecialistの期待値不整合等を確認。担当外のため修正していない。結果は `/tmp/eumenes-todo-dialogue-tests.log`。
- 変更対象の `git diff --check` は通過。既存の無関係な差分・未追跡ファイルには触れていない。

## 残ること

- 報告の抑制・不採用への修正は、本調査結果に基づく別の実装判断が必要。
- 自発発話のアーカイブを実際の音声配信完了へ変更する場合は設計の合意が必要。
- 新しい画面登録の実環境への適用、実LLMでの報告、実機器での読み上げ完了は未確認。サーバーは操作していない。
- まとめた検証の有効な全体合格には、並行変更が落ち着いた状態と、担当外の既存違反の解消が必要。

俯瞰評価では、同じ広い検証を繰り返さず、原因の再現と画面の通し確認へ切り替えた。これにより新しい原因の証拠とブラウザ通過を得て、今回の残作業を解消した。
