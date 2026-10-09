# CLI 実行と MCP 接続の実装計画

作成日: 2026-10-09 JST。状態: 実装前。[全体計画](README.md) の P0、P2、P4、P6 を担当する。タスクと権限の共通契約は [01](01-tasks-and-queue.md) を参照する。

## 1 目的と構成

`coding` domain は実行意図、workspace、receipt、出力取込み、Git 証拠を所有する。CLI のプロセス管理は独立した `packages/coding-runner` に置き、backend は限定した MCP adapter 経由で呼ぶ。

初版の経路は「Web/製品 CLI → Eumenes HTTP API → coding → MCP stdio → runner → Codex CLI」。MCP はブラウザーへ OS 権限を与える機構ではない。runner と対象 repository は現在の backend と同じ PC に置く。

runner package は protocol と実行コア、MCP façade、CLI adapter、worker entry を分ける。import だけではプロセスを起動しない。製品 DB や上位 domain を import しない。backend との共有型は package の純粋な contracts export に置き、境界検査へ明示的に登録する。

将来の Tauri は同じ実行コアを sidecar として起動し、必要なら MCP façade を通さない native adapter を作る。タスク状態・権限・報告の意味は変更しない。初版で Rust へ再実装しない。

## 2 採用する CLI adapter

最初の候補は `codex exec --json` と、明示 session ID を用いる続行。既存 SAAA の terminal adapter と公式 JSON 出力仕様を参照する。起動引数・終了・sandbox・質問・再開が採用版で成立するか P0 の契約 fixture と実 CLI で確かめる。

exec で処理できない対話中の質問・承認を必要とする場合は、対応可能性を確認した app-server adapter を採用する。app-server は MCP ではなく固有の JSON-RPC 契約である。旧 `codex mcp-server` は利用しない。公式資料上の実験的な機能や transport を安定契約として扱わない。

起動中の CLI への追加指示は adapter が正式に対応する操作だけにする。初版の exec adapter は現在の turn と子プロセスの終了を確認してから、保存した同じ session ID を指定して再開する。`latest` や直近の無関係な session を探して再利用しない。

Claude Code は後続 adapter。構造化出力、質問、resume、停止、認証の契約試験を同じ suite に通してから有効化する。PTY の画面解析と任意の既存端末への接続は初版に含めない。

## 3 Workspace と実行権限

管理者がローカルの Git workspace と CLI executable を登録する。モデルから任意 path、executable、shell 文字列を受け取らない。workspace ID を canonical path、repository identity、許可対象へ解決し、起動前に symlink・別 repository への置換を再検査する。

初版は登録した repository の固定 base commit から専用 worktree と `codex/` branch を作る。元の checkout に未コミット変更があれば自動でコピーせず、基準を明示して確認する。利用者の既存変更を混ぜて消したり commit したりしない。worktree はセキュリティ境界ではないため sandbox を別に設定する。

永続 `coding_workspace_reservations` と runner の OS lock を併用し、同一 workspace への書込みを一件にする。Queue の短期排他だけに依存しない。別の利用者プロセスによる変更は diff/version の照合で検出する。

権限プロファイルは read、workspace edit、登録済み検証、限定ネットワーク、commit、push を分ける。実装・レビュー用 CLI に Git credential を渡さず、初版の commit/push は host が検証した専用操作を runner に依頼する。CLI に一般 shell があるため、単にプロンプトで push を禁止するだけでは不十分。sandbox、環境、credential helper/SSH agent、Git 共通管理領域、hooks、外部ネットワークの実効制限を P0 で試験する。

CLI 認証に必要な経路と開発コマンドのネットワークは区別する。選定 CLI の sandbox でこの分離が成立しない環境は対応済みとせず、隔離 worker 等を用意するか有効化を保留する。CLI 全機能を止めるような一律ネットワーク遮断を採用したことにしない。

同じホストにある Eumenes/SAAA の製品 DB、設定、秘密の directory とローカル API も実行側のアクセス対象から外す。専用 worktree を使うだけで読取りを制限できたとは扱わない。許可されたソース・ビルド環境と CLI 認証に必要な資源を列挙し、無関係な製品データへ到達できないことを P0 の必須試験にする。

環境変数は allowlist、認証は実行ホスト内で利用する。CLI 全体のユーザー設定を変更せず、実行単位で必要な設定を指定する。LARM credential を worker に継承しない。shell 文字列連結ではなく executable と argv を固定・検証し、長い依頼は stdin/限定ファイルで渡す。

## 4 Backend と runner の契約

下記は固定 allowlist として公開する MCP tool 案。プロトコル version、対応 adapter と機能を初期接続で照合する。未知 schema を動的に実行しない。

