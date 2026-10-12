# Ruri 文章言語判定と TTS 振分けの実装計画

作成日: 2026-10-12。状態: **Eumenesの接続準備と固定試験、日英TTSの公開接続確認を実施済み。二分類Providerの公開配備とEumenes公開API経路の接続を確認済み。全体gateと実機器受入は実施記録を参照**。

採用済みの自然文をRuriで一度だけ `ja` / `en` に分類し、日本語はVOICEVOX、英語はKittenTTSへ渡す。既存の本文公開・回答採用・音声採用の条件を維持し、合成した音声は原文順に、前の音声が終了してから再生する。

この段階は文章全体の二分類を接続する。回答生成中からの発声、日英混在文の区間分割、境界・休止判定は後続作業とする。今回の接続が完了しても、それらが実現したとは扱わない。

## 目的と完了範囲

初回の到達点は、通常音声回答と再読み上げで、同じ読み上げ本文について判定結果を再利用し、正しいTTSへ接続できること。回答LLMの指示・本文形式は変更しない。分類器に会話生成や本文の書換えを依頼しない。

| 段階 | 完了条件 |
| --- | --- |
| 接続準備 | 内部契約、設定、振分け、取消・結果採用、固定fixtureが実装され、対象検証が通る。機能は既定で無効 |
| 公開接続 | 確定したLARM契約に対応し、discovery・確保・claim・認証・renew・解放と両TTSの実音声取得が通る |
| 製品受入 | 公開APIとブラウザの経路で順次再生と失敗表示を確認し、全体検証と実機器3往復が通る |

計画作成後の実装依頼に基づき作業を実施した。後掲の残作業と[検証記録](verification/ruri-sentence-language-2026-10-12/README.md)を正本とし、公開配備の未完了と区別する。

## Ruri 試作の前提

LARM担当からの提供情報は次のとおり。

| 項目 | 提供された内容 |
| --- | --- |
| 入出力 | 自然文全体を入力し、`ja` または `en` を一つ返す |
| 学習 | 日本語200文・英語200文の計400文をすべて使用。Ruri本体は固定し二分類ヘッドを学習 |
| 評価 | 学習・校正に使わない新規50文で日本語25/25、英語25/25。INT8・FP32とも50/50 |
| 実験モデルID | `ruri-v3-30m-sentence-language-prototype` |
| INT8保存先 | LARMホストの `/srv/ai/benchmarks/sentence-language/pilot-20261012-int8` |
| 公開状態 | 2026-10-12夕方に常駐公開済み。Provider `sentence-language`、capability `decision.sentence-language`、model `ruri-v3-30m-sentence-language` |
| 別モデル | `ruri-v3-30m-speaking-attitude` は既存の態度6分類用 |
| 既知の限界 | 一部の短文・英語引用・URLを含む文章で誤判定。ローマ字日本語は当面対象外 |

50文の評価は、その評価集合の結果として扱う。全実会話の精度、分割片や未完成の本文の分類性能、混在文の区間分割、公開APIの往復時間を保証する値ではない。仕様・評価資料と配備版の対応は公開接続の前に確認する。

Eumenesはモデルファイルを直接読まず、学習データ・モデル・秘密を他プロジェクトからコピーしない。追加学習とLARMの登録・配備はLARM側の作業とする。

## 現行経路と再利用先

現行checkoutの次の機構を再利用する。記載箇所に並行作業の差分がある場合は、その作業を上書きせず着手時に再確認する。

