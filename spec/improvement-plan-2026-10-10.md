# 改善実装手順書(2026-10-10)

2026-10-10 のプロジェクト評価(アーキテクチャ・セキュリティ・実行時の正しさ・frontend/試験/開発体験の4観点レビュー)で見つかった改善点を、**作業者がこの文書だけを読んで実装できる粒度** にした手順書。前回の [改善実装計画書(2026-10-09)](.archived/improvement-plan-2026-10-09.md) は全 WP 完了済み。本書はその続編で、前回「見送り」とした項目(CI・マルチプラットフォーム・AAD・migration の位置依存)も **ユーザー指示(2026-10-10「推奨の修正はすべて含める」)により本書で実施対象に含める**。

---

## 0. 作業者への共通規則(全 WP に適用・必読)

1. **AGENTS.md に従う。** 特に次を守ること。
   - 下位 domain から上位 domain を import しない。
   - 複数 domain の保存は単一 writer の transaction で行う。
   - Web・CLI は API 経由で操作し、DB を直接開かない。
   - LARM credential は backend 内に留める。
   - ログに会話本文・音声・認証情報・設定・Provider の生応答を出さない。
2. **行番号は 2026-10-10 時点の目安。** ファイル名と関数名(シンボル)を正とし、行番号はズレている前提で探すこと。
3. **コミット・push しない。** ユーザーが行う。
4. **着手前に `git status --short` を実行する。** WP の「書込許可」に挙げたファイルに未コミット変更(`M` / `??`)があれば、着手せずユーザーに報告して待つ(別セッションの作業中の可能性がある)。2026-10-10 時点で別作業により変更中のファイルは §1 の一覧のとおり。
5. **書込許可に無いファイルは変更しない。** 必要になったら手を止めて報告する。例外は、format の自動修正と、変更したシンボルを使う箇所の追従(rename など)だけ。後者は報告に列挙すること。
6. **検証コマンド**
   - 各 WP 完了時に `bun run verify -- --domain <主対象domain>` を実行する。
   - web を変えたら `bunx vitest run web` も実行する。
   - `scripts/`・`vite.config.ts`・`tests/browser` を変えたら、各 WP の「検証」欄の指示に従う。
   - 横断 WP は最後に `bun run verify:all` を実行する。
   - format は `bun run format`、lint は `bun run lint`(warning もエラー扱い)。
7. **「挙動変更なし」の WP では既存テストを 1 文字も変えずに通すこと。** 通らない場合は実装が誤っている。
8. **テストの書き方**
   - backend は `bun:test`、web は vitest + Testing Library、ブラウザは Playwright。
   - 新規テストは対象 domain の `test/` に置く(web は `web/src/domains/<d>/test/` か既存の配置に合わせる)。
   - 実時間の `sleep` は使わず、注入した clock や fake timers を使う。
9. **domain 間 import は `scripts/domains.ts` の `depends` に従う。** 新しい cross-domain import を足すときは `depends` も更新し、境界検査(`bun run verify` 内)を通すこと。
10. **エラーは機械可読な snake_case のコード(例 `larm_control_timeout`)で throw する。** HTTP status の対応は `api/application/error-status.ts`(ARC-10 実施後は各 domain の contracts)に追加する。
11. **ログは `getLogger("<component>")` を使う。** 形式は `log.warn("<event>", { reason: "<code>", ... }, error)`。fields は許可キーのみ(`api/infrastructure/logger.ts` の allowlist を確認すること)。
12. **完了時は §末尾「実施記録」に 1〜3 行で追記する。** 内容は日付・WP・結果・逸脱とその理由。

---

## 1. 着手前の状態(2026-10-10)

- `bun run typecheck` / `lint` / `format:check` はすべて成功している。
- `bun run verify:all` は単体試験で **2 件失敗** する(`api/domains/web-research/test/report-scope.test.ts`)。これは別セッションが作業中の未コミット変更なので、本書の作業者は直さない。browser fixture はこの失敗で未実行。
- **別作業で変更中のファイル**(§0-4 により、これらを書込許可に含む WP はクリーンになるまで待つ)

  ```
  api/application/toolchain*.ts, api/domains/agent-runtime/service/index.ts,
  api/domains/agent-runtime/test/route-harness.ts, api/domains/capabilities/**,
  api/domains/dialogue/service/index.ts, api/domains/dialogue/service/research-citations.ts,
  api/domains/voice-dialogue/service/index.ts, api/domains/voice-dialogue/service/spoken-text.ts,
  api/domains/web-research/index.ts, api/domains/web-research/service/report-scope.ts,
  scripts/toolchain-live.ts, tests/browser/toolchain.spec.ts,
  web/src/domains/agent-runtime/ResearchTaskCard.test.tsx, spec/verification/**/*.png
  ```

- 別作業のファイル `research-citations.ts` には次のレビュー指摘があるが、本書の対象外とし、その作業の担当者へ渡す。
  - リンクの正規表現が `)` を含む URL(例 Wikipedia の `Foo_(bar)`)を途中で切る。
  - 生 URL・`<https://…>` 形式のリンク・参照形式のリンク・画像はフィルタを素通りする。
  - `failureCode` だけがあるとき `holdBody` が false になり、未フィルタの部分文が SSE に出る。

---

## 2. WP 一覧・依存・並行可否

凡例: 並行 ○ = 他と並行可(書込パスが重ならない) / △ = 記載の WP と同一作業者で順に実施 / × = 依存完了後に着手。

### Phase 1: セキュリティと停止系の即効修正(小さく効果大)

| WP | 内容 | 主な書込先 | 依存 | 並行 |
| --- | --- | --- | --- | --- |
| SEC-1 | Vite の `fs`/CORS 制限と proxy の Origin 判定 | vite.config.ts, api/infrastructure/dev-proxy.ts | なし | ○ |
| SEC-2 | API token を LARM token から導出しない | api/infrastructure/auth-config.ts ほか | なし | ○ |
| SEC-3 | セキュリティ header | api/application/app.ts, vite.config.ts | SEC-1 | △SEC-1 |
| SEC-9 | Content-Length と Transfer-Encoding が両方ある要求の拒否 | api/application/app.ts | SEC-3 | △SEC-3 |
| RT-9 | snapshotStream の client 数リーク | api/infrastructure/snapshot-stream.ts | なし | ○ |
| RT-10 | `SqliteStore.write` の async callback 拒否 | api/infrastructure/sqlite/index.ts | なし | ○ |
| WEB-1 | root ErrorBoundary | web/src/main.tsx ほか | なし | ○ |
| WEB-6 | mic stream のリーク | web/src/domains/audio/controller/index.ts | なし | ○ |

### Phase 2: 実行時の頑健性

| WP | 内容 | 主な書込先 | 依存 | 並行 |
| --- | --- | --- | --- | --- |
| RT-1 | agent-runtime `reconcile` の例外処理と repairFeedback のリーク | agent-runtime/service/index.ts | §1 がクリーン | ○ |
| RT-2 | dialogue `reconcileAgents` の例外処理 | dialogue/service/index.ts | §1 がクリーン | ○ |
| RT-3 | scheduler の `retryAfter`・ログ・backoff | scheduler/service/index.ts | なし | ○ |
| RT-4 | queue の afterCommit hook を呼出しごとに分離 | queue/service/runner.ts | なし | ○ |
| RT-5 | queue 候補走査の飢餓 | queue/service/runner.ts, queue/repository/index.ts | RT-4 | △RT-4 |
| RT-6 | queue loop の失敗ログと backoff | queue/service/runner.ts | RT-5 | △RT-4 |
| RT-7 | shutdown の期限・独立化・二度目のシグナル・maintenance の多重起動防止 | api/application/server.ts | なし | ○ |
| RT-11 | LARM の timeout・冪等キー・abort・lastError・close | larm/service/{index,connect}.ts | なし | ○ |
| RT-12 | inference probe が running のまま残る | inference/service/index.ts | なし | ○ |
| RT-13 | voice の音声 eviction と sessions の TTL | voice-dialogue/service/index.ts | §1 がクリーン | ○ |

### Phase 3: セキュリティ(中〜低)

| WP | 内容 | 主な書込先 | 依存 | 並行 |
| --- | --- | --- | --- | --- |
| SEC-4 | LARM claim の provider host を固定 | larm/service/{guards,playground,playground-http,connect}.ts | RT-11 | △RT-11 |
| SEC-5 | settings: 169.254 の除外と envRef の host 束縛 | settings/{contracts,service}/index.ts | なし | ○ |
| SEC-6 | settings 暗号文に AAD | settings/service/index.ts | SEC-5 | △SEC-5 |
| SEC-7 | DB と鍵の権限、鍵の配置 | api/infrastructure/sqlite/index.ts, settings/service | RT-10, SEC-6 | × |
| SEC-8 | 生の error.message を保存・返却・ログしない | voice-dialogue/service, scheduler, queue/registry | RT-13, RT-3 | × |
| SEC-10 | coding-runner の host git 硬化と network 方針の強制 | packages/coding-runner/src/** | なし | ○ |
| SEC-11 | supervisor 指示の承認ゲート | coding-supervision/** | なし | ○ |
| SEC-12 | `allow_with_warning` のページを拒否 | web-research/adapters/llm-fetch.ts | なし | ○ |
| SEC-13 | dev.ts から Vite へ渡す env の最小化 | scripts/dev.ts, vite.config.ts | SEC-1, SEC-2 | × |
| SEC-14 | 高コスト endpoint の同時実行上限 | api/infrastructure/concurrency.ts, app.ts | SEC-9 | △SEC-3 |

### Phase 4: frontend

| WP | 内容 | 主な書込先 | 依存 | 並行 |
| --- | --- | --- | --- | --- |
| WEB-2 | reset 時の全 invalidate の範囲を絞る・QueryClient・staleTime | web/src/App.tsx, queryKeys.ts | なし | ○ |
| WEB-3 | timers のポーリング廃止 | web/src/domains/timers/**, components/domains/timers/** | WEB-2 | △WEB-2 |
| WEB-4 | 画面の遅延読込と chunk 分割 | web/src/App.tsx, vite.config.ts | WEB-2, SEC-13 | △WEB-2 |
| WEB-5 | avatar の遅延 import と非表示時の一時停止 | LightAvatarBackground.tsx | なし | ○ |
| WEB-7 | describeError の DOMException 対応と raw 文字列の排除 | web/src/errorMessages.ts, voice-dialogue/hooks | なし | ○ |
| WEB-8 | MessageList の読上げ(live region) | MessageList.tsx | なし | ○ |
| WEB-9 | Subtitle と TimerNotifications の live region | Subtitle.tsx, TimerNotifications.tsx | WEB-3 | △WEB-3 |
| WEB-10 | VAD・worklet・部分認識の効率化 | web/src/domains/audio/** | WEB-6 | △WEB-6 |
| WEB-11 | light-avatar JS と packages を型検査 | tsconfig*.json, light-avatar/*.js | WEB-5 | △WEB-5 |
| WEB-12 | artifact-ui 画像の URL scheme と拡張子 | packages/artifact-ui/src/** | なし | ○ |
| WEB-13 | Markdown のリンク先 hostname 表示 | markdownRenderer.ts | なし | ○ |

### Phase 5: 試験基盤

| WP | 内容 | 主な書込先 | 依存 | 並行 |
| --- | --- | --- | --- | --- |
| TST-1 | verify:all に design-system 試験を追加 | scripts/verify.ts | なし | ○ |
| TST-2 | スクリーンショットの出力先を分離 | tests/browser/** | §1 の toolchain.spec がクリーン | ○ |
| TST-3 | Playwright の固定 sleep を排除 | tests/browser/voice.spec.ts, timers.spec.ts | TST-2 | △TST-2 |
| TST-4 | 単体試験の実時間 sleep を排除 | larm/queue/dialogue の test | RT-11 | × |
| TST-5 | Playwright の起動・停止の堅牢化 | tests/browser/fixture.ts(新規)・各 spec | TST-3 | △TST-2 |
| TST-6 | client SDK の契約試験 | client/test/**(新規) | なし | ○ |
| TST-7 | CLI のコマンド分割とプロセス試験 | cli/** | なし | ○ |
| TST-8 | 未試験 UI の試験追加 | web/src/**/test | WEB 系の後 | × |
| TST-9 | Chromium の偽メディアによる worklet 経路の試験 | tests/browser/voice-media.spec.ts | TST-5, WEB-10 | × |

### Phase 6: 構造

