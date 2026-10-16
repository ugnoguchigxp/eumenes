# OpenUI Artifact 自由制作ツールチェーン実装計画・実施記録

作成・更新日: 2026-10-14

## 目的と範囲

利用者が作りたい画面の概要を入力し、保存済み画像を任意でモチーフに選び、制作担当のLLMでOpenUI画面を作る。作品は一覧から再表示し、選択中の作品への新たな指示は**同じ作品を上書き**する。プロンプト単位の履歴や過去版は保存しない。会話の登録ツールチェーンとArtifact内の制作フォームは同じ制作操作を呼ぶ。

初版で生成できるのは、登録済みの見出し・本文、情報カード、フォームの組み合わせ。フォームは text、radio、checkbox、textarea、select、number、boolean を扱う。任意のHTML・CSS・JavaScriptや外部API実行は対象にしない。デモは名前のテキスト入力、満足度のRadio選択、興味分野のチェックボックス選択、感想のTextarea、送信を含むアンケートとする。

## 構成と責務

| 層 | 実装 | 責務 |
| --- | --- | --- |
| 登録 | `api/domains/capabilities/bundles/ui-compositions.bundle.json` | profile・Skill・tool・package・toolchain・binding・Artifact・source/actionをデータドリブンで公開。アンケートの開始例を提示。 |
| 実行接続 | `api/application/ui-compositions-adapter.ts` | 会話コマンドとArtifact actionを制作domainの公開操作に接続。安定した受付receiptと作品参照を返す。 |
| 制作・保存 | `api/domains/ui-compositions/` | 作品、回答、操作receipt、queue、推論、取消、結果採用を所有。ID・世代・scope・入力契約を検証。 |
| 表示 | `packages/artifact-ui/src/` | 登録済みOpenUI viewを描画。作品の保存JSONを再検証してプレビューし、フォームを操作。 |
| Web | `web/src/domains/ui-compositions/` | source取得、画像一覧、選択中作品、生成中の更新、送信後の反映を扱う。 |

作品の正本はSQLiteの `ui_compositions` の一行。現在の依頼文、選択モチーフ、表示定義、項目、状態、世代のみを保持し、修正時に上書きする。`ui_composition_responses` には利用者がフォームから送信した回答を保存する。`ui_composition_receipts` は再送時に同じ操作結果を返すための小さな記録で、プロンプトや生成UIの履歴を含まない。

## 制作の流れ

1. フォームまたは会話で概要と任意の作品ID・モチーフIDを渡す。作品IDがなければ新規作成し、あればその作品の現在値を修正する。対象の意味判断は担当LLMに任せ、コードに題材別分岐を置かない。
2. 制作受付をtransactionで保存し、queueへ投入する。受付結果は「制作中」の作品参照を返す。画面は生成中を表示し、sourceを更新する。
3. workerが現在の依頼と既存項目を制作担当LLMに渡す。モチーフを指定した場合は画像domainの公開読取りで実画素を取得し、接続モデルの画像入力能力と容量を確認して渡す。画像内の文は命令として扱わない。
4. LLMの構成案をschemaとOpenUI parserで検証して保存する。不正案や推論失敗は失敗状態にする。取消・上書きで世代が進んだ古い結果は採用しない。
5. 一覧から作品を選び、保存定義をArtifactの共通Rendererで開く。新しい指示を送ると同じ作品行を上書きする。フォーム回答は現在の世代・項目・選択肢を検証してから保存する。

## 実装順と完了条件

| 段階 | 完了条件 | 状態 |
| --- | --- | --- |
| 保存・契約 | 一作品一行、上書き、再送、世代・取消検査、動的フォーム入力検証 | 実装済み |
| 制作 | queueと共通推論を使用。任意のモチーフ画像を実画素で渡し、許可済みOpenUI定義のみ採用 | 実装済み |
| 登録 | bundle検査、会話ツール、launcher、source/actionを登録adapterへ接続 | 実装済み |
| 画面 | Artifact幅で「作る」「プレビュー」を切替。目的・種類・要素・モチーフ・雰囲気から編集可能なプロンプトを組み立て、作品一覧・修正・回答送信まで操作 | 実装済み |
| デモ | 「アンケートのデモ」を1回押すと、text・radio・checkbox・textarea・送信を備えたアンケートの制作を開始 | 実装済み |
| 検証 | 部分→公開API結合→ブラウザ通し試験。実モデル接続はfixtureと分けて記録 | 下記参照 |

