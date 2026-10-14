# 共通Kanban・Codex SDK実装の検証記録

対象: `spec/codex-sdk-task-artifact-plan-2026-10-14.md` 改訂3から着手し、実測を改訂4へ反映。2026-10-15。

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
