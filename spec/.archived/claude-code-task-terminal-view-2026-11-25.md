# 専任担当が動かす Claude Code の経過を端末アーティファクトで見守る

作成日: 2026-11-25。状態: **利用者合意（2026-11-25「その進め方で始めてください」）・実装済み・固定試験済み・実画面未確認**。§8 が実装の記録。

利用者の要望（2026-11-25）: 「専門の担当が見る形で構わないが、Claude Code のアーティファクトを見て経過を見守りたい」。

[専任サブエージェント設計](../.todo/claude-code-managed-task-design-2026-11-15.md) の実行方式（専任担当が Claude Agent SDK の runner を監督する）は変えない。同設計の 374 行目「初期版の利用者向け表示は既存のTODO、質問、通知とwork照会で満たす」を改め、端末アーティファクト「Claude Code」（`artifact:terminals.workspace`）に、専任担当が動かす実行を**読み取り専用の見守りペイン**として出す。

## 1. 現状（2026-11-25 の本番 DB とログで確認）

| 項目 | 事実 |
|---|---|
| 会話の入口 | `toolchain:claude-code.request@7`（2026-11-23 18:02 登録）→ `binding:claude-code.managed@1`（`execution: task`） |
| 画面 | なし。`taskBindingV1` に `artifactRevisionId` の項目が無い（`api/domains/capabilities/contracts/bindings.ts:218`） |
| 実行の場所 | `packages/coding-runner/src/claude-cli.ts serve` の中の SDK 実行。PTY ではない |
| runner が残す記録 | `data/claude-code-runner/<executionId>/event-<seq>.json` に、ツール呼出しごとに `{tool, input, result}` を一件。Claude の地の文（説明・方針）は残さない。終了時の要約は `receipt.json` の `observation.summary` |
| 端末アーティファクト | `artifact:terminals.workspace@2`（タイトル「Claude Code」、表示 `terminal-workspace`）。一覧は `query:terminals.sessions@1` で、PTY のセッション（手動端末・Kanban）だけを並べる |
| 端末 API の利用 | 2026-11-23 以降のログに `/api/terminals` の呼出しは 0 件 |

今夜の実行（t505、2026-11-25 20:55〜21:00、26 ターン、成功）は、利用者から見える画面が無く、作業一覧も `todo` のままだった。

## 2. 方針

| 決めること | 決定 |
|---|---|
| 実行方式 | 変えない。専任担当が SDK runner を監督する |
| 表示先 | 既存の端末アーティファクト「Claude Code」に、手動端末・Kanban のペインと並べて出す |
| 操作 | 読み取り専用。キー入力・再起動は受け付けない。止める・条件を変えるは従来どおり会話から行う |
| 開くタイミング | 新しい仕事を受け付けた時点で画面を開く。既存の仕組み（`GET /api/terminals` の `requests` が増えると Web が「Claude Code」画面を開く `useClaudeCodeArtifacts`）に、受け付けた仕事の件数を足して使う。会話の委任経路（TODO 廃止で作り直し中）には触れない |
| 表示の正本 | runner のイベント記録と claude-code owner の view。別の状態の正本を作らない |
| PTY との関係 | 実行を PTY に結び付けない（374 行目の趣旨のうち「入力を送れる画面に結び付けない」は保つ） |

## 3. 見守りペインの表示

一つの仕事（`claude_code_work` 一件）を一つのペインにする。仕事の中の複数の実行（`executions`、上限 8）は、同じペインに続けて書く。

表示例（ANSI 色付きの行として端末ペインに書く）:

```
━━ Claude Code（専任担当）  依頼: 開いているプロジェクトで、設定からLive2Dの背景色を変更できる…
▶ 実行 1 開始 20:55:02
  Claude: 設定画面の定義と背景の描画箇所を確認します。
  $ git status --short; sed -n 40,70p web/src/domains/settings-data/settings-definitions.fixture.ts
    M api/application/settings/settings-adapter.ts …（出力 12 行のうち先頭 6 行）
  ✎ Edit web/src/components/domains/conversation/HiyoriAvatarBackground.tsx
  $ timeout 600 bun test ./api/application/settings ./api/domains/settings ./api/domains/capabilities
    240 pass / 0 fail
■ 実行 1 終了 20:57:40（error_max_turns・再開可能）
  担当: 検証の残りを同じ仕事で続けます。
▶ 実行 2 開始 20:57:52
  …
■ 実行 3 終了 21:00:48（success・26 ターン）
━━ 完了: 設定画面の「表示」から Live2D の背景色を変えられるようにしました。…
```

