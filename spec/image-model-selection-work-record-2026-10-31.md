# 画像生成のモデル選択（2026-10-31）

## 目的と範囲

利用者から提示されたLARM契約に合わせ、画像アーティファクトでQwen Turbo（既定）とFLUX 3 Image Klein（準備中）を選ぶ。会話でモデル指定のない画像依頼はmodelを省略し、LARMの既定を使う。既存の画像担当、キュー、catalogによるサービス発見と接続、Control認証、同期POST、結果取得、取消・結果採用、DesignSystemとOpenUIを再利用する。

作業順は入力契約・担当の新版登録 → 生成要求への接続 → 画面選択と失敗表示 → 部分・結合・domain検証 → 差分点検。完了条件は明示モデルが保存・送信され、未指定時model省略、steps省略、失敗時のモデル切替と生成POST再送がないこと。

ユーザーが指定した2つのモデル識別子は外部APIの選択値として新版の画面定義データだけに保持する。今回の明示依頼に基づく既存の固定モデル禁止規則への限定的な例外であり、製品コードにモデル名別分岐・補完・stepsの固定値は追加しない。自然文からの指定解釈は画像担当LLMが行う。

新しい実行方式、全ツールチェーンの移行、DB migration、認証変更、LARMの配備・重み配置は範囲外。既存の別作業差分を変更しない。開始時のブランチはlocal-review-intakeであり、mainへの切替や新規ブランチ作成は行わない。

## 検証計画と開始時の証拠

- ベースライン: image serviceとLARM image connectionの25試験が成功。
- 部分: 契約、新版登録と再seed、モデル送信・省略、成功応答の両形式、400/409/503・通信断時の一度だけのPOST、UI選択・リセット・準備中表示。
- 結合: フォームのモデル選択 → 既存のartifact submit → 画像担当 → LARM要求と保存記録。既定の会話経路も確認。
- 通し: image・larm・capabilities・影響する利用側domainを指定してverify（型、境界、build、試験）。
- ブラウザE2Eはfixtureサーバーの起動・停止が必要なため、サーバー操作の明示許可がない今回は実行しない。UIの描画と操作はサーバー不要の部品・OpenUI・Web試験で確認する。
- live生成はLARMのFLUX配備が未完了のため実行しない。固定試験と実生成を区別する。

## 部分検証（第1ラウンド）

モデル送信・省略、エラーと再送禁止、結果取得の25試験、image serviceの10試験、フォーム7試験は成功。新版登録はtoolchainの必須表示情報不足で失敗し、bundle全体が採用されないことを確認した。既存の未移行image backendではregistryがartifactメタデータを必須としているため、新toolchain revisionにも既存と同じImageWorkspace参照を保持する。adapter・実行方式を変更する全体移行は今回行わない。

残作業: 新版登録修正の再確認、結合・Web試験、domain検証、最終差分点検。


## 結合・画面確認と俯瞰評価

- 新版bundleのdry-runは2件とも成功。全Seedの初期化・再投入・再オープンの3試験、画像経路の結合12試験は成功。
- Webの3ファイル16試験、フォーム7試験、DesignSystem buildが成功。モデル選択・準備中表示・送信イベント・失敗表示を確認。
- 登録試験の不一致は旧revision期待とbundle host未設定という試験前提に絞った。旧builtin試験を維持し、旧revisionの不変性を確認する新版bundle試験を追加。登録・画面sourceの3試験も成功。
- 俯瞰評価の介入理由: 同じ目的の部分・結合確認が3ラウンドとなったため。モデル保持と要求値について残る仮説はなく、次は周辺domain検証へ進む。行数検査で既存の大きなLARM factoryの増加を検出したため、画像POSTと既知エラー処理を同domainの小さな関数へ切り出す。意味判断の移動や実行方式変更はない。

残作業: 切出し後の部分・結合試験、影響domainのverify、最終差分点検。サーバー操作・live生成は行っていない。


## 通し検証の第1回

verifyは境界検査で停止。追加したWeb試験がcapabilities内部のbundleファイルを直接importしていた。製品コードは境界を守っている。Web試験はOpenUIの公開入力で描画・選択を確認し、実際の画面定義の内容はapplication結合試験からcapabilitiesの公開読取り操作で確認する形へ修正する。同じ操作の再実行条件はこの境界違反の解消。


## 通し検証の第2回

境界・指示・行数・SQL・文書・書式・lint・DesignSystem型とbuildが成功。全体型検査で追加した試験の型不一致2件（TestInputのimport元、Receiptのmessage不足）を検出。いずれも試験コードを既存契約に合わせて修正。画面レビューで準備中説明がセレクトボックスと同じ横一列を圧迫し得るため、説明を次行へ折り返す表示を加える。次回はこれらの修正を含む固定入力でverifyを再実行する。


