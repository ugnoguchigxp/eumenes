# 担当への依頼と結果の報告（assignments）

会話エージェントが担当（ツールチェーン）へ頼んだ仕事は、会話エージェント自身の担当（assignment）になる。Web 調べもの（`start_preparation` → 調べもの担当 → メモ → 自分から知らせる）と同じ流れで、TODO・確認 `c<n>`・`work` ツールは使わない。設計は [担当への依頼を調べものと同じ流れにする](../spec/toolchain-assignment-as-research-2026-11-25.md)、第2段の実装設計は [第2段の実装設計](../spec/toolchain-assignment-stage2-implementation-2026-11-25.md)。

## 流れ

| 段階 | 誰が | 何をする | 会話エージェントが見るもの |
| --- | --- | --- | --- |
| 探す | 会話エージェント | `find_toolchain` | 候補 |
| 依頼 | 会話エージェント | `delegate(toolchain, request, refs?, inputs?, target?)` | ツールの結果（下の「`delegate` の結果」） |
| 記録 | agency（`AgencyLayerPort.assign`） | 項目 `delegatedTo` を作る。同じ担当・同じ文の未完了項目は断る | `assignments` |
| 実行 | ホスト | 利用者の依頼として起動する。確認なし・自律行動の予算なし。task は持ち主の `TaskLifecyclePort`、それ以外は agent-runtime が選んだ実行（pipeline は `startPipelineInTransaction`） | — |
| 進捗・質問 | ホスト → agency | 担当の進捗と質問を項目に付ける | `assignments[].progress`・`question` |
| 回答・変更・取消 | 会話エージェント | `assignment(id, action, text)` | ツールの結果 |
| 返却 | ホスト | 結果を作業報告メモにして返す。作った物は資源番号を付けて台帳へ入れる | `assignments` の状態、`notes` |
| 報告 | agency | 頼まれたものは自分から話す。作った物は報告の発言に資源チップとして付く | 自分の発言 |
| 参照 | 会話エージェント | `read_note` / `show_note` | メモ本文 |

即時回答型（`card.instant`。天気・株価）は依頼項目にならず、`delegate` の結果でその場の文を返す。session 型（`develop_app` など）は変わらず、ホストの予告「「…」に頼みます。」で会話を引き継ぐ。

画像・音楽・Excalidraw・command（タイマー・設定・CLI など）・pipeline・画面のフォーム送信も、この流れで始まる。返事が完成を待たずに返り、完成したときにエージェントが自分から知らせる。

## 構成

| 部品 | 場所 |
| --- | --- |
| `delegate` の入口と `assignTo` | `api/domains/dialogue/service/executor-delegation.ts` |
| 引数の schema | `api/domains/dialogue/service/generation-tools.ts`（`delegateArgs`） |
| 依頼の受け口 `AgencyLayerPort.assign`、依頼の詳細 `AssignmentDetails` | `api/domains/dialogue/contracts/index.ts`、`contracts/agency-always-on.ts` |
| 依頼項目・`assignments` 欄・`delegate` の説明 | agency パッケージ（`eumenes-agency` 0.1.13、`vendor/agency/`、`src/agenda/reply.ts`） |
| 担当の起動・観測・回答・取消 | `api/domains/dialogue/service/agency-actions.ts`、`agency-action-work.ts` |
| 起動の分岐（`delegatedTo`）、期限（2時間） | `api/application/agency/always-on-flow.ts` |
| 進捗と質問の観測 | `api/application/agency/work-observation.ts` |
| `assignment` ツール | `api/application/agency/always-on-assignments.ts` |
| 作業報告メモ（`reportNote`）と文書への保存 | `api/application/agency/always-on-memory.ts` |
| 起動を一件ずつの開始鍵にする（一つの発言から複数件） | `api/domains/agent-runtime/service/execution-single.ts`・`execution-pipeline.ts`（`startKey`） |
| 旧 TODO の表の削除と、その痕跡の忘却 | `api/domains/dialogue/repository/retired-todos.ts`（マイグレーション）、`api/domains/dialogue/service/retired-todo-traces.ts`（`recover()` から呼ぶ） |

