# OpenUI Artifact

Artifact の上部は DesignSystem の `workspace` タブを使う。上部タブの周囲は余白0、直下の内容欄だけに Tailwind `p-2` 相当の全周余白を付ける。配色と寸法は DesignSystem のテーマ・トークン定義を共有する。

会話と Artifact の境界は `ResizableWorkspace` で調整する。幅900px超では左右の幅、それ以下では上下の高さを、マウス・タッチのドラッグまたは境界にフォーカスして矢印キーで変更できる。Shift + 矢印で大きく変更し、Home / End は25% / 75%、Enter またはダブルクリックは半分へ戻す。両欄の比率は25〜75%に制限し、狭い画面では各欄をスクロールして操作する。左右・上下の比率を画面を開いている間は個別に保持し、タブの開閉やリサイズで会話・フォームの下書きを消さない。最後の Artifact を閉じると境界が消え、会話が全幅へ戻る。

共通クラスの結合では `text-ui` を文字サイズとして扱い、`text-primary-foreground` などの文字色を消さない。フォーム部品の初期の文字色は base layer に置き、部品の配色を上書きしない。

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

| view | 例の source | 実装した操作 |
| --- | --- | --- |
| components | c1 | 入力・送信、受け取った内容の表示、無効状態 |
| generated-image | g1 | queued / running / succeeded / failed / cancelled、読込失敗、全画面、ダウンロード |
| question | q1 | 選択 / 自由回答、受付後の操作停止、期限切れ |
| form | f1 | 必須 / 選択 / 真偽 / テキスト入力、送信、リセット、エラーと再試行 |
| memory | m1 | 内容の訂正、会話へ渡す情報の選択 |
| settings | s1 | テーマ、読み上げ、音量の編集 |
| timer-workspace | timer-setup / timer-保存ID | 時計の切替ボタン、開始前後で固定した時計・時間設定、右端の縦プリセット、保存確認後の計測・停止・同じIDの再開・新規設定、ストップウォッチ開始・停止・再開・リセット |

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

SDK は `0.3.0` を固定した。導入時の最新 `0.3.2` はプロジェクトの公開後7日ルールに達していなかったため、ルールを維持して選択した。SDK の開発用 Inspect の自動起動は `sdk-devtools.ts` で抑止する。0.3.0 の自動起動フラグを使い、歓迎表示が Escape を先取りしてアーティファクトの拡大表示を閉じられなくする問題を防ぐ。SDK 更新時はこの挙動と Escape のブラウザ試験を再確認する。Renderer の observability 発行は無効化している。

SDK は必要になった時に読み込む。

開発サーバーでは OpenUI SDK を起動時の dependency optimization に含める。初めて Artifact を開いた時に optimizer が走り、既存タブの依存URLが `504 Outdated Optimize Dep` になる経路を避ける。遅延 import と描画の例外はパネル内の boundary で受け、会話を残して再読み込みの案内を表示する。

## ホストとの契約

`ArtifactRenderer` に検証済み Lang と `ArtifactRuntime` を渡す。runtime は読み取り用 `snapshot` と操作の `dispatch(event)` を提供する。操作には `id / source / revision / action / values` があり、ホストは accepted / duplicate / conflict / rejected の receipt を返す。

Lang は登録部品へのリテラル JSON 呼び出しだけを受け付ける。追加文、リアクティブ状態、Query / Mutation、未知の部品は拒否する。登録済みのCompositionは、JSON内の検証済みchildrenを並べる。SDK に toolProvider は渡さない。ユーザーが入力した文字列は React のテキストとして描画する。

## 次の機能を追加する順序

1. `viewRegistry` に小さな用途別 schema と部品名を追加する。
2. DesignSystem を組み合わせた表示部品を `library.tsx` に登録する。通常の状態や操作をここへ閉じ込める。
3. ホストに読み取り用 source と、許可された操作だけを持つアダプターを実装する。
4. fixture とコンパイル試験、操作試験、Artifact 内での E2E を追加する。
5. 本番接続時に capabilities / tool-runtime / tasks / 各業務 domain の公開操作へつなぐ。

SystemContext には表示の利用場所、短い JSON の原則、権限と完了条件を置く。利用可能な view と source は実行時の候補として必要な分だけ渡す。SDK 全部品の仕様やメモリー内容を常時 SystemContext に埋め込まない。サブエージェントが提案した定義も同じホスト検証を通し、source の参照権限を継承したと扱わない。

## 実装範囲

LLM の UI ツール、質問台帳、LARM の実画像生成、永続化、Memory / WorldModel の閲覧・注入・訂正を公開 API へ接続する部分は P2 以降。

その時点でも Web が DB を開かず、ホストの公開操作と版付き receipt を使う。WorldModel への注入には対象と出所の契約を追加し、メモリーの選択操作を実際の永続注入と同一視しない。

試験と画面キャプチャは [検証記録](../spec/verification/openui-artifact/README.md) を参照。

## 表示の基本

