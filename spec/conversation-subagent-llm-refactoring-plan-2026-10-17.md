# 会話モデルとサブエージェントのLLM経路 リファクタリング計画

作成日: 2026-10-17

状態: 計画に合意済み（2026-10-17）。D 項目に依存しない P2・P3 を実装し、fixture で検証済み（§8）。D1〜D13・P0・P1・P5 は未実施。そのうえで、§6 の D 項目に依存する改修は、その D 項目が決まるまで実装しない。どの改修がどの D 項目に依存するかは、§3 の各表に「（D◯）」と付ける。依存のない改修が P2・P3 に入る（§4）。

## 1. 目的と原則

利用者が示した次の5原則を正本とし、通常会話・専門担当・調査サブエージェント（agent-runtime）のLLM経路を整理する。[委譲前の一時回答 §9](conversation-pre-delegation-response-design-2026-10-17.md) の5条件と同じ内容であり、本計画はその実装を、壊れにくく、速く戻れる形に直す。

1. **長く話さない。** 返答はTTSで読み上げられる。
2. **短く予告してから実行する。** 推論の段階は分かれてよい。その代わり、速く結果まで戻り、利用者を待たせない。
3. **時間のかかる制作は専門担当に入れ替える。** UI自由制作などは、作業完了まで専門担当が会話相手になる。
4. **サブエージェントのSystemContextは簡潔にする。** 決まったタスクの実行だけに集中させる。
5. **現在の依頼とSystemContextを区別する。** 利用者の現在の発言が、実行すべき命令である。SystemContextはそのタスクのための補助情報にすぎない。

新しい判断方式・優先順位・フォールバックは、§6 で合意したものだけを導入する。語句で分岐する処理と、固定の返答文は追加しない。

## 2. 前提と根拠

### 2.1 コードの状態

- §9（160字・2文の発話契約、予告の再生待ち）は、HEAD `6ebc6e36` でコミット済み。
- 作業ツリーには、同じ設計書 §10（修復時も現在の依頼を最後に固定する修正）の未コミット差分がある。対象は `api/domains/dialogue/service/conversation-generation.ts`、`generate-selection.ts`、`generation-handler.ts` とその試験。本計画はこの差分が確定した後に着手する（P0）。
- 通常会話では、`api/domains/dialogue/service/request-context.ts` の `markCurrentRequest`・`currentRequestMessage`・`currentRequestRules` と §10 の修正によって、現在の依頼を最後に置く方式がすでにある。原則5で未対応なのは、専門担当と agent-runtime である。

### 2.2 根拠

同日のコードレビュー（会話パイプライン、専門担当の切替・復帰、agent-runtime のループの3領域）。主要な指摘は、コードを読んで確認した。

運用ログの集計（`data/logs/api.jsonl` と `.1`、10/9〜10/17）は次のとおり。
- 対象は `agent.state_changed` のうち worker の最終状態。
- 内訳は、completed 41、failed 41、cancelled 3、interrupted 1（計86）。
- failed の理由は `error_code` で数えた。出力形式・契約・意味検証による拒否が約36件（約88%）。
  - `invalid_control_json` 18
  - `requirement_verification_failed` 8
  - `invalid_tool_input` 3
  - `invalid_evidence` 2
  - `invalid_requirement_schema` 2
  - `invalid_requirement_contract` 2
  - `tool_url_out_of_scope` 1
- 時間切れ（`deadline_exceeded`）は2件、予算切れは1件。
- 10/15〜17 の completed と failed の比は 24対6。

結論として、品質低下の主因は探索の方針ではない。次の3つである。
- 失敗時に、どこが悪いかを伝えずに1回だけやり直させている。
- 発話の長さ違反で、ターン全体を失敗させている。
- 専門担当への引き継ぎと、通常担当への復帰で、状態が食い違う。

## 3. 原則ごとの問題と改修方針

参照はシンボル名を主とし、パスは `api/` から書く。

### 3.1 原則1: 長く話さない

