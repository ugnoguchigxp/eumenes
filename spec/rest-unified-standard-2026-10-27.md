# REST の統一規格（endpoint 定義の共有）

状態: 案・合意待ち（2026-10-27）。

## 1. 目的

REST の入口（約310 route）と、それを呼ぶ client（41 module）を一つの規格にそろえる。各 endpoint を domain の `contracts` に一度だけ定義し、server の登録と client の呼び出しの両方がその定義を使う。これにより、次の三つを手で書く場所をなくす。

- path の文字列
- 入力と応答の schema の組み合わせ
- エラーから status への変換

client のコードは多少増えてもよい（2026-10-27 の利用者の指示）。

## 2. 現状（2026-10-27 の整理の後）

| 項目 | 現状 | 残っている不統一 |
|---|---|---|
| JSON の本文 | `parseJsonBody`（74 か所） | 長さの上限を自前で持つ route が `readBounded` と `JSON.parse` を使う（34 ファイル）。上限のない JSON の本文がある |
| クエリ | `parseQuery`・`queryInt`（53 か所） | path の値は route ごとに手で検証する（28 か所）か、検証しない |
| エラー → status | 各 domain の `errorStatus`、`shared`、`answerError` | controller の catch が約100残る。理由は次の4つ: 未知のエラーを固定のコードに置き換える、本文に項目を足す、コードを付け替える、status を持つエラーのクラスを使う |
| 応答の header | route ごとに `Cache-Control: no-store` を付ける（約50 か所） | 付けていない JSON の応答がある。エラーの応答には付かない |
| client | `callJson`（222 か所）・`json()`・`withQuery()` | path を client 側で組み立てる。`call` を直接使う箇所が36（バイナリ・SSE・status を読む・header を読む） |
| server と client の対応 | 規約だけ | path・method・schema を両側で別々に書くため、ずれても型と試験の外でしか分からない |

## 3. 規格の全体像

| 層 | 置き場所 | 役割 |
|---|---|---|
| endpoint の定義 | `api/domains/<d>/contracts/endpoints.ts` | method・path・path の値・クエリ・本文・応答・成功の status・既定外のコードを宣言する。zod と `api/infrastructure/endpoint.ts` だけを import する |
| 定義の型と組立て | `api/infrastructure/endpoint.ts`（新規、zod だけに依存） | `endpoint()`、本文の種類 `json()`・`bytes()`・`form()`、応答の種類の型 |
| server の登録 | `api/infrastructure/route.ts`（新規） | `route(app, def, handler)`。入力を検証・変換してから handler に渡し、戻り値を応答にする |
| エラーの応答 | `api/application/app.ts` の `answerError` と `error-status.ts` | 投げたコードを表で status にする唯一の場所 |
| client の呼び出し | `client/transport.ts` の `request()` | 定義から URL・本文・header を作り、応答を種類どおりに読む |
| client の module | `client/<d>.ts` | 今の公開関数（名前と引数）をそのまま残し、中身を `request()` の1行にする。web と CLI は変えない |
| 規格の検査 | `scripts/rest-standard.ts`（新規、verify の静的検査に追加） | §8 の規則を検査する |

## 4. endpoint の定義

### 4.1 項目

| 項目 | 必須 | 内容 |
|---|---|---|
| `method` | ○ | `GET`・`POST`・`PUT`・`PATCH`・`DELETE` |
| `path` | ○ | `/api/...`。可変の部分は `:name` |
| `params` | path に `:name` があるとき | `z.object`。key は path の `:name` と一致させる（定義の時点で検査し、ずれていれば起動時に失敗する） |
| `query` | | `z.object`。値は文字列で受けるので、数値は `queryInt`、真偽値は `queryBool`（新規、`"true"`・`"false"` だけを受ける） |
| `headers` | | `z.object`。受け取る request header（例: `Idempotency-Key`） |
| `body` | | `json(schema, {maxBytes?, emptyAs?})`、`bytes({type, maxBytes})`、`form({fields, maxBytes})` のどれか |
| `response` | ○ | JSON の schema、`"bytes"`、`"text"`、`"none"`、`"sse"`、`"response"` のどれか |
| `status` | | 成功の status。既定は 200（`"none"` は 204）。結果の値で status が決まる protocol だけ関数 `(result) => status` を書ける（§5.3） |
| `invalid` | | 入力が通らないときの 400 のコード。既定は `invalid_input` |
| `tooLarge` | | 本文が上限を超えたときのコード。既定は `payload_too_large`。今のコードを web が表示に使っているときだけ指定する |
| `unavailable` | | 表に status のないコードを投げたときの答え `{code, status}`。指定がなければ 500 `internal_error` |
| `cache` | | 成功の応答の `Cache-Control`。既定は `no-store`。バイナリで保存させるもの（例 `private, max-age=86400, immutable`）だけ指定する |