| WP | 内容 | 主な書込先 | 依存 | 並行 |
| --- | --- | --- | --- | --- |
| ARC-1 | ファイル・関数サイズの ratchet | scripts/size-budget.ts, scripts/verify.ts | TST-1 | △TST-1 |
| ARC-2 | agent-runtime service の分割(挙動変更なし) | agent-runtime/service/** | RT-1 | × |
| ARC-3 | world lifecycle-adapter の分割(挙動変更なし) | world/service/** | なし | ○ |
| ARC-4 | dialogue service の分割(挙動変更なし) | dialogue/service/** | RT-2 | × |
| ARC-5 | 他の巨大 service の分割(挙動変更なし) | coding-supervision, tasks, world/extraction-handler | ARC-3(world のみ) | ○ |
| ARC-6 | 境界検査の穴埋め(application・infrastructure・alias) | scripts/boundaries.ts, coding/index.ts, application/coding.ts | なし | ○ |
| ARC-7 | domains.ts の依存を本番用と試験用に分割し、宣言と実 import の差分を検査 | scripts/domains.ts, boundaries.ts, verify.ts | ARC-6 | △ARC-6 |
| ARC-8 | migration の名前付き化(位置依存の解消) | api/infrastructure/sqlite, api/application/migrations.ts, 各 repository | RT-10, SEC-7 | × |
| ARC-9 | canonical JSON / sha256 の一本化(出力は不変) | api/infrastructure/digest.ts, 各 service | なし | ○ |
| ARC-10 | エラーと HTTP status の対応を各 domain で宣言 | 各 contracts, error-status.ts | ARC-11 | × |
| ARC-11 | `parseJsonBody` helper と CORS methods | api/infrastructure/http.ts, 各 controller | SEC-9 | × |
| ARC-12 | 型付き config(zod)の一元化 | api/infrastructure/config.ts, server.ts ほか | RT-7 | × |
| ARC-13 | Lifecycle runner と createApp の module 化 | server.ts, app.ts | ARC-12 | × |
| ARC-14 | tool 固有の知識を汎用 runtime から追い出す | agent-runtime, tool-runtime, capabilities, toolchain.ts | ARC-2 | × |
| ARC-15 | domain をまたぐ SQL の検査 | scripts/sql-boundaries.ts, verify.ts | ARC-8 | × |
| ARC-16 | flock の OS 対応と CI(Linux / macOS) | api/infrastructure/flock.ts, scripts/verify.ts, .github/workflows | TST-1 | ○ |
| ARC-17 | 未使用 export の検出と削除 | package.json, knip.json, 各所 | ARC-2〜5 | × |
| ARC-18 | エラー握り潰しの可視化 | api/infrastructure/ignore-error.ts, 各 controller | ARC-11 | × |
| ARC-19 | world contracts の web 向けと host 向けの分離 | world/contracts/**, web/src/domains/world | ARC-3 | × |
| ARC-20 | 既定 principal 定数の一元化 | conversation/contracts, memory | なし | ○ |

### Phase 7: 衛生・文書

| WP | 内容 | 主な書込先 | 依存 | 並行 |
| --- | --- | --- | --- | --- |
| DOC-1 | vendor tgz の整理と world-model の整合試験 | vendor/**, api/application/vendor.test.ts | なし | ○ |
| DOC-2 | design-system の `dist` を git から外す | .gitignore, package.json | TST-1 | × |
| DOC-3 | LAN IP の既定値を廃止 | larm/service/{index,playground}.ts, larm.test.ts, README | RT-11, SEC-4 | × |
| DOC-4 | README の再構成・docs 索引・domain 表の自動生成 | README.md, docs/**, scripts/domain-docs.ts | 全 WP の後 | 最後 |
| DOC-5 | 実装済み spec の archive | spec/** | DOC-4 | 最後 |

---

# Phase 1

## SEC-1: Vite の `fs`/CORS 制限と proxy の Origin 判定

**問題(稼働中の開発サーバーで確認済み)**
1. Vite 開発サーバーが workspace 全体を `/@fs/` で配信している。`/@fs/<repo>/data/keys/settings.key`(暗号鍵)と `data/eumenes.sqlite3` が HTTP 200 で取れ、localhost の別オリジンにも CORS が許可されている。
2. proxy は Origin ヘッダが **無い** 要求にも Bearer を付ける(`vite.config.ts` の `proxyReq`)。このため `curl http://127.0.0.1:5173/api/status` が認証なしで通る。

**書込許可**: `vite.config.ts`、`api/infrastructure/dev-proxy.ts`(新規)、`api/infrastructure/dev-proxy.test.ts`(新規)

**手順**
1. `api/infrastructure/dev-proxy.ts` を新規作成し、純関数を置く。

   ```ts
   /** Dev proxy: attach the API credential only to requests from the SPA itself. */
   export function shouldAuthorize(
   	headers: { origin?: string; "sec-fetch-site"?: string },
   	expectedOrigin: string,
   ): boolean {
   	if (headers.origin !== undefined) return headers.origin === expectedOrigin;
   	// Same-origin GET from the SPA may omit Origin; browsers always send Sec-Fetch-Site.
   	return headers["sec-fetch-site"] === "same-origin";
   }
   ```

2. `vite.config.ts` の `proxy.on("proxyReq", ...)` を次の挙動に書き換える。
   - `shouldAuthorize(incoming.headers, expectedOrigin)` が false なら、`Authorization` を付けずに `request.removeHeader("authorization")` だけ行って return する。backend が 401 を返す。
   - true のときだけ `Authorization` と `Origin` を設定する。
   - `incoming.headers` の値は `string | string[] | undefined` なので、配列なら先頭を使う。
3. `server` に次を追加する。

   ```ts
   cors: false,
   fs: {
   	strict: true,
   	allow: [resolve("web"), resolve("client"), resolve("packages"), resolve("api"), resolve("node_modules")],
   	deny: [".env", ".env.*", "*.{crt,pem,key}", "**/data/**", "**/*.sqlite3*", "**/verification-reports/**"],
   },
   ```

   - `api` を allow に含めるのは、web が `api/domains/*/contracts` を import するため。`data/` は deny で塞ぐ。
   - deny は Vite の既定(`.env` など)を上書きするので、既定分も含めること。
4. `dev-proxy.test.ts` に次の 5 ケースを書く。
   - Origin 一致 → true
   - Origin 不一致 → false
   - Origin なし・`sec-fetch-site: same-origin` → true
   - Origin なし・`sec-fetch-site: cross-site` → false
   - どちらもなし(curl)→ false

**受入条件**
- `bun run dev` 起動中に次がすべて成り立つ。
  - `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/api/status` が 401。
  - `curl ... http://127.0.0.1:5173/@fs$(pwd)/data/keys/settings.key` が 403 か 404。
  - ブラウザで `http://127.0.0.1:5173` を開くと、会話・設定・SSE が通常どおり動く。
- `bunx playwright test` の全 spec が通る。fixture は `sec-fetch-site` を付けるブラウザ経由なので影響しない想定。落ちたら、fixture が Node fetch で proxy を叩いていないか確認し、直接 backend に token 付きで叩く形へ直す。

**検証**: `bun test api/infrastructure/dev-proxy.test.ts`、`bunx playwright test`、上記 curl。

---

## SEC-2: API token を LARM token から導出しない

**問題**: `resolveApiToken` は `EUMENES_API_TOKEN` が未設定のとき `HMAC(LARM token, 固定文字列)` を返す。LARM token は LAN を平文で流れるので、盗まれるとローカル API の token も導出できる。

**書込許可**
- `api/infrastructure/auth-config.ts` と `auth-config.test.ts`
- `api/application/server.ts`(起動失敗 reason の対応のみ)
- `scripts/dev.ts`
- `vite.config.ts`
- `cli/index.ts`(token 解決の呼出しのみ)
- `tests/browser/*.spec.ts`(token 指定のみ。ただし §1 の `toolchain.spec.ts` はクリーンになるまで待つ)
- `api/**/test/**` のうち token を作っている箇所
- `README.md` の該当文

**手順**
1. `auth-config.ts` の `resolveApiToken(env)` を次の順に解決する形へ変える。
   1. `EUMENES_API_TOKEN`(trim 後)があれば、従来どおり 24 文字未満は throw してそれを返す。
   2. 無ければ token ファイル `<dataDir>/keys/api.token` を読む。
      - `dataDir = dirname(resolve(env.EUMENES_DB ?? "./data/eumenes.sqlite3"))`
      - 中身は 64 文字の hex。trim し、`/^[0-9a-f]{64}$/` に一致しなければ `api_token_file_invalid` を throw する。
   3. ファイルが無ければ生成する。`mkdirSync(keys, {recursive:true, mode:0o700})` のあと、`randomBytes(32).toString("hex")` を `writeFileSync(path, token, {mode:0o600, flag:"wx"})` で書く。
      - `EEXIST` で失敗したら(並行起動)、そのファイルを読み直す。
   - **HMAC 導出は削除する。** LARM token が無くても API token は得られるようになるので、`Set LARM_API_TOKEN or EUMENES_API_TOKEN` エラーは不要になる。
   - backend の LARM 接続は LARM token が無ければ従来どおり unconfigured。
2. `server.ts` 末尾の `main().catch` の reason 対応を更新する。
   - `api_auth_unconfigured` の分岐を削除する。
   - `api_token_file_invalid` を `reason: "api_token_file_invalid"` に対応させる。
3. `vite.config.ts` と `scripts/dev.ts` は `resolveApiToken(env)` をそのまま使える。env に `EUMENES_DB` を含めて渡すこと(dev.ts は `process.env` を継承しているので変更不要。SEC-13 で最小化する際に `EUMENES_DB` を残す)。
4. 試験・fixture の対応
   - `grep -rn "resolveApiToken\|fixture-control" tests api cli client scripts` で、LARM token から API token を作っている箇所を列挙する。
   - 各箇所は `EUMENES_API_TOKEN` に 24 文字以上の固定文字列(例 `fixture-api-token-0123456789abcdef`)を明示して、backend・Vite・試験の全員に同じ値を渡す形へ変える。
   - fixture の一時 `EUMENES_DB` ごとに token ファイルが作られる挙動に依存させないこと。
5. `auth-config.test.ts` に次のケースを書く。
   - 明示 token
   - 24 文字未満で throw
   - ファイル生成(mode が 0600)
   - 既存ファイルの読取り
   - 不正な中身で throw
   - LARM token だけ設定されていても HMAC にならない(ファイル由来になる)
6. README の「`EUMENES_API_TOKEN` は空欄のままにでき、… LARM トークンから用途を分けて生成します」を次の主旨に直す: 空欄なら初回起動時に `data/keys/api.token`(0600)へ乱数で生成し、backend・Vite・CLI が共有する。
   - **既存利用者への注意**: 初回起動で token が変わる。CLI と Vite も同じファイルを読むので、追加の操作は不要。

**受入条件**
- `EUMENES_API_TOKEN` 未設定で `bun run dev` が起動し、`data/keys/api.token` が 0600 で作られる。
- 画面と CLI(`bun cli/index.ts status --json`)がそのまま動く。
- `verify:all` が成功する。

---

## SEC-3: セキュリティ header

**問題**: CSP の `frame-ancestors`・`X-Frame-Options`・`nosniff`・`Referrer-Policy` が無く、UI を iframe に入れたクリックジャッキングが可能。

**書込許可**: `api/application/app.ts`、`vite.config.ts`、`api/application/app.test.ts`

**手順**
1. `app.ts` の最初の `app.use("/api/*", ...)`(ログ middleware)の **前** に、全レスポンスへ次の header を付ける middleware を追加する。

   ```ts
   app.use("*", async (c, next) => {
   	await next();
   	c.header("X-Content-Type-Options", "nosniff");
   	c.header("Referrer-Policy", "no-referrer");
   	c.header("X-Frame-Options", "DENY");
   	c.header("Content-Security-Policy", "frame-ancestors 'none'");
   });
   ```

   - SSE(`/api/events`)と音声 WAV の応答にも付いて問題ない。既存の `nosniff` 設定と重複しても害はない。
2. `vite.config.ts` に小さな plugin を追加し、開発サーバーの全応答に `X-Frame-Options: DENY` と `Content-Security-Policy: frame-ancestors 'none'` を付ける。
   - 実装は `configureServer(server) { server.middlewares.use((req, res, next) => { res.setHeader(...); next(); }); }`。
   - **`default-src` などのフル CSP は付けない。** Vite の HMR と React plugin の inline preamble が壊れるため。
3. `app.test.ts` に、`/api/status` の応答に上記 4 header があることの試験を追加する。

**受入条件**: 試験が通り、`curl -I http://127.0.0.1:5173/` に `X-Frame-Options: DENY` がある。

---

## SEC-9: Content-Length と Transfer-Encoding が両方ある要求の拒否

**書込許可**: `api/application/app.ts`、`api/application/app.test.ts`

**手順**
1. `app.ts` の認証 middleware の body サイズ判定(`const length = c.req.header("content-length")`)の直前に、次を追加する。音声 upload を含む全 method が対象。

   ```ts
   if (c.req.header("content-length") !== undefined && c.req.header("transfer-encoding") !== undefined)
   	return c.json({ error: "invalid_framing" }, 400);
   ```

2. `invalid_` で始まるので `error-status.ts` の追加は不要(接頭辞で 400 になる)。
3. 試験: `app.request("/api/...", { method: "POST", headers: { "content-length": "10", "transfer-encoding": "chunked", authorization, ... } })` が 400 `invalid_framing` になる。

---

## RT-9: snapshotStream の client 数リーク

**問題**: `api/infrastructure/snapshot-stream.ts` は `clients++` を先に行う。`start()` 内の `subscribe` が throw すると `cleanup` が呼ばれず、32 回で全 SSE が `stream_capacity` になる。heartbeat の interval も `unref` されていない。

**書込許可**: `api/infrastructure/snapshot-stream.ts`、`snapshot-stream.test.ts`

**手順**
1. `start(next)` の本体を try/catch で囲む。catch では `cleanup(); controller.error(error);` を実行する(`controller.error` は既に閉じていれば try で握る)。
2. heartbeat を作った直後に `(heartbeat as { unref?: () => void }).unref?.()` を呼ぶ(Bun の Timer は unref を持つ)。
3. 試験を追加する。`subscribe` が throw する stream を `new Response(stream).text()` で 33 回開き、33 回目でも `stream_capacity` にならず subscribe の error になることを確認する。
   - `clients` はモジュール内変数なので、試験の後始末は stream を cancel するだけでよい。

---

## RT-10: `SqliteStore.write` の async callback 拒否

**問題**: `readSnapshot` は Promise を返す callback を `async_snapshot_callback` で拒否するが、`write` はしない。async 関数を渡すと最初の `await` で commit され、後続の SQL が transaction の外で走る。

**書込許可**: `api/infrastructure/sqlite/index.ts`、その試験(`api/infrastructure/sqlite/*.test.ts`。無ければ `sqlite.test.ts` を新規作成)

**手順**
1. `write` 内の `w.transaction(() => operation(w))()` の callback を次の形にする。

   ```ts
   w.transaction(() => {
   	const value = operation(w);
   	if (isThenable(value)) {
   		void Promise.resolve(value).catch(() => {});
   		throw new Error("async_write_callback");
   	}
   	return value;
   })()
   ```

   - `isThenable` は `readSnapshot` と同じ判定を関数に抜き出し、両方で使う。
   - throw は transaction 内なので rollback される。
2. `maintenance` にも同じ判定を入れる。
3. 試験を追加する。`store.write(async (db) => { db.exec("INSERT ..."); })` が `async_write_callback` で reject し、行が残らないこと。
4. `grep -rn "write(async" api` が 0 件であることを確認する(既存の呼出しを壊さない)。

---

## WEB-1: root ErrorBoundary

**問題**: `web/src/main.tsx` が `<App/>` を boundary なしで描画しており、描画例外で画面が真っ白になる。

**書込許可**: `web/src/main.tsx`、`web/src/components/ErrorBoundary.tsx`(新規)、`web/src/App.tsx`(boundary で囲む箇所のみ)、`web/src/components/ErrorBoundary.test.tsx`(新規)

**手順**
1. `ErrorBoundary.tsx` を class component で作る。
   - props: `{ label: string; children; onReset?: () => void }`
   - `getDerivedStateFromError` で `{failed:true}` にする。
   - `componentDidCatch` では `console.error("ui.render_failed", { label, name: error.name })` だけ出す(message は出さない)。
   - 失敗時は `role="alert"` の領域に「表示中にエラーが発生しました。」と「再表示」ボタン(state を戻して `onReset?.()`)を描く。
   - design-system の `Button` を使う。
2. `main.tsx` で `<ErrorBoundary label="app"><App/></ErrorBoundary>` にする。
3. `App.tsx` で `SettingsPage`、`ArtifactPanel`、`WorldPanel` 描画箇所をそれぞれ `ErrorBoundary` で囲む。設定画面が落ちても会話画面は残るようにする。
4. 試験: throw する子を描画すると alert が出て、「再表示」で子が再描画されること。

---

## WEB-6: mic stream のリーク

**問題**: `web/src/domains/audio/controller/index.ts` の `start()` は、`stream = opened` の後で `setSinkId`・`resume()`・worklet 初期化が throw すると、catch(`emit("error"...)`; `throw`)で track を止めない。次の `start()` は `if (disposed || stream) return` で何もしなくなり、マイクが開いたまま残る。

**書込許可**: `web/src/domains/audio/controller/index.ts`、`web/src/domains/audio/test/audio.test.ts`

**手順**
1. `start()` の catch の先頭(`if (disposed) return;` の前)で、入力側の資源を解放する。`pauseInput()` の解放処理と同じ順で行う。
   - `stream?.getTracks().forEach((t) => t.stop()); stream = undefined;`
   - `source?.disconnect(); source = undefined;`
   - `processor` と `worklet` の disconnect・`onmessage = null`・`undefined` 代入。
   - `releaseWatchers()` が同ファイルにあれば呼ぶ。
   - 解放処理は private 関数 `releaseInput()` に抜き出し、`pauseInput()` と共用する。
2. 試験: `openMicrophone` は成功し `AudioContext.resume` が reject する mock で `start()` が reject したあと、mock track の `stop` が呼ばれていることと、再度 `start()` を呼ぶと `openMicrophone` がもう一度呼ばれることを確認する。

---

# Phase 2

## RT-1: agent-runtime `reconcile` の例外処理と repairFeedback のリーク

**問題**
- `api/domains/agent-runtime/service/index.ts` の `reconcile()` は `while (dirty)` の中の書込みが throw すると止まる。
  - `dirty` は先頭で false にした後なので、起動通知が失われる。
  - `schedule()` は `void reconcile()` で呼ぶので、unhandled rejection になる。
  - `close()` は `await reconciling` で throw し、coordinator の `backend_stopped` 処理・`tools.close()` を飛ばす。
  - 1 件の不良 task が後続を永久に塞ぐ。
- `repairFeedback` は `releases` 経由でしか消えず、正常完了した task のぶんが残る。

**書込許可**: `api/domains/agent-runtime/service/index.ts`、`api/domains/agent-runtime/test/reconcile-failure.test.ts`(新規)

**前提**: §1 によりこのファイルが別作業で変更中。クリーンになってから着手する。

**手順**
1. `reconcile()` 内の **task 1 件ごとの処理**(`for (const taskId of new Set([...]))` の本体)と、**期限切れ処理の 1 件ごとの `store.write`** を、それぞれ try/catch で囲む。catch では次を行い、ループは継続する。
   - `log.warn("agent_runtime.reconcile_item_failed", { reason: code(error) }, error)`
   - `failures.set(taskId, (failures.get(taskId) ?? 0) + 1)`
   - `code(error)` は、`error.message` が `/^[a-z][a-z0-9_]{0,79}$/` に一致すればそれを、しなければ `"reconcile_failed"` を返す小関数。
2. 同じ task が連続 5 回失敗したら、その task を `store.write` で `fail(db, task, "reconcile_failed")` にする(この write も try で握る)。成功した task は `failures.delete(taskId)` する。
3. ループのどこかで失敗が 1 件でもあれば、`.finally` で再実行を予約する。`retryTimer` を `setTimeout(schedule, backoff)` で張り、`unref` する。
   - `backoff = Math.min(30_000, 250 * 2 ** consecutiveFailures)`。成功した周回で `consecutiveFailures = 0` に戻す。
4. `schedule()` の `void reconcile()` を次に変える。

   ```ts
   void reconcile().catch((e) => log.error("agent_runtime.reconcile_failed", { reason: "reconcile_failed" }, e))
   ```

5. `close()` の `await reconciling;` を `await reconciling?.catch(() => {});` に変え、`retryTimer` も clear する。
6. **repairFeedback**: task が終端状態(`completed|failed|cancelled|interrupted`)に遷移したことを検出した箇所で `repairFeedback.delete(taskId)` を呼ぶ。`reconcile` 冒頭の `if (!task || !root || terminal.has(root.state))` の解放群に追加すれば足りる。
7. 試験 `reconcile-failure.test.ts` を追加する(既存の試験 harness があれば流用。`agent-runtime/test/` の既存試験の生成方法をまねる)。
   - (a) `tools.settleInTransaction` が 1 回だけ throw するよう差し替えても、別の task が処理される。
   - (b) 5 回連続で失敗した task が `failed / reconcile_failed` になる。
   - (c) `close()` が reconcile の失敗で reject しない。

**受入条件**: 既存の agent-runtime 試験が無変更で通り、新規試験が通る。

---

## RT-2: dialogue `reconcileAgents` の例外処理

**問題**: `api/domains/dialogue/service/index.ts` の `reconcileAgents()` に 2 つの弱点がある。
- 前半(`pendingEvents()` のループ)は全例外をログなしで握り、250ms 間隔で永久に再試行する。
- 後半(`unfinishedAgentRuns` の `store.write`)は catch が無い。`void reconcileAgents()` なので unhandled rejection になり、起動通知も失われる。

**書込許可**: `api/domains/dialogue/service/index.ts`、`api/domains/dialogue/test/reconcile-agents.test.ts`(新規)

**前提**: §1 によりこのファイルは変更中。クリーンになってから着手する。

**手順**
1. 前半の `catch {}` を `catch (error) {...}` にする。
   - `log.warn("dialogue.agent_event_failed", { reason: code(error) }, error)` を出す(`code` は RT-1 と同じ判定の小関数をこのファイル内に置く)。
   - 再試行の遅延を固定 250ms から `Math.min(30_000, 250 * 2 ** retryCount)` に変える(`retryCount` は成功で 0 に戻す)。
   - 同じ `event.id` が 5 回連続で失敗したら、その event の run を `transition(..., "failed", ..., "agent_event_failed")` にする試みを 1 度だけ行う(try で握る)。
2. 後半の `await store.write(...)` を try/catch で囲み、前半と同じログと再試行予約を入れる。
3. `scheduleAgents` の `void reconcileAgents()` に `.catch(log.error...)` を付ける。
4. `close`(`stopped = true` にしている関数)で `retryTimer` を clear し、`await reconciling?.catch(() => {})` する。
5. 試験: `agents.byRootInTransaction` が throw する差し替えで、ログ(logger の試験 sink があればそれ、無ければ例外が外に出ないこと)と、後続の event が処理されることを確認する。

---

## RT-3: scheduler の `retryAfter`・ログ・backoff

**問題**(`api/domains/scheduler/service/index.ts`)
- `retryAfter` から削除されるのは `fireOne` が成功したときだけ。一時停止・取消された schedule の古い値が残る。
- `loop` の `Math.min(...retryAfter.values()) - at` が負になり、`delay` が 10ms の高速ループになる。
- 想定外の例外を、ログなし・+2 秒・永久に再試行している。

**書込許可**: `api/domains/scheduler/service/index.ts`、`api/domains/scheduler/test/scheduler.test.ts`(追記のみ)

**手順**
1. ファイル先頭に `import { getLogger } from "../../../infrastructure/logger"; const log = getLogger("scheduler");` を追加する。
2. `tickInner()` で `dueSchedules(...)` の結果を得た直後に、`retryAfter` のうち **今回の due に含まれない id** を削除する。

   ```ts
   const dueIds = new Set(allDue.map((d) => d.id));
   for (const id of retryAfter.keys()) if (!dueIds.has(id)) retryAfter.delete(id);
   ```

   - 既存のコードは `dueSchedules(...).filter(...)` を一行で書いているので、`allDue` を変数に分ける。
3. `loop()` の wait 計算を、**未来の値だけ** の最小値にする。

   ```ts
   const future = [...retryAfter.values()].filter((t) => t > at);
   const wait = next <= at ? (future.length ? Math.min(...future) - at : pollMs) : next - at;
   ```

4. `fireOne` の「Unexpected failure」の分岐を次のように変える。
   - `log.warn("scheduler.fire_failed", { reason: code(error) }, error)`(`code` は RT-1 と同じ判定)を出す。
   - 失敗回数 `failures: Map<string, number>` で backoff する: `retryAfter.set(id, at + Math.min(300_000, deferMs * 2 ** n) + jitter)`。`jitter = Math.floor(Math.random() * deferMs)`。
   - `setDeferReason(db, id, "unexpected_failure", at)` を capacity 分岐と同様に書く(`.catch` で握る)。
   - 成功したら `failures.delete(id)` する。
5. `loop()` の外側の catch(`delay = Math.min(pollMs, deferMs)`)にも `log.warn("scheduler.tick_failed", ...)` を出す。
6. 試験を追記する。
   - (a) 遅延中の schedule を pause したあと、ループが 10ms で回らない(注入 clock で、`tick` の呼出し回数が 1 秒あたり 100 回未満)。
   - (b) `materializeInTransaction` が throw する schedule は、2 回目の再試行間隔が 1 回目より長い。

---

## RT-4: queue の afterCommit hook を呼出しごとに分離

**問題**(`api/domains/queue/service/runner.ts`): `pendingHooks` を全 `writeAndFlush` で共有し、各呼出しの冒頭で `pendingHooks.length = 0` している。A の transaction が hook を積んだ後、A の continuation が走る前に B が開始すると、A の hook(timer の publish など)が消える。

**書込許可**: `api/domains/queue/service/runner.ts`、`api/domains/queue/test/queue.test.ts`(追記のみ)

**手順**
1. `writeAndFlush` を次に置き換え、`pendingHooks.length = 0` の 2 行と `flushHooks()` を削除する。transaction は直列かつ同期で実行されるため、callback の中で積まれた hook はその呼出しのものだけになる。

   ```ts
   async function writeAndFlush<T>(fn: (db: Tx) => T): Promise<T> {
   	let hooks: Array<() => void> = [];
   	const result = await store.write((db) => {
   		const start = pendingHooks.length;
   		try {
   			return fn(db);
   		} finally {
   			hooks = pendingHooks.splice(start);
   		}
   	});
   	runHooks(hooks);
   	return result;
   }
   ```

   - fn が throw した場合も `finally` で取り除かれ、`await` が reject するので hook は実行されない。
2. `store.write` を直接使っている箇所(`grep -n "store.write" runner.ts`。2026-10-10 時点では 421 行付近の 1 箇所)で `pendingHooks` に積む経路があるか確認する。あればそれも `writeAndFlush` に変える。
3. 試験: 2 つの `writeAndFlush` を `Promise.all` で同時に開始し、両方が hook を積む状況(queue の公開 API で 2 つの job を並行 settle する既存 harness を使う)で、両方の hook が実行されることを確認する。

---

## RT-5: queue 候補走査の飢餓

**問題**: `claimOne` は `candidates(db, now, 256)` の先頭 256 件だけを見る。資源が埋まっている古い background job が 256 件以上あると、その後ろの実行可能な job が一度も見られない。待ち理由の `setWaitReason` も毎回全件に書く。

**書込許可**: `api/domains/queue/service/runner.ts`、`api/domains/queue/repository/index.ts`、`api/domains/queue/test/queue.test.ts`(追記)

**手順**
1. repository に keyset pagination 版を追加する。

   ```ts
   export function candidatesAfter(db, now, limit, after: { laneRank: number; availableAtMs: number; createdSeq: number } | null): JobRecord[]
   ```

   - SQL は既存の `candidates` と同じ並び(`CASE lane WHEN 'interactive' THEN 0 ELSE 1 END, available_at_ms, created_seq`)。
   - `after` があれば `AND (laneRank, available_at_ms, created_seq) > (?, ?, ?)` 相当を書く。SQLite の row value 比較 `(a,b,c) > (?,?,?)` が使える。`laneRank` は同じ CASE 式で書く。
2. `claimOne` を、1 ページ 256 件で claim できる job が見つかるまで次ページへ進む形にする。走査の上限は合計 4096 件。
3. `setWaitReason` は、job の現在の wait reason と異なるときだけ書く。`JobRecord` に wait reason の列が含まれていれば比較し、含まれていなければ repository 側で `UPDATE ... WHERE id=? AND (wait_reason IS NOT ?)` にする。
4. 試験: `resource_busy` になる job を 300 件積み、その後ろに別 resource の job を 1 件積む。1 tick でその job が claim されることを確認する。

---

## RT-6: queue loop の失敗ログと backoff

**書込許可**: `api/domains/queue/service/runner.ts`

**手順**
1. `loop()` の `catch {` を `catch (error) {` にし、`log.warn("queue.tick_failed", { reason: code(error) }, error)` を出す。
2. 連続失敗回数 `tickFailures` を持つ。`delay = Math.min(opts.pollMs * 8, opts.backoff.baseMs * 2 ** tickFailures) + Math.floor(Math.random() * opts.backoff.baseMs)` とし、成功した周回で 0 に戻す。
3. 既存の queue 試験が無変更で通ること。

---

## RT-7: shutdown の期限・独立化・二度目のシグナル・maintenance の多重起動防止

**問題**(`api/application/server.ts`)
- `shutdown()` に全体の期限が無く、途中の await が止まると終了しない。
- 1 段が throw すると以降(`store.close()` と flock 解放)が飛ぶ。
- 二度目の SIGINT は無視される。
- `routeSweep` の interval が停止時に clear されない。
- `taskMaintenance` に多重起動防止が無い。

**書込許可**: `api/application/server.ts`

**手順**
1. `shutdown()` の各段を、名前付きの手順配列にする。

   ```ts
   const steps: Array<[string, () => unknown]> = [
   	["commits", () => unsubscribeCommits()],
   	["status", () => unsubscribeStatus()],
   	["changes", () => changes.close()],
   	["http", () => server.stop(true)],
   	["timers", () => { clearInterval(taskMaintenance); clearInterval(codingHeartbeat); clearInterval(timerMaintenance); if (routeSweep) clearInterval(routeSweep); }],
   	["coding_execution", () => codingExecution?.shutdown()],
   	// …既存の順序のまま全段…
   	["store", () => store.close()],
   ];
   for (const [name, step] of steps) {
   	try { await step(); }
   	catch (error) { failed = true; log.error("server.shutdown_step_failed", { reason: name }, error); }
   }
   ```

   - **既存の順序を変えないこと。** `timerMaintenanceBusy` の await と `inference.close()` の 5 秒 race も、そのまま 1 段として残す。
2. `terminate()` を次の挙動にする。
   - 1 回目: `shutdown()` を開始し、同時に `setTimeout(() => { log.error("server.shutdown_timeout", { reason: "shutdown_timeout" }); process.exit(1); }, 30_000).unref()` を張る。
   - 2 回目(`stopping` が非 null の状態で再度呼ばれた): `log.warn("server.shutdown_forced", { reason: "second_signal" })` を出して `process.exit(130)`。
   - shutdown の結果は、`failed` なら exit 1、そうでなければ exit 0。
3. `taskMaintenance` の interval 内で、`timerMaintenance` と同様に busy の Promise を保持し、前回が未完了なら skip する。`supervision.maintenance()` と `delegated.tasks.maintenance()` は `Promise.allSettled` でまとめる。
4. 手動確認: `bun run start` → Ctrl+C で 0 終了し、ログに `server.shutdown_completed` が出る。Ctrl+C を 2 回素早く押すと 130 で即終了する。

---

## RT-11: LARM の timeout・冪等キー・abort・lastError・close

**問題**(`api/domains/larm/service/index.ts`・`connect.ts`)
1. `control()` は、呼出し側の signal があると POST(接続作成・claim)にも 3 秒で timeout をかける。`Idempotency-Key` が毎回新規なので、再試行で接続が重複する。
2. `refresh` の catch は、呼出し元の abort でも `release(current)` して共有リースを捨てる。
3. connect の catch は、呼出し元の abort でも `lastError` を設定し、status が `failed` になる。
4. `close()` は使用中(`useCount > 0`)だと DELETE せずに終わる。
5. `infer()` が body の stream 全体に一律 120 秒の timeout をかけ、呼出し側の期限(LLM 180 秒)より先に切る。
6. 更新(renew)待ちの間、まだ有効なリースの新規利用まで止める。

**書込許可**: `api/domains/larm/service/index.ts`、`api/domains/larm/service/connect.ts`、`api/domains/larm/test/larm.test.ts`(追記のみ)

**手順**
1. `control()` の timeout を次の規則にする。
   - DELETE は従来どおり 15 秒。
   - `init.method` が無いか `"GET"` で `init.signal` がある(状態確認)場合は 3 秒。
   - それ以外(POST など)は 15 秒。
2. `createConnection(control, input)` に `idempotencyKey: string` を input として追加する。
   - 呼出し側(connect の段階 2)は、1 回の `connect()` 試行の中で同じ key を使い回す。key は connect 開始時に `crypto.randomUUID()` で 1 回だけ作る。
   - 同じ connect の中で作成を再試行する経路があれば、同じ key を渡す。
3. 呼出し元の abort を判定する小関数を置く。

   ```ts
   const callerAborted = (error: unknown, signal?: AbortSignal) => signal?.aborted === true && (error as Error)?.name === "AbortError";
   ```

   - `refresh` の catch: `callerAborted` なら release せずに再 throw する。
   - connect の catch: `callerAborted` なら `lastError` を更新しない。warn ログは `reason: "caller_aborted"` で info に下げる。
4. `close()` の変更
   - `lease` があり `useCount > 0` なら、最大 5 秒、100ms 間隔で `useCount === 0` を待つ(`Bun.sleep` ではなく既存の `pause` 注入があればそれを使う)。
   - その後 `release(current)` する。`release` の `if (current.useCount > 0) return;` は close 経由のときだけ無視する。引数 `force = false` を追加する。
5. `infer()` の `AbortSignal.timeout(120_000)` は、呼出し側の signal があればそれと `AbortSignal.timeout(300_000)` の any にする。無い場合は従来の 120 秒。
6. 更新中の利用
   - `connecting` を待つ分岐(`untilAborted(connecting)`)の前で判定する。現在の `lease` が `!closing && expiresAt - now > 30_000` なら、そのリースをそのまま使う(`useCount++` する既存経路へ進む)。
   - 待つのは、リースが無いか、残り 30 秒以下のときだけにする。
7. `larm.test.ts` に試験を追記する(既存の fixture サーバー・注入 clock を使う)。
   - (a) POST が 3 秒超・15 秒未満で応答しても接続できる。
   - (b) 作成 POST が timeout した後の再試行で、同じ `Idempotency-Key` が送られる。
   - (c) 呼出し元 abort で `status().state` が `failed` にならず、リースが残る。
   - (d) `close()` が使用中のリースを最大 5 秒待ってから DELETE する。
   - (e) 更新待ちの間も、有効なリースで新規の infer が始まる。

---

## RT-12: inference probe が running のまま残る

**問題**(`api/domains/inference/service/index.ts` の `startProbe`): 最後の状態 UPDATE が `database_writer_queue_full` などで失敗すると、行が `running` のまま残る。再起動まで `invalid_probe_busy` で新規 probe が拒否される。

**書込許可**: `api/domains/inference/service/index.ts`、`api/domains/inference/test/inference.test.ts`(追記)

**手順**
1. 最終の状態書込み(try の成功側と catch の失敗側の両方)を、`writeWithRetry(fn, 3 回, 200ms→400ms→800ms)` で包む。helper は同ファイル内に置く。
2. busy 判定(`invalid_probe_busy` を投げる箇所)で、running の行の `started_at`(列名は repository を確認)が 10 分より古ければ、その行を `failed / probe_stale` に更新してから新規 probe を開始する。
3. 試験: running の行を 11 分前の時刻で直接 INSERT した状態で `startProbe` が成功し、旧行が `probe_stale` になる。

---

## RT-13: voice の音声 eviction と sessions の TTL

**問題**(`api/domains/voice-dialogue/service/index.ts`)
- `createSpeech` は音声が 8 件以上あると最古の 1 件を、再生待ちの有効な turn であっても `failed / audio_evicted` にし、その run を取消す。
- `sessions` は `stop()` でしか消えない。

**書込許可**: `api/domains/voice-dialogue/service/index.ts`、`api/domains/voice-dialogue/test/voice.test.ts`(追記のみ)

**前提**: §1 によりこのファイルは変更中。クリーンになってから着手する。

**手順**
1. `audio` の各 entry に `createdAt: number`(`clock()` の ms)と、再生を開始したかどうかを持たせる(既存の型に追加)。
2. eviction の対象選びを次の順にする。
   1. 終端状態(再生済み・失敗・取消)の entry。
   2. 未再生かつ作成から 10 分以上経った entry。
   3. どちらも無ければ evict せず、新しい speech を `voice_audio_capacity` で失敗させる(throw)。`error-status.ts` に `voice_audio_capacity: 503` を追加する。
   - 書込許可外なので、この追加は報告して別途行うか、ARC-10 以降は contracts に置く。
3. `sessions` に最終利用時刻を持たせる。`accept`・`preview` など session を使う入口で更新し、30 分以上使われていない session を同じ入口で掃除する(timer は増やさない)。
4. 試験
   - (a) 未再生の 8 件がある状態で 9 件目を作ると、最古の turn は取消されず、9 件目が `voice_audio_capacity` になる。
   - (b) 10 分以上前の未再生 entry があれば、それが evict される。

---

# Phase 3

## SEC-4: LARM claim の provider host を固定

**問題**: claim 応答の `baseURL`・`daemonURL`・`endpoint` は「プライベートアドレスか `.local`」の検査しか受けずに、Bearer token の送り先になる。偽装・侵害された LARM が任意の LAN / loopback の宛先へ credential を送らせられる。

**書込許可**: `api/domains/larm/service/guards.ts`、`playground-http.ts`、`playground.ts`、`connect.ts`、`index.ts`、`api/domains/larm/test/*.test.ts`(追記)

**手順**
1. `guards.ts` に次を追加する。

   ```ts
   export function providerHostAllowed(url: URL, larmBase: URL, extra: readonly string[]): boolean
   ```

   - `url.hostname === larmBase.hostname`、または `extra`(小文字化済み)に含まれれば true。
   - `extra` は `process.env.EUMENES_LARM_PROVIDER_HOSTS`(カンマ区切り)。**env は larm service の生成箇所で 1 回だけ読み、config として注入する。**
2. 次の両方で、provider の URL(`baseURL`・`daemonURL`・`endpoint`)に `providerHostAllowed` を追加で要求する。
   - claim を検証する箇所: `connect.ts` の claim 段階と、`playground.ts` の `invalid_claim_configuration` を投げる付近。
   - `localEndpoint` / `localUrl` を通している箇所。
   - 不一致は `larm_provider_host_mismatch` で throw する。
3. `.local` ホストは、`larmBase` 自身が `.local` の場合か `extra` に明示された場合だけ許可する。`localEndpoint` / `localUrl` から `.local` の無条件許可を外す。
4. 試験
   - (a) claim の `baseURL` が larm と同じ host・別 port なら成功する。
   - (b) 別の RFC1918 host なら `larm_provider_host_mismatch` になる。
   - (c) `EUMENES_LARM_PROVIDER_HOSTS` で許可すれば成功する。
5. README の LARM 節に `EUMENES_LARM_PROVIDER_HOSTS` を 1 行追記する。README は DOC-4 で再構成するので、追記内容を実施記録に残す。

---

## SEC-5: settings: 169.254 の除外と envRef の host 束縛

**問題**
- `settings/contracts/index.ts` の `privateHost` が 169.254(クラウドのメタデータ用アドレス)を含む。
- `envRef=OPENAI_API_KEY` と `baseUrl=https://attacker` を組み合わせると、鍵を任意の host へ送れる。

**書込許可**: `api/domains/settings/contracts/index.ts`、`api/domains/settings/service/index.ts`、`api/domains/settings/test/*.test.ts`(追記)

**手順**
1. `privateHost` から `(a === 169 && b === 254)` を削除する。
2. `service/index.ts` の `knownProviderKeys` を、配列から **host 規則つきの表** に変える。

   ```ts
   const providerKeyHosts: Record<string, (host: string) => boolean> = {
   	OPENAI_API_KEY: (h) => h === "api.openai.com",
   	ANTHROPIC_API_KEY: (h) => h === "api.anthropic.com",
   	GEMINI_API_KEY: (h) => h === "generativelanguage.googleapis.com",
   	GOOGLE_API_KEY: (h) => h === "generativelanguage.googleapis.com",
   	AZURE_OPENAI_API_KEY: (h) => h.endsWith(".openai.azure.com"),
   	GROQ_API_KEY: (h) => h === "api.groq.com",
   	MISTRAL_API_KEY: (h) => h === "api.mistral.ai",
   	DEEPSEEK_API_KEY: (h) => h === "api.deepseek.com",
   };
   ```

   - 配列に他のキーがあれば、公式 API の host を調べて同様に追加する。不明なら報告する。
3. `isAllowedEnvRef(name, allowlist)` を `isAllowedEnvRef(name, allowlist, baseUrl: string)` に変える。
   - `EUMENES_CLOUD_*` と `EUMENES_ENV_REF_ALLOWLIST` のキー: host 不問で true(利用者が明示したもの)。
   - `providerKeyHosts` のキー: `new URL(baseUrl).hostname` が規則を満たすときだけ true。
   - 呼出し元(保存時の `invalid_env_ref` と解決時の `env_ref_not_allowed`)を追従させる。前回 S1 の互換方針(保存済みで変更のない envRef は保存を妨げず、利用時に失敗させる)を維持する。
4. 試験
   - (a) `OPENAI_API_KEY` + `https://api.openai.com/v1` は可。
   - (b) `OPENAI_API_KEY` + `https://evil.example` は保存時に `invalid_env_ref`。
   - (c) 既に保存済みの (b) は利用時に `env_ref_not_allowed`。
   - (d) `http://169.254.169.254` は `cloudEndpoint` で拒否される。

---

## SEC-6: settings 暗号文に AAD(前回の見送りを解除)

**問題**: AES-256-GCM に AAD が無く、DB に書ける者が行間で暗号文を入れ替えられる。

**書込許可**: `api/domains/settings/service/index.ts`、`api/domains/settings/test/*.test.ts`(追記)

**手順**
1. `settings_credentials` の主キー列名を repository で確認する(以下 `rowKey`。接続 id など)。
2. 新しい形式 `v2.<iv>.<tag>.<bytes>` を導入する。
   - `encrypt(value, rowKey)` は `c.setAAD(Buffer.from(\`eumenes:settings:v2:${rowKey}\`))` を設定して v2 形式で返す。
   - `decrypt(value, rowKey)` は、先頭が `v2.` なら同じ AAD で復号し、そうでなければ従来の AAD なし形式(v1)として復号する。
3. 起動時の既存暗号文検査ループ(`for (const row of ... SELECT encrypted ...)`)を `SELECT <rowKey>, encrypted` に変える。
   - v1 の行を見つけたら、復号して v2 で暗号化し直し、**1 つの `store.write` transaction で** UPDATE する。
   - 失敗したら key を無効化する既存挙動(`secret_key_unavailable`)に合流させる。
4. encrypt / decrypt の呼出し元すべてに `rowKey` を渡す(`grep -n "encrypt(\|decrypt(" service/index.ts`)。
5. 試験
   - (a) v2 の暗号文を別の行にコピーすると復号に失敗する。
   - (b) v1 の行を持つ DB で起動すると v2 に移行され、値が変わらない。
   - (c) 移行後に再起動しても正常に動く。

---

## SEC-7: DB と鍵のファイル権限、鍵の配置

**書込許可**: `api/infrastructure/sqlite/index.ts`、`api/domains/settings/service/index.ts`、関連試験、`README.md`(該当 1 文)

**手順**
1. `openStore` で migration の writer を開いた直後に、`chmodSync(canonical, 0o600)` を実行する。`-wal`・`-shm` が存在すれば、それらも同様にする。
   - 親ディレクトリの mode が group または other から読める(`stat.mode & 0o077`)場合は、`log.warn("sqlite.directory_permissive", { reason: "directory_permissive" })` を出す。起動は止めない(既存環境のため)。
2. settings の鍵ディレクトリを `EUMENES_KEY_DIR` で変更できるようにする。既定は従来どおり `<dbDir>/keys`。
   - `createSettings` の options に `keyDir?: string` を追加し、`server.ts` から env を渡す。`server.ts` は書込許可外なので、ARC-12 で config に統合するまでの間の 1 行追加として報告する。
   - SEC-2 の `api.token` も同じ `keyDir` を使うよう `auth-config.ts` を合わせる。書込許可外なので、SEC-2 と同一作業者で行うこと。
3. README に「バックアップで DB と鍵を同時に持ち出さないために、`EUMENES_KEY_DIR` を DB ディレクトリの外に置くことを推奨」と 1 文追記する。
4. 試験: 新規 DB の mode が 0600。`EUMENES_KEY_DIR` を指定すると鍵がそこに作られる。

---

## SEC-8: 生の error.message を保存・返却・ログしない

**問題**: `voice-dialogue/service/index.ts` の 466 行付近の `error: error instanceof Error ? error.message : "voice_failed"` が、生の文字列を turn 記録に保存し、`GET /api/voice/turns/:id` で返している。`scheduler/service/index.ts` の 386 行付近と `queue/service/registry.ts` の 10 行付近も、値から文字列を組み立てている。

**書込許可**: `api/domains/voice-dialogue/service/index.ts`、`api/domains/scheduler/service/index.ts`、`api/domains/queue/service/registry.ts`、`api/infrastructure/error-code.ts`(新規)と試験、各 domain の試験(追記)

**手順**
1. `api/infrastructure/error-code.ts` を作る。

   ```ts
   const codePattern = /^[a-z][a-z0-9_:]{0,100}$/;
   /** Machine-readable code only; anything else collapses to the fallback. */
   export function toErrorCode(error: unknown, fallback: string): string {
   	const m = error instanceof Error ? error.message : typeof error === "string" ? error : "";
   	return codePattern.test(m) ? m : fallback;
   }
   ```

   - queue に前回 S3 で入れた `toErrorCode` が既にあれば、それをここへ移して再利用する。移すときは queue の import を追従させる。
2. voice の該当箇所を `toErrorCode(error, "voice_failed")` にする。457 行付近の独自正規表現も同関数に置き換える。
3. scheduler と queue/registry の該当行を読み、値(id や入力)を連結した文字列を作っているなら、固定のコードにする。値の情報はログの fields(`id` などの許可キー)に分ける。
4. RT-1・RT-2・RT-3・RT-6 で作った小関数 `code()` を、この `toErrorCode` に置き換える(それらの WP の完了後に行う)。
5. 試験: voice の処理が `new Error("connect ECONNREFUSED 192.168.0.2:9810")` で失敗したとき、turn の `error` が `voice_failed` になる。

---

## SEC-10: coding-runner の host git 硬化と network 方針の強制

**問題**(現状は本番の隔離が未実装で到達不能だが、隔離を有効にすると問題になる)
- host 側の git 実行は、sandbox 内の agent が書ける `.git/config`・hooks・`.gitattributes` の filter を無効化していない。
- `snapshot()` は `ls-files --exclude-standard` を使うので、`.git/info/exclude` で隠したファイルがレビューから漏れる。
- `spec.network` を `worker.ts` が使っていない。

**書込許可**: `packages/coding-runner/src/workspace.ts`、`git-operations.ts`、`worker.ts`、`packages/coding-runner/test/**`(追記)

**手順**
1. `gitBytes` の env に `GIT_CONFIG_GLOBAL: "/dev/null"`、`GIT_CONFIG_SYSTEM: "/dev/null"`、`GIT_ATTR_NOSYSTEM: "1"` を追加する。
   - args の先頭(`-C path` の後)に次を追加する。

   ```
   -c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.ext.allow=never -c core.attributesFile=/dev/null
   ```

2. workspace 作成時(作成関数を `workspace.ts` で特定する)に、次を runner の storage に記録する。
   - `.git/config` の sha256
   - `.git/hooks` 配下のファイル一覧(空であることを期待)
   - 以後 `git-operations.ts` の各 host git 呼出しの前に照合し、不一致なら `runner_git_config_tampered` で失敗させる。
   - 照合は `verifyGitIntegrity(path)` として 1 箇所にまとめる。
3. `.gitattributes` に `filter=` を含む行があれば、`runner_git_filter_forbidden` で失敗させる(clean / smudge filter の実行を防ぐ)。
4. `snapshot()` で、`git ls-files --others --ignored --exclude-standard` と、`--exclude-standard` を外した一覧の差分を取る。workspace の `.gitignore` に由来しない ignored ファイル(`.git/info/exclude`・`core.excludesFile` 由来)があれば、`runner_hidden_files` で失敗させる。
5. `worker.ts` で、`spec.network === "registered"` の場合、隔離層が network 制御を提供していなければ `runner_network_policy_unsupported` で起動を拒否する。2026-10-10 時点では提供していないので常に拒否する。`"none"` は従来どおり。
6. 試験(fixture mode で)
   - (a) `.git/config` を書き換えると次の git 操作が `runner_git_config_tampered`。
   - (b) `.gitattributes` に filter があると拒否。
   - (c) `.git/info/exclude` で隠したファイルがあると `runner_hidden_files`。
   - (d) `network: "registered"` の spec が拒否される。

**検証**: `bun test packages/coding-runner/test`

---

## SEC-11: supervisor 指示の承認ゲート

**問題**: リポジトリ内の文書や CLI 出力(観測)が supervisor LLM を誘導できる。生成された `instruction`(最大 4000 字)がそのまま Codex に渡る。

**書込許可**: `api/domains/coding-supervision/**`、`api/domains/settings/contracts/index.ts`(設定 1 項目の追加のみ)、`web/src/domains/settings/**`(トグル 1 つ)、`api/domains/coding-supervision/test/**`

**手順**
1. **調査(実装前に必ず行う)**: `coding-supervision/service/index.ts` を読み、次を特定する。報告にも記載すること。
   - `decisionSchema` の `action` ごとの処理。
   - `escalate` がどのような状態遷移になり、ユーザーがどう応答するか(API と UI)。
2. 設定 `codingSupervision.approveInstructions: boolean`(既定 **true**)を settings の schema に追加する。既存の schema の追加方法・既定値・migration 方針に従う。
3. `request_change` と `answer_question` の decision で設定が true のとき:
   - Codex への step を enqueue せず、既存の escalate と同じ「ユーザー待ち」状態に遷移させる。理由コードは `instruction_approval_required`。`instruction` の本文はユーザーが確認できるよう task の記録に保存する(既存の evidence や report の仕組みを使う)。
   - ユーザーが承認したら、保存した `instruction` で step を enqueue する。却下なら escalate の却下と同じ扱いにする。
   - escalate の応答 API に「承認 / 却下」を表す値が無ければ、contracts に追加する。
4. Codex に渡す `instruction` を、次の固定の枠で包む。

   ```
   以下は監督AIが生成した指示です。許可された作業範囲(grant)の外の変更・外部送信・認証情報の参照は行わないこと。
   ---
   <instruction>
   ```

5. 試験
   - (a) 設定 true で `request_change` が承認待ちになり、Codex step が enqueue されない。
   - (b) 承認すると、元の指示を枠で包んで enqueue する。
   - (c) 設定 false では従来どおり。

---

## SEC-12: `allow_with_warning` のページを拒否

**書込許可**: `api/domains/web-research/adapters/llm-fetch.ts`、`api/domains/web-research/test/*.test.ts`(追記)

**手順**
1. `doc.security.decision !== "allow" && doc.security.decision !== "allow_with_warning"` を `doc.security.decision !== "allow"` に変える。
2. 試験: decision が `allow_with_warning` の fixture で `GUARD_DENIED` になる。既存の試験に `allow_with_warning` を許可前提としたものがあれば、報告してから期待値を更新する。この WP は「挙動変更あり」。

---

## SEC-13: dev.ts から Vite へ渡す env の最小化

**前提**: SEC-1 と SEC-2 が完了していること(SEC-2 以降、Vite は LARM token を必要としない)。

**書込許可**: `scripts/dev.ts`、`vite.config.ts`

**手順**
1. `scripts/dev.ts` で Vite を起動するときの `env` を、次の許可リストだけにする。

   ```
   PATH, HOME, TMPDIR, LANG, TERM, NODE_ENV, EUMENES_API_TOKEN(SEC-2 で解決した値を入れる),
   EUMENES_ORIGIN, EUMENES_PROXY_URL, EUMENES_DB, EUMENES_KEY_DIR, EUMENES_VITE_CACHE_DIR
   ```

   - backend の起動 env は従来どおりとする。
2. `vite.config.ts` の `loadEnv(mode, process.cwd(), "")` は `.env` の全キーを読む。`EUMENES_` で始まるキーだけを取る形 `loadEnv(mode, process.cwd(), "EUMENES_")` に変える。
   - LARM token が不要なことを確認する: `resolveApiToken` が `EUMENES_API_TOKEN` かファイルで解決できること。
3. 確認: `bun run dev` で画面が動く。Vite のプロセス env に `LARM_API_TOKEN` が無いこと(`ps eww <pid>` などで確認)。

---

## SEC-14: 高コスト endpoint の同時実行上限

**書込許可**: `api/infrastructure/concurrency.ts`(新規)と試験、`api/application/app.ts`

**手順**
1. `concurrency.ts` に middleware factory を置く。

   ```ts
   export function limitConcurrency(max: number, code = "too_many_requests") { let active = 0; return async (c, next) => { if (active >= max) return c.json({ error: code }, 429); active++; try { await next(); } finally { active--; } }; }
   ```

   - SSE のように応答 body が長く続くものには使わない。
2. `app.ts` で認証 middleware の後に、route group ごとに適用する。
   - `/api/service-tests/*` に 2
   - `/api/voice/replay/*` と `/api/voice/sample` に 2
   - `/api/inference/probes*` に 1(実際のパスは各 controller の `app.post` を grep して確認する)
3. `error-status.ts` に `too_many_requests: 429` を追加する。
4. 試験: 遅延させた handler に 3 並列で要求し、3 つ目が 429 になる。

---

# Phase 4

## WEB-2: reset 時の全 invalidate の範囲を絞る・QueryClient・staleTime

**問題**(`web/src/App.tsx`)
- 引数なしの `cache.invalidateQueries()` が、実プロバイダを叩く診断系(`settingsDiagnostics`・`inferenceProbes`・`larmVoices`)まで再取得する。該当は SSE の reset・再接続成功時・設定保存時。
- `QueryClient` を `useMemo` で作っている。

**書込許可**: `web/src/App.tsx`、`web/src/queryKeys.ts`、`web/src/queryKeys.test.ts`(新規)

**手順**
1. `queryKeys.ts` に live provider 系の root 一覧と、それ以外を全部 invalidate する関数を追加する。

   ```ts
   export const liveProviderRoots = [queryRoots.settingsDiagnostics, queryRoots.inferenceProbes, queryRoots.larmVoices] as const;
   export function invalidateAllButLive(cache: QueryClient) {
   	return cache.invalidateQueries({ predicate: (q) => !liveProviderRoots.includes(q.queryKey[0] as never) });
   }
   ```

   - live provider 系は `cache.invalidateQueries({ queryKey: [root], refetchType: "none" })` で stale 印だけ付ける(次に開いたとき取得される)。
2. `App.tsx` の 3 箇所の `cache.invalidateQueries()` を `invalidateAllButLive(cache)` に置き換える(reset・`reconnect.onSuccess`・`SettingsPage onSaved`)。
3. `App()` の `useMemo(() => new QueryClient(...), [])` を `useState(() => new QueryClient(...))[0]` に変え、`defaultOptions.queries.staleTime: 2_000` を追加する。`store` と `client` も同様に `useState` の初期化関数にする。
4. 試験: QueryClient にダミーの query(`settings` と `settings-diagnostics`)を入れ、`invalidateAllButLive` 後に前者だけが fetch されること。

---

## WEB-3: timers のポーリング廃止

**問題**: README は「定期取得なし」としているが、`useTimerArtifacts.ts` は 5 秒と 2 秒、`TimerNotifications.tsx` は 1 秒で polling している。SSE の change でも同じ root を invalidate するため、取得が重なる。

**書込許可**: `web/src/domains/timers/useTimerArtifacts.ts`、`web/src/components/domains/timers/TimerNotifications.tsx`、`web/src/domains/timers/test/*`、`tests/browser/timers.spec.ts`

**手順**
1. **方針**: サーバーの状態変化は SSE の `change` で invalidate される(`changeRoots` に `timers` が含まれる)。残る必要は「期限到来の瞬間」だけで、これは deadline timer で 1 回だけ再取得すれば足りる。
2. `useTimerArtifacts.ts` の変更
   - `active` query の `refetchInterval` を削除する。
   - 代わりに `useEffect` で、`active.data.items` の最も早い期限(item の期限のフィールド名は client の型で確認する)に対して `setTimeout(() => cache.invalidateQueries({queryKey:[queryRoots.timers,"workspace"]}), dueMs - now + 250)` を 1 本だけ張り、cleanup で clear する。
   - `receipts` の `refetchInterval: 2000` を削除する。`watched` に追加された時点で 1 回取得し、以後は SSE に任せる。
3. `TimerNotifications.tsx` の 1 秒 polling も同様に、`serverNow` と item の期限から次の変化時刻を計算する deadline timer に置き換える。
   - 残り時間の表示(秒の countdown)が必要なら、取得ではなく `useNow(1000)` 相当のローカル時計で描画する(再取得はしない)。
4. 試験(vitest): fake timers で、active な timer があっても 10 秒間に fetch が 1 回(初回)だけで、期限を過ぎると 1 回追加されること。
5. `bunx playwright test tests/browser/timers.spec.ts` が通ること。落ちる場合、SSE が届く前提の待ち方(`expect.poll`)に直す。

**受入条件**: 上記の試験が成功し、README の「定期取得なし」と実装が一致する。

---

## WEB-4: 画面の遅延読込と chunk 分割

**問題**: main bundle が 762KB。設定画面・世界モデル・研究経路・サービス試験を全部 eager に import している。

**書込許可**: `web/src/App.tsx`、`vite.config.ts`、`web/src/domains/settings/index.tsx`(export 形の調整のみ)

**手順**
1. `App.tsx` の `SettingsPage`、`ServiceTestsPanel`、`ResearchRoutesPanel`、`WorldPanel` の静的 import を `React.lazy` に変える。

   ```ts
   const SettingsPage = lazy(() => import("./domains/settings").then((m) => ({ default: m.SettingsPage })));
   ```

   - `useSettings` と `useVoiceMute` は会話画面でも使うので静的 import のまま残す。同じ module から lazy と static の両方で import すると分割されないので、`web/src/domains/settings/index.tsx` から `SettingsPage` を別ファイル(`SettingsPage.tsx`)経由で export する形に分ける。
   - 描画箇所を `<Suspense fallback={<p role="status">読み込み中…</p>}>` で囲む。WEB-1 の ErrorBoundary の内側に置く。
2. `vite.config.ts` の `build.rollupOptions.output.manualChunks` で vendor を分ける。
   - `react`・`react-dom` → `react`
   - `@tanstack` → `query`
   - `zod` → `zod`
   - `@radix-ui` → `radix`
3. `bun run build:web` の出力で、`index-*.js` が 400KB 未満になったことを確認する。sizes を実施記録に残す。
4. `bunx playwright test` が通ること(設定画面を開く spec が lazy 読込みを待てること)。

---

## WEB-5: avatar の遅延 import と非表示時の一時停止

**問題**(`web/src/components/domains/conversation/LightAvatarBackground.tsx`)
- 572KB の three.js chunk を初回描画で読み込む。
- タブ非表示や reduced-motion の切替えで、`release()` によりモデルと shader を毎回作り直す。
- `createAvatarPlayback(model, ...)` を `if (!model)` の判定より前に呼んでいる。

**書込許可**: `LightAvatarBackground.tsx`、その試験(既存があれば追記)、`web/src/components/domains/conversation/light-avatar/*.d.ts`(型が必要なら)

**手順**
1. import を初回描画後のアイドル時に遅らせる。`requestIdleCallback`(無ければ `setTimeout(…, 1500)`)の中で `import("./light-avatar/model.js")` を開始する。
2. effect の依存を分ける。
   - **生成と破棄**は `active` のみに依存させる。設定画面を開いたときに canvas を解放する、前回 F0 で検証済みの挙動を保つ。
   - **`visible` と `reduced`** は別の effect で `playback.current?.pause()` / `resume()` / `setReduced()` を呼ぶ。`createAvatarPlayback` の返り値にこれらの関数が無ければ、`light-avatar/motion.js` の render loop を止める・再開する関数を追加する。追加する場合は、`motion.js` と `.d.ts` も書込許可に含めてよい。
3. `.then` 内の順序を `model = createLightAvatar(element); if (!model) return;` → `createAvatarPlayback(model, ...)` に直す。
4. 確認
   - `bunx playwright test tests/browser/voice.spec.ts` の avatar 関連が通る。
   - DevTools の Network で、初回描画直後に three の chunk が読まれず、アイドル後に読まれる。

---

## WEB-7: describeError の DOMException 対応と raw 文字列の排除

**書込許可**: `web/src/errorMessages.ts`、`web/src/domains/voice-dialogue/hooks/index.ts`(該当箇所のみ)、`web/src/errorMessages.test.ts`(既存に追記)

**手順**
1. `describeError` の先頭で、`e instanceof DOMException`(または `e.name` を持つ Error)の場合に name で対応付ける。
   - `NotAllowedError` → 「マイクの使用が許可されていません。ブラウザの設定を確認してください。」
   - `NotFoundError` → 「マイクが見つかりません。」
   - `NotReadableError` → 「マイクを他のアプリが使用中です。」
   - `OverconstrainedError` → 「選択したマイクが使えません。」
   - `AbortError` → 「操作が中断されました。」
2. 末尾の `` `エラーが発生しました(${text.slice(0, 80)})` `` と ApiError 版の `` `エラーが発生しました(${e.message || e.status})` `` を次に変える。
   - **snake_case のコードのときだけ** `エラーが発生しました(コード: ${code})` にする。
   - それ以外は「エラーが発生しました。」だけにする(英語の例外文を UI に出さない)。
3. `voice-dialogue/hooks/index.ts` の 454〜458 行付近で、`error.message` を直接表示している箇所を `describeError(error)` に置き換える。
4. 試験: 各 DOMException name の文言。英文の Error は「エラーが発生しました。」になる。`larm_inference_409` はコード付きになる。

---

## WEB-8: MessageList の読上げ(live region)

**問題**(`MessageList.tsx`)
- 最後の assistant メッセージの先頭 80 字を常に live region に入れているので、初回読込の古い履歴でも読み上げる。
- 同じ文の回答は再度読み上げない。

**書込許可**: `web/src/components/domains/conversation/MessageList.tsx`、その試験

**手順**
1. `useRef<string | null>` で「最後に通知した message id」を持つ。
   - 初回描画(ref が未初期化)では、現在の最後の assistant id を記録するだけで通知しない。
   - 以後、`!streaming` で最後の assistant id が記録と異なるときだけ、`announcement` を `{id, text}` で更新する。
2. live region の要素に `key={announcement.id}` を付け、同じ文でも id が違えば読み上げられるようにする。
3. 描画する履歴の件数を最新 200 件に制限し、それより前がある場合は「以前の会話を表示」ボタンで全件にする(仮想化は行わない)。
4. 試験
   - (a) 初回描画では live region が空。
   - (b) 新しい assistant メッセージが来ると、その先頭 80 字が入る。
   - (c) 同じ文で別 id のメッセージでも入る。

---

## WEB-9: Subtitle と TimerNotifications の live region

**書込許可**: `web/src/components/domains/subtitle/Subtitle.tsx`、`web/src/components/domains/timers/TimerNotifications.tsx`(WEB-3 と同一作業者)、各試験

**手順**
1. `TimerNotifications` の通知カード一覧の容器に `role="status" aria-live="polite"` を付ける。期限到来の通知の見出しは、`role="alert"` の要素で描画する(既に `NotificationCard` が持っていれば重複させない。持っているかを最初に確認する)。
2. `Subtitle` は読み上げ中の音声と重複するので、`aria-hidden="true"` を付けて二重読みを避ける。これは字幕であり、音声と同じ内容のため。
3. 試験: timer 完了の通知が `role="alert"` で取得できる。

---

## WEB-10: VAD・worklet・部分認識の効率化

**問題**
- 無音判定の既定値が controller(700ms)と voice-activity(1500ms)で食い違っている。
- RMS 閾値(0.008)が固定で、背景雑音に追従しない。
- worklet が 128 sample ごとに postMessage している。
- 部分認識のたびに、発話全体(最大 10 秒)を 0.6 秒間隔で再送している。

**書込許可**: `web/src/domains/audio/**`(controller・worklet・voice-activity・その試験)

**手順**
1. 無音判定の既定値を 1 箇所の定数 `DEFAULT_SILENCE_MS = 700` にまとめる。voice-activity 側の既定値を `grep -rn "1500" web/src/domains/audio` で特定し、この定数を参照させる。
2. 背景雑音への追従: 発話外の区間で RMS の指数移動平均 `noiseFloor = 0.95*noiseFloor + 0.05*rms` を持ち、閾値を `max(0.008, noiseFloor * 3)` にする。
   - 純関数として voice-activity に置き、単体試験を付ける。静かな入力と、雑音の多い入力の 2 通り。
3. worklet での束ね: `recorder.worklet.ts` で 2048 sample まで内部バッファに貯めてから postMessage する。主スレッド側で束ねている処理(前回 F5)は、2048 sample を受け取るだけにする。
   - ScriptProcessor 版の fallback も 2048 sample を渡すことを確認する。
4. 部分認識の間隔を、発話長に応じて伸ばす: `interval = 600ms + 0.1 × 現在の発話長(ms)`、上限 2000ms。protocol は変えない。
5. 試験: 既存の audio 試験が通る。上記の純関数の試験を追加する。

---

## WEB-11: light-avatar JS と packages を型検査

**書込許可**: `tsconfig.json`、`web/src/components/domains/conversation/light-avatar/*.js`(JSDoc 追加のみ)、`*.d.ts`、`packages/artifact-ui/**` と `packages/coding-runner/**`(型エラーの修正のみ)

**手順**
1. `tsconfig.json` の `include` に `"packages/artifact-ui/src"` と `"packages/coding-runner/src"`、`"packages/coding-runner/test"` を追加し、`bun run typecheck` のエラーを修正する。
   - design-system は独自の tsconfig を持つので含めない。代わりに TST-1 で `bun run --cwd packages/design-system typecheck` を verify に追加する。
2. `light-avatar/model.js` と `motion.js` の先頭に `// @ts-check` を付ける。`tsconfig.json` に `"allowJs": true, "checkJs": false` を追加する(`@ts-check` を付けたファイルだけが検査される)。
3. 出たエラーを JSDoc(`/** @param {THREE.Scene} scene */` など)で解消する。手書きの `.d.ts` は、JS 本体と矛盾しないことを確認してから残すか削除する。
4. `bun run typecheck` が成功すること。

---

## WEB-12: artifact-ui 画像の URL scheme と拡張子

**書込許可**: `packages/artifact-ui/src/components.tsx`、`packages/artifact-ui/src/contracts.ts`、`packages/artifact-ui/test/*.test.tsx`(新規。vitest の include に入っていなければ `web/src/domains/artifact/test/` に置く)

**手順**
1. `contracts.ts` の `ImageResource.url` を `z.string().refine(isSafeImageUrl)` にする。`isSafeImageUrl` は `https:`・`blob:`・`data:image/(png|jpeg|webp|svg+xml);` だけを許可する。
2. `components.tsx` の 190 行付近の `download="generated-image.svg"` を、`mimeType`(無ければ URL の拡張子)から `generated-image.<png|jpg|webp|svg>` を導く形にする。
3. 試験: `javascript:` の URL が schema で拒否される。PNG の mime で `download` が `.png` になる。

---

## WEB-13: Markdown のリンク先 hostname 表示

**書込許可**: `web/src/components/domains/conversation/markdownRenderer.ts`、その試験

**手順**
1. リンクを描画する箇所(24 行付近)で、表示テキストが URL の hostname を含まない場合に、テキストの後ろに `<span class="link-host">(${hostname})</span>` を付ける。escape は既存の関数を使う。
2. CSS(`app.css`)に `.link-host { color: var(--muted); font-size: .85em; }` 相当を追加する。design token 名は既存の CSS を確認すること。`app.css` もこの WP の書込許可に含める。
3. 試験: `[公式サイト](https://phish.example/)` が「公式サイト(phish.example)」と描画される。`[https://a.example](https://a.example)` には付かない。

---

# Phase 5

## TST-1: verify:all に design-system の試験と型検査を追加

**書込許可**: `scripts/verify.ts`

**手順**
1. `if (all) {` の試験群で、`web tests` の後に次の 2 段を追加する。

   ```ts
   await run("design-system typecheck", [process.execPath, "run", "--cwd", "packages/design-system", "typecheck"]);
   await run("design-system tests", [process.execPath, "run", "--cwd", "packages/design-system", "test"]);
   ```

2. `bun run verify:all` を実行し、design-system の 59 ファイルが実行されることを確認する。
   - 失敗が出たら直さずに一覧を報告する。既存の不具合は別 WP にする。

---

## TST-2: スクリーンショットの出力先を分離

**問題**: Playwright が `spec/verification/**.png`(git 管理)を毎回上書きし、比較もしない。git の差分が常に出る。

**書込許可**: `tests/browser/evidence.ts`(新規)、`tests/browser/*.spec.ts` のスクリーンショット箇所

**前提**: §1 により `toolchain.spec.ts` がクリーンになってから着手する。

**手順**
1. `tests/browser/evidence.ts` を作る。

   ```ts
   import { resolve } from "node:path";
   /** Evidence images go to test-results unless explicitly recorded into spec/verification. */
   export function evidencePath(relative: string): string {
   	const base = process.env.EUMENES_RECORD_EVIDENCE === "1" ? "spec/verification" : "test-results/evidence";
   	return resolve(base, relative);
   }
   ```

2. 全 spec の `path: "spec/verification/<x>"` と `resolve("spec/verification/<dir>")` を `evidencePath("<x>")` / `evidencePath("<dir>")` に置き換える。対象は `grep -rn "spec/verification" tests/browser`。
3. `docs/acceptance.md` の冒頭付近に、証跡画像の更新手順 `EUMENES_RECORD_EVIDENCE=1 bunx playwright test` を 1 行追記する。`docs/acceptance.md` もこの WP の書込許可に含める。
4. 確認: `bunx playwright test` の実行後に `git status --short spec/verification` が空。

---

## TST-3: Playwright の固定 sleep を排除

**書込許可**: `tests/browser/voice.spec.ts`、`tests/browser/timers.spec.ts`

**手順**
1. `grep -n "waitForTimeout" tests/browser/*.ts` の各箇所(voice 6 件・timers 1 件)を分類し、次の方針で置き換える。
   - 「何かが起きる」のを待つもの → `await expect.poll(() => <条件>).toBe(...)` か locator の `toBeVisible()` など。
   - 「何も起きない」ことを確かめるもの(再取得されない等) → `page.route` で該当 API の要求回数を数える counter を置く。一定時間を待つ代わりに、**後続の別のイベント**(例: 次の操作の応答)を待ってから counter を検証する。
     - 時間経過そのものが条件の場合だけ `page.clock.install()` と `page.clock.runFor(ms)` を使う。
   - canvas スクリーンショットの比較(voice.spec 169〜178 行付近): 250ms 間隔の 2 枚の比較を、`page.clock` で時間を進めてからの比較にする。または、avatar 側が `data-avatar-frame` などの描画カウンタを公開していれば、その増加を `expect.poll` で見る。
2. 3 回連続で `bunx playwright test tests/browser/voice.spec.ts tests/browser/timers.spec.ts` が通ること。所要時間の短縮を実施記録に残す。

---

## TST-4: 単体試験の実時間 sleep を排除

**書込許可**: `api/domains/larm/test/larm.test.ts`、`api/domains/queue/test/queue.test.ts`、`api/domains/dialogue/test/queue.test.ts`。注入点が無い場合だけ、該当 service の options への `now` / `pause` 追加(larm・queue の service)

**手順**
1. `grep -n "setTimeout\|Bun.sleep\|sleep(" <上記3ファイル>` で実時間待ちを列挙する(larm 882・918・923・1061・1063・1101 行付近、queue 421 行付近、dialogue/queue 146 行付近)。
2. 各 service が `now` / `pause` / `sleep` を options で受け取るか確認する。
   - 受け取るなら、試験で手動 clock(`let t = 0; const now = () => t;`)を渡し、`t += 70` で進める。
   - 受け取らなければ options に追加し、既定値は従来の実装にする。
3. 試験の意図(lease TTL の前後など)を変えないこと。3 回連続で通ること。

---

## TST-5: Playwright の起動・停止の堅牢化

**問題**
- 各 spec が API・LARM fixture・Vite を個別に起動している。
- `fixturePorts()` が port を解放してから子が bind するまでの間に競合がある。
- `afterAll` は bun の親プロセスにしか SIGTERM を送らず、vite が孤児になる。

**書込許可**: `tests/browser/fixture.ts`(新規)、`tests/browser/*.spec.ts` の起動・停止部分、`playwright.config.ts`

**手順**
1. 各 spec に重複している起動コード(`fixturePorts`・`launch`・`ready`・`afterAll` の kill)を `tests/browser/fixture.ts` に抽出する。
   - spec ごとの差分(env など)は引数にする。
   - **挙動は変えない。** まず抽出だけで全 spec が通ることを確認してから、次の手順へ進む。
2. `launch` で `spawn(..., { detached: true })` にし、停止は `process.kill(-child.pid, "SIGTERM")`(プロセスグループ全体)にする。200ms 後に生存していれば `-pid` に SIGKILL を送る。
3. port の競合: `fixturePorts` は、確保した server を **子が起動する直前まで閉じない**。閉じた直後に起動するよう順序を変える。根本対策として backend が `EUMENES_PORT=0` に対応していれば、起動ログの `server.listening` の port を読む方式にする。対応していなければ現状維持とし、報告する。
4. `playwright.config.ts` に `retries: process.env.CI ? 1 : 0`、`reporter: [["list"], ["html", { open: "never" }]]`、`workers: 1` を追加する(fixture が重いため)。
5. 3 回連続で `bunx playwright test` が通り、終了後に `pgrep -f "vite --host 127.0.0.1 --port"` が空。

---

## TST-6: client SDK の契約試験

**問題**: `client/` の 23 ファイルのうち 17 モジュールに試験が無い(settings・timers・world・tasks・research-routes など)。

**書込許可**: `client/test/**`(新規)、`vitest.config.ts`(include に `client/**/*.test.ts` を追加)

**手順**
1. 各モジュールについて、`fetch` を差し替えた transport(既存の `client/transport` の試験の作り方をまねる)で次の 3 点を確かめる。
   - 正常な応答が zod で parse されて型どおり返る。
   - schema 違反の応答で client 固有のエラーになる。
   - 4xx の `{error}` が `ApiError` の `message` になる。
2. 応答の fixture は、backend の contracts の型を満たす最小の JSON を手で書く。
3. `bunx vitest run client` が通ること。

---

## TST-7: CLI のコマンド分割とプロセス試験

**書込許可**: `cli/**`、`api/application/cli.test.ts`(追記)

**手順**
1. `cli/index.ts`(630 行の `if (command === ...)` 連鎖)を、`cli/commands/<name>.ts` に分割する。
   - 各ファイルは `export async function run(args, io): Promise<number>` の形にする。
   - `index.ts` は引数解析と `commands[name]` の振分けだけにする。
   - **出力と終了コードは変えない(挙動変更なし)。**
2. `cli/index.ts` が `api/...` から import しているのは contracts と `auth-config` だけであることを確認する(前回 D4 の layer 規則)。
3. `cli.test.ts` に、未試験のコマンド(`collection`・`timer`・`memory`・`send --wait`)について、fixture backend を相手にしたプロセス試験を追加する。既存の `web` コマンドの試験の起動方法をまねる。確認するのは終了コードと `--json` 出力の形。

---

## TST-8: 未試験 UI の試験追加

**書込許可**: 各対象の隣の `test/` か `*.test.tsx`(新規)

**対象と確認事項**
1. `web/src/domains/tts-dictionary/index.tsx`
   - 409 時の再読込案内
   - 重複行の検出
   - paging
   - 5xx 時の文言(現状は「APIの接続を確認してください」に潰れている。`message()` を `describeError` 経由に変える。この 1 関数の変更も書込許可に含める)
2. `web/src/domains/settings/sections/cloud-add.tsx`: 必須入力・https 規則のエラー表示・保存成功
3. `larm-connection.tsx`: 状態ごとの表示
4. `voice-devices.tsx`: device が無いとき・選択の保存
5. `web/src/components/domains/world/ClaimDrawer.tsx`: 開閉・訂正送信・失敗表示
6. `App.tsx`: 起動時の smoke 試験。会話欄が描画され、設定ボタンで設定画面に切り替わる。client は mock

各 1〜4 ケースでよい。`bunx vitest run web` が通ること。

---

## TST-9: Chromium の偽メディアによる worklet 経路の試験

**書込許可**: `tests/browser/voice-media.spec.ts`(新規)、`tests/browser/fixtures/speech.wav`(新規。既存の試験用 WAV があればそれをコピー)

**手順**
1. `test.use({ launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`] } })` で起動する。
2. TST-5 の `fixture.ts` で backend・LARM fixture・Vite を起動し、「音声を開始」を押す。AudioWorklet 経由で turn が 1 件 upload され、文字起こしが表示されることを確認する。`getUserMedia` の差し替えは使わない。
3. 実機器の受入ではないことを spec 冒頭のコメントに書く。

---

# Phase 6

## ARC-1: ファイル・関数サイズの ratchet

**目的**: 巨大な単一クロージャの増加を止める。oxlint の `--deny-warnings` では warning 段階の導入ができないため、基準値を超えた **増加だけ** を失敗にする独自の検査を置く。

**書込許可**: `scripts/size-budget.ts`(新規)、`scripts/size-budget.json`(新規・生成物)、`scripts/verify.ts`、`package.json`(script 1 行)

**手順**
1. `scripts/size-budget.ts` を作る。
   - `api`・`web/src`・`client`・`cli`・`packages/*/src` の非試験 `.ts` / `.tsx` を TypeScript compiler API(`scripts/boundaries.ts` と同じく `ts.createSourceFile`)で走査する。
   - 次の 2 種類を集計する。
     - ファイル行数
     - 関数(function 宣言・関数式・アロー関数)の行数
   - しきい値はファイル 800 行・関数 300 行。
   - `--write` で、しきい値超えの現状値を `size-budget.json`(`{ "files": {"path": lines}, "functions": {"path#name": lines} }`)に書く。
   - 引数なしでは、json の値より **増えた** もの、または json に無い新規のしきい値超えを列挙して exit 1 にする。減ったものは json を自動更新しない(`--write` で更新する)。
   - 関数名が無い場合は `path#<line>` ではなく、親の変数名や property 名で識別する(行番号は変わりやすいため)。
