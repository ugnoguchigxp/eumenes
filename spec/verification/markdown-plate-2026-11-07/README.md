# Plate最小構成の採用検証

2026-11-07。状態: **隔離検証完了。本番採用は保留。** 本番ツールチェーンの登録・UI実装ではなく、採用判断のための隔離実験。

## 目的・境界

Markdownを利用者とAIが編集でき、普段のエディタとしても使えることを検証する。既存のbundle＋登録adapter＋session workspace＋`doc.view/edit/write`と、DesignSystem＋OpenUIを再利用する。Plate内蔵のモデル接続は導入しない。

追加の利用者指示: 画面は既存Artifact枠内の内容だけとし、独立アプリを作らない。ツールバーはできる限りフルセット。「AIが編集」のラベル・専用領域は不要で、全文・節・段落・任意箇所を会話から編集依頼できる。共同編集時は既存の共同作業collaboratorエージェントへ切替える。選択は対象を示す一手段であり、編集可能範囲を制限しない。

本体の依存、公開API、DB、設定、登録済みbundleは変更しない。サーバーの起動・停止・再起動をしない。ブラウザーへビルド済みの検証画面を直接読み込ませる。画像案は保存済みLARM設定と既存gatewayで生成する。UIは未承認のコンセプトであり、本番画面の実装を進める根拠にしない。

## 依存順・完了条件

1. 画像生成で会話欄＋Artifact編集欄のUI案を提示。
2. 公開後7日以上の安定版を固定し、検証用の依存だけを隔離導入。
3. Markdown→Plate→Markdownの保持を測定。文字列の一致と構文内容の保持を区別し、失敗した入力・出力を残す。通常構文とFrontmatter／HTML／脚注等を別に記録する。読取りだけで本文を再保存しないことも確認。
4. 実ChromiumのIME composition経路で未確定文字→変換→確定、取消、確定後のUndo、AI更新の到着を確認。OS実IME／実キー操作の受入とは区別。
5. 既存`runDocTool`を実行し、部分修正・版競合・不一致・原子性を確認。画面側の未保存変更・IME中の遅いAI応答も失わないことを隔離hostで確認する。固定AI操作と実LLMの意味判断を混同しない。
6. 検証専用SQLiteの閉鎖・再オープン、版の復元、ブラウザー再読込み、保存失敗を確認。製品DBは使わない。ブラウザー保存とbackend保存を区別する。
7. 部分→既存共通文書操作との結合→静的ビルドとブラウザー通し確認の順で実行し、採用／条件付き／保留／不採用を証拠から判断する。

失敗時は同じ条件の無根拠な再試行をしない。設定不足とライブラリ固有の不具合を分け、専用の語句分岐や変換パッチで例だけを通さない。3ラウンドごと、または同一失敗反復時に方針を再評価する。

## 採用の判定

- 最小構成で日常のMarkdown内容が失われず、日本語確定入力、競合検出、永続復元が成立すれば採用候補。
- 入力した記法・未編集領域の完全保持と、意味の保持は別要件。見えない文字・改行の消失、構文の消失は正規化として合格にしない。
- 常用構文で内容が失われる、または広範な専用補修が必要なら本番採用を保留する。未確認項目は未確認として残す。
- 完了は全項目の観測結果・制約・採否・次段階の条件が揃った時点。本番組込みの完了とは呼ばない。

## 結論

**検証したPlate最小構成を、そのままMarkdownエディタとして本番登録することは見送る。** WYSIWYGの再出力で通常のMarkdownにも内容・構造の消失があり、フルツールバーの情報を保持する要件にも達していない。Plate全バージョン・全構成の不採用を意味しない。保存・版競合・共同作業の接続自体は既存機構で構成できる。

現状は、Plateを導入すればすぐ完成する状態ではない。フルツールバーを維持するなら、Plateの構造化データを正本としMarkdownを入出力形式とする案と、Markdown本文を正本とし非対応の書式を制限／別途表現する案を設計として比較する必要がある。前者でも、読み込んだMarkdownの完全保持は別途解決が必要であり、この実験では実装・承認していない。単純に保存形式を変えれば入力Markdownの問題がすべて解決するとは扱わない。

