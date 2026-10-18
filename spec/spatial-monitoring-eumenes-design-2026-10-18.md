# Spatial 監視の実測接続（Eumenes 側）

作成日: 2026-10-18

状態: 2026-10-18 利用者合意（§8 Q1〜Q7 決着）。実装・fixture 試験済み（§10）。ブラウザ E2E・live（実 LARM・実機）での確認は未実施。設定画面の背景の説明文（bundle）は未更新（§10）。LARM 側の API は後続（§9）。

関連: [背景の状態契約](../docs/backgrounds.md)（`items` が唯一の観測入力）、[Spatial 検証記録](verification/spatial-galaxy-2026-10-14/README.md)（実測・API 取得経路は未接続）、[リアルタイム方針](../docs/realtime.md)、[ログ](../docs/logging.md)、[LARM 接続維持](larm-connection-retention-design-2026-10-18.md)。

## 1. 背景と目的

会話の背景「Spatial」は12体の監視対象を描くが、`ConversationBackground` が `items` を渡しておらず、全12件が固定の「未確認」のまま（`web/src/domains/background/initial-items.ts`）。Eumenes が既に持っている実行記録と、新たに読むホスト計測値から各対象の `SpatialState` を作り、背景へ渡す。

- 健全性（health）は取得側が判定し、Scene・モデルは判定しない（既存契約どおり）。
- 未取得の値は省略し、0 と区別する。デモ値は実測として扱わない（既存契約どおり）。
- 会話本文・設定・認証情報・Provider の生応答は観測に含めない。

## 2. 対象ごとの観測源（2026-10-18 調査）

| 対象 | activity（実行中） | health の材料 | utilization | 既存の記録 |
| --- | --- | --- | --- | --- |
| LLM | `inference_attempts.status='running'` かつ purpose=llm | LARM 状態（`GET /api/status`）、直近 attempt の failed＋reason | queue resource `inference.llm` の inUse/capacity | あり（DB） |
| ASR | 同上 purpose=asr | 同上 | `inference.aux` の inUse/capacity | あり（DB） |
| TTS | 同上 purpose=tts | 同上 | `inference.aux` | あり（DB） |
| Embedding | **記録なし** | **記録なし**（ログのみ） | なし | 新設（§4.2） |
| 態度判定 | larm service の `judging` フラグ（非公開） | 配送判断の fallback 理由 unavailable/timeout/invalid | なし | `answer_deliveries` に結果のみ。新設（§4.2） |
| 言語判定 | ASR 後の LLM 判定（subject 接尾辞 `:language`）の running | 同 attempt の failed | なし | あり（DB、purpose=llm に混在） |
| 画像生成 | `/api/jobs` の running（kind=image） | `image_generations` の failed＋errorCode。`image_service_unavailable` は接続断 | なし | あり（DB） |
| 楽曲生成 | 同上（kind=music） | `music_generations` の failed＋errorCode | なし | あり（DB） |
| CPU | — | ホスト計測（§4.3） | 全コア使用率 | **なし** |
| Memory | — | ホスト計測 | 使用率 | **なし** |
| SSD | — | データディレクトリのボリューム空き | 使用率 | **なし** |
| Eumenes Backend（Network の枠） | 実行中のジョブ・推論があれば working | snapshot の取得可否、event loop の遅延、待ち行列の最古待ち | event loop utilization | **なし**（`perf_hooks` で新設） |

言語判定のうち TTS 用の `speechLanguage()` は文字種の判定だけでモデルを呼ばないため、観測対象に含めない。

## 3. 状態の判定規則（案）

Eumenes 側で判定し、API はそのまま `SpatialState` 相当を返す。

**サービス系（LLM〜楽曲生成）**

| health | 条件 |
| --- | --- |
| disconnected | 接続先に届かない状態。LARM 経路は LARM 状態が `failed`/`unconfigured`、cloud 経路は接続が無効または credential が無い。画像・楽曲は catalog に該当 capability が無い。直近 10 分の最新の失敗が接続不能の理由（`larm_*` の接続系・`image_service_unavailable` 等）のときもここに入れる |
| fault | 直近 10 分の最新の結果が接続不能以外の理由で失敗（取消・利用者中断は除く）。接続していないことは fault にしない（Q6） |
| healthy | 直近 10 分以内に成功があり、上のいずれでもない |
| unknown | 直近 10 分に結果がない、または経路が未設定 |

