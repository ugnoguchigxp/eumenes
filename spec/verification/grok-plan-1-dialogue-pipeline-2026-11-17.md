# 計画1　会話から仕事の完遂まで　検証記録

2026-11-17。対象は [実装計画](../grok-improvement-plan-1-dialogue-pipeline-2026-11-17.md) の最初の作業、1-01、1-02。1-03以降と live は未実施。

## 条件

- 基準コミット `204280c675cc67809ddf1cd1ab623e4243d06a5e`。検証コピーは detached HEAD の作業ツリーで、`node_modules` は本体へのリンク。製品DB、設定、秘密、運用ログはコピーしていない。
- 本体の作業ツリーには別作業の未コミット差分がある。再現と合格は、その差分を含まない基準コミットに今回の4ファイルを載せたコピーで確認した。
- Bun 1.4.4。`initial_instructions` はこのセッションの利用可能ツールに無かった。
- サーバーの起動・停止、live 接続、外部担当の起動はしていない。

変更ファイルの SHA-256:

| ファイル | SHA-256 |
| --- | --- |
| `api/application/toolchain/router.fixture.ts` | `5f383569b89ca0e93ec8862664ed96b7b744fd00dbfb28864d2d272e0f5c6f0c` |
| `api/application/toolchain/toolchain.fixture.ts` | `22e6ae128b93b66e9dc4f87d78317b83148e9be0556c19c0071a9dd8106550dc` |
| `api/application/pipelines/pipeline-execution.test.ts` | `5a3262e4da448d2f0575be33bfd417c840aba3ed4615030ff499f56aa44456b0` |
| `api/domains/dialogue/test/routed-router.test.ts` | `d926a349c1c64f003dab8ac27c114916e2db61c4a157f2a012e7cbe4c709ac8c` |

## 修正前

`bun test ./api/application/pipelines/pipeline-execution.test.ts` は 0 pass / 3 fail。

| 試験 | 到達点 | 失敗 |
| --- | --- | --- |
| 二段タイマー | 会話 run は completed。Router は requests 1件、`timers.manage` の単一 run | 案内が null。期待は「「パイプライン」に頼みます。」 |
| 回答 | 親は completed、実行は1件、TODOは元の1件 | `structures` が 0。期待は 1 |
| 取消 | 親は cancelled、実行は1件、TODOは元の1件 | `structures` が 0。期待は 1 |

構造判定は `selectRouter` の版 `turn-structure-v8` へ来ていた。試験の `options.structure` は、モデル応答の system 全文が配布プロンプトと一致する分岐にだけ接続されていた。host は構造プロンプトへ handoff の SystemContext を足すため、その分岐には入らない。

## 1-01　結合fixtureの構造判定

`fixtureRouting` は、`options.structure` があるとき `selectRouter` の版が `turn-structure-v8` ならその関数の戻りを `{ decision }` として返す。後段の候補選択は、構造判定が埋めないキャッシュを読まず、各依頼の候補に対する既存の pick を使う。`liveRouting` と、`options.structure` を渡さない既存 fixture は変えていない。

回答・取消の試験は発話が2回ある。現行 Router は毎回構造を尋ねる。初回は pending も controls も空なので、試験は依頼全文を1件の requests として返し、構造判定の件数には数えない。件数と pending・controls の期待は、返信の構造プロンプトに残している。

修正後の同じコマンドは 4 pass / 0 fail（失敗試験を含む）。

| 試験 | 終端 | 件数 |
| --- | --- | --- |
| 二段タイマー | 親 completed、案内は「「パイプライン」に頼みます。」 | 構造1、計画2、子コマンド2、タイマー2、実行一覧1 |
| 回答 | 同じ親が completed、TODOは元の1件 | 構造1、計画2、子コマンド1 |
| 取消 | 同じ親が cancelled、TODOは元の1件 | 構造1、計画1、子コマンド0 |
| 前段失敗 | 親 partial | 実行一覧1、子コマンド1、タイマー0 |

境界は、既存の `routed-router.test.ts` が不正な構造、期限後の選択、取消後の構造を台帳0件で通している。今回の新規修正は重ねていない。異なる番号の候補は、選択応答のキーを別の依頼番号にした試験を追加した。選択口は1回、trace の error は `route_selection_invalid_response`、TODO と archived は0、toolchain の採用は0、delegate は返信のツールに含まれない。

## 1-02　依存工程

二段タイマーの2件目の command 入力 `references` に、1件目の確定ラベル `pipeline timer 1` が含まれる。依頼文の組み立ては変更していない。前段を未知のツールで失敗させると、依存先の command は呼ばれず、タイマーは0件のまま親は partial になる。

## 計画3へ渡す試験登録

新しい試験ファイルは追加していない。`api/application/pipelines/pipeline-execution.test.ts` は登録済み。dialogue の追加は所有パスの既存試験ファイル内。

## 未実施

- 1-03、1-06、1-08、1-09、1-11、1-12、1-13、1-15、1-16、1-18 の評価
- 1-04、1-05、1-07、1-10、1-14 の再現後修正
- 1-17 の fixture 分割
- `bun run verify -- --domain pipelines` と dialogue・agent-runtime を含む verify
- live の通常会話
