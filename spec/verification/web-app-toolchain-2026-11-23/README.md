# 会話から使えるWebアプリ：実装と検証記録

対象は [改善計画](../../.todo/web-app-toolchain-improvement-plan-2026-11-23.md) の W01〜W07。2026-11-23の実装開始依頼に基づく。main の未コミット差分で実装しており、同じ作業領域には別作業の変更もある。製品DBを複製せず、部分・結合・実モデルの制作試験は一時storeを使う。

## 実装済み

| 範囲 | 変更 |
| --- | --- |
| W01 | 公開transactionで旧予約と旧実行を取り消す。実行許可と予約発火は現行workflow版に限定し、復旧時に旧版予約を解除する |
| W02 | 汎用 `web.records@2` に行のJSON Pointerと取得範囲参照の対応を要求する。URL・根拠欄は取得結果からホストが設定し、未発行参照・根拠なし行を拒否する。比較元不足・切詰め・根拠を持たない空結果は部分結果とする |
| W03 | 必須入力、フォーム型、選択肢、固定値との重複を保存前に照合する。実行入力の型違反はdomainの拒否結果にする。Webフォームは数値・真偽・複数選択を型付きで送る |
| W04 | 原依頼を保持し、現在の依頼と本人のmessage/digest・UI操作の根拠を作業版と公開版へ保存する。本人が後から指定したURLを採用でき、失効した本人の参照はURL指定の根拠にしない |
| W05 | 元の確認済み保存票・状態版・digestを照合する保存再試行操作とボタンを追加する。物理保存のjobは元の保存票へ結び付ける |
| W06〜W07 | 既存のconversationHandoffを有効にし、制作skillに条件の保持、有限schema、根拠契約、検査結果からの修正、確認可能な案での停止を記載する。表示データの条件・時刻・取得元を画面へ渡す |

最初の追加登録は `toolchain:app.develop@12`、`package:app-development.studio@9`、`binding:app-development.studio@11`、`profile:app-development.studio@3`、`skill:app-development.studio@7`、`artifact:app-development.studio@3`、`app-development-retry-save@1`。実モデルで制作応答の形式違反と出力上限到達を観測し、操作全体を示す例を先に置いた `skill:app-development.studio@8` と、それを使う package@10・binding@12・toolchain@13 を追加した。本文は5,681字から4,320字へ短縮した。既存revisionの本文は変更していない。migration `app-development/0004-request-context` が依頼メタデータと保存票の状態版を追加する。

## 確認した結果

| 検証 | 結果 |
| --- | --- |
| app-development、ui-compositions、pipelines の所有試験とapplication結合試験（最終差分） | 116成功・4 live skip・失敗なし。16ファイル、3,541 assertions、38.33秒 |
| Scheduler、専門担当の会話接続、agent-runtimeのcontext | 41成功・1 live skip・失敗なし。3ファイル、672 assertions |
| Web adapter（Vitest） | 20成功・失敗なし。保存再試行票と表示データの条件・出典を保持する試験を追加 |
| 専門担当のprompt・作業文書・記憶の参照 | 18成功・失敗なし |
| ui-studio のソース編集・保存再試行・フォーム値変換とデータ表示部品 | 29成功・失敗なし |
| `bun check --all`（最終差分） | 3,569ファイル・型エラーなし |
| 対象コードのoxlintと `git diff --check` | 成功 |
| `toolchain:bundle -- check` | 登録可能。既存revisionとの内容衝突なし |
| 再起動後の製品backendの読み取り専用API | Artifact一覧に `artifact:app-development.studio@3` を確認。こちらからサーバー操作はしていない |

最終116件には、起動時の旧予約解除、公開transactionの巻き戻し、本人が指定していないURLの拒否、同じhostの別ページの出典と同じページの重複参照の区別、根拠欄の名前を保存前に実行契約へ合わせる検査を含む。部分試験で直した後、依存する制作・保存・実行の結合試験を再確認した。

結合試験と型検査の途中で、別作業によるCanvasパッケージの更新中にimportが失敗した。依存が解決した後、上記を再確認した。この停止を今回の実装の合格として数えない。

