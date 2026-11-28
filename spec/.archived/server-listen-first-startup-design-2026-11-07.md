# サーバー先行起動の設計（2026-11-07）

状態: 合意済み（2026-11-07 利用者回答「はい。」）・L1〜L3 実装済み・fixture 検証済み。実機での再起動確認は未実施。実装時の調整は §13。

依頼（2026-11-07 利用者）「サーバー起動を優先し、それから各種サービスのチェックなりが始める構成にデキマセンカ？」

## 1. 現状

`api/application/server.ts` は、全サービスの組み立て・復旧・開始を終えてから HTTP を listen する。

| 順 | 処理 | 場所 | 12:58 起動の時刻 |
| --- | --- | --- | --- |
| 1 | 設定・ログ・トークン | `server.ts:26-67` | 12:58:48.715 `server.starting` |
| 2 | `buildServices`（DB を開く、マイグレーション、事前バックアップ、bundle 取込、サービス生成） | `server.ts:68-77` | 〜12:58:49.6 |
| 3 | `recoverAll`（復旧 26 段） | `server.ts:80-83` | 12:58:49.633〜49.939 |
| 4 | `startAll`（開始 約 20 段） | `server.ts:84` | 〜12:58:59.9（10 秒） |
| 5 | `createApp` → `Bun.serve` | `server.ts:86-104` | 12:58:59.959 `server.listening` |
| 6 | LARM の疎通確認、router の接続 | `server.ts:106-119` | 12:59:04〜 |

`scripts/dev.ts` は `/api/status` が 200 を返すまで最大 30 秒待ち、その後に Vite を起動する。手順 2〜4 が長いと、画面も Vite もその分だけ遅れ、30 秒を超えると dev.ts が API を止める（2026-11-07 の 27 秒停止はこの形で失敗した）。

今の順序にしている理由は3つ。

| 理由 | 内容 |
| --- | --- |
| R1 復旧前の状態を見せない | 中断した実行・キュー・記憶の journal を復旧する前に、要求を処理しない |
| R2 起動失敗では受け付けない | 復旧・開始が失敗したら、要求を一件も処理せず終了する（fail-closed） |
| R3 アプリには全サービスが要る | `createApp` は全 domain の controller を組むため、サービスが揃うまで作れない |

## 2. 方針

listen を最初に行う。準備が終わるまでは「起動中」を返す小さな応答だけを置き、準備が終わったら本来のアプリに差し替える（Bun の `server.reload({ fetch })`）。R1〜R3 は、起動中の応答が業務の要求を一件も処理しないことで保つ。復旧と開始の順序・内容は変えない。

## 3. 起動の段階

| 段階 | 処理 | HTTP の応答 |
| --- | --- | --- |
| S0 | 設定・ログ・トークン → `Bun.serve`（起動中の応答） | 起動中の応答 |
| S1 | `buildServices` | 起動中の応答 |
| S2 | `recoverAll` | 起動中の応答 |
| S3 | `startAll` | 起動中の応答 |
| S4 | `createApp` → `server.reload({ fetch: app.fetch })` | 本来のアプリ |
| S5 | LARM の疎通確認、router の接続（今と同じく S4 の後） | 本来のアプリ |

## 4. 起動中の応答の規則

| 要求 | 応答 |
| --- | --- |
| `GET /api/status`、正しい Bearer | `200 {"service":"eumenes","phase":"starting"}` |
| それ以外（Bearer なし・不一致の status、`OPTIONS`、他のパス・メソッド） | `503 {"error":"server_starting"}`、`Retry-After: 1`。本文に情報を含まず、token の成否も示さない |

トークンの比較は `safeEqual` を使う。設定値・秘密・DB は読まない。listen 先は今と同じく loopback だけ。

## 5. `/api/status` の応答

| 段階 | 応答の例 |
| --- | --- |
| S0〜S3 | `{"service":"eumenes","phase":"starting"}` |
| S4 以降 | `{"service":"eumenes","phase":"ready","larm":{"state":"ready", …}}` |

`statusResponseSchema`（`api/domains/larm/contracts/index.ts:220`）を `phase` で分けた union にする。`larm` は `ready` のときだけ持つ。

## 6. 利用側の変更

