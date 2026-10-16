# World Model を記憶担当（steward）につなぐ実装計画

2026-10-14 / 状態: **計画**（未実装・未検証）/ 改訂4＋実装時の変更（§18）。実装済み・fixture 検証中。
前提: [記憶担当の実装計画](.archived/memory-steward-implementation-plan-2026-10-14.md)（実装済み。以下「steward 計画」）、[World の host 側の説明](../api/domains/world/README.md)、World Model パッケージの設計書（`../eumenes_world_model/spec/world-model-design.md`）。
実装形態: steward 計画と同じく TypeScript で直接実装する。会話エージェントが呼ぶツール（`world_query`）と設定画面の閲覧だけは、toolchain・bundle の手順（[登録と拡張の手順](../docs/toolchain-extension.md)）に載せる。

---

## 0. 現状の診断（2026-10-14）

| # | 事実 | 根拠 |
|---|---|---|
| W1 | World は **OFF**。`EUMENES_WORLD` が未設定。表はあるが中身は0件（`world_entity`、`world_inbox`、`world_host_extract_event` が0件）。World のログもない | `api/infrastructure/config.ts:36`、`data/eumenes.sqlite3` |
| W2 | 会話から World へ事実を抜き出すのは、steward とは**別の背景ジョブ** `world.extract`。同じ会話を2つのエージェントが別々に読む構造になっている | `api/domains/world/service/extraction-handler.ts`、`README.md` の Local extraction |
| W3 | `world.extract` は Local（LARM）専用。prepare で推論の route が `larm-only` で cloud 不可でなければ `local_provider_required` で止まる | `extraction-prepare.ts:256-283` |
| W4 | 主語（対象）の照合に必要な**対象の一覧**を、パッケージが提供していない。製品の既定ではすべての主語が `SUBJECT_UNRESOLVED` として**保留**される。ON にしても事実が入らない | `README.md` の「What is fixture-grade」、`application/world.ts:189` |
| W5 | 推論の問い合わせ `world.query`（関連・影響・依存・比較・不足）は実装済みだが、会話エージェントのツールとして**未登録** | `service/world-query-tool.ts`、`README.md` P5-01 |
| W6 | 主張の一覧・詳細の画面に、手動の訂正・取り消し・忘却の操作がある（`POST /api/world/claims/correct|retract|forget`、bundle `settings-world`） | `controller/claims.ts`、`capabilities/bundles/settings-world.bundle.json` |
| W7 | 会話の発言を忘れる製品の経路がない（`conversation.retract` も Memory の host source の忘却も、製品からは呼ばれない）。World は会話の outbox の `retracted` で source を忘れる作りだが、steward の除外台帳（メッセージを記憶・文脈に使わない）は会話の原文を変えないので、World には伝わらない | `README.md`、`service/lifecycle-feed.ts:185-215` |
| W8 | 目標の domain `goals` はあるが、server で組み立てられていない（`createGoalsService` を呼ぶ製品コードがない）。表は0件。Broker は `goalSnapshot` を読むだけ | `api/domains/goals/README.md`、`service/context-broker.ts:292` |
| W9 | 回答の文脈に World を差し込む Broker（`worldContext`）は dialogue に接続済み。World を使う回答は採用まで本文の公開を保留する | `dialogue/service/generation-handler.ts:154`、`context.ts:124` |
| W10 | World の ON/OFF/protect は環境変数で決まる。OFF に戻すと忘却の伝播も止まる（内容が残っているなら protect にする必要がある） | `README.md` の Assembly |

## 1. 決定事項（ユーザー合意済み）

| # | 決定 |
|---|---|
| G1 | World の更新・検索にも **cloud の API を使ってよい**（LARM がない環境もあるため）。steward と同じく、会話と同じ route を使う（steward 計画 K7） |
| G2 | World の読み書きは**記憶担当（steward）が兼任**する。失敗が続くようなら分けることを検討する（分けられる形にしておく） |
| G3 | World の主張を利用者が手で変える機能は持たない。**閲覧（観測）だけ**できる |
| G4 | 目標（Goals）も **steward が登録・保守**する。本人からの依頼（依頼キュー）でも変更できる |
| G6 | `world.extract` を廃止し、steward に一本化する |
| G7 | 目標は**期限で自動的に取り下げない**。採用済みの目標は本人が終えた・やめたと分かるまで残す（数年かかる目標もある）。推測から作った提案も期限では消さず、手入れで見直す |
| G8 | World の使い方は3つの組み合わせ（§4）: ①採用済みの目標は常に文脈に置く、②本人の発言に出た既知の対象は**ホストが名前・別名の一致で決定的に引き**、その状態と直接の因果・依存を回答の前に文脈へ入れる、③深い推論は会話エージェントが必要なときに `world_query` で引く。対象を LLM で毎回選ぶ step は作らない |
| G9 | World の ON/OFF は再起動で反映してよい。原則として常用する |
| G10 | 推論の省略は **curate-memory の出力に振り分けの判定を足す**方式（A）。curate-memory が往復ごとに「World の処理が要るか」「目標の処理が要るか」を返し、要らないときだけ curate-world / curate-goals の推論を省く。判定が読めないときは「要る」として扱う |
| G5 | steward 計画の K8（profile・モデル名を固定しない）、K9（互換層を作らない）、K10（機能が揃ってから live で観測）、K12/K13（忘却は原文を残し、再利用を禁止する）を World にも適用する |

