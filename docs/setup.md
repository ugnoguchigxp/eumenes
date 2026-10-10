# 起動の詳細

README のクイックスタートの補足です。トークン、LARM、TTS、VOICEVOX の設定と、起動後の動作を記載します。

## 手順

1. `bun install`
2. 環境変数: 必要に応じて `.env.example` を `.env` にコピーします。`LARM_API_TOKEN` が export 済みなら追加のトークン設定は不要です。backend・開発サーバー・CLI は同じ環境変数を引き継ぐシェルから起動してください。`EUMENES_API_TOKEN` は空欄のままにでき、空欄なら初回起動時に `data/keys/api.token`（0600。`EUMENES_KEY_DIR` 指定時はその配下）へ乱数で生成し、backend・Vite・CLI が共有します（LARM トークンからは導出しません）。明示的に指定する場合は24文字以上にします。同じ `.env` を backend と Vite が読み、Vite のローカル proxy が API 認証を付けます。ブラウザには token を渡しません。LARMの接続先は「設定 → 接続」で登録し、SQLiteに保存します。既存の保存済み接続先はそのまま使います。未登録の間、LARMは未設定扱いで接続を試みません。既定の profile は `SAAA-gemma4-26b` です。claim で返る Provider の host は LARM と同じ host に限定されます。別の host を許可する場合は `EUMENES_LARM_PROVIDER_HOSTS` にカンマ区切りで列挙します。LARM token は LAN 上を平文で流れるため、信頼できる LAN でのみ使用してください。同じLinuxホストから使う場合は、設定画面で接続先を `http://127.0.0.1:9810`、audienceを `same-host` にします。LARM 認証は SAAA と共通の `LARM_API_TOKEN` を優先し、未指定なら `LARM_CONTROL_TOKEN` を使います。TTS の声は「設定 → 音声」でキャラクター・発話スタイル・話す速さ・声の高さ・抑揚・音量を調整できます。声一覧と合成には claim した TTS Provider の baseUrl・model・token を使い、秘密をブラウザへ渡しません。VOICEVOXの自動選択では catalog の `default_voice` を使います。スタイル・高さ・抑揚は `voicevox-core` にだけ送信します。設定がまだない場合の voice 初期値は `EUMENES_TTS_VOICE` で、他モデルでは claim の voice または catalog の既定 voice を使います。秘密をリポジトリへコピーしないでください。
3. `bun run dev` を実行します。APIが起動してから画面用サーバーを起動し、Ctrl+Cで両方を終了します。既にAPIを起動している場合は、一度終了してから実行してください。個別に起動する場合は、別々のターミナルで `bun run start` と `bun run dev:web` を使えます。
4. `http://127.0.0.1:5173` を開くと会話欄に入ります。「音声を開始」でマイクを許可し、日本語で話します。「停止」で録音と再生を終了します。再生中の次の発話は前の再生を割り込みます。

## 待受と受入状況

backend は `127.0.0.1:8787` のみで待ち受けます。Chrome/Chromium の Playwright fixture で画面・音声経路を確認しています。実マイク・ヘッドホンによる3往復の受入は未実施です。

## DesignSystem

DesignSystem は `packages/design-system` にソースとビルド設定を持つ workspace package です。元の `main` から取り込み、Eumenes 内では `@eumenes/design-system` として管理します。`bun run build:design-system` で再ビルドでき、元の MIT ライセンスを同梱しています。

関連: LARM の接続と予算は [larm.md](larm.md)、画面からの設定は [settings.md](settings.md)、通知と再接続は [realtime.md](realtime.md)。

実推論の検証もSQLiteに保存されたLARM接続設定を読み取ります。`EUMENES_DB` を指定した場合はそのDB、未指定なら `./data/eumenes.sqlite3` が対象です。backend側の読み取り専用操作で接続設定だけを取得し、製品DBのmigration・設定変更は行いません。認証情報はbackend内に留めます。
