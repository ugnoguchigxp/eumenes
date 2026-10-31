## Goal

Eumenes の評価（Technical 約65/100・Project 約55/100、いずれも暫定）を、必須次元から順に正式スコアへ近づける。土台の検証を回復し、音声 MVP の完成 gate を満たし、agent としての安全境界と再起動継続を固めたうえで、差別化（ハーネス自己改善）と導入・継続性を底上げする。

## Success Criteria

- クリーンな HEAD で影響 domain の検証が `result=pass` となり、永続記録に残る。作業ツリーの未説明差分がゼロ。
- 実マイク・ヘッドホンでの3往復受入（再生中割込み・失敗表示含む）が完了し、`docs/acceptance.md` の該当行が受入済みになる。
- 会話からのシェル実行に承認境界（または明示的に狭めた許可範囲）が入り、fixture 試験で担保される。
- 再起動をまたぐ仕事の継続が、実施済み操作と未完了部分を区別して再開できる。
- 会話ターン等の代表条件に性能予算と再実行可能な測定記録がある。
- README の実装表が現行コミットと一致し、未完了項目の範囲明示が維持される。

## Approach

順序は「土台 → gate → 安全と継続 → 差別化と普及」とする。先に検証・CI・状態表を直さないと、以後の改善が正式スコアに反映されない。設計判断方式や優先順位の新規導入は行わず、既存の domain 境界・検証規律・受入表の枠組みの中で実装する。大きな方式変更が必要になった時点で、本書を改訂して合意を取り直す。

前提（変更しない）: 推論は保存済み LARM 接続を正本とし、profile 名・モデル名をコードに固定しない。Web/CLI は API 経由とし DB を直接開かない。下位 domain は上位 domain を参照しない。

## Steps

### Phase 0: 土台の回復（工数 S 中心、先行必須）

1. 検証の再実行と記録の永続化
   - 現行の未コミット変更を整理したクリーンな状態で、影響 domain を選び `bun run verify -- --domain <name>` を実行する。全体が必要な場合は `bun run verify:all`（ブラウザ E2E は含まない）。
   - 結果を `spec/verification/` 配下の永続記録に残す（`verification-reports/` はローカル専用のため根拠にしない）。
   - 対象: 検証基盤（`scripts/verify.ts`）、記録置き場。コード変更は原則なし。

2. ローカル検証の運用固定（CI/CD は対象外）
   - 利用者判断（2026-10-31）により CI/CD の自動実行化は行わない。`.github/workflows/verify.yml` は現行の手動起動のままとする。
   - 代わりに、変更のたびに影響 domain の `bun run verify` をローカルで実行し、結果を永続記録に残す運用を本書の Validation Plan で固定する。

3. README 実装表の現行化
   - Phase 0-1 の検証結果を反映し、表の日付と対象コミットを HEAD に合わせる。未完了項目（参照画像編集、計算の通し受入、再起動継続、自己改善、dots/Codex 受入）は範囲外として明示を維持する。
   - 対象: `README.md` の「現在の実装と利用条件」表。

### Phase 1: 完成 gate と安全境界

4. 音声の実機器3往復受入
   - 実マイク・ヘッドホンで3往復、再生中割込み、機器喪失・失敗表示を確認し、各 turn/run と機器条件を記録する。コード変更は不具合が見つかった場合のみ、該当 domain（voice-dialogue/audio/dialogue）に限定する。
   - 記録先: `docs/acceptance.md` の状態表と `spec/verification/` の受入記録。これは自動化できない手動 gate とする。

5. 会話シェル実行の承認境界
   - 会話からの CLI コマンド実行（現行は承認なし）に対し、確定操作と同型の承認フローを入れる。代替案として「登録プロジェクト内の読み取り系コマンドのみ許可」への限定も比較し、利用頻度とリスクで選ぶ。既定は承認フローとする。
   - 対象: shell domain の実行経路と会話側の確認対話、PTY への環境変数分離（LARM 資格情報を渡さない現行規律）は維持する。

### Phase 2: 継続性と測定

6. 再起動をまたぐ仕事の継続
   - 実行中だった会話生成・担当の仕事を、再起動後に実施済み操作と未完了部分を区別して再開する。現行の「中断として記録し自動再開しない」扱いを置き換えるため、queue/scheduler と各実行台帳の所有 domain で再開条件（冪等性、取消済みの不採用）を設計してから実装する。
   - 対象: queue、scheduler、dialogue/agent-runtime の実行台帳。単一 writer の transaction と公開操作の規律を守る。

7. 性能予算と測定の定常化
   - 代表条件（会話ターンの初回表示、TTS 開始、担当検索）を選び、予算値と測定手順を `docs/` に定義する。既存の個別疎通記録（ms 実績）を土台に、再実行可能な測定として残す。
   - 対象: 測定スクリプトと docs。予算超過時の扱い（警告に留めるか gate にするか）は初回測定後に決める。

### Phase 3: 差別化と普及

8. ハーネス自己改善の最小経路
   - 改善候補の生成から、期限付き試験運用、本採用・棄却、切り戻しまでを、実際の候補1件で通す。既存の試験・評価・実行記録を入力とし、全自動の無人改善にはしない。
   - 対象: steward/eval 周辺の既存基盤。新規 domain は作らず、既存の所有境界に収める。

9. 導入摩擦の低減
   - クリーン環境で初回起動から会話成立までの手順と所要を実測し、失敗時の復旧案内を設定・セットアップ文書に足す。前提（Bun 1.4.4、LARM 接続保存）自体は変えない。
   - 対象: `docs/setup.md`、`docs/settings.md` と設定画面の案内文。

