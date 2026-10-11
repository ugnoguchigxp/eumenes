# MusicPlayer・Playlist・GenerationStatus

2026-10-11。DesignSystemへ追加。業務API、画像生成ツールチェーン、OpenUI登録、既存MusicArtifactの置換は今回の対象外。

## 追加した部品

- `MusicPlayer`: `track: MusicTrack | null`、任意の`onPrevious / onNext / onEnded`、`className`。trackは`id / title / src`と任意の`subtitle / durationSeconds / disabled`。srcはホストで認証済み取得したURLを渡す。部品内で業務APIを呼ばない。再生、一時停止、シーク、前後10秒、前後の曲、音量に対応。前後のcallbackがない端ではボタンを無効にする。実際のdurationをシークの上限とし、曲を変える際は古い音声を停止する。再生中の曲変更は再生を引き継ぐ。
- `Playlist`: `tracks / currentTrackId / onSelect`、任意の`title / className`。曲IDで選択を通知。プレイヤーと独立して配置できる。空一覧、無効な曲、選択状態に対応。
- `GenerationStatus`: `status / title`、任意の`description / progress / onCancel / cancelling / onRetry / className`。statusはpending、running、completed、failed、cancelled。音楽固有の文言・生成APIを持たない。進捗が不明なら割合を表示せず、実値が渡された場合だけバーを表示。取消待ちの二重操作を抑止。自動再試行しない。動きを減らす設定に対応。

各部品は `@eumenes/design-system` からexport。Storybookの `Components/MusicPlayer`、`Components/Playlist`、`Components/GenerationStatus` に操作例を追加。WithPlaylistは30秒のローカル試験トーンであり、楽曲生成APIを使わない。サムネイルは未実装の音符表示。画像生成ツールチェーン追加後に検討する。

OpenUIでは将来、JSONの部品定義からホストのsourceを解決してこれらのpropsを渡し、イベントをホスト操作へ接続する。JSONにcallback・秘密・Blob URLを保存しない。今回OpenUIから呼べる状態まで完了したとは扱わない。

## 確認

- DesignSystem型検査・build: 成功。
- DesignSystem全単体: 62ファイル、1,095件成功（追加9件を含む）。
- 新規部品のBiome確認: 成功。初回はimport順、fieldset、fixture callbackの指摘があり、新規部分のみ修正。
- ブラウザ12項目: 実音声の再生進行、一時停止、キーボードシーク、前後10秒、前後の曲、Playlist選択、再生中の曲切替、360px横はみ出しなし、進捗不明と実値の生成表示。結果は `browser-result.json`。
- 最初のブラウザ操作は成功したが、スクリーンショットでPlaylist行のCSS欠落を確認。CSS分離の切出し位置を修正後、部品9件・型検査・ブラウザ12項目・buildを再確認して成功。期待値は変更していない。
- 生成画面は音楽・画像の固定Storyで確認。実サービスの進捗連携、実スピーカーの聴取、OpenUIのJSON合成は未確認。
- 変更はDesignSystem内と記録。domain間の接続変更はないため、製品のverify:allと楽曲live生成は実行していない。既存差分を保持した。

`browser-check.ts` はDesignSystemのStorybookをポート6087で起動して実行する。画面は `player-playlist.png`、`player-narrow.png`、`generation-loading.png`。生成したUI参考画像は `ui-concept.png`。参考画像は構図の確認用で、実装は既存テーマ・トークンを利用する。

## UI画像生成

組込みimage_genで1回生成。最終prompt:

> Use case: ui-mockup. Create a polished desktop music player plus playlist UI concept for a reusable design system component, flat front-on app screenshot, no device frame. Clean warm off-white surface, charcoal typography, muted teal accent, rounded cards and subtle borders. Player card left, playlist right, well balanced and compact, generous but practical spacing. Player includes square abstract music cover artwork, track title 'Evening Current', subtitle 'Instrumental · 03:42', a clearly draggable timeline seek slider showing 01:24 / 03:42, five conventional controls in this exact order: previous track, rewind 10 seconds, prominent play/pause, forward 10 seconds, next track. Include a small volume control. Playlist heading 'Playlist', 4 rows with numbered tracks, tiny covers, names and durations, selected first row with teal highlight: Evening Current 03:42, Soft Motion 02:58, Quiet Orbit 04:16, Morning Light 03:08. Looks like an implementable accessible web UI built from modular components, consistent alignment and legible text. Show the full UI only, no marketing copy, no gradients in the UI except abstract cover art, no extra controls.
