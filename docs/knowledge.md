# ContextStillと探索SKILL

Eumenesの認証済みAPIからContextStillの公開資料を検索し、資料の版と省略有無を確認できます。直接APIは探索可能な依頼に日本語または英語の既製SKILLを返します。Webアプリ開発とMarkdown共同編集の担当は、状況に応じてContextStillの手順を探し、個別の候補も受け取れます。

## 接続設定

Eumenesのbackend設定に `EUMENES_CONTEXT_STILL_MCP_URL` と `EUMENES_CONTEXT_STILL_MCP_TOKEN` を渡します。URLはContextStill v2の `/mcp`、認証にはContextStillのMCP用トークンを使います。検索・本文取得には `revision` と `contentTruncated` を公開するContextStill版が必要です。両設定を省略した場合も、固定探索SKILLの配達は利用できます。

探索SKILLの選択専用に既存のクラウドLLMリソースを指定する場合は、そのUUIDを `EUMENES_KNOWLEDGE_SELECTION_RESOURCE_ID` に設定します。選択専用の接続が利用できないときはエラーを返します。会話と新規SKILL生成には、従来の推論設定を使います。

## API

すべて通常のEumenes API認証が必要です。

| 操作 | 内容 |
| --- | --- |
| `POST /api/knowledge/search` | `query` と任意の `limit` を受け、公開MCPの資料カードと検索通知を返します |
| `GET /api/knowledge/sources/:ref` | 検索カードの `ref` で資料を取得します。 `complete` と `version` を確認できます |
| `POST /api/knowledge/skills` | UUIDの `requestId`、`goal`、`acceptance` と任意の `constraints` を受けます。条件は `{id, text}` の配列です。 `ready` はSKILL全文を含み、`pending` はHTTP 202と `requestRef` を返します |
| `GET /api/knowledge/skills/:ref` | `requestRef` で進捗またはSKILL全文を取得します |

`POST /api/knowledge/skills` から外部資料を検索させる場合は、送信してよい検索文だけを `publicSearchTask` に指定します。固定探索SKILLの配達中にMCPは呼び出されません。取得した外部資料が採用された場合は、配達前にも版・本文・省略の有無を照合します。

## 担当との会話

担当の最初の入力には既製の探索候補と元の状況説明が届きます。専用手順や根拠が必要なら、担当は `get_guidance` に作業版・試行と結果・迷い、公開技術の検索語 `publicSearchTask` を渡します。検索語の自動送信は管理者が設定した同一ホストのContextStillに限ります。状況説明の全文はSkillSmithに渡り、MCPの検索要求には指定された検索語だけを送ります。

`get_guidance` は受付IDを返し、担当の応答が完了してから既存ジョブで検索・生成を始めます。資料付き候補の受付からの期限は3分で、担当の最初の応答とは別です。SkillSmithは資料に応じて既存SKILLの再利用・部分修正、安全に探索できる場合の探索欄の具体化を行います。完成後は同じ担当に候補が届き、作業版と採用資料の版を確認したうえで担当が使う手順を判断します。検索中に別の発言が届いた場合も、同じ会話の処理順に沿って結果を届けます。受付IDを使い、同じ担当から結果を確認することもできます。


### 2026-11-11の本番確認

固定試験では、Webアプリ開発への部分修正、Markdown共同編集への既存手順の再利用と探索欄の具体化、資料の版変更による配達拒否を確認しました。本番では両担当で検索ジョブを開始し、同じ担当への結果通知を確認しました。最終試行ではWebアプリ開発が審査中に期限切れとなり、Markdown共同編集は検索を呼ばず既製候補を使いました。本番で資料付き候補の本文が担当に届くところまでは確認できていません。