## 2. 全体像

### 2.1 棚の分担（何をどこに置くか）

| 棚 | 入れるもの | 例 | 書き手 |
|---|---|---|---|
| 長期記憶（Memory State） | **本人について**のこと | 辛い物が苦手、仕事はエンジニア | steward（curate-memory） |
| World | **本人の外の世界**の、状態・関係・因果・依存・予測と結果 | 「Eumenes の記憶は steward が管理している」（状態）、「この作業は LARM の接続に依存する」（依存）、「cache を入れると応答が速くなりそう」（仮説） | steward（curate-world） |
| 目標（Goals） | 本人が目指すこと | 「音声応答の遅延を減らしたい」 | steward（curate-goals） |
| 短期メモ・要約 | 今の会話の流れ | 今調べている店 | steward（既存） |

- 同じ事実を Memory と World の両方に書かない（World の設計書 §2「二重管理を区別する」）。本人の好み・習慣は Memory、それ以外の世界の解釈は World。
- 本人の発言は「本人がそう報告した」根拠（`origin: user_report`）として World に入る。アシスタントの説明・推測は `model_hypothesis`（仮説）として入り、本人の報告や観測に格上げしない。

### 2.2 流れ（steward 計画の反映サイクルに step を足す）

```
run の終わり → 往復の台帳（既存）
                  ▼
反映 step（往復ごと。この順で連鎖する）
   curate-memory（振り分けの判定を出す: §3.4） → curate-goals（新） → dispose-exchanges → summarize
World の event の単位（往復の連鎖とは別。World の受付が起点: §3.1）
   curate-world（新）
付随 step
   prepare-recall（既存。World の対象選びは LLM を使わない: §4.1）
手入れ step（反映すべきものがないとき）
   consolidate-memory、compact-history、refine-summary、consolidate-world（新）、consolidate-goals（新）
```

- 新しい step（curate-world、curate-goals、consolidate-world、consolidate-goals）は steward 計画の `StewardStep` の形で足す（steward 計画 §2.2 で用意済み）。
- **curate-world は往復の連鎖に入れない**。往復の完了（3つの印）は World を待たない。World の受付（feed）の遅れ・初回の同期・訂正版の到着は往復と別の時期に起きるため、World の受付済み event を対象にした別の実行単位にする（§3.1）。
- **G2 の「分けられる形」**: World の step は steward の単位・判断記録・忘却の再検証をそのまま使うが、World 固有の処理（候補の検証、保存、採用）は world domain の公開操作に閉じる。将来 World 担当を分けるときは、step の呼び出し元を別のエージェントに移すだけで済む。

### 2.3 domain の依存

```
steward ──▶ memory, continuity, conversation, world（新）, goals（新）
world   ──▶ memory, conversation, goals（既存）
dialogue ─▶ memory（既存）。World の Broker は今と同じく port で受ける
```

steward は world の上位なので、steward から world・goals の公開操作を呼べる（steward 計画 §2.1 の想定どおり）。`scripts/domains.ts` の steward の依存に `world`、`goals` を足す。

## 3. 抽出の一本化（W2・W3・W4）

### 3.1 `world.extract` を廃止し、steward の `curate-world` に置き換える

| 段階 | 今（`world.extract`） | これから（`curate-world`） |
|---|---|---|
| 入力の受付 | 会話の outbox → World の inbox（決定的。取り消し・訂正の反映も含む）。受け付けるのは**ユーザーの追加・訂正発言だけ**（`extraction-intake.ts:65` の `isExtractionInput`） | feed の consumer は残す。**採用されたアシスタントの回答も受け付ける**（§3.1.1） |
| 起動 | World の `pump()` が未処理の inbox を見て1ジョブを積む | feed の consumer が event を受け付けた transaction の後で `steward.kickInTransaction` を呼ぶ（port。§3.1.2） |
| 単位 | 1ジョブ = Scope ごとの最古の event（最大12件） | steward の実行単位の新しい種類 `world_events`。対象は World の受付済み・未処理の event（最大12件 / 32KiB）。単位の識別は (Scope, event ID の集合, 試行の連番) |
| prepare | 入力窓の作成、Memory の外部依存の登録、推論 request の取得（Local の証明が必須） | 同じ処理を **world の公開操作** `prepareCurationInTransaction` として切り出して呼ぶ。Local の証明は外す（G1）。推論は steward の route（会話と同じ、cloud 可） |
| 推論 | 候補だけを返させる | 同じ。schema は strict 互換（steward 計画 §4.2 L5） |
| settle | `validateCandidates` → `candidate.settle`。ID・時刻・根拠はホストが付ける | 同じ処理を `settleCurationInTransaction` として切り出して呼ぶ。**World の確定、採用（§3.3）、steward の単位を閉じること、判断記録を1つの transaction で行う**。どれかが失敗すれば全部 rollback |
| 保留 | `held` の候補があると窓全体を保留 | 同じ規則を使う。同じ窓が3回保留になったら、その event を `rejected`（理由 `STEWARD_GAVE_UP`、最終）で終わらせ、後続の event を止めない |

