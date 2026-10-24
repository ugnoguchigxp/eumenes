# agency の発話の感情と TTS の抑揚 設計案 2026-10-24

eumenes_agency の設計（`eumenes_agency/spec/emotion-design.md`）を Eumenes 側に適用する。agency が発話ごとに選ぶ感情（絵文字ひとつ、15 種）を保存し、読み上げの調子とアバターの動作に使う。

## 1. 現状（2026-10-24 調査、コードの読み取りのみ）

- **agency の発話は自動では読み上げられない。** 自動の読み上げ（`web/src/domains/voice-dialogue/hooks/automatic.ts`）は run の回答（`run.answerMessageId`）だけを対象にする。`runId: null` の agency の発話は、会話の欄で再生を押したときだけ鳴る（`ConversationPanel.tsx` の replay）。
- 再生は `POST /api/voice/replay/audio` → `replaySpeech`（`voice-dialogue/service/index.ts`）。run のない文は `{deliveryScope: "chunk"}` だけで合成され、LARM が文ごとに文脈なしで感情を判定する（`inference/service/attempt-work.ts` の `chooseTtsDelivery`）。
- 外から感情を渡す口は `SpeechPreparation.delivery`（version 2、chunk 以外）だけで、本番のコードはまだ使っていない。
- 保存済みの感情（`answer_deliveries`）は `run_id` が鍵で、run のないメッセージには付けられない。
- 声のスタイル（`style_id`）は設定で固定。感情で変わるのは話速・音高・抑揚（`speech-delivery.v1.json` の `presets`）だけ。
- 前景の通常の応答の感情は LARM の判定だけで決まる（対話の LLM は感情を出さない）。

## 2. 変更

### 2.1 感情の種類（delivery）

- `emotionSchema` に agency の種類を足す: `enjoyment`・`wry`・`admiration`・`relief`・`shy`・`confusion`・`sadness`・`apologetic`・`worry`・`dislike`・`anger`（`joy`・`curiosity`・`surprise` は既存、agency の `calm` は `none`）。
- 利用者の決定（2026-10-24）: 通常の応答も普段から感情があってよい。**ただし、LARM の態度の判定は 6 ラベル固定の学習済み分類器**（`api/domains/larm/service/context.ts` の `assertAttitudeQuestions`、学習データは `attitude-dataset`）で、基準文を足すだけでは種類を増やせない。通常の応答に 15 種を使うには、データの追加と再学習が要る（§3 の決めること 3）。今回は、判定のラベル（`emotionSchema`、6 種）を変えず、配信が持てる感情（`deliveryEmotionSchema`、17 種）を別に足す。`SpeechDelivery.emotion`、`performance`、Web の絵文字の表だけが 17 種を使う。
- `speechToneSchema` に 3 つ足す（初期値。耳で調整する）:

| tone | [話速, 音高, 抑揚] | 用途 |
| --- | --- | --- |
| `soft` | [-0.1, -0.04, -0.35] | 悲しい |
| `wry` | [-0.03, -0.02, 0.15] | 苦笑 |
| `firm` | [0.03, -0.04, 0.2] | 怒り |

- `performance`（感情 → 動作・調子）:

| 感情 | 動作 | 調子 |
| --- | --- | --- |
| none（平静） | neutral | natural |
| joy | joyful | excited |
| enjoyment | joyful | bright |
| wry | agreeing | wry |
| curiosity | curious | bright |
| admiration | agreeing | bright |
| relief | agreeing | gentle |
| shy | shy | gentle |
| surprise | surprised | excited |
| confusion | thinking | serious |
| sadness | downcast | soft |
| apologetic | downcast | gentle |
| worry | listening | gentle |
| dislike | distant | serious |
| anger | distant | firm |

- `delivery.source` に `host` を足す（ホストが渡した感情。LARM の判定ではない）。

### 2.2 発話の感情の保存（conversation）

- migration で `message_deliveries`（`message_id` 主キー、`conversation_id`、`delivery` JSON）を足す。メッセージを読むときに `answer_deliveries`（run 経由）と合わせて引く。
- agency のホストは、発話を `appendInTransaction` するのと同じトランザクションで、感情があれば保存する（`source: "host"`、`emotionConfidence: 1`）。感情が `null` なら保存しない（従来どおり LARM の判定になる。黙った置き換えをしない）。
- メッセージの感情のアイコン（`MessageList.tsx`）は、この保存も読む。