| 問題（根拠） | 改修 |
| --- | --- |
| 担当選びの呼び出し（`dialogue/service/generate-selection.ts` から `generateConversation` へ `briefReply` を渡す）にも、発話の長さ検査がかかる。この呼び出しは `sessionRole: "auxiliary"` で、関数を呼ばずに返した散文は破棄される。それでも長さ違反が2回続くと、run が失敗する | 発話契約は、利用者に届く文を生成する呼び出しだけに適用する。除外するのは、`selectionMessages` がある補助的な担当選び（`sessionRole: "auxiliary"`）だけとする。候補がないときの `generateSelection` は `main` として利用者向けの回答を生成するので、この経路では `briefReply` の検査を残す。散文を破棄することは既存の契約どおりなので、検査の対象を正す調整として扱う |
| 書き直しの指示が、理由を伝えない。通常会話の `contexts/conversation-generation/correction-4` には内部コード名 `spoken_reply_too_long` が入り、無関係な違反のときにも付く。専門担当の `CORRECTION`（`specialist-prompt.ts` の `correctionMessage`）は「契約に合いません」としか言わない | 書き直しの指示に、違反の種類と、現在の字数・文数・上限を、参考資料として渡す（§3.5 の囲みを使う）。内部コード名は文面に出さない。発話の長さの案内は、長さ違反のときだけ付ける |
| 専門担当の返答文の長さ違反は、`outputShape` の `.refine(isBriefSpokenReply)` で判定される。この違反と、他の契約違反（invoke に text を付けた、など）とで、`specialistTurn` のやり直しフラグ `repaired`（ターン全体で1つ）を共有している。そのため `invoke` で作業が反映された後でも、最後の返答の違反でターンが `specialist_invalid_contract` になる | 違反の種類を書き直しの指示に渡す（上の行と同じ）。やり直しを数える単位は D3、作業反映後に返答だけが失敗したときの扱いは D10 で決める |
| 発話の整形（`api/domains/delivery/service/spoken-text.ts` の `spokenText`）は、ホスト名の判定が `[a-z]{2,63}` を TLD とみなす。そのため `Node.js`・`file.txt`・`main.py` を URL として消し、字数の見積もりも狂う | （D13）削除の対象を、スキーム付きの URL と `www.` で始まるホスト名だけにする。スキームのない裸のドメインは読み上げに残る。試験は delivery domain に置く |
| 「詳しく」と頼まれたときの例外が、全経路から消えた | 読み上げる部分は常に短くする。詳しい内容の扱いは D1 で決める |

### 3.2 原則2: 短く予告してから実行し、速く戻る

| 問題（根拠） | 改修 |
| --- | --- |
| 予告の再生完了待ち（`dialogue/service/operation-announcement.ts` の `deliverAnnouncement`、`voice-dialogue/service/announcement-delivery.ts`）に、独自の上限がない。実際には run の deadline まで待つ。次の場合は依頼ごと失敗する。ブラウザを閉じている。読み上げる文が1つもない（`announcement_audio_missing`）。音声が1つでも飛ばされた（`announcement_audio_failed`） | 待ちの扱いは D2 で決める。読み上げる文が1つもない予告は、生成時の検査で拒否して書き直させる。これは既存の上限付き修復に乗せるので、新しい判断は追加しない |
| 担当選びの入力に、ユーザーの発言しか入らない。候補検索のクエリ（`delegate-conversation.ts` の `routing.query`）は、現在の発言だけを使う。これは「過去のターンは参照資料に置き、検索の信号にしない」という意図による分離である。一方、担当選び用のメッセージ（`selection-trace.ts` の `selectionMessages`）は、assistant の発言を落としている。そのため「画像作りましょうか？」→「お願い」で、選定するモデルが直前の質問を見られない | （D8）担当選び用のメッセージに、直前のアシスタント発言を参考資料として加える。命令の正本は現在の発言のまま（§3.5）。検索クエリは変えない |
| 1ターンの中で、問い合わせ文の埋め込み（`embedQuery`）と記憶の想起（recall）が2回走る（`selection-trace.ts` の `prepareInitialDecision` と `prepareDecision`） | 初段で得た結果を、担当選びで再利用する。同じ入力に対する同じ計算をまとめるだけなので、判断は変わらない |
| 調査が失敗したとき（`failureCode`）、`researchResultContext` は longTerm と goals を除く。しかし `instructionCount`（`generation-prepare.ts`）は、除く前の数のままである。Claude セッションの `splitMessages` が例外になり、失敗を説明する返答が出せない | `instructionCount` を、組み立て後のメッセージ列の先頭にある system の数から求める |
| 現在時刻を、UTC の ISO 文字列に `timeZone: "Asia/Tokyo"` を添えて渡している。時計も `deps.clock` ではない（`research-result-context.ts`、`specialist-prompt.ts` の `specialistInput`、`agent-runtime/service/context.ts`）。日本時間の0〜9時は日付が1日ずれて見える | 既存の意図（日本時間で扱う）に合わせて、表現を直す。`deps.clock` から、JST のオフセット付き ISO 8601 で渡す。渡す場所と情報は変えない |
| 通常会話の初段には、現在日時が入っていない | （D9）初段にも現在日時を参考資料として渡すかを決める |

