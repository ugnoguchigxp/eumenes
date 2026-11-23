# 会話コンテキストのキャッシュ最優先4層構成・圧縮要約エリア・長期履歴参照の実装計画書

- 日付: 2026-11-22（第2版: 実コード照合レビュー反映済み）
- 状態: Phase 1〜3 実装済み・fixture 検証済み・CLI live 25往復検証済み（[context-window-cache-live-2026-11-23.md](verification/context-window-cache-live-2026-11-23.md)）。実機器受入は未実施
- 前提・完了済み事項:
  - 2026-11-22 実施の「SystemContext 圧縮＋全 19 ツール常時 KV 固定化」は実装・fixture 検証・live 5 ターン検証済み（`tools:4,162 + system:3,007 = 7,169 tok`、実測キャッシュヒット率 85.5〜95.0%）。
- 位置付け:
  - [context-window-layout-spec-2026-10-25.md](context-window-layout-spec-2026-10-25.md)、[conversation-toolcall-reliability-design-2026-10-27.md](conversation-toolcall-reliability-design-2026-10-27.md)、[conversation-read-tools-design-2026-10-31.md](conversation-read-tools-design-2026-10-31.md)、[codex-input-cache-structure-2026-11-12.md](codex-input-cache-structure-2026-11-12.md) の延長線上で、**会話履歴＋ツール閲覧/実施結果の短期保持と圧縮要約（`## Summary`）**、および **圧縮後に古い記録を掘り出す長期参照（`read_agents` / `read_history`）** の 2 層記憶を確立する。
- 対象 domain: `conversation`, `dialogue`, `capabilities`, `memory`（provenance・忘却連携）, `inference`（保護交換境界の検証）, `application`（配線・要約背景ジョブ）

---

## 1. 課題と設計目標

### 1.1 現状の構造的課題

2026-11-22 の本番会話調査および実コード確認により、以下の 4 点が判明している。

1. **スライディングウィンドウ（`users: 2`）による即忘却と KV キャッシュ破壊**
   - [conversation-input.ts](../api/domains/dialogue/service/conversation-input.ts) には `ConversationCut`（固定カット）の仕組みがあるが、[harness.ts](../api/domains/dialogue/service/harness.ts) の `localHarness.history.users = 2` が毎ターン直近 2 ユーザー発話のみを切り出す。
   - 3 ターン目以降は毎ターン先頭メッセージが変化するため、会話履歴部分の `input_cache` がヒットせず、2 発話より前の文脈も即失われる。
2. **ツール閲覧・実施結果の即クリア**
   - [tool-exchange.ts](../api/domains/dialogue/service/tool-exchange.ts) の保存対象（`CARRIED`）は `AGENDA_TOOLS`（4 本）と `find_toolchain` / `delegate` / `ask` のみで、閲覧系（`read_memory`, `read_history`, `read_runs`, `read_agents`, `read_world`, `lookup_public_information`）、Goal 系（`list_goals` 等）、作業制御系（`work`, `memory` 等）は 1 ターンで消滅する。
   - さらに `recentMessages()` が `agendaCalls(u)` で絞るため、DB に保存済みの `find_toolchain` / `delegate` すら次ターンのプロンプトからは落ちている。
3. **圧縮時の文脈・作業記憶の喪失**
   - カットが発生すると古い会話とツール利用経緯がまとめて消え、直近 4 発話（`RECENT.keep`）以外を引き継ぐ要約エリアが存在しない。
4. **カット後の長期参照ツールの死角**
   - `read_agents`（[executor-read.ts](../api/domains/dialogue/service/executor-read.ts)）は直近 20 run のみ走査し、`dialogue_work`（TODO・依頼本文・成果物結果）を参照しないため、過去の制作依頼の条件が引けない。
   - `read_history`（[history-scan.ts](../api/domains/conversation/service/history-scan.ts)）は単一文字列の完全一致（`text.indexOf(query)`）のみで、複数語・表記ゆれ・部分一致に弱く、該当なしになりやすい。

### 1.2 設計目標

- **キャッシュ最優先（Append-Only）**: 圧縮点に達するまでは、過去の会話とツール閲覧/実施結果を 1 バイトも書き換えずに追記し続け、`input_cache` ヒット率と応答速度を最大化する。
- **4 層コンテキスト構造**: 「整理できない生の会話・ツール履歴」は圧縮時に消える揮発エリアとし、その直前に **要約保持エリア（`## Summary`）** を置いて圧縮時に内容を統合要約して保存する。
- **応答待ち時間ゼロの圧縮**: Soft / Hard の 2 段階閾値により、裏（バックグラウンド）で先行要約を準備しておき、Hard 閾値到達時に 0ms で差し替える。
- **忘却（Forgetting）契約の完全維持**: 閲覧ツール結果と要約の両方に元データの `provenance`（`ReferenceInput`）を紐づけ、発言・記憶・World いずれの忘却でも即座に無効化する。
- **2 層記憶の完成**: 圧縮前は KV キャッシュ上の生データで即答し、圧縮後は `## Summary` ＋ 改善した `read_agents` / `read_history` で確実に追跡できる状態にする。

