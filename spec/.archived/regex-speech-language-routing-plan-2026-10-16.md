# 日英混在回答の区間別TTS振分け（正規表現判定）実装計画 2026-10-16

状態: 実装済み・fixture検証済み（2026-10-16、`bun run verify -- --domain delivery --domain inference --domain larm --domain voice-dialogue --domain settings` 通過）。live（`mixed-speech-live`）と実機器受入は未実施。[Ruri文章二分類計画](ruri-sentence-language-tts-implementation-plan-2026-10-12.md) を廃案にし、本計画で置き換える。

## 1. 目的と方針

LLMの回答に日本語と英語が混在するとき、英語として発声すべき区間を英語TTS（catalog capability `speech.tts.english`）、それ以外を日本語TTS（既存 `tts`）で合成し、原文順に再生する。

- 判定はLARMのRuri（`decision.sentence-language`）を使わず、backend内の純関数（文字種の正規表現と語数規則）で行う。ネットワーク往復・判定待ち・判定失敗による発声停止をなくす。
- 区間の分割と判定は同じ関数群で行い、分割済み区間を再判定しても同じ言語になること（冪等性）を試験で保証する。
- 単語辞書・語句リストで判定しない。使うのは文字種・大文字小文字・記号の形だけとする（日本語読み辞書 `tts-dictionary` は `ja` 区間の読みにだけ従来どおり適用する）。
- profile名・モデル名をコード・設定・手順に書かない。英語TTSはcatalog capabilityで発見する既存の仕組みを維持する。

## 2. 現状と問題（2026-10-16 レビュー結果）

- `voice-dialogue/service/respond.ts` が回答全文を `languageSource` として渡し、`inference/service/execute.ts` が全文を一度だけRuriで `ja`/`en` に分類し、全区間に同じラベルを使う。
- `voice-dialogue/service/sentences.ts` は句読点と240文字でしか分割せず、言語境界で切らない。
- 結果、日本語主体の回答中の英文はVOICEVOXが日本語読みし、英語主体の回答中の日本語は英語TTSへ送られる。

## 3. 判定規則

### 3.1 文字の分類

| 分類 | 文字 |
| --- | --- |
| J（日本語） | `\p{Script=Hiragana}` `\p{Script=Katakana}` `\p{Script=Han}`、`ー々〆ヶ`、全角英数字（`Ａ-Ｚａ-ｚ０-９`） |
| L（ラテン） | `\p{Script=Latin}` のうち全角を除くもの（アクセント付き文字を含む） |
| N（中立） | 上記以外（半角数字、空白、ASCII記号、和文句読点・括弧、絵文字など） |

### 3.2 run への分割

1. 句（`SpeechSentences` が出す1区間）を J の連続と L の連続に分ける。
2. 2つの L の間にある N が和文の句読点・全角記号（U+3000–303F、U+FF00–FFEF）と改行を含まなければ、両 L と N を1つの L run に結合する（例: `Open the settings`、`version 2.0`、`the → men`）。
3. それ以外の N は直前の run に付ける。ただし開き括弧類（`（「『【〈《[(` など）は直後の run に付ける。句頭の N は最初の run に付ける。

### 3.3 L run の言語

L run 内の語を `/\p{Script=Latin}+(?:['’-]\p{Script=Latin}+)*/gu` で数え、次の語は「通常語」に数えない。

- 略語: 大文字のみ2文字以上（末尾 `s` 可）、または大文字と数字の組合せ（`API` `APIs` `CPU` `MP3`）
- コード・アドレス形: `_` `@` `/` `://` を含む、または英字の間に `.` を含むトークン（`example.com` `snake_case`）
- 語中に大文字を含む語（`iPhone` `JavaScript` `GitHub`）

判定（上から順に適用）:

| 条件 | 言語 |
| --- | --- |
| 句に J が無く、通常語が1語以上 | `en`（例: `Hello!`、`Open the settings.`） |
| 句に J が無く、通常語が0語 | `ja`（例: `API。`、`OK`） |
| 句に J があり、run の全通常語が大文字始まり | `ja`（固有名詞句とみなす。例: `Visual Studio Code を開く`） |
| 句に J があり、通常語が2語以上 | `en`（例: `ここで Open the settings を押す`、`the men は`） |
| それ以外 | `ja`（例: `Docker を使う`、`API キー`） |

閾値（2語）は定数にまとめ、評価表の結果で調整する。語数は文字数ではなく、同じ L run の中で空白等を挟んで連続する語の数で数える。`the men` は2語で `en`。日本語を含む句の中の `ty` は1語で `ja`。ただし日本語を含まない句（`ty!` だけの句、読点で切れた `ty,`）は1行目の規則で `en` になる。`A or B` のように1文字の語も通常語に数える。