| 所有先と参照 | 現行動作と今回の判断 |
| --- | --- |
| [dialogueの生成処理](../api/domains/dialogue/service/generation-handler.ts) | Memory・World・担当結果等に応じて本文公開を保留する。保留条件を変更しない |
| [voice-dialogueの回答処理](../api/domains/voice-dialogue/service/respond.ts) | 回答の完了・採用とautoSpeakを確認してから合成する。この順序を維持する |
| [読み上げ本文の整形](../api/domains/voice-dialogue/service/spoken-text.ts) | 表示本文を保持したまま、引用リンク等を既存規則で読み上げ用に整える。全文を判定の入力にする |
| [音声区間の分割](../api/domains/voice-dialogue/service/sentences.ts) | 読点・句点等と240文字の上限で分割する。これは文章言語を決める機能ではない |
| [音声合成キュー](../api/domains/voice-dialogue/service/index.ts) | 未再生の合成音声を最大3区間に制限し、区間要求を作り、receiptを検査して採用する |
| [inferenceの共通実行](../api/domains/inference/service/execute.ts) | 合成前処理、設定snapshot、期限、取消、結果・交換記録を扱う。分類はこの経路に付随させる |
| [LARM接続](../api/domains/larm/service/connect.ts) | discovery・Connection確保・claim・renewを持つ。追加Providerも同じライフサイクルで扱う |
| [LARM Provider管理](../api/domains/larm/service/profiles.ts) | `tts` と `system-one` はそれぞれ一つだけ。分類用と英語TTSを別に識別する最小拡張が必要 |
| [Web再生キュー](../web/src/domains/voice-dialogue/hooks/index.ts) | 前の区間の再生終了と通知を待ち、原文順に進む |
| [音声controller](../web/src/domains/audio/controller/index.ts) | 実際の終了通知、再生世代、停止後のcallback拒否を持つ |

分類は、最初のLARM TTS要求の合成前処理で一度呼ぶ。判定対象はその要求の短い分割片ではなく、`spokenText(answer)` の全文とする。複数文の回答でも一つのラベルで全区間を振り分ける。文ごとの振分けを行うには入力単位と精度の別検証が必要である。

専用部分が必要な根拠は、新しい二分類モデルの入出力契約と、現行のProvider管理が分類用・英語TTSを識別できないこと。語句に反応する製品コードや新しい会話担当packageは追加しない。

## 実装する内部契約

### 判定対象と結果

`delivery`の音声準備契約に、読み上げ対象全文と、backendが発行する分類結果の参照を追加する。以下は内部に必要な情報であり、未確定のLARM送信JSONを表すものではない。

| 情報 | 用途 |
| --- | --- |
| 読み上げ対象全文 | 既存の本文整形後、日本語用の読み辞書による置換前の本文 |
| 対象の識別 | 音声処理単位・元回答、本文digest、設定snapshotの識別 |
| 分類結果 | `ja` / `en`、実際にclaimした分類modelと公開される版情報 |
| 実行情報 | 分類時間、接続・推論要求との相関情報、失敗理由 |

ラベルだけをブラウザや任意の呼出し元から受け取り、検証済み結果として採用しない。再利用可能な結果の実体はinferenceが管理し、参照の対象本文・設定・権限を毎回確認する。backend内部の参照を音声取得URLや秘密の保存先にしない。

分類成功後のTTS再試行と後続区間では、同じ判定結果を再利用する。初回TTSが失敗した場合でも、取消されていない同一処理の有効な分類結果まで捨てて毎区間判定し直さない。並行する同一対象の要求は一つの分類処理を共有する。

保持範囲は音声処理の寿命と既存の容量上限に合わせる。再起動後や結果の解放後は再判定できるものとし、分類結果専用の永続DBや全会話に及ぶ無期限cacheを作らない。

### 通常回答と再読み上げ

通常回答では`respond.ts`から全文を渡し、区間ごとの`SpeechPreparation`で同じ参照を使う。`voice-dialogue`から下位のLARMを直接呼ばず、既存のinference公開操作を通す。

runId付きの再読み上げでは、採用済みの元回答から同じ整形済み全文を取得する。既存の「対象区間が元回答に含まれること」の検査は維持する。区間ごとのHTTP要求でも、同じ元回答・本文・設定の結果をbackend内の有界な保持領域で共有する。

元回答のない単独合成では、渡された本文全体を分類する。設定サンプル等の明示的な日本語・英語の試聴は、声の試聴と自動分類の評価を区別する。APIへの任意の言語指定で通常回答の分類を迂回できる契約にはしない。

### 取消と採用

分類はTTS要求の設定snapshot・期限・AbortSignalに従い、成功直後と合成開始前にも権限・親要求を再確認する。分類結果に本文公開や音声採用の新しい権限を与えない。音声は従来どおり、TTS receiptの採用確認後に公開する。

