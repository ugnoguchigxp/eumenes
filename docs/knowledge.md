# ContextStillと探索SKILL

Eumenesの認証済みAPIからContextStillの公開資料を検索し、資料の版と省略有無を確認できます。SKILL配達は、探索できる依頼なら日本語または英語の固定SKILLを返します。個別の資料が必要な依頼は、同じ入口から既存ジョブに進みます。

## 接続設定

Eumenesのbackend設定に `EUMENES_CONTEXT_STILL_MCP_URL` と `EUMENES_CONTEXT_STILL_MCP_TOKEN` を渡します。URLはContextStill v2の `/mcp`、認証にはContextStillのMCP用トークンを使います。検索・本文取得には `revision` と `contentTruncated` を公開するContextStill版が必要です。両設定を省略した場合も、固定探索SKILLの配達は利用できます。

## API

すべて通常のEumenes API認証が必要です。

| 操作 | 内容 |
| --- | --- |
| `POST /api/knowledge/search` | `query` と任意の `limit` を受け、公開MCPの資料カードと検索通知を返します |
| `GET /api/knowledge/sources/:ref` | 検索カードの `ref` で資料を取得します。 `complete` と `version` を確認できます |
| `POST /api/knowledge/skills` | UUIDの `requestId`、`goal`、`acceptance` と任意の `constraints` を受けます。条件は `{id, text}` の配列です。 `ready` はSKILL全文を含み、`pending` はHTTP 202と `requestRef` を返します |
| `GET /api/knowledge/skills/:ref` | `requestRef` で進捗またはSKILL全文を取得します |

`POST /api/knowledge/skills` から外部資料を検索させる場合は、送信してよい検索文だけを `publicSearchTask` に指定します。固定探索SKILLの配達中にMCPは呼び出されません。取得した外部資料が採用された場合は、配達前にも版・本文・省略の有無を照合します。公開済みSKILLの管理と会話画面への公開は、別の接続段階です。
