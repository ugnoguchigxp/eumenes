# 会話の背景とSpatialのモデル

設定の「表示」→「会話の背景」で、光の妖精とSpatialを選び、「変更を適用」で保存する。旧設定や未選択時は光の妖精を表示する。保存は既存の設定APIを使い、ブラウザの再読込み後も選択を維持する。

選択中の背景だけを描画する。切替・設定画面への移動では前の背景を破棄し、会話・音声の処理は継続する。SpatialのThree.jsは初回選択時に読み込み、非表示タブでは描画を停止する。動きを減らす設定では静止表示になる。

WebGLを通常許可して使用する。WebGLの初期化失敗、context loss、モデルの描画失敗は背景内で扱い、「再表示」から再試行する。状態一覧はHTMLで表示するため、WebGLが使えない場合でも対象を確認できる。

## 今回の実装範囲

背景の切替・保存、単一Canvasとcamera・照明・resize・資源解放、差し替え可能なモデル登録、状態更新とHTMLでの対象選択を実装した。移植元のSpatialの表示とモデル分離の方針を、既存のThree.js 0.186.1へ接続した。React Three FiberやDashboardの実行基盤は追加していない。

初期表示はCPU・Memory・SSD・Networkの仮モデルで、状態はすべて未確認である。このMacの実測とProviderのhealth接続は別の実装となる。仮の正常値や負荷は作っていない。最終的な形状はDotsで作成・採用したモデルに差し替える。

## Dotsのモデルを組み込む

対象ごとに `web/src/domains/background/models/` にモデルのfactoryを置き、`models/index.ts` の対応キーをそのfactoryへ差し替える。現在のキーは `cpu`、`memory`、`ssd`、`network`、`provider`。新しい用途は同じ登録へ追加できる。実体の名前やIDを描画側で判別しない。

factoryは引数なしで `SpatialModel` を返す。状態と位置を変える場合も、同じ実体IDとモデル種別ならモデルとWebGL contextを再作成しない。モデル種別の変更や対象の削除では前のモデルを破棄する。

```ts
import { Group } from "three";
import type { SpatialModel } from "../contracts";

export function createCpuModel(): SpatialModel {
  const object = new Group();
  // このGroupに形状を追加する。生成したgeometry/material/textureを所有する。
  return {
    object,
    update(state, selected) {
      // 渡されたhealth・activity・stale・選択状態を形状へ反映する。
    },
    dispose() {
      // 所有するGPU資源を解放する。複数回呼ばれても安全にする。
    },
  };
}
```

- ローカル原点を中心に、おおむね幅1の範囲に収める。配置・camera・Canvasは基盤が所有する。
- `update` は外部から渡される状態を表現する。healthは `healthy` / `pressure` / `fault` / `disconnected` / `unknown`、activityは `idle` / `starting` / `working`、staleは観測情報の古さである。モデルで正常・異常を判定しない。
- 任意の `animate(seconds, deltaSeconds)` を実装できる。現在処理中の対象だけに最大24fpsで呼ばれ、非表示・reduced motion・stale・未確認・接続断では連続描画しない。静止した形でも対象を識別できるようにする。
- API取得、認証、独自のCanvas、独自の描画ループ、DOMイベントの登録をモデル内に持たせない。
- `dispose` は作成したgeometry・material・textureを解放する。factory途中で失敗した場合も、factory自身が途中までの資源を解放する。

モデルの型は `web/src/domains/background/contracts.ts`。Sceneの入力 `SpatialItem` は実体ID・表示名・モデルキー・位置・状態を持つ。同じProvider用モデルを複数の実体へ配置できる。

## 検証

部分試験は `bun run test:domain -- background` と `bun run test:domain -- settings`。切替の結合試験は `bun x vitest run web/src/components/ConversationBackground.test.tsx`、ブラウザのWebGL・保存・往復切替は `bun x playwright test tests/browser/backgrounds.spec.ts`。

変更domainと利用側のverifyを通し、横断検証は `bun run verify:all` で行う。実測・Provider接続や実マイク・スピーカーの受入は、これらのfixture試験とは分ける。

参照：[移植元のSpatial全体コンセプト](https://github.com/ugnoguchigxp/hono-standard/blob/9534a74cf14dd323890a69063f113293dfefbacf/docs/dashboard-overlay/11-spatial-observability-concept.md)、[採用構想Page](https://chatgpt.com/space/page_0c01338cc47481919b83c6b400117239)。
