# 画像一覧の物理削除

目的・範囲: 一覧の利用者操作からLARM保存画像を物理削除し、一覧・選択プレビューを更新する。LARM adapterと公開API/client、OpenUI操作とDesignSystemの一覧を拡張する。
正本: 保存済みbackend設定から読取専用でGET /openapi.jsonを確認。2026-10-13配備のDELETE /v1/image-artifacts/{id}はBearer認証、HTTP200、{id,deleted:true}。画像ID形式も現行契約と一致。API不足はない。
再利用: LARM ControlのURL/認証/timeout、imageArtifactId、image domain controller、client Transport、OpenUI source/revision/event ID/lock、DS ButtonとModal。利用者が明示した画像IDの削除であり意味判断は不要。会話側の担当/Skillや生成計画は変更しない。
非目標: 一括削除、復元、ごみ箱、DB migration、別機能の修正、新しい依存。Eumenesの生成履歴は維持し、LARMの実体だけを削除する。保存済み既存画像を実削除する受入は行わない。
依存順: 1 削除結果契約・LARM adapter 2 DELETE /api/images/:idとclient 3 OpenUI削除dispatchとcache更新 4 DS削除ボタンと確認、結果反映 5 部分 6 API/host結合・ブラウザ 7 image/larm/artifact gate・verify:all・Web build 8 差分点検と記録。
完了条件: 確認中は削除しない、確定で単一DELETE、正確な結果IDを検査、成功後に一覧/プレビューから消える、失敗時に残る、存在しないID・source・revision・重複を拒否/安全に扱う。認証なしと不正IDで外部削除しない。
検証計画: larm画像部分、DS一覧部分、web画像host、API削除結合、client Transport、ブラウザfixtureの順。削除失敗と不明結果を成功表示しない。実OpenAPIは読取のみ、削除はfixture。横断gateで担当外の失敗は証拠を記録して停止。
着手時の残作業: 実装・回帰試験コード・文書、部分→結合→全体gate、結果と未確認範囲の記録。

実装済み・試験前:
- LARM画像delete結果schemaはid/deleted:trueを検査し、対象IDの一致を確認する。Control認証と15秒deadlineを再利用。DELETEの自動再送なし。
- DELETE /api/images/:idをimage controllerへ追加し、client.deleteImageから使う。認証・不正ID・不存在・結果不明を区別する。DBや生成担当の指示変更はない。
- image-deleteイベントを既存OpenUIに追加。正規source・revision・ID存在・重複・操作lockを検査。DELETE前後で進行中の一覧GETを取消し、確認済み対象をcacheから外して正本一覧を再取得する。選択中のプレビューもクリアする。
- DS ImageGalleryに削除ボタン、既存Modalによる対象確認、待機中の無効化、個別OpenUI galleryの結果表示を追加。取消ではAPI操作せず、失敗では保存画像を勝手に隠さない。
- adapterの正確なreceipt/失敗/no-retry、APIの認証/ID/bytes・metadata削除、client契約、hostの拒否/失敗/duplicate、部品の確認/取消/一覧反映とブラウザの失敗後再操作の試験を作成。実接続はOpenAPI読取のみ。


確認結果:
- LARM画像部分: 12成功。HTTP200の正確なreceiptと対象一致、不正ID、false/missing receipt、404/503の自動再送なし。
- DesignSystem画像/全画面: 14成功。対象確認・キャンセル・確定ID・待機無効化・失敗時の画像保持と表示・一覧変更後のpreview閉鎖、既存フォーム/画面切替の回帰。
- client: 2成功。DELETE契約、IDの送信前検査、別IDの結果拒否。
- web画像host/OpenUI: 9成功。確認後だけimage-deleteを正規source/revisionで送信、unknown/stale/duplicateを検査、結果不明と一覧再取得、成功後の選択クリア、既存生成/閉じる/容量境界。
- API結合: 10成功。画像生成回帰8件と削除2件。認証なし401・不正ID400ではLARM要求0、成功200でmetadataとbytesをfixtureから削除、一覧0/totalBytes0・content不取得、再削除404。503では502と安全な分類を返し、画像を保持。生成POST追加なし。
- ブラウザfixture: 3成功。既存制作・一覧・再表示2件と削除1件。キャンセルでDELETE0、502で画像保持、再操作の200後に一覧枚数減少/プレビュー消失/文章保持。暗色・狭幅の確認はStorybookで実施しページ例外0。
- image / larm / artifactの各verify成功（larm128試験、artifact49試験）。root型1,205 files、製品DS build、Web build、size budget19 files、差分空白検査成功。
- verify:allは既存web/src/domains/settings/MemoryItemsPanel.test.tsxのsettings→memory依存境界で初期停止。後続の全件gateは未実行。DS全型検査は既存TimerWorkspace.test.tsx:22/125のgetByRole exact指定2件で停止し、今回の画像変更に型エラーなし。担当外は修正・反復実行していない。
- live: 保存済みbackend設定から配備OpenAPIを読取確認しただけ。既存LARM画像の実削除、新規実生成、実モデル判断の変更/確認は未実施。

差分点検: 着手前snapshotと照合して既存共有ファイルへの変更をimageの公開削除契約・イベント・部品接続に限定。生成Skill/SystemContext・DB・別domain・認証方式は変更していない。明示した画像IDの操作で意味分類や個別題材の分岐を追加していない。既存の未コミット差分は保持。

状態: 削除機能実装済み、固定試験・ブラウザ確認済み。全体gate成功と実LARM画像削除の確認とは区別する。残作業は担当外の設定境界/タイマー型エラー解消後の全体検証。続行条件はそれらの担当作業による解消であり、本件では改修しない。
固定証拠: [削除の確認](../verification/image-delete-2026-10-13/README.md)。OpenAPI抜粋、gate結果、ブラウザ記録、確認画面を保存。
Context Still: 今回context_compile/compile_eval各1、会話累計各3。initial_instructionsは会話初回の1回のみ。
