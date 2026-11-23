# 記憶の想起の改善: 実装設計（作業の単位・契約・手順）

- 日付: 2026-11-23
- 状態: 実装済み・fixture 検証済み（2026-11-23、§11）。live は分離した backend の起動待ち。本番の掃除は未実行
- 前提: [記憶の想起の改善設計](memory-recall-improvement-2026-11-23.md)（以下「改善設計」）。利用者は §9 の推奨をすべて承認した（2026-11-23）
- 元の設計: [記憶系の作り直し設計](memory-architecture-redesign-2026-11-22.md) §5・§6・§13・§16
- 対象のリポジトリ: 本体 `/Users/y.noguchi/Code/eumenes`、評価 `/Users/y.noguchi/Code/eumenes_consolidation`。記憶ライブラリ `/Users/y.noguchi/Code/eumenes_memory` は変更しない（§9 に理由）

## 0. 目的と、やらないこと

| 項目 | 内容 |
| --- | --- |
| 目的 | 承認された 10 項目を、書き込み先が重ならない作業の単位に分けて実装できるようにする |
| やること | 件数の上限の撤廃、常時の区画の拡張（本人の事実まで、枠 2,000 トークンから）、`read_memory` の照合の修正と順位付け、その回の区画 `## Recall`（設定で入切、既定は切）、似た記録の扱い、`memory` ツールの冪等の鍵の修正、整理のきっかけに件数を足す、評価の分離、本番の記憶の掃除と L1→L2 の移し替えの口 |
| やらないこと | 別の会話の発言を読む（`read_history` は変えない。`## Recall` に「前の会話」の行は作らない）。変更の宣言を訂正として反映する（§1 の保留の単位。`## Recall` の結果を見てから決める）。睡眠の層の規則の中身。全文索引（`memory_state_fts`）への置き換え（1,000 件を超える前に別途）。記憶ライブラリ・`vendor/` の更新。Web の画面 |
| 守る規則 | プロンプトに例文を入れない。モデル名・profile 名を書かない。domain の判断・SQL・試験は各 domain。置き換えた古いコードは消す（§2.6 の削除の一覧）。サーバーの起動・停止、live の計測、DB のバックアップと掃除の実行は利用者の指示を受けてから |

## 1. 作業の単位

書き込み先は単位どうしで重ならない。どの単位も次には書かない: `api/application/agency/` の別セッションが変更中のファイル（always-on-cycle.ts・always-on-goal-reply.ts・always-on-ports.ts・assembly.ts・goal-agenda.ts・host-types.ts・input.ts・note-documents.ts・goal-*.ts・registered-goals.ts）、`api/domains/memory/test/memory.fixture.ts`（読むだけ）、`vendor/**`、`api/domains/dialogue/contexts/**`、`.s11tnext/**`、`scripts/domains.ts`、`package.json`、`bun.lock`、`/Users/y.noguchi/Code/eumenes_agency/**`、§3 の共有ファイル。

2026-11-23 時点で、下の表の書き込み先に未コミットの変更は無い（`git status --short` で確認。汚れているのは `memory.fixture.ts` だけで、書き込み先から外してある）。

| 単位 | 目的 | 書いてよいパス | 触ってはいけないパス（上の共通分のほか） | 合格の試験 |
| --- | --- | --- | --- | --- |
| 記憶の検索・上限・印 | 件数の上限の撤廃。順位付きの検索 `recall`。機微・ほかの人の印。枠の設定。似た記録の検出。整理のきっかけに渡す数 | `api/domains/memory/service/**`（`residue.ts` を除く）、`api/domains/memory/contracts/**`、`api/domains/memory/repository/**`、`api/domains/memory/controller/index.ts`、`api/domains/memory/index.ts`、`api/domains/memory/test/**`（`memory.fixture.ts`・`residue.test.ts` を除く） | `api/domains/memory/service/residue.ts`、`controller/residue.ts`、`test/residue.test.ts`、dialogue・steward・application | `bun test api/domains/memory/test/context-window.test.ts api/domains/memory/test/immediate-explicit.test.ts api/domains/memory/test/migration.test.ts api/domains/memory/test/seed-import.test.ts api/domains/memory/test/maintenance.test.ts`、新規 `api/domains/memory/test/recall.test.ts`。最後に `bun run verify -- --domain memory` |
| 記憶の掃除と移し替えの口 | 根拠の会話で記録を選んで止める口と、候補を L2 へ移す口（§6） | 新規のみ: `api/domains/memory/service/residue.ts`、`api/domains/memory/controller/residue.ts`、`api/domains/memory/test/residue.test.ts` | 記憶の domain の既存ファイルすべて（配線は統合役） | `bun test api/domains/memory/test/residue.test.ts` |
| 会話の入力 | 常時の区画の拡張。`## Recall` の組み立て。`read_memory` を `recall` に乗せる | `api/domains/dialogue/service/conversation-input.ts`・`recall-text.ts`（新規）・`answer-input.ts`・`input-text.ts`・`state-plans.ts`・`executor-read.ts`・`generation-prepare.ts`・`routed-actions.ts`・`context.ts`、`api/domains/dialogue/eval/context/message-invariants.ts`・`session.ts`、`api/domains/dialogue/test/conversation-input.test.ts`・`read-tools.test.ts`・`state-text.test.ts`・`recall-text.test.ts`（新規） | `executor-memory.ts`・`generation-tools.ts`・`executor-context.ts`、`test/memory-immediate.test.ts`・`generation-tools.test.ts`・`memory-tool-*.test.ts` | `bun test api/domains/dialogue/test/conversation-input.test.ts api/domains/dialogue/test/recall-text.test.ts api/domains/dialogue/test/read-tools.test.ts api/domains/dialogue/test/state-text.test.ts`。最後に `bun run verify -- --domain dialogue` |
| `memory` ツール | 冪等の鍵に会話を入れる。似た記録の ref を結果に返す。印の引数 | `api/domains/dialogue/service/executor-memory.ts`・`generation-tools.ts`、`api/domains/dialogue/test/memory-immediate.test.ts`・`generation-tools.test.ts`、新規 `api/domains/dialogue/test/memory-tool-key.test.ts` | 「会話の入力」の書き込み先、`executor-context.ts`、steward | `bun test api/domains/dialogue/test/memory-tool-key.test.ts api/domains/dialogue/test/memory-immediate.test.ts api/domains/dialogue/test/generation-tools.test.ts` |
| 背景のパスの書き込み | 「満杯なら L1 へ」の分岐を消す。関係する記録の選び方を `recall` に乗せる。ほかの人の印を渡す | `api/application/agency/always-on-records.ts`、`api/application/agency/always-on-records.test.ts` | `api/application/agency/` のほかのファイルすべて | `bun test api/application/agency/always-on-records.test.ts` |
| 整理のきっかけ | 有効な記憶の増分と、似た記録の組の増分を、深い整理の起動の条件に足す | `api/domains/steward/service/sleep/policy.ts`・`kick.ts`、`api/domains/steward/service/sleep/steps.ts`（`setDeepDay` を呼ぶ箇所。448 行付近）、`api/domains/steward/service/types.ts`、`api/domains/steward/repository/sleep.ts`・`sleep-pressure.ts`（新規）・`index.ts`、`api/domains/steward/test/sleep.test.ts`・`sleep.fixture.ts`・`migration.test.ts`・`kick-scale.test.ts` | `api/domains/steward/service/inbox.ts`、記憶の domain | `bun test api/domains/steward/test/sleep.test.ts api/domains/steward/test/migration.test.ts api/domains/steward/test/kick-scale.test.ts`。最後に `bun run verify -- --domain steward` |
| 評価: ケース集と採点 | 事柄の使い回しをやめる。採点の誤りを直す。音声認識の誤りの区分を分ける（§7.2・§7.3） | 評価リポジトリの `src/cases/**`、`cases/*.json`（`bun run cases:build` の生成物）、`src/score/**`、`src/compare/**` | `src/run/**`、`scripts/**`、`test/fixtures/**`、`README.md`、`src/consolidation/**` | `bun test src/cases src/score src/compare`、`bun run cases:check` |
| 評価: 実行器と分離 | 分離した backend だけに live を流す。統合の劣化をまとめて流し、深い整理を待つ（§7.1・§7.4） | 評価リポジトリの `src/run/**`、`scripts/eval.ts`、`scripts/wait-deep.ts`（新規）、`test/fixtures/fake-eumenes-cli.ts`、`README.md` | `src/cases/**`、`cases/**`、`src/score/**`、`src/compare/**`、`src/consolidation/**` | `bun test src/run` |
| （保留）変更の宣言を訂正として反映 | 改善設計 §5.3。`## Recall` の対比較の結果を見て、利用者が決めた後に着手 | `eumenes_agency/src/agenda/extract.ts`、本体 `always-on-records.ts` の `writeRecords`、記憶の `explicit.ts` の `correct` | 着手まで全部 | 着手時に決める。`eumenes_agency` と `vendor/agency` は別セッションが変更中なので、統合役が別セッションの作業と調整してから vendor を取り込む |

