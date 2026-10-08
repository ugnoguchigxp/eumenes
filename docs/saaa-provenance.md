# SAAA 参照元と教訓

参照時点: 2026-10-07。SAAA HEAD `28616e61ce5fe853383d4af6ec14e5b5d542c076`。下記の採用ファイルは参照時に HEAD との差分なし。SAAA checkout、製品 DB、設定、資格情報は変更・コピーしていません。LARM 接続先は製品 DB の `providers.model/default` を読み取り専用で確認し、秘密は既存の `LARM_API_TOKEN` 環境変数から実行時に渡しました。

| 採用対象 | SAAA の参照元 | SHA-256 | Eumenes での対応 |
| --- | --- | --- | --- |
| 音声活動検出 | `src/lib/voiceActivity.ts` | `93f77ccf8d05d422d3b1b9868814a9b18419f4c505facfaed8555f0aaf9b787d` | `web/src/domains/audio/controller/voice-activity.ts` に移植。700ms の無音確定と10秒上限、録音前置 buffer を Eumenes で設定 |
| Agent Connection 契約 | `docs/larm-agent-connection-provide.md` | `b70f9a34d1c73828aec26e006f8e9a3691639140539b99a035a69073d154bbe2` | Profile、revision、作成、claim、lease、解放を `larm` が所有 |
| catalog と claim | `crates/larm-session/src/catalog.rs`、`contract.rs`、`lib.rs`、`http_api.rs` | 順に `cbc916f751aff2d663137af01f1d86ea7f7baf177c23e90019ede6f5a0cc8599`、`37a59fba641ed509e9f9d5cb9c686e8fcc9256b0c62572aeb89a7e7f418bf4f3`、`74263b9af3f5c25df35292f1ce9701e0553fca152839170c73732f653b0742a1`、`e30e47d7b80f8388478f5dfb8b6e58948f836c507bf3b67c7a4777e6cc81322a` | 公開契約の重要条件を TypeScript の adapter と契約試験へ対応付け |
| ASR multipart | `src-tauri/src/voice/cloud_asr.rs` | `c790de9d13efb94e31b7f42809aee4d4c96452148b9baae26afd519949138bd5` | `file`、`model`、`response_format=json` を送信する試験を追加 |
| TTS voice | `src-tauri/src/providers/larm_resources/audio.rs` | `7932c0ba10875b5f7def19bcd768b80c3d63a76e148bca0de9326ebdc7329c29` | claim の voice または明示 `EUMENES_TTS_VOICE` が必要。無根拠の default を送らない |
| 資格情報の所在 | `src-tauri/src/providers/dynamic_lan/credential.rs` | `11f39fa816b91daf5712dae24e59dc1cef55c47235d1c2d8e382f177667150c6` | Eumenes は `LARM_CONTROL_TOKEN` または環境変数 `LARM_API_TOKEN` を読む。ファイルの資格情報はコピーしない |

`hono-standard` の基盤は保存済み `variant/sqlite` の commit `dd266a43684c3ca5f4012e89b9f71edf8da78a83` から依存・設定を選んだ。元 checkout を切り替えず変更していない。

| SAAA の発生事象・確認できた原因 | 対策の所有者 | 回帰・受入 |
| --- | --- | --- |
| test filter だけでは全体の型依存を縮められない | `scripts/verify.ts` と domain 公開入口 | domain ごとに TypeScript が読んだ workspace closure を表示 |
| mock の状態が次の試験へ漏れた | 各 domain test | clock、通信、store を試験ごとに生成・回収し、単独と全件を確認 |
| 古い計画と現実の検証結果が食い違った | `scripts/verify.ts` | 実行前後の入力 hash を比較し、変化した run を成功扱いしない |
| 部品が存在しても利用側まで接続されなかった | `voice-dialogue` と browser fixture | 実 controller、service、SQLite、画面を接続した受入を実行 |
| 全体 gate の失敗と checkpoint の判断が混同された | 作業運用 | 依頼された checkpoint は検証結果と限界を併記する。今回は commit・push を行わない |

2026-10-08 逐次音声処理の参照: HEAD は引き続き `28616e61ce5fe853383d4af6ec14e5b5d542c076`。今回も参照専用で、SAAA の設定・製品DB・秘密はコピーしていない。

| 参照元 | SHA-256 | Eumenesでの対応 |
| --- | --- | --- |
| `src-tauri/src/voice/streaming_asr/batch_engine.rs` | `2bc260b1c4430dd0e18119fac6d5bb519a6e4dc66381ff57fc46b91820ea623b` | batch方式の契約を参考に、1.8秒の録音prefixから認識し、以後600msごとの最新1件を保持。確定入力が途中認識を取り消す。途中の仮説を会話履歴へ採用しない |
| `src-tauri/src/voice/streaming_tts/chunker/select_reason.rs` | `faa42e4fb24cd70f287968c88b6e8bd5a6cf2213f14cab297a87c158136e1735` | providerのtoken境界と独立して句読点で分割。小数の途中を切らず、240文字の長文上限と確定時の末尾処理を行う。今回はユーザーの指定に合わせ読点でも直ちに合成する |
| `src-tauri/tests/tts_streaming_contract.rs` | `400d6590c796843be6bbd9cf0edfe89eb9eb8128b718e3527412934860d7022e` | LLM完了前の最初の区切り、任意のtoken分割、途中の取消しを契約試験と実ブラウザで確認。未再生・合成中を含め最大3区切りまで先行する |

LLMの途中表示は状態更新通知とは別の認証付きSSEで配信する。途中の本文は確定した履歴と分け、再接続時は最新のsnapshotから再開。失敗・取消しでは途中表示を消し、既に出した文字にクラウドの別回答を継ぎ足さない。TTSの各区切りは元の設定snapshotとASR/LLMの依存関係を使い、取消し・権限取消し後の音声を公開しない。
