# Agency Shadow P0 報告 — 基準測定と比較条件の固定

2026-11-05。範囲: [実装依頼・受入計画](../../agency-shadow-p0-p1-implementation-request-2026-11-05.md) §3 のP0だけ。P1、製品反映、実モデルの意味評価・課金試験、外部サービス、src／api・依存の変更、サーバー操作、branch・commit・pushはいずれも行っていない。r1・r2の実施場所は候補workspace（`/private/tmp/eumenes-p0-20261105-jqewp9kw/{eumenes,eumenes_agency}`）のmain。親レビューでR1〜R5の解消を独立に確認した後、レビュー済みの同じファイルを正本（`/Users/y.noguchi/Code/{eumenes,eumenes_agency}`のmain）へ配置し、正本で最終確認した（§11）。これは製品機能・配布物の本番採用ではない。

## 0. 現在の結論と版

| 版 | 状態 | 判定 |
| --- | --- | --- |
| **最終（正本配置後）** | レビュー済みの8ファイルをhash一致のまま正本Agencyへ配置した。正本で、r2と同じ事前登録・条件のbaseline-record／baseline-replayを[新しい出力先](../../../verification-reports/agency-shadow/p0-20261105-final/)で実行した | 28/28 passed、attempt 46、作用0、replay差0、再集計一致、候補r2との記録差0、配布照合92/92差0。正本Agencyの`bun run verify`は、サンドボックスの`.env`読取り拒否のため標準コマンドでは完走していない。段別では、無関係の`pack`試験1件だけが同じ原因で失敗した（§11） |
| r2（候補workspaceで受入） | 親レビューの受入阻害事項R1〜R5を修正し、[修正版の事前登録](preregistration-r2.md)のあと、[新しい出力先](../../../verification-reports/agency-shadow/p0-20261105-r2/)で正式に測り直した | fixture laneでP0-A01〜A08は全てpass（各IDの証拠と範囲の制約は§3）。「P0計測基盤（fixture lane）の採用可」を提案する |
| r1（初回、保存のみ） | 初回の[事前登録](preregistration.md)と[出力](../../../verification-reports/agency-shadow/p0-20261105/)。当時はA01〜A08全passと判定した | **最終結果ではない**。R1〜R5により、A02・A03・A06・A07の根拠が不足していた（§6） |

意味品質・live計量・holdoutは未実施のまま保留する。独立した第三者による意味評価や、P1の採用は主張しない。

| 文書・成果物 | 内容 |
| --- | --- |
| [preregistration-r2.md](preregistration-r2.md) | r2の修正内容（R1〜R5）、ケース・期待、run計画、判定基準の変更点 |
| [preregistration.md](preregistration.md) | r1の事前登録（初回の記録として保存） |
| [baseline-manifest-final.json](baseline-manifest-final.json) ／ [baseline-manifest-r2.json](baseline-manifest-r2.json) ／ [baseline-manifest-r1.json](baseline-manifest-r1.json) | 各版の基準runのmanifest（生成物からの写し。finalは正本で実行） |
| [p0-acceptance.json](p0-acceptance.json) | r2の受入ID別判定と証拠の場所、r1との関係（機械可読） |
| [final生成物](../../../verification-reports/agency-shadow/p0-20261105-final/) ／ [r2生成物](../../../verification-reports/agency-shadow/p0-20261105-r2/) ／ [r1生成物](../../../verification-reports/agency-shadow/p0-20261105/) | 各runのmanifest・試行JSONL・cassette・要求・集計・比較・ログ。r1・r2は候補workspaceの生成物をhash一致で正本へ写したもの、finalは正本での実行。`verification-reports/`はgitignoreのローカル生成物 |
| [親の独立検査](../../../verification-reports/agency-shadow/p0-20261105-final/logs/parent-review/) | `parent-review-r2.json`（R1・R2・上限の境界probe）、`parent-artifact-audit-r2.json`（r2の17runの監査）、`parent-host-full-baseline.log`（本体agency fixtureの基準実行）。親が作成し、本作業では内容を変えずに写した |

## 1. 変更点

候補の`eumenes_agency/eval/initiative/`だけを変更した。製品の`src/`・`api/`、SystemContext、権限、設定、package.json、bun.lock、vendor tgzは変更していない（[r2保全ログ](../../../verification-reports/agency-shadow/p0-20261105-r2/logs/preservation.log)）。本体の変更は`spec/verification/agency-shadow-p0-p1/`の文書と、gitignore対象の生成物だけ。本体の`packages/dots-mcp/node_modules`は親が置いた読み取り専用symlinkで、本作業の変更ではない。