取消・設定失効・本文変更・世代変更後の結果は再利用しない。古い結果が遅れて完了しても、保持領域や再生待ちへ登録しない。voice停止時は分類待ち・両TTS・再生待ちへ停止を伝播させる。

分類要求を会話LLMのcontrol生成へ置き換えない。態度判定用の`judge`・6ラベルのvalidator・`SpeechDelivery`の意味を二分類へ流用しない。分類結果は独立した型として扱う。

## LARM の公開契約と配備への依存

既存Agent Profileに、分類専用Providerと英語TTSを追加し、現在の日本語TTS・態度判定と同時に識別できる構成を第一候補とする。同じ役割のProvider名を重複させない。

| LARM側で確定するもの | Eumenesが確認する内容 |
| --- | --- |
| Agent Profileとcatalog版 | 保存済みprofileで必要なProviderを発見できること。profile変更が必要なら設定APIで保存する |
| 分類のProvider名・capability・protocol | 態度判定との識別、分類操作の対応版 |
| 公開modelと配備版 | 実験モデルID、INT8保存先、公開model、学習・校正版の対応 |
| 分類の送信先とschema | 自然文の渡し方、`ja/en`の返却位置、model・版・推論時間等のmetadata |
| 入力制限と異常系 | 長さ、空入力、切詰め、timeout、過負荷、モデル不在の応答 |
| 英語TTS | KittenTTSの実公開model、Provider名、protocol、声一覧・既定voice、speed、WAV出力 |
| claim configuration | URLとmodelのfield名、専用credential、readiness、期限 |
| 更新と解放 | renew後の再claim、モデル変更や消失時の扱い、解放操作 |

2026-10-12の公開情報を調査し、英語TTSは `speech.tts.english` / `openai.audio-speech.v1`、claim modelは `kitten-tts-nano-0.8-fp32` と確認した。分類試作仕様は公開登録を対象外とし、既存System Oneのchoice契約を将来接続候補に挙げている。Eumenesに同契約のadapterを実装したが、この先行調査後、夕方に常駐Providerが公開され、文字列stateとclaim endpointを使う接続を実施した。実験モデルIDを態度用Providerへ送ったりローカルCLIで迂回したりしない。

確定後はcatalog・Connection応答・claimのmodelとprotocolの一致を検査する。URL・model・専用tokenはclaim値を使い、既存のhost許可検査を維持する。Control tokenをProvider認証に代用せず、ブラウザへtokenを渡さない。更新は再claimまで含め、終了時は追加Providerも解放する。

初回確保と更新の両方を拡張する。現在の追加Provider不在で通常会話が動かなくならないよう、分類機能が無効なら新Providerを必須にしない。有効時に必要なProviderが不足した場合は、音声側に不足を返す。

## 設定と TTS の振分け

2026-10-12 20時の追加指定により、以下の英語voice・speedの可変設定と画面は廃止した。現行は女性・中性→Rosie、男性→Jasper、英語速度1.0の固定動作。分類Provider選択を含む追加の音声設定欄を撤去済み。詳細は [固定動作の検証記録](verification/ruri-sentence-language-2026-10-12/fixed-voice-pair.md)。下の記述は初期計画の経緯として残す。

既存settings文書に、自動二分類の有効状態と英語用voice・speedを追加する。旧設定の読取りでは無効を既定とし、勝手に試作モデルを有効化しない。日本語の保存値は維持する。設定変更は既存API・revision・失効の仕組みを使い、接続先用の環境変数は追加しない。

英語voiceは英語Providerのcatalogまたはclaimの既定値を使う。日本語のvoice・style・pitch・intonationを流用しない。VOICEVOX固有のパラメータは日本語側だけへ送る。設定画面は既存の音声sectionと部品を使い、有効状態・英語の声・速度・接続不足を表示する。

分類は整形済みの全文に対して、日本語用読み辞書の置換前に行う。`ja`の合成は既存辞書を使い、`en`の合成には日本語用辞書を一律適用しない。この差は回帰試験で明示する。対象語の辞書・正規表現で分類結果を補正しない。

対象はLARM TTS経路。cloud-onlyでは新しいLARM判定を必須にしない。分類成功後のTTS通信障害に対するクラウド切替は、既存の許可設定に従い実際の実行先を記録する。分類の不在・不正・timeout自体を、通常のTTSネットワーク障害としてクラウドへ自動転送しない。実接続の振分け受入はlarm-onlyで行う。

