# OpenUI Artifact Showcase

P0/P1 を実装済み。会話の上部にある「UIショーケース」から開く。描画は既存 ArtifactPanel の中に固定し、Markdown とタイマーのタブを保つ。Showcase のタブを切り替えても下書きと試用状態を保ち、閉じると破棄する。

Artifact の上部は DesignSystem の `workspace` タブ、サンプル切替は `line` タブを使う。上部タブの周囲は余白0、直下の内容欄だけに Tailwind `p-2` 相当の全周余白を付ける。定義編集と試用状態の操作は初期表示で折りたたみ、プレビューを優先する。配色と寸法は DesignSystem のテーマ・トークン定義を共有する。

会話と Artifact の境界は `ResizableWorkspace` で調整する。幅900px超では左右の幅、それ以下では上下の高さを、マウス・タッチのドラッグまたは境界にフォーカスして矢印キーで変更できる。Shift + 矢印で大きく変更し、Home / End は25% / 75%、Enter またはダブルクリックは半分へ戻す。両欄の比率は25〜75%に制限し、狭い画面では各欄をスクロールして操作する。左右・上下の比率を画面を開いている間は個別に保持し、タブの開閉やリサイズで会話・フォームの下書きを消さない。最後の Artifact を閉じると境界が消え、会話が全幅へ戻る。

## デザイントークンの試用

表示テーマ・幅・密度と同じ操作欄に、角の丸みとタッチ操作を置く。テーマは全11種類、密度はコンパクト・標準・ゆったりの3段階、丸みは Storybook と同じ0 / 0.3 / 0.5 / 0.75 / 1rem。タッチ操作は44px以上の操作部品と文字・余白のプリセットを試せる。幅はトークンではなく、表示領域の確認用。

「デザイントークンを個別に試す」を開くと、色・余白・文字・部品の大きさを含む全64基礎トークンを編集できる。種類の切り替えと日本語名・CSS名の検索を用意し、初期表示は丸みだけを見せる。新規トークンは CSS の宣言から一覧へ取り込み、Tailwind の色・寸法・丸みの派生トークンも同じスコープで再計算する。色と丸みは小さな見本でも確認できる。部品固有の寸法は、そのトークンを使う部品に反映する。

値は入力直後にプレビューへ反映する。寸法は0以上の px / rem / em、色はブラウザが解釈できる色値を受け付け、入力途中や不正な値はエラーを示して最後の有効値を保持する。個別変更はテーマ・密度・タッチのプリセットより優先する。各項目の「戻す」で個別変更を解除し、「デザイントークンを初期化」で配色をショーケース開始時のテーマ、密度を標準、丸みを0.5rem、タッチを通常へ戻す。

設定はプレビューにだけ適用し、サンプル切替や「このサンプルを初期化」でも保持する。サンプル選択タブ、操作欄、アプリ本体の設定は変えない。「表示と音声」もホストの全トークンを継承し、内部のライト・ダーク設定で配色を上書きしない。保存用の既存試用契約は light / dark の明暗を保持し、11種類の配色や個別トークンを製品設定として保存しない。

共通クラスの結合では `text-ui` を文字サイズとして扱い、`text-primary-foreground` などの文字色を消さない。フォーム部品の初期の文字色は base layer に置き、部品の配色を上書きしない。

正本は `packages/design-system/src/styles/variables.css` / `themes.css` / `index.css`。`web/src/domains/artifact/designTokens.ts` で宣言とプリセットを読み、`DesignTokenEditor.tsx` で編集する。Vitest ではデータとして読む `?raw` CSS を空のスタイルモックに置き換えない。

## 短い定義からの描画

LLM が指定する定義の例は40 bytes。額縁、待機表示、拡大、ダウンロード、失敗状態はコンポーネントに実装してある。

```json
{"view":"generated-image","source":"g1"}
```

ホストは定義を検証し、次の OpenUI Lang に変換する。実際の `@openuidev/react-lang` の parser と Renderer を使う。

```text
root = GeneratedImage({"view":"generated-image","source":"g1"})
```

`g1` の完了状態を更新すると placeholder が画像へ変わる。元の JSON や Lang を作り直す必要はない。フォームは参照データの更新で入力を失わない。

| view | 試用 source | 実装した操作 |
| --- | --- | --- |
| components | c1 | 入力・送信、受け取った内容の表示、無効状態 |
| generated-image | g1 | queued / running / succeeded / failed / cancelled、読込失敗、全画面、ダウンロード |
| question | q1 | 選択 / 自由回答、受付後の操作停止、期限切れ |
| form | f1 | 必須 / 選択 / 真偽 / テキスト入力、送信、リセット、エラーと再試行 |
| memory | m1 | 内容の訂正、会話へ渡す情報の選択 |
| settings | s1 | テーマ、読み上げ、音量の編集 |

`title` は省略可能。質問は `source` の代わりに短い `question` を指定できる。

```json
{"view":"question","question":{"prompt":"回答の長さは？","options":["短く","詳しく"]}}
```

小さなフォームは `source` の代わりに最大8項目の `fields` を指定できる。text / textarea / number / select / boolean を使用し、select には options が必要。項目の重複 ID は拒否する。これは質問用のフォームであり、保存先や実行ツールを JSON に指定する仕組みではない。

## 所有する場所

