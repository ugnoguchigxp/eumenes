# 計算ツールチェーン（即時計算・LARM計算サービス） 設計

作成日: 2026-10-20

状態: 案・合意待ち（§12）。LARM側の計算サービスは未構築で、§4 は LARM への依頼仕様の案。

関連: [登録と拡張の手順](../docs/toolchain-extension.md)、[サブエージェントの二つの型](subagent-task-and-session-agents-design-2026-10-18.md)（P3 共有ツール・非同期）、[インスタント3Dモデル](instant-3d-model-toolchain-design-2026-10-18.md)（LARM のジョブ型APIの先例）、[LARM](../docs/larm.md)。

## 1 目的と完了条件

会話の担当（将来は他の専門担当も）が、普通の計算から関数計算・統計・機械学習まで気軽に頼めるようにする。重い計算は LARM 上の計算サービスに API で投げ、時間のかかる計算も受付・進捗・取消・完了通知で扱う。

| 依頼 | 完了条件 |
| --- | --- |
| 「1234×5678は？」「5マイルは何キロ？」「3x3行列の逆行列」 | R1 の関数呼出しだけで、Eumenes 内で計算した決まった形の文が返る（数百ms） |
| 「sin(x)/x を0から∞まで積分して」「この連立方程式を解いて」 | 計算担当が Python（SymPy・SciPy）のコードを書いて LARM で実行し、結果を短く答える |
| 「この数列に回帰を当てて、グラフも見せて」 | scikit-learn・statsmodels で計算し、係数・指標を答え、グラフ（PNG）を画面に出す |
| 「小さなMLPを1000エポック学習させて精度を見て」 | PyTorch（LARM の GPU）で実行する。数分以上かかる場合は受付を答え、進捗を画面に出し、完了を会話へ通知する |
| 「計算をやめて」 | 進行中のジョブを取り消す。取消後に届いた結果は採用しない |

## 2 結論：2段構成

| 段 | 関数（案） | 型 | 実行場所 | 用途 |
| --- | --- | --- | --- | --- |
| A 即時計算 | `calculate` | 即時回答（`execution:"instant"`） | Eumenes backend 内（mathjs） | 四則・関数値・単位換算・行列・簡単な統計。R2・一時回答・サブエージェントなし |
| B 計算担当 | `compute_python` | 単発型（`execution:"command"`、担当が Python を書く） | LARM 計算サービス（ジョブ） | 記号計算・数値解析・統計・機械学習・グラフ |

A で計算できない（式が解析できない、記号計算が要る、上限超過）ときは、`fallbackToolchainId` で同じ run のまま B へ元の発言を渡す。

将来の段（本書では契約だけ決め、実装は別段階）:

- C 共有ツール: UI自由制作・Web調査などの協働型から `agent.sharedTools` で `compute_python` を `async: true` の共有ツールとして使う。サブエージェント設計の P3 に依存する。
- D 計算ノート（協働型）: 作業文書をノートブック（セル列）にして、何往復も計算を詰める。需要を見て判断する。

## 3 全体構成

```
会話 R1 ─┬→ calculate（instant）→ adapter:compute@1.instant.run → mathjs（隔離した評価器）→ 決まった文
         │                         └ 失敗 → fallback: compute_python
         └→ compute_python（toolchain）→ command 担当（profile＋SKILL＋tools）
              → binding:compute.command → adapter:compute@1 → compute domain の公開 transaction 操作
              → キュー job（compute.submit / compute.poll / compute.cancel / compute.fetch）
              → larm domain の計算クライアント（Control origin＋Bearer）→ LARM 計算サービス
画面: artifact:compute.workspace@1 ← Web adapter ← /api/compute/*（backend 経由で LARM の成果物）
```

| 単位 | 置き場所 |
| --- | --- |
| 即時計算の評価器（mathjs を隔離設定で包む） | `api/domains/compute/service/expression.ts` |
| LARM 計算クライアント（HTTP と応答の zod 契約） | `api/domains/larm/contracts/compute.ts`、`api/domains/larm/service/compute-client.ts` |
| compute domain（ジョブ台帳・成果物・キュー handler・HTTP API） | `api/domains/compute/`（新設。larm は application で port として注入し、domain 同士で直接参照しない） |
| DomainAdapter | `api/application/compute/compute-adapter.ts` |
| bundle | `api/domains/capabilities/bundles/compute.bundle.json` |
| 入力 schema | `api/domains/capabilities/contracts/compute.ts`（新しい builtin キー `computeExpression`・`computeJob` 等） |
| 画面部品・OpenUI view | `packages/design-system/src/components/ComputeWorkspace/`、`packages/artifact-ui` の `compute-workspace` |
| Web adapter | `web/src/domains/compute/toolchain-adapter.tsx` |