速さの目標: 委譲する場合、予告が出るまでのLLM呼び出しは、修復を除いて2回以内（初段と担当選び）とする。予告を出してから委譲先を起動するまでに、LLM呼び出しは追加しない。結果までの時間の基準は P5 に置く。

### 3.3 原則3: 制作は専門担当へ入れ替え、完了まで担当させる

| 問題（根拠） | 改修 |
| --- | --- |
| 専門担当が依頼を通常担当へ戻すとき（`specialist-settle.ts` の `forwardToMain`）の重複防止キーが `specialist-forward:${run.id}` である。同じ run で2回目に戻すと、次のいずれかになる。① 完了済みの旧ジョブに紐づき、run が `queued` のまま止まる。② `request_conflict` で settle が失敗する。専門担当の各ターンのキー（`specialist-turn:${run.id}:${sessionId}:${epoch}`）は、すでに修正済み | キーにセッション id と epoch を含める。別の担当なら session id が異なる。同じセッションでも、再開（`specialist-start.ts` の `live.epoch + 1`）を挟めば epoch が進むので、同じ run の中で何度戻しても区別できる。同じ形のキー（`toolchain-answer:${run.id}` が2か所、`toolchain-command:${run.id}`、`operation-answer:${run.id}`）については、1つの run で2回作られうるかを確認し、作られうるものだけ同じように直す |
| 専門担当のLLM呼び出しは1ターン6回まで（`MAX_MODEL_CALLS = 6`）。6回目が `invoke` だと、成功しても `specialist_turn_limit` で失敗し、返答がない | （D11）上限に達したときの扱いを決める |
| 引数違反の詳細が捨てられる。`api/application/toolchain/specialist-port.ts` の `parseInvocation` は `specialist_invalid_arguments` しか返さず、モデルは直し方が分からない。SKILL は「error と detail に従って直す」としている | TOOL_RESULT の `detail` に、違反の場所（path）・種類（code）・期待する型だけを入れる。入力値は含めない。最大8件、各200字以内とする。既存の契約にある `detail` を埋めるだけなので、新しい判断は追加しない |
| 失敗したターンが履歴に残らない。`sessionHistory` は `status === "completed"` だけを採用する | （D12）失敗したターンを、依頼と失敗の短い記録として履歴に残すかを決める |
| 専門担当が依頼を戻すとき、後ろに詰まっていた発言のほうが、先に通常担当へ届く（`specialist-settle.ts`）。画面の「会話に戻る」（`specialist-commands.ts`）では、詰まっていた発言が `cancelSessionRuns` で黙って取消される | （D5）詰まっていた発言の扱いを決め、2つの経路で揃える |
| 保留中の下書きがあるときに「新しく作って」と頼むと、保留中の下書きが再開される。`specialist-start.ts` は、`toolchainId` と `savedRef === target` が一致すれば同じ対象とみなす | （D6）[専門担当の計画 §4.4](toolchain-specialist-dialogue-implementation-plan-2026-10-17.md) の再開規則を変えるかを決める |
| `api/domains/dialogue/contracts/specialist.ts` の epoch のコメントには「start, return, resume で進む」とあるが、return では進まない。return 後は state が active でなくなり、`addresseeMatches` で拒否されるため、実害はない | コメントを実装に合わせる |

### 3.4 原則4: サブエージェントのSystemContextを簡潔にする