その後の型検査では、並行作業中の目標管理の4ファイルで9件の型エラーが発生したが、最終再確認時には解消し、全体の型検査が成功した。対象45ファイルのhashは [inputs.json](inputs.json) に保存した。これは全作業領域の固定を示すものではない。

標準 `verify --domain ...` は初回に対象ファイルのformat違反で停止した。整形は修正済み。標準検証の選択にはHTTP fixtureサーバーを起動する試験が含まれるため、サーバー操作の明示許可が得られるまでは再実行しない。上の個別試験成功を標準verify全体の成功へ読み替えない。

## 実モデルと画面の受入

`api/application/app-development/app-creation.live.test.ts` に記録・日付別一覧・日次日誌の3件×3回を用意した。会話・担当選択・制作・実行のモデルは保存済みLARM設定を使用し、取得資料・Git・保存先はfixture。宛先を固定せず、利用者役が内部JSONを教える修正も行わない。最初の失敗で停止する。

最初の実行は、記録アプリ1回目がテスト側の180秒待機内に終わらず停止した。会話runは `b32790a6-3af5-41ea-ac17-3ebabecaa8bc`、制作jobは `647cfc76-f691-48d6-a2a0-897099ab9d50`。確認保存・初回利用には未到達。成功数は0。製品側の制作期限は20分のため、診断用再実行ではその期限まで待機し、本文を残さない段階ログを追加した。180秒時点の不合格記録は保持する。

再実行では記録アプリ1回目が453,030msで制作・確認保存・記録追加・編集まで成功した。会話runは `b6b3d240-8d7f-420d-a13d-6699e7a28a2f`。親の担当検索・委任のモデル応答は約12秒、制作担当の2回のモデル応答は約212秒と222秒で、モデル報告のdecode時間は約198秒と220秒。機能成功と待ち時間の課題を分ける。残りの実行結果は追記する。

この回の記録アプリ2回目は295,888msで失敗し、そこで停止した。runは `6854ea33-e86a-45f7-ac19-536b87030f12`。`finishReason=length`、`streamFailure=output_limit`、有効上限16,144 tokensを観測した。上限は増やしていない。3件目以降の7件は未実行。

skill@8では記録アプリ1回目が108,925msで成功し、「感想欄を先にする」という自然文でのアプリ改訂・保存済み記録の保持まで確認した。新規制作runは `e2663588-cf53-4f30-bb66-7c2ab2acb927`、改訂runは `f7e3b533-2fea-49fa-b624-8c3db38ee722`。2回目は18,284msで下書き未到達。run `7904fd99-ea0f-475a-a894-56bc195d2277` は候補検索後の通常回答で終了し、そこで受入を停止した。利用者文面を変えて成功扱いにはしていない。

ここまでの実モデル試験は、ハーネスの会話portが `testConversationAgent`（会話SystemContextなし）であった。会話・制作とも実モデルではあるが、製品の会話SystemContextを含む受入ではない。これは検証構成の不備として区別し、上記の成功・失敗を診断記録に保持する。実際の会話指示は製品の `agencyReplyParts` を使って再確認する。共通の会話指示や担当選択コードへ、題材別の分岐は追加しない。

候補診断を追加した旧ハーネスの実行は記録アプリ1回目（改訂まで）が143,468msで成功した後、2回目の制作中に中止した。理由は会話SystemContext欠落の修正。検証プロセスはHTTPサーバーを起動しておらず、そのクライアントだけを停止した。所有するLARM接続の解放と一時store削除を確認した。

製品の通常会話（背景の自律作業なし）の `agencyReplyParts` と同じ応答loopを使う修正版では、記録アプリ1回目が120,911msで作成・確認保存・記録追加・編集・自然文によるフォーム順の改訂まで成功した。2回目も75,228msで保存・初回利用まで成功した。3回目は295,521msで失敗し停止した。選択候補の先頭は `app.develop@13` で、制作担当への委任も成立している。失敗run `dc695ac2-ac91-46b9-aa30-dc6f59986ac8` は制作モデルの `finishReason=length`、`streamFailure=output_limit`、上限16,144 tokens、reasoning 67,727文字を記録した。残る一覧3回・日誌3回の6件は未実行。**必須9件の受入は不合格**。成功2件だけを完成の証拠にはしない。

