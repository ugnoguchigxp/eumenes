# D0〜D2 実装・検証記録

> 後続の利用者指示で追加サーバー前提を撤回した。この文書・画像は以前の状態の記録。現行は[削除後の設計](../../dots-no-relay-cleanup-2026-10-25.md)を参照。


2026-10-25。利用者が設計案に合意し、D0〜D2の実装・検証を指示。配備先・費用の判断前に報告する。

## 範囲と順序

1. D0: 現行受付・型・権限・停止のbaselineと、relayの版付き境界契約を記録。配備・費用・クラウド実環境・運用上限はD3前の判断事項として残す。模擬対象と実環境を混同しない。
2. D1: bundle、受付profile/SKILL/5 tool、command adapterを接続。既存tasks/dotsの公開操作・所有者検査・receiptを使い、旧fixed runtime経路を移行する。
3. D2: SQLite設定・公開操作、仕事一覧のアイコンボタンと浮動一覧、結果・質問・停止、設定artifact、Web adapterを接続。
4. 部分→結合→domain gate→対象browser fixture。文書・差分・LLM判断の置き場所を確認して記録を完了する。

完了条件: fresh/旧版seed/再seed、会話から受付・確認質問・同一操作照合、権限・revision拒否、設定の再open保持と無効状態、一覧切替・質問回答・停止・設定保存の画面操作を確認。D3の公開クラウド・実Session・PC停止受入は未実施と明示する。

## 再利用と専用実装の根拠

既存 `createDotsDialogue` の対象catalog・元ユーザー発言・revision検査とtasks/dotsの公開操作をadapterへ接続する。会話LLMの受付期限と外部作業期限を分ける。semantic routingの語句分岐は追加しない。

既存の資料一覧操作を参照し、Button/Popover等で仕事一覧を構成する。OpenUI登録JSONを正本とし、専用Artifact種別やWorkspace分岐は追加しない。

## 着手時の差分

既存のP5 messaging差分と、別作業のdialogue/conversation-output・agency設計等の差分がある。これらは保全し、今回の変更との関係を最終確認する。mainで作業。`initial_instructions` は会話内で実行済みのため再実行しない。

## 実装した内容

- D0: ローカルの受付・保存上限と、クラウド受領receiptの版付きwire契約を固定した。[契約表](d0-contracts.md)のとおり、wireのparseは署名検証ではなく、未実装の遅延採用を有効にはしない。クラウド保持量・期限・clock・署名鍵・配備先・費用はD3前の判断事項。
- D1: `dots-delegation.bundle.json` に受付profile/SKILL/package、start/list/inspect/answer/stop、command binding、adapter、外部担当の新しい版 `dots.orchestrate@3` を登録した。標準の会話catalog・command実行・確認質問・task保存・receiptへ接続した。共通SystemContextは書き増さず、bundleの担当指示と既存のcommandPromptを使う。
- D1移行: 旧固定runtimeの新規受付を除去し、旧taskの照会・停止だけを残した。旧Skill・package本文とhash、保存済みtoolchain revisionを保持する。旧プロジェクトの担当を起動時に自動更新せず、画面からrevisionを確認して変更する。
- D2: `dots/0005-work-settings` を追加。SQLiteに有効化、接続、作業先、受付担当、Session/時間上限、会話表示と起動時受取の設定を保存する。既存writer/CAS・下書き・UI操作台帳を使い、同じ操作IDは再実行せず照合する。受付無効を初期値とし、再seedや再openで設定を戻さない。
- D2画面: 既存アーティファクト領域に「dotsの仕事」「dotsの設定」を追加。仕事一覧はアイコン付きボタンから開く浮動一覧で、Select・常設サイドバーを使わない。要約/成果/依頼、質問と回答、一時停止/取消、既存の活動履歴を合成する。設定4節は縦に表示し、適用/破棄のバーを一つにまとめた。
- 結果: 最新の同じauthority epoch/generationの報告を表示する。「元の会話に表示する」が無効なら通知outboxを抑止し、原本は残す。起動時のクラウド回収は設定保存までであり、未配備と画面に表示する。

変更対象は [implementation-files.json](implementation-files.json)。共有ファイルには他作業の変更も含まれるため、記載は変更所有権の独占を意味しない。実装コードに利用者の語句を分類する分岐や固定返答は加えていない。専用コードは外部契約、権限・版・保存・UI入出力に限定した。

## 検証結果

検証の最終結果とコマンドは [checks.json](checks.json) と同じディレクトリのログに記録する。件数には重複する試験があり、合計のユニーク件数として足さない。