- `packages/artifact-ui/src/contracts.ts`: view 登録、用途別 Zod schema、参照データと操作 receipt の型。React を読み込まない契約エントリは `@eumenes/artifact-ui/contracts`。
- `compiler.ts`: 16KB 制限、未知の項目拒否、source と用途の照合、エスケープ、SDK parser による検証。
- `library.tsx` / `components.tsx`: 登録部品と既存 DesignSystem をつなぐ。Tailwind v4 の生成済み CSS と部品を再利用する。
- `index.tsx`: Artifact の共通 Renderer。定義と source を再検査し、描画エラーを Artifact 内に隔離する。
- `web/src/domains/artifact/showcaseFixture.ts`: 試用データ、非同期完了、版照合、重複操作防止、取消後の結果拒否。
- `web/src/components/domains/artifact/ArtifactShowcase.tsx`: サンプル、JSON / Lang 編集、テーマ・幅・密度、操作イベント。

SDK は `0.3.0` を固定した。導入時の最新 `0.3.2` はプロジェクトの公開後7日ルールに達していなかったため、ルールを維持して選択した。SDK の開発用 Inspect の自動起動は `sdk-devtools.ts` で抑止する。0.3.0 の自動起動フラグを使い、歓迎表示が Escape を先取りしてアーティファクトの拡大表示を閉じられなくする問題を防ぐ。SDK 更新時はこの挙動と Escape のブラウザ試験を再確認する。Renderer の observability 発行は無効化している。

Showcase と SDK は必要になった時に読み込む。既存の会話開始時に Showcase を描画しない。

開発サーバーでは OpenUI SDK を起動時の dependency optimization に含める。初めてショーケースを開いた時に optimizer が走り、既存タブの依存URLが `504 Outdated Optimize Dep` になる経路を避ける。遅延 import と描画の例外はパネル内の boundary で受け、会話を残して再読み込みの案内を表示する。

## ホストとの契約

`ArtifactRenderer` に検証済み Lang と `ArtifactRuntime` を渡す。runtime は読み取り用 `snapshot` と操作の `dispatch(event)` を提供する。操作には `id / source / revision / action / values` があり、ホストは accepted / duplicate / conflict / rejected の receipt を返す。

試用アダプターも操作前に source の種別と現在の版、質問の期限、入力を検査する。処理待ち中の同じ ID を予約し、二重受付を防ぐ。画像生成の世代を別に管理し、取消や初期化の前の完了を採用しない。

Lang の編集モードも登録部品へのリテラル JSON 呼び出しだけを受け付ける。追加文、リアクティブ状態、Query / Mutation、未知の部品は拒否する。SDK に toolProvider は渡さない。ユーザーが入力した文字列は React のテキストとして描画する。

## 次の機能を追加する順序

1. `viewRegistry` に小さな用途別 schema と部品名を追加する。
2. DesignSystem を組み合わせた表示部品を `library.tsx` に登録する。通常の状態や操作をここへ閉じ込める。
3. ホストに読み取り用 source と、許可された操作だけを持つアダプターを実装する。
4. fixture とコンパイル試験、操作試験、Artifact 内での E2E を追加する。
5. 本番接続時に capabilities / tool-runtime / tasks / 各業務 domain の公開操作へつなぐ。

SystemContext には表示の利用場所、短い JSON の原則、権限と完了条件を置く。利用可能な view と source は実行時の候補として必要な分だけ渡す。SDK 全部品の仕様やメモリー内容を常時 SystemContext に埋め込まない。サブエージェントが提案した定義も同じホスト検証を通し、source の参照権限を継承したと扱わない。

## 実装範囲

今回の Memory と設定はインメモリーの試用データであり、製品の正本へ保存しない。LLM の UI ツール、質問台帳、LARM の実画像生成、永続化、Memory / WorldModel の閲覧・注入・訂正を公開 API へ接続する部分は P2 以降。

その時点でも Web が DB を開かず、ホストの公開操作と版付き receipt を使う。WorldModel への注入には対象と出所の契約を追加し、メモリーの選択操作を実際の永続注入と同一視しない。

試験と画面キャプチャは [検証記録](../spec/verification/openui-artifact/README.md) を参照。

## 表示と操作の見直し（2026-10-10）

- サンプルのタブは全幅へ均等に収める。長い名称は CSS の ellipsis で省略し、全文の title と accessible name を残す。横スクロールは使わない。選択中は背景・文字色・太字・下線で区別する。
- 初期表示は、試せることの説明と操作可能なプレビューを優先する。装飾用の技術名バッジや空の Grid 見本を取り除く。
- 入力の受取内容、フォームで前回受け取った内容、情報の訂正・選択結果、設定の現在値はプレビュー内に表示する。試用設定の保存は、製品の表示変更や音声再生を意味しない。
- 表示テーマは幅・密度と同じ共通操作行に置き、全サンプルに即時反映する。「表示と音声」内に重複したテーマ選択は置かず、ホストから受け取る `previewTheme` を配色と保存に使う。保存済みのテーマは現在のプレビュー配色と区別して表示する。サンプル初期化は幅・密度・プレビューテーマを変更しない。共通操作行のないホストではフォーム内のテーマ選択を使用できる。
- 「このサンプルを初期化」は表示中の source の結果・操作履歴・入力を初期化し、他のサンプルのデータは保持する。
- サンプル画像の生成開始・取消は通常の操作として表示する。画像の強制完成・失敗、回答形式・期限切れ、送信エラーなどは「開発用の確認 → 試用条件を変更」に配置し、表示中のサンプルに関係する操作だけを出す。
- 定義、参照データ、操作履歴、内部イベントは初期状態で折りたたむ。操作履歴は現在の source への送信のみを対象に、処理中・完了・失敗・再確認を日本語で示す。操作がない場合は説明を表示する。入力値は履歴へ複製しない。
- アプリの基本文字設定は CSS の base layer に置き、共通部品の選択状態や文字サイズを上書きしない。
- タイマー通知は会話欄の子要素に置く。分割画面の直下へ3つ目の要素を追加して、アーティファクトを次の行へ押し出さない。
