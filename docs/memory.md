# 記憶（Memory と Steward）

会話エージェントの記憶と ContextWindow は、背景エージェント「記憶担当（steward）」が管理する。本書は現在の仕組みと調査手順の正本である。設計の経緯は[記憶担当の実装計画](../spec/.archived/memory-steward-implementation-plan-2026-10-14.md)、domain の依存は[domain 一覧](domains.md)、ログの見方は[ログ](logging.md)にある。

「実装済み」と「実機で観測済み」は別である。fixture 試験の結果と live の観測結果は混ぜず、`spec/verification/memory-steward-2026-10-14/README.md` に分けて記録する。

## 役割の分担

| domain | 持つもの |
| --- | --- |
| `memory` | 往復の台帳、除外台帳（block ledger）と block journal、要約の保管、ContextWindow の保管と公開、State と傾向の保存、忘却とその派生データの削除 |
| `steward` | 判断のすべて。step ジョブ、指示文、出力の検証と正規化、依頼の inbox、判断記録 |
| `continuity` | 短期メモ（目的・決定・未解決・活動・メモ）の保存 |
| `dialogue` | 会話。run の終わりで往復の登録と steward への通知を呼び、`compileContext` で Window を prompt に並べる |

- steward は memory、continuity、conversation を使う。dialogue は memory だけを見る。複数 domain への保存は、step の settle が1つの transaction の中で各 domain の公開操作を呼んで行う。
- 通常の記憶の変更は会話で伝える（依頼キュー）。設定画面は閲覧と「メモリーの接続」の入り切りに限る。導入時の例外として、本人の許可を得た未確認Seed候補を追加する管理API・CLIがある（下記）。
- profile 名・モデル名はコードに固定しない。steward の推論は会話と同じ route、同じ接続先で行われる。例外は World の記録（curate-world）で、設定 `world.curationResourceId` に登録済みのクラウドの会話モデルを選ぶと、その resource だけで推論する（未設定・resource がない・接続が無効・会話の route がクラウドを許可しないときは会話と同じ route）。

## パッケージの利用とSeedの導入

`eumenes-memory` の公開SQLite APIをMemory domainから使う。判断は既存のstewardの `prepare → infer → settle` で行い、保存は単一writerのtransactionで行う。単体検証用のExamplesやCodex専用クライアントを会話経路へ組み込まない。モデル・接続先は既存の保存済み設定を使う。

配布物は `vendor/eumenes-memory/eumenes-memory-0.0.2-6643656f3383.tgz` に固定する。パッケージ版は0.0.2で、中身はビルド済みのJavaScriptと型宣言（`dist/`）。bunとNode（Playwrightなど）の両方から読める。SQLite契約は8のままで、パッケージ側の初期化や再作成は不要。State一覧の `after / nextCursor` に対応し、ホストの同じ読み取り内で全ページを読む。ホスト側には候補資料と登録済みdigestを保持する追加migration `memory/0007-seed-import` がある。既存のmigration・記憶・設定を削除しない。

Seedは本人の確認済み発言として扱わない。構造化された候補の分類を受け取り、次のように扱う。

| 候補の種類 | 導入時の扱い |
| --- | --- |
| `state` | 本人の好み・事実・制約・習慣を `agent_inferred` として追加。適用範囲・利用場面・条件と未確認表示を本文に保持 |
| `host_procedure` | 保留。記憶から実行指示へ昇格させない。採用するなら別途、適切な指示・Skill・ツールとして設計する |
| `continuity` | 保留。会話を特定できない案件メモを、共通プロフィールへ入れない |

他者の情報は通常の会話の `route.world`、会話ごとの目的・決定は短期メモで扱う。現在の本人の指示をSeedより優先する。Memory担当には保存キー・由来・表示件数と全件数も渡し、条件の保持と省略範囲を判断できるようにする。

初回導入では、稼働中のAPIに対して候補を確認し、登録する。CLIはファイルを読みAPIへ渡すだけで、製品DBを直接開かない。

