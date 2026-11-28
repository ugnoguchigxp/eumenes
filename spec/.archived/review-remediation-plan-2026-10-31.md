# 技術評価の指摘への改修計画（2026-10-31）

状態: **第1部と第2部を実施済み（2026-10-31）・未コミット**。利用者の回答は「第1部 A1〜A7 すべて合意」「第2部 B1〜B7 を合意」、続けて「止めないで最後までやりなし」。B4 の期限は案の10分、B6 の許可リストは空、B7 は定数60秒で実装した。API（127.0.0.1:8787）と Web（127.0.0.1:5173）は作業中も起動したままなので、seed と画面の反映は再起動待ち。`bun run verify` は起動中のため未実施。

対象スナップショット: `main` `12f6114a`（2026-10-31 14:05）。実装担当: Grok 4.7。本書だけで作業できるよう、変更箇所・手順・受入条件を具体的に書く。

前提の評価: 2026-10-31 の技術品質評価（agent profile、暫定 58.2/100、正式点は未算出）。指摘の根拠は本書の各項目に再掲する。

## 0. 実装担当への作業規則（必ず守る）

`AGENTS.md` の規則に加えて、次を守る。

1. **ブランチ**: `main` で作業する。新しいブランチを作らない。
2. **サーバー**: サーバーを起動・停止・再起動しない。反映に再起動が要る項目は「再起動待ち」と記録して利用者に任せる。
3. **着手前の確認**: `git status --short` を実行する。対象ファイルに自分以外の未コミット変更があれば、その項目に着手せず利用者に報告する（並行セッションの作業を壊さないため）。
4. **範囲**: 本書に書いていない判断方式・優先順位・フォールバック・設定項目を足さない。書かれた手順で足りない、または前提が本書の記述と違うと分かったら、その項目を止めて「何が違ったか」を報告する。推測で埋めない。
5. **第2部**: 合意欄が「合意済み」でない項目には手を付けない。設計の詰めが要る項目（B4 など）は、合意後でも先に本書へ詳細を追記して利用者の確認を得る。
6. **順序**: 第1部は A1 から順に1項目ずつ進め、各項目の受入条件を満たしてから次へ進む。
7. **コミット**: 利用者の指示があるときだけ行う。指示があれば1項目1コミットにし、件名は既存の履歴に合わせた英語の一文にする。複数項目をまとめない。
8. **秘密**: ログ・試験出力・本書に、会話本文・認証情報・設定値・Provider の生応答を書かない。
9. **記録**: 各項目の終わりに §5 の実施記録へ、変更ファイル、実行したコマンド、終了コード、pass/fail 件数を書く。fixture・live・実機器を区別する。

### 0.1 検証の実行方法

- **開発サーバーの確認**: 検証の前に `lsof -nP -iTCP:8787 -iTCP:5173 -sTCP:LISTEN` で、開発サーバーが動いているかを確認する。
- **動いている場合**: `bun run verify` を実行しない。`verify` は DesignSystem の `dist` を作り直し、起動中の開発サーバーと重なると壊れる（`docs/verification.md`）。代わりに試験だけを `bun run test:domain -- --domain <name>` か `bun test <ファイル>` で実行し、記録に「静的検査は未実施（開発サーバー稼働中）」と書く。`verify` の実行可否は利用者に尋ねる。
- **動いていない場合**: `bun run verify -- --domain <name>` を、影響のある利用側 domain も含めて実行する。
- **サンドボックスでの PTY 試験**: サンドボックス内では実 PTY を開けず、`api/domains/shell` などの PTY 試験が timeout する（既知、`spec/score-improvement-plan-2026-10-31.md` の実施記録）。その失敗はサンドボックス外で同じファイルを再実行して pass を確かめ、両方の結果を記録する。
- **整形と lint**: `bun run format:check` と `bun run lint` は、どの項目でも最後に実行する。

## 1. 目的と成功条件

### Goal

評価で確認した不具合と、既存設計に対する未実装分を直す。あわせて、仕様変更が要る改善を、利用者が判断できる形に整理する。

### Success Criteria

- 第1部の各項目が受入条件を満たし、§5 に記録がある。
- `verification-reports/runs/<runId>/` に工程ごとの出力が残り、`report.json` から失敗した試験の名前が分かる（A1）。
- Eumenes 自身の画面で、ブラウザ担当によるクリック・確定キー・送信付き入力が、承認なしには実行されない（A5）。
- 第2部の各項目に、利用者の合意または不採用の判断が記録されている。

## 2. 第1部: 調整（本書の合意で着手可）

既存の仕様・責務・判断方式は変えない。既存設計を満たすための不具合修正と文書の訂正だけを行う。

### A1. 検証記録に工程ごとの出力と失敗した試験の名前を残す

