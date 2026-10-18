# UI自由制作の表現力拡張 実装計画

作成日: 2026-10-17

改訂: 同日、要合意事項D1〜D6の回答を反映した。picsum画像は依頼のテーマに合わせて選べるようにする。数式表示と、状態に書き込める電卓を加える。紙芝居・タブなど部品内だけの表示状態を認める。グラフはrechartsを使ってよい。SKILLの上限は48 KB。

状態: 実装・固定試験・ブラウザE2E済み（2026-10-18。§10・§11）。live（実モデル）・実機器の受入は未実施。

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

**テーマ目録**: picsumの画像IDをテーマ別に分類した目録[`picsum-themes.ts`](../packages/artifact-ui/src/picsum-themes.ts)をartifact-uiに置き、schemaとSKILLのテーマ一覧はこの目録から作る。

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
| `data-table` | 静的な行（50行まで）、または`series`から作る行（列は`x`・`y`を使う式）。表示は200行までで、超える分は「他N行」と表示する |

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
| `stepper` | steps（2〜12件。title・body）。前へ・次へのボタンとステップの一覧を表示する。DesignSystemの部品はStepGuideを新設した（既存のNavigationStepperには前後ボタンと本文表示が無く、12件で横にあふれるため）。現在のステップは部品内の表示状態で持つ。`bind`（number型の状態）を指定したときだけ作品の状態へ反映し、`diagram`の`stepBind`と連動させる |

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
| W1 基盤 | `compositionViews`、画像の型、テーマ目録`picsum-themes.ts`の作成、`buildPicsumUrl`、CSP、許可リストのbackend参照、`slides`と`tabs`の許可 | artifact-ui contracts・library、ui-compositions contracts、vite.config.ts、csp.spec.ts |
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

## 10 実施記録

2026-10-17。監督者1名と作業者7名で実施した。作業者の担当は、DesignSystemの見せる部品、内容・入力部品、グラフ・数式・電卓、図解、式とmodel、画像目録とCSP、SKILL・bundle・fixtureの7つ。共有ファイル（契約、`library.tsx`、`contracts.ts`、DesignSystemの`index.ts`と依存、backendの接続）は監督者が編集した。

### 実装したもの

- 契約: [composition-contracts.ts](../packages/artifact-ui/src/composition-contracts.ts)（22の view、画像の指定、`model`、図解の要素）。`viewRegistry`へ合流し、layoutに`model`・`when`・`slides`を追加した。
- 式と状態:
  - [composition-expressions.ts](../packages/artifact-ui/src/composition-expressions.ts)（自前のパーサと評価器）
  - [composition-compute.ts](../packages/artifact-ui/src/composition-compute.ts)（Reactを使わない計算）
  - [composition-model.tsx](../packages/artifact-ui/src/composition-model.tsx)（Provider）
  - [composition-validate.ts](../packages/artifact-ui/src/composition-validate.ts)（意味の検証）
  - [composition-format.ts](../packages/artifact-ui/src/composition-format.ts)
- 画像: [composition-images.ts](../packages/artifact-ui/src/composition-images.ts)と、24テーマの目録。目録の作業記録は[picsumテーマ目録](verification/ui-studio-picsum-themes-2026-10-17.md)。
- 描画adapter: `composition-marketing/content/data/diagram-components.tsx`。グラフ・表・数式・電卓は、rechartsとKaTeXを初回表示時に読み込む（`library.tsx`の`lazyView`）。
- DesignSystemの部品（新設20、既存の改修1）:
  - 新設: ContentImage、Hero、MediaCard、ProductCard、FeatureCard、Testimonial、CtaBanner、PricingCard、ComparisonTable、Faq、Timeline、StatTile、Slides、RangeSlider、ChoiceGroup、Chart、Formula、DataTable、Diagram、StepGuide
  - 改修: Calculator（`inline`・`scientific`・`initialExpression`・`evaluate`）
  - 依存: `recharts@3.10.1`・`katex@0.16.47`
- backend: `allowedViews`を`compositionViews`から作るようにした。設定画面専用のlayoutの項目は拒否する。保存と下書き反映で`validateComposition`を呼ぶ。backend向けの関数は`@eumenes/artifact-ui/composition-checks`から読み、Webの初期バンドルへ式エンジンを入れない。
- プレビュー: `appearance`ごとに`--ds-accent`を設定する（`ui-studio.css`）。
- SKILLとbundle:
  - 版: `skill:ui.studio@4`（約29.9 KB）、`package:ui.studio@4`、`toolchain:ui.compose@6`
  - 例: 7件。すべて`validatedDefinition`を通ることを試験している。