2. `package.json` に `"size:check": "bun scripts/size-budget.ts"` を追加する。
3. `scripts/verify.ts` の boundaries 検査の後(`--all` と `--domain` の両方)で `size-budget` を実行する。`--domain` のときは対象 path に絞る。
4. `bun scripts/size-budget.ts --write` で初期値を作り、その後 `bun run verify:all` が通ること。

---

## ARC-2: agent-runtime service の分割(挙動変更なし)

**前提**: RT-1 完了済みで、§1 のファイルがクリーンであること。

**書込許可**: `api/domains/agent-runtime/service/**`(`index.ts` の分割と新規ファイル)。facade(`api/domains/agent-runtime/index.ts`)の公開 API は変えない。

**現状**: `createAgentRuntime`(82 行〜1993 行)が 1 つのクロージャで、主な内部関数は次のとおり。
- task の操作: `currentActionPayload`、`invocationDigests`、`canReplace`、`replaceOrFail`、`releaseBinding`、`enqueue`、`insertTask`、`ready`、`fail`、`endSteps`、`next`、`cancelTreeInTransaction`、`toolLimit`、`usableTools`
- queue handler(471〜1146 行付近、約 675 行)
- 反映処理: `flush`、`schedule`、`maintenance`、`runMaintenance`、`reconcile`、`arm`
- 回答の受渡し: `reportInTransaction`、`bindAcquisition`、`safeRow`、`prepareAnswerInTransaction`、`validAnswerInTransaction`、`adoptedEvidence`

