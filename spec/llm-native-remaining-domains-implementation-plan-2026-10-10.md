# 残存domainのLLM-Native修正計画

2026-10-10。Sol実装用。**G01・W01実装済み、検証記録は末尾。live・実機器は未実施**。[根拠と再現](reviews/llm-native-remaining-domains-2026-10-10/README.md)を伴う。製品全体を再設計する計画ではない。

## 1. 実装対象と判断

| 項目 | 今回の実装範囲 | 完了条件 |
| --- | --- | --- |
| G01 | Goalsのproposed内容同一視を削除。既存operation replayを利用 | 別operationの文面・priority・source版を勝手に統合しない |
| W01 | Worldのheld入力を未適用で保持し、同じ抽出contextでの再実行を抑止 | 情報が変われば再評価でき、古い結果・取消結果は採用しない |
| M01 | Eumenesには製品変更を加えない。未接続Memory自動抽出の接続条件を文書化 | 括弧意味判定を撤去した依存新版の証拠なしに自動抽出を接続しない |

G01が意味判断の専用処理の撤去対象である。W01は接続済み処理の状態管理修正で、語句・辞書による意味判断違反とは区別する。Memoryの未接続処理を直すために現行の明示登録や会話View利用を止めない。

LLMへの既存指示・情報・ツール・共通実行機構を先に確認した結果、追加の意味分類モジュールは不要である。Goalsは既存operationKey、Worldは既存prepare/execute/settle・inference control・queue・Memory manifest releaseを再利用する。continuity、tasks、task-reports、coding、coding-supervision、runnerには今回の撤去変更を行わない。

## 2. 実装前の版確認と共通条件

1. `AGENTS.md`、この計画、監査README、対象の現行コード・契約・試験を読む。initial_instructionsはこのチャットで実行済みなので再実行不要。別チャットには送信しない。
2. 監査のsnapshot/recheckと現行差分を照合する。未commitの並行変更を正本とし、reset/restoreしない。既存計画の未完機能を実装済みと仮定しない。
3. 変更は各domainの公開操作と単一writer transaction内に置く。applicationにはSQL・判断を移さない。依存world_*テーブルを直読・直書きしない。Web/CLIはAPI経由を維持する。
4. 実装記録には実装済み、fixture検証済み、live未実施、実機器未実施を分ける。音声の実機器3往復受入は今回のfixtureから代替しない。
5. ログはID、状態、件数、固定reason codeのみ。本文・音声・credential・設定・生のモデル出力・entitiesを出さない。context digestも本文から内容を推測できるログ用途には使わない。

## 3. G01：操作の再送だけを同一視する

### 3.1 契約

現行の`propose(access, input)` / `proposeInTransaction(db, access, input)`と`adopt`の型・公開名を変えない。

```ts
// 現行契約を維持。新APIではない。
{
  scopeKey: string,
  desiredState: string,
  priority?: number,
  source: {
    namespace: string, kind: string, id: string,
    revision?: string, digest?: string, representation?: string
  },
  operationKey?: string
}
```

principal/scopeはhostが許可したaccessから決める。sourceや文面から推測しない。

| 入力 | 結果 |
| --- | --- |
| 同じprincipal/scope/key、同じ既存operationDigest | 同じGoalを返す。新規保存・revision/epoch更新なし |
| 同じprincipal/scope/key、異なる文面・priority・source版等 | 既存`operation_conflict`を返す |
| 別key、またはkeyなし | 独立した提案として保存。文面が同じでも統合しない。既存上限は適用 |
| 別principal/scope | 現行の隔離・権限検証を維持 |

operationKeyを必須に変更しない。キーなしの既存利用者は互換のまま、繰り返し新規操作が上限に達すればgoal_limitになる。新しい自動提案callerを将来接続する場合、同一の意図的な操作の再送にはhost発行の安定したkeyを渡す。自由文を正規化してkeyを作らない。

意味が同じか、既存目標へまとめるかの判断を追加する必要が生じた場合は、LLMへ許可範囲の既存GoalとID・revisionを提示し、明示された既存操作を選ばせる。今回はその接続も自動採用も追加しない。

### 3.2 変更箇所

| ファイル | 具体的変更 |
| --- | --- |
| `api/domains/goals/service/index.ts` | `normalized`と`status === proposed`内のlistProposedGoals/findによる内容重複排除を削除。operationDigest/getGoalByOperation、capacity、source保存、状態遷移を維持 |
| `api/domains/goals/test/goals.test.ts` | 現行「re-proposing the same thing…」試験を操作IDの再送試験に置換。大小文字・Unicode幅・空白が異なる別操作の保持、priority/source revision変更を追加 |
| `api/domains/goals/README.md`（新規） | 操作再送と提案上限、keyなし入力の扱いを説明する |