```sh
bun run cli -- memory seed preview /absolute/path/to/seed.jsonl --json
bun run cli -- memory seed import /absolute/path/to/seed.jsonl --json
bun run cli -- memory list --json
```

APIは `POST /api/memory/seeds/preview` と `POST /api/memory/seeds/import`（本文 `{ seeds: [...] }`）。登録は本人が許可した初回データセットに限る。`ready` の項目だけを全件まとめて確定し、同じキーの既存項目は状態・種類にかかわらず `existing_key` として保留する。意味が似ているかはコードで判定しない。上限100件を超える場合は全件 `blocked / capacity`、途中の保存失敗は全件巻き戻す。Memoryの接続設定は変更しない。

同じデータセットの再投入は `unchanged`、別データセットは `blocked / different_dataset`。受付記録は本文を含まないdigestのみで、後の訂正・停止・忘却をSeedで上書きしない。候補の元資料と出典参照はホスト所有の候補資料として保存し、引用もその資料を指す。Eumenesに架空の本人発言を作らず、元のCodexログは読まない。設定画面では出典を「未確認のSeed候補」と表示する。

登録後は通常の会話から確認・訂正・停止・忘却する。候補の `review` は見直しの目安で、自動的な期限としては使わない。忘却は既存の版・統合履歴の閉包をたどり、候補資料も削除する。忘却journalを維持して古いDBを復元した場合も、登録済みdigestを再適用し、Seedの再投入による復活を防ぐ。元の外部Seedファイル自体の削除は、このAPIの対象ではない。

今回のSeedは50候補（State28・手順18・案件4）。実データをリポジトリのfixtureへ複製しない。隔離環境での導入確認と既存環境への登録状況は、[導入検証記録](../spec/verification/memory-package-adoption-2026-10-16/README.md)に分けて記載する。

## ContextWindow

ContextWindowの内容・並び・予算・保持・再構成・忘却の扱いは、[会話エージェントのContextWindow仕様](../spec/context-window-spec-2026-10-24.md)と、区画・書式・キャッシュを定める[ContextWindow 構成仕様](../spec/context-window-layout-spec-2026-10-25.md)を正本とする。本書には書かない。

## step と実行単位

1 ジョブ ＝ 1 step ＝ 推論 1 回。確定の単位は step で、サイクル全体をまとめて確定することはしない。

| 種類 | step | 役割 |
| --- | --- | --- |
| 反映 step（処理済みの出来事ごと） | `curate-memory`、`curate-goals`、`curate-world` | 記憶の保存・更新・停止と短期メモ（決定・利用者への問い・目標・一時的な例外）、目標、World |
| 経緯の step（次の再構成が適用する） | `summarize`、`refine-summary` | `log` から外れる出来事の要約、続いた要約のまとめ直し |
| 手入れ step（会話の最後の出来事から10分後だけ） | `consolidate-memory`、`consolidate-goals` | 記憶の統合・停止・傾向、目標の整理 |

会話の内容を読む step（`curate-memory`・`curate-goals`・`summarize`・`refine-summary`）は、主会話と同じ先頭（system・tool定義・資料の文書）の後に自分の指示と入力を置き、主会話の接続で推論する。主会話の呼出しや音声の文字起こしが始まると取り消され（`larm_preempted`）、失敗に数えずに15秒後に作り直される。記憶の依頼の結果は、会話の `log` に `memory.notice` の出来事として足す。

**実行単位**（`steward_unit`）は 1 step ＝ 1 ジョブ。同じ対象に開いている単位は 1 つだけである。

| 種類 | 対象 |
| --- | --- |
| 往復の step | 1 つの会話の、その step が未了の往復（最大4往復・16 KiB） |
| 依頼のまとめ | pending の依頼（最大8件）。`curate-memory` として実行 |
| 手入れ | 会話の `maintenance_revision` ごとに 1 つ |

