# Agencyのagendaエージェント取込（always-on runtimeの置き換え）

2026-11-11の取込依頼に基づく。設定値 `agency.runtime: "always-on"` はそのまま残し、その裏で動くものを `eumenes-agency` 0.1.6 の agenda エージェント（`eumenes-agency/agenda`）に置き換えた。モードやトグルは足していない。F は変更なし。返事の途中に届いた利用者の言葉は `eumenes-steer` 0.1.0 で、その返事の次のモデル呼び出しへ渡す。

## 何を何に置き換えたか

| 旧（always-on） | 新（agenda） | 場所 |
| --- | --- | --- |
| 会話ごとの AlwaysOnAgent と heartbeat | 会話ごとの `createAgendaAgent`。次の実行は `agent.nextAt` のタイマー（待ち時間は足さない） | `always-on-scope.ts` `always-on-host.ts` |
| tick と ticket（speak / ask / prepare） | `step` が返す research / speak の ticket。追跡は host が行う | `always-on-cycle.ts` |
| アウトボックス → observation | 利用者の言葉 → `observe(user)`、返事 → `observe(reply)`、訂正 → 旧版を忘れて `<id>:c<seq>` で観測、撤回 → `forget` | `always-on-feed.ts` |
| 発話と準備の配信 | 発話は `agency:<scope>:<ticket>` のまま `persistSpeech`（Live 経由・受領・自動音声の規則を維持）。調べものは `startInTransaction`（承認・同時数・日次上限を維持） | `always-on-flow.ts` |
| 結果の取込（workReturned） | 台帳の結果 → メモ化 → `researchReturned`。採用は同じ writer で保存し、確定後に agent へ反映 | `always-on-cycle.ts` `always-on-memory.ts` |
| checkpoint（観測を Memory へ保管） | `kind: "agenda"` の封筒。agent の約束（`snapshot`）、研究 ticket、メモだけを保存。言葉は保存しない | `contracts/agency-always-on.ts` `always-on-checkpoint.ts` |
| 返事（runRespond + 旧 State 行） | 同じ `runRespond` に agenda の状態・道具・steer を足す | `always-on-ports.ts` |

外側のインターフェース（recover / start / close / dialoguePort / conversationAgent / attachWork / forget* / attend / status / inspect）、busy（注意リース・前景の推論・進行中の run）、active 会話だけが動く規則、設定ダイジェストによる失効は旧と同じ。

## 継ぎ目と決定

