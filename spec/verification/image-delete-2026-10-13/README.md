# 画像一覧の物理削除確認

[実装記録](../../image-delete-implementation-2026-10-13.md)に目的・契約・結果・未確認範囲をまとめた。

2026-10-13配備LARMの[OpenAPI削除契約](larm-delete-contract.json)をbackend保存設定とControl認証で読取確認。DELETE /v1/image-artifacts/{id}はHTTP200、idとdeleted:true。実LARM画像の削除は行っていない。

| 段階 | 結果 |
| --- | --- |
| LARM画像部分 | 12成功 |
| DS画像/全画面 | 14成功 |
| client | 2成功 |
| web画像host/OpenUI | 9成功 |
| API削除+画像生成fixture結合 | 10成功 |
| ブラウザfixture | 3成功 |
| Storybookの暗/狭幅表示 | ページ例外0 |
| image/larm/artifact gate | 成功 |
| root型・製品DS/Web build | 成功 |
| verify:all | 担当外settings→memory依存境界で停止 |
| DS全型 | 担当外TimerWorkspace試験の2件で停止 |

[確認（明）](confirmation.png)、[確認（暗）](storybook-confirm-dark.png)、[確認（狭幅）](storybook-confirm-mobile.png)、[削除後の一覧](gallery-after.png)、[ブラウザ結果](browser.log)。

[image gate](verify-image.json)、[larm gate](verify-larm.json)、[artifact gate](verify-artifact.json)、[全体gate](verify-all.json)。全gate中は入力を編集せず、完了後に結果記録だけ追記。
