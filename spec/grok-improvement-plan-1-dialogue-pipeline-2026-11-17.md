# Grok向け実装計画 1　会話から仕事の完遂まで

2026-11-17。前回評価の基準コミットは `204280c675cc67809ddf1cd1ab623e4243d06a5e`。着手時のコミットと既存差分を確認し、再現結果をそちらに対応付ける。

この文書を3並列のうち計画1の作業指示として使う。目的は、自然な依頼の分割、担当選択、利用者の回答・取消、子作業と最終状態の確定を、一続きの検証で判断できるようにすること。まず、現行Routerの結合試験3件を復旧する。P1の固定試験と再現済みの修正から進め、liveの許可待ちでもP2の固定試験や評価データ準備を続ける。

## 作業境界

| 担当 | 書き込み範囲 |
| --- | --- |
| 計画1 | 下記のファイルと、この計画専用の検証記録・評価データ |
| [計画2　状態・復旧](grok-improvement-plan-2-state-recovery-2026-11-17.md) | 専門担当、Collaboration、Memory・World、旧調査の忘却、永続キュー、実行権限。会話の `specialist-*` と保存・採用側を所有 |
| [計画3　Web・音声・検証](grok-improvement-plan-3-web-voice-verification-2026-11-17.md) | Web表示、音声、生成物と検証基盤。共有の `scripts/domains.ts` と `docs/domains.md`、統合検証を所有 |

編集できる場所は以下。ディレクトリ指定は記載した項目に必要なファイルに限る。

```text
api/application/toolchain/router.fixture.ts
api/application/toolchain/toolchain.fixture.ts
api/application/toolchain/toolchain-harness-options.fixture.ts
api/application/toolchain/toolchain-resources.fixture.ts
api/application/toolchain/task-execution.test.ts
api/application/pipelines/**
api/domains/pipelines/**
api/domains/dialogue/service/routed-*.ts
api/domains/dialogue/service/router-host-action.ts
api/domains/dialogue/contexts/local/router-*.context.toml
api/domains/dialogue/test/routed-*.test.ts
api/domains/dialogue/test/generation.fixture.ts
api/domains/agent-runtime/service/execution-*.ts
api/domains/agent-runtime/test/pipeline-execution.test.ts
api/domains/inference/service/router-selection.ts
api/domains/inference/test/router-selection.test.ts
api/application/web-note/**
api/domains/web-note/**
docs/toolchain.md
spec/verification/grok-plan-1-dialogue-pipeline-2026-11-17.md
```

`routed-turn.ts` などと進行中のContextWindow閲覧の作業が重なる場合は、先にfixture・評価データを進める。同じファイルを別の作業者が編集中なら、その差分の取り込み後に一人が編集する。`toolchain.fixture.ts` は計画2・3の試験でも使用する。既存のオプションと呼び出し方を維持し、計画2・3はこの共通fixtureを読み取り専用として扱う。新規の結合試験登録が必要なら、ファイルと対象domainを結果に記載し、計画3でまとめる。対象の結合試験ファイルは登録済み。