## `delegate` の結果

依頼項目にしたとき:

```json
{"delegated":true,"assignment":"a7","assignee":"Claude Code","next":"状態の assignments に出る。担当の質問はそこに出て、終わると作業報告のメモで届く（あなたから知らせる）"}
```

断ったとき:

```json
{"delegated":false,"code":"duplicate","assignment":"a7"}
```

```json
{"delegated":false,"code":"agency_unavailable"}
```

| `code` | 意味 |
| --- | --- |
| `duplicate` | 同じ担当・同じ文の未完了項目がある。`assignment` がその id |
| `agency_unavailable` | agenda が会話の返事を担当していない。依頼を持つ者がいないので始めない |
| `not_from_user` | 通知・予定など、利用者の発言に答えない run からの依頼 |
| `toolchain_unavailable` | 担当が今は使えない |
| `diagnostic_ref_not_supported` | 診断参照を受けない担当に `diagnosticRef` を付けた |

## 状態の `assignments`

会話エージェントの `<あなたの今の状態>` に、進行中のものと、終わったもののうち新しい3件が出る。依頼文は先頭80字、進捗は120字、質問は300字まで。全文と結果はメモにある。

```json
{
  "assignments": [
    {
      "id": "a7",
      "assignee": "Claude Code",
      "request": "開いているプロジェクトで、設定からLive2Dの背景色を変更できる機能を実装する",
      "status": "質問がある",
      "progress": "Claude Code が実行中です（直近操作: Bash / イベント 24 件）。",
      "minutesAgo": 5,
      "askedByUser": true,
      "question": "背景色設定は、どの画面や領域に適用する想定ですか？"
    },
    {
      "id": "a6",
      "assignee": "画像を作る",
      "request": "夕焼けの海の絵",
      "status": "終わった（メモ n12 になった）",
      "minutesAgo": 31,
      "askedByUser": true
    }
  ]
}
```

| `status` | 意味 |
| --- | --- |
| `待っている` | 担当の空き待ち（編集枠・LARM の空きなど） |
| `進めている` | 実行中 |
| `質問がある` | `question` への回答待ち。利用者にたずね、答えは `assignment(answer)` で渡す |
| `終わった（メモ n… になった）` | 返却済み。メモは `notes` にある |
| `やり遂げられなかった` | 失敗・期限切れ・権限の取消 |
| `やめた` | 取消 |

`progress` は担当の持ち主の view から毎回読み、写しは持たない。進捗を持たない担当では出ない。

## `assignment` ツール

返事の道具。`id` は `assignments` のもの。利用者の発言に答える回だけが使える（通知・自分の発話の回は `utterance_required`）。

```json
{"id":"a7","action":"answer","text":"設定の表示欄だけに適用する"}
```

| `action` | 使う場面 | 結果の文 |
| --- | --- | --- |
| `answer` | 担当の質問に利用者が答えた。`text` は利用者の答え | `answered: Claude Codeに回答を渡した` |
| `amend` | 利用者が依頼の条件を変えた。`text` は変更後の条件 | `amended: Claude Codeに変更を渡した` |
| `cancel` | 利用者がやめると言った | `cancelled: Claude Codeへの依頼をやめた` |

構造化された質問（選択肢・項目）には、`text` に JSON を渡す。形に合わなければ断りと形を返す。

```
refused: invalid_answer（回答の形: {"type":"object","properties":{…}}）
```

| 断り | 意味 |
| --- | --- |
| `assignment_not_found`・`assignment_ended` | その id が無い・終わっている |
| `not_started` | 担当がまだ始めていない（答えと変更を渡せない） |
| `text_required` | `answer`・`amend` に `text` が無い |
| `invalid_arguments` | 引数の形が違う |

照会（状態を読む操作）はない。状態は毎回 `assignments` に出る。

## 作業報告メモ

