# Eumenes プロジェクト評価(2026-10-09)

多角的評価の記録。コード読解(backend / frontend・client / テスト・ドキュメント・プロセスの3系統)と、本日実施した検証コマンドの実行結果に基づく。所見は原則 file:line の根拠付きで記載し、読解で確認した事実と推測を区別する。

## 評価方法

- 定量調査: 規模・構成・Git 履歴・依存の確認、`bun run lint`、`bun run typecheck`、`bun run verify:all` の実行(2026-10-09、未コミット変更を含む working tree に対して)。
- 定性調査: backend(`api/`)、frontend・client(`web/`、`client/`、`cli/`、`packages/design-system`)、テスト・検証基盤・ドキュメント・プロセス(`scripts/`、`tests/`、`docs/`、`spec/`)の3系統の読解。
- 実機・ブラウザの手動操作、live 検証(実 LARM 接続)は行っていない。

## 定量サマリ

| 項目 | 値 |
| --- | --- |
| 規模 | TS/TSX 462 ファイル、約 63,800 行(node_modules 除く) |
| テスト | backend 46・web 17・Playwright 1 spec(13 test)・design-system 約 56 ファイル、計約 334 ケース + design-system 約 1,000 ケース |
| テスト密度 | api/web/cli/client で試験約 13.5k 行 / 実装約 22k 行(約 0.6) |
| Git | 11 コミット(2026-10-07〜10-09)、未コミット 28 変更(新 domain `attitude-dataset` 含む) |
| lint / typecheck | 両方とも警告ゼロで通過(2026-10-09 実測) |
| verify:all | format・lint・型・domain 試験・build は通過。ブラウザ fixture 13 passed / **1 failed**(後述) |
| CI | なし(`.github/` 等なし)。全ゲートはローカル手動実行 |
| 依存 | Bun + Hono 4 + React 19 + Vite 8 + Zod 4 等、いずれも新しい。`eumenes-memory` は vendor tgz(0.3.3) |

本日の `verify:all` 失敗内容: `tests/browser/voice.spec.ts:199`「light avatar が設定画面遷移後に canvas を解放しない」。未コミット変更由来の退行か flake かは未切り分け。

## 総合評価

**開始2日強のプロジェクトとしては例外的に完成度が高い。** 特に「検証を設計に組み込む」姿勢(machine-enforced な domain 境界、fixture/live/実機の証跡分離、監査可能なレビュー記録)は、この規模・年齢のプロジェクトでは稀。一方で、個人・単一 Mac・CI なしという運用基盤と、数個の god module に成長リスクが集中している。

| 観点 | 評価 | 要約 |
| --- | --- | --- |
| アーキテクチャ | ★★★★☆ | DAG 宣言 + AST 検査で境界を強制。例外は checker の盲点と god module |
| backend 実装品質 | ★★★★☆ | `any` ゼロ、Zod を HTTP 境界に一貫適用。重複 infra と stringly-typed エラー対応が減点 |
| frontend 実装品質 | ★★★☆☆ | 音声の並行制御と SSE client は堅実。2,000 行級コンポーネントと deprecated API 依存が重い |
| 信頼性設計 | ★★★★★ | 単一 writer・fencing 付き queue・順序付き recovery・取消後の旧結果不採用。最も強い部分 |
| セキュリティ | ★★★★☆ | loopback 限定・token 導出・暗号化・ログ allowlist は良。`envRef` denylist と平文 HTTP LAN が穴 |
| テスト・検証 | ★★★★☆ | クラッシュ復旧を実プロセスで試験する等、密度・質ともに高い。カバレッジ穴と CI なしが減点 |
| ドキュメント | ★★★★☆ | logging.md・acceptance.md は精密。domains.md の鮮度落ちと証跡の gitignore 問題 |
| プロセス・運用 | ★★☆☆☆ | コミット粒度が粗く bisect 不能。CI なし、macOS 専用、単一開発環境依存 |

## 1. アーキテクチャ

### 強み

