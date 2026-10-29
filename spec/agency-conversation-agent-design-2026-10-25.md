# 会話エージェントを agency に置き換える設計

作成日: 2026-10-25。状態: **合意済み（2026-10-25）・実装中（§11.4）。** 現行の会話担当（dialogue の生成）を削除し、agency（`eumenes-agency`）を唯一の会話エージェントにする。[ContextWindow仕様](context-window-spec-2026-10-24.md)の§6（tool定義と生成）と、[Agency統合](agency-integration-spike-design-2026-10-22.md)を置き換える。合意後、両文書へ反映してから実装する。

## 1. 背景

現行の会話担当は、新しい発言ごとに `respond` で分類（`kind`・`freshness`・`impact`・`approved`）を出させ、分類と行動が合わない出力を構造の修正へ返し、修正も合わなければ失敗にしている。この方式で、ただの会話が返答なしで失敗した。

| run | 発言 | 失敗 |
| --- | --- | --- |
| `6839d520`（2026-10-25 05:52） | 「やっと動いてくれた」 | `respond_required` ×2 |
| `5145885e`（2026-10-25 06:00） | 「キャッシュできてないの」 | `answer_without_basis` ×2 |

会話担当は発言を種類に仕分ける分類器になっており、利用者と自然に会話するために作った agency は、背景の自発発話にしか使われていない。会話担当は今後保守しない。

## 2. 原則

1. **会話エージェントは agency ただ一つ。** 利用者の発言への返事、自分からの話しかけ、仕事の結果の報告は、すべて agency が行う。例外は、複雑な仕事で専門担当のsessionへ対話を切り替える場合だけ（現行の§6.8）。
2. **ツールの利用は会話の中で自然に行う。** タスクの依頼かどうかを判断するための回を設けない。分類を出させず、分類と行動を突き合わせない。agency は会話の流れでツールが必要だと判断したら、その返答の中で担当（toolchain）を呼び、仕事はサブエージェントが行う。
3. **待っているだけのbotにしない。** agency の自発発話（発話後・沈黙後の機会）は残す。
4. **TODOはサブエージェントが進め、状態と結果は agency に届く。** agency は機会ごとにTODOを見て、完了があれば読み上げる。伝え終えたTODOは `archived` になる。

## 3. 構成

| 部分 | 担当 |
| --- | --- |
| 利用者の発言への返事（ツールの利用を含む） | agency の返答（`respond`）。agency の人格・文体・感情・状態の提示で話し、必要ならツールを呼ぶ |
| 自発発話・TODOの完了の報告（発話後・沈黙後の機会） | agency の `decide`（現行の `select`。`hostTodos` で `done` も見る） |
| 意図・信念・候補・話題の種の更新 | agency の背景の `update`（現行） |
| 文脈（記憶・会話の流れ・仕事の結果・TODO） | 現行の ContextWindow で Eumenes が組み立てて agency に渡す（§9） |
| ツールの実行（担当への依頼・仕事の操作・記憶） | Eumenes（現行の実行処理を使う） |
| 担当の仕事 | サブエージェント（現行） |
| 受付・run・キュー・配信・音声 | Eumenes（現行） |

- 1回の利用者の発言に対して、返事を作る呼出しは agency の `respond` の1系統だけ（ツールを呼んだら結果を受けて続ける）。その後の背景の `update` は、agency の CLI と同じ現行の処理。
- dialogue domain は `eumenes-agency` を参照しない。組立て層（`api/application/agency/`）が agency と Eumenes の各 domain をつなぐ。

## 4. agency リポジトリの改修

- **返答（`respond`）:** 利用者の発言に答える公開操作を足す。入力は system（人格・文体・感情の規則、状態の提示 `AgencyProjection`、先に話しかけた内容）、ホストの文脈、会話の流れ、ツール定義。出力は発話と感情。現行の CLI の `ChatPort.reply` を、ツールとストリーミングに対応させて製品で使える形にする。
- **ツールの口（`ToolPort`）:** ホストがツール定義（名前・説明・入力schema・承認の要否）と実行を渡す。返答の中でツールが呼ばれたら `ToolPort` で実行し、結果を受けて続ける。回数の上限は agency 側で持つ。
- **mock:** agency には toolchain がないので、試験・評価用に `ToolPort` の mock を置く。担当の検索（固定の候補）・依頼の受付（TODOの作成）・`done` の結果を返し、Eumenes の担当の契約と同じ形にする。
- **TODOの完了の報告:** 現行の `hostTodos`（`done` を一つの次の行動と短く報告し、引用した発話が届いたらホストがアーカイブする）をそのまま使う。Eumenes は `done` も渡す（現行は未完了だけ）。
- 版を上げて vendor を更新する（`INSTRUCTION_VERSION`・`HOST_RULES_VERSION` も上げる）。