### 4.2 本文の上限

| 本文の種類 | `maxBytes` の既定 | 超えたとき |
|---|---|---|
| `json` | 1 MiB | 413、`tooLarge` のコード |
| `bytes`・`form` | 既定なし（必ず指定する） | 同上 |

今は上限のない JSON の本文がある。移行のときに、各 route の契約の最大長から 1 MiB で足りるかを確かめ、足りない route だけ `maxBytes` を書く。

### 4.3 例

```ts
// api/domains/music/contracts/endpoints.ts
import { z } from "zod";
import { endpoint, json, queryInt } from "../../../infrastructure/endpoint";
import { playlistRecord, playlistUpdate, musicTracks, trackQuery } from "./index";

const id = z.object({ id: z.string().min(1).max(120) });
export const endpoints = {
	playlists: endpoint({
		method: "GET",
		path: "/api/music/playlists",
		query: z.object({ conversationId: z.string().min(1) }),
		response: playlistRecord.array(),
	}),
	updatePlaylist: endpoint({
		method: "PUT",
		path: "/api/music/playlists/:id",
		params: id,
		body: json(playlistUpdate),
		response: playlistRecord,
	}),
	tracks: endpoint({
		method: "GET",
		path: "/api/music/tracks",
		query: trackQuery.extend({ limit: queryInt.optional() }),
		response: musicTracks,
	}),
	artwork: endpoint({
		method: "GET",
		path: "/api/music/:id/artwork",
		params: id,
		response: "bytes",
		cache: "private, max-age=86400, immutable",
	}),
} as const;
```

## 5. server の規格

### 5.1 登録

```ts
// api/domains/music/controller/index.ts
import { route } from "../../../infrastructure/route";
import { endpoints as e } from "../contracts/endpoints";

route(app, e.playlists, ({ query }) => s.playlists(query.conversationId));
route(app, e.updatePlaylist, ({ params, body }) => s.updatePlaylist(params.id, body));
route(app, e.artwork, async ({ params, signal }) => s.artwork(params.id, signal)); // Response を返す
```

handler が受け取るもの:

| 項目 | 内容 |
|---|---|
| `params`・`query`・`headers`・`body` | 定義の schema で検証・変換した後の値 |
| `signal` | request の中断 |
| `c` | Hono の context。`c.get(...)` で認証の主体などを読むためだけに使う。入力（`c.req.*`）は読まない（§8） |

### 5.2 `route()` の動き

| 順 | 処理 | 失敗したとき |
|---|---|---|
| 1 | `headers`・`params`・`query` を検証する | 400 `{error: invalid, issues}` |
| 2 | 本文を上限つきで読む（`json` は読めない・壊れた JSON を null として検証する） | 上限超え: 413 `tooLarge`。検証の失敗: 400 `{error: invalid, issues}` |
| 3 | handler を呼ぶ | 投げたエラーは `answerError` が答える（§6） |
| 4 | 戻り値を応答にする。JSON の schema なら `c.json(value, status)`。`"bytes"`・`"text"`・`"sse"`・`"response"` なら handler が返した Response をそのまま返す。`"none"` なら 204 | — |
| 5 | 成功の応答に `Cache-Control: cache` を付ける | — |

server は応答を schema で検証しない（client が検証する）。

### 5.3 結果の値で status が決まる protocol

`POST /api/world/query` は `world.query` の protocol で、結果の値（`ok`・`disabled`・`blocked`・`rejected`）が本文そのもので、status は値から決まる。こうした protocol の route だけ、定義の `status` を関数にする。それ以外の route では、失敗は throw にそろえる（例: world の claims は `result.code` を throw し、表で status を決める）。

## 6. エラーの規格

### 6.1 本文

| 場合 | status | 本文 |
|---|---|---|
| 入力の検証の失敗 | 400 | `{"error":"invalid_input","issues":[{"path":["limit"],"code":"invalid_format"}]}`（`issues` は path と zod の code だけで、値は入れない） |
| 本文の上限超え | 413 | `{"error":"payload_too_large"}` |
| 表にあるコードを投げた | 表の status | `{"error":"<code>"}` |
| `ApiFailure(code, {message})` を投げた | 表の status | `{"error":"<code>","message":"<人が読む説明>"}` |
| 表にないコードを投げた（`unavailable` あり） | 指定の status | `{"error":"<unavailable のコード>"}` |
| 表にないコードを投げた（`unavailable` なし） | 500 | `{"error":"internal_error"}` |

エラーの応答には、常に `Cache-Control: no-store` と `X-Request-Id` を付ける。

### 6.2 規則

