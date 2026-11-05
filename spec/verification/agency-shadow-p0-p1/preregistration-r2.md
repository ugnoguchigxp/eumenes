# Agency Shadow P0 修正版 事前登録（r2）

作成: 2026-11-05、r2の正式runより前。初回の[事前登録](preregistration.md)とその結果（`verification-reports/agency-shadow/p0-20261105/`、以下r1）は**初回結果として保存**し、書き換えない。親レビューは受入を妨げる事項R1〜R5を挙げた。r1の「A01〜A08全pass」は、この5件の欠陥を含む機構による判定であり、最終結果ではない。r2は新しい出力先`verification-reports/agency-shadow/p0-20261105-r2/`で測り直す。範囲・禁止事項はr1と同じ（P0のみ。P1・実モデル・製品反映・src/api・依存・サーバー操作・commit／pushなし）。

## 1. 修正内容（コード固定: `eval/initiative/*.ts` のsha256をr2固定として記録）

| ID | r1の欠陥 | r2の修正 | 回帰試験（`p0.test.ts`） |
| --- | --- | --- | --- |
| R1 | `requestParts`が`agentSession`をpresent／absentに置き換えて`conversationId`だけを取り出していた。`agentId`と未知の追加フィールドが比較から消えていた | 宣言したtransport identityを`decisionId`・`requestId`・`attemptId`・`conversationId`・`agentId`に拡張し、`agentId`を明示宣言した。比較対象のoptionsでは、identityの文字列だけを、同じrequest内で値ごとに決まるtoken（`<identity:n>`）に置き換える。こうすると`agentId = conversationId`という同値関係も比較される。それ以外のフィールドは未知・null・欠落を含めてそのまま比較する。request間では種類ごとに一対一で束縛する | 親の反例（agentId one→two、unexpected a→b）でdigestが異なること。欠落・null・追加・値の変更、agentSessionの有無、top-levelの追加でも異なること。identityを一貫して改名した場合だけ一致すること。agentIdを含む再束縛を拒否すること |
| R2 | 再生時に`expected.responseDigest`を検証せず、保存された応答をそのまま返していた | 返却前に`digest(response) === responseDigest`を検査する。不一致なら`response_digest_mismatch`として記録し、応答を返さない。digestを正しく更新した意図的な応答変更（tamper `response`）は従来どおり再生を通し、記録比較で挙動差を検出する | tamper `corrupt-response`（本文だけを改変しdigestは旧値のまま）→境界で拒否。tamper `response`（digestも更新）→境界は通り、記録比較で検出 |
| R3 | attempt上限をcaseの間で`>`比較していたため、上限1でもupdateとselectの2件が実行され、上限と同数でも次caseへ進んでいた | 上限は各物理attemptをserveする前に推論境界で強制する（再試行・複数stepを含め、1件も超えない）。各caseの前の停止条件は`served >= max`。上限で拒否したstepは`incomplete:stopped:cost_exceeded:attempt_cap`、残りの予定試行も全てincompleteとする。serve済みのattempt（`attempts`）と、serve前に拒否した試み（`refusedAttempts`・理由別`refusals`）を分けて数える。runStep内で例外が出た場合も、serve済みのattemptとusageをそのstepの記録に残す（r1では0件の空記録になっていた） | max=0・1、再試行中（max=2）、2段目のstep（max=3）の境界。故障注入F03（呼出しの後のrunner例外）でattempt 2件とusage 2件が残ること |
| R4 | tgz checksumと導入版のversionを別々に調べるだけで、installed distがtgzの中身と同じであることは示していなかった | `compareArtifactToInstalled`: tgz内の`package/dist/*`と、実際にinstallされたdistの全ファイルをsha256で比べ、欠落・追加・変更を列挙する。`installedDistMatchesArtifact`を測定開始の必須検査に加えた | 実物は92対92で差0。一時の偽hostでは、checksum・version・定数が全て一致したままでも、dist内ファイルの変更・欠落・追加を検出すること |
| R5 | 会話prefixのない基準しかなく、prefixがある場合の正の再生基準がなかった | 機構ケースM15を追加した。合成の`ConversationPrefix`と`## State`を、製品の`taskMessages`／`backgroundMessage`で組み立て、製品の`createAgencyLlmPort`に最終messages・native schema・session（`onConversation`、`agentSession`）を作らせる。record→replayで一致させる | M15の要求で、prefixのsystemが除かれていること、user／assistant／userの並び、`## State`と`## Task`、`onConversation`、agentId＝conversationIdのtoken。tamper `prefix-content`（prompt）と`session`（options）を検出すること |