分けない組: 「会話の入力」の中の常時の区画と `## Recall`（`conversation-input.ts`・`generation-prepare.ts` を共有）。評価の 2 単位は別の人でよいが、`EvalCase` の型（`src/cases/types.ts`）を変えるのは「ケース集と採点」だけ。

## 2. 先に固定する契約

統合役が並列の開始前に、この節の型と名前を確定として配る。変えるときは統合役に連絡する。

### 2.1 記憶の domain の公開操作（「記憶の検索・上限・印」が作り、dialogue・agency・steward が使う）

新規ファイル `api/domains/memory/contracts/recall.ts`。`api/domains/memory/index.ts` から型を出す。

```ts
export type MemoryRecallInput = {
	/** 利用者の発言、または read_memory の query。空文字は「全件」。 */
	text: string;
	/** 返す件数（1〜21）。 */
	limit: number;
	/** 常時の区画に載っている記録の ID。 */
	shown: ReadonlySet<string>;
	/** true: shown の記録を結果から省く。false: 含めて inProfile を付ける。 */
	omitShown: boolean;
	/** 失効した版（訂正の旧版）を付けるか。 */
	withPrevious: boolean;
	/** text が空でないとき、score がこれ以下の記録を外す。read_memory は 0。 */
	minScore: number;
	/** host: 抑制された記録を省き、機微・ほかの人の印の記録は direct のときだけ返す。tool: 全部返す。 */
	audience: "tool" | "host";
};
export type MemoryRecalled = {
	id: string;
	revision: number;
	kind: string;
	text: string;
	source: "user_said" | "inferred" | "observed";
	negated?: true;
	suppressed?: true;
	sensitive?: true;
	aboutOther?: true;
	since?: string;
	until?: string;
	inProfile?: true;
	/** text が空のときは 0。 */
	score: number;
	/** 問いの語（2 文字以上）のどれかが、記録の本文にそのまま含まれる。 */
	direct: boolean;
	/** withPrevious のとき、同じ事柄の失効した版。新しい順に 2 つまで。until は失効した日（Asia/Tokyo、YYYY-MM-DD）。 */
	previous?: { text: string; until: string }[];
};
export type MemoryRecallResult = {
	/** 今有効な記録と傾向の件数。 */
	total: number;
	/** 条件に当たった件数（limit で切る前）。 */
	matched: number;
	items: MemoryRecalled[];
};
```

`MemoryService` に足す操作と、消す操作:

| 操作 | 形 | 使う側 |
| --- | --- | --- |
| `recall(input)` | `(input: MemoryRecallInput) => MemoryRecallResult \| null`（記憶が使えないとき null。読み取り接続） | `executor-read.ts` |
| `recallInTransaction(db, input)` | `(db: Database, input: MemoryRecallInput) => MemoryRecallResult` | `recall-text.ts`、`always-on-records.ts` |
| `inputBudgetInTransaction(db)` | `(db: Database) => MemoryInputBudget` | `conversation-input.ts`、`recall-text.ts` |
| `consolidationPressureInTransaction(db)` | `(db: Database) => { activeItems: number; similarPairs: number }` | steward の `kick.ts` |
| 消す | `check`、`checkItemsInTransaction`、`readItemsInTransaction`（`recall` に置き換える。互換は残さない） | — |