| ファイル | 区分 | 内容（r2時点） |
| --- | --- | --- |
| [baseline.ts](../../../../eumenes_agency/eval/initiative/baseline.ts) | 新規 | 配布版の実ロードentryの特定と検査。tgz checksum、**tgz内の`package/dist/*`とinstalled distのファイル単位照合（R4）**、版定数、本体参照、本体importとのmodule同一性。git identity（未追跡のsymlinkは辿らない）。組立てとSystemContext資産のdigest。隣接src lane |
| [cassette.ts](../../../../eumenes_agency/eval/initiative/cassette.ts) | 新規 | 推論境界での固定応答と要求照合。**宣言identity（decision／request／attempt／conversation／agent）だけを同値tokenにし、その他は全フィールドを比較（R1）**。**返却前の応答digest検査（R2）**。**物理attemptごとの上限強制、serveと拒否の区別（R3）** |
| [record.ts](../../../../eumenes_agency/eval/initiative/record.ts) | 新規 | TrialRecord v2（serve済みattempt・拒否した試み・理由）、予定IDとの照合、生JSONLからの集計、wait／拒否／抑止の区別、usageのunknown扱い、試行比較、manifest比較組の検査 |
| [p0-cases.ts](../../../../eumenes_agency/eval/initiative/p0-cases.ts) | 新規 | dev10（既存の入力・ラベル、固定台本）、機構M01–M15（**M15: 合成の会話prefix（R5）**）、故障注入F01–F05、各stepの事前宣言した期待 |
| [p0.ts](../../../../eumenes_agency/eval/initiative/p0.ts) | 新規 | record／replay（改変10種・隣接lane）／faults／aggregate。runTrialsで全予定試行を記録。停止条件（上限到達を含む）、例外時もserve済みの計量を保持、fetch guard、秘密形状の走査 |
| [p0.test.ts](../../../../eumenes_agency/eval/initiative/p0.test.ts) | 新規 | P0試験32件（R1〜R5の回帰を含む） |
| [research.ts](../../../../eumenes_agency/eval/initiative/research.ts) | 変更 | 既存受付fixtureに、模擬担当の起動件数・一時DB行数と、受付transaction内の保存失敗注入を追加 |
| [trials.ts](../../../../eumenes_agency/eval/initiative/trials.ts) | 変更 | 既存runTrialsを汎化し、停止後の残りを`incomplete`として報告（既存の呼出し・既存試験は不変） |

再利用した既存部品: `runTrials`、`createResearchFixture`、`cases.ts`のdev10、`virtual-clock.ts`。`scenario.ts`の`replayScript`は既定で模擬成功receiptを記録するので使っていない。`trace.ts`と`compare.ts`は要求照合・機構比較を持たないため使っていない。汎用フレームワークは新設していない。既存の`run.ts`（live用）は変更しておらず、固定のモデル既定値もそのまま残っている。P0の新規コードはモデル名・接続名を持たない。

## 2. 基準版と比較版（r2）

| 区分 | 識別 |
| --- | --- |
| 本体 | `056afd43115c0ae7df91449ad62baa0000d73c60`（dirty: 依頼前からの`spec/README.md`・設計書2件、本作業の文書、親が置いたsymlink） |
| **第一基準** Agency配布版 | `eumenes-agency` 0.1.3、gitSha `e7b4096d5bd56b8a32dd8bd93a65a519f8393b3f`。tgz sha256 `b4fc0e1e9ac15aaaee8f9c78b416e0dbd54a9f76f568d7d9f125769718cd3f7d`。実ロードentryは`/Users/y.noguchi/Code/eumenes/node_modules/.bun/eumenes-agency@vendor+agency+eumenes-agency-0.1.3-e7b4096d5bd5.tgz+3a38e73420b28681/node_modules/eumenes-agency/dist/index.js`。**tgz内の`package/dist/*` 92ファイルとinstalled dist 92ファイルが、欠落0・追加0・変更0で一致**。dist digest `9bc1db3e…a55bb0`（run前後で同じ）。`p0e-instructions-17`／`host-rules-14`。本体importとのmodule同一性を確認。検査9項目が全てtrue |
| 比較lane 隣接Agency src | `79c0418d3a27ec2f3ae878e74a48c251d4fe6add`。`e7b4096`から`src/`の4ファイルが異なるのに、版定数は配布版と同じ。評価プロセス内のload pluginで差し替え、本体importが差し替え先と同一instanceであることを確認 |
| 組立て・入力 | 組立てファイル10件（r2で`conversation-input.ts`・`input-text.ts`を追加）`02dd9b87…`、SystemContext資産 `c44f512f…`、合成設定 `747c0888…`、catalog `3e49a645…`、limits `4e024682…`、wake `89e6b88a…`、activity `2f24df90…`、ケース `d0335617…`、ラベル `9ce50cf2…`、台本 `215673c8…`、時計 `358e66e8…`、合成prefix `f227df1b…`、事前登録r2 `e7fc55f4…` |
| 実行環境 | Bun 1.4.4（`38afee6c`）、darwin 25.6.0 arm64 |
| コード固定 | r2の`eval/initiative/*.ts`のsha256を[code-freeze-r2.sha256](../../../verification-reports/agency-shadow/p0-20261105-r2/logs/code-freeze-r2.sha256)に記録し、最終verifyの直前に不変を確認した |

