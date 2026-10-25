# OCR・物体認識の詳細分析の確認

2026-10-25 JST。利用者の設計合意と「実装開始」「最後までやりきって」に基づく実装。新しいツールチェーンID・専門エージェント・Artifact種別は追加せず、両画面のサブシステムとして実装した。

## 実装した接続

既存の画面ボタン → 版付きlocal action → 既存Web adapter → 認証済み分析API → 各domainの保存・共通queue → LARMのcatalog/connection/claim → 同期JSON推論 → 検証・保存 → 正規化画像と検出枠・マスク・説明の表示、という経路。

| 登録 | 内容 |
| --- | --- |
| `ocr.visual-analysis.bundle.json` | `artifact:ocr.workspace@6`、`binding:ocr.command@6`、既存IDの`toolchain:ocr.manage@6`。package/profile/skill/toolを増やさず既存版を参照 |
| `object-recognition-screen.visual-analysis.bundle.json` | `artifact:object-recognition.workspace@3`。既存の単独画面を改訂。toolchain定義は0件 |
| LARM | capability `vision.perception`、protocol `larm.visual-perception.v1`、apiStyle `larm-visual-perception`を検査。Profile・モデル・endpointは実行時に取得 |
| 保存・実行 | 各domainの`0004-analyses` migration。所有者・会話・元資料版/digest・設定version、受付UUID、別結果・状態・解放確認。共通queue resource/concurrency `vision.perception`、maxAttempts 1 |

既存のLLM・音声接続の責務は変更していない。試用機構のcatalog・Agent Connectionの処理を共有し、新しい外部JSON契約とマスク検証を追加した。画像正規化・動画フレーム抽出はOCR補正からinfrastructureへ切り出して両domainで利用する。分析のAPI/SQL・業務試験は各domainに置き、下位domainから上位を参照しない。

## 固定試験

| 段階 | 結果 |
| --- | --- |
| 変更前のOCR/物体認識 | 20成功、0失敗 |
| 外部JSON・接続の追加試験 | 22成功、0失敗。8task、Provider credential、pending→ready→claim、HTTP 400/401/409/413/429/503/504、取消・遅い接続応答、同じIdempotency-Keyでの接続回収、解放失敗、host境界、8マスクを含む7 MiB超の正常応答 |
| 各domainの分析試験 | 合計10成功。保存・再表示、画像/マスクAPI、原文版不変、所有者/会話/版、受付再送と競合、取消・削除・設定変更後の遅い結果の不採用、再起動時の既知接続回収 |
| アプリケーション結合 | 5ファイルで7成功。両domainの直列実行、認証済みAPI、旧版からの新しい画面版登録・再seed、従来OCR API・adapter |
| Web hook・既存runtime | 3ファイル18成功。明示操作だけで推論、保存済み受付の利用、通信断のreceipt照会（POST再送なし）、古い対象の拒否 |
| 詳細分析・物体認識の部品 | 2ファイル16成功。自由文と用途、文字列の安全描画、同じlabel複数時のmask index、枠のviewBox、truncated、状態、取消、二重実行抑制 |
| 対象domain gate | `bun run verify -- --domain larm --domain ocr --domain object-recognition`成功。境界・SystemContext・サイズ・整形・lint・DesignSystemの型/build・利用側の型検査、backend 365、Web 22、既存OCR部品10成功。[固定したreport](domain-verification.json) |
| 全体型検査 | 2,656ファイル成功。DesignSystemの型検査も別途528ファイル成功 |

対象domain gateのrunIdは`2026-10-25T11-21-51-470Z-c4f1332e-5f7c-4acd-973a-2b00c36b7970`。検証中に対象入力は編集していない。既存の全体`verify:all`・一時サーバーを起動するブラウザfixtureは実行していない。

## 実LARM・実API

保存済みsettingsのControl接続とbackendの既存credentialを利用した。接続先・Profile名・モデル名を再設定せず、公開selectorとaudienceを取得して確認した。検証用画像はリポジトリに既存のバス画像。確認用に保存したOCR/物体認識の資料2件と結果は、利用者がそのまま画面で確認できるよう保持した。

| 実行 | 結果 | Eumenes全体時間 |
| --- | --- | --- |
| OCR画面側API・画像説明 | 完了、説明文あり、detections空、解放確認true | 約24.5秒 |
| 物体認識側API・対象検索 | 完了、検出1件、解放確認true | 約53.5秒 |
| 物体認識側API・segmentation | 完了、検出1件・対応マスク1枚、解放確認true | 約33.2秒 |
| 稼働画面の「分析する」・画像説明 | 起動中→解析中→完了、説明と画像を表示、解放確認true | 約36.0秒 |