- activity: running が1件以上で `working`、接続確保中（LARM `connecting`）で `starting`、それ以外 `idle`。
- strength: running 件数を capacity で割った値（capacity のない対象は省略）。
- 経路が cloud の用途は LARM 状態を見ず、接続の有効/無効・`credentialAvailable`・attempt の結果で判定する（Q6）。
- サービス系に pressure は使わない（Q4。所要時間・待ち時間の基準は持たない）。

**ホスト系（CPU・Memory・SSD）と Eumenes Backend**

| health | 条件（案、Q3） |
| --- | --- |
| pressure | CPU 使用率（前回取得からの平均）85% 超 / メモリ使用率 90% 超 / 空き容量 10% 未満 |
| fault | 空き容量 3% 未満 |
| healthy | 計測でき、上のいずれでもない |
| unknown | 計測に失敗 |

高利用率だけで赤（fault）にはしない（既存契約）。activity はホスト系では常に `idle`（自転・公転は既存設定で動く）。

Eumenes Backend（案、Q7）:

| health | 条件 |
| --- | --- |
| disconnected | Web が snapshot を取得できない（Web の hook が判定。backend 自身は返せないため） |
| healthy | 取得でき、上のいずれでもない |

- 健全かどうか（healthy / disconnected）だけを判定する。pressure・fault は使わない（Q7）。個々の失敗は各サービスの形に出す。
- activity: queue の running または推論 attempt の running があれば `working`、なければ `idle`。
- utilization: 負荷の目安として、前回取得からの event loop utilization（`perf_hooks.performance.eventLoopUtilization` の差分、0–1）を渡す。色（health）は変えず、既存の描画で利用率として見せるだけ（Q7 で確認中）。

**stale**: 取得側（Web の hook）が判定する。`observedAt` が取得間隔の 3 倍（3 分）より古い、または取得に失敗し続けたら `stale: true`。

## 4. 構成

### 4.1 backend: `monitoring` domain（新設）

- tier は inference・queue・image・music・larm・settings より上（`scripts/domains.ts` に登録、`docs/domains.md` 更新）。各下位 domain の公開操作だけを読み、判定は monitoring に置く。
- `GET /api/monitoring/snapshot` → `{ observedAt, items: [{ id, kind, label, state }] }`。`id` は実体 ID（例 `eumenes-host-cpu`、`service-llm`）で、形状サンプルの ID とは別。`kind` は 12 形状のいずれか。
- DB への書き込みはしない。読み取りだけで、1 回の取得は軽量な集計 SQL（直近 10 分・用途別）と in-memory 値の読み出しで済ませる。
- 契約（zod）は `api/domains/monitoring/contracts`、client は `client/monitoring.ts`。

### 4.2 記録のない対象の観測（Embedding・態度判定）

LARM 呼出しを持つ `larm` domain に、in-memory の観測カウンタ（実行中件数・最後の成功時刻・最後の失敗時刻と理由コード）を置き、読み取り専用の公開操作で monitoring へ渡す。DB テーブルは作らない（再起動で消えてよい。消えた直後は unknown）。既存の `judging` フラグはこのカウンタへ置き換え、二重管理しない。

### 4.3 ホスト計測

backend が動いている Mac（Eumenes の実行ホスト）を計測する。LARM が別ホストの場合、その計測は §9 で LARM から取る。

- CPU: `os.cpus()` の times 差分（前回取得との差）で全体使用率。
- Memory: macOS では `os.freemem()` が再利用可能なキャッシュを空きに含めず使用率が過大に見えるため、`vm_stat` の値（free＋inactive＋speculative を利用可能とみなす）で使用率を出す（Q3）。
- SSD: `fs.statfs(データディレクトリ)` の空き/総量。
- Network: 計測しない（Q2）。Network の形（`network`）は Eumenes Backend の表示に使い、表示名を「Eumenes Backend」にする。
- Eumenes Backend: event loop utilization を前回値との差分で出す。
- 子プロセス（`vm_stat`）は monitoring の計測モジュールに閉じ込め、取得結果を 2 秒キャッシュする。