repository・DB migrationは不要。既存保存済みGoalのID・revision・status・epochは変更しない。過去に同一視されて失われた文面/priorityは現行DBから復元できないため、履歴を推測して新規作成しない。adopted一覧へproposedを混ぜない。

## 4. W01：未解決windowを完了扱いにしない

### 4.1 方式と理由

**候補にheldが1件でもあればwindow全体を未適用で保持する。** その実行でaccepted判定の候補も保存しない。候補から各原文への完全な対応が保証できない状態で部分適用する仕組みを追加せず、既存のprefix checkpoint契約を維持する。

packageの`candidate.settle(held)`は今回使わない。現在`xs-${eventId}`の固定keyでsettleするため、held→appliedを同じkeyで送るとpayload不一致になる。hostとpackage inboxをreceivedのまま保ち、最終適用時に既存settleを1回発行すれば、依存契約やoperation journalを改造せずに保持できる。

同じ情報のまま毎pollでLLMを呼ばないため、hostに**そのwindowを保留した抽出contextのdigest**を保存する。文面から意味を推定する処理ではなく、再評価条件の状態管理である。専用実装を置く根拠は監査probeで再現した入力消失と、既存prefix/operationKey契約にある。

この方式では未解決の先頭windowが後続の適用を止める。受信・forget/correctionの処理は継続する。情報不足を処理完了へ偽装しないための明示的な制約である。今回、entity自動生成や別の意味resolverは追加しない。

### 4.2 データ・公開契約

既存state enumは増やさない。末尾のhost migrationを追加する。

```sql
ALTER TABLE world_host_extract_event
ADD COLUMN held_context_digest TEXT
CHECK (held_context_digest IS NULL OR length(held_context_digest) = 64);
```

現行末尾は`world/0007-gap-task`。適用時に番号の重複を確認し、次の未使用IDへ追加する。過去migrationを編集しない。列はnullableなので既存received/applied/rejected/skipped行の意味を変えない。

抽出context digestの入力は固定バージョン、SYSTEM_PROMPT、interpretationVersion、entities portから取得した実際のJSONデータとする。現行のhasher/SHA-256を使用し、モデルへ渡すentitiesとdigest用データを同じ読取りで固定する。語句の正規化や自然言語の分類は行わない。entities portには同期的で安定した順序のJSON snapshotを要求する。source版は既存event identityとprepared refで別途拘束される。

`PreparedExtraction`に`contextDigest: string`を追加する。`ExtractionPayload`とHTTP APIは変更しない。queueに本文/entitiesを追加保存しない。`ExtractionReport.disposition`は既存`not_adopted`を使用し、固定reason=`EXTRACTION_CONTEXT_HELD`、accepted=0、heldは検証がheldとした候補数を返す。schedulerは既存idle形でreason=`extraction_context_held`を返す。LLMが出した自由文reasonを流さない。

### 4.3 実行・採用・取消

1. scheduleでは現在のusable/foreground/slot/job/backoff検査を維持する。最古receivedのheld_context_digestが現在contextと一致する場合、jobもrequestも作らずidleにする。後続だけを抜き出してcheckpointを進めない。
2. scheduleの抑止前にも既存classifyで原文の現在状態を確認する。gone/version_changed等なら既存のrejection/forget処理を優先する。保留digestがsource失効の処理を阻害してはならない。
3. contextが変わったら既存queueで新規attemptを準備する。prepareでも同じdigest検査を行い、schedule後の競合で同一情報を再呼出ししない。manifest登録、Local-only route固定、deadline、byte/token上限は維持する。
4. executeは現行の30秒budget、5秒取消確認、foreground割込み、slot占有を使う。取消未確認の間に次のLocal呼出しを開始しない。
5. settleは既存job/request/attempt、gate、source revision/digest、inference receipt検証を通す。加えて同一writer内で最新contextを取得しprepared.contextDigestと照合する。異なる場合は既存notAdopted/endJobで撤回し、新情報による次の試行へ戻す。古いentitiesの結果を採用しない。
6. validateCandidatesが正常でheldを含む場合、package settle/host finalization/appliedCursor更新を行わない。transaction内でendJob(false)によりrequestとmanifestを片付け、当該received行にheld_context_digestとreasonを記録する。failure count/backoffを増やさない。job/manifest/request参照は空、settled_at_msはnullを維持する。
7. heldがない正常windowは既存のaccepted handoffを保存し、host finalizationとpackage settleを同一transactionで確定する。terminal化した行のheld digestをnullにする。正当な空candidates/no-changeは従来どおり完了できる。malformed outputの最終rejected方針はこの変更では変えない。
8. retry・foreground・cancel・expiredは既存endJob/releaseへ戻す。これらを意味的heldとして記録しない。request取消後に遅延完了した旧attemptは既存のstale/fence検査で拒否する。forget/correctionは既存candidate root purgeで保留行も削除する。