R5で区別する点: prefixのデータ（直近の会話・`## State`の本文）は合成である。製品では`backgroundPrefixInTransaction`／`stateLinesInTransaction`が会話storeから作るが、P0はstoreを開かないので、これらは通っていない。製品コードを通るのは、組立て（`taskMessages`／`withLastMessage`／`backgroundMessage`）とllm-portの最終経路である。

その他: `gitIdentity`は未追跡のsymlinkを辿らず、リンク先の文字列でdigestする。これは本体に親が置いた`packages/dots-mcp/node_modules`への対応。組立てdigestの対象に`conversation-input.ts`・`input-text.ts`を加えた。記録schemaは`agency-p0-trial.v2`・`agency-p0-cassette.v2`・`agency-p0-manifest.v2`に上げた（r1の生成物はv1のまま保存）。

## 2. ケースと期待

- 基準: dev 10（r1と同じ）＋機構 M01–M15（18 step）＝予定28件。M15の期待は、ticket=speak、source=llm、本体受付=not_checked、期待拒否=いいえ。M01–M14とdevの期待はr1から変えない。
- 故障注入（別run）: F01 runner例外、F02 推論失敗、F03 呼出しの後のrunner例外（新規）、F04 schema違反の選択、F05 停止後の2段。予定6件。停止の注入はF04の後とする。
- holdout 16は引き続き未作成・未実施。M01–M15は本作業で作った合成であり、独立未見ではない。

## 3. 実施するrunと判定

出力先`<O>=verification-reports/agency-shadow/p0-20261105-r2`、作業ディレクトリ`eumenes_agency`。

| run | コマンド | 期待（pass条件） |
| --- | --- | --- |
| baseline-record | `bun eval/initiative/p0.ts record --out <O>/baseline-record` | 28/28 passed、外向き作用0、refused 0、配布物の検査（`installedDistMatchesArtifact`を含む）が全てtrue |
| baseline-replay | `… replay --from <O>/baseline-record --out <O>/baseline-replay` | 不一致0・記録差分0。束縛にagentIdとconversationIdを含む |
| tamper×10 | `… replay … --tamper <kind>` | system・options・prefix（dev-previous-task）→`request_digest_mismatch`。prefix-content→同[prompt]（M15）。session→同[options]（M15）。drop-entry→`extra_call`。extra-entry→`unconsumed_response`。identity→`identity_conflict`。corrupt-response→`response_digest_mismatch`。response→境界は通り、記録比較で差分。いずれも対象の1試行だけ |
| adjacent-src-replay | `… replay … --agency adjacent-src` | 比較組comparable（宣言済み差のみ）。結果は観測値をそのまま報告する（一致を必須にしない） |
| faults | `bun eval/initiative/p0.ts faults --out <O>/faults` | 6/6記録。F03はattempt 2件を保持。欠落・重複・未知を派生コピーで検出 |
| cap-0／cap-1／cap-45 | `… record --out <O>/cap-N --max-attempts N` | serveしたattempt数がN以下で、ちょうどN（基準run全体では46件が必要）。拒否した試みは別に数える。停止以降の予定試行は全てincompleteとし、passにしない |
| aggregate | `… aggregate --run <各run>` | 全runで生記録からの再集計が保存値と一致 |

その後、Agencyの`bun run verify`と、本体の`bun test api/application/agency`（全11ファイル。依存は親が置いた読み取り専用symlink）を実行する。失敗しても担当外は修正せず、証拠を残す。外部モデル呼出しは0のまま。

## 4. 受入の判定基準（r1からの変更点）

- A02は、prefixのない基準、正のprefix基準（M15）、session・prefix内容の改変検出、境界での応答破損拒否が全て揃った場合だけpassとする。
- A03・A07は、上限超過0、拒否と実serveの区別、停止後のincomplete全件、例外時の計量保持をpass条件に含める。
- A06は、installed distとtgzのファイル単位の一致をpass条件に含める。
- 検証できない必須項目が残ればpassとせず、unknown／保留とする。
