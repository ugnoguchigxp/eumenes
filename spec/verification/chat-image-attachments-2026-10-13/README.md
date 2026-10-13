# チャット画像入力の検証資料

- `live.json`: 保存済みLARM接続を使った隔離Eumenes経路の実推論4ケース。要求本文やBase64を記録せず、計数結果の一部・statusと非機密合成画像への回答のみを保存。
- `red.jpg`、`blue.png`、`green.bmp`: live受入用の非機密合成画像。
- `chat-narrow.png`: fixtureの履歴表示と狭幅の確認画面。
- `integration.log`: 追加部分・API結合試験。
- `browser.log`: paste/drop/選択から履歴と後続質問までのfixtureブラウザ試験。
- `verify-conversation.log`、`verify-dialogue.log`、`verify-larm.log`、`verify-inference.log`: 所有domain gate。
- `build.log`、`typecheck.log`: 製品buildとroot型確認。
- `verify-all.log`: 担当外のsettings→memory境界違反による全体gate停止の証拠。

fixture、live、稼働先での確認を区別する。音声の実機器受入とは関係しない。

ログは保存時に行末空白だけを除去しています。試験の期待値や結果は変更していません。`deployed-composer.png`は稼働UIの添付・保持方針表示です。
