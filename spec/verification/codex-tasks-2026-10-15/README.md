# 共通Kanban・Codex SDK実装の検証記録

更新（2026-10-15）: 以下は各改訂時点の履歴。最新の停止契約は[計画の改訂7](../../codex-sdk-task-artifact-plan-2026-10-14.md)と[検証記録](../test-environment-migration-2026-10-15/sdk-lifecycle.md)を参照。利用者承認により、完全停止の未達試験を現行の管理対象終了・虚偽証明防止の契約へ変更した。過去の全daemon停止の失敗は取り消していない。


対象: `spec/codex-sdk-task-artifact-plan-2026-10-14.md` 改訂3から着手し、実測を改訂4へ反映。独立CLI復元を改訂5へ反映し、作業を継続。2026-10-15。

目的は共通ボード・担当別FIFO・workspace排他・SDK実行・共通通知・UI専用git工程をP0〜P5で実装・受入すること。依存順はP0実測→P1契約/移行→P2実行/登録→P3 GUI→P4通知/git→P5全体受入。P0の権限・停止・持続threadが成立するまで製品接続を開始しない。

## 着手時点

- main、HEAD `0bbcc83`。既存Claude Kanbanはカード/run/noticeと受付receipt、`waiting_turn/handed`契約を実装済み。
- 引継ぎにあるserver/settings/inference/steward/docsの14ファイルがdirty。これらへ本作業の編集を行わず、開始時の内容指紋を`/tmp/eumenes-codex-tasks-initial-diff.sha256.json`に保持。
- 製品DBの書込み/初期化、製品remoteへのcommit/push、新branch/worktree、別チャットへのメッセージは行わない。独立したテストrepositoryのbaseline commitは受入の許可範囲。
- 初期指示MCPを一度実行。add-toolchain、OpenAI Docs、登録/検証手順、data-driven-toolchain手順を確認。既存ボード・OpenUI・DomainAdapter・共通受付台帳を再利用する。調査用lockedCodexは使わない。

## 実行条件と段階

P0用の候補transportと検証器を`scripts/codex-tasks-p0/`に置く。製品runnerへの登録はしていない。SDK 0.160.0、CLI 0.162.1、Bun 1.4.3。環境はCLI認証に必要な既存HOME/CODEX_HOMEと基本runtime変数のみ。製品の接続/秘密/DBを複製しない。モデル名を固定せずCLIが実行時に解決するモデルを使う。