### 4.4 Web

- 取得 hook（`useMonitoringItems`）は background domain の外（`web/src/domains/monitoring/`）に置き、`ConversationPanel` → `ConversationBackground` → `SpatialBackground` の `items` へ渡す。background domain は変更しない（受け口は既存）。
- 取得は Spatial を表示中かつタブ表示中だけ 1 分間隔で polling（Q5、利用者決定）。表示開始時に 1 回取得する。既存 SSE の `change` でも再取得する。光の妖精を表示中は取得しない。
- 配置（position・orbit）は既存の `initialSpatialItems` を kind で引いて使い、状態だけ差し替える。
- 状態プレビュー（デモ）有効時は従来どおりデモ値が優先。
- `source` は実測を `measurement`、未取得を `unconfirmed` にする。

### 4.5 ログ

監視の取得は通常ログに出さない（定期取得のため）。判定結果が変化したときだけ `monitoring.health_changed`（対象 ID・前後の health・理由コード）を info で出す。本文・設定値は出さない。

## 5. 段階

| 段階 | 内容 | 完了条件 |
| --- | --- | --- |
| P1 | monitoring domain、サービス系の判定、snapshot API、client | fixture 試験で 8 サービスの各 health/activity 分岐を確認 |
| P2 | larm の観測カウンタ（Embedding・態度判定）、`judging` 置換 | 既存の態度判定試験と新規カウンタ試験が通る |
| P3 | ホスト計測 | 計測モジュールの単体試験（子プロセス出力の解析は固定文字列で） |
| P4 | Web hook と背景への接続、stale 判定 | 部品試験。ブラウザ E2E は Spatial の該当ファイルを個別実行 |
| P5 | docs 更新（`docs/backgrounds.md`・`docs/settings.md` の「未接続」記述、`docs/domains.md`） | — |

検証は `bun run verify -- --domain monitoring` と影響 domain（larm・background）。fixture・live・実機の結果を分けて記録する。

## 6. 変更しないもの

- background domain の描画・判定方式（items を受け取るだけ）。
- 推論・画像・楽曲の実行経路と記録形式。
- LARM 本体。

## 7. リスク

- 子プロセス（`vm_stat`）は macOS 前提。他 OS では該当項目を unknown にする。
- 集計 SQL が 1 分ごとに走る（Spatial 表示中のみ）。直近 10 分に絞り、必要なら `inference_attempts(started_at)` の index を確認する。
- `judging` フラグの置換は態度判定の同時実行防止に関わるため、置換後も同時実行しないことを試験で確認する。

## 8. 要合意事項

- **Q1 ホストの範囲**: 決定（2026-10-18 利用者）。CPU/Memory/SSD は Eumenes backend が動く Mac を計測する。LARM ホストの計測は §9 で LARM API から取る。
- **Q2 Network**: 決定（2026-10-18 利用者）。Network は計測せず、その枠を Eumenes Backend の監視に使う。送受信量・到達性の案は後続で再検討する。
- **Q7 Eumenes Backend の判定**: 決定（2026-10-18 利用者）。healthy か接続断かだけを判定する。負荷の見せ方は確認中: event loop utilization を利用率として渡し、色は変えない案。
- **Q3 しきい値**: §3 のホスト系しきい値（CPU 1分平均 85%、メモリ 90%、空き 10%/3%）とメモリの算出方法（`vm_stat`）。決定（2026-10-18 利用者）。実機で調整する。
- **Q4 サービスの pressure**: 決定（2026-10-18 利用者）。考慮しない。サービス系は所要時間・待ち時間で pressure にしない。
- **Q5 取得方式**: 決定（2026-10-18 利用者）。Spatial 表示中だけ 1 分 polling＋SSE。5 秒は頻度が高すぎるため不採用。
- **Q6 接続していない状態**: 決定（2026-10-18 利用者）。接続していない状態を disconnected として区別し、fault にはしない。cloud 経路の用途は cloud の接続状態で判定する。

