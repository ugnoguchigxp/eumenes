# 記録アーティファクトの実装と検証

2026年10月13日。「記録」一つの入口から「AIの利用」「ツールチェーン」の2タブを開く。行の詳細、展開・スクロール位置の保持、更新、追加読み込み、取得手順の有効・無効・削除、診断JSONの保存を対象とした。旧設定画面は移行完了まで維持する。

## 接続と保存先

表示定義は `{"view":"records-workspace","source":"settings-records","title":"記録"}`。既存の `kind:openui` と共通Rendererを使う。新しいArtifact種別、LLMツール、API、DB migrationは追加していない。

DesignSystemの `RecordsWorkspace` が既存Tabs、展開する行、候補表、取得手順の削除確認、共通のデータと診断を描画する。props/eventsだけを扱い、API・認証を持たない。Webのsettingsホストが既存のclient経由で取得・更新し、OpenUI adapterが許可されたイベントを送る。記録sourceを含む場合だけ取得用ホストを開く。字幕プレビューとのlayout合成も結合試験で確認した。

| 内容 | 公開API | 保存先・変更範囲 |
| --- | --- | --- |
| AIの利用 | GET `/api/inference/usage` | 既存 `inference_attempts` / `inference_requests` の直近100件。読取のみ |
| 選択の記録 | GET `/api/toolchain-history/selections` | `toolchain_selections`。既存50件取得とcursorを使用。30日保持 |
| 取得手順 | GET `/api/toolchain-history/recipes` | `toolchain_recipes`。URL、読む箇所、利用状態、成功・失敗、最終成功 |
| 有効・無効 | POST `/api/toolchain-history/recipes/:id/state` | 既存writer操作でstate更新。有効化時の連続失敗数の扱いも既存契約 |
| 削除 | DELETE `/api/toolchain-history/recipes/:id` | 既存writer操作。画面で対象を示し、確認後に実行 |
| 診断保存 | GET `/api/settings/diagnostics`、`/api/inference/larm`、`/api/inference/usage` | 既存診断と利用先のJSONを端末に保存。設定・会話・認証情報を更新しない |

記録と取得手順は設定の共通下書きに含めない。取得手順の変更後は共通の履歴cacheも古い状態にし、旧画面を再表示した際も再取得する。source、revision、操作の型、取得済みの手順ID、重複IDと同時操作を検査する。HTTP失敗時に更新・削除を自動で再送しない。取得失敗を空の記録と混同しない。URLリンクはhttp/httpsに限定する。

画面の閉鎖でHTTP取消を通知し、旧世代の結果を採用しない。診断の読取が遅れて返ってもファイル保存を開始せず、同じホストの新世代にも旧結果を採用しない。ダウンロード用Blob URLは解放する。表示JSONに本文、認証情報、Blob URL、動的な取得状態を保存しない。

## 検証結果

- 部分・結合：settings domainはbackend 23件、Web 55件が成功。新規の4件は操作契約・重複と同時操作・古い結果の破棄、失敗時の自動再送なし、OpenUIと字幕の合成、既存clientの更新と設定保存の不使用を確認した。
- 共通描画：artifact domain 49件成功。toolchain-history domain 6件成功。DesignSystemの部品単体1件とStorybook Chromium 5件成功。
- 通し：`tests/browser/settings-records.spec.ts` の2件成功（成功した実行は1.2分）。通常API・隔離DB・Chromiumを使用。ツールチェーン55件と手順2件はAPI起動前に所有domainの公開transaction操作で準備し、UIは通常API経由で読み書きした。AIの利用35件のみ既存応答契約に沿った固定HTTP応答を使用した。
- 通しの操作：両タブの切替、展開行と実scrollTopの保持、更新後の保持、50件から55件への追加取得、候補表、手順の無効・有効・停止中から有効、削除取消と確認削除、API読取と再読込での反映を確認した。設定文書が変わらないことも確認した。
- 保存と失敗：ダウンロードの実ファイル名・JSONの診断／利用先／35件の利用記録と認証tokenの不在を確認。読取・更新・診断保存をHTTP 503で失敗させ、表示と明示的再試行、失敗した保存でdownloadが発生しないことを確認した。
- 表示：通常幅と390pxのタブ操作・描画を確認。画像を目視確認した。[通常幅](records-wide.png)、[狭い画面](records-narrow.png)。
- root型検査はbackendの後続変更が入る前に1,136ファイル成功。DesignSystem/Webのproduction build成功。所有差分のwhitespace検査成功。
- 実環境は読取のみを実行し、既存の認証手順を通して利用記録100件、選択記録12件、取得手順0件、診断、LARMの公開接続情報をすべて取得できた。通常運用の手順変更・削除や診断ファイルの保存は実行していない。未認証での試行は401となり、認証条件も維持されている。

