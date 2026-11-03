# 未使用コード・重複実装の追加調査

2026-11-03。基準commit: `9e17160bf9e7cac14c89548daf49ceea524cdd49`。
前回の整理後の追加調査。状態: 調査完了、製品コードへの削除・統合は未適用。

## 対象と調査方法

目的は、通常の未使用export検査が見つけない、返り値の未使用操作・テスト専用の本番処理・subプロジェクトと本体の重複を探すこと。

routing・interact・pipelineと、その対話・担当選択・実行機構は対象外。対象外の参照が見つかったときは、削除候補から外すための確認に留めた。DB・設定・migration・稼働サーバー・依存のインストールは変更していない。subプロジェクトは参照のみ。他チャットへの送信はない。

確認した資料は前回の[整理記録](subproject-dead-code-cleanup-2026-11-03.md)、World・Memory・Goalsの現行説明、[視覚解析設計](visual-perception-subsystem-design-2026-10-25.md)、[検証手順](../docs/verification.md)、各subプロジェクトの公開API。今回の調査で仕様変更や新しい判断方式は提案しない。

| 方法 | 確認したこと・限界 |
| --- | --- |
| knipのfiles/exports/types/namespace/enum/duplicates検査 | 通常検査の残りは対象外の`ExportCard`だけ。duplicate exportは同じオブジェクトの別名であり、実装の二重化とは限らない |
| TypeScriptによる返り値のプロパティ抽出と参照調査 | 単純なexport検査が拾わないサービス操作を抽出。構造的なinterfaceへの受渡し・spread・destructureで参照を見落とすため、解析結果だけで削除可能とは判断しない |
| 呼出し・契約・文字列登録・HTTP/Web/CLIとの照合 | 関数名が違う公開口、テストの操作、型を介した実行、画面の動的登録を個別確認 |
| 型・コメント・空白を除いた関数本体の照合 | 対象の本体とagency/memory/world/pursuitのソース計1,911ファイル。10行以上・250文字以上の関数を比較し、本体を含む完全一致12組。sub側との完全一致は検出されなかった。変数名やロジックが変わった近似コピーの不存在を証明するものではない |
| domain名を正規化した近似比較 | OCRと物体認識の同名ファイルを比較。下記の重複を確認 |
| 依存検査と全import照合 | 未参照の直接依存宣言2件を確認。他の検出は生成コード・試験・Bun組込みコマンドなどの誤検出として除外 |

調査スクリプト・解析結果・削除試算の差分とログは `/tmp/eumenes-deep-cleanup-20261103/`。保守用の解析基盤としてリポジトリへ追加していない。

## A. 先に整理できるもの

### A1. 呼出しのない公開口6件（削除試算済み）

内部関数を消さず、返り値に公開する操作だけを外す。

| ファイル | 公開口 | 根拠 |
| --- | --- | --- |
| `api/domains/world/service/curation-ctx.ts:308` | `manifestPrefix`・`releaseManifests` | 呼出しは同じclosure内だけ。外へ渡すプロパティの参照はない |
| `api/domains/steward/service/kick.ts:344` | `createUnit` | 内部では利用中。返された`Kick`のこのプロパティは使われない |
| `api/domains/tasks/service/index.ts:48` | `requestStartInTransaction` | 内部の`start()`がclosureから呼ぶ。公開プロパティは使われない |
| `api/domains/tasks/service/index.ts:52` | `amendGrantInTransaction` | 内部の`amend()`がclosureから呼ぶ。公開プロパティは使われない |
| `api/application/world/world.ts:209` | `WorldAssembly.initialSync` | 起動時と`setEnabled()`は内部関数を呼ぶ。公開interfaceと返り値のプロパティに呼出しがない |

削減量は小さいが、内部処理の責務や挙動を変えずに公開面を減らせる。4ファイルの削除案を試算済み。

### A2. Dotsの旧受領記録の読み書き2操作

`api/domains/dots/service/inbox.ts:13`の`dialogueReceiptInTransaction`と`:25`の`saveDialogueReceiptInTransaction`。合計37行の処理。

- メソッド呼出しは`api/domains/dots/test/inbox.test.ts:281`の旧受領記録の試験1件だけ。
- `callId`付きの`dots_execution_receipts`分岐には、その試験からの呼出しもない。
- 本番から新しく書く経路はなく、通常のDots報告・メッセージの受付とは別物。
- 試験だけが使う旧APIとして、メソッドとその専用試験を削除する候補になる。

ただし、`dots_dialogue_receipts`の古い行を消す処理は`service/commands.ts`や`repository/index.ts`で現在も使われる。表・migration・保持量のtrigger・忘却/削除処理まで消してよいという意味ではない。これらは維持する。

