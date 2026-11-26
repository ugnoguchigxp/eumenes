# 担当への依頼を調べものと同じ流れにする（TODO廃止）

2026年11月25日・第1稿・合意前。TODO の廃止は利用者が決定した（2026-11-25「todo廃止していいです」）。担当の割り当てと結果の報告は、Web調べもの（`start_preparation` → 調べもの担当 → メモ → 会話エージェントが自分から知らせる）の流れをそのまま踏襲する。

## 1. 背景

2026-11-25 11:48〜11:54、利用者が「Claude Codeで作って」と頼んだ。Claude Code は 11:48 から実行していた（`claude_code_work` ca4de857、実装中）。それでも会話エージェントは「まだ渡せていない」と答え、確認を出し直した。利用者の了承ごとに同じ依頼が3件増えた（t507・t508・t509）。

| 観測 | 原因 |
| --- | --- |
| モデル入力の `## State` の「仕事:」に t503（Web調べもの）しかない | TODO 行は、作った run の入力の版がすべて今と同じときだけ表示される（`work-context-input.ts` の `workContextCurrent`） |
| 承認から作った TODO が作成直後から消える | 承認した run の入力に、確認行の digest（`host-confirmation:`）が入る。承認で `used_at` が書かれると、digest が変わる |
| 確認なしの TODO も後から消える | 同じ State に並んでいた他の TODO の版（`host-work:`）が進むと消える。今回は t504 が版2から3へ進んだ |
| 担当の質問「どの画面や領域に適用する想定ですか？」への回答が届かない | 質問を持つ TODO の番号が見えず、`work` の answer を呼べない |

TODO は、実行の持ち主（`claude_code_work`、web-note、音楽・画像の各台帳）の状態を写した台帳である。写しの版が動くことと、版の一致で表示を決めることが衝突した。Web調べものの記録は会話エージェント（agency）自身が持つので、この衝突は起きない。

## 2. 踏襲する流れ（Web調べもの、現行）

| 段階 | 誰が | 何をする | 会話エージェントが見るもの |
| --- | --- | --- | --- |
| 依頼 | 会話エージェント | `start_preparation(request, askedByUser)` を呼ぶ | ツールの結果 `accepted: 頼んだ（始まれば数分でメモになり、できたら自分から知らせる。うまくいかなければ、それも知らせる）` |
| 記録 | agency（`requestResearch`） | 項目 `kind: research` を作る。同じ文の未完了項目があれば `duplicate` で断る | `researching` / `waitingResearch` |
| 実行 | ホスト（`startResearch` → `state.startInTransaction`） | web.note を起動する | — |
| 返却 | ホスト（`always-on-cycle.ts` → `researchReturned`） | 結果をメモにし、文書にも保存する（`keepNote`） | `researchLog` に「メモ n067… になった」、`notes` に題・要約 |
| 報告 | agency（計画・発話） | 頼まれたものは自分から話す。失敗も「うまく調べられなかった」と話す | 自分の発話として履歴に残る |
| 参照 | 会話エージェント | `read_note` で読み、`show_note` で画面に出す | メモ本文 |

`lookup_public_information` はその場で答えが返る形で、記録を持たない。即時の担当（`card.instant`）はこちらにそろえる。

## 3. 新しい流れ（担当への依頼）

