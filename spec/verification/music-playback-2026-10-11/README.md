# 保存曲プレイリストの検証

実装: `open_music_library` → `package:music.playback@1`、同名profile/skill、`tool:music.library@1`。検索条件と曲IDをmusic domainへ保存し、`music-library` / `music-player` / `playlist` のOpenUI JSONを認証済みhostで表示する。

LARM接続はbackend settingsの読み取り専用操作から取得。Control credentialはbackendだけで使う。libraryの読取・再生は生成モデルを起動せず、既存曲2曲を維持した。

- `live-first-events.json`: 実LLMのプレイリスト作成と親回答。runId `c8a5fc75-6d11-4d75-86ac-d6ff60f0988e`。ブラウザ後処理の失敗も作業記録に記載。
- `live-third-events.json`: 実LLMの再確認、runId `eea60d32-7716-4a64-80e9-86072445c199`。曲ID2件を保存し、新しい順のライブラリを回答。初期のブラウザ読込み待ちで停止。
- `live-ui-events.json` / `live-ui-requests.json` / `player.png`: 固定計画と実LARM保存曲を使ったブラウザ確認。10.0065秒のOpusを再生・停止・5秒へシーク。音声Range 64–127は206、Content-Range `bytes 64-127/81094`、64 bytes。pageerrorなし。

実接続ではpiano/ピアノ/bright/明るいの検索、動的タグ件数、実在する複数タグANDも確認。英語説明の曲に日本語タグが付いていることを確認した。お気に入り変更と曲削除は固定APIで検証し、既存曲へ実行していない。実スピーカーの聴取は未実施。

固定試験は公開入口→担当→結果採用→回答、取消後の遅延結果不採用、AND・順序・nextCursor、条件変更・過去条件復帰時の先頭取得、Control認証・同origin・Range206/416、favoriteの登録/解除、曲削除、507/409、OpenUI source種類の拒否と操作を含む。

全体検証: `bun run verify:all` が455814msで成功。backend1486成功/1skip、Web299、client329、DesignSystem1097、browser44成功/1skip。合計3255成功/2skip。型・SQL境界・容量・文書・format・lint・buildも全て成功。

- `full-gate.json` / `full-gate.txt`: 全体gate。検証入力revision `b2051b185769facc01356dd3cc00f70a9bb7b3684b7980348fe430fd61f2d646`。終了直後のhashと一致した。検証中の入力変更なし。終了後は作業記録と検証資料のみ追記。
- `artifact-gate.json` / `verify-*.txt`: 所有・利用domainの確認。music backend1/Web9、LARM76、capabilities20、dialogue backend120/Web6、Artifact48。
- `partial.txt` / `ds-tests.txt`: 最終のbackend部分試験12件と検索部品2件。

実行用Skill `skill:music.playback@1` は登録済みで、実モデルの計画へ渡した。context_compile / compile_eval は本作業で各1回（Opus作業を含め累計各2回）。差分点検では意味判断をLLMへ残し、独自タグ辞書や発話別ルーティングを追加していないことを確認した。

使い方: backendを再起動後、会話で「保存した曲のライブラリを開いて」と依頼する。Artifactで検索・複数タグ・並び順・お気に入りを選び、「検索する」を押す。「次の曲を取得」は前の応答のnextCursorをcursorへ渡し、条件変更時は先頭へ戻る。選曲してプレイヤーで再生する。

未確認範囲: 実スピーカーの聴取、実保存曲のお気に入り変更・削除。後者は既存曲を維持するためfixtureで検証した。UI確認fixtureの通知SSEの切断は担当外として記録し、変更していない。