| 段階 | 条件・実行 | 結果 |
| --- | --- | --- |
| 部分・既存Claude基準 | `bun run verify -- --domain kanban` | 成功。domain 39件、Web 18件、型/format/lint/size成功、7222ms |
| 結合・既存Claude基準 | applicationのkanban-runs/reconcile/adapter/conversation/toolchain試験 | 成功、47件、292 assertions |
| P0 live・round 1 | `bun scripts/codex-tasks-p0/run.ts --run`。独立repoでsum編集、test、AGENTS marker、HEAD不変 | CLI起動時のfilesystem設定parse失敗、threadなし、副作用なし。SDKのdotted-path展開ではfilesystemのpath/globキーを表現できなかった |
| P0 live・round 2 | 同コマンド。filesystemをSDKの公開configOverridesからinline TOMLで渡す | 成功、38685ms。marker一致、実体のsum test成功、HEAD不変、stream終端確認 |
| P0 live・round 3 | `bun scripts/codex-tasks-p0/continue.ts <record> resume` | 別プロセスで同thread `01a13c47-0eee-7da1-9d25-68a639e382c5`を再開、marker一致、11698ms |
| P0 live・権限 | `bun scripts/codex-tasks-p0/permissions.ts <record>` | 26591ms。private読取り、Git書込み、作業場所外書込み、loopback接続、git addの5項目すべて拒否。先行の55359ms実行は途中formatが入ったため参考扱いとし、凍結して再検証した |
| P0 live・git commit | `bun scripts/codex-tasks-p0/continue.ts <record> git` | 同threadでGit metadataのみに追加writeを付与しcommit成功、51211ms。ホスト観測HEAD `e9432fcda053997fa685075fa4e37c6670addad2`。pushは未実施 |
| P0 部分・transport | `bun test scripts/codex-tasks-p0/transport.test.ts` | 5件成功。正常終了、4MiBの改行無し行拒否、通常子/別group子の停止、owner強制終了後の停止。lint/format/型も成功 |
| P0 live・停止round 1 | `bun scripts/codex-tasks-p0/stop.ts <record> SIGKILL` | 不合格。CLI/groupのみを終了する候補で、Python child pid63840/pgid63840が残存。自分のfixtureで開始した同一identityの生存子だけをcleanupした |
| P0 live・停止round 2 | 同コマンド、process-tree監視候補 | foreground command停止は成功。別groupの子孫も追跡し、PID＋開始時刻＋実行バイナリを照合して停止、ownerも同identityで監視した。ただし後述の孤児プロセスを見落とすため、全体の停止証明にはしない |
| P0 live・local push | `bun scripts/codex-tasks-p0/continue.ts <record> push` | 成功、27463ms。同thread・別プロセスで既存HEADをローカルbare remoteへpush。ホストでremote SHA=commit SHA、HEAD不変、親HEAD=baseline、変更path=sum.jsだけを確認 |
| P0 live・Abort/正常終了 | `bun scripts/codex-tasks-p0/stop.ts <record> ABORT` / `SIGTERM` | いずれもforeground command・CLI・launcherの終了をホストで確認。孤児の見落としがあるため、このケースの成功をP0全体成功へ昇格しない |
| P0 live・連続実行 | `bun scripts/codex-tasks-p0/continue.ts <record> repeat` | 4件成功、各16277/14750/15343/11940ms。既存のwork/resume/git/pushと合わせ5件以上のSDKプロセス起動を観測し、各観測対象プロセスの終了を確認。検証器のsource SHAは開始/終了で一致。任意の背景子の不存在は証明できない |
| P0 部分・孤児 | `bun test scripts/codex-tasks-p0/orphan.test.ts` | **失敗**。別sessionでsleepをspawnして親を即時終了すると、子が残存し、候補が誤ってstopConfirmed=trueを返した。期待値を弱めず残す |
| P0 live・孤児 | `bun scripts/codex-tasks-p0/orphan-live.ts <record>` | **失敗**、23625ms、SDK thread `01a13c58-7eae-7391-a354-05093516d2db`。turn.completed後もpid72306の/bin/sleepが残存、候補の停止確認は誤り。source SHA一致、SDK streamは正常。自分のfixtureの同一identityだけをcleanupした |

実測のfixture出力は`verification-reports/codex-tasks-p0/`に保存。Provider生応答やstderrは保存せず、fixtureの最終schema、イベントtype/item type/id、実行時間、ホストによる実体確認を記録する。

表中の`<record>`は`verification-reports/codex-tasks-p0/2026-10-14T21-17-30.766Z`。初回設定parse失敗だけは親ディレクトリの`work.json`。最終検証器はSDK error/例外の生メッセージを保存せず固定codeへ落とす。初回の設定parseエラーは秘密を含まないfixture起動エラーとして原因だけを本記録へ転記した。

実SDKではcommand_executionのstarted/completed中心の粒度を観測した。一文字ごとの配信を保証しない。巨大な改行無し行の拒否は4MiBを使った固定transport試験までで、実SDKの巨大出力受入は未実施。

3ラウンド後の俯瞰評価で設定修正と再開成功を確認し、権限/停止へ継続した。検証中のformatを認めた際はその結果を参考扱いに変更し、実行器に開始/終了のsource SHA照合を追加した。次の3ラウンドで権限/commitは成功したが、停止に新しい失敗根拠（別process group）を得たためgroupだけの方式から子孫identity追跡へ変更した。

SDK公開イベントのturn.started/completedにturn IDはないが、CLIの自分のfixture threadのturn_contextには内部IDと実効permission profileが保存されていた。SDK契約へ内部IDを取り込まない。実効権限はrestricted filesystem、network restricted、approval neverを確認。CLIのdebug prompt-inputはtool schemaを公開しないため、spawn_agent定義が出なかったことだけでtool無効化の受入成功とはしない。

`codex features list -c features.multi_agent=false -c mcp_servers={}`はmulti_agent/multi_agent_v2ともfalse、shell_tool=trueを返した。SDKの観測itemはcommand_execution/file_change/agent_message。サブエージェント実行は観測していないが、公開SDKからnative tool catalogを完全取得できるとの主張はしない。