**会話prefixの扱い（R5の区別）**: M15以外のケースではprefixを付けていない（`task()`が`null`）。そのため最終messagesは`[system, user]`、sessionは`auxiliary`／`yields`になる。M15では次のようにしている。

- **prefixのデータ**: 直近の会話4件と`## State`の本文は**合成**である。製品では`backgroundPrefixInTransaction`／`stateLinesInTransaction`が会話storeから作るが、これらは通していない。
- **組立て**: 製品の`taskMessages`／`withLastMessage`／`backgroundMessage`を使う。
- **最終経路**: 製品の`createAgencyLlmPort`。prefixのsystemを除き、背景用のsystemを先頭に置き、`onConversation`と`agentSession`を付ける。

製品の会話storeからprefixデータを作る経路は未検証である。音声・通知のportは組み立てていない。

## 3. 受入IDごとの証拠（r2）

| ID | 判定 | 証拠（r2） | 範囲・制約 |
| --- | --- | --- | --- |
| P0-A01 manifestと比較組 | **pass** | [manifest](baseline-manifest-r2.json)の必須17項目の欠落は0。同一再生との組は`comparable`（宣言済み差5件）。隣接laneとの組は`comparable`（宣言済み49件: Agency identity、wake／activityのts／js表現）。単体試験で、固定項目の差・未宣言差・必須項目の欠落がいずれもholdになる | — |
| P0-A02 同一再生と不一致の検出 | **pass**（fixture範囲） | [同一再生](../../../verification-reports/agency-shadow/p0-20261105-r2/baseline-replay/replay-compare.json): 28試行で不一致0・記録差分0。束縛140件、5種（agentId・conversationIdを含む）で全て一対一。**正のprefix基準**: M15がrecord→replayで一致し、要求ではprefixのsystemが除かれ、user／assistant／user、`## State`、`## Task`、`onConversation`、agentId＝conversationIdを確認（単体試験）。故意の改変10種は全て対象の1試行だけで検出した（§5） | prefixのデータは合成。製品の会話store由来のprefixは未検証（§8で保留） |
| P0-A03 例外・無効出力・中断 | **pass** | [故障注入](../../../verification-reports/agency-shadow/p0-20261105-r2/faults/): 予定6件全てに記録がある（runner_error 2、model_error 2、incomplete 2）。F03（呼出し後の例外）はattempt 2件・usage 2件を保持。[記録欠落の模擬](../../../verification-reports/agency-shadow/p0-20261105-r2/faults/record-loss-check.json)で欠落・重複・未知を各1件検出し、元の生記録は不変。**上限run**: cap-0／cap-1／cap-45で、停止以降の予定試行を全てincompleteとして記録（passに数えない） | — |
| P0-A04 wait・拒否・抑止の別集計 | **pass**（抑止はmockのみ） | 基準runの区分: モデルwait 2、core拒否 3、本体受付拒否 3、host gate 6、select未到達 10、抑止 0。mock recordの単体試験で、抑止の別集計、gateで止まった禁止提案をFPに残すこと、参照拒否をwaitに数えないこと、未判定によるFP率の幅を確認 | observeは未実装 |
| P0-A05 外向きportsと一時DB | **pass** | 全17runで外向き作用0、外部通信の試み0。受付は`:memory:` SQLiteと模擬担当だけ（委譲4件は一時DB内のfixture作用として別計上）。本体の`data/`は前後とも存在しない | 音声・通知の0はportを組み立てていないことによる構造上の0 |
| P0-A06 基準の保全 | **pass** | 配布物の検査9項目が全てtrue（ファイル単位の照合を含む）。偽hostの負対照で、checksum・version・定数が全て一致したままでも、distの変更・欠落・追加をそれぞれ検出。tgz・distは不変、製品パスの変更0（[保全ログ](../../../verification-reports/agency-shadow/p0-20261105-r2/logs/preservation.log)）。隣接srcとの差を記録 | — |
| P0-A07 計量の整合 | **pass**（fixture範囲） | serveしたattempt 46件を全て数え、serve前に拒否した試み（0件）とは別に数えた。上限runではserve数がそれぞれ0・1・45で、上限を1件も超えなかった（cap-1とcap-45は拒否1件をattempt_capとして別計上）。生usageは46件ともunknown（合計null）で、製品portの0埋め45件を別に数えた。provider呼出し0なので実tokensは0、費用0。モデル名・接続名の固定値は0 | live量はunknown（未実施） |
| P0-A08 再集計と情報保護 | **pass** | [再集計](../../../verification-reports/agency-shadow/p0-20261105-r2/logs/aggregate-regeneration.log): 17run全てで保存値と一致。秘密形状の走査は全runで0件（植え込んだ陽性対照は検出）。製品DB・設定・.envは読んでいない | 生成物の本文は合成ケースとtracked済みSystemContext資産だけ |

