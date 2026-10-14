# Spatial 監視銀河移植の検証（2026-10-14）

## 実装した範囲

Eumenesの既存Spatial背景へ12種類の実粒子モデル（計29,952点）と採用済みのCPU変形・活動発光・段階的拡散を移植した。元のbinは保持し、CPUのSHA-256が原本と一致することを確認した。既存Three.js 0.186.1を使う。

- 不可視の原点を中心とする2本の公転帯。公転とモデルの活動・自転は別の変換。
- 全モデルの自転、CPU利用率連動、元の形40%／フォーカス60%、seedによる10%層の滑らかな拡散。
- 正常・圧迫・問題・接続断・未確認、活動・利用率・staleを独立した入力として表現。選択モデルは白。高利用率だけでは赤にしない。
- 表示の設定へ粒子・動き・状態プレビューの区分を追加。旧画面の見本は下書きを即時反映し、保存後に会話の背景へ反映する。
- 公転0–200%、自転0–100%、拡散・形状保持率・粒子サイズ・明るさ・視点・停止・reduced-motionを保存可能。
- 約0.85秒のカメラ遷移、上からのフォーカス、再選択・全体に戻るでズームアウト。カメラの左右配置と形状保持率も遷移させる。
- 単一context・静的点群buffer。hidden/reduced/pause、ResizeObserver、unmount、WebGL失敗と再表示、geometry/material/rendererの解放。

設定登録は `settings.spatial.bundle.json` の `artifact:settings.display@4`。並行作業で追加された `@5` は同じ21フィールドを引き継いでおり、既存の光の精霊アニメーションタブも保持されている。旧revisionは書き換えていない。settings保存・共有下書き・登録adapterは既存経路を再利用した。

## 検証結果

| 検査 | 結果 |
| --- | --- |
| 移植前の背景・切替ベースライン | 10試験通過 |
| background domain verify | size・format・lint・型・13試験通過 |
| settings domain verify | size・format・lint・型・backend27試験＋Web55試験通過 |
| capabilities domain verify | size・format・lint・型・63試験通過。ただし並行作業のsource変更検知でverify全体の確定は失敗（capabilities-verify.log） |
| 設定bundle dry-run | 新規不整合なし、登録済みの同一内容として成功 |
| 全体型検査 | 通過（typecheck.log） |
| 配布用Webビルド | 通過（build.log）。全12binを出力。大きいchunkの通常警告あり |
| 既存背景切替ブラウザー試験 | 1件通過 |
| Spatial専用ブラウザー試験 | 最終2件通過。隔離fixture・実Chromiumで実行 |

専用ブラウザー試験で確認した内容：12モデルの読み込み、デモと取得前表示、設定区分の切替、共有下書き保存、0%停止と5%公転、停止中のCanvas画像一致、再開後の画像変化、個別health変更、選択とズーム復帰、縦390×844と横1280×720、WebGL context lossでCanvas除去＋HTML12件、再表示、再読込み後の設定保持。Shader/WebGLのコンパイルエラーは検出されなかった。

モデル試験では全12モデルのpointCountとattribute数、CPU原本SHA、状態色の独立性、選択白、stale/reduced活動ゲート、非有限入力の防御、10,000回の有界phase更新を確認した。これは長時間実機性能の測定ではない。

## 画像

`browser/spatial-galaxy-12-models-s-7ec54-e-context-loss-and-recovery/` の下に以下を保存した。実ピクセルを目視確認済み。

- `spatial-all-models-preview.png`：全12モデルの見本
- `spatial-galaxy-wide.png`：会話の背景と個別health
- `spatial-focus.png`：白い選択モデルと上からのフォーカス
- `spatial-galaxy-portrait.png`：縦画面
- `spatial-settings.png`：公転0%などの設定

`browser/spatial-galaxy-registered--2e9be-fields-through-shared-draft/spatial-registered-settings.png` は登録済み表示設定の保存画面。

## 範囲と残事項

実測/API取得経路は未接続。初期値は全12件未確認であり、展示用モデルを導入済みProviderと扱わない。明示的に有効化した状態プレビューだけがデモ値を使用する。長時間の実機受入・性能保証は行っていない。

広い設定E2Eを実行した際には、並行変更中の光の精霊タブの旧selectorと、記録画面上のタイマー通知がクリックを遮るケースで失敗があった。Spatial専用2件は最終ソースで再実行して通過した。ほかの画面の失敗をSpatialの成功と混同しない。

通常の開発サーバーはbackendをwatch起動していない。稼働中の旧backendへ新しい保存schema・artifact登録を読み込むには、Eumenesの開発サーバーを再起動する。fixture以外の製品設定・DBは変更していない。Siteや別の作業の未コミット変更も変更対象にしていない。

context_compile 1回、compile_eval 1回。評価runId `00000000-0000-0000-18de-4fd62b39931d` に保存済み。
