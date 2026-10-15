# Claude Agent SDK 認証切替・セッション継続 実装計画（レビュー用）

状態: **計画**（未実装・未検証）。改訂3（2026-10-15）: Astra 再レビュー7件を反映し、セッション記録の正本を「SDK が書いた生の記録」から「Eumenes の正本から毎回組み立てる記録」へ変更（§10）。記載の挙動はいずれも実装済みではない。

## 1. 目的

1. チャット画面（メイン画面）左上の SelectBox で、会話エージェントの推論先（接続 × モデル）を即座に切り替えられるようにする。
2. Claude Agent SDK の接続で、認証経路を「Claude サブスクリプション」と「Claude API キー（API クレジット）」から明示的に選べるようにする。API キーとエンドポイントは設定画面で入力する。
3. 接続ごとに利用可能なモデル一覧を実行時に取得する（コードにモデル名を固定しない）。
4. 会話エージェントでは SDK の SessionID を接続 × 認証 × モデルごとに固定して `resume` し、会話の連続性とプロンプトキャッシュを活かす。サブエージェントはタスクごとに使い捨てのセッションで動かす。

## 2. 前提（確認済みの事実）

### 2.1 Anthropic 側

- サポート記事（2026-10-07 更新）: Agent SDK・`claude -p`・サードパーティーアプリは引き続きサブスクリプション枠で利用できる。同更新で Max / Team プランに月次 API クレジットが付与され、Agent SDK・`claude -p`・Claude API・Managed Agents が対象。
  - https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- 認証の優先順（Claude Code / Agent SDK 共通）: クラウドプロバイダー → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → サブスクリプションログイン。キーが一つでも混入すると黙って API 課金になる。`CLAUDE_CONFIG_DIR` ごとに認証情報（macOS キーチェーン項目を含む）が分離される。
  - https://code.claude.com/docs/en/authentication
- プロンプトキャッシュは先頭一致（`tools` → `system` → `messages`）で判定され、ワークスペース単位・モデル単位で分離される。SessionID とは無関係。
- Models API（`GET /v1/models`）は `id`・`display_name`・`max_input_tokens` を返す。
- 導入済み Agent SDK（`@anthropic-ai/claude-agent-sdk` 0.3.289）の関連契約:
  - `Query.supportedModels()`（文脈長なし）、`Query.accountInfo()`（`apiProvider`・`tokenSource`・`subscriptionType`・`apiKeySource` 等）、`system/init` の `apiKeySource`。
  - `ApiKeySource`（`sdk.d.ts:128`）: `none` は claude.ai OAuth・Bearer トークン・外部クラウドプロバイダーのいずれでも使われる。`oauth` は現行 CLI が返さない旧値。`apiKeySource` 単独ではサブスク経路を識別できない。
  - `persistSession: false` のセッションは後から再開できない（`sdk.d.ts:1810`）。
  - `SessionStore`（`sdk.d.ts:6527`）: `append(key, entries)` は**best-effort**（失敗時は 3 回まで再試行後にバッチを捨て `mirror_error` を通知し、推論は継続。`sdk.d.ts:6544`）。`load(key)` が返したエントリは一時 JSONL に展開され、子プロセスはそこから再開する。store から再開した実行のローカル写しは終了後に消える。
    - https://code.claude.com/docs/en/agent-sdk/session-storage
  - `SessionKey.projectKey` は既定で cwd 由来。固定するには `CLAUDE_CONFIG_DIR` と併用して env `CLAUDE_CODE_PROJECT_DIR_NAME` を指定する（公式資料）。名前に `:` を含むと検証を通らず cwd 由来に戻る（Astra の最小実験で確認: `eumenes:main` は cwd 由来、`eumenes-main` は固定キー）。

### 2.2 Eumenes 側（現行コード）