## 4 LARM 計算サービス（LARM への依頼仕様の案）

Eumenes は計算エンジンの種類・ライブラリの導入方法・GPU の割当てに依存しない。以下は Eumenes が前提にする契約で、LARM 側で建てる。

### 4.1 発見

- 保存済み Control 接続先の catalog（`GET /v3/agent-profiles` のルート `services`）から、capability `compute.python.execute`・protocol `larm.compute.v1` のサービスを探す。名前では探さない。複数あれば catalog の順で最初。
- `url` は Control origin を含む絶対URL。origin が保存済み接続先と違えば使わない。認証は Control の Bearer だけ（Provider の claim・agent-connections は不要。3D と同じ）。
- `description` に利用条件（GPU の有無など）を書いてもらい、担当に渡す。

### 4.2 API

| 操作 | API | 内容 |
| --- | --- | --- |
| 環境 | `GET {url}/environment` | `{python, packages:[{name, version}], accelerators:[{kind:"cuda"\|"mps"\|"cpu", name, memoryMiB}], limits:{maxTimeoutSec, maxCodeBytes, maxInputBytes, maxOutputBytes, maxArtifacts, maxArtifactBytes}}` |
| 投入 | `POST {url}/jobs`（`Idempotency-Key` 必須） | 本文 `{code, inputs?: {<名前>: JSON値}, timeoutSec, accelerator: "auto"\|"cpu"\|"gpu"}` → 202 `{jobId}`。同じキー・同じ本文は同じ job、違う本文は 409 |
| 状態 | `GET {url}/jobs/:jobId` | `{status:"queued"\|"running"\|"completed"\|"failed"\|"cancelled", stage, queuedAt, startedAt, finishedAt, progress?:{message, ratio?}, result?, error?}` |
| 成果物 | `GET {url}/jobs/:jobId/artifacts/:artifactId` | PNG・SVG・CSV・JSON（`result.artifacts[]` の `{id, name, mime, bytes}`） |
| 取消 | `DELETE {url}/jobs/:jobId` | 進行中なら停止。完了済みなら結果を削除 |

- `result` は `{value, stdout, stderr, stdoutTruncated, stderrTruncated, artifacts}`。`value` はコード内の変数 `result` を JSON 化したもの（numpy・pandas・torch の値は LARM 側で list・数値へ変換する。変換できなければ文字列表現）。グラフは matplotlib の図を保存した PNG を成果物として返す。
- `progress` はコードから呼べる関数（例 `report(message, ratio)`）で更新できると、学習の進捗が見える。無ければ stage だけでよい。
- `error.code` は `timeout`・`memory_exceeded`・`runtime_error`・`syntax_error`・`limit_exceeded`・`unavailable` 等の `/^[a-z_]+$/`。`runtime_error` は traceback の末尾（上限付き）を `error.message` に入れる。
- 進捗の取得は 3D と同じく、保存した Control origin に既知の path を組み立てて行い、応答中の URL は追わない。

### 4.3 LARM 側に求める隔離（Eumenes からは検証しない前提条件）

LLM が書いたコードは信頼できない入力として扱う。想定する危険は、事故（無限ループ・メモリやディスクの枯渇・巨大な出力）、GPU の占有による LLM・音声の停止、プロンプトインジェクションによる外部送信、LARM のモデル・設定・認証情報への波及。単一利用者の家庭用なので VM までは使わず、ジョブごとに使い捨てる強化したコンテナで隔離する。

LARM の機材（利用者確認、2026-10-20）: AMD Ryzen AI Max+ 395（GPU は gfx1151、CPU と GPU が同じメモリを使う統合メモリ）、Ubuntu。GPU 計算は ROCm（gfx1151 は ROCm 7.2.1 の対応表に載っている）。

**実行環境**