## 現在の阻害要因と続行条件

ポーリングは、観測の間に分離・再parent化した子を列挙できない。intervalを短くする、nonce環境変数だけで探索する、shell文字列を禁止する、LLMの指示で背景化を禁止する方式では、停止証明を保証できない。この不具合は正常終端でも起き、誤ったworkspace解放と次の担当との競合につながる。

最後の修正でP0候補は`stopConfirmed:false`を必ず返し、`observedProcessesStopped`を別の観測として記録する。製品runner/guardへ登録していない。誤った証明の抑止だけではP0合格としない。分離した子を実際に停止する回帰試験は失敗したまま保持する。

macOS 26.6.2、Xcode SDK 26.2。現行`sys/event.h`はNOTE_TRACK/NOTE_TRACKERR/NOTE_CHILDが10.5以降非対応で、NOTE_FORKの子PIDをkeventへ渡さないと明記。EndpointSecurityのdescendants clientは現行SDKに宣言がなく、[Appleの専用entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.endpoint-security.client)も必要となる。追加権限やOS更新を無断で行わない。

続行案は、SDKを維持しつつ、attemptごとの子孫が分離しても抜けられないOSの管理単位に実行を置くこと。例えば[Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)には、forkとの競合も考慮して配下を終了するcgroup.killがある。実行環境の選定、必要な権限、固定workspaceの接続を設計し、この孤児・backend強制終了・空の確認をP0で通してからP1へ進む。この案は未実装・未受入。

独立して実施できた作業はP0検証器・再現試験・既存Claude基準・権限/履歴/gitの観測まで。P1以降を製品へ接続することは計画のP0 gateに反するため停止する。full access/App Serverへの変更、製品commit/push、製品DB操作は行っていない。

並行する「Restore missing artifacts and System」がKanban/Terminal bundle、tool-runtimeの受付、capability seed/upgrade試験等を改訂したことをread-onlyで確認した。これらは本作業由来ではなく、保存・保護する。P1直前には再度内容・並行変更の有無を確認し、artifact@2を上書きせず次版@3を採用する。

## 最終差分と確認

- 本作業の変更は`scripts/codex-tasks-p0/`の検証器・回帰試験11ファイル、この記録、実測を反映した計画改訂4。製品domain・adapter・bundle・UIは未変更。
- 最終候補のformat/lint/型は成功。固定transportは5件成功、孤児停止の回帰は1件失敗。停止確認の期待値は弱めず、実停止を要求するassertionも保持した。
- 既存Claudeの基準はdomain 39件＋Web 18件＋application 47件=104件成功。ブラウザ、実Claude、自然言語受付、P1以降の結合/移行/第三担当は未実施（P0 gate未達）。
- 着手時14ファイルの指紋は最後まで全件一致。後から増えた他作業の差分も確認し、編集・stash/resetを行わなかった。
- 個別発話の分岐、意味判断のコード化、固定モデル/profile名、製品のsecret/DB複製、製品commit/push、別チャットへの送信を追加していない。専用部分はSDK伝送・権限fixture・OSプロセス観測と失敗再現であり、外部仕様/実測を根拠にしたP0だけの候補。
- initial_instructions 1回、context_compile 1回、compile_eval 1回。compile run `00000000-0000-0000-18de-81da7ce35aa5`へ評価を保存した。

## P0〜P5の残作業

| 段階 | 状態・完了条件 |
| --- | --- |
| P0 | **未完了・停止証明が阻害要因**。接続/権限/履歴/git/foreground停止を実測済み。孤児を含むOSの実行境界、tool catalogの取得制約、最終candidateの通し受入が残る |
| P1 | 未着手。P0成立後、完成Claude保存形/公開参照の移行判断、executor登録port、共通状態、担当FIFO、transaction rollback、workspace guard |
| P2 | 未着手。SDK attempt/event/権限/復旧、独立担当bundle/adapter、共通runへの採用 |
| P3 | 未着手。共通KanbanBoardとActivityTimeline、OpenUI、担当/キュー/能力表示、ブラウザ |
| P4 | 未着手。notice API維持、UI git許可、commit証拠/工程保存/push照合/再起動 |
| P5 | 未着手。domain/結合/移行/第三担当fixture/ブラウザ/自然言語/実SDKとClaude受入 |

