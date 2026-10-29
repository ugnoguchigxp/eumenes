# 背景と遊ぶモード（チャットを隠す・Spatial の詳細・精霊の触れ合い）

2026-10-29。利用者の明示依頼に基づく設計。状態: **合意済み（2026-10-29）・実装済み・fixture検証済み**（実画面の確認は未実施）。

- 依頼1: 背景の Spatial と光の妖精を触って遊べるモードを足す。
- 依頼2: 右上にチャット欄を隠す／出すボタンを置く。
- 依頼3: Spatial はオブジェクトをクリックすると詳細が見られる。
- 依頼4: 光の妖精はクリックすると「触られた」反応のアニメーションをする。

変える現行の設計: [larm-spatial-monitoring-integration-design-2026-10-18.md](larm-spatial-monitoring-integration-design-2026-10-18.md) §6.3「通常の会話背景に新しい常駐ボタンやドロップダウンは追加しない」。本書の切替ボタン1つだけを例外にする（Spatial 専用の常駐ボタンやドロップダウンは引き続き足さない）。

## 1. 変更の要点

| 項目 | 現行 | 変更後 |
| --- | --- | --- |
| 右上のボタン | 通知（右16px）・アーティファクト（右60px） | 左に「チャットを隠す」（右104px）を足して3つ |
| チャット欄 | 常に表示 | ボタンで隠せる。隠した状態を「背景モード」と呼ぶ |
| 背景への操作 | 受け付けない（`pointer-events: none`） | 背景モードの間だけ受け付ける |
| Spatial の選択 | WebGL 失敗時の状態一覧からだけ | 背景モードでオブジェクトをクリック。右側に詳細を出し、カメラが寄る（既存の `select` の動き） |
| Spatial の詳細の中身 | 状態一覧の中にだけある | 部品 `SpatialDetail` に切り出し、状態一覧とクリックの詳細で共用 |
| 光の妖精 | 会話の cue だけで動く | 背景モードで体をクリックすると反応の動作 `touched` を再生 |
| 動作の種類 | `state`・`emotion`・`speech`・`idle-gesture` | 群 `reaction`（触れたときの反応）を足す。API の `AvatarMotion` には足さない（Web 専用） |

## 2. 変えないもの

- 音声の会話は背景モードでも止めない・切り替えない。字幕・タイマーと通知のバナー・アーティファクトの画面はそのまま出す。
- チャット欄の中身（入力中の文・添付・履歴のスクロール位置・マイクの状態）は隠している間も保つ。隠すのは CSS だけで、部品を外さない。
- Spatial の取得・health の判断・描画方式・カメラの動き。光の妖精の待機・会話の cue・発話の重ね・試写タブ。
- 設定（SQLite）には何も保存しない。背景モードは再読み込みでチャット表示に戻る。

## 3. 切替ボタン

### 3.1 置き場所と見た目

```
┌──────────────────────────────────────────────────────────────────────┐
│ [宛先 … | 会話 ▾ | 音声 ▾ | 背景: 光の妖精 ▾ | ● LARM]   (隠す)(▦)(通知) │
│                                                                      │
```

`(隠す)` が新しいボタン、`(▦)` は既存のアーティファクト、`(通知)` は既存の通知センター。

| 項目 | 値 |
| --- | --- |
| 部品 | `web/src/workspace/ChatVisibilityToggle.tsx`（新規） |
| class | `chat-visibility-trigger`（`position: fixed`、`top: calc(12px + safe-area-top)`、`right: calc(104px + safe-area-right)`、36px の丸、`z-index: 11`。見た目は `artifact-launcher-trigger` と同じ） |
| 表示中のアイコン | 吹き出しに斜線（押すと隠す） |
| 背景モードのアイコン | 吹き出し（押すと出す） |
| `aria-label`・`title` | 表示中「チャットを隠す」／背景モード「チャットを表示」 |
| `aria-pressed` | 背景モードで `true` |
| 出さないとき | アーティファクトが全画面のとき（設定のサービス試験。チャット欄自体が無い） |
| 隠れた警告の印 | 背景モードでチャット欄の中に `role="alert"`（接続できない等）があるとき、ボタンの右上に赤い点。CSS の `:has()` だけで付け、状態を引き回さない |

