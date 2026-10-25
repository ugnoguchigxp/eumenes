# Agency 統合スパイク設計（2026-10-22）

**状態: 利用者の合意済み（2026-10-22、実装開始）。2026-10-25 に [会話エージェントを agency に置き換える設計](agency-conversation-agent-design-2026-10-25.md) で改めた: agency は唯一の会話エージェント（返答・自発発話・TODOの報告）で常に動き、設定 `agency.enabled`・`agency.resourceId` は削除、推論は Eumenes に設定された会話のLLM。以下の route・ON/OFF・主会話への別枠の記述はその改訂より前のもの。** 正本は eumenes_agency の `spec/eumenes-integration-spike.md`（同内容）。agency 側の実験の経緯は eumenes_agency の `spec/results.md` を参照。

決定済み（利用者、2026-10-22）:
- 背景推論の route は設定 `agency.resourceId` で選べるようにする: 保存済みの cloud 資源（Claude Haiku を claude-agent-sdk 接続で）を指定すればそれを、未指定（null）なら LARM のローカル LLM を使う。利用者はローカル LLM も試す。LARM（約 60 tok/s）では select の出力（約 800 token）で自発発話が遅くなり、主会話・TTS と GPU を取り合う点は、試して log で測る。指定した cloud 資源が使えないときに黙って LARM へ落とすことはせず、agency を止めて理由を log に出す（§3 の方針どおり）。主会話の返答は従来どおり Eumenes の route。
- 取込み（§6 の 2）と配信（§6 の 3）は推奨どおり（版付き tgz を vendor、runless の assistant message を直接 append）。
- idle の既定は **20 秒**（backoff 20→40→80、無応答上限 1）。
- **話題は Eumenes の記憶に蓄積する**: agency は【話題】メモ（socialTopics の種）を自分で作らず上書きもしない。host が Eumenes Memory（利用者の State の好み・事実、必要なら想起）から話題を選び、機会ごとに `Opportunity.topics`（`memory:<id>` で参照）として渡す（agency の `hostTopics` モード）。agency の状態は未解決事項のメモだけ。自発発言も Eumenes 側に残る形にする。



## 1. 目的と非目的

目的: CLI で自然と評価された構成（B1a＋social mode＋standing interest＋TTS 向け文体、無言 10 秒の idle、10→20→40 秒の backoff、無応答の自発発話は 1 回まで、新しい入力で背景処理を中断、自発発話を会話履歴へ入れる）を、Eumenes の中で設定 `agency.enabled`（既定 OFF）の下に動かす。段階は (1) Web のテキスト会話、(2) 音声・TTS。

非目的: 永続台帳・Memory/World への依存登録（P3）、自発ツール実行（ticket が tool なら実行せず `failed`）、B2/F、新しい domain・DB 表・migration・会話 message schema の変更、steward/memory の改修、評価（P4）、複数利用者。

## 2. Eumenes の現状（根拠）

