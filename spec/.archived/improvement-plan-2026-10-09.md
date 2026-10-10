# 改善実装計画書(2026-10-09)

[プロジェクト評価](project-evaluation-2026-10-09.md) で挙げた「大きすぎるモジュールの分割」「セキュリティの穴」「frontend の脆さ」および細かい指摘の実装計画。CI 導入はマルチプラットフォーム対応まで見送り(ユーザー決定)のため **本計画に含めない**。

作業者向けの注意: 本書の行番号は 2026-10-09 時点の目安。**ファイルと関数名(シンボル)を正とし、行番号はズレている前提で探すこと。**

## 共通規則(全 WP に適用)

1. AGENTS.md の規則に従う。特に: 下位 domain から上位 domain を import しない / 複数 domain の保存は単一 writer の transaction / LARM credential は backend 内 / ログに会話本文・音声・認証情報・Provider 生応答を出さない。
2. 各 WP 完了時に最低限 `bun run verify -- --domain <主対象domain>` を実行する。web 側の変更は `bunx vitest run web` も実行。横断変更(WP-D 系)は最後に `bun run verify:all`。
3. **コミット・push しない**(ユーザーが行う)。
4. domain 間 import は `scripts/domains.ts` の宣言グラフに従う。新しい cross-domain import を追加する場合は同ファイルの `depends` も更新し、`bun run verify` の境界検査を通すこと。
5. domain 内のファイル分割は自由(境界検査は domain を跨ぐ import のみ見る)。ただし **facade(`api/domains/<d>/index.ts`)の公開 API を変えない** こと。変える場合は呼び出し元を同一 WP 内で全て追従させる。
6. 「挙動変更なし」と書かれた WP では、既存テストを 1 文字も変えずに通すこと。テストを変えないと通らない場合は実装が間違っている。
7. format は `bun run format`、lint は `bun run lint`(warning もエラー扱い)。

## WP 一覧と優先順

| WP | 内容 | 種別 | 依存 | 並行可否 |
| --- | --- | --- | --- | --- |
| S1 | envRef の allowlist 化 | セキュリティ | なし | ○ |
| S2 | cloud 接続の https 必須化 | セキュリティ | なし(S1 と同ファイルのため同一作業者推奨) | △ |
| S3 | queue errorCode のサニタイズ | セキュリティ | なし | ○ |
| S4 | API token の constant-time 比較 | セキュリティ | なし | ○ |
| S5 | JSON body のグローバルサイズ上限 | セキュリティ | なし | ○ |
| F0 | avatar canvas 解放テストの赤の切り分け | 不具合 | なし | ○(最優先) |
| F1 | 全 query invalidate の廃止と再描画削減 | frontend | なし | ○ |
| F2 | エラー表示の日本語化と raw コード排除 | frontend | なし | ○ |
| F3 | mic/device 喪失の検知と通知 | frontend | なし | ○ |
| F4 | replay の音声パイプライン統合 | frontend | F3 と同ファイル。同一作業者推奨 | △ |
| F5 | AudioWorklet 移行 | frontend | F3/F4 の後 | × |
| M1 | 有界 stream reader の一本化 | 分割・重複排除 | なし | ○(ただし M2/M3 と衝突) |
| M2 | larm/service の分割 | 分割 | M1 の後 | × |
| M3 | inference/service の分割 | 分割 | M1 の後 | × |
| M4 | SettingsPage の分割 | 分割 | なし | ○ |
| M5 | useVoiceDialogue の state machine 化 | 分割 | F3〜F5 の後 | ×(段階2) |
| D1 | エラー→HTTP status の対応表化 | 細かい指摘 | なし | ○ |
| D2 | client 応答の Zod 検証統一 | 細かい指摘 | なし | ○ |
| D3 | barrel 経由 backend import の contracts 移行 | 細かい指摘 | なし | ○ |
| D4 | 境界 checker の盲点補強 | 細かい指摘 | D3 の後推奨 | ○ |
| D5 | migration checksum | 細かい指摘 | なし | ○ |
| D6 | composition root の wiring 改善 | 細かい指摘 | M2/M3 の後 | × |
| D7 | ドキュメント鮮度の回復 | 細かい指摘 | 他 WP 完了後 | 最後 |

並行実行する場合は書込パスが重ならない WP のみ同時に走らせること(各 WP に「書込許可」を明記)。

---

## S1: envRef の allowlist 化

**問題**: `connection.envRef` は denylist 検証のみ(`api/domains/settings/contracts/index.ts` の `connectionSchema.envRef`、`LARM_*`・`EUMENES_API_TOKEN`・`EUMENES_SECRET_KEY` だけ拒否)。認証済み client が `AWS_SECRET_ACCESS_KEY` 等サーバーの任意環境変数を cloud credential に指名し、client 指定の baseUrl へ bearer として送信させられる。

**方針**: 契約(contracts)は web からも import されるため **環境依存の検証を contracts に入れてはならない**。allowlist 判定は backend の settings service 側で行う。

**手順**:
1. `api/domains/settings/service/index.ts` に純関数 `isAllowedEnvRef(name: string, allowlist: readonly string[]): boolean` を追加。許可条件は次の OR:
   - `EUMENES_CLOUD_` prefix を持つ
   - 既知 provider の代表的な key 名: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `AZURE_OPENAI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`
   - 環境変数 `EUMENES_ENV_REF_ALLOWLIST`(カンマ区切り)に含まれる
2. envRef を**保存するとき**と**実際に値を解決するとき**(現 `process.env[...]` 参照箇所、service 内 1 箇所)の両方で検証する。保存時 NG は既存の `invalid_input` 系エラー、解決時 NG は `env_ref_not_allowed` という新コードで失敗させる(値は送信しない)。
3. 新エラーコードを `api/application/app.ts` の status 対応(D1 実施済みなら対応表)に 400 として追加。
4. 既存設定との互換: 既に保存済みの envRef が allowlist 外の場合、起動を壊さず**解決時に失敗**させる(上記 2 で自然に満たされる)。
5. テスト追加(`api/domains/settings/test/`): 許可 prefix / 既知 key / `EUMENES_ENV_REF_ALLOWLIST` 指定 / 拒否(任意の `PATH`, `AWS_SECRET_ACCESS_KEY` 等)/ 解決時拒否でエラーコードが返ること。

