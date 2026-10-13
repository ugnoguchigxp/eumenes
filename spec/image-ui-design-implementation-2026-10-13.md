# 画像UI・承認デザインの実装

目的: creation-v2 / gallery-v2の画像に合わせ、音楽と同じ選択式プロンプト作成、手編集保護、左プレビュー／右フォーム、全画面を切り替える画像一覧をOpenUIで実装する。
範囲: DesignSystemのImageCreationForm・ImagePreview・ImageGallery・FullscreenDialog、既存ImageWorkspace、OpenUI登録と構成JSON、画像hostと画面入口、試験・文書。画像生成・保存・認証・migration・音楽機能は既存経路を維持し、別作業の差分を保持する。
再利用: 音楽のUI選択→明示的な文字列組立て、手編集後の反映確認と復元。Checkbox/Input/Button、GenerationStatus、ImageViewer、Radix Dialog、OpenUI parser/Renderer、認証済み画像sourceとdispatch。
選択の文字列化は利用者が明示したフォーム値の直列化であり、発話・題材を意味分類しない。プロンプトから画像生成API引数を作る判断は既存担当が行う。
UI接続: image-workspaceにpresentation=fullscreenを追加。image-creation-form / image-preview / image-galleryを同一sourceで個別登録し、JSON合成でも利用できるようにする。全画面表示はDSのDialogでfocusとEscape・戻り操作を管理し、生成・取消・一覧・閉じるはhostイベントで扱う。
依存順: 1 DS部品・契約 2 OpenUI登録 3 host・入口 4 部分試験 5 JSON/host結合・ブラウザ 6 所有・利用側verify・verify:all 7 差分点検。
完了条件: 選択→文章組立て→手編集保護→生成、プレビューの拡大・取得、全画面一覧と戻り、並び替え・更新、暗／明／狭幅、エラー・取消、source/操作の拒否、JSON合成を確認。表示変更は保存済み画像またはfixtureで確認し、live生成は再実行しない。
着手時の残作業: 実装、部分→結合→全体の検証、デザイン画像との画面比較、最終記録。


実装経過:
- DesignSystemにImageCreationForm・ImagePreview・ImageGallery・FullscreenDialogを新設し、ImageWorkspaceを制作／一覧の全体切り替えに変更。画像sourceにはloadingとclose操作を接続し、既存の表示JSONには互換性を保つ。
- プロンプトは明示的な選択だけを組み立てる。手編集後の変更を保護し、置換・保持・元文章へ戻す操作を実装。JSON化した実際の依頼長を8000文字枠で検査し、長い引用・改行を含むプロンプトも受付前に拒否する。
- 個別view3種とworkspaceを同じsourceでOpenUIへ登録。未知の表示設定・sourceの種類違い・許可されない操作を拒否する試験を追加。
- 4列一覧を実LARMの保存画像12枚で確認。新規生成0回。一覧の実データの正本はLARM、計画担当はfixtureと明示してUI受入を行う。
- ブラウザで構図／光のlabelがoption文字列を含む問題を特定し、短い明示labelを設定。全画面内の拡大Dialogは既存Modalより下のlayerに親を配置し、最前面表示を実座標で確認する。
- 長い画面操作試験の終端で再読込確認の時間枠が尽きたため、再読込・再表示は独立して画像を生成するfixture試験に分離。期待する表示・草稿・取得・狭幅・閉じるの条件は保持する。
- フォーム関数の300行budgetを満たすため、数値設定の表示だけを内部のImageParametersへ分割。全体的な抽象化や音楽側への改修は加えない。

