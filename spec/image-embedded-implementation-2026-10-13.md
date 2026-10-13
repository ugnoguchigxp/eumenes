# 画像UIを通常のアーティファクト内へ

目的・範囲: 画像生成と一覧を通常のArtifactPanelに収め、上部の相互切替・削除・手編集保持を維持する。previewの表示を小さくし、狭幅とリサイズに対応する。
再利用: OpenUI image-workspaceの既存embedded presentation、共通ArtifactPanel/ResizableWorkspace、音楽Artifactの高さ伝播CSS、DS ImageWorkspace・ImagePreview・フォーム・一覧。意味判断は追加しない。
非目標: API・生成画像の実寸・モデル指示・生成/削除契約・DB・他機能。全画面DS部品自体は再利用用として保持し、製品画像の入口はembeddedを使用する。
変更順: 1 製品定義をembedded 2 共通枠の既存高さ機構に画像を追加 3 DS埋込時の単列・小さいpreviewと一覧画像 4 既存browser/読取UI/文書更新 5 部品→OpenUI→ブラウザ→所有利用側gate/build→差分。
完了条件: 会話と画像Artifactを同時表示し、UIが枠を越えない。previewを小さくし、必要な部分を枠内でスクロール。狭幅/枠のresize、画面切替と草稿、生成・取得・拡大・削除・閉じるは枠内から使用できる。
検証: DS既存部品、web画像/OpenUI、既存画像browser3件を枠内の期待に更新、image/artifact gate、製品build後にbrowserを実行、verify:all。liveは保存画像の読取UIだけで、新規実生成・実削除をしない。担当外の既存gateエラーは変更しない。
着手時の残作業: 実装・回帰期待・文書を揃え、段階別の検証と画面比較、結果記録。

実装済み・試験前: 製品のOpenUI定義をembeddedへ変更。音楽に使っていたArtifactPanelからRendererへ高さを伝えるCSSに画像も加え、body内のスクロールをDSに委ねた。DSの埋込時は単列、previewは160px以内（狭幅128px）、画像の実寸は不変。一覧のthumbnail表示高を160px以内にし、既存container列数を維持。既存browserはDialogではなくArtifactPanelの境界、modal非表示、リサイズと草稿保持、同じ取得データの実寸、タブcloseを確認する期待へ更新。拡大・削除確認だけは既存Modalを使用する。読取UI確認と製品文書も枠内表示へ更新。


確認結果:
- DS画像/全画面の部分試験14成功。既存の選択・手編集・草稿・表示切替・削除確認を保持。FullscreenDialogは再利用用の任意部品として試験を維持。
- web画像/OpenUI/Artifactの結合58成功。登録labelも枠内表示に合わせ「画像制作と一覧」に更新し、artifact gate49件を再確認して成功。
- browser fixture3成功。viewport全体のDialogを開かず、ArtifactPanelの境界内に画像UIを表示。preview表示幅160px以内と、取得PNGの実寸121×177を同時に確認。枠を25%へ縮めても横溢れなし、戻しても草稿保持、狭幅で会話/Artifactの両方を表示。拡大だけはModal、タブから閉じる。生成・再表示・削除の成功/失敗/再操作も通過。
- 保存画像UI: 実LARM保存画像12枚を読取、表示・取得・狭幅・制作/一覧を確認。preview縮小、一列フォーム、desktop一覧2列、会話との並列を画面比較した。実生成POST0、実削除0。計画モデルはfixture。
- Storybook: 720×720のArtifactPanel storyとその一覧を表示し、境界内に収まることとpage例外0を確認。
- imageとartifactのverify、root型1,205 files、製品DS/Web build成功。登録label更新後に型とWeb buildを再実行し、最終結果も成功。差分の空白検査成功。
- verify:allは既存settings→memoryの境界違反（MemoryItemsPanel.test.tsx）で初期停止。後続gate未実行。同じ失敗の繰り返しや担当外修正は行っていない。実LLMの新規生成・実画像の削除・backend結合の再実行は、API/LLM/保存契約を変えていないため省略した。

差分点検: 製品はOpenUIの既存embeddedモードを使い、APIや保存画像の寸法を変えない。共通app.cssは音楽の既存高さ条件を同値に維持し、画像を条件へ追加しただけ（formatterによる既存空行1行の整理を含む）。画像DSで埋込時だけpreviewとフォームの表示を変更。LLMの意味判断に代わる分類・個別題材の分岐はない。既存他作業の変更は保持した。
状態: アーティファクト枠内UI実装済み、部分/結合/browser/実保存画像表示を確認済み。残作業は既存settings境界解消後の全体gate。今回の表示要求の実装・画面確認は完了し、全体gate成功とは区別する。
証拠: [確認記録](verification/image-embedded-2026-10-13/README.md)。
Context Still: 今回context_compile/compile_eval各1、会話累計各5。initial_instructionsは初回の1回のみ。
