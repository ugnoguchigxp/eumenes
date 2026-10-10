# CLIコーディングタスクの監督

2026-10-10。計画03の監督ロジックと、計画04で使う報告台帳の先行契約を実装した。模擬ワーカーでの工程検証を実施済み。実CLIの自律実行、会話への報告配送、Kanbanモーダルはまだ受入済みではない。

## 所有する状態

`tasks` が依頼、権限、実行世代、ユーザー向け状態を所有する。`coding-supervision` は観測、判断、工程のintentと消費済み予算を持つ。`task-reports` は不変の報告と未配送outboxを持つ。別のタスク状態は作らない。

既存の `tasks.observe.v1` が60秒ごとに実行結果を読み、applicationの `superviseCodingExecution` が監督に渡す。観測が変わらなければ推論しない。正常な実行中・無出力は監視を続け、完了や失敗とは判定しない。5分の進捗欠如は `diagnosticDue` として表示できる。2回の観測失敗または150秒の観測途絶で監視遅延を記録し、新しい操作を保留する。

判断はQueueのbackground lane、会話と同じ実資源 `inference.llm` で実行する。CLIの工程は別jobで動かし、推論枠を占有しない。現在の観測、task revision、権限世代、実行世代、工程が変わると古い判断を採用しない。モデル応答後にワーカーをもう一度読み、snapshotや質問の変更も採用前に確認する。

判断と次のintent、タスク更新、報告は一つのwriter transactionで確定する。外部操作は保存済みintentの確定後に実行する。起動後に結果が不明になった操作を自動再送しない。取消や復旧は保存済みQueueとinference取消状態から処理し、実行世代を越えて結果を再利用しない。

## 工程と証拠

モデルが選べる行動は固定した列挙値だけ。任意のshellや追加権限を渡す入口はない。CLIの文章、リポジトリの記述、レビュー指摘は判断用の資料として扱い、監督への命令として扱わない。

CLI turn終了、子プロセス停止、証拠の取り込み完了を確認してから、固定チェック、実装と異なるread-only sessionのレビュー、必要な修正と再検証を進める。チェックの省略、定義digestの変更、自己レビュー、変更前snapshotの証拠は採用しない。同じブロッカーへの回答はIDの付け替えでも上限をリセットしない。

commit/pushはそれぞれ委任済みの場合にだけ実行する。branch、remote、operation ID、snapshot、停止・証拠状態を検査し、push先SHAが確定したcommit SHAと一致することを確認する。全完了条件のhost判定と検証・レビューの証拠がそろってから `tasks.completed` を記録する。Git参照は確認済みreceiptから報告DTOへ投影する。

`WorkflowPort` は登録済み操作ワーカーを接続するhost専用入口。モデルのJSONをこのportのreceiptとして使ってはいけない。実装時には計画02 C6の固定チェック、read-only review、workspace予約、権限・lease・期限、専用Git operationの証拠を強制する必要がある。現在の本番組立ては `unavailableCodingWorkflow` を使い、実行不能を明示する。

## 観測契約と診断（計画06）

`Observation.details` は、発言（種別・空か・切詰め）、turn終端、process状態、採取の完全性、報告の有無、取得範囲を別々に持つ。未確認と失敗を一つの「失敗」にしない。unknown種別の発言は最終回答ではなく、execでは明示finalが識別できないので `finalReport=unidentifiable`。turnが completed 以外（failed/cancelled/conflict/unconfirmed）なら、最終回答があっても変更・continue・commit/push・完了候補を許可しない（`stopped()`）。空報告・報告欠落だけでは検証工程を止めない。

読取りは `ObservationReadPort`（applicationの `codingObservationReader`）。coding domainの採用済みsnapshot（事実）をtransactionで固定し、transaction外で `coding.readEvidence` を最大4呼出し・4参照・64 KiB（1参照24 KiB）で読み、digestを照合し、読取り前後で意味のある変化があれば棄却する。coverageは一観測内だけで、観測間で合算しない。

