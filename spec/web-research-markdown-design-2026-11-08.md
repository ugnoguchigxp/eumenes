# Pursuitの調査結果を、担当を切り替えずMarkdown文書として保存する

作成日: 2026-11-08。状態: **利用者が実施・起動・実践検証を承認。製品実装・固定検証・実モデル/Docling/画面での保存確認済み。自然文中止・担当選択・調査時間には別の未解決課題がある。**

## 1. 目的・範囲・完了条件

利用者の依頼は、`web_research` のPursuitが詳しく調べた結果を、Markdown共同編集担当へ会話を引き継がず、適切なタイトルと文章を持つ文書として残せるようにすること。ローカルは既存の一時ファイル、永続保存は利用可能なDoclingを使い、Eumenes専用の領域へ蓄積する。

提案する利用動作は、各調査の終了時にMarkdown文書を自動で作り、一時ファイルへ書き出し、Doclingへ接続できれば同じ本文を保存する形である。「Markdownにして」という語句による専用分岐を設けない。タイトル・見出し・文章構成・必要な詳しさは、元依頼と資料を読んだPursuitのLLMが決める。会話には短い結論と文書を開く参照を返す。

完了条件:

- 調査の計画・本文の執筆・独立した内容検証をPursuitが担い、保存のために別のLLM担当やspecialist sessionを起動しない。
- `.md` の実体を既存scratchから取得できる。Docling利用時には同じ本文・タイトルを読み戻せ、既存Markdown一覧から開いて編集できる。
- 保存結果と調査の充足を別に記録する。部分調査を完了済みと扱わず、保存の受付や結果不明を保存成功と報告しない。
- 取消・訂正・忘却・期限・接続変更、重複受付で古い文書の採用・無断の再保存・他文書の上書きが起きない。

対象外: 共同編集の責務変更、既存文書への自動追記・更新・分類・移動・削除、版履歴、新しい汎用エージェントや実行フレームワーク、Pursuit配布物の改変、新規ライブラリ、LARM側の配備変更、サーバーの起動・停止・再起動。ローカルに永続ライブラリは作らない。

## 2. 確認した現行構成と不足

| 現行の根拠 | 再利用するもの／不足 |
| --- | --- |
| `api/domains/capabilities/bundles/pursuit-research.bundle.json` | 現行は `web.research@5` → `package:pursuit.research@3` → `skill:pursuit.research@3`、`binding:pursuit.research@2`。回答案を調査中から積み上げ、別の検証で内容を照合する |
| `api/domains/pursuit/service/tools.ts`、`contracts/index.ts`、`service/acceptance.ts` | `report_draft` / `report_read` と `report.json` がある。`answer` はMarkdown、出典・限界も保持するが、文書タイトルと外部文書保存の契約はない |
| `api/domains/pursuit/service/jobs.ts`、`lifecycle.ts` | 調査の終了・部分結果・取消・忘却・通知の正本。現在は結果確定後すぐ通知するため、文書の保存結果を結び付ける段階が必要 |
| `api/application/pursuit/pursuit-adapter.ts` | task lifecycleと報告画面を既存登録で公開。`autonomy: read` は、新規文書を保存する新版の副作用と一致しなくなる |
| `api/application/markdown/markdown-adapter.ts`、`api/domains/markdown/service/workspace.ts` | 現行の操作入口はUI、文書コミットはspecialist sessionの所有権を検査する。Pursuitがsessionを偽装して流用してはいけない |
| `api/domains/markdown/service/archive-save.ts`、`archive-content.ts`、`api/application/markdown/markdown-composition.ts` | Queue、一回のPUT、固定IDと入力、digest照合、GETのみの確認、競合・結果不明、接続bindingを再利用する。現行enqueueはPlate workspaceに結び付くため、未編集Markdownの新規保存入口が不足 |
| `api/domains/markdown/service/archive-library.ts`、`web/src/domains/markdown/toolchain-adapter.tsx` | `recovery=""` の文書は、Webで既存Plate取込みを行って編集できる。backendで空のPlate文書や擬似的な復元情報を作る必要はない |
| `api/application/scratch/scratch-composition.ts`、`api/domains/scratch/` | Markdown MIME・SSDへの書込み・容量・貸出・起動寿命・HTTP取得・会話の成果物登録がある。Pursuit runtimeには通常のagent-runtimeの `scratch.write` がそのまま付くわけではないため、applicationの接続が必要 |
| [文書ライブラリ引継ぎ](reference/larm-document-library-handoff-2026-11-07.md)、[Markdown保存設計](markdown-larm-documents-integration-2026-11-07.md) | LARMの文書APIと既存credentialで保存する。Docling本体の起動は不要。現行GET/PUTと拡張APIの両方を考慮する |

