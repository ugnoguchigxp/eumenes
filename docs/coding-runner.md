# CLI runner の実装状況

2026-10-10 JST。[計画02](../spec/delegated-coding-implementation-2026-10-09/02-coding-runner-and-mcp.md) のCLI/MCP基盤を実装中。実CLIはまだ有効化しない。

## 実装した部分

`packages/coding-runner` は製品DBを開かない独立したBun package。純粋なprotocol contracts、公式MCP TypeScript SDK 1.31.0によるstdio client/server、実行ごとのworker、非公開spoolを分けた。importだけでは起動しない。SDKの版はrepositoryの7日間のminimumReleaseAgeに従って固定した。

`coding` domainはworkspace、実行意図、operation、reservation、receipt、イベントcursorを所有する。applicationがtasks・Queueと結合し、task、dispatch job、coding intent、reservationを同じwriter transactionで保存する。MCPへの配送はtransaction外で行う。

MCP toolsは `runner.probe/start/inspect/continue/stop/read_evidence/git_operation` の7個に固定。path・shell文字列・executableをMCP引数にしない。`specRef` はbackendが構築したimmutable specの参照で、protocolは `eumenes-coding/2`。stdoutはMCP専用にし、CLIのstdout/stderrはworkerが常時drainする。

起動意図・spec・その実行用の管理設定はspawn前にfsyncする。同じoperation ID/digestの再送は保存済みreceiptを返す。不明な起動は `outcome_unknown` に保持し、再実行しない。CLI起動intentが残ったworkerも再起動しない。指定sessionの継続には初回の専用CODEX_HOMEを使う。保存済みPIDからkillせず、所有workerへの停止要求とprocess groupの終了確認を分ける。開始前の停止にもreceiptを残すので、後から届いた開始を実行しない。

絶対期限・heartbeat 15秒・lease 120秒・停止猶予5秒は監督推論から独立する。MCP切断やRPC取消をCLI停止と見なさない。backend停止時は停止要求を配送し、配送できなくてもleaseが失効する。

UTF-8/JSONLはbyte単位で組み立てる。途中行、1 MiBを超える行、実行20 MiB・全体200 MiBを超える保存は証拠不十分として停止する。保存対象は許可した公開message・工程イベント・snapshot digest。reasoning、provider event全体、コマンドの生出力、stderrは保存しない。既知のtoken書式とANSI/control bytesを除去するが、すべての秘密を検出できるとは扱わない。directoryは0700、fileは0600。通常のAPIログへ本文を渡さない。

証拠の読取時もイベントdigestと内容を照合する。範囲読取はUTF-8文字境界を保ち、nextOffsetを返す（limit 4〜65536 bytes）。turn.failed・終了code非0では証拠を失効させ、Git操作へ進めない。

取込みは最大100イベント/256 KiB。採用とcursor更新を同じtransactionで行い、重複digest・欠番・世代・権限の不一致を拒否する。観測は20 batchで区切り、続きがあれば短いQueue jobをすぐ作る。終了イベントを保存した後で最終receiptを公開し、完了イベントの取込みまでworkspace予約を保持する。監視の通信断・protocol不一致は要確認へ移し、取消と競合したlease更新は失効を配送する。turn終了、process終了、タスク完了は別の事実で、この基盤は完了文だけでタスクをcompletedにしない。

## Git証拠のfixture実装

canonical path、Git共通directoryのdev/inode、固定base SHA、`codex/` branchを検査する。snapshotは追跡・未追跡・削除・mode・バイナリのdigestを含む。レビュー中にsnapshotが変われば証拠を失効させる。

commitはspecの明示fileだけをstageし、snapshotとindexのmode/blobを照合する。既存stage、未承認の変更、clean filterの変換を採用しない。hookは有効のまま実行し、変更が生じたら結果不明にする。応答欠落は操作trailer・tree・parent・worktreeで照合し、commitを再実行しない。

pushは登録済みremoteのfetch/push URL、固定branch、commit SHA、期待remote SHAを確認する。確認済みcommitを通常pushし、remote refが一致したときだけ成功にする。force/mirror/tag・任意branchは入力にない。local設定のfollowTags/mirror/submodule送信を抑止し、file指定はliteral pathとして扱う。不明なGit効果はworkspaceを保留する。試験には一時bare remoteだけを使う。

