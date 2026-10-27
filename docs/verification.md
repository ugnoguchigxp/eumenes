# 検証とログ

README の「検証」の詳細です。

運用ログは Pino の JSONL 形式で `data/logs/api.jsonl` に保存します。`bun run logs -- --level warn` で警告・エラー、`bun run logs -- --id <run-id> --json` で処理ごとの記録、`bun run logs -- --follow` で追加分を確認できます。正常系は主要処理の開始・終了だけを残し、成功したGETや音声の細かな経過は `EUMENES_LOG_LEVEL=debug` で出します。保存先・世代管理・相関IDの使い方は [ログの確認](logging.md) を参照してください。

`verify` は対象 domain と型依存閉包を表示し、静的検査と domain 試験を実行します。静的検査（境界、system-context、サイズ、SQL境界、domain表、format、lint、型）は domain を指定しても常にリポジトリ全体に対して実行します（2026-10-27）。選んだ domain の所有パス・domain に属する違反は失敗にします。それ以外（他の domain、`api/application`・`web/src/workspace`・`client`・`cli`・`scripts` などどの domain にも属さない共有ファイル、生成物）の違反は失敗にせず、段階ごとに件数と先頭10件を警告として表示し、全件を report の `steps[].warnings` に残します。並行作業の途中の違反で他の検証を止めないためです。`verify:all` ではすべての違反が失敗です。各ツールが出す件数（型の `Found N errors`、lint の `N problems`、format の件数）と読み取れた違反の数が合わない場合、差の分はリポジトリ全体の違反として失敗にし、読み取れない失敗を見落としません。変更したdomainと影響のある利用側domainを選んで確認します。横断変更を理由に `verify:all` を必須とはしません。`verify:all` は全体の境界・文書整合・型・単体／API結合試験、DesignSystem、Web buildを実行し、ブラウザE2Eを含みません。検証結果と入力 hash は `verification-reports/runs/<runId>/report.json` に保存し、`verification-reports/latest.json` から直近の結果を参照できます。

`verification-reports/` はローカルの作業記録で、リポジトリに入れません。残す証跡は `spec/verification/` に置きます。

複数domainは `bun run verify -- --domain ocr --domain google-accounts` のように繰り返し指定します。所有パスと試験ファイルは重複排除されます。試験だけなら `bun run test:domain -- --domain ocr --domain google-accounts` を使えます。従来の `bun run test:domain -- ocr` と `bun run test:domain -- <domain> <subdomain>` も維持しています。依存閉包の表示は利用側domainの自動選択ではありません。影響のある利用側は引き続き明示してください。

検証順序は境界・サイズ等の確認、format、lint、DesignSystem通常型検査、DesignSystem build、rootの型検査（`bun check --no-pretty --all`、全体）、試験です。全件では最後にWeb buildを行い、続けて `scripts/bundle-budget.ts` で初期JS（entryと起動時に読むchunk）のgzipサイズを `scripts/bundle-budget.json` の記録値と比べます。2%を超えて増えると失敗し、5%を超えて減った場合は `--write` で記録を更新します。DesignSystemは再ビルドしません。DS通常型検査は試験・storiesを含み、build用型検査はこれらを除外するため両方必要です。DSソースはDS専用設定で検査し、root設定へ混在させません。キャッシュstampを検証合格の根拠にせず、毎回buildします。`test:domain` 単独は試験の実行のみで、この準備・整合確認を含みません。

DesignSystemの `dist` は共有です。`verify` の実行中は開発サーバー・ブラウザ試験・別のbuildを重ねないでください。検証同士はlockで排他しますが、他の利用者までlockするものではありません。build直後と全consumer終了時の出力パス・内容のhashを比較し、変更・欠落・読み取り失敗があれば結果を無効にします。前後で元に戻る一時的な変更や、他プロセスへの影響は検出・防止できません。snapshotによる隔離は後続段階です。

各実行には対象、基準commit、前後の入力hash、Bun・OS・runner、工程ごとの時間と状態、停止理由、DS出力hashを保存します。`pass`、`fail`、`interrupted`、`invalidated` を区別し、到達しなかった工程は `not_run` です。実行中は `running` を保存するため、強制終了やホスト停止で残った記録を合格として扱えません。SIGINT/SIGTERMでは実行中の子プロセス群を停止して記録を確定します。CI（GitHub Actions の `verify`）は手動で起動したときだけ動き、push と PR では動きません（2026-10-27）。起動した場合は成功・失敗の両方でレポートと準備時間をartifactへ保存します。手元の過去レポートは自動削除せず、CIの保持期間は7日です。