## 確定したUI・共同作業要件

- [更新したArtifact内の画像案](../../design/markdown-editor-2026-11-07/artifact-v2.png)。既存枠が提供するタブ・サイズ変更・会話欄は作り直さず、枠内の内容だけを描いた。初回の独立画面寄りの案は採用案から外す。
- ツールバーはできる限りフル構成。複数段とメニューで枠内に配置する。画像は構成の事前確認用で、全ボタンの機能が実装済みであることを意味しない。
- 「AIが編集」のラベル、専用の編集領域、AI専用の囲みは置かない。全文・節・段落・リストなど任意の箇所へ会話から依頼できる。選択範囲の指定は任意。
- 共同編集を開始すると既存の共同作業collaboratorへ切替える。担当ごとに新しい推論ループやモデル接続を増やさない。単独の手編集・文書の保存と再開は、collaboratorが稼働していなくてもできる設計にする。
- この画像案への利用者の承認はまだ得ていない。本番UIは未実装。

## 実行環境と構成

依存はこの検証ディレクトリ内だけに導入した。[固定バージョン](package.json)と[依存lock](package-lock.json)を参照。Plate `53.5.2`、Markdown `53.3.18`、React `19.2.7`、Chromium `149.0.7827.55`。公開後7日を経過した安定版を対象とし、インストールにも `--before=2026-10-31T00:00:00Z` を指定した。

本文変換を独自に補修するルールは追加していない。最初にClassic List、次に公式のflat List＋Indent、最後にMarkdownKit相当のremark GFM＋math＋MDX設定を比較した。脚注は公式の専用プラグインを登録した。数式の編集用プラグインや独自のFrontmatter保持は最小構成に含めていないため、その結果は対応構文の本体不具合と断定しない。