根拠: [公式SDK](https://learn.chatgpt.com/docs/codex-sdk)、[permissions](https://learn.chatgpt.com/docs/permissions)、[sandboxと保護パス](https://learn.chatgpt.com/docs/agent-approvals-security)。permission profileと旧sandbox設定は併用できないため、この候補は`default_permissions`のみで権限を選び、SDKのsandboxMode/networkAccessEnabledは渡さない。full accessは使わない。

## 改訂5での継続（2026-10-15）

ユーザーは独立CLIを復元ポイントとして設計を更新し、作業を続けるよう指定した。SDK自身の保存threadとresumeThreadを会話履歴の正本とし、runnerでは受付/実行状態/イベントcursor/報告/制御だけを保存する。backend停止時にSDKを終了する方式から、runnerが所有して継続する方式へ変更する。Dockerは採用しない。

旧孤児停止試験は失敗のまま保持する。独立CLI化はOS全子孫の停止証明を与えないため、managedExecutionStoppedとworkspaceReleaseConfirmedを分け、前者だけでは自動引渡しを拒否する。全daemon封じ込めを不要とするユーザー承認は得ていない。担当別固定workspace＋手動引渡しか、管理可能な実行環境かを確認中。

残作業: 独立CLIの部分/結合/live復元、重複実行防止、runner停止時unknown、停止操作、孤児時guard保持をP0で確認。その後P1〜P5へ継続する。上記の「停止」「最終」は改訂4時点の履歴であり現在の作業終了を表さない。initial_instructionsは通算1回、context_compile通算2回、compile_eval通算1回（最新compileの評価は完了時に記録）。

### 改訂5の実測・部分/結合結果

- packages/coding-runner/src/sdk-*へSDK専用CLIを追加。旧exec worker契約とconsumerは維持。SDK部分試験6件、runner全体68件（1217 assertions）成功。型/lint/sizeも成功。
- 実SDK復元: `runner-live.ts --run`。接続元のSIGTERM/SIGKILL後にそれぞれ完了、同epoch・同thread、再送時のturn.completedは各一件、HEAD不変、履歴をrunnerへ複製しないことを確認。thread `01a13c77-8765-7663-9b6a-ac9abf19c024`。source SHA開始/終了一致。結果 `verification-reports/codex-tasks-p0/2026-10-14T22-11-30.188Z/runner-recovery.json`。接続元は独立runnerを呼ぶbackend-portの検証clientであり、実Eumenes serverの通し受入ではない。
- 実SDK境界: `runner-boundaries.ts --run <record>`。manual Abort=cancelled/managedExecutionStopped=true、runner SIGKILL=unknown/同epoch/元指示再送なし、分離sleep残存=実測再現/引渡し拒否/guard保持。全ケースworkspaceReleaseConfirmed=false。source SHA一致。結果 `verification-reports/codex-tasks-p0/2026-10-14T22-13-54.910Z/runner-boundaries.json`。fixture残存processはPID/開始/実行バイナリ一致時だけcleanup。旧孤児の全子孫停止試験は失敗のまま。
- P1: kanban/0003-executors、共通状態/担当FIFO/汎用executor registry/旧@1投影/workspace guard/構造化状態採用を追加中。既存domain39・Web18とapplication47件成功。新共通fixture6件、移行/第三担当/rollback/unknown採用を確認。実SDKのボード接続・実PTY入力との排他・新GUI・bundle公開・git工程は未実装/未受入。
- 共有workspaceの引渡し方式は確認中。独立CLI化を全子孫停止保証の解決として扱わず、その判断に依存しないP1のみ先行する。

### P1〜P3の追加結果（実装継続中）

- codex-tasksの依存をcoding domainの公開入口へ接続し、fixture6件と選択domainの型/lint/format/size成功。公開入口を迂回するimportは除去した。最初の検証の型・依存規則の失敗は修正済み。試験追加前の「No tests selected」は未実装の試験が原因であり製品不具合として扱わない。
- applicationのSDK↔共通ボード結合4件成功。backend port切断/再接続、単一writerでの結果/通知のrollbackと再照会、sameworkspaceの次カード保留、同thread続行、unknownのguard保持を確認。偽SDK engineを独立runnerの実HTTP/Unix socket経路で動かすfixtureであり、実Eumenes serverのliveではない。
- SDK runner部分試験は8件に増加。明示的な新threadへの置換と、受付/前runのworkspace保有保存の途中crashでも、当該workspaceを凍結しつつinspectを継続するケースを追加。
- DesignSystemのKanbanBoard29件・ActivityTimeline3件=32件成功。第三の登録担当、利用不能な選択の保持（fallbackなし）、担当別再開、表示filterがwriteを起こさないこと、長い詳細/HTML文字列/追従停止を確認。DesignSystem build成功。ブラウザ/Storybook browserは未実施。
- P1〜P3の成果物はまだ製品ホスト/新bundleへ未接続。P4〜P5未着手。並行するWorld/research等の差分は保持し、その変更を本作業の成果に含めない。製品DB/秘密のコピー、branch/worktree作成、製品commit/push、他チャットへの送信は行っていない。


### 改訂6のホスト接続・Git進捗（継続中、2026-10-15）

- 共通ホスト、担当別登録、SDK専用設定、独立daemon接続、workspace/PTY入力排他、共通ボード/活動sourceを接続。旧kanban.bundle.jsonの内容はHEADと一致し、削除ファイルの復元漏れは見つからなかった。旧ボードのブラウザ4件とSDKボード1件はP3時点で成功。
- 部分/結合: runner全体75件・1243 assertions成功。最初の併走実行は既存protocol試験1件が5秒timeoutとなり、他74件は成功した。liveが終了した条件で当該3件を確認し、全体を凍結して再実行した75件が成功。期待値やtimeoutは変更していない。SDK/card接続4件、capability seed/upgrade4件（171 assertions）、旧adapter13件、DS32件も成功。
- 標準検証: codex-tasks（8件、35 assertions、970ms）、kanban（45件＋Web18件、4199ms）のsize/format/lint/型/試験・検証中のsource不変確認が成功。全体の型確認には担当外object-recognition browser試験のArrayBuffer/Iterable型不整合が一件残る。全体sizeにも担当外の既存/並行変更がある。これらを修正して検証を通す作業は行わない。
- P4部分: UIの元run/HEAD/内容指紋/登録remoteに結び付く許可を保存し、別SDK turnのcommit→pushを同一操作group内で行う。private MCPは一工程のツールだけを公開し、通常shellはread-only/network禁止を維持。ホストがバイナリ/削除/新規ファイルの内容、親HEAD、tree、branch/remote、期限、SHAを照合する。部分試験5件では再送一回性、後からの変更/混在/余分なstage/remote変更/不明intentの拒否を確認。
- 実SDKのGit受入: git-live.ts --run。最初はMCPの既定承認要求がapprovalPolicy=neverで拒否され、Git副作用は未開始、process観測の終了判定も未確認となった。privateなUI許可に限定する一工程のtool approval設定を公式MCP仕様に従って追加。実行バイナリが変わったPIDはsignalせず、同PID/開始時刻の生存中は完了を拒否し、zombie/終了後に観測対象の終了を判定する。
- 二回目のliveはwork/commit/pushの3SDK turnが同threadで成功。親HEAD=baseline、変更path=value.jsのみ、remote SHA=検証済みcommit、commit数2、同一受付再送で同epoch、管理対象終了、source SHA開始/終了一致。記録: verification-reports/codex-tasks-p0/2026-10-15T00-40-20.993Z/git-live.json。これは隔離したrunner/ローカルbare remoteの受入であり、Eumenes APIの通しではない。全OS子孫の停止保証へ昇格しない。
- SDK履歴はnative sessionだけを正本とする。CLIのcodex-runnerは製品DBを開かず、backend API認証の前に独立runner APIへ状態取得/停止を接続する。recoverによる未知工程の照合は残作業で、現状は保存状態の再照会。
- 運用ログに適用済みkanban/0003-executorsのchecksum不一致を確認したため、0003のSQLをGit追加前へ戻し、追加は0004-gitに分離した。製品DBの書換えやmigration checksum更新は行わない。画面/受付の新しい参照は共通artifact@4・Kanban binding/toolchain@4・Codex binding/toolchain@2。登録整合性試験は成功。保存済みの旧revisionは更新しない。
- ブラウザGit受入は継続中。最初は画面の文字列revisionを変換後のbuiltin数値schemaで検査して拒否した。画面用schema:kanban-git@1を追加し、実行時の厳密schemaを維持。登録参照のずれも検証で修正。次は受入済みの登録から画面操作を確認する。

残作業はGitの不明工程の読取り照合とUI制御、partial成功/通知、活動の過去run/cursorとClaude source、PTY排他の競合試験、設定UIの繰返し保存、Eumenes APIの独立runner復元live、自然言語/両担当/ブラウザの最終受入。製品DB/秘密のコピー、製品commit/push、branch/worktree作成、他チャットへの送信は行っていない。

### Kanban契約のHEAD復帰調査と画面反映の追加確認

- 利用者が指定した対象は `api/domains/capabilities/contracts/kanban.ts`。Claudeの作業記録では2026-10-14T23:27:53.742Zにcontracts全体を整形し、23:28:03.422Zに同ファイルをHEADへ戻していた。Codexの22:56:07.707Zの読取り記録はHEADの契約と一致する。その後HEAD復帰までに同ファイルへ機能変更を加えた呼出しも見つからない。記録から復元できる変更は3か所の整形であり、入力契約の変更を推測して追加しない。共通担当用の契約は別のkanban-shared.tsに保持されている。
- 対象ファイルだけ整形を復元した。kanban標準検証はdomain45件＋Web18件、size/format/lint/型とsource不変確認が成功（4106ms）。claude-code.tsや他作業のHEAD復帰には手を加えていない。
- SDKブラウザの追加診断: 単発成功後の3回確認で2成功・1失敗。失敗時もrunnerの3実行はすべてsucceeded、pendingは空、保存済みカードはDone、Git runはcompleted。画面だけが開始待ちだった。timeoutだけを原因とする仮説は棄却する。
- 次の診断付き3回は全成功したが、解消の根拠にはしない。取得中断と同じactive receiptの繰返し採用によるboard revision更新を観測したため、driverは内容とcursorが同じactive receiptを再採用しない。停止要求と終端結果はこの省略の対象外。結合5件が成功し、同じ観測3回で更新通知0件、終端採用と通知一件を確認した。警告はattempt/理由ごとに一度記録し、回復後は解除する。

俯瞰評価: 診断3ラウンドで実行側と表示側を切り分けた。正常な長時間処理の停止や待ち時間の引上げは行わず、重複した状態出版を減らす方針へ変更した。画面反映の最終判断は変更後のブラウザ結果で行う。

- 重複更新抑止後のブラウザ連続3回が成功。board revisionは各20、ボード応答は各9〜11件となり、変更前の約50 revision・約30応答から減少した。その後、Git制約とフォームを更新した候補でもSDKボード＋設定の連続保存のブラウザ2件が成功（41.4秒）。失敗記録は原因を完全に証明したものとして消去しない。
- SDK Git部分9件成功。active hook・署名設定は変更せず拒否し、認証用Git設定によるURL書換え、存在しないremote ref、許可外の既存commitを含むpushを拒否する。最初のfixtureは利用者のglobal hooks設定を意図せず継承していたため、隔離repoのsetupで自身のhooksディレクトリを正本にした。製品設定は変更しない。
- coding標準検証97件（runner79件＋domain18件）、1310 assertions、型・境界・size・format・lint・source不変確認が成功（99316ms）。初回の境界検査はSDK内部ファイルの直接再exportを拒否したため、既存contracts/clientの公開窓口へ揃えた。境界規則は緩めていない。
- 共通フォームは、保存後に新しいdefaultsを反映し、編集済みのフォームは古いpreconditionを維持して外部更新との競合を検出する。追加2件とartifact標準検証46件が成功（2604ms）。試験のDOM matcher・browser専用option、および既存の今回差分のlint/整形を直してから確認した。
- 最後のkanban標準検証もdomain45件＋Web18件、型・size・format・lint・source不変確認が成功（4056ms）。設定のモデル選択は保存済み候補だけを表示し、候補がない場合はAI接続設定へ案内する。利用不能な保存済み選択は保持し、自動で別モデルへ切り替えない。

この追加結果でP4/P5全体の完了とはしない。unknownの明示照合、過去run/Claude活動、PTY競合、独立runnerを使うEumenes APIのnative live受入、自然言語/両担当の最終受入は引き続き残作業。