## 4. 全試行と欠測（r2基準run `record-5cfd5e23…`）

予定28件（dev 10、機構18）を全て記録した。欠落・重複・未知は0、不一致0。**28件ともpass**（期待された拒否10件、想定外の拒否0件）。

| 集計 | 値 |
| --- | --- |
| モデル提案（select出力） | tool 8、speak 8、wait 2、未到達 10 |
| core判定 | llm 14、host_no_candidates 5、rejected 3、error 2、host_budget 1、wake（decisionなし）3 |
| ticket | 12件（tool 7、speak 5） |
| core拒否コード | unknown_ref・stale_revision・approval_required 各1 |
| 本体受付（fixture_only） | allowed 4、rejected 3（`fixture_save_failed`・`agency_capability_unavailable`・`agency_delegation_invalid`）、not_checked 21 |
| 作用 | 発話・通知・本番書込み・ActionReceipt・外部通信 0。一時DBの委譲 4。control receiptは受理43・拒否1 |
| attempt | serve 46（update 28、select 18）、serve前の拒否 0、provider 0、0埋め 45 |
| usage | 既知0・unknown 46・合計unknown。live未取得 |

r1と共通の27試行は、提案・source・拒否／blockコード・ticket・本体受付とコード・attempt数・結果・期待拒否が全てr1の[記録](../../../verification-reports/agency-shadow/p0-20261105/baseline-record/trials.jsonl)と同じだった（差0）。r2で追加したのは次の1行だけである。

| 試行 | 提案 | source | ticket | 本体受付 | attempt | 結果 |
| --- | --- | --- | --- | --- | --- | --- |
| M15 合成の会話prefix | speak | llm | speak | not_checked | 2 | passed |

試行ごとの全項目は[r2のtrials.jsonl](../../../verification-reports/agency-shadow/p0-20261105-r2/baseline-record/trials.jsonl)にある。dev10の応答は既存ラベルに沿った合成台本でありモデルの判断ではないので、意味採点不可（`scorable=false`）とし、FP／FN・有用性は算出していない。M08（再起動前後のsnapshot一致）とM09（同一IDで内容違いの観測の拒否）は合否条件に組み込んでいるが、注記としてrecordには保存していない。

上限run（同じ28件）:

| run | 上限 | serve | 拒否（理由） | 停止した試行 | 記録 |
| --- | --- | --- | --- | --- | --- |
| cap-0 | 0 | 0 | 0 | 最初のcaseの前（`cost_exceeded:attempt_cap_reached`） | 28件incomplete |
| cap-1 | 1 | 1 | 1（attempt_cap: dev-previous-taskのselect） | dev-previous-task（`stopped:cost_exceeded:attempt_cap`） | 28件incomplete |
| cap-45 | 45 | 45 | 1（attempt_cap: M15のselect） | M15（最後の試行） | 27件passed、1件incomplete |

## 5. 比較表（r2: 再生一致と故意不一致）