集計は [live-production-acceptance.json](live-production-acceptance.json)。利用者文面のhashに加えて、bundleとハーネスのhashを記録した。失敗時の候補ID・run状態は診断JSON、隔離fixtureの採用済み回答は別の評価Markdownへ保存し、運用ログやProviderの生応答とは分けた。

`tests/browser/app-development.spec.ts` に会話→下書き→初期保存失敗→障害除去→再試行→記録追加・編集→再表示→狭い画面を用意した。消音ブラウザーを使う。構文確認（`--list`）のみ成功し、操作試験は未実行。利用者から製品サーバー再起動の連絡を受けたが、一時fixtureサーバーの起動・終了許可とは扱っていない。

必須範囲の完了宣言は、実モデル9回、複数ターンの変更、画面での更新・予約停止・キーボード操作を含む受入を終えてから行う。現時点は実装済み・fixture回帰検証済みであり、通し受入完了ではない。

残作業は、制作モデルが長い思考で上限に達する問題の切り分け、実モデル9件の再受入、標準verify、隔離した画面での更新・旧予約停止・キーボード操作を含むブラウザー受入。次の調査では実際の出力schema適用と保存済み思考設定の反映を先に確認する。生成上限の引上げ、別モデルへの自動切替、利用者文面ごとの分岐による合格化は導入していない。

### 利用者が試験環境を起動する場合

製品サーバーの再起動は不要。別ターミナルで次の2つを起動する。一時DBはfixtureが作り、終了時に削除する。下のtokenはfixture専用の固定値であり、製品のcredentialを使わない。

```sh
EUMENES_PORT=48877 EUMENES_ORIGIN=http://127.0.0.1:45173 bun scripts/app-development-fixture-server.ts
```

```sh
EUMENES_PROXY_URL=http://127.0.0.1:48877 EUMENES_ORIGIN=http://127.0.0.1:45173 EUMENES_API_TOKEN=fixture-token-for-toolchain-browser EUMENES_VITE_CACHE_DIR=/tmp/eumenes-app-manual-vite bun run dev:web --port 45173
```

起動後は下の指定でブラウザー試験を実行できる。この指定では試験runnerはサーバーを起動・停止しない。終了は起動した各ターミナルのCtrl+Cで行う。

```sh
EUMENES_APP_FIXTURE_ORIGIN=http://127.0.0.1:45173 EUMENES_APP_FIXTURE_API=http://127.0.0.1:48877 bun x --no-install playwright test tests/browser/app-development.spec.ts
```

## 再レビュー後の実装 W11〜W16

利用者の実装開始依頼に基づき、計画書§10を実装前に追記した。W12〜W16の5件を修正した。

- 保存失敗から「下書きに戻す」を追加。失敗が確定した票とdigest・状態版・jobを照合し、失効したpreviewの成功は要求しない。初回の未公開領域は除去し、改訂では保存済み記録を保持する。物理版が進んだ場合はその版と準備済みスキーマを保持し、次回も非破壊更新を強制する。
- 別アプリを表示しているときに現在の作業の再試行を表示しない。UI起点のtargetRefもhostから操作へ渡し、Aを表示した操作でBの保存を再試行・復帰できないようにした。
- 依頼メタデータのない旧保存版は、原依頼・会話IDに一致する有効な本人の発言を解決する。別会話、assistant、撤回済み・忘却済みの発言は根拠にしない。原文と一致する有効な発言が見つからない場合に、保存文字列から根拠を作らない。
- 平文・Markdown・JSONのURLで、対応した閉じ括弧を保持する。
- 複数選択の選択肢を配列の要素型で照合し、実行時のminItems・maxItemsは維持する。

保存復帰の新queryとArtifactは@2・@4。migrationは0005。旧queryに未登録操作のボタンを出さない。復帰受付後、現在の作業と対象が一致する場合はその下書きへ表示を戻す。古い票の再送、jobが実行中の場合の拒否、未公開ファイルを除去した後の中断・再起動、物理初期化後の公開失敗、改訂後の既存記録保持を試験した。

### W11の送信契約と実モデル

通常の専門担当の操作は開いた引数を持つ共同制作契約であり、JSON-object形式で送ってホストが検査する。guidance候補の選択時のstrictな返信形式とは別契約。固定試験で、通常制作のシステムに操作schemaがあり、思考レベルlowと実効上限16,144 tokensがLARMへ届くことを確認した。model/profile名の固定、モデル分岐、上限変更、動的フォールバックは追加していない。

