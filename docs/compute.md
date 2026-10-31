# Python計算

チャットからCPUで数値計算・記号計算・統計・回帰・作図を依頼できる。公開関数は `compute_python`、担当が選べる操作は次の4本。登録は `api/domains/capabilities/bundles/compute.bundle.json`、設計の正本は [CPU計算の統合設計](../spec/compute-cpu-integration-design-2026-10-21.md)。

| tool | 引数 | 返るもの |
| --- | --- | --- |
| python_submit | code、inputs（省略時{}）、timeoutSec（1〜60、省略時60）、accelerator（cpu/auto、省略時auto） | EumenesのjobId、受付状態 |
| python_status | jobId | 状態・進捗・結果・エラー |
| python_cancel | jobId | 取消要求の状態 |
| python_artifact | jobId、artifactId | 保存済み成果物の参照 |

IDは担当へ渡したsnapshotのものを使う。Pythonは `inputs` を読み、答えを `result` に代入し、`report(message, ratio)` で進捗を出す。matplotlibの図はPNGになり、明示ファイルは `/work/artifacts` へ保存する。実環境と上限はenvironmentで確認する。GPU・network・子process・利用者が追加するthread・package追加は使えない。

新しい計算は受付を返し、キューが完了まで追跡する。日常担当からの呼出しでは親が確定結果を待って説明する。単発呼出しの完了通知は、取得した結果値と成果物の有無を元の会話へ返す。状態が不明な場合は新しい計算を自動投入しない。「計算」画面の状態再確認は同じkey・同じ本文を使う復旧操作で、意図的な再計算とは区別する。復旧で元の実行期限は延長しない。jobId未確定のまま期限が過ぎた投入は再送しない。

## 接続

保存済みLARM Control設定と既存のbackend Control Bearerを使用する。catalogのルートとprofile別servicesからcapability `compute.python.execute`、protocol `larm.compute.v1` を探す。サービス名やモデル名は固定しない。広告のurl・相対endpointとdescriptionを読み、environment取得まで成功したときに新規実行を提供する。相対endpointがあれば保存済みControlへ解決し、urlもある場合はパスの一致を確認する。相対endpointがない絶対urlは同一originに限る。保存済みControlと異なるoriginやredirectへ資格情報を送らない。

相対endpointがなく、保存済みControlと広告urlのoriginが違う場合は利用不可となる。広告URLのホストを固定IPへ書き換えず、catalogが広告する相対endpointを使用する。別originへの資格情報送信は行わない。保存済みジョブは計算サービスの可用性と分けて保持する。「計算」の画面は未接続・履歴0件でも開ける。接続状態と空の履歴を表示し、新規計算は環境の確認が済むまで拒否する。

## 保存と取消

投入前に正規化本文とIdempotency-Keyを保存し、受理後にLARM jobIdを記録する。初回pollは約1秒後。再起動後は永続queueと保存済みjobIdから追跡し、成否不明のPOSTを新しいkeyで繰り返さない。Control資格情報の世代が変わった場合は以前のjobを別の資格情報で追わない。

取消は専用POST。取消要求中と取消済みを分け、完成との競合でLARMがcompletedを返した場合は完成結果を保持する。期限・親の取消・失効後の結果は親へ採用しない。DELETEは補助管理操作であり、取消の再試行に使わない。結果・成果物を自動で外部削除しない。

PNG・SVG・CSV・JSONはbackendが取り込み、既存の認証付きAPIから提供する。PNGは画面表示し、SVGはinline表示せずダウンロードする。一部の取得に失敗しても取得済みの成果物は保存し、再取得では不足分だけを扱う。画像プレビューの失敗でも結果・状態・ダウンロード操作は表示する。表示JSONへ実体、秘密、Blob URLを保存しない。コード・入力・結果・標準出力・tracebackは通常ログへ出さない。

画面は会話50%・計算アーティファクト50%を基準とし、履歴サイドバーは置かない。「計算結果」と「ライブラリ」を別タブに分ける。ライブラリのテーブル一覧から過去の計算を「開く」と、計算結果タブへ移り、結果と成果物を一列で表示する。履歴選択にSelectは使わない。計算の状態バッジと短いIDは1行にまとめ、生のstageは表示しない。個別表示は「実行したPythonコード」「結果」の順のアコーディオンとし、コードは初期状態で閉じ、結果は開く。結果値・標準出力・標準エラー・エラー・グラフ・ダウンロードを結果の内側にまとめる。更新中も開閉状態を保ち、別の計算を開くと初期状態に戻る。

## 管理APIと検証

既存のAPI認証・Origin検査を使用する。

| 操作 | API |
| --- | --- |
| 一覧・状態 | GET /api/compute/jobs、GET /api/compute/jobs/:id |
| 投入 | POST /api/compute/jobs（Idempotency-KeyにUUID） |
| 取消・復旧照会 | POST /api/compute/jobs/:id/cancel、POST /api/compute/jobs/:id/reconcile |
| 削除 | DELETE /api/compute/jobs/:id |
| 成果物 | GET /api/compute/jobs/:id/artifacts/:artifactId |

部分試験は `bun test api/domains/compute/test/ api/domains/larm/test/compute-client.test.ts`。登録・アプリケーション結合は `bun run toolchain:bundle -- check api/domains/capabilities/bundles/compute.bundle.json` と `bun test api/application/compute/`。所有domainと利用側は `bun run verify -- --domain compute --domain larm --domain capabilities --domain tool-runtime --domain agent-runtime --domain dialogue --domain artifact`。

live確認は `bun scripts/compute-live.ts --run` で発見・環境取得、`--execute` を加えるとNumPy・SymPy・SciPyを各1件投入する。サーバーは起動せず設定も書き換えない。このスクリプトの結果だけでは実LLMの選択・ブラウザ表示・プロセス再起動の受入完了を意味しない。固定試験とliveの結果は [検証記録](../spec/verification/compute-cpu-2026-10-21/README.md) に分けて残す。
