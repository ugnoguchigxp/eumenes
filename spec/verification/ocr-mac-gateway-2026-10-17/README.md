# OCR正式gateway：Macからの接続設定と実接続受入

2026年10月17日。ユーザー指定の正式origin `http://192.168.0.130:18794` を、既存の設定APIで保存した。URLにパス・末尾スラッシュを追加していない。最終設定はrevision 1、`credentialConfigured: true`、`sharedCredentialAvailable: true`。

## 範囲と実行環境

今回のHTTP要求はMac上のEumenesワークスペースから送信した。稼働中backendの認証済みAPIは `http://127.0.0.1:8787` を使用した。OCR要求によるworkerのオンデマンド起動と取消は、今回の明示的な依頼に従って実施した。SSH・転送は使用せず、backendの起動・停止・再起動や接続方式の変更は行っていない。製品コードも今回の作業では変更していない。

認証はbackend共通の `resolveLarmToken` を使用する。`LARM_API_TOKEN`、未設定時は `LARM_CONTROL_TOKEN` をBearerとして送る既存経路を維持した。別キー、claim token、Excalidraw専用資格情報は使用していない。

## 状態確認と設定保存

| Macから正式originの `GET /hosting/status` | HTTP | service ID | state | generation |
| --- | --- | --- | --- | --- |
| 共通トークン付き・確認前 | 200 | ocr-host | stopped | 9 |
| 未認証 | 401 | — | — | — |
| 不正トークン | 401 | — | — | — |
| 共通トークン付き・確認後 | 200 | ocr-host | stopped | 9 |

状態確認だけではworkerが起動せず、state・generationが維持されたことを確認してから保存した。

`GET /api/settings/ocr` でrevision 0・接続先なしを確認し、`PUT /api/settings/ocr` に `expectedRevision: 0` と指定originだけを渡した。保存応答は200、revision 1。保存要求の `X-Request-Id` は `c97a7233-f168-43bb-bf88-9c232150c3bb`。最終再取得でも指定originと資格情報の利用可能状態が一致した。

[状態確認・保存記録](configuration.json)と[最終読取り記録](final.json)を参照。

## 合成資料での実接続

800×400pxの合成PNGと、その画像を表示する3秒のMP4を使用した。取消用には12秒のMP4を別途作った。原稿は試験用の英語3行で、実利用者の資料は使用していない。実行記録にはOCR本文やProviderの生応答を保存せず、検出有無・行数・フレーム数だけを残した。

| 検証 | Mac実接続の結果 |
| --- | --- |
| gateway `POST /api/analyze`、PNG | multipartの`file`一つで同期200。画像結果の契約に適合し、3行と試験文字の検出を確認 |
| gateway `POST /api/analyze`、3秒MP4 | 202とjob IDを取得 |
| gateway `GET /api/jobs/{id}` | 200、running→completed。動画結果は6フレーム・合計18行 |
| 稼働中EumenesからPNG受付 | API受付202→completed。実gatewayの結果が保存された |
| 稼働中Eumenesから3秒MP4受付 | API受付202→queued→running→completed。6フレームすべてで試験文字を検出し、合計18行を保存 |
| 原本取得 | PNG・MP4とも認証済みAPIが200を返し、送信したバイト列と完全一致 |
| 稼働中Eumenesから12秒MP4の取消 | 上流受付を示すqueued・revision 2の後に取消。APIは200、cancelling→cancelled。`result: null`・`errorCode: null`で上流の取消完了を確認。後続取得でも復活なし |

稼働中Eumenesの試験資料は会話 `ocr-mac-acceptance-2026-10-17` の範囲に保存した。画像資料IDは `9668ff59-33cc-4773-8d66-1b0251c88646`、完了した動画は `f2258175-7184-4e8f-b0d8-197e8718740d`、取消済み動画は `69c92a74-3aff-4837-b71e-bfba039b2457`。

これらは接続・契約の受入であり、日本語OCRの品質評価、カメラ撮影、ブラウザの操作受入を行った結果ではない。

[gateway・Eumenes画像・取消の記録](acceptance.json)、[Eumenes動画完了記録](backend-video.json)を参照。

## 原本・結果の権限

- 稼働中Eumenesの原本・結果APIは、未認証・不正APIトークンの両方を401で拒否した。
- Macの隔離したin-process backendで、既存の公開HTTP操作をalice／bobの別所有者へ登録した。同じ正式gatewayを使ってaliceの画像を実際に解析し、aliceの原本・結果は200、bobによる両方の取得・取消・削除は404だった。aliceの資料は変更されなかった。socketで待受する試験サーバーは起動していない。
- 上記の別所有者検証は、稼働中の単一principal構成へ新しい利用者や認証方式を追加したものではない。原本・結果の所有者境界を隔離した公開操作で確認したものとして区別する。
- 既存のOCR固定試験も9件成功・0件失敗。所有者境界、原文保存、再送防止、動画状態、取消後の遅い結果、設定変更等を確認した。

[別所有者の検証記録](owner-boundary.json)を参照。

## gnosis内の過去結果との区別

[以前の認証確認](../ocr-auth-2026-10-17/README.md)はSSH経由でgnosis内のloopback入口を調べた結果で、generationは7だった。今回のMacからの正式originへの到達、設定保存、画像・動画解析、取消の成功を、その過去結果へ混在させていない。

## 確認と完了条件

指定originの認証・読取り専用状態確認→既存設定APIで保存・再取得→画像・動画・取消の結合確認→稼働中backendの保存・原本確認→別所有者の拒否確認、の順で実施し、すべて成功した。実際の文字列との照合・結果schemaの検証はメモリー上で行った。

今回保存したJSON記録について、backend用APIトークンとLARM共通トークンの実値が含まれないことを検査した。秘密・OCR本文を報告へ転記していない。

今回の変更は接続設定と検証記録だけであるため、製品コードの全体ビルド・ブラウザE2Eは再実施していない。以前の一括verify・client試験の担当外エラーは、以前の記録に残したままであり、今回のMac実接続の成功で解消したとは扱わない。

完了: 指定originの保存、Macからの認証・解析・取消、原本保存とアクセス境界の確認。URLの推測変更、接続方式や意味判断ロジックの追加はない。
