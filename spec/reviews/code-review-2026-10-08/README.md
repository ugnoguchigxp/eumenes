# Eumenes 全体コードレビュー・修正記録（2026-10-08）

対象は `/Users/y.noguchi/Code/eumenes`、起点commit `75e7e4b7561411a00573712bf9efc550cffed380`。修正後のソースは [snapshot.json](snapshot.json) のSHA-256一覧で識別する。未commitの変更を含む。technical / deep / serviceとして、単一ユーザー・macOS・loopback APIのプロトタイプを評価した。

**修正前に確認した11件をすべて修正し、再評価時の未解決confirmed/suspectedは0件。** 技術品質の正式点は保留。暫定値は 62.7/100、評価した重みは 78.0%、未知部分を含む範囲は 48.9–70.9、確信度Medium。除外した軸の重みは0%で、未調査の基準をunknownとして残した。上限capなし、raw値と暫定値は同じ。事業性・将来性は今回の依頼対象外で採点していない。これはリリース認証や欠陥が存在しないことの証明ではない。

優先修正は完了。単一writer、domainの公開操作、取消・権限世代のfence、有限回の復旧を維持する。次の受入は実LARM/クラウドと実機器の3往復。未実施なので音声MVP完成とは判断しない。

## 対象と調べ方

Web/CLIから認証API、設定保存、推論・LARM、会話・queue、SQLite、音声受付・再生まで正常系と取消・失敗・再起動を追跡した。scheduler、SSE、migration、検証スクリプト、Markdown表示も確認した。共通UIはリスクのある部品を抽出して読み、部品試験は全体を実行した。生成物・vendor・すべての共通UIの全行を監査したという意味ではない。

修正後の追加確認は同じレビュアーが行った。1回目は取消・採用・暗号文削除・CLIの呼出経路、2回目は変更全体と既存の復旧・stream・境界試験との整合を確認し、新たな修正必須事項は見つからなかった。試験だけのglobalが不具合を隠した箇所はstubを除去した。音声writerのguardは一時的に取り除く負の対照で試験が失敗することを確認し、復元した。

## 修正した不具合