指示だけの変更では、Pursuitに未接続の保存先とsession以外の書込み入口は増えない。追加コードの根拠は上の公開契約の不足であり、意味判断をコードに移すためではない。

## 3. 文章と保存先

Pursuitの新版回答案に `title` を加える。`answer` をそのまま保存本文の正本とし、文書用に別のLLMで書き直さない。元依頼に応じたタイトル・見出し・結論・根拠・不明点・限界・出典リンクを本文に含めるよう新版Skillで指示し、既存の独立検証にも同じ回答案を渡す。必須の章を題材別のテンプレートや正規表現で生成しない。

| 保存先 | 提案する配置・寿命 |
| --- | --- |
| ローカル一時ファイル | 既存 `<dataDir>/scratch/<bootId>/<uuid>`。表示名はタイトルを使った `.md`、MIMEは `text/markdown`。UUIDの物理配置、2 GiB/LRU・貸出・再起動での失効を変更しない |
| Docling | 既存の許可領域 `namespace=eumenes` の `research/` フォルダー。表示上の配置は `eumenes/research/<日本時間の日付>_<安全なタイトル>_<文書固有ID>.md`。文書のtitleには元のタイトルを保持する |

Doclingの初回保存前に、許可namespaceに `eumenes` があることを確認する。他の領域を推測して使わない。GET/PUTのみの接続では、既存の論理pathを使って保存し、一覧のフォルダー表示を再利用する。拡張APIで実フォルダーを必要とする場合は、capabilitiesと既存の管理操作・固定ID・GET照合を通して `research/` を作成または取得する。未対応APIを試送しない。

ファイル名の整形は外部path・名前の長さ、UTF-8上限、禁止文字、相対パスの契約に限定する。名前が同じでも文書固有IDで分離し、既存文書へ自動更新しない。タイトルの意味をsummaryの先頭切出しやキーワード辞書で代用しない。

## 4. 実行の接続と所有権

1. 主会話から既存の `web_research` を起動する。調査中も会話の窓口は主人格のまま。保存処理をMarkdownのsessionへ委譲しない。
2. Pursuitは既存の計画・取得・回答案更新・読戻し・内容検証を行う。各仮説や未完成の `report_draft` 更新ごとにDoclingへ書かず、終了時に採用した回答案だけを書き出す。
3. ホストが調査ID・epoch・回答案digest・出所・期限を照合し、文書用の固定入力と操作IDをwriterで記録する。Pursuit domainは注入portだけを知り、Markdown・scratch・Doclingを直接参照しない。
4. applicationが既存scratchへ同じMarkdown本文を書き込み、Markdown domainの新規生成文書用の公開操作へつなぐ。scratchとHTTPはwriter外で実行し、受付・対応付け・結果採用は同じwriterと各domainの公開操作で行う。
5. Markdown domainは既存ArchivePort、Queue、digest・結果照合を再利用する。生成文書にはPlate編集データがないため `recovery=""` とし、原文を再シリアライズしない。既存保存処理の共有部分を使い、HTTP・再送・復旧の別実装を増やさない。生成文書の固定入力と保存状態を持つ最小の記録は追加する。
6. 保存の終端が分かった時点で、調査結果・一時ファイルref・Docling文書ref・保存状態を既存TODO/Host noticeへ一度だけ返す。未保存や結果不明も終端として報告し、LLMや会話runを開いたまま待たない。既存の報告画面・Markdown一覧・成果物のリンクから開く。

接続の版案（実装開始時に並行差分と再照合する）:

| 接続 | 新版案と維持するもの |
| --- | --- |
| 会話 → 調査 | `web.research@6` → `package:pursuit.research@4` / `skill:pursuit.research@4` / `binding:pursuit.research@3`。profileの役割とtask lifecycleは維持 |
| 調査 → 回答案 | 新bindingに対応するタイトル付き入力契約。旧bindingの `report_draft` schemaを上書きしない。調査中の旧実行へ保存義務を後付けしない |
| 調査 → 保存 | applicationで注入する文書保存port。Markdown domainにsessionを要さない新規文書保存の公開操作・結果照会を追加。ホストが操作元を照合し、UI専用操作の既存origin制限を一括解除しない |
| 保存 → 結果 | `schema:pursuit.result@3` に文書ref・タイトル・保存状態を追加。調査のstatusとは別の欄にする。既存resultやreceiptの本文を同revisionで変更しない |
| 結果 → 画面 | 既存の報告・scratch・MarkdownのResourceAdapterとOpenUI構成を使用。必要なsource/action契約だけ新版へ追加し、専用の文書閲覧画面は作らない |

新規文書を作る新版の副作用は `create` として登録し、Agencyも既存のcreate権限・予算・出所失効検査を通す。旧read権限の実行を保存可能へ昇格させない。既存文書の変更・公開・他者への送信権限は付与しない。実装時にadapterを版別にするか、現在の凍結bindingから副作用を判定する共通契約を使うかは、旧read実行へcreate権限が漏れないことを条件に決める。

## 5. 保存状態と停止

| 条件 | 期待する結果 |
| --- | --- |
| 完了した調査 | タイトル付き本文を一時保存し、Docling利用可能時は同じ本文を新規保存。両方の結果を返す |
| 取得不足等で部分結果になった調査 | 本文に未完・不足・限界を明記して同様に保存し、調査statusはpartialを維持。タイトルは調査中から回答案に保持する |
| Docling未設定・未対応・接続不能・領域の権限なし | 一時保存した参照を返し、Docling未保存の理由を示す。接続先やサービスを自動起動・変更しない |
| scratchの容量不足等 | 調査結果を消さず一時保存失敗を返す。独立したDocling保存は可能なら行い、片方の成功をもう片方の成功としない |
| PUTの応答喪失・5xx | 同一IDのGETでtitle・path・digestを限定照合。自動PUT再送、新IDでの作り直し、新ETagへの載替えをしない。不確定なら「保存結果不明」 |
| 同じ調査結果の再通知・再起動 | 固定操作ID・epoch・digestで照会し、文書を重複作成しない。scratchが消えた場合は失効とし、Docling文書と混同しない |
| 取消・忘却・出所失効・接続変更 | 保存受付・送信直前・結果採用で検査し、未送信の処理を止める。送信済みの副作用を取消できたとは報告せず、遅い結果を新しい実行へ採用しない |
| 調査期限切れ | 追加の調査はせず、既存のpartial確定を使う。有効な出所の部分結果に限り、固定の保存期限内で書き出す。保存待ちは既存文書API相当の上限内、無期限にはしない |

忘却時は新規に保持した出所・本文・参照・一時ファイルの到達経路も対象に含め、保存前なら処理を停止する。既にDoclingへ確定保存された独立文書は、会話忘却だけで自動削除しない。利用者の文書として既存の文書管理操作で扱い、この機能に自律削除権限を追加しない。

保存の確定には送信前に固定したID・本文digest・タイトル・配置の一致を必要とする。保存の可用性はsettingsの有無だけで成功と推測せず、既存capabilitiesと実際の操作結果を使う。保存失敗を理由に調査の内容検証を弱めたり再調査を始めたりしない。

## 6. 実装順・検証・残作業

