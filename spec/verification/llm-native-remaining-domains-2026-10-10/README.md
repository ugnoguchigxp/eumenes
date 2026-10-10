# Goals・WorldのLLM-Native修正 実施記録

2026-10-10。[実装計画](../../llm-native-remaining-domains-implementation-plan-2026-10-10.md)のG01・W01を実装した。Memoryは接続前条件の文書化に留めた。製品DBや設定の変更、依存パッケージの更新、他チャットへの送信は行っていない。

## 実装結果

- Goals：proposedのNFKC・小文字化・空白圧縮による内容同一視を削除。同一operationKeyの再送処理、異なるpayloadのconflict、scope・revision・epoch・提案上限を維持した。keyなし/別keyは独立した操作になる。既存の入力schemaによるtrim・長さ制約は維持する。
- World：heldを含むwindow全体をreceivedのまま保持する。accepted候補もこのwindowでは保存せず、package settleとapplied cursorを発行しない。hostのcontext digestで同じ情報の再呼出しを抑止し、情報が変われば既存queueから再評価する。原文の失効・forgetは抑止より優先する。
- Worldの採用：JSON snapshotをportの可変オブジェクトから切り離し、settleで現行contextと照合する。既存inferenceの読取り専用権限検証を利用し、最終適用時だけacceptする。held時のrequest・manifest解放、解放拒否時のrelease_pending/sweepは既存機構を使う。
- Memory：依存側の括弧意味判定撤去、新版配布の証拠、consumer試験、source/forget/restore/cancel競合の受入を接続前条件として記録。Memory製品コード・tgz・lockfileを本作業では変更していない。

変更対象はGoals・Worldとapplicationの結合試験、および関連文書。[baseline.json](baseline.json)に作業開始時の対象hashと既存変更一覧を保存した。reset/restoreや既存差分の置換は行わず、必要箇所だけを編集した。全域format検査のため、既存の`spec/verification/llm-native-2026-10-10/`の`live-saved-settings/results.json`・`live-final/results.json`を含む生成JSONの字下げも整えた。前後のJSON値が一致することを検証している。

## Fixture

| 検証 | 結果・記録 |
| --- | --- |
| 修正前回帰 | Goals内容同一視とWorld held消失の2件が意図どおり失敗。[regression-before.txt](regression-before.txt) |
| Goals/World回帰 | [regression-after.txt](regression-after.txt)。追加後の最終ケースはdomain/all検証で実行 |
| 保留・移行・実queue/inference | 20 pass / 0 fail。[held-results.txt](held-results.txt)。stub Local providerを使用し、実モデルではない |
| application/runner維持 | 79 pass / 0 fail。[application-runner-results.txt](application-runner-results.txt)。heldの実queue結合ケースは後から追加し上段で検証 |
| 10 domain | [domain-results.json](domain-results.json)とverify-*.txt/JSON。Goals、Memory、dialogue、continuity、tasks、task-reports、coding-supervision、inferenceはverify成功。Worldは再実行で成功。codingは試験62件成功だが検証中のsource変更で最終判定が失効し、下段の全域成功で現在版を検証した |
| 全域・最終 | **verify:all成功**。29 domain・全13工程がpass、430891 ms。backend 1231 pass / 1 skip、Web 253・client 329・design-system 1086 pass、browser 42 pass / 1 skip。[出力](verify-all-current.txt)、[判定JSON](verify-all-report.json)。実行前後のsource hash一致を確認 |

初回全域試験の3失敗は、開発serverの旧status期待値2件と、取消を無視するProviderを再現するfixtureの権限検証port未接続1件。前者は並行変更の修正をそのまま採用して再検証し、こちらで製品挙動を変えていない。後者は新しいportメソッドを接続し、`satisfies ExtractionInference`で型も検査するようにした。[full-failures-recheck.txt](full-failures-recheck.txt)で11 pass / 0 failを確認。source変更による失効や生成JSONのformat失敗も実行記録に残し、成功と読み替えていない。

[verify-all-final.txt](verify-all-final.txt)も全13工程の試験は成功したが、並行変更が入ったためsource hash一致の最終判定は失効した。[失効の判定JSON](verify-all-freshness-failed-report.json)。再実行時の検証ロック拒否は[verify-all-stable.txt](verify-all-stable.txt)へ記録し、並行側の検証終了後に上段の現在版検証を開始した。最終実行中はソース変更がないことを追加照合した。成功後に判定JSONをこの記録へ保存・整形したため、この証拠ファイル追加後の全域hashは判定JSONのrevisionと異なるが、製品コード・試験には変更していない。

backendのskipは実Local LLMを要するopt-in試験、browserのskipはAudioWorkletのfake microphone試験である。skipをlive・実機器の成功に含めない。format、lint、型検査、SQL境界、サイズ制約、domain文書検査、Webビルドも全域成功に含む。

Worldの試験は、再poll/restartの呼出し抑止、情報更新後の一度だけの適用、accepted+held混在とprefix、可変portのsnapshot分離、prepare再確認、source失効、forget、restore、解放拒否/sweep、writer rollback、解釈version更新、取消旧結果の拒否、権限不成立時の保留拒否を確認する。実queue/inferenceの結合では、held requestがrejected・attempt accepted=0で残り、更新後だけclaimが保存され、Cloud呼出しがないことを観測した。

Goalsの試験は、別操作の大小文字・Unicode幅・内部空白・priority/source版の保持、同key再送、同key別payloadのconflict、keyなし重複操作、50件上限、満杯での同key再送、既存権限・状態遷移を確認する。

## 移行・互換性

`world/0008-extraction-hold`はhostテーブルにnullableな64桁digest列だけをappendする。旧received/terminal行の状態と時刻が変わらず、不正digestが拒否されることを隔離DBで確認した。既存appliedの再開・履歴の再抽出・失われたGoalの推測復元は行わない。

旧binaryは未知の適用済みmigrationを拒否するため、そのままのdowngradeは不可。これは現行SQLite実装と回帰試験に基づき計画を修正した点である。migration台帳や列を削除して回避しない。製品DBへの適用とbackup復元は本作業で実施していない。

## Live・実機器と制限

live・実機器は未実施。現行serverはentities snapshot portを供給せず、実モデルの抽出品質も未測定である。保留した先頭windowは情報が変わるまで後続の適用を止める。修正は入力の保持・再評価・採用境界までで、自動World抽出の実用完成を示さない。fixtureのcallback差替えをproduction接続と読み替えない。音声MVPの実機器3往復受入も未達のままとする。

最終差分では発話や対象名を解釈するregex・辞書・固定応答を追加していない。新規の条件はtyped verdict、source版、操作ID、実行所有、抽出情報のdigest、権限と状態の検証に限られる。