- **根拠**: `scripts/verification-run.ts:190-201` は子プロセスを `stdio: "inherit"` で実行するので、出力は端末に流れるだけで記録に残らない。2026-10-31 の記録 `2026-10-31T04-29-07-598Z-…` は「bun tests failed (1)」だけで、どの試験が落ちたかを記録から確かめられなかった。
- **変更箇所**: `scripts/verification-run.ts`、`docs/verification.md`、試験は `scripts/verification.test.ts` に追加する（既存の試験の書き方に合わせる）。
- **手順**:
  1. `step.command` の子プロセスを、`stdio: ["inherit", "pipe", "pipe"]` で起動する。stdout と stderr の各チャンクを、そのまま `process.stdout` と `process.stderr` へ書き、同時に `<run directory>/steps/<2桁の工程番号>-<工程名の英数字とハイフン>.log` へ追記する。端末の表示は今と同じに保つ。
  2. `VerificationReport["steps"][number]` に、任意の欄 `log?: string`（run directory からの相対パス）と `failures?: string[]` を足す。`schemaVersion` は 1 のまま（任意欄の追加なので、既存の読み手を壊さない）。
  3. 工程が失敗したら、ログから ANSI エスケープを除いた行のうち、`(fail) ` で始まる行（bun test）と、`FAIL ` または `×` を含む行（vitest）を最大50行、各300文字まで `failures` に入れる。該当する行がなければ、最後の40行を入れる。
  4. ログのファイルは、工程の終了時（成功・失敗・中断のいずれでも）に閉じる。シグナルで中断したときの子プロセス群の停止（`killGroup`）は変えない。
  5. `docs/verification.md` の「各実行には…保存します」の段落に、工程ごとのログと `failures` を保存することを1文で足す。
- **受入条件**:
  - 試験: 失敗するコマンド（例 `bun -e "console.log('(fail) sample > case'); process.exit(1)"`）を工程に持つ計画を実行し、`report.json` の該当工程に `log` と `failures: ["(fail) sample > case"]` が入ること。成功する工程にも `log` が入ること。
  - `bun test scripts/verification.test.ts scripts/verification-metrics.test.ts` が pass すること。

### A2. 見ている人のいない run の状態を Map に残さない

- **根拠**: `api/domains/dialogue/service/progress.ts:34` の `publish` は、購読者がいなくても `watchedStatuses.set` を行う。削除は購読者がいなくなったときだけ（76-81行）。`publish` は委任のたびに呼ばれる（`executor-delegation.ts:80`）ので、プロセスが動いている間、run ごとに1件ずつ溜まる。
- **変更箇所**: `api/domains/dialogue/service/progress.ts` だけ。
- **手順**: `publish` の `watchedStatuses.set(runId, value.status)` を、`watchers.has(runId)` のときだけ行う。listener の呼出しは変えない。
- **受入条件**:
  - 試験: `api/domains/dialogue/test/` の既存の進捗試験と同じ fixture を使い、購読していない run に `publish` を呼んだあとで購読を始めても、listener が現在の状態を1回受け取ることを確かめる（振る舞いが変わらないことの回帰試験）。
  - `bun run test:domain -- --domain dialogue` が pass すること。

### A3. 巻き戻された取消を、あとで LARM へ送らない

- **根拠**: `api/domains/dialogue/service/specialist-core.ts:284-300` の `deferFlush` は、取消した run を、transaction と無関係なモジュールの Map に貯める。savepoint や transaction が巻き戻されても（`specialist-start.ts:150-165`、`executor-delegation.ts:139`）、次の決着の `afterCommit` で `flushCancelled` が `larm.cancelSubject(runId)` を状態の確認なしに呼ぶ（114-123行）。その結果、DB 上ではまだ実行中の run の推論と音声を止めてしまうことがある。queue の job 側は `flushCancellations` が状態を読み直すので問題ない。
- **変更箇所**: `api/domains/dialogue/service/specialist-core.ts`。
- **手順**:
  1. `flushCancelled` の `runIds` の繰り返しで、`deps.store.read((db) => byId(db, runId))` を使って run を読む。状態が `queued` か `running` の run には `cancelSubject` を呼ばない。`byId` は `../repository` から import する（`progress.ts` と同じ）。
  2. 事前に、`runIds` が `dialogue_runs` の id であることを、呼出し元（`cancelRunInTransaction` と、そこへ渡している entry）で確かめる。別の種類の id が混ざっていたら、変更せずに報告する。
- **受入条件**:
  - 試験（`api/domains/dialogue/test/specialist*.test.ts` の fixture を使う）: 実行中の run を `deferFlush` に入れてから `flushDeferred` を呼んでも `larm.cancelSubject` が呼ばれないこと。`cancelled` になった run では呼ばれること。
  - 可能なら、評価で示した再現手順も試験にする: 期限切れの専門セッションを終了させた transaction の中で `queue_full` を起こし、別の決着を commit させても、そのターンの推論要求が取消されないこと。fixture で `queue_full` を作れない場合は、この試験を省いて理由を記録する。
  - `bun run test:domain -- --domain dialogue` が pass すること。

### A4. 文書と実装のずれを直す