| 段階 | 誰が | 何をする | 会話エージェントが見るもの |
| --- | --- | --- | --- |
| 探す | 会話エージェント | `find_toolchain`（変更しない） | 候補 |
| 依頼 | 会話エージェント | `delegate(toolchain, request, refs?, inputs?, target?)` を呼ぶ | ツールの結果（§4.1） |
| 即時の担当 | ホスト | `card.instant` は今と同じく、その場で実行して結果を返す。記録は作らない | ツールの結果（`lookup_public_information` と同じ扱い） |
| 記録 | agency（`requestResearch({ delegatedTo })`） | 項目 `kind: research` に `delegatedTo` を付けて作る。同じ担当・同じ文の未完了項目があれば `duplicate` で断る | `assignments`（§4.2） |
| 実行 | ホスト（`startResearch` の `delegatedTo` 分岐） | 今は `agency_capability_unavailable` で失敗させている分岐で、担当の実行（`state.startInTransaction`、revisionId は担当の版）を起動する | — |
| 質問 | ホスト → agency（新設 `assignmentAsked`） | 担当の質問（Claude Code の確認など）を項目に付ける | `assignments[].question` |
| 回答・変更・取消 | 会話エージェント | `assignment(id, action, text)`（§4.4）を呼ぶ。ホストは担当の制御口（今の `executor-work.ts` の task 操作）へ渡す | ツールの結果 |
| 返却 | ホスト（`researchReturned`） | 担当の最終結果を作業報告メモ（§4.3）にして返す | `assignments` の状態、`notes` に題・要約 |
| 報告 | agency | 頼まれたものは自分から話す（調べものと同じ規則）。失敗は今の文「頼まれた「…」は、担当（…）がやり遂げられなかった」を使う | 自分の発話 |
| 参照 | 会話エージェント | `read_note` / `show_note`（作業報告メモも同じ） | メモ本文 |

担当ごとの同時実行の上限は、実行の持ち主が持つ（Claude Code の編集枠など）。調べもの担当の「一度に一つ」は web.note だけの規則として残し、他の担当には適用しない。

## 4. 会話エージェントに見せるもの（実例）

### 4.1 `delegate` の結果

```
accepted: Claude Codeに頼んだ（a7。終わったら作業報告のメモになり、自分から知らせる。担当から質問が来たら状態に出る）
```

断る場合:

```
refused: duplicate（同じ依頼を Claude Code が a7 で進めている）
```

### 4.2 `## Agency` の `<あなたの今の状態>` に足す欄

```json
{
  "assignments": [
    {
      "id": "a7",
      "assignee": "Claude Code",
      "request": "開いているプロジェクトで、設定からLive2Dの背景色を変更できる機能を実装する",
      "status": "進めている",
      "progress": "Claude Code が実行中です（直近操作: Bash / イベント 24 件）。",
      "minutesAgo": 5,
      "askedByUser": true,
      "question": "背景色設定は、どの画面や領域に適用する想定ですか？"
    }
  ]
}
```

| `status` の値 | 意味 |
| --- | --- |
| `待っている` | 担当の空き待ち（編集枠の待機など） |
| `進めている` | 実行中 |
| `質問がある` | `question` への回答待ち |
| `終わった（メモ n… になった）` | 返却済み。メモは `notes` にある |
| `やり遂げられなかった` | 失敗・期限切れ |
| `やめた` | 取消 |

`researchLog` と同じく、終わった項目は直近8件まで残す。進捗の `progress` は、実行の持ち主の view（今の `state-text.ts` が読んでいる `viewInTransaction` の `progress.summary`）から毎回読む。写しは持たない。

### 4.3 作業報告メモ

担当の最終結果を、調べもののメモと同じ形（題・要約・Markdown本文）にする。文書ライブラリへの保存も `keepNote` を使う。

```markdown
# Live2Dの背景色を設定から変更できるようにした

## 依頼
開いているプロジェクトで、設定からLive2Dの背景色を変更できる機能を実装する

## 達成したこと
- 設定の表示欄に「Live2Dの背景色」を追加した

## 確認した根拠
- …

## 残ったこと
- …

## 作ったもの
- [画像 a82](eumenes://…)
```

| 担当の結果 | メモの欄 |
| --- | --- |
| `summary` | 要約 |
| `fulfilled` | 達成したこと |
| 検証の記録 | 確認した根拠 |
| `missing` | 残ったこと |
| 作成物の URI（今の `work-links.ts` が集めているもの） | 作ったもの |

### 4.4 `assignment` ツール（`work` を置き換える）

| action | 使う場面 | ホストの動作 |
| --- | --- | --- |
| `answer` | 担当の質問に利用者が答えた | 担当の制御口へ回答を渡し、`question` を消す |
| `amend` | 利用者が依頼の条件を変えた | 担当の制御口へ変更を渡す |
| `cancel` | 利用者がやめると言った | 担当を止め、項目を `やめた` にする |

照会（今の `check`）は設けない。状態は `assignments` に毎回出る。