| 問題（根拠） | 改修 |
| --- | --- |
| agent-runtime の修正やり直しは、タスク全体で1回だけ（`agent_tasks.json_repairs`、`step-actions.ts`）。最初の構文エラーで使い切ると、後の引数ミス1回でタスクが失敗し、集めた根拠も捨てられる | （D3）やり直しを数える単位を決める |
| やり直しの指示に、どこが悪いかが入らない。`ValidationFailure` 以外の例外では、モデルに渡るのは `[{validationCode}]` だけ。意味検証のやり直し（`requirement-verification.ts` の `prepareRequirementVerification`）は固定文だけで、`lastResult.issues` を読まない | 次の例外を `ValidationFailure` にし、場所と理由を持たせる。対象は `api/domains/agent-runtime/service/requirements.ts`、`evidence-catalog.ts`、`api/domains/capabilities/service/requirement-schema.ts`、`requirements.ts` の plain Error。`tool-runtime/service/read-invocation.ts` はすでに `ValidationFailure` を使っているので、残っている箇所だけを直す。意味検証のやり直しにも `lastResult.issues` を渡す。既存の issues 契約を埋めるだけである |
| Web検索以外の調査ルート（`research-contract.ts` の `researchAction`、`firstResearchAction`）には、出力例がない。また「answered/partial なら根拠つきの主張（claim）を1件以上」という指示は、`search && !guided` のときしか入らない。ログの `report.claims too_small` 12件と一致する | 調査ルートごとに、最小の出力例を schema の examples として1つ置く。既存の必須条件（claim を1件以上、`checks`・`externalRules`・`evidence` が必須）を、schema の description に書く。条件そのものは変えない |
| worker-control 系の SystemContext が、9ファイル・5637バイトある。ルートや段階ごとの分岐（`instructions-for-2..5`、`route-policy-2`）が重なっている | 各ルートの SystemContext を「役割・出力契約の参照・やってはいけないこと」の1枚にまとめ、1ルート1.5KB以内を目安にする。分野ごとの手順は、TOOLS/schema か担当 SKILL に移す。削る指示は消さずに移し、移動先を表に記録する（P3） |
| 専門担当の `contexts/specialist-turn/rules` が、行動の契約・作業の進め方・保存・World/Memory の禁止・曖昧な依頼への対応を、1つの段落に詰め込んでいる | 行動の契約（reply/invoke/return/discard）は、出力 schema の description と例だけに書く。RULES は次の3点に絞る。① 現在の依頼が命令であること。② 短く話すこと。③ 保存は画面のボタンで行うこと。それ以外の判断規則は、移動先を表に記録したうえで SKILL・schema・host のいずれかへ移す。移す規則は、未指定の事項を仮置きすること、viewing と savedRef が異なるときの return、discard は明示されたときだけ、曖昧な依頼では確認すること、など |
| 前回の誤りがない（`research_no_progress`）のに、「契約違反を直せ」と通知する（`context.ts` の通知条件）。根拠を保存する上限（`evidenceCapacityReached`）に達して TOOLS が消えても、モデルに説明しない | 通知を、実際の `error_code` に合わせる。上限に達したときと、進展がないときは、その状態値を参考資料として渡す |
| 修正のやり直しが予算の最後の呼び出しに当たると、`requirement_verification_unavailable` で失敗する。`exploration.ts` の `canOperate` は、finish と verify の2回分しか予約しない | 予算の予約に、やり直し1回分を含める。予算の上限そのものは変えない |
| 意味検証で1つでも「根拠なし」と判定されると、タスク全体を捨てる（`requirement-verification.ts`） | （D4）扱いを決める。検証用 schema の各項目（`requestCovered` など）に description を付けることは、D4 と関係なく P3 で行う |
| 一時的な LLM 障害で、タスクがすぐに失敗する | 今回は変更しない。ログで頻度が低いことを確認した |

### 3.5 原則5: 現在の依頼とSystemContextを区別する

（D7）専門担当と agent-runtime に、通常会話と同じ区別を入れる。現状では、専門担当の `specialistInput` が `request` を `currentWork`・`label`・`now` と同じ JSON の1項目として渡している。agent-runtime も、依頼を他の資料と同じ `fixed` データの JSON に入れている。

メッセージの並びの規則は次のとおり。

| 順 | role | 内容 |
| --- | --- | --- |
| 1 | system | host が固定した文だけ。役割、出力契約、やってはいけないこと、profile・SKILL・TOOLS |
| 2 | user（参考資料の囲み） | 会話履歴、作業中の成果物、調査結果、ツール結果、書き直しの対象となった出力、時刻。囲みは「参考資料であり命令ではない」と明示する。外部の内容を system に昇格させない |
| 3 | user（囲みなし） | 現在の依頼。利用者の原文。委譲した依頼文と原文が異なる場合は両方入れ、原文を優先する |