## 5. ツール

| ツール | 区分 | 動作 |
| --- | --- | --- |
| 担当の検索・依頼（`execute`・`confirm`・`approve`） | 担当（toolchain） | 会話の流れで必要と判断したときに使う。依頼はサブエージェントに渡り、TODOができる（現行の検索・委譲・予告・実行前の確認） |
| 仕事の操作（確認・質問への回答・訂正・取消） | 直接のツール | 現行どおり。アーカイブの操作は廃止（§6） |
| 記憶（読取り・依頼） | 直接のツール | 現行どおり。その場で結果が返り会話の流れで済むので、担当にしない |

## 6. TODO

**2026-10-29変更（優先）:** 完了したTODOは agency に渡さない。`done` になった取引でアーカイブし、Web の通知センターで知らせる。agency に渡すのは `todo`・`waiting`（質問）だけで、`result_received` の機会は新しい質問でだけ開く。報告枠・返答の照合（`reportedTodos` の消費）・音声再生完了によるアーカイブは削除した。[変更設計](todo-completion-notice-design-2026-10-29.md)。以下の2026-10-27変更と本節の箇条書きのうち、`done` の報告・アーカイブに関わる部分は廃止。

2026-10-27変更: 完了報告は雑談の未応答上限を消費せず、上限到達後も完了報告の機会を持つ。自発報告・通常返答とも、文字保存時は報告の紐づけだけを行い、音声再生のfullでアーカイブを確定する。中断・失敗・音量0は確定しない。[変更設計](todo-spoken-report-delivery-design-2026-10-27.md)。§11.4の保存時確定の記録は変更前の実装履歴であり、この変更が優先する。

- 追加・`waiting`・`done` は実行台帳の遷移による（現行）。agency はTODOを追加・完了しない。
- `done`・`waiting` は agency の機会（TODOの変化・発話後・沈黙後）で `Opportunity.todos` に入り、agency が報告・質問する。
- **アーカイブ:** TODOを引用した発話（`todo:<id>`）の配信が最後まで聞かれた（`heard: full`）時点で、ホストが `archived` にする（agency の現行の `hostTodos` の規則）。途中で止まった・届かなかった場合は `done` のまま残り、次の機会で再び見える。
- **TODOの結果の検査:** `todo:<id>` を引用した発話は、そのTODOが結果のある `done`（または質問のある `waiting`）でなければ採用しない（agency の `validateParticipation` の根拠の検査に加える）。古い情報の回答への対策はこの検査とする。
- 利用者が不要と言ったTODOの扱いは今回の対象外とし、後の課題にする。

## 7. 削除するもの（Eumenes）

| 対象 | 内容 |
| --- | --- |
| 生成の判断と出力 | `respond` tool、分類（`kind`・`freshness`・`impact`・`approved`）、根拠の検査、`tool_choice: required`、構造の修正の特例（`dialogue/service/generation-tools.ts`・`generation-loop.ts` の該当部分） |
| 生成の指示文 | `dialogue/contexts/host-rules/`・`conversation-generation/` の会話担当向けの文（agency の指示に置き換え） |
| 選択の記録の分類 | `toolchain_selections.analysis_json`（列・型・書込み） |
| 仕事の操作のアーカイブ | `told`・アーカイブ要求の2段 |
| 主会話向けの agency の別枠 | `dialogue/service/agency-layer.ts`（agency 自身が話すので不要） |
| agency 専用の LLM の設定 | 設定 `agency.resourceId` と、その資源の確認・拒否の処理（`api/application/agency/llm-port.ts` の該当部分、settings の項目と画面） |
| サブエージェント専用の LLM の設定 | 設定 `subagent.resourceId` と、それに従う振分け（`agent-runtime/service/step-handler.ts`、`dialogue/service/toolchain-command.ts`、Webページの本文の確認 `api/application/toolchain/web-content-review.ts`、settings の項目と画面）。保存値は null なので動作は変わらない |
| Codex による調査の担当 | toolchain `web.research.codex`（bundle・runtime-meta の項目）、`inference/adapters/codex-research.ts`、`inference/service/codex-model.ts`、inference の `codexResearch` の受渡しと `codexResearchAvailable`、agent-runtime の `researcher: "codex"` の分岐、起動設定の Codex 調査の項目。ほとんど使われず選ばれる見込みも低い。長期思考のサブエージェント（eumenes_pursuit）に組み込む場合は別の設計で行う。Codex SDK の接続（`codex-sdk.ts`）は kanban・cloud-agents が使うので残す |
| 会話担当の評価 | `dialogue/eval/context/` のうち会話担当の生成を前提にするもの |