| 項目 | 現状 | 場所 |
|---|---|---|
| 接続種別 | `openai-compatible` / `codex-sdk` / `claude-agent-sdk` / `claude-managed-agents` | `api/domains/settings/contracts/index.ts:14` |
| 認証切替 | 暗黙。暗号化済みキーがあれば API キー、なければ Claude Code ログイン（サブスク）にフォールバック | `api/domains/inference/adapters/cloud-agents.ts:357` |
| 資格情報の保存 | 暗号化して SQLite に保存する経路あり（`source: "encrypted"`）。`envRef` 経路もあり | `api/domains/settings/service/index.ts:189-254` |
| Claude 実行 | 毎ターン新規 `query()`、`persistSession: false`、`cwd` は毎ターン `mkdtemp` → 削除、`settingSources: []`。`mirror_error` は処理していない | `cloud-agents.ts:319-435` |
| プロンプト形状 | 先頭の system 群をシステムプロンプトに、残りの全履歴を JSON 文字列 1 個の user プロンプトに詰める（履歴はキャッシュに乗らない） | `cloud-agents.ts:56` `promptParts` |
| モデル一覧 | Web にモデル名を固定記述（`agentModelCatalog`）。AGENTS.md の規則に違反 | `web/src/domains/settings/shared.ts:36` |
| 会話モデル切替 | `useConversationModel().select` は存在するが、チャット画面はラベル表示のみ | `web/src/workspace/ConversationPanel.tsx:157` |
| 会話 ID | Web は常に固定値 `"main"`。区切りのない 1 本の会話が永続する | `web/src/workspace/useWorkspace.ts:122` |
| 文脈の正本 | memory domain の Window（やり取り台帳の `keep` / `summarize` / `drop`、要約、長期・短期層、版管理、忘却による封鎖）。期限切れの短期記憶は次回の文脈から除去 | `api/domains/memory/service/context-window.ts:331` |
| 文脈の組み立て | `system → longTerm → goals → history(keep) → working(要約・短期) → unprocessed → input`（＋通知・prefetch の tail） | `api/domains/dialogue/service/context-compiler.ts:113-300` |
| 一発言あたりの推論 | 機能選択（`selectionMessages`）と本回答の生成は**同じ `input.requestId`** を使う。選択時の自然文は回答として採用せず、全文脈で生成し直す。見直し・出力契約違反の修正でも追加推論 | `dialogue/service/generation-handler.ts:171,217` |
| 修正処理 | 失敗出力を `UNTRUSTED_REJECTED_OUTPUT` として次の試行の入力へコピーする | `dialogue/service/conversation-generation.ts:124` |
| 回答の後処理 | 未確認の引用 URL を除去してから会話へ保存（`verifiedAnswerLinks`）。生の回答と採用された回答は異なりうる | `generation-handler.ts:244` / `dialogue/test/research-citations.test.ts:7` |
| 通知 | 「必要なら会話の中で一言伝えてください」という指示として tail に入り、回答の採用時に消去。結合試験は採用後の次の推論入力に通知が含まれないことを要求 | `context-compiler.ts:304` / `generation-handler.ts:333` / `dialogue/test/memory-integration.test.ts:285` |
| 採用判定 | Receipt の `attemptId` で実際の試行を特定する | `inference/service/receipt-authority.ts:13` |
| ツール呼び出し | 推論終了後に `settleConversationOperation` で検証し操作担当ジョブを登録。ジョブは会話の `concurrencyKey` を使い、キューは先行ジョブが残る間は後続を実行しない | `dialogue/service/generation-operation.ts:65,155` / `queue/service/runner.ts:380` |
| サブエージェントの推論 | 調査担当・操作担当とも `captureControlInTransaction`。接続を LARM 限定、`mode='control'`・`context_policy='exact'` に固定。Claude には到達しない | `inference/service/index.ts:346` / `agent-runtime/service/step-handler.ts:126` / `dialogue/service/toolchain-command.ts:212` |
| 調査担当の文脈 | 各 step で全体を組み直す。残り時間・残り呼び出し回数・`canInvoke`・修正情報、根拠の利用不能化、検証フェーズ専用の指示・報告候補・出力形式を更新する | `agent-runtime/service/context.ts:210` / `evidence-catalog.ts:37` / `requirement-verification.ts:68` |
| 背景処理の経路 | `captureBackgroundControlInTransaction` は `route` を受ける。World 整理は専用リソースを指定し、使用不能なら会話用経路へ戻す | `steward/service/unit-prepare.ts:39` / `inference/service/background-control.ts:77` |
| 忘却の後処理 | `memory.registerForgetPurge(hook)` は忘却のトランザクション内と起動時の再適用で走る | `memory/service/index.ts:511` / `memory/service/forget.ts:288` |
| 文脈長の安全弁 | `fitMessages` は `contextPolicy: "exact"` の要求では削らない。会話生成は exact のため、超過は `context_window_exceeded` | `inference/service/cloud.ts:30` |
| セッション役割 | `callOptions.sessionRole: "main" \| "auxiliary"` を**呼び出しごと**に設定。現状は inference が `mode` から推定 | `larm/contracts/index.ts:60` / `inference/service/execute.ts:334` |