- **根拠と変更箇所**:
  1. `docs/domains.md` の手書きの表（自動生成の表より下）が、存在しないパスを参照している。2026-10-31 に確認したものは次のとおり。`rg` で実在するパスを探して書き直し、該当するものがなければ「なし」とする。
     - `web/src/domains/service-tests/index.tsx` と `index.test.tsx`（実在するのは `toolchain-adapter.tsx`）
     - `web/src/domains/tts-dictionary/index.tsx`（ディレクトリがない）
     - `web/src/domains/toolchain-history/`（ディレクトリがない）
     - `web/src/components/domains/timers/TimerArtifact.tsx`
  2. `docs/domains.md:5` は「`--check` を `verify --all` に組み込みます」と書いているが、実際はすべての `verify` で実行される（`scripts/verify.ts:124-129`）。文をこれに合わせる。
  3. `docs/excalidraw.md` の `spec/excalidraw-work-record-2026-10-13.md` と、`docs/google-accounts.md` の `distribution-client.json` へのリンク先が存在しない。移動先を `git log --all --diff-filter=R --name-status` や `rg` で探し、見つかれば直し、なければ参照を外して「記録は削除済み」と書く。
  4. `spec/README.md` の状態欄で、`single-harness-plan-2026-10-31.md`（「案・合意待ち」）と `unreferenced-code-cleanup-plan-2026-10-31.md`（「未コミット」）が、各文書の先頭の状態行と `git log` に合っていない。各文書の状態行をそのまま写す。状態行と実装が食い違う場合は、自分で判断せず報告する。
- **やらないこと**: 文書の存在を自動で検査する仕組み（`domain-docs --check` の拡張など）は足さない。必要なら第2部に提案として書く。
- **受入条件**: `bun scripts/domain-docs.ts --check` が成功すること。直した各パスについて `test -e` で存在を確かめ、記録に書くこと。

### A5. ブラウザ担当が Eumenes 自身の画面で行う確定操作に承認を求める（設計 §4.4 の未実装分）

- **根拠**:
  - `spec/browser-tabs-toolchain-design-2026-10-18.md` §4.4 は「Eumenes の画面での保存・削除・送信は §5.3 の確定操作として扱う」と定めている。
  - しかし実装では、承認が要るのは次の場合だけである。
    - `needsApproval`（`api/domains/browser/service/approvals.ts:39-43`）が、GET 以外のフォームへの送信と判定した場合
    - モデルが自分で `effect: "commit"` と申告した場合（`operation-plan.ts:124-131`）
  - Eumenes の画面のボタンの多くはフォーム送信ではない。また、開発用 proxy が同一 origin の要求に API の認証を付けるので、Eumenes のタブでのクリックは、利用者本人の操作と同じ権限を持つ。
- **方針**: 「保存・削除・送信」を host が見分ける確かな方法がないので、安全側に倒す。対象タブの URL の origin が `ctx.webOrigins` に含まれる場合、次の3つを確定操作として扱う。読み取り（スナップショット・撮影・タブ一覧）は今のまま承認なしとする。
  - クリック（`click`）
  - 確定キー（`keyCommits` が真になる `press`）
  - 送信を伴う入力（`type` の `submit`）
- **変更箇所**: `api/domains/browser/service/operation-plan.ts` の `planOperation` だけ。`operations.ts` の `commitNeeded` は、`declared` が真なら要素を調べずに承認を求めるので、変えなくてよい。
- **手順**:
  1. `planOperation` の先頭で、`tab?.url` が Eumenes の Web origin かを、既存の `isWebOrigin(new URL(tab.url), ctx.webOrigins)`（`navigation.ts:79`）で判定する。URL を解析できない場合は Eumenes のタブとみなす（安全側）。driver へ新しく問い合わせない。
  2. Eumenes のタブであれば、次の3か所の commit guard で `declared` を真にする。
     - `click`: 今は `declared: action.effect === "commit"`（124-131行付近）。
     - `type`: `commits` の判定（`action.submit || action.effect === "commit"`）は変えない。送信を伴う入力のときだけ guard があり、そのときの `declared` を真にする。
     - `press`: `declared || keyCommits(action.key)` の判定は変えない。確定キーのときだけ guard があり、そのときの `declared` を真にする。
  3. 承認の文言は既存の `request(...)` を使い、新しい文言の種類を足さない。
  4. 承認の台帳・有効期限・1回限りの消費（`approvals.ts`）は変えない。
- **受入条件**:
  - 試験（`api/domains/browser/test/` の既存 fixture。Web origin の値は `api/application/browser/browser-task.fixture.ts` が import している `WEB` と同じものを使う）:
    - Eumenes の Web origin のタブで、フォーム外のボタンのクリックが `BrowserApprovalRequired` になること。
    - 承認を与えたあとは1回だけ実行され、2回目は再び承認を求めること。
    - 外部 origin の同じクリックは、今までどおり承認なしで実行されること。
    - Eumenes のタブでも、スナップショットとタブ一覧は承認なしで行えること。
  - `bun run test:domain -- --domain browser` と `bun test api/application/browser` が pass すること。
- **利用者への影響**: ブラウザ担当に Eumenes の画面を操作させる依頼は、クリックのたびに承認が必要になる。§4.4 が意図した挙動だが、利用者の体感は変わるので、完了報告に明記する。

### A6. 参照されていない vendor の旧 tarball を消す

- **根拠**: `vendor/world/eumenes-world-model-0.0.1.tgz` とその `.sha256` は、`package.json`・`bun.lock`・`vendor/world/manifest.json` のどこからも参照されていない（参照しているのは過去の計画書と検証記録だけ）。
- **手順**:
  1. `rg -n "eumenes-world-model-0.0.1.tgz" package.json bun.lock vendor api/application/vendor.test.ts` が0件であることを確かめる。1件でもあれば中止して報告する。
  2. `git rm vendor/world/eumenes-world-model-0.0.1.tgz vendor/world/eumenes-world-model-0.0.1.tgz.sha256` を実行する。過去の計画書と検証記録の中の記述は、当時の記録なので変えない。
  3. `bun install` は実行しない（lockfile を変えないため）。
