# 取得先学習・動的SKILL 検証記録

状態の区別: **実装済み**はコードとfixture試験が存在する範囲、**検証済み**はこの記録に結果を書いたものだけ、**計画**は未実施。fixture、live、実機器は混ぜない。

| 項目 | 状態 | 備考 |
| --- | --- | --- |
| backend domain (T01〜T21) と application配線 | 実装済み | 各domainのfixture試験あり。最終の全体gate結果は下の記録欄 |
| CLI・client・Web panel (T22〜T23) | 実装済み | clientを差し替えた試験。実backendのbrowser E2E（T24c）は未記録 |
| 鎌倉 live（実LARM＋実Web） | 計画（未実施） | 実行結果なし |
| 静岡市 live | 計画（未実施）かつ公開取得元が未対応 | [source-feasibility.md](source-feasibility.md): Yahoo!天気のページは「静岡市葵区」で、市単位の資料を確認できていない。city対応完了は宣言しない |
| AAPL live | 計画（未実施） | quote-json-v1は形式確認とfixtureまで |
| 実機器の音声3往復 | 計画（未実施） | 完了まで音声MVPの完成を宣言しない |

## 実行コマンド

```sh
bun run verify -- --domain research-routes   # 以降、capabilities / tool-runtime / agent-runtime / web-research / queue / inference / larm / dialogue / voice-dialogue / settings
bun run verify:all
EUMENES_LIVE_RESEARCH_ROUTES=1 LARM_BASE_URL=... LARM_API_TOKEN=... bun run verify:live -- --domain research-routes
```

liveには`EUMENES_LIVE_RESEARCH_ROUTES=1`、`LARM_BASE_URL`、backend側のLARM credential（`LARM_CONTROL_TOKEN`または`LARM_API_TOKEN`）が必須で、fixture fallbackはありません。一時DBの隔離backendを起動し、認証付きAPIから鎌倉・静岡市・AAPLのcold→登録完了待ち→warmを実行します。登録待ちは初回回答時間に含めません。生出力は`verification-reports/research-routes/live.json`（Git対象外）。

## 判定の分け方

- 機能合格（スクリプトが数えるもの）: coldの実検索（acquisitionMode=search、tool呼出し2以上）、登録がactiveになる、warmがcachedで1tool・モデル2回、warm前後でdraft/版が増えない（登録job0）。
- 値・日付・対象の一致は人が回答と照合する（`valueReview: required_manual`）。自動合格にしない。
- 速度目標（warm≤10秒、coldの半分以下）は機能と別欄。1組の結果から達成を主張しない（最低5組、比較対象ごと、sourceChanged/unsupported注記）。
- 実サイトの404/timeout/構造変更はfixture E2Eのみで、live成功と記録しない。

## 記録

| 日付 | 範囲 | 結果 |
| --- | --- | --- |
| 2026-10-09 | domain gate(fixture) | research-routes / web-research / inference / larm / voice-dialogue は `verify --domain` 通過。capabilities / tool-runtime / agent-runtime / queue / settings は、通過後に別作業(world・timers・queue runner・dialogue世界連携)の未完了差分が入り「source changed」または型・lint失敗で再確認できていない(本機能由来の失敗は確認していない) |
| 2026-10-09 | bun test ./api ./client ./cli / vitest / browser | 628中627通過。失敗1件は `dialogue/test/memory-integration.test.ts`(別作業の `memory/service` 変更による `feedResyncRequired`)。vitest 100件通過。`tests/browser/research-routes.spec.ts` 1件通過(fixture) |
| 2026-10-09 | `verify:all` | 未通過。別作業の `api/domains/world/service/context-render.ts` 構文エラーで format/tsc/lint が停止。本機能の再実行は上記が安定してから |
| 2026-10-09 | 独立レビュー | P1×1・P2×1・P3×5を修正済み(source_unusableの失効、announcedAt混入、候補保存、容量、bytes、result_expired、編集フォーム) |
| （未記入） | live | 未実施 |

全体gateと live が通るまで正本・チェックリストは archive しない。