### 3.4 区間の組立て

- J run と `ja` 判定の L run を連結して1つの `ja` 区間にする。`en` 判定の L run は単独の `en` 区間にする。隣接する同言語区間は結合する。
- 例: `これは Docker と Open the settings です。` → `ja: これは Docker と` / `en: Open the settings` / `ja: です。`
- 発声できない区間（`[\p{L}\p{N}]` を含まない）は隣の区間へ付け、単独では出さない。

### 3.5 公開関数（`delivery` domain）

新規 `api/domains/delivery/service/speech-language.ts`。`delivery` は他 domain を参照しないため、言語型 `"ja" | "en"` を自前で定義する（構造的に `larm` 側の型と一致）。

```ts
export type SpeechLanguage = "ja" | "en";
/** 1句を言語別の発声区間に分ける。順序と本文（空白の正規化を除く）を保つ。 */
export function speechSegments(clause: string): { text: string; language: SpeechLanguage }[];
/** 1要求の本文の言語。全区間が en のときだけ en、それ以外は ja。 */
export function speechLanguage(text: string): SpeechLanguage;
```

`speechLanguage` は区間に分かれていない任意の本文（設定画面の試聴、runId無しの単独合成、タイマー音声など）にも使う。混在本文は `ja`（日本語TTSと読み辞書）に倒す。

不変条件（試験で保証）: `speechSegments(x)` の各区間 `s` について `speechLanguage(s.text) === s.language`。

## 4. 変更内容

### 4.1 区間分割（voice-dialogue）

- `SpeechSentences.append` が確定した句ごとに `speechSegments(chunk)` を適用し、区間の本文を順に返す。戻り値の型（`string[]`）は変えない。
- これにより通常回答・`replaySentences`・`replaySpeech` の「元回答に含まれる区間か」の検査が同じ分割を共有する。
- 240文字の強制分割で L run が分断された場合はそのまま扱う（分断後の各片を再判定）。

### 4.2 言語決定（inference）

- `execute.ts` の Ruri 判定ブロック（`speechLanguages.select` 〜 `callOptions.speechLanguage` 設定）を、`row.purpose === "tts" && source === "larm" && row.snapshot.larm.englishSpeechEnabled` のとき `speechLanguage(r.input)` を使う同期処理に置き換える。
- 既存の言語別処理は維持する: `en` は日本語読み辞書 `speechText` と話し方判定 `chooseTtsDelivery` を通さない、`voiceAdoption` は `unmeasured`、`localModel` は `tts-english` のmodelを記録。
- 英語TTSが確保できない場合（`speech_tts_target_unavailable`）は、2026-10-16のユーザー指定により、その区間を `ja` として日本語TTSで合成する。同じ試行内で言語を `ja` に変え、日本語読み辞書 `speechText` と話し方判定 `chooseTtsDelivery` を通常の `ja` 区間と同じく適用してから合成をやり直す。`log.warn("inference.english_speech_fallback", { reason: "speech_tts_target_unavailable" })` を残し、attempt の model は日本語TTSのものを記録する。英語TTS以外の失敗（合成エラー・取消・期限切れ）は転送しない。
- 削除: `inference/service/speech-language.ts`（判定キャッシュ）とその試験、`speechLanguages` の生成・`clear()`、`options.sentenceLanguageMs`、`SpeechLanguageError` の `speech_language_*` 分岐と execute 末尾の再送出。

### 4.2.1 クラウドTTSへのフォールバック（既存経路の維持）

2026-10-16のユーザー指定: 日本語TTS（VOICEVOX）も使えない場合は、TTS route の `fallbackId` に設定する Cloudflare Workers AI の TTS へフォールバックする。クラウドTTSは多言語を1つのモデルで扱うため、言語判定・言語別の振分けを行わない。

