LARM画像取込 Eumenes受入記録（2026-10-19）

実装済み
・共通codec：EXIF向き、長辺2000px、拡大なし、品質75非可逆WebP、alpha保持、メタデータ除去。
・本番OpenAPIのreceiptとerror schema、通常Control認証、multipart file一個。
・送信前のUUID/bytes永続化、接続・token fingerprint、同一UUID直列化。
・応答断は照会、404だけ同一bytes再送。failed/削除/期限切れでは再作成しない。認証変更後の旧依頼を停止。
・共通ImagePickerの参照→アップロード→候補→確定→明示生成。32px未満は3D用に選択不可。取消後の応答を無視。
・Google追加同意・実付与scope検査・公式Picker・選択した写真だけbackendで取得・同じ画像取込へ接続。session/epoch取消と同一origin preview。外部URLを任意入力しない。

固定・結合
・image/LARM import試験7件、画像準備5件、Google provider/Photos試験13件成功。Google基本連携の既存試験も成功。
・applicationのGoogle写真→画像取込の結合2件成功。既知UUIDは元写真を再取得せず再開、選択変更・任意URLの拒否。
・共通Picker/ImageGallery/Model3dWorkspace計29件成功。参照だけでは送信しない、状態再確認は同UUID、取消でabortと遅い結果の排除、選択確定を分離。
・Web media試験5件成功。Google写真の明示取込、LARM ID引渡し、通信断後照会、失敗/削除/期限切れ、各HTTPエラー表示。
・サーバー不要Chromium部品試験4件成功。実GLB Grid、枠内詳細、狭幅、参照file chooserとプレビュー、アップロード→確定→生成ボタンでID引渡し。
・setContent試験はopaque originのためcrypto.randomUUIDが無い。試験側だけNodeで生成したUUIDを渡し、実製品のsecure loopback動作は変えていない。
・全体型検査は今回範囲の実装後に成功。後続の並行browser編集でweb/src/domains/browser/source.tsのBrowserTabStatus（blocked）型不整合が新たに発生し、最新の全体型検査はそこで停止。担当外として修正していない。
・今回範囲のlint/整形/size、diff --check、Web本番ビルド成功。
・実サーバー入口の共通JSON 1MiB制限を点検し、画像取込を既存streamBoundedRoutesへ登録。2MiB multipartを認証・共通ミドルウェア経由で受け、別パスは413、未認証401、取込上限超過413を確認。application既存試験と合わせ21件成功。
・先行の追加試験400はBun ResponseのFormDataを消費した後にContent-Typeを取得した試験側の問題。serialize前に取得し修正。製品のmultipart schemaは緩めていない。
・domain verify（image/model3d/larm/google-accounts/browser）は全14step成功、Web67件・DS44件を含む。ただし並行ソース変更検知で総合invalidated。検証中に自身の製品編集はしていない。総合passとはしない。
 report: verification-reports/runs/2026-10-18T21-36-08-894Z-c7e4e4d8-270f-466a-b193-141e4d993e46/report.json
・先行verifyは今回追加した試験のByRoleOptionsのexact指定の型エラーで停止し、修正済み。その後の型・部品・domain各step成功を確認。

本番LARM
live.jsonに記録。保存済みsettingsの公開読み取りとbackend認証解決だけを使用。
実ネットワークの前段には隔離DBを持つEumenes createApp（認証・共通ミドルウェア込み）を使い、APIサーバーは起動していない。
利用者添付の端末PNG：1462x928、277,021 bytes→31,828 bytes WebP（約88.5%削減）。
透過2000x2000 PNG：7,406 bytes WebP、alpha 127/128を保持。
各caseで一覧・content取得・保存後sha256・WebP bytes完全一致を確認。
応答破棄後のDB再open/照会、送信前切断の404照会→同UUID/同bytes再送、実DELETE後のreceipt deletedと一覧非表示、復活しないことを確認。
試験で新規作成した画像のみ削除。既存画像と元PNG/Google写真は変更していない。
取込経路の外部リクエストをimage-artifacts/image-importsに限定して検証し、GPU/生成POSTは送っていない。

未完了の実受入
利用者がbackend/Webを再起動した旨を報告し、2026-10-19に稼働画面を確認。本人のGoogle追加同意・実写真取得は同意操作待ち。
Google CloudのPhotos Picker API有効化・同意scope・テストユーザー設定が必要なら配布元が設定する。
実3D生成は今回自動実行しない。ID引渡しはfixtureで確認済み。利用者の生成ボタン操作で開始する。

差分点検
今回の専用処理は外部API契約のUUID/receipt/認証/期限・画像decode制約・Google同意境界に限定。発話の分類、語句分岐、LLMの意味判断代替は追加していない。
既存の並行browser/agent改修は保持し、その無関係な差分は修正していない。ブラウザ画像encoderの共通化は前依頼からの許可範囲。

稼働画面の端末画像受入（2026-10-19、再起動後）
・Braveの既存Eumenes画面で、3D→保存した画像から作る→画像を選ぶ→参照…を操作。
・自動file chooserのsetFiles経路ではファイル名を取得できるものの、blob previewのnaturalWidth=0で画像を読めず、POSTもbackendへ到達しなかった。receipt GETは404。画面再読み込みでも同じ。製品の通信失敗やLARM受付成功とは扱わない。
・稼働APIへの同じclientによる送信は成功。Web中継経由も同UUIDで成功し、サーバー・proxyと自動ファイル選択を分離した。
・OSの通常ファイル選択に切り替え、利用者の元写真MW1193-2_001.jpg（600x600、65,865 bytes）を選択。プレビューnaturalWidth/Height=600を確認してからアップロード。
・実画面upload→共通一覧で選択中→枠内拡大→この画像を使う→3Dフォームに600x600画像が確定、まで成功。画像は16,556 bytes WebP（約74.9%削減）。contentの保存sha256一致も確認。running-ui.jsonとterminal-upload-ui.jpgへ記録。
・実3D生成ボタンは押していない。画像取込だけで生成しないことを画面でも確認。元のJPEGを変更しない。
・切り分け用のスクリーンショット取込はこの試験で作成した1件のみ削除し、receipt deletedを確認。元写真の取込は利用者の画面候補として残す。
・Googleフォトのタブで追加同意の入口を確認。「写真選択を許可」からGoogle公式Choose an account画面まで開いた。本人に連携中の同一アカウント選択・追加同意を引き継いだ。アカウント選択・許可の代理操作は行っていない。
・本追記は受入記録のみ。製品コード・他タスク・サーバー操作に変更なし。