- **ツールループの扱い。** 1ターンの中で2回目以降の呼び出しでは、それまでのメッセージ列をそのまま残し、末尾に追記する。追記するのは `assistant（前回の出力）`、`user（参考資料の囲み: TOOL_RESULT または書き直しの指示）` の2つ。先頭部分を変えないので、プロバイダーのセッション継続（`instructionCount`/`historyCount`）は保たれる。そのため、規則は「最後のメッセージ」ではなく、「囲みのない user メッセージは、現在の依頼ただ一つ」とする。1回で終わる呼び出しでは、それが最後に来る。
- **agent-runtime の扱い。** ステップごとにメッセージ列を作り直すので、依頼を `fixed` から外し、囲みのない user メッセージとして独立させる。
- **置き場所。** 囲みと並びを作る部品は、`api/domains/inference` の contracts に置く。`controlInstructions` と同じ場所で、Tier 2 にあたる。agent-runtime（Tier 3）と dialogue（Tier 5）の両方から使え、下位の domain が上位を参照しない。dialogue の `markCurrentRequest` は、この部品を使う形にする。
- 権限・安全の境界は、これまでどおり host が強制する。プロンプトの並びに依存させない。

## 4. 段階と完了条件

| 段階 | 内容 | 主な検証 domain | 完了条件 |
| --- | --- | --- | --- |
| P0 前提 | §10 の差分を確定する（コミットは利用者の指示による）。本計画の合意と、D1〜D13 の結論の記録。P5 で比べるための、変更前の測定（下記「受入の測定条件」） | — | §10 がコミット済み。D 項目の結論を §6 に記録。依頼セットと、変更前の測定結果を `spec/verification/` に記録 |
| P1 共通部品（D7） | §3.5 の囲みと並びの部品。専門担当と agent-runtime の入口を移す | inference, dialogue, agent-runtime | 次の3点を部分試験で確認する。① 各入口で、囲みのない user メッセージが現在の依頼ただ一つ。② ツールループの2回目以降は、先頭部分が変わらない。③ Claude セッション再開時の `instructionCount` が一致する |
| P2 不具合修正（D 不要） | 担当選びを発話契約の対象から外す、書き直しの理由、`instructionCount`、重複防止キー、引数違反の detail、`ValidationFailure` 化と意味検証の issues、誤った通知、時刻表現、埋め込みと想起の再利用、予算の予約、予告の読み上げ可能性の検査、epoch のコメント | dialogue, agent-runtime, capabilities, tool-runtime, voice-dialogue と `api/application/toolchain/` の specialist-port 試験 | 各指摘に再現試験を用意し、修正前は失敗、修正後は成功することを確認する |
| P3 SystemContext の簡潔化（D 不要） | 専門担当の RULES と worker-control の整理、出力例、schema の description | dialogue, agent-runtime | 次の4点を満たす。① SystemContext の文字数を前後で記録する。② 削った指示と移動先（schema・SKILL・host）の対応表を本書に記録する。③ 移した判断規則ごとに実モデルのケースを用意し、前後で同じ挙動になることを live で確認する。④ SystemContext の編集は既存の手順（`context_compile`・`compile_eval`）で行い、回数を記録する |
| P4 合意事項の実装 | D1〜D6、D8〜D13 のうち、変更すると決まったもの | 各 D の対象 domain（D13 は delivery） | D ごとの部分試験と結合試験 |
| P5 受入 | 実モデルの試験と、実機器での音声確認 | — | 下記の基準 |

検証は `bun run verify -- --domain <name>` で、段階ごとの上表の domain をすべて指定する。fixture・実モデル（live）・実機器の結果は分けて記録する。

`api/application/toolchain/toolchain.test.ts` には、HEAD でも失敗する既存の6件がある（[設計書 §7・§8](conversation-pre-delegation-response-design-2026-10-17.md)）。このうち「worker の入力を、未信頼資料の囲みなしの JSON として読む」という期待値は、P1 の新しい契約に合わせて更新する。残りの5件は本計画の対象外として、変化がないことを記録する。

### 受入の測定条件

運用ログの集計（§2.2）は、問題の所在を示す根拠にとどめる。P5 の合否判定には使わない。合否は、同じ条件で行う変更前（P0）と変更後（P5）の比較で決める。

