# 音楽Artifactを画面単位へ統一

目的：曲・選曲結果ごとのランチャー項目を廃止し、楽曲生成と音楽プレイリストの入口とタブを各1つにする。空の生成履歴でも制作画面を開ける。曲と保存済みプレイリストは画面内で選び、新しい生成でフォームが再作成されない。

現状：共通MusicWorkspaceを再利用しているが、ランチャーはsongs／playlistsの各IDを並べている。最新の別作業ではどちらもtab id=musicとなり、開くたびに曲ID入りdefinitionとタイトルを入れ替え、key=definitionで画面を再マウントしていた。曲ごとにLLMがUIを生成しているわけではない。

範囲と再利用：既存Artifact workspaceのID重複防止、固定OpenUI music-workspace、MusicWorkspace、認証済みmusicList／musicPlaylists／musicTracks、submit／cancel／updateMusicPlaylistを使用する。生成用とplaylist用に固定source／固定tab IDを設定する。旧sourceの読取りは互換性として保つ。画面内選択は認証済み一覧の項目だけを受け付け、source・revision・取消とURL解放を維持する。意味判断・LLM指示、backend、DB、公開API、サービス設定は変更しない。別作業の大きな未コミット差分を保存・維持する。

依存順：固定definitionと開く操作 → ランチャー → 空履歴／最新結果のruntime → 画面内の保存playlist切替 → 回帰試験 → 画面確認 → 所有music／利用artifact・全体検証 → 差分点検。

完了条件：履歴が0件でも固定の2項目が表示される。曲やplaylistが増えても項目・画面数は増えない。生成画面とplaylist画面は互いを上書きしない。複数生成と曲選択で同じ制作フォームが維持される。playlist切替は同じ画面内で行え、旧検索や音声が新選択へ混ざらない。未知source・削除済み参照・古いrevisionを拒否する。画像生成はモックのまま。

検証：着手前の音楽・store試験を基準にする。単体で固定definition／tab重複、新項目の増加を確認。結合で空履歴の生成、最新生成の表示、認証済み選曲、playlist切替と不正sourceを確認。保存済みOpusと固定Providerでランチャー・2画面・複数生成・取消・再生をブラウザで通す。music／artifactのdomain gateと横断verify:allを実行する。実生成は行わない。検証中に入力が変わる場合、成功とは扱わず別作業の変更を直さない。同じ失敗に新しい根拠がなければ再実行を止めて報告する。

現在：実装・固定試験・画面確認・最終差分点検済み。全体gateは担当外の書式エラーで未合格として区別する。

実装：固定sourceはmusic-studio／library-studio、固定tab IDはmusic-generation／music-playlist。ランチャーには楽曲生成／音楽プレイリストを常に各1件表示する。保存済みの初期履歴は自動表示せず、新しい結果のみ既存画面を開く。新しい曲でdefinitionを差し替えないため、制作フォームは維持される。生成履歴の選曲、新しい結果の表示、playlistの選択は認証済み一覧に基づく。playlistのquery／currentId更新は既存APIを維持し、まだ保存済みplaylistがない場合は認証済み曲一覧を検索・再生できる。旧ID入りdefinitionも読める。

検証済み：着手時16件成功。修正後は固定2画面・初回生成・フォーム維持・保存playlist切替・未知source拒否を加えて25件成功。music domain gate（21件）とartifact gate（49件）、全体型検査、変更ファイルのlint・format・sizeとdiffチェック成功。保存済みOpusによる既存選曲・Visualizer・詳細・お気に入り試験成功。ブラウザ通しで空履歴の生成画面、取消→再生成、曲が増えても単一タブ、入力保持、2種類の独立タブ、playlist切替、390px幅、画像API未呼出しを確認。最初の画面試験は試験用track応答に必須metadataが不足し失敗したため、正式schemaのinstrumental／model／audioUrl／metadataUrlをfixtureへ補って再確認した。製品契約や期待値を弱めていない。

全体検証：`verify:all`を1回実行。入力hashは`55d029e62d5a7d708bac6b1428081029d2946fdaca3d5a7ec8a64ee78df9d49b`。size（808 files）、SQL境界（163 tables）、domain文書整合は成功。formatで担当外の`spec/design/settings-openui-2026-10-12/generate.ts`、`generation-manifest.json`、`screens.json`の3件が失敗し、後続は未実行。これらを変更したり、全体gateの条件を緩めたりしていない。その後、最新の作業状態で全体型検査、全Web試験328件、本番Web／部品buildを個別に実行して成功した。全体gateの成功には置き換えない。続行条件は担当外の書式エラー解消と安定した入力での全体再検証。

差分点検：着手時の対象ファイルを`/tmp/eumenes-singleton-artifact-2026-10-12`へコピーし、それとの比較で今回の変更を点検した。Workspace.tsxには作業中に別のpane表示条件の変更が入っており、それを保持して最新の型・画面確認を行った。他の大きな別作業差分を巻き戻していない。追加した分岐はUI source／表示選択／契約・状態管理であり、利用者の語句や音楽の意味判断を固定ルールで代替していない。DB・LLM・公開APIは変更せず、画像生成はモックのまま。今回の修正はcommit／pushしていない。

証拠：[メニュー](verification/singleton-music-artifact-2026-10-12/launcher.png)、[2画面とplaylist選択](verification/singleton-music-artifact-2026-10-12/playlist.png)、同ディレクトリのAPI経路・画像未呼出し・ログ・全体結果。通知エラーは音楽専用fixtureに通知APIがないためで、今回の操作失敗ではない。外部の音楽生成・画像生成は実行していない。実LLMの判断や実機器受入とは区別する。Context Stillはこの修正でcontext_compile／compile_evalを各1回使用。
