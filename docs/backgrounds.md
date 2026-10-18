# 会話の背景とSpatialのモデル

設定の「表示」→「会話の背景」で光の妖精とSpatialを選び、変更を保存する。旧設定や未選択時は光の妖精を表示する。設定保存は既存APIと共通下書きを使う。

## 監視銀河14体の採用（2026-10-18）

採用済み監視銀河source `2faaae57be7e9d78f74a0b9e2a4cba5538a0c153` の14点群、33,460点を移植。Eumenes10体（CPU・Memory・SSD・Backend・外部連携・LLM・ASR・TTS・Embedding・態度判定）とLARM4体（Core・CPU・Memory・GPU）。旧Networkは二重漏斗のBackendへ置き換え、言語・画像・楽曲の形状を展示から外した。各サービス自体と監視APIは維持する。

モデル内の元座標・phase・group・seed・size・weightは固定し、光の位相だけを進める。モデル内の自転・変形・噴出は行わない。公転はSceneが別に持つ配置。速度は活動workingでも基準の1.15倍まで、波・呼吸・利用率による発光上乗せは合計10%以内。faultは通常の流れを止め、pressureは加速しない。未確認・接続断・stale・reduced-motionでは時間変化を止める。選択してもhealth色を保持する。

| 項目 | 初期値 | 範囲 |
| --- | --- | --- |
| 散らばり | 350% | 0〜500% |
| 原型を残す割合 | 全景40%、近接60% | 各10〜90%（既存調整契約を維持） |
| 粒子サイズ | 100% | 50〜200% |
| 背景の明るさ | 80% | 20〜100% |
| 公転速度 | 50% | 0〜200%、0で公転のみ停止 |

初期割合では、拡散する点をseedで約10%ずつ、全景6群・近接4群へ分ける。各群へ最大範囲の1/6〜6/6、1/4〜4/4を割り当てる。ズームでは両端の係数を補間する。カメラの画角は原型から決め、散らばり操作では倍率を変えない。外側の点は画面外へ広がってよい。任意のcore/focusCore設定も既存uniformへ渡す。

近接では原型を明るくし、拡散点も見える大きさと不透明度にする。Eumenesの画面出力へ色空間変換を適用し、静的な表示光量を1.5倍に調整した。これは活動の10%上限やhealth判定を変えるものではない。

設定画面は `settings.display@10`。旧revisionは不変。廃止したモデル内自転の保存項目は旧文書互換として受理するが、描画では使わず新版画面には表示しない。

## 実測との接続

`SpatialBackground.items` が唯一の観測入力。取得側の `web/src/domains/monitoring` が既存 `GET /api/monitoring/snapshot` をSpatial表示中だけ1分ごとに読み、実体IDと状態を渡す。Sceneやモデルはhealthを判断せず、観測値がないことと0を区別する。APIの旧shape=`network`だけはWeb取得境界で新モデル=`backend`へ対応付ける（既存APIの互換接続）。

CPU・Memory・SSD・Backendと既存5サービスの状態は既存APIを利用する。外部連携とLARM4体の計測APIは未実装なのでunknown/idle/unconfirmedのまま表示し、他サービスの状態を流用しない。言語・画像・楽曲の監視はAPIに残るが新しい形へ勝手に割り当てない。

取得失敗時はBackendをdisconnected、他をstaleへ。明示的な状態プレビューだけはデモ値を優先する。デモは実測として保存・表示しない。既存の監視判定の正本は[実測接続の設計](../spec/spatial-monitoring-eumenes-design-2026-10-18.md)。

## 描画と資源管理

既存の単一WebGL contextとRAFを使用し、30fps・DPR1.5を上限とする。点群のinterleaved bufferは不変。光の評価器は同じcolor配列を再利用し、状態・時間に応じて更新する。別Canvas、別RAF、追加texture、画面全体のblurやrender targetは追加しない。非表示タブ・停止・背景切替・unmountでは既存の停止/解放経路を使う。

WebGL初期化・context loss・描画失敗ではGPU資源を解放し、HTML状態一覧と再表示ボタンを出す。HTMLからの選択、Sceneの有限カメラ遷移、reduced-motion即時切替も維持する。会話画面に状態を見るボタンやモデルドロップダウンを追加しない。

出所と全資産hashは`models/MODEL-SOURCE.md`と`source-hashes.json`。採用設計・確認範囲は[置換計画](../spec/spatial-monitor-galaxy-adoption-2026-10-18.md)。長時間GPU測定とLARM4体の実機計測対応を、この描画移植の完了と混同しない。