**手順**
1. 共有の可変状態を `type RuntimeState` にまとめ、`createAgentRuntime` 内で 1 回だけ生成する。対象は `prepared`・`actionPrepared`・`bindings`・`candidates`・`repairFeedback`・`releases`・`dirty`・`reconciling`・`timer` など、クロージャ内の `Map`・`Set`・`let` すべて。依存も `type RuntimeDeps` にまとめる(store・queue・tools・capabilities・log・now など、factory の引数と同じもの)。
2. 次のファイルを新規作成し、関数を **本文を変えずに** 移す。各関数は `(ctx: { state, deps }, ...元の引数)` を受け取る形にするか、`createTaskOps(ctx)` のような factory が関数群を返す形にする。どちらかに統一すること。
   - `service/task-ops.ts`: task の操作群
   - `service/handler.ts`: queue handler 本体。handler 内の内部関数も、このファイルの private 関数に分ける
   - `service/reconcile.ts`: `flush` から `arm` まで
   - `service/answer.ts`: 回答の受渡し群
3. `index.ts` は state と deps の生成、各 factory の呼出し、公開 object の組立てだけを行う。300 行以下を目安とする。
4. 循環参照(handler が reconcile の `schedule` を呼ぶ等)は、後から注入する形 `ctx.schedule = () => reconcile.schedule()` で解く。
5. `bun run verify -- --domain agent-runtime` と `bun run verify -- --domain dialogue`(利用側)が無変更の試験で通ること。ARC-1 の `size-budget.json` を `--write` で更新する。

