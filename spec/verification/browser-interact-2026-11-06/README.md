# browser.interact 本体統合の検証

2026-11-06。検証用入口までを受入済み。通常会話の候補は初期無効のままです。稼働中の製品サーバーとDBは変更していません。

mainの元版に今回の差分だけを載せた固定コピーで検証しました。まず6領域のverifyが1,800件成功し、最後の撮影参照・表示・入力保護の変更後に、影響する4領域のverifyが1,121件成功しました。型、境界、SQL、固定指示、書式、lint、生成物の整合確認も成功しています。件数は重複するため合算しません。

追加した受入はbackend 31件、Web 5件、実ブラウザの画面試験2件の計38件が成功。モデル応答は固定fixtureです。隔離HTTPサーバー、MCP、Chrome、撮影とWebP変換は実物を使用しました。原依頼・開始URL・自由入力の回答が共通受付履歴に保存されないことも確認しています。

- [結果と範囲](acceptance.json)
- [検証したソースのhash](sources.json)
- [広域verify](verify-broad.json) / [最終verify](verify-final.json)
- [backendの31件](backend.log) / [Webの5件](web.log) / [画面の2件](browser.log)
- [旧runner等の追加検証50件](legacy.log)
- [320pxの画面](interact-320.png) / [700pxの画面](interact-700.png)

追加の有料API呼出しは0件。共通台帳の保守的計上8.024065 USD、未確定11件の予約を保持し、10 USD上限を継続しています。単体の既存評価81.9点を本体統合後の再採点として扱いません。
