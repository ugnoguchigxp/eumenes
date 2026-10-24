# CLI実装・検証（2026-10-24）

## 目的・範囲・完了条件

合意済みのCLI設計P0〜P3を実装し、一覧からの画面起動、手入力、再接続、会話からの一件ずつの実行、終了コードと出力の通知を接続する。PTY・SSE・バックログ・Webの端末接続・OpenUI・DesignSystemは既存機構を再利用する。追加domainは `shell`。既存のClaude Codeの責務、認証、LLMによる依頼解釈を変えない。

サーバー操作は利用者が許可しなかったため、起動・停止・再起動は行っていない。ブラウザE2Eと実LLMによる自然言語受入P4は未実施。製品DBの新規登録・現在の画面への反映も未確認。通常のbackend初期化でmigrationとbundle seedが登録される実装を、隔離DBのサーバー構成試験で確認した。

## 接続と登録

`cli_command` → `toolchain:cli.run@1` → `package:cli.run@1` → `binding:cli.run@1` → `adapter:shell@1` の `shell.run` → `shell_runs` → commit後のPTY → 終端commit → dialogue通知。

登録定義: `profile:cli.run@1`、`skill:cli.run@1`、`tool:cli.run@1`、`package:cli.run@1`、`toolchain:cli.run@1`、`binding:cli.run@1`、`artifact:cli.workspace@1`、`schema:shell-session-id@1`。入力 `builtin:cliRun`、結果 `domain:shell.run-receipt@1`、projection `projection:shell.run-result@1`。画面source `shell` → `query:shell.sessions@1`。公開入口「CLI」は隔離DBの一覧APIで確認した。

## 検証結果

| 段階 | 実行・条件 | 結果 |
| --- | --- | --- |
| 変更前 | `bun test api/domains/terminals/test` | 58成功・失敗0 |
| 部分・実PTY | shellの12試験。commit gate、rollback、replay・conflict、FIFO、出力・終了コード、期限・停止、回復、保存失敗、保持期限、SSE・手入力・再起動、ANSI・Unicode・容量 | 成功。`/bin/sh`の実PTYで `actual-pty` と終了コード3を取得。APIソケットは開いていない |
| 横断gate | `bun run verify -- --domain shell --domain terminals --domain capabilities --domain dialogue` | 495成功＋Web19成功。境界・SystemContext・サイズ・書式・lint・DesignSystem型/build・型検査成功。入力整合も成功。run `2026-10-24T11-38-19-764Z-c5363e31-5ee0-4258-97e9-1d5b4f29e72f` |
| 最終修正後gate | `bun run verify -- --domain shell --domain terminals` | 70成功＋Web8成功。run `2026-10-24T11-40-09-193Z-43ec9971-4783-494e-8863-ed88650e6e6d` |
| host結合 | CLI結合・既存Claude Code結合/adapter/通知・全bundle seed・server lifecycleの6ファイル | 17成功。固定モデル→CLI→PTY→確定保存→通知まで確認。サーバー構成試験はサービス組立てのみでlistenしない |
| 最終CLI結合 | `bun test api/application/shell/cli-toolchain.test.ts` | 2成功。受付は `completed:false`、結果は出力と終了コード。executionの非0終了・取消も確認 |
| 画面結合 | CLI画面＋共通端末接続＋Claude Code hookの3ファイル | 10成功。登録adapter、source API、CLI起動API、専用文言、共通Renderer、SSE再接続を確認。jsdomのcanvas未実装警告があり、実描画は未確認 |
| 全体型・静的build | `bun check`、`bunx vite build` | 型2,419ファイル成功、Web build成功。buildには既存のchunkサイズ・backgroundのdynamic import警告あり |
| 登録検査 | `bun run toolchain:bundle -- check api/domains/capabilities/bundles/cli.bundle.json` | 成功。隔離DBに同内容登録済みとして確認 |
| 今回の差分 | 変更対象のlint、追加20ファイル範囲のsize budget、`git diff --check` | 成功 |
| ブラウザ | `bunx playwright test --list tests/browser/cli.spec.ts tests/browser/claude-code.spec.ts` | 2試験の読み込みのみ成功。fixtureサーバーを起動する実行は未実施 |

artifact domainまで含むgateは、今回変更していない `packages/artifact-ui/src/composition-fixer.ts`（827行）、`contracts.ts`（818行）、`ui-studio-components.tsx`（974行）の既存サイズ超過で停止した。これらの要件・期待値・制限は変更していない。変更した `terminal-components.tsx` は個別のsize/lint・全体型・画面結合・Web buildで確認した。

## 介入と最終点検

3ラウンドのgate確認で依存境界、既存サイズ超過、lint指摘を分離した。画面結合試験はworkspaceへ移動し、制御文字拒否のlint抑制コメント位置を修正した。既存サイズ超過を回避するための製品変更や検査基準変更は行っていない。

差分点検で、待機中の次依頼がある場合の状態表示漏れを修正した。さらに「停止未確認の実行を再照会するとfinalになる」「一chunkがバックログ上限を超えるとライブ出力も切れる」の2事象を回帰試験で失敗として再現し、修正後2成功を確認してから最終gateを通した。語句・個別例に応じた製品分岐や固定回答は追加していない。専用処理は合意済みのシェル実行、台帳、安全な状態確定、端末仕様に限定した。

作業開始時から存在する差分、および他の同時作業によるcontinuity・dialogue・voice・LARM・DropdownMenu・設定・文書・CSSの差分は保持した。別チャットへの送信、branch作成、commit/pushは行っていない。

## 残作業と続行条件

- backendへの反映には通常の再起動・起動が必要。利用者のサーバー操作禁止を維持し、今回は行わない。
- 許可後に `tests/browser/cli.spec.ts` と `tests/browser/claude-code.spec.ts` を実行し、実描画、手入力、閉じて再接続、実行端末の追加と通知を確認する。
- P4は実LLM・ブラウザが使える条件で、次の固定受入を実行する。開始前に隔離プロジェクトの実際の状態を記録し、受付応答と完了応答を分けて照合する。

| 入力・操作 | 期待する観測 |
| --- | --- |
| 「git statusを見て」 | 一回実行、実終了コードと出力、会話への結果通知、同じ実行の端末 |
| 「作業ディレクトリを確認して」 | 登録プロジェクトのルートで実行、実出力に沿った回答 |
| CLI一覧から開き、手入力して閉じて再度開く | 同じセッションID、出力再送、操作継続 |
| コマンドの使い方だけを質問 | コマンド実行を新規に作らず説明する |
| 実行中にbackendが終了する | 次回起動で結果不明、待機は取消、自動再実行なし |

自然言語の選択精度・ブラウザの実描画・製品DBへの反映を、固定試験の成功だけで受入済みとは扱わない。