| 項目 | 事実 |
| --- | --- |
| 会話の開始 | `POST /api/runs`（`api/domains/dialogue/controller/index.ts:63`）→ `intake.acceptInTransaction` が user message・run・queue job（`resourceKey: "inference.llm"`）を 1 transaction で作る（`dialogue/service/intake.ts:49-140`） |
| 返答の確定 | `generation-settle.ts:224-231` が assistant message（`runId` 付き）を append。run 終端は `run-end.ts:20-55` で memory の exchange 記録と `steward.runEndedInTransaction` |
| クライアントへの配信 | commit ごとに `store.onCommit(() => changes.publish())`（`api/application/server-core.ts:45`）。SSE `/api/events`（`app-modules.ts:175`）は本文を持たない無効化通知（100ms まとめ、`events.ts:1-27`）、画面は API を読み直す（`docs/realtime.md`）。生成中は `/api/runs/:id/stream`（`dialogue/controller/index.ts:43`） |
| サーバー起点の発言 | 既にある。timer 完了は runless の assistant message を直接 append（`api/application/timers/timer-announcements.ts:6-19`、配線 `server-services.ts:73`）。作業報告も同じ（`application/work/task-report-delivery.ts:25-42`）。別方式として notice＝隠れた入力から main model が返答する run（`intake.ts:280-299`、`task-execution-port.ts:214`） |
| Web 表示 | `MessageList.tsx:79-82` は `presentation !== "artifact"` の全 message を表示し、runless も出る |
| 自動読み上げ | `web/.../voice-dialogue/hooks/automatic.ts:50-67` は **完了した run の answer だけ** を読む。runless message は読まれない。`replay.ts:98-103` の `play(id, text, runId?, {automatic})` は runless でも読め、文単位で再生し `onInterrupted` を持つ |
| 主会話の履歴 | `context-compiler.ts:97-170` は memory の verbatim 台帳の `inputMessageId/answerMessageId`（run 単位の往復）から履歴を組む。**runless の assistant message は main model の履歴に入らない**（memory OFF 時の fallback 経路は未確認） |
| 文脈の差込口 | `ContextSource` は閉じた union（`inference/contracts/context-render.ts:9-30`）。goals は `GoalsLayerPort`（`dialogue/contracts/index.ts:140-145`）→ `renderGoalsLayer`（`goals-layer.ts:27-46`）→ `generation-prepare.ts:96-99,132`。今回だけの資料は `withVolatile`（`context-volatile.ts:33-50`、呼出し `generation-prepare.ts:195`）。表示ラベルは `context-format-current.ts:140,218` |
| 観測 feed | `conversation.changesInTransaction(db, after, limit)`（`conversation/service/index.ts:135`）。`OutboxEvent` は本文なし、`kind: added/corrected/retracted`、`speaker`、`sourceId`（`conversation/contracts/index.ts:41-67`）。本文は `sourceInTransaction`/`messageInTransaction`。World が同じ feed を使う（`world/service/source-adapter.ts:280`）。準備確認 `outboxReadyInTransaction`（`:106`） |
| 発話中・混雑 | `inference.foregroundBusy()`（`inference/service/index.ts:508-520`。会話・ASR・TTS の要求中に true、`background:` は除外）、`onActivity`（`:522`）。利用者の発話開始はブラウザ内だけ（`web/.../audio/controller/index.ts:526-542` の `onSpeech`）。サーバーが知るのは途中認識 `POST /api/voice/preview` と確定 `POST /api/voice/turns`（`voice-dialogue/controller/index.ts:155-156`）、再生 ack `/played`（`:173`） |
| 背景推論 | `captureBackgroundControlInTransaction` → `executeControl(requestId, messages, signal, {instructions, outputSchema})`（`inference/contracts/index.ts:124-164`、steward の使用例 `steward/service/unit-prepare.ts:44-58`, `units.ts:52-59`）。出力 1,500 token 以下、期限 30 秒（structured は 90 秒）（`background-control.ts:16-22,89-104`）。`route` 未指定は LARM のみ、`{resourceId}` は保存済みの cloud LLM 資源、ただし会話 route が `cloudAllowed` のときだけ（`background-control.ts:30-50`）。queue 資源は `inference.llm`=1, `inference.aux`=2（`server-core.ts:86`）、steward は aux（`steward/contracts/index.ts:7`） |
| Anthropic | 会話用の cloud 接続種別は `openai-compatible / cloudflare-workers-ai / codex-sdk / claude-agent-sdk`（`settings/contracts/index.ts:14-19`）。Claude は `claude-agent-sdk` 接続（API key か subscription）として LLM 用途にだけ使える（`:329-335`, `:520-523`）、cloud 呼出しは `agentRequest` 経由（`inference/service/cloud.ts:302`）。Messages API を直接呼ぶ汎用 provider はない。モデル名・profile 名をコードに書くことは禁止（`AGENTS.md:15`） |
| 設定 | 既定 OFF の前例 `world: {enabled: false, curationResourceId: null}`（`settings/contracts/index.ts:239-253`、起動時に一度読む）。defaults は `settings/service/index.ts:38-80` |
| 配布物の取込み | `package.json` の `"eumenes-memory": "file:vendor/eumenes-memory/…tgz"`、`vendor/*/manifest.json`（sha256・契約版）、`api/application/vendor.test.ts` が manifest・package.json・bun.lock・install 済みの一致を検査。World は `scripts/pack.ts` で dist＋型の tgz を作る。zod 4.4.3 と TypeScript 5.9.3 は両 repo で同じ |
| 層の規則 | domain は tier の低い方へだけ依存（`scripts/domains.ts:1-6`、`scripts/boundaries.ts`）。`api/application/*` は組立て層で全 domain を使える |

