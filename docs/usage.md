# 利用状況

独立メニュー「利用状況」からアーティファクトを開く。既存のワークスペース内に表示し、全画面への遷移は行わない。音声会話設定の「関連画面」からも開ける。

「概要」「Live」「Codex SDK」「料金設定」の4タブ。期間は今月を初期表示とし、今日・7日間・任意期間（366日以内）、モデル・接続で絞り込める。Codex SDKタブでは、保存済みの現在の会話モデルがCodex接続なら初期選択する。モデル識別子の完全一致で集計する。

## 計数と費用

- LiveはAPIの累計利用秒数。途中通知を足し合わせず、最終値がない切断では最後の受信量を残して「最終量未確認」とする。無音・作業待ちもAPIの報告に含まれる。
- Codex SDKは入力総数、出力、キャッシュ読取・作成、推論出力の受信量を保持する。キャッシュは入力の内訳、推論は出力の内訳で、総数へ再加算しない。複数の上流呼出しを含む実行全体の累計を使い、失敗・取消・不採用も取得済みの数値を集計する。
- 契約残量や追加請求額、Codexクレジットへの換算は表示しない。SDKの金額が取得できない場合、トークン量のみを表示する。
- Liveの概算には「料金設定」でモデル、USD / 分、適用開始（日本時間）、出典を入力し、確認して保存する。単価は上書きせず履歴を追記する。単価以前の実行や欠測は「未算定」。請求確定額とは区別する。

全カード・日別推移・明細は同じフィルターを使い、表示中の25件ではなく全保存対象を集計する。日付はAsia/Tokyoの開始日時で分類し、日付をまたぐ接続は開始日にまとめる。期間外で接続中のLiveは別に知らせ、小計へ加えない。実測されていない過去のモデル・終了日時・キャッシュ量は補完しない。

## 保存と実装

Liveの事実はlive-voice、SDKはinferenceが所有する。既存の忘却処理で回答・字幕が削除されても、本文を持たない数値と実行メタデータは既存の利用記録と同じく残る。新しい会話複製、保持期限、数値の自動削除は導入しない。集計はその時点で保持されている記録の範囲であり、記録のない過去をゼロ消費と断定しない。

usage domainは公開読み取りportから数値を受け、集計と単価履歴のみを所有する。画面は15秒ごとに保存値を再読する。Providerの追加呼出し、LLMによる分類、追加APIキーは不要。金額は小数文字列と整数演算で12桁の小数精度まで計算し、表示時に整える。

登録は `usage-dashboard.bundle.json`、`artifact:usage.dashboard@1`、`adapter:usage@1`。OpenUIの `usage-dashboard` は共通DesignSystem部品を呼ぶ登録view。独自の全画面ルートやWorkspaceArtifactsの分岐は追加しない。

Codex実通信は毎回ephemeral threadを新規作成し1turn実行する。従ってthreadのtotalが今回のattempt量となる。lastは直近の上流呼出しであり、全量として使わない。将来thread再開を追加する場合は開始前累計を差し引く必要がある。モデル変更通知があった累計を元モデルだけに付けず「不明・複数モデル」に残す。

根拠: [Liveの利用量と終了](https://developers.openai.com/api/docs/guides/live-conversations#usage-and-graceful-close)、[Codexの累計加算契約](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)、[app-serverのusage型](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)。