| 利用側 | 変更 |
| --- | --- |
| `scripts/dev.ts` | 判定は今のまま（200 かつ `service:"eumenes"`）。S0 の直後に通るので、Vite は API の起動から約 1 秒で始まる。30 秒の待ちは「listen まで」の上限になる。S1〜S3 の間に API が終了したら、今と同じく exit を見て止める |
| Web（`web/src/workspace/useWorkspace.ts:209-213`） | `phase:"starting"` の間は「サーバー起動中です」を表示し、状態を 1 秒ごとに取り直す。`ready` になってから作業画面の取得を始める。`503 server_starting` は失敗表示にしない |
| CLI（`cli/index.ts`・`client/transport.ts`） | client の `startingWaitMs`（CLI だけが 60 秒を指定）。要求が `503 server_starting` で断られたら、`/api/status` を 1 秒おきに聞き、`starting` でなくなったら同じ要求を 1 回だけ送り直す（起動中の応答は何も処理していないので安全。`ReadableStream` の本文は送り直さない）。60 秒を超えたら終了コード 5 |
| fixture サーバー・live 試験 | `/api/status` の `phase:"ready"` を待つ形に揃える（実装時に対象ファイルを列挙する） |

## 7. ログの順序（S4 で `server.ready` を足す）

```
server.starting
server.listening            {"port":8787}
sqlite.pre_migration_backup （未適用のマイグレーションがあるときだけ）
capability.revision_conflict / capability.bundle_skipped （今ある warn）
server.recovery_started
server.recovery_completed
server.ready
larm.*                      （疎通確認・router の接続）
```

## 8. 失敗と停止

| 状況 | 動作 |
| --- | --- |
| S0 でポート使用中 | すぐ `server.startup_failed {"reason":"port_in_use"}`、exit 1（今より早く分かる） |
| S1〜S3 の失敗 | 今と同じく `shutdown` → `server.startup_failed {reason}` → exit 1。起動中の応答は業務の要求を処理していないので、R2 は保たれる |
| S1〜S3 の間の SIGINT/SIGTERM | 今と同じく、実行中の段階が終わるのを待ってから `closeAll`。HTTP の停止（`server.stop`）は runner の http lifecycle で行う。runner ができる前の停止は `server.stop` を直接呼ぶ |
| S4 の差し替え中に届いた要求 | 差し替え前に受けた要求は起動中の応答のまま返り、差し替え後の要求から本来のアプリが処理する |

## 9. 変えないもの

| 項目 | 内容 |
| --- | --- |
| 復旧・開始の順序と中身 | `server-lifecycles.ts` の 26 段・約 20 段はそのまま |
| fail-closed | S4 より前に業務の要求は一件も処理しない |
| 本来のアプリの認証・origin 検査 | `app.ts` は変えない |
| LARM の接続開始 | S4 の後（2026-11-07 の修正と同じ位置） |

## 10. この設計で解決しないもの

| 項目 | 内容 |
| --- | --- |
| 同期処理による停止 | API は単一スレッドなので、S1〜S3 で同期処理が走っている間は、起動中の応答も返らない。listen は先に終わるが、`/api/status` はその処理が終わるまで待たされる。12:58 起動の `startAll` 10 秒（原因未特定）はこの対象で、CPU プロファイルで別途特定して短くする |
| 画面が使えるまでの時間 | Vite は早く起動するが、作業画面は S4 まで「サーバー起動中です」の表示になる |

## 11. 試験

| 対象 | 確かめること |
| --- | --- |
| `api/application/server.test.ts` | `server.listening` が `server.recovery_started` より先。起動中の応答（§4 の4行）。S4 で本来のアプリに切り替わる。S2 の失敗で exit 1、要求は処理されない |
| `scripts/dev.ts` の試験 | `phase:"starting"` で Vite を起動する |
| Web | `starting` の間は起動中の表示、`ready` で作業画面 |
| CLI | `503 server_starting` を待って送り直す、60 秒で終了コード 5 |
| verify | `bun run verify -- --domain larm` と application の server 試験。E2E は対象ファイルを指定して個別に実行 |

## 12. 段階

| 段階 | 内容 |
| --- | --- |
| L1 | `server.ts` の S0 と起動中の応答、`server.reload` による差し替え、`/api/status` の `phase`、`server.ready` のログ |
| L2 | Web・CLI・fixture サーバーの `starting` 対応 |
| L3 | §11 の試験 |

