# 委任タスクと CLI 監督機能の全体実装計画

作成日: 2026-10-09 JST。状態: 全体の実装計画。計画01のタスク基盤は実装済みで、CLI runner・監督・会話報告・モーダルは後続実装。各文書の実装記録と検証記録を参照する。

Eumenes の会話から仕事をタスクとして登録し、独立した監督サブエージェントが CLI コーディングエージェントへ実装、検証、レビュー、修正、commit、push を依頼する。状況は毎分確認し、節目、完了、ユーザー判断が必要なブロッカーを元の会話へ報告する。ユーザーは会話を続けながら、タスクメニューから Kanban モーダルで状況を確認できる。

永続タスクを業務上の正本にし、一回ごとの処理を既存 Queue、定期起動を既存 Scheduler に委ねる。Web 版はローカル backend から MCP 経由で runner を使う。将来の Tauri では同じ実行契約を native 側から利用できる構成にする。

## 1 計画書の構成と読む順序

| 計画書 | 主な責任範囲 | 先行条件 |
| --- | --- | --- |
| [01 タスク基盤と Queue](01-tasks-and-queue.md) | 登録、状態、権限、公開操作、定期確認の契約 | 全体契約の確定 |
| [02 CLI 実行と MCP](02-coding-runner-and-mcp.md) | workspace、プロセス、出力、復旧、Git 証拠 | 01 の ID と権限契約 |
| [03 監督サブエージェント](03-coding-supervision.md) | 独立した文脈、観測、判断、レビュー修正ループ | 01 と 02、04 の報告契約 |
| [04 会話との委任と報告](04-conversation-and-reports.md) | 会話受付、報告配送、追加指示、音声 | 01、03 の公開契約 |
| [05 タスクモーダル](05-task-modal.md) | Kanban、登録、詳細、回答、停止、更新 | 01 の API、04 の報告 DTO |

実装順は章番号の順に一括完成させる方式ではない。最初に全体契約を固定し、fixture で一往復を作ってから機能を厚くする。工程と統合ゲートは本書を正本とする。状態と ID は 01、runner と Git は 02、判断と予算は 03、報告と会話採用は 04、UI の投影は 05 を正本とし、変更時は利用側計画も同時に更新する。

## 2 現行実装と前提

参照 HEAD: `0492c6bf44cfbb6328fdf899e05570068ef9c004`。作業開始時に HEAD と差分を再採取する。確認時点では別作業の `spec/research-route-learning-implementation-plan-2026-10-09.md` が未追跡で存在する。本計画の作成では変更していない。

| 現行の入口 | 現状と利用方針 |
| --- | --- |
| [Queue](../../api/domains/queue/types/index.ts) | 重複キー、世代、lease、資源枠、同時実行キー、復旧方針を持つ。CLI 固有判断を追加しない |
| [Scheduler](../../api/domains/scheduler/types/index.ts) | 型付き target と transaction 内 materialize。60秒間隔、coalesce、重複 skip を再利用 |
| [組立て](../../api/application/server.ts) | loopback backend、単一 writer、worker 前の復旧、commit 後の SSE がある |
| [tool-runtime](../../api/domains/tool-runtime/contracts/index.ts) | 現在の結果は Web 調査専用。タスク受付の結果種別が必要 |
| [agent-runtime](../../api/domains/agent-runtime/contracts/index.ts) | 調査 coordinator/worker と回答採用 ticket。長期の業務タスクとは別の台帳 |
| [dialogue](../../api/domains/dialogue/service/index.ts) | 調査報告を使った回答採用。背景報告を起点にした通知は追加設計 |
| [inference](../../api/domains/inference/contracts/index.ts) | control は元の推論の期限・parents を継承する。背景 task 用の独立 capture と資源調整が必要 |
| [会話画面](../../web/src/App.tsx) | 設定への入口がある。タスクモーダルとその API は未実装 |
| [domain 規則](../../docs/domains.md) | 下位から上位を参照しない。application が公開操作を結合する |

