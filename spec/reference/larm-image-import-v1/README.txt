LARM画像取込 本番契約（2026-10-19）
正本は保存済みLARM接続先のGET /openapi.json。本ディレクトリのopenapi.jsonは、実接続で取得した画像取込・照会のpathsと参照schemaの抜粋であり、接続先・認証情報は含めない。利用者報告の本番revisionは111af3557904。
旧larm-image-import-v1-proposalは検討履歴であり、実装の契約として使わない。

POST /v1/image-artifacts/imports
Control Bearer認証、Idempotency-Key UUID、multipartはfile一個、image/webp。
EumenesでEXIF向きを適用し、拡大せず長辺2000px、品質75の非可逆WebPへ共通codecで変換。alpha保持・メタデータ除去。変換後16MiB、各軸2000px、4,000,000画素、multipart16MiB+64KiB。
201/200成功、202受付中。receiptはrequestId/createdAt/expiresAt/statusUrl/status。
succeeded/deleted:false/artifact、succeeded/deleted:true/artifactId、failed/error:{code,message}を区別する。artifactに生成専用model/seed/stepsは不要。
GET /v1/image-imports/{UUID}で7日間照会。202はRetry-Afterに従う。
同一主体・UUID・画像bytesで同一結果。通信断は先に照会、404だけ同UUID・保存済みbytesを再送。failedは同キー再実行不可。明示的なやり直しだけ新UUID。削除済み200 deleted:true、期限切れ410 image_import_receipt_expired。token変更後は過去依頼を自動再送しない。
通常error:{code,message}と失敗receiptを区別し、400/401/409/413/415/429/503/507を表示する。

EumenesのAPI・操作・受入結果はdocs/images.md、docs/model3d.md、docs/google-accounts.md、およびspec/verification/model3d-image-import-2026-10-19/を参照。