#### 3.1.1 アシスタントの回答の受付と、話者と origin の整合

- `isExtractionInput` を「ユーザーの追加・訂正」に加えて「**採用されたアシスタントの回答**の追加」も受け付けるように変える。会話に残るアシスタントのメッセージは、採用された回答だけ（取り消し・失敗した run は回答のメッセージを作らない）なので、未採用の回答は入らない。それでも host は、メッセージの run が `completed` であることを受付時に確かめる。
- 話者と origin の組み合わせをホストが検証する: ユーザー発言を根拠にした主張は `user_report`、アシスタントの回答を根拠にした主張は `model_hypothesis` だけ。組み合わせが違う要素は捨てる（理由 `origin_mismatch`）。アシスタントの回答から `user_report` を作らない。
- 除外台帳（steward 計画 §6）にあるメッセージは受け付けない（受付時と prepare 時の両方で確かめる）。

#### 3.1.2 受付と起動の契約

| 場面 | 扱い |
|---|---|
| 往復は終わったが、feed がまだその発言を受け付けていない | curate-world の単位は作られない（対象の event がまだない）。feed が受け付けた後の kick で作られる |
| feed の受付 | 受付の transaction が commit された後、World の assembly が `steward.kickInTransaction(db, conversationId)` を呼ぶ（application で配線する port） |
| 初回の ON（初期同期） | 今の規則のまま、ON の前の発言は `skipped` として記録し、**さかのぼって抽出しない**。curate-world の対象にもならない |
| 処理済みの発言の訂正 | World の受付が決定的に古い主張を止め（既存）、訂正版を新しい event として受け付ける。curate-world は新しい event として処理する |
| 取り消し・忘却された発言 | 既存の受付の規則どおり、event は抽出の前に `rejected` になる |
| 再起動 | steward の起動時の kick が、未処理の event を持つ Scope の単位を作る |

- `world.extract` のジョブ種別、`createWorldExtraction`、`extraction-handler.ts`、`extraction-execute.ts`、slot の管理、`pump()` からの schedule を**削除**する（K9）。prepare/settle の中身は world の公開操作として残す。
- 既存の `world_host_extract_event`（host の記録）は、`world_events` の単位の対象として使い続ける。単位の冪等性は event の状態（未処理のままか）で判定する。
- 抽出の上限（12発言 / 32KiB / 依存32件 / 候補8件）は world の公開操作の中で今のまま強制する。steward の入力上限（4往復 / 16KB）の方が小さいので、通常は World の上限に達しない。

### 3.2 対象の一覧（W4）— パッケージの変更

| # | 変更 | 場所 |
|---|---|---|
| E1 | `eumenes-world-model/sqlite` に、Scope 内の対象を読む公開 API `listEntities(db, { contractVersion, access, scopeKey, query?: { kind?, aliasPrefix?, ids? }, limit })` を足す。忘却済み・統合済みの扱いは既存の規則（tombstone は返さない、統合先を返す） | `../eumenes_world_model`（別リポジトリ）。試験と spec（`world-sqlite-public-api.md`）も更新する |
| E2 | パッケージを再配布し、Eumenes の vendor を更新する | `package.json`、`bun.lock`（vendor の tgz）。版は patch だけ上げる |
| E3 | host 側は `extraction.entities` に `listEntities` を渡す。curate-world の入力には、往復の言葉に近い対象（別名の前方一致と、最近使った対象）を最大30件だけ見せる | `api/application/world.ts`、world の公開操作 |

- モデルは、見せた対象の ref（`w1`〜）を使うか、新しい対象の登録を提案する。同名だけで統合しない。候補が複数あれば未解決のまま保留する（World の設計書 §3 の規則のまま）。

### 3.3 採用（G2）

| 主張の種類 | 扱い |
|---|---|
| 本人の発言を根拠にした状態・関係（`user_report`） | steward が採用する（`active`） |
| アシスタントの説明・推測（`model_hypothesis`） | 採用しても `hypothesis` の印のまま使う（World の claimTone の規則） |
| 既存の主張と矛盾する本人の発言 | 既存の主張を supersede し、新しい主張を採用する（今の `correctInTransaction` と同じ処理を steward が呼ぶ） |
| 本人が「それは違う」と言った主張 | retract する |

採用・訂正・取り消しは、すべて steward の判断記録に残る。

### 3.4 推論の振り分け（G10）

