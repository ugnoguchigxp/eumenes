# 品質ガードレール適正化・軽量化・運用持続可能性 改善計画書

- 日付: 2026-11-22
- 状態: 第3稿・利用者合意済み（2026-11-22、§6 論点 1〜9 の推奨案で承認）・合意範囲すべて実装・fixture 検証済み（§8 に実施記録。個別設計書へ分離した 6 項目 `O1`/`O3`/`P1x`/`P3`/`M1`/`M2` および随時 `S3` のみ対象外）
- 第3稿の変更点（2026-11-22、レビュー指摘 6 件および第2稿精査 4 件を実コードと照合して反映）:
  - **`G1`・`G2`・`G6` の失敗条件統一と入力固定の分離**: `G2`（`fixed-names`）も既存の `verification-static.ts` の `partition()`（選択範囲内のみ失敗・範囲外は警告）に揃え、共有組立てファイルの所有者と失敗させる domain を明示設計とした。また「違反の扱い」と「並行編集による `invalidated` 防止」を別の完了条件へ分け、[固定コピー手順](../../docs/verification.md#並行作業中の固定コピー) を明記した。無効な例示 `--domain agency` を実在する `--domain dialogue` 等へ修正した。
  - **`G4` の安全な縮小更新**: 現行 `size-budget.ts --write` が新規超過や増加まで全上書きする欠陥を踏まえ、通常の更新は既存エントリの縮小・解消のみを対象とし、新規超過・増加を取り込まない回帰試験を完了条件に加えた。
  - **`P1` の削除候補化と `G3` の Live2D 別契約**: 未使用 `.tgz` 20 本のうち、`vendor/agency/manifest.json` の `derivedFrom`（1 本）と `docs/memory.md` の指定（2 本）を照合してから削除一覧を確定する手順へ変更した。`G3` では npm tarball 12 系統と `assets.json` 管理の Live2D の照合条件を分けた。
  - **`O2` の削除範囲の実測適合**: 現行 `pruneVerificationReports()` が `runs/`（20 件・実測 3.2 MB）と `nl-acceptance/`（5 件・84 MB）をすでに整理していること、実容量の主因が個別調査ディレクトリ（最大 164 MB）であることを反映し、既存整理の再利用＋全体内訳・回収見込み表示（dry-run）→保持条件決定の順へ変更した。
  - **`B0`〜`B3` の固定コピー・初回操作計測・EUM010 改定**: 手元 `dist-web`（2026-11-09、359 KB）と 2026-11-17 検証（独立コピー・adapter 分割後 343.7 KB）を区別し、`B0` は固定コピーで実施する。容量だけでなく初回チャット入力・初回 Artifact 表示時間も同一条件で前後比較し、旧上限超えで再記録する場合は EUM010 の完了条件変更まで合意事項（§6 論点 3）に含めた。
  - **`R3` の候補取得元・異常系・`G2` との順序**: catalog のサービス識別子と生成 POST の `model` が別である現行契約を踏まえ、候補値の取得元と「候補ゼロ／取得失敗／選択後消失」時の振る舞いを確定してから `G2` の必須化と接続する順序にした。
  - **その他整合修正**: §5 ロードマップと §6 論点（1〜9）の 1 対 1 対応（`G4-2` を Phase 1 へ明記等）、`G5-1` の `verify` 除外と生 `bun test` の `./` 明示の書き分けを修正した。
- 第2稿の変更点（2026-11-22、第1稿を実コードと照合した結果）:
  - 初期 JS 肥大の原因を「design-system の単一バレル」とした診断を取り下げ、内訳調査 `B0` を先に置いた（§1.2-2、§3.4）。
  - `G1` から `git diff` による失敗判定を外し、`domains.ts` への明示所有だけにした。
  - 別計画が編集中のファイルに触れる項目（`S1` の agency 分、`R2`、`S3` の旧 host、`M3`）を、その計画の完了条件へ移した。
  - `vendor/` の系統数を 15 から 13 に訂正した。
  - 設計が 2〜5 行しかない `O1`・`O3`・`P1`（seeds 分離）・`P3`・`M1`・`M2` を本計画の合意対象から外し、個別設計書を起こす候補とした。`M2` の `packages/` 昇格基準は取り下げた。
  - `G4` の新しい運用ルールと `check:guards` の並行作業時の扱いを合意事項に加えた。
- 対象領域: ガードレール基盤（`scripts/`・`bunfig.toml`・`knip.json`）、サイズ予算、規約テスト、初期JS容量（`packages/design-system`・`client/`・`web/`）、運用保全、配布物・`vendor/`・`spec/`、ドメイン長期保守体制
- 位置付け: 2026-11-22 のプロジェクト多角評価で顕在化した6領域（サイズ予算、規約テスト、初期JS容量、運用性、配布性、持続可能性）と、それらを継続的に守る**ガードレール基盤の適正化**を一体で計画化する文書。
- 関連文書:
  - [Eumenes 全体課題一覧](../project-issues-2026-11-06.md)（EUM010・EUM026・EUM028・EUM029・EUM031・EUM032・EUM033）
  - [会話エージェントのトークン効率改善と技術的負債解消 実装計画書](../.todo/conversation-agent-token-efficiency-and-debt-plan-2026-11-22.md)（`D1`・`D4`・`D5`・`E2` と協調し重複実装しない）
  - [技術評価の改修計画書](review-remediation-plan-2026-10-31.md)（A6・B3 の再蓄積分を本計画へ統合）
  - [計画3 Web・音声・検証 検証記録](../verification/grok-plan-3-web-voice-verification-2026-11-17.md)（2026-11-17 時点の初期 JS 実測）
  - [検証とログ](../../docs/verification.md)（固定コピー手順・現行の静的検査範囲・世代管理）

---

## 0. 不変条件と作業規則（変えないもの）

本計画のすべての項目は、既存の契約・安全境界・作業方針を緩和しないことを前提とする。

| 項目 | 不変条件 |
| --- | --- |
| CI の扱い | [全体課題一覧](../project-issues-2026-11-06.md) の方針に従い、GitHub Actions の push/PR 自動必須化は対象外とする。本計画のガードレール適正化は**手元での高速・確実な検証体験**に集中する。 |
| 基準値の不自然な緩和禁止 | `size-budget`・`fixed-names` の上限やルールを機械的に緩めて緑化しない（EUM027 と同原則）。`bundle-budget` の扱いは、利用者の 2026-10-17 の判断（容量は重視せず基準を再記録する）と EUM010 の完了条件（機械的に増やして閉じない）が食い違うため、§6 の論点 3 で EUM010 完了条件の改定要否を含めて決める。 |
| モデル名・profile 名の非固定 | LLM・音声・画像・音楽の profile 名・モデル名はコード・bundle・手順書に書かず、SQLite 保存設定と LARM catalog から実行時に取得する（明示例外は `fixed-names.test.ts` の `decidedModelFiles` のみ）。 |
| 依存方向と SQL 境界 | `scripts/boundaries.ts`（tier・公開入口）と `scripts/sql-boundaries.ts`（450テーブル・許可1件）の既存水準を維持する。 |
| 調整と設計変更の分離 | 既存仕様・判断方式・外部契約を変えない「調整レベル」と、構造・契約・運用方針を変える「設計合意必須」を区別し、後者は合意後に着手する。 |
| サーバー・DB・秘密の扱い | サーバーの起動・停止・再起動は利用者許可なく行わない。実製品 DB・秘密鍵を検証へ複製しない。 |
| 並行作業との共存（違反扱いと入力固定の分離） | 同じ checkout を複数の作業が同時に編集する。他の作業が編集中のファイルを本計画の項目で分割・移動しない。静的検査では範囲外の違反で domain 検証を止めない（警告に留める）。一方、現行の `verify` は実行中に対象外の入力や共有 DesignSystem 出力が変わると結果を `invalidated` にするため、**並行編集下での確定検証は [固定コピー手順](../../docs/verification.md#並行作業中の固定コピー) で入力・生成物を分離して行う**。 |
| 外部化した研究 domain | 試行錯誤する domain を別プロジェクトで測り tarball で戻す現行方針を変えない。 |

---

## 1. 現状の定量診断（2026-11-22 実測）

2026-11-22 時点の作業ツリー（`HEAD: 1f6663d0`＋進行中の未コミット変更）での実測結果。第2稿・第3稿で `HEAD: dac16e45`＋未コミット変更に対し、`boundaries`・`size:check`・`vendor/`・`verification-reports/` 内訳・検査スクリプトの記述を再照合した（「再照合」列）。試験と Web のビルドは再実行していない。

### 1.1 静的検査・規約テストの現在状態

| 検査項目 | 現状 | 実測詳細 | 再照合 |
| --- | :---: | --- | --- |
| `bun run typecheck` | PASS | 3,462 ファイル・型エラー 0 件（633ms） | 未実施 |
| `bun scripts/sql-boundaries.ts` | PASS | 450 テーブル・許可済みクロスドメイン SQL 1 件・新規違反 0 件 | 未実施 |
| `bun scripts/domain-docs.ts --check` | PASS | `docs/domains.md` 整合済み | 未実施 |
| `bun scripts/boundaries.ts` | **FAIL (2件)** | 本番コード 0 件、テスト 2 件でドメイン公開入口を迂回 | 一致 |
| `bun run size:check` | **FAIL (9件)** | 既存ラチェット（1ファイル・23関数・3テスト）に加え新規／増加 9 件 | 一致（9 件。進行中の作業で行数は変動） |
| `bun scripts/bundle-budget.ts` | **FAIL** | 手元の古い `dist-web`（2026-11-09）で `entryGzip` 46,951 B、`initialGzip` **359,294 B**（上限 264,846 B）。2026-11-17 の独立コピー計測（adapter 分割後）では **343,662 B**（+78.8 KB 超過） | 11-17 記録と整合。最新版は未再計測 |
| `fixed-names.test.ts` | **FAIL** | `image-screen.bundle.json`（3行）、`docs/images.md`（1行）、`docs/larm.md`（2行）に `qwen` 混入。さらに `bun test` へ `./` 無し指定した際、`artifacts/` と `verification-reports/` 内の旧コピー 6 本が巻き込まれて実行・失敗 | 試験は未実施。検出パターンに `flux` 系が無いことは一致 |
| `fixed-input-size.test.ts` | **FAIL** | 作業ツリーで `settings.agency.runtime` の ZodError（`unrecognized_keys`） | 未実施。測定後に設定移行のコミット `c2bd4b9b` が入ったため要再測定 |
| `lint` (`oxlint`) / `context:check` (`s11tnext`) | **環境依存エラー** | `env: node: No such file or directory`（exit 127）。Bun 単体 PATH 環境で実行不可 | `node` が PATH にある環境では起きない |
| `deadcode` (`knip`) | **未統合** | `package.json` に存在するが `verify.ts` に未組み込み、`packages/design-system` も除外中 | 未実施 |

### 1.2 構造的ボトルネックの実測

1. **ガードレールの「割れ窓」を生む 3 つの構造的盲点**
   - **`api/application/**` が `verify --domain` で警告落ちする問題**: `scripts/verification-static.ts` の `inScope()` は選択ドメインの `ownedPaths` に含まれるファイルだけを失敗扱いとし、範囲外は警告に留める。`api/application/**` はどのドメインの `ownedPaths` にも属さないため、今回検出された `size-budget` 超過 9 件のうち **6 件** と `boundaries` 違反 **2 件すべて** が `api/application/**` で発生しながら、ドメイン検証では失敗せず素通りしていた。
   - **横断規約テストが `verify --domain` で走らない問題**: `integrationTestFiles()` は `api/application/*.test.ts` が対象ドメインを import しているかで選択するため、ドメインを import しない `fixed-names.test.ts` は `--all` 以外では一切実行されない。
   - **一部しか守っていない `vendor.test.ts`**: `vendor/` の実体は 13 系統（ほかに空ディレクトリ `evaluator`・`pursuit` が手元にあるが git 追跡外）。`vendor.test.ts` が照合しているのは 6 系統（`eumenes-memory`, `world`, `agency`, `steer`, `router`, `eumenes-memory-host`）のみで、`canvas`, `collaboration`, `interact`, `llm-fetch`, `pipeline`, `skill-smith`（以上 npm tarball 系 6 系統）および `live2d`（`assets.json` 管理 1 系統）の計 7 系統が未照合。依存宣言にない `.tgz`（追跡 33 本中 20 本）の残置も検出しない。

2. **初期 JS 容量の現状（11-17 検証と手元 `dist-web` の整理）**
   - 2026-11-17 の独立コピー検証（[検証記録](../verification/grok-plan-3-web-voice-verification-2026-11-17.md)）では、Web adapter の動的 `import()` 分割により `initialGzip` が **399,146 B → 343,662 B**（-55,484 B）へ削減されたが、上限 264,846 B に対して約 78.8 KB 超過したままである。その後の `DebugDiagnostic.tsx`・`MessageList.tsx` 等の変更は未再計測であり、初回入力や初回 Artifact 操作の所要時間も未計測である。
   - なお、手元 checkout の `dist-web`（2026-11-09 の古いビルド・359,294 B）で観測された `assets/markdownRenderer-*.js`（129,976 B gzip）や `assets/radix-*.js`（44,237 B gzip）は旧版の自動分割チャンクであり、第1稿の「design-system 単一バレルによる 110 コンポーネント集約」という診断は取り下げた。最新版の内訳は独立コピーでの `B0` 調査で確定する。

3. **リポジトリ・ローカル作業領域の肥大化**
   - git 追跡ファイル: 7,466 件 / 309 MB（`.git` 358 MB）。うち `spec/` **194 MB**（`.png` 150 MB、`.mp4`/`.gif` 9 MB）、`vendor/` **72 MB**（うち `vendor/skill-smith/seeds/ruri-catalog.sqlite` 46.5 MB と `.seed.sql.gz` 23.0 MB の二重保持が **67 MB**、依存宣言にない `.tgz` 20 本が 3.2 MB）。
   - ローカル未追跡領域: `verification-reports/` **500 MB**。現行 `pruneVerificationReports()`（`scripts/verification-run.ts:205`）がすでに `runs/`（20 件・実測 **3.2 MB**）と `nl-acceptance/`（5 件・実測 **84 MB**）を自動整理しており、残りの大半は `verification-reports/` 直下の個別調査ディレクトリ（最大 `tts-ack-latency-20261115` **164 MB**、`collaboration-integration-2026-11-05` 30 MB、`agency-shadow` 24 MB、`notification-sounds` 21 MB 等）。ほかに `artifacts/` に 2026-11-06 の検証用ソースコピーが残置。

---

## 2. 改善項目一覧と着手区分

| ID | 領域 | 項目 | 区分 | 関連 EUM / 計画 |
| --- | --- | --- | --- | --- |
| `G1` | ガードレール | `verify --domain` における `api/application/**` 警告素通りの是正（`domains.ts` への明示所有と共有組立てファイルの所有者定義） | **要設計合意**（論点 1） | EUM027 |
| `G2` | ガードレール | 横断規約検査（`fixed-names` 等）の `partition()` 統一実行化と検出パターン監査 | **要設計合意**（論点 2） | ― |
| `G3` | ガードレール | `vendor.test.ts` の 13 系統網羅化（npm tarball 12 系統＋Live2D `assets.json` 別契約）と未参照 `.tgz` の自動拒否 | 調整〜軽微設計 | EUM026 |
| `G4` | ガードレール | `size-budget` の安全な縮小専用更新・通知（回帰試験付き）と `bundle-budget` のチャンク内訳出力（新規追加禁止は論点 8） | 調整（1・3）＋**要合意**（2：論点 8） | EUM010・EUM027 |
| `G5` | ガードレール | `artifacts/` の検査除外・`.gitignore` 化（中身不変更は論点 6）と `node` 前提検査 | 確認つき調整（論点 6） | EUM029 |
| `G6` | ガードレール | 高速手元ゲート `check:guards` 新設（並行作業時は `--domain` 範囲指定：論点 7）と `knip` 監査の位置付け | 確認つき調整（論点 7） | EUM027 |
| `S1` | サイズ予算 | `api/application/**` 超過のうち agency 以外の 3 件の責務分割 | 調整 | ― |
| `S1x` | サイズ予算 | agency の超過 3 件（`always-on-host.ts`・`always-on-ports.ts`・`always-on.test.ts`） | **11-22 計画へ移管** | 11-22 `D1`・`D4` |
| `S2` | サイズ予算 | domain / design-system 超過 3 件の分割 | 調整 | ― |
| `S3` | サイズ予算 | 既存ラチェットの大型関数を、該当 domain の改修時に 1 件ずつ圧縮 | 調整（段階的） | ― |
| `R1` | 規約テスト | `boundaries.ts` テスト公開入口迂回 2 件の修正 | 調整 | ― |
| `R2` | 規約テスト | `fixed-input-size.test.ts` スキーマ整合回復 | **11-22 計画へ移管**（本計画は再測定のみ） | 11-22 `D4`・`E2` |
| `R3` | 規約テスト | 画像画面の固定モデル名除去（取得元・異常系仕様確定のうえ動的化） | **要設計合意**（論点 2） | EUM028 |
| `B0` | 初期 JS 容量 | 固定コピーでの最新ビルド内訳調査＋初回チャット・初回 Artifact 操作時間計測 | 調整（読み取り・計測のみ） | EUM010 |
| `B1` | 初期 JS 容量 | `B0` で見つかった、費用のかからない遅延読込みと前後比較 | 調整 | EUM010 |
| `B2` | 初期 JS 容量 | 構造を変える分割（`B0` 結果と論点 3 で実施決定した場合のみ） | **`B0`・論点 3 後に個別設計** | EUM010 |
| `B3` | 初期 JS 容量 | `bundle-budget.json` の基準値更新（`entryGzip` 含む）と EUM010 記録更新 | 調整（論点 3 決定後） | EUM010 |
| `O1` | 運用性 | DB＋忘却 journal＋メタデータ一体バックアップと復元検証コマンド化 | **個別設計書へ分離** | EUM013 |
| `O2` | 運用性 | 環境診断 `bun run doctor` と `verify:prune`（既存整理再利用＋全体内訳 dry-run＋個別調査ログ保持条件は論点 9） | 調整（調査表示）＋**要合意**（削除条件：論点 9） | 10-31 `B3` |
| `O3` | 運用性 | 検証時ビルド生成物の隔離強化（共有 `dist` 衝突防止） | **個別設計書へ分離** | EUM029 |
| `P1` | 配布性 | 依存宣言にない旧 `.tgz` 20 本の参照照合（`derivedFrom`・`docs/memory.md` 含む）と削除候補の確定・撤去 | **要確認・合意**（論点 4） | 10-31 `A6` |
| `P1x` | 配布性 | `vendor/skill-smith/seeds` 二重保持解消 | **個別設計書へ分離** | ― |
| `P2` | 配布性 | `spec/` 大容量バイナリの今後ルール策定（WebP 化・サイズ上限・外部退避） | **要設計合意**（論点 5） | ― |
| `P3` | 配布性 | 依存・脆弱性・ライセンス監査自動化（MIT と Live2D 等の分離）と導入プロファイル整理 | **個別設計書へ分離** | EUM026・032・033 |
| `M1` | 持続可能性 | `scripts/domains.ts` への保守ライフサイクル区分と受入鮮度メタデータ追加 | **個別設計書へ分離** | EUM028・031 |
| `M2` | 持続可能性 | `vendor/` 13 パッケージの更新手順の標準化（`scripts/vendor-sync.ts`） | **個別設計書へ分離** | EUM031 |
| `M3` | 持続可能性 | `retiring` コード（旧 `host.ts`・`context-keeper.ts`・旧 Router 等）の撤去 | **11-22 計画が実施**（本計画は撤去後の再計測のみ） | 11-22 `D4` |

「個別設計書へ分離」の項目は、本計画では方向だけを残す。本計画への合意はこれらの実装の合意にならない。着手するときは項目ごとに設計書を `spec/` に起こして合意を得る。

---

## 3. 領域別の詳細改善設計

### 3.1 ガードレール周りの適正化（`G1`〜`G6`）

現行のガードレール群は発想が非常に優れている一方、「誰がいつ実行し、どこで止めるか」の継ぎ目に盲点があり、違反が静かに蓄積する状態になっている。ここを適正化し、**「範囲内の違反は確実に止まり、範囲外・並行作業を不当に妨げない」**状態を作る。

#### `[G1]` `verify --domain` における `api/application/**` 警告素通りの是正（要設計合意・論点 1）
- **現状の問題**: `scripts/verification-static.ts` の `inScope()` では `api/application/**` がどのドメインの `ownedPaths` にも入らないため、たとえば `--domain dialogue` を実行しても、`api/application/agency/always-on-host.ts` や `api/application/server-services.ts` の `size-budget` / `boundaries` / `lint` / `typecheck` 違反がすべて `outside`（警告）扱いになる。
- **改善案**:
  1. `scripts/domains.ts` の各ドメイン定義に任意の `applicationPaths?: readonly string[]` を持たせ、`api/application/<subdir>` やファイルを domain が明示所有する（既存の `integrationTests` と同じ宣言方式）。`inScope()` は `ownedPaths` と同じ扱いで失敗対象にする。
  2. **共有の組立てファイル（`server.ts`, `server-services.ts`, `app.ts`, `migrations.ts` 等）の扱い**: 個別ドメインへ無理に押し込むと不自然な所有関係になるため、論点 1 で以下いずれかを決定する：
     - **案 A（推奨）**: `domains.ts` に共有組立て層用の所有区分（例：`application` または `server`）を明示定義し、その区分を指定した `verify --domain <共有区分>` および `verify:all` で失敗させる。各個別ドメインの `verify` では従来どおり範囲外警告として表示する。
     - **案 B**: 共有ファイルも含めて既存の個別ドメインへ 1 対 1 で割り当てる。
  3. いずれの案でも、`api/application/**` に未所有ファイルが残っていないことを `domain-docs --check` と同様の検査で失敗させる。
  4. `verify.ts` の完了サマリに「範囲外警告件数」を目立つ形で表示する。
- **採らない案**: `git diff` の変更ファイルを失敗対象にする方式。同じ checkout を複数の作業が同時に編集するため、差分には他の作業のファイルが混じり、並行作業との共存と両立しない。
- **完了条件（違反の扱いと入力固定を分離）**:
  - **違反の扱い**: `api/application/**` に未所有のファイルが無く、所有する domain（または共有区分）の `verify` で確実に検出・失敗し、無関係な domain の `verify` では警告に留まること。
  - **入力の固定**: 並行編集による `invalidated` の回避は違反の扱いとは別問題であり、確定検証時は [固定コピー手順](../../docs/verification.md#並行作業中の固定コピー) を用いて前後 hash 一致を確認すること。

#### `[G2]` 横断規約検査の `partition()` 統一実行化と検出パターン監査（要設計合意・論点 2）
- **現状の問題**: `fixed-names.test.ts` はドメインを import しないため `verify --domain` で一度も走らず、`qwen` 混入が放置された。また正規表現に `flux` 等の画像モデル系パターンがなく、`image-screen.bundle.json:179` の `flux-3-image-klein` を取り逃している。
- **改善案**:
  1. `fixed-names` の検査ロジックを `scripts/fixed-names.ts` として抽出し、`verify.ts` の静的ステップへ組み込む（実行時間 < 300ms）。
  2. **失敗条件の統一（`G1`・`G6` と同一基準）**: `scripts/verification-static.ts` の `partition()` をそのまま適用し、全リポジトリを走査しつつ **選択範囲内（`inScope()`）のファイルの違反だけを失敗、範囲外は警告** とする（`verify:all` では全件失敗）。これにより、たとえば `image-screen.bundle.json` の既知違反で無関係な `--domain timers` 等が止まる事態を防ぎつつ、所有 domain（`capabilities` 等）および `verify:all` で確実に止められる。`docs/` など特定 domain に属さない手順書の扱いは `G1` の共有区分または `verify:all` で捕捉する。
  3. `fixed-names` の検出パターン（`/\bflux[-_.\s]?\d/i` 等）の追加・監査は、`R3` の仕様確定・実装と順序を合わせて接続する（`R3` 未完のまま `flux` を足して無関係な作業を阻害しない）。
  4. `fixed-input-size.test.ts` は `dialogue` / `settings` / `steward` の `integrationTests` に明示登録し、関連ドメイン検証で必ず実行されるようにする。

#### `[G3]` `vendor.test.ts` の 13 系統網羅化と未参照 `.tgz` の自動拒否
- **現状の問題**: `vendor.test.ts` が 13 系統中 6 系統しか検証しておらず、依存宣言にない `.tgz` が 20 本残っていても通過する。また Live2D は npm tarball ではなく `assets.json` で管理されている（[vendor/live2d/README.md](../../vendor/live2d/README.md)）。
- **改善案**:
  1. **npm tarball 系（12 系統）**: `vendor/` 配下の全 `.tgz` について、`package.json`（`dependencies` / `devDependencies`）または明示的な来歴許可（`P1` で `derivedFrom` 実体保持と決めた場合のみ）のいずれかから参照されていることを検証し、未参照 `.tgz` があれば失敗させる。未照合の 6 系統（`canvas`, `collaboration`, `interact`, `llm-fetch`, `pipeline`, `skill-smith`）もテーブル駆動で共通契約（`manifest.json` または `provenance.json`、sha256、`package.json`・`bun.lock` 整合）を一括検査する。
  2. **Live2D（1 系統・別契約）**: `vendor/live2d/assets.json` を正本として、git 追跡対象の配布物（`vendor/live2d/framework.js`、`web/public/live2d/live2dcubismcore.min.js`、`web/public/live2d/shaders/` 等）の存在と SHA-256 を照合する。git 除外のローカルモデル（`web/public/live2d/hiyori/**`）は未配置環境で失敗させず、配置済みの場合のみハッシュ照合する。
  3. `vendor.test.ts` を `G1` で決める共有区分または関連 domain の `integrationTests` へ登録し、取りこぼしを防ぐ。

#### `[G4]` `size-budget` の安全な縮小専用更新と `bundle-budget` 診断詳細化
- **現状の欠陥**: 現行の `scripts/size-budget.ts --write`（L223-L236）は `measureAll()` の結果で `size-budget.json` を丸ごと上書きする。既存 1 関数を縮小した直後に `--write` を実行すると、別作業が持ち込んだ新規超過や増加（現在 9 件）まで基準値へ自動登録されてしまう。
- **改善案**:
  1. **`size-budget.ts` の安全な更新機構**:
     - 通常の更新（`--write`、または新設 `--ratchet` と `--write` の分離）では、**既存 `size-budget.json` に載っているエントリの縮小・上限未満への解消・削除済みファイル除去だけ**を反映し、新規超過および記録値より増加したエントリは決して取り込まない（違反が残っていればエラー終了するか、記録対象から除外して警告する）。
     - 記録値より一定割合（例：10% または 30 行以上）縮小したエントリ、上限未満に収まったエントリ、削除済みファイルの残存エントリを検出して縮小更新を促す通知（`RATCHET_NOTICE`）を追加する。
     - **回帰試験（必須完了条件）**: 新規超過ファイル・新規超過関数・既存より増加した関数が同時に存在する入力に対して通常の更新を実行したとき、**既存縮小・解消分だけが反映され、新規・増加は一切取り込まれない**ことをユニット試験で固定確認する。
  2. （要合意・§6 論点 8）`size-budget.json` への新規追加を原則禁止し、引き下げ専用にする運用をドキュメントに明文化する（明示的な例外フラグを残すかも論点 8 で決める）。合意が出るまで 1・3 だけを進める。
  3. `scripts/bundle-budget.ts` の失敗出力に、初期ロードに含まれるチャンクの **gzip サイズ上位 5 件** を併記する。

#### `[G5]` スナップショット混入防止と実行環境前提の適正化（論点 6）
- **改善案**:
  1. `scripts/verification-selection.ts` の `sourceFiles()` 除外リストに `"artifacts"` を追加し、`artifacts/` を `.gitignore` へ追加する（`artifacts/` は git 追跡外。中身の移動・削除は作成した作業の持ち主に確認してから行い、本項目では行わない）。
     - **効力の正確な範囲**: これにより `verify`・`test:inventory` 等の選択走査から `artifacts/` が除外される。一方、生の `bun test` は `.gitignore` 配下（`verification-reports/` や `artifacts/`）も部分一致で走査する仕様のため、単体試験を直接実行する際は既存の [検証手順](../../docs/verification.md#並行作業中の固定コピー) どおり `./path/to/file.test.ts` のように `./` 付きで明示指定する運用を維持する。
  2. `oxlint`・`s11tnext` が `#!/usr/bin/env node` に依存し `node` 不在環境で exit 127 になる問題について、以下を検証・整理する：
     - `bun x --bun oxlint` / `bun x --bun s11tnext` で Bun ランタイム直接実行が可能か確認する。
     - `oxlint` は安定版 Bun が `bun lint` を実行できるようになるまでのつなぎである（2026-11-03 の決定）。`bun lint` へ切り替えた時点でこの前提検査から外す。
     - Node が必須なツールについては、`scripts/verify.ts` の開始時に `node`（20.19+ / 22.12+）の存在をプリフライト検査し、`env: node: No such file or directory` ではなく明示的な環境要件エラーを返す。
  3. `bunfig.toml:7` の古いコメント（`There is no separate linter`）を実態（`oxlint` 使用中）に合わせて修正する。

#### `[G6]` 高速手元ゲート `check:guards` の新設と `knip`（deadcode）の位置付け（論点 7）
- **改善案**:
  1. CI が手動のみの運用下で手元の違反蓄積を防ぐため、テスト本体を回さず **10〜20 秒程度で完了する静的ガードレール一括コマンド `bun run check:guards`** を `package.json` に新設する：
     - `boundaries` + `sql-boundaries` + `size:check` + `fixed-names` + `domain-docs` + `format:check` + `lint` + `context:check` + `typecheck`（＋ビルド済み `dist-web` がある場合は `bundle:check` 参考表示）。
  2. **失敗条件の統一（`G1`・`G2` と同一基準）**: `verify --domain` と同じ `--domain <name>` 指定と `partition()` を共有し、選択範囲内だけ失敗・範囲外は警告とする。範囲指定なし（全リポジトリ失敗）を完了条件に使うのは、他の作業が止まっている時または [固定コピー](../../docs/verification.md#並行作業中の固定コピー) 内だけにする。
  3. `knip`（`bun run deadcode`）は誤検知の調整コストを踏まえ、まずは `check:guards` とは別の定期監査（または `--all` 時の警告レポート）として位置付け、`knip.json` の除外設定（特に `packages/design-system` と `retiring` コード）を段階的に適正化する。

---

### 3.2 サイズ予算の超過解消と再肥大化防止（`S1`〜`S3`）

- **`[S1]` `api/application/**` 超過のうち agency 以外の 3 件の分割（調整）**
  - `api/application/server-services.ts#buildServices`（500行）: 既に存在する `server-core.ts` / `server-media.ts` / `server-tasks.ts` / `server-world.ts` へ配分し、本体を 300 行未満へ戻す。着手時に `git status` でこのファイルが他の作業で変更中でないことを確かめる。
  - `api/application/app-development/workflow-web-records.ts#createWebRecords`（301行）: 整形・マッピング用純粋ヘルパーを抽出して 300 行未満へ。
  - `api/application/toolchain/toolchain.fixture.ts`（1,024行）: fixture をドメイン別ビルダーに分割して 1,000 行未満へ。
- **`[S1x]` agency の超過 3 件（11-22 計画へ移管）**
  - `api/application/agency/always-on-host.ts#createAlwaysOnHost`（474行）・`always-on-ports.ts#createAgendaPorts`（372行）・`always-on.test.ts`（1,288行）は、11-22 計画の `D1`・`D4` がいま編集しているファイルである。本計画では触らない。
  - 11-22 計画の該当 Phase の完了条件に「この 3 件が `size:check` を通る」を加えることを、同計画の合意の場で提案する（同計画の文書は本計画から書き換えない）。
- **`[S2]` domain / design-system 超過 3 件の分割（調整）**
  - `api/domains/agent-runtime/service/execution-commands.ts#executionCommands`（308行）および `api/domains/web-research/service/saved-bodies.ts#createSavedBodies`（308行）: ヘルパー関数抽出で 300 行未満へ。
  - `packages/design-system/src/components/ImagePicker/ImagePicker.tsx#ImagePicker`（402行）: 状態・操作ロジックを `useImagePicker.ts` に分離し、ビュー本体を 300 行未満へ。
- **`[S3]` 既存ラチェット 23 関数の計画的圧縮（調整・段階的）**
  - `api/application/agency/host.ts`（939行 / `createAgencyHost` 801行）の撤去は 11-22 計画 `D4` が実施中で、本計画の項目ではない。撤去後に `size-budget.json` の該当エントリが消えていることだけを確かめる。
  - 残る 500 行超の大型関数（`createAttitudeDataset` 618行、`createRunner` 578行、`createAudioController` 540行、`createMemoryService` 530行、`createLarmPlayground` 522行、`createInference` 520行、`createWebResearch` 507行、`useVoiceDialogue` 506行）は、該当ドメインに改修が入るタイミングで 1 件ずつ分割し、`G4` の安全な縮小更新で基準値を下げていく。

---

### 3.3 規約テストの緑化（`R1`〜`R3`）

- **`[R1]` `boundaries.ts` テスト迂回 2 件の修正（調整）**
  - `api/application/app-development/app-review.test.ts`（`../../domains/inference/service/attempt-work`）と `api/application/agency/note-input.test.ts`（`../../domains/dialogue/repository/agency`）を、公開入口・contracts・またはドメイン `test/` fixture 経由に書き換える。着手前に `git status` で他作業が編集中でないことを確認する。
- **`[R2]` `fixed-input-size.test.ts` の整合回復（11-22 計画へ移管）**
  - 失敗は 11-22 計画 `D4` の作業途中（`settings.agency.runtime` の撤去）で生じたもので、測定後に設定移行のコミット `c2bd4b9b` が入っている。原因の解消と `fixed-input-size.json` の確定は同計画（`D4`・`E2`）の作業である。
  - 本計画では、同計画の該当 Phase が終わった後に再測定し、残っていれば報告するだけとする。`G2-4` の `integrationTests` 登録は本計画で行う。
- **`[R3]` 画像画面の固定モデル名撤去と動的候補仕様の確定（要設計合意・論点 2）**
  - **現行契約の制約（[docs/larm.md:99](../../docs/larm.md#L99)）**: 画像生成では **catalog のサービス識別子** と **生成 POST (`POST /v1/images/generations`) で指定する `model`** が別である。音楽には `GET /v1/music/providers` があるが、画像については「生成要求に使える `model` 候補値をどこから取得するか」をまず現行 LARM 契約と `api/domains/image` / `larm` 実装から確定する必要がある。
  - **設計・実装の順序**:
    1. **取得元の確定**: LARM catalog / 接続応答（または画像用の provider 一覧 API）が生成要求に使える `model` 候補一覧を返すか確認する。返さない場合は、画面のモデル選択を「未指定（LARM 既定）のみ」に縮小するか、LARM 側の候補 API 契約を別途設計するかを利用者と決定する。
    2. **境界・異常系の仕様確定**: 以下の 3 条件における画面表示と送信動作を明文化する：
       - **候補ゼロ**: 既定（未指定＝LARM 既定で送信可）とするか、モデル欄を非表示／選択不可にするか。
       - **取得失敗（LARM 未接続・エラー）**: 固定フォールバックを一切入れず、取得失敗を表示したうえで未指定送信を許すか／送信を抑止するか。
       - **選択後に候補が消えた場合**: 送信前に最新候補またはエラー応答で拒否し、別モデルへ自動切替しない（[docs/larm.md:122](../../docs/larm.md#L122) の既存原則を維持）。
    3. **文書・bundle の更新**: `api/domains/capabilities/bundles/image-screen.bundle.json:166-183` から `qwen-image-2.1-turbo`・`flux-3-image-klein` を除去し、`docs/images.md:5` と `docs/larm.md:114-115` の手順記述を確定仕様に合わせて更新する（実測履歴は日付付き行または `spec/` へ移す）。
    4. **`G2` との接続順序**: `R3` の仕様確定・実装が完了してから、`G2-3`（`flux` パターン追加を含む `fixed-names` の強化と全緑確認）を完了とする。

---

### 3.4 初期 JS 容量と初回操作性能（EUM010：`B0`〜`B3`）

2026-11-17 の独立コピー計測で `initialGzip` は 343,662 B（上限 264,846 B に対し +78.8 KB 超過）まで下がったが、その後の変更と初回操作時間は未計測である。原因と体感影響を測る前に構造を設計しない。

- **`[B0]` 固定コピーでの最新内訳・初回操作時間のベースライン調査（調整・読み取り／計測のみ）**
  1. **実施環境**: 現行の `bun run build:web` は共有の `packages/design-system/dist` を書き換えるため、必ず [並行作業中の固定コピー手順](../../docs/verification.md#並行作業中の固定コピー) に従った独立コピー内で `build:web` と計測を行う。
  2. **容量内訳の機械抽出**: 初期 `modulepreload` に載る各チャンクについて「含まれるモジュール」と「初期エントリからそこへ至る import 経路」を一覧にし、「初期表示に必要」「遅延できる（費用小）」「遅延には構造変更が要る」に分類する。
  3. **初回操作時間の計測**: 同一条件（fixture 環境・ブラウザ E2E 等）で、① ページ表示→初回チャット入力可能までの時間、② 主要 Artifact を初めて開くまでの時間、を記録する。
  4. 結果を `spec/verification/` に日付付きで記録する。
- **`[B1]` 費用のかからない遅延読込みと前後比較（調整）**
  - `B0` で「遅延できる（費用小）」に分類したものだけを、既存の lazy Artifact と同じ方式で遅延させる。画面の構成・公開 API・パッケージのエントリは変えない。
  - 変更前後を `B0` と同一条件で比較し、**gzip 容量・初回チャット操作時間・初回 Artifact 表示時間**の差分を記録する（遅延読込みで初回 Artifact 表示が過度に悪化していないことも確認する）。
- **`[B2]` 構造を変える分割（`B0` と論点 3 の決定後に個別設計）**
  - 第1稿の案（design-system のサブパスエントリ分割、`client/` のコア／ドメイン分割）は、`B0` で効果が確認され、かつ論点 3 で「旧上限 264,846 B 以内まで構造分割して減らす」と決めた場合のみ、個別の設計書を起こして実施する。`client/` を分ける場合、Web が使わなくなった入口を互換目的で残さない（CLI と試験が実際に使う入口だけを残す）。
- **`[B3]` 基準値と EUM010 記録の更新（調整・論点 3 決定後）**
  - 論点 3 の決定に従う。起動・初期チャット表示・主要 lazy Artifact の読込み・エラー表示をブラウザ E2E（対象ファイル明示）で確かめてから `bun scripts/bundle-budget.ts --write` を実行し、`entryGzip`（記録値 112,035 B）も実測へ下げる。
  - **旧上限（264,846 B）を超えたまま再記録する場合**は、論点 3 で合意した内容に沿って [全体課題一覧 EUM010](../project-issues-2026-11-06.md#eum010-初期javascript容量の超過記録を閉じていない) の完了条件の改定経緯と、容量・初回操作時間の実測根拠を記録する。

---

### 3.5 運用性の改善（`O1`〜`O3`）

`O1`・`O3` は方向の記述に留める。着手時に個別の設計書を起こす。本計画で実装するのは `O2` だけである。

- **`[O1]` 一体型バックアップと復元検証コマンドの整備（個別設計書へ分離）**
  - 現状 `bun run db:backup` は SQLite 本体のみを複製し、忘却 journal や鍵との整合は [docs/operations.md](../../docs/operations.md) の手動手順依存。停止中バックアップの整合セット化（鍵実体は含めずフィンガープリントのみ）と EUM013 ベースの隔離復元検証コマンド（`db:verify-restore`）を個別設計する。
- **`[O2]` 環境診断 `bun run doctor` と検証ログ掃除 `bun run verify:prune`（調整＋論点 9）**
  - `bun run doctor`: Bun / Node / Python バージョン、`oxlint`・`s11tnext` 実行可否、`data/`・`verification-reports/` のディスク使用量、鍵ファイルパーミッション、DB ロック状態を 1 コマンドで読み取り専用診断する。
  - `bun run verify:prune`:
    - **現行実装の再利用**: `scripts/verification-run.ts` の `pruneVerificationReports()` はすでに `runs/`（20 件・実測 3.2 MB）と `nl-acceptance/`（5 件・84 MB）を整理している。`runs/` の件数削減ではなく、既存関数をそのまま再利用する。
    - **実容量に合わせた 2 段階構成**: 実測 500 MB の主因は `verification-reports/` 直下の個別調査ディレクトリ（最大 `tts-ack-latency-20261115` 164 MB 等）である。まず `bun run verify:prune`（既定・dry-run）で `verification-reports/` 配下の全ディレクトリについて「種別（`runs` / `nl-acceptance` / 個別調査）・容量・最終更新日時・削除候補と回収見込み」を表示する。
    - 個別調査ディレクトリを `--apply` で削除対象に含める保持条件（例：最終更新から N 日以上経過、保護名リスト、実行中検証ディレクトリの除外）は §6 論点 9 で決めてから削除機能を有効化する（10-31 計画 `B3` の実運用化）。
- **`[O3]` 検証時ビルド生成物の隔離強化（EUM029・個別設計書へ分離）**
  - 共有の `packages/design-system/dist` を上書きして並行編集や開発サーバーと競合する問題に対し、検証専用のビルド出力先／自動固定コピー運用を個別設計する。

---

### 3.6 配布性の改善（EUM026 / EUM032 / EUM033：`P1`〜`P3`）

- **`[P1]` 依存宣言にない旧 `.tgz` 20 本の参照照合と削除候補の確定・撤去（論点 4）**
  - `package.json` にない 20 本は「即削除」ではなく**削除候補**として扱い、着手前に全件の参照状況を照合して削除一覧を確定する。現時点で判明している要確認 3 本は次のとおり：
    1. `vendor/agency/eumenes-agency-0.1.7-01f61cbac379-2eb0e322579f.tgz`（1 本）: 現行 [vendor/agency/manifest.json:111](../../vendor/agency/manifest.json#L111) が `derivedFrom` で参照している。来歴追跡のため実体を残すか、manifest のハッシュと git 履歴で十分かを論点 4 で決める（残す場合は `G3` の照合で `derivedFrom` 参照を正当扱いとする）。
    2. `vendor/eumenes-memory/eumenes-memory-0.0.4-8ad114dda9a1.tgz` および `vendor/eumenes-memory-host/eumenes-memory-host-0.1.0-ce6f3e7b220b.tgz`（2 本）: [docs/memory.md:36](../../docs/memory.md#L36) が配布物として指定している（現行 `package.json` の採用版は `0.0.4-7bed1c085f00` と `0.2.0-cbca090ca596`）。運用文書の記載が古いことを確認・更新したうえで削除対象へ入れる。
    3. 残る 17 本についても、`docs/`・`spec/`・`vendor/*/manifest.json`・`scripts/` からの参照有無を機械検索し、無参照を確認した分だけを削除一覧として確定・撤去する（対応 `.sha256` 含む。10-31 計画 `A6` の完了＋`G3` による再発防止）。
- **`[P1x]` `vendor/skill-smith/seeds/` の二重保持解消（個別設計書へ分離）**
  - git 追跡されている `ruri-catalog.sqlite`（46.5 MB）と `ruri-catalog.seed.sql.gz`（23.0 MB）の片方を外すには、実行時読取り元・展開タイミング・`ruri-catalog.manifest.json` 照合・外部プロジェクト側の配布形を決める必要があるため、個別設計書へ分離する。
- **`[P2]` `spec/` の大容量バイナリ運用ルール策定（要設計合意・論点 5）**
  - 現在 git 追跡下の `spec/` は 194 MB（うち `.png` 150 MB、`.mp4`/`.gif` 9 MB、1 MB 超ファイル 58 件）。
  - **運用案**:
    1. 既存の履歴書き換え（force-push を伴う歴史改変）は行わず、**今後の新規追加分** に対して「画像は WebP/最適化 PNG で 1 枚あたり目安 250 KB 以下、動画や生キャプチャは git 外保管とし `spec/` には Markdown と構造化 JSON サマリのみコミットする」ルールを定める。
    2. 必要であれば `scripts/check-repo-hygiene.ts` で 1 MB 超のバイナリ新規追加を警告する。
- **`[P3]` 依存・脆弱性・ライセンス監査と導入プロファイル整理（EUM026 / EUM032 / EUM033・個別設計書へ分離）**
  - 全 npm 依存・`vendor/*`・外部アセット（Live2D 等）の棚卸し自動化（`audit:deps`）と、Core／Optional Adapters の導入プロファイル層別化を個別設計する。

---

### 3.7 持続可能性の改善（EUM028 / EUM031：`M1`〜`M3`）

`M1`・`M2` は方向の記述に留め、着手時に個別の設計書を起こす。`M3` は 11-22 計画が実施する。

- **`[M1]` `scripts/domains.ts` への保守ライフサイクル区分と受入鮮度の集約（個別設計書へ分離）**
  - 既存の `tier` とは別軸で `lifecycle`（`core` / `standard` / `experimental` / `retiring`）および受入鮮度メタデータを持たせ、`docs/domains.md` へ自動反映する方向。
- **`[M2]` `vendor/` 13 パッケージの更新手順の標準化（個別設計書へ分離）**
  - tarball 配置・sha256・manifest 更新・旧 tarball 削除・`bun install`・`vendor.test.ts` 実行を標準化する `scripts/vendor-sync.ts` を整備する方向（外部研究 domain の方針に沿い、`packages/` への昇格基準は設けない）。
- **`[M3]` `retiring` コードの計画撤去（既存計画と接続）**
  - 旧 F host 一式（13 ファイル・2,157 行）、休止中 `context-keeper.ts`（677 行）、旧 Router 残存（526+ 行）は、[11-22 トークン効率・負債計画](../.todo/conversation-agent-token-efficiency-and-debt-plan-2026-11-22.md) の `D4` が撤去する。本計画側では実施せず、撤去完了後に `size-budget.json` と `knip` の再計測を行う。

---

## 4. 既存計画書との接続・非重複マトリクス

| 既存計画・課題 | 重複を避ける分担ルール |
| --- | --- |
| [11-22 トークン効率・負債計画](../.todo/conversation-agent-token-efficiency-and-debt-plan-2026-11-22.md) `D1`・`D4`・`D5`・`E2` | 旧 `host.ts` 撤去（`D4`）と `onCommit` 最適化（`D1`）の仕様は 11-22 計画を正本とする。`S1x`（agency の超過 3 件）・`R2`・`M3` は同計画が編集中のファイルに属するため、同計画の作業とする。本計画は同計画の文書とファイルを書き換えず、完了後の再測定だけを行う。 |
| [11-06 全体課題一覧](../project-issues-2026-11-06.md) EUM010・026・028・029・031〜033 | 各 EUM の完了条件を引き継ぐ。EUM010 の完了条件を変更する場合は §6 論点 3 で明示合意する。EUM032/033 は外部展開時の条件付きのまま扱う。 |
| [10-31 技術評価改修計画](review-remediation-plan-2026-10-31.md) A6・B3 | 未参照 `vendor` 旧 tarball 削除（A6）と検証記録の自動整理（B3）は、本計画の `P1`・`G3`・`O2` に参照確認と再発防止ガード付きで統合する。 |
| [11-17 計画3 検証記録](../verification/grok-plan-3-web-voice-verification-2026-11-17.md) | adapter 分割（399 KB → 343.7 KB）は既実施として重複させず、`B0` で最新差分と初回操作時間を補完計測する。 |

---

## 5. 段階的実行ロードマップ

| Phase | 対象 ID | ゴール（完了条件） | 区分・依存論点 |
| :---: | --- | --- | --- |
| **Phase 0（即時衛生・計測）** | `G5`, `R1`, `S1`, `S2`, `G4`(1・3), `G6`, `O2`(doctor + prune dry-run), `B0` | `artifacts/` が `verify` / `test:inventory` 走査から除外。`boundaries` がエラー 0。`size:check` の残りが `S1x` の 3 件のみ、かつ `size-budget` 縮小専用更新の回帰試験が合格。`check:guards`（`--domain` 対応）・`doctor`・`verify:prune`（内訳と回収見込み表示）が動作。固定コピーでの最新初期 JS 内訳と初回操作時間の記録がある。 | 調整中心（`G5`・`G6` は論点 6・7 確認後） |
| **Phase 1（ガードレール適正化・衛生確定）** | `G1`, `R3` → `G2`, `P1` → `G3`, `G4`(2), `P2`, `O2`(prune `--apply`) | `api/application/**` に未所有ファイルが無く、所有 domain／共有区分の検証で失敗。`R3` 完了後に `fixed-names`（`partition()` 統一・`flux` 含む）が全検証で常時実行され違反 0。`P1` 参照照合・削除確定後に `vendor.test.ts` が 13 系統（tarball 12＋Live2D）を網羅し未許可 `.tgz` 0 本。`size-budget` 運用・`spec/` バイナリ規則・個別調査ログ保持条件が確定・反映されている。 | **要設計合意**（論点 1・2・4・5・8・9） |
| **Phase 2（初期 JS・初回操作）** | `B1`, `B3`（＋論点 3 で実施決定した場合の `B2`） | 論点 3 の決定どおりに `bundle:check` が通り、容量・初回チャット入力・初回 Artifact 表示時間の前後比較記録と基準値更新（必要なら EUM010 改定記録）が揃っている。 | 調整（論点 3 決定後、`B2` は個別設計） |
| **11-22 計画の完了後** | `S1x`・`R2` の再測定、`M3` 後の `size-budget.json`・`knip` 再計測 | `size:check` と `fixed-input-size.test.ts` がエラー 0。 | 再測定のみ |
| **本計画の合意対象外** | `O1`, `O3`, `P1x`, `P3`, `M1`, `M2`、`S3`（随時） | 項目ごとに設計書を起こして合意する。`S3` は該当 domain の改修時に行う。 | 個別設計 |

---

## 6. 合意確認事項（着手前に決定が必要な論点）

| # | 対象 | 確認したい論点 | 推奨案 |
| :---: | --- | --- | --- |
| 1 | `G1` | `verify --domain` で `api/application/**` の静的違反をどう所有・失敗させるか（特に `server.ts` / `server-services.ts` 等の共有組立てファイルの所有者と失敗させる domain） | `domains.ts` の `applicationPaths` で domain が明示所有し、共有組立てファイル用に専用区分（例：`application`）を定義して未所有ファイルを禁止する。共有区分は `--domain application` と `verify:all` で失敗させ、個別 domain 検証では警告に留める（`git diff` 判定は使わない） |
| 2 | `R3` / `G2` | 画像画面のモデル選択（`qwen` / `flux`）の扱い：生成 POST の `model` 候補値をどこから取得するか、候補ゼロ／取得失敗／選択後消失時の振る舞い、および `G2` への接続順序 | LARM 契約とコードで `model` 候補取得元の有無を確認したうえで、動的取得できるならそれを使い、取得不能なら未指定（LARM 既定）送信へ統一（自動切替なし）。`R3` 完了後に `G2`（`partition()` 統一＋`flux` パターン追加）を接続する |
| 3 | `B1`〜`B3` | 初期 JS 超過（11-17 時点で +78.8 KB）の到達点と EUM010 完了条件の扱い。2026-10-17 判断（容量は重視せず再記録）と EUM010（機械的に増やして閉じない）のどちらを採るか | `B0` を固定コピーで実施し容量＋初回操作時間を計測、費用小の遅延読込み（`B1`）と前後比較を行ったうえで、旧上限を超える分は実測根拠付きで `--write` 再記録し、**EUM010 の完了条件を「費用小の遅延と初回操作時間の悪化なしを確認して基準再記録」へ改定する**。旧上限 264 KB 内まで減らす場合は `B2` を個別設計する |
| 4 | `P1` / `G3` | 依存宣言にない旧 `.tgz` 20 本のうち、`agency` の `derivedFrom`（1 本）と `docs/memory.md` 指定（2 本）を含む削除候補の扱い | `docs/memory.md` の古い指定 2 本は現行採用版へ更新したうえで削除候補に含める。`agency` の `derivedFrom` 1 本は「来歴実体を残す（`G3` で `derivedFrom` 参照を正当扱い）」か「manifest の sha256 と git 履歴で足りるため削除」かを決定し、無参照を確認した分だけを削除する |
| 5 | `P2` | `spec/` への今後の画像・動画コミット方針 | 既存履歴は書き換えず、今後の新規追加のみ WebP/最適化（目安 250 KB 以下）と動画の外部保管をルール化する |
| 6 | `G5` | `artifacts/` の過去検証コピーの扱い | `.gitignore` と `sourceFiles()` の除外リストに加えるだけにし、中身は持ち主に確認せず動かさない（生 `bun test` では `./` 明示を維持） |
| 7 | `G6` | `check:guards` の並行作業時の扱い | `verify --domain` と同じ `--domain` 指定と `partition()` を共有し、範囲外は警告に留める |
| 8 | `G4` | `size-budget.json` への新規追加を原則禁止にするか | 通常の更新は既存エントリの縮小・解消のみとし、新規超過・増加の追加を禁止する（回帰試験で保証） |
| 9 | `O2` | `verification-reports/` の個別調査ディレクトリ（最大 164 MB 等）に適用する削除・保持条件 | まず `verify:prune` の dry-run で全体内訳と回収見込みを確認したうえで、保持条件（例：最終更新から 14 日超、かつ実行中でない個別調査ディレクトリを対象、保護リスト除外）を決定してから `--apply` を有効化する |

`O1`・`O3`・`P1x`・`P3`・`M1`・`M2` は、個別の設計書で論点を出す。

---

## 7. 検証計画

各 Phase の完了時は、以下の区分を守って検証結果を記録する。並行作業がある checkout では、[固定コピー手順](../../docs/verification.md#並行作業中の固定コピー) を使って入力・生成物を分離したうえで確定検証を行う。

- **静的検査（違反扱い）**: `bun run check:guards -- --domain <対象>`（`boundaries`, `sql-boundaries`, `size:check`, `fixed-names`, `domain-docs`, `format:check`, `lint`, `context:check`, `typecheck`）で、変更対象の範囲がエラー 0。範囲外の警告は件数と所有する作業を記録する。
- **回帰試験（`G4`・`G3`・`G1`・`G2`）**: `bun test ./scripts/size-budget.test.ts` 等（`./` 明示）で、`size-budget` の縮小専用更新が新規超過・増加を取り込まないこと、Live2D と npm tarball の照合条件、および `inScope()` / `partition()` の動作を確認する。
- **ドメイン検証（入力固定を含む）**: 変更対象ドメインおよび利用側ドメインの `bun run verify -- --domain <name>` が `pass`（`invalidated` でないこと・前後 hash 一致）で成功すること。
- **バンドル・UI 検証（Phase 2）**: 固定コピー上で `bun run build:web && bun run bundle:check` 合格に加え、同一条件での容量・初回チャット入力可能時間・主要 lazy Artifact 初回表示時間の前後比較、および対象明示のブラウザ E2E で回帰なしを確認。
- **再測定（11-22 計画の完了後）**: `bun run size:check` と `bun test ./api/application/fixed-input-size.test.ts` を実行し、結果を本計画の検証記録に追記する。

---

## 8. 実施記録（2026-11-22）

利用者合意（2026-11-22、論点 1〜9 は推奨案を採用）に基づき Phase 0〜2 を実施した。

| ID | 状態 | 実施内容と検証結果 |
| --- | :---: | --- |
| `G1` | 完了 | `scripts/domains.ts` に共有区分 `application`（`tier: 7`）と `applicationPaths`（全 `api/application/**` を漏れなく所有付け）を追加。`scripts/domain-docs.ts --check` で未所有ファイルを禁止、`scripts/verification-selection.ts` に `staticSelectionPaths()` を追加して `verify.ts` / `check-guards.ts` の `inScope()` へ接続、`verify.ts` に範囲外警告総数サマリを追加。`docs/domains.md` 更新済み。 |
| `G2` | 完了 | `scripts/fixed-names.ts` を抽出（`/\bflux[-_.\s]?\d/i` 追加）し、`verify.ts` へ `partition()` 統一ステップとして組み込み。`fixed-input-size.test.ts` を `dialogue`・`settings`・`steward` の `integrationTests` に明示登録。`bun scripts/fixed-names.ts` ok、`api/application/fixed-names.test.ts` 4/4 pass。 |
| `G3` | 完了 | `api/application/vendor.test.ts` を全 13 系統へ拡張（追加 npm tarball 6 系統のテーブル駆動照合＋Live2D `assets.json` の SHA-256 照合＋`package.json`・`manifest.json#derivedFrom` 以外の未参照 `.tgz` 拒否）。10/10 pass（605 expect）。 |
| `G4` | 完了 | `scripts/size-budget.ts` に `ratchetBudget()`（縮小・解消・削除済み除去専用、新規超過・増加は非登録）と `notices()`（`size-budget-notice:`）を実装し回帰試験追加。`scripts/bundle-budget.ts` に超過時上位 5 チャンク出力 `formatTopChunks()` 追加。`docs/verification.md` に引き下げ専用運用を明文化。 |
| `G5` | 完了 | `.gitignore` に `artifacts/` 追加（中身は非移動。`sourceFiles()` は既存の `isParkedCheckout()` 契約・単体試験を維持）。`package.json` の `lint`/`lint:fix`/`context:*`/`deadcode` を `bun x --bun` 実行化して Node 不在環境でも動作を確認。`bunfig.toml`（コメント修正・`vendor/canvas/workbench/**` 除外）と `.oxlintrc.json`（`vendor/canvas/workbench/**`・`spec/verification/**` 除外）を整備。 |
| `G6` | 完了 | `scripts/check-guards.ts`（`bun run check:guards`、`--domain` 対応、`partition()` 共有）と回帰試験 `scripts/check-guards.test.ts` を新設。既存リポジトリ全体の format/lint 違反（`memory-host.test.ts`、`composition-data-components.tsx`、`vendor/router/manifest.json` 等）も解消し、本計画管理下の 9 工程すべて PASS（`boundaries`, `sql-boundaries`, `size-budget`, `fixed-names`, `domain-docs`, `format`, `lint`, `system-context`, `typecheck`）。 |
| `R1` | 完了 | `api/domains/dialogue/test/agency-work.fixture.ts` を介して `api/application/agency/note-input.test.ts` の公開入口迂回を解消（`app-review.test.ts` は事前コミットで解消済み）。`bun scripts/boundaries.ts` ok（違反 0）。 |
| `R2` | 完了 | 並行作業（`7eb94887`）完了後に `bun test ./api/application/fixed-input-size.test.ts` を再計測し 1/1 pass を確認。 |
| `R3` | 完了 | 現行 LARM 契約に画像モデル候補一覧 API が無いことを確認し、`image-screen.bundle.json` から固定 `qwen`/`flux` を撤去（未指定＝LARM 既定送信、自動切替なし）。`docs/images.md`・`docs/larm.md`・`image-screen-adapter.test.ts` を更新。 |
| `S1` / `S2` | 完了 | `workflow-web-records.ts`・`toolchain.fixture.ts`（`toolchain-reply.fixture.ts` 分離）・`execution-commands.ts`・`saved-bodies.ts`・`ImagePicker.tsx`（`useImagePicker.ts` 分離）に加え、`server-services.ts`（`server-wiring.ts` 分離）も上限未満へ分割完了。 |
| `S1x` | 実装・検証済み（並行作業と同梱コミット待ち） | 並行作業完了後に残存した agency 3 件を分割・検証：`always-on-ports.ts`（モジュール関数抽出）、`always-on-host.ts`（`always-on-runtime.ts` 分離）、`always-on.test.ts`（`always-on-reply.test.ts` 分離）。関連統合試験 54/54 pass（最終微調整後 32/32 pass）、全超過ゼロを確認したうえで `bun scripts/size-budget.ts --write`（引き下げ専用）を実行し 15 件縮小・7 件除去（残存既存例外 18 関数・ファイル 0・テスト 0）、`bun run size:check` エラー 0・通知 0（2,475 files ok）。※ `always-on-ports.ts`/`always-on-host.ts`/`always-on-runtime.ts`/`always-on.test.ts` には直後に別セッションの改修（`scheduleProfile`・`always-on-goal-reply` 等）が重なったため、部分コミットによる破損を避け、当該 5 ファイルと `domains.ts` の `always-on-reply.test.ts` 登録は別セッション側へ引き継ぎ。 |
| `M3`（再計測） | 完了 | `bun run deadcode`（`knip --include files,exports,types`）を再実行し、未使用ファイル 4 件・未使用 export 37 件・未使用型 37 件を記録（スコープ外の無断削除は行わない）。 |
| `O2` | 完了 | `scripts/doctor.ts`（`bun run doctor`）と `scripts/verify-prune.ts`（`bun run verify:prune`、既存 `pruneVerificationReports()` 再利用＋全体内訳 dry-run＋`--apply` 14 日超・実行中除外・`--keep` 保護）＋試験 `scripts/verify-prune.test.ts` を実装。`bun run verify:prune -- --apply` を実行し 14 日超の個別調査ディレクトリ 155 件（約 185.9 MB）を回収（`verification-reports/` 500 MB → 294.0 MB）。 |
| `P1` | 完了 | 未使用 `.tgz` 20 本を全件照合し、`docs/memory.md:36` の古い 2 本記載を現行採用版（`0.0.4-7bed1c085f00`・`0.2.0-cbca090ca596`）へ更新、無参照確定 19 本（＋対応 `.sha256`）を撤去。`vendor/agency/manifest.json#derivedFrom` の 1 本は来歴実体として保持（`G3` で正当参照扱い）。 |
| `P2` | 完了 | `docs/verification.md` に `spec/` 新規バイナリルール（画像目安 250 KB 以下、動画等外部保管）を明文化し、`scripts/check-repo-hygiene.ts`（`bun run repo:hygiene`）を追加。 |
| `B0`〜`B3` | 完了 | 固定コピーで最新ビルド内訳・`zod` 二重バンドルを特定、`vite.config.ts` の build 限定 `resolve: { dedupe: ["zod"] }` で `initialGzip` 324,127 → 299,799 B（-24,328 B）・`entryGzip` 53,416 B。初回チャット／Artifact 表示の 5 回比較で悪化なし・`pageerror` 0 を確認し、`scripts/bundle-budget.json` と EUM010 を更新。[検証記録](../verification/quality-guardrails-b0-b1-2026-11-22.md)。 |
| 個別設計対象外 | 計画外 | `O1`・`O3`・`P1x`・`P3`・`M1`・`M2`（および随時 `S3`）は §5 の合意どおり個別設計書で別途扱う。 |