- **依頼セット:** 次の6種類を、文面を固定して用意し、P0 で記録する。
  1. 自力回答
  2. Web 調査
  3. Web 以外の調査ルート
  4. 画像生成
  5. UI 自由制作の複数往復（制作・部分修正・通常担当への復帰）
  6. 直前の質問への短い応答（「お願い」など）
- **試行数:** 各依頼を10回ずつ、合計60回。変更前と変更後で同じ数にする。
- **実行条件:**
  - 実行は、変更前・変更後で揃える。具体的には、同じ保存済みの LARM 接続先と resource 設定、同じ依頼の文面と順序で、会話の履歴がない新しい会話から実行する。
  - 設定は、保存済み設定のスナップショットの識別子として記録する。モデル名・profile 名は書かない。
  - サーバーの起動は利用者が行う。
- **失敗率:** 依頼の種類ごとに、失敗した回数を試行回数で割る。利用者が取消した試行は、分母から除き、件数を別に記録する。失敗理由は `error_code` ごとに数える。
- **時間:** 依頼の種類ごとに、次の2つの中央値と p90 を記録する。時刻は、run の受付と、予告の保存・最終回答の保存のログ時刻から求める。
  - 発言から予告が出るまで
  - 発言から最終回答が出るまで

P5 の基準（実モデル）
- 失敗率が、どの依頼の種類でも変更前以下で、全体では変更前より低い。
- 時間の中央値が、どの依頼の種類でも変更前以下。
- 読み上げる返答が、全試行で発話契約の上限を守る。
- UI 自由制作の複数往復が、10回すべて失敗せずに完了する。

実機器での音声3往復は、これまでどおり音声 MVP の完了条件とする。サーバーの起動・停止は利用者が行う。

## 5. 対象外

- 担当を探さずに自分で答えてしまう問題の根本対策。[設計書 §9](conversation-pre-delegation-response-design-2026-10-17.md) で、指示を追記しても改善しないと結論している。そのため、担当選びで候補が選ばれなかったことを回答側に伝える指示の追加も、本計画では行わない。
- 一時的な LLM 障害の再試行と、クラウドへのフォールバック。
- サブエージェント専用のクラウド設定が、会話側の `cloudAllowed` に従属していること（`inference/service/background-control.ts`）。設定の仕様として別途扱う。
- `codex_research_` 接頭辞による分岐。モデル名・profile 名ではないため。

## 6. 要合意事項

| ID | 論点 | 選択肢 |
| --- | --- | --- |
| D1 | 詳しい説明を求められたとき | (a) 読み上げは常に短くし、詳細は読み上げない表示用の本文に分ける（新しい出力形式） / (b) 常に短い要点だけを答える（現状） |
| D2 | 予告の再生待ち（現状は run の deadline まで待つ） | (a) 上限 N 秒で失敗とし、その旨を表示する / (b) 上限 N 秒で打ち切り、委譲を続ける（§9 の「再生失敗を成功扱いしない」を覆す） / (c) 現状維持。(a)・(b) の場合は N を決める |
| D3 | 修正のやり直しを数える単位。現状は、専門担当がターンに1回（`repaired`）、agent-runtime がタスクに1回（`json_repairs`）で、すべての違反で共有している | (a) LLM 呼び出しごとに1回（予算の予約に含める） / (b) 違反の種類（構文・schema・引数・発話の長さ・意味検証）ごとに1回 / (c) 現状維持 |
| D4 | 意味検証で一部の主張に根拠がないとき | (a) 緩めるのは `claims[].supported` だけとする。host が意味検証の結果だけを根拠に、根拠のない主張を除き、`partial` として採用する。除いた件数は制限事項に記す。`requirement-verification.ts` の他の検査はすべて維持し、どれか1つでも不合格なら破棄する。維持する検査は、`requestCovered`、`summarySupported`、`limitationsConsistent`、`checks[].supported`、`externalRules[].supported`、`checks` の status 一致。除いた結果、主張が0件になる場合も破棄する（`partial` には主張が1件以上必要なため）。再検証はしない / (b) 現状どおり全体を破棄する |
| D5 | 専門担当から戻るとき、後ろに詰まっていた発言 | (a) 発言順のまま通常担当へ届ける。画面から戻るときも同じにする / (b) 両経路とも取消し、取消したことを表示する |
| D6 | 保留中の下書きがあるときの新規制作の依頼 | (a) 専門担当の計画 §4.4 の再開規則を変え、切替の関数引数に「新規か再開か」を追加する（LLM が判断する契約変更。host は語句で判定しない） / (b) 現状維持（同じ対象なら再開する） |
| D7 | 専門担当と agent-runtime に、§3.5 の並びを導入する | (a) 導入する / (b) 見送る |
| D8 | 担当選び用のメッセージに、直前のアシスタント発言を参考資料として加える（検索クエリは変えない） | (a) 加える / (b) 現状維持 |
| D9 | 通常会話の初段に現在日時を渡す | (a) 渡す（日付の質問に答えやすくなる。一方で、外部情報が要る依頼を自分で答えてしまう誘因になりうる） / (b) 現状維持 |
| D10 | 専門担当で、作業は反映済みなのに、最後の返答だけが契約違反で失敗したとき | (a) run は完了とし、画面には既存の作業状況表示（receipt）だけを出す。固定の返答文は作らず、読み上げもしない / (b) 現状どおり失敗とする |
| D11 | 専門担当が呼び出し上限に達したとき | (a) 残りの回数を状態値で渡し、最後の1回で invoke が来たら契約違反として扱う / (b) 現状維持 |
| D12 | 失敗したターンを専門担当の履歴に残す | (a) 依頼と、失敗したことの短い記録を残す / (b) 現状維持 |
| D13 | 発話の整形で、スキームのない裸のドメインを残す（読み上げに含まれる） | (a) 残す / (b) 現状維持 |