- curate-memory の出力に `route: [{ "exchange": "e1", "world": true|false, "goals": true|false }]` を足す。指示文: 「本人の外の世界（プロジェクト、サービス、物、場所、他の人、状態、原因と結果、依存）が出てくる往復は world を true。目標・やりたいこと・やめたことが出てくる往復は goals を true。迷ったら true」。
- `world: false` の往復の event は、curate-world の推論をせずに `empty`（候補なし）として settle する。`goals: false` の往復は curate-goals を飛ばす（印は `done`）。
- 判定が欠けている・読めない往復は `true` として扱う（取りこぼさない側に倒す）。
- **判定は発言の版に結び付ける**: 判定を、判定した時点の発言の revision と digest の組で記録する（`steward_route(message_id, revision, digest, world, goals)`）。World の event の revision・digest と一致しないとき（訂正版など）は `true` として扱う。
- **feed が判定より先に届いた場合**: その往復の curate-memory が終わるまで、event を対象にした curate-world の単位は待機する（prepare で「判定待ち」として単位を作らない）。curate-memory の settle の後に kick する。往復が curate されないと決まった場合（skipped、memory が無効、往復が登録されない run）は `true` として扱う。
- 振り分けの結果は判断記録に残す。live で「false にしたが実は世界の情報があった」率を測り、指示文を調整する。

## 4. 使う（W5・W9）

### 4.1 常に・自動で使う（G8 の①②。LLM は使わない）

| 層 | 中身 | 決め方 | 置き場所 |
|---|---|---|---|
| ① 目標 | 採用済みの目標を**優先度の高い順**に、1件 **120文字**で切り詰めて並べる（最大 2KB）。入り切らない分は「ほか N 件」と件数だけ示す。全件の要約は作らない（改訂のたびに文面が変わり cache が崩れるため） | goals の `goalSnapshot`。変わるのは目標の採用・改訂・優先度の変更・完了・取り下げのときだけ | **L1 の直後**（変わりにくいので前の方。prompt cache が効く）。目標が変わったときだけ作り直す |
| ② 話題の対象 | 本人の今回の発言と直前の往復に出た**既知の対象**の、今の状態と直接の因果・依存（1段）、根拠の種類と鮮度（最大 4KB、対象は最大5件） | ホストが対象の名前・別名を発言の中で探す（`listEntities` の別名一覧を使った決定的な一致。正規化して最長一致）。曖昧な一致（同じ別名の対象が2つ以上）は入れない | **L4**（今の World の位置。毎回変わるので末尾） |

- ②は回答の prepare で Broker が作る（今の Broker の WorldSlice の仕組みに「発言の中の対象」を起点として渡す）。steward の Window には何も足さない。
- 既知の対象が発言になければ②は空（今と同じ既定の動作）。
- 予算は World の既存の予算配分（`CONTEXT_TOTAL_BYTES`）の中で、①と②を合わせて最大 6KB。①は必ず入れ、②は残りで入るだけ入れる。

### 4.2 質問されたとき：会話エージェントのツール `world_query`

- `createWorldQueryTool`（実装済み）を toolchain として登録する（bundle と adapter）。使える mode は `snapshot`、`relevance`、`influence`、`dependencies`、`scenarios`、`gaps`。
- 結果は参照データで、操作の許可にはならない（`executionPermission: "none"` のまま）。
- `linkGaps`（不足を作業に変える）は使わない（実際の Tasks domain が受け付けないため。W5 の README の記述）。

## 5. 目標（G4・W8）

| # | 内容 |
|---|---|
| O1 | server で `createGoalsService` を組み立てる（今は誰も作っていない） |
| O2 | 反映 step `curate-goals`: 往復と今の目標の一覧から、目標の登録・改訂・完了・取り下げを決める。本人が「〜したい」「〜を目指す」と言ったものは採用、会話の流れから推測したものは**提案**（goals の既存の区別）。**期限による自動の取り下げはしない**（G7）。完了・取り下げは、本人が終えた・やめたと言ったとき、または明らかに達成・不要になったことが会話から分かったときだけ |
| O2b | 手入れ step `consolidate-goals`（`consolidate-world` と同じ手入れの枠）: 提案の重複をまとめ、明らかに古くなった提案を取り下げる。提案が上限（50件）に近づいたら、関係の薄いものから取り下げる。採用済みの目標は手入れで取り下げない（本人の言葉が要る） |
| O3 | 依頼キューの kind に `goal` を足す（「この目標はもう終わった」など）。steward 計画 §3.4 の状態遷移をそのまま使う |
| O5 | **目標の根拠の追跡**: 目標の各改訂に、根拠にした発言（会話メッセージ ID）と、関係する World の対象（`serves_goal` の関係の相手）を記録する（goals に表を足す: `goals_source(goal_id, revision, message_id)`、`goals_entity(goal_id, entity_id)`）。完了・取り下げ済みの目標と、`goals_history` の改訂の由来も対象 |
| O4 | goals の既存の上限（提案50、採用30）、operationKey（再送の冪等性）、revision・epoch の検証は変えない。operationKey は steward の単位 ID と要素の番号から作る |

## 6. 忘却（W7・G5）