| 検証 | 結果 |
| --- | --- |
| bundle dry-run | `issues: []`。製品DBを開かず一時DBで登録確認 |
| 対象の部分・結合試験 | 28件成功、0件失敗、139 assertions。会話の通常入口、確認質問、長い日本語依頼、元会話の所有者、同操作照合、古い版・過剰権限・未配備cloudの拒否を含む |
| 旧版/再seed、設定永続化 | 上記に含む。旧版hash、公開無効の維持、SQLite close/reopen、明示的な担当変更、通知抑止後の原本保持を確認 |
| DesignSystem | 型検査成功。新規2部品の試験2件成功。ビルド成功 |
| Web adapter | 選択変更前の遅い応答で表示が戻らない試験1件成功 |
| 関連domain回帰 | Bun 936件成功、0件失敗。Web 85件成功、既存のレイアウト上限と期待値の不一致2件失敗 |
| 広いdomain gate | boundaries・SystemContext成功後、既存の行数制限で停止。下記参照 |
| 全体型検査 | 直近はDoclingの試験7か所（3ファイル）のfetch型で失敗。今回のコードのエラーは報告されていない |
| 対象browser fixture | 登録版の移行後にも1件成功。仕事一覧・狭幅・結果切替・回答・取消・設定保存とreloadを通し確認 |
| 実ローカルAPI | 起動確認とartifact/設定の読取成功。実仕事やクラウドの受入ではない |
| lint・差分 | 今回の対象ファイルのlint、`git diff --check` 成功 |

画面証拠は [仕事](workspace-browser.png)、[約320pxの仕事一覧](workspace-narrow-browser.png)、[設定保存後](settings-browser.png)。実装したアプリと隔離した実backendを使うが、Sessionと報告は模擬データである。実dotsの送信、実Session・PC停止中の継続・実クラウド回収は今回行っていない。

### 全体検査の未解決事項

1. `bun run verify -- --domain dots --domain capabilities --domain tool-runtime --domain dialogue --domain tasks --domain task-reports --domain artifact` は `composition-fixer.ts` 827行、`contracts.ts` 859行、`ui-studio-components.tsx` 974行の行数制限で停止した。着手前のHEADもそれぞれ827・829・974行で制限超過。共有差分ではcontractsが30行増えており、今回の仕事の型・view・footer登録も含む。上限・baselineは緩めていない。既存の分割は別途必要。
2. `web/src/domains/artifact/test/nested-layout.test.tsx:71` は深さ4、`composition.test.tsx:112` の一例は子13個を拒否する期待値。HEADから実装は深さ6・より多い子数を許す。今回その制限を変更していない。テスト期待値を弱めず、担当外として記録する。
3. 全体型検査は `api/application/docling/docling-e2e.test.ts:20`、`docling-toolchain.test.ts:14`、`api/domains/docling/test/docling.test.ts:59,88,98,112,124` のfetch mockに必要な`preconnect`がないため失敗。別作業のファイルは修正していない。途中で観測したresourcesの型不整合は直近の検査では解消していた。

dots単独gateは一度pass（64件＋Web2件）したが、共有の開発サーバーとのビルド重複を除くための再実行は、他作業によるソース更新でinvalidatedになった。各項目は成功したが、最終版の標準gateを一括成功とは記録しない。初回のブラウザ再確認はfixture起動待ちで失敗したが、単独起動とAPI 200を確認後に通し試験が成功し、さらに登録版の移行後にも再成功した。広いgateの停止を隠して完了扱いにせず、対象画面試験は別に記録する。検証のために製品の秘密や設定をコピーせず、製品DBの直接操作もしていない。

## 残作業と停止位置

D0〜D2の実装・対象検証を終えた段階で、クラウド配備先・費用の判断前に報告する。D3で常設HTTPS/OAuth、受取箱と同期、秘密・署名鍵・バックアップ・消去、実クラウド作業先の権限を実装・配備する必要がある。D4では実Session、PC停止、起動後の同一結果の一度だけの採用、質問・停止・失効を受入する。

クラウド配備・課金・アカウント作成・DNS変更は行っていない。ローカルの通常起動状態を復元する過程で、保存済みの同じ登録版と内容が衝突し、bundle全体が見送られる事象を確認した。既存データを削除・上書きせず、新しい文書版へ移行した。現行は `toolchain:dots.delegate@3`、`binding:dots.delegate@2`、`artifact:dots.workspace@2`、`artifact:settings.dots@2`、UI schema群@2。受付担当@1と外部担当@3は維持する。旧文書群を持つDBでのupgrade/reseed試験も追加した。初稿の登録定義は `dots-delegation-v1.fixture.json` に固定しており、製品に再seedする文書ではない。

その後、許可済みのサーバー操作の範囲で通常の `bun run dev` を起動し、実ローカルAPIのstatus 200、2 artifactの登録と設定読取を確認した（[local-api.json](local-api.json)）。設定はrevision 0・受付無効・作業先未選択で、接続や依頼を勝手に有効化していない。Web/APIは起動状態へ戻している。実dotへの依頼は送っていない。

