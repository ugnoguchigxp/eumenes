# 楽曲生成UIの確認

実装の範囲、版と未確認事項は[作業記録](../../.archived/music-generation-ui-work-record-2026-10-11.md)。画像は固定モデル・認証付きAPI fixture・保存済みOpusによる実際の画面。外部の楽曲生成と画像生成は実行していない。

- [ジャンルとプロンプト](genres.png)
- [歌声・声質・歌詞](desktop.png)
- [生成中・取消](generating.png)
- [390px幅](narrow.png)
- [生成／取消APIと画像未呼出し](result.json)
- [保存済み音声・Visualizer・プレイリスト](playback-result.json)

music／artifact／capabilities／larmのdomain gateは成功。それぞれ `verify-<domain>.log` に記録。

全体gateは未合格。`verify-all.json`／`verify-all.log` は初回、`verify-all-final.json`／`verify-all-final.log` は再検証。最終回は共通拒否ログの試験1件で失敗し、単独でも再現した。担当外を修正せず停止した。検証中の別作業による入力更新も確認したため、全体成功とは宣言しない。

後続を個別実行した結果：Web／client 633成功、DesignSystem 1,109成功と型成功、build成功、ブラウザ44成功・1スキップ。それぞれ同名の `.log` に保存。これらは全体gateの成功を代替しない。実モデルの担当選択・英語化・長い歌詞と、実際の歌声は未確認。

画面の通知エラーは音楽専用fixtureに通知・タイマーのAPIがないため。今回のUI操作のエラーではない。画像生成のボタンは無効、表示はモック。