10. 継続性の文書化
    - リリース手順、障害対応（`bun run logs` から runId/jobId で追う手順）、DB と鍵の保全、検証の回し方を、第三者が追える形にまとめる。
    - 対象: `docs/` の運用文書。新規ツールや体制変更は含めない。

## Validation Plan

- Phase 0: `bun run verify -- --domain <影響domain>` の結果が pass で、永続記録と一致すること（CI/CD は対象外のため、ローカル実行の記録をもって確認とする）。
- Phase 1: 音声は実機器受入記録（turn/run、機器、割込み、失敗表示）で確認する。シェル境界は対象 domain の fixture 試験（承認なしでは実行されないこと、承認後のみ実行されること）で確認する。
- Phase 2: 再起動継続は、実行中に backend を再起動し、実施済み操作が二重実行されず未完了部分が再開される試験で確認する。性能は定義した手順の再実行で予算との比較記録を残す。
- Phase 3: 自己改善は候補1件の全工程記録、導入はクリーン環境での成立記録で確認する。
- 各 Phase の終わりに、影響する利用側 domain も含めて `bun run verify` を再実行し、fixture / live / 実機器の結果を分けて記録する。

## 実施記録（2026-10-31）

- Phase 0-1（検証の再実行）: `bun run verify -- --domain shell --domain capabilities --domain dialogue` を実行。静的検査（inventory・boundaries・system-context・size-budget・sql-boundaries・domain-docs・format・lint・design-system・typecheck）は全て pass、bun tests は 539 pass / 1 fail。失敗は `api/domains/shell/test/shell.test.ts` の実 PTY 試験の timeout で、サンドボックス内では PTY を開けないことが原因（最小再現で `Failed to open PTY`）。サンドボックス外では同試験が pass（37〜40 ms）し、shell domain 単独の verify でも試験は全て pass した。全体の verify は並行作業で検証中にソースが変わったため `invalidated` となり、クリーンな状態での再実行が残る。
- Phase 0-2（CI/CD）: 利用者判断により対象外。ワークフローは変更していない。
- Phase 0-3（README）: CLI 行を確認（承認）ありへ更新。表の日付は各行の記載日を維持し、全体の再検証は音声受入後に行う。
- Phase 1-4（音声実機器）: 未実施。実機器・利用者の立ち会いとサーバー操作の許可が必要な手動 gate のため、自動では進めない。
- Phase 1-5（シェル承認）: 実装済み・固定試験済み。toolchain `cli.run@3` に `minImpact: modify_existing` を新 revision で追加し、既存の委任確認に乗せた。新規の承認機構は作っていない。`bun run toolchain:bundle -- check` と `api/application/shell/cli-toolchain.test.ts`（承認前は起動・保存されないこと、登録実行は従来どおり動くこと）で確認。
- Phase 2-6（再起動継続）: 利用者判断（2026-10-31）により実施しない。設計書 [restart-continuation-design-2026-10-31.md](restart-continuation-design-2026-10-31.md) は判断の記録として残す。現行の扱い（会話生成は中断、shell は自動再実行しない）を維持する。
- Phase 2-7（性能予算）: `docs/performance.md` を追加（暫定予算と測定手順）。達成の判定は今後の live 測定で行う。
- Phase 3-8（自己改善）: 合意・実装済み（2026-10-31、形を変更）。自動起票と台帳は採用せず、ツールチェーン項目として実装した。`terminals-screen.bundle.json` に `profile:claude-code.repair@2`・`skill:claude-code.repair@2`・`package:claude-code.repair@2`・`toolchain:claude-code.repair@2`（会話関数 `repair_error`）と `binding:claude-code.repair@2` を追加し、既存の `tool:claude-code.request@2` と `adapter:terminals@1` の操作へ接続した。`minImpact: modify_existing` で実行前の確認が必須。接続は repair_error → package:claude-code.repair@2 → binding:claude-code.repair@2 → adapter:terminals@1 の `claude-code.request` → terminals domain → artifact:terminals.workspace@2。作業は分析と実装の2回に分ける（独立レビューの指摘で改訂）。固定試験は `capability-seed.test.ts`（登録と minImpact）と `claude-code-toolchain.test.ts`（確認前は何も始まらないこと）で、合わせて6件 pass。`bun run verify -- --domain capabilities --domain terminals --domain dialogue` は静的検査 pass、試験 585 pass / 1 fail で、失敗はサンドボックス内で PTY を開けないための実 PTY 試験のみ（サンドボックス外では pass を確認済み）。Claude Code の実実行（live）と自然言語受入は未実施。
- Phase 3-9（導入摩擦）: `docs/setup.md` に「うまくいかないとき」を追加。クリーン環境での成立所要の実測は未実施。
- Phase 3-10（継続性）: `docs/operations.md` を追加し、`docs/README.md` の索引へ登録した。

## Risks / Open Questions

- Phase 2-6（再起動継続）は実行台帳と冪等性に触れるため、設計を先に固める。方式の判断が必要になった場合は実装前に本書を改訂する。
- Phase 1-4（音声受入）は実機器と利用者の立ち会いが必要で、自動化できない。日程は機器条件の確保に依存する。
- Phase 1-5 の承認方式（毎回承認か、範囲限定か）は利用頻度との trade-off がある。既定は承認フローとし、運用後に見直す。
- 本書の対象外: 参照画像編集、計算の会話通し受入の完成、dots/Codex の最終受入。これらは別計画で扱い、本書の Success Criteria には含めない。