`continuity` の会話上の目標・しおりは実行台帳の代替にしない。必要ならタスクへの参照を置き、状態の正本は `tasks` に一つだけ持つ。既存 `delivery` は発話・表情の制御であり、報告配送台帳を置く場所ではない。

補助 LARM selector は現行コードで利用を制限している。独立サブエージェントを独立モデル枠の配備済みと解釈しない。初版は文脈・台帳を分離し、利用可能な推論枠を Queue で共有する。

## 3 初版の範囲

初版は現在の単一利用者、ローカル backend、macOS を受入対象にする。対応 CLI はまず Codex 一種類とし、Claude Code は同じ adapter 契約の後続対応とする。CLI の版・認証・sandbox・利用可能なモデルは P0 で実機確認し、固定した版を受入記録に残す。

初版に含めるもの:

- 会話とモーダルから同じ API によるタスク登録。「着手」と「登録のみ」の区別。
- 登録済み Git workspace と専用 worktree、初期値で CLI 同時実行一件。
- 実装、指定の検証、別セッションでのレビュー、修正、委任済みの commit・push。
- 毎分の観測、必要時の監督判断、追加質問とユーザー回答、停止・再開。
- 進捗・完了・ブロッカー・失敗・取消・監視異常の会話報告と Kanban 表示。
- 出力の差分読取り、プロセス停止確認、再起動照合、操作と通知の重複防止。

初版に含めないもの:

- 利用者 PC へクラウドから接続する常駐配布、複数利用者、任意の既存端末への後付け接続。
- 任意 MCP server の登録、任意 shell をモデルへそのまま公開する機能、汎用 workflow editor。
- force push、保護ブランチへの直接反映、自動 merge・deploy・PR 作成。必要なら独立した委任契約を追加する。
- 無制限の修正、モデルや認証の無断切替え、sandbox 拒否の迂回。
- Tauri の製品移行、Windows/Linux の動作保証。移行可能な契約までを扱う。

SAAA と hono-standard は参照専用。製品 DB・設定・秘密を移植しない。本計画の作成・実装のために既存の別 Codex チャットへメッセージを送らない。

## 4 所有境界と依存方向

下表は追加後の許可依存案。既存依存は維持し、`scripts/domains.ts` と境界試験を変更時に更新する。

| Domain | 所有するもの | 新規の依存先 |
| --- | --- | --- |
| `tasks` 新規 | ユーザー向けタスク、委任、状態、質問、公開操作、SQL | なし |
| `coding` 新規 | workspace、実行意図、CLI 実行、イベント cursor、証拠、runner adapter | queue |
| `task-reports` 新規 | 版付き報告、配送 outbox、既読、重複排除 | tasks、queue |
| `coding-supervision` 新規 | 観測と判断、計画、予算、工程遷移、監督用 SKILL | tasks、coding、task-reports、queue、scheduler、inference |
| `dialogue` 既存 | 委任の意図判定、背景報告の自然文生成と採用 | tasks、task-reports を追加 |
| `tool-runtime` 既存 | タスク受付結果の契約と検査 | 既存依存を維持。下位 port を注入 |
| `agent-runtime` 既存 | 能力選択、調査とタスク受付の経路分岐 | 既存依存を維持 |
| `queue / scheduler` 既存 | 汎用実行、起動時刻、資源・重複制御 | 既存依存を維持 |

`api/application/delegated-tasks.ts` を結合点とし、登録・実行予約・権限取消・報告採用など複数 domain の更新を単一 writer transaction 内の公開操作で行う。各 domain は他 domain の SQL を直接書かない。外部通信・CLI 起動・ファイル操作・推論は transaction 外に置く。

`tasks` は kind ごとの起動 port を必要に応じて受け取るが、`coding-supervision` を import しない。`task-reports` から `dialogue` へ逆依存を作らず、会話への配送を application が結合する。runner package は backend の domain と製品 DB に依存しない。

Web と製品 CLI は `client/` の HTTP API を使う。MCP client は backend の内部 adapter であり、ブラウザーへ CLI credential や runner の実行権限を渡さない。