公式資料: [Markdown](https://platejs.org/docs/markdown)、[更新履歴](https://platejs.org/docs/releases)。更新履歴には公開直後のMarkdown `53.5.3`で改行関連の修正があるが、7日ルールに達しないため今回は未検証。この結果をその版の動作へ一般化しない。

## 部分検証: Markdownの保持

判定は文字列一致と、位置情報を除いたMarkdown AST一致の両方。参照リンクはリンク先・説明・代替テキストを保持したインライン表現に正規化して比較し、記法の変更だけで内容消失と判定しない。文字列に差があるだけで全件不合格にしたものでもない。

[最終27ケースの入力・出力・編集データ・AST](results/preservation-kit.json)、[集計](results/preservation-kit-summary.json)。**文字列一致7/27、AST一致15/27。通常構文20件のうち11件一致・9件相違、拡張構文7件のうち4件一致・3件相違。** AST差は直ちに文字の消失を意味しないため、次の実例を採否根拠にした。

| ケース | 観測した結果 |
| --- | --- |
| リンク・強調・インラインコード直後の改行 | `[link](https://example.com)\nnext` が `[link](https://example.com)next` となり、改行が消失 |
| 通常の段落内改行 | soft breakが明示のhard breakに変化 |
| GFM表の左右・中央揃え | 配置指定が消失 |
| リンクのtitle | URLと表示文は残るが説明文が消失 |
| リスト内の複数段落 | 同じ項目内の段落がリスト外へ移動する |
| コードフェンスのmeta | 言語とコード本文は残るが `title=demo.ts` が消失 |
| インライン画像 | 独立した段落へ移動する |
| Frontmatter | YAMLとしての保持は最小構成で未達 |
| math | 数式用の編集プラグイン未登録のため、数式と同じ段落の後続文が消失。現構成では使用不可 |
| HTML details | MDX構成ではタグ周囲の改行・AST構造が変化。これ単独で内容消失とは判定しない |
| 見出し・基本装飾・入れ子リスト／引用・脚注・Mermaidコード | 今回の入力ではASTを保持。一般の全入力を保証する結果ではない |

Classic Listで失われた番号開始値とチェック状態は、flat List＋Indentへの構成変更で保持できた。[Classic結果](results/preservation-classic.json)、[flat結果](results/preservation-flat.json)。設定不足が原因だったものと、最終構成にも残る問題を分けている。全27件で2回目の往復出力は安定したが、一度失われた情報が戻ることはなく、保持の成功とは扱わない。

## 結合・通し検証

[ブラウザー12ケースの結果](results/browser.json)。**10件成功・2件失敗、pageerror 0件。** 本番UIを先行実装せず、実Plateの編集欄だけのlabをビルドし、file URLから実Chromiumへ読み込んだ。保存通信はPlaywrightのテスト用portで所有側SQLiteへ接続した。HTTP・製品認証・本番ArtifactRendererの検証ではない。

| 分類 | 結果・条件 |
| --- | --- |
| 日本語入力 | Chromiumの `Input.imeSetComposition` を使い、かな→漢字変換→確定を確認。compositionstart/update/endとbeforeinput/inputが実ブラウザーから発生。確定文字の重複なし、取消・Undoも成功 |
| 日本語入力時の残る失敗 | 元文書末尾の半角空白がWYSIWYGへの読込み時に消え、その後の日本語入力と前文が連結。IMEで日本語文字自体が消失したものとは区別 |
| 未保存入力とAIの競合 | 手入力中・IME中のAI更新を保留。古いsnapshotは破棄し、手入力を消さない |
| 保存中の追加入力 | 古い入力の保存完了で新しい入力を保存済み扱いにせず、後続下書きとして保持 |
| 保存済みAI更新と古い下書き | 保存を版競合として拒否。再読込み、さらに追記して再読込みしても元の版を保持し、無断で現在版へ載せ替えない |
| 保存・復元 | 本文を開くだけでは正規化した文字列を保存しない。保存後の再読込み、未保存下書きの復元、保存失敗時の下書き保持を確認 |
| フルツールバーの情報 | 下線・色・文字サイズはHTML混在の文字列になる。中央揃えは保存されず不合格。基本Markdown設定では装飾がMDX nodeとなりserializerエラー、公式のMDX拡張設定ではエラーが解消したが配置情報は依然消失 |

未保存バッファ・IME・保存完了の保護は、Plate単体の標準機能として主張せず、[隔離host](lab.tsx)の責務として検証したもの。ホストは意味を判定せず、版・未保存状態・composition状態・保存処理の世代だけを検査する。共同編集の意味や対象の選択はcollaboratorが担う。

## 既存collaboratorと永続保存の接続確認

`specialist-prompt.ts`の `createCollaborationContract`／`collaborationInstructions`、`specialist-memory.ts`の `buildCollaborationMessages` を確認。既存のcollaborator契約・指示・文脈構築をsession実行が消費している。別のAI SDKで同じ役割を作る必要はない。

[保存adapter試験](store.test.ts)は実際の `runDocTool` を呼び、Markdownの見出し・段落・リストの任意箇所を修正し、他のバイトを保持した。古い版の拒否、複数置換の原子性、曖昧な範囲の拒否、テキスト全文／空文書、SQLiteの閉鎖・再オープン、履歴から新revisionとして復元、書込み失敗の非成功を確認した。

| 実行 | 結果 |
| --- | --- |
| 検証用adapterの部分試験 | 6件成功、25 assertions |
| 既存文書session・collaboration配布物・検証adapterの指定3ファイル結合 | 19件成功、93 assertions（6件を含む。同じ試験を合算しない） |
| 検証用tsconfigの `bun check` | 257ファイル、型エラー0 |
| Bunによるブラウザービルド | 成功。成果物は `verification-reports/markdown-plate-2026-11-07/lab.html` |
| 画像生成live | 保存済み設定→catalogのcapability/protocol→共通gatewayで確保応答のURL/description検証→生成→PNG保存。初稿1回、指示反映版1回。最初の呼出しミスは生成POST前で、修正後の初稿POSTは1回 |

最初の既存試験コマンドではBunのパスフィルターが過去snapshotまで選び、対象外snapshotの配布物参照4件が失敗した。これは本番コードの不具合と断定せず、`./`付きの厳密な3ファイル指定へ変更し、上記19件を確認した。過去snapshotを修正せず、期待値や試験時間も変更していない。

## 本番組込みの案と残作業

本番登録は実施していない。登録する際は以下の責務に分ける。IDは提案値で、公開済みのID・版ではない。

| 接続 | 案 |
| --- | --- |
| 登録 | 新しいbundleにMarkdown共同作業のprofile・Skill・package・session binding・artifactを登録。ランチャーからはAI不要で文書を開く |
| 会話→共同作業 | 既存handover/sessionを使いcollaboratorへ切替。対象文書ref・現在revision・元依頼を渡す |
| 共同作業→文書 | `workspace:markdown.document@1`に `document.md` と `text/markdown` を宣言し、既存`doc.view/edit/write`へ所有domainの検査・commitを接続。修正箇所はLLMが決める |
| 保存 | 文書を所有するdomainの公開transactionで保存・revision・履歴を管理。保存文書の寿命を会話sessionの終了へ結び付けない。既存の忘却・権限との関係は設計時に確定する |
| UI | DesignSystemの編集部品→OpenUI登録view→bundleのsource/action→既存ArtifactHost。本文を表示定義JSONへ埋め込まない。機能固有のArtifact種別を増やさない |
| 画面の状態 | 未保存・IME・古い応答・保存中の追記・復元時の版競合をhostで保護。API側にもCASを設ける。全体版の競合拒否であり、文字単位のリアルタイム自動マージではない |

残る判断・未検証:

1. Markdown本文を正本とするか、フル装飾を保持する構造化データを正本とするか。無許可で切り替えない。
2. 公開後7日を経過した新しいMarkdown版で、今回の回帰入力をそのまま再検証する。改行修正済み版でもその他の保持は個別確認が必要。
3. 変換の追加対応が必要なら、CommonMark/GFM等の外部仕様に対する汎用のノード変換として設計する。特定の文言を救う置換や、無断のソース専用フォールバックは追加しない。
4. 実OSの日本語IMEとキーボード、Safari・Firefox、モバイル、オフライン長期運用、複数端末は未確認。
5. 実LLMによる新しいMarkdown担当の選択・collaborator切替・編集対象の意味理解、本番API・認証・忘却、ArtifactRendererとの接続は未確認。固定AI操作の成功を実LLM成功と呼ばない。
6. UI案の合意後、保存・変換設計の合意を得てから本番実装へ進む。

## 再現コマンド

リポジトリルートから実行する。保持測定とブラウザー試験は、上記の未達要件を検出して**終了コード1**になる。期待値を下げて0にすることを完了条件にしていない。

```sh
npm ci --prefix spec/verification/markdown-plate-2026-11-07 --ignore-scripts --no-audit --no-fund
bun spec/verification/markdown-plate-2026-11-07/preservation.ts
bun test ./api/domains/dialogue/test/specialist-document.test.ts ./api/application/toolchain/collaboration-package.test.ts ./spec/verification/markdown-plate-2026-11-07/store.test.ts
bun check -p spec/verification/markdown-plate-2026-11-07/tsconfig.json
bun spec/verification/markdown-plate-2026-11-07/browser.ts
```

画像の再生成は採用判断の再実行には不要。[生成指示全文](../../design/markdown-editor-2026-11-07/artifact-v2.prompt.txt)と[生成記録](../../design/markdown-editor-2026-11-07/artifact-v2.generation.json)を保持した。既存のLARM gatewayを使用し、組込み画像ツール・新規の画像CLIは使用していない。

製品コード・rootの依存・DB・設定・既存bundleは変更していないため、製品domain verify・verify:all・本番ブラウザーE2Eは今回の実験では省略。検証ディレクトリの型・ビルド・試験と、再利用する共通処理の指定試験に範囲を限定した。サーバー操作、別Codexチャットへの送信、commit/pushは実施していない。

俯瞰評価: 3構成を比較した時点で、設定修正により改善したリストと、残存する変換問題を分けた。新しい根拠なく変換パッチを継ぎ足す方針は取らず、入力・競合・永続性の確認へ進んだ。そこで保存応答中の追記と競合下書きの復元についてhost責務を具体化し、固定試験で確認した。判定は採用保留で、未達要件を成功扱いにしていない。