settingsは既存JSON保存を使い、既存migrationを上書きしない。追加DB migrationが必要かは互換読取り試験で判断し、必要な場合もsettings domainの新しいmigrationに限定する。

## 失敗と実行記録

機能が無効なら従来のTTS経路を使う。有効時に分類Provider不在、不正応答、入力上限超過・切詰め、timeout、選択先TTS不在が起きた場合は、本文を残して音声処理を失敗させる。ラベルを推測したり、VOICEVOXへ黙って戻したりしない。

分類の構造・接続の失敗は、既存の区間合成再試行で各区間3回ずつ繰り返さない。全区間共通の準備失敗として終了させる。分類成功後の個別合成再試行は既存規則を使う。モデルが返した妥当な`ja/en`の誤判定はモデルの評価課題であり、Eumenesの個別分岐で隠さない。

timeoutの上限は公開契約と初回測定で固定し、既存TTS期限から独立した無期限待ちを作らない。未達を理由に分類を何度も呼び直す運用にしない。

交換記録は分類・態度判定・TTSを区別する。現在の`onExchange`は最大2件で後続を捨てるため、必要な操作とその有限な再接続分を記録できる上限へ変更する。分類modelでTTS attemptのmodel欄を誤って確定しない。英語TTSを選んだ場合は、日本語`tts`のinspect結果を合成modelとして記録しない。

ログにはrunId・utteranceId・inferenceId・request correlation、model、言語、時間、失敗理由を残す。本文・音声・認証情報・設定全体・Provider生応答は運用ログへ渡さない。短い評価文と正解ラベルが必要な試験資料は、運用ログとは別に保持する。

## 作業順序と変更箇所

以下はすべて未着手。内部操作名や新規ファイル名は実装時に既存命名へ合わせる。未確定の外部API schemaをfixtureで既成事実にしない。

| 作業 | 内容と主な変更先 | 依存と終了条件 |
| --- | --- | --- |
| P01 現状固定 | `voice-dialogue`・`inference`・`larm`・`settings`の関連試験と公開・採用条件を再確認。並行差分を記録 | 開始条件。担当外の失敗は証拠を報告し修正しない |
| P02 内部契約 | `delivery/contracts`、`inference/contracts`、`larm/contracts`に分類入力・結果参照・専用操作・TTS選択の最小契約を追加 | P01。固定ポートで正常・不正・取消を表せる |
| P03 設定 | `settings/contracts`・`settings/service`と既存音声sectionに無効既定、英語voice・speed、設定snapshotを接続 | P02。旧保存値の読取りと設定変更による失効が通る |
| P04 合成前処理 | `inference/service/execute`・`index`、`voice-dialogue/respond`・`index`、receipt関連に全文判定・再利用・選択先・失敗伝播・交換記録を接続 | P02・P03。通常回答、再読み上げ、単独合成の固定結合試験が通る |
| P05 固定接続準備 | domain fixtureと必要なbrowser fixture、隔離live runner、結果記録の形式を揃える | P04。LARM未配備でも無効時の従来経路と有効時の拒否を確認できる |
| L01 公開契約 | LARM担当が前章のProvider・schema・配備版・両TTS契約を確定し登録・配備 | 外部依存。P02〜P05と並行可能 |
| P06 公開adapter | `larm/service/profiles`・`connect`・`index`で追加Providerの初回claim・renew・解放と分類・英語TTS操作を実装 | L01・P05。確定した公開契約のfixtureと一致 |
| P07 回帰とlive | 利用側domain、API結合、全体gate、隔離実接続を実行 | P06。結果と未確認範囲を記録 |
| P08 実機器受入 | 実スピーカー・マイクで3往復、再読み上げ、割込みを確認 | P07。音声の実体と操作を確認 |

`dialogue`の生成方針、ASR入力言語の許可判定、態度6分類の学習と意味、会話ツールチェーンの登録は変更しない。既存Web再生キューを使い、新しいプレイヤー・Artifact・別の再生状態管理を追加しない。