## 通し検証の第3回と俯瞰評価

静的検査・型・DesignSystem buildは成功。backendは1070成功・2失敗。失敗は旧LARM試験2件がcatalog service.modelの要求へのコピーを期待していたためで、今回の新契約に合わせ、一件はサービスと異なる明示model、一件は未指定modelの省略を検査する。寸法・seed・形式・動的URL・外部origin拒否の期待値は維持する。検証中に別作業のruntime-meta等が更新され、入力hash変更も検出されたためこの回の結果は全体成功には使わない。

介入理由は3ラウンドの通し確認。既存試験が旧契約を検出した根拠が増え、残る製品不具合は見つかっていない。テスト期待はユーザー提示の新契約へ置き換える。検証中の自分の編集はなく、他作業の差分は維持する。正常に進んでいる長時間処理を停止せず完了を待った。次は修正2件の部分確認後、入力を固定してdomain検証をやり直す。

追加確認: 最終フォーム7試験と画像結合16試験が成功。サーバーなしの静的ブラウザ表示で640px・390pxの両方を目視確認し、選択欄の幅は約477px・227pxで枠内に収まる。これはアプリのブラウザE2Eや実生成受入とは別。保存先はverification-reports/image-model-selection/form-{640,390}.png。


## 最終結果（実装済み・固定試験済み）

共有作業領域の第4回verifyは全検査とbackend 1,072件・Web 94件が通ったが、他作業の更新で入力hashが変わり無効になった。同じ条件で繰り返さず、基準コミット6f5b3999とその時点のソース差分を、ブランチを作らない検証専用のdetached worktreeへ固定した。製品DB・設定・秘密はコピーしていない。外部依存ライブラリだけを参照し、DesignSystemは検証用コピー内でbuildした。

- `bun run verify -- --domain image --domain larm --domain capabilities --domain dialogue --domain music --domain ui-compositions`: 成功。境界・指示・行数・SQL・文書・書式・lint・型・DesignSystem build・backend 1,072件・Web 94件がすべて成功。
- 成功run: `2026-10-31T03-30-41-760Z-d6ed3345-6fab-4ae0-b078-0aafc47c8d45`。検証前後の入力hashはともに `780b2aa422309adcc6dfead5a668057577760c88f3d56e03a6812224ab8e8d8b`。98,802 ms。結果は `verification-reports/image-model-selection/domain-verify-report.json` と `domain-verify.log` に保存。
- 同じ固定コピーで画像のapplication結合16件とフォーム7件が成功。固定試験は計1,189件。`integration.log` と `form-tests.log` に保存。
- 同じ固定コピーでWebの本番build（`bunx --no-install vite build`）が成功。`web-build.log` に保存。既存の大きいchunkとbackground importの警告は今回の範囲外として変更していない。
- 実装・試験・利用手順の対象31ファイルは、検証用コピーと元の作業領域のSHA-256がすべて一致。`verified-sources.json` に保存。この結果追記だけは検証後の記録であり比較対象から外す。

接続は会話関数`image` → `toolchain:image.create@3` → `package:image.create@2`（`profile:image.create@1`、`skill:image.create@2`、`tool:image.generate@2`、`imagePlanV2`）→既存image domainとLARM接続。画面は`artifact:image.generation@2`、`schema:image-screen-generate@2`、既存`adapter:image-screen@1`と`query:image-screen.list@1`。新しい実行adapterやbindingは増やさず、未移行backendの表示メタデータを保持した。旧revision・schemaの内容は保持し、登録・再seedと旧版不変性を試験した。

最終差分では、モデル名に応じた製品コード分岐、個別プロンプトの専用処理、別モデルへの自動切替、生成POSTの自動再送が増えていないことを確認。モデル識別子は明示依頼に対応する画面定義データと契約説明・固定試験だけに置いた。外部仕様に必要な専用部分はmodelの透過、既知エラーの抽出・表示で、起動停止・補完・stepsはLARMが所有する。別作業による会話履歴・runtime・文書の変更には手を加えていない。

未実施: 稼働サーバーの起動・停止・再起動、実アプリのブラウザE2E、実LLMによる受入、FLUX実生成。本番配備・重み・エンジン準備はLARM側の残作業。FLUXを準備中として表示し、未設定時には失敗を示す。今回のEumenes実装と固定検証の残作業はなし。

コンテキスト確認: initial_instructions 1回、context_compile 1回、compile_eval 1回。検証用コピーは結果保存後に削除する。


## 利用画面の不具合修正と実接続確認（12:38以降）