### A3. Goals・Continuityのテスト用ラッパー

| ファイル | 候補 | 本番で使われる代替 |
| --- | --- | --- |
| `api/domains/goals/service/index.ts:512` | `adopt`・`propose`・`adoptProposal`・`update`・`withdraw`・`complete`・`snapshot`・`proposals`の8操作 | stewardは`applyInTransaction`・`proposalsInTransaction`などを単一writer内で利用 |
| `api/domains/continuity/service/index.ts:157` | `list`・`revisionInTransaction`・`snapshot`の3操作 | 本番の読取りは`snapshotInTransaction`とeventsを利用 |

Goalsの`snapshot`には試験からの参照も見つからない。それ以外はdomain試験やfixtureで使うが、本番からの呼出しはない。単に同じ名前を持つ別domainの`snapshot()`や`update()`とは区別して確認した。

削る場合、状態遷移・scope・revision・再送・transactionの回帰試験は維持し、試験側で`store.write`や`store.readSnapshot`を呼ぶ小さなfixtureに寄せる。目標・短期メモの業務処理そのものを削らない。ラッパー削除のために試験を大量に消す方針は取らない。

### A4. Worldの旧Slice usage検証

`api/domains/world/service/world-service.ts:340`の`validateUsageInTransaction`と`:420`の公開`validateUsage`は、現在はWorld domainとapplicationの試験からしか呼ばれない。

連鎖する候補は`service/inputs.ts:258`の`receiptSourceRefs`、`contracts/host.ts:101`の`WorldUsageCheck`とその再export。およそ50〜60行の本番側処理になる。

現行の会話はnames-only hint、調査結果の採用は`world-research-ports.ts`のclaim Source・版・出典再検査を使う。古いSlice receiptの検証とは経路が違う。

`world-evidence-integration.test.ts`などには、配布パッケージの版指定Slice・訂正後の失効を確認する意味のある受入試験がある。この検証は維持し、必要な組立てを試験側へ移すか、パッケージの公開APIから試す形にしてから本番ラッパーを外す。

**旧usage行とMemory dependentの清掃は別。** `service/usage-ledger.ts`は忘却・release retryから現役で呼ばれるため、これと一緒には削除しない。

### A5. 未参照の直接依存宣言2件

| 場所 | 宣言 | 根拠 |
| --- | --- | --- |
| rootの`package.json:51` | `@openai/codex-sdk` | 使用するのは`packages/coding-runner`のみ。同workspaceに同版の直接依存が既にある。会話のCodex接続はCLI app-server transportを利用 |
| `packages/dots-mcp/package.json:8` | `@modelcontextprotocol/core` | 自分のコードからのimportなし。使用中の`@modelcontextprotocol/server`が同版を通常dependencyとして持つ |

パッケージ全体が不要という意味ではなく、不要なのはその場所での直接依存宣言。削除時はlockを最小更新し、workspaceを含む型検査・runner/MCP試験で解決を確認する。他の依存更新やpostinstallを混ぜない。

## B. 実装の重複。稼働中なので統合設計が必要

### B1. LARMの接続解放

`api/domains/larm/service/lease-manager.ts:31`と`provider-leases.ts:19`の`stopUsing`、`:38`と`:26`の`releaseConnection`が同じ処理。

接続のDELETE、既存Promiseによる二重解放防止、許容HTTP status、bodyの破棄、解放ログ、失敗時の再試行可能化が二か所にある。両方が使用中なので、どちらかの呼出しをなくすことはできない。同domain内で小さい関数として一つにすれば、約30行の重複を減らせる。

候補はこの終端操作の共有だけ。LLM/音声/decisionのlease管理方式全体を統合したり、再試行・優先順位・接続世代の扱いを変えたりしない。既存のlease/release・取消・provider隔離試験を維持する。

### B2. OCRと物体認識の視覚解析

次の一致率はdomain名・表名・関数名を正規化した後の行比較。挙動の同一性を示すテスト結果ではない。

| 同名ファイル | OCR / 物体認識の行数 | 一致率 |
| --- | --- | --- |
| `controller/analyses.ts` | 118 / 118 | 100% |
| `service/analyses.ts` | 238 / 239 | 97.7% |
| `service/analysis-handler.ts` | 232 / 231 | 98.1% |
| `repository/analyses.ts` | 37 / 36 | 90.4% |
| `service/gateway.ts` | 107 / 107 | 98.1% |

解析のprepare/execute/settle、queueの空き待ち・取消、停止観測、画像/マスクの取得、HTTPの検査が重複している。既存のLARM`PerceptionPort`・共通schema・queue・停止観測機構は既に両側が利用している。残る二重化はその利用側の実行・HTTP組立て。