- **境界が機械的に強制されている。** 16 domain の依存 DAG を `scripts/domains.ts` に宣言し、`scripts/boundaries.ts` が TypeScript AST で (a) 未宣言 domain の import、(b) facade(`index.ts`)と `contracts` 以外への深い import を拒否する。実 import を総当たりした結果、宣言グラフと完全に一致し循環もない(調査で確認)。
- **composition root が規律的。** `api/application/server.ts:43-125` が依存順に構築し、recovery(memory→voice→larm→serviceTests→dialogue→queue→scheduler)を worker 起動前に直列実行、shutdown は逆順 + 単一 in-flight ガード(`server.ts:147-166`)。
- 全 domain が `contracts/controller/repository/service/test` + facade の同型構造(delivery のみ純粋ロジックで controller/repository なし)。

### 弱み

- **境界 checker の盲点**: `ImportDeclaration` のみ検査し、`export … from`(例: `api/domains/service-tests/contracts/index.ts:3`)、動的 `import()`、型 `import("…")` を見ない。実バイパス例: `api/domains/dialogue/test/memory-integration.test.ts:830` が `../../memory/service/journal` を動的 import(静的なら検出される深い import)。layer 規則(domain→application、web→api 内部)も未検査。
- **god module**: `larm/service/index.ts` 1,367 行(`connect` 約 370 行)、`inference/service/index.ts` 1,294 行(`executeRequest` 約 430 行)。レビュー・単体試験の単位として大きすぎる。
- **壊れやすい wiring**: `createApp` の optional 依存と `if (deps.x)` での route mount(`app.ts:37-53, 96-110`)、位置引数の `undefined` 渡し(`server.ts:84-92`)、`const larm = createInference(...)` という紛らわしい命名(`server.ts:63`)。
- **migration が位置依存・checksum なし**(`application/migrations.ts:41-67`、`infrastructure/sqlite/index.ts:65-83`)。vendor package の migration を slice で interleave しており、適用済み migration の書き換えを検出できない。

## 2. backend 実装品質

### 強み

- 型規律: production コードに `any` ゼロ、`as unknown as` 1 箇所、`@ts-ignore` なし。
- HTTP 境界で Zod を一貫適用(`safeParse` + `invalid_input`、例: `dialogue/controller/index.ts:31-33`)。settings contract は `.superRefine` で厳格(`settings/contracts/index.ts:182-215`)。
- エラーは snake_case の安定コード。内部 500 の詳細は client に漏らさない(`app.ts:130-133`)。

### 弱み

- **重複 infra**: 「有界 stream reader」が約 7 箇所に複製され(larm / inference / playground-http / voice-dialogue controller / settings controller / service-tests controller / `infrastructure/chat-stream.ts`)、既に挙動が drift(inference 版は read エラー時に reader を cancel せず `releaseLock` もしない)。SSE 実装も 3 系統(`application/events.ts`、`infrastructure/snapshot-stream.ts`、`infrastructure/chat-stream.ts`)。
- **repository の row 型が未検証**: SQLite row への `as Row` キャスト約 260 箇所(queue 50、scheduler 40 等)。bun:sqlite では典型だが実行時検査がない。
- LARM 応答は Zod でなく手書きガード(`larm/service/index.ts:128-138`)。
- **stringly-typed なエラー→HTTP status 対応**(`app.ts:111-136`): メッセージ文字列照合で、新コード追加のたびに手修正が必要、漏れると 500。
- queue runner が `error.message.slice(0,120)` をそのまま job の `errorCode` に永続化(`queue/service/runner.ts:484-487`)。未サニタイズの provider メッセージが queue API に露出しうる(推測)。

## 3. 信頼性設計(最も強い部分)

- **SQLite 単一 writer**(`infrastructure/sqlite/index.ts`): `flock` による排他 process lock、WAL、writer と read-only 接続の分離、全 write を promise chain で直列化し各々 `transaction()`、64 件超で `database_writer_queue_full`(503)。
- **queue**(`queue/service/runner.ts`): heartbeat 更新付き lease と settle 時の `owner/attempt/generation` fencing(451-475)、`SAVEPOINT` による handler 隔離(156-166)、crash 復旧は `replay_safe` なら retry・それ以外 `interrupted`(223-259)、deadline/lease-expiry sweep、会話単位の concurrency key、close 時の bounded drain。
- **dialogue** は prepare/execute/settle の各段で run revision と status を再検査し、stale 結果を破棄(`dialogue/service:202-220, 330-415`)。AGENTS.md の「取消後に古い結果を採用しない」規則を実装レベルで満たす。
- **SSE**(`application/events.ts`): invalidation-only、100ms debounce、`id: session:revision` + 接続時 `reset` で再同期、slow consumer の切断、最大 32 client。
- 複数 domain 保存は `*InTransaction(db, …)` を単一 `store.write` 内で合成(例: `dialogue/service:432-497`)、規約どおり。
- 懸念: lease 更新 write が約 10 秒ごとに `change` イベントを発火させ、client の全 query 再取得(後述)と組み合わさると実行中 job の間ずっと定期 refetch が起きる(推測)。

