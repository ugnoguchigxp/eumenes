# 日常の複数操作エージェント 計画書レビュー

実施日: 2026-10-21 JST

対象: [実装計画書](../../everyday-task-agent-implementation-plan-2026-10-21.md)。依頼は文書レビューと改善であり、製品実装ではない。文書と索引だけを編集した。既存の製品差分、他の設計案、稼働サーバー、設定は変更していない。

## レビュー方法と終了条件

既存の公開契約・実装・設計を読み、初回委譲、能力探索、子起動、結果返却、会話での継続、失効と復旧を机上で追った。表現の好みではなく、接続不能、意味判断の二重化、状態の矛盾、検証できない完了条件を修正対象にした。

終了条件は、確認した欠陥を本文・工程・受入ケースへ反映し、再読で具体的な未修正指摘がなく、ローカル参照・文書構造・索引・差分の確認が通ること。未実装の契約を「既存」と扱わず、実装時に確定すべき数値はP0の必須成果物へ分離した。

## 確認した欠陥と修正

| ID | 問題と根拠 | 計画書への修正・確認先 |
| --- | --- | --- |
| D01 | [analysisTools](../../../api/domains/dialogue/service/initial-decision.ts) の非instant関数は分類と予告だけを受け、子へ渡す依頼を受け取れない | §4〜5にR1のtask分岐と親用の子依頼schemaを定義。instantは登録schemaをargumentsに保持し、制御引数と衝突させない |
| D02 | [ExecutionResultV1](../../../api/domains/tool-runtime/contracts/adapters.ts) はneeds_inputを持ち、artifactRevisionIdを必須にする。終了専用・Artifactなしの型として再利用できない | §6で非同期の状態と最終結果を分離。親にダミーArtifactを作らず、既存UI契約を変更しない |
| D03 | [固定TaskState](../../../api/domains/inference/contracts/agent-task.ts) は固定JSONとappendする履歴を前提とする | §5に親用のversion付き状態と動的native関数の検証を定義。共通検査を再利用し、未使用候補と長文結果を全履歴へ蓄積しない |
| D04 | 委譲入口はあっても質問回答・進捗確認・訂正・取消を会話LLMが選ぶ入口がない | §4.3のtask_controlと作業projectionを追加。依頼版と進捗revisionを混同しない。終了後の依頼は新規実行と結果refへ接続 |
| D05 | [readActionOriginInTransaction](../../../api/domains/dialogue/service/action-origin.ts) は会話runが終了すると拒否する | §7で実行所有者を推論・adapter origin・結果検証まで通す必要を明示。会話originの偽装や既存検査の緩和を禁止 |
| D06 | [start-task](../../../api/domains/agent-runtime/service/start-task.ts) と [task-ops](../../../api/domains/agent-runtime/service/task-ops.ts) はroot run単位で開始・取消・完了配送する | §7に親・論理的な子・domain taskのID、開始キー、配送先、同一キーの競合と再送を定義。別の明示依頼を本文で重複扱いしない |
| D07 | [command interaction](../../../api/domains/dialogue/contracts/command-interactions.ts) は会話runの再開を返し、汎用の親実行状態機械ではない | §7で質問の表示/検査を再利用し、保存と再開は所有domainへ配送。既存commandと新しい作業の応答型を区別 |
| D08 | [browser tasks](../../../api/domains/browser/service/tasks.ts) のneeds_inputはtaskの終了で、[承認移送](../../../api/domains/browser/service/approvals.ts) は別taskへ行う | §9で一つの論理的な子呼出しに再開先を結ぶ。期限と総予算を維持し、終了したcoreや既実行の書込みを再送しない |
| D09 | [browser adapter](../../../api/application/browser/browser-adapter.ts) は原文が長い場合にbriefへ置き換える | §6でhostが束縛した元発言ref/版とbriefを分離。引用の検証元を引継ぎ文へ変えず、長文・短い同意の試験を追加 |
| D10 | [ContextAssembly](../../../api/domains/dialogue/service/context-assembly.ts) と [PreparedWindow](../../../api/domains/memory/contracts/index.ts) は委譲用の部分読取りAPIではない | §8で所有domainの版付き参照projectionを追加する範囲を明示。通常のWindow更新と使用資料の変更/忘却を区別し、独自Memoryを作らない |
| D11 | queued・子待ち・質問待ちには実行中のジョブがなく、Queueのrunning回収だけでは全体を止められない | §7で [期限reconciler](../../../api/domains/agent-runtime/service/reconcile-timer.ts) と [lifecycle](../../../api/domains/agent-runtime/service/lifecycle.ts) の対象拡張を計画。dispatch/結果/通知のクラッシュ窓と永続配送を明示 |
| D12 | 親子合計の推論上限を終了時に数えるだけでは強制できず、外部担当の内部推論も数えられない | §10で予約・一度だけの消費・未使用予約の返却を定義。command翻訳やbrowser再開も計上し、外部実行と会話推論の計測範囲を区別 |
| D13 | 最後の推論、質問待ち、期限切れの返却が未定義。取消後の動画停止を求める受入条件は巻戻し非保証と矛盾する | §7・9・10で期限回収とhostの不足返却、最終関数の制限、承認期限を定義。取消は後続操作の停止とし、既発生状態の変更は別依頼へ分ける |
| D14 | 「R1はMemoryを読まない」を変える影響が委譲時だけに見え、単純依頼の入力増加と性能上限が不明 | §4で通常R1への適用を明示。§11〜12で基準・許容増分・公開gateを必須化し、未報告usageと推定を区別 |
| D15 | 本文の契約追加とP0〜P6・試験が対応していない | §11に開始前の契約表、§12に復旧・再送・参照・容量・長文・継続を追加。新規試験パスを予定として明記 |
| D16 | 別設計のブラウザサービス内検索と親配送・原文参照を二重実装するおそれ | §15で [関連する設計案](../../browser-service-search-design-2026-10-21.md) との共有範囲を明示。他案の全体完成を先行条件にせず、実装済みの共通契約を再利用 |