## 5 全計画で守る契約

1. ユーザー向け `taskId`、監督の `decisionId`、CLI の `executionId`、Queue の `jobId`、会話の `runId` を別物として扱う。
2. 会話受付の終了や別の発話は委任タスクの取消ではない。登録後の寿命を元の会話 run に従属させない。
3. タスクの業務状態、作業工程、CLI の稼働状態、観測の新しさを別に持つ。
4. 受付、起動、turn 終了、試験成功、依頼完了、報告配送を区別する。
5. 権限は保存済みユーザー入力に結び付ける。モデル報告・CLI 出力・作業ファイルで拡張しない。
6. 一つの task に対する判断と変更操作を直列化する。毎分 tick と CLI event は同じ判断を重複起動しない。
7. 外部副作用は完全な exactly-once を保証しない。曖昧な起動・commit・push は照合し、自動再送しない。
8. 取消・権限変更・別の実行への切替え後は古い判断を採用しない。既に行われたファイル変更や push は取消で巻き戻さない。
9. 「毎分監視」は正常稼働中の観測間隔。スリープ中の監視や、一つの推論枠での常時即応を保証しない。
10. 通常ログへ会話本文、CLI の生出力、設定、認証情報を入れない。作業資料は専用保存とアクセス契約で扱う。

## 6 実装工程と統合ゲート

| 工程 | 実装するもの | 完了条件 |
| --- | --- | --- |
| P0 契約と環境 | 全計画の schema、版、domain graph、CLI probe、依存版、検証 fixture 方針 | 未解決の必須契約を解消。起動・停止・JSON 出力・権限制御の採用方式を決定 |
| P1 タスクの登録と閲覧 | 01 の DB/API、最小の 05、04 の会話受付 receipt | 登録のみと着手を区別し、再送しても一件。モーダルから一覧と詳細を確認 |
| P2 実行と観測 | 02、毎分観測の target、fixture runner | 一件を起動・観測・停止できる。切断しても二重起動しない |
| P3 監督の一巡 | 03、04 の報告 outbox、05 の質問回答 | 実装→検証→レビュー→修正→再検証を fixture で完遂。会話は継続できる |
| P4 commit と push | 限定権限、Git 証拠、結果照合 | 隔離した remote で指定 commit の反映を確認。未知の結果を再送しない |
| P5 会話と画面の仕上げ | 進捗集約、通知・音声、追加指示、モーダル全操作 | 新しいユーザー発話なしで報告。古い質問と重複通知を排除 |
| P6 受入と運用 | fault 注入、live、実操作、保持・cleanup、無効化 | 下記の全体受入を満たし、記録を分離して保存 |

各工程のチェックは未実施。P1〜P3 の fixture 完了を製品全体の完成と呼ばない。コーディング委任は P4 を含む本来の範囲を満たして初版完了とする。

## 7 全体受入

検証記録は `spec/verification/delegated-coding/{README,fixtures,live,devices}.md` を追加する。fixture の時刻は fake clock、DB は一時 DB、CLI は fixture process、remote は一時 bare repository とする。製品 workspace や通常の CLI セッションを試験に流用しない。

- A1 会話で push まで委任し、回答後に別の会話をしながら実装・レビュー・修正・検証・commit・push が進む。
- A2 登録のみでは実行されず、明示開始後に一件だけ開始する。HTTP 再送・モデルの重複呼出しも一件。
- A3 無出力の長いコマンドを勝手に再起動しない。毎分観測で新しい文章と稼働状態を区別できる。
- A4 自動解決可能な質問は範囲内で回答し、仕様・認証・権限の追加判断だけをメインへ渡す。
- A5 未回答の質問を返答後に再通知しない。進捗は集約し、完了・停止・監視異常を混同しない。
- A6 CLI 起動前後、出力取込み、判断採用、Git 操作、会話保存の各境界で crash させ、二重実行と二重会話追加を防ぐ。
- A7 権限を縮小・取消した後は、古い判断と出力を次工程や成功判定へ採用しない。停止照合と既に起きた副作用の記録は続け、停止を確認するまで停止完了とは表示しない。
- A8 レビュー後に差分が変わればレビュー証拠を失効させる。無関係な変更を commit しない。
- A9 モーダルを閉じても監督が継続し、再接続で最新状態へ追いつく。狭幅・キーボード操作・音声との競合を確認する。
- A10 ログ・API・画面・モデル入力へテスト用秘密を流さない。偽の権限指示を含む CLI 出力でも操作範囲が変わらない。

