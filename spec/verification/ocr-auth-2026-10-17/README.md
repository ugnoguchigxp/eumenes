# OCRのLARM共通トークン認証確認

追記: 正式originの指定を受け、後続作業で[Macからの接続設定と実接続受入](../ocr-mac-gateway-2026-10-17/README.md)を完了した。以下は正式入口の指定前に行った調査の記録。

2026年10月17日。調査、Eumenesの設定状態表示の修正、LARM担当向け依頼書の作成を実施した。接続先の保存、SSH転送の起動、backendの再起動、実画像・動画の解析は未実施。

## 原因の切り分け

稼働中Eumenesの `GET /api/settings/ocr` は `revision: 0`、`baseUrl: null`、`credentialConfigured: false`。接続先が未保存で、OCR履歴も空だった。LARMは `ocr-host` を登録済みで、gatewayはAIサーバーのloopbackだけで待受し、Mac側の対応ポートに転送はなかった。

既存実装はsettings domainの共通 `resolveLarmToken` で資格情報を解決し、OCR domainのgatewayがBearerを送る。共通契約もこの経路を指定しているため、新しい認証方式・フォールバック・LLMの判断規則は追加していない。

## 実接続・読取り専用確認

[資格情報を含まない取得結果](live-readiness.json)を保存した。

| 確認 | 結果 |
| --- | --- |
| Eumenes settings API | 認可されたAPI呼出しで200、OCR接続先は未設定 |
| gnosisからOCR gatewayの `/hosting/status`、トークンなし | 401 |
| 同じ入口、不正Bearer | 401 |
| 同じ入口、EumenesのLARM共通トークン | 200、`ocr-host`、`stopped` |
| 確認後のControl service状態 | 200、`stopped`、generation 7のまま |

SSH経由の読取り確認であり、MacからOCRへ通常接続できたという結果ではない。実際の画像・動画を解析していないため、gateway認証の成功とOCR解析の受入を区別する。

## 変更と固定試験

settings APIへ、接続先とは独立した `sharedCredentialAvailable` を追加した。clientと既存Artifactのresourceへ渡し、URLの未保存とトークンの未読込みを別々に表示する。旧backendレスポンスとの互換性のためclient・propsでは省略を許す。資格情報の値は返さない。

既存のHTTP結合試験を両環境変数名へ適用し、トークン付きgateway要求、公開レスポンスへの非露出、URL未保存でも共通トークンが利用可能と分かることを確認した。画面では、URL未保存、URL保存済みで資格情報なし、上流認証拒否の3状態を確認した。

| 検証 | 結果 |
| --- | --- |
| 変更箇所の部分試験 | OcrPanel 3件、Web runtime 10件成功 |
| HTTP結合試験 | LARM_API_TOKEN／LARM_CONTROL_TOKENの2件成功 |
| `bun run test:domain -- --domain ocr --domain settings --domain artifact` | backend 297件、Web 95件、DesignSystem 3件成功。合計395件 |
| DesignSystem型検査 | 451ファイル成功 |
| 変更コードのformat・lint・差分空白検査 | 成功 |
| `bun run verify -- --domain ocr --domain settings --domain artifact` | boundariesで停止。担当外の `web/src/domains/settings/useSpeechModels.ts` がsettings→inference依存違反。一括検証は未通過 |
| clientの関連結合試験 | 49件成功・3件失敗。既存の会話追加fixtureに必須の `specialistSessionId` がなく、OCR／補正／物体認識の会話追加応答で失敗。HEADのschemaでも同フィールドは必須であり、今回の接続状態フィールドとは別の不整合。担当外として未修正 |
| 対象ブラウザE2E `tests/browser/ocr.spec.ts` | 未実施。fixtureのbackend・Webを起動するため、AGENTS.mdの明示許可が必要 |
| Macからの実OCR通し・実カメラ | 未実施。到達可能な入口と起動の許可が必要 |

差分点検では、今回の変更にユーザー発話・語句・個別シナリオを分類する処理がないことを確認した。追加した分岐はAPIが返す接続設定・資格情報の有無の表示だけであり、LLMの意味判断を代替しない。他作業の変更は修正していない。

## 残作業

当時の残作業は次の3件だった。

1. [LARM担当への依頼書](../../.archived/ocr-larm-connectivity-request-2026-10-17.md)に従って到達可能な正式入口を用意する、または許可を得て既存gatewayへのSSH転送を起動する。
2. Eumenesの認証済み設定APIで接続先を保存する。未設定の値を推測で保存しない。
3. 起動を伴う試験の許可を得て、Macから画像・短い動画・状態照会・取消の受入を行う。

2026-10-17 の後続で、1〜3 は [Mac実接続の受入](../ocr-mac-gateway-2026-10-17/README.md) で完了した。この記録の対象ブラウザE2Eと、担当外の verify 失敗は、ここには残ったままである。

認証処理を新規実装した、現在の製品画面に修正を配備した、またはOCRを利用可能にした、という完了報告はしない。
