# 音楽デスクトップUI

## 目的・範囲・完了条件

左をVisualizer／楽曲イメージと曲名直前のお気に入り星、右を曲名・長さ中心の一覧、下部を共通プレイヤーにする。追記された要望に合わせ、プレイヤーは音楽パネルの最下部に固定し、上部は残りの高さを使う。狭い幅・低い高さでは上部だけをスクロールできる。説明・歌詞・タグ・生成情報と削除は詳細モーダルへ集約する。音声は一つのaudio要素から再生と解析へ渡す。

既存のMusicPlayer、Playlist、MusicLibraryControls、Modal、Artifact runtimeと許可済み操作を再利用する。独立した登録viewの組合せだけではaudio要素と解析状態を共有できないため、DesignSystemのMusicWorkspaceを追加し、OpenUIのmusic-workspaceとして登録する。業務API、DB、LLMの判断・指示、生成処理、認証、既存の担当外差分は変更対象外。

現行の楽曲APIは画像・歌詞を返さない。表示部品には任意の画像・歌詞を渡せるが、未取得の内容は捏造せず画像未登録／歌詞情報なしと表示する。画像生成や製品DBへの直接アクセスは行わない。

依存順は再生と解析の接続 → 表示部品とモーダル → OpenUI登録・ホストの表示JSON → 固定試験・画面確認 → 回帰検証。完了条件は一つの音声要素で再生・シーク・曲送り・表示切替が動くこと、星の状態がAPI結果と一致すること、詳細が選曲せず開くこと、通常デスクトップ幅で左右構成とプレイヤーが同時に見えること。

## 検証計画・残作業

- 部分：DesignSystemの再生・Visualizer・workspace操作・画像なし・詳細・星の試験。
- 結合：OpenUIの登録／source検査とmusic runtimeの選曲・お気に入りAPI接続、遅延応答の回帰。
- 画面：保存済み音声または固定音声を使い、デスクトップ・狭い幅、実音声解析、切替、モーダル、星を確認する。生成APIは再実行しない。
- 回帰：`bun run verify -- --domain music`、`bun run verify -- --domain artifact`、横断変更の`bun run verify:all`。担当外の失敗は原因・影響を記録し、勝手に修正しない。
- 最終差分：着手時の既存差分と分けて今回分を確認し、個別曲・語句に依存する処理が増えていないことを点検する。

実装、部品単体、OpenUI・ホスト結合、保存済みMP3での画面確認を完了。回帰検証とOpus確認を次に実施する。最終結果・入力hash・残作業は[検証記録](verification/music-desktop-2026-10-11/README.md)へ保存する。live生成・実機器受入は表示変更の範囲外。

## 接続した表示

ライブラリの保存JSONは`{"view":"music-workspace","source":"library-<playlist-id>","title":"プレイリスト"}`。生成音楽では`generation-status`と`music-workspace`を既存layoutのstackで組み合わせる。sourceのkindはmusic。検索・取得・選曲・星・削除は既存のmusic-search／music-more／music-refresh／music-select／music-favorite／music-deleteをホストへ渡す。星はAPI応答後のfavoriteを描画し、生成履歴だけのsourceには保存ライブラリの操作を公開しない。

MusicWorkspaceを含むArtifactにだけ高さを引き継ぎ、他のArtifactのスクロールを変更しない。Modalに既存RadixのonCloseAutoFocusを渡せるようにし、詳細を開いたボタンへフォーカスを戻す。専用の発話分類や固定返答は追加していない。

APIから次の曲を取得する間もMusicPlayerの再生意図を保持するloadingを追加し、選曲後の連続再生を部品試験と画面で確認した。一覧は8曲ずつのページ切替。描画アニメーションは実音声のFFT／波形を使い、画像表示中・非表示タブ・停止中・動きを減らす設定では継続更新しない。
