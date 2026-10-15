# World Model と steward の接続 — 検証記録（2026-10-15）

対象: [接続計画](../../world-steward-implementation-plan-2026-10-14.md)（改訂4＋§18）。fixture と live を分けて記録する。

## fixture

| 範囲 | 結果 |
|---|---|
| `bun run verify -- --domain world` / `steward` / `goals` / `dialogue` / `memory` | 通過（world 186、steward 103、goals 25、dialogue 227、memory 121） |
| `bun run verify -- --domain settings` / `inference` / `continuity` | 通過 |
| World Model パッケージ（`../eumenes_world_model`、0.0.1） | `bun run verify` 通過（833） |
| application の World 関連（`world*.test.ts`、`world-query-*`、`memory-adapter`、`capability-seed`） | 通過。残る失敗は並行セッションの kanban（`toolchain-history` の一覧）と google-accounts（終了順） |

## live（保存済み LARM、World ON、会話 ID `world-accept-*`）

| # | シナリオ | 結果 |
|---|---|---|
| L1 | 外の世界の状態を話す | **一部**。対象の登録と本人の報告の採用は動いた（`world-accept-a/b`）。モデルが対象の ref を取り違える・新しい対象の登録を忘れる回がある。取り違えはホストの「根拠の発言に名前が出ているか」の検査で落とす |
| L2 | アシスタントの説明が仮説になる | **不十分**。仮説は入るが内容が浅い（「関係がある」程度）、または書かれない |
| L3 | 訂正 | **不十分**。関係の訂正はホストが「取り消し＋追加」に変換するよう直したが、live のモデルは訂正を正しい形で書けなかった |
| L4 | 話題の対象で World の状況を使う | 未判定（L1 の書き込みが不安定なため） |
| L5 | `world_query` | **一部**。修正後、`world_query` が選ばれ完了した。回答の文面が結果をそのまま受け取ったような不自然な文になる |
| L6 | 「〇〇のことは全部忘れて」 | **合格**（修正後、`world-accept-e`）。対象と主張が消え、無関係な目標と記憶は残った |
| L7 | 目標 | **合格**。「音声応答の遅延を半分にしたい」が採用された |
| L8 | LARM が使えないとき cloud | 未実施 |

### live で見つけて直した不具合

| 不具合 | 修正 |
|---|---|
| 関係の主張で predicate が空だと捨てられる | 関係の種類を predicate に補う |
| 対象の ref の取り違え・質問からの根拠のない主張 | 根拠の発言に主語・関係先の名前が出ていなければ捨てる（`not_in_evidence`）。使われない新しい対象は登録しない（`unused_entity`） |
| 関係の訂正ができない（`relation_not_changeable`） | 本人の訂正を「取り消し＋新しい関係」に変換 |
| 振り分けがアシスタントの説明を World の対象外にする | 指示文を修正 |
| `memory_request` の bundle が revision 衝突で登録されない | revision を上げた |
| 「全部忘れて」で `memory_request` が選ばれない | 例文と使う場面を足した |
| 依頼の ID の書き間違い（`"forget"`） | schema で依頼の ID だけに制限 |
| 無関係な記憶を忘れようとする | ホストが依頼の文と内容の重なりを確かめ、重ならない対象を捨てる |
| 対象に含まれる主張・目標まで数えて上限超過 | 対象に含まれるものを件数から除く |
| World の対象名の照合が大文字小文字を区別 | ホスト側で正規化して照合 |
| `world_query` の回答が `report_invalidated` で失敗 | 結果の比較で照会時刻（`asOf`）を除外 |
| `world_query` が本人の説明でも選ばれる | 使う場面を質問に限定し、依頼は `memory_request` へ誘導 |

### 観察（記録の質）

- World の契約（対象の登録、関係、訂正）を、現在の会話用モデルは正しく書けないことが多い。ホスト側の検査で誤りの保存は防げるが、記録される量と質は低い。
- 質問文から「本人の報告」を作ってしまうことがある（名前は発言に出ているので根拠の検査を通る）。

## live（World の記録だけ cloud の軽量モデル、2026-10-15）

設定 `world.curationResourceId` に、保存済みの Claude Agent SDK 接続の軽量モデルの resource を選んだ。curate-world だけがその resource で推論し、他の手順は会話と同じ route のまま（`inference_attempts` と `inference.cloud_selected` で確認）。会話 ID `world-haiku-a/b/c`。

| # | シナリオ | 結果 |
|---|---|---|
| L1 | 外の世界の状態を話す | **合格**。新しい対象3件の登録と、本人の報告2件の採用。ref の取り違えなし |
| L2 | アシスタントの説明が仮説になる | **合格**。「freee が月末締め作業を減らす」「freee が CSV の手動取り込みを減らす」を `model_hypothesis` で採用。説明のない回答（確認の質問だけ）では何も書かなかった |
| L3 | 訂正 | **一部**。担当者の訂正は「取り消し＋追加」で反映。移行時期の訂正は、発言に対象名が出ないため `not_in_evidence` で落ちた |
| L4 | 話題の対象で World の状況を使う | **不合格**。担当者が「担当作業＝文字列」の値として記録され、topic slice（対象自身の状態と因果・依存の関係だけ）に入らない。因果の話題では会話モデルが `world_query` を選び、空の結果をそのまま説明した（内部の語 `not_computed` も出た） |

