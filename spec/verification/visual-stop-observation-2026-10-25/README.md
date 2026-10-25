# 詳細分析の停止確認・接続待機 受入記録

2026年10月25日。利用者提供のLARM修正commit `ae62948340e2e0959bbbae9eca362dba7a060626`の本番反映後に確認した。LARM側の4回連続成功と、本記録のEumenes側受入は別の試験である。以前の取消直後の停滞は旧instance停止との競合であり、資源待ちやEumenesの待機条件を原因とは扱わない。

## 実装

既存のOCR・物体認識の詳細分析、LARM接続取得、分析履歴保存、変更通知、共通画面部品を使う。接続先はbackend settingsの保存済み設定、認証は既存Control資格を再利用し、資格・設定を変更していない。新しいツールチェーン、inspection権限、専用lifecycle APIは追加していない。

- Connection readyでProvider識別情報を照合してclaimへ進む。claimableの10秒キャッシュは待機条件にしない。claim HTTP200の資格付きdescriptorを最終検証する。503 provider_semantic_not_readyだけ短いbackoff、409 connection_not_readyだけ接続状態を再取得し、120秒の待機枠を延長しない。failed/released/expiredは終了する。推論POSTを再送しない。
- 取消・成功・失敗時は自分が取得したConnectionを独立した期限で解放する。claim後、進捗通知で取消された場合も推論POST直前のsignal検査で送信を止める。
- 解放後に通常資格でConnectionを読み、allocationIdからallocation bindingsのvision.perception runtimeを特定する。モデル名・ポートを使って推測しない。
- `/state`はcache:no-storeで1秒間隔、30秒上限。online true、対象runtimeあり、COLD、observedAt >= releasedAt、取得時点から10秒以内、未来でない観測だけを停止確認にする。取得失敗・古い観測・対象不明・上限到達は停止未確認とする。
- 停止観測は読み取りのみで、次の取得やqueue枠を待たせない。観測結果は既存履歴へ後から反映し、取消した結果は採用しない。再起動で途切れた観測は停止未確認とし、確認済みの解放や推論を繰り返さない。
- COLDはLARMの稼働状態の観測。PID消滅・GPUメモリ解放の厳密な保証ではない。他の利用者の再取得でCOLDが見えない場合もあるため、停止未確認だけで異常にしない。

## 固定試験・結合

| 検証 | 結果 | 証拠 |
|---|---|---|
| `bun run verify -- --domain larm --domain ocr --domain object-recognition` | 成功。backend389、Web22、既存OCR部品10。境界・書式・lint・型・build・sizeも成功 | [domain-verification.json](domain-verification.json) |
| LARM停止・claim回帰 | 19成功。古い/未来/解放前COLD、offline、対象なし、warm継続、取得失敗、binding不明、ready+claimable false、指定503/409、terminal、取消・失敗時解放、観測と再取得の独立、epoch失効後の新規取得 | [larm-lifecycle-tests.txt](larm-lifecycle-tests.txt) |
| 両domain保存・取消・回収 | 14成功。上記verify後に追加した2件のsnapshot HTTP503保存試験を含む。結果を保持し停止未確認とすること、取消後の観測保存、再起動時の観測中断を確認 | [storage-tests.txt](storage-tests.txt) |
| Application公開API・登録 | 3成功。両domain共通queue、認証・所有者、既存登録の互換性 | [application-tests.txt](application-tests.txt) |
| Web hook・両runtime | 18成功 | [web-tests.txt](web-tests.txt) |
| 共通部品・物体認識部品 | 19成功。observing/COLD/unconfirmed表示、取消後も再実行可能。最終部品分割後に再実行 | [component-tests.txt](component-tests.txt) |
| 最終全体型・追加lint・size | 成功。規定超過を回避するため停止表示を小さな部品へ分割。閾値は変更していない | [typecheck.txt](typecheck.txt)、[size-check.txt](size-check.txt)、[extra-lint.txt](extra-lint.txt) |

snapshot取得失敗時の「停止未確認」は、HTTP503を注入した本番と同じLARM port＋domain保存試験と、共通画面部品試験で確認した。実LARMを障害状態にした試験とは区別する。従来のブラウザfixtureは専用サーバー起動が必要で、利用者指定により起動せず、稼働サーバーの画面で別途確認した。

## 修正済みLARMへの実接続

既存サーバーの起動停止は行わず、backendの保存設定を使うclient scriptで実モデルへ接続した。メタデータのみを[実接続記録](live.json)へ保存した。

| 確認 | 結果 |
|---|---|
| 通常Control資格による `/state` | HTTP200。Provider tokenは使用しない |
| claim後、推論POST前の取消 | claim HTTP200後に取消、独立したDELETEで解放。signal検査で推論を送らない |
| 停止観測を待たない再取得 | 新Connection取得、約21.3秒でreferring完了（起動待ち約17.2秒）、検出1件。成功時も解放 |
| 新鮮なCOLD | 上記2接続それぞれでbindingから同定したruntimeのCOLDを観測。observedAtは各releasedAt以降 |
| キャッシュ期限後 | readyからclaimを11秒遅らせ、Connection ready・Provider readiness ready・claimable falseを実観測。claim HTTP200、推論・解放・新鮮なCOLDまで成功（全体約43.2秒） |
| bootEpoch変更 | [旧Connection読み取り](epoch.json)はHTTP410 connection_epoch_expired。実接続記録の3接続と画面の2接続は変更後epochで新規取得 |

一度の実接続試験で上記を確認した。LARM側で行った4連続試験をEumenesの試験回数に加算しない。待機scriptの観測待ち引数は終了後に共通waitForの正式なtimeout/interval名へ修正したが、今回の観測は旧既定5秒以内に実際に完了しており、成功した実測値はそのまま保持した。

再実行: `bun scripts/visual-stop-observation-live.ts --run`。接続は自動解放し、旧Connectionを再利用しない。トークン・画像・推論本文・Provider生応答を通常ログやこの診断JSONへ書かない。

## Eumenes実画面

利用者による再起動後、稼働中のWeb画面を操作した。通常の保存済み試験画像を使い、新しいサーバーを起動していない。

- OCR: 詳細分析から実行し完了。起動待ち約19.8秒・推論待ち約14.4秒・全体約34.2秒。「停止確認（LARMの稼働状態: COLD）」が変更通知で表示された。[画面](ocr-cold.png)
- 物体認識: 詳細分析の解析中に中止。state cancelled、result不採用、releaseConfirmed true、その後COLD表示。「分析する」が再び利用できる。[画面](recognition-cancel-cold.png)
- [公開APIの保存結果メタデータ](ui-api.json)で、両画面のConnection・allocation・runtime・releasedAt・observedAtと結果採否を照合した。
- UI部品分割後にbuild・部品試験と保存結果の再表示を確認。再表示では推論を再送しない。

物体認識の従来YOLO解析失敗は以前からの別結果であり、今回の詳細分析の取消・停止観測とは別に表示される。範囲外の通常解析・会話・音声・Docling等の既存変更には手を加えていない。試験用分析履歴は画面で確認できるよう保持した。

## 差分点検

main上で作業し、新しいbranchや他Codexチャットへの送信はない。既存の他作業差分を一覧で確認して保持した。今回の専用判定は、公開HTTP契約、Connection/Provider識別、所有接続の解放、allocation binding、snapshot鮮度とstateの検査に限定する。利用者の言い回しや特定対象に依存する分岐・辞書・固定回答、モデル名/Profile名を固定した製品コードは追加していない。共通接続機構の既存利用者は既定の待機条件を維持し、変更は詳細分析のclaimオプションに限定した。
