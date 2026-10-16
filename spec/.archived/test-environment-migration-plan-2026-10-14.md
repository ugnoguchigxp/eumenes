# Eumenes テスト環境移行計画

作成日: 2026年10月14日

改訂日: 2026年10月15日 改訂3

状態: 再評価を反映した計画案。初回範囲はA・B・M。移行実装は未着手。

対象: ローカル検証とCIの実行範囲、実行順序、ビルド整合、入力固定、結果の保存。

Eumenesの既存の `verify` を拡張し、正しい入力に対して必要な試験を実行し、その範囲と結果を追跡できる環境へ移行する。初回は試験の実行漏れ、古いDesignSystemビルドの利用、結果保存の不足を解消し、自動選択とCI並列化の効果を比較する。

**変更からの自動選択は条件付きの後続段階とする。** 現在のdomain所有パスだけでは実際の変更の多くを扱えない。application・共通Web・DesignSystemの対応を含めた小さな分析で効果を見積もってから、表示専用の計画生成へ進む。

Replay、不変条件の試験、JiTTestは[テスト品質改善の後続案](../test-quality-improvement-options-2026-10-15.md)へ分離した。本計画の完了に、それらの導入を要求しない。

## 1 目的と成功の定義

解決する課題は、検証対象の選びにくさ、結果が出るまでの待ち時間、編集による結果の無効化、入力と実際に実行したコードの不一致である。テスト本数の削減自体は目的にしない。

- 発見した試験に実行経路があり、必要な利用側試験を取りこぼさない。
- 変更したソースから作った成果物を試験し、元の作業ツリーや古い成果物へ参照が逃げない。
- 結果に入力、環境、実行範囲が紐づき、部分合格を全体合格と扱わない。
- 準備と再実行を含めたローカルの待ち時間、CIの完了時間、CIの総runner時間を別々に測定する。
- 自動選択を見送る場合も、初回の実行漏れ修正と計測を独立した成果として完了できる。

## 2 現状と根拠

改訂時に確認したHEADは `2086a25baadbd78354672d085641cfc0b95858f8`。改訂2の着手時は作業ツリーがcleanだった。改訂3では改訂2の文書差分を引き継いでいる。性能値は2026年10月14日の保存済み記録であり、現在の再測定値ではない。初版の調査HEAD `296986df5c6c5d895df93885d7db6a46f2a69a43` と混同しない。

| 確認事項 | 根拠 | 対応 |
| --- | --- | --- |
| JS/TSの試験ファイルは527本。MJSを含めると528本 | 同じHEADのGit treeを再集計。追加の1本は `scripts/dots-oauth/provider.test.mjs` | ファイル数は参考値。Storybookのような生成試験を含むrunner/project単位で棚卸しする |
| `--affected` は未実装。`--domain` は1つを読み、`selected[0]` の試験だけを実行する | [verify](../../scripts/verify.ts) | 自動選択に先立ち、複数domainを1回で扱えるようにする |
| 依存閉包の表示は、利用側試験の自動実行を意味しない | [verify](../../scripts/verify.ts)、[test-domain](../../scripts/test-domain.ts) | 試験の選択根拠と実際の実行集合を一致させる |
| DesignSystemの試験はdomain所有パスから収集されても実行先に振り分けられない | [test-domain](../../scripts/test-domain.ts)、[domains](../../scripts/domains.ts) | DesignSystemの既存runnerへ渡す |
| `tests/acceptance/nl` の4ファイルはブラウザなし、driverはChromiumを起動する | [runner試験](../../tests/acceptance/nl/runner.test.ts)、[run処理](../../scripts/nl-acceptance/run.ts)、[driver試験](../../tests/acceptance/nl/driver.test.ts)、[driver](../../scripts/nl-acceptance/driver.ts) | `verify:all` にはブラウザなし4本だけ登録し、driverはファイルを明示した別実行とする |
| DesignSystemにはunitとstorybookの2 projectがあり、通常のtestはunitのみ | [Vite設定](../../packages/design-system/vite.config.ts)、[Storybook入力](../../packages/design-system/.storybook/main.ts)、[package](../../packages/design-system/package.json) | storiesから生成する試験も棚卸しする。storybookはブラウザ区分として初回の全件CIから除外する |
| DesignSystemのbuild用型検査はtest・spec・stories等を除外するが、通常の型検査はsrc全体を含む | [通常tsconfig](../../packages/design-system/tsconfig.json)、[build用tsconfig](../../packages/design-system/tsconfig.build.json) | buildを通常の型検査の代わりにせず、検査範囲を維持する |
| format・lint・root型検査は既に試験より前。DesignSystem型検査は後ろにある | [verify](../../scripts/verify.ts) | 順序改善はDesignSystem型検査の前倒しに限定して記述する |
| DesignSystemのexportsは `dist` を指し、rootのVitestにsrcへのaliasはない | [package](../../packages/design-system/package.json)、[Vitest設定](../../vitest.config.ts) | 利用側の型検査・試験より前に、その入力のDesignSystemをビルドする |
| `postinstall` にsource hash付きのビルド補助があるが、domain検証は呼ばない | [build補助](../../scripts/build-design-system.ts)、[root package](../../package.json) | 既存buildを再利用する。現在のstampはlockfile・runtime・出力内容まで保証していない |
| workspaceのDesignSystemとartifact-uiは相対symlinkで接続される | `node_modules/@eumenes` の参照先 | snapshotで元のnode_modules全体をsymlink共有しない |
| 検証digestは実行権限・symlink先を含まず、DesignSystemのdistを除外する | [入力hash](../../scripts/verification-inputs.ts) | 入力manifestに種別・必要なmode・リンク先を含め、成果物は生成元との対応を記録する |
| CIの結果アップロードは失敗時だけ | [CI定義](../../.github/workflows/verify.yml) | 成功・中断も含め実行ごとに保存する |
| 音声domainは約10.1秒。全体のbackend等の試験は302.37秒、その後のDesignSystem型検査で失敗した | [domain記録](../verification/voice-input-latency-2026-10-14/verify-voice-dialogue-final.log)、[全体記録](../verification/voice-input-latency-2026-10-14/verify-all-final.log) | 現在の基準値を測り直す。古い記録の失敗を現行不具合と断定しない |
| 検証中の入力変更による無効化がある | [実行記録](../verification/object-recognition-shared-credential-2026-10-13/verify-object-recognition-invalidated.json) | 入力変更検出を維持したまま固定実行を検討する |

