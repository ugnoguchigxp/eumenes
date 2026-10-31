# 会話のハーネスを local の作りに一本化する 計画（2026-10-31）

状態: 合意済み（2026-10-31 利用者回答「はいその方針で構いません。coderを使って分担してください。また、レビューも行って改善も行ってください」）。§4 #1 は訂正あり。利用者（2026-10-31）「いまcloud llmのハーネスをつかってみて、色々動かないので、クラウドハーネスを削除して、今あるlocal-llm用のハーネス一本化しようと思います。」

関係する文書: [local ハーネスの作り直し](local-harness-rebuild-plan-2026-10-30.md)、[会話のハーネスの設計](conversation-harness-design-2026-10-28.md)、[迷ったら検索の1位](local-choice-top-candidate-design-2026-10-31.md)。

## 1 今の二本

| 部分 | cloud（`turn: single`） | local（`turn: routed`） |
| --- | --- | --- |
| 選ばれる条件 | 保存済みの会話の route が `cloud-only` で、有効なクラウド接続を指すとき（`harnessOf`） | それ以外（LARM） |
| 回の進め方 | 会話の AI が道具（`find_toolchain`・`delegate`・`work`・`memory`）を自分で呼ぶループ（`generation-loop.ts`、agency の `respond`） | ホストが Ruri の判定と保留で振り分け、会話の回（道具なし）か、schema 付きの選ぶ呼出し1回 |
| system | `full`（担当・道具の節あり） | `talk`（担当・道具の節なし） |
| 最近の会話 | 道具のやりとり・知らせを含む全部 | 発言と返事だけ、利用者の発言2つまで |
| 推論・出力の上限 | low・1,024 | low・4,096（考える分を含む） |
| Ruri の判定 | 使わない（`openIntentGate` は local だけ） | 使う |

## 2 一本化した後

| 部分 | 決め |
| --- | --- |
| ハーネス | 1つ（今の routed）。会話のモデルが LARM でもクラウドでも、回の流れは同じ。会話の route（`cloud-only` ならクラウドで推論）は今のまま |
| 呼出しの設定 | 推論 low・出力の上限 4,096（考える分を含む）。クラウドでも同じ値（`CallSession.reasoning` の larm・cloud とも low） |
| 選ぶ呼出しの口 | 今ある schema の口をそのまま使う。LARM は `response_format: json_schema`、OpenAI 互換のクラウドは `json_schema`、Codex は `outputSchema`、Claude Agent SDK は `outputFormat`。schema の口がない経路では会話の回だけ（今の扱い） |
| Ruri の判定 | クラウドのモデルでも LARM の判定を使う。LARM が使えなければ判定なし（依頼の回が決める。今の `free`） |
| 実行器 | 残す。担当探し・引き渡し・確認と承認・仕事・記憶の処理は、routed の回が今も `turn.act` で使っている |
| agency の自発的な話しかけ | 残す（裏の select・update と知らせの回は、ハーネスに依らない） |

消すもの（使われなくなるコードは残さない）:

| もの | 場所 |
| --- | --- |
| cloud のハーネスの定義と切り替え | `harness.ts` の `cloudHarness`・`harnessFor`・`HarnessName`・`turn`、`harnessOf` の分岐 |
| 道具を自分で呼ぶループ | `generation-loop.ts`、`generation-handler.ts` の分岐、会話の呼出しへの道具定義の受け渡し |
| `full` の system と、その節 | `context-system.ts` の `SYSTEM_SECTIONS`・`systemTexts: full` と、`contexts/system/` の担当・道具の節 |
| 評価の cloud 用の組み立て | `eval/context/generation-runner.ts`（道具のループで回す）。評価の会話は routed の回で回す |
| 評価用ハーネスの cloud | `scripts/context-eval` の `--turn single`・`--harness cloud`・`--client codex` の single 用の経路 |
| cloud のハーネス前提の試験 | 道具の呼出しの台本で書いた試験（約30ファイル、約320件）。選ぶ呼出しの台本（`choiceByScript`・`routedChoice` は既にある）へ書き直すか、routed の回に同じ確かめがあれば消す |

## 3 段階

| 段階 | 中身 | 検証 |
| --- | --- | --- |
| U1 | `harnessOf` が常に routed を返す。試験の土台の既定を routed にする（今は cloud が既定） | dialogue・inference の `verify`、voice-dialogue、`api/application` |
| U2 | U1 で落ちた試験を、選ぶ呼出しの台本に書き直す。同じ確かめが routed にあるものは消す | 同上 |
| U3 | §2 の「消すもの」を消す | 同上、型検査・lint |
| U4 | 評価（`eval/context`）と評価用ハーネスを routed だけにする | `bun test scripts/context-eval`、`eval/context` の試験 |

