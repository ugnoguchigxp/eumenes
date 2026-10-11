# 音楽デスクトップUIの確認（2026-10-11）

実装済み。左は実音声のVisualizer（FFT／波形）と楽曲イメージの切替、曲名直前の保存済みお気に入りの星。右は曲名・長さ・詳細の8曲ずつの一覧。プレイヤーを音楽パネルの下端に固定し、残りを表示領域にした。詳細は既存Modalで表示し、閉じた後は開いたボタンへフォーカスを戻す。

共通のDesignSystem、ArtifactRenderer、音楽runtimeと登録済み操作を再利用した。`music-workspace`の追加は、単一audio要素と実音声の解析状態を共有するため。音声取得中の曲送りでは既存MusicPlayerの再生意図を保つ。意味判断・LLMの指示・生成API・DB・認証処理の変更はない。

## 部分・結合

- 部分：MusicWorkspace4、MusicPlayer8、Playlist2、MusicLibraryControls2の計16試験が成功。画像なし・支給画像・切替でのaudio維持・別曲の詳細・星の意図と正本追従・シーク・曲送り・解析非対応／再開失敗時の再生・選曲の取得待ちを確認。`parts.log`。
- 結合：MusicArtifact、LibraryArtifact、OpenUI composition、compilerの4ファイル42試験が成功。許可済みsource、URL制約、お気に入りAPI接続、検索・取得・削除・遅延応答を確認。`integration.log`。
- DesignSystemの型検査とbuildに成功。単体環境のcanvas非対応メッセージは実音声解析の成功とは区別し、以下のブラウザで補完した。

## 保存済み音声でのブラウザ確認

`bun scripts/music-ui-check.ts`はMP3で成功。`--audio spec/verification/music-opus-2026-10-11/track.opus`は最終描画修正後のOpusで成功（実測30.0065秒）。楽曲を再生成していない。固定ライブラリ12曲のメタデータは試験用コピーで、星の変更はメモリー上の試験サーバーだけに保存した。

確認した操作は再生／停止、シーク、10秒移動、前後曲、音声の実FFT／波形取得、同一audioのまま表示切替、星のオン／オフとページ再読込み、8曲ずつのページ切替、詳細で選曲しないこと、Escapeとフォーカス復帰。実AudioContextの終了を確認し、ページ例外は0。

1440×1000のデスクトップで左右表示、縦横スクロールなし、最下部のプレイヤーとパネル下端の差1px（外枠）を確認。1280×800でも左右表示。1440×480で上部をスクロールしてもプレイヤー全体を表示。390×844では上部を縦に並べ、重なり・横スクロールを避けてプレイヤーを維持した。最終試験でcanvasがstage内に収まり、曲名領域へはみ出さないことも確認。

証拠は`result.json`、`geometry.json`、`library-desktop-dark.png`、`library-narrow.png`。試験サーバーは音楽以外の通知APIを用意していないため通知の404が出る。音楽API・再生の失敗ではない。

## 回帰検証

- music：型・境界・format・lint・backend1試験・UI9試験が成功、6.140秒（`music-domain-first.log`）。最初の試行は試験成功後に担当外の入力変更を検出して失敗し、再実行した。最終canvas CSS調整後のmusic再実行は他の検証によるlockのため開始できなかった（`music-domain-last-attempt.log`）。
- artifact：最終描画CSSを含む入力で成功。型・境界・format・lint・UI7ファイル49試験、7.283秒。入力hashと全stepを`artifact-domain.json`、経過を`artifact-domain.log`に保存。
- `verify:all`：同じ作業場所の別の全体検証が実行中で、`Another verification is running`（exit3）により開始できなかった。`all-domain.log`。他の検証を止めたり、その結果を今回の成功として流用したりしていない。

全体検証は未完了。残作業は検証lock解放後に`bun run verify -- --domain music`と`bun run verify:all`を変更しない入力で実行すること。UI実装・対象部品／結合／ブラウザ確認は完了し、同じlock拒否を繰り返す追加試行は止めた。

## 差分点検・制約

製品コードに特定の曲名や発話語句への分岐を追加していない。固定の曲名はStorybook／試験のみ。既存の担当外の変更を保持した。現行の楽曲APIは画像・歌詞を返さないため、未登録／情報なしの表示を使う。画像をsourceで支給した場合は安全なURLだけを表示できる。

live生成とスピーカー／マイクの実機器受入は表示変更の範囲外なので未実行。固定試験やブラウザ結果をlive受入として扱わない。ContextStillは会話累計context_compile3回、compile_eval3回。