具体的なファイル単位の削除一覧は、§10の決定後に実装計画として本書に追記する。

## 8. 試験

- agency リポジトリ: `ToolPort` の mock で、返答の中の担当の検索・依頼、`done` の報告とアーカイブの引用、結果のないTODOを引用した発話の不採用を通す。
- Eumenes の固定試験: 挨拶・相づちに agency が1回の返答で答える。現在の情報の依頼で担当に依頼し、予告が話される。TODOが `done` になると報告され、`heard: full` で `archived` になる。`partial` では `done` のまま残る。沈黙で自発発話が起きる。
- live: run `6839d520`・`5145885e` と同じ発言で返答が返る。担当の仕事が終わると読み上げられる。
- 検証: agency リポジトリの `bun run verify`、Eumenes の `bun run verify -- --domain dialogue` と影響のある domain、`api/application/agency/` の試験。

## 9. 決定事項（2026-10-25、利用者）

- agency リポジトリの改修を本件に含める。toolchain は agency にないので mock できるようにする。
- agency の自発発話は残す。沈黙の機会でも推論する（受動的に待つだけのbotにしない）。
- 現行の会話担当は使わず、削除する（今後保守しない）。
- タスクの依頼かどうかを判断する回を設けず、会話の流れでツールを使う。
- 利用者が不要と言ったTODOは後の課題。
- 古い情報の回答は、TODOの結果の検査で防ぐ。
- 文脈は現行の ContextWindow を agency の返答の文脈にする。差し替えるのは先頭の指示とtool定義だけ（会話担当の規則と `respond` を、agency の人格・文体・感情の指示と agency のツール定義に置き換える）。中身（長期記憶・`log`・`episode`・`active`・`state`）と並び（キャッシュの維持）は変えない。agency の状態の提示は現行の `now.agency` に入れる。

- LLM: agency のすべての呼出し（返答・背景の `update`・自発発話の `decide`）は、Eumenes に設定されている会話の LLM を使う。別の LLM を使わない。agency は Provider を選ぶ仕組みを持たず、ホストが渡す口で呼ぶ。返答には inference と LARM の接続（ストリーミング・キャッシュ・tool呼出し。Eumenes の共通部品）を渡す。agency 専用の設定 `agency.resourceId` と、その資源を確かめて agency を止める処理（`AgencyRouteRefusedError` 等）は削除する。
- 推論の LLM は Eumenes に設定された一つに揃える。例外は次だけ。
  - World の記憶担当: **LARM の LLM に移行（2026-10-25 決定）。** Claude Agent SDK の専用資源をやめ、`world.curationResourceId` を `null`（会話と同じ経路）にした。会話の LLM 経路もクラウドへの切り替えをやめて `larm-only`（`fallbackId: null`）にした。クラウドの資源・接続と `cloudAllowed` は残し、クラウドをメインの推論（`cloud-only`）として選ぶ道は残す。きっかけは 10/21〜10/25 の `cloud_agent_billing_error` による全件失敗。2026-10-15 の比較ではローカル LLM が記録の形式を正しく書けなかった（[検証記録](verification/world-steward-2026-10-14/README.md)）。検査・指示を直した版での LARM の出力品質は未測定なので、実データで確認する。
  - kanban・codex-tasks: Codex・Claude SDK が担当しうる。
