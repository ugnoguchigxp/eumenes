# 音楽再生ツールチェーン

目的・範囲: 保存済みLARM曲を会話から検索し、PlaylistとMusicPlayerを合成したOpenUI Artifactで再生する。楽曲生成担当は維持する。

接続: open_music_library → package:music.playback@1 → profile:music.playback@1 / skill:music.playback@1 / tool:music.library@1。共通queue・inference receipt・capability失効検査・親会話再開を再利用。保存するのは検索条件と曲ID。再表示時は詳細APIを読む。

専用実装の根拠: LARMのタグAND・cursor契約、Control BearerとHTTP Range中継が既存の生成音声BLOB取得では満たせないため、LARM library adapterを追加する。検索の意味解釈はLLM、絞り込み実行・タグ生成はLARMへ委ねる。表示は既存Playlist/MusicPlayerと登録する検索部品のJSON合成。

依存順: LARM契約と中継 → 担当登録と永続参照 → 会話接続 → DesignSystem/OpenUIと認証済みhost → 部分/結合/利用domain/全体検証 → 保存済み曲によるlive読取・Range再生 → 差分点検。全段階を実施した。

完了条件: 動的タグと件数、複数選択、検索、並び順、cursor、取得状態/再試行、古い応答破棄、選曲、認証付きシーク、お気に入りと削除を確認する。liveは既存曲の読取・再生だけとし、既存曲は変更しない。更新・削除はfixtureで検証する。実スピーカーの聴取は別途。

実装済み: music.playback@1のprofile/Skill/packageとmusic.library@1、公開open_music_library、queue/receipt/取消・親再開、music/0002-playlists、検索/タグ/詳細/metadata/お気に入り/削除/Range中継API、動的検索部品とPlaylistのメタデータ・操作、3viewのOpenUI合成、検索キー別の取消可能な取得・cursor引継ぎ。

部分・結合: 公開入口→担当→検索→永続ID→回答、Control認証・origin、Range206/416、AND/並び順/cursor、お気に入り解除と削除の分離、507/409、取消後の結果不採用、Node HTTP中継の試験が成功。Webの検索・cursor維持・お気に入り・削除確認・遅延検索の試験8件、検索部品2件が成功。

live: 既存設定のControl /openapi.jsonで契約を確認。保存済み2曲にq=piano/ピアノ/bright/明るい、実在タグANDを実行。実LLMによる3回の会話試行は全て保存曲プレイリストと回答まで完了（新規生成0）。初回のbrowser試験は後処理の誤ったfixture関数名で本来の失敗表示を覆った。次は読み込み待ち5秒で停止。3回目も初回読み込み待ちで停止。試験を実行状態から切り離し、固定計画と実LARM保存曲でUIを再確認。10.0065秒のOpusを再生/停止/5秒へシーク、認証proxy経由でRange64–127→206、Content-Range=bytes 64-127/81094、64 bytesを確認。UIの読み込み待ちを15秒へ、シーク値を部品のstep=0.1へ合わせた。Control曲への変更・削除なし。実スピーカー聴取は未実施。

専用中継の確認: Content-Lengthとチャンク転送が併記され得るBunのストリーム出力を観測した。不要なContent-Lengthの手動引継ぎを外し、Node HTTPで読む回帰試験を追加。上記の初期ブラウザ停止は主に読み込み待ちと確認スクリプトの前提不足であり、このヘッダーだけが原因だとは断定しない。

指示の評価: context_compile 1回 / compile_eval 1回（本作業、過去のOpus作業と合計2回/2回）。compile runId=00000000-0000-0000-18dd-756667110091、eval runId=00000000-0000-0000-18dd-769155f6f985、評価86点。実モデルの選択・計画・回答は別途liveで確認した。

ページング補強: 検索条件を以前の値へ戻す場合も、対象条件のキャッシュを取消・破棄して初回cursorなしで取得する。ページ取得済み→別条件→元条件の回帰試験を追加して成功。選択曲は一覧の古い値より最新の詳細を表示し、お気に入り絞り込みから外す場合は保存された選択IDも解除する。

domain gate: music（backend1/Web9）、LARM76、capabilities20、dialogue（backend120/Web6）が成功。Artifactは登録部品の期待数が旧10で1件失敗したため、新規music-libraryを含む11へ更新し、source種類の拒否試験を追加。修正後48件成功。部分UIは計57件成功。最終の部分backend試験は4ファイル12件成功。

live補足: ブラウザ切り分けの追加1回は実PortのanswerStreamが残り、会話選択/回答はlive・計画はfixtureとなった。最終の読取り確認ではstreamを持たない固定Portに分離した。実曲・実HTTP・認証proxyの確認と、実LLMの選択/計画/回答の確認を別の証拠として扱う。新しい曲は生成していない。fixtureの通知SSEがidle timeoutで切れ、画面に通知エラーが出たが、音楽再生・Range取得は成功した。担当外の通知機構は変更しない。

全体gate: bun run verify:all が455814msで成功。backend1486成功/1skip、Web299、client329、DesignSystem1097、browser44成功/1skip、合計3255成功/2skip。size-budget、SQL境界、domain文書、format、lint、型検査、buildも成功。検証中に入力を編集していないことをhash一致で確認した。revision=b2051b185769facc01356dd3cc00f70a9bb7b3684b7980348fe430fd61f2d646。終了後に本記録と検証資料だけを更新した。

差分点検: 既存Opus作業の差分を保持した。発話の語句によるルーティング・独自のタグ辞書・別タグ生成モデルを追加していない。追加の正規表現は曲ID、URL、エラーコードの契約・安全性検査に限定する。担当外の変更を追加していない。お気に入り変更・削除はfixtureのみ、実スピーカーの聴取は未実施。今回の実装・固定試験・live確認の残作業はなし。実機器確認済みとは扱わない。

証拠: [検証資料](../verification/music-playback-2026-10-11/README.md) にdomainログ、全体gateのJSONとログ、実LLM会話・実LARM読取とRangeの時系列、プレイヤー画像を保存した。接続設定は保存済みのControlを正本とし、設定の変更・credentialのコピーは行っていない。