`bun run test:inventory` はrunner/projectごとの試験・生成元・別実行経路をJSONで出力します。`verify:all` には自然言語受入のjudge・frozen・tester-parser・runnerの4本を追加しています。runnerはfakeDriverを注入する試験です。Chromiumを起動するdriverは `bun test tests/acceptance/nl/driver.test.ts` の明示実行に残します。DSの `unit` は全件検証と所有domainの選択実行に含め、storiesから生成する `storybook` projectは初回CIから除外します。別途実行する場合はブラウザを準備し、`cd packages/design-system && bun x vitest run --project storybook src/components/GoogleAccounts/GoogleAccounts.stories.tsx` のようにstoryを明示してください。独立したOAuth試験の `.test.mjs` も棚卸しに含め、従来のBun全件実行範囲を維持します。runner設定や生成元のpatternを変えるときは棚卸しも更新します。

`bun run verify:metrics` は実行レポートから成功時間、失敗・割り込み・無効化の件数を集計し、直近60コミットの所有パスの参考値も出力します。全件合格の記録があれば、同じ必須検証をstatic・backend・Web/client・DS・Web buildに分けた場合の理想的な下限時間とrunner時間合計を計算します。各jobでDS buildを繰り返す費用は含みますが、install/postinstall・待ち時間・artifact転送・集約の費用は含まないため、CIの実測値とは区別します。CIの準備時間は `preparation.json` に保存します。履歴の所有率は現在の対応表による参考値であり、速度改善率でも変更影響の選択率でもありません。初回は `--affected` を導入せず、CIは各push/PRで全件を継続します。

ブラウザE2Eは、対象domainの試験ファイルを明示して個別に実行します。たとえばExcalidrawは `bunx playwright test tests/browser/excalidraw.spec.ts` です。複数domainに関係する変更は、影響のあるdomainのファイルを選びます。試験ファイルを指定しない全件実行は通常の検証手順に含めません。`CI=1` で実行する場合は `--fail-on-flaky-tests` も指定し、再試行でのみ成功した試験を合格にしません。

`verify:live` は明示した LARM への ASR・LLM・TTS 個別疎通であり、ブラウザと実機器を使う循環受入ではありません。

型チェックは Bun 1.4.4 の `bun check` を使います。root、DesignSystem、dots MVP と domain ごとの検査は、それぞれの tsconfig を使います。DesignSystem の build 前検査も `bun check -p tsconfig.build.json` です。root と DesignSystem の `typescript` は 7.0.2、Vite は 8.3.5 に揃えています。Bun は型宣言を出力しないため、`vite-plugin-dts` 5.1.2 による `.d.ts` 生成を残します。

TypeScript 7.0 は従来の JavaScript Compiler API を提供しません。境界・SQL・サイズ検査と試験棚卸しの4本は、公式の `@typescript/typescript6` 互換パッケージを使います。型宣言生成も同じ互換APIを使い、API Extractor が読む標準ライブラリの場所を `getDefaultLibFilePath` から解決します。API Extractor 内部には TypeScript 5.9.3 が残ります。`@types/bun` などの型定義も引き続き必要です。Vite 8.3.5 は利用者が指定した公開後7日未満の版のため、`bunfig.toml` の待機ルールでは Vite だけを例外に追加しています。

仕様と制約は [Bun 1.4.4 リリースノート](https://bun.sh/blog/bun-v1.4.4) と [型チェックの公式ドキュメント](https://bun.sh/docs/runtime/check) を参照してください。Bun の型チェックは TypeScript 7 に対応するため、TypeScript 5 と診断が異なる場合があります。CSS の副作用 import は各 workspace の `styles` export に型宣言を付け、DesignSystem の path alias は `baseUrl` を使わず相対パスで指定しています。

コマンドの一覧は README の「検証」を参照してください。fixture、live、実機器受入の結果は分けて記録します。

## 現在の限界の詳細

実マイク・ヘッドホンでの3往復と再生中割込みの受入、機器ごとの権限・echo、CLI の中断のプロセス試験を残しています。接続不能と引数不正はfixtureのプロセス試験で確認済みです。発話ごとの音声は最大4 MB に制限し、backend は受信 stream を読みながら上限を検査します。sequence と発話 ID で順序・再送を検査します。録音中の逐次 ASR は未実装です。LARM の実接続は合成音声を入力として個別操作を確認しました。受入項目は [docs/acceptance.md](acceptance.md)、SAAA 参照元と教訓は [docs/saaa-provenance.md](saaa-provenance.md) に記録しています。

RAG、経験再利用、Tauri、native AEC は後続構想です。[SAAA 全体コンセプト](https://chatgpt.com/space/page_9fc5877949748191b556705128f6a2f5) を継承先として扱い、この初版では先行実装していません。