## 検証記録

| 区分 | 実施内容 | 結果 |
| --- | --- | --- |
| 登録 | `bun run toolchain:bundle -- check api/domains/capabilities/bundles/ui-compositions.bundle.json` | 通過 |
| 部分 | `bun run verify -- --domain ui-compositions` | 4試験通過。上書き、モチーフ画素、カード画面、取消後の古い結果を確認 |
| 結合 | `bun test api/application/ui-compositions-e2e.test.ts` | 登録済みAPIから作成・表示・回答・上書き、会話から担当への委任と作品保存まで通過 |
| 表示領域 | `bun run verify -- --domain artifact` | 以前に44試験通過。今回の再実行は担当外の `terminal-components.tsx` の整形エラーで途中停止。`bun run test:domain -- artifact` の44試験、対象ファイルの整形・lint、`bun check` は通過 |
| ブラウザ | `bunx playwright test tests/browser/ui-compositions.spec.ts` | デモの1クリック制作、手入力からの制作、全入力型、回答、再表示、狭幅表示、テーマを確認。3試験通過 |
| 型 | `bun check` | 通過 |
| 登録領域 | `bun run verify -- --domain capabilities` | 共有作業による一度の無効化後、再実行で63試験・最終判定とも通過 |
| 実モデル | `bun scripts/ui-compositions-live.ts --run`。保存済みLARM接続、隔離DB、合成モチーフ画像を使用 | アンケート作成・上書き修正・画像入力各1件が通過。デモボタン修正後にも3件通過。初回はモチーフ付きのモデル出力が定義検証に失敗し、診断追加後の再実行で通過。出力の揺れは残る |

## Artifact画面の見直し

初回の画面案はアプリ全体の構成を描いており、Artifactの表示幅に合っていなかった。画像案をArtifact単体として作り直し、`spec/verification/ui-compositions-2026-10-14/concept.png` に保存した。実装では幅約640pxのArtifactで制作条件を縦に並べ、生成結果を同じ領域の「プレビュー」タブで操作する。プレビューの右下にはスクロール中も見える「編集画面に戻る」ボタンを置き、作成条件と手編集したプロンプトを保持したまま戻れる。「作品」から一覧を開き、修正は同じ作品へ上書きする。

画像・音楽制作と同じく、画面種別・必要な要素・雰囲気・画像モチーフを選ぶと最終プロンプトを組み立てる。手で編集した文章は選択変更だけで上書きせず、「選択内容を反映」を押した時だけ置き換える。モチーフの実画素は既存の画像保存領域から読み込む。生成結果の雰囲気は安全な4種類の表示トークンに限定し、LLMが選ぶ。Artifactでの実表示は `spec/verification/ui-compositions-2026-10-14/artifact-create.png` と `artifact-preview.png` で確認した。

## 判断と制約

- 上書き後は旧プロンプトと旧画面を作品履歴として保持しない。旧世代の受付receiptは操作の冪等性のために残す。
- モチーフ画像は構成の参考としてモデルへ渡す。生成画面内にその画像を配置する部品は初版では持たない。
- 会話ツールは受付と作品IDを返す。完成した作品はArtifactの一覧から確認する。queue完了時に会話の親runへ自動追記する契約はまだ追加していない。
- 生成画面の自由度は登録部品の範囲に限る。任意コードや未登録の業務操作を生成JSONから有効化しない。
- 共有mainの他作業は別の差分として扱う。担当外の検証失敗は証拠を記録し、勝手に修正しない。