```ts
export type MemoryInputBudget = {
	/** 常時の区画 `## Memory` の枠（トークン）。 */
	alwaysTokens: number;
	/** responses: 制約・好み。leanings: ＋習慣。facts: ＋本人の事実。 */
	alwaysScope: "responses" | "leanings" | "facts";
	/** その回の区画 `## Recall` を出すか。 */
	recallEnabled: boolean;
	recallTokens: number;
	recallItems: number;
};
```

順位付けの規則（`recall` の中身。記憶の domain の判断）:

| 規則 | 内容 |
| --- | --- |
| 正規化 | 問いと記録の文を NFKC にして小文字にする |
| 記録の文 | 本文・`semanticKey`・属性をつないだもの（`memory_state_search_doc` と同じ材料） |
| 語 | 問いを空白と句読点・かっこ・疑問符・感嘆符で区切る |
| 1 文字の語 | 記録の文にその文字があれば当たり（その語の割合は 1） |
| 2 文字以上の語 | 語の文字 2 つ組のうち、記録の文に含まれる割合。ひらがなだけの 2 つ組は、その語にほかの 2 つ組が 1 つでもあれば数えない |
| score | 語ごとの割合の合計。`minScore` 以下は外す |
| 並び | score の降順。同点は新しい順（`newness`）。text が空のときは、傾向を後ろにして新しい順（今と同じ） |
| 読むだけ | 読んでも強度・順位・記録は変わらない（今と同じ） |
| 計算量 | 今の全件の読み出しのまま。全文索引は使わない |

`previous` は、記憶ライブラリの `readStateFact`（同じ事柄の全版）と `listStateByTime`（`supersededAtMs`）で引く。ライブラリは変更しない。

### 2.2 印（機微・ほかの人）

| 項目 | 内容 |
| --- | --- |
| 置き場所 | 記憶の domain のホスト側の表 `memory_item_mark(item_id TEXT PRIMARY KEY, sensitive INTEGER NOT NULL DEFAULT 0, about_other INTEGER NOT NULL DEFAULT 0)`（§5 の migration）。本文は持たない |
| 書く口 | `RememberExplicitInput` に `sensitive?: boolean`・`aboutOther?: boolean` を足す。`subject` は `"self"` のまま（ライブラリの種類の制約を変えない） |
| 訂正 | 新しい版は、置き換えた版の印を引き継ぐ |
| 忘却 | 閉包削除の purge（`service/index.ts` の `purgeHooks`）で行を消す |
| 読む口 | `ProfileItem` に `sensitive?: true`・`aboutOther?: true` を足す（`profileItemFields` には出さない）。窓の形が変わるので `WINDOW_FORMAT` を 3 にする |
| 付ける者 | `memory` ツール: 引数 `memory.sensitive`（boolean）と `memory.subject`（`"self" \| "other"`。`other` のとき `aboutOther: true`）。背景のパス: 抽出の出力の `subject` が `self` 以外なら `aboutOther: true`（`ExtractedMemory.subject` は既にある。`eumenes_agency` は変えない）。背景のパスは機微な情報を書かない決まり（`extract.ts` の指示）なので `sensitive` は付けない |
| 既にある記録 | 印が無い。本人のこと・機微でないものとして扱う（§10） |

### 2.3 `rememberExplicitInTransaction` の結果（似た記録）

```ts
export type RememberExplicitOutcome =
	| { status: "applied"; requestId: string | null; itemId: string; revision: number;
			replacedItemId: string | null;
			/** 鍵は違うが文が似ている有効な記録（同じ種類、3 件まで）。値は書き換えていない。 */
			similar: { itemId: string; revision: number }[] }
	| { status: "unchanged"; itemId: string; revision: number }
	| Rejected;
```

| 場合（鍵が一致する有効な記録が無いとき） | 動き |
| --- | --- |
| 同じ種類の有効な記録に、正規化して空白と句読点を除いた本文と極性が同じものがある | その記録の再確認にする（今の「同じ値」の経路。新しい記録を作らない。`unchanged` か、推定だった記録なら本人のものにして `applied`） |
| 似ているが同じではない（`recall` の score が、記憶の domain の定数 `SIMILAR_MIN_SCORE` 以上） | 保存は止めない。`similar` に入れて返す |
| それ以外 | 今のまま。`similar: []` |

`memory` ツールの結果（dialogue、モデルが読む形）: `{ "accepted": true, "status": "applied", "ref": "m12", "similar": ["m7"] }`。`similar` は空なら出さない。ref は `shortRefs.assignInTransaction` で付ける。

### 2.4 `memory` ツールの冪等の鍵

`executor-memory.ts` の中だけで直す。`executor-context.ts` の `actionKey` は変えない（`acted` の出来事の `dedupeKey` は `continuity_events(conversation_id, dedupe_key)` の一意制約で会話ごとなので、衝突しない。確認済み）。

```ts
/** steward の受付（steward_inbox・対象の解決の依頼）の ID。会話をまたいで一意。 */
const requestIdOf = (target: string) => `${input.conversationId}:${actionKey(target)}`;
```

`apply(...)` へ渡す `requestId` と、`goal(...)` の `requestId` の両方に使う。既にある `steward_inbox` の行の ID は変えない。`inbox.ts` の「会話が違えば `request_conflict`」の検査は残す。

### 2.5 dialogue の中の契約（「会話の入力」の中で閉じるが、名前を固定する）

```ts
// conversation-input.ts
export function memoryLines(
	items: readonly ProfileItem[],
	budget: Pick<MemoryInputBudget, "alwaysTokens" | "alwaysScope">,
	refs?: ReadonlyMap<string, string>,
): { lines: string[]; ids: string[]; shown: ProfileItem[] };
export const memoryDigestOf: (window: WindowSnapshot | null, budget: Pick<MemoryInputBudget, "alwaysTokens" | "alwaysScope">) => string;

// input-text.ts
INPUT_HEADINGS.recall = "## Recall";

// state-plans.ts
export function planGoalFields(deps: DialogueDeps, tx: Database): { lines: string[]; planIds: string[] };

// recall-text.ts（新規）
export function recallLinesInTransaction(deps: DialogueDeps, tx: Database, input: {
	conversationId: string;
	utterances: readonly string[];
	shownMemoryIds: ReadonlySet<string>;
	shownPlanIds: ReadonlySet<string>;
	budget: Pick<MemoryInputBudget, "recallTokens" | "recallItems">;
	/** 記憶の短い参照を付ける（prepare の中。memoryFound と同じ付け方）。 */
	refOf: (items: readonly { itemId: string; revision: number }[]) => ReadonlyMap<string, string>;
}): { lines: string[]; memoryItemIds: string[]; planIds: string[] };
```

| 項目 | 規則 |
| --- | --- |
| 常時の区画に載る記録 | `source === "user_said"`、`alwaysScope` の種類、`sensitive`・`aboutOther` の印が無い、抑制されていない（今と同じ）。決定 C4（推定を載せない）は変えない |
| 枠を超えたときに残す順 | 出所 → 種類（制約 → 好み → 習慣 → 本人の事実）→ 新しい順。`keepOrder` の種類の順を変える（`profile.ts`。表示の順 `PROFILE_KIND_ORDER` は変えない） |
| 枠と範囲 | `deps.memory.inputBudgetInTransaction(tx)` から読む。`MEMORY_TOKENS`・`MEMORY_KINDS` の定数は消す |
| `## Recall` を出す回 | 利用者の発言に答える回だけ（`final.kind === "utterances"` で、定時の指示ではない）。`recallEnabled` が false、記憶が使えない、抑制の語が読めない、行が無い、のどれかなら見出しごと出さない |
| 置き場所 | 最後の `user` メッセージの中、`## State` の次、`## Host notice`・`## User` の前（`answerMessages` の `sections`） |
| 行: 記憶 | `recallInTransaction`（`audience: "host"`、`omitShown: false`、`withPrevious: true`、`minScore` は dialogue の定数 `RECALL_MIN_SCORE`）の結果のうち、常時の区画に無いもの。`- 記憶: m14 <本文>（推測）` の形で、出所の注記は `memoryItemLine` に合わせる |
| 行: 以前 | 結果の記録（常時の区画に載っているものも含む）の `previous`。`- 以前: m14 <旧い本文>（YYYY-MM-DD まで）` |
| 行: 予定 | `continuity.plans.searchInTransaction`（open・確認待ち）のうち、`shownPlanIds` に無いもの。参照は付けない。`- 予定: <本文>（期日）` |
| 行: 食い違い | open の `open_question` のうち、`memoryItemIds` が結果の記録（常時の区画に載っているものも含む）に結ばれたもの。`- 食い違い: m11 <問いの本文>`。どちらが正しいかは書かない |
| 抑制・除外 | 各行に `touchesSuppressedTerm` を通す。除外された記録と、それに立つ予定・問いは、各 domain の照会が既に外す |
| 保存 | 履歴に保存しない。毎回作り直す。同じ run の 2 回目の入力（`routed-actions.ts` の `answerMessages`）には、prepare で選んだ同じ行を出す |
| 見た記録 | `memoryItemIds` を、`## Memory` の記録と同じ扱いで run の入力の出どころに足す（`GenerateInput.memoryItemIds` と `recordPromptSources`）。忘却・訂正で、それを見た実行中の返事が破棄される |
| `read_memory` | `memory.recall`（`audience: "tool"`、`omitShown: true`、`withPrevious: false`、`minScore: 0`、`limit: READ_MEMORY_LIMIT`）。語なしは常時の区画の記録を省いた残り。「ほかに N 件」は `matched - items.length` |