| 順序 | 作業 | 完了の証拠 |
| --- | --- | --- |
| P0 | 利用者による本案の確認、対象の並行差分・旧revision・既存試験のbaseline確認 | 保存対象・配置・新規作成の副作用と旧実行の互換性を確定 |
| P1 | Markdownの新規生成文書保存契約、固定入力・receipt・Queue・公開照会、applicationのscratch接続 | Markdown本文とtitleが保持され、session不要。二重保存・競合・結果不明・容量・接続変更の部分試験 |
| P2 | Pursuitのタイトル付き回答案、新版Skill/bundle、終了時保存・通知・取消・忘却の接続 | 公開task入口から調査→検証→保存→TODO結果まで固定モデルで通り、specialist sessionが作られない |
| P3 | 参照・報告画面・既存一覧との接続 | `.md`取得、Docling一覧のresearchフォルダー、保存文書を既存Plateへ取込み・編集する経路を確認 |
| P4 | 影響domain検証・差分点検・記録 | 下記のgateと題材の異なる受入。fixture/live/画面を分けて記録 |

検証は部分→結合→通しの順。変更対象に応じ `bun run verify -- --domain pursuit --domain markdown --domain docling --domain scratch --domain capabilities --domain tool-runtime --domain dialogue --domain resources --domain artifact` を使い、applicationのPursuit・Markdown・scratchの結合試験も明示する。Agencyのcreate可用性も該当の固定試験で確認する。bundleのfresh/旧seed済みDB・二度目seed・旧revision hashの不変を確認する。

必要な受入ケースは、通常完了、別題材・長い日本語タイトル・同名タイトル、部分結果、Doclingなし、GET/PUTのみ、拡張あり、応答喪失後のGET一致/不一致、同一操作の再照会、取消・忘却・設定変更、再起動、一覧からの編集。本文とリンクをUTF-8で読戻し、保存の完了文だけで成功にしない。画面は対象E2Eを個別指定し、実LLMの執筆と実LARM保存は固定試験と区別する。サーバー反映が必要な場合は利用者の操作・明示許可を待つ。

本設計作成時は既存設計・実装契約の読取りと照合のみ。新機能の固定試験・live・画面受入は未実施。文書だけの変更のため製品試験は実行しない。作業ツリーにはAgency・Markdown・Docling等の既存未コミット差分が多数あり、それらの製品コードを本作業では変更していない。

着手時の残作業: P0の設計合意、P1〜P4の実装と検証、必要なサーバー反映後の実接続受入。現在の実施結果と残作業は7節および検証記録を参照。専用の意味判定・題材別条件分岐を加えず、保存接続・契約検査・状態管理だけをコードで担うことを最終差分でも点検する。


## 7. 実装と検証の記録

2026-11-08、利用者が本案の実施と、必要な場合のPursuit本体の改修を許可した。今回はEumenesのホスト接続で満たせたため、Pursuit配布物・本体は変更していない。

実装: タイトル付き回答案と新版Skill/binding/adapter、新規生成文書の固定入力とQueue、一時ファイル出力、既存の条件付き保存・GET照合の共用、保存待ちと結果通知、取消・忘却、文書refと既存Plate画面への取込みを接続した。新規作成の副作用をcreate版へ分離し、旧read版のschemaは維持した。Doclingの論理pathで `research/` を作るため、フォルダー管理の変更APIは実行しない。

旧版fixtureは、公開されていたpackage/skill/toolchainを明示して旧実行の検証を続ける。新規DBと旧bundleを登録したDBの両方、新版の再seed、旧revision不変を別途確認する。既存の能力失効規則を迂回して旧実行を延命する変更は加えていない。

追加したGET照合の入口は `POST /api/markdown/generated/{id}/check`。生成文書の保存中・結果不明とライブラリ管理操作を同じnamespaceで競合させない。保存後の一時ファイル失効も既存のreceiptから反映し、再作成しない。

検証結果と残課題は [検証記録](verification/web-research-markdown-2026-11-08/README.md) に記載する。設計時点ではサーバー操作を対象外としていたが、後続で利用者が起動と実践テストを明示的に許可した。既存サーバーの起動後、実モデルで題材の異なる調査2件を完了し、scratchと実Doclingの同一本文、専用フォルダー、通知からの表示、担当切り替えなしを確認した。取消操作も実接続で検証し、会話側の自然文中止・担当選択の問題と所要時間を別課題として記録した。製品コード・配布物・接続設定はこの追加検証では変更せず、サーバーを起動したままにした。