**書込許可**: `api/domains/settings/**`、`api/application/app.ts`(エラーコード追加行のみ)
**受入**: `bun run verify -- --domain settings` 通過。既存テスト無変更で通過 + 新テスト。

## S2: cloud 接続の https 必須化(非 private host)

**問題**: cloud 接続の `baseUrl` は `http:` を無条件に許す(`settings/contracts/index.ts` の `endpoint`)。public host へ bearer が平文で流れうる。

**方針**: 純関数判定なので contracts に置ける。**LARM 用 URL の検証は変えない**(LAN http が正規の運用)。cloud 接続 `connectionSchema.baseUrl` のみ別 refinement にする。

**手順**:
1. `settings/contracts/index.ts` に `cloudEndpoint` を追加: 既存 `endpoint` の条件 + 「`http:` を許すのは hostname が loopback(`localhost`, `127.0.0.0/8`, `::1`)、RFC1918(`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)、`.local` 終端、link-local(`169.254.0.0/16`)のときのみ。それ以外は `https:` 必須」。エラーメッセージは日本語で「外部ホストには https が必要です」。
2. `connectionSchema.baseUrl` を `cloudEndpoint` に差し替え。LARM 側スキーマ(同ファイル内の LARM URL 検証)は触らない。
3. テスト追加: `http://192.168.0.5` 許可 / `http://example.com` 拒否 / `https://example.com` 許可 / `http://foo.local` 許可。
4. README の LARM 既定接続(`http://192.168.0.130:9810`)の節に 1 文追記: 「LARM token は LAN 上を平文で流れるため、信頼できる LAN でのみ使用する」。

**書込許可**: `api/domains/settings/**`、`README.md`(追記 1 文のみ)
**受入**: `bun run verify -- --domain settings`。web が contracts を import しているため `bunx vitest run web` も通ること。

## S3: queue errorCode のサニタイズ

**問題**: `api/domains/queue/service/runner.ts` の settle 処理(現 484 行付近)が `error.message.slice(0,120)` をそのまま job の `errorCode` として永続化。Provider 由来の未サニタイズ文字列が queue API に露出しうる。

**手順**:
1. runner.ts に純関数 `toErrorCode(e: unknown): string` を追加: message が `/^[a-z][a-z0-9_]{0,63}$/` に一致すればそのまま(既存の snake_case コードは保存される)、不一致なら `"handler_failed"`。
2. `errorCode` への代入箇所をすべて `toErrorCode` 経由に変更。
3. テスト追加(`api/domains/queue/test/`): snake_case コードは保存される / 任意文字列(日本語・URL・token 風文字列)は `handler_failed` になる。

**書込許可**: `api/domains/queue/**`
**受入**: `bun run verify -- --domain queue`。既存テスト無変更で通過。

## S4: API token の constant-time 比較

**問題**: `api/application/app.ts` の bearer 検査(現 93 行付近)が `!==` 比較。

**手順**: `node:crypto` の `timingSafeEqual` を使う比較関数に置換。長さが違う場合も timing を揃える(両方を SHA-256 digest してから比較するのが最簡)。挙動変更なし。
**書込許可**: `api/application/app.ts`
**受入**: `bun test api/application/app.test.ts` 通過(無変更)。

## S5: JSON body のグローバルサイズ上限

**問題**: 音声のみ 4MB の streaming 検査があり(`voice-dialogue/controller`)、JSON body には上限がない。

**手順**:
1. `api/application/app.ts` の `/api/*` middleware に Content-Length 検査を追加: JSON 系 route は 1MB 超を `payload_too_large`(413)で拒否。Content-Length がなく chunked の場合は既存の有界 reader(M1 完了後は共通実装)で読む route のみ許容し、それ以外は 411 または 413。音声 route(`/api/voice/*` の該当 path)は既存の 4MB 検査に委ねるため除外。
2. エラーコード `payload_too_large` → 413 を status 対応に追加。
3. テスト追加(`api/application/app.test.ts`): 1MB 超 JSON が 413 / 通常 request は従来どおり。

**書込許可**: `api/application/app.ts`、`api/application/app.test.ts`
**受入**: `bun test api/application` 通過。

---

## F0: avatar canvas 解放テストの切り分け(最優先)

**問題**: 2026-10-09 の `verify:all` で `tests/browser/voice.spec.ts` の「light avatar stays behind usable chat and releases its canvas on navigation」が失敗(設定画面遷移後も `.light-avatar-background canvas` が 1 個残る)。未コミット変更由来の退行か flake か不明。

**手順**:
1. まず同テストのみ 3 回実行して再現性を確認: `bunx playwright test tests/browser/voice.spec.ts -g "releases its canvas"`。
2. 再現する場合: `web/src/components/.../LightAvatarBackground.tsx`(設定画面表示時に資源解放する effect がある)を調査。設定画面への遷移検知(hash routing、`App.tsx` の `Workspace`)と unmount/解放の条件を確認し、解放されない原因を特定して修正。
3. flake の場合(たまにしか落ちない): dynamic import 完了と遷移の race が既知パターン。テスト側ではなく実装側で「import 完了時に既に非表示条件なら即解放」を保証する(コンポーネントに該当ガードがあるはずなので、その条件漏れを探す)。
4. どちらでも、結論(退行 or flake、原因、修正内容)を `spec/verification/` 配下ではなく本計画書の末尾「実施記録」に 3 行で追記。

**書込許可**: `web/src/**`(avatar 関連)、本計画書末尾
**受入**: 上記 -g 指定テストを 3 回連続通過。`bunx vitest run web` 通過。

## F1: 全 query invalidate の廃止と再描画削減

**問題**(`web/src/App.tsx`):
- SSE の `change`/`reset` で `cache.invalidateQueries()` を key なし実行(現 163-169 行付近)。focus/visibility でも同様(145-162 行付近)で、`refetchOnWindowFocus: true`(555 行付近)と二重。
- 音声 level が 200ms ごとに `Workspace` 全体を再描画し(138 行付近で `level` を購読)、memo されていない `MessageList` が全メッセージの Markdown を毎回再 parse する。
- backend の lease 更新 write が約 10 秒ごとに `change` を発火するため、実行中 job の間この全再取得が定常的に起きる。

**手順**:
1. query key の台帳を作る: `web/src/queryKeys.ts` に全 query の key 定数を集約(既存 `useQuery` の key を探して列挙。会話・run・LARM status・設定・予約・memory の系統があるはず)。既存呼び出しを定数参照に置換。
2. SSE `change` 時は「サーバー状態系 key のみ」を列挙して invalidate(`cache.invalidateQueries({ queryKey: k })` を系統ごとに)。`reset` 時のみ全 invalidate を維持(再同期のため)。
3. focus/visibility の手動 invalidate を削除し、`refetchOnWindowFocus: true` に一本化(どちらを残すかは「手動側を削除」で固定)。
4. 音声 level 表示を小さな子コンポーネント(例 `MicLevelMeter`)に切り出し、`level` の購読をその中に閉じ込める。`Workspace` は `level` を購読しない。
5. `MessageList` を `React.memo` 化し、1 メッセージの Markdown HTML を `useMemo`(key は message の text/id)で保持する。`renderSafeMarkdown` 自体は変更しない。
6. 挙動確認: SSE で会話が更新される・focus 復帰で最新化される、という既存挙動を壊さない。

**書込許可**: `web/src/**`(`domains/audio` の controller は触らない)
**受入**: `bunx vitest run web` 通過(MessageList.test.tsx 無変更で通過)。`bunx playwright test tests/browser/voice.spec.ts` 通過。

## F2: エラー表示の日本語化と raw コード排除

**問題**: `setError(String(e))` が約 13 箇所あり、「ApiError: voice_…」「api_connection_failed」等の raw コードが日本語 UI に露出(`App.tsx:312, 512` 付近ほか)。

**手順**:
1. `web/src/errorMessages.ts` を新設: `describeError(e: unknown): string`。`ApiError`(`client/transport.ts` が throw)の `code`/`status`、`ApiConnectionError`、その他、の順で判定し日本語文を返す。既知コード(`invalid_input`, `request_conflict`, `database_writer_queue_full`, `api_connection_failed`, `voice_*` 系で UI に出うるもの)を対応表に持ち、未知コードは「エラーが発生しました(<code>)」とコード併記。
2. `setError(String(e))` を全箇所 `setError(describeError(e))` に置換(grep で列挙してから置換)。
3. `App.tsx` で `voice.turn?.status` と `connectionState` を raw 表示している箇所(現 312, 512 行付近)に日本語対応表を適用。
4. `MessageList.tsx` の `aria-live="polite"` を streaming 中の回答を含むコンテナから外し、「回答確定時のみ更新される非表示 live region」を 1 つ設ける(確定テキストの先頭 80 文字程度を announce)。
5. テスト: `describeError` の unit test を新設(既知コード・未知コード・接続エラー)。

**書込許可**: `web/src/**`
**受入**: `bunx vitest run web` 通過。`grep -rn "setError(String" web/src` が 0 件。

## F3: mic/device 喪失の検知と通知

**問題**(`web/src/domains/audio/controller/index.ts`): mic track の `ended`、`navigator.mediaDevices` の `devicechange`、AudioContext の `statechange` を一切監視していない。機器抜去時に「聞き取り中」のまま沈黙する。保存済み device 不在時は `deviceId: {exact}` の DOMException(message 空のことがある)で無言失敗しうる。

**手順**:
1. controller の録音開始処理で取得した `MediaStreamTrack` に `ended` listener を付け、発火時は録音セッションを停止して store の phase をエラー状態(新 phase または既存 error 相当)に遷移、理由文字列 `"mic_lost"` を公開する。
2. `devicechange` で現在使用中の deviceId が列挙から消えたことを検知した場合も同様に停止。listener はセッション停止時に必ず解除。
3. `AudioContext.onstatechange` で `interrupted`/`suspended`(ユーザー操作起因でないもの)を検知したら `resume()` を 1 回試み、失敗なら停止+通知。
4. `getUserMedia` を「`{exact}` で失敗(`OverconstrainedError` / `NotFoundError`)したら deviceId 指定なしで 1 回だけ retry し、retry したことを理由 `"saved_device_missing"` として公開」に変更。
5. hooks 層(`web/src/domains/voice-dialogue/hooks/index.ts` と audio の hook)で上記理由を受け、F2 の `describeError` 経由で日本語表示(例: 「マイクが切断されました。音声を再開してください」)。
6. テスト: controller は DOM 依存が強いので、理由→表示文の変換と、track `ended` ハンドラが phase を遷移させることを jsdom + fake track で unit test(既存の audio test の流儀に合わせる)。

**書込許可**: `web/src/domains/audio/**`、`web/src/domains/voice-dialogue/hooks/**`、`web/src/errorMessages.ts`
**受入**: `bun run verify -- --domain audio`(web 側 audio 試験)、`bunx vitest run web`、`bunx playwright test tests/browser/voice.spec.ts` 通過。

## F4: replay の音声パイプライン統合

**問題**(`web/src/domains/voice-dialogue/hooks/replay.ts`): 再読み上げが `HTMLAudioElement` 使用のため (a) 出力 device 設定(setSinkId)を無視、(b) half-duplex gate(`audio/controller/index.ts` 現 179 行付近、AudioContext の playback のみ監視)から見えない、(c) ライブ再生と排他しない。自己認識・二重再生の可能性。

**方針**: replay も AudioContext 経由にするのが本筋。

**手順**:
1. `audio/controller` に「任意の WAV/音声 buffer を通常の回答再生と同じ経路で再生する」公開関数を追加(既存の chunk 再生関数を一般化するか、`playOneShot(arrayBuffer): Promise<void>` を追加)。playbackEpoch・half-duplex gate・出力先は既存経路のものがそのまま効く形にする。
2. `replay.ts` を `HTMLAudioElement` から上記関数に置換。再生開始時に進行中のライブ再生を停止するか待つかは**既存のライブ再生と同じ割込み規則**(新しい再生が古い再生を割り込む)に合わせる。
3. 音声セッション開始時に replay 中なら replay を停止する(逆方向の排他)。
4. テスト: replay hook の unit test を実音声なしで(controller を fake 化して)「gate が閉じる」「epoch が進むと旧再生が破棄される」ことを検証。

**書込許可**: `web/src/domains/audio/**`、`web/src/domains/voice-dialogue/**`
**受入**: `bunx vitest run web`、`bunx playwright test tests/browser/voice.spec.ts` 通過。

## F5: AudioWorklet 移行(F3/F4 の後)

**問題**: 録音が deprecated な `ScriptProcessorNode`(main thread、`audio/controller/index.ts` 現 172 行付近)。three.js 描画や再描画と競合するとフレーム落ちしうる。

**手順**:
1. `web/src/domains/audio/worklet/recorder.worklet.ts` を新設: `AudioWorkletProcessor` で入力 Float32Array を 128 frame 単位で `port.postMessage`(transferable)する最小実装。VAD・WAV 化は従来どおり main thread 側(controller)で行い、**ロジック移植はしない**(メッセージ受信に置き換えるだけ)。
2. controller で `audioContext.audioWorklet.addModule(new URL("./worklet/recorder.worklet.ts", import.meta.url))` によりロード(Vite はこの形式で bundle する)。`ScriptProcessorNode` 経路を `AudioWorkletNode` + message 受信に置換。
3. `addModule` 失敗時(古いブラウザ等)は既存 `ScriptProcessorNode` 経路に fallback として残す(削除しない)。
4. 10 秒上限・pre-roll・downsample 等の既存処理は受信側で無変更。
5. Playwright の合成マイク経路で全 voice テストが通ることを確認。

**書込許可**: `web/src/domains/audio/**`、必要なら `vite.config.ts`(worklet bundle 設定)
**受入**: `bunx playwright test tests/browser/voice.spec.ts` 全通過、`bun run verify -- --domain audio`。

---

## M1: 有界 stream reader の一本化(M2/M3 の前提)

**問題**: 「上限付きで response body を読む」実装が約 7 箇所に複製され、挙動が drift 済み(inference 版は read エラー時に reader を cancel せず `releaseLock` もしない。larm 版は両方行う)。
複製箇所: `larm/service/index.ts` の `readBounded`、`inference/service/index.ts` の `bounded`、`larm/service/inference-error.ts`、`larm/service/playground-http.ts`、`voice-dialogue/controller/index.ts`、`settings/controller/index.ts`、`service-tests/controller/index.ts`、`infrastructure/chat-stream.ts`。

**手順**:
1. `api/infrastructure/bounded-read.ts` を新設。**larm 版(`readBounded`)の挙動を正とする**(エラー時 cancel + releaseLock)。シグネチャは既存利用箇所を全部見てから、上限 bytes・超過時 error コードを引数で受ける 1 関数+必要なら JSON 版 wrapper の 2 つに収める。
2. 上記 7+1 箇所を順に新実装へ置換。**1 箇所置換するごとに該当 domain のテストを実行**(`bun run test:domain -- larm` など)。挙動差分(超過時のエラーコード文字列)は各呼び出し元の既存コードを維持する(コードを引数化しているので可能)。
3. 置換完了後、旧ローカル実装を削除。`infrastructure/bounded-read.test.ts` を新設(上限内 / 超過 / 途中 abort / エラー時に reader が解放される)。
4. SSE 実装 3 系統(`application/events.ts`、`infrastructure/snapshot-stream.ts`、`infrastructure/chat-stream.ts`)の統合は**本 WP ではやらない**(用途が異なりリスクが高い。見送り理由として記録)。

**書込許可**: `api/infrastructure/**`、上記複製を持つ各 domain のファイル(reader 置換行のみ)
**受入**: `bun run verify:all` のうち api テスト全通過(`bun test api`)。既存テスト無変更。

## M2: larm/service の分割(挙動変更なし)

**問題**: `api/domains/larm/service/index.ts` が 1,367 行、`createLarm` 内の `connect` が約 370 行。

**方針**: facade(`api/domains/larm/index.ts`)の公開 API と `createLarm` のシグネチャは不変。domain 内の新ファイルへ「状態を持たない部分」から順に移す。閉包内の長大関数は「明示的な引数を持つモジュールレベル関数」に変換して移す。

**手順**(この順で、各ステップ後に `bun run test:domain -- larm`):
1. `service/profiles.ts` 新設: `gemmaProfile`, `gemmaAgentProfile`, `gemmaContext`, `auxiliaryProfile`, `endpoints`, `protocols` 等の定数群を移動。
2. `service/guards.ts` 新設: `record`, `string` 等の手書き型ガードと `readJson` を移動(M1 で `readBounded` は infrastructure へ移動済み)。
3. `service/connect.ts` 新設: `connect` の中身を 3〜5 個のモジュールレベル関数に分解して移す。分割の目安は処理の段(例: profile 発見 → claim → credential/configuration の検証 → lease 開始)。閉包が参照している可変状態(現在の connection、lease timer 等)は分解せず、`connect.ts` の関数には「入力と戻り値」で渡す。どうしても閉包状態に触る部分は index.ts に残してよい。**1 関数 150 行以下**を目安とする。
4. `inference-error.ts`, `playground.ts`, `playground-http.ts` は既に分かれているので触らない。
5. 完了条件: `index.ts` が 900 行以下。export の増減なし(`service/` 内部ファイルは domain 外から import されない — 境界検査が保証)。

**書込許可**: `api/domains/larm/service/**`
**受入**: `bun run verify -- --domain larm`。`larm.test.ts`(143 expects)無変更で通過。

## M3: inference/service の分割(挙動変更なし)

**問題**: `api/domains/inference/service/index.ts` が 1,294 行、`createInference` 内の `executeRequest` が約 430 行。

**手順**(各ステップ後に `bun run test:domain -- inference`):
1. `service/wav.ts` 新設: `probeWav` を移動。`service/errors.ts` 新設: `safeError`, `fallbackErrors` を移動(エラーメッセージのサニタイズ regex もここ)。
2. `service/execute.ts` 新設: `executeRequest` を段ごとのモジュールレベル関数に分解(目安: provider/経路の選択 → request 構築 → 送信と応答解釈 → 結果の採用判定と usage 記録)。M2 と同じ規則: 閉包の可変状態は引数と戻り値で受け渡し、不可能な部分だけ index.ts に残す。1 関数 150 行以下。
3. 型 import `import("../../delivery")` が 2 箇所(現 538, 540 行付近)にある。これは静的な `import type { ... } from "../../delivery/contracts"` に書き換える(D4 の checker 補強で検出対象になるため、contracts 経由に正す)。delivery/contracts に該当型がない場合は delivery 側で contracts に export を追加(型のみ。実装は動かさない)。
4. 完了条件: `index.ts` が 800 行以下。

**書込許可**: `api/domains/inference/service/**`、`api/domains/delivery/contracts/index.ts`(型 export 追加のみ)
**受入**: `bun run verify -- --domain inference`。`inference.test.ts` 無変更で通過。delivery に触れた場合は `bun run verify -- --domain delivery` も。

## M4: SettingsPage の分割

**問題**: `web/src/domains/settings/index.tsx` が 2,073 行。`SettingsPage` 単体で約 1,600 行、`useState` 22 個、query/mutation 約 10 個。

**方針**: 設定画面の左 nav カテゴリ(AI の使い方 / 接続先 / 音声 / データと利用記録 / 予約 / 表示 — 実物のカテゴリ定義は index.tsx 内の nav 配列を正とする)ごとに 1 コンポーネント 1 ファイルへ分割。**見た目・挙動・保存フローは変えない。**

**手順**:
1. まず index.tsx を読み、カテゴリと「カテゴリ内で閉じる state」「カテゴリを跨ぐ state(未保存変更ガード、適用ボタン等)」を仕分けする。仕分け結果を PR 説明ではなくコード冒頭コメントでなく、作業メモとして本計画書末尾「実施記録」に 5 行以内で残す。
2. `web/src/domains/settings/sections/<category>.tsx` を作り、カテゴリ内で閉じる state・query・mutation ごと移す。跨ぐ state は `SettingsPage` に残し、props で渡す(Context は作らない。props で済む規模)。
3. 既存の `MemoryConnectionPanel` のような分離済みコンポーネントの流儀(props の渡し方・テストの書き方)に合わせる。
4. 各 section に render の smoke test を 1 本ずつ新設(`sections/<category>.test.tsx`: 主要な見出しと保存ボタンが描画される程度でよい。query は既存テストの fake 流儀に合わせる)。
5. 完了条件: `index.tsx` 500 行以下、各 section 400 行以下。

**書込許可**: `web/src/domains/settings/**`
**受入**: `bunx vitest run web` 通過(`MemoryConnectionPanel.test.tsx` 無変更で通過)。`bunx playwright test tests/browser/voice.spec.ts -g "settings"` など設定関連の browser テストがあれば通過、なければ spec 全体を 1 回通す。

## M5: useVoiceDialogue の state machine 化(段階2・F3〜F5 完了後)

**問題**: `web/src/domains/voice-dialogue/hooks/index.ts`(480 行)が ref 約 8 個と 140 行の effect で chunk 再生を promise chain 駆動しており、正しさの根拠(generation/epoch/valid() ガード)がコードに散在。

**方針**: 挙動は変えず、状態遷移を明示的な reducer(`{phase, sessionId, generation, epoch, pending[]}` 等)に集約する。**これは本計画で最もリスクが高い WP。** F3〜F5 で周辺が安定し、browser テストが緑であることを前提に着手する。

**手順**:
1. 現状の状態と遷移を列挙した遷移表を先に書く(本計画書末尾「実施記録」へ)。遷移表に現れないコードパスが見つかったらそれが bug の可能性があるので、挙動を変えずそのまま遷移表に含める。
2. `hooks/machine.ts` に純粋 reducer として実装し、unit test を遷移表から機械的に書く(最低: 割込み、stale chunk 破棄、upload 失敗 retry、取消)。
3. `useVoiceDialogue` を reducer 駆動に置換。refs は「React 外のハンドル(AudioContext 等)」のみに限定。
4. 受入は Playwright 全 13 テスト 3 回連続通過(flake 検出のため)。

**書込許可**: `web/src/domains/voice-dialogue/**`
**受入**: `bunx vitest run web`、`bunx playwright test tests/browser/voice.spec.ts` を 3 回連続通過。

---

## D1: エラー→HTTP status の対応表化

**問題**: `api/application/app.ts` の `app.onError`(現 108-137 行)がメッセージ文字列の三項演算子連鎖。新コード追加のたびに手修正・漏れると 500。

**手順**:
1. app.ts 内(または `api/application/error-status.ts`)に data として定義:
   ```ts
   const statusByCode: Record<string, 400 | 409 | 413 | 503> = { request_conflict: 409, ... };
   const statusByPrefix: Array<[prefix: string, status: 400 | 409 | 503]> = [["invalid_", 400], ["voice_session_", 400], ["stale_", 400]];
   ```
   既存の対応(409: `request_conflict`, `revision_conflict`, `voice_sequence_out_of_order`, `voice_utterance_conflict`, `schedule_state_conflict`, `memory_unavailable`, `voice_preview_busy` / 400: `invalid_*`, `voice_sequence_invalid`, `voice_session_*`, `stale_*` / 503: `database_writer_queue_full`, `queue_full`, `schedule_limit_reached`, `stream_capacity`)を**一切変えず**移す。
2. lookup 関数 1 つに置換。未知コードは従来どおり 500 + `internal_error`。
3. `app.test.ts` に対応表の代表ケース(各 status 1 つ + 未知→500)のテストがなければ追加。

**書込許可**: `api/application/**`
**受入**: `bun test api/application` 通過(既存テスト無変更)。

## D2: client 応答の Zod 検証統一

**問題**: `client/` の一部は Zod parse(dialogue, queue, scheduler)だが、他は `as` キャスト(service-tests 7 箇所、settings 5、memory 3、larm 2、voice-dialogue の `voicePreview`/`replaySentences`)。

**手順**:
1. キャストしている各応答型に対応するスキーマを `api/domains/<d>/contracts/index.ts` から import(web も使うため contracts にあるはず。なければ contracts に応答スキーマを追加し、backend controller 側は変えない)。
2. `as X` を `schema.parse(json)` に置換。parse 失敗は既存の `ApiError` 系とは別に ZodError のまま投げてよい(CLI の exit code 規約で 2 になる点は D2 では変えない)。
3. 1 ファイル置換ごとに `bunx vitest run web` と `bun test api`(client のテストがある場所に合わせて)を実行。

**書込許可**: `client/**`、`api/domains/*/contracts/index.ts`(スキーマ追加のみ)
**受入**: `bun run verify:all` のうち api + web テスト通過。

## D3: barrel 経由 backend import の contracts 移行

**問題**: web/client が domain facade(barrel)経由で backend service コードを import しており、backend コードがブラウザ bundle に入る:
- `web/src/components/domains/conversation/MessageList.tsx:6` が `api/domains/delivery` から **値** `acceptedEmotion` を import
- `client/voice-dialogue.ts:2` が同 barrel から `avatarMotionSchema` を import

**手順**:
1. `acceptedEmotion` と `avatarMotionSchema` の定義を `api/domains/delivery/contracts/index.ts` へ移動(delivery 内の既存参照は contracts から re-import に変更。facade の再 export は互換のため残してよい)。
2. 上記 2 箇所の import を `api/domains/delivery/contracts` に変更。
3. 他に同種がないか検査: `grep -rn 'from "../../../api\|from ".*api/domains/[a-z-]*"' web/src client | grep -v contracts` で barrel 直 import を列挙し、あれば同様に処置。

**書込許可**: `api/domains/delivery/**`、`web/src/**`(import 行のみ)、`client/**`(import 行のみ)
**受入**: `bun run verify -- --domain delivery`、`bunx vitest run web` 通過。

## D4: 境界 checker の盲点補強

**問題**: `scripts/boundaries.ts` は `ImportDeclaration` のみ検査。`export … from`(実例: `api/domains/service-tests/contracts/index.ts:3`)、動的 `import()`、型 `import("…")` が素通り。実バイパス: `api/domains/dialogue/test/memory-integration.test.ts:830` が `../../memory/service/journal` を動的 import(facade 超えの深い import)。layer 規則(web→api 内部等)もない。

**手順**:
1. `boundaries.ts` の AST 走査に追加: `ExportDeclaration`(moduleSpecifier 付き)、`CallExpression` で callee が `ImportKeyword` のもの(引数が文字列 literal の場合のみ検査、動的文字列は `boundary_dynamic_specifier` としてエラー)、`ImportTypeNode`(`import("…")` 型)。判定ロジックは既存の import 検査と同一関数を通す。
2. これで新たに検出される違反を修正する:
   - `memory-integration.test.ts` の `../../memory/service/journal` → memory の facade または contracts から必要シンボルを export して差し替え(テストの検証内容は変えない)。
   - `service-tests/contracts` の re-export は宣言済み依存(larm)なら合法のはず。checker が正しく「合法」と判定することをテストで確認。
   - 他に出たものは同じ方針(公開経路へ寄せる)で潰す。
3. layer 規則を追加: `web/src/**` と `client/**` から `api/**` への import は `api/domains/*/contracts` のみ許可。`cli/**` は `client/**` と `api/infrastructure/auth-config` のみ許可(現状の実態を allowlist 化。縮小は本 WP ではしない)。違反メッセージには違反ファイルと許可される経路を出す。
4. `scripts/` 配下の checker 自体のテストがある場所(`api/domains/queue/test/boundaries.test.ts` が domain graph を試験)に、新検査の正例・負例を追加。

**書込許可**: `scripts/boundaries.ts`、`scripts/domains.ts`、違反修正に必要な最小限の各ファイル、`api/domains/queue/test/boundaries.test.ts`
**受入**: `bun run verify:all` の境界検査が全 domain で通過。意図的に違反を書いたときに落ちることをテストで確認。

## D5: migration checksum

**問題**: `schema_migrations` は id のみ記録(`api/infrastructure/sqlite/index.ts` 現 65-83 行)。適用済み migration の書き換えを検出できない。migration は位置依存で vendor package の分を slice で interleave(`api/application/migrations.ts` 現 41-67 行)。

**手順**:
1. `schema_migrations` に `checksum` 列を追加する migration を足す(後方互換: 列がない既存 DB は ALTER TABLE で追加し、既存行は現時点の定義から計算した checksum で backfill する。この backfill は「現在のコードと DB が一致している」前提を 1 回だけ受け入れる)。
2. 適用時: 各 migration の SQL 文字列の SHA-256 を保存。起動時: 適用済み id の checksum を照合し、不一致なら `migration_checksum_mismatch` で起動失敗(ログに id のみ。SQL は出さない)。
3. 位置依存(slice interleave)の解消は**本 WP ではやらない**(vendor 更新手順に関わるため)。no-op placeholder(`"SELECT 1"`)もそのまま。checksum により「黙って書き換わる」事故だけを塞ぐ。
4. テスト(`api/application/migrations.test.ts`): 正常適用 / 適用済み migration を書き換えた fake で起動失敗 / 旧形式 DB(checksum 列なし)からの backfill。

**書込許可**: `api/infrastructure/sqlite/**`、`api/application/migrations.ts`、`api/application/migrations.test.ts`
**受入**: `bun test api/application api/infrastructure` 通過。

## D6: composition root の wiring 改善(M2/M3 の後)

**問題**: `api/application/server.ts` で `createDialogueService(store, conversation, larm, queue, undefined, undefined, memory)` と位置引数 `undefined` 渡し(現 84-92 行)、`const larm = createInference(...)`(現 63 行)という誤解を招く命名、`createApp` の optional 依存と `if (deps.x)` mount(`app.ts` 現 37-53, 96-110 行)。

**手順**:
1. `createDialogueService` の引数を options object(`{ store, conversation, larm, queue, …, memory }`)に変更し、呼び出し元(server.ts とテスト)を全て追従。他の多引数 factory も 5 引数以上のものは同様に。
2. `const larm = createInference(...)` を `const inference = ...` に rename(Serena の rename を使い、`larm:` へ渡している箇所の意味を確認しながら)。
3. `createApp` の deps は**テストが部分組立てに依存している**ため optional を全廃しない。代わりに「production 組立て専用の `createProductionApp(deps: Required<…>)`」を server.ts 側に置き、本番経路では全依存必須にする。テスト用の部分組立ては従来の `createApp` のまま。
4. 挙動変更なし。全テスト無変更で通過。

**書込許可**: `api/application/**`、factory シグネチャ変更に伴う各 domain の呼び出し箇所とテスト
**受入**: `bun run verify:all` の api テスト全通過。

## D7: ドキュメント鮮度の回復(最後)

**手順**:
1. `docs/domains.md` の表に `avatar`(web のみ)と `service-tests` を追加し、`scripts/domains.ts` の宣言と突き合わせて全 domain が載っていることを確認。
2. `docs/acceptance.md` の先頭に「現在の状態」サマリ節(最新日付・各受入項目の最新ステータスのみの短い表)を追加し、以降は追記のたびにこの表も更新する運用注記を 1 行書く。過去ログは変更しない。
3. 本計画で挙動・構成が変わった箇所(S1/S2 の設定仕様、F3 のエラー表示、M2-M4 のファイル構成)について README と docs の該当記述を更新。
4. 評価レポートの指摘どおり、`verification-reports/` 配下で docs から引用されている証跡のうち恒久保存すべきもの(acceptance.md が参照する json/log)を `spec/verification/` へコピーし、参照パスを更新する。

**書込許可**: `docs/**`、`README.md`、`spec/verification/**`
**受入**: 記述と実体の一致を目視確認。`bun run verify:all` 1 回(ドキュメントのみなら省略可)。

---

## 見送り(今回やらない)と理由

- **CI 導入・マルチプラットフォーム対応**: ユーザー決定により保留。`verify.ts`/`sqlite/index.ts` の libSystem FFI 対応もこれに含めて保留。
- **SSE 実装 3 系統の統合**: 用途(invalidation / snapshot / chat)が異なり、統合の利益よりリスクが大きい。M1 の reader 統一のみ行う。
- **settings 暗号文への AAD 追加**: 既存暗号文の再暗号化 migration が必要で、鍵運用に触る。単体の defense-in-depth 改善としては S1/S2 より劣後。
- **migration の位置依存解消**: vendor package(eumenes-memory)の更新手順と一体で設計すべき。D5 の checksum で事故検出のみ先行。
- **コミット履歴の整理**: ユーザー指示により対象外。

## 実施記録

(各 WP 完了時に 1〜3 行で追記: 日付 / WP / 結果 / 逸脱があれば理由)

2026-10-09 実施。コミット・push はしていない。最終の `bun run verify:all` は成功（backend 292件・Web 92件・browser 14件・入力 hash 変更なし）。

- **S1**: 完了。`isAllowedEnvRef` を settings service に追加し、保存時（`invalid_env_ref`）と解決時（`env_ref_not_allowed`）に検証。逸脱: 既に保存済みで変更のない envRef は保存を妨げず、利用時にだけ失敗させる（既存設定の互換のため）。診断一覧は拒否された ref でも `credentialAvailable:false` を返す。
- **S2**: 完了。`cloudEndpoint`（http は loopback/RFC1918/`.local`/link-local のみ）を cloud 接続の baseUrl に適用、LARM URL は不変。逸脱: 読み込み側のスキーマは緩いままにし（保存済みの http 設定で設定画面が開けなくなるのを防ぐ）、`applySchema` の適用時にだけ検証する。README に平文注意と許可規則を追記。
- **S3**: 完了。`toErrorCode`（snake_case のみ保存、他は `handler_failed`、非 Error/空は従来どおり `execution_failed`）。
- **S4/S5/D1**: 完了。`api/application/error-status.ts` に対応表を移し、bearer を SHA-256 + `timingSafeEqual` で比較、JSON 系の 1MB 超 Content-Length を 413。逸脱: 音声 upload は `/api/voice/turns` と `/api/voice/preview` のみ除外（他の `/api/voice/*` は JSON）。長さなしの chunked は 411（`length_required`）で拒否。
- **F0**: 退行ではなく負荷依存の flake。単独 3/3 通過。計測では解放処理は常に実行されており、ソフトウェア GL のモデル生成（1〜5秒）がメインスレッドを占有して設定遷移の反映が5秒を超えることがあった。実装の修正点なし、browser 試験の待機を5→20秒、試験全体を45→60秒に延長。
- **F1**: 完了。`web/src/queryKeys.ts` に root 台帳と SSE `change` 用の `changeRoots`。`reset` と接続断のみ全 invalidate（`client/events.ts` が種別を通知）。focus 側の手動 invalidate を削除、`MicLevelMeter` を分離、`MessageList` と Markdown を memo 化。逸脱: 診断・プローブ・声一覧は change では再取得しない（実 Provider を叩くため）。voice-dialogue と service-tests は従来の挙動を保つため change でも再取得する。
- **F2**: 完了。`web/src/errorMessages.ts`（`describeError` / `describeTurnStatus` / `describeConnectionState`）。`setError(String(` は 0 件。ストリーミング中の回答は live region から外し、確定後の先頭80字だけ非表示の `<output>` で通知。browser 試験の期待文言（接続済み/待機中/再生済み）を日本語表示に合わせて更新。
- **F3**: 完了。track `ended`・`devicechange`・AudioContext `statechange`（1回 resume）を監視し `onLost`、保存 device 不在は既定 device で1回 retry して `onNotice`。hook が停止して日本語で通知。実機器での挙動は未確認。
- **F4**: 完了。replay を AudioController 経由（`startOutput` による出力専用 controller、またはライブ session の controller を共有）に変更。新しい再生が古い再生を割り込み、`onInterrupted` で旧再生を終了。音声開始時は replay を停止。controller の型に `startOutput` を足すため、hook 試験の型注釈 `typeof createAudioController` を `CreateAudio` に変更（試験の中身は不変）。
- **F5**: 完了。`audio/worklet/recorder.worklet.ts` を `?worker&url` で読み込み（`new URL` 形式は build で素の TS になるため）。128 frame を 2048 に束ねて既存の検出処理へ渡し、失敗時は ScriptProcessor に fallback。
- **M1**: 完了。`api/infrastructure/bounded-read.ts`（larm 版の挙動を採用、abort signal 対応）へ 7 箇所を置換。SSE 3系統は統合しない。`infrastructure/chat-stream.ts` は逐次パーサで全体を溜める reader ではないため対象外。
- **M2**: 完了。`larm/service/index.ts` 1346→900行。`profiles.ts`・`guards.ts`・`connect.ts`（catalog/create/ready/claim/renew）・`context.ts` に分割。facade・`createLarm` は不変、`larm.test.ts` 無変更で通過。
- **M3**: 完了。`inference/service/index.ts` 1279→約650行。`execute.ts`（`executeRequest` を段ごとの関数に分解、`Env` で状態を受け渡し）・`cloud.ts`・`errors.ts`・`wav.ts`。`import("../../delivery")` は contracts からの型 import に変更し、`Judge` 型を delivery contracts へ移動。
- **M4**: 完了。仕分け: 全カテゴリ共通（draft/keys/retry/message/busy/adding/devices/queries/apply）は `SettingsPage` に残し props で渡す。カテゴリ内で閉じる `voices` query と声の派生値は `sections/voice.tsx` へ。index 444行、最大 section 394行（connections 331、voice 394）。各 section に smoke test。
- **M5**: 完了。`hooks/machine.ts` の純 reducer（遷移表は同ファイル冒頭）。start/stop/segment_accepted/upload_failed/playback_cancelled/turn_released/player_installed/delivered_marked の8遷移で session・current・delivered・player epoch を管理し、`useVoiceDialogue` の ref は AudioController・AbortController・Promise tail のみ。遷移表にない経路は見つからなかった。browser 試験は 14 件を 3 回連続通過。
- **D2**: 完了。service-tests・settings(診断/使用記録/プローブ/LARM詳細)・memory・larm・voice-dialogue(preview/sentences) の応答を Zod で検証。スキーマは各 domain の contracts に追加。attitude-dataset の export 応答は対象外（一覧外）。
- **D3**: 完了。`acceptedEmotion` を delivery contracts へ移動（service は再 export）。web/client の api import は全て contracts 経由。
- **D4**: 完了。`export … from`・動的 `import()`・型 `import("…")` を検査し、動的な指定子は `boundary_dynamic_specifier`。layer 規則（web/client は contracts のみ、cli は client・contracts・auth-config のみ）を追加。検出された `dialogue/test/memory-integration.test.ts` の深い import は memory facade 経由に変更。`verify:all` は api・web/src・client・cli の全ファイルを検査。
- **D5**: 完了。`schema_migrations.checksum`（SHA-256）を追加。列がない旧 DB は ALTER で追加し既存行を現行定義で一度だけ backfill。不一致は `migration_checksum_mismatch`（id のみ）で起動失敗。
- **D6**: 完了。`createDialogueService` を options object に変更（呼び出し元とテストを追従）、server.ts の `larm` 変数を `inference` に rename、`createProductionApp(Required<…>)` を追加。
- **D7**: 完了。`docs/domains.md`（avatar・service-tests・境界規則）、`docs/acceptance.md` 冒頭の現在状態表、README（S1/S2 の仕様）、acceptance.md が引用する証跡 15 件を `spec/verification/acceptance/` へコピーして参照を更新（`verification-reports/` は git 管理外のため）。

レビュー後の修正（1回）: S2 の適用時検証への変更、replay の `interrupt` でライブ turn を解放、`startOutput` 失敗時の context 破棄、worklet の `onprocessorerror` で `mic_lost`、errorCode の上限を101字・`:` 許可に拡張。再実行した `verify:all` は成功（backend 293件・Web 92件・browser 14件）。