- Web 検索の担当（`web.search`・`web.service-search`）、ほかのサブエージェント、Webページの本文の確認（`web-content-review.ts`）は Eumenes の LLM を使い、`subagent.resourceId` を削除する。
- 発話はストリーミングで返し、現行の音声の処理（句読点単位で音声を生成して順に再生する）をそのまま使う。

## 11. 実装計画（2026-10-25）

### 11.1 作業の分担

| 作業 | 場所 | 担当 |
| --- | --- | --- |
| W1 agency の返答・ツールの口・mock・TODOの照合 | `../eumenes_agency` | サブエージェント |
| W2 LLM 設定の整理（`subagent.resourceId`・`agency.resourceId` の設定項目、Codex 調査の担当のうち inference 以外） | settings・agent-runtime・capabilities・web-research の adapter 呼出し側・config・Web の設定画面 | サブエージェント |
| W3 会話担当の置き換え（dialogue の生成・agency ホスト・音声の感情・選択の記録） | dialogue・`api/application/agency/`・toolchain-history・voice-dialogue | 本体 |
| 共有ファイル（`package.json`・`bun.lock`・`vendor/agency`）、inference の Codex 調査の受渡し | | 本体（W1・W2の後。inference は並行作業の確定を確かめてから） |

### 11.2 agency の公開物（W1 の契約）

- `respondSystem(options)`: 返答の system の文。自然な会話の基本、人格（関心）、音声の文体（`spokenReplyStyle`）、感情（有効なら返答の先頭に15種の絵文字を一つ）、ツールの使い方（会話の流れでツールが必要と判断したら使う。タスクの依頼かを判断する回は設けない。担当の検索の後は依頼するか断る。完了の報告は自分からしない＝`decide` の役目）、状態の提示（`AgencyProjection`）、先に話しかけた内容。
- `runRespond(input)`: 返答の1回。`ReplyPort.complete({ messages, tools }, onDelta, signal) → { text, toolCalls }` を呼び、tool呼出しがあれば `ToolPort.call` で順に実行して結果を tool message で返し、続ける。上限（既定4回）を超えたらツールを渡さずに最後の呼出しをする。`end: true` の結果で終わる。tool呼出しと同じ出力の本文は、話した前置きとして残す。感情が有効なら先頭の絵文字をストリームから除いて返す。戻り値は `{ text, emotion?, ended, calls }`。
- `ToolPort`: `{ tools: { name, description, parameters }[]; call({ id, name, arguments }, signal) → { content: string; end?: boolean } }`。
- mock: `createMockToolPort()`。担当の検索（固定の候補）・依頼（TODOを作る）・仕事の操作・記憶を Eumenes と同じ名前と引数で返し、試験から TODO を `done` にできる。CLI は mock で動く。
- TODOの照合: 背景の `update` が、通常の返答（`exchange.adopted`、actor agent）がどの `todo:<id>` を伝えたかを照合として返せる。`AgencyRuntime.takeReportedTodos() → { todoId, observationId }[]`。ホストは、その観測の発話が最後まで届いていれば `archived` にする。update に見せるTODOは `RuntimeDeps` に渡す取得関数から得る。
- 版を上げ（`INSTRUCTION_VERSION`・`HOST_RULES_VERSION`）、tgz を作る。

### 11.3 Eumenes（W3）

1. dialogue の生成: `respond` tool・分類・根拠の検査・`tool_choice`・修正の特例・`stop` を削除する。返答は dialogue の port（`ConversationAgentPort`）で行い、組立て層が agency の `runRespond`・`respondSystem` と inference の `executeStream`（`ReplyPort`）、dialogue の実行処理（`ToolPort`）でつなぐ。ContextWindow の先頭の会話担当の規則（`host-rules/tools.context.toml` の分類の記述など）を agency の system に置き換える。
2. TODO: 仕事の操作の `archive`・`told` を削除する。TODOの変化（`done`・`waiting`）のきっかけで会話担当の run を作るのをやめ、agency の `result_received` の機会を開く。agency に `done`（結果・outcome）も渡す。`decide` の発話が `todo:<id>` を引用し最後まで届いたら、また通常の返答が照合で伝えたと判断されたら、`archived` にする。
3. 主会話の返答の感情を音声の抑揚・モーションに使う（agency の発話の感情と同じ仕組み）。
4. `toolchain_selections.analysis_json` を削除する（追記の migration で列を削除）。選択の記録の `analysis` を書かない。
5. `agency.resourceId` を使う `api/application/agency/llm-port.ts` の資源の確認・拒否を削除し、会話の route で呼ぶ。
6. 削除で使われなくなるコード・試験・評価（`dialogue/eval/context/` の会話担当の生成の前提部分）を削除する。

