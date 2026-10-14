# 記憶担当（steward）検証記録 — 2026-10-14

対象: [記憶担当の実装計画](../../memory-steward-implementation-plan-2026-10-14.md)（改訂7＋§14.3）。
fixture（記録済みの LLM 出力を使う試験）と live（保存済みの LARM 接続先で実際に会話）を分けて記録する。実機器（音声）の受入は対象外。

## fixture

| 範囲 | 結果 |
|---|---|
| `bun run verify -- --domain memory` | 通過（115件） |
| `bun run verify -- --domain steward` | 通過（65件） |
| `bun run verify -- --domain continuity` / `inference` / `larm` | 通過 |
| `bun run verify -- --domain dialogue` | 全段階通過（214件）。最後の「検証中のソース変更」検査だけ、並行セッションの編集で失敗 |
| `bun test api` | 本計画が原因の失敗なし。残る失敗は基準版 `180d3ec` でも同じもの（`research-isolation` 2件、`chat-image-attachments`、`toolchain` の曖昧な対象、`music-e2e`、`world-adapter`）と、並行セッションの terminals 改修途中によるもの（`server`、`dev`、`logging`、`terminals-adapter`、`claude-code-toolchain`、`spool retention`） |
| 型検査 | 本計画の範囲でエラーなし（`tests/browser/object-recognition.spec.ts:265` は以前から） |

## live（2026-10-14、保存済み LARM、会話 ID `steward-accept-*`）

| # | シナリオ | 結果 | 記録 |
|---|---|---|---|
| A1 | 自己紹介を含む往復で記憶が溜まる | **合格（ばらつきあり）**。名前・辛い物・コーヒー・仕事・趣味が長期記憶に入った。「朝6時に起きる習慣」は記憶されなかった回がある | 初回は趣味・仕事が短期メモになり、同じメモが2回作られた → 指示文と重複防止を直して再確認（§14.3 の4） |
| A2 | アシスタントの推測を本人の事実にしない | **判定できず**。会話エージェントが推測を口にしなかった | fixture では確認済み |
| A3 | 訂正すると記憶が update され、回答が変わる | **合格**。「辛い物が苦手」→「食べられるようになった」で記憶が置き換わり、夕食の提案が変わった | `steward-accept-c` |
| A4 | 「忘れて」で対象だけが消え、原文は残る | **合格（修正後）**。初回は同じ発言の名前・辛い物の記憶まで消えた → 規則を直して再確認（§14.3 の1）。忘却に関わる判断記録も消えた | `steward-accept-d`（不具合）、`steward-accept-e`（修正後） |
| A5 | 生成中に取り消すと、忘却の依頼は実行されない | **一部合格**。取り消した run は `cancelled`、記憶は何も消えなかった。ただし取り消し時点で依頼ツールはまだ呼ばれておらず、「積まれた依頼の破棄」は live では再現できなかった（fixture で確認済み） | `steward-accept-j` |
| A5b | 既に覚えている内容を「覚えて」と頼むと、確認した版として保存し直す | **合格（修正後）**。初回はモデルが `none` を返した → ホスト側で再確認に回すよう直して再確認（§14.3 の3） | `steward-accept-i`、`reconfirmed: true` |
| A6 | DB のバックアップに戻して起動すると、除外と派生データの削除がやり直される | **live は未実施**（製品の DB を戻すため）。fixture で停止位置①②③と復元を確認済み | — |
| A7 | システム側の失敗で回答が出なかった run の制約が残る | **live は未実施**（失敗を意図的に起こせない）。fixture で確認済み | — |
| A7b | 長文（入力上限いっぱいの 7,912 文字）でも直近が保たれ、文脈が上限を超えない | **合格**。冒頭近くの「第3項の期限」を正しく答えた。steward への入力は最大約16KB | `steward-accept-l` |
| A8 | 同じ質問の繰り返しで逐語履歴が膨らまない | **合格**。4回とも逐語に残らなかった（要約2、破棄2）。`duplicateOf` は使われなかった | `steward-accept-h` |
| A9 | 手入れが走り、変更がなければ止まる | **合格**。各往復の後に consolidate-memory が1回走り、`changed: false` で止まった | 全シナリオ |
| A10 | steward が止まっても会話は続く | **live は未実施**。fixture で確認済み | — |

### 計測

| 項目 | 値 |
|---|---|
| 1 step の所要時間 | 約3.5〜9.3秒（curate-memory 4.5〜9.3秒、dispose 3.4〜5.6秒、summarize 約6.7秒） |
| 推論の経路 | 期限の修正後、steward の推論 99回すべて LARM。cloud への切替 0回 |
| 期限切れ・失敗 | 0回（`steward.unit_failed`、memory/steward の warn ログなし） |
| 最大の steward 入力 | 約16.5KB（長文の往復） |

### 観察（記憶担当の範囲外）

- 会話エージェントが利用者を設定の名前（「ゆうじ」）で呼ぶ。回答の日本語に中国語の字が混じることがある（「6时」）。
- curate-memory の出力で、モデルが依頼ではない文を `resolve.request` に入れることがある（ホストが捨てる）。
