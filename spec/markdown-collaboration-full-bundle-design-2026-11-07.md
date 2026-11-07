# Markdown共同編集・フル構成bundleの設計

2026-11-07。状態: **構築中**。利用者はbundleフルセットの構築開始を依頼し、保存形式「Plate形式＋原文履歴」に合意した。続いて「Docling Deskへの保存を優先し、バージョニングを重視しない」と指示した。後者を保存先と実装順の正本とする。既存の登録・共同作業・Artifactの構成を使い、試験未達のまま本番公開しない。

## 目的と完了条件

普段の文書編集と、共同作業collaboratorに切り替えたAIとの継続編集を、同じArtifact上で行えるようにする。本文の任意箇所を会話から指定でき、「AIが編集」のラベルや専用領域は置かない。既存Artifact枠内に収め、ツールバーはできる限りフル構成とする。[画像案](design/markdown-editor-2026-11-07/artifact-v2.png)の利用者修正を保持する。

登録定義だけで完成としない。bundle検査、保存domain・backend adapter・Web adapter・DesignSystem部品・OpenUI登録・collaborator切替が接続され、文書の作成／編集／Docling保存・読戻し／Markdown読込み・書出しと、手入力・IME・取消・古いAI結果の保護を確認して完了とする。fixture、実LLM、OS実IMEの結果は分ける。

## 既存機構と今回の追加

| 接続 | 再利用 | 追加するもの |
| --- | --- | --- |
| 会話→共同作業 | session binding、既存handover、collaboratorの契約・指示・入力構築 | 既存collaborator profileを再利用し、文書編集Skill・package・toolchainを追加 |
| 共同作業→文書 | `workspace`と`doc.view/edit/write`、版照合、ターン取消・期限・所有session検査 | 文書所有domainのcheck/read/commit/reject公開操作 |
| 画面→業務操作 | source/action、共通受付・outbox・receipt | `adapter:markdown@1`、登録query・入力変換・操作、Web adapter |
| 画面 | 既存ArtifactHost、DesignSystem、OpenUIのJSON構成 | Plate編集部品と`markdown-workspace` view。専用Artifact種別を増やさない |
| 保存 | Docling DeskのWiki import/catalog/markdown APIと既存のbackend専用接続設定 | `markdown` domainは現在の編集中の値・競合用revision・Docling保存参照だけを管理。独立した保存文書ライブラリや版履歴DBを作らない |
| 通常利用 | 単独公開artifactのlauncher | AIを呼ばず一覧・作成・編集・保存・復元できる入口 |

意味の解釈、編集対象、文章や構成の選択はcollaboratorに委ねる。コードは文書schema、権限、版、状態、サイズ、保存と安全な表示を検査する。利用者発話の語句や例文に対応する分岐を追加しない。

## 保存形式: 実装前に決める点

[最小構成の実測](verification/markdown-plate-2026-11-07/README.md)では、Markdownの変換で改行・リンクtitle等が失われた。また、配置・色・文字サイズ・複数列等を通常のMarkdownだけで表すことはできない。フルプラグインと公式設定を揃え、設定不足と変換器の不足を再確認するが、機能を登録するだけではこの違いは解決しない。

### 案A: Markdown本文を保存の正本とする

既存Markdownファイルを編集する用途を優先する。標準外の装飾は許可したHTML等の表現規則を設け、同じ表現へAIと画面の双方を接続する。JSONは保存した本文から復元できる投影として扱う。全プラグインを並べた結果、変換できない機能を黙って捨てたり、勝手に無効化／ソース専用へ切り替えたりしない。対応機能と保持規則の確認が必要。

### 案B: 文書としてPlateの構造化データと取り込んだ原文を保存する（合意済み）

フルツールバーによる編集を保持する。内部の編集データ、取り込んだMarkdown原文、変換版と由来を同じ文書revisionに保存する。原文は取込履歴であり、以後の編集結果と別の現在値として更新し続ける二重正本にはしない。共同作業の文書もこの構造に沿い、モデルに必要な現在値と操作schemaを提示する。

Markdown読込みと書出しを提供するが、書出せない属性は黙って落とさず、失われる内容を明示したうえで書出しの契約を設ける。これにより元のMarkdown記法まで自動的に完全保持できるとは主張しない。ソース編集は、現在の文書への変換が成立する範囲・未対応属性の扱いを明記する必要がある。

利用者は案Bに合意済み。保存先はDocling Deskを優先する追加指示に従う。

### Docling Deskを保存先の正本にする

既存の保存済みgatewayとBearerをbackendだけで使用する。Docling側のソースは参照のみとし、配備・起動・設定・DBを変更しない。現行Deskの公開ルートは `POST /api/wiki/import`、`GET /api/wiki/catalog`、`GET /api/wiki/sources/{id}/markdown`。同じnamespace/pathで記事IDを保った更新ができ、Plate形式のJSONファイルを直接受け付けるAPIはない。

