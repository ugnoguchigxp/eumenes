# subプロジェクトとの重複・未参照コードの整理

2026-11-03。利用者依頼による削除作業。製品の振る舞いと既存設計を維持する。

## 範囲と完了条件

- routing（router、対話の選択・実行機構、routing exportを含む）・interact・pipelineは対象外。
- agency・memory・world・pursuitの設計と、本体のパッケージ依存・呼出しを照合する。subプロジェクトは参照のみ。
- 本体の未使用export・型と、参照のないサービス操作を削除する。共有実行機構を置き換えたり、LLMの判断・指示・ツールの動きを変えたりしない。
- DB・設定・migration・互換読取りは変更しない。サーバー操作・依存更新・ブランチ作成・他チャットへの送信はしない。
- 削除箇所の全参照と、型からの参照・動的登録を確認する。部分検査、影響domainのverify、最終差分点検までを完了条件とする。
- 着手時の未コミット差分と変更前ソースは `/tmp/eumenes-cleanup-20261103/` に保存。既存変更を維持する。

## 確認した設計と採用方針

`unreferenced-code-cleanup-plan-2026-10-31.md`、`agency-autonomy-integration-2026-11-02.md`、`world-evidence-integration-2026-10-31.md`、`docs/memory.md`、`api/domains/world/README.md`、`docs/verification.md`と、隣接subプロジェクトのREADME・公開APIを確認した。

| 対象 | 観測と扱い |
| --- | --- |
| agency | `createHostRuntime`は配布済み`createAgencyRuntime`を利用。ホストは指示・設定・外部実行・配信・保存の接続を担当し、呼出しがあるため維持 |
| memory | State・忘却・成立期間判定は配布済み公開APIを利用。stewardの判断・ホストの引用位置付け・保存・journal復旧は現役。旧台帳のbackfillも起動時復旧で呼ばれるため維持 |
| world | 意味処理・SQLは配布済み公開APIを利用。旧usage/dependent行の清掃は忘却・release retryで使用中。消さず、呼ばれないホスト操作だけを削除 |
| pursuit | 本体のpackage依存・vendorに未導入。独立研究側に似た機能があっても置換済みとは判断しない |

## 削除候補と根拠

既存の`bun run deadcode`、追加の未使用ローカル検査、サービスが返す操作名の抽出、リポジトリ全体の参照検索を併用した。公開ライブラリのAPIやテストで意図して使う公開口を一括削除しない。

| 対象 | 根拠・削除内容 |
| --- | --- |
| image contractsの`imagePlan` | 未使用の再export。元のcapabilities schemaとその試験は残す |
| larm公開口の`planCapacityWait`・`retryAfter` | 未使用の再export。内部実装と内部からの呼出しは残す |
| live-voice公開口の`LiveSnapshot`・`LiveConversationPort` | 未使用の型再export。内部契約は残す |
| usageの`UsageService`・`UsagePorts` | 未使用の型別名・再export。利用中の内部`UsagePorts`は残す |
| monitoring/itemsの`STALE_AFTER_MS` | 本番未使用の再export。試験は定義元freshnessから読む |
| memoryの`itemDtoInTransaction` | 定義以外の参照なし。画面用DTO変換そのものは利用中のため残す |
| worldの`markInitialSyncCompleteInWriter`・`validateUsageInWriter`・`forgetItemInTransaction` | 定義以外の参照なし。使用中の同等操作・検証・忘却経路は残す |
| model3dの`knownAssetInTransaction`・`generationOwnedInTransaction` | 定義以外の参照なし。所有権検査の内部関数は利用中のため残す |
| tasksの`assertFenceInTransaction`・`conversationInTransaction` | 定義以外の参照なし。後者からしか呼ばれなかったrepositoryの`conversation`も削除。世代の検査と利用中のquery経路は残す |
| toolchain-historyの`ExportCard` | 未使用型として検出されたが、進行中のrouting exportに属するため対象外 |

## 検証と残作業

1. 編集後にdeadcode・型・対象ファイルの整形を確認する。追加で検出された定義は参照を再確認する。
2. `bun run verify -- --domain memory --domain world --domain steward --domain model3d --domain tasks --domain image --domain larm --domain live-voice --domain usage --domain monitoring`。MemoryとWorldの利用側stewardを含める。
3. 着手時との差分を点検し、対象外・既存変更の保持と、個別語句への依存やLLM判断の代替処理を追加していないことを確認する。

画面・外部サービスの動作変更はないため、ブラウザE2E・live・実機器受入は省略する。全件verifyは除外領域を含むため使わず、対象domainを選ぶ。失敗は削除との因果を切り分け、担当外の変更や期待値の緩和で通さない。

## 実施結果

状態: 削除・検証・差分点検完了。コミットはしていない。

- ソース15ファイルで7行追加・58行削除（着手時との差分）。サービス操作8件と、その削除で未使用になったrepository検索1件を削除した。未使用の再export・型別名を整理し、monitoringの試験3本は定義元からのimportへ変更した。試験の削除・期待値の緩和はない。
- `bun run deadcode`は10件から1件へ減少。残る`toolchain-history/contracts/export.ts`の`ExportCard`は対象外のrouting exportに属する。全体コマンドはこの1件により終了コード1、対象範囲の検出は0件。解析設定・除外注釈は変更していない。
- 型検査は2,850ファイルで成功。部分試験は73件成功。
- 上記10domainのverifyは成功。境界・SystemContext・サイズ・SQL境界・domain文書・整形・lint・DesignSystemの型検査とbuild・rootの型検査が通過。API等1,150件、Web74件、DesignSystem22件、合計1,246件成功。入力と共有build出力の整合性エラー0件。
- 検証記録: `verification-reports/runs/2026-11-03T13-34-43-997Z-f24ca424-7211-43c1-a78a-ad1a7fe06ad2/report.json`（ローカル記録）。全体ログ・着手時との比較差分は `/tmp/eumenes-cleanup-20261103/`。
- 着手時の追跡ファイル差分と比較し、整理対象外の変更は増えていない。migrationと既存の未コミット変更を維持。個別例への分岐・LLM判断の代替・新しいフォールバックの追加は0件。

残作業: 今回の対象範囲にはなし。routing exportの未使用型は対象外として残す。ブラウザE2E・live・実機器受入は上記の理由で未実施。
