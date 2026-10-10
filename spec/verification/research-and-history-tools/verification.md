# 検証記録

実施日: 2026-10-10 Asia/Tokyo。対象は `bc8cc6c24e9b9fe327bc545fa1bfe4ab1b6bf8fc` に開始時の未コミット変更と今回の実装を加えた作業ツリー。既存の他作業の差分を巻き戻していないため、この記録は作業ツリー全体の検証であり、未コミット差分すべてを今回の実装とみなすものではない。

## fixture

固定応答の版は `api/application/research-history.fixture.ts` と `research-history.test.ts`。API・CLIは試験用backendと試験用DBを使用。保存本文の合成資料と保存履歴だけを使い、外部通信・実credential・製品会話を使用しない。

受入シナリオR1〜R8・H1〜H8の対応表と、実装内容・実行手順は [README](README.md) に記載した。引用版・owner・原文revisionを誤らせたケースでは受理・採用が失敗する。これを正常系の引用が通る試験と組み合わせて確認している。

初期の全体検証では、凍結済み移行順序を前提とする試験、報告修復回数と精密な検証エラーを前提とする試験に不整合が見つかった。既存SQL・旧reportを維持し、新しい移行だけを全legacyの後へ追加した。新revisionの修復回数と旧revisionの回数を分け、失敗位置を正確に返すschema選択に修正した。最終再検証の結果を以下へ記録する。

続く全体試験は1,168件合格・1件skip・Git送信試験1件の5秒timeoutだった。単独再実行でも複数のローカルGit処理が5秒前後かかったため、該当する2試験だけを15秒の有限timeoutに調整した。検証条件・期待値・製品側の期限は変更していない。`bun test packages/coding-runner/test/git.test.ts` は再検証で8件合格・0件失敗、終了コード0（26.55秒）。

clientの既存fixtureに、現行の `codingSupervision.approveInstructions` と `pendingApproval` が欠けていたので補った。301件すべて合格。Web253件・共通UI部品1,086件・ビルドも通過した。

ブラウザの初回全体実行は37件合格・5件失敗。取得経路の管理とテーマ切替は単独再実行で通過した。再現した不整合は、画像fixtureの相対URLが現行のURL検査に合わないこと、アバターの描画再利用に対する古いcanvas再作成の期待、初回描画の停止時間がタイマーのHTTP時刻標本に混ざることだった。画像fixtureを既存SVGのdata URLへ変換し、アバターは同じcanvasで動作・停止し、画面遷移で解放することを検査した。タイマーの時刻検査は初回描画の準備完了後に開始する。画像・アバター・テーマ試験は再検証で合格、タイマー単独再検証も1件合格（11.6秒）。並列fixtureのbackend/Vite起動による競合を抑えるため、ブラウザworkerを2に制限した。製品の時計・期限・URL検査・描画実装を緩めていない。画像fixtureの利用側artifact検証は40件合格、終了コード0。

続く全体ブラウザ実行は41件合格・取消後の表示待ち1件の5秒timeout。遅延した初回描画とfixture通信の完了を待てるよう、ブラウザのexpect待機を既存の起動待機と同じ20秒へ統一した。判定内容・製品側の予算と期限は変更していない。

最後の取消・再読込みケースの単独再実行は1件合格、終了コード0（8.5秒）。この後、全体検証を再実行した。

次の全体実行では型検査通過後に共有作業ツリーのAppへ別作業の編集が入り、Webビルドが一時的に構文エラーとなった。その編集は巻き戻さず、更新後のコードを再確認した。最新の型検査とWebビルドは終了コード0で通過し、落ち着いた作業ツリーで全体検証を再実行する。

別作業で設定画面がファイル移動したため、383行の既存関数のsize ratchetのキーを新しいパスへ移した（数値は変更なし）。App側の設定表示は小さい描画componentへ分割し、Workspaceの元の上限617行以内を維持した。サイズ検査は619ファイルで通過。新しい数値上限や例外は追加していない。

共有作業ツリーに追加された音声ブラウザfixtureの起動helperを接続した。通知復旧試験では初回読込み・ブラウザfocusによる先行取得が「復旧前は旧表示」の前提と競合したため、障害中だけ既知の旧スナップショットを返すfixtureへ修正した。復旧後の新規取得・表示・警告解消は変更せず、単独再検証は1件合格、終了コード0（2.7秒）。

追加されたnative仮想マイク試験はmacOSのheadless Chromiumで取得が止まった。アプリを介さない一時HTTPページでも、headless shell・通常Chromium・音声ファイルを指定しない仮想機器の3構成がすべて5秒でtimeoutした。最終の共有コードはmacOSではこのfixtureをskipし、`EUMENES_FAKE_MEDIA=1` で強制実行できる形になった。他OSでは実行する。最終結果の1件skipは音声経路の合格や実機器受入には数えない。ブラウザworker数は共有作業ツリーの最新設定の1を使用する。