## 4. frontend・client 実装品質

### 強み

- **境界維持**: web/CLI とも共有 `client/` 経由の HTTP のみ。transport は loopback 以外と URL 内 credential を拒否(`client/transport.ts:17-24`)。token は Vite proxy が付与し、ブラウザに渡らない(規約どおり)。
- **音声パイプラインの並行制御が丁寧**(`web/src/domains/audio/controller/index.ts` ほか): DC offset 除去付き VAD、0.5 秒 pre-roll、playbackEpoch による stale decode 破棄、half-duplex gate + Bluetooth 向け 500ms tail、上限 2 の upload backpressure、置換 upload 成功後にのみ旧回答を取消。
- **SSE client が堅牢**(`client/events.ts`): `Last-Event-ID` 再開、45 秒 idle watchdog、64KB フレーム上限、指数 backoff、401/403/404 で再試行停止。
- **avatar の資源管理**: `own()` による GPU 資源追跡と dispose + `forceContextLoss()`(`model.js:32-48`)、idle 12fps / 移動 24fps 制限、dynamic import による 573KB chunk 分離、reduced-motion・context loss・WebGL2 なしへの対応。
- state 分離が規律的: server state は TanStack Query、Zustand は audio store 1 箇所のみ。Markdown は HTML escape + http(s)/mailto 限定で安全に描画(`markdownRenderer.ts:1-36`)。

### 弱み

1. **巨大コンポーネント**: `web/src/domains/settings/index.tsx` 2,073 行、`SettingsPage` 単体で約 1,600 行・`useState` 22 個。`useVoiceDialogue`(`voice-dialogue/hooks/index.ts`)は 480 行の ref + promise chain 編成で、明示的 state machine 化が望ましい。
2. **音声入力の脆さ**: deprecated な `ScriptProcessorNode`(main thread、`controller/index.ts:172`)で AudioWorklet なし。mic track の `ended`・`devicechange`・AudioContext 中断を未処理(機器抜去で「聞き取り中」のまま沈黙する可能性)。発話は 10 秒で強制分割。保存済み device 不在時は空メッセージの DOMException で無言失敗しうる。
3. **再読み上げ(replay)がパイプライン非統合**: `HTMLAudioElement` 使用(`replay.ts:54`)のため出力 device 設定と half-duplex gate を迂回し、ライブ再生と二重再生・自己認識の可能性。
4. **粗い cache invalidation と再描画**: SSE イベント・focus 変化のたびに全 query を invalidate(`App.tsx:152, 166`)、`refetchOnWindowFocus` と二重。音声 level が 200ms ごとに `Workspace` を再描画し、memo なしの `MessageList` が全メッセージの Markdown を毎回再 parse(会話が伸びるほど悪化)。
5. **衛生面**: tracked のまま残る `web/src/domains/settings/index.tsx-E`(sed -i -E の残骸 1,944 行、コミット `7678e17`)、未使用の `components/ui/Button.tsx`・`StatusBadge.tsx`、到達不能な artifact panel、client 応答の `as` キャスト多数(service-tests 7、settings 5 等)、`MessageList.tsx:6` と `client/voice-dialogue.ts:2` の barrel 経由 backend import、CLI の `api/infrastructure/auth-config` 直接 import。
6. **UX/a11y**: 日本語 UI に raw な英語 status・エラーコードが露出(`App.tsx:312, 512`、`setError(String(e))` 約 13 箇所)。`aria-live="polite"` が streaming 中のメッセージ一覧全体に付いており、読み上げ過多の可能性(`MessageList.tsx:24, 90-95`)。設定カテゴリが tablist でない。