---

## ARC-3: world lifecycle-adapter の分割(挙動変更なし)

**書込許可**: `api/domains/world/service/lifecycle-adapter.ts` と、同ディレクトリの新規ファイル

**現状**: `createWorldLifecycle`(383〜2117 行)の内部関数は次のとおり。
- 排他と受付: `withLock`、`worldOp`、`acceptInWriter`、`reportOf`
- 忘却(forget)の段階処理: `journalStep`、`worldStep`、`erasedKeys`、`externalErased`、`syncConfirmations`、`memoryStep`、`reopenStep`、`advance`、`acceptForget`、`resumeForgets`、`classify`
- 復元(restore): `journalTombstones`、`restoreScope`、`adoptJournalEntries`、`reverifyMemory`、`decide`、`runRecover`、`recoverWorld`
- 変更 feed の消費: `feedKeyOf`、`memoryRoot`、`invalidateKeys`、`receiveUsable`、`feedStages`、`consumeMemoryChanges`、`consumeSourceChanges`

**手順**: ARC-2 と同じ方式(state / deps の集約と、factory への移動)で次のファイルに分ける。`index.ts` 相当の組立ては `lifecycle-adapter.ts` に残す。
- `lifecycle-forget.ts`: 忘却の段階処理
- `lifecycle-restore.ts`: 復元
- `lifecycle-feed.ts`: 変更 feed の消費
- `lifecycle-lock.ts`: 排他と受付

