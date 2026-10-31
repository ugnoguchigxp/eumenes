# TTSの二重再生・別ボイスの原因と、1本のTTS実行・重複排除の設計

## 状態

合意済み（2026-11-01 利用者「では実装開始してください」）・S1〜S3 実装済み・fixture 検証済み（§8）。backend・Web の再起動と、2画面での実機受入は未実施。

利用者の依頼（2026-11-01）:「TTSが２重でながれたり、別のTTSボイスで再生されたり挙動がおかしいです。このあたりのロジックを詳しく調べて改善案を考案してください。TTSはシングルスレッドで、未生成のTTSは重複チェックし排除する動きにしたいのと、そもそも二重でリクエストされる状態にしたくないです。」

初版の判断点への回答（2026-11-01）:

- D1「担当が変わるのはやむを得ないですが、これはeumenesのサブ人格みたいなもので、それぞれがTTSを発話するイメージではないです。発話できるのは会話エージェント、またはサブエージェントと切り替えている時だけですね。タスクが終了次第、会話エージェントが発話する」→ §4.1 発話者の規則。初版の「担当の画面」は、専門担当と紛らわしいため「再生する画面」（§4.2）と言い換えた。
- D2「429が出ているなら発話しなくてもいい。429に限らずTTSエラーなら。」→ §4.6。
- D3「TTSを1系統でまとめるはそのとおり、ただ例外があって、通知音、メッセージは別でもう1系とあるとします。この2系統がそれぞれキューを持ち、同時に再生されない＆重複再生されない様にします」→ §4.4。

関連: [完了音声の重複調査](completion-audio-duplication-2026-10-31.md)（発生元は未特定のまま）、[TTSの停止原因と本文ストリーミング](tts-sql-stall-and-streaming-design-2026-10-27.md)。

## 1. 観測（ログ）

2026-10-27 21:06〜2026-11-01 のinferenceログ（直近10,000行）で、TTS成功は474件（LARM 471、クラウド 3）。クラウドの3件はすべて LARM の `larm_inference_429` の直後の代替で、3件とも別のTTSが同時に実行中だった。英語の句（`speech_language_selected kind=en`）は6件で、これは設計どおりの英語用の声。

| 時刻（JST） | 起きたこと | 同時に走っていたTTS |
| --- | --- | --- |
| 2026-11-01 06:10:49 | agencyの自発発話が届いた直後、`POST /api/voice/replay/sentences` が **1ms差で2回**。2つの読み上げが並行し、片方の1句目が LARM 429 → クラウドで7.1秒後に完成。両方がその後も次の句を要求し続けた | 別の読み上げの1句目（LARM、233ms） |
| 2026-10-31 21:35:14 | 音声入力の回（run `af69349a`）の返事を音声対話がchunkで合成中に、同じ回の `replay/sentences` が1回。replay側の句が LARM 429 → クラウド | 音声対話の `:speech:1`（LARM） |
| 2026-10-31 20:48:26 | `replay/sentences` が **2ms差で2回**。片方が 429 → クラウド。声の一覧の取得も429 | 別の読み上げ |

1つの画面の `useReplay.play` は前の再生を止めてから始めるため、同じ画面で2つの読み上げは並行しない。`replay/sentences` を呼ぶのは画面ごとに1つの `useReplay` だけなので、06:10と20:48の並行は **2つの画面（タブ・ウィンドウ・端末）がそれぞれ同じ発話を読み上げた** ものと判断した。21:35は、音声対話の画面では `ownsSpeech` で除外される回のため、別の画面からの自動読み上げと推定する（ログに画面IDがないため断定はできない）。

## 2. 原因

