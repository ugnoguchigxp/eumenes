# 会話・Agency・記憶のレビューに基づく修正（2026-10-29）

利用者指示（2026-10-29「全部なおしてください」）・実装済み・fixture 検証済み（live 未実施）。2026-10-29 21:36〜21:38 の失敗をきっかけに、Agency の受け答えから記憶までのコードを読み取り専用でレビューした（Agency・対話の組み立て・記憶の3範囲）。本書は、そこで見つけた欠陥ごとの決定を記録する。

## 1. きっかけ

| 時刻 | 利用者の発言 | 起きたこと | 原因（確認済み） |
| --- | --- | --- | --- |
| 21:36:37 | こんにちは | 「今日は音楽を聴きながら作業をしていますね」と事実でない断定 | `## Memory` の推測（一度の依頼から作った「元気が出る音楽を好む」「火曜の夜（22時頃）にぴたりの音楽を好む」）が「（本人の発言）」として出ていた。9時間前の「3分間、作業を続ける準備」も最近の会話に残っていた |
| 21:36:54 | いやあ、音楽聴いてないけど、 | 66 token・`finish=stop`・本文なしで run が `chat_stream_incomplete` で失敗 | モデルが何も言わずに終えた。思考だけだったかは記録がなく不明（`reasoningChars` を追加済み） |
| 21:37:45 | もうすっかり夜なんで、夜にあう音楽をつくって | `delegate` が3回拒否され、最後は制御文字だけで返事なしのまま完了 | `impact` の付け忘れ。拒否文がログ用の文字列で、何が足りないか分からなかった。拒否も Agency の呼出し回数（4）に数えられ、5回目はツール定義なしで呼ばれた |
| 21:38:57 | （自発発話） | 「夜の時間帯に合う音楽プレイリストを作成するね」と、実行しないことを約束 | 自発発話はツールを持たないのに、会話の system（ツールの規則）を先頭に読む |

## 2. 決定

### 2.1 記憶

| # | 直すこと | 決定 |
| --- | --- | --- |
| M1 | 推測が「本人の発言」と出る（`context-window.ts`） | State の `origin` で出所を分ける。`user_confirmed`・`user_edited` は `user_said`（「本人の発言」）、`agent_inferred`・`admitted_extraction` は `inferred`（「推測」）。ContextWindow 仕様 §4.1 の A3（本人の記憶）と A4（推測を含む）の区別どおり。担当へ渡す記憶の参照（execution references）は State の項目を従来どおり渡し、推測には `inferred: true` を付ける。保存済みの window（出所を分ける前の形）は形式の印 `format: 2` が無いので、次の読み込みで作り直す（その回で `## Memory` が変わり、区切りが入る） |
| M2 | 一度の依頼や、返事への指摘が「好み」として保存される | 記憶の整理（steward `curate-memory`）の指示に規則を2つ足す。依頼（作る・調べる・再生する・設定するよう頼むこと）の内容や対象から、好み・習慣・事実を作らない。会話エージェントの特定の返事への指摘（誤り・作り話の指摘）は、その返事への訂正であり、本人の好み・制約にしない（今後の話し方や振る舞いを本人が求めたときは好みとして書く）。例文は入れない。保存済みの項目は変えない（M1 で「推測」と出る。不要なものは画面から忘れさせる） |
| M3 | `## Memory`（300 token）で、本人の発言が推測より先に落ちうる | 残す順を「本人の発言 → 推測 → 観察（傾向）」にし、その中は従来どおり種類の順・新しい順。見せる順は従来どおり公開の順 |
| M4 | 日付の基準が混在（`validity.ts` はホストのローカル時刻） | Asia/Tokyo の日にそろえる（`profile.ts` の `tokyoDay`） |

### 2.2 対話（ツール呼出し）