---

## 2. コンテキストの 4 層レイアウト（`input_cache` 構造）

1 回の会話モデル呼び出しの入力を、変化しにくい順に次の 4 層へ整理する。

```text
┌────────────────────────────────────────────────────────────────┐
│ [1] 固定プレフィックス（常時不変・KV キャッシュ 100%）            │
│     Tools（全19ツール静的） + SystemContext（圧縮済み）           │
├────────────────────────────────────────────────────────────────┤
│ [2] 準固定エリア（圧縮点まで不変・圧縮時/忘却時のみ更新）          │
│     `messages[1]` の先頭ブロックとして固定:                      │
│     ・## Memory（長期: 利用者の傾向・制約）                       │
│     ・## Summary（中期・新設: 圧縮された会話＋ツール利用の要約）   │
├────────────────────────────────────────────────────────────────┤
│ [3] 作業エリア（短期・圧縮時に消える揮発エリア / Append-Only）     │
│     直近の会話 ＋ ツール呼出＆閲覧・実施結果（不変スナップショット）│
│     [User] → [Assistant(tool_calls)] → [Tool(result)] → [Asst]  │
│     ※ 圧縮点までは先頭も中身も一切変更しない                      │
├────────────────────────────────────────────────────────────────┤
│ [4] 今回ターン専用エリア（毎ターン末尾・ここだけ非キャッシュ）      │
│     最新ユーザー発話 ＋ ## State / ## Agency（現在時刻・最新状態） │
└────────────────────────────────────────────────────────────────┘
```

### 2.1 `[2] 準固定エリア` のメッセージ配置と `protectedCount` 整合