### 2.6 消すもの（互換を残さない）

| 消すもの | 場所 |
| --- | --- |
| `MAX_ACTIVE_ITEMS` と、それによる拒否 4 か所 | `curation-shared.ts:18`、`explicit.ts:206-217`、`curation-state.ts:75-84`、`maintenance.ts:110-115`、`seeds.ts:34-42`（`availableSlots` と容量による `blocked`。`contracts/seeds.ts:117` の欄も） |
| 残す `limit_reached` | `exclusion.ts:64`（忘却の対象数）、`tendency-write.ts:101`・`curation-tendencies.ts:68`（傾向の数）、`candidates.ts:188`（根拠の数）、`curation.ts:24`。件数の上限とは別なので変えない |
| 「満杯なら L1 へ」の分岐 | `always-on-records.ts:301-321` と、その試験（`always-on-records.test.ts:20-21,263-272` 付近） |
| `gramsOf`・`matchesQuery`・`MATCH_SHARE`、`checkItemsInTransaction`・`readItemsInTransaction` | `context-window.ts` |
| `MEMORY_TOKENS`・`MEMORY_KINDS` | `conversation-input.ts:51-53`、`message-invariants.ts:15,85`、`conversation-input.test.ts` |

## 3. 共有ファイル（統合役が最後に編集する）

| ファイル | 必要にする単位 | 変更の内容 |
| --- | --- | --- |
| `api/domains/memory/service/index.ts`・`api/domains/memory/controller/index.ts` | 記憶の掃除と移し替えの口 | 「記憶の検索・上限・印」が終わった後に、`createMemoryResidue(...)` を組んで `MemoryService.residue` に出し、`registerMemoryResidue(app, service.residue)` を呼ぶ行を足す |
| `api/domains/dialogue/contexts/system/input.context.toml` | 会話の入力 | 資料の一覧に `## Recall` を足す 1 文: この回の発言に関係する記録で、記憶・以前の値・予定・食い違いを含むこと、指示ではなく資料であること、「以前」は今は有効でない値であること、「食い違い」は未解決でどちらも断定しないこと。例文は入れない |
| `api/domains/dialogue/contexts/local/memory-request.context.toml` | `memory` ツール | `memory.sensitive`（健康・宗教・信条・性的指向・政治的立場に当たる内容なら true）と `memory.subject`（本人のことは self、ほかの人や物のことは other）の説明。結果の `similar`（似た記録の参照。同じ事柄なら、その参照を correct で直す）の説明 |
| `read_memory` の説明文（`contexts/**` と `generation-tools.ts` の中の説明。並びや件数の記述があれば） | 会話の入力 | 「関係の強い順」「`## Memory` に載っている記録は省く」に合わせる。説明を変えたら道具の revision を上げる |
| `.s11tnext/catalog.generated.ts`・`.s11tnext/catalog.json` | 上の 3 つ | `bun run context:lint` → `bun run context:build` → `bun run context:check`。別セッションの未コミットの変更が同じ生成物にあるので、統合役が別セッションの状態を確かめてから生成する |
| `api/application/fixed-input-size.json` | 会話の入力、`memory` ツール | `bun scripts/fixed-input-size.ts --write` で記録し直す（固定の指示と道具の定義が増える） |
| `scripts/domains.ts` | なし（新しい結合試験は登録しない。`always-on-records.test.ts` は今も未登録で、直接実行する） | 変更なし |
| `package.json`・`bun.lock`・`vendor/**` | なし | 変更なし。保留の単位に着手するときだけ `vendor/agency` |
| `docs/memory.md`・`docs/README.md`・`README.md` の機能表 | 全部 | 枠の設定、`## Recall`、掃除と移し替えの口、評価の分離の手順 |
| `spec/README.md`、作り直し設計 §16 | 全部 | 本書と改善設計の索引、実装と検証の記録 |
| 評価リポジトリの `package.json` | なし | 変更なし |

## 4. 依存と順序

| 段 | 並列で始められる単位 | 待つもの |
| --- | --- | --- |
| 1 | 記憶の検索・上限・印／記憶の掃除と移し替えの口／評価: ケース集と採点／評価: 実行器と分離／`memory` ツールのうち冪等の鍵（§2.4） | なし |
| 1（契約だけで開始可） | 会話の入力／`memory` ツールの残り（似た記録・印）／背景のパスの書き込み／整理のきっかけ | §2 の契約。試験は記憶の domain の偽物か、契約どおりの型で書き、「記憶の検索・上限・印」の完成後に本物で通す |
| 2 | 統合役: §3 の共有ファイル、`bun fmt <変更したファイル>`、`bun run verify -- --domain memory`・`dialogue`・`steward`・`continuity`、`bun test api/application/agency/always-on-records.test.ts`、評価リポジトリで `bun run verify` | 段 1 の全部 |
| 3 | 独立したレビューを 1 回、指摘をまとめて 1 回で直す | 段 2 |
| 4 | 利用者: 分離した backend の起動、live の小さい流し方（§7.5）、本番の掃除（§6） | 段 3 |

同じ run の中での順序の注意: 「背景のパスの書き込み」は `limit_reached` の分岐を消すので、「記憶の検索・上限・印」より先に本番に入っても害はない（拒否が来なくなるだけ）。逆の順でも害はない。