- ジョブ種別は `steward.step.v1`、`dedupeKey` ＝ unitId。資源は `inference.aux`。
- **prepare** で対象がまだ有効か確かめ、推論の期限と request を取り、忘却の連番 `forget_seq` を単位に記録する。**execute** は schema 付きの推論 1 回（上限は期限300秒・出力1200 tokens。LARM の考えるモデルには inference が考える分 10,000 tokens を足すので、約45 tokens/秒でも書き終わる長さにしている。会話と同じ route を使い、cloud への切替が期限から最大60秒を確保する。ジョブの期限は15分で、待ち・推論・再試行を含む）。**settle** は 1 つの transaction で、再検証、結果の適用、完了印、判断記録、Window の再公開、次の単位の enqueue を行う。
- 一時的な失敗（タイムアウト・接続失敗）は Queue の retry（最大3回）で同じジョブのまま再試行する。Queue で終わった（failed / expired / interrupted）単位、または出力が使えなかった単位は `failed` で閉じ、対象ごとに失敗を数える。`kick` が**新しい unitId** の単位を作り直す。3回失敗した往復は `skipped` の印で次へ進み（`dispose-exchanges` が見送られた往復は未処理と同じ扱い、`summarize` が見送られた往復は中身を失わないよう逐語のまま）、依頼は `none`（`steward_failed`）にする。
- 往復の完了は、3つの反映 step すべてに印（`done` / `skipped`）が付いたときである。`summarize` を選ばれた往復は、要約に入るまで逐語のまま残る。
- 長期記憶を書く step（`curate-memory`、`consolidate-memory`）の `concurrencyKey` は全会話共通の `steward:long-term`。Window だけを扱う step は `steward:<conversationId>`。
- **起動時と各 settle の後**に `kickInTransaction` が呼ばれる。会話を指定しない起動時の kick は、steward が知っている会話と、memory の台帳に反映待ちの往復がある会話（`pendingConversationIdsInTransaction`）のすべてを対象にする。開いている単位があればそれを待つ。
- 手入れが止まる条件: `maintenance_revision` が前回より進んだときだけ走る。1回の手入れは最大3 step。`changed: false` を返した step は次の revision まで走らない。前景の run が動いている間は始めず、steward 内の timer で時刻が来たら kick する（30秒 → 2分 → 10分）。Queue には未来の時刻のジョブを積まない（同じ `concurrencyKey` の後続を止めるため）。例外として `consolidate-memory` は `PENDING_LIMIT` に達したときは待たない。

## 依頼キューと run の取り込み

本人の「覚えて」「忘れて」「違う」は、会話エージェントの記憶ツール（`request`：`{ kind: forget|remember|correct, what, detail? }`）で steward の inbox に入る。dialogue が steward の `requestInTransaction` を直接呼び、受付を返すだけである（`steward.request` toolchain は退役した）。

`staged`（ツール呼び出し時）→ `pending`（run が終わる transaction）→ `done` / `none`（`curate-memory` の settle で `resolve` を適用）。破棄されたものは `discarded`。`what` と `detail` は `done` / `none` / `discarded` になった時点で空にする。

### run の終わり方ごとの取り込み（§2.5）

| run の終わり方 | 往復の登録 | その run の依頼 |
| --- | --- | --- |
| completed | 登録する（`outcome: answered`） | すべて pending |
| failed / interrupted | ユーザー発言だけの往復として登録（`outcome: failed`） | すべて pending |
| cancelled（本人の取り消し） | 登録しない | `remember` だけ pending。`forget`・`correct` は discarded |
| stale（新しい run に置き換えられた） | 登録しない | discarded |

- 定期実行のプロンプト（scheduled prompt）はユーザーの発言ではないので、往復にも学習にも使わない（除外台帳に `scheduled_prompt` で入る）。
- 取り消した run の `remember` は、その run のユーザー発言を根拠に保存する。明示の `remember` は、同じ内容の記憶が既にあっても省略せず、`replaces` を付けて本人が確認した版（`user_confirmed`）として保存し直す。
- 依頼だけでも単位を作る。依頼の冪等性は往復の印ではなく依頼の状態（pending のまま）で判定する。
- 起動時は、終了済みの run に残った staged を同じ表で振り分ける（`steward.requests_swept`）。
- ツールが呼ばれなくても、`curate-memory` は往復の中の「忘れて」を読み取って停止できる。