- **既存不変条件の維持**: [generation-prepare.ts](../api/domains/dialogue/service/generation-prepare.ts#L75-L95) の `answerSessionContext()` および [cloud.ts](../api/domains/inference/service/cloud.ts#L101-L126) の `fitMessages()` は、`messages[1]` が `## Memory` で始まり、先頭 `protectedCount` 件が窓超過トリムから保護される前提になっている。
- **`## Memory` と `## Summary` の同居配置**: `## Memory` の直下に `## Summary`（`active` 要約が存在するときのみ）を結合して先頭ブロック（`messages[1]`）に配置する。これにより `messages[1].content.startsWith("## Memory")` の既存契約を保ったまま、両方を確実にトリムから保護できる。
- **重要修正（`tool_calls` + `tool` の孤児防止）**: 現行の `answerSessionContext()` は `messages[2]` が `assistant` のとき `protectedCount = 2` を固定で返す。ツール履歴保持により `messages[2]` が `assistant(tool_calls)`、`messages[3]` が `tool(result)`、`messages[4]` が `assistant(reply)` となる場合、`protectedCount = 2` のままだと `fitMessages()` が `messages[3]`（`tool`）だけを削除して **プロバイダ HTTP 400（孤児 `tool` / 応答欠落 `tool_calls`）** を引き起こす。
  - **対策**: `answerSessionContext()` で `holdsMemory` の後に続く 1 交換全体の長さを既存の `exchangeEnd()`（[context-budget.ts](../api/infrastructure/context-budget.ts#L174-L182)）で算出し、`assistant(tool_calls)` + `tool*` + `assistant(reply)` を不可分の 1 単位として `protectedCount` に含める。
- **`## Memory` の途中更新とキャッシュ保護**: 現行 [conversation-input.ts](../api/domains/dialogue/service/conversation-input.ts#L310-L312) では、通常の記憶追加は `window.newMemories` に保留され、カット時の `republishWindowInTransaction` まで `window.profile.items`（＝`memoryDigest`）へは反映されない仕組みになっている。したがって `memoryDigest` が途中で変わるのは外部からの強制 `republish`（忘却・明示訂正・手動記憶変更）のときに限られる。本設計ではこの仕組みを維持し、通常の新規記憶追加では途中カットが起きないことを回帰テストで明示的に保証する。

### 2.2 `[4] 今回ターン専用エリア` との境界

- `## State` / `## Agency` は常に `[4]`（最新ターンの末尾）のみに付与し、確定した過去ターンの `user` メッセージには残さない。
- Turn $t+1$ では Turn $t$ の `## State` が外れた位置（直近 1 往復分）だけ再計算されるが、`[1] + [2] + [3] の Turn 1 .. t-1` はバイト単位で完全一致して `input_cache` にヒットし続ける。古い `## State` による状態誤認も起きない。

### 2.3 主会話と背景呼び出し（Steward / Agency）のハーネス分離

現行の [conversation-input.ts](../api/domains/dialogue/service/conversation-input.ts#L611-L651) では、`backgroundPrefixInTransaction()` が主会話と同じ `localHarness` を使い、`backgroundMessage()` が `{ role, content }` のみ抽出している。主会話の `localHarness` に全ツール履歴（`tool_calls` / `role: "tool"`）と 16,000 tok 枠を載せると、背景呼び出しで `tool_calls` / `tool_call_id` が剥がれて不正なメッセージ列になり、かつ背景トークンも急増する。

- **対策**:
  - **主会話用ハーネス（`conversationHarness`）**: 固定カット（`users` 未設定＝スライディング無し）、全保持ツール履歴を再送（`withCalls: true`）、`## Summary` 込み。
  - **背景呼び出し用ハーネス（`backgroundHarness`）**: 既存同等の軽量履歴（発話テキストのみ、`withCalls: false`、`users: 4` 程度、`## Summary` は共有可）とし、`backgroundMessage()` に `tool` ロールが混入しないことを型・テストで保証する。

---

## 3. 作業エリア `[3]` のツール履歴保持仕様

### 3.1 保存・再送対象の拡張（[tool-exchange.ts](../api/domains/dialogue/service/tool-exchange.ts) / [routed-turn.ts](../api/domains/dialogue/service/routed-turn.ts)）

ツール結果を書き込み時点で **1 回だけサイズ正規化（不変スナップショット化）** し、`conversation_utterances.tool_exchange_json` に保存する。`recentMessages()` は `agendaCalls(u)` の限定を外し、エポック内の保持対象ツール呼出・結果をすべて `assistant(tool_calls)` + `tool(result)` として再送する（主会話のみ）。

> [!IMPORTANT]
> **SQL 互換性制約（`latestReplyWithTool`）**: [input.ts](../api/domains/conversation/repository/input.ts#L257) の `latestReplyWithTool()` は `tool_exchange_json` の `$.result` が有効な JSON であり、`find_toolchain` の結果に `$.candidates` 配列があることを `json_extract` で参照している。したがって、**JSON を保存するツールは文字列の途中スライスを厳禁とし、必ず構造化フィールド単位で切り詰めて有効な JSON を保つ**。

| カテゴリ | 対象ツール | 保存形式と正規化ルール | 結果の上限サイズ |
| --- | --- | --- | ---: |
| **Agency メモ・準備** | `read_note`, `show_note`, `start_preparation`, `set_quiet` | 現行同等テキスト（`read_note` 本文・受付結果） | `read_note`: 4,000字<br>他: 800字 |
| **内部閲覧系** | `read_memory`, `read_history`, `read_runs`, `read_agents`, `read_world` | 返却テキストを保存。超過時は先頭抜粋＋`…（省略）` | 2,000字 |
| **Goal 系** | `list_goals`, `register_goal`, `update_goal` | 有効な JSON のまま項目単位で切り詰め（ID・件名・状態維持） | 1,500字 |
| **外部検索** | `lookup_public_information` | 有効な JSON として要旨・出典・**取得時刻 `fetchedAt`（JST）** を保存 | 1,500字 |
| **担当検索・委譲** | `find_toolchain`, `delegate`, `ask` | 現行 `carriedResult` の JSON 構造（`sources`, `candidates[]`, `todo`, `confirmation`, `answered`, `refused`）を 100% 互換維持し、各候補の `summary` 等をフィールド単位で上限切り | 1,200字 |
| **作業制御・記憶依頼** | `approve_confirmation`, `decline_confirmation`, `work`, `discard_for_pending_switch`, `memory` | 引数（各文字列 300 字上限）＋有効な JSON 結果（`status`, `todo`, `confirmation`, `work check` 抜粋） | 1,000字 |
| **除外・制限** | 診断ターゲット（`debugTarget`）、画像バイナリ | 履歴に載せない。1 ターン内のツール結果合計は最大 **6,000 字** を上限とし、超過分は後続ステップから優先して結果本文を圧縮 | 合計 6,000字 / ターン |

### 3.2 閲覧ツール結果の忘却（Provenance）追跡【必須】

現行の [executor-read.ts](../api/domains/dialogue/service/executor-read.ts#L548) は閲覧結果を保存しない前提のため、閲覧ツールが読んだレコードの出典 ID を `referenceInputs` に記録していない。そのまま `tool_exchange_json` に保存すると、後に「あの発言／あの記憶を忘れて」が実行された際に **コピーされた閲覧本文が `tool_exchange_json` と `## Summary` に残る忘却漏れ** が起きる。

- **対策**:
  1. `executor-read.ts` の各 `Found` 結果に `sources: ReferenceInput`（`read_history` → 返した `messageId` 群、`read_memory` → 返した `memory:<id>` 群、`read_runs` / `read_agents` → 参照した `run.inputMessageId` および `work.message_ids`、`read_world` → 参照した `world` エンティティ/資料参照）を添付して返す。
  2. `routed-turn.ts` がターン中に収集した全 `readSources` を `GenerationResult` 経由で `generation-settle.ts` に渡し、`memory.referenceInputs.recordRunInTransaction()` へ合流させる。
  3. 忘却時（発言・記憶・World のいずれの忘却でも）:
     - 既存の `conversationPrefixFrom` の `requireProvenance` 検証（[conversation-input.ts](../api/domains/dialogue/service/conversation-input.ts#L433-L452)）により、忘却済みソースに依存する `agent` 発話（およびその `tool_exchange_json`）は履歴から確実に除外される。
     - さらに、`retractUtterances()` / 記憶・World 忘却フックで該当 `conversation_cuts.due = 'forget'` を立て、後述の `conversation_summaries` も即時無効化する。

### 3.3 鮮度・現在状態との整合

- `lookup_public_information` のスナップショットには必ず `fetchedAt`（JST 時刻）を含める。既存ルール（「過去の結果を現在の外部状態の根拠にしない」）により、古い天気・株価等を現在値と誤認しない。
- 確認待ち（`c<ref>`）や TODO（`t<ref>`）の過去ツール結果が `[3]` に残っていても、現在状態は末尾 `[4]` の `## State` が正本であるルールを維持する。

---

## 4. 圧縮点（閾値）と圧縮要約エリア `[2] ## Summary` の動作仕様

### 4.1 閾値設計（既存 `planWindow()` 予算体系との一本化）

`localHarness.history.users: 2` のスライディングを廃止し、`ConversationCut` と既存の [context-budget.ts](../api/infrastructure/context-budget.ts)（`planWindow()` / `logTargets()`）を軸に一本化する。

履歴の消費量 `workingTokens` は **「`[3]` に含まれる発話本文 ＋ `toolCalls`（引数・結果の `estimateMessageTokens` 相当）の推定トークン合計」** で計測する。
モデル窓は既存の `windowOf(deps, tx, run.id)`（LARM 接続時は実測窓、クラウド時は `REFERENCE_WINDOW_TOKENS = 262,144`）から `planWindow()` で算出した `plan.log.cap` を上限基準としてクランプする。

| 項目 | 広窓モデル（`window >= 65,536`、256k クラス想定） | 狭窓モデル（`window < 65,536`、LARM 等） | 動作 |
| --- | --- | --- | --- |
| **Hard 閾値（圧縮実行点）** | `min(24,000, floor(plan.room * 0.35))` tok または **20 ユーザー発話** | `min(plan.log.high, floor(plan.room * 0.45))` tok または **10 ユーザー発話** | `placeCutInTransaction` で `cut.seq` を進め、`## Summary` を更新して `[3]` の古い区間を一括クリア |
| **Soft 閾値（先行要約トリガ）** | `floor(hardTokens * 0.75)`（= 18,000 tok）または **15 ユーザー発話** | `floor(hardTokens * 0.75)` または **8 ユーザー発話** | 応答完了後、裏（バックグラウンド）で圧縮対象区間の先行要約ジョブを 1 回だけ起動（ユーザー待ち 0ms） |
| **圧縮後に `[3]` へ残す量（低水位）** | 直近 **4 往復（最大 8 発話）** かつ **6,000 tok 以内** | 直近 **2 往復（最大 4 発話）** かつ `min(2,000, floor(hardTokens * 0.35))` tok 以内 | 直前文脈を切らさない最小限だけ `[3]` に残す（`assistant` 始まり回避のため既存の `keepNewestCut` 規則を踏襲） |
| **`## Summary` 上限** | **1,500 tok**（`plan.sections.episode` 以下） | **600 tok**（`plan.sections.episode` 以下） | ローリング統合要約で常に上限内に収める |
| **セッションリセット** | 無操作 **30 分**（`RECENT.gapMs`）または明示クリア | 同左 | `[3]` と `active` / `staged` の `## Summary` を一括クリア |

> [!NOTE]
> **30 分空白（`resumed`）で `## Summary` もリセットする理由**: 30 分超の空白後はプロバイダの KV キャッシュ TTL（5〜10分）が切れており、別トピックへ移ることも多い。古い話題の要約を毎ターン先頭に抱え続けるよりも、新しい会話セッションとしてクリーンに始め、前の話題を続ける場合だけ強化した `read_history` / `read_agents` で必要な文脈を引く方が精度・トークン効率ともに安定する。

### 4.2 要約保持エリア `[2] ## Summary` のフォーマット

[input-text.ts](../api/domains/dialogue/service/input-text.ts) の `INPUT_HEADINGS` に `summary: "## Summary"` を追加し、箇条書き中心の定型で保持する（外部データ由来文字は `dataText()` で無害化）。

```markdown
## Summary
対象範囲: 11-22 10:35〜10:50（圧縮済み履歴の要約。詳細は read_history / read_agents で確認可）
- 話題・合意: 鎌倉のカフェ案内ページの画像案を検討し、水彩風イラストで進める方針に決定。
- 実施ツール・成果物:
  - image.create（t436・完了）: 鎌倉の海辺のカフェを水彩風で生成（条件: 夕暮れ、江ノ電の遠景）。
  - read_memory: 七里ヶ浜・鎌倉の地域情報を把握希望、天気の調査メモは非表示の制約を確認。
- 未解決・引き継ぎ: 画像の色味をもう少し明るくする修正案を検討中。
```

- **必須抽出項目（要約プロンプト規約）**:
  1. 話題の流れ・確定した決定事項・利用者の明示条件
  2. **実施したツール・担当依頼・閲覧結果の要点**（担当名、TODO 番号 `t<ref>`、確認番号、作成した成果物や依頼条件の核心、未完了・失敗の事実）
  3. 引き継ぐべき未解決事項・次アクション
  4. **禁止事項**: 根拠のない推測を足さない、`## Memory` に既出の普遍的プロフィールを重複転記しない、古い外部情報（天気等）を現在事実として書かない。
- **ローリング統合要約**: 2 回目以降の圧縮では「既存の `active` な `## Summary` ＋ 今回 `[3]` から切り出す古い区間」をまとめて 1 つの新しい `## Summary`（上限内）へ統合する。

### 4.3 先行バックグラウンド要約とフォールバック（待ち時間 0ms・TOCTOU 対策）

1. **通常フロー（待ち時間 0ms）**:
   - Turn 終了時（`generation-settle.ts` の採用トランザクション内）に、現在の `[3]` が **Soft 閾値** を超えており、かつ現在の `cut.revision` に対して有効な `staged` 要約（または実行中/失敗済みジョブ）が存在しない場合、`dialogue` スコープのバックグラウンドジョブ `dialogue.compact_summary` を `queue` へ 1 件だけエンキューする。
     - `dedupeKey: compact:${conversationId}:${cut.revision}`
     - `maxAttempts: 1`（同一 `cut.revision` で失敗しても無限再試行しない）
     - `lane: "background"`, `subjectRef: background:compact:${conversationId}:${cut.revision}`
   - 要約ジョブは会話設定の LLM（既存の inference 経路、低思考量・最大出力 1,500 tok・タイムアウト 30 秒）で、`cut.seq < u.seq <= targetCutSeq` の発話・ツール結果と既存の `active` 要約を統合要約する。
   - **書込時の TOCTOU 検証**: 要約ジョブが `staged` を DB へ保存する単一書き込みトランザクション内で、以下をすべて再検証し、1 つでも崩れていれば棄却する:
     1. `currentCut.revision === baseCutRevision`（途中で別カットや忘却カットが起きていない）
     2. 対象区間の発話に `retracted_at IS NOT NULL` がない
     3. 収集した全 `source_refs`（発話 ID ＋ 閲覧ツールの `ReferenceInput.sources`）が `memory.referenceInputs.isCurrentInTransaction()` で有効である
   - 後続ターンで **Hard 閾値** に達したとき、`placeCutInTransaction` は同一トランザクション内で有効な `staged` 要約を `active` へ昇格させ、`cut_seq = staged.covered_through_seq` へ移動する（応答待ち **0ms**）。
2. **安全弁・フォールバック（以下のいずれかに該当する場合）**:
   - (a) Hard 到達時に `staged` 要約がまだ存在しない / 失敗していた / 忘却で無効化されていた場合
   - (b) `staged` を昇格させてもなお残存 `[3]`（`seq > staged.covered_through_seq`）が Hard 閾値を超えている場合（単発の超大型ツール連打等）
   - **動作**: ユーザーを同期 LLM 要約で待たせず、**機械的フォールバック要約（即時生成・0ms）**（切り落とす区間の「実施ツール名・`t<ref>`・依頼先頭・主要発話見出し」をルールベースで 400 tok 以内に圧縮）を `kind = 'mechanical'` として即座に `active` へ保存し、`keepNewestCut` の低水位位置まで確実に `cut_seq` を進める。

### 4.4 忘却（Forgetting）・訂正との整合性

1. **統一 Provenance 保存（`source_refs_json`）**:
   - `conversation_summaries` の各行に、要約元になった全参照元配列 `source_refs_json`（`ReferenceInput.sources` 互換: 発話 `messageId`、`memory:<id>`、閲覧ツールが参照した全ソース、および統合元 `active` 要約から引き継いだ全 `source_refs`）を保存する。
2. **忘却時の即時無効化（発言・記憶・World 全経路）**:
   - `conversation` domain の `retractUtterances()` は、`source_refs_json` に忘却対象 `messageId` を含む `active` / `staged` 要約を即座に `state = 'retracted'`, `summary_text = ''`, `retracted_at = at` へ更新し、`conversation_cuts.due = 'forget'` を立てる。
   - `memory` 項目または `world` 参照の忘却経路（`dialogue/service/agency-forgetting.ts` 相当の忘却ハンドラ）からも、`conversation.input.retractSummariesBySourceRefsInTransaction(tx, refs, at)` を呼び出し、該当 `active` / `staged` 要約を即時無効化＋`due = 'forget'` を立てる。
3. **生成中の忘却検知（採用ゲート連携）**:
   - `generation-prepare.ts` と [background-input.ts](../api/domains/dialogue/service/background-input.ts) の `shownMessageIds` / `ReferenceInput` に、`active` な `## Summary` の `source_refs` をすべて合流させる。応答生成中に要約元の発話・記憶が忘却された場合、既存の `validateMemoryWindow` / `shownMessageForgotten` で安全に不採用・再生成される。

2026-11-23 の修正で、即時の抜粋と背景要約は、通常の会話と同じ出典検査を使う。出典を追えなくなった回答は、その回答が保持するツール結果ごと圧縮対象から外す。訂正・忘却時は旧版を含め該当する要約の本文を消去し、背景推論の採用時には元発言と推論の採用可否を再検査する。更新前に作った要約は欠けた出典を復元できないため、移行 `conversation/0021-reset-unverified-summaries` で一度失効させる。元発言と履歴のカット位置は保持する。

先行要約のジョブには、会話で使った窓から算出した保持量と要約上限を渡す。Claude Agent SDK の履歴にツール交換がある場合は、画像履歴と同様に、全メッセージを役割・呼出 ID・引数・結果付きで今回の入力に含める。テキストだけの履歴では通常の再開を使う。

---

## 5. 長期参照ツールの改善（圧縮後に掘り出す層）

圧縮で `[3]` から落ち、`## Summary` にも要約しか残らない詳細（過去の制作依頼プロンプト全文や数日前の発言など）を確実に引き出せるよう、以下 2 本を同時に改善する。

### 5.1 `read_agents` の改善（[executor-read.ts](../api/domains/dialogue/service/executor-read.ts)）

- **改善内容**:
  1. `dialogue_work` の参照統合: [work.ts](../api/domains/dialogue/repository/work.ts) に読み取り専用クエリ `recentWorkForRead(db, conversationId, limit)` を追加し、`agentsFound()` が `recentRuns` だけでなく `dialogue_work`（`ref`, `toolchain_id`, `title`, `request`, `status`, `outcome`, `result_json`, `created_at`, `message_ids_json`）も時系列でマージして返せるようにする（同一 `run_id` に紐づく重複は 1 件に統合）。
  2. 忘却除外: `work.message_ids_json` のいずれかが `blocked` に含まれる行、および `forgetWork` で本文消去済みの行（`request = ''` かつ `title = ''`）は除外する。
  3. 走査上限とフィルタ拡張: `api/domains/capabilities` の `read_agents` スキーマに任意の `query?: string` と `toolchain?: string` を追加し、走査上限を 20 run → **最大 100 件（`dialogue_work` ＋ `runs`）** に拡大する。
  4. 出力形式と Provenance: 1 行ごとに `t<ref>`・日時・担当・依頼内容の要旨（`request` 最大 300 字）・状態・成果物サマリを返し、返却した行の `message_ids` / `run.inputMessageId` を §3.2 の `readSources` へ含める。

### 5.2 `read_history` の検索改善（[history-scan.ts](../api/domains/conversation/service/history-scan.ts)）

- **改善内容**:
  1. **正規化＋空白区切り AND 検索**:
     - 検索対象テキストとクエリを NFKC 正規化＋小文字化（`normalize("NFKC").toLowerCase()`）し、クエリを半角/全角空白でトークン分割して **全トークンを含むメッセージ（AND 一致）** にマッチさせる（単一語時は従来の上位互換）。
  2. **一部一致フォールバック**:
     - 複数語 AND で 0 件だった場合のみ、一致トークン数が多い順の緩和一致を最大 5 件まで返し、結果に「一部語句一致」と明示する（完全・AND 一致を最優先）。
  3. **ツール実行タグの併記**:
     - ヒットした `agent` メッセージに対応する `conversation_utterances.tool_exchange_json` がある場合、`[道具: delegate(image.create) → t436]` のような短い 1 行タグを末尾に添えて返し、会話ログからツール実行履歴も辿れるようにする。
  4. **Provenance 連携**: 返却した `view.messageId` 群を §3.2 の `readSources` へ含める。

---

## 6. データ構造・Domain 境界・変更対象ファイル

`AGENTS.md` の境界規則（下位 domain は上位 domain を参照しない・単一 writer トランザクション）を厳守する。

### 6.1 SQLite マイグレーション（`conversation` domain）

[api/domains/conversation/repository/summaries.ts](../api/domains/conversation/repository/summaries.ts) に新マイグレーション `conversation/0020-conversation-summaries`（`after: ["conversation/0019-message-displays"]`）を追加:

```sql
CREATE TABLE conversation_summaries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('staged', 'active', 'superseded', 'retracted')),
  base_cut_revision INTEGER NOT NULL,
  covered_from_seq INTEGER NOT NULL,
  covered_through_seq INTEGER NOT NULL,
  summary_text TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('llm', 'mechanical')),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  retracted_at TEXT
);
CREATE INDEX conversation_summaries_lookup
  ON conversation_summaries(conversation_id, state, base_cut_revision);
```

- **責務分離**:
  - `conversation` domain: `conversation_summaries` の永続化・読取・`staged → active` 昇格・`retractUtterances` / `retractSummariesBySourceRefs` 時の忘却無効化・セッションリセット時の `active`/`staged` 一括クリア。業務的な要約プロンプトや閾値判断は持たない。
  - `dialogue` domain: 閾値判定（Soft / Hard）、ツール結果のスナップショット正規化、閲覧ツール provenance 収集、先行要約ジョブ（`dialogue.compact_summary`）、`## Summary` を含む 4 層プレフィックスの組み立て、`read_agents` の `dialogue_work` 統合。

### 6.2 主な変更ファイル一覧

| 層 / domain | ファイル | 変更内容 |
| --- | --- | --- |
| `conversation` | [api/domains/conversation/repository/summaries.ts](../api/domains/conversation/repository/summaries.ts) / [input.ts](../api/domains/conversation/repository/input.ts) | `0020`/`0021` マイグレーション、要約 CRUD、`retractUtterances` / `retractSummariesBySourceRefs` / クリア時の `active`+`staged` 無効化 |
| `conversation` | [api/domains/conversation/contracts/input.ts](../api/domains/conversation/contracts/input.ts) | `ConversationSummary` 型定義 |
| `conversation` | [api/domains/conversation/service/history-scan.ts](../api/domains/conversation/service/history-scan.ts) | NFKC 正規化・空白分割 AND 検索・一部一致フォールバック |
| `capabilities` | `api/domains/capabilities/` (`read_agents` スキーマ) | `read_agents` に任意引数 `query`, `toolchain` を追加 |
| `dialogue` | [api/domains/dialogue/service/harness.ts](../api/domains/dialogue/service/harness.ts) | `conversationHarness`（固定カット・`withCalls: true`）と `backgroundHarness`（軽量テキストのみ・`withCalls: false`）の分離 |
| `dialogue` | [api/domains/dialogue/service/tool-exchange.ts](../api/domains/dialogue/service/tool-exchange.ts) | 全ツール種別の保存・不変スナップショット正規化（有効 JSON 維持）・サイズ上限・`fetchedAt` 付与 |
| `dialogue` | [api/domains/dialogue/service/routed-turn.ts](../api/domains/dialogue/service/routed-turn.ts) | `conversationToolPort` 実行分もすべて `exchange` へ記録し、`readSources` を収集して `GenerationOutcome` へ返却 |
| `dialogue` | [api/domains/dialogue/service/input-text.ts](../api/domains/dialogue/service/input-text.ts) | `INPUT_HEADINGS.summary = "## Summary"` 追加 |
| `dialogue` | [api/domains/dialogue/service/conversation-input.ts](../api/domains/dialogue/service/conversation-input.ts) | 発話＋ツール込みトークン計測、`planWindow()` 連動 Soft/Hard 閾値、低水位カット、`## Summary` 挿入、`recentMessages` の全保持ツール再送、背景ハーネス適用 |
| `dialogue` | `api/domains/dialogue/service/compaction-summary.ts`（新設） | 機械的フォールバック要約生成、バックグラウンド LLM 統合要約ハンドラ（`dialogue.compact_summary`、`maxAttempts: 1`、TOCTOU 検証） |
| `dialogue` | [api/domains/dialogue/service/generation-prepare.ts](../api/domains/dialogue/service/generation-prepare.ts) / [generation-settle.ts](../api/domains/dialogue/service/generation-settle.ts) | `answerSessionContext()` の `exchangeEnd` 対応、`plan` 閾値渡し、`active` 要約と `readSources` の provenance 登録、Soft 超過時の先行要約エンキュー |
| `dialogue` | [api/domains/dialogue/service/background-input.ts](../api/domains/dialogue/service/background-input.ts) / [agency-forgetting.ts](../api/domains/dialogue/service/agency-forgetting.ts) | `prefix.summarySourceRefs` の `ReferenceInput` 合流、記憶/World 忘却時の要約無効化呼び出し |
| `dialogue` | [api/domains/dialogue/repository/work.ts](../api/domains/dialogue/repository/work.ts) / [executor-read.ts](../api/domains/dialogue/service/executor-read.ts) | `read_agents` での `dialogue_work` 参照統合・100 件走査・フィルタ対応、`read_*` の `readSources` 返却、`read_history` のツール実行タグ併記 |
| SystemContext | [api/domains/dialogue/contexts/system/input.context.toml](../api/domains/dialogue/contexts/system/input.context.toml) 他 | `## Summary` の読み方（1 行追加）および要約生成用コンテキスト（`dialogue.contexts.system.compact-summary`）新設 |

---

## 7. 実装フェーズ計画

各フェーズ単位で `bun run verify` とキャッシュ実測を確認しながら段階的に進める。

### Phase 1: Append-Only 履歴＋全ツール不変スナップショット保持＋ハーネス分離
- `conversationHarness` / `backgroundHarness` を分離し、主会話の `users: 2` スライディングを廃止して `ConversationCut`（ツール結果込みトークン計測・`planWindow()` 連動の高水位/低水位カット）へ移行。
- `answerSessionContext()` の `protectedCount` を `exchangeEnd()` ベースへ修正し、ツール付き先頭交換が途中で割れないようにする。
- `tool-exchange.ts` / `routed-turn.ts` / `recentMessages` を拡張し、全ツールの閲覧・実施結果を不変スナップショット（JSON 互換維持・`fetchedAt` 付き・ターン合計上限付き）で `[3]` に保持・再送する。
- `executor-read.ts` の `readSources` 収集と `generation-settle.ts` の `referenceInputs` 登録を実装し、閲覧結果の忘却漏れを塞ぐ。
- **完了条件**: 10 ターン連続対話で過去の発言・ツール閲覧結果が保持され、Turn 2〜10 の `tools + system + Memory + 過去ターン` がバイト一致し、背景呼び出しに `tool` ロールが混入せず、忘却された閲覧元が履歴から確実に消えること（fixture 試験＋`fixed-input-size.json` 更新）。

### Phase 2: 要約保持エリア `[2] ## Summary` と先行バックグラウンド圧縮
- `conversation/0020-conversation-summaries` マイグレーションと永続化 API を実装。
- 機械的フォールバック要約＋バックグラウンド LLM 統合要約ジョブ（`dialogue.compact_summary`、`maxAttempts: 1`、TOCTOU 検証）を実装。
- `placeCutInTransaction` での `staged → active` 0ms 切替（残存超過時の安全弁含む）、30 分空白・明示クリア時の `active`+`staged` 一括リセット、発言・記憶・World 忘却時の即時無効化、`background-input.ts` / `generation-prepare.ts` の provenance 連携を実装。
- `input.context.toml` に `## Summary` の説明を追加し、`context:lint` / `context:build` / `context:check` を通す。
- **完了条件**:
  - Soft 閾値超過で先行要約が生成され、Hard 閾値到達時に 0ms で `## Summary` へ昇格＋`[3]` が低水位へ縮小すること。
  - `staged` 未完了・失敗・超過時に機械的フォールバックへ安全に降り、応答を止めないこと。
  - 要約元の発言・記憶・World のいずれかが忘却されたとき `## Summary` が即消去され、生成中の応答も不採用になること。

### Phase 3: 長期参照ツール改善（`read_agents` / `read_history`）
- `read_agents` に `dialogue_work` 統合・100 件走査・`query`/`toolchain` フィルタ・忘却除外・`readSources` 返却を追加。
- `read_history` に NFKC 正規化＋空白分割 AND 検索＋一部一致フォールバック＋ツール実行タグ併記を実装。
- **完了条件**: 圧縮・クリア後に過去の制作依頼本文や複数語クエリが `read_agents` / `read_history` で確実に取得でき、忘却済みメッセージ・仕事が一切漏れないこと。

### Phase 4: 統合検証（fixture → live 実測）
- **fixture 検証**:
  - `bun run verify -- --domain conversation --domain capabilities --domain dialogue --domain memory --domain inference`
  - 新規追加テスト:
    - Append-Only キャッシュプレフィックスのバイト一致テスト（Turn 1〜10、ツール呼出あり）
    - `answerSessionContext` + `fitMessages` のツール付き先頭交換保護テスト（孤児 `tool` ゼロ）
    - `backgroundPrefixInTransaction` の `tool` ロール非混入テスト
    - 閲覧ツール（`read_memory` / `read_history` / `read_agents`）結果の忘却連動テスト
    - 高水位 / 低水位カット＋`staged → active` 切替＋TOCTOU 棄却＋機械的フォールバックテスト
    - 発言・記憶・World 忘却時の `conversation_summaries` 即時無効化＋`shownMessageForgotten` テスト
    - `read_agents` の `dialogue_work` 取得・忘却除外、`read_history` の複数語 AND / 表記ゆれ検索テスト
- **live 検証（ユーザーによる再起動許可後）**:
  - CLI 対話モードで専用会話 ID を使い、ツール閲覧・担当検索・目標確認を挟む 12〜15 ターン連続対話を実施。
  - `api.jsonl` の `inference.input_sections` と `inference.codex_usage_updated` から、以下を実測確認する:
    1. 圧縮前の全ターンで `## Memory` ＋過去会話＋ツール結果まで `input_cache` がヒットし、ツール再実行が起きないこと。
    2. 圧縮点到達時に待ち時間なく `## Summary` へ引き継がれ、圧縮後も前の話題・ツール実施内容を把握して答えられること。
    3. 圧縮後に `read_agents` / `read_history` で古い依頼詳細が引けること。

---

## 8. 既存仕様・テストへの影響とリスク管理

| 影響箇所 | 影響内容 | 対処方針 |
| --- | --- | --- |
| `api/domains/dialogue/test/tool-exchange.test.ts` | 現行は「次ターンでは `find_toolchain` / `delegate` を描かない」前提のアサーションがある | 新仕様（エポック内は不変スナップショットとして再送）へ更新し、JSON 互換・サイズ上限・忘却除外の試験を追加 |
| `api/domains/dialogue/test/harness.test.ts` / `conversation-input.test.ts` | `users: 2` や `RECENT.hardTokens: 4000` の固定値アサーション | `conversationHarness` / `backgroundHarness` 分離および `planWindow()` 連動閾値に合わせて更新 |
| `api/domains/dialogue/test/generation-prepare.test.ts` | `protectedCount: 2` 固定アサーション | ツール無し交換は従来通り `2` を維持し、ツール付き交換では 1 交換全体が保護されるテストを追加 |
| `fixed-input-size.json` | `input.context.toml` への `## Summary` 1 行追加と `read_agents` 引数追加で +50〜80 tok 程度 | `bun run fixed-input-size -- --write` で記録更新し、増加を最小限に抑える |
| LARM ローカルモデル | 狭窓モデルで 16,000 tok 固定にすると溢れる | `planWindow()` 連動（§4.1）で自動縮小し、`plan.log.cap` を必ず下回るようにする |
| コンテキストウィンドウ検査 UI | デバッグ表示で `## Summary` の出典（`InputOrigin`）を表示 | `InputOrigin` に `kind: "summary"` を追加し、検査 UI でも由来を追跡可能にする |