担当が終わると、結果が調べもののメモと同じ形のメモになり、Markdown の文書としても保存される。題は `作業報告: <依頼の先頭50字>`。中身のない欄は書かない。結果が空なら、メモは作らず、エージェントが「頼まれた「…」は、担当（…）がやり遂げられなかった」と話す。

| 担当の結果 | 欄 |
| --- | --- |
| 依頼の原文 | 依頼 |
| `summary` | 結果（メモの要約にも使う） |
| `fulfilled` | 達成したこと |
| `missing` | 残ったこと |
| 作った物の URI | 作ったもの |

```markdown
# 作業報告: 開いているプロジェクトで、設定からLive2Dの背景色を変更できる機能を実装する

## 依頼

開いているプロジェクトで、設定からLive2Dの背景色を変更できる機能を実装する

## 結果

設定の表示欄にLive2Dの背景色を追加した。

## 達成したこと

- 設定の表示欄に「Live2Dの背景色」を追加した

## 残ったこと

- 実機での見え方は未確認

## 作ったもの

- eumenes://image/a82
```

作った物（画像・曲・図）は、作業を鍵にした資源番号 `a<n>` で台帳に入り、報告の発言に資源チップとして付く。メモは `read_note` で読み、`show_note` で画面に出せる（[agency.md](agency.md)の「調べもののメモを見る」）。

## 担当の画面を開く

利用者の言葉から担当へ依頼すると、その担当の登録済みの画面（担当の binding の `adapterRef` を `sourceBindings` に持つ artifact）も Web のワークスペースに開く（[設計 §13](../spec/toolchain-assignment-as-research-2026-11-25.md)）。

| 事柄 | 規則 |
| --- | --- |
| 合図 | `GET /api/agency/conversations/:id/status` の `assignments: [{ assignment, adapterRef, at }]`。担当の起動が成功した時点で記録し（起動を断られた依頼は載らない）、10分間（終わった後も）、会話ごとに新しい8件まで載る。`at` は起動の時刻（epoch ms） |
| Web | `useAssignmentArtifacts`（`web/src/domains/dialogue/hooks/assignments.ts`）が、ページの読み込み時刻より後に起動した `assignment` ごとに一度だけ `openByAdapter(adapterRef)` で開く。読み込みより前に起動したものは開かない |
| 開かないもの | agency 自身の調べもの、画面のフォーム送信からの依頼（その画面はもう開いている）、instant・session、対応する画面の無い担当 |
| Claude Code | 対応する画面が無く、受け付けで「Claude Code」画面を開く既存の仕組み（`useClaudeCodeArtifacts`）が開く |

```json
{"conversationId":"main","assignments":[{"assignment":"a7","adapterRef":"adapter:music@1","at":1795651200000}]}
```

合図はメモリーだけに持つ。backend の再起動後は、それより前の依頼の画面を開かない。

## 規則