試験ファイル数の集計条件は、Git treeのパス末尾に対する正規表現 `\.(test|spec)\.[jt]sx?$` で527本、`\.(test|spec)\.[cm]?[jt]sx?$` で528本。時点の差ではなくMJSを含めるかの差であり、Storybookの生成試験数はどちらにも含まれない。

### 2.1 過去変更の再集計

レビューの主要集計は再現できた。改訂時HEADからfirst-parentの直近60コミットを調べ、`.ts`・`.tsx`・`.css`・`.json` の変更を対象とし、`spec/` と `docs/` を除いた。各コミットの変更パスを改訂時の `ownedPaths` と照合した。最古の対象は `8deba7083234ed6cd5183d6045572aace2161173`。

| 集計項目 | 件数 |
| --- | --- |
| 対象コミット | 60 |
| 上記のコード変更を含むコミット | 52 |
| domain所有パスだけで閉じるコミット | 2 |
| 単一domainだけで閉じるコミット | 0 |
| 所有外の `api/application` に変更があるコミット | 42 |
| 所有外の `web/src` に変更があるコミット | 39 |
| 所有外の `tests/browser` に変更があるコミット | 39 |
| 所有外の `packages/design-system` に変更があるコミット | 25 |
| `scripts/domains.ts` に変更があるコミット | 21 |
| `api/infrastructure` に変更があるコミット | 16 |
| `package.json` に変更があるコミット | 16 |

複数カテゴリに触れるコミットは重複計上する。この2/52は所有パスだけで閉じる比率であり、完成後の自動選択率でも速度改善率でもない。現在のグラフを過去へ当てた概算で、YAML・lockfile・shell等もこの集計では網羅していない。複数作業をまとめたコミットと、ローカルの実際の作業単位も区別する。正式な評価では前後のグラフと全入力種別を使う。

## 3 変更範囲と設計原則

既存の `domains.ts`、boundary検査、Bun・Vitest・Playwright、DesignSystemのbuild、JSONレポートを再利用する。試験実行のために新しい製品domainや汎用Verification Engineは作らない。

自動選択では、domain間依存に加え、applicationの配線、共通Web、DesignSystem公開コンポーネントと利用側、client、動的bundle登録を主要な対象とする。静的importで求まる関係は導出し、動的接続等の不足だけ試験側の契約として宣言する。対応情報は実行可能な検査で整合を保ち、別の手書き台帳に依存グラフを複製しない。

変更意図や追加の故障仮説はLLMが判断できる。コードは構造上の依存、必須契約、実行範囲、予算、入力の有効性を管理する。語句辞書で意味判断を代替せず、LLMの「低リスク」という判断だけで必須試験を除外しない。初回移行では新たなLLM呼出しを必須にしない。

