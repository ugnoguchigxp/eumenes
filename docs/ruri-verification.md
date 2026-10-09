# Ruri互換・収集機能の検証記録

2026年10月9日。対象はEumenes側の互換対応、実会話300判定の収集、CLI/APIによる人手レビュー、JSONL出力。LARMの設定変更、追加学習、本番モデルの適用は行っていない。

## 実装と反映

Gemmaの接続をdiscovery/claimから再取得し、稼働中のbackendでもprofile=SAAA-gemma4-26b、decisionModel=ruri-v3-30m-speaking-attitudeを確認した。Laya互換入力・保存済みsourceも維持した。新コードを開発サーバーへ反映済み。

通常ログとは別の`data/attitude-dataset/dataset.sqlite3`へ保存する。開始・停止・件数・レビュー・分割・exportは認証付きAPIから行う。稼働サーバーで開始→停止と空データのexportを確認した。最終確認時点は停止中、成功0/300、未レビュー0、確認済み0、保留0、スキップ0、保存エラー0。fixture・接続用の合成例を実会話件数に加えていない。

採用情報は元の判定・選択と分離している。表情はreceipt採用を確認して記録し、toneはTTS receipt未採用ならnull。自動preset・通常基準・手動・未計測を区別する。手動音声をRuriの声色の適用済みとして扱わない。実再生時刻は取得しておらず、tts_start_delay_msはnull。

## Fixture

変更前のdelivery/larmは54件成功。変更後は関連domainの検証とverify:allを実行。全体結果は`verification-reports/ruri-verify-all.log`、domain結果は`verification-reports/ruri-verify-<domain>.log`に保存した。最終のverify:allはbackend 265件・Web 65件・ブラウザ14件が成功し、型・境界・書式・lint・ビルド・最終入力hashの検査も通過した。delivery、larm、inference、attitude-dataset、conversation、dialogue、voice-dialogue、avatarのdomain検証も成功した。

確認した条件:

- claimされたRuriのmodel/token、current_chunk優先、response互換、conversationを送らないこと、6ラベル外・none欠落の質問拒否。
- Ruriのsource・校正状態、0.6境界、候補外棄却、全6スコアの保持、トップレベルと旧usage両方の切詰め拒否。
- 収集オフ、重複、300成功件で停止、未レビュー正解欄null、予測を隠す表示、secret風の文字列除外。
- not-expressiveの追加判定は1回かつ非同期。テキストだけの初期接続でもバックグラウンドでSystem Oneを準備。回答・TTSは追加判定を待たない。
- 失敗、timeout、停止・取消・再起動、遅着、probe/benchmark対象外、採用確認、手動音声の記録。
- 人手訂正でも元予測を保持、保留・不完全レビュー・同時編集、確認済みのみ出力、未分割の出力拒否、追加収集後の分割無効化。
- 会話・テンプレート・未レビューの連結例を分断しないグループ分割、JSON SchemaとJSONLのフィールド、API入力とno-store。
- Ruriの名前横表示、既存の会話・音声・アバター経路、全体の型・境界・書式・lint・Web build・ブラウザfixture。

一度、domain検証の実行中に空exportのschema/report JSONを作成したため、検証対象ファイルのhash変化で終了した。該当検証は再実行した。途中の失敗を最終合格として扱っていない。最終版でもアバターの初期canvasを5秒待つブラウザ試験に一度失敗したが、ソースを変えずにverify:allを再実行し、全工程が成功した。失敗時のログは`verification-reports/ruri-verify-all-avatar-timeout.log`に保存している。

## 実接続（合成テキストによる互換確認）

`verification-reports/ruri-live.json`と再実行用の`verification-reports/ruri-live.ts`に記録。現行Ruriの推論意味や実会話の正解率を評価したものではない。

| 確認 | 結果 |
| --- | --- |
| 技術説明 | none、6クラス、input_mode=A |
| 祝福 | joy、6クラス |
| 挨拶 | warmth、6クラス |
| 祝福・挨拶の候補をnoneだけに制限 | API none、answer_confidence=0、全6スコアは変わらず |
| delivery→TTS | source=ruri、joy/joyful/bright、音声87,084 bytesを取得 |
| Encoder revision | 24899e5de370b56d179604a007c0d727bf144504 |
| head revision | synthetic-v1-c100-A-9d382201d67e |
| calibration revision | synthetic-v1-A-e768c18981af |
| 校正状態 | synthetic-provisional |
| 実行 | CPUExecutionProvider、dynamic-int8-encoder-fp32-head |
| 推論時間 | この3例でモデル内3.1〜5.1ms、Eumenes往復11.3〜16.3ms。接続準備を含まない |

マイク・スピーカー・ヘッドホンを使った3往復受入は未実施。音声MVP全体の完成とは宣言しない。実会話300件の収集・人手ラベル付け・クラスバランスの評価もこれからであり、現時点で全クラス・全場面が不足している。

[収集・レビュー手順とJSONL仕様](ruri-collection.md)を参照。空exportの`data/ruri-export-final-20261009/schema.json`に完全なフィールド一覧、同フォルダのreport.jsonに0件時点の不足一覧を保存した。実会話の受け渡し時は新しい出力先へexportする。

実行中APIで未認証401・別Origin 403を確認し、現在の開発サーバー出力に既知のAPI/LARM認証値が含まれないことも確認した。Context Stillはcontext_compile 1回、compile_eval 1回（各runに評価を保存）。

