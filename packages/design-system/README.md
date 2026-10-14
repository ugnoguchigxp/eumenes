# DesignSystem

元リポジトリ `../gxp-designSystem` の `main`、`abcf226c2d10b9f14a62e03d3f9655522ea70f02` からソースとビルド設定を取り込みました。Eumenes の workspace package `@eumenes/design-system` として独立して管理します。元のライセンスは `LICENSE` にあります。

Eumenes のルートで `bun install` を実行後、`bun run build:design-system` で配布物を再生成できます。`packages/design-system` 内では `bun run test` で部品の単体試験を実行できます。

## タブとテーマ

`TabsList` は既定の `line`（共通の基線と選択下線）と `workspace`（選択中の面が内容欄につながる形）を提供します。`line` は列の幅へ均等に収め、`workspace` は内容に合わせて縮みます。横スクロールは使わず、長いラベルは視覚上だけ省略し、全文の title と accessible name を保ちます。選択中は背景・文字色・太字・下線で区別します。Radix の選択状態、矢印キー操作、パネルとの関連付けを使います。

`TabsTrigger` に `onClose` と `closeLabel` を渡すと、選択ボタンの隣に独立した閉じるボタンを置きます。閉じる操作でタブを選択しません。ルートの制御値は利用側が所有します。

配色の正本は `src/styles/themes.css` です。ライトとダークは `ds-theme-light` / `ds-theme-dark` で局所的にも適用でき、プレビュー側で色値を複製する必要はありません。タブの高さと間隔は `--ui-tab-height` / `--ui-tab-gap`、部品の文字と余白は既存の密度トークンを使います。

密度も `ds-density-compact` / `ds-density-spacious` で局所適用できます。プレビュー固有の部品サイズを別に定義せず、アプリと同じトークンを使います。

## ラジオ選択

`RadioButtonGroup` は `label`、`options`（value / label）、`value`、`onValueChange` を受け取る制御部品です。選択肢は行全体で押せ、長い文章は折り返します。選択中は丸印・枠・背景で示し、フォーカスは行の外周に表示します。native radio の矢印キー・フォーム検証を保ち、グループ名を自動で分離します。`disabled` 時も選択済みの行は判読できる状態を保ちます。

## ターミナル

`TerminalWorkspace` は xterm.js（`@xterm/xterm`、fit・unicode11・WebGL addon）の端末を見出しやボタン無しで端から端まで並べ、複数なら幅 720px 以上で2列、それ未満で縦に積みます。高さは利用側が与えます。PTY・接続・認証は持たず、ホストが `output.subscribe` で出力を流し、`onInput`・`onResize` を受けます。入力は `status: "running"` の間だけ送り、`exited` になると下端に状態と「再起動」（`onRestart`）を出します。配色は `--stage-background` と `--primary` から作り、テーマ切替に追従します。WebGL が使えない環境では DOM 描画に戻ります。