| run | 介入 | 境界での検出 | 記録差分のある試行 | 組の判定 |
| --- | --- | --- | --- | --- |
| baseline-replay | なし | なし | 0 / 28 | comparable |
| tamper-system | systemに1文字追加（dev-previous-task） | `request_digest_mismatch[system]` | 1 | comparable（tamper宣言） |
| tamper-options | 出力上限−1 | `request_digest_mismatch[options]` | 1 | 同上 |
| tamper-prefix | prefixのない試行に別prefixを付ける | `request_digest_mismatch[prompt, options]` | 1 | 同上 |
| tamper-prefix-content | M15のprefix本文を変更 | `request_digest_mismatch[prompt]` | 1（M15） | 同上 |
| tamper-session | M15のagentIdをconversationIdと異なる値に | `request_digest_mismatch[options]` | 1（M15） | 同上 |
| tamper-drop-entry | 応答1件の欠落 | `extra_call` | 1 | 同上 |
| tamper-extra-entry | 応答1件の追加 | `unconsumed_response` | 1 | 同上 |
| tamper-identity | decisionIdの二重束縛 | `identity_conflict` | 1 | 同上 |
| tamper-corrupt-response | 応答本文だけ変更（digestは旧値のまま） | `response_digest_mismatch`（応答を返さない） | 1 | 同上 |
| tamper-response | 応答とdigestを正しく更新 | なし（境界は通る） | 1（proposal・ticket・状態digest・委譲作用の差） | 同上 |
| adjacent-src-replay | 隣接srcへの差替え | なし | 0 / 28 | comparable（Agency identity 49項目を宣言） |

境界で拒否した試行は全て`runner_error`（`replay_mismatch:…`）で、拒否した試みとして`refusedAttempts`に数えた（未消費だけの`extra-entry`では拒否した試みは0）。隣接srcの一致は、この28試行（本体所有SystemContextとJSON入力による背景update／select、M15のprefix経路を含む）に限った結果である。一般的な同等性は意味しない。

## 6. 初回r1との関係

r1は保存したまま書き換えていない（[r1生成物](../../../verification-reports/agency-shadow/p0-20261105/)）。r1の記録: 基準27件全pass、同一再生一致、改変7種の検出、故障注入5件、再集計11run一致、Agency verify 814 pass、本体fixtureは`autonomy.test.ts`の依存不足で1 fail（当時は`packages/dots-mcp/node_modules`が候補になかった）。親レビューで次が判明したため、r1の判定は最終結果として扱わない。

| ID | r1の欠陥 | 影響した受入ID | r2の対処と証拠 |
| --- | --- | --- | --- |
| R1 | agentSessionをpresent／absentに縮約していたため、agentIdと未知フィールドの差が比較から消えていた | A02 | 宣言identityだけを同値tokenにし、他は完全比較。反例・欠落・null・追加・変更の回帰試験と、tamper-sessionの検出 |
| R2 | 保存された応答のdigestを返却前に検査していなかった | A02 | 返却前の検査と`response_digest_mismatch`。tamper-corrupt-responseの検出。digestを正しく更新した変更は記録比較で検出 |
| R3 | 上限をcaseの間で`>`比較していたため、上限を超えたattemptを実行できた。runStep内の例外ではserve済みの計量が落ちていた | A03・A07 | 境界での強制とcaseの前の`>=`。境界試験（max=0・1・再試行・2段目）、cap-0／1／45、F03 |
| R4 | installed distとtgzの中身の一致を示していなかった | A06 | ファイル単位の照合（92対92、差0）と偽hostの負対照 |
| R5 | 会話prefixを含む正の再生基準がなかった | A02 | M15（製品の組立てとllm-port、合成データ）とprefix・sessionの改変検出 |

r1とr2はケース数・schema版・組立てdigestが異なるので、比較組としては比べていない。

## 7. テスト・検証結果（r2）

| 対象 | コマンド | 結果 |
| --- | --- | --- |
| Agency 変更前（r1開始時） | `bun run verify` | 795 pass、0 fail、23 skip、1 todo（819件・62ファイル）。[ログ](../../../verification-reports/agency-shadow/p0-20261105/logs/agency-verify-before.log) |
| Agency P0試験 | `bun test eval/initiative/` | 34 pass、0 fail（P0試験32件と既存2件） |
| Agency 最終（r2コード固定後） | `bun run verify` | format・lint・型・境界・test全て成功。827 pass、0 fail、23 skip、1 todo（851件・63ファイル）。[ログ](../../../verification-reports/agency-shadow/p0-20261105-r2/logs/agency-verify-final.log) |
| 本体 接続fixture | `bun test api/application/agency` | **全11ファイル 88 pass、0 fail**（`autonomy.test.ts`を含む。依存は親が置いた読み取り専用symlink）。[ログ](../../../verification-reports/agency-shadow/p0-20261105-r2/logs/host-agency-fixtures.log) |

