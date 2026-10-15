# Workers AIの音声接続設定（2026-10-16）

状態: Account ID・APIトークンの登録、catalogからのASR/TTS選択、保存・用途割当を実装し、固定応答とブラウザで確認した。利用者のトークンは未登録。Cloudflareとの実通信、品質・遅延、日本語の対応範囲、実機器での3往復は未確認。

## 範囲と再利用

- 既存の接続・モデル・用途割当、秘密channel、暗号化、共通下書き、保存transaction、接続世代・取消・採用検査を再利用した。
- 接続の種類にWorkers AIを追加し、Account IDから固定のCloudflare API URLを組み立てる。APIトークンを通常の設定JSONや変更一覧に入れない。
- 既存の「AIと接続」に「音声モデル」タブを追加。既存のSettingsSectionを使い、モデル・声・言語を選んで登録済みの構造操作を下書きへ追加する。登録したモデルは「利用するAI」で割り当てる。
- モデル一覧APIを拡張し、保存済みの資格情報で用途ごとのcatalogとschemaを取得する。手動更新、短いキャッシュ、接続世代変更時の失効、再取得失敗時の古い候補の操作禁止を確認した。
- Workers AI固有の処理は、外部APIの要求形式、応答の取り出し、音声形式の変換に限定した。モデル名・声・言語の候補を製品コードに固定していない。発話の意味判断やプロンプトへのシナリオ分岐は追加していない。
- 必要な専用処理の根拠は[公式のモデルschema API](https://developers.cloudflare.com/api/resources/ai/subresources/models/subresources/schema/methods/get/)。モデルによって音声の入力形式・本文のキー・声の指定・出力形式が異なり、OpenAI互換の音声APIだけでは接続できない。未対応の契約は選択と実行を拒否する。
- TTSは可能ならWAVを要求し、MP3は既存のbackend実行環境のffmpegでWAVへ変換する。外部URLやファイルを入力せず、標準入出力・出力量上限・期限・取消を使う。WebSocket音声は今回の範囲外。

## 登録の版

旧artifact・schemaは残し、追加前のJSON定義が保持されていることを照合した。

| 対象 | 新しい版 |
| --- | --- |
| AIと接続 | `artifact:settings.ai-connections@7` |
| 会話 | `artifact:settings.conversation@7` |
| 音声と入力 | `artifact:settings.voice-input@5` |
| 表示（既存Spatial画面を継承） | `artifact:settings.display@9` |
| 外部作業 | `artifact:settings.external-work@6` |
| 変更一覧 | `artifact:settings.changes@4` |
| 接続追加／モデル追加／共通保存schema | `schema:settings-add-connection@4`、`schema:settings-add-resource@2`、`schema:settings-apply@4` |

新しい画面は`settings.apply-v4`から既存のsettings domainの保存操作へ接続する。従来の`settings.apply`も残す。新しい構造操作は`structure:settings.add-connection@2`と`structure:settings.add-resource@2`。版を分けた理由は、旧schemaがAccount ID・接続種別・言語を受理しないため。

表示設定は別bundleの既存7・8を維持し、最新8の画面を継承した9で保存契約だけを更新した。初期の版番号競合は修正済み。2つのbundleの同時登録と、旧版の保全・更新・再登録の冪等性を結合試験に追加した。schema参照はbundle登録時に照合する（現行pinsはcapability definition専用でschema文書には対応しない）。

## 検証結果

製品DB・設定・秘密はfixtureへコピーしていない。入力は一時DB、ダミーの資格情報とモデル識別子、固定のcatalog/schema/音声応答。新しい接続で実サービスを呼び出した結果ではない。

| 段階 | 結果 |
| --- | --- |
| 着手前の設定・接続一覧・設定adapter | 73件成功 |
| 最終の設定adapter・登録の結合・Workers AIの部分試験 | [46件成功](backend-focused.log) |
| 新しい設定画面（秘密の分離、ASR/TTS保存、重複拒否、取得失敗とキャッシュ） | [4件成功](web-focused.log) |
| 設定画面全体・共通フォーム・client | 10ファイル144件成功（追加の取得失敗試験前） |
| Artifact・音声・会話モデル選択の画面 | 14ファイル97件成功 |
| Workers AIのブラウザ操作 | [1件成功](browser-workers.log)。登録→一覧取得→ASR/TTS追加→保存→用途割当→再読込 |
| 既存の表示・アニメーション・APIキー更新・接続追加削除 | [4件成功](browser-regression.log) |
| bundleチェック | settings、settings.spatialとも登録可能。競合なし |
| 変更対象のlint・サイズ・整形、差分の空白検査 | 成功 |

登録の画面は[registration.png](registration.png)、モデル選択は[model-selection.png](model-selection.png)。表示しているモデルはfixtureであり、Cloudflareの実catalogではない。

### 変更範囲外の未解決事項

`bun run verify -- --domain settings --domain inference --domain capabilities --domain artifact --domain voice-dialogue --domain service-tests`を実行したが、共有ソースの更新で無効化され、SDK周辺の型エラー3件でも停止した。今回の変更を理由に要件や期待値は緩めていない。

- `api/domains/inference/adapters/cloud-agents.ts`: 別作業で追加されたログの`code`がLogFieldsにない。今回このファイルで追加した変更はSDK種別の型を明示する部分。
- `api/domains/inference/service/background-control.ts`: ログの`connectionId`と`billingPath`にnullを渡す2件。
- 上記6domainの試験だけを実行した結果は292件成功・1件失敗。失敗は`inference.test.ts`の「a background control on a saved resource goes to that resource only, and falls back to the conversation route when it can not be used」。未解決の専用リソース指定で、期待の`larm-preferred`に対し実際は`larm-only`。Workers AIを使わない既存の背景実行経路の差分であり、ここは修正していない。

全体の検証完了や音声MVPの完成とはしていない。実トークン登録後は、catalog・実ASR・実TTS・声と対応言語・取消・実機器の3往復を別の結果として記録する。

## 試験運用の見直し

- ブラウザ試験の初期段階で、試験用認証の長さ、画面の配信先、非表示タブを含むlocatorを見直した。各修正で操作が先へ進むことを確認し、未完成の試験入力を製品不具合として処理しなかった。
- 全体検証中の共有ソース更新を認めた時点で無効化を通知し、設定・音声の固定試験と範囲外の失敗を分ける方針へ変更した。
- 最終bundle点検で表示設定の版番号競合を発見し、既存Spatial画面を継承する版へ修正。表示・アニメーションのブラウザ試験が成功し、旧定義の保持も確認した。

今回の`context_compile`と`compile_eval`は各1回。