本書の「全件CI」「全体検証」は `verify:all` が担当する非ブラウザ検証を指し、driver・storybook・製品のブラウザE2Eを含めない。

既存テストの大量削除、期待値の緩和、runtimeの全面統一、製品DB・認証・業務仕様の変更は対象外。fixture・live・実機器受入を区別する既存規則を維持し、ブラウザE2Eは対象ファイルを明示して別実行する。

## 4 段階0 正しい実行と比較材料を先に整える

### 4.1 初回実装

1. **実行経路を補う。** ファイル名だけでなく、runner設定のproject、生成元、起動資源を棚卸しする。domain試験から該当DesignSystem試験を既存のunit projectで実行する。`verify:all` に加えるacceptance試験は `judge.test.ts`、`frozen.test.ts`、`tester-parser.test.ts`、`runner.test.ts` の4本だけとし、ディレクトリ全体を渡さない。`driver.test.ts` とstorybook projectはブラウザ試験として別管理する。実LLM受入runも混ぜない。
2. **複数domainをまとめる。** 複数指定を明示的に受け付け、静的検査の対象パスと試験集合の和集合を取り、重複を除いて1回の実行とレポートにまとめる。各runner・package固有の設定は保つ。単一指定と既存subdomain指定の互換性を壊さず、余分な引数を黙って無視しない。
3. **型検査とbuildの順序を固定する。** DesignSystemを消費するrunでは、`format → lint → DesignSystem通常型検査 → DesignSystem build（build用型検査を含む）→ root型検査 → 試験` とする。境界・サイズ・文書整合等の既存検査も省略しない。build用tsconfigはtest・spec・storiesを除外するため、通常型検査を削除しない。root型検査が読む `dist/index.d.ts` は同じrunで生成したものにする。
4. **古いdistと途中で書き換えられたdistを検出する。** 変更したsrcだけでなく欠落・古い生成物も考慮し、対象run内で既存buildを1回実行する。build成功直後と、消費側の型検査・試験・Web buildがすべて終了した時点でdistのパス集合と内容hashを比較する。不一致・欠落・読取り失敗なら結果を無効にする。消費側へ同じ成果物を渡し、最後のWeb buildで再度DSを生成しないよう既存の呼出しを整理する。build失敗時に以前のdistで試験を続行しない。
5. **結果を保存する。** 実行ごとのレポートを保持し、`latest.json` を残す。CIは成功・失敗時とも保存し、中断時は得られたstepの状態を残す。レポートが生成されない中断も合格にしない。

**初回のブラウザ区分**

| runnerと対象 | 実行経路 | 初回CIでの扱い |
| --- | --- | --- |
| Bun / acceptanceのjudge・frozen・tester-parser・runner | 上記4ファイルを明示して `verify:all` に登録 | ブラウザ準備を要求しない。runnerはfakeDriverを渡し、run側のDriver importも型のみであることをコードで確認済み。実装時にもブラウザなしの環境で確認する |
| Bun / acceptance driver | `bun test tests/acceptance/nl/driver.test.ts` と明示した別実行 | `verify:all` とその全件CIには含めない。別実行時だけChromiumとOS依存を準備する |
| Vitest / DesignSystem unit | 既存の `--project unit` を使う | 非ブラウザ検証として実行する |
| Vitest / DesignSystem storybook | `.storybook/main.ts` のstoriesを生成元として登録し、対象storyファイルを明示した別実行を定義する | ブラウザ区分のため初回CIから明示的に除外する。実行手順の確認と専用CIの追加は後続とし、未実行を合格と表示しない |

棚卸しの主単位はrunnerのproject／実行区分とし、project内の手書きファイルと生成入力も照合する。新しいprojectや試験が見つかった場合は、実行資源と経路を分類するまで未登録として報告する。拡張子だけでブラウザの有無を決めない。

**共有distの制約**

段階0では出力先が共有の `packages/design-system/dist` のままであり、verifyのlockはdev・E2E・手動buildを制御しない。検証buildが他の利用者へ影響し、逆方向の書換えも起こり得る。同じdistを使うdev・E2E・別buildと重ならない実行をBの運用前提にし、確認できなければ待機または独立した環境で実行する。他プロセスを無断で停止しない。

前後のhash照合は書換えの検出を追加するもので、試験中に変更され元へ戻った場合や、他のconsumerへの影響を防ぐものではない。hash一致だけで排他性を証明したことにしない。共有出力への依存を解消する根本対応は段階2のsnapshotに置き、段階0で隔離完了とは宣言しない。