| # | 原因 | 場所 | 結果 |
| --- | --- | --- | --- |
| C1 | 自動読み上げの判定が画面ごとに独立している。既読（`seen`）と音声対話の所有（`ownsSpeech`）は画面のメモリ内だけで、他の画面と共有しない | `web/src/domains/voice-dialogue/hooks/automatic.ts` | 開いている画面の数だけ同じ回答・自発発話を読み上げる（二重再生） |
| C2 | 音声対話の回の所有は、マイクを使った画面にしかない | `machine.ts` の `ownedSpeech` | 別の画面は音声対話の返事を自動読み上げで重ねて読む（21:35） |
| C3 | backendのTTSに同時実行の上限がない。`withProvider` は lease を貸すだけで、要求を並べない | `api/domains/larm/service/with-provider.ts`、`inference/service/execute.ts` | LARM の TTS が同時要求を 429 で断る |
| C4 | TTSの経路が「LARM優先・クラウド代替あり」で、429もクラウド代替の対象（`fallbackErrors`）。代替後は同じ鍵で30秒の cooldown を置く | `inference/service/errors.ts`、`execute.ts` の `runAttempts` | Workers AI の声で読まれる（別ボイス）。cooldown が効くと30秒間クラウドの声が続き得る（今回のログでは未発生） |
| C5 | まだ生成していない同じTTSをまとめる仕組みがない | `voice-dialogue/service/index.ts` の `replaySpeech`・`replayAudio` | 中断直後の再要求や重複要求が、そのまま別のTTS要求になる |
| C6 | 画面内の出力が、音声セッション・replay用・通知用の別々の `createAudioController` に分かれている。TODO・Kanban・Claude Code の完了通知音（`chime`）は読み上げ中でも待たない | `replay.ts`、`useTimerTone.ts`、`useNotificationAudio.ts` | 読み上げと通知音、通知の読み上げが重なり得る |

## 3. 目標

| # | 規則 |
| --- | --- |
| G1 | 発話するのは Eumenes ひとり。会話エージェント、または切り替えて話している専門担当だけが発話する |
| G2 | 1つの発話・通知は、開いている画面の数によらず **1回だけ** 要求・再生する |
| G3 | 画面の再生は「発話」と「通知」の2系統。それぞれがキューを持ち、**同時に鳴らさず、重複して鳴らさない** |
| G4 | backend の TTS 生成は **同時に1件**。後の要求は先着順に待つ |
| G5 | まだ生成を終えていない同じ入力の TTS は、**1回の生成にまとめ**、2回目の要求を LARM へ送らない |
| G6 | TTS が失敗した句は発話しない。再試行も別の声への代替もしない |

## 4. 設計

### 4.1 発話者の規則（G1）

自動で読み上げる対象を、その時点の話し手のものに限る。

| 対象 | 読み上げ |
| --- | --- |
| 主会話の回の最終回答（`specialistSessionId = null`）。完了した委任タスクの報告の回（`sourceKind = notice`）を含む | する（会話エージェント） |
| 最終回答のない完了回の受付発話（`announcement`） | する（会話エージェント） |
| agency の自発発話（`agency:` のメッセージ） | する（会話エージェント） |
| 専門担当のセッションの回の最終回答 | そのセッションが今の話し相手（`active`）のときだけする。戻った後・終了後に完了した回は読まない。結果は会話エージェントの報告で話す |
| 通知のメッセージ（タイマーなど） | 発話ではなく通知の系統で鳴らす（§4.4） |

専門担当に別の声を割り当てる仕組みは今もなく、この変更でも作らない。話し手が変わっても声は設定の1つの声のまま（英語の句の英語用の声は従来どおり）。

### 4.2 再生する画面（G2）

既存の画面の存在通知（`PUT /api/inference/screen/:id`、`useScreenPresence`）に、音を出す画面を1つだけ決める判定を足す。再生する画面でない画面は、自動読み上げも通知音も鳴らさない（画面の表示は続ける）。再生する画面が変わるのはやむを得ないものとし、話し手は変わらない。

| 条件（上から順） | 再生する画面 |
| --- | --- |
| マイクの音声セッションを開いている画面がある | その画面（複数なら最後に開いた画面） |
| 利用者の操作（pointerdown・keydown）を報告した画面がある | 最後に操作した画面 |
| どちらもない | 最後に登録した画面 |
| pagehide・90秒の期限切れ | 候補から外す（既存の期限） |

画面が背面（`visibilityState=hidden`）でも外さない。声で使う間は別のアプリを見ていることがあるため。

```json
// PUT /api/inference/screen/3f0c…   本文
{ "revision": 12, "active": true, "sentAt": 1761945049000,
  "gestureAgeMs": 1690, "voiceSession": false, "leaving": false }

// 200 応答
{ "playbackScreen": true }
```

- 操作の報告は、操作時に存在通知を送る（5秒に1回まで）。操作の時刻は端末の時計ではなく経過ms（`gestureAgeMs`）で送り、backend が自分の時計に直す。再生する画面が変わったら既存の変更通知で各画面に知らせ、各画面は `GET /api/inference/screen/:id` で自分がそうかを問い直す（変更通知は全commitで届くため、1画面あたり1秒に1回まで）。
- 再生する画面でなくなった画面は、2系統のキューを捨てて再生中の自動読み上げ・通知音を止める。利用者が押した再生（手動のreplay）は止めない。
- 再生する画面でない間に届いた発話は既読にするだけで、後からさかのぼって読まない（会話を開いた時に履歴を読まない今の規則と同じ）。