初回のブラウザ実行は試験tokenが認証契約の最小長を満たさず起動失敗したため、fixtureのtokenを修正した。次の実行は同じトークン数を持つ35行へ曖昧なlocatorを使って停止したため、展開対象の行に限定した。製品の認証条件や試験の期待値は弱めていない。React検査が指摘したrender中のref読取とeffectからの同期setStateは、外部操作のsessionと状態の変化に対応する版管理へ修正した。

全体検証 `verify:all` は担当外の既存 `api/domains/agent-runtime/service/step-actions.ts#createStepActions` が306行で300行の上限を超え、最初の段階で停止した。DesignSystem全件の型検査も既存 `TimerWorkspace.test.tsx` の2箇所の `getByRole` に未対応の `exact` オプションがあり停止した。どちらも今回の差分では修正しておらず、全体検証の成功とは報告しない。

## 前段階の再検証停止

最後に保存場所の説明を利用者向けの短い文へ変更した後、production buildとsettings domain（backend 23／Web 55件）は再度成功した。ブラウザをビルドと並行して動かした実行は途中でアーティファクトが消え、依存bundle更新によるViteの再読込みが原因と考えられるため成功として扱わない。

ビルド完了後のブラウザ再実行はAPI起動前に停止した。隔離DBで別途起動を調査すると、並行作業で追加された `api/application/server.ts:220` の `queue.registerHandler(memory.agentHandler())` が起動エラーの位置にあり、現在のmemory domainには `agentHandler` が実装されていなかった。起動ログのbootIdは `08528a65-5674-4c99-b384-49c894238209`、reasonは `startup_failed`。担当外のserver/memoryを修正したり、起動条件を緩めたりしていない。

この段階では最新backendの通し再確認が未完了だった。メモリー接続の起動不備は後続の担当作業で解消され、次節の表への変更では新しいbackendを起動して通し検証した。旧カード画面の画像は前段階の固定データを示す。

## TanStack TableとAPIの検索・ソート・ページング

ユーザーの追加要件により主一覧と取得手順を表へ変更した。DesignSystemに`ServerDataTable`を追加し、`@tanstack/react-table` v8.21.3をdependenciesへ登録した。`manualSorting`、`manualFiltering`、`manualPagination`とCore row modelを使用する。クライアント内でのソート、検索、ページ切出しは行わない。初期10行、25／50行の選択、検索と解除、列ごとの昇順・降順、前・次ページと総件数、選んだ1行だけの詳細を扱う。表示件数・検索・ソートを変えたときは先頭ページへ戻る。両タブ・取得手順はそれぞれ独立した条件を保持し、更新時も条件を維持する。

| API | ソート列 | 検索対象 |
| --- | --- | --- |
| GET `/api/inference/usage/page` | started、purpose、source、model、status | 用途、利用先、モデル、結果、理由。サービス試用probeは従来どおり除外 |
| GET `/api/toolchain-history/selections/page` | createdAt、process、outcome | 処理、判断、依頼、結果、理由、実行ID |
| GET `/api/toolchain-history/recipes/page` | updatedAt、signature、state、successes、failures | 手順、URL、読む箇所、状態 |

要求は`pageIndex`（0起点）、`pageSize`（10／25／50）、`sort`、`desc`、`q`（200文字まで）。応答は`items`、条件に合う`total`、補正後の`pageIndex`、`pageSize`と条件のecho。SQLは所有domainに置き、読取snapshot内で総件数、全対象へのソート、ページ切出しを行う。同順位はIDで安定化する。検索は文字列の部分一致で、英字の大小と画面の固定ラベル（会話、採用済み、有効など）に対応する。`%`、`_`、引用符も文字として検索し、SQLへ展開しない。並べ替え列は所有schemaと列mapの許可リストに限定する。日時文字列そのものの検索は対象外。