- 既存の `runAttempts` の経路をそのまま使う: LARM 試行（`en` 区間は英語TTS→不在なら日本語TTS）が `fallbackErrors` に該当する失敗で終わり、route が `larm-preferred` かつ `cloudAllowed` なら `attempt(r, "cloud")` へ進む。以後30秒の cooldown 中は LARM を飛ばしてクラウドへ直行する。
- 言語判定は `source === "larm"` のときだけ行う（現行条件を維持）。クラウド試行では `speechLanguage` を計算せず、`LarmCallOptions.speechLanguage` も設定しない。
- クラウド試行の本文には、現行どおり日本語読み辞書 `speechText` を適用する（英単語の辞書読みを含む。2026-10-16のユーザー判断）。
- `voice-dialogue` の言語区間への分割は route を知らずに行うため、クラウドでも区間単位で要求が出る。各区間は正しい原文順で再生され、内容は変わらない。区間を結合し直す最適化は行わない。
- Cloudflare 接続の設定は別作業（本計画では接続・資源を追加しない）。fixture でクラウド資源を設定し、LARM の両TTSが `larm_inference_503` などで失敗したとき、`en` 区間・`ja` 区間ともにクラウドへ渡り、言語判定ログが出ないことを試験する。

### 4.3 LARM（larm）

削除:
- `service/sentence-language.ts`（`classifySentenceLanguage`・`speechRouting`）
- `LarmPort.classifySentenceLanguage` / `speechRouting`、`speechRoutingSchema` / `SpeechRouting`、`sentenceLanguageDecisionSchema` / `SentenceLanguageDecision`
- Provider role `sentence-language`（`profiles.ts` の型・protocol・endpoint、`speech-providers.ts` の候補選択と `languageProvider` 引数、`connect.ts:405` と `service/index.ts:539-551` の分岐、`config.sentenceLanguageProvider`）

残す:
- `tts-english` role の発見・claim・再claim、`voices(signal, "en")`、`pairedEnglishVoice`。
- `LarmCallOptions.speechLanguage`。型は `contracts/sentence-language.ts` を `speechLanguageSchema` / `SpeechLanguage` だけに縮め、ファイル名も `speech-language.ts` に改める。

catalog に `decision.sentence-language` が載っていても claim しない（試験で確認）。

### 4.4 delivery

- `contracts/sentence-language.ts` の `SpeechLanguageError` を削除。`speech_tts_target_unavailable` は通常の `Error` メッセージとして扱う（larm が既にそう投げている）。
- `SpeechPreparation.languageSource` を削除。

### 4.5 設定（settings）

- `larm.sentenceLanguageEnabled` → `larm.englishSpeechEnabled`（英語区間を英語TTSへ振り分けるか。省略時無効）。
- `larm.sentenceLanguageProvider` を削除。
- `repository/migrate-stored.ts` に、保存文書の `sentenceLanguageEnabled` を `englishSpeechEnabled` へ移し `sentenceLanguageProvider` を落とす冪等な移行を追加する（`connections` の有無に関係なく適用されるよう、早期 return の前に置く）。
- `service/valid.ts` の「分類有効時に LARM 設定が変わったら TTS 試行を無効化」条件を削除する（判定キャッシュが無くなるため不要）。

### 4.6 API・client・Web

- `/api/inference/speech-routing`、`voice-access.ts` の `speechRouting`、`client.speechRouting` を削除。英語TTSの到達確認は `/api/inference/voices?language=en` で行う。
- `respond.ts` と `replaySpeech` の `languageSource` 構築を削除。voice-dialogue の区間再試行から `SpeechLanguageError` と `speech_tts_target_unavailable` の即時失敗判定を削除する（後者は inference 内で日本語TTSへ切り替わるため区間まで届かない）。
- `web/src/errorMessages.ts` の `speech_language_*` 文言を削除する。`speech_tts_target_unavailable` は英語の声一覧（`/api/inference/voices?language=en`）の失敗で引き続き出るため残す。
- 言語の任意指定を合成APIへ公開しない方針は維持する。

### 4.7 scripts・docs・spec

- 削除: `scripts/sentence-language-live.ts`、`scripts/sentence-language-api-live.ts`、`scripts/sentence-language-bench.ts`。
- 更新: `scripts/speech-voice-pair-live.ts`、`scripts/settings-voice-sample-live.ts` の設定キー。`scripts/profile-live.ts` の参照を確認して除去。
- 追加: `scripts/mixed-speech-live.ts --run`。隔離backendに保存済みLARM設定を設定APIで保存し、固定の日英混在回答を区間化→合成し、区間ごとの言語・使用Provider role・model・WAV取得を `verification-reports/mixed-speech-live/`（ローカルの検証記録。リポジトリには含めない）に記録する。
- `docs/larm.md` の文章二分類の節（判定・共有結果・再確認手順）を本計画の内容に書き換える。
- `spec/README.md` で旧計画を「廃案」と記し、本計画を追加する。旧計画の冒頭に廃案の注記を入れる。`spec/verification/ruri-sentence-language-2026-10-12/` は記録として残す。

## 5. 試験