### 4.3 発話・通知の一回限りの確保（G2）

再生する画面の切り替わりの瞬間や、変更通知の遅れでも二重にならないよう、自動の発話と通知は再生の前に backend で対象を確保する。最初の確保だけが成功する。

```json
// POST /api/voice/speech-claims
{ "screenId": "3f0c…", "sourceKey": "message:agency:main.f6d7b706-1" }

// 200 { "claimed": true }
// 409 { "error": "not_playback_screen" }         再生する画面でない
// 409 { "error": "speech_already_claimed" }      別の画面が確保済み
// 409 { "error": "speech_owned_by_voice_turn" }  音声対話の回（chunkで再生済み・再生中）
// 409 { "error": "speech_not_speaker" }          §4.1 の話し手でない
```

| 対象 | `sourceKey` |
| --- | --- |
| 回の最終回答 | `run:<runId>:answer` |
| 最終回答のない完了回の受付発話 | `run:<runId>:announcement:<revision>` |
| agencyの自発発話 | `message:<messageId>` |
| TODO・Kanban・Claude Code の完了通知 | `notice:<source>:<id>` |

- 確保は voice-dialogue domain のメモリに10分（最大512件）保持する。再起動で消えても、画面は再接続時に既存の発話を既読にするため読み直さない。
- `run.utteranceId` に音声対話の回が結びつく回は、どの画面からも自動読み上げで確保できない（C2の対策。21:35の事例）。
- §4.1 の判定は backend でも行う（`speech_not_speaker`）。画面の判定と食い違っても読み上げない。
- 手動のreplayと、既存の claim/lease を持つタイマー通知はこの確保を使わない。

### 4.4 再生の2系統（G3）

画面の出力は1つ（音声セッション中はそのcontroller、それ以外は画面ごとに1つの出力用controller）にし、2つのキューがそれを使う。

| 系統 | 中身 | 重複の鍵 | 取消 |
| --- | --- | --- | --- |
| 発話 | 音声対話のchunk、自動読み上げ、手動の再生 | 発話は `sourceKey`、句は `sourceKey` と句の番号 | barge-in・mute・停止で未再生分を捨てる（今と同じ）。手動の再生は今の発話を止めて始める（今と同じ） |
| 通知 | 通知音（タイマー、TODO・Kanban・Claude Code の完了SE、完了音声）と通知メッセージの読み上げ | タイマーは `notificationId`、完了通知は `sourceKey` | 通知の既存の取消・既読のまま。発話の取消では捨てない |

| 規則 | 内容 |
| --- | --- |
| 系統内 | 先着順に1件ずつ。鍵が同じものがキューにある・再生中・再生済みなら、もう入れない |
| 系統間 | 同時に鳴らさない。発話が1つの発話を読んでいる間（句の間を含む）は通知が待つ（今のタイマー通知の待ちと同じ）。通知が鳴っている間は、発話の次の句がその終了を待つ |
| 両方が待つとき | 発話を先に、通知は発話の切れ目で |
| タイマーの繰り返し | 2.5秒ごとの繰り返しの間に発話が始まったら、次の繰り返しはその発話の後 |

今は読み上げ中でも鳴る完了通知音（C6）は、この規則で発話の切れ目まで待つようになる。

### 4.5 TTSを1本で生成する（G4・G5）

inference domain に TTS の実行レーン（新規 `inference/service/speech-lane.ts`）を置く。

| 項目 | 規則 |
| --- | --- |
| 対象 | `executeRequest` の `purpose="tts"` すべて（音声対話のchunk、replay、通知の読み上げ、声のサンプル）。LARM の試験画面（playground）の直接呼出しは対象外 |
| 同時実行 | 1件 |
| 順序 | 先着順。優先順位は付けない |
| 待ち時間 | 要求の期限（TTSは45秒）に含める。待つ間に取り消された要求は列から外し、LARM へ送らない |
| 実行中の取消 | 今と同じく接続を切って次へ進む |

重複の統合（G5）は、まだ結果を返していない standalone の TTS（`speak`・`speakWithDelivery`。replay・通知・サンプルが使う）に適用する。音声対話のchunkは発話と句の順番ごとに一意で、受領を1件ずつ確定するため統合しない。