## 3. 統合の構成

組立て層の `api/application/agency/`（新規、domain にしない）に `AgencyHost` を置き、会話ごとに `createAgencyRuntime` を 1 つ持つ（判断 5）。core はそのまま使う。

**観測の取込み**: `store.onCommit` で feed を読む（起動時の cursor は末尾。過去は読まない）。`added` は本文を読んで `observe({id: sourceId, kind: "exchange.adopted", actor: speaker==="user"?"user":"agent", occurredAt, text})`。`agency:` で始まる自分の発言は観測しない（`recordResult` が結果を台帳に入れるため）。timer・作業報告の runless 発言は `actor:"agent"` の観測になる。`corrected` は `kind:"correction"`。`retracted` は該当会話の runtime を作り直す（core に forget がないため。判断 9）。1 commit の複数 event は seq 順に全部取る（S7）。

**機会**: (a) `turn_end`: run 付きの assistant message を観測した直後に `runBackground`→`decide`。(b) `idle`: CLI の `createIdlePlanner`/`createIdleScheduler`（手順 A1 で core へ移す）を会話ごとに持ち、返答・自発発話の後の無言で起動。既定 idle 10 秒、backoff 2 回、無応答上限 1。利用者の新しい発言で planner をリセット。

**presence / busy**: `foregroundBusy = inference.foregroundBusy() || 当該会話に queued/running の run がある`。`presence`: テキスト段は `quiet`。音声段は利用者の発話開始報告から確定まで `speaking`、音声セッションが有効で報告が途絶えたら `unknown`。`playerBusy`: 音声段はクライアントの再生報告から、テキスト段は `false`。core は speaking/busy で `host_blocked` を返す（`src/application/runtime.ts:232`）。

**失効（fence）**: 新しい user message の観測、`POST /api/runs` の受理、音声の発話開始報告で、会話の generation を進め、背景 `AbortController` を abort、`runtime.invalidate("input.changed", now)`。AbortSignal だけに頼らず、配信 transaction の中で再検証する（下記）。

**発言の配信**: speak ticket は `store.write(tx => …)` の 1 transaction で、(1) generation が decide 開始時と同じ、(2) `conversation.latestOrdinalInTransaction(tx, conversationId)` が機会作成時と同じ（間に誰の発言もない）、(3) 設定が ON、を確かめてから `appendInTransaction(tx, {id: "agency:<ticketId>", role: "assistant", text, runId: null, createdAt})`。timer 通知と同じ形で、commit → SSE → 画面に出る。どれかが外れたら append せず `interrupted`。

**主会話に発言を見せる**: runless なので履歴に入らない（§2）。そこで `ContextSource` に `"agency.recent"` を足し、`AgencyLayerPort` で「最後の利用者発言以降に自分から言ったこと（聞かれた範囲）」を host_record・this_turn の volatile block として渡す。CLI と同じく projection（最大 5 件、参考資料で指示ではない）も同じ block の別節に入れるかは判断 4。block は 600 token 上限、超えたら古い方から落とし件数を書く。OFF なら block を作らず、プロンプトはバイト単位で現行と同じ。

**receipt**: 1 ticket に終端 receipt は 1 つ（S3）。テキスト段は append の commit 成功で `succeeded`（`resultText` は本文）、fence 不一致で `interrupted`。音声段で自動読み上げが ON なら append 後も receipt を保留し、クライアント報告で確定する: 全文再生 `succeeded`、途中で中断 `interrupted`（`resultText` は再生済みの文だけ、S1）、再生不能 `failed`、60 秒報告なし `outcome_unknown`（S4）。画面表示と音声は別媒体として log に記録する。

**状態の保存**: スパイクは RAM のみ。再起動で agency 状態は消える（会話本体は Eumenes の DB に残る）。open-items snapshot（verification-plan「状態の保存」）は手順 A3/E8 で後から。