本体の全体`bun run verify`は実行していない。理由は、本体ソースの変更がないこと、P0が使う接続部分（llm-port・組立て・受付・会話入力の組立て）を上記fixtureとAgency側の`research.test.ts`・`p0.test.ts`で直接通していること。

検証の順序: R1〜R5の修正と回帰→r2のコード固定→修正版の事前登録→正式run（record、replay、改変10、隣接lane、faults、cap-0／1／45）→再集計→コード不変の確認→Agency verify→本体fixture→保全検査→本報告・受入JSON・manifest写しの更新。検証中の編集はない。検証の入力と非入力は次のように区別する。事前登録（`preregistration.md`／`preregistration-r2.md`）は**固定入力**で、正式runの前に作成し、そのdigestを各runのmanifestに記録している。本報告・`p0-acceptance.json`・manifest写しは**非入力**で、検証の後に作成・更新したものであり、どの検証の結果にも影響しない。

## 8. 採用・不採用・保留の提案

| 対象 | 提案 | 根拠・条件 |
| --- | --- | --- |
| P0計測基盤（fixture lane） | **採用可（提案）** | r2でA01〜A08がpass（§3の範囲・制約つき）。正本配置後の基準run・再生でも同じ結果（§11）。ただし正本Agencyの`bun run verify`は、サンドボックスの`.env`読取り拒否のため標準コマンドでは未完走（段別では、無関係の`pack`試験1件だけ失敗）。自動では反映しない |
| 意味品質（dev10のlive、holdout16） | 保留 | liveは未許可。holdoutは独立評価担当が未指定のため作成していない。M01–M15は本作業で作った合成 |
| live usage・費用・時間 | 保留（unknown） | provider呼出し0 |
| 製品の会話store由来のprefixデータ | 保留 | 組立てとllm-portの最終経路は確認済み。prefixのデータ生成（`backgroundPrefixInTransaction`・`stateLinesInTransaction`）は会話storeが必要で、P0では未検証 |
| P1性能手順のバッチ構成 | 保留 | 26ケースのバッチはholdoutが前提。P1着手前に確認する |
| r1の判定 | 不採用（最終結果として扱わない） | R1〜R5（§6）。生成物は保存 |

P1を始める場合の固定条件: r2基準の`fixed`と`identity.host`／`environment`を同じにする。介入として扱えるのは、`p1Declaration`の候補Agency identityとobserveの指定だけ。候補版も、同じr2 cassetteで`replay`する。

## 9. 再現コマンド（r2）

作業ディレクトリは`eumenes_agency`。`O=../eumenes/verification-reports/agency-shadow/p0-20261105-r2`、`P=../eumenes/spec/verification/agency-shadow-p0-p1/preregistration-r2.md`とする。

```sh
bun eval/initiative/p0.ts record --out $O/baseline-record --preregistration $P
bun eval/initiative/p0.ts replay --from $O/baseline-record --out $O/baseline-replay --preregistration $P
for t in system options prefix prefix-content session drop-entry extra-entry response corrupt-response identity; do
  bun eval/initiative/p0.ts replay --from $O/baseline-record --out $O/tamper-$t --tamper $t --preregistration $P
done
bun eval/initiative/p0.ts replay --from $O/baseline-record --out $O/adjacent-src-replay --agency adjacent-src --preregistration $P
bun eval/initiative/p0.ts faults --out $O/faults --preregistration $P
for n in 0 1 45; do bun eval/initiative/p0.ts record --out $O/cap-$n --max-attempts $n --preregistration $P; done
bun eval/initiative/p0.ts aggregate --run $O/<run>   # 各runに対して実行
bun test eval/initiative/ && bun run verify
```

prefix-content／sessionの改変は、既定でM15を対象にする。既存の出力先へは追記しない。

## 10. 未実施事項・制約

