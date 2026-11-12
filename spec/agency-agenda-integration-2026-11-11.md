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
- **メモの出どころ**: 会話ごとのドキュメント一覧 API はない。台帳が返した結果（実行結果の `answer` / `summary` / `claims` / `sources` / `document.title`）を、調べものを頼んだ ticket の `refs` つきのメモにして checkpoint に持つ（最新30件、本文は最大8000字）。`read_note` はこれを読む。`show_note` は、その返事が採用されて assistant メッセージが現れた後に、メモを Markdown ドメインの文書にして、その文書を付けた `agency-note:<scope>:<runId>:<noteId>` のメッセージを会話に出す（返事と調べものにつき1件。`agency:` ではないので自動音声で読み上げない。本文は題と要約だけで、メモの本文は会話に入れない）。Web 由来の文書なので、モデルへ渡す履歴には入れず（`recordSpoke` しない）、Memory はブロックして学習しない。採用されなかった返事は表示しない。詳細は下記「メモは Markdown 文書として表示する」。
- **調べものの機能選択**: `toolchain:web.note@…` だけ（承認不要のもの。Codex の検索による調べもの、[web-note-codex-search-2026-11-11](web-note-codex-search-2026-11-11.md)）。`web.research`（Pursuit の深い調査）や他の機能には回さない（2026-11-11 までは `web.research`）。結果は題・要約・Markdown 本文・出典を持ち、そのままメモになる。なければ、承認が要る・予算超過と同じく「できなかった」として agent に返す（10秒ごとの再試行にしない）。サーバーからの個別指定は不要（既定がこの選択）。研究 ticket は checkpoint の保存が他の変更で競合しても、すぐ取り直して開始する。
- **LLM**: purpose は think。agent の呼び出しには `input` が無いので、旧の入力ガードの代わりに世代（利用者の言葉・訂正・忘却で増える）と中止信号で古さを判定する。reasoning は設定がなければ low（出力 400〜1500 トークンを使い切らせない）。出力上限 2400 は agent の要求（最大 1500）以内。
- **返事**: system には Eumenes の人格・感情規則の外側に、パッケージの `agendaReplySystem` の「仕組み」〜「返事の仕方」の範囲を加える（`always-on-system.ts`）。状態（記憶・メモ・調査記録・静かな時間・`askIfFits`）は `agendaReplyMessages` が作る状態メッセージを、利用者の最後のメッセージの前に差し込む（プロンプト先頭は変わらない）。返事はどのターン（通知・作業報告・引き渡しも）でも agenda の道具と状態を持つ。agenda が使えない間（runtime が always-on でない、Memory が不健全、台帳なし）は system からも agenda の規則を外す（`agencyReplyParts(settings, agenda)`）。道具は `start_preparation` `read_note` `show_note` `set_quiet`。`find_toolchain` / `delegate` は配布物のもの（`delegatedTo` の調べもの）ではなく host の道具で、利用者の発言に答える会話の返事に渡す（2026-11-12 改訂。[Router の設計](router-package-integration-2026-11-04.md)の「会話の返事から担当に頼む道」。返事の規則は配布物の `toolchains: true` の範囲）。呼び出し上限は host の道具の上限に3を足す。返事の道具呼び出しは次の返事の履歴として agent の `said` に入る。
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

## 思考の表示（2026-11-11 追加）

参照ホストの CLI（`eumenes_agency/standalone/agenda.ts` の plan 表示）と同じく、agenda が考えたことを会話欄に出す（利用者の依頼、2026-11-11。吹き出しにせず表示だけ）。