初回はbuildを省略するキャッシュを新設しない。将来既存のbuild stampを使う場合は、source・build設定・lockfile・toolchainと出力の対応を検査できることを条件にする。distを入力digestへ追加するだけでは、正しいsrcから生成された保証にならない。

### 4.2 計測と代案の比較

本格的な `--affected` を実装する前に、次を分析・試行する。

- 過去コミットと、記録できるローカル作業単位を別々に集計する。前後の所有・依存グラフを使い、application・共通Web・DesignSystemの代表変更へ暫定対応を当てる。局所選択できる割合、全体へ戻る理由、推定実行時間を記録する。
- step別時間、build・install・準備時間、再実行、入力変更による無効化を測る。初回の実行漏れ修正で試験が増えた分を高速化の悪化と混同しない。
- **全件を保ったCIのjob分割を比較候補にする。** 独立runnerで静的検査、Bun試験、Web/client試験、DesignSystem試験・buildを分ける。依存関係があるjobでは正しいbuild成果物を先に用意する。成功・失敗を集約する最終判定で全jobの完了を要求し、cancelled・skippedを成功扱いしない。
- 分割前後で試験集合の和集合と必須検査が同じことを確認する。環境の独立で共有DB等の競合は避けやすいが、分割漏れや実行順序依存が消える保証はない。

Bunの長い試験群が約302秒のままなら、他のjobとの並列化だけではその時間より短くならない。大枠のjob分割で30％短縮できるとは仮定しない。必要ならBun試験群内部の分割を別に評価し、global mockや共通資源の依存を確認する。install・postinstallの重複、runner待機、成果物転送、総runner時間も比較する。

CI分割の試行中は現行の全件判定を残すか、同等性を確認した全件構成で比較する。試行の準備を理由にローカルのlockを外さない。この改訂ではworkflow自体は変更しない。

### 4.3 完了条件と次段階の判断

初回完了には、project・生成試験まで含む棚卸しとブラウザ分離、複数domainの重複排除、排他実行の前提下でのbuild整合とdist前後照合、レポート保存を確認し、段階1へ進むか見送るかの判断を残す。分析用の小さい対応付けは作るが、表示専用 `--plan` の完成を初回完了条件に含めない。

局所選択率だけの一律閾値は置かない。高頻度でも短い試験だけを減らす案と、低頻度でも長い試験を減らす案では効果が異なるためである。**ローカルの代表作業群で、build等の準備を含めて中央値30％短縮を見込めるか**を段階1の暫定着手基準とし、対応情報の更新負担も併記する。見込めなければ自動選択の優先度を下げ、全件CIの並列化や長い試験の改善を優先する。30％は未達の仮説であり、評価開始前に条件を固定する。

CIだけが短縮できてもローカル改善の証拠にはしない。CIが目標を満たしても、ローカルの負担が残り上記条件を満たすなら段階1へ進める。

## 5 段階1 利用側を含めた検証計画を生成する

段階0の着手条件を満たした場合に、計画表示だけを先に実装する。出力は変更一覧、対象試験、対象外とした理由、必須契約、build等の実行依存、影響不明の範囲を含む。CLI名は実装時に確定し、現行で未実装のオプションを運用手順として案内しない。

### 5.1 対応情報の主要対象

| 対象 | 初期の扱い |
| --- | --- |
| domain | 前後の所有パスとAPI・Web・test-only依存から利用側へ辿る |
| application | 配線・公開操作・登録adapterと、その結合試験を対応付ける。巨大な共通fixtureをimportするだけで全機能への意味的依存と断定せず、公開契約の宣言も使う |
| 共通Web・DesignSystem | 公開コンポーネント・共通hook・CSS・entryの利用関係を求め、関係するdomain試験・Web結合・明示したbrowser試験を選ぶ。選べない場合は全Web/DSの決定的試験へ広げる |
| client・bundle | API契約、client wrapper、登録adapter、schemaの接続を対象とする。動的接続を無視しない |
| `scripts/domains.ts` | 単なる登録データの変更なら前後グラフの差分と両側の逆依存を使う。所有移動は旧・新両所有者を含める |
| 選択処理・共通設定・依存物 | グラフ走査関数、`ownedPaths`等の処理、runner・lockfile・root設定の意味を限定できない変更は全体の決定的検証へ戻す |

`domains.ts` は実行コードも含む。任意の変更前コードを評価してグラフを取り出さず、安全に読める宣言部分を解析する。解析不能・スキーマ変更・動的計算・グラフ検査失敗は保守的に扱う。登録項目の変更を限定できた場合も、全体のグラフ整合とdomain文書整合は省略しない。