- **発話間隔**: 設定は 10/60/600 秒、agenda は 10/60/300 秒。600 は 300 として読む（設定契約は変更しない）。台帳の `claimDispatch` は epoch の栅としてだけ使い、間隔は 0 にした。間隔は agent 自身の規則で、調べものの開始が発話を遅らせない。
- **メモの出どころ**: 会話ごとのドキュメント一覧 API はない。台帳が返した結果（実行結果の `answer` / `summary` / `claims` / `sources` / `document.title`）を、調べものを頼んだ ticket の `refs` つきのメモにして checkpoint に持つ（最新30件、本文は最大8000字）。`read_note` はこれを読む。`show_note` は、その返事が採用されて assistant メッセージが現れた後に、本文を `agency-note:<scope>:<runId>:<noteId>` のメッセージとして会話に出す（返事と調べものにつき1件。`agency:` ではないので自動音声で読み上げない）。Web 由来の文書なので、モデルへ渡す履歴には入れず（`recordSpoke` しない）、Memory はブロックして学習しない。採用されなかった返事は表示しない。pursuit が保存する Markdown 文書とは今は結ばない。
- **調べものの機能選択**: `toolchain:web.note@…` だけ（承認不要のもの。Codex の検索による調べもの、[web-note-codex-search-2026-11-11](web-note-codex-search-2026-11-11.md)）。`web.research`（Pursuit の深い調査）や他の機能には回さない（2026-11-11 までは `web.research`）。結果は題・要約・Markdown 本文・出典を持ち、そのままメモになる。なければ、承認が要る・予算超過と同じく「できなかった」として agent に返す（10秒ごとの再試行にしない）。サーバーからの個別指定は不要（既定がこの選択）。研究 ticket は checkpoint の保存が他の変更で競合しても、すぐ取り直して開始する。
- **LLM**: purpose は think。agent の呼び出しには `input` が無いので、旧の入力ガードの代わりに世代（利用者の言葉・訂正・忘却で増える）と中止信号で古さを判定する。reasoning は設定がなければ low（出力 400〜1500 トークンを使い切らせない）。出力上限 2400 は agent の要求（最大 1500）以内。
- **返事**: system には Eumenes の人格・感情規則の外側に、パッケージの `agendaReplySystem` の「仕組み」〜「返事の仕方」の範囲を加える（`always-on-system.ts`）。状態（記憶・メモ・調査記録・静かな時間・`askIfFits`）は `agendaReplyMessages` が作る状態メッセージを、利用者の最後のメッセージの前に差し込む（プロンプト先頭は変わらない）。返事はどのターン（通知・作業報告・引き渡しも）でも agenda の道具と状態を持つ。agenda が使えない間（runtime が always-on でない、Memory が不健全、台帳なし）は system からも agenda の規則を外す（`agencyReplyParts(settings, agenda)`）。道具は `start_preparation` `read_note` `show_note` `set_quiet`（`find_toolchain` / `delegate` は Router の host 操作なので渡さない）。呼び出し上限は host の道具の上限に3を足す。返事の道具呼び出しは次の返事の履歴として agent の `said` に入る。
- **返事の根拠**: 返事に渡した記憶・メモ・状態が引く参照（`memory:` / `note:` / 利用者のメッセージ）を `AgencyLayerPort.replyInputInTransaction(runId)` で採用時に Memory から取り直し、run の入力に加える。一つでも失われていれば（採用前に忘却）その返事は採用せず、一度だけ書き直し、それでも失われていれば `memory_stale` で失敗する。
- **発話・調べものの根拠**: ticket の `refs` に加えて、モデル呼び出しが見たもの（利用者の直近の発言と、そのとき有効な記憶）を入力に含める。どれかが忘却されると発話・調べものを実行せず、保存済みの ticket も落ちる。計画が作る item の `refs` は従来どおり（依頼・約束した item は依頼の言葉に結ぶ）。
- **steer**: サーバーに `createSteeringInbox` を一つ（`server-services.ts`）。`switching-host` の dialoguePort も `steeredInTransaction` / `replyInputInTransaction` を転送する。返事ごとに `createAgendaReplySteering`（`holdsText: false`）で target を開き、chat をラップする。返事の最中に届いた利用者のメッセージは、フィードが commit 後に `send` する。メッセージ本文は ストアから都度読み直し、忘却済みなら渡さない。
  - 二重返事の防止: 返事の run が終わるとき、モデル呼び出しが取ったメッセージ id を `AgencyLayerPort.steeredInTransaction(runId)` で受け、`generation-settle.ts` が同じ transaction でその pending 発話を log に取り込む（折り込まれた発話と同じ扱い）。次の run は `utterance_handled` で終わる（引き渡しの返事が取った言葉も同じ）。非ストリームの LARM 経路は、その呼び出しのメッセージ（steer・agenda の状態入り）で答える。run の記憶（Memory の入力）にも加えるので、忘却はその返事にも及ぶ。返事が採用されなかったときは pending のまま残り、次の run が答える。最後のモデル呼び出し中に届いたものは取られず、これまで通り次の run が答える。