## 5. 規則

| 事柄 | 規則 |
| --- | --- |
| 依頼の権限 | 利用者の今回の発言が根拠（`refs` に発言ID）。利用者に頼まれた依頼には、agency の自律行動の上限（`agency.actions` の日次上限・同時数・`requiresApproval`）を適用しない |
| 確認 | `modify_existing` は確認しない。`irreversible`（公開・送信・push など）は、項目をホストの質問「…してよいですか」付きの `質問がある` で作り、`answer` で了承されてから起動する。確認の台帳 `c<n>` は廃止する |
| 重複 | 同じ担当・同じ正規化文の未完了項目があれば断る（`requestResearch` の既存判定を `delegatedTo` 込みで使う）。進行中の依頼は `assignments` に必ず出るので、モデルが依頼の有無を見失わない |
| 表示の判定 | `assignments` は agency の記録なので、作った run の入力の版で隠さない。忘却は、項目の `refs`（発言ID）を `forget` が落とす既存の規則で反映する |
| 失敗・期限 | 担当の失敗・期限切れは `researchReturned(status: failed)`。頼まれたものなら、失敗を話す項目を自分で作る（既存） |
| 再起動 | 未完了の項目は agency の snapshot に残る（既存）。起動中の実行は `state.workActiveInTransaction` で引き継ぎ、二重に起動しない（既存の `startResearch`） |
| 登録目標の実作業 | 変更しない（`goalWork.delegation` と goal runner の経路はそのまま） |
| 自律行動 | 変更しない（agency が自分で始める担当作業は、今の上限と承認のまま） |

## 6. 廃止するもの

| 対象 | 場所 |
| --- | --- |
| TODO 台帳・確認台帳への書き込み | `dialogue_work`・`dialogue_confirmations`（表は行を残して書き込みを止める。表を消すかは別のマイグレーションで決める。旧ランナーの表と同じ扱い） |
| TODO・確認の処理 | `dialogue/service/work-ledger.ts`・`executor-work.ts`・`work-links.ts`（作成物の収集は §4.3 へ移す）・`work-stop.ts`（停止は担当の制御口へ）・`work-context-input.ts`・`confirmation-decision.ts`・`confirmation-revisions.ts`・`report-notice.ts`、`executor-delegation.ts` の confirm / approve 分岐 |
| State の「仕事:」欄 | `state-text.ts`・`background-input.ts` の TODO と確認の行 |
| ツール | `work`・`approve_confirmation`・`decline_confirmation`、`delegate` の `mode`・`revises`・`announcement` |
| 完了通知の既読管理 | `GET /api/todo-notices`・`POST /api/todo-notices/archive`・`POST /api/todo-notices/:id/read`、`web/src/domains/dialogue/hooks/todo-notices.ts`、通知センターの TODO 表示 |
| TODO の報告の後処理 | `api/application/agency/speech.ts` の `reportedTodoIds`、`operation-ports.ts` の `hostTodosInTransaction` |
| `read_agents` の TODO 部分 | 説明の「制作TODO」を外し、終わった依頼は `assignments` とメモで読む |

`docs/` と会話の指示（`contexts/agency/*.toml`）から、TODO・`t<n>`・`c<n>` の説明を消す。

## 7. agency パッケージ（`../eumenes_agency`）の変更

| 変更 | 場所 |
| --- | --- |
| 担当の質問を項目に付ける `assignmentAsked({ ticketId, question })` と、回答・取消で質問を閉じる操作 | `src/agenda/agent.ts`、`contracts.ts` の項目に `question` |
| `delegatedTo` の項目を `researching` の一枠に入れず、担当ごとに並行させる | `agent.ts`（`st.researching` は調べもの担当だけ） |
| 状態の欄 `assignments` | `src/agenda/reply.ts` の状態組み立て |
| `delegate` の説明から「依頼するとTODOができ」と `mode` を外す | `reply.ts` |

取り込みは今の手順どおり tarball で行い、版はパッチを1つ上げる。

## 8. 既存の設計との関係