- ジョブごとに新しいコンテナを作り、終わったら消す。rootless の Docker か Podman。
- `--network none`、`--read-only`（書けるのは容量上限付きの tmpfs の作業領域だけ。例 1 GiB）、`--cap-drop ALL`、`--security-opt no-new-privileges`、root 以外の利用者、`--pids-limit`、`--ipc private`。privileged と seccomp の解除は使わない（ROCm の文書でも `seccomp=unconfined` は任意扱い。既定の seccomp で動くかを実機で確かめる）。
- ホストのディレクトリはマウントしない。LARM のモデル置き場・設定・認証情報・他のサービスの socket は見えない。
- GPU の device（`/dev/kfd` と対象の `/dev/dri/renderD*` だけ、`video`・`render` group）は `accelerator` が `gpu`／`auto` で GPU を割り当てたジョブだけに渡す。CPU のジョブには渡さない。
- 実行イメージは digest で固定する。ライブラリは固定イメージに入れる（実行中の `pip install` は不可）。最低限 numpy・scipy・sympy・pandas・matplotlib・scikit-learn・statsmodels・PyTorch（ROCm 版）。版は `environment` で返す。
- 結果の保持期限（例 24時間）。Eumenes は完了後に取得して自分で保存し、LARM 側の結果を削除する（画像と同じ扱い）。

**上限**

| 対象 | 方法 | 例 |
| --- | --- | --- |
| 実行時間 | 監督プロセスが時間超過でコンテナを kill（`timeout`） | 既定 60秒、最大 3600秒 |
| CPU | `--cpus` | 8（16コアのうち半分。LARM の他の処理に残す） |
| メモリ（CPU 側） | `--memory`・`--memory-swap` を同値 | 16 GiB（`memory_exceeded`） |
| GPU メモリ | 統合メモリのため、GPU の確保（VRAM・GTT）は `--memory` で数えられない可能性が高い（要実機確認）。起動時に PyTorch の `set_per_process_memory_fraction` を設定し（弱い制限）、監督プロセスが `amd-smi` 等で使用量を見て超過したら kill する（強い制限） | 24 GiB |
| 出力 | stdout・stderr・成果物の大きさと件数 | stdout 256 KiB、成果物 10件・各 5 MiB |
| 投入 | コード・入力の大きさ | コード 64 KiB、入力 256 KiB |

**GPU の調停**

- LLM・TTS・ASR と同じ GPU とメモリ帯域を使うため、計算ジョブはリアルタイムの推論より優先度を下げる。GPU のジョブは同時に 1件。
- GPU が空くまでは 3D と同じく `waiting_gpu` の stage で待たせる。待ち時間は実行時間に数えない。
- 会話の推論が始まったときに GPU の計算を一時停止・中断するかは LARM 側で決める（Eumenes は stage を表示するだけ）。

## 5 段A：即時計算 `calculate`

- binding は `execution:"instant"`、tool 一件（schemaKey `computeExpression`: `{expression: string(1..500)}`）、`fallbackToolchainId` は `compute_python`。
- R1 は利用者の言った式を mathjs の構文に直して渡す（「5マイルをkmで」→ `5 mile to km`）。式への変換は LLM に任せ、Eumenes は語句で振り分けない。
- adapter の `instant.run` が mathjs で評価する。隔離の設定:
  - `create(all)` の後、`import`・`createUnit`・`evaluate`・`parse`・`simplify`・`derivative`・`resolve`・`reviver` を式から呼べないように上書きする（mathjs の公式のセキュリティ手順）。
  - 式は 500 文字まで、BigNumber の精度は 64 桁まで、行列は 100×100 まで、結果の文字列は 2,000 文字まで。超えたら `{ok:false, code}` で B へ渡す。
  - 評価は Worker で行い、200ms で打ち切る（巨大な階乗などで backend を止めない）。
- 回答文は「1234 × 5678 = 7,006,652 です。」の形。式を必ず入れ、利用者が解釈違いに気づけるようにする。単位換算は換算先の単位を入れる。
- 為替（通貨換算）は対象外。レートの取得元が要るので、Web 調査か別の即時回答に任せる（§11）。

## 6 段B：計算担当 `compute_python`

### 6.1 型

単発型（command）。担当は一件の依頼を受け、コードを書いて実行し、結果を返したら終わる。数値の解釈や説明は通常担当が結果から行う。