| 対象 | 内容 |
| --- | --- |
| `delivery/test/speech-language.test.ts`（新規） | 評価表（日本語のみ、英語のみ、英文混在、1語混在、略語、固有名詞句、URL・コード、数字・版数、括弧・引用、感嘆・疑問、空白なし混在、全角英字）で区間と言語を検査。全ケースで冪等性と本文順序の保存を検査 |
| `voice-dialogue` の分割試験 | ストリーム追記で句確定後に言語区間へ分かれること、未確定の末尾を早く切らないこと、`replaySentences` と通常回答が同じ区間を返すこと |
| `inference/test/inference.test.ts` | Ruri 関連試験を置換: `en` 区間は `tts-english`・辞書なし・判定なし、`ja` 区間は `tts`・辞書あり、設定無効時は全区間 `tts`、英語TTS不在時は同じ本文を日本語TTSで合成し、辞書・話し方判定が適用され、warn が1件出て attempt の model が日本語TTSになる。英語TTSの合成エラーでは日本語TTSへ転送しない |
| `inference/test/inference.test.ts`（クラウド） | LARM の英語TTS・日本語TTSがともにフォールバック対象の失敗をしたとき、全区間がクラウドTTSへ渡り、`speech_language` 系の判定・`english_speech_fallback` 以外の言語処理が走らない |
| `larm/test/larm.test.ts`・`speech-voice-pair.test.ts` | `sentence-language` 試験を削除し、catalog に分類Providerがあっても claim しないことを追加 |
| `settings/test/settings.test.ts` | 旧キーを持つ保存文書の移行（冪等、厳格parse通過） |
| `voice-dialogue/test/settings-integration.test.ts` | 設定キーの置換と、混在回答が区間ごとに振り分けられる結合試験 |
| `web/src/errorMessages.test.ts` | 削除した文言の追随 |

検証コマンド: `bun run verify -- --domain delivery --domain inference --domain larm --domain voice-dialogue --domain settings`。fixture・live（`mixed-speech-live`）・実機器受入の結果は分けて記録する。

## 6. 受入

- fixture: 上記試験がすべて通る。
- live: `mixed-speech-live` で日英混在回答の `ja`/`en` 区間がそれぞれ日本語TTS・英語TTSで合成され、WAVを取得できる。
- 実機器: 実マイク・スピーカーで、日本語回答・英語回答・日英混在回答・混在回答の再読み上げを含む3往復以上を確認する。声の切替、順序、前音声終了後の次発声、割込みを観測する。音声ファイル取得だけでは実機器受入に数えない。

## 7. 既知の限界

- 規則は文字種と語の形だけを見るため、複数語の一般名詞句（例: 小文字の製品名）や1語の英語の挨拶が日本語文中にある場合など、期待と異なる声になることがある。誤りは声の違いにとどまり、発声は止まらない。
- 区間が細かくなると声の切替と合成要求が増える。合成の先行数（3区間）は変えない。
- 全大文字の英文（`THANK YOU`）は略語扱いで `ja` になる。ハイフン複合語の語中大文字（`Well-Known`）は語数に数えない。ラテン文字・日本語文字以外の文字体系（キリル文字など）は区間にならず `ja` として日本語TTSへ渡る。
- 評価表で誤りが多い型が見つかった場合は、規則の追加か閾値の調整で対応し、語句リストは追加しない。

## 8. 作業順

1. `delivery` の純関数と評価表試験。
2. `SpeechSentences` への適用と分割試験。
3. `execute.ts` の置換、Ruri 判定経路・`SpeechLanguageError`・`languageSource` の削除。
4. `larm` の `sentence-language` role と `speechRouting` の削除。
5. 設定キーの改名と保存文書の移行、`valid.ts` の条件削除。
6. API・client・Web 文言・scripts・docs・spec 索引の整理。
7. 対象 domain の `verify`、live、実機器受入の順で確認。

## 9. 実施記録（2026-10-16）

- 実装: 上記 4.1〜4.7。英語合成が保持中のリースから日本語の声一覧を読むよう変更し、`withProvider` の入れ子による更新待ちの自己待機を解消した。英語TTSの不在はリースごとに1回だけ再確認する。LARM 失敗時の cooldown は英語・日本語の声ごとに分ける（英語TTSの障害で日本語区間をクラウドへ回さない）。
- fixture: 対象 domain の verify 通過、`client/test`・`web/src/errorMessages.test.ts` 通過。独立レビュー1回を実施し、指摘を反映した。
- 未実施: `bun scripts/mixed-speech-live.ts --run`（live）、実機器3往復受入。