承認待ち・decision・stepの失効判定とfingerprintは `semanticObservationDigest` を使う。時刻・heartbeat位置・抜粋・coverageは含めない。新しい発言・終端・停止・採取欠落・snapshot・質問・観測障害codeは含める。

観測失敗は、固定code・最後の正常cursor・実行/世代/権限を `observationFailedInTransaction` に渡す（自由な例外文字列は保存しない）。古い世代の障害は無視する。ホストの診断は専用Queue job（`coding-supervision.inspect.v1`、1回のみ・interrupt）で行い、変更用のavailable/policy/tokenizerに依存しない。回数は実行/世代/権限ごとにcode別2回・合計4回で、予約時に消費し再起動で戻さない。モデルの `inspect_more` も同じ読取りで、変更用のStepIntentに入らない。

診断を打ち切る条件は「process停止確認済み かつ（上限到達 または 続行不能の確定）」。このとき自由入力の質問は出さず、固定codeのholdと、確認済み範囲・権限・残予算を含む報告を一回だけ作る（`monitoring_issue`、dedupe `blocked:<executionId>`。task-reportsのblockerは質問を要求するため使わない）。停止未確認の間は不足報告と停止監視を続ける。選択肢付きの復旧質問は計画07の範囲で未実装。

## 推論と予算

`captureBackgroundControlInTransaction` はtask/decisionと権限・実行世代に結び付いた独立requestを作る。会話の期限やparentsを継承せず、現在の設定を固定したLARM-only/exact-contextで実行する。設定revisionの変更とtask取消は、別々の経路で古い結果の採用を止める。クラウドへの自動切替は行わない。

一判断30秒、出力1,500 token、入力12,000 token。JSONの修復は一度で、最初の30秒期限を共有する。実行時間と最大判断回数は保存済みtask grantに従い、修正は最大2回、同じブロッカーへの回答は最大1回。消費済み回数は停止・再開や再起動で戻さない。入力の計測値を判断履歴へ保存する。Providerが返していない使用量・金額は推測しない。

入力計測は採用モデルのtokenizerとmessage framingを把握した `countControlTokens` が必須。文字数からtoken数へ置き換えない。現在の本番LARM接続にはこの計測器が未接続なので、`model_tokenizer_unavailable` で保留する。fixtureの固定計測値は予算分岐の検証専用で、実モデルのtoken数や費用の証明ではない。

## 報告と読取りAPI

通常進捗は変化がある場合だけ、初期値5分の間隔で集約する。工程の確定結果、ブロッカー、完了、監視異常は別の報告になる。報告は確認時刻と確定時刻、task revision/権限・実行世代、証拠、snapshot、元の会話、質問への参照を持つ。本文・件数・16KiBの上限を検査する。古い未配送progressは集約し、終端報告は不要になったblocker/監視異常を置き換える。履歴自体は不変。

- `GET /api/tasks/:id/supervisor`：監視時刻、遅延、判断・工程への参照、予算消費、保留理由。CLI本文、session、privateなreceiptは出さない。
- `GET /api/tasks/:id/reports?after=0&limit=50`：sequence順の報告。既存の認証・origin検査を使う。
- 共通clientの `taskSupervisor` / `taskReports` から利用する。WebやCLIはDBを開かない。

忘却・本文期限切れ時には、監督の文脈と報告をタスクと同じtransactionで削除する。削除後のAPIは410。会話への配送、既読・配達receipt、元会話の世代検査、音声通知、タスクメニューとモーダルは計画04/05で実装する。

## 本番接続の未完了条件

実CLIを有効化する前に、計画02の隔離、固定操作ワーカー、実モデルのtokenizer計測、CLIとLARMでのlive受入が必要。本番runnerのprobeは現在も `isolation_not_verified` で起動を拒否する。監督ロジックのfixture成功を、実CLIや自律判断の成功率と読み替えない。

検証の詳細は [supervision-fixtures.md](../spec/verification/delegated-coding/supervision-fixtures.md) を参照。