`bun run verify -- --domain world` と `bun run verify -- --domain dialogue` が無変更の試験で通ること。

---

## ARC-4: dialogue service の分割(挙動変更なし)

**前提**: RT-2 完了済みで、§1 のファイルがクリーンであること。

**書込許可**: `api/domains/dialogue/service/**`

**手順**
1. `createDialogueService`(128〜1232 行)の内部関数を `grep -nE '^\t(async )?function ' api/domains/dialogue/service/index.ts` で列挙し、責務で 3〜5 群に分ける。報告に分類表を載せる。目安は次のとおり。
   - 入力受付と冪等(`byRequest`・`byUtterance`)
   - 生成 job の handler
   - 回答の採用と取消
   - agent との連携(`scheduleAgents`・`reconcileAgents`)
   - 復旧(recover)
2. ARC-2 と同じ方式で分割する。
3. `bun run verify -- --domain dialogue` と `--domain voice-dialogue` が無変更の試験で通ること。

---

## ARC-5: 他の巨大 service の分割(挙動変更なし)

**書込許可**(1 つずつ別の作業者にしてよい)
- (a) `api/domains/coding-supervision/service/**`
- (b) `api/domains/tasks/service/**`
- (c) `api/domains/world/service/extraction-handler.ts` と同ディレクトリの新規ファイル(ARC-3 の後)