## 3. 設計方針

1. **課金経路は利用者の明示操作でのみ切り替わる。** 自動の経路変更が課金経路をまたぐことを、設定検証と実行時の両方で禁止する（§4.1・§4.7）。
2. **1 回の SDK 呼び出しには 1 種類の認証情報だけを渡し、モデル送信前に経路を検証する。**（§4.2）
3. **SDK に読み込ませる履歴は、毎回 Eumenes の正本から組み立てる。** SDK が書き出した生の記録は履歴として保存しない。修正用入力・後処理前の回答・通知・ターン限定情報・ツール呼び出しで終わった試行は、正本に存在しないので履歴に現れない。
4. **SessionID は固定し、中身は正本に従う。** 接続 × 認証 × モデル（サブエージェントはタスク）ごとに ID を一つ発行して使い続ける。正本の変化（要約・drop・忘却・失効）は次回の組み立てに反映され、ID は変えない。
5. **忘却は、実行中の試行の中止と一時領域の削除で即時に反映する。** 休眠中のセッションには履歴の本文を保存しないため、消すべきものが残らない（§4.6）。
6. **非同期のツール実行機構（settle・キュー・採用）は変えない。**（§4.8）
7. **出力形式（`mode`）とセッション寿命（`sessionRole`）を別の軸とし、役割は試行（attempt）単位で扱う。**（§4.4）
8. モデル名・プロファイル名をコード・既定値・手順に書かない。

## 4. 設計詳細

### 4.1 設定（settings domain）

- `connectionSchema` に `auth: "subscription" | "api-key"` を追加し、`claude-agent-sdk` では必須とする。
  - `api-key`: 暗号化キーと `baseUrl` が必須。`envRef` は従来規則どおり。
  - `subscription`: API キー・`envRef` を持てない。`claude setup-token` で発行した OAuth トークンを設定画面から入力して暗号化保存し、実行時に `CLAUDE_CODE_OAUTH_TOKEN` として渡す。**［要決定 D2］**
- キー有無による暗黙の切替を廃止する。既存の `claude-agent-sdk` 接続は一度だけ移行する（キーあり → `api-key`、なし → `subscription`）。互換コードは残さない。
- 課金経路の比較関数 `billingPath(connection)`（`larm` / `subscription` / `api-key` / その他クラウド）を settings に置き、設定検証と実行時の経路決定（§4.7）が共有する。
- 設定検証: `routes.llm` の代替先と主経路が異なる課金経路のクラウド接続になる組を拒否する。World 整理の専用リソースとサブエージェント用リソース（§4.4）は保存を許し、実行時に課金経路をまたいで戻さない（§4.7）。
- 設定画面は `settings.bundle.json` を改訂して `auth` の選択欄と資格情報欄を追加する（`docs/toolchain-extension.md` の手順）。
- `claude-managed-agents`: 削除を推奨。**［要決定 D3］**

### 4.2 SDK 実行の認証分離と送信前検証（inference adapter）

- 認証方式ごとの env:
  - `api-key`: `ANTHROPIC_API_KEY`・`ANTHROPIC_BASE_URL` のみ。
  - `subscription`: `CLAUDE_CODE_OAUTH_TOKEN` のみ。
  - 共通: `ANTHROPIC_AUTH_TOKEN`・クラウドプロバイダー系変数・環境の `CLAUDE_CONFIG_DIR` は渡さない。`CLAUDE_CONFIG_DIR` は呼び出しごとの一時ディレクトリ、`CLAUDE_CODE_PROJECT_DIR_NAME` は §4.5 の固定名。