- **受入条件**: `bun test api/application/vendor.test.ts` が pass すること。
- **範囲外**: memory の manifest にソースの commit を記録すること、World を未変更のソースから作り直すことは、別リポジトリでの作業が要るので本書では扱わない（§4）。

### A7. バックアップからの復元手順を文書にする

- **根拠**: `db:backup`（`api/application/db-backup.ts`）と、移行前のバックアップ（`api/infrastructure/sqlite/pre-migration-backup.ts`）はある。しかし、どの文書にも戻し方が書かれていない。また、バックアップは DB しか含まず、`data/keys/settings.key` がないと、暗号化して保存した認証情報を読めない（`docs/settings.md`）。
- **変更箇所**: `docs/operations.md` に「バックアップからの復元」の節を足す。文書だけで、コードは変えない。
- **手順**:
  1. 次の事実を、コードを読んで確かめてから書く。推測では書かない。
     - 既定の DB パスと `EUMENES_DB`
     - バックアップのファイル名と置き場所
     - WAL・SHM ファイルの扱い
     - owner lock
     - 移行前のバックアップが3世代だけ残ること
  2. 手順を書く。
     1. 利用者が API を止める。
     2. 今の DB と `-wal`・`-shm` を別名に退避する。
     3. バックアップを DB のパスへ複製する。
     4. 同じ時点の `data/keys/` を使う。
     5. 利用者が API を起動する。
     6. `bun run logs -- --level warn` で起動時の警告を確認する。
  3. 「バックアップに鍵は含まれない」「新しい版の DB を古いコードで開くと起動を拒否する」（`sqlite/index.ts` の版の検査）を注意書きにする。
  4. 実データでの復元は行わない。文書の末尾に「手順は未実行（文書のみ）」と書く。
- **受入条件**: 書いた各事実の根拠のファイルと行を §5 の記録に残すこと。

## 3. 第2部: 仕様変更（項目ごとに合意が必要）

各項目の「合意」欄が「合意済み（日付と利用者の回答）」になるまで着手しない。推奨案を先に書く。第2部は第1部がすべて終わってから、B1 から順に進める。

### B1. 会話からの Claude Code への依頼に、実行前の確認を付ける

- 合意: **合意済み（2026-10-31、案のとおり）**
- **根拠**:
  - `claude-code.repair@2` には `minImpact: "modify_existing"` があり、実行前の確認が必須になっている。
  - 同じツール（`tool:claude-code.request@2`）を使う `claude-code.request@3` には `minImpact` がない（`api/domains/capabilities/bundles/terminals-screen.bundle.json`）。
  - そのため、会話エージェントが影響を `none` と申告すると、確認なしで Claude Code にファイルを編集させられる。
  - Claude Code 自身の権限確認は残るが、利用者の `~/.claude/settings.json` で広く許可していれば効かない。
- **案**: `claude-code.request@4` を新しい revision として足す。@3 と同じ内容に `"minImpact": "modify_existing"` を加え、既存の revision は書き換えない（`docs/toolchain-extension.md` の規則）。
- **影響**: 会話から Claude Code へ頼むたびに、確認と承認の1往復が増える。
- **実装の要点**:
  - `bun run toolchain:bundle -- check` を通す。
  - `api/application/toolchain/capability-seed.test.ts` に @4 の `minImpact` の検査を足す。
  - `api/application/work/claude-code-toolchain.test.ts` の「a conversation request reaches Claude Code once saved…」は、確認を経る流れに書き直す。「確認前は何も始まらない」試験も足す。
  - seed は API の起動時に投入されるので、反映は利用者による再起動のあとになる。

### B2. domain を指定した verify で、その domain を使う結合試験も実行する

- 合意: **合意済み（2026-10-31、推奨案: import から自動で選ぶ）**。所要時間の上限は設けない。`docs/verification.md` の「所有範囲外なので別途実行」の記述を、この方式に合わせて書き直す。
- **根拠**:
  - 試験の選び方（`scripts/verification-selection.ts` の `ownedPaths`）は、domain の所有パスだけを対象にしている。
  - そのため `api/application` の試験160本と `api/infrastructure` の試験29本は、`--all` でしか実行されない。`docs/verification.md` も「所有範囲外なので別途実行」としている。
  - 一方で `docs/domains.md` は `api/application/work/tasks-http.test.ts` などを、その domain の結合試験として載せている。
  - 結合層が壊れても、domain を指定した verify は通ってしまう。
- **推奨案**: 選んだ domain の公開入口（`api/domains/<name>/index.ts`）を直接 import している `api/application/**/*.test.ts` を、試験の対象に自動で加える。import の解析は `scripts/boundaries.ts` の既存の解析器を使う。静的検査の扱い（範囲外は警告）は変えない。
- **代替案**: `scripts/domains.ts` の各 domain に、結合試験の一覧（`integration: string[]`）を手で持つ。文書との二重管理になる。
- **影響**: domain を指定した verify の所要時間が延びる。多くの domain を import する試験（`server.test.ts` など）は、ほぼ毎回実行される。
- **決めること**: 推奨案か代替案か。所要時間の上限を設けるか。

### B3. 古い検証記録を自動で整理する

