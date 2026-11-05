# Agency Shadow P0 事前登録（固定基準測定）

作成: 2026-11-05、正式runの前。正本の契約は[実装依頼・受入計画](../../agency-shadow-p0-p1-implementation-request-2026-11-05.md) §3。本書はP0だけを対象にする。P1の実装・試験、製品反映、実モデル・課金・外部サービスの試験は行わない。

## 1. 測る対象（第一基準）

| 項目 | 値 |
| --- | --- |
| 本体 | 候補workspace `eumenes`、HEAD `056afd43115c0ae7df91449ad62baa0000d73c60` |
| 基準Agency | 本体が導入した配布物 `node_modules/eumenes-agency`（`vendor/agency/eumenes-agency-0.1.3-e7b4096d5bd5.tgz`、sha256 `b4fc0e1e…cd3f7d`、gitSha `e7b4096d5bd5…`、`p0e-instructions-17`／`host-rules-14`） |
| 組立て | 本体の`createHostRuntime`（F・各opt-in flags・予算上書き）と`createAgencyLlmPort`（最終messages・native schema・出力上限・session options）。fixture化するのは`captureBackgroundControlInTransaction`／`executeControl`の推論境界だけ |
| 比較lane | 隣接Agency `79c0418d3a27…` の`src/`。評価プロセス内のload pluginで本体の`eumenes-agency` importを差し替える。基準ではない |

実ロードしたentryのrealpath、配布dist全92ファイルのdigest、tgz checksum、本体package.json／bun.lockの参照、版定数、本体のimportと評価器が同じmodule instanceであること（エラークラスの同一性）をrunごとにmanifestへ記録し、一つでも不一致なら測定を開始しない。

## 2. ケース・ラベル・応答

| 区分 | 件数（step） | 内容 | 意味評価としての扱い |
| --- | --- | --- | --- |
| dev | 10（10） | 既存`eval/initiative/cases.ts`の10場面と既存ラベル（expected）。入力は変更しない | 応答は固定の**合成台本**でありモデル判断ではない。意味採点不可（scorable=false） |
| mechanism | 14（17） | 本作業で作った追加の合成fixture M01–M14。未知ref、古い版、承認必須、予算満杯、返却とreviewの重なり、同じ障害の再到着、取消中に信号を無視するLLM、再起動、観測重複・同一ID内容違い、受付内の保存失敗、JSONでない出力、通信失敗と再試行、外部資料中の承認主張、委譲入力の形式違反 | holdoutではない。独立未見と呼ばない |
| fault-injection | 4（5） | 別run。runner例外、再試行しない推論失敗、schema違反の選択、停止後の未実施2段 | 失敗・欠測の記録を確かめるためだけ |
| holdout Q01–Q08 | 0（予定16） | **未作成・未実施**。利用者が指定する独立評価担当が作成・ラベル確定する | 保留 |

各stepの期待（ticket有無と種類、許容するdecision source、必須の拒否コード、本体受付の結果とコード、update／select呼出し上限、attempt数、受理・拒否されたcontrol receipt数、wake理由、期待された拒否か）は`eumenes_agency/eval/initiative/p0-cases.ts`の`expect`に固定した。拒否コードは配布版と同一の`participation.ts`（`e7b4096`から無変更）を読んで決めた。期待と台本のdigestはmanifestの`fixed.labels`／`fixed.responses`に入る。

### 2.1 正式run前のdry runで直したもの

scratch（リポジトリ外）で4回dry runし、**台本の定義誤り**だけを直した。期待の緩和はしていない。

- selectまで到達しない場面（候補なし・JSONでない更新・観測重複）に置いていたselect応答を削除。5観測の場面はbatchSize 4のため更新応答を2件にした。
- M08のs1は候補を引用したwaitが候補をdeferredにし版を上げるため、s2の引用が古い版になっていた。s1を候補を引用しないwaitに変更。
- M05は同じintentへの返却がreview期限を返却時刻+24hへ更新するため、返却とreviewが重ならなかった。review期限切れの別intentを加え、wake理由`work_returned`と`review_due`の両方を期待へ**追加**した（条件を厳しくする方向）。
- 比較器が試行をまたぐrequest連番（transport identity）を生値で比べて対象外の試行まで差分にしていたため、連番を試行内に閉じ、attempt IDは再生器の一対一対応表で検査するようにした。