## 9. 後続: LARM 側（概要のみ）

LARM に health/metrics の API は現在ない（`docs/larm.md`）。後続で、LARM ホストの CPU/GPU/NPU・メモリ、Provider ごとの読込状態・実行中件数を返す API を LARM 側に設け、Eumenes の monitoring が取得して同じ snapshot に載せる（LARM ホストの項目を別の実体 ID で追加するか、ホスト系を置き換えるかは、その設計時に決める）。

## 10. 実装記録（2026-10-18）

実装した範囲: P1〜P5。設計からの差分は次のとおり（いずれも合意済みの判定方式は変えない実装上の選択）。

- **記録のない対象（§4.2）**: 観測カウンタは `larm` domain の `createActivityRecorder`（`api/domains/larm/service/activity.ts`）。application が2つ作り、態度判定は `createInference` → `createLarm` の `judgeActivity`、Embedding は `createSavedEmbedder` で包む。既存の `judging` フラグは同時実行の防止として残し、観測には使わない（役割が違うため置き換えない）。取消（signal の abort）は成功・失敗のどちらにも数えない。
- **推論の記録**: `inference` に `attemptActivity(since)`（`service/activity.ts`）を追加。probe（`probe:%`）と取消（reason `cancelled`）は除く。
- **画像・楽曲**: 各 domain に `activity(since)` を追加し、直近50件の生成記録から実行中件数・最新の完了と失敗を返す。catalog の capability 有無は1分ごとに LARM へ問い合わせないため見ない。接続断は LARM の状態と `image_service_unavailable`・`music_service_unavailable` で判定する。
- **接続不能の理由**: 推論の LARM fallback と同じ `fallbackErrors` に、`larm_profile_missing` 等の到達不能コードを加えたもの（`api/domains/monitoring/service/rules.ts`）。
- **サービスの utilization**: 出さない。queue の `inference.llm`・`inference.aux` は画像・楽曲・OCR 等のジョブ用で、推論の実行とは対応しないため。
- **Eumenes Backend の負荷（Q7）**: Bun では `performance.eventLoopUtilization()` が常に0を返すため、backend プロセスの CPU 使用率（`process.cpuUsage()` の差分 ÷ 経過時間、1コアで上限1）を utilization にした。色は変えない。
- **取得（Q5）**: 1分ごとの polling だけにした。SSE の `change` は会話中に頻繁に来るため、再取得の合図には使わない（`changeRoots` に入れない）。
- **ログ**: `monitoring.health_changed` は既存のログ項目で `subjectId`（対象ID）・`status`（新しい health）・`reason` を出す。
- **レビュー反映**: 期限切れ（signal の reason が `TimeoutError`）は失敗 `deadline_exceeded` として記録し、取消だけを除く。`local_timeout` は届いた上での遅延なので接続断ではなく fault にする。ホスト計測は2秒以内の読み取りで1回の計測を共有する（同時取得で極小の差分窓にしない）。cloud-only の用途には LARM の接続確保中（starting）を出さない。画像・楽曲の最新結果は `updatedAt` の新しい順で選ぶ。Web の stale は、端末の時計で「受け取ってからの経過」を30秒ごとに判定する。
- **未更新**: 設定画面「会話の背景」の説明文「Spatialの状態表示は、実際の機器の計測値にはまだ対応していません。」は settings bundle（`settings.display`）にあり、変更には新しい revision が要るため今回は変えていない。

試験（fixture）:

- `api/domains/monitoring/test/monitoring.test.ts`（判定規則、LARM 断・cloud 経路・credential 無し、10分窓、ホストしきい値、Backend の負荷と活動、`vm_stat` の解析）
- `api/domains/inference/test/attempt-activity.test.ts`、`api/domains/larm/test/activity-recorder.test.ts`
- `web/src/domains/monitoring/items.test.ts`（配置への当てはめ、取得失敗時の接続断と stale）
