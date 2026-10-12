# 常駐Ruri文章言語判定の公開接続

現行の英語声は女性・中性→Rosie、男性→Jasper、英語速度1.0の固定対応。追加の音声設定欄は撤去済み。全6名の実接続結果と最終gateは [固定動作の検証](fixed-voice-pair.md)を参照。

その後、既存の音楽画面の型エラーを修正し、型・全単体試験・buildは成功。全体browserで失敗3件があり、同じ3件の再試験は成功した。全体gateの安定合格は未確認。[最新の再検証](music-type-error-fix.md)。

2026-10-12（日本時間）。公開配備後のEumenes接続を実装・検証し、通常の音声設定で試用を有効化した。文章全体の `ja/en` 判定から、VOICEVOX / KittenTTSの実音声取得とreceipt採用まで成功した。全体gateは担当外のDesignSystem試験の型エラーで停止。実機器3往復は未実施。

## 接続と変更

保存済み設定の `SAAA-gemma4-26b` を使い、catalogで `sentence-language` / `decision.sentence-language` / `ruri-v3-30m-sentence-language` / `larm.system-one.v1` を確認した。Profile全体を要求する既存のConnection確保は、このProviderも含む。態度用 `system-one` / `ruri-v3-30m-speaking-attitude` と同じConnectionで利用する。

先行adapterの `state.current_chunk` オブジェクトを、公開契約の文字列 `state` に変更した。回答LLMの自然文や出力指示は変えていない。採用済みの読み上げ全文をそのまま分類し、`answers.language.type=choice` と `choice=ja|en` を検証する。分類の語彙・正規表現補正は追加していない。

分類Providerは、catalogのcapabilityと任意の保存Provider名で選ぶ。未選択なら該当capabilityの候補が一つの場合に限り自動選択する。単なるSystem One protocolの一致だけでは選ばない。複数候補や不正bindingでは判定を推測しない。

claimのmodel・protocolとcatalog / Connectionの一致、configurationのdaemonURLとbaseUrlの一致、host許可とendpointの一致を確認する。分類ではclaimの正確なendpoint URL・model・credential.tokenを使う。公開claimのcapabilityは汎用transportの `decision.system-one` だが、catalogの意味上のcapability `decision.sentence-language` とProvider名・model・protocolを別々に検証している。旧来のcapability enumにより新Providerを拒否しないことをfixtureと実接続で確認した。

既存音声Providerのclaimはendpointを省略してbaseURLを返す場合がある。英語TTSはこの既存契約を保持し、endpointがあれば検証・使用し、なければ宣言済みの音声pathをbaseURLに解決する。分類Providerのendpoint欠落・許可外host・不一致は拒否する。tokenや生応答はブラウザ・実施記録へ渡さない。

接続とHTTP要求は共通機構を再利用した。常駐モデルのローカルファイル読込み、判定プログラムの毎回起動、tokenizer / encoderの初期化をEumenesから行わない。更新では全Providerを再claimし、endpointと専用tokenも更新する。不正になった追加bindingと旧tokenは破棄し、当該役割の利用を拒否する。

古いdaemon epochの認証拒否後、Controlで404 / releasedを確認し、一回だけConnectionとclaimを取り直す。追加前のvoice leaseが新しいProviderを持たない場合も、Controlの現状を確認して失効済み接続を再取得する。妥当な接続の401や不正schemaを無制限に再送しない。

既存の本文公開・回答採用、分類中の取消、snapshot変更、旧世代の遅着拒否、最大3区間の合成先行、終了通知を待つ原文順の再生を維持した。分類は全文につき一回で、後続区間と再読に再利用する。文章内の日英区間分割、生成途中の発声、ローマ字日本語の追加学習はこの実装に含まない。

## 固定試験とgate

| 検証 | 結果 |
| --- | --- |
| 変更前のLARM fixture | 61件成功。ただし公開された文字列state / claim endpointの契約は旧fixtureでは未検証だった |
| 最終対象backend 5 domain | 251件成功、失敗0（23ファイル） |
| LARM domain gate | 95件成功。新capability、自動発見、文字列state、claim endpoint、専用認証、renew、旧epoch、追加前のlease、解放、取消、不正bindingを検証 |
| inference / voice-dialogue gate | 成功。57件 / 64件、voice Web34件 |
| 対象Web / client | 436件成功（29ファイル） |
| 英語速度label修正後のsettings Web | 33件成功。英語の速さの変更が日本語の設定を変えないことを追加確認 |
| root typecheck / 対象lint・format・サイズ / 差分空白 | 成功 |
| 最終settings gate | 型・format・lint・backend21件・Web33件は成功。終了時の入力hash確認で `source changed during verification` となり、gate全体の成功には数えない |
| Web build | 成功。既存のbundleサイズ警告あり |
| `verify:all` | 境界・全体サイズ・SQL境界・domain文書・format・lint・root型検査が成功。backend等1608件、Web308件、client314件が成功。その後DesignSystemの型検査で停止 |
| 対象browser | 17件成功、1件既存skip。初回の16成功と、修正後の速度設定保存試験1成功を合わせたもの |

