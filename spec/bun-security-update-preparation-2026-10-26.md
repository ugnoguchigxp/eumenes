# Bun 1.4.4 セキュリティ更新の準備

状態: **Bun 本体・プロジェクト指定・CI を 1.4.4 に更新済み。許可されたサーバー不使用範囲の検証を完了。全体チェックには旧版でも再現する既存の失敗あり。**
確認日: 2026-10-26（日本時間）。

準備後、利用者から更新実行と依存エラー修正の依頼を受けた。サーバーについては「サーバーを使わない範囲で検証」と指定されたため、下記の準備時の手順よりこの制約と「更新実施結果」を優先する。

## 目的と範囲

Bun 1.4.3 から 1.4.4 へ速やかに更新するため、公式根拠、互換性、変更箇所、切替・復旧手順を揃える。既存の `bun check`、SQLite 試験、固定インストール、domain 検証を再利用する。

準備時は本書・索引・証跡・未適用パッチのみを作成し、更新依頼後にパッチの4ファイルと手元の実行ファイルを更新した。アプリケーションの判断方式、LLM 指示、API、DB スキーマ、接続設定、依存パッケージの版は変更していない。main で作業し、既存の別作業の差分を保持した。サーバーの停止・起動・再起動は実施していない。

## 更新を優先する根拠

