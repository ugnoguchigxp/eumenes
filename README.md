# Eumenes

TypeScript、Bun、Hono、React、SQLite によるローカル音声対話の初期実装です。ブラウザのマイク入力を LARM の ASR・LLM・TTS につなぎ、回答をブラウザで再生します。文字入力と CLI も同じ backend と実行台帳を使います。

## 起動

1. `bun install`
2. 必要に応じて `.env.example` を `.env` にコピーします。`LARM_API_TOKEN` が export 済みなら追加のトークン設定は不要です。backend・開発サーバー・CLI は同じ環境変数を引き継ぐシェルから起動してください。`EUMENES_API_TOKEN` は空欄のままにでき、ローカル API 用の認証値を LARM トークンから用途を分けて生成します。明示的に指定する場合は24文字以上にします。同じ `.env` を backend と Vite が読み、Vite のローカル proxy が API 認証を付けます。ブラウザには token を渡しません。LARM は `http://192.168.0.130:9810` の `SAAA-gemma4-26b` を既定値とし、同じ Linux ホストから使う場合は URL を `http://127.0.0.1:9810`、`LARM_AUDIENCE` を `same-host` にします。LARM 認証は SAAA と共通の `LARM_API_TOKEN` を優先し、未指定なら `LARM_CONTROL_TOKEN` を使います。TTS の voice が LARM の claim に含まれない場合は `EUMENES_TTS_VOICE` を設定します。秘密をリポジトリへコピーしないでください。
3. 別々のターミナルで `bun run start` と `bun run dev` を実行します。
4. `http://127.0.0.1:5173` を開くと会話欄に入ります。「音声を開始」でマイクを許可し、日本語で話します。「停止」で録音と再生を終了します。再生中の次の発話は前の再生を割り込みます。

backend は `127.0.0.1:8787` のみで待ち受けます。Chrome/Chromium の Playwright fixture で画面・音声経路を確認しています。実マイク・ヘッドホンによる3往復の受入は未実施です。

LARM 接続では毎回接続状態を API で確認し、claim が返した `configuration.fields.baseURL`、`configuration.fields.model`、`credential.token` を使用します。LLM のみなら `providers: ["llm"]`、音声を使う場合は `providers` を省略して Profile 全体を要求します。期限前の renew 後は再claimで token を更新し、終了時に接続を解放します。メインの入力予算は 256072 token、出力上限は 4096 token です。4 セッション構成の目標は、同じ 512K のランタイムを共有するメイン 256K × 1 と補助 64K × 3 です。補助の入力予算は各 59464 token とし、利用側でセッション数と予算を管理します。補助 selector `SAAA-gemma4-26b-64k` は 2026-10-08 時点で catalog が 404 を返すため、コードからも接続を禁止しています。配備後に catalog を確認し、補助の管理処理を実装してから有効化します。

DesignSystem は `packages/design-system` にソースとビルド設定を持つ workspace package です。元の `main` から取り込み、Eumenes 内では `@eumenes/design-system` として管理します。`bun run build:design-system` で再ビルドでき、元の MIT ライセンスを同梱しています。

## CLI

backend を先に起動し、同じ認証環境（`LARM_API_TOKEN`、明示指定時は `EUMENES_API_TOKEN`）を持つシェルから実行します。通常の CLI 操作は backend や DB writer を起動しません。

```sh
bun cli/index.ts status --json
bun cli/index.ts send 'こんにちは' --wait --json
bun cli/index.ts history main --json
bun cli/index.ts run <run-id> --json
bun cli/index.ts cancel <run-id> --json
```

`send` は標準入力も読めます。応答が不明な送信には、表示された request ID を `--request-id <UUID>` に指定して同じ要求を照会・再試行できます。`--json` の結果は stdout、診断は stderr です。終了コードは成功 `0`、引数・認証 `2`、処理失敗 `3`、取消・待機結果不明 `4`、接続不能 `5` です。

## 音声 MVP の所有境界

| 領域 | 所有する処理 | 依存 |
| --- | --- | --- |
| `conversation` | 確定メッセージと会話 revision | なし |
| `continuity` | ユーザーが選んだ発言のしおり、訂正・無効化・出典確認 | conversation |
| `larm` | Profile 発見、Connection、claim、lease、ASR・LLM・TTS | なし |
| `audio` | ブラウザ録音、発話検出、WAV 化、再生 | なし |
| `queue` | 有界ジョブ、資源枠、取消と復旧 | なし |
| `scheduler` | 時刻指定の起動と定期起動 | queue |
| `dialogue` | 入力受付、LLM、回答採用、取消、復旧 | conversation、larm、queue、scheduler |
| `voice-dialogue` | 発話から再生までの状態と割込み | audio、dialogue、larm |

domain の公開入口と試験は [docs/domains.md](docs/domains.md) にあります。SQLite の writer は backend の単一プロセスが所有し、起動前の OS lock、直列 write queue、WAL、読み取り専用 lane を使います。Web・CLI は API のみからアクセスします。TanStack Query は backend の履歴・run 状態を表示する cache、Zustand はブラウザ音声の一時状態です。音声ファイルは既定で保存しません。

## 検証

```sh
bun run verify -- --domain conversation
bun run verify -- --domain audio
bun run verify -- --domain voice-dialogue
bun run test:domain -- conversation
bun run verify:all
LARM_BASE_URL=... EUMENES_LIVE_ASR_WAV=/absolute/path/speech.wav EUMENES_LIVE_EXPECT_TEXT=こんにちは bun run verify:live -- --domain larm
```

`verify` は対象 domain と型依存閉包を表示し、format、lint、型、境界、domain 試験を実行します。`verify:all` は全 TypeScript、保存・画面 build、ブラウザ fixture を含みます。`verify:live` は明示した LARM への ASR・LLM・TTS 個別疎通であり、ブラウザと実機器を使う循環受入ではありません。検証結果と入力 hash は `verification-reports/latest.json` に出力されます。

## 現在の限界と次の工程

画面の「継続情報」では、ユーザー発言を選んでしおりを保存・訂正・無効化できます。しおりを自動で回答へ注入する機能はまだありません。

実マイク・ヘッドホンでの3往復と再生中割込みの受入、機器ごとの権限・echo、CLI の中断・接続不能のプロセス試験を残しています。発話ごとの音声は最大4 MB に制限し、backend は受信 stream を読みながら上限を検査します。sequence と発話 ID で順序・再送を検査します。録音中の逐次 ASR は未実装です。LARM の実接続は合成音声を入力として個別操作を確認しました。受入項目は [docs/acceptance.md](docs/acceptance.md)、SAAA 参照元と教訓は [docs/saaa-provenance.md](docs/saaa-provenance.md) に記録しています。

RAG、個人記憶、ToolChain、経験再利用、Tauri、native AEC は後続構想です。[SAAA 全体コンセプト](https://chatgpt.com/space/page_9fc5877949748191b556705128f6a2f5) を継承先として扱い、この初版では先行実装していません。