| 種類（`kind`） | いつ | 表示の例 |
| --- | --- | --- |
| `plan` | step の計画が item を足した | `💭 + 調べる: 週末の天気（土曜に出かける予定）` |
| `drop` | 計画が item を落とした | `💭 - 週末の天気（もう答えた）` |
| `check` | 調べものの重複確認が new 以外 | `💭 一部は調べ済み（n1a2b3c4 と同じ）: 日曜の降水確率` |
| `repeat` | 問いを聞かないことにした | `💭 聞かない（もう聞いた）: 何時に出ますか — 先ほど聞いた` |
| `decline` | 発話を書く呼び出しが見送った | `💭 見送り: 週末の天気 — 今は作業中` |
| `research` | 調べものを渡した（受付拒否・できなかったも） | `🔎 [頼まれた] 週末の天気` / `🔎 週末の天気（受付拒否）` |
| `researched` | 調べものの結果が返った | `📝 週末の天気: 土曜は晴れ…` |
| `profile` | 予定と関心のメモを書いた | `🗓 土曜に出かける予定` |
| `quiet` | 返事が静かな時間を変えた | `🤫 30分、自分から話しかけません（調べものは続けます）` |
| `error` | 計画の呼び出し・step が失敗した | `⚠ 考えられませんでした（llm_timeout）` |

- **保存しない**: 会話ごとに最新100件をサーバーのメモリーに持つだけ（`AgendaScope.thoughts`）。会話のメッセージにも checkpoint にも入れない。だから読み上げ・Memory の学習・モデルへの履歴・エクスポートのどれにも入らない。再起動で消える。
- **忘却**: 思考は参照を持たないので、その会話で何かが忘却されたら全部消す（保守的）。
- **配信**: `GET /api/agency/conversations/:id/thoughts` → `{ thoughts: [{ id, at, kind, text }] }`。思考が増えた・消えたときは SSE の change を出す（`AgencyHostDeps.publish`）。F の host は常に空。
- **画面**: 会話欄で、各思考をその後に書かれた最初のメッセージの前に置く（それより新しいものは最後のメッセージの後）。`.agency-thought` の薄い1行で、吹き出し・読み上げボタン・完了の読み上げ通知はない。古いメッセージを畳んでいる間は、その時刻の思考も畳む。
- ログには思考の本文を出さない（従来どおり件数・理由コードだけ）。

## 参照ホスト（CLI）との挙動差の解消（2026-11-12）

利用者の依頼（2026-11-12「agenda cli とほぼ同じ挙動になるように」）。切替後のログ（2026-11-11 23:25〜2026-11-12 08:35）で、音声ターン27回のあと step が一度も走っていなかった。agent（パッケージ）は変えず、Eumenes が agent に渡す「忙しい」「いつ言ったか」「何を見たか」を参照ホストに合わせる。

| # | 参照ホスト（CLI） | これまでの Eumenes | 決定 |
| --- | --- | --- | --- |
| 1 | 入力中は最後のキーから4秒（`typingIdleMs`）。送信で解ける | 入力欄に文字がある間ずっと入力中。音声認識の文字はターン後も欄に残るので、音声会話では常に入力中だった | 画面は「利用者が自分で書いた文が直近4秒以内に変わった」ときだけ `typing` と報告する。音声認識が入れた文字、書きかけのまま置いた下書き、送信後は入力中ではない（`web/src/workspace/useAgencyAttention.ts` の `useTyping`。下記「2026-11-12 改訂」と同じ修正） |
| 2 | 言葉は表示された瞬間に「言った」。間隔（15秒・60秒・設定値）はそこから数える | 返事はメッセージの作成時刻、自分からの発話は保存時刻から数える。読み上げの時間を数えないので、長い読み上げの直後に話し出しうる | 画面が読み上げる言葉は、**読み上げが終わった時刻**に「言った」とする。返事は `observe(reply)`、自分からの発話は `recordDelivery` を、その時刻で agent に渡す（`always-on-heard.ts`） |
| 3 | 再起動は新しいセッション（会話は空から） | サーバーの再起動は利用者には会話の途中。agent の作業記憶（会話・質問待ち・最後に話した時刻）だけが消え、空の会話で計画していた | scope を作るとき、会話の最新60件（agent が持つ件数 `SAID_KEPT`）を元の時刻で agent に見せ直す（`recallConversation`） |
| 4 | agent が出した発話はその場で出る | 保存の瞬間に忙しい（入力・音声認識・読み上げ）と失敗扱いで10秒先送りし、文を書き直す | 忙しいだけなら同じ文を持ったまま、忙しさが終わるのを待って出す。待っている間に利用者が話したら、その場で待ちを解いて出さない（従来どおり失敗として agent に返す。step は塞がない） |

