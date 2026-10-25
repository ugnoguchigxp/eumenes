# 失敗した run のエラーレポート（LLMへ貼れる診断）

作成日: 2026-10-17

状態: 2026-10-17 実装・fixture済み（API・CLI・画面）、独立レビューの指摘（最初の失敗の選び方ほか）を修正済み。E1〜E3は§6で決定。実機での確認は未。build の commit hash は未掲載。操作失敗（actionFailure）で完了した run にも詳細が出る（調査失敗と区別する読み取りが agent-runtime に無いため）。

関連: [ログの確認](../docs/logging.md)、[調査失敗時の返答](research-failure-reply-and-readahead-2026-10-17.md)、[会話の初動（削除済み。正本は会話エージェントのContextWindow仕様）](context-window-spec-2026-10-24.md)。

## 1. 目的

音声の返答は「失敗しました。」だけにした。原因を調べるときは、画面の失敗した回答から、LLM（Claude Code など）へそのまま貼れる短い診断テキストをコピーできるようにする。ログ全体を LLM に読ませるより少ないトークンで、失敗箇所・理由・追跡用IDが伝わることを狙う。

## 2. 現状（確認済み）

- ログは JSONL で、許可した運用項目だけを記録する（`docs/logging.md`）。会話本文・設定・認証情報・Provider の生応答・モデル出力の値は出ない。契約違反は `validationPath`・`validationCode`・`expectedType`・`actualType` などの固定項目で残る。
- 調査は `bun run logs -- --id <runId> --json` で行うが、1 run で数十〜数百行になり、`performance.stage` などの正常系が大半を占める（例: 天気の run `bc992888-…` は約120行）。
- run の状態・失敗コードは dialogue の run、選定は toolchain-history、サブエージェントの状態と失敗は agent-runtime、推論要求は inference が持つ。
- 画面には run の状態・作業状況の表示（`web/src/workspace/RunDetails.tsx`）があるが、失敗の診断をまとめて出す仕組みはない。

## 3. 提案

### 3.1 診断レポート（backend が組み立てる）

dialogue が `GET /api/runs/:id/error-report` を公開し、失敗した run（`status=failed`、中断した `status=interrupted`（E4）、または調査失敗の固定返答で完了した run）について、次の固定形式のテキストを返す。各情報は所有 domain の公開操作から読む（dialogue が他 domain の DB を直接読まない）。ログは infrastructure にログ読み取りの公開操作を設け、`scripts/logs.ts` と同じ読み取りを使う。

```text
# Eumenes エラーレポート
これは失敗した会話処理の診断です。会話本文・設定・認証情報は含みません。
原因の推定と、確認すべきコード・ログを示してください。

## 概要
- 発生: 2026-10-17T12:19:45Z（JST 21:19）  build: <commit短縮hash> boot: <bootId>
- 結果: failed / invalid_conversation_operation
- 失敗した段階: サブエージェント（web.search@6 / worker / search）

## 経過（正常系は集約）
| 経過 | 段階 | 結果 |
| 0.0s | R1 依頼分析 | live_info / find_toolchain（5.9s） |
| 6.0s | 候補検索 | 4件（embedding） |
| 11.1s | R2 選定 | web.search、一時回答あり |
| 18.2s | worker step 2（invoke） | control_schema_invalid → 修復 → control_schema_invalid → invalid_control_json |
| 25.0s | 失敗の回答 | spoken_reply_too_long ×2 → invalid_conversation_operation |

## 最初の失敗
- component: agent-runtime  event: agent.control_rejected
- reason: control_schema_invalid  validationPath: unknown.0  validationCode: invalid_type  expected: object  actual: string
- 参考: docs/logging.md「調査失敗の原因」

## 追跡用
- runId / requestId / jobId / taskId / stepId …
- bun run logs -- --id <runId> --json
- bun run logs -- --id <taskId> --level warn --json
```

- **集約の規則:** `performance.stage`・接続・正常な状態遷移は段階ごとに所要時間へまとめる。warn 以上と、`*_rejected`・`*_failed`・`*_validation_issue` は個別に残す。同じ理由の繰り返しは「×N」にまとめる。
- **上限:** 全体を約3,000文字（目安1,000〜1,500トークン）に収める。超える場合は経過の古い正常系から省き、省いた件数を書く。
- **含めないもの:** ログ規約と同じ（会話本文・依頼文・認識結果・音声・設定・認証情報・Provider の生応答・モデル出力の値・未知の項目名）。R1 の `goal` なども含めない。IDと固定の理由コードだけ。
- **「参考」の対応:** 理由コードから `docs/logging.md` の節への対応は、固定の表で持つ（新しい理由コードを足したら表も更新する）。対応がなければ書かない。

### 3.2 画面

- 失敗した回答（「失敗しました。」や失敗表示の run）に「詳細」ボタンを出す。押すと上のレポートをダイアログで表示し、「コピー」ボタンでクリップボードへ写す。
- ダイアログに「IDやエラー発生箇所が含まれます。外部へ共有する前に確認してください」と1行添える（ログ規約の注意と同じ）。
- 音声の返答は「失敗しました。」のまま変えない。

### 3.3 CLI

`bun run cli run <id> --error-report` で同じテキストを標準出力へ出す。Claude Code から直接取得できる。

## 4. 変更範囲（見込み）

| 対象 | 変更 |
| --- | --- |
| `api/infrastructure/`（logger の読み取り側） | runId 等の相関IDで JSONL を読む公開操作。`scripts/logs.ts` はこれを使う形に寄せる |
| `api/domains/dialogue/` | `error-report` の組み立てと API。集約・上限・理由コード→節の表 |
| toolchain-history・agent-runtime・inference | レポートに必要な読み取りの公開操作（既存で足りなければ最小の追加） |
| `web/src/workspace/RunDetails.tsx` 周辺 | 「詳細」ボタンとダイアログ、コピー |
| `cli/` | `--error-report` |
| `docs/logging.md` | エラーレポートの節 |

## 5. 受入

- fixture: 失敗の種類ごと（R1/R2 の契約違反連続、worker の control 失敗、調査失敗の固定返答、tool 失敗、取消）にレポートが固定形式で出て、最初の失敗と理由コードが正しく、上限を超えない。会話本文・依頼文・設定値が含まれない。
- 画面: 失敗した回答から詳細を開き、コピーした内容が API と一致する。
- 実機: 失敗を1件起こし、レポートを Claude Code に貼って、ログを直接読ませた場合と同じ原因に到達できるかを比べる（トークン数も記録）。

## 6. 要合意事項

| ID | 論点 | 選択肢 |
| --- | --- | --- |
| E1 | 対象 | 決定: (a) 会話の run の失敗（その run から起動したサブエージェント・操作の失敗を含む）。それ以外の画面・機能の失敗は対象外 |
| E2 | 依頼文を含めるか | 決定: (a) 含めない（ログ規約どおり） |
| E3 | 調査失敗の固定返答で完了した run も対象にするか | 決定: (a) 対象にする |
| E4 | 中断（`status=interrupted`）で終わった run も対象にするか | 決定（2026-10-24）: (a) 対象にする。回答が出ないまま終わったので、失敗と同じく AI の回答の位置にエラー吹き出しを出し、レポートの結果欄は `interrupted / <理由>` |