- アプリの基本文字設定は CSS の base layer に置き、共通部品の選択状態や文字サイズを上書きしない。
- タイマー通知は会話欄の子要素に置く。分割画面の直下へ3つ目の要素を追加して、アーティファクトを次の行へ押し出さない。

## 音楽と生成状態の組合せ（2026-10-11）

DesignSystemのMusicPlayer・Playlist・GenerationStatusをOpenUIに登録した。既存の単一view形式を維持し、次のJSONで他の登録済みviewと組み合わせる。layoutはstack/grid、childrenは1〜12個の登録済みviewまたは子layout。入れ子はrootを含めて深さ4まで、1定義のview数は60まで。layoutは任意の `gap`（compact/normal/relaxed）と `width`（narrow/normal/wide）、text-blockは任意の `emphasis`（normal/strong/muted）を持てる。任意URL・関数・未知のpropsは受け付けない。

```json
{
  "view": "layout",
  "direction": "grid",
  "title": "楽曲とプレイリスト",
  "children": [
    { "view": "generation-status", "source": "generation-saved-a" },
    { "view": "music-player", "source": "music-saved-a" },
    { "view": "playlist", "source": "music-saved-a" }
  ]
}
```

music-playerとplaylistはkind=musicのsourceを共有する。generation-statusはkind=generationを参照する。各sourceはホストの許可済みsnapshotに存在する必要があり、JSONを作っただけでは取得権限を得ない。Compositionも実際のOpenUI parser/Rendererを通り、子は登録済み表示へ接続する。

Artifactのタブはkind=openuiとdefinition（JSON文字列）を保持する。専用のkind=musicとrenderMusicは廃止。MusicArtifactは表示実装ではなく、認証済みmusicList/audioからruntimeを組み立てるホストになった。表示はArtifactRendererへdefinitionとruntimeを渡す。音声・Blob URL・関数は保存JSONに含めない。現行のタブ保持はインメモリーであり、再読込時は楽曲一覧から構成を作る。新たな永続化DBは追加していない。

ホストは表示のsourceを許可済み会話の楽曲一覧と照合し、選択した完了曲だけ音声を取得する。選曲イベントはsource・revision・曲IDと再生可否を検査する。取得中の取消とURLの解放を行い、前の楽曲の取得結果を新しい選択へ採用しない。再生・一時停止・シーク・10秒移動はプレイヤー内、選曲はホスト状態。曲変更で新しい音声を取得した後は再生ボタンで開始する。

生成状態は同じJSONのままsource更新で反映する。音声取得まで待機表示、取得後はプレイヤーとPlaylistを表示する。実測進捗だけを表示し、音楽APIに取消・再試行の接続がないこの画面では、それらのボタンを公開しない。汎用generation sourceはホストがcanCancel/canRetryを許可した場合だけdispatchへ接続できる。

部分・結合確認と保存済みMP3によるブラウザ確認は [検証記録](../spec/verification/music-openui-2026-10-11/README.md) を参照する。曲切替の2曲目は同じ保存済み音声を使う試験用メタデータであり、別の楽曲を生成したものではない。

## 本番の設定フォーム

`settings-navigation`から会話・音声と入力・表示を開く。各`settings-section`内の保存ボタン、または`settings-changes`から共同下書きを適用する。試用専用の`settings` viewとは保存契約が異なる。sourceはsettings所有ホストが組み立て、秘密・物理保存先・任意APIを渡さない。

SettingsSectionはtext/select/toggle/range/number/multiple、区分、詳細欄、検索可能な候補、許可操作に対応する。イベント値は既存string契約のまま、数値・真偽値・配列は文字列表現を所有bindingで変換し、既存Zod schemaを検証する。複数選択はJSON配列文字列。表現部品で型を確定したとみなさず、範囲・許可候補・source・revisionをホストで再確認する。

音声と入力の登録sourceは`settings-voice-input`。TTS能力は認証済みlarmVoices API、試聴は既存voiceSample APIを使う。クラウドTTSの任意カタログAPIは未対応で、現行OpenAI互換adapterの音声IDと速度を扱う。試聴・機器確認は`settings-action`の許可IDで実行し、閉鎖・対象変更時に取消と解放を行う。声の編集対象の選択は用途割当を変更しない。

表示は次の登録viewをJSONで組み合わせる。`settings-display`は5項目の編集・共通保存、`settings-display-preview`はkind=`subtitle-preview`の読み取り専用source。プレビュー単体でも同じsettingsホストへ接続でき、操作イベントは受け付けない。新しいArtifact種別や専用renderは追加しない。

```json
{"view":"layout","direction":"stack","title":"表示の設定","children":[{"view":"settings-section","source":"settings-display","title":"表示"},{"view":"subtitle-preview","source":"settings-display-preview"}]}
```

DesignSystemに`Subtitle`と`SubtitlePreview`を追加し、既存の字幕描画・CSSを共有した。API・認証は持たず、text/style/size/enabledをpropsで受ける。`subtitle-preview`をOpenUIへ登録し、通常のparser・Rendererを通す。会話の読み上げ字幕と旧表示フォームも同じ`Subtitle`を使い、既存4デザイン・3サイズを維持する。