| 規則 | 内容 |
|---|---|
| E1 | status は `errorStatus`・`shared`・接頭辞の表だけが決める。controller・route で status を決めない |
| E2 | 投げたコードが、そのまま返るコードになる。controller でコードを付け替えない。上流のコードを Eumenes のコードにする変換は、service か adapter の境界で行う |
| E3 | status を持つエラーのクラス（`MusicArtworkError`・`ActionRequestError`・`GoogleAccountError` など）はなくす。コードを投げ、status を表に書く |
| E4 | 上流から来る、値が決まっていないコードは、接頭辞を接頭辞の表に登録する（例 `larm_http_` → 502）。登録できないものは固定のコードに包み、元のコードを `message` に入れる |
| E5 | どの domain が投げても同じ意味の汎用のコード（`not_found` など）は `shared` に置く。同じコードに別の status を付けると、今と同じく起動時に失敗する |
| E6 | 本文に足せる項目は `message` と `issues` だけ。ほかの項目が要るものは成功の応答の型として定義する |

## 7. client の規格

### 7.1 `request()`

```ts
request(t, def, input?, options?)
// input:   { params?, query?, headers?, body? }  （定義の schema から型を作る）
// options: { signal?, timeoutMs?, withStatus? }
```

| 定義の `response` | 戻り値 | request の `Accept` |
|---|---|---|
| JSON の schema | `schema.parse` した値 | `application/json` |
| `"bytes"` | `Blob` | なし |
| `"text"` | `string` | なし |
| `"none"` | `void` | なし |
| `"sse"` | `Response`（`readSse` に渡す） | `text/event-stream` |
| `"response"` | `Response`（呼ぶ側が header などを読む） | なし |

| 処理 | 内容 |
|---|---|
| path | `params` の各値を `encodeURIComponent` して `:name` に入れる |
| クエリ | `withQuery` と同じ（`undefined`・`null` は送らない、配列は key を繰り返す） |
| 本文 | `json` は `Content-Type: application/json` と `JSON.stringify`、`bytes` は定義の `type` と Blob、`form` は FormData |
| `headers` | 定義にある header だけを送る（例 `Idempotency-Key`） |
| `timeoutMs` | `signal` と `AbortSignal.timeout` を合わせる（今の toolchain-history・web-research の自前の関数を置き換える） |
| `withStatus` | `{status, data}` を返す（今の toolchain-actions の `call` 直書きを置き換える） |
| エラー | 今の `ApiError`（status・コード・`X-Request-Id`・`message`・本文）に `issues` を足す |

client は入力を schema で検証しない（server が検証する）。応答は検証する。

### 7.2 module の書き方

```ts
// client/music.ts
import { endpoints as e } from "../api/domains/music/contracts";
import { request, type Transport } from "./transport";

export function musicClient(t: Transport) {
	return {
		musicPlaylists: (conversationId: string, signal?: AbortSignal) =>
			request(t, e.playlists, { query: { conversationId } }, { signal }),
		updateMusicPlaylist: (id: string, value: PlaylistUpdate) =>
			request(t, e.updatePlaylist, { params: { id }, body: value }),
		musicArtwork: (id: string, signal?: AbortSignal) =>
			request(t, e.artwork, { params: { id } }, { signal }),
	};
}
```

公開関数の名前と引数は変えない。web と CLI はそのまま動く。

### 7.3 import の境界

client が `api/infrastructure/endpoint.ts` の型を import できるように、`scripts/boundaries.ts` の client の許可に `api/infrastructure/endpoint` を1つ足す。CLI が `api/infrastructure/auth-config` を使ってよいのと同じ扱い。web の許可は変えない。

## 8. 検査（`scripts/rest-standard.ts`）

| 規則 | 対象 | 禁止すること |
|---|---|---|
| S1 | `api/**`（`route.ts` と試験を除く） | `app.get`・`post`・`put`・`patch`・`delete`・`on` で route を直接登録する（中間処理の `app.use` と、`app.ts` の横断の `limitConcurrency` は除く） |
| S2 | 同上 | `c.req.json`・`text`・`query`・`queries`・`param`・`formData`・`parseBody`・`raw.body` を読む |
| S3 | 同上 | `c.json({ error` でエラーを返す |
| S4 | `api/domains/*/contracts/**` を除く `api/**` | `"/api/` で始まる文字列（path は定義にだけ書く） |
| C1 | `client/*.ts`（`transport.ts`・`sse.ts` を除く） | `.call(`、`fetch(`、`"/api/` で始まる文字列 |
| C2 | `web/src/**` | `fetch(` で `/api` を呼ぶ |

移行のあいだは警告として報告し、最後の段階で失敗に変える（§10）。

## 9. 挙動の変化