- 1ターンの推論は最大 3 回（コード作成 → 実行 → `syntax_error`・`runtime_error` なら traceback を見て 1 回だけ直す）。`timeout`・`memory_exceeded` は直さず、そのまま報告する（自動で上限を上げない）。
- 担当に見せる snapshot（`snapshotInTransaction`）に、LARM の `environment`（ライブラリと版、GPU の有無、上限）と、この会話の進行中・直近のジョブ一覧（取消・結果参照の対象）を入れる。環境は catalog revision ごとにキャッシュする。

### 6.2 tools（新しい builtin キー）

| tool | 入力 | 動作 |
| --- | --- | --- |
| `compute.run` | `{title, code, inputs?, timeoutSec, accelerator}` | ジョブを受け付け、キューの `compute.submit` を積む |
| `compute.cancel` | `{jobId}`（snapshot にあるものだけ） | 取消。取消後に届いた結果は採用しない |
| `compute.result` | `{jobId}` | 保存済みの結果を読む（再計算しない） |

`inputs` は会話で利用者が示した数値・表を JSON で渡す（合計 256 KiB まで）。添付ファイル（CSV 等）の受け渡しは §11。

### 6.3 短い計算と長い計算（要合意 Q3）

- **短い計算**（数秒〜20秒）は、同じ返答で結果を答えたい。tool-runtime の command 操作は transaction 内で完結する前提なので、そのままではジョブの完了を待てない。
- 案1（推奨）: 段B の最初の実装では、受付後にキューのジョブが状態を追い、完了したら会話へ assistant の発言を一件追加する（3D・タイマーと同じ通知経路）。短い計算でも「計算しています」→ 数秒後に結果、の2発言になる。
- 案2: 単発型のエージェント核に「transaction 外でジョブの完了を最大 N 秒待ち、終わっていれば同じ返答で答える」仕組みを足す。P3 の非同期ツール（`async_completed`）と同じ部品なので、P3 の詳細設計と一緒に入れる。
- 案1で始め、P3 で案2へ移る、を推奨する。

### 6.4 Eumenes 側の投入制限

LARM の隔離に加えて、投げる前に次を確かめる（LARM が落ちていても守れる層）。

- コード・入力・`timeoutSec` が `environment.limits` の範囲内。超えたら投げずに `limit_exceeded` で答える。
- 同じ会話で進行中のジョブは 1件まで。全体でも単位時間あたりの投入数に上限（例 1分に 10件）。
- 自動再送しない。`timeout`・`memory_exceeded` で上限を上げて再実行しない。
- GPU を使うジョブ、または `timeoutSec` が一定（例 300秒）を超えるジョブは、投げる前に利用者へ確認する（Q8）。

### 6.5 profile と SKILL（要点）

- `result` 変数に答えを入れる。グラフは matplotlib で描いて保存する（LARM の規約に従う）。
- 記号計算は SymPy、数値計算は NumPy・SciPy、統計は statsmodels、機械学習は scikit-learn、深層学習と GPU が要るものは PyTorch を使う。環境に無いライブラリを import しない（snapshot の一覧を見る）。
- 乱数は seed を固定する。長い学習は `report` で進捗を出し、`timeoutSec` を見積もって指定する。
- 結果の数値は丸めずに `result` へ入れ、丸めや説明は通常担当に任せる。

## 7 compute domain

### 7.1 ジョブ台帳 `compute_jobs`

`id`・`requestId`（Idempotency-Key）・`origin`（conversation・screen・将来は shared）・`conversationId`・`runId`・`title`・`code`・`inputs`・`timeoutSec`・`accelerator`・`state`（submitting・queued・running・completed・failed・cancelled）・`stage`・`progress`・`larmJobId`・`result`（value・stdout・stderr の上限付き）・`errorCode`・`errorMessage`・`createdAt`・`updatedAt`・`revision`。

- コードと結果は DB にだけ保存し、ログには出さない（`jobId`・`larmJobId`・分類 code・所要時間だけ）。
- 成果物（PNG 等）は完了時に取得して `compute_artifacts` に保存（1件 5 MiB・1ジョブ 10 件まで）。取得後に LARM 側の結果を削除する。
- migration は名前付き・`after` 明示（`docs/domains.md`）。

