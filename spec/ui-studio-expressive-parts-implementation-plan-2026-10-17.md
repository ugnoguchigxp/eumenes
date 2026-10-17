# UI自由制作の表現力拡張 実装計画

作成日: 2026-10-17

改訂: 同日、要合意事項D1〜D6の回答を反映した。picsum画像は依頼のテーマに合わせて選べるようにする。数式表示と、状態に書き込める電卓を加える。紙芝居・タブなど部品内だけの表示状態を認める。グラフはrechartsを使ってよい。SKILLの上限は48 KB。

状態: 計画・D1〜D6は決着（§9）。実装前。

UI自由制作（`ui.compose`）で作れる画面を、案内画面とアンケートから、ランディングページ・ECのデモ、計算やシミュレーションが動く画面、仕組みの図解まで広げる。LLMにはコードを書かせず、登録済み部品のJSON定義で表現できる範囲を広げる。

## 1 目的と範囲

2026-10-17の利用者との合意を基準とする。検討した案を「やれる」「条件付きでやれる」「やれない」「やるべきでない」に分け、今回は「やれる」だけを対象にする。「条件付きでやれる」は別の機会に検討する。「やれない」「やるべきでない」は選外とし、今後も扱わない。

今回作れるようにするもの（受入シナリオは§8）。

| 番号 | 作れるもの | 主に使う層 |
| --- | --- | --- |
| U1 | ランディングページ（ヒーロー、背景画像にキャッチコピー、特長、お客様の声、料金、行動喚起の帯） | A |
| U2 | ECの商品一覧・商品詳細・カート画面（数量×単価の合計が動く） | A＋B |
| U3 | 電卓・単位換算・割り勘・BMIなどの計算画面 | B |
| U4 | ローン返済・積立・老後資金のシミュレーション（入力に応じてグラフと数値が変わる） | B |
| U5 | 仕組みの図解とステップ解説。例1: 飛行機が飛ぶ仕組み（迎角スライダーで揚力の矢印が伸びる）。例2: 三角測量で月までの距離を求める説明（基線ABの長さを電卓で求め、その結果を次の段の数式に使う） | C＋B |
| U6 | クイズ・診断チャート（選択に応じた分岐表示と採点） | B |
| U7 | 比較表・FAQ・料金表・タイムライン・静的な値のダッシュボード・紙芝居（スライド送り） | A |
| U8 | アンケート（既存の`form`。回答の記録も既存のまま） | 既存 |

表現力を広げる層は次の3つ。

- **A 見せる部品**: テーマで選べる画像を含む静的な表示部品と、紙芝居・タブ。
- **B 状態と式**: 作品全体で共有する状態、安全な式、入力部品と出力部品、数式表示、電卓。
- **C 図解の部品**: 図形・矢印・ラベルとステップ送り。

範囲外とするもの（いずれも別の機会に検討）:
- LARMで生成した画像の利用
- 他のツールチェーンの実データ（天気・株価など）をsourceとして渡すこと
- アニメーションのプリセット
- 定義の上限（16 KiB・60部品）の引き上げ

## 2 現行実装と不足

計画作成時点のコード確認による。

| 現行の仕組みと根拠 | 今回不足しているもの |
| --- | --- |
| 部品の許可リスト `allowedViews`（[ui-compositions contracts](../api/domains/ui-compositions/contracts/index.ts)）は `layout`・`text-block`・`info-card`・`form` の4つ。layoutの`direction`は`stack`・`grid`だけを許す | 新しい部品の許可、`tabs`・`slides`の許可、図・式の検証 |
| view登録 [viewRegistry](../packages/artifact-ui/src/contracts.ts) と描画 [library.tsx](../packages/artifact-ui/src/library.tsx)。layoutは入れ子4階層まで。`tabs`は`tabs`指定が無ければ子ごとに1タブを作り、選択中のタブを部品内の状態で持つ | 画像・状態・式を持つview。作品単位の状態を描画へ配る仕組み。紙芝居 |
| `appearance`（clean・warm・elegant・friendly）のアクセント色（[ui-studio.css](../packages/artifact-ui/src/ui-studio.css)） | 新しい部品が`appearance`に従う配色 |
| DesignSystemの [Card](../packages/design-system/src/components/Card/Card.tsx)・Tabs・Collapsible・MiniTable・NavigationStepper・Calculator（モーダルで開く四則電卓）・Badge・Button | ヒーロー・商品カード・画像・グラフ・図解・数式の部品。電卓をページ内に置く表示、関数キー、計算結果の受け渡し |
| Web版のCSP `img-src 'self' blob: data: https://*.googleusercontent.com`、`style-src 'self' 'unsafe-inline'`、`font-src 'self' data:`（[vite.config.ts](../vite.config.ts)） | picsum画像の読込み許可 |
| SKILL `skill:ui.studio@3`（約6.6 KB）。「hero・image・buttonは無い」「URL・画像は使えない」と明記している（[bundle](../api/domains/capabilities/bundles/ui-compositions.bundle.json)） | 新しい部品・式・画像・テーマの規則と例 |