### 2 の規則（聞き終えた時刻）

| 状況 | agent に渡す時刻 |
| --- | --- |
| その会話を表示している画面がない | 現れた時刻（CLI と同じ。待たない） |
| 画面があり、3秒以内に読み上げが始まった（または既に読み上げ中） | 読み上げが終わった時刻（画面の `playing` が false になった時） |
| 画面はあるが3秒たっても読み上げが始まらない（自動読み上げなし・消音） | 現れた時刻 |
| 聞き終える前に利用者が話した・返事が始まった・サーバーが終了する | その時点（現れた時刻より前にはしない） |
| 聞き終える前に返事が訂正・撤回・忘却された | agent に渡さない（訂正後の言葉は新しい言葉として同じ規則で渡す）。自分からの発話は従来どおり「言った」と数える |

- 聞き終えるまで、その会話は busy（計画と発話は止まる。読み上げ中は元から止まっていた。待っている調べものの開始は下記「2026-11-12 改訂」のとおり止めない）。返事は、聞き終えた時に agent が観測し、計画とメモ書きはそこから始まる。
- 「画面がある」は、その会話の注意リース（`leaving` でないもの）があること。読み上げの判定は既存の `playing`（返事・自分からの発話・Live の音声）で、契約は変えない。
- 自分からの発話は、保存した後〜聞き終えるまで agent の中で「出している途中」。この間にサーバーが落ちると、約束した報告（`promised`）はもう一度言うことがある（通常の終了では聞き終えた扱いにして保存する）。

### 3 の規則（会話の読み直し）

- 対象はフィードと同じ（利用者と assistant のメッセージ。アーティファクト表示・Memory がブロックしたもの・`agency-note:` は除く。画像の参照文は付ける）。自分からの発話（`agency:`）は agent の言葉（`reply`）として見せる。
- 読み直した言葉は、予定と関心のメモ書きには「読んだ」ものとして渡す（古い言葉を新しい証拠にしない）。
- 利用者の古い言葉は、その後に頼まれた静かな時間（保存済み）を終わらせない（読み直しの後で戻す）。
- 試験: `always-on-heard.test.ts`（聞き終えた時刻の規則）、`always-on-pace.test.ts`（間合い・読み直し・保留）、`always-on-activity.test.ts`。
- 見送ったこと: 答えのない自分からの発話の回数（`unanswered`）は戻らない。計画の item（約束以外）は最初の計画が作り直す。

## 保存・忘却

- agent の `snapshot`（依頼・約束した調べもの、静かな時間）と研究 ticket とメモだけが残る。再起動後、実行中だった調べものは待ち状態に戻り、同じ item に新しい ticket が来たら動いている台帳の仕事を引き継ぐ（二重実行しない）。
- 参照は利用者のメッセージ id、`memory:<id>`、`note:<id>`。忘却は実行中の agent と保存済みの記録の両方に届き、依存する item・ticket・メモ・台帳の仕事（実行データを含む）を消す。旧 always-on の記録は起動時に失効する。
- 発話・調べものの根拠は、実行の直前に Memory から取り直した入力（`referencedInput`）。一つでも忘却されていれば実行しない。

## 残っていること

- メモは会話ごとに30件（利用者単位の保管ではない）。
- 利用者の入力中・前景の応答中は、計画と発話を止める（agent 自身の規則）。待っている調べものの開始は止めない（下記「2026-11-12 改訂」）。
- 返事の履歴の tool 呼び出しは、agenda が返事を担う会話で保存した分だけ。agenda 導入前の返事には無い。
- ルーターが処理した返事は、メッセージが会話に出た時点で観測する（出さない run は agent に見えない）。

