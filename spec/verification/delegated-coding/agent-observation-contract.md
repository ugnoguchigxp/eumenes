# 計画06 実装・検証記録

2026-10-10 JST。fixture検証のみ。直接CLIのlive確認、LARM経路、実配送は未実施。

## 実装したこと（コード上）

- runner: protocol `eumenes-coding/2`、発言metadata、正式終端（completed/failed/conflict）、processStarted、captureState/captureIssues、v1 readerと固定continue拒否、`kill(-pgid)` のEPERM扱い。
- coding: receiptの退行検査、terminalEventSeqと終端eventの照合、`observationSnapshotInTransaction`、`observationIssueCode`。
- coding-supervision: `details`、`semanticObservationDigest`（5箇所置換）、診断job（code別2/合計4）、`inspect_more` の読取り化、`selectReportMessages`、報告limitations。
- application: `codingObservationReader`、catchから固定code・cursorの受渡し。

## D0の記録・判断

- v1の正常終端投影（A22前半）は実装しない。本番の操作workerは未接続（available=false）で、継続価値のあるv1実行はない。v1は閲覧・停止照合とcontinue拒否のみ。
- inspect_moreのoffset指定読取りは未実装。1観測の有界読取りだけ。
- 報告は task-reports の `blocker`（質問必須）でなく `monitoring_issue` を使う。

## 受入との対応

| ID | 確認した場所 |
| --- | --- |
| A1/A7/A8 | packages/coding-runner/test/observation.test.ts（decoder）、api/application/coding-observation.test.ts |
| A2/A3/A9 | runner observation.test.ts（failed/noterminal/conflict）、coding-supervision observation.test.ts |
| A4 | coding-observation.test.ts（empty_only）、supervision（stopped条件） |
| A11/A14/A18 | coding-observation.test.ts（digest/状態変化の棄却、固定code）、coding-supervision.test.ts |
| A12/A21/A21b | coding-supervision observation.test.ts |
| A13/A22 | coding.test.ts（v1 snapshot・continue拒否）、runner（旧receipt） |
| A16/A24/A25 | coding-supervision observation.test.ts（上限・単一報告） |
| A17 | coding-supervision observation.test.ts（inspect_more） |
| A20 | runner observation.test.ts（processStarted） |
| A23 | runner observation.test.ts（長文でcaptureState=complete） |

未確認: A5（LARMの早着通知）、A6の一部（別実行の通知は既存fence検査に依存）、A10、A15（LARM経路）、A19の複数rangeの追加読取り。

## 実行結果

実行日時と結果は作業記録（会話）に従う。`verify:all` は他セッションの未完了編集（agent-runtime等）の影響を受けた。