## 5. migration

適用済みの migration は 1 バイトも変えない（`memory/0001`〜`0015`、`steward/0001`〜`0008`。再起動は作業ツリーをそのまま適用するので、下の 3 つも一度適用されたら固定し、直すときは次の番号を追記する）。

| ID | 置き場所（新規ファイル） | `after` | SQL の中身 |
| --- | --- | --- | --- |
| `memory/0016-item-marks` | `api/domains/memory/repository/marks.ts` | `memory/0015-explicit-request-requested` | `CREATE TABLE memory_item_mark (item_id TEXT PRIMARY KEY, sensitive INTEGER NOT NULL DEFAULT 0, about_other INTEGER NOT NULL DEFAULT 0);` |
| `memory/0017-input-budget` | `api/domains/memory/repository/input-budget.ts` | `memory/0016-item-marks` | `memory_host_settings` に列を足す: `always_tokens INTEGER NOT NULL DEFAULT 2000`、`always_scope TEXT NOT NULL DEFAULT 'facts'`、`recall_enabled INTEGER NOT NULL DEFAULT 0`、`recall_tokens INTEGER NOT NULL DEFAULT 400`、`recall_items INTEGER NOT NULL DEFAULT 8` |
| `steward/0009-sleep-pressure` | `api/domains/steward/repository/sleep-pressure.ts` | `steward/0008-target-requests` | `steward_sleep_state` に列を足す: `deep_item_count INTEGER`、`deep_similar_pairs INTEGER`（NULL は「まだ基準が無い」） |

登録は各 domain の `repository/index.ts` の `migrations` の末尾（記憶は「記憶の検索・上限・印」、steward は「整理のきっかけ」が書く）。試験は各 domain の `test/migration.test.ts` に、前の版の DB から上げて列と既定値を確かめる 1 件を足す。

枠の値は SQL の既定値と保存した設定だけに置き、TypeScript の定数にしない。変更は `POST /api/memory/settings`（`settingsSchema` を `enabled`・`alwaysTokens`（200〜8000）・`alwaysScope`・`recallEnabled`・`recallTokens`（0〜2000）・`recallItems`（0〜21）のどれか 1 つ以上に広げる。`enabled` だけを送る今の Web はそのまま動く）。保存は `revision` を 1 つ上げるので、次の入力で常時の区画が作り直される（今の `policyRevision` の仕組み）。`GET /api/memory/status` は今の値を返す。

整理のきっかけ（steward）:

| 項目 | 内容 |
| --- | --- |
| 条件 | 今の「出来事が `deepEvents` 以上」に、「有効な記憶が前回の深い整理から `deepItems` 以上増えた」「似た記録の組が前回から `deepSimilarPairs` 以上増えた」を or で足す。時間帯・1 日 1 回・休止の条件は今のまま |
| 閾値 | `SLEEP_POLICY.deepItems`・`deepSimilarPairs`（`policy.ts`。初期の仮の値は 20 と 3。評価で直す） |
| 基準 | 深い整理の完了時（`steps.ts` の `setDeepDay` の所。時間帯の外の補いの実行でも書く）に、そのときの件数を `deep_item_count`・`deep_similar_pairs` に書く。NULL のときは、最初の kick で今の件数を基準として書くだけで起動しない |
| 似た組の数え方 | 記憶の domain の `consolidationPressureInTransaction`。同じ種類の有効な記録の組で、`recall` の score が `SIMILAR_MIN_SCORE` 以上のもの。結果は記憶の状態の変更番号（`stateChangeSeq`）ごとに 1 つ覚えておき、変わらない間は計算し直さない |

## 6. 本番の記憶の掃除と、L1→L2 の移し替え

口は記憶の domain に置く（記憶は continuity と conversation を参照できる。複数の domain の保存は、記憶の writer の 1 つの transaction の中で、continuity の公開操作を呼ぶ）。Web・CLI・手順は API だけを使い、DB を直接開かない。

### 6.1 API（「記憶の掃除と移し替えの口」が作る）

| 口 | 入力 | 出力 |
| --- | --- | --- |
| `POST /api/memory/maintenance/residue/preview` | `{ "conversationPrefix": "eval-" }`（3 文字以上） | 対象の一覧と `digest`（一覧の内容の sha256） |
| `POST /api/memory/maintenance/residue/apply` | `{ "conversationPrefix": "eval-", "digest": "<preview の値>" }` | 行ったことの受領書（止めた記録・閉じた候補・閉じた予定と問いの ID と、直前の状態） |
| `POST /api/memory/maintenance/candidates/preview` | `{ "excludeConversationPrefix": "eval-" }` | 移せる候補の一覧と `digest` |
| `POST /api/memory/maintenance/candidates/apply` | `{ "candidateIds": [...], "digest": "<preview の値>" }` | 移した記録の ID、移せなかった候補と理由 |

`apply` は、今の一覧の `digest` が入力と違えば何も変えずに `maintenance_conflict`（409）を返す。確認した一覧と同じものだけが適用される。

### 6.2 対象を判定する規則

評価の会話は ID が `eval-` で始まる（評価リポジトリの `EVAL_CONVERSATION_PREFIX`。実行器は、それ以外の会話を拒否している）。

| 対象 | 掃除の対象になる条件 | 行うこと | 戻し方 |
| --- | --- | --- | --- |
| 記憶（L2） | 有効で、根拠の発言がすべて該当の会話にある | 停止（ライブラリの `deactivateState`） | 既にある `POST /api/memory/maintenance/apply`（`active: true`）に受領書の ID を渡す |
| 記憶（L2）で根拠が混ざるもの | 該当の会話とそれ以外の両方に根拠がある | 何もしない。一覧の `mixed` に出す | — |
| 候補（L1） | open で、根拠の発言がすべて該当の会話にある | 閉じる（ライブラリの `dismissCandidate`） | API では戻せない。バックアップから復元（§10） |
| 予定・意図・食い違い（L3 の `plan`・`intent`・`open_question`） | open か確認待ちで、根拠の発言がすべて該当の会話にある、または止める記憶だけに結ばれている | 閉じる（continuity の `closeInTransaction`） | API では戻せない。バックアップから復元 |
| 傾向（L4） | 根拠がすべて該当の会話にある | 停止（今の maintenance と同じ操作） | `POST /api/memory/maintenance/apply`（`active: true`） |
| 会話の発言・run・`steward_inbox`・問いかけの台帳 | — | 触らない（会話のログは消さない） | — |

適用の最後に、保存してある窓を消す（`purgeInTransaction`。次の入力で作り直される）。

移し替えの対象になる候補（すべて満たすもの）:

| 条件 | 理由 |
| --- | --- |
| open、`subject` が self、種類が L2 の 4 種 | L2 に書ける |
| 根拠がすべて利用者の発言で、外のメモ（`note:`）を含まない | 本人の発言に基づくものだけ移す |
| 根拠の発言が `excludeConversationPrefix` の会話に 1 つも無い | 評価の値を移さない |
| 根拠の発言が除外・取り消しされていない | 忘却を越えない |

上限で L1 に回った言葉と、推定として L1 に入った候補は、データからは区別できない（どちらも同じ操作で書かれた）。そのため一覧には両方が出る。一覧は本文・根拠の発言の原文・日時・会話を示し、統合役が利用者に見せて、移す ID を利用者が選ぶ。

移す操作: 候補の本文・種類・鍵・根拠の発言と引用で `rememberExplicit`（`requested: false`、`user_confirmed`）を書き、候補を閉じる。食い違い・忘却の途中などで拒否されたものは移さず、理由を返す。戻すときは、移した記録を `POST /api/memory/maintenance/apply`（`active: false`）で止める。

### 6.3 手順（実行は統合役が利用者に確認してから）

| 順 | 誰が | 行うこと |
| ---: | --- | --- |
| 1 | 利用者 | API を止め、`bun run db:backup` でバックアップを取り、API を起動する（`docs/operations.md`。起動中はバックアップが拒否される） |
| 2 | 統合役 | `residue/preview` を呼び、件数と一覧（`mixed` を含む）を利用者に示す |
| 3 | 利用者 | 一覧を確認して、実行を指示する |
| 4 | 統合役 | `residue/apply` を preview の `digest` で呼び、受領書を保存する |
| 5 | 統合役 | `candidates/preview` を呼び、一覧を利用者に示す |
| 6 | 利用者 | 移す候補を選ぶ |
| 7 | 統合役 | `candidates/apply` を呼ぶ。`GET /api/memory/items?all=1` で結果を確かめる |

掃除は、評価の分離（§7.1）が入った後に行う（先に掃除しても、本番に評価を流せばまた汚れる）。

## 7. 評価の分離

### 7.1 分離した backend につなぐ（「評価: 実行器と分離」）

| 項目 | 内容 |
| --- | --- |
| backend | 利用者が、空の `EUMENES_DB`（別のディレクトリ）と別の `EUMENES_PORT` で起動する。LARM の接続先など、要る設定は設定 API でその backend に保存する（本番の DB・設定・秘密をコピーしない） |
| つなぎ方 | CLI は `EUMENES_URL` を読む（`cli/index.ts`）。実行器に `--eumenes-url <URL>` を足し、`CliTransport` の `env` に `EUMENES_URL` として渡す |
| 守り | live の実行は `--eumenes-url`（または環境変数 `EUMENES_URL`）が無ければ拒否する。既定の `http://127.0.0.1:8787` と同じ URL も拒否する。新しい run の開始時に `GET <URL>/api/memory/items?all=1` を呼び、記憶が空でなければ拒否する（`--run-id` での再開は検査しない）。認証の要るときのトークンの渡し方は CLI と同じにする（未確認） |
| 記録 | `RunMeta` に接続先の URL を残す |
| 評価のための設定 | 分離した backend で、`POST /api/memory/settings` で枠と `recallEnabled` を切り替える。深い整理のために、整理の時間帯（設定の `memory.consolidationWindow`）の開始と終了を同じ時刻にし（終日）、話しかけの間隔（`agency.speechIntervalSec`）を最短にする |

### 7.2 ケース集で事柄の使い回しをやめる（「評価: ケース集と採点」）

| 項目 | 内容 |
| --- | --- |
| 規則 | 1 つの事柄（猫の名前・合言葉・引っ越し先・勤務先・予算・誕生日・好物・上司の名前・応援するチームなど）を、2 つ以上のケースで使わない。別のケースとは、事柄そのものを変える（値だけを変えない） |
| ケース ID | 変えない（§7.5 の対象の指定と、前の結果との対比のため）。区分ごとの件数も変えない |
| 検査 | `src/cases/cases.test.ts` に、全ケースの `mustContain`・`mustNotContain` の値と、利用者の発言の主な名詞の重なりを見る試験を足す。重なりの判定は、同じ値（variants を含む）が 2 つ以上のケースに出ないこと |
| 出来事を問うケース | 答えが会話のログにしか無いケース（音声認識の誤り・時間推論の一部）は、確認の問いを同じ会話に置き（`ask(..., { same: true })`）、間に別の話題の発言を足す。別の会話の発言は読まない決定のため |
| 生成物 | `bun run cases:build` で `cases/*.json` を作り直す |

### 7.3 採点の誤りの修正（「評価: ケース集と採点」）

| 対象 | 直し方 |
| --- | --- |
| 取り下げ（`withdraw.ts` の `gone`）と、同じ形の基準 | 「覚えていない・聞いていない」に加えて、「取り消した・削除した」と答え、値を言っていない返事も合格にする |
| `explicit-remember-003` の「千円」 | `mustNotContain` を `judge-if-hit` にする（記録したと述べたときだけ違反） |
| 音声認識の誤り | 想起できたか（値の文字列）と、誤認識をどう扱ったか（rubric）を別の項目にする。想起の失敗は不合格の理由として別に記録し、区分の集計で分けて出す |
| 較正 | 基準を変えたケースを `calibration-set.ts` に反映する |

### 7.4 統合の劣化で深い整理を起こす（「評価: 実行器と分離」）

深い整理の起動の条件（`kick.ts`）は、出来事が 20 以上（§5 の後は件数の増分でも）・その日にまだ走っていない・整理の時間帯の中・会話が休んでいる、のすべて。1 日に 1 回なので、ケースごとには起こせない。

| 項目 | 内容 |
| --- | --- |
| 流し方 | `probe.afterConsolidation` のケースをまとめて扱う: 全ケースの会話（sessions）を先に流す → 深い整理を 1 回待つ → 全ケースの確認の問いを流す。実行器に、この 3 段の進め方を足す（今はケースごとに `consolidate` を呼ぶ） |
| 待ち方 | 新規 `scripts/wait-deep.ts`: 分離した backend の読み取りの API で、開始後に閉じた深い整理の unit を確かめるまで待つ。上限の時間を過ぎたら失敗で終わる。`--consolidate-cmd "bun scripts/wait-deep.ts --eumenes-url <URL>"` で渡す。使える API は `GET /api/steward/decisions`（疑似会話 `steward:sleep`）の見込みだが、深い整理の完了がそこから読めるかは未確認。読めなければ統合役に報告する（本体に読み取りの口を足すかは別に決める） |
| 記録 | 整理を確かめた trial だけ `consolidationRan=true`。確かめられない間は、この区分を合否に数えない |
| 同じ日の流し直し | 2 回目は起動しない（1 日 1 回）。利用者が新しい空の DB で backend を起動し直す |

### 7.5 改善ごとの小さい流し方