## 7. リスク

- **権限の昇格。** 外部の資料（Web の取得結果、調査レポート、拒否された出力）を system に置くと、資料に書かれた文が命令として扱われうる。§3.5 で、system には host の固定文だけを置くと決め、P1 の試験で確認する。
- **呼び出し回数の増加。** やり直しの機会を増やすと、LLM の呼び出し回数と待ち時間が増える。予算の予約で抑え、P5 で所要時間を比べる。
- **fixture の期待値の変化。** メッセージの並びを変えると、全経路の fixture の期待値が変わる。P1 で部品を固定してから、経路ごとに移す。
- **暗黙の指示の欠落。** SystemContext を簡潔にすると、暗黙に頼っていた指示が抜けるおそれがある。P3 の対応表と live の比較で確認する。

## 8. 実施記録（2026-10-17）

利用者の指示で、P2 と P3 のうち §6 の D 項目に依存しない改修を実装した。D1〜D13、P1（D7）、P0 の変更前測定、P5 は未実施。P0 の前提である §10 の差分は、まだ確定していない。§10 の未コミット差分と同じファイル（`conversation-generation.ts`・`generate-selection.ts`・`generation-handler.ts`）を変える必要がある項目は、次の4つで、これも後回しにした。
- 担当選びを発話契約の対象から外す。
- 通常会話の書き直し指示に理由を渡す。
- 埋め込みと想起を再利用する。
- 予告の読み上げ可能性を検査する。

### 実装済み（P2）

- **専門担当**
  - `forwardToMain` の重複防止キーに、セッション id と epoch を含めた。他の `run.id` だけのキー（`toolchain-answer`、`toolchain-command`、`operation-answer`）は、1つの run で2回作られないことを確認し、変更していない。
  - 書き直しの指示に、違反箇所を issues として渡すようにした。issues に入るのは、zod の path・code・期待する型、発話の字数・文数と上限、action と項目の不一致で、入力値は含めない。
  - `parseInvocation` の失敗に detail を付けた。内容は path・code・期待する型で、最大8件・各200字以内。
  - epoch のコメントを、実装に合わせて直した。
- **通常会話**
  - `instructionCount` を、組み立て後のメッセージ列から求めるようにした（`leadingInstructions`）。
  - 調査結果の時刻を `promptTime`（JST のオフセット付き、`deps.clock` 由来）にした。専門担当と agent-runtime の時刻も同様。