**LLM route**: `AgencyLlmPort`（application 内）が `captureBackgroundControlInTransaction(db, {taskId: "agency", decisionId: "<conv>.<opp|bg>.<n>", authorityEpoch: 1, executionGeneration: generation, deadline: now+30s, taskDeadline, maxOutputTokens: request.maxOutputTokens, structuredOutput: true, route})` → `executeControl(id, messages, signal, {instructions: request.system, outputSchema: z.toJSONSchema(request.schema)})` → `request.schema.safeParse` → 失敗は core の `LlmOutputError`。route は判断 1:

| 候補 | 遅延 | 費用 | 品質 | 主会話との競合 |
| --- | --- | --- | --- | --- |
| A. 保存済み cloud 資源（Claude を `claude-agent-sdk` 接続で、`agency.resourceId`） | CLI の Haiku 直呼びより重い可能性（Agent SDK のセッション起動。**未計測**） | 従量課金。CLI の実績では 1 会話で数円規模 | CLI で確かめた構成と同系統。structured output が Agent SDK 経路で効くかは**未確認** | LARM を使わないので会話・TTS と競合しない |
| B. LARM（route 未指定 = larm-only） | ローカルモデル次第。GPU を会話・ASR・TTS と共有 | 追加課金なし | B1a の指示は Haiku でしか調整していない。品質未評価 | 調査済みの懸念: aux 枠は物理 GPU の優先を保証しない（source-audit「推論と負荷」）。turn_end 直後の update は次の返答と重なりやすい |
| C. Anthropic Messages API を application から直呼び | 最短（CLI と同じ） | A と同じ | CLI と同一 | なし。ただし新 provider・新しい credential 経路・モデル名の扱いが Eumenes 規則（`AGENTS.md:12-15`）に反するため不採用 |

A は会話 route が `cloudAllowed` でないと LARM に落ちる（`background-control.ts:30-50`）。この自動切替を黙って使わず、資源が使えないときは agency を止めて log に理由を出す（新しい fallback を足さない、`AGENTS.md:9`）。

**ログ**: `agency.observation_received / decision / delivered / receipt / invalidated / llm_call`。runId・ticketId・opportunityId・理由コード・token・遅延だけ。本文は出さない（`AGENTS.md:18`）。決定ごとに `DecisionSource` と理由コードを残す（S9）。

## 4. 配布と host-neutral の維持

- core（`src/`）は今のまま host-neutral。`scripts/check-boundaries.ts` は src からの `setTimeout`・`Date`・`node:`/`bun:`・src 外 import を禁じる。idle planner/scheduler は時計・timer を注入する純粋な状態機械なので src へ移せる（`chat-loop.ts` の `node:fs` を使う部分は standalone に残す）。
- Eumenes 固有のもの（feed、配信、文脈 block、LlmPort、設定）はすべて Eumenes 側の `api/application/agency/` に置き、この repo には Eumenes の型を入れない。
- 取込みは判断 2。推奨は World と同じ「dist（JS＋d.ts）の版付き tgz を `vendor/agency/` に置き、manifest と `vendor.test.ts` で照合」。`package.json` の `exports` は今 `./src/index.ts` を指すので、pack 時に `dist/index.js`/`index.d.ts` へ書き換える。tgz に `standalone/`・`eval/`・`data/`・`.env` を入れない。

## 5. 変更一覧（実装順。各段で単体試験を通す）

### この repo（eumenes_agency）

| # | 変更 | 試験 |
| --- | --- | --- |
| A1 | `createIdlePlanner`/`createIdleScheduler`/`IdleConfig`/`CycleOutcome` を `standalone/chat-loop.ts` から `src/application/idle.ts` へ移し `src/index.ts` から export。CLI はそこから import | 既存 `standalone/test/chat-loop.test.ts` の該当試験を `src` 側へ移して通す。`bun run check:boundaries` |
| A2 | `scripts/pack.ts`＋`tsconfig.build.json`（`rewriteRelativeImportExtensions`、emit dist）。出力 `artifacts/pack/eumenes-agency-<ver>-<sha12>.tgz` と manifest（version, sha256, `INSTRUCTION_VERSION`, `HOST_RULES_VERSION`）。`.gitignore` に artifacts | tgz を展開し `src` 相当の公開名が import でき、standalone/eval/.env を含まないことを確かめる試験 |
| A3 | （後段）`RuntimeDeps.initial?: {state, cursor}` で open items の復元。根拠照合はホストの仕事 | 復元後の projection・decide が同じ、閉じた項目を受け付けない |