[API結果](live-api.json)、[画面からの実行結果](ui-run.json)には、workerの時間とEumenes待ち時間を分けて保存した。モデルの応答文字列をHTMLや命令として扱わず、そのままの観測として保持する。実応答の特殊トークンから座標を作らない。PNG原本・maskの取得と、実画面上の対応も確認した。

## 取消・放置・再取得と失敗した試行

- 無推論の接続をclaimして観測し、約60.4秒後に公開Connection APIで`released`を確認した。観測区間の推論は0件。自分の接続だけを最後にDELETEした。
- 実接続をclaimした後、推論の送信前に取消し、独立したDELETEで解放が成功した。
- 直後の再取得試行はready待ちの120秒上限で終了した。推論開始前で、推論POSTは再送していない。この失敗を成功に含めない。その後、稼働画面で利用者操作と同じ「分析する」を明示実行した試行は約36秒で完了し、新しい接続の解放も確認した。
- 最初のAPI試行中には利用者によるEumenes再起動があり、対象の記録は`analysis_interrupted`・releaseConfirmed trueになった。既存受付を確認してから別試行として続けた。[中断した試行](live-api-interrupted.json)を最終成功の記録と分離した。
- HTTP各種・入力不正・推論中取消・削除後の遅い結果・解放失敗は固定試験で確認した。実LARMへの意図的な推論障害や上流の強制停止は行っていない。

[ライフサイクル記録](live-lifecycle.json)に無通信解放・取消と、その後の画面からの再取得を残す。実機器やLARMプロセスを直接停止・再起動していない。

## 実画面

利用者が再起動した既存のEumenesサーバーと既存Webを使用した。こちらで検証用・本番いずれのサーバーも起動・停止・再起動していない。

- ランチャーに既存の入口が各1件あり、新しいOCR画面版6・物体認識画面版3をAPIと実画面で確認。
- OCRの「詳細分析」で保存した説明・履歴を表示。再表示では推論しない。
- 物体認識の「詳細分析」で保存したsegmentationを表示。マスクのオン/オフ、検出枠、結果履歴の選択を確認。
- 自由文を変更して「分析する」を押し、起動中・解析中・完了と新しい説明を確認。
- 広い表示と狭い表示で、正規化画像に対する枠・maskが対応することを目視確認。

証拠: [マスクあり](mask-on.png)、[マスクなし](mask-off.png)、[画面からの解析完了](ui-run-completed.png)、[狭い画面のmask](mask-narrow.png)。スクリーンショットには同じローカル画面の会話欄も含まれる。

## 範囲外・未確認

通常のOCR実接続はこの確認用画像でも成功した。通常YOLOの上流は、確認用原本の受付が`recognition_submission_unconfirmed`となった。保存した原本から詳細分析は成功する。通常YOLOのgatewayや設定は今回の修正対象外のため変更せず、固定回帰試験の成功と通常YOLOのlive未確認を区別する。

LARMのモデルプロセス停止の追加観測に使おうとした`GET /v1/inspection/runtimes`は、既存credentialに対してHTTP403だった。Connectionの自動解放とDELETE成功は確認したが、Eumenesからのモデルプロセス停止の独立観測は未確認。権限の変更やworker/systemdへの直接接続は行っていない。LARM側の起動・停止検証は利用者提供の配備受入と区別する。

一時サーバーの起動を許可しないという利用者指定により、既存の`tests/browser/ocr.spec.ts`・`tests/browser/object-recognition.spec.ts`は未実行。稼働ブラウザでの上記手動操作、部品、hook、インプロセスHTTP結合で確認した。動画の実フレームによる詳細分析は今回live未実施（既存の抽出処理・時刻検査を再利用）。実カメラの受入は含めない。

アプリケーション層を含む補助的なサイズ点検では、着手前からの超過（serverの組立て・lifecycle、既存の物体認識画面、共通試験harness）があった。今回の新しいdomain処理は分割して300行以内に収め、対象domainのサイズgateは成功した。既存の超過を解消する全体リファクタリングや閾値の緩和は行っていない。

## 最終差分点検

実装で増えた分岐は外部契約のtask・MIME・座標・マスク・状態と権限・容量の検査、利用者が明示選択した画面操作である。対象名・発話の語句に対応する辞書や分類、モデル名・Profile名の固定、独自confidence、推論の自動再送は追加していない。既存原文・YOLOの結果・補正案・会話の経路を上書きしない。並行作業による対話・音声・monitoring・Docling等の無関係な差分は変更対象から外し、取り消していない。