`.conversation-status` の `max-width` の右の空きを 92px から 136px にする（ボタン3つ分）。

### 3.2 状態の持ち主

```tsx
// Workspace.tsx
const [chatHidden, setChatHidden] = useState(false);
...
{!fullscreen && (
  <ChatVisibilityToggle hidden={chatHidden} onToggle={() => setChatHidden((v) => !v)} />
)}
<ConversationPanel client={client} store={store} state={state} chatHidden={chatHidden} />
```

```tsx
// ConversationPanel.tsx
<section className="chat-panel" data-chat-hidden={chatHidden || undefined} aria-label="会話">
  <ConversationBackground ... interactive={chatHidden} />
```

### 3.3 背景モードで隠すもの・残すもの

| 要素 | 背景モード |
| --- | --- |
| `.conversation-status`（宛先・モデル・背景の選択・LARM） | 隠す |
| `.conversation-notice`・`.chat-error`・接続の再確認ボタン | 隠す（警告はボタンの赤い点で知らせる） |
| `.chat-history`・`.latest-button` | 隠す |
| `.chat-bottom`（経路・入力欄・マイク・送信） | 隠す |
| 字幕（`.chat-panel > .subtitle`） | 残す |
| 背景（光の妖精／Spatial） | 残し、操作を受け付ける |
| Spatial の失敗時の状態一覧 | 残す（WebGL が無い時の唯一の表示） |
| 右上の3つのボタン・タイマーと通知のバナー | 残す（チャット欄の外） |
| アーティファクトの画面（左右分割） | 残す。隠すのはチャット側だけ |

隠し方は `visibility: hidden`。`display: none` は履歴のスクロール位置を失うため使わない。`visibility: hidden` の要素はクリックもフォーカスも受けないので、その下の背景にクリックが届く。

```css
.chat-panel[data-chat-hidden] :is(.conversation-status, .conversation-notice, .chat-error,
  .chat-history, .latest-button, .chat-bottom) { visibility: hidden; }
.chat-panel[data-chat-hidden] :is(.light-avatar-background, .spatial-background) { pointer-events: auto; }
```

キーボード: ボタンは Tab で届く。背景モード専用の全体ショートカットは足さない。Esc は Spatial の詳細を閉じるのに使う（§4.4）。

## 4. Spatial: クリックで詳細

### 4.1 当たり判定（`controller/scene.ts` に `pick` を足す）

粒子とシェーダーの変形があるため three.js の Raycaster は使わず、画面上の円で判定する。

| 段 | 内容 |
| --- | --- |
| 中心 | 各オブジェクトの `model.object.position` を camera で画面の px へ投影 |
| 半径 | `model.bounds(0, core).radius`（無ければ 1.1）× 1単位の px（正射影なので `host の高さ / (camera.top − camera.bottom)`）。最小 22px（指で押せる大きさ） |
| 当たり | 中心からの距離 ≤ 半径。複数なら 距離/半径 が最小のもの、同じなら camera に近いもの |
| 戻り値 | `pick(clientX, clientY): string \| null`（item の id） |

### 4.2 操作

| 操作 | 結果 |
| --- | --- |
| オブジェクトにポインタを載せる | カーソルを指に、ポインタの右下に名札「LLM · 正常」を出す（`pointermove` を1フレームに1回だけ判定） |
| オブジェクトをクリック・タップ | そのオブジェクトを選択。カメラが寄り（既存の `select`）、右側に詳細を出す |
| 別のオブジェクトをクリック | 選択を移す |
| 何も無い所をクリック | 選択を外して全体に戻る |
| 詳細の「×」・Esc | 選択を外して全体に戻る |
| チャット表示に戻す | 選択を外して全体に戻る（右の空き 280px が残ったまま会話を見せないため） |

ドラッグでの回転・拡大は足さない。

### 4.3 詳細の表示

カメラは選択中に右側を `min(280px, 幅の45%) + 24px` 空ける（既存の `reserve`）。詳細はその空きに置く。