| 項目 | 規則 |
| --- | --- |
| 同じ入力の鍵 | 句の文字列（そのまま）、設定のrevision、声の上書き（`speechOverride`）、`SpeechPreparation` の全体。どれか1つでも違えば別の要求 |
| 統合 | 同じ鍵の要求が待機中か実行中なら、新しい推論要求を作らずに、その結果を一緒に受け取る |
| 取消 | 合流したすべての呼出し元が取り消したときだけ、元の要求を取り消す |
| 生成済みの結果 | 再利用しない（キャッシュは作らない）。統合するのは未生成の間だけ |
| 記録 | 推論要求・利用量の記録は元の1件だけ。回への delivery の記録は、今と同じく各呼出し元が同じ値で行う |

### 4.6 TTSの失敗（G6）

TTS のエラーは429に限らず、その句を発話しないで終える。再試行も、クラウドなど別の声への代替もしない。

| 項目 | 変更 |
| --- | --- |
| 経路の設定 | `routes.tts.mode` は `larm-only` か `cloud-only` だけを受け付ける（`larm-preferred` は schema で拒否）。`cloudAllowed` は「この用途でクラウド送信を許可」のまま残す（`cloud-only` に必要）。保存済みの `larm-preferred` は移行で `larm-only` にする（今の保存値は LARM優先・代替あり → LARMのみ）。設定画面は `settings.ai-connections` rev 9 で、読み上げの使い方から「LARMを優先・クラウドへ自動切替」を外し、代替先の欄を「読み上げ：クラウドのモデル」とした。LLM・ASR の経路は変えない |
| 実行 | TTS は選んだ経路の1回だけ。429でも cooldown を置かない |
| 音声対話のchunk | 句ごとの最大3回の再試行（`isRetryableSpeechError`）をやめ、失敗した句を飛ばして次の句へ（飛ばす処理は既存） |
| replay・自動読み上げ | 失敗した句を飛ばして次の句へ。どの句も発話できなかったときだけ、手動の再生は既存のエラー表示を出す。自動読み上げは表示しない |
| 通知メッセージ | 今と同じく、読み上げに失敗しても通知音は鳴らす |
| 英語の句 | 英語用の声が LARM にないときに日本語の声で読む既存の規則（`speech_tts_target_unavailable`）は残す。主の声のままなので声は変わらない |

### 4.7 診断ログ

本文・音声・設定は出さない。

| イベント | 項目 |
| --- | --- |
| `voice.speech_claimed` / `voice.speech_claim_rejected` | `screenId`、`sourceKey`、`reason` |
| `inference.speech_lane_waited` | `inferenceId`、`waitMs`、`queueLength` |
| `inference.speech_joined` | `inferenceId`（元の要求）、`count`（合流数） |
| `voice.speech_skipped` | `inferenceId`、`reason`（TTSの失敗で飛ばした句） |
| 確保の記録 | `screenId` を許可済みログ項目に追加。`sourceKey` は `subjectId` に入れる。replay の HTTP ログへの画面IDの追加は、確保の記録で発生元を追えるため行わない |

## 5. 変更しないこと

- 句の分け方、声・速度などの設定、英語の句を英語の声で読む規則。LLM・ASR の経路と代替。
- 音声対話のchunk再生、barge-in、mute、Live音声中の除外、会話を開いた時に履歴を読まない規則。
- 手動のreplayが今の発話を止めて始めること。タイマー通知の既存の claim/lease と、実行中は通知を待たせる既存の条件。
- 可聴出力はブラウザー内だけ（backendは生成まで）。

## 6. 段階と検証

| 段階 | 内容 | domain | 検証 |
| --- | --- | --- | --- |
| S1 | TTSレーンと未生成の統合（4.5）、TTSの失敗（4.6）、診断ログ | inference、voice-dialogue、settings、Web settings | 同時2要求でLARMへの同時送信が1件／待機中の取消でLARMへ送らない／同じ鍵の2要求で推論要求1件・両者が同じ音声を受け取る／片方だけの取消で元の要求が続く／429・5xxでクラウドを使わず句を飛ばす／保存済み `larm-preferred` の移行。`bun run verify -- --domain inference --domain voice-dialogue --domain settings` |
| S2 | 発話者の規則（4.1）、再生する画面（4.2）、確保（4.3） | inference、voice-dialogue、dialogue、Web voice-dialogue | 2画面で再生する画面だけが鳴らす／切替で止まる／同じ`sourceKey`の2回目が409／音声対話の回が409／終了した専門担当の回を読まない／手動replayは影響なし |
| S3 | 再生の2系統（4.4） | Web audio・voice-dialogue・dialogue・kanban | 系統内で重ならない・同じ鍵を2回鳴らさない／読み上げ中の完了通知音が切れ目まで待つ／通知中の発話が終了を待つ／barge-inで通知を捨てない |

