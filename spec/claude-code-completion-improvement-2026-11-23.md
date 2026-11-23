# Claude Code タスク完遂・イベント可視化・質問回答 改善設計書

作成日: 2026-11-23  
状態: **実装済み・固定試験通過・実接続受入前**  
基礎設計: [claude-code-managed-task-design-2026-11-15.md](claude-code-managed-task-design-2026-11-15.md)

## 1. 目的と合意事項

会話から Claude Code へ依頼した開発作業について、以下を一貫して成立させる。

1. 独立 Claude Runner を通常起動で稼働・自動接続し、新経路（`toolchain:claude-code.request@7`）を有効化する。
2. 質問（複数問・複数選択・自由記述）とツール追加許可要求に対応し、専任担当による一次仕分け（既知事実の代理回答）と利用者確認を使い分ける。
3. 失敗理由・`stderr`・詳細イベント読取り（`events`）・複数実行をまたぐ証跡保持・判断リトライを整え、途中で止まらずやり切れる継続ループを成立させる。
4. 実行フェーズ・待機理由・進捗要約を遅延なく投影し、会話と TODO 画面から状況を把握できるようにする。

合意済みの設計方針:
- **通常作業の権限**: 登録作業場所内の読み書きと、サンドボックス内コマンドを既定許可とする。禁止操作（`git push`・秘密領域等）は `PreToolUse` で機械的に拒否し、許可外の追加操作は `canUseTool` で利用者確認へ回す（専任担当による自己承認は禁止）。
- **進捗の見せ方**: 自動発話で会話に割り込まず、TODO パネル・通知センター・`work.check`・次の会話の `## State` で見せる（質問・許可待ちのみ即時通知）。
- **既存 PTY 画面の位置づけ**: `terminals.workspace` は手動操作用として維持し、会話依頼は SDK runner 経路へ切り替える（`workspace-guard` を共有）。

## 2. 変更単位と実装計画

### Phase 1: 独立 Claude Runner の常駐起動と通常経路への接続
- `packages/coding-runner/src/claude-cli.ts`: `serve <configPath>` で `serveClaudeRunner` を起動する独立 CLI エントリポイント。ローカル `claude` 実行ファイルとログイン状態を確認し、通常作業向け `prepare`（利用可能ツール、サンドボックス設定、プロジェクト指示、アカウント照合）を構成する。モデル名・profile 名はコードに固定しない。
- `packages/coding-runner/src/claude-daemon.ts`: Codex 用の `sdk-daemon.ts` と同じく、private socket（`0700`/`0600`）へ接続し未起動時は detached で自動起動する `claudeDaemonClient`。backend 終了で runner を止めない。
- `api/domains/coding/index.ts`・`api/application/server-wiring.ts`: `EUMENES_CLAUDE_WORK_RUNNER_SOCKET` が指定されていればそれを優先し、未指定時は `claudeDaemonClient` を既定の private root（`dirname(dbPath)/claude-code-runner`）で構成して probe する。

### Phase 2: 質問・追加許可の完全対応と一次仕分け
- `packages/coding-runner/src/claude-contracts.ts`・`claude-engine.ts`・`claude-service.ts`:
  - `AskUserQuestion` の複数質問（1〜4件）・`multiSelect`・自由記述を受理し、1 問ずつ順番に `ask()` で解決して `updatedInput.answers` を組み立てる。
  - `canUseTool` で事前許可外のツール要求を受けた場合、禁止境界に当たらない限り `kind: "permission"` の確認質問（対象ツール・入力概要・選択肢「許可 / 拒否」）として `ask()` へ流し、利用者の明示承認時のみ `allow` を返す。
  - 質問メタデータ（`kind: "question" | "permission"`、選択肢、対象ツール概要）を `ClaudeQuestion` に保持する。
- `api/domains/claude-code/`:
  - 質問が runner から届いたとき、通常モードでは即 `waiting_user` にせず `decisionMode: "question"` で専任担当の判断ジョブを起動する（`kind: "permission"` は自己承認を機械的に禁止し、そのまま利用者確認へ進める）。
  - 専任担当の判断アクションに `reply`（`questionId` + `answer`）を追加し、元依頼・既知事実で答えられる質問は代理回答する。利用者判断が必要な場合は `ask_user` で元質問と対応付けた質問を会話へ提示する。
  - 質問の 15 分タイムアウト時は仕事全体を `expired` 終了せず、質問のみ期限切れとして扱い、仕事期限内なら再判断・継続可能にする。

### Phase 3: 失敗観測・詳細イベント読取り・継続耐性の強化
- `packages/coding-runner/src/claude-engine.ts`・`claude-service.ts`・`claude-client.ts`:
  - `PostToolUseFailure` を通常モードでも証跡に記録し、`stderr` の末尾抜粋（上限 2 KiB）と `result` の `subtype`（`success` / `error_max_turns` / `error_during_execution` 等）・`errors` を観測に含める。
  - `claudeRunnerClient` に `events(id, after)` を追加。