「記録」は`RecordsWorkspace`をDesignSystemに追加し、`records-workspace`として登録した。表の検索・ソート・ページ、選んだ1行の詳細、既存Tabsでの切替、取得手順の折りたたみと操作、共通の診断データ保存をprops/eventsで受ける。APIや認証は持たない。定義は`{"view":"records-workspace","source":"settings-records","title":"記録"}`で、他の登録viewとlayoutで合成できる。Webのsettingsホストが利用記録・ツールチェーン・診断の既存公開APIを解決し、source、revision、操作、取得済みの手順IDを検証する。表示JSONには記録本文、秘密、取得状態やBlob URLを保存しない。記録画面を閉じた後の診断ダウンロードは破棄し、Blob URLは解放する。新しいArtifact種別・専用renderは追加していない。
記録の主一覧3種はDesignSystemの`ServerDataTable`を使う。TanStack Table v8.21.3の`manualSorting`・`manualFiltering`・`manualPagination`とCore row modelだけを使用し、クライアントで再ソート・再検索・ページ切出しをしない。APIの`total`をrowCountへ渡し、`records-query`で許可された表ID、ページ、表示件数、列ID、方向、検索文字列を送る。ホストは既存clientが公開する所有domainのschemaで検証してからquery keyを更新する。検索条件ごとのHTTP取消と別cache keyで古い検索結果を現在の表へ採用しない。初期10件、25／50件へ変更でき、詳細は選択した1行だけを描画する。選択記録の候補比較はその詳細内の読み取り専用表を維持する。[TanStackのページング仕様](https://tanstack.com/table/v8/docs/guide/pagination)と[ソート仕様](https://tanstack.com/table/v8/docs/guide/sorting)に従う。


## 画像制作と一覧（2026-10-13）

承認済みの制作・一覧デザインをDesignSystemで実装し、OpenUIへ登録した。`image-workspace` は小さな上部プレビュー・下部フォームの制作画面と、同じアーティファクト枠内で切り替える一覧を持つ。`presentation` は省略時embedded、通常の画像スタジオもembeddedを指定する。枠の幅に合わせて一覧の列数を調整し、フォームは枠内でスクロールする。FullscreenDialogは表示と操作だけを持ち、認証・取得・生成ジョブは扱わない。

```json
{"view":"image-workspace","source":"image-studio","presentation":"embedded"}
```

`image-creation-form`、`image-preview`、`image-gallery`は個別登録も行い、同一のimage-workspace sourceから描画できる。

```json
{"view":"layout","direction":"grid","children":[{"view":"image-preview","source":"image-studio"},{"view":"image-creation-form","source":"image-studio"}]}
```

選択内容の文章化は利用者が明示したフォーム値の直列化であり、テーマの意味解釈は既存の画像担当に渡す。手編集後の選択変更では自動上書きを止め、反映・編集継続・復元の操作を提供する。sourceの更新や制作・一覧の切り替えで草稿を破棄しない。画像URLは許可済みsnapshotで供給し、表示JSONに保持しない。生成、取消、選択、更新、閉じるのイベントはホストがsource・revision・重複・利用可否を検証する。

`drawing-workspace`はDesignSystemのDrawingWorkspaceを使う。snapshotの保存済み図の参照、起動状態、実行時URLと`drawing-new`/`drawing-open`/`drawing-refresh`を接続し、他の登録済みviewとlayoutで並べられる。表示JSONにはscene・credential・実行時URLを埋め込まない。URLからの編集画面もEumenesの認証済みAPIを使い、保存未確定の下書きを保護する。手順は[Excalidraw連携](excalidraw.md)を参照する。

## UI自由制作

UI自由制作は専門担当との対話で作る（[計画](../spec/toolchain-specialist-dialogue-implementation-plan-2026-10-17.md)）。制作画面は `{"view":"ui-studio","source":"ui-studio","title":"UI自由制作"}` で、プレビューを主にし、元に戻す・やり直す・保存・破棄・会話に戻る・作品履歴・デスクトップ／モバイル切替を持つ。生成できる定義は layout（入れ子可。direction は stack・grid・tabs・slides）と、[`compositionViews`](../packages/artifact-ui/src/composition-contracts.ts) に挙げた部品に限る。text-block、info-card、inline `fields` の form（1定義に1つ）に加え、[表現力拡張の計画](../spec/ui-studio-expressive-parts-implementation-plan-2026-10-17.md)の部品を使える。見せる部品（hero・商品カード・料金表など）、テーマ別のpicsum画像、一番外側の layout の `model`（状態と式）、入力と出力、数式・電卓、図解とステップである。式は自前の式言語で評価し、コードとしては実行しない。backend は保存と下書き反映のときに `validateComposition` で配置・参照・型を検証する。保存は保存ボタンだけで行い、編集中のフォームは試用として回答を記録しない。主表示は「プレビュー／ソース」で切り替えられ、ソースは表示中の採用済み定義JSONを読取専用で示す。履歴から保存作品を開いている間は「新規作成」で編集中の案または空の状態へ戻れる。
