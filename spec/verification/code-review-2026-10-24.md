# 応答遅延・フォーム直接実行・作業報告のコードレビュー

2026-10-24。利用者の依頼により、mainの未commit差分全体をレビューし、再現した問題を修正した。LARM側は対応中のため、実接続での速度・品質・cache保持の受入は行っていない。製品サーバーの停止・起動・再起動も行っていない。

## 修正

- 完了確認のProvider失敗で共有requestがfailedとなり、後続回答までpermission_revokedになる問題を修正。既存の「確認失敗ならunverifiedとして結果を回答する」契約を満たすため、inferenceの共有executorに、answer requestの非表示auxiliary呼出しだけに使える`failureScope: "call"`を追加した。失敗attemptは記録し、本文のdeltaは公開しない。main/controlでは指定を拒否し、取消・期限・snapshot・採用権限は緩めない。公開APIからタイマー実行→完了確認失敗→結果回答まで回帰試験した。
- AgencyをOFFにした後、新しいcommitがないと保留報告を解除しない問題を修正。設定反映・起動・停止時にも監視する。
- idleが無効、または新しいcommitがない場合に30分の保留期限が働かない問題を修正。期限用timerを独立して設けた。解除中に発生したcommitは解除後に再確認し、closeは解除中のwriterも待つ。解除済み報告の監視IDも除く。
- schema変換がconst/default/examples/enum中の固定データまで変更する問題を修正。schemaを値として持つkeywordだけをたどる小さな共通処理をinferenceとLARMで再利用した。keywordと同名のプロパティ名も保つ。
- schemaにpropertiesがあると追加引数を一律禁止していた変換を修正。元のadditionalProperties契約を維持する。Providerが受け付けないschemaを別方式へ自動再送する経路は追加していない。
- 再帰的な`$ref: "#"`、boolean schemaとその参照で省略用nullの復元が誤る問題を修正。nullableな値と許可された追加引数は保ち、既存の所有側validatorに渡す。
- 指定済みフォームの実行には不要な保持候補をprepareしないようにした。無関係な候補revisionの消失でフォームが失敗する経路を除く。memory準備の組立ては同じ内容の補助関数へ移し、createPrepareの既存307行のsize違反も解消した。

goldenの追加更新は8ファイル・16箇所の`calls/*/session/failureScope`だけで、本文・履歴・候補は変更していない。先行する応答遅延実装のgolden変更とは分けて確認した。

## 検証

稼働環境のDesignSystem出力を書き換えないため、一時cloneへ全作業差分をコピーし、固定した入力で検証した。元の作業ツリーとコード・設定・fixture等3,677ファイルの一致を確認。verifyのsource/dist整合性検査にも違反はない。以下の件数には再実行の重複があるため合計しない。

| 検証 | 結果 |
| --- | --- |
| 再現4件を含む部分試験 | 修正前に失敗を確認、修正後70 pass |
| dialogue/inference/larm/memory/delivery/voice-dialogue/agent-runtime/tasks/pipelines/image/musicのverify | Bun 1,426、Web 129、DesignSystem 28、計1,583 pass |
| 最後に追加したschema境界の回帰試験 | inference・dialogue・共通処理60 pass |
| 最後のschema変更後のinference/larm verify | 430 pass |
| Agency・media・toolchain・設定の結合、共通処理、比較runnerのfixture | 326 pass |
| MusicPlayer・MusicWorkspace | 18 pass |
| Artifact UI | 341 pass |
| 全体型検査 | 2,387ファイル、エラーなし |
| 変更ファイルのformat/lint、SystemContext、変更domainの境界・size | pass |
| Web build | pass |
| 同梱Agencyパッケージ | frozen lockfileで導入、manifestと実体のSHA-256一致 |

11domain検証の後に変わった製品コードはschemaの参照解決・省略値復元だけ。その変更は部分試験→inference/larm verify→結合試験の順で確認したため、無関係な11domain全体の再実行は省略した。

記録は`verification-reports/code-review-2026-10-24/`（git対象外）。主なログは`domains-final.log`、`schema-domains-accepted.log`、`application-accepted.log`、`music-ui-accepted.log`、`artifact-ui-accepted.log`、`typecheck-accepted.log`、`web-build.log`。verifyのreport.jsonも同所へ保存する。

## 全体gateと未受入

全体gateは合格としない。既存の違反を調査し、無関係な修正や予算緩和はしていない。

- 全体formatは差分外の33ファイル、lintは差分外のbrowser-task-tools.tsとStepGuide.tsxで失敗する。
- 全体のdomain境界・SQL境界には既存の違反がある。新設したschema処理・report処理による新しい越境はない。既存testのprivate importも残る。
- 全体sizeには既存の超過13件が残る。AgencyHost等は変更前から超過しており、今回の追加もその大きさに影響する。上限変更や、レビュー範囲を超える構造変更は行わない。
- bundle上限: 変更前mainもentry 126,917 B / initial 274,570 Bで失敗。今回は127,000 B / 274,653 Bで、増加は各83 B（gzip）。基準112,035 B / 259,653 Bと許容率は変えていない。

構造化判断・入力配置の候補は通常動作へ採用していない。LARMの保持修正後のlive比較、Providerの後方system互換性、ブラウザE2E、実機器の音声往復は未受入。機能試験の成功を、応答速度改善や音声MVP完成の宣言にしない。

最終差分では、語句による意味分類・固定返答・新たな承認判断・黙ったフォールバックの追加がないことを確認した。今回の機能範囲の再レビューでは、新たな重大・中程度の不具合は見つからなかった。ContextStillは本会話累計compile 4回・eval 6回。