初稿を先に検査へ渡すよう調整したskill@9・package@11・binding@13・toolchain@14で、凍結済みの利用者文面を使って再試験した。**最初の記録アプリが失敗し停止。0成功・1失敗・8未実行。** run `23e8ff7e-3315-451f-95ed-eda262105e58`、制作job `20db5cdd-da0f-426e-9423-344baa77c413`。294,207msで初稿未到達。`chat_stream_incomplete / finishReason:length / streamFailure:output_limit`、上限・消費とも16,144 tokens、reasoning 42,201文字を記録した。利用者文面のhashは前回と同じ。集計とbundle/harnessのhashは [live-rereview-acceptance.json](live-rereview-acceptance.json)。

今回の指示だけの調整では改善を観測できなかったため、同じ調整を再試行していない。履歴は保持し、既存skill@8を使うpackage@12・binding@14・toolchain@15を追加した。保存復帰のArtifact@4は保持する。旧revisionは不変。**生成安定化は未解決であり、必須範囲全体の完成は宣言しない。** 次の調査対象はサービス側の思考制御の契約。新しい生成方式を採用する場合は先に設計する。

### 最終差分の検証

| 対象 | 結果 |
| --- | --- |
| `bun run verify -- --domain app-development` | 成功。33成功・3 live skip・9ファイル・1,983 assertions。59.406秒。結果ID `2026-11-23T14-44-29-201Z-70968456-a049-48e9-b7ef-85f2b5d0f3dd` |
| app-development・pipelines・ui-compositionsの所有／application結合 | 117成功・4 live skip・失敗なし・16ファイル・3,636 assertions。37.62秒 |
| tool-runtime action requests・専門担当の会話／文書／prompt／記憶・agent-runtime context・LARM送信契約 | 99成功・失敗なし・8ファイル・880 assertions。28.70秒 |
| Schedulerの利用側回帰 | 5成功・1 live skip・失敗なし・119 assertions |
| Artifact UIのソース操作・復旧・フォーム値変換 | 13成功・失敗なし・2ファイル・57 assertions |
| Web adapter（Vitest） | 21成功・失敗なし。復帰対象の下書きへ戻す場合と、別作業へ切り替えない場合を含む |
| 型・サイズ・境界・SQL・固定名 | `bun check --all` 3,579ファイル成功。選択範囲のguard成功。サイズ23ファイル成功 |
| bundle | 登録可能。HEADに存在する全revisionと、再レビュー前Artifact@3が不変であることを比較確認 |
| 起動済み製品backend | 読み取り専用の`/api/status`成功、Artifact一覧に@4の反映を確認。サーバー操作なし |
| ブラウザー | 新しい復帰経路を試験に追加し、`--list`成功。操作試験は未実行 |

標準verifyの対象外に、別作業のformat・lint・SystemContext生成物の警告が3件ある。対象外の変更は修正していない。全リポジトリの検証成功とは扱わない。

サーバーを起動しないapp-development単独の標準verifyは試験ファイル一覧を確認して実行した。HTTP fixtureの起動を含む他domainの標準verify全体と、専用backend・Viteを使うブラウザー試験は未実行。利用者の「再起動済み」の連絡に対して接続を確認し、製品backendの@4反映を確認した。試験専用サーバーの起動・終了許可へ読み替えず、製品DBへ試験データも書いていない。

ブラウザー試験には、初期保存失敗→障害除去→保存再試行→物理初期化後の公開失敗→下書き復帰→新たな確認保存→記録追加・編集・再表示を用意した。既存の消音設定、試験専用環境であることの確認、利用者が起動したfixture環境に接続する指定を維持する。

途中の試行でWeb用VitestをBunのUI試験と同じプロセスで実行し、DOM環境の不一致で失敗した。正しい各runnerに分けて上の結果を確認した。標準検証の期待値は変更していない。入力hashは [inputs-rereview.json](inputs-rereview.json)。実モデルの指示調整時点の入力は [inputs-rereview-trial.json](inputs-rereview-trial.json) に分ける。