- 資格情報が無い接続は実行前にエラー（`cloud_credential_unavailable`）。ログインへのフォールバック経路は削除する。
- 送信前検証: プロンプトを AsyncIterable で渡し、最初のユーザーメッセージを流す前に `initializationResult()` / `accountInfo()` を取得して判定する。不一致ならメッセージを流さずに `close()` し `cloud_agent_auth_mismatch`。判定は渡した資格情報の種類と観測値の組で行う:

  | 認証方式 | 渡した資格情報 | 期待する観測値（V4 で確定） |
  |---|---|---|
  | `api-key` | `ANTHROPIC_API_KEY` のみ | `apiKeySource === "ANTHROPIC_API_KEY"`、`apiProvider` が `firstParty`（独自エンドポイントは V4 で確認した値） |
  | `subscription` | `CLAUDE_CODE_OAUTH_TOKEN` のみ | `apiKeySource === "none"`、`apiProvider === "firstParty"`、`tokenSource` が環境変数の OAuth トークンを示す値、`subscriptionType` が存在 |

  `oauth` は判定に使わず、`none` は単独では許可条件にしない。
- JSONL ログに接続 ID・`auth`・観測値・`sessionRole`・SessionID・attemptId を記録する。資格情報・会話本文は記録しない。
- 利用量に `cache_read_input_tokens`・`cache_creation_input_tokens`、`api-key` では `total_cost_usd` を追加する。
- `CLAUDE_AGENT_SDK_CLIENT_APP: "eumenes"` は両経路で維持する。

### 4.3 モデル一覧 API（inference domain の公開操作）

- `GET /api/inference/connections/:id/models` を新設する。Web と CLI はこの API のみを使う。
  - `api-key`: `@anthropic-ai/sdk` の `models.list()`（保存済みエンドポイント・キー、`anthropicFetch` でヘッダーを絞る）。`max_input_tokens` から文脈長を設定する。
  - `subscription`: プロンプトを流さない `query()` で `supportedModels()`・`accountInfo()` を取得して即 `close()`。文脈長は初回ターンの `result.modelUsage[model].contextWindow` から学習して inference に保存し、学習前は安全側の値で扱う。
- 同 API を接続テストにも使う。一覧は短い TTL でキャッシュし、設定画面に再取得操作を置く。
- `agentModelCatalog`・`registerCatalogModel` を削除し、取得結果からリソースを登録する。

### 4.4 出力形式・セッション寿命・接続選択の分離

| 軸 | 値 | 単位 |
|---|---|---|
| `mode`（既存） | `answer` / `control` | リクエスト（出力契約） |
| `sessionRole`（拡張） | `main` / `subagent` / `auxiliary` | **呼び出し（attempt）ごと**。既存の `callOptions.sessionRole` を使い、inference の attempt 行に保存する |

| `sessionRole` | 使う呼び出し | セッション |
|---|---|---|
| `main` | dialogue の本回答の生成（修正の再推論を含む） | §4.5 の固定 SessionID で再開。履歴は Window から組み立て |
| `subagent` | 調査担当・操作担当などのタスク。`taskId` 必須 | §4.9 |
| `auxiliary` | 機能選択・回答の見直し・背景の制御など 1 回で終わる呼び出し | 毎回使い捨て（`persistSession: false`） |

- 同じ `requestId` の中で、機能選択の呼び出しは `auxiliary`、本回答の生成は `main` を指定する（`generation-handler.ts:171,217`）。`execute.ts:334` の `mode` からの推定は廃止する。
- attempt 行に `session_role`・`sdk_session_id` を保存し、Receipt の `attemptId` から、どの SDK 呼び出しが採用されたかを辿れるようにする（記録・監査用。履歴の組み立てには使わない）。
- 検証: `main` は dialogue の本回答生成からのみ、`subagent` は `taskId` 必須。`control` × `subagent` を許す。
- タスクの接続選択: `captureControlInTransaction` に `route`（`larm-only` / `{ resourceId }`、`captureBackgroundControlInTransaction` と同じ形）を追加する。既定は `larm-only`（現行を維持）。settings に `subagentResourceId: uuid | null` を追加し、調査担当・操作担当は `sessionRole: "subagent"`・`taskId`・`route` を渡す。`engine: "codex_luna"` はそのまま。
- LARM では当面 `subagent` を `auxiliary` と同じ独立接続で扱う。

### 4.5 会話エージェントのセッション（`main`）: 正本から組み立てる履歴

#### 基本

