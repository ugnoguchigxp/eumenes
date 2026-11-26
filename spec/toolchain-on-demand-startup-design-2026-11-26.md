# ツールチェーンの実行サービスを初回利用時に起動する設計

2026-11-26。設計案・合意前。調査はコード、既存の起動ログ、待ち受けを行わないモジュール読み込みで実施した。

## 目的と対象

会話画面と通常APIを開くための処理を減らし、利用するツールチェーンの実行サービスだけを読み込む。最初の利用には、会話で選ばれた担当の実行、利用者が開いた対応アーティファクト、実行条件を満たしてキューが再開する既存ジョブを含める。

最初の改修対象はCanvas。Computeなどへの展開は、Canvasの測定結果と、各担当の候補表示条件・復旧要件に基づいて決める。

## 起動時に必要な処理

[現行の先行起動](server-listen-first-startup-design-2026-11-07.md)では、サービス構築・復旧・開始をすべて終えてから通常APIへ切り替える。現在はCanvasのプレビュー用・観測用の待ち受けとComputeの環境探索もこの前に行う。Computeは接続設定がある場合、環境探索に最大15秒の期限を設けている。実際の短縮幅は変更後の計測で確認する。 [起動処理](../api/application/server.ts#L88) [復旧の登録](../api/application/server-lifecycles.ts#L213) [Computeの探索](../api/domains/compute/service/index.ts#L80)

- **ツールチェーンの登録。** 起動時にbundle・設定で有効なadapter・`describe()`・schemaを揃える。既存の`bundleHostOf`、版の検査、公開済みの設定、`find_toolchain`とランチャーの登録を使う。候補一覧や全体の起動確認は登録情報と設定だけで応答する。 [bundleの検査](../api/application/toolchain/toolchain-adapters.ts#L215) [起動時の登録](../api/application/toolchain/toolchain.ts#L285)
- **中断状態と失効の復旧。** 忘却・失効の反映を済ませ、キューのジョブ種別・入力版・復旧方針・結果を確定する処理を復旧前に登録する。`queue.recover()`はhandlerの方針を読み、以前の実行を中断扱いにするか再実行するかを決める。再実行するジョブは実際に実行するときに必要なサービスだけを読み込む。 [キューの復旧](../api/domains/queue/service/runner.ts#L205)

読み込みの切り分けでは、ファイルの生成や待ち受けを行わず、別々のBunプロセスで `server.ts` が776ミリ秒、Canvasの `runtime.ts` が251ミリ秒だった。各値には共通依存の読み込みを含む。受入では同じ起動経路で、初期画面までの時間とツールの初回実行時間を測る。

## 最初の改修（Canvas）

1. **候補と準備状態。** Canvasの設定が有効なら、コマンド・検索の候補とランチャーから起動前でも到達できるようにする。現在の`runtime.ready()`は実行サービスと作品一覧を使用できる条件なので、その用途で使う。候補表示は有効な設定と登録情報から判定し、実行時は初期化の結果と操作の権限を確認する。 [現行の可用性・スナップショット](../api/application/canvas/adapter.ts#L83) [アーティファクトの参照](../api/application/canvas/adapter.ts#L178)
2. **初期化の起点。** Canvas検索は`instant.run`、制作コマンドは選択済みbindingの入力準備、画面は認証とOrigin確認を通過したCanvas固有の要求、再開ジョブはキューの`execute`から、共通の初期化を呼ぶ。制作コマンドは選択済みbindingを確定し、transaction外で初期化してから作品のスナップショットを取得する。既存の認可・版・入力の照合はSQLiteの同一writerで行い、読み込み中の取消・失効・期限経過を読み込み後にも確認する。 [制作コマンドの入力準備](../api/domains/dialogue/service/execution-command.ts#L49) [Canvasジョブ](../api/application/canvas/jobs.ts#L68) [Canvasの画面ルート](../api/application/canvas/routes.ts#L78)
3. **読み込むもの。** Canvasの設定・登録情報・ジョブの状態管理を起動時の側に置き、保存作品を開くサービス・プレビューの待ち受け・Playwrightの観測実装を初回利用の側に置く。起動側が`runtime.ts`やCanvasの実装を値として読み込むimportを調べ、定義や型だけを使う接続に整理する。作品・候補を照合する既存の経路が必要な場合も、その処理から同じ初期化へ入る。 [現行のランタイム](../api/application/canvas/runtime.ts#L126) [候補の権限照合](../api/application/canvas/jobs.ts#L26)
4. **同時利用と失敗。** 同時の初回利用は一つの初期化を共有する。各呼出しの期限と取消は、その呼出しの待機と操作に適用する。ポート競合などで準備できなければ、途中まで開いた資源を閉じ、該当するCanvasの操作に既存の利用不可エラーを返す。会話や通常APIは使える状態で受付を続ける。次の正当な利用で再試行できる。終了処理では読み込み済み・読み込み中の資源を閉じる。プレビューの別オリジンと短命トークンは既存のCanvas連携に従う。 [画面とプレビューの境界](canvas-app-integration-2026-11-12.md#L21)

変更候補はCanvasの接続と試験、起動時の組み立て、選択された担当の実行。共通実行側では、選択されたbindingでスナップショットが必要になった時点の初期化に範囲を絞る。 [Canvasの本番接続](../api/application/canvas/) [起動時の組み立て](../api/application/server-wiring.ts) [ライフサイクル](../api/application/server-lifecycles.ts) [選択された担当の実行](../api/application/toolchain/task-execution-dispatch.ts)

## 他のツールチェーンへの展開候補

| 担当 | 初回利用へ回せる処理 | 実施条件 |
| --- | --- | --- |
| Compute | 保存済みLARM接続先での環境探索 | 現在は探索結果の有効期限が120秒で、他の履歴がない初回設定時は探索前に候補外になる。設定済み・未確認の候補から初回の探索に進める条件を決め、実行の前に探索結果と現在の接続設定を照合する。 [可用性](../api/domains/compute/service/index.ts#L134) [保存した環境](../api/domains/compute/repository/index.ts#L159) |
| Webブラウザー操作 | ドライバーの接続と、保持期限が過ぎた記録・孤立ファイルの整理 | ドライバーは既存の接続操作から開始する。前回の接続・実行が中断したことは起動時に確定し、整理は定期保守に任せる。 [状態の復旧](../api/domains/browser/service/connection.ts#L132) [定期保守](../api/application/server-lifecycles.ts#L120) |
| 株価 | EDINETの銘柄一覧の取得と展開 | 銘柄コード・会社名の照合精度を維持する。初回の株価依頼で会社名の解決に必要な一覧を取得し、既存の更新間隔とエラー処理を適用する。 [株価adapter](../api/application/stock/stock-adapter.ts#L119) |
| 天気 | 区域一覧の取得 | 起動時に取得する既存合意と、一覧が揃うまで候補に出さない条件を調整する必要がある。 [天気の設計](weather-instant-toolchain-design-2026-10-18.md#L58) |

## 検証条件

- Canvasの再開対象ジョブがない状態では、起動と通常の会話、`find_toolchain`、ランチャー一覧でCanvasの初期化回数が0。Canvasの検索、制作、アーティファクトをそれぞれ初回操作として実行し、正しい結果に到達する。
- 同時の初回操作で待ち受けと保存サービスは一組。初期化中の失敗・取消・終了で途中の資源が残らず、Canvasの失敗中も会話APIは応答する。
- 旧DB・保存済み作品・前回の中断ジョブを使い、中断結果の再採用を防ぎ、再開可能なジョブの初回実行と、作品に対する所有者・版の照合を確認する。認証・Origin不一致・初期化中の権限変更も確認する。
- 部分試験に続けて [Canvasの登録・利用試験](../api/application/canvas/) とキュー復旧を実行する。通し試験は [Canvas画面の個別ブラウザー試験](../tests/browser/canvas-app.spec.ts) を対象にする。サーバーの起動を伴う確認は事前に許可を得る。fixtureと稼働環境の結果を区別する。