## 実CLIの有効化条件と残る工程

本番entryはfixture modeを拒否する。production probeは `available=false / isolation_not_verified`。feature flagを1にしてもCLIは起動しない。標準workspace-writeだけで製品DB・秘密・ローカルAPIへの読取禁止、Git管理領域の保護、CLI認証と開発ネットワークの分離が成立したとは宣言しない。

`EUMENES_CODING_RUNNER_CONFIG` は管理者用0600のlocal設定fileを指定する。production設定の読取・workspace/CLIの変更検出まで用意したが、有効な隔離launcherはまだない。credentialをコピーしたり全体のCodex設定を変えたりしない。runnerを構成しない初期状態では従来どおりタスク登録のみ可能。

残る工程:

- C4: Linux隔離workerか同じmacOS上の隔離かを選び、実装と必須到達禁止試験を行う。
- C5: 実CLIの認証、正確なsession継続、構造化質問を受け入れる。
- C6: 登録済みcheck、固定snapshotレビューreceipt、Git操作のbackend結合を完成する。長いGit I/Oは監視・停止用MCPから分離する。
- C7: 実課金と配布の受入を行う。

引数とJSONLは [公式non-interactive仕様](https://developers.openai.com/codex/noninteractive/) とinstalled CLI 0.155.1のhelpを照合した。実CLI実行に成功したとは扱わない。

## API・検証

共通clientから認証済み `GET /api/coding/workspaces`、`GET /api/coding/executions/:id`、`GET /api/coding/executions/:id/events?after=0&limit=100` を読む。一般viewにはsession、PID、nonce、instruction、workspaceの絶対pathを含めない。操作はtasks公開操作を通し、読取APIで権限を変更しない。

`bun run verify -- --domain coding` にdomain/packageの境界・整形・lint・型・fixtureを含めた。`verify:all` もrunner package試験を含む。[検証記録](../spec/verification/delegated-coding/runner-fixtures.md)でfixture/live/実機器を分ける。

2026-10-10の[コードレビューと修正記録](../spec/verification/delegated-coding/runner-review.md)：対象37試験、結合回帰137試験とcoding domain gate成功。全体verifyは別領域の整形で未通過。

## 発言・終端・採取の事実（計画06）

receiptは `observation` を持つ（`turnOutcome` unconfirmed/completed/failed/cancelled/conflict、`terminalEventSeq`、`processStarted`、`captureState`、`captureIssues`）。直接CLI 0.155.1のexec JSONLにはphaseもturnIdもないため、messageは常に `messageKind=unknown`（`phase_not_provided`、想定外のphaseは `phase_unsupported`）。commentary/final_answerとexplicit_contractは型に予約しただけで、adapterは出さない。本文は32,768 UTF-16 code unitのprefix（code pointを割らない）で、`sourceTruncated` と秘密除去後/保存後のbyte数、`contentPresence` を発言metadataに残す。孤立surrogateは置換せず `runner_invalid_unicode` の採取障害にする。

終端は明示した `turn.completed` / `turn.failed` だけ。一般の `error`、process終了、停止要求から作らない。completed後のfailed等の矛盾は `conflict` になり、証拠適格性も下げる。`turnFinished` は引き続き「正常終端」の意味（失敗でtrueにならない）。`evidenceComplete`（Git/continueの保守的gate）と `captureState`（採取・保存の完全性）は別で、失敗turnでも採取が正常なら `captureState=complete`、`evidenceComplete=false`。長文の `sourceTruncated` は両方を変えない。

`processStarted` は所有workerがspawnを確認したときだけtrue、起動前停止はfalse、spawn intentだけ残った場合と旧receiptはunknown。v1 spec/receiptは閲覧と停止照合に限り、新規start・continueはしない（`runner_protocol_mismatch`、`coding_legacy_continue_unsupported`）。protocolは `eumenes-coding/2`。

macOSでは、全メンバーがzombieのprocess groupへの `kill(-pgid)` が EPERM を返す。停止確認ではESRCHと同じく「生存なし」として扱う。