最も削減余地が大きい箇所だが、現在どちらも画面とAPIから使われる。一方を丸ごと削除する候補ではない。統合するなら先に責務と検証を設計する。SQL・表・domainの業務判断と試験は各domainに残し、OCRが物体認識内部を参照するような統合はしない。推論の意味判断・出力・再試行を変えず、IOと実行の重複だけを狭く扱う。

## C. 今回は削除候補にしないもの

- **Memoryの実行参照。** `executionReferencesInTransaction`の発行は試験からしか呼ばれないが、読取りは対象外の`application/toolchain/task-execution-sources.ts`に残る。表・既存参照の検証・忘却処理もある。発行だけを見て全体を削除しない。
- **Memoryの日付処理。** ホストの`parseDatePart`/`formatDatePart`はsub側の`parsePartialDate`/`formatPartialDate`に似ている。ただし後者は配布パッケージの公開口に出ておらず、入力検査・例外の契約も違う。非公開の深いimportや日付検証の変更をしてまで削る対象ではない。
- **Worldのjournal、Memoryのblock/forget journal、旧台帳backfill。** 保存形式・復旧・忘却の責務が違い、稼働中。外見が似ていても不要とは判断しない。
- **`BrowserSettingsView = BrowserWorkspaceView`。** 画面登録が両方の名前を使う。関数実装は既に一つであり、二重実装ではない。
- **`activityQuerySchema = eventsQuerySchema`。** schemaは同じオブジェクトで、実装の複製ではない。必要なら元定義のexportを内側へ閉じる程度。
- **queue/schedulerの`tick`、datasetの`drain`、Agencyの`inspect`など。** 固定試験を同期・観測する入口。テストからしか呼ばれないという理由だけで消さない。
- **Pursuit。** 基準commitの本体依存・vendorには未導入。将来の置換計画と、現在使われなくなった実装は区別する。
- **小さなUI/契約の文字列整形の重複。** OCR補正の`correctionText`と`correctionPlainText`は同じ本体だが両方使用中。DesignSystemからbackendを参照したり、新しいpackageを増やしたりするほどの削減量ではなく、優先度は低い。

## 削除試算と検証結果

本体を変更せず、tracked sourceと試験を一時ディレクトリへ複製してA1の公開口6件だけを削除。DB・実設定・秘密は複製せず、インストール済み依存は参照した。

| 確認 | 結果 |
| --- | --- |
| 試算ソースの`bun check --no-pretty --all` | 成功（2,926ファイル）。コピー側と参照先workspaceの両方が含まれるため、元の検査のファイル数とは異なる |
| tasks/tasks、steward/steps、world/world-service、application/world/worldの4試験ファイル | 59件成功、失敗0。fixture検証のみ |
| 元の作業ツリー | 製品コードを変更していない。調査記録のみ追加 |

準備時に依存リンク・参照fixtureが揃う前の検査と、試算編集が内部bindingまで外してしまった検査が失敗した。リンク/fixtureを揃え、削除対象を返り値の公開口に限定した後の最終結果だけを上の成功として採用した。元ソースへの編集や試験期待値の変更はしていない。

A2〜A5とBは参照・設計調査まで。削除後の動作検証済みとは扱わない。実装する際は対象domainと利用側の`bun run verify -- --domain ...`を実行する。今回は本体の実装を変えていないため、全件verify、ブラウザE2E、live、実機器受入は再実施していない。

## 推奨する順序と残作業

1. A1の公開口6件を削除。影響domainはworld・steward・tasks。
2. A2の旧Dots受領記録APIとA3の薄いラッパーを整理。試験の移し替えを伴う箇所は別段階にする。
3. A4のパッケージ受入試験を維持して旧World検証を本番から外す。A5の依存宣言は別の最小差分で整理する。
4. B1は同domain内の終端操作の共有案を先に固める。B2は削減余地が大きいため、domain境界・SQL所有・取消/復旧を含む設計の合意後に実装する。

調査の残作業はなし。製品への削除・統合、A2以降の実装検証は未実施。調査中に別作業の`spec/README.md`と`spec/agent-roles-and-pursuit-integration-design-2026-11-03.md`の差分が現れたが、今回の変更に含めず維持している。

後続記録: 利用者の実施指示を受け、A1〜A5の削除/試験fixture移動、B1・B2の共通化、verifyと差分コードレビューを完了した。詳細は[実装設計と完了記録](unused-code-consolidation-design-2026-11-03.md)を参照。上記の未実施表示は追加調査時点の履歴である。