- 設定を変えると host が作り直され、記録は失効する（旧と同じ。約束も消える）。約束を残すには、失効の条件を関連する設定だけに絞る必要がある。
- 返事の状態（記憶・メモ）は呼び出し時に作る。作った後〜採用前に忘却が起きた場合は、既存の古さ検査で返事が採用されないことに任せている。
- Live への発話の提案は、受け付けられた時点で「言った」と数える（実際に話されたかは未確認）。
- 返事で使ったメモの `show_note` は、Markdown ドメインの文書として表示する（下記「メモは Markdown 文書として表示する」。2026-11-12 までは、メモ本文を会話のメッセージとして出していた）。
- 利用者の TODO（会話内の仕事）を agent の観測にする旧の経路（`attachWork`）は、今回は接続しない（no-op。決定済み）。
- 旧 always-on の記録は起動時に失効するが、その観測を保管した Memory の Record（`agency/observation`）と観測表は孤児として残る（決定済み。掃除は別途）。
- 試験: `always-on.test.ts` ほか agency の4ファイルと `dialogue/test/steer-settle.test.ts`。既存の `action-kinds.test.ts`（task の報告リソース）は取込前から失敗している。

## steer は Eumenes のもの（eumenes-agency 0.1.7）

agency の配布物には steer を含めない（利用者、2026-11-11）。agency は返事の途中に足された言葉の受け口（`AgendaAddedWords`）と、返事の規則が読む印（`addedWordsLine`）だけを持つ。Eumenes は `api/application/agency/agenda-steer.ts` で、サーバーの eumenes-steer の受付箱（`vendor/steer`、5ba40df6）をこの受け口につなぐ。返事は書きながら流れるので、最後のモデル呼び出しの途中に届いた言葉は、その返事に取り込まず、会話の次の run が答える。


## 入力中・応答中でも頼まれた調べものを始める（2026-11-12 改訂、利用者の決定）

2026-11-11 夜〜11-12 朝、音声で話している間じゅう agency が一度も動かず、頼んだ調べものが再起動まで（7時間以上）始まらなかった。原因は二つで、どちらも直した。

| 原因 | 直したこと | 場所 |
| --- | --- | --- |
| 画面が「入力欄に文字がある」ことを入力中（`typing`）と報告していた。音声の認識文は入力欄に入ったまま残るので、音声で一度話すと、画面が見えている間ずっと入力中になった | 入力中は「利用者が自分で書いた文が、直近 4 秒以内に変わった」ときだけ（参照ホストの `typingIdleMs` と同じ）。音声が入れた文と、置いたままの下書きは入力中ではない | `web/src/workspace/useAgencyAttention.ts` の `useTyping` |
| busy（入力中・再生中・前景の推論・進行中の run）の間は step そのものを止めていたので、返事が `start_preparation` で引き受けた調べものも、静かになるまで始まらなかった | busy の間も、待っている調べもの（open の research、実行中が無いとき）があれば step を1回走らせる。agent は busy の間、計画と発話を自分で止めるので、走るのは重複確認と調べものの開始だけ。同じ待ちの組に対しては1回だけ（始められなかった分は静かになってから）。利用者の発言で中止された step は、もう一度試す | `always-on-cycle.ts` の `mayStep` / `researchWaiting`、`always-on-host.ts` の `arm` |

- busy でない間の動き（`agent.nextAt` のタイマー）は変えていない。
- 会話が active でない・host が止まっている・復旧中は、従来どおり何も走らない。

## メモは Markdown 文書として表示する（2026-11-12、利用者の決定）

「agency に組み込まれている表示は外し、すでにある Markdown のドメイン形式でメモを表示する」。`show_note` がメモ本文を会話のメッセージに書く表示をやめ、詳しい Web 調査の報告（[web-research-markdown-design-2026-11-08](web-research-markdown-design-2026-11-08.md)）と同じ Markdown ドメインの生成文書にした。

