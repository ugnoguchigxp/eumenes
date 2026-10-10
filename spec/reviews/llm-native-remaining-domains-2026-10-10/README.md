# 残存domainのLLM-Native監査

2026-10-10の実装前監査。監査時は製品コードを変更せず、当時のworking treeを読み、到達経路と再現結果から判定した。その後G01・W01を実装したため、現在の状態は[実装計画](../../llm-native-remaining-domains-implementation-plan-2026-10-10.md)と[検証記録](../../verification/llm-native-remaining-domains-2026-10-10/README.md)を参照する。以下のprobeとsnapshotは修正前の証拠であり、修正後の成功試験ではない。

## 結論

今回確認したEumenesの接続済み経路には、発話の語句・辞書・正規表現でLLMの意味判断を代替する処理を確認できなかった。ただし、未接続のGoals提案APIには文面正規化による同一視が残る。Memory配布パッケージの未接続の自動抽出経路には、括弧を引用とみなしてモデルのmodalityを覆す処理がある。

Worldでは別種の問題を再現した。候補が`held`でも入力イベントを`applied`にするため、後から対象情報を供給しても再評価できない。これは発話辞書の違反ではなく、モデル判断を保留した後の状態管理の不整合である。撤去項目と混ぜず、関連修正として計画に分けた。

| ID | 優先度・到達性 | 判定 | 措置 |
| --- | --- | --- | --- |
| G01 | P3・公開APIは存在、製品の提案writer呼出しは未接続 | 文面のNFKC・小文字化・空白圧縮で異なる操作を同じ提案にする | 内容同一視を削除し、既存operationKeyの完全一致による再送処理を使う |
| W01 | P2・World ON時の抽出経路 | held入力が適用済みになり再評価不能。LLM-Nativeの語句判定違反ではない | 未解決windowを未適用に保ち、同じ抽出情報での連続再実行を抑止する |
| M01 | P3・配布物には存在、現行Eumenesは呼ばない | 括弧の構文で引用という意味を推定し、assertedを覆す | 自動抽出を接続する前に依存側で撤去。今回Eumenesに迂回処理を追加しない |

P2は有効化された処理のデータ喪失、P3は現在未接続の問題として付けた。製品全体の品質点・将来性点や「全域監査済み」という評価は付けない。

## 正本と範囲

- 基点HEADは`30f9524905f8fdf281a53b7c207c467d27e2f1e5`。未commit差分を含むworking treeを正本とした。HEADだけの監査ではない。
- [snapshot-manifest.json](snapshot-manifest.json)は517ファイルのSHA-256を記録する。これは版の照合用であり、517ファイルすべての精読を意味しない。
- [snapshot-recheck.json](snapshot-recheck.json)で監査中の並行変更を検出した。toolchain、dialogueのserviceとdelegate、inferenceのexecuteの現行差分を再読した。G01・W01・M01の根拠ファイルに変更はなかった。
- 前回の[監査](../llm-native-design-2026-10-10/README.md)と[計画](../../llm-native-implementation-plan-2026-10-10.md)を境界資料として参照した。削除済みの天気・株価専用分岐や定型応答は復活させない。並行中のLuna・要件検証の実装を本監査の成果と扱わない。
- SAAA、hono-standard、隣接リポジトリの製品DB・設定・秘密をコピーしていない。他のCodexチャットへ送信していない。

| 対象 | 実際に確認した層 | 到達性と結果 |
| --- | --- | --- |
| memory | service/controller、Conversation/Continuity adapter、dialogue注入・採用、依存側assertUserState・View・admission・semantic-key・extraction | 明示登録とView利用が接続済み。自動抽出とdictionary resolverは未接続 |
| world | lifecycle/feed/forget、抽出prepare/execute/settle/intake/events、query/runtime/gap、application assembly、配布側検証・identity・condition・reasoning・settle | ONだけ自動抽出。serverはentities portを供給しない。query/runtime等の公開部品の存在をserver接続と混同しない |
| coding | service・契約・controller・receipt/observation、application coding/tasks/observation、runner MCP/decoder/worker/observation/workspace・Git操作 | 接続は設定とprobe次第。現行runnerはproduction isolation未対応で実行を拒否 |
| coding-supervision | prompt・decision・context・policy・apply・approval・holds・diagnostics・report、application workflow | モデルへの入力と実行権限を分離。serverで渡すworkflowはavailable:false |
| continuity | 明示登録・訂正・履歴・上限とMemory adapter | typed操作を実行。発話からの自動分類なし |
| goals | service・契約・repository・operation idempotency・試験、World goal snapshot利用 | 読み取りと提案writerを分離して追跡。G01は後者のみ |
| tasks | core/lifecycle/progress/grants/maintenance、契約・queries・repository代表箇所、application委任 | typed commands、grant、generation、revisionの制約。自然言語の専用routerなし |
| task-reports | service・契約・repository・利用側report生成 | 状態・本文・操作IDの整合検査。定型の技術状態報告は発話意味判断の代替ではない |