**手順**: ARC-2 と同じ方式で分割する。各ファイル 500 行以下を目安とする。各 domain の verify が無変更の試験で通ること。(a) では SEC-11 と衝突するので、SEC-11 の完了後に行う。

---

## ARC-6: 境界検査の穴埋め(application・infrastructure・alias)

**問題**(`scripts/boundaries.ts`)
- `api/application/**`、`api/infrastructure/**`、`scripts`、`tests` は、domain の所有者が無いので検査されない。
  - 例: `api/application/coding.ts:4` が `../domains/coding/adapters` を直接 import している。
- bare specifier(`.` で始まらない指定子)は無条件に素通りする。

**書込許可**: `scripts/boundaries.ts`、`scripts/boundaries.test.ts`(無ければ新規)、`api/domains/coding/index.ts`(re-export の追加のみ)、`api/application/coding.ts`(import の変更のみ)

**手順**
1. `checkSource` に次の規則を追加する。
   - **application 規則**: path が `api/application/` 配下で非試験ファイルなら、domain への import は `api/domains/<d>/index.ts` か `api/domains/<d>/contracts/**` だけを許可する。違反は `application must use <d> public entry`。
     - 試験ファイル(`*.test.ts`・`*.fixture.ts`)は追加で `api/domains/<d>/test/**` を許可する。
   - **infrastructure 規則**: path が `api/infrastructure/` 配下なら、`api/domains/**` と `api/application/**` の import を禁止する。違反は `infrastructure must not import domains/application`。
   - **alias 規則**: bare specifier のうち `@/`・`~/`・`api/`・`web/` で始まるもの(tsconfig の paths を使った越境)は `boundary_alias_forbidden` で禁止する。npm package 名は従来どおり素通りさせる。
2. `api/domains/coding/index.ts` に、application が必要とする adapter を re-export する。`api/application/coding.ts` の import を `../domains/coding` に変える。
3. `checkBoundaries` に渡す file 一覧(`scripts/verify.ts` の `all` 分岐)は、既に `api` 全体を含むので変更不要。
4. 試験(`boundaries.test.ts`): `checkSource(name, text)` に仮想の path と source を渡す形で、上記 3 規則の違反と許可の両方を確認する。

---

## ARC-7: domains.ts の依存を本番用と試験用に分割し、宣言と実 import の差分を検査

**問題**
- `scripts/domains.ts` に宣言された依存のうち、`world→memory`、`dialogue→settings`、`dialogue→world` は本番 code で使われていない(試験だけが使っている)。
- `conversation→avatar` は web 専用の domain への依存。
- backend と web が 1 つの `depends` を共用している。

**書込許可**: `scripts/domains.ts`、`scripts/boundaries.ts`、`scripts/verify.ts`、`scripts/test-domain.ts`(閉包の計算を使っていれば)

**手順**
1. 各 entry の `depends` を `{ api: Domain[]; web: Domain[]; test: Domain[] }` に変える。
   - 移行時は、現在の `depends` を実 import に基づいて振り分ける。
   - 振分けは手順 3 の検査を `--report` で実行して得る。
2. `closure(domain, layer)` を layer 別に計算する。`verify --domain` は、型検査には api と web の閉包、試験には test を加えた閉包を使う。
3. `boundaries.ts` に「宣言されているが使われていない依存」の検査を追加する。全ファイルの import から domain → domain の実辺集合を作り、宣言との差分(過剰宣言)を `unused dependency <a> -> <b> (<layer>)` として error にする。
   - この検査は `verify --all` のときだけ実行する(部分検査では判定できないため)。
4. `bun run verify:all` が通ること。

---

## ARC-8: migration の名前付き化(位置依存の解消・前回の見送りを解除)

**問題**
- `api/application/migrations.ts` は位置で適用する単一の配列で、memory package の migration を `slice(0,4)`・`slice(4,5)`・`slice(5)` で手作業で挿入している。
- 死に枠(`retiredContinuityMigration = "SELECT 1"`)がある。
- DB がコードより新しい場合を検出しない。

**書込許可**
- `api/infrastructure/sqlite/index.ts` と試験
- `api/application/migrations.ts` と `migrations.test.ts`
- 各 `api/domains/*/repository/index.ts` の migration export(名前付きの配列の追加のみ。既存の SQL 文字列は 1 文字も変えない)
- 各 domain の `index.ts`(re-export の追加のみ)

**設計**
1. 型を `type Migration = { id: string; sql: string }` とする。id は `"<owner>/<4桁連番>-<slug>"`(例 `conversation/0001-init`、`memory-package/0005`、`world-package/0003`)。
2. 新しい表を作る。

   ```sql
   CREATE TABLE IF NOT EXISTS schema_migrations_v2 (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)
   ```

3. **旧 DB からの移行**: `migrations.ts` に、現在の位置順の配列(2026-10-10 時点の `migrations` と同じ並び)を `legacyOrder: readonly string[]`(各要素は新しい id)として **凍結** する。
   - 起動時に `schema_migrations`(INTEGER id)があり、`schema_migrations_v2` が空なら、`legacyOrder[i-1]` を id として checksum とともに v2 へ写す。この処理は 1 transaction で行う。
   - 旧表は残す(ロールバック用。削除は将来の別 WP)。
4. 適用順は配列の順番ではなく、**各 migration の `after: string[]` 宣言**(依存する migration の id)による topological sort とする。
   - 宣言の無いものは、legacyOrder 上の直前の要素に依存するとみなす。これで現在の順序が再現される。
   - 新規の migration は `after` を明示すること。
5. DB にあってコードに無い id があれば、`migration_unknown_applied:<id>` で起動を失敗させる(DB がコードより新しい場合)。
6. checksum の不一致は、従来どおり起動失敗にする(`migration_checksum_mismatch` に id を付ける)。

**手順**
1. 各 domain の repository に `export const migrations: readonly Migration[] = [...]` を追加する。既存の `migration`・`xxxMigration` 文字列を参照して作るので、SQL は変えない。package migration は `memoryPackageMigrations.map((sql, i) => ({ id: \`memory-package/${pad(i+1)}\`, sql }))` のように包む。
2. `migrations.ts` を「全 domain の `migrations` を集めて sort する」形に書き換える。`retiredContinuityMigration` は `{ id: "continuity-legacy/0001-retired", sql: "SELECT 1" }` として legacyOrder に残す。
3. `openStore(filename, migrations: readonly Migration[])` に変え、上記の設計どおりに適用する。
4. 試験(`migrations.test.ts` と sqlite の試験)
   - (a) 空 DB に全件適用される。
   - (b) **2026-10-10 時点の位置方式で作った DB**(試験内で旧実装相当の INTEGER 表を作り、全 SQL を位置順で適用)を開くと、v2 へ移行され、追加の適用が 0 件。
   - (c) 未知の id があると失敗する。
   - (d) `after` を宣言した新規 migration が依存の後に適用される。
   - (e) 現在の開発 DB(`data/eumenes.sqlite3`)の **コピー** を一時ディレクトリで開けることを手動で確認し、結果を実施記録に残す。実 DB は直接開かない。
5. `docs/domains.md` に migration の追加規則(id の命名、`after` の宣言、既存 SQL の変更禁止)を追記する。`docs/domains.md` もこの WP の書込許可に含める。

---

## ARC-9: canonical JSON / sha256 の一本化(出力は不変)

**問題**: canonical JSON の実装が少なくとも 5 つ(tasks・scheduler・queue・timers・research-routes)あり、`const sha256 = ...` も world 配下だけで 6 箇所ある。tasks だけが `localeCompare` を使い、undefined も除かない。

**重要**: digest は DB に保存され、冪等判定に使われている。**各 domain の出力を 1 bit も変えてはならない。**

**書込許可**
- `api/infrastructure/digest.ts`(新規)と試験
- 次の各ファイル(canonical・sha256 の定義を import に置き換える部分だけ)
  - `api/domains/{tasks,scheduler,queue,timers}/service/*.ts`
  - `api/domains/research-routes/contracts/index.ts`
  - `api/domains/capabilities/contracts/index.ts`(§1 で変更中なのでクリーンになってから)
  - `api/domains/world/service/{world-journal,lifecycle-adapter,memory-adapter,extraction-intake,extraction-handler,runtime-adapter}.ts`
  - `api/domains/{memory,coding,coding-supervision}/service/index.ts`
  - `api/application/app.ts`

**手順**
1. **先に golden 試験を書く。** 各実装に、次の値を通した出力(文字列と hex digest)を、**現行実装で** 計算して試験に固定する。
   - `{b:1,a:[1,{d:undefined,c:"x"}],"Z":null,"é":2}`
   - 空 object
   - 入れ子の配列
   - 数値の `-0`・`1e21`
2. `digest.ts` に 2 つの関数を置く。
   - `sha256Hex(input: string | Uint8Array): string`
   - `canonicalJson(value, opts: { omitUndefined: boolean; keyOrder: "codeUnit" | "locale" })`
   - 実装は timers 版(`codeUnit` は `a < b ? -1 : 1`)を基にし、`locale` は `a.localeCompare(b)` とする。
3. 各 domain の実装を `canonicalJson(v, {…})` の呼出しに置き換える。option は各実装の現状に合わせる。
   - tasks: `{ omitUndefined: false, keyOrder: "locale" }`
   - 他: 実装を読んで決める
   - `sha256` の各定義は `sha256Hex` に置き換える。
4. 手順 1 の golden 試験が、置換後も同じ値で通ること。
5. tasks の `locale` 方式はロケール依存の危険があるが、**変更しない**。`digest.ts` に「tasks 互換専用。新規利用禁止」とコメントする。

---

## ARC-10: エラーと HTTP status の対応を各 domain で宣言

**前提**: ARC-11 の後。

**書込許可**: `api/application/error-status.ts`、各 `api/domains/*/contracts/index.ts`(`errorStatus` export の追加のみ)、各 domain の `index.ts`(re-export)、`api/application/error-status.test.ts`

**手順**
1. 各 domain の contracts に `export const errorStatus = { <code>: <status>, ... } as const satisfies Record<string, 400|401|403|404|409|411|413|415|422|429|502|503>` を追加する。中身は `error-status.ts` の表から、その domain が throw するコードを移す。
   - どの domain のコードかは、`grep -rn "\"<code>\"" api/domains` で throw 元を特定して決める。
2. `error-status.ts` は、全 domain の `errorStatus` を merge した表を作る。同じコードが 2 つの domain で異なる status に定義されていたら、**module の読込み時に throw** する。接頭辞規則(`invalid_` など)は残す。
3. 試験
   - (a) merge で重複・矛盾が無い。
   - (b) 既存の対応がすべて同じ status を返す。移行前の表を試験に固定してから比較する。

---

## ARC-11: `parseJsonBody` helper と CORS methods

**問題**
- `await c.req.json().catch(() => null)` が 22 箇所にある。queue の controller だけ `.catch(() => ({}))` で挙動が違う。
- `Access-Control-Allow-Methods` が `GET, POST, OPTIONS` に固定されている。

**書込許可**: `api/infrastructure/http.ts`(新規)と試験、各 `api/domains/*/controller/index.ts` の該当行。§1 で変更中の domain(capabilities・voice-dialogue・dialogue・web-research)は、クリーンになってから行う。`api/application/app.ts`(CORS 行)

**手順**
1. `http.ts` に次を置く。

   ```ts
   export async function parseJsonBody<T>(c: Context, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; response: Response }>
   ```

   - JSON の parse 失敗と schema 不一致はどちらも `c.json({ error: "invalid_input" }, 400)` を返す。
2. 各 controller の `schema.safeParse(await c.req.json().catch(() => null))` を、この helper に置き換える。
   - 返す error コードが `invalid_input` 以外の箇所(例 `invalid_voice_ids`)は、helper に `code` 引数を足して維持する。
   - **queue の controller の `({})` は、空 body を許す意図か確認する。** 空 body が正当な API なら `parseJsonBody(c, schema, { emptyAs: {} })` で維持し、そうでなければ統一して報告する。
3. `app.ts` の `Access-Control-Allow-Methods` を `"GET, POST, PUT, PATCH, DELETE, OPTIONS"` にする。
4. 各 domain の verify が通ること(400 の応答 body が変わらないこと)。

---

## ARC-12: 型付き config(zod)の一元化

**問題**
- `process.env` の読取りが、`server.ts` に 17 箇所あるほか、`world.ts`・`toolchain.ts`・`delegated-tasks.ts`・settings・logger・cli・coding-runner に散在している。
- フラグの解釈がまちまちで(`EUMENES_WORLD` は off/0/false/protect/on/1/true、`EUMENES_TOOLCHAIN_ENABLED` は未設定=true、`EUMENES_DELEGATED_TASKS_ENABLED` は未設定=false)、NaN の検証も無い。

**書込許可**: `api/infrastructure/config.ts`(新規)と試験、`api/application/server.ts`、`world.ts`、`toolchain.ts`(§1 で変更中。クリーンになってから)、`delegated-tasks.ts`、`api/domains/settings/service/index.ts`(env の受け口のみ)

**手順**
1. `config.ts` に `loadConfig(env: Record<string, string|undefined>): Config` を zod で実装する。
   - 全 `EUMENES_*`・`LARM_*` を 1 つの schema にする。各変数の意味と既定値は、現在の読取り箇所の既定値を **そのまま** 移す。
   - 数値は `z.coerce.number().int().min(...)` で検証し、NaN は起動失敗(`config_invalid:<NAME>`)にする。
   - 真偽フラグは共通の parser `flag(default)`(`1/true/on` → true、`0/false/off` → false、それ以外は失敗)を使う。ただし `EUMENES_WORLD` は既存の 3 値(off・protect・on)を `z.enum` で表す。**既存の未設定時の既定値は変えない。**
2. `server.ts` の冒頭で `const config = loadConfig(process.env)` を 1 回だけ実行し、以降の `process.env.X` をすべて `config.x` に置き換える。`world.ts` などの関数には、`config` の必要部分を引数で渡す。
3. 秘密(token)は `Config` に含めてよいが、logger に渡さないこと。
4. 試験: 既定値の一覧が、移行前の各既定値と一致する(表で固定する)。不正な数値で失敗する。
5. `grep -rn "process.env" api/application api/domains | grep -v test` が `config.ts` 以外で 0 件になること。cli と coding-runner は別プロセスなので対象外。

---

## ARC-13: Lifecycle runner と createApp の module 化

**前提**: RT-7 と ARC-12 の後。

**書込許可**: `api/application/server.ts`、`api/application/app.ts`、`api/application/lifecycle.ts`(新規)と試験、`api/application/app.test.ts`(呼出し形の追従のみ)

**手順**
1. `lifecycle.ts` を作る。
   - `type Lifecycle = { name: string; recover?(): Promise<void>; start?(): void; close?(): Promise<void> }`
   - `createLifecycleRunner(items: Lifecycle[])` が `{ recoverAll, startAll, closeAll(deadlineMs) }` を返す。
   - `closeAll` は登録の **逆順** に、RT-7 と同じ方式(各段を try/catch・ログ・全体の期限)で閉じる。
2. `server.ts` の recover・start・shutdown の手書きの順序を、この runner への登録に置き換える。**登録順は、現在の recover と start の順序を正とし、close はその逆順になるように並べる。**
   - 現在の shutdown 順が start の逆順と異なる箇所があれば列挙して報告し、shutdown の順序を優先して個別に調整する。
3. 定期処理(`routeSweep`・`taskMaintenance`・`codingHeartbeat`・`timerMaintenance`)は、`intervalLifecycle(name, ms, fn)` の helper で Lifecycle にする(start で interval、close で clear し、実行中の Promise を待つ)。
4. `createApp(deps)` の optional な 20 個の依存を、`modules: Array<{ mount(app: Hono): void }>` を受け取る形に変える。`server.ts` は各 domain の `register*` を `{ mount: (app) => registerX(app, svc) }` として並べる。`createProductionApp` の `Required<…>` も削除する。
5. `server.ts` の `main()` から `buildServices(config)` を export 可能な関数として抜き出し、import 時に副作用が走らないようにする。トップレベルの `await main()` は `if (import.meta.main)` の中に移す。
6. 試験: `createLifecycleRunner` の逆順 close・失敗の継続・期限。`app.test.ts` が module 形式で通る。