| # | 内容 |
|---|---|
| F1 | steward 計画 §6 の忘却で除外台帳に入れたメッセージを、**同じ transaction で World の source の忘却として受け付ける**（`lifecycle.acceptForgetInTransaction`、roots は `{ kind: "source", id: <会話メッセージの source key> }`、reasonCode `SOURCE_BLOCKED`、origin `steward`）。commit の後に `resumeForget` で進める（World の既存の流れ） |
| F2 | Memory の State を忘れたときの World への伝播は、既存の `lifecycle-forget-memory` のまま |
| F3 | 依頼キューの「忘れて」で World の主張も消せるようにする。curate-memory の入力に World の主張の ref（`c1`〜、対象と述語と値の短い文）を足し、`resolve.refs` で指せるようにする。主張の忘却は `forgetInTransaction`（World の既存の公開操作）で受け付ける。1件の依頼で消せる上限は、Memory と合わせて5件 |
| F4 | 対象（entity）ごと忘れる依頼（「〇〇プロジェクトのことは全部忘れて」）は、entity の忘却（パッケージの既存機能。関係先・統合された配下まで届く）として受け付ける |
| F7 | **World からの忘却を会話へ戻す**: World の主張・対象を忘れるとき（F3・F4）、その主張の根拠の発言（`world_evidence` の会話の source）を world の公開操作 `evidenceMessagesOf({ claimIds, entityIds })` で取り出し、**記憶の除外台帳に入れる**（memory の `forgetInTransaction` を `messageIds` だけで呼ぶ。メッセージだけの忘却なので、そのメッセージを根拠にした他の記憶は消えない: steward 計画 §14.3 の1）。要約・turn vector・判断記録の削除は memory の既存の経路に乗る |
| F8 | **目標の忘却**: 次の目標を、改訂の履歴（`goals_history` と §5 O5 の表）ごと削除する。(a) 依頼で名指しされた目標（curate-memory の入力に目標の ref `g1`〜 を足し、`resolve.refs` で指せる）、(b) 忘れる World の対象に結び付いた目標（`goals_entity`）。忘れる内容そのものを文面に含む目標は、steward が (a) として名指しする。**同じ発言を根拠にしていただけの目標は消さない**（記憶と同じ規則）。完了・取り下げ済みの目標も対象 |
| F10 | **目標の忘却も会話へ戻す**: 目標を忘れるとき（F8）、その目標の**全改訂の根拠の発言**（§5 O5 の `goals_source`）を、記憶の除外台帳に入れる（memory の `forgetInTransaction` を `messageIds` で呼ぶ）。要約・turn vector・判断記録の削除と `forget_seq` の更新は既存の経路に乗る。同じ発言から作った他の目標は残す（F8 の規則） |
| F11 | **目標の忘却の耐久記録**: block journal の1行（steward 計画 §5.1）に `derived: { goalIds: string[] }` を足す。memory は `derived` を解釈せずに保存し、purge hook に渡す。起動時の照合（steward 計画 §6.4）では、journal の行ごとに steward の hook が目標の削除（履歴と §5 O5 の表を含む）をやり直す。照合が終わるまで memory の `ready()` は false で、回答は再開されない。World の主張・対象の忘却は World 自身の journal が持つ（既存） |
| F9 | 目標の層（①）は、目標の忘却で作り直す（immediate change として扱い、生成中の回答はその目標を使っていれば `memory_stale` になる）。忘却と重なった curate-goals / consolidate-goals の結果は `forget_seq` の照合で採用しない |
| F5 | steward の判断記録の削除は、World の主張・対象の ref も `steward_decision_ref` に書き、忘却で消す（steward 計画 §6.2 と同じ） |
| F6 | 忘却と重なった World の step の結果は採用しない。`forget_seq` に加え、World の forget epoch を単位に記録して settle で照合する |

## 7. 手動変更の削除と閲覧（G3・W6）

| 対象 | 削除するもの | 残すもの・足すもの |
|---|---|---|
| HTTP | `POST /api/world/claims/correct|retract|forget` | `GET /api/world/status`、`/claims`、`/claims/:id`、`/forgets` |
| bundle `settings-world` と adapter | 訂正・取り消し・忘却の action | 一覧・詳細・忘却の進み具合の表示。判断記録（steward の World の step）へのリンク |
| service | `world-claims-changes.ts` の `correct/retract/forget` の外部向けの入口 | 同じ処理の内部の公開操作（steward が使う） |

## 8. ON/OFF を設定にする（W10）

- `EUMENES_WORLD` を廃止し、SQLite の設定項目 `world.enabled`（true/false）にする（環境変数を設定へ移す方針の先取り）。
- OFF でも、World に内容が残っている間は自動的に protect（忘却の伝播だけ動く）にする。利用者が「OFF に戻すと忘却が止まる」ことを意識しなくてよくする。
- 切り替えは backend の再起動で反映する（初回の同期と gate の扱いが起動時の処理のため）。設定画面に「再起動で反映」と出す。
- `EUMENES_WORLD_JOURNAL`、`EUMENES_WORLD_POLL_MS`、`EUMENES_WORLD_CURSOR_SECRET` は今回は変えない（運用の値なので、環境変数の整理の時にまとめて扱う）。

## 9. 出力契約（概要）

すべて strict 互換の JSON（全 key が required、任意の値は `null`）。ホストが要素ごとに検証する。