| # | 直すこと | 決定 |
| --- | --- | --- |
| D1 | 拒否も Agency の呼出し回数に数えられ、拒否3回で上限に達する | 返事1回の呼出しの上限（拒否を含む）を dialogue が決めて渡す。実行 `MAX_TOOL_CALLS`（4）＋拒否 2 = 6。実行の上限（4）は従来どおり dialogue が数える |
| D2 | 上限の後の最後の呼出しがツール定義なしになり、ツール呼出しを本文に書き、キャッシュも外れる | 上限の後の呼出しも同じツール定義を送り、`toolChoice: "none"` にする（先頭が変わらずキャッシュが効く。LFM で `none` が通ることは 10-28 の測定で確認済み）。上限に達した回の結果には「この返事ではもうツールを使えない」の1行を足す。クラウドの agent（SDK）には tool choice が無いので、`none` の呼出しはツール定義なしで送る |
| D3 | 拒否文にログ用の issues（`validationPath unknown.unknown` など）が入り、何が足りないか書かれていない | 引数の検査で拒否したときは、モデルに `reason` と、直す項目を1行ずつ（`- impact: required（none・create・modify_existing・irreversible）`）返す。値が無い項目は `required` にする。実行側の拒否（担当・確認・予告など）は従来どおり issues を返す |
| D4 | ログでどのツールのどの項目か分からない（`unknown.unknown`） | `validation-log` の許可する名前に、会話のツール名（`memory`・`find_toolchain`・`delegate`・`work`）と引数名（`mode`・`impact`・`toolchain`・`request`・`announcement`・`inputs`・`target`・`refs`・`confirmation`・`todo`・`operation` ほか）を足す。値は従来どおり記録しない |
| D5 | 候補の行は「影響:」、引数名は `impact` | 候補の行を `impact: <最小の値>` にする |
| D6 | `delegate` がすべて拒否で終わった回が `decision: answer` と記録される | `delegate` を呼んでどれも受け付けられなかった回は `decision: rejected`（出力が契約違反） |
| D7 | LFM が `delegate` の `impact` をほぼ書かず（2026-10-29 本番で7回中0回、10-28 の計測で61回中12回）、拒否されても同じ呼び方を繰り返すので、依頼が一度も通らない（利用者指示 2026-10-29 の案 A） | `impact` が無い `execute`・`confirm` を拒否しない。ホストが補う。対象（`target`）を指定した依頼は「既存を変える」（`modify_existing`）、それ以外は `none` とし、従来どおり担当が宣言した最小の影響（`minImpact`）と比べて大きい方を使う。したがって、担当の最小が `modify_existing`・`irreversible` なら確認に回る。ツール定義の `impact` の必須は残す（書けるモデルには書かせる）。書かれた `impact` は従来どおり使う。担当の最小が `create` の担当（音楽・画像など）への「既存を直して」の依頼は、モデルが `impact` も `target` も書かなければ確認なしで実行されうる（受け入れた危険） |

### 2.3 返事なし

| # | 直すこと | 決定 |
| --- | --- | --- |
| R1 | 返事が無い終わり方が2通りの扱い（本文が空なら失敗、制御文字だけなら返事なしで完了） | system は「話すことがなければ本文を書かない」を認めている。会話の呼出しが正常に終わって本文もツール呼出しも無いときは、失敗にせず返事なしで完了する。会話以外の呼出し（記憶の整理など）は従来どおり失敗（コードを `chat_output_empty` に分ける。途切れ・終わりなしは従来どおり `chat_stream_incomplete`）。返事なしで完了した回は `dialogue.no_answer`（`kind` と、それまでに実行した呼出しの数 `count`）を記録する |

### 2.4 Agency

| # | 直すこと | 決定 |
| --- | --- | --- |
| A1 | 自発発話が実行しないことを約束する | 自発発話の配信形式（`utteranceStyle`）に1行足す。この発話では何も実行されないこと、作る・調べる・始める・再生すると約束しないこと。文は dialogue の文脈（`dialogue.contexts.agency.utterance`）に置く |
| A2 | 割り込まれた背景の呼出しを即座に再試行し、前景の開始と重なる | `larm_preempted` は下からの中断（`AbortError`）として Agency に渡す。Agency は中断を再試行せず、隔離（quarantine）の回数にも数えない。中断の呼出しを含む回は `aborted` とし、idle の backoff を使わない |
| A3 | 配信の直前に前景（ASR・TTS・返事）の最中かを見ない | 書き込みの直前に `foregroundBusy()` も確かめ、最中なら配信しない（`stale`） |