### Eumenes（`../../eumenes`）

| # | 変更（ファイル） | 試験 |
| --- | --- | --- |
| E0 | `spec/agency-spike-<date>.md`（本書の要約）で合意 | — |
| E1 | **共有ファイル**: `vendor/agency/<tgz>`＋`manifest.json`、`package.json` dependencies、`bun.lock`、`api/application/vendor.test.ts` に agency の照合を追加 | `bun test api/application/vendor.test.ts` |
| E2 | 設定: `settings/contracts/index.ts` の world の隣に `agency: {enabled: false, resourceId: uuid|null = null, idleSec: 10, maxUnanswered: 1, interests: string[] ≤3 = []}`（`.default` 付き、strict）。`settings/service/index.ts` defaults。保存済み設定の移行が要るかは `settings/repository/migrate-stored.ts` で確認 | 既定値 OFF、旧設定の読込み、範囲外の拒否（settings の既存試験に追加） |
| E3 | `api/application/agency/llm-port.ts`（§3 LLM route） | fake `InferencePort` で: capture の引数、schema 違反→`LlmOutputError`、abort の伝播、`maxOutputTokens>1500` を出さない |
| E4 | `api/application/agency/host.ts`: 会話ごとの runtime、feed 追従、機会、presence、fence、配信、receipt、log。依存は `store, conversation, inference, settings, clock` だけ | 一時 DB の fixture と固定 `LlmPort` で: OFF なら観測・LLM 呼出し・append が 0、返答 1 回で turn_end の decide 1 回、通常返答の経路に LLM 呼出しを足さない、S5（decide 中に user message が commit → append なし・`interrupted`）、S3、S6（同文でも機会が違えば別 ticket）、S7、idle backoff と無応答上限 1、retraction で runtime 再作成 |
| E5 | 配線: `api/application/server-services.ts`（dialogue 作成 `:185` の後）で host を作り、`agency.enabled` が ON のときだけ feed を購読。終了処理を `server-lifecycles.ts` に登録。設定変更は `settings.onChange` → `setEnabled` | server の既存試験が OFF で変わらないこと |
| E6 | 主文脈: `inference/contracts/context-render.ts` に `"agency.recent"`、`dialogue/contracts/index.ts` に `AgencyLayerPort { recentForContextInTransaction(db, conversationId): {utterances: {messageId: string; text: string; heard: "full"|"partial"}[]; interests: string[]} | null }`、`dialogue/service/agency-layer.ts`（block 生成と 600 token 上限）、`DialogueDeps`/`createDialogueService` に `agency?`、`generation-prepare.ts` の `withVolatile` に追加、`context-format-current.ts` のラベル、s11tnext の文脈資産（frame 文）と `context:build` の生成物 | `goals-layer.test.ts` に倣い: 空なら null、順序・上限・OFF で既存プロンプトと同一、`context-assembly.test.ts` の予算 |
| E7 | （音声段）Web: `web/src/domains/voice-dialogue/hooks/agency.ts` で `agency:` の新着 message を `player.play(id, text, null, {automatic: true})`（`automatic.ts` と同じ `blocked`・`ownsSpeech` の条件）。開いた時点の既存分は読まない。`onSpeech` と再生開始/終了/中断（再生済み文数）を `POST /api/agency/activity` で報告。API: `api/application/agency/routes.ts`（`app-modules.ts` に登録） | hooks の試験（`automatic.test.tsx` に倣う）: 新着だけ読む、中断で `interrupted`＋文数、run の自動読み上げと二重にならない。API 側で S1・S4・S2（後述の限界） |
| E8 | （後段）snapshot を 1 行で保存・起動時に根拠照合して復元（A3 依存） | 再起動後に根拠が retract 済みの項目を捨てる |

変えないもの: run の受理・生成・settle、`automatic.ts` の run の読み上げ、memory の台帳と steward、会話 message schema と migration、timer・作業報告の流れ、既存 `ContextSource` の描画順、OFF 時の挙動とプロンプト。`conversation-generation.ts`（未コミット変更中）には触れない。

