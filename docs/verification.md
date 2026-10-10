# 検証とログ

README の「検証」の詳細です。

運用ログは Pino の JSONL 形式で `data/logs/api.jsonl` に保存します。`bun run logs -- --level warn` で警告・エラー、`bun run logs -- --id <run-id> --json` で処理ごとの記録、`bun run logs -- --follow` で追加分を確認できます。正常系は主要処理の開始・終了だけを残し、成功したGETや音声の細かな経過は `EUMENES_LOG_LEVEL=debug` で出します。保存先・世代管理・相関IDの使い方は [ログの確認](logging.md) を参照してください。

`verify` は対象 domain と型依存閉包を表示し、format、lint、型、境界、domain 試験を実行します。`verify:all` は全 TypeScript、保存・画面 build、ブラウザ fixture を含みます。`verify:live` は明示した LARM への ASR・LLM・TTS 個別疎通であり、ブラウザと実機器を使う循環受入ではありません。検証結果と入力 hash は `verification-reports/latest.json` に出力されます。

コマンドの一覧は README の「検証」を参照してください。fixture、live、実機器受入の結果は分けて記録します。

## 現在の限界の詳細

実マイク・ヘッドホンでの3往復と再生中割込みの受入、機器ごとの権限・echo、CLI の中断のプロセス試験を残しています。接続不能と引数不正はfixtureのプロセス試験で確認済みです。発話ごとの音声は最大4 MB に制限し、backend は受信 stream を読みながら上限を検査します。sequence と発話 ID で順序・再送を検査します。録音中の逐次 ASR は未実装です。LARM の実接続は合成音声を入力として個別操作を確認しました。受入項目は [docs/acceptance.md](acceptance.md)、SAAA 参照元と教訓は [docs/saaa-provenance.md](saaa-provenance.md) に記録しています。

RAG、経験再利用、Tauri、native AEC は後続構想です。[SAAA 全体コンセプト](https://chatgpt.com/space/page_9fc5877949748191b556705128f6a2f5) を継承先として扱い、この初版では先行実装していません。