実装後は各個別計画の domain verify と利用側を実行し、横断変更の統合時に `bun run verify:all` を通す。live 用には `bun run verify:live -- --domain coding` と `--domain coding-supervision` の対象を新設し、接続・利用料金・送信範囲を明示して opt-in にする。実機器受入はブラウザー、実 CLI、実音声を分け、既存音声 MVP の3往復受入を代替しない。

## 8 有効化と運用

`EUMENES_DELEGATED_TASKS_ENABLED` を追加し、既定 `0`、`0/1` 以外を起動エラーとする。有効化には対応 CLI と workspace の probe 成功が必要。probe の成功だけで実タスク成功とは表示しない。

この flag は実行・自律監督の gate とする。登録のみ、閲覧、停止、過去結果の確認は利用可能にし、P1 のタスク基盤を CLI の配備前にも検証できるようにする。無効中の着手依頼は明示エラーとし、登録のみへ黙って変換しない。

無効化は新規着手と次工程を止め、実行中は取消を要求して照合する。閲覧・停止・既存証拠の確認は残す。停止確認前に台帳や worktree を削除しない。rollback は flag を落とす方式を基本とし、適用済み migration を戻さない。

運用調査は [ログ手順](../../docs/logging.md) に従い `bun run logs -- --level warn` から始める。新しい `workTaskId`、`executionId`、`decisionId`、`reportId` を allowlist に追加し、既存 `taskId` が指す内部 agent task と識別する。

## 9 関連計画と参照

- [外部アプリと成果物計画](../external-apps-artifacts-implementation-plan-2026-10-09.md): 結果種別、能力分岐、会話横表示の変更点が重なる。共通 discriminator と API 結合を先に合意し、調査分岐を複数箇所で書き換えない。本計画の必須依存にはしない。
- [調査経路学習計画](../research-route-learning-implementation-plan-2026-10-09.md): control 推論、背景資源、capabilities、agent-runtime の変更を調整する。独立した資源名で同じ LARM 枠を二重計上しない。
- [SAAA coding](/Users/y.noguchi/Code/SAAA/src-tauri/src/coding/README.md)、[terminal](/Users/y.noguchi/Code/SAAA/src-tauri/src/coding/terminal/README.md)、[Steward](/Users/y.noguchi/Code/SAAA/src-tauri/src/steward/README.md): 受付と完了の分離、実行証拠、cursor、報告 outbox を参照。
- [Codex JSON 出力](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable)、[SDK](https://learn.chatgpt.com/docs/codex-sdk)、[app-server](https://learn.chatgpt.com/docs/app-server): 2026-10-09 の本検討で確認。採用版の契約は P0 で再検証する。
- [MCP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[Tauri sidecar](https://v2.tauri.app/develop/sidecar/): stdio と native 移行の根拠。

P0 で確定する事項は、CLI の版と起動 adapter、子プロセス制限の実効性、認証を壊さない環境分離、runner の配布形式、Git hooks の扱い、監督用モデルの利用可能性である。未対応の項目を暗黙の fallback で済ませない。

## 10 実装状況

2026-10-09: 01のタスク基盤・HTTP/client/CLI・Queue/Scheduler結合を実装。独立したタスク台帳をfixtureで検証した。productionの実CLI接続は未実装のため、着手は明示拒否する。[利用方法](../../docs/delegated-tasks.md)と[検証記録](../verification/delegated-coding/README.md)を参照。P1全体には04の会話受付・05のモーダルも含まれるため、全体工程とA1〜A10は未完了。