- 台帳 `agent_sessions`（単一 writer）は**履歴の本文を持たない**。列: `role`・`task_id`・`connection_id`・`auth`・`model`・`sdk_session_id`・`learned_context_window`・`created_at`・`updated_at`。
- 組み合わせを初めて使うときにホストが UUID を発行し、以後その組み合わせでは同じ ID で `resume` する。
- inference は `SessionStore` を実装し、`query()` に渡す:
  - `load(key)`: その呼び出しのために dialogue が渡した「正本の履歴」（下記）を SDK の記録エントリ形式に変換して返す。
  - `append(key, entries)`: 何も保存しない（受け取って捨てる）。SDK が書く生の記録は、修正用入力・後処理前の回答・通知・ターン限定情報を含むため正本にしない。保存しないので `mirror_error` による欠落も採用に影響しない。
  - `delete(key)`: 台帳の行を消す（本文は元から無い）。
- `CLAUDE_CONFIG_DIR` は呼び出しごとの一時ディレクトリ、`CLAUDE_CODE_PROJECT_DIR_NAME` は `eumenes-main`（`:` を使わない固定名）。呼び出し終了時に一時ディレクトリを削除する（異常終了分は起動時に回収）。

#### 正本の履歴と送信内容

dialogue の context-compiler が組み立てる各層を、次のように振り分ける。

| 層 | 渡し先 | 備考 |
|---|---|---|
| `system`・`longTerm`・`goals` | `systemPrompt` | 版が変わったときだけ変化（そのターンはキャッシュ不一致） |
| `history(keep)`・`unprocessed` の採用済みやり取り | **`load` が返す履歴**（user＝保存済みの発言本文、assistant＝保存済みの採用回答本文） | 会話台帳に保存された本文をそのまま使う。後処理後の回答・取り下げ・忘却・drop・要約が反映済み |
| `working`（要約・短期記憶）・通知・prefetch・今回の入力 | 今回の user メッセージ | ターン限定。履歴に保存されないので、次回は Window の最新状態で作り直される |
| 修正処理の `UNTRUSTED_REJECTED_OUTPUT` | 修正試行の user メッセージ | 同上。正本に入らない |

- 送信される順序は `system → 履歴 → working・通知・prefetch・入力` となり、現行の組み立て順と一致する。
- Window への追記だけが起きている間は、履歴の先頭部分が前回と同一になり、キャッシュが効く（前回の送信のうち、直前のターンの user メッセージだけは今回の履歴の形と異なるため、キャッシュ一致は「前々回までの履歴」まで）。
- 要約・drop・忘却・失効で正本が変わったときは、変わった位置以降がキャッシュ不一致になる。SessionID は変えない。
- 使用トークンが Window の予算を超える場合は、Window 側の要約・drop に任せる（SDK 側で作り直さない）。Claude Code の自動要約は無効化する（`settings` の `autoCompactEnabled: false`。※V2）。
- 修正の再推論（同じ run の 2 回目以降の `main` 試行）も同じ履歴を `load` で受け取り、修正用入力は今回の user メッセージにだけ入る。

#### 採用

- 履歴は会話台帳から組み立てるため、SDK 側の「採用」操作は不要。dialogue が回答を会話台帳へ保存した時点で、次回の `load` に反映される。
- 選択時の自然文・修正前の出力・取消・ツール呼び出しで終わった試行・後処理で変わった部分は、会話台帳に無いので履歴に現れない。

### 4.6 忘却・失効

- 履歴の本文を保存しないため、休眠中のセッションに対して消去すべき内容は無い。次回の `load` は Window（忘却済み）から組み立てられる。
- 実行中の試行: attempt の開始時に、その試行へ渡した参照（会話メッセージ ID、記憶の item ID、prefetch の pin）を attempt 行に記録する。api/application 層で `memory.registerForgetPurge` に inference の公開操作 `revokeAgentAttemptsInTransaction(db, { messageIds, itemIds })` を接続し、該当する実行中の試行を失効させる。失効した試行は:
  - 中止（abort）して子プロセスを終了させ、一時 `CLAUDE_CONFIG_DIR` を削除する。
  - 採用されない（既存の「取消後に古い結果を採用しない」規則と同じ扱い。Receipt 検証で拒否）。
- 起動時の再適用では、該当する実行中の試行は存在しないため冪等。
- 通知・短期記憶の失効は、ターン限定層が履歴に入らないため追加の処理は不要。

### 4.7 経路決定と課金経路の制約