repositoryの全SQL、runnerの全OS境界、全Web/CLI画面、他のdomainの全経路は網羅していない。agent-runtime、capabilities、web-research等の並行変更は接続確認の範囲であり、ここで独立した深掘り監査を完了したとはしない。

## G01：文面で別操作を同一提案にする

根拠は[goals/service/index.ts](../../../api/domains/goals/service/index.ts)の`normalized`（192行付近）と`create`内のproposed分岐（255行付近）。sourceのnamespace/kind/idと正規化したdesiredStateだけで既存提案を返す。priority、source revision/digest、別のoperationKeyを無視する。既存の完全一致のoperation replay判定はこの分岐の前に存在する。

[probe.ts](probe.ts)では、同一sourceに`保管コードはUS`・priority=10・key=aと、`保管コードはus`・priority=90・key=bを送った。IDが一致し、後者の返値は前者の文面とpriority=10のまま、保存提案数は1になった。大文字小文字が同じ意味かどうかはコードには判断できない。

反証確認：既存試験の「同一sourceから再提案してslotを埋めない」という目的は妥当だが、すでにoperationKeyの再送契約がある。文面の同一視を残す理由にはならない。製品側の非test呼出しを検索するとpropose/proposeInTransactionはGoals内部だけで、現在のserverに自動提案writerは組み立てられていない。稼働中のユーザー提案が失われているとは主張しない。

## W01：heldを処理完了として消費する

根拠は[extraction-settle.ts](../../../api/domains/world/service/extraction-settle.ts)のacceptedIndexes選択（195行付近）、全イベントへの`disposition: applied`（231行付近）、`report(adopted)`（250行付近）。[repository/extraction.ts](../../../api/domains/world/repository/extraction.ts)はstate=receivedだけを次回抽出に選ぶ。

実際のWorld/Memoryパッケージ、隔離DB、fixture推論・queueで再現した。登録済みentityはあるが抽出入力のentitiesを空にし、モデル候補のsubjectをaliasにすると`SUBJECT_UNRESOLVED`でheld=1、accepted=0となる。それでもhost/inboxの双方がapplied、claim数は0。後からentities portに対象を供給してもscheduleは`idle/no_input`、モデル呼出しは1回のままだった。

反証確認：不適切な候補を無限に再試行しない目的は妥当。未解決という判定を完了へ変換する必要はない。配布パッケージにはheld settleもあるが、既存の固定operationKeyをheldとappliedに再利用すると別payloadの衝突になる。最小修正案は、held時にはpackageへのsettle自体を発行せず、windowを未適用で保つ方式とする。

[server.ts](../../../api/application/server.ts)のWorld ON assemblyはqueue/inference/foregroundを渡すがentitiesを渡さない。[extraction-prepare.ts](../../../api/domains/world/service/extraction-prepare.ts)は既定で空配列を使う。したがって製品ON時にも対象未解決の経路は到達可能。ただし実モデルでの発生頻度・抽出品質は測定していない。今回の修正だけで自動抽出の実用完成を宣言しない。

## M01：未接続の括弧判定

採用配布物は`eumenes-memory@0.3.6`、`vendor/eumenes-memory/eumenes-memory-0.3.6.tgz`。実際の依存ソースの[admission.ts](../../../node_modules/eumenes-memory/src/domains/state/service/admission.ts)（218行付近）が`isQuotedSpan`を呼び、assertedでも括弧内ならMODALITY_QUOTEDとする。[evidence.ts](../../../node_modules/eumenes-memory/src/domains/state/service/evidence.ts)（163・186行付近）は括弧一覧と開閉・ASCII引用符の数を使う。

同一のasserted/current/self候補で、原文`私は羅針盤が好きです。`はadmitted、`私は『羅針盤』が好きです。`はpending_userになった。書名を括弧で書いても他人からの引用にはならない。byte rangeと原文一致を確認する処理とは異なり、modalityの意味判断を代替している。

反証確認：現行Eumenesの[rememberInTransaction](../../../api/domains/memory/service/index.ts)（333行付近）は明示登録から公開`assertUserState`を呼び、origin=user_confirmedで保存する。その公開操作の依存側経路はparse/evidence検査/reducerでありevaluateAdmissionを呼ばない。自動抽出prepare/settle、canonicalSemanticKeyの製品呼出しもなかった。現行のMemory会話接続を止める理由ではない。