宣言する対応情報には存在・重複・未登録の検査を置く。判断不能を適当なdomainへ割り当てない。未対応領域を減らすために必須契約を弱めない。

### 5.2 比較基準

**mainへのpush**ではイベントの `before SHA` から検証対象の `after SHA` までの全変更を対象とする。複数コミットをまとめたpushで最後の1コミットだけを調べない。beforeがゼロ・取得不能・想定外の履歴の場合は、全体の非ブラウザ検証へ戻す。PR時の基準も支援するが、PRだけを前提にしない。

最小構成は、beforeの必要な検証の成功が確認できなければ全体の非ブラウザ検証を行う。確認材料がない状態も「未検証」とする。成功の証拠を利用する場合はSHA、Linux・macOS両方の必要job、検証範囲・設定の対応を確認し、単に緑のstatusがあるだけでは採用しない。

初期のverifyにはGitHub APIによるCI履歴探索や「最後の成功点」の自動探索を追加しない。CI側から信頼できる成功証拠を渡す経路がなければ、CIは全件のまま、段階1をローカルの計画表示に限定できる。履歴参照や累積基準を将来追加する場合は、権限・API障害・rate limit・複数OS結果の照合・保持期間の費用を、対応情報の維持負担と並べて段階1の採否時に評価する。push前にCIが完了している保証も置かず、push後の失敗を変更採用前の防止と混同しない。

**ローカル**では最後の有効な検証結果を候補にするが、digestだけでは差分を復元できない。基準のファイルmanifest、必要な旧グラフ、ソースを再取得できる参照、検証済み範囲、環境条件が揃うことを条件にする。あるdomainだけの合格をリポジトリ全体の正常基準に昇格させない。条件を満たさなければ明示的なGit基準と作業ツリー差分を使い、必要な範囲を広げる。ローカル履歴を基準にできない初期版でもGit基準で運用できる。

どちらも新規・削除・改名・staged・unstaged・未追跡の対象入力を扱う。変更前後のグラフを得られない場合は範囲を広げる。ブラウザの対応不明は未解決として残し、無指定の全件E2Eへ自動的に逃がさない。prompt・schema変更に対する判断品質は、固定応答のfixtureだけで確認済みとしない。

### 5.3 完了条件

代表的な過去変更と合成差分で選択漏れを確認し、計画に出した試験集合とrunnerへ渡す集合が一致すること。application・共通Web・DesignSystemを主要対象として扱い、全体へ戻る割合と理由を報告する。計画表示の完成だけでは、実行時間の改善やCI縮小の完了を宣言しない。

## 6 段階2 固定入力での実行と比較運用

### 6.1 snapshotの忠実性

固定実行には独立したディレクトリを使い、新しい作業ブランチは作成しない。

最初の検証項目は、**workspaceパッケージがsnapshot側へ解決されること**とする。元の `node_modules` ディレクトリ全体へのsymlink共有は禁止する。DesignSystem、artifact-uiなどの実参照先を確認し、元の作業ツリーを変更してもsnapshotの読取りと動作が変わらないことを試験する。

| 候補 | 確認事項 |
| --- | --- |
| snapshot内でlockfileからinstall | 忠実性の比較基準。installとpostinstallの時間を含める |
| macOSのAPFS clone機能を使う複製 | `cp -c` 相当を候補にし、使用可能なfilesystem、symlink保持、実解決先、書込み分離、所要時間を実機で確認する。まだ採用方式ではない |
| OSをまたぐ通常コピーまたは依存キャッシュ利用 | Linuxでも同じ忠実性条件を満たす。共有できる不変の外部依存と、snapshot内に必要なworkspaceを区別する |

ソース・未追跡入力・削除・改名・実行権限・symlinkの種別とリンク先・必要資産をmanifestに含める。snapshot外を参照するリンクは宣言された不変依存以外拒否する。取り込み途中の変更を検出したら不完全なsnapshotとして終了する。製品DB、秘密、ローカル設定を丸ごとコピーしない。

DesignSystemのdistは、同じsnapshot内のsrc・設定・依存から再生成し、消費側の型検査・試験より前に成功させる。元のdistのコピーや現在のbuild stampだけでは代替しない。生成元と出力の対応を結果に記録する。DB・port・出力・書込み可能なcacheも分離する。

固定化方式は計測後に選ぶ。準備時間が利点を打ち消す場合は、既存の入力変更検出付き直列実行を維持する。ローカルでのlock解除・並列化は別の判断とする。