| 事柄 | 規則 |
| --- | --- |
| 画面に出ていない会話 | agency の段取りは画面の会話で回る。ほかの会話でも、依頼・調べものが待っているか動いている間と、まだ伝えていない報告がある間は回り、そこで頼まれた仕事が起動し、結果もその会話で伝わる（`keepsPromise`） |
| エージェントの設定変更 | 興味・口調・名前などの agency 設定を変えても、利用者の依頼（項目・依頼の詳細・起動中の作業）は引き継ぐ。止めるのは agency 自身の調べものだけ |
| 依頼の根拠 | 依頼の根拠は依頼した発言（画面フォームならその送信）だけ。無関係な発言や記憶が更新されても依頼は止まらない。依頼した発言を忘れると、依頼項目と作業も止まる |
| 依頼の権限 | 利用者の今回の発言が根拠。利用者に頼まれた依頼には、自律行動の日次上限・同時数・承認を適用しない。取消・回答・変更にも利用者の発言が要る |
| 起動前の確認 | しない。`modify_existing` も確認なしで始める。確認の台帳 `c<n>`・`approve_confirmation`・`decline_confirmation` は廃止した |
| 取り返しのつかない操作 | Claude Code が commit・push の前に質問を出す。利用者がその質問に答える（`assignments` の「質問がある」→ `assignment(answer)`） |
| 重複 | 同じ担当・同じ文の未完了項目があれば `duplicate` で断り、進めている項目の id を返す |
| 取消 | `assignment(cancel)` は担当の持ち主へ取消を渡し、項目を `やめた` にする。LARM に預けた仕事には取消（DELETE）まで届く |
| 忘却 | 依頼した発言を忘れると、項目と開始の詳細（保存済みの依頼）を落とす。チェックポイントにも残さない |
| 開始の詳細 | `inputs`・`target`・`routedSteps` などは依頼のときの内容を保存し、起動前に照合する。変わっていれば始めない（`agency_origin_stale`） |
| 複数件 | 一つの発言から複数件（「絵と曲を作って」）頼める。件ごとに別の開始鍵で起動する |
| 担当がいない | agenda が会話を担当していなければ `delegate` は `agency_unavailable`。ローカル（Ruri 振り分け）経路の `handWith` も `delegate` を呼ぶだけ |
| 期限 | 項目は2時間で期限切れになり、`やり遂げられなかった`。再起動をまたぐ項目は agency のチェックポイントから戻り、起動中の実行は引き継いで二重に起動しない |
| 失敗 | 担当の失敗・期限切れ・権限の取消は `やり遂げられなかった`。取消（`やめた`）とは別に扱い、エージェントが失敗を話す |
| 旧 TODO の記録 | 表ごと消した（2026-11-26、`dialogue/0049-drop-retired-todos`）。TODO・確認・コマンドの質問フォーム・TODO を鍵にした最初の画像の表が対象。TODO が作ったものも一緒に消す。古い発言の添付チップは非表示にし、短期記憶の TODO 結果は「あったこと」だけにし、旧調べもの報告は Web の調べものごと消す。チップと報告はマイグレーションと次の起動で一度だけ消え（`retired-todo-traces.ts`）、画像・音楽・文書そのものは各画面に残る |
| 通知 | TODO の通知 API（`/api/todo-notices*`）・TODO 画面・質問フォーム（`/api/toolchain-interactions*`）は廃止した。完了と質問の知らせは、エージェントの発言だけ |
| 登録目標・自律行動 | 変更しない。登録目標の実作業（`goalWork.delegation`）と、agency が自分で始める作業の上限と承認はそのまま |

## 検証

状態: 固定試験（fixture）は domain ごとに通っている。live（実モデル・実 Claude Code・実 LARM）と実機器の確認は未実施。

| 確認 | 試験 |
| --- | --- |
| 依頼項目の作成・取消・回答・作業報告メモ・忘却 | `bun test api/application/agency/always-on-assignments.test.ts` |
| 種別ごとの起動（画像・曲・command の質問・pipeline の `routedSteps`・開始詳細の改ざん・playlist） | `bun test api/application/agency/assignment-kinds.test.ts` |
| 取消が LARM に届く・権限の取消・構造化回答・出典付きのメモ | `bun test api/application/agency/assignment-repairs.test.ts` |
| 旧 TODO の表の削除 | `bun test ./api/domains/dialogue/test/retired-todos.test.ts` |
| TODO 画面の入口を launcher から外す migration | `bun test api/domains/capabilities/test/agency-todos-retire.test.ts` |
| 確認なしの依頼・`agency_unavailable` | `bun test api/domains/dialogue/test/talk-work.test.ts` |
| 会話・agency | `bun run verify -- --domain dialogue` |
| 利用側 | `bun run verify -- --domain agent-runtime`、`--domain claude-code`、`--domain development-supervision`、`--domain web-note`、`--domain tool-runtime`、`--domain capabilities`、`--domain timers`、`--domain pipelines`、`--domain live-voice`、`--domain conversation` |

上の3つの agency 試験は `scripts/domains.ts` の `dialogue` の統合試験に含まれ、`bun run verify -- --domain dialogue` で流れる。ブラウザ E2E は流さない。fixture、live、実機器の結果は分けて記録する（[検証手順](verification.md)）。