## 5. セキュリティ

### 強み

- loopback 限定 bind(`server.ts:40-42`)、全 `/api/*` に bearer + Origin 厳密一致(`app.ts:72-95`)。
- API token は明示指定(24 文字以上)か、LARM token から HMAC-SHA256 で用途分離導出(`infrastructure/auth-config.ts`)。
- 外向き fetch は全箇所 `redirect: "error"` で、redirect 先への credential 転送を防止。
- **settings 暗号化は README の主張どおり**(`settings/service/index.ts:112-130`): AES-256-GCM、値ごとランダム 12B IV、鍵は `EUMENES_SECRET_KEY` か 0600/`wx` で生成する `keys/settings.key`、暗号文があるのに鍵がない場合は再生成せず停止(82-92)。
- **ログ衛生が強い**(`infrastructure/logger.ts`): 約 22 key の allowlist、256 文字上限、エラーは stack frame のみでメッセージ行を落とす、0600 + rotation。production コードに `console.*` なし(検証済み)。
- SQL は全箇所 `?` バインド。injectable な面は発見されず。

### 弱み・リスク

1. **`envRef` が denylist 方式**(`settings/contracts:28-37` は `LARM_*` 等のみ拒否): 認証済み client が任意のサーバー環境変数(例: `AWS_SECRET_ACCESS_KEY`)を cloud credential として指名し、client 指定の(平文 `http:` もありうる)baseUrl へ bearer として送信させられる。API token が前提のため remote hole ではないが、defense-in-depth の穴。allowlist + 非ローカル host への https 必須化が妥当。
2. **LARM bearer token が既定で平文 HTTP LAN を流れる**(既定 `http://192.168.0.130:9810`、`settings/contracts:191-207` は LAN の `http:` を許可)。
3. token 比較が plain `!==` で constant-time でない(`app.ts:93`。loopback 限定のためリスクは低い)。
4. JSON body にグローバルなサイズ上限がない(音声のみ 4MB 検査、`voice-dialogue/controller:11-23`)。
5. 暗号文に AAD(`id:epoch` への束縛)がなく、既定では鍵が DB と同じディレクトリに同居(DB 単体漏洩には有効、data ディレクトリ漏洩には無効)。

## 6. テスト・検証基盤

### 強み

- **密度と質**: 約 334 ケース + design-system 約 1,000。`queue/test/recovery.test.ts` は実子プロセスを SIGKILL して commit 済み job の生存を検査、`application/logging.test.ts` は実 backend を起動してログを検査、CLI は process 終了コードまで試験。`.skip`/`.only`/`.todo` ゼロ。
- **fixture の作り込み**: Playwright は実 backend + Vite + 372 行の LARM 偽サーバー(`scripts/larm-fixture-server.ts`、`holdNext` による stall 注入付き)を random port で起動し、合成マイクで 13 試験・159 expect。
- **verify.ts の設計**(208 行): 境界→format→lint→型→試験の順、per-domain の型依存閉包、`flock` による多重実行防止、**実行前後の全ソース SHA-256 比較**(並行編集された run を不合格扱いにした実績が acceptance.md にある)、`verification-reports/latest.json` 出力。
- **証跡の分離**: fixture / live / 実機を明確に区別し、未検証項目(実マイク3往復受入、再生中割込みの実機確認、実クラウド live 等)を正直に「未受入」と明記。live 検証は credential なしでは実行拒否し、ASR が「虹→二次」と誤認識した事実を精度合格と数えない等、自己欺瞞がない。

### 弱み

1. **CI なし + macOS 専用**: 全ゲートが開発者の Mac 上の手動実行。`verify.ts` と `sqlite/index.ts` が `/usr/lib/libSystem.B.dylib` を FFI で読むため、そのままでは Linux CI で動かない。
2. **verify:all の漏れ**: design-system の試験(約 1,079 件)と lint、decision-bench self-test が対象外。`--affected` は未実装。
3. **カバレッジ穴**: 2,073 行の settings 画面本体・`tts-dictionary/index.tsx`(419 行)・`App.tsx`(566 行)に unit test なし。coverage 計測ツール未設定。
4. **ドキュメントが引用する証跡が gitignore されている**: acceptance.md・README が参照する `verification-reports/*.json` はこのマシンにしか存在せず、clone では証跡リンクが壊れる(durable な証跡は `spec/reviews/*/evidence` のみ)。
5. 本日の `verify:all` はブラウザ fixture 1 件失敗(avatar canvas 未解放、`tests/browser/voice.spec.ts:199`)。未コミット変更由来か flake か要切り分け。

