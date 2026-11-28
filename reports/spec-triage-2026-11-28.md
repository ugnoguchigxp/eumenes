# 未実施計画の採否整理（2026-11-28）

前回の直下115文書を、現行仕様・今後取り組むもの・今後行わない旧案に分けた。判断は今回の整理であり、過去の利用者決定と推奨を混同しない。実装済みと未受入、未合意の設計をそれぞれ保持する。既存の `.archived` は内容の再点検対象にしていない。

| 区分 | 件数 | 扱い |
| --- | ---: | --- |
| 今後取り組むもの | 89 | `.todo/`。既存機能の残件、受入、現行案を区別 |
| やらない旧案 | 21 | `.archived/`。各文書冒頭に対象範囲と理由を明記 |
| 現行仕様・課題一覧 | 5 | 直下に保持し、残件を別途 `.todo/` に記載 |
| 旧委任コーディングの下位資料 | 6 | 旧CLI runner・監督方式を再開しないため履歴に移動 |

`spec/design/` と `spec/assets/` の画面見本・画像・調査レビューは、今回の未実施計画には数えず、各機能の設計を確認するための参照資料として元の場所に保持した。以前から `.archived/` にある文書の採否は今回見直していない。

## やらない旧案

一般的な利用者目的は捨てず、[現行方式で引き継ぐ目的](../spec/.todo/current-continuity-and-safety.md) に残した。以下は個別方式の判断である。

旧Routerの撤去は[会話の性能・負債計画](../spec/.todo/conversation-agent-token-efficiency-and-debt-plan-2026-11-22.md)、旧TODOの廃止は[依頼項目の設計](../spec/.todo/toolchain-assignment-as-research-2026-11-25.md)、Pursuit・Collaborationの方針は[専門担当の設計](../spec/.todo/specialist-evaluator-design-2026-11-13.md)に記録されている。REST全面統一と物体認識の独自学習は、それぞれの未合意・保留状態と現状の必要性を踏まえた**今回の整理判断**であり、過去に利用者が明示的に中止したという意味ではない。

| 文書 | やらない理由 |
| --- | --- |
| [役割とPursuit](../spec/.archived/agent-roles-and-pursuit-integration-design-2026-11-03.md) | 旧Pursuitを中核に据える四役割構成は採らない。後続の専門担当・Evaluator設計にはPursuitとCollaborationの廃案が利用者方針と明記されている。調査機能や出典・取消の要件は後継担当側で扱う。 |
| [ブラウザー共同作業の継続](../spec/.archived/browser-collaboration-continuation-design-2026-11-12.md) | 汎用Collaboration担当へタブを引き継ぐ旧経路は再導入しない。該当bundleはdormantで、後継への移行方針が記録されている。同じタブの継続操作・読み上げは現行の担当で別途検証する。 |
| [共同作業の評価](../spec/.archived/collaboration-evaluator-design-2026-11-12.md) | 旧Collaboration専用のPipeline Quick評価は再開しない。本文が現行方針をSKILLを使う評価担当設計に引き継いでいる。根拠付き評価の機能は後継側で扱う。 |
| [共同作業の後続設計](../spec/.archived/collaboration-followup-design-2026-11-05.md) | 旧Pipeline制作adapterや汎用Collaborationを復活させる接続は行わない。本文自体が旧制作画面の撤去と新方式への移行を明記している。共同編集の必要性は現行のMarkdown・専門担当の計画で扱う。 |
| [LARM Router依頼文](../spec/.archived/larm-router-request-prompt-2026-11-01.md) | 会話の前に独立Routerを置くLARM向け依頼は送信・再開しない。2026-11-21に通常会話の自動Routerを撤去し会話主導の担当選択へ変更した記録がある。 |
| [担当Router再設計](../spec/.archived/toolchain-router-redesign-2026-11-01.md) | Ruriと専用Routerで会話・担当を前段一括分類する旧R0〜R5は再開しない。後続の会話主導選択へ置換済み。検索の品質と取消は現行経路で扱う。 |
| [Routerパッケージ統合](../spec/.archived/router-package-integration-2026-11-04.md) | 通常会話の前段に旧eumenes_routerを復活させる統合は行わない。後続文書に自動Router撤去が記録されている。既存の検索や会話履歴は現行経路で維持する。 |
| [取消対象の構造解析](../spec/.archived/router-cancellation-structure-design-2026-11-06.md) | 旧Routerの構造判定と旧TODO参照を前提とする取消方式は再実装しない。TODO廃止後も自然文での安全な取消という要件は現行の依頼項目で検証する。 |
| [調査経路の後続案](../spec/.archived/research-routing-followup-design-2026-11-08.md) | 旧RouterのrouteStructuredを会話前に追加する案は採らない。旧構造probe自体が誤取消・timeoutを示し、後に独立Routerも撤去された。自然文取消と報告品質は現行経路の課題として残す。 |
| [候補1位への誘導](../spec/.archived/local-choice-top-candidate-design-2026-10-31.md) | 旧local専用の候補1位誘導案は再開しない。後続では会話モデルが検索候補から判断する方式へ変更されている。担当選択の品質は現行方式で評価する。 |
| [ローカルハーネス再構築](../spec/.archived/local-harness-rebuild-plan-2026-10-30.md) | Ruri二択と旧local選択ループの再構築・その版を前提にした残測定は再開しない。後続の会話主導方式で経路が置き換わった。性能や実機の確認は現行方式の計画で扱う。 |
| [ローカル文脈の予算](../spec/.archived/local-context-budget-design-2026-10-29.md) | 旧local専用ハーネスを前提に固定5000 tokenへ揃え、memoryを別担当へ移す旧案は実施しない。入力予算や記憶の品質は後続の会話・Memory設計を正本に評価する。 |
| [会話ハーネス](../spec/.archived/conversation-harness-design-2026-10-28.md) | 旧local/cloud分岐と旧localの判断・返答ループを本書どおり再導入しない。後続の会話主導・履歴圧縮設計で対象範囲が更新されている。現行入力仕様は直下に保持する。 |
| [旧改善計画 初版](../spec/.archived/improvement-plan-2026-10-10.md) | 旧版を別の実装計画として再実行しない。本文が未完項目を第2版へ移管済みと明記している。第2版の未解決項目は継続する項目として残す。 |
| [外部アプリ共通契約](../spec/.archived/external-apps-artifacts-implementation-plan-2026-10-09.md) | 2026-10-09の独自の汎用外部アプリ契約をそのまま追加しない。Markdown・Docling・Artifactは後続の所有domainとbundleで別に扱われているため、未達の利用体験は現行の各計画で確認する。 |
| [REST統一標準](../spec/.archived/rest-unified-standard-2026-10-27.md) | 約310 routeを一括で新規規格へ移す全面変更は行わない。合意前の案で、直ちにその規模の契約変更が必要という現行の根拠がない。個別の契約不整合が確認された場合は既存の公開契約を修正する。 |
| [物体認識の独自学習](../spec/.archived/object-recognition-custom-training-concept-2026-10-18.md) | 個人の物品向けモデルの独自追加学習は行わない。文書自身が着手予定なしとし、撮影・ラベル付けの自動化も未成立。必要な物体検出は既存の上流対応・利用者要望を先に評価する。 |
| [日常作業担当](../spec/.archived/everyday-task-agent-implementation-plan-2026-10-21.md) | 品質不合格で無効化された旧日常作業担当をそのまま有効化・再実装しない。最新の複数操作受入が未達であり、現行の担当選択・依頼経路で必要な複合作業を扱う。 |
| [日常作業の進行契約](../spec/.archived/everyday-task-agent-progress-contract-proposal-2026-10-21.md) | 品質未達の旧日常作業担当専用の進行契約をそのまま採用しない。重複実行を防ぎ結果を確認する要件は現行の依頼項目・取消経路で扱う。 |
| [記憶想起の実装](../spec/.archived/memory-recall-implementation-2026-11-23.md) | 取消済みのRecall区画・類似記録・旧冪等鍵をこの実装手順で復活させない。利用者が後続の直接curation方式に変更済み。残る記憶の取扱いは現行設計で確認する。 |
| [記憶想起の改善案](../spec/.archived/memory-recall-improvement-2026-11-23.md) | 取消済みのRecall区画・類似記録を前提とする旧改善案をそのまま再実施しない。後続の直接curationが優先し、本人の記録の取得・訂正・忘却の品質は現行方式で扱う。 |

