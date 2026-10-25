# Docling Desk コードレビューと改善

2026-10-25。対象は今回追加したDocling連携と、その登録・設定・Artifactの接続。既存設計を維持する不具合修正として進め、並行作業の担当外変更は保持する。

手順は、指示・契約と差分の再確認 → 境界条件の再現 → 最小修正 → 部分/結合/ブラウザ試験 → 再レビュー。完了条件は、確認できた指摘を修正し、取消・設定更新・エラー表示の回帰試験を通し、対象差分を再点検して未解決の指摘がないこと。全体gateの担当外問題は別記する。

## 第1ラウンド: 指摘と再現仮説

1. 設定更新が画面に届かない。Web query keyは独自の`docling`文字列だが、既存SSEの`changeRoots`に未登録。初期未設定から設定しても開くボタンが無効のままになる。上流へ接続しない既存status APIを既存の変更通知に接続する。
2. Web側で古い接続要求を破棄しない。cleanupはunmount時だけで、clientや取得済み設定revisionが変わっても要求が残る。backendが応答を確定した後にクライアントで設定更新を観測する場合も含め、古いtabへ遅い結果を使わないことを試験する。
3. Artifactの競合理由が消える。共通hostは古いrevisionに`conflict`を返すが、表示部品は`rejected`しかエラーにしない。成功以外の理由を表示し、再操作できるようにする。

意味分類、起動待ちジョブ、文書保存、認証方式、lease管理を変更しない。一般的な改善案だけで範囲を広げず、再現できる差異を根拠に修正する。

## 第2ラウンド: 再現と修正

- query root未登録、設定更新時の未取消、client切替時の未取消、競合理由の非表示を固定試験で再現した。
- `queryRoots.docling`を既存SSEの変更対象へ登録。Docling statusはsettingsだけの読み取りなので、本体を起こさない。
- Web adapterのcleanupをclientと設定revision/configured/publicOriginに結び付け、古い別タブを閉じ、遅いticketを採用しないようにした。同じ設定の定期再取得では取り消さない。
- Artifactは`rejected`と`conflict`の理由を表示する。pending/indeterminateを失敗表示へ変更していない。
- Web8件、Artifact部品1件が成功。React Queryの再取得完了とReactの反映は非同期なので、試験では描画更新の完了を明示的に待つ。
- 実HTTPを切断する追加のlocal fixtureで、BunのRequest.signalから上流取消へ伝わり、実行中ガードが解放されることも確認した。初回のAPI試験中にformatを実行したため、初回を最終証拠には数えず、固定コピーで再実行する。

## 第3ラウンド: 俯瞰と再レビュー

- 3点の指摘について、修正前の再現と修正後の成功が得られた。別の意味判断方式や永続状態を追加せず、既存の通知と取消へ接続した。新しい証拠のない同一失敗の再試行はしない。
- 認証・許可origin/Host・一回だけのPOST・ticket非保存・取消/設定変更後の採用・immutableな入口receipt・共有ライブラリの表示を再点検し、追加の未解決指摘は見つからなかった。
- 利用者からSSH禁止の追加指示を受けた。このレビューではSSH接続を実行していない。前回の中継PIDは既に終了していた。以降も再接続せず、実Doclingへは接続せず、ローカルfixtureだけで最終検証する。前回のlive受入結果は今回の再実行として数えない。
- 最終検証は、環境ファイル・製品DB・秘密を除いた固定コピー`/tmp/eumenes-docling-review`で行う。新しいブランチは作成しない。

## 最終結果

3件の指摘を修正し、最終差分の再レビューでDocling連携に追加の未解決指摘はない。登録方式、モデルの判断方式、認証方式、起動・停止の責務は維持した。通信中の不変な設定の再取得では取消しないこと、二重操作でタブや上流要求を増やさないこと、正常に開いたDoclingタブはArtifactを閉じても残ることも試験した。

| 検証 | 結果 |
| --- | --- |
| Docling正式verify | pass。入力revisionと終了revision一致、DesignSystem出力も一致 |
| 型検査 | 全2,627ファイル成功 |
| domain/settings/API/会話結合 | 11件成功、73 assertions。実HTTP切断とガード解放を含む |
| Web対象 | 11件成功。open、adapter、Artifact構成、query keys |
| 実ブラウザfixture | 3件成功。成功・認証失敗・popup拒否。ランダムportの専用localhost fixtureだけへ接続 |
| 利用側Bun | 1,057件成功、失敗なし。新しいArtifact描画試験を含む |
| 利用側Web | 110件成功、既存2件失敗 |
| 利用側/全体verify | 既存サイズ超過で停止。gateの制約は変更していない |

利用側Webの失敗は`artifact/test/composition.test.tsx:112`と`artifact/test/nested-layout.test.tsx:71`。前者はlayoutのchildren13件を拒否する期待、後者は深さ4・総view60の旧期待を含む。現行の共通契約はchildren48、深さ6、総view240であり、今回の3箇所の修正はその上限や解析処理に触れていない。担当外として調査と記録に留め、旧期待や現行制約を変更して通していない。

サイズgateには共有Artifactの3ファイル、settingsの試験、agency・server組立て・既存画面等の超過がある。前回残っていた型エラーは今回の検査では解消していたが、全体検証成功とは扱わない。

詳細は[review-checks.json](review-checks.json)、[Docling正式レポート](review-verify-docling.json)、[利用側gate](review-verify-consumers.json)、[全体gate](review-verify-all.json)。変更した製品3ファイルと試験3ファイルは検証コピーと一致することを確認した。`git diff --check`成功。context_compile/compile_evalは会話累計各4回。SSHと実Doclingの再接続は未実行。