## 見直しの経過

| ラウンド | 観点 | 得られた結果 |
| --- | --- | --- |
| 1 | 現行の関数・結果・所有者・非同期契約 | D01〜03・05〜07・11の不足を修正。指示の変更だけでは接続できない範囲が具体化 |
| 2 | 継続依頼・質問・参照・親子の予算 | D04・08・10・12を修正。会話と作業の寿命、背景資料の読取り、承認後の再開を接続 |
| 3 | 原文の保存・工程と試験・性能の採用条件 | D09・13〜16を修正。性能基準なしの公開と、取消時に未依頼の巻戻しを期待する不整合を解消 |
| 俯瞰評価 | 3ラウンド時点で作業目的と差分を再確認 | 証拠と修正が増えたため継続。製品実装へ範囲を広げず、次は契約名・工程・受入条件の最終整合を確認する方針へ変更 |
| 最終整合 | 本文・工程・試験の再読 | 関数引数の衝突、依頼版と進捗版、最後の推論で許す関数、検索後の参照読取り、個別IDの許可リストを避ける点を明確化 |

再読では、意味判断をLLMに残し、hostが契約・権限・実行状態だけを強制する構成を確認した。動画やサイト専用の分岐、別の分類エージェント、Pursuit/Harness2の取込を追加していない。

## 文書の検証と残作業

文書検証の対象は本計画・本記録・spec索引。計画11件・記録17件のローカルリンク、節参照、制御名、工程P0〜P6、コード枠・空白、索引の重複は読取り専用の機械検査で成功し、表と契約の対応は再読で確認した。最初の構造検査はコード枠内のシェルコメントを見出しと誤認したため、コード枠を除外する検査へ修正して再確認した。文書の要件や期待値は弱めていない。差分の空白検査も成功した。

最終再読で具体的な未修正指摘は0件。検証した計画本文のSHA-256は `c7644c3125e242b64a9c37b4940f1a27b701a7defe16b53af3c70162fcf2bc28`。製品試験・live・ブラウザE2Eは文書変更だけなので実行しない。この判断は [登録検証手順](../../../docs/toolchain-extension-verification.md) の文書のみの変更に従う。

製品実装と受入はP0〜P6の全段階が残る。予算の数値は暫定案であり、性能の許容値・容量・保持期間の確定はP0の必須成果物である。これらを未確定のまま公開可能とする記述はない。実装の容易さや、実モデル・実ブラウザでの成功を文書レビューだけで保証しない。

Context補助は本レビューで `context_compile` 1回、`compile_eval` 1回。初回計画作成時にも各1回を使用した。`initial_instructions` は会話開始時の実行を再利用した。
