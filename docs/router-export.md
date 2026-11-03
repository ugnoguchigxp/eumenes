# Router 評価データの書き出し

```sh
bun run cli -- router-export --out /Users/yourname/router-evaluation/snapshot --with-embeddings
bun run cli -- router-export --out /Users/yourname/router-evaluation/recent --since 2026-11-01T00:00:00+09:00
```

認証付き `GET /api/router-export` を CLI の型付きクライアントで呼ぶ。backend の利用が必要。書き出し処理は `readSnapshot` の読み取り専用接続だけを使い、SQL は所有 domain の公開読み取り操作に置く。migration・seed・prune・推論・ツール実行・外部サービスへの接続は行わない。カードと履歴は同じ SQLite スナップショットから取得する。既存のルーティング判断や登録方式は変更しない。

出力先は Git 作業ツリーの外の新しいディレクトリに限る。Git の ignore 設定に関係なく、作業ツリー内は拒否する。既存ディレクトリも拒否し、上書きしない。ディレクトリは `0700`、ファイルは `0600`。一時ディレクトリで作成後に公開し、manifest が揃ったものだけを完成したスナップショットとして扱う。CLI の標準出力は件数だけで、本文や接続先を表示しない。

## ファイルと範囲

| ファイル | 単位・範囲 |
| --- | --- |
| `cards.jsonl` | 現在登録されている全 Toolchain の active revision（無効なものも含む）、組み込み read ツール、固定の会話・記憶候補。実行部分・binding 本体・SKILL・引数・設定は含まない |
| `utterances.jsonl` | 保存済みの通常会話 run と選択・Router 記録の和集合。`turnId` は dialogue の run ID。専門担当セッションへの直接入力は通常 run の抽出から除外する |
| `choices.jsonl` | 保存済みの選択結果または Router trace を持つ run ごとに1行。同じ run の重複はまとめる。通常会話は `selectedId: "none"`。未決定・拒否・実際の経路不明は `null` |
| `corrections.jsonl` | 保存済みのユーザー訂正。active / retracted / stale / conflict をそのまま保持 |
| `embeddings.jsonl.gz` | `--with-embeddings` 指定時の保存済みベクトル。1行は card ID × revision × passage 番号 × space ID。現在のカード文の digest と一致するものだけ。ベクトルの再計算はしない |
| `manifest.json` | スキーマ版1、ソースの commit SHA と dirty、件数、出力日時、since、埋め込み空間情報、取得できない項目と理由・件数 |

`--since` はタイムゾーンを含む ISO 日時で、境界を含む。通常 run は開始日時、選択・Router trace は記録日時、訂正は更新日時で絞る。カードは現在の全件を保持し、埋め込みも履歴期間で絞らない。直前の user / agent 発言は期間より前でも取得する。

選択・Router trace の通常保存期間は30日。書き出し時には失効分を削除せず、スナップショットに残っているものを取得する。過去に削除された履歴は復元できない。撤回された発言を trace 内の複製から復元することもしない。

`result` は保存済み outcome の completed / answered を success、failed を failure、cancelled を cancelled に対応させる。partial / not_found / clarification_required / expired、未記録は `null` とし、元の値を `recordedOutcome` に残す。会話 run が完了しているという理由だけで、その先の仕事を成功扱いにしない。

Router が on で有効な判断記録がある場合は Router の候補と決定を採用する。shadow は実際に動作した LLM 側を採用し、`routerMode` に shadow を残す。判断に失敗した trace だけでは実際の経路を確定しない。確率と embedding 類似度は別フィールドにする。

## カード文の再現

現行検索はカード全体を1本のベクトルにしない。`toolchainPassages` の返す順序を `embeddingPassages` にそのまま保存する。

1. `${title}: ${summary}`
2. `useWhen` の各要素（元の順序）
3. `examples` の各要素（あれば、元の順序）

`embeddingText` はこの配列を改行1文字 `\n` で結んだもの。配列の要素ごとに passage embedding を作り、query embedding との内積の最大値をカードの類似度とする。連結した文1本を embedding にした値では現行検索を再現できない。`avoidWhen`・タグ・別名・kind は埋め込み文に追加しない。query は発言先頭2000文字。

`routerText` は別の共通関数 `routerPassage` を使う。

```text
${title}: ${summary}（${useWhen の先頭2件を「／」で連結}）
```

用途がない場合は括弧を付けない。組み立て後に JavaScript の `slice(0, 300)` で最大300文字にする。固定の会話・記憶候補の `routerText` は、実際の Router が読む SystemContext を使う。これらは embedding の対象ではなく、embedding 関連項目は `null`。

## 取得できない値

- 全カードの `updatedAt`：定義改訂の作成日時しか残っておらず、有効状態の変更まで含む最終更新日時がない。
- 発言時の `activeToolchainId` / `activeTaskId`：当時の状態が保存されていない。現在の状態で補わない。
- `resourceKinds`：その run に保存された閲覧中 URI・メッセージのリソースリンクから取れる場合のみ取得。参照情報が残っていなければ `null`。
- 直前の user / agent、本文、元メッセージID・時刻：保持されている発言から取れる場合のみ。削除・保持範囲外・関連 run が欠ける場合は `null`。
- 操作種別・影響・承認：元の定義が宣言している範囲だけ。`requiresApproval` は minImpact が modify_existing / irreversible の場合の最低限の承認要否であり、個別の実行時承認結果ではない。実行時には対象や操作によりさらに承認が必要になり得る。
- 現在の埋め込みモデル名：DB の索引は空間ハッシュだけを保存し、現在の外部サービスのモデル名を永続化していないため `manifest.embeddingModel` は `null`。保存済み Router 記録の空間情報がハッシュと一致する場合だけ、ベクトルの `modelId` を補う。次元は保存済み Float32 ベクトルから取得する。異なる空間を混ぜて比較しない。
- 仕事・承認待ち・訂正先などの動的候補：各ターンに生成される当時の説明文は保存されていない。カード本文を復元せず、保存済みの候補 ID を choices に残す。

認証・接続情報は出力の許可リストに入れない。加えて、本文に含まれる保存済み接続文字列・EUMENES 環境変数の値・認証ヘッダー・認証情報の代入・秘密鍵・認証付きURLを `[REDACTED]` に置換する。置換した文字列の件数を manifest に残す。氏名など通常の個人情報は保持するため、スナップショットの配布先は管理すること。

## 検証

fixture はカード文・無効カード・直前の発言・旧 LLM / Router / shadow・訂正・期間境界・stale ベクトル除外・読み取り専用性・秘密の除外を検証する。認証付き API → 型付きクライアント → JSONL/gzip 書き出しもプロセス内で結合検証し、サーバーを起動しない。

```sh
bun test api/application/toolchain/router-export.test.ts
bun run verify -- --domain capabilities --domain toolchain-history --domain conversation --domain dialogue --domain settings
```

画面を変更しないためブラウザー E2E・実機器試験は対象外。fixture と実データの件数・制約は区別して報告する。