### 7.2 キューのジョブ

画像・3D と同じ `HandlerDefinition`。`compute.submit`（POST、自動再送しない。同じ Idempotency-Key での照会だけ）、`compute.poll`（間隔は状態に応じて伸ばす）、`compute.fetch`（結果と成果物の取得・LARM 側削除）、`compute.cancel`。

### 7.3 完了・失敗の通知

会話から頼まれたジョブが終わったら、その会話へ assistant の発言を一件追加する（同じ ID で二度出さない）。本文は通常担当が結果から作るか、決まった形にするかを Q4 で決める。失敗は理由の分類を一つ添える（「計算が時間切れになりました（上限 300秒）」）。画面から投げたジョブは会話へ通知しない。

## 8 画面（artifact:compute.workspace@1）

- 入口「計算」。ジョブ一覧（状態・stage・進捗・所要時間）、選んだジョブのコード・結果の値・stdout/stderr・グラフ。
- 操作: 取消、同じコードで再実行（新しいジョブ）、コードを直して実行（画面から投げる）。
- 成果物は `GET /api/compute/jobs/:id/artifacts/:artifactId` で backend から渡す（Bearer は渡さない）。
- 最初の段では一覧と表示・取消だけにし、画面からのコード編集は後の段にしてもよい（Q5）。

## 9 守ること

- ライブラリ名は SKILL に書いてよいが、profile 名・モデル名・LARM のサービス名をコード・既定値・ファイル名に書かない。サービスは capability で発見する。
- Control の Bearer は backend 内だけ。画面・URL・ログに出さない。
- ログに式・コード・入力・結果・traceback を出さない。
- 生成 POST を自動再送しない。取消後・古い revision の結果を採用しない。
- `timeout`・`memory_exceeded` で上限を上げて自動再実行しない。
- 依頼の振り分け（A か B か）は LLM が関数で選ぶ。語句で振り分けるコードを書かない。

## 10 段階

| 段 | 内容 | 前提 |
| --- | --- | --- |
| S1 | 段A `calculate`（mathjs、instant）。fallback 先は Q2（S2 で `compute_python` に替える） | なし。LARM 不要 |
| S2 | LARM 計算クライアント、compute domain、段B `compute_python`（案1の通知経路） | LARM 側 §4 の構築 |
| S3 | 画面 `compute.workspace`（一覧・結果・グラフ・取消） | S2 |
| S4 | 短い計算を同じ返答で答える（案2）、協働型からの共有ツール（段C） | サブエージェント設計 P3 |
| S5 | 計算ノート（段D） | 需要次第 |

## 11 対象外

為替・株価など外部データの取得、添付ファイル（CSV・Excel）の受け渡し、学習済みモデルの保存と再利用、ライブラリの実行時追加、Eumenes 端末での Python 実行。

## 12 要合意事項

| ID | 論点 | 推奨案 |
| --- | --- | --- |
| Q1 | 2段構成（即時計算は Eumenes 内の mathjs、それ以外は LARM） | この構成にする |
| Q2 | S1 だけ先に出す場合の `calculate` の fallback 先 | 既存の Web 調査（`web.search`）。S2 で `compute_python` に替える |
| Q3 | 短い計算の返り方 | 案1（通知の2発言）で始め、P3 で案2 |
| Q4 | 完了通知の本文 | 結果を通常担当に渡して短い説明を作らせる（1推論増える）。決まった形だけだと数値の意味が伝わらないため |
| Q5 | 画面からのコード編集・実行 | S3 では一覧・表示・取消・再実行まで。編集は後の段 |
| Q6 | LARM の API 契約 §4 | この案で LARM 側を建てる。名前・path は LARM 側で決めてよく、確定したら §4 を確定仕様で置き換える |
| Q7 | 実行時間の上限 | 担当の既定 60秒、指定できる上限は LARM の `limits.maxTimeoutSec`（LARM 側で例 3600秒） |
| Q8 | GPU のジョブ・長いジョブを投げる前に確認するか | 確認する（command 担当の確認質問）。会話の応答が遅くなる可能性があるため |
| Q9 | 隔離の方式（§4.3） | ジョブごとに使い捨てる強化した rootless コンテナ。VM・gVisor は使わない（GPU を渡しにくく、家庭用には過剰） |