すべて分離した backend、順に流す（並行 1）。live は利用者の開始の指示を受けてから。途中の失敗（エラー）は最初の 1 件で止めて直す。

| 改善 | 流すケース（`--case`） | 見ること |
| --- | --- | --- |
| 評価の分離そのもの | `--smoke` | 返事に別のケースの値が出ない。記憶の一覧にほかのケースと食い違う記録が無い |
| 冪等の鍵 | `relearn-009,withdraw-012,explicit-forget-001` | `request_conflict` が出ない。決定的な違反が無い |
| 照合と順位付け | `extraction-008,extraction-012,multi-session-inference-002,update-010,retention-011,abstention-001,abstention-002,sycophancy-001` | 記録が見つかる。棄権・迎合が悪くならない |
| 上限の撤廃と常時の区画 | `relearn-001,relearn-002,relearn-006,relearn-010,proactive-use-006,proactive-use-008,proactive-use-010,retention-010,sycophancy-003,sycophancy-008,abstention-001` | 新しい事実と応答の好みが返事に出る。枠 1,000・2,000・4,000 で、区切り直後の最初の音までの時間と `dialogue.input_cut` の理由ごとの回数を比べる |
| `## Recall`（区画なしとありの 2 回） | `temporal-006,temporal-010,update-006,update-009,relearn-002,relearn-004,multi-session-inference-006,multi-session-inference-011,asr-error-001,asr-error-004,abstention-001,abstention-002,abstention-003,sycophancy-001,sycophancy-002,suppress-001,explicit-forget-001` | 同じケースの対比較。遅延 p95。採否は利用者が決める |
| 似た記録 | `explicit-remember-001,explicit-remember-002,update-012,temporal-012` | 重複が増えない。別の事柄を同じと見なさない |
| 統合の劣化 | `--category consolidation-regression`（§7.4 の流し方） | `consolidationRan=true` で、整理の前（`--consolidate-cmd` なし）と比べる |

## 8. 受入の条件

fixture と live を分けて記録する。全件を流すのは最後に 1 回だけ。

### 8.1 fixture（実装した単位と統合役）

| 単位 | 条件（試験に書くこと） |
| --- | --- |
| 記憶の検索・上限・印 | 有効な記録が 100 件を超えても、背景のパスの書き込み（`requested: false`）・整理の書き込み・seed・再有効化が拒否されない。改善設計 §2.3 の組が当たる（「猫 名前」と「猫の名前はミル」、1 文字の語、文で書いた問い）。関係の強い記録が、語を 1 つだけ共有する記録より先に並ぶ。`audience: "host"` は抑制された記録を返さず、印のある記録は `direct` のときだけ返す。訂正した記録の `previous` に旧い本文と失効の日が出る。印が訂正で引き継がれ、忘却で消える。鍵が違い本文が同じ 2 回の「覚えて」が 1 件になる。似ているが違う本文は保存され `similar` が返る。枠の設定を保存すると `revision` が上がる。migration 2 つが前の版から上がる |
| 記憶の掃除と移し替えの口 | preview は何も変えない。apply は digest が違えば何も変えない。根拠が混ざる記録は止めない。止めた記録が既存の maintenance で戻る。候補の移し替えは、評価の会話の根拠・外のメモの根拠・除外された根拠を持つ候補を一覧に出さない。移した記録は `user_confirmed` |
| 会話の入力 | 常時の区画に本人の事実が載り、印のある記録・推定・傾向は載らない。枠を超えると、制約 → 好み → 習慣 → 事実の順に残る。同じ記録なら同じ並び・同じ文（digest が変わらない）。`recallEnabled` が false なら入力は `## Recall` を含まない。true のとき、常時の区画の記録は「記憶」の行に出ず、旧い版は「以前」、結ばれた `open_question` は「食い違い」に出る。抑制の語に触れる行は出ない。`## Recall` は履歴に残らない。`## Recall` で見た記録を忘却すると、実行中の返事が破棄される。`read_memory` の語なしは常時の区画の記録を省く |
| `memory` ツール | 2 つの会話で、同じ発言の番号・同じ ref の忘却が両方通る。同じ run の再呼出しは二重に適用されない。`similar` が ref で返る。`sensitive`・`subject: other` が印として保存される |
| 背景のパスの書き込み | 100 件を超えても `memories` が L2 に入り、候補にならない。`subject` が self 以外の記録に `aboutOther` が付く。関係する記録が `recall` の順で渡る |
| 整理のきっかけ | 基準が NULL の最初の kick は起動しない。件数の増分・似た組の増分で、時間帯と 1 日 1 回の条件の中で深い整理が起動する。完了で基準が書かれ、同じ件数では次の日に起動しない |
| 評価の 2 単位 | 同じ事柄が 2 つのケースに出ない試験が通る。`withdraw-002` と `explicit-remember-003` の実際の返事（改善設計 §2.5・§2.6）が合格になる。`--eumenes-url` なしの live、既定の URL、記憶が空でない backend を拒否する。まとめて流す 3 段が模擬の CLI で通る |
| 統合役 | `bun run verify -- --domain memory`、`--domain dialogue`、`--domain steward`、`--domain continuity`、`bun test api/application/agency/always-on-records.test.ts`、`bun run context:check`、`bun test api/application/fixed-input-size.test.ts`、評価リポジトリの `bun run verify` |

### 8.2 live（利用者の開始の指示の後、分離した backend）

| 条件 | 内容 |
| --- | --- |
| 小さい流し方 | §7.5 の各行を流し、行ごとに結果を記録する |
| 決定的な違反 | `relearn-009`・`withdraw-012` で違反が出ない |
| 悪くしない | 棄権・迎合・抑制・明示の忘却のケースで、改善の前に合格だったものが不合格にならない |
| `## Recall` の採否 | 区画なしとありの対比較の結果と遅延 p95 を利用者に示し、利用者が決める。入れると決まったら、分離した backend と本番の設定を `recallEnabled: true` にする |
| 枠 | 計測の結果を示し、利用者が値を決める。決めた値を本番の設定に保存する |
| 全件 | 上が済んだ後に 1 回だけ流す。合格率の目標の数字は置かない（前の結果は混入を含み、比べる基準にならない）。区分ごとの結果と不合格の主因を記録する |
| 本番 | §6 の掃除と移し替えを行い、`GET /api/memory/items?all=1` に評価の値が無いことを確かめる |

## 9. 記憶ライブラリと `eumenes_agency` を変えない理由

| 要ること | 既にあるもの |
| --- | --- |
| 失効した版を読む | `readStateFact`（同じ事柄の全版）、`listStateByTime`（`supersededAtMs`） |
| 記録を止める・戻す、候補を閉じる | `deactivateState`・`reactivateState`、`dismissCandidate` |
| ほかの人の記録の区別 | 抽出の出力の `subject`（`ExtractedMemory.subject`）。本体の `writeRecords` が今は捨てている |
| 機微な情報を背景のパスが書かない | `extract.ts` の指示に既にある |

