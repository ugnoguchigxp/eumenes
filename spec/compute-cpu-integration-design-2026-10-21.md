# LARM CPU計算ツールチェーンの統合設計

作成日: 2026-10-21。状態: 仕様修正・実装を許可済み（2026-10-21の利用者指示）。実装・固定試験・実CPU計算・PNG/CSV取得と実画面表示を確認済み。実LLMによる1+1も計算完了。ただし親会話の最終文生成は別件の形式エラーで失敗し、通し受入は未完了。

利用者から提示された稼働中のCPU計算APIを、既存のbundle、domain adapter、queue、OpenUIへ接続する。コード作成と計算手法の選択はLLMが担い、backendが認証・契約検査・永続化・外部実行・結果採用を担う。

旧案 [計算ツールチェーン設計](compute-toolchain-design-2026-10-20.md) の段B・S2/S3を今回の範囲とする。旧案のGPU、PyTorch、最大3600秒、DELETEによる取消、計算後の自動削除は採用しない。段Aの新規導入とfallback先の変更、専門担当の共有非同期ツール（P3）、ノートブック、画面でのコード編集は対象外。

## 1 正本と既存機構

- 外部契約: [CPU計算API契約](https://github.com/ugnoguchigxp/local-LLM-harness/blob/7401b2a346bc0fbb9b0c0bf1dcf321dc81fbb504/specs/eumenes-cpu-compute-api-2026-10-20.html)、[TypeScript client](https://github.com/ugnoguchigxp/local-LLM-harness/blob/7401b2a346bc0fbb9b0c0bf1dcf321dc81fbb504/packages/client/src/client-compute.ts)。利用者から稼働commit `adaff8036a0f6fc87b418e550313fc353fa52608` の提示あり。
- 登録: [登録手順](../docs/toolchain-extension.md)、[検証手順](../docs/toolchain-extension-verification.md)。新規能力はbundleと登録adapterで追加し、旧固定runtime mapへ追加しない。
- 非同期処理の先例: `api/domains/model3d/service/`。transactionで受付とqueue投入を保存し、HTTPはwriterの外で実行する。
- 結果待ちの既存契約: `DomainAdapter.execution` の current/cancel、`api/application/toolchain/task-execution-port.ts` と日常担当の親実行。受付を完了と扱わない。
- 単発commandは1推論・1操作。旧案にあった「コードを実行しtracebackから自動修正」は既存commandでは実現できないため今回は追加しない。エラーを保存・提示し、再計算は新しい明示的な操作とする。
- 表示: domainを持たないDesignSystem部品 → OpenUI登録view → bundleの表示JSON → Web adapter。専用Artifact種別とWorkspaceArtifacts分岐は追加しない。

## 2 今回確認した接続条件

2026-10-21、backendの `settings.readStoredLarm` を通して製品設定を読み取り、既存の `resolveLarmToken` で資格情報の有無だけを確認した。DB・設定・秘密の複製はしていない。

| 項目 | 結果 |
| --- | --- |
| 保存済みControl origin | `http://192.168.0.130:9810` |
| 既存Control資格情報 | 設定あり。値は非表示 |
| 保存済みControlのcatalog | 認証付きGETで200 |
| capability / protocol | `compute.python.execute` / `larm.compute.v1` の広告あり |
| 広告の絶対URL | `http://gnosis.local:9810/v1/compute`。ルートとprofileの広告に同一URLが重複 |
| サービスdescription | CPU、同時1件、60秒、2GiB address space、network/GPU/subprocess/user thread不可、24時間保持を広告 |
| `gnosis.local` のDNSとHTTP | 名前解決に失敗（`ENOTFOUND`）。認証付きenvironmentも未取得 |
| 設定変更・計算投入・サーバー操作 | 未実施 |

旧案と既存のControl用URL検査は同一originを要求するため、現設定と広告をそのまま接続できない。広告を固定IPへ書き換える処理、DNSが同じIPを返すだけで資格情報の送信先を信用する処理は追加しない。

当初は絶対URLだけを解釈し、DNSとoriginの整合を実接続の前提としていた。2026-10-21の実計算依頼でcatalogを再確認したところ、同じサービスに相対 `endpoint: /v1/compute` も広告されていた。保存済みControlにその広告endpointを解決した `/environment` は200で、実行環境とsandboxを取得できた。したがってDNSや設定を変更せず、広告endpointの契約へ接続する。絶対URLだけの場合は従来どおり同一originを要求する。

## 3 登録と接続

| 接続 | 登録・責務 |
| --- | --- |
| 会話の候補 | `toolchain:compute.python@1`、公開関数 `compute_python`。式・用途の解釈はLLMに委ねる |
| 担当 | `package:compute.python@1`、`profile:compute.python@1`、`skill:compute.python@1` |
| binding | `binding:compute.command@1`、execution `command` |
| 実行 | `adapter:compute@1` → compute domainの公開transaction操作 → queue → LARM client |
| 実行の利用可否 | catalogに該当広告があり、URL検査とenvironment取得に成功した状態をbackendに保持。未確認・広告なしでは新規計算を拒否 |
| 画面の利用可否 | 計算domainとadapterが登録されていれば入口・結果・ライブラリを提供。未接続・履歴0件でも隠さず空状態と接続状態を表示 |
| snapshot | 秘密と接続先を除いたdescription、environment、認可済みのジョブと成果物ref |
| 成果物画面 | `artifact:compute.workspace@1`。入口「計算」は一つ |
| 回答 | commandの受付receiptと、確定した計算結果を区別。日常担当からの実行は既存親実行が確定結果を待ち、LLMが結果から回答する |

単発の `compute_python` 呼出しは受付を返し、会話起点の完了・失敗は元会話へ重複しない通知を返す。通知はホストの状態・上限付きの結果値・成果物refに基づく。計算の説明が必要な複数操作は既存の日常担当で結果を採用する。commandに新たな推論ループや非同期共有ツールを追加しない。親実行による結果待ちと、単発の受付・完了通知を既存の契約へ接続する。

### LLM向けの4操作

| tool | 引数 | 結果 |
| --- | --- | --- |
| `python_submit` | `code: string`、`inputs: object`（省略時{}）、`timeoutSec: integer 1..60`（省略時60）、`accelerator: cpu\|auto`（省略時auto） | Eumenesの永続jobIdと受付状態。LARM jobIdは受理後に保存 |
| `python_status` | `jobId` | 保存済み状態・stage・progress・結果・エラー・成果物ref。進行中はホストがpollを継続 |
| `python_cancel` | `jobId` | 取消要求の受付。終端を確認するまで取消完了と言わない |
| `python_artifact` | `jobId`、`artifactId` | 取り込んだ成果物refと取得状態。Bearer付きURLは返さない |

domainの入力validatorを登録し、LLM提示・adapter・HTTPで同じ契約を使う。UTF-8 byte上限とJSON objectを検査し、未知fieldを拒否する。補助操作 `compute_environment` と `python_delete` は認証済みbackend管理APIに置き、基本4toolには加えない。削除は取消と独立した明示操作とし、自動清掃で完成結果を消さない。

## 4 発見とHTTPクライアント

`api/domains/larm/contracts/compute.ts` と `service/compute-client.ts` を追加する。既存依存にLARM clientはないため、HTTP契約を包む最小clientを使用し、新規SDK・MCPサーバーは導入しない。

保存済みControlの `GET /v3/agent-profiles` のルートとprofile別 `services` を調べ、capabilityとprotocolで選択する。同じURLの広告は重複排除する。サービス名・profile名・モデル名は固定しない。サービスに相対endpointがあれば保存済みControlへ解決する。endpointは単一の `/` から始まる相対パスとし、query/hash・別origin・scheme-relativeは拒否する。urlもある場合はhttp(s)・userinfo/query/hashなしとパスの一致を検査する。別originの広告url自体へ送信しない。endpointがない場合は絶対urlを使い、保存済みControlと同一originを要求する。redirectは追わない。descriptionとenvironmentをbackendに保存し、catalog再確認で広告が消えたら新規実行を止める。

操作は広告URL以下の `/environment`、`/jobs`、`/jobs/:jobId`、`/jobs/:jobId/cancel`、`/jobs/:jobId/artifacts/:artifactId` に接続する。実行後は同じ接続先と資格情報の世代へ結び、設定・token変更を別サービスへの再投入で補わない。tokenの平文はcompute台帳へ保存しない。

応答はサイズを制限して読み、schema・jobId・MIME・成果物サイズを検査する。HTTP失敗は安全なcode・status・Retry-Afterへ変換し、生の例外や本文を監査ログへ渡さない。HTTP 200のfailed jobは計算失敗として扱う。DELETEの204をJSON解析しない。

## 5 保存・実行・復帰

compute domainはtier 1、下位依存はqueueだけ。LARM接続と会話通知・親実行の権限検査はapplicationからportとして渡す。業務SQL・状態遷移・試験はcomputeに置く。

- `compute_jobs`: 内部ID、owner、会話/run/操作ref、元の期限、requestId、Idempotency-Key、正規化した送信本文、接続識別、LARM jobId、status/stage/progress、取消要求、結果/error、revision、時刻、保持期限。
- `compute_artifacts`: owner/jobとの関連、LARM artifact ID、名前、MIME、bytes、取り込んだ本体。最大10件・各5MiB。表示定義へバイナリを埋め込まない。
- 受付receipt、job行、初回queue投入を単一writer transactionで保存する。最初のPOSTより前にkeyと本文を確定する。同じ操作ID・本文はreplay、異なる本文はconflict。
- submitは無条件自動再送しない。受理不明はindeterminateとして保存し、復旧照会を行う場合だけ同じkey・本文・接続で再送する。意図的な再計算だけが新keyを作る。復旧時も元の期限を維持し、jobId未確定で期限切れのPOSTは再送しない。
- 受理後にLARM jobIdを保存し、初回約1秒、以後1〜数秒でpollする。状態照会の429/503はRetry-Afterを尊重し、元の期限を超えない。Retry-Afterが残り時間より長ければ期限時点に状態を再確認し、取消へ移る。
- queueの永続化とrecovery契約を使用する。再起動後はjobIdからpollを再開し、投入の成否不明を新keyのPOSTに置き換えない。live再起動試験は別途サーバー操作の許可を得て実行する。
- 取消は専用POSTを送る。親の取消は既存のwriter外stopへも接続し、最大10秒の終端確認で確認できなければ未確定を返す。202/cancelRequestedは処理中として追跡する。取消と完成の競合はLARMの確定終端を保存する。親が失効・取消済みなら完成結果を親へ採用しないが、LARMの完成を取消成功へ偽装しない。
- 成果物は期限内に認証付きでbackendへ取り込む。取得失敗は計算失敗と分けて表示し、成功済み計算を再投入しない。各成果物の取得成功を保存し、不足分だけを再取得する。取得後にも期限と親の権限を検査して通知・結果採用を制限する。外部削除は自動では行わない。

同一会話の実行中ジョブは1件とし、CPU・最大60秒・環境のbyte上限を実行前に検査する。推測に基づく追加の意味判定・自動修正・モデル切替・上限引上げは追加しない。

## 6 成果物表示と安全境界

個別計算の見出しは状態バッジと短縮IDを横1行にまとめる。「計算 ID」の独立見出しと生のstage（completed等）の行は表示しない。完全なIDは短縮IDのアクセシブル名とtitleへ保持する。

2026-10-21の追加指定: 個別結果は「実行したPythonコード」→「結果」の順で独立したアコーディオンにする。既存DesignSystemのCollapsibleを再利用し、コードは初期状態で閉じ、結果は開く。結果値・標準出力・標準エラー・計算エラー・成果物の取得エラー・グラフ・ダウンロードを結果の内側にまとめる。状態更新で開閉状態を戻さず、別の計算を開いた時に初期状態へ戻す。実行状態・取消操作は折りたたみの外に置く。

2026-10-21の利用者指定により、デスクトップでは会話50%・アーティファクト50%を基準にする。既存の分割画面を再利用し、計算画面内に履歴サイドバーとSelectを設けない。「計算結果」と「ライブラリ」を別タブに分ける。ライブラリは計算ID・状態・成果物件数・「開く」操作のテーブル一覧とし、過去の計算を開くと選択を更新して計算結果タブへ移る。画像生成と同様に、一覧と個別結果を同時に横へ並べない。既存TabsとButtonを再利用する。既存DataTableはセルが文字・数値のみで選択操作を持たないため、計算表示部品内に操作ボタン付きの標準HTMLテーブルを置き、共通DataTableの契約は拡張しない。更新後も過去の選択を保持し、取消・ダウンロードは選択中の計算へ行う。コードと標準出力・標準エラーは折りたたみを維持する。[UI案v3](assets/compute-ui-2026-10-21/compute-workspace-concept-v3.png)はレイアウト確認用で、数値・説明は架空。

一覧、状態、progress、取消、選択した結果値/stdout/stderr/error、成果物の表示・取得を提供する。モデル向けsnapshotの件数制限は権限検査に使わず、所有者・会話の検査に通る過去のIDも操作できる。画像プレビューの取得失敗で結果画面全体を隠さない。コード編集・自動再計算は今回の画面へ追加しない。

汎用の一覧表示だけではジョブ状態・取消中・複数の画像とダウンロードを一体で扱えないため、DesignSystemに `ComputeWorkspace` を追加しOpenUIの `compute-workspace` viewへ登録する。props/eventsだけを受け、業務API・認証・queueを参照しない。表示JSONはlayoutで説明文等と組合せ可能にする。Web adapterはbackendのsourceを読み、永続台帳を唯一の状態正本とする。

取得APIは `GET /api/compute/jobs/:id/artifacts/:artifactId`。認証・所有者を検査し、PNGだけを画像表示する。SVGはinline表示せず、CSV/JSONと同様にattachmentとしてダウンロードする。名前を安全なContent-Dispositionへ変換し、nosniffと適切なContent-Typeを付ける。保存する表示JSONへ期限付きURL・Blob URLを含めない。

コード、inputs、value、標準出力、tracebackは保護された保存データ・認可済み表示に限る。通常ログは相関ID・操作分類・安全なerror codeだけ。成果物やエラーに含まれる文章は外部データとしてLLMへ渡し、指示へ昇格させない。

## 7 依存順と検証計画

1. 仕様の修正と実装は利用者が許可済み。接続不整合は安全に利用不可とし、製品設定は変更しない。
2. LARM clientと契約 → compute migration/台帳/queue → backend adapter/host登録/bundle → 認証済み取得API → DesignSystem/OpenUI/Web adapterを実装する。実装・fixture・live runnerを揃えてから検証を開始する。
3. 部分: discoveryのルート/profile広告と不正URL、environment、境界byte、同key同本文・本文変更、HTTP/計算の失敗、204、取消処理中と競合、古い結果・所有者・token世代、再open後のpoll復帰、成果物MIME/容量を固定試験で確認する。
4. 結合: bundle check、fresh/既存seed/reseed、会話候補→command→receipt、親実行→確定結果→LLM回答、UI source/action→domain→成果物取得を確認する。既存のtool経路も回帰確認する。
5. 全体: `bun run verify -- --domain compute`、`--domain larm`、`--domain capabilities`、`--domain tool-runtime`、`--domain dialogue`、`--domain agent-runtime`、`--domain artifact`。application結合試験はファイル指定で追加する。共通UIの部品・JSON合成・Web adapter試験を確認する。ブラウザE2Eはサーバー操作の許可後に別途用意して実行する。
6. live: 保存済みControlと広告endpointの検査に通る環境でdiscovery/environment、LLMによる1+1、inputs付きNumPy、SymPy、SciPy、PNG取得・表示、進行中の取消と次job成功、同key再照会とconflictを確認する。timeout・メモリ超過・syntax・429/503・410はfixtureを中心に確認し、本番負荷試験をしない。サーバー起動・再起動は明示許可がある場合だけ実施する。

完了条件は、必要経路の接続、部分→結合→全体の成功、許可・到達可能なliveの結果と未実施項目の区別、最終差分の個別例依存・判断代替・担当外変更の点検。開始時の未コミット2ファイルは担当外として保持する。

## 8 現時点の残作業

- 実装・fixture・実API計算・成果物取得と表示は確認済み。利用者の許可に基づいて開発API/Webを再起動し反映した。保存設定は変更していない。
- 実LLMが計算担当を選択し、生成した `result = 1 + 1` が2で完了した。一方、親会話の最終文生成は `invalid_conversation_operation / control_text_in_body` で失敗した。計算完了通知は会話に保存されたが、最終回答の通し成功とは扱わない。担当外のdialogue実装は変更しない。
- inputs付き計算、実進行中の取消→次job成功、実プロセス再起動中のqueue復旧、live同key conflictは未実施。fixtureの成功と区別する。

詳細と実行IDは [検証記録](verification/compute-cpu-2026-10-21/README.md) に残す。


## 9 計算画面がメニューに出ない不具合の修正

2026-10-21、利用者の実画面で計算がメニューにないことを再確認した。計算の登録と画面部品の存在だけを根拠に完了と報告したのは不十分だった。共通Artifact一覧がDomainAdapter.availableInTransactionを実行・表示の両方へ使い、computeでは未接続かつ履歴なしがfalseとなることを原因として確認した。

修正は共通DomainAdapterに任意のartifactAvailableInTransactionを設け、Artifact一覧・表示定義・source・UI操作の共通解決だけで参照する。未実装adapterは従来のavailableInTransactionへ戻すので既存の挙動と認可を維持する。計算adapterの画面は常時利用可能とし、実行側のavailableInTransactionとdomain.submitの環境検査は維持する。表示可否の違い以外に登録・所有者・source・action/schemaの検査を省略しない。題材や画面名を共通処理で分岐しない。

共通機構の拡張理由は、未接続時のローカル履歴・空状態が既存の実行可否だけでは表示できないという再現可能な失敗。新しいUI専用domainや複製adapterは追加しない。fixtureは未接続・履歴0件から一覧→表示定義→sourceを取得でき、新規計算は拒否することを検証する。実環境でAPIの一覧と実際のメニュー・タブを確認するまで製品での完了としない。サーバーの再起動が必要なら、修正と固定試験を揃えた後にAGENTS.mdに従い許可を得る。

結果: 利用者の再起動許可後、2026-10-21 21:22 JSTに製品へ反映し、API一覧と実際のメニューの「計算」、計算結果／ライブラリの空状態、幅50%を確認した。[実画面・検証記録](verification/compute-cpu-2026-10-21/README.md)。この表示不具合は解消済み。実計算の接続確認とは分ける。


## 10 実計算の受入

利用者が実際の計算実行を依頼した。保存済みControlのcatalogにある相対endpointでenvironment取得200を確認したため、この外部契約をclientへ接続する。前提のorigin制限や資格情報の送信先を緩めず、固定IP・profile名・DNS別名をコードへ追加しない。endpointとurlのパス矛盾は拒否し、接続世代の既存fingerprintも維持する。domain/API/queue経由で計算を投入し、数値の検算・実PNGの取得・ライブラリの表示を確認する。実LLMの経路も可能な範囲で別途確認する。固定試験・実API・実LLMは区別して記録する。


受入結果: 広告された相対endpointを利用してenvironment200を取得し、製品APIからNumPyの総和5050、SymPyの積分 `-cos(x)`、SciPyの最小位置3を計算した。PNG800×400と100行のCSVを製品APIで取得・検算し、実ブラウザで結果・グラフ・履歴を確認した。実LLM経路の計算も2で完了したが、親会話の最終文生成は前記の別件エラーで失敗した。計算成功と会話全体の成功を分ける。