[作業規則](../AGENTS.md)と[固定コピーの手順](../docs/verification.md#並行作業中の固定コピー)に従う。3担当で同じ基準コミットを共有し、試験用DB・依存・DesignSystemの出力は作業コピーごとに持つ。作業先と反映方法は利用者の指定に従う。サーバー操作、live接続、外部担当の起動は既存の許可の範囲で行う。製品DB・鍵・設定は検証コピーへ持ち込まない。別チャットへの送信は利用者の明示依頼に従う。

## 最初の作業　現行Routerと試験をつなぐ

1. [11月14日の選択方式と11月15日の失敗時契約](router-package-integration-2026-11-04.md#2026-11-14-選択方式への切替)を読み、`routeWithSelection`、`activeRouter`、`selectRouter`、`attachFixtureRouter` の実際の呼び出しを追う。旧Routerの `routeStructured` を前提にしない。
2. 固定コピーで `bun test ./api/application/pipelines/pipeline-execution.test.ts` を実行する。評価版では、二段の依頼で委任案内が空になり、回答・取消で構造判定呼び出しが0回だった。後者のケースは、元の親の完了・取消とTODOが一件のままであることまでは到達済み。現在版で既に通るケースは原因箇所を再確認し、新規修正を重ねない。
3. 試験用の `options.structure` を、現行 `selectRouter` が受ける構造判定へ接続する。固定応答の見分けにはRouterが渡すプロンプトの版・構造を使い、本文の語句やSystemContext全文一致に依存させない。構造判定の後に各工程の候補選択が必要なケースは、その工程の候補から選ぶ既存のfixtureを接続する。構造だけ差し替えたことで、後段が未設定の候補キャッシュを読む状態を残さない。固定応答未指定の既存fixture、`liveRouting`、既存本番ポートを維持する。
4. 元の3件を期待値ごと通した後、境界ケースを足す。構造の出力が不正なとき、異なる番号の候補を返したとき、期限・取消後に返したときは、hostが操作しないことを台帳と受け口の回数で検査する。

## 改善一覧

「修正」は現行の契約の範囲。「再現後修正」は試験や履歴から対象を絞り、再現した範囲で直す。「評価」「設計」は証拠や案の作成まで進める。優先順位や新しいfallback、権限、プロバイダーを変える案は合意後に実装する。

| ID・順 | 項目 | 実装または確認と合格条件 |
| --- | --- | --- |
| **1-01 P1 修正** | 結合fixtureの構造判定 | 上の手順で現行の構造・選択両ポートを接続。既存3件の期待値を保ち、構造判定回数と子操作が一致する。 |
| **1-02 P1 再現後修正** | 依存工程の取りこぼし（EUM001・004） | 既存の二段タイマーを通し、追加の題材では前段の確定値を後段に渡す。親は1、子は2、順序と入力値が一致。前段失敗なら依存先の操作は0。 |
| **1-03 P1 評価** | 独立した二依頼・同じ担当への二操作 | 「同時に頼む二種類」と「同じ担当で別々の二件」を分ける。意図が二件なら操作とreceiptも二件。同じ要求IDの再送では増えない。既存の複数作業契約に反するケースだけ修正候補にする。 |
| **1-04 P1 再現後修正** | 保留質問への回答の帰属（EUM002） | 元の質問・仕事・版を固定し、回答で同じ親・子が進むことを確認。別会話、期限切れ、回答済みの参照への回答操作により、新規作業や再開が起きない。自然文の意味判断は現行の構造化出力・欄埋めで行う。 |
| **1-05 P1 再現後修正** | 取消と遅い結果 | 質問待ち、子稼働中、取消前に終端が確定した場合を区別する。取消後に子が遅く返しても結果・通知が増えず、別の未完了作業には影響しない。 |
| **1-06 P1 評価** | 質問への回答と新依頼の混在 | 無関係な新依頼、曖昧な回答、複数の保留をケース化。既存契約に従った確認・着手・見送りを記録し、どの仕事へ作用したかを比較する。新しい優先規則は別途合意。 |
| **1-07 P1 再現後修正** | Routerの失敗時の副作用 | 一時停止・期限切れ・schema不一致・選択不可をスタブで返す。既存の会話・許可された読み取り経路へ届き、承認・取消・委任・新規調査の件数は0。元run自体の取消は会話への引継ぎも0。 |
| **1-08 P1 評価** | 保存設定と接続を外した場合 | 既存のクラウド許可・公式origin・未設定のケースを照合。モデルや接続を固定せず、保存設定なし・クラウド不可の振る舞いを現行の仕様と照合する。別プロバイダーへの自動切替は設計候補として扱う。 |
| **1-09 P1 評価** | 長い依頼と添付だけの依頼 | 現行の入力schemaと配布Routerの `STRUCTURE_LIMITS` を先に照合。受付上限の手前、末尾に条件がある場合、全角文字・改行、添付のみを試験。受付した条件の部分欠落を観測したら、範囲と採用結果を記録する。上限の調整や長文専用経路は設計合意後。 |
| **1-10 P1 再現後修正** | 実行計画と元依頼の一致 | 既存の計画照合・子の入力schema・依存参照・定義の固定版を使う。一部が実行不可、参照が失効、schema外の出力、子失敗の場合、未実行分が確定扱いにならないことを確認。親の終端だけで採点せず、効果の受領まで検査する。 |
| **1-11 P1 評価** | 合成の通し試験の検出力（EUM005・006） | `selection.json` と試験出力を照合して、3件が標準domain検証へ入ることを確認。構造と選択・実行を別々に失敗させるfixtureで、後段だけの合格を防げるか確かめる。対象ケースではTODO一件と既存の完了通知一件を照合する。EUM003の追加報告は撤回済み。 |
| **1-12 P1 評価** | 実モデルの反復評価（EUM006） | 既知の失敗と言い換え、未調整の題材を先に凍結。各条件を複数回実行し、判定、子操作、親・子状態、誤操作、不要な確認、未実施、所要時間を別計数。担当・設定の変更前後を同条件で比較し、調整済み題材を未使用扱いしない。 |
| **1-13 P2 評価** | 調査の正しさと所要（EUM007–009） | 現行の会話内検索と `web.note` をそれぞれ測る。短い確認と調査メモを分け、対象日・発表版・数値・出典が一致するかを固定資料で照合。外部検索・モデル・保存の時間と、取得できる呼び出し数・費用を計上。不明な費用は不明とする。旧Web担当の約83秒は歴史値。 |
| **1-14 P2 再現後修正** | 調査の失敗・部分成果 | 取得できる資料と取得できない資料、期限切れ、保存結果不明を分ける。明示された未確認点と、有効な出典付き成果を既存の文書契約で扱い、同じ成果物を重複保存しない。現在の `web.note` の固定モデル方針と旧結果の読み取りを維持。 |
| **1-15 P2 評価** | 使う能力の受入を絞って広げる（EUM023・024） | 調査メモ・計算→タイマー・既存の添付OCRのうち対象を固定し、依頼から結果再読まで照合。OCRは正解の文字列・数値を先に固定し、原文と補正の差分を記録する。この計画でOCR本体や成果物UIを編集する必要が出たら、原因と変更候補を報告する。 |
| **1-16 P2 設計** | 自発行動と自己改善の採否（EUM018・019） | 「役に立った」「不要な割込み」「見逃し」の観測基準を決め、現行の通知・試験運用の記録で採否を比較する。利用者の明示目標や発案根拠を照合し、既存の予算・確認・停止を使う。自動起票や自動採用、既定値切替は設計合意の対象。 |
| **1-17 P2 修正** | 結合fixtureと実行処理の保守負担 | `toolchain.fixture.ts` と `execution-commands.ts` の既存サイズ指摘を再確認。Router組み立てのように既存の責務が分離できる箇所から抽出する。各利用側の挙動・import先の公開契約を保ち、集約だけのための汎用層は増やさない。 |
| **1-18 P2 評価** | 本人の反復業務での便益（EUM030） | 前の調査を更新する仕事と、順序付きの依頼のうち1〜2件を同じ条件で比べる。完遂、再説明、確認・手直し、待ち時間、本人が止めた回を記録。現行の手作業や利用中の代替手段と比較し、デモ一回で成果を確定しない。 |

参照先は[全体課題](project-issues-2026-11-06.md)、[Pipeline契約](pipeline-0.1.0-hardening-2026-11-06.md)、[調査メモの実装・検証](verification/research-note-levels-2026-11-15/README.md)。実モデルの6件は当時の判定の証拠で、今回の通しの合否は親と子の台帳・副作用で確認する。

## 検証と引渡し

部分 → 結合 → 対象domainの順で実行する。まず固定の認証・推論・操作を使い、接続先の準備なしでも確かめられる部分を終える。

```sh
bun test ./api/domains/dialogue/test/routed-package.test.ts ./api/domains/dialogue/test/routed-router-turns.test.ts ./api/domains/dialogue/test/routed-work-integration.test.ts
bun test ./api/domains/agent-runtime/test/pipeline-execution.test.ts ./api/application/pipelines/pipeline-execution.test.ts ./api/application/pipelines/workflow-authoring.test.ts
bun run verify -- --domain pipelines
bun run verify -- --domain dialogue --domain pipelines --domain agent-runtime
```

`router-selection` または調査担当を編集した場合は、対応する `inference`、`web-note` と実際に影響を受けた利用側domainも選ぶ。標準検証の対象に待受の起動を伴う試験がある場合は、許可を確認した段階で実行する。それまでは許可範囲の試験ファイルを明示し、未実施の工程を記録する。

liveの通常会話は[CLI対話モード](../docs/cli-chat.md#aiによる再現デバッグ)の検証用会話IDを使う。最初に `bun run logs -- --level warn` を使い、対象の `runId`、親・子・受領のIDで絞る。ログや検証記録に会話本文、認証情報、設定値、Providerの生応答を載せない。複数の言い方に対応する改善は既存のLLM指示・候補・出力契約で検証する。

完了報告には、各IDの変更ファイル、基準コミットと入力hash、失敗→成功の証拠、子操作と終端の件数、未実施のlive・設計項目、計画3へ渡す試験登録の候補を記す。自分の差分に他担当のファイルや例文専用の製品分岐が入っていないか最後に点検する。