---

## ARC-14: tool 固有の知識を汎用 runtime から追い出す

**前提**: ARC-2 の後で、§1 の toolchain と capabilities がクリーンであること。

**問題**
- 汎用 runtime に `web.*`・`timer.*` の tool id が直書きされている。
  - `agent-runtime/service/*` の 451・465・777〜780・939・977 行付近
  - `context.ts` の 121・132 行付近
  - `tool-runtime/service/index.ts` の 138・211・216・439 行付近
- `api/application/toolchain.ts` の 46〜110 行付近に、`web.forecast`・`web.quote`・`web.lookup` の引数組立てがある。

**書込許可**: `api/domains/capabilities/contracts/**`、`api/domains/agent-runtime/service/**`、`api/domains/tool-runtime/service/**`、`api/domains/web-research/**`(adapter の移設先)、`api/application/toolchain.ts`

**手順**
1. 上記の各直書き箇所を読み、tool id ごとに「runtime が tool について知っていること」を表にする。項目は step cost・scope 判定・grant 種別・引数組立てなど。表は報告と本書の実施記録に残す。
2. capability の定義(contracts)に、表の各項目を表す metadata の field を追加する(例 `stepCost: number`、`grant: "user_origin" | "none"`、`scope: "url_from_input" | "any"`)。
3. runtime 側は tool id を比較せず、metadata を読むよう書き換える。
4. `toolchain.ts` の web の引数組立てを `web-research` domain の adapter(`web-research/adapters/toolchain.ts`)へ移し、application は配線だけにする。
5. `grep -rn "\"web\.\|\"timer\." api/domains/agent-runtime api/domains/tool-runtime | grep -v test` が 0 件になること。各 domain の verify と `verify:all` が通ること。挙動変更なし。

---

## ARC-15: domain をまたぐ SQL の検査

**問題**: domain 間 API の引数が生の `Database` なので、どの domain も他の domain の表に書ける。import の境界検査は SQL を見ない。

**書込許可**: `scripts/sql-boundaries.ts`(新規)と試験、`scripts/verify.ts`

**手順**
1. ARC-8 の後なら、各 domain の `migrations` から `CREATE TABLE (IF NOT EXISTS)? <name>` を抽出し、表 → 所有 domain の対応を作る。ARC-8 の前なら、各 repository の migration 文字列から同様に抽出する。
2. 各 domain の非試験ファイルの文字列リテラル(template を含む)から、`\b(FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)` を抽出する。所有者が別の domain の表への参照を列挙する。
3. 現存する越境は `scripts/sql-boundaries.allow.json` に「domain・表・理由」で列挙して許可する(初期値は `--write` で生成)。以後の新規の越境だけを失敗にする。
4. `verify --all` で実行する。

---

## ARC-16: flock の OS 対応と CI(前回の見送りを解除)

**問題**: `api/infrastructure/sqlite/index.ts:15` と `scripts/verify.ts:35` が `/usr/lib/libSystem.B.dylib` を無条件に dlopen するため、Linux では import 時に落ちる。CI が無い。

**書込許可**: `api/infrastructure/flock.ts`(新規)と試験、`api/infrastructure/sqlite/index.ts`、`scripts/verify.ts`、`.github/workflows/verify.yml`(新規)、`README.md`(Linux の注記 1 行)

**手順**
1. `flock.ts` を作る。`packages/coding-runner/src/storage.ts` の 97〜101 行付近にある OS 分岐を参考にする(coding-runner は product layer を import できないので共有はしない)。

   ```ts
   const libraryPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : process.platform === "linux" ? "libc.so.6" : null;
   let lib: ... | undefined;
   function load() { if (!libraryPath) throw new Error("flock_unsupported_platform"); return (lib ??= dlopen(libraryPath, { flock: {...} })); }
   export const LOCK_EX_NB = 2 | 4, LOCK_UN = 8;
   export function flock(fd: number, op: number): number { return load().symbols.flock(fd, op); }
   ```

   - **遅延読込み**にし、import 時には dlopen しない。
2. `sqlite/index.ts` と `scripts/verify.ts` の dlopen を `flock.ts` の利用に置き換える。`scripts` から `api/infrastructure` への import は boundaries 上許可されているか確認し、不可なら `scripts/flock.ts` に同じ内容を複製する。
3. `.github/workflows/verify.yml` を作る。
   - matrix は `ubuntu-latest` と `macos-latest`。
   - steps: `actions/checkout@v4`、`oven-sh/setup-bun@v2`(`bun-version` は `package.json` の `@types/bun` に合わせ、`bun --version` の値を固定する)、`bun install --frozen-lockfile`、`bunx playwright install --with-deps chromium`、`bun run verify:all`。
   - env は `EUMENES_API_TOKEN: ci-api-token-0123456789abcdef`。live 系は実行しない。
   - DOC-2 の後なら、design-system の build を install の後に入れる(postinstall で行われるなら不要)。
4. Linux 上での確認: Docker が使えれば `docker run --rm -v $PWD:/w -w /w oven/bun:<version> bun test api/infrastructure` で flock 試験が通ることを確認する。使えなければ、CI の初回実行の結果で確認すると報告する。
5. README の「同一 Linux ホストから使う場合」の記述が成り立つことを、Linux 上での確認の結果として実施記録に残す。

---

## ARC-17: 未使用 export の検出と削除

**前提**: ARC-2〜5 の後(分割で export 構成が変わるため)。

**書込許可**: `package.json`(devDependency と script)、`bun.lock`、`knip.json`(新規)、未使用と判定された export を持つファイル

**手順**
1. `bun add -d knip@<2週間以上前の固定 version>` を実行する。`knip.json` には次を設定する。
   - entry: `api/application/server.ts`、`web/src/main.tsx`、`cli/index.ts`、`scripts/*.ts`、試験ファイルの glob
   - project: `api/**`・`web/src/**`・`client/**`・`cli/**`・`packages/*/src/**`
2. `bunx knip --include exports,types` の結果のうち、明らかに未使用のもの(例 `setMemoryFinal`、`journalHead`、`getKeyByIncarnation`、`isTerminalDraft`、`draftOrigin`、`codingEventsSchema`)を削除する。domain facade の公開型は、web・client が使っていなくても contracts として意図的なものがあるので、その場合は `knip.json` の ignore に理由付きで追加する。
3. `package.json` に `"deadcode": "knip --include exports,types"` を追加する。verify には **入れない**(誤検出で止まるのを避ける)。実施記録に削除件数を残す。

---

## ARC-18: エラー握り潰しの可視化

**書込許可**: `api/infrastructure/ignore-error.ts`(新規)、`api/domains/{larm,attitude-dataset,inference}/controller/index.ts`、`grep` で見つかった非試験の握り潰し箇所(§1 で変更中のファイルを除く)

**手順**
1. `ignoreError(log, event, reason)` を作る。`(error) => log.debug(event, { reason }, error)` を返す。
2. `grep -rnE "catch \{|\.catch\(\(\) => \{\}\)" api --include="*.ts" | grep -v test` の各箇所(約 90 件)を分類する。
   - 意図的な後始末(close の二重呼出しなど)はコメントだけ付けて残す。
   - 原因が分からなくなるもの(controller の 11・29・21 行付近など)は `ignoreError` に置き換える。
3. 置き換えた件数とファイルを報告する。

---

## ARC-19: world contracts の web 向けと host 向けの分離

**書込許可**: `api/domains/world/contracts/**`、`api/domains/world/index.ts`、`web/src/domains/world/**` と `client/world*.ts` の import 行

**手順**
1. `world/contracts/host.ts` と `query.ts` が `eumenes-world-model(/sqlite)` の **実体** を import しているか確認する。
2. web と client が使う表示用の型・zod schema だけを `world/contracts/view.ts` に移す(vendor package を import しない)。web と client の import を `contracts/view` に変える。
3. boundaries の layer 規則(前回 D4)に「web と client は `world/contracts/view` 以外の world contracts を import しない」を追加する。`scripts/boundaries.ts` もこの WP の書込許可に含める。ARC-6 と同時に行う場合は同一作業者で行う。
4. `bun run build:web` の bundle に `eumenes-world-model` が含まれないことを確認する(`grep -l world-model dist-web/assets/*.js` が空)。

---

## ARC-20: 既定 principal 定数の一元化

**書込許可**: `api/domains/conversation/contracts/index.ts`、`api/domains/memory/**`(該当定数の参照のみ)

**手順**
1. `CONVERSATION_DEFAULT_PRINCIPAL` と memory の `PRINCIPAL` の値が同一であることを確認する。
2. memory は conversation より下位か上位かを `scripts/domains.ts` で確認し、**下位の domain** の contracts に定数を 1 つだけ置く。上位の domain はそれを import する。
   - 依存の向きが合わない場合は、`api/infrastructure/principal.ts` に置く。
3. world の試験にある一致確認は残す。

---

# Phase 7

## DOC-1: vendor tgz の整理と world-model の整合試験

**書込許可**: `vendor/**`、`api/application/vendor.test.ts`

**手順**
1. `git rm vendor/eumenes-memory/eumenes-memory-0.3.{3,4,5}.tgz` を実行する(使用中は `package.json` の 0.3.6 だけ)。
2. `vendor/world/pack-result.json` の中身を確認する。memory の別 tgz(`0.3.6-local.0`)のハッシュを記録していて world-model と無関係なら、削除する。
3. `vendor/world/manifest.json` を、memory と同じ形式(`package`・`version`・`artifact`・`sha256`)で作る。sha256 は既存の `.sha256` ファイルの値を使い、`shasum -a 256` で一致を確認する。
4. `vendor.test.ts` に、world-model について memory と同じ 4 点を確かめる試験を追加する: manifest の sha256、`package.json` の依存指定、`bun.lock` の integrity、install 済みの version。
5. version が `0.0.0` 固定である点は、package 側(別リポジトリ)で採番が必要。本リポジトリでは対応せず、実施記録に「world-model の version 採番は upstream 依頼」と残す。
6. `bunfig.toml` の `minimumReleaseAgeExcludes = ["llm-fetch"]` について確認する。`npm view llm-fetch@0.1.2 time --json` の公開日時が 7 日以上前なら、この行とコメントを削除する(`bunfig.toml` もこの WP の書込許可に含める)。

---

## DOC-2: design-system の `dist` を git から外す

**書込許可**: `.gitignore`、`package.json`、`packages/design-system/dist/**`(git 管理からの除外)

**手順**
1. ルートの `package.json` の scripts に `"postinstall": "bun run build:design-system"` を追加する。
2. `bun install` 後に `packages/design-system/dist/index.mjs` が生成されることを確認する。生成されなければ、`postinstall` が Bun で実行されるか調べて報告する。
3. `.gitignore` に `packages/design-system/dist/` を追加し、`git rm -r --cached packages/design-system/dist` を実行する。
4. 一時ディレクトリへの clone で確認する。`git clone . /tmp/<scratch>/e && cd … && bun install && bun run typecheck` が成功すること。

---

## DOC-3: LAN IP の既定値を廃止

**問題**: `http://192.168.0.130:9810` がコードの既定値になっている(`larm/service/index.ts:55`、`playground.ts:50`)。別の環境で clone すると、他人の LAN アドレスに平文の token を送ってしまう。

**書込許可**: `api/domains/larm/service/index.ts`、`playground.ts`、`api/domains/larm/test/larm.test.ts`、`README.md`(該当文)

**手順**
1. 両ファイルの `|| "http://192.168.0.130:9810"` を削除する。`baseUrl` が空なら、LARM の状態を `unconfigured`(既存の状態値。`errorMessages.ts` に「未設定」がある)にし、接続を試みない。`lastError` は `larm_base_url_unconfigured` にする。
2. `larm.test.ts` の 642 行付近の既定値に依存した期待は、「`baseUrl` を明示した場合」の試験に書き換える。この WP は挙動変更ありとして報告する。
3. README の「LARM は `http://192.168.0.130:9810` の … を既定値とします」を「`LARM_BASE_URL` を必ず設定します(例: `http://<LARMのホスト>:9810`)」に変える。
4. **ユーザーへの依頼を報告に書く**: `.env.example` は作業者が読めない設定のため、ユーザーが `LARM_BASE_URL=` の例を更新する。ユーザー自身の `.env` に `LARM_BASE_URL` が無ければ、追加が必要になる。

---

## DOC-4: README の再構成・docs 索引・domain 表の自動生成

**前提**: 他の WP の完了後(仕様が固まってから)。

**書込許可**: `README.md`、`docs/**`、`scripts/domain-docs.ts`(新規)、`scripts/verify.ts`

**手順**
1. README を次の構成に書き直す。**既存の情報は削らず `docs/` へ移す。**
   1. 1 段落の概要
   2. クイックスタート(5 手順以内)
   3. CLI の主要コマンド
   4. 検証コマンド
   5. 現在の限界(実機器の 3 往復受入が未実施であることなど)
   6. docs 索引への link

   移す先は次のとおり。
   - 起動の詳細(token・LARM・TTS・VOICEVOX) → `docs/setup.md`
   - 通知(SSE)と再接続の仕様 → `docs/realtime.md`
   - Web 取得 → 既存の web-research 計画書と `docs/research-routes.md`
   - LARM の予算と session 構成 → `docs/larm.md`
2. `docs/README.md`(索引)を作り、`docs/*.md` の全ファイルを 1 行説明付きで並べる。
3. `scripts/domain-docs.ts` を作り、`scripts/domains.ts` から domain・依存・公開入口の表を生成して、`docs/domains.md` の `<!-- domains:start -->`〜`<!-- domains:end -->` の間に書き込む。
   - `--check` では差分があれば exit 1 にする。
   - `verify --all` に `--check` を追加する。
   - README の「音声 MVP の所有境界」表は、この生成表への link に置き換える。
4. 「定期取得なし」などの記述が、WEB-3 後の実装と一致していることを確認する。

---

## DOC-5: 実装済み spec の archive

**書込許可**: `spec/**`

**手順**
1. `spec/` 直下の計画書(`*-plan*.md`・`*-tasks*.md`・`*-design*.md`)を 1 つずつ確認する。本文の「実施記録」や完了記述で全項目が完了と読めるものを候補にする。
2. 候補ごとに `spec-checker` agent(spec の各項目がコードと試験にあるかを確認し、すべて確認できたら `spec/.archived/` へ移す)を実行する。spec-checker を使えない環境では、手で各項目の実装箇所を確認し、`git mv spec/<file> spec/.archived/<file>` で移す。
3. `spec/README.md`(索引)を作り、進行中・archive 済みを分けて並べる。
4. 本書(improvement-plan-2026-10-10)は、全 WP の完了後に archive する。

---

## 運用上の推奨(コード変更なし)

- コミットは WP 単位で分ける。「Checkpoint ...」のように多くの domain を 1 コミットに束ねない。本書の WP 番号をコミット message の先頭に付けると、追跡しやすい。
- 並行セッションで作業するときは、§0-4 の `git status` 確認を必ず行う。

---

## 実施記録

(各 WP 完了時に 1〜3 行で追記: 日付 / WP / 結果 / 逸脱があれば理由)

### 2026-10-10 実施結果(コミットなし)

- 実装済み(対象別の試験で確認): RT-3〜7, 9〜12 / SEC-1〜7, 9〜14 / WEB-1〜5, 7〜9, 11〜13 / TST-1〜8(TST-2 の toolchain.spec 除く), TST-9(macOS では skip、Linux CI 未確認) / ARC-1, 3, 5(a)(b)(c), 6〜13, 15, 16, 19, 20 / ARC-17, 18 は一部 / DOC-1〜5。
- 未実施(別セッションの未コミット変更と衝突するため延期): RT-1, RT-2, RT-13, SEC-8, ARC-2, ARC-4, ARC-14, WEB-6, WEB-10, TST-2/5 の toolchain.spec 変換、ARC-12 の toolchain.ts、ARC-10 の保留 errorStatus、ARC-9 の capabilities contracts。
- `bun run verify:all`: size-budget / domain-docs / lint / tsc / bun test 1174 pass / vitest / ブラウザ試験 42 pass・1 skip まで全て成功。ただし最後の「検証中にソースが変わった」判定で 2 回失敗(別セッションが agent-runtime を編集中のため)。fixture・live・実機器の受入は未実施。