- [公式リリース](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4)は正式版。公開日時は 2026-10-22 10:11:32 UTC（同日19:11:32 JST）。
- [公式リリースノート](https://bun.com/blog/bun-v1.4.4)は TLS、HTTP、WebSocket、Brotli、DB クライアント、パッケージ管理などのセキュリティ修正を列挙している。個々の修正の深刻度や CVE 対応表は同ページでは公表されていないため、すべてを Critical と扱わない。
- Brotli の CVE-2026-111497 は不正な圧縮データによる範囲外書き込み。[上流の修正版](https://github.com/google/brotli/releases/tag/v1.2.1)は遠隔コード実行につながる脆弱性として告知している。[Bun 側の報告](https://github.com/oven-sh/bun/issues/46352)では 1.4.3 が影響を受け、`fetch()` の `Content-Encoding: br` 応答や `node:zlib` から到達することが説明され、修正は完了扱いになっている。

Eumenes は `api/application/server.ts` の `Bun.serve`、LARM・cloud adapter の HTTP 通信、依存ライブラリを通じた外部通信を使用する。localhost 待受であっても外向き通信があるため、Bun 更新を優先する。これは利用経路からの影響評価であり、この環境での攻撃成立や侵害を確認したものではない。

互換性確認では TLS の信頼ルート更新、WebSocket の送受信・終了、厳密化された固定依存の検証、vendor の `file:` tarball を重視する。独自 CA／mTLS を使う環境では、`ca` だけではクライアント証明書を要求しなくなった点も確認する。

## 現状と準備済み資材

| 項目 | 確認結果 |
| --- | --- |
| 実行環境 | macOS arm64 |
| 準備時の Bun | `/Users/y.noguchi/.bun/bin/bun`、`1.4.3+c6da4a4d3` |
| 更新候補 | `1.4.4+38afee6c8`、公式 macOS arm64 zip を別配置 |
| 候補の実行ファイル | `/Users/y.noguchi/.codex/tmp/eumenes-bun-1.4.4-20261026/bun-darwin-aarch64/bun` |
| zip の SHA-256 | `c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510` |
| 整合性確認 | GitHub Release API の asset digest と `SHASUMS256.txt` の両方に一致。GPG 署名の検証は未実施 |
| 準備時の版指定 | `package.json`、`.github/workflows/verify.yml` ともに 1.4.3 |
| 型定義 | `@types/bun` 1.3.14 を維持。ランタイムのセキュリティ修正とは別管理 |

[update.patch](verification/bun-security-update-2026-10-26/update.patch) は次の4ファイルだけを変更する。準備時の `git apply --check` は成功し、更新依頼後に適用済み。

1. `package.json`: `packageManager` を `bun@1.4.4` にする。
2. `.github/workflows/verify.yml`: CI の Bun を 1.4.4 にする。
3. `README.md`: セットアップ前提を更新する。
4. `docs/verification.md`: 型検査の使用版とリリースノート参照を更新する。

`packageManager` の変更だけでは手元の実行ファイルや起動済みプロセスは更新されない。`bunfig.toml` の公開後7日待機は npm 依存の解決に関する設定であり、公式バイナリの別配置を妨げない。待機ルール・例外の変更は不要だった。

## 事前検証の実績

結果の詳細は [preflight.json](verification/bun-security-update-2026-10-26/preflight.json)、取得根拠は [release-evidence.json](verification/bun-security-update-2026-10-26/release-evidence.json)、検査時の commit・manifest hash は [baseline-inputs.json](verification/bun-security-update-2026-10-26/baseline-inputs.json) に保存した。

| 検証 | 現行 1.4.3 | 候補 1.4.4 |
| --- | --- | --- |
| SQLite の既存試験5ファイル | 13 pass / 0 fail | 13 pass / 0 fail |
| root `bun check` | 今回未実施 | 成功 |
| DesignSystem 通常用 `bun check -p packages/design-system/tsconfig.json` | 今回未実施 | 成功 |
| DesignSystem build用 `bun check -p packages/design-system/tsconfig.build.json` | 今回未実施 | 成功 |
| dots MVP `bun check -p scripts/dots-mvp/tsconfig.json` | 今回未実施 | 成功 |
| 別配置での `install --frozen-lockfile --ignore-scripts` | 今回未実施 | 873 packages installed、終了0、lockfile 不変 |

SQLite 試験は一時 DB のみを使用。インストールは root と workspace の manifest、lockfile、bunfig、必要な vendor tarball だけを別ディレクトリへコピーし、候補の `packageManager` で実行した。製品 DB・設定・秘密はコピーしていない。元の manifest と lockfile の hash は検証後も一致した。

これは部分試験と依存解決の事前確認であり、更新完了や全体互換性の保証ではない。`--ignore-scripts` により lifecycle／postinstall は未検証。domain の正式検証は DesignSystem の共有出力を再生成し、試験によっては待受を開始するため、今回省略した。全体検証・ブラウザ E2E・live・実機器受入も未実施。

## 準備時に定めた更新手順

以下は準備時の手順。実施範囲と結果は「更新実施結果」を参照。利用者の指定に従い、サーバー操作とそれを必要とする試験は実施していない。

1. サーバー操作の明示許可を得て、同じ checkout を使う開発・検証処理と停止時点を調整する。現時点の他者の変更、稼働中の仕事、実行ファイルの場所・版を再確認する。
2. 次のパッチを再確認して適用する。ほかの差分を含めて一括で戻したり、commit したりしない。

   ```sh
   git apply --check spec/verification/bun-security-update-2026-10-26/update.patch
   git apply spec/verification/bun-security-update-2026-10-26/update.patch
   ```

3. 実行中の仕事を安全に終え、許可されたサーバー停止を行う。現在の Bun 実行ファイルを更新用資材のディレクトリに退避し、取得・照合済みの候補を `~/.bun/bin` 内の一時ファイルへコピーしてから rename で置き換える。`bunx` は現行の Bun を指す symlink のため別更新は不要。[公式の導入・更新方法](https://bun.com/docs/installation)を使う場合も、採用版が 1.4.4 であることを確認する。
4. `command -v bun`、`bun --version`、`bun --revision` で採用版を確認する。別プロセス・別ホスト・埋込み実行ファイルはそれぞれ別に確認する。
5. 部分→結合の順で、以下を実行する。失敗した場合は証跡を保存し、対象外のコードや期待値を修正しない。

   ```sh
   bun install --frozen-lockfile
   bun run verify -- --domain larm --domain inference
   bun run verify -- --domain dialogue --domain voice-dialogue --domain audio
   ```

   postinstall と共有 DesignSystem build の成功、lockfile に意図しない変更がないことを確認する。横断的な変更のため、続いて `bun run verify:all` で全体の通し検証を行う。Linux・macOS の CI 結果は手元の結果と分ける。
6. 許可された起動を行い、状態 API、HTTPS 接続、会話の応答、通知・切断復帰、CLI を確認する。ブラウザ試験は `tests/browser/voice.spec.ts` など対象ファイルを指定し、fixture と live の結果を分ける。保存済み接続先は backend の settings domain の読み取り専用操作で取得する。
7. Bun の更新、版指定と CI の整合、必要な検証、稼働プロセスの新バージョン採用まで確認して初めて「更新完了」とする。実機器の3往復受入なしに音声 MVP の完成を宣言しない。

## 障害時の復旧

失敗が更新に起因するかを現行版と比較し、`bun run logs -- --level warn` と相関 ID で原因を絞る。復旧のためのサーバー停止・起動も明示許可の範囲で実施する。

切り戻す場合は退避した実行ファイルを戻し、パッチの4ファイルは今回の変更箇所だけを戻す。`git apply -R --check` で確認し、後続編集と衝突する場合は一括適用しない。DB migration や依存版変更は今回のパッチに含まれない。旧版ではセキュリティ修正が失われるため、恒久的な復旧扱いにせず、失敗箇所の修正と再更新の条件を残す。

## 別の更新対象として判明したこと

手元の `node` は mise 配下の **v24.11.1**。`scripts/dev.ts` は画面用 Vite を Node.js で起動する。[Node.js の公式セキュリティ告知](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)では同じ Brotli 脆弱性を含む修正が **24.22.1** に入っている。Bun の更新ではこの Node.js は更新されない。今回は調査結果の記録だけとし、Node.js の更新・設定変更は行っていない。

## 更新実施結果

`/Users/y.noguchi/.bun/bin/bun` は **1.4.4+38afee6c8**。照合済み zip と展開済み候補の内容を再照合し、旧実行ファイルを `/Users/y.noguchi/.codex/tmp/eumenes-bun-1.4.4-20261026/bun-1.4.3-backup` に退避後、同一ディレクトリ内の一時ファイルから rename して更新した。`bunx --version` も 1.4.4。プロジェクトと CI の指定、README、検証手順も更新済み。CI 自体は未実行。

| 検証 | 結果 |
| --- | --- |
| `bun install --frozen-lockfile` | 終了0。164 packages installed。postinstall の DesignSystem 型検査・型宣言生成・ビルド成功 |
| `bun run verify -- --domain larm` | pass。347試験成功、0失敗。全12工程成功 |
| `bun run verify -- --domain inference` | pass。191試験成功、0失敗。全12工程成功 |
| root 型検査 | 2,673ファイル、エラーなし |
| dots MVP 型検査 | 10ファイル、エラーなし |
| SQLite 試験 | 13試験成功、0失敗 |
| Web production build | 成功。既存の chunk／静的・動的 import に関する警告あり |

LARM・推論 domain の試験は HTTP／agent の fake と一時 DB を使い、サーバー起動を含まないことを確認して実行した。依存パッケージの解決・読み込みエラーは確認されず、追加の製品コード修正や依存版変更は不要だった。`bun.lock` は準備時と同じ hash を保持している。

詳細は [update-state.json](verification/bun-security-update-2026-10-26/update-state.json)、[検証一覧](verification/bun-security-update-2026-10-26/update-verification.json)、[LARM の正式レポート](verification/bun-security-update-2026-10-26/larm-domain-report.json)、[推論の正式レポート](verification/bun-security-update-2026-10-26/inference-domain-report.json)。

### 全体チェックで残った既存の問題

次の6項目は、退避した 1.4.3 で同じチェックを実行しても同じ診断となった。書式の時間表示だけを比較から除いている。Bun 1.4.4 固有の失敗とは判断せず、担当外のコード・基準値・期待値は変更していない。

| 項目 | 内容 |
| --- | --- |
| format | 既存の41ファイルに書式差分 |
| lint | `ConversationComposer`／`ErrorReportDialog` の render 中の ref 参照、`browser-task-tools` の制御文字正規表現、`StepGuide` の非対話要素へのイベント |
| domain 境界 | visual-analysis 関連の非公開 entry 参照と `voice-dialogue -> settings` の未使用依存宣言 |
| SQL 境界 | inference から settings 所有の `settings_document` への参照 |
| domain 文書 | `docs/domains.md` の表と `scripts/domains.ts` の不一致 |
| bundle budget | entry 176,960 B／initial 323,799 B が既存基準の許容値を超過 |

bundle は 1.4.3 でも別の出力先へ再ビルドし、初期 JS の各ファイルの gzip サイズを含む計測結果が 1.4.4 と完全一致した。比較根拠は [baseline-comparison.json](verification/bun-security-update-2026-10-26/baseline-comparison.json) と [web-build-comparison.json](verification/bun-security-update-2026-10-26/web-build-comparison.json)。

利用者の指定により、待受を必要とする全体試験・ブラウザ E2E・live・実機器受入、製品サーバーの起動・停止・再起動は未実施。稼働中プロセスへの新版反映は確認していない。全体検証合格とは報告しない。

## 完了条件と残作業

- [x] 公式の公開情報、セキュリティ修正、現在の使用版・導入先を確認。
- [x] 公式の更新用実行ファイルを別配置し、digest と公開 checksum を照合。
- [x] 既存の型検査・SQLite 試験・固定インストールによる事前確認。
- [x] 最小更新パッチ、切替・復旧手順、未検証範囲と証跡を保存。
- [x] 実環境の実行ファイル更新と版指定パッチ適用。
- [x] postinstall、サーバー不使用の domain 検証、root 型検査、Web build。
- [x] 全体チェックの失敗を旧版と比較し、更新固有の依存エラーと区別。
- [ ] 既存の全体チェック6項目の改善（今回の依存更新とは別の担当範囲）。
- [ ] CI と、サーバーを必要とする検証・起動済みプロセスの新版反映（今回未実施）。

製品コードの分岐・固定応答・判断方式の追加はない。Bun 本体と版指定の更新、許可された範囲の検証を完了し、既存の全体チェック失敗と未実施の検証を区別して扱う。
