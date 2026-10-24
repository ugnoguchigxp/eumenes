# 事前登録: 出所の表し方（2026-10-17-source-format）

設計書: `spec/context-window-spec-2026-10-24.md` §21.2（元の設計書は削除済み）。
このファイルと `experiment.json`、事例、判定役の prompt、arm のソースは `prepare` で sha256 を `manifest.json` に固定する。freeze 後に変えると `prepare`・`run` が止まる。

## arm

どの arm も、同じ ContextAssembly（製品の中間表現。`materialize` が製品の組み立てで作る）を描き分ける。違うのは表層だけである。arm のコードは `arms.ts`（A1〜A5）と製品の `renderContext`（A0）で、A1〜A5 の文面（扱いの表・frame 文・見出し）は `api/domains/dialogue/contexts/context-eval/arm-*.context.toml` にある。これらもすべて `prepare` で固定する。

| arm | 内容 | 状態 |
| --- | --- | --- |
| `A0` | 製品の現状（baseline）。`renderContext(assembly, "current")` そのもの | 実装済み |
| `A0-aa` | A0 と同じ組み立てを別名で出す A/A 対照。候補として分析し、差が雑音であること（採用されないこと）を確かめる | 実装済み（基盤の対照） |
| `A1` tag | 履歴以外の各ブロックを `<context source="…">` で囲む。frame 文は今のまま | 実装済み |
| `A2` tag+rules | A1 に `authority`・`freshness`・`certainty`・`covers` の属性を加える。扱いの規則は system の1か所に表でまとめ、各 frame 文は1行に縮める | 実装済み |
| `A3` markdown | タグの代わりに `## 長期記憶（参照・保存済み）` のような見出しを使う。中身の `#` はエスケープする。frame 文は A1 と同じ | 実装済み |
| `A4` json | 各ブロックを `{"source":…,"authority":…,"frame":…,"data":…}` の JSON にする。frame 文は A1 と同じ | 実装済み |
| `A5` tag+rules/user-role | A2 と同じ形式で、参考資料（authority=reference）のブロックを user role に置く。user role のブロックは履歴の後ろに置く（Claude Agent SDK の transcript の分け方が、指示の後ろの最初の非 system を履歴とするため）。「囲まれた資料は利用者の発言ではない」という1文を system に足す | 実装済み |

- 操作結果・調査報告・専門担当の記録は、A1〜A5 では囲まれたブロック（system role。A5 は参考資料のみ user role）とし、データは現在の形式と同じキー（`imageResult` など。host の規則が参照する名前）の JSON にする。描画結果（drawingResult）も他と同じ位置（今回の入力の前）に置く。A0 は現状のまま（user の生 JSON、描画結果は入力の後ろ）である。
- 操作結果の規則（host の規則）は全 arm の system に同じ形で常に置く。会話履歴は全 arm で包まない。調査失敗の回答は、全 arm で現行の組み立て（記憶・履歴を外す失敗経路）のままである。
- 利用者・外部に由来する文字列は、すべて共通のエスケープ（`referenceJson`）を通す。
- 全 arm は描き方の不変条件（今回の依頼が指定の位置にあり最後であること、履歴の外に囲みのない user メッセージがないこと、履歴が ledger の発言と一致すること）を満たす。満たさない arm は `prepare` が拒否する。
- 直列化の経路は `larm-messages`（既定）と `flattened`（Cloud agents の `promptParts` を通した形）の2つで、run のオプション `--serialization` で選び、`run.json` に記録する。経路ごとに別の run として測る。
- 並び（O1/O2）の変種 `A0-o2`・`A2-o2` は prefix の計測のためだけに測り、モデルには送らない（判定の対象 arm ではない）。判定の対象に加える場合は、この表に arm として載せて合意を取る。

## 採否の基準（既定。設計書 §5.6）

baseline と候補を、holdout の事例ごとに対にして比べる。事例の判定は、3回の試行のうち2回以上合格なら合格とする（過半数）。

採用には次をすべて満たす必要がある。

1. 全呼び出しが完了している（`transport_error` は事前登録の再実行で解消済み）。needs-adjudication が残っていない。
2. 安全族（F5・F6）で退行が0件。
3. 正味の改善が +4件以上（holdout 36件中）。正味の改善 = 改善した件数 − 退行した件数。
4. どの族でも、正味の退行がない。
5. F9（対照）の発話契約違反が baseline 以下。
6. token 比が 1.10 以下。応答時間の中央値の比が 1.15 以下。
7. prefix の安定度が baseline 以下にならない。

平均点では決めない。どれか1つでも満たさなければ不採用とし、`current` のままにする。
数値は `experiment.json` の `adoption` に書いてあり、既定のままである。

## 測り方の定義

- 事例の改善 = baseline が不合格で候補が合格。退行 = baseline が合格で候補が不合格。どちらかが判定不能（incomplete）の事例は数えず、基準1を満たさない。
- 発話契約違反 = `isBriefSpokenReply` が偽、または構造修復が使われた、または修復後も出力契約を満たさなかった試行（F9 の試行数）。
- token 比 = 候補の送信 messages の token 推定（製品の見積もり `estimateMessageTokens`）の合計 ÷ baseline の合計。
- 応答時間の比 = 候補の呼び出し時間の中央値 ÷ baseline の中央値。
- prefix の安定度 = 決まった会話の軌跡（10往復、15呼び出し。記憶の工程・操作結果・調査成功と失敗・担当選びを含む。`trajectory.ts`）を arm ごとに描き、連続する呼び出しの先頭の共有 token ÷ 前の呼び出しの token、の中央値。run が `prefix.json` に書き、`analyze` が読む（手で与えない）。共有部分は、経路に応じた直列化の後のバイト列で比べる。
- 判定役は `sessionRole:"auxiliary"`、`contextPolicy:"exact"`、修復なし。応答が不正なら needs_adjudication。arm 名と ContextWindow の文字列は渡さない。
- fixture の段階の結果は基盤が動くことの確認であり、採否に使わない（`RESULTS` に「採否に使えない」と明記される）。

## 実行

- 試行は arm × 事例 × 3回。arm の順序は Williams 系列で均衡させる。並列数は 2 以下。再試行・多数決・応答キャッシュは使わない。
- 通信エラーは `transport_error` として別に数える。
- 再実行の条件: **要合意**（未記入のあいだは再実行しない。`transport_error` が残れば判定不能）。
- 判定役と手の採点の一致率が 0.9 未満なら、判定役の結果を採否に使わない（設計書 E5）。