| 項目 | 内容 |
| --- | --- |
| いつ | 調べものが返ってメモになったとき（2026-11-12 改訂。下の「メモを Markdown に蓄積する」）。`show_note` はその文書を会話に出す |
| 文書 | `markdown.generated` の所有者 `agency-note`。題はメモの題、本文はメモの Markdown そのまま。ローカルは scratch の `<題>.md`、Docling がつながっていれば `eumenes` の `notes/<日付>_<題>_<noteId>.md` へ新規保存（既存の Queue・PUT 1回・GET 照合を共用） |
| 同じメモ | 会話とメモから決まる固定の文書 id。何度表示しても文書は1つ。再起動でローカルが失効し、Docling へ未送信だった文書だけ作り直す（送信結果が不明のものは作り直さない） |
| 会話 | 保存の終端を待ってから（最長 210 秒）、文書を資源として会話に登録し、`agency-note:` のメッセージのチップにする。本文は題と要約 |
| 画面 | メッセージが届いたら、その文書を Markdown の画面で開く（Docling 保存済みなら既存の Plate 編集、ローカルだけなら読み取り専用の Plate 表示）。画面を開いたときに既にあったメッセージは自動では開かず、チップから開く（`web/src/workspace/useShownNotes.ts`） |
| 失敗 | scratch も Docling も使えない・保存の期限切れは、メッセージを出さず `agency.show_note_failed` を記録する |
| 忘却 | メモが忘却されたら、ローカルのファイルと生成文書の記録を消し、保存待ちは止める。Docling へ確定保存された文書は利用者の文書として残す（調査報告と同じ） |

- 場所: `api/application/agency/note-documents.ts`（`NoteDocumentPort` の実装、`server-services.ts` で接続）、`always-on-flow.ts` の `showNote`。
- 保存待ちはサーバーのメモリー上で行う。待っている間に再起動すると、そのメッセージは出ない（文書は Markdown の一覧に残る）。
- 試験: `api/application/agency/note-documents.test.ts`（Docling あり・なし）、`always-on.test.ts`、`web/src/workspace/useShownNotes.test.tsx`。


## agency の調べものは会話のルーターの候補にしない（2026-11-12）

2026-11-12 10:10〜10:12（JST）、URL を貼った調査依頼と「はい、開いてみて」（メモを表示するかへの返事）が 3 回続けて「うまく頼めませんでした」で終わった。どれも、ルーターの構造解析（`turn-structure-v8`）が発言を「既存の仕事の取消」（`control`）に当て、host がその取消を実行できなかった結果である。取消先は agency 自身の調べものだった。

| 回 | 発言 | 取消先に選ばれたもの | 取消が失敗した理由 |
| --- | --- | --- | --- |
| 1 | URL ＋「これとか調べて見てもらえますか？」 | `t89`（そのとき実行中だった agency の調べもの） | 選ばれた直後に調べものが終わった |
| 2・3 | 「はい、開いてみて。」 | `t85`（1 時間前から閉じていなかった agency の調べもの） | 実行がもう無かった |

agency の調べものは、成果の資源を会話に結ぶために会話の仕事の台帳（`dialogue_work`、題は `[担当名] 問い`）に載る。台帳の開いている仕事はそのままルーターの候補（確認・訂正・取消）と構造解析の取消先になっていたので、agency が調べている間は、利用者の発言がその調べものの取消に当たり得た。取消が通る場合は、頼んでいない取消が実行される。直したのは次の 2 点。

| 原因 | 直したこと | 場所 |
| --- | --- | --- |
| agency 自身の調べものが、利用者の仕事と同じくルーターの候補・取消先になっていた | ルーターに渡す仕事（`RoutedInput.todos`）から、agency の仕事（`dialogue_agency_work` の `root_id` を run とする台帳の仕事）を外す。開いている仕事も、`## State` が示す終わった仕事も対象。保留質問（`pending.questions`）と `## State` の表示は変えていない | `api/domains/dialogue/service/generation-prepare.ts` の `routedInputInTransaction` |
| 所有者が実行を捨てた調べもの（出どころの失効などで web.note が run を忘れたもの）は結果を返さないので、ticket が戻らず、台帳の仕事が開いたまま残った | 実行が無くなった仕事は、失敗として agent に返し、台帳の仕事を閉じる（`discard`） | `api/domains/dialogue/service/agency-results.ts` の `resultsInTransaction` / `returnedInTransaction` |

- agency の調べものを声で取り消す経路は無くなる（静かにしてほしいときは `set_quiet`）。調べものの結果は、従来どおり返事の `read_note` / `show_note` で扱う。
- 構造解析が取消でない発言を `control` にした判断そのものは `eumenes_router` の側の課題で、host では変えていない。利用者が頼んだ仕事が実行中の間は、同じ誤りが起こり得る。
- 試験: `api/domains/dialogue/test/routed-router.test.ts`（agency の仕事が候補に出ない）、`api/application/agency/web-note-research.test.ts`（実行が無くなった調べものが閉じる）。