この外部制約に合わせ、保存ファイルは読みやすいMarkdown本文と、Plate値・取込原文を含む版付きの復元情報を一つのMarkdownファイルに持つ。復元情報は末尾の「書き出し原本」以後の未使用Markdownリンク定義へbase64で格納し、通常表示・検索本文から分離する（末尾の外部契約確認を参照）。本文のタグや任意コードとして実行しない。書式を変換できない場合もPlate値は保持する。任意のMarkdown文書をEumenes由来と誤認せず、識別子・schema・サイズ・ダイジェストを検証して復元する。

保存はDoclingへの一回のPOSTと読み戻し確認を、既存queueのwriter外処理として実行する。同じ保存でPOSTを自動再送しない。応答喪失時は同じpathの内容をGETで照合し、確認できなければ結果不明として下書きを残す。正常応答でも保存した内容の読み戻しが一致しなければ「保存済み」にしない。接続設定変更・取消・古い保存応答を採用しない。

Doclingの同名記事更新に上流CAS契約はないため、保存前に読取ったrevisionで外部変更を検出するが、別アプリからの同時更新まで原子的に防ぐとは扱わない。Eumenes内のAI／手入力は既存writerとrevisionで競合を検出する。保存済み記事の一覧と再読込みを先に接続し、独自バージョン画面・履歴復元の構築は後回しとする。

## bundleに揃える定義

IDは新規の提案。公開済みrevisionを上書きしない。

| 種別 | ID／内容 |
| --- | --- |
| profile / Skill / package | 既存`profile:collaboration@1`と新規Skill・package `markdown.collaborate@1`。役割、部分編集、元依頼保持、本文と命令の分離、結果確認、停止条件 |
| toolchain | `markdown.collaborate@2`、会話関数 `markdown_edit`。文書の作成・継続編集に使う |
| binding | `binding:markdown.collaborate@2`、`execution:session`、`adapter:markdown@1`。モデル・接続先は既存保存設定 |
| workspace | `workspace:markdown.document@1`、`document.json` / `application/json`。Plate形式の現在値を共通文書操作へ渡す |
| artifact | `artifact:markdown.workspace@2`。launcher、OpenUI JSON、source/action、default variantを一式で定義 |
| sources | workspaceの現在文書とDocling保存先の参照。Docling記事一覧・読み戻しは認証済みの所有APIで取得 |
| backend操作 | 作成、画面編集の適用、Doclingへの保存、文書名変更、保存済み記事の読込み。receiptとrevisionを返す。独自の履歴復元・記事削除は必須範囲から外す |
| local操作 | 文書の選択、表示モード、Markdown書出し、共同編集開始・終了。業務保存をlocalで完了扱いにしない |
| schemas | 対象、source条件、各UI操作の生入力・domain入力。JSON文字列を受ける場合もdomainで実体schemaを検査する |

共通の`doc.*`はhost提供なので、架空の通常toolとして重複登録しない。文書保存／履歴復元等は既存sessionの画面操作方式に従い、モデルに未公開の操作を使わせない。bundleは宣言データであり、npmパッケージや実行コードを埋め込まない。

## Plateのフル編集構成

公式のプラグインを同じ安定版系列で固定する。公開後7日ルールを維持し、別モデル接続やPlate独自AIループは導入しない。

| 機能群 | 構成 |
| --- | --- |
| 基本文書 | 見出し、段落、引用、区切り線、太字・斜体・下線・取消・コード・ハイライト・上付き／下付き |
| 文字・段落 | 色・背景色、文字サイズ・書体、配置、行間、インデント |
| リスト | flat List＋Indent、番号開始、箇条書き、チェック、入れ子 |
| 構造 | 表、リンク、画像、コードブロック、数式、脚注 |
| 挿入 | コールアウト、折畳み、目次、列、絵文字。保存契約に接続した機能だけを公開する |
| 編集操作 | Undo/Redo、範囲／ブロック選択、Markdown入力補助。読取りだけでは本文を再保存しない |

コメント、変更提案の承認UI、マルチユーザーのpresence、Yjs同期、Plate内蔵AI SDKは今回の必須構成に含めない。ツールバーをフルに近づけるために、未接続の外部サービスや新たな意味判断を追加しない。

## 競合と保存・復元

サーバーrevisionを正本にし、保存はCAS。IME中と未保存中のリモート更新は保留する。保存応答の到着までに増えた入力は、保存済み扱いにせず新しい下書きとして保持する。復元した下書きは元revisionを保持し、現在版へ無断で載せ替えない。

共同作業開始時には画面下書きと保存状態を整合させ、同じ文書refへhandoverする。取消・期限・session終了後のAI応答を採用しない。会話終了後も保存文書を開ける。忘却時に消すもの／所有文書として残すものは既存の文書権限・忘却設計に照合して確定する。

## 実装順と検証