- 合意: **合意済み（2026-10-31、runs は20件、自然言語受入は5件）**。`docs/verification.md` の「自動削除せず」の記述を書き直す。
- **根拠**:
  - `docs/verification.md` は「手元の過去レポートは自動削除せず」としている。
  - 実際に、2026-10-31 には `runs/` が908件・83MB まで溜まっていた（手作業で整理済み）。
  - `verification-reports/nl-acceptance` だけで 961MB ある。
- **推奨案**:
  - verify の終了時に、`runs/` を新しい順に20件と `latest.json` が指す run だけ残す。
  - 自然言語受入の出力は、新しい順に5件残す。
  - 件数は定数で持つ。
- **影響**: `bun run verify:metrics` の集計に使える履歴が20件までになる。
- **決めること**: 残す件数。

### B4. シェル実行の承認を、実際に実行するコマンドに結び付ける

- 合意: **合意済み（2026-10-31、案A）**。実装の前に、下の「案A の実装の見通し」の詳細を本書へ追記し、承認の期限（案は10分）とあわせて利用者の確認を得る。
- **根拠**:
  - 会話での承認は、確認文のあとに利用者の発言があったことだけをホストが確かめ、それを承認とみなすかはモデルが決める（`executor-delegation.ts:445-475`）。
  - 承認の時点ではコマンドがまだ決まっていない。承認のあとで担当が `cliRun` の `command`（任意のシェル文字列、最大8000文字）を組み立てる（`capabilities/contracts/cli.ts:4-16`、`application/shell/shell-adapter.ts:75-90`）。
  - 利用者が「git の状態を見る」に同意しても、実際に実行されるコマンドは利用者の目に触れない。
- **案A（推奨）: 画面での実行前承認**
  - 会話から来た実行は、shell domain で「承認待ち」の状態にし、確定したコマンドの全文を CLI 画面と通知に出す。
  - 「実行」「取消」のボタンで決める。API はコマンドの digest を照合する。
  - 期限（例10分）を過ぎたら取消にする。再起動のあとも、承認待ちのまま実行しない。
  - ブラウザ domain の承認台帳（`approvals.ts`、`valueDigest`）と同じ考え方で、モデルが承認を作れない。
- **案B: 確認文にコマンドを含める**: 確認の前にコマンドを作らせ、確認文に全文を載せる。会話ハーネスの順序を変えるので、改修が大きい。
- **案C: 読み取り系だけ確認なし**: 読み取り系のコマンドの許可リストに合うものだけ確認なしで実行し、それ以外は案Aにする。許可リストの保守が要る。
- **案A の実装の見通し**:
  - `shell_runs.state` の CHECK 制約に状態を足すため、表を作り直す移行が要る。
  - 変更は、shell の contracts・ledger・controller、CLI 画面の Web、会話への報告文に及ぶ。
  - 合意後、実装担当は本書に次の詳細を追記し、利用者の確認を得てから実装する。
    - 状態遷移
    - API
    - 画面
    - 期限
    - 再起動時の扱い
    - 試験の一覧
- **決めること**: 案A・B・C のどれにするか。期限の長さ。
- **実装した詳細（2026-10-31）**: 利用者の「止めないで最後まで」により、確認を待たず案Aと期限10分で実装した。
  - 状態: 会話 origin は `awaiting_approval` で挿入する。digest はコマンド文字列の sha256（実行台帳の複合 digest ではない）。`POST /api/shell/runs/:id/decision` の `execute` が digest と一致し、作成から10分以内なら `queued` になる。不一致は 409 `shell_run_conflict` で状態は変わらない。`cancel` と停止は `cancelled` / `cancelled_by_person`。10分超過は `cancelled` / `approval_expired`。execution origin は従来どおりすぐ `queued`。モデルはこの決定を作れない。
  - API: 決定の body は `{ decision: "execute" | "cancel", digest }`。`digest` は16進64文字。セッション一覧は承認待ちを `approvals: { id, task, command, digest }[]` で返す。
  - 画面: `artifact:cli.workspace@2`（toolchain `cli.run@4`、binding `cli.run@2`）。各承認待ちにタスク名、コマンド全文、「実行」（`shell-approve`）、「取消」（`shell-cancel`）を出す。両方とも `{ id, digest }` を送る。
  - 期限: `APPROVAL_MS` = 10分。
  - 再起動: `awaiting_approval` は残し、期限切れだけを `approval_expired` にする。`queued` は `cancelled` / `restarted`、`running` は `unknown` / `restarted`。自動再実行しない。
  - 試験: 会話 origin は表示中の digest まで起動しないこと、digest 不一致は衝突すること、取消と期限切れは起動しないこと、再起動しても承認待ちは残ること、通知にコマンド全文が含まれること、公開アーティファクトが `@2` で `shell-approve` を持つこと。
  - 移行: `shell/0002-approval`。既存の `shell/0001-runs` の SQL は変えていない。

### B5. 検索結果のタイトルとスニペットにもインジェクション対策を通す

- 合意: **合意済み（2026-10-31、案のとおり）**
- **根拠**:
  - ページの本文は llm-fetch の `contextGuard` と LLM による確認を通している（`web-research/adapters/llm-fetch.ts:211-254`）。
  - 一方、検索結果の `title` と `snippet` は長さを切るだけで、`tainted` の印を付けて会話へ渡している（`llm-fetch.ts:331-340`）。