**curate-world**
```json
{
  "entities": [{ "op": "register|alias", "ref": "w1|null", "kind": "<entity kinds>", "name": "…", "alias": "…|null" }],
  "claims":   [{ "op": "assert|correct|retract", "ref": "c1|null", "subject": "w1|new:0", "predicate": "…", "value": { "type": "<typed value>", "value": "…" } | null,
                 "relation": { "kind": "increases|decreases|causes|enables|inhibits|depends_on|correlates|part_of|related_to", "object": "w2|new:1" } | null,
                 "condition": "…|null", "evidence": "e1", "origin": "user_report|model_hypothesis", "validFrom": "YYYY(-MM(-DD))|null", "validUntil": "…|null" }],
  "changed": true
}
```
- 型付きの値、条件の式、述語の語彙は World パッケージの既存の契約（`validateCandidates` が受け付けるもの）に合わせる。実装時に契約から schema を作る。
- 上限: 対象の登録4件、主張8件（World の候補上限）。

**curate-goals**
```json
{ "goals": [{ "op": "propose|adopt|revise|complete|withdraw", "ref": "g1|null", "text": "…|null", "priority": "high|normal|low|null", "evidence": "e1|null" }] }
```


**consolidate-world**（手入れ）: 統合の提案（`planMerge` に渡す。可逆）、古くなった状態の `stale` の印、使われない仮説の取り下げ。上限は1回4件。

## 10. 指示文の方針

- curate-world: 本人の外の世界について、今後の判断に役立つ状態・関係・依存・因果を書く。本人について（好み・習慣）は書かない（curate-memory の仕事）。本人の言葉は `user_report`、アシスタントの説明・推測は `model_hypothesis`。同名だけで別の対象をまとめない。分からなければ書かない。
- curate-goals: 本人が明言した目標は adopt、会話から推測した目標は propose。目標の達成・断念が分かったら complete / withdraw。

## 11. タスク

順序: パッケージ（対象の一覧）→ 設定と組み立て → 抽出の一本化 → 採用と目標 → 使う側（focus・ツール）→ 忘却 → 閲覧と削除 → 総合検証。

| 段 | # | 内容 | 主なファイル |
|---|---|---|---|
| A | T1 | パッケージに `listEntities` を足し、試験と spec を更新して再配布する（§3.2 E1・E2） | `../eumenes_world_model/**`、`package.json`、vendor |
| B | T2 | ON/OFF を設定にする。OFF でも内容があれば protect（§8） | `settings/**`、`api/application/world.ts`、`server-world.ts`、`infrastructure/config.ts` |
| | T3 | goals を組み立てる（§5 O1） | `api/application/server.ts`（または組み立て用の補助ファイル） |
| C | T4 | world の公開操作 `prepareCurationInTransaction` / `settleCurationInTransaction` を切り出し、Local の証明を外す。`world.extract` 一式を削除する。受付をアシスタントの採用済み回答にも広げ、話者と origin を検証する。受付の後に steward を kick する port（§3.1） | `api/domains/world/service/extraction-*.ts`、`world.ts` |
| | T4b | steward の実行単位 `world_events`（§3.1 の単位・保留の終端化・原子性・再起動） | steward |
| | T5 | steward の `curate-world` step と指示文（§9・§10） | `api/domains/steward/service/steps/`、`prompts/` |
| D | T6 | 採用・訂正・取り消しの公開操作と steward からの呼び出し（§3.3） | `world/service/world-claims-changes.ts`、steward |
| | T7 | `curate-goals` と依頼の `goal`（§5 O2・O3）、目標の根拠の追跡（O5） | steward、`goals/**` |
| | T7b | 推論の振り分け（§3.4）: curate-memory の出力と指示文、`world: false` の event の settle、判定と発言の版の結び付け、判定待ち | steward |
| E | T8 | ①目標を L1 の直後に置く、②発言の中の既知の対象を名前・別名の一致で引いて Broker の WorldSlice の起点にする（§4.1） | `world/service/context-broker.ts`、`dialogue/service/context-compiler.ts`、`memory/service/context-window.ts`（目標の層の位置） |
| | T9 | `world_query` ツールの bundle と adapter（§4.2） | `capabilities/bundles/`、`api/application/` |
| F | T10 | 忘却の接続（§6 F1〜F11）: World・目標からの忘却を除外台帳へ戻す、目標の忘却と block journal の `derived`、起動時の再適用 | steward、`world/service/lifecycle-*.ts`、`goals/**`、memory の block journal と purge hook |
| G | T11 | 手動変更の削除と閲覧（§7） | `world/controller/claims.ts`、`world-claims*.ts`、`settings-world.bundle.json`、`application/world-adapter.ts` |
| | T12 | `consolidate-world` と `consolidate-goals`（手入れ） | steward |
| H | T13 | 文書: `docs/memory.md` に World と目標の節を足す。`api/domains/world/README.md` を更新する（抽出・手動変更・設定）。`docs/domains.md` を再生成する | `docs/*`、`api/domains/world/README.md` |
| | T14 | 総合の verify と live の受入（§13） | `spec/verification/world-steward-2026-10-14/README.md` |

## 12. 試験（fixture）