下位domainから`voice-dialogue`や`dialogue`を参照しない。読み上げ本文の整形は上位で実行して渡す。domainを跨ぐ保存が必要な場合は、公開操作と単一writer transactionを使う。

## 検証方法

### 部分検証

所有domainの試験へ、今回の契約と失敗条件だけを追加する。

| 対象 | 確認する条件 |
| --- | --- |
| 分類結果 | `ja/en`のみ受理、schema違反・model不一致・切詰め拒否。未定義のconfidenceを正解確率と扱わない |
| 再利用 | 分割数にかかわらず分類成功は一回。同時要求・合成再試行・再読で共有し、本文・snapshot・世代が違えば使わない |
| 設定 | 無効既定、旧設定読取り、保存・再読込、英語voice分離、変更による取消・失効、秘密非公開 |
| TTS送信 | ラベルに対応したProvider・model・token・voice。英語にVOICEVOXパラメータと日本語辞書を送らない |
| 接続 | discovery・確保・claim・renew後のtoken・解放、追加Provider不在、model差替え、許可外host、401・過負荷 |
| 採用と記録 | 親要求の有効性、音声receipt採用、遅着拒否、実合成model、分類・態度・TTSの交換記録、本文・秘密のログ不在 |

### 固定結合検証

既存のvoice・settings integration・world release・Web再生fixtureを拡張する。APIを通して、採用済み回答の全文が判定へ渡り、各区間の本文が書き換わらず、合成結果が原順序で再生されることを確認する。

本文保留中、採用失敗、autoSpeak無効では分類とTTSの呼出しを0件にする。分類待ち・合成待ち・再生中の各時点で取消し、遅れた結果と終了callbackが古い再生を再開しないことを確認する。分類Provider不在等はvoiceの失敗表示へ到達し、各区間を黙ってskipして成功にしない。

TTSの合成開始は前の音声終了を待たず先行できる。発声は前の音声の実際の終了後に始める。次音声が未準備なら待機し、重ねたり順番を飛ばしたりしない。現在の取得・デコードには区間間の待ちが残り得るため、今回の結果だけで無音のない再生を保証しない。

### 部分から全体へのコマンド

以下は実装後に実行する。作業途中は完了した所有範囲のコマンドだけを選び、全経路を揃えてから結合・全体へ進む。

```sh
bun run verify -- --domain delivery
bun run verify -- --domain settings
bun run verify -- --domain larm
bun run verify -- --domain inference
bun run verify -- --domain voice-dialogue
bun run verify -- --domain audio
bun run verify -- --domain tts-dictionary

bun test api/application/agent-voice-response.test.ts
bun run verify:all
```

domain検証は利用側・application結合試験を自動で網羅するものではない。追加する公開API結合試験とbrowser fixtureはP05で実際のファイルを確定し、その実行入口を実施記録へ追記する。全体gateの成功は最終入力hash一致まで含む。

### 実接続確認

P05で `scripts/sentence-language-live.ts` を作成済み。既存の `scripts/live-larm.ts` のbackend用settings読取りと接続手順を再利用し、実行入口は `bun scripts/sentence-language-live.ts --run`。2026-10-12に両TTSの公開接続を確認した。分類Providerを含む確認は未配備のため未実施。

1. 保存済みLARM設定をbackendの読み取り専用操作で取得し、公開契約とmodel版を確認する。
2. 隔離backendへ同じ接続先・検証用設定を設定APIで保存する。製品DB・credentialファイルをコピーしない。
3. 検証専用clientのConnectionを確保し、ready・claimを確認する。初回準備と準備済み状態を分ける。
4. 日本語・英語の固定全文を分類し、VOICEVOX・KittenTTSへ送信する。分類modelと合成modelの両方を記録する。
5. 音声を既存の認証付き取得APIから取得し、WAVのデコード・長さを確認する。録音済みの私的会話は使わない。
6. renew・再claim後にも合成できること、取消後の音声を採用しないことを確認する。
7. `finally`で検証Connectionと隔離backendを解放する。既存の稼働Connectionを検証用に解放しない。

短文・英語引用・URLの既知の難例も評価するが、二分類モデルの誤判定と接続・振分けの失敗を分ける。既存50文の再評価は資料と正解を入手した場合に限り同条件で行い、Eumenesに例専用の補正を加えない。