- **案**: スニペットにも `contextGuard` を通し、重大と判定されたものは伏せる。llm-fetch の `toolset()` が行う扱いと同じにする。
- **実装（2026-10-31）**: title と snippet を別々に検査する。連結すると、短いタイトルがスニペットの判定を消すため。`deny` と `require_approval` のヒットは外し、件数だけをログに残す。本文はログに出さない。
- **影響**: 検索結果の一部が伏せられることがある。伏せた件数をログに残す。

### B6. 外部サイトでの JavaScript のボタンのクリックにも承認を求める

- 合意: **合意済み（2026-10-31）**。対象範囲（どの origin を許可リストにするか、許可リストをどこに保存するか）は未決。実装の前に本書へ案を追記し、利用者の確認を得る。
- **根拠**:
  - 承認の判定はフォーム送信だけを見ている（`approvals.ts:39-43`）。
  - そのため、利用者がログインしている実際の Brave で、単一ページアプリの「送信」「削除」「購入」などのボタンは、モデルが確定操作と申告しない限り承認なしで押せる。
- **案**:
  - 利用者がログインしているサイト（Cookie の有無は読めないので、許可リストの origin で代える）以外では、要素の効果が判定できない `button` と `[role=button]` のクリックを、確定操作として扱う。
  - どこまでを対象にするかは、A5 の運用を見てから決める。
- **影響**: 承認の回数が大きく増える。利用者の負担との兼ね合いで判断する。
- **実装（2026-10-31）**: 許可リストは空の定数 `BUTTON_COMMIT_EXEMPT_ORIGINS`。新しい保存先は作らない。Eumenes の画面は A5 のまま。GET フォーム、dialog フォーム、リンクのクリックは従来どおり承認不要。送信にならない `button` と `[role=button]` のクリックは、どの origin でも承認が要る。検査関数が `role=button` を返す。

### B7. LLM の応答が途中で止まったときの時間制限

- 合意: **合意済み（2026-10-31）**。N の値と、設定にするか定数にするかは未決。実装の前に利用者に確認する。
- **根拠**:
  - LARM の LLM の試行には、設定しない限り試行ごとの上限がない（`inference/service/attempt-work.ts:37-43`）。
  - 応答が途中で止まっても、要求全体の期限（最大180秒）まで会話の枠と推論資源を占有し続ける（`execute.ts:405-409`）。
  - `chat-stream.ts` には、データの間隔に対する時間制限がない。
- **案**:
  - 最初のデータを受け取ったあと、N 秒データが来なければ、その試行を `llm_stream_stalled` で失敗にする。
  - 最初のデータまでの待ちは、長い思考を妨げないよう今のままにする。
- **決めること**: N の値と、設定にするか定数にするか。
- **実装（2026-10-31）**: N は定数60秒（`STREAM_STALL_MS`）。設定項目にはしない。最初のバイトの前は従来の期限のまま。最初のバイトのあと60秒データがなければ、その読み取りを `llm_stream_stalled` で失敗にする。60秒は、要求全体の上限180秒の内側で、受信開始後の無通信を停滞とみなす値として置いた。本書は秒数を未決にしていた。利用者の「止めないで最後まで」により、確認を待たずこの定数で実装した。会話のモデル呼び出し失敗の一覧にも加えた。

## 4. 本書で扱わないもの

- **実行記録の保持期限**: `dialogue_runs`・`inference_attempts`・`messages` の保持期限。消してよい範囲と、記憶・World の根拠との関係を決める必要があるため、別の設計書で扱う。
- **vendor の出所**: memory の manifest にソースの commit を記録すること、World を未変更のソースから作り直すことは、別リポジトリでの作業。
- **CI の自動実行**: 利用者の判断（2026-10-31）で行わない。
- **コミットの粒度**: 作業習慣の問題で、コードの改修ではない。§0 の7で、本書の作業についてだけ1項目1コミットとする。
- **依存の監査手順**（`bun audit` の定期実行など）と、ライセンス表記の整備: 別の計画で扱う。

## 5. 実施記録

各項目の完了時に、次の形で追記する。

```
- A1（YYYY-MM-DD）: 変更 <ファイル>。試験 <コマンド> → exit <n>、<pass>/<fail>。静的検査 <実施/未実施と理由>。残り <なし/内容>。
```