各段階で、修正前に落ちる試験は修正前に確かめる。fixture・live の結果を分けて記録する。live の確認（クラウドのモデルでの会話）は利用者の合図の後。

## 4 合意してほしいこと

| # | こと | 案 |
| --- | --- | --- |
| 1 | agency の `respond`（会話の AI が道具を自分で呼んで返事するループ）も消す | 消す（合意）。**訂正（10-31）: 消さない。** routed の会話の回（`routed-turn.ts` の `talk`）も、道具なしの1回の呼出しを agency の `respond` を通して行っている。調べ違いだった |
| 2 | クラウドのモデルでも Ruri の判定（LARM）を使う | 使う。LARM が使えないときは、依頼の回が選ぶ（判定なし） |
| 3 | クラウドのモデルの出力の上限 | local と同じ 4,096（考える分を含む）。クラウドの考えるモデルで足りなければ、測ってから直す |

## 5 実施記録

### 5.1 U1・U2・U4（2026-10-31）

| 段階 | 担当 | 結果 |
| --- | --- | --- |
| U1 | 私 | `harnessOf` は常に local（routed）を返す。意図の判定はハーネスによらず試す。dialogue の試験 174件が落ち、ほかの領域（`api/application` を含む）は落ちなかった（アプリの土台は既に選ぶ呼出しの台本） |
| U2-A | coder | specialist の土台と試験5ファイル。63件成功。削除なし |
| U2-B | coder | command-interactions の土台と試験5ファイル。38件成功。削除1件（道具の引数の strict 検査。クラウドのループ固有） |
| U2-C | coder | generation の土台と試験13ファイル。削除6件（モデル自身の道具呼出し・その拒否と修復のループなど、クラウドのループ固有）。置き換えの試験1件を追加 |
| U4 | coder | 評価（`eval/context`）は製品の routed の回で回す。評価用ハーネスから `--turn single`・`--harness`・`--client codex` と単発の返事のループを消した。評価の試験 89件、評価用ハーネス 65件成功 |

U2-A で見つかった製品の欠け: routed の回では、未保存の作業がある担当から別の担当への切り替えを完了できなかった（クラウドのループではモデルが `resolveUnsaved: "discard"` を付けていた）。直し: 選ぶ呼出しの入力に、切り替えを待つ担当（`RoutedInput.switching`、生きている専門担当のセッションの `pendingSwitch`）を足し、その担当の枝だけに `resolveUnsaved`（`discard` だけ）を出す。choice の system に「切替の確認待ちがあり、利用者が未保存の作業を破棄してよいと言ったときだけ」を足した。試験は U2-A が削除した後半（破棄してよいと言われたら切り替わる）を戻し、修正前に落ちることを確かめた。

確かめ方が弱くなった点: 道具が断られたときの理由コード（`revision_stale`・`confirmation_not_heard`・`todo_not_found` など）は、routed ではモデルに返らずホストの失敗の一言にまとまるため、試験は「失敗の一言」「状態が変わらない」「仕事が増えない」で確かめる。

動きの変化: system を写した返事は、run を失敗にせず、ホストの一言で完了する（routed の既存の決まり）。

### 5.2 U3 と後始末（2026-10-31）

| 部分 | 変えたもの |
| --- | --- |
| ハーネス | `cloudHarness`・`harnessFor`・`HarnessName`・`harnessOf` と、`name`・`turn`・`system`・`systemTexts`・履歴の `toolExchanges`・`notices` の欄を消した。残るのは `localHarness`（名前は application が読むので変えない）・`routeConversation`・呼出しの設定 |
| 道具のループ | `generation-loop.ts` を消した。型（`ToolOutcome`・`ToolExecutor`・`GenerationOutcome`）は `executor-context.ts` へ。`generation-handler.ts` は常に routed の回 |
| system | `SYSTEM_SECTIONS`・`full` の文と `contexts/system/` の `facts`・`speaking`・`tools`・`toolchains`・`results`、`contexts/generation-loop/` を消した。system は会話の回の5節だけ。担当一覧（`toolchainTitles`）と、system の写しの検出のうち道具名の検出も消した |
| 最近の会話 | 道具のやりとりと知らせを描く処理（`exchangeMessages`）と、前置きの `tools` を消した（dialogue の中だけ） |
| 道具の定義 | 会話の AI に渡していた道具の定義（`generationTools`）を消した。引数の schema と `parseCall` は、routed の回の `turn.act` が使うので残す |
| 選択の試験（パイプライン制作） | 製品の選ぶ呼出し（`choiceMessages`・`choiceSchema`）で試す。利用者の制御要求に `structuredOutput` を足し、schema を厳密に守らせる |
| 試験 | `harness.test.ts`・`harness-voice.test.ts` を残った部分に書き直した。`conversation-output.test.ts`・`conversation-input.test.ts`・`context-system.test.ts`・`generation-tools.test.ts` から、消した部分の試験を消した |