| ID | 重大度 / 優先度 | 条件と影響 | 修正・受入 |
| --- | --- | --- | --- |
| F01 | High / P1 | 未回答の過去入力があり、3件の履歴が予算を超える → providerに今回の問いが届かず別内容へ回答する | 最後のsystemと今回入力を必ず保持し、収まらない場合は明示失敗。修正済み・回帰試験成功。根拠: `api/domains/larm/service/index.ts:879; regression api/domains/larm/test/larm.test.ts:913` |
| F02 | Medium / P1 | URLが不正、またはsame-hostでbaseUrl未設定 → safeParseがthrow、または保存後接続できない | 解析可能なURLだけを追加検証し、same-hostにはURLを要求。修正済み・回帰試験成功。根拠: `api/domains/settings/contracts/index.ts:108; regression api/domains/settings/test/settings.test.ts:189` |
| F03 | Medium / P1 | キー置換・キー削除・接続削除 → 不要な暗号文が残り、全削除後もmaster key再生成が妨げられる | 現在のcredentialだけを同一transactionで残す。修正済み・回帰試験成功。根拠: `api/domains/settings/service/index.ts:281; regression api/domains/settings/test/settings.test.ts:215` |
| F04 | High / P1 | accept後、writer callback前にstopする → 停止後のturn保存とASR呼出が始まる | writer内でもsession世代を確認。修正済み・回帰試験成功。根拠: `api/domains/voice-dialogue/service/index.ts:360; regression api/domains/voice-dialogue/test/voice.test.ts:212` |
| F05 | Medium / P1 | 推論receiptの採用が拒否される → run failedとqueue completedが食い違う | settleから業務失敗を返しjob/attemptも同一transactionでfailedにする。修正済み・回帰試験成功。根拠: `api/domains/dialogue/service/index.ts:232; api/domains/queue/service/runner.ts:198; regression api/domains/dialogue/test/queue.test.ts:246` |
| F06 | Low / P2 | 同じsignalで繰り返し待機する、または取消済みsignalを渡す → listener蓄積・停止遅延 | 完了とabortを共通cleanupにし、事前abortは即時resolve。修正済み・回帰試験成功。根拠: `api/domains/queue/service/runner.ts:49; regression api/domains/queue/test/sleep.test.ts:5` |
| F07 | Medium / P1 | audio開始のawait中にstopする → 消えたcontextを参照し遅いerror通知が出る | 開始したcontextを保持しawaitごとにidentity/disposed確認。修正済み・回帰試験成功。根拠: `web/src/domains/audio/controller/index.ts:118; regression web/src/domains/audio/test/audio.test.ts:213` |
| F08 | Medium / P1 | Bunがfetchを含まない接続不能TypeErrorを返す → 約束した終了コード5にならず呼出側が原因を誤認する | transportで型を分け、取消は保持してCLIで接続不能を判定。修正済み・回帰試験成功。根拠: `client/transport.ts:9; cli/index.ts:127; regression api/application/cli.test.ts:24` |
| F09 | Medium / P1 | --request-id値欠落/不正、または不正API URL → 重複送信の危険、設定エラーの終了コード不一致 | 引数を送信前検証しclient初期化も設定エラー処理内へ。修正済み・回帰試験成功。根拠: `cli/index.ts:12-40; regression api/application/cli.test.ts:38` |
| F10 | Medium / P1 | 通常の製品環境でalt省略/メニュー選択/画像Escape → ReferenceErrorにより表示やclick処理が失敗 | 暗黙globalを除き標準altと通常callbackにし、偽のglobal宣言も削除。修正済み・回帰試験成功。根拠: `packages/design-system/src/components/DropdownMenu/DropdownMenu.tsx:249; packages/design-system/src/components/ImageViewer/ImageViewer.tsx:44; regression packages/design-system/src/components/{DropdownMenu,ImageViewer}/*.test.tsx` |
| F11 | Low / P2 | 負/超過value、またはmax=200 → ARIA値と見た目の進捗率が食い違う | value/maxを正規化して表示とRadix両方へ適用。修正済み・回帰試験成功。根拠: `packages/design-system/src/components/ProgressBar/ProgressBar.tsx:38; regression packages/design-system/src/components/ProgressBar/ProgressBar.test.tsx` |

High 2件、Medium 7件、Low 2件。別の根本原因は分け、同じglobal依存の画像ビューア・メニューはF10へ統合した。詳細な反証、変更箇所、受入条件、影響基準は [review.json](review.json)。`withdrawn` はここでは「修正・検証によって現在の未解決事項から除いた」の意味で、元の指摘が誤りだったという意味ではない。修正前のconfirmedは [baseline.json](baseline.json) に保持した。

## 検証

| 確認 | 条件 | 結果 |
| --- | --- | --- |
| `bun run verify:all` | format/lint/typecheck、domain境界、API、Web、build、ブラウザ | 成功。API 136件、Web 15件、ブラウザ8件。65,316ms。[最終ログ](evidence/final-all.log) |
| `bun run verify -- --domain <name>` | settings / larm / queue / inference / dialogue / voice-dialogue / audio | 全7選択で成功 |
| `bun run test`（共通部品のディレクトリ） | unit、最終ソース・globalに依存しない修正後 | 56ファイル、1,079件成功 |
| 新規・強化回帰試験 | 一時DB、明示fixture token、loopbackサーバー、AudioContext偽物 | 修正前の不具合検出、修正後の成功を保存 |

最終ビルドでImageViewerへ渡す引数の型不一致を検出し、画像要素だけで空URLを避ける形に補正した。その後、部品37件・部品全体1,079件・全体検証を再実行して成功。生成bundleも更新し、実artifactの静的描画を確認した。[生成物hash](generated-artifacts.json) を保持する。

実行環境はBun 1.4.2 / Node 24.11.1 / macOS。fixtureの結果とlive・実機器の受入を区別した。製品DB・設定・秘密情報は変更していない。各実行ログは [evidence/](evidence/)、実行条件と終了コードは [execution-records.json](execution-records.json)。初期の音声試験ではBunのassertionによる実行順の問題があり、handlerを先に付けてからstopする形へ直した。中間の `fixed.log` はその試験の最終合格記録には使っていない。