| # | 変化 | 影響 |
|---|---|---|
| B1 | JSON の応答とエラーの応答に、常に `Cache-Control: no-store` が付く | client は今も `cache: "no-store"` で呼んでいるため、見える違いはない |
| B2 | 400 の本文に `issues`（path と zod の code）が付く | 項目が増えるだけ。値は入れない |
| B3 | JSON の本文に上限（既定 1 MiB）が付く | 超えると 413。今の契約の最大長から確かめる（§4.2） |
| B4 | 本文の上限を超えたときのコードが、既定で `payload_too_large` になる | 今 `invalid_body_size` などを返す route も、web が表示に使っていなければ `payload_too_large` にそろえる |
| B5 | controller でコードを付け替えて隠していた箇所は、投げたコードをそのまま返す（status は同じ）。例: world の文書の `document_digest_mismatch` は、今は `invalid_input` に付け替えている | 本文の `error` がより細かくなる |
| B6 | route ごとに未知のコードをそのまま返していた箇所（excalidraw・browser など）は、表にないコードを `unavailable` のコードで答える | 内部のコードを外に出さないという全体の方針に合わせる |
| B7 | handler の中で起きた zod の検証の失敗は 500 になる | 入力の検証はすべて定義に移すので、今 400 を返している route は 400 のまま |

path の値の schema は、今その route が受け付けている形より厳しくしない（例: 今は存在しない id に 404 を返している route を、形式の検査で 400 にしない）。

## 10. 移行

### 10.1 段階

| 段階 | 内容 | 担当 |
|---|---|---|
| P0 | 新しく作るもの: `endpoint.ts`（定義・本文の種類・`queryInt`・`queryBool`）、`route.ts`、`ApiFailure`、`answerError` の拡張（`unavailable`・`issues`・`message`・`no-store`）、client の `request()`、境界の許可、`rest-standard.ts`（警告の扱い）。それぞれの試験も書く | 私（共有ファイルのため） |
| P1 | 会話と音声: dialogue、voice-dialogue、conversation、steward、memory、continuity、tts-dictionary、attitude-dataset。client は dialogue・voice-dialogue・conversation・memory・events・run-stream・tts-dictionary・attitude-dataset | coder 1 |
| P2 | 作業と担当: capabilities、tool-runtime、agent-runtime、pipelines、tasks、task-reports、scheduler、queue、timers、kanban、coding、coding-supervision、toolchain-history、resources。client は対応する module と toolchain-actions・requirements | coder 2 |
| P3 | 画像と認識: ocr、object-recognition、image（Google 写真の取り込みを含む）、model3d、excalidraw、compute、docling、music。client は対応する module と visual-analysis | coder 3 |
| P4 | 接続と設定: settings、inference、google-accounts、browser、world、service-tests、terminals、shell、web-research、larm、monitoring、dots（dots-messaging を含む）。client は対応する module | coder 4 |
| P5 | 検査を失敗の扱いに変える。不要になったものを削除する（§11）。`docs/domains.md` の「HTTP の入出力」を、この規格の要約に書き換える | 私 |

P1〜P4 は書く範囲が重ならないので、並行して進める。

- 各 coder が書くのは、担当する domain の `contracts/endpoints.ts`、`controller/`、`test/`、client の module。
- `error-status.ts`・`client/index.ts`・client の試験のうち複数の段階にまたがるもの（`core.test.ts` など）は、私が最後に直す。
- 着手の前に `git status` で、並行して作業中のファイルを除外する。

### 10.2 各段階の受入

- 担当する route の status・`error` のコード・本文が、§9 の変化を除いて今と同じ。controller の試験と、route の path で試験を検索して見つかる HTTP の試験が通る。
- client の試験が通る（URL・method・本文が今と同じ）。
- 担当するファイルで `rest-standard.ts` の指摘がない。
- 担当範囲の型・lint・整形が通る。

## 11. 削除するもの

| 対象 | 時期 |
|---|---|
| controller の status の変換だけをする catch、route ごとの「未知のコードを固定のコードにする」関数（compute の `failed`、image の取り込みの `unavailable`、Google 写真の取り込みの `forwarded`、excalidraw の `safe`） | P1〜P4 |
| status を持つエラーのクラス | P1〜P4 |
| client の module ごとの timeout の関数（toolchain-history・web-research）、`idempotent` の関数（excalidraw）、決まった schema の包み（tasks の `post`、scheduler の `operate`） | P1〜P4 |
| `parseJsonBody`・`parseQuery` を外へ公開すること（`route.ts` の内部だけで使う） | P5 |
| client の `callJson`・`json`・`withQuery` を外へ公開すること（`request()` の内部だけで使う） | P5 |
| controller の `readBounded` と `JSON.parse` の直書き | P1〜P4 |

## 12. 実施記録

（未着手）
