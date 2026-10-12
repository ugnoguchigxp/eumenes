# Ruri文章二分類・日英TTS接続の実施記録

**最新状態:** 2026-10-12夕方に常駐Providerを公開接続し、通常環境で試用を有効化した。[公開接続の実施記録](public-connection.md)を参照。以下は公開前の接続準備の記録。

2026-10-12。Eumenes側の接続準備、固定試験、公開Profileによる日英TTSの音声取得を実施した。二分類Providerの公開配備、分類を含む公開通し接続、性能評価、実機器3往復は未完了。機能は既定で無効のまま。

## 正本の確認と判断

[Space Pages「LARMの全体コンセプト」](https://chatgpt.com/space/page_9fab9c53bce8819181c9c8256a3b303a)と[「LARM プロファイル選択と接続の共通手順 ContextStillとSAAA」](https://chatgpt.com/space/page_ab39a64dc10481919c03b533cbf02e76)を読んだ。ProfileとProviderが利用意図の識別子であり、ランタイムやモデル・起動ポートは接続先の正本ではない。discoveryだけで起動・確保しない。確保、ready、claimの一致、専用token、renew後の再claim、解放を共通機構で扱う。

保存済みbackend設定を `settings.readStoredLarm` で読み、公開 `/openapi.json`、`/v3/agent-profiles`、`/v1/models`、`/v1/services` を確認した。`SAAA-gemma4-26b` / `saaa-conversation-gemma4-26b-voice` に既存日本語TTS、態度用 `system-one`、英語TTSがある。英語は `tts-english`、capability `speech.tts.english`、protocol `openai.audio-speech.v1`、endpoint `/v1/audio/speech`、model `kitten-tts-nano-0.8-fp32`。二分類Providerは公開catalogにない。モデル一覧に実験モデルIDもない。

LARMホストの試作仕様 `/srv/ai/apps/local-LLM-harness/specs/ruri-sentence-language-classification-2026-10-12.html` と保存モデルmanifestを読み取り専用で確認した。公開登録・配備は試作の対象外で、将来の接続候補に既存 `/v1/systemone` のchoice契約が記載されている。試作は空入力・512 token超を拒否し、切詰めない。ローカルINT8の約1msの測定値は公開HTTP・接続確保の時間ではない。ローカル判定CLIをEumenesの接続経路として使っていない。モデル・学習データ・製品DB・秘密はコピーしていない。

## 変更範囲と理由

- `delivery` に全文と対象scopeを持つ内部の音声準備契約と、全区間を止める言語準備エラーを追加した。
- `larm` に独立した二分類ポートと `ja/en` 検証、選択したProviderのSystem One choice adapter、英語TTSのcatalog / claim / renew接続を追加した。モデルやURLを固定せずclaim値を使う。不正な追加Providerは旧tokenも含め破棄し、当該言語を選択した場合は失敗させる。通常の日本語読み上げまで巻き添えにしない。態度用Providerと混同しない。分類応答のmodel不一致、不正ラベル、切詰め、入力破棄を拒否する。
- `inference` の既存TTS前処理に分類を接続した。同一回答・本文・設定をdigestで識別し、backendの有界な保持領域（64件・10分）で結果と実行中処理を共有する。失敗は保持せず、最後の利用者の取消や設定変更で実行を止め、遅着結果を採用しない。分類中にTTS側の期限が先に切れた場合も、分類の時間切れとして終了し、クラウド合成へ黙って移らない。分類・態度・合成の交換記録を操作名で区別し、TTS model欄に分類modelを保存しない。
- 接続準備は既存のTTS期限内で行い、準備後の分類に暫定2秒上限を置く。冷起動の接続確保をその2秒に混ぜない。公開分類器の性能で上限を再評価する必要がある。
- `settings` に無効既定の有効状態、分類Provider名、英語voice・speedを追加した。旧設定互換と保存・再読込を確認した。英語に日本語のvoice・style・pitch・intonation、読み辞書、態度による音声パラメータを送らない。既存JSON保存を使い、新規migrationは不要。
- `voice-dialogue` は採用済みの読み上げ対象全文を通常回答とrunId付き再読み上げへ渡す。分類失敗を各句3回ずつ再試行せず、音声処理全体の失敗として止める。本文は残す。
- 言語判定や声の不足・時間切れ等の音声失敗を日本語で表示する。Webの音声設定に公開状況、分類Providerの選択、英語の声・速さを追加した。一覧にない保存値を保持し、日本語設定を変えない。未適用のLARM接続変更では発見を待つ。通常合成APIへ任意の言語指定は追加していない。
- サイズ制限のため、既存の合成処理・設定の有効性確認・音声アクセス・日本語声選択を小さな別ファイルへ移した。共通機構で満たせない追加部分はProviderの接続契約・ラベル検証・取消・容量制限に限定した。語句・英字判定・辞書で言語判断を代替していない。

本文公開・回答採用の条件、最大3区間の合成先行、Webの終了通知を待つ順次再生を維持した。全文の回答採用後に分類するため、LLMの最初の本文到着から発声を始めるストリーム処理と、日英混在文の区間分割は実装していない。

## 固定試験

最終結果は下記の実行結果とする。fixtureの音声は人工WAVであり、実機器受入ではない。

| 検証 | 結果 |
| --- | --- |
| 対象backend 5 domain（delivery / settings / inference / larm / voice-dialogue） | 23ファイル・241件成功。その後、追加Providerの不正model・許可外host・renew時の3ケースを追加してLARM61件を再検証、成功。さらにTTS側の短い期限が分類中に切れた場合の1ケースを追加し、inference35件を再検証、成功（対象backendの固有試験は計245件） |
| Web settings / voice-dialogue / audio とclient | 28ファイル・426件成功 |
| Web 音声エラー表示 | 10件成功。接続不足・不正判定・時間切れ・過負荷等を日本語で表示 |
| Web build | 成功（既存のbundleサイズ警告あり） |
| application `agent-voice-response.test.ts` | 7件成功。失敗回答・取消・autoSpeak・採用後TTSの既存条件を維持 |
| domain gate: delivery | 成功、backend14件 |
| domain gate: settings | 初回成功（backend20件・Web33件）。最終再確認は担当外 `larm/service/playground.ts:284` の新しい型エラーで停止。追加設定の固定試験を含むbackend21件は別実行で成功 |
| domain gate: inference | 成功、backend56件 |
| domain gate: voice-dialogue | 成功、backend64件・Web34件 |
| domain gate: audio | 成功、Web45件 |
| domain gate: tts-dictionary | 成功、backend7件・Web6件 |
| domain gate: larm | 担当外の `service/playground.ts` サイズ超過で停止。LARM固定試験と変更ファイルのサイズ・lintを別実行して成功 |
| 対象lint / 差分空白検査 | 成功 |
| 全体 `verify:all` | 初回は担当外サイズ超過で停止。並行修正後の再確認では境界・全体サイズ・SQL境界・domain文書・format・lintが成功し、担当外 `larm/service/playground.ts:284` の型エラーで停止。後段の全体試験・browser fixtureは未実施。Web buildは別実行で成功 |
| 全体typecheck | 最新実行は担当外 `larm/service/playground.ts:284` の `string | undefined` 型エラーのみで失敗。途中のdialogue試験4箇所の型エラーは別作業により解消。今回の変更由来の型エラーは解消、初回の利用側domain gateの型検査は成功 |

固定試験は、専用tokenとclaim model、更新後の再claim、discoveryのみでは確保しないこと、欠落Provider、model不一致・不正ラベル・切詰め・破棄、英文への日本語設定混入防止、採用済み全文一回の分類、3区間の先行上限と再生通知による解放、再読み上げの共有を確認した。取消の共有処理、本文・snapshot変更、容量、時間切れと遅着、音声失敗時の本文保持も確認した。

途中で分類エラーが共通実行のplain Error化により区間再試行へ入り9回呼ばれる問題を検出した。言語準備エラーの型を共通実行で保持し、一回の失敗で音声処理を終了する試験が成功した。要件や期待値を弱めていない。

全体gateの担当外失敗箇所は `larm/service/playground.ts`（839行、関数696→789）、`agent-runtime/service/step-actions.ts`（302行）、`dialogue/service/generation-handler.ts`（440→529）、`toolchain-history/service/index.ts`（451行）。並行差分を修正せず、サイズ基準も変更しなかった。並行作業がサイズ問題を解消したため再確認し、全体サイズ検査792ファイルは成功した。ただし残るplaygroundの型エラーは担当外のため修正していない。作業前に保存した対象ファイルとの比較と最終差分点検で、別作業の変更を巻き戻していないことを確認した。

## live（公開TTSの通信・音声取得）

`scripts/sentence-language-live.ts --run` を保存済みbackend設定で実行した。専用認証による公開Profileの確保・claimと解放を使い、テスト用の日英各1文でWAVを取得した。任意の環境変数で接続先を上書きしていない。

| 言語 | claim model / voice | 音声 | 時間 |
| --- | --- | --- | --- |
| ja | `voicevox-core` / `Kenzaki_Mesuo` | 107564 bytes、24kHz mono、2.240秒 | 9156ms（初回接続確保約8891msを含む） |
| en | `kitten-tts-nano-0.8-fp32` / `Rosie` | 196444 bytes、24kHz mono、4.092秒 | 220ms（同じ準備済み接続） |

WAVのフレーム数とサンプルレートを別途読んで検証した。初回は各一回の通信確認でありP50/P95や分類の性能測定ではない。接続相関IDは `aconn_epoch-9713f666-ce0c-4635-b795-d6818ce1c9ae_f96e7272-2b5a-47bd-ad70-7c6aa4692992`。安全なmetadataは [live-result.json](live-result.json)、合成WAVはローカルの `verification-reports/sentence-language-live/ja.wav` / `en.wav` に保存した。

接続bindingの最終修正後に再確認し、両TTSのWAV取得が再度成功した。最終日本語6758ms（接続確保約6552ms込み）、英語188ms。WAVのサイズと形式は初回と同じ。相関ID `aconn_epoch-9713f666-ce0c-4635-b795-d6818ce1c9ae_9ee41e81-80cf-4dbd-908f-f9a86511621b`、[最終metadata](live-result-final.json)に記録した。

分類Providerの未公開はrunnerの `tts_passed_classifier_pending` として記録した。分類の代替としてローカルCLIや既存態度モデルを実行していない。既知言語を明示した合成はTTS通信だけの確認であり、自動分類の成功には数えない。

## 続行条件と残作業

1. LARM担当が文章二分類Providerを公開Profileへ登録・配備する。同じProfileで既存態度用Providerと区別でき、modelと学習版の対応を確認できることが必要。
2. Eumenesの音声設定で公開catalogの分類Providerを選ぶ。別protocolの場合は先に公開契約に合わせたadapter検証を追加する。保存済み接続先の再入力は不要。
3. runnerを再実行し、公開二分類の `ja/en`、512 token等の制限、取消、過負荷、renew、両TTSを確認する。短文・引用・URLはモデル誤判定と接続失敗を分ける。
4. 公開分類往復を通常・並行負荷で測り、暫定2秒上限と準備済みP95目標を評価する。生成待ち・接続確保・分類・合成・取得・最初の発声・区間間待ちを区別する。
5. 担当外 `larm/service/playground.ts:284` の型エラーが解消された後、全体gateを再実行する。
6. 分類を有効にした公開API・ブラウザ経路と、実マイク・スピーカー等で日英・再読・割込みを含む3往復を確認してから製品受入とする。

実機器受入は未実施。TTSのWAV取得成功を音声MVP完成とは宣言しない。

ContextStillの今回の実装開始compileと評価は各1回実施。会話の累計はcompile/eval各6回。直近runId `00000000-0000-0000-18dd-b12644cf7fe5`、評価はpartial（公開情報を追加調査）。