全体gateの未解決箇所は `packages/design-system/src/components/MusicWorkspace/MusicCreationForm.test.tsx` の6箇所（20 / 23 / 42 / 49 / 60 / 83行）。`getByRole` の `ByRoleOptions` にない `exact` 指定による型エラー。担当外なので変更していない。gate後に追加した旧lease回復ケースは最終LARM gateと対象backend251件で検証した。

browser初回は英語速度スライダーが日本語と同じ「話す速さ」で識別され、既存保存試験が二つの要素に一致した。共通部品に表示labelを指定できる最小変更を加え、英語側を「英語の速さ」とした。期待値を弱めず、同じbrowser保存試験が成功した。fake-mediaの1件は、macOSでChromium getUserMediaが停止する既存skip条件による。実マイク受入には数えない。

## 公開接続・時間測定

`bun scripts/sentence-language-live.ts --run --benchmark` で、接続準備後のHTTP要求と応答検証を測った。テスト用の日英各1文を使用し、各条件200回。同時条件は分類と態度の両方が完了するまでを計測した。P95の定義は95%点であり、最大待ち時間ではない。

| 条件 | P50 ms | P95 ms | 最大 ms | 失敗 |
| --- | ---: | ---: | ---: | ---: |
| 日本語分類 | 12.25 | 27.36 | 47.21 | 0/200 |
| 英語分類 | 19.62 | 52.68 | 131.07 | 0/200 |
| 態度との同時要求：両方完了 | 36.33 | 107.82 | 326.56 | 0/200 |

600回すべて同じConnectionを使用した。態度の結果も既存emotion契約とclaimed modelを検証した。このPCからのネットワークを含む値で、LARM担当のホスト内測定（日本語3.16ms、英語1.87ms、同時8.48ms）と測定境界が異なる。2文の繰返しであり、追加50文の精度試験をEumenes側で再実行した結果ではない。

接続準備は約1033msで、上表から除いた。試作の348msはモデルの新規初期化時間であり、毎回の分類時間として加算しない。先行スモークでは約586ms / 2916msの単発も観測したため、600回の成功を全状況の上限保証とは扱わない。分類の暫定2秒期限を残し、超過は音声失敗として扱う。初期案のP95 50msは英語と同時条件で未達であり、値を隠したり目標を満たしたと宣言したりしない。

分類結果を実際に使って日英両TTSからWAVを取得した。安全なmetadataは [public-live-result.json](public-live-result.json)。Connectionは `aconn_epoch-09680c28-92db-4388-ab05-a473587ab9b3_6986f07f-e9c9-4465-8a17-e1d487055f12`。script終了時に公開の解放操作を実行した。更新・token入替・失効後不採用はfixtureでも検証し、LARM側の実接続検証結果とは区別する。

## Eumenes公開APIと通常環境

`bun scripts/sentence-language-api-live.ts --run` は新規の隔離backendを起動し、接続先を既存settings APIで保存した。公開catalogからProviderを選び、分類を有効にして、`/api/voice/replay/audio` から日英のWAVを取得した。source=`larm`、実合成model、accepted=1、分類と合成の交換記録を確認した。製品DBや秘密のコピーは行っていない。

- 日本語: `voicevox-core`、90156 bytes、24kHz mono、1.877秒。
- 英語: `kitten-tts-nano-0.8-fp32` / Rosie、196444 bytes、24kHz mono、4.092秒。
- 両者の分類model: `ruri-v3-30m-sentence-language`。同じConnectionで分類・合成。

記録は [public-api-live-result.json](public-api-live-result.json)。

通常環境のbackendは更新前のコードで、新APIが404だったため、実行中の推論が0件であることを確認して標準の `bun run dev` で再起動した。保存済み接続先を再入力せず、settings APIで `sentenceLanguageProvider=sentence-language` と `sentenceLanguageEnabled=true` を保存した（revision 18）。日本語の声・速度など他の設定は保持した。

通常環境の公開APIでも日英の分類→合成→採用が成功した。日本語109612 bytes、英語196444 bytes、いずれもaccepted=1。接続確保・分類・合成・取得を含む時間は日本語約2901ms、英語約2126ms。これを分類単体の時間と混同しない。記録は [normal-runtime-result.json](normal-runtime-result.json)。現在は試用として有効。全体gate・実機器の製品受入を完了したとは扱わない。

## 残作業

2026-10-12の追加確認で、通常Brave画面の再読み上げから日英7区間の実Web Audio出力と終了後の次開始を確認した。再試聴後ユーザーから可聴性の確認を得た。日英とも女性声（春日部つむぎ / Rosie）に変更・保存し、実合成で利用を確認した。詳細は [実ブラウザ読み上げ](browser-playback.md)。実マイク3往復は別途。

- 担当外DesignSystem試験の型エラー解消と並行ソース編集の停止後に、settings / 全体gateを再実行して入力hash一致まで確認する。
- 実マイク・スピーカー等で、日英回答、再読、前音声終了後の次発声、割込みを含む3往復を確認する。
- 通信・負荷条件ごとの公開往復を継続評価し、P95目標と暫定期限を決める。入力の長さ・難例・ローマ字日本語はモデル評価と分けて扱う。

ContextStillは今回compile/eval各1回、会話累計は各7回。runId `00000000-0000-0000-18dd-bcac10aa63f6`、評価useful。