| 文書 | 扱い |
| --- | --- |
| [作業場所・担当・承認の引き継ぎ](conversation-delegation-continuity-2026-11-22.md) §3（実行確認への同意をそのターンの受付に結び付ける） | 確認の台帳の廃止に伴い置き換える。§1・§2・§4 は残す |
| [会話から依頼した仕事の継続・結果共有と読み上げの実装計画書](conversation-work-handoff-design-2026-11-23.md)（合意前） | 「仕事台帳から次の会話に渡す」は、本書の `assignments` と作業報告メモで置き換える。質問・確認を一度だけ届ける規則は、§4.4 の `answer` で満たす |
| ContextWindow 仕様 §10.1（会話の TODO） | 本書で置き換える |

## 9. 実装順と合格条件

| 順 | 内容 | 合格条件（fixture） |
| --- | --- | --- |
| 1 | agency パッケージの変更（§7）と取り込み | agency の試験。`delegatedTo` 項目の並行、質問、回答、取消、重複拒否、再起動復元 |
| 2 | ホストの `delegatedTo` 分岐で担当を起動し、結果を作業報告メモで返す | Claude Code の fake runner で、依頼 → `進めている` → 質問 → 回答 → `終わった（メモ…）` → 自分からの報告 |
| 3 | `delegate` の新しい結果と `assignment` ツール、即時の担当の扱い | 依頼の直後と次のターンの State に `assignments` が出る。承認を経た依頼も消えない（今回の再現） |
| 4 | TODO・確認の書き込み・ツール・API・Web表示の削除（§6） | 削除後の参照0件（grep）。`bun run verify -- --domain dialogue`、影響する domain（`claude-code`・`web-note`・`tool-runtime`・`capabilities`）の verify |
| 5 | 開いている TODO の移し替え | 切替時点で未完了の TODO を一度だけ `delegatedTo` 項目へ移し、実行中の担当を引き継ぐ（二重起動0件） |
| 6 | 文書 | `docs/agency.md`・`docs/delegated-tasks.md`・README の機能表を新しい流れに直す |

live（実モデル・実 Claude Code）での確認は、利用者の指示があるときだけ行う。

## 10. 実施記録（2026-11-25、第1段）

| 内容 | 状態 |
| --- | --- |
| agency パッケージ（§7）：担当項目の並行発行、`assignmentObserved`・`assignmentEnded`、`assignments` 欄、`delegate` の説明、`check.ts` で担当項目を調べ済みに数えない | 実装・試験済み（`test/agenda` 231件）。0.1.13 として取り込み（`vendor/agency/assignments-adoption-source.patch`） |
| ホスト：`AgencyLayerPort.assign`、依頼の詳細（担当の版・素材・利用者の発言の source）の保存と復元、`startResearch` の `delegatedTo` 分岐、承認不要・予算対象外での起動、進捗と質問の観測、作業報告メモ、`assignment` 道具（answer・amend・cancel） | 実装・fixture 試験済み |
| `delegate`：agency が返事を担当している会話で、task の担当への依頼（保存済み対象・inputs・診断参照・routed steps なし）を依頼項目にする。`modify_existing` は確認しない | 実装済み |
| agency の作業（調べもの・依頼）は TODO 行を作らない。生成物の資源番号は agency の作業 root を鍵にする | 実装済み |

第1段で残したもの（第2段の設計が要る）:

| 残り | 理由 |
| --- | --- |
| `command` 種別（画像・音楽・ブラウザーなど）、`pipeline`、`session`、保存済み対象・inputs・診断参照付きの依頼、ローカル（Ruri 振り分け）経路 | これらは TODO と確認の経路のまま。`command` の結果は、会話内の資源番号の付け方と画面への提示が TODO 行に結び付いている。依頼項目へ移すと結果の見せ方が変わるため、別に設計する |
| §6 の削除（`work`・確認・TODO 通知 API・Web 表示・TODO 台帳） | 上の経路が残る間は削除できない |
| `irreversible` の依頼を担当の質問として確認する（§5） | 第1段は既存の確認 `c<n>` を通し、承認後に依頼項目にする |
| §9 の 5（開いている TODO の移し替え） | 未実施 |
| 実 Claude Code・実モデルでの確認 | 未実施（利用者の指示待ち） |