保留の単位（変更の宣言）だけが `eumenes_agency/src/agenda/extract.ts` の変更を要る。

## 10. 危ない点と、確かめられなかったこと

| 項目 | 内容 |
| --- | --- |
| 既にある記録の印 | 印が無いので、既にある機微な記録・ほかの人の記録は常時の区画に載りうる。掃除の後に残る本人の記録を、利用者が `memory all --json` で見て、載せたくないものを抑制するか忘れさせる |
| 候補・予定・問いの戻し方 | 閉じた候補と予定・問いを開き直す操作が無い（ライブラリと continuity に無い）。戻すにはバックアップからの復元になる。開き直す口を足すかは利用者の判断 |
| 順位付けの定数 | `RECALL_MIN_SCORE`・`SIMILAR_MIN_SCORE`、ひらがなだけの 2 つ組を数えない規則は、固定の試験の組で決める仮のもの。関係の薄い記録が `## Recall` に出ると棄権・迎合が悪くなる。対比較で見る |
| 語が違う問い | 「資格」と「試験に合格した」は、この照合では当たらない。常時の区画が受ける。枠を超える規模では別の方式が要る（改善設計 §10） |
| 区切りの回数 | 本人の事実が常時の区画に載ると、訂正のたびに区切りが入る。`dialogue.input_cut` の回数で確かめる |
| 似た組の数え方の重さ | 件数の 2 乗の比較。数百件までは変更番号ごとに 1 回で足りる見込み。1,000 件を超える前に全文索引へ |
| 「記憶の掃除と移し替えの口」の試験 | 配線（`service/index.ts`）を統合役が後で入れるので、試験は `createMemoryResidue` を直接組む。`memory.fixture.ts`（読むだけ）から要る依存が取れるかは未確認。取れなければ統合役が先に配線を入れる |
| 深い整理の完了の確かめ方 | `GET /api/steward/decisions` で読めるかは未確認（§7.4） |
| 評価の実行器の認証 | 分離した backend にトークンを設定した場合の、実行器からの `GET` の認証は未確認 |
| `routed-actions.ts` の 2 回目の入力 | prepare で選んだ `## Recall` の行をそこへ渡す経路は、`GenerateInput` に欄を足して通す想定。今の受け渡しの形は確かめていない |
| `read_memory` の説明文の場所 | 並びや件数を述べた文があるかは確かめていない（§3） |
| 別セッションとの重なり | `.s11tnext/**` の生成物と `api/application/server-*.ts` は別セッションが変更中。本書の単位は配線（`server-wiring.ts`・`server-services.ts`）を変えない作りにしてある（枠の設定を記憶の domain に置いた理由）。生成物だけ統合役が調整する |
| 道具の定義の変更 | `memory` ツールに引数 2 つを足す。作り直し設計 §0「記憶のツールは増やさない（引数は足す）」の範囲 |

## 11. 実装の記録（2026-11-23）

6 つの単位を coder が並列で実装し、統合役が共有ファイルを編集した。独立レビュー 1 回（重大 1・中 6・軽微 8）の指摘は、修正 1 回でまとめて直した。

| 検証（fixture） | 結果 |
| --- | --- |
| `bun run verify -- --domain memory` / `dialogue` / `steward` / `continuity` / `goals` / `inference` | 255 / 729 / 135 / 95 / 59 / 312 件、すべて合格 |
| `bun test ./api/application/agency ./api/application/memory-host*.test.ts` | 193 件合格 |
| 評価リポジトリ `bun run verify` | 363 件合格 |
| `bun check`・`bun run size:check`・`context:check`・`fixed-input-size` | 合格（固定の入力は記録し直した） |

| 本書との違い | 実装 | 理由 |
| --- | --- | --- |
| 設定の保存と `policyRevision` | 枠・範囲・`recall*` の保存は `policyRevision` を上げない（`enabled` の変更だけ上げる）。窓の作り直しは `WindowInputs.budgetKey`（`alwaysTokens:alwaysScope`）で行う | 出どころの印が `policyRevision` を含むため、枠を保存するたびに保存済みの返事が古いと判定され、履歴から消えていた（レビューの重大） |
| 語に読めない問い | 空でない問いが語に読めない（「あ、え、」や句読点だけ）ときは 0 件。空文字だけが全件 | 音声の言いよどみが全件を返さない |
| 1 文字の語 | 漢字・カタカナ・英数だけ。ひらがな 1 字は語にしない。問いは先頭 200 字 | 音声の「あ」「え」が全記録に当たる雑音と、長い発言の計算量 |
| 似た記録 | `similarityOf`（score ÷ 語数、0〜1）が `SIMILAR_MIN_SCORE`（0.6）以上。抑制済みの記録は `similar` に出さない | 語の数で値が膨らまない。抑制した記録の存在を漏らさない |
| 印の読み出し | 記憶の公開操作 `marksInTransaction(db, itemIds)` を足した。Agency の自発の話しかけ（`knownFor`・`readMemoryRefs`）は印のある記録を除く | 自発の話しかけに機微・ほかの人の記録が入っていた |
| 同じ値の再確認で印が増えた | `state_correct` を記録して窓を区切る | 「これは機微」と言い直しても `## Memory` に残っていた |
| 掃除 `candidates/apply` の入力 | `excludeConversationPrefix` を足した（必須） | digest を一覧全体で計算するため、適用時に同じ一覧を作り直す値が要る |
| 掃除の接頭辞 | `eval-` で始まるものだけ受ける | 利用者の会話を誤って選ばない |
| 掃除で訂正の旧版を戻す | 止める版が置き換えた旧い版で、根拠が評価の会話の外のものは、同じ transaction で新しい有効な版として書き直す（`restores`・`restoredStates`）。戻すときは、新しい版を止めてから止めた版を戻す | 評価の会話が本人の記録を訂正していると、その事柄の有効な記録が無くなっていた |
| 整理の基準 | 今の数が基準より小さければ基準を下げる（その kick では起動しない） | 忘却・掃除の後に起動しなくなっていた |
| 評価の分離 | 偽 CLI 以外は `--fixture` でも分離の検査をする。既定の URL と同じとみなす綴りを広げた（IPv4 射影・`0.0.0.0`・機器名・自機のアドレス）。`GET /api/memory/status` の `healthy` も見る。深い整理は会話の段の後に始まったもの（`createdAt − durationMs`）だけ数える | 本番の backend に流れる経路を塞ぐ |

残り（直さなかった軽微）: 印は付けるだけで外す口がない。`direct` は句読点のない文ではほぼ立たない（機微・ほかの人の記録が `## Recall` に出にくい安全側）。古い記録が窓に混じったときだけ、`## Memory` の出どころの判定が記録ごとになる。