隣接`eumenes_memory`の該当ソースとの一致を読み取りで確認した。依存側の修正・新配布・consumer試験が必要であり、Eumenes内から依存の内部関数へ製品importして迂回する案は採らない。probe内の内部importはalias照合の監査専用で、製品の接続経路ではない。

## 削除対象にしない処理

| 候補 | 判断の根拠 |
| --- | --- |
| Memoryのsemantic-key辞書 | 呼出し元が宣言したkey/aliasの完全一致検索。未知の言い換えを勝手に既存keyへ統合しない。現行Eumenesは使用しない。発話からkindや意図を分類する辞書と区別する |
| MemoryのNOT表示、kindラベル、空白整形 | 保存済みpolarity・typed kindの表示。発話の否定語検出ではない |
| Memory明示登録のquote index/UTF-8 range | 原文と根拠の完全一致・所有・role・scopeの検証。取り込み権限をLLMの推測に委ねない |
| Worldのalias resolver | modelが選んだsubjectを、同一scopeの登録entityへ照合。未知/曖昧をheldにする。対象別の発話routerではない |
| Worldのmodality/condition/relation検査 | typed契約の検査。negatedを肯定payloadとして保存しない制約を削除しない。asserted+boolean:falseは別の有効表現。否定の意味変換品質はlive未測定 |
| Worldの数値・単位・時刻・三値conditionとgraph演算 | typed条件の実行。自然言語の解釈はcandidateを作るモデル側にある |
| codingのevent正規化とエラー分類 | CLI JSONイベント、version、terminal、ANSI、byte上限等の外部プロトコル処理。発話の単語で成功を判定しない |
| runnerのfinal/commentary/unknown | 信頼できるevent metadataを使う。phaseがないadapterはunknownのまま。最後のmessageを最終成功とみなさない |
| supervisionのallowed actions・check/review/commit/push・budget | host側の許可と必須実行制約。モデルの「完了した」という文言で権限やcheckを解除しない |
| continuity/tasks/task-reportsのenum・上限・操作key regex | 明示されたtyped commandと状態契約の検証。自由文から用途を推定する分岐ではない |

supervisionのpromptは依頼・完了条件・観測・receiptをデータとしてモデルへ渡す。decisionは既存inference controlを使用し、採用前にtask/observation/fenceを再確認する。今回この経路への別plannerや辞書追加は必要ない。

## 残る確認事項

| ID | 不確実性 | 必要な証拠・対応 |
| --- | --- | --- |
| U01 | World promptはcondition/validTimeを許すが、その完全な外部schemaを入力で説明していない。否定、条件、未知predicateの実モデル品質は不明 | 実際の固定配布契約とモデル入力を照合したlive corpus。失敗が確認された場合はSYSTEM_PROMPT/契約情報を改善。発話別TS分岐を追加しない |
| U02 | coding production isolationとsupervisionの実check/review/Git workflowが未提供 | 対応adapterの外部仕様と実環境受入。fixtureの成功をproduction対応と読み替えない |
| U03 | World serverにentity snapshot portがない | パッケージの公開read契約と採用版のconsumer試験を整えた別接続計画。内部SQL直読みや自動entity作成で埋めない |

U01〜U03は未検証事項であり、語句判定違反として数えない。

## 実施した検証

| 区分 | 結果 | 記録 |
| --- | --- | --- |
| 既存fixture | 8 domain・runner・application関連34ファイル、356 pass / 0 fail | [fixture-results.txt](fixture-results.txt) |
| dialogue fixture | Memory/World接続の2ファイル、64 pass / 0 fail | [dialogue-fixture-results.txt](dialogue-fixture-results.txt) |
| 監査用再現 | G01/W01/M01、alias exact lookupの反証確認。全assertion成功 | [probe.ts](probe.ts)、[probe-result.json](probe-result.json) |
| live | 未実施。実モデル品質とproduction coding動作は未検証 | fixtureから外挿しない |
| 実機器 | 未実施 | 音声MVP完成の判断をしない |

再現コマンドは`bun spec/reviews/llm-native-remaining-domains-2026-10-10/probe.ts`。本文は合成例、DBは一時領域で作成・破棄する。期待値は修正前の不具合を示す監査用であり、修正後の検証にはdomainの回帰試験を使う。実装前の本監査ではverify:allを実装検証として実行していない。後続実装の結果は上記検証記録へ分離した。

context_compileは代表実装・既存指示を読んだ後に1回使用し、記憶の接続範囲・Worldの保留と採用・coding observationの境界を確認する手掛かりにした。最終判断は現行ソースと上記再現に基づく。compile_evalも1回返却済み（outcome=useful、runId=`00000000-0000-0000-18dd-228c88e5ac98`）。