## 今後取り組むもの

個別の残件と実施状況は [一覧](../spec/.todo/README.md) を正本とする。記載は今後取り組む内容で、未合意案の実装承認や、外部への送信・サーバー操作の許可ではない。

## 直下に残す現行資料

| 文書 | 未完・留保 |
| --- | --- |
| [ContextWindow構成](../spec/context-window-layout-spec-2026-10-25.md) | 一部実施・現行参照。fixture済み、liveは一部のみ、実機器未実施。agencyの台帳番号を受け取る改修は未着手と記載。 |
| [ContextWindow仕様](../spec/context-window-spec-2026-10-24.md) | 現行仕様・一部未実施。索引には未実装の検査等が列挙され、後続設計の置換範囲もある。 |
| [会話入力仕様](../spec/conversation-input-spec-2026-10-26.md) | 一部実施・現行参照。fixture済みだがP0のlive測定・評価再実行は未実施と記載。入力順や圧縮は後続設計で変更されている。 |
| [全体課題](../spec/project-issues-2026-11-06.md) | 継続管理の一覧。複数の未完課題を含む。 |
| [Spatialモデル目録](../spec/spatial-model-catalog-2026-10-18.md) | 一部合意。アニメーションの周期・位相は未制作・未実装。 |

## 旧委任コーディング計画

利用者が2026-10-31に直接Codex CLI runnerと旧coding-supervisionを中止したことから、その方式を前提とする下位資料6件はやらないものとして移動した。現在のSDK方式や、利用者が望む結果共有・作業状況・安全な再開は上記の継続項目に残す。

| 文書 |
| --- |
| [README.md](../spec/.archived/delegated-coding-implementation-2026-10-09/README.md) |
| [04-conversation-and-reports.md](../spec/.archived/delegated-coding-implementation-2026-10-09/04-conversation-and-reports.md) |
| [05-task-modal.md](../spec/.archived/delegated-coding-implementation-2026-10-09/05-task-modal.md) |
| [06-agent-observation-contract.md](../spec/.archived/delegated-coding-implementation-2026-10-09/06-agent-observation-contract.md) |
| [06-agent-observation-contract-review.md](../spec/.archived/delegated-coding-implementation-2026-10-09/06-agent-observation-contract-review.md) |
| [07-recovery-question.md](../spec/.archived/delegated-coding-implementation-2026-10-09/07-recovery-question.md) |