| Tool | 入力の中心 | 応答 |
| --- | --- | --- |
| `runner.probe` | 登録済み adapter/workspace ID | CLI 版、利用可能機能、準備状態。課金実行はしない |
| `runner.start` | operationId、executionId、検証済み実行仕様への参照 | durable receipt または照合が必要な状態 |
| `runner.inspect` | executionId、afterSeq、limit | 稼働状態、イベント、次 cursor、観測時刻 |
| `runner.continue` | 新 operationId、現在の execution/session、回答・指示参照 | 新しい実行の receipt。busy/古い版は再送しない |
| `runner.stop` | operationId、executionId、世代、理由コード | 停止要求の受付。停止完了とは別 |
| `runner.read_evidence` | executionId、許可済み evidenceRef、範囲 | 有界の資料と digest、切詰め情報 |
| `runner.git_operation` | operationId、登録済み操作仕様 | commit/push receipt または unknown |

業務向けの `coding.start/inspect/continue/cancel/answer` はこれらとは別の Eumenes の公開操作であり、監督がモデル入力として操作できる範囲を絞る。runner の実行仕様は backend が権限確認後に構築する。モデルが authorityEpoch、workspace path、nonce を直接決めない。

stdio の stdout は MCP メッセージ専用にし、CLI の stdout/stderr を混ぜない。protocol error、deadline、接続断、CLI 失敗を別の error code にする。MCP 通信の取消だけで CLI が停止したと判断しない。

通信は採用版の公式 MCP SDK を利用する方針とし、依存版と Bun 互換性を P0 で固定する。必要なら runner を Node 実行へ分離し、その配布依存を明記する。汎用 HTTP MCP とリモート接続は後続。導入時は認証、Origin 検査、到達範囲、接続先固定を追加する。

権限縮小時は backend が新規操作を直ちに拒否し、runner へ失効 epoch と停止要求を優先配送する。runner は新しい工程・Git 操作の開始直前に許可の有効性を確認する。既に受付済みの実行は停止まで副作用が発生し得るため、失効から停止確認までの残存効果を記録する。ネットワーク/プロセスをまたぐ取消を瞬間的な巻戻しとして説明しない。

## 5 長期実行の所有と復旧

MCP server の一回の呼出しが数十分待ち続ける構成にしない。server は実行専用 worker を起動し、worker が CLI の process group と子プロセスを所有する。MCP server が終了しても worker の記録を照合できるよう、実行ごとの非公開ディレクトリへ receipt とイベントを保存する。

起動手順:

1. backend transaction で task との束縛、実行意図、operationId、権限の版、workspace reservation、dispatch job を確定。
2. transaction 外で runner に要求。runner が operationId と仕様 digest の一致を検査し、同一操作を重複起動しない。
3. worker が exclusive lock、nonce、immutable spec、起動意図を fsync してから spawn。PID と開始時刻等の識別 receipt を追記。
4. backend は受付 receipt を保存し、dispatch job を終了。CLI 完了を意味しない。

spawn と receipt の間には原子的にできない隙間がある。記録が曖昧な場合は `outcome_unknown` として照合し、存在しないと断定して再起動しない。未知の PID を殺さない。PID、開始時刻、実行 identity、process group を確認して停止する。

worker は絶対期限と host lease を持つ。初期案は host heartbeat 15秒、lease 120秒、停止猶予5秒。host heartbeat は観測・監督推論と別に送り、LLM 枠待ちで切れないようにする。host 不在・lease 失効時は worker 自身が停止・出力回収を行い、receipt を残す。正常終了も取消を要求し、確認できなければ次回照合対象にする。

再起動時は旧実行を新しい MCP server から照会する。生存 worker を再登録する場合は identity と lease を検証する。停止済み・確認済みの実行は記録だけ採用し、不明なものは reconciling に残す。新しい作業を自動再送しない。

## 6 Text とイベントの取込み

CLI の stdout/stderr は worker が常時 drain する。毎分処理は保存済みイベントを読む処理であり、stdout の読取りを60秒ごとに止めない。

`CodingEvent` は `executionId / generation / seq / observedAt / kind / payloadRef / payloadDigest` を持つ。kind は message、command_started、command_finished、file_changed、question、turn_finished、process_exited、error、heartbeat 等。provider event の名前・終了意味は adapter が正規化する。公開される説明文だけを扱い、非公開の内部推論取得を前提にしない。

実装要件:

- UTF-8 の分割、JSON 行の途中、stdout/stderr の別 stream、終了直前の残りを扱う。途中行を確定イベントとして採用しない。
- 一行上限1 MiB、実行ごとの資料上限20 MiB、全体200 MiBを初期案とする。stdout を詰まらせず、上限時は本文を保存せず drain し、証拠欠落を明示して停止する。
- seq と cursor を採用記録と同一 transaction で保存。重複イベントを二重に処理せず、欠番・digest 不一致を監視異常にする。
- 一度に最大100イベント/256 KiBを取得。続きがある場合は観測 job で分割し、毎分 tick を待たず backlog を処理する。
- provider の文章は未信頼データ。制御状態や権限変更は文章中のキーワードで確定しない。