保存済みの作品の定義は、今回の変更後もそのまま受理する（部品の追加のみで、既存の部品の形は変えない）。

## 3 共通方針

- 定義はこれまでどおりJSONとし、任意のHTML・CSS・JavaScript・URL・`source`は受け付けない。新しい部品もstrictなschemaで検証する。
- 数値はLLMに計算させない。計算はすべて§5の式で書き、描画側が評価する。SKILLでも、計算結果を本文へ直接書くことを禁止する。
- 部品はDesignSystemにprops駆動の汎用部品として置き、業務APIや認証を持たせない（[登録手順 E2](../docs/toolchain-extension.md#e2-必要なdesignsystemコンポーネントを作る)）。OpenUIへの登録はE3に従う。
- UI自由制作で使える部品の一覧は、artifact-uiに`compositionViews`として一つだけ置く。backendの`allowedViews`はこれを参照し、一覧を二重に持たない。
- 状態は2種類に分ける。
  - **作品の状態**（`model`）: 複数の部品で共有する値（入力値、電卓の結果、図解と連動するステップ番号）。一番外側の`layout`だけが持つ（§5.1）。
  - **部品内の表示状態**: 紙芝居の現在の場面、選択中のタブ、FAQの開閉、電卓の表示中の値など。その部品の中で閉じる状態であり、定義には書かず`model`も要らない。
- どちらの状態も保存・記録しない。定義に保存されるのは`model`の初期値だけ。記録する回答はこれまでどおり`form`だけが扱う。
- 新しい部品も`appearance`のアクセント色に従い、ライトとダーク両方のテーマで読めるようにする。

## 4 層A 見せる部品と画像

### 4.1 画像の指定とテーマ

URLは受け付けず、取得元・テーマ・seedで画像を指定する。依頼の内容（コーヒー店、登山用品、旅行など）に合うテーマを選ぶことで、画像の雰囲気をページに合わせる。

```json
{ "provider": "picsum", "theme": "coffee", "seed": "hero", "alt": "湯気の立つコーヒー" }
{ "provider": "placeholder", "tone": "accent", "alt": "" }
```

キーは`source`ではなく`provider`とする。部品の`source`はホストのデータを指す既存の意味があり、UI自由制作では禁止しているため。

**テーマ目録**: picsumの画像IDをテーマ別に分類した目録`picsum-themes.json`をartifact-uiに置き、schemaとSKILLのテーマ一覧はこの目録から作る。

- 目録はW1で作る。picsumの一覧API（`/v2/list`）からIDを取り、縮小画像を目視で確認して分類する。分類の結果と確認日を作業記録に残す。
- 目標は1テーマあたり6枚以上、25テーマ程度。テーマ名は英小文字とハイフンにする。候補は次のとおり。
  - 自然: nature・mountain・forest・sea・beach・sky・flower
  - 都市と建物: city・architecture・interior・night
  - 食: food・coffee
  - 人と動物: people・animal
  - 仕事と道具: workspace・tech・books
  - 移動と季節: travel・road・winter・autumn
  - 地の模様: texture・minimal
- 画像は`theme`とseedのハッシュで目録から決定的に選ぶ。同じ指定なら毎回同じ画像になり、保存した作品の見た目が変わらない。seedを変えると同じテーマの別の画像になる。
- picsumは風景・都市・静物が中心で、特定の商品（スニーカー・家電など）の写真はほとんど無い。SKILLでは、近いテーマ（例: スニーカーならcityかtexture）を選ぶか、placeholderを使うよう指示する。商品と違う写真を商品画像として断定する代替テキストは付けさせない。

| 項目 | 規則 |
| --- | --- |
| `theme` | 目録に載っているテーマ名だけを受け付ける |
| `seed` | `^[a-z0-9][a-z0-9-]{0,39}$`。省略時は`"1"` |
| `alt` | picsumでは必須（1〜120字）。placeholderは装飾として空文字を許す |
| `grayscale`・`blur` | 真偽値、0〜10の整数 |
| `tone`（placeholder） | `accent`・`neutral`・`warm`・`cool`。外部へ通信せず、デザイントークンのグラデーションで描く |
| 寸法 | 部品と`aspect`（`landscape`・`square`・`portrait`・`wide`）から描画側が決める。URLは `https://picsum.photos/id/<目録のID>/<w>/<h>`。`srcset`は1xと2x |
| 失敗時 | 読込みに失敗したら同じ枠をplaceholderで描く。代替テキストは保持する |
| 送信 | `referrerPolicy="no-referrer"`、`loading="lazy"`、`decoding="async"` |

URLの組立ては`buildPicsumUrl(image, width, height)`の一か所だけで行い、URLに入るのは目録のIDと寸法・フィルタの値だけにする。CSPの`img-src`へ`https://picsum.photos`と`https://fastly.picsum.photos`（リダイレクト先）を追加し、[CSP試験](../tests/browser/csp.spec.ts)を更新する。

### 4.2 部品

| view | DesignSystem部品（新設） | 主なprops | variant |
| --- | --- | --- | --- |
| `hero` | Hero | eyebrow、title（必須）、body、primaryLabel、secondaryLabel、image | `centered`・`split`（文字と画像を左右に）・`background`（画像を全面背景にし文字を重ねる。overlayは`dark`・`light`・`accent`、alignは`start`・`center`、heightは`md`・`lg`） |
| `image` | ContentImage | image、aspect、caption、rounded | — |
| `media-card` | MediaCard | image、aspect、title、body、eyebrow | `vertical`・`horizontal` |
| `product-card` | ProductCard | image、name、price（表示文字列）、compareAtPrice、badge（`new`・`sale`・`limited`・`soldout`）、body、rating（0〜5、0.5刻み） | `vertical`・`horizontal` |
| `feature-card` | FeatureCard | icon（列挙した約30種のlucideアイコン）、title、body | — |
| `testimonial` | Testimonial | quote、name、role、avatar（image） | — |
| `pricing-card` | PricingCard | plan、price、period、features（1〜10件）、ctaLabel、highlighted | — |
| `cta-banner` | CtaBanner | title、body、primaryLabel、secondaryLabel、image | `accent`・`subtle`・`image` |
| `comparison-table` | ComparisonTable | columns（2〜6）、rows（1〜20。値は文字列または`true`・`false`）、highlightColumn | — |
| `faq` | Faq（Collapsibleを再利用） | items（1〜12件。question・answer） | — |
| `timeline` | Timeline | items（1〜12件。label・title・body） | — |
| `stat` | StatTile | label、value（文字列、または§5の式）、format、caption、trend（`up`・`down`・`flat`） | — |

- ボタンの表記（primaryLabelなど）は表示だけとし、押しても何も起きない。リンクと遷移は作らない。
- 商品の価格は表示用の文字列として持つ。カートの合計は§5の`stat`の式で計算する。

### 4.3 紙芝居とタブ

`layout`の`direction`に`slides`を追加し、UI自由制作では既存の`tabs`も許可する。

- **`slides`**: 子を1枚ずつ表示する紙芝居。前へ・次へのボタン、「2 / 5」の位置表示、場面の一覧（点）を持つ。キーボードの左右キーでも送れる。
- **`tabs`**: 子ごとに1タブ。タブ名は子の`title`を使う。
- どちらも、現在の場面や選択中のタブは部品内の表示状態（§3）とする。
- UI自由制作では、`tabs`の明示指定・`headerChildren`・`draftSource`・`form-preview`は従来どおり受け付けない（設定画面専用）。

## 5 層B 状態と式

### 5.1 作品の状態

一番外側の`layout`だけが`model`を持てる。入れ子の`layout`に`model`があれば拒否する。

```json
{
  "view": "layout",
  "model": {
    "state": {
      "age": { "type": "number", "initial": 40, "min": 20, "max": 70 },
      "monthly": { "type": "number", "initial": 30000, "min": 0, "max": 500000 },
      "rate": { "type": "number", "initial": 3, "min": 0, "max": 15 },
      "answer1": { "type": "text", "initial": "" }
    },
    "computed": {
      "balance": { "series": { "from": "age", "to": 65, "initial": 0, "expr": "prev * (1 + rate / 100) + monthly * 12" } },
      "atRetire": "last(balance)"
    }
  },
  "children": []
}
```

| 項目 | 規則 |
| --- | --- |
| 状態 | 名前は`^[a-z][a-zA-Z0-9]{0,31}$`、32個まで。typeは`number`・`boolean`・`text`。`number`は`min`・`max`・`step`を持てる |
| 計算値 | 式の文字列、または`series`。32個まで。参照に循環があれば拒否する |
| `series` | `from`・`to`は式で、評価後に整数へ丸める。1系列あたり1,200点まで。`expr`では`i`（現在の添字）と`prev`（直前の値。初回は`initial`）を使える。結果は`{x, y}`の列 |

描画側は一番外側の`layout`で`CompositionModelProvider`を作り、状態の値と計算値を子へ配る。`model`の無い定義は今までどおり描画する。

### 5.2 式

artifact-uiに自前のパーサと評価器（`composition-expressions.ts`）を置き、backendの検証とWebの描画で同じものを使う。`eval`・`Function`・動的importは使わない。

| 分類 | 内容 |
| --- | --- |
| リテラル | 数値、`"..."`の文字列（120字まで）、`true`・`false`、定数`pi`・`e` |
| 演算子 | `+ - * / % ^`、`== != < <= > >=`、`&& \|\| !`、`c ? a : b`、括弧 |
| 関数 | 基本: `min`・`max`・`abs`・`round(x, 桁)`・`floor`・`ceil`・`sqrt`・`pow`・`log`・`exp`・`clamp(x, lo, hi)`。三角関数（度で受ける）: `sin`・`cos`・`tan`・`asin`・`acos`・`atan`・`atan2`。金融: `pmt(rate, n, pv)`・`fv(rate, n, pmt, pv)`。系列: `last`・`first`・`at(s, i)`・`sum`・`len`。文字列: `text(x)`・`format(x, "yen"\|"number"\|"percent"\|"km"…)` |
| 上限 | 式1つが300字まで、ASTの深さ32まで。1回の評価で全系列合わせて1万ステップまで |
| 失敗時 | 0除算・範囲外・型違いは`NaN`または`null`とし、表示は「—」。例外で画面を落とさない |

三角関数は、図解と三角測量で使う度数法に揃える。弧度で受ける関数は置かない。

backendは保存と下書き反映のときにすべての式を構文解析し、参照先の存在・循環・上限・関数名を検証する。失敗したら既存の`ui_definition_invalid`系のエラーとして、短いdetailを付けて返す。detailには位置と規則名だけを入れ、定義の値は入れない。

### 5.3 入力・出力・数式・電卓

入力部品:

| view | 内容 |
| --- | --- |
| `number-input` | `bind`（number型の状態）、label、unit、min・max・step（状態側の値を既定にする） |
| `slider` | `bind`、label、unit、表示形式 |
| `choice` | `bind`（text型）、options（2〜8件）。`buttons`（セグメント）または`cards`（クイズ・診断向けの大きな選択肢） |
| `toggle` | `bind`（boolean型）、label |

出力部品:

| view | 内容 |
| --- | --- |
| `stat` | §4.2 |
| `chart` | `kind`は`bar`・`line`・`area`・`pie`。`series`は1〜3件で、各件は計算値の`series`名か、定義内の静的な点（120点まで）。軸のラベル・単位・注記を持つ。凡例とツールチップを付ける。配色はアクセント色から作る。描画はrecharts（§9 D3） |
| `data-table` | 静的な行、または`series`から作る行（列は`x`と式）。200行まで、超える分は「他N行」と表示する |

数式と電卓:

| view | 内容 |
| --- | --- |
| `formula` | 数式を表示する。`tex`はLaTeXのサブセットで、KaTeXで描画する（`trust: false`、`\href`・`\url`・`\html*`は不可、`maxSize`と`maxExpand`に上限）。任意の`expr`（§5.2）を付けると、現在の状態で評価した値を「= 384,400 km」のように併記する。`label`で「ステップ2」などの見出しを付けられる |
| `calculator` | ページ内に置く電卓。DesignSystemのCalculatorに、モーダルではなく直接置く`inline`表示と、関数キー（`sin`・`cos`・`tan`・`√`・`^`・`π`）を持つ`scientific`表示を追加して再利用する。`preset`（§5.2の式の文字列）を指定すると、その計算式を入力済みの状態で表示し、利用者は「=」を押して結果を確かめる。`resultBind`（number型の状態）を指定すると、「=」で得た結果をその状態へ書き込み、後続の`formula`・`stat`・`diagram`がその値を使う |

- 電卓は、利用者が自分で計算を確かめることに意味があるページでだけ使う。SKILLでもそう指示する。
- 三角測量の例では、ステップ1の`calculator`で基線ABの長さを`preset`から計算して`resultBind: "baseline"`へ書き込む。ステップ2の`formula`は`d = \frac{AB}{\tan\theta}`を表示し、`expr: "baseline / tan(theta)"`の値を併記する。

その他:

- `layout`に`when`（式）を追加し、真のときだけ子を表示する。診断の結果やクイズの正誤表示に使う。
- `bind`・`resultBind`の先が存在しない、または型が違う場合は検証で拒否する。

## 6 層C 図解

| view | 内容 |
| --- | --- |
| `diagram` | 座標0〜100の`viewBox`に、`shape`（`rect`・`ellipse`・`polygon`）・`line`・`arrow`・`label`・`polyline`・`angle`（角度の弧と記号）の要素を80個まで置く。要素の色は`accent`・`ink`・`muted`・`positive`・`negative`・`warning`のトークン名から選ぶ。座標・長さ・角度・ラベル文字には§5の式を使える（例: 揚力の矢印の長さ`= 10 + lift * 0.4`）。要素ごとに`steps`（表示するステップ番号の配列）と`highlightAt`を持てる |
| `stepper` | steps（2〜12件。title・body）。前へ・次へのボタンとステップの一覧を表示する。DesignSystemのNavigationStepperを再利用する。現在のステップは部品内の表示状態で持つ。`bind`（number型の状態）を指定したときだけ作品の状態へ反映し、`diagram`の`stepBind`と連動させる |

- `diagram`はReactで要素ごとにSVGを組み立てる。文字列でのSVG挿入や`dangerouslySetInnerHTML`は使わない。図には自前のDesignSystem部品`Diagram`を新設する（rechartsでは描かない）。

## 7 SKILLとbundle

- SKILLの「使える部品」「定義の形」を書き直す。
  - 部品の説明: 部品ごとの必須props・variant・使いどころ。
  - 式: 規則と使える関数。
  - 画像: テーマ一覧、テーマの選び方、seedの付け方。
  - 状態: 作品の状態と部品内の表示状態の使い分け。
  - 電卓を使う条件。
  - 例: ランディングページ、EC、シミュレーション、図解（飛行機）、三角測量、クイズ、紙芝居。
- 禁止事項として次の規則を加える。
  - 計算結果を本文へ直接書かず、式で書く。
  - 実在のブランド名・ロゴ・商標を使わない。架空の名前を付ける。
  - パスワード・カード番号などの入力欄を作らない。
  - シミュレーションには前提（利回りなど）と「試算」である旨の注記を必ず表示する。
- SKILL本文は48 KB以内とする。部品カタログを引く読み取り専用ツールは作らない。
- 改版: `skill:ui.studio@4`、`package:ui.studio@4`、`toolchain:ui.compose@6`。toolchainの`useWhen`と`examples`にEC・計算・図解・紙芝居の例を加える。profileは変えない。

## 8 作業単位・試験・受入

### 8.1 作業単位

| 単位 | 内容 | 主な変更先 |
| --- | --- | --- |
| W1 基盤 | `compositionViews`、画像の型、テーマ目録`picsum-themes.json`の作成、`buildPicsumUrl`、CSP、許可リストのbackend参照、`slides`と`tabs`の許可 | artifact-ui contracts・library、ui-compositions contracts、vite.config.ts、csp.spec.ts |
| W2 見せる部品 | §4.2の部品（DesignSystem部品・stories・test、view登録、描画adapter、appearanceへの対応）、紙芝居 | design-system components、artifact-ui |
| W3 状態と式 | パーサ・評価器・検証、`CompositionModelProvider`、入力部品、`when`、`stat`・`chart`（recharts）・`data-table`、`formula`（KaTeX）、Calculatorの`inline`・`scientific`・`preset`・`resultBind` | artifact-ui、design-system、ui-compositions contracts |
| W4 図解 | `diagram`・`stepper` | design-system、artifact-ui |
| W5 SKILL・bundle | §7、ui-studioのWeb試験の更新 | bundle、web/src/domains/artifact/test |

依存の追加: `recharts`と`katex`をdesign-systemへ追加する。版は導入時の安定版に固定し、React 19との互換を確認する。KaTeXのCSSとフォントは自前で配信し、CSPの`font-src 'self'`の範囲に収める。

DesignSystemの部品はディレクトリ単位で分かれるので並行して作れる。`contracts.ts`・`library.tsx`・`package.json`・bundleなどの共有ファイルは一人がまとめて編集する。

### 8.2 試験

- **DesignSystem**: 部品ごとのstoriesとtest（variant、画像失敗時の代替表示、キーボード操作、ダークテーマ）。
- **紙芝居**: 前へ・次へ、左右キー、端での停止、位置表示。
- **電卓**: `preset`の表示、「=」での`resultBind`への書込みと後続部品の再計算、関数キー。
- **式**: 演算子・関数（度数法の三角関数を含む）・優先順位・0除算・上限超過・循環参照・未定義参照を試験する。`constructor`・`__proto__`などの名前で既存オブジェクトに触れないことを確かめる。
- **schema**: すべての新しいviewの正常例と拒否例。入れ子の`model`、型違いの`bind`・`resultBind`、URLの混入、目録に無いテーマ、不正なseed、KaTeXで禁止したコマンドは拒否する。
- **テーマ目録**: 全テーマが6枚以上を持つこと。同じ指定から同じIDが選ばれること。
- **ui-compositions**: 新しい部品を使った下書き反映・保存・閲覧。保存済みの旧作品がそのまま表示されること。
- **Web**: 制作画面のプレビューとソース表示。入力に応じた再計算。保存作品の閲覧で入力値が保存されないこと。
- **検証コマンド**: `bun run verify -- --domain ui-compositions` に、影響を受ける利用側のdomainを加えて実行する。ブラウザE2Eは`tests/browser/ui-compositions.spec.ts`と`tests/browser/csp.spec.ts`を個別に実行する。

### 8.3 受入

fixtureとliveは分けて記録する。

| 種別 | 内容 |
| --- | --- |
| fixture | U1〜U8それぞれの完成定義を試験データとして持ち、schema・backend検証・描画を通す。U5は飛行機と三角測量の2件。定義が16 KiB・60部品に収まることも確かめる |
| live（実モデル） | 保存済みの担当設定で、U1〜U7を1件ずつ依頼する（例:「コーヒー豆のECサイトのトップページを作って」「老後資金のシミュレーターを作って」「飛行機が飛ぶ仕組みを図解して」「三角測量で月までの距離を求める説明ページを作って」）。一回目の反映が成功したか、失敗時の自己修正で通ったか、画像のテーマが依頼に合っていたかを記録する |
| 実機器 | 音声での依頼と修正（例:「利回りの初期値を5%にして」）。音声MVPの受入とは別に記録する |

## 9 決定事項

2026-10-17に利用者と決着。

| ID | 論点 | 決定 |
| --- | --- | --- |
| D1 | 保存作品を開くたびに、閲覧者のブラウザからpicsumへリクエストが出る | 許容する。依頼に合うテーマの画像を選べるようにする（§4.1のテーマ目録）。no-referrer、遅延読込み、失敗時は代替表示 |
| D2 | 部品が増えてSKILLが長くなる | 48 KB以内ならSKILLに収める。カタログツールは作らない |
| D3 | グラフ・図の描画方法 | グラフはrecharts（SVGで描画する）。図解は自由な配置が要るため自前のSVG部品 |
| D4 | 電卓の置き方 | 必要なページだけで使う。ページ内に置き、計算式を入力済みにでき、結果を作品の状態へ渡せる。数式表示の`formula`と組み合わせる（§5.3） |
| D5 | 状態の範囲 | 作品の状態（`model`）は一番外側の`layout`だけが持つ。紙芝居の場面・タブ・開閉など部品内で閉じる表示状態は、`model`なしで部品が持ってよい |
| D6 | 定義の上限 | 16 KiB・60部品のまま。fixtureで超える例があれば報告し、引き上げは別の機会に検討する |