| 対象 | 確かめること |
|---|---|
| 対象の一覧 | Scope 内だけ返す / 忘却済みを返さない / 統合先を返す / 上限 |
| 抽出の一本化 | feed の受付の後に curate-world の単位が作られる / feed が遅れても往復の完了は待たない / 初回の同期の前の発言は対象にならない / 処理済みの発言の訂正版が新しい event として処理される / World の確定・単位の close・判断記録が1つの transaction（途中で失敗すると何も残らない） / 3回保留した event は `STEWARD_GAVE_UP` で終わり後続が進む / `world.extract` のジョブ種別がない / cloud の route でも動く / 忘却と重なると不採用 |
| 受付と origin | 採用されたアシスタントの回答が受け付けられ、`model_hypothesis` になる / アシスタントの回答から `user_report` は作られない（`origin_mismatch`） / ユーザー発言から `model_hypothesis` は作られない / 除外台帳のメッセージは受け付けない |
| 振り分け | `world: false` の往復は curate-world を推論せずに `empty` で settle / **訂正版の event（revision・digest が違う）は true 扱いで curate-world が走る** / feed が判定より先に届くと、curate-memory の後まで curate-world は待つ / 往復が curate されないと決まれば true 扱い / `goals: false` は curate-goals を飛ばす / 判定が欠けた往復は true 扱い / 初めて出てくる対象の往復（既知の対象0件）でも world が true なら curate-world が走る |
| 採用 | 本人の報告は active、仮説は hypothesis / 本人の訂正で supersede / 「違う」で retract |
| 目標の層の予算 | 採用30件・各500文字の日本語でも 2KB を超えない / 優先度順・1件120文字・「ほか N 件」 / 優先度の変更で並びが変わり、変更がなければ同じ文面 |
| 目標の忘却 | 名指しの目標・忘れる対象に結び付いた目標が、改訂履歴ごと消える / 目標の全改訂の根拠の発言が除外台帳に入り、要約・判断記録から消える / **忘却前の DB を戻して起動しても、最初の回答の前に目標が消えている**（通常の再起動でも同じ） / 完了・取り下げ済みも消える / 同じ発言を根拠にしただけの目標は残る / 目標の層が作り直され、その目標を使った生成中の回答は `memory_stale` / 忘却と重なった curate-goals は不採用 |
| World からの忘却の戻り | 主張・対象を忘れると、その根拠の発言が除外台帳に入り、要約・turn vector・判断記録から消える / そのメッセージを根拠にした他の記憶は残る / 再抽出で同じ発言から主張が作られない |
| 目標 | 明言は adopt、推測は propose / 時間がたっても自動で withdraw しない / 手入れで重複の提案をまとめ、上限に近づくと関係の薄い提案から withdraw / 採用済みは手入れで withdraw しない / 依頼で complete |
| 目標の層と話題の対象 | 目標は L1 の直後に入り、目標が変わらなければ同じ文面（cache が効く） / 発言に出た既知の対象の状態と直接の因果が L4 に入る / 曖昧な一致は入らない / 対象が出なければ L4 は今と同じ / 予算 6KB を超えない |
| ツール | `world_query` が登録され、mode ごとに答える / 結果に操作の許可がない |
| 忘却 | 除外台帳のメッセージを根拠にした World の主張が消える / 依頼で主張・対象を消せる / 上限5件 / 判断記録から消える / 起動時の復旧で同じ状態になる |
| 閲覧と削除 | 変更の HTTP と action がない / 閲覧は動く |
| 設定 | OFF・内容なしなら何も組み立てない / OFF・内容ありなら protect / ON で初回同期 |

## 13. live の受入（機能が揃ってから）

| # | シナリオ | 合格の条件 |
|---|---|---|
| L1 | 「Eumenes の記憶は steward が管理している」のように外の世界の状態を話す | World に対象と主張が入り、採用される。Memory には入らない |
| L2 | アシスタントが「cache を入れると速くなるかもしれません」と言う | 仮説として入り、本人の報告にはならない |
| L3 | 訂正（「いや、それは LARM ではなく cloud で動いている」） | 古い主張が supersede され、その後の回答が変わる |
| L4 | 既知の対象（例: Eumenes）を話題に出す | その対象の状態と因果が L4 に入り、回答で「それを変えると〇〇に響く」のように使われる |
| L5 | 「この変更で何に影響する？」 | 会話エージェントが `world_query` を使う |
| L6 | 「〇〇のことは全部忘れて」 | World の対象と主張が消え、以後使われない |
| L7 | 「音声の遅延を減らしたい」 | 目標が採用され、関連する回答で目標が踏まえられる |
| L8 | LARM が使えない状態 | cloud で World の step が動く |
| 計測 | step ごとの時間・出力 tokens・期限切れの率、World の主張の件数と採用率 | steward 計画 §11 と同じ判断基準 |

## 14. リスク

