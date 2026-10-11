# OpenUIによる音楽UIの組合せ

2026-10-11。目的はDesignSystemのMusicPlayer・Playlist・GenerationStatusをOpenUIへ登録し、既存の楽曲ArtifactをJSON定義による構成へ置き換えること。

## 作業単位1 契約と登録

既存のview/source契約とOpenUI parser/Rendererを再利用した。music-player、playlist、generation-status、Compositionをlibraryへ登録。layoutはstack/gridで登録済みviewを1〜12個並べる。ネストしたlayoutや任意プログラムの実行は追加していない。音楽以外の既存viewも同じchildrenに配置できる。

JSONは表示の正本。ホストのsnapshotは音声URL、選択曲、一覧、生成状態を持ち、定義へURL・関数・秘密を埋め込まない。各子のsourceを種別と照合する。music-player/playlistはkind=music、generation-statusはkind=generation。既存の単一viewとLangの検証経路は維持した。

## 作業単位2 既存Artifactの置換

ArtifactTabの専用kind=music/musicIdをkind=openui/definitionへ置き換えた。Appの開く操作はmusicArtifactDefinitionでJSONを作り、ArtifactPanelの共通renderOpenUIへ渡す。MusicArtifactは認証済みデータを解決するホストとなり、表示はArtifactRendererとDesignSystem部品へ委ねる。

useMusicRuntimeは許可済みのmusicListを参照してsourceを解決する。選択した完了曲だけmusicAudioを取得し、取消後の取得結果を捨て、Blob URLを解放する。選曲はsource、revision、対象ID、完了状態を検査し、操作IDの重複を拒否する。生成中から再生可能への切替はJSONを変更せずsnapshot更新で行う。

タブの保持は既存どおりインメモリー。永続化DBやUI生成LLM、生成APIの変更はしていない。ホストに未接続の生成取消・再試行ボタンは表示しない。別のホストではgeneration resourceのcanCancel/canRetryとdispatchを提供して利用できる。

## 作業単位3 部分・結合確認

- Artifactのdomain検査: 成功。47件のWeb試験を含む。`verify-artifact.txt`。
- musicのdomain検査: 成功。backend 1件、Web 4件。`verify-music.txt`。
- 型検査、lint、サイズ検査: 成功。
- JSON合成の試験: 既存入力UIと音楽3部品の混在、実OpenUI parserの往復、別sourceの更新時に音声要素を保つこと、未登録・種別違いsource・任意URL props・過大/入れ子layoutの拒否。
- MusicArtifactの試験: 認証済み音声取得、Playlistからの曲切替、URL解放、同じJSONで生成中→完了、失敗時と未知sourceで音声を取得しないこと。

途中の静的確認で、layout追加に伴うShowcaseの型更新漏れ、試験APIの型、既存の長い関数のサイズ制限に到達した。該当箇所を修正し、Appの開くcallbackとShowcaseのサンプルタブを同じファイルの小さい関数へ移した。意味判断や要件の緩和は加えていない。

## 作業単位4 保存済み音声のブラウザ確認

`scripts/music-ui-check.ts` が、前回実生成して保存した `spec/verification/music-2026-10-11/track.mp3` を読み、認証を要求する読取専用API fixtureで配信する。製品のReact画面、client、ArtifactPanel、MusicArtifact、OpenUI、DesignSystemを通した。楽曲の再生成とLLM呼出しはしない。

時系列:

1. fixtureの楽曲状態generatingで画面を開き、JSONから生成中表示を確認。
2. 同じ保存済み音声をcompletedとして再読込みし、プレイヤー表示・メタデータ取得を確認。再読込みなしの状態遷移は単体/結合試験で別途確認。
3. 再生を開始しcurrentTimeの進行を確認、一時停止。
4. 先頭へシーク→10秒スキップ→10秒巻き戻し→キーボードのシークを確認。
5. 次の曲→前の曲→Playlist行の選択を確認。
6. ダウンロードリンク、30秒の実測duration、readyState=4、例外なしを確認。

2曲目は同じ保存音声に別の試験用メタデータを与えたコピー。別楽曲を生成したものではない。実環境の永続DBからの読取り、スピーカーの聴取、複数の異なる楽曲音源の確認ではない。

初回は5のPlaylist行の選択で停止。同名のタブの閉じるボタンまで試験locatorが拾ったため。`first-browser-failure.txt` に保存。製品コードは変更せず、locatorをPlaylist領域内に限定し、2回目で全操作成功。期待値は変更していない。

`result.json` に取得リクエストと結果。音楽へのリクエストはGETのみ。`generating.png` と `completed.png` は実画面。fixtureで接続していない通知等のAPIが404となり通知取得エラーが画面に出るが、これは既知の隔離fixtureの範囲外であり、音楽UIの失敗ではない。実LLM/実外部生成の通し確認へ結果を拡大解釈しない。

## 全体回帰確認

`bun run verify:all` は1回で成功、終了コード0、468,965 ms。backend等1,471成功・1スキップ、Web 293成功、client 329成功、DesignSystem 1,095成功、ブラウザ44成功・1スキップ。型・lint・整形・境界・サイズ・buildを含め全gate成功。`verify-all.txt` に保存。検証中は製品・試験コードとdocsを変更せず、終了時の入力同一性検査も成功した。

最後に差分を点検。既存の未コミット変更を保持し、題材やユーザー発話を判定する専用分岐は追加していない。登録view名とsource種別による処理は表示契約の接続。今回固有の保存曲名は試験fixtureと記録のみ。