| 行の種類 | 出どころ | 書き方 |
|---|---|---|
| 見出し | owner の view の `request` | 先頭 80 文字 |
| 実行の開始・終了 | owner の view（`executionId` の切替、`observation.state`・`resultSubtype`） | 時刻・終了理由 |
| Claude の地の文 | **新規**: runner が SDK の assistant テキストを別のファイルに残す（1 件 2,000 文字まで） | 8 行・1 行 200 文字まで |
| ツール呼出し | 既存の `event-<seq>.json` の `tool` と `input` | Bash は `$ コマンド`、Edit/Write は `✎ パス`、Read は `📄 パス`、その他は `• ツール名` |
| ツール結果 | 同じイベントの `result` | 先頭 6 行・1 行 200 文字まで |
| 担当の判断 | owner の `summary` の更新（`invoke / wait / ask_user / finish`） | `担当: …` |
| 質問 | owner の `question` | `？ …（会話で答えてください）` |
| 完了 | `result.summary` | 先頭 300 文字 |

## 4. 変更の構成

| 層 | 変更 |
|---|---|
| runner（`packages/coding-runner`） | SDK の assistant テキストを、ツール記録とは別のファイル（`text-<n>.json`、直前のツール記録の番号 `afterSeq` 付き）に残し、操作 `narration` で読めるようにする。ツール記録・evidence の数え方・上限と、担当の判断の入力は変えない |
| claude-code domain | 見守り（`watch`）を追加する。仕事の実行を順に、runner のツール記録と Claude の説明を seq 順に並べ、§3 の行に整形して流す。仕事に実行 ID の履歴（`executionIds`）と受付時刻を記録する |
| capabilities | 変更しない（画面は既存の `artifact:terminals.workspace@2` と `query:terminals.sessions@1` のまま。項目の追加は任意項目なので版を上げない） |
| terminals domain | 画面用の一覧 `screens()` を追加する。PTY のセッションに加えて、専任担当の仕事を `owner: "claude-task:<workId>"`・`readOnly: true` の項目として返す。`list()` は PTY だけのまま（作業場所の排他と会話の snapshot が読むため） |
| 出力の配信 | `/api/terminals/:id/output` と同じ配信形式で、見守りペインの行を流す。id が専任担当の仕事なら §3 の整形済みの行を返し、終了後は `exit` を送る |
| Web（`web/src/domains/terminals/toolchain-adapter.tsx`） | `readOnly` の項目は `onInput`・`onRestart` を渡さず、`heading` に「専任担当」を出す |
| 会話 | 変更しない（画面は上の件数で開く） |

## 5. 規則

| 場面 | 動作 |
|---|---|
| 仕事が `queued`（作業場所待ち） | ペインを出し、「作業場所の空き待ち」を一行書く |
| 実行中 | 新しいイベントを順に追記する |
| 質問待ち | 質問行を出す。答えは会話で受ける |
| 完了・失敗・取消・期限切れ | 終了行を書いて `exited` にする。ペインは一覧に残る（手動端末の終了と同じ） |
| 仕事を忘れた（`forgotten`） | 一覧から外し、出力も返さない |
| 読取りだけの仕事 | 同じく表示する（runner の `readOnly` は Claude Code 側の権限で、表示とは無関係） |
| 他の会話の仕事 | 出さない。会話に属する仕事だけ |
| backend 再起動 | runner の記録から最初の seq まで読み直して再描画する |
| 一覧の上限 | 見守りペインは手動端末の同時起動数の上限に数えない |

## 6. 範囲外

- 実行方式を PTY に戻すこと、実行中の Claude Code へ端末から直接入力すること。
- 作業一覧の状態（`todo` のまま）や重複依頼の防止。別に進んでいる[TODO廃止の設計](../.todo/toolchain-assignment-as-research-2026-11-25.md)と合わせて扱う。
- 監督つき実行（`origin: supervised`、登録目標）の表示。開発監督の画面側で扱う。

## 7. 検証