| # | リスク | 対策 |
|---|---|---|
| R1 | 1回の往復の推論が増える（curate-world、curate-goals の最大2回。対象選びは LLM を使わない） | curate-memory の振り分け（§3.4）で、世界の情報も目標もない往復は推論しない。失敗が続けば World 担当を分ける（G2） |
| R6 | 振り分けの誤り（世界の情報があるのに false） | 迷ったら true の指示、判定が読めなければ true。live で誤りの率を測る |
| R2 | 外の世界の情報が cloud に送られる（World の設計書は Local 限定だった） | G1 で合意済み。route は会話と同じなので、会話で cloud に送っている範囲を超えない |
| R3 | 対象の取り違え（同名の別物を1つにまとめる） | 同名だけで統合しない。統合は手入れの step で、可逆の `planMerge` を使う |
| R4 | 小さいモデルが World の契約（型付き値・関係）を守れない | 要素ごとに捨てる。判断記録で失敗の傾向を見て指示文と語彙を絞る |
| R5 | パッケージの変更（対象の一覧）が別リポジトリになる | T1 を最初に行い、版を patch だけ上げる |

## 15. 決定済みの確認事項（2026-10-14）

| # | 確認事項 | 決定 |
|---|---|---|
| 1 | 目標を L1 の直後に置く（目標が変わると後ろの cache は崩れる） | この位置でよい |
| 2 | 対象の一致は名前・別名の決定的な一致だけ（言い換えや指示語は拾わない） | これでよい。拾えない分は③のツールと curate-world で補う |
| 3 | 予算（①と②で最大 6KB、②の対象は最大5件） | まずこの値で運用し、live の様子を見て見直す |

## 16. 改訂3 の変更点（外部レビュー6件）

| # | 指摘 | 対応 |
|---|---|---|
| 1 | 目標が忘却から漏れる | §5 O5（根拠の追跡）、§6 F8・F9（目標の忘却、層の作り直し、重なった結果の不採用）、§12 |
| 2 | World から忘れても会話が残る | §6 F7（根拠の発言を記憶の除外台帳へ戻す。他の記憶は消さない） |
| 3 | アシスタントの仮説を取り込めない | §3.1.1（採用済みの回答の受付、話者と origin の検証） |
| 4 | World の受付と steward の起動の契約がない | §2.2・§3.1・§3.1.2（curate-world を往復の連鎖から外し `world_events` の単位にする。受付後の kick、初回同期、訂正、原子性、保留の終端化） |
| 5 | 推論の省略が新しい対象の登録を妨げる | G10・§3.4（curate-memory の出力に振り分けの判定。読めなければ true） |
| 6 | 目標の全件と 2KB が両立しない | §4.1 ①（優先度順・1件120文字・「ほか N 件」）、§12 |

## 17. 改訂4 の変更点（外部レビュー2回目の3件）

| # | 指摘 | 対応 |
|---|---|---|
| 1 | 目標だけを忘れたとき、元の会話・要約が残る | §6 F10（目標の全改訂の根拠の発言を除外台帳へ） |
| 2 | 古い DB を戻すと忘れた目標が復活する | §6 F11（block journal の `derived.goalIds`、起動時に回答の前に再適用）、§12 |
| 3 | 訂正版の event に古い振り分けが効く | §3.4（判定を発言の revision・digest に結び付け、不一致は true。feed が先なら判定待ち） |

## 18. 実装で変えたこと（2026-10-15）

| # | 変更 | 理由 |
|---|---|---|
| 1 | 対象（entity）に種類（kind）の欄を持たせず、種類は World の主張として表す。curate-world の出力から `kind` を外した | パッケージの Entity に kind がない（足すには migration が要る） |
| 2 | `world_events` の窓は1往復分（最大2件） | パッケージは窓の全発言を各主張の根拠に持たせるので、忘却の巻き込みを小さくする |
| 3 | curate-memory の入力の World の主張の ref は `k1`〜（`c1` は想起の候補と重なる） | 既存の ref と衝突するため |
| 4 | `consolidate-world` は未実装 | World に event なしで仮説の取り下げ・統合をする公開操作がない |
| 5 | `evidenceMessagesOf` は生きている主張の根拠だけを返す | パッケージの公開 read の制約。取り消し済みの主張の根拠を返すにはパッケージの API が要る |
| 6 | 条件（condition）は扱わない（`unspecified`） | パッケージの条件は観測キーに対する構造式で、自由文から作れない |
| 7 | アシスタントの回答の根拠の種類はパッケージ上 `document`（主張の origin は `model_hypothesis`） | パッケージにアシスタント用の発言の種類がない |
| 8 | G8 の②（話題の対象の状態を L4 に入れる topic slice と既定の slice）とコマンド `world_query`（会話の AI が生の結果を読む方式）は 2026-10-15 に廃止。話題に出た既知の対象の名前だけを L4 の1行の手がかりにし、World の中身は research sub-agent の調査（`world.find`／`world.query`、別の LARM セッション、根拠つきの報告）で読む。World 用の入力予算（`CONTEXT_TOTAL_BYTES` の World 分、最小 slice、World の blocked）と slice の使用記録の書き込みは無くなった。目標の layer（G8 の①）は変えない | 会話の AI に World の中身を直接読ませない方針への変更。仕様: [world-research-subagent-2026-10-15.md](world-research-subagent-2026-10-15.md) |