manifest解放が拒否された場合は既存release_pendingとsweepを使用する。releaseを成功と偽装しない。SQL更新、package操作、report採用状態に例外があればwriter全体をrollbackする。transaction外でモデル待ちをしない。

### 4.4 変更箇所

| ファイル | 具体的変更 |
| --- | --- |
| `world/repository/extraction.ts` | row/raw/columnsにnullable digestを追加。received+job ownershipを条件とする保留記録操作とterminal時クリア。本文の保存は増やさない |
| `world/repository/migrations.ts`と同repositoryの新migrationファイル | append-onlyで上記ALTERを登録 |
| `world/service/extraction-ctx.ts` | 現在entitiesとdigestを同一snapshotで取る小さな共通操作。既存hasher/release/endJobを再利用 |
| `world/service/extraction-events.ts` | oldest heldの同一context抑止。classifyによる失効検査を先行。公開idle形を維持 |
| `world/service/extraction-prepare.ts` / `extraction-types.ts` | preparedにcontextDigestを固定。snapshotとmodel入力のentitiesを一致させ、再確認を行う |
| `world/service/extraction-settle.ts` | 最新context照合。held windowのfinalizationを停止して保留記録。取消/manifest解放を既存機構へ接続 |
| `api/domains/world/test/extraction*.test.ts`、migration試験 | 下記受入。監査probeの現在期待値をそのままコピーしない |
| `api/domains/world/README.md` | 保留・prefix停止・context変化で再評価、entities未供給の制限を記す |

表の`world/`は`api/domains/world/`を指す。application/server、依存パッケージ、Web/CLIに新しいentity repositoryやLLMの判断代替を作らない。

### 4.5 移行と互換性

旧appliedイベントをreceivedへ戻さない。失われた候補を根拠なく再作成しない。全履歴を再抽出しない。既存receivedは初回context判定で通常処理される。restart後もdigestの抑止を保持する。restore/resyncでは既存のepochとpurge契約を維持する。

実装時にSQLiteの現行migration契約を確認した結果、旧binaryは未知の適用済みmigrationを拒否する。列を無視した直接の切戻しはできない。移行済みbinaryを維持するか、データ損失と並行migrationを考慮した別のbackup復元計画が必要。DBの列削除・migration台帳の削除・他の並行migrationの巻戻しで回避しない。

現行serverはentitiesを供給しないため、情報不足は保持されても解消されない。W01の完了は入力保持の修正までである。U03の公開entity read契約・実接続が完了するまで「自動World抽出が実用完成」と記録しない。内部table直読みで接続欠落を埋めない。

## 5. M01：将来のMemory自動抽出の接続条件

現在の明示登録`assertUserState`とView v2は維持する。Eumenesのnode_modules、vendor tgz、隣接リポジトリをこの実装で直接書き換えない。

依存側への具体的な修正要求は、admissionのquotedSpan判定呼出しと、そのためだけのQUOTATION_PAIRS/isQuotedSpanを削除し、モデルが選んだtyped modalityを利用すること。quoted/reportedをpendingにする明示方針、原文role・所有・scope・UTF-8根拠・改訂・temporal・host-owned kinds・user overrideは維持する。書名/発話引用/括弧のない伝聞をデータとして試験し、括弧の有無だけでmodalityを覆さない。

自動抽出接続は以下が揃ってから別作業として行う。

- 依存側の対象差分と回帰結果、新版tgzのversion/SHA-256/schema互換証拠。
- Eumenesのvendor manifest/package.json/bun.lockを同一変更で更新し、固定配布物でconsumer試験。依存内部importを製品に追加しない。
- 抽出モデルにkind/subject/modality/temporalと根拠契約を渡す。意味判断の品質をliveで評価する。勝手に「肯定」と固定する迂回はしない。
- current source再検証・forget/restore/cancel競合と保存のsingle-writer受入。fixture成功だけでliveを有効化しない。

この条件を文書へ記録できれば今回のM01項目は完了とする。依存修正や自動抽出接続が完了したとは記録しない。

## 6. 受入

### Fixture