| 項目 | 値 |
| --- | --- |
| 要素 | `<aside class="spatial-detail" aria-label="LLMの詳細">` |
| 位置 | `top: calc(60px + safe-area-top)`、`right: 16px`、幅 280px（600px 以下は `45%`） |
| 中身 | 部品 `SpatialDetail`（`SpatialBackground.tsx` の状態一覧の中にある表示を切り出す。状態一覧も同じ部品を使う） |

表示の見本（監視から実測が届いている LLM）:

```
┌──────────────────────────────┐
│ LLM                       ×  │
│ ● 正常            実測        │
│                              │
│ 活動     処理中               │
│ 利用率   63%                  │
│ 観測     14:02:11（12秒前）    │
│ ──────────────────────────── │
│ 取得済み · 2026/10/29 14:02:11（12秒前） │
└──────────────────────────────┘
```

計測前の展示（初期の14体）:

```
┌──────────────────────────────┐
│ LARM GPU                  ×  │
│ ● 未確認          未確認      │
│                              │
│ 活動     待機                 │
│ 利用率   未取得               │
│ 観測     未取得               │
└──────────────────────────────┘
```

| 行 | 出所 | 無いとき |
| --- | --- | --- |
| 名前 | `item.label` | — |
| 状態 | `healthLabels[health]`、点の色は `healthColors[health]`。`stale` なら「（情報が古い）」を後ろに足す | — |
| 出所 | `source`: `measurement`→実測、`demo`→デモ値、`unconfirmed`→未確認 | 未確認 |
| 活動 | 待機／準備中／処理中 | — |
| 利用率 | `utilization` を % に | 未取得 |
| 観測 | `observedAt` を時刻と経過秒に | 未取得 |
| 区切りの下 | `details`（監視の `monitoringDetails` が作る文。背景は分類しない） | 行ごと出さない |
| デモ値の欄 | 設定でデモが有効なときだけ（現行の「このモデルのデモ値」をそのまま移す） | 出さない |

## 5. 光の妖精: 触れたときの反応

### 5.1 当たり判定（`model.js` に `hitTest` を足す）

| 部位 | 判定の形 | 半径（世界単位） |
| --- | --- | --- |
| `head` | ボーン `head` の中心の円 | 0.55 |
| `body` | ボーン `hips`→`chest` を結ぶ線分からの距離 | 0.6 |

骨の世界座標を camera で画面の px へ投影し、半径は camera の右方向へ半径分ずらした点との px 距離で換算する（透視投影のため）。`head` と `body` の両方に当たれば `head`。

```ts
// model.d.ts
hitTest(clientX: number, clientY: number): "head" | "body" | null;
```

### 5.2 動作 `touched`（`motions/touched.json`、群 `reaction`）

| 変化版 | 名前 | 使うとき | 動き（2.4秒） |
| --- | --- | --- | --- |
| `touched-head` | 撫でられて目を細める | 頭に触れた | 頭を傾ける（0.25rad）・目を0.6秒閉じる・頭頂が揺れる・`light.energy` と `light.sparkle` が上がる |
| `touched-body` | くすぐったくて身をよじる | 体に触れた | 体を左右に2回ひねる（±0.3rad）・腕を内へ寄せる・小さく2回弾む・`light.swirl` が上がる |
| `touched-startle` | びっくりして跳ねる | 4秒以内に3回目以降の触れ | 0.35 跳ねて腕を開く・`light.sparkle` と `light.core` が強く光る |

変化版は当たった部位と回数で決め、`beginMotion({ variant })` で指定する（自動選択は使わない）。速度は 0〜15% の自動の上げ幅をそのまま使う。

`clips.ts` の変更:

```ts
export const motionGroups = {
	state: "状態",
	emotion: "感情と仕草",
	speech: "発話",
	"idle-gesture": "待機中の仕草",
	reaction: "触れたときの反応",
} as const;
// duration: idle-gesture と reaction は 1〜8 秒、それ以外は 8 秒
```

