# 事前登録: 出所の表し方（2026-10-17-source-format）

設計書: `spec/context-window-structure-and-evaluation-design-2026-10-17.md` §5.6、§6.1。
このファイルと `experiment.json`、事例、判定役の prompt、arm のソースは `prepare` で sha256 を `manifest.json` に固定する。freeze 後に変えると `prepare`・`run` が止まる。

## arm

| arm | 内容 | 状態 |
| --- | --- | --- |
| `baseline-compile` | 製品の現状（baseline）。`compileContext` の区画を generation-prepare と同じ位置に並べる | 実装済み |
| `baseline-compile-aa` | 同じ組み立てを別名で出す A/A 対照。候補として分析し、差が雑音であること（採用されないこと）を確かめる | 実装済み（基盤の対照） |
| A1 tag | 履歴以外の各ブロックを `<context source="…">` で囲む。frame 文は今のまま | C1 待ち |
| A2 tag+rules | A1 に `authority`・`freshness`・`certainty`・`covers` の属性を加える。扱いの規則は system の1か所に表でまとめ、各 frame 文は1行に縮める | C1 待ち |
| A3 markdown | タグの代わりに `## 長期記憶（参照・保存済み）` のような見出しを使う。中身の `#` はエスケープする | C1 待ち |
| A4 json | 各ブロックを `{"source":…,"authority":…,"data":…}` の JSON にする | C1 待ち |
| A5 tag+rules/user-role | A2 と同じ形式で、参考資料のブロックを user role に置く | C1 待ち |

操作結果の規則を system[0] から移すことは A0 を除く全 arm に共通とする（設計書 §6.1）。会話履歴は全 arm で包まない。
C1（ContextAssembly と `render` の分離）が入るまで、`baseline-compile` は操作結果・調査結果・recall・専門担当の seed を messages に載せない（`unsupportedSeeds` に記録する）。これらを使う事例（F5・F8 の一部など）は C1 の後に有効になる。

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
- token 比 = 候補の送信 messages の token 推定（UTF-8 bytes / 3 の切り上げ）の合計 ÷ baseline の合計。
- 応答時間の比 = 候補の呼び出し時間の中央値 ÷ baseline の中央値。
- prefix の安定度 = 同じ会話の連続する呼び出しの先頭の共有 bytes ÷ 前の呼び出しの bytes、の中央値（`--prefix` で与える。未計測なら基準7は「未計測」で、判定は incomplete）。
- 判定役は `sessionRole:"auxiliary"`、`contextPolicy:"exact"`、修復なし。応答が不正なら needs_adjudication。arm 名と ContextWindow の文字列は渡さない。
- fixture の段階の結果は基盤が動くことの確認であり、採否に使わない（`RESULTS` に「採否に使えない」と明記される）。

## 実行

- 試行は arm × 事例 × 3回。arm の順序は Williams 系列で均衡させる。並列数は 2 以下。再試行・多数決・応答キャッシュは使わない。
- 通信エラーは `transport_error` として別に数える。
- 再実行の条件: **要合意**（未記入のあいだは再実行しない。`transport_error` が残れば判定不能）。
- 判定役と手の採点の一致率が 0.9 未満なら、判定役の結果を採否に使わない（設計書 E5）。