## 引継ぎ後の補強と再確認

同日、既存実装を改めて確認し、次を補強した。関連するdelivery・attitude-datasetのfixtureは計26件成功、両domainの書式・lint・型・境界検査も成功した。inferenceのdomain検証も成功している。LARMのdomain検証も47件成功し、書式・lint・型・境界検査が通過した。

- トップレベルと旧usageの切詰め情報が食い違う場合も、切詰めあり・最大の欠落数を記録する。
- 不完全な6クラスのスコア・logitでもRuriのmodelを保持し、Layaへの誤帰属を防ぐ。スコア合計が1から外れる応答は正規化せず不正応答として扱う。
- chunk収集契約の現在テキストにcontext内の回答全文を混ぜない。
- レビューの修正理由・テンプレートIDに認証文字列が含まれた場合、保存を拒否する。

Gemmaのclaimを再取得し、稼働APIのmodelがRuriであることを再確認した。実接続probeの再試行は成功し、6クラス、候補外のnone/confidence=0、スコア保持、Ruri由来の演出、TTS合成87,084 bytesを確認した。この3例のモデル内推論は3.03〜5.37ms、Eumenes往復13.96〜19.52ms。実会話精度やP50/P95の評価ではない。途中に1回のタイムアウトがあり、成功とは別に記録した。結果は`verification-reports/ruri-handoff-live-retry.json`、稼働APIの状態は`verification-reports/ruri-handoff-api.json`。

現在の収集は停止中、成功0/300・未レビュー0・確認済み0・保留0・スキップ0。追加補強はソースの検証と新しいプロセスでの実接続を確認したものであり、既に起動しているbackendへ反映する際は再起動が必要。

全体検証は初回・再実行ともbackend 280件・Web 74件が成功し、ブラウザは13件成功・1件失敗。失敗は設定へ移った後のアバターcanvas解除待機で、再実行時の表示状態は`#settings / inactive / hidden=true`だったがcanvasが残った。収集機能の試験失敗ではないが、今回のverify:allを合格とは扱わない。ログは`verification-reports/ruri-handoff-verify-all.log`と`verification-reports/ruri-handoff-verify-all-retry.log`に保存した。確認中にアバター表示・ブラウザ試験へ別の作業変更が入っており、その変更は上書きしていない。

## コードレビュー後の修正

収集・レビュー・export・Ruri応答の整合性を再レビューし、次を修正した。

- 独立した確認済み群が3つ以上ある場合、train/calibration/evalに最低1群ずつ確保する。従来の二乗誤差だけの配分では、100件ずつの3群を200/100/0へ配分し、evalが空になっていた。グループを分けず100/100/100にするfixtureを追加した。
- coverage_tagsの重複を拒否し、同じ例で場面別件数が増えないようにした。
- Ruriのlogit首位、スコア首位、API返却ラベル、answer_confidenceの整合性を検査する。正規の候補外none/0は維持し、矛盾した応答は演出や成功収集に使わず元のベクトルを確認用に保持する。0.6の採用条件は維持した。
- CLI exportは新しいディレクトリを先に確保する。既存のschema等にぶつかる前に一部ファイルだけ生成する不整合を防ぎ、既存内容が変わらないことをCLI/APIのfixtureで確認した。
- 専用SQLiteの本体を600にしてから開くことでWAL/SHMにも600を引き継ぐ。既存の補助ファイルも600に修正する。公開権限の親ディレクトリと既存の644ファイルから開くfixtureで本体・WAL・SHMを検査した。
- アバターcanvasをGPU資源の解放前に画面から外す。画面遷移の解除fixtureは、同時進行で更新されたSwiftShaderの待機時間を含む試験で通過した。元の短い待機時間では失敗しており、この変更だけで解決したとは扱わない。

対象fixtureは31件成功。delivery、attitude-dataset、inference、avatarのdomain検証が成功した。Ruri実接続・候補外棄却・TTS合成も成功し、`verification-reports/ruri-review-live.json`に記録した。実会話収集は実施していない。全体検証は一度全工程を通過し（`verification-reports/ruri-review-verify-all.log`）、権限補強後の最終結果を`verification-reports/ruri-review-verify-all-final.log`に保存する。

権限補強後の最初の全体実行は、同時進行で追加されたAudioWorklet fixtureの発話開始条件で失敗した。そのfixtureが更新された後の再実行ではbackend 285件・Web 76件・ブラウザ14件が成功したが、検証中のソース変更を最後のhash検査が検出して終了した（`verification-reports/ruri-review-verify-all-final-retry.log`）。途中の成功を最終合格として扱わず、現在のソースを`verification-reports/ruri-review-verify-all-stable.log`で再検証する。

最後の全体実行（`verification-reports/ruri-review-verify-all-final-ready.log`）はbackend 292件・Web 76件・ブラウザ14件が成功し、書式・lint・型・境界・buildも通過した。ただし同時進行の変更を最終入力hash検査が検出して終了したため、verify:all全体を最終合格とは記録しない。途中の関数移動・SQLite checksum初期化の変更にも一時的な不整合があり、現在は解消している。収集・deliveryのdomain検証を最後に再実行し、各入力hash検査を含めて通過した。対象範囲の再レビューでは新たな要修正の指摘はない。収集は停止中0/300件、確認済み0件のまま。