## 7. ドキュメント・プロセス

### 強み

- `docs/logging.md` は精密(field 表、10MiB×5 rotation、0600/0700、redaction 方針、未収集項目の明記)で、実装が実際に従っている。
- `docs/acceptance.md` は日付付き追記型ログで、不合格 run も含めて記録する誠実さがある。
- **spec/reviews/ のレビュー記録は監査可能**: findings(severity・file:line・回帰テスト付き)、修正前 baseline、全ソース SHA-256 snapshot、before/after 証跡ログ、較正付きスコア(62.7/100、48.9–70.9、Medium confidence)を「リリース認証ではない」と明記。ガードを一時除去して試験が落ちることを確認する negative control の記録もある。
- AGENTS.md の 7 規則(単一 writer、API 経由、証跡分離、「3往復受入まで MVP 完成を宣言しない」等)が acceptance.md の運用と一貫。

### 弱み

- **コミット衛生**: 11 コミットに最大 +45.7k 行(`0217eef`)。メッセージが広すぎ、branch/PR の痕跡なし、bisect 不能。現在も新 domain 丸ごと含む 28 変更が未コミット。
- **ドキュメント鮮度**: `docs/domains.md` は HEAD で `attitude-dataset`・`delivery` を欠き(working tree で追加済み)、`avatar`・`service-tests` は依然表にない。acceptance.md は追記型で現在状態のサマリがなく、先頭の状態表は 10-07 のまま。
- 独立した人間レビューの痕跡がない(レビュー記録は AI エージェント生成と推測される)。

## 8. 推奨アクション(優先順)

1. **CI の導入**(最優先): まず Linux で動く範囲(lint・typecheck・web vitest・design-system)だけでも GitHub Actions 化し、`verify.ts`/`sqlite/index.ts` の libSystem FFI を条件分岐してクロスプラットフォーム化する。
2. **コミット粒度の改善**: 未コミット 28 変更を論理単位で分割コミット。以後は機能単位の小さいコミットに。`web/src/domains/settings/index.tsx-E` を削除。
3. **セキュリティの2点**: `envRef` を allowlist 化 + 非ローカル host に https 必須。LARM への平文 LAN 接続のリスクを README に明記するか TLS 経路を用意。
4. **god module の分割**: `larm.connect`(約 370 行)と `inference.executeRequest`(約 430 行)、`SettingsPage`(約 1,600 行)、`useVoiceDialogue` の state machine 化。
5. **重複 infra の統合**: 有界 stream reader を `infrastructure/` の 1 実装に集約(drift 済みのため正しい方へ寄せる)、SSE 実装 3 系統の整理。
6. **境界 checker の補強**: `export … from`・動的 import・型 import の検査、layer 規則(web→api 内部、CLI→infrastructure)の追加。`MessageList.tsx:6` 等の barrel import を contracts 経由に修正。
7. **frontend の退行対処**: 本日失敗した avatar canvas 解放試験の切り分け、全 query invalidate の key 付き化、`MessageList` の memo 化、AudioWorklet への移行と device loss 処理。
8. **証跡の永続化**: acceptance.md が引用する検証証跡のうち要保存分を `spec/verification/` にコピーする運用に変更。
9. migration への checksum 導入、エラー→status 対応のコード表化、client 応答の Zod 検証統一。

## 制約・免責

- 本評価は静的読解と fixture ベースの検証実行に基づく。実機・実 LARM・実クラウドでの動作品質は評価していない(プロジェクト自身の区別に合わせ、ここも fixture 証跡である)。
- 推測と明記した項目(再描画コストの実害、queue errorCode 露出、aria-live の読み上げ挙動等)は実測していない。
- 未コミット変更を含む working tree 時点(HEAD `e2755c4` + 28 変更)の評価である。