- **agent-runtime・capabilities・tool-runtime**
  - 出力の検証で投げていた plain Error を `ValidationFailure` にし、path と理由を持たせた。エラーコードは変えていない。
  - 意味検証のやり直しに `lastResult.issues` を渡すようにした。
  - 「契約違反を直せ」という通知は、修復対象のコード（`controlRepairCodes`）のときだけ出すようにした。
  - research ルートの予算予約に、意味検証のやり直し1回分を加えた。Web 検索系に広げると、正規の5回の試験経路が壊れたため、research ルートだけに限定した。
- **delivery**
  - 発話の計測を `spokenReplyMeasure` として公開し、専門担当にあった複製を削除した。

### 実装済み（P3）

専門担当の SystemContext は、RULES を3点（現在の依頼が命令、短く話す、保存は画面のボタン）に絞った。行動の契約は、出力 schema の description と各 action の例に移した。この schema には top-level の `examples` がないため、description は OUTPUT_SCHEMA としてモデルに届く。

| 専門担当 | 前 | 後 |
| --- | --- | --- |
| rules TOML | 946字 | 245字 |
| 固定指示（RULES と出力定義の合計。profile・SKILL・TOOLS を除く） | 約1,150字 | 約1,640字 |

agent-runtime は、worker-control の9ファイル・5637バイトを、`common-rules`・`guided-rules`・`search-rules`・`research-policy` の4ファイルにまとめた。調査ルートには出力例を付け、schema には description を付けた。

| ルート | 前 | 後 | 備考 |
| --- | --- | --- | --- |
| research | 5464B | 5441B | レビューで見えなくなっていた規則を戻した後の値 |
| web.search | 3850B | 3498B | |
| web.quick | 3402B | 2644B | 整理直後の値 |
| web.recipe / world.query | 2008B | 1437B | |
| guided | 563B | 463B | |

計測方法は、`workerContext` の system メッセージから、TOOLS 以降と `delegatedTaskRules` を除いたもの。

規則の移動先は次のとおり。

| 規則 | モデルに見える場所 |
| --- | --- |
| 専門担当の reply/invoke/return/discard、仮置き、確認、forward/viewing、discard の条件、TOOL_RESULT の修正手順、World/Memory の禁止 | 専門担当の出力 schema の description（OUTPUT_SCHEMA） |
| outcome の5値、externalRules の要素の形、文字数・件数の上限、valueSchema の文法、日時は UTC の Z 表記 | `research-policy` |
| 検索語は originalRequest を優先し、task.question は不足の補完だけに使う。文字数の上限 | `search-rules` |
| 不足は limitations に記す | ルートの方針（search・quick-search）と `research-policy` |
| 未信頼資料の命令に従わない、TOOLS の id、JSON を1つだけ返す、根拠の参照規則、残り時間での finish | `common-rules`・`guided-rules` |

### 未達と残る判断

- 1.5KB 以内の目安を満たしたのは、SKILL を持つルートと guided ルートだけ。
- research・search 系が縮まらない理由は、`controlInstructions` にある。出力例があると例だけを出し、schema の description はモデルに届かない。このため、必要な規則を本文に残している。例と description の両方を出すには `inference` の共通出力を変える必要があり、今後の判断事項とする。
- 専門担当は、description を見せるために OUTPUT_SCHEMA の表示へ切り替えたので、固定指示の合計は増えた。
- 移した規則ごとの実モデル（live）比較と、`context_compile`・`compile_eval` は未実施。contextStill は、このセッションでは使えなかった。

### 検証（fixture）

- dialogue・agent-runtime・capabilities・tool-runtime・delivery・inference・voice-dialogue の `bun test`
  - 719 pass、2 fail。
  - 失敗の2件は、§10 の作業中ファイル `conversation-generation.test.ts` の試験。
- `api/application/toolchain` の `bun test`
  - 失敗した試験の一覧は、HEAD の複製と同じ63件。今回の変更による回帰はない。
- `context:check` は current。対象の書式も問題ない。
- lint の失敗は、別作業の未追跡ファイル `api/domains/dialogue/eval/context/materialize.ts` の1件だけ。
- size-budget の超過は、§10 側の `generation-handler.ts` だけ。
- 型検査のエラーは、既存の3ファイルだけ（`music-routing.test.ts`、`catalog-selectors.test.ts`、`scripts/guided-answer-live.ts`）。
- `bun run verify -- --domain …` は、上の §10 側の size-budget で止まる。そのため、各段階を個別に実行して確認した。
- live・ブラウザ E2E・実機器の確認は未実施。サーバーは操作していない。