### 2.3 読み上げ

- `replaySpeech` は、メッセージ ID に保存した感情があれば `preparation.delivery` に渡す。`chooseTtsDelivery` は、ホストが渡した感情を chunk の単位でも使う（発話全体で同じ感情。LARM の判定は呼ばない）。
- 動作は既存の `X-Avatar-Motion` で返る。

### 2.4 agency の発話の自動読み上げ

自動の読み上げ（`useAutomaticSpeech`）が対象にするのは完了した run の回答だけで、run のない agency の自発の発話は鳴らない（完了報告は通知の run の回答なので鳴る）。利用者の決定（2026-10-24）: 自発の発話も随時読み上げてよい。

- `useAutomaticSpeech` は、run の回答に加えて、新しく現れた `agency:` のメッセージもキューに入れる（開いた時点の履歴は読まない、という既存の扱いも同じ）。
- 自動の読み上げが OFF のとき、利用者の音声の発話の最中、ほかの読み上げの最中の扱いは既存と同じ（キューで順に、OFF なら捨てる）。
- 読み上げは §2.3 の保存した感情を使う。

### 2.5 設定とログ

- 設定 `agency.emotion`（既定 ON）。OFF なら、ホストは `utteranceEmotion` を渡さない（感情を選ばせない）。
- ログ `agency.delivered` に感情の名前を足す（本文は残さない）。

### 2.6 同梱の agency

`utteranceEmotion`・`Decision.emotion`・`ActionTicket.emotion` を含む版に更新する。

## 3. 決めること

1. ~~agency の自発の発話を自動で読み上げるか~~ → 随時読み上げる（2026-10-24 決定、§2.4）。
2. ~~通常の応答の種類を広げるか~~ → 広げたい（2026-10-24 決定）。
3. 通常の応答の 15 種化の方法（§2.1）: (a) LARM の態度分類器を新ラベルで再学習する（`attitude-dataset` に例を足す）、(b) 対話の LLM が回答と一緒に絵文字を一つ返す（前景のプロンプトと出力の形が変わる。プロンプトの別作業の後）。未決。

## 5. 実装の記録（2026-10-24）

- delivery: `deliveryEmotionSchema`（判定の 6 種＋11）、調子 `soft`・`wry`・`firm`、`source: "host"`、`hostDelivery(emotion)`。`chooseTtsDelivery` と `execute` の準備は、`host` の配信を chunk の単位でも使う（判定を呼ばない）。
- conversation: migration `conversation/0009-message-delivery`（`message_deliveries`）。run のないメッセージを `delivery` 付きで `appendInTransaction` すると、同じトランザクションで保存する（表がなければ黙って捨てずに失敗）。読むときは run の配信を優先し、なければメッセージの配信。
- 読み上げ: `POST /api/voice/replay/audio` に `messageId`。run のない文は、そのメッセージの `host` の配信を、そのメッセージの文のときだけ使う。Web の再生は run のないメッセージの ID を渡す。
- 自動の読み上げ: `useAutomaticSpeech` は、新しく現れた `agency:` のメッセージも順に読む（開いた時点の履歴、OFF の間に来たものは読まない）。
- agency のホスト: 設定 `agency.emotion`（既定 ON）で `utteranceEmotion` を渡し、発話の気持ちを `hostDelivery` にして発話と一緒に保存する（agency の `calm` は `none`）。ログ `agency.delivered` に `emotion`（名前だけ）。設定画面の切り替えは未追加。
- 同梱の agency を d4cec5c の版に更新した（`utteranceEmotion`・`ActionTicket.emotion`）。独立レビュー（2026-10-24）で重大な指摘なし。軽微な指摘（`messageId` の上限、仕様の列名）は直した。

## 4. 試験

- delivery: 新しい感情と調子・動作の対応、判定の基準文がすべての種類（agency が選ばない `warmth`・`empathy` を含む）にあること、`host` の感情が chunk の単位でも使われ判定が呼ばれないこと。
- conversation: `message_deliveries` の保存と読み出し、run のあるメッセージは従来どおり。
- agency のホスト: 感情つきの発話が同じトランザクションで保存される、`null` なら保存しない、設定 OFF で `utteranceEmotion` を渡さない。
- 読み上げの調子は耳で確かめる（利用者）。
