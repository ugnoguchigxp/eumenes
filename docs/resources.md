# リソースURI（`eumenes://`）

Eumenes が作ったもの（生成物）・TODO・会話の出来事を、`eumenes://<種類>/<ID>` の URI で指す。URI を解決すると、その種類の画面で開く・指し示す・再生する・読むことができる。設計と実装の記録は [resource-uri-implementation-plan-2026-10-25.md](../spec/resource-uri-implementation-plan-2026-10-25.md)。

## 書式

```
eumenes://<kind>/<id>[?action=open|play|read]
```

| 部分 | 規則 |
| --- | --- |
| `kind` | 登録した種類（`[a-z0-9]+(\.[a-z0-9-]+)*`） |
| `id` | 持ち主の domain の中の ID。`encodeURIComponent` で符号化、1〜160字 |
| `action` | 解決の入力でだけ使う。保存する URI には付けない |

解析と生成は `parseResourceUri`・`formatResourceUri`（`api/domains/resources`）だけを使う。

## 誰が URI を見るか

| 読み手 | 見せ方 |
| --- | --- |
| 会話エージェント | 番号 `a<n>` だけ（`## State` の仕事の行と提示中の行）。URI と ID は見せない |
| agency | 見せない。`HostTodo` の `title`（`[担当名] 依頼文`）と `nextActions`（種類の操作の言葉）で種類を伝える |
| サブエージェント | `RESOURCES` 区画に URI・種類・表示名・要約。`resource.read` で読み、作ったものを `finish.links` に書く |
| Web | URI（吹き出しのチップ、Markdown の `eumenes://` リンク、画面への指示） |

## 種類を足す

1. capabilities に `resource-kind` の item を登録する（builtin は `api/domains/capabilities/builtin/resource-kinds.ts`、bundle でも足せる）。item id は `resource.<種類>`。データは表示名・持ち主・操作・既定の操作・作る担当（`producedBy`）。
2. 持ち主の domain に `service/resource-adapter.ts` を置き、`ResourceAdapter`（`fromResultInTransaction`・`getInTransaction`・`search`・`read`・任意の `prepareInTransaction`）を実装する。`read` は `headWithin` で 600 token 以内に縮める。
3. `api/application/resources/wiring.ts` の `adapters` に足す。持ち主が複数の種類は ID の接頭辞（`<prefix>:<id>`）で `combineKindAdapters` に渡す。
4. 開く画面の Web adapter に `focus(targetRef)`・`viewing()`（必要なら `play(targetRef)`）を実装する（`web/src/components/domains/resource-focus` の補助を使う）。
5. `scripts/domains.ts` で、持ち主の domain の api と web の depends に `resources` を足す。

## API

| 経路 | 内容 |
| --- | --- |
| `GET /api/resources/resolve?uri=` | 解決（開く画面・対象・操作） |
| `GET /api/resources?query=&kind=&since=&until=&limit=` | 種類をまたぐ検索（新しい順） |
| `GET /api/conversations/:id/resources` | 会話の台帳（`a<n>`）とメッセージごとのリンク |

画面への指示の経路（`/api/screen/commands`）と、会話エージェント向けの即答の担当 `resources` は 2026-10-25 に削除した。