既存の利用記録array（直近100件）、選択記録cursor、取得手順一覧、認証、writerによる手順の更新・削除、診断の100件保存は維持する。新しいDB migrationは追加していない。モデルが未確定の利用記録も新しい表APIでは「不明」として表示する。旧array APIのNULLと順序の扱いは変更しない。削除等で最終ページが消えた場合はAPIが有効な最後のページへ補正し、表はその応答を使う。

OpenUIは`records-query`で表IDと条件を送る。ホストはclientが公開する所有domainのschemaを使い、既存のsource、revision、重複・同時操作・閉鎖世代の検査を維持する。検索ごとのquery keyとHTTP signalで古い結果を現在の表へ採用しない。取得手順の変更・削除は現在取得しているページのIDだけを操作する。保存用の表示JSONに記録、条件、秘密、Blob URLや関数は追加しない。SQLのCASEは保存済みの閉じたenumを画面の表示名へ対応させる処理であり、入力文の意味判断を行う分類器ではない。

部分：新しいAPI試験2件・52 assertions成功。125件の利用記録、65件ずつの選択・取得手順を使い、旧100件に含まれない記録の検索、全対象の昇降順、表示ラベルでの検索、同日時のページ間の重複・欠落なし、最終ページ削除後の補正、未確定モデルの表示、旧APIの互換、任意SQL・不正列・件数・方向等の400拒否を確認。inference既存66件も成功したが、後の実行は並行する別作業によるsource変更でdomain gateの完了判定が停止した。toolchain-history domain 7件とartifact domain 49件は成功。

部品・結合：DesignSystem 2件、Storybook Chromium 9件、Webの記録関係4件が成功。特に部品試験は、供給したページがZ→Aのままでもソート条件のイベントだけを送り、クライアントで並べ替え・検索を行わないことを確認。選択行の詳細、タブ・スクロール保持、確認付き削除、共通設定保存を使わないことも確認した。production buildと所有差分のlint・whitespace検査は成功。root型検査は1,198ファイル成功。

通し：最終のブラウザ2件は46.1秒で成功した。固定HTTP応答の主一覧を廃止し、通常API・隔離DB・Chromiumで利用記録125件、選択55件、取得手順27件を用意。初期10行、25／50行、次ページ、初回未取得のモデル・依頼・手順の検索、SQLから返る昇降順と要求URL、タブと更新後の条件・詳細・実scrollTopの保持を確認。手順の有効・無効・停止から有効、削除取消・確認削除、最終ページ6件の削除後の前ページ補正、診断100件の実ファイル、設定が変わらないこと、再読込、390pxの操作も確認した。503の取得・変更・保存失敗と明示的再試行も成功。

試験の調整：件数表示のlocatorが「25件」のselect optionにも一致したため、総件数とページ表示へ限定した。操作を増やした90秒枠は最後の撮影手順で超過したため、期待値を維持して180秒枠へ拡張し、同じ2件を最後まで検証した。最終実行は枠内の46.1秒で成功している。[通常幅の表](records-table-wide.png)、[狭い画面の表](records-table-narrow.png)を目視確認した。

実環境：既存のdevプロセスを通常の終了手順で再起動し、新しいAPIを反映した。既存の認証と設定を使用し、利用記録APIは全対象1,189件から10行、選択記録12件から10行、取得手順0件を取得できた。「会話」の検索は370件から10行、モデル昇順と次ページ10行を確認。実環境の手順は更新・削除していない。保存用の設定値を試験用へ書き換えていない。

全体gateの残り：最新のsettingsとverify:allは担当外の`web/src/domains/settings/MemoryItemsPanel.test.tsx`の未宣言dependency `settings -> memory` で停止した。根拠と担当範囲が異なるため、この作業では依存宣言・試験を修正していない。表の実装と上述の機能確認・実環境への反映は済み。リポジトリ全体の検証成功とは報告しない。

実サービスの生成、音声・マイクなどの機器受入は画面の要件に含まれないため実行していない。通常運用の記録・手順・設定は検証で変更していない。LLMの判断処理や個別の依頼に対応する製品分岐は追加していない。