1. 設計書、bundle宣言草案、フルプラグイン一覧・隔離検証を揃える。未登録のadapterを架空の実装として成功扱いにしない。
2. 合意済みの保存形式とDocling保存指示に従い、所有domainのschema・編集中の状態だけのmigration・Docling保存client・公開操作・部分試験を実装する。ファイル上の試験DBだけを使う。
3. 登録adapterとbundleを接続し、dry-run、fresh／再seed、replay、権限・版競合、取消・遅延応答を固定試験で確認する。
4. DesignSystem部品→OpenUI契約と登録→Web adapter→ArtifactHostの順に接続する。画像案と利用者指示に従う。
5. 実Artifactの固定データ経路で入力、全ツールバー項目、文書切替、保存、復元、書出し、狭い幅、他viewとの合成を確認する。
6. 変更domainと利用側の `bun run verify -- --domain markdown --domain capabilities --domain dialogue --domain artifact`、明示したapplication結合、Web adapter試験、対象ブラウザー試験、型とbuildを行う。検証中は入力ファイルを変更しない。
7. サーバー操作の明示許可後に本番反映を扱う。実LLM切替と実OS IMEは別の受入結果にする。本文・認証情報・設定・Provider生応答を通常ログへ入れない。

保持試験の入力・期待値は元の27ケースを維持する。フルツールバーの項目ごとに作成→保存→再読込み→AI部分編集→書出しの保持を確認する。未対応の機能をテストから削除して成功にしない。新しい証拠なしで同じ試行を繰り返さず、3ラウンドで俯瞰評価する。

## 残作業

- [x] 既存機構、利用者指示、最小構成の失敗入力を確認。
- [x] フルセットの責務・登録内容・保存形式の選択肢と受入条件を文書化。
- [x] bundle宣言と契約チェック。
- [x] フルPlate構成を揃え、保持と全書式の保存を再測定（Markdown意味一致16/27、編集データ・原文の保存用形式での復元27/27）。
- [x] 保存形式の合意。追加指示でDocling Deskを保存先として優先。
- [x] domain／adapter／UI／登録を実装。保存・登録・移行・合成の固定試験を確認。ブラウザー32件と全体gateの結果・残る受入は検証記録へ記載。
- [ ] 実LLM・実OS IME・稼働環境の受入。

### 入力容量の接続（実装時の契約確認）

共通UI操作の受付契約はイベント全体16,384 bytes、HTTP本文32,768 bytesまでである（`tool-runtime/contracts/adapters.ts`、同controller）。装飾を含む文書本体を直接イベントへ入れると通常の長さの文書も保存できない。既存のArtifact `uploadFile` 接続を再利用して文書JSONとMarkdown投影を一時アップロードし、登録操作には発行された不透明な参照IDと期待revisionだけを渡す。共通受付の上限は変更しない。一時入力は期限・件数を制限し、操作の成功と同じtransactionで消費する。これは文書履歴ではない。保存時には一時入力の文書と現在の作業文書の一致も検査する。

### 保存結果が不明なときの復旧

確認不能な保存は文書ごとに直近1件の送信内容だけを一時保持し、再起動後も「保存状態を確認」からGETで照合する。同じ内容がDoclingにあれば保存済み基準を復元し、その後の追記は残す。新規保存で該当文書がないことを確認できた場合は未保存へ戻し、次の明示的な保存を可能にする。内容が違う場合は競合として止める。確認を経ずに同じPOSTを再送しない。取消後の実行結果は採用せず、利用者が求めた照合は新しい読取りとして扱う。

### 公開済み登録からの更新

稼働APIの読み取りでartifact:markdown.workspace@1が既に公開され、「保存状態を確認」が含まれないことを確認した。公開済み本文は上書きせず、artifact/binding/toolchainと編集・保存用入力schemaを@2として追加する。profileとSkill・packageは本文を変えず@1を再利用する。これは登録契約の更新であり、利用者文書の版履歴ではない。

### Doclingの表示・索引契約に合わせた保存用形式の修正

Doclingの`knowledge/content.py`はMarkdownItを`html:false`で使うため、先頭のHTMLコメント案では編集データが文字として表示・索引化される。既存の`knowledge/catalog.py:evidence_body`は`## 書き出し原本`以後を索引から除外する。この外部仕様に合わせ、保存用形式v2は本文の後に同区切りと復元の説明を置き、編集データを未使用のMarkdownリンク定義へ格納する。リンク定義はHTMLを許可しないMarkdownでも本文に表示されない。先頭の空行はDoclingのfrontmatter抽出による書換えを防ぐ。編集データ・原文・本文digestの契約は維持し、旧v1コメント形式の読取りは残す。日本語の区切りの固定は外部API契約への接続であり、利用者の意味判断を代替するものではない。Docling本体には変更を加えない。

未使用リンクのURLには予約済みドメイン`eumenes.invalid`のHTTPS形式を使う。DoclingのMarkdownItは`data:`形式を拒否して定義ごと本文に表示することを再現したためである。リンクは未使用で描画・取得されない。Docling本体の純粋な表示・索引関数を同じ依存バージョンで実行し、データ非表示・本文のみの索引・frontmatter保持を確認する。旧v1読取りと改変拒否も固定試験で維持する。
