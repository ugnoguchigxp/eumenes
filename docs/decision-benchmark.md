# 判断モデルのベンチマーク

製品の判断処理と独立したPython Scriptで、Laya等を同じ日本語データで測定できます。`bun run decision:bench validate`で同梱データを確認し、`bun run decision:bench:check`でモデル不要の自己検証を行います。`run`で確率・時間・資源量を保存し、`score`でモデルを再実行せず閾値や表情遷移を比較します。結果はGit対象外の`verification-reports/decision-bench/`へ保存します。

実機での実行、校正、モデルadapter、出力の読み方は[判断モデルのベンチマーク](../scripts/decision-bench/README.md)を参照してください。通常の評価と集計はPython標準ライブラリで動き、モデルを直接ロードする場合だけ評価専用のライブラリ環境が必要です。

GemmaのRuri発話態度判定は、実会話の異なる成功判定300件を専用DBへ収集できます。`bun run cli -- collection start`で開始し、`status`で収集・未レビュー・確認済み件数を確認、`stop`で停止します。初回の予測を隠した人手レビューと、会話・類似テンプレートを分けないtrain/calibration/evalのJSONL出力に対応しています。[収集・レビュー・exportの手順](ruri-collection.md)と[互換性の検証記録](ruri-verification.md)を参照してください。会話本文はGit管理外に保存します。