- 実行時の経路決定（`background-control.ts`・`execute.ts` の代替処理）で、自動の経路変更が課金経路をまたぐ場合は変更しない。
  - 専用リソース（World 整理・サブエージェント）が使用不能のとき、会話用経路と課金経路が同じ場合だけ会話用経路へ戻す。異なる場合は `larm-only` に落とし、`route_billing_mismatch` をログに残す。
  - `routes.llm` の代替先も同じ比較を通す。
- 既存の代替動作の試験は、課金経路が同じ場合の期待値として残し、異なる場合の試験を追加する。期待値を変える理由は §3-1。

### 4.8 ツール呼び出しと非同期実行

- SDK のターンはツール呼び出しで終える（現行どおり捕捉して中断）。その試行の生の記録は保存されない（§4.5 の `append` は捨てる）。
- 呼び出しの受付は既存の `settleConversationOperation` → キュー登録 → 採用の流れのまま。
- 操作の結果が会話に戻って回答が採用されると、その回答が会話台帳に入り、次回の `load` の履歴に現れる。
- MCP ハンドラー内でホスト側ツールを実行して待つ方式（改訂1の案 A）は採らない（会話の `concurrencyKey` によりキューが後続を実行せず、相互待ちになるため）。

### 4.9 サブエージェント（`subagent`）

- 段階 1（初期仕様）: `sessionRole: "subagent"` と `taskId` を渡し、接続選択（§4.4）・ログ・課金経路の制約を適用する。履歴は持たず、各 step はタスク側が組み立てた全文脈を今回の user メッセージとして送る（現行の文脈組み立てを変えない）。SessionID はタスクごとに一つ発行し、`load` は空の履歴を返す。
- 段階 2（後続）: agent-runtime が文脈を次の二つに分けて渡す契約を定め、`load` の履歴に資料を載せる。
  - **現在状態**（毎 step 今回の user メッセージで送る）: 残り時間・残り呼び出し回数・`canInvoke`・修正情報・フェーズ専用の指示と出力形式・報告候補・根拠の利用可否。
  - **資料**（履歴として再送）: 採用済みの step 出力と、利用可能な根拠の本文。利用不能になった根拠は履歴から外す（その位置以降はキャッシュ不一致）。
- `releaseTaskSession(taskId)` をタスク側が結果報告時に呼び、台帳の行を削除する。呼び忘れ・異常終了は期限切れの掃除で回収する。次のタスクには持ち越さない。

### 4.10 チャット画面の SelectBox（Web）

- `ConversationPanel` の会話状態表示の左上に、モデルラベルの代わりに SelectBox を置く。接続ごとにグループ化し（例: LARM / Claude（サブスク）/ Claude（API）/ Codex）、グループ名に課金経路を明示する。
- 選択で即座に `routes.llm` を保存（既存 `useConversationModel().select`）。次の発言から適用。応答中は無効化。
- 現在の経路と直近ターンの実経路（§4.2 の観測値）をツールチップ等で表示する。
- 切り替えると別の組み合わせの SessionID に移り、戻せば以前の ID で再開する。履歴はどちらも同じ正本から組み立てるため、切替前後で会話の内容は一致する。モデル切替直後の 1 ターンはキャッシュ不一致（モデル単位の分離のため不可避）。

## 5. 実装フェーズ

| # | 内容 | 主な対象 | 依存 |
|---|---|---|---|
| P0 | SDK 挙動の事前検証（§6） | 検証スクリプト（scratch、コミットしない） | なし |
| P1 | 設定: `auth`・`setup-token`・`subagentResourceId`・`billingPath`・検証・移行・bundle 改訂・Managed Agents 削除（D3） | settings / capabilities bundle / `api/application/settings-structures.ts` / Web settings | P0 |
| P2 | アダプター: 認証分離、送信前検証、利用量拡張、ログイン経路削除 | `inference/adapters/cloud-agents.ts` / `inference/service/cloud.ts` | P1 |
| P3 | モデル一覧 API・接続テスト・`agentModelCatalog` 削除 | inference controller/service、Web settings | P2 |
| P4 | `mode` と `sessionRole` の分離（attempt 単位）、`captureControlInTransaction` の `route`、経路決定の課金経路制約 | inference execute / background-control、larm contracts、agent-runtime、dialogue | P1 |
| P5 | `main` セッション: 台帳、SessionStore（`load` で正本から組み立て・`append` は破棄）、層の振り分け、dialogue からの正本履歴の受け渡し | inference / dialogue | P0, P4 |
| P6 | 忘却時の実行中試行の失効（api/application で forget purge 接続） | inference / api/application | P5 |
| P7 | `subagent` 段階 1 と `releaseTaskSession`・掃除 | inference / agent-runtime / dialogue（操作担当） | P4 |
| P8 | チャット画面 SelectBox | `web/src/workspace/ConversationPanel.tsx` / `web/src/domains/settings` | P3 |
| P9 | 文書更新（`docs/settings.md`・`docs/logging.md` 等） | docs | 全体 |
| P10 | `subagent` 段階 2（現在状態と資料の分離） | agent-runtime / inference | P7（別計画で詳細化） |

