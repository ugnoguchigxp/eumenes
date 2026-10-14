# 会話の背景とSpatialのモデル

設定の「表示」→「会話の背景」で光の妖精とSpatialを選び、変更を保存する。旧設定や未選択時は光の妖精を表示する。保存は既存の設定APIを使い、再読込み後も選択と調整値を維持する。

## 監視銀河の移植（2026-10-14）

監視銀河の採用版からCPU・Memory・SSD・Network・LLM・ASR・TTS・Embedding・態度判定・言語判定・画像生成・楽曲生成の12種類を移植した。元の点群29,952点を変更せず、Eumenes既存のThree.js 0.186.1で描画する。CPUの元座標を保持し、元のCPU変形式を適用してから正規化する。モデル内の活動・自転と、Sceneが持つ公転の変換を分離している。中心には物体や文字を置かない。

これらは展示用の形状サンプルであり、実測したこのMacの機器一覧や導入済みProviderの一覧ではない。データ取得経路は未接続で、通常は全モデルを未確認・待機として表示する。会話・音声・API接続・認証は背景に持たせていない。

設定の表示画面に粒子・動き・状態プレビューの区分を追加した。旧画面でも同じ保存項目を編集でき、Spatialの見本は下書きを即時表示する。会話背景への反映は保存後になる。

| 項目 | 初期値 | 調整範囲 |
| --- | --- | --- |
| 粒子の拡散 | 100%（監視銀河の基準） | 0–200% |
| 元の形を残す割合 | 全体40%、フォーカス60% | 各10–90% |
| 粒子サイズ | 100% | 50–200% |
| 明るさ | 80% | 20–100% |
| 公転速度 | 50% | 0–200%、1%刻み |
| 自転速度 | 25% | 0–100%、1%刻み |

拡散は各粒子の元座標から行い、seedを10%ずつの層へ分けて滑らかに広げる。別のランダムな雲は生成しない。全モデルが自転し、CPUは利用率にも連動する。公転0%は公転だけを止める。「動きを停止」や「動きを減らす」、端末のreduced-motion設定では動きを停止する。

状態一覧の選択で、上から見下ろすフォーカスへ約0.85秒のカメラ遷移を行う。選択モデルは白い粒子になり、他のモデルは薄くなる。再クリック・全体に戻るで全体表示へ戻り、選択を解除する。healthは一覧にも残る。

## 状態の契約と将来の取得経路

`SpatialBackground` の `items` が取得側から受け取る唯一の観測入力。Sceneやモデルはhealthを判定しない。将来は取得側が公開APIの結果をこの型へ変換し、同じ実体IDで渡す。モデルとWebGL contextは状態変更だけでは再作成しない。形状サンプルのIDを実際のProviderのIDと混同しない。

```ts
// 型は web/src/domains/background の公開entryからimportする。
const item: SpatialItem = {
  id: "owner-supplied-instance-id",
  label: "取得側が決める表示名",
  model: "llm",
  position: [8, 0, 0],
  orbit: { radius: 8, phase: 0, speed: 0.75 },
  state: {
    health: "unknown",
    activity: "idle",
    stale: false,
    source: "unconfirmed",
    // utilization / strength / observedAt は取得できた場合だけ渡す。
  },
};
```

- health: healthy＝青白、pressure＝橙、fault＝赤、disconnected/unknown＝暗い灰紫。未確認・接続断・staleでは光量も抑える。高利用率だけで赤くしない。
- activity: idle / starting / working。活動量strengthと利用率utilizationは別の0–1の値。未取得は省略し、0と区別する。
- stale: 観測情報の古さ。取得側が判定する。古い情報や未確認・接続断では活動の発光を停止する。
- source: unconfirmed / demo / measurement。取得側が観測の出所を明示できる。
- 状態プレビューは明示的に有効化した場合だけデモ値を表示する。設定タブで共通health・活動・活動量・利用率・staleを調整し、選択したモデルではhealth・活動・利用率を個別に上書きできる。デモ値は実測値として保存・利用しない。

## 描画と資源管理

選択中の背景だけを描画し、設定画面への移動・切替・unmountでSceneを解放する。非表示タブではRAFを停止し、復帰時に経過時間を持ち越さない。表示サイズに合わせてカメラとCanvasを更新し、縦画面でも拡散領域を画角へ収める。

一つのWebGL context、静的なinterleaved点群buffer、ShaderMaterialのuniformを使用する。毎フレームの点群配列再生成やポストプロセス用RenderTargetは追加していない。描画要求は30fpsを上限としDPRは1.5まで。これは性能保証ではなく描画の制限である。

WebGL初期化失敗・context loss・描画失敗ではRAFとGPU資源を解放し、HTMLの状態一覧と再表示ボタンを出す。再表示時は新しいcontextを作る。停止中でも有限のカメラ遷移だけは可能で、reduced-motionでは即時切り替える。

点群資産は `models/assets/` に置く（`data/` はリポジトリの除外対象）。資産の取得・検査は `models/index.ts`、モデルのGPU表現は `models/particles.ts`、活動・拡散の式は `models/shaders.ts`。新しいモデルは同じregistryへ登録し、独自Canvasや独自RAFを持たせない。

## 検証

- `bun run verify -- --domain background`
- `bun run verify -- --domain settings`
- `bun run toolchain:bundle -- check api/domains/capabilities/bundles/settings.spatial.bundle.json`
- `bun x playwright test tests/browser/backgrounds.spec.ts tests/browser/spatial-galaxy.spec.ts`
- `bun check --noEmit` と `bun run build:web`

記録とスクリーンショットは `spec/verification/spatial-galaxy-2026-10-14/`。実測・Provider接続・長時間実機受入は未実施。