並行作業の分け方: A1/A2 と E2/E3 は独立。E4 と E5 は分けない（host の購読と配線が密結合）。E6 は E4 と独立だが `DialogueDeps` を触るので 1 人で。E1・`package.json`・`bun.lock`・`app-modules.ts`・s11tnext 生成物は呼出し側が最後にまとめて編集する。

## 6. 利用者が決めること（推奨つき）

1. **背景 LLM の route**: 推奨 **A（保存済みの Claude 資源）**。CLI で自然だった品質を保ち、会話・TTS と GPU を取り合わない。最初に 1 件の structured 呼出しの遅延と schema 準拠を測り、だめなら B を比較。C は Eumenes 規則に反するので採らない。
2. **取込み方法**: 推奨 **版付き tgz（vendor）**。スパイクの手元反復だけ `file:../eumenes_agency` を使い、それはコミットしない。
3. **配信の形**: 推奨 **runless の assistant message を直接 append**（timer 通知と同じ。文面そのまま、速い、main model を回さない）。代替の notice→run は履歴に自動で入るが、主会話の LARM を 1 回使い、文面が言い換わり、遅い。
4. **主文脈への差込み**: 推奨 **自発発言は必須で入れる、projection は interests と自発発言だけ（最大 5 行）**。runless 発言は履歴に入らないので、入れないと次の返答が矛盾する（CLI で確認済みの問題）。
5. **会話の範囲**: 推奨 **会話ごとに runtime、idle は直近に利用者が発言した会話だけ**。複数タブ・複数会話への同時自発はしない。
6. **ON/OFF の反映**: 推奨 **即時（`settings.onChange`→`setEnabled`）**。world と違い起動時固定にする理由がない。OFF で進行中の背景を abort、保留 ticket を失効。
7. **状態の保存**: 推奨 **スパイクは RAM のみ**、snapshot は E8 で。
8. **Web での idle 秒数**: 推奨 **既定 10 秒・設定可**、無応答上限 1。長文の返答を読んでいる途中で話しかける懸念は実利用で確かめる。
9. **取消・忘却の扱い**: 推奨 **retraction・forget を見たらその会話の runtime を捨てて作り直す**（core に forget がないため。忘れた本文が自発発言に残らないことを優先）。
10. **音声の目印**: 推奨 **id の接頭辞 `agency:`**（schema を変えない）。正式統合で message に由来の field を足すかは後で決める。

## 7. リスク

- runless 発言は memory の往復台帳に入らない。steward の要約・想起は自発発言を知らない（長期記憶の欠落）。スパイクでは E6 の block だけで補う。
- `claude-agent-sdk` 経由の control が structured output に対応するか、遅延がどれだけかは未確認（`cloud.ts:384` の strict schema は openai-compatible 経路のコメント）。
- route A は会話 route が `cloudAllowed` のときだけ有効。会話内容が cloud に送られる点は既存の会話 route と同じ許可範囲に従う。
- B を選ぶと turn_end 直後の update が次の返答・TTS と同じ GPU で重なる。`foregroundBusy` での見送りは選択（decide）にしか効かず、`runBackground` は走る。
- テキスト入力中（未送信）はサーバーに見えない。入力欄に打っている最中に自発発言が出ることがある。
- S2: 音声段で「発話開始」を VAD の `onSpeech` にすると単発の雑音でも失効する。確定発話（`/api/voice/turns`）にすると発話中に自発発言が出る。スパイクは `onSpeech` 側（安全側）で始め、誤失効の頻度を log で見る。
- 複数タブ: 読み上げが二重になりうる。`automatic.ts` と同じく再生中の判定は各タブ内だけ。
- Eumenes の作業ツリーに他の未コミット変更がある。担当外のファイルを触らない。

## 8. 利用者の操作なしでは確かめられないこと

サーバーを起動しての実会話の自然さと idle の間、route A/B の実遅延・費用・schema 準拠、LARM 混雑時の主会話への影響、SSE 経由の表示までの遅れ、ブラウザ自動再生と中断・barge-in、VAD の雑音での誤失効（S2）、音声の実機 3 往復受入（`AGENTS.md:17`）。いずれも fixture 試験の合格とは別に記録する。