| 対象 | 必須ケース・期待結果 |
| --- | --- |
| Goals | 同key同payloadは1提案。同key別priority/source版/文面はconflict。別keyのUS/us、幅・空白の違う文面は別提案で原文保持。keyなしも別操作。上限・scope・revision・epoch・明示adoptは従来どおり |
| World保留 | alias未解決時にhost/package received、claims=0、applied cursor不変。再poll/restartでモデル0回追加。entities変更で新規実行され1回だけ適用 |
| World混在 | accepted+held windowは両方未適用。解消後にwindow全体を確定し、同eventを二重保存しない。後続はprefixを追い越さない |
| World競合 | prepare後のcontext/source変更、forget/correction/restore、旧attempt遅延、取消未確認、release拒否、writer失敗で誤採用・漏れ・hot loopがない |
| World契約 | 空候補は完了、malformedは既存rejected、typed false/数値/条件を契約に沿って処理。列追加前DBからupgrade、旧terminal行不変、no history rescan |
| Memory維持 | 明示登録・停止/訂正/忘却・ON/OFF・dialogue View/usage/staleの既存試験が通る |
| coding維持 | authority/fence/cancel、unknown message、approval/check/review制約とproduction isolation refusalが維持される |

再現語句は回帰データに置く。製品コードへUS/us、書名、音声サービスなどを判別する分岐を追加しない。別名・別predicate・別scopeに入れ替えても同じ契約で通ることを確かめる。

日常検証は`bun run verify -- --domain goals`、`world`。利用側の`memory`、`dialogue`、`continuity`、`tasks`、`task-reports`、`coding`、`coding-supervision`、`inference`も同じdomain指定で実行する。runner/applicationは監査READMEにある対象試験を実行し、横断変更のため最後に`bun run verify:all`を通す。新しい変更や失敗がなければ同じ全域試験を繰り返さない。

### Liveと実機器

W01をONで受け入れる前に、実際のLocal-only requestで原文根拠・registered entity ID・alias未解決・typed false・条件付き候補を確認する。語句専用コードではなく実モデルの出力とtyped契約の整合を記録する。entities portが未接続ならそのlive gateは未達と記録し、fixtureのcallback差替えを実接続と扱わない。U01で失敗が出たらまずSYSTEM_PROMPTと提供する契約情報を修正する。

Goals APIだけの変更にはLLM liveがなく、operation契約のfixtureを受入根拠にできる。coding productionや音声の実機器は今回の変更で完成しない。未実施は未実施と記録し、既存の音声3往復条件を緩和しない。

## 7. 実装順と完了記録

1. G01の現行不具合を回帰試験で示す。内容正規化の分岐を撤去し、operation replay試験に置換してGoals検証。
2. W01の保留消失・同情報hot loop抑止・context更新後再評価をfixture化。host migration、digest固定、schedule/prepare/settleを一まとまりで実装。
3. 取消・forget・restart・writer rollback・manifest releaseを検証。部分実装でWorld ONを受け入れない。
4. Memory接続前条件と到達性を文書化。前回計画の別作業・並行差分を重複実装しない。
5. 利用側とverify:allを実行。最終差分を読み、発話の語句・対象別regex/dictionary/固定文面による判断が増えていないことを確認する。保存されたLLM選択を権限・契約検証する処理は残す。
6. `spec/verification/llm-native-remaining-domains-2026-10-10/README.md`へ対象差分・fixture結果・live未達・実機器未実施・移行互換を記録し、この計画に実施記録を追記する。全項目と必要なgateが完了するまでarchiveしない。

## 8. 実施記録（2026-10-10）

G01の内容同一視を削除し、再送は既存operationKeyだけで処理する。既存の入力schemaのtrim・長さ制約は維持し、別操作の文面を統合しない。提案上限と操作keyのconflictも回帰試験で確認した。

W01はnullableなhost列を`world/0008-extraction-hold`で追加した。heldを含むwindowはreceivedのまま保持し、同じcontextではschedule/prepareを抑止する。prepareのJSON snapshotはportの可変オブジェクトから切り離し、settleで現在contextと照合する。既存の読取り専用`validateReceiptInTransaction`を抽出portにも使用し、最終適用時だけacceptする。これにより実inferenceの保留結果もacceptedとして残さない。

Memoryは接続前条件の文書化のみ。依存ソース・tgz・lockfile・Memory製品コードに本作業の変更はない。

検証の結果・移行制約・未達gateは[実施記録](verification/llm-native-remaining-domains-2026-10-10/README.md)を正本とする。実モデルのWorld抽出品質、production entity snapshot接続、音声実機器は未達。archiveしない。

対象と利用側のdomain検証、application/runner試験を実施し、現在版で`verify:all`が全13工程成功した。backend 1231 pass / 1 skip、Web 253・client 329・design-system 1086 pass、browser 42 pass / 1 skip。初回失敗・並行source変更による失効・検証ロック拒否は実施記録へ残し、最終成功とは区別した。
