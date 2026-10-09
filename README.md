# Eumenes

TypeScript、Bun、Hono、React、SQLite によるローカル音声対話の初期実装です。ブラウザのマイク入力を LARM の ASR・LLM・TTS につなぎ、回答をブラウザで再生します。文字入力と CLI も同じ backend と実行台帳を使います。

## 起動

1. `bun install`
2. 必要に応じて `.env.example` を `.env` にコピーします。`LARM_API_TOKEN` が export 済みなら追加のトークン設定は不要です。backend・開発サーバー・CLI は同じ環境変数を引き継ぐシェルから起動してください。`EUMENES_API_TOKEN` は空欄のままにでき、ローカル API 用の認証値を LARM トークンから用途を分けて生成します。明示的に指定する場合は24文字以上にします。同じ `.env` を backend と Vite が読み、Vite のローカル proxy が API 認証を付けます。ブラウザには token を渡しません。LARM は `http://192.168.0.130:9810` の `SAAA-gemma4-26b` を既定値とし、同じ Linux ホストから使う場合は URL を `http://127.0.0.1:9810`、`LARM_AUDIENCE` を `same-host` にします。LARM 認証は SAAA と共通の `LARM_API_TOKEN` を優先し、未指定なら `LARM_CONTROL_TOKEN` を使います。TTS の声は「設定 → 音声」でキャラクター・発話スタイル・話す速さ・声の高さ・抑揚・音量を調整できます。声一覧と合成には claim した TTS Provider の baseUrl・model・token を使い、秘密をブラウザへ渡しません。VOICEVOXの自動選択では catalog の `default_voice` を使います。スタイル・高さ・抑揚は `voicevox-core` にだけ送信します。設定がまだない場合の voice 初期値は `EUMENES_TTS_VOICE` で、他モデルでは claim の voice または catalog の既定 voice を使います。秘密をリポジトリへコピーしないでください。
3. `bun run dev` を実行します。APIが起動してから画面用サーバーを起動し、Ctrl+Cで両方を終了します。既にAPIを起動している場合は、一度終了してから実行してください。個別に起動する場合は、別々のターミナルで `bun run start` と `bun run dev:web` を使えます。
4. `http://127.0.0.1:5173` を開くと会話欄に入ります。「音声を開始」でマイクを許可し、日本語で話します。「停止」で録音と再生を終了します。再生中の次の発話は前の再生を割り込みます。

backend は `127.0.0.1:8787` のみで待ち受けます。Chrome/Chromium の Playwright fixture で画面・音声経路を確認しています。実マイク・ヘッドホンによる3往復の受入は未実施です。

backend 起動時に LARM への接続を一度確認します。失敗時は画面に原因を表示し、「接続を再確認」から再試行できます。状態確認の GET は新しい接続を作りません。画面は認証付き SSE の接続を共有し、DB の保存確定と LARM の接続状態変化を受けて既存 API から最新状態を読み直します。会話・回答待ち・音声・設定・予約の定期取得はありません。変更通知は100ms単位でまとめ、15秒ごとの heartbeat は再取得を起こしません。接続や再接続のたびに最新状態を読み直すため、切断中の変更やサーバー再起動にも追いつきます。通知接続の失敗時は5秒から最大30秒まで再試行間隔を延ばし、401・403・404では自動再試行を停止します。回答は従来どおり確定後に表示し、音声再生の操作も変えていません。

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
| `larm` | Profile 発見、Connection、claim、lease、ASR・LLM・TTS | なし |
| `audio` | ブラウザ録音、発話検出、WAV 化、再生 | なし |
| `queue` | 有界ジョブ、資源枠、取消と復旧 | なし |
| `scheduler` | 時刻指定の起動と定期起動 | queue |
| `dialogue` | 入力受付、LLM、回答採用、取消、復旧 | conversation、larm、queue、scheduler |
| `voice-dialogue` | 発話から再生までの状態と割込み | audio、dialogue、larm |

domain の公開入口と試験は [docs/domains.md](docs/domains.md) にあります。SQLite の writer は backend の単一プロセスが所有し、起動前の OS lock、直列 write queue、WAL、読み取り専用 lane を使います。Web・CLI は API のみからアクセスします。TanStack Query は backend の履歴・run 状態を表示する cache、Zustand はブラウザ音声の一時状態です。音声ファイルは既定で保存しません。

## 検証

運用ログは Pino の JSONL 形式で `data/logs/api.jsonl` に保存します。`bun run logs -- --level warn` で警告・エラー、`bun run logs -- --id <run-id> --json` で処理ごとの記録、`bun run logs -- --follow` で追加分を確認できます。正常系は主要処理の開始・終了だけを残し、成功したGETや音声の細かな経過は `EUMENES_LOG_LEVEL=debug` で出します。保存先・世代管理・相関IDの使い方は [ログの確認](docs/logging.md) を参照してください。

