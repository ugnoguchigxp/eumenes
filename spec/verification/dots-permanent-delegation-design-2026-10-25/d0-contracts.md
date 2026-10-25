# D0: D1〜D2で固定する契約とD3の境界

> 後続の利用者指示で追加サーバー前提を撤回した。この文書・画像は以前の状態の記録。現行は[削除後の設計](../../dots-no-relay-cleanup-2026-10-25.md)を参照。


2026-10-25。計画への実装合意に従う。公開先・費用の選定はこの段階では行わない。

| 境界 | 今回の契約 | 未配備時の動作 |
| --- | --- | --- |
| 会話→受付 | `toolchain:dots.delegate@3` → `package:dots.request@1` → `binding:dots.delegate@2` → `adapter:dots-delegation@1` | 有効設定と利用可能な作業先がなければ新規実行を公開しない。設定・履歴artifactは利用可能 |
| 受付→実タスク | start/list/inspect/answer/stop。元ユーザー発言・同じ会話・project/connection revision・許可操作を検査 | 未提示ID、別会話、古い版を拒否。受付の短い期限で作業期限を短縮しない |
| 作業制限 | 既存tasks上限を維持。実行は60〜7,200秒、Sessionは1〜20。保存済み設定はその範囲をさらに狭める。初期値は受付無効・7,200秒・3 Session | 利用者が設定を保存して有効化するまで開始しない。旧接続・公開無効化を再seedで有効に戻さない |
| SQLite | dots/0005-work-settings。設定revision、operation ID・入力digest・host origin・receipt | UIは共通の下書き/CAS、同ID同入力は同receipt。モデル本文・秘密をログへ出さない |
| 一覧snapshot | 共通snapshot取得へ任意のhost会話参照を渡す最小拡張。dotsのLLM向けタスク一覧はその会話に限定 | 会話参照がなければタスク一覧は空。既存adapterは新引数を無視できる |
| ローカル操作台帳 | 30日、10,000件、単一receipt 64KiB、総量32MiB。容量到達は新規操作を拒否 | 成否不明を別IDで再開始しない。長期taskの原本はtasksが所有 |
| クラウド受渡し | append-only command/report、本人の固定、元grant digest/epoch/generation/順序、永続保存後のreceipt | cloudの作業先は保存できるが、永続transport未配備ではavailable=false。localへ代替しない |
| 遅延結果 | `relayReportV1` は版付きwire契約。署名はEd25519・base64url。trusted issuer/keyの検証、canonical署名対象、ローカル採用はD3 | schemaを通るだけでは署名済みと扱わず、現行report_taskを緩めない。遅延採用操作はまだ公開しない |
| 時刻と取消 | cloud受領時刻・実行期限・同期時刻を分離。期限前receiptかつ元許可と現行取消世代が一致する場合だけD3で採用 | PC停止を取消としない。取消済み／期限後初着の結果はタスクを復活させない |

クラウド保持期間・容量・clock許容差・署名鍵の信頼先・native環境の実IDと権限・配備先・費用はD3前に決める。未決値を暗黙の既定値で運用しない。D0〜D2のfixtureは実クラウドやPC停止中の作業完了を証明しない。