保存先は DB 隣の `coding-runs/<executionId>`、directory 0700/file 0600。通常の `api.jsonl` へ生出力を流さない。必要な文章は許可フィールド抽出・既知秘密の除去を行った専用作業資料として保存し、非公開の運用情報として扱う。完全な秘密検出を保証せず、取得権限・保持・モデルへ渡す範囲を制限する。認証情報と Provider 生応答全体は保存対象にしない。

ユーザー向け出力ビュー、監督への入力、メインへの報告で取得範囲を分ける。CLI 表示は ANSI/制御文字を処理し、HTML として実行しない。資料の期限切れや切詰めがある場合は完了証拠が十分かを再検査する。

## 7 完了証拠と Git 操作

turn 終了と process 終了を別に保存する。背景の子コマンドが生存したままレビューや Git を開始しない。agent の「完了」は候補であり、host が下記を確認する。

`WorkspaceSnapshot` は repository/worktree identity、base SHA、HEAD、追跡済みと未追跡の対象ファイル、削除、mode、内容 digest を含む。ignored な成果物が完了条件に含まれる場合も個別に記録する。`git diff` だけで未追跡ファイルを見落とさない。

試験 receipt は事前登録した check ID、argv、cwd、環境方針、対象 snapshot、終了状態、出力 digest、時刻を保持する。試験がファイルを書き換えたら新しい snapshot を採り、レビュー対象との差を解消してから進む。CLI が検証コマンドを自己都合で弱めた結果を採用しない。

レビューは固定した snapshot を別 session へ渡し、読み取り主体で実行する。レビュー中の編集は禁止する。変更が生じたら結果を失効させる。指摘対応後は新 snapshot で再検証・必要な再レビューを行う。

commit は許可ファイルを明示して stage し、index の tree と承認された snapshot の一致を検査する。無条件の `git add .` は使わない。hook が変更を加えたら再検証し、hook の停止・実行を無断で切り替えない。commit SHA と実際の tree を証拠にする。

push は登録済み remote と branch、送り出す commit SHA、期待する remote の基準を固定する。fast-forward の通常 push だけを初版対象とし、force、mirror、tag、別 branch を拒否する。送信先 URL の認証部分を表示しない。成功表示は remote ref と送信 commit の照合後。remote が先へ進んでいる場合は到達関係まで確認できなければ結果不明として扱う。

commit/push の応答が途切れたら、履歴・tree・remote ref と保存した操作仕様を照合する。自動で同じ shell を再実行しない。CLI に commit/push を直接委任する将来 adapter も同じ証拠を要求する。

## 8 変更対象と工程

新規 `api/domains/coding/{contracts,repository,service,controller,adapters,test}/`、`packages/coding-runner/{src,test}/`。テーブル案は `coding_workspaces / coding_workspace_reservations / coding_executions / coding_operations / coding_event_cursors / coding_evidence`。CLI session・PID・nonce は一般の一覧へ露出させない。

C1: protocol と fixture process。C2: MCP 接続・start/inspect/stop。C3: spool と復旧。C4: workspace・環境・権限制御。C5: 出力・質問・正確な session 続行。C6: 検証・レビュー snapshot・Git。C7: live と配布確認。

## 9 検証と完了条件

package 試験を `coding` の verify に組み込み、`bun run verify -- --domain coding`、利用側 `coding-supervision`、`bun run verify:all` を実行する。

fixture では MCP client から server を起動し、tools/list、正常呼出し、未知 tool、不正引数、版不一致、通信取消を確認する。CLI は分割 UTF-8、部分行、巨大出力、無出力長時間、質問、背景子プロセス、異常終了を再現する。

起動の各境界、fsync 前後、cursor 保存前後、停止中、commit 後の応答欠落、push 後の応答欠落で fault を注入する。二重起動・二重 commit・不明 PID の停止が0件で、照合結果が UI と報告へ反映されることを要求する。

隔離 repository と一時 bare remote で未追跡ファイル、他人の変更、hook の変更、レビュー後の変更、non-fast-forward を試験する。テスト用 credential を含む出力や偽の完了文でも権限・証拠を偽造できないことを確認する。

live は登録済み CLI の版・モデル・認証方式・実行ホストを記録し、実装→試験→レビュー→修正→commit→隔離 remote への push を通す。fixture 成功、CLI 起動 probe、実課金での成功を別に記録する。