Web の試験は対象の試験ファイルを個別に実行する。fixture・live・実機器の結果を分けて記録する。受入は利用者が2つの画面（例: 2つのタブ）を開いた状態で、自発発話・入力した質問・音声入力の返事・完了通知が各1回だけ、同じ声で、重ならずに聞こえること。反映には backend と Web の再起動が必要で、再起動は利用者が行う。

## 7. 決定事項

| # | 点 | 決定 |
| --- | --- | --- |
| D1 | 発話する者 | 会話エージェント、または切り替えて話している専門担当だけ（§4.1）。再生する画面の決め方は §4.2 の推奨のまま |
| D2 | TTSの失敗 | 429に限らず発話しない。再試行・代替なし（§4.6） |
| D3 | 再生の系統 | 発話と通知の2系統。それぞれキューを持ち、同時に鳴らさず重複させない（§4.4） |

## 8. 実装と検証の記録（2026-11-01）

### 実装

| 段階 | 主な変更 |
| --- | --- |
| S1 | `inference/service/speech-lane.ts`（同時1件・先着順・待機中の取消は送らない・待機中の期限切れは `speech_lane_timeout`）を `executeRequest` の `purpose="tts"` に適用。`voice-access.ts` で未生成の同一TTSを統合（全員の取消で中止、完了時に `inference.speech_joined` を元の要求IDで記録）。`settings` の schema・既定値・保存文書の移行、`settings-structures.ts`、`settings.ai-connections` rev 9、`useSpeechModels.ts`。`synthesis.ts` の句の再試行と `isRetryableSpeechError` を削除し、失敗した句は `voice.speech_skipped`。replay は失敗した句を飛ばす |
| S2 | `screen-presence.ts` に再生する画面の判定（音声セッション → 最後の操作 → 最後の登録、`leaving` で除外、背面でも保持）と変化の通知。PUT は `{ playbackScreen }` を返し、GET を追加。`voice-dialogue/service/speech-claims.ts` と `POST /api/voice/speech-claims`。Web は `useScreenPresence`（背面でも30秒ごとに報告）、`useScreenSound`、`useAutomaticSpeech`（再生する画面・話し手・確保）、`useNotificationAudio`（完了通知音の確保。TODO・Kanban・Claude Code）、タイマー通知は再生する画面でなければ確保しない |
| S3 | `web/src/domains/audio/screen-output.ts`（1画面1出力、発話と通知の2系統、通知は整理券の先着順、発話が先、鳴っている通知の終了を句が待つ）。replay・`useTimerTone`・音声対話のchunkが使う。起動済みの共有出力は通知の取消・失敗で閉じない。タイマー通知の10秒は通知の順番が来た時から数え、待ちは確保の期限内に収める。完了通知音は60秒以内に鳴らせなければ捨てる |

設計からの変更: `cloudAllowed` は送信許可として残した（§4.6）。replay の HTTP ログへの画面IDの追加は行わず、確保の記録で追う（§4.7）。

### 独立レビュー

1回実施。high 0件。medium 2件（変更通知ごとのGET、通知の取消で共有出力を閉じる）と low 6件（タイマーの10秒に待ちを含む、Claude Code の完了音が未確保、端末の時計ずれ、レーン待ちのタイムアウトの識別、完了通知音の無期限の待ち、統合ログの要求ID欠落）をすべて修正した。

### 検証（fixture）

`bun run verify -- --domain inference --domain voice-dialogue --domain settings --domain audio --domain dialogue --domain kanban --domain timers --domain terminals` は全13工程が pass（backend 1,103件・Web 258件成功、静的検査は選択domain内の違反0）。ただし並行作業のファイルが実行中に変わったため、run は `invalidated`（`verification-reports/runs/2026-10-31T22-36-06-487Z-…/report.json`）。範囲外の警告（size-budget 7・型 5・format 2・domain表 1）は並行作業の capacity wait の分。domain に属さない Web 試験は個別に実行し成功（`useScreenPresence`・通知・タイマー等 113件）。`web/src/workspace/shell-artifact.test.tsx` の1件と `client/test/settings-tasks.test.ts` の2件（`live` の期待値なし）は、今回変えていない経路の既存の失敗として残した。

live・実機器: 未実施。backend と Web の再起動後、2つの画面を開いた状態で、自発発話・入力した質問・音声入力の返事・完了通知が各1回だけ、同じ声で、重ならずに聞こえることを確認する。
