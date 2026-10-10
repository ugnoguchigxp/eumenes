# Eumenes

TypeScript、Bun、Hono、React、SQLite によるローカル音声対話の初期実装です。ブラウザのマイク入力を LARM の ASR・LLM・TTS につなぎ、回答をブラウザで再生します。文字入力と CLI も同じ backend と実行台帳を使います。

## クイックスタート

1. `bun install`
2. 必要に応じて `.env.example` を `.env` にコピーし、`LARM_API_TOKEN` を設定します（export 済みでもよい）。LARMの接続先は「設定 → 接続」で保存し、SQLite内の設定を使います。`EUMENES_API_TOKEN` は空欄なら初回起動時に自動生成されます。
3. `bun run dev` で API と画面用サーバーを起動します(Ctrl+C で両方終了)。個別に起動する場合は `bun run start` と `bun run dev:web` を使います。
4. `http://127.0.0.1:5173` を開き、「音声を開始」でマイクを許可して日本語で話します。「停止」で録音と再生を終了します。

token・LARM・TTS・VOICEVOX の詳細は [docs/setup.md](docs/setup.md) を参照してください。

## CLI

backend を先に起動し、同じ認証環境（`LARM_API_TOKEN`、明示指定時は `EUMENES_API_TOKEN`）を持つシェルから実行します。通常の CLI 操作は backend や DB writer を起動しません。

```sh
bun cli/index.ts status --json
bun cli/index.ts send 'こんにちは' --wait --json
bun cli/index.ts history main --json
bun cli/index.ts run <run-id> --json
bun cli/index.ts cancel <run-id> --json
bun cli/index.ts web search 'Bun SQLite' --read-pages --wait --json
bun cli/index.ts web read https://example.com/ --wait --json
bun cli/index.ts web read https://example.com/ --stable --wait --json
bun cli/index.ts capabilities --json
bun cli/index.ts task <agent-task-id> --json
bun cli/index.ts task-report <agent-task-id> --json
bun cli/index.ts task-cancel <agent-task-id> --json
bun cli/index.ts web cache --json
bun cli/index.ts web clear --json
```

`send` は標準入力も読めます。応答が不明な送信には、表示された request ID を `--request-id <UUID>` に指定して同じ要求を照会・再試行できます。`--json` の結果は stdout、診断は stderr です。終了コードは成功 `0`、引数・認証 `2`、処理失敗 `3`、取消・待機結果不明 `4`、接続不能 `5` です。

Web 取得の詳細は [docs/web-research.md](docs/web-research.md)、会話からの調査は [docs/toolchain.md](docs/toolchain.md)、取得先と手順の学習は [docs/research-routes.md](docs/research-routes.md) を参照してください。

## 検証

```sh
bun run verify -- --domain conversation
bun run verify -- --domain audio
bun run verify -- --domain voice-dialogue
bun run test:domain -- conversation
bun run verify:all
EUMENES_LIVE_ASR_WAV=/absolute/path/speech.wav EUMENES_LIVE_EXPECT_TEXT=こんにちは bun run verify:live -- --domain larm
```

- `bun run verify -- --domain <name>` は対象 domain と型依存閉包の format、lint、型、境界、domain 試験を実行します。`verify:all` は全 TypeScript、保存・画面 build、ブラウザ fixture を含みます。
- `verify:live` は明示した LARM への ASR・LLM・TTS 個別疎通であり、ブラウザと実機器を使う循環受入ではありません。fixture、live、実機器受入の結果は分けて記録します。
- 障害調査は `bun run logs -- --level warn` から始めます。
- 詳細は [docs/verification.md](docs/verification.md) と [docs/logging.md](docs/logging.md) を参照してください。

## 現在の限界

- 実マイク・ヘッドホンによる3往復と再生中割込みの受入は **未実施** です。音声 MVP は完成と宣言していません。fixture 検証(Chrome/Chromium の Playwright)で画面・音声経路を確認している段階です。
- 機器ごとの権限・echo、CLI の中断のプロセス試験を残しています。録音中の逐次 ASR は未実装です。
- LARM の実接続は合成音声を入力とした個別操作の確認までです。補助セッション(`SAAA-gemma4-26b-64k`)は catalog 確認後まで接続を禁止しています。
- RAG、経験再利用、Tauri、native AEC は後続構想です。

受入項目は [docs/acceptance.md](docs/acceptance.md)、限界の詳細と SAAA 参照元は [docs/verification.md](docs/verification.md#現在の限界の詳細) と [docs/saaa-provenance.md](docs/saaa-provenance.md) に記録しています。

## ドキュメント

[docs/README.md](docs/README.md) に docs の索引があります。主な入口は次のとおりです。

- [docs/domains.md](docs/domains.md): domain の一覧・依存・公開入口(自動生成)と所有境界
- [docs/setup.md](docs/setup.md): 起動の詳細
- [docs/settings.md](docs/settings.md): 設定画面
- [docs/realtime.md](docs/realtime.md): 通知(SSE)と再接続
- [spec/README.md](spec/README.md): 計画書・設計書の索引