修正後の全体実行では全12検査stepを通過し、ブラウザ42件合格・1件skipとなった。ただし開始後にnative fixtureの環境検査を加えたため、最後のsource hash一致検査で終了コード1となった。変更後のコードを固定して全体を再実行し、その結果を以下に記す。

| コマンド | 終了コード | 結果 |
| --- | --- | --- |
| `bun run verify:all` | 0 | 全12検査stepと開始・終了のsource hash一致を通過。441.995秒 |
| 利用側10domainの `bun run verify -- --domain <name>` | すべて0 | 下表のAPI/Web試験、整形・lint・型検査・サイズ・domain境界を通過 |

全体検証のsource hashは `019c6a4f6e9c8691f2233fe7bd53ec96ac79348b26710f8b716b7afe4e0d3e24`。保存した機械可読reportは `verification-reports/research-history-final.json`。API1,169件合格・実Local Provider1件skip・0件失敗、Web253件合格、client301件合格、共通UI部品1,086件合格、ブラウザ42件合格・native仮想マイク1件skip。整形・lint・型検査・サイズ・SQL/domain境界・ビルドを含む。合計2,851件合格、2件skipで、liveと実機器の結果は含まない。

個別検証のsource hashはすべて `d3b6174a81d9498fd01330832985587d35e6ca665562792a5d1fa5911ab4e991`。依存閉包を含むため、件数はdomain間で重複する。

| domain | API試験 | Web試験 | 検証全体の時間 |
| --- | ---: | ---: | ---: |
| web-research | 47 | — | 3.23秒 |
| conversation | 16 | 25 | 5.84秒 |
| capabilities | 11 | — | 10.63秒 |
| tool-runtime | 5 | — | 2.21秒 |
| agent-runtime | 41 | 9 | 5.62秒 |
| research-routes | 65 | 8 | 6.74秒 |
| dialogue | 84 | 2 | 13.76秒 |
| voice-dialogue | 37 | 32 | 14.78秒 |
| memory | 2 | — | 2.72秒 |
| world | 180 | 26 | 22.08秒 |

## 追補検証（保存済みLARM接続先の確認後）

参照の取り違えへの訂正案内は `web.find` と `web.read_saved` の両方に適用する。失敗した引数が現在提示しているsourceIdと一致する場合だけ、その資料の発行済みsourceRefを次操作の案として示す。未知のUUID、cursor/startの矛盾、現在許可されていないtoolには訂正案を出さない。自動実行・参照期限の更新・検査の省略は行わない。型・サイズ検査と関連92試験（13ファイル、792 assertions）が通過し、実モデルと全体検証を再実行した。指示の点検は `system-context-engineer` の手順に従い、動的な参照の案内をruntime contextに置き、owner・取消・scope・期限・予算はhost codeで検査している。

新しい回帰試験を追加し、型・lint・サイズ検査とagent-runtime/tool-runtimeの既存試験を確認した。共有作業ツリーの追加試験がcoding-supervision内部serviceへ直接依存していたため、既存のdomain試験fixtureを経由する参照へ修正した。schedulerの関数sizeが既存上限を3行超えたため、待機関数を同じ動作の小さなprivate関数へ抽出した。数値上限・境界規則・試験判定は変更していない。

補助の `bun run deadcode` は終了コード1（未使用export 306件・未使用export type 267件）だった。これは現作業ツリー全体の追加点検結果で、必須のverify:allには含まれない。公開domain契約をまとめて削除する変更は行っていない。

## live

URLを含む複数資料の依頼で、modelが必要項目の引用内のURLを短縮して3回とも拒否された。引用候補はURLを含まない短い原文の節を優先し、原文との完全一致・Unicode境界・件数/文字数の上限を維持した。URLだけの依頼や短い依頼には原文の範囲を使う。最新版の回帰試験は91件合格・0件失敗（13ファイル、789 assertions）。失敗した必要項目を自動承認したり、原文の言換えを引用として認めたりしない。

`EUMENES_LIVE_TOOLCHAIN=1 bun scripts/toolchain-live.ts research-history` を試みた。初回は隔離backendと異なる認証tokenを使う既存scriptの問題で起動確認に失敗した。scriptを専用一時DBと専用tokenの組に修正し、再実行では隔離backendの起動と認証を確認できた。

初回は環境変数だけを見て接続先未設定と誤判定した。ユーザーの指摘後、backendのsettings公開repositoryを読取り専用で確認し、SQLiteに `http://192.168.0.130:9810`（revision 16）が保存されていることを確認した。製品backendは保存済みの `settings.larm.baseUrl` を使用する。隔離受入backendには確認できたURLだけを初期値として渡し、製品DB・設定一式・通常会話を複製していない。実credentialはbackend内に留めた。