### 11.4 実装の記録（2026-10-25）

- W1（agency）: `respondSystem`・`runRespond`・`ReplyPort`・`ToolPort`・`createMockToolPort`・`takeReportedTodos`・`HostTodo.status: "waiting"`（`question`）を実装。CLI は mock のツールで動く。`INSTRUCTION_VERSION` `p0e-instructions-11`、`HOST_RULES_VERSION` `host-rules-5`。照合は B1 に `reconciliations` がないため、hostTodos の update に `reportedTodos: [{ todoId, observationRef }]` を足した。tgz は未コミットの作業ツリーから作ったもの（`dirty: true`）を vendor に取り込んだ。agency リポジトリのコミット後に作り直して取り込み直す。
- 会話エージェントの ON/OFF（`agency.enabled`）も削除した。agency が唯一の会話エージェントで、自発発話は必須のため、常に動く。
- dialogue: 生成は `ConversationAgentPort.respond`（組立て層が agency の `runRespond` でつなぐ）で行う。host は ReplyPort（`executeStream`、準備したメッセージが常に先頭）と ToolPort（固定の4種。受け付けない呼出しは理由を結果で返し、agency が続ける）を渡す。`respond` tool・分類・根拠の検査・構造の修正（`correction*.context.toml`）・`spoken_reply_too_long`・`tool_choice`・仕事の操作の `archive`/`told`・選択の記録の `analysis`/`repaired` を削除した。system は agency の `respondSystem`（設定で決まる）＋Eumenes の人格と host の規則。agency の状態は `now.agency`（`AgencyLayerPort.stateForContextInTransaction`）。
- TODO: 仕事の結果だけで起きる run は生成せずに完了し（サブエージェントの答えはここで消費）、agency の `result_received` の機会を開く（`workChangedInTransaction`、利用者が今いる会話のとき）。agency には `todo`・`waiting`（質問）・`done`（outcome と一行の結果）を渡し、取り消した仕事は渡さない。`decide` の発話が引用した `done` は保存と同時に `archived`（agency の発話は保存で配信済みとする現行の扱い）。通常の返答が伝えたと update が照合した `done` は、その返答が最後まで聞かれたら `archived`。
- 返答の感情は、返答の配信の感情（`hostDelivery`）として保存する。ストリーミング中の句ごとの音声は、従来どおり LARM の判定による。
- 仕事の結果だけで完了する run の扱い（試験移行で見つかった不具合の修正）:
  - 引き渡し後の別のコミットで生成が取消扱いにならないよう、生成の古さの判定は「この生成の引き渡しで次の版の `queued` になった run」を引き渡し済みと見なす。
  - 通知 run は答えを持たずに完了しても、通知は届いたもの（`delivered`）とする。報告は TODO が運ぶ。
  - 生成せずに完了する run は、答えのリクエストをホストの答えとして受理する（`acceptRunAnswer`。専門担当の返答と同じ扱い）。これで音声ターンが `permission_revoked` にならない。引き渡しの時点では受理しない。サブエージェントは pending の親リクエストの下で推論するため。
- agency の `result_received` は、まだ機会を開いていない `done` か質問が TODO にあるときだけ開く。ロールバックした取引の知らせは何も開かない。
- agency が読む `done` の結果は、その時点の操作の結果を読み直したもの（完了後の取消が見える）。旧来の結果ラウンド直前の読み直しに代わる、TODO の結果の検査（§9 Q6）。
- 検証（fixture）: domain の試験（dialogue 340・voice-dialogue 68・inference と settings 211・toolchain-history 10・continuity 24・agent-runtime 145・capabilities 93・web-research 56・tool-runtime 31）は全件通過。`api/application` は 900 件中 899 件が通過し、残る 1 件は vendor の `dirty: true` による。live と実機器の受入は未実施。
