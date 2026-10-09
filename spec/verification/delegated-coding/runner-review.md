# 計画02 CLI/MCP基盤のコードレビュー

2026-10-10 JST。対象は未commitの `packages/coding-runner`、`coding` domain、tasks/Queueとのapplication結合、HTTP/clientおよび対応試験。計画01は既存回帰試験で確認した。並行作業の他領域の差分は対象外。

実装済み範囲で見つかった指摘を修正し、再レビューと結合試験を実施した。最後の確認では追加の修正指摘なし。実CLI隔離や実課金受入まで完成したという意味ではない。

## 修正した指摘

| 対象 | 問題と修正 |
| --- | --- |
| CLI継続 | 実行ごとに新しいCODEX_HOMEを使っていたため、指定sessionの履歴を読めなかった。初回実行の専用保存場所を継続実行に引き継ぐ。fixtureも保存履歴なしのresumeを拒否するよう変更し、終了code・証拠・turn終了を照合した |
| 起動の再送・復旧 | workerのCLI起動intent後、reserved receiptだけが残ると再起動できた。intentがあるworkerを結果不明に保ち、保存PIDへ信号を送らない。起動時の管理設定を固定し、操作lock内の不要なawaitを除いて同時再送を一つのreceiptへ収束させた |
| 停止と失効 | pauseの停止記録が後の取消・失効を隠し、継続を許可していた。失効を不可逆にし、停止operation IDの引数を永続照合する。旧権限・古い実行からの継続も拒否した |
| CLI異常終了 | turn.failed・終了code非0でも証拠が完全な扱いだった。証拠を失効させ、失敗した実行からのGit操作と継続を拒否する |
| 最終状態の公開 | file_changedの保存時点でterminal receiptを公開し、最後のprocess_exitedが欠けた一覧を読めた。最終イベント列を保存してからterminal状態を公開する。終了処理を遅延するfixtureで順序を直接検証した |
| 監視通信断 | inspectの通信エラーが採用処理のcatch外にあり、観測できない実行へのlease更新が続いた。結果不明と要確認へ移し、独立heartbeatで失効を配送する |
| heartbeatと終了 | 更新待ちの間の取消、逐次RPCによる他実行のlease飢餓、終了後のheartbeatを対処。現在権限を配送前後に照合し、最大16件を並行配送する。終了時は進行中heartbeatを待ち、新しい更新を止め、停止配送にも期限を付けた |
| 権限・receipt・予約 | 同じepochで期限・操作・networkを差し替えられる条件と、完了状態・証拠flagの巻き戻りを拒否した。完了イベントを取り込むまでworkspace予約を保持する。取消後の物理停止確認は未採用の古い結果を取り込まず予約を解放できる。最新実行は壁時計でなく保存順で選ぶ |
| 証拠読取 | 保存内容をイベントdigestと照合していなかった。改変を拒否し、UTF-8文字境界を保つ範囲読取とnextOffsetを追加した。先頭BOMを保存内容の一部として扱う。範囲の最小limitは4 bytes |
| private file | boundedなfd読取に変更した。一方、atomic renameで開いた旧inodeのctimeだけが変わる場合は有効なsnapshotであり、内容変更と誤判定しない。別processが200回差し替える間の1000回読取を試験した。失敗したatomic writeの一時fileも残さない |
| workspace snapshot | 大きなfileを全部読んだ後で64 MiB上限を検査していた。読取前のsize検査、NOFOLLOW、固定長読取、前後fstatとHEAD照合を加えた |
| Git副作用 | filenameをpathspecとして解釈する危険と、local設定によるfollowTags/mirror/submodule送信を抑止した。replace refをGit証拠に採用しない。wildcard文字を含むfileと、mirror/followTags設定付きbare remoteで試験した。通常pushとhook保持の方針は継続する |
| 境界の整合性 | MCP tool一覧の重複・prototype名、直接adapterの不正cursor/範囲を拒否した。protocol digestの並びをlocaleから独立させ、domainとrunnerの契約を共有した。CLI操作一覧の重複も拒否する。同じ操作のfield順やoptional undefinedで偽の競合が出ないことも確認した |
| transaction callback | 非同期のprepareが返ってもtask/Queueをcommitしていた。PromiseLikeを拒否し、task・dispatch・monitorをrollbackする。遅いPromise拒否も未処理例外にしない |
| process ownership | 停止timerとerror/exit listenerの寿命を修正した。所有groupの停止確認後はそのPIDへ再度信号を送らず、残ったtimerを解除する |

初回結合試験では、通常fixtureがturn未完了で停止する1件の失敗も確認した。起動負荷と短いleaseの影響が疑われたため、通常fixtureを10秒lease/30秒deadlineに変更し、lease失効の試験だけ200 msを明示する。最終状態の公開競合とprivate file読取競合は試験待ち条件で隠さず実装を修正した。

## 最終検証

- `bun run verify -- --domain coding`: 成功。境界・整形・lint・型・37試験、1130 assertions、source hash照合を含む。
- runner/coding・application/client・tasks・Queue・Schedulerの結合回帰: 137件成功、0失敗、1730 assertions、15 files。今回16件追加し、既存のsession継続・Git push試験も強化した。
- 全体 `bun run typecheck`、対象applicationのlint、`git diff --check`: 成功。
- `bun run verify:all`: 別領域の整形7 filesで停止。timer-toolchain、toolchain fixture、timers capability/contracts、timer phrase、Queue runner、browser timers。全体ゲートの通過には数えない。

fixtureは一時repository・DB・Python CLI・bare remoteのみ使用。起動intentの復旧は残存receiptを再構成する試験であり、すべてのfsync境界の実process crash suiteを完了したとは扱わない。

## 残る計画と本番条件

計画02は実装中。C4の実効隔離、C5の実CLI認証・構造化質問・live session受入、C6の登録済みcheck/固定snapshotレビュー/Gitのbackend結合、C7のlive・配布受入は残る。Gitをbackendに結合する際は、長いGit I/Oを制御・監視用MCPから分離し、実隔離の保存容量・process制限も受け入れる。

production probeは `available=false / isolation_not_verified` を維持した。実CLI・実Provider・製品workspaceへのCLI編集・実remoteへのrunner pushは実施していない。会話agentへの報告、監督agent、Kanban/modal、Tauriの完成も宣言しない。

修正は未commit。別領域の差分をstage/unstageせず、他のCodexチャットへメッセージを送っていない。