## 忘却の契約

**会話の原文は残す。記憶と文脈への再利用を禁止し、派生データを消す。忘却は必ず完遂し、忘却と重なった古い結果は採用しない。**

### 除外台帳（block ledger）

`memory_message_block` に、記憶にも文脈にも使わないメッセージを message ID で記録する。理由は `scheduled_prompt` か `forgotten`。会話の原文は変えないので、会話画面の履歴はそのまま見える。単位はメッセージ（往復）で、同じ発言にあった他の話題も文脈から消える。記憶として保存済みの内容は残る。

除外台帳に入れるもの: 忘れる記憶（過去の版と統合の系譜を含む）の根拠のメッセージ、steward が `resolve.alsoIn` で返した往復、それらの相手側（ユーザー発言なら回答、回答ならユーザー発言）。同じメッセージを根拠にした他の記憶は消さない（本人が忘れてと言っていない事実だから。メッセージは文脈から外れるだけ）。会話ごとの除外では、会話 `''` の行（旧 `memory_agent_excluded_message` から移した行。どの会話か分からない）はすべての会話に適用される。

### 参照する場所

steward の各 step の入力、根拠の作成、`compileContext` の L3・未処理・直近2往復（**memory の有効/無効に関係なく適用**）、想起、要約の入力と依存元、短期メモの作成、調査ツールの `history.search` / `history.read`、調査結果の採用時の検証。会話画面の履歴表示だけは変えない。

### 忘却で消すもの（1つの transaction）

State（過去の版を含む）・usage・Window・傾向、World の派生、短期メモ（除外したメッセージを `sourceMessageId` にするもの、忘れた State を根拠にしたもの）、除外したメッセージの turn vector、要約（`memory_summary_source` に除外した往復を含む版。除外されていない依存元の往復は作り直しの対象になり、作り直すまで逐語で残る）、判断記録（`steward_decision_ref` で引ける行）、依頼の本文、往復の `disposition`（`drop` にする）。会話の原文と、本人に見える会話画面は消さない。

### journal と復旧

忘却の前に、別ファイルの **block journal**（forget journal と同じ場所の `*.blocks.jsonl`）へ意図を 1 行書く（`{ forgetId, conversationId, messageIds, itemIds, at }`）。書く順は「block journal → forget journal → DB」。block journal の行は完遂すべき意図で、起動時にまだ忘却されていない `itemIds` を実行して完遂し、派生データの削除を冪等にやり直す。照合が終わるまで memory は `ready()` が false で、State も Window も使われない。DB を忘却前のバックアップに戻して起動しても、journal から同じ状態になる。

### 古い結果を採用しない

各単位は prepare 時の `forget_seq`（と、要約を使う step は要約の `revision`）を記録する。**全 step の settle**で値が進んでいれば、結果を一切採用せず、単位を `stale` で閉じて `kick` に作り直させる。判断記録には本文を残さず、理由コード `stale_forget`（または `stale_summary`）だけを書く。

## World と目標（steward が兼任する）

計画: [World Model と steward の接続計画](../spec/.archived/world-steward-implementation-plan-2026-10-14.md)。

| 棚 | 入れるもの | 書き手の step |
|---|---|---|
| 長期記憶（Memory State） | 本人についてのこと | curate-memory |
| World | 本人の外の世界の状態・関係・因果・依存（本人の発言は `user_report`、アシスタントの回答は `model_hypothesis`＝仮説） | curate-world |
| 目標（Goals） | 本人が目指すこと（明言は採用、推測は提案。期限では取り下げない） | curate-goals、手入れの consolidate-goals |

