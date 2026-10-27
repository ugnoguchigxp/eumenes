# Codex SDK移行と調査失敗の原因説明

2026-10-11。対象はLunaの推論アダプター、安全な障害記録、調査結果を会話モデルへ渡す共通コンテキスト。音楽など別作業の差分は変更していない。

現行実装は末尾の「LunaのJSONを最小化」を参照。Lunaへはinvoke/finishの2例と項目の説明を渡し、SDKのnative outputSchemaは使用しない。前段の実装・検証記録は変更前の経緯として残す。

## 元の障害の時系列（日本時間）

runId: `131bfb3b-b632-48eb-994c-5e59e1c2843e`。

| 時刻 | 記録で確認した事象 | 判定 |
| --- | --- | --- |
| 21:03:20.321 | 「今日のAIニュースを教えて。」を受付 | 正常 |
| 21:03:31.920 | 会話モデルがLunaのWeb調査を選択 | 正常 |
| 21:03:41.119 | 旧CLIアダプターが9.172秒で `codex_research_failed` | JSON解釈に進む前の実行失敗。検索・読取りは0件 |
| 21:03:52.263 | 会話モデルが「制御JSON不正」と説明して保存 | 記録が裏付けない原因の説明 |
| 21:04:02.529 | 音声生成が終了 | 会話の完了は調査成功を意味しない |

当時の標準エラーは捨てられていたため、旧実行の接続・認証・プロセス終了などの詳細原因は復元できない。「JSON形式不正」が原因だったとは確認できない。

## 実装

- `@openai/codex-sdk@0.160.0` の `startThread` / `runStreamed` / `outputSchema` を使用。従来の独自JSONL解析を削除。既存のinvoke/finish契約とホスト側の検証を再利用した。
- 正常なturn完了とイベント列の正常終了を確認して最終候補を採用。未完了、二重完了、終了失敗、取消、容量超過では採用しない。
- 失敗は処理段階、HTTP状態、終了コード、許可したシグナル・Providerコードに分類する。推論・試行・ジョブのIDで追跡できる。生応答、会話本文、認証情報を通常ログへ保存しない。
- 現在の失敗を `CURRENT_RESEARCH_FAILURE` として先頭system指示に渡す。過去の障害説明より今回の実行状態を優先し、記録以上の原因を推測しない。取得資料・報告は未信頼のuserデータのまま保持する。
- Lunaには元の依頼とtask.questionを渡し、調査・次の操作の選択・根拠と制約を含む終了報告という役割を明示する。利用者の語句を判定する分岐や固定の最終回答は追加していない。