## メモを Markdown に蓄積する（2026-11-12、利用者の決定）

「Markdown に蓄積する形が取れたら、メモを捨てなくて良い。会話エージェントのメモ一覧からは削除しても良いが、Markdown は残せるようにしたい」。メモを文書にするのを `show_note` のときから、メモができたときへ移した。

| 項目 | 内容 |
| --- | --- |
| いつ | 調べものの結果がメモとして採用された直後（`collectAgendaResults`）。再起動で戻ってきたメモも同じ（作成済みの文書は作り直さない） |
| 保存先 | Docling の `eumenes` の `notes/<YYYY-MM-DD>_<題>_<noteId>.md`（日付は日本時間のメモ作成日）。詳しい Web 調査の報告（`research/`）とは別のフォルダー。Docling が無いときは scratch の一時ファイルだけ |
| agent のメモ一覧から外れたとき | 一覧は新しい 30 件（`NOTES_KEPT`）だけを持つ。外れたメモの文書には何もしない（Docling の文書も、その起動中のローカルのファイルも残る）。文書の保存は「agent がそのメモを持っているか」に依らない |
| 忘却（元の発言の忘却・出どころの失効） | 従来どおり。ローカルのファイルと生成文書の記録を消し、Docling へ確定保存された文書は利用者の文書として残す |
| 保存の失敗 | メモは agent のメモのまま。`agency.note_document_failed` を記録する。Docling へ送れなかった文書は、次の再起動でメモがまだ一覧にあれば作り直す |
| `show_note` | 同じ文書（会話とメモから決まる id）を待って、会話のメッセージに付ける。一覧から外れたメモは `show_note` では出せず、Markdown の一覧から開く |

- 場所: `always-on-flow.ts` の `keepNote`、`always-on-cycle.ts`（結果の採用後）、`always-on-host.ts`（scope の復元後）、`note-documents.ts`（`held` の照会を廃止、保存先を `notes/` へ）。
- 試験: `always-on.test.ts`（届いたメモが文書になる、再起動後も同じ文書、表示していないメモも文書になる）、`note-documents.test.ts`（日付つきの保存先）。

## 一覧から外れたメモは忘却ではない（2026-11-12）

2026-11-12 11:30（JST）、返事の読み上げが始まった直後に止まり（`generation_replaced`）、同じ発言への返事が約 22 秒後にもう一度作られた。返事を書いている間に調べものの結果が届き、満杯（30 件）のメモ一覧から一番古いメモが押し出されたためである。返事は渡されたメモ全部に依拠し、採用時に「渡したものがまだあるか」を確かめる。押し出されたメモは一覧に無いので「忘却された」と判定され、返事は採用されずに書き直された。メモが 30 件に達してからは、返事の途中で調べものが返るたびに起きる。

| 項目 | 内容 |
| --- | --- |
| 直したこと | 一覧から押し出されたメモは、参照（id と `refs`）だけを scope に残す（`retired`、最新 200 件、checkpoint には保存しない）。メモへの参照は「一覧にあるメモ＋押し出されたメモ」で解決する |
| 効く場所 | 返事の採用（`replyInputInTransaction`）、調べものの開始、自分からの発話、`show_note`、メモの文書化 |
| 忘却 | 押し出されたメモも、読んだ発言・記憶が忘却されれば一覧のメモと同じに扱う（参照を消し、agent に伝え、文書のローカルと記録を消す）。それに依拠する返事は従来どおり採用されない |
| 再起動 | `retired` は消える。書きかけの返事も残らないので、今回の現象には影響しない |

- 場所: `always-on-scope.ts`（`retired`、`citableNotes`、`holdNote`）、`always-on-cycle.ts`、`always-on-ports.ts`、`always-on-flow.ts`、`always-on-checkpoint.ts`。
- 試験: `always-on.test.ts`「a note the full list lets go for a newer one is not a forgotten one」（修正を外すと失敗する）。