ほかの領域に残っているもの（独立したレビューで扱う）: `ConversationAgentSystem.toolRules`（dialogue はもう読まない）、steward・agency・prewarm・inference の `prefixTools`（いつも空）、発言に保存する `toolCalls`・`notice`（もう描かない）。

| 検証 | 結果 |
| --- | --- |
| `bun run verify -- --domain dialogue --domain inference --domain larm --domain steward --domain memory --domain world` | pass（1,469件） |
| voice-dialogue・`scripts/context-eval`・`scripts/response-decision` | 166件成功 |
| `bun test ./api/application` | 961件成功。失敗3件は既存の `toolchain.test.ts` |
| 型検査・`oxlint`・`context:check` | エラー0件 |

### 5.3 独立したレビューと直し（2026-10-31）

| # | 指摘 | 直し |
| --- | --- | --- |
| 1（高） | 選ぶ呼出しの schema（ルートが候補ごとの枝の `anyOf`、任意の欄、長さの範囲）が、OpenAI 互換・Codex の厳密な structured output の規則に合わない。クラウドの会話モデルでは選ぶ呼出しが毎回断られる恐れ | 呼出しの `cloudOutputSchema`（inference）を足した。dialogue が選ぶ呼出しの schema を厳密な形（1つの object に全部の枝の欄を並べる。`choice` は必須、ほかは必須で使わなければ null、追加の欄なし、長さの範囲なし、担当の欄は JSON の文字列）に写し（`strictChoiceSchema`）、クラウドへはそれを送る。LARM には今の枝の形を送る。答えは `parseChoice` が null を落とし、欄の文字列を object に読み戻す。ホストの検査は今のまま |
| 2（高） | 選ぶ呼出しがクラウド固有の失敗（空の出力、429・5xx など）で落ちると、会話の回へ回らず run が失敗する | 選ぶ呼出しが呼出しそのものの失敗（提供元・通信・LARM の推論の失敗）で終わったら、`dialogue.choice_failed` を残して会話の回が答える。会話の回でも同じ失敗なら、ホストの一言で答える |
| 3（中〜高） | 「破棄していいよ」の回は、その言葉だけで担当を探すので、切り替え待ちの担当が候補に入らず、切り替えが終わらない（試験の土台が毎回全部の担当を返していたため見逃した） | 切り替え待ちの担当を、検索なしで渡せる担当（`retained`）に足す。候補にも引き渡しの許可にも入る。試験の土台に「検索で見つかる担当」を絞る口を足し、検索が何も見つけない場合の試験にした（修正前に落ちることを確かめた） |
| 4（中） | パイプラインの選択の試験の schema が、LARM 向けの長さの範囲の除去を通らない | 厳密な schema を使う制御要求はすべて、LARM には長さの範囲を除いた形で送る（`toolOutputFormat: "json-schema"`） |
| 5（中） | 一本化で失うもの: 1回の発言で複数の操作、選ぶ呼出しに画像が届かない、断られた理由がモデルにも利用者にも届かない、クラウドでは往復が2回 | 方針の範囲の結果として記録する（直さない） |
| 6（低） | 使われなくなった `toolRules`、いつも空の `prefixTools` とそれだけのための `toolChoice: "none"`、dialogue のメッセージ型の `tool_calls` | 消した（coder）。inference・larm の `tool_calls` は、道具を使う裏の担当がまだ使うので残す |

| 検証 | 結果 |
| --- | --- |
| `bun run verify -- --domain dialogue --domain inference --domain larm --domain steward --domain memory --domain world` | pass（1,468件） |
| voice-dialogue・`scripts/context-eval`・`scripts/response-decision`・agency・prewarm・pipelines | 247件成功 |
| `bun test ./api/application` | 961件成功。失敗3件は既存の `toolchain.test.ts` |
| 型検査・`oxlint`・`context:check` | エラー0件 |

クラウドの会話モデルでの動き（厳密な形を各提供元が受け付けるか）は fixture でしか確かめていない。live は利用者の合図の後。