- A1（2026-10-31）: 変更 `scripts/verification-run.ts`、`scripts/verification.test.ts`、`docs/verification.md`。失敗した工程は `steps/` にログを残し、`(fail)` / `FAIL ` / `×` の行、なければ末尾40行を、最大50件 `steps[].failures` に入れる。試験 `bun test scripts/verification.test.ts scripts/verification-metrics.test.ts` → exit 0、14 pass / 0 fail（fixture）。静的検査は実施（`bun run format:check` exit 0、`bun run lint` exit 0）。lint は ANSI 除去の正規表現リテラルが `no-control-regex` になったため、制御文字をソースに書かない `RegExp` に直してから通した。残りなし。
- A2（2026-10-31）: 変更 `api/domains/dialogue/service/progress.ts`、追加 `api/domains/dialogue/test/progress.test.ts`。購読者がいない run は `watchedStatuses` に残さない。試験 `bun run verify -- --domain dialogue` → exit 0（bun 439 pass / 0 fail、web 15 pass / 0 fail、fixture）。静的検査は verify に含まれる。残りなし。
- A3（2026-10-31）: 変更 `api/domains/dialogue/service/specialist-core.ts`、追加 `api/domains/dialogue/test/specialist-flush.test.ts`。巻き戻し後の flush は、`queued` または `running` の run を LARM に取り消さない。試験は A2 と同じ verify（追加分を含む 439 pass / 0 fail、fixture）。`queue_full` の通し試験は書かなかった。セッション期限と `queue_full` を一つの transaction で再現する fixture がなく、本書がスキップと記録を許している。残りなし。
- A4（2026-10-31）: 変更 `docs/domains.md`、`docs/excalidraw.md`、`spec/README.md`。`domain-docs --check` は dialogue と browser の verify に含まれ、exit 0。直さなかったもの: 未参照コード整理の索引は、計画書自身が「未コミット」と書いているので索引もそのまま。`docs/google-accounts.md` の `distribution-client.json` は、配布時に置くファイルの手順であり、削除済みの記録ではなかった。残りなし。
- A5（2026-10-31）: 変更 `api/domains/browser/service/operation-plan.ts` と browser の domain 試験、`api/application/browser` のタスク fixture と試験。Eumenes の Web origin ではクリック、確定キー、送信を伴う入力を確定操作にする。試験 `bun run verify -- --domain browser` → exit 0（bun 232 pass / 0 fail、web 52 pass / 0 fail、DesignSystem 58 pass / 0 fail、fixture）。`bun test api/application/browser` → exit 0（97 pass / 0 fail、fixture。修正前は同じ 97 件のうち 2 件が失敗し、Eumenes のタブ上のクリックを外部 origin へ移してから全体が exit 0）。利用者への影響: ブラウザ担当が Eumenes の画面をクリックする依頼は、クリックのたびに承認が要る。静的検査は verify に含まれる。残りなし。
- A6（2026-10-31）: `git rm vendor/world/eumenes-world-model-0.0.1.tgz vendor/world/eumenes-world-model-0.0.1.tgz.sha256`。`package.json`、`bun.lock`、`vendor/world/manifest.json`、`api/application/vendor.test.ts` に参照はなかった。`vendor` 配下の一致は、削除した `.sha256` 自身の1行だけだった。`bun install` はしていない。試験 `bun test api/application/vendor.test.ts` は、`verification-reports/world-integration-2026-10-31/before/` にある同じ相対パスの複製も拾い exit 1（複製は vendor が無く ENOENT）。製品のファイルだけは `bun test /Users/y.noguchi/Code/eumenes/api/application/vendor.test.ts` → exit 0、3 pass / 0 fail（fixture）。静的検査は A1 の format と lint に含まれる。残りなし。
- A7（2026-10-31）: 変更 `docs/operations.md` のみ。コードは変えていない。根拠: 既定 DB は `api/infrastructure/config.ts` 119行（`EUMENES_DB` が無ければ `./data/eumenes.sqlite3`）。ファイル名と3世代は `api/infrastructure/sqlite/pre-migration-backup.ts` 9行・63–71行・104–117行。WAL は `api/infrastructure/sqlite/index.ts` 187行、owner lock は同 168–177行、未知の migration は同 201–203行（`migration_unknown_applied`）。鍵の場所は `api/domains/settings/service/index.ts` 103–107行。バックアップは SQLite の `VACUUM INTO` だけで鍵を含まない（`api/application/db-backup.ts`）。実データでの復元はしていない。静的検査は A1 の format と lint に含まれる。残りなし。
- B1（2026-10-31）: 変更 `api/domains/capabilities/bundles/terminals-screen.bundle.json`（`claude-code.request@4` に `minImpact: modify_existing`）、`api/application/toolchain/capability-seed.test.ts`、`api/application/work/claude-code-toolchain.test.ts`、`api/application/toolchain/capability-upgrade.test.ts`。試験 `bun test api/application/work/claude-code-toolchain.test.ts` → exit 0、4 pass / 0 fail（fixture）。`bun test api/application/toolchain/capability-seed.test.ts api/application/toolchain/capability-upgrade.test.ts` → exit 0、4 pass / 0 fail（seed 3、upgrade 1、fixture）。`bun run toolchain:bundle -- check api/domains/capabilities/bundles/terminals-screen.bundle.json` → exit 0。静的検査は第2部のまとめで実施。seed の反映は再起動待ち。残りなし。
- B2（2026-10-31）: 変更 `scripts/boundaries.ts`、`scripts/verification-selection.ts`、`scripts/verify.ts`、`scripts/test-domain.ts`、`docs/verification.md`、`scripts/verification.test.ts`。選んだ domain の公開入口を直接 import している `api/application` の試験を、その domain の verify と test:domain に含める。間接の import はたどらない。試験 `bun test scripts/verification.test.ts scripts/verification-metrics.test.ts` → exit 0、16 pass / 0 fail（fixture。B3 の整理試験を含む）。静的検査は第2部のまとめで実施。残りなし。
- B3（2026-10-31）: 変更 `scripts/verification-run.ts`、`docs/verification.md`、`scripts/verification.test.ts`。`VERIFY_RUNS_KEPT` は20、`NL_ACCEPTANCE_RUNS_KEPT` は5。verify の終了時（成功・失敗・中断）に、`runs/` は新しい順20件と `latest.json` の run、`nl-acceptance/` は新しい順5件を残す。試験は B2 と同じコマンド（exit 0、16 pass / 0 fail、fixture。実ディレクトリは消していない）。次に本番の `bun run verify` を実行すると、手元の記録がこの件数まで減る。静的検査は第2部のまとめで実施。残りなし。
- B4（2026-10-31）: 変更 shell の contracts・repository（`shell/0002-approval`）・ledger・service・controller、`api/application/shell/shell-reports.ts`、`client/shell.ts`、`api/domains/capabilities/bundles/cli.bundle.json`（`cli.run@4`、`binding:cli.run@2`、`artifact:cli.workspace@2`）、`packages/artifact-ui` の端末画面と `WorkspaceAction`、`web/src/domains/shell/toolchain-adapter.tsx`、`docs/shell.md`、`README.md`、対応する試験。会話 origin は画面の「実行」まで起動しない。期限は10分。再起動しても承認待ちは実行しない。試験 `bun test api/domains/shell/test/shell.test.ts api/application/shell/cli-toolchain.test.ts` → exit 0、16 pass / 0 fail（fixture。shell 14、cli 2）。`bun test api/application/migrations.test.ts` → exit 0、17 pass / 0 fail（fixture。GOLDEN の既存 SQL は無変更）。`bun run toolchain:bundle -- check api/domains/capabilities/bundles/cli.bundle.json` → exit 0。画面のクリック確認は、起動中の Web が再起動前のプロセスのため未実施。起動・再起動はしていない。残りは再起動待ち。レビュー後の修正: 期限切れの「実行」は取消をコミットしてから `shell_not_found` にする（書き込み中の例外で取消が戻らない）。承認通知と完了通知は会話の8000字に収める。長いコマンドは画面の全文を指し、長い出力は通知内で短くする。試験 `bun test api/domains/shell/test/shell.test.ts api/application/shell/cli-toolchain.test.ts` → exit 0、17 pass / 0 fail（fixture）。`bun run typecheck` → exit 0。
- B5（2026-10-31）: 変更 `api/domains/web-research/adapters/llm-fetch.ts`、`api/domains/web-research/test/web-research.test.ts`。検索の title と snippet を、ページ本文と同じ `createBuiltinContextGuard` で別々に検査する。`deny` または `require_approval` のヒットは結果から外し、件数だけを `web_research.hits_withheld` に出す。試験は B6 のコマンドに含まれる（exit 0、fixture）。静的検査は第2部のまとめで実施。残りなし。
- B6（2026-10-31）: 変更 `api/domains/browser/service/approvals.ts`、`api/domains/browser/service/operations.ts`、`api/domains/browser/contracts/ports.ts`、`api/domains/browser/adapters/mcp-driver.ts`、browser の試験。許可リストは空。送信にならない `button` と `[role=button]` のクリックは承認が要る。GET・dialog・リンクは承認不要。Eumenes の画面は A5 のまま。試験 `bun test api/domains/browser api/application/browser api/domains/web-research/test/web-research.test.ts api/infrastructure/chat-stream.test.ts api/infrastructure/chat-diagnostics.test.ts` → exit 0、374 pass / 0 fail（fixture。B5 と B7 の読み取り試験を含む）。静的検査は第2部のまとめで実施。残りなし。
- B7（2026-10-31）: 変更 `api/infrastructure/chat-stream.ts`、`api/infrastructure/chat-stream.test.ts`、`api/domains/dialogue/service/routed-turn.ts`。最初のバイトのあと60秒無通信なら `llm_stream_stalled`。最初のバイトの前は従来どおり。会話のモデル呼び出し失敗にも加えた。試験は B6 のコマンド（chat-stream を含む 374 pass / 0 fail、fixture）と、その後の `bun test api/infrastructure/chat-stream.test.ts` → exit 0、7 pass / 0 fail。静的検査: `bun run lint` → exit 0、`bun run typecheck` → exit 0（2,680 files）、`bun run size:check` → exit 0（2002 files）。`bun run verify` は API と Web が起動中のため未実施。残りなし。
- 第2部の静的検査（2026-10-31）: `bun run lint` exit 0、`bun run typecheck` exit 0、`bun run size:check` exit 0。変更ファイルは oxfmt 済み。`bun run verify` は 127.0.0.1:8787 と 127.0.0.1:5173 が listen 中のため未実施。サーバーの停止・起動・再起動はしていない。

## 6. Risks / Open Questions

- A5 は、Eumenes の画面を対象にしたブラウザ担当の依頼で、承認の回数を増やす。§4.4 の意図どおりだが、運用で負担が大きければ、対象を絞る案を第2部に起こす。
- A1 で出力をパイプ経由にすると、子プロセスが TTY を検出しなくなり、色や進捗表示が変わる可能性がある。端末の表示が大きく崩れる場合は、その旨を記録して利用者に判断を仰ぐ。
- 第2部の B2 と B4 は実施済み。domain 指定の verify は結合試験の分だけ長くなり、会話からのシェルは画面での「実行」まで起動しない。B6 は外部サイトの未判定ボタンでも承認が増える。B3 は次の本番 verify で手元の記録を20件と5件まで消す。B7 の60秒は未決だった秒数を、止めずに終える指示で定数にした。