- **記憶の書き込み**: steward が continuity から書くので agenda の memory writer は足していない。
- **計画・関心のメモ（profile）**: パッケージの `updateProfile` を、返事が会話に入った後に裏で一回走らせる（返事は待たない。パスは直列）。メモは checkpoint の `profile`（最新の本文、基点、直近12パスの本文と読んだ利用者の言葉の id）に持ち、agent の `profile` と返事の状態（plans / interests）に渡す。忘却は、その言葉を最初に読んだパスの前までメモを戻す（それ以後のパスの追加分も一緒に消える。保守的）。忘却をまたいだ書き込みは採用しない。返事の根拠（上記）にも、メモを書いた言葉を含める。
- **返事の言い直し**: 採用する返事の本文に `dropRepeatedSentences` をかける。ストリームで既に出た重複は取り消せないが、保存される本文・agent の `said`・計画は一度の形になる。
- **返事の履歴**: 返事が呼んだ agenda の道具と答えは、返事を会話に出すとき utterance の `toolCalls` として保存し、agenda が返事を担う会話では次の返事の履歴に assistant の `tool_calls` + `tool` メッセージとして戻す（`recentMessages`、`servesRepliesInTransaction`）。F では従来どおり言葉のみ。同じ条件で、会話の最初の利用者の発言も履歴に残す（`## Memory` はその最初のメッセージに付ける）。
- **ルーターが処理した返事**: 返事の出どころによらず、会話に出た assistant メッセージはフィードが `who:"reply"` で観測し、`infoChanged` を呼ぶ（計画が見る）。返事が失敗したときも `infoChanged`。
- **調べものの上限**: agenda の調べもの（台帳の `agenda` 記録が根拠のもの）は `agency.actions` の同時数・日次の上限に数えない（承認の要否は従来どおり。同時には agent が一つずつ進める）。F の行動の上限は従来どおり。
- **返事の system の整合**: agenda が返事を担うとき、F の事実規則（「Webで調べることはできず約束もしない」）の代わりに `contexts/agency/talk-facts.context.toml`（調べものは `start_preparation` で頼める）を使い、`always-on-reply` の「許可された読取りで確かめます」を外した。`.s11tnext` の catalog は `bun run context:build` で作り直した（`context:check` 通過）。
- **時計と出力の余裕**: agent と返事の時計は CLI の形式（日本時間・曜日つき「2026/11/11(水) 14:02」）。agenda の呼び出し（独立した制御呼び出しで推論水準を名指すもの）は、見える出力の上限に 2800 トークンの余白を足す（`attempt-work.ts` の `INDEPENDENT_THINKING_HEADROOM_TOKENS`。取り込み上限 2400 は変えない）。
- **小さなこと**: 通知・作業報告の返事は問いを足さない（`askIfFits` なし）。道具呼び出しの上限は通知でも4（host の道具に3を足す、ただし4を下回らない）。

## 保存・忘却

- agent の `snapshot`（依頼・約束した調べもの、静かな時間）と研究 ticket とメモだけが残る。再起動後、実行中だった調べものは待ち状態に戻り、同じ item に新しい ticket が来たら動いている台帳の仕事を引き継ぐ（二重実行しない）。
- 参照は利用者のメッセージ id、`memory:<id>`、`note:<id>`。忘却は実行中の agent と保存済みの記録の両方に届き、依存する item・ticket・メモ・台帳の仕事（実行データを含む）を消す。旧 always-on の記録は起動時に失効する。
- 発話・調べものの根拠は、実行の直前に Memory から取り直した入力（`referencedInput`）。一つでも忘却されていれば実行しない。

## 残っていること

- メモは会話ごとに30件（利用者単位の保管ではない）。
- 利用者の入力中・前景の応答中は step 全体を止める（計画・調べものも止まる。参照ホストは発話だけ止められる）。
- 返事の履歴の tool 呼び出しは、agenda が返事を担う会話で保存した分だけ。agenda 導入前の返事には無い。
- ルーターが処理した返事は、メッセージが会話に出た時点で観測する（出さない run は agent に見えない）。

- 設定を変えると host が作り直され、記録は失効する（旧と同じ。約束も消える）。約束を残すには、失効の条件を関連する設定だけに絞る必要がある。
- 返事の状態（記憶・メモ）は呼び出し時に作る。作った後〜採用前に忘却が起きた場合は、既存の古さ検査で返事が採用されないことに任せている。
- Live への発話の提案は、受け付けられた時点で「言った」と数える（実際に話されたかは未確認）。
- 返事で使ったメモの `show_note` は、pursuit の Markdown 文書（Docling `eumenes` / `research/<題>.md`）ではなく、メモ本文を会話に出す。
- 利用者の TODO（会話内の仕事）を agent の観測にする旧の経路（`attachWork`）は、今回は接続しない（no-op。決定済み）。
- 旧 always-on の記録は起動時に失効するが、その観測を保管した Memory の Record（`agency/observation`）と観測表は孤児として残る（決定済み。掃除は別途）。
- 試験: `always-on.test.ts` ほか agency の4ファイルと `dialogue/test/steer-settle.test.ts`。既存の `action-kinds.test.ts`（task の報告リソース）は取込前から失敗している。

## steer は Eumenes のもの（eumenes-agency 0.1.7）

agency の配布物には steer を含めない（利用者、2026-11-11）。agency は返事の途中に足された言葉の受け口（`AgendaAddedWords`）と、返事の規則が読む印（`addedWordsLine`）だけを持つ。Eumenes は `api/application/agency/agenda-steer.ts` で、サーバーの eumenes-steer の受付箱（`vendor/steer`、5ba40df6）をこの受け口につなぐ。返事は書きながら流れるので、最後のモデル呼び出しの途中に届いた言葉は、その返事に取り込まず、会話の次の run が答える。
