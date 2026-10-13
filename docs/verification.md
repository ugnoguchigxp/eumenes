# 検証とログ

README の「検証」の詳細です。

運用ログは Pino の JSONL 形式で `data/logs/api.jsonl` に保存します。`bun run logs -- --level warn` で警告・エラー、`bun run logs -- --id <run-id> --json` で処理ごとの記録、`bun run logs -- --follow` で追加分を確認できます。正常系は主要処理の開始・終了だけを残し、成功したGETや音声の細かな経過は `EUMENES_LOG_LEVEL=debug` で出します。保存先・世代管理・相関IDの使い方は [ログの確認](logging.md) を参照してください。

`verify` は対象 domain と型依存閉包を表示し、format、lint、型、境界、domain 試験を実行します。変更したdomainと影響のある利用側domainを選んで確認します。横断変更を理由に `verify:all` を必須とはしません。`verify:all` は全体の境界・文書整合・型・単体／API結合試験、DesignSystem、Web buildを実行し、ブラウザE2Eを含みません。検証結果と入力 hash は `verification-reports/latest.json` に出力されます。

ブラウザE2Eは、対象domainの試験ファイルを明示して個別に実行します。たとえばExcalidrawは `bunx playwright test tests/browser/excalidraw.spec.ts` です。複数domainに関係する変更は、影響のあるdomainのファイルを選びます。試験ファイルを指定しない全件実行は通常の検証手順に含めません。`CI=1` で実行する場合は `--fail-on-flaky-tests` も指定し、再試行でのみ成功した試験を合格にしません。

`verify:live` は明示した LARM への ASR・LLM・TTS 個別疎通であり、ブラウザと実機器を使う循環受入ではありません。

型チェックは Bun 1.4.3 の `bun check` を使います。root、DesignSystem、dots MVP と domain ごとの検査は、従来と同じ tsconfig・対象範囲で実行します。DesignSystem の build 前検査も `bun check -p tsconfig.build.json` です。Bun は型宣言を出力しないため、`vite-plugin-dts` による `.d.ts` 生成と、それが使う TypeScript 依存を残します。root の TypeScript 依存も境界・SQL・サイズ検査の Compiler API に必要です。`@types/bun` などの型定義も引き続き必要です。

仕様と制約は [Bun 1.4.3 リリースノート](https://bun.sh/blog/bun-v1.4.3) と [型チェックの公式ドキュメント](https://bun.sh/docs/runtime/check) を参照してください。Bun の型チェックは TypeScript 7 に対応するため、TypeScript 5 と診断が異なる場合があります。CSS の副作用 import は各 workspace の `styles` export に型宣言を付け、DesignSystem の path alias は `baseUrl` を使わず相対パスで指定しています。

コマンドの一覧は README の「検証」を参照してください。fixture、live、実機器受入の結果は分けて記録します。

## 現在の限界の詳細

実マイク・ヘッドホンでの3往復と再生中割込みの受入、機器ごとの権限・echo、CLI の中断のプロセス試験を残しています。接続不能と引数不正はfixtureのプロセス試験で確認済みです。発話ごとの音声は最大4 MB に制限し、backend は受信 stream を読みながら上限を検査します。sequence と発話 ID で順序・再送を検査します。録音中の逐次 ASR は未実装です。LARM の実接続は合成音声を入力として個別操作を確認しました。受入項目は [docs/acceptance.md](acceptance.md)、SAAA 参照元と教訓は [docs/saaa-provenance.md](saaa-provenance.md) に記録しています。

ASR 言語判定は LLM による補助判定で、発話内容による誘導を完全には防げない。迂回された場合も発話は通常の会話入力として扱われ、権限は増えない(受容リスク、2026-10-10)。

RAG、経験再利用、Tauri、native AEC は後続構想です。[SAAA 全体コンセプト](https://chatgpt.com/space/page_9fc5877949748191b556705128f6a2f5) を継承先として扱い、この初版では先行実装していません。