## 3. 実施するrunと再現コマンド

作業ディレクトリ`eumenes_agency`、出力先`eumenes/verification-reports/agency-shadow/p0-20261105/`。

| run | コマンド |
| --- | --- |
| 基準（record） | `bun eval/initiative/p0.ts record --out <out>/baseline-record` |
| 同一再生 | `bun eval/initiative/p0.ts replay --from <out>/baseline-record --out <out>/baseline-replay` |
| 故意不一致×7 | `… replay --from <out>/baseline-record --out <out>/tamper-<kind> --tamper <kind>`（system、options、prefix、drop-entry、extra-entry、response、identity。対象は予定1件目の試行） |
| 隣接src lane | `… replay --from <out>/baseline-record --out <out>/adjacent-src-replay --agency adjacent-src` |
| 故障注入 | `bun eval/initiative/p0.ts faults --out <out>/faults` |
| 再集計 | `bun eval/initiative/p0.ts aggregate --run <各run>` |

反復1（固定応答のため同一入力の反復は独立経験に数えない）。順序はrep→ケース記載順→step順。乱数は入力に使わない（transport IDだけがプロセスごとのboot IDを持つ）。

## 4. 停止・費用・計量

- 各ケース前に停止条件を検査する: 外向き作用>0（安全違反）、外部通信の試み>0または総attempt>200（費用超過）、配布distまたは本体組立てファイルのdigest変化（版変更）。停止後の予定試行は`incomplete:<理由>`で全件記録する。
- 通信失敗の再試行は別attemptとして記録し、元の失敗を消さない。無効応答・不一致を再抽選しない。
- モデル・provider呼出しは0。fixture laneのtokensは**実測0**（provider呼出し0）。推論attemptの生usageは無いため`unknown`とし、製品portが0埋めした件数を別に数える。live量は未取得で`unknown`。費用は0（呼出しなし）。

## 5. 受入判定（P0-A01〜A08）

| ID | 判定に使う証拠 | pass条件 |
| --- | --- | --- |
| A01 | manifest、`checkPair`（replay／隣接lane用の宣言）と変異manifestの単体試験 | 必須識別情報が全てある。宣言済み介入差は許容し、固定項目差・未宣言差・必須欠落はhold |
| A02 | 同一再生のrecord比較、故意不一致7種、隣接lane | 同一再生で差分0・不一致0。7種とも想定した種類で検出（responseは要求一致のままrecord比較で検出） |
| A03 | 故障注入run、欠落・重複・未知IDの模擬（派生ファイル） | 全予定試行に終端記録。欠落・重複・未知を全件検出し、元の生記録を書き換えない |
| A04 | 集計のbuckets、mock recordの単体試験 | モデルwait・core拒否・本体受付拒否・抑止（mock）・host gateを別集計。参照拒否をwaitに数えない |
| A05 | 各runの外向き作用、fetch guard、受付fixture | 発話・通知・本番書込み・外部通信0。受付は`:memory:`のSQLiteと模擬担当のみ |
| A06 | 配布物の検査、run前後のdigest、git差分 | 配布物・製品指示・設定・ソースが不変。隣接srcとの差を記録 |
| A07 | attempt別usage、0埋め件数、manifestのmodel | 全attemptを数え、欠測を0にしない。モデル・接続名の固定値0 |
| A08 | 再集計の一致、秘密形状の走査と陽性対照 | 生記録から同じ集計を再生成。生成物・ログに秘密・設定本文・実会話なし |

全通過でも「計測基盤の採用可」の提案に留め、判断品質・P1の採用は主張しない。

## 6. P1用の暫定閾値（変更しない）

依頼書§5.2の表と性能手順（26ケース1バッチ、warmup 5、30対、nearest-rank p95、2run、増分max(10%, 5ms)）をそのまま固定する。P0では性能測定を行わない。26ケースのうちholdout16は未作成のため、性能バッチの構成はP1着手前に利用者と確認する。