実LARM接続は成功し、実モデル・実Webの3ケースを実行した。初回の到達率は0/3。初回needsの不足、参照失効が通常の操作失敗として処理されないこと、モデルの誤った範囲読取り入力を確認した。初回schemaでneedsを必須にし、拒否したfieldだけを本文なしでフィードバックし、無効参照を有限予算内の操作失敗へ統一した。範囲読取りには一致位置の発行済みcursorを使う次の呼出し例と、cursor/startの排他条件を追加した。

現在のSQLite公式HTMLやBunの一部公式資料は既存取得ガードに拒否された。ガードは変更せず、取得可能なSystem.Data.SQLite公式配布内のSQLite資料で中間読取り・候補不一致・検索語変更を試す。公開資料の取得段階で拒否された場合を合格に数えない。再実行では本文取得後の読取りは成功したが、重複する範囲読取りや参照番号の取り違えで終了した。既読範囲を次操作の案内から外し、最終報告用に15秒を予約した（この時点ではworkerの90秒・親の全体期限・モデル/操作回数上限を維持）。

能力選択は発行済みcandidateRefだけをmodel入力schemaで選べるようにし、実行側も同じ候補列で検査する。新しい調査packageでは、指定URLを渡しても既存grant内の検索toolを使用できるようにした。旧revisionやcached direct grantの条件は維持する。本文参照発行前はローカルWeb読取りを提示しない。workerの出力schemaへtool別引数、cursor/startを分けた形、提示済みview/source/excerptの組を反映した。requestQuoteには現在の依頼からの短い原文候補を提示する（最大6候補・合計600 UTF-16 code units、1候補300以下）。hostの原文一致・owner・版・取消検査は維持した。

追加した拒否diagnosticにはfield名と固定codeだけを含め、本文・拒否されたquote・UUIDの値は含めない。cursor/start競合は `arguments.start / omit_start_with_cursor` として、同じ2回の修復予算で修正できる。URL指定の受入がmetadata転記漏れで範囲外になる問題も確認した。Web能力の質問と指定URLは現在の依頼原文から確定し、URLを最大3件まで渡す。modelが書き換えた質問・URLは取得権限にせず、未読の指定URLの読取り例を提示する。型・候補参照・実際の取得先のscope検査は維持し、未知のURLを勝手に取得しない。履歴能力へURLを追加しない。合成試験で、modelが架空のURLを選択metadataへ入れても、元の指定URLだけがworkerへ渡り、その後の取得は指定URLと検索で発行された候補だけに限られることを検証した。

実測では、本体取得・find・read_savedの3操作が通っても、version 2報告の生成が従来の1回30秒の制限を超えるケースがあった。新revisionだけworkerを最大150秒、model stepを最大45秒とし、親に30秒を残す。次操作の提示は残り60秒以下で止め、最終報告用の時間を残す。親runの既存180秒・外部5/ローカル4/モデル12（履歴7）・修復2の上限は維持。旧revisionはworker90秒・model step30秒・親余裕15秒を維持し、取消済み・期限切れタスクの期限は延ばさない。短い親期限ではそれに合わせてworker期限を縮め、作成時に期限を過ぎていれば拒否する。回帰試験は90件合格・0件失敗（13ファイル）。隔離受入DBの参照metadataだけを照合し、本文内検索失敗が、modelのsourceId/sourceRef取り違えであることを確認した（本文・model生応答・検索語は出力しない）。失敗したfindの引数が現在提示したsourceIdと一致するときだけ、対応する発行済みsourceRefで明示的な再試行例を返す。引数を自動置換して実行せず、任意の未知参照は補正しない。修正後の実モデル結果と最新の全体検証を以下へ追記する。

| ケース | 実モデル結果 | 到達率・回数・終了理由 |
| --- | --- | --- |
| 長い公開資料の中間読取り | 未実施 | 未測定 |
| 初回候補の不一致から別資料 | 未実施 | 未測定 |
| 不足を反映した検索語変更 | 未実施 | 未測定 |

この3ケースはfixtureの成功から合格と推定しない。保存済み接続先を用いた専用実行経路で `scenarioExercised` と到達を検査し、取得・ローカル操作・モデル回数・coverage・失敗コードを `verification-reports/toolchain/research-history-live.json` に記録する。通常ログには本文・検索語・Provider生応答・秘密を追加していない。

## 実機器と残件

実マイク・ヘッドホン3往復と割込みは未実施。音声MVP完成の宣言はしない。fixtureで、履歴が失効した回答を完成テキスト・音声へ採用しないことを確認した。

P6の残件は実モデル3ケースの受入と、音声機器を使う受入結果の記録。実装済みの機能、固定応答で確認済みの結果、live・実機器の未確認を区別する。

## 作業用MCP

`initial_instructions`、`context_compile`、`compile_eval` を各1回実行した。別Codexチャットへメッセージを送信していない。