分類往復、第一合成、音声取得、第一発声、区間間待ちを分けて測定する。準備済みの分類往復P95 50msを初期目標案とするが、未測定の合格実績として記載しない。公開配備後の試作測定で実行条件・deadline・性能合格値を固定し、本受入で未達なら原因と影響を報告する。失敗とtimeoutも集計する。

分類往復の測定は、日本語・英語、短文・長文、通常・並行負荷を分け、代表条件ごとに200回以上の試行数を記録する。音声生成は分類測定の全試行で繰り返さず、別の少数の通し試験で測る。最初のLLM本文到着から回答採用までの待ちも別に記録し、全文採用待ちの今回の経路をストリーム発声として評価しない。

実接続の記録は `spec/verification/ruri-sentence-language-2026-10-12/` を保存先とする計画。fixture・live・実機器を別項目にし、model版、入力条件、試行数、P50/P95、失敗件数、採用結果を記録する。

### 実機器受入

実マイク・スピーカーまたはヘッドホンで3往復以上確認する。日本語回答、英語回答、同一回答の再読み上げを含め、選択先の声・速度・音量、順序、前音声終了後の次発声、割込みを観測する。音声ファイルの取得成功だけで実機器受入にしない。

## 有効化と停止条件

P02〜P05は公開Provider未配備でも進める。公開schemaが不明な間はP06の実送信形式を推測で確定しない。内部実装の完了と公開接続の完了を別々に報告する。

本番での有効化は公開契約、固定試験、全体gate、live受入が揃った後に設定APIで行う。機能を無効にすれば従来の日本語TTS経路へ戻せるようにする。取消・権限失効・秘密非公開・本文採用条件を弱める変更をロールバック手段にしない。

検証失敗では `bun run logs -- --level warn` から調査し、相関IDで絞る。担当範囲で原因が確認できた失敗だけを最小修正する。並行作業由来・担当外の失敗は証拠と影響を報告し、依頼なしに修正しない。同じ失敗で新しい根拠がなければ再実行を止め、続行条件を整理する。

最終差分では、単語・文章例による振分けが増えていないこと、分類判断をコードへ移していないこと、既存の別作業を巻き戻していないことを確認する。試験が通るだけで完了にしない。

## 残作業と実施記録

- [x] P01 現状と並行差分の確認
- [x] P02 内部契約と専用ポート
- [x] P03 無効既定の設定と英語音声設定
- [x] P04 全文判定と共通TTS経路への接続
- [x] P05 固定fixtureと隔離live runner
- [x] L01 LARMの公開契約確定と登録配備
- [x] P06 公開adapterの接続（文字列state、claim endpoint・model・token、常駐HTTP、分類結果による両TTS、公開API receipt採用を確認済み）
- [ ] P07 利用側検証と全体gateとlive（対象固定試験・利用側gate・公開API live済み。全体は担当外DesignSystemの型エラーで停止）
- [ ] P08 実機器3往復

実施記録は作業完了・試験終了後に追記する。項目は、変更箇所と理由、実行した検証、入力条件・model版・試行数、結果と相関ID、未確認範囲、残作業・続行条件とする。実装済み・固定試験済み・実接続済み・実機器受入済みを区別する。

関連手順: [LARM接続](../docs/larm.md)、[ツールチェーン登録と拡張](../docs/toolchain-extension.md)、[段階別検証](../docs/toolchain-extension-verification.md)、[運用ログ](../docs/logging.md)。

2026-10-12実施: [検証記録](verification/ruri-sentence-language-2026-10-12/README.md)に変更範囲、Pages・LARM正本、fixture / live / 実機器の区別、公開配備の続行条件を記録した。

2026-10-12夕方の公開配備対応: [公開接続の実施記録](verification/ruri-sentence-language-2026-10-12/public-connection.md)。先行adapterの `state.current_chunk` を公開契約の文字列 `state` に変更し、capabilityによる発見とclaimされたendpointの検証・使用を追加した。

通常環境はsettings APIで試用を有効化済み（revision 18）。[最新の公開接続・有効化記録](verification/ruri-sentence-language-2026-10-12/public-connection.md)に、全体gate未完了・実機器未受入・P95目標未達を含めて記録した。