- P1の実装・試験（禁止）、製品反映、サーバー操作、別担当への送信。
- 実モデルの意味評価・課金・live計量、holdout16の作成・評価、性能測定（P1）。
- observeは未実装（抑止はmockだけ）。本体の受付はfixture_onlyで、speak ticketの本体gateは範囲外。
- 製品の会話store由来のprefixデータ、音声・通知のport。
- 本体全体のverifyは省略（§7）。
- dry runはscratch（リポジトリ外）で行い、台本の定義誤りとr2の挙動確認だけに使った。採否には使っていない（[r1事前登録 §2.1](preregistration.md#21-正式run前のdry-runで直したもの)、[r2事前登録 §1](preregistration-r2.md)）。

## 11. 正本配置後の最終確認

2026-11-05、親レビューでR1〜R5の解消が独立に確認された後に実施した。コードは書き直していない。レビュー済みの同じファイルを配置し、検証しただけである。候補r2の結果を、正本で実行したとは扱わない。

### 11.1 配置

| 対象 | 内容 | 証拠 |
| --- | --- | --- |
| 正本Agency `eval/initiative/` | 配置前の正本: `main`・`79c0418d3a27…`。新規6ファイルは未存在、`research.ts`／`trials.ts`はHEADのまま（利用者の先行変更なし）。候補の8ファイルが`control/reviewed-p0-files.json`のhashと一致することを確認し、同じ相対位置へそのままコピーした。配置後の8件ともレビュー済みhashと一致。新しいロジック・試験は追加していない | [copy-agency-files.log](../../../verification-reports/agency-shadow/p0-20261105-final/logs/copy-agency-files.log)、[code-freeze-final.sha256](../../../verification-reports/agency-shadow/p0-20261105-final/logs/code-freeze-final.sha256) |
| 正本Eumenes `spec/verification/agency-shadow-p0-p1/`と、生成物`p0-20261105{,-r2}/` | 正本に存在しなかった場所だけに、264ファイルと親の検査3件をコピーした（計267件、全てhash一致）。node_modules・.git・製品data／設定／.envは含めていない | [copy-eumenes-artifacts.log](../../../verification-reports/agency-shadow/p0-20261105-final/logs/copy-eumenes-artifacts.log) |
| 正本の設計書2件・`spec/README.md` | 候補の写しで上書きせず、正本の現物を編集した。作成時の「未承認・未着手・担当を起動しない」は履歴として残し、「利用者がP0だけを委譲実装として承認→fixture計測基盤を実装・受入検証、P1は結果確認待ちで未着手、実モデル意味評価・holdout・製品反映は未実施」と本報告へのリンクを加えた。P1以降の契約は変更していない | 各文書の冒頭・残作業 |

配置後、正本Agencyの`eval/initiative`以外に利用者側の変更が現れた（`README.md`、`eval/action-steps/run.ts`、`eval/f-fusion/run.ts`、`eval/live-b1-f/run.ts`、`standalone/claude.ts`、`standalone/cli.ts`、未追跡の`standalone/api-keys.ts`・`standalone/test/api-keys.test.ts`）。これらはP0の変更ではない。触れておらず、manifestの`identity.agency.changed`にそのまま記録した（[状態ログ](../../../verification-reports/agency-shadow/p0-20261105-final/logs/agency-status-after.log)、[並行変更の記録](../../../verification-reports/agency-shadow/p0-20261105-final/logs/agency-concurrent-changes.log)）。配置した8ファイルは最終runの後もレビュー済みhashのままだった。

### 11.2 検証（コード固定のまま）

| 対象 | コマンド | 結果 |
| --- | --- | --- |
| 正本Agency | `bun run verify` | **標準コマンドでは完走していない**（終了コード1）。原因: 正本Agencyのルートに`.env`があり、サンドボックスがその読取りを拒否する。bunの子プロセスは起動時に`.env`を自動で読むため、EPERMで終了する（[証拠](../../../verification-reports/agency-shadow/p0-20261105-final/logs/agency-env-file-evidence.log)）。1回目はformat:checkが並行変更中の`standalone/`2ファイルを報告していた（その後、利用者側の編集で解消） |
| 同上（段別、`.env`を読まない） | `bun --no-env-file run format:check`／`lint`／`typecheck`、`bun --no-env-file scripts/check-boundaries.ts`、`bun --no-env-file test ./src ./test ./standalone ./eval` | format・lint・型・境界は成功。testは830 pass、**1 fail**、23 skip、1 todo（855件・64ファイル。並行変更の試験を含む）。失敗は`test/core/pack.test.ts`で、試験が起動する子`bun --eval`が正本ルートで`.env`を自動で読みEPERMになるため。`pack.ts`・`pack.test.ts`はHEADのままでP0と無関係なので、修正していない（[段別ログ](../../../verification-reports/agency-shadow/p0-20261105-final/logs/agency-verify-steps-no-env-file.log)、[testログ](../../../verification-reports/agency-shadow/p0-20261105-final/logs/agency-test-no-env-file.log)） |
| 正本Agency P0試験 | `bun --no-env-file test eval/initiative/` | 34 pass、0 fail（[ログ](../../../verification-reports/agency-shadow/p0-20261105-final/logs/agency-p0-tests.log)） |
| 正本Eumenes 接続fixture | `bun test api/application/agency` | 全11ファイル 88 pass、0 fail（[ログ](../../../verification-reports/agency-shadow/p0-20261105-final/logs/host-agency-fixtures.log)）。`--no-env-file`でも同じ結果 |

### 11.3 正本runnerでの基準run

正本に配置したrunnerで、修正版の[preregistration-r2.md](preregistration-r2.md)（digest `e7fc55f4…`、候補と同一）を指定して実行した。条件はr2と同じ（同一ペア: final record→final replay）。正本Agencyのルートで`.env`を読まないよう`bun --no-env-file`を付けた。これは環境変数の読込みだけを止める実行オプションで、runnerの入力・コードは変わらない。

| 確認項目 | 結果 |
| --- | --- |
| manifestの絶対位置 | `resolvedFrom` `/Users/y.noguchi/Code/eumenes/api/application/agency/runtime.ts`。実ロードentry `/Users/y.noguchi/Code/eumenes/node_modules/.bun/eumenes-agency@vendor+agency+eumenes-agency-0.1.3-e7b4096d5bd5.tgz+3a38e73420b28681/node_modules/eumenes-agency/dist/index.js`。本体`056afd43…`、Agency`79c0418d…`（いずれもmain） |
| 配布照合 | tgz `b4fc0e1e…`、tgz内`package/dist` 92とinstalled 92で欠落・追加・変更0。検査9項目が全てtrue（module同一性を含む） |
| baseline-record | planned 28、**28 passed**、serveしたattempt **46**、serve前の拒否 0、provider 0、外向き作用 0、usageは全てunknown |
| baseline-replay | 不一致0、記録差分**0**、束縛140件（5種）、比較組comparable |
| 再集計 | 2runとも保存値と一致 |
| 候補r2との対応（参考） | 28試行の記録比較で差0。台本・ケース・ラベル・組立て・SystemContext・dist・事前登録のdigestが同一。`replayDeclaration`での組の判定はhold。理由は、checkoutの位置とdirty状態の項目（事前登録のパス、`identity.agency`／`identity.host`の変更一覧・差分digest、`resolvedFrom`）が異なるためで、同一ペアの比較には使っていない |
| 製品data／秘密 | `data/`は読んでいない。runnerの存在確認（`existsSync`）はtrueを返したが、`ls`はEPERMで、中身には一度も触れていない。`.env`も読んでいない（サンドボックスが拒否し、bunは`--no-env-file`で起動）。秘密形状の走査は0件 |

証拠: [final-checks.json](../../../verification-reports/agency-shadow/p0-20261105-final/logs/final-checks.json)、[baseline-record](../../../verification-reports/agency-shadow/p0-20261105-final/baseline-record/)、[baseline-replay](../../../verification-reports/agency-shadow/p0-20261105-final/baseline-replay/replay-compare.json)、[再集計](../../../verification-reports/agency-shadow/p0-20261105-final/logs/aggregate-regeneration.log)、[baseline-manifest-final.json](baseline-manifest-final.json)。

### 11.4 保全と、最終報告の後の文書

正本Eumenesで`src`・`api`（SystemContext資産・権限を含む）・`web`・`packages`・`vendor`・`package.json`・`bun.lock`に変更がないこと、branchがmainのままであることを確認した（[保全ログ](../../../verification-reports/agency-shadow/p0-20261105-final/logs/preservation.log)）。正本Agencyでも`src`・`test`・`scripts`・`package.json`・`bun.lock`・`config`に変更はない。

本節を含む報告・受入JSON・manifest写しは、上記の検証とrunの後に作成・更新した。どの検証の入力にもなっていない。P1は未着手、live・holdoutは未測定のまま。