| 段階 | 内容 |
|---|---|
| fixture | runner の text/tool イベントの記録、整形した行（§3 の各種類）、seq の続き読み、終了時の `exit`、`readOnly` 項目の入力拒否、`query:terminals.sessions@2` の会話ごとの絞り込み、版の追加で適用済みの版が変わらないこと |
| domain | `bun run verify -- --domain claude-code --domain terminals --domain capabilities --domain dialogue` |
| Web | `web/src/domains/terminals/toolchain-adapter.test.tsx` に読み取り専用ペインの試験を追加 |
| 実画面 | backend 再起動後、会話から Claude Code に小さな作業を頼み、端末アーティファクトが開いて経過が流れ、完了で終わることを利用者が確認する |

## 8. 実装の記録（2026-11-25）

| 層 | ファイル | 内容 |
|---|---|---|
| runner | `packages/coding-runner/src/claude-engine.ts`・`claude-narration.ts`・`claude-service.ts`・`claude-contracts.ts`・`claude-client.ts` | SDK の assistant テキスト（主スレッドのみ）を `text-<n>.json`（`afterSeq` 付き）に保存。操作 `narration(id, after)` を追加。ツール記録（`event-<n>.json`）と件数・evidence は変えない |
| claude-code domain | `api/domains/claude-code/watch.ts`・`contracts.ts`・`lifecycle.ts`・`task.ts`・`index.ts` | 仕事に `executionIds` と `startedAt` を記録。`watch` が一覧（進行中すべて＋終わった直近3件）、件数、出力（server-sent events）を返す。出力は開いたとき runner の記録から全部書き直し、以後1秒ごとに追記。ペインごとに処理を直列化 |
| terminals domain | `service/watch-panes.ts`・`service/index.ts`・`contracts/index.ts`・`controller/index.ts` | `configureWatch`・`screens`・`watchStream`。ペインの resize は何もしない。`GET /api/terminals` は `screens()` |
| application | `toolchain/toolchain-host.ts`・`toolchain/toolchain.ts`・`work/terminals-adapter.ts` | claude-code の `watch` を terminals に接続。画面の source は `screensInTransaction` |
| Web | `packages/artifact-ui/src/terminal-components.tsx`・`web/src/domains/terminals/toolchain-adapter.tsx` | 読み取り専用ペイン（入力・再起動なし、見出し「Claude Code（専任担当）」）。進行中のペインがあれば手動端末を自動起動しない |

| 検証 | 結果 |
|---|---|
| fixture | `api/domains/claude-code/test/watch.test.ts`（行の整形・切れたイベント・制御文字の除去、二実行の順序・説明・判断・結果、一覧と件数）、`api/domains/terminals/test/watch-panes.test.ts`（一覧の合成、`list()` 不変、revision、resize、出力の振り分け）、`web/src/domains/terminals/toolchain-adapter.test.tsx`（読み取り専用・自動起動の条件） |
| domain | 初回の `bun run verify -- --domain claude-code --domain terminals --domain coding`：試験 176 件中 1 件失敗（`claude-code-toolchain.test.ts` の確認の取り下げ。TODO 廃止の作業中の変更範囲で、本変更は dialogue に触れていない）。レビュー修正後は、TODO 廃止の作業中のファイル削除（dialogue の `interactions`・`todo-notices` など）で verify と Web の vitest が途中で止まるため、本変更のファイルだけ型・lint・整形と試験（bun 8 件）を確認した。TODO 廃止のコミット後に verify と Web 試験をやり直す |
| 実画面 | 未確認。backend と Claude Code runner（`claude-cli.ts serve`）の再起動後に確認する。runner を再起動するまでは Claude の説明は出ず、ツール記録だけが流れる |

独立レビュー（2026-11-25）の指摘を一度で直した: C1 制御文字と行区切りの除去、ペインを受付順に固定（接続の張り直しを防ぐ）、手動端末の自動起動を画面を最初に読んだときだけ判定（見守り中の完了で起動しない）、記録を読めない終了済みの仕事は5回で打ち切って終端行を出す、Claude の説明の書込み失敗で実行を落とさない、一覧の変更検知と存在確認を行の解析なしの軽い SELECT に、旧仕事の実行履歴を直前の実行から始める、失敗したツールの理由（`✗`）と監督経路の平文の記録を表示、専任担当のペインではチャイムを鳴らさない（結果は会話が知らせる）。自動で開く件数は実害なしとして変えていない。