- `api/domains/claude-code/`:
  - 専任担当の判断アクションに `read_events`（cursor 指定）を追加し、`driver.ts` から runner の `events` を取得して次回判断へ渡す（直近 8 件×300 字の制限を補う）。
  - `Work` に複数実行をまたぐ有効証跡 `ref` 一覧（上限 128 件）を保持し、前半実行の検証証跡を最終 `finish` で引用しても `partial` に誤降格しないようにする。
  - 判断ジョブの一時失敗（推論タイムアウト・スキーマ不一致）を最大 2 回まで再試行し、非 `progress` 時の `wait` は即 `partial` 終了せず再判断に回す。

### Phase 4: 非 LLM 進捗フェーズ即時投影と通知導線
- `api/domains/claude-code/lifecycle.ts`・`index.ts`:
  - 観測更新時（開始・ツール実行進捗・確認待ち・実行完了・エラー・再試行）に LLM を呼ばず即座に `work.summary`（フェーズ＋直近の活動要約）と `observedAt` を更新する。
  - 60 秒間隔の進捗要約推論は補助として維持し、会話の `## State`・`work.check`・TODO 画面で常に現在状況が追えるようにする。
- `api/domains/capabilities/bundles/claude-code-task.bundle.json`:
  - 既存の published revision の本文を変えず、必要な説明・ルール補強は専任担当の runtime rules（`decision.ts`）または新 revision で整合させる。

## 3. 検証計画

1. 固定試験: `packages/coding-runner/test`、`api/domains/claude-code`、`api/application/work/claude-code-task-*.test.ts`、`api/application/work/supervision-*.test.ts` で、daemon 起動、複数質問・複数選択、ツール追加許可、専任担当の代理回答と権限自己承認禁止、詳細イベント読取り、失敗理由観測、過去証跡保持、判断リトライ、非破壊質問タイムアウトを検証する。
2. ドメイン検証: `bun run verify -- --domain claude-code --domain coding --domain capabilities --domain tool-runtime --domain dialogue`、`bun run size:check`、`bun run fixed-names` を実行する。
## 4. 実装・検証記録（2026-11-23）

### 実装済み
- **Phase 1（常駐 Runner 化・接続配線）**: `packages/coding-runner/src/claude-policy.ts`・`claude-cli.ts`・`claude-daemon.ts` を追加し、`api/application/server-wiring.ts` から既定で `claudeDaemonClient` を起動・接続するように構成（`EUMENES_CLAUDE_WORK_RUNNER_SOCKET` 指定時は既存ソケットを優先、`EUMENES_CLAUDE_WORK_RUNNER_AUTOSTART=0` で自動起動を無効化可能）。
- **Phase 2（質問・追加許可・一次仕分け）**: `packages/coding-runner/src/claude-questions.ts`・`claude-engine.ts`・`claude-service.ts` で複数質問・複数選択・自由記述の `AskUserQuestion` と、`PreToolUse: "ask"` → `canUseTool` 経由のツール追加許可（`kind: "permission"`）に対応。`api/domains/claude-code/` で通常質問の専任担当一次仕分け（代理回答 `reply` / 利用者確認 `ask_user`、権限確認の自己承認禁止）と、通常モードにおける非破壊的な質問タイムアウトを実装。
- **Phase 3（失敗観測・イベント読取り・継続耐性）**: `claude-engine.ts`・`claude-service.ts`・`claude-client.ts` で `PostToolUseFailure` 通常記録・`resultSubtype`・`errorDetail`・`stderrExcerpt`・`events(id, after)` を追加。`api/domains/claude-code/` で `read_events` 取得、複数実行をまたぐ `knownEvidenceRefs` 保持、判断ジョブの一時エラーリトライ（最大 2 回）を実装。
- **Phase 4（非 LLM 進捗投影）**: `lastTool`・`eventCount`・実行終了理由・許可待ち／質問待ちに応じた進捗サマリーを `ExecutionView.progress` へ即時反映。

### 検証済み（fixture / 固定試験）
- `bun run verify -- --domain claude-code --domain coding --domain capabilities --domain tool-runtime --domain dialogue --domain development-supervision`: **PASS**（Bun 1,161 pass / 4 skip / 0 fail、Web Vitest 22 pass / 0 fail、全静的検査・境界・サイズ・固定名・型検査・DesignSystem ビルド通過）。
- `bun test`（新規 2 ファイル含む 7 ファイル）: **22 pass / 0 fail**（201 assertions）。
  - `packages/coding-runner/test/claude-questions-and-policy.test.ts`
  - `api/application/work/claude-code-improvements.test.ts`
  - 既存 `claude-service.test.ts`・`claude-supervised-execution.test.ts`・`claude-code-task-integration.test.ts`・`claude-code-task-recovery.test.ts`・`goal-supervision.test.ts`

### 未検証（実接続・実機器受入前）
- 稼働中サーバーの再起動および実 Claude CLI 認証・実モデル・実ブラウザーでの通し受入（`claude-code` 新経路での依頼 → 進捗確認 → 質問／許可回答 → 失敗リカバリ → 検証付き完了）は未実施。