### 6.2 比較運用と切替

現行と同じ全件検証を残し、選択した試験と同じ入力で比較する。直近20のコード変更を含むmainコミットを暫定評価集合にするが、CIの実際の単位はpushイベントである。複数コミットのpushは1実行として関連付け、推測で分割したpush履歴を実測として扱わない。必要な履歴がない場合は以後のpushイベントを記録し、コミット分析と区別する。

ローカルは別の代表作業集合で比較し、コミットの集計をそのまま体感時間の代理にしない。小さなUI変更だけでは共通基盤の評価を満たさない。既知回帰と限定的な故障注入を使い、全成功の比較だけで検出力を判断しない。

切替条件は、評価集合で未解決の選択漏れがないこと、入力と成果物が対応すること、準備込みの時間改善を確認すること。Linux・macOSの両方で確認する。全体監査の頻度と公開前に必要な証拠を確定するまで、現在の全件CIの範囲を狭めない。全件を保つjob分割は、選択による範囲縮小と別に採用できる。

選択漏れが判明したら自動的な省略を停止し、全件の決定的検証へ戻す。snapshot不備の場合はその結果を無効とし、入力変更検出付き実行へ戻す。結果は検証したsnapshotにのみ有効で、後から編集された作業ツリーの合格として流用しない。

## 7 証拠と検証の契約

初回は既存JSONを拡張し、新しい証拠DBを作らない。レポート版、run識別子、入力digest、基準commit、実行範囲、OS・runtime・runner、stepの状態と時間、停止理由を保存する。DesignSystemを使うrunにはbuildの入力・出力の対応と、build直後・消費側終了時のdist hashを残す。

manifestや旧グラフはローカル基準・snapshotに必要となる段階で追加する。選択理由は計画生成段階で追加する。LLM追加提案、モデル費用、Replay用seed等は後続案の実装時に追加し、初回の必須契約にしない。資格情報やProviderの生応答を記録しない。

必須項目の未実行・中断・入力不一致を合格としない。失敗の原因が不明なら未確定とする。担当外の既存失敗は証拠と影響を報告し、無断で修正・除外しない。

| 実装単位 | 部分検証 | 結合と通しの完了条件 |
| --- | --- | --- |
| A 試験経路と複数domain | runner/project・生成元の列挙、ブラウザ区分、振分け、重複排除、引数の拒否 | ブラウザなしacceptance4本とDS unitが動く。driver・storybookが `verify:all` に混入せず、別実行／除外理由が記録される |
| B build整合・順序・履歴 | 通常／build型検査の範囲、順序、dist hash、状態、report互換 | 古いdistと型宣言を置きsrcだけ変更したケースで新しい成果物を利用。test型エラーも検出する。build失敗で停止し、外部からのdist書換えを無効化。共有利用への制約を記録 |
| M 計測と代案比較 | 分類条件・基準範囲・時間集計 | 前後グラフと共通領域を含む選択見積り、全件job分割の集合一致と準備込み計測、採否を記録 |
| C 計画表示 | 削除・改名・未追跡・グラフ差分・複数commit push | applicationとUIの対応を含め、計画と実行集合が一致。before失敗時や部分合格基準から未検証変更を落とさない |
| D 固定入力と選択実行 | mode・symlink・manifest・buildの出自 | 全workspaceがsnapshot側を参照し、元ツリー変更の影響を受けない。同一入力の全件結果と比較 |

A・B・Mを初回範囲とし、C・Dは計測後の条件付きとする。検証基盤の変更は対象script試験から始め、`bun run verify -- --domain <name>` による代表domainの結合確認、固定入力の `bun run verify:all` の順に確認する。必要なブラウザ試験はファイルを明示し、CIでは既存のflaky拒否方針を維持する。

レビュー時点の実装を変えていないため、今回の改訂では製品試験・CI試行を実行しない。実装時に通し検証を省略する場合は理由と未確認範囲を残す。

## 8 指標と未決事項

| 指標 | 定義と判断 |
| --- | --- |
| 局所選択率 | 全件より小さい試験集合を選べる変更の割合。変更分類別に示し、時間削減率と混同しない |
| ローカル待ち時間 | 実際の現行手順との比較。準備・build・無効化・再実行を含む有効な結果までの時間。中央値30％削減を暫定目標とする |
| CI完了時間 | 同じ対象commitと全件範囲で、開始から必須jobがすべて終わるまで。待機・installを別記し、30％削減は独立した暫定目標とする |
| CI総runner時間 | 並列jobの時間の合計とOS別費用。許容増加量を試行開始前に定める |
| 選択漏れと安定性 | 全件のみで検出する失敗、既知回帰の見逃し、同一入力の揺れ、再試行だけ成功したもの |
| 維持費用 | 対応宣言・build条件・snapshot実装の更新時間と調査負担 |

