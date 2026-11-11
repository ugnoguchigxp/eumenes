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
- **調べものの機能選択**: `toolchain:web.research@…` だけ（承認不要のもの）。他の機能には回さない。なければ、承認が要る・予算超過と同じく「できなかった」として agent に返す（10秒ごとの再試行にしない）。サーバーからの個別指定は不要（既定がこの選択）。研究 ticket は checkpoint の保存が他の変更で競合しても、すぐ取り直して開始する。
- **LLM**: purpose は think。agent の呼び出しには `input` が無いので、旧の入力ガードの代わりに世代（利用者の言葉・訂正・忘却で増える）と中止信号で古さを判定する。reasoning は設定がなければ low（出力 400〜1500 トークンを使い切らせない）。出力上限 2400 は agent の要求（最大 1500）以内。
- **返事**: system には Eumenes の人格・感情規則の外側に、パッケージの `agendaReplySystem` の「仕組み」〜「返事の仕方」の範囲を加える（`always-on-system.ts`）。状態（記憶・メモ・調査記録・静かな時間・`askIfFits`）は `agendaReplyMessages` が作る状態メッセージを、利用者の最後のメッセージの前に差し込む（プロンプト先頭は変わらない）。返事はどのターン（通知・作業報告・引き渡しも）でも agenda の道具と状態を持つ。agenda が使えない間（runtime が always-on でない、Memory が不健全、台帳なし）は system からも agenda の規則を外す（`agencyReplyParts(settings, agenda)`）。道具は `start_preparation` `read_note` `show_note` `set_quiet`（`find_toolchain` / `delegate` は Router の host 操作なので渡さない）。呼び出し上限は host の道具の上限に3を足す。返事の道具呼び出しは次の返事の履歴として agent の `said` に入る。
- **返事の根拠**: 返事に渡した記憶・メモ・状態が引く参照（`memory:` / `note:` / 利用者のメッセージ）を `AgencyLayerPort.replyInputInTransaction(runId)` で採用時に Memory から取り直し、run の入力に加える。一つでも失われていれば（採用前に忘却）その返事は採用せず、一度だけ書き直し、それでも失われていれば `memory_stale` で失敗する。
- **発話・調べものの根拠**: ticket の `refs` に加えて、モデル呼び出しが見たもの（利用者の直近の発言と、そのとき有効な記憶）を入力に含める。どれかが忘却されると発話・調べものを実行せず、保存済みの ticket も落ちる。計画が作る item の `refs` は従来どおり（依頼・約束した item は依頼の言葉に結ぶ）。
- **steer**: サーバーに `createSteeringInbox` を一つ（`server-services.ts`）。`switching-host` の dialoguePort も `steeredInTransaction` / `replyInputInTransaction` を転送する。返事ごとに `createAgendaReplySteering`（`holdsText: false`）で target を開き、chat をラップする。返事の最中に届いた利用者のメッセージは、フィードが commit 後に `send` する。メッセージ本文は ストアから都度読み直し、忘却済みなら渡さない。
  - 二重返事の防止: 返事の run が終わるとき、モデル呼び出しが取ったメッセージ id を `AgencyLayerPort.steeredInTransaction(runId)` で受け、`generation-settle.ts` が同じ transaction でその pending 発話を log に取り込む（折り込まれた発話と同じ扱い）。次の run は `utterance_handled` で終わる（引き渡しの返事が取った言葉も同じ）。非ストリームの LARM 経路は、その呼び出しのメッセージ（steer・agenda の状態入り）で答える。run の記憶（Memory の入力）にも加えるので、忘却はその返事にも及ぶ。返事が採用されなかったときは pending のまま残り、次の run が答える。最後のモデル呼び出し中に届いたものは取られず、これまで通り次の run が答える。
- **記憶の書き込み**: steward が continuity から書くので agenda の memory writer は足していない。計画・関心のメモ（profile）も未接続。

## 保存・忘却

- agent の `snapshot`（依頼・約束した調べもの、静かな時間）と研究 ticket とメモだけが残る。再起動後、実行中だった調べものは待ち状態に戻り、同じ item に新しい ticket が来たら動いている台帳の仕事を引き継ぐ（二重実行しない）。
- 参照は利用者のメッセージ id、`memory:<id>`、`note:<id>`。忘却は実行中の agent と保存済みの記録の両方に届き、依存する item・ticket・メモ・台帳の仕事（実行データを含む）を消す。旧 always-on の記録は起動時に失効する。
- 発話・調べものの根拠は、実行の直前に Memory から取り直した入力（`referencedInput`）。一つでも忘却されていれば実行しない。

## 残っていること

- 設定を変えると host が作り直され、記録は失効する（旧と同じ。約束も消える）。約束を残すには、失効の条件を関連する設定だけに絞る必要がある。
- 返事の状態（記憶・メモ）は呼び出し時に作る。作った後〜採用前に忘却が起きた場合は、既存の古さ検査で返事が採用されないことに任せている。
- Live への発話の提案は、受け付けられた時点で「言った」と数える（実際に話されたかは未確認）。
- 返事で使ったメモの `show_note` は、pursuit の Markdown 文書（Docling `eumenes` / `research/<題>.md`）ではなく、メモ本文を会話に出す。
- 利用者の TODO（会話内の仕事）を agent の観測にする旧の経路（`attachWork`）は、今回は接続しない（no-op。決定済み）。
- 旧 always-on の記録は起動時に失効するが、その観測を保管した Memory の Record（`agency/observation`）と観測表は孤児として残る（決定済み。掃除は別途）。
- 試験: `always-on.test.ts` ほか agency の4ファイルと `dialogue/test/steer-settle.test.ts`。既存の `action-kinds.test.ts`（task の報告リソース）は取込前から失敗している。