SDK内部はCLIランタイムを使う。[公式仕様](https://developers.openai.com/codex/sdk)に従う。採用版SDKにephemeral、ユーザー設定・exec規則の無視、process groupの強制終了APIがないため、その隔離・容量上限・取消だけを小さな起動補助で強制した。SDK自身がJSONL解析・モデル呼出し・turnイベントを扱う。これは外部仕様と実行制約に限った実装で、調査の意味判断はLLMが担当する。終了を拒む子・孫を残さない回帰試験で必要性を確認した。

## 検証

### fixture（外部接続なし）

- 関連部分・結合テスト: 98成功、0失敗（11ファイル）。SDK出力、取消、採用制約、会話への状態受渡し、ログの相関を確認。
- 最終SDKアダプター・障害結合テスト: 11成功、0失敗。シグナル異常終了も確認。
- 最終会話コンテキスト・障害結合テスト: 6成功、0失敗。
- domain検証: inference成功、dialogue成功、agent-runtime成功（backend57件、web9件）。
- 全体検証: 不通過。最初の全体実行は追加liveで判明した会話コンテキストの不十分さを修正するため中止し、最終差分で実行し直した。形式・lint・型・domain境界・SQL境界・ビルドは成功。backend 1,490成功・1省略・0失敗、web 299成功、client 329成功、design-system 1,097成功。ブラウザは43成功・1省略・1失敗。

ブラウザの失敗は `tests/browser/timers.spec.ts:424` の通知drawerの `scrollIntoViewIfNeeded` で、`Element is not attached to the DOM`。本変更の担当外なので調査と記録に留め、UI・テスト期待値は修正していない。原因が音楽UI変更などであるとは確認していない。検証中には別作業の音楽UI差分が増えており、全体ゲート末尾のsource一致確認はブラウザ失敗のため未到達。全体検証成功とは報告しない。

認証エラー結合試験ではSDKを実際に通し、疑似ランタイムがHTTP 401・終了コード7を返す。`inference.attempt_failed` に `phase=sdk_turn/status=401/exitCode=7/reason=codex_research_http_401` が残ること、検索が0件であること、秘密を含む生メッセージが残らないことを確認した。会話モデルのstubを使う結合試験と、以下の実モデル確認は区別する。

### live（保存済みLARM設定・実Codex接続）

| 確認 | 結果 |
| --- | --- |
| SDK接続・小さな構造化終了判断 | 12.438秒で正常終了。`{"action":"finish"}` を採用 |
| Lunaの実Web調査を通す確認 | 1回実行。最初のモデル呼出しが既存45秒制限で `deadline_exceeded`。検索0件・報告なし。ニュース取得の通し成功は未確認 |
| 初稿: 過去の誤説明と後続system通知 | 実モデルが再び「キーワード未指定」と誤説明。部分試験の成功だけで完成扱いにせず修正した |
| 修正案: 現在の失敗を先頭systemに集約 | 過去の原因を流用せず、今回の調査失敗を説明 |
| 最終実装: 原因不明 + 過去の「JSON不正・キーワード不足」 | 「調査モデルの処理で失敗したため、ニュースを報告できませんでした。」と説明。過去の原因を流用しない |
| 最終実装: HTTP401 + 同じ誤説明履歴 | 調査失敗・情報不足を説明。JSON不正・キーワード不足を原因にしない。自然文では401の詳細を省略した |

通しrunIdは `0bcf2983-80b5-48da-8392-7d3417fe8ff3`、workerは `f7b219be-94be-441c-a8b5-a0843b15da66`、jobIdは `50cd30ef-9421-43c0-b814-4c26d3374404`、inferenceIdは `58be186b-4131-474a-8d51-81d3f25f7165`。21:21:10.701受付、21:21:14.656 SDK開始、21:21:59.647 deadline失敗、21:22:04.348回答完了。生のProvider応答は記録していない。

live証拠は `verification-reports/search-agents/2026-10-11T12-21-06.093Z/` と `verification-reports/codex-sdk/2026-10-11/`（通常ログとは別の検証成果物、0600。いずれもローカルの検証記録でリポジトリには含めない）。録画・実機器の音声受入はこの変更の対象外。

## 残る制約

ニュース取得全体は45秒のモデル応答期限で止まり、今回の変更で取得成功まで確認したとはいえない。期限は緩めていない。過去の失敗の詳細原因は元記録がないため不明。失敗説明はLLMによるため全発話での保証ではなく、今回の過去履歴を含む実モデル回帰例で確認した。

開発backendはwatch起動ではないため、APIで実行中・待機中ジョブが0件であることを確認して開発サーバーを再起動した。再起動後の `/api/status` は200・service=eumenes、Webも200を確認。新実装を反映済み。

Context Still: この実装作業ではcontext_compile 1回、compile_eval 1回。

## 追補: Lunaへ渡すJSON定義の修正

利用者の指摘を受け、SystemContextのOUTPUT_SCHEMAがactionを直接返す定義で、SDKのoutputSchemaだけがdecisionラッパーを要求していた不一致を確認した。固定指示とschemaを値で分離し、SDKに送る完全な定義をSystemContextにも一度だけ埋め込むようにした。

さらに21:42の実接続で `HTTP 400 / invalid_json_schema / phase=sdk_turn` を確認した（runId `592b4f60-3fdc-4eb7-8e5c-0bae6e0fb7a3`）。元のinvoke契約のargumentsは任意JSONを示す空schemaであり、strict形式で必要な定義が欠けていた。登録済みのtool idとinputSchemaを値で渡し、invokeをツールごとの型付きの枝にする。optionalはstrict形式に必要なnullable/required表現に変換し、省略可能かつ非nullableな入力のnullだけを元の省略へ戻す。SDK非対応の制約はwire表現から除き、ホストの完全な検証を維持する。検索語やニュースの選択をコードに実装していない。

最終の定義変換での部分・結合試験は33件成功。実接続はrunId `df3d0e53-9b60-4526-8c7c-8013b8b49e2b`、証拠は `verification-reports/search-agents/2026-10-11T12-46-22.792Z/`（ローカルの検証記録。リポジトリには含めない）。

| 日本時間 | 結果 |
| --- | --- |
| 21:46:22以降 | 会話モデルがLunaを選択 |
| 21:46:39以降 | 有効なinvokeを受理、Web検索を実行 |
| 21:46:41.312 | 検索5件を取得 |
| 21:46:53以降 | 有効なfinishを受理、報告version 2を採用 |
| 21:46:57.970 | 親の回答が完了。計34.729秒 |

2モデル呼出し・1検索・JSON修正0回・構造違反0件・worker completed。報告はnot_found（具体的な発表内容・日付の根拠不足）でclaimsは0件。定義の送信・応答受理・検索・終了報告の接続は通過したが、ニュースと引用が揃う検索ケースの判定は不合格。根拠不足の報告をニュース取得成功として扱わない。元の21:03の詳細原因が同じだったとは当時のログから確定できない。

現在のレンダラーが生成する代表的な初回検索定義を `luna-output-schema.json` と `luna-definition.txt` に保存した。実際のツール一覧はstepで変わるため、これらは説明用の生成例であり、過去のProvider応答や製品会話のコピーではない。

元の作業コピーではinferenceの45件、agent-runtimeの57件/backendと9件/webが成功したが、同時作業でソースが変わり、末尾の一致ゲートが失敗した。今回の所有差分だけをHEADに適用した隔離worktreeでdomain・全体検証を実行中。DB・保存済み設定・認証情報はコピーしていない。

この追補作業のContext Still: context_compile 1回、compile_eval 1回。

追補の最終結果: 隔離worktreeのinference（46件）・agent-runtime（57件/backend、9件/web）検証が一致ゲートまで成功。全体検証も537.328秒で成功し、backend 1,476件、web 293件、client 329件、design-system 1,095件、ブラウザ44件が成功した。fixtureの省略はbackend 1件・ブラウザ1件（実Provider・実マイクの任意lane）で、今回の実Codex接続は別途上記の通り実施。記録はschema-isolated-verify-all.json。隔離対象はHEAD + このSDK/会話/JSON定義の所有差分であり、他の同時作業の音楽UI差分は含まない。初回の隔離全体検証は既存scripts/dots-mvpの依存未導入で型検査が止まったため、保存済みmanifest/lock通りに依存を導入してから再検証した。製品コードの修正や検査条件の緩和で通したものではない。

定義修正後に、開発APIの待機・実行中ジョブ0件を確認してサーバーを再起動。API /api/status とWebの200を確認して反映済み。最終差分は引数契約・外部API用の表現変換・指示と定義の一致に限り、利用者の語句による分岐や検索内容の決め打ちは追加していない。検証用worktreeは記録保全後にアーカイブする。


## 追補: LunaのJSONを最小化

目的はLuna向けの輸送上の構造を撤去し、既存の操作・報告契約へ直接接続すること。DB・公開API・権限・取得予算・報告の根拠条件は変更しない。部分・結合→実接続→domain・全体検証で、直接のinvoke/finish、失敗分類、修正一回上限、未取得の根拠拒否、元の会話への結果引渡しを確認する。

- `decision`の包みとSDK strict schemaの変換ファイルを削除。ツールごとの枝・任意入力のnull強制・null復元・TOOLSの二重保持も撤去した。
- Web調査契約のmetadataにinvoke/finishの2例を置き、SystemContextへ `OUTPUT_FORMAT` として渡す。出力例は190文字で、終了報告はoutcome・summary・claims・limitationsの4項目。根拠はe1などの参照で示す。argumentsの定義はTOOLSに一度だけ含め、任意項目は省略する。
- Codex SDKは引き続きモデル・イベント・turn完了を担当する。native outputSchemaを使用せず、正常終了した最終応答を共通JSON補正と元の完全なホスト契約・権限・根拠検証へ渡す。不正応答は既存の修正一回上限で扱う。別作業の共通JSON補正は変更せず再利用した。
- 代表的な定義は `luna-output-format.json` と `luna-definition.txt`。以前の約300行のSDK用schema生成例は撤去した。
- 調査判断・語句判定・検索内容の固定処理は追加していない。今回のschema簡素化だけから21:03の失敗原因を断定しない。

部分試験は43成功、結合試験は62成功、失敗0。疑似ランタイムを実SDKに接続した試験では、HTTP401・終了コード7のログ、過去の誤説明からの分離、余分な項目をホストへ残して検証すること、取消・異常終了時の候補不採用を確認した。

最初のlive（runId `5dc533a9-da14-4deb-99e4-1994e56cb227`）は、確認用スクリプトがTOOLSの終端を旧OUTPUT_SCHEMAに依存していたため22:11:29にSDK実行前で失敗した。errorFramesが `scripts/search-agents-live.ts:88` を示し、Lunaの出力障害ではない。TOOLSの一行だけを読むように確認用スクリプトと同じ形式のfixture読取りを修正してから再実行した。試験期待値は変えていない。

最終live: runId `1c78a7a3-1551-4ca2-87db-88ab349ada68`、証拠 `verification-reports/search-agents/2026-10-11T13-12-24.593Z/`（ローカルの検証記録。リポジトリには含めない）。

| 日本時間 | 状態 |
| --- | --- |
| 22:12:25.055 | 依頼受付 |
| 22:12:27.608 | Lunaに最小の定義と最初のツールを提示 |
| 22:12:39.606 | root action=invokeを受理、Web検索へ |
| 22:12:41.153 | 検索結果をLunaに提示 |
| 22:12:52.668 | root action=finishを受理、partial・根拠付き3件 |
| 22:13:00.556 | 親の回答完了（35.513秒） |

2モデル呼出し・1検索・JSON修正0・契約違反0。Luna検索ケースの判定は全項目成功。内容は検索抜粋に基づく候補3件で、本文未確認をlimitationsに保持した。ニュースの出来事の原文確認まで完了したとは扱わない。

隔離worktreeは前回のSDK変更に今回の所有差分を反映し、変更していない共通JSON補正・利用側fixtureを検証依存として含めた。他の音楽UI・World等の作業、製品DB・保存済み設定・秘密はコピーしていない。domain検証はinference・agent-runtimeとも成功。全体検証の結果とbackendへの反映は確認後に追記する。

簡素化後の開発backendを22:14に起動し、API `/api/status` 200・service=eumenes、queue openJobs=0、Web 200を確認して反映済み。今回のContext Stillはcontext_compile 1回・compile_eval 1回。


簡素化の最終検証: 隔離worktreeでinference 45件、agent-runtime 60件/backend・9件/web、全体検証がすべて成功した。全体はbackend 1,504件成功・1件省略、web 293件成功、client 329件成功、design-system 1,095件成功、ブラウザ44件成功・1件省略。省略は実Provider・実マイクの任意laneであり、実Codex接続は上記の別liveで確認した。結果は `minimal-isolated-inference.json` / `minimal-isolated-agent-runtime.json` / `minimal-isolated-all.json`。検証後に所有コードと共通JSON処理の17ファイルの一致を再確認し、変化は0件。差分の全体点検・空白検査も成功。別作業の音楽UI等を含む作業フォルダ全体の検証成功とは混同しない。

最終状態: 最小JSONの実装・部分/結合/domain/全体の固定試験・Lunaの検索から根拠付きpartial報告までの実接続・開発backend反映は完了。元の21:03の詳細原因と、検索候補の記事本文における出来事の確認は未確定のまま保持する。検証用worktreeは記録を保全してアーカイブする。