30％は未検証の目標である。計測条件を評価前に固定し、目標未達を理由に必須試験や期待値を削らない。元々domain検証で済むローカル変更を全体検証と比較して改善を大きく見せない。

初期方針は、storybookをブラウザ区分として全件CIから除外し、beforeの成功証拠が不明なら全件検証へ戻すこととする。未決事項は、storybook専用CIの採用と明示対象の実行手順、将来のCI履歴参照の費用、applicationの対応宣言の粒度、CI並列化のrunner予算、snapshotの方式、ローカル基準を保持する範囲、全件監査の頻度、レポート保持期間。順序はA・B → M → Cの採否 → Dの採否とし、CI分割はMの結果で独立して判断する。3ラウンドでの俯瞰評価など作業中の停止規則はAGENTS.mdに従い、環境移行の受入条件と混ぜない。

## 9 外部評価への対応と再評価依頼

| 指摘 | 判断と反映 |
| --- | --- |
| domain所有外の変更が多く、選択が効かない | 採用。60コミットの主要集計を再現し、application・共通Web・DSを段階1の本体へ変更。Cを初回必須から外した |
| 古いDesignSystemのdistを試験する | 採用。段階1を待たず初回Bでbuild整合を扱う。全件のWeb試験にも適用する |
| snapshotのnode_modules参照が元ツリーへ逃げる | 採用。workspace解決をDの最初の受入項目とし、APFS cloneを未評価の候補として追加 |
| CIのjob分割との比較がない | 採用。ただし302秒の主要試験群が残るため、30％改善や修正費用の小ささを未測定で断定しない |
| mainへの直接pushを基準にする | 採用。before/afterと複数コミットpushを明示。失敗したbeforeやローカルの部分合格を正常基準にしない条件を補足 |
| Replay・JiTTestは別計画にする | 採用。後続案へ移し、移行の完了条件と初回レポートから分離 |
| 複数domainを1回で実行する | 採用。初回Aに含め、静的検査・build・試験を重複排除 |

### 改訂3での対応

| 再評価の指摘 | 判断と反映 |
| --- | --- |
| acceptance driverを全件へ入れるとブラウザ分離規則に反する | 採用。ブラウザなし4本だけを登録し、driverはファイル明示の別実行にした。runnerのfakeDriver注入を確認した |
| Storybookの生成試験が棚卸しから漏れる | 採用。runner/project・生成元を主単位にし、storybookは初回CIから理由付きで除外した |
| 共有distが他プロセスに書き換えられる | 採用。前後hashと無効化条件を追加。前後一致では一時的な書換えや他consumerへの影響を防げないため、重複実行を避ける運用前提とsnapshotへの責任分担も明示した |
| DS buildと通常型検査をまとめる | 順序の明確化は採用。build用tsconfigはtest・stories等を除外するため代替は不採用とし、通常型検査を残した |
| 528本と527本の不一致 | 同一HEADで再集計。差は `provider.test.mjs` 1本であり、両方の数と正規表現を明記した |
| beforeの失敗時にCI履歴参照が必要になる | 最小案を採用。成功不明なら全件へ戻し、履歴APIの追加は初回対象外とした |

Opusへの再評価では、次の依頼文を使用できる。

> 改訂3のテスト環境移行計画を、再評価の指摘が解消されたかという観点で評価してください。AGENTS.mdと根拠コードを読み、今回もレビューのみで、コード変更、実接続、別チャットへの送信は行わないでください。
>
> acceptanceのブラウザなし4本とdriverの分離、Storybookを含むrunner/project棚卸し、通常型検査を残したDS build順序、共有distの前後hashの限界と排他実行の前提、beforeの成功不明時の全件fallbackを優先してください。初回A・B・Mを拡大しすぎず、なお偽の合格や選択漏れが起きる具体例を示してください。
>
> 採用判断、重要度順の残問題、コード上の根拠、最小修正、未決事項を返してください。既に確認した60コミットの所有パス集計を速度改善率と扱わず、事実・設計上の欠陥・未検証の仮説・好みを区別してください。

## 10 関連文書

- [検証手順](../../docs/verification.md)
- [domain一覧](../../docs/domains.md)
- [自然言語UI受入](../../docs/nl-acceptance.md)
- [既存の配布物整合試験](../../api/application/vendor.test.ts)
- [Replay 不変条件 JiTTestの後続案](../test-quality-improvement-options-2026-10-15.md)