独立レビュー（2026-11-25）の指摘のうち、次を修正した: 取消にも利用者の発言を要求、回答は利用者に見せた質問と同じときだけ渡す、`pipeline` を第1段から外す、切替前の agency の TODO 行を完了時・忘却時に片付ける、進捗だけの変化では保存と step を起こさない、依頼項目は DB の書込みが通るときだけ作る、オフライン忘却で依頼の詳細を落とす、取消の失敗を拒否として返す、作業報告から URL の追記を除く、「残ったこと」だけの結果もメモにする。

## 11. 第2段：TODO の全面廃止（2026-11-25・合意前）

利用者の決定（2026-11-25「そのままtodoを廃止して、タスク委譲のスムーズさと自然な結果報告を表示できる様にしたい」）に基づく。第1段の後も TODO を使っているのは、会話の run が担当の完了を待ち、その返事で結果を見せる経路（`work-dispatch.ts` の `image`・`music-create`・`music-playback`・`excalidraw`・`command`・既定の route）と、`pipeline`、保存済み対象・inputs・診断参照・routed steps 付きの依頼。これらも依頼項目にする。

### 11.1 利用者から見た変化

| 場面 | 今 | 第2段の後 |
| --- | --- | --- |
| 「絵を描いて」 | 返事が画像の完成まで待ち、その返事に画像が出る | 「描いてもらいますね」とすぐ返り、会話は続く。完成するとエージェントが自分から知らせ、その発言に画像が資源チップとして付く |
| 「曲を作って」「この曲を流して」 | 同上 | 同上。再生は完成した時点で始まる |
| 取り返しのつかない操作 | 確認 `c<n>` → 承認 | 起動前の確認はしない。Claude Code が commit・push の前に出す質問に、利用者が答える |
| 完了の通知 | TODO の画面通知（既読管理） | エージェントの報告の発言だけ |
| 仕事の一覧 | State の「仕事:」と TODO 画面 | 状態の `assignments`。画面の一覧は廃止 |

### 11.2 起動の口をそろえる

`agency-actions.ts` の `start` は、担当の持ち主の `TaskLifecyclePort`（`taskInTransaction`）を通して起動する。会話の run に結び付いた起動口しか持たない種別には、run を持たない adapter を各 domain に足す。

| 種別 | 今の起動口 | 足す adapter（`TaskLifecyclePort`） |
| --- | --- | --- |
| `image` | `deps.image.startInTransaction(media)`（`runId` 必須） | image domain：execution id で job を持ち、`viewInTransaction` で状態と結果（`links`）を返す |
| `music-create`・`music-playback` | `deps.music.*`（`runId` 必須） | music domain：同上 |
| `excalidraw` | `deps.excalidraw.startInTransaction` | excalidraw domain：同上 |
| `command` | dialogue の queue job（`COMMAND_KIND`、`runId` で結ぶ） | dialogue 外へ出さず、job の payload を execution id で結ぶ adapter |
| 既定の route（agent-runtime の調べもの） | `delegateConversation` | `agents.executions.startSelectedInTransaction`（agency の自律行動と同じ） |
| `pipeline` | `startPipelineInTransaction` | そのまま。`references` と `routedSteps` を渡す |

依頼の詳細（`AgendaAssignment`）に `inputs`・`target`・`diagnosticRef`・`resolveUnsaved`・`routedSteps` を足し、adapter の `startInTransaction` へそのまま渡す。保存票の schema は optional で足すので、既存の checkpoint はそのまま読める。

### 11.3 結果の見せ方

| 結果 | 見せ方 |
| --- | --- |
| 文章の結果（調べもの・作業報告） | 作業報告メモ（第1段と同じ） |
| 資源（画像・曲・図） | 作業 root を鍵に資源番号を付け（第1段）、報告の発言に資源チップとして付ける（今の自発発話の `linkFindingsInTransaction` と同じ） |
| 失敗 | 「頼まれた「…」は、担当（…）がやり遂げられなかった」（第1段と同じ） |

### 11.4 確認