確認結果（2026-10-13）:
- DesignSystem部分試験: 11成功。選択式文章、手編集保護、反映・復元、リセット、草稿保持、全画面切り替え、並び替え・取得・拡大、取消、画像GET失敗後の再読込を確認。
- Storybook: 制作フォーム・全画面制作・一覧・生成中・失敗の5 storyを表示し、画面を目視確認。ページ例外0件。
- JSON/host結合: web画像の6成功、artifact domainの49成功。個別view合成・許可source・不正表示設定の拒否・閉じる操作・実際のJSON枠を含む容量超過を確認。
- backend結合: image/musicの15成功。生成・失敗・不正計画・studio/library・取得失敗・取消後の結果不採用・権限失効を確認。モデルと画像APIはfixture。
- ブラウザfixture: 2成功。手編集保護と全画面移動・元の草稿保持・PNG 121×177の生成結果デコード・ダウンロード・重ねた拡大画面の最前面表示・明色/狭幅・閉じる・再読込後の表示を確認。
- 保存画像UI: 実LARMの読取だけを使用し、12画像を表示。最初の画像は512×384、一覧/メタ/画像取得HTTP200、ダウンロード・暗色/狭幅・画面移動を確認。LARM生成POST 0。実モデルの意味判断や新規生成をこのUI検証の合格に含めない。
- 所有/利用側gate: image、artifact成功。入力hashと各結果は下記の固定記録。
- root型検査: 1,202 files成功。DesignSystem製品buildとWeb build成功。size budget17 files成功、diff空白検査成功。
- DesignSystem全型検査: 画像UI試験のgetByRoleに誤ってexactを指定していた7箇所を削除（name文字列は既定で完全一致）。再検査では画像UIのエラー0、担当外TimerWorkspace.test.tsx:22/125の同種2エラーで停止。タイマーは変更していない。
- verify:all: 担当外web/src/domains/settings/MemoryItemsPanel.test.tsxのsettings→memory依存境界違反で初期gate停止。後続の全件試験は未実行。同じ失敗の再試行、期待値の変更、担当外の修正は行っていない。

差分点検: 作業前snapshotとの比較で共有ファイルの変更を画像view登録・表示設定・close接続へ限定したことを確認。既存のrecords/settings/memory等の差分を保持。題材に応じた条件分岐や発話の分類は追加していない。フォームの選択値は明示入力の直列化、画像APIの計画・担当選択は既存LLM機構を維持。実DB・credentialのコピーは行っていない。

状態: 承認デザインのUI実装済み、部分・結合・ブラウザfixture・実保存画像表示の確認済み。残作業は全体gateの担当外エラー解消後の全件検証。変更範囲の実装・受入項目は完了、全体検証の成功とは区別する。
続行条件: 設定/メモリの依存境界、およびタイマー試験の型エラーを担当作業で解消した状態で全体gateを実行する。

固定記録: [verification/image-ui-2026-10-13](verification/image-ui-2026-10-13/README.md)。暗/明/狭幅の画面とgate結果を保存。docs/images.mdとOpenUI showcaseに入口・JSON構成・確認方法を記述。
Context Still: 今回context_compile 1 / compile_eval 1、会話累計各2。initial_instructionsは会話開始時の1回のみ。


追加変更: 制作/一覧の相互切り替え（2026-10-13）
目的・範囲: 一覧の左側「戻る」ボタンを削除し、制作/一覧で上部右側の同じ位置に「画像一覧」/「画像生成」を表示する。既存DS ImageWorkspaceのlocal view stateとOpenUI構成・草稿保持を再利用。API・生成・削除・保存契約は変更しない。
変更順・完了条件: DSのheaderを共通の切替ボタンへ更新、既存試験/読取確認スクリプト/文書のlabelを更新、部品→OpenUI→ブラウザの既存制作切替経路とbuildを確認、差分と結果を追記。画面間移動でプロンプトを保持し、一覧では上部右側の「画像生成」が使えること。
確認: DS14件、画像host/OpenUI9件とimage gate成功。製品DS/Web build成功。ブラウザの既存制作・相互切り替え・草稿保持・狭幅・拡大/取得経路1件成功、一覧のタイトル左/「画像生成」右を暗黙の戻り操作と分けて目視確認。初回はブラウザと共通部品buildを重ねた状態でvisible後のboundingBoxがnullとなった。試験期待値は変えず、全build完了後に1回再確認して成功した。並行buildでの再描画が原因候補であり、別の製品修正はしていない。
全体gate: 既存settings→memory依存境界で初期停止、後続未実行。担当外を変更せず記録。API/LLM/削除を変えない表示変更のため、実LARM生成/削除は追加しない。
差分点検: headerの一つの切り替えボタンと既存label更新に限定し、意味判断の追加なし。変更範囲の実装・画面確認完了、全件gateの既存障害は前述の継続条件を維持。
証拠: [一覧の最新画面](verification/image-switch-2026-10-13/gallery-light.png)、[狭幅](verification/image-switch-2026-10-13/gallery-mobile.png)、[image gate](verification/image-switch-2026-10-13/verify-image.json)、[全体gate](verification/image-switch-2026-10-13/verify-all.json)、[ブラウザ](verification/image-switch-2026-10-13/browser.log)。
Context Still: 今回compile/eval各1、会話累計各4。