- **World の ON/OFF** は設定 `world.enabled`（再起動で反映）。OFF でも World に中身があれば、忘却の伝播だけが動く（protect）。
- **World の記録に使う AI** は設定 `world.curationResourceId`（設定画面「会話」の「ワールドモデルの記録に使うAI」）。次の記録から反映される。応答は他の手順と同じく `parseLlmJson` で構文だけ補正してから schema で検査する。
- **World への反映**: 会話の outbox から World が受け付けた event（ユーザー発言と、採用されたアシスタントの回答）を、steward の実行単位 `world_events` が1往復分（最大2件）ずつ処理する。往復の完了は World を待たない。受付の後に World が steward を kick する。3回保留された event は `STEWARD_GAVE_UP` で終わる。
- **振り分け**: curate-memory が往復ごとに「World・目標の処理が要るか」を判定し、発言の revision と digest に結び付けて記録する。要らない往復は推論しない。版が違う・判定がないときは処理する。
- **回答での使い方**: ① 採用済みの目標を L1 の直後に置く（優先度順、1件120文字、全体 2KB、溢れは「ほか N 件」）。② 本人の発言（今回の入力、直前の往復）に出た既知の対象を名前・別名の一致（決定的、NFKC・小文字、曖昧な名前は除く）で最大5件引き、**名前だけ**を L4 の1行（`Worldに記録がある対象: freee、経費精算システム（内容は world_query で調べる）`）にする。主張の中身・ID は渡さない。対象が無い、または World が使えないときは何も入れない。③ World の中身は、会話の AI が直接読まない。`world_query`（toolchain `world.query`）の調査として、会話とは別の LARM セッション（auxiliary）で動く research sub-agent が `world.find`／`world.query` で読み、根拠つきの報告（Report）を返す。会話の AI はその報告（projection）だけを引用して答える。World の記録は本人と会話から作った記録で、外部で確認した事実ではない。`model_hypothesis` の主張は仮説として伝え、カバー範囲が partial のときは「影響がない」「依存がない」と言い切らない。仕様: [World の照会を sub-agent の調査にする](../spec/.archived/world-research-subagent-2026-10-15.md)。
- **忘却**: World の主張・対象、目標を忘れるときは、その根拠の発言も記憶の除外台帳に入れる（同じ発言を根拠にした他の記憶・目標は消さない）。忘れる目標の ID は block journal の `derived.goalIds` に書き、起動時の照合でやり直す。除外台帳に入れた発言は World の source の忘却としても受け付ける。
- **手動の変更はない**: World の主張の訂正・取り消し・忘却は会話で頼む（依頼キュー）。設定画面の World は閲覧だけ。
- **World 側の巻き込み（意図した非対称）**: 記憶では、忘れた発言を根拠にした他の記憶は残す。World では、同じ窓（1往復分）から作られた主張が窓の全発言を根拠に持つため（パッケージの仕様）、その中の1発言が除外台帳に入る（記憶・主張・目標のどれを忘れても、根拠の発言は World の source の忘却に回る）と、同じ窓の他の主張も消える。窓を1往復に絞って範囲を小さくしている。
- **既知の制約**:根拠の発言を取り出す処理は生きている主張しか対象にできない（取り消し済みの主張の根拠は漏れる）。World の手入れ（統合・仮説の取り下げ）は World 側の操作がないので未実装。

## 判断の閲覧（設定画面「記憶」）

設定画面の「記憶」の「判断の記録」タブに、steward の判断のタイムラインと往復の台帳が出る（新しい順、各50件）。

| 列 | 意味 |
| --- | --- |
| 時刻・担当した作業 | 判断した step（記憶の判断・目標・World・要約・要約の推敲・記憶の整理・目標の整理） |
| 提案 | モデルの出力の要約（各リストの件数と、要約・問い合わせの本文） |
| 適用・却下と理由 | 適用の件数、却下の件数と理由コード、採用しなかった単位は理由コード |
| 文脈の版 | Window の版の変化（例: 版 3 → 4） |
| 所要 | 所要時間と出力 tokens |