## 技術品質の内訳

点数は各軸で**評価できた基準のみ**の観測値。未調査を0点にしていない。基準0–4の根拠と反証はledgerにある。重みと集計はskillのrubric 1.1.0 / serviceを固定して計算した。

| 軸 | 観測値 /10 | 基礎重み / 実効重み% | 評価率% | 確信度 | 根拠・不足 |
| --- | ---: | ---: | ---: | --- | --- |
| 設計と境界 | 6.7 | 8 / 8.0 | 100.0 | Medium | E01–02: 公開入口・境界検査・単一writer |
| 正しさ | 7.5 | 15 / 15.0 | 100.0 | High | E03–08: 不正入力・履歴・取消・採用試験 |
| セキュリティ | 5.0 | 20 / 20.0 | 100.0 | Medium | E03–04: loopback/Bearer/Origin、暗号化・世代失効 |
| 失敗・復旧 | 6.7 | 15 / 15.0 | 100.0 | Medium | E02・04・07: crash/restart・有限復旧・資源上限 |
| 保守性 | 6.3 | 8 / 8.0 | 66.7 | Medium | E01・05・09: domain所有・局所修正、長期費用は不明 |
| 共通部品 | 5.0 | 4 / 4.0 | 66.7 | Medium | E08・05: 共通transport/UI、全重複比較は未実施 |
| 検証 | 6.7 | 10 / 10.0 | 100.0 | High | E05–07: 実行・再現・負の対照、CI履歴は不明 |
| 依存・配布 | 保留 | 8 / 8.0 | 0.0 | Unknown | 依存権利・到達可能な脆弱性・実配布は未監査 |
| 性能 | 保留 | 6 / 6.0 | 0.0 | Unknown | 実環境の遅延・費用・負荷測定なし |
| 運用・操作 | 5.0 | 6 / 6.0 | 33.3 | Medium | E08・10: 状態表示、実機器と導入全工程は未検証 |

計算結果は [score-summary.json](score-summary.json)。修正前ledgerは実証した失敗だけに採点し、同等の肯定根拠が揃わない基準はunknownとしたため、修正前後の総点比較には用いない。過去のdesktop profile評価とも単純比較しない。

## 保持すべき設計と残る受入

| 参照 | 次の行動 | 依存・受入条件 |
| --- | --- | --- |
| E01–02 | domain所有・公開操作・単一writerを維持 | 横断変更では利用側domainと全体検証を実行 |
| E04・07 | cancellation/epoch fenceと限定した復旧を維持 | 遅い結果を採用しない、SSE公開後のreplayをしない既存試験を保持 |
| E09 / Unknown | 実LARM・クラウドの接続、失効、quota、復旧を確認 | 実サービスでの受入。今回fixture成功からlive成功を推定しない |
| E09 / Unknown | 実マイク・スピーカーで3往復と停止操作を受入 | 設定した入出力機器で観測。音声MVP完成の前提 |
| supply_chain / Unknown | 実配布前に依存provenance・脆弱性の到達性・権利とartifact整合を確認 | 現在の依存版・利用条件・実際の配布工程が必要 |
| performance / Unknown | 実負荷の遅延・資源・費用を測定 | 代表端末、入力、provider、予算を固定して比較 |

実装改善として抽象化追加、DB分割、広範な書換えを行う根拠は今回得ていない。現在の規模では既存の公開操作と単一writerを保ち、失敗する具体的な境界だけを直す方針を採った。受入不足は未解決のコード欠陥と混同しない。

## 証跡

[snapshot.json](snapshot.json)、[review.json](review.json)、[baseline.json](baseline.json)、[score-summary.json](score-summary.json)、[baseline-summary.json](baseline-summary.json) を保持。集計は `score_review.py` で検証しており、計算値を手入力で変更していない。レビュー後にコードを変更した場合はsnapshotと受入を更新する。

ContextStill: `initial_instructions` 1回（作業開始時）、`context_compile` 1回、`compile_eval` 1回。compile run: `00000000-0000-0000-18dc-6e5a42e58299`。