## 6. 事前検証（P0）

| ID | 検証内容 | 結果による分岐 |
|---|---|---|
| V1 | **組み立てた記録の受理**: 実際の SDK 実行で書かれるエントリ形式を採取し、同じ形式で組み立てた user/assistant エントリを `load` で返したとき、`resume` が同じ SessionID で続き、モデルに送られる messages がその履歴＋今回の入力になるか（`append` を捨てても次回の `load` で問題ないか） | 受理されなければ §4.5 は成立しない。その場合は `main` も履歴なし（今回の user メッセージに全文脈）とし、キャッシュは system 部分のみとする |
| V2 | `settings` の `autoCompactEnabled: false` が効くか | 効かなければ Window の予算を SDK の自動要約の閾値より十分小さく保つ |
| V3 | `CLAUDE_CODE_PROJECT_DIR_NAME=eumenes-main` と一時 `CLAUDE_CONFIG_DIR` で、`load` に届く `projectKey` が固定になり、cwd を毎回変えても同じになるか。ローカル写しが一時ディレクトリ以外に残らないか | 固定にならなければ store 内で SDK のキーを sessionId だけで引く |
| V4 | 各認証方式で `accountInfo()` の観測値が経路を**識別できるか**（重ならないこと、資格情報の混在を検知できること） | §4.2 の判定表を確定。識別できない項目は判定から外し、資格情報の構成側の保証を強める |
| V5 | ストリーミング入力で最初のメッセージを流す前に `initializationResult()` / `accountInfo()` が得られ、その時点でモデル送信が起きていないか | 送信が先行するなら、送信前検証をプロンプトなしの事前 `query()` で行う |
| V6 | 組み立てた履歴（thinking ブロックを含まない assistant エントリ）で再開したとき、API 側の履歴編集検査・thinking の扱いでエラーにならないか | エラーになる場合は assistant エントリの形式を V1 の採取結果に合わせて調整、不可なら V1 の分岐に従う |
| V7 | 連続 3 ターンで、2 ターン目以降に `cache_read_input_tokens` が履歴部分に相当する量だけ出るか | 出なければ組み立て順・エントリ形式を見直す |

## 7. 検証計画

- fixture（`bun run verify -- --domain settings` / `--domain inference` / `--domain dialogue` / `--domain agent-runtime` / `--domain steward` 等、影響する利用側 domain も選択）
  - 設定スキーマ・移行・課金経路の比較・経路またぎの拒否
  - アダプターの env 構成、送信前検証（不一致時にメッセージを流さないこと）
  - モデル一覧の正規化
  - `sessionRole` の attempt 単位の保存、同じ request 内で選択＝`auxiliary`・本回答＝`main`
  - `route` による接続選択（既定 LARM 限定の維持）、背景・代替経路の課金経路制約
  - `load` の組み立て: 層の振り分け、後処理後の回答本文が履歴に入ること、修正用入力・通知・選択時の自然文・ツール呼び出し試行が履歴に入らないこと（既存の `memory-integration.test.ts:285` の期待値を SDK 経路でも満たすこと）
  - `append` を保存しないこと
  - 忘却: 実行中試行の失効・中止・一時領域削除・不採用、起動時再適用の冪等性
  - `subagent` 段階 1: 接続選択・SessionID の発行と破棄・期限切れ掃除
- live（保存済み接続を使用）
  - 両経路でモデル一覧取得と 1 往復、送信前検証の観測値
  - `main` で同一接続 3 往復し、キャッシュ読み取り量が履歴に相当すること（V7）
  - 接続 A → B → A の切替で、A に戻ったとき同じ SessionID で再開し、会話内容が一致すること