合意をお願いする点: 起動順を §3 の S0〜S5 に変えること（§4 の起動中の応答、§5 の `phase` 追加を含む）。

## 13. 実施記録（2026-11-07）

### 実装時の調整

| 項目 | 設計時 | 実装 | 理由 |
| --- | --- | --- | --- |
| Bearer なしの status（起動中） | 401 | 503 `server_starting` | ブラウザー試験の待ち（`tests/browser/fixture.ts:133`、token なしで 500 未満になるまで待つ）が、起動中に通り抜けないようにする。token の成否も示さない |
| CLI の待ち方 | コマンドの前に状態を見る案 | client が 503 を受けたときだけ待って同じ要求を 1 回送り直す | 「API を呼ぶ前に引数を検査する」既存試験と要求回数の試験を保つ。標準入力を読み直さない |

### 変更したもの

| ファイル | 内容 |
| --- | --- |
| `api/application/server.ts` | S0 で `Bun.serve`（起動中の応答）→ `server.listening`。S1〜S3 は従来どおり。S4 で `server.reload({ fetch: app.fetch })` → `server.ready`。runner ができる前の停止は `server.stop(true)` を直接呼ぶ |
| `api/application/app.ts` | `createStartingFetch`（§4）。セキュリティヘッダーを本来のアプリと共有 |
| `api/domains/larm/contracts/index.ts`・`controller/index.ts` | `statusResponseSchema` を `phase` の union に、`readyStatusSchema`（`/api/larm/connect` の応答） |
| `client/transport.ts`・`client/index.ts`・`client/larm.ts` | `startingWaitMs`（CLI 用、既定は無効） |
| `cli/index.ts`・`cli/failure.ts` | 60 秒の待ち、超過時は終了コード 5 |
| `web/src/App.tsx`・`web/src/workspace/ServerReady.tsx` | `ready` まで「サーバー起動中です。」を表示し、状態を 1 秒ごとに取り直す。届かないサーバーは従来の接続表示に任せる |
| `web/src/workspace/useWorkspace.ts`・`ConversationStatusBar.tsx` | `phase:"ready"` のときだけ `larm` を読む |
| `scripts/voice-live.ts`・`mixed-speech-live.ts`・`response-latency-api-live.ts`・`nl-acceptance/stack.ts` | `phase:"ready"` まで待つ |

### 検証（fixture）

| 対象 | 結果 |
| --- | --- |
| 型検査 `bun check` | エラー 0 件（3,055 ファイル） |
| bun 試験（`app`・`server`・`cli`・`dev`・router-judge・larm 全件） | 529 件成功。追加: 起動中の応答の規則、listen → 復旧 → ready の順序と ready 後の status、CLI が 503 の後に待って送り直す |
| vitest（`ServerReady`・client core） | 92 件成功。追加: starting の間は作業画面を出さず ready で出す、届かないサーバーでは作業画面に任せる |
| vitest（`web/src/App*.test.tsx` 他） | 未確認。別作業の katex CSS 読み込み（`Unknown file extension ".css"`）でファイルごと読み込めない。client の settings 試験 4 件は別作業の settings 契約変更（`intent` の削除）で失敗 |
| 実機の再起動 | 未実施（利用者が再起動） |

### 独立レビュー（1回）と修正

| 指摘 | 修正 |
| --- | --- |
| 中〜高: Web の待ちが、status の取得失敗中も 1 秒ごとに取り直し続ける（`tests/browser/voice.spec.ts` の「障害中は取り直さない」試験に反する） | 取り直すのは最後の応答が `starting` のときだけ |
| 中: ready の後に status が `starting` を返す（再起動・フォーカス時の取り直し）と作業画面が外れ、入力・購読が失われる | 一度作業画面を出したら戻さない |
| 低: CLI の待ちで status の 1 回の問い合わせに時間制限がない／一時失敗で待ちが終わる／abort の listener が残る | 1 回 2 秒で打ち切る。応答なし・503 の間は待ち続ける。待ち終わりに listener を外す |
| 低: 起動中の応答が、許可していない Origin からの status に 200 を返す | 本来のアプリと同じく Origin が違えば応えない（503） |

修正後: 型検査 0 件、bun 試験（`app`・`server`・`cli`・`dev`）55 件、vitest（`ServerReady`・client core）94 件成功。ブラウザー E2E（`voice.spec.ts` ほか）はサーバーを起動するため未実行。