利用者の判断（2026-11-25「取り返しのつかない操作はclaude codeぐらいなはずです」）と、`irreversible` を宣言する担当が0件であることから、起動前の確認は全廃する。commit・push など取り返しのつかない手前の判断は、Claude Code 自身の質問（`assignments` の「質問がある」→ `assignment(answer)`）で行う。`dialogue_confirmations` への書込み、`approve_confirmation`・`decline_confirmation`、`delegate` の `mode`・`revises`・`announcement`・`impact` を削除する。

### 11.5 担当する agency が無いとき

依頼項目は agenda の agent が持つ。agenda が会話を担当していないとき（`servesRepliesInTransaction` が false）は、`delegate` は `agency_unavailable` で断る。ローカル（Ruri 振り分け）経路の `handWith` も `delegate` を同じく呼ぶだけにし、確認の分岐を消す。

### 11.6 移行

起動時に一度だけ、開いている TODO（`archived_at IS NULL`）を閉じる。task の実行中のものは持ち主へ取消を送り、TODO は `interrupted` で閉じる。依頼項目へは移さない（現在開いているのは、重複した Claude Code の依頼3件だけ）。表 `dialogue_work`・`dialogue_confirmations` は行を残して書込みを止め、表を消すかは別のマイグレーションで決める。

### 11.7 削除

§6 の全項目に加えて、`work-dispatch.ts` の run を待つ分岐、`result-intake.ts` の TODO 報告、`report-notice.ts`、`generation-settle` の TODO 関連、TODO 画面の API（`/api/todo-notices*`）と Web（`hooks/todo-notices.ts`、通知センターの TODO 表示、`Workspace` の TODO 画面）、`read_agents` の TODO 部分、会話の指示文の `t<n>`・`c<n>`。

### 11.8 実装の分担と合格条件

| 単位 | 書込み先 | 合格条件（fixture） |
| --- | --- | --- |
| 種別ごとの adapter | image・music・excalidraw domain、dialogue の command adapter | 各 domain の試験。adapter 経由で開始・状態・結果・取消 |
| 依頼の詳細の拡張と起動 | dialogue の agency 系・application/agency | 「絵を描いて」→ 依頼項目 → 完成 → 報告発言に資源チップ（fake の画像担当） |
| 確認の廃止 | dialogue・application/agency | `modify_existing` の依頼も確認なしで依頼項目になる。確認の台帳への書込み0件 |
| 削除 | dialogue・Web | 参照0件（grep）。`bun run verify -- --domain dialogue` と影響 domain |
| 移行 | dialogue | 開いている TODO が起動後に0件、task の実行は取消済み |

## 13. 担当への依頼で、その担当の画面も開く（2026-11-26・利用者の要望）

利用者の要望（2026-11-26「会話エージェントが、ツールチェーンから担当を見つけて引き継ぐと、それに引かれてアーティファクトも起動する形にしたい」）。

| 事柄 | 規則 |
| --- | --- |
| 開く時点 | 利用者の依頼から作った依頼項目が受け付けられたとき、1回だけ |
| 開く画面 | 担当の binding の `adapterRef` を `sourceBindings` に持つ、登録済みの画面（Web の `openByAdapter(adapterRef, targetRef)` が引くもの）。対応する画面がない担当は開かない |
| 開かないもの | agency が自分から始める調べもの。画面のフォーム送信から作った依頼（その画面はすでに開いている）。instant・session（session は今の専門担当の画面の開き方のまま） |
| Claude Code | 受け付けで「Claude Code」画面を開く既存の仕組み（`useClaudeCodeArtifacts`、`spec/claude-code-task-terminal-view-2026-11-25.md`）を使い、二重に開かない |
| 合図 | 会話の状態の読み取り（Web が読む agency の状態）に、起動した依頼項目ごとの `{ assignment, adapterRef, at, targetRef? }` を載せる（起動の成功時に記録し、10分間残す）。Web は、ページの読み込み時刻より後に起動した依頼項目の画面だけを一度開く |
| 対象の参照 | 担当の実行が作った対象（例: 曲・画像の資源）がまだ無い時点で開くので、`targetRef` は持てるときだけ付ける。無ければ画面の既定の表示 |