- CSP: `img-src`へ`https://picsum.photos`と`https://fastly.picsum.photos`を追加した。
- fixture: U1〜U8（U5は飛行機と三角測量の2件）を`api/domains/ui-compositions/test/fixtures/`に置いた。backendの検証、初期状態の計算値、`ArtifactRenderer`での描画まで試験している。
- 検証の仕組み: `packages/artifact-ui/src`の試験をbunで実行するよう、`scripts/verification-selection.ts`に規則を追加した。

### 計画からの差分

- 目録は`.ts`にした。図解のステップはStepGuideを新設した。`data-table`の静的な行は50行まで。
- 三角関数・`rotate`・`angle`の角度は、度で反時計回りを正とする。
- 式の失敗は`null`（表示は「—」）。予約名（`pi e true false i prev x y`）と、状態と計算値の重名は拒否する。
- 電卓の結果は12桁で丸める。scientificの電卓では、暗黙の掛け算になる入力（`2π`など）に` * `を補う。

### 独立レビューと修正

highの指摘は無かった。medium・lowの指摘はまとめて1回で修正した。

| 分類 | 修正内容 |
| --- | --- |
| 電卓 | 暗黙の掛け算の補完、浮動小数の丸め、`preset`を変えたときの再マウント |
| 計算量 | 系列を引数にした`min`・`max`も評価の上限に数える。系列の点数は1系列1,200点・全体1万点を検証で拒否（`series_too_long`・`series_budget_exceeded`） |
| 数式 | 禁止するTeXコマンドを検証で拒否（`tex_command_not_allowed`）。KaTeXの赤字エラーと例外は代替表示にする |
| 検証の追加 | `bind_range_mismatch`・`choice_initial_not_in_options`・`state_range_invalid`・`expr_without_series` |
| 紙芝居 | 全場面をマウントし、場面を移っても入力が残る。`when`が偽の場面は場面に数えない |
| 入力と表示 | ChoiceGroupの無効化。modelが無いときも定数の`stat`式を評価する |
| グラフ | x が重複する点とpieのkeyの重複を直した |
| 画像 | 2倍解像度用の寸法で縦横比を保つ |

一番外側を`tabs`にしたときにtitleが見出しとして表示される点は、設定画面と描画を共有しているため描画を変えず、SKILLに明記した。

### 検証結果（fixture）

- `bun run verify -- --domain ui-compositions --domain artifact`: pass。bunの試験303件、webの試験83件、design-systemの型検査とbuildを含む。
- design-systemの新設・改修部品の単体試験: 22ファイル198件がpass。
- capabilities・ui-compositionsのadapter・`scripts/verification.test.ts`: 95件がpass。
- リポジトリ全体の`bun check`: 今回の範囲外の`api/application/media/music-routing.test.ts`（`runId`の欠落）だけが失敗する。

### 未実施・未確認

- ブラウザE2E（2026-10-17、利用者の許可を得て実行）:
  - 実行方法: 初回の実行時は、`bunx playwright test`（Node 24）でどのspecも読込みに失敗した。`client`が読む`eumenes-memory`がTypeScriptのまま`node_modules`にあり、Nodeの型除去が`node_modules`内を扱わないため。下の対応後は、Nodeのままの`bunx playwright test --list`で全specを認識する。この下の2件の結果は、対応前に`bun --bun x playwright test`で得たもの。
  - 対応（利用者の指示）: `eumenes-memory`を、ビルド済みのdist（JavaScriptと型宣言）を同梱する0.0.2にし、`vendor/eumenes-memory/eumenes-memory-0.0.2-6643656f3383.tgz`として取り込んだ。
    - eumenes_memory側: `tsconfig.build.json`、`exports`をdistへ、`files`をdistだけに、`prepack`でbuild。`verify:all`は548件pass。
    - Eumenes側: 型検査とmemory・worldのverify（314件）がpass。
  - `tests/browser/csp.spec.ts`: 1件pass。picsumを含むimg-srcで主要画面のCSP違反は無い。
  - `tests/browser/ui-compositions.spec.ts`: 7件すべてfail。依頼を送った直後に会話が`invalid_conversation_operation`で止まり、専門担当へ切り替わらない。この失敗は、別の作業として進行中の初動の要求分析（`api/domains/dialogue/service/request-analysis.ts`、未追跡）が、fixtureの台本どおりの会話モデルに合わないことによる。今回の変更の範囲外。その作業が落ち着いてから再実行する。