```json
{
	"id": "touched",
	"label": "触れられる",
	"group": "reaction",
	"duration": 2.4,
	"variants": [
		{ "id": "touched-head", "label": "撫でられて目を細める", "tracks": { "head": [[0, 0, 0, 0], [0.3, 0.05, 0, 0.25], [1.6, 0.05, 0, 0.2], [2.4, 0, 0, 0]], "...": [] }, "blinks": [[0.3, 0.6]] },
		{ "id": "touched-body", "label": "くすぐったくて身をよじる", "tracks": { "...": [] } },
		{ "id": "touched-startle", "label": "びっくりして跳ねる", "tracks": { "...": [] } }
	]
}
```

既存の規則（全 track は静止姿勢で始まり静止姿勢で終わる、ボーン名、範囲）をそのまま満たす。試写タブの動作一覧は `motionGroups` から作るため、「触れたときの反応」の見出しで自動的に並ぶ。

### 5.3 再生の規則（`domains/avatar/controller` の playback に `react(part)` を足す）

| 状況 | 触れたとき |
| --- | --- |
| 待機 | 反応を再生 |
| 会話の動作（状態・感情）の途中 | 反応を再生し、終われば会話の動作の経過時間どおりの位置へ 0.7秒で戻る。会話の動作が既に終わる時刻（8秒）を過ぎていれば待機へ |
| 発話中 | 反応を再生し、発話の重ねは続ける |
| 反応の開始から 0.6秒未満 | 動作は変えない（光の輪だけ） |
| 反応の開始から 0.6秒以上 | 新しい反応を始める |
| 反応中に会話の新しい cue が届く | 会話を優先し、反応を打ち切る |
| `prefers-reduced-motion` | 動作は再生しない。光の輪を動かさず 0.4秒だけ表示 |
| 設定の試写タブが表示中 | 反応しない（試写が同じ模型を動かしている） |
| 精霊に当たらない | 光の輪だけ |

光の輪: 触れた位置に `span.light-avatar-touch` を置き、CSS で 0.6秒広がって消える。当たりは金色（`#ffdca2`、48→96px）、外れは淡い青（`#b3dbff`、32→64px）。精霊の上にポインタがあるときはカーソルを指にする（`pointermove` を1フレームに1回 `hitTest`）。

## 6. 変更するファイル

| ファイル | 変更 |
| --- | --- |
| `web/src/workspace/ChatVisibilityToggle.tsx` | 新規。切替ボタン |
| `web/src/workspace/Workspace.tsx` | `chatHidden` の状態、ボタンの配置、全画面判定の変数化 |
| `web/src/workspace/ConversationPanel.tsx` | `data-chat-hidden`、`interactive` を背景へ渡す |
| `web/src/app.css` | 隠す規則、ボタン、`:has()` の赤い点、`.conversation-status` の空き |
| `web/src/components/ConversationBackground.tsx` | `interactive` を両方の背景へ渡す |
| `web/src/domains/background/controller/scene.ts` | `pick` |
| `web/src/domains/background/SpatialBackground.tsx` | クリック・名札・Esc・詳細の表示、`interactive` が外れたら選択を外す |
| `web/src/domains/background/SpatialDetail.tsx` | 新規。詳細の中身（状態一覧と共用） |
| `web/src/domains/background/style.css` | 詳細・名札・操作中のカーソル |
| `web/src/components/domains/conversation/LightAvatarBackground.tsx` | `interactive`、クリックとポインタの処理、光の輪 |
| `web/src/components/domains/conversation/light-avatar/model.js`・`model.d.ts` | `hitTest` |
| `web/src/components/domains/conversation/light-avatar/clips.ts` | 群 `reaction` と duration の規則 |
| `web/src/components/domains/conversation/light-avatar/motions/touched.json`・`index.ts` | 新規の動作と登録 |
| `web/src/domains/avatar/controller/index.ts` | `react(part)`、`beginMotion(choice)` の受け渡し |
| `web/src/components/domains/conversation/light-avatar/README.md` | 動作の表に反応の層を足す |

## 7. 試験と検証

