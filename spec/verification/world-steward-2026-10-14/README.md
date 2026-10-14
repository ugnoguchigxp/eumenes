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