- E2E（対象試験ファイルを明示して個別実行）: SelectBox の切替と応答中の無効化
- fixture / live / 実機受入の結果は分けて記録する。

## 8. 要決定事項

| ID | 内容 | 推奨 |
|---|---|---|
| D1 | ツール呼び出しの扱い | §4.8（ターンはツール呼び出しで終え、結果は後続の採用済み回答として正本に入る） |
| D2 | サブスク側の認証（`setup-token` を設定画面で暗号化保存 / 既存 `~/.claude` ログイン） | `setup-token` |
| D3 | `claude-managed-agents` の削除 | 削除 |
| D4 | `codex-sdk` も同方針にそろえるか | そろえる |
| D5 | サブエージェントの接続選択を `subagentResourceId` 一つにするか、調査担当・操作担当で分けるか | 一つ |
| D6 | サブエージェントの初期仕様を段階 1（履歴なし）とし、段階 2 を別計画にするか | 段階 1 で開始 |

## 9. リスク・未解決点

- **§4.5 は SDK の文書化されていない利用に依存する。** `SessionStore` の契約は「`load` は `append` されたものと deep-equal を返す」であり、Eumenes が組み立てたエントリを返すことは契約の外にある。V1・V6 で受理を確認し、SDK の版を固定して、エントリ形式の golden 試験で版上げ時に検知する。受理されない・壊れた場合は V1 の分岐（履歴なし）へ戻す。
- 直前ターンの user メッセージは「ターン限定層＋入力」で送られ、次回は「入力のみ」として履歴に入るため、毎ターン直前の 1 往復分はキャッシュに一致しない。
- `goals` を `systemPrompt` に入れるため、目標の更新のたびに全体がキャッシュ不一致になる。頻度を live で観測し、必要なら tail 側へ移す（現行の組み立て順の変更を伴うため別途判断）。
- サブエージェントの段階 2 は agent-runtime の文脈組み立ての分割を伴い、現在状態の欠落（根拠の失効・フェーズ変更・契約凍結）を起こさない契約が必要。

## 10. 改訂履歴

### 改訂3（2026-10-15）: Astra 再レビュー対応

| 指摘 | 対応 |
|---|---|
| 1. `projectKey` の `eumenes:main` は SDK の検証を通らず cwd 由来になる | §4.5 で `CLAUDE_CODE_PROJECT_DIR_NAME=eumenes-main`（`:` なし）を `CLAUDE_CONFIG_DIR` と併用。V3 で固定化を確認、不可なら store 内で sessionId のみで引く |
| 2. `sessionRole` の保存単位が request で、選択と本回答が同じ requestId | §4.4 で役割を attempt 単位に変更（既存の `callOptions.sessionRole`）。attempt 行に SessionID を保存し Receipt の `attemptId` と対応付け |
| 3. 成功試行を残すと修正用入力・後処理前の回答が履歴に残る | §4.5 で生の記録を保存せず、`load` は会話台帳の保存済み本文から毎回組み立てる方式に変更 |
| 4. `append` は best-effort で、欠落したセッションを採用しうる | `append` は保存しない（§4.5）。履歴の正本は会話台帳なので、保存失敗は採用条件に関係しない |
| 5. 忘却後に実行中の `append` が書き戻せる | `append` は保存しない。実行中の試行は attempt 開始時の参照で失効・中止・一時領域削除（§4.6） |
| 6. 調査担当へ追加分だけ送ると現在状態が欠落する | §4.9 で段階 1（履歴なし・全文脈を毎回送る）を初期仕様に確定。段階 2 で「現在状態」と「資料」を分ける契約を別計画化 |
| 7. 通知を履歴に残すのは現行の「一度だけ」と異なる | 通知はターン限定層として今回の user メッセージにだけ入り、履歴に入らない（§4.5）。既存結合試験の期待値を SDK 経路でも検証（§7） |

### 改訂2（2026-10-15）: Astra レビュー対応

サブエージェント経路（`mode` と `sessionRole` の分離、`route`、`subagentResourceId`）、試行と採用の台帳、`registerForgetPurge` への接続、案 A の撤回、`accountInfo()` を含む送信前検証、`billingPath` による経路制約、`fitMessages` の条件を追記。改訂3で、試行・採用・巻き戻しの台帳は「正本から組み立てる履歴」に置き換えた。

### 改訂1（2026-10-15）

初版。