### 2.5 入力の組み立て

| # | 直すこと | 決定 |
| --- | --- | --- |
| C1 | 担当名の一覧をそのまま答えると `system_text_copied` で失敗しうる | 写しの検査から担当名の一覧（`[[titles]]` に入る、「、」でつないだ並び）を外す。外すのはその並びを含む行だけで、規則の文は従来どおり検査する。計測（`scripts/context-eval/harness.ts`）も同じ |
| C2 | 30分以上空いた後（`resumed`）も古い4発言が時刻なしで残り、今の話に見える | `resumed` の区切りでは、それまでの発言を最近の会話に残さない（会話の入力仕様 §6.1.1 ⑤ の変更）。続きは State（仕事）と記憶が運ぶ。ほかの区切り（system・記憶の変化、上限、忘却）は従来どおり新しい4発言を残す |
| C3 | 区切りの大きさを、描かないツール履歴・知らせまで含めて数える | ハーネスの `history` が描く範囲だけを数える |
| C4 | 最近の会話を空にしても、State と `## Memory` から前の会話が入る（2026-10-29 利用者指示「ContextWindowに過去の会話記録は残らないように」） | State の仕事に載せる終わった仕事（「通知済み」）は、最近の会話が始まった時刻（最近の会話がなければ区切りの時刻）より後に終わったものだけにする。進行中の仕事と確認待ちは今の状態なので残す。前の発言を全部落とす区切り（`resumed`・手で空にしたとき）では、文脈係の State（話題・決まったこと・未解決・関係する記録）も捨てる。`## Memory` には本人の発言の項目だけを入れる（推測・観察は入れない。記憶のツールの読み取りでは従来どおり全部読める） |
| C5 | 文脈係の State（話題・決まったこと・未解決・関係する記録）が前の会話を運ぶ（2026-10-29 利用者指示「文脈Stateも一旦いらない」） | 文脈係をいったん止める（サーバーで作らない。コードは残す）。文脈係がいない間は、保存済みの文脈係の State も入力に描かない。最近の会話の区切りはホストの決まった規則（強い上限・30分・忘却・system と記憶の変化・手で空にする）だけになる。`## State` はホストの欄（今・仕事・提示中）だけ |

## 3. 変えないもの

- `find_toolchain` を最初に呼ぶ手順。
- 保存済みの記憶の項目と会話の記録（変更・削除しない）。
- 意図判定（shadow）とその記録。
- 二段の手（`decide-then-reply`）の経路（測定で使う）。

## 4. 検証

- 各 domain の `bun run verify -- --domain <name>`（dialogue・memory・steward・larm・inference）と、`api/application/agency` の試験。
- fixture の追加：出所の表示（M1）、残す順（M3）、上限の後の呼出し（D1・D2）、拒否文（D3）、返事なし（R1）、割り込み（A2）、配信直前の確認（A3）、写しの検査（C1）、`resumed`（C2）。
- live（LARM）での確認は再起動の後、利用者の合図で行う。

## 5. 実施記録（2026-10-29）

### 5.1 変更したファイル

| 範囲 | ファイル |
| --- | --- |
| 記憶 | `memory/service/context-window.ts`（出所・形式の印）、`profile.ts`（`inferred`・残す順）、`execution-references.ts`、`validity.ts`、`steward/contexts/curate-memory/instructions-text.context.toml` |
| 対話 | `dialogue/service/generation-loop.ts`（呼出しの上限・上限の後の `none`・拒否文・返事なし）、`generation-handler.ts`（`rejected`・`no_answer`）、`executor-search.ts`・`generation-executor.ts`、`generation-tools.ts`、`result-text.ts`（`推測`・`impact:`・拒否文）、`conversation-output.ts`・`context-system.ts`（一覧の除外）、`conversation-input.ts`（`resumed`・`lastAt`・数え方）、`generation-prepare.ts`・`context-keeper.ts`・`context.ts`、`dialogue/contracts/index.ts`（`maxToolCalls`）、文脈 `generation-loop/tool-limit`・`agency/utterance` |
| Agency | `application/agency/host.ts`（配信形式・配信直前の確認・中断の回）、`llm-port.ts`（割り込み → 中断） |
| 共通 | `infrastructure/chat-stream.ts`（`chat_output_empty`・`reasoningChars`）、`logger.ts`、`validation-log.ts`（名前の許可・`required`）、`inference/service/cloud.ts`（agent への `none`） |
| 文書 | 本書、`spec/README.md`、`spec/conversation-input-spec-2026-10-26.md`（§6.1.1 ⑤）、`docs/logging.md` |