## 11 初回実装の記録（2026-10-15）

A・Bを実装し、Mの棚卸し・履歴集計・工程時間記録と比較用集計を追加した。利用手順は [検証手順](../../docs/verification.md) に反映した。Cのaffected自動選択とDのsnapshotは導入していない。

- A：ブラウザなしacceptance 4本を全件へ追加。DS unitをdomain試験へ接続し、複数domainの和集合を実行する。Storybook projectの75 sourceとブラウザ24ファイルは別実行として記録する。`.mjs` を含めた棚卸しは実装時530ファイル（元の528＋今回の回帰試験2）で、通常経路は506ファイル。OAuthの `.test.mjs` はBunでも発見されることをfixtureで確認し、既存範囲を維持した。
- B：DS通常型検査→build→利用側型検査→試験の順序、出力前後hash、実行別レポート、割り込み・未実行・無効化の区別、CIの常時artifact保存を実装した。DSのソースは専用の型設定で検査し、rootの選択設定に混在させない。
- M：直近60コミットを、docs/specとMarkdown以外の全tracked変更パスで再集計した。コード変更52、所有パス内だけ2、単一domainだけ0。基準HEADと最古commitは前掲と同じ。現在のgraphを当てた参考値に留める。OCR＋Google Accountsの1回の合格は19,571msで、build 6,520ms、Bun試験3,559ms、Web試験5,302ms、DS試験3,079msだった。比較可能な変更前の合格記録がなく、改善率は算出していない。

変更前の全件検証は `api/application/google-accounts.test.ts` にあるcapabilities内部bundleへの参照境界違反で停止した。またroot型検査では、今回未変更の `tests/browser/object-recognition.spec.ts:265` にTS2769がある。これらを今回の範囲で修正したり、検査対象から外したりしない。全件が合格するまでCI分割の実測比較と改善率判定は保留し、Cは見送る。CI上のinstall/postinstall時間は今後の実行で収集する。CI job分割はまだ採用していない。

初回の局所・結合検証は、移行処理等の13試験、ブラウザなしacceptanceの61試験、OCR＋Google Accountsの選択検証で合格した。全件の合格、ブラウザ・live・実機器の合格を意味しない。実行証跡と最終確認は [初回実装の検証記録](../verification/test-environment-migration-2026-10-15/README.md) に分けて残す。


## 12 受入までの継続（2026-10-15）

利用者の継続指示により、初回に担当外として残した既存の全件失敗も修正対象に含めた。bundle内部の検査は所有domainへ移動し、画像fixtureのBlob取得を型推論できる形にした。整形・lintの既存不備、サイズ制限に抵触する4関数は、検査基準を下げずに修正した。サイズ対応は既存処理の切り出しに限定し、意味判断の変更は行わない。サーバー停止順序の試験には、既存のGoogle Accountsの終了処理を追加した。

前節の失敗記録は初回時点の履歴として保持する。継続後の全件結果、実行時間、残る運用上の制約は [継続の検証記録](../verification/test-environment-migration-2026-10-15/continuation.md) を正本とする。自動選択・snapshot・CI分割は引き続き導入しない。

継続中に会話の機能選択と回答生成を分けた変更との試験前提の差も見つかった。利用者の明示承認により、機能を呼ばず文章だけが返った場合は既存のLLM再確認を1回行い、選ばれた操作を既存の契約検査・実行機構へ戻す。再確認にも直近の利用者発話を使い、過去のassistantの完了主張を操作根拠にしない。通常回答の場合は選択→再確認→回答の3呼出しになり、速度改善とは扱わない。画像の順序・確認質問・履歴の分離・一度だけの楽曲生成を保ったまま試験を整合させる。

初回の全件検証は `scripts/codex-tasks-p0/orphan.test.ts` の完全停止要件で失敗した。その後、利用者がmacOSでのSDK完了待ち・管理対象終了を採用したため、[SDK計画の改訂7](../codex-sdk-task-artifact-plan-2026-10-14.md)に従って受入契約を更新する。同じ孤児再現を除外せず「全停止を偽って証明しない」試験として維持し、正常終了待ちと強制停止を実SDK＋CLI fixtureで追加検証する。全daemon子孫の停止は未対応であり、修正成功とは扱わない。変更後の全件結果は[終了処理の検証記録](../verification/test-environment-migration-2026-10-15/sdk-lifecycle.md)に保存し、過去の失敗レポートは保持する。