### 観察

- 記録の形式（ref、登録、関係、訂正）は、軽量の cloud モデルでほぼ正しく書ける。仮説も具体的になった。
- ホストの根拠の検査（`not_in_evidence`）が、言い換えた名前（「CSVを手で取り込む」→「CSV手動取り込み」）や、名前を省いた訂正（「来月じゃなくて再来月」）を落とす。小さいモデルの取り違えを防ぐための検査で、今は厳しすぎる。
- L4 と L5 の失敗は会話用のモデル側（ツールの選び方、結果の言い換え）と、topic slice の範囲による。

## World の照会を sub-agent の調査にした後（2026-10-15、[設計](../../world-research-subagent-2026-10-15.md)）

### fixture

| 範囲 | 結果 |
|---|---|
| `bun run verify -- --domain` world / dialogue / voice-dialogue / agent-runtime / tool-runtime / steward / memory / goals | 通過（world 168、steward 104、memory 121、goals 25、tool-runtime 37） |
| `api/application/world-research.test.ts` | 17 通過（委譲、worker 入力、find の対象と目標、world_claim の読み取り、親への投影に ID と本文が入らない、調査中の取り消し・訂正・忘却で不採用、World OFF で提示しない、切り詰めで coverage partial） |
| `world-acceptance-p3`、`capability-upgrade`、`capability-seed` の World 部分 | 通過。残る失敗は並行作業の kanban・codex-tasks（seed の一覧、`runner_path_not_canonical`）と既知の `toolchain` ambiguous target |

### live（保存済み LARM、World の記録は cloud の軽量モデル）

| 会話 | 質問 | 結果 |
|---|---|---|
| `world-haiku-c` | 「freee の移行について誰に聞けばいい？」 | 不合格。候補に World の調査は出たが、会話の AI は会話履歴の調査を選んだ（その調査も報告の形式の誤りで失敗） |
| `world-haiku-c` | 「World の記録だと、freee にすると月末締めはどうなりそう？」 | 不合格（skill@2）。World の調査が選ばれ、調べ役は `world.find` → `world.query` ×2 まで動いたが、報告の claim に根拠参照（evidence）を書かず2回拒否された。会話の AI は履歴にあった旧方式の回答を写した |
| `world-research-a` | 同上（新しい会話） | 不合格。候補の上位4件に World の調査が入らなかった（例文が質問の形に合っていない） |
| `world-research-b`（skill@3、toolchain@5） | 「World の記録だと、freee にすると月末締めはどうなりそう？」 | 不合格。World の調査が選ばれたが、調べ役が `world.find` だけで照会せず not_found を返した |
| `world-research-b` | 「freee の移行について誰に聞けばいい？」 | **一部**。World の調査が選ばれ、報告は根拠つき・partial（担当は佐藤、月末締めは現在3日、「freee が月末締め作業を減らす」は仮説）。回答に内部の語は出なかった。会話の AI が記録にない名前（「藤原」）と作業項目を足した |

直したもの:
- skill@3: claim は text と evidence（eN の配列）を必ず持つ、根拠が無いときの not_found／failed の書き方、要約のキー名 `claims` を `documents` に。
- toolchain@5: 「〜にするとどうなりそう？」「誰に聞けばいい？」「World の記録だと…」の使う場面と例文。
- skill@4、package@4、toolchain@6: 対象が見つかったら必ず `world.query` を呼んでから報告する、limitations にも内部の語を書かない。
- `world.query` の port: snapshot・gaps で `entityId` を1件だけ渡したら起点1件として読む（live で調べ役が繰り返した誤り）。mode に合わない入力は `invalid_input` と直すべき項目名を返す（以前は理由のない失敗で、同じ入力を3回繰り返した）。

| 会話 | 質問 | 結果 |
|---|---|---|
| `world-research-c`（skill@4） | 「World の記録だと、freee にすると月末締めはどうなりそう？」 | 不合格。照会はしたが snapshot に `entityId` を渡して入力エラーを3回繰り返し、not_found（上の port の修正で対応） |
| `world-research-d` | 「World の記録だと、freee にすると月末締めはどうなりそう？」 | **合格**。`world.find` → `world.query`（snapshot）→ 報告 partial（根拠5件）。回答は「今は3日」「銀行・カード連携に対応」を本人の報告として、「月末締め作業が減る」を仮説として分けて伝え、断定しなかった。内部の語なし |
| `world-research-d` | 「freee の移行について誰に聞けばいい？」 | **合格**。報告 partial（根拠4件）。回答は「佐藤さんに相談するのがよさそう」で、記録にない名前は出なかった |
