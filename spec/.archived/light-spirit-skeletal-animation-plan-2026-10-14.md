# 光の精霊 ボーン導入とアニメーション拡充 計画

作成日: 2026-10-14。状態: **実装済み・fixture検証済み**（実機GPUでの目視確認は未実施）。実施結果と計画からの変更は [§12](#12-実施結果2026-10-14)。

対象: 会話画面の背景に出す光の精霊（`web/src/components/domains/conversation/light-avatar/`）と、設定の「表示」画面（`settings.display` artifact）。

## 1. 目的

- 精霊に骨格（ボーン）を入れ、頭・胴・頭頂の炎・裾・腕4本を関節単位で動かせるようにする。
- 動作を層に分けて重ね、二次運動・視線・動作の変化版・光の演出を加え、繰り返しに見えない動きにする。
- 設定の「表示」画面にタブを足し、全動作を一通り再生して確かめられる「アニメーション」タブを用意する。
- 動きはできるだけ派手にする（§5.2）。感情によっては体ごと横方向（鉛直軸まわり）に1回転してよい。

## 2. 現状（2026-10-14 時点の実装）

| 項目 | 現状 |
| --- | --- |
| 形状 | `model.js` が Three.js 0.186.1 で手続き生成する。殻メッシュ（`shellGeometry`）、腕のリボン×4（外L/R・内L/R）、粒子（`Points`）、金線（`Line`）、光の核、目 |
| 頭の変形 | シェーダ uniform `uHead`（回転行列1つ）。殻の y=0.57〜1.18 を smoothstep で頭へ寄せる（`commonDeform`） |
| 腕の変形 | `bendArm`（`uArmSwing`・`uArmReach`）。曲線上の位置 u を重みにした根元からの1回の曲げ。途中に関節がない |
| 胴 | `root` Group の回転・移動 |
| 目 | 頭の回転を CPU で手計算して位置を合わせる |
| 姿勢 | `Pose`（16値: hx/hy/hz, bx/by/bz, lift, forward, left/right, leftInner/rightInner, gx/gy, energy, open） |
| 動作 | `motion.js` の8秒固定キーフレーム（13種）、`idle.ts`（呼吸・揺れ・瞬き・約30秒ごとの体振り）、`performance.ts`（発話の上乗せ） |
| 制約 | 待機12fps・身振り24fpsが上限。`prefers-reduced-motion` では静止姿勢。タブ非表示・unmount で GPU 資源を解放 |

単調に見える原因は次の4点。

1. 動かせる箇所が少なく、腕が棒の回転に見える。
2. 遅れて揺れる動き（頭頂の炎、裾、腕の先）がない。
3. 同じ8秒が毎回そのまま再生される。
4. 光の演出が `energy` 1値しかない。

## 3. 方針

- 形状はこれまでどおりコードで手続き生成する。glTF への作り直しはしない。
- ボーンは `THREE.Bone` / `THREE.Skeleton` をコードで組み、重みも手続きで計算する。
- 置き換えた `uHead`・`bendArm`・目の手計算・`Pose` の16値はすべて削除する。互換のための層は残さない。
- 動作は JSON のキーフレームデータで定義する。将来 Blender で作る場合に備え、ボーン名を固定し「ボーンとアニメーションだけの glTF」から読み込める形にしておく。読み込み処理そのものは今回の範囲に含めない。
- 精霊の描画一式は `packages/design-system` へ移す。会話背景（web）と設定の試験タブ（artifact-ui）が同じ部品を使えるようにし、Storybook でも確認できるようにするため。

## 4. ボーン構成

ボーン名は固定し、動作データと将来の glTF との共通の名前にする。全部で25本。

```
root
└ hips
  ├ tail_01 ─ tail_02 ─ tail_03          下の炎（裾）
  └ spine ─ chest
            ├ core                        光の核
            ├ neck ─ head
            │        ├ crown_01 ─ crown_02 ─ crown_03   頭頂の巻き
            │        └ eyes               目（子として付けて手計算をやめる）
            └ arm_{outer,inner}_{l,r}_01 ─ _02 ─ _03 ─ _tip   腕×4
```

| 部品 | 重みの決め方 |
| --- | --- |
| 殻 | 高さ y に沿って、近い2本のボーン（tail_03〜head/crown）へ smoothstep で振り分ける。現在の headSpan（0.57〜1.18）は neck/head の境目として引き継ぐ |
| 腕のリボン・金線・腕の粒子 | 曲線上の位置 u（`uv.y` / `aU`）を各腕の4本へ区分線形で振り分ける |
| 体と頭の粒子・光の幕 | 生成元の殻の位置（u, φ）から、殻と同じ重みを付ける |
| 光の核・目・腕先の光 | ボーンの子 Object3D として付ける（重みは不要） |

**技術的な難所**: Three.js 標準の `Points` と `Line` はスキニングに対応していない。粒子と金線は自作の `ShaderMaterial` なので、`skeleton.boneTexture` と `bindMatrix` を共通の uniform として渡し、`skinIndex`・`skinWeight` 属性から自前で変形する GLSL 部品を一つ作り、全素材で共有する。P1 で成り立つかを最初に確かめる。

## 5. アニメーションの層

`AnimationMixer` で層を重ね、その後で手続き計算の層を加える。

| 順 | 層 | 内容 | 合成方法 |
| --- | --- | --- | --- |
| 1 | 待機 | 呼吸・浮遊・瞬き・時折の体振り（`idle.ts` を移す） | 常時。基礎 |
| 2 | 状態・感情 | listening / thinking / 感情5種など。1つの動作に2〜3の変化版を持たせ、再生ごとに選ぶ。速度は ±10% の範囲で揺らす | 重み付きで重ねる。切替は0.7秒のクロスフェード（現行と同じ時間） |
| 3 | 発話 | 頷き・手振り（`performance.ts` を移す）。うなだれる・照れる・眠そうでは小さめにする規則も引き継ぐ | 加算 |
| 4 | 待機中の小さな仕草 | 見回す・くるっと回る・伸びる・光をこぼす。待機が続いたときだけ15〜40秒間隔で、同じ仕草が続かないように選ぶ | 加算。他の層が動くと0.7秒で抑える |
| 5 | 視線 | 頭と目がゆっくり向きを変える。目標はカメラ（利用者）を既定にする | 手続き。頭の回転を上限付きで足す |
| 6 | 二次運動 | crown・tail・腕の先をばねで遅らせる | 手続き。固定時間刻みで計算し、fps 上限が変わっても見た目が同じになるようにする |
| 7 | 光 | 核の脈動、粒子の渦の速さ、腕先の光の尾、きらめき | クリップの数値トラック（`light.*`）を uniform に渡す |

- 表示全体の時計と動作の時計を分ける現行の仕組みは維持する。動作を切り替えても呼吸や光の時計は巻き戻さない。
- `prefers-reduced-motion` では層1の静止姿勢だけを表示し、層4〜7は止める（現行どおり）。
- 発話音声の振幅との同期は、層3の入力として口ではなく核の光と腕の振りに使える形で枠だけ用意する。実際の振幅入力は範囲外とし、§11 に記録する。

### 5.1 動作データの形式

`light-avatar/motions/*.json` に1動作1ファイルで置く。

```json
{
  "id": "joyful",
  "label": "うれしい",
  "group": "emotion",
  "duration": 8,
  "loop": true,
  "variants": [
    {
      "id": "joyful-a",
      "tracks": {
        "head": [[0, [0, 0, 0]], [1.2, [-0.12, 0.05, 0.08]], [8, [0, 0, 0]]],
        "arm_outer_l_02": [[0, [0, 0, 0]], [1.4, [0, 0, 0.6]], [8, [0, 0, 0]]],
        "light.sparkle": [[0, 0], [1.3, 1], [3, 0]]
      }
    }
  ]
}
```

- 回転はオイラー角（ラジアン）で書き、読み込み時に quaternion のトラックへ変換する。
- 体の1回転は quaternion では表せない（最短経路で補間されて逆回りや無回転になる）。そこで、回転角を累積の数値で持つ専用トラック `spin`（鉛直軸、ラジアン）を設け、`root` の y 回転に足す。2π は1回転を表し、終了時は 2π の倍数に戻ること。
- 読み込み時に検査する。ボーン名と `light.*` の名前は登録一覧にあるものだけ受け付ける。時刻は昇順で `0..duration` に収まること。ボーンの回転は各軸 ±π 以内であること（`spin` は対象外。1動作で ±2π×2 以内とする）。
- `group` は `state`（聞く・考える・話す）、`emotion`（感情）、`speech`（発話の上乗せ）、`idle-gesture`（待機中の仕草）のいずれか。
- 現行13種は P2 で新しいボーン構成へ移し、元のキーフレームは削除する。

### 5.2 派手さの方針

- 現行の「通常の身振りは元の半分に抑える」減衰はやめる。振幅を元の値まで戻したうえで、P4 で動作ごとに大きくする。
- 予備動作（ため）→ 本動作 → 行き過ぎ → 戻り、の4拍を基本にして、緩急をはっきり付ける。行き過ぎの揺れは二次運動の層で増幅する。
- 体全体の跳ね・浮き上がり・前後の傾きを使う。腕は4本を別々の時間差で動かし、大きく広げる・丸める・振り上げる形を使う。
- 光の層を動作に連動させる。見せ場で核を強く光らせ、粒子を広げ、腕先に光の尾を引く。

感情と状態ごとの見せ場（変化版のうち少なくとも1つに入れる）:

| 動作 | 見せ場 |
| --- | --- |
| joyful（うれしい） | 跳ね上がって横に1回転し、着地で光を弾けさせる |
| surprised（驚く） | 後ろへ大きくのけぞり、腕4本を一気に開いて、核を瞬間的に強く光らせる |
| greeting（挨拶） | 半回転して振り向く、または1回転してから腕を大きく振る |
| agreeing（親しみ） | 体ごと深く頷き、腕を胸の前で交差させる |
| curious（興味） | 体を大きく傾けて覗き込み、頭頂の炎を跳ねさせる |
| listening（寄り添う・聞く） | 前に寄って身を乗り出し、内側の腕で包む形を作る |
| thinking（考える） | 粒子を周りで渦巻かせ、ゆっくり半回転して戻る |
| shy（照れる） | 横を向いて縮こまり、腕で顔を隠す |
| sleepy・downcast | 大きく沈み込み、裾と腕を垂らす。光を弱める |

- 回転と跳ねは見せ場ごとに1回に限る。8秒のうち残りは大きめの身振りで続け、回転を何度も繰り返さない。
- 発話の上乗せ（層3）を重ねている間は `spin` の振幅を半分にする。字幕と話している印象を崩さないため。試験タブでは「発話を重ねる」を入れて確かめる。
- 画面からはみ出さないようにする。跳ね・傾き・腕の広がりの最大値で精霊が canvas に収まることを、試験タブの全動作再生で確かめる。収まらなければカメラの余白を広げる。
- 後ろを向いている間は現行どおり目を隠す（`uFrontFacing`）。1回転の途中で目が透けて見えないことを確かめる。
- `prefers-reduced-motion` では回転・跳ねを含むすべての動作を止める（§5 のとおり）。

## 6. 設定「表示」のアニメーション試験タブ

### 6.1 画面構成

`settings.display` artifact の定義を revision 4 にし、`direction: "tabs"` に変える。

| タブ | 内容 |
| --- | --- |
| 表示 | 現行の設定項目（テーマ・背景・字幕）と字幕の見本。現行の横並び（form-preview）を保つ |
| アニメーション | 新しい view `avatar-motion-lab` |

現行の schema では `form-preview` が2子に限られ、タブ内でも使えない。そこでタブ定義に任意の `arrangement: "form-preview"` を足し、そのタブの子が `settings-section` と `subtitle-preview` の2つのときだけ横並びで描画する。`contracts.ts` の検査規則もこれに合わせて書き換える。`draftSource: "settings-display"` を指定し、下書きバーは現行どおり表示する。

### 6.2 `avatar-motion-lab` view

- 新しい OpenUI view として `packages/artifact-ui` の `contracts.ts` と `library.tsx` に登録する。schema は `{ view: "avatar-motion-lab", title? }`。
- 動作の一覧は design-system の部品に同梱した動作データから作る。backend の source も操作も持たない。再生は画面内の状態だけで完結し、設定文書には書かない。
- 描画部品 `LightSpiritLab` を `packages/design-system/src/components/LightSpirit/` に置く。

| 要素 | 内容 |
| --- | --- |
| 試写面 | 精霊の canvas。会話背景と同じ部品を使う |
| 動作一覧 | `group` ごとに見出しを付けたボタン一覧。押すとその動作を再生する。変化版がある動作は「変化版」を選べる（既定は自動選択） |
| 再生の操作 | 再生/停止、最初から、繰り返しの有無、速度（0.5×・1×・1.5×）、待機に戻す |
| 層の切替 | 発話を重ねる、二次運動、視線、待機中の小さな仕草を個別に入切する（試験用の一時的な状態で、保存はしない） |
| 表示補助 | ボーンの表示（`SkeletonHelper`）の入切。現在の動作名・変化版・経過時間・fps の表示 |
| 動きを減らす設定 | `prefers-reduced-motion` のときは自動再生せず、「動きを減らす設定のため静止しています。再生を押すと再生します」と表示する |

- 会話背景の精霊と同時に動かさない。試験タブが表示されている間は試写面だけを描画し、タブを離れたら GPU 資源を解放する。設定画面を開いている間は会話背景がすでに解放される（現行）ことを前提にする。
- WebGL 非対応・描画失敗時は試写面に失敗の表示を出し、一覧と操作は無効にする。

### 6.3 bundle 以外の変更

- 背景の選択（`appearance.background`）が `spatial` でも試験タブは使える。精霊の試験は背景設定と独立させる。
- launcher の説明を「背景 テーマ 字幕 アニメーション」に変える。

## 7. ファイル配置と所有

| 変更 | 場所 |
| --- | --- |
| 精霊の描画一式の移動 | `web/.../light-avatar/` → `packages/design-system/src/components/LightSpirit/`（model・skeleton・skinning GLSL・mixer の層・二次運動・視線・motions/*.json・THREE-LICENSE・README） |
| 会話背景 | `web/src/components/domains/conversation/LightAvatarBackground.tsx` は import 先の変更だけ。`AvatarMotion` の型は design-system から import する |
| 試験 view | `packages/artifact-ui/src/avatar-components.tsx`（新規）、`contracts.ts`、`library.tsx`、`styles.css` |
| タブの横並び | `packages/artifact-ui/src/contracts.ts`（`tabs[].arrangement`）、`library.tsx`（`CompositionView`） |
| bundle | `api/domains/capabilities/bundles/settings.bundle.json`（`settings.display` revision 4） |
| 依存 | `three` を design-system の dependencies に移す（root `package.json` の宣言を整理） |
| 文書 | 精霊の README を移して改訂。`docs/toolchain-extension.md` の §10 E に view を追記 |

注意: `settings.bundle.json`・`contracts.ts`・`library.tsx` は 2026-10-14 時点で未コミットの変更がある。着手前にその変更の扱いを確認し、上書きしない。

## 8. 段階

| 段階 | 内容 | 完了の条件 |
| --- | --- | --- |
| P0 移動 | 精霊を design-system へ移し、web は import 先だけ変える。挙動は変えない | 既存の試験（idle・performance・LightAvatarBackground）が通り、会話背景の見た目が移動前と同じ |
| P1 骨格の試作 | 骨格を組み、殻と腕1本に重みを付ける。粒子と線のスキニング GLSL を確かめる | 現行の13動作を新しいボーン回転に置き換えて、移動前とスクリーンショットで比べて差が小さい。粒子と線が殻・腕に追従する |
| P2 全面適用 | 全部品に重みを付け、`uHead`・`bendArm`・目の手計算・`Pose` を削除する。13動作を JSON へ移す | 古い変形処理の参照が残らない。描画コスト（draw call・三角形数・1フレームの時間）を移動前と比べて記録する |
| P3 層 | Mixer の層、二次運動、視線、光のトラック | 層ごとの単体試験。切替・取消・句終了での0.7秒の復帰が現行どおり |
| P4 動作を増やす | 変化版、待機中の小さな仕草、光の演出、§5.2 の見せ場。感情5種と状態3種にそれぞれ2つ以上の変化版を持たせる | 動作データの検査に通る。同じ動作を3回続けて再生しても同一にならない。§5.2 の表の見せ場がすべて入っている。全動作で精霊が canvas に収まり、回転中に目が透けない |
| P5 試験タブ | `avatar-motion-lab` view、タブの横並び、bundle revision 4、Storybook の stories | §9 の UI 確認が通る |

P0→P1 の結果を見て、P1 の難所（粒子と線のスキニング）が成り立たない場合は、粒子だけ CPU 側でボーン行列を当てる方式に切り替えるかを判断する。そのときは描画コストを測ってから決める。

## 9. 検証

結果は fixture・live・実機器で分けて記録する。

- 単体: 動作データの検査（ボーン名・時刻・範囲）、変化版の選択、層の合成、二次運動の固定時間刻み、reduced-motion。
- design-system: `LightSpirit` と `LightSpiritLab` の stories と描画試験。
- artifact-ui: `avatar-motion-lab` の schema、タブの `arrangement` の検査規則（不正な組合せを拒否する）。
- bundle: `settings.display` revision 4 の検査。
- 検証コマンド: `bun run verify -- --domain <name>` を、変更した domain と利用側の domain（settings・artifact・conversation に相当するもの）について実行する。
- ブラウザ E2E: `tests/browser/settings-data-driven.spec.ts` に「表示」のタブ切替と試験タブの再生を加え、そのファイルを指定して個別に実行する。会話背景の精霊については既存のブラウザ試験を指定して実行する。
- 目視: 全動作を試験タブで再生し、スクリーンショットを作業記録に残す。

## 10. 完了の定義

- §8 の P0〜P5 の完了条件がすべて満たされ、§9 の検証結果が記録されている。
- 会話背景の精霊が、待機・聞く・考える・発話・感情の各場面で新しい骨格で動き、fps の上限・資源の解放・reduced-motion の扱いが現行どおり保たれている。
- 精霊の README が新しい構成に改訂されている。

## 11. 範囲外

- Blender などで作った glTF アニメーションの読み込み（ボーン名の固定だけ行う）。
- 音声の振幅入力そのものと、音声の pause/resume への追従（現行も未実装）。
- 新しい感情の種類の追加（会話側の判定の変更を伴うため）。
- 試験タブでの動作の編集・保存（姿勢エディタ）。

## 12. 実施結果（2026-10-14）

### 計画からの変更

| 計画 | 実装 | 理由 |
| --- | --- | --- |
| 描画一式を `packages/design-system` へ移す（§3・§7） | 描画器は `web/.../light-avatar/` に残し、design-system には試写画面の部品 `LightSpiritLab`（操作と表示だけ）を置いた。artifact-ui の `avatar-motion-lab` は host が `ArtifactRuntime.hostViews` で渡す画面を置くだけ | three.js を design-system の dist に同梱せず、web の dynamic import（初回表示に含めない）を保つため |
| ボーン25本（§4） | 29本（`core` と腕先 `tip` を独立ボーンにした） | 光の核と腕先の光をボーンの子として付け、揺れの追従の終端にも使うため |
| `AnimationMixer` で層を重ねる（§5） | 自前の sampler（Catmull-Rom 接線の3次Hermite）と加算合成 | 鏡映、累積角の `spin`、発話中の振り向きへの変換、静止姿勢の検査を一つの形式で扱うため |
| 速度を ±10% 揺らす（§5） | 0〜15% 速める側だけ | 遅くすると、8秒で待機へ戻るときにクリップが静止姿勢の前で切れるため |
| 動作データに `loop` 項目 | 持たない | 繰り返しは発話中の再生と試写の「繰り返す」で決まるため |
| 発話中は `spin` の振幅を半分（§5.2） | 発話中は1回転を `0.35·sin(spin/2)` の振り向きに変える | 振幅を半分にすると半回転で止まり、後ろを向いたままになるため |
| `settings.display` revision 4（§6.1） | revision 5（`settings.spatial.bundle.json` に追加） | 作業中に別作業が revision 4（Spatial の項目）を登録済みだったため。revision 4 は登録内容のまま残した |
| `direction: "form-preview"` を tabs の `arrangement` へ移す | `tabs[].arrangement: "form-preview"` を追加し、`direction: "form-preview"` も残した | revision 4 が `direction: "form-preview"` を使っているため |
| 腕先の光の尾 | 腕先の直近8点を1つの Points で描き、腕先が動いたときだけ見える | 描画呼び出しを1回に抑えるため |
| 試写タブに専用の試写面（canvas）を置き、その間は会話背景を止める（§6.2） | 試写面は持たず、タブの操作で会話背景の精霊そのものを動かす。背景はモデルを `load.ts` に登録し、タブ表示中は cue 再生を止めて `data-avatar-state="motion-lab"` になる | 利用者の確認で、背景の精霊と連動していないと別物に見えるため（2026-10-14 変更） |

カメラは跳ね・回転の余白のため 7.7→8.5（縦長 8.6→9.5）へ引いた。

### 検証結果

- fixture（単体）: `light-avatar`（動作データ検査・鏡映・瞬き・変化版の非連続・クロスフェード・発話中の振り向き・発話の繰り返し境界・待機中の仕草）、`LightAvatarBackground`（試写中の一時停止を含む）、`LightAvatarMotionLab`（画面外では描画器を作らない・再生・変化版・層・解放・WebGL2非対応）、design-system `LightSpiritLab`、artifact-ui の tabs `arrangement` 検査と host view。
- `bun run verify -- --domain` conversation・avatar・capabilities・settings は通過。artifact は既存の `service-test-components.tsx` の関数行数予算（別作業の変更）で size-budget が止まるため、`bun run test:domain -- artifact` を個別に実行して通過。
- ブラウザE2E（fixture）: `tests/browser/settings-data-driven.spec.ts`（10件、アニメーションタブの再生・変化版・切替で canvas 解放・設定に書き込まないことを含む）と `tests/browser/backgrounds.spec.ts` が通過。
- 目視: Playwright（SwiftShader）で状態・感情・発話・待機中の仕草の各変化版を静止画で確認し、跳ね・回転・腕の開きで精霊が canvas に収まることを確認した。実機GPUでの動きとfpsは未確認。