検証は fixture のみ: 依頼の受付で状態に画面の合図が載る（サーバー）、新しい合図で1回だけ開き再読み込みでは開かない（Web）、調べもの・画面フォーム送信・Claude Code では開かない。

## 12. 実施記録（第2段）

2026-11-26。第2段（§11 と [実装設計](toolchain-assignment-stage2-implementation-2026-11-25.md)）をコミット `c2fc0969` で実装した。文書は [docs/assignments.md](../docs/assignments.md) に登録した。

### 12.1 届けたもの

| 内容 | 状態 |
| --- | --- |
| すべての種別を依頼項目にする: 画像・音楽（作成・再生）・Excalidraw・command・pipeline・画面のフォーム送信。起動は task の持ち主の `TaskLifecyclePort`、または agent-runtime の選んだ実行（`startSelectedInTransaction`・`startPipelineInTransaction`）。一つの発言から複数件頼めるよう、開始鍵 `startKey` を足した | 実装・fixture 試験済み（`assignment-kinds.test.ts`） |
| 依頼の詳細 `AssignmentDetails`（`inputs`・`target`・`diagnosticRef`・`resolveUnsaved`・`routedSteps`）を項目に保存し、起動前に照合する（`agency_origin_stale`） | 同上 |
| 確認の廃止: `delegate` の `mode`・`revises`・`announcement`・`impact`、`approve_confirmation`・`decline_confirmation`、確認台帳への書き込み。取り返しのつかない操作の判断は、Claude Code 自身の質問（`assignments` → `assignment(answer)`） | 実装済み |
| TODO の廃止: `work` ツール、run を待つ dispatch、TODO 台帳への書き込み、`/api/todo-notices*`、`/api/toolchain-interactions*`、Web の TODO 画面と通知カード、command の質問フォーム、`agency.todos` の bundle（launcher から外す migration とその試験を含む） | 実装済み。表 `dialogue_work`・`dialogue_confirmations`・`command_interactions` は行を残して書き込みを止めた |
| 起動時の閉鎖（`todo-closure.ts`）: 開いた TODO・確認・質問の行を一度だけ閉じ、task の実行中のものは持ち主へ取消を送る | 実装・fixture 試験済み（`todo-closure.test.ts`） |
| `agency_unavailable`: agenda が会話を担当していなければ `delegate` は断る | 実装・fixture 試験済み（`talk-work.test.ts`） |
| 第1段の続きで直したもの: 取消が LARM に届かない、構造化回答、command の結果、作業報告の出典、画像・音楽の空き待ちの再試行、Claude Code の完了通知の二重 | 実装・fixture 試験済み（`assignment-repairs.test.ts`） |

### 12.2 残り

| 残り | 内容 |
| --- | --- |
| 読まれないデータ | 登録済みの capability revision には、command の質問フォームのための `answer`・`questionDefinition` の欄が残っている。読むコードは無い。revision は書き換えず（既存の版は変えない規則）、次に版を上げるときに外す |
| 即時性の高い command の報告 | タイマーなどの短い command も非同期の依頼になり、結果を毎回メモ（文書）にして報告する。問題になれば、その担当を `instant` へ移す（データドリブン、版を上げる）。決めていない |
| 表の扱い | `dialogue_work`・`dialogue_confirmations`・`command_interactions` を消すマイグレーションは作っていない（別に決める） |
| 画像のモデルへの提示 | 依頼で作った画像を会話モデルに見せる観測は残した。鍵を TODO の id から依頼の作業 root と利用者の run に付け替えた（`dialogue_assignment_images`）。利用者が頼んだ画像も、agency 自身の調べものの画像も見つかる |
| 検証 | 固定試験は domain ごとに通っている。全体スイートの一括実行と独立レビューはコミット時点で未了。**live（実モデル・実 Claude Code・実 LARM）の確認と実機器の確認は未実施**で、利用者の指示を待つ。画面（Web）の描画・操作も実画面では未確認 |
| 試験の登録 | `always-on-assignments.test.ts`・`assignment-kinds.test.ts`・`assignment-repairs.test.ts` は `scripts/domains.ts` の統合試験一覧に載っていない（ファイルを指定して流す） |