| 種類 | 内容 |
| --- | --- |
| 単体 | `scene.test.ts`: `pick` の当たり・外れ・重なり・最小 22px。`clips.test.ts`: `reaction` の duration 規則と `touched` の検査。avatar controller の試験: §5.3 の表の各行 |
| 部品 | `SpatialBackground.test.tsx`: `interactive` のときクリックで詳細が出る・Esc と何も無い所で閉じる・`interactive` が外れると閉じる。`LightAvatarBackground.test.tsx`: `interactive` でないときクリックを受けない。切替ボタン: ラベル・`aria-pressed`・全画面で出ない |
| 検証 | `bun run verify -- --domain background --domain avatar --domain conversation`（workspace は domain に属さないため Web の型検査と build で確認） |
| 実画面 | 利用者が Web を再起動した後に、両方の背景で背景モード・クリック・反応を確認する |

## 8. 非目標

- Spatial のドラッグでの回転・拡大、オブジェクトの並べ替え。
- 精霊の撫でる（ドラッグ）・持ち上げる等の連続した操作、触れた方向へ顔を向ける動き。
- 背景モードの状態の保存、背景モード専用のマイクのボタン、背景の切替を背景モード内に置くこと。

## 実装と検証結果

2026-10-29 実装。設計からの差分（いずれも合意した振る舞いを変えない実装上の選択）:

| 箇所 | 設計 | 実装 |
| --- | --- | --- |
| §3.3 隠す要素 | 隠す class を列挙 | `.chat-panel[data-chat-hidden] > :not(背景・光の輪・Spatial・字幕・画像ドロップの表示)` を隠す。「接続を再確認」ボタンに class が無く、列挙では漏れるため |
| §3.3 背景の操作 | `.chat-panel[data-chat-hidden]` の下で `pointer-events: auto` | 背景の部品が自分の `data-interactive` で切り替える（`ConversationBackground` の `interactive`） |
| §5.1 体の当たり | `hips`→`chest` の線分 | `tail_01`→`neck` の線分（半径 0.6）。光の尾と胸の上まで触れられるように広げた |
| §3.1 アーティファクトのタブ | 記載なし | 分割表示のタブの右の空きを 104px から 148px にした（ボタン3つ分。レビューの指摘） |
| §4.2 Esc | 押せば閉じる | フォーカスが body か詳細の中にあるときだけ閉じる。メニュー・ダイアログを開いている間の Esc はそちらに任せる（レビューの指摘） |
| §5.3 会話の動作との関係 | 反応の後、会話の動作の途中へ 0.7秒で戻る | 反応を performer の重ねの層にした。下の動作は自分の時刻のまま進み続け、反応の track は静止姿勢で始まり終わるので、戻りに継ぎ目が出ない。動作中・発話中の重みは 0.7。次の反応・会話の cue が来たら前の反応を 0.3秒で消す |

| 種類 | 結果 |
| --- | --- |
| fixture | `bun run verify -- --domain background --domain avatar --domain conversation` 成功（レビュー修正後、web tests 97件・bun tests 39件）。修正前の2回は、今回触れていない `background/models/evaluator.test.ts` が並列実行で 5秒の時間切れ（単独では 3.9秒で成功） |
| 追加した試験 | `scene.test.ts`（`pick`）、`SpatialBackground.test.tsx`（クリック・空所・×・Esc・モード解除・詳細の中身）、`performer.test.ts`（重ねと時刻の維持・cue での消去）、`playback.test.ts`（部位・0.6秒・3回目・24fps・reduced）、`clips.test.ts`（`reaction` の duration）、`LightAvatarBackground.test.tsx`（モード外は受けない・光の輪・反応）、`ChatVisibilityToggle.test.tsx` |
| レビュー | 独立レビュー1回。指摘4件（タブとボタンの重なり、描く前の反応に会話の cue が重なり再生を作り直した直後の時計で重みが膨らむ、Esc の横取り、詳細の「N秒前」が止まる）をすべて修正し、該当の試験を足した |
| 未試験 | 全画面のアーティファクトでボタンを出さない（`Workspace.tsx` の分岐。Workspace の部品試験が無い） |
| lint | workspace の変更ファイルも `oxlint --deny-warnings` 成功 |
| 実画面 | 未確認。利用者が Web を再起動した後に、両方の背景で背景モード・クリック・反応を確かめる |