```sh
bun run verify -- --domain conversation
bun run verify -- --domain audio
bun run verify -- --domain voice-dialogue
bun run test:domain -- conversation
bun run verify:all
LARM_BASE_URL=... EUMENES_LIVE_ASR_WAV=/absolute/path/speech.wav EUMENES_LIVE_EXPECT_TEXT=こんにちは bun run verify:live -- --domain larm
```

`verify` は対象 domain と型依存閉包を表示し、format、lint、型、境界、domain 試験を実行します。`verify:all` は全 TypeScript、保存・画面 build、ブラウザ fixture を含みます。`verify:live` は明示した LARM への ASR・LLM・TTS 個別疎通であり、ブラウザと実機器を使う循環受入ではありません。検証結果と入力 hash は `verification-reports/latest.json` に出力されます。

## 判断モデルのベンチマーク

製品の判断処理と独立したPython Scriptで、Laya等を同じ日本語データで測定できます。`bun run decision:bench validate`で同梱データを確認し、`bun run decision:bench:check`でモデル不要の自己検証を行います。`run`で確率・時間・資源量を保存し、`score`でモデルを再実行せず閾値や表情遷移を比較します。結果はGit対象外の`verification-reports/decision-bench/`へ保存します。

実機での実行、校正、モデルadapter、出力の読み方は[判断モデルのベンチマーク](scripts/decision-bench/README.md)を参照してください。通常の評価と集計はPython標準ライブラリで動き、モデルを直接ロードする場合だけ評価専用のライブラリ環境が必要です。

## 現在の限界と次の工程


実マイク・ヘッドホンでの3往復と再生中割込みの受入、機器ごとの権限・echo、CLI の中断のプロセス試験を残しています。接続不能と引数不正はfixtureのプロセス試験で確認済みです。発話ごとの音声は最大4 MB に制限し、backend は受信 stream を読みながら上限を検査します。sequence と発話 ID で順序・再送を検査します。録音中の逐次 ASR は未実装です。LARM の実接続は合成音声を入力として個別操作を確認しました。受入項目は [docs/acceptance.md](docs/acceptance.md)、SAAA 参照元と教訓は [docs/saaa-provenance.md](docs/saaa-provenance.md) に記録しています。

RAG、個人記憶、ToolChain、経験再利用、Tauri、native AEC は後続構想です。[SAAA 全体コンセプト](https://chatgpt.com/space/page_9fc5877949748191b556705128f6a2f5) を継承先として扱い、この初版では先行実装していません。


## 設定画面

右上の「設定」から、AIの使い方、接続先、音声、データと利用記録、予約、表示を変更できます。LARMを優先し、接続不能・混雑・時間切れの場合は用途ごとに登録したクラウドへ自動で切り替えます。クラウドの送信許可と自動切替は初期値で有効ですが、代替先が未登録ならクラウドには送信しません。認証エラーや契約不一致、取消では自動切替しません。

クラウドはOpenAI互換のChat Completions、multipart音声認識、WAV音声合成に対応します。接続名、ベースURL、モデルとAPIキーまたは環境変数名を登録し、「AIの使い方」で用途に割り当てて「変更を適用」を押します。一つの接続に複数の用途のモデルを追加できます。接続確認と少量の生成テストは保存済み設定を使い、サービスの利用が発生します。

LARMのURL・Profile・audience・voiceは初回起動時に環境変数から取り込み、以降は設定画面に保存した値を使います。URLが空欄の場合はbackend既定の接続先を使います。LARM認証とクラウドキーの環境変数はbackendだけで読みます。環境変数を変更した場合はbackendを再起動してください。

APIキーはAES-256-GCMで暗号化します。暗号鍵は32バイトをBase64にした `EUMENES_SECRET_KEY`、またはデータベースの隣の `keys/settings.key` を使います。未指定ならファイルを自動生成します。データベースと暗号鍵を一緒にバックアップしてください。既存の暗号文があるのに鍵が見つからない場合は再生成せず、保存済みキーによるクラウド利用を停止します。APIキーは設定取得や診断データに含めません。

送信許可の取消、キーの削除・更新、接続の無効化は実行中の結果にも反映します。読み上げの変更は次の発話、マイク・録音調整は次の音声開始から反映します。予約は一回と固定間隔に対応し、Eumenes起動中に実行します。予約の取消は今後の受付を停止し、受付済みの会話は実行記録から別途取り消します。

実装と検証の詳細は [設定画面の検証記録](spec/verification/settings/README.md) を参照してください。