### 5.2 検証（fixture）

| 項目 | 結果 |
| --- | --- |
| `bun run verify -- --domain dialogue --domain memory --domain steward --domain larm --domain inference` | pass（1,273件） |
| `api/application/agency`・`api/infrastructure`・`scripts/context-eval` | 329件 pass |
| 型検査・lint・整形・文脈の生成物（`context:check`） | pass |
| 新しい試験 | 出所の表示（M1、古い window の作り直しを含む）、残す順（M3）、Asia/Tokyo の日（M4、3つのタイムゾーン）、呼出しの上限と上限の後の `none`・拒否文・`rejected`（D1〜D3・D6）、`required` と名前の許可（D3・D4）、返事なしと途切れの区別（R1）、クラウドの agent への `none`、割り込みの中断・backoff（A2）、配信直前の確認（A3）、一覧の除外（C1）、`resumed`（C2、間の表示を含む） |
| 修正を外すと落ちることの確認 | A2・A3 の試験 |

独立レビュー（1回）の指摘8件は、すべて上の表に含めて直した（保存済み window の作り直し、割り込みを隔離に数えない、クラウドの agent への `none`、`no_answer` の呼出し数、拒否文を1項目1行、一覧の行だけを除外、計測の写しの検査、`docs/logging.md`）。

### 5.3 再起動後の不具合（2026-10-29 22:51、run `121fa7a9`）

再起動の直後、30分以上空いた後の「こんばんは」に、古い4発言（答えていない「夜にあう音楽をつくって」と、自発発話の「作成するね」）が残っていた。記憶の窓の作り直し（M1 の形式の印）で「記憶が変わった」（`memory_changed`）が先に判定され、従来の「新しい4件を残す」区切りになったため。モデルはその依頼の続きとして `find_toolchain` 2回・`delegate` 4回（すべて `impact` なしで拒否）を呼び、返事なしで終わった。C2 の判定を、ほかの理由（忘却・system・記憶の変化）より先にした。間が空いていれば、理由が重なっても古い発言を残さない（試験を追加）。

同じ run で、`delegate` は4回とも `impact` なしで拒否された。LFM に戻した後の本番では7回中0回、10-28 の計測では61回中12回しか `impact` を書いていない（Qwen はどの計測でも書く）。D7 で、`impact` なしの依頼をホストが補うようにした（`execute`・`confirm`。試験：補って依頼が通る、対象付きは確認に回る、`request` なしは従来どおり拒否）。dialogue の verify は pass（463件）。

### 5.4 最近の会話を手で空にする（利用者指示 2026-10-29）

古い依頼が最近の会話に残り続ける場合のために、区切りを最新の発言の後ろへ動かす操作を足した。会話の記録は消さない。次の入力には前の発言が入らず、その後のラウンドは通常どおり残る。run が待ち・実行中のときは断る（409 `conversation_busy`）。

| 入口 | 形 |
| --- | --- |
| API | `POST /api/conversations/:id/recent/clear` → `{ ok: true }` |
| CLI | `bun run cli -- recent-clear [conversationId]` |
| ログ | `dialogue.input_cut`（`reason: user_cleared`） |

試験：空にした次の回は前の発言が無く、その次の回は残る。実行中は断り、終われば空にできる。

### 5.5 未実施

- live（LARM）での確認。反映には再起動が要る。
- 保存済みの記憶の項目（一度の依頼から作った好み、指摘から作った好み）は変更していない。M1 で「推測」と表示される。