- Storybookと実ブラウザでの見た目（コントラスト、図解の文字の重なり、KaTeXのフォント）は確認していない。
- live（実モデル）の受入、実機器（音声）の受入は未実施。
- `bun run bundle:check`は記録値を超えている。
  - 測定値: エントリgzip 112,035 B、初期読込み全体259,653 B。記録値はそれぞれ101,087 B・247,357 B。
  - 今回の変更の寄与は、`viewRegistry`へ合流した新しいviewのschema（gzipで約4 KB）。残りは、同時期に並行して進んだ別の作業の変更によると見ている（未分離）。
  - 利用者の判断（2026-10-17、バンドルサイズは重視しない）により、`bun scripts/bundle-budget.ts --write`で記録値を現状に更新した。

## 11 ブラウザE2Eの実施（2026-10-18）

LARMの圧縮通信の対応後、利用者の指示で再開した。§10の初回実行で失敗していた`ui-compositions.spec.ts`の原因と対応は次のとおり。

| 原因 | 対応 |
| --- | --- |
| fixtureの台本（`scripts/ui-compositions-fixture-server.ts`）が、会話の初動の要求分析（1回目に委譲先と予告、2回目にその機能への依頼を書く）に未対応で、`invalid_conversation_operation`で止まっていた | API試験と同じく`analysisReceipt`で1回目に`ui_create`と予告を返し、UI以外の依頼は自分で答える |
| 専門担当のターンが速く、`activeRunId`が設定されて解除されるまでの間にsessionを一度も読めないと、制作画面のソースを再取得しない（下書きの更新が画面に出ない）。製品の不具合 | `web/src/domains/ui-compositions/toolchain-adapter.tsx`の再取得キーに`session.updatedAt`を加えた。ターンの度にsessionは更新される。回帰試験を追加 |
| specのlocatorの曖昧さ。読上げ用の`aria-live`と本文の重複、作品名の見出しが制作画面とプレビューの2か所、同じファイル内の別の試験が保存した同名作品、保存作品のフォームのボタン名が「送信」（「フォームを送信」ではない）、会話欄とフォームの送信ボタン | `exact`、`.first()`、会話欄への範囲指定、実際のボタン名に修正。初回の計画（専門担当との対話編集）でブラウザE2Eは未実施だったため、今回が初めての実行 |

今回の部品の確認として`tests/browser/ui-composition-parts.spec.ts`を追加した。fixtureの専門担当がU1・U4・U5bの定義と、入力を持つ紙芝居を反映する。

- picsum画像がCSP違反なしで読み込まれる（`naturalWidth > 0`、`referrerpolicy="no-referrer"`）
- グラフの描画領域の大きさが0でない。スライダーを動かすとstatとグラフの系列が変わる。年ごとの表が出る
- 電卓の「=」の結果が`resultBind`経由で、`when`で隠れていたステップ2と数式の値に反映される。数式はKaTeXで描画される
- 紙芝居で場面を移っても入力が残り、次の場面のstatが作品の状態を共有する
- ダークテーマで、数式・stat・電卓の見出しの文字が背景に対してコントラスト比4.5以上

結果:

- `bunx playwright test tests/browser/csp.spec.ts tests/browser/ui-compositions.spec.ts tests/browser/ui-composition-parts.spec.ts`: 13件pass。2回続けて実行し、2回ともpass。
- 各runでViteのキャッシュが空から始まるため、初回の制作画面の表示（rechartsとKaTeXの変換）が20秒を超えることがあった。最初の表示だけ60秒待つ。
- `bun run verify -- --domain ui-compositions --domain artifact`: pass（bunの試験303件、webの試験84件）。

利用者の実機確認で見つかった不具合（2026-10-18）:

- 現象: 音声でUI自由制作の担当に話しかけると、画面に「接続の権限が取り消されました。」（`permission_revoked`）が出て、返答が読み上げられない。テキスト入力では起きない。最初の音声の依頼で担当へ切り替わる場合も、宛先が担当のままの2回目以降の依頼も同じ。
- 原因:
  - 音声の応答は、読み上げに入る前に、runの会話側の推論要求が採用済みかを確かめる（`voice-dialogue/service/index.ts`の`advance`）。
  - 専門担当の経路では、返答を書くのは専門担当で、会話側の推論要求は採用されずに`pending`のまま残る。宛先が担当の場合は、会話側のモデルが一度も呼ばれない。
  - そのため、会話のrunは`completed`なのに、音声のターンだけが毎回`permission_revoked`で失敗していた。
  - 先に疑ったbundleの版の衝突（`skill:ui.studio@4`）とrepairは、原因ではなかった。版の衝突は別に直した（skill@5・package@5・toolchain@7）。
- 修正: `dialogue/service/specialist-settle.ts`。専門担当の返答でrunを完了する経路（返答、および作業を返して終える返答）で、専門担当の推論結果を採用したあと、同じトランザクションで会話側の推論要求を既存の`acceptHostAnswerInTransaction`（モデルの回答を採用せずにホストが回答を確定する仕組み）で確定する。確定できなければ`permission_revoked`で失敗させる。会話側へ戻す経路（`forward`）は、会話側のモデルが同じ要求で答えるので対象外。
- 試験: `api/application/toolchain/specialist-voice.test.ts`（音声で切り替わる1回目と、宛先が担当の2回目）。修正前はfail、修正後はpass。`bun run verify -- --domain dialogue --domain voice-dialogue --domain ui-compositions --domain inference`はpass（bunの試験703件、webの試験70件）。実機での再確認は、サーバー再起動後に利用者が行う。

- 現象（2回目）: 音声でランディングページを依頼すると、専門担当の下書きが3回続けて`ui_definition_invalid`で拒否され、4回目の推論の途中で`specialist_turn_timeout`（1ターン120秒）になる。1回の推論は33〜38秒。
- 原因:
  - 拒否の理由が「`children/0: Invalid input`」だけだった。部品はすべての部品のschemaの和（union）で検証されるため、zodの最初の指摘は和全体の失敗で、どの部品のどの項目が悪いかを含まない。
  - モデルは直す手がかりが無く、3回とも同じ案を出し直していた。出力はどれも1261トークンで、入力は毎回、前の出力と拒否の結果の分（約1300トークン）だけ増えていた。出力上限による打ち切りではない（上限は4096）。
  - 前回足したログの`repairHint`は、ロガーの項目の許可リストに無く、捨てられていた。
- 修正:
  - `ui-compositions/contracts`の`validatedDefinition`。和の指摘では、`view`が一致した枝（その部品自身の種類のschema）の最初の指摘を入れ子までたどって返す（例「`children/1/children/0/image/theme: Invalid option: expected one of …`」）。
  - `infrastructure/logger.ts`の許可リストに`repairHint`を加える。
- 試験: `ui-compositions.test.ts`（部品の項目を指す理由）、`logger.test.ts`（`repairHint`が残る）。`bun run verify -- --domain ui-compositions`はpass。
- 制限の緩和（2026-10-18の利用者の指示。モデルの文脈には余裕があり、出力は24kトークンまで見込んでよい）:
  - 専門担当: 出力上限4096→24576トークン（LARMの出力予約が小さければそちらが効く）、自分の履歴24 KiB→192 KiB、拒否の手がかり300→1000字、操作の結果24,000→96,000字。
  - 定義: 16 KiB→96 KiB、部品60→240、入れ子4→6階層、layoutの子12→48（artifact-uiの`contracts.ts`とui-compositionsの`limits`）。見出しは120→480字。
  - 表現部品: 文字数の上限は4倍、件数はおおむね4倍（項目・手順・FAQ・料金の特長など）、表は列12・行200、グラフは系列8・各600点、図は要素240。
  - SKILLの数値を合わせ、skill@6・package@6・toolchain@8に上げた。
  - 試験の上限値を更新し、`bun run verify -- --domain ui-compositions --domain dialogue --domain capabilities --domain voice-dialogue`はpass（bunの試験650件）。
- 残る課題: 1回の推論が長く、作り直しが2回重なると上限に達する。これは[一回推論の下書きと定義の補正](ui-studio-one-shot-draft-design-2026-10-18.md)で扱う（合意待ち）。

残る受入:

- live（実モデル）: U1〜U7を1件ずつ依頼し、一回目の反映の成否、失敗時の自己修正、画像のテーマが依頼に合うかを記録する。
- 実機器（音声での依頼と修正）。
- Storybookでの見た目の確認は未実施。