利用者から「準備中となって生成できない」「今作った画像のプロンプトを画像作成プロンプトに残したい」と再指摘を受けた。前回は実アプリ操作を確認しておらず、画像生成recordが後から届く場合のフォーム初期化を確認できていなかった。

### 原因と修正範囲

稼働画面では画像が完成しているのにtextareaが空で、生成buttonがdisabledだった。保存済みrecordには272文字のpromptがあることを認証済みAPIで確認。ImageCreationFormはuseState(initialValues.prompt)で初回値だけを保持し、その後のrecord取得・計画完了で届くpromptを反映していなかった。「準備中」の表示自体には生成禁止処理はない。

既存のrecord→OpenUI snapshot→ImageCreationFormという経路を維持し、未編集のpromptだけを後着のsource promptへ同期する。手入力・選択で作った文章・リセット・復元は保護し、生成送信後は次の結果を採用する。空のplanningデータで入力を消さず、モデルを先に選んでもpromptを受け取れる。LLMの意味判断・入力契約・外部API・モデル選択方式・保存方式は変更していない。

### 固定検証

- 修正前の追加試験で「後着promptが空のまま」「送信後に実生成promptを採用しない」の2失敗を再現。既存編集保護とリセットの8件は成功。
- 修正後のフォーム11件とWorkspace5件、Web17件が成功。空→後着→次の結果、手編集保護、明示リセット、計画中の保持、送信後の採用、先に選んだモデル保持、OpenUI経由のbutton有効化と送信を確認。
- `bun run verify -- --domain image` 成功。backend27件・Web17件と、境界・指示・行数・SQL・文書・書式・lint・型・DesignSystem buildを通過。成功run `2026-10-31T03-43-51-114Z-1dd6965c-93f7-4044-bd1e-0c0b380f582f`、26,618 ms。
- 結果は `verification-reports/image-prompt-repair/verify-report.json`、`verify.log`、`form-tests.log`、`web-tests.log`、修正前は`baseline.log`。

### 実画面・実生成

ユーザー自身がEumenesを再起動した。こちらではサーバーの起動・停止・再起動を行っていない。再起動後、実ブラウザで生成中の画像アーティファクトを開いたまま待ち、会話から生成した画像の完成と329文字promptの反映、次の生成buttonの有効化を確認。

さらにアーティファクトの生成buttonからQwenを指定して1回生成。run `fd07af77-d495-40b0-a741-c17428c7e501`、record `9e1d30ec-0045-4793-9a98-e630c28aa21e` はcompleted。artifact `image_31c13398ad1b4e11b9c9f649f153829c` を認証済みAPIで取得し、WebP 512×512、78,384 bytesをデコード確認した。生成に渡したpromptと実画面に残ったpromptはともに329文字、SHA-256 `d4aef349a0aefe7f70f265358b38e63e7a70d5511e68cdddbe8b92af21bb488b` で一致。証拠は`form-generation.json`と`qwen-completed.jpg`。

FLUX要求run `aae0ec36-7fbe-4ed3-abfa-d6418c5b835d` は `model=flux-3-image-klein` がrecordへ保持され、`larm_http_400` でfailed。失敗後も同じ329文字promptが入力欄に残り、編集・生成buttonが利用可能なことを実画面で確認。失敗した生成POSTを再送していない。証拠は`selected-model-failure.json`と`selected-model-result.jpg`。

### FLUXが失敗する原因と担当範囲

保存済み接続先のLARMに対してControl認証で`GET /openapi.json`を読み取り、配備中`POST /v1/images/generations`のrequest schemaが `model: {type:string,const:qwen-image-2.1-turbo}`、`steps: {type:number,const:8}` であることを確認した。公開descriptionもQwen専用・modelは広告serviceと一致する契約である。新しい2モデル契約が配備されていないため、FLUX指定は実生成以前に400で拒否される。catalogの説明もQwenだけを広告していた。`deployed-contract.json` に関連する公開schemaだけを保存。

LARMはこのPCにはなく、設定に保存された外部の接続先である。LARMへのソース変更・モデル配置・起動停止・配備は一切行っていない。利用者は対象を「Eumenes側の修正と原因報告まで」と明示したため、LARM側の対応はこの作業へ追加しない。LARM運用側で新契約を本番へ反映し、FLUXの実行環境を用意した後に成功確認が必要。Eumenesのmodelを変更したり、別モデルへ自動切替したりして回避しない。

結論: Eumenesのprompt保持は実装・固定試験・実画面・Qwen実生成まで確認済み。FLUX成功は外部LARMの配備が未対応のため未達であり、Eumenes側の残作業とは区別する。今回の追加context_compile/compile_evalは各1回、会話累計各2回。