往復の台帳は、往復ごとの結果（回答あり／回答なし）、各 step の印（済／見送り／未）、履歴での扱い（逐語で残す／要約へ／出さない／未判断）を示す。

画面は読み取り専用で、adapter の query は `query:memory.steward-decisions@1` と `query:memory.steward-exchanges@1`（`adapter:memory@1`）。artifact は `settings.memory`。API と CLI でも同じ内容が読める。

```sh
bun cli/index.ts memory decisions [--conversation ID]   # 判断記録（JSON）
```

HTTP は `GET /api/steward/decisions?conversationId=main&limit=50` と `GET /api/steward/exchanges?conversationId=main`。

判断記録は会話ごとに新しい1000行までを保持する。忘却で触れた行は、本文が消える（出力は消去済みと表示される）。

## 障害調査

まず警告以上を見る。

```sh
bun run logs -- --level warn --component steward
bun run logs -- --id <jobId> --json     # steward の step ジョブ。同じ jobId の行を時系列で見る
bun run logs -- --id <runId> --json     # 会話の run。往復の登録（dialogue.*）を確認
```

| event | レベル | 意味 | 見るもの |
| --- | --- | --- | --- |
| `steward.unit_settled` | info | step が採用された | `stepId` / `kind` / `applied` / `rejected` / `durationMs` / `jobId`。`applied: 0, rejected: N` が続くなら判断記録の `results` の理由コードを見る |
| `steward.unit_stale` | info | 結果を採用せず単位を閉じた | `reason`: `stale_forget`（忘却と重なった）、`stale_summary`（要約が更新された）、`memory_unavailable`（memory が使えない）など。続く `kick` が作り直す |
| `steward.unit_failed` | warn | 単位が失敗した（推論の失敗・出力の不正） | `reason`（エラーコード）。対象ごとに3回で諦める |
| `steward.unit_not_created` | warn | 単位は作れたがキューへの投入に失敗した | `stepId` / `reason: enqueue_failed` |
| `steward.kick_failed` | warn | kick 自体が失敗した（run の終わりの transaction は巻き込まない） | エラーフレーム |
| `steward.requests_swept` | info | 起動時に、終了済みの run に残っていた staged の依頼を振り分けた | `count` |
| `dialogue.exchange_not_recorded` | warn | 往復を登録できなかった（メッセージが無い） | `runId` |
| `memory.long_term_trimmed` / `memory.short_term_trimmed` | info | 予算を超えた分を省いた | `omitted` |

調べ方の順序:

1. 記憶が増えない: `steward.unit_*` が出ているか確認する。出ていなければ memory が接続されているか（設定画面「会話への接続」。`memory_unavailable` は忘却の照合が終わっていない、または journal が読めない）を確認する。出ていれば判断記録のタイムラインで、該当 step の「適用・却下と理由」を見る。`blocked_source`（除外済みメッセージ）、`limit_reached`、`item_changed`（競合）などの理由コードがある。
2. step が失敗し続ける: `steward.unit_failed` の `reason` と、判断記録の `errorCode`、`durationMs`、`outputTokens` を見る。期限切れ（step の 5% 超）や出力が上限の8割を超える step は、要素の上限か step の上限を調整する対象である。
3. 履歴の欠落: 往復の台帳で、対象の往復の印と履歴での扱いを見る。「見送り」は3回失敗して諦めたもの、「出さない」は `drop` か除外台帳による。
4. 忘れたはずの内容が出る: 除外台帳（`memory_message_block`）と判断記録の消去状態を確認し、`stale_forget` で単位が破棄されているかを見る。block journal が残っていて照合が終わっていない場合は memory が使えない。

**ログと判断記録に渡さないもの**: 会話本文・音声・認証情報・設定・Provider の生応答。ログには件数・理由コード・ID・所要時間だけを出す。判断記録の出力は正規化後のもので、忘却に触れたものは消える。
